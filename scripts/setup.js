#!/usr/bin/env node
/**
 * Post-install setup script:
 *  1. Copies Readability.js from node_modules → lib/
 *  2. Generates simple PNG icons for the extension
 *
 * No external dependencies — uses only Node.js built-ins.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

// ─── 1. Copy Readability.js ───────────────────────────────────────────────────

const readabilitySrc = path.join(ROOT, 'node_modules', '@mozilla', 'readability', 'Readability.js');
const readabilityDst = path.join(ROOT, 'lib', 'Readability.js');

if (!fs.existsSync(path.dirname(readabilityDst))) {
  fs.mkdirSync(path.dirname(readabilityDst), { recursive: true });
}

if (fs.existsSync(readabilitySrc)) {
  fs.copyFileSync(readabilitySrc, readabilityDst);
  console.log('✓ Readability.js → lib/Readability.js');
} else {
  console.error('✗ Readability.js not found. Run: npm install');
  process.exit(1);
}

// ─── 2. Generate PNG icons ────────────────────────────────────────────────────

const iconsDir = path.join(ROOT, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

/**
 * Pure-Node CRC32 used by the PNG chunk encoder.
 */
function makeCRCTable() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
}

const CRC_TABLE = makeCRCTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcVal]);
}

/**
 * Build a minimal valid RGB PNG filled with a single solid colour.
 * Draws a rounded-corner square with a white letter "O" in the centre
 * to make it recognisable at small sizes.
 *
 * @param {number} size   Width/height in pixels.
 * @param {number} r,g,b  Background fill colour (0-255 each).
 */
function makePNG(size, r, g, b) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR — 8-bit RGB, no interlace
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // Raw image data: 1 filter byte (None=0) + 3 bytes/pixel per row
  const rowLen = 1 + size * 3;
  const raw = Buffer.alloc(size * rowLen, 0);

  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.42; // icon circle radius
  const ringW = size * 0.1; // ring thickness for the "O" shape

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const dist = Math.hypot(dx, dy);

      let pr = r,
        pg = g,
        pb = b; // default: brand colour

      // White "O" ring
      if (dist >= outerR - ringW && dist <= outerR) {
        pr = 255;
        pg = 255;
        pb = 255;
      } else if (dist > outerR) {
        // Outside icon — transparent-ish: use a lighter background
        pr = 240;
        pg = 240;
        pb = 250;
      }

      const i = y * rowLen + 1 + x * 3;
      raw[i] = pr;
      raw[i + 1] = pg;
      raw[i + 2] = pb;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Indigo brand colour (#6366f1)
const [BRAND_R, BRAND_G, BRAND_B] = [99, 102, 241];

for (const size of [16, 48, 128]) {
  const png = makePNG(size, BRAND_R, BRAND_G, BRAND_B);
  const dest = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`✓ icons/icon${size}.png`);
}

console.log(
  '\nSetup complete. Load the extension from Chrome → Manage Extensions → Load unpacked.',
);
