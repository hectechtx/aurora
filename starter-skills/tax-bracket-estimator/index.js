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

// Simplified, approximate 2024-ish brackets. Illustrative only.
const BRACKETS = {
  single: [
    { upTo: 11600, rate: 0.10 },
    { upTo: 47150, rate: 0.12 },
    { upTo: 100525, rate: 0.22 },
    { upTo: 191950, rate: 0.24 },
    { upTo: 243725, rate: 0.32 },
    { upTo: 609350, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 }
  ],
  marriedJoint: [
    { upTo: 23200, rate: 0.10 },
    { upTo: 94300, rate: 0.12 },
    { upTo: 201050, rate: 0.22 },
    { upTo: 383900, rate: 0.24 },
    { upTo: 487450, rate: 0.32 },
    { upTo: 731200, rate: 0.35 },
    { upTo: Infinity, rate: 0.37 }
  ]
};

function run(args) {
  const income = Number(args.income);
  const filingStatus = args.filingStatus;

  if (!Number.isFinite(income) || income < 0) {
    throw new Error("income must be a non-negative number");
  }
  if (!BRACKETS[filingStatus]) {
    throw new Error("filingStatus must be 'single' or 'marriedJoint'");
  }

  const brackets = BRACKETS[filingStatus];
  let tax = 0;
  let lowerBound = 0;

  for (const bracket of brackets) {
    if (income <= lowerBound) break;
    const taxableInBracket = Math.min(income, bracket.upTo) - lowerBound;
    tax += taxableInBracket * bracket.rate;
    lowerBound = bracket.upTo;
  }

  const estimatedTax = Math.round(tax * 100) / 100;
  const effectiveRatePercent = income > 0 ? Math.round((tax / income) * 1000) / 10 : 0;

  return {
    estimatedTax,
    effectiveRatePercent,
    disclaimer: "Illustrative estimate only — not tax advice. Consult a professional for actual filing."
  };
}
