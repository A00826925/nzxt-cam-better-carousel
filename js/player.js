/*
 * Kraken Carousel — playlist player.
 * Preloads the next item off-screen, cross-fades between items, loops videos in place
 * and skips anything that fails to load, so the carousel never stalls or flashes black.
 */
(function (global) {
  "use strict";

  var LOAD_TIMEOUT = 20000;  // give big local GIFs/videos time to decode
  var STALL_TIMEOUT = 15000; // video stopped progressing -> move on

  /**
   * stage: a KrakenStage instance.
   * opts.onChange(index, item) — called whenever a new item is shown.
   * opts.maxItemMs — cap each item's on-screen time (editor "quick preview").
   */
  function Player(stage, opts) {
    opts = opts || {};
    var all = [];        // every enabled item
    var items = [];      // what actually plays: `all` minus NSFW items while those are hidden
    var showNsfw = false;
    var cur = null;      // { index, item, el }
    var pending = null;  // preloaded next item
    var timer = 0;
    var stallTimer = 0;
    var gen = 0;         // bumps on stop/goto so stale async work is ignored
    var failures = 0;
    var held = false;    // paused: the current item stays up (videos loop) until resumed

    function nextIndex(i) { return items.length ? (i + 1) % items.length : 0; }

    function visible() {
      return showNsfw ? all.slice() : all.filter(function (it) { return !it.nsfw; });
    }

    /** Index (in `items`) of the first playable item after `item` in playlist order, or -1. */
    function nextVisibleAfter(item) {
      var from = all.indexOf(item);
      for (var k = 1; k <= all.length; k++) {
        var j = items.indexOf(all[(from + k) % all.length]);
        if (j >= 0) return j;
      }
      return -1;
    }

    function load(index) {
      var item = items[index];
      var el = stage.createMedia(item);
      var ready = new Promise(function (resolve) {
        var done = false;
        function finish(ok) {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(ok);
        }
        var t = setTimeout(function () { finish(false); }, LOAD_TIMEOUT);
        el.addEventListener("error", function () { finish(false); }, { once: true });
        if (el.tagName === "VIDEO") {
          el.addEventListener("canplay", function () { finish(true); }, { once: true });
        } else if (el.decode) {
          el.decode().then(function () { finish(true); }, function () { finish(el.naturalWidth > 0); });
        } else {
          el.addEventListener("load", function () { finish(true); }, { once: true });
        }
      });
      return { index: index, item: item, el: el, ready: ready };
    }

    function clearTimers() {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      timer = stallTimer = 0;
    }

    function dispose(p) {
      if (p) stage.disposeMedia(p.el);
    }

    function itemMs(ms) {
      return opts.maxItemMs ? Math.min(ms, opts.maxItemMs) : ms;
    }

    function startPlayback(p, myGen) {
      var item = p.item, el = p.el;
      if (el.tagName !== "VIDEO") {
        timer = setTimeout(advance, itemMs(item.duration * 1000));
        return;
      }
      var plays = Math.max(1, item.plays || 1), count = 0;
      function live() { return cur === p && myGen === gen; }
      function play() {
        var r = el.play();
        if (r && r.catch) r.catch(function () {
          // Autoplay with sound was blocked: retry muted.
          if (!live()) return;
          el.muted = true;
          el.play().catch(function () {});
        });
      }
      function watchStall() {
        if (!live()) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(function () { if (live()) advance(); }, STALL_TIMEOUT);
      }
      el.addEventListener("timeupdate", watchStall);
      el.addEventListener("error", function () { if (live()) advance(); });
      el.addEventListener("ended", function () {
        if (!live()) return;
        if (++count < plays) {
          el.currentTime = 0;
          play();
        } else {
          advance();
        }
      });
      if (opts.maxItemMs) timer = setTimeout(advance, opts.maxItemMs);
      watchStall();
      play();
    }

    function show(p) {
      var myGen = gen;
      p.ready.then(function (ok) {
        if (myGen !== gen) { dispose(p); return; }
        if (!ok) {
          dispose(p);
          if (++failures >= items.length) {
            // Nothing loads: wait and try again rather than spinning.
            failures = 0;
            timer = setTimeout(function () { show(load(nextIndex(p.index))); }, 10000);
          } else {
            show(load(nextIndex(p.index)));
          }
          return;
        }
        failures = 0;

        var at = items.indexOf(p.item);
        if (at < 0) {
          // Hidden (NSFW switched off) while it was loading: never put it on screen.
          dispose(p);
          var skip = nextVisibleAfter(p.item);
          if (skip >= 0) show(load(skip));
          return;
        }
        p.index = at; // the visible list may have changed while this loaded

        var prev = cur;
        cur = p;
        stage.media.appendChild(p.el);
        stage.setOverlay(p.item.overlay, p.item.dim, p.item.color);
        // Force a style flush so the fade-in transition runs.
        void p.el.offsetWidth;
        p.el.classList.add("ks-on");
        if (prev) {
          prev.el.classList.remove("ks-on");
          var fade = Math.max(0, stage.settings.transitionMs || 0);
          setTimeout(function () { dispose(prev); }, fade + 50);
        }
        startPlayback(p, myGen);
        if (opts.onChange) opts.onChange(p.index, p.item);

        if (items.length > 1) pending = load(nextIndex(p.index));
      });
    }

    /** While held, "time to move on" just keeps the current item going instead. */
    function replayCurrent() {
      if (cur.el.tagName !== "VIDEO") return; // an image simply stays on screen
      cur.el.currentTime = 0;
      var r = cur.el.play();
      if (r && r.catch) r.catch(function () {});
    }

    function advance() {
      clearTimers();
      if (held && cur) { replayCurrent(); return; }
      if (!items.length) return;
      var target = cur ? nextIndex(cur.index) : 0;
      var p = pending && pending.index === target ? pending : load(target);
      if (pending && pending !== p) dispose(pending);
      pending = null;
      show(p);
    }

    function goto(index) {
      gen++;
      clearTimers();
      dispose(pending);
      pending = null;
      if (!items.length) return;
      show(load(((index % items.length) + items.length) % items.length));
    }

    function stop() {
      gen++;
      clearTimers();
      dispose(pending);
      dispose(cur);
      pending = cur = null;
    }

    return {
      /** Replace the playlist (only enabled items are played). */
      setItems: function (list) {
        all = (list || []).filter(function (it) { return it.enabled !== false && it.src; });
        items = visible();
        dispose(pending);
        pending = null;
      },
      /**
       * Show or hide items tagged NSFW. Hiding takes an NSFW item that is on screen down at once
       * (no crossfade) and moves on to the next item that is allowed.
       */
      setNsfw: function (on) {
        on = !!on;
        if (on === showNsfw) return;
        showNsfw = on;
        var current = cur && cur.item;
        items = visible();
        dispose(pending); // the preloaded next item may no longer be the right one
        pending = null;
        if (!current) return;
        var at = items.indexOf(current);
        if (at >= 0) {
          cur.index = at;
          if (items.length > 1) pending = load(nextIndex(at));
          return;
        }
        gen++;
        clearTimers();
        dispose(cur);
        cur = null;
        var next = nextVisibleAfter(current);
        if (next >= 0) show(load(next));
      },
      get nsfw() { return showNsfw; },
      get total() { return all.length; },
      start: function (index) { goto(index || 0); },
      goto: goto,
      next: function () { goto(cur ? cur.index + 1 : 0); },
      prev: function () { goto(cur ? cur.index - 1 : 0); },
      stop: stop,
      /** Pause on / off. Explicit next / prev / goto still work while paused. */
      hold: function (on) {
        on = !!on;
        if (held === on) return;
        held = on;
        // Resuming an image: give it a normal full duration from now, then move on.
        // (A video moves on by itself at the end of its current run.)
        if (!held && cur && cur.el.tagName !== "VIDEO") {
          clearTimeout(timer);
          timer = setTimeout(advance, itemMs(cur.item.duration * 1000));
        }
      },
      get held() { return held; },
      get items() { return items; },
      get index() { return cur ? cur.index : -1; }
    };
  }

  global.KrakenPlayer = Player;
})(window);
