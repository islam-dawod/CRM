// Analytics: funnel, team performance, response time, revenue (spec §35, §36, §38, §24)
import { api } from '../api.js';
import { store } from '../store.js';
import { esc, avatar, fmtNum, fmtMoney, fmtMinutes, bars, donut, colorFor, skeleton, empty, fresh} from '../ui.js';

let days = 30;

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="filters">
      <div class="seg">
        ${[7, 30, 90, 365].map((d) => `<button data-days="${d}" class="${days === d ? 'active' : ''}">${d} ימים</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn btn-sm" onclick="window.print()">🖨️ הדפסה</button>
    </div>
    <div id="rep-body">${skeleton(8)}</div>`;

  view.addEventListener('click', (e) => {
    const d = e.target.closest('[data-days]');
    if (d) { days = Number(d.dataset.days); render(view); }
  });

  const from = new Date(Date.now() - days * 86400000).toISOString();
  const [funnel, team, response, revenue, sources] = await Promise.all([
    api.get('/api/reports/funnel', { from }),
    api.get('/api/reports/team', { from }),
    api.get('/api/reports/response-time', { from }),
    api.get('/api/reports/revenue', { from }),
    api.get('/api/reports/sources', { from }),
  ]);

  const maxStep = funnel.steps[0]?.value || 1;
  view.querySelector('#rep-body').innerHTML = `
    <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">

      <section class="card card-pad" style="grid-column:1/-1">
        <h3 class="mb">📉 משפך המרה</h3>
        ${funnel.steps.map((s, i) => `
          <div class="funnel-step">
            <div style="width:110px" class="small bold">${esc(s.label)}</div>
            <div class="funnel-bar" style="width:${Math.max(6, (s.value / maxStep) * 100)}%">
              ${fmtNum(s.value)}
            </div>
            <div class="tiny dim" style="width:120px">
              ${s.pct_of_total}% מהסה״כ${i ? ` · ${s.pct_of_prev}% מהשלב הקודם` : ''}
            </div>
          </div>`).join('')}
        <div class="flex-wrap" style="margin-top:14px">
          <span class="chip">הכנסות מלידים אלה: <b>${fmtMoney(funnel.revenue.amount)}</b></span>
          <span class="chip">שולם: <b>${fmtMoney(funnel.revenue.paid)}</b></span>
          <span class="chip">ליד → הגיע: <b>${funnel.steps[4]?.pct_of_total || 0}%</b></span>
        </div>
      </section>

      <section class="card card-pad">
        <h3 class="mb">⏱️ זמן תגובה ראשון</h3>
        <div class="pill-stat mb"><span class="n">${fmtMinutes(response.avg_min)}</span>
          <span class="dim tiny">ממוצע · ${response.total} לידים · ${response.no_response} ללא מענה כלל</span></div>
        ${bars([
          { label: 'עד 5 דקות', value: response.under_5 || 0, color: '#22c55e' },
          { label: '5–15 דקות', value: response.m5_15 || 0, color: '#84cc16' },
          { label: '15–60 דקות', value: response.m15_60 || 0, color: '#f59e0b' },
          { label: '1–24 שעות', value: response.h1_24 || 0, color: '#f97316' },
          { label: 'מעל 24 שעות', value: response.over_24h || 0, color: '#ef4444' },
        ])}
        <div class="tiny dim mt">זהו KPI קריטי — ליד שנענה תוך 5 דקות ממיר פי כמה מליד שנענה למחרת.</div>
      </section>

      <section class="card card-pad">
        <h3 class="mb">💰 הכנסות</h3>
        <div class="grid-3 center mb">
          <div><div class="tiny dim">סה״כ עסקאות</div><div class="bold">${fmtMoney(revenue.totals.amount)}</div></div>
          <div><div class="tiny dim">שולם</div><div class="bold" style="color:var(--green)">${fmtMoney(revenue.totals.paid)}</div></div>
          <div><div class="tiny dim">יתרה</div><div class="bold" style="color:var(--amber)">${fmtMoney(revenue.totals.balance)}</div></div>
        </div>
        ${bars(revenue.byTreatment.slice(0, 7).map((t) => ({
          label: t.name, value: Math.round(t.amount), color: t.color || '#0ea5e9',
        })))}
      </section>

      <section class="card card-pad">
        <h3 class="mb">🌐 מקורות</h3>
        <div class="flex" style="gap:16px;flex-wrap:wrap">
          ${donut(sources.slice(0, 6).map((s) => ({ value: s.leads, color: colorFor(s.name) })))}
          <div style="flex:1;min-width:160px">
            ${sources.slice(0, 7).map((s) => `
              <div class="row-between small" style="padding:3px 0">
                <span class="flex"><span class="dot" style="background:${colorFor(s.name)}"></span>${esc(s.name)}</span>
                <span class="tiny dim">${s.leads} · ${s.conv_arrived}% הגיעו · ${fmtMoney(s.revenue)}</span>
              </div>`).join('')}
          </div>
        </div>
      </section>

      <section class="card" style="grid-column:1/-1">
        <div class="card-head"><h3>👥 ביצועי עובדים</h3></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr>
            <th>עובד</th><th>לידים</th><th>נוצר קשר</th><th>שיחות</th><th>ענו</th>
            <th>נקבע תור</th><th>הגיעו</th><th>טיפולים</th><th>הכנסה</th>
            <th>זמן תגובה</th><th>המרה להגעה</th><th>משימות באיחור</th>
          </tr></thead>
          <tbody>${team.map((u) => `
            <tr>
              <td><div class="flex">${avatar(u.name, u.color, 'sm')}<span class="bold small">${esc(u.name)}</span></div></td>
              <td class="num">${u.leads}</td>
              <td class="num">${u.contacted}</td>
              <td class="num">${u.calls}</td>
              <td class="num">${u.answered} <span class="tiny dim">(${u.answer_rate}%)</span></td>
              <td class="num">${u.scheduled}</td>
              <td class="num bold">${u.arrived}</td>
              <td class="num">${u.treatments}</td>
              <td class="num bold">${fmtMoney(u.revenue)}</td>
              <td class="num ${u.avg_response_min > 60 ? 'bold' : ''}"
                  style="${u.avg_response_min > 60 ? 'color:var(--red)' : ''}">${fmtMinutes(u.avg_response_min)}</td>
              <td>
                <div class="bar-track" style="width:70px"><div class="bar-fill"
                  style="width:${Math.min(100, u.conv_arrived)}%;background:var(--green)"></div></div>
                <span class="tiny dim">${u.conv_arrived}%</span>
              </td>
              <td class="num" style="${u.overdue_tasks ? 'color:var(--red);font-weight:700' : ''}">${u.overdue_tasks}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </section>
    </div>`;
}
