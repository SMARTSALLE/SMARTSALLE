/* SmartSalle ISPITS — routeur, application shell, menus et synchronisation temps réel */
'use strict';

const MENUS = {
  admin: [
    { section: 'Pilotage' },
    { path: '/dashboard', label: 'Dashboard', icon: '🏠' },
    { path: '/admin/requests', label: 'Demandes de comptes', icon: '📨', badge: () => APP.pendingAccounts },
    { path: '/admin/users', label: 'Utilisateurs', icon: '👥' },
    { path: '/admin/audit', label: 'Historique', icon: '🕘' },
    { section: 'Pédagogie' },
    { path: '/admin/options', label: 'Options', icon: '🎯' },
    { path: '/pedagogy', label: 'Modules et enseignants', icon: '📚' },
    { section: 'Ressources' },
    { path: '/rooms', label: 'Salles', icon: '🚪' },
    { path: '/admin/equipment', label: 'Équipements', icon: '🎧' },
    { path: '/reservations', label: 'Réservations', icon: '📅' },
    { path: '/planning', label: 'Planning global', icon: '🗓️' },
    { path: '/absences/review', label: 'Absences et justificatifs', icon: '📋' },
    { path: '/sheets', label: 'Pages officielles', icon: '📄' },
    { path: '/find-room', label: 'Trouver une salle', icon: '🔍' },
    { section: 'Système' },
    { path: '/notifications', label: 'Notifications', icon: '🔔' },
    { path: '/admin/settings', label: 'Paramètres', icon: '⚙️' },
    { path: '/admin/export', label: 'Exportations', icon: '📦' }
  ],
  coordinateur: [
    { section: 'Coordination' },
    { path: '/dashboard', label: 'Dashboard', icon: '🏠' },
    { path: '/option', label: 'Mon option', icon: '🎯' },
    { path: '/find-room', label: 'Trouver une salle', icon: '🔍' },
    { path: '/reservations', label: 'Mes réservations', icon: '📅' },
    { path: '/planning', label: 'Planning', icon: '🗓️' },
    { path: '/sheets', label: 'Pages officielles', icon: '📄' },
    { section: 'Ressources pédagogiques' },
    { path: '/pedagogy', label: 'Modules et enseignants', icon: '📚' },
    { path: '/absences/review', label: 'Absences à vérifier', icon: '📋' },
    { path: '/rooms', label: 'Salles', icon: '🚪' },
    { section: 'Personnel' },
    { path: '/notes', label: 'Mes notes', icon: '📝' },
    { path: '/tasks', label: 'Mes tâches', icon: '✅' },
    { path: '/notifications', label: 'Notifications', icon: '🔔' }
  ],
  enseignant: [
    { section: 'Enseignement' },
    { path: '/dashboard', label: 'Dashboard', icon: '🏠' },
    { path: '/planning', label: 'Mon planning', icon: '🗓️' },
    { path: '/pedagogy', label: 'Mes modules', icon: '📚' },
    { path: '/reservations', label: 'Mes réservations', icon: '📅' },
    { path: '/absences', label: 'Absences de mes cours', icon: '📋' },
    { path: '/rooms', label: 'Salles', icon: '🚪' },
    { section: 'Personnel' },
    { path: '/notifications', label: 'Notifications', icon: '🔔' }
  ],
  etudiant: [
    { section: 'Scolarité' },
    { path: '/absences', label: 'Mes absences', icon: '📋' },
    { path: '/notifications', label: 'Notifications', icon: '🔔' }
  ]
};

const ROUTES = [
  { path: '/', public: true, view: () => ViewHome() },
  { path: '/login', public: true, view: () => ViewLogin() },
  { path: '/register', public: true, view: () => ViewRegister() },
  { path: '/verify', public: true, view: () => ViewVerify() },
  { path: '/forgot', public: true, view: () => ViewForgot() },
  { path: '/r/:token', public: true, view: (p) => ViewPublicRoom(p.token) },
  { path: '/dashboard', title: 'Dashboard', view: () => ViewDashboard() },
  { path: '/option', title: 'Mon option', view: () => ViewOption() },
  { path: '/rooms', title: 'Salles', view: () => ViewRooms() },
  { path: '/find-room', title: 'Trouver une salle', view: (p, q) => ViewFindRoom(q) },
  { path: '/reservations/new', title: 'Nouvelle réservation', view: (p, q) => ViewNewReservation(q), roles: ['admin', 'coordinateur'] },
  { path: '/reservations', title: 'Réservations', view: (p, q) => ViewReservations(q) },
  { path: '/planning', title: 'Planning', view: (p, q) => ViewPlanning(q) },
  { path: '/print', title: 'Impression', view: (p, q) => ViewPrint(q) },
  { path: '/sheets', title: 'Pages officielles', view: (p, q) => ViewSheets(q) },
  { path: '/modules', title: 'Modules', view: (p, q) => ViewPedagogy(q) },
  { path: '/pedagogy', title: 'Modules et enseignants', view: (p, q) => ViewPedagogy(q) },
  { path: '/teachers', title: 'Enseignants', view: () => ViewTeachers() },
  { path: '/notes', title: 'Mes notes', view: () => ViewNotes() },
  { path: '/tasks', title: 'Mes tâches', view: () => ViewTasks() },
  { path: '/notifications', title: 'Notifications', view: () => ViewNotifications() },
  { path: '/absences', title: 'Absences', view: (p, q) => ViewAbsences(q) },
  { path: '/absences/review', title: 'Absences et justificatifs', roles: ['admin', 'coordinateur'], view: (p, q) => ViewAbsencesReview(q) },
  { path: '/admin/users', title: 'Utilisateurs', roles: ['admin'], view: () => ViewAdminUsers() },
  { path: '/admin/requests', title: 'Demandes de comptes', roles: ['admin'], view: () => ViewAdminRequests() },
  { path: '/admin/options', title: 'Options', roles: ['admin'], view: () => ViewAdminOptions() },
  { path: '/admin/equipment', title: 'Équipements', roles: ['admin'], view: () => ViewEquipment() },
  { path: '/admin/audit', title: 'Historique', roles: ['admin'], view: () => ViewAudit() },
  { path: '/admin/settings', title: 'Paramètres', roles: ['admin'], view: () => ViewSettings() },
  { path: '/admin/export', title: 'Exportations', roles: ['admin'], view: () => ViewExport() }
];

function ViewHome() {
  return h('div', { class: 'auth-wrap' },
    authHero(),
    h('div', { class: 'auth-panel' },
      h('div', { class: 'auth-card' },
        h('h2', {}, 'Bienvenue'),
        h('div', { class: 'sub' }, 'Gestion intelligente des salles et des emplois du temps — ISPITS Laâyoune'),
        h('div', { style: { display: 'grid', gap: '10px', marginTop: '18px' } },
          h('a', { class: 'btn block', href: '#/login', style: { padding: '13px', fontSize: '15px' } }, 'CONNEXION'),
          h('a', { class: 'btn secondary block', href: '#/register', style: { padding: '13px', fontSize: '15px' } }, 'CRÉER UN COMPTE')),
        h('div', { class: 'auth-alt', style: { marginTop: '20px', lineHeight: 1.7 } },
          'Quatre espaces : Administration · Coordinateur · Enseignant · Étudiant')),
    ));
}

/* ---------------- Routeur ---------------- */
function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const query = {};
  if (queryPart) new URLSearchParams(queryPart).forEach((v, k) => { query[k] = v; });
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return { path: path === '' ? '/' : path, query };
}

function matchRoute(path) {
  for (const r of ROUTES) {
    if (r.path.includes(':')) {
      const prefix = `${r.path.split('/:')[0]}/`;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest && !rest.includes('/')) {
        const params = {};
        params[r.path.split('/:')[1]] = rest;
        return { route: r, params };
      }
    } else if (path === r.path) return { route: r, params: {} };
  }
  return null;
}

function navigateTo(path) {
  location.hash = `#${path}`;
}

async function ensureCatalogs() {
  /* Chaque catalogue est récupéré indépendamment : le refus d'un accès (403)
     sur l'un d'eux ne doit pas priver la page des autres. L'espace étudiant n'a
     pas besoin du catalogue des enseignants (réservé aux rôles pédagogiques). */
  const jobs = [
    ['__options', get('/api/options').then((v) => v.options || [])],
    ['__groups', get('/api/groups').then((v) => v.groups || [])]
  ];
  if (!APP.user || APP.user.role !== 'etudiant') {
    jobs.push(['__teachers', get('/api/teachers').then((v) => v.teachers || [])]);
  }
  const settled = await Promise.allSettled(jobs.map((j) => j[1]));
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') window[jobs[i][0]] = res.value;
  });
}

let rendering = false;
let renderQueued = false;
/* Une navigation survenue pendant un rendu en cours (date + semestre cliqués
   rapidement, évènement temps réel…) n’est jamais perdue : elle est rejouée à la
   fin du rendu en cours. Sans cela, la page restait affichée sur l’ancienne
   semaine alors que l’URL avait déjà changé. */
async function renderRoute() {
  if (rendering) { renderQueued = true; return; }
  rendering = true;
  try {
    do {
      renderQueued = false;
      await renderPass();
    } while (renderQueued);
  } finally {
    rendering = false;
  }
}

/* Une passe de rendu : route, rôles, affichage de la vue. */
async function renderPass() {
  try {
    const { path, query } = parseHash();
    const match = matchRoute(path);

    if (!match) {
      navigateTo('/dashboard');
      return;
    }
    const route = match.route;

    // Pages publiques
    if (route.public) {
      mount(document.getElementById('app'), route.view(match.params, query));
      document.title = 'SmartSalle ISPITS';
      return;
    }

    // Authentification requise
    if (!APP.user) {
      const me = await get('/api/auth/me');
      APP.user = me.user;
      APP.settings = me.settings || {};
      APP.pendingAccounts = me.pending_accounts || 0;
      APP.unread = me.unread_notifications || 0;
      if (!APP.user) { navigateTo('/login'); return; }
    }

    // Compte en attente
    if (APP.user.status !== 'active') {
      mount(document.getElementById('app'), accountPendingScreen());
      return;
    }
    if (!APP.user.email_verified) { navigateTo('/verify'); return; }

    // Restrictions de rôle (côté serveur aussi)
    if (route.roles && !route.roles.includes(APP.user.role)) {
      toast('Accès refusé : page réservée à un autre rôle.', 'err');
      navigateTo('/dashboard');
      return;
    }

    // Coordinateur multi-options : forcer la sélection de l'option active
    if (APP.user.role === 'coordinateur' && path !== '/option' &&
      (APP.user.approved_options || []).length > 1 && !APP.user.active_option) {
      navigateTo('/option');
      return;
    }

    await ensureCatalogs();
    mount(document.getElementById('app'), buildShell());
    const content = document.getElementById('content');
    const result = route.view(match.params, query);
    let node = null;
    if (result && typeof result.then === 'function') {
      mount(content, loadingCard('Chargement…'));
      node = await result;
      if (node) mount(content, node);
    } else {
      node = result;
      mount(content, result);
    }
    // Vue d'impression : c'est ce titre que le navigateur imprime en en-tête du
    // papier (en-tête/pied par défaut). On y met un titre officiel, sans le nom
    // de l'application.
    document.title = (node && node.dataset && node.dataset.docTitle)
      ? node.dataset.docTitle
      : `${route.title} — SmartSalle ISPITS`;
    window.scrollTo(0, 0);
  } catch (e) {
    console.error(e);
    if (e && e.status === 401) { APP.user = null; navigateTo('/login'); return; }
    mount(document.getElementById('app'), h('div', { class: 'content' },
      h('div', { class: 'card' },
        h('div', { class: 'empty' }, h('span', { class: 'big' }, '⚠️'), errorMessage(e)),
        h('div', { style: { textAlign: 'center' } }, h('button', { class: 'btn', onclick: () => window.refresh() }, 'Réessayer')))));
  }
}

function accountPendingScreen() {
  const u = APP.user;
  return h('div', { class: 'auth-wrap' },
    authHero(),
    h('div', { class: 'auth-panel' },
      h('div', { class: 'auth-card' },
        h('h2', {}, 'Compte en attente'),
        h('div', { class: 'sub' }, `${u.prenom} ${u.nom} — ${u.email}`),
        h('div', { class: 'card', style: { borderLeft: '4px solid var(--warn)' } },
          h('div', { style: { display: 'grid', gap: '9px' } },
            h('div', {}, u.email_verified ? badge('Email vérifié', 'ok') : badge('Email non vérifié', 'warn'), ' ',
              u.status === 'active' ? badge('Compte validé', 'ok') : badge('Validation administrative requise', 'warn')),
            h('p', { class: 'help', style: { margin: '4px 0 0' } },
              'Votre compte sera activé après vérification de votre email puis validation par l’administration ISPITS. Vous serez notifié dès sa validation.'),
            h('div', { style: { display: 'flex', gap: '9px', flexWrap: 'wrap' } },
              !u.email_verified ? h('a', { class: 'btn', href: '#/verify' }, 'Vérifier mon email') : null,
              h('a', { class: 'btn secondary', href: '#/login' }, 'Aller à la connexion'),
              h('button', {
                class: 'btn secondary', onclick: async () => {
                  try {
                    const res = await post('/api/auth/logout');
                    void res;
                    APP.user = null;
                    navigateTo('/login');
                  } catch (e) { toast(errorMessage(e), 'err'); }
                }
              }, 'Se déconnecter')))))));
}

function buildShell() {
  const user = APP.user;
  const { path } = parseHash();
  const menu = MENUS[user.role] || [];

  const nav = h('nav', {}, menu.map((item) => {
    if (item.section) return h('div', { class: 'nav-section' }, item.section);
    const active = path === item.path || (item.path !== '/dashboard' && path.startsWith(item.path));
    const count = item.badge ? item.badge() : 0;
    return h('a', {
      class: `nav-link${active ? ' active' : ''}`,
      href: `#${item.path}`,
      onclick: () => { document.querySelector('.sidebar')?.classList.remove('open'); }
    },
      h('span', { class: 'ico' }, item.icon),
      h('span', {}, item.label),
      count ? h('span', { class: 'pill' }, count) : null);
  }));

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-brand' },
      h('div', { class: 'mark' }, h('img', {
        src: APP.settings.logo_url || '/assets/logo-ispits.png', alt: '',
        onerror: function () { const parent = this.parentNode; this.remove(); if (parent) parent.textContent = '◈'; }
      })),
      h('div', {},
        h('div', { class: 'brand-name' }, APP.settings.app_name || 'SMARTSALLE ISPITS'),
        h('div', { class: 'brand-sub' }, APP.settings.institution_name || 'ISPITS LAÂYOUNE'))),
    nav,
    h('div', { class: 'sidebar-foot' },
      h('div', {}, `${APP.settings.semester || 'S1'} · ${APP.settings.academic_year || ''}`),
      h('div', { style: { marginTop: '5px' } }, h('a', { href: '#/login', onclick: logout, style: { color: '#ffd7a1' } }, 'Déconnexion'))));

  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'mobile-head' },
      h('button', { class: 'icon-btn', onclick: () => document.querySelector('.sidebar').classList.toggle('open') }, '☰')),
    h('h1', {}, (matchRoute(path) && matchRoute(path).route.title) || 'SmartSalle'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'searchbox' },
      h('span', {}, '🔎'),
      h('input', {
        type: 'text', placeholder: 'Rechercher salle, groupe, module, enseignant…',
        onkeydown: (e) => { if (e.key === 'Enter') globalSearch(e.target.value); },
        oninput: (e) => { if (e.target.value.length >= 2) globalSearch(e.target.value, true); }
      })),
    h('div', { class: 'presence', id: 'presence', title: 'Utilisateurs connectés' }, h('span', { class: 'p-label' }, 'Chargement…')),
    h('button', { class: 'icon-btn', title: 'Notifications', onclick: () => navigateTo('/notifications') },
      '🔔', h('span', { class: 'dot', id: 'notif-count', style: { display: APP.unread > 0 ? 'grid' : 'none' } }, String(APP.unread || ''))),
    h('div', { class: 'user-chip', onclick: userMenu },
      h('div', { class: 'avatar' }, initials(`${user.prenom} ${user.nom}`)),
      h('div', { class: 'who' },
        h('b', {}, `${user.prenom} ${user.nom}`),
        h('span', {}, roleLabel(user.role) + (user.active_option ? ` · ${user.active_option.code}` : '')))));

  const bottomItems = (MENUS[user.role] || []).filter((m) => m.path).slice(0, 5);
  const bottomNav = h('nav', { class: 'bottom-nav' },
    bottomItems.map((m) => h('a', { class: path === m.path ? 'active' : '', href: `#${m.path}` },
      h('span', { class: 'ico' }, m.icon), h('span', {}, m.label.split(' ')[0]))));

  return h('div', { class: 'app-shell' },
    sidebar,
    h('div', { class: 'main' }, topbar, h('main', { class: 'content', id: 'content' })),
    bottomNav);
}

function userMenu() {
  const u = APP.user;
  modal({
    title: 'Mon compte',
    body: h('div', {},
      table([
        { key: 'k', label: 'Champ' },
        { key: 'v', label: 'Valeur' }
      ], [
        { k: 'Nom', v: `${u.prenom} ${u.nom}` },
        { k: 'Email', v: u.email },
        { k: 'Rôle', v: roleLabel(u.role) },
        /* Titre déduit de la fonction choisie à la création du compte. */
        { k: 'Titre', v: u.role === 'enseignant' ? '—' : `${coordinatorTitle(u.gender)}` },
        { k: 'Option active', v: u.active_option ? `${u.active_option.code} — ${u.active_option.name}` : '—' },
        { k: 'Options approuvées', v: (u.approved_options || []).map((o) => o.code).join(', ') || '—' },
        { k: 'Statut', v: STATUS_LABEL[u.status] || u.status }
      ]),
      h('div', { style: { marginTop: '16px' } },
        h('h3', {}, 'Changer mon mot de passe'),
        form({
          inline: true,
          fields: [
            { name: 'current', label: 'Mot de passe actuel', type: 'password', required: true },
            { name: 'next', label: 'Nouveau mot de passe', type: 'password', required: true }
          ],
          submitLabel: 'Modifier',
          onSubmit: async (values) => {
            const res = await post('/api/auth/change-password', values);
            toast(res.message, 'ok');
          }
        }))),
    foot: [
      h('button', { class: 'btn secondary', onclick: logout }, 'Se déconnecter'),
      h('button', { class: 'btn', onclick: () => { document.getElementById('modal-root').innerHTML = ''; } }, 'Fermer')
    ]
  });
}

async function logout() {
  try { await post('/api/auth/logout'); } catch (e) { /* ignore */ }
  APP.user = null;
  if (APP.eventSource) { try { APP.eventSource.close(); } catch (e) {} }
  document.getElementById('modal-root').innerHTML = '';
  navigateTo('/login');
}

/* ---------------- Recherche globale ---------------- */
let searchBox = null;
async function globalSearch(q, live) {
  if (!q || q.length < 2) return;
  try {
    const res = await get(`/api/search/global${qs({ q })}`);
    if (live) {
      // simple feedback : toast discret si vide
      if (!res.results.length && q.length > 3) return;
      if (!live) return;
    }
    modal({
      title: `Recherche : « ${q} »`,
      body: res.results.length
        ? h('div', { class: 'list' }, res.results.map((r) => h('a', {
          class: 'item', href: `#${r.link}`, onclick: () => { document.getElementById('modal-root').innerHTML = ''; }
        },
          h('div', { class: 'i-ico' }, { salle: '🚪', option: '🎯', groupe: '👥', module: '📚', enseignant: '🎓', réservation: '📅' }[r.kind] || '🔎'),
          h('div', { class: 'i-main' },
            h('b', {}, r.label),
            h('p', {}, `${r.kind}${r.sub ? ' · ' + r.sub : ''}`)))))
        : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🔍'), 'Aucun résultat.')
    });
  } catch (e) { /* ignore */ }
}

/* ---------------- Temps réel ---------------- */
let refreshTimer = null;
function handleRealtimeEvent(ev) {
  const t = ev.type || '';
  const r = ev.payload || {};
  if (t.startsWith('reservation')) {
    const labels = {
      'reservation.created': `Nouvelle réservation : ${r.reservation ? `${r.reservation.room_code} ${r.reservation.start}–${r.reservation.end} (${r.reservation.option_code})` : ''}`,
      'reservation.updated': `Réservation modifiée : ${r.reservation ? `${r.reservation.room_code} ${r.reservation.day} ${r.reservation.start}–${r.reservation.end}` : ''}`,
      'reservation.deleted': 'Réservation annulée par un autre utilisateur',
      'reservation.cleared': 'Le planning a été vidé par l’administration',
      'reservation.bulk': 'Copie de planning terminée'
    };
    if (labels[t]) toast(labels[t], 'warn');
    scheduleRefresh();
  } else if (t.startsWith('account') || t.startsWith('option') || t.startsWith('room') || t.startsWith('settings') || t.startsWith('group') || t.startsWith('module') || t.startsWith('teacher')) {
    scheduleRefresh();
  } else if (t === 'notification') {
    if (!r.user_id || r.user_id === (APP.user && APP.user.id)) {
      APP.unread += 1;
      updateBadge();
      toast(`🔔 ${r.title} — ${r.body}`, 'ok', 5000);
    }
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { window.refresh(); }, 450);
}

window.refresh = () => renderRoute();
window.navigateTo = navigateTo;
window.onReservationChanged = () => scheduleRefresh();

/* ---------------- Démarrage ---------------- */
/* Lien direct hors hash (ex. /print?… tapé dans la barre d’adresse ou après un
   rechargement) : on restaure la route dans le hash. Sans cela l’application
   repart sur la page d’accueil (connexion) alors que la session est valide —
   c’était le cas quand un lien « Imprimer » provoquait un rechargement complet. */
function restoreRouteFromPath() {
  if (location.hash) return;
  const p = location.pathname.replace(/\/index\.html$/, '');
  const rest = `${p}${location.search}`;
  if (rest && rest !== '/') history.replaceState(null, '', `/#${rest}`);
}

async function boot() {
  restoreRouteFromPath();
  try {
    const me = await get('/api/auth/me');
    APP.user = me.user;
    APP.settings = me.settings || {};
    APP.pendingAccounts = me.pending_accounts || 0;
    APP.unread = me.unread_notifications || 0;
  } catch (e) {
    APP.user = null;
  }

  if (APP.user) {
    connectRealtime(handleRealtimeEvent);
    const unread = await get('/api/notifications?limit=1').catch(() => null);
    if (unread) APP.unread = unread.unread;
  }

  window.addEventListener('hashchange', () => renderRoute());
  await renderRoute();
}

document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
