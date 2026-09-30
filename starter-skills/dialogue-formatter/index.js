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
  const lines = String(args.lines ?? "");
  if (!lines.trim()) throw new Error("lines is required");
  const formatted = lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.+?):\s*(.+)$/);
      if (!match) return null;
      const [, name, text] = match;
      return `"${text.trim()}," said ${name.trim()}.`;
    })
    .filter((line) => line !== null)
    .join("\n\n");
  return { formatted };
}
