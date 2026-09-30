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

const MAJOR_KEYWORDS = [
  "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "GROUP BY", "ORDER BY",
  "SELECT", "FROM", "WHERE", "JOIN", "HAVING", "LIMIT"
];

// Single alternation regex so multi-word keywords (e.g. "LEFT JOIN") are matched
// as one token instead of being re-split by a later standalone "JOIN" pass.
const KEYWORD_RE = new RegExp(
  `\\s*\\b(${MAJOR_KEYWORDS.map((kw) => kw.replace(" ", "\\s+")).join("|")})\\b\\s*`,
  "gi"
);

function run(args) {
  const sql = String(args.sql ?? "");
  if (!sql.trim()) {
    throw new Error("sql is required");
  }

  let formatted = sql.replace(/\s+/g, " ").trim();

  // Uppercase and place major keywords on new lines
  formatted = formatted.replace(KEYWORD_RE, (m, kw) => `\n${kw.toUpperCase().replace(/\s+/g, " ")}\n  `);

  // AND / OR on their own indented line
  formatted = formatted.replace(/\s+\b(AND|OR)\b\s+/gi, (m, p1) => `\n    ${p1.toUpperCase()} `);

  // Clean up: collapse multiple blank lines, trim trailing spaces per line
  const lines = formatted
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .filter((l) => l.trim().length > 0 || l.length === 0);

  formatted = lines.join("\n").trim();

  return { formatted };
}
