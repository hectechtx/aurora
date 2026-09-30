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
  const { startDate, frequency, count = 10 } = args;
  if (!startDate) throw new Error("startDate is required");
  if (!["daily", "weekly", "monthly"].includes(frequency)) {
    throw new Error("frequency must be daily, weekly, or monthly");
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }
  if (count > 100) throw new Error("count must not exceed 100");

  const start = new Date(startDate);
  if (isNaN(start.getTime())) throw new Error("startDate is not a valid date");

  const dates = [];
  let current = new Date(start.getTime());
  for (let i = 0; i < count; i++) {
    dates.push(toISODate(current));
    if (frequency === "daily") {
      current = new Date(current.getTime() + MS_PER_DAY);
    } else if (frequency === "weekly") {
      current = new Date(current.getTime() + 7 * MS_PER_DAY);
    } else {
      current = new Date(current.getTime());
      current.setUTCMonth(current.getUTCMonth() + 1);
    }
  }

  return { dates };
}
