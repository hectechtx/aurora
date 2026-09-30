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
  const beats = Array.isArray(args.beats) ? args.beats.map((b) => String(b)) : null;
  if (!beats || beats.length === 0) throw new Error("beats must be a non-empty array of strings");
  const title = args.title != null && String(args.title).trim() ? String(args.title) : "Untitled";

  const n = beats.length;
  const chunkSize = Math.ceil(n / 3);
  const act1 = beats.slice(0, chunkSize);
  const act2 = beats.slice(chunkSize, chunkSize * 2);
  const act3 = beats.slice(chunkSize * 2);

  return {
    title,
    acts: [
      { name: "Act 1: Setup", beats: act1 },
      { name: "Act 2: Confrontation", beats: act2 },
      { name: "Act 3: Resolution", beats: act3 },
    ],
  };
}
