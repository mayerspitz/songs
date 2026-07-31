# Humlab 〰

**Hum it before you build it.** Humlab is a collaborative song-composition studio where songs start as humming: record takes into beat-perfect sections, let invited friends pick favorites and vote, then carry the winner through performance and full arrangement — one stage at a time.

## The three stages

Every song moves through three stages (switcher at the top; work in any stage anytime — the *official* stage is just the badge admins advance):

| Stage | What happens | Compiled versions |
|---|---|---|
| **1 · Hum** | Split the song into **Sections** (as short as 1 beat). Record unlimited humming **Takes** into each section against a metronome/chord-pad/drum-beat/MIDI backing. Cut, paste, split, nudge, effects. Everyone picks favorites per section. | **Comps** — one-or-more takes per section, voted 1–10 |
| **2 · Song** | Take the winning Hum comp, decide the **structure** (section order & repeats), and record full-song performance runs over it. Contributors record their own revisions, compile, and vote. | **Song comps** — structure + performance takes, voted 1–10 |
| **3 · Arrange** | Instrumental decisions: add instrument **tracks**, generate clean instrument lines from note-corrected hums (simple key-note output first), record real audio, apply per-range effect chains. | **Mixes** — take selection per track, voted 1–10 |

The "Arrange →" action on a winning comp advances the song and pre-selects it as the next stage's source; each stage has a dropdown to switch which source comp you're building on.

## The features that solve the hard problems

- **Born on the grid** — every take is recorded *into* a specific section with a count-in, so a 1-beat idea can never become an orphan you can't place. Takes can be dragged between sections, split at the playhead, duplicated, copied across sections.
- **Tempo Sense** — tempo setup is optional. The app detects BPM (and meter) from your hums; confidence grows as you record. One click sets it official. Takes that later drift off-grid get a ⚠ flag with an intent dialog: *fix* (rubberband stretch onto the grid, previewed first), *keep* (it was intentional), or *keep both* (save an on-grid variant).
- **Match** — analyzes a take against a reference take (or the grid), detects the pitch offset (¢) and tempo ratio, and applies studio-grade time-stretch + transpose via ffmpeg's rubberband. Preview before apply; apply in-place (undoable) or as a variant.
- **Note Correction** — extracts the notes you *meant* from a hum: pitch-tracks the audio, segments notes, and offers several accurate interpretations (grid resolutions × scale snapping, ranked by least correction — never wild). Piano-roll preview with synth audition. Save the notes, render corrected audio, or keep several intents as variants.
- **Backing without bleed** — while recording you can hear the metronome, a chord pad, a drum beat, or an uploaded MIDI file. Echo cancellation removes what the app plays from your mic signal, and each take remembers its *recording context* — so you can replay any take with the exact backing it was recorded against, regenerated from the original sources (never from low-quality bleed).
- **Flatten & layering** — select multiple takes and bounce them into one; comps can layer several takes per section.
- **Instruments** — generate a track from any note-corrected take with 9 built-in instruments (piano, e-piano, bass, strings, violin, flute, trumpet, marimba, synth lead), then shape it with per-range effect chains (reverb, delay, EQ, chorus, tremolo, distortion, gain) — preview live, apply offline, undo anytime.
- **Collaboration** — pin comments to any beat, on takes, or on comps. Per-user picks ("listen as Alice"). Comps with 1–10 voting. Server-rendered WAV export of any comp or of whatever you're currently hearing.
- **Pristine audio path** — uploads are archived as lossless FLAC masters; all processing (stretch, pitch, trim, mixdown) runs server-side through ffmpeg + librubberband from the master, never from a lossy copy. Browsers stream lightweight MP3 play-copies.

## Roles

Six cumulative levels, assignable per **song** or per **collection** (a user's effective role is the highest granted). Anyone can create an account and fully own their *own* songs; other people's songs are visible only when invited by email.

| Role | Can do |
|---|---|
| **viewer** | Open, listen, read comments & votes |
| **voter** | + rate comps 1–10 |
| **suggester** | + comment/pin, record suggestion takes (marked ✦), keep personal picks, edit own material |
| **contributor** | + full creative access in all stages: sections, any takes, effects/processing, comps, structure, tracks |
| **admin** | + invite/manage members (up to admin), song settings, official tempo/meter/key, advance the official stage & source comps, delete anything |
| **owner** | + delete the song/collection (the creator) |

## Running it

### Local (zero setup)

```bash
npm install
npm run dev        # DEV_LOGIN=1 — plain email login for local testing
# open http://localhost:3000
```

With no `DATABASE_URL` the app uses an embedded Postgres (PGlite) stored in `.data/`. Never enable `DEV_LOGIN` in production.

Tests: `npm run smoke` (API end-to-end, server must be running) and `node test/e2e.js` (headless-browser flow incl. recording via a fake mic).

### Production (Render + Neon)

The repo ships a `Dockerfile` — deploy as a **Docker** web service on [Render](https://render.com) (already set up: auto-deploys `main`).

1. **Neon** — create a project at [neon.tech](https://neon.tech), copy the connection string (`postgresql://…?sslmode=require`).
2. **Google OAuth** — in [Google Cloud Console](https://console.cloud.google.com/apis/credentials): create an OAuth 2.0 Client ID (Web application) with authorized redirect URI `https://<your-app>.onrender.com/auth/google/callback`. Configure the consent screen (External, publish it so any Google account can sign in).
3. **Render env vars** (Environment tab):

   | Key | Value |
   |---|---|
   | `NEON_POSTGRES_CONNECTION_STRING` (or `DATABASE_URL`) | the Neon connection string |
   | `GOOGLE_AUTH_CLIENT_ID` (or `GOOGLE_CLIENT_ID`/`CLIENT_ID`) | OAuth client id |
   | `GOOGLE_AUTH_CLIENT_SECRET` (or `GOOGLE_CLIENT_SECRET`/`CLIENT_SECRET`) | OAuth client secret |
   | `APP_URL` *(optional)* | `https://<your-app>.onrender.com` — inferred from request headers if unset |

4. *(Optional but recommended)* Settings → Health Check Path: `/api/config`.

Audio is stored inside Postgres (FLAC master + MP3 play copy, ~3.5 MB per recorded minute), so the app needs **no disk or S3** and survives redeploys. Watch your Neon storage tier as your library grows.

## Stack

Zero-framework by design: a dependency-light Node server (`pg`, `ffmpeg-static`, PGlite for local dev; hand-rolled HTTP routing, Google OAuth, sessions) and a vanilla-JS SPA (canvas timeline, Web Audio engine for playback/backing/recording/synth instruments/FX, DSP analysis server-side in pure JS). All audio processing goes through ffmpeg with librubberband.

```
server/   db.js  auth.js  perm.js  api.js  audio.js  analysis.js  index.js
public/   index.html  style.css  js/{main,store,api,ui,audio,midi,synths,timeline}.js  js/views/*
test/     smoke.js (API)  e2e.js (browser)
```
