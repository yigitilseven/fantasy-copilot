// Generates the PWA icons (public/icons/*.png) with no dependencies: node scripts/make-icons.mjs  (the PNGs are committed)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const crcT = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (t, d) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t), d]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

/** Dark square, orange ball with seams. `pad` shrinks the ball (maskable icons keep it inside the safe zone). */
function icon(size, pad) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, r = size * (0.5 - pad), seam = Math.max(1.5, size * 0.018);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cx, d = Math.hypot(dx, dy);
      let c = [10, 10, 10];
      if (d <= r) {
        c = [234, 88, 12];
        const arc = Math.abs(Math.hypot(Math.abs(dx) - r * 1.05, dy) - r * 0.62) < seam && Math.abs(dx) < r;
        if (Math.abs(dx) < seam || Math.abs(dy) < seam || arc) c = [24, 24, 27];
      } else if (d <= r + 1) c = [120, 50, 8];
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

fs.mkdirSync(out, { recursive: true });
for (const [name, size, pad] of [["icon-192.png", 192, 0.1], ["icon-512.png", 512, 0.1], ["icon-maskable-512.png", 512, 0.22], ["apple-touch-icon.png", 180, 0.08]]) {
  fs.writeFileSync(path.join(out, name), icon(size, pad));
  console.log("wrote", name);
}
