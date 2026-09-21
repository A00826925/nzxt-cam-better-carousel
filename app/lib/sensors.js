'use strict';
/*
 * Runs the KrakenSensors helper (LibreHardwareMonitor, read-only) and keeps its latest reading.
 * The helper prints one JSON line per second and exits when our end of its stdin closes.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = path.join(__dirname, '..', 'sensors', 'bin', 'publish', 'KrakenSensors.exe');

class Sensors {
  constructor(log) {
    this.log = log || (() => {});
    this.latest = null;
    this.child = null;
    this.stopped = false;
    this.restartDelay = 2000;
  }

  start() {
    if (!fs.existsSync(EXE)) {
      this.log(`sensor helper not built (${EXE}); CPU/GPU readings unavailable — see README`);
      return;
    }
    this.stopped = false;
    const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.latest = JSON.parse(line);
          this.restartDelay = 2000;
        } catch (e) { /* partial or odd line */ }
      }
    });
    child.stderr.on('data', (d) => this.log(`sensors: ${String(d).trim()}`));
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.log(`sensor helper exited (${code}), restarting in ${this.restartDelay / 1000}s`);
      setTimeout(() => { if (!this.stopped) this.start(); }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 60000);
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.stdin.end(); } catch (e) { /* already closed */ }
      const c = this.child;
      setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 1500);
      this.child = null;
    }
  }

  /**
   * In the shape NZXT CAM passes to window.nzxt.v1.onMonitoringDataUpdate. Unknown values are
   * left out rather than sent as null, so the page shows "–" instead of 0.
   */
  monitoringData(liquid) {
    const s = this.latest || {};
    const entry = (r) => {
      const o = {};
      if (r && r.temp != null) o.temperature = r.temp;
      if (r && r.load != null) o.load = r.load / 100;
      return o;
    };
    const data = { cpus: [entry(s.cpu)], gpus: [entry(s.gpu)] };
    if (liquid != null) data.kraken = { liquidTemperature: liquid };
    return data;
  }
}

module.exports = { Sensors };
