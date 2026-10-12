'use strict';
const { ok, created } = require('../router');
const { ApiError, readJson, str, int, requireFields, bool } = require('../util');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const realtime = require('../realtime');
const { notify } = require('./auth');

module.exports = function personalRoutes(router) {

  /* ================= NOTES (privées) ================= */
  router.add('GET', '/api/notes', async ({ req, res }) => {
    const user = requireAuth(req);
    const rows = db.get().prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id DESC').all(user.id);
    return ok(res, { notes: rows });
  });

  router.add('POST', '/api/notes', async ({ req, res }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    requireFields(b, ['title']);
    const r = db.get().prepare('INSERT INTO notes (user_id, title, content) VALUES (?,?,?)')
      .run(user.id, str(b.title, 160), str(b.content, 5000));
    db.audit(user, 'CREATION_NOTE', 'notes', Number(r.lastInsertRowid), null, { title: b.title });
    return created(res, { ok: true, id: Number(r.lastInsertRowid) });
  });

  router.add('PUT', '/api/notes/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    const note = db.get().prepare('SELECT * FROM notes WHERE id = ?').get(+params.id);
    if (!note) throw new ApiError(404, 'NOT_FOUND', 'Note introuvable.');
    if (note.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette note ne vous appartient pas.');
    db.get().prepare("UPDATE notes SET title=?, content=?, updated_at=datetime('now') WHERE id=?")
      .run(b.title !== undefined ? str(b.title, 160) : note.title, b.content !== undefined ? str(b.content, 5000) : note.content, note.id);
    db.audit(user, 'MODIFICATION_NOTE', 'notes', note.id, null, { title: b.title });
    return ok(res, { ok: true });
  });

  router.add('DELETE', '/api/notes/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const note = db.get().prepare('SELECT * FROM notes WHERE id = ?').get(+params.id);
    if (!note) throw new ApiError(404, 'NOT_FOUND', 'Note introuvable.');
    if (note.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette note ne vous appartient pas.');
    db.get().prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    db.audit(user, 'SUPPRESSION_NOTE', 'notes', note.id, note, null);
    return ok(res, { ok: true });
  });

  /* ================= TÂCHES ================= */
  router.add('GET', '/api/tasks', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const args = [user.id];
    let sql = 'SELECT * FROM tasks WHERE user_id = ?';
    if (query.status) { sql += ' AND status = ?'; args.push(query.status); }
    sql += ' ORDER BY CASE priority WHEN \'URGENT\' THEN 1 WHEN \'HIGH\' THEN 2 WHEN \'NORMAL\' THEN 3 ELSE 4 END, due_date IS NULL, due_date, id DESC';
    return ok(res, { tasks: db.get().prepare(sql).all(...args) });
  });

  router.add('POST', '/api/tasks', async ({ req, res }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    requireFields(b, ['title']);
    const priority = ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(b.priority) ? b.priority : 'NORMAL';
    const status = ['TODO', 'DOING', 'DONE'].includes(b.status) ? b.status : 'TODO';
    const r = db.get().prepare('INSERT INTO tasks (user_id, title, description, due_date, priority, status) VALUES (?,?,?,?,?,?)')
      .run(user.id, str(b.title, 160), str(b.description, 2000), b.due_date ? str(b.due_date, 10) : null, priority, status);
    db.audit(user, 'CREATION_TACHE', 'tasks', Number(r.lastInsertRowid), null, { title: b.title, priority });
    realtime.publish('task.updated', { user_id: user.id });
    return created(res, { ok: true, id: Number(r.lastInsertRowid) });
  });

  router.add('PUT', '/api/tasks/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(+params.id);
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Tâche introuvable.');
    if (task.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette tâche ne vous appartient pas.');
    const priority = b.priority !== undefined && ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(b.priority) ? b.priority : task.priority;
    const status = b.status !== undefined && ['TODO', 'DOING', 'DONE'].includes(b.status) ? b.status : task.status;
    db.get().prepare(`UPDATE tasks SET title=?, description=?, due_date=?, priority=?, status=?, updated_at=datetime('now') WHERE id=?`)
      .run(b.title !== undefined ? str(b.title, 160) : task.title,
        b.description !== undefined ? str(b.description, 2000) : task.description,
        b.due_date !== undefined ? (b.due_date ? str(b.due_date, 10) : null) : task.due_date,
        priority, status, task.id);
    db.audit(user, 'MODIFICATION_TACHE', 'tasks', task.id, { status: task.status }, { status });
    realtime.publish('task.updated', { user_id: user.id, id: task.id, status });
    return ok(res, { ok: true });
  });

  router.add('DELETE', '/api/tasks/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const task = db.get().prepare('SELECT * FROM tasks WHERE id = ?').get(+params.id);
    if (!task) throw new ApiError(404, 'NOT_FOUND', 'Tâche introuvable.');
    if (task.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette tâche ne vous appartient pas.');
    db.get().prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    db.audit(user, 'SUPPRESSION_TACHE', 'tasks', task.id, task, null);
    return ok(res, { ok: true });
  });

  /* ================= NOTIFICATIONS ================= */
  router.add('GET', '/api/notifications', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const limit = Math.min(+(query.limit || 50), 200);
    const rows = db.get().prepare(`SELECT * FROM notifications
      WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT ?`).all(user.id, limit);
    const unread = db.get().prepare('SELECT COUNT(*) AS c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL').get(user.id).c;
    return ok(res, { notifications: rows, unread });
  });

  router.add('POST', '/api/notifications/read', async ({ req, res }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    const d = db.get();
    if (Array.isArray(b.ids) && b.ids.length) {
      const ids = b.ids.map((x) => +x).filter(Number.isFinite);
      const stmt = d.prepare('UPDATE notifications SET read_at = datetime(\'now\') WHERE id = ? AND user_id = ?');
      for (const id of ids) stmt.run(id, user.id);
    } else {
      d.prepare('UPDATE notifications SET read_at = datetime(\'now\') WHERE user_id = ? AND read_at IS NULL').run(user.id);
    }
    const unread = d.prepare('SELECT COUNT(*) AS c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL').get(user.id).c;
    return ok(res, { ok: true, unread });
  });

  router.add('DELETE', '/api/notifications/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const n = db.get().prepare('SELECT * FROM notifications WHERE id = ?').get(+params.id);
    if (!n) throw new ApiError(404, 'NOT_FOUND', 'Notification introuvable.');
    if (n.user_id !== null && n.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Notification non applicable.');
    db.get().prepare('DELETE FROM notifications WHERE id = ?').run(n.id);
    return ok(res, { ok: true });
  });
};
