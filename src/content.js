/* Better Kick — content script
 *
 * Design note: almost all *hiding* is done by kick.css, not by this script.
 * Kick's chat is a React list that recycles DOM nodes, so deleting nodes (or
 * stamping per-node "hidden" classes) fights the framework and can crash it.
 * Instead JS only does the few things CSS cannot:
 *   1. tag chat entries / containers so CSS has a stable hook
 *   2. hide sub / gift-sub controls that are only identifiable by their text
 *   3. repaint Kick-green computed colors into purple
 *
 * Plain-text chat is not done here either: "Just chat" (justchat.js) draws
 * its own list over Kick's instead of editing Kick's rows.
 */
(() => {
  'use strict';

  const PURPLE = 'rgb(145, 71, 255)';

  // What the popup stores: four switches, each covering a group of features.
  const SETTINGS = {
    simpleChat: true,       // just chat, no subs/pinned/drops clutter, no animations
    showDeleted: true,      // deleted messages stay visible + the deleted-messages log
    rememberSettings: true, // 1080p, collapsed panels, browse filters
    purpleTheme: true       // purple instead of Kick green
  };

  // The individual features each switch turns on. Everything below reads
  // these, not the switches.
  function derive(g) {
    return {
      justChat: g.simpleChat,       // own chat list: "username: text", nothing else
      hideSubs: g.simpleChat,       // subscribe / gift-sub UI and sub event messages
      hideDrops: g.simpleChat,      // drops / daily-reward chest, top bar and sidebar
      hidePinned: g.simpleChat,     // pinned messages, highlights, celebrations
      killAnimations: g.simpleChat, // no animations/transitions in chat
      smoothScroll: g.simpleChat,   // own auto-scroll for Kick's list (idle under just chat)
      monoUsernames: false,         // force all usernames to one flat color
      hideTimestamps: false,
      deletedLog: g.showDeleted,    // deleted messages kept, highlighted, and logged
      force1080: g.rememberSettings,      // keep the player at 1080p
      rememberBrowse: g.rememberSettings, // restore the last browse filters (language, sort)
      rememberPanels: g.rememberSettings, // restore the sidebar + chat collapsed state
      purpleTheme: g.purpleTheme    // purple theme instead of Kick green
    };
  }

  // settings key -> <html> attribute that kick.css keys off of
  const FLAGS = {
    justChat: 'data-bpk-just',
    hideSubs: 'data-bpk-subs',
    hideDrops: 'data-bpk-drops',
    hidePinned: 'data-bpk-pinned',
    killAnimations: 'data-bpk-anim',
    purpleTheme: 'data-bpk-theme',
    monoUsernames: 'data-bpk-mono',
    hideTimestamps: 'data-bpk-notime',
    // Read by justchat.js / chatscroll.js / quality.js / browse.js / chatlog.js, which run
    // in the page world and so share no variables with this script — only the
    // DOM.
    deletedLog: 'data-bpk-dellog',
    smoothScroll: 'data-bpk-scroll',
    force1080: 'data-bpk-1080',
    rememberBrowse: 'data-bpk-browse'
  };

  let G = Object.assign({}, SETTINGS);
  let S = derive(G);

  /* ------------------------------------------------------------------ */
  /* selectors                                                           */
  /* ------------------------------------------------------------------ */

  // One selector below needs ":has()". A browser without it must never see
  // that selector: one bad member makes the whole comma-joined query throw,
  // which would silently kill even the selectors that do work.
  let hasSupport = false;
  try {
    document.querySelector('div:has(> span)');
    hasSupport = true;
  } catch {
    /* no :has() */
  }

  // Precise: these match a row and never a piece of one ("chat-entry-content"
  // is a different class token from "chat-entry", and ~= compares tokens).
  // Current Kick (2025+) rows are virtualised [data-index] wrappers whose
  // message body carries an inline "--chatroom-font-size" style — the last
  // two selectors are that DOM.
  const ENTRY_SEL_STRICT = [
    '[data-chat-entry]',
    '[data-chat-id]',
    '[data-message-id]',
    '[data-chat-entry-id]',
    '.chat-entry',
    '[class~="chat-message"]',
    '[class~="chatMessage"]',
    '[data-index][style*="--chatroom-font-size"]'
  ]
    .concat(hasSupport ? ['[data-index]:has([style*="--chatroom-font-size"])'] : [])
    .join(',');

  // Loose fallback, only used when nothing precise exists on the page.
  const ENTRY_SEL_LOOSE = [
    ENTRY_SEL_STRICT,
    '[class*="chat-entry" i]',
    '[class*="chat-message" i]',
    '[class*="chatMessage" i]',
    'div[style*="--chatroom-font-size"]',
    '#chatroom-messages > div',
    '#chatroom-messages > div > div'
  ].join(',');

  let entrySelCache = null;
  function entrySel() {
    if (entrySelCache) return entrySelCache;
    try {
      if (document.querySelector(ENTRY_SEL_STRICT)) entrySelCache = ENTRY_SEL_STRICT;
    } catch {
      /* ignore */
    }
    return entrySelCache || ENTRY_SEL_LOOSE;
  }

  // ":not([class*='--chatroom'])" keeps Tailwind arbitrary values out: emote
  // and row classes like w-[calc(var(--chatroom-font-size)*56/13)] contain
  // the substring "chatroom" but are message pieces, not the chatroom.
  const CHATROOM_SEL = [
    '#chatroom',
    '#chatroom-messages',
    '#chatroom-top',
    '[id*="chatroom" i]',
    '[data-chatroom]',
    '[class*="chatroom" i]:not([class*="--chatroom" i])',
    '[class*="chat-container" i]'
  ].join(',');

  const IDENT_SEL = [
    '.chat-entry-username',
    '[class*="chat-message-identity" i]',
    '[class*="identity" i]',
    '[class*="username" i]',
    '[class*="user-name" i]',
    '[class*="userName" i]',
    '[class*="sender" i]',
    '[class*="author" i]',
    '[class*="nick" i]',
    '[data-username]',
    '[data-user-id]',
    '[data-chat-entry-user]',
    '[data-chat-entry-user-id]',
    // Current Kick: the username is a classless <button> that carries the
    // viewer's chat colour inline and opts out of message-expand.
    'button[data-prevent-expand]',
    'button[style^="color" i]'
  ].join(',');

  // Buttons/links that are only recognisable by the words inside them.
  const SUB_TEXT_RE =
    /^(subscribe|subscribed|resubscribe|gift(\s+a)?\s+sub(s|scription)?|gift\s+subs?|sub\s+gift|gifted\s+subs?|gift|subscription|become\s+a\s+subscriber|subscribe\s+now|send\s+kicks?|buy\s+kicks?|kicks)\b/i;

  // Drops / daily-reward controls, matched on the whole label so a message or
  // a channel called "drops" is never touched. The top-bar chest button is
  // icon-only and its aria-label is localised, so the Turkish wording is
  // matched as well ("Günlük Ödülünü Al" = claim your daily reward). \w is
  // ASCII-only in JS, hence \S* for the Turkish suffixes.
  const DROP_TEXT_RE =
    /^(drops?|daily\s+drops?|daily\s+rewards?|daily\s+bonus|rewards?|claim(\s+your)?\s+daily(\s+\S+){0,2}|günlük\s+ödül\S*(\s+al)?|ödül\S*|hediye\S*)$/i;

  // Chat *events* generated by Kick for subs/gifts/celebrations/Kicks.
  const SUB_EVENT_RE =
    /(gifted\s+(a\s+)?(\d+\s+)?sub|just\s+subscribed|is\s+now\s+a\s+subscriber|subscribed\s+for\s+\d+|has\s+(re)?subscribed|months?\s+in\s+a\s+row|welcome\s+to\s+the\s+sub|tier\s*[123]\s+sub|gifted\s+\d+|sub\s+gift|thank\s+you\s+for\s+subscribing|sent\s+[\d.,\s]*kicks?\b|kicks?\s+leaderboard)/i;

  /* ------------------------------------------------------------------ */
  /* emoji                                                               */
  /* ------------------------------------------------------------------ */

  const EMOJI_SRC =
    '[\\u{1F3FB}-\\u{1F3FF}]' +                  // skin tone modifiers
    '|[0-9#*]\\uFE0F?\\u20E3' +                  // keycaps
    '|[\\u{1F1E6}-\\u{1F1FF}]' +                 // regional indicators (flags)
    '|\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?' +
    '(\\u200D\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?)*' +
    '|[\\uFE0F\\uFE0E\\u200D]';                  // stray VS / ZWJ leftovers

  const EMOJI_RE = new RegExp(EMOJI_SRC, 'gu');

  /* ------------------------------------------------------------------ */
  /* tagging                                                             */
  /* ------------------------------------------------------------------ */

  // classList.add/remove writes the class attribute even when nothing changes,
  // which our own MutationObserver would then pick up — so never write unless
  // the class actually needs to change.
  function addClass(el, cls) {
    if (!el.classList.contains(cls)) el.classList.add(cls);
  }

  function removeClass(el, cls) {
    if (el.classList.contains(cls)) el.classList.remove(cls);
  }

  function tagChatrooms(root) {
    let found = 0;
    for (const el of qsa(root, CHATROOM_SEL)) {
      addClass(el, 'bpk-chatroom');
      found++;
    }
    // Strip the tag from anything that no longer qualifies (e.g. emote
    // wrappers that used to slip in through Tailwind arbitrary values).
    for (const el of qsa(root, '.bpk-chatroom')) {
      try {
        if (!el.matches(CHATROOM_SEL)) removeClass(el, 'bpk-chatroom');
      } catch {
        /* ignore */
      }
    }
    return found;
  }

  // Count identity elements, ignoring ones nested inside another identity
  // element (Kick wraps a username span inside an identity span).
  function countIdentities(el) {
    let n = 0;
    for (const id of el.querySelectorAll(IDENT_SEL)) {
      let p = id.parentElement;
      let nested = false;
      while (p && p !== el) {
        if (p.matches(IDENT_SEL)) { nested = true; break; }
        p = p.parentElement;
      }
      if (!nested && ++n > 3) return n;
    }
    return n;
  }

  // The loose selector deliberately matches broadly, so it also hits pieces *inside* a
  // row ("chat-entry-content") and containers *around* it. A row is the
  // outermost match that still holds only a few identity-ish elements — a real
  // row has one username but may add a reply-target or an @mention, while a
  // container of rows has dozens.
  function isRowLike(el) {
    try {
      if (el.matches(CHATROOM_SEL)) return false;
    } catch {
      return false;
    }
    // A real row never contains another row; a container does — and this
    // catches containers holding too few messages for the identity count
    // below to reject. Always tested with the STRICT selector: the loose one
    // deliberately matches pieces inside a row and would reject every row.
    try {
      if (el.querySelector(ENTRY_SEL_STRICT)) return false;
    } catch {
      /* ignore */
    }
    const idents = countIdentities(el);
    // No username AND no text at all: an empty container or a loading
    // skeleton, not a row. Tagging one of these at boot is what used to
    // swallow every row Kick later rendered inside it.
    if (idents === 0 && !el.textContent.trim()) return false;
    return idents <= 3;
  }

  function hasEntryAncestor(el, candidates) {
    let p = el.parentElement;
    while (p) {
      if (candidates.has(p) || p.classList.contains('bpk-entry')) return true;
      p = p.parentElement;
    }
    return false;
  }

  // A container tagged as a row while it was empty (or held one message)
  // swallows every row later rendered inside it: hasEntryAncestor skips them
  // all, so per-row processing never runs and emote-only messages survive as
  // stranded "username:" lines. Anything tagged that no longer looks like a
  // row lost that status — untag it, both under root and on root's ancestor
  // chain, so the real rows get tagged individually.
  function demoteStaleEntries(root) {
    for (const el of qsa(root, '.bpk-entry')) {
      if (!isRowLike(el)) {
        removeClass(el, 'bpk-entry');
        removeClass(el, 'bpk-hide-row');
        clearRowFlips(el);
      }
    }
    let p = root.nodeType === 1 ? root.parentElement : null;
    while (p) {
      if (p.classList.contains('bpk-entry') && !isRowLike(p)) {
        removeClass(p, 'bpk-entry');
        removeClass(p, 'bpk-hide-row');
        clearRowFlips(p);
      }
      p = p.parentElement;
    }
  }

  function tagEntries(root) {
    demoteStaleEntries(root);
    const candidates = qsa(root, entrySel()).filter(isRowLike);
    const set = new Set(candidates);
    let tagged = 0;
    // Document order guarantees ancestors are visited before descendants.
    for (const el of candidates) {
      if (hasEntryAncestor(el, set)) continue;
      addClass(el, 'bpk-entry');
      processEntry(el, true); // brand new node: nothing to debounce against
      tagged++;
    }
    return tagged;
  }

  // `immediate` distinguishes a row's first-ever processing (true — nothing
  // was rendered before this, so acting right away can't desync anything)
  // from a re-evaluation of a row Kick already painted (false — see
  // setRowClass for why that path is debounced).
  function processEntry(entry, immediate) {
    // One malformed row must never take down the whole scan.
    try {
      markSubEvent(entry, immediate); // unconditional: must also UNmark on recycle
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[Better Kick] row processing failed:', err, entry);
      }
    }
  }

  let warned = false;

  // entry -> Map(class name -> pending timer id)
  const flipTimers = new WeakMap();
  const FLIP_DEBOUNCE_MS = 220;

  function clearRowFlips(entry) {
    const timers = flipTimers.get(entry);
    if (!timers) return;
    for (const t of timers.values()) clearTimeout(t);
    flipTimers.delete(entry);
  }

  // Adds/removes `cls` on `entry`. `immediate` applies it right away — used
  // for a row's first paint, where there is no earlier Kick-observed size to
  // conflict with. Otherwise the change only commits once it has held for
  // FLIP_DEBOUNCE_MS: Kick's own re-renders churn row attributes constantly
  // (see scanShallow), and a badge/emote can genuinely vanish from the DOM
  // for a single frame mid-render. Without this debounce, that instant reads
  // as "the message just became empty", flips display:none straight back on,
  // and un-flips again next frame — a real, repeated resize each time, which
  // is exactly what desyncs Kick's virtualized list and produces the
  // flicker/"N new messages" bug. A genuine, held-stable change (a recycled
  // row now showing a different message, or a message that really trails
  // off into nothing) still collapses fully — just not on a single frame's
  // say-so.
  function setRowClass(entry, cls, on, immediate) {
    const already = entry.classList.contains(cls);
    if (immediate) {
      const timers = flipTimers.get(entry);
      if (timers) { clearTimeout(timers.get(cls)); timers.delete(cls); }
      if (on) addClass(entry, cls); else removeClass(entry, cls);
      return;
    }
    if (already === on) {
      const timers = flipTimers.get(entry);
      if (timers && timers.has(cls)) { clearTimeout(timers.get(cls)); timers.delete(cls); }
      return;
    }
    let timers = flipTimers.get(entry);
    if (!timers) { timers = new Map(); flipTimers.set(entry, timers); }
    clearTimeout(timers.get(cls));
    timers.set(cls, setTimeout(() => {
      timers.delete(cls);
      if (entry.isConnected) { if (on) addClass(entry, cls); else removeClass(entry, cls); }
    }, FLIP_DEBOUNCE_MS));
  }

  // Kick renders sub/gift/Kicks events as chat rows with no user identity
  // element. Only those get text-matched, so a viewer typing "subscribe to
  // my yt" keeps their message. The class is also *removed* when the row no
  // longer matches, so a recycled row can't stay hidden on the wrong
  // message. See setRowClass for the debounce that keeps this collapse from
  // fighting Kick's virtualized list.
  function markSubEvent(entry, immediate) {
    let hide = false;
    if (S.hideSubs) {
      const isEvent =
        !entry.querySelector(IDENT_SEL) ||
        /sub|gift|kicks|celebrat|reward|kick[-_]?highlight/i.test(entry.className || '');
      if (isEvent) {
        const txt = (entry.textContent || '').replace(/\s+/g, ' ').trim();
        hide = !!txt && SUB_EVENT_RE.test(txt);
      }
    }
    setRowClass(entry, 'bpk-hide-row', hide, immediate);
  }

  /* ------------------------------------------------------------------ */
  /* subscribe / gift-sub / drops controls found by their label          */
  /* ------------------------------------------------------------------ */

  const CLICKABLE_SEL = 'button, a, [role="button"], [role="menuitem"]';
  const EMPTY_SET = new Set();

  function hideLabelledControls(root) {
    for (const el of qsa(root, CLICKABLE_SEL)) {
      if (el.classList.contains('bpk-hide') || el.classList.contains('bpk-drop-hide')) {
        continue;
      }
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!label || label.length > 40) continue;
      if (S.hideSubs && SUB_TEXT_RE.test(label)) {
        addClass(el, 'bpk-hide');
        continue;
      }
      // Tagged whether or not the feature is on: the class it gets is gated in
      // CSS, so the popup toggle works live in both directions, while
      // .bpk-hide above is ungated and only ever goes one way.
      // Nothing inside chat is a drops control, and a username is a <button>
      // whose whole text is that name — so a viewer called "Drops" would
      // otherwise have their name hidden on every line they post.
      if (
        DROP_TEXT_RE.test(label) &&
        !el.closest('.bpk-entry, .bpk-chatroom, #chatroom-messages, #chatroom')
      ) {
        hideDropItem(el);
      }
    }
  }

  // A sidebar entry is a link inside a wrapper (a <li>, or a div holding the
  // row's own padding). Hiding only the link leaves that wrapper behind as a
  // gap in the nav, so the tag walks up while the element is its parent's
  // only child — which stops immediately on a wrapper that holds anything
  // else, so a whole nav section is never taken down with one item.
  function hideDropItem(el) {
    addClass(el, 'bpk-drop-hide');
    let p = el.parentElement;
    for (let i = 0; i < 3 && p && p !== document.body; i++) {
      if (p.children.length !== 1) break;
      try {
        if (p.matches(CHATROOM_SEL) || p.tagName === 'NAV') break;
      } catch {
        break;
      }
      addClass(p, 'bpk-drop-hide');
      p = p.parentElement;
    }
  }

  /* ------------------------------------------------------------------ */
  /* green -> purple repaint                                             */
  /* ------------------------------------------------------------------ */

  const COLOR_PROPS = [
    'color',
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'text-decoration-color',
    'caret-color',
    'column-rule-color',
    'fill',
    'stroke',
    // Kick's verified badge is an <svg> whose <path> is filled with
    // url(#VerifiedBadge__a) — a <linearGradient> whose green lives in
    // <stop stop-color="#1eff00">. Computed 'fill' on the path is the url(),
    // never a colour, so the badge was invisible to this pass. stop-color is a
    // real CSS property on <stop>, so reading it here and writing an inline
    // one back (inline beats the presentation attribute) recolours the
    // gradient itself.
    'stop-color',
    'flood-color'
  ];

  // Generation, not a plain "seen" set. An element's colours are not fixed at
  // first sight: React restyles, a lazily-loaded stylesheet lands, a card
  // hydrates into its live state. Checking each element exactly once meant
  // anything that turned green *after* we looked stayed green forever — which
  // is what left LIVE pills and buttons green on the browse page. The sweep
  // bumps the generation so everything gets looked at again.
  const paintGen = new WeakMap();
  let generation = 0;
  const RGB_RE = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/;

  // Anchored: only a value that is *entirely* a hex colour. A box-shadow or a
  // gradient is a longer string that happens to contain colours, and those
  // still fall through to the rgb() branch, which finds the first one.
  const HEX_RE = /^#([0-9a-f]{3,8})$/i;

  // Computed styles always come back as rgb(), but SVG presentation
  // attributes (stop-color="#1eff00") do not go through the cascade, so a hex
  // has to be readable directly.
  function parseRgb(value) {
    if (!value) return null;
    const v = String(value).trim();
    const hex = HEX_RE.exec(v);
    if (hex) {
      let h = hex[1];
      if (h.length === 3 || h.length === 4) {
        h = h.slice(0, 3).split('').map((c) => c + c).join('');
      }
      if (h.length < 6) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
      };
    }
    const m = RGB_RE.exec(v);
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }

  function isKickGreen(value) {
    const c = parseRgb(value);
    if (!c) return false;
    // Kick brand green is #53FC18, the verified badge runs #1EFF00 -> #00FF8C.
    // Catch the whole lime/green family.
    return c.g > 150 && c.r < c.g - 60 && c.b < c.g - 60;
  }

  function greenToPurple(value) {
    return value.replace(
      /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(\s*[,/]\s*([\d.]+%?))?\s*\)/g,
      (full, r, g, b, _tail, alpha) => {
        if (!isKickGreen(`rgb(${r},${g},${b})`)) return full;
        return alpha ? `rgba(145, 71, 255, ${alpha})` : PURPLE;
      }
    );
  }

  // ::before / ::after cannot take an inline style, and getComputedStyle(el)
  // never reports them — so a pill whose green is a pseudo-element (the dot on
  // a LIVE badge is the classic one) was invisible to the whole repaint pass.
  // The host gets a class instead and kick.css paints the pseudo through it.
  const PSEUDO = [
    { sel: '::before', cls: 'bpk-pb' },
    { sel: '::after', cls: 'bpk-pa' }
  ];
  const PSEUDO_PROPS = [
    { prop: 'background-color', suffix: '-bg' },
    { prop: 'color', suffix: '-fg' },
    { prop: 'border-top-color', suffix: '-bd' },
    { prop: 'border-bottom-color', suffix: '-bd' },
    { prop: 'border-left-color', suffix: '-bd' },
    { prop: 'border-right-color', suffix: '-bd' }
  ];

  const PSEUDO_SUFFIXES = ['-bg', '-fg', '-bd'];
  const pseudoTagged = new WeakSet(); // elements that carry a bpk-p* class

  function repaintPseudo(el) {
    for (const { sel, cls } of PSEUDO) {
      let cs;
      try {
        cs = getComputedStyle(el, sel);
      } catch {
        continue;
      }
      // 'none' means the pseudo is not generated at all, so there is nothing
      // on screen to recolour.
      if (!cs || cs.content === 'none') continue;
      for (const { prop, suffix } of PSEUDO_PROPS) {
        if (!isKickGreen(cs.getPropertyValue(prop))) continue;
        addClass(el, cls + suffix);
        pseudoTagged.add(el);
      }
    }
  }

  // Which inline properties this pass wrote, per element — together with the
  // declaration that was sitting there before, so taking the write back off
  // puts Kick's own value back rather than deleting it. removeProperty() was
  // destructive: Kick writes username colours as inline style="color: ...",
  // setProperty replaced that declaration outright, and the clear then left
  // the element with no colour at all. The next measurement found nothing
  // green to repaint, so a recycled chat row came back green and stayed a
  // different colour on every pass through the list.
  const paintedProps = new WeakMap(); // el -> [{ prop, value, priority }]

  // class + style attribute as they stood when the paint was written. If both
  // are still the same, nothing that could change the answer has happened.
  const paintSig = new WeakMap();

  function paintSignature(el) {
    // Separated by a character neither attribute can contain, so a token
    // moving from one to the other cannot read as "unchanged".
    return (el.getAttribute('class') || '') + '\u0000' + (el.getAttribute('style') || '');
  }

  // Stripping the paint off to look underneath it is only invisible while the
  // intermediate state is never rendered. It is not: getComputedStyle below
  // forces a style recalc, which commits the green the clear just exposed, and
  // for any element Kick gave a colour transition the engine starts animating
  // towards it. Writing purple straight after does not cancel that — it starts
  // a second transition from wherever the first one got to. That is the
  // purple -> green -> purple flash, once every sweep, on exactly the elements
  // with a transition on them (buttons, links, the LIVE pill).
  //
  // Pinning transitions off for the length of the measurement means no
  // intermediate state is ever animated. The pin comes back off only after a
  // second forced recalc has committed the final colour: re-enabling
  // transitions while the engine still holds green as the previous value would
  // start the same animation the moment anything else touches the element.
  // Pinned through a class rather than an inline property, because
  // ::before / ::after carry their own transitions and no inline style can
  // reach them — and a pseudo is where half of Kick's green lives (the dot on
  // a LIVE pill is the classic one).
  function suppressTransitions(el) {
    addClass(el, 'bpk-measuring');
    return () => {
      try {
        getComputedStyle(el).getPropertyValue('color');
      } catch {
        /* element went away mid-pass */
      }
      removeClass(el, 'bpk-measuring');
    };
  }

  // The pass used to only ever ADD inline styles. That is fine while an
  // element's colours are fixed and wrong the moment they are not: Kick's
  // browse tabs move the "active" classes from one <a> to the next, so a tab
  // that had just gone inactive kept the purple written for it and carried on
  // looking active — two tabs underlined at once, and the newly active one
  // still green until the next pass caught up.
  //
  // Clearing before re-measuring is what makes the pass reversible. It has to
  // happen before getComputedStyle, or the read returns our own purple and the
  // element looks like it was never green.
  function clearPaint(el) {
    const props = paintedProps.get(el);
    if (props) {
      for (const { prop, value, priority } of props) {
        if (value) el.style.setProperty(prop, value, priority);
        else el.style.removeProperty(prop);
      }
      paintedProps.delete(el);
    }
    paintSig.delete(el);
    if (pseudoTagged.has(el)) {
      for (const { cls } of PSEUDO) {
        for (const suffix of PSEUDO_SUFFIXES) removeClass(el, cls + suffix);
      }
      pseudoTagged.delete(el);
    }
  }

  // Theme switched off: every inline colour this pass wrote comes back out.
  // One walk of the document on a toggle the user rarely touches, in exchange
  // for the theme actually turning off without a reload.
  function clearAllPaint() {
    for (const el of document.querySelectorAll('*')) clearPaint(el);
  }

  function repaint(el) {
    if (!S.purpleTheme || !el || el.nodeType !== 1) return;
    if (paintGen.get(el) === generation) return;
    paintGen.set(el, generation);

    const painted = paintedProps.has(el) || pseudoTagged.has(el);
    // Already purple, and neither its classes nor its style attribute have
    // moved since: the answer cannot have changed, so there is nothing to gain
    // from stripping the paint off and looking underneath again. The sweep
    // bumps the generation to catch elements that turn green *later*, and
    // those are the unpainted ones, which are measured without a clear. Kick
    // swapping an element's colour does move one of the two attributes — a
    // class change, or React rewriting an inline style — and both land here as
    // a different signature.
    if (painted && paintSig.get(el) === paintSignature(el)) return;

    const restore = painted ? suppressTransitions(el) : null;
    clearPaint(el);

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (!cs || !cs.color) {
      if (restore) restore();
      return;
    }

    const wrote = [];
    for (const prop of COLOR_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (isKickGreen(v)) {
        wrote.push({
          prop,
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop)
        });
        el.style.setProperty(prop, PURPLE, 'important');
      }
    }
    // A <stop> lives inside <defs>, which the UA stylesheet gives display:none.
    // Computed style is still defined there, but reading the attribute as well
    // costs one property check per element and does not depend on the engine
    // resolving presentation attributes for an unrendered subtree.
    if (el.localName === 'stop' && isKickGreen(el.getAttribute('stop-color'))) {
      wrote.push({
        prop: 'stop-color',
        value: el.style.getPropertyValue('stop-color'),
        priority: el.style.getPropertyPriority('stop-color')
      });
      el.style.setProperty('stop-color', PURPLE, 'important');
    }
    for (const prop of ['box-shadow', 'background-image', 'text-shadow']) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== 'none' && isKickGreen(v)) {
        wrote.push({
          prop,
          value: el.style.getPropertyValue(prop),
          priority: el.style.getPropertyPriority(prop)
        });
        el.style.setProperty(prop, greenToPurple(v), 'important');
      }
    }
    if (wrote.length) paintedProps.set(el, wrote);
    repaintPseudo(el);
    if (restore) restore();
    // Written last: repaintPseudo and the transition pin both touch the very
    // attributes the signature is taken from.
    if (paintedProps.has(el) || pseudoTagged.has(el)) {
      paintSig.set(el, paintSignature(el));
    }
  }

  // Repaint is the expensive pass, so it runs from a budgeted queue.
  const repaintQueue = [];
  let repaintScheduled = false;

  function queueRepaint(root) {
    if (!S.purpleTheme || !root) return;
    repaintQueue.push(root);
    if (repaintScheduled) return;
    repaintScheduled = true;
    requestAnimationFrame(drainRepaint);
  }

  function drainRepaint() {
    repaintScheduled = false;
    let budget = 1500;
    while (repaintQueue.length && budget > 0) {
      const root = repaintQueue.shift();
      if (!root.isConnected) continue;
      repaint(root);
      budget--;
      for (const el of root.querySelectorAll('*')) {
        if (paintGen.get(el) === generation) continue;
        repaint(el);
        if (--budget <= 0) {
          repaintQueue.push(root); // finish the rest next frame
          break;
        }
      }
    }
    if (repaintQueue.length) {
      repaintScheduled = true;
      requestAnimationFrame(drainRepaint);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Kick wordmark -> purple                                             */
  /* ------------------------------------------------------------------ */

  // The sidebar/header logo is an <img> pointing at /img/kick-logo.svg, so the
  // green lives inside a separate document that no CSS of ours can reach and
  // the computed-style repaint above cannot see. It is fetched once (same
  // origin, so it comes straight out of the HTTP cache), its greens are
  // rewritten, and the result is handed back as a data: URI.
  //
  // A CSS filter would have been the no-fetch alternative and was not used: it
  // can only approximate #9147ff, and it would tint whatever the logo becomes
  // if Kick ever redraws it. The original src is kept on the element so
  // turning the theme off puts the green wordmark straight back.
  const LOGO_SEL = [
    'img[alt*="kick logo" i]',
    'img[src*="kick-logo" i]',
    'img[src*="kick_logo" i]'
  ].join(',');

  const logoCache = new Map(); // original src -> recoloured data: URI
  const logoTried = new Set(); // srcs already fetched (ok or not) — fetch once

  function hexToRgb(hex) {
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function svgToPurple(text, canForce) {
    let changed = false;
    let out = text.replace(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/gi, (hex) => {
      const rgb = hexToRgb(hex);
      if (!rgb || !isKickGreen(`rgb(${rgb[0]},${rgb[1]},${rgb[2]})`)) return hex;
      changed = true;
      return '#9147ff';
    });
    out = out.replace(/rgba?\([^)]*\)/gi, (v) => {
      if (!isKickGreen(v)) return v;
      changed = true;
      return greenToPurple(v);
    });
    // Nothing green in the file: the shapes take their colour from
    // currentColor or from a class, and neither is reachable from here.
    // Force every shape purple instead — but only for a file we already know
    // is the Kick wordmark, so a sponsor logo is never repainted wholesale.
    if (!changed && canForce) {
      out = out.replace(
        /<svg\b[^>]*>/i,
        (m) => m + '<style>*{fill:#9147ff !important;stroke:#9147ff !important;}</style>'
      );
      changed = /<svg\b/i.test(out);
    }
    return changed ? out : null;
  }

  function applyLogo(img, uri) {
    if (img.getAttribute('src') === uri) return;
    if (!img.dataset.bpkLogoSrc) img.dataset.bpkLogoSrc = img.getAttribute('src') || '';
    img.setAttribute('src', uri);
  }

  function purpleLogos(root) {
    if (!S.purpleTheme || !root) return;
    for (const img of qsa(root, LOGO_SEL)) {
      // img.src is the absolute form; the attribute is what Kick wrote and is
      // what has to go back when the theme is switched off.
      const original = img.dataset.bpkLogoSrc || img.getAttribute('src') || '';
      if (!original || original.startsWith('data:')) continue;
      const url = new URL(original, location.href).href;
      const done = logoCache.get(url);
      if (done) {
        applyLogo(img, done);
        continue;
      }
      if (logoTried.has(url)) continue;
      logoTried.add(url);
      fetchLogo(url);
    }
  }

  async function fetchLogo(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return;
      const text = await res.text();
      if (!/<svg\b/i.test(text) || text.length > 512 * 1024) return;
      const purple = svgToPurple(text, /kick[-_]?logo/i.test(url));
      if (!purple) return;
      logoCache.set(url, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(purple));
      purpleLogos(document); // the images are already on the page, waiting
    } catch {
      /* offline, blocked, or not ours to read — leave the logo alone */
    }
  }

  // Theme switched off: hand every logo its own file back.
  function restoreLogos() {
    for (const img of document.querySelectorAll('img[data-bpk-logo-src]')) {
      const original = img.dataset.bpkLogoSrc;
      delete img.dataset.bpkLogoSrc;
      if (original) img.setAttribute('src', original);
    }
  }

  /* ------------------------------------------------------------------ */
  /* favicon -> purple                                                   */
  /* ------------------------------------------------------------------ */

  // The tab icon is a separate file again, and unlike the wordmark it is not
  // always an SVG — Kick may serve .ico or .png, which no text rewrite can
  // touch. Rasters go through a canvas: fetch (same origin, so the canvas is
  // never tainted and getImageData is allowed), recolour the green pixels,
  // hand back a data: URI.
  //
  // The link element's href is updated in place rather than the element being
  // replaced. Chrome re-reads a changed href, and leaving Kick's own <link>
  // nodes where they are keeps this out of the way of Next.js's head manager —
  // removing nodes it believes it owns is how you get it to throw on the next
  // navigation.
  const FAVICON_SEL = 'link[rel~="icon" i], link[rel*="icon" i]';
  const faviconCache = new Map(); // original href -> recoloured data: URI
  const faviconTried = new Set();

  // Looser than isKickGreen on purpose. That one reads CSS values, where the
  // colour is exactly what the designer wrote; here every edge pixel is a
  // blend between the brand green and whatever is behind it, and leaving those
  // alone puts a green fringe around a purple icon.
  function isGreenishPixel(r, g, b) {
    return g > Math.max(r, b) + 30;
  }

  // createImageBitmap is the direct route, but .ico is exactly the format a
  // decoder is most likely to refuse — and it is the one favicons are most
  // likely to be in. An <img> goes through the full image pipeline, which
  // does take .ico, so it is worth the extra round trip as a fallback.
  function decodeViaImg(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const done = (value) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });
  }

  async function rasterToPurple(blob) {
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      bmp = await decodeViaImg(blob);
    }
    if (!bmp) return null;
    // Favicons are tiny; a cap only guards against a mislabelled huge file.
    const w = Math.min(bmp.width || bmp.naturalWidth || 0, 256);
    const h = Math.min(bmp.height || bmp.naturalHeight || 0, 256);
    if (!w || !h) return null;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    if (typeof bmp.close === 'function') bmp.close();

    let data;
    try {
      data = ctx.getImageData(0, 0, w, h);
    } catch {
      return null; // tainted canvas — should not happen same-origin, but
    }
    const px = data.data;
    let changed = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue; // fully transparent: nothing to recolour
      if (!isGreenishPixel(px[i], px[i + 1], px[i + 2])) continue;
      px[i] = 145;
      px[i + 1] = 71;
      px[i + 2] = 255;
      changed++;
    }
    if (!changed) return null; // nothing green in it — leave Kick's file alone
    ctx.putImageData(data, 0, 0);
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  async function fetchFavicon(url) {
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) return;
      const blob = await res.blob();
      if (blob.size > 1024 * 1024) return;

      let uri = null;
      // An SVG favicon can reuse the wordmark's text rewrite, which keeps the
      // icon vector-sharp instead of baking it to a fixed-size PNG.
      if (/svg/i.test(blob.type) || /\.svg(\?|$)/i.test(url)) {
        const text = await blob.text();
        const purple = svgToPurple(text, true);
        if (purple) uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(purple);
      }
      if (!uri) uri = await rasterToPurple(blob);
      if (!uri) return;

      faviconCache.set(url, uri);
      purpleFavicon(); // the link elements are already on the page, waiting
    } catch {
      /* offline, blocked, or undecodable — leave the tab icon alone */
    }
  }

  function purpleFavicon() {
    if (!S.purpleTheme || !document.head) return;
    let links = Array.from(document.querySelectorAll(FAVICON_SEL));
    // No declared icon at all: the browser is falling back to /favicon.ico, so
    // give it something to point at before recolouring it. Only once the page
    // has finished loading, though — Next.js writes its own icon links late,
    // and synthesising one first would leave two icons competing.
    if (!links.length) {
      if (document.readyState !== 'complete') return;
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = '/favicon.ico';
      link.dataset.bpkFaviconOwn = '1';
      document.head.appendChild(link);
      links = [link];
    }
    for (const link of links) {
      const original = link.dataset.bpkFaviconSrc || link.getAttribute('href') || '';
      if (!original || original.startsWith('data:')) continue;
      let url;
      try {
        url = new URL(original, location.href).href;
      } catch {
        continue;
      }
      const done = faviconCache.get(url);
      if (done) {
        if (link.getAttribute('href') === done) continue;
        if (!link.dataset.bpkFaviconSrc) link.dataset.bpkFaviconSrc = original;
        link.setAttribute('href', done);
        continue;
      }
      if (faviconTried.has(url)) continue;
      faviconTried.add(url);
      fetchFavicon(url);
    }
  }

  // Theme switched off: put Kick's own tab icon back, and drop the link
  // element if it was ours to begin with.
  function restoreFavicon() {
    for (const link of document.querySelectorAll('link[data-bpk-favicon-src], link[data-bpk-favicon-own]')) {
      if (link.dataset.bpkFaviconOwn) {
        link.remove();
        continue;
      }
      const original = link.dataset.bpkFaviconSrc;
      delete link.dataset.bpkFaviconSrc;
      if (original) link.setAttribute('href', original);
    }
  }

  /* ------------------------------------------------------------------ */
  /* scanning                                                            */
  /* ------------------------------------------------------------------ */

  function qsa(root, sel) {
    const out = [];
    try {
      if (root.nodeType === 1 && root.matches(sel)) out.push(root);
      out.push(...root.querySelectorAll(sel));
    } catch {
      /* selector unsupported in this browser — ignore */
    }
    return out;
  }

  // Our own UI (the deleted-messages button and its window) is not Kick's
  // chat: it must not be tagged as a row or repainted.
  function ours(node) {
    return !!(node && node.nodeType === 1 && node.closest && node.closest('.bpk-ui'));
  }

  function scan(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    if (ours(root)) return;
    tagChatrooms(root);
    tagEntries(root);
    hideLabelledControls(root);
    purpleLogos(root);
    queueRepaint(root.nodeType === 9 ? root.documentElement : root);
  }

  // Attribute churn is constant on a React page, so an attribute change only
  // re-examines that one element — never its whole subtree.
  function scanShallow(el) {
    if (!el || el.nodeType !== 1 || ours(el)) return;
    try {
      if (el.matches(CHATROOM_SEL)) addClass(el, 'bpk-chatroom');
      if (el.classList.contains('bpk-entry')) {
        // Already known and already painted at least once: debounce the
        // empty/sub-event verdict so React's own attribute churn (see the
        // attributeFilter note below) can't flap display:none on and off.
        processEntry(el, false);
      } else if (
        el.matches(entrySel()) &&
        isRowLike(el) &&
        !hasEntryAncestor(el, EMPTY_SET)
      ) {
        addClass(el, 'bpk-entry');
        processEntry(el, true); // brand new node, nothing to debounce against
      }
      if (el.matches(CLICKABLE_SEL)) hideLabelledControls(el);
      if (el.matches(LOGO_SEL)) purpleLogos(el);
    } catch {
      /* selector unsupported — ignore */
    }
    repaint(el);
  }

  // node -> true (deep) / false (shallow); deep always wins.
  let pending = new Map();
  let scanScheduled = false;

  function scheduleScan(node, deep = true) {
    const target = node || document.body;
    if (!target) return;
    if (!pending.has(target) || deep) pending.set(target, deep);
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      const batch = pending;
      pending = new Map();
      for (const [n, isDeep] of batch) {
        if (!n || !n.isConnected) continue;
        if (isDeep) scan(n);
        else scanShallow(n);
      }
    });
  }

  // A row that is going to be dropped has to be judged BEFORE it paints, and
  // everything else in this file is deferred to requestAnimationFrame. That
  // deferral is what makes dropped messages flicker: the row is inserted,
  // painted at full height for one frame, and only collapsed on the next —
  // a visible flash on every emote-only line, every copypasta line and every
  // sub event. Worse, that first frame is also when Kick's virtualised list
  // measures the row, so it records a full height for a row that is about to
  // be zero and its scroll model is wrong from then on.
  //
  // A MutationObserver callback is a microtask: it runs after the DOM
  // changed but before the frame's layout and paint. Tagging here means the
  // row simply never appears, and the only height Kick ever measures is the
  // right one. Nothing on this path reads layout, so it forces no reflow —
  // and isRowLike() already refuses to tag an empty shell, so a row React
  // fills in afterwards is left to the deferred pass as before.
  function tagNewRows(node) {
    if (ours(node)) return;
    try {
      tagEntries(node);
    } catch {
      /* one bad subtree must not take down the batch */
    }
  }

  // Kick's own tokens only, sorted so that a reorder — which classList.remove
  // followed by classList.add produces on its own — does not read as a change.
  function foreignClasses(value) {
    if (!value) return '';
    return value
      .split(/\s+/)
      .filter((c) => c && !c.startsWith('bpk-'))
      .sort()
      .join(' ');
  }

  function ownClassChange(oldValue, el) {
    return foreignClasses(oldValue) === foreignClasses(el.getAttribute('class'));
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData') {
        const entry = rec.target.parentElement?.closest('.bpk-entry');
        if (entry) scheduleScan(entry, false);
        continue;
      }
      if (rec.type === 'attributes') {
        if (rec.attributeName === 'class') {
          // Every tag this file writes is a class change, and the observer
          // sees them all — so a tagged element re-scanned itself on the next
          // frame, tagged itself again, and never stopped. Only a change Kick
          // made is worth reacting to.
          if (ownClassChange(rec.oldValue, rec.target)) continue;
          // A class change is the main way an element's colours change, so let
          // the repaint pass look at it again rather than trusting the verdict
          // it reached under the old class list.
          paintGen.delete(rec.target);
        }
        scheduleScan(rec.target, false);
        continue;
      }
      // Content changed inside a row we already know about (text streamed in,
      // an emote swapped, a node removed) — re-evaluate the whole row, since
      // whether it still says anything can flip either way.
      if (rec.target.nodeType === 1) {
        const entry = rec.target.closest('.bpk-entry');
        if (entry) scheduleScan(entry, false);
      }
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) {
          tagNewRows(node); // synchronously — see below
          scheduleScan(node, true);
        } else if (node.nodeType === 3 && rec.target.nodeType === 1) {
          scheduleScan(rec.target, false);
        }
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* force 1080p                                                         */
  /* ------------------------------------------------------------------ */

  // This is the *fallback* half of the 1080p lock. The primary half lives in
  // quality.js (page world): it pins Kick's own "stream_quality" preference
  // so the player starts at 1080 instead of being corrected up to it. This
  // one only runs when that failed — the stream started below 1080 anyway.
  //
  // Kick forgets the chosen quality and falls back to "Auto". The player has
  // no scriptable API from a content script, so this walks its settings menu
  // with simulated pointer input. video.videoHeight is the passive "is it
  // 1080?" signal — checking it needs no menu at all.
  //
  // The trigger is very likely Radix-style: it opens on POINTERDOWN, not on
  // a plain .click(). A bare `.click()` (the first version of this feature)
  // dispatches only a "click" event and does nothing to a pointerdown-gated
  // trigger, which is the leading suspect for why nothing happened before.
  // qClick() below always fires the full pointerdown -> mousedown -> (wait)
  // -> pointerup -> mouseup -> click sequence so it works either way.
  const QDEBUG = '[Better Kick 1080p]';
  const qAttempts = new Map(); // stream key -> { tries, last, gaveUp }
  let qBusy = false;

  function qText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Keyed on path + src: a new stream load (new blob src) resets the budget,
  // so a quality drop after a stream restart gets re-enforced.
  function qKey(video) {
    return location.pathname + '|' + (video.currentSrc || video.src || '');
  }

  function findVideo() {
    const named = document.getElementById('video-player');
    if (named && named.tagName === 'VIDEO' && named.videoHeight > 0) return named;
    const scope = named || document;
    for (const v of scope.querySelectorAll('video')) {
      if (v.videoHeight > 0 && v.readyState >= 1) return v;
    }
    for (const v of document.querySelectorAll('video')) {
      if (v.videoHeight > 0 && v.readyState >= 1) return v;
    }
    return null;
  }

  // Fires a realistic pointer/mouse sequence at the element's own center —
  // needed both because some handlers key off clientX/clientY and because a
  // Radix-style trigger opens on pointerdown, which a bare .click() never
  // sends.
  async function qClick(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2) || 1;
    const y = Math.round(r.top + r.height / 2) || 1;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, isPrimary: true })); } catch { /* no PointerEvent */ }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await new Promise((res) => setTimeout(res, 30));
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, isPrimary: true })); } catch { /* no PointerEvent */ }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    try { el.click(); } catch { el.dispatchEvent(new MouseEvent('click', opts)); }
  }

  // Realistic hover at real coordinates, bubbled up through a couple of
  // ancestors too — the control bar's own hover state (not just the video's)
  // is often what actually reveals the buttons.
  function qHover(el) {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2) || 1;
    const y = Math.round(r.top + r.height / 2) || 1;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    let node = el;
    for (let i = 0; i < 3 && node; i++) {
      for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
        node.dispatchEvent(new MouseEvent(type, opts));
      }
      try { node.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerId: 1, isPrimary: true })); } catch { /* no PointerEvent */ }
      node = node.parentElement;
    }
  }

  const SETTINGS_LABEL_RE = /setting|ayarlar|gear|options|quality|kalite/i;

  // Scored instead of first-match: the page can have other "Settings"-ish
  // buttons (channel settings, chat settings, account menu) outside the
  // player. Requiring a real signal (label, aria-haspopup, or proximity to
  // the video) before ever clicking keeps this from firing on the wrong one.
  function findSettingsButton(video) {
    const scope =
      video.closest('[id*="player" i], [class*="player" i]') || document.body;
    const vr = video.getBoundingClientRect();
    // Generous pad: the control bar usually sits just inside/below the video
    // box, not exactly inside it.
    const pad = 150;
    let best = null;
    let bestScore = 0;
    for (const b of qsa(scope, 'button')) {
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      let score = 0;
      if (SETTINGS_LABEL_RE.test(label)) score += 2;
      if (b.hasAttribute('aria-haspopup')) score += 2;
      const r = b.getBoundingClientRect();
      if (
        r.width > 0 &&
        r.left >= vr.left - pad && r.right <= vr.right + pad &&
        r.top >= vr.top - pad && r.bottom <= vr.bottom + pad
      ) score += 1;
      // >= so the later (rightmost / most-recently-rendered) candidate wins
      // a tie, matching where a settings cog usually sits in a control bar.
      if (score > 0 && score >= bestScore) {
        best = b;
        bestScore = score;
      }
    }
    return best;
  }

  function menuItems() {
    return qsa(
      document,
      '[role="menuitem"], [role="menuitemradio"], [data-testid*="quality" i], [data-testid*="option" i]'
    );
  }

  function waitFor(pick, timeout) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const poll = () => {
        let v = null;
        try { v = pick(); } catch { /* ignore */ }
        if (v) return resolve(v);
        if (performance.now() - t0 > timeout) return resolve(null);
        setTimeout(poll, 70);
      };
      poll();
    });
  }

  async function force1080(video) {
    const key = qKey(video);
    const st = qAttempts.get(key) || { tries: 0, last: 0, gaveUp: false };
    const now = Date.now();
    if (st.gaveUp || st.tries >= 4 || now - st.last < 8000) return;
    st.tries++;
    st.last = now;
    qAttempts.set(key, st);
    if (qAttempts.size > 40) qAttempts.delete(qAttempts.keys().next().value);

    qBusy = true;
    const html = document.documentElement;
    html.setAttribute('data-bpk-qwork', 'on');
    let btn = null;
    try {
      // Player controls stay hidden/inert until the player sees a pointer.
      qHover(video);
      await new Promise((r) => setTimeout(r, 350));
      qHover(video);

      btn = await waitFor(() => findSettingsButton(video), 1200);
      if (!btn) {
        console.debug(QDEBUG, 'attempt', st.tries, 'settings button not found');
        return;
      }
      qHover(btn);
      await qClick(btn);

      // Either the menu opens straight onto the resolution radios, or it has
      // a "Quality" submenu entry that must be clicked first.
      const step = await waitFor(() => {
        const items = menuItems();
        if (items.some((el) => /\b(1080|720|480|360|160|source|auto)\b/i.test(qText(el)))) {
          return { direct: true };
        }
        const q = items.find((el) => /quality|kalite/i.test(qText(el)));
        return q ? { submenu: q } : null;
      }, 1500);
      if (!step) {
        console.debug(QDEBUG, 'attempt', st.tries, 'menu did not open; items seen:', menuItems().map(qText));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return;
      }
      if (step.submenu) {
        await qClick(step.submenu);
        await waitFor(() => (menuItems().some((el) => /\b1080\b/.test(qText(el))) ? true : null), 1000);
      }

      const radios = menuItems();
      const target = radios.find((el) => /(^|[^\d])1080/.test(qText(el)));
      if (target) {
        await qClick(target); // menu closes itself on selection
        console.debug(QDEBUG, 'attempt', st.tries, 'clicked 1080p option');
      } else {
        st.gaveUp = true; // menu opened: this stream has no 1080p to pick
        console.debug(QDEBUG, 'gave up: menu opened but no 1080p option among', radios.map(qText));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      // Whatever happened above, the menu must not be left open when the
      // invisibility attribute comes off.
      const closed = await waitFor(
        () => (btn.getAttribute('aria-expanded') !== 'true' && menuItems().length === 0 ? true : null),
        600
      );
      if (!closed && btn.isConnected) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (menuItems().length) await qClick(btn);
      }
    } catch (err) {
      console.debug(QDEBUG, 'attempt', st.tries, 'threw', err);
    } finally {
      // Small delay so the menu finishes closing while still invisible.
      setTimeout(() => html.removeAttribute('data-bpk-qwork'), 400);
      qBusy = false;
    }
  }

  function enforceQuality() {
    if (!S.force1080 || qBusy) return;
    const video = findVideo();
    if (!video) return;
    if (video.videoHeight >= 1080) return;
    force1080(video);
  }

  /* ------------------------------------------------------------------ */
  /* deleted messages log                                                */
  /* ------------------------------------------------------------------ */

  // The reading half of chatlog.js: a button next to Kick's chat settings cog
  // and a chat-shaped window listing what was deleted, who wrote it, when it
  // went and — where Kick's own events say so — who took it down.
  //
  // Entries arrive by postMessage from the page world (chatlog.js has the
  // socket; this script has chrome.storage and the UI). The page could forge
  // one of those messages, so nothing in an entry is ever treated as markup:
  // every field below goes in through textContent.
  //
  // The panel is position:fixed at <body> level over the chat's rect rather
  // than a child of the chat — the same reason chatscroll.js puts its
  // scrollbar there. React owns the chat subtree and reconciles foreign
  // children away. The *button* has to live in the chat footer to be next to
  // the cog, so it is remounted by the sweep whenever React drops it.

  const LOG_MAX = 400;
  const logEntries = [];
  const logRows = new Map(); // entry seq -> row element
  let logBtn = null;
  let logBadge = null;
  let logPanel = null;
  let logBody = null;
  let logCount = null;
  let logEmpty = null;
  let logOpen = false;
  let logSeen = 0; // highest seq the user has already looked at
  let logPlaceTimer = 0;

  function clock(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // Kick sends emotes as "[emote:37226:EZ]". The rest of the extension throws
  // emotes away, but in a log of things somebody said, the name is the only
  // trace of what they sent — so it is kept as plain text.
  const LOG_MARKUP_RE = /\[(?:emote|emoji|sticker|gif|img)[:|]([^\]]*)\]/gi;

  function logText(raw) {
    let t = String(raw || '').replace(LOG_MARKUP_RE, (_m, body) => {
      const parts = String(body).split(/[:|]/);
      const name = parts[parts.length - 1] || '';
      return name ? ' ' + name + ' ' : ' ';
    });
    if (S.justChat) t = t.replace(EMOJI_RE, '');
    return t.replace(/\s+/g, ' ').trim();
  }

  function svgIcon(paths, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(NS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('width', String(size));
    el.setAttribute('height', String(size));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '1.8');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      el.appendChild(p);
    }
    return el;
  }

  /* ---- where the button goes ---------------------------------------- */

  // Every hook in Kick's chat footer is unreliable: no id, icon-only buttons,
  // localised labels, and a send button that is sometimes not a <button
  // type=submit> at all. So the mount does not look for the send button. It
  // works outward from the one thing in that footer that is unmistakable —
  // the box you type in — and takes the button row nearest to it.
  //
  // And if there is no composer at all (logged out, chat in read-only mode)
  // it falls back to a small floating button pinned to the chat panel.
  // A feature you cannot reach is worse than one sitting slightly off.
  //
  // Which route was taken is written to <html data-bpk-logmount> so that
  // __bpkDiag() can print it: "none" means no chat panel was found at all,
  // "float" means the footer was not recognised.

  const CHAT_INPUT_SEL =
    '#chat-input,[data-testid*="chat-input" i],[data-lexical-editor="true"],' +
    'div[contenteditable="true"],textarea';

  // Ordered by how much the selector is trusted, not by convenience: the
  // first entry is Kick's real id and the last ones are guesses, and
  // "[data-testid*=chat]" on its own would happily match a chat *toggle* in
  // the top bar.
  const CHATBOX_LIST = [
    '#chatroom',
    '#chatroom-messages',
    '[id*="chatroom" i]',
    '[data-testid*="chatroom" i]',
    '[class*="chatroom" i]:not([class*="--chatroom" i])'
  ];

  // Used for the panel's placement too, where any of these is good enough.
  const CHATBOX_SEL = CHATBOX_LIST.join(',');

  function chatBox() {
    for (const sel of CHATBOX_LIST) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue; // :not()/:is() unsupported here — try the next one
      }
      if (el && el.getBoundingClientRect().width > 120) return el;
    }
    return null;
  }

  let mountNoted = '';

  function markMount(how) {
    const html = document.documentElement;
    if (html && html.getAttribute('data-bpk-logmount') !== how) {
      html.setAttribute('data-bpk-logmount', how);
    }
    // One line per change of route, so a "where is my button" report can be
    // answered from the console without any DOM archaeology.
    if (mountNoted !== how) {
      mountNoted = how;
      console.debug('[Better Kick log] deleted-messages button mount:', how);
    }
  }

  // Zero-sized buttons are Kick's hidden/placeholder controls; inserting next
  // to one would put ours somewhere invisible too.
  function realButtons(root) {
    const out = [];
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      if (b.closest('.bpk-ui')) continue;
      // The quick-emote strip is a row of buttons directly above the input,
      // and plain-chat mode hides the whole strip — mounting in there would
      // hide the log button with it.
      if (b.closest('#quick-emotes-holder,[id*="quick-emote" i]')) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 6 && r.height > 6) out.push(b);
    }
    return out;
  }

  const COG_RE = /setting|ayar|option|seçenek|secenek|preference|gear/i;

  function findCog(row, skip) {
    for (const b of row.querySelectorAll('button, [role="button"]')) {
      if (b === skip || b.closest('.bpk-ui')) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '');
      if (COG_RE.test(label)) return b;
    }
    return null;
  }

  // The direct child of `row` that contains `el` — the send button is often
  // wrapped, and inserting next to the wrapper keeps the footer's own layout.
  function childHolding(row, el) {
    let n = el;
    while (n && n.parentElement && n.parentElement !== row) n = n.parentElement;
    return n && n.parentElement === row ? n : null;
  }

  function findInput(scope) {
    for (const el of scope.querySelectorAll(CHAT_INPUT_SEL)) {
      if (el.closest('.bpk-ui')) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 8) return el;
    }
    return null;
  }

  function findMountSpot(box) {
    // #chatroom is sometimes only the message list, with the composer as a
    // sibling below it, so the search widens by a few ancestors before giving
    // up. It stops well short of <body> — the page's other text boxes (search,
    // login) must never be mistaken for the chat composer.
    let input = null;
    let scope = box;
    for (let i = 0; scope && i < 4 && !input; i++, scope = scope.parentElement) {
      input = findInput(scope);
    }
    if (!input) return null;

    // Climb out of the text box until an ancestor holds a real button. That
    // ancestor is the composer; the last button in it is the rightmost
    // control, which is Send in every layout Kick has shipped.
    let el = input.parentElement;
    for (let i = 0; el && el !== box && i < 6; i++, el = el.parentElement) {
      const btns = realButtons(el);
      if (!btns.length) continue;
      const last = btns[btns.length - 1];
      let row = last.parentElement;
      // A send button wrapped alone in its own div: go up one, so the log
      // button joins the action cluster instead of the wrapper.
      if (row && row !== el && realButtons(row).length < 2 && row.parentElement) {
        row = row.parentElement;
      }
      if (!row) row = el;
      const cog = findCog(row, last);
      return {
        parent: row,
        before: cog || childHolding(row, last),
        how: cog ? 'cog' : 'send'
      };
    }
    return null;
  }

  function makeLogButton() {
    const btn = document.createElement('button');
    btn.type = 'button'; // the footer is a form — a default button would submit it
    btn.className = 'bpk-ui bpk-log-btn';
    btn.setAttribute('aria-label', 'Deleted messages');
    btn.title = 'Deleted messages (Better Kick)';
    btn.appendChild(
      svgIcon(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14', 'M10 10v7', 'M14 10v7'], 18)
    );
    logBadge = document.createElement('span');
    logBadge.className = 'bpk-log-badge';
    logBadge.hidden = true;
    btn.appendChild(logBadge);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleLog();
    });
    return btn;
  }

  let floatTimer = 0;

  function mountLogButton() {
    if (!S.deletedLog) return;
    if (logBtn && logBtn.isConnected) return;
    const box = chatBox();
    if (!box) {
      markMount('none');
      return;
    }
    const spot = findMountSpot(box);
    if (spot && spot.parent && spot.parent.isConnected) {
      const btn = makeLogButton();
      // Left of the cog, so the order reads [log][settings][send].
      if (spot.before && spot.before.parentElement === spot.parent) {
        spot.parent.insertBefore(btn, spot.before);
      } else {
        spot.parent.appendChild(btn);
      }
      logBtn = btn;
      stopFloat();
      markMount(spot.how);
    } else {
      floatButton();
      markMount('float');
    }
    paintBadge();
  }

  // Last resort: a chip pinned to the top-right of the chat panel. Fixed at
  // <body> level and repositioned on a slow timer, like the panel itself.
  function floatButton() {
    const btn = makeLogButton();
    btn.classList.add('bpk-log-float');
    document.body.appendChild(btn);
    logBtn = btn;
    placeFloat();
    if (!floatTimer) floatTimer = setInterval(placeFloat, 1000);
  }

  function stopFloat() {
    clearInterval(floatTimer);
    floatTimer = 0;
  }

  function placeFloat() {
    if (!logBtn || !logBtn.classList.contains('bpk-log-float')) {
      stopFloat();
      return;
    }
    const box = chatBox();
    const r = box ? box.getBoundingClientRect() : null;
    if (!r || r.width < 120 || r.height < 120) {
      logBtn.style.display = 'none';
      return;
    }
    logBtn.style.display = '';
    logBtn.style.left = Math.round(r.right - 44) + 'px';
    logBtn.style.top = Math.round(r.top + 8) + 'px';
  }

  /* ---- the window ---------------------------------------------------- */

  function makePanel() {
    const panel = document.createElement('div');
    panel.className = 'bpk-ui bpk-log';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Deleted messages');

    const head = document.createElement('div');
    head.className = 'bpk-log-head';

    const title = document.createElement('span');
    title.className = 'bpk-log-title';
    title.textContent = 'Deleted messages';
    head.appendChild(title);

    logCount = document.createElement('span');
    logCount.className = 'bpk-log-n';
    head.appendChild(logCount);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'bpk-log-clear';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      logEntries.length = 0;
      logRows.clear();
      logSeen = 0;
      askLog('clear');
      renderLog();
      paintBadge();
    });
    head.appendChild(clear);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bpk-log-x';
    close.setAttribute('aria-label', 'Close');
    close.appendChild(svgIcon(['M5 5l14 14', 'M19 5L5 19'], 16));
    close.addEventListener('click', closeLog);
    head.appendChild(close);

    panel.appendChild(head);

    logBody = document.createElement('div');
    logBody.className = 'bpk-log-body';
    panel.appendChild(logBody);

    logEmpty = document.createElement('div');
    logEmpty.className = 'bpk-log-none';
    logEmpty.textContent =
      'Nothing deleted yet. Messages removed from this chat from now on show up here.';
    logBody.appendChild(logEmpty);

    const foot = document.createElement('div');
    foot.className = 'bpk-log-foot';
    foot.textContent = 'Kept in this tab only — closing it forgets everything.';
    panel.appendChild(foot);

    document.body.appendChild(panel);
    return panel;
  }

  function metaText(e) {
    const parts = [];
    parts.push((e.kind === 'ban' ? 'removed ' : 'deleted ') + clock(e.at));
    const auto = /automod/i.test(e.why || '');
    if (e.by) parts.push('by ' + e.by + (e.guessed ? ' (assumed)' : ''));
    else if (!auto) parts.push('by an unknown moderator');
    if (e.why) parts.push(e.why);
    return parts.join(' · ');
  }

  function makeRow(e) {
    const row = document.createElement('div');
    row.className = 'bpk-log-row' + (e.kind === 'notice' ? ' bpk-log-notice' : '');

    if (e.kind === 'notice') {
      const line = document.createElement('div');
      line.className = 'bpk-log-msg';
      const t = document.createElement('span');
      t.className = 'bpk-log-time';
      t.textContent = clock(e.at);
      line.appendChild(t);
      const said = document.createElement('span');
      said.className = 'bpk-log-say';
      said.textContent = e.user
        ? e.user + ' ' + (e.why || 'was moderated') + (e.by ? ' · by ' + e.by : '')
        : e.why || 'moderator action';
      line.appendChild(said);
      row.appendChild(line);
      return row;
    }

    const line = document.createElement('div');
    line.className = 'bpk-log-msg';

    const time = document.createElement('span');
    time.className = 'bpk-log-time';
    time.textContent = e.sentAt ? clock(e.sentAt) : '--:--:--';
    line.appendChild(time);

    const user = document.createElement('span');
    user.className = 'bpk-log-user';
    if (e.color && !S.monoUsernames && /^#[0-9a-f]{3,8}$/i.test(e.color)) {
      user.style.color = e.color;
    }
    user.textContent = e.user || '(unknown user)';
    line.appendChild(user);

    const sep = document.createElement('span');
    sep.className = 'bpk-log-sep';
    sep.textContent = ':';
    line.appendChild(sep);

    const text = document.createElement('span');
    text.className = 'bpk-log-text';
    const body = logText(e.text);
    if (!e.known) {
      text.classList.add('bpk-log-dim');
      text.textContent = '(not captured — it was sent before this tab was open)';
    } else if (!body) {
      text.classList.add('bpk-log-dim');
      text.textContent = '(emotes only)';
    } else {
      text.textContent = body;
    }
    line.appendChild(text);
    row.appendChild(line);

    const meta = document.createElement('div');
    meta.className = 'bpk-log-meta';
    meta.textContent = metaText(e);
    row.appendChild(meta);

    if (e.guessed) {
      row.title =
        "Kick's delete event does not name a moderator. This name is taken from a ban of the same" +
        ' user seconds later, so it is an attribution, not a fact.';
    }
    return row;
  }

  function renderLog() {
    if (!logBody) return;
    logBody.textContent = '';
    logRows.clear();
    logBody.appendChild(logEmpty);
    logEmpty.hidden = logEntries.length > 0;
    for (const e of logEntries) {
      const row = makeRow(e);
      logRows.set(e.seq, row);
      logBody.appendChild(row);
    }
    if (logCount) logCount.textContent = String(logEntries.length);
    logBody.scrollTop = logBody.scrollHeight;
  }

  function addLogEntry(e) {
    if (!e || typeof e !== 'object' || typeof e.seq !== 'number') return;
    logEntries.push(e);
    if (logEntries.length > LOG_MAX) {
      const gone = logEntries.splice(0, logEntries.length - LOG_MAX);
      for (const old of gone) {
        const row = logRows.get(old.seq);
        if (row) row.remove();
        logRows.delete(old.seq);
      }
    }
    if (logOpen && logBody) {
      const atEnd = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 24;
      const row = makeRow(e);
      logRows.set(e.seq, row);
      logBody.appendChild(row);
      logEmpty.hidden = true;
      if (logCount) logCount.textContent = String(logEntries.length);
      if (atEnd) logBody.scrollTop = logBody.scrollHeight;
      logSeen = e.seq;
    }
    paintBadge();
  }

  // chatlog.js re-sends an entry when a later ban tells it who the moderator
  // was — same seq, one more field filled in.
  function updateLogEntry(e) {
    if (!e || typeof e.seq !== 'number') return;
    const i = logEntries.findIndex((x) => x.seq === e.seq);
    if (i < 0) return;
    logEntries[i] = e;
    const row = logRows.get(e.seq);
    if (!row) return;
    const fresh = makeRow(e);
    logRows.set(e.seq, fresh);
    row.replaceWith(fresh);
  }

  function paintBadge() {
    if (!logBadge) return;
    let unseen = 0;
    for (const e of logEntries) if (e.seq > logSeen) unseen++;
    logBadge.textContent = unseen > 99 ? '99+' : String(unseen);
    logBadge.hidden = unseen === 0;
    if (logBtn) logBtn.classList.toggle('bpk-has-new', unseen > 0);
  }

  function placePanel() {
    if (!logPanel || !logOpen) return;
    let box = null;
    try {
      box = (logBtn && logBtn.closest(CHATBOX_SEL)) || document.querySelector('#chatroom');
    } catch {
      box = document.querySelector('#chatroom');
    }
    const r = box ? box.getBoundingClientRect() : null;
    const b = logBtn && logBtn.isConnected ? logBtn.getBoundingClientRect() : null;
    let left;
    let width;
    let top;
    let bottom;
    if (r && r.width >= 200 && r.height >= 200) {
      left = r.left;
      width = r.width;
      top = r.top + 8;
      // Stop above the composer when the button is inside the same box, so
      // the chat input stays usable with the log open.
      bottom = (b && b.top > r.top + 160 ? b.top : r.bottom) - 10;
    } else if (b) {
      width = Math.min(380, window.innerWidth - 16);
      left = Math.max(8, Math.min(b.right - width, window.innerWidth - width - 8));
      bottom = b.top - 10;
      top = Math.max(8, bottom - 460);
    } else {
      return;
    }
    logPanel.style.left = Math.round(left) + 'px';
    logPanel.style.width = Math.round(width) + 'px';
    logPanel.style.top = Math.round(top) + 'px';
    logPanel.style.height = Math.round(Math.max(180, bottom - top)) + 'px';
  }

  function openLog() {
    if (!S.deletedLog) return;
    if (!logPanel) logPanel = makePanel();
    logOpen = true;
    logPanel.classList.add('bpk-on');
    if (logBtn) logBtn.classList.add('bpk-open');
    askLog('sync'); // in case entries landed before this panel existed
    renderLog();
    placePanel();
    logSeen = logEntries.length ? logEntries[logEntries.length - 1].seq : logSeen;
    paintBadge();
    // The chat panel is resized by the sidebar, by theatre mode and by the
    // window; re-measuring on a slow timer is cheaper than watching all three.
    clearInterval(logPlaceTimer);
    logPlaceTimer = setInterval(placePanel, 250);
    window.addEventListener('resize', placePanel);
    document.addEventListener('keydown', onLogKey, true);
  }

  function closeLog() {
    logOpen = false;
    if (logPanel) logPanel.classList.remove('bpk-on');
    if (logBtn) logBtn.classList.remove('bpk-open');
    clearInterval(logPlaceTimer);
    logPlaceTimer = 0;
    window.removeEventListener('resize', placePanel);
    document.removeEventListener('keydown', onLogKey, true);
  }

  function toggleLog() {
    if (logOpen) closeLog();
    else openLog();
  }

  function onLogKey(e) {
    if (e.key === 'Escape' && logOpen) {
      e.stopPropagation();
      closeLog();
    }
  }

  function teardownLog() {
    closeLog();
    stopFloat();
    // Switched off means nothing is kept anywhere, not just nothing shown.
    askLog('off');
    logEntries.length = 0;
    logSeen = 0;
    if (logPanel) {
      logPanel.remove();
      logPanel = null;
      logBody = null;
      logCount = null;
      logEmpty = null;
    }
    if (logBtn) {
      logBtn.remove();
      logBtn = null;
      logBadge = null;
    }
    logRows.clear();
  }

  function askLog(type) {
    try {
      window.postMessage({ __bpk: 'log', type }, location.origin || '*');
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__bpk !== 'log' || !S.deletedLog) return;
    if (d.type === 'entry') addLogEntry(d.entry);
    else if (d.type === 'update') updateLogEntry(d.entry);
    else if (d.type === 'list') {
      if (!Array.isArray(d.entries)) return;
      logEntries.length = 0;
      logEntries.push(...d.entries.slice(-LOG_MAX));
      if (logOpen) {
        renderLog();
        // The panel is on screen, so everything in it counts as seen.
        logSeen = logEntries.length ? logEntries[logEntries.length - 1].seq : logSeen;
      }
      paintBadge();
    } else if (d.type === 'reset') {
      // Channel change: the previous chat's log is not this chat's log.
      logEntries.length = 0;
      logRows.clear();
      logSeen = 0;
      if (logOpen) renderLog();
      paintBadge();
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function applyFlags() {
    const html = document.documentElement;
    if (!html) return;
    for (const [key, attr] of Object.entries(FLAGS)) {
      html.setAttribute(attr, S[key] ? 'on' : 'off');
    }
  }

  /* ------------------------------------------------------------------ */
  /* sidebar / chat collapse memory                                      */
  /* ------------------------------------------------------------------ */

  // Kick holds the collapsed state of the left rail and the chat panel in
  // React state and nowhere else, so every reload puts both back to their
  // defaults. Nothing outside the app can set that state — the only way in is
  // the toggle the user clicks, which makes replaying a click the only
  // mechanism available.
  //
  // Which button to replay is *learned* rather than hardcoded, because neither
  // toggle has a hook worth trusting: a collapse button's aria-label flips
  // between "collapse" and "expand" as it is used, and the labels are
  // localised on top of that. So: when a click is followed by a panel changing
  // width, that button is the toggle for that panel. It gets remembered along
  // with the width the user left the panel at, and on the next load, if the
  // panel comes up materially different, the button is clicked once.
  //
  // The upshot is that a panel is remembered from the first time you collapse
  // it — the toggling *is* the teaching, so there is nothing to configure.
  const PANEL_STORE = 'bpk_panels';
  const PANEL_VERSION = 2; // bump to discard everything learned by older logic
  const PANEL_SETTLE_MS = 450; // a collapse animation has finished by here
  const PANEL_MIN_DELTA = 40;  // px; below this it is a resize, not a collapse
  const PANEL_WINDOW_MS = 15000; // stop restoring: after this it is the user's

  // Geometric, not name-based: the left rail is the tall element pinned to the
  // left edge, whatever Kick calls it this month. It stays full height when
  // collapsed — only its width changes — so this finds it either way.
  function findSidebar() {
    let best = null;
    for (const el of qsa(document, 'nav, aside, [class*="sidebar" i], [id*="sidebar" i]')) {
      const r = el.getBoundingClientRect();
      if (r.left > 120 || r.width === 0) continue;
      if (r.height < window.innerHeight * 0.5) continue;
      if (!best || r.height > best.h) best = { el, h: r.height };
    }
    return best ? best.el : null;
  }

  function findChatPanel() {
    return document.querySelector(
      '.bpk-chatroom, #chatroom, #chatroom-messages, [data-testid*="chatroom" i]'
    );
  }

  const PANELS = [
    { key: 'sidebar', find: findSidebar },
    { key: 'chat', find: findChatPanel }
  ];

  // Absent counts as zero width, which is the point: a collapsed chat panel is
  // usually unmounted rather than shrunk, and both read the same way here.
  function panelWidth(el) {
    if (!el || !el.isConnected) return 0;
    return Math.round(el.getBoundingClientRect().width);
  }

  function panelSnapshot() {
    const out = {};
    for (const p of PANELS) out[p.key] = panelWidth(p.find());
    return out;
  }

  function loadPanels() {
    try {
      const raw = localStorage.getItem(PANEL_STORE);
      const map = raw ? JSON.parse(raw) : null;
      if (!map || typeof map !== 'object') return { v: PANEL_VERSION };
      // Anything learned before the navigation guards below is not just stale,
      // it is actively harmful — the first version could learn a *link* as a
      // panel toggle and then "restore" the panel by navigating. Drop it.
      // The stamp has to be carried on every empty result too, or each save
      // would write a map that the next load rejects as old.
      if (map.v !== PANEL_VERSION) return { v: PANEL_VERSION };
      return map;
    } catch {
      return { v: PANEL_VERSION };
    }
  }

  function savePanels(map) {
    try {
      localStorage.setItem(PANEL_STORE, JSON.stringify(map));
    } catch {
      /* storage blocked */
    }
  }

  // Only hooks that survive a re-render are worth storing. A structural path
  // would be brittle in a way that stays invisible until it silently clicks
  // the wrong thing, so a button without one of these is simply not learned.
  function panelSig(el) {
    const testid = el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + CSS.escape(testid) + '"]';
    if (el.id) return '#' + CSS.escape(el.id);
    const label = el.getAttribute('aria-label');
    if (label) return '[aria-label="' + CSS.escape(label) + '"]';
    const title = el.getAttribute('title');
    if (title) return '[title="' + CSS.escape(title) + '"]';
    return null;
  }

  // A collapse toggle never navigates. A link always does — and a link is
  // exactly what must never be learned here, because "restoring" the panel
  // would then mean following it. This is not hypothetical: clicking a stream
  // from the browse grid takes the chat panel from 0 to full width, which
  // reads as a perfect collapse-toggle signal, and the memory that produced
  // sent you back to the stream every time you opened Browse.
  function navigates(el) {
    if (!el.matches('a[href], area[href]')) return false;
    const href = el.getAttribute('href') || '';
    return href !== '' && !href.startsWith('#');
  }

  function onPanelClick(e) {
    if (!S.rememberPanels) return;
    const el = e.target && e.target.closest ? e.target.closest('button, [role="button"], a') : null;
    // Our own buttons are not Kick's panel toggles, and one of them sits in
    // the chat footer where a toggle plausibly could.
    if (!el || navigates(el) || el.closest('.bpk-ui')) return;
    const sig = panelSig(el);
    if (!sig) return;
    const before = panelSnapshot();
    const fromUrl = location.href;
    setTimeout(() => {
      // The page moved while we were waiting, so the two snapshots are of
      // different layouts and the difference between them means nothing. Any
      // width change here belongs to the navigation, not to a toggle.
      if (location.href !== fromUrl) return;
      const after = panelSnapshot();
      const store = loadPanels();
      let learned = false;
      for (const p of PANELS) {
        if (Math.abs(after[p.key] - before[p.key]) < PANEL_MIN_DELTA) continue;
        store[p.key] = { sig, width: after[p.key], misses: 0 };
        learned = true;
        console.debug('[Better Kick panels] learned', p.key, sig, after[p.key] + 'px');
      }
      if (learned) savePanels(store);
    }, PANEL_SETTLE_MS);
  }

  let panelRestoreClicks = 0;
  let panelDeadline = 0;

  function restorePanels() {
    if (!S.rememberPanels || panelRestoreClicks >= 2) return;
    if (panelDeadline && Date.now() > panelDeadline) return;
    const store = loadPanels();
    const now = panelSnapshot();

    for (const p of PANELS) {
      const mem = store[p.key];
      if (!mem || !mem.sig) continue;
      if (Math.abs(now[p.key] - mem.width) < PANEL_MIN_DELTA) continue;

      // The toggle's presence is what says "this page has this panel". Testing
      // for the panel itself cannot work: the state we most need to restore is
      // the one where the panel is unmounted and has nothing to find.
      let btn = null;
      try {
        btn = document.querySelector(mem.sig);
      } catch {
        continue; // stored selector no longer parses
      }
      if (!btn) continue;
      // Second line of defence: even a stored signature can come to match a
      // link after Kick reshuffles its markup, and following one would be a
      // navigation the user never asked for.
      if (navigates(btn)) {
        const s = loadPanels();
        delete s[p.key];
        savePanels(s);
        console.debug('[Better Kick panels] forgot', p.key, '— its toggle now resolves to a link');
        continue;
      }

      panelRestoreClicks++;
      const fromUrl = location.href;
      console.debug('[Better Kick panels] restoring', p.key, 'to', mem.width + 'px', 'via', mem.sig);
      qClick(btn);

      setTimeout(() => {
        const fresh = loadPanels();
        if (!fresh[p.key]) return;
        // Clicking it navigated. Whatever it is, it is not a panel toggle, and
        // keeping it would repeat the navigation on every single page load.
        if (location.href !== fromUrl) {
          delete fresh[p.key];
          savePanels(fresh);
          console.debug('[Better Kick panels] forgot', p.key, '— clicking it navigated');
          return;
        }
        const after = panelWidth(p.find());
        if (Math.abs(after - mem.width) < PANEL_MIN_DELTA) {
          fresh[p.key].misses = 0;
          savePanels(fresh);
          return;
        }
        // Clicking it did not do what it used to. Two strikes before the
        // memory is dropped — one failure is more likely to be a page that
        // happens to have a same-named button than a genuinely stale hook.
        fresh[p.key].misses = (fresh[p.key].misses || 0) + 1;
        if (fresh[p.key].misses >= 2) {
          delete fresh[p.key];
          console.debug('[Better Kick panels] forgot', p.key, '— its toggle no longer works');
        }
        savePanels(fresh);
      }, PANEL_SETTLE_MS * 2);
    }
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    scan(document);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      // Needed to tell our own tagging apart from a class change Kick made —
      // see ownClassChange().
      attributeOldValue: true,
      // 'style' is deliberately not observed: repaint() writes inline styles,
      // and observing them would feed our own writes straight back in.
      // 'data-index' changes when Kick's virtual list recycles a row into a
      // different message, so the row must be re-evaluated then.
      attributeFilter: ['class', 'data-chat-entry', 'data-index', 'title', 'aria-label']
    });
    // Kick swaps whole panels on channel navigation; a slow sweep catches
    // anything a mutation batch missed.
    setInterval(() => {
      // Re-open every element to the repaint pass. Colours are not settled at
      // first sight — a browse card hydrates into its live state well after
      // it is inserted — so a once-only check leaves greens behind. Nothing
      // happens in a background tab, and the queue is budgeted per frame, so
      // the re-check costs a couple of frames every 4s on a visible page.
      if (!document.hidden) generation++;
      scan(document.body || document);
      purpleFavicon();
      restorePanels();
      // React owns the chat footer and reconciles foreign children away, so
      // the deleted-messages button is put back rather than mounted once.
      mountLogButton();
    }, 4000);
    // The footer mounts well after boot, and 4s of missing button reads as a
    // broken feature — try on a short ramp first.
    for (const delay of [600, 1500, 3000]) setTimeout(mountLogButton, delay);
    // Panels: watch every click to learn the toggles, and try the restore on a
    // short ramp — the rail and the chat panel mount at different times, and
    // measuring either before it has laid out reads as "collapsed".
    document.addEventListener('click', onPanelClick, true);
    panelDeadline = Date.now() + PANEL_WINDOW_MS;
    for (const delay of [800, 1800, 3200]) setTimeout(restorePanels, delay);
    // Kick's head manager rewrites the icon link on navigation, so watch for
    // it directly rather than waiting up to 4s for the sweep to notice.
    if (document.head) {
      new MutationObserver(() => purpleFavicon()).observe(document.head, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
      });
    }
    purpleFavicon();
    // Quality watchdog: whenever the playing stream is below 1080, switch it.
    setInterval(enforceQuality, 5000);
  }

  // Flags go on immediately with defaults so there is no unstyled flash,
  // then get corrected once storage resolves.
  applyFlags();

  const boot = () => {
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  };

  try {
    chrome.storage.sync.get(SETTINGS, (stored) => {
      if (!chrome.runtime.lastError && stored) G = Object.assign({}, SETTINGS, stored);
      S = derive(G);
      applyFlags();
      boot();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (k in G) G[k] = newValue;
      }
      S = derive(G);
      applyFlags();
      // The logo and favicon swaps are href/src rewrites, not CSS rules, so
      // they are the two things a flag change cannot undo on its own.
      if (!S.purpleTheme) {
        restoreLogos();
        restoreFavicon();
        clearAllPaint();
      }
      if (S.deletedLog) mountLogButton();
      else teardownLog();
      scan(document);
      purpleFavicon();
    });
  } catch {
    boot(); // storage unavailable (e.g. sandboxed frame) — run with defaults
  }
})();
