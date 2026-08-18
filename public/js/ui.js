// DOM + formatting helpers shared by every view.
import { lang } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape untrusted text before putting it into an innerHTML template. */
export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Swaps a container for an empty clone of itself and returns the clone.
 * Views attach delegated listeners to their container; without this, re-rendering
 * (or navigating away and back) would stack a new handler on the same node and
 * every click would fire two, three, four times.
 */
export function fresh(node) {
  const next = node.cloneNode(false);
  node.replaceWith(next);
  return next;
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---------------------------------------------------------------- dates ----
const TZ = 'Asia/Jerusalem';
const locale = () => (lang === 'ar' ? 'ar-EG' : lang === 'en' ? 'en-GB' : 'he-IL');

export const fmtDate = (d, opts = {}) =>
  d ? new Intl.DateTimeFormat(locale(), { timeZone: TZ, day: '2-digit', month: '2-digit', ...opts }).format(new Date(d)) : '';
export const fmtTime = (d) =>
  d ? new Intl.DateTimeFormat(locale(), { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d)) : '';
export const fmtDateTime = (d) => (d ? `${fmtDate(d, { year: '2-digit' })} ${fmtTime(d)}` : '');
export const fmtFull = (d) =>
  d ? new Intl.DateTimeFormat(locale(), { timeZone: TZ, dateStyle: 'full', timeStyle: 'short' }).format(new Date(d)) : '';

export function fmtRelative(d) {
  if (!d) return '';
  const diff = (new Date(d) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 2592000) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(d, { year: '2-digit' });
}

export const fmtMoney = (n, currency = 'ILS') =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(n || 0));
export const fmtNum = (n) => new Intl.NumberFormat(locale()).format(Number(n || 0));
export const fmtDuration = (s) => `${String(Math.floor((s || 0) / 60)).padStart(2, '0')}:${String((s || 0) % 60).padStart(2, '0')}`;

export function fmtMinutes(m) {
  m = Math.round(m || 0);
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}:${String(m % 60).padStart(2, '0')} שע'`;
  return `${Math.floor(h / 24)} ימים`;
}

/** Local-time value for <input type="datetime-local"> */
export function toLocalInput(d) {
  const dt = d ? new Date(d) : new Date();
  const off = dt.getTimezoneOffset() * 60000;
  return new Date(dt - off).toISOString().slice(0, 16);
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

// -------------------------------------------------------------- visuals ----
export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const PALETTE = ['#0ea5e9', '#8b5cf6', '#f59e0b', '#22c55e', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];
export function colorFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return PALETTE[h % PALETTE.length];
}

export const avatar = (name, color, cls = '') =>
  `<div class="avatar ${cls}" style="background:${esc(color || colorFor(name))}" title="${esc(name || '')}">${esc(initials(name))}</div>`;

export const TEMP_ICON = { hot: '🔥', warm: '🌤️', cold: '❄️' };
export const tempChip = (t) =>
  `<span class="chip temp-${esc(t)}">${TEMP_ICON[t] || ''} ${t === 'hot' ? 'חם' : t === 'cold' ? 'קר' : 'בינוני'}</span>`;

export const SOURCE_ICON = {
  facebook_lead_ads: '📘', facebook_campaign: '📘', instagram: '📷', landing_page: '🌐',
  website: '🖥️', whatsapp: '💬', google_ads: '🔍', phone: '📞', manual: '✍️', referral: '🤝',
};
export const SOURCE_LABEL = {
  facebook_lead_ads: 'Facebook Lead Ads', facebook_campaign: 'Facebook', instagram: 'Instagram',
  landing_page: 'דף נחיתה', website: 'אתר', whatsapp: 'WhatsApp', google_ads: 'Google Ads',
  phone: 'טלפון', manual: 'ידני', referral: 'הפניה',
};
export const sourceChip = (s) =>
  `<span class="chip">${SOURCE_ICON[s] || '•'} ${esc(SOURCE_LABEL[s] || s || '')}</span>`;

export function scoreRing(score) {
  const c = score >= 65 ? '#ef4444' : score >= 35 ? '#f59e0b' : '#0ea5e9';
  return `<div class="score-ring" style="background:conic-gradient(${c} ${score * 3.6}deg, var(--bg-soft) 0);"
    title="Lead score"><span style="background:var(--surface);width:32px;height:32px;border-radius:50%;
    display:grid;place-items:center">${score}</span></div>`;
}

// --------------------------------------------------------------- toasts ----
export function toast(message, kind = '') {
  const node = el(`<div class="toast ${kind}">${esc(message)}</div>`);
  document.getElementById('toast-root').append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

// --------------------------------------------------------------- modals ----
export function modal({ title, body, footer, wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title || '')}</h3><div class="spacer"></div>
          <button class="btn btn-ghost btn-icon" data-close>✕</button></div>
        <div class="modal-body"></div>
        ${footer ? '<div class="modal-foot"></div>' : ''}
      </div>
    </div>`);
  const bodyEl = $('.modal-body', backdrop);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);
  if (footer) {
    const f = $('.modal-foot', backdrop);
    if (typeof footer === 'string') f.innerHTML = footer;
    else f.append(footer);
  }
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  onMount?.(backdrop, close);
  return { close, root: backdrop, body: bodyEl };
}

export function confirmDialog(message, { danger = false, confirmText = 'אישור' } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'אישור פעולה',
      body: `<p class="muted">${esc(message)}</p>`,
      footer: `<button class="btn" data-close>ביטול</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmText)}</button>`,
      onMount(root, close) {
        $('[data-yes]', root).addEventListener('click', () => { close(); resolve(true); });
        root.addEventListener('click', (e) => {
          if (e.target === root || e.target.closest('[data-close]')) resolve(false);
        });
      },
    });
  });
}

/** Simple prompt-style form modal. fields: [{name,label,type,value,options,required,rows}] */
export function formModal({ title, fields, submitText = 'שמירה', wide = false }) {
  return new Promise((resolve) => {
    let done = false;
    const html = fields.map((f) => {
      if (f.type === 'hidden') return '';
      const id = `f_${f.name}`;
      let control;
      if (f.type === 'select') {
        control = `<select class="input" id="${id}" name="${f.name}" ${f.required ? 'required' : ''}>
          ${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>`;
      } else if (f.type === 'textarea') {
        control = `<textarea class="input" id="${id}" name="${f.name}" rows="${f.rows || 4}" ${f.required ? 'required' : ''}
          placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`;
      } else if (f.type === 'checkbox') {
        return `<div class="field flex"><label class="switch"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}><span class="track"></span></label>
          <label for="${id}" style="margin:0">${esc(f.label)}</label></div>`;
      } else if (f.type === 'multiselect') {
        control = `<div class="flex-wrap" data-multi="${f.name}">
          ${(f.options || []).map((o) => `<span class="chip clickable ${(f.value || []).map(String).includes(String(o.value)) ? 'active' : ''}"
            data-val="${esc(o.value)}">${esc(o.label)}</span>`).join('')}</div>`;
      } else {
        control = `<input class="input" id="${id}" name="${f.name}" type="${f.type || 'text'}"
          value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}
          ${f.step ? `step="${f.step}"` : ''}>`;
      }
      return `<div class="field"><label for="${id}">${esc(f.label)}</label>${control}
        ${f.hint ? `<div class="tiny dim" style="margin-top:4px">${esc(f.hint)}</div>` : ''}</div>`;
    }).join('');

    const m = modal({
      title,
      wide,
      body: `<form id="modal-form">${html}</form>`,
      footer: `<button class="btn" data-close>ביטול</button>
               <button class="btn btn-primary" form="modal-form" type="submit">${esc(submitText)}</button>`,
      onMount(root, close) {
        const form = $('#modal-form', root);
        $$('[data-multi]', root).forEach((box) => {
          box.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-val]');
            if (chip) chip.classList.toggle('active');
          });
        });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const data = Object.fromEntries(new FormData(form));
          for (const f of fields) {
            if (f.type === 'checkbox') data[f.name] = !!$(`#f_${f.name}`, root)?.checked;
            if (f.type === 'multiselect') {
              data[f.name] = $$(`[data-multi="${f.name}"] .chip.active`, root).map((c) => c.dataset.val);
            }
            if (f.type === 'hidden') data[f.name] = f.value;
          }
          done = true;
          close();
          resolve(data);
        });
        root.addEventListener('click', (e) => {
          if (e.target === root || e.target.closest('[data-close]')) { if (!done) resolve(null); }
        });
        setTimeout(() => $('input,textarea,select', form)?.focus(), 60);
      },
    });
  });
}

// -------------------------------------------------------------- skeleton ---
export const skeleton = (rows = 5) =>
  `<div class="card card-pad">${Array.from({ length: rows }, () => '<div class="skeleton sk-row"></div>').join('')}</div>`;

export const empty = (text, icon = '📭') =>
  `<div class="empty"><div class="ico">${icon}</div><div>${esc(text)}</div></div>`;

// ------------------------------------------------------------ mini chart ---
export function sparkline(values, { width = 220, height = 46, color = '#0ea5e9' } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => `${i * step},${height - (v / max) * (height - 6) - 3}`).join(' ');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">
    <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
    <polyline fill="${color}22" stroke="none" points="0,${height} ${pts} ${width},${height}"/>
  </svg>`;
}

export function donut(segments, size = 120) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const stops = segments.map((s) => {
    const from = (acc / total) * 360;
    acc += s.value;
    return `${s.color} ${from}deg ${(acc / total) * 360}deg`;
  }).join(',');
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:conic-gradient(${stops});
    display:grid;place-items:center;flex:none">
    <div style="width:${size * 0.6}px;height:${size * 0.6}px;border-radius:50%;background:var(--surface);
      display:grid;place-items:center;font-weight:800">${fmtNum(total)}</div></div>`;
}

export function bars(items, { max: forced } = {}) {
  const max = forced || Math.max(...items.map((i) => i.value), 1);
  return items.map((i) => `
    <div style="margin-bottom:10px">
      <div class="row-between tiny" style="margin-bottom:4px">
        <span class="bold">${esc(i.label)}</span><span class="num">${fmtNum(i.value)}${i.suffix || ''}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${(i.value / max) * 100}%;background:${i.color || 'var(--brand)'}"></div></div>
    </div>`).join('');
}
