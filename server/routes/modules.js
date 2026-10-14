'use strict';
const { ok, created } = require('../router');
const { ApiError, readJson, str, int, bool, requireFields } = require('../util');
const db = require('../db');
const { requireRole, mapDbError } = require('../auth');
const realtime = require('../realtime');

/* Options approuvées pour un coordinateur (null pour admin = toutes) */
function approvedOptionIds(user) {
  if (user.role === 'admin') return null; // toutes
  const rows = db.get().prepare(
    "SELECT option_id FROM coordinator_options WHERE user_id = ? AND status = 'APPROVED'"
  ).all(user.id);
  return rows.map((r) => r.option_id);
}

/* Vérifie qu'un coordinateur a accès à l'option (admin = toujours) */
function assertOptionAccess(user, optionId) {
  if (user.role === 'admin') return;
  const ids = approvedOptionIds(user);
  if (!ids.includes(+optionId)) {
    throw new ApiError(403, 'OPTION_NOT_ALLOWED', 'Vous n’êtes pas coordinateur de cette option.');
  }
}

module.exports = function moduleRoutes(router) {

  /* ================= LECTURE MODULES (filtrée par option) ================= */
  router.add('GET', '/api/modules', async ({ req, res, query }) => {
    const user = requireRole(req, ['admin', 'coordinateur', 'enseignant']);
    const d = db.get();
    const args = [];
    const cond = [];
    
    if (user.role === 'coordinateur') {
      const ids = approvedOptionIds(user);
      if (!ids.length) return ok(res, { modules: [] });
      cond.push('m.option_id IN (' + ids.map(() => '?').join(',') + ')');
      args.push(...ids);
    } else if (user.role === 'enseignant') {
      // Enseignant : uniquement ses modules (via affectations)
      cond.push('m.teacher_id = ?');
      args.push(user.teacher_id || -1);
    }
    
    if (query.option_id) { cond.push('m.option_id = ?'); args.push(+query.option_id); }
    if (query.semester) { cond.push('m.semester = ?'); args.push(query.semester); }
    if (query.academic_year) { cond.push('m.academic_year = ?'); args.push(query.academic_year); }
    if (query.teacher_id) { cond.push('m.teacher_id = ?'); args.push(+query.teacher_id); }
    if (query.q) { cond.push('(m.code LIKE ? OR m.name LIKE ?)'); args.push(`%${query.q}%`, `%${query.q}%`); }
    if (query.validation_status) { cond.push('m.validation_status = ?'); args.push(query.validation_status); }
    
    let sql = `SELECT m.*, o.code AS option_code, o.name AS option_name, o.category AS option_category,
      g.code AS group_code, 
      t.nom AS teacher_nom, t.prenom AS teacher_prenom,
      u.nom AS creator_nom, u.prenom AS creator_prenom
      FROM modules m 
      JOIN options o ON o.id = m.option_id
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN teachers t ON t.id = m.teacher_id
      LEFT JOIN users u ON u.id = m.created_by`;
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY o.code, m.semester, m.code LIMIT 500';
    
    const rows = d.prepare(sql).all(...args).map((m) => ({
      ...m,
      teacher_name: m.teacher_id ? `${m.teacher_prenom || ''} ${m.teacher_nom || ''}`.trim() : '',
      creator_name: m.created_by ? `${m.creator_prenom || ''} ${m.creator_nom || ''}`.trim() : ''
    }));
    return ok(res, { modules: rows });
  });

  /* ================= CRÉATION / MODIFICATION MODULE ================= */
  router.add('POST', '/api/modules', async ({ req, res }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    requireFields(b, ['code', 'name', 'option_id', 'semester', 'academic_year']);
    
    assertOptionAccess(user, b.option_id);
    
    const d = db.get();
    const data = {
      code: str(b.code, 40).toUpperCase(),
      name: str(b.name, 120),
      description: str(b.description, 500),
      option_id: +b.option_id,
      group_id: b.group_id ? +b.group_id : null,
      teacher_id: b.teacher_id ? +b.teacher_id : null,
      semester: str(b.semester, 20),
      academic_year: str(b.academic_year, 20),
      hours: Math.max(0, +b.hours || 0),
      hours_theory: Math.max(0, +b.hours_theory || 0),
      hours_td: Math.max(0, +b.hours_td || 0),
      hours_tp: Math.max(0, +b.hours_tp || 0),
      created_by: user.id
    };
    
    // Validation : si l’administration a activé la validation des modules
    // (paramètre require_module_validation), une fiche créée par un
    // coordinateur attend la validation de l’admin ; sinon elle est active
    // immédiatement. L’admin crée toujours des fiches validées.
    const settings = db.getSettings();
    data.validation_status = (user.role === 'admin' || settings.require_module_validation !== '1')
      ? 'VALIDATED' : 'PENDING';
    
    try {
      const r = d.prepare(`INSERT INTO modules (code, name, description, option_id, group_id, teacher_id, 
        semester, academic_year, hours, hours_theory, hours_td, hours_tp, validation_status, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(data.code, data.name, data.description, data.option_id, data.group_id, data.teacher_id,
          data.semester, data.academic_year, data.hours, data.hours_theory, data.hours_td, data.hours_tp,
          data.validation_status, data.created_by);
      const id = Number(r.lastInsertRowid);
      
      db.audit(user, 'CREATION_MODULE', 'modules', id, null, data);
      realtime.publish('modules.created', { id, ...data });
      
      // Si un enseignant est assigné, créer aussi l'affectation
      if (data.teacher_id) {
        d.prepare(`INSERT INTO module_teachers (module_id, teacher_id, academic_year, semester, hours, teaching_type, created_by)
          VALUES (?,?,?,?,?, 'COURS', ?)`)
          .run(id, data.teacher_id, data.academic_year, data.semester, data.hours, data.created_by);
      }
      
      return created(res, { ok: true, id, message: 'Module créé avec succès.' });
    } catch (e) {
      throw mapDbError(e) || e;
    }
  });

  router.add('PUT', '/api/modules/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    const d = db.get();
    const before = d.prepare('SELECT * FROM modules WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Module introuvable.');
    
    assertOptionAccess(user, before.option_id);
    
    const data = {};
    if (b.code !== undefined) data.code = str(b.code, 40).toUpperCase();
    if (b.name !== undefined) data.name = str(b.name, 120);
    if (b.description !== undefined) data.description = str(b.description, 500);
    if (b.option_id !== undefined) { data.option_id = +b.option_id; assertOptionAccess(user, data.option_id); }
    if (b.group_id !== undefined) data.group_id = b.group_id ? +b.group_id : null;
    if (b.teacher_id !== undefined) data.teacher_id = b.teacher_id ? +b.teacher_id : null;
    if (b.semester !== undefined) data.semester = str(b.semester, 20);
    if (b.academic_year !== undefined) data.academic_year = str(b.academic_year, 20);
    if (b.hours !== undefined) data.hours = Math.max(0, +b.hours || 0);
    if (b.hours_theory !== undefined) data.hours_theory = Math.max(0, +b.hours_theory || 0);
    if (b.hours_td !== undefined) data.hours_td = Math.max(0, +b.hours_td || 0);
    if (b.hours_tp !== undefined) data.hours_tp = Math.max(0, +b.hours_tp || 0);
    if (b.status !== undefined) data.status = b.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    
    // L'admin peut changer le statut de validation
    if (user.role === 'admin' && b.validation_status !== undefined) {
      data.validation_status = ['PENDING', 'VALIDATED', 'REJECTED'].includes(b.validation_status) 
        ? b.validation_status : before.validation_status;
      data.validation_comment = str(b.validation_comment || '', 500);
      data.validated_by = user.id;
      data.validated_at = new Date().toISOString();
    }
    
    const cols = Object.keys(data);
    if (!cols.length) return ok(res, { ok: true, unchanged: true });
    
    try {
      d.prepare(`UPDATE modules SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
        .run(...cols.map((c) => data[c]), +params.id);
    } catch (e) { throw mapDbError(e) || e; }
    
    db.audit(user, 'MODIFICATION_MODULE', 'modules', +params.id, before, data);
    realtime.publish('modules.updated', { id: +params.id });
    return ok(res, { ok: true, message: 'Module mis à jour.' });
  });

  router.add('DELETE', '/api/modules/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const d = db.get();
    const before = d.prepare('SELECT * FROM modules WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Module introuvable.');
    
    assertOptionAccess(user, before.option_id);
    
    // Archiver plutôt que supprimer (l'historique est conservé)
    d.prepare("UPDATE modules SET status = 'ARCHIVED' WHERE id = ?").run(before.id);
    db.audit(user, 'ARCHIVAGE_MODULE', 'modules', before.id, { status: before.status }, { status: 'ARCHIVED' });
    realtime.publish('modules.updated', { id: before.id });
    return ok(res, { ok: true, message: 'Module archivé (l’historique est conservé).' });
  });

  /* ================= AFFECTATIONS ENSEIGNANTS-MODULES ================= */
  router.add('GET', '/api/module-teachers', async ({ req, res, query }) => {
    const user = requireRole(req, ['admin', 'coordinateur', 'enseignant']);
    const d = db.get();
    const args = [];
    const cond = [];
    
    if (user.role === 'coordinateur') {
      const ids = approvedOptionIds(user);
      if (!ids.length) return ok(res, { assignments: [] });
      cond.push('m.option_id IN (' + ids.map(() => '?').join(',') + ')');
      args.push(...ids);
    } else if (user.role === 'enseignant') {
      cond.push('mt.teacher_id = ?');
      args.push(user.teacher_id || -1);
    }
    
    if (query.module_id) { cond.push('mt.module_id = ?'); args.push(+query.module_id); }
    if (query.teacher_id) { cond.push('mt.teacher_id = ?'); args.push(+query.teacher_id); }
    if (query.academic_year) { cond.push('mt.academic_year = ?'); args.push(query.academic_year); }
    if (query.semester) { cond.push('mt.semester = ?'); args.push(query.semester); }
    if (query.status) { cond.push('mt.status = ?'); args.push(query.status); }
    
    let sql = `SELECT mt.*, m.code AS module_code, m.name AS module_name, m.semester AS module_semester,
      o.code AS option_code, t.nom AS teacher_nom, t.prenom AS teacher_prenom, t.email AS teacher_email
      FROM module_teachers mt
      JOIN modules m ON m.id = mt.module_id
      JOIN options o ON o.id = m.option_id
      JOIN teachers t ON t.id = mt.teacher_id`;
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY o.code, m.semester, m.code, t.nom LIMIT 1000';
    
    const rows = d.prepare(sql).all(...args).map((mt) => ({
      ...mt,
      teacher_name: `${mt.teacher_prenom || ''} ${mt.teacher_nom || ''}`.trim()
    }));
    return ok(res, { assignments: rows });
  });

  router.add('POST', '/api/module-teachers', async ({ req, res }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    requireFields(b, ['module_id', 'teacher_id', 'academic_year']);
    
    const d = db.get();
    const module = d.prepare('SELECT * FROM modules WHERE id = ?').get(+b.module_id);
    if (!module) throw new ApiError(404, 'MODULE_NOT_FOUND', 'Module introuvable.');
    
    assertOptionAccess(user, module.option_id);
    
    const teacher = d.prepare('SELECT * FROM teachers WHERE id = ?').get(+b.teacher_id);
    if (!teacher) throw new ApiError(404, 'TEACHER_NOT_FOUND', 'Enseignant introuvable.');
    
    const data = {
      module_id: +b.module_id,
      teacher_id: +b.teacher_id,
      academic_year: str(b.academic_year, 20),
      semester: str(b.semester || module.semester, 20),
      hours: Math.max(0, +b.hours || module.hours || 0),
      teaching_type: str(b.teaching_type || 'COURS', 20),
      notes: str(b.notes, 500),
      created_by: user.id
    };
    
    // Unicité (module, enseignant, année) vérifiée avant insertion : la base
    // la garantit aussi via UNIQUE (module_id, teacher_id, academic_year).
    const dup = d.prepare('SELECT id FROM module_teachers WHERE module_id = ? AND teacher_id = ? AND academic_year = ?')
      .get(data.module_id, data.teacher_id, data.academic_year);
    if (dup) {
      throw new ApiError(409, 'ALREADY_ASSIGNED', 'Cet enseignant est déjà affecté à ce module pour cette année. Modifiez plutôt l’affectation existante.');
    }
    
    try {
      const r = d.prepare(`INSERT INTO module_teachers (module_id, teacher_id, academic_year, semester, hours, teaching_type, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(data.module_id, data.teacher_id, data.academic_year, data.semester, data.hours, data.teaching_type, data.notes, data.created_by);
      const id = Number(r.lastInsertRowid);
      
      db.audit(user, 'CREATION_AFFECTATION', 'module_teachers', id, null, data);
      realtime.publish('module_teachers.created', { id, ...data });
      return created(res, { ok: true, id, message: 'Affectation créée.' });
    } catch (e) {
      throw mapDbError(e) || e;
    }
  });

  router.add('PUT', '/api/module-teachers/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    const d = db.get();
    const before = d.prepare('SELECT mt.*, m.option_id FROM module_teachers mt JOIN modules m ON m.id = mt.module_id WHERE mt.id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Affectation introuvable.');
    
    assertOptionAccess(user, before.option_id);
    
    const data = {};
    if (b.hours !== undefined) data.hours = Math.max(0, +b.hours || 0);
    if (b.teaching_type !== undefined) data.teaching_type = str(b.teaching_type, 20);
    if (b.notes !== undefined) data.notes = str(b.notes, 500);
    if (b.status !== undefined) data.status = ['ACTIVE', 'ARCHIVED'].includes(b.status) ? b.status : before.status;
    if (b.teacher_id !== undefined) data.teacher_id = +b.teacher_id;
    
    const cols = Object.keys(data);
    if (!cols.length) return ok(res, { ok: true, unchanged: true });
    
    try {
      d.prepare(`UPDATE module_teachers SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
        .run(...cols.map((c) => data[c]), +params.id);
    } catch (e) { throw mapDbError(e) || e; }
    
    db.audit(user, 'MODIFICATION_AFFECTATION', 'module_teachers', +params.id, before, data);
    realtime.publish('module_teachers.updated', { id: +params.id });
    return ok(res, { ok: true, message: 'Affectation modifiée.' });
  });

  router.add('DELETE', '/api/module-teachers/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const d = db.get();
    const before = d.prepare('SELECT mt.*, m.option_id FROM module_teachers mt JOIN modules m ON m.id = mt.module_id WHERE mt.id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Affectation introuvable.');
    
    assertOptionAccess(user, before.option_id);
    
    // Archiver plutôt que supprimer
    d.prepare("UPDATE module_teachers SET status = 'ARCHIVED' WHERE id = ?").run(before.id);
    db.audit(user, 'ARCHIVAGE_AFFECTATION', 'module_teachers', before.id, { status: before.status }, { status: 'ARCHIVED' });
    realtime.publish('module_teachers.updated', { id: before.id });
    return ok(res, { ok: true, message: 'Affectation archivée.' });
  });

  /* ================= VALIDATION ADMIN ================= */
  router.add('POST', '/api/admin/modules/:id/validate', async ({ req, res, params }) => {
    const admin = requireRole(req, 'admin');
    const b = await readJson(req);
    const d = db.get();
    const module = d.prepare('SELECT * FROM modules WHERE id = ?').get(+params.id);
    if (!module) throw new ApiError(404, 'NOT_FOUND', 'Module introuvable.');
    
    const action = str(b.action, 20); // APPROVE ou REJECT
    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new ApiError(400, 'INVALID_ACTION', 'Action invalide : APPROVE ou REJECT.');
    }
    
    const status = action === 'APPROVE' ? 'VALIDATED' : 'REJECTED';
    const comment = str(b.comment, 500);
    
    d.prepare(`UPDATE modules SET validation_status = ?, validation_comment = ?, validated_by = ?, validated_at = datetime('now') 
      WHERE id = ?`)
      .run(status, comment, admin.id, module.id);
    
    db.audit(admin, action === 'APPROVE' ? 'VALIDATION_MODULE' : 'REFUS_MODULE', 'modules', module.id,
      { validation_status: module.validation_status }, { validation_status: status, comment });
    realtime.publish('modules.updated', { id: module.id, validation_status: status });
    
    return ok(res, { ok: true, message: `Module ${action === 'APPROVE' ? 'validé' : 'refusé'}.` });
  });

  /* ================= LECTURE ENSEIGNANTS ================= */
  router.add('GET', '/api/teachers', async ({ req, res, query }) => {
    const user = requireRole(req, ['admin', 'coordinateur', 'enseignant']);
    const d = db.get();
    const args = [];
    const cond = [];
    
    if (user.role === 'enseignant') {
      cond.push('id = ?');
      args.push(user.teacher_id || -1);
    }
    
    if (query.q) { cond.push('(nom LIKE ? OR prenom LIKE ? OR email LIKE ? OR specialty LIKE ?)'); 
      args.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
    if (query.status) { cond.push('status = ?'); args.push(query.status); }
    
    let sql = 'SELECT * FROM teachers';
    if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
    sql += ' ORDER BY nom, prenom LIMIT 500';
    
    const rows = d.prepare(sql).all(...args).map((t) => ({
      ...t,
      full_name: `${t.prenom} ${t.nom}`.trim()
    }));
    return ok(res, { teachers: rows });
  });

  router.add('POST', '/api/teachers', async ({ req, res }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    requireFields(b, ['nom', 'prenom']);
    
    const d = db.get();
    const data = {
      nom: str(b.nom, 80),
      prenom: str(b.prenom, 80),
      email: str(b.email, 160),
      specialty: str(b.specialty, 120),
      grade: str(b.grade, 80),
      phone: str(b.phone, 40),
      establishment: str(b.establishment, 200),
      contract: str(b.contract, 40),
      notes: str(b.notes, 500),
      status: 'ACTIVE'
    };
    
    try {
      const r = d.prepare(`INSERT INTO teachers (nom, prenom, email, specialty, grade, phone, establishment, contract, notes, status)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(data.nom, data.prenom, data.email, data.specialty, data.grade, data.phone, data.establishment, data.contract, data.notes, data.status);
      const id = Number(r.lastInsertRowid);
      
      db.audit(user, 'CREATION_ENSEIGNANT', 'teachers', id, null, data);
      realtime.publish('teachers.created', { id, ...data });
      return created(res, { ok: true, id, message: 'Enseignant créé.' });
    } catch (e) {
      throw mapDbError(e) || e;
    }
  });

  router.add('PUT', '/api/teachers/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    const d = db.get();
    const before = d.prepare('SELECT * FROM teachers WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Enseignant introuvable.');
    
    const data = {};
    if (b.nom !== undefined) data.nom = str(b.nom, 80);
    if (b.prenom !== undefined) data.prenom = str(b.prenom, 80);
    if (b.email !== undefined) data.email = str(b.email, 160);
    if (b.specialty !== undefined) data.specialty = str(b.specialty, 120);
    if (b.grade !== undefined) data.grade = str(b.grade, 80);
    if (b.phone !== undefined) data.phone = str(b.phone, 40);
    if (b.establishment !== undefined) data.establishment = str(b.establishment, 200);
    if (b.contract !== undefined) data.contract = str(b.contract, 40);
    if (b.notes !== undefined) data.notes = str(b.notes, 500);
    if (b.status !== undefined) data.status = b.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    
    const cols = Object.keys(data);
    if (!cols.length) return ok(res, { ok: true, unchanged: true });
    
    try {
      d.prepare(`UPDATE teachers SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
        .run(...cols.map((c) => data[c]), +params.id);
    } catch (e) { throw mapDbError(e) || e; }
    
    db.audit(user, 'MODIFICATION_ENSEIGNANT', 'teachers', +params.id, before, data);
    realtime.publish('teachers.updated', { id: +params.id });
    return ok(res, { ok: true, message: 'Enseignant mis à jour.' });
  });

  router.add('DELETE', '/api/teachers/:id', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin']);
    const d = db.get();
    const before = d.prepare('SELECT * FROM teachers WHERE id = ?').get(+params.id);
    if (!before) throw new ApiError(404, 'NOT_FOUND', 'Enseignant introuvable.');
    
    // Archiver plutôt que supprimer (l'historique est conservé)
    d.prepare("UPDATE teachers SET status = 'INACTIVE' WHERE id = ?").run(before.id);
    db.audit(user, 'DESACTIVATION_ENSEIGNANT', 'teachers', before.id, { status: before.status }, { status: 'INACTIVE' });
    realtime.publish('teachers.updated', { id: before.id });
    return ok(res, { ok: true, message: 'Enseignant désactivé (l’historique est conservé).' });
  });

};
