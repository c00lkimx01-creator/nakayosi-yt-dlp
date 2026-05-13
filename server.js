import express from "express";
import compression from "compression";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  next();
});
app.use(
  express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true })
);

// =========================================================
// Invidious instances（cookie 不要・最速ルート）
// =========================================================
const INV_INSTANCES = (process.env.INVIDIOUS_INSTANCES ||
  [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://yewtu.be",
    "https://invidious.privacyredirect.com",
    "https://iv.ggtyler.dev",
    "https://invidious.f5.si",
    "https://invidious.materialio.us",
  ].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// Invidious /api/v1/videos/:id から hlsUrl / formatStreams を取得
async function tryInvidious(videoId, perTimeout = 6000) {
  return await new Promise((resolve) => {
    let remaining = INV_INSTANCES.length;
    let lastErr = "";
    if (remaining === 0) return resolve({ ok: false, err: "no instances" });

    INV_INSTANCES.forEach((base) => {
      const url = `${base.replace(/\/+$/, "")}/api/v1/videos/${encodeURIComponent(
        videoId
      )}?fields=hlsUrl,dashUrl,formatStreams,adaptiveFormats`;
      fetchWithTimeout(url, perTimeout)
        .then(async (r) => {
          if (!r.ok) throw new Error(`${base} -> ${r.status}`);
          const j = await r.json();
          // 優先順: HLS manifest -> DASH manifest -> 直リンク
          let pick = null;
          if (j.hlsUrl) pick = { url: j.hlsUrl, type: "hls", source: base };
          else if (j.dashUrl) pick = { url: j.dashUrl, type: "dash", source: base };
          else if (Array.isArray(j.formatStreams) && j.formatStreams.length) {
            // 720p/360p の muxed mp4
            const best = j.formatStreams
              .filter((f) => f.url)
              .sort((a, b) => (parseInt(b.bitrate || 0)) - (parseInt(a.bitrate || 0)))[0];
            if (best) pick = { url: best.url, type: "mp4", source: base };
          }
          if (pick) return resolve({ ok: true, ...pick });
          throw new Error(`${base} -> empty`);
        })
        .catch((e) => {
          lastErr = String(e?.message || e);
        })
        .finally(() => {
          remaining -= 1;
          if (remaining === 0) resolve({ ok: false, err: lastErr || "all failed" });
        });
    });
  });
}

// =========================================================
// Cookie 自動取得（yt-dlp フォールバック用）
// =========================================================
const MANUAL_COOKIE = path.join(__dirname, "cookie.txt");
const AUTO_COOKIE = path.join(os.tmpdir(), "yt_auto_cookies.txt");
let cookiePath = null;
let cookieExpires = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

function writeNetscapeCookies(setCookieHeaders, file) {
  const lines = ["# Netscape HTTP Cookie File", "# Auto-generated"];
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 180;
  for (const raw of setCookieHeaders) {
    const parts = raw.split(";").map((s) => s.trim());
    const [nameVal, ...attrs] = parts;
    const eq = nameVal.indexOf("=");
    if (eq < 0) continue;
    const name = nameVal.slice(0, eq);
    const value = nameVal.slice(eq + 1);
    let domain = ".youtube.com";
    let cookiePathAttr = "/";
    for (const a of attrs) {
      const [k, v] = a.split("=");
      if (!k) continue;
      if (k.toLowerCase() === "domain" && v)
        domain = v.startsWith(".") ? v : "." + v;
      if (k.toLowerCase() === "path" && v) cookiePathAttr = v;
    }
    lines.push(
      [domain, "TRUE", cookiePathAttr, "FALSE", expires, name, value].join("\t")
    );
  }
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "CONSENT", "YES+1"].join("\t"));
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "SOCS", "CAI"].join("\t"));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function refreshCookies() {
  if (fs.existsSync(MANUAL_COOKIE)) {
    cookiePath = MANUAL_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch("https://www.youtube.com/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    clearTimeout(t);
    let setCookies = [];
    if (typeof r.headers.getSetCookie === "function") setCookies = r.headers.getSetCookie();
    else {
      const raw = r.headers.get("set-cookie");
      if (raw) setCookies = raw.split(/,(?=[^;]+=)/);
    }
    writeNetscapeCookies(setCookies, AUTO_COOKIE);
    cookiePath = AUTO_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  } catch {
    try {
      writeNetscapeCookies([], AUTO_COOKIE);
      cookiePath = AUTO_COOKIE;
      cookieExpires = Date.now() + COOKIE_TTL_MS;
    } catch {}
    return cookiePath;
  }
}

async function ensureCookies() {
  if (cookiePath && Date.now() < cookieExpires && fs.existsSync(cookiePath)) {
    return cookiePath;
  }
  return await refreshCookies();
}

refreshCookies().catch(() => {});

// =========================================================
// キャッシュ & in-flight
// =========================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const getCache = (id) => {
  const v = cache.get(id);
  if (!v) return null;
  if (Date.now() > v.expires) { cache.delete(id); return null; }
  return v;
};
const setCache = (id, payload) =>
  cache.set(id, { ...payload, expires: Date.now() + CACHE_TTL_MS });
const inflight = new Map();

// =========================================================
// yt-dlp（manifest 優先）
// =========================================================
function tryYtDlp(args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let yt;
    try { yt = spawn("yt-dlp", args); }
    catch (e) { return resolve({ ok: false, err: String(e?.message || e) }); }
    let out = "", err = "", settled = false;
    const done = (v) => { if (settled) return; settled = true; try { yt.kill("SIGKILL"); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ ok: false, err: "timeout" }), timeoutMs);
    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => { clearTimeout(timer); done({ ok: false, err: String(e?.message || e) }); });
    yt.on("close", (code) => {
      clearTimeout(timer);
      const url = out.trim().split("\n").filter(Boolean)[0];
      if (code === 0 && url && /^https?:\/\//.test(url)) done({ ok: true, url });
      else done({ ok: false, err: err.trim().slice(0, 300) || `exit ${code}` });
    });
  });
}

async function ytDlpManifest(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const baseArgs = (client) => {
    const a = [
      "-g", "--no-warnings", "--no-playlist",
      "--socket-timeout", "8",
      "--user-agent",
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      "--extractor-args", `youtube:player_client=${client}`,
    ];
    if (cookiePath && fs.existsSync(cookiePath)) a.unshift("--cookies", cookiePath);
    return a;
  };

  // ios/android クライアントは HLS manifest を返しやすい
  const tasks = [
    tryYtDlp([...baseArgs("ios"), "-f", "best", url], 12000),
    tryYtDlp([...baseArgs("android"), "-f", "best", url], 12000),
    tryYtDlp([...baseArgs("web_safari"), "-f", "best[protocol^=m3u8]/best", url], 12000),
    tryYtDlp([...baseArgs("tv_embedded"), "-f", "best", url], 12000),
  ];

  return await new Promise((resolve) => {
    let remaining = tasks.length;
    let lastErr = "";
    tasks.forEach((p) =>
      p.then((r) => {
        if (r.ok) return resolve({ ok: true, url: r.url, type: r.url.includes(".m3u8") ? "hls" : "mp4", source: "yt-dlp" });
        lastErr = r.err || lastErr;
      }).finally(() => {
        remaining -= 1;
        if (remaining === 0) resolve({ ok: false, err: lastErr || "yt-dlp failed" });
      })
    );
  });
}

// =========================================================
// 統合: Invidious -> yt-dlp の順で並列気味に
// =========================================================
async function getStream(videoId) {
  // Invidious を先に投げる（cookie 不要・速い）
  const invP = tryInvidious(videoId, 6000);
  // yt-dlp は少し遅延させて起動（Invidious が成功したら無駄にしない）
  const ytP = new Promise((resolve) => setTimeout(() => resolve(ytDlpManifest(videoId)), 1500))
    .then((p) => p);

  const inv = await invP;
  if (inv.ok) return inv;
  const yt = await ytP;
  if (yt.ok) return yt;
  // 最終フォールバック：cookie をリフレッシュしてもう一回 yt-dlp
  refreshCookies().catch(() => {});
  return { ok: false, err: inv.err || yt.err || "unknown" };
}

// =========================================================
// API
// =========================================================
app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");
  if (!/^[\w-]{6,20}$/.test(id)) {
    return res.status(200).json({ id, url: null, error: "invalid id" });
  }
  try {
    const cached = getCache(id);
    if (cached) return res.status(200).json({ id, url: cached.url, type: cached.type, source: cached.source, cached: true });

    let p = inflight.get(id);
    if (!p) {
      p = getStream(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    const r = await p;
    if (r.ok) {
      setCache(id, { url: r.url, type: r.type, source: r.source });
      return res.status(200).json({ id, url: r.url, type: r.type, source: r.source });
    }
    return res.status(200).json({ id, url: null, error: r.err || "failed" });
  } catch (e) {
    return res.status(200).json({ id, url: null, error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) =>
  res.status(200).json({
    ok: true,
    cookie: cookiePath ? path.basename(cookiePath) : null,
    invidious: INV_INSTANCES.length,
  })
);

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.listen(PORT, () => console.log(`listening on ${PORT}`));
