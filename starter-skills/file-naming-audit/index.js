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
  const filenames = args.filenames;
  if (!Array.isArray(filenames)) throw new Error("filenames must be an array of strings");
  const patternSrc = typeof args.pattern === "string" && args.pattern.length > 0
    ? args.pattern
    : "^[a-z0-9]+(-[a-z0-9]+)*\\.[a-z0-9]+$";
  let re;
  try {
    re = new RegExp(patternSrc);
  } catch (err) {
    throw new Error("pattern is not a valid regular expression: " + err.message);
  }
  const violations = filenames.filter((f) => !re.test(String(f)));
  return {
    violations,
    compliantCount: filenames.length - violations.length,
    total: filenames.length,
  };
}
