/* SmartSalle ISPITS — tableaux de bord, sélection d'option, salles, trouv une salle */
'use strict';

/* ==================== TABLEAU DE BORD ==================== */
async function ViewDashboard() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement du tableau de bord…'));
  try {
    const res = await get('/api/dashboard');
    const s = res.stats;
    if (APP.user.role === 'admin') renderAdminDashboard(root, s);
    else if (APP.user.role === 'coordinateur') renderCoordinatorDashboard(root, s);
    else renderTeacherDashboard(root, s);
  } catch (e) {
    mount(root, h('div', { class: 'card' }, h('div', { class: 'empty' }, errorMessage(e))));
  }
  return root;
}

function occupancyLists(occ, opts) {
  opts = opts || {};
  const cell = (room) => h('div', { class: 'item', style: { padding: '9px 12px' } },
    h('div', { class: 'i-main' },
      h('b', {}, room.code, room.restricted ? ' ' : ''),
      h('p', {}, room.restricted ? `Réservée au ${room.reserved_for}` : (room.booking
        ? `${room.booking.option} · ${room.booking.start}–${room.booking.end}${room.booking.title ? ' · ' + room.booking.title : ''}`
        : `${room.floor} · ${room.location}`))));
  return h('div', { class: 'cols-equal' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, `🟢 Salles libres (${occ.free.length})`)),
      occ.free.length ? h('div', { class: 'list' }, occ.free.slice(0, 12).map(cell)) : h('div', { class: 'empty' }, 'Aucune salle libre sur ce créneau.'),
      occ.free.length > 12 ? h('div', { class: 'help', style: { marginTop: '8px' } }, `+${occ.free.length - 12} autres salles libres…`) : null),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, `🔴 Salles occupées (${occ.taken.length})`)),
      occ.taken.length ? h('div', { class: 'list' }, occ.taken.slice(0, 12).map(cell)) : h('div', { class: 'empty' }, 'Aucune salle occupée : tout est libre.')));
}

function renderAdminDashboard(root, s) {
  mount(root,
    pageHead(`Bonjour, ${APP.user.prenom} ${APP.user.nom}`, `Administration · ${fmtDay(s.day)} · ${s.now}`,
      [h('a', { class: 'btn secondary', href: '#/planning' }, '🌐 Planning global'),
       h('a', { class: 'btn', href: '#/reservations/new' }, '＋ Nouvelle réservation')]),
    h('div', { class: 'stats grid' },
      statCard('Salles totales', s.rooms_total, `${s.rooms_free} libres · ${s.rooms_occupied} occupées`),
      statCard('Réservations aujourd’hui', s.reservations_today, `${s.reservations_week} cette semaine`, 'ok'),
      statCard('Options actives', s.options, `${s.groups} groupes · ${s.modules} modules`, 'purple'),
      statCard('Enseignants', s.teachers, `${s.users_teachers} comptes actifs`, 'info'),
      statCard('Demandes de comptes', s.pending_accounts, `${s.pending_options} demandes d’option`, s.pending_accounts ? 'danger' : 'ok'),
      statCard('Utilisateurs', s.users_total, `${s.users_coord} coordinateurs`)),
    s.pending_accounts ? h('div', { class: 'card', style: { borderLeft: '4px solid var(--danger)' } },
      h('div', { class: 'card-head' }, h('h3', {}, '⏳ Demandes en attente'), h('div', { class: 'actions' },
        h('a', { class: 'btn sm', href: '#/admin/requests' }, 'Traiter les demandes'))) ) : null,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', {}, `Prochaines réservations`),
        h('div', { class: 'actions' }, h('a', { class: 'btn sm secondary', href: '#/reservations' }, 'Toutes'))),
      s.next_reservations && s.next_reservations.length
        ? table([
          { key: 'day', label: 'Jour', render: (r) => fmtDayShort(r.day) },
          { key: 'start', label: 'Heure', render: (r) => `${r.start}–${r.end}` },
          { key: 'room_code', label: 'Salle' },
          { key: 'option_code', label: 'Option', render: (r) => badge(r.option_code, 'brand') },
          { key: 'group_code', label: 'Groupe' },
          { key: 'module_name', label: 'Module' },
          { key: 'teacher_name', label: 'Enseignant' }
        ], s.next_reservations)
        : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🗓️'), 'Aucune réservation à venir.')),
    occupancyLists(s.occupancy),
    h('div', { class: 'card' },
      h('h3', {}, 'Accès rapide'),
      h('div', { class: 'quick-actions' },
        quick('#/admin/requests', '📨', 'Demandes de comptes'),
        quick('#/find-room', '🔍', 'Trouver une salle'),
        quick('#/rooms', '🚪', 'Salles'),
        quick('#/admin/settings', '⚙️', 'Paramètres'),
        quick('#/admin/audit', '🕘', 'Historique'),
        quick('#/admin/export', '📦', 'Exports'))));
}

function quick(href, icon, label) {
  return h('a', { class: 'quick', href },
    h('span', { class: 'qi' }, icon), h('span', {}, label));
}

function renderCoordinatorDashboard(root, s) {
  const opt = s.active_option;
  mount(root,
    pageHead(`${APP.user.prenom} ${APP.user.nom} — ${coordinatorTitle(APP.user.gender)}`,
      opt ? `Option active : ${opt.code} · ${fmtDay(s.day)} · ${s.now}` : 'Aucune option active',
      [h('a', { class: 'btn secondary', href: '#/find-room' }, '🔍 Trouver une salle'),
       h('a', { class: 'btn', href: '#/reservations/new' }, '＋ Nouvelle réservation')]),
    !opt ? h('div', { class: 'card', style: { borderLeft: '4px solid var(--warn)' } },
      h('h3', {}, 'Aucune option approuvée'),
      h('p', {}, 'Votre demande d’option est en attente, ou aucune option ne vous a encore été approuvée. Vous pouvez demander une option ci-dessous.'),
      h('a', { class: 'btn', href: '#/option' }, 'Gérer mes options')) : null,
    h('div', { class: 'stats grid' },
      statCard('Option active', opt ? opt.code : '—', opt ? opt.name : 'en attente', 'purple'),
      statCard('Réservations aujourd’hui', s.reservations_today, opt ? `${s.reservations_of_option} cette semaine` : '', 'ok'),
      statCard('Groupes', s.groups_of_option || 0, 'de mon option'),
      statCard('Modules', s.modules_of_option || 0, 'de mon option'),
      statCard('Salles libres', s.rooms_free, `${s.rooms_occupied} occupées`),
      statCard('Part de l’option', s.reservation_share ? `${s.reservation_share.mine}/${s.reservation_share.total}` : '—', 'réservations cette semaine', 'info')),
    h('div', { class: 'card' },
      h('h3', {}, 'Actions'),
      h('div', { class: 'quick-actions' },
        quick('#/find-room', '🔍', 'Trouver une salle'),
        quick('#/reservations/new', '📅', 'Nouvelle réservation'),
        quick('#/planning', '🗓️', 'Mon planning'),
        quick('#/notes', '📝', 'Mes notes'),
        quick('#/tasks', '✅', 'Mes tâches'),
        quick('#/option', '🎯', 'Mon option'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Prochaines activités'),
        h('div', { class: 'actions' }, h('a', { class: 'btn sm secondary', href: '#/planning' }, 'Planning complet'))),
      (s.next_activities || []).length
        ? table([
          { key: 'day', label: 'Jour', render: (r) => fmtDayShort(r.day) },
          { key: 'start', label: 'Heure', render: (r) => `${r.start}–${r.end}` },
          { key: 'room_code', label: 'Salle' },
          { key: 'group_code', label: 'Groupe' },
          { key: 'module_name', label: 'Module' },
          { key: 'teacher_name', label: 'Enseignant' },
          { key: 'option_code', label: 'Option', render: (r) => badge(r.option_code, r.option_code === (opt && opt.code) ? 'ok' : 'warn') }
        ], s.next_activities)
        : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🗓️'), 'Aucune activité prévue pour votre option.')),
    occupancyLists(s.occupancy));
}

function renderTeacherDashboard(root, s) {
  mount(root,
    pageHead(`Bonjour, ${APP.user.prenom} ${APP.user.nom}`, `Enseignant · ${fmtDay(s.day)} · ${s.now}`,
      [h('a', { class: 'btn secondary', href: '#/planning' }, '🗓️ Mon planning')]),
    h('div', { class: 'stats grid' },
      statCard('Cours aujourd’hui', s.reservations_today, `${s.week_reservations} cette semaine`, 'ok'),
      statCard('Mes modules', s.my_modules, 'affectations'),
      statCard('Salles libres', s.rooms_free, `${s.rooms_occupied} occupées`, 'info'),
      statCard('Horaires', `${APP.settings.day_start || '08:00'}–${APP.settings.day_end || '18:00'}`, 'lundi → samedi')),
    h('div', { class: 'card' },
      h('h3', {}, 'Accès rapide'),
      h('div', { class: 'quick-actions' },
        quick('#/planning', '🗓️', 'Mon planning'),
        quick('#/modules', '📚', 'Mes modules'),
        quick('#/reservations', '📅', 'Mes réservations'),
        quick('#/notifications', '🔔', 'Notifications'))),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Mes prochains horaires')),
      (s.next_activities || []).length
        ? table([
          { key: 'day', label: 'Jour', render: (r) => fmtDay(r.day) },
          { key: 'start', label: 'Heure', render: (r) => `${r.start}–${r.end}` },
          { key: 'room_code', label: 'Salle' },
          { key: 'option_code', label: 'Option' },
          { key: 'group_code', label: 'Groupe' },
          { key: 'module_name', label: 'Module' }
        ], s.next_activities)
        : h('div', { class: 'empty' }, h('span', { class: 'big' }, '📚'), 'Aucun cours programmé pour le moment.')),
    occupancyLists(s.occupancy));
}

/* ==================== SÉLECTION / DEMANDE D'OPTION ==================== */
async function ViewOption() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement de vos options…'));
  const [me, allRes] = await Promise.all([get('/api/auth/me'), get('/api/options')]);
  const user = me.user;
  APP.user = user;
  const all = (allRes.options || []).filter((o) => o.status === 'ACTIVE');
  const approved = user.approved_options || [];
  const requested = (user.options || []).filter((o) => o.status === 'REQUESTED');
  const rejected = (user.options || []).filter((o) => o.status === 'REJECTED');

  /* --- Cas 1 : plusieurs options approuvées → écran « Sélectionnez votre option » --- */
  if (approved.length > 1) {
    const cards = approved.map((o) => {
      const active = user.active_option && user.active_option.id === o.id;
      const node = h('div', { class: 'option-card' });
      node.addEventListener('click', async () => {
        try {
          const res = await post('/api/auth/switch-option', { option_id: o.id });
          APP.user = res.user;
          toast(`Option active : ${o.code}`, 'ok');
          window.navigateTo('/dashboard');
        } catch (e) { toast(errorMessage(e), 'err'); }
      });
      appendKids(node, [
        h('div', { class: 'oc-code' }, o.code),
        h('div', { class: 'oc-name' }, o.name),
        active ? badge('ACTIVE', 'ok') : h('div', { style: { marginTop: '8px' } }, badge('Sélectionner', 'brand'))
      ]);
      return node;
    });
    const pickCard = h('div', { class: 'card' }, h('div', { class: 'option-pick' }, cards));
    const helpCard = h('div', { class: 'card' },
      h('h3', {}, 'Changement d’option'),
      h('p', { class: 'help' }, 'Vous pouvez changer d’option à tout moment : groupes, modules, réservations, statistiques et planning suivent automatiquement.'));
    mount(root,
      pageHead('Sélectionnez votre option', 'Votre tableau de bord et vos données affichent l’option sélectionnée'),
      pickCard, helpCard);
    return root;
  }

  const availableToRequest = all.filter((o) =>
    !approved.some((a) => a.id === o.id) && !requested.some((r2) => r2.option_id === o.id));

  /* --- Bloc « option approuvée ou non » --- */
  let statusCard;
  if (approved.length) {
    statusCard = h('div', { class: 'card', style: { borderLeft: '4px solid var(--ok)' } },
      h('h3', {}, 'Option approuvée'),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '26px', fontWeight: 800, color: 'var(--brand)' } }, approved[0].code),
        badge('APPROUVÉE', 'ok'),
        h('span', { class: 'help' }, approved[0].name)),
      h('div', { style: { marginTop: '12px' } },
        h('a', { class: 'btn', href: '#/dashboard' }, 'Ouvrir mon tableau de bord')));
  } else {
    statusCard = h('div', { class: 'card', style: { borderLeft: '4px solid var(--warn)' } },
      h('h3', {}, 'Aucune option approuvée'),
      h('p', {}, 'Les options ci-dessous sont en attente de validation. Vous pouvez en demander 1, 2 ou 3 au maximum — jamais plus.'));
  }

  /* --- Demandes en attente --- */
  let requestedCard = null;
  if (requested.length) {
    const cols = [
      { key: 'code', label: 'Option' },
      { key: 'name', label: 'Intitulé' },
      { key: 'status', label: 'Statut', render: (o) => statusBadge(o.status) },
      {
        key: '_a', label: '', render: (o) => h('button', {
          class: 'btn sm secondary',
          onclick: async () => {
            const ok2 = await confirmBox({
              title: 'Annuler la demande',
              message: `Annuler votre demande pour l’option ${o.code} ?`,
              confirmLabel: 'Annuler la demande'
            });
            if (!ok2) return;
            try {
              await del(`/api/options/requests/${o.request_id}`);
              toast('Demande annulée.', 'ok');
              window.refresh();
            } catch (e) { toast(errorMessage(e), 'err'); }
          }
        }, '✕ Annuler')
      }
    ];
    requestedCard = h('div', { class: 'card' },
      h('h3', {}, 'Demandes en attente'),
      table(cols, requested));
  }

  /* --- Demandes refusées --- */
  let rejectedCard = null;
  if (rejected.length) {
    const cols = [
      { key: 'code', label: 'Option' },
      { key: 'status', label: 'Statut', render: (o) => statusBadge(o.status) },
      {
        key: '_a', label: '', render: (o) => h('button', {
          class: 'btn sm',
          onclick: async () => {
            try {
              await post('/api/options/requests', { option_id: o.id });
              toast('Nouvelle demande envoyée.', 'ok');
              window.refresh();
            } catch (e) { toast(errorMessage(e), 'err'); }
          }
        }, '↺ Redemander')
      }
    ];
    rejectedCard = h('div', { class: 'card' },
      h('h3', {}, 'Demandes refusées'),
      table(cols, rejected));
  }

  /* --- Nouvelle demande (maximum 3 au total) --- */
  let requestCard;
  const total = approved.length + requested.length;
  if (availableToRequest.length && total < 3) {
    const items = availableToRequest.map((o) => {
      const btn = h('button', { class: 'quick', style: { justifyContent: 'flex-start' } });
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await post('/api/options/requests', { option_id: o.id });
          toast(res.message, 'ok');
          window.refresh();
        } catch (err) {
          toast(errorMessage(err), 'err');
          btn.disabled = false;
        }
      });
      appendKids(btn, [
        h('span', { class: 'qi' }, '＋'),
        h('span', {}, `Demander ${o.code}`,
          h('span', { style: { display: 'block', fontSize: '11.5px', color: 'var(--muted)', fontWeight: 400 } }, o.name))
      ]);
      return btn;
    });
    requestCard = h('div', { class: 'card' },
      h('h3', {}, `Demander une option (${total}/3)`),
      h('div', { class: 'checkbox-list' }, items));
  } else {
    requestCard = h('div', { class: 'card' },
      h('h3', {}, 'Maximum atteint'),
      h('p', { class: 'help' }, 'Vous avez déjà 3 options demandées ou approuvées. Contactez l’administration pour en modifier.'));
  }

  mount(root,
    pageHead('Mon option',
      approved.length ? 'Votre option validée par l’administration' : 'Demande d’option à valider par l’administration'),
    statusCard, requestedCard, rejectedCard, requestCard);
  return root;
}

/* ==================== SALLES ==================== */
async function ViewRooms() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des salles…'));
  const isAdmin = APP.user.role === 'admin';
  const [roomsRes, occRes] = await Promise.all([get('/api/rooms'), get('/api/occupancy')]);
  const rooms = roomsRes.rooms;
  const occ = occRes;
  const busyMap = {};
  occ.taken.forEach((r) => { busyMap[r.code] = r; });
  const freeMap = {};
  occ.free.forEach((r) => { freeMap[r.code] = r; });

  let floorFilter = '';
  let search = '';

  const grid = h('div', { class: 'room-grid' });

  function draw() {
    const list = rooms.filter((r) => (!floorFilter || r.floor === floorFilter) &&
      (!search || r.code.toLowerCase().includes(search.toLowerCase()) || r.name.toLowerCase().includes(search.toLowerCase())));
    mount(grid, list.map((r) => {
      const busy = busyMap[r.code];
      const cls = !r.bookable ? 'restricted' : (busy ? 'busy' : 'free');
      return h('div', { class: `room ${cls}` },
        h('div', { class: 'code' }, r.code),
        h('div', { class: 'meta' }, `${r.floor} · ${r.location}`),
        h('div', { class: 'state', style: { color: !r.bookable ? 'var(--purple)' : (busy ? 'var(--danger)' : 'var(--ok)') } },
          h('span', { class: 'dot' }),
          !r.bookable ? `RÉSERVÉE AU ${r.reserved_for}` : (busy ? 'OCCUPÉE' : 'LIBRE')),
        h('div', { class: 'now' }, !r.bookable
          ? 'Indisponible pour les réservations normales'
          : (busy ? `En cours ${busy.booking.start}–${busy.booking.end} · ${busy.booking.option}` : 'Libre actuellement')),
        h('div', { class: 'actions' },
          h('button', {
            class: 'btn sm secondary', onclick: () => showRoomDetails(r, occ)
          }, 'Détails'),
          r.bookable && APP.user.role !== 'enseignant'
            ? h('a', { class: 'btn sm', href: `#/reservations/new?room=${r.id}` }, 'Réserver')
            : null,
          isAdmin ? h('button', { class: 'btn sm ghost', onclick: () => editRoom(r) }, '✏️') : null));
    }));
  }

  const filters = h('div', { class: 'filters no-print' },
    h('span', { class: 'lbl' }, 'Étage'),
    h('select', { onchange: (e) => { floorFilter = e.target.value; draw(); } },
      h('option', { value: '' }, 'Tous'),
      h('option', { value: 'RDC' }, 'Rez-de-chaussée'),
      h('option', { value: '1ER' }, 'Premier étage'),
      h('option', { value: 'AMPHI' }, 'Amphithéâtre')),
    h('input', { type: 'text', placeholder: 'Rechercher une salle…', oninput: (e) => { search = e.target.value; draw(); }, style: { minWidth: '200px' } }),
    h('span', { class: 'lbl', style: { marginLeft: 'auto' } }, `${rooms.length} salles`),
    isAdmin ? h('button', { class: 'btn sm', onclick: () => editRoom(null) }, '＋ Nouvelle salle') : null,
    h('a', { class: 'btn sm secondary', href: '/api/export/rooms.xls' }, '⬇ Excel'),
    h('a', { class: 'btn sm secondary', href: '/api/export/rooms.csv' }, '⬇ CSV'));

  mount(root,
    pageHead('Salles', 'S12-RDC et S12-1ER sont deux salles distinctes · AMPHI : entrée de l’ISPITS à gauche'),
    h('div', { class: 'card', style: { background: 'var(--purple-soft)', border: '1px solid #ddd0fb' } },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
        h('b', {}, 'S12-1ER — MASTER MANAGEMENT'),
        badge('RÉSERVÉE TOUTE L’ANNÉE', 'purple'),
        h('span', { class: 'help' }, 'Exclue des recherches et des réservations normales · visible par l’administration et les coordinateurs'))),
    filters, grid);
  draw();
  return root;
}

function showRoomDetails(room, occ) {
  const qr = h('div', { style: { textAlign: 'center' } },
    h('img', { src: `/api/rooms/${encodeURIComponent(room.code)}/qr?format=svg&size=220`, alt: `QR ${room.code}`, style: { width: '200px', height: '200px' } }),
    h('div', { class: 'help' }, 'Scannez pour ouvrir la page publique de la salle'));
  const details = table([
    { key: 'k', label: 'Champ' },
    { key: 'v', label: 'Valeur' }
  ], [
    { k: 'Code', v: room.code },
    { k: 'Nom', v: room.name },
    { k: 'Étage', v: room.floor },
    { k: 'Localisation', v: room.location },
    { k: 'Statut', v: STATUS_LABEL[room.status] || room.status },
    { k: 'Réservée pour', v: room.reserved_for || '—' },
    { k: 'Réservable normalement', v: room.bookable ? 'OUI' : 'NON (MASTER MANAGEMENT)' },
    { k: 'Équipements', v: room.equipment || '—' },
    { k: 'Notes', v: room.notes || '—' }
  ]);
  modal({
    title: `Salle ${room.code}`,
    wide: true,
    body: h('div', { class: 'cols-equal' }, h('div', {}, details), qr),
    foot: [
      h('button', { type: 'button', class: 'btn secondary', onclick: () => window.print() }, '🖨️ Imprimer la fiche'),
      room.bookable && APP.user.role !== 'enseignant'
        ? h('a', { class: 'btn', href: `#/reservations/new?room=${room.id}`, onclick: () => { document.getElementById('modal-root').innerHTML = ''; } }, 'Réserver cette salle')
        : null
    ]
  });
}

async function editRoom(room) {
  const isNew = !room;
  const modalEl = modal({
    title: isNew ? 'Nouvelle salle' : `Modifier ${room.code}`,
    body: form({
      values: room || { floor: 'RDC', status: 'ACTIVE', bookable: true },
      fields: [
        { name: 'code', label: 'Code (ex : S12-RDC)', required: true },
        { name: 'name', label: 'Nom', required: true },
        { name: 'floor', label: 'Étage', type: 'select', options: [{ value: 'RDC', label: 'Rez-de-chaussée' }, { value: '1ER', label: 'Premier étage' }, { value: 'AMPHI', label: 'Amphithéâtre' }] },
        { name: 'location', label: 'Localisation' },
        { name: 'status', label: 'Statut', type: 'select', options: [{ value: 'ACTIVE', label: 'ACTIVE' }, { value: 'RESERVED', label: 'RÉSERVÉE' }, { value: 'INACTIVE', label: 'INACTIVE' }] },
        { name: 'reserved_for', label: 'Réservée pour (ex : MASTER MANAGEMENT)' },
        { name: 'equipment', label: 'Équipements (séparés par des virgules)', placeholder: 'videoProjecteur, tableau, climatisation' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
        { name: 'bookable', label: 'Réservable normalement', type: 'checkbox', help: 'Décochez pour une salle réservée toute l’année (comme S12-1ER)' }
      ],
      submitLabel: isNew ? 'Créer la salle' : 'Enregistrer',
      onSubmit: async (values) => {
        const payload = {
          code: values.code, name: values.name, floor: values.floor, location: values.location,
          status: values.status, reserved_for: values.reserved_for, equipment: values.equipment,
          notes: values.notes, bookable: !!values.bookable
        };
        if (isNew) await post('/api/admin/rooms', payload);
        else await put(`/api/admin/rooms/${room.id}`, payload);
        toast(isNew ? 'Salle créée.' : 'Salle mise à jour.', 'ok');
        modalEl.close();
        window.refresh();
      }
    })
  });
}

/* ==================== TROUVER UNE SALLE ==================== */
async function ViewFindRoom(query) {
  const root = h('div', {});
  const presetRoom = query.room ? Number(query.room) : null;
  let results = null;

  const resultsBox = h('div', {});
  const structured = form({
    inline: false,
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, value: query.date || todayISO() },
      { name: 'start', label: 'Heure de début', type: 'select', required: true, options: timeOptions(7, 20), value: query.start || '10:00' },
      { name: 'end', label: 'Heure de fin', type: 'select', required: true, options: timeOptions(7, 21), value: query.end || '12:00' },
      { name: 'equipment', label: 'Équipement souhaité (optionnel)', type: 'select', options: [{ value: '', label: 'Aucun équipement imposé' }, { value: 'videoProjecteur', label: 'Vidéoprojecteur' }, { value: 'ordinateur', label: 'Ordinateur' }, { value: 'tableau', label: 'Tableau' }, { value: 'climatisation', label: 'Climatisation' }] },
      { name: 'floor', label: 'Étage (optionnel)', type: 'select', options: [{ value: '', label: 'Tous les étages' }, { value: 'RDC', label: 'Rez-de-chaussée' }, { value: '1ER', label: 'Premier étage' }, { value: 'AMPHI', label: 'Amphithéâtre' }] }
    ],
    submitLabel: '🔎 Trouver une salle',
    onSubmit: async (values) => {
      mount(resultsBox, loadingCard('Recherche des salles disponibles…'));
      const res = await get(`/api/search/room${qs(values)}`);
      results = res;
      drawResults(res, values);
    }
  });

  const smartInput = h('input', { type: 'text', class: 'input', placeholder: 'Ex : trouve-moi une salle mardi de 10h à 12h', style: { minWidth: '260px', flex: '1' } });
  const smartBtn = h('button', {
    class: 'btn secondary',
    onclick: async () => {
      if (!smartInput.value.trim()) { toast('Décrivez votre besoin.', 'warn'); return; }
      mount(resultsBox, loadingCard('Analyse de votre demande…'));
      try {
        const res = await get(`/api/search/smart${qs({ q: smartInput.value })}`);
        if (res.need) {
          mount(resultsBox, h('div', { class: 'card' },
            h('div', { class: 'empty' },
              h('span', { class: 'big' }, '🤖'),
              h('div', {}, res.message),
              h('div', { class: 'help', style: { marginTop: '8px' } }, res.example))));
          return;
        }
        $('#f_date').value = res.parsed.date;
        $('#f_start').value = res.parsed.start;
        $('#f_end').value = res.parsed.end;
        drawResults(res, res.parsed);
      } catch (e) { toast(errorMessage(e), 'err'); mount(resultsBox, h('div', {})); }
    }
  }, '✨ Smart Search');

  function drawResults(res, criteria) {
    mount(resultsBox,
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', {}, `${res.count} salle(s) disponible(s) — ${fmtDay(criteria.date)} de ${criteria.start} à ${criteria.end}`),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn sm secondary', onclick: () => window.print() }, '🖨️ Imprimer'),
            h('a', { class: 'btn sm secondary', href: `/api/export/reservations.csv${qs({ from: criteria.date, to: criteria.date })}` }, '⬇ Export'))),
        h('div', { class: 'help', style: { marginBottom: '12px' } }, res.note || ''),
        res.count
          ? h('div', { class: 'room-grid' }, res.rooms.map((r) => h('div', { class: 'room free' },
            h('div', { class: 'code' }, r.code),
            h('div', { class: 'meta' }, `${r.floor} · ${r.location}`),
            r.equipment ? h('div', { class: 'now', style: { borderTop: 0, paddingBottom: 0 } }, `🎧 ${r.equipment}`) : null,
            h('div', { class: 'state', style: { color: 'var(--ok)' } }, h('span', { class: 'dot' }), 'DISPONIBLE'),
            APP.user.role !== 'enseignant'
              ? h('div', { class: 'actions' },
                h('button', {
                  class: 'btn sm', onclick: () => openReservationModal({
                    room_id: r.id, room_code: r.code, date: criteria.date, start: criteria.start, end: criteria.end
                  })
                }, 'Réserver'))
              : null)))
          : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🚫'),
            'Aucune salle libre sur ce créneau. Essayez une autre plage horaire.')));
  }

  mount(root,
    pageHead('Trouver une salle', 'Recherche intelligente — la salle S12-1ER (Master Management) est automatiquement exclue, et le nombre d’étudiants n’est jamais utilisé comme filtre'),
    h('div', { class: 'card' },
      h('h3', {}, 'Recherche par créneau'),
      structured),
    h('div', { class: 'card' },
      h('h3', {}, 'Smart Search (langage naturel)'),
      h('div', { class: 'form-row' }, smartInput, smartBtn),
      h('div', { class: 'help', style: { marginTop: '7px' } }, 'Exemples : « trouve-moi une salle mardi de 10h à 12h », « jeudi 14h-16h », « salle libre mercredi pendant 2h »')),
    resultsBox);

  if (presetRoom) {
    setTimeout(() => { const formEl = $('form', root); if (formEl) formEl.requestSubmit(); }, 120);
  }
  return root;
}
