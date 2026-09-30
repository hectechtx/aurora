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
  const { startDate, cadenceDays, count } = args;
  if (!startDate) throw new Error("startDate is required");
  if (typeof cadenceDays !== "number" || !isFinite(cadenceDays) || cadenceDays < 0) {
    throw new Error("cadenceDays must be a non-negative number");
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  if (count > 200) throw new Error("count must not exceed 200");

  const start = new Date(startDate);
  if (isNaN(start.getTime())) throw new Error("startDate is not a valid date");

  const releaseDates = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * cadenceDays * MS_PER_DAY);
    releaseDates.push(toISODate(d));
  }

  return { releaseDates };
}
