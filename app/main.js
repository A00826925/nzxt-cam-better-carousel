'use strict';
/*
 * Kraken Host: shows the carousel on an NZXT Kraken's LCD without NZXT CAM.
 *
 * Renders ../index.html (the same page CAM would show) in a hidden off-screen window sized to the LCD,
 * feeds it sensor readings through the same hook CAM uses (window.nzxt.v1.onMonitoringDataUpdate),
 * and streams every frame to the cooler exactly the way CAM does.
 *
 * Display only: it never sends pump, fan or lighting commands.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Kraken } = require('./lib/kraken');
const q565 = require('./lib/q565');
const { Sensors } = require('./lib/sensors');

const ROOT = path.resolve(__dirname, '..');   // the carousel folder: index.html, editor.html, media/
const PAGE = path.join(ROOT, 'index.html');
const EDITOR = path.join(ROOT, 'editor.html');
// Until a cooler is connected; then the window follows its resolution. The env var is a test knob.
const DEFAULT_SIZE = Number(process.env.KRAKEN_HOST_TEST_SIZE) || 640;
const FPS = 30;                // ask Chromium for at most this many frames; the cooler tops out ~28
const KEEPALIVE_MS = 1000;     // re-send the current frame at least this often, even if nothing moved
const RETRY_MS = 5000;         // how often to retry when the cooler is missing or CAM has it
const SENSOR_MS = 1000;

// Only ever loads the local carousel page, so Electron's remote-content warning is just noise.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

// Bitmaps at the LCD's exact size regardless of Windows display scaling; let videos start without a click.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let kraken = null;
  let quitting = false;
  let sensors = null;

  let latest = null;     // most recent painted frame (NativeImage)
  let latestSeq = 0;     // bumps on every paint
  let sentSeq = -1;
  let lastSentAt = 0;

  const state = { status: 'Starting…', fps: 0, liquid: null, sentWindow: [] };

  // ---------- logging ----------

  const logFile = path.join(app.getPath('userData'), 'kraken-host.log');
  // Logging must never break the app. Started from Task Scheduler there is no console at all,
  // so the file comes first and the console write is best-effort.
  function log(msg) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1e6) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, line, 'utf8');
    } catch (e) { /* nowhere else to report it */ }
    try { if (process.stdout && process.stdout.writable) process.stdout.write(line); } catch (e) { /* no console */ }
  }
  process.stdout && process.stdout.on && process.stdout.on('error', () => {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(s) {
    if (s !== state.status) log(`status: ${s}`);
    state.status = s;
  }

  // ---------- NZXT CAM detection: two programs can't drive the screen at once ----------

  function camRunning() {
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq NZXT CAM.exe', '/NH'], { windowsHide: true }, (err, out) => {
        resolve(!err && /NZXT CAM\.exe/i.test(out));
      });
    });
  }

  // ---------- the cooler ----------

  let framesThisConnection = 0;
  let rejectedConnections = 0; // untested model that hasn't taken a single frame, connection after connection
  let retryMs = RETRY_MS;

  async function connect() {
    if (await camRunning()) {
      setStatus('NZXT CAM is running — close it to use Kraken Host');
      return false;
    }
    try {
      kraken = await new Kraken().open();
      const m = kraken.model;
      framesThisConnection = 0;
      setStatus(`Streaming to your ${m.name}${m.tested ? '' : ' (untested model)'}`);
      log(`connected: ${m.name} (PID ${kraken.productId.toString(16)}), ${kraken.size}x${kraken.size}, ` +
          `orientation ${kraken.orientation * 90}°${m.tested ? '' : ', UNTESTED model'}`);
      setRenderSize(kraken.size);
      sentSeq = -1; // push a frame right away
      return true;
    } catch (e) {
      kraken = null;
      setStatus(`Cooler not available (${e.message})`);
      return false;
    }
  }

  /** Render the page at the cooler's own resolution; the page rescales itself to fit. */
  function setRenderSize(size) {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    if (w === size && h === size) return;
    log(`render size ${size}x${size}`);
    win.setContentSize(size, size);
    latest = null;
  }

  async function disconnect(reason) {
    if (!kraken) return;
    log(`disconnect: ${reason}`);
    const k = kraken;
    kraken = null;
    await k.close().catch(() => {});
  }

  async function streamLoop() {
    let px = null;
    while (!quitting) {
      if (!kraken && !(await connect())) { await sleep(retryMs); continue; }

      const now = Date.now();
      const fresh = latestSeq !== sentSeq;
      if (!latest || (!fresh && now - lastSentAt < KEEPALIVE_MS)) { await sleep(4); continue; }

      // Hold on to this connection: the CAM check in sensorLoop may drop `kraken` while a frame is in flight.
      const k = kraken;
      const size = k.size;
      const seq = latestSeq;
      const { width, height } = latest.getSize();
      if (width !== size || height !== size) { await sleep(20); continue; } // resize still settling
      if (!px || px.length !== size * size) px = new Uint16Array(size * size);

      const payload = q565.encode(q565.bgraToRgb565(latest.toBitmap(), size, k.orientation, px), size, size);
      try {
        await k.sendFrame(payload);
        sentSeq = seq;
        lastSentAt = Date.now();
        state.sentWindow.push(lastSentAt);
        framesThisConnection++;
        rejectedConnections = 0;
        retryMs = RETRY_MS;
      } catch (e) {
        if (kraken !== k) continue; // already dropped on purpose (CAM started, sleep, quitting)
        const model = k.model;
        const neverTookAFrame = framesThisConnection === 0 && !model.tested;
        await disconnect(`frame failed: ${e.message}`);
        if (neverTookAFrame && ++rejectedConnections >= 3) {
          // Best-effort model that doesn't understand CAM's live frames: say so, and stop hammering it.
          setStatus(`Your ${model.name} didn't accept live frames — this model isn't supported yet`);
          log(`${model.name}: no frame accepted after ${rejectedConnections} tries; now retrying once a minute`);
          retryMs = 60000;
          await sleep(retryMs);
        } else {
          await sleep(1000);
        }
      }
    }
  }

  // ---------- sensors -> page (same hook CAM uses) ----------

  async function sensorLoop() {
    while (!quitting) {
      const cutoff = Date.now() - 2000;
      state.sentWindow = state.sentWindow.filter((t) => t > cutoff);
      state.fps = state.sentWindow.length / 2;

      if (kraken) {
        try { state.liquid = await kraken.readLiquid(); } catch (e) { /* next round */ }
        // If CAM gets started while we're streaming, step aside instead of fighting over the screen.
        if (Date.now() - (state.lastCamCheck || 0) > 5000) {
          state.lastCamCheck = Date.now();
          if (await camRunning()) {
            await disconnect('NZXT CAM started');
            setStatus('NZXT CAM is running — close it to use Kraken Host');
          }
        }
      }
      const data = sensors ? sensors.monitoringData(state.liquid) : { cpus: [{}], gpus: [{}] };
      if (win && !win.isDestroyed()) {
        const js = `window.nzxt && window.nzxt.v1 && window.nzxt.v1.onMonitoringDataUpdate(${JSON.stringify(data)})`;
        win.webContents.executeJavaScript(js, true).catch(() => {});
      }
      updateTray();
      if (Date.now() - (state.lastStatsLog || 0) > 10000) {
        state.lastStatsLog = Date.now();
        const r = (sensors && sensors.latest) || {};
        if (kraken) log(`${state.fps.toFixed(1)} fps | liquid ${state.liquid} | cpu ${JSON.stringify(r.cpu)} | gpu ${JSON.stringify(r.gpu)}`);
      }
      await sleep(SENSOR_MS);
    }
  }

  // ---------- off-screen page ----------

  function createWindow() {
    win = new BrowserWindow({
      show: false,
      width: DEFAULT_SIZE,
      height: DEFAULT_SIZE,
      useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true },
    });
    win.webContents.setFrameRate(FPS);
    win.webContents.setAudioMuted(true); // the cooler has no speakers
    win.webContents.on('paint', (e, dirty, image) => { latest = image; latestSeq++; });
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') log(`page ${e.level}: ${e.message}`);
    });
    win.webContents.on('render-process-gone', (e, details) => {
      log(`page crashed (${details.reason}), reloading`);
      setTimeout(() => { if (!quitting) win.reload(); }, 1000);
    });
    win.loadFile(PAGE, { query: { kraken: '1' } });
  }

  // ---------- tray ----------

  function updateTray() {
    if (!tray) return;
    const deg = (v) => (v == null ? '–' : `${Math.round(v)}°`);
    const s = (sensors && sensors.latest) || {};
    const temps = `CPU ${deg(s.cpu && s.cpu.temp)} · GPU ${deg(s.gpu && s.gpu.temp)} · liquid ${deg(state.liquid)}`;
    tray.setToolTip(`Kraken Host — ${state.status}\n${temps}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: state.status, enabled: false },
      { label: `${state.fps.toFixed(0)} fps · ${temps}`, enabled: false },
      { type: 'separator' },
      // Via Explorer, so the browser opens as the normal user even though this app runs elevated.
      { label: 'Open editor', click: () => execFile('explorer.exe', [EDITOR], { windowsHide: true }, () => {}) },
      { label: 'Reload display', click: () => win && win.reload() },
      { label: 'Open log', click: () => shell.openPath(logFile) },
      { type: 'separator' },
      { label: 'Quit', click: () => quit() },
    ]));
  }

  async function quit() {
    quitting = true;
    if (sensors) sensors.stop();
    await disconnect('quitting');
    app.exit(0);
  }

  // ---------- start ----------

  app.whenReady().then(() => {
    log(`Kraken Host starting, page ${PAGE}`);
    if (!fs.existsSync(PAGE)) log('WARNING: index.html not found next to the app folder');
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')));
    sensors = new Sensors(log);
    sensors.start();
    updateTray();
    createWindow();

    // The cooler resets across sleep; drop the connection and let the loop reconnect.
    powerMonitor.on('suspend', () => disconnect('system suspend'));
    powerMonitor.on('resume', () => disconnect('system resume'));

    streamLoop();
    sensorLoop();

    // Debug aid: KRAKEN_HOST_SNAPSHOT=<file.png> saves what is being rendered, every 5 s.
    const snap = process.env.KRAKEN_HOST_SNAPSHOT;
    if (snap) {
      let paints = 0;
      win.webContents.on('paint', () => { paints++; });
      setInterval(() => {
        if (!latest) return;
        fs.writeFileSync(snap, latest.toPNG());
        const { width, height } = latest.getSize();
        log(`snapshot ${width}x${height}, ${paints / 5} paints/s`);
        paints = 0;
      }, 5000);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
  app.on('second-instance', () => updateTray());
}
