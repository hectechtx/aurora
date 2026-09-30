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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function run(args) {
  const inputLines = args.lines;
  if (!Array.isArray(inputLines) || inputLines.length === 0) {
    throw new Error("lines must be a non-empty array");
  }

  let totalBudgeted = 0;
  let totalActual = 0;

  const lines = inputLines.map((l) => {
    const name = String(l.name ?? "");
    const budgeted = Number(l.budgeted);
    const actual = Number(l.actual);
    if (!name || !Number.isFinite(budgeted) || !Number.isFinite(actual)) {
      throw new Error("each line needs a name, budgeted, and actual");
    }
    const variance = actual - budgeted;
    const variancePercent = budgeted !== 0 ? round2((variance / budgeted) * 100) : null;
    const status = variance > 0 ? "Over Budget" : variance < 0 ? "Under Budget" : "On Budget";

    totalBudgeted += budgeted;
    totalActual += actual;

    return { name, budgeted, actual, variance: round2(variance), variancePercent, status };
  });

  return {
    lines,
    totalBudgeted: round2(totalBudgeted),
    totalActual: round2(totalActual),
    totalVariance: round2(totalActual - totalBudgeted)
  };
}
