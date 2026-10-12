'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { hashSecret, todayStr } = require('./util');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SMARTSALLE_DB || path.join(DATA_DIR, 'smartsalle.db');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','coordinateur','enseignant')),
  -- Genre du titulaire : 'M' ou 'F' (vide = compte antérieur à cette colonne).
  -- Sert uniquement au titre affiché (Coordinateur / Coordinatrice) : il ne
  -- conditionne AUCUN droit d'accès ni aucune fonctionnalité.
  gender TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','refused','suspended')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  active_option_id INTEGER REFERENCES options(id) ON DELETE SET NULL,
  teacher_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status);

CREATE TABLE IF NOT EXISTS coordinator_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (user_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_co ON coordinator_options(user_id, status);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  floor TEXT NOT NULL DEFAULT 'RDC',
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESERVED','INACTIVE')),
  reserved_for TEXT NOT NULL DEFAULT '',
  is_available_for_normal_booking INTEGER NOT NULL DEFAULT 1,
  equipment TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  qr_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  option_id INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  semester TEXT NOT NULL DEFAULT '',
  academic_year TEXT NOT NULL DEFAULT '',
  students_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  specialty TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  establishment TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  option_id INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  semester TEXT NOT NULL DEFAULT '',
  academic_year TEXT NOT NULL DEFAULT '',
  hours REAL NOT NULL DEFAULT 0,
  hours_theory REAL NOT NULL DEFAULT 0,
  hours_td REAL NOT NULL DEFAULT 0,
  hours_tp REAL NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL DEFAULT 'VALIDATED',
  validation_comment TEXT NOT NULL DEFAULT '',
  validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS module_teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  academic_year TEXT NOT NULL DEFAULT '',
  semester TEXT NOT NULL DEFAULT '',
  hours REAL NOT NULL DEFAULT 0,
  teaching_type TEXT NOT NULL DEFAULT 'COURS',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  validation_status TEXT NOT NULL DEFAULT 'VALIDATED',
  validation_comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (module_id, teacher_id, academic_year)
);
CREATE INDEX IF NOT EXISTS idx_mt_module ON module_teachers(module_id);
CREATE INDEX IF NOT EXISTS idx_mt_teacher ON module_teachers(teacher_id);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES options(id),
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  teacher_name_override TEXT NOT NULL DEFAULT '',
  module_name_override TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  students_count INTEGER NOT NULL DEFAULT 0,
  equipment TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  semester TEXT NOT NULL DEFAULT '',
  academic_year TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED','CANCELLED')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  CHECK (start_min % 30 = 0 AND end_min % 30 = 0 AND end_min > start_min),
  CHECK (start_min >= 0 AND end_min <= 1440),
  CHECK (day LIKE '____-__-__')
);
CREATE INDEX IF NOT EXISTS idx_res_day ON reservations(day, room_id);
CREATE INDEX IF NOT EXISTS idx_res_room ON reservations(room_id, status);
CREATE INDEX IF NOT EXISTS idx_res_option ON reservations(option_id, day);

-- =========================================================================
-- Garantie base de données : aucune réservation ne peut chevaucher une autre
-- dans la même salle. Chaque créneau de 30 minutes est verrouillé par une
-- clé primaire (room_id, day, slot) : toute insertion qui se chevauche échoue
-- au niveau du SGBD, même si deux utilisateurs réservent simultanément.
-- =========================================================================
CREATE TABLE IF NOT EXISTS reservation_locks (
  room_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  slot INTEGER NOT NULL,
  reservation_id INTEGER NOT NULL,
  PRIMARY KEY (room_id, day, slot)
) WITHOUT ROWID;

-- Verrou atomique ENSEIGNANT : un enseignant ne peut pas être programmé dans
-- deux cours simultanés, même dans deux salles et deux semestres différents.
CREATE TABLE IF NOT EXISTS teacher_locks (
  teacher_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  slot INTEGER NOT NULL,
  reservation_id INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, day, slot)
) WITHOUT ROWID;  -- Verrou atomique GROUPE : un même groupe d'étudiants ne peut pas avoir deux
  -- cours simultanés, même dans deux salles et deux semestres différents. Le
  -- verrou n'est posé que si un groupe est renseigné ; le conflit d'option est
  -- contrôlé dans services.assertNoConflicts avant l'insertion.
CREATE TABLE IF NOT EXISTS group_locks (
  entity_key TEXT NOT NULL,
  day TEXT NOT NULL,
  slot INTEGER NOT NULL,
  reservation_id INTEGER NOT NULL,
  PRIMARY KEY (entity_key, day, slot)
) WITHOUT ROWID;

-- Grille des demi-heures (0..47) alimentée au démarrage : les déclencheurs
-- ci-dessous l'utilisent pour verrouiller chaque créneau occupé.
CREATE TABLE IF NOT EXISTS slot_grid (
  slot INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);

DROP TRIGGER IF EXISTS trg_res_lock_insert;
CREATE TRIGGER trg_res_lock_insert AFTER INSERT ON reservations
FOR EACH ROW WHEN NEW.status = 'CONFIRMED'
BEGIN
  INSERT INTO reservation_locks (room_id, day, slot, reservation_id)
  SELECT NEW.room_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_lock_update;
CREATE TRIGGER trg_res_lock_update AFTER UPDATE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM reservation_locks WHERE reservation_id = NEW.id;
  INSERT INTO reservation_locks (room_id, day, slot, reservation_id)
  SELECT NEW.room_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE NEW.status = 'CONFIRMED'
    AND g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_lock_delete;
CREATE TRIGGER trg_res_lock_delete AFTER DELETE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM reservation_locks WHERE reservation_id = OLD.id;
END;

-- Règle S12-1ER : salle réservée au Master Management, jamais réservable
-- "normalement" — appliquée par la base de données elle-même.
DROP TRIGGER IF EXISTS trg_res_restricted_insert;
CREATE TRIGGER trg_res_restricted_insert BEFORE INSERT ON reservations
WHEN (
  SELECT COALESCE(r.is_available_for_normal_booking, 1) FROM rooms r WHERE r.id = NEW.room_id
) = 0
AND COALESCE((SELECT u.role FROM users u WHERE u.id = NEW.created_by), '') <> 'admin'
BEGIN
  SELECT RAISE(ABORT, 'ROOM_RESTRICTED');
END;

-- =====================================================================
-- Verrou ENSEIGNANT : déclenché à l'insertion ET à la mise à jour, il
-- refuse (ABORT) tout cours qui donnerait à un même enseignant deux
-- créneaux simultanés. La décision est prise par la base elle-même : la
-- course entre deux requêtes simultanées est impossible.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_res_teacher_insert;
CREATE TRIGGER trg_res_teacher_insert AFTER INSERT ON reservations
FOR EACH ROW WHEN NEW.status = 'CONFIRMED' AND NEW.teacher_id IS NOT NULL
BEGIN
  INSERT INTO teacher_locks (teacher_id, day, slot, reservation_id)
  SELECT NEW.teacher_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_teacher_update;
CREATE TRIGGER trg_res_teacher_update AFTER UPDATE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM teacher_locks WHERE reservation_id = NEW.id;
  INSERT INTO teacher_locks (teacher_id, day, slot, reservation_id)
  SELECT NEW.teacher_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE NEW.status = 'CONFIRMED' AND NEW.teacher_id IS NOT NULL
    AND g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_teacher_delete;
CREATE TRIGGER trg_res_teacher_delete AFTER DELETE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM teacher_locks WHERE reservation_id = OLD.id;
END;

-- =====================================================================
-- Verrou GROUPE : un même groupe d'étudiants ne peut pas avoir deux cours
-- simultanés, même dans deux salles et deux semestres différents. Le verrou
-- n'est posé QUE si un groupe est réellement renseigné : sans groupe, la clé
-- serait identique pour tout un lot de cours et le déclencheur se
-- contredirait lui-même. La règle « une option ne peut pas avoir deux cours
-- simultanés » est contrôlée dans services.assertNoGroupConflict.
-- =====================================================================
DROP TRIGGER IF EXISTS trg_res_group_insert;
CREATE TRIGGER trg_res_group_insert AFTER INSERT ON reservations
FOR EACH ROW WHEN NEW.status = 'CONFIRMED' AND NEW.group_id IS NOT NULL
BEGIN
  INSERT INTO group_locks (entity_key, day, slot, reservation_id)
  SELECT 'G:' || NEW.group_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_group_update;
CREATE TRIGGER trg_res_group_update AFTER UPDATE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM group_locks WHERE reservation_id = NEW.id;
  INSERT INTO group_locks (entity_key, day, slot, reservation_id)
  SELECT 'G:' || NEW.group_id, NEW.day, g.slot, NEW.id
  FROM slot_grid g
  WHERE NEW.status = 'CONFIRMED' AND NEW.group_id IS NOT NULL
    AND g.slot >= NEW.start_min / 30 AND g.slot < NEW.end_min / 30;
END;

DROP TRIGGER IF EXISTS trg_res_group_delete;
CREATE TRIGGER trg_res_group_delete AFTER DELETE ON reservations
FOR EACH ROW
BEGIN
  DELETE FROM group_locks WHERE reservation_id = OLD.id;
END;

DROP TRIGGER IF EXISTS trg_res_restricted_update;
CREATE TRIGGER trg_res_restricted_update BEFORE UPDATE ON reservations
WHEN (
  SELECT COALESCE(r.is_available_for_normal_booking, 1) FROM rooms r WHERE r.id = NEW.room_id
) = 0
AND COALESCE((SELECT u.role FROM users u WHERE u.id = NEW.created_by), '') <> 'admin'
BEGIN
  SELECT RAISE(ABORT, 'ROOM_RESTRICTED');
END;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'verify_email',
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_codes_user ON email_codes(user_id, purpose);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','DOING','DONE')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_label TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_SETTINGS = {
  app_name: 'SMARTSALLE ISPITS',
  institution_name: 'ISPITS LAÂYOUNE',
  subtitle: 'Gestion intelligente des salles, des emplois du temps et des réservations',
  logo_url: '/assets/logo-ispits.png',
  day_start: '08:00',
  day_end: '18:00',
  working_days: 'mon,tue,wed,thu,fri,sat',
  closed_days: 'sun',
  semester: 'S1',
  academic_year: '2026/2027',
  require_module_validation: '0',
  pdf_header: 'ROYAUME DU MAROC\nMINISTÈRE DE LA SANTÉ ET DE LA PROTECTION SOCIALE\nISPITS LAÂYOUNE\nEMPLOI DU TEMPS',
  pdf_extra: '',
  pdf_header_image: '/assets/entete-officielle.png',
  pdf_footer_image: '/assets/pied-officielle.png',
  session_hours: '2',
  print_show_rooms: '1',
  sig_dac: 'DAC',
  sig_directeur: 'Directeur de l’ISPITS',
  notify_reservations: '1',
  notify_accounts: '1',
  notify_tasks: '1',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_from: 'no-reply@ispits.ma',
  smtp_secure: 'starttls',
  expose_dev_codes: '1'
};

/* Catalogue officiel des filières de l'ISPITS Laâyoune.
   [code, intitulé, filière] — l'ordre des filières est celui d'affichage. */
const OPTION_CATEGORIES = ['Soins Infirmiers', 'Techniques de Santé', 'Rééducation et Réhabilitation', 'Autres Filières'];
const OPTION_CATALOG = [
  // IP et IBO restent les deux premières options (ids 1 et 2 en base neuve).
  ['IP', 'Infirmier Polyvalent', 'Soins Infirmiers'],
  ['IBO', 'Infirmier en Bloc Opératoire', 'Soins Infirmiers'],
  ['ISM', 'Infirmier en Santé Mentale', 'Soins Infirmiers'],
  ['IPAR/IDAR', 'Infirmier en Anesthésie Réanimation', 'Soins Infirmiers'],
  ['ISUSI', 'Infirmier en Soins d\u2019Urgence et Soins Intensifs', 'Soins Infirmiers'],
  ['ISF', 'Infirmier en Santé de la Famille', 'Soins Infirmiers'],
  ['RAD', 'Radiologie', 'Techniques de Santé'],
  ['LAB', 'Laboratoire', 'Techniques de Santé'],
  ['PREP', 'Préparateur en Pharmacie', 'Techniques de Santé'],
  ['DN', 'Diététique et Nutrition', 'Techniques de Santé'],
  ['SE', 'Santé de l\u2019Environnement', 'Techniques de Santé'],
  ['SS', 'Statistiques Sanitaires', 'Techniques de Santé'],
  ['KINE', 'Kinésithérapie', 'Rééducation et Réhabilitation'],
  ['ORTHO', 'Orthophonie / Orthoptie / Orthoprothésie', 'Rééducation et Réhabilitation'],
  ['ERGO', 'Ergothérapie', 'Rééducation et Réhabilitation'],
  ['PSYCHOM', 'Psychomotricité', 'Rééducation et Réhabilitation'],
  ['SF', 'Sage-Femme', 'Autres Filières'],
  ['AS', 'Assistant Social (Assistance Médico-Sociale)', 'Autres Filières']
];

const ROOMS = [
  ['S01', 'Salle S01', 'RDC', 'Rez-de-chaussée', 1],
  ['S02', 'Salle S02', 'RDC', 'Rez-de-chaussée', 1],
  ['S03', 'Salle S03', 'RDC', 'Rez-de-chaussée', 1],
  ['S04', 'Salle S04', 'RDC', 'Rez-de-chaussée', 1],
  ['S05', 'Salle S05', 'RDC', 'Rez-de-chaussée', 1],
  ['S12-RDC', 'Salle S12 (Rez-de-chaussée)', 'RDC', 'Rez-de-chaussée', 1],
  ['S13', 'Salle S13', 'RDC', 'Rez-de-chaussée', 1],
  ['S06', 'Salle S06', '1ER', 'Premier étage', 1],
  ['S07', 'Salle S07', '1ER', 'Premier étage', 1],
  ['S08', 'Salle S08', '1ER', 'Premier étage', 1],
  ['S09', 'Salle S09', '1ER', 'Premier étage', 1],
  ['S10', 'Salle S10', '1ER', 'Premier étage', 1],
  ['S11', 'Salle S11', '1ER', 'Premier étage', 1],
  ['S12-1ER', 'Salle S12 (Premier étage)', '1ER', 'Premier étage', 0],
  ['AMPHI', 'Amphithéâtre', 'AMPHI', 'Entrée de l’ISPITS — à gauche', 1]
];

let db = null;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function get() {
  return db || open();
}

function seed(d) {
  // Grille des demi-heures 00:00 → 24:00
  if (d.prepare('SELECT COUNT(*) AS c FROM slot_grid').get().c < 48) {
    d.prepare('DELETE FROM slot_grid').run();
    const ins = d.prepare('INSERT INTO slot_grid (slot, label) VALUES (?,?)');
    for (let i = 0; i < 48; i++) ins.run(i, `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
  }

  const roomCount = d.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  if (roomCount === 0) {
    const ins = d.prepare('INSERT INTO rooms (code, name, floor, location, status, reserved_for, is_available_for_normal_booking, qr_token) VALUES (?,?,?,?,?,?,?,?)');
    const { randomToken } = require('./util');
    for (const [code, name, floor, location, normal] of ROOMS) {
      const reserved = normal === 0;
      ins.run(code, name, floor, location, reserved ? 'RESERVED' : 'ACTIVE',
        reserved ? 'MASTER MANAGEMENT' : '', reserved ? 0 : 1, randomToken(16));
    }
    console.log(`[seed] ${ROOMS.length} salles initialisées (dont S12-1ER réservée au MASTER MANAGEMENT)`);
  }

  // Migration : colonne « gender » sur les comptes existants. Aucun compte n'est
  // modifié autrement : la valeur reste vide et le titre masculin historique est
  // conservé, tant que l'administration n'a pas précisé le genre.
  const userCols = d.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'gender')) {
    d.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    console.log("[seed] colonne users.gender ajoutée (titres Coordinateur / Coordinatrice)");
  }

  // Migration : nettoyage des anciens libellés de signature masculins. Ces deux
  // réglages n'étaient plus lus nulle part depuis le passage aux titres dynamiques
  // (optionTitle / filiereTitle) : les laisser en place aurait fait réapparaître
  // un champ « Signature — Coordinateur d’Option » dans les paramètres, sans
  // aucun effet sur l'impression. Les libellés restent portés par les blocs de
  // signature eux-mêmes, calculés à partir du genre du responsable.
  const deadSig = d.prepare("DELETE FROM settings WHERE key IN ('sig_coordinateur_option','sig_coordinateur_filiere')").run();
  if (deadSig.changes) console.log(`[seed] ${deadSig.changes} libellé(s) de signature masculin(s) obsolète(s) retiré(s)`);

  // Migration : colonne « category » (filière) sur les bases existantes.
  const optCols = d.prepare('PRAGMA table_info(options)').all();
  if (!optCols.some((c) => c.name === 'category')) {
    d.exec("ALTER TABLE options ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    console.log('[seed] colonne options.category ajoutée');
  }

  // Migration : colonne « description » sur les modules (bases existantes).
  const modCols = d.prepare('PRAGMA table_info(modules)').all();
  if (!modCols.some((c) => c.name === 'description')) {
    d.exec("ALTER TABLE modules ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    console.log('[seed] colonne modules.description ajoutée');
  }

  // Migration : nouvelles colonnes modules (répartition horaire, validation).
  const modCols2 = d.prepare('PRAGMA table_info(modules)').all();
  const modNewCols = {
    hours_theory: 'REAL NOT NULL DEFAULT 0',
    hours_td: 'REAL NOT NULL DEFAULT 0',
    hours_tp: 'REAL NOT NULL DEFAULT 0',
    validation_status: "TEXT NOT NULL DEFAULT 'VALIDATED'",
    validation_comment: "TEXT NOT NULL DEFAULT ''",
    validated_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL',
    validated_at: 'TEXT',
    created_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL'
  };
  for (const [col, def] of Object.entries(modNewCols)) {
    if (!modCols2.some((c) => c.name === col)) {
      d.exec(`ALTER TABLE modules ADD COLUMN ${col} ${def}`);
      console.log(`[seed] colonne modules.${col} ajoutée`);
    }
  }

  // Migration : nouvelles colonnes enseignants (grade, téléphone, établissement…).
  const teachCols = d.prepare('PRAGMA table_info(teachers)').all();
  const teachNewCols = { grade: '', phone: '', establishment: '', contract: '', notes: '' };
  for (const col of Object.keys(teachNewCols)) {
    if (!teachCols.some((c) => c.name === col)) {
      d.exec(`ALTER TABLE teachers ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
      console.log(`[seed] colonne teachers.${col} ajoutée`);
    }
  }

  // Migration : semestre cible + année sur les réservations existantes.
  // Aucune donnée n'est supprimée : on recolle le semestre depuis le module
  // puis le groupe, comme le faisait déjà le filtre d'affichage.
  const resCols = d.prepare('PRAGMA table_info(reservations)').all();
  if (!resCols.some((c) => c.name === 'semester')) {
    d.exec("ALTER TABLE reservations ADD COLUMN semester TEXT NOT NULL DEFAULT ''");
    console.log('[seed] colonne reservations.semester ajoutée');
  }
  if (!resCols.some((c) => c.name === 'academic_year')) {
    d.exec("ALTER TABLE reservations ADD COLUMN academic_year TEXT NOT NULL DEFAULT ''");
    console.log('[seed] colonne reservations.academic_year ajoutée');
  }
  const backfilled = d.prepare(`UPDATE reservations
      SET semester = TRIM(REPLACE(UPPER(COALESCE(NULLIF(m.semester, ''), g.semester, '')), 'SEMESTRE', '')),
          academic_year = COALESCE(NULLIF(m.academic_year, ''), NULLIF(g.academic_year, ''), '')
      FROM modules m LEFT JOIN groups g ON g.id = m.group_id
      WHERE reservations.module_id = m.id AND reservations.semester = ''`).run().changes
    + d.prepare(`UPDATE reservations SET semester = TRIM(REPLACE(UPPER(g.semester), 'SEMESTRE', '')),
        academic_year = COALESCE(NULLIF(g.academic_year, ''), '')
        FROM groups g WHERE reservations.group_id = g.id AND reservations.semester = ''`).run().changes;
  if (backfilled) console.log(`[seed] ${backfilled} réservation(s) existante(s) rattachée(s) à leur semestre`);

  /* Dernier recours : une réservation SANS module ni groupe (saisie libre, avant
     que le semestre ne devienne obligatoire) ne peut recopier aucun semestre.
     Sans cette étape elle resterait « sans semestre » et serait invisible dans
     TOUTES les vues S1→S6, ce qui ferait disparaître des cours déjà enregistrés
     — contraire à la règle de conservation des données. On la rattache donc au
     semestre courant de l’établissement, celui affiché par défaut. */
  const orphans = d.prepare("SELECT COUNT(*) AS c FROM reservations WHERE TRIM(semester) = ''").get().c;
  if (orphans > 0) {
    const fallback = String(getSettings().semester || 'S1').trim().toUpperCase();
    const num = fallback.replace(/^SEMESTRE\s*/, '').replace(/^S/, '').trim();
    const target = /^[1-6]$/.test(num) ? `S${num}` : 'S1';
    const n = d.prepare("UPDATE reservations SET semester = ? WHERE TRIM(semester) = ''").run(target).changes;
    console.log(`[seed] ${n} réservation(s) sans module ni groupe rattachée(s) au semestre ${target} (semestre par défaut de l’établissement)`);
  }

  // Reconstruction complète des verrous à partir des réservations confirmées :
  // les lignes migrées depuis une base plus ancienne n'ont aucun verrou, et
  // des verrous orphelins d'une base antérieure feraient échouer des
  // réservations légitimes. Un verrou qui ne peut pas être reconstruit signale
  // un conflit déjà présent dans les données : on le laisse de côté plutôt
  // que de bloquer le démarrage, mais on le signale à l'administrateur.
  const totalRes = d.prepare("SELECT COUNT(*) c FROM reservations WHERE status = 'CONFIRMED'").get().c;
  if (totalRes > 0) {
    const rebuild = (table, insertCols, selectExprs) => {
      const n = d.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      if (n > 0) d.exec(`DELETE FROM ${table}`);
      const ins = d.prepare(`INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}, slot, reservation_id)
        SELECT ${selectExprs.join(', ')}, g.slot, r.id FROM reservations r JOIN slot_grid g
        ON g.slot >= r.start_min / 30 AND g.slot < r.end_min / 30 WHERE r.status = 'CONFIRMED'`);
      return ins.run().changes;
    };
    const roomPlaced = rebuild('reservation_locks', ['room_id', 'day'], ['r.room_id', 'r.day']);
    const tRes = rebuild('teacher_locks', ['teacher_id', 'day'], ['r.teacher_id', 'r.day']);
    // group_locks : un verrou de groupe n'existe que si la réservation en a un.
    const gRes = rebuild('group_locks', ['entity_key', 'day'],
      ["CASE WHEN r.group_id IS NOT NULL THEN 'G:' || r.group_id ELSE NULL END", 'r.day']);
    console.log(`[seed] verrous reconstruits : ${roomPlaced} salle, ${tRes} enseignant, ${gRes} groupe (${totalRes} réservation(s) confirmée(s))`);
  }

  // Migration : table d'affectations enseignants-modules (N:N).
  const hasMt = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='module_teachers'").get();
  if (!hasMt) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS module_teachers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
        academic_year TEXT NOT NULL DEFAULT '',
        semester TEXT NOT NULL DEFAULT '',
        hours REAL NOT NULL DEFAULT 0,
        teaching_type TEXT NOT NULL DEFAULT 'COURS',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        validation_status TEXT NOT NULL DEFAULT 'VALIDATED',
        validation_comment TEXT NOT NULL DEFAULT '',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (module_id, teacher_id, academic_year)
      );
      CREATE INDEX IF NOT EXISTS idx_mt_module ON module_teachers(module_id);
      CREATE INDEX IF NOT EXISTS idx_mt_teacher ON module_teachers(teacher_id);
    `);
    console.log('[seed] table module_teachers créée');
  }

  // Migration : recopier l'enseignant existant du module dans module_teachers
  // (les affectations historiques ne sont pas perdues).
  if (d.prepare('SELECT COUNT(*) AS c FROM module_teachers').get().c === 0) {
    const legacy = d.prepare('SELECT id, teacher_id, semester, academic_year, hours FROM modules WHERE teacher_id IS NOT NULL').all();
    if (legacy.length) {
      const ins = d.prepare("INSERT INTO module_teachers (module_id, teacher_id, academic_year, semester, hours, teaching_type, status) VALUES (?,?,?,?,?, 'COURS', 'ACTIVE')");
      for (const m of legacy) {
        try { ins.run(m.id, m.teacher_id, m.academic_year || '', m.semester || '', m.hours || 0); } catch (e) { /* ignore doublon */ }
      }
      console.log(`[seed] ${legacy.length} affectation(s) enseignant migrée(s) depuis modules.teacher_id`);
    }
  }

  // Catalogue complet des filières ISPITS : insertion idempotente des options
  // manquantes, puis rappel de la filière (et de l'intitulé si jamais customisé).
  const insOpt = d.prepare("INSERT INTO options (code, name, description, status, category) VALUES (?,?,?, 'ACTIVE', ?) ON CONFLICT(code) DO NOTHING");
  const setCat = d.prepare('UPDATE options SET category = ? WHERE code = ?');
  const setName = d.prepare('UPDATE options SET name = ? WHERE code = ? AND name = code');
  let added = 0;
  for (const [code, name, category] of OPTION_CATALOG) {
    const r = insOpt.run(code, name, `Filière ${category} — configurable par l’administration`, category);
    if (r.changes) added++;
    setCat.run(category, code);
    setName.run(name, code);
  }
  if (added) console.log(`[seed] ${added} option(s) ISPITS ajoutées (catalogue : ${OPTION_CATALOG.length} au total)`);

  const setCount = d.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
  if (setCount === 0) {
    const ins = d.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  }

  const adminCount = d.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
  if (adminCount === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@ispits.ma';
    const password = process.env.ADMIN_PASSWORD || 'Smartsalle@2026';
    d.prepare("INSERT INTO users (nom, prenom, email, password_hash, role, status, email_verified) VALUES (?,?,?,?, 'admin','active',1)")
      .run('Administration', 'ISPITS', email, hashSecret(password));
    console.log(`[seed] compte administration créé : ${email} / ${password}`);
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'initial-admin.txt'),
        `Compte administration SmartSalle ISPITS\nEmail : ${email}\nMot de passe : ${password}\nCréé le : ${todayStr()}\n`, 'utf8');
    } catch (e) { /* ignore */ }
  }
}

/* ---------- settings ---------- */
function getSettings() {
  const rows = get().prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setSettings(obj) {
  const d = get();
  const ins = d.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (!(k in DEFAULT_SETTINGS)) continue;
    ins.run(k, String(v));
  }
  return getSettings();
}

/* ---------- audit ---------- */
function audit(user, action, entityType, entityId, oldValue, newValue) {
  const u = user || {};
  try {
    get().prepare('INSERT INTO audit_log (user_id, user_label, action, entity_type, entity_id, old_value, new_value) VALUES (?,?,?,?,?,?,?)')
      .run(u.id || null, u.label || (u.email || 'système'), action, entityType || '', entityId === null || entityId === undefined ? null : String(entityId),
        oldValue === undefined || oldValue === null ? '' : JSON.stringify(oldValue).slice(0, 4000),
        newValue === undefined || newValue === null ? '' : JSON.stringify(newValue).slice(0, 4000));
  } catch (e) {
    console.error('[audit] ', e.message);
  }
}

module.exports = { open, get, getSettings, setSettings, audit, DEFAULT_SETTINGS, DB_PATH, DATA_DIR, ROOMS, OPTION_CATALOG, OPTION_CATEGORIES };
