// Dashboard — spec §2
import { api } from '../api.js';
import { store, statusName } from '../store.js';
import {
  esc, avatar, fmtTime, fmtDateTime, fmtRelative, fmtNum, sparkline, donut, empty, colorFor,
  sourceChip, tempChip, toast, fresh,} from '../ui.js';
import { openLead } from './leadPanel.js';
import { newLeadModal } from '../app.js';
import { logoImg, clinic } from '../clinic.js';

const KPIS = [
  { key: 'new_today', label: 'לידים חדשים היום', color: '#3b82f6', filter: '#/leads?created=today' },
  { key: 'waiting', label: 'ממתינים לחזרה', color: '#f59e0b', filter: '#/leads?stage=working' },
  { key: 'no_answer', label: 'לא ענו', color: '#f97316', filter: '#/leads?status=no_answer,attempt_1,attempt_2,attempt_3' },
  { key: 'scheduled', label: 'נקבע תור', color: '#22c55e', filter: '#/leads?stage=scheduled' },
  { key: 'arrived', label: 'הגיעו לטיפול', color: '#10b981', filter: '#/leads?arrived=1' },
  { key: 'completed', label: 'טיפולים שנסגרו', color: '#15803d', filter: '#/leads?status=treatment_done' },
  { key: 'untouched_24h', label: 'ללא טיפול מעל 24 שעות', color: '#ef4444', filter: '#/leads?untouched=1' },
];

export async function render(view) {
  view = fresh(view);
  const data = await api.get('/api/reports/dashboard');
  const { kpi, todayAppointments, dueTasks, newMessages, newLeads, idleAgents, bySource, daily } = data;

  view.innerHTML = `
    <div class="page-header">
      ${logoImg('clinic-logo', 'max-width:112px')}
      <div>
        <div class="ttl">${esc(clinic().short_name || clinic().name || '')} – Clinic CRM</div>
        <div class="sub">${esc(clinic().subtitle || '')}${clinic().address ? ` · ${esc(clinic().address)}` : ''}</div>
      </div>
    </div>

    <div class="kpi-grid">
      ${KPIS.map((k) => `
        <div class="kpi" data-nav="${k.filter}">
          <div class="bar" style="background:${k.color}"></div>
          <div class="label">${esc(k.label)}</div>
          <div class="value num" style="color:${k.color}">${fmtNum(kpi[k.key] || 0)}</div>
        </div>`).join('')}
    </div>

    <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(330px,1fr))">

      <section class="card">
        <div class="card-head"><h3>📅 תורים להיום</h3>
          <span class="chip">${todayAppointments.length}</span></div>
        <div id="today-appts">${todayAppointments.length ? todayAppointments.map((a) => `
          <div class="day-slot" style="padding:10px 14px;cursor:pointer" data-lead="${a.lead_id}">
            <div class="day-time num">${fmtTime(a.start_at)}</div>
            <div style="flex:1;min-width:0">
              <div class="small bold truncate">${esc(a.first_name)} ${esc(a.last_name)}</div>
              <div class="tiny dim truncate">${esc(a.treatment_he || '')}${a.doctor_name ? ` · ${esc(a.doctor_name)}` : ''}</div>
            </div>
            <span class="chip tiny">${esc(apptLabel(a.status))}</span>
          </div>`).join('') : empty('אין תורים היום', '📅')}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>⏰ משימות לחזרה</h3>
          <a class="btn btn-ghost btn-sm" href="#/tasks">לכל המשימות</a></div>
        <div>${dueTasks.length ? dueTasks.map((t) => `
          <div class="day-slot" style="padding:10px 14px;cursor:pointer" data-lead="${t.lead_id || ''}">
            <div class="day-time tiny ${new Date(t.due_at) < new Date() ? 'bold' : ''}"
                 style="color:${new Date(t.due_at) < new Date() ? 'var(--red)' : 'var(--text-2)'}">
              ${isToday(t.due_at) ? fmtTime(t.due_at) : fmtDateTime(t.due_at)}</div>
            <div style="flex:1;min-width:0">
              <div class="small bold truncate">${esc(t.title)}</div>
              <div class="tiny dim truncate">${esc([t.first_name, t.last_name].filter(Boolean).join(' '))}</div>
            </div>
            <button class="btn btn-sm" data-done="${t.id}">בוצע ✓</button>
          </div>`).join('') : empty('אין משימות פתוחות 🎉', '✅')}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>💬 הודעות חדשות</h3>
          <a class="btn btn-ghost btn-sm" href="#/inbox">לתיבה</a></div>
        <div>${newMessages.length ? newMessages.map((m) => `
          <div class="day-slot" style="padding:10px 14px;cursor:pointer" data-lead="${m.lead_id}">
            <div style="font-size:18px">${m.channel === 'email' ? '✉️' : '💬'}</div>
            <div style="flex:1;min-width:0">
              <div class="small bold truncate">${esc(m.first_name)} ${esc(m.last_name)}</div>
              <div class="tiny dim truncate">${esc(m.body || '')}</div>
            </div>
            <div class="tiny dim">${fmtRelative(m.created_at)}</div>
          </div>`).join('') : empty('אין הודעות שלא נקראו', '💬')}
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h3>🎯 לידים אחרונים</h3>
          <button class="btn btn-primary btn-sm" id="dash-new-lead">＋ ליד</button></div>
        <div>${newLeads.length ? newLeads.map((l) => `
          <div class="day-slot" style="padding:10px 14px;cursor:pointer" data-lead="${l.id}">
            ${avatar(`${l.first_name} ${l.last_name}`, colorFor(l.first_name), 'sm')}
            <div style="flex:1;min-width:0">
              <div class="small bold truncate">${esc(l.first_name)} ${esc(l.last_name)}</div>
              <div class="tiny dim truncate">${esc(l.campaign_name || l.source || '')}</div>
            </div>
            ${tempChip(l.temperature)}
            <div class="tiny dim">${fmtRelative(l.created_at)}</div>
          </div>`).join('') : empty('אין לידים חדשים', '🎯')}
        </div>
      </section>

      <section class="card card-pad">
        <h3 style="margin-bottom:10px">📈 לידים ב-14 הימים האחרונים</h3>
        ${sparkline(fillDays(daily), { height: 70 })}
        <div class="row-between tiny dim" style="margin-top:6px">
          <span>${esc(daily[0]?.day || '')}</span><span>היום</span>
        </div>
      </section>

      <section class="card card-pad">
        <h3 style="margin-bottom:12px">🌐 מקורות לידים (30 יום)</h3>
        <div class="flex" style="gap:18px;align-items:center;flex-wrap:wrap">
          ${donut(bySource.slice(0, 6).map((s) => ({ value: s.n, color: colorFor(s.source) })))}
          <div style="flex:1;min-width:150px">
            ${bySource.slice(0, 6).map((s) => `
              <div class="row-between small" style="margin-bottom:5px">
                <span class="flex"><span class="dot" style="background:${colorFor(s.source)}"></span>
                  ${esc(s.source)}</span>
                <span class="num bold">${s.n}</span>
              </div>`).join('')}
          </div>
        </div>
      </section>

      ${idleAgents.length ? `
      <section class="card">
        <div class="card-head"><h3>⚠️ עובדים עם משימות פתוחות</h3></div>
        <div>${idleAgents.map((a) => `
          <div class="day-slot" style="padding:10px 14px">
            ${avatar(a.name, a.color, 'sm')}
            <div style="flex:1"><div class="small bold">${esc(a.name)}</div></div>
            ${a.overdue ? `<span class="chip" style="background:var(--red-soft);color:#b91c1c">${a.overdue} באיחור</span>` : ''}
            ${a.untouched ? `<span class="chip">${a.untouched} לא טופלו</span>` : ''}
          </div>`).join('')}
        </div>
      </section>` : ''}
    </div>`;

  view.addEventListener('click', async (e) => {
    const doneBtn = e.target.closest('[data-done]');
    if (doneBtn) {
      e.stopPropagation();
      await api.patch(`/api/tasks/${doneBtn.dataset.done}`, { done: true });
      toast('המשימה סומנה כבוצעה', 'ok');
      render(view);
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) { location.hash = nav.dataset.nav; return; }
    const leadRow = e.target.closest('[data-lead]');
    if (leadRow && leadRow.dataset.lead) openLead(Number(leadRow.dataset.lead));
  });
  view.querySelector('#dash-new-lead')?.addEventListener('click', () => newLeadModal());
}

const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();

const apptLabel = (s) => ({
  scheduled: 'נקבע', confirmed: 'אושר', arrived: 'הגיע', no_show: 'לא הגיע', done: 'בוצע', cancelled: 'בוטל',
}[s] || s);

function fillDays(daily) {
  const map = new Map(daily.map((d) => [d.day, d.n]));
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(map.get(key) || 0);
  }
  return out;
}
