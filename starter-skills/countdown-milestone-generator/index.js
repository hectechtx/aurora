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

// Truncate to a UTC-midnight timestamp representing the calendar date,
// independent of the host machine's local timezone.
function utcMidnight(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function run(args) {
  const { deadline, milestoneCount = 4 } = args;
  if (!deadline) throw new Error("deadline is required");
  if (typeof milestoneCount !== "number" || !Number.isInteger(milestoneCount) || milestoneCount < 1) {
    throw new Error("milestoneCount must be a positive integer");
  }

  const deadlineDate = new Date(deadline);
  if (isNaN(deadlineDate.getTime())) throw new Error("deadline is not a valid date");

  const todayMs = utcMidnight(new Date());
  const deadlineMs = utcMidnight(deadlineDate);
  const totalDays = Math.round((deadlineMs - todayMs) / MS_PER_DAY);

  if (totalDays < 0) throw new Error("deadline is in the past");

  const milestones = [];
  for (let i = 1; i <= milestoneCount; i++) {
    const offsetDays = Math.round((totalDays * i) / milestoneCount);
    const ms = deadlineMs - (totalDays - offsetDays) * MS_PER_DAY;
    milestones.push({ label: `Milestone ${i}`, date: toISODate(new Date(ms)) });
  }
  // Ensure the last milestone is exactly the deadline
  milestones[milestones.length - 1].date = toISODate(new Date(deadlineMs));

  return { milestones, deadline: toISODate(new Date(deadlineMs)) };
}
