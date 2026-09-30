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
  if (!text.trim()) throw new Error("text is required");
  const wpm = args.wpm != null ? Number(args.wpm) : 200;
  if (!Number.isFinite(wpm) || wpm <= 0) throw new Error("wpm must be a positive number");

  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const minutesFloat = words / wpm;
  const totalSeconds = Math.round(minutesFloat * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const formatted = `${m}m ${s}s`;

  return {
    words,
    wpm,
    minutes: Math.round(minutesFloat * 10) / 10,
    formatted,
  };
}
