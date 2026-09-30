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

const STATUS_CODES = {
  200: "OK", 201: "Created", 204: "No Content",
  301: "Moved Permanently", 302: "Found", 304: "Not Modified",
  400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  415: "Unsupported Media Type", 422: "Unprocessable Entity", 429: "Too Many Requests",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout"
};

const CATEGORIES = {
  1: "Informational", 2: "Success", 3: "Redirection", 4: "Client Error", 5: "Server Error"
};

function run(args) {
  const code = Number(args.code);
  if (!Number.isInteger(code) || !(code in STATUS_CODES)) {
    throw new Error("unknown status code");
  }
  const category = CATEGORIES[Math.floor(code / 100)];
  return { code, description: STATUS_CODES[code], category };
}
