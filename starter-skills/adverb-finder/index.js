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

const EXCLUDE = new Set([
  "family", "only", "early", "supply", "reply", "apply", "rally", "ally",
  "ugly", "silly", "holy", "july", "imply", "comply", "multiply", "rely",
]);

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");
  const matches = text.match(/\b\w+ly\b/gi) ?? [];
  const counts = new Map();
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (EXCLUDE.has(lower)) continue;
    counts.set(lower, (counts.get(lower) ?? 0) + 1);
  }
  const adverbs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count }));
  const total = adverbs.reduce((sum, a) => sum + a.count, 0);
  return { adverbs, total };
}
