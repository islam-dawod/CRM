// My Tasks (spec §32) + the reminder actions from §17
import { api } from '../api.js';
import { store, agents } from '../store.js';
import {
  esc, avatar, colorFor, fmtDateTime, fmtRelative, empty, skeleton, toast, formModal, fromLocalInput, toLocalInput, fresh,} from '../ui.js';
import { openLead } from './leadPanel.js';

let bucket = 'today';
let userFilter = null;
let showDone = false;

const BUCKETS = [
  { id: 'overdue', label: 'באיחור', icon: '🚨', color: 'var(--red)' },
  { id: 'today', label: 'היום', icon: '📌', color: 'var(--brand)' },
  { id: 'tomorrow', label: 'מחר', icon: '📅', color: 'var(--purple)' },
  { id: 'week', label: 'השבוע', icon: '🗓️', color: 'var(--text-2)' },
  { id: '', label: 'הכל', icon: '📋', color: 'var(--text-2)' },
];

export async function render(view) {
  view = fresh(view);
  if (userFilter === null) userFilter = store.permissions.readAll ? 'all' : 'me';
  const summary = await api.get('/api/tasks/summary', { user: userFilter });
  view.innerHTML = `
    <div class="kpi-grid">
      ${[['דחוף', summary.urgent, '#ef4444', 'overdue'], ['באיחור', summary.overdue, '#f97316', 'overdue'],
        ['היום', summary.today, '#0ea5e9', 'today'], ['מחר', summary.tomorrow, '#8b5cf6', 'tomorrow']]
        .map(([label, n, color, b]) => `
        <div class="kpi" data-bucket="${b}">
          <div class="bar" style="background:${color}"></div>
          <div class="label">${label}</div><div class="value num" style="color:${color}">${n || 0}</div>
        </div>`).join('')}
    </div>
    <div class="filters">
      ${BUCKETS.map((b) => `<span class="chip clickable ${bucket === b.id ? 'active' : ''}" data-bucket="${b.id}">
        ${b.icon} ${esc(b.label)}</span>`).join('')}
      <div class="spacer"></div>
      ${store.permissions.readAll ? `<select id="f-user">
        <option value="me" ${userFilter === 'me' ? 'selected' : ''}>המשימות שלי</option>
        <option value="all" ${userFilter === 'all' ? 'selected' : ''}>כל הצוות</option>
        ${agents().map((u) => `<option value="${u.id}" ${String(userFilter) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>` : ''}
      <span class="chip clickable ${showDone ? 'active' : ''}" data-done-toggle>הצג שבוצעו</span>
      <button class="btn btn-primary btn-sm" id="new-task">＋ משימה</button>
    </div>
    <div id="tasks-body">${skeleton(6)}</div>`;

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bucket]');
    if (b) { bucket = b.dataset.bucket; render(view); return; }
    if (e.target.closest('[data-done-toggle]')) { showDone = !showDone; render(view); }
  });
  view.querySelector('#f-user')?.addEventListener('change', (e) => { userFilter = e.target.value; load(view); });
  view.querySelector('#new-task').addEventListener('click', async () => {
    const data = await formModal({
      title: '＋ משימה חדשה',
      fields: [
        { name: 'title', label: 'כותרת', required: true },
        { name: 'due_at', label: 'מועד', type: 'datetime-local', required: true, value: toLocalInput(new Date(Date.now() + 3600000)) },
        {
          name: 'priority', label: 'עדיפות', type: 'select', value: 'normal',
          options: [{ value: 'low', label: 'נמוכה' }, { value: 'normal', label: 'רגילה' }, { value: 'urgent', label: 'דחוף' }],
        },
        {
          name: 'user_id', label: 'אחראי', type: 'select', value: store.user.id,
          options: agents().map((u) => ({ value: u.id, label: u.name })),
        },
        { name: 'note', label: 'הערה', type: 'textarea', rows: 2 },
      ],
    });
    if (!data) return;
    await api.post('/api/tasks', { ...data, due_at: fromLocalInput(data.due_at), user_id: Number(data.user_id) });
    toast('המשימה נוספה', 'ok');
    render(view);
  });

  await load(view);
}

async function load(view) {
  const rows = await api.get('/api/tasks', {
    bucket: bucket || undefined,
    user: userFilter,
    done: showDone ? 'all' : undefined,
    limit: 300,
  });
  const body = fresh(view.querySelector('#tasks-body'));
  if (!rows.length) { body.innerHTML = empty('אין משימות 🎉', '✅'); return; }

  body.innerHTML = `<div class="card">${rows.map((t) => `
    <div class="day-slot" style="padding:12px 14px;align-items:flex-start;${t.overdue ? 'background:var(--red-soft)' : ''}">
      <input type="checkbox" data-done="${t.id}" ${t.done ? 'checked' : ''} style="width:20px;height:20px;margin-top:2px">
      <div style="flex:1;min-width:0;cursor:pointer" data-lead="${t.lead_id || ''}">
        <div class="small bold" style="${t.done ? 'text-decoration:line-through;opacity:.55' : ''}">
          ${t.priority === 'urgent' ? '🚨 ' : ''}${esc(t.title)}</div>
        <div class="tiny ${t.overdue ? 'bold' : 'dim'}" style="${t.overdue ? 'color:var(--red)' : ''}">
          ${fmtDateTime(t.due_at)} · ${fmtRelative(t.due_at)}
          ${t.full_name ? ` · 👤 ${esc(t.full_name)}` : ''}</div>
        ${t.note ? `<div class="tiny muted" style="margin-top:3px">${esc(t.note)}</div>` : ''}
      </div>
      <div class="flex">
        ${t.user_name ? avatar(t.user_name, t.user_color, 'sm') : ''}
        ${!t.done ? `
          <button class="btn btn-sm btn-icon" data-call="${t.lead_id || ''}" title="התקשר">📞</button>
          <button class="btn btn-sm" data-snooze="${t.id}" data-min="15">15ד׳</button>
          <button class="btn btn-sm" data-snooze="${t.id}" data-min="60">שעה</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-del="${t.id}">🗑</button>
      </div>
    </div>`).join('')}</div>`;

  body.addEventListener('click', async (e) => {
    const chk = e.target.closest('[data-done]');
    if (chk) {
      await api.patch(`/api/tasks/${chk.dataset.done}`, { done: chk.checked });
      toast(chk.checked ? 'המשימה בוצעה ✓' : 'המשימה הוחזרה', 'ok');
      render(view);
      return;
    }
    const sn = e.target.closest('[data-snooze]');
    if (sn) {
      await api.patch(`/api/tasks/${sn.dataset.snooze}`, { snooze_min: Number(sn.dataset.min) });
      toast('המשימה נדחתה', 'ok');
      render(view);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) { await api.del(`/api/tasks/${del.dataset.del}`); render(view); return; }
    const call = e.target.closest('[data-call]');
    if (call?.dataset.call) { openLead(Number(call.dataset.call), { tab: 'calls', logCall: true }); return; }
    const lead = e.target.closest('[data-lead]');
    if (lead?.dataset.lead) openLead(Number(lead.dataset.lead));
  });
}
