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
  const { widthPx, heightPx } = args;
  const dpi = args.dpi ?? 300;
  if (typeof widthPx !== "number" || !isFinite(widthPx) || widthPx <= 0) {
    throw new Error("widthPx must be a positive number");
  }
  if (typeof heightPx !== "number" || !isFinite(heightPx) || heightPx <= 0) {
    throw new Error("heightPx must be a positive number");
  }
  if (typeof dpi !== "number" || !isFinite(dpi) || dpi <= 0) {
    throw new Error("dpi must be a positive number");
  }
  const widthInches = widthPx / dpi;
  const heightInches = heightPx / dpi;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    widthInches: round2(widthInches),
    heightInches: round2(heightInches),
    widthCm: round2(widthInches * 2.54),
    heightCm: round2(heightInches * 2.54),
  };
}
