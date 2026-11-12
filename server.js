// ═══════════════════════════════════════════════════════
// IPTV Stream Relay — Hugging Face / Back4app (Docker, port 7860)
//
// يعمل من IP نظيف دائم. يفعل شيئين من نفس الـIP:
//   1) جلسة Stalker كاملة (handshake -> create_link) للحصول على رابط البث.
//   2) تمرير بايتات البث (passthrough) إلى المشغّل مباشرة.
// بهذا يبقى play_token صالحًا لأنه مقفل على IP هذا الخادم نفسه.
//
// الأمان: سرّ مشترك (X-Relay-Secret للـPOST، و ?secret= للـGET).
// ═══════════════════════════════════════════════════════

const http = require("http");
const { URL } = require("url");
const { Readable } = require("stream");

const PORT = process.env.PORT || 7860;
const RELAY_SECRET = process.env.RELAY_SECRET || "change-me-to-a-long-random-string";

const STB_UA = "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3";
const PREFIXES = ["/portal.php", "/server/load.php", "/stalker_portal/server/load.php", "/c/portal.php"];

function stbHeaders(host, mac, extra = {}) {
  const h = {
    "User-Agent": STB_UA,
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Connection": "close",
    "Referer": host.replace(/\/+$/, "") + "/c/",
    ...extra,
  };
  if (mac) {
    h["Cookie"] = `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe/London`;
    h["X-User-Agent"] = "Model: MAG250; Link: WiFi";
  }
  return h;
}

function normalizeMacHost(host) {
  if (!host) return host;
  host = String(host).trim();
  if (!/^https?:\/\//i.test(host)) host = "http://" + host;
  try {
    const u = new URL(host);
    const authMatch = host.match(/^https?:\/\/([^\/?#]+)/i);
    const authority = authMatch ? authMatch[1] : u.host;
    const p = u.pathname.replace(/\/+$/, "");
    const low = p.toLowerCase();
    if (low.includes("/stalker_portal")) {
      const idx = low.indexOf("/stalker_portal");
      return `${u.protocol}//${authority}${p.slice(0, idx + "/stalker_portal".length)}`;
    }
    return `${u.protocol}//${authority}`;
  } catch {
    return host.replace(/\/+$/, "");
  }
}

async function stalkerLogin(b, mac) {
  for (const p of PREFIXES) {
    try {
      const url = `${b}${p}?type=stb&action=handshake&token=&JsHttpRequest=1-xml`;
      const r = await fetch(url, { headers: stbHeaders(b, mac), signal: AbortSignal.timeout(10000), redirect: "follow" });
      if (r.status !== 200) continue;
      const txt = await r.text();
      const m = txt.match(/"token"\s*:\s*"([^"]+)"/) || txt.match(/token["']?\s*[:=]\s*["']?([A-Za-z0-9]{8,})/i);
      const token = m ? m[1] : null;
      if (!token) continue;
      try {
        const purl = `${b}${p}?type=stb&action=get_profile&JsHttpRequest=1-xml`;
        await fetch(purl, { headers: stbHeaders(b, mac, { Authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(10000) });
      } catch (_) {}
      return { token, prefix: p };
    } catch (_) {}
  }
  return null;
}

async function stalkerCreateLink(b, mac, token, prefix, cmd) {
  try {
    const url = `${b}${prefix}?type=itv&action=create_link&cmd=${encodeURIComponent(cmd)}&JsHttpRequest=1-xml`;
    const r = await fetch(url, { headers: stbHeaders(b, mac, { Authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(10000) });
    if (r.status !== 200) return null;
    const data = JSON.parse(await r.text());
    let link = (data && data.js && data.js.cmd ? data.js.cmd : "").toString();
    link = link.replace(/^ffmpeg\s+/i, "").trim();
    return link || null;
  } catch { return null; }
}

async function stalkerGetChannelsPaged(b, mac, token, prefix, maxTotal) {
  const out = [];
  const pageSize = 14;
  const maxPages = Math.ceil(maxTotal / pageSize) + 1;
  for (let p = 1; p <= maxPages && out.length < maxTotal; p++) {
    let data = null;
    try {
      const url = `${b}${prefix}?type=itv&action=get_ordered_list&genre=*&force_ch_link_check=&fav=0&p=${p}&JsHttpRequest=1-xml`;
      const r = await fetch(url, { headers: stbHeaders(b, mac, { Authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(10000), redirect: "follow" });
      if (r.status !== 200) break;
      data = JSON.parse(await r.text());
    } catch { break; }
    const list = (data && data.js && data.js.data) ? data.js.data : [];
    if (!Array.isArray(list) || list.length === 0) break;
    for (const ch of list) { if (out.length >= maxTotal) break; out.push(ch); }
    const total = Number((data && data.js && data.js.total_items) || 0);
    if (total && p * pageSize >= total) break;
  }
  return out;
}

function cmdOf(ch) {
  return (ch.cmd || (ch.cmds && ch.cmds[0] && ch.cmds[0].url) || "").toString();
}

// يبني M3U روابطها تشير إلى /live على هذا الخادم (التحليل وقت البث)
async function buildProxyM3U(publicBase, portal, mac, login, b, limit) {
  const channels = await stalkerGetChannelsPaged(b, mac, login.token, login.prefix, limit);
  if (!channels.length) return { ok: false, reason: "empty" };
  let m3u = "#EXTM3U\n";
  let count = 0;
  const sec = encodeURIComponent(RELAY_SECRET);
  const pEnc = encodeURIComponent(portal);
  const mEnc = encodeURIComponent(mac);
  for (const ch of channels) {
    const cmd = cmdOf(ch);
    if (!cmd) continue;
    const name = (ch.name || "Channel").toString();
    const logoRaw = ch.logo || "";
    const logo = logoRaw && /^https?:/i.test(logoRaw) ? ` tvg-logo="${logoRaw}"` : "";
    const url = `${publicBase}/live?portal=${pEnc}&mac=${mEnc}&cmd=${encodeURIComponent(cmd)}&secret=${sec}`;
    m3u += `#EXTINF:-1${logo},${name}\n${url}\n`;
    count++;
  }
  return { ok: count > 0, m3u, total: channels.length, count };
}

// تمرير البث: login -> create_link -> جلب الرابط الحقيقي وضخ البايتات
async function handleLive(req, res, q) {
  const portal = (q.get("portal") || "").toString();
  const mac = (q.get("mac") || "").toString().toUpperCase().trim();
  const cmd = (q.get("cmd") || "").toString();
  if (!portal || !mac || !cmd) { res.writeHead(400); return res.end("missing params"); }
  const b = normalizeMacHost(portal).replace(/\/+$/, "");
  const login = await stalkerLogin(b, mac);
  if (!login) { res.writeHead(502); return res.end("login failed"); }
  const real = await stalkerCreateLink(b, mac, login.token, login.prefix, cmd);
  if (!real) { res.writeHead(502); return res.end("create_link failed"); }
  let upstream;
  try {
    upstream = await fetch(real, {
      headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20", "Accept": "*/*", "Connection": "close" },
      redirect: "follow",
    });
  } catch (e) { res.writeHead(502); return res.end("upstream error"); }
  if (!upstream.ok && upstream.status !== 206) { res.writeHead(upstream.status || 502); return res.end("upstream " + upstream.status); }
  const ct = upstream.headers.get("content-type") || "video/mp2t";
  res.writeHead(200, { "Content-Type": ct, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  try {
    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      req.on("close", () => { try { nodeStream.destroy(); } catch (_) {} });
      nodeStream.on("error", () => { try { res.end(); } catch (_) {} });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (e) { try { res.end(); } catch (_) {} }
}

function send(res, status, obj, type) {
  res.writeHead(status, { "Content-Type": type || "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function publicBaseOf(req) {
  if (process.env.PUBLIC_BASE) return process.env.PUBLIC_BASE.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["host"];
  return `${proto}://${host}`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Relay-Secret",
    });
    return res.end();
  }

  const u = new URL(req.url, "http://x");
  const path = u.pathname;
  const q = u.searchParams;

  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(res, 200, { status: "ok", relay: "iptv-stream", ts: Date.now() });
  }

  if (req.method === "GET" && path === "/live") {
    if ((q.get("secret") || "") !== RELAY_SECRET) { res.writeHead(401); return res.end("unauthorized"); }
    return handleLive(req, res, q);
  }

  if (req.method === "GET" && (path === "/playlist.m3u" || path === "/playlist")) {
    if ((q.get("secret") || "") !== RELAY_SECRET) { res.writeHead(401); return res.end("unauthorized"); }
    const portal = (q.get("portal") || "").toString();
    const mac = (q.get("mac") || "").toString().toUpperCase().trim();
    let limit = Number(q.get("limit")) || 400;
    if (limit < 1) limit = 1; if (limit > 5000) limit = 5000;
    if (!portal || !mac) { res.writeHead(400); return res.end("missing portal or mac"); }
    const b = normalizeMacHost(portal).replace(/\/+$/, "");
    const login = await stalkerLogin(b, mac);
    if (!login) { res.writeHead(502); return res.end("login failed"); }
    const out = await buildProxyM3U(publicBaseOf(req), portal, mac, login, b, limit);
    if (!out.ok) { res.writeHead(502); return res.end("empty playlist"); }
    return send(res, 200, out.m3u, "audio/x-mpegurl; charset=utf-8");
  }

  if (req.method === "POST") {
    if ((req.headers["x-relay-secret"] || "") !== RELAY_SECRET) return send(res, 401, { error: "unauthorized" });
    const body = await readBody(req);
    const op = (body.op || "login").toString();
    const portal = (body.portal || "").toString();
    const mac = (body.mac || "").toString().toUpperCase().trim();
    let limit = Number(body.limit) || 150;
    if (limit < 1) limit = 1; if (limit > 5000) limit = 5000;
    if (!portal || !mac) return send(res, 400, { error: "missing portal or mac" });
    const b = normalizeMacHost(portal).replace(/\/+$/, "");
    const login = await stalkerLogin(b, mac);
    if (!login) return send(res, 200, { ok: false, reason: "login", base: b });
    if (op === "login") return send(res, 200, { ok: true, token: login.token, prefix: login.prefix, base: b });
    if (op === "createlink") {
      const cmd = (body.cmd || "").toString();
      if (!cmd) return send(res, 400, { error: "missing cmd" });
      const link = await stalkerCreateLink(b, mac, login.token, login.prefix, cmd);
      return send(res, 200, { ok: !!link, url: link, base: b });
    }
    if (op === "m3u") {
      const out = await buildProxyM3U(publicBaseOf(req), portal, mac, login, b, limit);
      return send(res, 200, Object.assign({}, out, { base: b, prefix: login.prefix }));
    }
    return send(res, 400, { error: "unknown op" });
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`IPTV stream relay listening on :${PORT}`);
});
