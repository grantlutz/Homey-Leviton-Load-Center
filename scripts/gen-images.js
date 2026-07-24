'use strict';

/**
 * Generates placeholder PNG assets at the exact dimensions the Homey App Store
 * validator expects. Solid brand-colour background with a lighter panel — enough
 * to pass validation; replace with real artwork before publishing.
 *
 *   node scripts/gen-images.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width, height, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const rowLen = width * 3;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1);
    raw[off] = 0; // filter: none
    // simple two-tone: outer brand colour, inner lighter panel
    const inset = Math.floor(Math.min(width, height) * 0.12);
    for (let x = 0; x < width; x++) {
      const inside = x > inset && x < width - inset && y > inset && y < height - inset;
      const [r, g, b] = inside ? [Math.min(255, rgb[0] + 90), Math.min(255, rgb[1] + 90), Math.min(255, rgb[2] + 70)] : rgb;
      const p = off + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const BRAND = [0x00, 0x98, 0xDB];
const root = path.join(__dirname, '..');

const targets = [
  // App images
  ['assets/images/small.png', 250, 175],
  ['assets/images/large.png', 500, 350],
  ['assets/images/xlarge.png', 1000, 700],
  // Driver images (square)
  ['drivers/breaker/assets/images/small.png', 75, 75],
  ['drivers/breaker/assets/images/large.png', 500, 500],
  ['drivers/breaker/assets/images/xlarge.png', 1000, 1000],
  ['drivers/panel/assets/images/small.png', 75, 75],
  ['drivers/panel/assets/images/large.png', 500, 500],
  ['drivers/panel/assets/images/xlarge.png', 1000, 1000],
  ['drivers/ct/assets/images/small.png', 75, 75],
  ['drivers/ct/assets/images/large.png', 500, 500],
  ['drivers/ct/assets/images/xlarge.png', 1000, 1000],
];

for (const [rel, w, h] of targets) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(w, h, BRAND));
  console.log(`wrote ${rel} (${w}x${h})`);
}
console.log('Done.');
