// Clinic branding + "send clinic info" actions.
// Every link comes from store.settings.clinic — nothing is hard-coded per button
// (spec §15), so changing the address or a URL is a single edit in Settings.
import { api } from './api.js';
import { store } from './store.js';
import { $, $$, el, esc, modal, toast } from './ui.js';

export const clinic = () => store.settings?.clinic || {};

export const clinicName = () => clinic().name || 'המרפאה';
export const clinicLogo = () => clinic().logo || '/assets/clinic-logo.png';

/** <img> for the official logo. Width-driven so proportions are never distorted. */
export function logoImg(cls = 'clinic-logo', style = '') {
  const c = clinic();
  return `<img class="${cls}" src="${esc(clinicLogo())}" alt="${esc(c.name || 'לוגו המרפאה')}"
    width="560" height="289" style="${esc(style)}" decoding="async">`;
}

/** The official links, in the order they should be offered to the team (§10). */
export function clinicLinks() {
  const c = clinic();
  return [
    { key: 'website', icon: '🌐', label: 'אתר המרפאה', url: c.website_url },
    { key: 'card', icon: '💳', label: 'כרטיס דיגיטלי', url: c.digital_card_url },
    { key: 'maps', icon: '📍', label: 'Google Maps', url: c.maps_url },
    { key: 'waze', icon: '🚗', label: 'Waze', url: c.waze_url },
    { key: 'medreviews', icon: '⭐', label: 'MedReviews', url: c.medreviews_url },
    { key: 'whatsapp', icon: '💬', label: 'WhatsApp המרפאה', url: c.whatsapp_url },
    { key: 'phone', icon: '📞', label: `חיוג ${c.phone || ''}`.trim(), url: c.tel_url },
    { key: 'instagram', icon: '📷', label: 'Instagram', url: c.instagram_url },
    { key: 'facebook', icon: '📘', label: 'Facebook', url: c.facebook_url },
  ].filter((l) => l.url);
}

export const KIND_LABEL = {
  location: { icon: '📍', title: 'שליחת מיקום המרפאה' },
  card: { icon: '💳', title: 'שליחת כרטיס המרפאה' },
  details: { icon: '📲', title: 'שליחת פרטי המרפאה' },
  appointment: { icon: '📅', title: 'שליחת פרטי הפגישה' },
};

const CHANNELS = [
  { id: 'whatsapp', icon: '💬', label: 'WhatsApp' },
  { id: 'sms', icon: '📱', label: 'SMS' },
  { id: 'email', icon: '✉️', label: 'Email' },
  { id: 'copy', icon: '📋', label: 'העתקת קישור' },
];

/**
 * Opens the send dialog: pick a channel, review/edit the text, send.
 * onSent() lets the caller refresh the timeline.
 */
export async function openClinicSend(leadId, kind, { appointmentId = null, lead = null, onSent } = {}) {
  const meta = KIND_LABEL[kind] || KIND_LABEL.details;
  let preview;
  try {
    preview = await api.get(`/api/leads/${leadId}/clinic-message`, {
      kind, appointment_id: appointmentId || undefined,
    });
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const c = preview.clinic || clinic();
  const hasEmail = !!(lead?.email ?? true);
  const missingCard = (kind === 'card' || kind === 'details') && !c.digital_card_url;

  modal({
    title: `${meta.icon} ${meta.title}`,
    wide: true,
    body: `
      <div class="stack">
        <div class="flex" style="gap:12px;align-items:center">
          ${logoImg('clinic-logo', 'max-width:104px')}
          <div>
            <div class="bold">${esc(c.name || '')}</div>
            <div class="tiny dim">${esc(c.subtitle || '')}</div>
            <div class="tiny">${esc(c.address || '')}</div>
          </div>
        </div>

        <div class="flex-wrap">
          ${c.maps_url ? `<a class="btn btn-sm" href="${esc(c.maps_url)}" target="_blank" rel="noopener">📍 Google Maps</a>` : ''}
          ${c.waze_url ? `<a class="btn btn-sm" href="${esc(c.waze_url)}" target="_blank" rel="noopener">🚗 Waze</a>` : ''}
          ${c.digital_card_url ? `<a class="btn btn-sm" href="${esc(c.digital_card_url)}" target="_blank" rel="noopener">💳 כרטיס דיגיטלי</a>` : ''}
        </div>

        ${missingCard ? `<div class="chip" style="background:var(--amber-soft);color:#b45309;white-space:normal;height:auto;padding:8px 12px">
          ⚠️ עדיין לא הוגדרה כתובת לכרטיס הדיגיטלי — יש להוסיף אותה בהגדרות → קישורי המרפאה.
        </div>` : ''}

        <div class="field" style="margin:0">
          <label>ערוץ שליחה</label>
          <div class="flex-wrap" id="cs-channels">
            ${CHANNELS.map((ch, i) => `<span class="chip clickable ${i === 0 ? 'active' : ''}"
              data-ch="${ch.id}">${ch.icon} ${ch.label}</span>`).join('')}
          </div>
        </div>

        <div class="field" style="margin:0" id="cs-subject-wrap" hidden>
          <label>נושא</label>
          <input class="input" id="cs-subject" value="${esc(preview.subject || '')}">
        </div>

        <div class="field" style="margin:0">
          <label>תוכן ההודעה — ניתן לערוך לפני השליחה</label>
          <textarea class="input" id="cs-body" rows="9">${esc(preview.body)}</textarea>
        </div>
      </div>`,
    footer: `<button class="btn" data-close>ביטול</button>
             <button class="btn btn-primary" id="cs-send">שליחה</button>`,
    onMount(root, close) {
      let channel = 'whatsapp';
      const subjectWrap = $('#cs-subject-wrap', root);
      const sendBtn = $('#cs-send', root);

      $('#cs-channels', root).addEventListener('click', (e) => {
        const chip = e.target.closest('[data-ch]');
        if (!chip) return;
        channel = chip.dataset.ch;
        $$('#cs-channels .chip', root).forEach((x) => x.classList.toggle('active', x === chip));
        subjectWrap.hidden = channel !== 'email';
        sendBtn.textContent = channel === 'copy' ? 'העתקה' : 'שליחה';
      });

      sendBtn.addEventListener('click', async () => {
        const text = $('#cs-body', root).value.trim();
        if (!text) return toast('תוכן ההודעה ריק', 'err');
        sendBtn.disabled = true;
        try {
          if (channel === 'copy') await navigator.clipboard.writeText(text).catch(() => {});
          await api.post(`/api/leads/${leadId}/clinic-send`, {
            kind,
            channel,
            body: text,
            subject: $('#cs-subject', root)?.value,
            appointment_id: appointmentId || undefined,
          });
          toast(channel === 'copy' ? 'ההודעה הועתקה ונרשמה בהיסטוריה' : `נשלח ב-${
            CHANNELS.find((x) => x.id === channel).label}`, 'ok');
          close();
          onSent?.();
        } catch (err) {
          toast(err.message, 'err');
          sendBtn.disabled = false;
        }
      });
    },
  });
}

/** Quick-action buttons shared by the lead card and the mobile sheet (§14). */
export const CLINIC_ACTIONS = [
  { act: 'send-location', icon: '📍', label: 'שליחת מיקום', kind: 'location' },
  { act: 'send-card', icon: '💳', label: 'כרטיס המרפאה', kind: 'card' },
  { act: 'send-details', icon: '📲', label: 'פרטי המרפאה', kind: 'details' },
];
