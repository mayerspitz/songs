'use strict';
// Database adapter: real Postgres (DATABASE_URL, e.g. Neon) in production,
// embedded PGlite (file-backed) for local dev so the app runs with zero setup.

const path = require('path');

let _db = null; // { query(text, params) -> Promise<{rows}> , kind }

async function connect() {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    const needSsl = !/localhost|127\.0\.0\.1/.test(url);
    const pool = new Pool({
      connectionString: url,
      ssl: needSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    _db = { kind: 'pg', query: (text, params) => pool.query(text, params) };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = path.join(__dirname, '..', '.data', 'pglite');
    require('fs').mkdirSync(dir, { recursive: true });
    const lite = new PGlite('file://' + dir);
    await lite.waitReady;
    _db = { kind: 'pglite', query: (text, params) => lite.query(text, params) };
    console.log('[db] DATABASE_URL not set — using embedded PGlite at .data/pglite (local dev mode)');
  }
  await migrate(_db);
  return _db;
}

async function q(text, params) {
  const db = await connect();
  return db.query(text, params);
}
async function rows(text, params) { return (await q(text, params)).rows; }
async function one(text, params) { return (await q(text, params)).rows[0] || null; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  color TEXT NOT NULL DEFAULT '#7c6cf0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  stage INT NOT NULL DEFAULT 1,               -- official current stage 1|2|3
  bpm REAL,                                   -- official tempo; NULL = not set yet (Tempo Sense running)
  beats_per_bar INT,                          -- official meter; NULL = not set yet
  bars INT NOT NULL DEFAULT 16,
  key_root INT,                               -- 0..11 (C..B); optional
  key_mode TEXT,                              -- 'major'|'minor'; optional
  latency_ms INT NOT NULL DEFAULT 90,        -- recording latency compensation
  midi_file_id TEXT,                          -- optional backing .mid
  chords JSONB NOT NULL DEFAULT '[]',         -- backing chord pad [{s,l,root,quality}] beats
  beat JSONB NOT NULL DEFAULT '{}',           -- backing drum beat {pattern,gain}
  stage2_source_comp TEXT,                    -- comp id from stage 1 used in Song stage
  stage3_source_comp TEXT,                    -- comp id from stage 2 used in Arrange stage
  rev INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,                -- 'song' | 'collection'
  resource_id TEXT NOT NULL,
  email TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),          -- linked once that email signs in
  role TEXT NOT NULL,                         -- viewer|voter|suggester|contributor|admin|owner
  invited_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id, email)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,                         -- of master
  master BYTEA NOT NULL,                      -- lossless FLAC master (processing source)
  play BYTEA NOT NULL,                        -- AAC .m4a playback copy (universally decodable)
  duration REAL NOT NULL,
  peaks JSONB NOT NULL,                       -- waveform min/max buckets
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_beat REAL NOT NULL,
  length_beats REAL NOT NULL,
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instrument TEXT NOT NULL DEFAULT 'piano',
  color TEXT NOT NULL,
  pos INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  stage INT NOT NULL,                         -- 1|2|3
  lane_type TEXT NOT NULL,                    -- 'section' | 'perf' | 'track'
  lane_id TEXT NOT NULL,                      -- section id | 'perf' | track id
  name TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  is_suggestion BOOLEAN NOT NULL DEFAULT false,
  offset_beats REAL NOT NULL DEFAULT 0,       -- position relative to lane origin (section start / beat 0)
  gain REAL NOT NULL DEFAULT 1,
  muted BOOLEAN NOT NULL DEFAULT false,
  file_id TEXT REFERENCES files(id),
  history JSONB NOT NULL DEFAULT '[]',        -- [{file_id,label,at}] previous audio versions (undo chain)
  analysis JSONB NOT NULL DEFAULT '{}',       -- {bpm:{bpm,confidence,candidates}, f0Median, voiced}
  notes JSONB,                                -- note-corrected melody [{s,l,m,v}] beats/midi
  flags JSONB NOT NULL DEFAULT '{}',          -- {tempo:{detected,ratio,state:'open'|'kept'|'fixed'|'variant'}}
  rec_ctx JSONB NOT NULL DEFAULT '{}',        -- backing active while recording: {metronome,pad,beatPattern,backing:{compId|takeIds},fromBeat,toBeat}
  variant_of TEXT,                            -- take id this is an intent-variant of
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS picks (
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  stage INT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lane_id TEXT NOT NULL,
  take_ids JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (song_id, stage, user_id, lane_id)
);
CREATE TABLE IF NOT EXISTS comps (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  stage INT NOT NULL,
  name TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  payload JSONB NOT NULL,                     -- s1 {selections:{sectionId:[takeIds]}}
                                              -- s2 {sourceCompId,structure:[{sectionId,repeats}],takeIds:[perf takes]}
                                              -- s3 {sourceCompId,selections:{trackId:[takeIds]}}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS votes (
  comp_id TEXT NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INT NOT NULL CHECK (score BETWEEN 1 AND 10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comp_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  stage INT NOT NULL,
  beat REAL,                                  -- pinned timeline position (optional)
  take_id TEXT REFERENCES takes(id) ON DELETE CASCADE,
  comp_id TEXT REFERENCES comps(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_takes_song ON takes(song_id);
CREATE INDEX IF NOT EXISTS idx_sections_song ON sections(song_id);
CREATE INDEX IF NOT EXISTS idx_members_res ON members(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_comps_song ON comps(song_id);
CREATE INDEX IF NOT EXISTS idx_comments_song ON comments(song_id);
`;

async function migrate(db) {
  // Statements are idempotent; run one by one (pglite dislikes some multi-statement execs with params).
  for (const stmt of SCHEMA.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
}

function id() { return require('crypto').randomUUID().replace(/-/g, '').slice(0, 20); }

async function bumpRev(songId) {
  await q('UPDATE songs SET rev = rev + 1 WHERE id = $1', [songId]);
}

module.exports = { connect, q, rows, one, id, bumpRev };
