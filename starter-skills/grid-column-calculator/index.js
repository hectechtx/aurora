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
  const containerWidth = args.containerWidth;
  const columns = args.columns;
  const gutter = args.gutter ?? 16;
  if (typeof containerWidth !== "number" || !isFinite(containerWidth) || containerWidth <= 0) {
    throw new Error("containerWidth must be a positive number");
  }
  if (typeof columns !== "number" || !Number.isInteger(columns) || columns < 1) {
    throw new Error("columns must be a positive integer");
  }
  if (typeof gutter !== "number" || !isFinite(gutter) || gutter < 0) {
    throw new Error("gutter must be a non-negative number");
  }
  const columnWidth = Math.round(((containerWidth - gutter * (columns - 1)) / columns) * 100) / 100;
  return { columnWidth, columns, gutter, containerWidth };
}
