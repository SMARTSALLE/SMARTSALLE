'use strict';
const { ok } = require('../router');
const { ApiError, str, todayStr, addDays, mondayOf, fmtMin, nowMin, parseHHMM, dayKeyOf, DAY_NAMES, int } = require('../util');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { readJson } = require('../util');
const { notify } = require('./auth');
const S = require('../services');

function roomShape(r) {
  return {
    id: r.id, code: r.code, name: r.name, floor: r.floor, location: r.location,
    status: r.status, reserved_for: r.reserved_for,
    bookable: !!r.is_available_for_normal_booking,
    equipment: r.equipment || '', notes: r.notes || '', qr_token: r.qr_token,
    created_at: r.created_at
  };
}

function roomFilter(query) {
  const where = [];
  const args = [];
  if (query.floor) { where.push('floor = ?'); args.push(query.floor); }
  if (query.status) { where.push('status = ?'); args.push(query.status); }
  if (query.q) { where.push('(code LIKE ? OR name LIKE ?)'); args.push(`%${query.q}%`, `%${query.q}%`); }
  return { where, args };
}

module.exports = function catalogRoutes(router) {

  /* ---------------- SALLES ---------------- */
  router.add('GET', '/api/rooms', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const { where, args } = roomFilter(query);
    const sql = 'SELECT * FROM rooms' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ` ORDER BY CASE floor WHEN 'RDC' THEN 1 WHEN '1ER' THEN 2 ELSE 3 END, code`;
    const rows = db.get().prepare(sql).all(...args).map(roomShape);
    return ok(res, {
      rooms: rows,
      count: rows.length,
      // La coordination voit le statut de S12-1ER, mais elle n'est jamais réservable normalement.
      restricted_visible_to: user.role
    });
  });

  router.add('GET', '/api/rooms/:code', async ({ req, res, params }) => {
    requireAuth(req);
    const r = db.get().prepare('SELECT * FROM rooms WHERE code = ? OR id = ?').get(params.code, int(params.code, -1));
    if (!r) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const now = nowMin();
    const day = todayStr();
    const busy = db.get().prepare(`SELECT r.*, o.code AS option_code FROM reservations r JOIN options o ON o.id = r.option_id
      WHERE r.room_id = ? AND r.day = ? AND r.status = 'CONFIRMED' AND r.start_min <= ? AND r.end_min > ?`).all(r.id, day, now, now);
    const upcoming = db.get().prepare(`SELECT r.*, o.code AS option_code FROM reservations r JOIN options o ON o.id = r.option_id
      WHERE r.room_id = ? AND r.day = ? AND r.status = 'CONFIRMED' AND r.start_min >= ? ORDER BY r.start_min LIMIT 5`).all(r.id, day, now);
    return ok(res, {
      room: roomShape(r),
      occupied_now: busy.length > 0,
      current: busy[0] ? { option: busy[0].option_code, start: fmtMin(busy[0].start_min), end: fmtMin(busy[0].end_min), title: busy[0].title } : null,
      upcoming: upcoming.map((u) => ({ start: fmtMin(u.start_min), end: fmtMin(u.end_min), option: u.option_code, title: u.title }))
    });
  });

  router.add('GET', '/api/equipment', async ({ req, res }) => {
    requireAuth(req);
    const rows = db.get().prepare('SELECT equipment FROM rooms').all();
    const set = new Set();
    rows.forEach((r) => String(r.equipment || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => set.add(x)));
    return ok(res, { equipment: [...set].sort() });
  });

  /* ---------------- OPTIONS / GROUPES / MODULES / ENSEIGNANTS ---------------- */
  router.add('GET', '/api/options', async ({ req, res }) => {
    const user = require('../auth').currentUser(req);
    const rows = user && user.role === 'admin'
      ? db.get().prepare('SELECT * FROM options').all()
      : db.get().prepare("SELECT * FROM options WHERE status = 'ACTIVE'").all();
    // Tri par filière officielle puis par code — la page de connexion et celle
    // de création de compte affichent le catalogue groupé par filière.
    const order = db.OPTION_CATEGORIES;
    rows.sort((a, b) => {
      const ia = order.indexOf(a.category);
      const ib = order.indexOf(b.category);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || String(a.code).localeCompare(String(b.code));
    });
    return ok(res, {
      categories: order,
      options: rows.map((o) => ({ id: o.id, code: o.code, name: o.name, description: o.description, category: o.category || '', status: o.status, created_at: o.created_at }))
    });
  });

  router.add('GET', '/api/groups', async ({ req, res, query }) => {
    requireAuth(req);
    const args = [];
    let sql = `SELECT g.*, o.code AS option_code, o.name AS option_name FROM groups g JOIN options o ON o.id = g.option_id`;
    if (query.option_id) { sql += ' WHERE g.option_id = ?'; args.push(+query.option_id); }
    if (query.q) { sql += (args.length ? ' AND' : ' WHERE') + ' (g.code LIKE ? OR g.name LIKE ?)'; args.push(`%${query.q}%`, `%${query.q}%`); }
    sql += ' ORDER BY o.code, g.code';
    return ok(res, { groups: db.get().prepare(sql).all(...args) });
  });

  router.add('GET', '/api/modules', async ({ req, res, query }) => {
    requireAuth(req);
    const args = [];
    let sql = `SELECT m.*, o.code AS option_code, g.code AS group_code, t.nom AS teacher_nom, t.prenom AS teacher_prenom
      FROM modules m JOIN options o ON o.id = m.option_id
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN teachers t ON t.id = m.teacher_id`;
    const cond = [];
    if (query.option_id) { cond.push('m.option_id = ?'); args.push(+query.option_id); }
    if (query.teacher_id) { cond.push('m.teacher_id = ?'); args.push(+query.teacher_id); }
    if (query.q) { cond.push('(m.code LIKE ? OR m.name LIKE ?)'); args.push(`%${query.q}%`, `%${query.q}%`); }
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY o.code, m.code';
    const rows = db.get().prepare(sql).all(...args).map((m) => ({
      ...m, teacher_name: m.teacher_id ? `${m.teacher_prenom || ''} ${m.teacher_nom || ''}`.trim() : ''
    }));
    return ok(res, { modules: rows });
  });

  router.add('GET', '/api/teachers', async ({ req, res, query }) => {
    requireAuth(req);
    const args = [];
    let sql = 'SELECT * FROM teachers';
    if (query.q) { sql += ' WHERE nom LIKE ? OR prenom LIKE ? OR email LIKE ?'; args.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
    if (query.status) { sql += (query.q ? ' AND' : ' WHERE') + ' status = ?'; args.push(query.status); }
    sql += ' ORDER BY nom, prenom';
    const rows = db.get().prepare(sql).all(...args).map((t) => ({ ...t, full_name: `${t.prenom} ${t.nom}`.trim() }));
    return ok(res, { teachers: rows });
  });

  /* ---------------- DEMANDE D'OPTION PAR UN COORDINATEUR ---------------- */
  router.add('POST', '/api/options/requests', async ({ req, res }) => {
    const user = requireRole(req, 'coordinateur');
    const b = await readJson(req);
    const optionId = int(b.option_id);
    if (!optionId) throw new ApiError(400, 'OPTION_REQUIRED', 'Option à demander requise.');
    const d = db.get();
    const total = d.prepare("SELECT COUNT(*) AS c FROM coordinator_options WHERE user_id = ? AND status IN ('REQUESTED','APPROVED')").get(user.id).c;
    if (total >= 3) {
      throw new ApiError(400, 'TOO_MANY_OPTIONS', 'Maximum 3 options (demandées ou approuvées). Contactez l’administration pour en modifier.', { total });
    }
    const opt = d.prepare("SELECT * FROM options WHERE id = ? AND status = 'ACTIVE'").get(optionId);
    if (!opt) throw new ApiError(404, 'OPTION_NOT_FOUND', 'Option introuvable ou inactive.');
    try {
      const r = d.prepare("INSERT INTO coordinator_options (user_id, option_id, status) VALUES (?,?, 'REQUESTED')").run(user.id, optionId);
      db.audit(user, 'DEMANDE_OPTION', 'coordinator_option', Number(r.lastInsertRowid), null, { option: opt.code });
      const admins = d.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();
      admins.forEach((a) => notify(a.id, 'option_request', 'Nouvelle demande d’option',
        `${user.prenom} ${user.nom} demande l’option ${opt.code}.`, '#/admin/requests'));
      realtime.publish('option.request', { user_id: user.id, option: opt.code, status: 'REQUESTED' });
      return ok(res, { ok: true, message: `Demande envoyée pour l’option ${opt.code}. En attente de l’administration.` });
    } catch (e) {
      const mapped = require('../auth').mapDbError(e);
      throw mapped || e;
    }
  });

  router.add('DELETE', '/api/options/requests/:id', async ({ req, res, params }) => {
    const user = requireRole(req, 'coordinateur');
    const row = db.get().prepare('SELECT * FROM coordinator_options WHERE id = ?').get(+params.id);
    if (!row) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Demande introuvable.');
    if (row.user_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette demande ne vous appartient pas.');
    if (row.status !== 'REQUESTED') throw new ApiError(400, 'NOT_PENDING', 'Seule une demande en attente peut être annulée.');
    db.get().prepare('DELETE FROM coordinator_options WHERE id = ?').run(row.id);
    db.audit(user, 'ANNULATION_DEMANDE_OPTION', 'coordinator_option', row.id, row, null);
    return ok(res, { ok: true });
  });

  /* ---------------- OCCUPATION ---------------- */
  router.add('GET', '/api/occupancy', async ({ req, res, query }) => {
    requireAuth(req);
    const day = query.day ? str(query.day, 10) : todayStr();
    const minute = query.minute !== undefined ? parseHHMM(query.minute) : nowMin();
    return ok(res, { ...S.occupancyAt(day, minute === null ? nowMin() : minute), day });
  });

  /* ---------------- PLANNING ---------------- */
  router.add('GET', '/api/planning', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const from = query.from ? str(query.from, 10) : (query.week ? mondayOf(str(query.week, 10)) : mondayOf(todayStr()));
    const to = query.to ? str(query.to, 10) : addDays(from, 5); // lundi → samedi
    const filters = {
      from, to,
      option_id: query.option_id, group_id: query.group_id, module_id: query.module_id,
      teacher_id: query.teacher_id, room_id: query.room_id, floor: query.floor, status: query.status,
      semester: query.semester
    };
    if (user.role === 'enseignant') {
      filters.teacher_id = user.teacher_id || -1;
    }
    const reservations = S.listReservations(filters);
    if (user.role === 'enseignant' && user.teacher_id) {
      const extra = S.listReservations({ ...filters, teacher_id: null, created_by: user.id });
      extra.forEach((e) => { if (!reservations.some((r) => r.id === e.id)) reservations.push(e); });
    }
    const days = [];
    for (let i = 0; i < 6; i++) {
      const d = addDays(from, i);
      days.push({ date: d, key: dayKeyOf(d), name: DAY_NAMES[dayKeyOf(d)] });
    }
    const rooms = db.get().prepare(`SELECT * FROM rooms ORDER BY CASE floor WHEN 'RDC' THEN 1 WHEN '1ER' THEN 2 ELSE 3 END, code`).all().map(roomShape);
    const settings = db.getSettings();
    // Responsables affichés sur la feuille d'emploi imprimée (colonne de gauche +
    // signatures) : l'administration et les coordinateurs actifs, avec l'option
    // dont chacun est coordinateur.
    // Genre inclus : il détermine le titre affiché (Coordinateur / Coordinatrice)
    // sur la feuille imprimée et dans les blocs de signature.
    const officials = db.get().prepare(`SELECT id, role, prenom, nom, gender FROM users
      WHERE status = 'active' AND role IN ('admin','coordinateur') ORDER BY role DESC, nom`).all();
    const coordinator_options = db.get().prepare(
      `SELECT co.option_id, co.user_id, o.code AS option_code FROM coordinator_options co
       JOIN options o ON o.id = co.option_id WHERE co.status = 'APPROVED' ORDER BY o.code`).all();
    return ok(res, { from, to, days, rooms, reservations, settings, officials, coordinator_options, role: user.role });
  });

  /* ---------------- TABLEAU DE BORD ---------------- */
  router.add('GET', '/api/dashboard', async ({ req, res }) => {
    const user = requireAuth(req);
    const d = db.get();
    const s = (sql) => d.prepare(sql);
    const day = todayStr();
    const weekFrom = mondayOf(day);
    const weekTo = addDays(weekFrom, 5);
    const now = nowMin();

    const base = {
      day, now: fmtMin(now),
      rooms_total: s('SELECT COUNT(*) AS c FROM rooms').get().c,
      options: s("SELECT COUNT(*) AS c FROM options WHERE status='ACTIVE'").get().c,
      groups: s('SELECT COUNT(*) AS c FROM groups').get().c,
      modules: s('SELECT COUNT(*) AS c FROM modules').get().c,
      teachers: s("SELECT COUNT(*) AS c FROM teachers WHERE status='ACTIVE'").get().c
    };
    const occ = S.occupancyAt(day, now);
    base.rooms_free = occ.free.length;
    base.rooms_occupied = occ.taken.length;
    base.next_reservations = S.nextReservations(6);
    base.occupancy = occ;

    if (user.role === 'admin') {
      base.reservations_today = s("SELECT COUNT(*) AS c FROM reservations WHERE day = ? AND status='CONFIRMED'").get(day).c;
      base.reservations_week = s("SELECT COUNT(*) AS c FROM reservations WHERE day BETWEEN ? AND ? AND status='CONFIRMED'").get(weekFrom, weekTo).c;
      base.pending_accounts = s("SELECT COUNT(*) AS c FROM users WHERE status='pending'").get().c;
      base.pending_verified = s('SELECT COUNT(*) AS c FROM users WHERE status=\'pending\' AND email_verified = 1').get().c;
      base.pending_options = s("SELECT COUNT(*) AS c FROM coordinator_options WHERE status='REQUESTED'").get().c;
      base.users_total = s('SELECT COUNT(*) AS c FROM users').get().c;
      base.users_coord = s("SELECT COUNT(*) AS c FROM users WHERE role='coordinateur' AND status='active'").get().c;
      base.users_teachers = s("SELECT COUNT(*) AS c FROM users WHERE role='enseignant' AND status='active'").get().c;
      return ok(res, { role: 'admin', stats: base });
    }

    if (user.role === 'coordinateur') {
      const opt = user.active_option;
      base.active_option = opt;
      base.approved_options = user.approved_options;
      base.requested_options = user.options.filter((o) => o.status === 'REQUESTED');
      if (opt) {
        base.groups_of_option = s('SELECT COUNT(*) AS c FROM groups WHERE option_id = ?').get(opt.id).c;
        base.modules_of_option = s('SELECT COUNT(*) AS c FROM modules WHERE option_id = ?').get(opt.id).c;
        base.reservations_of_option = s("SELECT COUNT(*) AS c FROM reservations WHERE option_id = ? AND status='CONFIRMED' AND day BETWEEN ? AND ?").get(opt.id, weekFrom, weekTo).c;
        base.reservations_today = s("SELECT COUNT(*) AS c FROM reservations WHERE option_id = ? AND day = ? AND status='CONFIRMED'").get(opt.id, day).c;
        base.next_activities = S.listReservations({ from: day, to: addDays(day, 7), option_id: opt.id, limit: 8 });
        base.reservation_share = {
          mine: s("SELECT COUNT(*) AS c FROM reservations WHERE option_id = ? AND day BETWEEN ? AND ? AND status='CONFIRMED'").get(opt.id, weekFrom, weekTo).c,
          total: s("SELECT COUNT(*) AS c FROM reservations WHERE day BETWEEN ? AND ? AND status='CONFIRMED'").get(weekFrom, weekTo).c
        };
      } else {
        base.next_activities = [];
        base.groups_of_option = 0;
        base.modules_of_option = 0;
        base.reservations_of_option = 0;
        base.reservations_today = 0;
      }
      base.pending_option_requests = user.options.filter((o) => o.status === 'REQUESTED').length;
      return ok(res, { role: 'coordinateur', stats: base });
    }

    // ENSEIGNANT
    const tid = user.teacher_id;
    base.reservations_today = tid
      ? s("SELECT COUNT(*) AS c FROM reservations WHERE teacher_id = ? AND day = ? AND status='CONFIRMED'").get(tid, day).c
      : s("SELECT COUNT(*) AS c FROM reservations WHERE created_by = ? AND day = ? AND status='CONFIRMED'").get(user.id, day).c;
    base.week_reservations = tid
      ? s("SELECT COUNT(*) AS c FROM reservations WHERE teacher_id = ? AND day BETWEEN ? AND ? AND status='CONFIRMED'").get(tid, weekFrom, weekTo).c
      : 0;
    base.my_modules = tid ? s('SELECT COUNT(*) AS c FROM modules WHERE teacher_id = ?').get(tid).c : 0;
    base.next_activities = S.listReservations({ from: day, to: addDays(day, 7), teacher_id: tid || -1, limit: 8 });
    base.rooms_free = occ.free.length;
    return ok(res, { role: 'enseignant', stats: base });
  });
};

module.exports.roomShape = roomShape;
