import express from "express";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

function getStreamUrl(videoId) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // -g prints the direct media URL (googlevideo.com)
    // -f best picks a single muxed stream when available
    const yt = spawn("yt-dlp", ["-g", "-f", "best", url]);
    let out = "";
    let err = "";
    yt.stdout.on("data", (d) => (out += d.toString()));
    yt.stderr.on("data", (d) => (err += d.toString()));
    yt.on("error", (e) => reject(e));
    yt.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || `yt-dlp exit ${code}`));
      const lines = out.trim().split("\n").filter(Boolean);
      resolve(lines[0]);
    });
  });
}

app.get("/api/video/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[\w-]{6,20}$/.test(id)) {
    return res.status(400).json({ error: "invalid id" });
  }
  try {
    const streamUrl = await getStreamUrl(id);
    res.json({ id, url: streamUrl });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log(`listening on ${PORT}`));
