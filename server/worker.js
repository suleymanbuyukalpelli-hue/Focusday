// FocusDay push server — Cloudflare Worker (paste into the dashboard editor as-is)
// Needs: a KV binding named "KV" and a Cron Trigger "* * * * *" (every minute).
// The VAPID key pair is created on first use and kept in KV, so no secrets to set up.
// All devices live in one KV key ("devices") so each cron run costs 1 read and no list calls
// (free plan: 100k reads, 1k writes, 1k lists per day).

const ALLOWED_ORIGIN = "https://suleymanbuyukalpelli-hue.github.io";
const CONTACT = "mailto:suleymanbuyukalpelli@yahoo.com";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

/* ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
const enc = new TextEncoder();
const b64u = {
  enc: (buf) => {
    let s = "";
    new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  },
};
const cat = (...a) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let p = 0;
  a.forEach((x) => { o.set(x, p); p += x.length; });
  return o;
};
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function encryptPayload(sub, plaintext) {
  const uaPub = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(plaintext), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function getVapid(env) {
  let v = await env.KV.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u.enc(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.KV.put("vapid", JSON.stringify(v));
  }
  return v;
}
async function sendPush(env, sub, payload) {
  const v = await getVapid(env);
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1e3) + 3600, sub: CONTACT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims)));
  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + head + "." + claims + "." + b64u.enc(sig) + ", k=" + v.pub,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: "high",
    },
    body: await encryptPayload(sub, JSON.stringify(payload)),
  });
}

/* ---------- what is due ---------- */
function localParts(ms, tz) {
  const opts = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  let f;
  try { f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }); }
  catch (_) { f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", ...opts }); }
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.year + "-" + p.month + "-" + p.day, min: +p.hour * 60 + +p.minute };
}
function dueMessages(dev, nowMs) {
  const out = [], { day, min } = localParts(nowMs, dev.tz);
  dev.sent = dev.sent || {};
  (dev.reminders || []).forEach((r) => {
    const m = /^(\d{2}):(\d{2})$/.exec(r.time || "");
    if (!m) return;
    const at = +m[1] * 60 + +m[2], key = r.id + "@" + day;
    if (min >= at && min - at < 15 && !dev.sent[key]) out.push({ title: "Reminder", body: String(r.title).slice(0, 120), tag: "rem-" + r.id, mark: key });
  });
  const t = dev.timer;
  if (t && t.endsAt && t.endsAt <= nowMs && nowMs - t.endsAt < 30 * 6e4 && !t.sent) {
    out.push({ title: t.phase === "focus" ? "Focus complete \u{1F345}" : "Break is over", body: t.phase === "focus" ? "Time for a break." : "Ready for the next round?", tag: "timer", timer: true });
  }
  Object.keys(dev.sent).forEach((k) => { if (!k.endsWith("@" + day)) delete dev.sent[k]; });
  return out;
}

/* ---------- storage: one key holds every device ---------- */
const loadDevices = async (env) => (await env.KV.get("devices", "json")) || {};
const saveDevices = (env, d) => env.KV.put("devices", JSON.stringify(d));

async function runCron(env, nowMs = Date.now()) {
  const devices = await loadDevices(env);
  let changed = false;
  for (const id of Object.keys(devices)) {
    const dev = devices[id], due = dueMessages(dev, nowMs);
    for (const m of due) {
      try {
        const r = await sendPush(env, dev.sub, { title: m.title, body: m.body, tag: m.tag });
        if (r.status === 404 || r.status === 410) { delete devices[id]; changed = true; break; }
        if (r.status >= 200 && r.status < 300) {
          if (m.mark) dev.sent[m.mark] = 1;
          if (m.timer) dev.timer.sent = true;
          changed = true;
        }
      } catch (_) { /* try again next minute */ }
    }
  }
  if (changed) await saveDevices(env, devices);
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, mesaj: "FocusDay bildirim sunucusu çalışıyor" });
  if (url.pathname === "/vapid-public-key") return json({ key: (await getVapid(env)).pub });
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  if (request.headers.get("Origin") !== ALLOWED_ORIGIN) return json({ error: "forbidden" }, 403);
  let b;
  try { b = await request.json(); } catch (_) { return json({ error: "bad json" }, 400); }
  if (!b || typeof b.deviceId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(b.deviceId)) return json({ error: "bad deviceId" }, 400);
  const devices = await loadDevices(env);

  if (url.pathname === "/unsubscribe") {
    if (devices[b.deviceId]) { delete devices[b.deviceId]; await saveDevices(env, devices); }
    return json({ ok: true });
  }
  if (url.pathname === "/sync") {
    const s = b.sub;
    if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "bad subscription" }, 400);
    const old = devices[b.deviceId] || {};
    const reminders = (Array.isArray(b.reminders) ? b.reminders : []).slice(0, 50).map((r) => ({ id: String(r.id).slice(0, 20), title: String(r.title).slice(0, 120), time: String(r.time) }));
    const timer = b.timer && Number.isFinite(b.timer.endsAt)
      ? { endsAt: b.timer.endsAt, phase: b.timer.phase === "focus" ? "focus" : "break", sent: old.timer && old.timer.endsAt === b.timer.endsAt ? !!old.timer.sent : false }
      : null;
    const dev = { sub: { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } }, tz: typeof b.tz === "string" ? b.tz.slice(0, 60) : "Europe/Istanbul", reminders, timer, sent: old.sent || {} };
    if (JSON.stringify(dev) !== JSON.stringify(old)) { devices[b.deviceId] = dev; await saveDevices(env, devices); } // skip no-op writes
    return json({ ok: true });
  }
  if (url.pathname === "/test") {
    const dev = devices[b.deviceId];
    if (!dev) return json({ error: "not synced yet" }, 404);
    const r = await sendPush(env, dev.sub, { title: "FocusDay", body: "Server notifications work \u{1F389}", tag: "test" });
    return json({ ok: r.status < 300, status: r.status });
  }
  return json({ error: "not found" }, 404);
}

export default {
  fetch: (request, env) => handle(request, env).catch((e) => json({ error: String((e && e.message) || e) }, 500)),
  scheduled: (event, env, ctx) => { ctx.waitUntil(runCron(env)); },
};
