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
  const text = String(args.text ?? "");
  const mode = args.mode;
  if (mode !== "encode" && mode !== "decode") {
    throw new Error("mode must be 'encode' or 'decode'");
  }
  const result = mode === "decode"
    ? Buffer.from(text, "base64").toString("utf8")
    : Buffer.from(text, "utf8").toString("base64");
  return { result };
}
