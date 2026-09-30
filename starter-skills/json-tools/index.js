const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stdout.write(JSON.stringify({ error: "invalid stdin payload" }));
    return;
  }
  const { tool, args } = payload;

  if (tool === "format_json") {
    try {
      const parsed = JSON.parse(String(args?.json ?? ""));
      const mode = args?.mode === "minify" ? "minify" : "pretty";
      const output = mode === "minify" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
      process.stdout.write(JSON.stringify({ formatted: output }));
    } catch (err) {
      process.stdout.write(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
    }
    return;
  }

  if (tool === "json_to_csv") {
    let rows;
    try {
      rows = JSON.parse(String(args?.json ?? ""));
    } catch (err) {
      process.stdout.write(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
      return;
    }
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") {
      process.stdout.write(JSON.stringify({ error: "json must be a non-empty array of flat objects" }));
      return;
    }
    const columns = Array.from(rows.reduce((set, r) => { Object.keys(r).forEach((k) => set.add(k)); return set; }, new Set()));
    const escape = (v) => {
      const s = v === undefined || v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map(escape).join(",")];
    for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(","));
    process.stdout.write(JSON.stringify({ csv: lines.join("\n") }));
    return;
  }

  process.stdout.write(JSON.stringify({ error: `unknown tool "${tool}"` }));
});
