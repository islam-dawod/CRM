// Team management: roles, workload, lead distribution (spec §33, §34, §47)
import { api } from '../api.js';
import { store, ROLE_LABEL } from '../store.js';
import {
  esc, avatar, fmtNum, fmtMinutes, fmtMoney, skeleton, toast, formModal, confirmDialog, empty, fresh,} from '../ui.js';

export async function render(view) {
  view = fresh(view);
  const [users, team, assignment] = await Promise.all([
    api.get('/api/users'),
    store.permissions.reports ? api.get('/api/reports/team', { from: new Date(Date.now() - 30 * 86400000).toISOString() }) : [],
    store.permissions.admin ? api.get('/api/settings').then((s) => s.assignment) : null,
  ]);
  const stats = new Map(team.map((t) => [t.id, t]));

  view.innerHTML = `
    ${assignment ? `
    <div class="card card-pad mb">
      <div class="row-between mb"><h3>⚖️ חלוקת לידים אוטומטית</h3></div>
      <div class="grid-3">
        <div class="field" style="margin:0"><label>שיטת חלוקה</label>
          <select class="input" id="assign-mode">
            <option value="round_robin" ${assignment.mode === 'round_robin' ? 'selected' : ''}>Round Robin (בתורות)</option>
            <option value="least_load" ${assignment.mode === 'least_load' ? 'selected' : ''}>לפי עומס נמוך</option>
          </select></div>
        <div class="field flex" style="margin:0;align-items:center;gap:10px;padding-top:22px">
          <label class="switch"><input type="checkbox" id="assign-spec" ${assignment.by_specialty ? 'checked' : ''}>
            <span class="track"></span></label>
          <span class="small">חלוקה לפי התמחות בטיפול</span>
        </div>
      </div>
    </div>` : ''}

    <div class="row-between mb"><h3>👥 צוות (${users.length})</h3>
      ${store.permissions.admin ? '<button class="btn btn-primary btn-sm" id="add-user">＋ עובד חדש</button>' : ''}</div>

    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
      ${users.map((u) => {
        const s = stats.get(u.id);
        return `<div class="card card-pad ${u.active ? '' : 'muted'}">
          <div class="flex mb">
            ${avatar(u.name, u.color, 'lg')}
            <div style="flex:1;min-width:0">
              <div class="bold truncate">${esc(u.name)}${u.active ? '' : ' <span class="chip tiny">לא פעיל</span>'}</div>
              <div class="tiny dim truncate">${esc(u.email)}</div>
              <div class="flex-wrap" style="margin-top:4px">
                <span class="chip tiny">${esc(ROLE_LABEL[u.role] || u.role)}</span>
                ${u.receives_leads ? '<span class="chip tiny" style="background:var(--green-soft);color:#166534">מקבל לידים</span>' : ''}
              </div>
            </div>
            ${store.permissions.admin ? `<button class="btn btn-ghost btn-icon" data-edit="${u.id}">✎</button>` : ''}
          </div>
          ${s ? `
          <div class="grid-3 center tiny" style="border-top:1px solid var(--border);padding-top:10px">
            <div><div class="dim">לידים</div><div class="bold" style="font-size:16px">${s.leads}</div></div>
            <div><div class="dim">הגיעו</div><div class="bold" style="font-size:16px;color:var(--green)">${s.arrived}</div></div>
            <div><div class="dim">הכנסה</div><div class="bold" style="font-size:14px">${fmtMoney(s.revenue)}</div></div>
          </div>
          <div class="tiny dim" style="margin-top:8px">
            זמן תגובה ממוצע: <b>${fmtMinutes(s.avg_response_min)}</b> ·
            לידים פתוחים: <b>${s.open_leads}</b>
            ${s.overdue_tasks ? ` · <span style="color:var(--red)">${s.overdue_tasks} משימות באיחור</span>` : ''}
          </div>` : ''}
        </div>`;
      }).join('')}
    </div>`;

  view.querySelector('#assign-mode')?.addEventListener('change', async (e) => {
    await api.put('/api/settings/assignment', { ...assignment, mode: e.target.value });
    toast('שיטת החלוקה עודכנה', 'ok');
  });
  view.querySelector('#assign-spec')?.addEventListener('change', async (e) => {
    await api.put('/api/settings/assignment', { ...assignment, by_specialty: e.target.checked });
    toast('הגדרת ההתמחות עודכנה', 'ok');
  });
  view.querySelector('#add-user')?.addEventListener('click', () => userForm(null, view));
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (btn) userForm(users.find((u) => u.id === Number(btn.dataset.edit)), view);
  });
}

async function userForm(user, view) {
  const data = await formModal({
    title: user ? `עריכת ${user.name}` : '＋ עובד חדש',
    wide: true,
    fields: [
      { name: 'name', label: 'שם', required: true, value: user?.name },
      { name: 'email', label: 'אימייל', type: 'email', required: !user, value: user?.email },
      { name: 'phone', label: 'טלפון', value: user?.phone },
      {
        name: 'role', label: 'תפקיד', type: 'select', value: user?.role || 'agent',
        options: Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })),
      },
      { name: 'password', label: user ? 'סיסמה חדשה (ריק = ללא שינוי)' : 'סיסמה', type: 'password' },
      { name: 'color', label: 'צבע', type: 'color', value: user?.color || '#0ea5e9' },
      {
        name: 'specialties', label: 'התמחות בטיפולים', type: 'multiselect', value: user?.specialties || [],
        options: store.treatments.map((t) => ({ value: t.id, label: t.name_he })),
      },
      { name: 'receives_leads', label: 'מקבל לידים אוטומטית', type: 'checkbox', value: user ? user.receives_leads : true },
      ...(user ? [{ name: 'active', label: 'משתמש פעיל', type: 'checkbox', value: user.active }] : []),
    ],
  });
  if (!data) return;
  const payload = {
    ...data,
    specialties: (data.specialties || []).map(Number),
  };
  if (!payload.password) delete payload.password;
  try {
    if (user) await api.patch(`/api/users/${user.id}`, payload);
    else await api.post('/api/users', payload);
    toast('נשמר', 'ok');
    const bootstrap = await api.get('/api/bootstrap');
    store.users = bootstrap.users;
    render(view);
  } catch (err) { toast(err.message, 'err'); }
}
