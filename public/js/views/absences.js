/* SmartSalle ISPITS — absences et justificatifs
   Règle essentielle : le DÉPÔT d'un justificatif ne valide jamais l'absence.
   Deux statuts toujours distincts et affichés séparément :
     · statut de la DEMANDE de justificatif (table justificatifs)
     · statut ADMINISTRATIF de l'absence (table absences)
   Une absence n'est « JUSTIFIÉE » qu'après décision d'une personne habilitée. */
'use strict';

const DEMAND_LABEL = {
  EN_ATTENTE: 'EN ATTENTE DE VÉRIFICATION',
  JUSTIFIE: 'JUSTIFICATIF ACCEPTÉ',
  REFUSE: 'JUSTIFICATIF REFUSÉ',
  COMPLEMENT_DEMANDE: 'COMPLÉMENT DEMANDÉ'
};
const DEMAND_KIND = { EN_ATTENTE: 'warn', JUSTIFIE: 'ok', REFUSE: 'danger', COMPLEMENT_DEMANDE: 'info' };
const ABSENCE_LABEL = {
  EN_ATTENTE: 'ABSENCE EN ATTENTE DE DÉCISION',
  JUSTIFIEE: 'ABSENCE JUSTIFIÉE',
  NON_JUSTIFIEE: 'ABSENCE NON JUSTIFIÉE'
};
const ABSENCE_KIND = { EN_ATTENTE: 'warn', JUSTIFIEE: 'ok', NON_JUSTIFIEE: 'danger' };

function demandBadge(s) { return badge(DEMAND_LABEL[s] || s || '—', DEMAND_KIND[s]); }
function absenceBadge(s) { return badge(ABSENCE_LABEL[s] || s || '—', ABSENCE_KIND[s]); }

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    r.readAsDataURL(file);
  });
}

function docFileField() {
  const input = h('input', {
    type: 'file', name: 'document', id: 'f_document',
    accept: '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp'
  });
  const node = h('div', { class: 'field' },
    h('label', { for: 'f_document' }, 'Justificatif ', h('span', { class: 'req' }, ' *')),
    input,
    h('div', { class: 'help' }, 'PDF, PNG, JPEG ou WebP — 5 Mo maximum.'));
  return { input, node };
}

async function readDocument(input) {
  const f = input.files && input.files[0];
  if (!f) throw new Error('Joignez votre justificatif (fichier obligatoire).');
  if (f.size > 5 * 1024 * 1024) throw new Error('Document trop volumineux (5 Mo maximum).');
  const dataUrl = await fileToDataUrl(f);
  return { document: dataUrl, document_name: f.name };
}

/* ==================== DISPATCH ==================== */
function ViewAbsences(q) {
  const role = APP.user.role;
  if (role === 'etudiant') return ViewMyAbsences();
  if (role === 'enseignant') return ViewTeacherAbsences();
  return ViewAbsencesReview(q);
}

/* ==================== ÉTUDIANT : déposer + suivre ==================== */
async function ViewMyAbsences() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement de vos absences…'));
  const box = h('div', {});
  let meta = { modules: [], teachers: [] };

  async function draw() {
    const res = await get('/api/absences/mine');
    const rows = res.absences || [];
    mount(box,
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Comment ça marche')),
        h('div', { class: 'help', style: { lineHeight: 1.8 } },
          '1. Vous déposez votre justificatif → la demande passe « En attente de vérification », l’absence reste NON justifiée. ',
          '2. Une personne habilitée examine le document. ',
          '3. Si le justificatif est accepté, l’absence devient « Justifiée » ; s’il est refusé, elle devient « Non justifiée » (motif du refus indiqué) ; si le document est incomplet ou illisible, un « Complément demandé » vous permet d’en transmettre un nouveau. ',
          '4. Chaque changement de statut est tracé (auteur, date, commentaire).')),
      rows.length
        ? table([
          { key: 'day', label: 'Date', render: (a) => fmtDay(a.day) },
          { key: 'hor', label: 'Horaires', render: (a) => `${a.start} – ${a.end}` },
          { key: 'module_label', label: 'Module' },
          { key: 'teacher_label', label: 'Enseignant' },
          { key: 'st', label: 'Statut de l’absence', render: (a) => absenceBadge(a.absence_status) },
          { key: 'dm', label: 'Statut de la demande', render: (a) => demandBadge((a.justificatif || {}).status) },
          {
            key: '_a', label: '', render: (a) => h('div', { class: 'row-actions' },
              h('button', { class: 'btn sm secondary', onclick: () => openAbsenceDetail(a.id, draw) }, '👁 Détail'),
              (a.justificatif && a.justificatif.has_document)
                ? h('a', { class: 'btn sm secondary', href: `/api/justificatifs/${a.justificatif.id}/document`, target: '_blank', rel: 'noopener' }, '📄 Pièce')
                : null,
              (a.justificatif && a.justificatif.status === 'COMPLEMENT_DEMANDE')
                ? h('button', { class: 'btn sm', onclick: () => openResubmit(a.justificatif) }, '📤 Nouveau document')
                : null)
          }
        ], rows, { empty: 'Aucune absence déclarée.', emptyIcon: '🗓️' })
        : null);
  }

  function openResubmit(j) {
    const doc = docFileField();
    const m = modal({
      title: 'Transmettre un nouveau document',
      body: h('div', {},
        h('p', { class: 'help' }, 'Un complément a été demandé : votre nouveau document repasse la demande « En attente de vérification ». L’absence n’est pas justifiée tant qu’aucune décision n’est prise.'),
        form({
          fields: [],
          after: doc.node,
          submitLabel: 'Envoyer le document',
          cancel: () => m.close(),
          onSubmit: async () => {
            const payload = await readDocument(doc.input);
            const res = await post(`/api/justificatifs/${j.id}/document`, payload);
            toast(`Document transmis (version ${res.version}) — demande de nouveau en attente de vérification.`, 'ok');
            m.close();
            draw();
          }
        }))
    });
  }

  async function openDeposit() {
    try { meta = (await get('/api/absences/meta')); } catch (e) { meta = { modules: [], teachers: [] }; }
    const modules = meta.modules || [];
    const teachers = meta.teachers || [];
    const doc = docFileField();
    const teacherSel = h('select', { name: 'teacher_id', id: 'f_teacher_id' },
      h('option', { value: '' }, '— Enseignant du module —'),
      teachers.map((t) => h('option', { value: String(t.id) }, `${t.prenom} ${t.nom}`)));
    const moduleSel = h('select', { name: 'module_id', id: 'f_module_id', required: true },
      h('option', { value: '' }, '— Choisir un module —'),
      modules.map((m2) => h('option', { value: String(m2.id) }, `${m2.code} — ${m2.name}${m2.option_code ? ` (${m2.option_code})` : ''}`)));
    moduleSel.addEventListener('change', () => {
      const mod = modules.find((x) => String(x.id) === moduleSel.value);
      teacherSel.value = mod && mod.teacher_id ? String(mod.teacher_id) : '';
    });

    const m = modal({
      title: 'Déposer un justificatif d’absence',
      wide: true,
      body: h('div', {},
        h('div', { class: 'card', style: { borderLeft: '4px solid var(--warn)', marginBottom: '14px' } },
          h('b', {}, 'Le dépôt ne valide pas votre absence. '),
          h('span', { class: 'help' }, 'Votre demande sera « En attente de vérification » jusqu’à la décision d’un responsable habilité.')),
        form({
          fields: [
            { name: 'day', label: 'Date de l’absence', type: 'date', required: true, value: todayISO() },
            { name: 'start', label: 'Début', type: 'select', required: true, value: '08:00', options: timeOptions(7, 20) },
            { name: 'end', label: 'Fin', type: 'select', required: true, value: '10:00', options: timeOptions(7, 20) },
            { name: 'motif', label: 'Motif de l’absence', type: 'textarea', rows: 3, required: true, placeholder: 'Ex. : rendez médical, certificat d’arrêt de travail…' }
          ],
          after: h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', { for: 'f_module_id' }, 'Module ', h('span', { class: 'req' }, ' *')), moduleSel,
              h('div', { class: 'help' }, modules.length ? `${modules.length} module(s) actif(s)` : 'Aucun module disponible.')),
            h('div', { class: 'field' }, h('label', { for: 'f_teacher_id' }, 'Enseignant'), teacherSel),
            doc.node),
          submitLabel: 'Envoyer la demande',
          cancel: () => m.close(),
          onSubmit: async (values) => {
            if (!values.module_id) throw new Error('Choisissez le module concerné.');
            const payload = await readDocument(doc.input);
            const res = await post('/api/absences', {
              day: values.day,
              start: values.start,
              end: values.end,
              module_id: Number(values.module_id),
              teacher_id: values.teacher_id ? Number(values.teacher_id) : null,
              motif: values.motif,
              ...payload
            });
            toast(`Demande déposée — statut : « En attente de vérification ». L’absence n’est pas encore justifiée.`, 'ok');
            m.close();
            draw();
            return res;
          }
        }))
    });
  }

  mount(root,
    pageHead('Mes absences', 'Dépôt d’un justificatif et suivi de vos demandes',
      [h('button', { class: 'btn', onclick: openDeposit }, '＋ Déposer un justificatif')]),
    box);
  await draw();
  return root;
}

/* ==================== VÉRIFICATION (administration / coordinateur) ==================== */
async function ViewAbsencesReview(q) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des demandes…'));
  const box = h('div', {});
  const state = { status: (q && q.status) || '', option_id: (q && q.option_id) || '' };
  const options = window.__options || [];

  async function draw() {
    const res = await get(`/api/absences${qs({ status: state.status, option_id: state.option_id })}`);
    const rows = res.absences || [];
    const pending = rows.filter((a) => a.absence_status === 'EN_ATTENTE').length;
    mount(box,
      h('div', { class: 'stats grid' },
        statCard('À vérifier', pending, 'en attente de décision', pending ? 'warn' : 'ok'),
        statCard('Absences justifiées', rows.filter((a) => a.absence_status === 'JUSTIFIEE').length, 'décision favorable', 'ok'),
        statCard('Absences non justifiées', rows.filter((a) => a.absence_status === 'NON_JUSTIFIEE').length, 'refusé', 'danger'),
        statCard('Total', rows.length, 'absences déclarées')),
      rows.length
        ? table([
          { key: 'day', label: 'Date', render: (a) => fmtDay(a.day) },
          { key: 'hor', label: 'Horaires', render: (a) => `${a.start} – ${a.end}` },
          { key: 'student_name', label: 'Étudiant' },
          { key: 'module_label', label: 'Module' },
          { key: 'st', label: 'Absence', render: (a) => absenceBadge(a.absence_status) },
          { key: 'dm', label: 'Demande', render: (a) => demandBadge((a.justificatif || {}).status) },
          {
            key: '_a', label: '', render: (a) => h('div', { class: 'row-actions' },
              h('button', {
                class: `btn sm${a.absence_status === 'EN_ATTENTE' ? '' : ' secondary'}`,
                onclick: () => openAbsenceDetail(a.id, draw)
              }, a.absence_status === 'EN_ATTENTE' ? '🔎 Examiner' : '👁 Détail'))
          }
        ], rows, { empty: 'Aucune absence déclarée pour ce filtre.', emptyIcon: '📋' })
        : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'big' }, '✅'), 'Aucune demande à traiter.')));

    const statusSel = $('#abs-status');
    const optionSel = $('#abs-option');
    if (statusSel) statusSel.value = state.status;
    if (optionSel) optionSel.value = state.option_id;
  }

  const filters = h('div', { class: 'card no-print' },
    h('div', { class: 'form-row', style: { alignItems: 'flex-end' } },
      h('div', { class: 'field' }, h('label', {}, 'Statut de l’absence'),
        h('select', {
          id: 'abs-status', onchange: (e) => { state.status = e.target.value; draw(); }
        },
          h('option', { value: '' }, 'Tous'),
          h('option', { value: 'EN_ATTENTE' }, 'En attente de décision'),
          h('option', { value: 'JUSTIFIEE' }, 'Justifiées'),
          h('option', { value: 'NON_JUSTIFIEE' }, 'Non justifiées'))),
      options.length ? h('div', { class: 'field' }, h('label', {}, 'Option'),
        h('select', { id: 'abs-option', onchange: (e) => { state.option_id = e.target.value; draw(); } },
          h('option', { value: '' }, 'Toutes'),
          options.map((o) => h('option', { value: String(o.id) }, o.code)))) : null));

  mount(root,
    pageHead('Absences et justificatifs', 'Vérification des demandes — le dépôt ne valide jamais une absence par lui-même'),
    h('div', { class: 'card', style: { borderLeft: '4px solid var(--brand, #0f3d6e)' } },
      h('span', { class: 'help' }, 'Seuls l’administration et le coordinateur de l’option concernée peuvent accepter, refuser ou demander un complément. Chaque décision est tracée (identité, date, observations).')),
    filters,
    box);
  await draw();
  return root;
}

/* ==================== ENSEIGNANT : statut seul ==================== */
async function ViewTeacherAbsences() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des absences…'));
  const box = h('div', {});

  async function draw() {
    const res = await get('/api/absences/enseignant');
    const rows = res.absences || [];
    mount(box, rows.length
      ? table([
        { key: 'day', label: 'Date', render: (a) => fmtDay(a.day) },
        { key: 'hor', label: 'Horaires', render: (a) => `${a.start} – ${a.end}` },
        { key: 'module_label', label: 'Module' },
        { key: 'student_name', label: 'Étudiant' },
        { key: 'st', label: 'Statut de l’absence', render: (a) => absenceBadge(a.absence_status) },
        { key: 'dm', label: 'Statut de la demande', render: (a) => demandBadge(a.demand_status) }
      ], rows, { empty: 'Aucune absence déclarée pour vos cours.', emptyIcon: '🗓️' })
      : h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'big' }, '🗓️'), 'Aucune absence déclarée pour vos cours.')));
  }

  mount(root,
    pageHead('Absences de mes cours', 'Statut de justification — consultation seule'),
    h('div', { class: 'card' },
      h('span', { class: 'help' },
        'Vous consultez ici le STATUT des absences de vos cours. Les motifs, les pièces justificatives (certificats médicaux) et les observations restent confidentiels : cette vue ne les contient pas, et la décision appartient exclusivement aux personnes habilitées.')),
    box);
  await draw();
  return root;
}

/* ==================== DÉTAIL + DÉCISION + HISTORIQUE ==================== */
async function openAbsenceDetail(id, onChanged) {
  const body = h('div', {});
  const m = modal({
    title: 'Absence — détail et historique',
    wide: true,
    body,
    foot: [h('button', { class: 'btn secondary', onclick: () => m.close() }, 'Fermer')]
  });

  async function draw() {
    mount(body, loadingCard('Chargement…'));
    let res;
    try {
      res = await get(`/api/absences/${id}`);
    } catch (e) {
      mount(body, h('div', { class: 'empty' }, errorMessage(e)));
      return;
    }
    const a = res.absence;
    const j = a.justificatif || null;
    const history = res.history || [];
    const canDecide = APP.user && (APP.user.role === 'admin' || APP.user.role === 'coordinateur')
      && j && !['JUSTIFIE', 'REFUSE'].includes(j.status);

    const infos = h('div', { class: 'form-grid', style: { marginBottom: '12px' } },
      infoCell('Étudiant', a.student_name || '—'),
      infoCell('Date', fmtDay(a.day)),
      infoCell('Horaires', `${a.start} – ${a.end}`),
      infoCell('Module', a.module_label),
      infoCell('Enseignant', a.teacher_label || '—'),
      infoCell('Option', a.option_code || '—'),
      infoCell('Statut de l’absence', absenceBadge(a.absence_status)),
      infoCell('Statut de la demande', demandBadge(j && j.status)));

    const motifBox = (APP.user.role !== 'enseignant' && a.motif)
      ? h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'card-head' }, h('h3', {}, 'Motif déclaré')),
        h('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, a.motif))
      : null;

    /* Pièce confidentielle : servie par une route protégée, jamais en statique. */
    const docBox = (APP.user.role !== 'enseignant' && j && j.has_document)
      ? h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'card-head' },
          h('h3', {}, `Pièce justificative (version ${j.version || 1})`),
          h('div', { class: 'actions' },
            h('a', { class: 'btn sm secondary', href: `/api/justificatifs/${j.id}/document`, target: '_blank', rel: 'noopener' }, 'Ouvrir la pièce'))),
        j.document_mime === 'application/pdf'
          ? h('iframe', { src: `/api/justificatifs/${j.id}/document`, style: { width: '100%', height: '420px', border: '1px solid var(--line, #dbe3ee)', borderRadius: '8px' } })
          : h('img', { src: `/api/justificatifs/${j.id}/document`, alt: j.document_name || 'justificatif', style: { maxWidth: '100%', maxHeight: '420px', borderRadius: '8px', border: '1px solid var(--line, #dbe3ee)' } }),
        h('div', { class: 'help' }, j.document_name || ''))
      : null;

    const refusalBox = (j && (j.status === 'REFUSE' || j.status === 'COMPLEMENT_DEMANDE'))
      ? h('div', { class: 'card', style: { borderLeft: '4px solid var(--danger)', marginBottom: '12px' } },
        j.motif_refus ? h('div', {}, h('b', {}, 'Motif du refus : '), h('span', {}, j.motif_refus)) : null,
        j.observations ? h('div', { style: { marginTop: j.motif_refus ? '6px' : 0 } }, h('b', {}, 'Observations : '), h('span', {}, j.observations)) : null,
        j.decided_by_name ? h('div', { class: 'help', style: { marginTop: '6px' } },
          `Décision de ${j.decided_by_name}${j.decided_at ? ` le ${String(j.decided_at).slice(0, 16).replace('T', ' ')}` : ''}`) : null)
      : null;

    /* Panneau de décision : réservé aux habilités, jamais à l'étudiant. */
    const reason = h('textarea', { class: 'input', rows: '2', placeholder: 'Motif du refus (obligatoire pour un refus)' });
    const obs = h('textarea', { class: 'input', rows: '2', placeholder: 'Observations (obligatoires pour un complément demandé)' });
    const decideBox = canDecide
      ? h('div', { class: 'card', style: { marginBottom: '12px' } },
        h('div', { class: 'card-head' }, h('h3', {}, 'Décision (personnes habilitées uniquement)')),
        h('div', { class: 'field' }, h('label', {}, 'Motif du refus'), reason),
        h('div', { class: 'field' }, h('label', {}, 'Observations'), obs),
        h('div', { class: 'actions', style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', {
            class: 'btn ok', onclick: async () => {
              try {
                const r = await post(`/api/justificatifs/${j.id}/decision`, { action: 'ACCEPT', observations: obs.value });
                toast(`Décision enregistrée — ${ABSENCE_LABEL[r.absence_status]}.`, 'ok');
                draw(); if (onChanged) onChanged();
              } catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '✅ Accepter le justificatif'),
          h('button', {
            class: 'btn danger', onclick: async () => {
              try {
                const r = await post(`/api/justificatifs/${j.id}/decision`, { action: 'REFUSE', reason: reason.value, observations: obs.value });
                toast(`Décision enregistrée — ${ABSENCE_LABEL[r.absence_status]}.`, 'ok');
                draw(); if (onChanged) onChanged();
              } catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '⛔ Refuser'),
          h('button', {
            class: 'btn secondary', onclick: async () => {
              try {
                const r = await post(`/api/justificatifs/${j.id}/decision`, { action: 'COMPLEMENT', observations: obs.value });
                toast('Complément demandé : l’étudiant peut transmettre un nouveau document.', 'ok');
                draw(); if (onChanged) onChanged();
              } catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '📄 Demander un complément')))
      : (APP.user.role === 'enseignant'
        ? null
        : APP.user.role === 'etudiant'
          /* L'étudiant consulte : il ne peut ni décider ni modifier le statut. */
          ? h('div', { class: 'card' }, h('span', { class: 'help' },
            !j ? 'Aucun justificatif associé à cette absence.'
              : ['JUSTIFIE', 'REFUSE'].includes(j.status)
                ? `Décision prise par ${j.decided_by_name || 'un responsable habilité'}${j.decided_at ? ` le ${String(j.decided_at).slice(0, 16).replace('T', ' ')}` : ''} : vous ne pouvez pas modifier ce statut.`
                : j.status === 'COMPLEMENT_DEMANDE'
                  ? 'Un complément est demandé : transmettez un nouveau document depuis la liste. Le statut ne peut être modifié que par un responsable habilité.'
                  : 'Votre demande est en attente de vérification : seul un responsable habilité peut l’accepter ou la refuser. Le dépôt ne justifie pas l’absence.'))
          : h('div', { class: 'card' }, h('span', { class: 'help' },
            j && ['JUSTIFIE', 'REFUSE'].includes(j.status)
              ? 'Décision définitive déjà prise sur cette demande.'
              : 'Aucun justificatif à examiner.')));

    const histBox = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Historique des statuts')),
      history.length
        ? table([
          { key: 'created_at', label: 'Date', render: (x) => String(x.created_at).slice(0, 16).replace('T', ' ') },
          { key: 'trajet', label: 'Changement', render: (x) => `${x.from_status ? (DEMAND_LABEL[x.from_status] || x.from_status) + ' → ' : ''}${DEMAND_LABEL[x.to_status] || x.to_status}` },
          { key: 'actor_label', label: 'Auteur' },
          { key: 'comment', label: 'Commentaire' }
        ], history, { empty: 'Aucun changement enregistré.' })
        : h('div', { class: 'empty' }, 'Aucun changement enregistré.'));

    mount(body, infos, motifBox, docBox, refusalBox, decideBox, histBox);
  }

  await draw();
  return m;
}

function infoCell(label, value) {
  return h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { style: { fontSize: '14px', fontWeight: '600' } }, value === null || value === undefined || value === '' ? '—' : value));
}
