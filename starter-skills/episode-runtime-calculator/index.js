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

function formatDuration(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function run(args) {
  const { segments } = args;
  if (!Array.isArray(segments) || segments.length === 0) throw new Error("segments must be a non-empty array");

  let cumulative = 0;
  const result = [];
  for (const seg of segments) {
    if (!seg || typeof seg.name !== "string" || typeof seg.durationSeconds !== "number" || seg.durationSeconds < 0) {
      throw new Error("each segment requires name (string) and durationSeconds (non-negative number)");
    }
    result.push({
      name: seg.name,
      durationSeconds: seg.durationSeconds,
      cumulativeStartFormatted: formatDuration(cumulative),
    });
    cumulative += seg.durationSeconds;
  }

  return {
    totalRuntimeFormatted: formatDuration(cumulative),
    totalSeconds: cumulative,
    segments: result,
  };
}
