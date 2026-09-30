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

const SIZES = [
  { sizePx: 16, label: "Classic favicon" },
  { sizePx: 32, label: "Standard favicon" },
  { sizePx: 48, label: "Windows site icon" },
  { sizePx: 180, label: "Apple touch icon" },
  { sizePx: 192, label: "Android Chrome (small)" },
  { sizePx: 512, label: "Android Chrome (large) / PWA splash" },
];

function run(args) {
  const sourceSizePx = args.sourceSizePx ?? 1024;
  if (typeof sourceSizePx !== "number" || !isFinite(sourceSizePx) || sourceSizePx <= 0) {
    throw new Error("sourceSizePx must be a positive number");
  }
  const required = SIZES.filter((s) => s.sizePx <= sourceSizePx);
  const excluded = SIZES.filter((s) => s.sizePx > sourceSizePx);
  const result = { required };
  if (excluded.length > 0) {
    result.warning = `Source image (${sourceSizePx}px) is too small for: ${excluded.map((s) => `${s.label} (${s.sizePx}px)`).join(", ")}.`;
  }
  return result;
}
