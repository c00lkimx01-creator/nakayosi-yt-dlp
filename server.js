import express from "express";
import compression from "compression";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// gzip + 静的ファイルキャッシュで配信を高速化
app.use(compression());
app.use((req, res, next) => {
  // CORS（フロントから直接呼べるように）
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

// cookie.txt があれば使う。無くてもOK
const COOKIE_PATH = path.join(__dirname, "cookie.txt");
const hasCookie = fs.existsSync(COOKIE_PATH);

// 簡易メモリキャッシュ（TTL 5 分）
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // id -> { url, expires }
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

// 進行中のリクエストを束ねる（同じ id が同時に来ても yt-dlp は 1 回だけ）
const inflight = new Map(); // id -> Promise

// yt-dlp を 1 回試行。失敗しても throw しない
function tryYtDlp(extraArgs, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const args = [...extraArgs];
    if (hasCookie) args.unshift("--cookies", COOKIE_PATH);
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
      else done({ ok: false, err: err.trim() || `exit ${code}` });
    });
  });
}

// 速い client から並列に試して、最初に成功したものを使う
async function getStreamUrl(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const base = ["-g", "-f", "best", "--no-warnings", "--no-playlist", "--socket-timeout", "10"];
  const clients = ["android", "ios", "web_safari", "tv_embedded"];

  const attempts = clients.map((c) =>
    tryYtDlp([...base, "--extractor-args", `youtube:player_client=${c}`, url], 12000)
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
  // キャッシュ用ヘッダ
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
    return res.status(200).json({ id, url: null, error: r.error });
  } catch (e) {
    return res.status(200).json({ id, url: null, error: String(e?.message || e) });
  }
});

// ヘルスチェック
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

// 想定外の例外でプロセスが死なないように
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.listen(PORT, () =>
  console.log(`listening on ${PORT} (cookie: ${hasCookie ? "yes" : "no"})`)
);
