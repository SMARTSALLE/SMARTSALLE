'use strict';
const { ok, created } = require('../router');
const { ApiError, readJson, str, int, requireFields, parseHHMM, fmtMin, todayStr, addDays, dayKeyOf, DAY_KEYS, parseDay, mondayOf, nowMin, bool } = require('../util');
const db = require('../db');
const { requireAuth, requireRole, requireCoordinator, ERR } = require('../auth');
const S = require('../services');
const realtime = require('../realtime');
const { notify } = require('./auth');

function broadcastReservations(type, payload) {
  realtime.publish(type, payload);
}

module.exports = function reservationRoutes(router) {

  /* ---------------- LISTE ---------------- */
  router.add('GET', '/api/reservations', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const spanFrom = query.from || query.day || null;
    const spanTo = query.to || query.day || spanFrom;
    const filter = {
      from: spanFrom,
      to: spanTo,
      day: null, room_id: query.room_id, room_code: query.room_code,
      option_id: query.option_id, group_id: query.group_id, module_id: query.module_id,
      teacher_id: query.teacher_id, floor: query.floor, status: query.status,
      // Chaque emploi du temps est autonome par semestre : ce filtre est ce
      // qui garantit qu'un cours de S3 n'apparaît jamais dans S1, S2, S4, S5, S6.
      semester: query.semester || null,
      created_by: query.mine === '1' ? user.id : null,
      limit: query.limit
    };
    if (query.from && !query.to) filter.to = null;
    if (user.role === 'enseignant') {
      // Un enseignant ne voit que ce qui le concerne.
      filter.teacher_id = user.teacher_id || -1;
    }
    const rows = S.listReservations(filter);
    const mine = user.role === 'enseignant' && user.teacher_id
      ? S.listReservations({ ...filter, teacher_id: null, created_by: user.id, limit: 500 }) : [];
    const merged = user.role === 'enseignant'
      ? [...rows, ...mine.filter((m) => !rows.some((r) => r.id === m.id))]
      : rows;
    return ok(res, { reservations: merged, count: merged.length });
  });

  router.add('GET', '/api/reservations/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const r = S.getReservation(params.id);
    if (!r) throw new ApiError(404, 'NOT_FOUND', 'Réservation introuvable.');
    if (user.role === 'enseignant' && !(r.teacher_id === user.teacher_id && user.teacher_id) && r.created_by !== user.id) {
      throw new ApiError(403, 'FORBIDDEN', 'Accès refusé.');
    }
    return ok(res, { reservation: r });
  });

  /* ---------------- CRÉATION ---------------- */
  router.add('POST', '/api/reservations', async ({ req, res }) => {
    const user = requireCoordinator(req);
    const b = await readJson(req);
    requireFields(b, ['option_id', 'date', 'start', 'end', 'room_id']);
    const day = str(b.date, 10);
    const startMin = parseHHMM(b.start);
    const endMin = parseHHMM(b.end);
    const optionId = int(b.option_id);
    const groupId = int(b.group_id);
    const teacherId = int(b.teacher_id);
    const moduleId = int(b.module_id);
    /* Semestre cible obligatoire : s’il n’est pas fourni on le reprend du module
       ou du groupe choisi (il le porte déjà), ce qui évite un refus à tort tout
       en interdisant réellement un cours sans semestre : sans module ni groupe,
       aucun semestre ne peut être déduit et la création est refusée. */
    let semester;
    if (b.semester !== undefined && b.semester !== null && String(b.semester).trim() !== '') {
      semester = S.normalizeSemester(b.semester);
    } else {
      const source = moduleId ? { table: 'modules', id: moduleId }
        : (groupId ? { table: 'groupes', id: groupId } : null);
      if (!source) {
        throw new ApiError(400, 'SEMESTER_REQUIRED',
          'Le semestre cible est obligatoire : choisissez un semestre (S1 à S6), ou un module / un groupe qui le porte.');
      }
      const table = source.table === 'modules' ? 'modules' : 'groups';
      const row = db.get().prepare(`SELECT semester FROM ${table} WHERE id = ?`).get(source.id);
      semester = S.normalizeSemester(row && row.semester);
    }

    S.assertCanCreate(user, optionId);
    S.assertTimeSlot(day, startMin, endMin);
    const room = S.assertRoomBookable(user, b.room_id);

    // Contrôle centralisé de TOUS les conflits (salle, enseignant, groupe,
    // option), à l'échelle de l'établissement et tous semestres confondus.
    S.assertNoConflicts({ room, option_id: optionId, group_id: groupId,
      teacher_id: teacherId, day, start: startMin, end: endMin });

    const d = db.get();
    let id;
    try {
      const r = d.prepare(`INSERT INTO reservations
        (room_id, option_id, group_id, module_id, teacher_id, teacher_name_override, module_name_override,
         title, day, start_min, end_min, students_count, equipment, notes, semester, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(room.id, optionId, groupId, moduleId, teacherId,
          str(b.teacher_name_override, 120), str(b.module_name_override, 120),
          str(b.title, 160), day, startMin, endMin, int(b.students_count, 0) || 0,
          str(b.equipment, 200), str(b.notes, 1000), semester, user.id);
      id = Number(r.lastInsertRowid);
    } catch (e) {
      // Verrou atomique perdu face à une requête simultanée : la base a
      // tranché, on l'explique plutôt que de renvoyer une erreur brute.
      if (e && /UNIQUE constraint failed/.test(String(e.message || ''))) {
        throw new ApiError(409, 'SCHEDULE_CONFLICT',
          'Conflit détecté : ce créneau vient d’être réservé par un autre utilisateur. Choisissez une autre salle ou un autre horaire.',
          { kind: 'concurrent' });
      }
      const mapped = require('../auth').mapDbError(e);
      throw mapped || e;
    }

    const row = S.getReservation(id);
    db.audit(user, 'CREATION_RESERVATION', 'reservation', id, null, row);
    if (db.getSettings().notify_reservations === '1') {
      notify(row.created_by, 'reservation', 'Réservation créée',
        `${row.room_code} — ${row.day} ${row.start}–${row.end} (${row.option_code})`, '#/reservations');
    }
    broadcastReservations('reservation.created', { reservation: row });
    return created(res, { ok: true, reservation: row });
  });

  /* ---------------- MODIFICATION / REPROGRAMMATION ---------------- */
  async function updateReservation({ req, res, params }) {
    const user = requireCoordinator(req);
    const b = await readJson(req);
    const current = S.getReservation(params.id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Réservation introuvable.');
    S.assertCanManage(user, current);

    const day = b.date ? str(b.date, 10) : current.day;
    const startMin = b.start !== undefined ? parseHHMM(b.start) : current.start_min;
    const endMin = b.end !== undefined ? parseHHMM(b.end) : current.end_min;
    const roomId = b.room_id !== undefined ? int(b.room_id) : current.room_id;
    const optionId = b.option_id !== undefined ? int(b.option_id) : current.option_id;
    // La modification dure de la salle, du jour ou de l'horaire relance TOUS
    // les contrôles de conflits avant validation (cahier des charges 5E).
    const semester = b.semester !== undefined ? S.normalizeSemester(b.semester) : current.semester;
    const groupId = b.group_id !== undefined ? int(b.group_id) : current.group_id;
    const teacherId = b.teacher_id !== undefined ? int(b.teacher_id) : current.teacher_id;

    S.assertCanCreate(user, optionId);
    S.assertTimeSlot(day, startMin, endMin);
    const room = S.assertRoomBookable(user, roomId);

    S.assertNoConflicts({ room, option_id: optionId, group_id: groupId,
      teacher_id: teacherId, day, start: startMin, end: endMin, exclude_id: current.id });

    const d = db.get();
    const next = {
      room_id: roomId, option_id: optionId, semester,
      group_id: groupId,
      module_id: b.module_id !== undefined ? int(b.module_id) : current.module_id,
      teacher_id: teacherId,
      teacher_name_override: b.teacher_name_override !== undefined ? str(b.teacher_name_override, 120) : current.teacher_name_override,
      module_name_override: b.module_name_override !== undefined ? str(b.module_name_override, 120) : current.module_name_override,
      title: b.title !== undefined ? str(b.title, 160) : current.title,
      day, start_min: startMin, end_min: endMin,
      students_count: b.students_count !== undefined ? (int(b.students_count, 0) || 0) : current.students_count,
      equipment: b.equipment !== undefined ? str(b.equipment, 200) : current.equipment,
      notes: b.notes !== undefined ? str(b.notes, 1000) : current.notes,
      updated_at: "datetime('now')"
    };
    try {
      d.prepare(`UPDATE reservations SET room_id=?, option_id=?, group_id=?, module_id=?, teacher_id=?,
        teacher_name_override=?, module_name_override=?, title=?, day=?, start_min=?, end_min=?,
        students_count=?, equipment=?, notes=?, semester=?, updated_at=datetime('now') WHERE id=?`)
        .run(next.room_id, next.option_id, next.group_id, next.module_id, next.teacher_id,
          next.teacher_name_override, next.module_name_override, next.title, next.day,
          next.start_min, next.end_min, next.students_count, next.equipment, next.notes,
          next.semester, current.id);
    } catch (e) {
      if (e && /UNIQUE constraint failed/.test(String(e.message || ''))) {
        throw new ApiError(409, 'SCHEDULE_CONFLICT',
          'Conflit détecté : ce créneau vient d’être réservé par un autre utilisateur. Choisissez une autre salle ou un autre horaire.',
          { kind: 'concurrent' });
      }
      const mapped = require('../auth').mapDbError(e);
      throw mapped || e;
    }

    const row = S.getReservation(current.id);
    db.audit(user, 'MODIFICATION_RESERVATION', 'reservation', current.id,
      { day: current.day, start: current.start, end: current.end, room: current.room_code },
      { day: row.day, start: row.start, end: row.end, room: row.room_code });
    broadcastReservations('reservation.updated', { reservation: row });
    return ok(res, { ok: true, reservation: row });
  }

  router.add('PUT', '/api/reservations/:id', updateReservation);

  router.add('POST', '/api/reservations/:id/reschedule', updateReservation);

  /* ---------------- ANNULATION ---------------- */
  router.add('DELETE', '/api/reservations/:id', async ({ req, res, params }) => {
    const user = requireCoordinator(req);
    const current = S.getReservation(params.id);
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Réservation introuvable.');
    S.assertCanManage(user, current);
    const query = (req.url.split('?')[1] || '');
    const hard = new URLSearchParams(query).get('hard') === '1' && user.role === 'admin';
    const d = db.get();
    if (hard) {
      d.prepare('DELETE FROM reservations WHERE id = ?').run(current.id);
    } else {
      // Annulation : les verrous de créneau sont libérés par le trigger de la base.
      d.prepare("UPDATE reservations SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?").run(current.id);
    }
    db.audit(user, 'ANNULATION_RESERVATION', 'reservation', current.id, current, { status: 'CANCELLED', hard });
    if (db.getSettings().notify_reservations === '1') {
      notify(current.created_by, 'reservation_cancelled', 'Réservation annulée',
        `${current.room_code} — ${current.day} ${current.start}–${current.end}`, '#/reservations');
    }
    broadcastReservations('reservation.deleted', { id: current.id, reservation: current });
    return ok(res, { ok: true, message: 'Réservation annulée.' });
  });

  /* ---------------- COPIE JOURNÉE / SEMAINE ---------------- */
  router.add('POST', '/api/reservations/copy', async ({ req, res }) => {
    const user = requireCoordinator(req);
    const b = await readJson(req);
    requireFields(b, ['from_day', 'mode']);
    const fromDay = str(b.from_day, 10);
    if (!parseDay(fromDay)) throw new ApiError(400, 'INVALID_DATE', 'Jour source invalide.');
    const mode = str(b.mode, 10);
    let pairs = [];
    if (mode === 'day') {
      const to = b.to_day ? str(b.to_day, 10) : addDays(fromDay, 1);
      pairs = [{ from: fromDay, to }];
    } else if (mode === 'week') {
      const srcMonday = mondayOf(fromDay);
      const dstMonday = b.to_week ? mondayOf(str(b.to_week, 10)) : addDays(srcMonday, 7);
      for (let i = 0; i < 6; i++) pairs.push({ from: addDays(srcMonday, i), to: addDays(dstMonday, i) });
    } else {
      throw new ApiError(400, 'INVALID_MODE', 'Mode invalide (day|week).');
    }
    let created = 0;
    const skipped = [];
    const targets = [];
    for (const p of pairs) {
      const r = S.copyReservations(user, { from_day: p.from, to_days: [p.to], option_filter: b.option_id });
      created += r.created;
      skipped.push(...r.skipped);
      targets.push(p.to);
    }
    db.audit(user, 'COPIE_PLANNING', 'reservation', null, { from: fromDay, mode }, { created, skipped: skipped.length });
    if (created) broadcastReservations('reservation.bulk', { created });
    return ok(res, { ok: true, created, skipped, targets: [...new Set(targets)] });
  });

  /* ---------------- TROUVER UNE SALLE ---------------- */
  router.add('GET', '/api/search/room', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const day = str(query.date || query.day, 10);
    const startMin = parseHHMM(query.start);
    const endMin = parseHHMM(query.end);
    if (!parseDay(day)) throw new ApiError(400, 'INVALID_DATE', 'Date invalide.');
    if (startMin === null || endMin === null) throw new ApiError(400, 'INVALID_TIME', 'Heures de début et de fin requises.');
    S.assertTimeSlot(day, startMin, endMin);
    // S12-1ER exclue automatiquement ; aucune utilisation du nombre d'étudiants.
    const rooms = S.findAvailableRooms({
      day, startMin, endMin,
      equipment: query.equipment, floor: query.floor,
      includeRestricted: false, excludeRoomId: null
    });
    return ok(res, {
      date: day, start: fmtMin(startMin), end: fmtMin(endMin),
      count: rooms.length, rooms,
      note: 'S12-1ER (MASTER MANAGEMENT) est automatiquement exclue de la recherche. Le nombre d’étudiants n’est jamais utilisé comme filtre.'
    });
  });

  /* ---------------- SMART SEARCH ---------------- */
  const FR_DAYS = [
    ['lundi', 0], ['mardi', 1], ['mercredi', 2], ['jeudi', 3], ['vendredi', 4], ['samedi', 5], ['dimanche', 6]
  ];

  function parseSmart(q) {
    const out = { day: null, start: null, end: null, duration: null, equipment: [] };
    const lower = ' ' + q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + ' ';
    for (const [name, dow] of FR_DAYS) {
      const idx = lower.indexOf(' ' + name);
      if (idx !== -1) { out.dayDow = dow; out.dayWord = name; break; }
    }
    if (/aujourd/.test(lower)) out.dayDow = (new Date().getDay() + 6) % 7;
    if (/demain/.test(lower)) out.dayDow = ((new Date().getDay() + 6) % 7 + 1) % 7;

    const timeRe = /(\d{1,2})\s*h\s*(\d{2})?|(\d{1,2}):(\d{2})/g;
    const times = [];
    let m;
    while ((m = timeRe.exec(lower)) !== null) {
      const h = +(m[1] !== undefined ? m[1] : m[3]);
      const mi = m[2] !== undefined ? +m[2] : (m[4] !== undefined ? +m[4] : 0);
      if (h < 24 && mi < 60) times.push(h * 60 + mi);
    }
    if (times.length >= 2) { out.start = times[0]; out.end = times[1]; }
    else if (times.length === 1) {
      const dur = /(\d{1,2})\s*h(?!\s*\d)/.exec(lower.replace(/(\d{1,2})\s*h\s*\d{2}/g, ''));
      out.start = times[0];
      if (dur) { out.duration = +dur[1] * 60; out.end = out.start + out.duration; }
    }
    for (const eq of ['videoProjecteur', 'ordinateur', 'tableau', 'climatisation', 'visioconference']) {
      const fr = { videoProjecteur: 'video', ordinateur: 'ordinateur', tableau: 'tableau', climatisation: 'clim', visioconference: 'visio' }[eq];
      if (lower.includes(fr)) out.equipment.push(eq);
    }
    if (out.dayDow !== undefined && out.dayDow !== null) {
      const today = new Date();
      const todayDow = (today.getDay() + 6) % 7;
      let delta = (out.dayDow - todayDow + 7) % 7;
      if (delta === 0 && out.start !== null && out.start < nowMin()) delta = 7;
      out.day = addDays(todayStr(today), delta);
    }
    return out;
  }

  router.add('GET', '/api/search/smart', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const q = str(query.q, 200);
    if (!q) throw new ApiError(400, 'QUERY_REQUIRED', 'Décrivez votre besoin (ex : « trouve-moi une salle mardi de 10h à 12h »).');
    const parsed = parseSmart(q);
    const need = [];
    if (!parsed.day) need.push('day');
    if (parsed.start === null) need.push('start');
    if (parsed.end === null) need.push('end');
    if (need.length) {
      const ask = { day: 'quel jour', start: 'l’heure de début', end: 'l’heure de fin' };
      return ok(res, {
        need, parsed,
        message: `J’ai besoin uniquement de ${need.map((n) => ask[n]).join(' et ')}.`,
        example: '« trouve-moi une salle mardi de 10h à 12h »'
      });
    }
    S.assertTimeSlot(parsed.day, parsed.start, parsed.end);
    const rooms = S.findAvailableRooms({
      day: parsed.day, startMin: parsed.start, endMin: parsed.end,
      equipment: parsed.equipment.join(','), includeRestricted: false
    });
    return ok(res, {
      parsed: { date: parsed.day, start: fmtMin(parsed.start), end: fmtMin(parsed.end), equipment: parsed.equipment },
      count: rooms.length, rooms
    });
  });

  /* ---------------- RECHERCHE GLOBALE ---------------- */
  router.add('GET', '/api/search/global', async ({ req, res, query }) => {
    const user = requireAuth(req);
    const q = `%${str(query.q, 80)}%`;
    if (!str(query.q, 80)) return ok(res, { results: [] });
    const d = db.get();
    const results = [];
    const push = (kind, items) => items.forEach((i) => results.push({ kind, ...i }));
    push('salle', d.prepare('SELECT id, code AS label, name AS sub, \'#/rooms\' AS link FROM rooms WHERE code LIKE ? OR name LIKE ? LIMIT 6').all(q, q).map((r) => ({ ...r, link: `#/rooms` })));
    push('option', d.prepare("SELECT id, code AS label, name AS sub FROM options WHERE (code LIKE ? OR name LIKE ?) AND status='ACTIVE' LIMIT 6").all(q, q).map((r) => ({ ...r, link: '#/options' })));
    push('groupe', d.prepare('SELECT id, code AS label, name AS sub FROM groups WHERE code LIKE ? OR name LIKE ? LIMIT 6').all(q, q).map((r) => ({ ...r, link: '#/groups' })));
    push('module', d.prepare('SELECT id, code AS label, name AS sub FROM modules WHERE code LIKE ? OR name LIKE ? LIMIT 6').all(q, q).map((r) => ({ ...r, link: '#/modules' })));
    push('enseignant', d.prepare('SELECT id, (prenom || \' \' || nom) AS label, specialty AS sub FROM teachers WHERE nom LIKE ? OR prenom LIKE ? OR email LIKE ? LIMIT 6').all(q, q, q).map((r) => ({ ...r, link: '#/teachers' })));
    if (user.role !== 'enseignant') {
      push('réservation', d.prepare(`SELECT r.id, (rm.code || ' — ' || r.title) AS label, (r.day || ' ' || r.start_min) AS sub
        FROM reservations r JOIN rooms rm ON rm.id = r.room_id
        WHERE r.status='CONFIRMED' AND (r.title LIKE ? OR rm.code LIKE ? OR r.day LIKE ?) LIMIT 6`).all(q, q, q)
        .map((r) => ({ ...r, link: '#/reservations' })));
    }
    return ok(res, { results });
  });

  /* ---------------- VIDER L’EMPLOI DU TEMPS D’UN SEMESTRE (admin) ---------------- */
  /* Deux modes, tous deux soumis à une confirmation explicite :
     · semester : « S3 » → seules les réservations de S3 sont supprimées ;
     · all: true → tout vider, mais seulement si confirm vaut le nom exact de
       l’établissement (double saisie) : impossible par inadvertance.
     Dans les deux cas seules les réservations sont supprimées : utilisateurs,
     salles, options, groupes, modules et enseignants sont conservés. Les
     verrous sont libérés par les déclencheurs trg_res_*_delete. */
  router.add('POST', '/api/admin/clear-planning', async ({ req, res }) => {
    const user = requireRole(req, 'admin');
    const b = await readJson(req);
    const settings = db.getSettings();
    const wipeAll = b.all === true || b.all === '1';

    if (wipeAll) {
      const institution = String(settings.institution_name || '').trim();
      if (str(b.confirm, 120).trim() !== institution) {
        throw new ApiError(400, 'CONFIRMATION_REQUIRED',
          `Pour tout vider, tapez exactement le nom de l’établissement : « ${institution} ».`);
      }
    } else if (str(b.confirm, 40) !== 'VIDER') {
      throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Confirmation requise : tapez « VIDER » pour vider le planning.');
    }

    const d = db.get();
    let semester = null;
    let ids;
    if (wipeAll) {
      ids = d.prepare("SELECT id FROM reservations WHERE status = 'CONFIRMED'").all().map((x) => x.id);
    } else {
      // Un semestre cible est obligatoire : on ne vide jamais « tout par erreur ».
      semester = S.normalizeSemester(b.semester);
      const variants = S.semesterVariants(semester);
      const norm = "TRIM(REPLACE(UPPER(COALESCE(NULLIF(r.semester, ''), m.semester, g.semester, '')), 'SEMESTRE', ''))";
      ids = d.prepare(`SELECT r.id FROM reservations r
        LEFT JOIN modules m ON m.id = r.module_id
        LEFT JOIN groups g ON g.id = r.group_id
        WHERE r.status = 'CONFIRMED' AND ${norm} IN (${variants.map(() => '?').join(',')})`).all(...variants)
        .map((x) => x.id);
    }
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      d.prepare(`DELETE FROM reservations WHERE id IN (${ph})`).run(...ids);
    }
    const locks = d.prepare('SELECT COUNT(*) AS c FROM reservation_locks').get().c;
    const scope = wipeAll ? 'tout le planning' : `le semestre ${semester}`;
    db.audit(user, wipeAll ? 'VIDER_PLANNING' : 'VIDER_PLANNING_SEMESTRE', 'reservation', null,
      { semester, deleted: ids.length }, null);
    realtime.publish('reservation.cleared', { deleted: ids.length, semester });
    return ok(res, { ok: true, semester, all: wipeAll, deleted: ids.length, locks_remaining: locks,
      message: wipeAll
        ? `${ids.length} réservation(s) supprimée(s) sur ${scope}. Utilisateurs, salles, options, groupes, modules et enseignants sont conservés.`
        : `${ids.length} réservation(s) supprimée(s) pour ${scope} uniquement. Les autres semestres, utilisateurs, salles, options, groupes, modules et enseignants sont conservés.` });
  });
};
