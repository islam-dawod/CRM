// Campaign analysis — which campaign actually brings money (spec §37)
import { api } from '../api.js';
import { esc, fmtNum, fmtMoney, skeleton, empty, colorFor, fresh} from '../ui.js';

let days = 30;
let group = 'campaign';

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="filters">
      <div class="seg">
        ${[7, 30, 90, 365].map((d) => `<button data-days="${d}" class="${days === d ? 'active' : ''}">${d} ימים</button>`).join('')}
      </div>
      <div class="seg">
        ${[['campaign', 'לפי קמפיין'], ['ad', 'לפי מודעה'], ['source', 'לפי מקור']]
          .map(([g, l]) => `<button data-group="${g}" class="${group === g ? 'active' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div id="camp-body">${skeleton(6)}</div>`;

  view.addEventListener('click', (e) => {
    const d = e.target.closest('[data-days]');
    if (d) { days = Number(d.dataset.days); render(view); return; }
    const g = e.target.closest('[data-group]');
    if (g) { group = g.dataset.group; render(view); }
  });

  const from = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await api.get('/api/reports/campaigns', { from, group });
  const body = view.querySelector('#camp-body');
  if (!rows.length) { body.innerHTML = empty('אין נתוני קמפיינים בטווח שנבחר', '📣'); return; }

  const totalRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
  const totalLeads = rows.reduce((s, r) => s + r.leads, 0);

  body.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="bar" style="background:#0ea5e9"></div>
        <div class="label">סה״כ לידים</div><div class="value num">${fmtNum(totalLeads)}</div></div>
      <div class="kpi"><div class="bar" style="background:#22c55e"></div>
        <div class="label">סה״כ הכנסות</div><div class="value num" style="font-size:22px">${fmtMoney(totalRevenue)}</div></div>
      <div class="kpi"><div class="bar" style="background:#8b5cf6"></div>
        <div class="label">הכנסה לליד</div><div class="value num" style="font-size:22px">
          ${fmtMoney(totalLeads ? totalRevenue / totalLeads : 0)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>📣 ביצועי קמפיינים</h3>
        <span class="tiny dim">ממוין לפי הכנסה — לא לפי כמות לידים</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr>
          <th>קמפיין</th><th>לידים</th><th>נוצר קשר</th><th>קבעו תור</th><th>הגיעו</th>
          <th>לקוחות</th><th>הכנסה</th><th>הכנסה לליד</th><th>המרה להגעה</th>
        </tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><div class="flex"><span class="dot" style="background:${colorFor(r.name)}"></span>
              <span class="bold small">${esc(r.name || '—')}</span></div>
              <div class="tiny dim">${esc(r.source || '')}</div></td>
            <td class="num">${r.leads}</td>
            <td class="num">${r.contacted}</td>
            <td class="num">${r.scheduled}</td>
            <td class="num bold">${r.arrived}</td>
            <td class="num">${r.customers}</td>
            <td class="num bold" style="color:var(--green)">${fmtMoney(r.revenue)}</td>
            <td class="num">${fmtMoney(r.revenue_per_lead)}</td>
            <td>
              <div class="bar-track" style="width:80px"><div class="bar-fill"
                style="width:${Math.min(100, r.conv_arrived)}%;background:${r.conv_arrived >= 20 ? 'var(--green)' : 'var(--amber)'}"></div></div>
              <span class="tiny dim">${r.conv_arrived}%</span>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}
