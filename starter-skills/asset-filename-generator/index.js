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

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function run(args) {
  const { project, assetType, extension } = args;
  const version = args.version ?? "v1";
  const date = args.date ?? todayIso();
  if (typeof project !== "string" || !project.trim()) throw new Error("project is required");
  if (typeof assetType !== "string" || !assetType.trim()) throw new Error("assetType is required");
  if (typeof extension !== "string" || !extension.trim()) throw new Error("extension is required");
  if (typeof version !== "string" || !version.trim()) throw new Error("version must be a non-empty string");
  if (typeof date !== "string" || !date.trim()) throw new Error("date must be a non-empty string");

  const projectSlug = slugify(project);
  const typeSlug = slugify(assetType);
  if (!projectSlug) throw new Error("project must contain at least one alphanumeric character");
  if (!typeSlug) throw new Error("assetType must contain at least one alphanumeric character");

  const ext = extension.trim().replace(/^\.+/, "");
  if (!ext) throw new Error("extension must contain at least one character besides leading dots");

  const filename = `${projectSlug}_${typeSlug}_${version}_${date}.${ext}`;
  return { filename };
}
