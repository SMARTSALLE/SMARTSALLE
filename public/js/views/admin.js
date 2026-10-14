/* SmartSalle ISPITS — écrans administration (utilisateurs, demandes, options, groupes, modules, enseignants, audit, paramètres) */
'use strict';

/* ============ helper CRUD générique ============ */
async function crudView(config) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement…'));
  let rows = [];
  let search = '';
  const isReadOnly = !!config.readOnly;
  const tableBox = h('div', {});

  async function load() {
    const res = await config.load();
    rows = res;
    draw();
  }

  function draw() {
    const filtered = search
      ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(search.toLowerCase()))
      : rows;
    mount(tableBox, table(config.columns(isReadOnly, draw, openForm), filtered, {
      empty: config.empty || 'Aucune donnée pour le moment.',
      emptyIcon: config.emptyIcon || '∅'
    }));
  }

  function openForm(row) {
    const m = modal({ title: row ? config.editTitle(row) : config.createTitle, wide: true, body: h('div', {}) });
    mount($('.modal-body', document.getElementById('modal-root')), form({
      values: row || (config.defaults || {}),
      fields: config.fields(rows),
      submitLabel: row ? 'Enregistrer' : config.createLabel || 'Créer',
      cancel: () => m.close(),
      onSubmit: async (values) => {
        if (row && config.idKey !== undefined) await config.save(values, row[config.idKey]);
        else await config.save(values, null);
        toast(row ? 'Modifications enregistrées.' : 'Élément créé.', 'ok');
        m.close();
        load();
      }
    }));
  }

  mount(root,
    pageHead(config.title, config.subtitle,
      isReadOnly ? [] : [
        h('a', { class: 'btn secondary', href: config.exportXls || '#' }, '⬇ Excel'),
        ...(config.extraActions ? config.extraActions() : []),
        h('button', { class: 'btn', onclick: () => openForm(null) }, config.createButton || '＋ Nouvel élément')
      ].filter(Boolean)),
    h('div', { class: 'filters no-print' },
      h('input', { type: 'text', placeholder: 'Rechercher…', style: { minWidth: '240px' }, oninput: (e) => { search = e.target.value; draw(); } }),
      h('span', { class: 'lbl', style: { marginLeft: 'auto' } }, `${rows.length} élément(s)`)),
    tableBox);
  await load();
  return root;
}

/* ==================== UTILISATEURS ==================== */
function ViewAdminUsers() {
  return crudView({
    title: 'Utilisateurs', subtitle: 'Comptes administration, coordinateurs, enseignants et étudiants',
    exportXls: '/api/export/users.xls',
    idKey: 'id',
    createTitle: 'Nouvel utilisateur', editTitle: (u) => `Modifier ${u.prenom} ${u.nom}`,
    createButton: '＋ Nouvel utilisateur',
    createLabel: 'Créer le compte',
    load: async () => (await get('/api/admin/accounts')).accounts,
    defaults: { role: 'coordinateur' },
    fields: (rows) => [
      { name: 'prenom', label: 'Prénom', required: true },
      { name: 'nom', label: 'Nom', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'role', label: 'Rôle', type: 'select', options: [{ value: 'admin', label: 'ADMINISTRATION' }, { value: 'coordinateur', label: 'COORDINATEUR' }, { value: 'enseignant', label: 'ENSEIGNANT' }, { value: 'etudiant', label: 'ÉTUDIANT' }] },
      /* Fonction : détermine le titre affiché (Coordinateur / Coordinatrice).
         N'influence ni les droits ni les fonctionnalités du compte. */
      { name: 'gender', label: 'Fonction', type: 'select', help: 'Sert uniquement au titre affiché sur les profils et les documents.', options: [{ value: '', label: '— Non renseignée (titre masculin par défaut) —' }, { value: 'M', label: 'COORDINATEUR' }, { value: 'F', label: 'COORDINATRICE' }] },
      { name: 'teacher_id', label: 'Fiche enseignant liée', type: 'select', options: [{ value: '', label: '— Aucune —' }, ...window.__teachers.map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }))], value: '' },
      { name: 'password', label: 'Mot de passe', type: 'password', help: 'Laisser vide pour conserver le mot de passe actuel (lors de la modification).' }
    ],
    save: async (values, id) => {
      if (id) {
        await put(`/api/admin/accounts/${id}`, { prenom: values.prenom, nom: values.nom, email: values.email, role: values.role, gender: values.gender, teacher_id: values.teacher_id ? Number(values.teacher_id) : null });
        if (values.password) await post(`/api/admin/accounts/${id}/password`, { password: values.password });
      } else {
        await post('/api/admin/accounts', values);
      }
    },
    columns: (readOnly, reload, openForm) => [
      { key: 'prenom', label: 'Nom complet', render: (u) => h('div', {}, h('b', {}, `${u.prenom} ${u.nom}`), h('div', { class: 'help' }, u.email)) },
      { key: 'role', label: 'Rôle', render: (u) => badge(roleLabel(u.role), roleKind(u.role)) },
      { key: 'status', label: 'Statut', render: (u) => statusBadge(u.status) },
      { key: 'email_verified', label: 'Email', render: (u) => u.email_verified ? badge('VÉRIFIÉ', 'ok') : badge('NON VÉRIFIÉ', 'warn') },
      { key: 'options', label: 'Options', render: (u) => u.options.length ? u.options.map((o) => badge(o.code, o.status === 'APPROVED' ? 'ok' : (o.status === 'REJECTED' ? 'danger' : 'warn'))) : '—' },
      { key: 'created_at', label: 'Demande', render: (u) => String(u.created_at).slice(0, 16) },
      {
        key: '_a', label: '', render: (u) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openForm(u) }, '✏️'),
          u.status === 'active'
            ? h('button', { class: 'btn sm warn', onclick: async () => { await post(`/api/admin/accounts/${u.id}/status`, { status: 'suspended' }); toast('Compte suspendu.', 'ok'); reload(); } }, 'Suspendre')
            : h('button', { class: 'btn sm ok', onclick: async () => { await post(`/api/admin/accounts/${u.id}/validate`, { force: true }); toast('Compte validé.', 'ok'); reload(); } }, 'Valider'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const ok2 = await confirmBox({ title: 'Supprimer le compte', message: `Supprimer définitivement ${u.email} ?`, confirmLabel: 'Supprimer', danger: true });
              if (!ok2) return;
              try { await del(`/api/admin/accounts/${u.id}`); toast('Compte supprimé.', 'ok'); reload(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '🗑'))
      }
    ]
  });
}

/* ==================== DEMANDES DE COMPTES ==================== */
async function ViewAdminRequests() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des demandes…'));
  const boxAccounts = h('div', {});
  const boxOptions = h('div', {});

  async function drawAccounts() {
    const res = await get('/api/admin/accounts');
    const pending = res.accounts.filter((a) => a.status === 'pending');
    mount(boxAccounts, table([
      { key: 'prenom', label: 'Nom', render: (a) => h('div', {}, h('b', {}, `${a.prenom} ${a.nom}`), h('div', { class: 'help' }, a.email)) },
      { key: 'role', label: 'Rôle', render: (a) => badge(roleLabel(a.role), roleKind(a.role)) },
      { key: 'options', label: 'Options demandées', render: (a) => a.options.length ? a.options.map((o) => badge(o.code, o.status === 'APPROVED' ? 'ok' : (o.status === 'REJECTED' ? 'danger' : 'warn'))) : '—' },
      { key: 'email_verified', label: 'Email vérifié', render: (a) => a.email_verified ? badge('OUI', 'ok') : badge('NON', 'warn') },
      { key: 'created_at', label: 'Date de demande', render: (a) => String(a.created_at).slice(0, 16) },
      { key: 'status', label: 'Statut', render: (a) => statusBadge(a.status) },
      {
        key: '_a', label: 'Actions', render: (a) => h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm ok',
            onclick: async () => {
              try {
                const res2 = await post(`/api/admin/accounts/${a.id}/validate`, { approve_options: a.role === 'coordinateur', force: a.email_verified ? undefined : true });
                toast(res2.message + (res2.approved_options ? ` (${res2.approved_options} option(s) approuvée(s))` : ''), 'ok');
                drawAccounts();
              } catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, 'VALIDER'),
          h('button', {
            class: 'btn sm danger',
            onclick: async () => {
              const reason = await promptBox('Refuser la demande', 'Motif du refus (envoyé au demandeur) :');
              if (reason === null) return;
              try { await post(`/api/admin/accounts/${a.id}/refuse`, { reason }); toast('Demande refusée.', 'ok'); drawAccounts(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, 'REFUSER'))
      }
    ], pending, { empty: 'Aucune demande de compte en attente.', emptyIcon: '✅' }));
  }

  async function drawOptions() {
    const res = await get('/api/admin/options/requests?status=REQUESTED');
    mount(boxOptions, table([
      { key: 'prenom', label: 'Responsable', render: (r) => h('div', {}, h('b', {}, `${coordinatorTitle(r.gender)} ${r.prenom} ${r.nom}`), h('div', { class: 'help' }, r.email)) },
      { key: 'code', label: 'Option demandée', render: (r) => badge(r.code, 'brand') },
      { key: 'email_verified', label: 'Email', render: (r) => r.email_verified ? badge('VÉRIFIÉ', 'ok') : badge('NON', 'warn') },
      { key: 'requested_at', label: 'Date', render: (r) => String(r.requested_at).slice(0, 16) },
      { key: 'status', label: 'Statut', render: (r) => statusBadge(r.status) },
      {
        key: '_a', label: 'Actions', render: (r) => h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm ok', onclick: async () => {
              try { await post(`/api/admin/options/requests/${r.id}/approve`, {}); toast(`Option ${r.code} approuvée.`, 'ok'); drawOptions(); drawAccounts(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, 'VALIDER'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              try { await post(`/api/admin/options/requests/${r.id}/reject`, {}); toast(`Option ${r.code} refusée.`, 'warn'); drawOptions(); drawAccounts(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, 'REFUSER'))
      }
    ], res.requests, { empty: 'Aucune demande d’option en attente.', emptyIcon: '🎯' }));
  }

  mount(root,
    pageHead('Demandes de comptes', 'Vérification email + validation administrative requises avant toute connexion',
      [h('a', { class: 'btn secondary', href: '#/admin/users' }, 'Tous les comptes')]),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, '📨 Demandes de comptes')), boxAccounts),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, '🎯 Demandes d’options (1 à 3 par coordinateur)')), boxOptions));

  await Promise.all([drawAccounts(), drawOptions()]);
  return root;
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

/* ==================== OPTIONS ==================== */
function ViewAdminOptions() {
  return crudView({
    title: 'Options', subtitle: 'Options de formation configurables par l’administration',
    exportXls: '/api/export/options.xls',
    idKey: 'id',
    createTitle: 'Nouvelle option', editTitle: (o) => `Modifier l’option ${o.code}`,
    createButton: '＋ Nouvelle option', createLabel: 'Créer l’option',
    load: async () => (await get('/api/options')).options,
    fields: () => [
      { name: 'code', label: 'Code (ex : IP)', required: true },
      { name: 'name', label: 'Intitulé', required: true },
      {
        name: 'category', label: 'Filière', type: 'select',
        options: [{ value: '', label: '— Sans filière —' }].concat(
          ['Soins Infirmiers', 'Techniques de Santé', 'Rééducation et Réhabilitation', 'Autres Filières']
            .map((c) => ({ value: c, label: c })))
      },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'status', label: 'Statut', type: 'select', options: [{ value: 'ACTIVE', label: 'ACTIVE' }, { value: 'INACTIVE', label: 'INACTIVE' }] }
    ],
    save: async (values, id) => { if (id) await put(`/api/admin/options/${id}`, values); else await post('/api/admin/options', values); },
    columns: (readOnly, reload, openForm) => [
      { key: 'code', label: 'Code', render: (o) => h('b', {}, o.code) },
      { key: 'name', label: 'Intitulé' },
      { key: 'category', label: 'Filière', render: (o) => o.category || '—' },
      { key: 'description', label: 'Description', render: (o) => o.description || '—' },
      { key: 'status', label: 'Statut', render: (o) => statusBadge(o.status) },
      {
        key: '_a', label: '', render: (o) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openForm(o) }, '✏️'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const ok2 = await confirmBox({ title: 'Supprimer l’option', message: `Supprimer l’option ${o.code} ?`, confirmLabel: 'Supprimer', danger: true });
              if (!ok2) return;
              try { await del(`/api/admin/options/${o.id}`); toast('Option supprimée.', 'ok'); reload(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '🗑'))
      }
    ]
  });
}

/* ==================== MODULES ==================== */

/* Ajout rapide : une ligne = un module (CODE | Intitulé | Description | Heures).
   Tous les modules sont créés d'un coup pour le semestre choisi. */
function quickAddModules(onDone) {
  const m = modal({ title: 'Ajout rapide de modules', wide: true, body: h('div', {}) });
  mount($('.modal-body', document.getElementById('modal-root')), form({
    fields: [
      { name: 'option_id', label: 'Option', type: 'select', required: true, options: (window.__options || []).map((o) => ({ value: o.id, label: o.code })) },
      { name: 'semester', label: 'Semestre', type: 'select', options: SEMESTERS.map((s) => ({ value: s, label: s })), value: APP.settings.semester || 'S1' },
      { name: 'academic_year', label: 'Année universitaire', value: APP.settings.academic_year || '2026/2027' },
      { name: 'teacher_id', label: 'Enseignant (optionnel)', type: 'select', options: [{ value: '', label: '— Aucun —' }, ...(window.__teachers || []).map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }))] },
      {
        name: 'lines', label: 'Modules — une ligne par module : CODE | Intitulé | Description | Heures', type: 'textarea', rows: 10, required: true,
        help: 'Exemple : ANGL101 | Anglais médical | Expression écrite et orale, 6h/semaine | 30'
      }
    ],
    submitLabel: '⚡ Créer les modules',
    cancel: () => m.close(),
    onSubmit: async (v) => {
      const modules = String(v.lines || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const parts = line.split('|').map((x) => x.trim());
        return { code: parts[0] || '', name: parts[1] || parts[0] || '', description: parts[2] || '', hours: Number(parts[3]) || 0 };
      }).filter((x) => x.code);
      if (!modules.length) { toast('Aucune ligne valide.', 'err'); return; }
      const res = await post('/api/admin/modules/bulk', {
        option_id: v.option_id, semester: v.semester, academic_year: v.academic_year,
        teacher_id: v.teacher_id ? Number(v.teacher_id) : null, modules
      });
      const skipped = (res.skipped || []).length;
      toast(`${res.created.length} module(s) créé(s)${skipped ? ` · ${skipped} ignoré(s)` : ''}.`, skipped ? 'warn' : 'ok');
      m.close();
      if (onDone) onDone();
    }
  }));
}

function ViewModules() {
  const isAdmin = APP.user.role === 'admin';
  const isTeacher = APP.user.role === 'enseignant';
  return crudView({
    title: isTeacher ? 'Mes modules' : 'Modules',
    subtitle: 'Chaque module porte une description et un semestre : l’emploi se filtre semestre par semestre',
    readOnly: !isAdmin,
    exportXls: '/api/export/modules.xls',
    extraActions: () => [h('button', { class: 'btn secondary', onclick: () => quickAddModules() }, '⚡ Ajout rapide par semestre')],
    idKey: 'id',
    createTitle: 'Nouveau module', editTitle: (m) => `Modifier ${m.code}`,
    createButton: '＋ Nouveau module', createLabel: 'Créer le module',
    load: async () => (await get(isTeacher ? `/api/modules${qs({ teacher_id: APP.user.teacher_id || 0 })}` : '/api/modules')).modules,
    fields: () => [
      { name: 'code', label: 'Code (ex : ANGL101)', required: true },
      { name: 'name', label: 'Intitulé', required: true },
      { name: 'description', label: 'Description du module (contenu du semestre)', type: 'textarea', rows: 3, help: 'Texte affiché dans l’emploi du temps et sur l’impression.' },
      { name: 'option_id', label: 'Option', type: 'select', required: true, options: (window.__options || []).map((o) => ({ value: o.id, label: o.code })) },
      { name: 'group_id', label: 'Groupe', type: 'select', options: [{ value: '', label: '— Aucun —' }, ...(window.__groups || []).map((g) => ({ value: g.id, label: g.code }))] },
      { name: 'teacher_id', label: 'Enseignant', type: 'select', options: [{ value: '', label: '— Aucun —' }, ...(window.__teachers || []).map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }))] },
      { name: 'semester', label: 'Semestre', type: 'select', options: [{ value: 'S1', label: 'S1' }, { value: 'S2', label: 'S2' }, { value: 'S3', label: 'S3' }, { value: 'S4', label: 'S4' }, { value: 'S5', label: 'S5' }, { value: 'S6', label: 'S6' }] },
      { name: 'academic_year', label: 'Année universitaire', value: APP.settings.academic_year || '2026/2027' },
      { name: 'hours', label: 'Volume horaire', type: 'number', min: 0, step: 0.5 },
      { name: 'status', label: 'Statut', type: 'select', options: [{ value: 'ACTIVE', label: 'ACTIF' }, { value: 'INACTIVE', label: 'INACTIF' }] }
    ],
    save: async (values, id) => {
      const payload = {
        ...values, option_id: Number(values.option_id),
        group_id: values.group_id ? Number(values.group_id) : null,
        teacher_id: values.teacher_id ? Number(values.teacher_id) : null,
        hours: Number(values.hours || 0)
      };
      if (id) await put(`/api/admin/modules/${id}`, payload); else await post('/api/admin/modules', payload);
    },
    columns: (readOnly, reload, openForm) => [
      { key: 'code', label: 'Code', render: (m) => h('b', {}, m.code) },
      { key: 'name', label: 'Intitulé' },
      { key: 'description', label: 'Description', render: (m) => h('span', { title: m.description || '' }, m.description || '—') },
      { key: 'option_code', label: 'Option', render: (m) => badge(m.option_code, 'brand') },
      { key: 'group_code', label: 'Groupe' },
      { key: 'teacher_name', label: 'Enseignant', render: (m) => m.teacher_name || '—' },
      { key: 'semester', label: 'Semestre' },
      { key: 'hours', label: 'H', className: 'num' },
      ...(readOnly ? [] : [{
        key: '_a', label: '', render: (m) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openForm(m) }, '✏️'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const ok2 = await confirmBox({ title: 'Supprimer le module', message: `Supprimer ${m.code} ?`, confirmLabel: 'Supprimer', danger: true });
              if (!ok2) return;
              try { await del(`/api/admin/modules/${m.id}`); toast('Module supprimé.', 'ok'); reload(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '🗑'))
      }])
    ]
  });
}

/* ==================== ENSEIGNANTS ==================== */
function ViewTeachers() {
  const isAdmin = APP.user.role === 'admin';
  return crudView({
    title: 'Enseignants', subtitle: 'Aucun enseignant fictif : créez uniquement les enseignants réels de l’ISPITS',
    readOnly: !isAdmin,
    exportXls: '/api/export/teachers.xls',
    idKey: 'id',
    createTitle: 'Nouvel enseignant', editTitle: (t) => `Modifier ${t.full_name || t.nom}`,
    createButton: '＋ Nouvel enseignant', createLabel: 'Créer l’enseignant',
    load: async () => (await get('/api/teachers')).teachers,
    fields: () => [
      { name: 'prenom', label: 'Prénom', required: true },
      { name: 'nom', label: 'Nom', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'specialty', label: 'Spécialité' },
      { name: 'status', label: 'Statut', type: 'select', options: [{ value: 'ACTIVE', label: 'ACTIF' }, { value: 'INACTIVE', label: 'INACTIF' }] }
    ],
    save: async (values, id) => { if (id) await put(`/api/admin/teachers/${id}`, values); else await post('/api/admin/teachers', values); },
    columns: (readOnly, reload, openForm) => [
      { key: 'full_name', label: 'Nom complet', render: (t) => h('b', {}, `${t.prenom} ${t.nom}`) },
      { key: 'email', label: 'Email', render: (t) => t.email || '—' },
      { key: 'specialty', label: 'Spécialité', render: (t) => t.specialty || '—' },
      { key: 'status', label: 'Statut', render: (t) => statusBadge(t.status) },
      ...(readOnly ? [] : [{
        key: '_a', label: '', render: (t) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openForm(t) }, '✏️'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const ok2 = await confirmBox({ title: 'Supprimer l’enseignant', message: `Supprimer ${t.prenom} ${t.nom} ? Ses réservations perdront le lien mais seront conservées.`, confirmLabel: 'Supprimer', danger: true });
              if (!ok2) return;
              try { await del(`/api/admin/teachers/${t.id}`); toast('Enseignant supprimé.', 'ok'); reload(); }
              catch (e) { toast(errorMessage(e), 'err'); }
            }
          }, '🗑'))
      }])
    ]
  });
}

/* ==================== ÉQUIPEMENTS ==================== */
function ViewEquipment() {
  const isAdmin = APP.user.role === 'admin';
  return crudView({
    title: 'Équipements', subtitle: 'Équipements par salle (utilisés comme filtre optionnel dans “Trouver une salle”)',
    readOnly: !isAdmin,
    idKey: 'id',
    createTitle: 'Équipement — nouvelle salle', editTitle: (r) => `Équipements de ${r.code}`,
    createButton: '＋ Nouvelle salle', createLabel: 'Enregistrer',
    load: async () => (await get('/api/rooms')).rooms,
    fields: () => [
      { name: 'code', label: 'Code de salle', required: true },
      { name: 'name', label: 'Nom', required: true },
      { name: 'floor', label: 'Étage', type: 'select', options: [{ value: 'RDC', label: 'Rez-de-chaussée' }, { value: '1ER', label: 'Premier étage' }, { value: 'AMPHI', label: 'Amphithéâtre' }] },
      { name: 'equipment', label: 'Équipements (virgules)', placeholder: 'videoProjecteur, ordinateur, tableau, climatisation' },
      { name: 'bookable', label: 'Réservable normalement', type: 'checkbox' }
    ],
    save: async (values, id) => {
      const payload = { ...values, bookable: !!values.bookable };
      if (id) await put(`/api/admin/rooms/${id}`, payload); else await post('/api/admin/rooms', payload);
    },
    columns: (readOnly, reload, openForm) => [
      { key: 'code', label: 'Salle', render: (r) => h('b', {}, r.code) },
      { key: 'floor', label: 'Étage' },
      { key: 'equipment', label: 'Équipements', render: (r) => r.equipment ? r.equipment.split(',').map((x) => badge(x.trim(), 'info')) : '—' },
      { key: 'bookable', label: 'Réservable', render: (r) => r.bookable ? badge('OUI', 'ok') : badge('MASTER MGMT', 'purple') },
      ...(readOnly ? [] : [{
        key: '_a', label: '', render: (r) => h('div', { class: 'row-actions' },
          h('button', { class: 'btn sm secondary', onclick: () => openForm(r) }, '✏️ Équipements'))
      }])
    ]
  });
}

/* ==================== HISTORIQUE / AUDIT ==================== */
function ViewAudit() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement de l’historique…'));
  const box = h('div', {});
  let action = '';
  let search = '';

  async function draw() {
    const res = await get(`/api/admin/audit${qs({ action, q: search, limit: 300 })}`);
    mount(box, table([
      { key: 'created_at', label: 'Date / heure', render: (a) => h('span', { class: 'help' }, String(a.created_at).replace('T', ' ').slice(0, 19)) },
      { key: 'user_label', label: 'Utilisateur', render: (a) => h('b', {}, a.user_label) },
      { key: 'action', label: 'Action', render: (a) => badge(a.action, actionKind(a.action)) },
      { key: 'entity_type', label: 'Élément', render: (a) => `${a.entity_type || '—'} ${a.entity_id ? '#' + a.entity_id : ''}` },
      { key: 'old_value', label: 'Avant', render: (a) => h('span', { class: 'help', style: { display: 'block', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' } }, a.old_value || '—') },
      { key: 'new_value', label: 'Après', render: (a) => h('span', { class: 'help', style: { display: 'block', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' } }, a.new_value || '—') }
    ], res.history, { empty: 'Aucune activité enregistrée.', emptyIcon: '🕘' }));
  }

  function actionKind(a) {
    if (/SUPPRESSION|REFUS|REJET|VIDER/.test(a)) return 'danger';
    if (/CREATION|VALIDATION|APPROBATION/.test(a)) return 'ok';
    if (/MODIFICATION|REPROGRAMMATION|CHANGEMENT/.test(a)) return 'warn';
    return 'brand';
  }

  mount(root,
    pageHead('Historique / Audit', 'Utilisateur, action, date, heure, élément concerné, ancienne et nouvelle valeur',
      [h('a', { class: 'btn secondary', href: '/api/export/audit.csv' }, '⬇ CSV'), h('a', { class: 'btn secondary', href: '/api/export/audit.xls' }, '⬇ Excel')]),
    h('div', { class: 'filters no-print' },
      h('select', { onchange: (e) => { action = e.target.value; draw(); } },
        h('option', { value: '' }, 'Toutes les actions'),
        ['CREATION_RESERVATION', 'MODIFICATION_RESERVATION', 'ANNULATION_RESERVATION', 'VALIDATION_COMPTE', 'REFUS_COMPTE', 'APPROBATION_OPTION', 'MODIFICATION_SALLE', 'VIDER_PLANNING'].map((a) => h('option', { value: a }, a))),
      h('input', { type: 'text', placeholder: 'Rechercher…', oninput: (e) => { search = e.target.value; draw(); } })),
    box);
  draw();
  return root;
}

/* ==================== PARAMÈTRES ==================== */
async function ViewSettings() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des paramètres…'));
  const res = await get('/api/admin/settings');
  const s = res.settings;

  const logoPreview = h('img', { src: s.logo_url || '/assets/logo-ispits.png', style: { width: '90px', height: '90px', objectFit: 'cover', borderRadius: '12px', border: '1px solid var(--line)' } });
  const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'input', onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 400 * 1024) { toast('Logo trop volumineux (400 Ko max).', 'err'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r2 = await post('/api/admin/settings/logo', { logo_data: reader.result });
        logoPreview.src = r2.logo_url;
        APP.settings.logo_url = r2.logo_url;
        toast('Logo mis à jour.', 'ok');
      } catch (err) { toast(errorMessage(err), 'err'); }
    };
    reader.readAsDataURL(file);
  } });

  const mainForm = form({
    values: s,
    fields: [
      { name: 'institution_name', label: 'Nom de l’établissement', required: true },
      { name: 'app_name', label: 'Nom de l’application' },
      { name: 'subtitle', label: 'Sous-titre' },
      { name: 'semester', label: 'Semestre', type: 'select', options: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((x) => ({ value: x, label: x })) },
      { name: 'academic_year', label: 'Année universitaire', placeholder: '2026/2027' },
      {
        name: 'require_module_validation', label: 'Validation administrative des modules', type: 'select',
        options: [{ value: '0', label: 'Non — les coordinateurs créent directement des modules actifs' },
          { value: '1', label: 'Oui — les modules créés par les coordinateurs attendent votre validation' }]
      },
      { name: 'day_start', label: 'Début de journée', type: 'time' },
      { name: 'day_end', label: 'Fin de journée', type: 'time' },
      { name: 'session_hours', label: 'Durée d’une bande horaire (heures)', type: 'number', help: '2 = lignes 08:00-10:00, 10:00-12:00… à l’impression' },
      { name: 'working_days', label: 'Jours de travail', help: 'mon,tue,wed,thu,fri,sat' },
      { name: 'closed_days', label: 'Jours de fermeture', help: 'sun' }
    ],
    submitLabel: '💾 Enregistrer les paramètres généraux',
    onSubmit: async (values) => {
      const r2 = await put('/api/admin/settings', { settings: values });
      APP.settings = r2.settings;
      toast('Paramètres enregistrés.', 'ok');
    }
  });

  const pdfForm = form({
    values: s,
    fields: [
      { name: 'pdf_header_image', label: 'Image d’en-tête officielle (URL)', help: 'Ex. /assets/entete-officielle.png — vide pour utiliser le texte ci-dessous' },
      { name: 'pdf_footer_image', label: 'Image de pied de page officielle (URL)', help: 'Ex. /assets/pied-officielle.png — vide pour masquer' },
      { name: 'pdf_header', label: 'Texte d’en-tête PDF (une ligne par ligne)', type: 'textarea', rows: 6, help: 'ROYAUME DU MAROC / MINISTÈRE…' },
      { name: 'pdf_extra', label: 'Texte complémentaire / N.B. (optionnel)', type: 'textarea', rows: 2 },
      { name: 'print_show_rooms', label: 'Afficher le nom des salles sur la feuille imprimée', type: 'select', options: [{ value: '1', label: 'Oui' }, { value: '0', label: 'Non' }] },
      { name: 'sig_dac', label: 'Signature — DAC' },
      { name: 'sig_directeur', label: 'Signature — Directeur de l’ISPITS' }
    ],
    submitLabel: '🖨️ Enregistrer l’en-tête et les signatures',
    onSubmit: async (values) => {
      const r2 = await put('/api/admin/settings', { settings: values });
      APP.settings = r2.settings;
      toast('Paramètres d’impression enregistrés.', 'ok');
    }
  });

  /* Test d'envoi réel : appelle /api/admin/settings/smtp-test et affiche le
     résultat (« smtp » = envoyé, « outbox » = copie locale, SMTP absent/faux). */
  const smtpTestBtn = h('button', {
    type: 'button', class: 'btn secondary', style: { marginTop: '12px' },
    onclick: async () => {
      smtpTestBtn.disabled = true;
      const prev = smtpTestBtn.textContent;
      smtpTestBtn.textContent = '⏳ Envoi du test…';
      try {
        const r = await post('/api/admin/settings/smtp-test', {});
        toast(r.message, r.delivered === 'smtp' ? 'ok' : 'warn', 8000);
      } catch (e) { toast(errorMessage(e), 'err'); }
      finally { smtpTestBtn.disabled = false; smtpTestBtn.textContent = prev; }
    }
  }, '📧 Tester l’envoi SMTP');

  const notifForm = form({
    values: s,
    fields: [
      { name: 'notify_reservations', label: 'Notifications de réservation (créée / annulée)', type: 'checkbox' },
      { name: 'notify_accounts', label: 'Notifications de comptes', type: 'checkbox' },
      { name: 'notify_tasks', label: 'Rappels de tâches', type: 'checkbox' },
      { name: 'expose_dev_codes', label: 'Afficher le code de vérification en local (hors production)', type: 'checkbox', help: 'À désactiver en production si SMTP configuré.' },
      { name: 'smtp_host', label: 'Serveur SMTP (vide = boîte locale data/outbox)', placeholder: 'smtp.host.ma', help: 'Tant que vide, aucun email n’est réellement envoyé (copie dans data/outbox).' },
      { name: 'smtp_port', label: 'Port SMTP', help: '587 = STARTTLS · 465 = TLS direct' },
      { name: 'smtp_secure', label: 'Chiffrement SMTP', type: 'select', options: [
        { value: 'starttls', label: 'STARTTLS (port 587)' },
        { value: 'smtps', label: 'TLS direct — SMTPS (port 465)' },
        { value: 'none', label: 'Aucun (SMTP interne / port 25)' }
      ] },
      { name: 'smtp_user', label: 'Utilisateur SMTP', help: 'Le mot de passe n’est pas stocké en base : variable SMTP_PASSWORD (Infisical / .env).' },
      { name: 'smtp_from', label: 'Expéditeur' }
    ],
    after: smtpTestBtn,
    submitLabel: '🔔 Enregistrer les notifications / email',
    onSubmit: async (values) => {
      const payload = {};
      Object.entries(values).forEach(([k, v]) => { payload[k] = typeof v === 'boolean' ? (v ? '1' : '0') : v; });
      const r2 = await put('/api/admin/settings', { settings: payload });
      APP.settings = r2.settings;
      toast('Notifications enregistrées.', 'ok');
    }
  });

  mount(root,
    pageHead('Paramètres', 'Configuration générale de l’établissement, impression PDF et notifications'),
    h('div', { class: 'cols-equal' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, '🏫 Établissement')),
        h('div', { class: 'form-row', style: { alignItems: 'center', marginBottom: '14px' } }, logoPreview, h('div', { class: 'field', style: { flex: 1 } }, h('label', {}, 'Logo'), fileInput, h('div', { class: 'help' }, 'PNG/JPG/SVG · 400 Ko maximum'))),
        mainForm),
      h('div', { class: 'card' },
        h('h3', {}, '🔔 Notifications & email'),
        notifForm)),
    h('div', { class: 'card' },
      h('h3', {}, '🖨️ En-tête d’impression & signatures'),
      pdfForm,
      h('div', { class: 'actions', style: { marginTop: '12px' } },
        h('a', { class: 'btn secondary', href: '#/print' }, '👁 Aperçu de l’impression'))),
    h('div', { class: 'card' },
      h('h3', {}, '🧹 Maintenance'),
      h('div', { class: 'form-row' },
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            const ok2 = await confirmBox({
              title: 'Vider le planning',
              message: 'Cette action supprime uniquement les réservations. Utilisateurs, salles, options, groupes, modules, enseignants et paramètres sont conservés.',
              confirmLabel: 'Vider le planning', danger: true, typed: 'VIDER'
            });
            if (!ok2) return;
            try {
              const r2 = await post('/api/admin/clear-planning', { confirm: 'VIDER' });
              toast(r2.message, 'ok', 6000);
            } catch (e) { toast(errorMessage(e), 'err'); }
          }
        }, '🗑 Vider le planning'))));
  return root;
}

/* ==================== EXPORTS ==================== */
function ViewExport() {
  const items = [
    ['planning', 'Planning de la semaine', '🗓️'],
    ['reservations', 'Réservations', '📅'],
    ['rooms', 'Salles', '🚪'],
    ['groups', 'Groupes', '👥'],
    ['modules', 'Modules', '📚'],
    ['teachers', 'Enseignants', '🎓'],
    ['options', 'Options', '🎯'],
    ['users', 'Utilisateurs (admin)', '👤'],
    ['audit', 'Historique (admin)', '🕘']
  ];
  return h('div', {},
    pageHead('Exports', 'Formats Excel (.xls), CSV et impression PDF via le navigateur'),
    h('div', { class: 'grid stats' },
      items.map(([key, label, icon]) => h('div', { class: 'stat' },
        h('div', { class: 'k' }, icon + ' ' + label),
        h('div', { class: 'actions', style: { marginTop: '10px', display: 'flex', gap: '7px' } },
          h('a', { class: 'btn sm', href: `/api/export/${key}.xls` }, '⬇ Excel'),
          h('a', { class: 'btn sm secondary', href: `/api/export/${key}.csv` }, '⬇ CSV'))))),
    h('div', { class: 'card' },
      h('h3', {}, '🖨️ Impression / PDF'),
      h('p', { class: 'help' }, 'Utilisez la vue d’impression (A4 paysage, en-tête institutionnel et signatures) puis « Enregistrer en PDF » dans le navigateur.'),
      h('a', { class: 'btn', href: '#/print' }, 'Ouvrir la vue d’impression')));
}
