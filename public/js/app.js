// App shell: auth gate, layout, routing, global search, notification centre.
import { api, ApiError } from './api.js';
import { store, loadBootstrap, emitChange } from './store.js';
import { t, lang, setLang } from './i18n.js';
import {
  $, $$, el, esc, toast, avatar, initials, fmtRelative, skeleton, tempChip,
} from './ui.js';
import { openLead } from './views/leadPanel.js';

const routes = {
  dashboard: () => import('./views/dashboard.js'),
  leads: () => import('./views/leads.js'),
  inbox: () => import('./views/inbox.js'),
  calendar: () => import('./views/calendar.js'),
  appointments: () => import('./views/appointments.js'),
  tasks: () => import('./views/tasks.js'),
  reports: () => import('./views/reports.js'),
  campaigns: () => import('./views/campaigns.js'),
  team: () => import('./views/team.js'),
  automation: () => import('./views/automation.js'),
  templates: () => import('./views/templates.js'),
  settings: () => import('./views/settings.js'),
  ai: () => import('./views/ai.js'),
};

const NAV = [
  { group: 'עבודה יומית' },
  { id: 'dashboard', icon: '📊', label: 'dashboard' },
  { id: 'leads', icon: '🎯', label: 'leads' },
  { id: 'inbox', icon: '💬', label: 'inbox', badge: 'inbox' },
  { id: 'tasks', icon: '✅', label: 'tasks', badge: 'tasks' },
  { id: 'calendar', icon: '📅', label: 'calendar' },
  { id: 'appointments', icon: '🦷', label: 'appointments' },
  { group: 'ניהול' },
  { id: 'reports', icon: '📈', label: 'reports', perm: 'reports' },
  { id: 'campaigns', icon: '📣', label: 'campaigns', perm: 'reports' },
  { id: 'team', icon: '👥', label: 'team', perm: 'team' },
  { id: 'automation', icon: '⚡', label: 'automation', perm: 'automations' },
  { id: 'templates', icon: '📝', label: 'templates' },
  { id: 'ai', icon: '🤖', label: 'ai' },
  { id: 'settings', icon: '⚙️', label: 'settings', perm: 'admin' },
];

const MOBILE_NAV = [
  { id: 'dashboard', icon: '📊', label: 'בית' },
  { id: 'leads', icon: '🎯', label: 'לידים' },
  { id: 'inbox', icon: '💬', label: 'הודעות', badge: 'inbox' },
  { id: 'calendar', icon: '📅', label: 'יומן' },
  { id: 'more', icon: '☰', label: 'עוד' },
];

let currentRoute = null;
let currentCleanup = null;

// ---------------------------------------------------------------- theme ---
function applyTheme(theme) {
  const next = theme || localStorage.getItem('crm_theme') ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = next;
  localStorage.setItem('crm_theme', next);
}
applyTheme();

// ----------------------------------------------------------------- boot ---
async function boot() {
  try {
    await loadBootstrap();
    renderLayout();
    window.addEventListener('hashchange', handleRoute);
    handleRoute();
    startPolling();
    requestPushPermission();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) renderLogin();
    else {
      document.getElementById('app').innerHTML =
        `<div class="empty"><div class="ico">⚠️</div><div>שגיאת טעינה: ${esc(err.message)}</div></div>`;
    }
  }
}

// ---------------------------------------------------------------- login ---
function renderLogin(message = '') {
  const app = document.getElementById('app');
  app.className = '';
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="flex" style="margin-bottom:16px">
          <div class="brand-logo" style="width:44px;height:44px;font-size:22px">🦷</div>
          <div><h1>CRM מרפאה</h1><div class="sub">ניהול לידים, תורים ותקשורת במקום אחד</div></div>
        </div>
        <form id="login-form">
          <div class="field"><label>אימייל</label>
            <input class="input" name="email" type="email" required autocomplete="username" value="admin@clinic.local"></div>
          <div class="field"><label>סיסמה</label>
            <input class="input" name="password" type="password" required autocomplete="current-password" value=""></div>
          <div id="login-err" class="tiny" style="color:var(--red);min-height:18px">${esc(message)}</div>
          <button class="btn btn-primary btn-block" style="margin-top:8px" type="submit">כניסה</button>
        </form>
        <div class="login-hint">חשבון דמו: admin@clinic.local · סיסמה 123456</div>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(e.target));
      await api.post('/api/auth/login', data);
      await boot();
    } catch (err) {
      $('#login-err').textContent = err.message || 'שגיאה';
      btn.disabled = false;
    }
  });
}

// --------------------------------------------------------------- layout ---
function renderLayout() {
  const app = document.getElementById('app');
  app.className = '';
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo">🦷</div>
          <div>
            <div class="brand-name">${esc(store.settings?.clinic?.name || 'CRM מרפאה')}</div>
            <div class="brand-sub">Leads & Patients CRM</div>
          </div>
        </div>
        <nav class="nav" id="nav"></nav>
        <div class="sidebar-foot">
          <div class="user-chip" id="user-chip">
            ${avatar(store.user.name, store.user.color)}
            <div style="min-width:0">
              <div class="small bold truncate">${esc(store.user.name)}</div>
              <div class="tiny dim">${esc(roleLabel(store.user.role))}</div>
            </div>
            <div class="spacer"></div>
            <span class="dim">⋯</span>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h2 id="page-title">${t('dashboard')}</h2>
          <div class="search-box">
            <span class="ico">🔍</span>
            <input id="global-search" placeholder="${t('search')}" autocomplete="off">
            <div id="search-results" class="search-results" hidden></div>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-primary btn-sm" id="btn-new-lead">＋ <span class="hide-sm">${t('new_lead')}</span></button>
          <button class="btn btn-ghost btn-icon" id="btn-theme" title="מצב תצוגה">🌓</button>
          <button class="btn btn-ghost btn-icon" id="btn-bell" title="התראות" style="position:relative">
            🔔<span id="bell-badge" class="nav-badge" style="position:absolute;top:-2px;inset-inline-end:-2px;display:none"></span>
          </button>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>
    <nav class="mobile-nav" id="mobile-nav"></nav>`;

  renderNav();
  renderMobileNav();

  $('#btn-theme').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#btn-new-lead').addEventListener('click', () => newLeadModal());
  $('#btn-bell').addEventListener('click', toggleNotifications);
  $('#user-chip').addEventListener('click', userMenu);
  wireGlobalSearch();

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#global-search').focus(); }
  });
}

const roleLabel = (r) => ({ admin: 'מנהל מערכת', manager: 'מנהל', agent: 'נציג', reception: 'קבלה', doctor: 'רופא' }[r] || r);

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = NAV.map((item) => {
    if (item.group) return `<div class="nav-group">${esc(item.group)}</div>`;
    if (item.perm && !store.permissions[item.perm]) return '';
    return `<div class="nav-item" data-route="${item.id}">
      <span class="ico">${item.icon}</span><span>${t(item.label)}</span>
      ${item.badge ? `<span class="nav-badge" data-badge="${item.badge}" hidden></span>` : ''}
    </div>`;
  }).join('');
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('[data-route]');
    if (item) location.hash = `#/${item.dataset.route}`;
  });
}

function renderMobileNav() {
  const nav = $('#mobile-nav');
  if (!nav) return;
  nav.innerHTML = MOBILE_NAV.map((i) => `
    <div class="item" data-route="${i.id}">
      <span class="ico">${i.icon}</span><span>${esc(i.label)}</span>
      ${i.badge ? `<span class="dot" data-dot="${i.badge}" hidden></span>` : ''}
    </div>`).join('');
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('[data-route]');
    if (!item) return;
    if (item.dataset.route === 'more') moreMenu();
    else location.hash = `#/${item.dataset.route}`;
  });
}

function moreMenu() {
  import('./ui.js').then(({ modal }) => {
    modal({
      title: 'תפריט',
      body: `<div class="stack">${NAV.filter((n) => n.id && !(n.perm && !store.permissions[n.perm]))
        .map((n) => `<div class="nav-item" data-route="${n.id}"><span class="ico">${n.icon}</span>${t(n.label)}</div>`)
        .join('')}</div>`,
      onMount(root, close) {
        root.addEventListener('click', (e) => {
          const it = e.target.closest('[data-route]');
          if (it) { location.hash = `#/${it.dataset.route}`; close(); }
        });
      },
    });
  });
}

function userMenu() {
  import('./ui.js').then(({ modal, formModal }) => {
    modal({
      title: store.user.name,
      body: `
        <div class="stack">
          <div class="flex">${avatar(store.user.name, store.user.color, 'lg')}
            <div><div class="bold">${esc(store.user.name)}</div>
            <div class="tiny dim">${esc(store.user.email)} · ${esc(roleLabel(store.user.role))}</div></div></div>
          <div class="field"><label>שפת ממשק</label>
            <select class="input" id="ui-lang">
              <option value="he" ${lang === 'he' ? 'selected' : ''}>עברית</option>
              <option value="ar" ${lang === 'ar' ? 'selected' : ''}>العربية</option>
              <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
            </select></div>
          <button class="btn" id="btn-pass">שינוי סיסמה</button>
          <button class="btn btn-danger" id="btn-logout">${t('logout')}</button>
        </div>`,
      onMount(root, close) {
        $('#ui-lang', root).addEventListener('change', (e) => {
          setLang(e.target.value);
          location.reload();
        });
        $('#btn-logout', root).addEventListener('click', async () => {
          await api.post('/api/auth/logout');
          location.reload();
        });
        $('#btn-pass', root).addEventListener('click', async () => {
          close();
          const data = await formModal({
            title: 'שינוי סיסמה',
            fields: [
              { name: 'current', label: 'סיסמה נוכחית', type: 'password', required: true },
              { name: 'next', label: 'סיסמה חדשה', type: 'password', required: true },
            ],
          });
          if (!data) return;
          try {
            await api.post('/api/auth/password', data);
            toast('הסיסמה עודכנה', 'ok');
          } catch (e) { toast(e.message, 'err'); }
        });
      },
    });
  });
}

// --------------------------------------------------------------- router ---
async function handleRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, ...rest] = hash.split('/');

  if (name === 'lead' && rest[0]) {
    if (!currentRoute) await mount('dashboard', []);
    openLead(Number(rest[0]));
    return;
  }
  await mount(name, rest);
}

async function mount(name, params) {
  const loader = routes[name] ? routes[name] : routes.dashboard;
  const view = $('#view');
  if (!view) return;
  currentCleanup?.();
  currentCleanup = null;
  currentRoute = name;

  $$('.nav-item[data-route]').forEach((n) => n.classList.toggle('active', n.dataset.route === name));
  $$('.mobile-nav .item').forEach((n) => n.classList.toggle('active', n.dataset.route === name));
  const titleKey = NAV.find((n) => n.id === name)?.label || 'dashboard';
  $('#page-title').textContent = t(titleKey);

  view.innerHTML = skeleton(6);
  try {
    const mod = await loader();
    currentCleanup = (await mod.render(view, params)) || null;
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty"><div class="ico">⚠️</div><div>${esc(err.message || 'שגיאה')}</div></div>`;
  }
}

export function navigate(hash) {
  location.hash = hash;
}
export function refreshView() {
  handleRoute();
}

// -------------------------------------------------------- global search ---
function wireGlobalSearch() {
  const input = $('#global-search');
  const box = $('#search-results');
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const { rows } = await api.get('/api/leads', { q, limit: 8 });
        box.hidden = false;
        box.innerHTML = rows.length
          ? rows.map((r) => `
            <div class="row" data-id="${r.id}">
              ${avatar(r.full_name, r.owner_color, 'sm')}
              <div style="min-width:0;flex:1">
                <div class="small bold truncate">${esc(r.full_name || r.phone_pretty)}</div>
                <div class="tiny dim truncate">${esc(r.phone_pretty)} · ${esc(r.treatments_he || '')}</div>
              </div>
              <span class="chip tiny" style="background:${esc(r.status_color)}22;color:${esc(r.status_color)}">
                ${esc(r.status_he || '')}</span>
            </div>`).join('')
          : '<div class="row dim">אין תוצאות</div>';
      } catch { /* ignore */ }
    }, 220);
  });
  box.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    box.hidden = true;
    input.value = '';
    openLead(Number(row.dataset.id));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) box.hidden = true;
  });
}

// ------------------------------------------------------- notifications ----
let notifOpen = false;
async function toggleNotifications() {
  const existing = $('.notif-panel');
  if (existing) { existing.remove(); notifOpen = false; return; }
  notifOpen = true;
  const panel = el(`<div class="notif-panel">
    <div class="card-head"><h3>🔔 התראות</h3>
      <button class="btn btn-ghost btn-sm" data-read-all>סמן הכל כנקרא</button></div>
    <div style="overflow-y:auto" id="notif-list">${skeleton(4)}</div></div>`);
  document.body.append(panel);
  const { rows } = await api.get('/api/notifications', { limit: 40 });
  $('#notif-list', panel).innerHTML = rows.length ? rows.map((n) => `
    <div class="notif-item ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-lead="${n.lead_id || ''}">
      <div style="font-size:18px">${levelIcon(n.level, n.type)}</div>
      <div style="min-width:0;flex:1">
        <div class="small bold">${esc(n.title)}</div>
        ${n.body ? `<div class="tiny muted truncate">${esc(n.body)}</div>` : ''}
        <div class="tiny dim">${fmtRelative(n.created_at)}</div>
      </div>
    </div>`).join('') : '<div class="empty">אין התראות</div>';

  panel.addEventListener('click', async (e) => {
    if (e.target.closest('[data-read-all]')) {
      await api.post('/api/notifications/read', {});
      panel.remove();
      refreshBadges();
      return;
    }
    const item = e.target.closest('[data-id]');
    if (!item) return;
    await api.post('/api/notifications/read', { id: Number(item.dataset.id) });
    panel.remove();
    refreshBadges();
    if (item.dataset.lead) openLead(Number(item.dataset.lead));
  });
  setTimeout(() => {
    document.addEventListener('click', function outside(ev) {
      if (!ev.target.closest('.notif-panel') && !ev.target.closest('#btn-bell')) {
        panel.remove();
        document.removeEventListener('click', outside);
      }
    });
  }, 10);
}

const levelIcon = (level, type) => {
  if (type === 'new_lead') return '🔥';
  if (type === 'message_in') return '💬';
  if (type === 'email_open') return '📧';
  if (type === 'mention') return '@';
  if (type === 'task_due' || type === 'task_overdue') return '⏰';
  if (type?.startsWith('appointment')) return '📅';
  return level === 'urgent' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
};

// ------------------------------------------------------------- polling ----
let lastNotifId = 0;
async function refreshBadges() {
  try {
    const [notif, inbox, tasks] = await Promise.all([
      api.get('/api/notifications', { unread: 1, limit: 10 }),
      api.get('/api/inbox/counts'),
      api.get('/api/tasks/summary'),
    ]);
    store.counts = { notifications: notif.unread, inbox: inbox.unread, tasks };
    const badge = $('#bell-badge');
    if (badge) {
      badge.textContent = notif.unread > 99 ? '99+' : notif.unread;
      badge.style.display = notif.unread ? 'grid' : 'none';
    }
    setBadge('inbox', inbox.unread);
    setBadge('tasks', (tasks.overdue || 0) + (tasks.today || 0));

    // browser push for genuinely new notifications (spec §53)
    const newest = notif.rows[0];
    if (newest && lastNotifId && newest.id > lastNotifId && Notification?.permission === 'granted') {
      new Notification(newest.title, { body: newest.body || '', icon: '/favicon.ico', tag: `crm-${newest.id}` });
    }
    if (newest) lastNotifId = Math.max(lastNotifId, newest.id);
    emitChange();
  } catch { /* offline — ignore */ }
}

function setBadge(key, n) {
  $$(`[data-badge="${key}"]`).forEach((b) => {
    b.textContent = n > 99 ? '99+' : n;
    b.hidden = !n;
  });
  $$(`[data-dot="${key}"]`).forEach((d) => { d.hidden = !n; });
}

function startPolling() {
  refreshBadges();
  setInterval(refreshBadges, 30000);
}

function requestPushPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => Notification.requestPermission().catch(() => {}), 4000);
  }
}

// -------------------------------------------------------- new lead form ---
export async function newLeadModal(prefill = {}) {
  const { formModal } = await import('./ui.js');
  const data = await formModal({
    title: '＋ ליד חדש',
    wide: true,
    submitText: 'יצירת ליד',
    fields: [
      { name: 'first_name', label: 'שם פרטי', required: true, value: prefill.first_name },
      { name: 'last_name', label: 'שם משפחה', value: prefill.last_name },
      { name: 'phone', label: 'טלפון', required: true, placeholder: '05X-XXXXXXX', value: prefill.phone },
      { name: 'email', label: 'אימייל', type: 'email', value: prefill.email },
      { name: 'city', label: 'עיר', value: prefill.city },
      {
        name: 'treatments', label: 'טיפול מבוקש', type: 'multiselect',
        options: store.treatments.map((tr) => ({ value: tr.id, label: tr.name_he })), value: [],
      },
      {
        name: 'source', label: 'מקור הליד', type: 'select', value: prefill.source || 'phone',
        options: store.sources.map((s) => ({ value: s, label: s })),
      },
      { name: 'campaign_name', label: 'שם קמפיין', value: prefill.campaign_name },
      {
        name: 'language', label: 'שפת הלקוח', type: 'select', value: 'he',
        options: [{ value: 'he', label: 'עברית' }, { value: 'ar', label: 'ערבית' }, { value: 'en', label: 'אנגלית' }],
      },
      {
        name: 'owner_id', label: 'עובד מטפל', type: 'select', value: '',
        options: [{ value: '', label: 'הקצאה אוטומטית' },
          ...store.users.filter((u) => ['agent', 'reception', 'manager'].includes(u.role))
            .map((u) => ({ value: u.id, label: u.name }))],
      },
    ],
  });
  if (!data) return null;
  try {
    const res = await api.post('/api/leads', {
      ...data,
      treatment: data.treatments,
      owner_id: data.owner_id || undefined,
    });
    if (res.duplicate) toast(`לקוח קיים במערכת (${res.days_ago} ימים) — הפנייה צורפה לכרטיס`, 'ok');
    else toast('הליד נוצר', 'ok');
    openLead(res.lead.id);
    refreshView();
    return res.lead;
  } catch (err) {
    toast(err.message, 'err');
    return null;
  }
}

boot();
