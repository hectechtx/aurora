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
  const { lines } = args;
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("lines must be a non-empty array");

  let totalBudgeted = 0;
  let totalSpent = 0;
  const result = [];
  for (const l of lines) {
    if (!l || typeof l.category !== "string" || typeof l.budgeted !== "number" || typeof l.spent !== "number") {
      throw new Error("each line requires category (string), budgeted (number), spent (number)");
    }
    const remaining = l.budgeted - l.spent;
    const overBudget = l.spent > l.budgeted;
    totalBudgeted += l.budgeted;
    totalSpent += l.spent;
    result.push({ category: l.category, budgeted: l.budgeted, spent: l.spent, remaining, overBudget });
  }

  return {
    lines: result,
    totalBudgeted,
    totalSpent,
    totalRemaining: totalBudgeted - totalSpent,
  };
}
