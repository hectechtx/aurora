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

const KEYWORDS = [
  ["indemnif", "Indemnification"],
  ["liquidated damages", "Liquidated Damages"],
  ["non-compete", "Non-Compete"],
  ["noncompete", "Non-Compete"],
  ["force majeure", "Force Majeure"],
  ["arbitration", "Arbitration"],
  ["limitation of liability", "Limitation of Liability"],
  ["termination for convenience", "Termination for Convenience"],
  ["confidential", "Confidentiality"],
  ["governing law", "Governing Law"],
];

function run(args) {
  const text = args.text;
  if (typeof text !== "string") throw new Error("text must be a string");
  const lower = text.toLowerCase();
  const flagged = [];
  for (const [keyword, clauseType] of KEYWORDS) {
    let fromIndex = 0;
    let idx;
    while ((idx = lower.indexOf(keyword, fromIndex)) !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + keyword.length + 40);
      const snippet = text.slice(start, end).trim();
      flagged.push({ clauseType, snippet, index: idx });
      fromIndex = idx + keyword.length;
    }
  }
  return {
    flagged,
    disclaimer: "Keyword screening only — not legal advice. Have an attorney review the actual contract.",
  };
}
