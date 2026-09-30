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
  const shots = args.shots;
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error("shots must be a non-empty array");
  }
  let cumulativeStart = 0;
  const rows = [];
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (
      !shot ||
      typeof shot.description !== "string" ||
      !shot.description.trim() ||
      typeof shot.durationSeconds !== "number" ||
      !isFinite(shot.durationSeconds) ||
      shot.durationSeconds <= 0
    ) {
      throw new Error(`shot ${i + 1} must have a non-empty description and a positive durationSeconds`);
    }
    rows.push({
      num: i + 1,
      start: cumulativeStart,
      duration: shot.durationSeconds,
      description: shot.description,
      notes: typeof shot.notes === "string" ? shot.notes : "",
    });
    cumulativeStart += shot.durationSeconds;
  }

  let formatted = "| Shot# | Start | Duration | Description | Notes |\n|---|---|---|---|---|\n";
  for (const r of rows) {
    formatted += `| ${r.num} | ${r.start}s | ${r.duration}s | ${r.description} | ${r.notes} |\n`;
  }

  return { formatted, totalDurationSeconds: cumulativeStart };
}
