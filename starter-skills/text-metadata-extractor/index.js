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
  const text = args.text;
  if (typeof text !== "string") throw new Error("text must be a string");
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const wordCount = words.length;
  const charCount = text.length;
  const lineCount = text.split("\n").length;
  const paragraphCount = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  const totalWordChars = words.reduce((sum, w) => sum + w.length, 0);
  const avgWordLength = wordCount > 0 ? Math.round((totalWordChars / wordCount) * 100) / 100 : 0;
  return { wordCount, charCount, lineCount, paragraphCount, avgWordLength };
}
