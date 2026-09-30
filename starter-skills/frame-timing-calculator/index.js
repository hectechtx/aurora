const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  const args = payload?.args ?? {};
  try {
    const result = run(args);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

function parseTimecode(tc, fps) {
  const m = String(tc ?? "").trim().match(/^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (!m) throw new Error("timecode must be in HH:MM:SS:FF format");
  const h = Number(m[1]), mnt = Number(m[2]), s = Number(m[3]), f = Number(m[4]);
  return (h * 3600 + mnt * 60 + s) * fps + f;
}

function framesToTimecode(frames, fps) {
  const totalSeconds = Math.floor(frames / fps);
  const ff = Math.round(frames - totalSeconds * fps);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function run(args) {
  const fps = args.fps;
  if (typeof fps !== "number" || !isFinite(fps) || fps <= 0) {
    throw new Error("fps must be a positive number");
  }
  const provided = ["frames", "seconds", "timecode"].filter(
    (k) => args[k] !== undefined && args[k] !== null
  );
  if (provided.length !== 1) {
    throw new Error("provide exactly one of frames, seconds, or timecode");
  }

  let frames, seconds;
  if (args.frames !== undefined) {
    frames = args.frames;
    if (typeof frames !== "number" || !isFinite(frames) || frames < 0) {
      throw new Error("frames must be a non-negative number");
    }
    seconds = frames / fps;
  } else if (args.seconds !== undefined) {
    seconds = args.seconds;
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) {
      throw new Error("seconds must be a non-negative number");
    }
    frames = Math.round(seconds * fps);
  } else {
    frames = parseTimecode(args.timecode, fps);
    seconds = frames / fps;
  }

  const timecode = framesToTimecode(frames, fps);
  return {
    fps,
    frames: Math.round(frames),
    seconds: Math.round(seconds * 1000) / 1000,
    timecode,
  };
}
