// Unified inbox — WhatsApp / Email / social in one place (spec §10)
import { api } from '../api.js';
import { esc, avatar, colorFor, fmtRelative, empty, skeleton, tempChip, fresh} from '../ui.js';
import { openLead } from './leadPanel.js';

let channel = 'all';
let unreadOnly = false;

const CHANNELS = [
  { id: 'all', label: 'הכל', icon: '📥' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
  { id: 'email', label: 'מייל', icon: '✉️' },
  { id: 'facebook', label: 'Facebook', icon: '📘' },
  { id: 'instagram', label: 'Instagram', icon: '📷' },
];

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="flex-wrap mb" id="inbox-filters">
      ${CHANNELS.map((c) => `<span class="chip clickable ${c.id === channel ? 'active' : ''}" data-ch="${c.id}">
        ${c.icon} ${esc(c.label)} <span class="dim" data-count="${c.id}"></span></span>`).join('')}
      <div class="spacer"></div>
      <span class="chip clickable ${unreadOnly ? 'active' : ''}" data-unread>שלא נקראו בלבד</span>
    </div>
    <div id="inbox-body">${skeleton(6)}</div>`;

  await load();

  view.querySelector('#inbox-filters').addEventListener('click', (e) => {
    const ch = e.target.closest('[data-ch]');
    if (ch) { channel = ch.dataset.ch; render(view); return; }
    if (e.target.closest('[data-unread]')) { unreadOnly = !unreadOnly; render(view); }
  });
}

async function load() {
  const body = document.querySelector('#inbox-body');
  const [rows, counts] = await Promise.all([
    api.get('/api/inbox', { channel, unread: unreadOnly ? 1 : undefined, limit: 120 }),
    api.get('/api/inbox/counts'),
  ]);
  document.querySelector('[data-count="all"]').textContent = counts.unread || '';
  document.querySelector('[data-count="whatsapp"]').textContent = counts.whatsapp || '';
  document.querySelector('[data-count="email"]').textContent = counts.email || '';

  if (!rows.length) { body.innerHTML = empty('אין הודעות', '📭'); return; }
  body.innerHTML = `<div class="card">${rows.map((m) => `
    <div class="day-slot" style="padding:12px 14px;cursor:pointer;${m.unread ? 'background:var(--brand-soft)' : ''}"
         data-lead="${m.lead_id}" data-channel="${esc(m.channel)}">
      <div style="font-size:20px">${channelIcon(m.channel)}</div>
      ${avatar(m.full_name || '?', colorFor(m.full_name), 'sm')}
      <div style="flex:1;min-width:0">
        <div class="row-between">
          <span class="small bold truncate">${esc(m.full_name || m.phone_norm)}</span>
          <span class="tiny dim">${fmtRelative(m.created_at)}</span>
        </div>
        ${m.subject ? `<div class="tiny bold truncate">${esc(m.subject)}</div>` : ''}
        <div class="tiny dim truncate">${m.direction === 'out' ? '↩︎ ' : ''}${esc(m.preview)}</div>
      </div>
      ${m.unread ? `<span class="badge-new">${m.unread}</span>` : ''}
      ${m.status_he ? `<span class="chip tiny" style="background:${esc(m.status_color)}1f;color:${esc(m.status_color)};border-color:transparent">${esc(m.status_he)}</span>` : ''}
    </div>`).join('')}</div>`;

  body.addEventListener('click', (e) => {
    const row = e.target.closest('[data-lead]');
    if (row) openLead(Number(row.dataset.lead), { tab: row.dataset.channel === 'email' ? 'email' : 'whatsapp' });
  });
}

const channelIcon = (c) => ({ whatsapp: '💬', email: '✉️', facebook: '📘', instagram: '📷', sms: '📱' }[c] || '📨');
