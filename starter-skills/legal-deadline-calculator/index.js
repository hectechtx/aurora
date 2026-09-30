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
  const { triggerDate, days } = args;
  const dayType = args.dayType || "calendar";
  if (!["calendar", "business"].includes(dayType)) {
    throw new Error("dayType must be calendar or business");
  }
  const d = new Date(triggerDate);
  if (typeof triggerDate !== "string" || isNaN(d.getTime())) {
    throw new Error("triggerDate is not a valid date");
  }
  if (typeof days !== "number" || !isFinite(days) || days < 0) {
    throw new Error("days must be a non-negative number");
  }

  const deadline = new Date(d.getTime());
  if (dayType === "calendar") {
    deadline.setDate(deadline.getDate() + days);
  } else {
    let counted = 0;
    while (counted < days) {
      deadline.setDate(deadline.getDate() + 1);
      const dow = deadline.getDay();
      if (dow !== 0 && dow !== 6) counted++;
    }
  }

  return {
    triggerDate,
    days,
    dayType,
    deadline: deadline.toISOString().slice(0, 10),
    disclaimer: "Scheduling aid only — confirm applicable deadline rules with counsel. Not legal advice.",
  };
}
