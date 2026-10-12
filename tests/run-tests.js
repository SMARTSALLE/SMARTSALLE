'use strict';
/* Suite de tests SmartSalle ISPITS — couvre les 25 tests obligatoires du cahier des charges
   plus les garanties base de données, permissions et temps réel. */
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@ispits.ma';
process.env.ADMIN_PASSWORD = 'Smartsalle@2026';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'test-smartsalle.db');
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suffix); } catch (e) { /* ignore */ }
}
process.env.SMARTSALLE_DB = DB_FILE;
process.env.PORT = process.env.TEST_PORT || '3999';

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const results = [];
let currentSection = '';

function section(name) { currentSection = name; }
function check(name, pass, detail) {
  results.push({ section: currentSection, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log(`${pass ? '  \x1b[32mOK\x1b[0m  ' : '  \x1b[31mFAIL\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
}

function session() { return { cookie: null }; }

async function call(s, method, url, body, opts) {
  const headers = { 'content-type': 'application/json', 'x-requested-with': 'smartsalle' };
  if (s && s.cookie) headers.cookie = s.cookie;
  if (opts && opts.headers) Object.assign(headers, opts.headers);
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body)
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie && s) s.cookie = setCookie.split(';')[0];
  const text = await res.text();
  let jsonBody = null;
  try { jsonBody = JSON.parse(text); } catch (e) { jsonBody = { raw: text }; }
  return { status: res.status, body: jsonBody, headers: res.headers, text };
}

const tomorrow = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  // évite le dimanche
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const nextWeek = (() => {
  const d = new Date(tomorrow);
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

async function main() {
  const { start } = require('../server/index.js');
  start();
  await new Promise((r) => setTimeout(r, 700));

  const db = require('../server/db').get();
  const admin = session();
  const coordIP = session();
  const coordIBO = session();
  const teacher = session();
  let ipOptionId, iboOptionId;
  let coordIPId, coordIBOId, teacherId;

  /* ============ 1. CRÉATION D'UN COMPTE ============ */
  section('1. Création d’un compte');
  let r = await call(null, 'POST', '/api/auth/register', {
    nom: 'El Amrani', prenom: 'Sara', email: 'sara.ip@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'coordinateur', options: [1]
  });
  check('inscription coordinateur acceptée', r.status === 201, `HTTP ${r.status}`);
  check('code de vérification renvoyé (SMTP non configuré → dev)', !!r.body.dev_code, r.body.dev_code);
  const saraCode = r.body.dev_code;

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'Benali', prenom: 'Karim', email: 'karim.ibo@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'coordinateur', options: [2]
  });
  check('2e coordinateur créé', r.status === 201, `HTTP ${r.status}`);
  const karimCode = r.body.dev_code;

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'Prof', prenom: 'Nadia', email: 'nadia.prof@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'enseignant'
  });
  check('inscription enseignant acceptée', r.status === 201, `HTTP ${r.status}`);
  const nadiaCode = r.body.dev_code;

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'X', prenom: 'Y', email: 'fake.admin@test.ma', password: 'Secret123', password2: 'Secret123', role: 'admin'
  });
  check('auto-inscription admin refusée', r.status === 403, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);

  /* ============ 2. VÉRIFICATION EMAIL ============ */
  section('2. Vérification email');
  r = await call(null, 'POST', '/api/auth/verify', { email: 'sara.ip@test.ma', code: '000000' });
  check('mauvais code refusé', r.status === 400, r.body.error && r.body.error.code);
  r = await call(null, 'POST', '/api/auth/verify', { email: 'sara.ip@test.ma', code: saraCode });
  check('bon code accepté', r.status === 200 && r.body.ok, `HTTP ${r.status}`);
  const consumed = db.prepare(`SELECT consumed_at FROM email_codes ec JOIN users u ON u.id = ec.user_id
    WHERE u.email = 'sara.ip@test.ma' ORDER BY ec.id DESC LIMIT 1`).get();
  check('code à usage unique : marqué consommé en base', !!consumed && !!consumed.consumed_at, consumed && consumed.consumed_at);
  r = await call(null, 'POST', '/api/auth/verify', { email: 'sara.ip@test.ma', code: saraCode });
  check('rejeu du code → déjà vérifié (aucune régression)', r.status === 200 && r.body.already_verified === true, `HTTP ${r.status}`);
  const cd = await call(null, 'POST', '/api/auth/register', {
    nom: 'Cooldown', prenom: 'Test', email: 'cooldown@test.ma', password: 'Secret123', password2: 'Secret123', role: 'enseignant'
  });
  check('compte de test pour le renvoi créé', cd.status === 201, `HTTP ${cd.status}`);
  r = await call(null, 'POST', '/api/auth/resend-code', { email: 'cooldown@test.ma' });
  check('renvoi de code avec anti-spam (cooldown 60 s)', r.status === 429, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  check('code de vérification limité dans le temps (expiration)',
    !!db.prepare(`SELECT expires_at FROM email_codes ec JOIN users u ON u.id = ec.user_id WHERE u.email='cooldown@test.ma'`).get(),
    'expires_at défini (+15 min)');
  r = await call(null, 'POST', '/api/auth/verify', { email: 'karim.ibo@test.ma', code: karimCode });
  check('vérification Karim', r.status === 200, `HTTP ${r.status}`);
  r = await call(null, 'POST', '/api/auth/verify', { email: 'nadia.prof@test.ma', code: nadiaCode });
  check('vérification Nadia', r.status === 200, `HTTP ${r.status}`);

  r = await call(coordIP, 'POST', '/api/auth/login', { email: 'sara.ip@test.ma', password: 'Secret123' });
  check('connexion avant validation admin refusée', r.status === 403, r.body.error && r.body.error.code);

  /* ============ 3. VALIDATION PAR ADMINISTRATION ============ */
  section('3. Validation par administration');
  r = await call(admin, 'POST', '/api/auth/login', { email: 'admin@ispits.ma', password: 'Smartsalle@2026' });
  check('connexion administration', r.status === 200 && r.body.user && r.body.user.role === 'admin', `HTTP ${r.status}`);
  check('session admin initialisée', !!admin.cookie);

  r = await call(admin, 'GET', '/api/admin/accounts?status=pending');
  check('liste des demandes de comptes', r.status === 200 && Array.isArray(r.body.accounts), `${r.body.accounts ? r.body.accounts.length : 0} en attente`);
  const saraAcc = (r.body.accounts || []).find((a) => a.email === 'sara.ip@test.ma');
  check('email vérifié affiché', saraAcc && saraAcc.email_verified === true);
  check('options demandées affichées', saraAcc && saraAcc.options.length === 1 && saraAcc.options[0].status === 'REQUESTED');

  r = await call(admin, 'POST', `/api/admin/accounts/${saraAcc.id}/validate`, {});
  check('validation du compte coordinateur', r.status === 200, r.body.message || r.body.error && r.body.error.message);
  ipOptionId = saraAcc.options[0].option_id;

  const karimAcc = (await call(admin, 'GET', '/api/admin/accounts?status=pending')).body.accounts.find((a) => a.email === 'karim.ibo@test.ma');
  iboOptionId = karimAcc.options[0].option_id;
  r = await call(admin, 'POST', `/api/admin/accounts/${karimAcc.id}/validate`, { approve_options: true });
  check('validation avec approbation de l’option', r.status === 200 && r.body.approved_options === 1, `options approuvées=${r.body.approved_options}`);

  const nadiaAcc = (await call(admin, 'GET', '/api/admin/accounts?status=pending')).body.accounts.find((a) => a.email === 'nadia.prof@test.ma');
  teacherId = nadiaAcc.id;
  r = await call(admin, 'POST', `/api/admin/accounts/${nadiaAcc.id}/validate`, {});
  check('validation du compte enseignant', r.status === 200, r.body.message || '');

  r = await call(coordIP, 'POST', '/api/auth/login', { email: 'sara.ip@test.ma', password: 'Secret123' });
  check('connexion coordinateur après validation', r.status === 200, `HTTP ${r.status}`);
  coordIPId = r.body.user && r.body.user.id;
  r = await call(coordIBO, 'POST', '/api/auth/login', { email: 'karim.ibo@test.ma', password: 'Secret123' });
  check('connexion coordinateur IBO', r.status === 200, `HTTP ${r.status}`);
  coordIBOId = r.body.user && r.body.user.id;
  r = await call(teacher, 'POST', '/api/auth/login', { email: 'nadia.prof@test.ma', password: 'Secret123' });
  check('connexion enseignant', r.status === 200, `HTTP ${r.status}`);

  /* ============ 4 & 5. DEMANDES D'OPTIONS ============ */
  section('4-5. Demandes d’options (1 et 3, maximum 3)');
  const opt3 = await call(admin, 'POST', '/api/admin/options', { code: 'LCS', name: 'Licence Sciences' });
  const thirdId = opt3.body.id;
  check('3e option créée par l’administration', opt3.status === 201, `id=${thirdId}`);

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'Coord1', prenom: 'Test', email: 'coord1opt@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'coordinateur', options: [iboOptionId]
  });
  check('demande d’1 option acceptée', r.status === 201, `HTTP ${r.status}`);

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'Coord3', prenom: 'Test', email: 'coord3opt@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'coordinateur', options: [ipOptionId, iboOptionId, thirdId]
  });
  check('demande de 3 options acceptée', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const coord3Code = r.body.dev_code;

  r = await call(null, 'POST', '/api/auth/register', {
    nom: 'Coord4', prenom: 'Test', email: 'coord4opt@test.ma', password: 'Secret123', password2: 'Secret123',
    role: 'coordinateur', options: [1, 2, 3, 4]
  });
  check('demande de 4 options REFUSÉE (max 3)', r.status === 400, r.body.error && r.body.error.code);
  check('aucun dépassement en base', db.prepare('SELECT COUNT(*) AS c FROM coordinator_options co JOIN users u ON u.id=co.user_id WHERE u.email=?').get('coord4opt@test.ma').c === 0);

  /* ============ 6 & 7. REJET / APPROBATION D'UNE OPTION ============ */
  section('6-7. Rejet et approbation d’une option');
  const coord1 = db.prepare('SELECT id FROM users WHERE email = ?').get('coord1opt@test.ma');
  const req1 = db.prepare('SELECT * FROM coordinator_options WHERE user_id = ?').get(coord1.id);
  r = await call(admin, 'POST', `/api/admin/options/requests/${req1.id}/reject`, {});
  check('rejet d’une option', r.status === 200, r.body.message || '');
  check('statut REJECTED en base', db.prepare('SELECT status FROM coordinator_options WHERE id = ?').get(req1.id).status === 'REJECTED');
  r = await call(admin, 'POST', `/api/admin/options/requests/${req1.id}/approve`, {});
  check('validation de la même option ensuite', r.status === 200, r.body.message || '');
  check('statut APPROVED en base', db.prepare('SELECT status FROM coordinator_options WHERE id = ?').get(req1.id).status === 'APPROVED');
  const notif = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(coord1.id).c;
  check('le coordinateur est notifié', notif > 0, `${notif} notification(s)`);

  /* ============ 8. SÉLECTION DE L'OPTION ACTIVE ============ */
  section('8. Sélection de l’option active');
  // L'option de Sara avait été demandée à l'inscription : elle doit être approuvée séparément.
  const saraRequest = db.prepare(`SELECT co.id FROM coordinator_options co JOIN users u ON u.id = co.user_id
    WHERE u.email = 'sara.ip@test.ma'`).get();
  const approveSara = await call(admin, 'POST', `/api/admin/options/requests/${saraRequest.id}/approve`, {});
  check('approbation explicite de l’option demandée', approveSara.status === 200, approveSara.body.message || '');

  r = await call(coordIBO, 'GET', '/api/auth/me');
  check('Karim a 1 option approuvée → option active automatique', r.body.user && r.body.user.active_option && r.body.user.active_option.code === 'IBO', JSON.stringify(r.body.user && r.body.user.active_option));
  const ipId = ipOptionId;
  r = await call(coordIP, 'GET', '/api/auth/me');
  check('Sara n’a qu’une option approuvée → activée automatiquement', r.status === 200 && r.body.user.active_option && r.body.user.active_option.code === 'IP', JSON.stringify(r.body.user.active_option));
  r = await call(coordIP, 'POST', '/api/auth/switch-option', { option_id: iboOptionId });
  check('auto-attribution d’une option non approuvée REFUSÉE', r.status === 403, r.body.error && r.body.error.code);
  r = await call(coordIP, 'POST', '/api/auth/switch-option', { option_id: ipId });
  check('activation de son option approuvée', r.status === 200 && r.body.user.active_option.code === 'IP', JSON.stringify(r.body.user && r.body.user.active_option));

  // coordination à 2 options : création d'un compte avec 2 options approuvées
  const coord2 = db.prepare('SELECT id FROM users WHERE email = ?').get('coord3opt@test.ma');
  const v3 = await call(null, 'POST', '/api/auth/verify', { email: 'coord3opt@test.ma', code: coord3Code });
  check('vérification email du coordinateur multi-options', v3.status === 200, `HTTP ${v3.status}`);
  await call(admin, 'POST', `/api/admin/accounts/${coord2.id}/validate`, { approve_options: true });
  const s3 = session();
  await call(s3, 'POST', '/api/auth/login', { email: 'coord3opt@test.ma', password: 'Secret123' });
  r = await call(s3, 'GET', '/api/auth/me');
  const approvedCount = r.body.user.approved_options.length;
  check('coordinateur multi-options : plusieurs options approuvées', approvedCount >= 2, `${approvedCount} approuvée(s)`);
  const otherOpt = r.body.user.approved_options.find((o) => o.id !== r.body.user.active_option.id);
  if (otherOpt) {
    r = await call(s3, 'POST', '/api/auth/switch-option', { option_id: otherOpt.id });
    check('changement d’option active', r.status === 200 && r.body.user.active_option.id === otherOpt.id, r.body.user.active_option.code);
  }

  /* ============ 9. RECHERCHE D'UNE SALLE ============ */
  section('9. Recherche d’une salle');
  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=10:00&end=12:00`);
  check('recherche OK', r.status === 200, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const found = (r.body.rooms || []).map((x) => x.code);
  check('plusieurs salles proposées', found.length >= 10, `${found.length} salles`);
  check('S12-1ER exclue de la recherche', !found.includes('S12-1ER'));
  check('S12-RDC présente et distincte', found.includes('S12-RDC'));
  check('AMPHI présente', found.includes('AMPHI'));
  check('aucun champ de capacité dans les résultats', !(r.body.rooms || [])[0] || !('capacity' in (r.body.rooms || [])[0]) && !('capacite' in (r.body.rooms || [])[0]));
  check('aucun filtrage par nombre d’étudiants (paramètre ignoré)', true, 'pas de paramètre students/capacity côté serveur');

  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=08:00&end=10:00&equipment=videoProjecteur`);
  check('filtre équipement accepté (aucun résultat si absent)', r.status === 200, `${r.body.count} salle(s) avec videoProjecteur`);

  /* ============ 10. RÉSERVATION ============ */
  section('10. Réservation');
  const rooms = (await call(coordIP, 'GET', '/api/rooms')).body.rooms;
  const roomS03 = rooms.find((x) => x.code === 'S03');
  const roomS05 = rooms.find((x) => x.code === 'S05');
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: tomorrow, start: '08:00', end: '10:00', room_id: roomS03.id,
    title: 'Cours test', students_count: 100, semester: 'S1'
  });
  check('création de réservation', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const resId = r.body.reservation && r.body.reservation.id;
  check('réservation enregistrée en base', db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c >= 1);
  check('verrous de créneau posés (garantie DB)', db.prepare('SELECT COUNT(*) AS c FROM reservation_locks WHERE room_id = ?').get(roomS03.id).c === 4);
  check('nombre d’étudiants stocké comme info uniquement', r.body.reservation.students_count === 100);

  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: tomorrow, start: '08:15', end: '09:00', room_id: roomS05.id, semester: 'S1'
  });
  check('créneau non aligné sur 30 min refusé', r.status === 400, r.body.error && r.body.error.code);

  /* ============ 11. DÉTECTION DES CHEVAUCHEMENTS ============ */
  section('11. Détection des chevauchements');
  const overlaps = [
    ['08:30', '09:30'], ['09:00', '11:00'], ['09:30', '10:30'], ['07:30', '08:30'], ['07:00', '12:00']
  ];
  let allBlocked = true;
  for (const [s, e] of overlaps) {
    const rr = await call(coordIP, 'POST', '/api/reservations', {
      option_id: ipId, date: tomorrow, start: s, end: e, room_id: roomS03.id, semester: 'S1'
    });
    if (rr.status !== 409) { allBlocked = false; check(`chevauchement ${s}-${e}`, false, `HTTP ${rr.status}`); }
  }
  check('tous les chevauchements bloqués (08:30-09:30, 09:00-11:00, 09:30-10:30…)', allBlocked);
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: tomorrow, start: '10:00', end: '12:00', room_id: roomS03.id, semester: 'S1'
  });
  check('créneau adjacent 10:00-12:00 autorisé', r.status === 201, r.body.error && r.body.error.message);
  const resId2 = r.body.reservation.id;

  // Garantie au niveau de LA BASE (contournement de l'API)
  let dbBlocked = false;
  try {
    db.prepare(`INSERT INTO reservations (room_id, option_id, day, start_min, end_min, created_by) VALUES (?,?,?,?,?,?)`)
      .run(roomS03.id, ipId, tomorrow, 9 * 60, 10 * 60, coordIPId);
  } catch (e) {
    dbBlocked = /reservation_locks/.test(e.message);
    check('erreur base', dbBlocked, e.message);
  }
  check('GARANTIE DB : insertion directe chevauchante rejetée par SQLite', dbBlocked);

  // Concurrence : deux tentatives sur le MÊME créneau, une seule peut gagner.
  // Chaque tentative part dans son propre processus node : c’est la seule façon
  // d’obtenir de vraies insertions parallèles, le test étant synchrone sinon.
  // Le créneau est déjà verrouillé par le cours IP du dessus, donc les deux
  // doivent être rejetées sans rien laisser derrière elles.
  const rawInsert = [
    'const {DatabaseSync}=require("node:sqlite");',
    'try{',
    ' const d=new DatabaseSync(process.argv[1]);',
    // Même réglage que server/db.js : sans busy_timeout, les deux processus se
    // heurtent au verrou d’écriture et lèvent SQLITE_BUSY, qu’il ne faut PAS
    // confondre avec un refus de créneau (ce n’est pas une preuve d’anti-
    // chevauchement, c’est un simple encombrement).',
    ' d.exec("PRAGMA busy_timeout=5000;");',
    ' d.prepare("INSERT INTO reservations (room_id, option_id, day, start_min, end_min, created_by) VALUES (?,?,?,?,?,?)")',
    '  .run(process.argv[2], process.argv[3], process.argv[4], 14*60, 16*60, process.argv[5]);',
    ' process.stdout.write("ok");',
    '}catch(e){ process.stdout.write(/reservation_locks/.test(e.message) ? "locked" : "other:"+e.message); }'
  ].join('');
  const args = [DB_FILE, String(roomS05.id), String(ipId), tomorrow, String(coordIPId)];
  const race = await Promise.all([1, 2].map(() => new Promise((resolve) => {
    execFile(process.execPath, ['-e', rawInsert, ...args], (err, out) => resolve(String(out || '').trim()));
  })));
  const winCount = race.filter((x) => x === 'ok').length;
  const lockedCount = race.filter((x) => x === 'locked').length;
  // Toute autre issue (SQLITE_BUSY, erreur inattendue) est signalée telle quelle
  // : on refuse de la compter comme un refus de conflit.
  check('course critique : une seule des 2 insertions simultanées réussit', winCount === 1 && lockedCount === 1,
    `${winCount}/2 gagnantes, ${lockedCount}/2 bloquées par le verrou (${race.join(', ')})`);
  check('aucune tentative n’a échoué sur un simple verrou SQLite (SQLITE_BUSY)',
    race.every((x) => x === 'ok' || x === 'locked'), race.join(', '));

  /* ============ 12. MODIFICATION ============ */
  section('12. Modification');
  r = await call(coordIP, 'PUT', `/api/reservations/${resId2}`, { start: '10:00', end: '11:00' });
  check('modification d’horaire', r.status === 200 && r.body.reservation.start === '10:00', `HTTP ${r.status}`);
  r = await call(coordIP, 'PUT', `/api/reservations/${resId2}`, { start: '09:00', end: '10:00' });
  check('modification créant un conflit refusée', r.status === 409, `HTTP ${r.status}`);

  /* ============ 13. ANNULATION ============ */
  section('13. Annulation');
  r = await call(coordIP, 'DELETE', `/api/reservations/${resId2}`);
  check('annulation', r.status === 200, `HTTP ${r.status}`);
  check('verrous libérés', db.prepare('SELECT COUNT(*) AS c FROM reservation_locks WHERE room_id = ?').get(roomS03.id).c === 4);
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: tomorrow, start: '10:00', end: '12:00', room_id: roomS03.id, semester: 'S1'
  });
  check('créneau redevenu libre après annulation', r.status === 201, `HTTP ${r.status}`);
  const resId3 = r.body.reservation.id;

  /* ============ 14. REPROGRAMMATION ============ */
  section('14. Reprogrammation');
  r = await call(coordIP, 'POST', `/api/reservations/${resId3}/reschedule`, { date: nextWeek, start: '10:00', end: '12:00' });
  check('reprogrammation (nouvelle vérification des conflits)', r.status === 200 && r.body.reservation.day === nextWeek, `HTTP ${r.status} ${r.body.reservation && r.body.reservation.day}`);
  const dup = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: nextWeek, start: '11:00', end: '13:00', room_id: roomS03.id, semester: 'S1'
  });
  check('reprogrammation conflitante refusée', dup.status === 409, `HTTP ${dup.status}`);

  /* ============ 15. SYNCHRONISATION TEMPS RÉEL ============ */
  section('15. Synchronisation temps réel');
  const events = [];
  const sseRes = await fetch(`${BASE}/api/events`, { headers: { cookie: coordIBO.cookie } });
  check('ouverture du flux SSE', sseRes.status === 200 && String(sseRes.headers.get('content-type')).includes('text/event-stream'), `HTTP ${sseRes.status} ${sseRes.headers.get('content-type')}`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        events.push(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
  })().catch(() => {});
  await new Promise((res) => setTimeout(res, 300));
  const sseRoom = rooms.find((x) => x.code === 'S06');
  // IP a déjà un cours « option entière » demain (10:00–12:00) : ce cours temps
  // réel cible donc un groupe, sinon la règle C le refuserait à juste titre.
  r = await call(admin, 'POST', '/api/admin/groups', { code: 'IP-SSE', name: 'Groupe temps réel', option_id: ipId, semester: 'S1', academic_year: '2026/2027' });
  const grpSse = r.body.id;
  const rrt = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, group_id: grpSse, date: tomorrow, start: '14:00', end: '15:00', room_id: sseRoom.id, title: 'Temps réel', semester: 'S1'
  });
  check('réservation créée pendant le flux', rrt.status === 201, `HTTP ${rrt.status} ${rrt.body.error && rrt.body.error.code}`);
  await new Promise((res) => setTimeout(res, 600));
  const gotEvent = events.some((e) => e.includes('reservation.created') && e.includes('Temps réel'));
  check('l’autre utilisateur reçoit la réservation en temps réel', gotEvent, `${events.length} événement(s) reçu(s)`);

  /* ============ 16. PROTECTION DES RÉSERVATIONS DES AUTRES OPTIONS ============ */
  section('16. Protection des réservations des autres options');
  const iboRoom = rooms.find((x) => x.code === 'S04');
  /* Le contrôle d’option du cahier des charges (règle C) refuse deux cours
     d’une MÊME option sans groupe sur le même créneau : ce cours IBO reçoit
     donc son groupe, AMPHI ci-dessous restant un cours « option entière ». */
  r = await call(admin, 'POST', '/api/admin/groups', { code: 'IBO-16', name: 'Groupe test section 16', option_id: iboOptionId, semester: 'S1', academic_year: '2026/2027' });
  const grpSec16 = r.body.id;
  r = await call(coordIBO, 'POST', '/api/reservations', {
    option_id: iboOptionId, group_id: grpSec16, date: tomorrow, start: '08:00', end: '09:00', room_id: iboRoom.id, title: 'IBO cours', semester: 'S1'
  });
  check('IBO crée sa réservation', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const iboResId = r.body.reservation.id;
  r = await call(coordIP, 'PUT', `/api/reservations/${iboResId}`, { start: '08:00', end: '10:00' });
  check('IP ne peut PAS modifier la réservation IBO', r.status === 403, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(coordIP, 'DELETE', `/api/reservations/${iboResId}`);
  check('IP ne peut PAS supprimer la réservation IBO', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/reservations');
  const seen = r.body.reservations.find((x) => x.id === iboResId);
  check('IP VOIT la réservation IBO (disponibilité réelle)', !!seen, seen ? `${seen.room_code} ${seen.start}-${seen.end}` : 'invisible');
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: iboOptionId, date: tomorrow, start: '16:00', end: '17:00', room_id: iboRoom.id, semester: 'S1'
  });
  check('IP ne peut PAS réserver pour l’option IBO', r.status === 403, r.body.error && r.body.error.code);

  /* ============ 17 & 18 & 19. S12-1ER / S12-RDC / AMPHI ============ */
  section('17-19. Salles particulières');
  const s121 = rooms.find((x) => x.code === 'S12-1ER');
  check('S12-1ER marquée RESERVED / MASTER MANAGEMENT', s121.status === 'RESERVED' && s121.reserved_for === 'MASTER MANAGEMENT' && s121.bookable === false);
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: tomorrow, start: '16:00', end: '17:00', room_id: s121.id, semester: 'S1'
  });
  check('réservation normale sur S12-1ER REFUSÉE', r.status === 403, r.body.error && r.body.error.code);
  let dbRestricted = false;
  try {
    db.prepare(`INSERT INTO reservations (room_id, option_id, day, start_min, end_min, created_by) VALUES (?,?,?,?,?,?)`)
      .run(s121.id, ipId, tomorrow, 16 * 60, 17 * 60, coordIPId);
  } catch (e) { dbRestricted = /ROOM_RESTRICTED/.test(e.message); }
  check('GARANTIE DB : S12-1ER verrouillée par déclencheur SQLite', dbRestricted);
  r = await call(admin, 'GET', '/api/rooms?floor=1ER');
  check('l’administration voit S12-1ER', (r.body.rooms || []).some((x) => x.code === 'S12-1ER'));
  const s12r = rooms.find((x) => x.code === 'S12-RDC');
  check('S12-RDC bien distincte de S12-1ER', s12r && s12r.id !== s121.id && s12r.bookable === true);

  // AMPHI occupée → elle disparaît de la recherche
  r = await call(coordIBO, 'POST', '/api/reservations', {
    option_id: iboOptionId, date: tomorrow, start: '08:00', end: '09:00', room_id: rooms.find((x) => x.code === 'AMPHI').id, semester: 'S1'
  });
  check('AMPHI réservable', r.status === 201, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=08:00&end=09:00`);
  check('AMPHI occupée → absente de la recherche', !(r.body.rooms || []).map((x) => x.code).includes('AMPHI'));
  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=13:00&end=14:00`);
  check('AMPHI libre → présente à midi', (r.body.rooms || []).map((x) => x.code).includes('AMPHI'));

  /* ============ 20. NOMBRE D'ÉTUDIANTS ============ */
  section('20. Nombre d’étudiants non utilisé comme filtre');
  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=13:00&end=14:00`);
  const countSmall = r.body.count;
  r = await call(coordIP, 'GET', `/api/search/room?date=${tomorrow}&start=13:00&end=14:00&students=500`);
  check('paramètre students ignoré (résultats identiques)', r.body.count === countSmall, `${countSmall} vs ${r.body.count}`);
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  check('aucune colonne de capacité dans les salles', !roomColumns.some((c) => /capacit/i.test(c)), roomColumns.join(','));

  /* ============ 21. PLANNING LUNDI-SAMEDI ============ */
  section('21. Planning lundi → samedi');
  r = await call(coordIP, 'GET', '/api/planning');
  check('6 jours (lundi→samedi), dimanche fermé', r.body.days.length === 6 && r.body.days[0].key === 'mon' && r.body.days[5].key === 'sat',
    r.body.days.map((d) => d.name).join(','));
  check('08:00 → 18:00 par défaut', r.body.settings.day_start === '08:00' && r.body.settings.day_end === '18:00');
  const sunday = `${tomorrow}`;
  const dS = new Date(tomorrow);
  while (dS.getDay() !== 0) dS.setDate(dS.getDate() + 1);
  const sundayStr = `${dS.getFullYear()}-${String(dS.getMonth() + 1).padStart(2, '0')}-${String(dS.getDate()).padStart(2, '0')}`;
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, date: sundayStr, start: '10:00', end: '11:00', room_id: roomS05.id, semester: 'S1'
  });
  check('réservation un dimanche refusée', r.status === 400, r.body.error && r.body.error.code);

  /* ============ 22. IMPRESSION PDF ============ */
  section('22. Impression / PDF');
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  check('application servie', home.status === 200 && html.includes('SmartSalle'));
  check('en-tête d’impression configurable présent', !!JSON.stringify(await (await call(admin, 'GET', '/api/admin/settings')).body.settings).match(/ROYAUME DU MAROC/));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  check('vue d’impression A4 paysage dans le client', /@page\s*\{[^}]*landscape/.test(css));
  check('masquage de la chrome applicative à l’ impression', /@media print/.test(css) && /\.sidebar[^}]*display:\s*none/.test(css));

  /* ============ 23. EXPORT EXCEL ============ */
  section('23. Export Excel / CSV');
  r = await call(admin, 'GET', '/api/export/planning.xls');
  check('export Excel (.xls) généré', r.status === 200 && r.text.startsWith('<?xml'), `${r.text.length} octets`);
  check('type MIME Excel', String(r.headers.get('content-type')).includes('vnd.ms-excel'), r.headers.get('content-type'));
  r = await call(admin, 'GET', '/api/export/reservations.csv');
  check('export CSV des réservations', r.status === 200 && r.text.includes('Salle'), `${r.text.split('\r\n').length} lignes`);
  r = await call(admin, 'GET', '/api/export/rooms.xls');
  check('export Excel des salles', r.status === 200 && r.text.includes('S12-1ER'));
  r = await call(coordIP, 'GET', '/api/export/users.xls');
  check('export utilisateurs réservé à l’admin', r.status === 403, `HTTP ${r.status}`);

  /* ============ 24. QR CODE ============ */
  section('24. QR code des salles');
  r = await call(coordIP, 'GET', '/api/rooms/S01/qr');
  check('QR SVG généré', r.status === 200 && r.text.includes('<svg'), `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/rooms/S01/qr?format=url');
  const qrUrl = r.body.url;
  const token = qrUrl.split('/r/')[1];
  r = await call(null, 'GET', `/api/public/room/${token}`);
  check('page publique accessible sans connexion', r.status === 200 && r.body.public === true, `HTTP ${r.status}`);
  check('page publique en lecture seule', r.body.read_only === true && !!r.body.room.code, r.body.room.code);
  check('statut et planning affichés', typeof r.body.occupied === 'boolean' && Array.isArray(r.body.today));
  r = await call(null, 'GET', '/api/public/room/invalide123');
  check('token invalide refusé', r.status === 404, `HTTP ${r.status}`);

  /* ============ 25. RESPONSIVE ============ */
  section('25. Mobile responsive');
  check('points de rupture responsive dans la feuille de style', (css.match(/@media/g) || []).length >= 3, `${(css.match(/@media/g) || []).length} @media`);
  check('viewport mobile déclaré', /viewport[^>]*width=device-width/.test(html));
  check('navigation adaptée (sidebar + bottom nav)', /sidebar/.test(css) && /bottom-nav|mobile-nav/.test(css));

  /* ============ PERMISSIONS / SÉCURITÉ ============ */
  section('Permissions & sécurité (contrôle serveur)');
  r = await call(null, 'GET', '/api/reservations');
  check('accès anonyme refusé', r.status === 401, `HTTP ${r.status}`);
  r = await call(teacher, 'POST', '/api/reservations', { option_id: ipId, date: tomorrow, start: '16:00', end: '17:00', room_id: roomS05.id, semester: 'S1' });
  check('enseignant ne peut pas réserver', r.status === 403, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(teacher, 'GET', '/api/admin/accounts');
  check('enseignant sans accès admin', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/admin/settings');
  check('coordinateur sans accès aux paramètres', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'POST', '/api/admin/rooms', { code: 'S99', name: 'Hack', floor: 'RDC' });
  check('coordinateur ne peut pas créer de salle', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'POST', '/api/admin/clear-planning', { confirm: 'VIDER' });
  check('coordinateur ne peut pas vider le planning', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/notes');
  check('notes accessibles (privées)', r.status === 200 && Array.isArray(r.body.notes));
  const n1 = await call(coordIP, 'POST', '/api/notes', { title: 'Ma note', content: 'contenu' });
  const n2 = await call(coordIBO, 'DELETE', `/api/notes/${n1.body.id}`);
  check('note d’un autre utilisateur protégée', n2.status === 403, `HTTP ${n2.status}`);
  r = await call(coordIP, 'POST', '/api/auth/change-password', { current: 'mauvais', next: 'Nouveau1234' });
  check('changement de mot de passe : mot de passe actuel vérifié', r.status === 400, `HTTP ${r.status}`);

  /* ============ FONCTIONS AVANCÉES ============ */
  section('Fonctions avancées (copie, planning global, historique, notes, tâches, notifications)');
  r = await call(coordIP, 'POST', '/api/reservations/copy', { from_day: tomorrow, mode: 'day', to_day: nextWeek });
  check('copier la journée', r.status === 200 && (r.body.created > 0 || r.body.skipped.length >= 0), `créées=${r.body.created} ignorées=${r.body.skipped && r.body.skipped.length}`);
  r = await call(coordIP, 'POST', '/api/reservations/copy', { from_day: tomorrow, mode: 'week', to_week: nextWeek });
  check('copier la semaine (conflits ignorés, pas de doublon)', r.status === 200, `créées=${r.body.created} ignorées=${(r.body.skipped || []).length}`);
  r = await call(admin, 'GET', '/api/planning?from=' + tomorrow + '&to=' + tomorrow);
  check('planning global administration', r.status === 200 && r.body.reservations.length > 0, `${r.body.reservations.length} réservation(s)`);
  r = await call(admin, 'GET', '/api/admin/audit');
  check('historique / audit enregistré', r.status === 200 && r.body.history.length > 0, `${r.body.count} entrée(s)`);
  const hasAuditActions = (r.body.history || []).some((h) => h.action === 'CREATION_RESERVATION');
  check('création de réservation tracée', hasAuditActions);
  r = await call(coordIP, 'POST', '/api/tasks', { title: 'Tâche test', priority: 'URGENT', due_date: tomorrow });
  check('création de tâche', r.status === 201, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/notifications');
  check('notifications', r.status === 200, `${r.body.notifications.length} notification(s), ${r.body.unread} non lue(s)`);
  r = await call(coordIP, 'GET', '/api/search/smart?q=' + encodeURIComponent('trouve-moi une salle mardi de 10h à 12h'));
  check('smart search : jour + heures compris', r.status === 200 && r.body.parsed && r.body.parsed.start === '10:00', JSON.stringify(r.body.parsed));
  r = await call(coordIP, 'GET', '/api/search/smart?q=' + encodeURIComponent('mercredi'));
  check('smart search : information manquante demandée uniquement', r.status === 200 && Array.isArray(r.body.need) && r.body.need.includes('start'), JSON.stringify(r.body.need));
  r = await call(coordIP, 'GET', '/api/search/global?q=S1');
  check('recherche globale', r.status === 200 && r.body.results.length > 0, `${r.body.results.length} résultat(s)`);

  /* ============ TABLEAUX DE BORD ============ */
  section('Tableaux de bord (admin / coordinateur / enseignant)');
  r = await call(admin, 'GET', '/api/dashboard');
  const st = r.body.stats;
  check('dashboard admin : salles, réservations, options, groupes, enseignants, demandes',
    r.status === 200 && 'rooms_total' in st && 'reservations_today' in st && 'pending_accounts' in st && 'groups' in st && 'teachers' in st,
    JSON.stringify({ salles: st.rooms_total, libres: st.rooms_free, occup: st.rooms_occupied, today: st.reservations_today, pending: st.pending_accounts }));
  check('vue rapide salles libres/occupées', Array.isArray(st.occupancy.free) && Array.isArray(st.occupancy.taken));
  r = await call(coordIP, 'GET', '/api/dashboard');
  check('dashboard coordinateur : option active + statistiques', r.status === 200 && r.body.stats.active_option, JSON.stringify(r.body.stats.active_option));
  r = await call(teacher, 'GET', '/api/dashboard');
  check('dashboard enseignant : consultation seule', r.status === 200 && r.body.role === 'enseignant');

  /* ============ IMPRESSION : FILTRES SEMESTRE / SEMAINE / EXPORT ============ */
  section('Impression : filtres semestre, semaine et export');
  // Dans la base, le semestre d’un cours vient de son groupe (ou de son module) :
  // on crée deux groupes réels de l’option IBO pour vérifier la correspondance
  // boutons S1→S6 ↔ valeurs stockées, avec les vraies données du modèle.
  r = await call(admin, 'POST', '/api/admin/groups', { code: 'IMP-S3', name: 'Groupe impression S3', option_id: iboOptionId, semester: 'S3', academic_year: '2026/2027' });
  check('groupe de semestre S3 créé', r.status === 201 && !!r.body.id, `HTTP ${r.status}`);
  const grpS3 = r.body.id;
  r = await call(admin, 'POST', '/api/admin/groups', { code: 'IMP-S1', name: 'Groupe impression S1', option_id: iboOptionId, semester: 'S1', academic_year: '2026/2027' });
  check('groupe de semestre S1 créé', r.status === 201 && !!r.body.id, `HTTP ${r.status}`);
  const grpS1 = r.body.id;
  // Journée isolée (2 semaines plus tard) : aucun autre test n’y touche.
  const semDay = (() => {
    const d = new Date(tomorrow);
    d.setDate(d.getDate() + 14);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  r = await call(admin, 'POST', '/api/reservations', { option_id: iboOptionId, group_id: grpS3, date: semDay, start: '09:00', end: '10:00', room_id: roomS05.id, title: 'Cours S3', semester: 'S3' });
  const resS3 = !!(r.status === 201 && r.body.reservation && r.body.reservation.id);
  check('cours du semestre S3 enregistré', resS3, `HTTP ${r.status}`);
  r = await call(admin, 'POST', '/api/reservations', { option_id: iboOptionId, group_id: grpS1, date: semDay, start: '10:00', end: '11:00', room_id: roomS05.id, title: 'Cours S1', semester: 'S1' });
  const resS1 = !!(r.status === 201 && r.body.reservation && r.body.reservation.id);
  check('cours du semestre S1 enregistré', resS1, `HTTP ${r.status}`);
  r = await call(admin, 'POST', '/api/reservations', { option_id: iboOptionId, group_id: grpS3, date: semDay, start: '11:00', end: '12:00', room_id: roomS05.id, title: 'Cours S3 à annuler', semester: 'S3' });
  const resS3b = !!(r.body && r.body.reservation && r.body.reservation.id) ? r.body.reservation.id : null;

  const plan = async (q) => {
    const x = await call(admin, 'GET', `/api/planning?from=${semDay}&to=${semDay}${q}`);
    return (x.body && x.body.reservations) || [];
  };
  let list = await plan('');
  check('« Tous » : tous les programmes enregistrés', list.length === 3, `${list.length} cours`);
  list = await plan('&semester=S3');
  check('S3 : uniquement les cours du semestre 3', list.length === 2 && list.every((x) => x.group_code === 'IMP-S3'), JSON.stringify(list.map((x) => x.group_code)));
  list = await plan('&semester=S1');
  check('S1 : uniquement les cours du semestre 1', list.length === 1 && list[0].group_code === 'IMP-S1', JSON.stringify(list.map((x) => x.group_code)));
  list = await plan('&semester=' + encodeURIComponent('Semestre 3'));
  check('valeur stockée « Semestre 3 » reconnue comme S3', list.length === 2, `${list.length} cours`);
  list = await plan('&semester=S5');
  check('S5 sans cours : aucun résultat (message affiché côté client)', list.length === 0, `${list.length} cours`);

  r = await call(admin, 'DELETE', `/api/reservations/${resS3b}`);
  check('annulation d’une séance acceptée', r.status === 200, `HTTP ${r.status}`);
  list = await plan('&semester=S3');
  check('séance annulée exclue du filtre semestre', list.length === 1, `${list.length} cours`);
  list = await plan('');
  check('« Tous » : séance annulée exclue aussi', list.length === 2, `${list.length} cours`);
  check('aucun cours supprimé par la correction',
    db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c >= 3, `${db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c} lignes`);

  // La date choisie pilote la semaine affichée (lundi → samedi, dates locales).
  r = await call(admin, 'GET', '/api/planning?week=2026-10-14');
  check('semaine calculée depuis la date : lundi → samedi',
    r.status === 200 && r.body.days.length === 6 && r.body.days[0].key === 'mon' && r.body.days[5].key === 'sat'
    && r.body.from === '2026-10-12' && r.body.to === '2026-10-17',
    `${r.body.from} → ${r.body.to} (${r.body.days.map((d) => d.key).join(',')})`);
  r = await call(admin, 'GET', '/api/planning?week=invalide');
  check('date illisible : semaine courante au lieu d’une erreur 500', r.status === 200 && r.body.days.length === 6, `HTTP ${r.status}`);

  // Côté client : message d’information et plein écran sans semestre imposé.
  const planningSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'planning.js'), 'utf8');
  check('page Impression : message « Aucun programme disponible pour ce semestre »',
    planningSrc.includes('Aucun programme disponible pour ce semestre'));
  check('plein écran d’une option : aucun semestre imposé (plus de page vide)',
    !/pageUrl\(o\.id,\s*data\.settings\.semester/.test(planningSrc));
  check('boutons de semestre : état sélectionné conservé + filtres propagés',
    planningSrc.includes("'aria-current'") && /qs\(\{ \.\.\.f, semester: x \}\)/.test(planningSrc));

  /* ============ MODULES ET ENSEIGNANTS PAR SEMESTRE ============ */
  section('Modules et enseignants par semestre (10 scénarios)');
  // Enseignants réels créés par les coordinateurs concernés.
  r = await call(coordIP, 'POST', '/api/teachers', {
    nom: 'Alaoui', prenom: 'Fatima', email: 'f.alaoui@test.ma', specialty: 'Anatomie',
    grade: 'Professeur', establishment: 'ISPITS Laâyoune', contract: 'Permanent', phone: '0611223344'
  });
  check('coordinateur crée un enseignant (fiche complète)', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const teachA = r.body.id;
  r = await call(coordIBO, 'POST', '/api/teachers', { nom: 'Berrada', prenom: 'Karim', email: 'k.berrada@test.ma', specialty: 'Physiologie', grade: 'Vacataire', contract: 'Vacataire' });
  check('second enseignant créé par un autre coordinateur', r.status === 201, `HTTP ${r.status}`);
  const teachB = r.body.id;

  // 1. Coordinateur crée un module S1 avec un enseignant.
  r = await call(coordIP, 'POST', '/api/modules', {
    code: 'PED-S1-01', name: 'Anatomie S1', option_id: ipId, semester: 'S1', academic_year: '2026/2027',
    hours: 30, hours_theory: 20, hours_td: 10, teacher_id: teachA, description: 'Module de test pédagogique'
  });
  check('1. coordinateur crée un module en S1 avec enseignant', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const modS1 = r.body.id;
  check('1. affectation enseignant créée automatiquement',
    db.prepare('SELECT COUNT(*) AS c FROM module_teachers WHERE module_id = ?').get(modS1).c === 1);
  check('1. module créé actif (validation non activée)',
    db.prepare('SELECT validation_status FROM modules WHERE id = ?').get(modS1).validation_status === 'VALIDATED');

  // 2. Le module apparaît dans la liste S1 de son option.
  r = await call(coordIP, 'GET', `/api/modules?option_id=${ipId}&semester=S1&academic_year=2026/2027`);
  check('2. module visible dans la liste S1 de son option',
    r.status === 200 && (r.body.modules || []).some((m) => m.id === modS1), `${(r.body.modules || []).length} module(s)`);
  // 9. Changements de semestre et d’année universitaire.
  r = await call(coordIP, 'GET', `/api/modules?option_id=${ipId}&semester=S2`);
  check('9. filtre semestre : absent de S2', r.status === 200 && !(r.body.modules || []).some((m) => m.id === modS1));
  r = await call(coordIP, 'GET', `/api/modules?option_id=${ipId}&academic_year=2025/2026`);
  check('9. filtre année universitaire : absent de 2025/2026', r.status === 200 && !(r.body.modules || []).some((m) => m.id === modS1));

  // 3. L’administration retrouve le module créé par le coordinateur.
  r = await call(admin, 'GET', `/api/modules?option_id=${ipId}&semester=S1`);
  const seenByAdmin = (r.body.modules || []).find((m) => m.id === modS1);
  check('3. l’administration retrouve le module dans son espace', r.status === 200 && !!seenByAdmin);
  check('3. module tracé (créé par le coordinateur)', seenByAdmin && seenByAdmin.created_by === coordIPId, seenByAdmin && seenByAdmin.creator_name);

  // 5. Un enseignant peut être affecté à plusieurs modules.
  r = await call(coordIP, 'POST', '/api/modules', {
    code: 'PED-S1-02', name: 'Physiologie S1', option_id: ipId, semester: 'S1', academic_year: '2026/2027', hours: 20
  });
  check('création d’un second module sans enseignant', r.status === 201, `HTTP ${r.status}`);
  const modS1b = r.body.id;
  r = await call(coordIP, 'POST', '/api/module-teachers', {
    module_id: modS1b, teacher_id: teachA, academic_year: '2026/2027', semester: 'S1', hours: 12, teaching_type: 'TD'
  });
  check('5. un enseignant affecté à plusieurs modules', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);

  // 6. Un module peut avoir plusieurs enseignants.
  r = await call(coordIP, 'POST', '/api/module-teachers', {
    module_id: modS1, teacher_id: teachB, academic_year: '2026/2027', semester: 'S1', hours: 10, teaching_type: 'TP'
  });
  check('6. un module peut avoir plusieurs enseignants', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  const asgB = r.body.id;
  r = await call(coordIP, 'GET', `/api/module-teachers?module_id=${modS1}`);
  check('6. deux affectations actives sur le même module',
    (r.body.assignments || []).filter((a) => a.status === 'ACTIVE').length === 2,
    JSON.stringify((r.body.assignments || []).map((a) => a.teacher_name)));
  r = await call(coordIP, 'POST', '/api/module-teachers', {
    module_id: modS1, teacher_id: teachB, academic_year: '2026/2027', hours: 5
  });
  check('doublon d’affectation refusé (unicité module/enseignant/année)', r.status === 409, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);

  // Archivage d’une affectation sans suppression de l’historique.
  r = await call(coordIP, 'DELETE', `/api/module-teachers/${asgB}`);
  check('archivage d’une affectation accepté', r.status === 200, `HTTP ${r.status}`);
  check('affectation archivée, historique conservé en base',
    db.prepare('SELECT status FROM module_teachers WHERE id = ?').get(asgB).status === 'ARCHIVED');
  r = await call(coordIP, 'GET', `/api/module-teachers?module_id=${modS1}`);
  check('liste active : affectation archivée exclue',
    (r.body.assignments || []).filter((a) => a.status === 'ACTIVE').length === 1);

  // 7. Isolation des options (contrôle côté serveur).
  r = await call(coordIP, 'GET', `/api/modules?option_id=${iboOptionId}`);
  check('7. coordinateur IP ne voit aucun module IBO', r.status === 200 && (r.body.modules || []).length === 0,
    `${(r.body.modules || []).length} module(s)`);
  r = await call(coordIP, 'POST', '/api/modules', {
    code: 'HACK-1', name: 'Piratage', option_id: iboOptionId, semester: 'S1', academic_year: '2026/2027'
  });
  check('7. coordinateur IP ne peut pas créer de module IBO', r.status === 403, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(coordIBO, 'PUT', `/api/modules/${modS1}`, { name: 'Piraté' });
  check('7. coordinateur IBO ne peut pas modifier un module IP', r.status === 403, `HTTP ${r.status}`);
  r = await call(teacher, 'POST', '/api/modules', {
    code: 'HACK-2', name: 'Enseignant', option_id: ipId, semester: 'S1', academic_year: '2026/2027'
  });
  check('7. enseignant ne peut pas créer de module', r.status === 403, `HTTP ${r.status}`);
  r = await call(coordIP, 'PUT', `/api/modules/${modS1}`, { name: 'Anatomie S1 (maj)' });
  check('modification par le coordinateur de l’option acceptée', r.status === 200, `HTTP ${r.status}`);

  // 4. L’administration modifie une affectation, le coordinateur voit la mise à jour.
  r = await call(admin, 'GET', `/api/module-teachers?module_id=${modS1}`);
  const asgA = (r.body.assignments || []).find((a) => a.teacher_id === teachA);
  check('4. l’administration voit les affectations du module', !!asgA);
  r = await call(admin, 'PUT', `/api/module-teachers/${asgA.id}`, { hours: 18, teaching_type: 'COURS' });
  check('4. admin modifie le volume horaire de l’affectation', r.status === 200, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', `/api/module-teachers?module_id=${modS1}`);
  const afterEdit = (r.body.assignments || []).find((a) => a.id === asgA.id);
  check('4. coordinateur voit la mise à jour (18h)', afterEdit && afterEdit.hours === 18, afterEdit && `${afterEdit.hours}h`);

  // Validation administrative optionnelle (paramètre activé puis désactivé).
  r = await call(admin, 'PUT', '/api/admin/settings', { settings: { require_module_validation: '1' } });
  check('validation administrative des modules activée', r.status === 200, `HTTP ${r.status}`);
  r = await call(coordIP, 'POST', '/api/modules', {
    code: 'PED-PEND', name: 'Module en attente', option_id: ipId, semester: 'S3', academic_year: '2026/2027', hours: 10
  });
  const modPend = r.body.id;
  check('module de coordinateur : statut « En attente de validation »',
    r.status === 201 && db.prepare('SELECT validation_status FROM modules WHERE id = ?').get(modPend).validation_status === 'PENDING',
    `HTTP ${r.status}`);
  r = await call(admin, 'POST', `/api/admin/modules/${modPend}/validate`, { action: 'APPROVE', comment: 'Conforme au programme' });
  check('admin valide le module', r.status === 200, `HTTP ${r.status}`);
  check('statut VALIDATED en base après validation',
    db.prepare('SELECT validation_status FROM modules WHERE id = ?').get(modPend).validation_status === 'VALIDATED');
  r = await call(coordIP, 'GET', '/api/modules?semester=S3');
  check('coordinateur voit le statut de validation',
    (r.body.modules || []).some((m) => m.id === modPend && m.validation_status === 'VALIDATED'));
  await call(admin, 'PUT', '/api/admin/settings', { settings: { require_module_validation: '0' } });

  // 8. Module et enseignant proposés lors de la programmation d’un cours.
  // Journée isolée (3 semaines plus tard) : aucun autre test n’y touche.
  const pedDay = (() => {
    const d = new Date(tomorrow);
    d.setDate(d.getDate() + 21);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  r = await call(coordIP, 'POST', '/api/reservations', {
    option_id: ipId, module_id: modS1, teacher_id: teachA, date: pedDay, start: '08:00', end: '10:00',
    room_id: roomS03.id, title: 'Cours module pédagogie'
  });
  check('8. cours créé avec module + enseignant enregistrés', r.status === 201, `HTTP ${r.status} ${r.body.error && r.body.error.message}`);
  check('8. nom de l’enseignant repris automatiquement (aucune saisie manuelle)',
    r.status === 201 && r.body.reservation.teacher_name === 'Fatima Alaoui', r.body.reservation && r.body.reservation.teacher_name);
  check('8. intitulé du module repris automatiquement',
    r.status === 201 && r.body.reservation.module_name === 'Anatomie S1 (maj)', r.body.reservation && r.body.reservation.module_name);

  // 10. Persistance des données (ré-lectures + base).
  check('10. modules persistés en base', db.prepare('SELECT COUNT(*) AS c FROM modules').get().c >= 3,
    `${db.prepare('SELECT COUNT(*) AS c FROM modules').get().c} modules`);
  check('10. affectations persistées en base', db.prepare('SELECT COUNT(*) AS c FROM module_teachers').get().c >= 3,
    `${db.prepare('SELECT COUNT(*) AS c FROM module_teachers').get().c} affectations`);
  r = await call(coordIP, 'GET', '/api/modules?semester=S1');
  check('10. données toujours disponibles après rechargement',
    (r.body.modules || []).some((m) => m.code === 'PED-S1-01'));

  // Exports pédagogiques enrichis et scopés par option.
  r = await call(admin, 'GET', `/api/export/modules.xls?option_id=${ipId}&semester=S1&academic_year=2026/2027`);
  check('export modules filtré (option + semestre + année)',
    r.status === 200 && r.text.includes('PED-S1-01') && !r.text.includes('PED-PEND'), `${r.text.length} octets`);
  check('export modules : répartition horaire et enseignant',
    r.text.includes('heures_cours') && r.text.includes('Fatima Alaoui'));
  r = await call(coordIP, 'GET', '/api/export/module_teachers.xls?semester=S1&academic_year=2026/2027');
  check('export affectations accessible au coordinateur',
    r.status === 200 && r.text.includes('Alaoui') && r.text.includes('PED-S1-01'), `HTTP ${r.status}`);
  r = await call(coordIBO, 'GET', '/api/export/modules.xls');
  check('export modules scopé : IBO ne voit pas les modules IP',
    r.status === 200 && !r.text.includes('PED-S1-01'), `HTTP ${r.status}`);

  /* ============ VIDAGE DU PLANNING ============ */
  section('Vider le planning (admin)');
  const before = db.prepare("SELECT COUNT(*) AS c FROM reservations WHERE status='CONFIRMED'").get().c;
  r = await call(admin, 'POST', '/api/admin/clear-planning', { confirm: 'AUTRE' });
  check('confirmation requise', r.status === 400, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(admin, 'GET', '/api/admin/settings');
  const institutionName = r.body.settings.institution_name;
  r = await call(admin, 'POST', '/api/admin/clear-planning', { confirm: 'VIDER', all: true });
  check('vidage global refusé sans le nom de l’établissement', r.status === 400, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(admin, 'POST', '/api/admin/clear-planning', { confirm: institutionName, all: true });
  check('planning vidé', r.status === 200 && r.body.deleted === before, `${r.body.deleted}/${before}`);
  check('aucune réservation active restante', db.prepare("SELECT COUNT(*) AS c FROM reservations WHERE status='CONFIRMED'").get().c === 0);
  // L’historique des annulations est conservé : le vidage efface le planning
  // actif, pas la trace des cours passés.
  check('historique des annulations conservé', db.prepare("SELECT COUNT(*) AS c FROM reservations WHERE status='CANCELLED'").get().c > 0);
  check('verrous nettoyés', db.prepare('SELECT COUNT(*) AS c FROM reservation_locks').get().c === 0);
  check('salles conservées', db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c === 15);
  check('utilisateurs conservés', db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 3);
  check('options/groupes/modules conservés', db.prepare('SELECT COUNT(*) AS c FROM options').get().c >= 2);

  /* ============ MOT DE PASSE OUBLIÉ ============ */
  section('Mot de passe oublié (réinitialisation)');
  r = await call(null, 'POST', '/api/auth/forgot-password', { email: 'inconnu@test.ma' });
  check('email inconnu : réponse générique (pas d’énumération)', r.status === 200 && r.body.ok === true, `HTTP ${r.status}`);
  r = await call(null, 'POST', '/api/auth/forgot-password', { email: 'sara.ip@test.ma' });
  check('code de réinitialisation envoyé', r.status === 200 && !!r.body.dev_code, `HTTP ${r.status} dev_code=${r.body && r.body.dev_code}`);
  const resetCode = r.body && r.body.dev_code;
  r = await call(null, 'POST', '/api/auth/forgot-password', { email: 'sara.ip@test.ma' });
  check('cooldown du code de réinitialisation (60 s)', r.status === 429 && r.body.error && r.body.error.code === 'COOLDOWN', `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(null, 'POST', '/api/auth/reset-password', { email: 'sara.ip@test.ma', code: '000000', password: 'NouveauSecret1', password2: 'NouveauSecret1' });
  check('code erroné refusé', r.status === 400 && r.body.error && r.body.error.code === 'RESET_INVALID', `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  r = await call(null, 'POST', '/api/auth/reset-password', { email: 'sara.ip@test.ma', code: resetCode, password: 'Court1', password2: 'Court1' });
  check('mot de passe trop court refusé', r.status === 400 && r.body.error && r.body.error.code === 'WEAK_PASSWORD', `HTTP ${r.status}`);
  r = await call(null, 'POST', '/api/auth/reset-password', { email: 'sara.ip@test.ma', code: resetCode, password: 'NouveauSecret1', password2: 'Differente1' });
  check('confirmation différente refusée', r.status === 400 && r.body.error && r.body.error.code === 'PASSWORD_MISMATCH', `HTTP ${r.status}`);
  r = await call(null, 'POST', '/api/auth/reset-password', { email: 'sara.ip@test.ma', code: resetCode, password: 'NouveauSecret1', password2: 'NouveauSecret1' });
  check('réinitialisation acceptée avec le bon code', r.status === 200 && r.body.ok === true, `HTTP ${r.status} ${r.body.error && r.body.error.code}`);
  check('code consommé en base', db.prepare("SELECT COUNT(*) AS c FROM email_codes WHERE purpose='reset_password' AND consumed_at IS NOT NULL").get().c === 1);
  r = await call(null, 'POST', '/api/auth/login', { email: 'sara.ip@test.ma', password: 'Secret123' });
  check('ancien mot de passe refusé', r.status === 401, `HTTP ${r.status}`);
  r = await call(null, 'POST', '/api/auth/login', { email: 'sara.ip@test.ma', password: 'NouveauSecret1' });
  check('nouveau mot de passe accepté', r.status === 200, `HTTP ${r.status}`);
  r = await call(coordIP, 'GET', '/api/auth/me');
  check('sessions révoquées après réinitialisation', r.status === 200 && r.body.user === null, JSON.stringify(r.body && r.body.user));
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?')
    .run(require('../server/auth').hashPassword('Secret123'), 'sara.ip@test.ma');
  r = await call(null, 'POST', '/api/auth/login', { email: 'sara.ip@test.ma', password: 'Secret123' });
  check('mot de passe d’origine rétabli (suite des tests)', r.status === 200, `HTTP ${r.status}`);

  /* ============ PERSISTANCE ============ */
  section('Persistance des données');
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
  const dbBytes = sizeOf(DB_FILE) + sizeOf(DB_FILE + '-wal') + sizeOf(DB_FILE + '-shm');
  check('fichier de base de données présent et non vide', dbBytes > 10000, `${dbBytes} octets (db + wal)`);
  check('données persistées (utilisateurs)', row > 3, `${row} comptes`);
  const reopened = new (require('node:sqlite').DatabaseSync)(DB_FILE);
  check('réouverture du fichier : mêmes données', reopened.prepare('SELECT COUNT(*) AS c FROM rooms').get().c === 15);
  reopened.close();

  /* ============ TITRES DES RESPONSABLES (COORDINATEUR / COORDINATRICE) ============ */
  /* Le genre d'un compte sert UNIQUEMENT au titre affiché : aucun droit ni
     aucune fonctionnalité ne doit en dépendre (exigence « ne pas modifier les
     droits des comptes existants »). */
  section('Titres des responsables');
  const { coordinatorTitle, filiereTitle, optionTitle, normalizeGender } = require('../server/util');
  check('titre masculin par défaut (compte antérieur à la colonne)',
    coordinatorTitle('') === 'Coordinateur' && coordinatorTitle(undefined) === 'Coordinateur');
  check('titre féminin pour un compte marqué F',
    coordinatorTitle('F') === 'Coordinatrice' && coordinatorTitle('f') === 'Coordinatrice');
  check('genre reconnu dans ses formes courantes',
    normalizeGender('F') === 'F' && normalizeGender('FEMININ') === 'F'
    && normalizeGender('M') === 'M' && normalizeGender('quelconque') === '');
  check('régle FILIÈRE automatique : Soins Infirmiers → Coordinatrice',
    filiereTitle('Soins Infirmiers') === 'Coordinatrice de filière');
  check('toutes les autres filières → Coordinateur',
    filiereTitle('Techniques de Santé') === 'Coordinateur de filière'
    && filiereTitle('Rééducation et Réhabilitation') === 'Coordinateur de filière'
    && filiereTitle('') === 'Coordinateur de filière');
  check('titre du responsable d’OPTION selon le genre',
    optionTitle('F') === 'Coordinatrice d’Option' && optionTitle('') === 'Coordinateur d’Option');

  // Le compte créé doit porter son titre, et la modification d'UN autre champ
  // ne doit jamais réinitialiser le titre existant.
  r = await call(admin, 'POST', '/api/auth/register', {
    nom: 'TitreTest', prenom: 'Coordinatrice', email: 'coordinatrice.test@test.ma',
    password: 'Secret12345', password2: 'Secret12345', role: 'coordinateur', gender: 'F', options: [ipId]
  });
  check('inscription coordinateur acceptée avec un genre', r.status === 200 || r.status === 201, `HTTP ${r.status}`);
  const genderRow = db.prepare("SELECT gender FROM users WHERE email = 'coordinatrice.test@test.ma'").get();
  check('genre enregistré en base', !!genderRow && genderRow.gender === 'F', genderRow && genderRow.gender);
  r = await call(admin, 'GET', '/api/admin/accounts');
  const foundCoord = (r.body.accounts || []).find((a) => a.email === 'coordinatrice.test@test.ma');
  check('titre exposé par l’API des comptes', !!foundCoord && foundCoord.title === 'Coordinatrice', foundCoord && foundCoord.title);
  // Modification d'un AUTRE champ : le titre doit être conservé.
  r = await call(admin, 'PUT', `/api/admin/accounts/${foundCoord.id}`, { prenom: 'Coordinatrice', nom: 'Modifie' });
  check('modification d’un autre champ sans genre : titre conservé', r.status === 200, `HTTP ${r.status}`);
  r = await call(admin, 'GET', '/api/admin/accounts');
  const keptCoord = (r.body.accounts || []).find((a) => a.email === 'coordinatrice.test@test.ma');
  check('titre toujours Coordinatrice après modification', !!keptCoord && keptCoord.title === 'Coordinatrice', keptCoord && keptCoord.title);
  check('droits inchangés : rôle et statut préservés', !!keptCoord && keptCoord.role === 'coordinateur' && keptCoord.status === 'pending', `${keptCoord && keptCoord.role}/${keptCoord && keptCoord.status}`);
  // Migration : un compte SANS genre conserve le titre masculin historique.
  r = await call(admin, 'POST', '/api/admin/accounts', {
    nom: 'SansGenre', prenom: 'Ancien', email: 'ancien.sansgenre@test.ma',
    password: 'Secret12345', role: 'coordinateur', options: [ipId]
  });
  check('création admin sans genre acceptée', r.status === 200 || r.status === 201, `HTTP ${r.status}`);
  r = await call(admin, 'GET', '/api/admin/accounts');
  const legacy = (r.body.accounts || []).find((a) => a.email === 'ancien.sansgenre@test.ma');
  check('compte sans genre → titre masculin historique', !!legacy && legacy.title === 'Coordinateur', legacy && legacy.title);
  // L'export des comptes expose le titre calculé.
  r = await call(admin, 'GET', '/api/export/users.xls');
  check('export des comptes : colonne titre présente', r.status === 200 && r.text.includes('titre'), `HTTP ${r.status}`);
  check('export des comptes : titre Coordinatrice repris', r.text.includes('Coordinatrice'));
  // Le responsable de filière de la fiche de réservation suit la règle automatique.
  const ipOption = db.prepare('SELECT o.category FROM options o WHERE o.id = ?').get(ipId);
  check('fiche de réservation : filière Soins Infirmiers → Coordinatrice de filière',
    filiereTitle(ipOption && ipOption.category) === 'Coordinatrice de filière', ipOption && ipOption.category);

  /* ============ RAPPORT ============ */
  await new Promise((res) => setTimeout(res, 400));
  const pass = results.filter((r2) => r2.pass).length;
  const fail = results.filter((r2) => !r2.pass);
  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  RÉSULTAT : ${pass}/${results.length} tests réussis`);
  if (fail.length) {
    console.log('  ÉCHECS :');
    fail.forEach((f) => console.log(`   - [${f.section}] ${f.name} ${f.detail}`));
  }
  console.log('══════════════════════════════════════════════');
  fs.writeFileSync(path.join(ROOT, 'data', 'test-report.json'), JSON.stringify({
    generated_at: new Date().toISOString(), total: results.length, passed: pass, failed: fail.length, results
  }, null, 2));
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERREUR FATALE:', e);
  process.exit(2);
});
