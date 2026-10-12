/* SmartSalle ISPITS — pages publiques : connexion, inscription, vérification, salle publique */
'use strict';

function authHero() {
  return h('div', { class: 'auth-hero' },
    h('div', { class: 'logo-row' },
      h('div', { class: 'logo-mark' }, h('img', { src: '/assets/logo-ispits.png', alt: 'ISPITS', onerror: function () { this.remove(); } })),
      h('div', {},
        h('div', { style: { fontSize: '13px', letterSpacing: '3px', opacity: .85 } }, 'ISPITS LAÂYOUNE'),
        h('h1', {}, 'SMARTSALLE ISPITS'))),
    h('div', { class: 'tagline' }, 'Gestion intelligente des salles et des emplois du temps'),
    h('ul', {},
      h('li', {}, 'Salles disponibles et occupées en temps réel'),
      h('li', {}, 'Réservations sans conflit, garanties par la base de données'),
      h('li', {}, 'Emplois du temps imprimables et exportables'),
      h('li', {}, 'Coordination multi-utilisateurs synchronisée')));
}

/* Catalogue des filières ISPITS — regroupe les options par filière, dans l'ordre officiel. */
function groupOptions(opts) {
  const order = ['Soins Infirmiers', 'Techniques de Santé', 'Rééducation et Réhabilitation', 'Autres Filières'];
  const map = new Map();
  (opts || []).forEach((o) => {
    const key = o.category || 'Autres Filières';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  });
  const keys = [...map.keys()].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  return keys.map((k) => ({ category: k, options: map.get(k) }));
}

/* Bloc lecture seule « Nos filières et options » — affiché sur la connexion
   et sur la création de compte (source : GET /api/options, public). */
function optionsCatalogBlock(title) {
  const box = h('div', { class: 'opt-catalog' });
  mount(box, h('div', { class: 'help' }, 'Chargement des filières…'));
  get('/api/options').then((res) => {
    const groups = groupOptions((res.options || []).filter((o) => o.status === 'ACTIVE'));
    const total = groups.reduce((n, g) => n + g.options.length, 0);
    if (!total) { mount(box, h('div', {}, '')); return; }
    mount(box,
      h('div', { class: 'opt-catalog-title' }, title || 'Nos filières et options',
        h('span', { class: 'help', style: { fontWeight: 400, marginLeft: '6px' } }, `${total} options`)),
      h('div', { class: 'opt-cat-list' },
        groups.map((g) => h('div', { class: 'opt-cat' },
          h('div', { class: 'opt-cat-name' }, g.category),
          h('div', { class: 'opt-cat-items' },
            g.options.map((o) => h('div', { class: 'opt-item' },
              h('span', { class: 'opt-code' }, o.code),
              h('span', { class: 'opt-name' }, o.name))))))));
  }).catch(() => { mount(box, h('div', { class: 'help' }, 'Filières indisponibles pour le moment.')); });
  return box;
}

function ViewLogin() {
  const card = h('div', { class: 'auth-card' },
    h('h2', {}, 'Connexion'),
    h('div', { class: 'sub' }, 'Accédez à votre espace SmartSalle ISPITS'),
    form({
      fields: [
        { name: 'email', label: 'Adresse email', type: 'email', required: true, placeholder: 'vous@ispits.ma' },
        { name: 'password', label: 'Mot de passe', type: 'password', required: true, placeholder: '••••••••' }
      ],
      submitLabel: 'Se connecter',
      block: true,
      onSubmit: async (values, ctx) => {
        const res = await post('/api/auth/login', values);
        APP.user = res.user;
        APP.settings = (await get('/api/auth/me')).settings || {};
        toast(`Bienvenue ${res.user.prenom} ${res.user.nom}`, 'ok');
        window.navigateTo('/dashboard');
      }
    }),
    h('div', { class: 'auth-alt', style: { marginTop: '-6px' } },
      h('a', { href: '#/forgot' }, 'Mot de passe oublié ?')),
    h('div', { class: 'auth-alt' },
      'Pas encore de compte ? ',
      h('a', { href: '#/register', style: { fontWeight: 700 } }, 'Créer un compte')),
    h('div', { class: 'auth-alt', style: { marginTop: '6px' } },
      h('a', { href: '#/' }, '← Retour à l’accueil')));

  return h('div', { class: 'auth-wrap' }, authHero(),
    h('div', { class: 'auth-panel' }, card, optionsCatalogBlock('Nos filières et options')));
}

function ViewRegister() {
  const state = { role: 'coordinateur', options: [], gender: 'M' };
  let optionsBox = null;
  let counter = null;
  let genderBox = null;
  let genderPreview = null;

  /* Le sélecteur de fonction n'a de sens QUE pour un coordinateur : un
     enseignant n'a pas de titre de responsable. Le titre est affiché en direct
     pour que la personne voie exactement ce qui apparaîtra sur les documents. */
  function refreshGenderUI() {
    if (genderBox) genderBox.style.display = state.role === 'coordinateur' ? '' : 'none';
    if (genderPreview) {
      genderPreview.textContent = state.role === 'coordinateur'
        ? `Titre affiché partout dans l’application : « ${coordinatorTitle(state.gender)} »`
        : '';
    }
  }

  async function loadOptions() {
    try {
      const res = await get('/api/options');
      const opts = (res.options || []).filter((o) => o.status === 'ACTIVE');
      renderOptions(opts);
    } catch (e) { /* ignore */ }
  }

  function renderOptions(opts) {
    if (!optionsBox) return;
    const groups = groupOptions(opts);
    mount(optionsBox,
      h('div', { class: 'field' },
        h('label', {}, 'Choisissez les options que vous coordonnez ', h('span', { class: 'req' }, ' *'),
          h('span', { class: 'help', style: { fontWeight: 400, marginLeft: '6px' } }, '1 à 3 options maximum')),
        h('div', { class: 'opt-check-groups' },
          groups.map((g) => h('div', { class: 'opt-check-group' },
            h('div', { class: 'opt-check-cat' }, g.category),
            h('div', { class: 'checkbox-list' },
              g.options.map((o) => {
                const checked = state.options.includes(o.id);
                return h('label', { class: `check${checked ? ' sel' : ''}` },
                  h('input', {
                    type: 'checkbox', checked,
                    onchange: (e) => {
                      if (e.target.checked) {
                        if (state.options.length >= 3) {
                          e.target.checked = false;
                          toast('Un coordinateur ne peut demander que 3 options au maximum.', 'warn');
                          return;
                        }
                        state.options.push(o.id);
                      } else {
                        state.options = state.options.filter((x) => x !== o.id);
                      }
                      renderOptions(opts);
                    }
                  }),
                  h('span', {}, o.code, h('span', { style: { color: 'var(--muted)', fontWeight: 400, fontSize: '12.5px' } }, ` — ${o.name}`)));
              }))))),
        counter = h('div', { class: 'help' }, `${state.options.length}/3 option(s) sélectionnée(s)`)));
    if (counter) counter.textContent = `${state.options.length}/3 option(s) sélectionnée(s)`;
  }

  const card = h('div', { class: 'auth-card' },
    h('h2', {}, 'Créer un compte'),
    h('div', { class: 'sub' }, 'Votre demande sera vérifiée par email puis validée par l’administration'),
    form({
      fields: [
        { name: 'nom', label: 'Nom', required: true },
        { name: 'prenom', label: 'Prénom', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'vous@exemple.ma' },
        { name: 'password', label: 'Mot de passe', type: 'password', required: true, help: '8 caractères minimum' },
        { name: 'password2', label: 'Confirmation du mot de passe', type: 'password', required: true }
      ],
      submitLabel: 'Créer mon compte',
      onSubmit: async (values, ctx) => {
        values.role = state.role;
        values.options = state.options;
        values.gender = state.gender;
        if (state.role === 'coordinateur' && !state.options.length) {
          throw new HttpError(400, 'OPTION_REQUIRED', 'Choisissez les options que vous coordonnez (1 au minimum).');
        }
        const res = await post('/api/auth/register', values);
        sessionStorage.setItem('pending_email', values.email);
        sessionStorage.setItem('dev_code', res.dev_code || '');
        sessionStorage.setItem('delivery', res.delivery || '');
        toast(res.message, 'ok', 5000);
        window.navigateTo('/verify');
      },
      after: h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field' },
          h('label', {}, 'Rôle souhaité '),
          h('div', { class: 'role-picker' },
            h('div', {
              class: `role-card${state.role === 'coordinateur' ? ' sel' : ''}`,
              onclick: (e) => { state.role = 'coordinateur'; $$('.role-card').forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); optionsBox.style.display = ''; refreshGenderUI(); }
            }, 'COORDINATEUR', h('span', { class: 'rl-sub' }, '1 à 3 options')),
            h('div', {
              class: `role-card${state.role === 'enseignant' ? ' sel' : ''}`,
              onclick: (e) => { state.role = 'enseignant'; $$('.role-card').forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); optionsBox.style.display = 'none'; refreshGenderUI(); }
            }, 'ENSEIGNANT', h('span', { class: 'rl-sub' }, 'consultation')))),
        /* Fonction : Coordinateur ou Coordinatrice. Le titre affiché partout dans
           l’application en découle automatiquement — il n’est jamais imposé au
           masculin pour tous les comptes. */
        genderBox = h('div', { class: 'field', style: { marginTop: '16px' } },
          h('label', {}, 'Fonction ', h('span', { class: 'req' }, ' *'),
            h('span', { class: 'help', style: { fontWeight: 400, marginLeft: '6px' } }, 'sert uniquement au titre affiché')),
          h('div', { class: 'role-picker' },
            ['M', 'F'].map((g) => h('div', {
              class: `role-card${state.gender === g ? ' sel' : ''}`,
              'data-gender': g,
              onclick: (e) => {
                state.gender = g;
                $$('.role-card[data-gender]').forEach((x) => x.classList.remove('sel'));
                e.currentTarget.classList.add('sel');
                refreshGenderUI();
              }
            }, g === 'M' ? 'COORDINATEUR' : 'COORDINATRICE',
            h('span', { class: 'rl-sub' }, g === 'M' ? 'titre masculin' : 'titre féminin')))),
          genderPreview = h('div', { class: 'help', style: { marginTop: '8px' } })),
        optionsBox = h('div', {}))
    }),
    h('div', { class: 'auth-alt' }, 'Déjà inscrit ? ', h('a', { href: '#/login', style: { fontWeight: 700 } }, 'Connexion')));

  setTimeout(loadOptions, 0);
  /* Le bloc « Fonction » est construit dans `after` : on l'initialise une fois
     le DOM monté (masqué pour un enseignant, titre affiché pour un coordonateur). */
  setTimeout(refreshGenderUI, 0);
  return h('div', { class: 'auth-wrap' }, authHero(),
    h('div', { class: 'auth-panel' }, card, optionsCatalogBlock('Toutes les filières de l’ISPITS')));
}

function ViewVerify() {
  const email = sessionStorage.getItem('pending_email') || '';
  const devCode = sessionStorage.getItem('dev_code') || '';
  const delivery = sessionStorage.getItem('delivery') || '';
  const outbox = delivery === 'outbox';
  let infoBox = null;
  let cooldown = 0;
  let timer = null;

  const resendBtn = h('button', {
    class: 'btn secondary', type: 'button',
    onclick: async () => {
      try {
        const res = await post('/api/auth/resend-code', { email: inpEmail.value });
        if (res.dev_code) toast(`Code de développement : ${res.dev_code}`, 'warn', 9000);
        else if (res.delivery === 'outbox') toast('SMTP non configuré : aucun email envoyé (copie locale data/outbox).', 'warn', 9000);
        else toast(res.message, 'ok');
        sessionStorage.setItem('delivery', res.delivery || '');
        startCooldown(res.cooldown || 60);
      } catch (e) { toast(errorMessage(e), 'err'); }
    }
  }, 'Renvoyer le code');

  function startCooldown(sec) {
    cooldown = sec;
    clearInterval(timer);
    timer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0) { clearInterval(timer); resendBtn.disabled = false; resendBtn.textContent = 'Renvoyer le code'; }
      else { resendBtn.disabled = true; resendBtn.textContent = `Renvoyer dans ${cooldown}s`; }
    }, 1000);
    resendBtn.disabled = true;
    resendBtn.textContent = `Renvoyer dans ${cooldown}s`;
  }

  const inpEmail = h('input', { type: 'email', id: 'f_email', value: email, placeholder: 'vous@exemple.ma', required: true });
  const inpCode = h('input', { type: 'text', id: 'f_code', class: 'code-input', maxlength: '8', placeholder: '000000', required: true, autocomplete: 'one-time-code' });

  const card = h('div', { class: 'auth-card' },
    h('h2', {}, 'Vérification email'),
    h('div', { class: 'sub' }, outbox
      ? 'SMTP non configuré : aucun email n’a réellement été envoyé (copie locale dans data/outbox).'
      : 'Un code à 6 chiffres a été envoyé à votre adresse. Il expire dans 15 minutes.'),
    h('div', { class: 'field' }, h('label', {}, 'Adresse email'), inpEmail),
    h('div', { class: 'field' }, h('label', {}, 'Code de vérification'), inpCode),
    devCode ? h('div', { class: 'field' },
      h('div', { class: 'help', style: { background: 'var(--warn-soft)', padding: '9px 11px', borderRadius: '8px', color: 'var(--warn)' } },
        `SMTP non configuré — code de test : ${devCode}`)) : null,
    (!devCode && outbox) ? h('div', { class: 'field' },
      h('div', { class: 'help', style: { background: 'var(--warn-soft)', padding: '9px 11px', borderRadius: '8px', color: 'var(--warn)' } },
        'Le code n’a pas pu être envoyé : configurez SMTP dans Paramètres (l’administration dispose d’une copie dans data/outbox).')) : null,
    infoBox = h('div', { class: 'err', style: { display: 'none' } }),
    h('div', { style: { display: 'flex', gap: '9px', marginTop: '10px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn', onclick: async () => {
          infoBox.style.display = 'none';
          try {
            const res = await post('/api/auth/verify', { email: inpEmail.value, code: inpCode.value.trim() });
            toast(res.message || 'Email vérifié.', 'ok');
            sessionStorage.removeItem('dev_code');
            setTimeout(() => window.navigateTo('/login'), 700);
          } catch (e) {
            infoBox.textContent = errorMessage(e);
            infoBox.style.display = 'block';
            toast(errorMessage(e), 'err');
          }
        }
      }, 'Vérifier'),
      resendBtn),
    h('div', { class: 'auth-alt' }, 'Vous pouvez maintenant ', h('a', { href: '#/login', style: { fontWeight: 700 } }, 'vous connecter')),
    h('div', { class: 'auth-alt', style: { marginTop: '6px', fontSize: '13px' } },
      'Le compte reste en attente tant que l’administration n’a pas validé la demande.'));

  if (email) startCooldown(60);
  return h('div', { class: 'auth-wrap' }, authHero(), h('div', { class: 'auth-panel' }, card));
}

/* ---------------- Réinitialisation du mot de passe (mot de passe oublié) ---------------- */
function ViewForgot() {
  const state = {
    email: sessionStorage.getItem('pending_reset_email') || '',
    devCode: sessionStorage.getItem('pending_reset_code') || ''
  };
  let cooldown = 0;
  let timer = null;

  const resendBtn = h('button', {
    class: 'btn secondary', type: 'button',
    onclick: async () => {
      try {
        const res = await post('/api/auth/resend-code', { email: state.email, purpose: 'reset_password' });
        if (res.dev_code) { state.devCode = res.dev_code; sessionStorage.setItem('pending_reset_code', res.dev_code); toast(`Code de développement : ${res.dev_code}`, 'warn', 9000); drawCode(); }
        else toast(res.message, 'ok');
        startCooldown(res.cooldown || 60);
      } catch (e) { toast(errorMessage(e), 'err'); }
    }
  }, 'Renvoyer le code');

  function startCooldown(sec) {
    cooldown = sec;
    clearInterval(timer);
    timer = setInterval(() => {
      cooldown -= 1;
      if (cooldown <= 0) { clearInterval(timer); resendBtn.disabled = false; resendBtn.textContent = 'Renvoyer le code'; }
      else { resendBtn.disabled = true; resendBtn.textContent = `Renvoyer dans ${cooldown}s`; }
    }, 1000);
    resendBtn.disabled = true;
    resendBtn.textContent = `Renvoyer dans ${cooldown}s`;
  }

  function drawEmail() {
    clearInterval(timer);
    mount(panel,
      h('div', { class: 'auth-card' },
        h('h2', {}, 'Mot de passe oublié'),
        h('div', { class: 'sub' }, 'Indiquez votre adresse email : un code de réinitialisation vous sera envoyé (valable 15 minutes).'),
        form({
          fields: [
            { name: 'email', label: 'Adresse email', type: 'email', required: true, placeholder: 'vous@ispits.ma', value: state.email }
          ],
          submitLabel: 'Envoyer le code',
          block: true,
          onSubmit: async (values) => {
            const res = await post('/api/auth/forgot-password', { email: values.email });
            state.email = values.email;
            state.devCode = res.dev_code || '';
            sessionStorage.setItem('pending_reset_email', state.email);
            if (state.devCode) sessionStorage.setItem('pending_reset_code', state.devCode);
            startCooldown(res.cooldown || 60);
            toast(res.message, 'ok', 5000);
            drawCode();
          }
        }),
        h('div', { class: 'auth-alt' },
          h('a', { href: '#/login', style: { fontWeight: 700 } }, '← Retour à la connexion'))));
  }

  function drawCode() {
    if (!state.email) { drawEmail(); return; }
    mount(panel,
      h('div', { class: 'auth-card' },
        h('h2', {}, 'Nouveau mot de passe'),
        h('div', { class: 'sub' }, `Code envoyé à ${state.email} — saisissez-le avec votre nouveau mot de passe (8 caractères minimum).`),
        state.devCode ? h('div', { class: 'field' },
          h('div', { class: 'help', style: { background: 'var(--warn-soft)', padding: '9px 11px', borderRadius: '8px', color: 'var(--warn)' } },
            `SMTP non configuré — code de test : ${state.devCode}`)) : null,
        form({
          fields: [
            { name: 'code', label: 'Code de réinitialisation', type: 'text', required: true, placeholder: '000000' },
            { name: 'password', label: 'Nouveau mot de passe', type: 'password', required: true, help: '8 caractères minimum' },
            { name: 'password2', label: 'Confirmation du mot de passe', type: 'password', required: true }
          ],
          submitLabel: 'Réinitialiser le mot de passe',
          block: true,
          onSubmit: async (values) => {
            const res = await post('/api/auth/reset-password', {
              email: state.email, code: String(values.code).trim(),
              password: values.password, password2: values.password2
            });
            clearInterval(timer);
            sessionStorage.removeItem('pending_reset_email');
            sessionStorage.removeItem('pending_reset_code');
            state.devCode = '';
            toast(res.message || 'Mot de passe réinitialisé.', 'ok', 5000);
            window.navigateTo('/login');
          }
        }),
        h('div', { style: { display: 'flex', gap: '9px', marginTop: '10px', flexWrap: 'wrap' } }, resendBtn),
        h('div', { class: 'auth-alt' },
          h('a', { href: '#/login', style: { fontWeight: 700 } }, '← Retour à la connexion')),
        h('div', { class: 'auth-alt', style: { marginTop: '6px', fontSize: '13px' } },
          h('a', { href: '#/forgot', onclick: (e) => { e.preventDefault(); clearInterval(timer); drawEmail(); } }, 'Changer d’adresse email'))));
  }

  const panel = h('div', { class: 'auth-panel' });
  if (state.email) { startCooldown(60); drawCode(); } else drawEmail();
  return h('div', { class: 'auth-wrap' }, authHero(), panel);
}

/* ---------------- Page publique d'une salle (QR code, lecture seule) ---------------- */
function ViewPublicRoom(token) {
  const root = h('div', { class: 'public-room' });
  mount(root, h('div', { class: 'empty' }, 'Chargement…'));
  get(`/api/public/room/${encodeURIComponent(token)}`).then((data) => {
    const r = data.room;
    document.title = `${r.code} — ${data.app_name || 'SmartSalle ISPITS'}`;
    mount(root,
      h('div', { class: 'pr-head' },
        h('div', {},
          h('div', { class: 'pr-code' }, r.code),
          h('div', { style: { opacity: .9, fontSize: '14px' } }, `${r.name} · ${r.floor}`),
          h('div', { style: { opacity: .8, fontSize: '13px' } }, r.location)),
        h('div', { style: { marginLeft: 'auto', textAlign: 'right', display: 'grid', gap: '8px', justifyItems: 'end' } },
          h('div', { class: 'pr-state' }, r.bookable
            ? (data.occupied ? 'OCCUPÉE — LIBRE À ' + (data.next ? data.next.start : 'fin de créneau') : 'LIBRE MAINTENANT')
            : `RÉSERVÉE AU ${r.reserved_for}`),
          h('div', { style: { fontSize: '13px', opacity: .9 } }, `Heure locale : ${data.now}`))),
      h('div', { class: 'card', style: { marginTop: '16px' } },
        h('h3', {}, 'Activité du jour'),
        data.current ? h('div', { class: 'item' },
          h('div', { class: 'i-ico' }, '🔴'),
          h('div', { class: 'i-main' },
            h('b', {}, `En cours : ${data.current.start}–${data.current.end}`),
            h('p', {}, [data.current.option, data.current.group, data.current.module, data.current.teacher].filter(Boolean).join(' · '))))
          : null,
        data.today.length ? table([
          { key: 'start', label: 'Heure', render: (x) => `${x.start} – ${x.end}` },
          { key: 'option', label: 'Option' },
          { key: 'group', label: 'Groupe' },
          { key: 'module', label: 'Module' },
          { key: 'teacher', label: 'Enseignant' }
        ], data.today, { empty: 'Aucune réservation aujourd’hui.' })
          : h('div', { class: 'empty' }, h('span', { class: 'big' }, '📭'), 'Aucune réservation aujourd’hui.')),
      h('div', { class: 'card' },
        h('h3', {}, 'Planning de la semaine'),
        data.week.length ? table([
          { key: 'day', label: 'Jour', render: (x) => fmtDayShort(x.day) },
          { key: 'start', label: 'Heure', render: (x) => `${x.start} – ${x.end}` },
          { key: 'option', label: 'Option' },
          { key: 'group', label: 'Groupe' },
          { key: 'title', label: 'Intitulé' }
        ], data.week, { empty: 'Semaine libre.' })
          : h('div', { class: 'empty' }, 'Aucune réservation cette semaine.')),
      h('div', { class: 'card' },
        h('h3', {}, 'Informations'),
        table([
          { key: 'k', label: 'Champ' },
          { key: 'v', label: 'Valeur' }
        ], [
          { k: 'Salle', v: r.code },
          { k: 'Étage', v: r.floor },
          { k: 'Localisation', v: r.location },
          { k: 'Équipements', v: r.equipment || '—' },
          { k: 'Statut', v: r.bookable ? 'Réservable' : `Réservée au ${r.reserved_for}` },
          { k: 'Établissement', v: data.institution }
        ])),
      h('div', { class: 'readonly-note' }, 'Page publique en lecture seule — aucune modification possible.'),
      h('div', { class: 'readonly-note' }, h('a', { href: '#/login' }, 'Accéder à l’application SmartSalle ISPITS')));
  }).catch((e) => {
    mount(root, h('div', { class: 'card' },
      h('div', { class: 'empty' }, h('span', { class: 'big' }, '⚠️'), errorMessage(e)),
      h('div', { style: { textAlign: 'center' } }, h('a', { href: '#/' }, 'Retour à l’accueil'))));
  });
  return root;
}
