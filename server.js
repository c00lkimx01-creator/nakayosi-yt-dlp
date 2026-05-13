import express from "express";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// cookie.txt があれば使うが、無くても動作する
const COOKIE_PATH = path.join(__dirname, "cookie.txt");
const hasCookie = fs.existsSync(COOKIE_PATH);

// yt-dlp を 1 回試行する。成功時は URL、失敗時は null を返す（throw しない）
function tryYtDlp(extraArgs) {
  return new Promise((resolve) => {
    const args = [...extraArgs];
    if (hasCookie) args.unshift("--cookies", COOKIE_PATH);
    const yt = spawn("yt-dlp", args);
    let out = "";
    let err = "";
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // 安全弁: 25 秒で諦める
    const timer = setTimeout(() => {
      try { yt.kill("SIGKILL"); } catch {}
      done({ ok: false, err: "timeout" });
    }, 25000);

    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, err: String(e.message || e) });
    });
    yt.on("close", (code) => {
      clearTimeout(timer);
      const url = out.trim().split("\n").filter(Boolean)[0];
      if (code === 0 && url && /^https?:\/\//.test(url)) {
        done({ ok: true, url });
      } else {
        done({ ok: false, err: err.trim() || `exit ${code}` });
      }
    });
  });
}

async function getStreamUrl(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // cookie 無しでも通りやすい順に複数戦略を試す
  const strategies = [
    ["-g", "-f", "best", "--extractor-args", "youtube:player_client=android", url],
    ["-g", "-f", "best", "--extractor-args", "youtube:player_client=ios", url],
    ["-g", "-f", "best", "--extractor-args", "youtube:player_client=web_safari", url],
    ["-g", "-f", "best", "--extractor-args", "youtube:player_client=tv_embedded", url],
    ["-g", "-f", "bestvideo*+bestaudio/best", "--extractor-args", "youtube:player_client=android", url],
    ["-g", "-f", "best", url],
  ];

  let lastErr = "";
  for (const args of strategies) {
    const r = await tryYtDlp(args);
    if (r.ok) return { url: r.url };
    lastErr = r.err;
  }
  return { url: null, error: lastErr || "unknown" };
}

app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{6,20}$/.test(id)) {
    // エラーを投げず常に 200 で返す
    return res.status(200).json({ id, url: null, error: "invalid id" });
  }
  try {
    const r = await getStreamUrl(id);
    if (r.url) return res.status(200).json({ id, url: r.url });
    return res.status(200).json({ id, url: null, error: r.error });
  } catch (e) {
    // 予期せぬ例外も 200 で返す（絶対にエラーで落とさない）
    return res.status(200).json({ id, url: null, error: String(e?.message || e) });
  }
});

// 想定外の例外でプロセスが死なないようにする
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

app.listen(PORT, () => console.log(`listening on ${PORT} (cookie: ${hasCookie ? "yes" : "no"})`));
