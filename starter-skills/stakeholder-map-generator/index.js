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
  const stakeholders = args.stakeholders;
  if (!Array.isArray(stakeholders) || stakeholders.length === 0) {
    throw new Error("stakeholders must be a non-empty array");
  }

  const quadrants = {
    "Manage Closely": [],
    "Keep Satisfied": [],
    "Keep Informed": [],
    "Monitor": []
  };

  for (const s of stakeholders) {
    const name = String(s.name ?? "");
    const power = Number(s.power);
    const interest = Number(s.interest);
    if (!name || !Number.isFinite(power) || !Number.isFinite(interest)) {
      throw new Error("each stakeholder needs a name, power, and interest");
    }
    let quadrant;
    if (power >= 5 && interest >= 5) quadrant = "Manage Closely";
    else if (power >= 5 && interest < 5) quadrant = "Keep Satisfied";
    else if (power < 5 && interest >= 5) quadrant = "Keep Informed";
    else quadrant = "Monitor";
    quadrants[quadrant].push(name);
  }

  return { quadrants };
}
