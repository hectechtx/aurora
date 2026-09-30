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

const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

function run(args) {
  const { startValue, endValue, steps } = args;
  const easing = args.easing ?? "linear";
  if (typeof startValue !== "number" || !isFinite(startValue)) {
    throw new Error("startValue must be a number");
  }
  if (typeof endValue !== "number" || !isFinite(endValue)) {
    throw new Error("endValue must be a number");
  }
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 2) {
    throw new Error("steps must be an integer >= 2");
  }
  const easeFn = EASINGS[easing];
  if (!easeFn) {
    throw new Error("easing must be linear, easeIn, easeOut, or easeInOut");
  }
  const values = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const easedT = easeFn(t);
    const value = startValue + (endValue - startValue) * easedT;
    values.push(Math.round(value * 10000) / 10000);
  }
  return { values };
}
