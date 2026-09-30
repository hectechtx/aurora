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

function shapeForLetter(ch) {
  const c = ch.toLowerCase();
  if ("aei".includes(c)) return "wide";
  if ("ou".includes(c)) return "round";
  if ("mbp".includes(c)) return "closed";
  if ("fv".includes(c)) return "teeth";
  if (/[a-z]/.test(c)) return "neutral";
  return null;
}

function run(args) {
  const text = args.text;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("text must be a non-empty string");
  }
  const wordTokens = text.trim().split(/\s+/);
  const words = wordTokens.map((word) => {
    const letters = word.replace(/[^a-zA-Z]/g, "");
    const rawVisemes = [];
    for (const ch of letters) {
      const shape = shapeForLetter(ch);
      if (shape) rawVisemes.push(shape);
    }
    const visemes = [];
    for (const shape of rawVisemes) {
      if (visemes[visemes.length - 1] !== shape) visemes.push(shape);
    }
    return { word, visemes };
  });
  return { words, disclaimer: "Approximate — not phonetically precise. Use as a rough reference only." };
}
