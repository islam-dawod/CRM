// Settings: clinic, statuses, treatments, SLA, integrations, audit log
// Spec §4, §5, §18, §25, §26, §47, §48
import { api } from '../api.js';
import { store } from '../store.js';
import {
  $, $$, esc, skeleton, toast, formModal, confirmDialog, empty, fmtDateTime, avatar, colorFor, fresh,} from '../ui.js';

let tab = 'clinic';
const TABS = [
  ['clinic', '🏥 מרפאה'], ['links', '🔗 קישורי המרפאה'], ['statuses', '🔄 סטטוסים'], ['treatments', '🦷 טיפולים'],
  ['sla', '⏱️ SLA והתראות'], ['integrations', '🔌 חיבורים'], ['audit', '📜 יומן פעולות'],
];

export async function render(view) {
  view = fresh(view);
  view.innerHTML = `
    <div class="filters">${TABS.map(([id, label]) =>
      `<span class="chip clickable ${tab === id ? 'active' : ''}" data-tab="${id}">${label}</span>`).join('')}</div>
    <div id="set-body">${skeleton(5)}</div>`;
  view.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { tab = t.dataset.tab; render(view); }
  });
  await load(view);
}

async function load(view) {
  const body = view.querySelector('#set-body');
  const settings = await api.get('/api/settings');
  if (tab === 'clinic') return clinicTab(body, settings, view);
  if (tab === 'links') return linksTab(body, settings, view);
  if (tab === 'statuses') return statusesTab(body, view);
  if (tab === 'treatments') return treatmentsTab(body, view);
  if (tab === 'sla') return slaTab(body, settings, view);
  if (tab === 'integrations') return integrationsTab(body, settings, view);
  if (tab === 'audit') return auditTab(body);
}

// ------------------------------------------------------------------ clinic --
function clinicTab(body, settings, view) {
  const c = settings.clinic || {};
  body.innerHTML = `
    <div class="card card-pad" style="max-width:640px">
      <h3 class="mb">פרטי המרפאה</h3>
      <div class="grid-2">
        <div class="field"><label>שם המרפאה</label><input class="input" id="c-name" value="${esc(c.name || '')}"></div>
        <div class="field"><label>טלפון</label><input class="input" id="c-phone" value="${esc(c.phone || '')}"></div>
        <div class="field"><label>כתובת</label><input class="input" id="c-address" value="${esc(c.address || '')}"></div>
        <div class="field"><label>קידומת מדינה</label><input class="input" id="c-cc" value="${esc(c.country_code || '972')}"></div>
        <div class="field"><label>שפת ברירת מחדל</label>
          <select class="input" id="c-lang">
            <option value="he" ${c.default_lang === 'he' ? 'selected' : ''}>עברית</option>
            <option value="ar" ${c.default_lang === 'ar' ? 'selected' : ''}>ערבית</option>
          </select></div>
        <div class="field"><label>סניפים (מופרד בפסיק)</label>
          <input class="input" id="c-branches" value="${esc((c.branches || []).join(', '))}"></div>
      </div>
      <button class="btn btn-primary" id="c-save">שמירה</button>
    </div>`;
  $('#c-save', body).addEventListener('click', async () => {
    await api.put('/api/settings/clinic', {
      ...c,
      name: $('#c-name', body).value,
      phone: $('#c-phone', body).value,
      address: $('#c-address', body).value,
      country_code: $('#c-cc', body).value,
      default_lang: $('#c-lang', body).value,
      branches: $('#c-branches', body).value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    toast('נשמר — רענן כדי לראות את השם החדש', 'ok');
  });
}

// ------------------------------------------------------------ clinic links --
// Spec §15 + "Clinic Links": one screen that every button in the CRM reads from.
const LINK_FIELDS = [
  ['name', 'שם המרפאה', 'text'],
  ['short_name', 'שם קצר (בתפריט)', 'text'],
  ['subtitle', 'תת-כותרת', 'text'],
  ['phone', 'טלפון', 'text'],
  ['whatsapp', 'WhatsApp (מספר בינלאומי, ללא +)', 'text'],
  ['email', 'אימייל', 'email'],
  ['address', 'כתובת', 'text'],
  ['website_url', 'אתר המרפאה', 'url'],
  ['maps_url', 'Google Maps URL', 'url'],
  ['waze_url', 'Waze URL', 'url'],
  ['digital_card_url', 'כרטיס דיגיטלי URL', 'url'],
  ['medreviews_url', 'MedReviews URL', 'url'],
  ['instagram_url', 'Instagram URL', 'url'],
  ['facebook_url', 'Facebook URL', 'url'],
  ['logo', 'נתיב הלוגו', 'text'],
];

function linksTab(body, settings, view) {
  const c = settings.clinic || {};
  body.innerHTML = `
    <div class="card card-pad" style="max-width:760px">
      <div class="flex mb" style="gap:14px;align-items:center">
        <img class="clinic-logo" src="${esc(c.logo || '/assets/clinic-logo.png')}" alt="לוגו"
             style="max-width:130px" width="560" height="289">
        <div>
          <h3>קישורי המרפאה</h3>
          <div class="tiny dim">כל כפתורי המערכת — מיקום, ניווט, כרטיס דיגיטלי ותבניות ההודעות —
            מושכים את הפרטים מכאן. שינוי כאן מתעדכן בכל המערכת מיד.</div>
        </div>
      </div>
      <div class="grid-2">
        ${LINK_FIELDS.map(([key, label, type]) => `
          <div class="field"><label>${esc(label)}</label>
            <input class="input" data-link="${key}" type="${type}" value="${esc(c[key] || '')}"
                   dir="${type === 'url' || type === 'email' ? 'ltr' : 'auto'}"></div>`).join('')}
      </div>
      <div class="tiny dim mb">
        אם Google Maps או Waze נשארים ריקים — המערכת בונה אותם אוטומטית מהכתובת.
      </div>
      <button class="btn btn-primary" id="l-save">שמירה</button>
    </div>`;

  $('#l-save', body).addEventListener('click', async () => {
    const patch = { ...c };
    $$('[data-link]', body).forEach((inp) => { patch[inp.dataset.link] = inp.value.trim(); });
    await api.put('/api/settings/clinic', patch);
    await refreshBootstrap();
    toast('קישורי המרפאה נשמרו', 'ok');
    render(view);
  });
}

// ---------------------------------------------------------------- statuses --
async function statusesTab(body, view) {
  const rows = await api.get('/api/statuses');
  body.innerHTML = `
    <div class="row-between mb"><div>
      <h3>סטטוסים בפייפליין</h3>
      <div class="tiny dim">ניתן להוסיף, לערוך ולשנות סדר. "בלוח" קובע אם הסטטוס מוצג כעמודה בקאנבן.</div></div>
      <button class="btn btn-primary btn-sm" id="add-status">＋ סטטוס</button></div>
    <div class="card"><div class="table-wrap"><table class="tbl">
      <thead><tr><th>שם</th><th>ערבית</th><th>אנגלית</th><th>שלב במשפך</th><th>בלוח</th><th>פעיל</th><th>סדר</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `
        <tr data-id="${s.id}" style="cursor:default">
          <td><div class="flex"><span class="dot" style="background:${esc(s.color)}"></span>
            <b>${esc(s.name_he)}</b></div><div class="tiny dim"><code>${esc(s.key)}</code></div></td>
          <td class="small">${esc(s.name_ar)}</td>
          <td class="small">${esc(s.name_en)}</td>
          <td><span class="chip tiny">${esc(stageLabel(s.stage))}</span></td>
          <td><input type="checkbox" data-kanban="${s.id}" ${s.in_kanban ? 'checked' : ''}></td>
          <td><input type="checkbox" data-active="${s.id}" ${s.active ? 'checked' : ''}></td>
          <td class="num">${s.sort}</td>
          <td class="flex">
            <button class="btn btn-sm" data-edit="${s.id}">✎</button>
            <button class="btn btn-sm btn-ghost" data-del="${s.id}">🗑</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div></div>`;

  body.addEventListener('change', async (e) => {
    const k = e.target.closest('[data-kanban]');
    if (k) { await api.patch(`/api/statuses/${k.dataset.kanban}`, { in_kanban: k.checked }); toast('נשמר', 'ok'); await refreshBootstrap(); }
    const a = e.target.closest('[data-active]');
    if (a) { await api.patch(`/api/statuses/${a.dataset.active}`, { active: a.checked }); toast('נשמר', 'ok'); await refreshBootstrap(); }
  });
  body.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { statusForm(rows.find((r) => r.id === Number(ed.dataset.edit)), view); return; }
    const del = e.target.closest('[data-del]');
    if (del && (await confirmDialog('למחוק את הסטטוס? (אם יש לידים משויכים הוא רק יושבת)', { danger: true }))) {
      const res = await api.del(`/api/statuses/${del.dataset.del}`);
      toast(res.deactivated ? `הסטטוס הושבת (${res.leads} לידים משויכים)` : 'נמחק', 'ok');
      await refreshBootstrap();
      render(view);
    }
  });
  $('#add-status', body).addEventListener('click', () => statusForm(null, view));
}

const STAGES = [['new', 'ליד חדש'], ['working', 'בטיפול'], ['scheduled', 'נקבע תור'],
  ['arrived', 'הגיע'], ['treatment', 'בטיפול רפואי'], ['won', 'נסגר בהצלחה'], ['lost', 'אבוד']];
const stageLabel = (s) => Object.fromEntries(STAGES)[s] || s;

async function statusForm(st, view) {
  const data = await formModal({
    title: st ? `עריכת ${st.name_he}` : '＋ סטטוס חדש',
    fields: [
      { name: 'name_he', label: 'שם בעברית', required: true, value: st?.name_he },
      { name: 'name_ar', label: 'שם בערבית', value: st?.name_ar },
      { name: 'name_en', label: 'שם באנגלית', value: st?.name_en },
      { name: 'color', label: 'צבע', type: 'color', value: st?.color || '#64748b' },
      {
        name: 'stage', label: 'שלב במשפך', type: 'select', value: st?.stage || 'working',
        options: STAGES.map(([value, label]) => ({ value, label })),
      },
      { name: 'sort', label: 'סדר', type: 'number', value: st?.sort ?? 99 },
      { name: 'in_kanban', label: 'הצג כעמודה בלוח הקאנבן', type: 'checkbox', value: st ? !!st.in_kanban : true },
    ],
  });
  if (!data) return;
  try {
    if (st) await api.patch(`/api/statuses/${st.id}`, { ...data, sort: Number(data.sort) });
    else await api.post('/api/statuses', { ...data, sort: Number(data.sort) });
    toast('נשמר', 'ok');
    await refreshBootstrap();
    render(view);
  } catch (err) { toast(err.message, 'err'); }
}

// -------------------------------------------------------------- treatments --
async function treatmentsTab(body, view) {
  const rows = await api.get('/api/treatments');
  body.innerHTML = `
    <div class="row-between mb"><div><h3>סוגי טיפולים</h3>
      <div class="tiny dim">ניתן להוסיף טיפולים חדשים ללא צורך במתכנת</div></div>
      <button class="btn btn-primary btn-sm" id="add-tr">＋ טיפול</button></div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
      ${rows.map((t) => `
        <div class="card card-pad ${t.active ? '' : 'muted'}">
          <div class="row-between">
            <div class="flex"><span class="dot" style="background:${esc(t.color)}"></span>
              <div><div class="bold">${esc(t.name_he)}</div>
              <div class="tiny dim">${esc(t.name_ar)} · ${esc(t.name_en)}</div></div></div>
            <button class="btn btn-sm" data-edit="${t.id}">✎</button>
          </div>
          <div class="tiny dim mt">מחיר ברירת מחדל: <b>₪${Number(t.price).toLocaleString('he-IL')}</b>
            ${t.active ? '' : ' · לא פעיל'}</div>
        </div>`).join('')}
    </div>`;

  $('#add-tr', body).addEventListener('click', () => treatmentForm(null, view));
  body.addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) treatmentForm(rows.find((r) => r.id === Number(ed.dataset.edit)), view);
  });
}

async function treatmentForm(tr, view) {
  const data = await formModal({
    title: tr ? `עריכת ${tr.name_he}` : '＋ טיפול חדש',
    fields: [
      { name: 'name_he', label: 'שם בעברית', required: true, value: tr?.name_he },
      { name: 'name_ar', label: 'שם בערבית', value: tr?.name_ar },
      { name: 'name_en', label: 'שם באנגלית', value: tr?.name_en },
      { name: 'price', label: 'מחיר ברירת מחדל (₪)', type: 'number', value: tr?.price ?? 0 },
      { name: 'color', label: 'צבע', type: 'color', value: tr?.color || '#0ea5e9' },
      ...(tr ? [{ name: 'active', label: 'פעיל', type: 'checkbox', value: !!tr.active }] : []),
    ],
  });
  if (!data) return;
  const payload = { ...data, price: Number(data.price) };
  if (tr) await api.patch(`/api/treatments/${tr.id}`, payload);
  else await api.post('/api/treatments', payload);
  toast('נשמר', 'ok');
  await refreshBootstrap();
  render(view);
}

// --------------------------------------------------------------------- SLA --
function slaTab(body, settings, view) {
  const s = settings.sla || {};
  body.innerHTML = `
    <div class="card card-pad" style="max-width:560px">
      <h3 class="mb">זמני תגובה והסלמה</h3>
      <div class="field"><label>יעד זמן תגובה ראשון (דקות)</label>
        <input class="input" id="s-first" type="number" value="${s.first_response_min ?? 15}"></div>
      <div class="field"><label>משימה נחשבת באיחור אחרי (דקות)</label>
        <input class="input" id="s-overdue" type="number" value="${s.overdue_task_min ?? 15}"></div>
      <div class="field"><label>הסלמה למנהל אחרי (דקות)</label>
        <input class="input" id="s-esc" type="number" value="${s.escalate_min ?? 60}"></div>
      <div class="field"><label>התראה על ליד ללא טיפול אחרי (שעות)</label>
        <input class="input" id="s-untouched" type="number" value="${s.untouched_hours ?? 24}"></div>
      <button class="btn btn-primary" id="s-save">שמירה</button>
    </div>`;
  $('#s-save', body).addEventListener('click', async () => {
    await api.put('/api/settings/sla', {
      first_response_min: Number($('#s-first', body).value),
      overdue_task_min: Number($('#s-overdue', body).value),
      escalate_min: Number($('#s-esc', body).value),
      untouched_hours: Number($('#s-untouched', body).value),
    });
    toast('נשמר', 'ok');
  });
}

// ------------------------------------------------------------ integrations --
function integrationsTab(body, settings, view) {
  const i = settings.integrations || {};
  const base = location.origin;
  body.innerHTML = `
    <div class="stack" style="max-width:760px">
      <div class="card card-pad">
        <h3 class="mb">🔗 כתובות Webhook</h3>
        <div class="tiny dim mb">חבר את דפי הנחיתה ואת Facebook Lead Ads לכתובות הבאות.</div>
        ${[
          ['ליד מדף נחיתה / טופס', `${base}/hooks/lead?key=${i.webhook_key || ''}`, 'POST'],
          ['Facebook / Instagram Lead Ads', `${base}/hooks/facebook`, 'GET verify + POST'],
          ['WhatsApp Cloud API', `${base}/hooks/whatsapp`, 'GET verify + POST'],
          ['פיקסל מעקב פתיחת מייל', `${base}/t/o/{tracking_id}`, 'GET'],
        ].map(([label, url, method]) => `
          <div class="field">
            <label>${esc(label)} <span class="chip tiny">${esc(method)}</span></label>
            <div class="flex"><input class="input" readonly value="${esc(url)}">
              <button class="btn btn-sm" data-copy="${esc(url)}">העתק</button></div>
          </div>`).join('')}
        <button class="btn btn-sm" id="regen-key">🔄 יצירת מפתח חדש</button>
        <div class="tiny dim mt">דף נחיתה לדוגמה: <a href="/demo/landing" target="_blank">${base}/demo/landing</a></div>
      </div>

      <div class="card card-pad">
        <h3 class="mb">💬 WhatsApp</h3>
        <div class="field"><label>ספק</label>
          <select class="input" id="wa-provider">
            <option value="simulator" ${i.whatsapp?.provider === 'simulator' ? 'selected' : ''}>סימולטור (ללא חיבור חיצוני)</option>
            <option value="cloud_api" ${i.whatsapp?.provider === 'cloud_api' ? 'selected' : ''}>Meta WhatsApp Cloud API</option>
          </select></div>
        <div class="grid-2">
          <div class="field"><label>Phone Number ID</label>
            <input class="input" id="wa-pid" value="${esc(i.whatsapp?.phone_number_id || '')}"></div>
          <div class="field"><label>Verify Token</label>
            <input class="input" id="wa-verify" value="${esc(i.whatsapp?.verify_token || 'crm-verify')}"></div>
        </div>
        <div class="field"><label>Access Token</label>
          <input class="input" id="wa-token" type="password" value="${esc(i.whatsapp?.token || '')}"></div>
        <div class="tiny dim">במצב סימולטור ההודעות נשמרות בכרטיס הלקוח בלי לצאת החוצה — מושלם להדגמה ולפיתוח.</div>
      </div>

      <div class="card card-pad">
        <h3 class="mb">✉️ מייל</h3>
        <div class="grid-2">
          <div class="field"><label>ספק</label>
            <select class="input" id="mail-provider">
              <option value="simulator" ${i.email?.provider === 'simulator' ? 'selected' : ''}>סימולטור</option>
              <option value="smtp" ${i.email?.provider === 'smtp' ? 'selected' : ''}>SMTP</option>
            </select></div>
          <div class="field"><label>כתובת שולח</label>
            <input class="input" id="mail-from" value="${esc(i.email?.from || '')}"></div>
        </div>
      </div>

      <div class="card card-pad">
        <h3 class="mb">📘 Facebook</h3>
        <div class="grid-2">
          <div class="field"><label>Verify Token</label>
            <input class="input" id="fb-verify" value="${esc(i.facebook?.verify_token || 'crm-verify')}"></div>
          <div class="field"><label>Page ID</label>
            <input class="input" id="fb-page" value="${esc(i.facebook?.page_id || '')}"></div>
        </div>
      </div>

      <button class="btn btn-primary" id="i-save">שמירת חיבורים</button>
    </div>`;

  body.addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast('הועתק ללוח', 'ok');
    }
  });
  $('#regen-key', body).addEventListener('click', async () => {
    if (!(await confirmDialog('יצירת מפתח חדש תנתק דפי נחיתה קיימים. להמשיך?'))) return;
    await api.post('/api/settings/webhook-key', {});
    toast('נוצר מפתח חדש', 'ok');
    render(view);
  });
  $('#i-save', body).addEventListener('click', async () => {
    await api.put('/api/settings/integrations', {
      ...i,
      whatsapp: {
        ...i.whatsapp,
        provider: $('#wa-provider', body).value,
        phone_number_id: $('#wa-pid', body).value,
        verify_token: $('#wa-verify', body).value,
        token: $('#wa-token', body).value,
      },
      email: { ...i.email, provider: $('#mail-provider', body).value, from: $('#mail-from', body).value },
      facebook: { ...i.facebook, verify_token: $('#fb-verify', body).value, page_id: $('#fb-page', body).value },
    });
    toast('נשמר', 'ok');
  });
}

// ------------------------------------------------------------------- audit --
async function auditTab(body) {
  const rows = await api.get('/api/audit', { limit: 200 });
  body.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>📜 יומן פעולות</h3><span class="tiny dim">מי עשה מה ומתי</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>מתי</th><th>משתמש</th><th>ישות</th><th>פעולה</th><th>פרטים</th><th>IP</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr style="cursor:default">
            <td class="tiny">${fmtDateTime(r.created_at)}</td>
            <td><div class="flex">${r.user_name ? avatar(r.user_name, colorFor(r.user_name), 'sm') : ''}
              <span class="small">${esc(r.user_name || 'מערכת')}</span></div></td>
            <td class="small">${esc(r.entity)}${r.entity_id ? ` #${r.entity_id}` : ''}</td>
            <td><span class="chip tiny">${esc(r.action)}</span></td>
            <td class="tiny truncate" style="max-width:280px">${esc(r.detail || '')}</td>
            <td class="tiny dim num">${esc(r.ip || '')}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

async function refreshBootstrap() {
  const data = await api.get('/api/bootstrap');
  Object.assign(store, data);
}
