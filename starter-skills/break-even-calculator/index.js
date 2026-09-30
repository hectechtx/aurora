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
  const fixedCosts = Number(args.fixedCosts);
  const pricePerUnit = Number(args.pricePerUnit);
  const variableCostPerUnit = Number(args.variableCostPerUnit);

  if (!Number.isFinite(fixedCosts) || fixedCosts < 0) throw new Error("fixedCosts must be a non-negative number");
  if (!Number.isFinite(pricePerUnit)) throw new Error("pricePerUnit must be a number");
  if (!Number.isFinite(variableCostPerUnit)) throw new Error("variableCostPerUnit must be a number");

  const contributionMargin = pricePerUnit - variableCostPerUnit;
  if (contributionMargin <= 0) {
    throw new Error("pricePerUnit must exceed variableCostPerUnit for a break-even point to exist");
  }

  const breakEvenUnits = Math.ceil(fixedCosts / contributionMargin);
  const breakEvenRevenue = breakEvenUnits * pricePerUnit;

  return { breakEvenUnits, breakEvenRevenue, contributionMargin };
}
