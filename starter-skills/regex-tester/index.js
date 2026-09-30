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
  const pattern = args.pattern;
  const flags = args.flags ?? "g";
  const text = String(args.text ?? "");
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("pattern is required");
  }
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`invalid regular expression: ${err.message}`);
  }
  const matches = [];
  if (flags.includes("g")) {
    for (const m of text.matchAll(regex)) {
      matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
    }
  } else {
    const m = regex.exec(text);
    if (m) {
      matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
    }
  }
  return { matches, count: matches.length };
}
