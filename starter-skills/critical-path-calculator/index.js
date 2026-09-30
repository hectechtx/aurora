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

  const byId = new Map();
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || typeof t.durationDays !== "number" || !Array.isArray(t.dependsOn)) {
      throw new Error("each task requires id (string), durationDays (number), dependsOn (string[])");
    }
    if (byId.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) throw new Error(`task ${t.id} depends on unknown task ${dep}`);
    }
  }

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map();
  const dependents = new Map();
  for (const t of tasks) {
    inDegree.set(t.id, t.dependsOn.length);
    dependents.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      dependents.get(dep).push(t.id);
    }
  }

  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of dependents.get(id)) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== tasks.length) throw new Error("circular dependency detected");

  const earliestFinish = new Map();
  const bestPredecessor = new Map();
  for (const id of order) {
    const t = byId.get(id);
    if (t.dependsOn.length === 0) {
      earliestFinish.set(id, t.durationDays);
      bestPredecessor.set(id, null);
    } else {
      let maxDep = 0;
      let maxDepId = null;
      for (const dep of t.dependsOn) {
        const ef = earliestFinish.get(dep);
        if (ef > maxDep) {
          maxDep = ef;
          maxDepId = dep;
        }
      }
      earliestFinish.set(id, t.durationDays + maxDep);
      bestPredecessor.set(id, maxDepId);
    }
  }

  let totalDurationDays = 0;
  let endId = null;
  for (const [id, ef] of earliestFinish.entries()) {
    if (ef > totalDurationDays) {
      totalDurationDays = ef;
      endId = id;
    }
  }

  const criticalPath = [];
  let cur = endId;
  while (cur !== null && cur !== undefined) {
    criticalPath.unshift(cur);
    cur = bestPredecessor.get(cur);
  }

  return { totalDurationDays, criticalPath };
}
