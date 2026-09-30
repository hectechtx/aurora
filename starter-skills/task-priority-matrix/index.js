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
  const { tasks } = args;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks must be a non-empty array");

  const quadrants = { doFirst: [], schedule: [], delegate: [], eliminate: [] };
  for (const t of tasks) {
    if (!t || typeof t.name !== "string" || typeof t.urgent !== "boolean" || typeof t.important !== "boolean") {
      throw new Error("each task requires name (string), urgent (boolean), important (boolean)");
    }
    if (t.urgent && t.important) quadrants.doFirst.push(t.name);
    else if (t.important && !t.urgent) quadrants.schedule.push(t.name);
    else if (t.urgent && !t.important) quadrants.delegate.push(t.name);
    else quadrants.eliminate.push(t.name);
  }

  return { quadrants };
}
