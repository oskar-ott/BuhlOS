#!/usr/bin/env node
// Rasterise the BuhlOS 3-pin plug icon to PNG at 192 + 512 px.
//
// No external dependencies — uses Node's built-in zlib for the IDAT
// chunk and a hand-rolled CRC32 + PNG chunker. The geometry is the
// same as public/icon.svg so the three sizes never drift apart.
//
// Run:    node scripts/make-icons.js
// Output: public/icon-192.png, public/icon-512.png
//
// Why this exists: the project doesn't ship rsvg-convert / ImageMagick
// / Inkscape on the dev box or in CI, and Node has no native rasteriser.
// The icon is simple enough (4 rounded rects on a rounded-square ground)
// that walking the pixel grid in JS is faster than adding a binary dep.

const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

// Palette pulled from theme.css so the icon matches the workspace shell.
const NAVY   = [0x0d, 0x1b, 0x34, 0xff];
const YELLOW = [0xf5, 0xd0, 0x20, 0xff];

// ── CRC32 (PNG spec) ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  // Filter type 0 (None) per scanline.
  const stride = 1 + width * 4;
  const filtered = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    filtered[y * stride] = 0;
    rgba.subarray(y * width * 4, (y + 1) * width * 4)
      .copy(filtered, y * stride + 1);
  }
  const compressed = zlib.deflateSync(filtered, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width,  0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type RGBA
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter method
  ihdr.writeUInt8(0, 12);  // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Geometry primitives ────────────────────────────────────────────────
// All units in the canonical 512×512 design grid; rasterise() scales them.

// Returns coverage in [0, 1] for a rounded rectangle at angle (rad) centred
// at (cx, cy), with width w, height h, corner radius r. The point (px, py)
// is in the same grid as cx/cy. Coverage uses a simple 2×2 supersample on
// the boundary — enough to soften the edges at the final raster sizes.
function rrectCoverage(px, py, cx, cy, w, h, r, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const sample = (x, y) => {
    const dx = x - cx, dy = y - cy;
    // Rotate into pin-local coords.
    const lx =  dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const ax = Math.abs(lx), ay = Math.abs(ly);
    if (ax > w / 2 || ay > h / 2) return 0;
    if (ax <= w / 2 - r || ay <= h / 2 - r) return 1;
    const ddx = ax - (w / 2 - r);
    const ddy = ay - (h / 2 - r);
    return (ddx * ddx + ddy * ddy <= r * r) ? 1 : 0;
  };
  // 2×2 supersample on a 0.5-grid offset to soften the rotation jaggies.
  return (
    sample(px - 0.25, py - 0.25) +
    sample(px + 0.25, py - 0.25) +
    sample(px - 0.25, py + 0.25) +
    sample(px + 0.25, py + 0.25)
  ) / 4;
}

// Background coverage: rounded-square mask (radius r). 1 inside, 0 outside.
function maskCoverage(px, py, size, r) {
  const sample = (x, y) => {
    if (x < r) {
      if (y < r) {
        const dx = x - r, dy = y - r;
        return dx * dx + dy * dy <= r * r ? 1 : 0;
      }
      if (y > size - r) {
        const dx = x - r, dy = y - (size - r);
        return dx * dx + dy * dy <= r * r ? 1 : 0;
      }
    }
    if (x > size - r) {
      if (y < r) {
        const dx = x - (size - r), dy = y - r;
        return dx * dx + dy * dy <= r * r ? 1 : 0;
      }
      if (y > size - r) {
        const dx = x - (size - r), dy = y - (size - r);
        return dx * dx + dy * dy <= r * r ? 1 : 0;
      }
    }
    return 1;
  };
  return (
    sample(px - 0.25, py - 0.25) +
    sample(px + 0.25, py - 0.25) +
    sample(px - 0.25, py + 0.25) +
    sample(px + 0.25, py + 0.25)
  ) / 4;
}

// ── Rasteriser ─────────────────────────────────────────────────────────
function rasterise(size) {
  const scale = size / 512;
  const rgba  = Buffer.alloc(size * size * 4);

  const cornerR = 90 * scale;

  // Pins (centre, rotation in radians).
  const pins = [
    { cx: 186 * scale, cy: 200 * scale, angle: -30 * Math.PI / 180 },
    { cx: 326 * scale, cy: 200 * scale, angle:  30 * Math.PI / 180 },
    { cx: 256 * scale, cy: 370 * scale, angle:  0 },
  ];
  const pinW = 30 * scale, pinH = 120 * scale, pinR = 15 * scale;

  // Coarse bounding boxes for each pin so we don't scan the entire image
  // when applying the pin colour. Slightly oversized to cover rotation.
  const pinBoxes = pins.map(p => {
    const half = Math.ceil(Math.max(pinW, pinH) / 2 + 2);
    return {
      ...p,
      minX: Math.max(0, Math.floor(p.cx - half)),
      maxX: Math.min(size - 1, Math.ceil(p.cx + half)),
      minY: Math.max(0, Math.floor(p.cy - half)),
      maxY: Math.min(size - 1, Math.ceil(p.cy + half)),
    };
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const mask = maskCoverage(x + 0.5, y + 0.5, size, cornerR);
      if (mask <= 0) {
        rgba[i] = 0; rgba[i+1] = 0; rgba[i+2] = 0; rgba[i+3] = 0;
        continue;
      }
      // Default: navy at mask coverage.
      let r = NAVY[0], g = NAVY[1], b = NAVY[2], a = NAVY[3] * mask;

      // Overlay each pin.
      for (const p of pinBoxes) {
        if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue;
        const c = rrectCoverage(x + 0.5, y + 0.5, p.cx, p.cy, pinW, pinH, pinR, p.angle);
        if (c > 0) {
          r = Math.round(r * (1 - c) + YELLOW[0] * c);
          g = Math.round(g * (1 - c) + YELLOW[1] * c);
          b = Math.round(b * (1 - c) + YELLOW[2] * c);
          a = Math.max(a, YELLOW[3] * mask * c);
        }
      }

      rgba[i] = r; rgba[i+1] = g; rgba[i+2] = b; rgba[i+3] = Math.min(255, a);
    }
  }

  return encodePNG(size, size, rgba);
}

// ── Entry point ────────────────────────────────────────────────────────
const root = path.join(__dirname, '..');
for (const size of [192, 512]) {
  const png = rasterise(size);
  const out = path.join(root, 'public', `icon-${size}.png`);
  fs.writeFileSync(out, png);
  process.stdout.write(`wrote ${out} (${png.length} bytes)\n`);
}
