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
  const startingBalance = Number(args.startingBalance);
  const monthlyInflow = Number(args.monthlyInflow);
  const monthlyOutflow = Number(args.monthlyOutflow);
  const months = args.months === undefined ? 12 : Number(args.months);

  if (![startingBalance, monthlyInflow, monthlyOutflow, months].every(Number.isFinite)) {
    throw new Error("startingBalance, monthlyInflow, monthlyOutflow, and months must be numbers");
  }
  if (months > 60 || months < 1 || !Number.isInteger(months)) {
    throw new Error("months must be an integer between 1 and 60");
  }

  const projection = [];
  let balance = startingBalance;
  for (let i = 0; i < months; i++) {
    balance += monthlyInflow - monthlyOutflow;
    projection.push({ month: i + 1, balance: Math.round(balance * 100) / 100 });
  }

  return { projection, endingBalance: projection[projection.length - 1].balance };
}
