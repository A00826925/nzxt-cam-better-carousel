/*
 * Kraken Carousel — shared stage renderer.
 * Used by the cooler display (index.html) and the editor preview (editor.html).
 * Classic script (no ES modules) so it works from file:// URLs inside NZXT CAM.
 */
(function (global) {
  "use strict";

  var SIZE = 640; // design resolution; the stage is scaled to fit smaller screens
  var VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;
  var MEDIA_RE = /\.(mp4|webm|mov|m4v|ogv|gif|jpe?g|png|webp|avif|bmp|svg)$/i;

  var OVERLAYS = ["none", "temps", "clock", "digital"];
  var DEFAULT_DIM = { none: 0, temps: 20, clock: 40, digital: 35 };

  var DEFAULT_SETTINGS = {
    title: "NZXT",
    leftSensor: "cpu",
    rightSensor: "gpu",
    tempUnit: "C",
    hour24: true,
    showDate: true,
    clockSweep: false,
    clockTemps: true,
    textColor: "#ffffff",
    handColor: "#ffffff",
    accentColor: "#ff2d2d",
    transitionMs: 600,
    defaultDuration: 60,
    muteVideos: true
  };

  var SENSORS = {
    cpu: { label: "CPU", unit: "temp" },
    gpu: { label: "GPU", unit: "temp" },
    liquid: { label: "LIQUID", unit: "temp" },
    cpuLoad: { label: "CPU", unit: "load" },
    gpuLoad: { label: "GPU", unit: "load" }
  };

  var FOCUS_WORDS = {
    center: [50, 50], top: [50, 0], bottom: [50, 100], left: [0, 50], right: [100, 50],
    "top-left": [0, 0], "top-right": [100, 0], "bottom-left": [0, 100], "bottom-right": [100, 100]
  };

  // ---------- model helpers ----------

  function isVideo(src) { return VIDEO_RE.test(src || ""); }
  function isMedia(name) { return MEDIA_RE.test(name || ""); }

  function num(v, fallback) {
    v = Number(v);
    return isFinite(v) ? v : fallback;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function withDefaults(settings) {
    var out = {};
    for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    if (settings) for (var j in settings) if (settings[j] !== undefined) out[j] = settings[j];
    return out;
  }

  /** Fill in missing fields so every consumer can rely on them. */
  function normalizeItem(raw, settings) {
    var it = {};
    for (var k in raw) it[k] = raw[k];
    it.src = String(raw.src || "");
    it.overlay = OVERLAYS.indexOf(raw.overlay) >= 0 ? raw.overlay : "none";
    it.dim = clamp(num(raw.dim, DEFAULT_DIM[it.overlay]), 0, 100);
    it.zoom = clamp(num(raw.zoom, 100), 25, 1000);
    it.x = clamp(num(raw.x, 50), 0, 100);
    it.y = clamp(num(raw.y, 50), 0, 100);
    it.fit = raw.fit === "contain" ? "contain" : "cover";
    it.enabled = raw.enabled !== false;
    it.nsfw = raw.nsfw === true;
    if (isVideo(it.src)) it.plays = Math.max(1, Math.round(num(raw.plays, 1)));
    else it.duration = Math.max(1, num(raw.duration, (settings && settings.defaultDuration) || DEFAULT_SETTINGS.defaultDuration));
    return it;
  }

  function parseFocus(focus) {
    var f = String(focus || "center").trim().toLowerCase();
    if (FOCUS_WORDS[f]) return FOCUS_WORDS[f].slice();
    var words = f.split(/\s+/).join("-");
    if (FOCUS_WORDS[words]) return FOCUS_WORDS[words].slice();
    var m = f.match(/(-?[\d.]+)%\s+(-?[\d.]+)%/);
    if (m) return [clamp(+m[1], 0, 100), clamp(+m[2], 0, 100)];
    return [50, 50];
  }

  /** Convert the original script.js `mediaFiles` array into v2 items. */
  function migrateLegacy(list) {
    return (list || []).map(function (m) {
      var focus = parseFocus(m.focus);
      var overlay = m.overlayStyle === "dualTemps" ? "temps" : m.overlayStyle === "clock" ? "clock" : "none";
      var plays = Math.max(1, Math.round(num(m.loop, 0)) || 1);
      var item = { src: m.src, overlay: overlay, dim: DEFAULT_DIM[overlay], zoom: num(m.zoom, 100), x: focus[0], y: focus[1] };
      if (m.type === "video" || isVideo(m.src)) item.plays = plays;
      else item.duration = (num(m.duration, 10000) / 1000) * plays; // old code re-showed the image `loop` times
      return item;
    });
  }

  /** Encode each path segment so names with spaces / # / ? still load. */
  function encodePath(src) {
    if (/^(blob:|data:|https?:|file:)/i.test(src)) return src;
    return src.split("/").map(encodeURIComponent).join("/");
  }

  // ---------- monitoring data ----------

  /** Flatten NZXT's onMonitoringDataUpdate payload into { cpu, gpu, liquid, cpuLoad, gpuLoad }. */
  function readMonitoring(data) {
    var cpu = data && data.cpus && data.cpus[0];
    var gpu = data && data.gpus && data.gpus[0];
    var kraken = data && data.kraken;
    function t(v) { v = Number(v); return isFinite(v) ? Math.abs(v) : null; }
    function l(v) { v = Number(v); return isFinite(v) ? v * (v <= 1 ? 100 : 1) : null; }
    return {
      cpu: cpu ? t(cpu.temperature) : null,
      gpu: gpu ? t(gpu.temperature) : null,
      liquid: kraken ? t(kraken.liquidTemperature) : null,
      cpuLoad: cpu ? l(cpu.load) : null,
      gpuLoad: gpu ? l(gpu.load) : null
    };
  }

  function formatSensor(key, values, unit) {
    var def = SENSORS[key] || SENSORS.cpu;
    var v = values ? values[key] : null;
    if (v == null) return def.unit === "load" ? "–%" : "–°";
    if (def.unit === "load") return Math.round(v) + "%";
    if (unit === "F") v = v * 9 / 5 + 32;
    return Math.round(v) + "°";
  }

  // ---------- DOM ----------

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  var DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  /**
   * Build a stage inside `container`.
   * options.resolve(src) -> URL   (lets the editor swap in blob: URLs)
   */
  function create(container, settings, options) {
    options = options || {};
    var resolve = options.resolve || encodePath;
    var s = withDefaults(settings);
    var values = null;
    var overlay = "none";
    var tickTimer = 0;
    var angles = null; // current [second, minute, hour] hand angles; null = clock hidden

    var root = h("div", "ks-stage");
    var media = h("div", "ks-media");
    var dim = h("div", "ks-dim");

    // Temps overlay
    var temps = h("div", "ks-ov ks-temps");
    var title = h("div", "ks-title ks-txt");
    var row = h("div", "ks-row ks-txt");
    var slots = [0, 1].map(function () {
      var box = h("div", "ks-sensor");
      var val = h("div", "ks-val", "--°");
      var label = h("div", "ks-label");
      box.appendChild(val);
      box.appendChild(label);
      row.appendChild(box);
      return { val: val, label: label };
    });
    temps.appendChild(title);
    temps.appendChild(row);

    /** A small "CPU 47°  GPU 58°" row, used under both clock faces. */
    var miniRows = [];
    function makeMini(cls) {
      var el = h("div", "ks-mini ks-txt" + (cls ? " " + cls : ""));
      miniRows.push([0, 1].map(function () {
        var span = h("span");
        var label = h("i");
        var val = h("b");
        span.appendChild(label);
        span.appendChild(val);
        el.appendChild(span);
        return { val: val, label: label };
      }));
      return el;
    }

    // Analog clock overlay
    var clock = h("div", "ks-ov ks-clock");
    for (var i = 0; i < 12; i++) {
      var mark = h("div", "ks-mark");
      var a = i * 30 * Math.PI / 180;
      mark.style.left = (320 + 240 * Math.cos(a)) + "px";
      mark.style.top = (320 + 240 * Math.sin(a)) + "px";
      clock.appendChild(mark);
    }
    var hourHand = h("div", "ks-hand ks-hour");
    var minHand = h("div", "ks-hand ks-min");
    var secHand = h("div", "ks-hand ks-sec");
    clock.appendChild(hourHand);
    clock.appendChild(minHand);
    clock.appendChild(secHand);
    clock.appendChild(h("div", "ks-cap"));
    var clockMini = makeMini("ks-clock-mini"); // sensor readout below the hands
    clock.appendChild(clockMini);

    // Digital clock overlay
    var digital = h("div", "ks-ov ks-digital");
    var dTime = h("div", "ks-time ks-txt");
    var dTimeMain = h("span");
    var dAmPm = h("span", "ks-ampm");
    dTime.appendChild(dTimeMain);
    dTime.appendChild(dAmPm);
    var dDate = h("div", "ks-date ks-txt");
    var dMini = makeMini();
    digital.appendChild(dTime);
    digital.appendChild(dDate);
    digital.appendChild(dMini);

    var layers = { temps: temps, clock: clock, digital: digital };
    root.appendChild(media);
    root.appendChild(dim);
    root.appendChild(temps);
    root.appendChild(clock);
    root.appendChild(digital);
    container.appendChild(root);

    function renderSensors() {
      var keys = [s.leftSensor, s.rightSensor];
      for (var i = 0; i < 2; i++) {
        var key = SENSORS[keys[i]] ? keys[i] : (i ? "gpu" : "cpu");
        var text = formatSensor(key, values, s.tempUnit);
        setText(slots[i].val, text);
        slots[i].val.classList.toggle("ks-long", text.length > 3);
        setText(slots[i].label, SENSORS[key].label);
        for (var r = 0; r < miniRows.length; r++) {
          setText(miniRows[r][i].val, text);
          setText(miniRows[r][i].label, SENSORS[key].label + " ");
        }
      }
    }

    function renderTime() {
      var now = new Date();
      var hr = now.getHours(), mn = now.getMinutes(), sc = now.getSeconds();

      if (overlay === "clock") {
        // First frame after the clock appears: place the hands without animating.
        clock.classList.toggle("ks-snap", !angles);
        var prev = angles || [0, 0, 0];
        angles = [
          turn(prev[0], ((s.clockSweep ? sc + 1 : sc) % 60) * 6),
          turn(prev[1], mn * 6 + sc / 10),
          turn(prev[2], (hr % 12) * 30 + mn / 2 + sc / 120)
        ];
        secHand.style.transform = "rotate(" + (angles[0] - 90) + "deg)";
        minHand.style.transform = "rotate(" + (angles[1] - 90) + "deg)";
        hourHand.style.transform = "rotate(" + (angles[2] - 90) + "deg)";
      } else if (overlay === "digital") {
        var shown = s.hour24 ? hr : (hr % 12 || 12);
        setText(dTimeMain, (s.hour24 && shown < 10 ? "0" : "") + shown + ":" + (mn < 10 ? "0" : "") + mn);
        setText(dAmPm, s.hour24 ? "" : (hr < 12 ? "AM" : "PM"));
        setText(dDate, DAYS[now.getDay()] + " " + now.getDate() + " " + MONTHS[now.getMonth()]);
      }
    }

    /** Rotate forward from `from` to the angle `target` (mod 360) so hands never spin backwards through 12. */
    function turn(from, target) {
      var d = (((target - from) % 360) + 360) % 360;
      return from + (d > 180 ? d - 360 : d);
    }

    // One timer, aligned to the second, only running while a clock is visible.
    function tick() {
      renderTime();
      tickTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    }
    function syncTicker() {
      var need = overlay === "clock" || overlay === "digital";
      if (need && !tickTimer) tick();
      if (!need && tickTimer) { clearTimeout(tickTimer); tickTimer = 0; }
    }

    function applySettings(next) {
      s = withDefaults(next);
      root.style.setProperty("--ks-text", s.textColor);
      root.style.setProperty("--ks-hand", s.handColor);
      root.style.setProperty("--ks-accent", s.accentColor);
      root.style.setProperty("--ks-fade", Math.max(0, num(s.transitionMs, 600)) + "ms");
      root.classList.toggle("ks-sweep", !!s.clockSweep);
      setText(title, s.title || "");
      title.style.display = s.title ? "" : "none";
      dDate.style.display = s.showDate ? "" : "none";
      clockMini.style.display = s.clockTemps === false ? "none" : "";
      renderSensors();
      renderTime();
    }

    /** Show one overlay; `color` optionally overrides the text colour for this item. */
    function setOverlay(type, dimPercent, color) {
      overlay = layers[type] ? type : "none";
      for (var k in layers) layers[k].classList.toggle("ks-on", k === overlay);
      dim.style.opacity = clamp(num(dimPercent, DEFAULT_DIM[overlay]), 0, 100) / 100;
      root.style.setProperty("--ks-text", color || s.textColor);
      if (overlay !== "clock") angles = null;
      renderTime();
      syncTicker();
    }

    function setData(data) {
      values = data && data.cpus ? readMonitoring(data) : data;
      renderSensors();
    }

    function frame(el, item) {
      var x = clamp(num(item.x, 50), 0, 100), y = clamp(num(item.y, 50), 0, 100);
      var z = num(item.zoom, 100) / 100;
      el.style.objectFit = item.fit === "contain" ? "contain" : "cover";
      el.style.objectPosition = x + "% " + y + "%";
      el.style.transformOrigin = x + "% " + y + "%";
      el.style.transform = z !== 1 ? "scale(" + z + ")" : "";
    }

    /** Create (but do not attach) the element for an item. */
    function createMedia(item) {
      var el;
      if (isVideo(item.src)) {
        el = document.createElement("video");
        el.muted = s.muteVideos !== false;
        el.playsInline = true;
        el.preload = "auto";
        el.disablePictureInPicture = true;
      } else {
        el = document.createElement("img");
        el.decoding = "async";
        el.alt = "";
      }
      el.src = resolve(item.src);
      frame(el, item);
      return el;
    }

    function disposeMedia(el) {
      if (!el) return;
      if (el.tagName === "VIDEO") {
        el.pause();
        el.removeAttribute("src");
        el.load(); // releases the decoder
      }
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    function fit(box) {
      var w = box ? box.clientWidth : window.innerWidth;
      var ht = box ? box.clientHeight : window.innerHeight;
      var scale = Math.min(w, ht) / SIZE;
      root.style.transform = "translate(" + (w - SIZE * scale) / 2 + "px," + (ht - SIZE * scale) / 2 + "px) scale(" + scale + ")";
      return scale;
    }

    function destroy() {
      clearTimeout(tickTimer);
      tickTimer = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    applySettings(s);

    return {
      el: root,
      media: media,
      get settings() { return s; },
      applySettings: applySettings,
      setOverlay: setOverlay,
      setData: setData,
      frame: frame,
      createMedia: createMedia,
      disposeMedia: disposeMedia,
      fit: fit,
      destroy: destroy
    };
  }

  global.KrakenStage = {
    SIZE: SIZE,
    OVERLAYS: OVERLAYS,
    DEFAULT_DIM: DEFAULT_DIM,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    SENSORS: SENSORS,
    isVideo: isVideo,
    isMedia: isMedia,
    withDefaults: withDefaults,
    normalizeItem: normalizeItem,
    migrateLegacy: migrateLegacy,
    parseFocus: parseFocus,
    encodePath: encodePath,
    readMonitoring: readMonitoring,
    create: create
  };
})(typeof window !== "undefined" ? window : globalThis);
