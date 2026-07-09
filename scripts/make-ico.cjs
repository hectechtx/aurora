// Wraps a 256x256 PNG in a minimal single-entry .ico container (Windows
// Vista+ supports embedding a raw PNG for the 256px ICO entry — no need for
// a full BMP-based ICO encoder or an extra dependency).
const fs = require("node:fs");
const path = require("node:path");

const pngPath = process.argv[2];
const icoPath = process.argv[3];

const png = fs.readFileSync(pngPath);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width (0 = 256)
entry.writeUInt8(0, 1); // height (0 = 256)
entry.writeUInt8(0, 2); // color palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // image data size
entry.writeUInt32LE(header.length + entry.length, 12); // offset

fs.writeFileSync(icoPath, Buffer.concat([header, entry, png]));
console.log(`Wrote ${icoPath} (${fs.statSync(icoPath).size} bytes)`);
