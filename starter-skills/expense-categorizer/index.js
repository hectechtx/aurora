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

const RULES = [
  { keywords: ["uber", "lyft", "gas", "fuel", "flight", "airline", "hotel", "parking"], category: "Travel" },
  { keywords: ["aws", "hosting", "software", "saas", "subscription", "license"], category: "Software" },
  { keywords: ["staples", "office", "supplies", "paper", "printer"], category: "Office Supplies" },
  { keywords: ["restaurant", "coffee", "lunch", "dinner", "cafe", "catering"], category: "Meals" },
  { keywords: ["rent", "lease"], category: "Rent" },
  { keywords: ["ads", "advertising", "marketing", "promo"], category: "Marketing" },
  { keywords: ["salary", "payroll", "wage", "contractor"], category: "Payroll" }
];

function categorize(description) {
  const lower = description.toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return "Uncategorized";
}

function run(args) {
  const expenses = args.expenses;
  if (!Array.isArray(expenses) || expenses.length === 0) {
    throw new Error("expenses must be a non-empty array");
  }

  const totalsByCategory = {};
  const categorized = expenses.map((e) => {
    const description = String(e.description ?? "");
    const amount = Number(e.amount);
    if (!description || !Number.isFinite(amount)) {
      throw new Error("each expense needs a description and amount");
    }
    const category = categorize(description);
    totalsByCategory[category] = (totalsByCategory[category] ?? 0) + amount;
    return { description, amount, category };
  });

  for (const cat in totalsByCategory) {
    totalsByCategory[cat] = Math.round(totalsByCategory[cat] * 100) / 100;
  }

  return { categorized, totalsByCategory };
}
