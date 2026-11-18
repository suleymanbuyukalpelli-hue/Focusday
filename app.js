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
const REPEATS = [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const UNITS = ['pages', 'km', 'min', 'hours', 'times', 'glasses', 'count'];
const typeOf = id => TYPES.find(t => t[0] === id) || TYPES[0];

const DEFAULT = {
  tasks: [], habits: [
    { id: uid(), title: 'Read', goal: 20, unit: 'pages', log: {} },
    { id: uid(), title: 'Run', goal: 1, unit: 'km', log: {} },
    { id: uid(), title: 'Brush teeth', goal: 3, unit: 'times', log: {} }
  ], sessions: [], notified: {},
  settings: { focus: 25, brk: 5, long: 15, wake: true, notify: true },
  timer: { phase: 'focus', running: false, endsAt: 0, remaining: 25 * 60, round: 1, taskId: null, free: false, label: 'Reading emails' }
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
function migrate() { // older versions: tasks without date/type, separate reminders, habits without unit
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
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) { toast('Storage is full or blocked', null); } scheduleSync(); }
load();

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
const blankForm = () => ({ id: null, title: '', type: 'todo', date: dkey(), hasTime: false, time: '09:00', repeat: 'none', est: 0 });
function formFrom(t) { return { id: t.id, title: t.title, type: t.type, date: t.date, hasTime: !!t.time, time: t.time || '09:00', repeat: t.repeat, est: t.est || 0 }; }
function saveForm() {
  const f = form, title = f.title.trim(); if (!title) { toast('Give the task a title', null); return; }
  const rec = { title: title.slice(0, 120), type: f.type, date: f.date || dkey(), time: f.hasTime ? f.time : '', repeat: f.repeat, est: f.type === 'todo' ? +f.est || 0 : 0 };
  if (f.id) { const t = S.tasks.find(x => x.id === f.id); if (t) Object.assign(t, rec); }
  else S.tasks.push(Object.assign({ id: uid(), doneDays: {}, created: Date.now() }, rec));
  form = null; save(); render();
}

/* ---------- Today: summary ---------- */
function viewToday() {
  const today = dkey(), list = tasksFor(today), over = overdue();
  const tDone = list.filter(t => isDone(t, today)).length, hMet = S.habits.filter(h => habitMet(h, today)).length;
  const total = list.length + S.habits.length, done = tDone + hMet, pct = total ? Math.round(100 * done / total) : 0;
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const dayStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const focus = S.sessions.filter(s => dkey(new Date(s.start)) === today).reduce((a, s) => a + s.dur, 0);
  let h = '<div><h1>' + greet + '</h1><div class="sub">' + esc(dayStr) + '</div></div>';
  h += '<section class="card" style="gap:10px"><div class="row"><h2 class="sp">Today at a glance</h2><b style="font-size:22px">' + pct + '%</b></div>' +
    '<div class="bar" role="img" aria-label="' + pct + ' percent done"><i style="width:' + pct + '%"></i></div>' +
    '<div class="sub">' + (total ? done + ' of ' + total + ' done' : 'Nothing planned yet') + (over.length ? ' · ' + over.length + ' overdue' : '') + '</div>' +
    '<div class="grid3"><div class="stat"><b>' + tDone + '/' + list.length + '</b><span class="sub">Tasks</span></div><div class="stat"><b>' + hMet + '/' + S.habits.length + '</b><span class="sub">Habits</span></div><div class="stat"><b>' + fmtMin(focus) + '</b><span class="sub">Focus</span></div></div></section>';
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
    const d = isDone(t, today), pomos = S.sessions.filter(s => s.taskId === t.id).length;
    h += '<div class="item ' + (d ? 'done' : '') + '"><button class="chk ' + (d ? 'on' : '') + '" role="checkbox" aria-checked="' + d + '" aria-label="' + esc(t.title) + '" data-tc="' + t.id + '">' + (d ? '✓' : '') + '</button>' +
      '<div class="sp"><div class="title" style="white-space:normal">' + typeOf(t.type)[1] + ' ' + esc(t.title) + '</div><div class="sub">' + (t.time || 'All day') + (t.repeat !== 'none' ? ' · ' + repeatLabel(t.repeat) : '') + '</div></div>' +
      (t.est ? '<span class="pill">' + pomos + '/' + t.est + ' 🍅</span>' : '') +
      (editing ? '<button class="icon" data-td="' + t.id + '" aria-label="Delete: ' + esc(t.title) + '">🗑</button>' : '') + '</div>';
  });
  h += '</section>';

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Habits</h2></div>';
  if (!S.habits.length) h += '<div class="empty">No habits yet — add one in Plan.</div>';
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
function formHTML() {
  const f = form;
  let h = '<section class="card" style="gap:10px"><h2>' + (f.id ? 'Edit task' : 'New task') + '</h2>' +
    '<input type="text" id="f-title" value="' + esc(f.title) + '" placeholder="What is it?" aria-label="Title" maxlength="120" autocomplete="off">' +
    '<div class="chips" role="group" aria-label="Type">' + TYPES.map(t => '<button type="button" class="chip ' + (f.type === t[0] ? 'sel' : '') + '" aria-pressed="' + (f.type === t[0]) + '" data-ftype="' + t[0] + '">' + t[1] + ' ' + t[2] + '</button>').join('') + '</div>' +
    '<div class="row"><input type="date" id="f-date" value="' + f.date + '" aria-label="Date" style="flex:1"><button type="button" class="chip" data-fq="0">Today</button><button type="button" class="chip" data-fq="1">Tomorrow</button></div>' +
    '<div class="seg" role="group" aria-label="Time"><button type="button" class="' + (!f.hasTime ? 'on' : '') + '" data-ft="0">All day</button><button type="button" class="' + (f.hasTime ? 'on' : '') + '" data-ft="1">Set a time</button></div>' +
    (f.hasTime ? '<input type="time" id="f-time" value="' + f.time + '" aria-label="Time">' : '') +
    '<label class="sub" for="f-repeat">Repeat</label><select id="f-repeat">' + REPEATS.map(r => '<option value="' + r[0] + '"' + (f.repeat === r[0] ? ' selected' : '') + '>' + r[1] + '</option>').join('') + '</select>' +
    (f.type === 'todo' ? '<label class="sub" for="f-est">Pomodoros needed</label><select id="f-est">' + [0, 1, 2, 3, 4, 5, 6, 8].map(n => '<option value="' + n + '"' + (+f.est === n ? ' selected' : '') + '>' + (n || 'Not set') + '</option>').join('') + '</select>' : '') +
    '<div class="row"><button class="btn pri sp" id="f-save">Save</button><button class="btn" id="f-cancel">Cancel</button>' + (f.id ? '<button class="icon" id="f-del" aria-label="Delete this task">🗑</button>' : '') + '</div></section>';
  return h;
}
function bindForm() {
  const f = form, q = id => document.getElementById(id);
  q('f-title').oninput = e => { f.title = e.target.value; };
  q('f-date').onchange = e => { f.date = e.target.value || dkey(); };
  if (q('f-time')) q('f-time').onchange = e => { f.time = e.target.value || '09:00'; };
  q('f-repeat').onchange = e => { f.repeat = e.target.value; };
  if (q('f-est')) q('f-est').onchange = e => { f.est = +e.target.value; };
  document.querySelectorAll('[data-ftype]').forEach(b => b.onclick = () => { f.type = b.dataset.ftype; if (f.type !== 'todo') f.est = 0; if (f.type !== 'todo' && !f.hasTime && f.type !== 'trip') f.hasTime = true; render(); });
  document.querySelectorAll('[data-fq]').forEach(b => b.onclick = () => { const d = new Date(); d.setDate(d.getDate() + +b.dataset.fq); f.date = dkey(d); render(); });
  document.querySelectorAll('[data-ft]').forEach(b => b.onclick = () => { f.hasTime = b.dataset.ft === '1'; render(); });
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
      S.sessions.push({ id: uid(), start: T.startedAt || Date.now(), dur: finished ? S.settings.focus : dur, taskId: T.free ? null : T.taskId, label: T.free ? T.label : null, free: !!T.free });
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
const ringBg = r => { const T = S.timer, p = Math.round(100 * (1 - r / phaseLen(T.phase))); return 'conic-gradient(' + (T.phase === 'focus' ? 'var(--tom)' : 'var(--ok)') + ' 0 ' + p + '%, #E4E7EC ' + p + '% 100%)'; };
function viewPomodoro() {
  const T = S.timer, today = dkey(), r = remaining();
  const sess = S.sessions.filter(s => dkey(new Date(s.start)) === today).sort((a, b) => a.start - b.start);
  const total = sess.reduce((a, s) => a + s.dur, 0);
  const open = tasksFor(today).filter(t => t.type === 'todo' && !isDone(t, today)).concat(overdue().filter(t => t.type === 'todo'));
  if (!T.free && !open.find(t => t.id === T.taskId)) T.taskId = open[0] ? open[0].id : null;
  let h = '<h1>Pomodoro</h1>';
  h += '<section class="card" style="gap:10px"><div class="seg" role="group" aria-label="Focus target"><button data-mode="task" class="' + (!T.free ? 'on' : '') + '" aria-pressed="' + !T.free + '">Task</button><button data-mode="free" class="' + (T.free ? 'on' : '') + '" aria-pressed="' + !!T.free + '">Free focus</button></div>';
  if (!T.free) {
    h += open.length ? '<label class="sub" for="taskSel">Working on</label><select id="taskSel">' + open.map(t => '<option value="' + t.id + '"' + (t.id === T.taskId ? ' selected' : '') + '>' + esc(t.title) + '</option>').join('') + '</select>' : '<div class="sub">No open tasks — add one on Today, or use Free focus.</div>';
  } else {
    h += '<label class="sub" for="freeIn">What are you focusing on?</label><input type="text" id="freeIn" value="' + esc(T.label) + '" maxlength="60"><div class="chips">' +
      ['Reading emails', 'Admin', 'Learning', 'Planning'].map(c => '<button class="chip" data-chip="' + c + '">' + c + '</button>').join('') + '</div><div class="sub">Counts toward your total focus time, not toward any task.</div>';
  }
  h += '</section>';
  h += '<div class="ring" id="ring" style="background:' + ringBg(r) + '"><div><span class="sub" style="font-weight:600">' + phaseName(T.phase) + ' · Round ' + T.round + '/4</span><span class="time" id="clock">' + pad(Math.floor(r / 60)) + ':' + pad(r % 60) + '</span><span class="sub" id="ends">' + (T.running ? 'Ends at ' + fmtClock(T.endsAt) : 'Ready') + '</span></div></div>';
  h += '<div class="dots" role="img" aria-label="Round ' + T.round + ' of 4">' + [1, 2, 3, 4].map(i => '<i class="' + (i <= T.round ? 'on' : '') + '"></i>').join('') + '</div>';
  h += '<div class="row"><button class="btn big tom sp" id="startPause">' + (T.running ? 'Pause' : (r < phaseLen(T.phase) ? 'Resume' : 'Start')) + '</button><button class="btn big" id="finish" style="width:110px;font-size:14px">' + (T.phase === 'focus' ? 'Finish' : 'Skip') + '</button><button class="btn big" id="reset" style="width:80px;font-size:14px">Reset</button></div>';
  h += '<section class="card"><label class="sw"><span class="sp"><b>Keep screen on</b><div class="sub">Phone stays awake while the timer runs</div></span><input type="checkbox" id="wake" ' + (S.settings.wake ? 'checked' : '') + '></label>' +
    '<label class="sw"><span class="sp"><b>Notify when done</b><div class="sub">Works while the app is open; locked-phone alerts need the server</div></span><input type="checkbox" id="ntf" ' + (S.settings.notify ? 'checked' : '') + '></label>' +
    '<div class="item"><span class="sp"><b>Durations (min)</b></span><input type="number" id="dFocus" min="1" max="120" value="' + S.settings.focus + '" aria-label="Focus minutes" style="width:64px"><input type="number" id="dBrk" min="1" max="60" value="' + S.settings.brk + '" aria-label="Break minutes" style="width:64px"><input type="number" id="dLong" min="1" max="90" value="' + S.settings.long + '" aria-label="Long break minutes" style="width:64px"></div></section>';
  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Today\'s sessions</h2><span class="sub" id="tot">' + sess.length + (sess.length === 1 ? ' pomodoro · ' : ' pomodoros · ') + fmtMin(total) + '</span></div>';
  if (!sess.length) h += '<div class="empty">No sessions logged today yet.</div>';
  sess.forEach(s => {
    const t = S.tasks.find(x => x.id === s.taskId), name = s.free ? s.label : (t ? t.title : 'Deleted task');
    h += '<div class="item"><span class="sub" style="width:44px">' + fmtClock(s.start) + '</span><span class="title">' + esc(name) + '</span>' + (s.free ? '<span class="pill" style="color:var(--acc)">Free</span>' : '') + '<span class="pill">' + s.dur + ' min</span>' +
      '<button class="icon" data-sd="' + s.id + '" aria-label="Delete session: ' + fmtClock(s.start) + ', ' + esc(name) + '">🗑</button></div>';
  });
  return h + '</section>';
}
function bindPomodoro() {
  const T = S.timer;
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { T.free = b.dataset.mode === 'free'; save(); render(); });
  const sel = $('#taskSel'); if (sel) sel.onchange = () => { T.taskId = sel.value; save(); };
  const fi = $('#freeIn'); if (fi) fi.onchange = () => { T.label = fi.value.trim() || 'Free focus'; fi.value = T.label; save(); };
  document.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => { T.label = b.dataset.chip; save(); render(); });
  $('#startPause').onclick = () => { if (fi) { T.label = fi.value.trim() || 'Free focus'; } T.running ? pauseTimer() : startTimer(); };
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
    const t = S.tasks.find(x => x.id === s.taskId), n = s.free ? s.label : (t ? t.title : null); if (n) top[n] = (top[n] || 0) + s.dur;
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); if (S.timer.running) lockScreen(true); onTick(); render(); checkReminders(); } });
setInterval(onTick, 500);
setInterval(checkReminders, 20000);
render(); checkReminders();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
