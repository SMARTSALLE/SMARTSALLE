'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { fail, ApiError } = require('./util');
const { createRouter } = require('./router');
const realtime = require('./realtime');
const { currentUser } = require('./auth');  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  var UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

const router = createRouter();
require('./routes')(router);

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const target = path.join(UPLOAD_DIR, path.normalize(pathname.slice('/uploads/'.length)).replace(/^\.\.(\/|\\|$)/, ''));
    if (!target.startsWith(UPLOAD_DIR) || !fs.existsSync(target)) { res.writeHead(404); res.end('Not found'); return; }
    const stat = fs.statSync(target);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=600' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target).pipe(res);
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Un asset manquant ne doit pas renvoyer l'application (erreur 404 explicite)
    if (path.extname(rel)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Fichier introuvable');
      return;
    }
    // SPA : toute route sans extension renvoie l'application
    target = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(target).toLowerCase();
  const stat = fs.statSync(target);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
  };
  if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const secure = req.headers['x-forwarded-proto'] === 'https' || url.protocol === 'https:';

  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');

  try {
    // --- API / temps réel ---
    if (pathname === '/api/events' || pathname === '/events') {
      const user = currentUser(req);
      if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise');
      realtime.add(req, res, user);
      return;
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/r/') || pathname === '/api') {
      const handled = await router.handle(req, res, pathname, query, { secure, realtime });
      if (!handled) throw new ApiError(404, 'NOT_FOUND', `Route introuvable : ${pathname}`);
      return;
    }

    // --- Fichiers statiques ---
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, pathname);
      return;
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Méthode non autorisée');
  } catch (e) {
    const mapped = require('./auth').mapDbError(e) || e;
    if (!res.headersSent) fail(res, mapped);
    else try { res.end(); } catch (e2) { /* ignore */ }
  } finally {
    if (process.env.LOG_REQUESTS === '1') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

function start() {
  const db = require('./db');
  db.open();
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║  SMARTSALLE ISPITS — serveur démarré         ║');
    console.log(`  ║  URL : http://localhost:${String(PORT).padEnd(24)}║`);
    console.log(`  ║  DB  : ${String(db.DB_PATH).slice(-40).padEnd(40)}║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Le port ${PORT} est déjà utilisé. Définissez PORT=8080 npm start`);
      process.exit(1);
    }
    throw e;
  });
  const shutdown = () => {
    console.log('\n[smartsalle] arrêt propre…');
    try { server.close(); } catch (e) { /* ignore */ }
    try { require('./db').get().close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { start, server, router };
