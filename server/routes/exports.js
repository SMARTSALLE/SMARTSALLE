'use strict';
const { ok } = require('../router');
const { ApiError, str, toCsv, toXls, sendFile, todayStr, addDays, mondayOf, fmtMin } = require('../util');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { semesterVariants } = require('../services');

function stamp() { return todayStr(); }

function reservationsRows(from, to, extra) {
  const x = extra || {};
  /* Filtres optionnels (export « planning » de la vue Impression) : même
     normalisation de semestre et même test de statut que /api/planning
     (services.listReservations) pour que le fichier exporté corresponde
     exactement à la feuille affichée. */
  const where = ["r.status = 'CONFIRMED'", 'r.day BETWEEN ? AND ?'];
  const args = [from, to];
  if (x.option_id) { where.push('r.option_id = ?'); args.push(+x.option_id); }
  if (x.group_id) { where.push('r.group_id = ?'); args.push(+x.group_id); }
  if (x.semester) {
    const variants = semesterVariants(x.semester);
    if (!variants.length) where.push('1 = 0');
    else {
      /* Même règle que /api/planning : le semestre CIBLE posé sur la réservation
         fait foi, sinon on retombe sur le module / le groupe (données antérieures
         à la migration). */
      where.push('TRIM(REPLACE(UPPER(COALESCE(NULLIF(r.semester, \'\'), m.semester, g.semester, \'\')), \'SEMESTRE\', \'\')) IN (' + variants.map(() => '?').join(', ') + ')');
      args.push(...variants);
    }
  }
  const rows = db.get().prepare(`
    SELECT rm.code AS Salle, r.day AS Jour, strftime('%w', r.day) AS Dow,
           printf('%02d:%02d', r.start_min/60, r.start_min%60) AS Debut,
           printf('%02d:%02d', r.end_min/60, r.end_min%60) AS Fin,
           COALESCE(NULLIF(r.semester, ''), m.semester, g.semester, '') AS Semestre,
           o.code AS Option, g.code AS Groupe, COALESCE(NULLIF(r.module_name_override,''), m.name, r.title) AS Module,
           COALESCE(NULLIF(r.teacher_name_override,''), t.prenom || ' ' || t.nom, '') AS Enseignant,
           r.students_count AS Etudiants, r.equipment AS Equipement, r.title AS Titre, r.notes AS Notes
    FROM reservations r
    JOIN rooms rm ON rm.id = r.room_id
    JOIN options o ON o.id = r.option_id
    LEFT JOIN groups g ON g.id = r.group_id
    LEFT JOIN modules m ON m.id = r.module_id
    LEFT JOIN teachers t ON t.id = r.teacher_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.day, r.start_min, rm.code`).all(...args);
  const header = ['Salle', 'Jour', 'Date', 'Début', 'Fin', 'Semestre', 'Option', 'Groupe', 'Module', 'Enseignant', 'Etudiants', 'Equipement', 'Titre', 'Notes'];
  const body = rows.map((r) => [r.Salle, r.Jour, r.Dow, r.Debut, r.Fin, r.Semestre || '', r.Option, r.Groupe || '', r.Module || '', r.Enseignant || '', r.Etudiants, r.Equipement || '', r.Titre || '', r.Notes || '']);
  return [header, ...body];
}

function roomsRows() {
  const rows = db.get().prepare('SELECT code, name, floor, location, status, reserved_for, is_available_for_normal_booking, equipment FROM rooms ORDER BY floor, code').all();
  return [['Code', 'Nom', 'Etage', 'Localisation', 'Statut', 'Reservee pour', 'Reservable normalement', 'Equipements'],
    ...rows.map((r) => [r.code, r.name, r.floor, r.location, r.status, r.reserved_for, r.is_available_for_normal_booking ? 'OUI' : 'NON (MASTER MANAGEMENT)', r.equipment])];
}

function genericRows(table, sql, args) {
  const rows = db.get().prepare(sql).all(...(args || []));
  if (!rows.length) return [['Information'], ['Aucune donnée']];
  const header = Object.keys(rows[0]);
  return [header, ...rows.map((r) => header.map((h) => (r[h] === null || r[h] === undefined ? '' : r[h])))];
}

/* Options autorisées pour un coordinateur (null = toutes, pour l'admin). */
function allowedOptionIds(user) {
  if (!user || user.role === 'admin') return null;
  return db.get().prepare("SELECT option_id FROM coordinator_options WHERE user_id = ? AND status = 'APPROVED'")
    .all(user.id).map((r) => r.option_id);
}

function optionScope(alias, ids) {
  if (!ids) return { cond: [], args: [] };
  if (!ids.length) return { cond: ['1 = 0'], args: [] };
  return { cond: [`${alias}.option_id IN (${ids.map(() => '?').join(', ')})`], args: [...ids] };
}

const EXPORTS = {
  reservations: (q) => reservationsRows(q.from || todayStr(), q.to || addDays(q.from || todayStr(), 30)),
  planning: (q) => reservationsRows(q.from || mondayOf(todayStr()), q.to || addDays(mondayOf(todayStr()), 5), {
    option_id: q.option_id, group_id: q.group_id, semester: q.semester
  }),
  rooms: () => roomsRows(),
  groups: () => genericRows('groups', `SELECT g.code, g.name, o.code AS option, g.semester, g.academic_year, g.students_count AS etudiants, g.status FROM groups g JOIN options o ON o.id=g.option_id ORDER BY o.code, g.code`),
  /* Modules enrichis : filière, répartition horaire, enseignant principal et
     statut de validation — filtrables par option / semestre / année. */
  modules: (q, user) => {
    const scope = optionScope('m', allowedOptionIds(user));
    const cond = [...scope.cond];
    const args = [...scope.args];
    if (q.option_id) { cond.push('m.option_id = ?'); args.push(+q.option_id); }
    if (q.semester) { cond.push('m.semester = ?'); args.push(q.semester); }
    if (q.academic_year) { cond.push('m.academic_year = ?'); args.push(q.academic_year); }
    const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
    return genericRows('modules', `
      SELECT m.code, m.name AS intitule, o.category AS filiere, o.code AS option, m.semester AS semestre,
        m.academic_year AS annee, m.hours AS heures_total, m.hours_theory AS heures_cours,
        m.hours_td AS heures_td, m.hours_tp AS heures_tp,
        COALESCE(t.prenom || ' ' || t.nom, '') AS enseignant_principal,
        m.validation_status AS validation, m.status
      FROM modules m JOIN options o ON o.id = m.option_id
      LEFT JOIN teachers t ON t.id = m.teacher_id${where}
      ORDER BY o.code, m.semester, m.code`, args);
  },
  /* Affectations enseignants → modules (un module plusieurs enseignants). */
  module_teachers: (q, user) => {
    const scope = optionScope('m', allowedOptionIds(user));
    const cond = [...scope.cond, "mt.status = 'ACTIVE'"];
    const args = [...scope.args];
    if (q.option_id) { cond.push('m.option_id = ?'); args.push(+q.option_id); }
    if (q.semester) { cond.push('mt.semester = ?'); args.push(q.semester); }
    if (q.academic_year) { cond.push('mt.academic_year = ?'); args.push(q.academic_year); }
    return genericRows('module_teachers', `
      SELECT t.nom, t.prenom, t.email, t.grade, t.specialty, m.code AS module_code, m.name AS module,
        o.code AS option, mt.semester AS semestre, mt.academic_year AS annee,
        mt.teaching_type AS type_enseignement, mt.hours AS heures, mt.notes
      FROM module_teachers mt
      JOIN modules m ON m.id = mt.module_id
      JOIN options o ON o.id = m.option_id
      JOIN teachers t ON t.id = mt.teacher_id
      WHERE ${cond.join(' AND ')}
      ORDER BY o.code, mt.semester, m.code, t.nom`, args);
  },
  teachers: () => genericRows('teachers', "SELECT nom, prenom, email, specialty AS specialite, grade, phone AS telephone, establishment AS etablissement, contract AS statut, status FROM teachers ORDER BY nom"),
  options: () => genericRows('options', "SELECT code, name, category AS filiere, description, status FROM options ORDER BY CASE category WHEN 'Soins Infirmiers' THEN 1 WHEN 'Techniques de Santé' THEN 2 WHEN 'Rééducation et Réhabilitation' THEN 3 WHEN 'Autres Filières' THEN 4 ELSE 5 END, code"),
  /* Titre calculé en base pour rester cohérent avec l'affichage :
     Coordinatrice si le compte est marqué 'F', sinon Coordinateur. */
  users: () => genericRows('users', `SELECT nom, prenom, email, role,
      CASE WHEN UPPER(COALESCE(gender,'')) = 'F' THEN 'Coordinatrice' ELSE 'Coordinateur' END AS titre,
      status, email_verified, created_at FROM users ORDER BY id`),
  audit: () => genericRows('audit_log', 'SELECT created_at AS date, user_label AS utilisateur, action, entity_type AS type, entity_id AS id, old_value AS avant, new_value AS apres FROM audit_log ORDER BY id DESC LIMIT 2000')
};

module.exports = function exportRoutes(router) {

  router.add('GET', '/api/export/:file', async ({ req, res, params, query }) => {
    const user = requireAuth(req);
    const [name, extRaw] = String(params.file).split('.');
    const ext = (extRaw || 'csv').toLowerCase();
    if (!EXPORTS[name]) throw new ApiError(404, 'EXPORT_NOT_FOUND', `Export inconnu : ${name}`);
    if (['users', 'audit'].includes(name)) requireRole(req, 'admin');
    if (name === 'audit') requireRole(req, 'admin');
    // Les exports pédagogiques respectent les options approuvées du coordinateur.
    const rows = EXPORTS[name](query, user);
    if (ext === 'xls') {
      return sendFile(res, `${name}-${stamp()}.xls`, 'application/vnd.ms-excel; charset=utf-8', toXls(name, rows));
    }
    if (ext !== 'csv') throw new ApiError(400, 'INVALID_FORMAT', 'Format attendu : .csv ou .xls');
    return sendFile(res, `${name}-${stamp()}.csv`, 'text/csv; charset=utf-8', toCsv(rows));
  });

  /* ---------- QR CODE ---------- */
  router.add('GET', '/api/rooms/:code/qr', async ({ req, res, params, query }) => {
    const user = requireAuth(req);
    const room = db.get().prepare('SELECT * FROM rooms WHERE code = ? OR id = ?').get(params.code, parseInt(params.code, 10) || -1);
    if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const origin = query.origin || `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host || 'localhost:3000'}`;
    const url = `${origin}/#/r/${room.qr_token}`;
    if (query.format === 'url') return ok(res, { url, token: room.qr_token });
    const QRCode = require('qrcode');
    if (query.format === 'png') {
      const buf = await QRCode.toBuffer(url, { type: 'png', width: +query.size || 400, margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(buf);
    }
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0f2f4f', light: '#ffffff' } });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(svg);
  });

  /* ---------- PAGE PUBLIQUE SALLE (lecture seule) ---------- */
  router.add('GET', '/api/public/room/:token', async ({ res, params }) => {
    const room = db.get().prepare('SELECT * FROM rooms WHERE qr_token = ?').get(params.token);
    if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const day = todayStr();
    const settings = db.getSettings();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const dayRows = db.get().prepare(`
      SELECT r.start_min, r.end_min, r.title, o.code AS option_code, g.code AS group_code,
             COALESCE(NULLIF(r.module_name_override,''), m.name, '') AS module_name,
             COALESCE(NULLIF(r.teacher_name_override,''), t.prenom || ' ' || t.nom, '') AS teacher_name
      FROM reservations r JOIN options o ON o.id = r.option_id
      LEFT JOIN groups g ON g.id = r.group_id
      LEFT JOIN modules m ON m.id = r.module_id
      LEFT JOIN teachers t ON t.id = r.teacher_id
      WHERE r.room_id = ? AND r.day = ? AND r.status = 'CONFIRMED' ORDER BY r.start_min`).all(room.id, day);
    const current = dayRows.find((r) => r.start_min <= nowMin && r.end_min > nowMin) || null;
    const next = dayRows.find((r) => r.start_min > nowMin) || null;
    const week = db.get().prepare(`
      SELECT r.day, r.start_min, r.end_min, o.code AS option_code, g.code AS group_code, r.title
      FROM reservations r JOIN options o ON o.id = r.option_id
      LEFT JOIN groups g ON g.id = r.group_id
      WHERE r.room_id = ? AND r.day BETWEEN ? AND ? AND r.status = 'CONFIRMED' ORDER BY r.day, r.start_min`)
      .all(room.id, mondayOf(day), addDays(mondayOf(day), 5));
    return ok(res, {
      public: true,
      room: {
        code: room.code, name: room.name, floor: room.floor, location: room.location,
        status: room.status, reserved_for: room.reserved_for, bookable: !!room.is_available_for_normal_booking,
        equipment: room.equipment
      },
      institution: settings.institution_name,
      app_name: settings.app_name,
      now: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      occupied: !!current,
      current: current ? { start: fmtMin(current.start_min), end: fmtMin(current.end_min), option: current.option_code, group: current.group_code, module: current.module_name, teacher: current.teacher_name, title: current.title } : null,
      next: next ? { start: fmtMin(next.start_min), end: fmtMin(next.end_min), option: next.option_code, group: next.group_code, module: next.module_name, title: next.title } : null,
      today: dayRows.map((r) => ({ start: fmtMin(r.start_min), end: fmtMin(r.end_min), option: r.option_code, group: r.group_code, module: r.module_name, teacher: r.teacher_name })),
      week: week.map((r) => ({ day: r.day, start: fmtMin(r.start_min), end: fmtMin(r.end_min), option: r.option_code, group: r.group_code, title: r.title })),
      read_only: true
    });
  });
};
