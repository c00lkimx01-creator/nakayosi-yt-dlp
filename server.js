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
  express.static(path.join(__dirname, "public"), {
    maxAge: "1h",
    etag: true,
  })
);

// =========================================================
// Cookie 自動取得：YouTube に HEAD/GET して Set-Cookie を保存
// cookie.txt が手動配置されていればそれを優先
// =========================================================
const MANUAL_COOKIE = path.join(__dirname, "cookie.txt");
const AUTO_COOKIE = path.join(os.tmpdir(), "yt_auto_cookies.txt");
let cookiePath = null;
let cookieExpires = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000; // 30 分

function writeNetscapeCookies(setCookieHeaders, file) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Auto-generated",
  ];
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 60 * 60 * 24 * 180; // 180 日
  for (const raw of setCookieHeaders) {
    // 例: "VISITOR_INFO1_LIVE=abc; Path=/; Domain=.youtube.com; ..."
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
      if (k.toLowerCase() === "domain" && v) domain = v.startsWith(".") ? v : "." + v;
      if (k.toLowerCase() === "path" && v) cookiePathAttr = v;
    }
    lines.push(
      [domain, "TRUE", cookiePathAttr, "FALSE", expires, name, value].join("\t")
    );
  }
  // CONSENT を念のため付与（EU 同意ダイアログ回避）
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "CONSENT", "YES+1"].join("\t"));
  lines.push([".youtube.com", "TRUE", "/", "FALSE", expires, "SOCS", "CAI"].join("\t"));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

async function refreshCookies() {
  // 手動 cookie が置いてあれば常にそれを使う
  if (fs.existsSync(MANUAL_COOKIE)) {
    cookiePath = MANUAL_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
    return cookiePath;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
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
    // 複数 Set-Cookie を取得
    let setCookies = [];
    if (typeof r.headers.getSetCookie === "function") {
      setCookies = r.headers.getSetCookie();
    } else {
      const raw = r.headers.get("set-cookie");
      if (raw) setCookies = raw.split(/,(?=[^;]+=)/);
    }
    if (setCookies.length > 0) {
      writeNetscapeCookies(setCookies, AUTO_COOKIE);
      cookiePath = AUTO_COOKIE;
      cookieExpires = Date.now() + COOKIE_TTL_MS;
      console.log(`auto cookies refreshed (${setCookies.length})`);
      return cookiePath;
    }
  } catch (e) {
    console.error("cookie refresh failed:", e?.message || e);
  }
  // 失敗しても最低限の CONSENT クッキーだけ作る
  try {
    writeNetscapeCookies([], AUTO_COOKIE);
    cookiePath = AUTO_COOKIE;
    cookieExpires = Date.now() + COOKIE_TTL_MS;
  } catch {}
  return cookiePath;
}

async function ensureCookies() {
  if (cookiePath && Date.now() < cookieExpires && fs.existsSync(cookiePath)) {
    return cookiePath;
  }
  return await refreshCookies();
}

// 起動時に 1 回取得（失敗してもサーバーは動かす）
refreshCookies().catch(() => {});

// =========================================================
// 結果キャッシュと in-flight 共有
// =========================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
function getCache(id) {
  const v = cache.get(id);
  if (!v) return null;
  if (Date.now() > v.expires) {
    cache.delete(id);
    return null;
  }
  return v.url;
}
function setCache(id, url) {
  cache.set(id, { url, expires: Date.now() + CACHE_TTL_MS });
}
const inflight = new Map();

// =========================================================
// yt-dlp 実行
// =========================================================
function tryYtDlp(extraArgs, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const args = [...extraArgs];
    if (cookiePath && fs.existsSync(cookiePath)) {
      args.unshift("--cookies", cookiePath);
    }
    let yt;
    try {
      yt = spawn("yt-dlp", args);
    } catch (e) {
      return resolve({ ok: false, err: String(e?.message || e) });
    }
    let out = "";
    let err = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { yt.kill("SIGKILL"); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, err: "timeout" }), timeoutMs);
    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, err: String(e?.message || e) });
    });
    yt.on("close", (code) => {
      clearTimeout(timer);
      const url = out.trim().split("\n").filter(Boolean)[0];
      if (code === 0 && url && /^https?:\/\//.test(url)) done({ ok: true, url });
      else done({ ok: false, err: err.trim().slice(0, 300) || `exit ${code}` });
    });
  });
}

async function getStreamUrl(videoId) {
  await ensureCookies();
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const base = [
    "-g",
    "-f",
    "best",
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout",
    "10",
    "--user-agent",
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  ];
  const clients = ["android", "ios", "web_safari", "tv_embedded", "mweb"];

  const attempts = clients.map((c) =>
    tryYtDlp(
      [...base, "--extractor-args", `youtube:player_client=${c}`, url],
      15000
    )
  );

  return await new Promise((resolve) => {
    let remaining = attempts.length;
    let lastErr = "";
    attempts.forEach((p) => {
      p.then((r) => {
        if (r.ok) return resolve({ url: r.url });
        lastErr = r.err || lastErr;
        remaining -= 1;
        if (remaining === 0) resolve({ url: null, error: lastErr || "unknown" });
      }).catch((e) => {
        lastErr = String(e?.message || e);
        remaining -= 1;
        if (remaining === 0) resolve({ url: null, error: lastErr });
      });
    });
  });
}

app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  res.setHeader("Cache-Control", "public, max-age=120");

  if (!/^[\w-]{6,20}$/.test(id)) {
    return res.status(200).json({ id, url: null, error: "invalid id" });
  }

  try {
    const cached = getCache(id);
    if (cached) return res.status(200).json({ id, url: cached, cached: true });

    let p = inflight.get(id);
    if (!p) {
      p = getStreamUrl(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    const r = await p;
    if (r.url) {
      setCache(id, r.url);
      return res.status(200).json({ id, url: r.url });
    }
    // 失敗時は cookie を強制リフレッシュして次回に備える
    refreshCookies().catch(() => {});
    return res.status(200).json({ id, url: null, error: r.error });
  } catch (e) {
    return res.status(200).json({ id, url: null, error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) =>
  res.status(200).json({ ok: true, cookie: cookiePath ? path.basename(cookiePath) : null })
);

process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.listen(PORT, () => console.log(`listening on ${PORT}`));
