'use strict';
const db = require('./db');
const { ApiError, str, parseHHMM, fmtMin, todayStr, addDays, dayKeyOf, DAY_NAMES, parseDay, mondayOf, nowMin } = require('./util');
const { ERR } = require('./auth');

/* ---------- vue SQL unique des réservations ---------- */
const RES_SELECT = `
  SELECT r.*,
         rm.code AS room_code, rm.name AS room_name, rm.floor AS room_floor, rm.status AS room_status,
         o.code AS option_code, o.name AS option_name, o.category AS option_category,
         g.code AS group_code, g.name AS group_name,
         m.code AS module_code, m.name AS module_name,
         COALESCE(NULLIF(r.semester, ''), m.semester, g.semester, '') AS semester,
         t.nom AS teacher_nom, t.prenom AS teacher_prenom,
         u.nom AS creator_nom, u.prenom AS creator_prenom, u.email AS creator_email
  FROM reservations r
  JOIN rooms rm ON rm.id = r.room_id
  JOIN options o ON o.id = r.option_id
  LEFT JOIN groups g ON g.id = r.group_id
  LEFT JOIN modules m ON m.id = r.module_id
  LEFT JOIN teachers t ON t.id = r.teacher_id
  LEFT JOIN users u ON u.id = r.created_by
`;

function shapeReservation(r) {
  if (!r) return null;
  const teacher = r.teacher_id
    ? `${r.teacher_prenom || ''} ${r.teacher_nom || ''}`.trim()
    : (r.teacher_name_override || '');
  const module = r.module_id ? r.module_name : (r.module_name_override || '');
  return {
    id: r.id,
    room_id: r.room_id, room_code: r.room_code, room_name: r.room_name, floor: r.room_floor,
    option_id: r.option_id, option_code: r.option_code, option_name: r.option_name,
    option_category: r.option_category || '',
    group_id: r.group_id, group_code: r.group_code, group_name: r.group_name,
    module_id: r.module_id, module_code: r.module_code, module_name: module,
    semester: r.semester || '',
    teacher_id: r.teacher_id, teacher_name: teacher,
    teacher_name_override: r.teacher_name_override, module_name_override: r.module_name_override,
    title: r.title, day: r.day, start: fmtMin(r.start_min), end: fmtMin(r.end_min),
    start_min: r.start_min, end_min: r.end_min,
    students_count: r.students_count, equipment: r.equipment, notes: r.notes,
    status: r.status, created_by: r.created_by,
    created_by_name: r.created_by ? `${r.creator_prenom || ''} ${r.creator_nom || ''}`.trim() : '',
    created_at: r.created_at, updated_at: r.updated_at,
    weekday: DAY_NAMES[dayKeyOf(r.day)] || r.day
  };
}

function getReservation(id) {
  const row = db.get().prepare(RES_SELECT + ' WHERE r.id = ?').get(+id);
  return row ? shapeReservation(row) : null;
}

/* Normalisation du semestre : dans la base la valeur peut être 'S3', '3',
   'Semestre 3'… — les boutons S1→S6 de l’UI envoyant 'S3', on compare les
   formes normalisées des DEUX côtés pour que le filtre corresponde réellement. */
function semesterVariants(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (!raw) return [];
  const bare = raw.replace(/^SEMESTRE\s*/, '').trim();      // 'SEMESTRE 3' → '3'
  const num = bare.replace(/^S/, '').trim();                 // 'S3'      → '3'
  if (/^[1-6]$/.test(num)) return [`S${num}`, num];
  return [raw];
}

function listReservations(filter) {
  const f = filter || {};
  const where = [];
  const args = [];
  if (f.from) { where.push('r.day >= ?'); args.push(f.from); }
  if (f.to) { where.push('r.day <= ?'); args.push(f.to); }
  if (f.day) { where.push('r.day = ?'); args.push(f.day); }
  if (f.room_id) { where.push('r.room_id = ?'); args.push(+f.room_id); }
  if (f.room_code) { where.push('rm.code = ?'); args.push(String(f.room_code)); }
  if (f.option_id) { where.push('r.option_id = ?'); args.push(+f.option_id); }
  if (f.group_id) { where.push('r.group_id = ?'); args.push(+f.group_id); }
  if (f.module_id) { where.push('r.module_id = ?'); args.push(+f.module_id); }
  if (f.teacher_id) { where.push('r.teacher_id = ?'); args.push(+f.teacher_id); }
  if (f.floor) { where.push('rm.floor = ?'); args.push(String(f.floor)); }
  if (f.created_by) { where.push('r.created_by = ?'); args.push(+f.created_by); }
  // Les réservations annulées ne doivent apparaître dans aucun filtre (avant,
  // le filtre semestre les incluait car il remplaçait le test de statut).
  if (f.status) { where.push('r.status = ?'); args.push(String(f.status)); }
  else where.push("r.status = 'CONFIRMED'");
  if (f.semester) {
    const variants = semesterVariants(f.semester);
    if (!variants.length) where.push('1 = 0');
    else {
      // On retient d'abord le semestre cible posé sur la réservation, puis on
      // retombe sur le semestre du module ou du groupe pour les données
      // antérieures à la colonne semester. UPPER d'abord (casse libre dans la
      // base), puis retrait de « SEMESTRE » puis trim : 'Semestre 3' → '3'.
      const norm = "TRIM(REPLACE(UPPER(COALESCE(NULLIF(r.semester, ''), m.semester, g.semester, '')), 'SEMESTRE', ''))";
      where.push(`${norm} IN (${variants.map(() => '?').join(', ')})`);
      args.push(...variants);
    }
  }
  const sql = RES_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY r.day, r.start_min, rm.code LIMIT ' + (Math.min(+f.limit || 2000, 5000));
  return db.get().prepare(sql).all(...args).map(shapeReservation);
}

/* ---------- conflits ---------- */
function findConflict(roomId, day, startMin, endMin, excludeId) {
  const args = [roomId, day, endMin, startMin];
  let sql = `SELECT r.id, rm.code, r.start_min, r.end_min FROM reservations r JOIN rooms rm ON rm.id = r.room_id
             WHERE r.room_id = ? AND r.day = ? AND r.status = 'CONFIRMED' AND r.start_min < ? AND r.end_min > ?`;
  if (excludeId) { sql += ' AND r.id <> ?'; args.push(+excludeId); }
  const row = db.get().prepare(sql).get(...args);
  return row || null;
}

/* Un enseignant ne peut pas être programmé dans deux cours simultanés, même
   dans deux salles et deux semestres différents. */
function findTeacherConflict(teacherId, day, startMin, endMin, excludeId) {
  if (!teacherId) return null;
  const args = [teacherId, day, endMin, startMin];
  let sql = `SELECT r.id, rm.code AS room_code, r.start_min, r.end_min, r.semester
             FROM reservations r JOIN rooms rm ON rm.id = r.room_id
             WHERE r.teacher_id = ? AND r.day = ? AND r.status = 'CONFIRMED'
               AND r.start_min < ? AND r.end_min > ?`;
  if (excludeId) { sql += ' AND r.id <> ?'; args.push(+excludeId); }
  const row = db.get().prepare(sql).get(...args);
  return row || null;
}

/* Un même groupe d'étudiants ne peut pas avoir deux cours simultanés, même
   dans deux salles et deux semestres différents. */
function findGroupConflict(groupId, day, startMin, endMin, excludeId) {
  if (!groupId) return null;
  const args = [groupId, day, endMin, startMin];
  let sql = `SELECT r.id, rm.code AS room_code, r.start_min, r.end_min
             FROM reservations r JOIN rooms rm ON rm.id = r.room_id
             WHERE r.group_id = ? AND r.day = ? AND r.status = 'CONFIRMED'
               AND r.start_min < ? AND r.end_min > ?`;
  if (excludeId) { sql += ' AND r.id <> ?'; args.push(+excludeId); }
  const row = db.get().prepare(sql).get(...args);
  return row || null;
}

/* Quand aucun groupe n'est renseigné, c'est l'option qui est concernée : deux
   cours d'une même option ne peuvent pas se chevaucher, y compris dans des
   salles différentes. */
function findOptionConflict(optionId, day, startMin, endMin, excludeId) {
  if (!optionId) return null;
  const args = [optionId, day, endMin, startMin];
  let sql = `SELECT r.id, rm.code AS room_code, r.start_min, r.end_min
             FROM reservations r JOIN rooms rm ON rm.id = r.room_id
             WHERE r.option_id = ? AND r.day = ? AND r.status = 'CONFIRMED'
               AND r.group_id IS NULL AND r.start_min < ? AND r.end_min > ?`;
  if (excludeId) { sql += ' AND r.id <> ?'; args.push(+excludeId); }
  const row = db.get().prepare(sql).get(...args);
  return row || null;
}

const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* Contrôle centralisé de TOUS les conflits, à l'échelle de l'établissement et
   tous semestres confondus. La base de données refuse de son côté (verrous
   atomiques) si deux requêtes arrivent exactement en même temps : ce contrôle
   sert uniquement à expliquer clairement à l'utilisateur ce qui coince. */
function assertNoConflicts({ room, option_id, group_id, teacher_id, day, start, end, exclude_id }) {
  const roomClash = findConflict(room.id, day, start, end, exclude_id);
  if (roomClash) {
    throw new ApiError(409, 'ROOM_CONFLICT',
      `Conflit de salle : ${room.code} est déjà réservée de ${hh(roomClash.start_min)} à ${hh(roomClash.end_min)} ce jour-là.`,
      { kind: 'room', room: room.code, start: hh(roomClash.start_min), end: hh(roomClash.end_min), reservation_id: roomClash.id });
  }
  const teacherClash = findTeacherConflict(teacher_id, day, start, end, exclude_id);
  if (teacherClash) {
    throw new ApiError(409, 'TEACHER_CONFLICT',
      `Conflit d'enseignant : cette personne est déjà programmée de ${hh(teacherClash.start_min)} à ${hh(teacherClash.end_min)} ce jour-là (salle ${teacherClash.room_code}${teacherClash.semester ? `, ${teacherClash.semester}` : ''}).`,
      { kind: 'teacher', room: teacherClash.room_code, start: hh(teacherClash.start_min), end: hh(teacherClash.end_min), reservation_id: teacherClash.id });
  }
  const groupClash = findGroupConflict(group_id, day, start, end, exclude_id);
  if (groupClash) {
    throw new ApiError(409, 'GROUP_CONFLICT',
      `Conflit de groupe : ce groupe a déjà cours de ${hh(groupClash.start_min)} à ${hh(groupClash.end_min)} ce jour-là (salle ${groupClash.room_code}).`,
      { kind: 'group', room: groupClash.room_code, start: hh(groupClash.start_min), end: hh(groupClash.end_min), reservation_id: groupClash.id });
  }
  if (!group_id) {
    const optionClash = findOptionConflict(option_id, day, start, end, exclude_id);
    if (optionClash) {
      throw new ApiError(409, 'OPTION_CONFLICT',
        `Conflit d'option : l'option a déjà cours de ${hh(optionClash.start_min)} à ${hh(optionClash.end_min)} ce jour-là (salle ${optionClash.room_code}).`,
        { kind: 'option', room: optionClash.room_code, start: hh(optionClash.start_min), end: hh(optionClash.end_min), reservation_id: optionClash.id });
    }
  }
}

/* Le semestre cible est obligatoire : aucun emploi du temps ne doit être créé
   sans semestre. */
function normalizeSemester(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (!raw) throw new ApiError(400, 'SEMESTER_REQUIRED', 'Le semestre cible est obligatoire : choisissez un semestre (S1 à S6).');
  const num = raw.replace(/^SEMESTRE\s*/, '').replace(/^S/, '').trim();
  if (!/^[1-6]$/.test(num)) {
    throw new ApiError(400, 'INVALID_SEMESTER', 'Semestre invalide : choisissez S1, S2, S3, S4, S5 ou S6.');
  }
  return `S${num}`;
}

function assertTimeSlot(day, startMin, endMin) {
  if (!parseDay(day)) throw new ApiError(400, 'INVALID_DATE', 'Date invalide (format AAAA-MM-JJ).');
  if (startMin === null || endMin === null) throw new ApiError(400, 'INVALID_TIME', 'Heure invalide.');
  if (endMin <= startMin) throw new ApiError(400, 'INVALID_RANGE', 'L’heure de fin doit être après l’heure de début.');
  if (startMin % 30 !== 0 || endMin % 30 !== 0) {
    throw new ApiError(400, 'SLOT_NOT_ALIGNED', 'Les créneaux doivent être alignés sur 30 minutes (ex : 08:00, 08:30).');
  }
  const key = dayKeyOf(day);
  const s = db.getSettings();
  const closed = String(s.closed_days || 'sun').split(',').map((x) => x.trim()).filter(Boolean);
  if (closed.includes(key)) throw new ApiError(400, 'DAY_CLOSED', `${DAY_NAMES[key]} : établissement fermé (paramétrable).`);
}

/* ---------- permissions réservation ---------- */
function assertCanCreate(user, optionId) {
  if (user.role === 'admin') return;
  if (user.role !== 'coordinateur') throw new ApiError(403, 'FORBIDDEN', 'Seuls les coordinateurs et l’administration peuvent créer des réservations.');
  const ok = user.approved_options.some((o) => o.id === +optionId);
  if (!ok) throw ERR.OPTION();
}

function assertCanManage(user, resv) {
  if (user.role === 'admin') return;
  if (user.role !== 'coordinateur') throw ERR.OWNERSHIP();
  const ok = user.approved_options.some((o) => o.id === resv.option_id);
  if (!ok) throw ERR.OWNERSHIP();
}

function assertRoomBookable(user, roomId) {
  const room = db.get().prepare('SELECT * FROM rooms WHERE id = ?').get(+roomId);
  if (!room) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
  if (room.status === 'INACTIVE') throw new ApiError(403, 'ROOM_INACTIVE', 'Cette salle est désactivée.');
  if (!room.is_available_for_normal_booking && user.role !== 'admin') {
    throw ERR.RESTRICTED();
  }
  return room;
}

/* ---------- recherche de salle ---------- */
function findAvailableRooms({ day, startMin, endMin, equipment, floor, includeRestricted, excludeRoomId }) {
  const rooms = db.get().prepare('SELECT * FROM rooms ORDER BY CASE floor WHEN \'RDC\' THEN 1 WHEN \'1ER\' THEN 2 ELSE 3 END, code').all();
  const busy = new Set(
    db.get().prepare("SELECT DISTINCT room_id FROM reservations WHERE day = ? AND status = 'CONFIRMED' AND start_min < ? AND end_min > ?")
      .all(day, endMin, startMin).map((r) => r.room_id)
  );
  const wanted = String(equipment || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return rooms.filter((room) => {
    if (excludeRoomId && room.id === +excludeRoomId) return false;
    if (room.status !== 'ACTIVE') return false;
    if (floor && room.floor !== floor) return false;
    if (!room.is_available_for_normal_booking) return !!includeRestricted; // S12-1ER exclue par défaut
    if (busy.has(room.id)) return false;
    if (wanted.length) {
      const have = String(room.equipment || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      if (!wanted.every((w) => have.includes(w))) return false;
    }
    return true;
  }).map((room) => ({
    id: room.id, code: room.code, name: room.name, floor: room.floor, location: room.location,
    equipment: room.equipment, status: room.status, reserved_for: room.reserved_for,
    available: !busy.has(room.id), bookable: !!room.is_available_for_normal_booking
  }));
}

/* ---------- occupation ---------- */
function occupancyAt(day, minute) {
  const rooms = db.get().prepare('SELECT * FROM rooms').all();
  const busy = db.get().prepare(`
    SELECT r.id, r.room_id, r.day, r.start_min, r.end_min, r.title, o.code AS option_code, r.created_by
    FROM reservations r JOIN options o ON o.id = r.option_id
    WHERE r.day = ? AND r.status = 'CONFIRMED' AND r.start_min <= ? AND r.end_min > ?`).all(day, minute, minute);
  const busyMap = new Map(busy.map((b) => [b.room_id, b]));
  const free = [];
  const taken = [];
  for (const room of rooms) {
    const restricted = !room.is_available_for_normal_booking;
    const item = {
      id: room.id, code: room.code, name: room.name, floor: room.floor, location: room.location,
      reserved_for: room.reserved_for, restricted,
      booking: busyMap.has(room.id) ? {
        id: busyMap.get(room.id).id, option: busyMap.get(room.id).option_code,
        title: busyMap.get(room.id).title,
        start: fmtMin(busyMap.get(room.id).start_min), end: fmtMin(busyMap.get(room.id).end_min)
      } : null
    };
    if (restricted) continue; // jamais "libre" pour les réservations normales
    if (busyMap.has(room.id)) taken.push(item); else free.push(item);
  }
  return { free, taken, at: fmtMin(minute), day };
}

/* ---------- copie de planning ---------- */
function copyReservations(user, { from_day, to_days, option_filter }) {
  const source = db.get().prepare(RES_SELECT + " WHERE r.day = ? AND r.status = 'CONFIRMED'").all(from_day);
  if (!source.length) return { created: 0, skipped: [], empty: true };
  const allowed = user.role === 'admin' ? null : user.approved_options.map((o) => o.id);
  const createdRows = [];
  const skipped = [];
  const ins = db.get().prepare(`
    INSERT INTO reservations (room_id, option_id, group_id, module_id, teacher_id, teacher_name_override,
      module_name_override, title, day, start_min, end_min, students_count, equipment, notes, semester, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const target of to_days) {
    if (!parseDay(target)) continue;
    for (const r of source) {
      if (option_filter && r.option_id !== +option_filter) continue;
      if (allowed && !allowed.includes(r.option_id)) continue;
      // Le même contrôle de conflits que pour une réservation manuelle : la
      // copie ne doit jamais créer un conflit de salle, d'enseignant ou de groupe.
      let clash = null;
      try {
        assertNoConflicts({ room: { id: r.room_id, code: r.room_code }, option_id: r.option_id,
          group_id: r.group_id, teacher_id: r.teacher_id, day: target,
          start: r.start_min, end: r.end_min });
      } catch (e) {
        clash = e;
      }
      if (clash) {
        skipped.push({ room: r.room_code, day: target, start: fmtMin(r.start_min), end: fmtMin(r.end_min),
          reason: 'CONFLIT', kind: clash.code || 'CONFLIT', message: clash.message });
        continue;
      }
      try {
        ins.run(r.room_id, r.option_id, r.group_id, r.module_id, r.teacher_id, r.teacher_name_override,
          r.module_name_override, r.title, target, r.start_min, r.end_min, r.students_count, r.equipment,
          r.notes, r.semester || '', user.id);
        createdRows.push(target);
      } catch (e) {
        skipped.push({ room: r.room_code, day: target, start: fmtMin(r.start_min), end: fmtMin(r.end_min), reason: 'CONFLIT', detail: e.message });
      }
    }
  }
  return { created: createdRows.length, skipped };
}

function nextReservations(limit, fromDay) {
  const day = fromDay || todayStr();
  const min = nowMin();
  const rows = db.get().prepare(RES_SELECT + ` WHERE r.status = 'CONFIRMED' AND (r.day > ? OR (r.day = ? AND r.end_min >= ?))
    ORDER BY r.day, r.start_min LIMIT ?`).all(day, day, min, limit || 8);
  return rows.map(shapeReservation);
}

module.exports = {
  RES_SELECT, shapeReservation, getReservation, listReservations, semesterVariants, findConflict,
  findTeacherConflict, findGroupConflict, findOptionConflict, assertNoConflicts, normalizeSemester,
  assertTimeSlot, assertCanCreate, assertCanManage, assertRoomBookable,
  findAvailableRooms, occupancyAt, copyReservations, nextReservations
};
