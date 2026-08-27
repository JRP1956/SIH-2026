import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 128;
const HEIGHT = 128;
const BG = [246, 247, 244];
const GREEN = [22, 121, 74];

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([len, payload, crc]);
}

function inShield(x, y) {
  const nx = (x - 64) / 48;
  const ny = (y - 64) / 54;
  if (ny < -0.85) return false;
  if (ny > 0.95) return false;
  const half = ny < 0.15 ? 1 - Math.abs(ny + 0.7) * 0.15 : 1 - (ny - 0.15) * 1.15;
  return Math.abs(nx) <= Math.max(0, half);
}

const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y++) {
  const row = y * (WIDTH * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x++) {
    const i = row + 1 + x * 4;
    const [r, g, b] = inShield(x, y) ? GREEN : BG;
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "icons", "icon.png");
writeFileSync(out, png);
console.log("Wrote", out);
