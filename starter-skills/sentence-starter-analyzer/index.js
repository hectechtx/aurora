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
  const starters = sentences.map((s) => {
    const m = s.match(/[a-zA-Z']+/);
    return m ? m[0].toLowerCase() : "";
  });

  const repeatedStarters = [];
  let i = 0;
  while (i < starters.length) {
    if (!starters[i]) { i++; continue; }
    let j = i + 1;
    while (j < starters.length && starters[j] === starters[i]) j++;
    if (j - i >= 2) {
      const sentenceIndexes = [];
      for (let k = i; k < j; k++) sentenceIndexes.push(k);
      repeatedStarters.push({ word: starters[i], sentenceIndexes });
    }
    i = j;
  }

  return { repeatedStarters };
}
