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

const NAMED_RATIOS = {
  minorSecond: 1.067,
  majorSecond: 1.125,
  minorThird: 1.2,
  majorThird: 1.25,
  perfectFourth: 1.333,
  goldenRatio: 1.618,
};

function run(args) {
  const baseSizePx = args.baseSizePx ?? 16;
  const steps = args.steps ?? 6;
  let ratio = args.ratio ?? 1.25;
  if (typeof ratio === "string") {
    if (!Object.prototype.hasOwnProperty.call(NAMED_RATIOS, ratio)) {
      throw new Error(`unknown ratio name "${ratio}". Valid names: ${Object.keys(NAMED_RATIOS).join(", ")}`);
    }
    ratio = NAMED_RATIOS[ratio];
  }
  if (typeof baseSizePx !== "number" || !isFinite(baseSizePx) || baseSizePx <= 0) {
    throw new Error("baseSizePx must be a positive number");
  }
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
    throw new Error("steps must be a positive integer");
  }
  if (typeof ratio !== "number" || !isFinite(ratio) || ratio <= 0) {
    throw new Error("ratio must be a positive number or a known named ratio");
  }
  const scale = [];
  for (let i = 0; i < steps; i++) {
    const px = Math.round(baseSizePx * Math.pow(ratio, i));
    const rem = Math.round((px / 16) * 1000) / 1000;
    scale.push({ step: i, px, rem });
  }
  return { scale };
}
