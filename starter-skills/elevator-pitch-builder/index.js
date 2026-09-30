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
  const product = String(args.product ?? "").trim();
  const problem = String(args.problem ?? "").trim();
  const targetMarket = String(args.targetMarket ?? "").trim();
  const solution = String(args.solution ?? "").trim();
  const differentiator = String(args.differentiator ?? "").trim();
  const ask = args.ask != null ? String(args.ask).trim() : "";

  if (!product || !problem || !targetMarket || !solution || !differentiator) {
    throw new Error("product, problem, targetMarket, solution, and differentiator are all required");
  }

  let pitch = `For ${targetMarket} who struggle with ${problem}, ${product} is a solution that ${solution}. Unlike alternatives, ${differentiator}.`;
  if (ask) {
    pitch += ` ${ask}`;
  }

  return { pitch };
}
