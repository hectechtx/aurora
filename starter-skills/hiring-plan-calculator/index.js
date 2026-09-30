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
  const currentHeadcount = Number(args.currentHeadcount);
  const targetHeadcount = Number(args.targetHeadcount);
  const averageSalary = Number(args.averageSalary);
  const benefitsLoadPercent = args.benefitsLoadPercent === undefined ? 25 : Number(args.benefitsLoadPercent);

  if (![currentHeadcount, targetHeadcount, averageSalary, benefitsLoadPercent].every(Number.isFinite)) {
    throw new Error("currentHeadcount, targetHeadcount, averageSalary, and benefitsLoadPercent must be numbers");
  }

  const newHires = targetHeadcount - currentHeadcount;
  if (newHires < 0) {
    throw new Error("target is below current headcount");
  }

  const fullyLoadedCostPerHire = averageSalary * (1 + benefitsLoadPercent / 100);
  const totalAnnualBudget = newHires * fullyLoadedCostPerHire;

  return { newHires, fullyLoadedCostPerHire, totalAnnualBudget };
}
