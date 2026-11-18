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

const DEFAULT = {
  tasks: [], habits: [
    { id: uid(), title: 'Drink water', goal: 8, log: {} },
    { id: uid(), title: 'Read 20 pages', goal: 1, log: {} }
  ], reminders: [], sessions: [], notified: {},
  settings: { focus: 25, brk: 5, long: 15, wake: true, notify: true },
  timer: { phase: 'focus', running: false, endsAt: 0, remaining: 25 * 60, round: 1, taskId: null, free: false, label: 'Reading emails' }
};
let S;
function load() {
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (_) { S = null; }
  S = Object.assign(JSON.parse(JSON.stringify(DEFAULT)), S || {});
  S.settings = Object.assign({}, DEFAULT.settings, S.settings);
  S.timer = Object.assign({}, DEFAULT.timer, S.timer);
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) { toast('Storage is full or blocked', null); } scheduleSync(); }
load();

/* ---------- push server (lock-screen reminders) ---------- */
const PUSH_URL = 'https://focusday-push.suleymanbuyukalpelli.workers.dev'; // Cloudflare Worker (source: server/worker.js)
const SUBKEY = 'focusday.pushsub', DEVKEY = 'focusday.dev';
function pushSub() { try { return JSON.parse(localStorage.getItem(SUBKEY)); } catch (_) { return null; } }
function pushOn() { return !!(PUSH_URL && pushSub()); }
function deviceId() {
  let d = localStorage.getItem(DEVKEY);
  if (!d) { d = Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 28) + uid() + uid(); localStorage.setItem(DEVKEY, d); }
  return d;
}
const bytesToB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
      reminders: S.reminders.map(r => ({ id: r.id, title: r.title, time: r.time })),
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
    const { key } = await (await fetch(PUSH_URL + '/vapid-public-key')).json(); // server creates and keeps its own key pair
    let sub = await reg.pushManager.getSubscription();
    const cur = sub && sub.options && sub.options.applicationServerKey;
    if (sub && cur && bytesToB64u(cur) !== key) { await sub.unsubscribe(); sub = null; } // server key changed: subscribe again
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
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

/* ---------- habits ---------- */
function habitCount(h, day) { return h.log[day] || 0; }
function habitStreak(h) {
  let n = 0; const d = new Date();
  if (habitCount(h, dkey(d)) < h.goal) d.setDate(d.getDate() - 1); // today may still be in progress
  while (habitCount(h, dkey(d)) >= h.goal) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function bumpHabit(id, delta) {
  const h = S.habits.find(x => x.id === id); if (!h) return;
  const k = dkey(); h.log[k] = Math.max(0, habitCount(h, k) + delta);
  save(); render();
}

/* ---------- today view ---------- */
let editing = false;
function viewToday() {
  const today = dkey();
  const open = S.tasks.filter(t => !t.done), done = S.tasks.filter(t => t.done && t.doneDay === today);
  const rem = S.reminders.slice().sort((a, b) => a.time.localeCompare(b.time));
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const dayStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const focusToday = S.sessions.filter(s => dkey(new Date(s.start)) === today).reduce((a, s) => a + s.dur, 0);
  let h = '<div><h1>' + greet + '</h1><div class="sub">' + esc(dayStr) + ' · focus today ' + fmtMin(focusToday) + '</div></div>';
  if (new Date().getDay() === 0) h += '<div class="banner">It\'s Sunday — your weekly report is ready in the Report tab.</div>';

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Habits</h2><button class="btn" id="addHabit">Add</button></div>';
  if (!S.habits.length) h += '<div class="empty">No habits yet.</div>';
  S.habits.forEach(x => {
    const c = habitCount(x, today), ok = c >= x.goal, st = habitStreak(x);
    h += '<div class="item ' + (ok ? 'done' : '') + '"><div class="sp"><div class="title" style="white-space:normal">' + esc(x.title) + '</div><div class="sub">' + c + ' / ' + x.goal + (st ? ' · ' + st + '-day streak' : '') + '</div></div>' +
      '<button class="btn" data-hm="' + x.id + '" aria-label="Remove one: ' + esc(x.title) + '">−</button>' +
      '<button class="btn pri" data-hp="' + x.id + '" aria-label="Add one: ' + esc(x.title) + '">+1</button>' +
      (editing ? '<button class="icon" data-hd="' + x.id + '" aria-label="Delete habit: ' + esc(x.title) + '">🗑</button>' : '') + '</div>';
  });
  h += '</section>';

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Tasks</h2><button class="btn" id="toggleEdit">' + (editing ? 'Done' : 'Edit') + '</button></div>';
  h += '<form class="row" id="taskForm" style="padding-bottom:8px"><input type="text" id="taskIn" placeholder="New task (add !3 = 3 pomodoros)" aria-label="New task" autocomplete="off"><button class="btn pri" type="submit">Add</button></form>';
  if (!open.length && !done.length) h += '<div class="empty">Nothing left for today.</div>';
  open.concat(done).forEach(t => {
    const pomos = S.sessions.filter(s => s.taskId === t.id).length;
    h += '<div class="item ' + (t.done ? 'done' : '') + '"><button class="chk ' + (t.done ? 'on' : '') + '" role="checkbox" aria-checked="' + !!t.done + '" aria-label="' + esc(t.title) + '" data-tc="' + t.id + '">' + (t.done ? '✓' : '') + '</button>' +
      '<span class="title">' + esc(t.title) + '</span>' + (t.est ? '<span class="pill">' + pomos + '/' + t.est + ' 🍅</span>' : '') +
      (editing ? '<button class="icon" data-td="' + t.id + '" aria-label="Delete: ' + esc(t.title) + '">🗑</button>' : '') + '</div>';
  });
  h += '</section>';

  h += '<section class="card"><div class="row" style="padding-bottom:6px"><h2 class="sp">Reminders</h2></div>' +
    '<form class="row" id="remForm" style="padding-bottom:8px;flex-wrap:wrap"><input type="text" id="remIn" placeholder="Reminder" aria-label="Reminder text" style="flex:2;min-width:140px"><input type="time" id="remTime" value="09:00" aria-label="Reminder time" style="flex:1;min-width:120px"><button class="btn pri" type="submit">Add</button></form>';
  if (!rem.length) h += '<div class="empty">No reminders.</div>';
  rem.forEach(r => {
    h += '<div class="item"><span class="pill" style="color:var(--acc)">' + esc(r.time) + '</span><span class="title">' + esc(r.title) + '</span>' +
      '<button class="icon" data-rd="' + r.id + '" aria-label="Delete reminder: ' + esc(r.title) + '">🗑</button></div>';
  });
  h += '</section>';
  return h;
}
function bindToday() {
  $('#toggleEdit').onclick = () => { editing = !editing; render(); };
  $('#addHabit').onclick = () => {
    const name = prompt('Habit name'); if (!name || !name.trim()) return;
    const goal = parseInt(prompt('Daily goal (count)', '1'), 10);
    S.habits.push({ id: uid(), title: name.trim().slice(0, 60), goal: goal > 0 ? Math.min(goal, 99) : 1, log: {} }); save(); render();
  };
  document.querySelectorAll('[data-hp]').forEach(b => b.onclick = () => bumpHabit(b.dataset.hp, 1));
  document.querySelectorAll('[data-hm]').forEach(b => b.onclick = () => bumpHabit(b.dataset.hm, -1));
  document.querySelectorAll('[data-hd]').forEach(b => b.onclick = () => {
    const i = S.habits.findIndex(x => x.id === b.dataset.hd), it = S.habits[i]; if (i < 0) return;
    S.habits.splice(i, 1); save(); render(); toast('"' + it.title + '" deleted', () => { S.habits.splice(Math.min(i, S.habits.length), 0, it); save(); render(); });
  });
  $('#taskForm').onsubmit = e => {
    e.preventDefault();
    let v = $('#taskIn').value.trim(); if (!v) return;
    let est = 0; const m = v.match(/\s*!(\d)\s*$/); if (m) { est = +m[1]; v = v.slice(0, m.index).trim(); }
    if (!v) return;
    S.tasks.push({ id: uid(), title: v.slice(0, 120), est, done: false, created: Date.now() }); save(); render();
    $('#taskIn').focus();
  };
  document.querySelectorAll('[data-tc]').forEach(b => b.onclick = () => {
    const t = S.tasks.find(x => x.id === b.dataset.tc); if (!t) return;
    t.done = !t.done; t.doneDay = t.done ? dkey() : null; save(); render();
  });
  document.querySelectorAll('[data-td]').forEach(b => b.onclick = () => {
    const i = S.tasks.findIndex(x => x.id === b.dataset.td), it = S.tasks[i]; if (i < 0) return;
    S.tasks.splice(i, 1); save(); render();
    toast('"' + it.title + '" deleted', () => { S.tasks.splice(Math.min(i, S.tasks.length), 0, it); save(); render(); });
  });
  $('#remForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#remIn').value.trim(), t = $('#remTime').value; if (!v || !t) return;
    S.reminders.push({ id: uid(), title: v.slice(0, 100), time: t }); save(); render();
  };
  document.querySelectorAll('[data-rd]').forEach(b => b.onclick = () => {
    const i = S.reminders.findIndex(x => x.id === b.dataset.rd), it = S.reminders[i]; if (i < 0) return;
    S.reminders.splice(i, 1); save(); render();
    toast('Reminder deleted', () => { S.reminders.splice(Math.min(i, S.reminders.length), 0, it); save(); render(); });
  });
}

/* reminders fire while the app is open; the server (later) covers the locked phone */
function checkReminders() {
  const now = new Date(), day = dkey(now), hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  S.reminders.forEach(r => {
    const k = r.id + '@' + day;
    if (r.time <= hm && !S.notified[k] && now.getHours() * 60 + now.getMinutes() - (+r.time.slice(0, 2) * 60 + +r.time.slice(3)) < 60) {
      S.notified[k] = 1; save(); if (!pushOn()) notify('Reminder', r.title, 'rem-' + r.id); toast('⏰ ' + r.title, null);
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
  const open = S.tasks.filter(t => !t.done);
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
  const doneTasks = S.tasks.filter(t => t.done && keys.includes(t.doneDay)).length;
  const hab = S.habits.map(h => ({ h, days: keys.filter(k => habitCount(h, k) >= h.goal).length }));
  const passed = Math.max(1, keys.filter(k => k <= dkey()).length);
  const best = mins.indexOf(Math.max(...mins));
  let h = '<h1>Weekly report</h1><div class="sub">' + days[0].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' – ' + days[6].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + '</div>';
  h += '<section class="card" style="gap:10px"><div class="grid3"><div class="stat"><b>' + fmtMin(totalMin) + '</b><span class="sub">Focus time</span></div><div class="stat"><b>' + poms + '</b><span class="sub">Pomodoros</span></div><div class="stat"><b>' + doneTasks + '</b><span class="sub">Tasks done</span></div></div>' +
    '<div class="bars" role="img" aria-label="Focus minutes per day">' + mins.map((m, i) => '<div><span>' + (m || '') + '</span><b style="height:' + Math.round(100 * m / maxMin) + '%"></b><span>' + names[i] + '</span></div>').join('') + '</div>' +
    (totalMin ? '<div class="sub">Best day: ' + days[best].toLocaleDateString('en-GB', { weekday: 'long' }) + ' (' + fmtMin(mins[best]) + ')</div>' : '<div class="sub">No focus sessions yet this week.</div>') + '</section>';
  h += '<section class="card"><h2 style="padding-bottom:6px">Habits this week</h2>';
  if (!hab.length) h += '<div class="empty">No habits.</div>';
  hab.forEach(x => {
    h += '<div class="item" style="flex-wrap:wrap;padding:8px 0"><span class="title">' + esc(x.h.title) + '</span><span class="pill" style="color:var(--ok)">' + x.days + '/' + passed + ' days</span>' +
      '<div class="heat" style="width:100%" role="img" aria-label="' + x.days + ' of ' + passed + ' days done">' + keys.map(k => { const c = habitCount(x.h, k); return '<i class="' + (c >= x.h.goal ? 'l3' : c > 0 ? 'l1' : '') + '"></i>'; }).join('') + '</div></div>';
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
const TABS = [['today', '☀️', 'Today'], ['pomodoro', '⏱', 'Pomodoro'], ['report', '📊', 'Report'], ['settings', '⚙️', 'Settings']];
let tab = (location.hash || '#today').slice(1);
if (!TABS.find(t => t[0] === tab)) tab = 'today';
function render() {
  const view = $('#view'), views = { today: viewToday, pomodoro: viewPomodoro, report: viewReport, settings: viewSettings };
  const y = window.scrollY; view.innerHTML = views[tab]();
  ({ today: bindToday, pomodoro: bindPomodoro, settings: bindSettings }[tab] || (() => {}))();
  $('#nav').innerHTML = TABS.map(t => '<button data-tab="' + t[0] + '" class="' + (t[0] === tab ? 'on' : '') + '"' + (t[0] === tab ? ' aria-current="page"' : '') + '><span aria-hidden="true">' + t[1] + '</span>' + t[2] + '</button>').join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; location.hash = tab; editing = false; window.scrollTo(0, 0); render(); });
  window.scrollTo(0, y);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); if (S.timer.running) lockScreen(true); onTick(); render(); checkReminders(); } });
setInterval(onTick, 500);
setInterval(checkReminders, 20000);
render(); checkReminders();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
