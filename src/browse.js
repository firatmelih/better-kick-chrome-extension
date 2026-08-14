/* Better Kick — browse filter memory.
 *
 * Runs in the PAGE world (manifest "world": "MAIN") at document_start, before
 * Kick's own bundle boots. That timing is the whole trick: Kick's browse page
 * reads its filters out of the query string on first render, so if the query
 * string is already restored by the time the app starts, the first paint is
 * filtered. Nothing has to be clicked and nothing flashes unfiltered.
 *
 * What resets today: the filters live in the URL (`?language=…&sort=…`), so a
 * refresh keeps them — but the *Browse* link in the nav points at a bare
 * `/browse`, so coming back from a stream throws the whole selection away.
 * That, not the refresh, is what actually loses them.
 *
 * Two restore paths, because there are two ways into the page:
 *   - hard load (refresh, pasted link, new tab): rewrite location with
 *     replaceState before the app can read it. Free — no extra request.
 *   - in-app click on a bare browse link: cancel the SPA navigation and go to
 *     the restored URL instead. One full navigation, same as the click would
 *     have cost in the end, and the URL and the UI can never disagree.
 *
 * Deliberately generic: it stores whatever query string the page settles on,
 * so it keeps working if Kick renames `sort` or adds a filter we've never
 * seen. Nothing here knows what "armenian" or "viewers_high_to_low" mean.
 *
 * Setting comes in as <html data-bpk-browse="on|off">, written by content.js:
 * the two worlds share no variables, but they do share the DOM.
 */
(() => {
  'use strict';

  if (window.__bpkBrowse) return;

  const DBG = '[Better Kick browse]';
  const STORE_KEY = 'bpk_browse_filters';   // localStorage: path -> '?a=b'
  const GUARD_KEY = 'bpk_browse_restored';  // sessionStorage: loop breaker
  const GUARD_MS = 6000;
  // After a restore the app often normalises the URL once. Until this passes,
  // an empty query is assumed to be that normalisation and not a real "the
  // user cleared the filters".
  const GRACE_MS = 3000;

  let enabled = true;
  let restoredAt = 0;
  let lastPath = location.pathname;

  function readFlag() {
    const el = document.documentElement;
    enabled = !el || el.getAttribute('data-bpk-browse') !== 'off';
  }

  /* -------------------------------------------------------------------- */
  /* which pages have a memory                                             */
  /* -------------------------------------------------------------------- */

  // Which pages get a memory at all. Everything else — channels, VODs, the
  // search page — keeps its query string untouched.
  const PAGE_RE =
    /^\/(browse|categories|category|clips|following|popular|games|creative|irl|music|esports|subscriptions)(\/|$)/i;

  // One memory per exact path, NOT one per section. The first version bucketed
  // /browse and /browse/clips together, which broke the feature in two ways at
  // once: the tabs overwrote each other's filters, and every tab click looked
  // like a "same section" click, which is the one case restore is suppressed
  // for (it means the user is deliberately resetting). Keying on the path
  // keeps each tab's filters separate and makes tab clicks restorable.
  function keyFor(pathname) {
    if (!pathname || !PAGE_RE.test(pathname)) return null;
    return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const map = raw ? JSON.parse(raw) : null;
      return map && typeof map === 'object' ? map : {};
    } catch {
      return {}; // storage blocked, or someone wrote junk over the key
    }
  }

  function savedFor(key) {
    const v = loadAll()[key];
    return typeof v === 'string' && v.startsWith('?') ? v : '';
  }

  /* -------------------------------------------------------------------- */
  /* remember                                                              */
  /* -------------------------------------------------------------------- */

  // allowEmpty=false is used at boot: a page we have only just arrived on
  // tells us nothing about whether the user wants no filters.
  function remember(allowEmpty) {
    if (!enabled) return;
    const key = keyFor(location.pathname);
    if (!key) return;
    const search = location.search;
    // An empty query only means "the user cleared the filters" if the user was
    // already here. Arriving on a bare browse URL is the thing being fixed —
    // recording it would erase the very filters about to be restored.
    if (!search && !allowEmpty) return;
    if (!search && key !== keyFor(lastPath)) return;
    if (!search && Date.now() - restoredAt < GRACE_MS) return;
    const map = loadAll();
    if (map[key] === search) return;
    map[key] = search;
    // Per-path keying means /category/<slug> grows one entry per category
    // browsed. Drop the oldest so this can't creep up on localStorage.
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length - 40; i++) delete map[keys[i]];
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(map));
      console.debug(DBG, 'remembered', key, search || '(no filters)');
    } catch { /* storage blocked in this frame */ }
  }

  /* -------------------------------------------------------------------- */
  /* restore                                                               */
  /* -------------------------------------------------------------------- */

  // Hard load. replaceState rather than a redirect: the app has not read the
  // URL yet, so simply editing it is enough and costs nothing.
  function restoreInPlace() {
    if (!enabled) return;
    const key = keyFor(location.pathname);
    if (!key || location.search) return;
    const search = savedFor(key);
    if (!search) return;
    try {
      history.replaceState(history.state, '', location.pathname + search + location.hash);
      restoredAt = Date.now();
      console.debug(DBG, 'restored', key, search, 'before app boot');
    } catch { /* opaque origin */ }
  }

  // A left click on a plain same-origin link, with no modifier that means
  // "open this somewhere else". Anything else is left entirely alone.
  function plainNavClick(e) {
    return !e.defaultPrevented && e.button === 0 &&
      !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  // The nav's Browse link is a bare /browse. Cancelling it and navigating to
  // the remembered URL instead is done here — at the click — rather than by
  // rewriting history.pushState later, because by the time the router calls
  // pushState it has already decided what content to render: editing the URL
  // then would leave the address bar claiming filters the page is not
  // applying. Taking the click means the app only ever sees the full URL.
  function onClick(e) {
    if (!enabled || !plainNavClick(e)) return;
    const el = e.target;
    const a = el && el.closest ? el.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    const target = (a.getAttribute('target') || '').toLowerCase();
    if (target && target !== '_self') return;

    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin !== location.origin || url.search) return;

    const key = keyFor(url.pathname);
    // A link to the page you are already on is a deliberate reset — the one
    // case where a bare browse link is meant to stay bare.
    if (!key || key === keyFor(location.pathname)) return;

    const search = savedFor(key);
    if (!search) return;

    e.preventDefault();
    e.stopPropagation();
    console.debug(DBG, 'link to', url.pathname, '— restoring', search);
    location.assign(url.pathname + search + url.hash);
  }

  // Backstop for entries that never involve an anchor (a button that calls
  // router.push, a redirect). Costs a reload, so it is deliberately the last
  // resort: only when *arriving* from a different page, and never twice in
  // a row.
  function restoreByReload() {
    if (!enabled) return;
    const key = keyFor(location.pathname);
    if (!key || location.search) return;
    if (key === keyFor(lastPath)) return; // already here: user's own doing
    const search = savedFor(key);
    if (!search) return;

    let last = 0;
    try { last = Number(sessionStorage.getItem(GUARD_KEY)) || 0; } catch { /* blocked */ }
    // If Kick strips the query back off on load, this stops the two of us
    // bouncing the page between filtered and bare forever.
    if (Date.now() - last < GUARD_MS) {
      console.debug(DBG, 'skipping reload restore — one just happened');
      return;
    }
    try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch { /* blocked */ }
    console.debug(DBG, 'entered', key, 'bare — reloading with', search);
    location.replace(location.pathname + search + location.hash);
  }

  /* -------------------------------------------------------------------- */
  /* wiring                                                                */
  /* -------------------------------------------------------------------- */

  // Every URL this script has seen, in order. Without it a bug report can
  // only say "it's gone" — with it, the exact path and query Kick used are
  // right there, which is the one thing that cannot be guessed from outside.
  const trail = [];
  function note(what) {
    const at = location.pathname + location.search;
    if (trail.length && trail[trail.length - 1].url === at && trail[trail.length - 1].what === what) return;
    trail.push({ what, url: at, key: keyFor(location.pathname) });
    if (trail.length > 40) trail.shift();
  }

  function onNav() {
    readFlag();
    note('nav');
    remember(true);
    restoreByReload();
    lastPath = location.pathname;
  }

  readFlag();
  restoreInPlace();
  note('load');
  // Record straight away rather than waiting for the first poll: landing on a
  // filtered URL and clicking away inside a second would otherwise never save
  // it, which is the easiest way to lose a filter set you just picked.
  remember(false);

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
  document.addEventListener('click', onClick, true);
  // The app can also change the query without touching history (a filter
  // applied via router.replace during hydration), so poll slowly as well.
  setInterval(onNav, 1000);

  new MutationObserver(readFlag).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bpk-browse']
  });

  // Live diagnosis from the page console.
  window.__bpkBrowse = {
    get enabled() { return enabled; },
    get trail() { return trail.slice(); },
    report() {
      const out = {
        enabled,
        page: keyFor(location.pathname),
        eligible: PAGE_RE.test(location.pathname),
        current: location.search || '(none)',
        saved: loadAll()
      };
      console.log(DBG, out);
      console.table(trail);
      return out;
    },
    // Wipe the memory without touching settings.
    forget() {
      try { localStorage.removeItem(STORE_KEY); } catch { /* blocked */ }
      console.log(DBG, 'forgot every remembered filter set');
    }
  };
})();
