// Pipeline — list view + drag & drop kanban (spec §3, §28, §29, §30)
import { api } from '../api.js';
import { store, kanbanStatuses, statusName, agents } from '../store.js';
import {
  $, $$, esc, avatar, colorFor, fmtRelative, fmtDateTime, fmtNum, tempChip, sourceChip,
  empty, skeleton, toast, scoreRing, el, fresh,} from '../ui.js';
import { openLead } from './leadPanel.js';
import { newLeadModal } from '../app.js';

let mode = localStorage.getItem('crm_leads_mode') || 'list';
let filters = {};

export async function render(view, params) {
  view = fresh(view);
  filters = parseHashQuery();
  view.innerHTML = `
    <div class="row-between mb" style="flex-wrap:wrap;gap:10px">
      <div class="seg">
        <button data-mode="list" class="${mode === 'list' ? 'active' : ''}">☰ רשימה</button>
        <button data-mode="board" class="${mode === 'board' ? 'active' : ''}">▦ לוח</button>
      </div>
      <div class="flex">
        <button class="btn btn-sm" id="btn-export">⬇ ייצוא CSV</button>
        <button class="btn btn-primary btn-sm" id="btn-new">＋ ליד חדש</button>
      </div>
    </div>
    <div class="filters" id="filters"></div>
    <div id="leads-body">${skeleton(6)}</div>`;

  renderFilters();
  await load();

  view.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) {
      mode = m.dataset.mode;
      localStorage.setItem('crm_leads_mode', mode);
      $$('[data-mode]', view).forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
      load();
    }
  });
  $('#btn-new', view).addEventListener('click', () => newLeadModal());
  $('#btn-export', view).addEventListener('click', exportCsv);

  async function load() {
    // fresh node per load — list and board each attach their own click handler
    const body = fresh($('#leads-body', view));
    body.innerHTML = skeleton(6);
    if (mode === 'board') await renderBoard(body);
    else await renderList(body);
  }

  function renderFilters() {
    const box = $('#filters', view);
    box.innerHTML = `
      <input class="input" id="f-q" style="max-width:230px" placeholder="🔍 שם, טלפון, מייל, עיר..." value="${esc(filters.q || '')}">
      <select id="f-status"><option value="">כל הסטטוסים</option>
        ${store.statuses.map((s) => `<option value="${s.key}" ${filters.status === s.key ? 'selected' : ''}>${esc(s.name_he)}</option>`).join('')}
      </select>
      <select id="f-owner"><option value="">כל העובדים</option>
        <option value="none" ${filters.owner === 'none' ? 'selected' : ''}>ללא נציג</option>
        ${agents().map((u) => `<option value="${u.id}" ${String(filters.owner) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>
      <select id="f-treatment"><option value="">כל הטיפולים</option>
        ${store.treatments.map((t) => `<option value="${t.id}" ${String(filters.treatment) === String(t.id) ? 'selected' : ''}>${esc(t.name_he)}</option>`).join('')}
      </select>
      <select id="f-source"><option value="">כל המקורות</option>
        ${store.sources.map((s) => `<option value="${s}" ${filters.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select id="f-temperature"><option value="">כל הדירוגים</option>
        <option value="hot" ${filters.temperature === 'hot' ? 'selected' : ''}>🔥 חם</option>
        <option value="warm" ${filters.temperature === 'warm' ? 'selected' : ''}>🌤️ בינוני</option>
        <option value="cold" ${filters.temperature === 'cold' ? 'selected' : ''}>❄️ קר</option>
      </select>
      <select id="f-sort">
        <option value="created_desc">חדשים ראשונים</option>
        <option value="next_action" ${filters.sort === 'next_action' ? 'selected' : ''}>לפי פעולה הבאה</option>
        <option value="score_desc" ${filters.sort === 'score_desc' ? 'selected' : ''}>לפי ניקוד</option>
        <option value="updated_desc" ${filters.sort === 'updated_desc' ? 'selected' : ''}>עודכן לאחרונה</option>
        <option value="name" ${filters.sort === 'name' ? 'selected' : ''}>לפי שם</option>
      </select>
      <label class="chip clickable ${filters.arrived === '1' ? 'active' : ''}" data-toggle="arrived">הגיעו למרפאה</label>
      <label class="chip clickable ${filters.arrived === '0' ? 'active' : ''}" data-toggle="not_arrived">לא הגיעו</label>
      <label class="chip clickable ${filters.untouched === '1' ? 'active' : ''}" data-toggle="untouched">לא טופלו</label>
      <label class="chip clickable ${filters.overdue === '1' ? 'active' : ''}" data-toggle="overdue">באיחור</label>
      ${Object.keys(filters).length ? '<button class="btn btn-sm btn-ghost" id="f-clear">נקה ✕</button>' : ''}`;

    let timer;
    $('#f-q', box).addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { filters.q = e.target.value.trim() || undefined; load(); }, 250);
    });
    for (const [id, key] of [['f-status', 'status'], ['f-owner', 'owner'], ['f-treatment', 'treatment'],
      ['f-source', 'source'], ['f-temperature', 'temperature'], ['f-sort', 'sort']]) {
      $(`#${id}`, box).addEventListener('change', (e) => {
        filters[key] = e.target.value || undefined;
        load();
      });
    }
    box.addEventListener('click', (e) => {
      const tg = e.target.closest('[data-toggle]');
      if (tg) {
        const k = tg.dataset.toggle;
        if (k === 'arrived') filters.arrived = filters.arrived === '1' ? undefined : '1';
        if (k === 'not_arrived') filters.arrived = filters.arrived === '0' ? undefined : '0';
        if (k === 'untouched') filters.untouched = filters.untouched === '1' ? undefined : '1';
        if (k === 'overdue') filters.overdue = filters.overdue === '1' ? undefined : '1';
        renderFilters();
        load();
      }
      if (e.target.closest('#f-clear')) { filters = {}; renderFilters(); load(); }
    });
  }

  // ------------------------------------------------------------- list ----
  async function renderList(body) {
    const { rows, total } = await api.get('/api/leads', { ...filters, limit: 100 });
    if (!rows.length) { body.innerHTML = empty('לא נמצאו לידים התואמים לסינון', '🔍'); return; }
    body.innerHTML = `
      <div class="card">
        <div class="card-head"><h3>${fmtNum(total)} לידים</h3></div>
        <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>לקוח</th><th>טלפון</th><th>טיפול</th><th>סטטוס</th><th>מקור</th>
            <th>עובד</th><th>פעולה הבאה</th><th>ניקוד</th><th></th>
          </tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table></div>
      </div>`;
    body.addEventListener('click', (e) => {
      const act = e.target.closest('[data-quick]');
      if (act) { e.stopPropagation(); quickAction(act.dataset.quick, Number(act.dataset.id)); return; }
      const tr = e.target.closest('tr[data-id]');
      if (tr) openLead(Number(tr.dataset.id));
    });
  }

  function rowHtml(r) {
    return `
    <tr data-id="${r.id}">
      <td>
        <div class="flex">
          ${avatar(r.full_name || '?', colorFor(r.full_name), 'sm')}
          <div style="min-width:0">
            <div class="bold truncate">${esc(r.full_name || '—')}
              ${r.unread ? `<span class="badge-new">${r.unread}</span>` : ''}</div>
            <div class="tiny dim">${esc(r.city || '')} ${r.temperature === 'hot' ? '🔥' : ''}</div>
          </div>
        </div>
      </td>
      <td class="num small">${esc(r.phone_pretty || '')}</td>
      <td class="small truncate" style="max-width:170px">${esc(r.treatments_he || '—')}</td>
      <td><span class="chip" style="background:${esc(r.status_color)}1f;color:${esc(r.status_color)};border-color:transparent">
        ${esc(r.status_he || r.status_key)}</span></td>
      <td class="tiny">${sourceChip(r.source)}</td>
      <td>${r.owner_name ? avatar(r.owner_name, r.owner_color, 'sm') : '<span class="dim tiny">ללא</span>'}</td>
      <td class="tiny ${r.next_action_at && new Date(r.next_action_at) < new Date() ? 'bold' : ''}"
          style="${r.next_action_at && new Date(r.next_action_at) < new Date() ? 'color:var(--red)' : ''}">
        ${r.next_action_at ? fmtDateTime(r.next_action_at) : (r.next_appointment ? `📅 ${fmtDateTime(r.next_appointment)}` : '—')}</td>
      <td>${scoreRing(r.score)}</td>
      <td>
        <div class="flex">
          <button class="btn btn-sm btn-icon" data-quick="call" data-id="${r.id}" title="התקשר">📞</button>
          <button class="btn btn-sm btn-icon btn-wa" data-quick="wa" data-id="${r.id}" title="WhatsApp">💬</button>
        </div>
      </td>
    </tr>`;
  }

  // ------------------------------------------------------------ board ----
  async function renderBoard(body) {
    const { columns } = await api.get('/api/leads/kanban', { ...filters, per_column: 50 });
    body.innerHTML = `<div class="kanban">${columns.map((c) => `
      <div class="kan-col" data-status="${esc(c.status.key)}">
        <div class="kan-head" style="background:${esc(c.status.color)}1f;color:${esc(c.status.color)}">
          <span class="dot" style="background:${esc(c.status.color)}"></span>
          ${esc(c.status.name_he)}
          <span class="kan-count">${c.total}</span>
        </div>
        <div class="kan-body">${c.rows.map(cardHtml).join('') || '<div class="tiny dim center" style="padding:12px">—</div>'}</div>
      </div>`).join('')}</div>`;

    let dragged = null;
    body.querySelectorAll('.lead-card').forEach((card) => {
      card.draggable = true;
      card.addEventListener('dragstart', () => { dragged = card; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); dragged = null; });
    });
    body.querySelectorAll('.kan-col').forEach((col) => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        if (!dragged) return;
        const id = Number(dragged.dataset.id);
        const status = col.dataset.status;
        if (dragged.closest('.kan-col').dataset.status === status) return;
        $('.kan-body', col).prepend(dragged);
        try {
          await api.post(`/api/leads/${id}/status`, { status_key: status });
          toast(`הסטטוס שונה ל: ${statusName(status)}`, 'ok');
          renderBoard(body);
        } catch (err) {
          toast(err.message, 'err');
          renderBoard(body);
        }
      });
    });
    body.addEventListener('click', (e) => {
      const act = e.target.closest('[data-quick]');
      if (act) { e.stopPropagation(); quickAction(act.dataset.quick, Number(act.dataset.id)); return; }
      const card = e.target.closest('.lead-card');
      if (card) openLead(Number(card.dataset.id));
    });
  }

  function cardHtml(r) {
    return `
    <div class="lead-card" data-id="${r.id}">
      <div class="row-between">
        <div class="name truncate">${esc(r.full_name || r.phone_pretty)}</div>
        ${r.temperature === 'hot' ? '<span>🔥</span>' : ''}
      </div>
      <div class="meta truncate">${esc(r.treatments_he || '—')}</div>
      <div class="meta num">${esc(r.phone_pretty || '')}</div>
      ${r.next_action_at ? `<div class="tiny" style="margin-top:5px;color:${new Date(r.next_action_at) < new Date() ? 'var(--red)' : 'var(--text-2)'}">
        ⏰ ${fmtDateTime(r.next_action_at)}</div>` : ''}
      <div class="foot">
        ${r.owner_name ? avatar(r.owner_name, r.owner_color, 'sm') : '<span class="tiny dim">ללא נציג</span>'}
        <div class="spacer"></div>
        ${r.unread ? `<span class="badge-new">${r.unread}</span>` : ''}
        <button class="btn btn-sm btn-icon" data-quick="call" data-id="${r.id}">📞</button>
        <button class="btn btn-sm btn-icon btn-wa" data-quick="wa" data-id="${r.id}">💬</button>
      </div>
    </div>`;
  }

  async function quickAction(kind, id) {
    const lead = await api.get(`/api/leads/${id}`);
    if (kind === 'call') {
      window.open(`tel:${lead.phone_norm}`, '_self');
      openLead(id, { tab: 'calls', logCall: true });
    } else {
      openLead(id, { tab: 'whatsapp' });
    }
  }

  async function exportCsv() {
    const { rows } = await api.get('/api/leads', { ...filters, limit: 1000 });
    const cols = ['id', 'full_name', 'phone_pretty', 'email', 'city', 'treatments_he', 'status_he',
      'source', 'campaign_name', 'owner_name', 'temperature', 'score', 'created_at', 'arrived_at'];
    const csv = ['﻿' + cols.join(',')]
      .concat(rows.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function parseHashQuery() {
  const q = location.hash.split('?')[1];
  if (!q) return {};
  const out = {};
  for (const [k, v] of new URLSearchParams(q)) {
    if (k === 'created' && v === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      out.created_from = d.toISOString();
    } else out[k] = v;
  }
  return out;
}
