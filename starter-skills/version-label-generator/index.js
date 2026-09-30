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
  const currentVersion = args.currentVersion;
  if (typeof currentVersion !== "string" || currentVersion.length === 0) {
    throw new Error("currentVersion must be a non-empty string");
  }
  const bumpType = args.bumpType || "patch";
  if (!["major", "minor", "patch"].includes(bumpType)) {
    throw new Error("bumpType must be major, minor, or patch");
  }

  const semverMatch = currentVersion.match(/^(v?)(\d+)\.(\d+)\.(\d+)$/);
  if (semverMatch) {
    const [, prefix, majorS, minorS, patchS] = semverMatch;
    let major = parseInt(majorS, 10);
    let minor = parseInt(minorS, 10);
    let patch = parseInt(patchS, 10);
    if (bumpType === "major") {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (bumpType === "minor") {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    return { currentVersion, nextVersion: `${prefix}${major}.${minor}.${patch}` };
  }

  const simpleMatch = currentVersion.match(/^(v?)(\d+)$/);
  if (simpleMatch) {
    const [, prefix, numS] = simpleMatch;
    const next = parseInt(numS, 10) + 1;
    return { currentVersion, nextVersion: `${prefix}${next}` };
  }

  throw new Error("unrecognized version format");
}
