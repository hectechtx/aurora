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

function sortKey(author) {
  const s = String(author);
  if (s.includes(",")) return s.split(",")[0].trim().toLowerCase();
  const parts = s.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}

function run(args) {
  const sources = args.sources;
  if (!Array.isArray(sources)) throw new Error("sources must be an array");
  for (const s of sources) {
    if (!s || typeof s.author !== "string" || typeof s.title !== "string" || typeof s.year !== "number") {
      throw new Error("each source requires author (string), title (string), and year (number)");
    }
  }
  const sorted = [...sources].sort((a, b) => sortKey(a.author).localeCompare(sortKey(b.author)));
  const index = sorted.map((s, i) => ({
    number: i + 1,
    formatted: `${s.author} (${s.year}). ${s.title}.`,
  }));
  return { index };
}
