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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function run(args) {
  const { startDate, ideas, platforms = ["Instagram", "TikTok", "X"], postsPerWeek = 3 } = args;
  if (!startDate) throw new Error("startDate is required");
  if (!Array.isArray(ideas) || ideas.length === 0) throw new Error("ideas must be a non-empty array");
  if (!Array.isArray(platforms) || platforms.length === 0) throw new Error("platforms must be a non-empty array");
  if (typeof postsPerWeek !== "number" || !isFinite(postsPerWeek) || postsPerWeek <= 0) {
    throw new Error("postsPerWeek must be a positive number");
  }

  const start = new Date(startDate);
  if (isNaN(start.getTime())) throw new Error("startDate is not a valid date");

  const intervalDays = 7 / postsPerWeek;
  const calendar = ideas.map((idea, i) => {
    if (typeof idea !== "string") throw new Error("each idea must be a string");
    const d = new Date(start.getTime() + Math.round(i * intervalDays) * MS_PER_DAY);
    const platform = platforms[i % platforms.length];
    return { date: toISODate(d), idea, platform };
  });

  return { calendar };
}
