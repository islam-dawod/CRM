// Customer 360 side panel — the most important screen in the system (spec §6, §51)
import { api } from '../api.js';
import {
  store, statusName, statusColor, agents, doctors, treatmentName,
  OUTCOME_LABEL, APPT_STATUS_LABEL, APPT_STATUS_COLOR, DEAL_STAGE_LABEL,
} from '../store.js';
import {
  $, $$, el, esc, avatar, colorFor, initials, fmtDate, fmtTime, fmtDateTime, fmtFull,
  fmtRelative, fmtMoney, fmtNum, fmtDuration, fmtMinutes, toLocalInput, fromLocalInput,
  tempChip, sourceChip, scoreRing, empty, skeleton, toast, modal, formModal, confirmDialog,
} from '../ui.js';
import { openClinicSend, logoImg } from '../clinic.js';

let currentId = null;
let currentTab = 'overview';
let lead = null;

const TABS = [
  { id: 'overview', label: 'סקירה', icon: '👤' },
  { id: 'timeline', label: 'היסטוריה', icon: '🕐' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
  { id: 'email', label: 'מייל', icon: '✉️' },
  { id: 'calls', label: 'שיחות', icon: '📞' },
  { id: 'appointments', label: 'תורים', icon: '📅' },
  { id: 'tasks', label: 'משימות', icon: '✅' },
  { id: 'notes', label: 'הערות', icon: '📝' },
  { id: 'documents', label: 'מסמכים', icon: '📎' },
  { id: 'deals', label: 'עסקאות', icon: '💰' },
];

export async function openLead(id, opts = {}) {
  currentId = id;
  currentTab = opts.tab || 'overview';
  closePanel();

  const backdrop = el('<div class="drawer-backdrop"></div>');
  const drawer = el(`
    <div class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head" id="lead-head">${skeleton(2)}</div>
      <div class="drawer-tabs" id="lead-tabs"></div>
      <div class="drawer-body" id="lead-body">${skeleton(5)}</div>
    </div>`);
  const root = document.getElementById('drawer-root');
  root.append(backdrop, drawer);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', escHandler);

  await reload();
  if (opts.logCall) logCallModal();
}

function escHandler(e) {
  if (e.key === 'Escape') closePanel();
}

export function closePanel() {
  document.getElementById('drawer-root').innerHTML = '';
  document.removeEventListener('keydown', escHandler);
  if (location.hash.startsWith('#/lead/')) history.back();
}

async function reload(keepTab = true) {
  lead = await api.get(`/api/leads/${currentId}`);
  renderHead();
  renderTabs();
  await renderTab();
}

// ------------------------------------------------------------------ head ---
/** Replaces a panel section with an empty clone so its old listeners go away. */
function freshNode(selector) {
  const previous = $(selector);
  if (!previous) return null;
  const next = previous.cloneNode(false);
  previous.replaceWith(next);
  return next;
}

function renderHead() {
  const head = freshNode('#lead-head');
  if (!head) return;
  const nba = lead.next_best_action;
  head.innerHTML = `
    <div class="row-between" style="align-items:flex-start">
      <div class="flex" style="align-items:flex-start;gap:12px;min-width:0">
        ${avatar(lead.full_name || '?', colorFor(lead.full_name), 'lg')}
        <div style="min-width:0">
          <h3 style="font-size:19px" class="truncate">${esc(lead.full_name || 'ליד ללא שם')}</h3>
          <div class="tiny dim">#${lead.id} · ${esc(lead.city || '')} · ${sourceChip(lead.source)}</div>
          <div class="flex-wrap" style="margin-top:7px">
            ${tempChip(lead.temperature)}
            <span class="chip" style="background:${esc(lead.status_color)}1f;color:${esc(lead.status_color)};border-color:transparent">
              ${esc(lead.status_he || lead.status_key)}</span>
            ${lead.do_not_contact ? '<span class="chip" style="background:var(--red-soft);color:#b91c1c">אין ליצור קשר</span>' : ''}
          </div>
        </div>
      </div>
      <div class="flex">
        ${scoreRing(lead.score)}
        <button class="btn btn-ghost btn-icon" id="lead-close">✕</button>
      </div>
    </div>

    <!-- Mobile: one button opens a sheet so the card stays uncluttered (spec §12) -->
    <div style="margin-top:12px">
      <button class="btn btn-primary btn-block btn-actions" data-act="sheet">⚡ פעולות</button>
    </div>

    <div class="flex-wrap lead-actions-desktop" style="margin-top:12px">
      <a class="btn btn-sm btn-primary" href="tel:${esc(lead.phone_norm || '')}" data-act="call">📞 התקשר</a>
      <button class="btn btn-sm btn-wa" data-act="wa">💬 WhatsApp</button>
      <button class="btn btn-sm" data-act="email" ${lead.email ? '' : 'disabled'}>✉️ מייל</button>
      <button class="btn btn-sm" data-act="send-location">📍 שליחת מיקום</button>
      <button class="btn btn-sm" data-act="send-card">💳 כרטיס המרפאה</button>
      <button class="btn btn-sm" data-act="send-details">📲 פרטי המרפאה</button>
      <button class="btn btn-sm" data-act="appt">📅 קבע תור</button>
      <button class="btn btn-sm" data-act="task">⏰ קבע חזרה</button>
      <button class="btn btn-sm" data-act="log-call">📝 תיעוד שיחה</button>
      ${lead.status_stage === 'scheduled' ? '<button class="btn btn-sm" style="background:var(--green);color:#fff;border-color:var(--green)" data-act="arrived">✓ הלקוח הגיע</button>' : ''}
    </div>

    ${nba ? `<div class="flex" style="margin-top:10px;background:var(--purple-soft);padding:8px 11px;border-radius:10px;font-size:13px">
      <span>🤖</span>
      <div style="flex:1;min-width:0">
        <b>המלצת AI:</b> ${esc(nba.label)}
        <span class="dim tiny"> (${nba.probability}% · ${esc(nba.reasons.slice(0, 2).join(', '))})</span>
      </div>
    </div>` : ''}`;

  $('#lead-close', head).addEventListener('click', closePanel);
  head.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act) runAction(act);
  });
}

/** Single place where a quick action is executed, shared by the row and the sheet. */
function runAction(act) {
  switch (act) {
    case 'wa': return switchTab('whatsapp');
    case 'email': return switchTab('email');
    case 'appt': return appointmentModal();
    case 'task': return taskModal();
    case 'log-call': return logCallModal();
    case 'arrived': return markArrived();
    case 'sheet': return actionSheet();
    case 'send-location':
    case 'send-card':
    case 'send-details': {
      const kind = { 'send-location': 'location', 'send-card': 'card', 'send-details': 'details' }[act];
      return openClinicSend(lead.id, kind, { lead, onSent: () => reload() });
    }
    case 'call':
    default:
      return undefined; // the phone link handles itself
  }
}

/** Mobile actions sheet (spec §12) */
function actionSheet() {
  const items = [
    { act: 'wa', icon: '💬', label: 'WhatsApp' },
    { act: 'call-link', icon: '📞', label: 'התקשרות' },
    { act: 'email', icon: '✉️', label: 'Email', disabled: !lead.email },
    { act: 'send-location', icon: '📍', label: 'שליחת מיקום' },
    { act: 'send-card', icon: '💳', label: 'כרטיס המרפאה' },
    { act: 'send-details', icon: '📲', label: 'פרטי המרפאה' },
    { act: 'appt', icon: '📅', label: 'קביעת פגישה' },
    { act: 'task', icon: '⏰', label: 'קביעת חזרה' },
    { act: 'log-call', icon: '📝', label: 'תיעוד שיחה' },
  ];
  const sheet = el(`
    <div class="sheet-backdrop">
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-grip"></div>
        ${items.map((i) => (i.act === 'call-link'
          ? `<a class="sheet-item" href="tel:${esc(lead.phone_norm || '')}"><span class="ico">${i.icon}</span>${esc(i.label)}</a>`
          : `<div class="sheet-item" data-sheet-act="${i.act}" style="${i.disabled ? 'opacity:.45;pointer-events:none' : ''}">
               <span class="ico">${i.icon}</span>${esc(i.label)}</div>`)).join('')}
      </div>
    </div>`);
  document.getElementById('modal-root').append(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) return sheet.remove();
    const item = e.target.closest('[data-sheet-act]');
    if (!item) return;
    sheet.remove();
    runAction(item.dataset.sheetAct);
  });
}

function renderTabs() {
  const box = freshNode('#lead-tabs');
  if (!box) return;
  const counts = lead.counts || {};
  box.innerHTML = TABS.map((t) => {
    const n = { whatsapp: counts.whatsapp, email: counts.emails, calls: counts.calls,
      appointments: lead.appointments.length, tasks: lead.tasks.filter((x) => !x.done_at).length,
      documents: lead.documents.length, deals: lead.deals.length }[t.id];
    return `<div class="drawer-tab ${t.id === currentTab ? 'active' : ''}" data-tab="${t.id}">
      ${t.icon} ${esc(t.label)}${n ? ` <span class="dim">${n}</span>` : ''}
      ${t.id === 'whatsapp' && counts.unread ? `<span class="badge-new">${counts.unread}</span>` : ''}
    </div>`;
  }).join('');
  box.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
  });
}

function switchTab(id) {
  currentTab = id;
  $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
  renderTab();
}

async function renderTab() {
  const previous = $('#lead-body');
  if (!previous) return;
  // Swap in a fresh node: each tab attaches its own delegated click handler, and
  // reusing the element would stack handlers from every tab visited before it.
  const body = previous.cloneNode(false);
  previous.replaceWith(body);
  body.innerHTML = skeleton(4);
  const fn = {
    overview: tabOverview, timeline: tabTimeline, whatsapp: (b) => tabChat('whatsapp', b),
    email: (b) => tabChat('email', b), calls: tabCalls, appointments: tabAppointments,
    tasks: tabTasks, notes: tabNotes, documents: tabDocuments, deals: tabDeals,
  }[currentTab] || tabOverview;
  await fn(body);
}

// -------------------------------------------------------------- overview ---
async function tabOverview(body) {
  const rows = [
    ['שם פרטי', lead.first_name, 'first_name'],
    ['שם משפחה', lead.last_name, 'last_name'],
    ['טלפון', lead.phone_pretty, 'phone'],
    ['WhatsApp', lead.whatsapp, 'whatsapp'],
    ['אימייל', lead.email, 'email'],
    ['עיר', lead.city, 'city'],
    ['שפה', { he: 'עברית', ar: 'ערבית', en: 'אנגלית' }[lead.language], 'language'],
    ['טיפול מבוקש', lead.treatments_he, 'treatments'],
    ['מקור הליד', lead.source, 'source'],
    ['קמפיין', lead.campaign_name, 'campaign_name'],
    ['מודעה', lead.ad_name, 'ad_name'],
    ['תאריך כניסה', fmtFull(lead.created_at), null],
    ['זמן תגובה ראשון', lead.response_time_min != null ? fmtMinutes(lead.response_time_min) : 'טרם נוצר קשר', null],
    ['הגיע למרפאה', lead.arrived_at ? fmtFull(lead.arrived_at) : '—', null],
  ];

  body.innerHTML = `
    <div class="stack">
      <div class="card card-pad">
        <div class="grid-2" style="gap:10px 16px">
          <div class="field" style="margin:0">
            <label>סטטוס</label>
            <select class="input" id="ov-status">
              ${store.statuses.map((s) => `<option value="${s.key}" ${s.key === lead.status_key ? 'selected' : ''}>${esc(s.name_he)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0">
            <label>עובד מטפל</label>
            <select class="input" id="ov-owner">
              <option value="">ללא</option>
              ${agents().map((u) => `<option value="${u.id}" ${u.id === lead.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="flex-wrap" style="margin-top:12px">
          <span class="tiny dim">דירוג:</span>
          ${['hot', 'warm', 'cold'].map((t) => `<span class="chip clickable ${lead.temperature === t ? 'active' : ''}"
            data-temp="${t}">${{ hot: '🔥 חם', warm: '🌤️ בינוני', cold: '❄️ קר' }[t]}</span>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>פרטים אישיים</h3>
          <button class="btn btn-sm" id="ov-edit">✎ עריכה</button></div>
        <div class="card-pad" style="padding-top:6px">
          ${rows.map(([label, value]) => `
            <div class="row-between" style="padding:7px 0;border-bottom:1px solid var(--border)">
              <span class="tiny dim">${esc(label)}</span>
              <span class="small bold" style="text-align:end;max-width:60%">${esc(value || '—')}</span>
            </div>`).join('')}
        </div>
      </div>

      ${lead.submissions.length ? `
      <div class="card">
        <div class="card-head"><h3>מקור וקמפיין (UTM)</h3>
          ${lead.submissions.length > 1 ? `<span class="chip">${lead.submissions.length} פניות</span>` : ''}</div>
        <div class="card-pad" style="padding-top:6px">
          ${['utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'ad_set', 'landing_page']
            .filter((k) => lead[k]).map((k) => `
            <div class="row-between" style="padding:6px 0"><span class="tiny dim">${k}</span>
              <span class="small">${esc(lead[k])}</span></div>`).join('') || '<div class="tiny dim">אין נתוני קמפיין</div>'}
          ${lead.submissions.length > 1 ? `<div class="tiny dim" style="margin-top:8px">
            פניות: ${lead.submissions.map((s) => `${fmtDate(s.created_at)} (${esc(s.source)})`).join(' · ')}</div>` : ''}
        </div>
      </div>` : ''}

      <div class="card card-pad">
        <div class="grid-3 center">
          <div><div class="tiny dim">שיחות</div><div class="bold" style="font-size:20px">${lead.counts.calls}</div></div>
          <div><div class="tiny dim">הודעות</div><div class="bold" style="font-size:20px">${lead.counts.whatsapp + lead.counts.emails}</div></div>
          <div><div class="tiny dim">תורים</div><div class="bold" style="font-size:20px">${lead.appointments.length}</div></div>
        </div>
      </div>

      <div class="flex-wrap">
        <button class="btn btn-sm" id="ov-dnc">${lead.do_not_contact ? '↩︎ בטל חסימת יצירת קשר' : '🚫 סמן: אין ליצור קשר'}</button>
        <button class="btn btn-sm btn-danger" id="ov-archive">🗄️ העבר לארכיון</button>
      </div>
    </div>`;

  $('#ov-status', body).addEventListener('change', async (e) => {
    try {
      lead = await api.post(`/api/leads/${lead.id}/status`, { status_key: e.target.value });
      toast('הסטטוס עודכן', 'ok');
      renderHead();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#ov-owner', body).addEventListener('change', async (e) => {
    lead = await api.post(`/api/leads/${lead.id}/assign`, { user_id: e.target.value || null });
    toast('הליד הועבר', 'ok');
  });
  body.addEventListener('click', async (e) => {
    const temp = e.target.closest('[data-temp]');
    if (temp) {
      await api.post(`/api/leads/${lead.id}/temperature`, { temperature: temp.dataset.temp });
      lead.temperature = temp.dataset.temp;
      renderHead();
      renderTab();
    }
  });
  $('#ov-edit', body).addEventListener('click', editLeadModal);
  $('#ov-dnc', body).addEventListener('click', async () => {
    await api.patch(`/api/leads/${lead.id}`, { do_not_contact: !lead.do_not_contact });
    await reload();
  });
  $('#ov-archive', body).addEventListener('click', async () => {
    if (!(await confirmDialog('להעביר את הליד לארכיון?', { danger: true }))) return;
    await api.del(`/api/leads/${lead.id}`);
    toast('הליד הועבר לארכיון', 'ok');
    closePanel();
  });
}

async function editLeadModal() {
  const data = await formModal({
    title: 'עריכת פרטי לקוח',
    wide: true,
    fields: [
      { name: 'first_name', label: 'שם פרטי', value: lead.first_name },
      { name: 'last_name', label: 'שם משפחה', value: lead.last_name },
      { name: 'phone', label: 'טלפון', value: lead.phone_pretty },
      { name: 'whatsapp', label: 'WhatsApp', value: lead.whatsapp },
      { name: 'email', label: 'אימייל', type: 'email', value: lead.email },
      { name: 'city', label: 'עיר', value: lead.city },
      {
        name: 'language', label: 'שפה', type: 'select', value: lead.language,
        options: [{ value: 'he', label: 'עברית' }, { value: 'ar', label: 'ערבית' }, { value: 'en', label: 'אנגלית' }],
      },
      {
        name: 'treatment_ids', label: 'טיפול מבוקש', type: 'multiselect', value: lead.treatment_ids,
        options: store.treatments.map((t) => ({ value: t.id, label: t.name_he })),
      },
      { name: 'campaign_name', label: 'קמפיין', value: lead.campaign_name },
      { name: 'ad_name', label: 'מודעה', value: lead.ad_name },
    ],
  });
  if (!data) return;
  data.treatment_ids = (data.treatment_ids || []).map(Number);
  try {
    lead = await api.patch(`/api/leads/${lead.id}`, data);
    toast('הפרטים נשמרו', 'ok');
    renderHead();
    renderTab();
  } catch (err) { toast(err.message, 'err'); }
}

// -------------------------------------------------------------- timeline ---
const TL_ICON = {
  lead_created: '🎯', status: '🔄', call: '📞', whatsapp: '💬', email: '✉️', sms: '📱',
  email_open: '👁️', email_click: '🔗', note: '📝', task: '⏰', appointment: '📅',
  assign: '👤', document: '📎', automation: '⚡', payment: '💰',
  location: '📍', clinic_card: '💳', clinic_info: '📲', appointment_info: '📅',
};

async function tabTimeline(body) {
  const events = await api.get(`/api/leads/${lead.id}/timeline`);
  if (!events.length) { body.innerHTML = empty('אין עדיין היסטוריה', '🕐'); return; }
  body.innerHTML = `<div class="card card-pad"><div class="timeline">
    ${events.map((e) => `
      <div class="tl-item">
        <div class="tl-dot">${TL_ICON[e.type] || '•'}</div>
        <div class="tl-title">${esc(e.title)}</div>
        <div class="tl-meta">${fmtDateTime(e.created_at)} · ${fmtRelative(e.created_at)}
          ${e.actor_name ? ` · ${esc(e.actor_name)}` : ''}</div>
        ${e.body ? `<div class="tl-body">${esc(e.body)}</div>` : ''}
      </div>`).join('')}
  </div></div>`;
}

// ------------------------------------------------------------------ chat ---
async function tabChat(channel, body) {
  const [messages, allTemplates] = await Promise.all([
    api.get(`/api/leads/${lead.id}/messages`, { channel }),
    api.get('/api/templates', { channel }),
  ]);
  // Templates in the customer's own language first (spec: he + ar side by side)
  const templates = allTemplates
    .filter((t) => t.active)
    .sort((a, b) => (a.lang === lead.language ? -1 : 0) - (b.lang === lead.language ? -1 : 0));
  const isEmail = channel === 'email';

  body.innerHTML = `
    <div class="stack">
      ${isEmail ? '' : `<div class="tiny dim">💬 ${esc(lead.whatsapp || lead.phone_pretty || '')}</div>`}
      ${isEmail && !lead.email ? '<div class="chip" style="background:var(--amber-soft)">ללא כתובת מייל — עדכן בכרטיס הלקוח</div>' : ''}
      <div class="chat-wrap" id="chat-scroll">
        ${messages.length ? `<div class="chat">${messages.map((m) => bubble(m, isEmail)).join('')}</div>`
          : empty(isEmail ? 'לא נשלחו מיילים' : 'אין עדיין שיחת וואטסאפ', isEmail ? '✉️' : '💬')}
      </div>

      ${templates.length ? `<div>
        <div class="tiny dim mb">תבניות מוכנות:</div>
        <div class="flex-wrap">${templates.map((t) => `
          <span class="chip clickable" data-tpl="${t.id}">${t.lang === 'ar' ? '🇸🇦' : t.lang === 'en' ? '🇬🇧' : '🇮🇱'} ${esc(t.name)}</span>`).join('')}</div>
      </div>` : ''}

      ${isEmail ? `
        <div class="field"><label>נושא</label><input class="input" id="mail-subject" placeholder="נושא ההודעה"></div>
        <div class="field"><label>תוכן</label><textarea class="input" id="mail-body" rows="6"></textarea></div>
        <button class="btn btn-primary btn-block" id="send-mail" ${lead.email ? '' : 'disabled'}>✉️ שלח מייל</button>
      ` : `
        <div class="composer">
          <textarea class="input" id="wa-body" rows="2" placeholder="כתוב הודעה..."></textarea>
          <button class="btn btn-wa" id="send-wa">שלח</button>
        </div>
        <div class="flex-wrap tiny">
          <button class="btn btn-sm btn-ghost" data-quick-tpl="location">📍 מיקום</button>
          <button class="btn btn-sm btn-ghost" data-quick-tpl="hours">🕐 שעות פעילות</button>
          <button class="btn btn-sm btn-ghost" id="sim-reply">🧪 סימולציית תשובת לקוח</button>
        </div>`}
    </div>`;

  const scroll = $('#chat-scroll', body);
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  body.addEventListener('click', async (e) => {
    const tplChip = e.target.closest('[data-tpl]');
    if (tplChip) {
      const rendered = await api.get(`/api/leads/${lead.id}/template/${tplChip.dataset.tpl}`);
      if (isEmail) {
        $('#mail-subject', body).value = rendered.subject || '';
        $('#mail-body', body).value = rendered.body;
      } else {
        $('#wa-body', body).value = rendered.body;
      }
      return;
    }
    const quick = e.target.closest('[data-quick-tpl]');
    if (quick) {
      const clinic = store.settings.clinic || {};
      const text = quick.dataset.quickTpl === 'location'
        ? `הכתובת שלנו: ${clinic.address || ''} — ${clinic.name || ''}`
        : 'שעות הפעילות שלנו: א׳–ה׳ 09:00–19:00, ו׳ 09:00–13:00';
      $('#wa-body', body).value = text;
    }
  });

  $('#send-wa', body)?.addEventListener('click', async () => {
    const text = $('#wa-body', body).value.trim();
    if (!text) return;
    try {
      await api.post(`/api/leads/${lead.id}/whatsapp`, { body: text });
      toast('ההודעה נשלחה', 'ok');
      await reload();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#wa-body', body)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#send-wa', body).click();
  });
  $('#send-mail', body)?.addEventListener('click', async () => {
    const subject = $('#mail-subject', body).value.trim();
    const text = $('#mail-body', body).value.trim();
    if (!text) return toast('תוכן ההודעה ריק', 'err');
    try {
      await api.post(`/api/leads/${lead.id}/email`, { subject, body: text });
      toast('המייל נשלח', 'ok');
      await reload();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#sim-reply', body)?.addEventListener('click', async () => {
    const data = await formModal({
      title: 'סימולציית תשובת לקוח',
      fields: [{ name: 'body', label: 'תוכן ההודעה הנכנסת', type: 'textarea', value: 'שלום, אני יכול להגיע ביום חמישי?' }],
      submitText: 'קבל הודעה',
    });
    if (!data) return;
    await api.post(`/api/leads/${lead.id}/simulate-reply`, { channel: 'whatsapp', body: data.body });
    await reload();
  });
}

function bubble(m, isEmail) {
  const status = { sent: '✓', delivered: '✓✓', read: '✓✓', opened: '👁️', clicked: '🔗', failed: '⚠️' }[m.status] || '';
  return `<div class="bubble ${m.direction}">
    ${isEmail && m.subject ? `<div class="bold" style="margin-bottom:4px">${esc(m.subject)}</div>` : ''}
    ${esc(m.body)}
    <div class="time">${fmtDateTime(m.created_at)} ${m.direction === 'out' ? status : ''}
      ${m.opens ? ` · נפתח ×${m.opens}` : ''}${m.clicks ? ` · לחיצות ${m.clicks}` : ''}</div>
  </div>`;
}

// ----------------------------------------------------------------- calls ---
async function tabCalls(body) {
  const calls = await api.get(`/api/leads/${lead.id}/calls`);
  body.innerHTML = `
    <div class="stack">
      <button class="btn btn-primary btn-block" id="new-call">📝 תיעוד שיחה חדשה</button>
      ${calls.length ? calls.map((c) => {
        const ai = c.ai_summary ? JSON.parse(c.ai_summary) : null;
        return `<div class="card card-pad">
          <div class="row-between">
            <div class="flex">
              <span style="font-size:18px">${c.outcome === 'answered' ? '✅' : c.outcome === 'no_answer' ? '📵' : '📞'}</span>
              <div>
                <div class="bold small">${esc(OUTCOME_LABEL[c.outcome] || c.outcome)}</div>
                <div class="tiny dim">${fmtDateTime(c.created_at)} · ${esc(c.user_name || '')}
                  ${c.duration_sec ? ` · ${fmtDuration(c.duration_sec)}` : ''}</div>
              </div>
            </div>
            ${c.recording_url ? `<a class="btn btn-sm" href="${esc(c.recording_url)}" target="_blank">▶️ האזן</a>` : ''}
          </div>
          ${c.summary ? `<div class="tl-body" style="margin-top:8px">${esc(c.summary)}</div>` : ''}
          ${ai ? `<div class="flex" style="margin-top:8px;background:var(--purple-soft);padding:8px 10px;border-radius:9px">
            <span>🤖</span><div class="tiny"><b>סיכום AI:</b> ${esc(ai.summary)}<br>
            <b>המשך מומלץ:</b> ${esc(ai.next_action)}</div></div>` : ''}
        </div>`;
      }).join('') : empty('לא תועדו שיחות', '📞')}
    </div>`;
  $('#new-call', body).addEventListener('click', logCallModal);
}

async function logCallModal() {
  const data = await formModal({
    title: '📞 תיעוד שיחה',
    submitText: 'שמור שיחה',
    fields: [
      {
        name: 'outcome', label: 'תוצאת השיחה', type: 'select', required: true,
        options: Object.entries(OUTCOME_LABEL).map(([value, label]) => ({ value, label })),
      },
      { name: 'duration_sec', label: 'משך (שניות)', type: 'number', value: 0 },
      {
        name: 'summary', label: 'סיכום שיחה', type: 'textarea', rows: 4,
        placeholder: 'לדוגמה: הלקוח מעוניין בשתי השתלות, ביקש לדבר עם אשתו ולחזור אליו ביום חמישי.',
      },
      { name: 'recording_url', label: 'קישור להקלטה (אופציונלי)', placeholder: 'https://...' },
      { name: 'follow_up_at', label: 'קביעת חזרה', type: 'datetime-local' },
    ],
  });
  if (!data) return;
  try {
    const res = await api.post(`/api/leads/${lead.id}/calls`, {
      outcome: data.outcome,
      duration_sec: Number(data.duration_sec || 0),
      summary: data.summary || null,
      recording_url: data.recording_url || null,
      follow_up_at: data.follow_up_at ? fromLocalInput(data.follow_up_at) : null,
    });
    toast('השיחה תועדה', 'ok');
    if (res.ai?.summary) {
      modal({
        title: '🤖 סיכום AI',
        body: `<p class="mb">${esc(res.ai.summary)}</p>
               <div class="chip">המשך מומלץ: ${esc(res.ai.next_action)}</div>`,
        footer: '<button class="btn btn-primary" data-close>הבנתי</button>',
      });
    }
    await reload();
  } catch (err) { toast(err.message, 'err'); }
}

// ---------------------------------------------------------- appointments ---
async function tabAppointments(body) {
  body.innerHTML = `
    <div class="stack">
      <button class="btn btn-primary btn-block" id="new-appt">📅 קביעת תור</button>
      ${lead.appointments.length ? lead.appointments.map((a) => `
        <div class="card card-pad">
          <div class="row-between">
            <div>
              <div class="bold">${esc(a.treatment_he || 'תור')}</div>
              <div class="small muted">${fmtFull(a.start_at)}</div>
              <div class="tiny dim">${esc(a.doctor_name || '')} ${a.branch ? `· ${esc(a.branch)}` : ''}</div>
            </div>
            <span class="chip" style="background:${APPT_STATUS_COLOR[a.status]}22;color:${APPT_STATUS_COLOR[a.status]};border-color:transparent">
              ${esc(APPT_STATUS_LABEL[a.status] || a.status)}</span>
          </div>
          ${a.notes ? `<div class="tl-body" style="margin-top:8px">${esc(a.notes)}</div>` : ''}
          <!-- §8 — the same sends available directly next to the appointment -->
          <div class="flex-wrap" style="margin-top:10px">
            <button class="btn btn-sm btn-wa" data-confirm-send="${a.id}">💬 שלח אישור</button>
            <button class="btn btn-sm" data-send="appointment" data-appt-id="${a.id}">📅 תזכורת + פרטי פגישה</button>
            <button class="btn btn-sm" data-send="location" data-appt-id="${a.id}">📍 שליחת מיקום</button>
            <button class="btn btn-sm" data-send="card" data-appt-id="${a.id}">💳 כרטיס המרפאה</button>
            <a class="btn btn-sm btn-ghost" href="/confirm/${esc(a.confirm_token)}" target="_blank">🔗 קישור אישור</a>
          </div>
          <div class="flex-wrap" style="margin-top:8px">
            ${['confirmed', 'arrived', 'no_show', 'cancelled', 'done']
              .filter((s) => s !== a.status)
              .map((s) => `<button class="btn btn-sm btn-ghost" data-appt="${a.id}" data-status="${s}">${esc(APPT_STATUS_LABEL[s])}</button>`).join('')}
          </div>
        </div>`).join('') : empty('לא נקבעו תורים', '📅')}
    </div>`;

  $('#new-appt', body).addEventListener('click', appointmentModal);
  body.addEventListener('click', async (e) => {
    const send = e.target.closest('[data-send]');
    if (send) {
      openClinicSend(lead.id, send.dataset.send, {
        lead,
        appointmentId: Number(send.dataset.apptId),
        onSent: () => reload(),
      });
      return;
    }
    const btn = e.target.closest('[data-appt]');
    if (btn) {
      await api.patch(`/api/appointments/${btn.dataset.appt}`, { status: btn.dataset.status });
      toast('סטטוס התור עודכן', 'ok');
      await reload();
      return;
    }
    const confirmSend = e.target.closest('[data-confirm-send]');
    if (confirmSend) {
      await api.post(`/api/leads/${lead.id}/whatsapp`, { template_key: 'appointment_confirm' });
      toast('הודעת אישור נשלחה', 'ok');
      await reload();
    }
  });
}

async function appointmentModal() {
  const data = await formModal({
    title: '📅 קביעת תור',
    submitText: 'קבע תור',
    fields: [
      { name: 'start_at', label: 'תאריך ושעה', type: 'datetime-local', required: true, value: toLocalInput(nextSlot()) },
      { name: 'duration_min', label: 'משך (דקות)', type: 'number', value: 45 },
      {
        name: 'treatment_id', label: 'טיפול', type: 'select',
        value: lead.treatment_ids[0] || '',
        options: [{ value: '', label: '—' }, ...store.treatments.map((t) => ({ value: t.id, label: t.name_he }))],
      },
      {
        name: 'doctor_id', label: 'רופא', type: 'select',
        options: [{ value: '', label: '—' }, ...doctors().map((d) => ({ value: d.id, label: d.name }))],
      },
      {
        name: 'branch', label: 'סניף', type: 'select',
        options: (store.settings.clinic?.branches || ['ראשי']).map((b) => ({ value: b, label: b })),
      },
      { name: 'notes', label: 'הערות', type: 'textarea', rows: 2 },
    ],
  });
  if (!data) return;
  try {
    await api.post('/api/appointments', {
      lead_id: lead.id,
      start_at: fromLocalInput(data.start_at),
      duration_min: Number(data.duration_min || 45),
      treatment_id: data.treatment_id ? Number(data.treatment_id) : null,
      doctor_id: data.doctor_id ? Number(data.doctor_id) : null,
      branch: data.branch,
      notes: data.notes,
    });
    toast('התור נקבע ואישור נשלח ללקוח', 'ok');
    await reload();
  } catch (err) { toast(err.message, 'err'); }
}

function nextSlot() {
  const d = new Date(Date.now() + 86400000);
  d.setHours(10, 0, 0, 0);
  return d;
}

async function markArrived() {
  await api.post(`/api/leads/${lead.id}/status`, { status_key: 'arrived' });
  toast('הלקוח סומן כהגיע למרפאה ✓', 'ok');
  await reload();
}

// ----------------------------------------------------------------- tasks ---
async function tabTasks(body) {
  body.innerHTML = `
    <div class="stack">
      <button class="btn btn-primary btn-block" id="new-task">⏰ קביעת חזרה / משימה</button>
      <div class="flex-wrap">
        ${[['היום', 0], ['בעוד שעה', 60], ['בעוד 3 שעות', 180], ['מחר 10:00', 'tomorrow']]
          .map(([label, v]) => `<span class="chip clickable" data-quick-task="${v}">${label}</span>`).join('')}
      </div>
      ${lead.tasks.length ? lead.tasks.map((t) => `
        <div class="card card-pad ${t.done_at ? 'muted' : ''}">
          <div class="row-between">
            <div style="min-width:0">
              <div class="bold small ${t.done_at ? 'dim' : ''}" style="${t.done_at ? 'text-decoration:line-through' : ''}">
                ${esc(t.title)}</div>
              <div class="tiny ${!t.done_at && new Date(t.due_at) < new Date() ? '' : 'dim'}"
                   style="${!t.done_at && new Date(t.due_at) < new Date() ? 'color:var(--red);font-weight:700' : ''}">
                ${fmtDateTime(t.due_at)} · ${esc(t.user_name || '')}
                ${t.priority === 'urgent' ? ' · 🚨 דחוף' : ''}</div>
              ${t.note ? `<div class="tiny muted" style="margin-top:4px">${esc(t.note)}</div>` : ''}
            </div>
            <div class="flex">
              ${t.done_at ? '<span class="chip">בוצע ✓</span>' : `
                <button class="btn btn-sm" data-snooze="${t.id}">דחה 15ד׳</button>
                <button class="btn btn-sm btn-primary" data-done="${t.id}">בוצע ✓</button>`}
            </div>
          </div>
        </div>`).join('') : empty('אין משימות', '✅')}
    </div>`;

  $('#new-task', body).addEventListener('click', taskModal);
  body.addEventListener('click', async (e) => {
    const q = e.target.closest('[data-quick-task]');
    if (q) {
      const v = q.dataset.quickTask;
      let due = new Date();
      if (v === 'tomorrow') { due.setDate(due.getDate() + 1); due.setHours(10, 0, 0, 0); }
      else due = new Date(Date.now() + Number(v) * 60000);
      await api.post('/api/tasks', { lead_id: lead.id, title: 'חזרה ללקוח', due_at: due.toISOString() });
      toast('משימת חזרה נקבעה', 'ok');
      await reload();
      return;
    }
    const done = e.target.closest('[data-done]');
    if (done) { await api.patch(`/api/tasks/${done.dataset.done}`, { done: true }); await reload(); return; }
    const snooze = e.target.closest('[data-snooze]');
    if (snooze) { await api.patch(`/api/tasks/${snooze.dataset.snooze}`, { snooze_min: 15 }); await reload(); }
  });
}

async function taskModal() {
  const data = await formModal({
    title: '⏰ קביעת חזרה',
    fields: [
      { name: 'title', label: 'כותרת', value: 'חזרה ללקוח', required: true },
      { name: 'due_at', label: 'מועד', type: 'datetime-local', required: true, value: toLocalInput(new Date(Date.now() + 3600000)) },
      {
        name: 'priority', label: 'עדיפות', type: 'select', value: 'normal',
        options: [{ value: 'low', label: 'נמוכה' }, { value: 'normal', label: 'רגילה' }, { value: 'urgent', label: 'דחוף' }],
      },
      {
        name: 'user_id', label: 'אחראי', type: 'select', value: lead.owner_id || '',
        options: agents().map((u) => ({ value: u.id, label: u.name })),
      },
      { name: 'note', label: 'הערה', type: 'textarea', rows: 2, placeholder: 'להציע תור עם הרופא.' },
    ],
  });
  if (!data) return;
  await api.post('/api/tasks', {
    lead_id: lead.id,
    title: data.title,
    due_at: fromLocalInput(data.due_at),
    priority: data.priority,
    user_id: Number(data.user_id) || undefined,
    note: data.note,
  });
  toast('המשימה נקבעה', 'ok');
  await reload();
}

// ----------------------------------------------------------------- notes ---
async function tabNotes(body) {
  const events = await api.get(`/api/leads/${lead.id}/timeline`, { limit: 200 });
  const notes = events.filter((e) => e.type === 'note');
  body.innerHTML = `
    <div class="stack">
      <div class="card card-pad">
        <div class="field" style="margin:0">
          <label>הערה פנימית (אינה נשלחת ללקוח) — אפשר לתייג עם @שם</label>
          <textarea class="input" id="note-body" rows="3" placeholder="לדוגמה: הלקוח דובר ערבית בלבד. @רנא נא לחזור לפני 15:00"></textarea>
        </div>
        <div class="flex-wrap" style="margin-top:8px">
          ${store.users.filter((u) => u.active).slice(0, 6).map((u) => `
            <span class="chip clickable" data-mention="${esc(u.name.split(' ')[0])}">@${esc(u.name)}</span>`).join('')}
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" id="add-note">הוסף הערה</button>
        </div>
      </div>
      ${notes.length ? notes.map((n) => `
        <div class="card card-pad">
          <div class="flex" style="align-items:flex-start">
            ${avatar(n.actor_name || 'מערכת', n.actor_color, 'sm')}
            <div style="flex:1;min-width:0">
              <div class="tiny dim">${esc(n.actor_name || 'מערכת')} · ${fmtDateTime(n.created_at)}</div>
              <div class="small" style="white-space:pre-wrap;margin-top:3px">${highlightMentions(n.body || n.title)}</div>
            </div>
          </div>
        </div>`).join('') : empty('אין הערות', '📝')}
    </div>`;

  body.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mention]');
    if (m) {
      const ta = $('#note-body', body);
      ta.value = `${ta.value}${ta.value ? ' ' : ''}@${m.dataset.mention} `;
      ta.focus();
    }
  });
  $('#add-note', body).addEventListener('click', async () => {
    const text = $('#note-body', body).value.trim();
    if (!text) return;
    const res = await api.post(`/api/leads/${lead.id}/notes`, { body: text });
    toast(res.mentioned?.length ? `נוספה הערה ונשלחה התראה ל-${res.mentioned.length} עובדים` : 'ההערה נוספה', 'ok');
    renderTab();
  });
}

const highlightMentions = (text) =>
  esc(text).replace(/@([\p{L}\w'-]+)/gu, '<b style="color:var(--brand)">@$1</b>');

// ------------------------------------------------------------- documents ---
async function tabDocuments(body) {
  body.innerHTML = `
    <div class="stack">
      <div class="drop-zone" id="drop">📎 גרור קבצים לכאן או לחץ להעלאה<br>
        <span class="tiny">PDF, צילומים, הצעות מחיר, טפסים</span></div>
      <input type="file" id="file-input" multiple hidden>
      ${lead.documents.length ? lead.documents.map((d) => `
        <div class="doc-item">
          <span style="font-size:20px">${d.mime?.startsWith('image/') ? '🖼️' : d.mime?.includes('pdf') ? '📕' : '📄'}</span>
          <div style="flex:1;min-width:0">
            <div class="small bold truncate">${esc(d.name)}</div>
            <div class="tiny dim">${(d.size / 1024).toFixed(0)} KB · ${fmtDate(d.created_at)}</div>
          </div>
          <a class="btn btn-sm" href="${esc(d.url)}" target="_blank">פתח</a>
          <button class="btn btn-sm btn-ghost" data-del-doc="${d.id}">🗑</button>
        </div>`).join('') : empty('אין מסמכים', '📎')}
    </div>`;

  const input = $('#file-input', body);
  const drop = $('#drop', body);
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    upload(e.dataTransfer.files);
  });
  input.addEventListener('change', () => upload(input.files));
  body.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-doc]');
    if (del && (await confirmDialog('למחוק את המסמך?', { danger: true }))) {
      await api.del(`/api/documents/${del.dataset.delDoc}`);
      await reload();
    }
  });

  async function upload(files) {
    if (!files?.length) return;
    const fd = new FormData();
    [...files].forEach((f) => fd.append('file', f));
    try {
      await api.upload(`/api/leads/${lead.id}/documents`, fd);
      toast('הקבצים הועלו', 'ok');
      await reload();
    } catch (err) { toast(err.message, 'err'); }
  }
}

// ----------------------------------------------------------------- deals ---
async function tabDeals(body) {
  const total = lead.deals.reduce((s, d) => s + (d.amount || 0), 0);
  const paid = lead.deals.reduce((s, d) => s + (d.paid || 0), 0);
  body.innerHTML = `
    <div class="stack">
      <div class="card card-pad">
        <div class="grid-3 center">
          <div><div class="tiny dim">סה״כ עסקאות</div><div class="bold" style="font-size:19px">${fmtMoney(total)}</div></div>
          <div><div class="tiny dim">שולם</div><div class="bold" style="font-size:19px;color:var(--green)">${fmtMoney(paid)}</div></div>
          <div><div class="tiny dim">יתרה</div><div class="bold" style="font-size:19px;color:var(--amber)">${fmtMoney(total - paid)}</div></div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" id="new-deal">💰 הוספת עסקה</button>
      ${lead.deals.map((d) => `
        <div class="card card-pad">
          <div class="row-between">
            <div>
              <div class="bold">${esc(d.title || d.treatment_he || 'עסקה')}</div>
              <div class="tiny dim">${esc(DEAL_STAGE_LABEL[d.stage] || d.stage)} · ${fmtDate(d.created_at)}</div>
            </div>
            <div style="text-align:end">
              <div class="bold">${fmtMoney(d.amount, d.currency)}</div>
              <div class="tiny" style="color:var(--green)">שולם ${fmtMoney(d.paid, d.currency)}</div>
              ${d.balance > 0 ? `<div class="tiny" style="color:var(--amber)">יתרה ${fmtMoney(d.balance, d.currency)}</div>` : ''}
            </div>
          </div>
          <div class="bar-track" style="margin-top:8px">
            <div class="bar-fill" style="width:${d.amount ? Math.min(100, (d.paid / d.amount) * 100) : 0}%;background:var(--green)"></div>
          </div>
          <div class="flex-wrap" style="margin-top:9px">
            <button class="btn btn-sm" data-pay="${d.id}">＋ תשלום</button>
            <button class="btn btn-sm btn-ghost" data-del-deal="${d.id}">🗑</button>
          </div>
        </div>`).join('') || empty('אין עסקאות', '💰')}
    </div>`;

  $('#new-deal', body).addEventListener('click', async () => {
    const data = await formModal({
      title: '💰 עסקה חדשה',
      fields: [
        {
          name: 'treatment_id', label: 'טיפול', type: 'select', value: lead.treatment_ids[0] || '',
          options: [{ value: '', label: '—' }, ...store.treatments.map((t) => ({ value: t.id, label: `${t.name_he} (${fmtMoney(t.price)})` }))],
        },
        { name: 'amount', label: 'סכום העסקה', type: 'number', required: true, value: 0 },
        { name: 'paid', label: 'שולם כעת', type: 'number', value: 0 },
        {
          name: 'stage', label: 'שלב', type: 'select', value: 'quoted',
          options: Object.entries(DEAL_STAGE_LABEL).map(([value, label]) => ({ value, label })),
        },
      ],
    });
    if (!data) return;
    await api.post(`/api/leads/${lead.id}/deals`, {
      treatment_id: data.treatment_id ? Number(data.treatment_id) : null,
      amount: Number(data.amount), paid: Number(data.paid || 0), stage: data.stage,
    });
    toast('העסקה נוספה', 'ok');
    await reload();
  });

  body.addEventListener('click', async (e) => {
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      const data = await formModal({
        title: 'רישום תשלום',
        fields: [{ name: 'amount', label: 'סכום', type: 'number', required: true },
          { name: 'method', label: 'אמצעי תשלום', value: 'מזומן' }],
      });
      if (!data) return;
      await api.patch(`/api/deals/${pay.dataset.pay}`, { add_payment: Number(data.amount), method: data.method });
      toast('התשלום נרשם', 'ok');
      await reload();
      return;
    }
    const del = e.target.closest('[data-del-deal]');
    if (del && (await confirmDialog('למחוק את העסקה?', { danger: true }))) {
      await api.del(`/api/deals/${del.dataset.delDeal}`);
      await reload();
    }
  });
}
