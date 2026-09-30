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
  const text = args.text;
  if (typeof text !== "string") throw new Error("text must be a string");
  const terms = new Set();
  const straightRe = /"([A-Z][a-zA-Z\s]*)"/g;
  const curlyRe = /“([A-Z][a-zA-Z\s]*)”/g;
  let m;
  while ((m = straightRe.exec(text)) !== null) {
    const term = m[1].trim();
    if (term.length > 0) terms.add(term);
  }
  while ((m = curlyRe.exec(text)) !== null) {
    const term = m[1].trim();
    if (term.length > 0) terms.add(term);
  }
  const definedTerms = [...terms].sort((a, b) => a.localeCompare(b));
  return {
    definedTerms,
    disclaimer: "Pattern-based extraction only — manually verify the definitions list is complete. Not legal advice.",
  };
}
