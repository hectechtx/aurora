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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function run(args) {
  const objectives = Array.isArray(args.objectives) ? args.objectives : null;
  if (!objectives || objectives.length === 0) {
    throw new Error("objectives must be a non-empty array");
  }

  const rows = ["| Objective | Key Result | Progress |", "| --- | --- | --- |"];
  const objectiveScores = [];

  for (const obj of objectives) {
    const objectiveName = String(obj?.objective ?? "").trim();
    if (!objectiveName) throw new Error("each objective must have a non-empty 'objective' name");
    const keyResults = Array.isArray(obj?.keyResults) ? obj.keyResults : [];
    if (keyResults.length === 0) throw new Error(`objective "${objectiveName}" must have at least one key result`);

    let sum = 0;
    for (const kr of keyResults) {
      const description = String(kr?.description ?? "").trim();
      const current = Number(kr?.current);
      const target = Number(kr?.target);
      if (!Number.isFinite(current) || !Number.isFinite(target) || target === 0) {
        throw new Error(`invalid key result under objective "${objectiveName}"`);
      }
      const progressPercent = clamp((current / target) * 100, 0, 100);
      sum += progressPercent;
      rows.push(`| ${objectiveName} | ${description} | ${Math.round(progressPercent)}% |`);
    }

    const avgProgressPercent = Math.round((sum / keyResults.length) * 100) / 100;
    objectiveScores.push({ objective: objectiveName, avgProgressPercent });
  }

  return { formatted: rows.join("\n"), objectiveScores };
}
