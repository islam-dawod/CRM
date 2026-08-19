// Appointment management (spec §20–§22)
import { api } from '../api.js';
import { store, doctors, APPT_STATUS_LABEL, APPT_STATUS_COLOR } from '../store.js';
import { esc, fmtDateTime, fmtDate, fmtTime, empty, skeleton, toast, confirmDialog, fresh} from '../ui.js';
import { openLead } from './leadPanel.js';
import { openClinicSend } from '../clinic.js';

let filter = { status: '', doctor: '', when: 'upcoming' };

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="filters">
      <div class="seg">
        <button data-when="today" class="${filter.when === 'today' ? 'active' : ''}">היום</button>
        <button data-when="upcoming" class="${filter.when === 'upcoming' ? 'active' : ''}">קרובים</button>
        <button data-when="past" class="${filter.when === 'past' ? 'active' : ''}">היסטוריה</button>
      </div>
      <select id="f-status"><option value="">כל הסטטוסים</option>
        ${Object.entries(APPT_STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${filter.status === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}
      </select>
      <select id="f-doctor"><option value="">כל הרופאים</option>
        ${doctors().map((d) => `<option value="${d.id}" ${String(filter.doctor) === String(d.id) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
      </select>
    </div>
    <div id="appt-body">${skeleton(6)}</div>`;

  view.addEventListener('click', (e) => {
    const w = e.target.closest('[data-when]');
    if (w) { filter.when = w.dataset.when; render(view); }
  });
  view.querySelector('#f-status').addEventListener('change', (e) => { filter.status = e.target.value; load(view); });
  view.querySelector('#f-doctor').addEventListener('change', (e) => { filter.doctor = e.target.value; load(view); });

  await load(view);
}

async function load(view) {
  const now = new Date();
  const q = { status: filter.status || undefined, doctor: filter.doctor || undefined, limit: 300 };
  if (filter.when === 'today') {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    q.from = s.toISOString();
    q.to = new Date(s.getTime() + 86400000).toISOString();
  } else if (filter.when === 'upcoming') {
    q.from = now.toISOString();
  } else {
    q.to = now.toISOString();
  }
  const rows = await api.get('/api/appointments', q);
  if (filter.when === 'past') rows.reverse();
  const body = fresh(view.querySelector('#appt-body'));

  if (!rows.length) { body.innerHTML = empty('אין תורים להצגה', '📅'); return; }

  // group by day
  const groups = new Map();
  for (const a of rows) {
    const key = fmtDate(a.start_at, { weekday: 'long', year: 'numeric' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  body.innerHTML = [...groups].map(([day, list]) => `
    <div class="card mb">
      <div class="card-head"><h3>${esc(day)}</h3><span class="chip">${list.length} תורים</span></div>
      <div>${list.map((a) => `
        <div class="day-slot" style="padding:12px 14px;align-items:flex-start">
          <div class="day-time num">${fmtTime(a.start_at)}</div>
          <span class="dot" style="background:${esc(a.treatment_color || '#0ea5e9')};margin-top:7px"></span>
          <div style="flex:1;min-width:0;cursor:pointer" data-lead="${a.lead_id}">
            <div class="small bold">${esc(a.first_name)} ${esc(a.last_name)}</div>
            <div class="tiny dim">${esc(a.treatment_he || 'תור')}${a.doctor_name ? ` · ${esc(a.doctor_name)}` : ''}${a.branch ? ` · ${esc(a.branch)}` : ''}</div>
            <div class="tiny dim num">${esc(a.phone_norm || '')}</div>
          </div>
          <div class="flex-wrap" style="justify-content:flex-end">
            <span class="chip" style="background:${APPT_STATUS_COLOR[a.status]}22;color:${APPT_STATUS_COLOR[a.status]};border-color:transparent">
              ${esc(APPT_STATUS_LABEL[a.status] || a.status)}</span>
            ${a.status === 'scheduled' ? `<button class="btn btn-sm" data-set="${a.id}" data-status="confirmed">אשר</button>` : ''}
            ${['scheduled', 'confirmed'].includes(a.status) ? `
              <button class="btn btn-sm btn-primary" data-set="${a.id}" data-status="arrived">✓ הגיע</button>
              <button class="btn btn-sm" data-set="${a.id}" data-status="no_show">לא הגיע</button>` : ''}
            ${a.status === 'arrived' ? `<button class="btn btn-sm" data-set="${a.id}" data-status="done">סיים טיפול</button>` : ''}
            <button class="btn btn-sm btn-ghost" data-send="appointment" data-lead="${a.lead_id}" data-appt="${a.id}"
              title="שליחת תזכורת עם פרטי הפגישה והמיקום">📅 תזכורת</button>
            <button class="btn btn-sm btn-ghost" data-send="location" data-lead="${a.lead_id}" data-appt="${a.id}"
              title="שליחת מיקום המרפאה">📍</button>
            <button class="btn btn-sm btn-ghost" data-send="card" data-lead="${a.lead_id}" data-appt="${a.id}"
              title="שליחת כרטיס המרפאה">💳</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`).join('');

  body.addEventListener('click', async (e) => {
    const send = e.target.closest('[data-send]');
    if (send) {
      openClinicSend(Number(send.dataset.lead), send.dataset.send, {
        appointmentId: Number(send.dataset.appt),
        onSent: () => load(view),
      });
      return;
    }
    const set = e.target.closest('[data-set]');
    if (set) {
      try {
        await api.patch(`/api/appointments/${set.dataset.set}`, { status: set.dataset.status });
        toast('סטטוס התור עודכן', 'ok');
        load(view);
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    const lead = e.target.closest('[data-lead]');
    if (lead) openLead(Number(lead.dataset.lead), { tab: 'appointments' });
  });
}
