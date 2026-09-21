/*
 * Kraken Carousel — editor.
 *
 * Open editor.html in Chrome or Edge. "Connect folder" grants the page access to the carousel
 * folder (File System Access API) so it can copy new media into media/ and write config.js.
 * Without it (e.g. Firefox) you can still edit and then download config.js.
 */
(function () {
  "use strict";

  var KS = window.KrakenStage;
  var FSA = typeof window.showDirectoryPicker === "function";
  var SAMPLE = { cpu: 47, gpu: 58, liquid: 31, cpuLoad: 23, gpuLoad: 41 };
  var ITEM_KEYS = ["src", "duration", "plays", "overlay", "dim", "zoom", "x", "y", "fit", "color", "enabled", "nsfw"];
  var PREFS_KEY = "kraken-carousel-editor";

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fileName(src) { return decodeURIComponent(String(src).split("/").pop()); }
  function kindOf(src) { return KS.isVideo(src) ? "VIDEO" : /\.gif$/i.test(src) ? "GIF" : "IMAGE"; }
  function round(n, d) { var k = Math.pow(10, d || 0); return Math.round(n * k) / k; }

  function fmtDur(sec) {
    if (!isFinite(sec)) return "?";
    sec = Math.round(sec);
    if (sec < 60) return sec + "s";
    var m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + ":" + (s < 10 ? "0" : "") + s;
    return Math.floor(m / 60) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60) + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtLong(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return m + " min";
    return Math.floor(m / 60) + " h " + (m % 60) + " min";
  }

  var prefs = (function () {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  })();
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  // ======================================================================
  // State, serialization, history
  // ======================================================================

  var uid = 0;
  function newId() { return "i" + (++uid); }

  var state = { settings: KS.withDefaults(), items: [] };
  var selected = new Set();
  var primaryId = null;
  var anchorId = null;

  function makeItem(raw) {
    var it = KS.normalizeItem(raw, state.settings);
    it.id = newId();
    return it;
  }

  function loadConfig(cfg) {
    state.settings = KS.withDefaults(cfg && cfg.settings);
    state.items = ((cfg && cfg.items) || []).map(function (raw) {
      var it = KS.normalizeItem(raw, state.settings);
      it.id = newId();
      return it;
    });
    selected = new Set();
    primaryId = anchorId = state.items.length ? state.items[0].id : null;
    if (primaryId) selected.add(primaryId);
  }

  function cleanItem(it) {
    var out = {};
    ITEM_KEYS.forEach(function (k) {
      var v = it[k];
      if (v === undefined || v === null || v === "") return;
      if (k === "fit" && v === "cover") return;
      if (k === "enabled" && v !== false) return;
      if (k === "nsfw" && v !== true) return;
      if (k === "duration" && KS.isVideo(it.src)) return;
      if (k === "plays" && !KS.isVideo(it.src)) return;
      out[k] = typeof v === "number" ? round(v, 2) : v;
    });
    return out;
  }

  /** config.js text. Items are one per line so diffs stay readable. */
  function serialize(s) {
    return "// Kraken Carousel playlist. Edit it with editor.html (or by hand — it must stay valid JSON).\n" +
      "window.CAROUSEL_CONFIG = {\n" +
      '  "version": 2,\n' +
      '  "settings": ' + JSON.stringify(s.settings, null, 2).replace(/\n/g, "\n  ") + ",\n" +
      '  "items": [\n' +
      s.items.map(function (it) { return "    " + JSON.stringify(cleanItem(it)); }).join(",\n") +
      "\n  ]\n};\n";
  }

  function normalizedText(cfg) {
    var settings = KS.withDefaults(cfg.settings);
    return serialize({
      settings: settings,
      items: (cfg.items || []).map(function (it) { return KS.normalizeItem(it, settings); })
    });
  }

  function parseConfig(text) {
    var a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* fall through: maybe hand-edited JS */ }
    }
    try {
      var w = {};
      new Function("window", text)(w);
      return w.CAROUSEL_CONFIG || null;
    } catch (e) {
      return null;
    }
  }

  function parseLegacy(text) {
    var m = text.match(/mediaFiles\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return null;
    try { return KS.migrateLegacy(new Function("return " + m[1])()); } catch (e) { return null; }
  }

  var savedText = null; // what's on disk (normalized); null = never saved
  function isDirty() { return savedText === null || serialize(state) !== savedText; }

  var undoStack = [], redoStack = [], lastSnap = null;
  function snapshot() {
    return JSON.stringify({ settings: state.settings, items: state.items, sel: Array.from(selected), primary: primaryId });
  }
  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnap = snapshot();
  }
  function commit() {
    var snap = snapshot();
    if (snap !== lastSnap && lastSnap) {
      // Selection-only changes aren't worth an undo step.
      var a = JSON.parse(snap), b = JSON.parse(lastSnap);
      if (JSON.stringify([a.settings, a.items]) !== JSON.stringify([b.settings, b.items])) {
        undoStack.push(lastSnap);
        if (undoStack.length > 200) undoStack.shift();
        redoStack = [];
      }
    }
    lastSnap = snap;
    renderAll();
  }
  function restore(snap) {
    var s = JSON.parse(snap);
    state.settings = s.settings;
    state.items = s.items;
    var ids = new Set(state.items.map(function (i) { return i.id; }));
    // Keep the current selection where possible; otherwise fall back to the snapshot's.
    var keep = Array.from(selected).filter(function (id) { return ids.has(id); });
    selected = new Set(keep.length ? keep : s.sel.filter(function (id) { return ids.has(id); }));
    if (!ids.has(primaryId) || !selected.has(primaryId)) {
      primaryId = ids.has(s.primary) && selected.has(s.primary) ? s.primary : (selected.size ? Array.from(selected)[0] : null);
    }
    lastSnap = snap;
    stopPlay();
    renderAll();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(lastSnap);
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(lastSnap);
    restore(redoStack.pop());
  }

  function getItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }
  function indexOfId(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return i;
    return -1;
  }
  function selectedItems() {
    return state.items.filter(function (it) { return selected.has(it.id); });
  }

  // ======================================================================
  // Media URLs, thumbnails & file info
  // ======================================================================

  var tempURLs = new Map();     // src -> object URL for files added before a folder was connected
  var pendingFiles = new Map(); // src -> File waiting to be copied into media/
  var fileURLs = new Map();     // src -> blob URL read from the connected folder
  var folderFiles = new Map();  // src -> { size } of media files found in the folder

  function resolveSrc(src) {
    return tempURLs.get(src) || fileURLs.get(src) || KS.encodePath(src);
  }

  var info = new Map(); // src -> { status: loading|ok|error, thumb, w, h, duration }
  var probeQueue = [];
  var probing = 0;
  var probeReady = false; // wait until we know whether a folder is connected (blob vs relative URLs)

  function requestInfo(src) {
    var rec = info.get(src);
    if (rec) return rec;
    rec = { status: "loading" };
    info.set(src, rec);
    probeQueue.push(src);
    pumpProbes();
    return rec;
  }

  function resetInfo() {
    info.clear();
    probeQueue = [];
  }

  function pumpProbes() {
    while (probeReady && probing < 3 && probeQueue.length) {
      var src = probeQueue.shift();
      var rec = info.get(src);
      if (!rec) continue;
      probing++;
      (function (src, rec) {
        Promise.all([probe(src), videoIsHevc(src)]).then(function (both) {
          var res = both[0];
          res.hevc = both[1];
          probing--;
          if (info.get(src) === rec) {
            Object.assign(rec, res);
            onInfo(src);
          }
          pumpProbes();
        });
      })(src, rec);
    }
  }

  function coverCanvas(source, w, h) {
    if (!w || !h) return null;
    var S = 112, c = document.createElement("canvas");
    c.width = c.height = S;
    var k = Math.max(S / w, S / h);
    try { c.getContext("2d").drawImage(source, (S - w * k) / 2, (S - h * k) / 2, w * k, h * k); } catch (e) { return null; }
    return c;
  }

  function probe(src) {
    var url = resolveSrc(src);
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { finish({ status: "error" }); }, 30000);
      function finish(r) {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(r);
      }
      if (KS.isVideo(src)) {
        var v = document.createElement("video");
        v.muted = true;
        v.preload = "metadata";
        v.onloadedmetadata = function () { v.currentTime = Math.max(0.05, Math.min(1, (v.duration || 0) * 0.1)); };
        v.onseeked = function () {
          var r = { status: "ok", w: v.videoWidth, h: v.videoHeight, duration: v.duration, thumb: coverCanvas(v, v.videoWidth, v.videoHeight) };
          v.removeAttribute("src");
          v.load();
          finish(r);
        };
        v.onerror = function () { finish({ status: "error" }); };
        v.src = url;
      } else {
        var img = new Image();
        img.decoding = "async";
        img.onload = function () {
          finish({ status: "ok", w: img.naturalWidth, h: img.naturalHeight, thumb: coverCanvas(img, img.naturalWidth, img.naturalHeight) });
        };
        img.onerror = function () { finish({ status: "error" }); };
        img.src = url;
      }
    });
  }

  // ---------- codec check ----------
  // CAM's cooler page (Electron/Chromium) can only play HEVC with GPU decoding, which it does not
  // get, so HEVC clips are silently skipped on the cooler even though Chrome/Edge play them fine.
  // Spot them from the sample-entry tag in the file's moov box — no decoding needed.

  function hasFourcc(bytes, code) {
    var a = code.charCodeAt(0), b = code.charCodeAt(1), c = code.charCodeAt(2), d = code.charCodeAt(3);
    for (var i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) return true;
    }
    return false;
  }

  /** True when an MP4/MOV file holds HEVC video. Walks the top-level boxes to find moov. */
  async function isHevcFile(file) {
    if (!file || !/\.(mp4|m4v|mov)$/i.test(file.name || "")) return false;
    try {
      var pos = 0, size = file.size;
      while (pos + 8 <= size) {
        var head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
        var len = head.getUint32(0);
        var type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
        if (len === 1 && head.byteLength >= 16) len = head.getUint32(8) * 4294967296 + head.getUint32(12); // 64-bit size
        else if (len === 0) len = size - pos; // box runs to the end of the file
        if (type === "moov") {
          var moov = new Uint8Array(await file.slice(pos, pos + Math.min(len, 8 << 20)).arrayBuffer());
          return hasFourcc(moov, "hvc1") || hasFourcc(moov, "hev1");
        }
        if (len < 8) return false; // not a box structure we understand
        pos += len;
      }
    } catch (e) { /* unreadable: say nothing rather than guess */ }
    return false;
  }

  /** Needs the actual file: from the connected folder, or one added but not copied yet. */
  function videoIsHevc(src) {
    if (!KS.isVideo(src)) return Promise.resolve(false);
    if (pendingFiles.has(src)) return isHevcFile(pendingFiles.get(src));
    if (!rootDir) return Promise.resolve(false);
    return fileAt(src).then(isHevcFile, function () { return false; });
  }

  function paintThumb(canvas, src) {
    var rec = requestInfo(src);
    var g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (rec.thumb) g.drawImage(rec.thumb, 0, 0, canvas.width, canvas.height);
  }

  function onInfo(src) {
    state.items.forEach(function (it) { if (it.src === src) updateRow(it.id); });
    $$('.tile[data-src="' + cssEscape(src) + '"] canvas').forEach(function (c) { paintThumb(c, src); });
    renderSummary();
    var p = getItem(primaryId);
    if (p && p.src === src) { refreshInspector(); updatePreviewMsg(); }
  }

  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }

  // ======================================================================
  // Playlist rendering
  // ======================================================================

  var ICONS = {
    grip: '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>',
    eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24"><path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>'
  };
  var OVERLAY_NAMES = { none: "No overlay", temps: "Temps", clock: "Clock", digital: "Digital", quad: "Quad" };

  var list = $("#list");
  var dropLine = document.createElement("li");
  dropLine.className = "drop-line";
  dropLine.setAttribute("aria-hidden", "true");

  function rowTime(it) {
    if (!KS.isVideo(it.src)) return fmtDur(it.duration);
    var rec = info.get(it.src);
    return rec && rec.duration ? fmtDur(rec.duration) + " × " + it.plays : it.plays + "× play";
  }

  function buildRow(it, i) {
    var li = document.createElement("li");
    li.className = "row";
    li.dataset.id = it.id;
    li.draggable = true;
    li.innerHTML =
      '<span class="grip">' + ICONS.grip + "</span>" +
      '<span class="idx"></span>' +
      '<div class="thumb"><canvas width="104" height="104"></canvas><span class="kind"></span></div>' +
      '<div class="meta"><div class="name"></div><div class="sub"><span class="nsfw-tag">NSFW</span><span class="ov"></span><span class="time"></span></div></div>' +
      '<div class="acts">' +
      '<button type="button" data-act="toggle"></button>' +
      '<button type="button" data-act="dup" title="Duplicate">' + ICONS.copy + "</button>" +
      '<button type="button" data-act="del" title="Remove from playlist">' + ICONS.trash + "</button>" +
      "</div>";
    fillRow(li, it, i);
    return li;
  }

  function fillRow(li, it, i) {
    var rec = requestInfo(it.src);
    var missing = rec.status === "error" && !rec.hevc; // an HEVC file exists even if this browser can't decode it
    li.classList.toggle("sel", selected.has(it.id));
    li.classList.toggle("primary", it.id === primaryId && selected.size > 1);
    li.classList.toggle("off", !it.enabled);
    li.classList.toggle("missing", missing);
    li.classList.toggle("playing", it.id === playingId);
    $(".idx", li).textContent = i + 1;
    $(".kind", li).textContent = kindOf(it.src);
    var name = $(".name", li);
    name.textContent = fileName(it.src);
    name.title = it.src;
    $(".nsfw-tag", li).hidden = !it.nsfw;
    var ov = $(".ov", li);
    ov.className = "ov ov-" + it.overlay;
    ov.textContent = OVERLAY_NAMES[it.overlay];
    li.classList.toggle("hevc", !!rec.hevc && !missing);
    var time = $(".time", li);
    time.className = missing ? "time warn" : rec.hevc ? "time codec" : "time";
    time.textContent = missing ? "⚠ file not found" : rec.hevc ? "⚠ HEVC \u2014 won't play on the cooler" : rowTime(it);
    time.title = rec.hevc ? "HEVC (H.265) video: NZXT CAM can't decode it, so the cooler skips it. Re-encode it to H.264 (see README)." : "";
    var toggle = $('[data-act="toggle"]', li);
    toggle.innerHTML = it.enabled ? ICONS.eye : ICONS.eyeOff;
    toggle.title = it.enabled ? "Skip this in the rotation" : "Include in the rotation";
    paintThumb($("canvas", li), it.src);
  }

  function updateRow(id) {
    var li = $('.row[data-id="' + id + '"]', list);
    var i = indexOfId(id);
    if (li && i >= 0) fillRow(li, state.items[i], i);
  }

  function renderList() {
    var frag = document.createDocumentFragment();
    state.items.forEach(function (it, i) { frag.appendChild(buildRow(it, i)); });
    list.textContent = "";
    list.appendChild(frag);
    list.appendChild(dropLine);
    if (!state.items.length) {
      list.insertAdjacentHTML("afterbegin", '<li class="list-empty">No media yet.<br>Click <b>Add media</b> or drop files here.</li>');
    }
    renderSummary();
    renderUnused();
  }

  function renderSummary() {
    var on = state.items.filter(function (i) { return i.enabled; });
    var total = 0, unknown = false;
    on.forEach(function (it) {
      if (!KS.isVideo(it.src)) { total += it.duration; return; }
      var rec = info.get(it.src);
      if (rec && rec.duration) total += rec.duration * it.plays;
      else unknown = true;
    });
    var parts = [state.items.length + " item" + (state.items.length === 1 ? "" : "s")];
    if (on.length !== state.items.length) parts.push(on.length + " in rotation");
    if (on.length) parts.push("loop ≈ " + fmtLong(total) + (unknown ? "+" : ""));
    var nsfw = on.filter(function (i) { return i.nsfw; }).length;
    if (nsfw) parts.push(nsfw + " NSFW" + (coolerNsfw ? "" : " (hidden)"));
    $("#summary").textContent = parts.join(" · ");
  }

  function renderUnused() {
    var box = $("#unused");
    if (!rootDir) { box.hidden = true; return; }
    var used = new Set(state.items.map(function (i) { return i.src; }));
    var files = Array.from(folderFiles.keys()).filter(function (s) { return !used.has(s); }).sort();
    box.hidden = !files.length;
    $("#unusedCount").textContent = files.length;
    var grid = $("#unusedGrid");
    grid.textContent = "";
    files.forEach(function (src) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tile";
      b.dataset.src = src;
      b.title = "Add " + fileName(src) + " to the playlist";
      b.innerHTML = '<div class="thumb"><canvas width="96" height="96"></canvas></div><span></span>';
      $("span", b).textContent = fileName(src);
      grid.appendChild(b);
      paintThumb($("canvas", b), src);
    });
  }

  // ======================================================================
  // Selection & item operations
  // ======================================================================

  function selectId(id, e) {
    stopPlay();
    if (e && (e.ctrlKey || e.metaKey)) {
      if (selected.has(id) && selected.size > 1) selected.delete(id);
      else selected.add(id);
      primaryId = selected.has(id) ? id : Array.from(selected).pop();
      anchorId = id;
    } else if (e && e.shiftKey && anchorId && getItem(anchorId)) {
      var a = indexOfId(anchorId), b = indexOfId(id);
      selected = new Set(state.items.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (i) { return i.id; }));
      primaryId = id;
    } else {
      selected = new Set([id]);
      primaryId = anchorId = id;
    }
    refreshSelection();
  }

  function selectRelative(delta, extend) {
    if (!state.items.length) return;
    var i = primaryId ? indexOfId(primaryId) : -1;
    var next = state.items[clamp(i + delta, 0, state.items.length - 1)];
    selectId(next.id, extend ? { shiftKey: true } : null);
  }

  function refreshSelection() {
    $$(".row", list).forEach(function (r) {
      r.classList.toggle("sel", selected.has(r.dataset.id));
      r.classList.toggle("primary", r.dataset.id === primaryId && selected.size > 1);
    });
    var row = primaryId && $('.row[data-id="' + primaryId + '"]', list);
    if (row) row.scrollIntoView({ block: "nearest" });
    cancelRename();
    refreshInspector();
    renderPreview();
  }

  function insertionPoint() {
    var i = primaryId ? indexOfId(primaryId) : -1;
    return i >= 0 ? i + 1 : state.items.length;
  }

  function insertItems(items, index) {
    if (!items.length) return;
    stopPlay();
    Array.prototype.splice.apply(state.items, [index, 0].concat(items));
    selected = new Set(items.map(function (i) { return i.id; }));
    primaryId = anchorId = items[0].id;
    commit();
  }

  function removeSelected() {
    var ids = new Set(selected);
    if (!ids.size) return;
    stopPlay();
    var first = Math.min.apply(null, Array.from(ids).map(indexOfId));
    state.items = state.items.filter(function (i) { return !ids.has(i.id); });
    var next = state.items[Math.min(first, state.items.length - 1)];
    selected = new Set(next ? [next.id] : []);
    primaryId = anchorId = next ? next.id : null;
    commit();
    toast("Removed " + ids.size + " item" + (ids.size > 1 ? "s" : "") + " (files stay in media/)", "info", { label: "Undo", fn: undo });
  }

  function duplicateSelected() {
    var items = selectedItems();
    if (!items.length) return;
    var copies = items.map(function (it) {
      var c = JSON.parse(JSON.stringify(it));
      c.id = newId();
      return c;
    });
    insertItems(copies, indexOfId(items[items.length - 1].id) + 1);
  }

  function moveIds(ids, index) {
    var set = new Set(ids);
    var before = state.items.slice(0, index).filter(function (i) { return !set.has(i.id); });
    var after = state.items.slice(index).filter(function (i) { return !set.has(i.id); });
    var moving = state.items.filter(function (i) { return set.has(i.id); });
    state.items = before.concat(moving, after);
    commit();
  }

  function moveSelected(delta) {
    var ids = selectedItems().map(function (i) { return i.id; });
    if (!ids.length) return;
    var first = indexOfId(ids[0]), last = indexOfId(ids[ids.length - 1]);
    if (delta < 0 && first > 0) moveIds(ids, first - 1);
    else if (delta > 0 && last < state.items.length - 1) moveIds(ids, last + 2);
  }

  function toggleEnabled(id) {
    var it = getItem(id);
    if (!it) return;
    stopPlay();
    var targets = selected.has(id) ? selectedItems() : [it];
    var value = !it.enabled;
    targets.forEach(function (t) { t.enabled = value; });
    commit();
  }

  // ======================================================================
  // Inspector
  // ======================================================================

  var FIELD_LIMITS = { zoom: [100, 1000], x: [0, 100], y: [0, 100], dim: [0, 100], duration: [1, 86400], plays: [1, 999] };

  function setItemField(field, value) {
    stopPlay();
    var lim = FIELD_LIMITS[field];
    if (lim) {
      value = Number(value);
      if (!isFinite(value)) return;
      value = clamp(value, lim[0], lim[1]);
      if (field === "plays") value = Math.round(value);
    }
    selectedItems().forEach(function (it) {
      if (field === "duration" && KS.isVideo(it.src)) return;
      if (field === "plays" && !KS.isVideo(it.src)) return;
      if (field === "overlay" && it.overlay !== value && it.dim === KS.DEFAULT_DIM[it.overlay]) {
        it.dim = KS.DEFAULT_DIM[value]; // keep the per-overlay default dim unless the user changed it
      }
      it[field] = value;
      updateRow(it.id);
    });
    syncInspectorValues();
    renderPreview();
    renderSummary();
    updateDirty();
  }

  function setSetting(key, value) {
    if (typeof KS.DEFAULT_SETTINGS[key] === "number") {
      value = Number(value);
      if (!isFinite(value)) return;
      value = Math.max(key === "defaultDuration" ? 1 : 0, value);
    }
    state.settings[key] = value;
    stage.applySettings(state.settings);
    renderPreview();
    syncSettings();
    updateDirty();
  }

  function readInput(el) {
    if (el.type === "checkbox") return el.checked;
    return el.value;
  }

  function paintRange(el) {
    if (el.type !== "range") return;
    var min = +el.min, max = +el.max, v = +el.value;
    el.style.setProperty("--p", ((clamp(v, min, max) - min) / (max - min)) * 100 + "%");
  }

  function setControl(el, v) {
    if (el.matches(".seg, .ovgrid")) {
      $$("button", el).forEach(function (b) { b.classList.toggle("on", String(v) === b.dataset.value); });
      return;
    }
    if (el === editingEl && (el.type === "number" || el.type === "text")) return; // don't fight the user's typing
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = typeof v === "number" ? round(v, el.type === "range" ? 1 : 0) : (v == null ? "" : v);
    paintRange(el);
  }

  function refreshInspector() {
    var it = getItem(primaryId);
    var items = selectedItems();
    $("#itemEmpty").hidden = !!it;
    $("#itemPanel").hidden = !it;
    if (!it) { updateNow(); return; }
    var multi = items.length > 1;
    $("#itemPanel").classList.toggle("multi", multi);
    var anyVideo = items.some(function (i) { return KS.isVideo(i.src); });
    var anyImage = items.some(function (i) { return !KS.isVideo(i.src); });
    $('[data-show="video"]').hidden = !anyVideo;
    $('[data-show="image"]').hidden = !anyImage;

    if (multi) {
      $("#itemName").textContent = items.length + " items selected";
      $("#itemPath").textContent = "Changes apply to every selected item";
    } else {
      var rec = requestInfo(it.src);
      var bits = [it.src];
      if (rec.w) bits.push(rec.w + "×" + rec.h);
      if (rec.duration) bits.push(fmtDur(rec.duration));
      if (rec.status === "error" && !rec.hevc) bits.push("file not found");
      if (rec.hevc) bits.push("HEVC \u2014 won't play on the cooler");
      $("#itemName").textContent = fileName(it.src);
      $("#itemPath").textContent = bits.join(" · ");
      $("#itemPath").title = it.src;
    }
    syncInspectorValues();
    updateNow();
  }

  function syncInspectorValues() {
    var it = getItem(primaryId);
    if (!it) return;
    var items = selectedItems();
    $$("[data-item]").forEach(function (el) {
      var f = el.dataset.item;
      var src = it[f] !== undefined ? it : (items.filter(function (i) { return i[f] !== undefined; })[0] || it);
      setControl(el, src[f]);
    });
    var durItem = items.filter(function (i) { return !KS.isVideo(i.src); })[0];
    $$("#durationChips button").forEach(function (b) { b.classList.toggle("on", !!durItem && +b.dataset.duration === durItem.duration); });
    $$("#anchorPad button").forEach(function (b) { b.classList.toggle("on", +b.dataset.x === round(it.x) && +b.dataset.y === round(it.y)); });
    $("#colorCustom").checked = !!it.color;
    $("#colorInput").value = it.color || state.settings.textColor;

    var vid = items.filter(function (i) { return KS.isVideo(i.src); })[0];
    var total = "";
    if (vid && items.length === 1) {
      var rec = info.get(vid.src);
      total = rec && rec.duration ? "Clip is " + fmtDur(rec.duration) + " → on screen for " + fmtDur(rec.duration * vid.plays) : "";
    }
    $("#videoTotal").textContent = total;
    $("#videoTotal").hidden = !total;
  }

  function syncSettings() {
    $$("[data-setting]").forEach(function (el) { setControl(el, state.settings[el.dataset.setting]); });
  }

  var editingEl = null;

  function bindInspector() {
    $$("[data-item]").forEach(function (el) {
      if (el.matches(".seg, .ovgrid")) {
        el.addEventListener("click", function (e) {
          var b = e.target.closest("button[data-value]");
          if (!b) return;
          setItemField(el.dataset.item, b.dataset.value);
          commit();
        });
        return;
      }
      el.addEventListener("input", function () {
        paintRange(el);
        if (el.type === "number" && el.value === "") return;
        editingEl = el;
        setItemField(el.dataset.item, readInput(el));
        editingEl = null;
      });
      el.addEventListener("change", commit);
    });

    $$("[data-setting]").forEach(function (el) {
      var key = el.dataset.setting;
      if (el.matches(".seg")) {
        el.addEventListener("click", function (e) {
          var b = e.target.closest("button[data-value]");
          if (!b) return;
          setSetting(key, el.dataset.type === "bool" ? b.dataset.value === "true" : b.dataset.value);
          commit();
        });
        return;
      }
      el.addEventListener("input", function () {
        paintRange(el);
        if (el.type === "number" && el.value === "") return;
        editingEl = el;
        setSetting(key, readInput(el));
        editingEl = null;
      });
      el.addEventListener("change", commit);
    });

    $("#durationChips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-duration]");
      if (!b) return;
      setItemField("duration", +b.dataset.duration);
      commit();
    });
    $$(".stepper button").forEach(function (b) {
      b.addEventListener("click", function () {
        var it = selectedItems().filter(function (i) { return KS.isVideo(i.src); })[0];
        if (!it) return;
        setItemField("plays", it.plays + +b.dataset.step);
        commit();
      });
    });
    $("#anchorPad").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      setItemField("x", +b.dataset.x);
      setItemField("y", +b.dataset.y);
      commit();
    });
    $("#resetFraming").addEventListener("click", resetFraming);
    $("#colorCustom").addEventListener("change", function () {
      setItemField("color", this.checked ? $("#colorInput").value : null);
      commit();
    });
    $("#colorInput").addEventListener("input", function () {
      $("#colorCustom").checked = true;
      setItemField("color", this.value);
    });
    $("#colorInput").addEventListener("change", commit);
    $("#renameBtn").addEventListener("click", startRename);
    $("#renameOk").addEventListener("click", applyRename);
    $("#renameCancel").addEventListener("click", cancelRename);
    $("#renameInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyRename(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
    });
    $("#dupBtn").addEventListener("click", duplicateSelected);
    $("#delBtn").addEventListener("click", removeSelected);

    $$(".tab").forEach(function (t) {
      t.addEventListener("click", function () { showTab(t.dataset.tab); });
    });
  }

  function showTab(name) {
    $$(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === name); });
    $("#tab-item").hidden = name !== "item";
    $("#tab-display").hidden = name !== "display";
    prefs.tab = name;
    savePrefs();
  }

  function resetFraming() {
    var it = getItem(primaryId);
    if (!it) return;
    it.x = 50;
    it.y = 50;
    it.zoom = 100;
    commit();
  }

  // ======================================================================
  // Preview
  // ======================================================================

  var previewBox = $("#preview");
  var stage = KS.create(previewBox, state.settings, { resolve: resolveSrc });
  stage.setData(SAMPLE);
  var pv = null;         // { el, url } single-item preview
  var player = null;     // playlist preview
  var playingId = null;

  function fitPreview() { stage.fit(previewBox); }
  if (window.ResizeObserver) new ResizeObserver(fitPreview).observe(previewBox);
  else window.addEventListener("resize", fitPreview);

  function clearPreview() {
    if (pv) stage.disposeMedia(pv.el);
    pv = null;
  }

  function renderPreview() {
    if (player) return;
    var it = getItem(primaryId);
    if (!it) {
      clearPreview();
      stage.setOverlay("none", 0);
      updatePreviewMsg();
      return;
    }
    var url = resolveSrc(it.src);
    if (!pv || pv.url !== url) {
      clearPreview();
      var el = stage.createMedia(it);
      if (el.tagName === "VIDEO") {
        el.loop = true;
        el.muted = true;
        el.play().catch(function () {});
      }
      el.classList.add("ks-on");
      stage.media.appendChild(el);
      pv = { el: el, url: url };
    } else {
      stage.frame(pv.el, it);
    }
    stage.setOverlay(it.overlay, it.dim, it.color);
    updatePreviewMsg();
  }

  function updatePreviewMsg() {
    var msg = $("#previewMsg");
    var it = getItem(primaryId);
    if (player) { msg.hidden = true; return; }
    if (!state.items.length) {
      msg.textContent = "Add some media to get started";
      msg.className = "preview-msg";
      msg.hidden = false;
    } else if (!it) {
      msg.textContent = "Select an item to preview it";
      msg.className = "preview-msg";
      msg.hidden = false;
    } else if ((info.get(it.src) || {}).status === "error") {
      msg.textContent = "Can't load " + fileName(it.src) + (rootDir ? " — it isn't in the connected folder." : " — make sure it's in the media folder.");
      msg.className = "preview-msg error";
      msg.hidden = false;
    } else {
      msg.hidden = true;
    }
  }

  function updateNow() {
    var it = player ? getItem(playingId) : getItem(primaryId);
    $("#nowName").textContent = it ? fileName(it.src) : "—";
    var pos = "";
    if (it && player) pos = (player.index + 1) + " / " + player.items.length + " in rotation";
    else if (it) pos = (indexOfId(it.id) + 1) + " / " + state.items.length;
    $("#nowPos").textContent = pos;
  }

  function startPlay() {
    if (!state.items.some(function (i) { return i.enabled; })) {
      toast("Nothing to play — every item is hidden", "warn");
      return;
    }
    clearPreview();
    player = KrakenPlayer(stage, {
      maxItemMs: prefs.quick ? 4000 : 0,
      onChange: function (index, item) {
        var prev = playingId;
        playingId = item.id;
        if (prev) updateRow(prev);
        updateRow(item.id);
        var row = $('.row[data-id="' + item.id + '"]', list);
        if (row) row.scrollIntoView({ block: "nearest" });
        updateNow();
      }
    });
    player.setItems(state.items);
    player.setNsfw(coolerNsfw);
    var start = player.items.indexOf(getItem(primaryId));
    player.start(start >= 0 ? start : 0);
    previewBox.classList.add("playing");
    $("#playBtn").classList.add("on");
    $("#playLabel").textContent = "Stop";
    updatePreviewMsg();
  }

  function stopPlay() {
    if (!player) return;
    player.stop();
    player = null;
    var prev = playingId;
    playingId = null;
    if (prev) updateRow(prev);
    previewBox.classList.remove("playing");
    $("#playBtn").classList.remove("on");
    $("#playLabel").textContent = "Play playlist";
    renderPreview();
    updateNow();
  }

  function bindPreview() {
    var drag = null, wheelTimer = 0;

    previewBox.addEventListener("pointerdown", function (e) {
      if (player || !pv || e.button !== 0 || !getItem(primaryId)) return;
      previewBox.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: false };
      previewBox.classList.add("grabbing");
    });
    previewBox.addEventListener("pointermove", function (e) {
      if (!drag || !pv) return;
      var it = getItem(primaryId), el = pv.el;
      var nw = el.naturalWidth || el.videoWidth, nh = el.naturalHeight || el.videoHeight;
      var k = KS.SIZE / previewBox.clientWidth;
      var dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!it || !nw || !nh) return;
      // With object-position f and transform-origin f, a content point lands at z·u + f·(B − z·C).
      // So moving the picture by d screen pixels needs Δf = d / (B − z·C).
      var B = KS.SIZE;
      var cover = it.fit === "contain" ? Math.min(B / nw, B / nh) : Math.max(B / nw, B / nh);
      var z = it.zoom / 100;
      var denX = B - z * nw * cover, denY = B - z * nh * cover;
      if (Math.abs(denX) > 1) it.x = clamp(it.x + (100 * dx) / denX, 0, 100);
      if (Math.abs(denY) > 1) it.y = clamp(it.y + (100 * dy) / denY, 0, 100);
      drag.moved = true;
      stage.frame(el, it);
      syncInspectorValues();
    });
    function endDrag() {
      if (!drag) return;
      previewBox.classList.remove("grabbing");
      var moved = drag.moved;
      drag = null;
      if (moved) commit();
    }
    previewBox.addEventListener("pointerup", endDrag);
    previewBox.addEventListener("pointercancel", endDrag);

    previewBox.addEventListener("wheel", function (e) {
      var it = getItem(primaryId);
      if (player || !pv || !it) return;
      e.preventDefault();
      it.zoom = clamp(it.zoom * Math.exp(-e.deltaY * 0.0012), 100, 1000);
      stage.frame(pv.el, it);
      syncInspectorValues();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(commit, 350);
    }, { passive: false });

    previewBox.addEventListener("dblclick", function () { if (!player) resetFraming(); });

    $("#playBtn").addEventListener("click", function () { player ? stopPlay() : startPlay(); });
    $("#prevBtn").addEventListener("click", function () { player ? player.prev() : selectRelative(-1); });
    $("#nextBtn").addEventListener("click", function () { player ? player.next() : selectRelative(1); });
    $("#remotePrev").addEventListener("click", function () { sendRemote("prev"); });
    $("#remoteNext").addEventListener("click", function () { sendRemote("next"); });
    $("#remoteShow").addEventListener("click", remoteShowSelected);
    $("#remotePause").addEventListener("click", toggleCoolerPause);
    $("#coolerNsfw").addEventListener("change", function () { setCoolerNsfw(this.checked); });
    syncPauseButton();

    var quick = $("#quickToggle");
    quick.checked = !!prefs.quick;
    quick.addEventListener("change", function () {
      prefs.quick = quick.checked;
      savePrefs();
      if (player) { stopPlay(); startPlay(); }
    });
    var square = $("#squareToggle");
    square.checked = !!prefs.square;
    function applySquare() {
      previewBox.classList.toggle("round", !square.checked);
      $("#previewShell").classList.toggle("square", square.checked);
    }
    square.addEventListener("change", function () {
      prefs.square = square.checked;
      savePrefs();
      applySquare();
    });
    applySquare();
  }

  // ======================================================================
  // Folder access (File System Access API)
  // ======================================================================

  var rootDir = null, mediaDir = null, storedHandle = null;

  var idb = {
    db: null,
    open: function () {
      if (!this.db) {
        this.db = new Promise(function (res, rej) {
          var r = indexedDB.open("kraken-carousel", 1);
          r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { rej(r.error); };
        });
      }
      return this.db;
    },
    get: function (key) {
      return this.open().then(function (db) {
        return new Promise(function (res) {
          var r = db.transaction("kv").objectStore("kv").get(key);
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { res(undefined); };
        });
      });
    },
    set: function (key, value) {
      return this.open().then(function (db) {
        return new Promise(function (res) {
          var tx = db.transaction("kv", "readwrite");
          tx.objectStore("kv").put(value, key);
          tx.oncomplete = function () { res(); };
          tx.onerror = function () { res(); };
        });
      });
    }
  };

  async function readText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
  }
  async function writeFile(dir, name, data) {
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
    return fh;
  }
  async function fileAt(path) {
    try {
      var parts = path.split("/").filter(Boolean), dir = rootDir;
      for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch (e) {
      return null;
    }
  }

  function setFolderUI(mode) {
    var box = $("#folder"), text = $("#folderText"), btn = $("#folderBtn");
    box.dataset.state = mode;
    $("#rescanBtn").hidden = mode !== "connected";
    btn.hidden = false;
    if (mode === "connected") {
      text.textContent = rootDir.name;
      text.title = "Saving writes config.js and copies new media into this folder";
      btn.textContent = "Change";
    } else if (mode === "reconnect") {
      text.textContent = "Reconnect to “" + storedHandle.name + "”";
      text.title = "The browser needs your OK again to edit this folder";
      btn.textContent = "Reconnect";
    } else if (mode === "unsupported") {
      text.textContent = "This browser can't save to folders";
      text.title = "Use Chrome or Edge to save directly; here you can download config.js instead";
      btn.hidden = true;
    } else {
      text.textContent = "Folder not connected";
      text.title = "Connect the carousel folder (the one with index.html) so the editor can save";
      btn.textContent = "Connect folder";
    }
    $("#saveLabel").textContent = mode === "unsupported" ? "Download" : "Save";
    $("#saveBtn").title = mode === "connected" ? "Save config.js to “" + rootDir.name + "” (Ctrl+S)"
      : mode === "unsupported" ? "Download config.js" : "Save (Ctrl+S). The first time, you'll pick the carousel folder to save into.";
    updateDirty();
  }

  async function initFolder() {
    if (!FSA) { setFolderUI("unsupported"); return; }
    try { storedHandle = await idb.get("root"); } catch (e) { storedHandle = null; }
    if (storedHandle) {
      var perm = "denied";
      try { perm = await storedHandle.queryPermission({ mode: "readwrite" }); } catch (e) { /* stale handle */ }
      if (perm === "granted") { await connect(storedHandle, false); return; }
      setFolderUI("reconnect");
      return;
    }
    setFolderUI("none");
  }

  async function pickFolder() {
    var handle;
    try {
      handle = await window.showDirectoryPicker({ id: "kraken-carousel", mode: "readwrite" });
    } catch (e) {
      if (e.name !== "AbortError") toast("Couldn't open that folder: " + e.message, "error");
      return false;
    }
    return connect(handle, true);
  }

  async function reconnect() {
    try {
      if ((await storedHandle.requestPermission({ mode: "readwrite" })) === "granted") return connect(storedHandle, false);
    } catch (e) { /* folder moved or deleted */ }
    toast("Couldn't reopen that folder — pick it again", "warn");
    return pickFolder();
  }

  /** Returns false (cancelled), true (connected), or "loaded" (replaced the playlist from disk). */
  async function connect(handle, fresh) {
    var configText = await readText(handle, "config.js");
    var legacy = null;
    if (configText == null) {
      var legacyText = await readText(handle, "script.js");
      legacy = legacyText && parseLegacy(legacyText);
      if (fresh && !legacy && (await readText(handle, "index.html")) == null) {
        var ok = confirm("“" + handle.name + "” doesn't look like the carousel folder (no config.js or index.html).\n\n" +
          "Use it anyway? Saving will create config.js and a media folder there.");
        if (!ok) return false;
      }
    }

    rootDir = handle;
    storedHandle = handle;
    mediaDir = await handle.getDirectoryHandle("media", { create: true });
    try { await idb.set("root", handle); } catch (e) { /* IndexedDB unavailable: reconnect each visit */ }

    var result = true;
    if (configText != null) {
      var cfg = parseConfig(configText);
      if (!cfg) {
        toast("config.js in that folder couldn't be read — saving will overwrite it (a backup is kept)", "warn");
        savedText = null;
      } else {
        var diskText = normalizedText(cfg);
        // Only a conflict if the folder's playlist differs from the one the editor started from
        // (i.e. a different folder, or the file changed elsewhere). Otherwise just keep the edits.
        if (diskText !== serialize(state) && diskText !== savedText) {
          var take = !isDirty() || confirm("The folder's playlist is different from the one in the editor.\n\n" +
            "OK — load the folder's playlist (your unsaved edits are dropped)\nCancel — keep your edits (Save will overwrite the folder's)");
          if (take) {
            stopPlay();
            loadConfig(cfg);
            resetHistory();
            result = "loaded";
          }
        }
        savedText = diskText;
      }
    } else if (legacy && confirm("This folder has an old-style script.js playlist with " + legacy.length + " items.\n\nImport it into the editor?")) {
      stopPlay();
      loadConfig({ settings: state.settings, items: legacy });
      resetHistory();
      savedText = null;
      result = "loaded";
    } else {
      savedText = null;
    }

    await scanFolder();
    await flushPending();
    resetInfo();
    clearPreview();
    setFolderUI("connected");
    renderAll();
    await readCoolerNsfw();
    toast("Connected to “" + handle.name + "”", "ok");
    return result;
  }

  async function scanFolder() {
    fileURLs.forEach(function (u) { URL.revokeObjectURL(u); });
    fileURLs.clear();
    folderFiles.clear();
    for await (var entry of mediaDir.values()) {
      if (entry.kind !== "file" || !KS.isMedia(entry.name)) continue;
      var f = await entry.getFile();
      var src = "media/" + entry.name;
      folderFiles.set(src, { size: f.size });
      fileURLs.set(src, URL.createObjectURL(f));
    }
    // Items that live somewhere else in the folder (sub-folders etc.)
    for (var i = 0; i < state.items.length; i++) {
      var s = state.items[i].src;
      if (fileURLs.has(s) || /^[a-z]+:/i.test(s)) continue;
      var file = await fileAt(s);
      if (file) fileURLs.set(s, URL.createObjectURL(file));
    }
  }

  async function rescan() {
    if (!rootDir) return;
    await scanFolder();
    resetInfo();
    clearPreview();
    renderAll();
    toast("Rescanned media folder — " + folderFiles.size + " files", "ok");
  }

  function sanitizeName(name) {
    var clean = name.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "");
    return clean || "file";
  }

  function splitName(src) {
    var name = String(src).split("/").pop();
    var dot = name.lastIndexOf(".");
    return { dir: src.slice(0, src.length - name.length), base: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot) : "" };
  }

  async function dirHandleFor(path) {
    var parts = path.split("/").filter(Boolean), dir = rootDir;
    for (var i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
    return dir;
  }

  function startRename() {
    var it = getItem(primaryId);
    if (!it || selected.size > 1) return;
    var parts = splitName(it.src);
    $("#itemRename").hidden = false;
    $("#renameExt").textContent = parts.ext;
    var input = $("#renameInput");
    input.value = parts.base;
    input.focus();
    input.select();
  }

  function cancelRename() { $("#itemRename").hidden = true; }

  /** Rename the file in media/ and point every item that uses it at the new name. */
  async function applyRename() {
    var it = getItem(primaryId);
    if (!it) { cancelRename(); return; }
    var parts = splitName(it.src);
    // The extension always stays as it is; drop one if it was typed along with the name.
    var base = sanitizeName($("#renameInput").value.trim())
      .replace(/\.(mp4|webm|mov|m4v|ogv|gif|jpe?g|png|webp|avif|bmp|svg)$/i, "")
      .replace(/\.+$/, "");
    if (!base || base === parts.base) { cancelRename(); return; }
    var oldSrc = it.src, newSrc = parts.dir + base + parts.ext;
    if (folderFiles.has(newSrc) || pendingFiles.has(newSrc) || state.items.some(function (i) { return i.src === newSrc; })) {
      toast("There's already a file called " + base + parts.ext, "error");
      return;
    }

    if (pendingFiles.has(oldSrc)) {
      // Added but not copied into media/ yet: just rename what's queued.
      pendingFiles.set(newSrc, pendingFiles.get(oldSrc));
      pendingFiles.delete(oldSrc);
      tempURLs.set(newSrc, tempURLs.get(oldSrc));
      tempURLs.delete(oldSrc);
    } else if (rootDir) {
      try {
        var dir = await dirHandleFor(oldSrc);
        var oldName = oldSrc.split("/").pop(), newName = newSrc.split("/").pop();
        var fh = await dir.getFileHandle(oldName);
        if (fh.move) {
          await fh.move(newName);
        } else {
          // Older browsers: copy, make sure the copy is complete, only then drop the old name.
          var file = await fh.getFile();
          var copy = await writeFile(dir, newName, file);
          if ((await copy.getFile()).size !== file.size) throw new Error("the copy came out a different size");
          await dir.removeEntry(oldName);
        }
        var moved = await dir.getFileHandle(newName);
        if (fileURLs.has(oldSrc)) URL.revokeObjectURL(fileURLs.get(oldSrc));
        fileURLs.delete(oldSrc);
        fileURLs.set(newSrc, URL.createObjectURL(await moved.getFile()));
        if (folderFiles.has(oldSrc)) {
          folderFiles.set(newSrc, folderFiles.get(oldSrc));
          folderFiles.delete(oldSrc);
        }
      } catch (e) {
        toast("Couldn't rename the file: " + e.message, "error");
        return;
      }
    } else {
      toast("Connect your carousel folder first — renaming changes the file in media/.", "warn",
        { label: "Connect", fn: function () { storedHandle ? reconnect() : pickFolder(); } });
      return;
    }

    if (info.has(oldSrc)) {
      info.set(newSrc, info.get(oldSrc));
      info.delete(oldSrc);
    }
    state.items.forEach(function (i) { if (i.src === oldSrc) i.src = newSrc; });
    renameInHistory(oldSrc, newSrc); // the file is already renamed, so undo must not bring the old path back
    cancelRename();
    clearPreview();
    commit();
    toast("Renamed to " + base + parts.ext, "ok");
    if (rootDir) await save(); // keep config.js in step with the file on disk
  }

  function renameInHistory(oldSrc, newSrc) {
    function fix(snap) {
      var s = JSON.parse(snap);
      s.items.forEach(function (i) { if (i.src === oldSrc) i.src = newSrc; });
      return JSON.stringify(s);
    }
    undoStack = undoStack.map(fix);
    redoStack = redoStack.map(fix);
    if (lastSnap) lastSnap = fix(lastSnap);
  }

  async function copyIntoMedia(file) {
    var name = sanitizeName(file.name);
    var existing = folderFiles.get("media/" + name);
    if (existing && existing.size === file.size) return "media/" + name; // same file already there
    if (existing) {
      var dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
      var n = 2;
      while (folderFiles.has("media/" + base + "_" + n + ext)) n++;
      name = base + "_" + n + ext;
    }
    var fh = await writeFile(mediaDir, name, file);
    var src = "media/" + name;
    folderFiles.set(src, { size: file.size });
    fileURLs.set(src, URL.createObjectURL(await fh.getFile()));
    return src;
  }

  /** Copy files that were added before a folder was connected. */
  async function flushPending() {
    if (!rootDir || !pendingFiles.size) return;
    var count = 0;
    for (var entry of Array.from(pendingFiles)) {
      var src = entry[0], file = entry[1];
      pendingFiles.delete(src);
      var users = state.items.filter(function (i) { return i.src === src; });
      if (!users.length) continue;
      try {
        var newSrc = await copyIntoMedia(file);
        users.forEach(function (i) { i.src = newSrc; });
        count++;
      } catch (e) {
        toast("Couldn't copy " + file.name + ": " + e.message, "error");
      }
      URL.revokeObjectURL(tempURLs.get(src));
      tempURLs.delete(src);
    }
    if (count) toast("Copied " + count + " new file" + (count > 1 ? "s" : "") + " into media/", "ok");
  }

  // ---------- remote control of the cooler ----------

  var remoteCmds = []; // recent commands; the display applies the ones it has not seen yet

  async function sendRemote(cmd, src) {
    if (!rootDir) {
      if (!FSA) { toast("Controlling the cooler needs Chrome or Edge with the folder connected", "warn"); return; }
      toast("Connect your carousel folder to control the cooler", "warn",
        { label: "Connect", fn: function () { storedHandle ? reconnect() : pickFolder(); } });
      return;
    }
    if (cmd) {
      var last = remoteCmds.length ? remoteCmds[remoteCmds.length - 1].seq : 0;
      remoteCmds.push({ seq: Math.max(Date.now(), last + 1), cmd: cmd, src: src });
      remoteCmds = remoteCmds.slice(-10);
    }
    try {
      await writeFile(rootDir, "remote.js",
        "// Written by editor.html to control the cooler (next / previous / show / NSFW). Safe to ignore.\n" +
        "window.CAROUSEL_REMOTE = " + JSON.stringify({ nsfw: coolerNsfw, cmds: remoteCmds }) + ";\n");
      return true;
    } catch (e) {
      toast("Couldn't reach the cooler: " + e.message, "error");
      return false;
    }
  }

  // ---------- NSFW switch ----------
  // Lives in remote.js (not config.js) so it reaches the cooler within a second, no save needed.

  var coolerNsfw = false;

  function syncNsfwSwitch() {
    $("#coolerNsfw").checked = coolerNsfw;
    renderSummary();
  }

  /** On connect, take the switch position from the folder's remote.js: that is what the cooler uses. */
  async function readCoolerNsfw() {
    var text = await readText(rootDir, "remote.js");
    var r = null;
    if (text) {
      try { var w = {}; new Function("window", text)(w); r = w.CAROUSEL_REMOTE; } catch (e) { r = null; }
    }
    coolerNsfw = !!(r && r.nsfw === true);
    syncNsfwSwitch();
  }

  async function setCoolerNsfw(on) {
    if (!rootDir) {
      $("#coolerNsfw").checked = coolerNsfw;
      sendRemote(); // shows the connect prompt
      return;
    }
    var was = coolerNsfw;
    coolerNsfw = on;
    if (!(await sendRemote())) {
      coolerNsfw = was;
      syncNsfwSwitch();
      return;
    }
    syncNsfwSwitch();
    if (player) player.setNsfw(on);
    toast(on ? "NSFW items now show on the cooler" : "NSFW items hidden on the cooler", "ok");
  }

  // The cooler cannot report back, so this is what we last told it (kept across editor reloads).
  function syncPauseButton() {
    var b = $("#remotePause");
    b.classList.toggle("on", !!prefs.coolerPaused);
    b.title = prefs.coolerPaused
      ? "Paused \u2014 resume the cooler playlist"
      : "Pause the cooler on its current item";
  }

  async function toggleCoolerPause() {
    if (!rootDir) { sendRemote("pause"); return; } // shows the connect prompt
    var pause = !prefs.coolerPaused;
    await sendRemote(pause ? "pause" : "resume");
    prefs.coolerPaused = pause;
    savePrefs();
    syncPauseButton();
    toast(pause ? "Cooler paused \u2014 the current item stays up" : "Cooler playlist resumed", "ok");
  }

  function remoteShowSelected() {
    var it = getItem(primaryId);
    if (!it) { toast("Select an item first", "warn"); return; }
    if (!it.enabled) { toast("That item is hidden from the rotation, so the cooler can't show it", "warn"); return; }
    if (it.nsfw && !coolerNsfw) { toast("That item is tagged NSFW and NSFW is off on the cooler", "warn"); return; }
    if (savedText && savedText.indexOf('"src":' + JSON.stringify(it.src)) < 0) {
      toast("Save first — the cooler doesn't have " + fileName(it.src) + " yet", "warn", { label: "Save", fn: save });
      return;
    }
    sendRemote("show", it.src);
    toast("Showing " + fileName(it.src) + " on the cooler", "ok");
  }

  var saving = false;
  async function save() {
    if (saving) return;
    if (!FSA) { downloadConfig(); return; }
    if (!rootDir) {
      if (!storedHandle) toast("Pick your carousel folder (the one with index.html). The playlist is saved there as config.js.", "info");
      var res = storedHandle ? await reconnect() : await pickFolder();
      if (!res) return;
      if (res === "loaded") { toast("Loaded the playlist from that folder — nothing was overwritten", "info"); return; }
    }
    saving = true;
    updateDirty();
    try {
      await flushPending();
      var text = serialize(state);
      var old = await readText(rootDir, "config.js");
      if (old != null && old !== text) await writeFile(rootDir, "config.backup.js", old);
      await writeFile(rootDir, "config.js", text);
      savedText = text;
      toast("Saved. The cooler picks up changes within ~15 seconds.", "ok");
    } catch (e) {
      toast("Save failed: " + e.message, "error");
      if (e.name === "NotAllowedError") setFolderUI("reconnect");
    }
    saving = false;
    renderAll();
  }

  function downloadConfig() {
    var text = serialize(state);
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    a.download = "config.js";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    if (!FSA) savedText = text;
    updateDirty();
    toast("Downloaded config.js — put it in your carousel folder (replacing the old one).", "info");
  }

  function updateDirty() {
    var dirty = isDirty();
    var btn = $("#saveBtn");
    btn.classList.toggle("clean", !dirty && !saving);
    btn.disabled = saving;
    var label = !FSA ? "Download" : saving ? "Saving…" : dirty ? "Save" : "Saved";
    $("#saveLabel").textContent = label;
    document.title = (dirty ? "• " : "") + "Kraken Carousel Editor";
    $("#undoBtn").disabled = !undoStack.length;
    $("#redoBtn").disabled = !redoStack.length;
  }

  // ======================================================================
  // Adding media
  // ======================================================================

  function looksLikeMedia(f) {
    return KS.isMedia(f.name) || /^(image|video)\//.test(f.type);
  }

  async function addFiles(fileList, index) {
    var files = Array.prototype.filter.call(fileList, looksLikeMedia);
    if (!files.length) { toast("Those aren't images or videos", "warn"); return; }
    if (index == null) index = insertionPoint();
    var items = [];
    var busy = files.length > 1 || files[0].size > 20e6 ? toast("Adding " + files.length + " file" + (files.length > 1 ? "s" : "") + "…", "info") : null;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], src;
      if (rootDir) {
        try { src = await copyIntoMedia(f); } catch (e) { toast("Couldn't copy " + f.name + ": " + e.message, "error"); continue; }
      } else {
        src = "media/" + sanitizeName(f.name);
        if (tempURLs.has(src)) URL.revokeObjectURL(tempURLs.get(src));
        tempURLs.set(src, URL.createObjectURL(f));
        pendingFiles.set(src, f);
        info.delete(src);
      }
      items.push(makeItem({ src: src, overlay: "none" }));
    }
    if (busy) busy.remove();
    if (!items.length) return;
    insertItems(items, index);
    renderUnused();
    var hevc = [];
    for (var h = 0; h < files.length; h++) {
      if (await isHevcFile(files[h])) hevc.push(files[h].name);
    }
    if (hevc.length) {
      toast(hevc.join(", ") + (hevc.length > 1 ? " are" : " is") +
        " HEVC (H.265). NZXT CAM can't play that, so the cooler will skip " + (hevc.length > 1 ? "them" : "it") +
        ". Re-encode to H.264 first \u2014 see the README.", "error");
    }
    if (rootDir) {
      toast("Added " + items.length + " item" + (items.length > 1 ? "s" : ""), "ok");
    } else if (FSA) {
      toast("Added " + items.length + " item" + (items.length > 1 ? "s" : "") + ". Connect your carousel folder so they get copied into media/.", "warn",
        { label: "Connect", fn: function () { storedHandle ? reconnect() : pickFolder(); } });
    } else {
      toast("Added. Remember to copy the file" + (items.length > 1 ? "s" : "") + " into your media folder.", "warn");
    }
  }

  function addFromFolder(srcs) {
    var items = srcs.map(function (src) { return makeItem({ src: src, overlay: "none" }); });
    insertItems(items, state.items.length);
  }

  async function importLegacy(file) {
    var items = parseLegacy(await file.text());
    if (!items) { toast("Couldn't find a mediaFiles list in " + file.name, "error"); return; }
    if (!confirm("Replace the current playlist (" + state.items.length + " items) with " + items.length + " items from " + file.name + "?")) return;
    stopPlay();
    state.items = items.map(makeItem);
    selected = new Set(state.items.length ? [state.items[0].id] : []);
    primaryId = anchorId = state.items.length ? state.items[0].id : null;
    commit();
    toast("Imported " + items.length + " items — review them, then Save", "ok");
  }

  // ======================================================================
  // Drag & drop (reorder + files)
  // ======================================================================

  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") >= 0;
  }

  function bindDragDrop() {
    var dragIds = null;

    function rows() { return $$(".row", list); }
    function indexAt(y) {
      var r = rows();
      for (var i = 0; i < r.length; i++) {
        var b = r[i].getBoundingClientRect();
        if (y < b.top + b.height / 2) return i;
      }
      return r.length;
    }
    function showLine(i) {
      var r = rows();
      var top = !r.length ? 0 : i < r.length ? r[i].offsetTop - 1 : r[r.length - 1].offsetTop + r[r.length - 1].offsetHeight + 1;
      dropLine.style.top = top + "px";
      dropLine.classList.add("show");
    }
    function hideLine() { dropLine.classList.remove("show"); }

    list.addEventListener("dragstart", function (e) {
      var row = e.target.closest(".row");
      if (!row) return;
      var id = row.dataset.id;
      if (!selected.has(id)) selectId(id);
      dragIds = selectedItems().map(function (i) { return i.id; });
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragIds.join(","));
      requestAnimationFrame(function () {
        rows().forEach(function (r) { r.classList.toggle("dragging", dragIds && dragIds.indexOf(r.dataset.id) >= 0); });
      });
    });
    list.addEventListener("dragover", function (e) {
      if (!dragIds && !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragIds ? "move" : "copy";
      showLine(indexAt(e.clientY));
    });
    list.addEventListener("dragleave", function (e) {
      if (!list.contains(e.relatedTarget)) hideLine();
    });
    list.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideLine();
      hideDropzone();
      var idx = indexAt(e.clientY);
      if (dragIds) {
        var ids = dragIds;
        dragIds = null;
        moveIds(ids, idx);
      } else if (e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files, idx);
      }
    });
    list.addEventListener("dragend", function () {
      dragIds = null;
      hideLine();
      rows().forEach(function (r) { r.classList.remove("dragging"); });
    });

    // Files dropped anywhere else in the window get appended after the selection.
    var depth = 0, zone = $("#dropzone");
    function hideDropzone() { depth = 0; zone.hidden = true; }
    window.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      depth++;
      zone.hidden = false;
    });
    window.addEventListener("dragleave", function (e) {
      if (!hasFiles(e)) return;
      if (--depth <= 0) hideDropzone();
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      hideDropzone();
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  // ======================================================================
  // Toasts
  // ======================================================================

  function toast(message, kind, action) {
    var el = document.createElement("div");
    el.className = "toast " + (kind || "info");
    var span = document.createElement("span");
    span.textContent = message;
    el.appendChild(span);
    if (action) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = action.label;
      b.addEventListener("click", function () { el.remove(); action.fn(); });
      el.appendChild(b);
    }
    $("#toasts").appendChild(el);
    setTimeout(function () { el.remove(); }, action ? 8000 : kind === "error" ? 7000 : 4000);
    return el;
  }

  // ======================================================================
  // Wiring
  // ======================================================================

  function renderAll() {
    stage.applySettings(state.settings);
    renderList();
    refreshInspector();
    syncSettings();
    renderPreview();
    updateDirty();
  }

  function bindGlobal() {
    list.addEventListener("click", function (e) {
      var row = e.target.closest(".row");
      if (!row) return;
      var act = e.target.closest("[data-act]");
      if (act) {
        e.stopPropagation();
        var id = row.dataset.id;
        if (act.dataset.act === "toggle") toggleEnabled(id);
        else {
          if (!selected.has(id)) selectId(id);
          if (act.dataset.act === "dup") duplicateSelected();
          if (act.dataset.act === "del") removeSelected();
        }
        return;
      }
      selectId(row.dataset.id, e);
    });

    list.addEventListener("dblclick", function (e) {
      if (!e.target.closest(".name")) return;
      var row = e.target.closest(".row");
      if (!row) return;
      selectId(row.dataset.id);
      startRename();
    });

    $("#unusedGrid").addEventListener("click", function (e) {
      var tile = e.target.closest(".tile");
      if (tile) addFromFolder([tile.dataset.src]);
    });
    $("#addAllUnused").addEventListener("click", function (e) {
      e.preventDefault();
      addFromFolder($$(".tile", $("#unusedGrid")).map(function (t) { return t.dataset.src; }));
    });

    $("#addBtn").addEventListener("click", function () { $("#filePick").click(); });
    $("#filePick").addEventListener("change", function () {
      if (this.files.length) addFiles(this.files);
      this.value = "";
    });
    $("#legacyBtn").addEventListener("click", function () { $("#legacyPick").click(); });
    $("#legacyPick").addEventListener("change", function () {
      if (this.files[0]) importLegacy(this.files[0]);
      this.value = "";
    });
    $("#downloadBtn").addEventListener("click", downloadConfig);

    $("#saveBtn").addEventListener("click", save);
    $("#undoBtn").addEventListener("click", undo);
    $("#redoBtn").addEventListener("click", redo);
    $("#folderBtn").addEventListener("click", function () {
      var mode = $("#folder").dataset.state;
      if (mode === "reconnect") reconnect();
      else pickFolder();
    });
    $("#rescanBtn").addEventListener("click", rescan);

    document.addEventListener("keydown", function (e) {
      var key = e.key.toLowerCase();
      var mod = e.ctrlKey || e.metaKey;
      if (mod && key === "s") { e.preventDefault(); save(); return; }
      if (e.target.closest("input, select, textarea")) return;
      if (e.target.closest("button") && (key === " " || key === "enter")) return;
      if (mod && key === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && key === "y") { e.preventDefault(); redo(); }
      else if (mod && key === "a") {
        e.preventDefault();
        selected = new Set(state.items.map(function (i) { return i.id; }));
        if (!primaryId && state.items.length) primaryId = state.items[0].id;
        refreshSelection();
      }
      else if (mod && key === "d") { e.preventDefault(); duplicateSelected(); }
      else if (key === "delete" || key === "backspace") { e.preventDefault(); removeSelected(); }
      else if (key === "arrowup" || key === "arrowdown") {
        e.preventDefault();
        var d = key === "arrowup" ? -1 : 1;
        if (e.altKey) moveSelected(d);
        else selectRelative(d, e.shiftKey);
      }
      else if (key === " ") { e.preventDefault(); player ? stopPlay() : startPlay(); }
      else if (key === "h") { if (primaryId) toggleEnabled(primaryId); }
      else if (key === "n") {
        var sel = selectedItems();
        if (sel.length) {
          setItemField("nsfw", !sel[0].nsfw);
          commit();
        }
      }
      else if (key === "f2") { e.preventDefault(); startRename(); }
    });

    window.addEventListener("beforeunload", function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  // ---------- boot ----------

  var initial = window.CAROUSEL_CONFIG;
  if (initial && Array.isArray(initial.items)) {
    loadConfig(initial);
    savedText = normalizedText(initial);
  } else {
    loadConfig({ items: [] });
  }
  resetHistory();

  bindInspector();
  bindPreview();
  bindDragDrop();
  bindGlobal();
  showTab(location.hash === "#display" || (prefs.tab === "display" && location.hash !== "#item") ? "display" : "item");
  fitPreview();
  renderAll();
  initFolder().catch(function (e) { console.error(e); }).then(function () {
    probeReady = true;
    pumpProbes();
  });
})();
