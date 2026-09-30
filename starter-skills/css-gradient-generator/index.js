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
  const colors = args.colors;
  const angleDeg = args.angleDeg ?? 90;
  const type = args.type ?? "linear";
  if (!Array.isArray(colors) || colors.length < 2 || !colors.every((c) => typeof c === "string" && c.trim())) {
    throw new Error("colors must be an array of at least 2 non-empty color strings");
  }
  if (!["linear", "radial"].includes(type)) {
    throw new Error("type must be linear or radial");
  }
  if (typeof angleDeg !== "number" || !isFinite(angleDeg)) {
    throw new Error("angleDeg must be a number");
  }
  const css = type === "radial"
    ? `radial-gradient(circle, ${colors.join(", ")})`
    : `linear-gradient(${angleDeg}deg, ${colors.join(", ")})`;
  return { css };
}
