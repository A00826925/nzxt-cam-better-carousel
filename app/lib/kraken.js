'use strict';
/*
 * NZXT Kraken LCD: display-only driver (Elite 2023 tested; other LCD models best-effort).
 *
 * Two USB interfaces on the cooler:
 *   - HID (interface 1): 64-byte command/response reports. Used here ONLY for the frame handshake
 *     and for reading info (orientation, liquid temperature). No pump, fan or lighting commands.
 *   - WinUSB bulk (interface 0, endpoint 0x02): the frame data.
 *
 * Streaming a frame, as NZXT CAM does it (from a USB capture):
 *   HID  36 01 00 01 08            start transfer, type 8 = live q565 frame
 *   HID  <- 37 01                  cooler ready
 *   BULK 12fa01e8abcdef9876543210 | 08 00 00 00 | payload length (u32 LE)
 *   BULK q565 frame
 *   HID  36 02                     end transfer
 *   HID  <- 37 02                  frame drawn (~20 ms); only then send the next one
 */
const HID = require('node-hid');
const { findByIds } = require('usb');

const VID = 0x1e71;

// Kraken models with a screen, as known to liquidctl. Only the Elite 2023 has been tested; the others
// share the protocol family and are enabled on a best-effort basis ("if it happens to work, it works").
// `chunk` is how much the cooler takes per bulk write (liquidctl's bulk_buffer_size).
const MODELS = {
  0x300c: { name: 'Kraken Elite (2023)', size: 640, chunk: 2 * 1024 * 1024, tested: true },
  0x3012: { name: 'Kraken Elite RGB (2024)', size: 640, chunk: 2 * 1024 * 1024, tested: false },
  0x300e: { name: 'Kraken (2023)', size: 240, chunk: 2 * 1024 * 1024, tested: false },
  0x3014: { name: 'Kraken Plus (2024)', size: 240, chunk: 2 * 1024 * 1024, tested: false },
  0x3008: { name: 'Kraken Z53/Z63/Z73', size: 320, chunk: 512, tested: false },
};
const PIDS = Object.keys(MODELS).map(Number);
const REPORT = 64;
const MAGIC = Buffer.from('12fa01e8abcdef9876543210', 'hex');

class Kraken {
  constructor() {
    this.hid = null;
    this.usbDev = null;
    this.iface = null;
    this.bulkOut = null;
    this.waiters = [];     // { a, b, resolve, timer }
    this.orientation = 0;  // 0..3
    this.model = null;     // entry from MODELS
    this.size = 640;       // square LCD resolution of the connected model
    this.busy = Promise.resolve(); // serialises HID exchanges so replies can't get mixed up
  }

  static async find() {
    for (const pid of PIDS) {
      const found = await HID.devicesAsync(VID, pid);
      if (found.length) return found[0];
    }
    return null;
  }

  async open() {
    const info = await Kraken.find();
    if (!info) throw new Error('No Kraken with a screen found');
    this.productId = info.productId;
    this.model = MODELS[info.productId];
    this.size = this.model.size;

    this.hid = await HID.HIDAsync.open(info.path);
    this.hid.on('data', (buf) => this._onReport(buf));
    this.hid.on('error', (err) => this._failAll(err));

    this.usbDev = findByIds(VID, info.productId);
    if (!this.usbDev) throw new Error('Kraken LCD interface not found');
    this.usbDev.open();
    this.iface = this.usbDev.interface(0);
    this.iface.claim();
    this.bulkOut = this.iface.endpoints.find((e) => e.direction === 'out');
    if (!this.bulkOut) throw new Error('Kraken LCD bulk endpoint not found');
    this.bulkOut.timeout = 3000;

    const lcd = await this.readLcdInfo();
    this.orientation = lcd.orientation;
    return this;
  }

  /** Release both interfaces. Awaits the USB release, or the device stays open. */
  async close() {
    this._failAll(new Error('closed'));
    const { hid, iface, usbDev } = this;
    this.hid = this.usbDev = this.iface = this.bulkOut = null;
    try { if (hid) await hid.close(); } catch (e) { /* already gone */ }
    if (iface) await new Promise((resolve) => { try { iface.release(() => resolve()); } catch (e) { resolve(); } });
    try { if (usbDev) usbDev.close(); } catch (e) { /* already gone */ }
  }

  // ---------- HID plumbing ----------

  _onReport(buf) {
    const i = this.waiters.findIndex((w) => buf[0] === w.a && (w.b === null || buf[1] === w.b));
    if (i < 0) return; // periodic status reports etc. that nobody asked for
    const [w] = this.waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(buf);
  }

  _failAll(err) {
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
  }

  _waitFor(a, b, ms = 1000) {
    return new Promise((resolve, reject) => {
      const w = { a, b, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`timeout waiting for ${a.toString(16)} ${b === null ? '' : b.toString(16)}`));
      }, ms);
      this.waiters.push(w);
    });
  }

  async _write(bytes) {
    const data = bytes.concat(new Array(REPORT - bytes.length).fill(0));
    await this.hid.write(data);
  }

  /** Send a command and wait for its reply (prefix a,b). Exchanges never overlap. */
  _exchange(cmd, a, b, ms) {
    const run = async () => {
      const reply = this._waitFor(a, b, ms);
      await this._write(cmd);
      return reply;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }

  /** Bulk write in the model's chunk size (one transfer for the 2023+ models' 2 MB buffers). */
  async _bulk(buf) {
    const step = (this.model && this.model.chunk) || buf.length;
    for (let i = 0; i < buf.length; i += step) {
      await this.bulkOut.transferAsync(buf.subarray(i, Math.min(i + step, buf.length)));
    }
  }

  // ---------- reads ----------

  async readLcdInfo() {
    const msg = await this._exchange([0x30, 0x01], 0x31, 0x01);
    return { brightness: msg[0x18], orientation: msg[0x1a] & 3 };
  }

  /** Liquid temperature (°C) from the cooler itself; null if the reading looks broken. */
  async readLiquid() {
    const msg = await this._exchange([0x74, 0x01], 0x75, null);
    if (msg[15] === 0xff && msg[16] === 0xff) return null;
    return msg[15] + msg[16] / 10;
  }

  // ---------- frames ----------

  /** Stream one q565 frame; resolves once the cooler has drawn it. */
  sendFrame(payload) {
    const run = async () => {
      const ready = this._waitFor(0x37, 0x01);
      await this._write([0x36, 0x01, 0x00, 0x01, 0x08]);
      await ready;
      const header = Buffer.alloc(20);
      MAGIC.copy(header, 0);
      header[12] = 0x08;
      header.writeUInt32LE(payload.length, 16);
      await this._bulk(header);
      await this._bulk(payload);
      const drawn = this._waitFor(0x37, 0x02);
      await this._write([0x36, 0x02]);
      await drawn;
    };
    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }
}

module.exports = { Kraken, VID, PIDS, MODELS };
