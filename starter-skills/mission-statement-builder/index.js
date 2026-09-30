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

function clean(s) {
  return String(s ?? "").trim().replace(/\.+$/, "");
}

function run(args) {
  const purpose = clean(args.purpose);
  const audience = clean(args.audience);
  const value = clean(args.value);
  if (!purpose || !audience || !value) {
    throw new Error("purpose, audience, and value are all required");
  }
  const missionStatement = `We exist to ${purpose} for ${audience} by ${value}.`;
  return { missionStatement };
}
