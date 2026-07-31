'use strict';
// End-to-end backend smoke test against a live server (DEV_LOGIN=1).
// Usage: DEV_LOGIN=1 node server/index.js &  then  node test/smoke.js

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;

function wavFromNotes(notes, { sr = 48000, bpm = 120 } = {}) {
  // notes: [{beat, beats, midi}] -> 16-bit mono WAV with soft attacks (hum-like)
  const spb = 60 / bpm;
  const totalSec = Math.max(...notes.map(n => (n.beat + n.beats) * spb)) + 0.3;
  const n = Math.round(totalSec * sr);
  const pcm = new Float32Array(n);
  for (const note of notes) {
    const f = 440 * Math.pow(2, (note.midi - 69) / 12);
    const s = Math.round(note.beat * spb * sr);
    const len = Math.round(note.beats * spb * sr * 0.92);
    for (let i = 0; i < len && s + i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, i / (0.02 * sr)) * Math.min(1, (len - i) / (0.05 * sr));
      pcm[s + i] += Math.sin(2 * Math.PI * f * t) * 0.5 * env
        + Math.sin(2 * Math.PI * 2 * f * t) * 0.12 * env; // small 2nd harmonic, voice-ish
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  return buf;
}


function buildZip(entries) {
  // store-method (no compression) ZIP for testing the import endpoint
  const { crc32 } = require('zlib');
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

function client() {
  let cookie = '';
  return {
    async call(method, path, { body, binary, query } = {}) {
      const url = new URL(BASE + path);
      for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
      const res = await fetch(url, {
        method,
        headers: {
          cookie,
          ...(binary ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
        },
        body: body ? (binary ? body : JSON.stringify(body)) : undefined,
      });
      const setc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setc) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sid=')) cookie = kv;
      }
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data };
    },
  };
}

function check(name, cond, extra) {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.error('  FAIL ' + name, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}

(async () => {
  const owner = client();
  const guest = client();

  console.log('· auth');
  let r = await owner.call('POST', '/auth/dev', { body: { email: 'owner@test.dev', name: 'Olive Owner' } });
  check('dev login owner', r.status === 200, r.data);
  r = await guest.call('POST', '/auth/dev', { body: { email: 'guest@test.dev', name: 'Gus Guest' } });
  check('dev login guest', r.status === 200, r.data);
  r = await owner.call('GET', '/api/me');
  check('me', r.data.user && r.data.user.email === 'owner@test.dev', r.data);

  console.log('· song + sections');
  r = await owner.call('POST', '/api/songs', { body: { name: 'Smoke Song', bars: 8 } });
  check('create song', r.status === 200 && r.data.id, r.data);
  const songId = r.data.id;
  r = await owner.call('GET', `/api/songs/${songId}`);
  check('snapshot has starter section', r.data.sections && r.data.sections.length === 1, r.data.sections);
  const sec1 = r.data.sections[0];
  r = await owner.call('POST', `/api/songs/${songId}/sections`, { body: { name: 'Hook', startBeat: 16, lengthBeats: 1, color: '#e8595c' } });
  check('1-beat section', r.status === 200 && r.data.length_beats === 1, r.data);
  const sec2 = r.data;

  console.log('· guest has no access until invited');
  r = await guest.call('GET', `/api/songs/${songId}`);
  check('guest blocked', r.status === 403, r.status);
  r = await owner.call('POST', `/api/members/song/${songId}`, { body: { email: 'guest@test.dev', role: 'suggester' } });
  check('invite guest as suggester', r.status === 200, r.data);
  r = await guest.call('GET', `/api/songs/${songId}`);
  check('guest can now view', r.status === 200 && r.data.myRole === 'suggester', r.data.myRole);

  console.log('· take upload + analysis (hum at 120bpm, A minor riff)');
  const wav = wavFromNotes([
    { beat: 0, beats: 1, midi: 57 }, { beat: 1, beats: 1, midi: 60 },
    { beat: 2, beats: 1, midi: 64 }, { beat: 3, beats: 1, midi: 60 },
    { beat: 4, beats: 1, midi: 57 }, { beat: 5, beats: 1, midi: 60 },
    { beat: 6, beats: 1, midi: 64 }, { beat: 7, beats: 1, midi: 67 },
    { beat: 8, beats: 2, midi: 64 }, { beat: 10, beats: 2, midi: 60 },
    { beat: 12, beats: 4, midi: 57 },
  ], { bpm: 120 });
  r = await owner.call('POST', `/api/songs/${songId}/takes`, {
    binary: true, body: wav,
    query: { type: 'audio/wav', meta: JSON.stringify({ stage: 1, laneType: 'section', laneId: sec1.id, name: 'Riff v1' }) },
  });
  check('upload take', r.status === 200 && r.data.take, r.data);
  const take1 = r.data.take;
  check('bpm detected ~120', take1.analysis && take1.analysis.tempo && Math.abs(take1.analysis.tempo.bpm - 120) < 6,
    take1.analysis && take1.analysis.tempo);

  r = await owner.call('GET', `/api/songs/${songId}/tempo-sense`);
  check('tempo-sense suggests ~120', r.data.suggestions && r.data.suggestions[0] && Math.abs(r.data.suggestions[0].bpm - 120) < 6, r.data);

  console.log('· set official tempo, then upload an off-tempo take -> flag');
  r = await owner.call('PATCH', `/api/songs/${songId}`, { body: { bpm: 120, beatsPerBar: 4 } });
  check('set official tempo', r.status === 200 && r.data.bpm === 120, r.data);
  const wavOff = wavFromNotes(
    Array.from({ length: 12 }, (_, i) => ({ beat: i, beats: 1, midi: 57 + (i % 4) * 3 })), { bpm: 138 });
  r = await owner.call('POST', `/api/songs/${songId}/takes`, {
    binary: true, body: wavOff,
    query: { type: 'audio/wav', meta: JSON.stringify({ stage: 1, laneType: 'section', laneId: sec1.id, name: 'Later idea (fast)' }) },
  });
  const takeOff = r.data.take;
  check('off-tempo flagged', takeOff && takeOff.flags && takeOff.flags.tempo && takeOff.flags.tempo.state === 'open', takeOff && takeOff.flags);

  console.log('· intent fix: stretch to grid as variant');
  r = await owner.call('POST', `/api/takes/${takeOff.id}/flag-intent`, { body: { action: 'variant' } });
  check('variant created', r.status === 200, r.data);
  r = await owner.call('GET', `/api/songs/${songId}`);
  const variant = r.data.takes.find(t => t.variantOf === takeOff.id);
  check('variant exists + on-grid duration',
    variant && Math.abs(variant.duration / takeOff.duration - takeOff.flags.tempo.stretch) < 0.06,
    variant && { dur: variant.duration, orig: takeOff.duration });

  console.log('· processing: preview + commit, match');
  r = await owner.call('POST', `/api/takes/${take1.id}/process`, { body: { op: 'rubberband', params: { cents: 200 }, preview: true } });
  check('preview created', r.status === 200 && r.data.previewId, r.data);
  const prevAudio = await owner.call('GET', `/api/previews/${r.data.previewId}/audio`);
  check('preview audio streams', prevAudio.status === 200 && prevAudio.data.length > 1000, prevAudio.status);
  r = await owner.call('POST', `/api/takes/${take1.id}/commit-preview`, { body: { previewId: r.data.previewId, label: '+2 semitones' } });
  check('commit preview', r.status === 200, r.data);
  r = await owner.call('POST', `/api/takes/${take1.id}/revert`, {});
  check('revert to original', r.status === 200, r.data);
  r = await owner.call('POST', `/api/takes/${takeOff.id}/process`, { body: { op: 'match', params: { refTakeId: take1.id }, preview: true } });
  check('match suggests ratio>1 (slower)', r.status === 200 && r.data.suggestion && r.data.suggestion.ratio > 1.05, r.data.suggestion);

  console.log('· note correction');
  r = await owner.call('POST', `/api/takes/${take1.id}/analyze-notes`, { body: {} });
  check('note candidates', r.status === 200 && r.data.candidates && r.data.candidates.length >= 2, r.status === 200 ? r.data.candidates && r.data.candidates.length : r.data);
  if (r.status === 200 && r.data.candidates.length) {
    const cand = r.data.candidates[0];
    const notesOk = cand.notes.length >= 8 && cand.notes.length <= 14;
    check('candidate note count sane (8-14)', notesOk, cand.notes.length);
    const r2 = await owner.call('POST', `/api/takes/${take1.id}/apply-notes`, { body: { notes: cand.notes, mode: 'notes-only' } });
    check('apply notes-only', r2.status === 200, r2.data);
    const r3 = await owner.call('POST', `/api/takes/${take1.id}/apply-notes`, { body: { notes: cand.notes, mode: 'variant' } });
    check('corrected-audio variant', r3.status === 200 && r3.data.takeId, r3.data);
  }

  console.log('· flatten + picks + comps + votes');
  r = await owner.call('POST', `/api/songs/${songId}/flatten`, { body: { takeIds: [take1.id, variant.id], name: 'Layered' } });
  check('flatten', r.status === 200 && r.data.take, r.data);
  r = await owner.call('PUT', `/api/songs/${songId}/picks`, { body: { stage: 1, laneId: sec1.id, takeIds: [take1.id] } });
  check('save picks', r.status === 200, r.data);
  r = await owner.call('POST', `/api/songs/${songId}/comps`, {
    body: { stage: 1, name: 'Olive full v1', payload: { selections: { [sec1.id]: [take1.id], [sec2.id]: [] } } },
  });
  check('create comp', r.status === 200 && r.data.id, r.data);
  const compId = r.data.id;
  r = await guest.call('PUT', `/api/comps/${compId}/vote`, { body: { score: 8 } });
  check('guest (suggester⊇voter) votes', r.status === 200, r.data);
  r = await guest.call('POST', `/api/songs/${songId}/comps`, { body: { stage: 1, name: 'nope', payload: {} } });
  check('suggester cannot create comps', r.status === 403, r.status);
  r = await guest.call('POST', `/api/songs/${songId}/takes`, {
    binary: true, body: wavFromNotes([{ beat: 0, beats: 2, midi: 62 }, { beat: 2, beats: 2, midi: 65 }], { bpm: 120 }),
    query: { type: 'audio/wav', meta: JSON.stringify({ stage: 1, laneType: 'section', laneId: sec2.id, name: 'Gus idea' }) },
  });
  check('suggester take is marked suggestion', r.status === 200 && r.data.take.isSuggestion === true, r.data.take && r.data.take.isSuggestion);

  console.log('· comp render + wav export');
  r = await owner.call('GET', `/api/comps/${compId}/render`);
  check('render m4a', r.status === 200 && r.data.length > 2000, r.status);
  r = await owner.call('GET', `/api/comps/${compId}/render`, { query: { format: 'wav' } });
  check('render wav', r.status === 200 && r.data.slice(0, 4).toString() === 'RIFF', r.status);

  console.log('· comments, split, stage flow');
  r = await guest.call('POST', `/api/songs/${songId}/comments`, { body: { stage: 1, beat: 4.5, text: 'love this pin' } });
  check('pinned comment', r.status === 200 && r.data.beat === 4.5, r.data);
  r = await owner.call('POST', `/api/takes/${take1.id}/split`, { body: { atSec: 2.0 } });
  check('split take', r.status === 200, r.data);
  r = await owner.call('PATCH', `/api/songs/${songId}`, { body: { stage: 2, stage2SourceComp: compId } });
  check('advance to Song stage', r.status === 200 && r.data.stage === 2, r.data);
  const perfWav = wavFromNotes(Array.from({ length: 16 }, (_, i) => ({ beat: i, beats: 1, midi: 57 + (i % 5) * 2 })), { bpm: 120 });
  r = await owner.call('POST', `/api/songs/${songId}/takes`, {
    binary: true, body: perfWav,
    query: { type: 'audio/wav', meta: JSON.stringify({ stage: 2, laneType: 'perf', laneId: 'perf', name: 'Full run 1' }) },
  });
  check('perf take', r.status === 200, r.data);
  const perfTake = r.data.take;
  r = await owner.call('POST', `/api/songs/${songId}/comps`, {
    body: {
      stage: 2, name: 'Song v1',
      payload: { sourceCompId: compId, structure: [{ sectionId: sec1.id, repeats: 2 }, { sectionId: sec2.id, repeats: 1 }], takeIds: [perfTake.id], backingGain: 0.4 },
    },
  });
  check('stage-2 comp', r.status === 200 && r.data.id, r.data);
  const s2comp = r.data.id;
  r = await owner.call('GET', `/api/comps/${s2comp}/render`);
  check('stage-2 render (perf + backing)', r.status === 200 && r.data.length > 2000, r.status);

  console.log('· stage 3: tracks + mix');
  r = await owner.call('PATCH', `/api/songs/${songId}`, { body: { stage: 3, stage3SourceComp: s2comp } });
  check('advance to Arrange', r.status === 200 && r.data.stage === 3, r.data);
  r = await owner.call('POST', `/api/songs/${songId}/tracks`, { body: { name: 'Lead', instrument: 'violin' } });
  check('create track', r.status === 200 && r.data.id, r.data);
  const trackId = r.data.id;
  r = await owner.call('POST', `/api/songs/${songId}/takes`, {
    binary: true, body: wav,
    query: { type: 'audio/wav', meta: JSON.stringify({ stage: 3, laneType: 'track', laneId: trackId, name: 'Violin line' }) },
  });
  check('track take', r.status === 200, r.data);
  const trackTake = r.data.take;
  r = await owner.call('POST', `/api/songs/${songId}/comps`, {
    body: { stage: 3, name: 'Mix 1', payload: { sourceCompId: s2comp, selections: { [trackId]: [trackTake.id] } } },
  });
  check('mix comp', r.status === 200, r.data);
  r = await owner.call('GET', `/api/comps/${r.data.id}/render`, { query: { format: 'wav' } });
  check('mix render wav', r.status === 200 && r.data.slice(0, 4).toString() === 'RIFF', r.status);


  console.log('· pool: zip import, place, move, send-to-song');
  const note1 = wavFromNotes([{ beat: 0, beats: 2, midi: 60 }, { beat: 2, beats: 2, midi: 64 }], { bpm: 120 });
  const note2 = wavFromNotes([{ beat: 0, beats: 1, midi: 67 }], { bpm: 120 });
  const zip = buildZip([
    { name: 'voice/PTT-001.wav', data: note1 },
    { name: 'voice/PTT-002.wav', data: note2 },
    { name: 'voice/notes.txt', data: Buffer.from('not audio') },
  ]);
  r = await owner.call('POST', `/api/songs/${songId}/import`, {
    binary: true, body: zip, query: { name: 'voicenotes.zip', type: 'application/zip' },
  });
  check('zip import: 2 audio entries', r.status === 200 && r.data.imported === 2, r.data);
  const poolTake = r.data.takes[0];
  check('pool item is unplaced (stage 0, pool lane)', poolTake.stage === 0 && poolTake.laneType === 'pool', poolTake);
  check('pool item not tempo-flagged', !(poolTake.flags && poolTake.flags.tempo), poolTake.flags);
  r = await owner.call('POST', `/api/songs/${songId}/import`, {
    binary: true, body: note2, query: { name: 'single-note.wav', type: 'audio/wav' },
  });
  check('single-file import', r.status === 200 && r.data.imported === 1, r.data);
  r = await owner.call('POST', `/api/takes/${poolTake.id}/duplicate`, {
    body: { stage: 1, laneType: 'section', laneId: sec1.id, offsetBeats: 2, name: poolTake.name },
  });
  check('place copy from pool', r.status === 200 && r.data.id, r.data);
  r = await owner.call('GET', `/api/songs/${songId}`);
  const placed = r.data.takes.find(t => t.laneId === sec1.id && t.name === poolTake.name);
  const stillPooled = r.data.takes.find(t => t.id === poolTake.id);
  check('copy landed in section, original stays pooled', !!placed && stillPooled.laneType === 'pool', { placed: !!placed });
  const pool2 = r.data.takes.filter(t => t.laneType === 'pool')[1];
  r = await owner.call('PATCH', `/api/takes/${pool2.id}`, { body: { stage: 1, laneType: 'section', laneId: sec1.id, offsetBeats: 0 } });
  check('move pool item out of pool', r.status === 200, r.data);
  r = await owner.call('POST', '/api/songs', { body: { name: 'Second Song', bpm: 100 } });
  const song2Id = r.data.id;
  r = await owner.call('POST', `/api/takes/${take1.id}/send-to-song`, { body: { songId: song2Id } });
  check('send take to other song pool', r.status === 200 && r.data.songName === 'Second Song', r.data);
  r = await owner.call('GET', `/api/songs/${song2Id}`);
  check('take arrived in other song pool', r.data.takes.some(t => t.laneType === 'pool' && t.name === take1.name), r.data.takes.length);
  r = await guest.call('POST', `/api/takes/${take1.id}/send-to-song`, { body: { songId: song2Id } });
  check('guest without target access blocked', r.status === 403, r.status);

  console.log('· role guardrails');
  r = await guest.call('PATCH', `/api/songs/${songId}`, { body: { bpm: 90 } });
  check('suggester cannot change settings', r.status === 403, r.status);
  r = await guest.call('DELETE', `/api/takes/${take1.id}`);
  check('suggester cannot delete others takes', r.status === 403, r.status);
  r = await owner.call('POST', `/api/members/song/${songId}`, { body: { email: 'viewer@test.dev', role: 'viewer' } });
  check('invite viewer', r.status === 200, r.data);
  const viewer = client();
  await viewer.call('POST', '/auth/dev', { body: { email: 'viewer@test.dev', name: 'Vera Viewer' } });
  r = await viewer.call('PUT', `/api/comps/${compId}/vote`, { body: { score: 9 } });
  check('viewer cannot vote', r.status === 403, r.status);
  r = await viewer.call('GET', `/api/songs/${songId}`);
  check('viewer can view', r.status === 200, r.status);

  console.log(failures ? `\n${failures} FAILURES` : '\nAll smoke checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH', e); process.exit(1); });
