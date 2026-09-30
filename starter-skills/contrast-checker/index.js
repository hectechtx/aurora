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

  function parseHex(hex) {
    const m = String(hex ?? "").trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  }

  function relativeLuminance([r, g, b]) {
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const [rl, gl, bl] = [r, g, b].map(lin);
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
  }

  const fg = parseHex(args.foreground);
  const bg = parseHex(args.background);
  if (!fg || !bg) {
    process.stdout.write(JSON.stringify({ error: "foreground and background must be 6-digit hex colors" }));
    return;
  }

  const l1 = relativeLuminance(fg), l2 = relativeLuminance(bg);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  process.stdout.write(JSON.stringify({
    ratio: Math.round(ratio * 100) / 100,
    passesAA: ratio >= 4.5,
    passesAALarge: ratio >= 3,
    passesAAA: ratio >= 7,
  }));
});
