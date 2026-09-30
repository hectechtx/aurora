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

const PREFIXES = ["Nova", "Prime", "Peak", "Bright", "Swift", "True", "Bold", "Clear", "Next", "Rise"];
const SUFFIXES = ["Labs", "Co", "Hub", "Works", "Studio", "Group", "Collective", "Partners", "Ventures", "House"];

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function run(args) {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) throw new Error("keyword is required");
  const count = args.count != null ? Number(args.count) : 15;
  if (!Number.isFinite(count) || count <= 0) throw new Error("count must be a positive number");

  const cap = capitalize(keyword);
  const candidates = [];

  for (const suffix of SUFFIXES) {
    candidates.push(`${cap}${suffix}`);
  }
  for (const prefix of PREFIXES) {
    candidates.push(`${prefix}${cap}`);
  }
  for (const suffix of SUFFIXES) {
    candidates.push(`${cap} ${suffix}`);
  }

  const seen = new Set();
  const names = [];
  for (const c of candidates) {
    const key = c.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      names.push(c);
    }
    if (names.length >= count) break;
  }

  return { names };
}
