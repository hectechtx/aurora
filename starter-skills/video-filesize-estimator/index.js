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
  const { videoBitrateKbps, durationSeconds, audioBitrateKbps = 128 } = args;
  if (typeof videoBitrateKbps !== "number" || !isFinite(videoBitrateKbps) || videoBitrateKbps < 0) {
    throw new Error("videoBitrateKbps must be a non-negative number");
  }
  if (typeof durationSeconds !== "number" || !isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error("durationSeconds must be a non-negative number");
  }
  if (typeof audioBitrateKbps !== "number" || !isFinite(audioBitrateKbps) || audioBitrateKbps < 0) {
    throw new Error("audioBitrateKbps must be a non-negative number");
  }

  const totalKbits = (videoBitrateKbps + audioBitrateKbps) * durationSeconds;
  const totalBytes = (totalKbits * 1000) / 8;
  const estimatedSizeMb = totalBytes / (1024 * 1024);

  return { estimatedSizeMb: Math.round(estimatedSizeMb * 100) / 100 };
}
