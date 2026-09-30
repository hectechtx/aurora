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

const CHECKLIST = [
  { item: "confidentiality", keywords: ["confidential", "proprietary"] },
  { item: "term", keywords: ["term of this agreement", "shall remain in effect", "expir"] },
  { item: "exceptions", keywords: ["does not include", "exclu", "already known", "publicly available"] },
  { item: "remedies", keywords: ["injunctive relief", "irreparable harm", "remedies"] },
  { item: "governingLaw", keywords: ["governing law", "jurisdiction", "venue"] },
];

function run(args) {
  const text = args.text;
  if (typeof text !== "string") throw new Error("text must be a string");
  const lower = text.toLowerCase();
  const checklist = CHECKLIST.map(({ item, keywords }) => ({
    item,
    present: keywords.some((k) => lower.includes(k)),
  }));
  const missingCount = checklist.filter((c) => !c.present).length;
  return {
    checklist,
    missingCount,
    disclaimer: "Keyword screening only — a missing keyword doesn't necessarily mean the concept is absent, and presence doesn't guarantee adequate legal protection. Not legal advice.",
  };
}
