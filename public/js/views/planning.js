/* SmartSalle ISPITS — planning hebdomadaire + vue impression A4 paysage */
'use strict';

const SEMESTERS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

/* Valeur de semestre normalisée côté client : '3' / 's3' / 'Semestre 3' → 'S3'.
   Le serveur applique exactement la même règle (services.semesterVariants) :
   boutons S1→S6, pastilles « Pages officielles » et base de données parlent
   ainsi le même langage, quel que soit le format stocké. */
function normSemester(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (!raw) return '';
  const num = raw.replace(/^SEMESTRE\s*/, '').trim().replace(/^S/, '').trim();
  return /^[1-6]$/.test(num) ? `S${num}` : raw;
}

const PLANNING_FILTERS = ['week', 'option_id', 'group_id', 'module_id', 'teacher_id', 'room_code', 'floor', 'semester'];

function planningQuery(query) {
  return {
    week: query.week || '',
    option_id: query.option_id || '',
    group_id: query.group_id || '',
    module_id: query.module_id || '',
    teacher_id: query.teacher_id || '',
    room_code: query.room_code || '',
    floor: query.floor || '',
    semester: query.semester || ''
  };
}

async function fetchPlanning(f) {
  return get(`/api/planning${qs({
    week: f.week || todayISO(), option_id: f.option_id, group_id: f.group_id, module_id: f.module_id,
    teacher_id: f.teacher_id, room_code: f.room_code, floor: f.floor, semester: f.semester
  })}`);
}

/* ---------- Grille horaire : une séance occupe autant de lignes que sa durée ----------

   L'écran ET l'impression partagent la même grille en bandes de 2 h —
   08:00-10:00, 10:00-12:00, 12:00-14:00, 14:00-16:00, 16:00-18:00, soit 5 lignes
   au total, chaque case respectant exactement la marge horaire. Une séance remplit
   TOUTE la hauteur de sa bande ; si elle se termine dans la bande suivante, elle
   fusionne les lignes via rowSpan. Avant, seule la première ligne était remplie :
   la ligne suivante restait vide, ce qui décalait les cellules.

   `spanMatrix` est le cœur commun : il reçoit des lignes de dimensions quelconques
   (en minutes), calcule la hauteur de chaque cellule et marque les lignes suivantes
   comme déjà couvertes par la séance du dessus.                                */
function spanMatrix(rows, colKeys, pick) {
  const covered = new Set();
  return rows.map((row, ri) => colKeys.map((ck) => {
    if (covered.has(`${ck}|${ri}`)) return { ck, skipped: true, span: 1, items: [] };
    const list = pick(ck, row) || [];
    let span = 1;
    const items = list.slice().sort((a, b) => a.start_min - b.start_min);
    items.forEach((r) => {
      let last = rows.length - 1;
      for (let k = ri; k < rows.length; k++) {
        if (r.end_min > rows[k].start && r.end_min <= rows[k].end) { last = k; break; }
      }
      for (let k = ri + 1; k <= last; k++) covered.add(`${ck}|${k}`);
      span = Math.max(span, Math.min(last - ri + 1, rows.length - ri));
    });
    return { ck, skipped: false, span, items };
  }));
}

function hhmmLabel(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;
}

/* Bandes horaires (grille à l'écran + feuille imprimée) : 2 h par défaut —
   08:00-10:00, 10:00-12:00, 12:00-14:00, 14:00-16:00, 16:00-18:00 = 5 lignes.
   `allBands` : on affiche le tableau TOTAL —
   toutes les bandes du jour (day_start → day_end) même sans programmation,
   pour que la page officielle reste une grille complète et vide le cas échéant. */
function timeBands(reservations, settings, allBands) {
  const s = settings || {};
  const toMin = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
  const from = toMin(s.day_start); const to = toMin(s.day_end);
  const size = Math.max(30, (parseInt(s.session_hours, 10) || 2) * 60);
  const all = [];
  for (let m = from == null ? 480 : from; m < (to == null ? 1080 : to); m += size) {
    all.push({ start: m, end: Math.min(m + size, to == null ? 1080 : to) });
  }
  if (!all.length) all.push({ start: 480, end: 540 });
  const used = (b) => reservations.some((r) => r.status === 'CONFIRMED' && r.start_min < b.end && r.end_min > b.start);
  const chosen = allBands ? all : (all.filter(used).length ? all.filter(used) : [all[0]]);
  return chosen.map((b) => ({ start: b.start, end: b.end, label: `${hhmmLabel(b.start)}-${hhmmLabel(b.end)}` }));
}

/* Date numérique courte utilisée dans l’en-tête des colonnes (5/10/2026). */
function fmtDayNum(day) {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day || '';
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function dayHours(settings) {
  const startH = parseInt(String((settings || {}).day_start || '08:00').split(':')[0], 10);
  const endH = parseInt(String((settings || {}).day_end || '18:00').split(':')[0], 10);
  const hours = [];
  for (let hh = startH; hh < endH; hh++) hours.push(hh);
  return hours;
}

function canCreateSession() {
  return APP.user && APP.user.role !== 'enseignant';
}

function newSessionUrl(day, startMin, roomId) {
  return `/reservations/new${qs({ date: day, start: hhmmLabel(startMin), room: roomId || '' })}`;
}

/* Vider l’emploi du temps d’un SEMESTRE. Confirmation obligatoire (saisie de
   « VIDER »), puis envoi du semestre au serveur : les autres semestres ne sont
   jamais touchés. */
async function clearSemesterPlanning(semester, onDone) {
  const box = h('div', {});
  const m = modal({
    title: `Vider l’emploi du temps ${semester}`,
    body: box,
    foot: []
  });
  const f = form({
    fields: [{
      name: 'confirm', label: 'Tapez VIDER pour confirmer', required: true,
      placeholder: 'VIDER'
    }],
    submitLabel: `🗑 Vider ${semester}`,
    onSubmit: async (vals) => {
      if (String(vals.confirm || '').trim() !== 'VIDER') {
        toast('Confirmation invalide : tapez exactement « VIDER ».', 'warn');
        return;
      }
      const res = await post('/api/admin/clear-planning', { confirm: 'VIDER', semester });
      toast(res.message || `${semester} vidé.`, 'ok');
      m.close();
      if (onDone) onDone();
      if (window.onReservationChanged) window.onReservationChanged();
    }
  });
  mount(box,
    h('p', { class: 'help', style: { marginTop: 0 } },
      `Seules les réservations du semestre ${semester} seront supprimées. Les autres semestres, ` +
      'les salles, options, groupes, modules et enseignants sont conservés.'),
    f);
}

function slotNode(r) {
  const mine = r.created_by === APP.user.id ||
    (APP.user.approved_options || []).some((o) => o.id === r.option_id);
  const cls = r.status === 'CANCELLED' ? 'cancelled' : (mine ? 'mine' : 'other-option');
  /* Actions en un clic : au survol de la séance, ✏️ reprogramme et 🗑 supprime
     (réservé à l’administration / coordinateur de l’option, comme le serveur). */
  const quick = canManageReservation(r) ? h('div', { class: 'slot-quick no-print' },
    h('button', {
      class: 'sq', title: 'Modifier cette séance (un clic)',
      onclick: (e) => { e.stopPropagation(); editReservation(r, null); }
    }, '✏️'),
    h('button', {
      class: 'sq sq-del', title: 'Supprimer cette séance (un clic)',
      onclick: (e) => { e.stopPropagation(); deleteReservation(r); }
    }, '🗑')) : null;
  return h('div', {
    class: `slot ${cls}`,
    title: `${r.room_code} · ${r.start}–${r.end} · ${r.option_code} · ${r.group_code || ''} · ${r.module_name || ''}`,
    onclick: () => showReservation(r)
  },
    quick,
    h('b', {}, `${r.room_code} · ${r.start}–${r.end}`),
    h('span', { class: 'm' }, [r.semester, r.option_code, r.group_code].filter(Boolean).join(' · ')),
    r.module_name ? h('div', { class: 'm' }, r.module_name) : null,
    r.teacher_name ? h('div', { class: 'm', style: { fontStyle: 'italic' } }, r.teacher_name) : null);
}

function planningLegend() {
  return h('div', { class: 'planning-legend no-print' },
    h('span', {}, h('span', { class: 'sw', style: { background: '#e7f6ec' } }), 'Réservations de mes options'),
    h('span', {}, h('span', { class: 'sw', style: { background: '#fdf1e0' } }), 'Autres options (visibles, non modifiables)'),
    canCreateSession() ? h('span', {}, '🖱️ Cliquez sur une case vide pour y placer une séance') : null,
    h('span', {}, 'Cliquez sur une séance pour le détail'),
    canCreateSession() ? h('span', {}, '✏️/🗑 Au survol d’une séance : modifier ou supprimer en un clic') : null);
}

/* ---------- Vue par jour ---------- */
function buildDayGrid(data) {
  /* Bandes de 2 h, identiques à la feuille imprimée : 5 lignes (08:00-10:00 → 16:00-18:00). */
  const bands = timeBands(data.reservations, data.settings, true);
  const closed = String(data.settings.closed_days || 'sun').split(',');
  const keys = data.days.map((d) => d.date);
  const matrix = spanMatrix(bands, keys, (day, b) => data.reservations.filter(
    (r) => r.day === day && r.status === 'CONFIRMED' && r.start_min >= b.start && r.start_min < b.end));
  const canCreate = canCreateSession();

  const thead = h('thead', {}, h('tr', {},
    h('th', {}, 'Heure'),
    data.days.map((d) => h('th', {}, d.name, h('span', { class: 'd' }, fmtDayShort(d.date))))));

  const tbody = h('tbody', {}, matrix.map((cells, i) => {
    const band = bands[i];
    const kids = [h('th', {}, `${hhmmLabel(band.start)}-${hhmmLabel(band.end)}`)];
    cells.forEach((c) => {
      if (c.skipped) return; // bande déjà couverte par la séance du dessus (rowspan)
      const day = data.days.find((d) => d.date === c.ck);
      const isClosed = closed.includes(day.key);
      const attrs = { class: isClosed ? 'closed' : '' };
      if (c.span > 1) attrs.rowSpan = c.span;
      if (!c.items.length && !isClosed && canCreate) {
        attrs.class = `${attrs.class} free`.trim();
        attrs.title = `Créer une séance le ${fmtDay(day.date)} — ${hhmmLabel(band.start)}-${hhmmLabel(band.end)}`;
        attrs.onclick = () => navigateTo(newSessionUrl(day.date, band.start));
      }
      kids.push(h('td', attrs, c.items.map((r) => slotNode(r))));
    });
    return h('tr', {}, kids);
  }));

  return h('div', { class: 'planning-wrap' }, h('table', { class: 'planning' }, thead, tbody));
}

/* ---------- Vue par salle ---------- */
function buildRoomGrid(data) {
  const rooms = data.rooms.filter((r) => !data.filterFloor || r.floor === data.filterFloor);
  const hours = dayHours(data.settings);
  const canCreate = canCreateSession();
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, 'Salle'),
    data.days.map((d) => h('th', {}, d.name, h('span', { class: 'd' }, fmtDayShort(d.date))))));
  const tbody = h('tbody', {}, rooms.map((room) => h('tr', {},
    h('th', { style: { textAlign: 'left', width: '110px' } },
      h('div', {}, room.code),
      h('div', { class: 'd', style: { fontSize: '10.5px', opacity: .8 } }, room.floor)),
    data.days.map((d) => {
      const cellRes = data.reservations.filter((r) => r.day === d.date && r.room_id === room.id && r.status === 'CONFIRMED')
        .sort((a, b) => a.start_min - b.start_min);
      const attrs = {};
      if (!cellRes.length && canCreate) {
        attrs.class = 'free';
        attrs.title = `Créer une séance — ${room.code}, ${d.name}`;
        attrs.onclick = () => navigateTo(newSessionUrl(d.date, (hours[0] || 9) * 60, room.id));
      }
      return h('td', attrs, cellRes.map((r) => slotNode(r)));
    }))));
  return h('div', { class: 'planning-wrap' }, h('table', { class: 'planning' }, thead, tbody));
}

/* ---------- Planning ---------- */
async function ViewPlanning(query) {
  const root = h('div', {});
  mount(root, loadingCard('Chargement du planning…'));
  const f = planningQuery(query);
  const [data, catalogs] = await Promise.all([fetchPlanning(f), loadCatalogData()]);
  data.filterFloor = f.floor;
  let mode = query.view === 'rooms' ? 'rooms' : 'days';

  const gridBox = h('div', {});
  function draw() {
    mount(gridBox, mode === 'rooms' ? buildRoomGrid(data) : buildDayGrid(data), planningLegend());
  }

  const filterBar = h('div', { class: 'filters no-print' },
    h('span', { class: 'lbl' }, 'Semaine du'),
    h('input', { type: 'date', value: f.week || todayISO(), onchange: (e) => navigateTo(`/planning${qs({ ...f, week: e.target.value, view: mode })}`) }),
    /* Sélecteur de semestre OBLIGATOIRE : chaque emploi du temps est autonome
       par semestre. Il n'existe plus de vue « Tous les semestres ». */
    h('select', {
      title: 'Semestre de l’emploi du temps (obligatoire)',
      onchange: (e) => navigateTo(`/planning${qs({ ...f, semester: e.target.value, view: mode })}`)
    },
      SEMESTERS.map((s) => h('option', { value: s, selected: (f.semester || 'S1') === s }, s))),
    h('select', { onchange: (e) => navigateTo(`/planning${qs({ ...f, option_id: e.target.value, view: mode })}`) },
      h('option', { value: '' }, 'Toutes les options'),
      catalogs.options.map((o) => h('option', { value: o.id, selected: String(o.id) === String(f.option_id) }, o.code))),
    h('select', { onchange: (e) => navigateTo(`/planning${qs({ ...f, group_id: e.target.value, view: mode })}`) },
      h('option', { value: '' }, 'Tous les groupes'),
      catalogs.groups.map((g) => h('option', { value: g.id, selected: String(g.id) === String(f.group_id) }, `${g.code}`))),
    h('select', { onchange: (e) => navigateTo(`/planning${qs({ ...f, module_id: e.target.value, view: mode })}`) },
      h('option', { value: '' }, 'Tous les modules'),
      catalogs.modules.map((m) => h('option', { value: m.id, selected: String(m.id) === String(f.module_id) }, `${m.code}`))),
    h('select', { onchange: (e) => navigateTo(`/planning${qs({ ...f, teacher_id: e.target.value, view: mode })}`) },
      h('option', { value: '' }, 'Tous les enseignants'),
      catalogs.teachers.map((t) => h('option', { value: t.id, selected: String(t.id) === String(f.teacher_id) }, `${t.prenom} ${t.nom}`))),
    h('input', { type: 'text', placeholder: 'Salle', value: f.room_code, style: { width: '110px' }, onchange: (e) => navigateTo(`/planning${qs({ ...f, room_code: e.target.value, view: mode })}`) }),
    h('select', { onchange: (e) => navigateTo(`/planning${qs({ ...f, floor: e.target.value, view: mode })}`) },
      h('option', { value: '' }, 'Tous les étages'),
      ['RDC', '1ER', 'AMPHI'].map((x) => h('option', { value: x, selected: f.floor === x }, x))),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '7px', flexWrap: 'wrap' } },
      h('button', { class: `btn sm ${mode === 'days' ? '' : 'secondary'}`, onclick: () => { mode = 'days'; draw(); } }, 'Par jour'),
      h('button', { class: `btn sm ${mode === 'rooms' ? '' : 'secondary'}`, onclick: () => { mode = 'rooms'; draw(); } }, 'Par salle'),
      h('a', { class: 'btn sm secondary', href: `#/print${qs(f)}` }, '🖨️ Imprimer'),
      /* L’export reprend les mêmes filtres que l’écran (option / groupe /
         semestre) pour que le fichier Excel corresponde au planning affiché. */
      h('a', { class: 'btn sm secondary', href: `/api/export/planning.xls${qs({ from: data.from, to: data.to, option_id: f.option_id, group_id: f.group_id, semester: f.semester })}` }, '⬇ Excel'),
      h('button', {
        class: 'btn sm secondary',
        title: 'Ajouter un cours dans l’emploi du temps de ce semestre',
        onclick: () => navigateTo(`/reservations/new${qs({ semester: f.semester || 'S1' })}`)
      }, '＋ Ajouter un cours')));

  /* Vider l’emploi du temps du SEMESTRE sélectionné uniquement : les autres
     semestres ne sont jamais touchés. Confirmation explicite requise. */
  const clearBar = APP.user.role === 'admin'
    ? h('div', { class: 'filters no-print', style: { marginTop: '-6px' } },
      h('button', { class: 'btn sm danger', onclick: () => clearSemesterPlanning(f.semester || 'S1', draw) }, '🧹 Vider et reprogrammer le semestre'),
      h('span', { class: 'help' }, 'Ne concerne que le semestre sélectionné.'))
    : null;

  const title = APP.user.role === 'enseignant' ? 'Mon planning' : (APP.user.role === 'admin' ? 'Planning global' : 'Planning de mon option');
  const semesterLabel = ` · Semestre ${f.semester || 'S1'}`;

  mount(root,
    pageHead(title, `Semaine du ${fmtDay(data.from)} au ${fmtDay(data.to)}${semesterLabel} · ${data.settings.day_start} → ${data.settings.day_end} · ${data.reservations.length} réservation(s)`,
      APP.user.role !== 'enseignant' ? [h('a', { class: 'btn secondary', href: '#/reservations/new' }, '＋ Nouvelle réservation')] : []),
    filterBar, clearBar, gridBox);

  draw();
  return root;
}

/* ==================== VUE D'IMPRESSION (format officiel ISPITS) ==================== */
function teacherHonor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name ? `Pr. ${name}` : '';
  return `Pr. ${parts[parts.length - 1].toUpperCase()} ${parts.slice(0, -1).join(' ')}`;
}

function printItem(r, showRooms) {
  const meta = [showRooms && r.room_code ? r.room_code : '', r.group_code || ''].filter(Boolean).join(' · ');
  return h('div', { class: 'pg-item' },
    r.module_name ? h('div', { class: 'pg-mod' }, r.module_name) : h('div', { class: 'pg-mod' }, r.title || '—'),
    r.teacher_name ? h('div', { class: 'pg-tea' }, teacherHonor(r.teacher_name)) : null,
    meta ? h('div', { class: 'pg-meta' }, meta) : null);
}function sigBlock(label, name) {
  return h('div', { class: 'pg-sig' },
    h('div', { class: 'pg-sig-label' }, label),
    h('div', { class: 'pg-sig-name' }, name || ' '),
    h('div', { class: 'pg-sig-space' }));
}

async function ViewPrint(query) {
  const root = h('div', { class: 'print-sheet' });
  mount(root, loadingCard('Préparation de l’impression…'));
  const f = planningQuery(query);
  f.semester = normSemester(f.semester) || 'S1';
  /* `full` (plein écran) fait partie de l’état de la page : il doit survivre à un
     changement de date, d’option ou de semestre — sans cela la feuille sautait
     hors du plein écran au premier clic et semblait « bloquée ». */
  f.full = String(query.full || '') === '1' ? '1' : '';
  const [data, catalogs] = await Promise.all([fetchPlanning(f), loadCatalogData()]);
  const s = data.settings;
  const headerLines = String(s.pdf_header || '').split('\n').filter(Boolean);
  const optionSelected = catalogs.options.find((o) => String(o.id) === String(f.option_id));
  const groupSelected = catalogs.groups.find((g) => String(g.id) === String(f.group_id));
  const semester = f.semester || 'S1';
  // Titre officiel du document : c’est ce texte que le navigateur imprime en
  // en-tête du papier, il ne doit donc pas contenir le nom de l’application.
  root.dataset.docTitle = `Emploi du temps${semester ? ` — semestre ${semester.slice(1)}` : ''} — ${(s.institution_name || 'ISPITS').trim()}`;
  const closed = String(s.closed_days || 'sun').split(',');
  const showRooms = String(s.print_show_rooms || '1') !== '0';
  const headImg = String(s.pdf_header_image || '').trim();
  const footImg = String(s.pdf_footer_image || '').trim();

  /* Responsables : coordinateur de l'option imprimée, sinon le premier
     coordinateur ; DAC et directeur = comptes administrateurs actifs. */
  const officials = data.officials || [];
  const links = data.coordinator_options || [];
  const fullName = (u) => (u ? `${u.prenom || ''} ${u.nom || ''}`.trim() : '');
  const coordOption = optionSelected
    ? officials.find((u) => u.role === 'coordinateur' && links.some((l) => l.user_id === u.id && String(l.option_id) === String(optionSelected.id)))
    : null;
  const anyCoord = officials.find((u) => u.role === 'coordinateur');
  const admin = officials.find((u) => u.role === 'admin');

  const confirmed = data.reservations.filter((r) => r.status === 'CONFIRMED');
  /* Aucun cours pour ce filtre : on le dit clairement plutôt que de laisser un
     tableau vide donner l’impression que les programmes ont disparu. */
  const emptyMsg = confirmed.length ? null
    : (semester ? 'Aucun programme disponible pour ce semestre'
      : 'Aucun programme disponible pour cette semaine');
  // Impression : tableau total, toutes les bandes horaires même si vide.
  const bands = timeBands(confirmed, s, true);
  const matrix = spanMatrix(bands, data.days.map((d) => d.date), (day, b) => confirmed.filter(
    (r) => r.day === day && r.start_min >= b.start && r.start_min < b.end));

  /* --- Tableau : une colonne « Heure » + une colonne par jour.
         Les informations administratives (filière / option / année) sont
         affichées SANS cadre au-dessus du tableau ; les signatures des
         responsables sont déplacées SOUS le tableau (4 blocs alignés).     --- */
  const adminInfo = [
    `Filière : ${optionSelected ? (optionSelected.category || '—') : 'Toutes les filières'}`,
    `Option : ${optionSelected ? (optionSelected.name ? `${optionSelected.code} — ${optionSelected.name}` : optionSelected.code) : 'Toutes les options'}`,
    groupSelected ? `Groupe : ${groupSelected.code}` : null,
    `Semestre ${semester.slice(1)}`,
    `Année universitaire ${s.academic_year || ''}`
  ].filter(Boolean);

  const rows = [
    h('tr', {},
      h('th', { class: 'pg-corner' }),
      h('th', { class: 'pg-band', colspan: String(data.days.length) },
        h('span', { class: 'b' }, 'EMPLOI DU TEMPS'),
        h('span', { class: 's' }, semester ? `Semestre ${semester.slice(1)} — année universitaire ${s.academic_year || ''}` : `Année universitaire ${s.academic_year || ''}`))),
    h('tr', {}, h('th', { class: 'pg-corner' }),
      data.days.map((d) => h('th', { class: 'pg-day' }, d.name, h('span', { class: 'd' }, fmtDayNum(d.date)))))
  ];

  matrix.forEach((cells, i) => {
    const band = bands[i];
    const kids = [h('th', { class: 'pg-time' }, h('span', {}, hhmmLabel(band.start)), h('span', { class: 'dash' }, '-'), h('span', {}, hhmmLabel(band.end)))];
    cells.forEach((c) => {
      if (c.skipped) return; // bande déjà couverte par la séance du dessus (rowSpan)
      const day = data.days.find((d) => d.date === c.ck);
      // Case vide : pas de « boîte » vide sur le papier — seulement les séances
      // sont encadrées, les autres cellules restent en ligne continue.
      const attrs = { class: `pg-cell${closed.includes(day.key) ? ' closed' : ''}${c.items.length ? '' : ' empty'}` };
      if (c.span > 1) attrs.rowSpan = c.span;
      kids.push(h('td', attrs, c.items.map((r) => printItem(r, showRooms))));
    });
    rows.push(h('tr', {}, kids));
  });

  /* Un semestre est TOUJOURS choisi : il n'existe plus d'impression « Tous les
     semestres ». Sans semestre dans l’URL on en applique un par défaut (S1)
     pour que l’URL partageable reste valable. */
  const semesterLinks = h('div', { class: 'no-print', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px', alignItems: 'center' } },
    h('span', { class: 'lbl', style: { marginRight: '4px' } }, 'Imprimer le semestre :'),
    SEMESTERS.map((x) => h('a', {
      class: `btn sm ${semester === x ? '' : 'secondary'}`,
      href: `#/print${qs({ ...f, semester: x })}`,
      title: `Programme du semestre ${x.slice(1)}`,
      'aria-current': semester === x ? 'true' : null
    }, x)));

  /* Plein écran : la feuille occupe tout l’écran (pas de barre latérale, pas de
     bandeau) — c’est la page « seule » par option / semestre / groupe. */
  const isFull = f.full === '1';
  if (isFull) {
    document.body.classList.add('sheet-full');
    const off = () => {
      document.body.classList.remove('sheet-full');
      window.removeEventListener('hashchange', off);
    };
    window.addEventListener('hashchange', off);
  }

  const optionPicker = h('select', { title: 'Filière / option à imprimer', onchange: (e) => navigateTo(`/print${qs({ ...f, option_id: e.target.value })}`) },
    h('option', { value: '' }, 'Toutes les options'),
    catalogs.options.map((o) => h('option', { value: o.id, selected: String(o.id) === String(f.option_id) }, `${o.category ? o.category + ' / ' : ''}${o.code}`)));

  const weekPicker = h('input', { type: 'date', value: f.week || todayISO(), title: 'Semaine à imprimer',
    onchange: (e) => navigateTo(`/print${qs({ ...f, week: e.target.value })}`) });

  mount(root,
    h('div', { class: `actions no-print${isFull ? ' sheet-toolbar' : ''}`, style: { marginBottom: '14px', display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' } },
      h('button', { class: 'btn secondary', onclick: () => window.history.back() }, isFull ? '✕ Fermer' : '← Retour'),
      h('a', { class: 'btn secondary', href: '#/sheets' }, '📄 Toutes les pages'),
      h('span', { class: 'lbl' }, 'Semaine du'), weekPicker,
      h('span', { class: 'lbl' }, 'Filière / option'), optionPicker,
      h('button', { type: 'button', class: 'btn secondary', onclick: () => window.print() }, '👁 Aperçu / Imprimer'),
      h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, '💾 Enregistrer en PDF'),
      h('a', { class: 'btn secondary', href: `/api/export/planning.xls${qs({ from: data.from, to: data.to, option_id: f.option_id, group_id: f.group_id, semester: f.semester })}` }, '⬇ Export Excel')),    semesterLinks,
    headImg
      ? h('div', { class: 'pg-logo-head' },
          h('img', { src: headImg, alt: 'En-tête officiel ISPITS', onerror: (e) => { e.target.style.display = 'none'; } }),
          h('div', { class: 'pg-title' }, `EMPLOI DU TEMPS${semester ? ` — SEMESTRE ${semester.slice(1)}` : ''}`))
      : h('div', { class: 'pg-head' },
          headerLines.map((l, i) => h('div', { class: 'pg-hl', style: i === 0 ? { fontSize: '15px' } : {} }, l))),
    /* Informations administratives : sans cadre, sans bordure, sans fond. */
    h('div', { class: 'pg-admin' }, adminInfo.join('  ·  ')),
    /* Message explicite quand le filtre ne correspond à aucun cours enregistré. */
    emptyMsg ? h('div', { class: 'pg-empty' }, emptyMsg) : null,
    h('table', { class: 'pg-grid' },
      h('colgroup', {},
      h('col', { style: { width: '8%' } }),
        data.days.map(() => h('col', { style: { width: '15.33%' } }))),
      h('tbody', {}, rows)),
    /* Quatre blocs de signature alignés sur une seule ligne, sous le tableau.
       Libellés DYNAMIQUES : le titre dépend du genre du responsable (choisi à
       la création du compte) et de la filière imprimée — la filière « Soins
       Infirmiers » est dirigée par une Coordinatrice, toutes les autres par un
       Coordinateur. La règle s'applique seule, sans saisie possible. */
    h('div', { class: 'pg-foot' },
      sigBlock(optionTitle((coordOption || anyCoord || {}).gender), fullName(coordOption || anyCoord)),
      sigBlock(filiereTitle(optionSelected ? optionSelected.category : ''), ''),
      sigBlock(s.sig_dac || 'D.A.C des études', ''),
      sigBlock(s.sig_directeur || 'Directeur de l’ISPITS', '')),
    h('div', { class: 'pg-foot-note' },
      h('span', { class: 'pg-foot-cap' }, 'N.B des études :'),
      /* La période affichée doit TOUJOURS suivre la semaine choisie : le texte
         complémentaire éventuel s’ajoute, il ne remplace plus la période. */
      h('span', { class: 'pg-foot-txt' }, `Semaine du ${fmtDay(data.from)} au ${fmtDay(data.to)}${s.pdf_extra ? ' · ' + s.pdf_extra : ''} · N.B : Ce programme peut subir des changements au cours de la semaine`)),
    footImg ? h('div', { class: 'pg-logo-foot' },
      h('img', { src: footImg, alt: 'Pied de page officiel ISPITS', onerror: (e) => { e.target.style.display = 'none'; } })) : null,
    h('div', { class: 'readonly-note no-print' },
      `Format A4 paysage · ${bands.length} bande(s) horaire(s) de ${hhmmLabel(bands[0].start)} à ${hhmmLabel(bands[bands.length - 1].end)} · utilisez « Enregistrer en PDF ».`));
  return root;
}

/* ==================== INDEX : UNE PAGE PLEIN ÉCRAN PAR OPTION / SEMESTRE / GROUPE ====================
   L’organisation est automatique : on relève la semaine une seule fois, puis on
   compte les séances par option, par semestre et par groupe pour générer une
   page autonome (modèle officiel ISPITS) pour chaque combinaison.          */
async function ViewSheets(query) {
  const root = h('div', {});
  // Titre officiel imprimé par le navigateur — sans nom d’application.
  root.dataset.docTitle = 'Pages officielles de l’emploi du temps';
  mount(root, loadingCard('Organisation des pages…'));
  const week = query.week || todayISO();
  const [data, catalogs] = await Promise.all([fetchPlanning({ week }), loadCatalogData()]);
  const rs = data.reservations.filter((r) => r.status === 'CONFIRMED');
  const weekLabel = `Semaine du ${fmtDay(data.from)} au ${fmtDay(data.to)}`;

  const count = (optionId, semester, groupId) => rs.filter((r) =>
    (!optionId || String(r.option_id) === String(optionId)) &&
    (!semester || normSemester(r.semester) === normSemester(semester)) &&
    (!groupId || String(r.group_id) === String(groupId))).length;

  const options = (APP.user.role === 'coordinateur' && (APP.user.approved_options || []).length)
    ? APP.user.approved_options.filter((o) => o.status !== 'INACTIVE')
    : catalogs.options;

  const pageUrl = (optionId, semester, groupId) => `#/print${qs({
    week, option_id: optionId || '', semester: normSemester(semester) || '', group_id: groupId || '', full: 1
  })}`;

  const chip = (label, n, url, kind) => h('a', {
    class: `sheet-chip${kind || ''}${n ? '' : ' empty'}`,
    href: url, title: n ? `${n} séance(s) — ouvrir la page plein écran` : 'Aucune séance cette semaine'
  }, h('b', {}, label), h('span', {}, n ? `${n}` : '—'));

  const cards = options.map((o) => {
    const groups = catalogs.groups.filter((g) => String(g.option_id) === String(o.id));
    const total = count(o.id, '', '');
    const semChips = SEMESTERS.map((s) => [s, count(o.id, s, '')]).filter(([, n]) => n > 0);
    const grpChips = groups.map((g) => [g.code, count(o.id, g.semester || '', g.id), g]).filter(([, n]) => n > 0);
    return h('div', { class: 'sheet-card' },
      h('div', { class: 'sheet-card-head' },
        h('div', {},
          h('b', {}, o.code),
          h('div', { class: 'm' }, o.name || '')),
        h('span', { class: 'badge' }, `${total} séance(s)`)),
      // On ne crée de lien que pour les combinaisons qui ont réellement des
      // séances : plus de pastilles « boîte vide ».
      total ? h('div', { class: 'sheet-card-body' },
        h('div', { class: 'sheet-line' },
          h('span', { class: 'lbl' }, 'Semestres'),
          chip('Tous', total, pageUrl(o.id, '', '')),
          semChips.map(([s, n]) => chip(s, n, pageUrl(o.id, s, '')))),
        grpChips.length ? h('div', { class: 'sheet-line' },
          h('span', { class: 'lbl' }, 'Groupes'),
          grpChips.map(([code, n, g]) => chip(code, n, pageUrl(o.id, g.semester || '', g.id)))) : null)
        : h('div', { class: 'sheet-empty' }, 'Aucune séance cette semaine — ouvrez le planning pour en créer.'),
      h('div', { class: 'sheet-card-foot' },
        /* Plein écran = TOUTE la semaine de l’option : on n’impose aucun semestre
           (un semestre par défaut — même celui des paramètres — masquait les
           programmes existants et affichait une page vide). */
        h('a', { class: 'btn sm secondary', href: pageUrl(o.id, '', '') }, '⛶ Plein écran'),
        h('a', { class: 'btn sm secondary', href: `#/print${qs({ week, option_id: o.id })}` }, '🖨 Aperçu / imprimer')));
  });

  mount(root,
    pageHead('Pages officielles de l’emploi du temps',
      `${weekLabel} · une page autonome (plein écran) par option, semestre et groupe · modèle ISPITS`,
      [h('a', { class: 'btn secondary', href: `#/planning${qs({ week })}` }, '🗓️ Planning'),
       h('a', { class: 'btn', href: `#/print${qs({ week, full: 1 })}` }, '⛶ Toutes les options plein écran')]),
    h('div', { class: 'filters' },
      h('span', { class: 'lbl' }, 'Semaine du'),
      h('input', { type: 'date', value: week, onchange: (e) => navigateTo(`/sheets${qs({ ...query, week: e.target.value })}`) }),
      h('span', { class: 'lbl', style: { marginLeft: 'auto' } },
        `Modèle : en-tête officiel · bandes de 2 h · S1 → S6`)),
    cards.length ? h('div', { class: 'sheet-grid' }, cards) :
      h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'big' }, '🗓️'), 'Aucune option disponible.')));
  return root;
}
