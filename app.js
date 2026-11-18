'use strict';
/* FocusDay — personal planner PWA. Data stays on the phone (localStorage). */
const KEY = 'focusday.v1';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const pad = n => String(n).padStart(2, '0');
const dkey = (d = new Date()) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fmtMin = m => { const h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + ' h ' + r + ' min' : h + ' h') : r + ' min'; };
const fmtClock = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const r2 = n => Math.round(n * 100) / 100;
const fmtNum = n => String(r2(n));
const TYPES = [['todo', '✅', 'Todo'], ['reminder', '⏰', 'Reminder'], ['meeting', '👥', 'Meeting'], ['appointment', '📅', 'Appointment'], ['trip', '✈️', 'Trip'], ['call', '📞', 'Call']];
const REPEATS = [['none', 'No repeat'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const UNITS = ['pages', 'km', 'min', 'hours', 'times', 'glasses', 'count'];
const typeOf = id => TYPES.find(t => t[0] === id) || TYPES[0];

const DEFAULT = {
  tasks: [], habits: [
    { id: uid(), title: 'Read', goal: 20, unit: 'pages', log: {} },
    { id: uid(), title: 'Run', goal: 1, unit: 'km', log: {} },
    { id: uid(), title: 'Brush teeth', goal: 3, unit: 'times', log: {} }
  ], sessions: [], notified: {},
  settings: { focus: 25, brk: 5, long: 15, wake: true, notify: true, theme: 'dark', city: 'İstanbul', zone: 'Europe/Berlin', base: 'EUR', quote: 'TRY' },
  timer: { phase: 'focus', running: false, endsAt: 0, remaining: 25 * 60, round: 1, taskId: null, free: true, label: 'Reading emails' }
};
let S;
function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (_) { S = null; }
  const fresh = !S;
  S = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), S || {});
  S.settings = Object.assign({}, DEFAULT.settings, S.settings);
  S.timer = Object.assign({}, DEFAULT.timer, S.timer);
  if (!fresh) migrate();
}
function migrate() {
  S.timer.free = true;
  const legacy = { Istanbul: 'İstanbul', Izmir: 'İzmir', Balikesir: 'Balıkesir', Tekirdag: 'Tekirdağ' };
  if (legacy[S.settings.city]) S.settings.city = legacy[S.settings.city];
  S.settings.base = S.settings.base || 'EUR'; S.settings.quote = S.settings.quote || 'TRY'; // older versions: tasks without date/type, separate reminders, habits without unit
  const today = dkey();
  S.tasks.forEach(t => {
    if (!t.date) t.date = t.created ? dkey(new Date(t.created)) : today;
    t.type = t.type || 'todo'; t.repeat = t.repeat || 'none'; t.time = t.time || '';
    if (!t.doneDays) { t.doneDays = {}; if (t.done) t.doneDays[t.doneDay || t.date] = 1; }
    delete t.done; delete t.doneDay;
  });
  (S.reminders || []).forEach(r => S.tasks.push({ id: r.id, title: r.title, type: 'reminder', date: today, time: r.time, repeat: 'daily', est: 0, doneDays: {}, created: Date.now() }));
  delete S.reminders;
  S.habits.forEach(h => { h.unit = h.unit || 'times'; });
}
function applyTheme() {
  const t = S.settings.theme || 'dark'; document.documentElement.dataset.theme = t;
  const light = t === 'light' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = light ? '#F5F6F8' : '#0F1218';
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) { toast('Storage is full or blocked', null); } scheduleSync(); }
load(); applyTheme();

/* ---------- push server (lock-screen reminders) ---------- */
const PUSH_URL = ''; // Cloudflare Worker address, e.g. https://focusday-push.<name>.workers.dev
const VAPID_PUBLIC = 'BMmOAKt8mkdnZjmP3ev5nNZdTP4qDwerEc4irojjlxt__SmvXWo1FPXM8pgH4OmFc0AbWdrjcHB3oiO8InVjsOE';
const SUBKEY = 'focusday.pushsub', DEVKEY = 'focusday.dev';
function pushSub() { try { return JSON.parse(localStorage.getItem(SUBKEY)); } catch (_) { return null; } }
function pushOn() { return !!(PUSH_URL && pushSub()); }
function deviceId() {
  let d = localStorage.getItem(DEVKEY);
  if (!d) { d = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 28) + uid() + uid(); localStorage.setItem(DEVKEY, d); }
  return d;
}
const b64uToBytes = str => { str = str.replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; return Uint8Array.from(atob(str), c => c.charCodeAt(0)); };
async function serverCall(path, body) {
  const r = await fetch(PUSH_URL.replace(/\/$/, '') + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ deviceId: deviceId() }, body)) });
  return r.json().catch(() => ({}));
}
let syncTimer;
function scheduleSync() { if (!pushOn()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); }
async function syncNow() {
  if (!pushOn()) return;
  const T = S.timer;
  try {
    return await serverCall('/sync', {
      sub: pushSub(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Istanbul',
      reminders: S.tasks.filter(t => t.time && !(t.repeat === 'none' && isDone(t, t.date))).slice(0, 100).map(t => ({ id: t.id, title: t.title, kind: typeOf(t.type)[2], time: t.time, date: t.date, repeat: t.repeat, done: Object.keys(t.doneDays || {}).sort().slice(-3) })),
      timer: T.running ? { endsAt: T.endsAt, phase: T.phase } : null
    });
  } catch (_) { /* offline: next change syncs again */ }
}
async function enablePush() {
  if (!PUSH_URL) { toast('Push server address is not set yet', null); return; }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Open FocusDay from the Home Screen icon first (iOS 16.4+)', null); return; }
  try {
    if (Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { toast('Notifications are blocked in iOS Settings', null); render(); return; } }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC) });
    localStorage.setItem(SUBKEY, JSON.stringify(sub.toJSON()));
    const res = await syncNow();
    toast(res && res.ok ? 'Lock-screen notifications enabled' : 'Could not reach the push server', null);
  } catch (e) { toast('Could not enable: ' + (e && e.message || e), null); }
  render();
}
async function disablePush() {
  try { const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); await serverCall('/unsubscribe', {}); } catch (_) {}
  localStorage.removeItem(SUBKEY); toast('Lock-screen notifications turned off', null); render();
}

/* ---------- toast with undo ---------- */
let toastTimer;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = '<div class="t"><span>' + esc(msg) + '</span>' + (undo ? '<button id="undo">Undo</button>' : '') + '</div>';
  if (undo) $('#undo').onclick = () => { clearTimeout(toastTimer); t.innerHTML = ''; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.innerHTML = ''; }, 5000);
}

/* ---------- notifications ---------- */
async function notify(title, body, tag) {
  if (!S.settings.notify) return;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) return reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag });
      new Notification(title, { body });
    }
  } catch (_) { /* ignore */ }
}
async function askPermission() {
  if (!('Notification' in window)) { toast('Notifications need the app on the Home Screen (iOS 16.4+)', null); return; }
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Notifications enabled' : 'Notifications are blocked in iOS Settings', null);
  render();
}


/* ---------- tasks (one-off and repeating) ---------- */
const dow = day => pd(day).getDay();
function occursOn(t, day) {
  if (day < t.date) return false;
  switch (t.repeat) {
    case 'daily': return true;
    case 'weekdays': { const w = dow(day); return w >= 1 && w <= 5; }
    case 'weekly': return dow(day) === dow(t.date);
    case 'monthly': return pd(day).getDate() === pd(t.date).getDate();
    default: return day === t.date;
  }
}
const isDone = (t, day) => !!(t.doneDays && t.doneDays[day]);
function tasksFor(day) {
  return S.tasks.filter(t => occursOn(t, day)).sort((a, b) => (a.time || '').localeCompare(b.time || '') || (a.created || 0) - (b.created || 0));
}
function overdue() { const today = dkey(); return S.tasks.filter(t => t.repeat === 'none' && !isDone(t, t.date) && t.date < today).sort((a, b) => a.date.localeCompare(b.date)); }
function toggleDone(id, day) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  t.doneDays = t.doneDays || {}; if (t.doneDays[day]) delete t.doneDays[day]; else t.doneDays[day] = 1;
  save(); render();
}
function removeTask(id) {
  const i = S.tasks.findIndex(x => x.id === id), it = S.tasks[i]; if (i < 0) return;
  S.tasks.splice(i, 1); save(); render();
  toast('"' + it.title + '" deleted', () => { S.tasks.splice(Math.min(i, S.tasks.length), 0, it); save(); render(); });
}
const dayLabel = day => {
  const t = dkey(), n = new Date(); n.setDate(n.getDate() + 1);
  if (day === t) return 'Today'; if (day === dkey(n)) return 'Tomorrow';
  return pd(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
const repeatLabel = r => (REPEATS.find(x => x[0] === r) || REPEATS[0])[1];
const taskMeta = t => [t.repeat === 'none' ? dayLabel(t.date) : repeatLabel(t.repeat), t.time || 'All day'].join(' · ');

/* ---------- habits (amount per day, with a unit) ---------- */
const habitAmt = (h, day) => h.log[day] || 0;
const habitMet = (h, day) => habitAmt(h, day) >= h.goal;
function habitStreak(h) {
  let n = 0; const d = new Date();
  if (!habitMet(h, dkey(d))) d.setDate(d.getDate() - 1); // today may still be in progress
  while (habitMet(h, dkey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function setHabit(id, fn) { const h = S.habits.find(x => x.id === id); if (!h) return; const k = dkey(); const v = fn(habitAmt(h, k)); if (v <= 0) delete h.log[k]; else h.log[k] = r2(v); save(); render(); }
function removeHabit(id) {
  const i = S.habits.findIndex(x => x.id === id), it = S.habits[i]; if (i < 0) return;
  S.habits.splice(i, 1); save(); render();
  toast('"' + it.title + '" deleted', () => { S.habits.splice(Math.min(i, S.habits.length), 0, it); save(); render(); });
}
const parseNum = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

/* ---------- forms state (Plan tab) ---------- */
let form = null, hform = null, editing = false;
const next7 = () => Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return dkey(d); });
const blankForm = () => ({ id: null, title: '', type: 'todo', date: dkey(), other: false, hasTime: false, time: '09:00', repeat: 'none' });
function formFrom(t) { return { id: t.id, title: t.title, type: t.type, date: t.date, other: !next7().includes(t.date), hasTime: !!t.time, time: t.time || '09:00', repeat: t.repeat }; }
function saveForm() {
  const f = form, title = f.title.trim(); if (!title) { toast('Give the task a title', null); return; }
  const rec = { title: title.slice(0, 120), type: f.type, date: f.date || dkey(), time: f.hasTime ? f.time : '', repeat: f.repeat };
  if (f.id) { const t = S.tasks.find(x => x.id === f.id); if (t) Object.assign(t, rec); }
  else S.tasks.push(Object.assign({ id: uid(), doneDays: {}, created: Date.now(), est: 0 }, rec));
  form = null; save(); render();
}

/* ---------- Today info: weather, other country's time, EUR/TRY ---------- */
const PROVINCES = 'Adana 37.00 35.32;Adıyaman 37.76 38.28;Afyonkarahisar 38.76 30.54;Ağrı 39.72 43.05;Aksaray 38.37 34.03;Amasya 40.65 35.83;Ankara 39.93 32.86;Antalya 36.90 30.70;Ardahan 41.11 42.70;Artvin 41.18 41.82;Aydın 37.85 27.84;Balıkesir 39.65 27.89;Bartın 41.64 32.34;Batman 37.88 41.13;Bayburt 40.26 40.23;Bilecik 40.14 29.98;Bingöl 38.89 40.50;Bitlis 38.40 42.11;Bolu 40.73 31.61;Burdur 37.72 30.29;Bursa 40.19 29.06;Çanakkale 40.15 26.41;Çankırı 40.60 33.62;Çorum 40.55 34.95;Denizli 37.78 29.09;Diyarbakır 37.91 40.24;Düzce 40.84 31.16;Edirne 41.68 26.56;Elazığ 38.67 39.22;Erzincan 39.75 39.49;Erzurum 39.90 41.27;Eskişehir 39.78 30.52;Gaziantep 37.07 37.38;Giresun 40.91 38.39;Gümüşhane 40.46 39.48;Hakkari 37.57 43.74;Hatay 36.20 36.16;Iğdır 39.92 44.04;Isparta 37.76 30.55;İstanbul 41.01 28.98;İzmir 38.42 27.14;Kahramanmaraş 37.58 36.94;Karabük 41.20 32.63;Karaman 37.18 33.23;Kars 40.60 43.10;Kastamonu 41.39 33.78;Kayseri 38.72 35.49;Kilis 36.72 37.12;Kırıkkale 39.85 33.52;Kırklareli 41.74 27.23;Kırşehir 39.15 34.17;Kocaeli 40.77 29.94;Konya 37.87 32.48;Kütahya 39.42 29.98;Malatya 38.35 38.31;Manisa 38.61 27.43;Mardin 37.31 40.74;Mersin 36.80 34.64;Muğla 37.22 28.36;Muş 38.74 41.49;Nevşehir 38.62 34.71;Niğde 37.97 34.68;Ordu 40.98 37.88;Osmaniye 37.07 36.25;Rize 41.02 40.52;Sakarya 40.69 30.44;Samsun 41.29 36.33;Siirt 37.93 41.94;Sinop 42.03 35.15;Sivas 39.75 37.02;Şanlıurfa 37.16 38.79;Şırnak 37.52 42.46;Tekirdağ 40.98 27.51;Tokat 40.31 36.55;Trabzon 41.00 39.72;Tunceli 39.11 39.55;Uşak 38.68 29.41;Van 38.49 43.38;Yalova 40.65 29.27;Yozgat 39.82 34.81;Zonguldak 41.45 31.80'.split(';').map(x => { const p = x.split(' '); return [p[0], +p[1], +p[2]]; });
const CITIES = {}; PROVINCES.forEach(p => { CITIES[p[0]] = [p[1], p[2]]; });
const PAIRS = [['EUR', 'TRY'], ['USD', 'TRY'], ['GBP', 'TRY'], ['CHF', 'TRY'], ['EUR', 'USD'], ['GBP', 'USD'], ['EUR', 'GBP']];
let customPair = false;
const CURRENCIES = ['TRY', 'EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CNY', 'AUD', 'CAD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'INR', 'BRL', 'KRW', 'ZAR', 'AED', 'SAR', 'RUB'];
const ZONES = [['Berlin (Germany)', 'Europe/Berlin'], ['London', 'Europe/London'], ['New York', 'America/New_York'], ['Los Angeles', 'America/Los_Angeles'], ['Dubai', 'Asia/Dubai'], ['Moscow', 'Europe/Moscow'], ['Mumbai', 'Asia/Kolkata'], ['Shanghai', 'Asia/Shanghai'], ['Tokyo', 'Asia/Tokyo'], ['Sydney', 'Australia/Sydney']];
const WX_KEY = 'focusday.wx', FX_KEY = 'focusday.fx';
const wxIcon = (c, day) => c === 0 ? (day ? '☀️' : '🌙') : c <= 2 ? '🌤' : c === 3 ? '☁️' : c <= 48 ? '🌫' : c <= 57 ? '🌦' : c <= 67 ? '🌧' : c <= 77 ? '🌨' : c <= 82 ? '🌦' : c <= 86 ? '🌨' : '⛈';
const cache = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
function zoneOffsetMs(zone, at) {
  const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).forEach(x => { p[x.type] = +x.value; });
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at.getTime() / 1000) * 1000;
}
function infoHTML() {
  const wx = cache(WX_KEY), fx = cache(FX_KEY), city = S.settings.city, zone = S.settings.zone, now = new Date(), pair = S.settings.base + '/' + S.settings.quote;
  const zl = (ZONES.find(z => z[1] === zone) || [zone])[0].split(' (')[0];
  let time = '--:--', diff = '';
  try {
    time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const d = Math.round((zoneOffsetMs(zone, now) - zoneOffsetMs(Intl.DateTimeFormat().resolvedOptions().timeZone, now)) / 60000) / 60;
    diff = d === 0 ? 'same' : (d > 0 ? '+' : '−') + fmtNum(Math.abs(d)) + 'h';
  } catch (_) { /* unknown zone */ }
  const w = wx && wx.city === city ? wx : null;
  return '<div class="stat"><b>' + (w ? wxIcon(w.code, w.day) + ' ' + Math.round(w.temp) + '°' : '—') + '</b><span class="sub">' + esc(city) + '</span></div>' +
    '<div class="stat"><b>' + time + '</b><span class="sub">' + esc(zl) + ' · ' + diff + '</span></div>' +
    '<div class="stat"><b>' + (fx && fx.pair === pair ? fmtRate(fx.rate) : '—') + '</b><span class="sub" title="' + (fx && fx.date ? 'Rate of ' + fx.date : '') + '">' + pair.replace('/', ' / ') + '</span></div>';
}
const fmtRate = r => r >= 10 ? r.toFixed(2) : r >= 1 ? r.toFixed(4) : r.toFixed(5);
function updateInfo() { const el = $('#info'); if (el) el.innerHTML = infoHTML(); }
async function fetchJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function refreshInfo(force) {
  const now = Date.now(), wx = cache(WX_KEY), fx = cache(FX_KEY), c = CITIES[S.settings.city] || CITIES['İstanbul'];
  const jobs = [];
  if (force || !wx || wx.city !== S.settings.city || now - wx.t > 20 * 60000) jobs.push(fetchJSON('https://api.open-meteo.com/v1/forecast?latitude=' + c[0] + '&longitude=' + c[1] + '&current=temperature_2m,weather_code,is_day').then(j => {
    localStorage.setItem(WX_KEY, JSON.stringify({ t: now, city: S.settings.city, temp: j.current.temperature_2m, code: j.current.weather_code, day: !!j.current.is_day }));
  }).catch(() => {}));
  const base = S.settings.base, quote = S.settings.quote, pair = base + '/' + quote;
  if (base !== quote && (force || !fx || fx.pair !== pair || now - fx.t > 60 * 60000)) jobs.push(fetchJSON('https://api.frankfurter.dev/v1/latest?base=' + base + '&symbols=' + quote).then(j => {
    if (!(j.rates && j.rates[quote] > 0)) throw new Error('no rate');
    localStorage.setItem(FX_KEY, JSON.stringify({ t: now, pair, rate: j.rates[quote], date: j.date }));
  }).catch(() => fetchJSON('https://open.er-api.com/v6/latest/' + base).then(j => {
    if (!(j.rates && j.rates[quote] > 0)) throw new Error('no rate');
    localStorage.setItem(FX_KEY, JSON.stringify({ t: now, pair, rate: j.rates[quote], date: new Date(now).toISOString().slice(0, 10) }));
  })).catch(() => {}));
  if (jobs.length) { await Promise.all(jobs); updateInfo(); }
}

/* ---------- Today: summary ---------- */
function viewToday() {
  const today = dkey(), list = tasksFor(today), over = overdue();
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const dayStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  let h = '<div><h1>' + greet + '</h1><div class="sub">' + esc(dayStr) + '</div></div>';
  h += '<div class="grid3" id="info" aria-label="Weather, time and exchange rate">' + infoHTML() + '</div>';
  if (new Date().getDay() === 0) h += '<div class="banner row"><span class="sp">It\'s Sunday — your weekly report is ready.</span><button class="btn pri" data-go="report">Open</button></div>';

  if (over.length) {
    h += '<section class="card"><h2 style="padding-bottom:6px;color:var(--danger)">Overdue</h2>';
    over.forEach(t => {
      h += '<div class="item"><button class="chk" role="checkbox" aria-checked="false" aria-label="' + esc(t.title) + '" data-od="' + t.id + '"></button><span class="title">' + typeOf(t.type)[1] + ' ' + esc(t.title) + '</span><span class="sub">' + dayLabel(t.date) + '</span>' +
        '<button class="btn" data-mv="' + t.id + '" aria-label="Move to today: ' + esc(t.title) + '">→ Today</button></div>';
    });
    h += '</section>';
  }

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Today\'s plan</h2><button class="btn" id="toggleEdit">' + (editing ? 'Done' : 'Edit') + '</button><button class="btn pri" data-newtask="1">+ Add</button></div>';
  if (!list.length) h += '<div class="empty">Nothing planned for today.</div>';
  list.slice().sort((a, b) => isDone(a, today) - isDone(b, today)).forEach(t => {
    const d = isDone(t, today);
    h += '<div class="item ' + (d ? 'done' : '') + '"><button class="chk ' + (d ? 'on' : '') + '" role="checkbox" aria-checked="' + d + '" aria-label="' + esc(t.title) + '" data-tc="' + t.id + '">' + (d ? '✓' : '') + '</button>' +
      '<div class="sp"><div class="title" style="white-space:normal">' + typeOf(t.type)[1] + ' ' + esc(t.title) + '</div><div class="sub">' + (t.time || 'All day') + (t.repeat !== 'none' ? ' · ' + repeatLabel(t.repeat) : '') + '</div></div>' +
      (editing ? '<button class="icon" data-td="' + t.id + '" aria-label="Delete: ' + esc(t.title) + '">🗑</button>' : '') + '</div>';
  });
  h += '</section>';

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Habits</h2><button class="btn pri" data-newhabit="1">+ Add</button></div>';
  if (!S.habits.length) h += '<div class="empty">No habits yet.</div>';
  S.habits.forEach(x => {
    const a = habitAmt(x, today), met = a >= x.goal, st = habitStreak(x), p = Math.min(100, Math.round(100 * a / x.goal));
    h += '<div class="habit"><div class="row"><span class="mark ' + (met ? 'on' : '') + '" aria-hidden="true">' + (met ? '✓' : '') + '</span><div class="sp"><div class="title" style="white-space:normal">' + esc(x.title) + '</div>' +
      '<div class="sub">' + fmtNum(a) + ' / ' + fmtNum(x.goal) + ' ' + esc(x.unit) + (met ? ' · done' : '') + (st ? ' · ' + st + '-day streak' : '') + '</div></div>' +
      (a > 0 ? '<button class="btn" data-hr="' + x.id + '" aria-label="Reset today: ' + esc(x.title) + '">Reset</button>' : '') +
      (editing ? '<button class="icon" data-hd="' + x.id + '" aria-label="Delete habit: ' + esc(x.title) + '">🗑</button>' : '') + '</div>' +
      '<div class="bar"><i style="width:' + p + '%"></i></div>' +
      '<form class="row" data-hf="' + x.id + '"><input type="text" inputmode="decimal" placeholder="How many ' + esc(x.unit) + '?" aria-label="Amount of ' + esc(x.unit) + ' for ' + esc(x.title) + '"><button class="btn pri" type="submit">Add</button>' + (met ? '' : '<button class="btn" type="button" data-hdone="' + x.id + '" aria-label="Mark done: ' + esc(x.title) + '">Done</button>') + '</form></div>';
  });
  return h + '</section>';
}
function bindToday() {
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  document.querySelectorAll('[data-newhabit]').forEach(b => b.onclick = () => { hform = { id: null, title: '', goal: '1', unit: 'times' }; go('plan'); });
  document.querySelectorAll('[data-newtask]').forEach(b => b.onclick = () => { form = blankForm(); go('plan'); });
  $('#toggleEdit').onclick = () => { editing = !editing; render(); };
  document.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => toggleDone(b.dataset.tc, dkey()));
  document.querySelectorAll('[data-od]').forEach(b => b.onclick = () => { const t = S.tasks.find(x => x.id === b.dataset.od); if (t) toggleDone(t.id, t.date); });
  document.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => { const t = S.tasks.find(x => x.id === b.dataset.mv); if (t) { t.date = dkey(); save(); render(); } });
  document.querySelectorAll('[data-td]').forEach(b => b.onclick = () => removeTask(b.dataset.td));
  document.querySelectorAll('[data-hd]').forEach(b => b.onclick = () => removeHabit(b.dataset.hd));
  document.querySelectorAll('[data-hr]').forEach(b => b.onclick = () => setHabit(b.dataset.hr, () => 0));
  document.querySelectorAll('[data-hdone]').forEach(b => b.onclick = () => { const x = S.habits.find(q => q.id === b.dataset.hdone); if (x) setHabit(x.id, a => Math.max(a, x.goal)); });
  document.querySelectorAll('[data-hf]').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const v = parseNum(f.querySelector('input').value);
    if (!(v > 0) || v > 100000) { toast('Enter an amount greater than 0', null); return; }
    setHabit(f.dataset.hf, a => a + v);
  });
}

/* ---------- Plan: tasks + habits ---------- */
function timeOptions(f) {
  const vals = []; for (let m = 0; m < 1440; m += 15) vals.push(pad(Math.floor(m / 60)) + ':' + pad(m % 60));
  if (f.hasTime && !vals.includes(f.time)) { vals.push(f.time); vals.sort(); }
  return '<option value=""' + (!f.hasTime ? ' selected' : '') + '>All day</option>' + vals.map(v => '<option' + (f.hasTime && f.time === v ? ' selected' : '') + '>' + v + '</option>').join('');
}
function dateOptions(f) {
  return next7().map(d => '<option value="' + d + '"' + (!f.other && f.date === d ? ' selected' : '') + '>' + (d === dkey() ? 'Today' : dayLabel(d)) + '</option>').join('') + '<option value="other"' + (f.other ? ' selected' : '') + '>Other date…</option>';
}
function formHTML() {
  const f = form;
  return '<section class="card" style="gap:10px"><h2>' + (f.id ? 'Edit task' : 'New task') + '</h2>' +
    '<input type="text" id="f-title" value="' + esc(f.title) + '" placeholder="What is it?" aria-label="Title" maxlength="120" autocomplete="off">' +
    '<div class="g2"><div><label class="sub" for="f-type">Type</label><select id="f-type">' + TYPES.map(t => '<option value="' + t[0] + '"' + (f.type === t[0] ? ' selected' : '') + '>' + t[1] + ' ' + t[2] + '</option>').join('') + '</select></div>' +
    '<div><label class="sub" for="f-repeat">Repeat</label><select id="f-repeat">' + REPEATS.map(r => '<option value="' + r[0] + '"' + (f.repeat === r[0] ? ' selected' : '') + '>' + r[1] + '</option>').join('') + '</select></div>' +
    '<div><label class="sub" for="f-date">Date</label><select id="f-date">' + dateOptions(f) + '</select></div>' +
    '<div><label class="sub" for="f-time">Time</label><select id="f-time">' + timeOptions(f) + '</select></div></div>' +
    (f.other ? '<input type="date" id="f-date2" value="' + f.date + '" aria-label="Pick a date">' : '') +
    '<div class="row"><button class="btn pri sp" id="f-save">Save</button><button class="btn" id="f-cancel">Cancel</button>' + (f.id ? '<button class="icon" id="f-del" aria-label="Delete this task">🗑</button>' : '') + '</div></section>';
}
function bindForm() {
  const f = form, q = id => document.getElementById(id);
  q('f-title').oninput = e => { f.title = e.target.value; };
  q('f-type').onchange = e => { f.type = e.target.value; if (f.type !== 'todo' && f.type !== 'trip' && !f.hasTime) f.hasTime = true; render(); };
  q('f-repeat').onchange = e => { f.repeat = e.target.value; };
  q('f-date').onchange = e => { if (e.target.value === 'other') { f.other = true; } else { f.other = false; f.date = e.target.value; } render(); };
  if (q('f-date2')) q('f-date2').onchange = e => { f.date = e.target.value || dkey(); };
  q('f-time').onchange = e => { f.hasTime = e.target.value !== ''; if (f.hasTime) f.time = e.target.value; };
  q('f-save').onclick = saveForm;
  q('f-cancel').onclick = () => { form = null; render(); };
  if (q('f-del')) q('f-del').onclick = () => { const id = f.id; form = null; removeTask(id); };
}
function habitFormHTML() {
  const f = hform;
  return '<section class="card" style="gap:10px"><h2>' + (f.id ? 'Edit habit' : 'New habit') + '</h2>' +
    '<input type="text" id="h-title" value="' + esc(f.title) + '" placeholder="e.g. Read, Run, Brush teeth" aria-label="Habit name" maxlength="60" autocomplete="off">' +
    '<div class="row"><input type="text" inputmode="decimal" id="h-goal" value="' + esc(f.goal) + '" aria-label="Daily goal" style="width:90px"><select id="h-unit" aria-label="Unit">' + UNITS.map(u => '<option' + (f.unit === u ? ' selected' : '') + '>' + u + '</option>').join('') + '</select><span class="sub">per day</span></div>' +
    '<div class="row"><button class="btn pri sp" id="h-save">Save</button><button class="btn" id="h-cancel">Cancel</button></div></section>';
}
function bindHabitForm() {
  const f = hform;
  $('#h-title').oninput = e => { f.title = e.target.value; };
  $('#h-goal').oninput = e => { f.goal = e.target.value; };
  $('#h-unit').onchange = e => { f.unit = e.target.value; };
  $('#h-cancel').onclick = () => { hform = null; render(); };
  $('#h-save').onclick = () => {
    const title = f.title.trim(), goal = parseNum(f.goal);
    if (!title) { toast('Give the habit a name', null); return; }
    if (!(goal > 0) || goal > 100000) { toast('Goal must be greater than 0', null); return; }
    if (f.id) { const x = S.habits.find(q => q.id === f.id); if (x) Object.assign(x, { title: title.slice(0, 60), goal, unit: f.unit }); }
    else S.habits.push({ id: uid(), title: title.slice(0, 60), goal, unit: f.unit, log: {} });
    hform = null; save(); render();
  };
}
function viewPlan() {
  const today = dkey();
  const row = t => '<div class="item"><span aria-hidden="true">' + typeOf(t.type)[1] + '</span><button class="link sp" data-te="' + t.id + '"><div class="title" style="white-space:normal">' + esc(t.title) + '</div><div class="sub">' + esc(taskMeta(t)) + '</div></button>' +
    '<button class="icon" data-td="' + t.id + '" aria-label="Delete: ' + esc(t.title) + '">🗑</button></div>';
  const over = overdue(), oneoff = S.tasks.filter(t => t.repeat === 'none' && t.date >= today && !isDone(t, t.date)).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))), rep = S.tasks.filter(t => t.repeat !== 'none');
  let h = '<div class="row"><h1 class="sp">Plan</h1>' + (form ? '' : '<button class="btn pri" id="newTask">+ New task</button>') + '</div>';
  if (form) h += formHTML();
  h += '<section class="card"><h2 style="padding-bottom:6px">Tasks</h2>';
  if (!over.length && !oneoff.length && !rep.length) h += '<div class="empty">No tasks yet. Tap “+ New task”.</div>';
  if (over.length) h += '<div class="sub" style="color:var(--danger);font-weight:700;padding-top:4px">Overdue</div>' + over.map(row).join('');
  let last = '';
  oneoff.forEach(t => { if (t.date !== last) { last = t.date; h += '<div class="sub" style="font-weight:700;padding-top:10px">' + esc(dayLabel(t.date)) + '</div>'; } h += row(t); });
  if (rep.length) h += '<div class="sub" style="font-weight:700;padding-top:10px">Repeating</div>' + rep.map(row).join('');
  h += '</section>';
  if (hform) h += habitFormHTML();
  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Habits</h2>' + (hform ? '' : '<button class="btn" id="newHabit">+ Add</button>') + '</div>';
  if (!S.habits.length) h += '<div class="empty">No habits yet.</div>';
  S.habits.forEach(x => {
    h += '<div class="item"><button class="link sp" data-he="' + x.id + '"><div class="title" style="white-space:normal">' + esc(x.title) + '</div><div class="sub">' + fmtNum(x.goal) + ' ' + esc(x.unit) + ' per day</div></button>' +
      '<button class="icon" data-hd="' + x.id + '" aria-label="Delete habit: ' + esc(x.title) + '">🗑</button></div>';
  });
  return h + '</section>';
}
function bindPlan() {
  if ($('#newTask')) $('#newTask').onclick = () => { form = blankForm(); render(); };
  if ($('#newHabit')) $('#newHabit').onclick = () => { hform = { id: null, title: '', goal: '1', unit: 'times' }; render(); };
  if (form) bindForm();
  if (hform) bindHabitForm();
  document.querySelectorAll('[data-te]').forEach(b => b.onclick = () => { const t = S.tasks.find(x => x.id === b.dataset.te); if (t) { form = formFrom(t); render(); window.scrollTo(0, 0); } });
  document.querySelectorAll('[data-he]').forEach(b => b.onclick = () => { const x = S.habits.find(q => q.id === b.dataset.he); if (x) { hform = { id: x.id, title: x.title, goal: String(x.goal), unit: x.unit }; render(); window.scrollTo(0, 0); } });
  document.querySelectorAll('[data-td]').forEach(b => b.onclick = () => removeTask(b.dataset.td));
  document.querySelectorAll('[data-hd]').forEach(b => b.onclick = () => removeHabit(b.dataset.hd));
}

/* in-app reminders for tasks with a time (the server covers the locked phone) */
function checkReminders() {
  const now = new Date(), day = dkey(now), mins = now.getHours() * 60 + now.getMinutes();
  tasksFor(day).forEach(t => {
    if (!t.time || isDone(t, day)) return;
    const at = +t.time.slice(0, 2) * 60 + +t.time.slice(3), k = t.id + '@' + day;
    if (mins >= at && mins - at < 60 && !S.notified[k]) {
      S.notified[k] = 1; save();
      if (!pushOn()) notify(typeOf(t.type)[2], t.title, 'task-' + t.id);
      toast(typeOf(t.type)[1] + ' ' + t.title, null);
    }
  });
  const keep = Object.keys(S.notified).filter(k => k.endsWith('@' + day));
  if (keep.length !== Object.keys(S.notified).length) { const n = {}; keep.forEach(k => n[k] = 1); S.notified = n; save(); }
}

/* ---------- pomodoro ---------- */
let wakeLock = null, tick = null;
const phaseLen = p => (p === 'focus' ? S.settings.focus : p === 'brk' ? S.settings.brk : S.settings.long) * 60;
const phaseName = p => p === 'focus' ? 'Focus' : p === 'brk' ? 'Break' : 'Long break';
function remaining() { const T = S.timer; return T.running ? Math.max(0, Math.ceil((T.endsAt - Date.now()) / 1000)) : T.remaining; }
async function lockScreen(on) {
  try {
    if (on && S.settings.wake && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (_) { /* not supported */ }
}
function startTimer() {
  const T = S.timer; if (T.running) return;
  T.endsAt = Date.now() + T.remaining * 1000; T.running = true; T.startedAt = T.startedAt || Date.now();
  save(); lockScreen(true); render();
}
function pauseTimer() {
  const T = S.timer; if (!T.running) return;
  T.remaining = remaining(); T.running = false; save(); lockScreen(false); render();
}
function nextPhase(finished) {
  const T = S.timer;
  if (T.phase === 'focus') {
    if (finished || T.logPartial) {
      const dur = Math.max(1, Math.round((phaseLen('focus') - T.remaining) / 60)) || S.settings.focus;
      S.sessions.push({ id: uid(), start: T.startedAt || Date.now(), dur: finished ? S.settings.focus : dur, taskId: null, label: T.label || 'Focus', free: true });
    }
    T.phase = T.round % 4 === 0 ? 'long' : 'brk';
  } else { T.round = T.phase === 'long' ? 1 : T.round + 1; T.phase = 'focus'; }
  T.running = false; T.remaining = phaseLen(T.phase); T.startedAt = 0; T.logPartial = false;
  save(); lockScreen(false);
}
function finishNow() {
  const T = S.timer, left = remaining(), spent = phaseLen(T.phase) - left;
  if (T.phase === 'focus' && spent >= 60) { T.remaining = left; T.logPartial = true; }
  if (T.phase === 'focus' && spent < 60) { T.logPartial = false; }
  T.running = false; nextPhase(false); render();
}
function resetTimer() { const T = S.timer; T.running = false; T.phase = 'focus'; T.round = 1; T.remaining = phaseLen('focus'); T.startedAt = 0; save(); lockScreen(false); render(); }
function onTick() {
  const T = S.timer;
  if (T.running && remaining() <= 0) {
    const was = T.phase, late = Date.now() - T.endsAt; T.remaining = 0;
    nextPhase(true);
    if (!(pushOn() && late > 5000)) notify(was === 'focus' ? 'Focus complete 🍅' : 'Break is over', was === 'focus' ? 'Time for a break.' : 'Ready for the next round?', 'timer');
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (_) {}
    render(); return;
  }
  const el = $('#clock'); if (el) {
    const r = remaining(); el.textContent = pad(Math.floor(r / 60)) + ':' + pad(r % 60);
    const ring = $('#ring'); if (ring) ring.style.background = ringBg(r);
    const ends = $('#ends'); if (ends) ends.textContent = T.running ? 'Ends at ' + fmtClock(T.endsAt) : 'Paused';
    document.title = T.running ? el.textContent + ' · FocusDay' : 'FocusDay';
  }
}
const ringBg = r => { const T = S.timer, p = Math.round(100 * (1 - r / phaseLen(T.phase))); return 'conic-gradient(' + (T.phase === 'focus' ? 'var(--tom)' : 'var(--ok)') + ' 0 ' + p + '%, var(--track) ' + p + '% 100%)'; };
function viewPomodoro() {
  const T = S.timer, today = dkey(), r = remaining();
  const sess = S.sessions.filter(s => dkey(new Date(s.start)) === today).sort((a, b) => a.start - b.start);
  const total = sess.reduce((a, s) => a + s.dur, 0);
  let h = '<h1>Pomodoro</h1>';
  h += '<section class="card" style="gap:10px"><label class="sub" for="freeIn">What are you focusing on?</label><input type="text" id="freeIn" value="' + esc(T.label) + '" maxlength="60"><div class="chips">' +
    ['Reading emails', 'Admin', 'Learning', 'Planning'].map(c => '<button class="chip" data-chip="' + c + '">' + c + '</button>').join('') + '</div></section>';
  h += '<div class="ring" id="ring" style="background:' + ringBg(r) + '"><div><span class="sub" style="font-weight:600">' + phaseName(T.phase) + ' · Round ' + T.round + '/4</span><span class="time" id="clock">' + pad(Math.floor(r / 60)) + ':' + pad(r % 60) + '</span><span class="sub" id="ends">' + (T.running ? 'Ends at ' + fmtClock(T.endsAt) : 'Ready') + '</span></div></div>';
  h += '<div class="dots" role="img" aria-label="Round ' + T.round + ' of 4">' + [1, 2, 3, 4].map(i => '<i class="' + (i <= T.round ? 'on' : '') + '"></i>').join('') + '</div>';
  h += '<div class="row"><button class="btn big tom sp" id="startPause">' + (T.running ? 'Pause' : (r < phaseLen(T.phase) ? 'Resume' : 'Start')) + '</button><button class="btn big" id="finish" style="width:110px;font-size:14px">' + (T.phase === 'focus' ? 'Finish' : 'Skip') + '</button><button class="btn big" id="reset" style="width:80px;font-size:14px">Reset</button></div>';
  h += '<section class="card"><label class="sw"><span class="sp"><b>Keep screen on</b><div class="sub">Phone stays awake while the timer runs</div></span><input type="checkbox" id="wake" ' + (S.settings.wake ? 'checked' : '') + '></label>' +
    '<label class="sw"><span class="sp"><b>Notify when done</b><div class="sub">Locked-phone alerts need the server</div></span><input type="checkbox" id="ntf" ' + (S.settings.notify ? 'checked' : '') + '></label>' +
    '<div class="item"><span class="sp"><b>Durations (min)</b></span><input type="number" id="dFocus" min="1" max="120" value="' + S.settings.focus + '" aria-label="Focus minutes" style="width:64px"><input type="number" id="dBrk" min="1" max="60" value="' + S.settings.brk + '" aria-label="Break minutes" style="width:64px"><input type="number" id="dLong" min="1" max="90" value="' + S.settings.long + '" aria-label="Long break minutes" style="width:64px"></div></section>';
  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Today\'s sessions</h2><span class="sub" id="tot">' + sess.length + (sess.length === 1 ? ' pomodoro · ' : ' pomodoros · ') + fmtMin(total) + '</span></div>';
  if (!sess.length) h += '<div class="empty">No sessions logged today yet.</div>';
  sess.forEach(s => {
    const t = S.tasks.find(x => x.id === s.taskId), name = s.label || (t ? t.title : 'Focus');
    h += '<div class="item"><span class="sub" style="width:44px">' + fmtClock(s.start) + '</span><span class="title">' + esc(name) + '</span><span class="pill">' + s.dur + ' min</span>' +
      '<button class="icon" data-sd="' + s.id + '" aria-label="Delete session: ' + fmtClock(s.start) + ', ' + esc(name) + '">🗑</button></div>';
  });
  return h + '</section>';
}
function bindPomodoro() {
  const T = S.timer, fi = $('#freeIn');
  fi.onchange = () => { T.label = fi.value.trim() || 'Focus'; fi.value = T.label; save(); };
  document.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { T.label = b.dataset.chip; save(); render(); });
  $('#startPause').onclick = () => { T.label = fi.value.trim() || 'Focus'; T.running ? pauseTimer() : startTimer(); };
  $('#finish').onclick = finishNow; $('#reset').onclick = resetTimer;
  $('#wake').onchange = e => { S.settings.wake = e.target.checked; save(); if (T.running) lockScreen(e.target.checked); };
  $('#ntf').onchange = e => { S.settings.notify = e.target.checked; save(); };
  const dur = (id, k) => { $(id).onchange = e => { const v = Math.min(+e.target.max, Math.max(1, parseInt(e.target.value, 10) || DEFAULT.settings[k])); S.settings[k] = v; e.target.value = v; if (!T.running && !T.startedAt) T.remaining = phaseLen(T.phase); save(); render(); }; };
  dur('#dFocus', 'focus'); dur('#dBrk', 'brk'); dur('#dLong', 'long');
  document.querySelectorAll('[data-sd]').forEach(b => b.onclick = () => {
    const i = S.sessions.findIndex(x => x.id === b.dataset.sd), it = S.sessions[i]; if (i < 0) return;
    S.sessions.splice(i, 1); save(); render(); toast(fmtClock(it.start) + ' session deleted', () => { S.sessions.splice(Math.min(i, S.sessions.length), 0, it); save(); render(); });
  });
}

/* ---------- report ---------- */
function weekDays() { // Monday → Sunday of the current week
  const d = new Date(); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd);
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
}
function viewReport() {
  const days = weekDays(), keys = days.map(d => dkey(d)), names = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const mins = keys.map(k => S.sessions.filter(s => dkey(new Date(s.start)) === k).reduce((a, s) => a + s.dur, 0));
  const totalMin = mins.reduce((a, b) => a + b, 0), maxMin = Math.max(30, ...mins);
  const poms = S.sessions.filter(s => keys.includes(dkey(new Date(s.start)))).length;
  const doneTasks = S.tasks.reduce((n, t) => n + keys.filter(k => isDone(t, k)).length, 0);
  const planned = keys.reduce((n, k) => n + S.tasks.filter(t => occursOn(t, k) && k <= dkey()).length, 0);
  const passed = Math.max(1, keys.filter(k => k <= dkey()).length);
  const best = mins.indexOf(Math.max(...mins));
  let h = '<h1>Weekly report</h1><div class="sub">' + days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + '</div>';
  h += '<section class="card" style="gap:10px"><div class="grid3"><div class="stat"><b>' + fmtMin(totalMin) + '</b><span class="sub">Focus time</span></div><div class="stat"><b>' + poms + '</b><span class="sub">Pomodoros</span></div><div class="stat"><b>' + doneTasks + '/' + planned + '</b><span class="sub">Tasks done</span></div></div>' +
    '<div class="bars" role="img" aria-label="Focus minutes per day">' + mins.map((m, i) => '<div><span>' + (m || '') + '</span><b style="height:' + Math.round(100 * m / maxMin) + '%"></b><span>' + names[i] + '</span></div>').join('') + '</div>' +
    (totalMin ? '<div class="sub">Best day: ' + days[best].toLocaleDateString('en-GB', { weekday: 'long' }) + ' (' + fmtMin(mins[best]) + ')</div>' : '<div class="sub">No focus sessions yet this week.</div>') + '</section>';
  h += '<section class="card"><h2 style="padding-bottom:6px">Habits this week</h2>';
  if (!S.habits.length) h += '<div class="empty">No habits.</div>';
  S.habits.forEach(x => {
    const met = keys.filter(k => habitMet(x, k)).length, tot = keys.reduce((a, k) => a + habitAmt(x, k), 0);
    h += '<div class="item" style="flex-wrap:wrap;padding:8px 0"><span class="title">' + esc(x.title) + '</span><span class="pill" style="color:var(--ok)">' + met + '/' + passed + ' days</span>' +
      '<div class="sub" style="width:100%">Total ' + fmtNum(tot) + ' ' + esc(x.unit) + ' · goal ' + fmtNum(x.goal) + '/day</div>' +
      '<div class="heat" style="width:100%" role="img" aria-label="' + met + ' of ' + passed + ' days done">' + keys.map(k => { const c = habitAmt(x, k); return '<i class="' + (c >= x.goal ? 'l3' : c > 0 ? 'l1' : '') + '"></i>'; }).join('') + '</div></div>';
  });
  h += '</section>';
  const top = {}; S.sessions.filter(s => keys.includes(dkey(new Date(s.start)))).forEach(s => {
    const t = S.tasks.find(x => x.id === s.taskId), n = s.label || (t ? t.title : null); if (n) top[n] = (top[n] || 0) + s.dur;
  });
  const rows = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (rows.length) h += '<section class="card"><h2 style="padding-bottom:6px">Where the time went</h2>' + rows.map(r => '<div class="item"><span class="title">' + esc(r[0]) + '</span><span class="pill">' + fmtMin(r[1]) + '</span></div>').join('') + '</section>';
  return h;
}

/* ---------- settings ---------- */
function viewSettings() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return '<h1>Settings</h1>' +
    '<section class="card" style="gap:10px"><h2>Notifications</h2><div class="sub">Permission: ' + perm + (standalone ? '' : ' · open FocusDay from the Home Screen icon to enable') + '</div>' +
    '<div class="sub">Lock-screen reminders: <b>' + (pushOn() ? 'on' : PUSH_URL ? 'off' : 'server not set up') + '</b></div>' +
    (pushOn() ? '<button class="btn pri" id="testS">Send test from server</button><button class="btn" id="offP">Turn off lock-screen reminders</button>' : '<button class="btn pri" id="perm">Enable lock-screen reminders</button>') +
    '<button class="btn" id="testN">Test local notification</button></section>' +
    '<section class="card" style="gap:10px"><h2>Appearance & Today info</h2>' +
    '<label class="sub" for="s-theme">Theme</label><select id="s-theme">' + [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Automatic']].map(o => '<option value="' + o[0] + '"' + (S.settings.theme === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
    '<label class="sub" for="s-city">Weather city (all 81 provinces)</label><select id="s-city">' + PROVINCES.map(p => p[0]).sort((a, b) => a.localeCompare(b, 'tr')).map(c => '<option' + (S.settings.city === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select>' +
    '<label class="sub" for="s-pair">Exchange rate</label><select id="s-pair">' + PAIRS.map(p => '<option value="' + p.join('/') + '"' + (!customPair && S.settings.base === p[0] && S.settings.quote === p[1] ? ' selected' : '') + '>' + p.join(' / ') + '</option>').join('') + '<option value="custom"' + (customPair || !PAIRS.some(p => p[0] === S.settings.base && p[1] === S.settings.quote) ? ' selected' : '') + '>Other pair…</option></select>' +
    (customPair || !PAIRS.some(p => p[0] === S.settings.base && p[1] === S.settings.quote) ? '<div class="g2"><div><label class="sub" for="s-base">From</label><select id="s-base">' + CURRENCIES.map(c => '<option' + (S.settings.base === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
    '<div><label class="sub" for="s-quote">To</label><select id="s-quote">' + CURRENCIES.map(c => '<option' + (S.settings.quote === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div></div>' : '') +
    '<label class="sub" for="s-zone">Second clock</label><select id="s-zone">' + ZONES.map(z => '<option value="' + z[1] + '"' + (S.settings.zone === z[1] ? ' selected' : '') + '>' + z[0] + '</option>').join('') + '</select></section>' +
    '<section class="card" style="gap:10px"><h2>Backup</h2><div class="sub">Your data lives only on this phone. Export a copy now and then.</div>' +
    '<button class="btn pri" id="exp">Export backup (JSON)</button><label class="btn" style="display:flex;align-items:center;justify-content:center">Import backup<input type="file" id="imp" accept="application/json,.json" hidden></label></section>' +
    '<section class="card" style="gap:10px"><h2>Reset</h2><button class="btn" id="wipe" style="color:var(--danger)">Delete all data</button></section>' +
    '<div class="sub" style="text-align:center">FocusDay 1.0</div>';
}
function bindSettings() {
  if ($('#perm')) $('#perm').onclick = enablePush;
  if ($('#offP')) $('#offP').onclick = disablePush;
  if ($('#testS')) $('#testS').onclick = async () => { await syncNow(); const r = await serverCall('/test', {}).catch(() => ({})); toast(r && r.ok ? 'Sent — check your lock screen' : 'Server could not send (' + (r && (r.status || r.error) || 'no reply') + ')', null); };
  $('#testN').onclick = () => { const p = S.settings.notify; S.settings.notify = true; notify('FocusDay', 'Notifications work 🎉', 'test'); S.settings.notify = p; };
  $('#s-theme').onchange = e => { S.settings.theme = e.target.value; save(); applyTheme(); render(); };
  $('#s-city').onchange = e => { S.settings.city = e.target.value; save(); refreshInfo(true); };
  $('#s-pair').onchange = e => { if (e.target.value === 'custom') { customPair = true; render(); return; } customPair = false; const [b, q] = e.target.value.split('/'); S.settings.base = b; S.settings.quote = q; save(); refreshInfo(true); render(); };
  if ($('#s-base')) $('#s-base').onchange = e => { S.settings.base = e.target.value; save(); refreshInfo(true); };
  if ($('#s-quote')) $('#s-quote').onchange = e => { S.settings.quote = e.target.value; save(); refreshInfo(true); };
  $('#s-zone').onchange = e => { S.settings.zone = e.target.value; save(); };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'focusday-backup-' + dkey() + '.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('#imp').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.habits) || !Array.isArray(d.sessions)) throw new Error('bad');
        if (!confirm('Replace current data with this backup?')) return;
        localStorage.setItem(KEY, JSON.stringify(d)); load(); toast('Backup restored', null); render();
      } catch (_) { toast('That file is not a FocusDay backup', null); }
    };
    r.readAsText(f);
  };
  $('#wipe').onclick = () => { if (confirm('Delete ALL data? This cannot be undone.')) { localStorage.removeItem(KEY); load(); toast('All data deleted', null); render(); } };
}

/* ---------- shell ---------- */
const TABS = [['today', '☀️', 'Today'], ['plan', '🗓', 'Plan'], ['pomodoro', '⏱', 'Pomodoro'], ['report', '📊', 'Report'], ['settings', '⚙️', 'Settings']];
let tab = (location.hash || '#today').slice(1);
if (!TABS.find(t => t[0] === tab)) tab = 'today';
function go(t) { tab = t; location.hash = t; editing = false; window.scrollTo(0, 0); render(); }
function render() {
  const view = $('#view'), views = { today: viewToday, plan: viewPlan, pomodoro: viewPomodoro, report: viewReport, settings: viewSettings };
  const y = window.scrollY; view.innerHTML = views[tab]();
  ({ today: bindToday, plan: bindPlan, pomodoro: bindPomodoro, settings: bindSettings }[tab] || (() => {}))();
  $('#nav').innerHTML = TABS.map(t => '<button data-tab="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</button>').join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => go(b.dataset.tab));
  window.scrollTo(0, y);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); applyTheme(); refreshInfo(); if (S.timer.running) lockScreen(true); onTick(); render(); checkReminders(); } });
setInterval(onTick, 500);
setInterval(checkReminders, 20000);
setInterval(updateInfo, 30000);
render(); checkReminders(); refreshInfo();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
