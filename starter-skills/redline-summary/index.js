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

function tokenize(text) {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function countMap(words) {
  const map = new Map();
  for (const w of words) map.set(w, (map.get(w) || 0) + 1);
  return map;
}

function run(args) {
  const { originalText, revisedText } = args;
  if (typeof originalText !== "string" || typeof revisedText !== "string") {
    throw new Error("originalText and revisedText must be strings");
  }
  const originalWords = tokenize(originalText);
  const revisedWords = tokenize(revisedText);
  const originalCounts = countMap(originalWords);
  const revisedCounts = countMap(revisedWords);

  const wordsAdded = [];
  for (const [word, count] of revisedCounts.entries()) {
    const origCount = originalCounts.get(word) || 0;
    if (count > origCount) wordsAdded.push({ word, count: count - origCount });
  }

  const wordsRemoved = [];
  for (const [word, count] of originalCounts.entries()) {
    const revCount = revisedCounts.get(word) || 0;
    if (count > revCount) wordsRemoved.push({ word, count: count - revCount });
  }

  return {
    wordsAdded,
    wordsRemoved,
    wordCountChange: revisedWords.length - originalWords.length,
    disclaimer: "Word-level text comparison only — always review the actual redline for legal significance. Not legal advice.",
  };
}
