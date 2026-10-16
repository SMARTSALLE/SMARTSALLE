'use strict';
const { ok, created } = require('../router');
const { ApiError, readJson, isEmail, str, requireFields, json, normalizeGender } = require('../util');
const db = require('../db');
const { hashPassword, checkPassword, createSession, attachSession, clearSession, destroySession, currentUser, userForToken, requireAuth, requireRole, mapDbError } = require('../auth');
const mail = require('../mail');
const realtime = require('../realtime');

function notify(targetUserId, type, title, body, link) {
  try {
    const d = db.get();
    const r = d.prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?,?,?,?,?)')
      .run(targetUserId === null ? null : targetUserId, type, title, str(body, 500), str(link, 200));
    realtime.publish('notification', { id: Number(r.lastInsertRowid), user_id: targetUserId, type, title, body, link });
  } catch (e) {
    console.error('[notify]', e.message);
  }
}

function notifyAdmins(type, title, body, link) {
  try {
    const admins = db.get().prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all();
    for (const a of admins) notify(a.id, type, title, body, link);
  } catch (e) { /* ignore */ }
}

module.exports = function registerAuthRoutes(router) {

  /* ---------------- INSCRIPTION ---------------- */
  router.add('POST', '/api/auth/register', async ({ req, res }) => {
    const b = await readJson(req);
    requireFields(b, ['nom', 'prenom', 'email', 'password', 'password2', 'role']);
    const nom = str(b.nom, 80), prenom = str(b.prenom, 80);
    const email = str(b.email, 160).toLowerCase();
    if (!isEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Adresse email invalide.');
    if (String(b.password).length < 8) throw new ApiError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
    if (b.password !== b.password2) throw new ApiError(400, 'PASSWORD_MISMATCH', 'Les deux mots de passe ne correspondent pas.');

    const role = str(b.role, 30);
    if (!['coordinateur', 'enseignant'].includes(role)) {
      throw new ApiError(403, 'ROLE_NOT_ALLOWED', 'L’auto-inscription est réservée aux rôles COORDINATEUR et ENSEIGNANT.');
    }

    let optionIds = [];
    if (role === 'coordinateur') {
      optionIds = Array.isArray(b.options) ? b.options.map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n)) : [];
      if (optionIds.length < 1) throw new ApiError(400, 'OPTION_REQUIRED', 'Choisissez les options que vous coordonnez (1 au minimum).');
      if (optionIds.length > 3) throw new ApiError(400, 'TOO_MANY_OPTIONS', 'Un coordinateur ne peut demander que 3 options au maximum.');
      const uniq = [...new Set(optionIds)];
      if (uniq.length !== optionIds.length) throw new ApiError(400, 'DUPLICATE_OPTIONS', 'Options en double dans la demande.');
      optionIds = uniq;
      const placeholders = optionIds.map(() => '?').join(',');
      const rows = db.get().prepare(`SELECT id FROM options WHERE id IN (${placeholders}) AND status = 'ACTIVE'`).all(...optionIds);
      if (rows.length !== optionIds.length) throw new ApiError(400, 'INVALID_OPTION', 'Une ou plusieurs options demandées sont introuvables ou inactives.');
    }

    const d = db.get();
    try {
      const r = d.prepare("INSERT INTO users (nom, prenom, email, password_hash, role, gender, status, email_verified) VALUES (?,?,?,?,?,?,'pending',0)")
        .run(nom, prenom, email, hashPassword(String(b.password)), role, normalizeGender(b.gender));
      const userId = Number(r.lastInsertRowid);
      if (optionIds.length) {
        const ins = d.prepare('INSERT INTO coordinator_options (user_id, option_id, status) VALUES (?,?,\'REQUESTED\')');
        for (const oid of optionIds) ins.run(userId, oid);
      }
      db.audit({ id: userId, label: email }, 'CREATION_COMPTE', 'user', userId, null,
        { nom, prenom, email, role, options_demandees: optionIds.length });

      notifyAdmins('account_request', 'Nouvelle demande de compte',
        `${prenom} ${nom} (${email}) demande le rôle ${role.toUpperCase()}`, '#/admin/requests');

      /* Plus de vérification par code email : le compte naît « en attente de
         validation administrative » et reste inutilisable tant que
         l’administration ne l’a pas approuvé. Aucun envoi SMTP n’est requis
         pour s’inscrire (la délivrance reste vérifiable dans data/outbox). */
      return created(res, {
        ok: true,
        status: 'pending',
        needs_verification: false,
        email,
        message: 'Compte créé. Votre demande est en attente de validation administrative : '
          + 'l’accès sera ouvert après approbation par l’administration ISPITS.'
      });
    } catch (e) {
      const mapped = mapDbError(e);
      if (mapped) throw mapped;
      throw e;
    }
  });

  /* ---------------- RENVOI DE CODE (réinitialisation de mot de passe) -------
     La vérification email à l’inscription n’existe plus : ce service ne sert
     qu’au réinitialisation de mot de passe (purpose = reset_password). */
  router.add('POST', '/api/auth/resend-code', async ({ req, res }) => {
    const b = await readJson(req);
    const email = str(b.email, 160).toLowerCase();
    const purpose = str(b.purpose, 30) || 'reset_password';
    // Réponse identique pour éviter l'énumération de comptes.
    const generic = { ok: true, message: 'Si le compte existe, un nouveau code a été envoyé.' };
    if (purpose !== 'reset_password') return ok(res, generic);
    const user = db.get().prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return ok(res, generic);
    const wait = mail.cooldownRemaining(user.id, purpose);
    if (wait > 0) throw new ApiError(429, 'COOLDOWN', `Veuillez patienter ${wait} seconde(s) avant de redemander un code.`, { wait });
    const sent = await mail.sendPasswordResetEmail(user);
    return ok(res, {
      ok: true,
      message: 'Nouveau code envoyé.',
      expires_minutes: sent.expires_minutes,
      cooldown: sent.cooldown,
      dev_code: sent.code || null,
      delivery: sent.delivered
    });
  });

  /* ---------------- MOT DE PASSE OUBLIÉ ---------------- */
  // Réponse identique que le compte existe ou non (pas d'énumération de comptes).
  const forgotGeneric = {
    ok: true,
    message: 'Si un compte existe avec cet email, un code de réinitialisation a été envoyé.'
  };

  router.add('POST', '/api/auth/forgot-password', async ({ req, res }) => {
    const b = await readJson(req);
    const email = str(b.email, 160).toLowerCase();
    const user = email ? db.get().prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    // Compte introuvable : réponse générique, aucun code envoyé (pas d'énumération).
    if (!user) return ok(res, forgotGeneric);
    const wait = mail.cooldownRemaining(user.id, 'reset_password');
    if (wait > 0) throw new ApiError(429, 'COOLDOWN', `Veuillez patienter ${wait} seconde(s) avant de redemander un code.`, { wait });
    const sent = await mail.sendPasswordResetEmail(user);
    db.audit({ id: user.id, label: user.email }, 'DEMANDE_REINIT_MDP', 'user', user.id, null, null);
    return ok(res, {
      ...forgotGeneric,
      expires_minutes: sent.expires_minutes,
      cooldown: sent.cooldown,
      dev_code: sent.code || null,
      delivery: sent.delivered
    });
  });

  router.add('POST', '/api/auth/reset-password', async ({ req, res }) => {
    const b = await readJson(req);
    const email = str(b.email, 160).toLowerCase();
    const code = str(b.code, 12);
    const password = String(b.password || '');
    if (password.length < 8) throw new ApiError(400, 'WEAK_PASSWORD', 'Le mot de passe doit contenir au moins 8 caractères.');
    if (password !== String(b.password2 || '')) throw new ApiError(400, 'PASSWORD_MISMATCH', 'Les deux mots de passe ne correspondent pas.');
    // Même message que "compte inconnu" et que "code invalide" : aucune fuite d'information.
    const invalid = new ApiError(400, 'RESET_INVALID', 'Code incorrect ou expiré, ou compte introuvable.');
    const user = email ? db.get().prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
    if (!user) throw invalid;
    const result = mail.verifyEmailCode(user.id, code, 'reset_password');
    if (!result.ok) {
      const map = {
        CODE_EXPIRED: 'Code expiré. Demandez un nouveau code.',
        TOO_MANY_ATTEMPTS: 'Trop de tentatives. Demandez un nouveau code.',
        CODE_NOT_FOUND: 'Aucun code en cours. Demandez un nouveau code.'
      };
      if (result.reason === 'INVALID_CODE') throw invalid;
      throw new ApiError(400, result.reason, map[result.reason] || 'Code invalide.');
    }
    const d = db.get();
    d.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hashPassword(password), user.id);
    // Toutes les sessions existantes sont révoquées : l'ancien mot de passe ne donne plus accès à rien.
    d.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.audit({ id: user.id, label: user.email }, 'REINIT_MDP', 'user', user.id, null, null);
    notify(user.id, 'security', 'Mot de passe réinitialisé',
      'Votre mot de passe a été réinitialisé. Si ce n’était pas vous, contactez l’administration.', '#/login');
    return ok(res, { ok: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
  });

  /* ---------------- CONNEXION ---------------- */
  router.add('POST', '/api/auth/login', async ({ req, res, secure }) => {
    const b = await readJson(req);
    const email = str(b.email, 160).toLowerCase();
    const password = String(b.password || '');
    const user = db.get().prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !checkPassword(password, user.password_hash)) {
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Email ou mot de passe incorrect.');
    }
    if (user.status === 'pending') throw new ApiError(403, 'ACCOUNT_PENDING', 'Compte en attente de validation administrative. L’administration doit d’abord approuver votre demande.', { email });
    if (user.status === 'refused') throw new ApiError(403, 'ACCOUNT_REFUSED', 'Votre demande de compte a été refusée.');
    if (user.status === 'suspended') throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Compte suspendu.');

    const token = createSession(user.id, req);
    attachSession(res, token, secure);
    db.audit({ id: user.id, label: user.email }, 'CONNEXION', 'session', user.id, null, null);
    return ok(res, { ok: true, user: userForToken(token) });
  });

  router.add('POST', '/api/auth/logout', async ({ req, res }) => {
    destroySession(req);
    clearSession(res);
    return ok(res, { ok: true });
  });

  router.add('GET', '/api/auth/me', async ({ req, res }) => {
    const user = currentUser(req);
    if (!user) return ok(res, { user: null });
    const d = db.get();
    const pendingCount = d.prepare("SELECT COUNT(*) AS c FROM users WHERE status = 'pending'").get().c;
    const unread = d.prepare('SELECT COUNT(*) AS c FROM notifications WHERE (user_id = ? OR user_id IS NULL) AND read_at IS NULL').get(user.id).c;
    return ok(res, {
      user,
      server_time: new Date().toISOString(),
      pending_accounts: user.role === 'admin' ? pendingCount : 0,
      unread_notifications: unread,
      settings: user.status === 'active' ? db.getSettings() : db.getSettings()
    });
  });

  /* ---------------- OPTION ACTIVE ---------------- */
  router.add('POST', '/api/auth/switch-option', async ({ req, res }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    const optionId = parseInt(b.option_id, 10);
    if (user.role !== 'coordinateur') throw new ApiError(403, 'FORBIDDEN', 'Réservé aux coordinateurs.');
    const allowed = user.approved_options.find((o) => o.id === optionId);
    if (!allowed) throw new ApiError(403, 'OPTION_NOT_APPROVED',
      'Vous ne pouvez pas activer une option qui ne vous a pas été approuvée par l’administration.');
    db.get().prepare('UPDATE users SET active_option_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(optionId, user.id);
    db.audit(user, 'OPTION_ACTIVE', 'user', user.id, user.active_option ? user.active_option.code : null, allowed.code);
    realtime.publish('user.updated', { user_id: user.id, option: allowed.code }, (u) => u && (u.id === user.id || u.role === 'admin'));
    const fresh = currentUser(req);
    return ok(res, { ok: true, user: fresh });
  });

  /* ---------------- MOT DE PASSE ---------------- */
  router.add('POST', '/api/auth/change-password', async ({ req, res }) => {
    const user = requireAuth(req);
    const b = await readJson(req);
    const row = db.get().prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!checkPassword(String(b.current || ''), row.password_hash)) {
      throw new ApiError(400, 'BAD_CURRENT_PASSWORD', 'Mot de passe actuel incorrect.');
    }
    if (String(b.next || '').length < 8) throw new ApiError(400, 'WEAK_PASSWORD', 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
    db.get().prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(hashPassword(String(b.next)), user.id);
    db.audit(user, 'MOT_DE_PASSE', 'user', user.id, null, null);
    return ok(res, { ok: true, message: 'Mot de passe modifié.' });
  });

  /* ---------------- SESSIONS (liste / révocation admin) ---------------- */
  router.add('POST', '/api/auth/logout-all', async ({ req, res }) => {
    const user = requireAuth(req);
    db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    clearSession(res);
    return ok(res, { ok: true });
  });
};

module.exports.notify = notify;
module.exports.notifyAdmins = notifyAdmins;
