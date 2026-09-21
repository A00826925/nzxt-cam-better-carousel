/*
 * Kraken Carousel — cooler display entry point (index.html).
 * Optional URL params: ?item=5 starts at the 5th enabled item (handy for testing).
 *
 * Remote control: the editor writes remote.js next to this page; it is re-read every second and
 * any new commands (next / prev / show a given file / pause / resume) are applied to the running
 * carousel. Pausing is not remembered across a restart of the page: it starts playing again.
 * remote.js also carries the NSFW switch as plain state (`nsfw: true|false`), read on every poll —
 * including the very first — so it survives restarts. Missing or unreadable means NSFW stays hidden.
 */
(function () {
  "use strict";

  var RELOAD_EVERY = 15000; // re-read config.js so saves from the editor show up without restarting CAM
  var REMOTE_EVERY = 1000;  // how often to look for editor commands in remote.js

  var host = document.getElementById("display");
  var stage = KrakenStage.create(host, window.CAROUSEL_CONFIG && window.CAROUSEL_CONFIG.settings);
  var player = KrakenPlayer(stage);
  var message = null;
  var nsfwOn = false; // NSFW items stay hidden until remote.js says otherwise
  var lastJSON = "";
  var itemsJSON = "";

  function fit() { stage.fit(host); }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(host);
  else window.addEventListener("resize", fit);
  fit();

  // NZXT CAM pushes sensor data here about once a second.
  window.nzxt = {
    v1: {
      onMonitoringDataUpdate: function (data) { stage.setData(data); }
    }
  };

  function showMessage(text) {
    if (!message) {
      message = document.createElement("p");
      message.className = "msg";
      host.appendChild(message);
    }
    message.innerHTML = text;
    message.hidden = !text;
  }

  function apply(config, first) {
    if (!config || !Array.isArray(config.items)) {
      if (first) showMessage("config.js is missing or invalid.<br>Open editor.html to create a playlist.");
      return;
    }
    var settings = KrakenStage.withDefaults(config.settings);
    var items = config.items.map(function (it) { return KrakenStage.normalizeItem(it, settings); });
    stage.applySettings(settings);

    var json = JSON.stringify(items);
    if (json === itemsJSON) return; // only settings changed
    itemsJSON = json;

    var current = player.items[player.index];
    player.setItems(items);
    if (!player.items.length) {
      showEmpty();
      return;
    }
    showMessage("");

    var start = 0;
    if (first) {
      var fromUrl = parseInt(new URLSearchParams(location.search).get("item"), 10);
      if (fromUrl > 0) start = fromUrl - 1;
    } else if (current) {
      // Stay on the same media after an edit (it restarts so framing changes show).
      for (var i = 0; i < player.items.length; i++) {
        if (player.items[i].src === current.src) { start = i; break; }
      }
    }
    player.start(start);
  }

  function showEmpty() {
    player.stop();
    stage.setOverlay("none");
    showMessage(player.total
      ? "Everything in the playlist is tagged NSFW.<br>Turn NSFW on in the editor to show it."
      : "The playlist is empty.<br>Open editor.html to add media.");
  }

  function applyNsfw(on) {
    if (on === nsfwOn) return;
    nsfwOn = on;
    var wasEmpty = !player.items.length;
    player.setNsfw(on);
    if (!player.items.length) showEmpty();
    else if (wasEmpty) { showMessage(""); player.start(0); }
  }

  function reloadConfig() {
    var script = document.createElement("script");
    script.src = "config.js?t=" + Date.now();
    script.onload = script.onerror = function () {
      script.remove();
      var json = JSON.stringify(window.CAROUSEL_CONFIG || null);
      if (json !== lastJSON) {
        lastJSON = json;
        apply(window.CAROUSEL_CONFIG, false);
      }
    };
    document.head.appendChild(script);
  }

  // ---------- remote control ----------

  var remoteSeq = null; // newest command already handled; null until the first read

  function runRemote(cmds) {
    // Fold everything that arrived since the last read into one jump, so three quick
    // "next" clicks move three items even though they are applied in the same tick.
    var target = null, steps = 0, hold = null;
    cmds.forEach(function (c) {
      if (c.cmd === "pause") hold = true;
      else if (c.cmd === "resume") hold = false;
      else if (c.cmd === "next") steps++;
      else if (c.cmd === "prev") steps--;
      else if (c.cmd === "show") {
        for (var i = 0; i < player.items.length; i++) {
          if (player.items[i].src === c.src) { target = i; steps = 0; break; }
        }
      }
    });
    if (hold !== null) player.hold(hold);
    if (!player.items.length) return;
    if (target !== null) player.goto(target + steps);
    else if (steps) player.goto(Math.max(0, player.index) + steps);
  }

  function pollRemote() {
    var script = document.createElement("script");
    script.src = "remote.js?t=" + Date.now();
    script.onload = script.onerror = function () {
      script.remove();
      var r = window.CAROUSEL_REMOTE;
      applyNsfw(!!(r && r.nsfw === true));
      var cmds = (r && Array.isArray(r.cmds)) ? r.cmds : [];
      var newest = cmds.reduce(function (m, c) { return Math.max(m, c.seq || 0); }, 0);
      if (remoteSeq === null) {
        remoteSeq = newest; // whatever is already in the file happened before this page started
        return;
      }
      var fresh = cmds.filter(function (c) { return c.seq > remoteSeq; });
      remoteSeq = Math.max(remoteSeq, newest);
      if (fresh.length) runRemote(fresh);
    };
    document.head.appendChild(script);
  }

  lastJSON = JSON.stringify(window.CAROUSEL_CONFIG || null);
  apply(window.CAROUSEL_CONFIG, true);
  setInterval(reloadConfig, RELOAD_EVERY);
  pollRemote();
  setInterval(pollRemote, REMOTE_EVERY);
})();
