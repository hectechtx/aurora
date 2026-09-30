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
  const before = String(args.before ?? "");
  const after = String(args.after ?? "");
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > 3000 || b.length > 3000) {
    throw new Error("input exceeds 3000 lines");
  }

  const n = a.length;
  const m = b.length;
  // LCS DP table
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      linesRemoved++;
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      linesAdded++;
      j++;
    }
  }
  while (i < n) {
    lines.push(`- ${a[i]}`);
    linesRemoved++;
    i++;
  }
  while (j < m) {
    lines.push(`+ ${b[j]}`);
    linesAdded++;
    j++;
  }

  return { diff: lines.join("\n"), linesAdded, linesRemoved };
}
