'use strict';
/*
 * q565 encoder: the RGB565 variant of the QOI image format that the Kraken Elite LCD decodes.
 * Port of the reference encoder at https://github.com/seritools/q565 (MIT / Apache-2.0), minus the
 * optional DIFF_INDEXED operation, which only trades encoder speed for ~5% smaller output.
 * The colour table is updated exactly where the decoder updates it (LUMA and RGB565 only).
 */

/** Sign-extend the low `bits` bits: the wrap-around channel difference the format uses. */
function sx(v, bits) {
  const s = 32 - bits;
  return (v << s) >> s;
}

/** px: Uint16Array of RGB565 pixels, row by row. Returns a Buffer with the q565 stream. */
function encode(px, width, height) {
  const out = Buffer.allocUnsafe(8 + px.length * 3 + 1); // worst case: every pixel a literal
  out.write('q565', 0, 'latin1');
  out.writeUInt16LE(width, 4);
  out.writeUInt16LE(height, 6);
  let o = 8;

  const arr = new Uint16Array(64);
  let prev = 0, pr = 0, pg = 0, pb = 0;
  const n = px.length;
  let i = 0;

  while (i < n) {
    const p = px[i];
    if (p === prev) {
      let run = 0;
      while (i < n && px[i] === prev) { run++; i++; }
      while (run >= 62) { out[o++] = 0xfd; run -= 62; } // RUN of 62 (0xc0 | 61)
      if (run > 0) out[o++] = 0xc0 | (run - 1);
      continue;
    }
    i++;

    prev = p;
    const r = p >> 11, g = (p >> 5) & 63, b = p & 31;
    const dr = sx(r - pr, 5), dg = sx(g - pg, 6), db = sx(b - pb, 5);
    pr = r; pg = g; pb = b;

    const h = ((p & 0xff) + (p >> 8)) & 63;
    if (arr[h] === p) {                                   // INDEX
      out[o++] = h;
      continue;
    }
    if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
      out[o++] = 0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2); // DIFF (not stored)
      continue;
    }
    const drg = dr - dg, dbg = db - dg;
    if (dg >= -16 && dg <= 15 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) {
      out[o++] = 0x80 | (dg + 16);                        // LUMA
      out[o++] = ((drg + 8) << 4) | (dbg + 8);
    } else {
      out[o++] = 0xfe;                                    // RGB565 literal
      out[o++] = p & 0xff;
      out[o++] = p >> 8;
    }
    arr[h] = p;
  }

  out[o++] = 0xff;                                        // END
  return out.subarray(0, o);
}

/**
 * Convert a BGRA frame (what Electron's offscreen renderer hands out) to RGB565, rotated for how
 * the cooler is mounted. `rotation` is the LCD orientation code (0..3 = 0/90/180/270 degrees);
 * like CAM and liquidctl, the picture is turned by rotation * -90 degrees (i.e. 270 -> 90 CCW).
 * Square frames only (the Kraken Elite is 640x640).
 */
function bgraToRgb565(bgra, size, rotation, out) {
  const px = out || new Uint16Array(size * size);
  const last = size - 1;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      let sxp, syp;
      switch (rotation & 3) {
        case 1: sxp = dy; syp = last - dx; break;        // 90 CW
        case 2: sxp = last - dx; syp = last - dy; break; // 180
        case 3: sxp = last - dy; syp = dx; break;        // 90 CCW
        default: sxp = dx; syp = dy;
      }
      const s = (syp * size + sxp) * 4;
      const b = bgra[s], g = bgra[s + 1], r = bgra[s + 2];
      px[dy * size + dx] =
        (((r * 249 + 1014) >> 11) << 11) | (((g * 253 + 505) >> 10) << 5) | ((b * 249 + 1014) >> 11);
    }
  }
  return px;
}

module.exports = { encode, bgraToRgb565 };
