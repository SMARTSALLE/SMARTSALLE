/* SmartSalle ISPITS — boîte à outils UI (DOM, formulaires, tables, modales, toasts) */
'use strict';

function h(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'value') e.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') { if (v) e[k] = true; }
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendKids(e, children);
  return e;
}

function appendKids(parent, kids) {
  kids.forEach((k) => {
    if (k === null || k === undefined || k === false || k === true) return;
    if (Array.isArray(k)) { appendKids(parent, k); return; }
    if (k instanceof Node) { parent.appendChild(k); return; }
    parent.appendChild(document.createTextNode(String(k)));
  });
  return parent;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
function mount(node, ...kids) { clear(node); appendKids(node, kids); return node; }
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [...(root || document).querySelectorAll(sel)]; }

/* ---------------- Toasts ---------------- */
function toast(message, type, ms) {
  const root = document.getElementById('toasts');
  const node = h('div', { class: `toast ${type || ''}` },
    h('span', { html: escapeHTML(message) }),
    h('span', { class: 't-close', onclick: () => node.remove() }, '✕'));
  root.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; setTimeout(() => node.remove(), 320); }, ms || (type === 'err' ? 6000 : 3600));
}

function errorMessage(err) {
  if (!err) return 'Erreur inconnue';
  if (err.code === 'SCHEDULE_CONFLICT') return 'Conflit de réservation : ce créneau est déjà pris.';
  return err.message || String(err);
}

/* ---------------- Modales ---------------- */
function modal({ title, body, foot, wide, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => { clear(root); document.body.style.overflow = ''; if (onClose) onClose(); };
  const box = h('div', { class: `modal${wide ? ' wide' : ''}`, onclick: (e) => e.stopPropagation() },
    h('div', { class: 'modal-head' },
      h('h3', {}, title),
      h('span', { class: 'x', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    foot ? h('div', { class: 'modal-foot' }, foot) : null);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: close }, box);
  mount(root, backdrop);
  document.body.style.overflow = 'hidden';
  const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
  return { close, box };
}

function confirmBox({ title, message, confirmLabel, danger, typed }) {
  return new Promise((resolve) => {
    let input = null;
    const okBtn = h('button', { class: `btn ${danger ? 'danger' : ''}`, onclick: () => { finish(typed ? (input ? input.value : '') : true); } }, confirmLabel || 'Confirmer');
    function finish(v) { close(); resolve(v); }
    const body = h('div', {},
      h('p', { style: { margin: '0 0 10px' }, html: escapeHTML(message) }),
      typed ? h('div', { class: 'field' }, h('label', {}, `Tapez « ${typed} » pour confirmer`), input = h('input', { type: 'text', class: 'input', onkeydown: (e) => { if (e.key === 'Enter') finish(input.value); } })) : null);
    const { close } = modal({
      title: title || 'Confirmation',
      body,
      foot: [
        h('button', { class: 'btn secondary', onclick: () => finish(null) }, 'Annuler'),
        okBtn
      ]
    });
    if (input) setTimeout(() => input.focus(), 60);
  });
}

/* ---------------- Formulaires ---------------- */
function field(spec, values) {
  const val = values && values[spec.name] !== undefined ? values[spec.name] : (spec.value !== undefined ? spec.value : '');
  let control;
  const common = { name: spec.name, id: `f_${spec.name}` };
  if (spec.type === 'select') {
    control = h('select', { ...common, required: !!spec.required, onchange: spec.onchange },
      spec.placeholder ? h('option', { value: '' }, spec.placeholder) : null,
      (spec.options || []).map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(val) }, o.label)));
  } else if (spec.type === 'textarea') {
    control = h('textarea', { ...common, placeholder: spec.placeholder || '', rows: spec.rows || 4 }, String(val));
  } else if (spec.type === 'checkbox') {
    control = h('input', { type: 'checkbox', ...common, checked: !!val });
  } else {
    control = h('input', {
      type: spec.type || 'text', ...common, value: val,
      placeholder: spec.placeholder || '', min: spec.min, max: spec.max, step: spec.step,
      required: !!spec.required, oninput: spec.oninput, list: spec.list
    });
  }
  return h('div', { class: `field${spec.className ? ' ' + spec.className : ''}` },
    spec.type === 'checkbox'
      ? h('label', { class: 'check', for: `f_${spec.name}` }, control, spec.label)
      : h('label', { for: `f_${spec.name}` }, spec.label, spec.required ? h('span', { class: 'req' }, ' *') : null),
    spec.type !== 'checkbox' ? control : null,
    spec.help ? h('div', { class: 'help' }, spec.help) : null,
    spec.hint ? h('div', { class: 'help' }, spec.hint) : null);
}

function readForm(container) {
  const out = {};
  $$('input[name], select[name], textarea[name]', container).forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}

/**
 * Construit un formulaire.
 * spec: { fields: [...], onSubmit(values, ctx), submitLabel, values, inline }
 */
function form(spec) {
  const values = spec.values || {};
  const body = h('div', { class: spec.inline ? 'form-row' : 'form-grid' }, spec.fields.map((f) => field(f, values)));
  const errLine = h('div', { class: 'err', style: { display: 'none' } });
  const btn = h('button', { class: `btn${spec.submitClass ? ' ' + spec.submitClass : ''}${spec.block ? ' block' : ''}`, type: 'submit' }, spec.submitLabel || 'Enregistrer');
  const f = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const data = readForm(f);
      const prev = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Envoi…';
      errLine.style.display = 'none';
      try {
        await spec.onSubmit(data, { btn, errLine, values });
      } catch (err) {
        errLine.textContent = errorMessage(err);
        errLine.style.display = 'block';
        toast(errorMessage(err), 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }
  },
    body,
    spec.after ? spec.after : null,
    errLine,
    spec.noSubmit ? null : h('div', { class: spec.inline ? '' : 'form-actions', style: { marginTop: '14px' } },
      spec.cancel ? h('button', { type: 'button', class: 'btn secondary', style: { marginRight: '9px' }, onclick: spec.cancel }, 'Annuler') : null,
      btn));
  return f;
}

/* ---------------- Tables ---------------- */
/**
 * columns: [{ key, label, render(row) -> Node|string, className, hideOnMobile }]
 * rows: array
 */
function table(columns, rows, opts) {
  opts = opts || {};
  if (!rows || !rows.length) {
    return h('div', { class: 'empty' }, h('span', { class: 'big' }, opts.emptyIcon || '∅'), opts.empty || 'Aucune donnée.');
  }
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.className || '' }, c.label))));
  const tbody = h('tbody', {}, rows.map((row, i) => h('tr', { class: opts.rowClass ? opts.rowClass(row, i) : '' },
    columns.map((c) => {
      const content = c.render ? c.render(row, i) : row[c.key];
      return h('td', { class: c.className || '' }, content === null || content === undefined || content === '' ? '—' : content);
    }))));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
}

function badge(text, kind) {
  return h('span', { class: `badge ${kind || ''}` }, text);
}

const STATUS_LABEL = {
  pending: 'EN ATTENTE', active: 'VALIDÉ', refused: 'REFUSÉ', suspended: 'SUSPENDU',
  REQUESTED: 'EN ATTENTE', APPROVED: 'VALIDÉ', REJECTED: 'REFUSÉ',
  CONFIRMED: 'CONFIRMÉE', CANCELLED: 'ANNULÉE',
  ACTIVE: 'ACTIF', INACTIVE: 'INACTIF', RESERVED: 'RÉSERVÉE',
  TODO: 'À FAIRE', DOING: 'EN COURS', DONE: 'TERMINÉE',
  LOW: 'BASSE', NORMAL: 'NORMALE', HIGH: 'HAUTE', URGENT: 'URGENTE'
};
const STATUS_KIND = {
  pending: 'warn', active: 'ok', refused: 'danger', suspended: 'danger',
  REQUESTED: 'warn', APPROVED: 'ok', REJECTED: 'danger',
  CONFIRMED: 'ok', CANCELLED: 'danger',
  ACTIVE: 'ok', INACTIVE: '', RESERVED: 'purple',
  TODO: 'info', DOING: 'warn', DONE: 'ok',
  LOW: '', NORMAL: 'info', HIGH: 'warn', URGENT: 'danger'
};
function statusBadge(status) { return badge(STATUS_LABEL[status] || status, STATUS_KIND[status]); }

function roleLabel(role) {
  return { admin: 'ADMINISTRATION', coordinateur: 'COORDINATEUR', enseignant: 'ENSEIGNANT', etudiant: 'ÉTUDIANT' }[role] || role;
}
function roleKind(role) { return { admin: 'brand', coordinateur: 'purple', enseignant: 'info', etudiant: 'ok' }[role] || ''; }

/* ---------------- Titres des responsables ---------------- */
/* Miroir exact de server/util.js : le genre d'un compte sert UNIQUEMENT au titre
   affiché (Coordinateur / Coordinatrice) et ne conditionne aucun droit. */
function normalizeGender(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (raw === 'F' || raw === 'FEMININ' || raw === 'FEMININE' || raw === 'FEMININ(E)' || raw === 'C') return 'F';
  if (raw === 'M' || raw === 'MASCULIN' || raw === 'MASCULINE' || raw === 'MASCULIN(E)' || raw === 'H') return 'M';
  return '';
}

/* Titre d'un responsable selon son genre. Sans genre renseigné (comptes
   antérieurs) on conserve le titre masculin historique. */
function coordinatorTitle(gender) {
  return normalizeGender(gender) === 'F' ? 'Coordinatrice' : 'Coordinateur';
}

/* Titre du responsable de FILIÈRE — règle automatique de l'ISPITS Laâyoune :
   la filière « Soins Infirmiers » est dirigée par une Coordinatrice, toutes les
   autres conservent Coordinateur. Appliquée seule, sans saisie possible. */
function filiereTitle(category) {
  const cat = String(category === null || category === undefined ? '' : category).trim().toLowerCase();
  return cat === 'soins infirmiers' || cat.startsWith('soins infirmier')
    ? 'Coordinatrice de filière' : 'Coordinateur de filière';
}

/* Titre du responsable d'OPTION : suit le genre du responsable. */
function optionTitle(gender) {
  return `${coordinatorTitle(gender)} d’Option`;
}

/* ---------------- Divers ---------------- */
function fmtDay(day) {
  if (!day) return '—';
  const names = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return `${names[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function fmtDayShort(day) {
  const names = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : `${names[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timeOptions(startHour, endHour) {
  const out = [];
  const start = (startHour === undefined ? 8 : startHour) * 60;
  const end = (endHour === undefined ? 18 : endHour) * 60;
  for (let m = start; m <= end; m += 30) {
    out.push({ value: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
  }
  return out;
}
function pageHead(title, subtitle, actions) {
  return h('div', { class: 'page-head no-print' },
    h('div', {}, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions && actions.length ? h('div', { class: 'actions' }, actions) : null);
}
function loadingCard(text) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'big' }, '◌'), text || 'Chargement…'));
}
function statCard(label, value, sub, kind) {
  return h('div', { class: `stat ${kind || ''}` },
    h('div', { class: 'k' }, label),
    h('div', { class: 'v' }, value === null || value === undefined ? '—' : value),
    sub ? h('div', { class: 's' }, sub) : null);
}
function roomStateBadge(room) {
  if (!room.bookable) return badge('MASTER MANAGEMENT', 'purple');
  if (room.status === 'INACTIVE') return badge('INACTIVE', 'danger');
  if (room.status === 'RESERVED') return badge('RÉSERVÉE', 'purple');
  return badge('ACTIVE', 'ok');
}
