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

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "is",
  "it", "that", "this", "for", "with", "as", "was", "were", "be", "by",
  "are", "from", "has", "have", "had", "not", "its", "i", "you", "he",
  "she", "they", "we", "his", "her", "their",
]);

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");
  const topN = args.topN != null ? Number(args.topN) : 10;
  if (!Number.isFinite(topN) || topN <= 0) throw new Error("topN must be a positive number");

  const words = text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 0);
  const counts = new Map();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const topWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));

  return { topWords, totalWords: words.length, uniqueWords: counts.size };
}
