'use strict';
const { ApiError, sha256, randomToken, hashSecret, verifySecret, cookies, setCookie, str, normalizeGender,
  ratePeek, rateHit, rateClear, clientIp } = require('./util');
const { get } = require('./db');

const SESSION_COOKIE = 'ss_session';
const SESSION_DAYS = 30;

function hashPassword(plain) { return hashSecret(plain); }
function checkPassword(plain, hash) { return verifySecret(plain, hash); }

/* Anti force brute : tentatives échouées par couple IP + email, puis par IP
   (anti « spraying » sur de nombreux comptes). Le compteur d'un couple est
   remis à zéro dès qu'une connexion réussie prouve que c'est le titulaire. */
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILS = 8;         // par couple IP + email
const MAX_LOGIN_FAILS_PER_IP = 50; // par adresse IP, tous comptes confondus

function loginWaitSeconds(ip, email) {
  return Math.max(
    ratePeek(`login:${ip}:${String(email || '').toLowerCase()}`, MAX_LOGIN_FAILS, RATE_WINDOW_MS),
    ratePeek(`loginip:${ip}`, MAX_LOGIN_FAILS_PER_IP, RATE_WINDOW_MS));
}

function recordLoginFailure(ip, email) {
  rateHit(`login:${ip}:${String(email || '').toLowerCase()}`, MAX_LOGIN_FAILS, RATE_WINDOW_MS);
  rateHit(`loginip:${ip}`, MAX_LOGIN_FAILS_PER_IP, RATE_WINDOW_MS);
}

function clearLoginFailures(ip, email) {
  rateClear(`login:${ip}:${String(email || '').toLowerCase()}`);
}

/* Hash factice : quand l'email n'existe pas, on vérifie quand même un hash
   pour que le temps de réponse soit identique — pas d'énumération de comptes
   par chronométrage. Calculé une seule fois au démarrage. */
const DUMMY_HASH = hashSecret('smartsalle-timing-decoy');
function decoyVerify(plain) { return verifySecret(plain, DUMMY_HASH); }

function createSession(userId, req) {
  const d = get();
  const token = randomToken(32);
  const ua = str(req && req.headers ? req.headers['user-agent'] : '', 200);
  d.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?,?,datetime(\'now\', ?),?)')
    .run(sha256(token), userId, `+${SESSION_DAYS} days`, ua);
  return token;
}

function attachSession(res, token, secure) {
  setCookie(res, SESSION_COOKIE, token, { httpOnly: true, maxAge: SESSION_DAYS * 86400, sameSite: 'Lax', secure: !!secure });
}

function clearSession(res) {
  setCookie(res, SESSION_COOKIE, '', { httpOnly: true, maxAge: 0, sameSite: 'Lax' });
}

function destroySession(req) {
  const token = cookies(req)[SESSION_COOKIE];
  if (!token) return;
  try { get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); } catch (e) { /* ignore */ }
}

function sessionToken(req) {
  return cookies(req)[SESSION_COOKIE] || null;
}

/** Retourne l'utilisateur connecté (avec options approuvées) ou null. */
function currentUser(req) {
  return userForToken(sessionToken(req));
}

function userForToken(token) {
  if (!token) return null;
  const d = get();
  const row = d.prepare(`
    SELECT u.id, u.nom, u.prenom, u.email, u.role, u.gender, u.status, u.email_verified, u.active_option_id, u.teacher_id,
           s.expires_at AS session_expires, s.token_hash AS token_hash
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token));
  if (!row) return null;
  return hydrate(row, token);
}

function hydrate(row, token) {
  const d = get();
  const options = d.prepare(`
    SELECT co.id, co.status, co.requested_at, co.approved_at, o.id AS option_id, o.code, o.name, o.status AS option_status
    FROM coordinator_options co JOIN options o ON o.id = co.option_id
    WHERE co.user_id = ? ORDER BY o.code`).all(row.id);
  const approved = options.filter((o) => o.status === 'APPROVED' && o.option_status === 'ACTIVE');
  let activeOption = approved.find((o) => o.option_id === row.active_option_id) || null;
  if (!activeOption && approved.length === 1) {
    get().prepare('UPDATE users SET active_option_id = ? WHERE id = ? AND (active_option_id IS NULL)').run(approved[0].option_id, row.id);
    activeOption = approved[0];
  }
  return {
    id: row.id,
    nom: row.nom,
    prenom: row.prenom,
    email: row.email,
    role: row.role,
    /* Genre → titre affiché (Coordinateur / Coordinatrice). Vide pour les comptes
       antérieurs : le titre masculin historique est conservé. */
    gender: normalizeGender(row.gender),
    status: row.status,
    email_verified: !!row.email_verified,
    teacher_id: row.teacher_id || null,
    active_option: activeOption ? { id: activeOption.option_id, code: activeOption.code, name: activeOption.name } : null,
    options: options.map((o) => ({ id: o.option_id, request_id: o.id, code: o.code, name: o.name, status: o.status, requested_at: o.requested_at, approved_at: o.approved_at })),
    approved_options: approved.map((o) => ({ id: o.option_id, code: o.code, name: o.name }))
    /* Le jeton de session n'est JAMAIS renvoyé en JSON : il ne vit que dans le
       cookie HttpOnly. Une fuite dans une réponse (log, cache, XSS) ne doit pas
       permettre de rejouer la session. */
  };
}

/** Exige une session valide. Lance ApiError sinon. */
function requireAuth(req) {
  const user = currentUser(req);
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise');
  if (user.status === 'refused') throw new ApiError(403, 'ACCOUNT_REFUSED', 'Votre compte a été refusé par l’administration.');
  if (user.status === 'suspended') throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Votre compte est suspendu.');
  /* La vérification email a été supprimée : seule la validation administrative
     ouvre l’accès aux fonctionnalités protégées. */
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_PENDING', 'Compte en attente : validation administrative requise.');
  return user;
}

function requireRole(req, roles) {
  const user = requireAuth(req);
  const list = Array.isArray(roles) ? roles : [roles];
  if (!list.includes(user.role)) {
    throw new ApiError(403, 'FORBIDDEN', `Accès réservé au rôle : ${list.join(', ')}`, { role: user.role });
  }
  return user;
}

function requireAdmin(req) { return requireRole(req, 'admin'); }

function requireCoordinator(req) { return requireRole(req, ['coordinateur', 'admin']); }

/** Codes d'erreur métier normalisés (contrôle serveur, jamais seulement frontend). */
const ERR = {
  CONFLICT: () => new ApiError(409, 'SCHEDULE_CONFLICT', 'Conflit : cette salle est déjà réservée sur ce créneau.'),
  RESTRICTED: () => new ApiError(403, 'ROOM_RESTRICTED', 'Salle réservée au MASTER MANAGEMENT — indisponible pour une réservation normale.'),
  OPTION: () => new ApiError(403, 'OPTION_NOT_ALLOWED', 'Vous ne pouvez réserver que pour vos options approuvées.'),
  OWNERSHIP: () => new ApiError(403, 'NOT_OWNER', 'Vous ne pouvez modifier que vos propres réservations (ou celles de vos options).')
};

function isSqliteConflict(e) {
  const msg = String(e && e.message || '');
  return msg.includes('UNIQUE constraint failed: reservation_locks') ||
    msg.includes('reservation_locks.room_id') ||
    msg.includes('FOREIGN KEY constraint failed: reservation_locks');
}

function mapDbError(e) {
  if (isSqliteConflict(e)) return ERR.CONFLICT();
  const msg = String(e && e.message || '');
  if (msg.includes('ROOM_RESTRICTED')) return ERR.RESTRICTED();
  if (msg.includes('UNIQUE constraint failed')) {
    if (msg.includes('users.email')) return new ApiError(409, 'EMAIL_EXISTS', 'Un compte existe déjà avec cet email.');
    if (msg.includes('rooms.code')) return new ApiError(409, 'ROOM_EXISTS', 'Ce code de salle existe déjà.');
    if (msg.includes('options.code')) return new ApiError(409, 'OPTION_EXISTS', 'Ce code d’option existe déjà.');
    if (msg.includes('groups.code')) return new ApiError(409, 'GROUP_EXISTS', 'Ce code de groupe existe déjà.');
    if (msg.includes('modules.code')) return new ApiError(409, 'MODULE_EXISTS', 'Ce code de module existe déjà.');
    if (msg.includes('coordinator_options')) return new ApiError(409, 'ALREADY_REQUESTED', 'Cette option est déjà demandée ou approuvée.');
  }
  if (msg.includes('CHECK constraint failed')) return new ApiError(400, 'INVALID_VALUE', `Valeur invalide : ${msg.split('CHECK constraint failed:')[1] || ''}`.trim());
  if (msg.includes('FOREIGN KEY constraint failed')) return new ApiError(400, 'INVALID_REFERENCE', 'Référence invalide (élément introuvable).');
  return null;
}

module.exports = {
  SESSION_COOKIE, hashPassword, checkPassword, createSession, attachSession, clearSession,
  destroySession, sessionToken, currentUser, userForToken, requireAuth, requireRole, requireAdmin,
  requireCoordinator, ERR, mapDbError, isSqliteConflict, hydrate,
  loginWaitSeconds, recordLoginFailure, clearLoginFailures, decoyVerify, clientIp
};
