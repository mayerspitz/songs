'use strict';
// Browser end-to-end test with Playwright + Chromium's fake microphone.
// Prereqs: DEV_LOGIN=1 server running on :3000 (fresh .data is nicest).
// Usage: node test/e2e.js

const { chromium } = require('playwright-core');

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const ok = (name, cond, extra) => {
  if (cond) console.log('  ok  ' + name);
  else { failures++; console.error('  FAIL ' + name, extra !== undefined ? String(extra).slice(0, 300) : ''); }
};

// Synthesize a hum-like melody WAV that Chromium will use as the fake microphone.
function makeMicWav(path) {
  const sr = 48000, bpm = 110, spb = 60 / bpm;
  const notes = [
    { beat: 0, beats: 1, midi: 57 }, { beat: 1, beats: 1, midi: 60 },
    { beat: 2, beats: 1, midi: 64 }, { beat: 3, beats: 1, midi: 60 },
    { beat: 4, beats: 2, midi: 64 }, { beat: 6, beats: 2, midi: 57 },
  ];
  const totalSec = 8 * spb + 0.2;
  const n = Math.round(totalSec * sr);
  const pcm = new Float32Array(n);
  for (const note of notes) {
    const f = 440 * Math.pow(2, (note.midi - 69) / 12);
    const s = Math.round(note.beat * spb * sr);
    const len = Math.round(note.beats * spb * sr * 0.9);
    for (let i = 0; i < len && s + i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, i / (0.03 * sr)) * Math.min(1, (len - i) / (0.06 * sr));
      pcm[s + i] += (Math.sin(2 * Math.PI * f * t) * 0.45 + Math.sin(2 * Math.PI * 2 * f * t) * 0.1) * env;
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  require('fs').writeFileSync(path, buf);
}

(async () => {
  const exec = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  const micWav = require('os').tmpdir() + '/humlab-e2e-mic.wav';
  makeMicWav(micWav);
  const browser = await chromium.launch({
    executablePath: require('fs').existsSync(exec) ? exec : undefined,
    args: [
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micWav}`,
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));

  console.log('· login page');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  ok('login renders', await page.locator('.login-card').count() === 1);
  await page.fill('.dev-login input', 'e2e@test.dev');
  await page.click('.dev-login button');
  await page.waitForSelector('.page-title', { timeout: 15000 });
  ok('home renders after login', await page.locator('.page-title').textContent() === 'Your songs');

  console.log('· create song');
  await page.click('button:has-text("+ Compose song")');
  await page.fill('.modal input.input', 'E2E Anthem');
  await page.fill('.modal input[type=number]', '110');
  await page.click('.modal button:has-text("Create")');
  await page.waitForSelector('.songview', { timeout: 15000 });
  ok('song view opens', true);
  ok('tempo widget shows official bpm', (await page.locator('.tempo-widget').textContent()).includes('110'));
  ok('stage tabs present', await page.locator('.stage-tab').count() === 3);
  ok('timeline canvas present', await page.locator('canvas.tl-canvas').count() === 1);

  console.log('· record a take with the fake mic (~3.2s)');
  await page.click('button.record');
  await page.waitForSelector('.btn.rec-live', { timeout: 15000 });
  ok('recording banner shows', await page.locator('.rec-banner').count() === 1);
  await page.waitForTimeout(3200);
  await page.click('.btn.rec-live');
  await page.waitForSelector('.busy-overlay', { timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.busy-overlay', { state: 'detached', timeout: 120000 });
  await page.waitForTimeout(600);
  const snap1 = await page.evaluate(() => fetch(location.origin + '/api/home').then(r => r.json()));
  ok('take stored (home shows 1 take)', snap1.songs[0] && snap1.songs[0].takeCount >= 1, JSON.stringify(snap1.songs));
  ok('inspector shows the new take', await page.locator('.inspector .take-name, .inspector b').count() >= 1);

  console.log('· solo playback of the take');
  await page.click('.inspector button:has-text("▶ Solo")');
  await page.waitForTimeout(700);
  ok('no console errors so far', errors.length === 0, errors.join(' | '));

  console.log('· pick it + save comp + vote');
  const pickBtn = page.locator('.inspector button:has-text("pick")').first();
  if (await pickBtn.count()) await pickBtn.click();
  await page.waitForTimeout(500);
  page.once('dialog', d => d.accept('My first comp'));
  await page.click('button:has-text("Save current listen as")');
  await page.waitForSelector('.comp-card', { timeout: 15000 });
  ok('comp card appears', await page.locator('.comp-card').count() === 1);
  await page.locator('.vote-slider').first().fill('9');
  await page.locator('.vote-slider').first().dispatchEvent('change');
  await page.waitForTimeout(800);
  ok('vote registered', (await page.locator('.comp-card .small.dim').first().textContent()).includes('9.0'));

  console.log('· comment with pin');
  await page.click('.panel-tab:has-text("💬")');
  await page.fill('.comment-input', 'love the hook here');
  await page.click('button:has-text("📍 at playhead")');
  await page.waitForTimeout(600);
  ok('comment appears', (await page.locator('.comment-text').first().textContent()) === 'love the hook here');

  console.log('· members panel');
  await page.click('.panel-tab:has-text("👥")');
  await page.fill('.invite-box input[type=email]', 'friend@test.dev');
  await page.click('.invite-box button:has-text("Invite")');
  await page.waitForTimeout(600);
  ok('invited member listed', (await page.locator('.member-row').count()) >= 2);

  console.log('· stage switching');
  await page.click('.stage-tab:has-text("2 · Song")');
  await page.waitForTimeout(400);
  ok('stage 2 toolbar shows', await page.locator('.subtoolbar').count() === 1);
  await page.click('.stage-tab:has-text("3 · Arrange")');
  await page.waitForTimeout(400);
  ok('stage 3 add-track visible', await page.locator('button:has-text("+ Track")').count() === 1);
  await page.click('button:has-text("+ Track")');
  await page.click('.modal button:has-text("Add track")');
  await page.waitForTimeout(600);
  ok('track created (toolbar has track btn)', await page.locator('button:has-text("⚙ Track")').count() === 1);

  console.log('· note correction dialog on the hum (back on stage 1)');
  await page.click('.stage-tab:has-text("1 · Hum")');
  await page.waitForTimeout(400);
  // select first clip via inspector Actions
  const canvas = page.locator('canvas.tl-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 30, box.y + 26 + 26 + 20); // first clip area
  await page.waitForTimeout(300);
  const actionsBtn = page.locator('button:has-text("Actions ▾")');
  if (await actionsBtn.count()) {
    await actionsBtn.click();
    const nc = page.locator('.menu-item:has-text("Note correction")');
    if (await nc.count()) {
      await nc.click();
      const gotDialog = await page.waitForSelector('.piano-roll', { timeout: 90000 }).then(() => true).catch(() => false);
      ok('note-correction candidates render (fake mic tone)', gotDialog,
        gotDialog ? '' : 'no pitched notes in fake stream is acceptable — but dialog should error-toast');
      if (gotDialog) {
        ok('candidate rows listed', (await page.locator('.cand-row').count()) >= 1);
        await page.click('.modal-head .icon-btn');
      }
    } else ok('note correction menu item exists', false);
  } else ok('take selectable for actions', false);

  console.log('· mobile viewport sanity');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal page overflow on mobile', overflow <= 2, 'overflow=' + overflow);
  ok('side panel stacked below', await page.locator('.side-panel').isVisible());

  const benign = e => /favicon|Autofill|deprecated|Third-party|AudioContext was not allowed|status of 4\d\d/i.test(e);
  const realErrors = errors.filter(e => !benign(e));
  ok('zero real console errors end-to-end', realErrors.length === 0, realErrors.join(' | '));

  await browser.close();
  console.log(failures ? `\n${failures} E2E FAILURES` : '\nAll E2E checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('E2E CRASH', e); process.exit(1); });
