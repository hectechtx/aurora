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

function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

function run(args) {
  const { width, height, ratioWidth, ratioHeight } = args;
  if (typeof ratioWidth !== "number" || typeof ratioHeight !== "number" || ratioWidth <= 0 || ratioHeight <= 0) {
    throw new Error("ratioWidth and ratioHeight must be positive numbers");
  }
  let outWidth, outHeight;
  if (typeof width === "number") {
    if (width <= 0) throw new Error("width must be a positive number");
    outWidth = width;
    outHeight = Math.round((width * ratioHeight) / ratioWidth);
  } else if (typeof height === "number") {
    if (height <= 0) throw new Error("height must be a positive number");
    outHeight = height;
    outWidth = Math.round((height * ratioWidth) / ratioHeight);
  } else {
    throw new Error("provide width or height");
  }
  const divisor = gcd(ratioWidth, ratioHeight);
  const simplifiedRatio = `${Math.round(ratioWidth) / divisor}:${Math.round(ratioHeight) / divisor}`;
  return { width: outWidth, height: outHeight, simplifiedRatio };
}
