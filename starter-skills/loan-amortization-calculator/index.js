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
  const principal = Number(args.principal);
  const annualRatePercent = Number(args.annualRatePercent);
  const termMonths = Number(args.termMonths);

  if (![principal, annualRatePercent, termMonths].every(Number.isFinite)) {
    throw new Error("principal, annualRatePercent, and termMonths must be numbers");
  }
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new Error("termMonths must be a positive integer");
  }
  if (termMonths > 480) {
    throw new Error("termMonths must not exceed 480");
  }

  const r = annualRatePercent / 100 / 12;
  const payment = r === 0 ? principal / termMonths : (principal * r) / (1 - Math.pow(1 + r, -termMonths));

  let remainingBalance = principal;
  let totalInterest = 0;
  const schedule = [];

  for (let month = 1; month <= termMonths; month++) {
    const interestPaid = remainingBalance * r;
    let principalPaid = payment - interestPaid;
    remainingBalance -= principalPaid;
    if (month === termMonths) {
      // absorb any floating-point residue on the final payment
      principalPaid += remainingBalance;
      remainingBalance = 0;
    }
    totalInterest += interestPaid;
    schedule.push({
      month,
      payment: round2(payment),
      principalPaid: round2(principalPaid),
      interestPaid: round2(interestPaid),
      remainingBalance: round2(remainingBalance)
    });
  }

  return {
    monthlyPayment: round2(payment),
    totalInterest: round2(totalInterest),
    schedule
  };
}
