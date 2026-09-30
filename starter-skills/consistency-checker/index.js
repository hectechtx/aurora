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

const VARIANT_PAIRS = [
  ["color", "colour"], ["organize", "organise"], ["email", "e-mail"],
  ["website", "web site"], ["gray", "grey"], ["favorite", "favourite"],
  ["center", "centre"], ["realize", "realise"], ["traveling", "travelling"],
  ["analyze", "analyse"], ["license", "licence"], ["behavior", "behaviour"],
  ["labor", "labour"], ["defense", "defence"], ["dialog", "dialogue"],
  ["catalog", "catalogue"], ["program", "programme"], ["theater", "theatre"],
  ["fulfill", "fulfil"], ["skillful", "skilful"],
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countWholeWord(text, phrase) {
  const pattern = new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi");
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");

  const inconsistencies = [];
  for (const [v1, v2] of VARIANT_PAIRS) {
    const count1 = countWholeWord(text, v1);
    const count2 = countWholeWord(text, v2);
    if (count1 > 0 && count2 > 0) {
      inconsistencies.push({ variant1: v1, count1, variant2: v2, count2 });
    }
  }

  return { inconsistencies };
}
