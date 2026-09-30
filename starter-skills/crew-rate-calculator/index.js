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
  const { roles } = args;
  if (!Array.isArray(roles) || roles.length === 0) throw new Error("roles must be a non-empty array");

  let grandTotal = 0;
  const result = [];
  for (const r of roles) {
    if (
      !r ||
      typeof r.role !== "string" ||
      typeof r.dayRate !== "number" ||
      typeof r.headcount !== "number" ||
      typeof r.days !== "number"
    ) {
      throw new Error("each role requires role (string), dayRate, headcount, and days (numbers)");
    }
    if (r.dayRate < 0 || r.headcount < 0 || r.days < 0) {
      throw new Error("dayRate, headcount, and days must not be negative");
    }
    const totalCost = r.dayRate * r.headcount * r.days;
    grandTotal += totalCost;
    result.push({ role: r.role, dayRate: r.dayRate, headcount: r.headcount, days: r.days, totalCost });
  }

  return { roles: result, grandTotal };
}
