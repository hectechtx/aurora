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

const MATRICES = {
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
};

function parseHex(hex) {
  const m = String(hex ?? "").trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) throw new Error("hex must be a 6-digit hex color (with or without leading #)");
  const h = m[1];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    normalized: `#${h.toLowerCase()}`,
  };
}

function toHex(r, g, b) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function run(args) {
  const { r, g, b, normalized } = parseHex(args.hex);
  const type = args.type;
  const m = MATRICES[type];
  if (!m) throw new Error("type must be protanopia, deuteranopia, or tritanopia");
  const newR = m[0][0] * r + m[0][1] * g + m[0][2] * b;
  const newG = m[1][0] * r + m[1][1] * g + m[1][2] * b;
  const newB = m[2][0] * r + m[2][1] * g + m[2][2] * b;
  return { original: normalized, simulated: toHex(newR, newG, newB), type };
}
