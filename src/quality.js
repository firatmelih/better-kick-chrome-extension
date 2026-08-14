/* Better Kick — quality lock.
 *
 * Runs in the PAGE world (manifest "world": "MAIN") at document_start, before
 * Kick's own bundle boots.
 *
 * The problem this solves is *not* the settings menu — content.js already
 * clicks that as a fallback. It is that Kick remembers the chosen quality in
 * sessionStorage under "stream_quality", and sessionStorage is:
 *   - per tab, so a new tab / a restored tab starts empty, and
 *   - overwritten by the player itself back to "auto" (or to whatever the ABR
 *     ladder settled on) on a reload, a channel change, or a stream restart.
 * Either way the remembered 1080 is gone by the time the player reads it, and
 * playback starts on whatever ABR picks.
 *
 * So: keep the real preference in localStorage (survives reloads, tabs and
 * restarts), copy it into sessionStorage before the player can read it, and
 * hold it there — any later write that would lower it is replaced with the
 * pinned value instead of being stored.
 *
 * Setting comes in as <html data-bpk-1080="on|off">, written by content.js:
 * the two worlds share no variables, but they do share the DOM.
 */
(() => {
  'use strict';

  if (window.__bpkQuality) return;

  const DBG = '[Better Kick quality]';

  // Kick's own key, plus the near variants it might rename to. Anchored at
  // the end on purpose: a loose /quality/i would also swallow keys like
  // "video_quality_options" (a list, not a choice) and corrupt them.
  const KEY = 'stream_quality';
  const KEY_RE = /(^|_)quality$/i;
  // Our persistent copy. Deliberately not quality-shaped, so the guard below
  // never treats its own bookkeeping as a page write.
  const PIN_KEY = 'bpk_pinned_stream_quality';
  const DEFAULT_PIN = '1080';

  // Captured before patching: every internal read/write goes through these,
  // so our own bookkeeping can never be intercepted by our own guard.
  const NAT = {
    get: Storage.prototype.getItem,
    set: Storage.prototype.setItem,
    del: Storage.prototype.removeItem
  };
  if (!NAT.get || !NAT.set || !NAT.del) return; // nothing to stand on

  let enabled = true;
  let pinned = DEFAULT_PIN;

  function readFlag() {
    const el = document.documentElement;
    const v = el && el.getAttribute('data-bpk-1080');
    enabled = v !== 'off'; // absent = on, so a missed handshake fails useful
  }

  // A value counts as "already 1080" if 1080 is the resolution it names. The
  // string form varies ("1080", "1080p", "1080p60"), so the pin learns
  // whichever spelling Kick actually writes rather than guessing one.
  function is1080(value) {
    return typeof value === 'string' && /(^|[^\d])1080([^\d]|$)/.test(value);
  }

  function loadPin() {
    let stored = null;
    try { stored = NAT.get.call(localStorage, PIN_KEY); } catch { /* blocked */ }
    if (is1080(stored)) pinned = stored;
  }

  function savePin(value) {
    if (value === pinned) return;
    pinned = value;
    try { NAT.set.call(localStorage, PIN_KEY, value); } catch { /* blocked */ }
  }

  function isQualityKey(key) {
    return key === KEY || (typeof key === 'string' && key !== PIN_KEY && KEY_RE.test(key));
  }

  /* -------------------------------------------------------------------- */
  /* the lock                                                              */
  /* -------------------------------------------------------------------- */

  // Writes the pin into sessionStorage — the store the player reads — using
  // the native setter, so this can never be intercepted by our own guard.
  // The durable copy lives in localStorage under PIN_KEY; Kick's own key is
  // left alone there, since Kick does not use it.
  let reasserts = 0;
  function assert(reason) {
    if (!enabled) return;
    try {
      if (NAT.get.call(sessionStorage, KEY) === pinned) return;
      NAT.set.call(sessionStorage, KEY, pinned);
      reasserts++;
      if (reasserts <= 5) console.debug(DBG, 'pinned', KEY, '=', pinned, '(' + reason + ')');
    } catch { /* storage blocked in this frame */ }
  }

  Storage.prototype.setItem = function (key, value) {
    if (enabled && isQualityKey(key)) {
      const str = String(value);
      if (is1080(str)) {
        // Kick just told us the exact spelling it uses — adopt it, so the pin
        // is always a value the player itself accepts.
        savePin(str);
      } else {
        // A downgrade ("auto", "720p", ...). Store the pin instead, so the
        // next read — including the player's own — still sees 1080.
        return NAT.set.call(this, key, pinned);
      }
    }
    return NAT.set.call(this, key, value);
  };

  // Covers the case where the player reads before our first assert lands, or
  // reads a store that was cleared out from under us.
  Storage.prototype.getItem = function (key) {
    if (enabled && isQualityKey(key)) return pinned;
    return NAT.get.call(this, key);
  };

  // Kick clears the key on teardown; letting that through is exactly the
  // "resets to nothing" the lock exists to prevent.
  Storage.prototype.removeItem = function (key) {
    if (enabled && isQualityKey(key)) return;
    return NAT.del.call(this, key);
  };

  /* -------------------------------------------------------------------- */
  /* re-assert points                                                      */
  /* -------------------------------------------------------------------- */

  // setItem/getItem cover normal code. Direct property writes
  // (sessionStorage.stream_quality = 'auto') and .clear() bypass the
  // prototype entirely, so the value is also re-checked on every event that
  // could have run one — and on a slow tick, as the backstop.
  readFlag();
  loadPin();
  assert('boot');

  const onNav = () => assert('navigation');
  for (const name of ['pushState', 'replaceState']) {
    const orig = history[name];
    if (typeof orig !== 'function') continue;
    history[name] = function (...args) {
      const out = orig.apply(this, args);
      onNav();
      return out;
    };
  }
  addEventListener('popstate', onNav);
  addEventListener('pageshow', () => assert('pageshow'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) assert('tab visible');
  });
  // A new stream load is the moment the player re-reads the preference.
  document.addEventListener('loadstart', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') assert('video loadstart');
  }, true);
  setInterval(() => assert('tick'), 2000);

  new MutationObserver(() => {
    const was = enabled;
    readFlag();
    if (enabled && !was) assert('re-enabled');
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bpk-1080']
  });

  // Live diagnosis from the page console.
  window.__bpkQuality = {
    get pinned() { return pinned; },
    get enabled() { return enabled; },
    report() {
      const out = { enabled, pinned, reasserts };
      try { out.session = NAT.get.call(sessionStorage, KEY); } catch { out.session = '<blocked>'; }
      try { out.persisted = NAT.get.call(localStorage, PIN_KEY); } catch { out.persisted = '<blocked>'; }
      console.log(DBG, out);
      return out;
    },
    // Pin something other than 1080 (e.g. '720p60') without touching settings.
    pin(value) {
      pinned = String(value);
      try { NAT.set.call(localStorage, PIN_KEY, pinned); } catch { /* blocked */ }
      assert('manual pin');
      return pinned;
    }
  };
})();
