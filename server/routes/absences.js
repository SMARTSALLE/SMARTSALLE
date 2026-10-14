'use strict';
/* =========================================================================
   ABSENCES ET JUSTIFICATIFS — règle essentielle
   Le simple DÉPÔT d'un document par l'étudiant n'entraîne JAMAIS, à lui seul,
   la validation de l'absence. Le dépôt crée une demande au statut
   « EN_ATTENTE » ; l'absence reste « EN_ATTENTE » (non justifiée) jusqu'à une
   décision explicite d'un utilisateur habilité (administration ou coordinateur
   de l'option concernée). Chaque changement de statut est tracé dans
   justificatif_history (auteur, date, commentaire).
   ========================================================================= */
const fs = require('node:fs');
const path = require('node:path');
const { ok, created } = require('../router');
const { ApiError, readJson, str, int, requireFields } = require('../util');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify, notifyAdmins } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const JF_DIR = path.join(DATA_DIR, 'justificatifs');

/* Types de documents acceptés : PDF et images. Taille max ~5 Mo (base64). */
const DOC_RE = /^data:(application\/pdf|image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/;
const DOC_MAX_B64 = 7 * 1024 * 1024;
const DOC_EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/* Statuts de la DEMANDE de justificatif et statuts administratifs de l'absence
   sont deux choses distinctes — jamais fusionnées. */
const DEMAND = { EN_ATTENTE: 'EN_ATTENTE', JUSTIFIE: 'JUSTIFIE', REFUSE: 'REFUSE', COMPLEMENT_DEMANDE: 'COMPLEMENT_DEMANDE' };

function minToHhmm(m) {
  if (typeof m !== 'number') return null;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function hhmmToMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const min = (+m[1]) * 60 + (+m[2]);
  return (min >= 0 && min <= 1440) ? min : null;
}

/* Coordinateur autorisé sur l'option de l'absence ? (admin = toujours) */
function canReview(user, row) {
  if (user.role === 'admin') return true;
  if (user.role !== 'coordinateur' || !row.option_id) return false;
  return !!db.get().prepare(
    "SELECT 1 AS x FROM coordinator_options WHERE user_id = ? AND option_id = ? AND status = 'APPROVED'"
  ).get(user.id, row.option_id);
}

function jfShape(j, opts) {
  opts = opts || {};
  const out = {
    id: j.id, absence_id: j.absence_id, status: j.status,
    document_name: j.document_name, document_mime: j.document_mime,
    motif_refus: j.motif_refus, observations: j.observations,
    decided_by: j.decided_by, decided_at: j.decided_at,
    submitted_at: j.submitted_at, resubmitted_at: j.resubmitted_at, version: j.version,
    decided_by_name: j.decided_by_name || null
  };
  /* L'enseignant n'a jamais accès au document ni aux observations : le lien de
     téléchargement n'est tout simplement pas exposé dans sa réponse. */
  if (!opts.limited) out.has_document = !!j.document_path;
  return out;
}

function absShape(a, opts) {
  opts = opts || {};
  const out = {
    id: a.id, day: a.day, start: minToHhmm(a.start_min), end: minToHhmm(a.end_min),
    module_label: a.module_label, teacher_label: a.teacher_label,
    option_id: a.option_id, option_code: a.option_code || null,
    student_id: a.student_id, student_name: a.student_name || null,
    absence_status: a.status
  };
  /* Vue « enseignant » : statut uniquement, sans motif ni pièce confidentielle. */
  if (!opts.limited) {
    out.motif = a.motif;
    out.justificatif = a.justificatif ? jfShape(a.justificatif, opts) : null;
  } else {
    out.demand_status = a.justificatif ? a.justificatif.status : null;
  }
  return out;
}

const BASE_SELECT = `
  SELECT a.*, o.code AS option_code,
    (u.prenom || ' ' || u.nom) AS student_name
  FROM absences a
  LEFT JOIN options o ON o.id = a.option_id
  LEFT JOIN users u ON u.id = a.student_id`;

function loadJustificatif(d, absenceId) {
  return d.prepare(`SELECT j.*, (u2.prenom || ' ' || u2.nom) AS decided_by_name
    FROM justificatifs j LEFT JOIN users u2 ON u2.id = j.decided_by
    WHERE j.absence_id = ?`).get(absenceId) || null;
}

function loadFull(d, id) {
  const a = d.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(id);
  if (!a) return null;
  a.justificatif = loadJustificatif(d, a.id);
  return a;
}

function trace(d, jf, absenceId, from, to, actor, comment) {
  d.prepare(`INSERT INTO justificatif_history (justificatif_id, absence_id, from_status, to_status, actor_id, actor_label, comment)
    VALUES (?,?,?,?,?,?,?)`)
    .run(jf.id, absenceId, from || '', to, actor ? actor.id : null,
      actor ? `${actor.prenom} ${actor.nom}` : 'Système', str(comment || '', 500));
}

module.exports = function absenceRoutes(router) {

  /* ================= DÉPÔT D'UN JUSTIFICATIF (étudiant) =================
     L'étudiant renseigne date, horaires, module, enseignant et motif, puis joint
     son document. La demande naît « EN_ATTENTE » et l'absence aussi : rien n'est
     justifié à ce stade. */
  router.add('POST', '/api/absences', async ({ req, res }) => {
    const user = requireRole(req, 'etudiant');
    const b = await readJson(req, 8 * 1024 * 1024);
    requireFields(b, ['day', 'start', 'end', 'module_id', 'motif', 'document']);
    const day = str(b.day, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError(400, 'INVALID_DAY', 'Date invalide (AAAA-MM-JJ).');
    const startMin = hhmmToMin(b.start);
    const endMin = hhmmToMin(b.end);
    if (startMin === null || endMin === null) throw new ApiError(400, 'INVALID_TIME', 'Horaires invalides (HH:MM).');
    if (endMin <= startMin) throw new ApiError(400, 'INVALID_RANGE', 'L’heure de fin doit être après l’heure de début.');
    if (startMin % 30 !== 0 || endMin % 30 !== 0) throw new ApiError(400, 'INVALID_GRID', 'Les horaires sont posés sur une grille de 30 minutes.');

    const d = db.get();
    const mod = d.prepare('SELECT id, option_id, teacher_id, name, code FROM modules WHERE id = ?').get(+b.module_id);
    if (!mod) throw new ApiError(400, 'MODULE_NOT_FOUND', 'Module introuvable.');
    const tch = b.teacher_id ? d.prepare('SELECT id, nom, prenom FROM teachers WHERE id = ?').get(+b.teacher_id) : null;

    /* Pièce jointe obligatoire : sans document, la demande n'a pas de sens. */
    const m = DOC_RE.exec(String(b.document || ''));
    if (!m) throw new ApiError(400, 'INVALID_DOCUMENT', 'Document attendu : PDF, PNG, JPEG ou WebP (données base64).');
    if (m[3].length > DOC_MAX_B64) throw new ApiError(400, 'DOCUMENT_TOO_LARGE', 'Document trop volumineux (5 Mo maximum).');

    /* Aucun blocage de chevauchement ici : une absence est un fait déclaré par
       l'étudiant, pas une réservation de salle. */
    const ins = d.prepare(`INSERT INTO absences
      (student_id, option_id, day, start_min, end_min, module_id, teacher_id, module_label, teacher_label, motif, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,'EN_ATTENTE')`);
    const teacherLabel = tch ? `${tch.prenom} ${tch.nom}` : '';
    const r = ins.run(user.id, mod.option_id, day, startMin, endMin, mod.id,
      tch ? tch.id : (mod.teacher_id || null), `${mod.code} — ${mod.name}`, teacherLabel, str(b.motif, 500));
    const absenceId = Number(r.lastInsertRowid);

    fs.mkdirSync(JF_DIR, { recursive: true });
    const ext = DOC_EXT[m[1]];
    const fileName = `jf${absenceId}_v1.${ext}`;
    fs.writeFileSync(path.join(JF_DIR, fileName), Buffer.from(m[3], 'base64'));

    d.prepare(`INSERT INTO justificatifs (absence_id, status, document_path, document_name, document_mime)
      VALUES (?, 'EN_ATTENTE', ?, ?, ?)`)
      .run(absenceId, fileName, str(b.document_name || `justificatif.${ext}`, 200), m[1]);
    const jf = loadJustificatif(d, absenceId);
    trace(d, jf, absenceId, '', 'EN_ATTENTE', user, 'Dépôt du justificatif par l’étudiant.');

    db.audit(user, 'DEPOT_JUSTIFICATIF', 'absence', absenceId, null,
      { day, module: mod.code, version: 1 });
    /* Notification : administration + coordinateurs de l'option concernée. */
    notifyAdmins('absence', 'Nouveau justificatif déposé',
      `Absence du ${day} — module ${mod.code} — en attente de vérification.`, '#/absences/review');
    if (mod.option_id) {
      const coords = d.prepare(`SELECT co.user_id FROM coordinator_options co
        JOIN users uu ON uu.id = co.user_id AND uu.status = 'active'
        WHERE co.option_id = ? AND co.status = 'APPROVED'`).all(mod.option_id);
      for (const c of coords) {
        if (c.user_id !== user.id) notify(c.user_id, 'absence', 'Nouveau justificatif à vérifier',
          `Absence du ${day} — module ${mod.code}.`, '#/absences/review');
      }
    }
    return created(res, { ok: true, absence_id: absenceId, absence_status: 'EN_ATTENTE', demand_status: 'EN_ATTENTE' });
  });

  /* ================= MES ABSENCES (étudiant) =================
     L'étudiant consulte l'état de ses demandes. Aucune route ne lui permet de
     modifier un statut : c'est volontaire (règle de gestion). */
  router.add('GET', '/api/absences/mine', async ({ req, res }) => {
    const user = requireRole(req, 'etudiant');
    const d = db.get();
    const rows = d.prepare(`${BASE_SELECT} WHERE a.student_id = ? ORDER BY a.day DESC, a.start_min DESC LIMIT 500`).all(user.id);
    rows.forEach((a) => { a.justificatif = loadJustificatif(d, a.id); });
    return ok(res, { absences: rows.map((a) => absShape(a)) });
  });

  /* ================= MÉTADONNÉES DU DÉPÔT (étudiant) =================
     Modules actifs et enseignants, strictement ce qu'il faut pour remplir le
     formulaire : l'étudiant n'a pas accès au reste du catalogue pédagogique. */
  router.add('GET', '/api/absences/meta', async ({ req, res }) => {
    requireRole(req, 'etudiant');
    const d = db.get();
    const modules = d.prepare(`SELECT m.id, m.code, m.name, m.option_id,
        o.code AS option_code, m.teacher_id,
        COALESCE(t.prenom || ' ' || t.nom, '') AS teacher_name
      FROM modules m
      LEFT JOIN options o ON o.id = m.option_id
      LEFT JOIN teachers t ON t.id = m.teacher_id
      WHERE m.status = 'ACTIVE'
      ORDER BY m.code, m.name`).all();
    const teachers = d.prepare(`SELECT id, prenom, nom FROM teachers
      WHERE status = 'ACTIVE' ORDER BY prenom, nom`).all();
    return ok(res, { modules, teachers });
  });

  /* ================= VUE ENSEIGNANT (statut seul) =================
     L'enseignant voit les absences de SES cours : horaires, module, statut de
     l'absence et statut de la demande. Jamais le motif, jamais la pièce
     médicale, jamais les observations — le lien de téléchargement n'existe pas
     dans cette réponse. */
  router.add('GET', '/api/absences/enseignant', async ({ req, res }) => {
    const user = requireRole(req, 'enseignant');
    if (!user.teacher_id) return ok(res, { absences: [] });
    const d = db.get();
    const rows = d.prepare(`${BASE_SELECT} WHERE a.teacher_id = ? ORDER BY a.day DESC, a.start_min DESC LIMIT 1000`)
      .all(user.teacher_id);
    rows.forEach((a) => { a.justificatif = loadJustificatif(d, a.id); });
    return ok(res, { absences: rows.map((a) => absShape(a, { limited: true })) });
  });

  /* ================= VÉRIFICATION (administration / coordinateurs) ================= */
  router.add('GET', '/api/absences', async ({ req, res, query }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const d = db.get();
    const args = [];
    let sql = BASE_SELECT;
    if (user.role === 'coordinateur') {
      const ids = d.prepare("SELECT option_id FROM coordinator_options WHERE user_id = ? AND status = 'APPROVED'")
        .all(user.id).map((x) => x.option_id);
      if (!ids.length) return ok(res, { absences: [] });
      sql += ' WHERE a.option_id IN (' + ids.map(() => '?').join(',') + ')';
      args.push(...ids);
    }
    if (query.status) { sql += (args.length ? ' AND' : ' WHERE') + ' a.status = ?'; args.push(query.status); }
    if (query.option_id) { sql += (args.length ? ' AND' : ' WHERE') + ' a.option_id = ?'; args.push(+query.option_id); }
    sql += ' ORDER BY a.day DESC, a.start_min DESC LIMIT 1000';
    const rows = d.prepare(sql).all(...args);
    rows.forEach((a) => { a.justificatif = loadJustificatif(d, a.id); });
    return ok(res, { absences: rows.map((a) => absShape(a)) });
  });

  /* ================= DÉTAIL + HISTORIQUE =================
     Étudiant propriétaire, administration et coordinateur de l'option. */
  router.add('GET', '/api/absences/:id', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const d = db.get();
    const a = loadFull(d, +params.id);
    if (!a) throw new ApiError(404, 'ABSENCE_NOT_FOUND', 'Absence introuvable.');
    if (user.role === 'etudiant' && a.student_id !== user.id) {
      throw new ApiError(403, 'NOT_OWNER', 'Cette absence ne vous appartient pas.');
    }
    if (!['admin', 'etudiant'].includes(user.role) && !canReview(user, a)) {
      throw new ApiError(403, 'FORBIDDEN', 'Accès réservé aux personnes habilitées.');
    }
    const history = a.justificatif
      ? d.prepare(`SELECT h.from_status, h.to_status, h.actor_label, h.comment, h.created_at
          FROM justificatif_history h WHERE h.justificatif_id = ? ORDER BY h.id`).all(a.justificatif.id)
      : [];
    return ok(res, { absence: absShape(a), history });
  });

  /* ================= TÉLÉCHARGEMENT DE LA PIÈCE (confidentielle) =================
     Le dossier des justificatifs n'est PAS servi statiquement : chaque accès est
     autorisé. L'enseignant reçoit systématiquement un refus. */
  router.add('GET', '/api/justificatifs/:id/document', async ({ req, res, params }) => {
    const user = requireAuth(req);
    const d = db.get();
    const j = d.prepare(`SELECT j.*, a.student_id, a.option_id FROM justificatifs j
      JOIN absences a ON a.id = j.absence_id WHERE j.id = ?`).get(+params.id);
    if (!j || !j.document_path) throw new ApiError(404, 'DOCUMENT_NOT_FOUND', 'Document introuvable.');
    const owner = user.role === 'etudiant' && j.student_id === user.id;
    const reviewer = canReview(user, { option_id: j.option_id });
    if (!owner && !reviewer && user.role !== 'admin') {
      throw new ApiError(403, 'DOCUMENT_FORBIDDEN',
        'Document confidentiel : accès réservé à l’étudiant concerné et aux personnes habilitées à la vérification.');
    }
    const file = path.join(JF_DIR, path.basename(j.document_path));
    if (!fs.existsSync(file)) throw new ApiError(404, 'DOCUMENT_MISSING', 'Fichier absent du stockage.');
    res.writeHead(200, {
      'Content-Type': j.document_mime || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Content-Disposition': `inline; filename="${(j.document_name || 'justificatif').replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store'
    });
    fs.createReadStream(file).pipe(res);
  });

  /* ================= DÉCISION (habilités uniquement) =================
     ACCEPT → demande JUSTIFIE + absence JUSTIFIEE (seul cas de justification).
     REFUSE → demande REFUSE + absence NON_JUSTIFIEE, motif du refus obligatoire.
     COMPLEMENT → demande COMPLEMENT_DEMANDE, l'absence reste EN_ATTENTE et
     l'étudiant peut transmettre un nouveau document. */
  router.add('POST', '/api/justificatifs/:id/decision', async ({ req, res, params }) => {
    const user = requireRole(req, ['admin', 'coordinateur']);
    const b = await readJson(req);
    requireFields(b, ['action']);
    const action = str(b.action, 20).toUpperCase();
    if (!['ACCEPT', 'REFUSE', 'COMPLEMENT'].includes(action)) {
      throw new ApiError(400, 'INVALID_ACTION', 'Action invalide : ACCEPT, REFUSE ou COMPLEMENT.');
    }
    const d = db.get();
    const abs = d.prepare(`${BASE_SELECT} WHERE a.id = ?`).get(+params.id);
    if (!abs) throw new ApiError(404, 'ABSENCE_NOT_FOUND', 'Absence introuvable.');
    const j = loadJustificatif(d, abs.id);
    if (!j) throw new ApiError(404, 'JUSTIFICATIF_NOT_FOUND', 'Aucun justificatif associé.');
    if (!canReview(user, abs)) {
      throw new ApiError(403, 'FORBIDDEN', 'Seul l’administration ou le coordinateur de l’option peut statuer.');
    }
    if (j.status === 'JUSTIFIE' || j.status === 'REFUSE') {
      throw new ApiError(409, 'ALREADY_DECIDED', 'Une décision définitive a déjà été prise sur cette demande.');
    }
    const motifRefus = str(b.reason || '', 500);
    const observations = str(b.observations || '', 500);
    if (action === 'REFUSE' && !motifRefus) {
      throw new ApiError(400, 'REASON_REQUIRED', 'Le motif du refus est obligatoire.');
    }
    if (action === 'COMPLEMENT' && !observations) {
      throw new ApiError(400, 'OBSERVATIONS_REQUIRED', 'Précisez ce qui est incomplet ou illisible (complément demandé).');
    }

    const from = j.status;
    const fromAbs = abs.status;
    let to, absTo;
    if (action === 'ACCEPT') { to = DEMAND.JUSTIFIE; absTo = 'JUSTIFIEE'; }
    else if (action === 'REFUSE') { to = DEMAND.REFUSE; absTo = 'NON_JUSTIFIEE'; }
    else { to = DEMAND.COMPLEMENT_DEMANDE; absTo = 'EN_ATTENTE'; }

    d.prepare(`UPDATE justificatifs SET status=?, motif_refus=?, observations=?,
      decided_by=?, decided_at=datetime('now') WHERE id=?`)
      .run(to, motifRefus, observations, user.id, j.id);
    d.prepare("UPDATE absences SET status=?, updated_at=datetime('now') WHERE id=?").run(absTo, abs.id);
    trace(d, j, abs.id, from, to, user, observations || motifRefus || '');
    db.audit(user, 'DECISION_JUSTIFICATIF', 'absence', abs.id, { demand: from, absence: fromAbs }, { demand: to, absence: absTo });

    const label = to === DEMAND.JUSTIFIE ? 'Votre absence est désormais justifiée.'
      : to === DEMAND.REFUSE ? `Justificatif refusé : ${motifRefus}`
        : `Complément demandé : ${observations}`;
    notify(abs.student_id, 'absence', 'Décision sur votre justificatif', label, '#/absences');
    return ok(res, { ok: true, demand_status: to, absence_status: absTo });
  });

  /* ================= NOUVEAU DOCUMENT (étudiant) =================
     Autorisé uniquement après un « complément demandé ». La demande repasse
     « EN_ATTENTE » : aucune justification automatique. */
  router.add('POST', '/api/justificatifs/:id/document', async ({ req, res, params }) => {
    const user = requireRole(req, 'etudiant');
    const b = await readJson(req, 8 * 1024 * 1024);
    requireFields(b, ['document']);
    const d = db.get();
    const j = d.prepare(`SELECT j.*, a.student_id FROM justificatifs j
      JOIN absences a ON a.id = j.absence_id WHERE j.id = ?`).get(+params.id);
    if (!j) throw new ApiError(404, 'JUSTIFICATIF_NOT_FOUND', 'Demande introuvable.');
    if (j.student_id !== user.id) throw new ApiError(403, 'NOT_OWNER', 'Cette demande ne vous appartient pas.');
    if (j.status !== 'COMPLEMENT_DEMANDE') {
      throw new ApiError(409, 'NOT_COMPLEMENT', 'Un nouveau document n’est accepté qu’après un complément demandé.');
    }
    const m = DOC_RE.exec(String(b.document || ''));
    if (!m) throw new ApiError(400, 'INVALID_DOCUMENT', 'Document attendu : PDF, PNG, JPEG ou WebP (données base64).');
    if (m[3].length > DOC_MAX_B64) throw new ApiError(400, 'DOCUMENT_TOO_LARGE', 'Document trop volumineux (5 Mo maximum).');
    const version = (j.version || 1) + 1;
    fs.mkdirSync(JF_DIR, { recursive: true });
    const ext = DOC_EXT[m[1]];
    const fileName = `jf${j.absence_id}_v${version}.${ext}`;
    fs.writeFileSync(path.join(JF_DIR, fileName), Buffer.from(m[3], 'base64'));
    d.prepare(`UPDATE justificatifs SET status='EN_ATTENTE', document_path=?, document_name=?,
      document_mime=?, resubmitted_at=datetime('now'), version=? WHERE id=?`)
      .run(fileName, str(b.document_name || `justificatif_v${version}.${ext}`, 200), m[1], version, j.id);
    d.prepare("UPDATE absences SET status='EN_ATTENTE', updated_at=datetime('now') WHERE id=?").run(j.absence_id);
    const fresh = loadJustificatif(d, j.absence_id);
    trace(d, fresh, j.absence_id, 'COMPLEMENT_DEMANDE', 'EN_ATTENTE', user, `Nouveau document transmis (version ${version}).`);
    db.audit(user, 'NOUVEAU_DOCUMENT_JUSTIFICATIF', 'absence', j.absence_id, { version: j.version }, { version });
    const dayRow = d.prepare('SELECT day, module_label FROM absences WHERE id = ?').get(j.absence_id);
    notifyAdmins('absence', 'Nouveau document transmis',
      `Complément reçu pour l’absence du ${(dayRow && dayRow.day) || ''} — ${(dayRow && dayRow.module_label) || ''}.`, '#/absences/review');
    return ok(res, { ok: true, demand_status: 'EN_ATTENTE', absence_status: 'EN_ATTENTE', version });
  });
};
