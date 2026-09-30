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
  return text.match(/[a-zA-Z0-9']+/g) ?? [];
}

function toMultiset(words) {
  const map = new Map();
  for (const w of words) {
    const lower = w.toLowerCase();
    map.set(lower, (map.get(lower) ?? 0) + 1);
  }
  return map;
}

function run(args) {
  const before = String(args.before ?? "");
  const after = String(args.after ?? "");
  if (!before && !after) throw new Error("before and after are required");

  const beforeWords = tokenize(before);
  const afterWords = tokenize(after);
  const beforeMap = toMultiset(beforeWords);
  const afterMap = toMultiset(afterWords);

  const wordsAdded = [];
  for (const [word, count] of afterMap.entries()) {
    const beforeCount = beforeMap.get(word) ?? 0;
    if (count > beforeCount) wordsAdded.push({ word, count: count - beforeCount });
  }

  const wordsRemoved = [];
  for (const [word, count] of beforeMap.entries()) {
    const afterCount = afterMap.get(word) ?? 0;
    if (count > afterCount) wordsRemoved.push({ word, count: count - afterCount });
  }

  return {
    wordsAdded,
    wordsRemoved,
    wordCountBefore: beforeWords.length,
    wordCountAfter: afterWords.length,
    wordCountDelta: afterWords.length - beforeWords.length,
  };
}
