'use strict';
// Google Sign-In (OAuth 2.0 code flow, no SDK) + cookie sessions.
// DEV_LOGIN=1 additionally enables a plain email dev login for local testing — never set it in production.

const crypto = require('crypto');
const { q, one, id } = require('./db');

const SESSION_DAYS = 60;
const COLORS = ['#e8595c', '#e8a03d', '#d8c93a', '#5fbf6e', '#43b5a0', '#4a9de8', '#7c6cf0', '#b76ce8', '#e86cb8', '#8a9aa8'];

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(/; */)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function setCookie(res, name, value, { maxAge, secure } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge) bits.push(`Max-Age=${maxAge}`);
  if (secure) bits.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, bits.join('; ')) : bits.join('; '));
}

async function userFromReq(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const row = await one(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`, [sid]);
  return row || null;
}

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3);
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expires]);
  setCookie(res, 'sid', token, { maxAge: SESSION_DAYS * 86400, secure: appUrl(req).startsWith('https') });
}

async function upsertUser({ email, name, picture }) {
  email = String(email).trim().toLowerCase();
  let user = await one('SELECT * FROM users WHERE email = $1', [email]);
  if (!user) {
    const uid = id();
    const color = COLORS[parseInt(crypto.createHash('md5').update(email).digest('hex').slice(0, 6), 16) % COLORS.length];
    await q('INSERT INTO users (id, email, name, picture, color) VALUES ($1,$2,$3,$4,$5)',
      [uid, email, name || email.split('@')[0], picture || null, color]);
    user = await one('SELECT * FROM users WHERE id = $1', [uid]);
  } else if ((name && name !== user.name) || (picture && picture !== user.picture)) {
    await q('UPDATE users SET name = COALESCE($2,name), picture = COALESCE($3,picture) WHERE id = $1',
      [user.id, name || null, picture || null]);
  }
  // Link any pending email invites to this account.
  await q('UPDATE members SET user_id = $1 WHERE lower(email) = $2 AND user_id IS NULL', [user.id, email]);
  return user;
}

// ---- Routes ----

async function googleStart(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) { res.writeHead(500); return res.end('GOOGLE_CLIENT_ID not configured'); }
  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, 'oauth_state', state, { maxAge: 600, secure: appUrl(req).startsWith('https') });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: appUrl(req) + '/auth/google/callback',
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
  res.end();
}

async function googleCallback(req, res, url) {
  const cookies = parseCookies(req);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== cookies.oauth_state) {
    res.writeHead(400); return res.end('OAuth state mismatch — try signing in again.');
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: appUrl(req) + '/auth/google/callback',
      grant_type: 'authorization_code',
    }),
  });
  const tok = await tokenRes.json();
  if (!tok.access_token) { res.writeHead(400); return res.end('Google sign-in failed: ' + JSON.stringify(tok)); }
  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + tok.access_token },
  });
  const info = await infoRes.json();
  if (!info.email) { res.writeHead(400); return res.end('Google account has no email.'); }
  const user = await upsertUser({ email: info.email, name: info.name, picture: info.picture });
  await createSession(res, req, user.id);
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function devLogin(req, res, body) {
  if (process.env.DEV_LOGIN !== '1') { res.writeHead(404); return res.end('not found'); }
  const { email, name } = body || {};
  if (!email) { res.writeHead(400); return res.end(JSON.stringify({ error: 'email required' })); }
  const user = await upsertUser({ email, name });
  await createSession(res, req, user.id);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, user: { id: user.id, email: user.email, name: user.name } }));
}

async function logout(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) await q('DELETE FROM sessions WHERE token = $1', [sid]);
  setCookie(res, 'sid', '', { maxAge: 0 });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
}

module.exports = { userFromReq, googleStart, googleCallback, devLogin, logout, appUrl };
