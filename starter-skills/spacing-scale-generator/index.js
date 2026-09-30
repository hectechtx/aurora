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
  const baseUnitPx = args.baseUnitPx ?? 4;
  const steps = args.steps ?? 8;
  const ratio = args.ratio ?? 1.5;
  if (typeof baseUnitPx !== "number" || !isFinite(baseUnitPx) || baseUnitPx <= 0) {
    throw new Error("baseUnitPx must be a positive number");
  }
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
    throw new Error("steps must be a positive integer");
  }
  if (typeof ratio !== "number" || !isFinite(ratio) || ratio <= 0) {
    throw new Error("ratio must be a positive number");
  }
  const scale = [];
  for (let i = 0; i < steps; i++) {
    const px = Math.round(baseUnitPx * Math.pow(ratio, i));
    const rem = Math.round((px / 16) * 1000) / 1000;
    scale.push({ step: i, px, rem });
  }
  return { scale };
}
