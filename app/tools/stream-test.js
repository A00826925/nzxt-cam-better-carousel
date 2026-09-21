'use strict';
/*
 * Stand-alone check of the USB layer: streams a procedurally drawn animation to the LCD, at the
 * connected model's own resolution. NZXT CAM and Kraken Host must both be closed.
 * Usage: node tools/stream-test.js [seconds]
 */
const { Kraken } = require('../lib/kraken');
const q565 = require('../lib/q565');

const seconds = Number(process.argv[2] || 10);

function makeRenderer(S) {
  const c = S / 2;
  const u = S / 640; // drawn at 640 proportions, scaled to the screen

  const bg = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const d = Math.hypot(x - c, y - c);
      const ring = d > 300 * u && d < 312 * u;
      bg[i] = ring ? 246 : 24; bg[i + 1] = ring ? 92 : 12; bg[i + 2] = ring ? 139 : 10; bg[i + 3] = 255;
    }
  }

  function dot(buf, cx, cy, r, b, g, rr) {
    for (let y = Math.max(0, cy - r); y <= Math.min(S - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(S - 1, cx + r); x++) {
        const i = (y * S + x) * 4;
        buf[i] = b; buf[i + 1] = g; buf[i + 2] = rr;
      }
    }
  }

  return function drawFrame(n) {
    const f = Buffer.from(bg);
    const a = (n * 6 * Math.PI) / 180 - Math.PI / 2;                 // one turn per 60 frames
    const r = Math.max(1, Math.round(5 * u));
    for (let t = 0; t <= 250 * u; t += Math.max(1, 3 * u)) {
      dot(f, Math.round(c + t * Math.cos(a)), Math.round(c + t * Math.sin(a)), r, 45, 45, 255);
    }
    const bx = 120 * u + ((n * 4 * u) % (400 * u));                  // bar sweeping across the lower half
    for (let x = 120 * u; x < bx; x += Math.max(1, 4 * u)) dot(f, Math.round(x), Math.round(470 * u), Math.round(8 * u), 238, 211, 34);
    dot(f, Math.round(c), Math.round(c), Math.round(14 * u), 45, 45, 255);
    return f;
  };
}

(async () => {
  const k = await new Kraken().open();
  const S = k.size;
  console.log(`opened ${k.model.name} (PID ${k.productId.toString(16)}), ${S}x${S}, orientation ${k.orientation * 90} deg${k.model.tested ? '' : ' — UNTESTED model'}`);
  console.log(`liquid ${await k.readLiquid()} °C`);

  const drawFrame = makeRenderer(S);
  const start = Date.now();
  let n = 0, enc = 0, usb = 0, bytes = 0, lastLog = start;
  const px = new Uint16Array(S * S);
  while (Date.now() - start < seconds * 1000) {
    const t0 = process.hrtime.bigint();
    const payload = q565.encode(q565.bgraToRgb565(drawFrame(n), S, k.orientation, px), S, S);
    const t1 = process.hrtime.bigint();
    await k.sendFrame(payload);
    const t2 = process.hrtime.bigint();
    enc += Number(t1 - t0) / 1e6; usb += Number(t2 - t1) / 1e6; bytes += payload.length; n++;
    if (Date.now() - lastLog > 3000) {
      const secs = (Date.now() - start) / 1000;
      console.log(`${n} frames, ${(n / secs).toFixed(1)} fps | encode ${(enc / n).toFixed(1)} ms, usb+draw ${(usb / n).toFixed(1)} ms | ${(bytes / n / 1024).toFixed(0)} KB/frame | liquid ${await k.readLiquid()} °C`);
      lastLog = Date.now();
    }
  }
  const secs = (Date.now() - start) / 1000;
  console.log(`DONE ${n} frames in ${secs.toFixed(1)} s = ${(n / secs).toFixed(1)} fps`);
  await k.close();
})().catch((e) => { console.error('ERROR', (e && e.stack) || e); process.exit(1); });
