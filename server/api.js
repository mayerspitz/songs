'use strict';
const crypto = require('crypto');
const { q, rows, one, id, bumpRev } = require('./db');
const perm = require('./perm');
const audio = require('./audio');
const analysis = require('./analysis');

// ---------- helpers ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const err = (status, message) => { throw new ApiError(status, message); };

const asBuf = v => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v));

function spbOf(song) {
  if (!song.bpm) err(409, 'Set the official tempo first (Tempo Sense panel) — this operation needs the beat grid.');
  return 60 / song.bpm;
}

async function effectiveRole(userId, song) {
  if (!userId || !song) return null;
  if (song.owner_id === userId) return 'owner';
  let role = null;
  const ms = await rows(
    `SELECT role FROM members WHERE user_id = $1 AND (
       (resource_type = 'song' AND resource_id = $2) OR
       (resource_type = 'collection' AND resource_id = $3))`,
    [userId, song.id, song.collection_id || '']);
  for (const m of ms) role = role ? perm.maxRole(role, m.role) : m.role;
  return role;
}

async function songAccess(user, songId, action = 'view') {
  const song = await one('SELECT * FROM songs WHERE id = $1', [songId]);
  if (!song) err(404, 'Song not found');
  const role = await effectiveRole(user.id, song);
  if (!role) err(403, 'You are not invited to this song');
  if (!perm.allows(role, action)) err(403, `Your role (${role}) cannot do this`);
  return { song, role };
}

async function takeAccess(user, takeId, { editing = false } = {}) {
  const take = await one('SELECT * FROM takes WHERE id = $1', [takeId]);
  if (!take) err(404, 'Take not found');
  const { song, role } = await songAccess(user, take.song_id, 'view');
  if (editing) {
    const own = take.author_id === user.id;
    if (!(own ? perm.allows(role, 'editOwn') : perm.allows(role, 'editContent'))) {
      err(403, own ? 'Your role cannot edit takes' : 'Only contributors can edit takes of others');
    }
  }
  return { take, song, role };
}

async function saveFile(rec, mime = 'audio/flac') {
  const fid = id();
  await q('INSERT INTO files (id, mime, master, play, duration, peaks) VALUES ($1,$2,$3,$4,$5,$6)',
    [fid, mime, rec.master, rec.play, rec.duration, JSON.stringify(rec.peaks)]);
  return fid;
}

async function fileMaster(fileId) {
  const f = await one('SELECT master FROM files WHERE id = $1', [fileId]);
  if (!f) err(404, 'Audio file missing');
  return asBuf(f.master);
}

const previews = new Map(); // previewId -> {rec, takeId, label, expires}
function stashPreview(rec, takeId, label) {
  const pid = id();
  previews.set(pid, { rec, takeId, label, expires: Date.now() + 15 * 60e3 });
  return pid;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of previews) if (v.expires < now) previews.delete(k);
}, 60e3).unref();

function downPeaks(peaks, buckets = 240) {
  if (!Array.isArray(peaks) || peaks.length <= buckets) return peaks;
  const out = [];
  const per = peaks.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let mn = 0, mx = 0;
    for (let i = Math.floor(b * per); i < Math.min(peaks.length, Math.ceil((b + 1) * per)); i++) {
      if (peaks[i][0] < mn) mn = peaks[i][0];
      if (peaks[i][1] > mx) mx = peaks[i][1];
    }
    out.push([mn, mx]);
  }
  return out;
}

// Tempo flag: compare a take's detected bpm against the official grid.
function tempoFlag(song, takeAnalysis) {
  const det = takeAnalysis && takeAnalysis.tempo;
  if (!song.bpm || !det || !det.bpm || det.confidence < 0.3) return null;
  let r = det.bpm / song.bpm;
  while (r > 1.45) r /= 2;   // hummed double-time is fine
  while (r < 0.7) r *= 2;    // hummed half-time is fine
  if (Math.abs(r - 1) <= 0.045) return null;
  return {
    detected: det.bpm,
    ratio: Math.round(r * 1000) / 1000,     // detected/official after octave folding
    stretch: Math.round(r * 1000) / 1000,   // duration multiplier that would fix it
    state: 'open',
  };
}

function shapeTake(t) {
  return {
    id: t.id, stage: t.stage, laneType: t.lane_type, laneId: t.lane_id, name: t.name,
    authorId: t.author_id, isSuggestion: t.is_suggestion, offsetBeats: t.offset_beats,
    gain: t.gain, muted: t.muted, fileId: t.file_id, duration: t.file_duration,
    peaks: downPeaks(t.file_peaks), analysis: t.analysis, notes: t.notes, flags: t.flags,
    recCtx: t.rec_ctx, variantOf: t.variant_of, historyLen: (t.history || []).length,
    createdAt: t.created_at,
  };
}

async function loadTakeShaped(tid) {
  const t = await one(
    `SELECT t.*, f.duration AS file_duration, f.peaks AS file_peaks
     FROM takes t LEFT JOIN files f ON f.id = t.file_id WHERE t.id = $1`, [tid]);
  return t ? shapeTake(t) : null;
}

async function newTakeFromRec(user, song, rec, meta, { isSuggestion, label }) {
  const fid = await saveFile(rec);
  const an = analysis.analyzeAll(rec.pcm);
  const flags = {};
  // pool items aren't on the grid yet — no tempo flag until they're placed
  const tf = meta.laneType === 'pool' ? null : tempoFlag(song, an);
  if (tf) flags.tempo = tf;
  const tid = id();
  await q(
    `INSERT INTO takes (id, song_id, stage, lane_type, lane_id, name, author_id, is_suggestion,
       offset_beats, gain, file_id, analysis, flags, rec_ctx, variant_of, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [tid, song.id, meta.stage, meta.laneType, meta.laneId, label, user.id, isSuggestion,
      meta.offsetBeats || 0, 1, fid, JSON.stringify(an), JSON.stringify(flags),
      JSON.stringify(meta.recCtx || {}), meta.variantOf || null,
      meta.notes ? JSON.stringify(meta.notes) : null]);
  await bumpRev(song.id);
  return loadTakeShaped(tid);
}

// Apply a processed recording to a take (push current audio onto history).
async function pushTakeAudio(take, rec, label) {
  const fid = await saveFile(rec);
  const history = (take.history || []).concat([{ file_id: take.file_id, label: label || 'edit', at: new Date().toISOString() }]);
  const an = analysis.analyzeAll(rec.pcm);
  await q('UPDATE takes SET file_id = $2, history = $3, analysis = $4 WHERE id = $1',
    [take.id, fid, JSON.stringify(history), JSON.stringify(an)]);
  await bumpRev(take.song_id);
}

// ---------- comp rendering ----------

async function renderComp(song, comp) {
  const spb = spbOf(song);
  const takesById = {};
  for (const t of await rows('SELECT * FROM takes WHERE song_id = $1', [song.id])) takesById[t.id] = t;
  const sections = await rows('SELECT * FROM sections WHERE song_id = $1 ORDER BY start_beat', [song.id]);
  const secById = Object.fromEntries(sections.map(s => [s.id, s]));
  const items = [];
  const place = async (takeId, atBeats) => {
    const t = takesById[takeId];
    if (!t || !t.file_id || t.muted || t.deleted) return;
    items.push({ master: await fileMaster(t.file_id), offsetSec: Math.max(0, atBeats * spb), gain: t.gain });
  };
  const p = comp.payload || {};
  if (comp.stage === 1) {
    for (const sec of sections) {
      for (const tid of (p.selections && p.selections[sec.id]) || []) {
        const t = takesById[tid];
        if (t) await place(tid, sec.start_beat + t.offset_beats);
      }
    }
  } else if (comp.stage === 2) {
    const src = p.sourceCompId ? await one('SELECT * FROM comps WHERE id = $1', [p.sourceCompId]) : null;
    const backingGain = p.backingGain == null ? 0 : p.backingGain;
    if (src && backingGain > 0) {
      let cursor = 0;
      for (const step of p.structure || []) {
        const sec = secById[step.sectionId];
        if (!sec) continue;
        for (let r = 0; r < (step.repeats || 1); r++) {
          for (const tid of (src.payload.selections && src.payload.selections[sec.id]) || []) {
            const t = takesById[tid];
            if (!t || !t.file_id || t.muted) continue;
            items.push({
              master: await fileMaster(t.file_id),
              offsetSec: (cursor + t.offset_beats) * spb,
              gain: t.gain * backingGain,
            });
          }
          cursor += sec.length_beats;
        }
      }
    }
    for (const tid of p.takeIds || []) {
      const t = takesById[tid];
      if (t) await place(tid, t.offset_beats);
    }
  } else {
    for (const trackId of Object.keys(p.selections || {})) {
      for (const tid of p.selections[trackId] || []) {
        const t = takesById[tid];
        if (t) await place(tid, t.offset_beats);
      }
    }
  }
  if (!items.length) err(409, 'This comp has no audible takes selected');
  return audio.mixdown(items);
}

// ---------- route table ----------
// Each handler: (ctx) => data | {__raw}. ctx = {req,res,url,params,body,user,config}

const routes = [];
const route = (method, pattern, opts, handler) => {
  if (!handler) { handler = opts; opts = {}; }
  const names = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, m => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, names, handler, opts });
};

// ----- config / me -----

route('GET', '/api/config', { public: true }, async () => ({
  devLogin: process.env.DEV_LOGIN === '1',
  google: !!require('./auth').GOOGLE_ID(),
}));

route('GET', '/api/me', { public: true }, async ({ user }) => user
  ? { user: { id: user.id, email: user.email, name: user.name, picture: user.picture, color: user.color } }
  : { user: null });

// ----- home -----

route('GET', '/api/home', async ({ user }) => {
  const songs = await rows(
    `SELECT DISTINCT s.* FROM songs s
       LEFT JOIN members ms ON ms.resource_type = 'song' AND ms.resource_id = s.id AND ms.user_id = $1
       LEFT JOIN members mc ON mc.resource_type = 'collection' AND mc.resource_id = s.collection_id AND mc.user_id = $1
     WHERE s.owner_id = $1 OR ms.user_id IS NOT NULL OR mc.user_id IS NOT NULL
     ORDER BY s.created_at DESC`, [user.id]);
  const collections = await rows(
    `SELECT DISTINCT c.* FROM collections c
       LEFT JOIN members m ON m.resource_type = 'collection' AND m.resource_id = c.id AND m.user_id = $1
     WHERE c.owner_id = $1 OR m.user_id IS NOT NULL
     ORDER BY c.created_at DESC`, [user.id]);
  const counts = await rows(
    `SELECT song_id, count(*)::int AS n FROM takes GROUP BY song_id`);
  const nBy = Object.fromEntries(counts.map(c => [c.song_id, c.n]));
  const owners = await rows(`SELECT id, name, color FROM users`);
  return {
    songs: songs.map(s => ({ ...pickSong(s), takeCount: nBy[s.id] || 0 })),
    collections,
    users: owners,
  };
});

route('POST', '/api/collections', async ({ user, body }) => {
  const cid = id();
  await q('INSERT INTO collections (id, name, owner_id) VALUES ($1,$2,$3)', [cid, String(body.name || 'Collection').slice(0, 120), user.id]);
  return one('SELECT * FROM collections WHERE id = $1', [cid]);
});

route('PATCH', '/api/collections/:id', async ({ user, params, body }) => {
  const col = await one('SELECT * FROM collections WHERE id = $1', [params.id]);
  if (!col) err(404, 'Collection not found');
  const role = col.owner_id === user.id ? 'owner'
    : (await one(`SELECT role FROM members WHERE resource_type='collection' AND resource_id=$1 AND user_id=$2`, [col.id, user.id]) || {}).role;
  if (!role || !perm.allows(role, 'editSettings')) err(403, 'Admins only');
  await q('UPDATE collections SET name = $2 WHERE id = $1', [col.id, String(body.name).slice(0, 120)]);
  return { ok: true };
});

route('DELETE', '/api/collections/:id', async ({ user, params }) => {
  const col = await one('SELECT * FROM collections WHERE id = $1', [params.id]);
  if (!col) err(404, 'Collection not found');
  if (col.owner_id !== user.id) err(403, 'Only the owner can delete a collection');
  await q('UPDATE songs SET collection_id = NULL WHERE collection_id = $1', [col.id]);
  await q(`DELETE FROM members WHERE resource_type='collection' AND resource_id=$1`, [col.id]);
  await q('DELETE FROM collections WHERE id = $1', [col.id]);
  return { ok: true };
});

function pickSong(s) {
  const { id, name, collection_id, owner_id, stage, bpm, beats_per_bar, bars, key_root, key_mode,
    latency_ms, chords, beat, midi_file_id, stage2_source_comp, stage3_source_comp, rev, created_at } = s;
  return { id, name, collection_id, owner_id, stage, bpm, beats_per_bar, bars, key_root, key_mode,
    latency_ms, chords, beat, midi_file_id, stage2_source_comp, stage3_source_comp, rev, created_at };
}

route('POST', '/api/songs', async ({ user, body }) => {
  const sid = id();
  if (body.collectionId) {
    const col = await one('SELECT * FROM collections WHERE id = $1', [body.collectionId]);
    if (!col) err(404, 'Collection not found');
    const crole = col.owner_id === user.id ? 'owner'
      : (await one(`SELECT role FROM members WHERE resource_type='collection' AND resource_id=$1 AND user_id=$2`, [col.id, user.id]) || {}).role;
    if (!crole || !perm.allows(crole, 'editContent')) err(403, 'You cannot add songs to this collection');
  }
  await q(`INSERT INTO songs (id, name, collection_id, owner_id, bpm, beats_per_bar, bars)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sid, String(body.name || 'New song').slice(0, 160), body.collectionId || null, user.id,
      body.bpm || null, body.beatsPerBar || null, body.bars || 16]);
  // a starter section so recording works immediately
  await q(`INSERT INTO sections (id, song_id, name, start_beat, length_beats, color)
           VALUES ($1,$2,'Part A',0,$3,'#4a9de8')`, [id(), sid, (body.beatsPerBar || 4) * 4]);
  return pickSong(await one('SELECT * FROM songs WHERE id = $1', [sid]));
});

route('DELETE', '/api/songs/:id', async ({ user, params }) => {
  const { song } = await songAccess(user, params.id, 'deleteSong');
  await q('DELETE FROM songs WHERE id = $1', [song.id]);
  return { ok: true };
});

// ----- song snapshot -----

route('GET', '/api/songs/:id', async ({ user, params }) => {
  const { song, role } = await songAccess(user, params.id, 'view');
  const [sections, tracks, takes, comps, votes, comments, members, picks] = await Promise.all([
    rows('SELECT * FROM sections WHERE song_id = $1 ORDER BY start_beat', [song.id]),
    rows('SELECT * FROM tracks WHERE song_id = $1 ORDER BY pos, created_at', [song.id]),
    rows(`SELECT t.*, f.duration AS file_duration, f.peaks AS file_peaks
          FROM takes t LEFT JOIN files f ON f.id = t.file_id
          WHERE t.song_id = $1 AND NOT t.deleted ORDER BY t.created_at`, [song.id]),
    rows('SELECT * FROM comps WHERE song_id = $1 ORDER BY created_at', [song.id]),
    rows('SELECT v.* FROM votes v JOIN comps c ON c.id = v.comp_id WHERE c.song_id = $1', [song.id]),
    rows('SELECT * FROM comments WHERE song_id = $1 ORDER BY created_at', [song.id]),
    rows(`SELECT m.* FROM members m WHERE (m.resource_type='song' AND m.resource_id=$1)
            OR (m.resource_type='collection' AND m.resource_id=$2)`, [song.id, song.collection_id || '']),
    rows('SELECT * FROM picks WHERE song_id = $1', [song.id]),
  ]);
  const userIds = new Set([song.owner_id]);
  takes.forEach(t => userIds.add(t.author_id));
  comments.forEach(c => userIds.add(c.author_id));
  comps.forEach(c => userIds.add(c.author_id));
  votes.forEach(v => userIds.add(v.user_id));
  members.forEach(m => m.user_id && userIds.add(m.user_id));
  picks.forEach(p => userIds.add(p.user_id));
  const users = userIds.size
    ? await rows(`SELECT id, email, name, picture, color FROM users WHERE id = ANY($1)`, [[...userIds]])
    : [];
  return {
    song: pickSong(song), myRole: role, rev: song.rev,
    sections, tracks,
    takes: takes.map(shapeTake),
    comps, votes, comments, members, picks, users,
  };
});

route('GET', '/api/songs/:id/rev', async ({ user, params }) => {
  const { song } = await songAccess(user, params.id, 'view');
  return { rev: song.rev };
});

const SETTING_FIELDS = {
  name: { col: 'name', map: v => String(v).slice(0, 160), action: 'editSettings' },
  bpm: { col: 'bpm', map: v => (v == null ? null : Math.max(30, Math.min(300, Number(v)))), action: 'editSettings' },
  beatsPerBar: { col: 'beats_per_bar', map: v => (v == null ? null : Math.max(1, Math.min(12, Math.round(v)))), action: 'editSettings' },
  bars: { col: 'bars', map: v => Math.max(1, Math.min(500, Math.round(v))), action: 'editSettings' },
  keyRoot: { col: 'key_root', map: v => (v == null ? null : ((Math.round(v) % 12) + 12) % 12), action: 'editSettings' },
  keyMode: { col: 'key_mode', map: v => (v ? String(v) : null), action: 'editSettings' },
  latencyMs: { col: 'latency_ms', map: v => Math.max(0, Math.min(500, Math.round(v))), action: 'editSettings' },
  stage: { col: 'stage', map: v => Math.max(1, Math.min(3, Math.round(v))), action: 'setStage' },
  stage2SourceComp: { col: 'stage2_source_comp', map: v => v || null, action: 'setStage' },
  stage3SourceComp: { col: 'stage3_source_comp', map: v => v || null, action: 'setStage' },
  chords: { col: 'chords', map: v => JSON.stringify(Array.isArray(v) ? v.slice(0, 400) : []), action: 'editContent' },
  beat: { col: 'beat', map: v => JSON.stringify(v || {}), action: 'editContent' },
};

route('PATCH', '/api/songs/:id', async ({ user, params, body }) => {
  const { song, role } = await songAccess(user, params.id, 'view');
  const sets = [], vals = [song.id];
  for (const [k, v] of Object.entries(body || {})) {
    const f = SETTING_FIELDS[k];
    if (!f) continue;
    if (!perm.allows(role, f.action)) err(403, `Your role (${role}) cannot change ${k}`);
    vals.push(f.map(v));
    sets.push(`${f.col} = $${vals.length}`);
  }
  if (sets.length) {
    await q(`UPDATE songs SET ${sets.join(', ')} WHERE id = $1`, vals);
    await bumpRev(song.id);
  }
  return pickSong(await one('SELECT * FROM songs WHERE id = $1', [song.id]));
});

// Tempo Sense summary: aggregate detected bpm across takes.
route('GET', '/api/songs/:id/tempo-sense', async ({ user, params }) => {
  const { song } = await songAccess(user, params.id, 'view');
  const takes = await rows('SELECT analysis FROM takes WHERE song_id = $1', [song.id]);
  const buckets = [];
  for (const t of takes) {
    const det = t.analysis && t.analysis.tempo;
    if (!det || !det.bpm || det.confidence < 0.15) continue;
    let bpm = det.bpm;
    const hit = buckets.find(b => {
      for (const f of [1, 2, 0.5]) if (Math.abs(b.bpm - bpm * f) <= b.bpm * 0.04) return true;
      return false;
    });
    if (hit) { hit.weight += det.confidence; hit.samples.push(bpm); }
    else buckets.push({ bpm, weight: det.confidence, samples: [bpm] });
  }
  buckets.sort((a, b) => b.weight - a.weight);
  const total = buckets.reduce((a, b) => a + b.weight, 0) || 1;
  const meters = {};
  for (const t of takes) {
    const m = t.analysis && t.analysis.meter;
    if (m && m.confidence > 0.1) meters[m.beatsPerBar] = (meters[m.beatsPerBar] || 0) + m.confidence;
  }
  const meterBest = Object.entries(meters).sort((a, b) => b[1] - a[1])[0];
  return {
    official: { bpm: song.bpm, beatsPerBar: song.beats_per_bar },
    suggestions: buckets.slice(0, 3).map(b => ({
      bpm: Math.round((b.samples.sort((x, y) => x - y)[Math.floor(b.samples.length / 2)]) * 10) / 10,
      confidence: Math.round(Math.min(0.98, (b.weight / total) * (0.4 + 0.15 * Math.min(4, b.samples.length))) * 100) / 100,
      takes: b.samples.length,
    })),
    meterSuggestion: meterBest ? { beatsPerBar: Number(meterBest[0]) } : null,
    analyzedTakes: takes.filter(t => t.analysis && t.analysis.tempo && t.analysis.tempo.bpm).length,
  };
});

// ----- members / invites -----

async function resourceForMembers(user, rtype, rid) {
  if (rtype === 'song') {
    const { song, role } = await songAccess(user, rid, 'manageMembers');
    return { role, ownerId: song.owner_id };
  }
  const col = await one('SELECT * FROM collections WHERE id = $1', [rid]);
  if (!col) err(404, 'Collection not found');
  const role = col.owner_id === user.id ? 'owner'
    : (await one(`SELECT role FROM members WHERE resource_type='collection' AND resource_id=$1 AND user_id=$2`, [rid, user.id]) || {}).role;
  if (!role || !perm.allows(role, 'manageMembers')) err(403, 'Admins only');
  return { role, ownerId: col.owner_id };
}

route('GET', '/api/members/:rtype/:rid', async ({ user, params }) => {
  const rtype = params.rtype === 'collection' ? 'collection' : 'song';
  if (rtype === 'song') await songAccess(user, params.rid, 'view');
  else await resourceForMembers(user, rtype, params.rid).catch(() => err(403, 'Admins only'));
  const ms = await rows(`SELECT * FROM members WHERE resource_type=$1 AND resource_id=$2 ORDER BY created_at`, [rtype, params.rid]);
  return { members: ms };
});

route('POST', '/api/members/:rtype/:rid', async ({ user, params, body }) => {
  const rtype = params.rtype === 'collection' ? 'collection' : 'song';
  const { role: myRole } = await resourceForMembers(user, rtype, params.rid);
  const email = String(body.email || '').trim().toLowerCase();
  const newRole = body.role;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err(400, 'Valid email required');
  if (!perm.validRole(newRole) || newRole === 'owner') err(400, 'Invalid role');
  if (perm.rank(newRole) >= perm.rank('admin') && myRole !== 'owner') err(403, 'Only the owner can grant admin');
  const existing = await one('SELECT id FROM members WHERE resource_type=$1 AND resource_id=$2 AND lower(email)=$3', [rtype, params.rid, email]);
  const linked = await one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    await q('UPDATE members SET role = $2 WHERE id = $1', [existing.id, newRole]);
  } else {
    await q(`INSERT INTO members (id, resource_type, resource_id, email, user_id, role, invited_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id(), rtype, params.rid, email, linked ? linked.id : null, newRole, user.id]);
  }
  if (rtype === 'song') await bumpRev(params.rid);
  return { ok: true };
});

route('PATCH', '/api/member/:id', async ({ user, params, body }) => {
  const m = await one('SELECT * FROM members WHERE id = $1', [params.id]);
  if (!m) err(404, 'Member not found');
  const { role: myRole } = await resourceForMembers(user, m.resource_type, m.resource_id);
  if (!perm.validRole(body.role) || body.role === 'owner') err(400, 'Invalid role');
  if ((perm.rank(body.role) >= perm.rank('admin') || perm.rank(m.role) >= perm.rank('admin')) && myRole !== 'owner') {
    err(403, 'Only the owner can manage admins');
  }
  await q('UPDATE members SET role = $2 WHERE id = $1', [m.id, body.role]);
  if (m.resource_type === 'song') await bumpRev(m.resource_id);
  return { ok: true };
});

route('DELETE', '/api/member/:id', async ({ user, params }) => {
  const m = await one('SELECT * FROM members WHERE id = $1', [params.id]);
  if (!m) err(404, 'Member not found');
  const { role: myRole } = await resourceForMembers(user, m.resource_type, m.resource_id);
  if (perm.rank(m.role) >= perm.rank('admin') && myRole !== 'owner') err(403, 'Only the owner can remove admins');
  await q('DELETE FROM members WHERE id = $1', [m.id]);
  if (m.resource_type === 'song') await bumpRev(m.resource_id);
  return { ok: true };
});

// ----- sections & tracks -----

route('POST', '/api/songs/:id/sections', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'editContent');
  const sid = id();
  await q(`INSERT INTO sections (id, song_id, name, start_beat, length_beats, color) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sid, song.id, String(body.name || 'Part').slice(0, 80), Math.max(0, Number(body.startBeat) || 0),
      Math.max(0.25, Number(body.lengthBeats) || 4), body.color || '#4a9de8']);
  await bumpRev(song.id);
  return one('SELECT * FROM sections WHERE id = $1', [sid]);
});

route('PATCH', '/api/sections/:id', async ({ user, params, body }) => {
  const sec = await one('SELECT * FROM sections WHERE id = $1', [params.id]);
  if (!sec) err(404, 'Section not found');
  const { song } = await songAccess(user, sec.song_id, 'editContent');
  await q(`UPDATE sections SET name=$2, start_beat=$3, length_beats=$4, color=$5 WHERE id=$1`,
    [sec.id,
      body.name != null ? String(body.name).slice(0, 80) : sec.name,
      body.startBeat != null ? Math.max(0, Number(body.startBeat)) : sec.start_beat,
      body.lengthBeats != null ? Math.max(0.25, Number(body.lengthBeats)) : sec.length_beats,
      body.color || sec.color]);
  await bumpRev(song.id);
  return one('SELECT * FROM sections WHERE id = $1', [sec.id]);
});

route('DELETE', '/api/sections/:id', async ({ user, params }) => {
  const sec = await one('SELECT * FROM sections WHERE id = $1', [params.id]);
  if (!sec) err(404, 'Section not found');
  const { song } = await songAccess(user, sec.song_id, 'editContent');
  await q('DELETE FROM takes WHERE lane_type = $1 AND lane_id = $2', ['section', sec.id]);
  await q('DELETE FROM sections WHERE id = $1', [sec.id]);
  await bumpRev(song.id);
  return { ok: true };
});

route('POST', '/api/songs/:id/tracks', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'editContent');
  const tid = id();
  const n = await one('SELECT count(*)::int AS n FROM tracks WHERE song_id = $1', [song.id]);
  await q(`INSERT INTO tracks (id, song_id, name, instrument, color, pos) VALUES ($1,$2,$3,$4,$5,$6)`,
    [tid, song.id, String(body.name || 'Track').slice(0, 80), body.instrument || 'piano', body.color || '#b76ce8', n.n]);
  await bumpRev(song.id);
  return one('SELECT * FROM tracks WHERE id = $1', [tid]);
});

route('PATCH', '/api/tracks/:id', async ({ user, params, body }) => {
  const tr = await one('SELECT * FROM tracks WHERE id = $1', [params.id]);
  if (!tr) err(404, 'Track not found');
  const { song } = await songAccess(user, tr.song_id, 'editContent');
  await q(`UPDATE tracks SET name=$2, instrument=$3, color=$4, pos=$5 WHERE id=$1`,
    [tr.id, body.name != null ? String(body.name).slice(0, 80) : tr.name,
      body.instrument || tr.instrument, body.color || tr.color,
      body.pos != null ? body.pos : tr.pos]);
  await bumpRev(song.id);
  return one('SELECT * FROM tracks WHERE id = $1', [tr.id]);
});

route('DELETE', '/api/tracks/:id', async ({ user, params }) => {
  const tr = await one('SELECT * FROM tracks WHERE id = $1', [params.id]);
  if (!tr) err(404, 'Track not found');
  const { song } = await songAccess(user, tr.song_id, 'editContent');
  await q('DELETE FROM takes WHERE lane_type = $1 AND lane_id = $2', ['track', tr.id]);
  await q('DELETE FROM tracks WHERE id = $1', [tr.id]);
  await bumpRev(song.id);
  return { ok: true };
});

// ----- takes -----

route('POST', '/api/songs/:id/takes', { binary: true }, async ({ user, params, url, body }) => {
  const { song, role } = await songAccess(user, params.id, 'addTake');
  if (!body || !body.length) err(400, 'No audio uploaded');
  if (body.length > 80 * 1024 * 1024) err(413, 'Audio too large');
  const meta = JSON.parse(url.searchParams.get('meta') || '{}');
  if (!meta.laneType || !meta.laneId || !meta.stage) err(400, 'meta {stage, laneType, laneId} required');
  if (meta.laneType === 'section') {
    const sec = await one('SELECT id FROM sections WHERE id = $1 AND song_id = $2', [meta.laneId, song.id]);
    if (!sec) err(404, 'Section not found');
  }
  if (meta.laneType === 'track') {
    const tr = await one('SELECT id FROM tracks WHERE id = $1 AND song_id = $2', [meta.laneId, song.id]);
    if (!tr) err(404, 'Track not found');
  }
  const ext = { 'audio/webm': '.webm', 'audio/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac' }[
    (url.searchParams.get('type') || '').split(';')[0]] || '.webm';
  let rec = await audio.ingest(body, ext);
  // Recorder sends the count-in + latency head to trim off (so the take starts exactly on its beat).
  const trimHead = Number(meta.trimHeadSec) || 0;
  if (trimHead > 0.01 && trimHead < rec.duration - 0.05) {
    rec = await audio.trim(rec.master, trimHead, rec.duration);
  }
  const isSuggestion = !perm.allows(role, 'editContent');
  const take = await newTakeFromRec(user, song, rec, meta, {
    isSuggestion, label: String(meta.name || 'Take').slice(0, 120),
  });
  return { take };
});

route('PATCH', '/api/takes/:id', async ({ user, params, body }) => {
  const { take, song } = await takeAccess(user, params.id, { editing: true });
  const updates = {
    name: body.name != null ? String(body.name).slice(0, 120) : take.name,
    offset_beats: body.offsetBeats != null ? Number(body.offsetBeats) : take.offset_beats,
    gain: body.gain != null ? Math.max(0, Math.min(4, Number(body.gain))) : take.gain,
    muted: body.muted != null ? !!body.muted : take.muted,
    lane_id: body.laneId != null ? body.laneId : take.lane_id,
    lane_type: body.laneType != null ? body.laneType : take.lane_type,
    stage: body.stage != null ? body.stage : take.stage,
    flags: body.flags !== undefined ? JSON.stringify(body.flags) : JSON.stringify(take.flags),
    notes: body.notes !== undefined ? (body.notes ? JSON.stringify(body.notes) : null) : (take.notes ? JSON.stringify(take.notes) : null),
  };
  if (body.laneId != null && updates.lane_type === 'section') {
    const sec = await one('SELECT id FROM sections WHERE id = $1 AND song_id = $2', [updates.lane_id, song.id]);
    if (!sec) err(404, 'Target section not found');
  }
  await q(`UPDATE takes SET name=$2, offset_beats=$3, gain=$4, muted=$5, lane_id=$6, lane_type=$7, stage=$8, flags=$9, notes=$10 WHERE id=$1`,
    [take.id, updates.name, updates.offset_beats, updates.gain, updates.muted, updates.lane_id, updates.lane_type, updates.stage, updates.flags, updates.notes]);
  await bumpRev(song.id);
  return { ok: true };
});

route('DELETE', '/api/takes/:id', async ({ user, params }) => {
  const { take, song, role } = await takeAccess(user, params.id);
  const own = take.author_id === user.id;
  if (!(own ? perm.allows(role, 'editOwn') : perm.allows(role, 'deleteAny'))) err(403, 'Cannot delete this take');
  await q('UPDATE takes SET deleted = true WHERE id = $1', [take.id]); // soft delete -> undoable
  await bumpRev(song.id);
  return { ok: true };
});

route('POST', '/api/takes/:id/restore', async ({ user, params }) => {
  const take = await one('SELECT * FROM takes WHERE id = $1', [params.id]);
  if (!take) err(404, 'Take not found');
  const { song, role } = await songAccess(user, take.song_id, 'view');
  const own = take.author_id === user.id;
  if (!(own ? perm.allows(role, 'editOwn') : perm.allows(role, 'deleteAny'))) err(403, 'Cannot restore this take');
  await q('UPDATE takes SET deleted = false WHERE id = $1', [take.id]);
  await bumpRev(song.id);
  return { ok: true };
});

route('POST', '/api/takes/:id/duplicate', async ({ user, params, body }) => {
  const { take, song } = await takeAccess(user, params.id);
  // placing a copy of your own pool item only needs addTake; everything else is contributor territory
  const placingOwnPoolItem = take.lane_type === 'pool' && take.author_id === user.id;
  const { role } = await songAccess(user, song.id, placingOwnPoolItem ? 'addTake' : 'editContent');
  const targetLaneType = body.laneType || take.lane_type;
  const tid = id();
  // leaving the pool onto the grid -> run the tempo check the pool import skipped
  let flags = take.flags || {};
  if (take.lane_type === 'pool' && targetLaneType !== 'pool') {
    flags = {};
    const tf = tempoFlag(song, take.analysis);
    if (tf) flags.tempo = tf;
  }
  await q(`INSERT INTO takes (id, song_id, stage, lane_type, lane_id, name, author_id, is_suggestion,
             offset_beats, gain, muted, file_id, history, analysis, notes, flags, rec_ctx, variant_of)
           SELECT $2, song_id, $3, $4, $5, $6, $7, $9, $8, gain, muted, file_id, '[]',
                  analysis, notes, $10, rec_ctx, variant_of
           FROM takes WHERE id = $1`,
    [take.id, tid, body.stage != null ? body.stage : take.stage, targetLaneType,
      body.laneId || take.lane_id, String(body.name || take.name + ' (copy)').slice(0, 120), user.id,
      body.offsetBeats != null ? Number(body.offsetBeats) : take.offset_beats,
      !perm.allows(role, 'editContent'), JSON.stringify(flags)]);
  await bumpRev(song.id);
  return { id: tid };
});

route('POST', '/api/takes/:id/audio-version', { binary: true }, async ({ user, params, url, body }) => {
  const { take, song } = await takeAccess(user, params.id, { editing: true });
  if (!body || !body.length) err(400, 'No audio uploaded');
  const ext = { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/webm': '.webm', 'audio/mp4': '.mp4', 'audio/flac': '.flac' }[
    (url.searchParams.get('type') || '').split(';')[0]] || '.wav';
  const rec = await audio.ingest(body, ext);
  await pushTakeAudio(take, rec, url.searchParams.get('label') || 'client render');
  void song;
  return { ok: true };
});

route('POST', '/api/takes/:id/revert', async ({ user, params }) => {
  const { take, song } = await takeAccess(user, params.id, { editing: true });
  const history = take.history || [];
  if (!history.length) err(409, 'No previous version to revert to');
  const prev = history[history.length - 1];
  const f = await one('SELECT id FROM files WHERE id = $1', [prev.file_id]);
  if (!f) err(409, 'Previous audio version is gone');
  await q('UPDATE takes SET file_id = $2, history = $3 WHERE id = $1',
    [take.id, prev.file_id, JSON.stringify(history.slice(0, -1))]);
  await bumpRev(song.id);
  return { ok: true };
});

route('POST', '/api/takes/:id/split', async ({ user, params, body }) => {
  const { take, song } = await takeAccess(user, params.id, { editing: true });
  const spb = spbOf(song);
  const atSec = Number(body.atSec);
  const master = await fileMaster(take.file_id);
  const dur = (await one('SELECT duration FROM files WHERE id = $1', [take.file_id])).duration;
  if (!(atSec > 0.05 && atSec < dur - 0.05)) err(400, 'Split point outside the take');
  const a = await audio.trim(master, 0, atSec);
  const b = await audio.trim(master, atSec, dur);
  await pushTakeAudio(take, a, 'split (left)');
  const song2 = await one('SELECT * FROM songs WHERE id = $1', [song.id]);
  await newTakeFromRec(user, song2, b,
    { stage: take.stage, laneType: take.lane_type, laneId: take.lane_id, offsetBeats: take.offset_beats + atSec / spb, recCtx: take.rec_ctx },
    { isSuggestion: false, label: take.name + ' (b)' });
  return { ok: true };
});

// ----- server-side processing (rubberband etc.) -----

async function processedRec(take, song, op, p) {
  const master = await fileMaster(take.file_id);
  const dur = (await one('SELECT duration FROM files WHERE id = $1', [take.file_id])).duration;
  switch (op) {
    case 'rubberband': {
      const stretch = p.stretch ? Math.max(0.25, Math.min(4, Number(p.stretch))) : 1;
      const cents = p.cents ? Math.max(-2400, Math.min(2400, Number(p.cents))) : 0;
      return { rec: await audio.rubberband(master, { stretch, pitchCents: cents }), label: `stretch ${stretch.toFixed(2)}× / ${cents}¢` };
    }
    case 'stretch-to-beats': {
      const spb = spbOf(song);
      const beats = Math.max(0.25, Number(p.beats));
      const stretch = (beats * spb) / dur;
      return { rec: await audio.rubberband(master, { stretch }), label: `fit to ${beats} beats` };
    }
    case 'trim': {
      const s = Math.max(0, Number(p.startSec) || 0);
      const e = Math.min(dur, Number(p.endSec) || dur);
      if (e - s < 0.05) err(400, 'Trim range too small');
      return { rec: await audio.trim(master, s, e), label: 'trim' };
    }
    case 'gainfade':
      return {
        rec: await audio.gainFade(master, {
          gain: p.gain != null ? Number(p.gain) : 1,
          fadeIn: Number(p.fadeIn) || 0, fadeOut: Number(p.fadeOut) || 0,
          normalize: !!p.normalize, reverse: !!p.reverse,
        }), label: 'gain/fades',
      };
    default:
      err(400, 'Unknown op');
  }
}

route('POST', '/api/takes/:id/process', async ({ user, params, body }) => {
  const { take, song, role } = await takeAccess(user, params.id);
  const own = take.author_id === user.id;
  if (!(perm.allows(role, 'process') || (own && perm.allows(role, 'editOwn')))) err(403, 'Your role cannot process takes');
  let op = body.op, p = body.params || {};
  let suggestion = null;
  if (op === 'match') {
    // analyze target vs reference (a take id or 'grid')
    const tgtMaster = await fileMaster(take.file_id);
    const tgtPcm = await audio.decodePcm(tgtMaster, '.flac');
    const tgtFrames = analysis.f0Track(tgtPcm);
    const tgtBpm = (take.analysis && take.analysis.tempo) || analysis.bpmDetect(tgtPcm);
    if (p.refTakeId && p.refTakeId !== 'grid') {
      const ref = await one('SELECT * FROM takes WHERE id = $1 AND song_id = $2', [p.refTakeId, song.id]);
      if (!ref) err(404, 'Reference take not found');
      const refPcm = await audio.decodePcm(await fileMaster(ref.file_id), '.flac');
      const refFrames = analysis.f0Track(refPcm);
      const refBpm = (ref.analysis && ref.analysis.tempo) || analysis.bpmDetect(refPcm);
      suggestion = analysis.matchAnalysis(refFrames, tgtFrames, refBpm.bpm, tgtBpm.bpm);
    } else {
      const flag = tempoFlag(song, { tempo: tgtBpm });
      suggestion = { cents: 0, ratio: flag ? flag.stretch : 1 };
    }
    op = 'rubberband';
    p = { stretch: p.ratio != null ? p.ratio : (suggestion.ratio || 1), cents: p.cents != null ? p.cents : (suggestion.cents || 0) };
  }
  const { rec, label } = await processedRec(take, song, op, p);
  if (body.preview) {
    const pid = stashPreview(rec, take.id, label);
    return { previewId: pid, duration: rec.duration, suggestion, applied: p };
  }
  await pushTakeAudio(take, rec, label);
  if (op === 'rubberband' && take.flags && take.flags.tempo && take.flags.tempo.state === 'open') {
    const flags = { ...take.flags, tempo: { ...take.flags.tempo, state: 'fixed' } };
    await q('UPDATE takes SET flags = $2 WHERE id = $1', [take.id, JSON.stringify(flags)]);
  }
  return { ok: true, suggestion, applied: p };
});

route('POST', '/api/takes/:id/commit-preview', async ({ user, params, body }) => {
  const { take, song, role } = await takeAccess(user, params.id);
  const own = take.author_id === user.id;
  if (!(perm.allows(role, 'process') || (own && perm.allows(role, 'editOwn')))) err(403, 'Your role cannot process takes');
  const pv = previews.get(body.previewId);
  if (!pv || pv.takeId !== take.id) err(404, 'Preview expired — run it again');
  if (body.asVariant) {
    const song2 = await one('SELECT * FROM songs WHERE id = $1', [song.id]);
    const t = await newTakeFromRec(user, song2, pv.rec,
      { stage: take.stage, laneType: take.lane_type, laneId: take.lane_id, offsetBeats: take.offset_beats, variantOf: take.id, recCtx: take.rec_ctx },
      { isSuggestion: false, label: `${take.name} · ${body.label || pv.label}` });
    previews.delete(body.previewId);
    return { ok: true, takeId: t.id };
  }
  await pushTakeAudio(take, pv.rec, body.label || pv.label);
  previews.delete(body.previewId);
  return { ok: true };
});

// Tempo-flag intent resolution.
route('POST', '/api/takes/:id/flag-intent', async ({ user, params, body }) => {
  const { take, song } = await takeAccess(user, params.id, { editing: true });
  const flag = take.flags && take.flags.tempo;
  if (!flag) err(404, 'No tempo flag on this take');
  const setState = async state => {
    await q('UPDATE takes SET flags = $2 WHERE id = $1',
      [take.id, JSON.stringify({ ...take.flags, tempo: { ...flag, state } })]);
    await bumpRev(song.id);
  };
  if (body.action === 'keep') { await setState('kept'); return { ok: true }; }
  const stretch = body.ratio != null ? Number(body.ratio) : flag.stretch;
  const master = await fileMaster(take.file_id);
  const rec = await audio.rubberband(master, { stretch });
  if (body.action === 'variant') {
    const song2 = await one('SELECT * FROM songs WHERE id = $1', [song.id]);
    await newTakeFromRec(user, song2, rec,
      { stage: take.stage, laneType: take.lane_type, laneId: take.lane_id, offsetBeats: take.offset_beats, variantOf: take.id, recCtx: take.rec_ctx },
      { isSuggestion: false, label: `${take.name} · on-grid` });
    await setState('variant');
    return { ok: true };
  }
  await pushTakeAudio(take, rec, `tempo fix ${stretch.toFixed(3)}×`);
  await setState('fixed');
  return { ok: true };
});

// ----- Note Correction -----

route('POST', '/api/takes/:id/analyze-notes', async ({ user, params }) => {
  const { take, song } = await takeAccess(user, params.id);
  const bpm = song.bpm || (take.analysis && take.analysis.tempo && take.analysis.tempo.bpm);
  if (!bpm) err(409, 'Set the official tempo first (Tempo Sense) so notes can be quantized.');
  const pcm = await audio.decodePcm(await fileMaster(take.file_id), '.flac');
  const frames = analysis.f0Track(pcm);
  const raw = analysis.extractNotes(frames);
  if (!raw.length) err(409, 'No clear pitched notes found in this take');
  const keyHint = song.key_root != null && song.key_mode ? { root: song.key_root, mode: song.key_mode } : null;
  const candidates = analysis.noteCandidates(raw, bpm, keyHint);
  return { bpm, rawNotes: raw, candidates };
});

route('POST', '/api/takes/:id/apply-notes', async ({ user, params, body }) => {
  const { take, song, role } = await takeAccess(user, params.id);
  const own = take.author_id === user.id;
  if (!(perm.allows(role, 'process') || (own && perm.allows(role, 'editOwn')))) err(403, 'Your role cannot process takes');
  const notes = (body.notes || []).map(n => ({ s: Number(n.s), l: Number(n.l), m: Math.round(n.m), v: n.v != null ? n.v : 0.9 }));
  if (!notes.length) err(400, 'notes required');
  const mode = body.mode || 'notes-only';
  if (mode === 'notes-only') {
    await q('UPDATE takes SET notes = $2 WHERE id = $1', [take.id, JSON.stringify(notes)]);
    await bumpRev(song.id);
    return { ok: true };
  }
  // corrected audio render — every note gets moved/stretched/retuned into its slot
  const spb = spbOf(song);
  const segs = (body.notes || []).filter(n => n.srcStart != null).map(n => ({
    srcStart: Number(n.srcStart), srcEnd: Number(n.srcEnd),
    dstStart: Number(n.s) * spb, dstLen: Number(n.l) * spb,
    cents: Number(n.cents) || 0,
  }));
  if (!segs.length) err(400, 'notes are missing source timings — run analyze-notes first');
  const master = await fileMaster(take.file_id);
  const total = Math.max(...segs.map(s => s.dstStart + s.dstLen)) + 0.25;
  const rec = await audio.renderCorrected(master, segs, total);
  if (mode === 'variant') {
    const song2 = await one('SELECT * FROM songs WHERE id = $1', [song.id]);
    const t = await newTakeFromRec(user, song2, rec,
      { stage: take.stage, laneType: take.lane_type, laneId: take.lane_id, offsetBeats: take.offset_beats, variantOf: take.id, recCtx: take.rec_ctx, notes },
      { isSuggestion: false, label: `${take.name} · corrected` });
    return { ok: true, takeId: t.id };
  }
  await pushTakeAudio(take, rec, 'note correction');
  await q('UPDATE takes SET notes = $2 WHERE id = $1', [take.id, JSON.stringify(notes)]);
  await bumpRev(song.id);
  return { ok: true };
});

// ----- Pool import (voice notes: single audio files or a whole ZIP) -----

route('POST', '/api/songs/:id/import', { binary: true }, async ({ user, params, url, body }) => {
  const { song, role } = await songAccess(user, params.id, 'addTake');
  if (!body || body.length < 16) err(400, 'No file uploaded');
  const isSuggestion = !perm.allows(role, 'editContent');
  const claimedName = String(url.searchParams.get('name') || 'Voice note').slice(0, 110);
  const isZip = body[0] === 0x50 && body[1] === 0x4b && (claimedName.toLowerCase().endsWith('.zip')
    || (url.searchParams.get('type') || '').includes('zip') || (body[2] === 3 && body[3] === 4));
  const results = [];
  const failures = [];
  const importOne = async (name, ext, data) => {
    try {
      const rec = await audio.ingest(data, ext);
      if (rec.duration < 0.2) throw new Error('too short');
      const take = await newTakeFromRec(user, song, rec,
        { stage: 0, laneType: 'pool', laneId: 'pool', offsetBeats: 0 },
        { isSuggestion, label: name.replace(/[_-]+/g, ' ').trim().slice(0, 110) || 'Voice note' });
      results.push(take);
    } catch (e) {
      failures.push({ name, error: String(e.message || e).slice(0, 120) });
    }
  };
  if (isZip) {
    let entries;
    try { entries = require('./zip').audioEntries(body); }
    catch (e) { err(400, 'Could not read the ZIP: ' + e.message); }
    if (!entries.length) err(400, 'No audio files found inside the ZIP');
    for (const e of entries) await importOne(e.name, e.ext, e.data);
  } else {
    const dot = claimedName.lastIndexOf('.');
    const ext = dot >= 0 ? claimedName.slice(dot).toLowerCase() : '.ogg';
    await importOne(dot >= 0 ? claimedName.slice(0, dot) : claimedName, ext, body);
  }
  if (!results.length) err(422, 'Nothing could be imported' + (failures.length ? ` (${failures[0].name}: ${failures[0].error})` : ''));
  return { imported: results.length, failed: failures, takes: results };
});

// Send a take (or pool item) to another song's Pool.
route('POST', '/api/takes/:id/send-to-song', async ({ user, params, body }) => {
  const { take } = await takeAccess(user, params.id); // view access on the source song
  const targetId = String(body.songId || '');
  if (targetId === take.song_id) err(400, 'That take is already in this song');
  const { song: target, role: targetRole } = await songAccess(user, targetId, 'addTake');
  const tid = id();
  await q(`INSERT INTO takes (id, song_id, stage, lane_type, lane_id, name, author_id, is_suggestion,
             offset_beats, gain, file_id, analysis, notes, flags, rec_ctx)
           VALUES ($1,$2,0,'pool','pool',$3,$4,$5,0,$6,$7,$8,$9,'{}','{}')`,
    [tid, target.id, take.name, user.id, !perm.allows(targetRole, 'editContent'),
      take.gain, take.file_id, JSON.stringify(take.analysis || {}),
      take.notes ? JSON.stringify(take.notes) : null]);
  await bumpRev(target.id);
  return { id: tid, songName: target.name };
});

// ----- flatten -----

route('POST', '/api/songs/:id/flatten', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'process');
  const spb = spbOf(song);
  const sections = await rows('SELECT * FROM sections WHERE song_id = $1', [song.id]);
  const secById = Object.fromEntries(sections.map(s => [s.id, s]));
  // work in ABSOLUTE beats so takes from different sections combine correctly
  const absOf = t => (t.lane_type === 'section' ? (secById[t.lane_id]?.start_beat || 0) : 0) + t.offset_beats;
  const takes = [];
  for (const tid of body.takeIds || []) {
    const t = await one('SELECT * FROM takes WHERE id = $1 AND song_id = $2 AND NOT deleted', [tid, song.id]);
    if (t && t.file_id) takes.push(t);
  }
  if (takes.length < 1) err(400, 'Select takes to flatten');
  const baseAbs = Math.min(...takes.map(absOf));
  const items = [];
  for (const t of takes) {
    items.push({ master: await fileMaster(t.file_id), offsetSec: (absOf(t) - baseAbs) * spb, gain: t.gain });
  }
  const rec = await audio.mixdown(items);
  const first = takes.slice().sort((a, b) => absOf(a) - absOf(b))[0];
  const laneType = body.laneType || first.lane_type;
  const laneId = body.laneId || first.lane_id;
  const laneOrigin = laneType === 'section' ? (secById[laneId]?.start_beat || 0) : 0;
  const t = await newTakeFromRec(user, song, rec,
    { stage: body.stage || first.stage, laneType, laneId, offsetBeats: baseAbs - laneOrigin },
    { isSuggestion: false, label: String(body.name || 'Flattened').slice(0, 120) });
  return { take: t };
});

// ----- picks -----

route('PUT', '/api/songs/:id/picks', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'pick');
  const stage = Math.max(1, Math.min(3, Number(body.stage) || 1));
  const laneId = String(body.laneId || '');
  const takeIds = (body.takeIds || []).slice(0, 40);
  await q(`INSERT INTO picks (song_id, stage, user_id, lane_id, take_ids) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (song_id, stage, user_id, lane_id) DO UPDATE SET take_ids = $5`,
    [song.id, stage, user.id, laneId, JSON.stringify(takeIds)]);
  await bumpRev(song.id);
  return { ok: true };
});

// ----- comps & votes -----

route('POST', '/api/songs/:id/comps', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'createComp');
  const cid = id();
  await q(`INSERT INTO comps (id, song_id, stage, name, author_id, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [cid, song.id, Math.max(1, Math.min(3, Number(body.stage) || 1)),
      String(body.name || 'Comp').slice(0, 120), user.id, JSON.stringify(body.payload || {})]);
  await bumpRev(song.id);
  return one('SELECT * FROM comps WHERE id = $1', [cid]);
});

route('PATCH', '/api/comps/:id', async ({ user, params, body }) => {
  const comp = await one('SELECT * FROM comps WHERE id = $1', [params.id]);
  if (!comp) err(404, 'Comp not found');
  const { song, role } = await songAccess(user, comp.song_id, 'view');
  if (!(comp.author_id === user.id ? perm.allows(role, 'createComp') : perm.allows(role, 'deleteAny'))) {
    err(403, 'Only the author (or an admin) can edit this comp');
  }
  await q('UPDATE comps SET name = $2, payload = $3, updated_at = now() WHERE id = $1',
    [comp.id, body.name != null ? String(body.name).slice(0, 120) : comp.name,
      body.payload !== undefined ? JSON.stringify(body.payload) : JSON.stringify(comp.payload)]);
  await bumpRev(song.id);
  return { ok: true };
});

route('DELETE', '/api/comps/:id', async ({ user, params }) => {
  const comp = await one('SELECT * FROM comps WHERE id = $1', [params.id]);
  if (!comp) err(404, 'Comp not found');
  const { song, role } = await songAccess(user, comp.song_id, 'view');
  if (!(comp.author_id === user.id ? perm.allows(role, 'createComp') : perm.allows(role, 'deleteAny'))) {
    err(403, 'Only the author (or an admin) can delete this comp');
  }
  await q('DELETE FROM comps WHERE id = $1', [comp.id]);
  await bumpRev(song.id);
  return { ok: true };
});

route('PUT', '/api/comps/:id/vote', async ({ user, params, body }) => {
  const comp = await one('SELECT * FROM comps WHERE id = $1', [params.id]);
  if (!comp) err(404, 'Comp not found');
  const { song } = await songAccess(user, comp.song_id, 'vote');
  const score = Math.max(1, Math.min(10, Math.round(Number(body.score))));
  await q(`INSERT INTO votes (comp_id, user_id, score) VALUES ($1,$2,$3)
           ON CONFLICT (comp_id, user_id) DO UPDATE SET score = $3, updated_at = now()`,
    [comp.id, user.id, score]);
  await bumpRev(song.id);
  return { ok: true };
});

route('DELETE', '/api/comps/:id/vote', async ({ user, params }) => {
  const comp = await one('SELECT * FROM comps WHERE id = $1', [params.id]);
  if (!comp) err(404, 'Comp not found');
  const { song } = await songAccess(user, comp.song_id, 'vote');
  await q('DELETE FROM votes WHERE comp_id = $1 AND user_id = $2', [comp.id, user.id]);
  await bumpRev(song.id);
  return { ok: true };
});

route('GET', '/api/comps/:id/render', async ({ user, params, url, res }) => {
  const comp = await one('SELECT * FROM comps WHERE id = $1', [params.id]);
  if (!comp) err(404, 'Comp not found');
  const { song } = await songAccess(user, comp.song_id, 'view');
  const rec = await renderComp(song, comp);
  if (url.searchParams.get('format') === 'wav') {
    const wav = await audio.toWav(rec.master);
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${(song.name + ' - ' + comp.name).replace(/[^\w\- ]+/g, '')}.wav"`,
    });
    res.end(wav);
  } else {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    res.end(asBuf(rec.play));
  }
  return { __handled: true };
});

// ----- comments -----

route('POST', '/api/songs/:id/comments', async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'comment');
  const cid = id();
  await q(`INSERT INTO comments (id, song_id, stage, beat, take_id, comp_id, author_id, text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [cid, song.id, Math.max(1, Math.min(3, Number(body.stage) || 1)),
      body.beat != null ? Number(body.beat) : null, body.takeId || null, body.compId || null,
      user.id, String(body.text || '').slice(0, 4000)]);
  await bumpRev(song.id);
  return one('SELECT * FROM comments WHERE id = $1', [cid]);
});

route('PATCH', '/api/comments/:id', async ({ user, params, body }) => {
  const c = await one('SELECT * FROM comments WHERE id = $1', [params.id]);
  if (!c) err(404, 'Comment not found');
  const { song, role } = await songAccess(user, c.song_id, 'view');
  if (body.text != null) {
    if (c.author_id !== user.id) err(403, 'Only the author can edit a comment');
    await q('UPDATE comments SET text = $2 WHERE id = $1', [c.id, String(body.text).slice(0, 4000)]);
  }
  if (body.resolved != null) {
    if (!(c.author_id === user.id || perm.allows(role, 'editContent'))) err(403, 'Cannot resolve');
    await q('UPDATE comments SET resolved = $2 WHERE id = $1', [c.id, !!body.resolved]);
  }
  await bumpRev(song.id);
  return { ok: true };
});

route('DELETE', '/api/comments/:id', async ({ user, params }) => {
  const c = await one('SELECT * FROM comments WHERE id = $1', [params.id]);
  if (!c) err(404, 'Comment not found');
  const { song, role } = await songAccess(user, c.song_id, 'view');
  if (!(c.author_id === user.id || perm.allows(role, 'deleteAny'))) err(403, 'Cannot delete this comment');
  await q('DELETE FROM comments WHERE id = $1', [c.id]);
  await bumpRev(song.id);
  return { ok: true };
});

// ----- files / previews / midi -----

route('GET', '/api/files/:id/audio', async ({ user, params, res }) => {
  const f = await one('SELECT play FROM files WHERE id = $1', [params.id]);
  if (!f) err(404, 'File not found');
  void user;
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(asBuf(f.play));
  return { __handled: true };
});

route('GET', '/api/files/:id/peaks', async ({ params }) => {
  const f = await one('SELECT peaks, duration FROM files WHERE id = $1', [params.id]);
  if (!f) err(404, 'File not found');
  return { peaks: f.peaks, duration: f.duration };
});

route('GET', '/api/files/:id/wav', async ({ params, res }) => {
  const f = await one('SELECT master FROM files WHERE id = $1', [params.id]);
  if (!f) err(404, 'File not found');
  const wav = await audio.toWav(asBuf(f.master));
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Disposition': 'attachment; filename="take.wav"' });
  res.end(wav);
  return { __handled: true };
});

route('GET', '/api/previews/:id/audio', async ({ params, res }) => {
  const pv = previews.get(params.id);
  if (!pv) err(404, 'Preview expired');
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  res.end(asBuf(pv.rec.play));
  return { __handled: true };
});

route('POST', '/api/songs/:id/midi', { binary: true }, async ({ user, params, body }) => {
  const { song } = await songAccess(user, params.id, 'editSettings');
  if (!body || body.length < 8) err(400, 'No MIDI uploaded');
  if (body.length > 2 * 1024 * 1024) err(413, 'MIDI too large');
  const fid = id();
  await q('INSERT INTO files (id, mime, master, play, duration, peaks) VALUES ($1,$2,$3,$4,0,$5)',
    [fid, 'audio/midi', body, body, JSON.stringify([])]);
  await q('UPDATE songs SET midi_file_id = $2 WHERE id = $1', [song.id, fid]);
  await bumpRev(song.id);
  return { ok: true, fileId: fid };
});

route('GET', '/api/songs/:id/midi', async ({ user, params, res }) => {
  const { song } = await songAccess(user, params.id, 'view');
  if (!song.midi_file_id) err(404, 'No MIDI backing uploaded');
  const f = await one('SELECT master FROM files WHERE id = $1', [song.midi_file_id]);
  if (!f) err(404, 'MIDI file missing');
  res.writeHead(200, { 'Content-Type': 'audio/midi' });
  res.end(asBuf(f.master));
  return { __handled: true };
});

module.exports = { routes, ApiError };
