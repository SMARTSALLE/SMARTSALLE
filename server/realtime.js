'use strict';
const { str } = require('./util');

/* Hub temps réel (Server-Sent Events) : chaque client connecté reçoit
   immédiatement toute modification de réservation / notification. */
const clients = new Map(); // id -> { res, user }
let seq = 0;

function add(req, res, user) {
  const id = ++seq;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, at: Date.now() })}\n\n`);
  clients.set(id, { res, user });
  broadcastPresence();

  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(id);
    broadcastPresence();
  });
  return id;
}

function publish(type, payload, filter) {
  const event = { type, payload: payload || {}, at: Date.now() };
  const data = `event: change\ndata: ${JSON.stringify(event)}\n\n`;
  for (const [, c] of clients) {
    if (filter && !filter(c.user)) continue;
    try { c.res.write(data); } catch (e) { /* ignore */ }
  }
}

function presence() {
  const map = new Map();
  for (const [, c] of clients) {
    const u = c.user;
    if (!u) continue;
    const key = u.id;
    if (!map.has(key)) {
      map.set(key, {
        id: u.id,
        name: str(`${u.prenom} ${u.nom}`),
        role: u.role,
        active_option: u.active_option ? u.active_option.code : null
      });
    }
  }
  return [...map.values()];
}

function broadcastPresence() {
  const list = presence();
  const data = `event: presence\ndata: ${JSON.stringify({ users: list, at: Date.now() })}\n\n`;
  for (const [, c] of clients) {
    try { c.res.write(data); } catch (e) { /* ignore */ }
  }
}

function stats() {
  return { clients: clients.size, users: presence().length };
}

module.exports = { add, publish, presence, stats, broadcastPresence };
