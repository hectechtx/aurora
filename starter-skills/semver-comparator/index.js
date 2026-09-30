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

function parse(v, label) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  if (!m) throw new Error(`${label} is not a valid semantic version`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function run(args) {
  const v1 = parse(args.version1, "version1");
  const v2 = parse(args.version2, "version2");

  let greater;
  if (v1.major !== v2.major || v1.minor !== v2.minor || v1.patch !== v2.patch) {
    if (v1.major !== v2.major) greater = v1.major > v2.major ? "version1" : "version2";
    else if (v1.minor !== v2.minor) greater = v1.minor > v2.minor ? "version1" : "version2";
    else greater = v1.patch > v2.patch ? "version1" : "version2";
  } else {
    greater = "equal";
  }

  const big = greater === "version1" ? v1 : greater === "version2" ? v2 : v1;
  const small = greater === "version1" ? v2 : greater === "version2" ? v1 : v2;

  let bumpType = "none";
  if (greater !== "equal") {
    if (big.major !== small.major) bumpType = "major";
    else if (big.minor !== small.minor) bumpType = "minor";
    else bumpType = "patch";
  }

  return { greater, bumpType };
}
