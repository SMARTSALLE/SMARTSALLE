/* SmartSalle ISPITS — Modules et enseignants (organisés par semestre) */
'use strict';

const TEACHING_TYPES = ['COURS', 'TD', 'TP', 'AUTRE'];

function teachTypeOptions(selected) {
  return TEACHING_TYPES.map((t) => ({ value: t, label: t, selected: t === selected }));
}

/* Badge de validation d’un module (statut visible par le coordinateur). */
function validationBadge(m) {
  if (m.validation_status === 'PENDING') return badge('EN ATTENTE DE VALIDATION', 'warn');
  if (m.validation_status === 'REJECTED') return badge('REFUSÉ', 'danger');
  return null;
}

/* ==================== VUE PRINCIPALE ==================== */
async function ViewPedagogy(query) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des modules…'));

  const isAdmin = APP.user.role === 'admin';
  const isCoord = APP.user.role === 'coordinateur';
  const isTeacher = APP.user.role === 'enseignant';

  // Options accessibles : toutes pour l'admin, approuvées pour le coordinateur.
  let accessibleOptions = [];
  if (isAdmin) {
    const res = await get('/api/options');
    accessibleOptions = (res.options || []).filter((o) => o.status === 'ACTIVE');
  } else if (isCoord) {
    accessibleOptions = (APP.user.approved_options || []).filter((o) => o.status !== 'INACTIVE');
    if (!accessibleOptions.length) {
      mount(root, h('div', { class: 'card' }, h('div', { class: 'empty' },
        h('span', { class: 'big' }, '🎯'), 'Aucune option approuvée. Contactez l’administration.')));
      return root;
    }
  }

  const state = {
    tab: query.tab === 'teachers' && !isTeacher ? 'teachers' : 'modules',
    optionId: query.option_id ? +query.option_id : (accessibleOptions[0] || {}).id || null,
    semester: query.semester || APP.settings.semester || 'S1',
    academicYear: query.academic_year || APP.settings.academic_year || '2026/2027',
    search: ''
  };

  let modules = [];
  let assignments = [];
  let teachers = [];

  async function loadData() {
    const [mRes, aRes, tRes] = await Promise.all([
      get('/api/modules' + qs({
        option_id: state.optionId || '', semester: state.semester, academic_year: state.academicYear
      })),
      get('/api/module-teachers' + qs({ semester: state.semester, academic_year: state.academicYear })),
      state.tab === 'teachers' ? get('/api/teachers') : Promise.resolve({ teachers: [] })
    ]);
    modules = (mRes.modules || []).filter((m) => m.status !== 'ARCHIVED');
    assignments = aRes.assignments || [];
    teachers = tRes.teachers || [];
  }

  const tableBox = h('div', {});

  /* ---------- ONGLET MODULES ---------- */
  function drawModules() {
    const q = state.search.toLowerCase();
    const filtered = q
      ? modules.filter((m) =>
          m.code.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) ||
          (m.teacher_name || '').toLowerCase().includes(q))
      : modules;

    mount(tableBox, table([
      ...(isTeacher ? [{ key: 'option_code', label: 'Option', render: (m) => badge(m.option_code, 'brand') }] : []),
      { key: 'code', label: 'Code', render: (m) => h('b', {}, m.code) },
      {
        key: 'name', label: 'Intitulé', render: (m) => h('div', {},
          h('b', {}, m.name),
          validationBadge(m) ? h('span', { style: { marginLeft: '6px' } }, validationBadge(m)) : null,
          m.description ? h('div', { class: 'help' }, m.description) : null)
      },
      {
        key: 'teacher_name', label: 'Enseignant(s)', render: (m) => {
          const asg = assignments.filter((a) => a.module_id === m.id && a.status === 'ACTIVE');
          if (!asg.length) {
            return m.teacher_name
              ? h('div', {}, h('b', {}, m.teacher_name), h('span', { class: 'help' }, ' · fiche module'))
              : h('span', { class: 'help' }, '— Aucun enseignant affecté —');
          }
          return h('div', {}, asg.map((a) => h('div', { style: { marginBottom: '2px' } },
            h('b', {}, a.teacher_name),
            h('span', { class: 'help' }, ` · ${a.teaching_type} · ${a.hours}h`))));
        }
      },
      {
        key: 'hours', label: 'Volume horaire', render: (m) => {
          const parts = [];
          if (m.hours_theory > 0) parts.push(`${m.hours_theory}h cours`);
          if (m.hours_td > 0) parts.push(`${m.hours_td}h TD`);
          if (m.hours_tp > 0) parts.push(`${m.hours_tp}h TP`);
          return h('div', {}, h('b', {}, `${m.hours}h`), parts.length ? h('div', { class: 'help' }, parts.join(' · ')) : null);
        }
      },
      { key: 'semester', label: 'Semestre', render: (m) => badge(m.semester || '—', 'brand') },
      { key: 'academic_year', label: 'Année', render: (m) => h('span', { class: 'help' }, m.academic_year || '—') },
      ...(isTeacher ? [] : [{
        key: '_a', label: '', render: (m) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openModuleForm(m, accessibleOptions) }, '✏️'),
          h('button', { class: 'btn sm secondary', onclick: () => openAssignmentsModal(m) }, '👥 Affectations'),
          isAdmin && m.validation_status === 'PENDING'
            ? h('button', { class: 'btn sm ok', onclick: () => validateModule(m, 'APPROVE') }, '✓ Valider')
            : null,
          isAdmin && m.validation_status === 'PENDING'
            ? h('button', { class: 'btn sm warn', onclick: () => validateModule(m, 'REJECT') }, '✗ Refuser')
            : null,
          h('button', { class: 'btn sm danger', onclick: () => archiveModule(m) }, '🗄'))
      }])
    ], filtered, {
      empty: `Aucun module enregistré pour le semestre ${state.semester}${state.search ? ' correspondant à la recherche' : ''}`,
      emptyIcon: '📚'
    }));
  }

  /* ---------- ONGLET ENSEIGNANTS ---------- */
  function drawTeachers() {
    const q = state.search.toLowerCase();
    const filtered = q
      ? teachers.filter((t) => (t.full_name || '').toLowerCase().includes(q) ||
          (t.email || '').toLowerCase().includes(q) || (t.specialty || '').toLowerCase().includes(q))
      : teachers;

    mount(tableBox, table([
      { key: 'full_name', label: 'Nom et prénom', render: (t) => h('b', {}, t.full_name || `${t.prenom} ${t.nom}`) },
      { key: 'grade', label: 'Grade / fonction', render: (t) => t.grade || '—' },
      { key: 'specialty', label: 'Spécialité', render: (t) => t.specialty || '—' },
      { key: 'establishment', label: 'Établissement / service', render: (t) => t.establishment || '—' },
      { key: 'email', label: 'Email professionnel', render: (t) => t.email || '—' },
      { key: 'phone', label: 'Téléphone', render: (t) => t.phone || '—' },
      { key: 'contract', label: 'Statut', render: (t) => t.contract ? badge(t.contract, t.contract === 'Vacataire' ? 'warn' : 'info') : '—' },
      {
        key: '_m', label: 'Modules attribués', render: (t) => {
          const asg = assignments.filter((a) => a.teacher_id === t.id && a.status === 'ACTIVE');
          if (!asg.length) return h('span', { class: 'help' }, '— Aucun —');
          return h('div', {}, asg.map((a) => h('div', { style: { fontSize: '12px' } },
            h('b', {}, a.module_code), h('span', { class: 'help' }, ` · ${a.semester || a.module_semester} · ${a.teaching_type} · ${a.hours}h`))));
        }
      },
      { key: 'status', label: 'Compte', render: (t) => t.status === 'ACTIVE' ? badge('ACTIF', 'ok') : badge('INACTIF', 'danger') },
      ...(isTeacher ? [] : [{
        key: '_a', label: '', render: (t) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openTeacherForm(t) }, '✏️'),
          isAdmin && t.status === 'ACTIVE'
            ? h('button', {
              class: 'btn sm danger', onclick: async () => {
                if (!(await confirmBox({
                  title: 'Désactiver l’enseignant',
                  message: `Désactiver ${t.full_name || `${t.prenom} ${t.nom}`} ? L’historique et les affectations sont conservés.`,
                  confirmLabel: 'Désactiver', danger: true
                }))) return;
                await del(`/api/teachers/${t.id}`);
                toast('Enseignant désactivé (historique conservé).', 'ok');
                refresh();
              }
            }, '🗄')
            : null)
      }])
    ], filtered, {
      empty: 'Aucun enseignant enregistré.',
      emptyIcon: '🎓'
    }));
  }

  function draw() { if (state.tab === 'teachers') drawTeachers(); else drawModules(); }

  async function refresh() { await loadData(); draw(); }

  let searchInput = null;

  /* ---------- BARRE D’ONGLETS + FILTRES ---------- */
  const tabs = isTeacher ? null : h('div', { class: 'filters no-print', style: { marginBottom: '10px' } },
    h('button', { class: `btn sm ${state.tab === 'modules' ? '' : 'secondary'}`, onclick: () => { state.tab = 'modules'; draw(); } }, '📚 Modules'),
    h('button', { class: `btn sm ${state.tab === 'teachers' ? '' : 'secondary'}`, onclick: () => { state.tab = 'teachers'; state.search = ''; searchInput.value = ''; draw(); } }, '🎓 Enseignants'));

  const filterBar = h('div', { class: 'filters no-print' },
    isTeacher || !accessibleOptions.length ? null : h('span', { class: 'lbl' }, 'Option'),
    isTeacher || !accessibleOptions.length ? null : h('select', { onchange: (e) => { state.optionId = +e.target.value || null; refresh(); } },
      h('option', { value: '' }, 'Toutes mes options'),
      accessibleOptions.map((o) => h('option', { value: o.id, selected: o.id === state.optionId }, `${o.code} — ${o.name}`))),
    state.tab === 'modules' ? h('span', { class: 'lbl' }, 'Semestre') : null,
    state.tab === 'modules' ? h('select', { onchange: (e) => { state.semester = e.target.value; refresh(); } },
      ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((s) => h('option', { value: s, selected: s === state.semester }, s))) : null,
    state.tab === 'modules' ? h('span', { class: 'lbl' }, 'Année') : null,
    state.tab === 'modules' ? h('input', {
      type: 'text', value: state.academicYear, style: { width: '110px' },
      onchange: (e) => { state.academicYear = e.target.value.trim(); refresh(); }
    }) : null,
    (() => {
      const inp = h('input', {
        type: 'text', placeholder: state.tab === 'teachers' ? 'Rechercher un enseignant…' : 'Rechercher module ou enseignant…',
        style: { minWidth: '210px' },
        oninput: (e) => { state.search = e.target.value; draw(); }
      });
      searchInput = inp;
      return inp;
    })(),
    h('span', { class: 'lbl', style: { marginLeft: 'auto' } },
      state.tab === 'teachers' ? `${teachers.length} enseignant(s)` : `${modules.length} module(s)`),
    h('button', { class: 'btn sm secondary', onclick: () => window.print() }, '🖨️ Imprimer'),
    h('a', {
      class: 'btn sm secondary',
      href: state.tab === 'teachers' ? '/api/export/teachers.xls'
        : '/api/export/modules.xls' + qs({ option_id: state.optionId || '', semester: state.semester, academic_year: state.academicYear })
    }, '⬇ Excel'));

  const actions = isTeacher ? null : h('div', { class: 'actions no-print', style: { marginBottom: '14px', display: 'flex', gap: '7px', flexWrap: 'wrap' } },
    h('button', { class: 'btn', onclick: () => openModuleForm(null, accessibleOptions, state) }, '＋ Ajouter un module'),
    h('button', { class: 'btn secondary', onclick: () => openTeacherForm(null) }, '＋ Nouvel enseignant'));

  await loadData();
  draw();

  const optLabel = isTeacher ? '' : (accessibleOptions.find((o) => o.id === state.optionId)
    ? ` · Option ${accessibleOptions.find((o) => o.id === state.optionId).code}` : ' · Toutes vos options');
  mount(root,
    pageHead(isTeacher ? 'Mes modules' : 'Modules et enseignants',
      `${isTeacher ? '' : optLabel} · Semestre ${state.semester} · Année ${state.academicYear} · les modifications sont visibles immédiatement dans l’espace Administration`),
    tabs, filterBar, actions, tableBox);
  return root;
}

/* ==================== FORMULAIRE MODULE ==================== */
function openModuleForm(module, optionsList, state) {
  const isNew = !module;
  const opts = optionsList || (APP.user.role === 'coordinateur' ? APP.user.approved_options : (window.__options || []));
  const m = modal({
    title: isNew ? 'Ajouter un module' : `Modifier ${module.code}`,
    wide: true,
    body: h('div', {})
  });

  mount($('.modal-body', document.getElementById('modal-root')), form({
    values: module || {
      option_id: (state && state.optionId) || (APP.user.role === 'coordinateur' ? (APP.user.approved_options[0] || {}).id : (opts[0] || {}).id),
      semester: (state && state.semester) || 'S1',
      academic_year: (state && state.academicYear) || APP.settings.academic_year || '2026/2027'
    },
    fields: [
      { name: 'code', label: 'Code du module (ex : ANAT101)', required: true },
      { name: 'name', label: 'Intitulé du module', required: true },
      { name: 'description', label: 'Description / observations (facultatif)', type: 'textarea', rows: 3 },
      {
        name: 'option_id', label: 'Option', type: 'select', required: true,
        options: opts.map((o) => ({ value: o.id, label: `${o.category ? o.category + ' / ' : ''}${o.code} — ${o.name}` })),
        help: 'La filière est celle de l’option choisie.'
      },
      {
        name: 'semester', label: 'Semestre', type: 'select', required: true,
        options: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((s) => ({ value: s, label: s }))
      },
      { name: 'academic_year', label: 'Année universitaire', required: true, placeholder: '2026/2027' },
      { name: 'hours', label: 'Volume horaire total (heures)', type: 'number', min: 0, step: 0.5 },
      { name: 'hours_theory', label: 'Répartition — cours théoriques (h)', type: 'number', min: 0, step: 0.5 },
      { name: 'hours_td', label: 'Répartition — travaux dirigés (h)', type: 'number', min: 0, step: 0.5 },
      { name: 'hours_tp', label: 'Répartition — travaux pratiques (h)', type: 'number', min: 0, step: 0.5 },
      {
        name: 'teacher_id', label: 'Enseignant (facultatif)', type: 'select',
        options: [{ value: '', label: '— Aucun (géré via « Affectations ») —' },
          ...(window.__teachers || []).filter((t) => t.status === 'ACTIVE')
            .map((t) => ({ value: t.id, label: t.full_name || `${t.prenom} ${t.nom}` }))],
        help: 'Un module peut avoir plusieurs enseignants : ajoutez-les via « Affectations ».'
      }
    ],
    submitLabel: isNew ? 'Enregistrer' : 'Enregistrer',
    cancel: () => m.close(),
    onSubmit: async (values) => {
      const payload = {
        code: values.code, name: values.name, description: values.description,
        option_id: +values.option_id, semester: values.semester, academic_year: values.academic_year,
        hours: +values.hours || 0, hours_theory: +values.hours_theory || 0,
        hours_td: +values.hours_td || 0, hours_tp: +values.hours_tp || 0,
        teacher_id: values.teacher_id ? +values.teacher_id : null
      };
      if (isNew) {
        const res = await post('/api/modules', payload);
        toast(res.message || 'Module enregistré.', 'ok');
      } else {
        await put(`/api/modules/${module.id}`, payload);
        toast('Module mis à jour.', 'ok');
      }
      m.close();
      window.refresh();
    }
  }));
}

/* ==================== MODALE AFFECTATIONS (N:N) ==================== */
function openAssignmentsModal(module) {
  const box = h('div', {});
  const m = modal({
    title: `Affectations — ${module.code} · ${module.name}`,
    wide: true,
    body: box
  });
  const listBox = h('div', {});

  async function drawList() {
    const res = await get('/api/module-teachers', qs({ module_id: module.id }));
    const list = (res.assignments || []).filter((a) => a.status === 'ACTIVE');
    mount(listBox, table([
      { key: 'teacher_name', label: 'Enseignant', render: (a) => h('b', {}, a.teacher_name) },
      { key: 'teaching_type', label: 'Type d’enseignement', render: (a) => badge(a.teaching_type, 'info') },
      { key: 'hours', label: 'Volume horaire', render: (a) => `${a.hours} h` },
      { key: 'academic_year', label: 'Année' },
      { key: '_a', label: '', render: (a) => h('div', { class: 'row-actions' },
        h('button', { class: 'btn sm secondary', onclick: () => editAssignment(a) }, '✏️'),
        h('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!(await confirmBox({
              title: 'Archiver l’affectation',
              message: `Archiver ${a.teacher_name} sur ${module.code} ? L’historique est conservé.`,
              confirmLabel: 'Archiver', danger: true
            }))) return;
            await del(`/api/module-teachers/${a.id}`);
            toast('Affectation archivée (historique conservé).', 'ok');
            drawList();
          }
        }, '🗄'))
      }
    ], list, { empty: 'Aucun enseignant affecté à ce module.', emptyIcon: '👥' }));
  }

  function editAssignment(a) {
    const em = modal({ title: `Modifier l’affectation — ${a.teacher_name}`, body: h('div', {}) });
    mount($('.modal-body', document.getElementById('modal-root')), form({
      values: a,
      fields: [
        { name: 'hours', label: 'Volume horaire attribué (h)', type: 'number', min: 0, step: 0.5, required: true },
        { name: 'teaching_type', label: 'Type d’enseignement', type: 'select', required: true, options: teachTypeOptions(a.teaching_type) },
        { name: 'notes', label: 'Observations (facultatif)', type: 'textarea', rows: 2 }
      ],
      submitLabel: 'Enregistrer',
      cancel: () => em.close(),
      onSubmit: async (values) => {
        await put(`/api/module-teachers/${a.id}`, { hours: +values.hours || 0, teaching_type: values.teaching_type, notes: values.notes });
        toast('Affectation mise à jour.', 'ok');
        em.close();
        drawList();
      }
    }));
  }

  const addForm = form({
    inline: true,
    fields: [
      {
        name: 'teacher_id', label: 'Enseignant', type: 'select', required: true,
        options: [{ value: '', label: '— Choisir —' },
          ...(window.__teachers || []).filter((t) => t.status === 'ACTIVE')
            .map((t) => ({ value: t.id, label: t.full_name || `${t.prenom} ${t.nom}` }))]
      },
      { name: 'hours', label: 'Volume horaire (h)', type: 'number', min: 0, step: 0.5, required: true, value: module.hours || '' },
      { name: 'teaching_type', label: 'Type', type: 'select', required: true, options: teachTypeOptions('COURS') },
      { name: 'notes', label: 'Observations', type: 'textarea', rows: 2 }
    ],
    submitLabel: '＋ Affecter l’enseignant',
    onSubmit: async (values) => {
      if (!values.teacher_id) { toast('Choisissez un enseignant.', 'warn'); return; }
      const res = await post('/api/module-teachers', {
        module_id: module.id, teacher_id: +values.teacher_id,
        academic_year: module.academic_year, semester: module.semester,
        hours: +values.hours || 0, teaching_type: values.teaching_type, notes: values.notes
      });
      toast(res.message || 'Affectation ajoutée.', 'ok');
      drawList();
    }
  });

  mount(box,
    h('p', { class: 'help', style: { marginTop: 0 } },
      `Semestre ${module.semester} · année ${module.academic_year} · volume total ${module.hours}h. ` +
      'Un module peut avoir plusieurs enseignants et un enseignant plusieurs modules.'),
    h('h3', {}, 'Enseignants affectés'),
    listBox,
    h('h3', { style: { marginTop: '16px' } }, 'Affecter un enseignant'),
    addForm);
  drawList();
}

/* ==================== FORMULAIRE ENSEIGNANT ==================== */
function openTeacherForm(teacher) {
  const isNew = !teacher;
  const m = modal({
    title: isNew ? 'Nouvel enseignant' : `Modifier ${teacher.full_name || `${teacher.prenom} ${teacher.nom}`}`,
    wide: true,
    body: h('div', {})
  });

  mount($('.modal-body', document.getElementById('modal-root')), form({
    values: teacher || {},
    fields: [
      { name: 'nom', label: 'Nom', required: true },
      { name: 'prenom', label: 'Prénom', required: true },
      { name: 'email', label: 'Email professionnel', type: 'email' },
      { name: 'phone', label: 'Téléphone professionnel (facultatif)' },
      { name: 'grade', label: 'Grade ou fonction', placeholder: 'Professeur, Maître de conférences, Vacataire…' },
      { name: 'specialty', label: 'Spécialité' },
      { name: 'establishment', label: 'Établissement ou service d’affectation' },
      {
        name: 'contract', label: 'Statut', type: 'select',
        options: [{ value: '', label: '— Non précisé —' },
          ...['Permanent', 'Vacataire', 'Contractuel', 'Autre'].map((x) => ({ value: x, label: x }))]
      },
      { name: 'notes', label: 'Observations (facultatif)', type: 'textarea', rows: 3 }
    ],
    submitLabel: isNew ? 'Enregistrer' : 'Enregistrer',
    cancel: () => m.close(),
    onSubmit: async (values) => {
      if (isNew) {
        await post('/api/teachers', values);
        toast('Enseignant enregistré.', 'ok');
      } else {
        await put(`/api/teachers/${teacher.id}`, values);
        toast('Enseignant mis à jour.', 'ok');
      }
      m.close();
      window.refresh();
    }
  }));
}

/* ==================== VALIDATION / ARCHIVAGE ==================== */
async function validateModule(module, action) {
  const comment = await promptBox(
    action === 'APPROVE' ? 'Valider le module' : 'Refuser le module',
    action === 'APPROVE' ? 'Commentaire (facultatif)' : 'Motif du refus (affiché au coordinateur)'
  );
  if (comment === null) return;
  const res = await post(`/api/admin/modules/${module.id}/validate`, { action, comment });
  toast(res.message || (action === 'APPROVE' ? 'Module validé.' : 'Module refusé.'), action === 'APPROVE' ? 'ok' : 'warn');
  window.refresh();
}

async function archiveModule(module) {
  if (!(await confirmBox({
    title: 'Archiver le module',
    message: `Archiver ${module.code} — ${module.name} ? Il disparaîtra des listes actives ; l’historique et les affectations sont conservés.`,
    confirmLabel: 'Archiver', danger: true
  }))) return;
  const res = await del(`/api/modules/${module.id}`);
  toast(res.message || 'Module archivé.', 'ok');
  window.refresh();
}

function promptBox(title, message) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', class: 'input', placeholder: message });
    const m = modal({
      title,
      body: h('div', {}, h('p', { class: 'help' }, message), input),
      foot: [
        h('button', { class: 'btn secondary', onclick: () => { m.close(); resolve(null); } }, 'Annuler'),
        h('button', { class: 'btn', onclick: () => { m.close(); resolve(input.value); } }, 'Confirmer')
      ]
    });
    setTimeout(() => input.focus(), 60);
  });
}
