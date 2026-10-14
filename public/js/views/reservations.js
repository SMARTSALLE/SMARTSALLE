/* SmartSalle ISPITS — réservations : liste, création, modification, reprogrammation, copie */
'use strict';

async function loadCatalogData() {
  const [options, groups, modules, teachers, rooms, mt] = await Promise.all([
    get('/api/options'), get('/api/groups'), get('/api/modules'), get('/api/teachers'), get('/api/rooms'),
    get('/api/module-teachers').catch(() => ({ assignments: [] }))
  ]);
  return {
    options: (options.options || []).filter((o) => o.status === 'ACTIVE'),
    groups: groups.groups || [],
    modules: (modules.modules || []).filter((m) => m.status !== 'ARCHIVED'),
    teachers: (teachers.teachers || []).filter((t) => t.status === 'ACTIVE'),
    /* Affectations enseignants → modules : quand un module est choisi dans le
       formulaire, seuls les enseignants qui lui sont affectés sont proposés. */
    assignments: (mt.assignments || []).filter((a) => a.status === 'ACTIVE'),
    rooms: (rooms.rooms || []).filter((r) => r.status !== 'INACTIVE' && (APP.user.role === 'admin' || r.bookable))
  };
}

/* Remplit dynamiquement une liste déroulante (cascade option → semestre →
   module → enseignant) sans recharger la page. */
function refillSelect(sel, items, preferred) {
  if (!sel) return;
  const keep = preferred !== undefined ? String(preferred || '') : sel.value;
  sel.innerHTML = '';
  items.forEach((it) => sel.appendChild(h('option', { value: String(it.value) }, it.label)));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function reservationFields(data, values, opts) {
  opts = opts || {};
  const v = values || {};
  const isCoord = APP.user.role === 'coordinateur';
  const myOptions = isCoord ? (APP.user.approved_options || []) : data.options;
  const initialOption = v.option_id || (isCoord && APP.user.active_option ? APP.user.active_option.id : (data.options[0] || {}).id);
  const initialModule = v.module_id ? data.modules.find((m) => String(m.id) === String(v.module_id)) : null;

  /* --- Cascade filière/option → semestre → module → enseignant affecté --- */
  const moduleItems = (optionId, sem) => data.modules
    .filter((m) => (!optionId || String(m.option_id) === String(optionId))
      && (!sem || normSemester(m.semester) === normSemester(sem)))
    .map((m) => ({ value: m.id, label: `${m.code} — ${m.name}${m.semester ? ` (${m.semester})` : ''}` }));
  const teacherItems = (moduleId) => {
    if (!moduleId) return data.teachers.map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }));
    const asg = data.assignments.filter((a) => String(a.module_id) === String(moduleId));
    const ids = new Set(asg.map((a) => String(a.teacher_id)));
    // L’enseignant déjà enregistré sur la réservation reste toujours proposée.
    if (v.teacher_id) ids.add(String(v.teacher_id));
    if (!ids.size) return data.teachers.map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }));
    return data.teachers.filter((t) => ids.has(String(t.id)))
      .map((t) => ({ value: t.id, label: `${t.prenom} ${t.nom}` }));
  };
  const sel = (name) => document.getElementById(`f_${name}`);
  const refreshModules = () => {
    refillSelect(sel('module_id'), [{ value: '', label: '— Aucun module —' },
      ...moduleItems(sel('option_id') ? sel('option_id').value : '', sel('semester') ? sel('semester').value : '')]);
    refreshTeachers();
  };
  const refreshTeachers = () => {
    const mid = sel('module_id') ? sel('module_id').value : '';
    refillSelect(sel('teacher_id'), [{ value: '', label: '— Aucun enseignant —' }, ...teacherItems(mid)], v.teacher_id || '');
  };
  const refreshGroups = () => {
    const oid = sel('option_id') ? sel('option_id').value : '';
    const sem = sel('semester') ? sel('semester').value : '';
    refillSelect(sel('group_id'), [{ value: '', label: '— Aucun groupe —' },
      ...data.groups.filter((g) => (!oid || String(g.option_id) === String(oid))
        && (!sem || !g.semester || normSemester(g.semester) === normSemester(sem)))
        .map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))]);
  };

  return [
    {
      name: 'option_id', label: 'Option', type: 'select', required: true,
      options: (isCoord ? myOptions : data.options).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
      value: initialOption,
      onchange: () => { refreshModules(); refreshGroups(); },
      help: isCoord ? 'Vous ne pouvez réserver que pour vos options approuvées.' : null
    },
    { name: 'group_id', label: 'Groupe', type: 'select', options: [{ value: '', label: '— Aucun groupe —' },
      ...data.groups.filter((g) => (!initialOption || String(g.option_id) === String(initialOption))
        && (!v.semester || !g.semester || normSemester(g.semester) === normSemester(v.semester)))
        .map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }))], value: v.group_id || '' },
    /* Semestre cible : champ OBLIGATOIRE réellement envoyé au serveur. Aucune
       réservation ne peut être créée sans semestre, et il fait foi pour
       l'emploi du temps auquel le cours appartient (S3 n'apparaît jamais dans
       S1). La liste des modules est restreinte au semestre choisi. */
    { name: 'semester', label: 'Semestre cible', type: 'select', required: true,
      options: [{ value: '', label: '— Choisir un semestre —' },
        ...(typeof SEMESTERS !== 'undefined' ? SEMESTERS : ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']).map((s) => ({ value: s, label: s }))],
      value: v.semester || (initialModule ? normSemester(initialModule.semester) : ''),
      onchange: () => { refreshModules(); refreshGroups(); },
      help: 'Obligatoire : le cours est placé dans l’emploi du temps de ce semestre uniquement.' },
    { name: 'module_id', label: 'Module', type: 'select',
      options: [{ value: '', label: '— Aucun module —' }, ...moduleItems(initialOption, initialModule ? initialModule.semester : '')],
      value: v.module_id || '',
      onchange: () => refreshTeachers(),
      help: 'Le choix du module propose automatiquement les enseignants qui lui sont affectés.' },
    { name: 'teacher_id', label: 'Enseignant', type: 'select',
      options: [{ value: '', label: '— Aucun enseignant —' }, ...teacherItems(v.module_id || '')],
      value: v.teacher_id || '',
      help: 'Enseignants affectés au module sélectionné (nom et prénom repris automatiquement).' },
    { name: 'date', label: 'Date', type: 'date', required: true, value: v.date || todayISO() },
    { name: 'start', label: 'Heure de début', type: 'select', required: true, options: timeOptions(7, 21), value: v.start || '08:00' },
    { name: 'end', label: 'Heure de fin', type: 'select', required: true, options: timeOptions(7, 22), value: v.end || '10:00' },
    {
      name: 'room_id', label: 'Salle', type: 'select', required: true,
      options: data.rooms.map((r) => ({
        value: r.id,
        label: r.bookable ? `${r.code} (${r.floor})` : `${r.code} — MASTER MANAGEMENT (exclue)`
      })),
      value: v.room_id || (data.rooms.find((r) => r.bookable) || {}).id,
      help: 'S12-1ER est réservée au Master Management et n’apparaît pas ici.'
    },
    { name: 'students_count', label: 'Nombre d’étudiants (informatif)', type: 'number', min: 0, value: v.students_count !== undefined && v.students_count !== null ? v.students_count : '' , help: 'Information uniquement — jamais utilisé pour filtrer les salles.' },
    { name: 'equipment', label: 'Équipement souhaité', placeholder: 'videoProjecteur, tableau…', value: v.equipment || '' },
    { name: 'title', label: 'Intitulé', value: v.title || '', placeholder: 'Ex : Cours TD' },
    { name: 'teacher_name_override', label: 'Enseignant (saisie manuelle)', value: v.teacher_name_override || '', help: 'À défaut d’enseignant enregistré.' },
    { name: 'module_name_override', label: 'Module (saisie manuelle)', value: v.module_name_override || '', help: 'À défaut de module enregistré.' },
    { name: 'notes', label: 'Notes', type: 'textarea', value: v.notes || '' }
  ];
}

function reservationPayload(values) {
  return {
    option_id: values.option_id ? Number(values.option_id) : null,
    group_id: values.group_id ? Number(values.group_id) : null,
    module_id: values.module_id ? Number(values.module_id) : null,
    teacher_id: values.teacher_id ? Number(values.teacher_id) : null,
    date: values.date, start: values.start, end: values.end,
    semester: values.semester || '',
    room_id: values.room_id ? Number(values.room_id) : null,
    students_count: values.students_count === '' ? 0 : Number(values.students_count || 0),
    equipment: values.equipment, title: values.title, notes: values.notes,
    teacher_name_override: values.teacher_name_override || '',
    module_name_override: values.module_name_override || ''
  };
}

/** Modale de réservation (pré-remplie depuis "Trouver une salle"). */
async function openReservationModal(prefill) {
  const data = await loadCatalogData();
  const values = Object.assign({}, prefill);
  if (prefill && prefill.room_id) values.room_id = Number(prefill.room_id);
  const box = h('div', {});
  const m = modal({
    title: prefill && prefill.room_code ? `Réserver ${prefill.room_code}` : 'Nouvelle réservation',
    wide: true,
    body: box
  });
  mount(box, form({
    values,
    fields: reservationFields(data, values),
    submitLabel: 'Confirmer la réservation',
    cancel: () => m.close(),
    onSubmit: async (vals) => {
      const payload = reservationPayload(vals);
      const res = await post('/api/reservations', payload);
      toast(`Réservation créée : ${res.reservation.room_code} le ${fmtDay(res.reservation.day)} de ${res.reservation.start} à ${res.reservation.end}`, 'ok');
      m.close();
      if (window.onReservationChanged) window.onReservationChanged();
    }
  }));
}

function ViewNewReservation(query) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement du formulaire…'));
  loadCatalogData().then((data) => {
    const values = {};
    if (query.room) values.room_id = Number(query.room);
    if (query.date) values.date = query.date;
    if (query.start) values.start = query.start;
    mount(root,
      pageHead('Nouvelle réservation', 'La détection de conflit est assurée côté serveur ET côté base de données',
        [h('a', { class: 'btn secondary', href: '#/find-room' }, '🔍 Trouver une salle'),
         h('a', { class: 'btn secondary', href: '#/reservations' }, '← Liste')]),
      h('div', { class: 'card' },
        form({
          values,
          fields: reservationFields(data, values),
          submitLabel: '📅 Créer la réservation',
          onSubmit: async (vals) => {
            const res = await post('/api/reservations', reservationPayload(vals));
            toast('Réservation enregistrée.', 'ok');
            window.navigateTo(`/reservations?created=${res.reservation.id}`);
          }
        })),
      h('div', { class: 'card', style: { background: 'var(--surface-2)' } },
        h('h3', {}, 'Règles appliquées'),
        h('ul', { style: { margin: 0, paddingLeft: '18px', color: 'var(--muted)', fontSize: '13.5px', lineHeight: 1.7 } },
          h('li', {}, 'Aucun chevauchement possible dans une même salle (08:00–10:00 bloque 08:30–09:30, 09:00–11:00, 09:30–10:30, mais autorise 10:00–12:00).'),
          h('li', {}, 'S12-1ER est réservée au MASTER MANAGEMENT toute l’année.'),
          h('li', {}, 'Créneaux alignés sur 30 minutes, du lundi au samedi.'),
          h('li', {}, 'Le nombre d’étudiants est informatif : il ne filtre jamais les salles.'))));
  }).catch((e) => mount(root, h('div', { class: 'card' }, h('div', { class: 'empty' }, errorMessage(e)))));
  return root;
}

/* ==================== LISTE DES RÉSERVATIONS ==================== */
async function ViewReservations(query) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des réservations…'));

  const filters = {
    from: query.from || todayISO(),
    to: query.to || '',
    option_id: query.option_id || '',
    room_code: query.room_code || '',
    mine: query.mine || ''
  };
  let data = await loadCatalogData();

  async function load() {
    const res = await get(`/api/reservations${qs({ from: filters.from, to: filters.to || filters.from, option_id: filters.option_id, room_code: filters.room_code, mine: filters.mine })}`);
    return res.reservations || [];
  }

  const tableBox = h('div', {});
  const canEdit = APP.user.role === 'admin' || APP.user.role === 'coordinateur';

  function canManage(r) {
    if (APP.user.role === 'admin') return true;
    return (APP.user.approved_options || []).some((o) => o.id === r.option_id);
  }

  async function draw() {
    const rows = await load();
    mount(tableBox, table([
      { key: 'day', label: 'Jour', render: (r) => h('div', {}, h('b', {}, fmtDayShort(r.day)), h('div', { class: 'help' }, r.weekday)) },
      { key: 'start', label: 'Horaire', render: (r) => `${r.start} – ${r.end}` },
      { key: 'room_code', label: 'Salle', render: (r) => h('b', {}, r.room_code) },
      { key: 'option_code', label: 'Option', render: (r) => badge(r.option_code, 'brand') },
      { key: 'group_code', label: 'Groupe' },
      { key: 'module_name', label: 'Module' },
      { key: 'teacher_name', label: 'Enseignant' },
      { key: 'students_count', label: 'Ét.', className: 'num' },
      { key: 'status', label: 'Statut', render: (r) => statusBadge(r.status) },
      {
        key: '_a', label: '', className: '', render: (r) => {
          if (!canEdit || !canManage(r)) return h('span', { class: 'help' }, r.created_by_name ? `par ${r.created_by_name}` : '');
          return h('div', { class: 'row-actions' },
            h('button', { class: 'btn sm secondary', title: 'Reprogrammer', onclick: () => editReservation(r, data, draw) }, '✏️'),
            h('button', { class: 'btn sm secondary', title: 'Voir / imprimer',            onclick: () => showReservation(r, data) }, '👁'),
            h('button', {
              class: 'btn sm danger', title: 'Annuler',
              onclick: async () => {
                const ok2 = await confirmBox({ title: 'Annuler la réservation', message: `Annuler ${r.room_code} le ${fmtDay(r.day)} de ${r.start} à ${r.end} ?`, confirmLabel: 'Annuler la réservation', danger: true });
                if (!ok2) return;
                try { await del(`/api/reservations/${r.id}`); toast('Réservation annulée.', 'ok'); draw(); }
                catch (e) { toast(errorMessage(e), 'err'); }
              }
            }, '🗑'));
        }
      }
    ], rows, {
      empty: 'Aucune réservation sur la période.',
      emptyIcon: '📅',
      rowClass: (r) => (r.status === 'CANCELLED' ? 'cancelled' : '')
    }));
  }

  const filterBar = h('div', { class: 'filters no-print' },
    h('span', { class: 'lbl' }, 'Du'),
    h('input', { type: 'date', value: filters.from, onchange: (e) => { filters.from = e.target.value; draw(); } }),
    h('span', { class: 'lbl' }, 'au'),
    h('input', { type: 'date', value: filters.to, onchange: (e) => { filters.to = e.target.value; draw(); } }),
    h('select', { onchange: (e) => { filters.option_id = e.target.value; draw(); } },
      h('option', { value: '' }, 'Toutes les options'),
      data.options.map((o) => h('option', { value: o.id, selected: String(o.id) === String(filters.option_id) }, o.code))),
    h('input', { type: 'text', placeholder: 'Code salle (ex : S03)', value: filters.room_code, style: { width: '150px' }, onchange: (e) => { filters.room_code = e.target.value.trim(); draw(); } }),
    canEdit ? h('select', { onchange: (e) => { filters.mine = e.target.value; draw(); } },
      h('option', { value: '' }, 'Toutes (toutes options visibles)'),
      h('option', { value: '1', selected: filters.mine === '1' }, 'Mes créations')) : null,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '7px', flexWrap: 'wrap' } },
      h('a', { class: 'btn sm secondary', href: `/api/export/reservations.xls${qs({ from: filters.from, to: filters.to || filters.from })}` }, '⬇ Excel'),
      h('a', { class: 'btn sm secondary', href: `/api/export/reservations.csv${qs({ from: filters.from, to: filters.to || filters.from })}` }, '⬇ CSV')));

  mount(root,
    pageHead(APP.user.role === 'enseignant' ? 'Mes réservations' : 'Réservations',
      'Toutes les options sont visibles pour connaître la disponibilité réelle des salles ; seules vos options sont modifiables.',
      canEdit ? [
        h('button', { class: 'btn secondary', onclick: () => copyPlanning(draw) }, '📄 Copier jour / semaine'),
        h('a', { class: 'btn', href: '#/reservations/new' }, '＋ Nouvelle réservation')
      ] : []),
    filterBar,
    tableBox,
    h('div', { class: 'planning-legend no-print' },
      h('span', {}, h('span', { class: 'sw', style: { background: '#e7f6ec' } }), 'Mes réservations'),
      h('span', {}, h('span', { class: 'sw', style: { background: '#fdf1e0' } }), 'Autres options (lecture seule)')));

  await draw();
  window.refreshReservations = draw;
  return root;
}

/* Modification / suppression d’une séance : réservée à l’administration ou au
   coordinateur d’une option approuvée concernée (miroir de assertCanManage
   côté serveur). */
function canManageReservation(r) {
  if (!APP.user) return false;
  if (APP.user.role === 'admin') return true;
  if (APP.user.role !== 'coordinateur') return false;
  return (APP.user.approved_options || []).some((o) => String(o.id) === String(r.option_id));
}

/* Suppression en un clic (planning ou liste) : confirmation puis annulation
   de la séance ; le planning se rafraîchit automatiquement. */
async function deleteReservation(r, onDone) {
  const ok2 = await confirmBox({
    title: 'Supprimer la séance',
    message: `Supprimer la séance du ${fmtDay(r.day)} (${r.start}–${r.end}, ${r.room_code}) ?`,
    confirmLabel: 'Supprimer', danger: true
  });
  if (!ok2) return false;
  try {
    await del(`/api/reservations/${r.id}`);
    toast('Séance supprimée du planning.', 'ok');
    if (onDone) onDone();
    if (window.onReservationChanged) window.onReservationChanged();
    return true;
  } catch (e) {
    toast(errorMessage(e), 'err');
    return false;
  }
}

function showReservation(r, cat) {
  const manage = canManageReservation(r);
  const m = modal({
    title: `Réservation ${r.room_code} — ${fmtDay(r.day)}`,
    body: table([
      { key: 'k', label: 'Champ' },
      { key: 'v', label: 'Valeur' }
    ], [
      { k: 'Salle', v: `${r.room_code} (${r.floor})` },
      { k: 'Jour', v: `${fmtDay(r.day)} (${r.weekday})` },
      { k: 'Horaire', v: `${r.start} – ${r.end}` },
      { k: 'Filière', v: r.option_category || '—' },
      { k: 'Option', v: r.option_code },
      { k: 'Groupe', v: r.group_code || '—' },
      { k: 'Module', v: r.module_name || '—' },
      { k: 'Enseignant', v: r.teacher_name || '—' },
      { k: 'Nombre d’étudiants', v: `${r.students_count} (informatif)` },
      { k: 'Équipement', v: r.equipment || '—' },
      { k: 'Statut', v: STATUS_LABEL[r.status] || r.status },
      { k: 'Créée par', v: r.created_by_name || '—' },
      { k: 'Notes', v: r.notes || '—' },
      /* Espaces de signature — libellés DYNAMIQUES : le titre du responsable
         d’option suit le genre du compte ; celui du responsable de filière suit
         la règle automatique de l’ISPITS (« Soins Infirmiers » → Coordinatrice,
         toutes les autres filières → Coordinateur). */
      { k: 'Signature responsable', v: h('div', { class: 'sig-pair' },
        h('div', { class: 'pg-sig' },
          h('div', { class: 'pg-sig-label' }, optionTitle(APP.user.gender)),
          h('div', { class: 'pg-sig-space' })),
        h('div', { class: 'pg-sig' },
          h('div', { class: 'pg-sig-label' }, filiereTitle(r.option_category)),
          h('div', { class: 'pg-sig-space' }))) }
    ]),
    foot: [
      manage ? h('button', { type: 'button', class: 'btn', onclick: () => { m.close(); editReservation(r, cat); } }, '✏️ Modifier') : null,
      manage ? h('button', { type: 'button', class: 'btn danger', onclick: () => { m.close(); deleteReservation(r); } }, '🗑 Supprimer') : null,
      h('button', { type: 'button', class: 'btn secondary', onclick: () => window.print() }, '🖨️ Imprimer'),
      h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, 'Fermer')
    ].filter(Boolean)
  });
}

async function editReservation(r, data, onSaved) {
  const box = h('div', {});
  const m = modal({ title: `Reprogrammer ${r.room_code}`, wide: true, body: box });
  const values = {
    option_id: r.option_id, group_id: r.group_id || '', module_id: r.module_id || '',
    teacher_id: r.teacher_id || '', date: r.day, start: r.start, end: r.end,
    semester: r.semester || '',
    room_id: r.room_id, students_count: r.students_count, equipment: r.equipment,
    title: r.title, notes: r.notes, teacher_name_override: r.teacher_name_override, module_name_override: r.module_name_override
  };
  mount(box, form({
    values,
    fields: reservationFields(data || await loadCatalogData(), values),
    submitLabel: '💾 Enregistrer le nouveau créneau',
    cancel: () => m.close(),
    onSubmit: async (vals) => {
      const res = await put(`/api/reservations/${r.id}`, reservationPayload(vals));
      toast(`Réservation reprogrammée : ${fmtDay(res.reservation.day)} ${res.reservation.start}–${res.reservation.end}`, 'ok');
      m.close();
      if (onSaved) onSaved();
      if (window.onReservationChanged) window.onReservationChanged();
    }
  }));
}

function copyPlanning(onDone) {
  const box = h('div', {});
  const m = modal({
    title: 'Copier un planning',
    body: box,
    foot: []
  });
  mount(box,
    h('p', { class: 'help', style: { marginTop: 0 } }, 'La copie vérifie automatiquement les conflits : les créneaux déjà pris sont ignorés (aucun doublon, aucun chevauchement).'),
    form({
      inline: true,
      fields: [
        { name: 'mode', label: 'Mode', type: 'select', options: [{ value: 'day', label: 'Copier la journée' }, { value: 'week', label: 'Copier la semaine' }] },
        { name: 'from_day', label: 'Source', type: 'date', required: true, value: todayISO() },
        { name: 'to_day', label: 'Destination', type: 'date', value: '' }
      ],
      submitLabel: '📋 Copier',
      cancel: () => m.close(),
      onSubmit: async (values) => {
        const payload = { mode: values.mode, from_day: values.from_day };
        if (values.to_day) payload[values.mode === 'day' ? 'to_day' : 'to_week'] = values.to_day;
        const res = await post('/api/reservations/copy', payload);
        const skipped = (res.skipped || []).length;
        toast(`Copie terminée : ${res.created} créée(s), ${skipped} ignorée(s) pour conflit.`, skipped && !res.created ? 'warn' : 'ok');
        m.close();
        if (onDone) onDone();
        if (window.onReservationChanged) window.onReservationChanged();
      }
    }));
}
