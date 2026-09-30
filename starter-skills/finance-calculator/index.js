const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stdout.write(JSON.stringify({ error: "invalid stdin payload" }));
    return;
  }
  const args = payload?.args ?? {};
  const op = String(args.operation ?? "");

  if (op === "percent_change") {
    const from = Number(args.from), to = Number(args.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) {
      process.stdout.write(JSON.stringify({ error: "from and to are required, and from can't be 0" }));
      return;
    }
    const pct = ((to - from) / Math.abs(from)) * 100;
    process.stdout.write(JSON.stringify({ percentChange: Math.round(pct * 100) / 100, direction: pct >= 0 ? "increase" : "decrease" }));
    return;
  }

  if (op === "simple_interest" || op === "compound_interest") {
    const principal = Number(args.principal), rate = Number(args.rate), years = Number(args.years);
    if (!Number.isFinite(principal) || !Number.isFinite(rate) || !Number.isFinite(years)) {
      process.stdout.write(JSON.stringify({ error: "principal, rate, and years are required" }));
      return;
    }
    const r = rate / 100;
    if (op === "simple_interest") {
      const interest = principal * r * years;
      process.stdout.write(JSON.stringify({ interest: Math.round(interest * 100) / 100, total: Math.round((principal + interest) * 100) / 100 }));
    } else {
      const n = Number(args.compoundsPerYear) || 12;
      const total = principal * Math.pow(1 + r / n, n * years);
      process.stdout.write(JSON.stringify({ interest: Math.round((total - principal) * 100) / 100, total: Math.round(total * 100) / 100 }));
    }
    return;
  }

  process.stdout.write(JSON.stringify({ error: `unknown operation "${op}"` }));
});
