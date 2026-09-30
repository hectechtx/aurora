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
  const options = args.options;
  const criteria = args.criteria;
  const scores = args.scores;

  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("options must be a non-empty array");
  }
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error("criteria must be a non-empty array");
  }
  if (!Array.isArray(scores) || scores.length !== options.length) {
    throw new Error("scores must have one row per option");
  }
  for (const row of scores) {
    if (!Array.isArray(row) || row.length !== criteria.length) {
      throw new Error("each scores row must have one value per criterion");
    }
  }

  const totalWeight = criteria.reduce((sum, c) => sum + Number(c.weight), 0);
  if (totalWeight === 0) {
    throw new Error("sum of criteria weights must not be zero");
  }

  const ranked = options.map((option, i) => {
    const weightedScore = scores[i].reduce((sum, s, j) => sum + Number(s) * Number(criteria[j].weight), 0) / totalWeight;
    return { option, weightedScore };
  });

  ranked.sort((a, b) => b.weightedScore - a.weightedScore);

  return { ranked };
}
