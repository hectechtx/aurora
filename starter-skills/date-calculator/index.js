const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MS_PER_DAY = 86_400_000;

function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""))) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stdout.write(JSON.stringify({ error: "invalid stdin payload" }));
    return;
  }
  const args = payload?.args ?? {};
  const op = String(args.operation ?? "");

  if (op === "days_between") {
    const from = parseDate(args.from), to = parseDate(args.to);
    if (!from || !to) { process.stdout.write(JSON.stringify({ error: "from and to must be YYYY-MM-DD" })); return; }
    const days = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
    process.stdout.write(JSON.stringify({ days }));
    return;
  }

  if (op === "add_days") {
    const date = parseDate(args.date);
    const days = Number(args.days);
    if (!date || !Number.isFinite(days)) { process.stdout.write(JSON.stringify({ error: "date (YYYY-MM-DD) and days are required" })); return; }
    const result = new Date(date.getTime() + days * MS_PER_DAY);
    process.stdout.write(JSON.stringify({ result: result.toISOString().slice(0, 10), dayOfWeek: DAY_NAMES[result.getUTCDay()] }));
    return;
  }

  if (op === "day_of_week") {
    const date = parseDate(args.date);
    if (!date) { process.stdout.write(JSON.stringify({ error: "date must be YYYY-MM-DD" })); return; }
    process.stdout.write(JSON.stringify({ dayOfWeek: DAY_NAMES[date.getUTCDay()] }));
    return;
  }

  process.stdout.write(JSON.stringify({ error: `unknown operation "${op}"` }));
});
