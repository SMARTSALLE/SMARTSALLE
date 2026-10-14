/* SmartSalle ISPITS — mes notes, mes tâches, notifications */
'use strict';

/* ==================== NOTES ==================== */
async function ViewNotes() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement de vos notes…'));
  const box = h('div', {});

  async function draw() {
    const res = await get('/api/notes');
    const notes = res.notes || [];
    mount(box, notes.length
      ? h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' } },
        notes.map((n) => h('div', { class: 'card', style: { margin: 0 } },
          h('div', { class: 'card-head' },
            h('h3', {}, n.title),
            h('div', { class: 'actions' },
              h('button', { class: 'btn sm secondary', onclick: () => openNote(n) }, '✏️'),
              h('button', {
                class: 'btn sm danger', onclick: async () => {
                  const ok2 = await confirmBox({ title: 'Supprimer la note', message: `Supprimer « ${n.title} » ?`, confirmLabel: 'Supprimer', danger: true });
                  if (!ok2) return;
                  await del(`/api/notes/${n.id}`);
                  toast('Note supprimée.', 'ok');
                  draw();
                }
              }, '🗑'))),
          h('p', { style: { whiteSpace: 'pre-wrap', margin: '0 0 10px', fontSize: '14px', color: '#334155' } }, n.content || '—'),
          h('div', { class: 'help' }, `Créée le ${String(n.created_at).slice(0, 16).replace('T', ' ')} · privée`))))
      : h('div', { class: 'empty' }, h('span', { class: 'big' }, '📝'), 'Aucune note pour le moment.'));
  }

  function openNote(note) {
    const m = modal({ title: note ? 'Modifier la note' : 'Nouvelle note', body: h('div', {}) });
    mount($('.modal-body', document.getElementById('modal-root')), form({
      values: note || {},
      fields: [
        { name: 'title', label: 'Titre', required: true },
        { name: 'content', label: 'Contenu', type: 'textarea', rows: 7 }
      ],
      submitLabel: 'Enregistrer',
      cancel: () => m.close(),
      onSubmit: async (values) => {
        if (note) await put(`/api/notes/${note.id}`, values);
        else await post('/api/notes', values);
        toast('Note enregistrée.', 'ok');
        m.close();
        draw();
      }
    }));
  }

  mount(root,
    pageHead('Mes notes', 'Notes personnelles et privées (visibles uniquement par votre compte)',
      [h('button', { class: 'btn', onclick: () => openNote(null) }, '＋ Nouvelle note')]),
    box);
  await draw();
  return root;
}

/* ==================== TÂCHES ==================== */
async function ViewTasks() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement de vos tâches…'));
  const box = h('div', {});
  let filter = '';

  async function draw() {
    const res = await get(`/api/tasks${qs({ status: filter })}`);
    const tasks = res.tasks || [];
    mount(box, table([
      { key: 'title', label: 'Tâche', render: (t) => h('div', {}, h('b', {}, t.title), t.description ? h('div', { class: 'help' }, t.description) : null) },
      { key: 'due_date', label: 'Échéance', render: (t) => t.due_date ? fmtDay(t.due_date) : '—' },
      { key: 'priority', label: 'Priorité', render: (t) => statusBadge(t.priority) },
      { key: 'status', label: 'Statut', render: (t) => statusBadge(t.status) },
      {
        key: '_a', label: '', render: (t) => h('div', { class: 'row-actions' },
          t.status !== 'DOING' && t.status !== 'DONE'
            ? h('button', { class: 'btn sm secondary', onclick: async () => { await put(`/api/tasks/${t.id}`, { status: 'DOING' }); draw(); } }, '▶ En cours')
            : null,
          t.status !== 'DONE'
            ? h('button', { class: 'btn sm ok', onclick: async () => { await put(`/api/tasks/${t.id}`, { status: 'DONE' }); toast('Tâche terminée 🎉', 'ok'); draw(); } }, '✓ Terminer')
            : h('button', { class: 'btn sm secondary', onclick: async () => { await put(`/api/tasks/${t.id}`, { status: 'TODO' }); draw(); } }, '↺ Rouvrir'),
          h('button', {
            class: 'btn sm danger', onclick: async () => {
              const ok2 = await confirmBox({ title: 'Supprimer la tâche', message: `Supprimer « ${t.title} » ?`, confirmLabel: 'Supprimer', danger: true });
              if (!ok2) return;
              await del(`/api/tasks/${t.id}`);
              draw();
            }
          }, '🗑'))
      }
    ], tasks, { empty: 'Aucune tâche. Créez votre première tâche.', emptyIcon: '✅' }));
  }

  function openTask() {
    const m = modal({ title: 'Nouvelle tâche', body: h('div', {}) });
    mount($('.modal-body', document.getElementById('modal-root')), form({
      fields: [
        { name: 'title', label: 'Titre', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'due_date', label: 'Date limite', type: 'date' },
        { name: 'priority', label: 'Priorité', type: 'select', options: [{ value: 'LOW', label: 'BASSE' }, { value: 'NORMAL', label: 'NORMALE' }, { value: 'HIGH', label: 'HAUTE' }, { value: 'URGENT', label: 'URGENTE' }], value: 'NORMAL' },
        { name: 'status', label: 'Statut', type: 'select', options: [{ value: 'TODO', label: 'À FAIRE' }, { value: 'DOING', label: 'EN COURS' }, { value: 'DONE', label: 'TERMINÉE' }], value: 'TODO' }
      ],
      submitLabel: 'Créer la tâche',
      cancel: () => m.close(),
      onSubmit: async (values) => {
        await post('/api/tasks', values);
        toast('Tâche créée.', 'ok');
        m.close();
        draw();
      }
    }));
  }

  mount(root,
    pageHead('Mes tâches', 'Priorités LOW / NORMAL / HIGH / URGENT · statuts À FAIRE / EN COURS / TERMINÉE',
      [h('button', { class: 'btn', onclick: openTask }, '＋ Nouvelle tâche')]),
    h('div', { class: 'filters no-print' },
      ['TODO', 'DOING', 'DONE', ''].map((s) => h('button', {
        class: `btn sm ${filter === s ? '' : 'secondary'}`,
        onclick: () => { filter = s; draw(); }
      }, s ? (STATUS_LABEL[s]) : 'Toutes'))),
    box);
  await draw();
  return root;
}

/* ==================== NOTIFICATIONS ==================== */
async function ViewNotifications() {
  const root = h('div', {});
  mount(root, loadingCard('Chargement des notifications…'));
  const box = h('div', {});

  async function draw() {
    const res = await get('/api/notifications');
    APP.unread = res.unread;
    updateBadge();
    mount(box, res.notifications.length
      ? h('div', { class: 'list' }, res.notifications.map((n) => h('div', { class: `item${n.read_at ? '' : ' unread'}` },
        h('div', { class: 'i-ico' }, iconFor(n.type)),
        h('div', { class: 'i-main' },
          h('b', {}, n.title),
          h('p', {}, n.body),
          n.link ? h('a', { href: n.link, style: { fontSize: '13px' } }, 'Ouvrir →') : null),
        h('div', { class: 'i-time' }, String(n.created_at).slice(0, 16).replace('T', ' ')))))
      : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🔔'), 'Aucune notification.'));
  }

  function iconFor(t) {
    return { reservation: '📅', reservation_cancelled: '🗑', account: '👤', option: '🎯', option_request: '📨', task: '✅', notification: '🔔' }[t] || '🔔';
  }

  mount(root,
    pageHead('Notifications', 'Réservations, comptes, options et rappels',
      [h('button', {
        class: 'btn secondary', onclick: async () => {
          await post('/api/notifications/read', {});
          toast('Toutes les notifications sont marquées comme lues.', 'ok');
          draw();
        }
      }, '✓ Tout marquer comme lu')]),
    box);
  await draw();
  return root;
}

function updateBadge() {
  const el = document.getElementById('notif-count');
  if (!el) return;
  el.textContent = APP.unread || '';
  el.style.display = (APP.unread > 0) ? 'grid' : 'none';
}
