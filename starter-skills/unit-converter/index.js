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
  const { value, from, to } = payload?.args ?? {};
  const v = Number(value);
  const f = String(from ?? "").toLowerCase();
  const t = String(to ?? "").toLowerCase();
  if (!Number.isFinite(v) || !f || !t) {
    process.stdout.write(JSON.stringify({ error: "value, from, and to are required" }));
    return;
  }

  // Each group converts through a common base unit.
  const LENGTH_TO_M = { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 };
  const WEIGHT_TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523125 };
  const VOLUME_TO_L = { l: 1, ml: 0.001, gal: 3.785411784, qt: 0.946352946 };

  function convertViaBase(table, unitFrom, unitTo) {
    if (!(unitFrom in table) || !(unitTo in table)) return null;
    return (v * table[unitFrom]) / table[unitTo];
  }

  let result = null;
  if (f in LENGTH_TO_M && t in LENGTH_TO_M) result = convertViaBase(LENGTH_TO_M, f, t);
  else if (f in WEIGHT_TO_KG && t in WEIGHT_TO_KG) result = convertViaBase(WEIGHT_TO_KG, f, t);
  else if (f in VOLUME_TO_L && t in VOLUME_TO_L) result = convertViaBase(VOLUME_TO_L, f, t);
  else if (["c", "f", "k"].includes(f) && ["c", "f", "k"].includes(t)) {
    let celsius;
    if (f === "c") celsius = v;
    else if (f === "f") celsius = ((v - 32) * 5) / 9;
    else celsius = v - 273.15;
    if (t === "c") result = celsius;
    else if (t === "f") result = (celsius * 9) / 5 + 32;
    else result = celsius + 273.15;
  }

  if (result === null) {
    process.stdout.write(JSON.stringify({ error: `can't convert "${f}" to "${t}" — check they're the same kind of unit (length/weight/temperature/volume) and spelled right` }));
    return;
  }

  process.stdout.write(JSON.stringify({ value: v, from: f, to: t, result: Math.round(result * 1e6) / 1e6 }));
});
