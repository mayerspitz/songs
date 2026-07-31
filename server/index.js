'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connect, q } = require('./db');
const authMod = require('./auth');
const { routes, ApiError } = require('./api');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function readBody(req, { limit, binary }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (binary) return resolve(buf);
      if (!buf.length) return resolve({});
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch { reject(new ApiError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUB, p);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) {
      // SPA fallback
      file = path.join(PUB, 'index.html');
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathName = url.pathname;
  try {
    // auth endpoints
    if (pathName === '/auth/google' && req.method === 'GET') return await authMod.googleStart(req, res);
    if (pathName === '/auth/google/callback' && req.method === 'GET') return await authMod.googleCallback(req, res, url);
    if (pathName === '/auth/dev' && req.method === 'POST') {
      const body = await readBody(req, { limit: 64 * 1024 });
      return await authMod.devLogin(req, res, body);
    }
    if (pathName === '/auth/logout' && req.method === 'POST') return await authMod.logout(req, res);

    if (pathName.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathName.match(r.rx);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => params[n] = decodeURIComponent(m[i + 1]));
        const user = await authMod.userFromReq(req);
        if (!user && !r.opts.public) throw new ApiError(401, 'Sign in first');
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await readBody(req, {
            limit: r.opts.binary ? 100 * 1024 * 1024 : 2 * 1024 * 1024,
            binary: !!r.opts.binary,
          });
        }
        const data = await r.handler({ req, res, url, params, body, user });
        if (data && data.__handled) return;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(data == null ? { ok: true } : data));
      }
      throw new ApiError(404, 'No such API endpoint');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, pathName);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    if (status === 500) console.error(`[api] ${req.method} ${pathName}:`, e);
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Server error' }));
    } else {
      res.end();
    }
  }
});

(async () => {
  await connect();
  await q('DELETE FROM sessions WHERE expires_at < now()');
  setInterval(() => q('DELETE FROM sessions WHERE expires_at < now()').catch(() => {}), 3600e3).unref();
  server.listen(PORT, () => {
    console.log(`Humlab listening on http://localhost:${PORT}`);
    if (process.env.DEV_LOGIN === '1') console.log('[auth] DEV_LOGIN enabled — do not use in production');
    if (!authMod.GOOGLE_ID()) console.log('[auth] Google OAuth not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  });
})().catch(e => { console.error('Fatal boot error:', e); process.exit(1); });
