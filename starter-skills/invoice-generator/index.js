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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function run(args) {
  const clientName = String(args.clientName ?? "").trim();
  const items = args.items;
  const taxPercent = args.taxPercent === undefined ? 0 : Number(args.taxPercent);
  const discountPercent = args.discountPercent === undefined ? 0 : Number(args.discountPercent);

  if (!clientName) {
    throw new Error("clientName is required");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (!Number.isFinite(taxPercent) || !Number.isFinite(discountPercent)) {
    throw new Error("taxPercent and discountPercent must be numbers");
  }

  let subtotal = 0;
  const lineRows = items.map((item) => {
    const description = String(item.description ?? "");
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    if (!description || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) {
      throw new Error("each item needs a description, quantity, and unitPrice");
    }
    const lineTotal = quantity * unitPrice;
    subtotal += lineTotal;
    return { description, quantity, unitPrice, lineTotal: round2(lineTotal) };
  });

  const discountAmount = subtotal * (discountPercent / 100);
  const taxableAmount = subtotal - discountAmount;
  const taxAmount = taxableAmount * (taxPercent / 100);
  const total = taxableAmount + taxAmount;

  const lines = [];
  lines.push(`INVOICE`);
  lines.push(`Client: ${clientName}`);
  lines.push("");
  lines.push("Line Items:");
  for (const row of lineRows) {
    lines.push(`  ${row.description} — ${row.quantity} x $${row.unitPrice.toFixed(2)} = $${row.lineTotal.toFixed(2)}`);
  }
  lines.push("");
  lines.push(`Subtotal: $${round2(subtotal).toFixed(2)}`);
  lines.push(`Discount (${discountPercent}%): -$${round2(discountAmount).toFixed(2)}`);
  lines.push(`Tax (${taxPercent}%): $${round2(taxAmount).toFixed(2)}`);
  lines.push(`Total: $${round2(total).toFixed(2)}`);

  return {
    formatted: lines.join("\n"),
    subtotal: round2(subtotal),
    discountAmount: round2(discountAmount),
    taxAmount: round2(taxAmount),
    total: round2(total)
  };
}
