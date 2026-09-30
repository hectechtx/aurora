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

function clamp255(n) {
  return Math.max(0, Math.min(255, n));
}

function parseHexColor(str) {
  const m = String(str ?? "").trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function parseRgbColor(str) {
  const m = String(str ?? "").trim().match(/^rgba?\(?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)?$/i);
  if (!m) return null;
  return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]) };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = s / 100;
  l = l / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: clamp255(Math.round((r + m) * 255)),
    g: clamp255(Math.round((g + m) * 255)),
    b: clamp255(Math.round((b + m) * 255)),
  };
}

function parseHslColor(str) {
  const m = String(str ?? "").trim().match(/^hsla?\(?\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)?$/i);
  if (!m) return null;
  return hslToRgb(+m[1], +m[2], +m[3]);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0; s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function rgbToCmyk(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - r - k) / (1 - k);
  const m = (1 - g - k) / (1 - k);
  const y = (1 - b - k) / (1 - k);
  return { c: Math.round(c * 100), m: Math.round(m * 100), y: Math.round(y * 100), k: Math.round(k * 100) };
}

function toHexStr(r, g, b) {
  const c = (n) => clamp255(Math.round(n)).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function run(args) {
  const { color, from, to } = args;
  if (typeof color !== "string" || !color.trim()) throw new Error("color must be a non-empty string");

  let rgb;
  if (from === "hex") rgb = parseHexColor(color);
  else if (from === "rgb") rgb = parseRgbColor(color);
  else if (from === "hsl") rgb = parseHslColor(color);
  else throw new Error("from must be hex, rgb, or hsl");

  if (!rgb) throw new Error(`could not parse "${color}" as ${from}`);

  let result;
  if (to === "hex") {
    result = toHexStr(rgb.r, rgb.g, rgb.b);
  } else if (to === "rgb") {
    result = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  } else if (to === "hsl") {
    const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
    result = `hsl(${h}, ${s}%, ${l}%)`;
  } else if (to === "cmyk") {
    const { c, m, y, k } = rgbToCmyk(rgb.r, rgb.g, rgb.b);
    result = `cmyk(${c}%, ${m}%, ${y}%, ${k}%)`;
  } else {
    throw new Error("to must be hex, rgb, hsl, or cmyk");
  }

  return { result };
}
