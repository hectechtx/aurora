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

const CLICHES = [
  "at the end of the day", "think outside the box", "low-hanging fruit",
  "it is what it is", "when push comes to shove", "in this day and age",
  "needle in a haystack", "tip of the iceberg", "back to square one",
  "cut to the chase", "easier said than done", "best of both worlds",
  "time will tell", "only time will tell", "at the drop of a hat",
  "beat around the bush", "better late than never", "bite the bullet",
  "burn the midnight oil", "calm before the storm", "cutting edge",
  "dead as a doornail", "drop in the bucket", "every cloud has a silver lining",
  "food for thought", "in the nick of time", "last but not least",
  "light at the end of the tunnel", "method to the madness", "move the needle",
  "on the same page", "once in a blue moon", "par for the course",
  "piece of cake", "read between the lines", "the elephant in the room",
  "the whole nine yards", "thinking outside the box", "throw caution to the wind",
  "whole new ballgame", "win-win situation",
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(args) {
  const text = String(args.text ?? "");
  if (!text.trim()) throw new Error("text is required");

  const found = [];
  for (const phrase of CLICHES) {
    const pattern = new RegExp(escapeRegex(phrase), "gi");
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      found.push({ phrase, count: matches.length });
    }
  }

  return { found };
}
