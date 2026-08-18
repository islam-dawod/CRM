// Hebrew / Arabic / English UI strings (spec: he + ar now, en later).
const DICT = {
  he: {
    dashboard: 'לוח בקרה', leads: 'לידים', customers: 'לקוחות', inbox: 'תיבת הודעות',
    calendar: 'יומן', appointments: 'תורים', tasks: 'משימות', campaigns: 'קמפיינים',
    reports: 'דוחות', team: 'צוות', automation: 'אוטומציות', templates: 'תבניות',
    settings: 'הגדרות', ai: 'עוזר AI', logout: 'התנתקות', search: 'חיפוש...',
    new_lead: 'ליד חדש', save: 'שמירה', cancel: 'ביטול', close: 'סגירה', delete: 'מחיקה',
    edit: 'עריכה', add: 'הוספה', send: 'שליחה', call: 'התקשר', whatsapp: 'WhatsApp',
    email: 'מייל', note: 'הערה', timeline: 'היסטוריה', overview: 'סקירה',
    documents: 'מסמכים', deals: 'עסקאות', status: 'סטטוס', owner: 'עובד מטפל',
    source: 'מקור', treatment: 'טיפול', phone: 'טלפון', city: 'עיר', language: 'שפה',
    created: 'נכנס בתאריך', next_action: 'פעולה הבאה', score: 'ניקוד', temperature: 'דירוג',
    hot: 'חם', warm: 'בינוני', cold: 'קר', today: 'היום', tomorrow: 'מחר',
    overdue: 'באיחור', urgent: 'דחוף', all: 'הכל', none: 'ללא', list: 'רשימה',
    board: 'לוח', loading: 'טוען...', no_results: 'אין תוצאות', appointment: 'תור',
    revenue: 'הכנסות', funnel: 'משפך', response_time: 'זמן תגובה', performance: 'ביצועים',
  },
  ar: {
    dashboard: 'لوحة التحكم', leads: 'العملاء المحتملون', customers: 'العملاء', inbox: 'صندوق الرسائل',
    calendar: 'التقويم', appointments: 'المواعيد', tasks: 'المهام', campaigns: 'الحملات',
    reports: 'التقارير', team: 'الفريق', automation: 'الأتمتة', templates: 'القوالب',
    settings: 'الإعدادات', ai: 'مساعد AI', logout: 'تسجيل خروج', search: 'بحث...',
    new_lead: 'عميل جديد', save: 'حفظ', cancel: 'إلغاء', close: 'إغلاق', delete: 'حذف',
    edit: 'تعديل', add: 'إضافة', send: 'إرسال', call: 'اتصال', whatsapp: 'واتساب',
    email: 'بريد', note: 'ملاحظة', timeline: 'السجل', overview: 'نظرة عامة',
    documents: 'مستندات', deals: 'الصفقات', status: 'الحالة', owner: 'الموظف المسؤول',
    source: 'المصدر', treatment: 'العلاج', phone: 'هاتف', city: 'المدينة', language: 'اللغة',
    created: 'تاريخ الدخول', next_action: 'الإجراء التالي', score: 'النقاط', temperature: 'التصنيف',
    hot: 'ساخن', warm: 'متوسط', cold: 'بارد', today: 'اليوم', tomorrow: 'غداً',
    overdue: 'متأخر', urgent: 'عاجل', all: 'الكل', none: 'بدون', list: 'قائمة',
    board: 'لوحة', loading: 'جارٍ التحميل...', no_results: 'لا نتائج', appointment: 'موعد',
    revenue: 'الإيرادات', funnel: 'القمع', response_time: 'زمن الاستجابة', performance: 'الأداء',
  },
  en: {
    dashboard: 'Dashboard', leads: 'Leads', customers: 'Customers', inbox: 'Inbox',
    calendar: 'Calendar', appointments: 'Appointments', tasks: 'Tasks', campaigns: 'Campaigns',
    reports: 'Reports', team: 'Team', automation: 'Automation', templates: 'Templates',
    settings: 'Settings', ai: 'AI Assistant', logout: 'Log out', search: 'Search...',
    new_lead: 'New lead', save: 'Save', cancel: 'Cancel', close: 'Close', delete: 'Delete',
    edit: 'Edit', add: 'Add', send: 'Send', call: 'Call', whatsapp: 'WhatsApp',
    email: 'Email', note: 'Note', timeline: 'Timeline', overview: 'Overview',
    documents: 'Documents', deals: 'Deals', status: 'Status', owner: 'Owner',
    source: 'Source', treatment: 'Treatment', phone: 'Phone', city: 'City', language: 'Language',
    created: 'Created', next_action: 'Next action', score: 'Score', temperature: 'Rating',
    hot: 'Hot', warm: 'Warm', cold: 'Cold', today: 'Today', tomorrow: 'Tomorrow',
    overdue: 'Overdue', urgent: 'Urgent', all: 'All', none: 'None', list: 'List',
    board: 'Board', loading: 'Loading...', no_results: 'No results', appointment: 'Appointment',
    revenue: 'Revenue', funnel: 'Funnel', response_time: 'Response time', performance: 'Performance',
  },
};

export let lang = localStorage.getItem('crm_lang') || 'he';

export function setLang(next) {
  lang = DICT[next] ? next : 'he';
  localStorage.setItem('crm_lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
}

export const t = (key) => DICT[lang]?.[key] ?? DICT.he[key] ?? key;

/** Picks name_he / name_ar / name_en off a reference row. */
export const nameOf = (row) => row?.[`name_${lang}`] || row?.name_he || row?.name || '';

setLang(lang);
