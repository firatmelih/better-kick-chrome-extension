/* Simple Chat for Kick — chat scroll manager.
 *
 * Runs in the PAGE world (manifest "world": "MAIN"), unlike content.js.
 * That is not a style choice: a content script gets its own JS wrappers for
 * DOM nodes, so redefining `scrollTop` there would only ever intercept our
 * own writes — never Kick's. Only a page-world script can actually take the
 * scroller away from Kick's virtual list.
 *
 * Why take it away at all: content.js drops rows (emote-only messages,
 * copypasta, sub events) with display:none. Kick's list is virtualised off
 * *remembered* row heights, so its idea of where "the bottom" is no longer
 * matches the DOM the moment a row is dropped. Its auto-scroll then aims at a
 * position that does not exist, misses, decides it is "not at the bottom",
 * and fights whatever it does next — the jumping and the stuck
 * "N new messages" chip.
 *
 * Fix: block Kick's scroll-to-bottom writes and run our own follow logic off
 * a measurement that cannot be wrong — the on-screen bottom edge of the last
 * row that is actually rendered. Plus a custom overlay scrollbar, since the
 * native one has to go with it.
 *
 * Settings come in as <html data-bpk-scroll="on|off">, written by content.js:
 * the two worlds share no variables, but they do share the DOM.
 */
(() => {
  'use strict';

  if (window.__bpkChatScroll) return;
  window.__bpkChatScroll = true;

  // Native accessors, captured before anything is patched. Every internal
  // move goes through these, so our own writes can never be blocked by our
  // own guard and can never be mistaken for Kick's.
  const NAT = {
    top: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
    scrollTo: Element.prototype.scrollTo,
    scrollBy: Element.prototype.scrollBy,
    scroll: Element.prototype.scroll,
    intoView: Element.prototype.scrollIntoView
  };
  if (!NAT.top || !NAT.top.get || !NAT.top.set) return; // nothing to stand on

  const DBG = '[Simple Chat for Kick scroll]';
  const FOLLOW_SLOP = 28;   // px from the bottom that still counts as "pinned"
  const SNAP_SLOP = 8;      // this close to the real end == the real end
  const WHEEL_MS = 170;     // wheel notch glide
  const IDLE_MS = 1100;     // scrollbar fade-out delay
  const BAR_PAD = 4;        // track inset, top and bottom
  const MIN_THUMB = 28;

  let sc = null;            // the chat scroller we own
  let inset = 0;            // its bottom padding + border
  let enabled = true;
  let follow = true;        // pinned to the newest message
  let dragging = false;
  let anim = null;          // { from, to, t0, dur, owner }
  let bar = null;
  let thumb = null;
  let idleTimer = 0;
  let ro = null;
  let mo = null;
  let lastWrite = -1;       // the last position WE put the scroller at

  // Counters, read back by __bpkScroll.report() — this thing has to be
  // diagnosable from a console on a live channel, since none of it can be
  // reproduced offline.
  const stats = { pins: 0, moved: 0, redirected: 0, held: 0, attaches: 0 };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ------------------------------------------------------------------ */
  /* geometry                                                            */
  /* ------------------------------------------------------------------ */

  const getTop = () => NAT.top.get.call(sc);
  const maxTop = () => Math.max(0, sc.scrollHeight - sc.clientHeight);

  // Every move we make goes through here, and records where it put us.
  // A scroll event landing on exactly that number is our own echo — it must
  // never be read as "the user scrolled", or a message arriving in the gap
  // between the write and the event would silently switch following off.
  function setTop(v) {
    lastWrite = v;
    NAT.top.set.call(sc, v);
  }

  // Rows, in document order. [data-index] is Kick's virtual-list wrapper;
  // .bpk-entry is content.js's own tag, which also covers older markup.
  const ROW_SEL = '[data-index],.bpk-entry';

  // The last row that actually takes up space. Tested by measured height,
  // not by class or display: that covers a row kick.css collapsed to zero
  // height, a row Kick itself hid, and any future way of dropping one.
  function isVisibleRow(el) {
    return el.getBoundingClientRect().height > 0.5;
  }

  function lastRow() {
    let rows;
    try {
      rows = sc.querySelectorAll(ROW_SEL);
    } catch {
      return null;
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isVisibleRow(rows[i])) return rows[i];
    }
    return null;
  }

  // scrollTop at which the newest visible message sits flush with the bottom
  // of the viewport. Measured, not modelled — so leftover space a virtual
  // list still reserves for rows we hid is simply scrolled past.
  // Cached because several callers per frame want it and each measurement
  // forces layout; invalidated by hand whenever a frame starts doing work.
  let btValue = 0;
  let btFresh = false;
  function bottomTop() {
    if (btFresh) return btValue;
    btFresh = true;
    const max = maxTop();
    const row = lastRow();
    if (!row) {
      btValue = max;
      return btValue;
    }
    const anchor = sc.getBoundingClientRect().bottom - inset;
    const want = clamp(getTop() + (row.getBoundingClientRect().bottom - anchor), 0, max);
    // Within a hair of the real end: prefer the real end, so Kick's own
    // "are we at the bottom" check (which reads scrollTop, not our maths)
    // agrees with us and drops its "N new messages" chip.
    btValue = max - want < SNAP_SLOP ? max : want;
    return btValue;
  }

  const nearBottom = () => bottomTop() - getTop() <= FOLLOW_SLOP;

  function measureInset() {
    try {
      const cs = getComputedStyle(sc);
      inset = (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    } catch {
      inset = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* our own scrolling                                                   */
  /* ------------------------------------------------------------------ */

  function stopAnim() {
    anim = null;
  }

  // Retargets in flight instead of restarting, so a burst of messages reads
  // as one continuous glide rather than a stutter of overlapping tweens.
  function glide(to, dur, owner) {
    to = clamp(to, 0, maxTop());
    const from = getTop();
    if (dur <= 0 || Math.abs(to - from) < 1) {
      stopAnim();
      setTop(to);
      updateBar();
      return;
    }
    if (anim) {
      anim.from = from;
      anim.to = to;
      anim.t0 = performance.now();
      anim.dur = dur;
      anim.owner = owner;
      return;
    }
    anim = { from, to, t0: performance.now(), dur, owner };
    requestAnimationFrame(step);
  }

  function step(ts) {
    if (!anim || !sc) return;
    const p = clamp((ts - anim.t0) / anim.dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    setTop(anim.from + (anim.to - anim.from) * e);
    updateBar();
    if (p < 1) {
      requestAnimationFrame(step);
      return;
    }
    // A user-driven glide that happens to end at the bottom re-arms
    // following; scroll events can't do it, since every frame of the glide
    // was our own write.
    const wasUser = anim.owner === 'user';
    anim = null;
    if (wasUser && !dragging) follow = nearBottom();
  }

  let pinQueued = false;
  function schedulePin() {
    if (pinQueued) return;
    pinQueued = true;
    requestAnimationFrame(() => {
      pinQueued = false;
      btFresh = false; // the DOM moved since last frame — measure again
      pin();
      updateBar();
    });
  }

  function pin() {
    if (!sc || !enabled || !follow || dragging || !sc.clientHeight) return;
    stats.pins++;
    const to = bottomTop();
    if (Math.abs(to - getTop()) < 1) return;
    stats.moved++;
    // Following is deliberately INSTANT, not eased. An eased catch-up spends
    // ~7 frames at positions Kick's list considers wrong, and it re-renders
    // (and repositions its rows) at every one of them — which is visible as
    // twitching. Smoothness belongs to scrolling the user asked for; a chat
    // pinning itself to the newest line should just be there, the way every
    // other chat client does it.
    if (anim && anim.owner === 'pin') {
      glide(to, anim.dur, 'pin'); // a jump-to-bottom is in flight; retarget it
      return;
    }
    setTop(to);
  }

  function toBottom(smooth) {
    follow = true;
    btFresh = false;
    glide(bottomTop(), smooth ? 220 : 0, 'pin');
  }

  /* ------------------------------------------------------------------ */
  /* taking the scroller away from Kick                                  */
  /* ------------------------------------------------------------------ */

  // The whole point of the file.
  //
  // While we are following, Kick's scroll-to-bottom is *redirected*, not
  // swallowed. Swallowing looks tempting and is wrong: a virtual list that
  // asks for a scroll and never sees one keeps asking, re-rendering its rows
  // on every retry — a fight that shows up as twitching even though our
  // final position is correct. Redirecting gives it the move it wanted, at
  // the position we measured, and its state machine settles.
  //
  // While the user is reading further up, Kick may still correct the
  // position *upwards* (it trims old messages off the top, and that
  // correction is what keeps the view from lurching) — it just may not drag
  // the user back down.
  function ownTop(el, target) {
    if (!enabled || !sc || el !== sc) {
      NAT.top.set.call(el, target);
      return;
    }
    if (follow) {
      stats.redirected++;
      setTop(bottomTop());
      return;
    }
    if (target > getTop() + 2) {
      stats.held++;
      return;
    }
    setTop(target);
  }

  // scrollTo(x, y) and scrollTo({top, left, behavior}) both land here.
  function scrollArgTop(a, b) {
    if (a && typeof a === 'object') return a.top;
    return b;
  }

  function patch(el) {
    try {
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        enumerable: false,
        get() {
          return NAT.top.get.call(this);
        },
        set(v) {
          ownTop(this, +v || 0);
        }
      });
    } catch {
      /* frozen element — the rest of the patch still helps */
    }
    el.scrollTo = function (a, b) {
      const top = scrollArgTop(a, b);
      if (top == null) return NAT.scrollTo.call(this, a, b); // horizontal only
      ownTop(this, +top || 0);
    };
    el.scroll = el.scrollTo;
    el.scrollBy = function (a, b) {
      const dy = scrollArgTop(a, b);
      if (dy == null) return NAT.scrollBy.call(this, a, b);
      ownTop(this, NAT.top.get.call(this) + (+dy || 0));
    };
  }

  function unpatch(el) {
    try {
      delete el.scrollTop;
    } catch {
      /* ignore */
    }
    delete el.scrollTo;
    delete el.scroll;
    delete el.scrollBy;
  }

  // A virtual list's other way of chasing the bottom: scroll a sentinel row
  // into view. Patched on the prototype (page world, so this is the page's
  // real prototype) but only ever acts on elements inside our scroller.
  Element.prototype.scrollIntoView = function (...args) {
    if (enabled && sc && this !== sc && sc.contains(this)) {
      if (follow) return; // we are already keeping the newest line in view
      const r = this.getBoundingClientRect();
      if (r.top > sc.getBoundingClientRect().bottom) return; // downward yank
    }
    return NAT.intoView.apply(this, args);
  };
  if (Element.prototype.scrollIntoViewIfNeeded) {
    const natIfNeeded = Element.prototype.scrollIntoViewIfNeeded;
    Element.prototype.scrollIntoViewIfNeeded = function (...args) {
      if (enabled && sc && this !== sc && sc.contains(this) && follow) return;
      return natIfNeeded.apply(this, args);
    };
  }

  /* ------------------------------------------------------------------ */
  /* input                                                               */
  /* ------------------------------------------------------------------ */

  function onScroll() {
    if (!sc) return;
    btFresh = false;
    // Three things can move this scroller and they must not be confused:
    //   - our own writes, which land on lastWrite and mean nothing new;
    //   - a glide of ours in flight, which is on its way somewhere already;
    //   - anything else, which is the user (or a page write we allowed).
    // Only the third may turn following off. Reading "not at the bottom"
    // off our own echo is how auto-scroll used to give up mid-conversation:
    // a message arriving between the write and the event is enough.
    const ours = Math.abs(getTop() - lastWrite) < 1.5;
    if (!dragging && !anim) {
      if (!ours) follow = nearBottom();
      else if (!follow && nearBottom()) follow = true;
    }
    updateBar(); // no showBar() here: our own auto-scroll must not flash it
  }

  function onWheel(e) {
    if (!enabled || !sc || e.ctrlKey) return;
    let d = e.deltaY;
    if (!d) return;
    showBar();
    // Any nudge upward lets go of the bottom, however small. Without this a
    // trackpad flick of a few px stays inside FOLLOW_SLOP, so the next
    // message drags the reader straight back down — which feels exactly like
    // the chat fighting you.
    if (d < 0) follow = false;
    if (e.defaultPrevented) return;
    if (e.deltaMode === 1) d *= 40;                    // lines
    else if (e.deltaMode === 2) d *= sc.clientHeight;  // pages
    // Trackpads and precise wheels already arrive pre-smoothed in small
    // increments; easing those a second time feels like syrup. Only real
    // notched wheels get our glide, everything else keeps native handling.
    else if (Math.abs(d) < 48) return;
    e.preventDefault();
    const base = anim && anim.owner === 'user' ? anim.to : getTop();
    glide(base + d, WHEEL_MS, 'user');
  }

  // Kick's "N new messages" chip works by asking the list to scroll to the
  // bottom — a call we now swallow, which would leave the chip dead. Catch
  // the click and do the jump ourselves instead. Listened for on the
  // document, not the scroller: the chip is an overlay *beside* the list, so
  // its clicks never reach the scroller at all. It is not always a <button>
  // either, hence walking a few ancestors rather than closest().
  const CHIP_RE =
    /new message|more message|yeni mesaj|scroll to (the )?bottom|jump to|en alta|aşağı/i;
  function onClick(e) {
    if (!enabled || !sc || follow) return;
    let el = e.target;
    for (let i = 0; el && el.nodeType === 1 && i < 4; i++, el = el.parentElement) {
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (label && label.length <= 60 && CHIP_RE.test(label)) {
        toBottom(true);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* the scrollbar                                                       */
  /* ------------------------------------------------------------------ */

  // Lives at <body> (or the fullscreen element) rather than inside the chat:
  // React owns that subtree and would eventually reconcile a foreign child
  // away. position:fixed over the scroller's rect gives the same result with
  // nothing for React to fight over.
  function host() {
    const fs = document.fullscreenElement;
    return fs && sc && fs.contains(sc) ? fs : document.body;
  }

  function makeBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'bpk-sbar';
    thumb = document.createElement('div');
    thumb.className = 'bpk-sthumb';
    bar.appendChild(thumb);
    thumb.addEventListener('pointerdown', onThumbDown);
    host().appendChild(bar);
  }

  function killBar() {
    if (!bar) return;
    bar.remove();
    bar = null;
    thumb = null;
  }

  // Only ever called for something the user did — pointer in the chat, a
  // wheel, a drag. Notably NOT for chat auto-scrolling: showing the bar
  // every time a message arrives means it pulses on and off all day, which
  // reads as flickering in its own right.
  function showBar() {
    if (!bar) return;
    const was = bar.classList.contains('bpk-on');
    bar.classList.add('bpk-on');
    if (!was) updateBar();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!dragging && bar) bar.classList.remove('bpk-on');
    }, IDLE_MS);
  }

  function updateBar() {
    if (!bar || !sc) return;
    // Invisible: skip it. Measuring the scroller on every message just to
    // move something nobody can see is pure layout thrash.
    if (!bar.classList.contains('bpk-on')) return;
    if (!sc.isConnected || !sc.clientHeight) {
      bar.style.display = 'none';
      return;
    }
    const r = sc.getBoundingClientRect();
    if (r.width < 40 || r.height < 60) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = '';
    bar.style.top = r.top + 'px';
    bar.style.left = r.right - 12 + 'px';
    bar.style.height = r.height + 'px';

    const track = r.height - BAR_PAD * 2;
    // Measured against *our* bottom, so a pinned chat shows the thumb parked
    // at the end even when the virtual list still reserves space below it.
    const top = getTop();
    const max = Math.max(bottomTop(), top);
    if (max < 1 || track < MIN_THUMB) {
      thumb.style.height = '0px';
      return;
    }
    const h = clamp(Math.round((track * sc.clientHeight) / sc.scrollHeight), MIN_THUMB, track);
    const y = BAR_PAD + clamp(top / max, 0, 1) * (track - h);
    thumb.style.height = h + 'px';
    thumb.style.transform = 'translateY(' + Math.round(y) + 'px)';
  }

  function onThumbDown(e) {
    if (!sc || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    stopAnim();
    bar.classList.add('bpk-drag', 'bpk-on');
    document.documentElement.style.setProperty('user-select', 'none');
    try {
      thumb.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    const startY = e.clientY;
    const startTop = getTop();
    const h = thumb.offsetHeight;

    const move = (ev) => {
      btFresh = false;
      const track = sc.getBoundingClientRect().height - BAR_PAD * 2;
      const span = Math.max(1, track - h);
      const max = Math.max(bottomTop(), startTop);
      setTop(clamp(startTop + ((ev.clientY - startY) / span) * max, 0, maxTop()));
      follow = nearBottom();
      updateBar();
    };
    const up = () => {
      dragging = false;
      bar.classList.remove('bpk-drag');
      document.documentElement.style.removeProperty('user-select');
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      follow = nearBottom();
      showBar();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  /* ------------------------------------------------------------------ */
  /* attach / detach                                                     */
  /* ------------------------------------------------------------------ */

  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    let ov;
    try {
      ov = getComputedStyle(el).overflowY;
    } catch {
      return false;
    }
    return ov === 'auto' || ov === 'scroll' || ov === 'overlay';
  }

  // A box big enough to be the chat viewport that scrolls its overflow.
  // Deliberately does NOT require scrollHeight > clientHeight: a chat with
  // three messages in it does not overflow yet, and skipping past it to
  // whatever DOES overflow higher up means owning the page scroller instead
  // of the message list — with the real list still auto-scrolling itself.
  function scrollHost(el) {
    return el.clientHeight >= 120 && isScrollable(el);
  }

  const SEED_SEL =
    '#chatroom-messages,#chatroom,[data-chat-messages],[class*="chatroom" i]:not([class*="--chatroom" i])';

  // Found by walking UP from an actual chat row: a row's scroller is by
  // definition its nearest scrollable ancestor, and that is not a guess.
  // Selector-matching the panel is the fallback, for a chat with no rows in
  // it yet.
  function findScroller() {
    let row = null;
    try {
      row =
        document.querySelector(
          '#chatroom-messages [data-index],#chatroom-messages .bpk-entry,' +
            '[data-index][style*="--chatroom-font-size"]'
        ) || document.querySelector(ROW_SEL);
    } catch {
      /* ignore */
    }
    let p = row ? row.parentElement : null;
    for (let i = 0; p && p !== document.body && i < 14; i++, p = p.parentElement) {
      if (scrollHost(p)) return p;
    }

    let seeds;
    try {
      seeds = document.querySelectorAll(SEED_SEL);
    } catch {
      return null;
    }
    for (const seed of seeds) {
      if (scrollHost(seed)) return seed;
      let q = seed.parentElement;
      for (let i = 0; q && q !== document.body && i < 6; i++, q = q.parentElement) {
        if (scrollHost(q)) return q;
      }
    }
    return null;
  }

  // The class is what kick.css hangs the hidden-scrollbar rules on; the
  // inline copies cover the case where React rewrites className out from
  // under us before the observer below puts it back. Every write is guarded
  // by a read, because writing an unchanged value would still notify our own
  // MutationObserver — which calls this — and that loop never ends.
  // NB: overflow-anchor is deliberately NOT disabled. Browser scroll
  // anchoring is on our side here — while the user is scrolled up reading,
  // it is the thing that keeps the view still when content.js collapses a
  // row *above* the viewport 220ms after painting it. While we are following
  // the bottom, our own correction overrides it anyway.
  const OUR_STYLE = [
    ['scrollbar-width', 'none'],
    ['scroll-behavior', 'auto'],   // the glide is ours; CSS smooth-scroll would fight it
    ['overscroll-behavior', 'contain']
  ];

  function keepOurStyles() {
    if (!sc) return;
    if (!sc.classList.contains('bpk-scroller')) sc.classList.add('bpk-scroller');
    for (const [prop, val] of OUR_STYLE) {
      if (sc.style.getPropertyValue(prop) !== val) sc.style.setProperty(prop, val);
    }
  }

  function attach(el) {
    if (sc === el) return;
    detach();
    sc = el;
    stats.attaches++;
    console.log(DBG, 'attached to', el, '— run __bpkScroll.report() to inspect');
    measureInset();
    patch(sc);
    keepOurStyles();

    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('wheel', onWheel, { passive: false });
    sc.addEventListener('mouseenter', showBar);
    sc.addEventListener('mousemove', showBar, { passive: true });

    try {
      ro = new ResizeObserver(() => {
        measureInset();
        schedulePin();
      });
      ro.observe(sc);
      if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    } catch {
      /* no ResizeObserver */
    }

    // Anything that changes the rendered height of the list — a message
    // arriving, content.js collapsing a row 220ms later, the virtual list
    // repositioning — has to re-pin.
    mo = new MutationObserver(() => {
      keepOurStyles();
      // Corrected in the same microtask checkpoint the mutation arrived in —
      // that is, before this frame's layout and paint. Deferring to rAF
      // instead means a row content.js just collapsed gets painted once at
      // the old offset and only then corrected: a one-frame jump, which is
      // exactly what a twitch is. pin() reads no layout at all unless we are
      // actually following, so React's attribute churn stays cheap.
      btFresh = false;
      pin();
      schedulePin(); // backstop, for heights that settle later in the frame
    });
    mo.observe(sc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-index']
    });

    makeBar();
    follow = true;
    schedulePin();
  }

  function detach() {
    if (!sc) return;
    if (ro) { ro.disconnect(); ro = null; }
    if (mo) { mo.disconnect(); mo = null; }
    sc.removeEventListener('scroll', onScroll);
    sc.removeEventListener('wheel', onWheel);
    sc.removeEventListener('mouseenter', showBar);
    sc.removeEventListener('mousemove', showBar);
    unpatch(sc);
    sc.classList.remove('bpk-scroller');
    for (const [prop] of OUR_STYLE) sc.style.removeProperty(prop);
    stopAnim();
    sc = null;
    killBar();
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function readFlag() {
    const html = document.documentElement;
    // absent = on, so a missed handshake fails useful. Just chat covers
    // Kick's list with its own, so there is nothing here to manage then.
    const on =
      html.getAttribute('data-bpk-scroll') !== 'off' &&
      html.getAttribute('data-bpk-just') !== 'on';
    if (on === enabled) return;
    enabled = on;
    if (!enabled) detach();
    else sweep();
  }

  // If we and Kick's list are pulling against each other, the position moves
  // far more often than messages arrive. Say so once — a silent fight is the
  // hardest kind to diagnose from a bug report.
  let lastMoved = 0;
  let warnedFight = false;
  function checkFight() {
    const moved = stats.moved - lastMoved;
    lastMoved = stats.moved;
    if (warnedFight || moved < 60) return; // 60 corrections in 800ms is not chat
    warnedFight = true;
    console.warn(
      DBG,
      'the chat list appears to be fighting the takeover (' + moved + ' corrections in 0.8s).',
      'Run __bpkScroll.report() and check deadSpace/hiddenRows.'
    );
  }

  // Kick is a SPA: the chat panel is torn down and rebuilt on every channel
  // change, so ownership has to be re-taken rather than set up once.
  function sweep() {
    if (!enabled) return;
    checkFight();
    if (sc && sc.isConnected && isScrollable(sc)) return;
    const found = findScroller();
    if (found) attach(found);
    else if (sc && !sc.isConnected) detach();
  }

  // Live diagnosis from the page console — none of this can be reproduced
  // without a real channel open, so the extension has to be able to say what
  // it thinks is going on.
  window.__bpkScroll = {
    get el() {
      return sc;
    },
    report() {
      const out = { version: '1.3.2', attached: !!sc, enabled, follow, dragging };
      if (sc) {
        btFresh = false;
        let rows = 0;
        let hidden = 0;
        for (const r of sc.querySelectorAll(ROW_SEL)) {
          rows++;
          if (!isVisibleRow(r)) hidden++;
        }
        Object.assign(out, {
          scroller: (sc.tagName + (sc.id ? '#' + sc.id : '') + '.' + (sc.className || '')).slice(0, 120),
          scrollTop: Math.round(getTop()),
          ourBottom: Math.round(bottomTop()),
          nativeBottom: Math.round(maxTop()),
          clientHeight: sc.clientHeight,
          scrollHeight: sc.scrollHeight,
          rows,
          hiddenRows: hidden,
          // A big gap here is the smoking gun for the virtual list's height
          // model disagreeing with the DOM after rows were dropped.
          deadSpace: Math.round(maxTop() - bottomTop())
        });
      }
      Object.assign(out, stats);
      console.log(DBG, out);
      return out;
    },
    // Turns the takeover off without touching settings, to A/B it live.
    off() {
      enabled = false;
      detach();
      console.log(DBG, 'off — reload the page or call __bpkScroll.on() to restore');
    },
    on() {
      enabled = true;
      sweep();
    }
  };

  function boot() {
    readFlag();
    sweep();
    setInterval(sweep, 800);
    document.addEventListener('click', onClick, true);
    new MutationObserver(readFlag).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bpk-scroll', 'data-bpk-just']
    });
    addEventListener('resize', () => { measureInset(); schedulePin(); });
    // The bar is position:fixed over the scroller's rect, so anything that
    // moves that rect (page scroll, theatre mode) has to move the bar too —
    // but only while it is actually on screen.
    addEventListener(
      'scroll',
      (e) => { if (e.target !== sc && bar && bar.classList.contains('bpk-on')) updateBar(); },
      true
    );
    addEventListener('fullscreenchange', () => {
      if (bar) host().appendChild(bar);
      updateBar();
    });
    // Coming back to a hidden tab: rAF was frozen, so the glide never ran.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { stopAnim(); pin(); updateBar(); }
    });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
