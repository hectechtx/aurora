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
  const cashBalance = Number(args.cashBalance);
  const monthlyBurn = Number(args.monthlyBurn);
  if (!Number.isFinite(cashBalance) || !Number.isFinite(monthlyBurn)) {
    throw new Error("cashBalance and monthlyBurn must be numbers");
  }

  if (monthlyBurn <= 0) {
    return { runwayMonths: null, note: "Profitable or break-even — no burn to project against." };
  }

  const runwayMonths = Math.round((cashBalance / monthlyBurn) * 10) / 10;

  const now = new Date();
  const wholeMonths = Math.floor(runwayMonths);
  const fractionalDays = Math.round((runwayMonths - wholeMonths) * 30);
  const runoutDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + wholeMonths,
    now.getUTCDate() + fractionalDays
  ));
  const estimatedRunoutDate = runoutDate.toISOString().slice(0, 10);

  return { runwayMonths, estimatedRunoutDate };
}
