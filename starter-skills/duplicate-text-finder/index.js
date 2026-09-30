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
  const entries = args.entries;
  if (!Array.isArray(entries)) throw new Error("entries must be an array of strings");
  const map = new Map();
  for (const e of entries) {
    const s = String(e);
    const normalized = s.toLowerCase().trim().replace(/\s+/g, " ");
    if (!map.has(normalized)) map.set(normalized, []);
    map.get(normalized).push(s);
  }
  const duplicateGroups = [];
  for (const [normalized, originals] of map.entries()) {
    if (originals.length > 1) duplicateGroups.push({ normalized, originals });
  }
  return { duplicateGroups };
}
