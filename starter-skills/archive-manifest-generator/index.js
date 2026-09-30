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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function run(args) {
  const files = args.files;
  if (!Array.isArray(files)) throw new Error("files must be an array");
  const today = new Date().toISOString().slice(0, 10);
  let totalBytes = 0;
  const manifest = files.map((f) => {
    if (!f || typeof f.filename !== "string" || typeof f.sizeBytes !== "number" || !isFinite(f.sizeBytes)) {
      throw new Error("each file requires a filename (string) and sizeBytes (number)");
    }
    totalBytes += f.sizeBytes;
    return {
      filename: f.filename,
      sizeBytes: f.sizeBytes,
      sizeFormatted: formatBytes(f.sizeBytes),
      dateAdded: typeof f.dateAdded === "string" && f.dateAdded.length > 0 ? f.dateAdded : today,
    };
  });
  return {
    manifest,
    totalFiles: files.length,
    totalSizeFormatted: formatBytes(totalBytes),
  };
}
