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

const PHI = 1.618033988749895;

function run(args) {
  const dimension = args.dimension;
  if (typeof dimension !== "number" || !isFinite(dimension) || dimension <= 0) {
    throw new Error("dimension must be a positive number");
  }
  const largeSection = dimension / PHI;
  const smallSection = dimension - largeSection;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    total: dimension,
    largeSection: round2(largeSection),
    smallSection: round2(smallSection),
    ratio: "1:1.618",
  };
}
