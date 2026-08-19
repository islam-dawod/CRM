// Single source of truth for clinic details and the outgoing message texts.
// Spec §15: every button reads the links from here, so changing the address or a
// URL is a one-time edit in Settings → Clinic Links, never a code change.
import { all, get, setting } from '../db.js';
import { prettyPhone } from './util.js';

/** Fields the admin can edit in Settings → Clinic Links. */
export const CLINIC_FIELDS = [
  'name', 'short_name', 'subtitle', 'phone', 'whatsapp', 'email', 'address',
  'website_url', 'maps_url', 'waze_url', 'digital_card_url', 'medreviews_url',
  'instagram_url', 'facebook_url', 'logo',
];

export function clinicConfig() {
  const c = setting('clinic', {}) || {};
  const address = c.address || '';
  return {
    ...c,
    // Derive navigation links from the address when they were not set explicitly.
    maps_url: c.maps_url || (address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : ''),
    waze_url: c.waze_url || (address
      ? `https://waze.com/ul?q=${encodeURIComponent(address)}&navigate=yes`
      : ''),
    whatsapp_url: c.whatsapp ? `https://wa.me/${String(c.whatsapp).replace(/\D/g, '')}` : '',
    tel_url: c.phone ? `tel:${String(c.phone).replace(/[^\d+]/g, '')}` : '',
  };
}

/** Template variables exposed to WhatsApp / email templates. */
export function clinicVars() {
  const c = clinicConfig();
  return {
    clinic: c.name || '',
    clinic_short: c.short_name || c.name || '',
    clinic_subtitle: c.subtitle || '',
    clinic_phone: c.phone || '',
    clinic_email: c.email || '',
    clinic_address: c.address || '',
    website_url: c.website_url || '',
    maps_url: c.maps_url || '',
    waze_url: c.waze_url || '',
    card_url: c.digital_card_url || '',
    medreviews_url: c.medreviews_url || '',
  };
}

const line = (...parts) => parts.filter(Boolean).join('\n');
const greet = (lead) => (lead?.first_name ? `שלום ${lead.first_name},` : 'שלום,');

// ---------------------------------------------------------------------------
// Message builders (spec §2, §6, §7, §9)
// ---------------------------------------------------------------------------
export function buildLocationMessage(lead) {
  const c = clinicConfig();
  return line(
    greet(lead),
    `מצורף המיקום של ${c.name || 'המרפאה'}.`,
    c.address ? `📍 ${c.address}` : null,
    '',
    c.maps_url ? `לניווט ב-Google Maps:\n${c.maps_url}` : null,
    c.waze_url ? `לניווט ב-Waze:\n${c.waze_url}` : null,
  );
}

export function buildCardMessage(lead) {
  const c = clinicConfig();
  return line(
    greet(lead),
    `מצורף הכרטיס הדיגיטלי של ${c.name || 'המרפאה'}.`,
    'בכרטיס ניתן למצוא פרטי קשר, מידע על המרפאה ודרכי הגעה.',
    '',
    c.digital_card_url || c.website_url || '',
  );
}

export function buildDetailsMessage(lead) {
  const c = clinicConfig();
  return line(
    greet(lead),
    '',
    c.name || '',
    c.subtitle || '',
    c.address ? `📍 ${c.address}` : null,
    c.phone ? `📞 ${c.phone}` : null,
    c.website_url ? `🌐 אתר המרפאה: ${c.website_url}` : null,
    c.maps_url ? `📍 Google Maps: ${c.maps_url}` : null,
    c.waze_url ? `🚗 Waze: ${c.waze_url}` : null,
    c.digital_card_url ? `💳 כרטיס דיגיטלי: ${c.digital_card_url}` : null,
  );
}

export function buildAppointmentMessage(lead, appt) {
  const c = clinicConfig();
  const fmt = (d, opts) =>
    d ? new Intl.DateTimeFormat('he-IL', { timeZone: c.timezone || 'Asia/Jerusalem', ...opts }).format(new Date(d)) : '';
  const treatment = appt?.treatment_id
    ? get('SELECT name_he FROM treatments WHERE id=?', appt.treatment_id)?.name_he
    : null;
  return line(
    greet(lead),
    `תזכורת לפגישה שלך ב${c.name || 'מרפאה'}.`,
    '',
    appt ? `📅 תאריך: ${fmt(appt.start_at, { day: '2-digit', month: '2-digit', year: 'numeric' })}` : null,
    appt ? `🕐 שעה: ${fmt(appt.start_at, { hour: '2-digit', minute: '2-digit', hour12: false })}` : null,
    treatment ? `🦷 טיפול: ${treatment}` : null,
    c.address ? `📍 ${c.address}` : null,
    '',
    c.maps_url ? `Google Maps: ${c.maps_url}` : null,
    c.waze_url ? `Waze: ${c.waze_url}` : null,
    c.digital_card_url ? `💳 כרטיס המרפאה: ${c.digital_card_url}` : null,
    '',
    c.phone ? `טלפון המרפאה: ${c.phone}` : null,
  );
}

export const MESSAGE_KINDS = {
  location: {
    build: buildLocationMessage,
    subject: 'מיקום המרפאה',
    event: 'location',
    label: 'מיקום המרפאה',
    icon: '📍',
  },
  card: {
    build: buildCardMessage,
    subject: 'הכרטיס הדיגיטלי של המרפאה',
    event: 'clinic_card',
    label: 'כרטיס המרפאה הדיגיטלי',
    icon: '💳',
  },
  details: {
    build: buildDetailsMessage,
    subject: 'פרטי המרפאה',
    event: 'clinic_info',
    label: 'פרטי המרפאה',
    icon: '📲',
  },
  appointment: {
    build: buildAppointmentMessage,
    subject: 'פרטי הפגישה שלך',
    event: 'appointment_info',
    label: 'פרטי הפגישה',
    icon: '📅',
  },
};

export const CHANNEL_LABEL = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  copy: 'העתקה ללוח',
};
