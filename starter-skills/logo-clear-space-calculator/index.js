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
  const { logoWidthPx, logoHeightPx } = args;
  const clearSpaceRatio = args.clearSpaceRatio ?? 0.25;
  if (typeof logoWidthPx !== "number" || !isFinite(logoWidthPx) || logoWidthPx <= 0) {
    throw new Error("logoWidthPx must be a positive number");
  }
  if (typeof logoHeightPx !== "number" || !isFinite(logoHeightPx) || logoHeightPx <= 0) {
    throw new Error("logoHeightPx must be a positive number");
  }
  if (typeof clearSpaceRatio !== "number" || !isFinite(clearSpaceRatio) || clearSpaceRatio <= 0) {
    throw new Error("clearSpaceRatio must be a positive number");
  }
  const clearSpacePx = Math.round(Math.min(logoWidthPx, logoHeightPx) * clearSpaceRatio);
  const minimumSizePx = Math.round(Math.max(logoHeightPx * 0.15, 24));
  return {
    clearSpacePx,
    minimumSizePx,
    guidance: `Keep at least ${clearSpacePx}px of clear space around the logo. Don't display it smaller than ${minimumSizePx}px tall.`,
  };
}
