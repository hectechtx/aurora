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

const DEFAULT_CATEGORIES = {
  venue: 40,
  catering: 25,
  entertainment: 10,
  marketing: 10,
  staff: 10,
  misc: 5,
};

function run(args) {
  const { totalBudget, categories } = args;
  if (typeof totalBudget !== "number" || !isFinite(totalBudget) || totalBudget < 0) {
    throw new Error("totalBudget must be a non-negative number");
  }
  const cats = categories && typeof categories === "object" ? categories : DEFAULT_CATEGORIES;

  const allocations = [];
  for (const [category, percent] of Object.entries(cats)) {
    if (typeof percent !== "number" || !isFinite(percent)) {
      throw new Error(`percent for category "${category}" must be a number`);
    }
    if (percent < 0) throw new Error(`percent for category "${category}" must not be negative`);
    allocations.push({ category, percent, amount: totalBudget * (percent / 100) });
  }

  return { allocations };
}
