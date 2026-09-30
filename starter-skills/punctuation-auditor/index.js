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

function countOccurrences(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const totalWords = words.length || 1;

  const emDash = countOccurrences(text, /—/g);
  const exclamation = countOccurrences(text, /!/g);
  const ellipsis = countOccurrences(text, /(\.\.\.|…)/g);
  const semicolon = countOccurrences(text, /;/g);

  const counts = { emDash, exclamation, ellipsis, semicolon };
  const perThousandWords = {};
  const flags = [];
  for (const [key, count] of Object.entries(counts)) {
    const rate = (count / totalWords) * 1000;
    perThousandWords[key] = Math.round(rate * 100) / 100;
    if (rate > 5) flags.push(key);
  }

  return { counts, perThousandWords, flags };
}
