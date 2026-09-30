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
  const investment = Number(args.investment);
  const totalReturn = Number(args.totalReturn);

  if (!Number.isFinite(investment) || !Number.isFinite(totalReturn)) {
    throw new Error("investment and totalReturn must be numbers");
  }
  if (investment === 0) {
    throw new Error("investment must not be zero");
  }

  const roiPercent = ((totalReturn - investment) / investment) * 100;

  let paybackPeriods = null;
  if (args.periods !== undefined) {
    const periods = Number(args.periods);
    if (!Number.isFinite(periods)) {
      throw new Error("periods must be a number");
    }
    if (periods > 0) {
      const avgReturnPerPeriod = totalReturn / periods;
      paybackPeriods = avgReturnPerPeriod !== 0 ? investment / avgReturnPerPeriod : null;
    }
  }

  return { roiPercent, paybackPeriods };
}
