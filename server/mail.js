'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { randomCode, hashSecret, timingEqual } = require('./util');
const { get, getSettings, DATA_DIR } = require('./db');

const CODE_TTL_MINUTES = 15;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 6;

function createEmailCode(userId, purpose) {
  const d = get();
  const code = randomCode(6);
  d.prepare('UPDATE email_codes SET consumed_at = datetime(\'now\') WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL')
    .run(userId, purpose || 'verify_email');
  d.prepare('INSERT INTO email_codes (user_id, code_hash, purpose, expires_at) VALUES (?,?,?,datetime(\'now\', ?))')
    .run(userId, hashSecret(code), purpose || 'verify_email', `+${CODE_TTL_MINUTES} minutes`);
  return code;
}

function lastCodeAt(userId, purpose) {
  const row = get().prepare('SELECT MAX(created_at) AS t FROM email_codes WHERE user_id = ? AND purpose = ?').get(userId, purpose || 'verify_email');
  if (!row || !row.t) return null;
  return row.t;
}

function cooldownRemaining(userId, purpose) {
  const t = lastCodeAt(userId, purpose);
  if (!t) return 0;
  const elapsed = (Date.now() - new Date(`${t.replace(' ', 'T')}Z`).getTime()) / 1000;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
}

function verifyEmailCode(userId, code, purpose) {
  const d = get();
  const rows = d.prepare('SELECT * FROM email_codes WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1')
    .all(userId, purpose || 'verify_email');
  if (!rows.length) return { ok: false, reason: 'CODE_NOT_FOUND' };
  const row = rows[0];
  if (new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() < Date.now()) return { ok: false, reason: 'CODE_EXPIRED' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
  d.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  return verifyStoredCode(row, code);
}

function verifyStoredCode(row, code) {
  // Le hash contient le sel ; on recalcule avec le sel stocké.
  const parts = String(row.code_hash).split('$');
  if (parts.length !== 6) return { ok: false, reason: 'INVALID_CODE' };
  const [, N, r, p, salt, hash] = parts;
  const crypto = require('node:crypto');
  const calc = crypto.scryptSync(String(code), salt, 64, { N: +N, r: +r, p: +p }).toString('hex');
  const ok = Buffer.from(calc, 'hex').length === Buffer.from(hash, 'hex').length &&
    crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  if (!ok) return { ok: false, reason: 'INVALID_CODE' };
  get().prepare('UPDATE email_codes SET consumed_at = datetime(\'now\') WHERE id = ?').run(row.id);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Livraison : SMTP réel si configuré, sinon boîte locale + console.  */
/* ------------------------------------------------------------------ */
function deliver({ to, subject, text }) {
  const s = getSettings();
  const outbox = path.join(DATA_DIR, 'outbox');
  try { fs.mkdirSync(outbox, { recursive: true }); } catch (e) { /* ignore */ }
  const file = path.join(outbox, `${Date.now()}-${String(to).replace(/[^a-z0-9@._-]/gi, '_')}.eml`);
  const eml = `From: ${s.smtp_from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  try { fs.writeFileSync(file, eml, 'utf8'); } catch (e) { /* ignore */ }
  console.log(`[mail] -> ${to} | ${subject}`);

  if (!s.smtp_host) return Promise.resolve({ delivered: 'outbox', file });
  return smtpSend(s, { to, from: s.smtp_from, subject, text })
    .then(() => ({ delivered: 'smtp', file }))
    .catch((e) => {
      console.error('[mail] échec SMTP, copie locale :', e.message);
      return { delivered: 'outbox', file, error: e.message };
    });
}

/* ------------------------------------------------------------------ */
/* Client SMTP — lecture ligne à ligne (réponses multi-lignes).        */
/* ------------------------------------------------------------------ */
function makeReader(sock) {
  let buf = '';
  let failure = null;
  let waiter = null;
  const flush = () => {
    if (!waiter) return;
    const idx = buf.indexOf('\r\n');
    if (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const w = waiter; waiter = null; w.resolve(line);
    } else if (failure) {
      const w = waiter; waiter = null; w.reject(failure);
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); flush(); };
  const onError = (e) => { failure = e instanceof Error ? e : new Error(String(e)); flush(); };
  const onClose = () => onError(new Error('Connexion SMTP fermée'));
  sock.on('data', onData);
  sock.on('error', onError);
  sock.on('close', onClose);
  return {
    next: () => new Promise((resolve, reject) => { waiter = { resolve, reject }; flush(); }),
    detach() {
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
    }
  };
}

async function readReply(reader) {
  const lines = [];
  for (;;) {
    const line = await reader.next();
    lines.push(line);
    const m = /^(\d{3})([ -])/.exec(line);
    if (!m) throw new Error(`SMTP : réponse invalide « ${line} »`);
    if (m[2] === ' ') return { code: parseInt(m[1], 10), text: lines.join(' | ') };
  }
}

/* Dialogue SMTP correct, étape par étape :
   220 → EHLO → [STARTTLS + EHLO] → AUTH LOGIN (334 / 334 / 235)
   → MAIL FROM → RCPT TO → DATA (stuffing des points) → QUIT.
   L'ancienne version envoyait `AUTH LOGIN <utilisateur>` en une seule ligne et
   n'envoyait jamais le mot de passe : le serveur refusait, on retombait en
   boîte locale et le code n'arrivait jamais dans la vraie boîte mail.
   Mot de passe : variable SMTP_PASSWORD (env, via Infisical) — jamais en base. */
function smtpSend(s, msg) {
  const host = s.smtp_host;
  const port = +s.smtp_port || 587;
  const mode = String(s.smtp_secure || 'starttls');
  const user = String(s.smtp_user || '');
  const pass = String(s.smtp_password || process.env.SMTP_PASSWORD || '');
  const directTls = mode === 'smtps';
  const useStartTls = mode === 'starttls' && !directTls;
  const domain = 'smartsalle.local';
  const servername = net.isIP(host) ? undefined : host;

  return (async () => {
    let sock = directTls ? tls.connect({ host, port, servername }) : net.connect({ host, port });
    let reader = null;
    const guard = setTimeout(() => { try { sock.destroy(); } catch (e) { /* ignore */ } }, 20000);
    const attach = () => { reader = makeReader(sock); };
    const write = (line) => sock.write(line + '\r\n');
    const cmd = async (line) => { write(line); return readReply(reader); };

    try {
      await new Promise((resolve, reject) => {
        sock.once(directTls ? 'secureConnect' : 'connect', resolve);
        sock.once('error', reject);
      });
      attach();
      let r = await readReply(reader);
      if (r.code !== 220) throw new Error(`SMTP bannière : ${r.text}`);
      r = await cmd(`EHLO ${domain}`);
      if (r.code !== 250) throw new Error(`SMTP EHLO : ${r.text}`);

      if (useStartTls) {
        r = await cmd('STARTTLS');
        if (r.code !== 220) throw new Error(`SMTP STARTTLS : ${r.text}`);
        const plain = sock;
        reader.detach();
        sock = await new Promise((resolve, reject) => {
          const t = tls.connect({ socket: plain, servername }, () => resolve(t));
          t.once('error', reject);
        });
        attach();
        r = await cmd(`EHLO ${domain}`);
        if (r.code !== 250) throw new Error(`SMTP EHLO après TLS : ${r.text}`);
      }

      if (user) {
        r = await cmd('AUTH LOGIN');
        if (r.code !== 334) throw new Error(`SMTP AUTH LOGIN refusé : ${r.text}`);
        r = await cmd(Buffer.from(user, 'utf8').toString('base64'));
        if (r.code !== 334) throw new Error(`SMTP AUTH (utilisateur) : ${r.text}`);
        r = await cmd(Buffer.from(pass, 'utf8').toString('base64'));
        if (r.code !== 235) throw new Error(`SMTP AUTH (identifiants refusés) : ${r.text}`);
      }

      const from = String(msg.from || s.smtp_from || '').trim() || (user.includes('@') ? user : `no-reply@${host}`);
      r = await cmd(`MAIL FROM:<${from}>`);
      if (r.code !== 250) throw new Error(`SMTP MAIL FROM : ${r.text}`);
      r = await cmd(`RCPT TO:<${msg.to}>`);
      if (r.code !== 250 && r.code !== 251) throw new Error(`SMTP RCPT TO : ${r.text}`);
      r = await cmd('DATA');
      if (r.code !== 354) throw new Error(`SMTP DATA : ${r.text}`);

      const subject = /[^\x00-\x7F]/.test(msg.subject)
        ? `=?UTF-8?B?${Buffer.from(msg.subject, 'utf8').toString('base64')}?=`
        : msg.subject;
      const body = [
        `From: ${from}`, `To: ${msg.to}`, `Subject: ${subject}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
        ...String(msg.text).replace(/\r\n/g, '\n').split('\n').map((l) => (l.startsWith('.') ? `.${l}` : l))
      ].join('\r\n');
      sock.write(`${body}\r\n.\r\n`);
      r = await readReply(reader);
      if (r.code !== 250) throw new Error(`SMTP envoi refusé : ${r.text}`);

      try { write('QUIT'); await readReply(reader); } catch (e) { /* fermeture bénigne */ }
      return true;
    } finally {
      clearTimeout(guard);
      try { if (reader) reader.detach(); } catch (e) { /* ignore */ }
      try { if (sock) sock.destroy(); } catch (e) { /* ignore */ }
    }
  })();
}

/* Réinitialisation de mot de passe : mécanisme de code (TTL, cooldown,
   nombre de tentatives). Ancienne fonction de vérification à l'inscription
   (sendVerificationEmail) supprimée : l'inscription n'envoie plus aucun code. */
async function sendPasswordResetEmail(user) {
  const code = createEmailCode(user.id, 'reset_password');
  const s = getSettings();
  const subject = `${s.app_name} — réinitialisation du mot de passe`;
  const text = [
    `Bonjour ${user.prenom} ${user.nom},`,
    '',
    `Votre code de réinitialisation ${s.app_name} est : ${code}`,
    '',
    `Ce code expire dans ${CODE_TTL_MINUTES} minutes.`,
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message et changez votre mot de passe.`,
    '',
    s.institution_name
  ].join('\n');
  const result = await deliver({ to: user.email, subject, text });
  const expose = s.expose_dev_codes === '1' && process.env.NODE_ENV !== 'production';
  return { code: expose ? code : undefined, delivered: result.delivered, delivery_error: result.error, expires_minutes: CODE_TTL_MINUTES, cooldown: RESEND_COOLDOWN_SECONDS };
}

module.exports = {
  createEmailCode, verifyEmailCode, cooldownRemaining, sendPasswordResetEmail,
  deliver, CODE_TTL_MINUTES, RESEND_COOLDOWN_SECONDS, MAX_ATTEMPTS
};
