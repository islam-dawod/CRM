// Central calendar — day / week / month (spec §19)
import { api } from '../api.js';
import { esc, fmtTime, fmtDate, empty, skeleton, toast, fresh} from '../ui.js';
import { openLead } from './leadPanel.js';

let mode = 'week';
let anchor = new Date();

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="row-between mb" style="flex-wrap:wrap;gap:10px">
      <div class="seg">
        <button data-cal="day" class="${mode === 'day' ? 'active' : ''}">יום</button>
        <button data-cal="week" class="${mode === 'week' ? 'active' : ''}">שבוע</button>
        <button data-cal="month" class="${mode === 'month' ? 'active' : ''}">חודש</button>
      </div>
      <div class="flex">
        <button class="btn btn-sm" data-move="-1">‹ הקודם</button>
        <button class="btn btn-sm" data-move="0">היום</button>
        <button class="btn btn-sm" data-move="1">הבא ›</button>
      </div>
      <div class="bold" id="cal-title"></div>
    </div>
    <div id="cal-body">${skeleton(5)}</div>`;

  view.addEventListener('click', (e) => {
    const m = e.target.closest('[data-cal]');
    if (m) { mode = m.dataset.cal; render(view); return; }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const dir = Number(mv.dataset.move);
      if (dir === 0) anchor = new Date();
      else if (mode === 'day') anchor.setDate(anchor.getDate() + dir);
      else if (mode === 'week') anchor.setDate(anchor.getDate() + dir * 7);
      else anchor.setMonth(anchor.getMonth() + dir);
      anchor = new Date(anchor);
      render(view);
    }
  });

  await load(view);
}

async function load(view) {
  const { from, to, title } = range();
  view.querySelector('#cal-title').textContent = title;
  const events = await api.get('/api/calendar', { from: from.toISOString(), to: to.toISOString() });
  const body = view.querySelector('#cal-body');

  if (mode === 'month') body.innerHTML = monthHtml(events, from, to);
  else if (mode === 'week') body.innerHTML = weekHtml(events, from);
  else body.innerHTML = dayHtml(events, from);

  body.addEventListener('click', (e) => {
    const item = e.target.closest('[data-lead]');
    if (item?.dataset.lead) openLead(Number(item.dataset.lead));
  });
}

function range() {
  const d = new Date(anchor);
  if (mode === 'day') {
    const from = new Date(d.setHours(0, 0, 0, 0));
    return { from, to: new Date(from.getTime() + 86400000), title: fmtDate(from, { weekday: 'long', year: 'numeric' }) };
  }
  if (mode === 'week') {
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 7 * 86400000);
    return { from: start, to: end, title: `${fmtDate(start)} – ${fmtDate(new Date(end - 1))}` };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());
  const end = new Date(gridStart.getTime() + 42 * 86400000);
  return {
    from: gridStart, to: end,
    title: new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' }).format(start),
  };
}

const DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function monthHtml(events, from) {
  const cells = [];
  const month = new Date(anchor).getMonth();
  for (let i = 0; i < 42; i++) {
    const day = new Date(from.getTime() + i * 86400000);
    const dayEvents = events.filter((e) => sameDay(e.start_at, day));
    cells.push(`
      <div class="cal-cell ${day.getMonth() !== month ? 'other' : ''} ${sameDay(day, new Date()) ? 'today' : ''}">
        <div class="bold tiny">${day.getDate()}</div>
        ${dayEvents.slice(0, 4).map((e) => `
          <div class="cal-ev" style="background:${esc(e.color)}" data-lead="${e.lead_id || ''}" title="${esc(e.title)}">
            ${fmtTime(e.start_at)} ${esc(e.title)}</div>`).join('')}
        ${dayEvents.length > 4 ? `<div class="tiny dim">+${dayEvents.length - 4}</div>` : ''}
      </div>`);
  }
  return `<div class="cal-grid" style="margin-bottom:6px">${DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells.join('')}</div>`;
}

function weekHtml(events, from) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86400000));
  return `<div style="display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:6px;overflow-x:auto">
    ${days.map((day) => {
      const list = events.filter((e) => sameDay(e.start_at, day)).sort((a, b) => a.start_at.localeCompare(b.start_at));
      return `<div class="card" style="min-height:200px;${sameDay(day, new Date()) ? 'border-color:var(--brand)' : ''}">
        <div class="card-head" style="padding:8px 10px">
          <div><div class="tiny dim">${DOW[day.getDay()]}</div><div class="bold">${day.getDate()}/${day.getMonth() + 1}</div></div>
          ${list.length ? `<span class="chip tiny">${list.length}</span>` : ''}
        </div>
        <div style="padding:6px">${list.map((e) => `
          <div class="cal-ev" style="background:${esc(e.color)};margin-bottom:4px;white-space:normal"
               data-lead="${e.lead_id || ''}">
            <b>${fmtTime(e.start_at)}</b> ${esc(e.title)}</div>`).join('') || '<div class="tiny dim center">—</div>'}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function dayHtml(events, from) {
  const list = events.filter((e) => sameDay(e.start_at, from)).sort((a, b) => a.start_at.localeCompare(b.start_at));
  if (!list.length) return empty('אין אירועים ביום זה', '📅');
  return `<div class="card card-pad">${list.map((e) => `
    <div class="day-slot" data-lead="${e.lead_id || ''}" style="cursor:pointer">
      <div class="day-time num">${fmtTime(e.start_at)}</div>
      <span class="dot" style="background:${esc(e.color)};margin-top:7px"></span>
      <div style="flex:1;min-width:0">
        <div class="small bold">${esc(e.title)}</div>
        <div class="tiny dim">${e.kind === 'appointment' ? `תור${e.doctor ? ` · ${esc(e.doctor)}` : ''}${e.branch ? ` · ${esc(e.branch)}` : ''}` : 'משימה'}</div>
      </div>
      ${e.status ? `<span class="chip tiny">${esc(e.status)}</span>` : ''}
      ${e.done ? '<span class="chip tiny">בוצע ✓</span>' : ''}
    </div>`).join('')}</div>`;
}
