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
  const { secondsPerFrame, totalFrames } = args;
  if (typeof secondsPerFrame !== "number" || !isFinite(secondsPerFrame) || secondsPerFrame < 0) {
    throw new Error("secondsPerFrame must be a non-negative number");
  }
  if (typeof totalFrames !== "number" || !Number.isInteger(totalFrames) || totalFrames < 0) {
    throw new Error("totalFrames must be a non-negative integer");
  }
  const totalSeconds = secondsPerFrame * totalFrames;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  const formatted = `${h}h ${m}m ${s}s`;
  return { totalSeconds: Math.round(totalSeconds), formatted };
}
