// CSV Analyzer skill — parses CSV/TSV text and summarizes each column. Pure
// Node, no dependencies. Includes a small RFC-4180-ish parser that handles
// quoted fields, escaped quotes, and newlines inside quotes.

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return process.stdout.write(JSON.stringify({ error: "invalid stdin payload" })); }
  try {
    process.stdout.write(JSON.stringify(run(payload?.args ?? {})));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }));
  }
});

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (c === "\r") {
      // handled by the \n branch; skip
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

function summarizeColumn(name, values) {
  const nonEmpty = values.filter((v) => v !== "" && v != null);
  const nums = nonEmpty.map((v) => Number(String(v).replace(/[$,%\s]/g, ""))).filter((n) => Number.isFinite(n));
  const isNumeric = nonEmpty.length > 0 && nums.length >= nonEmpty.length * 0.8;
  const base = { column: name, filled: nonEmpty.length, empty: values.length - nonEmpty.length };
  if (isNumeric) {
    const sum = nums.reduce((a, b) => a + b, 0);
    return { ...base, type: "numeric", min: Math.min(...nums), max: Math.max(...nums), mean: +(sum / nums.length).toFixed(4), sum: +sum.toFixed(4) };
  }
  const counts = new Map();
  for (const v of nonEmpty) counts.set(v, (counts.get(v) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: String(value).slice(0, 80), count }));
  return { ...base, type: "text", distinct: counts.size, topValues: top };
}

function run(args) {
  const csv = String(args.csv ?? "");
  if (!csv.trim()) throw new Error("csv text is required");
  let delimiter = args.delimiter ? String(args.delimiter) : ",";
  if (delimiter === "\\t") delimiter = "\t";

  const rows = parseCsv(csv, delimiter);
  if (rows.length < 2) throw new Error("need a header row plus at least one data row");
  const header = rows[0].map((h, i) => h.trim() || `col${i + 1}`);
  const dataRows = rows.slice(1);

  const columns = header.map((name, ci) => summarizeColumn(name, dataRows.map((r) => (r[ci] ?? "").trim())));
  return { rowCount: dataRows.length, columnCount: header.length, columns: header, analysis: columns };
}
