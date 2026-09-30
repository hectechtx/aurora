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

function run(args) {
  const { frames, sourceFps, targetFps } = args;
  if (typeof frames !== "number" || !isFinite(frames) || frames < 0) {
    throw new Error("frames must be a non-negative number");
  }
  if (typeof sourceFps !== "number" || !isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error("sourceFps must be a positive number");
  }
  if (typeof targetFps !== "number" || !isFinite(targetFps) || targetFps <= 0) {
    throw new Error("targetFps must be a positive number");
  }
  const seconds = frames / sourceFps;
  const targetFrames = Math.round(seconds * targetFps);
  return { seconds: Math.round(seconds * 1000) / 1000, targetFrames };
}
