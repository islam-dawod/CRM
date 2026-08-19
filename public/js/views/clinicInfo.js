// Clinic — every official link of the practice in one place (spec §10)
import { store } from '../store.js';
import { esc, fresh, empty } from '../ui.js';
import { clinic, clinicLinks, logoImg } from '../clinic.js';

export async function render(view) {
  view = fresh(view);
  const c = clinic();
  const links = clinicLinks();

  view.innerHTML = `
    <div class="card card-pad mb" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      ${logoImg('clinic-logo', 'max-width:190px')}
      <div style="flex:1;min-width:220px">
        <h2 style="font-size:20px">${esc(c.name || 'המרפאה')}</h2>
        <div class="muted">${esc(c.subtitle || '')}</div>
        <div class="flex-wrap" style="margin-top:10px">
          ${c.address ? `<span class="chip">📍 ${esc(c.address)}</span>` : ''}
          ${c.phone ? `<span class="chip">📞 ${esc(c.phone)}</span>` : ''}
          ${c.email ? `<span class="chip">✉️ ${esc(c.email)}</span>` : ''}
        </div>
      </div>
    </div>

    <h3 class="mb">קישורים רשמיים</h3>
    ${links.length ? `
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">
        ${links.map((l) => `
          <a class="link-tile" href="${esc(l.url)}" target="_blank" rel="noopener">
            <span class="ico">${l.icon}</span>
            <div style="min-width:0">
              <div class="bold small">${esc(l.label)}</div>
              <div class="tiny dim truncate">${esc(l.url)}</div>
            </div>
          </a>`).join('')}
      </div>` : empty('לא הוגדרו קישורים', '🔗')}

    ${!c.digital_card_url ? `
      <div class="card card-pad mt" style="border-color:var(--amber)">
        <div class="bold mb">⚠️ הכרטיס הדיגיטלי עדיין לא מוגדר</div>
        <div class="small muted">
          כתובת הכרטיס הדיגיטלי לא פורסמה באתר המרפאה, ולכן לא ניתן היה למלא אותה אוטומטית.
          כפתורי "שליחת כרטיס המרפאה" ו"שליחת פרטי המרפאה" ישלחו את שאר הפרטים בינתיים.
          ${store.permissions.admin ? 'ניתן להוסיף את הכתובת בהגדרות → קישורי המרפאה.' : 'יש לפנות למנהל המערכת.'}
        </div>
        ${store.permissions.admin
          ? '<a class="btn btn-primary btn-sm mt" href="#/settings">להגדרות קישורי המרפאה</a>' : ''}
      </div>` : ''}

    <div class="card card-pad mt">
      <div class="tiny dim">
        כל הקישורים כאן מגיעים מהגדרה מרכזית אחת. שינוי כתובת או קישור מתבצע פעם אחת
        בהגדרות → קישורי המרפאה, וכל כפתורי המערכת מתעדכנים אוטומטית.
      </div>
    </div>`;
}
