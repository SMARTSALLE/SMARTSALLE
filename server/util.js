'use strict';
const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function fail(res, err) {
  const status = err instanceof ApiError ? err.status : (err && err.status) || 500;
  const code = err instanceof ApiError ? err.code : 'INTERNAL_ERROR';
  const message = err && err.message ? err.message : 'Erreur interne';
  if (status === 500) console.error('[error]', err && err.stack ? err.stack : err);
  json(res, status, { error: { code, message, extra: err && err.extra ? err.extra : null } });
}

function readJson(req, limit) {
  limit = limit || 1024 * 512;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        reject(new ApiError(400, 'INVALID_JSON', 'JSON invalide'));
      }
    });
    req.on('error', (e) => reject(new ApiError(400, 'REQUEST_ERROR', e.message)));
  });
}

function cookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, opts) {
  opts = opts || {};
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const cookie = parts.join('; ');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : [cookie]);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes || 32).toString('hex');
}

function randomCode(len) {
  const n = len || 6;
  let out = '';
  for (let i = 0; i < n; i++) out += crypto.randomInt(0, 10);
  return out;
}

function hashSecret(s) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(s), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${hash}`;
}

function verifySecret(plain, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const calc = crypto.scryptSync(String(plain), salt, 64, { N: +N, r: +r, p: +p });
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch (e) {
    return false;
  }
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------- time helpers ---------- */
function pad(n) { return String(n).padStart(2, '0'); }

function todayStr(d) {
  const dt = d || new Date();
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function parseDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const dt = new Date(`${s}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function addDays(dayStr, n) {
  const dt = parseDay(dayStr);
  if (!dt) return addDays(todayStr(), n); // date illisible : on ne fait pas planter la route
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

function mondayOf(dayStr) {
  const dt = parseDay(dayStr);
  if (!dt) return mondayOf(todayStr()); // idem — semaine par défaut = semaine courante
  const dow = (dt.getDay() + 6) % 7; // 0 = lundi
  dt.setDate(dt.getDate() - dow);
  return todayStr(dt);
}

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_NAMES = { mon: 'Lundi', tue: 'Mardi', wed: 'Mercredi', thu: 'Jeudi', fri: 'Vendredi', sat: 'Samedi', sun: 'Dimanche' };

function dayKeyOf(dayStr) {
  const dt = parseDay(dayStr);
  return dt ? DAY_KEYS[(dt.getDay() + 6) % 7] : null;
}

function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtMin(min) {
  if (min === null || min === undefined) return '';
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(v || '').trim());
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? (def === undefined ? null : def) : n;
}

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || String(obj[f]).trim() === '');
  if (missing.length) throw new ApiError(400, 'MISSING_FIELD', `Champ(s) manquant(s) : ${missing.join(', ')}`, { missing });
}

/* ---------- titres des responsables (Coordinateur / Coordinatrice) ---------- */
/* Le genre d'un compte sert UNIQUEMENT au titre affiché : il ne conditionne
   aucun droit ni aucune fonctionnalité. Valeurs stockées : 'M', 'F', ou '' pour
   les comptes créés avant l'ajout de la colonne — dans ce cas on conserve le
   titre masculin historique pour ne rien changer aux comptes existants. */
function normalizeGender(v) {
  const raw = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (raw === 'F' || raw === 'FEMININ' || raw === 'FEMININE' || raw === 'FEMININ(E)' || raw === 'C') return 'F';
  if (raw === 'M' || raw === 'MASCULIN' || raw === 'MASCULINE' || raw === 'MASCULIN(E)' || raw === 'H') return 'M';
  return '';
}

/* Titre d'un responsable (option, filière, section…) selon son genre. */
function coordinatorTitle(gender) {
  return normalizeGender(gender) === 'F' ? 'Coordinatrice' : 'Coordinateur';
}

/* Titre du responsable de FILIÈRE : règle automatique de l'ISPITS Laâyoune.
   La filière « Soins Infirmiers » est dirigée par une Coordinatrice ; toutes
   les autres filières conservent Coordinateur. La règle s'applique seule pour
   éviter toute erreur de saisie. */
const NURSING_CATEGORY = 'Soins Infirmiers';
function filiereTitle(category) {
  const cat = String(category === null || category === undefined ? '' : category)
    .trim().toLowerCase();
  const nursing = cat === NURSING_CATEGORY.toLowerCase()
    || cat.startsWith('soins infirmier');
  return nursing ? 'Coordinatrice de filière' : 'Coordinateur de filière';
}

/* Titre du responsable d'une OPTION : dépend du genre du responsable, saisi à
   la création du compte (Coordinateur / Coordinatrice). */
function optionTitle(gender) {
  return `${coordinatorTitle(gender)} d’Option`;
}

/* ---------- exports ---------- */
function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvEscape).join(';')).join('\r\n');
}

function xmlEsc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function toXls(sheetName, rows) {
  const body = rows.map((r) => {
    const cells = r.map((c) => {
      const isNum = typeof c === 'number' && Number.isFinite(c);
      return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${xmlEsc(c)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');
  return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${xmlEsc(sheetName || 'Export').slice(0, 30)}"><Table>${body}</Table></Worksheet></Workbook>`;
}

function sendFile(res, filename, contentType, data, disposition) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `${disposition || 'attachment'}; filename="${filename}"`,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

module.exports = {
  ApiError, json, fail, readJson, cookies, setCookie,
  sha256, randomToken, randomCode, hashSecret, verifySecret, timingEqual,
  normalizeGender, coordinatorTitle, filiereTitle, optionTitle, NURSING_CATEGORY,
  todayStr, parseDay, addDays, mondayOf, dayKeyOf, DAY_KEYS, DAY_NAMES,
  parseHHMM, fmtMin, nowMin, isEmail, str, int, bool, requireFields,
  toCsv, toXls, sendFile
};
