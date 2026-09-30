// YouTube Transcript skill — uses the yt-dlp binary AURORA already bundles for
// its music feature (data/musicsearch/yt-dlp.exe) to pull captions reliably.
// A pure fetch of YouTube's timedtext now returns empty without a browser
// session, so yt-dlp (which handles that) is the dependable path. yt-dlp writes
// a .vtt subtitle file into the skill's own working dir; we parse and clean it,
// then delete it.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", async () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  try {
    process.stdout.write(JSON.stringify(await run(payload?.args ?? {})));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

function videoId(input) {
  const s = String(input ?? "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  throw new Error("could not find an 11-character YouTube video id in the input");
}

// yt-dlp lives under the app's data dir; the runner hands us the full env, so
// AURORA_DATA_DIR (or APPDATA) locates it. Fall back to a bare "yt-dlp" on PATH.
function ytDlpPath() {
  const candidates = [];
  if (process.env.AURORA_DATA_DIR) candidates.push(path.join(process.env.AURORA_DATA_DIR, "musicsearch", "yt-dlp.exe"));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "AURORA", "data", "musicsearch", "yt-dlp.exe"));
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function parseVtt(vtt) {
  const lines = vtt.split(/\r?\n/);
  const out = [];
  let last = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("WEBVTT") || line.startsWith("Kind:") || line.startsWith("Language:")) continue;
    if (line.includes("-->") || /^\d+$/.test(line.trim())) continue;
    const clean = line.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (clean && clean !== last) { out.push(clean); last = clean; } // yt auto-subs repeat rolling lines; dedupe adjacent
  }
  return out.join(" ").trim();
}

function run(args) {
  const id = videoId(args.video);
  const lang = String(args.lang ?? "en").trim() || "en";
  const bin = ytDlpPath();
  const outBase = path.join(os.tmpdir(), `aurora-yt-${id}-${Date.now()}`);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [
      "--skip-download", "--write-auto-subs", "--write-subs",
      "--sub-langs", `${lang}.*,${lang},en`, "--sub-format", "vtt",
      "-o", `${outBase}.%(ext)s`,
      `https://www.youtube.com/watch?v=${id}`,
    ], { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => reject(new Error(`could not run yt-dlp (${err.message})`)));

    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 25000);

    child.on("close", () => {
      clearTimeout(killer);
      let dir, base;
      try { dir = path.dirname(outBase); base = path.basename(outBase); } catch { dir = os.tmpdir(); base = ""; }
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith(".vtt")); } catch { /* ignore */ }
      if (!files.length) {
        return reject(new Error(`no captions retrieved (video may have none, or be region/age restricted). yt-dlp said: ${stderr.slice(-200).trim()}`));
      }
      const preferred = files.find((f) => f.includes(`.${lang}`)) || files[0];
      let text = "";
      try { text = parseVtt(fs.readFileSync(path.join(dir, preferred), "utf8")); } catch { /* ignore */ }
      for (const f of files) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
      if (!text) return reject(new Error("caption file was empty after parsing"));
      resolve({ videoId: id, subtitleFile: preferred.replace(dir, ""), charCount: text.length, transcript: text.slice(0, 40000), truncated: text.length > 40000 });
    });
  });
}
