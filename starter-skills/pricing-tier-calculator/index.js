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

function roundToNinetyNine(price) {
  if (price <= 1) return Math.max(0, Math.round(price * 100) / 100);
  return Math.round(price) - 0.01;
}

function run(args) {
  const basePrice = Number(args.basePrice);
  if (!Number.isFinite(basePrice) || basePrice <= 0) throw new Error("basePrice must be a positive number");

  const tierMultipliers = Array.isArray(args.tierMultipliers) && args.tierMultipliers.length > 0
    ? args.tierMultipliers.map((m) => Number(m))
    : [1, 1.8, 3.2];

  if (tierMultipliers.some((m) => !Number.isFinite(m) || m <= 0)) {
    throw new Error("tierMultipliers must all be positive numbers");
  }

  const namedTiers = tierMultipliers.length === 3 ? ["Good", "Better", "Best"] : null;

  const tiers = tierMultipliers.map((m, i) => ({
    name: namedTiers ? namedTiers[i] : `Tier ${i + 1}`,
    price: roundToNinetyNine(basePrice * m),
  }));

  return { tiers };
}
