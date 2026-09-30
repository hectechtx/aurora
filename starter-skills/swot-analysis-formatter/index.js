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

function toList(arr) {
  return Array.isArray(arr) ? arr.map((s) => String(s)) : [];
}

function bulletBlock(heading, items) {
  const lines = items.length > 0
    ? items.map((i) => `- ${i}`).join("\n")
    : "- (none)";
  return `### ${heading}\n${lines}`;
}

function run(args) {
  const strengths = toList(args.strengths);
  const weaknesses = toList(args.weaknesses);
  const opportunities = toList(args.opportunities);
  const threats = toList(args.threats);

  if (
    strengths.length === 0 &&
    weaknesses.length === 0 &&
    opportunities.length === 0 &&
    threats.length === 0
  ) {
    throw new Error("at least one of strengths, weaknesses, opportunities, or threats must be non-empty");
  }

  const formatted = [
    "## SWOT Analysis",
    "",
    bulletBlock("Strengths", strengths),
    "",
    bulletBlock("Weaknesses", weaknesses),
    "",
    bulletBlock("Opportunities", opportunities),
    "",
    bulletBlock("Threats", threats),
  ].join("\n");

  return {
    formatted,
    counts: {
      strengths: strengths.length,
      weaknesses: weaknesses.length,
      opportunities: opportunities.length,
      threats: threats.length,
    },
  };
}
