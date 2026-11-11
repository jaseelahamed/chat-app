const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Precomputed CRC32 table for valid PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function blend(dst, idx, r, g, b, alpha) {
  const a = clamp01(alpha);
  dst[idx] = Math.round(lerp(dst[idx], r, a));
  dst[idx + 1] = Math.round(lerp(dst[idx + 1], g, a));
  dst[idx + 2] = Math.round(lerp(dst[idx + 2], b, a));
  dst[idx + 3] = 255;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = clamp01(((px - x1) * dx + (py - y1) * dy) / lenSq);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function roundedRectSdf(px, py, cx, cy, halfSize, radius) {
  const qx = Math.abs(px - cx) - (halfSize - radius);
  const qy = Math.abs(py - cy) - (halfSize - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function renderPulseIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1.35 / size;

  const wavePoints = [
    [0.29, 0.5],
    [0.385, 0.5],
    [0.445, 0.33],
    [0.545, 0.67],
    [0.615, 0.5],
    [0.71, 0.5]
  ];

  for (let y = 0; y < size; y++) {
    const ny = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5) / size;
      const idx = (y * size + x) * 4;

      // Deep navy radial background (#131c33 -> #070b14)
      const bgDist = Math.hypot(nx - 0.5, ny - 0.38);
      const bgT = clamp01(bgDist / 0.72);
      rgba[idx] = Math.round(lerp(20, 7, bgT));
      rgba[idx + 1] = Math.round(lerp(30, 11, bgT));
      rgba[idx + 2] = Math.round(lerp(56, 20, bgT));
      rgba[idx + 3] = 255;

      // Soft outer glow behind badge
      const badgeSdf = roundedRectSdf(nx, ny, 0.5, 0.5, 0.31, 0.085);
      if (badgeSdf > 0 && badgeSdf < 0.16) {
        const glow = Math.pow(1 - badgeSdf / 0.16, 2.2) * 0.36;
        blend(rgba, idx, 72, 130, 245, glow);
      }

      // Indigo -> Violet -> Cyan gradient badge
      const badgeAlpha = clamp01(0.5 - badgeSdf / aa);
      if (badgeAlpha > 0) {
        const gt = clamp01((nx * 0.55 + ny * 0.45 - 0.18) / 0.64);
        let r, g, b;
        if (gt < 0.5) {
          const u = gt * 2;
          r = lerp(99, 139, u);
          g = lerp(102, 92, u);
          b = lerp(241, 246, u);
        } else {
          const u = (gt - 0.5) * 2;
          r = lerp(139, 6, u);
          g = lerp(92, 182, u);
          b = lerp(246, 212, u);
        }

        // Subtle frosted glass top highlight
        const sheen = clamp01(1 - (ny - 0.19) / 0.28) * 0.16;
        r = lerp(r, 255, sheen);
        g = lerp(g, 255, sheen);
        b = lerp(b, 255, sheen);

        blend(rgba, idx, r, g, b, badgeAlpha);

        // Crisp inner glass border
        const borderDist = Math.abs(badgeSdf + 0.005);
        const borderAlpha = clamp01(1 - borderDist / 0.006) * 0.35 * badgeAlpha;
        if (borderAlpha > 0) {
          blend(rgba, idx, 255, 255, 255, borderAlpha);
        }
      }

      // Pulse ECG waveform
      let minDist = Infinity;
      for (let i = 0; i < wavePoints.length - 1; i++) {
        const [x1, y1] = wavePoints[i];
        const [x2, y2] = wavePoints[i + 1];
        const d = distToSegment(nx, ny, x1, y1, x2, y2);
        if (d < minDist) minDist = d;
      }

      const strokeRadius = 0.025;
      if (minDist < strokeRadius + 0.03) {
        const waveGlow = clamp01(1 - (minDist - strokeRadius) / 0.03) * 0.32;
        if (waveGlow > 0 && minDist > strokeRadius) {
          blend(rgba, idx, 224, 248, 255, waveGlow);
        }
        const waveAlpha = clamp01(0.5 - (minDist - strokeRadius) / aa);
        if (waveAlpha > 0) {
          blend(rgba, idx, 255, 255, 255, waveAlpha);
        }
      }
    }
  }

  return encodePng(size, size, rgba);
}

function ensureIcons() {
  const iconsDir = path.join(__dirname, 'icons');
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const size of [192, 512]) {
    const outPath = path.join(iconsDir, `icon-${size}.png`);
    const png = renderPulseIcon(size);
    fs.writeFileSync(outPath, png);
    console.log(`  [icons] Generated ${outPath}`);
  }
}

if (require.main === module) {
  ensureIcons();
}

module.exports = { ensureIcons };

