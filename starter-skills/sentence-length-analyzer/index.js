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
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (sentences.length === 0) throw new Error("no sentences found in text");
  const wordCounts = sentences.map((s) => s.split(/\s+/).filter((w) => w.length > 0).length);
  const sentenceCount = wordCounts.length;
  const sum = wordCounts.reduce((a, b) => a + b, 0);
  const avgWords = sum / sentenceCount;
  const minWords = Math.min(...wordCounts);
  const maxWords = Math.max(...wordCounts);
  const variance = wordCounts.reduce((acc, c) => acc + (c - avgWords) ** 2, 0) / sentenceCount;
  const varietyScore = Math.sqrt(variance);
  return {
    sentenceCount,
    avgWords: Math.round(avgWords * 100) / 100,
    minWords,
    maxWords,
    varietyScore: Math.round(varietyScore * 100) / 100,
  };
}
