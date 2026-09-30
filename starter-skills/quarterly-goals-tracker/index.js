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
  const inputGoals = args.goals;
  if (!Array.isArray(inputGoals) || inputGoals.length === 0) {
    throw new Error("goals must be a non-empty array");
  }

  let onTrack = 0;
  let needsAttention = 0;
  let atRisk = 0;

  const goals = inputGoals.map((g) => {
    const name = String(g.name ?? "");
    const progressPercent = Number(g.progressPercent);
    const dueInWeeks = Number(g.dueInWeeks);
    if (!name || !Number.isFinite(progressPercent) || !Number.isFinite(dueInWeeks)) {
      throw new Error("each goal needs a name, progressPercent, and dueInWeeks");
    }

    let status;
    if (progressPercent >= 90) { status = "On Track"; onTrack++; }
    else if (progressPercent >= 50) { status = "Needs Attention"; needsAttention++; }
    else { status = "At Risk"; atRisk++; }

    const flagged = dueInWeeks <= 2 && progressPercent < 80;

    return { name, progressPercent, dueInWeeks, status, flagged };
  });

  return { goals, summary: { onTrack, needsAttention, atRisk } };
}
