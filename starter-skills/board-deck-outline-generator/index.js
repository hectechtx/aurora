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

const SECTIONS = [
  { section: "Executive Summary", talkingPoints: ["Key wins this period", "Headline metric", "Top priority for next period"] },
  { section: "Financial Performance", talkingPoints: ["Revenue vs plan", "Burn rate and runway", "Notable variances"] },
  { section: "KPIs & Metrics", talkingPoints: ["Core metric trends", "Cohort/retention if relevant"] },
  { section: "Product/Operations Update", talkingPoints: ["Shipped this period", "Roadmap for next period"] },
  { section: "Risks & Challenges", talkingPoints: ["Top 3 risks", "Mitigation plans"] },
  { section: "Strategic Initiatives", talkingPoints: ["Progress on key bets"] },
  { section: "Ask / Discussion Items", talkingPoints: ["What you need from the board"] }
];

function run(args) {
  const companyName = String(args.companyName ?? "").trim();
  if (!companyName) {
    throw new Error("companyName is required");
  }
  const quarter = args.quarter ? String(args.quarter).trim() : "";
  const title = quarter ? `${companyName} Board Meeting — ${quarter}` : `${companyName} Board Meeting`;
  return { title, outline: SECTIONS.map((s) => ({ section: s.section, talkingPoints: [...s.talkingPoints] })) };
}
