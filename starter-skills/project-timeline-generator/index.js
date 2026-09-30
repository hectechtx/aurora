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
  const { startDate, tasks } = args;
  if (!startDate) throw new Error("startDate is required");
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array");
  const parsed = new Date(startDate);
  if (isNaN(parsed.getTime())) throw new Error("startDate is not a valid date");
  let currentMs = parsed.getTime();

  const timeline = [];
  for (const task of tasks) {
    if (!task || typeof task.name !== "string" || typeof task.durationDays !== "number" || !isFinite(task.durationDays)) {
      throw new Error("each task requires a name (string) and durationDays (number)");
    }
    if (task.durationDays < 0) throw new Error("durationDays must not be negative");
    const taskStartMs = currentMs;
    const taskEndMs = currentMs + task.durationDays * MS_PER_DAY;
    timeline.push({
      name: task.name,
      startDate: toISODate(new Date(taskStartMs)),
      endDate: toISODate(new Date(taskEndMs)),
    });
    currentMs = taskEndMs;
  }

  return { timeline, projectEndDate: toISODate(new Date(currentMs)) };
}
