// Draws the app icons (green tile, gold eight-point star) as PNGs with no image libraries.
// Run: node tools/make-icons.js
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const OUT = path.join(__dirname, '..', 'public', 'icons');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const star = (cx, cy, R, r, n = 8, rot = -90) => Array.from({ length: 2 * n }, (_, i) => {
  const a = (rot + i * 180 / n) * Math.PI / 180, rad = i % 2 ? r : R; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
});
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
  const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// shapes on a 0..1 canvas, painted in order
function draw(size, { radius = 0, scale = 1, badge = false }) {
  const S = 4, buf = Buffer.alloc(size * size * 4);
  const s = scale, c = .5;
  const outer = star(c, c, .34 * s, .21 * s, 8, -90 + 22.5), inner = star(c, c, .17 * s, .1 * s, 8, -90);
  const green = hex('#0d4f43'), gold = hex('#e8b23a'), red = hex('#c2482b'), cream = hex('#fffaf0');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + .5) / S) / size, v = (y + (sy + .5) / S) / size;
      let col = null;
      if (!badge) {   // background tile with optional rounded corners
        const dx = Math.max(radius - u, 0, u - (1 - radius)), dy = Math.max(radius - v, 0, v - (1 - radius));
        if (radius === 0 || dx * dx + dy * dy <= radius * radius) col = [...green, 255];
      }
      if (inPoly(u, v, outer)) col = badge ? [255, 255, 255, 255] : [...gold, 255];
      if (inPoly(u, v, inner)) col = badge ? [0, 0, 0, 0] : [...red, 255];
      if (!badge && Math.hypot(u - c, v - c) < .045 * s) col = [...cream, 255];
      if (col) { acc[0] += col[0] * col[3]; acc[1] += col[1] * col[3]; acc[2] += col[2] * col[3]; acc[3] += col[3]; }
    }
    const i = (y * size + x) * 4, a = acc[3] / (S * S);
    buf[i] = acc[3] ? acc[0] / acc[3] : 0; buf[i + 1] = acc[3] ? acc[1] / acc[3] : 0; buf[i + 2] = acc[3] ? acc[2] / acc[3] : 0; buf[i + 3] = a;
  }
  return png(size, buf);
}
fs.mkdirSync(OUT, { recursive: true });
const files = {
  'icon-192.png': draw(192, { radius: .22 }),
  'icon-512.png': draw(512, { radius: .22 }),
  'maskable-512.png': draw(512, { radius: 0, scale: .8 }),   // full bleed; star inside the safe zone
  'apple-touch-icon.png': draw(180, { radius: 0 }),          // iPhone rounds the corners itself
  'badge-96.png': draw(96, { badge: true, scale: 1.25 }),    // white silhouette for Android's status bar
};
for (const [name, data] of Object.entries(files)) { fs.writeFileSync(path.join(OUT, name), data); console.log(name, data.length, 'bytes'); }
