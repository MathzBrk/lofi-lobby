// Room server: one Durable Object per room, everyone connected over WebSocket.
// Protocol (JSON):
//   client -> server: { t: "hello", name, gender, x, z, dir } | { t: "pos", x, z, dir, step }
//                     { t: "chat", text } | { t: "name", name } | { t: "gender", gender }
//                     { t: "radio", idx, password }   (admin)
//                     { t: "auth", password, quiet }   (admin login: admin-ok or an error; quiet = on reconnect, no admin-ok)
//                     { t: "who", id, password }   (admin: who is this player)
//                     { t: "mod", action: "kick"|"ban"|"unban", id, password }   (admin)
//   server -> client: { t: "you", id } | { t: "state", players: [...] }
//                     { t: "joined", player } | { t: "left", id } | { t: "pos", ... }
//                     { t: "chat", id, name, text, at } | { t: "name", id, name }
//                     { t: "gender", id, gender } | { t: "radio", command } | { t: "error", msg }
//                     { t: "history", messages: [{ id, name, text, at }] } (on join)
//                     { t: "notice", msg } | { t: "rename", name } (your name was refused)
//                     { t: "who", id, tag, names, sameTag } (admin only)
//                     { t: "kicked", msg } (the server closes you; don't reconnect)
//                     { t: "admin", id } (that player logged in as admin; players and chat also carry admin: true)
//
// Security (the client is public, so nothing coming from it is trusted):
//  - max message size, per-connection rate limit, max players per room
//  - admin password only on the server (ADMIN_PASSWORD secret), constant-time compare,
//    few attempts per connection
//  - allowed origins (ALLOWED_ORIGINS) so other sites can't use this server
//  - per IP: few connections, shared chat budget, admin lockout, progressive mute for spam
//  - all text is stripped of control characters and truncated; numbers finite and clamped
//  - word filter: bad names refused, bad chat words become *** (worker/moderation.js)
//  - admin kick (short IP ban) and ban (long IP ban), kept in storage
//
// Stats (Workers Analytics Engine, dataset "lofi_lobby"): one data point per join, leave and chat.
// No IP, name or chat text is stored: a visitor is a hash of IP + day, only good for counting uniques.
//   blob1 event ("join"|"leave"|"chat"), blob2 gender, blob3 country, blob4 visitor
//   double1 players online, double2 seconds in the room (leave)
// /api/stats (admin password in the Authorization header) reads them back through the SQL API
// (CF_ACCOUNT_ID and CF_API_TOKEN secrets) for public/stats.html.

const MAX_PLAYERS = 100;
// v1 has a single room; any other name is refused so nobody can spin up extra rooms (and extra cost)
const ROOMS = ["lobby"];
const MAX_BYTES = 1024;
const COORD_LIMIT = 500;
const ADMIN_ATTEMPTS = 20; // per IP, then locked for ADMIN_LOCK_MS (the "other" rate limit already caps tries at ~1/s)
const ADMIN_LOCK_MS = 60_000;
const MAX_PER_IP = 3; // tabs/devices behind one IP
const KICK_MS = 10 * 60_000; // kick = a short ban, so the client's auto-reconnect doesn't undo it
const BAN_MS = 7 * 24 * 60 * 60_000;
// chat history for people who just arrived: last few messages, only recent ones, never the IP
const HISTORY_SIZE = 30;
const HISTORY_MS = 2 * 60 * 60_000;
// admin sees a short tag per IP (never the IP) and the names used from it in the last hours
const NAMES_KEEP = 10;
const NAMES_MS = 6 * 60 * 60_000;
// progressive mute: each spam strike mutes for longer; strikes are forgotten after STRIKE_RESET_MS quiet
const MUTE_STEPS_MS = [0, 15_000, 60_000, 5 * 60_000, 30 * 60_000]; // first strike is only a warning
const STRIKE_RESET_MS = 30 * 60_000;
const REPEAT_LIMIT = 3; // the same text more than this many times in a row...
const REPEAT_WINDOW_MS = 30_000; // ...inside this window counts as spam
// rate buckets: capacity, refill per second
const RATES = { pos: [30, 20], chat: [8, 1], other: [10, 1] };

import { badName, cleanChat, normalize } from "./moderation.js";

const DIRS = ["down", "up", "left", "right"];
const cleanText = (s, max) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const number = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) : 0;
};
const gender = (g) => (g === "female" ? "female" : "male");

// constant-time compare (timing doesn't leak how many characters match)
function equal(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function visitorOf(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + day));
  return [...new Uint8Array(hash).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// last 30 days, answered by the Analytics Engine SQL API
const STATS_QUERIES = {
  daily: `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS joins, COUNT(DISTINCT blob4) AS visitors, MAX(double1) AS peak
          FROM lofi_lobby WHERE blob1 = 'join' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`,
  sessions: `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval * double2) / SUM(_sample_interval) AS avgSeconds
          FROM lofi_lobby WHERE blob1 = 'leave' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`,
  chat: `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS messages
          FROM lofi_lobby WHERE blob1 = 'chat' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day`,
  hours: `SELECT toHour(timestamp) AS hour, SUM(_sample_interval) AS joins
          FROM lofi_lobby WHERE blob1 = 'join' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY hour ORDER BY hour`,
  countries: `SELECT blob3 AS country, COUNT(DISTINCT blob4) AS visitors
          FROM lofi_lobby WHERE blob1 = 'join' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY country ORDER BY visitors DESC LIMIT 12`,
  genders: `SELECT blob2 AS gender, SUM(_sample_interval) AS joins
          FROM lofi_lobby WHERE blob1 = 'join' AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY gender`,
};

// one finished day, for the archive (Analytics Engine keeps only 3 months)
const dayQuery = (day) => `SELECT blob1 AS event, SUM(_sample_interval) AS n, COUNT(DISTINCT blob4) AS visitors,
  MAX(double1) AS peak, SUM(_sample_interval * double2) AS seconds
  FROM lofi_lobby WHERE timestamp >= toDateTime('${day} 00:00:00') AND timestamp < toDateTime('${day} 00:00:00') + INTERVAL '1' DAY
  GROUP BY event`;

// Measured by Cloudflare since launch (the API allows about 31 days back): Worker requests per day (with assets
// served before the Worker, almost all are WebSocket connections: page loads and reconnects) and the most
// WebSockets open at once on the Durable Object (peak online, from before the game logged its own stats).
const CONNECTIONS_QUERY = `query ($account: String!, $since: Date!) { viewer { accounts(filter: { accountTag: $account }) {
  workersInvocationsAdaptive(limit: 100, filter: { scriptName: "lofi-lobby", date_geq: $since }, orderBy: [date_ASC]) {
    sum { requests } dimensions { date } }
  durableObjectsPeriodicGroups(limit: 100, filter: { date_geq: $since }, orderBy: [date_ASC]) {
    max { activeWebsocketConnections } dimensions { date } } } } }`;

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map(); // "ip|type" or "ws-id|pos" -> { tokens, at } (in memory)
    this.spam = new Map(); // ip -> { strikes, mutedUntil, lastStrike, lastText, lastAt }
  }

  stat(event, p, extra = []) {
    try {
      this.env.STATS?.writeDataPoint({
        indexes: [event],
        blobs: [event, p.gender || "", p.country || "", p.visitor || ""],
        doubles: [this.state.getWebSockets().length, ...extra],
      });
    } catch {}
  }

  async stats(req) {
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const password = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const check = await this.checkAdmin(ip, password);
    if (!check.ok) return Response.json({ error: check.msg }, { status: 401 });
    if (!this.env.CF_ACCOUNT_ID || !this.env.CF_API_TOKEN) return Response.json({ error: "stats not set up" }, { status: 501 });
    const out = { online: this.state.getWebSockets().length };
    await Promise.all(Object.entries(STATS_QUERIES).map(async ([key, sql]) => {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
        method: "POST", headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` }, body: sql,
      });
      out[key] = r.ok ? (await r.json()).data : [];
      if (!r.ok) out.errors = [...(out.errors || []), key + ": " + (await r.text()).slice(0, 200)];
    }));
    try { out.connections = await this.connections(); } catch (e) { out.connections = []; (out.errors ||= []).push("connections: " + e.message); }
    // connections: archived days under the live ~31 days
    const live = new Set(out.connections.map((c) => c.day));
    out.archive = [...(await this.state.storage.list({ prefix: "day:" }))].map(([k, v]) => ({ day: k.slice(4), ...v }));
    for (const a of out.archive) if (a.connections != null && !live.has(a.day)) out.connections.push({ day: a.day, requests: a.connections, peak: a.cfPeak || 0 });
    return Response.json(out, { headers: { "Cache-Control": "no-store" } });
  }

  async sql(query) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST", headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` }, body: query,
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 200));
    return (await r.json()).data;
  }

  async connections() {
    const since = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: CONNECTIONS_QUERY, variables: { account: this.env.CF_ACCOUNT_ID, since } }),
    });
    const body = await r.json();
    if (body.errors?.length) throw new Error(body.errors[0].message.slice(0, 200));
    const acc = body.data.viewer.accounts[0];
    const days = new Map();
    for (const x of acc.workersInvocationsAdaptive) days.set(x.dimensions.date, { day: x.dimensions.date, requests: x.sum.requests, peak: 0 });
    for (const x of acc.durableObjectsPeriodicGroups) {
      const d = days.get(x.dimensions.date) || { day: x.dimensions.date, requests: 0, peak: 0 };
      d.peak = Math.max(d.peak, x.max.activeWebsocketConnections);
      days.set(d.day, d);
    }
    return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // daily cron: keep every finished day (of the last 80) in storage, forever
  async archive() {
    if (!this.env.CF_ACCOUNT_ID || !this.env.CF_API_TOKEN) return;
    // Cloudflare's own count only goes ~31 days back, so it is archived too
    const today = new Date().toISOString().slice(0, 10);
    for (const c of await this.connections().catch(() => [])) {
      if (c.day >= today) continue;
      const key = "day:" + c.day;
      const saved = (await this.state.storage.get(key)) || {};
      if (saved.connections == null) await this.state.storage.put(key, { ...saved, connections: c.requests, cfPeak: c.peak });
    }
    for (let i = 80; i >= 1; i--) {
      const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      const saved = (await this.state.storage.get("day:" + day)) || {};
      if (saved.joins != null) continue;
      const rows = await this.sql(dayQuery(day));
      if (!rows.length) continue;
      const by = Object.fromEntries(rows.map((r) => [r.event, r]));
      const joins = Number(by.join?.n || 0), leaves = Number(by.leave?.n || 0);
      await this.state.storage.put("day:" + day, {
        ...saved, joins, visitors: Number(by.join?.visitors || 0), peak: Number(by.join?.peak || 0),
        avgSeconds: leaves ? Number(by.leave.seconds) / leaves : 0, messages: Number(by.chat?.n || 0),
      });
    }
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/api/stats") return this.stats(req);
    if (path === "/internal/archive") { await this.archive(); return new Response("ok"); }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (this.state.getWebSockets().length >= MAX_PLAYERS) return new Response("room is full", { status: 503 });
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const ban = await this.state.storage.get("ban:" + ip);
    if (ban > Date.now()) return new Response("banned", { status: 403 });
    const sameIp = this.state.getWebSockets().filter((w) => w.deserializeAttachment()?.ip === ip).length;
    if (sameIp >= MAX_PER_IP) return new Response("too many connections", { status: 429 });

    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    // hibernation: the DO can sleep with connections open; each player's
    // state lives on its own socket (serializeAttachment)
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, name: "trainer", gender: "male", x: 0, z: 0, dir: "down", step: 0, ip,
      country: String(req.cf?.country || "").slice(0, 2), visitor: await visitorOf(ip) });
    server.send(JSON.stringify({ t: "you", id }));
    const radio = await this.state.storage.get("radio");
    if (radio) server.send(JSON.stringify({ t: "radio", command: radio }));
    const messages = await this.history();
    if (messages.length) server.send(JSON.stringify({ t: "history", messages }));
    server.send(JSON.stringify({ t: "state", players: this.players().filter((p) => p.id !== id) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // only each player's public fields (never the IP)
  public(p) {
    return { id: p.id, name: p.name, gender: p.gender, x: p.x, z: p.z, dir: p.dir, step: p.step, admin: !!p.admin };
  }
  players() {
    return this.state.getWebSockets().map((ws) => ws.deserializeAttachment()).filter(Boolean).map((p) => this.public(p));
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }

  // rate limit (token bucket): movement per connection, chat and the rest shared by everyone on one IP
  allowed(p, type) {
    const [cap, refill] = RATES[type] || RATES.other;
    const key = (type === "pos" ? p.id : p.ip) + "|" + type;
    const now = Date.now() / 1000;
    let k = this.buckets.get(key);
    if (!k) this.buckets.set(key, (k = { tokens: cap, at: now }));
    k.tokens = Math.min(cap, k.tokens + (now - k.at) * refill);
    k.at = now;
    if (k.tokens < 1) return false;
    k.tokens -= 1;
    return true;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const p = ws.deserializeAttachment();
    if (!p) return;
    const type = m.t === "pos" ? "pos" : m.t === "chat" ? "chat" : "other";
    if (!this.allowed(p, type)) {
      if (type === "chat") this.strike(ws, p.ip);
      return;
    }

    if (m.t === "hello") {
      p.name = this.nameFor(ws, m.name);
      p.gender = gender(m.gender);
      // where the player already is (a reconnect, or a saved spot), so others see them there at once
      p.x = number(m.x);
      p.z = number(m.z);
      p.dir = DIRS.includes(m.dir) ? m.dir : "down";
      const first = !p.joinedAt;
      if (first) p.joinedAt = Date.now();
      ws.serializeAttachment(p);
      if (first) this.stat("join", p);
      this.broadcast({ t: "joined", player: this.public(p) }, ws);
      await this.rememberName(p);
    } else if (m.t === "gender") {
      p.gender = gender(m.gender);
      ws.serializeAttachment(p);
      this.broadcast({ t: "gender", id: p.id, gender: p.gender }, ws);
    } else if (m.t === "name") {
      p.name = this.nameFor(ws, m.name);
      ws.serializeAttachment(p);
      this.broadcast({ t: "name", id: p.id, name: p.name }, ws);
      await this.rememberName(p);
    } else if (m.t === "pos") {
      p.x = number(m.x);
      p.z = number(m.z);
      p.dir = DIRS.includes(m.dir) ? m.dir : "down";
      p.step = Math.abs(m.step | 0) % 4;
      ws.serializeAttachment(p);
      this.broadcast({ t: "pos", id: p.id, x: p.x, z: p.z, dir: p.dir, step: p.step }, ws);
    } else if (m.t === "auth") {
      if (!(await this.isAdmin(ws, p, m.password))) return;
      // everyone sees who the admin is (badge over the name, colour in the chat)
      p.admin = true;
      ws.serializeAttachment(p);
      this.broadcast({ t: "admin", id: p.id });
      if (!m.quiet) ws.send(JSON.stringify({ t: "admin-ok" }));
    } else if (m.t === "who") {
      if (!(await this.isAdmin(ws, p, m.password))) return;
      const all = this.state.getWebSockets().map((w) => w.deserializeAttachment()).filter(Boolean);
      const target = all.find((q) => q.id === cleanText(m.id, 16));
      if (!target) return;
      const tag = await this.tagOf(target.ip);
      const names = (await this.namesOf(tag)).map((n) => n.name).filter((n) => n !== target.name);
      const sameTag = all.filter((q) => q.ip === target.ip && q.id !== target.id).map((q) => q.name);
      ws.send(JSON.stringify({ t: "who", id: target.id, tag, names, sameTag }));
    } else if (m.t === "mod") {
      if (!(await this.isAdmin(ws, p, m.password))) return;
      await this.moderate(ws, m.action, cleanText(m.id, 16));
    } else if (m.t === "radio") {
      if (!(await this.isAdmin(ws, p, m.password))) return;
      const command = { idx: Math.max(0, Math.min(999, m.idx | 0)), at: Date.now() };
      await this.state.storage.put("radio", command);
      this.broadcast({ t: "radio", command });
    } else if (m.t === "chat") {
      const text = cleanChat(cleanText(m.text, 140));
      if (text === null) return void ws.send(JSON.stringify({ t: "error", msg: "message blocked" }));
      if (!text) return;
      const now = Date.now();
      const s = this.spamOf(p.ip, now);
      if (s.mutedUntil > now) return this.tellMuted(ws, s.mutedUntil);
      s.repeats = text === s.lastText && now - s.lastAt < REPEAT_WINDOW_MS ? s.repeats + 1 : 1;
      if (s.repeats > REPEAT_LIMIT) return this.strike(ws, p.ip);
      s.lastText = text;
      s.lastAt = now;
      const msg = { id: p.id, name: p.name, text, at: now, ...(p.admin && { admin: true }) };
      this.broadcast({ t: "chat", ...msg });
      this.stat("chat", p);
      await this.saveHistory([...(await this.history()), msg]);
    }
  }

  // a refused name becomes a random trainer name, and the player is told so it shows the same
  nameFor(ws, raw) {
    const name = cleanText(raw, 16) || "trainer";
    // nobody can pose as staff by name: the real admin is shown by the badge
    const staff = /admin|moderador|moderator|staff/.test(normalize(name));
    if (!badName(name) && !staff) return name;
    const fallback = "trainer" + Math.floor(Math.random() * 900 + 100);
    try { ws.send(JSON.stringify({ t: "rename", name: fallback, msg: "that name is not allowed" })); } catch {}
    return fallback;
  }

  // failures counted per IP in storage, so reconnecting doesn't reset them
  async isAdmin(ws, p, password) {
    const check = await this.checkAdmin(p.ip, password);
    if (!check.ok) ws.send(JSON.stringify({ t: "error", msg: check.msg }));
    return check.ok;
  }
  async checkAdmin(ip, password) {
    // bump the "v3" prefix to drop every stored lock
    const lockKey = "admin-fail-v3:" + ip;
    const lock = (await this.state.storage.get(lockKey)) || { fails: 0, until: 0 };
    if (lock.until > Date.now()) return { ok: false, msg: "admin locked, try later" };
    if (!this.env.ADMIN_PASSWORD || typeof password !== "string" || !equal(password, this.env.ADMIN_PASSWORD)) {
      lock.fails = lock.until ? 1 : lock.fails + 1; // a finished lock starts over
      lock.until = lock.fails >= ADMIN_ATTEMPTS ? Date.now() + ADMIN_LOCK_MS : 0;
      if (lock.until) lock.fails = 0;
      await this.state.storage.put(lockKey, lock);
      return { ok: false, msg: "invalid admin password" };
    }
    await this.state.storage.delete(lockKey);
    return { ok: true };
  }

  // kick / ban a player by id: everyone on that player's IP loses the room
  async moderate(adminWs, action, id) {
    const tell = (msg) => adminWs.send(JSON.stringify({ t: "notice", msg }));
    if (action === "unban") {
      const bans = await this.state.storage.list({ prefix: "ban:" });
      await this.state.storage.delete([...bans.keys()]);
      return tell(`unbanned ${bans.size}`);
    }
    if (action !== "kick" && action !== "ban") return;
    const sockets = this.state.getWebSockets();
    const target = sockets.map((w) => w.deserializeAttachment()).find((p) => p?.id === id);
    if (!target || adminWs.deserializeAttachment()?.id === id) return tell("that player already left");
    const name = target.name;
    const ips = new Set([target.ip]);
    // a banned player's messages leave the history too
    const gone = new Set(sockets.map((w) => w.deserializeAttachment()).filter((q) => q && ips.has(q.ip)).map((q) => q.id));
    await this.saveHistory((await this.history()).filter((m) => !gone.has(m.id)));
    const until = Date.now() + (action === "ban" ? BAN_MS : KICK_MS);
    for (const ip of ips) await this.state.storage.put("ban:" + ip, until);
    const msg = action === "ban" ? "you were banned from the room" : "you were kicked, come back later";
    for (const w of sockets) {
      if (w === adminWs || !ips.has(w.deserializeAttachment()?.ip)) continue;
      try { w.send(JSON.stringify({ t: "kicked", msg })); w.close(4003, action); } catch {}
      this.leave(w);
    }
    tell(`${action === "ban" ? "banned" : "kicked"} ${name}`);
  }

  // short, stable tag for an IP: HMAC with a random key kept in this room's storage, so it can't
  // be turned back into the IP or recomputed by anyone else
  async tagOf(ip) {
    if (!this.tagKey) {
      let raw = await this.state.storage.get("tag-key");
      if (!raw) await this.state.storage.put("tag-key", (raw = [...crypto.getRandomValues(new Uint8Array(32))]));
      this.tagKey = await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    }
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", this.tagKey, new TextEncoder().encode(ip)));
    return [...sig.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async namesOf(tag) {
    const all = (await this.state.storage.get("names:" + tag)) || [];
    return all.filter((n) => n.at > Date.now() - NAMES_MS);
  }
  async rememberName(p) {
    const tag = await this.tagOf(p.ip);
    const names = (await this.namesOf(tag)).filter((n) => n.name !== p.name);
    await this.state.storage.put("names:" + tag, [...names, { name: p.name, at: Date.now() }].slice(-NAMES_KEEP));
  }

  // kept in storage so it survives the object sleeping (hibernation)
  async history() {
    const all = (await this.state.storage.get("chat")) || [];
    return all.filter((m) => m.at > Date.now() - HISTORY_MS);
  }
  async saveHistory(messages) {
    await this.state.storage.put("chat", messages.slice(-HISTORY_SIZE));
  }

  spamOf(ip, now) {
    let s = this.spam.get(ip);
    if (!s) this.spam.set(ip, (s = { strikes: 0, mutedUntil: 0, lastStrike: 0, lastText: "", lastAt: 0, repeats: 0 }));
    if (s.strikes && now - s.lastStrike > STRIKE_RESET_MS) s.strikes = 0;
    return s;
  }
  // a spam strike: mute this IP, longer each time
  strike(ws, ip) {
    const now = Date.now();
    const s = this.spamOf(ip, now);
    if (s.mutedUntil > now) return; // already muted; don't stack while muted
    const ms = MUTE_STEPS_MS[Math.min(s.strikes, MUTE_STEPS_MS.length - 1)];
    s.strikes++;
    s.lastStrike = now;
    s.mutedUntil = now + ms;
    if (!ms) {
      try { ws.send(JSON.stringify({ t: "error", msg: "slow down, next time you get muted" })); } catch {}
      return;
    }
    this.tellMuted(ws, s.mutedUntil);
  }
  tellMuted(ws, until) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    const wait = secs >= 60 ? Math.ceil(secs / 60) + " min" : secs + " s";
    try { ws.send(JSON.stringify({ t: "error", msg: `muted for spam, ${wait} left` })); } catch {}
  }

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const p = ws.deserializeAttachment();
    if (!p) return;
    if (p.joinedAt) this.stat("leave", p, [Math.round((Date.now() - p.joinedAt) / 1000)]);
    for (const k of this.buckets.keys()) if (k.startsWith(p.id + "|")) this.buckets.delete(k);
    this.broadcast({ t: "left", id: p.id }, ws);
  }
}

export default {
  // once a day: archive yesterday's numbers in the room's storage (see Room.archive)
  async scheduled(event, env) {
    await env.ROOM.get(env.ROOM.idFromName(ROOMS[0])).fetch("https://room/internal/archive");
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    // stats: the room's Durable Object checks the admin password (same lockout as the game)
    if (url.pathname === "/api/stats") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return env.ROOM.get(env.ROOM.idFromName(ROOMS[0])).fetch(req);
    }
    // /ws/<room>  ->  that room's Durable Object. Everything else is the static site (assets).
    const m = url.pathname.match(/^\/ws\/([a-z0-9-]{1,32})$/i);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("lofi-lobby", { status: 404 });
    if (!ROOMS.includes(m[1].toLowerCase())) return new Response("unknown room", { status: 404 });

    // only accept connections from the site itself (or origins listed in ALLOWED_ORIGINS)
    const origin = req.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    allowed.push(url.origin);
    if (!origin || !allowed.includes(origin)) return new Response("origin not allowed", { status: 403 });

    const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toLowerCase()));
    return stub.fetch(req);
  },
};
