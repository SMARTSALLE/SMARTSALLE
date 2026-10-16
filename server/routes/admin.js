'use strict';
const { ok, created } = require('../router');
const { ApiError, readJson, str, int, bool, isEmail, requireFields, todayStr, normalizeGender, coordinatorTitle } = require('../util');
const db = require('../db');
const { requireRole, hashPassword, mapDbError } = require('../auth');
const realtime = require('../realtime');
const { notify } = require('./auth');

function userShape(u, optionRows) {
  return {
    id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, role: u.role,
    gender: normalizeGender(u.gender),
    /* Titre affiché partout dans l'application : déduit du genre du compte. */
    title: coordinatorTitle(u.gender),
    status: u.status, email_verified: !!u.email_verified,
    active_option_id: u.active_option_id, teacher_id: u.teacher_id || null,
    created_at: u.created_at, updated_at: u.updated_at,
    options: optionRows || []
  };
}

module.exports = function adminRoutes(router) {

  /* ================= COMPTES / DEMANDES ================= */
  router.add('GET', '/api/admin/accounts', async ({ req, res, query }) => {
    const user = requireRole(req, 'admin');
    const args = [];
    const cond = [];
    if (query.status) { cond.push('u.status = ?'); args.push(query.status); }
    if (query.role) { cond.push('u.role = ?'); args.push(query.role); }
    if (query.q) { cond.push('(u.nom LIKE ? OR u.prenom LIKE ? OR u.email LIKE ?)'); args.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
    let sql = 'SELECT u.* FROM users u' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '') + ' ORDER BY u.created_at DESC, u.id DESC LIMIT 500';
    const rows = db.get().prepare(sql).all(...args);
    const optStmt = db.get().prepare(`SELECT co.id AS request_id, co.status, co.requested_at, co.approved_at,
        o.id AS option_id, o.code, o.name
      FROM coordinator_options co JOIN options o ON o.id = co.option_id WHERE co.user_id = ? ORDER BY o.code`);
    return ok(res, {
      accounts: rows.map((u) => userShape(u, u.role === 'coordinateur' ? optStmt.all(u.id) : [])),
      current_user: user.id
    });
  });

  router.add('GET', '/api/admin/accounts/:id', async ({ req, res, params }) => {
    requireRole(req, 'admin');
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    const opts = db.get().prepare(`SELECT co.id AS request_id, co.status, co.requested_at, co.approved_at, o.id AS option_id, o.code, o.name
      FROM coordinator_options co JOIN options o ON o.id = co.option_id WHERE co.user_id = ?`).all(u.id);
    const teacher = u.teacher_id ? db.get().prepare('SELECT * FROM teachers WHERE id = ?').get(u.teacher_id) : null;
    return ok(res, { account: userShape(u, opts), teacher });
  });

  router.add('POST', '/api/admin/accounts', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    requireFields(b, ['nom', 'prenom', 'email', 'password', 'role']);
    const email = str(b.email, 160).toLowerCase();
    if (!isEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Email invalide.');
    if (String(b.password).length < 8) throw new ApiError(400, 'WEAK_PASSWORD', 'Mot de passe : 8 caractères minimum.');
    const role = str(b.role, 20);
    if (!['admin', 'coordinateur', 'enseignant', 'etudiant'].includes(role)) throw new ApiError(400, 'INVALID_ROLE', 'Rôle invalide.');
    const d = db.get();
    let optionIds = [];
    if (role === 'coordinateur' && Array.isArray(b.options)) {
      optionIds = b.options.map((x) => +x).filter((n) => Number.isFinite(n));
      if (optionIds.length > 3) throw new ApiError(400, 'TOO_MANY_OPTIONS', 'Maximum 3 options.');
    }
    try {
      const r = d.prepare('INSERT INTO users (nom, prenom, email, password_hash, role, gender, status, email_verified) VALUES (?,?,?,?,?,?,?,?)')
        .run(str(b.nom, 80), str(b.prenom, 80), email, hashPassword(String(b.password)), role, normalizeGender(b.gender),
          bool(b.email_verified) ? 'active' : 'pending', b.email_verified === false ? 0 : 1);
      const userId = Number(r.lastInsertRowid);
      for (const oid of optionIds) {
        d.prepare("INSERT INTO coordinator_options (user_id, option_id, status, approved_at, approved_by) VALUES (?,?, 'APPROVED', datetime('now'), ?)")
          .run(userId, oid, admin.id);
      }
      db.audit(admin, 'CREATION_COMPTE_ADMIN', 'user', userId, null, { email, role, options: optionIds.length });
      realtime.publish('account.created', { id: userId });
      return created(res, { ok: true, id: userId, email, password: String(b.password) });
    } catch (e) {
      throw mapDbError(e) || e;
    }
  });

  router.add('POST', '/api/admin/accounts/:id/validate', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    if (u.status === 'active') return ok(res, { ok: true, message: 'Compte déjà validé.' });
    /* Plus de vérification email préalable : la décision de l’administration
       (accepter / refuser) est le seul verrou d’accès. Le paramètre `force`
       reste accepté pour compatibilité, sans effet. */
    void b.force;
    const d = db.get();
    d.prepare("UPDATE users SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(u.id);
    let approvedOptions = 0;
    if (b.approve_options) {
      const r = d.prepare("UPDATE coordinator_options SET status='APPROVED', approved_at=datetime('now'), approved_by=? WHERE user_id=? AND status='REQUESTED'")
        .run(admin.id, u.id);
      approvedOptions = r.changes;
      if (approvedOptions && !u.active_option_id) {
        const first = d.prepare("SELECT option_id FROM coordinator_options WHERE user_id=? AND status='APPROVED' ORDER BY id LIMIT 1").get(u.id);
        if (first) d.prepare('UPDATE users SET active_option_id = ? WHERE id = ?').run(first.option_id, u.id);
      }
    }
    // Un compte enseignant est relié à sa fiche enseignant réelle (aucune donnée fictive).
    let linkedTeacher = null;
    if (u.role === 'enseignant' && !u.teacher_id) {
      let t = d.prepare('SELECT id FROM teachers WHERE email = ?').get(u.email);
      if (!t) {
        const tr = d.prepare('INSERT INTO teachers (nom, prenom, email, status) VALUES (?,?,?,?)')
          .run(u.nom, u.prenom, u.email, 'ACTIVE');
        t = { id: Number(tr.lastInsertRowid) };
        db.audit(admin, 'CREATION_FICHE_ENSEIGNANT', 'teachers', t.id, null, { email: u.email, from_user: u.id });
      }
      d.prepare('UPDATE users SET teacher_id = ? WHERE id = ?').run(t.id, u.id);
      linkedTeacher = t.id;
    }
    db.audit(admin, 'VALIDATION_COMPTE', 'user', u.id, { status: u.status }, { status: 'active', approved_options: approvedOptions, linked_teacher: linkedTeacher });
    notify(u.id, 'account', 'Compte validé',
      'Votre compte a été validé par l’administration. Vous pouvez vous connecter.', '#/login');
    realtime.publish('account.updated', { id: u.id, status: 'active' });
    return ok(res, { ok: true, message: 'Compte validé.', approved_options: approvedOptions, linked_teacher: linkedTeacher });
  });

  router.add('POST', '/api/admin/accounts/:id/refuse', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    if (u.role === 'admin' && u.id === admin.id) throw new ApiError(400, 'SELF_ACTION', 'Impossible de refuser votre propre compte.');
    db.get().prepare("UPDATE users SET status='refused', updated_at=datetime('now') WHERE id = ?").run(u.id);
    db.get().prepare("UPDATE coordinator_options SET status='REJECTED', approved_at=datetime('now'), approved_by=? WHERE user_id=? AND status='REQUESTED'")
      .run(admin.id, u.id);
    db.audit(admin, 'REFUS_COMPTE', 'user', u.id, { status: u.status }, { status: 'refused', reason: str(b.reason, 200) });
    notify(u.id, 'account', 'Demande de compte refusée', str(b.reason, 300) || 'Votre demande a été refusée par l’administration.', '#/login');
    realtime.publish('account.updated', { id: u.id, status: 'refused' });
    return ok(res, { ok: true, message: 'Compte refusé.' });
  });

  router.add('POST', '/api/admin/accounts/:id/status', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const status = str(b.status, 20);
    if (!['active', 'pending', 'suspended', 'refused'].includes(status)) throw new ApiError(400, 'INVALID_STATUS', 'Statut invalide.');
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    if (u.id === admin.id && status !== 'active') throw new ApiError(400, 'SELF_ACTION', 'Impossible de modifier votre propre statut.');
    db.get().prepare('UPDATE users SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, u.id);
    if (status !== 'active') db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.audit(admin, 'CHANGEMENT_STATUT', 'user', u.id, { status: u.status }, { status });
    realtime.publish('account.updated', { id: u.id, status });
    return ok(res, { ok: true, status });
  });

  router.add('PUT', '/api/admin/accounts/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    const d = db.get();
    const nom = b.nom !== undefined ? str(b.nom, 80) : u.nom;
    const prenom = b.prenom !== undefined ? str(b.prenom, 80) : u.prenom;
    const email = b.email !== undefined ? str(b.email, 160).toLowerCase() : u.email;
    const role = b.role !== undefined ? str(b.role, 20) : u.role;
    const teacherId = b.teacher_id !== undefined ? int(b.teacher_id) : u.teacher_id;
    /* Genre → titre affiché. Non fourni = on conserve celui du compte : la
       modification d'un autre champ ne doit jamais réinitialiser le titre. */
    const gender = b.gender !== undefined ? normalizeGender(b.gender) : normalizeGender(u.gender);
    if (!['admin', 'coordinateur', 'enseignant', 'etudiant'].includes(role)) throw new ApiError(400, 'INVALID_ROLE', 'Rôle invalide.');
    if (!isEmail(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Email invalide.');
    try {
      d.prepare('UPDATE users SET nom=?, prenom=?, email=?, role=?, gender=?, teacher_id=?, updated_at=datetime(\'now\') WHERE id=?')
        .run(nom, prenom, email, role, gender, teacherId, u.id);
    } catch (e) { throw mapDbError(e) || e; }
    db.audit(admin, 'MODIFICATION_COMPTE', 'user', u.id,
      { nom: u.nom, prenom: u.prenom, email: u.email, role: u.role, gender: normalizeGender(u.gender) },
      { nom, prenom, email, role, gender, teacher_id: teacherId });
    realtime.publish('account.updated', { id: u.id });
    return ok(res, { ok: true });
  });

  router.add('POST', '/api/admin/accounts/:id/password', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    if (String(b.password || '').length < 8) throw new ApiError(400, 'WEAK_PASSWORD', '8 caractères minimum.');
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    db.get().prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(hashPassword(String(b.password)), u.id);
    db.get().prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.audit(admin, 'REINIT_MOT_DE_PASSE', 'user', u.id, null, null);
    return ok(res, { ok: true, message: 'Mot de passe réinitialisé, sessions fermées.' });
  });

  router.add('DELETE', '/api/admin/accounts/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const u = db.get().prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
    if (!u) throw new ApiError(404, 'USER_NOT_FOUND', 'Utilisateur introuvable.');
    if (u.id === admin.id) throw new ApiError(400, 'SELF_ACTION', 'Impossible de supprimer votre propre compte.');
    if (u.role === 'admin') throw new ApiError(403, 'ADMIN_ACCOUNT', 'Les comptes administration ne peuvent pas être supprimés ici.');
    db.get().prepare('DELETE FROM users WHERE id = ?').run(u.id);
    db.audit(admin, 'SUPPRESSION_COMPTE', 'user', u.id, { email: u.email, role: u.role }, null);
    realtime.publish('account.deleted', { id: u.id });
    return ok(res, { ok: true });
  });

  /* ================= OPTIONS ================= */
  router.add('POST', '/api/admin/options', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    requireFields(b, ['code', 'name']);
    try {
      const r = db.get().prepare('INSERT INTO options (code, name, description, category, status) VALUES (?,?,?,?,?)')
        .run(str(b.code, 20).toUpperCase(), str(b.name, 80), str(b.description, 300), str(b.category, 60), b.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE');
      const id = Number(r.lastInsertRowid);
      db.audit(admin, 'CREATION_OPTION', 'option', id, null, b);
      realtime.publish('option.created', { id });
      return created(res, { ok: true, id });
    } catch (e) { throw mapDbError(e) || e; }
  });

  router.add('PUT', '/api/admin/options/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const o = db.get().prepare('SELECT * FROM options WHERE id = ?').get(+params.id);
    if (!o) throw new ApiError(404, 'OPTION_NOT_FOUND', 'Option introuvable.');
    try {
      db.get().prepare('UPDATE options SET code=?, name=?, description=?, category=?, status=? WHERE id=?')
        .run(str(b.code, 20).toUpperCase() || o.code, str(b.name, 80) || o.name, str(b.description, 300),
          b.category === undefined ? o.category : str(b.category, 60),
          b.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', o.id);
    } catch (e) { throw mapDbError(e) || e; }
    db.audit(admin, 'MODIFICATION_OPTION', 'option', o.id, o, b);
    realtime.publish('option.updated', { id: o.id });
    return ok(res, { ok: true });
  });

  router.add('DELETE', '/api/admin/options/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const o = db.get().prepare('SELECT * FROM options WHERE id = ?').get(+params.id);
    if (!o) throw new ApiError(404, 'OPTION_NOT_FOUND', 'Option introuvable.');
    const used = db.get().prepare('SELECT (SELECT COUNT(*) FROM reservations WHERE option_id=?) + (SELECT COUNT(*) FROM groups WHERE option_id=?) + (SELECT COUNT(*) FROM modules WHERE option_id=?) AS c')
      .get(o.id, o.id, o.id).c;
    if (used > 0) throw new ApiError(409, 'OPTION_IN_USE', `Option utilisée par ${used} élément(s) : mettez-la INACTIVE plutôt que de la supprimer.`);
    db.get().prepare('DELETE FROM options WHERE id = ?').run(o.id);
    db.audit(admin, 'SUPPRESSION_OPTION', 'option', o.id, o, null);
    return ok(res, { ok: true });
  });

  router.add('GET', '/api/admin/options/requests', async ({ req, res, query }) => {
    requireRole(req, 'admin');
    const args = [];
    let sql = `SELECT co.*, o.code, o.name, o.category AS option_category, u.nom, u.prenom, u.email, u.gender, u.status AS user_status, u.email_verified
      FROM coordinator_options co JOIN options o ON o.id = co.option_id JOIN users u ON u.id = co.user_id`;
    if (query.status) { sql += ' WHERE co.status = ?'; args.push(query.status); }
    sql += ' ORDER BY co.requested_at DESC LIMIT 500';
    return ok(res, { requests: db.get().prepare(sql).all(...args) });
  });

  router.add('POST', '/api/admin/options/requests/:id/approve', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const row = db.get().prepare('SELECT * FROM coordinator_options WHERE id = ?').get(+params.id);
    if (!row) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Demande introuvable.');
    if (row.status === 'APPROVED') return ok(res, { ok: true, message: 'Déjà approuvée.' });
    const d = db.get();
    d.prepare("UPDATE coordinator_options SET status='APPROVED', approved_at=datetime('now'), approved_by=? WHERE id=?").run(admin.id, row.id);
    const first = d.prepare("SELECT option_id FROM coordinator_options WHERE user_id=? AND status='APPROVED' ORDER BY id LIMIT 1").get(row.user_id);
    if (first && !d.prepare('SELECT active_option_id FROM users WHERE id = ?').get(row.user_id).active_option_id) {
      d.prepare('UPDATE users SET active_option_id = ? WHERE id = ?').run(first.option_id, row.user_id);
    }
    const opt = d.prepare('SELECT code FROM options WHERE id = ?').get(row.option_id);
    db.audit(admin, 'APPROBATION_OPTION', 'coordinator_option', row.id, { status: row.status }, { status: 'APPROVED', option: opt.code });
    notify(row.user_id, 'option', 'Option approuvée',
      `Votre option ${opt.code} a été approuvée par l’administration.`, '#/dashboard');
    realtime.publish('option.request', { id: row.id, status: 'APPROVED' });
    return ok(res, { ok: true, message: `Option ${opt.code} approuvée.` });
  });

  router.add('POST', '/api/admin/options/requests/:id/reject', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const row = db.get().prepare('SELECT * FROM coordinator_options WHERE id = ?').get(+params.id);
    if (!row) throw new ApiError(404, 'REQUEST_NOT_FOUND', 'Demande introuvable.');
    db.get().prepare("UPDATE coordinator_options SET status='REJECTED', approved_at=datetime('now'), approved_by=? WHERE id=?").run(admin.id, row.id);
    const opt = db.get().prepare('SELECT code FROM options WHERE id = ?').get(row.option_id);
    db.audit(admin, 'REJET_OPTION', 'coordinator_option', row.id, { status: row.status }, { status: 'REJECTED', option: opt.code });
    notify(row.user_id, 'option', 'Option refusée',
      `Votre demande d’option ${opt.code} a été refusée. Vous pouvez faire une nouvelle demande.`, '#/option');
    realtime.publish('option.request', { id: row.id, status: 'REJECTED' });
    return ok(res, { ok: true, message: `Option ${opt.code} refusée.` });
  });

  /* ================= GROUPES / MODULES / ENSEIGNANTS / SALLES ================= */
  function crudCreate(table, allowed, auditType, required) {
    return async ({ req, res }) => {
      const admin = requireRole(req, 'admin');
      const b = await readJson(req);
      const data = {};
      for (const [key, mapper] of Object.entries(allowed)) {
        if (b[key] !== undefined && b[key] !== null) data[key] = mapper(b[key]);
      }
      requireFields(data, required || []);
      const cols = Object.keys(data).filter((k) => k !== '__required');
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      try {
        const r = db.get().prepare(sql).run(...cols.map((c) => data[c]));
        const id = Number(r.lastInsertRowid);
        db.audit(admin, `CREATION_${auditType}`, table, id, null, data);
        realtime.publish(`${table}.created`, { id, ...data });
        return created(res, { ok: true, id });
      } catch (e) { throw mapDbError(e) || e; }
    };
  }

  function crudUpdate(table, allowed) {
    return async ({ req, res, params }) => {
      const admin = requireRole(req, 'admin');
      const b = await readJson(req);
      const before = db.get().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(+params.id);
      if (!before) throw new ApiError(404, 'NOT_FOUND', 'Élément introuvable.');
      const data = {};
      for (const [key, mapper] of Object.entries(allowed)) {
        if (b[key] !== undefined) data[key] = mapper(b[key]);
      }
      const cols = Object.keys(data);
      if (!cols.length) return ok(res, { ok: true, unchanged: true });
      try {
        db.get().prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
          .run(...cols.map((c) => data[c]), +params.id);
      } catch (e) { throw mapDbError(e) || e; }
      db.audit(admin, `MODIFICATION_${table.toUpperCase()}`, table, +params.id, before, data);
      realtime.publish(`${table}.updated`, { id: +params.id });
      return ok(res, { ok: true });
    };
  }

  const T = (max) => (v) => str(v, max);
  const N = () => (v) => int(v);
  const OPT = () => (v) => int(v);
  const TXT = () => (v) => (v === '' ? '' : str(v, 500));
  const NUM = () => (v) => (v === '' || v === null ? 0 : Math.max(0, +v || 0));

  /* Groupes */
  router.add('POST', '/api/admin/groups', crudCreate('groups', {
    code: T(40), name: T(120), option_id: OPT(), semester: T(20), academic_year: T(20),
    students_count: NUM(), status: T(20)
  }, 'GROUPE', ['code', 'name', 'option_id']));
  router.add('PUT', '/api/admin/groups/:id', crudUpdate('groups', {
    code: T(40), name: T(120), option_id: OPT(), semester: T(20), academic_year: T(20),
    students_count: NUM(), status: T(20)
  }));
  router.add('DELETE', '/api/admin/groups/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const before = db.get().prepare('SELECT * FROM groups WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Groupe introuvable.');
    const used = db.get().prepare('SELECT COUNT(*) AS c FROM reservations WHERE group_id = ?').get(before.id).c;
    if (used) throw new ApiError(409, 'IN_USE', `Groupe lié à ${used} réservation(s) : suppression impossible.`);
    db.get().prepare('DELETE FROM groups WHERE id = ?').run(before.id);
    db.audit(admin, 'SUPPRESSION_GROUPE', 'groups', before.id, before, null);
    return ok(res, { ok: true });
  });

  /* Modules */
  router.add('POST', '/api/admin/modules', crudCreate('modules', {
    code: T(40), name: T(120), description: T(300), option_id: OPT(), group_id: N(), teacher_id: N(),
    semester: T(20), academic_year: T(20), hours: NUM(), status: T(20)
  }, 'MODULE', ['code', 'name', 'option_id']));
  router.add('PUT', '/api/admin/modules/:id', crudUpdate('modules', {
    code: T(40), name: T(120), description: T(300), option_id: OPT(), group_id: N(), teacher_id: N(),
    semester: T(20), academic_year: T(20), hours: NUM(), status: T(20)
  }));
  /* Ajout rapide de plusieurs modules d'un même semestre en une seule requete. */
  router.add('POST', '/api/admin/modules/bulk', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const body = await readJson(req);
    const optionId = OPT()(body.option_id);
    if (!optionId) throw new ApiError(400, 'INVALID_OPTION', 'Option requise.');
    const semester = T(20)(body.semester) || '';
    const academicYear = T(20)(body.academic_year) || db.getSettings().academic_year || '';
    const teacherId = N()(body.teacher_id) || null;
    const raw = Array.isArray(body.modules) ? body.modules : [];
    if (!raw.length) throw new ApiError(400, 'EMPTY', 'Aucun module à créer.');
    if (raw.length > 200) throw new ApiError(400, 'TOO_MANY', 'Maximum 200 modules par envoi.');
    const created = [];
    const skipped = [];
    const d = db.get();
    const exists = d.prepare('SELECT id FROM modules WHERE code = ?');
    const ins = d.prepare(`INSERT INTO modules (code, name, description, option_id, teacher_id, semester, academic_year, hours, status)
                           VALUES (?,?,?,?,?,?,?,?,'ACTIVE')`);
    for (const item of raw) {
      const code = T(40)(item && item.code);
      const name = T(120)(item && item.name);
      if (!code || !name) { skipped.push({ code: code || '(vide)', reason: 'code ou intitulé manquant' }); continue; }
      if (exists.get(code)) { skipped.push({ code, reason: 'code déjà existant' }); continue; }
      const r = ins.run(code, name, T(300)(item.description) || '', optionId, teacherId, semester,
        academicYear, Number(item.hours) > 0 ? Number(item.hours) : 0);
      created.push({ id: Number(r.lastInsertRowid), code, name, semester, academic_year: academicYear });
    }
    db.audit(admin, 'CREATION_MODULES_MULTIPLES', 'modules', null,
      { option_id: optionId, semester, count: raw.length }, { created: created.length, skipped: skipped.length });
    return ok(res, { created, skipped, semester, academic_year: academicYear, option_id: optionId });
  });
  router.add('DELETE', '/api/admin/modules/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const before = db.get().prepare('SELECT * FROM modules WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Module introuvable.');
    const used = db.get().prepare('SELECT COUNT(*) AS c FROM reservations WHERE module_id = ?').get(before.id).c;
    if (used) throw new ApiError(409, 'IN_USE', `Module lié à ${used} réservation(s) : suppression impossible.`);
    db.get().prepare('DELETE FROM modules WHERE id = ?').run(before.id);
    db.audit(admin, 'SUPPRESSION_MODULE', 'modules', before.id, before, null);
    return ok(res, { ok: true });
  });

  /* Enseignants */
  router.add('POST', '/api/admin/teachers', crudCreate('teachers', {
    nom: T(80), prenom: T(80), email: T(160), specialty: T(120), status: T(20)
  }, 'ENSEIGNANT', ['nom']));
  router.add('PUT', '/api/admin/teachers/:id', crudUpdate('teachers', {
    nom: T(80), prenom: T(80), email: T(160), specialty: T(120), status: T(20), user_id: N()
  }));
  router.add('DELETE', '/api/admin/teachers/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const before = db.get().prepare('SELECT * FROM teachers WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Enseignant introuvable.');
    db.get().prepare('UPDATE reservations SET teacher_id = NULL WHERE teacher_id = ?').run(before.id);
    db.get().prepare('UPDATE modules SET teacher_id = NULL WHERE teacher_id = ?').run(before.id);
    db.get().prepare('DELETE FROM teachers WHERE id = ?').run(before.id);
    db.audit(admin, 'SUPPRESSION_ENSEIGNANT', 'teachers', before.id, before, null);
    return ok(res, { ok: true });
  });

  /* Salles */
  router.add('POST', '/api/admin/rooms', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    requireFields(b, ['code', 'name', 'floor']);
    const { randomToken } = require('../util');
    try {
      const r = db.get().prepare(`INSERT INTO rooms (code, name, floor, location, status, reserved_for, is_available_for_normal_booking, equipment, notes, qr_token)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(str(b.code, 20).toUpperCase(), str(b.name, 120), str(b.floor, 20), str(b.location, 160),
          str(b.status, 20) || 'ACTIVE', str(b.reserved_for, 80),
          b.bookable === false || b.is_available_for_normal_booking === 0 ? 0 : 1,
          str(b.equipment, 300), str(b.notes, 500), randomToken(16));
      const id = Number(r.lastInsertRowid);
      db.audit(admin, 'CREATION_SALLE', 'rooms', id, null, b);
      realtime.publish('room.created', { id });
      return created(res, { ok: true, id });
    } catch (e) { throw mapDbError(e) || e; }
  });

  router.add('PUT', '/api/admin/rooms/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const before = db.get().prepare('SELECT * FROM rooms WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const code = b.code !== undefined ? str(b.code, 20).toUpperCase() : before.code;
    const bookable = b.bookable !== undefined ? (b.bookable ? 1 : 0) : before.is_available_for_normal_booking;
    try {
      db.get().prepare(`UPDATE rooms SET code=?, name=?, floor=?, location=?, status=?, reserved_for=?,
        is_available_for_normal_booking=?, equipment=?, notes=? WHERE id=?`)
        .run(code, b.name !== undefined ? str(b.name, 120) : before.name,
          b.floor !== undefined ? str(b.floor, 20) : before.floor,
          b.location !== undefined ? str(b.location, 160) : before.location,
          b.status !== undefined ? str(b.status, 20) : before.status,
          b.reserved_for !== undefined ? str(b.reserved_for, 80) : before.reserved_for,
          bookable,
          b.equipment !== undefined ? str(b.equipment, 300) : before.equipment,
          b.notes !== undefined ? str(b.notes, 500) : before.notes, before.id);
    } catch (e) { throw mapDbError(e) || e; }
    db.audit(admin, 'MODIFICATION_SALLE', 'rooms', before.id, before, b);
    realtime.publish('room.updated', { id: before.id });
    return ok(res, { ok: true });
  });

  router.add('POST', '/api/admin/rooms/:id/qr', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const before = db.get().prepare('SELECT * FROM rooms WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const { randomToken } = require('../util');
    const token = randomToken(16);
    db.get().prepare('UPDATE rooms SET qr_token = ? WHERE id = ?').run(token, before.id);
    db.audit(admin, 'QR_SALLE', 'rooms', before.id, null, { regenerated: true });
    return ok(res, { ok: true, qr_token: token });
  });

  router.add('DELETE', '/api/admin/rooms/:id', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const before = db.get().prepare('SELECT * FROM rooms WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'ROOM_NOT_FOUND', 'Salle introuvable.');
    const used = db.get().prepare("SELECT COUNT(*) AS c FROM reservations WHERE room_id = ? AND status='CONFIRMED'").get(before.id).c;
    const query = new URLSearchParams((req.url.split('?')[1] || ''));
    if (used && query.get('force') !== '1') {
      throw new ApiError(409, 'ROOM_IN_USE', `Cette salle a ${used} réservation(s) : utilisez force=1 pour supprimer la salle et ses réservations.`);
    }
    db.get().prepare('DELETE FROM rooms WHERE id = ?').run(before.id);
    db.audit(admin, 'SUPPRESSION_SALLE', 'rooms', before.id, before, { deleted_reservations: used });
    realtime.publish('room.deleted', { id: before.id });
    return ok(res, { ok: true, deleted_reservations: used });
  });

  /* ================= PARAMÈTRES ================= */
  router.add('GET', '/api/admin/settings', async ({ req, res }) => {
    requireRole(req, 'admin');
    return ok(res, { settings: db.getSettings() });
  });

  router.add('PUT', '/api/admin/settings', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const before = db.getSettings();
    const next = db.setSettings(b.settings || b);
    db.audit(admin, 'MODIFICATION_PARAMETRES', 'settings', null,
      { semester: before.semester, academic_year: before.academic_year, day_start: before.day_start, day_end: before.day_end },
      { semester: next.semester, academic_year: next.academic_year, day_start: next.day_start, day_end: next.day_end });
    realtime.publish('settings.updated', { settings: next });
    return ok(res, { ok: true, settings: next });
  });

  router.add('POST', '/api/admin/settings/logo', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const dataUrl = String(b.logo_data || '');
    const m = /^data:image\/(png|svg\+xml|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new ApiError(400, 'INVALID_LOGO', 'Logo attendu au format data URL (png, jpeg, webp ou svg).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 400 * 1024) throw new ApiError(413, 'LOGO_TOO_LARGE', 'Logo trop volumineux (400 Ko max).');
    const fs = require('node:fs');
    const path = require('node:path');
    const { DATA_DIR } = require('../db');
    const dir = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const ext = m[1] === 'svg+xml' ? 'svg' : (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(dir, `logo.${ext}`), buf);
    const url = `/uploads/logo.${ext}?v=${Date.now()}`;
    db.setSettings({ logo_url: url });
    db.audit(admin, 'MODIFICATION_LOGO', 'settings', null, null, { url });
    return ok(res, { ok: true, logo_url: url });
  });

  /* Test d'envoi : vérifie que l'hôte/l'utilisateur Paramètres + le mot de
     passe SMTP_PASSWORD (env) fonctionnent réellement, avant qu'une inscription
     dépende de la réception de l'email. */
  router.add('POST', '/api/admin/settings/smtp-test', async ({ req, res }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const mail = require('../mail');
    const s = db.getSettings();
    const to = String(b.email || '').trim() || admin.email;
    if (!isEmail(to)) throw new ApiError(400, 'INVALID_EMAIL', 'Adresse email de test invalide.');
    const result = await mail.deliver({
      to,
      subject: `${s.app_name} — test d'envoi SMTP`,
      text: [
        'Ceci est un message de test envoyé par SmartSalle ISPITS.',
        '',
        `Destinataire : ${to}`,
        `Hôte SMTP    : ${s.smtp_host || '(non configuré)'}:${s.smtp_port || 587}`,
        `Utilisateur  : ${s.smtp_user || '(anonyme)'}`,
        `Date         : ${new Date().toISOString()}`,
        '',
        s.institution_name
      ].join('\n')
    });
    db.audit(admin, 'TEST_ENVOI_SMTP', 'settings', null, null, { to, delivered: result.delivered });
    return ok(res, {
      ok: true,
      delivered: result.delivered,
      error: result.error || null,
      message: result.delivered === 'smtp'
        ? `Email de test envoyé à ${to}.`
        : (result.error
            ? `Échec SMTP (${result.error}) — message conservé dans data/outbox.`
            : 'SMTP non configuré (hôte vide) — message conservé dans data/outbox, aucun envoi réel.')
    });
  });

  /* ================= HISTORIQUE / AUDIT ================= */
  router.add('GET', '/api/admin/audit', async ({ req, res, query }) => {
    requireRole(req, 'admin');
    const args = [];
    const cond = [];
    if (query.action) { cond.push('action LIKE ?'); args.push(`%${query.action}%`); }
    if (query.q) { cond.push('(user_label LIKE ? OR entity_type LIKE ? OR entity_id = ?)'); args.push(`%${query.q}%`, `%${query.q}%`, query.q); }
    let sql = 'SELECT * FROM audit_log' + (cond.length ? ' WHERE ' + cond.join(' AND ') : '');
    sql += ' ORDER BY id DESC LIMIT ' + Math.min(+(query.limit || 200), 1000);
    const rows = db.get().prepare(sql).all(...args);
    return ok(res, { history: rows, count: rows.length });
  });

  /* ================= STATISTIQUES AVANCÉES ================= */
  router.add('GET', '/api/admin/stats', async ({ req, res, query }) => {
    requireRole(req, 'admin');
    const d = db.get();
    const day = query.day || todayStr();
    const byFloor = d.prepare(`SELECT floor, COUNT(*) AS total,
        SUM(CASE WHEN is_available_for_normal_booking = 0 THEN 1 ELSE 0 END) AS restricted
      FROM rooms GROUP BY floor ORDER BY floor`).all();
    const byOption = d.prepare(`SELECT o.code, COUNT(r.id) AS reservations
      FROM options o LEFT JOIN reservations r ON r.option_id = o.id AND r.status='CONFIRMED'
      GROUP BY o.id ORDER BY reservations DESC`).all();
    const recent = d.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 15').all();
    return ok(res, { by_floor: byFloor, by_option: byOption, recent_activity: recent, day });
  });
};
