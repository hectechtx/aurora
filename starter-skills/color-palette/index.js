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
  const hex = String(args.hex ?? "").trim();
  const scheme = String(args.scheme ?? "");
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) {
    process.stdout.write(JSON.stringify({ error: "hex must be a 6-digit hex color like #3366cc" }));
    return;
  }

  function hexToHsl(h) {
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let hue = 0, sat = 0;
    const light = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      sat = d / (1 - Math.abs(2 * light - 1));
      switch (max) {
        case r: hue = ((g - b) / d) % 6; break;
        case g: hue = (b - r) / d + 2; break;
        default: hue = (r - g) / d + 4;
      }
      hue *= 60;
      if (hue < 0) hue += 360;
    }
    return { h: hue, s: sat * 100, l: light * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const mm = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const toHex = (v) => Math.round((v + mm) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  const { h, s, l } = hexToHsl(m[1]);
  let colors;
  if (scheme === "complementary") colors = [hslToHex(h, s, l), hslToHex(h + 180, s, l)];
  else if (scheme === "analogous") colors = [hslToHex(h - 30, s, l), hslToHex(h, s, l), hslToHex(h + 30, s, l)];
  else if (scheme === "triadic") colors = [hslToHex(h, s, l), hslToHex(h + 120, s, l), hslToHex(h + 240, s, l)];
  else if (scheme === "monochromatic") colors = [20, 35, 50, 65, 80].map((lightness) => hslToHex(h, s, lightness));
  else {
    process.stdout.write(JSON.stringify({ error: `unknown scheme "${scheme}" — use complementary, analogous, triadic, or monochromatic` }));
    return;
  }

  process.stdout.write(JSON.stringify({ base: `#${m[1].toLowerCase()}`, scheme, colors }));
});
