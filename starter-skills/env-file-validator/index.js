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
  const content = String(args.content ?? "");
  const lines = content.split("\n");
  const errors = [];
  const seen = new Map();
  const duplicateKeys = [];

  lines.forEach((rawLine, idx) => {
    const lineNumber = idx + 1;
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) return;

    if (!/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(line)) {
      errors.push({ line: lineNumber, issue: "invalid syntax" });
      return;
    }

    const eqIdx = line.indexOf("=");
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);

    if (seen.has(key)) {
      errors.push({ line: lineNumber, issue: `duplicate key: ${key}` });
      if (!duplicateKeys.includes(key)) duplicateKeys.push(key);
    } else {
      seen.set(key, lineNumber);
    }

    if (value.trim().length === 0) {
      errors.push({ line: lineNumber, issue: "empty value" });
    }
  });

  return { valid: errors.length === 0, errors, duplicateKeys };
}
