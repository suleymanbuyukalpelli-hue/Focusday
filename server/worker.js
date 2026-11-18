// src/webpush.js
var enc = new TextEncoder();
var b64u = {
  enc: (buf) => {
    let s = "";
    new Uint8Array(buf).forEach((b) => {
      s += String.fromCharCode(b);
    });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
};
var cat = (...a) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  a.forEach((x) => {
    o.set(x, p);
    p += x.length;
  });
  return o;
};
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function encryptPayload(sub, plaintext) {
  const uaPub = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = cat(enc.encode(plaintext), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidHeader(endpoint, privateJWK, publicKeyB64u, subject) {
  const jwk = typeof privateJWK === "string" ? JSON.parse(privateJWK) : privateJWK;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1e3) + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return "vapid t=" + head + "." + body + "." + b64u.enc(sig) + ", k=" + publicKeyB64u;
}
async function sendWebPush({ sub, payload, privateJWK, publicKey, subject, ttl = 3600, urgency = "high" }) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const Authorization = await vapidHeader(sub.endpoint, privateJWK, publicKey, subject);
  return fetch(sub.endpoint, { method: "POST", headers: { Authorization, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: urgency }, body });
}

// src/worker.js
var ALLOWED_ORIGIN = "https://suleymanbuyukalpelli-hue.github.io";
var CONTACT = "https://github.com/suleymanbuyukalpelli-hue/Focusday";
var cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
var json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
function localParts(ms, tz) {
  let f;
  try {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch (_) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => {
    p[x.type] = x.value;
  });
  return { day: p.year + "-" + p.month + "-" + p.day, min: +p.hour * 60 + +p.minute };
}
var dowOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
var domOf = (day) => +day.slice(8, 10);
function occursOn(r, day) {
  const start = r.date || "0000-01-01", rep = r.repeat || (r.date ? "none" : "daily");
  if (day < start) return false;
  switch (rep) {
    case "daily":
      return true;
    case "weekdays": {
      const w = dowOf(day);
      return w >= 1 && w <= 5;
    }
    case "weekly":
      return dowOf(day) === dowOf(start);
    case "monthly":
      return domOf(day) === domOf(start);
    default:
      return day === start;
  }
}
function dueMessages(dev, nowMs) {
  const out = [], { day, min } = localParts(nowMs, dev.tz);
  dev.sent = dev.sent || {};
  (dev.reminders || []).forEach((r) => {
    const m = /^(\d{2}):(\d{2})$/.exec(r.time || "");
    if (!m) return;
    const at = +m[1] * 60 + +m[2], key = r.id + "@" + day;
    if (!occursOn(r, day) || (r.done || []).includes(day)) return;
    if (min >= at && min - at < 15 && !dev.sent[key]) out.push({ title: r.kind || "Reminder", body: String(r.title).slice(0, 120), tag: "task-" + r.id, mark: key });
  });
  const t = dev.timer;
  if (t && t.endsAt && t.endsAt <= nowMs && nowMs - t.endsAt < 30 * 6e4 && !t.sent) {
    out.push({ title: t.phase === "focus" ? "Focus complete \u{1F345}" : "Break is over", body: t.phase === "focus" ? "Time for a break." : "Ready for the next round?", tag: "timer", timer: true });
  }
  Object.keys(dev.sent).forEach((k) => {
    if (!k.endsWith("@" + day)) delete dev.sent[k];
  });
  return out;
}
var VAPID_PUBLIC = "BMmOAKt8mkdnZjmP3ev5nNZdTP4qDwerEc4irojjlxt__SmvXWo1FPXM8pgH4OmFc0AbWdrjcHB3oiO8InVjsOE";
var sendPush = (env, sub, payload) => sendWebPush({ sub, payload, privateJWK: env.VAPID_PRIVATE, publicKey: VAPID_PUBLIC, subject: CONTACT });
async function runCron(env, nowMs = Date.now(), send = sendPush) {
  let cursor, n = 0;
  do {
    const page = await env.KV.list({ prefix: "d:", cursor });
    for (const k of page.keys) {
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      const dev = JSON.parse(raw), due = dueMessages(dev, nowMs);
      if (!due.length) continue;
      let dead = false;
      for (const m of due) {
        try {
          const r = await send(env, dev.sub, { title: m.title, body: m.body, tag: m.tag });
          if (r.status === 404 || r.status === 410) {
            dead = true;
            break;
          }
          if (r.status >= 200 && r.status < 300) {
            if (m.mark) dev.sent[m.mark] = 1;
            if (m.timer) dev.timer.sent = true;
            n++;
          }
        } catch (_) {
        }
      }
      if (dead) await env.KV.delete(k.name);
      else await env.KV.put(k.name, JSON.stringify(dev), { expirationTtl: 60 * 86400 });
    }
    cursor = page.list_complete ? void 0 : page.cursor;
  } while (cursor);
  return n;
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/health") return json({ ok: true });
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  if (request.headers.get("Origin") && request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
  let b;
  try {
    b = await request.json();
  } catch (_) {
    return json({ error: "bad json" }, 400);
  }
  if (!b || typeof b.deviceId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(b.deviceId)) return json({ error: "bad deviceId" }, 400);
  const key = "d:" + b.deviceId;
  if (url.pathname === "/unsubscribe") {
    await env.KV.delete(key);
    return json({ ok: true });
  }
  if (url.pathname === "/sync") {
    const s = b.sub;
    if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "bad subscription" }, 400);
    const old = JSON.parse(await env.KV.get(key) || "{}");
    const reminders = (Array.isArray(b.reminders) ? b.reminders : []).slice(0, 100).map((r) => ({ id: String(r.id).slice(0, 20), title: String(r.title).slice(0, 120), kind: String(r.kind || "Reminder").slice(0, 20), time: String(r.time), date: /^\\d{4}-\\d{2}-\\d{2}$/.test(r.date || "") ? r.date : void 0, repeat: ["none", "daily", "weekdays", "weekly", "monthly"].includes(r.repeat) ? r.repeat : void 0, done: (Array.isArray(r.done) ? r.done : []).slice(-3).map(String) }));
    const t = b.timer && Number.isFinite(b.timer.endsAt) ? { endsAt: b.timer.endsAt, phase: b.timer.phase === "focus" ? "focus" : "break", sent: old.timer && old.timer.endsAt === b.timer.endsAt ? !!old.timer.sent : false } : null;
    const dev = { sub: { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } }, tz: typeof b.tz === "string" ? b.tz.slice(0, 60) : "Europe/Istanbul", reminders, timer: t, sent: old.sent || {} };
    await env.KV.put(key, JSON.stringify(dev), { expirationTtl: 60 * 86400 });
    return json({ ok: true });
  }
  if (url.pathname === "/test") {
    const raw = await env.KV.get(key);
    if (!raw) return json({ error: "not synced yet" }, 404);
    const r = await sendPush(env, JSON.parse(raw).sub, { title: "FocusDay", body: "Server notifications work \u{1F389}", tag: "test" });
    return json({ ok: r.status < 300, status: r.status });
  }
  return json({ error: "not found" }, 404);
}
var worker_default = {
  fetch: (request, env) => handle(request, env).catch((e) => json({ error: String(e && e.message || e) }, 500)),
  scheduled: (event, env, ctx) => {
    ctx.waitUntil(runCron(env));
  }
};
export {
  worker_default as default,
  dueMessages,
  localParts,
  occursOn,
  runCron
};
