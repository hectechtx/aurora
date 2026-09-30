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
  "are", "from", "has", "have", "had", "not", "its", "you", "he",
  "she", "they", "we", "his", "her", "their", "them", "who", "what",
]);

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");
  const windowWords = args.windowWords != null ? Number(args.windowWords) : 30;
  if (!Number.isFinite(windowWords) || windowWords <= 0) throw new Error("windowWords must be a positive number");

  const words = text.match(/[a-zA-Z']+/g) ?? [];
  const reported = new Set();
  const repeats = [];

  for (let i = 0; i < words.length; i++) {
    const lower = words[i].toLowerCase();
    if (lower.length <= 3 || STOPWORDS.has(lower)) continue;
    for (let j = i + 1; j < words.length && j - i <= windowWords; j++) {
      const otherLower = words[j].toLowerCase();
      if (otherLower === lower) {
        const key = `${lower}:${i}:${j}`;
        if (!reported.has(key)) {
          reported.add(key);
          repeats.push({ word: lower, distanceApart: j - i, firstIndex: i });
        }
        break;
      }
    }
  }

  return { repeats, count: repeats.length };
}
