// Generates cover.png (800x534) for gladys-lightwave: plain Node, no dependency.
// A wall light switch with its dimmer bar, a radiator valve with its dial and
// a window sensor, on a gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.6 + (y / H) * 0.4;
  return [30 + 30 * t, 70 + 60 * t, 120 + 90 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [245, 246, 250];
const dark = [40, 46, 60];
const amber = [255, 190, 60];
const teal = [70, 200, 190];
const red = [230, 90, 80];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

// A glow behind the switch (a dimmed light).
disc(230, 250, 200, amber, 0.12);

// The wall switch: a plate, a rocker and the dimmer bar with its lit segments.
box(110, 120, 350, 400, 22, white);
box(150, 160, 310, 300, 14, dark);
box(165, 175, 295, 235, 8, [60, 68, 86]);
for (let k = 0; k < 8; k += 1) {
  box(165 + k * 17, 320, 177 + k * 17, 370, 3, k < 5 ? amber : [200, 204, 214], 0.95);
}
disc(230, 395, 0, white);

// The radiator valve: a body on a pipe, its dial and a temperature mark.
line(430, 420, 700, 420, 16, [190, 196, 206]);
box(495, 220, 635, 420, 24, white);
disc(565, 300, 52, dark);
disc(565, 300, 40, [60, 68, 86]);
line(565, 300, 565 + 26 * Math.cos(-0.8), 300 + 26 * Math.sin(-0.8), 5, amber);
for (let k = 0; k < 12; k += 1) {
  const angle = -Math.PI * 0.75 + (k * Math.PI * 1.5) / 11;
  disc(565 + 46 * Math.cos(angle), 300 + 46 * Math.sin(angle), 2.2, white);
}
disc(565, 380, 7, red);

// The window sensor: two halves, a contact light.
box(440, 110, 560, 160, 10, white);
box(575, 110, 640, 160, 10, white);
disc(500, 135, 7, teal);
disc(607, 135, 5, [120, 128, 145]);

// A small signal wave from the hub, bottom right.
for (const r of [18, 32, 46]) {
  for (let a = -Math.PI * 0.85; a <= -Math.PI * 0.15; a += 0.01) {
    set(Math.round(700 + r * Math.cos(a)), Math.round(500 + r * Math.sin(a)), white, 0.9);
  }
}
disc(700, 500, 6, white);

// PNG encoder (RGB, no filter), CRC and zlib from Node.
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
