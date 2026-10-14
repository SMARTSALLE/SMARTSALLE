/* SmartSalle ISPITS — client API (authentification par cookie de session) */
'use strict';

const APP = {
  user: null,
  settings: {},
  presence: [],
  unread: 0,
  pendingAccounts: 0,
  eventSource: null
};

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function api(method, url, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'smartsalle' }
  };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new HttpError(0, 'NETWORK', 'Impossible de joindre le serveur. Vérifiez votre connexion.');
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = data && data.error ? data.error : {};
    throw new HttpError(res.status, err.code || 'ERROR', err.message || `Erreur ${res.status}`, err.extra || null);
  }
  return data;
}

const get = (u) => api('GET', u);
const post = (u, b) => api('POST', u, b === undefined ? {} : b);
const put = (u, b) => api('PUT', u, b === undefined ? {} : b);
const del = (u, b) => api('DELETE', u, b === undefined ? {} : b);

function qs(params) {
  const parts = [];
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  });
  return parts.length ? `?${parts.join('&')}` : '';
}

function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---- Temps réel (Server-Sent Events) ---- */
function connectRealtime(onChange) {
  if (APP.eventSource) { try { APP.eventSource.close(); } catch (e) {} }
  const es = new EventSource('/api/events');
  APP.eventSource = es;
  es.addEventListener('change', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch (e) {}
    if (onChange) onChange(data);
  });
  es.addEventListener('presence', (ev) => {
    try { APP.presence = JSON.parse(ev.data).users || []; } catch (e) { APP.presence = []; }
    const holder = document.getElementById('presence');
    if (holder) holder.innerHTML = presenceHTML();
  });
  es.onerror = () => { /* EventSource reconnexion automatique */ };
  return es;
}

function presenceHTML() {
  const list = APP.presence.slice(0, 5);
  if (!list.length) return '<span class="p-label">Hors ligne</span>';
  return list.map((u) => `<span class="p-av" title="${escapeHTML(u.name)} · ${u.role}${u.active_option ? ' · ' + u.active_option : ''}">${initials(u.name)}</span>`).join('') +
    `<span class="p-label">${APP.presence.length} en ligne</span>`;
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
}

function escapeHTML(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
