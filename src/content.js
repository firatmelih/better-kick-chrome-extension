/* Better Kick — content script
 *
 * Design note: almost all *hiding* is done by kick.css, not by this script.
 * Kick's chat is a React list that recycles DOM nodes, so deleting nodes (or
 * stamping per-node "hidden" classes) fights the framework and can crash it.
 * Instead JS only does the few things CSS cannot:
 *   1. tag chat entries / containers so CSS has a stable hook
 *   2. strip unicode emoji out of text nodes
 *   3. add the "username:" colon when Kick's own separator is gone
 *   4. hide sub / gift-sub controls that are only identifiable by their text
 *   5. repaint Kick-green computed colors into purple
 *
 * Chat scrolling is not handled here at all: dropping rows desyncs Kick's
 * virtual list, and fixing that means overriding page-world code, which a
 * content script cannot reach. That lives in chatscroll.js.
 */
(() => {
  'use strict';

  const PURPLE = 'rgb(145, 71, 255)';

  const DEFAULTS = {
    plainChat: true,      // no emotes, badges, images, svg in chat
    stripEmoji: true,     // strip unicode emoji from message text
    removeLinks: false,   // false = links stay as unclickable plain text
    hideSubs: true,       // subscribe / gift-sub UI and sub event messages
    hideDrops: true,      // drops / daily-reward chest, top bar and sidebar
    hidePinned: true,     // pinned messages, highlights, celebrations
    killAnimations: true, // no animations/transitions in chat
    purpleTheme: true,    // purple theme instead of Kick green
    monoUsernames: false, // force all usernames to one flat color
    hideTimestamps: false,
    hideEmpty: true,      // drop rows left with no text once stripping is done
    hideRepeats: true,    // drop copypasta: same message 10x in 10 minutes
    force1080: true,      // keep the player at 1080p, re-apply when it drops
    smoothScroll: true,   // own chat's auto-scroll + custom scrollbar
    rememberBrowse: true  // restore the last browse filters (language, sort)
  };

  // settings key -> <html> attribute that kick.css keys off of
  const FLAGS = {
    plainChat: 'data-bpk-plain',
    removeLinks: 'data-bpk-nolinks',
    hideSubs: 'data-bpk-subs',
    hideDrops: 'data-bpk-drops',
    hidePinned: 'data-bpk-pinned',
    killAnimations: 'data-bpk-anim',
    purpleTheme: 'data-bpk-theme',
    monoUsernames: 'data-bpk-mono',
    hideTimestamps: 'data-bpk-notime',
    hideEmpty: 'data-bpk-empty',
    hideRepeats: 'data-bpk-repeat',
    // Read by chatscroll.js / quality.js / browse.js, which run in the page
    // world and so share no variables with this script — only the DOM.
    smoothScroll: 'data-bpk-scroll',
    force1080: 'data-bpk-1080',
    rememberBrowse: 'data-bpk-browse'
  };

  let S = Object.assign({}, DEFAULTS);

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
  const EMOJI_TEST = new RegExp(EMOJI_SRC, 'u'); // non-global: safe for .test()

  function stripEmojiIn(root) {
    if (!S.stripEmoji || !root || root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && EMOJI_TEST.test(n.nodeValue)) hits.push(n);
    }
    for (const t of hits) {
      const next = t.nodeValue.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ');
      if (next !== t.nodeValue) t.nodeValue = next;
    }
  }

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
        removeClass(el, 'bpk-empty');
        removeClass(el, 'bpk-hide-row');
        removeClass(el, 'bpk-repeat');
        clearRowFlips(el);
      }
    }
    let p = root.nodeType === 1 ? root.parentElement : null;
    while (p) {
      if (p.classList.contains('bpk-entry') && !isRowLike(p)) {
        removeClass(p, 'bpk-entry');
        removeClass(p, 'bpk-empty');
        removeClass(p, 'bpk-hide-row');
        removeClass(p, 'bpk-repeat');
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
      stripEmojiIn(entry); // must run before collapseBlanks/markEmpty
      if (S.plainChat) collapseBlanks(entry);
      markSubEvent(entry, immediate); // unconditional: must also UNmark on recycle
      if (S.plainChat) ensureColon(entry);
      // renderedText() walks the whole row, and both checks below need the
      // same string, so it is computed once here rather than twice.
      const text =
        S.hideEmpty || S.hideRepeats
          ? renderedText(entry).replace(TIME_PREFIX_RE, '')
          : '';
      markEmpty(entry, immediate, text);
      markRepeat(entry, immediate, text);
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

  const MEDIA_TAGS = new Set([
    'IMG', 'SVG', 'PICTURE', 'VIDEO', 'CANVAS', 'OBJECT', 'EMBED', 'IFRAME', 'I'
  ]);
  const KEEP_TAGS = new Set(['BR', 'INPUT', 'TEXTAREA', 'SELECT']);

  // Text that exists for screen readers only. A badge is usually
  // <span><img><span class="sr-only">Moderator</span></span>, so this text is
  // invisible but still lands in textContent — which is what made badge
  // wrappers look non-empty (leaving "_ _ _ username:") and made a row full of
  // nothing but badges look like it had something to say.
  // [aria-hidden="true"] is deliberately NOT here: it means hidden from screen
  // readers, not from the screen — Kick's visible ":" separator carries it.
  const SR_ONLY_SEL = [
    '[class*="sr-only" i]',
    '[class*="srOnly" i]',
    '[class*="visually-hidden" i]',
    '[class*="visuallyHidden" i]',
    '[class*="screen-reader" i]',
    '[class*="screenReader" i]',
    '[class*="a11y" i]',
    'title',
    'desc'
  ].join(',');

  function isDecorative(el) {
    if (MEDIA_TAGS.has(el.tagName.toUpperCase())) return true;
    try {
      return el.matches(SR_ONLY_SEL);
    } catch {
      return false;
    }
  }

  // True when nothing inside this element would render as readable text.
  // Purely structural — no class-name guessing and no layout measurement, so
  // it can't drift with Kick's markup and can't oscillate.
  function isCollapsible(el) {
    if (KEEP_TAGS.has(el.tagName.toUpperCase())) return false;
    if (isDecorative(el)) return true;
    // A span holding only whitespace is a spacer, not decoration — keep it,
    // otherwise "name:" and the message run together.
    if (el.children.length === 0 && el.textContent.length > 0 && !el.textContent.trim()) {
      return false;
    }
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        if (node.nodeValue && node.nodeValue.trim()) return false;
      } else if (node.nodeType === 1 && !isCollapsible(node)) {
        return false;
      }
    }
    return true;
  }

  // Hiding a badge's <img> is not enough: Kick wraps each badge in a span that
  // keeps its own width and margin, which is what leaves "_ _ _ username:".
  // Mark the OUTERMOST element that renders no text, so the wrapper collapses
  // with it and the reserved space goes too.
  function collapseBlanks(entry) {
    for (const child of entry.children) collapseFrom(child);
  }

  function collapseFrom(el) {
    if (isCollapsible(el)) {
      addClass(el, 'bpk-blank');
      return; // whole subtree is gone; no need to walk into it
    }
    removeClass(el, 'bpk-blank');
    for (const child of el.children) collapseFrom(child);
  }

  // Everything inside a row that is not the message itself: the username, the
  // timestamp, and the decorations kick.css hides. Text found under any of
  // these does not count towards "did this person actually say something".
  const NON_MESSAGE_SEL = [
    IDENT_SEL,
    SR_ONLY_SEL,
    'time',
    '[class*="timestamp" i]',
    '[class*="time-stamp" i]',
    '[data-testid*="timestamp" i]',
    // Current Kick: the timestamp span has no telling class, but its inline
    // style toggles visibility through this variable.
    '[style*="--chatroom-timestamps-display" i]',
    '[data-testid*="badge" i]',
    '[data-testid*="emote" i]',
    '[data-testid*="sticker" i]',
    '[data-emote-name]',
    '[data-emote-id]',
    '[data-emoji]',
    '[role="img"]',
    '[class*="emote" i]',
    '[class*="emoji" i]',
    '[class*="badge" i]',
    '[class*="sticker" i]',
    '[class*="avatar" i]',
    '[class*="gif" i]',
    '[class*="logo" i]',
    '[class*="verified" i]',
    '[class*="moderator" i]',
    '[class*="reaction" i]',
    '[class*="preview" i]',
    '[class*="embed" i]'
  ].join(',');

  // True when this text is actually on screen and is not a timestamp or a
  // decoration's label.
  // Only ancestors strictly between the text and the row are considered. The
  // row's own classes describe the whole row, not this text — counting them
  // would make an already-hidden row look like it said nothing.
  function isRenderedText(node, entry) {
    let p = node.parentElement;
    while (p && p !== entry) {
      try {
        if (p.classList.contains('bpk-blank') || p.classList.contains('bpk-hide')) {
          return false;
        }
        if (p.matches(NON_MESSAGE_SEL)) return false;
      } catch {
        return false;
      }
      // With links deleted their text is not on screen either.
      if (S.removeLinks && p.tagName === 'A') return false;
      p = p.parentElement;
    }
    return true;
  }

  // Text runs from separate elements are joined with a space, so "bob" and
  // "lol" in sibling spans read as "bob lol" and not "boblol".
  function renderedText(entry) {
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    const runs = [];
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      if (!isRenderedText(n, entry)) continue;
      runs.push(n.nodeValue.trim());
    }
    return runs.join(' ').replace(/\s+/g, ' ').trim();
  }

  const TIME_PREFIX_RE = /^\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\s*/i;
  // A row showing one bare token and a colon is a stranded username.
  const LONE_NAME_RE = /^[\w.\-]{1,32}\s*:\s*$/;

  // A message that was nothing but emotes/emoji/gifs is blank once stripped,
  // so the row would render as a lone "username:". Hide the whole row —
  // fully collapsed (display:none via CSS), not just blanked, so it doesn't
  // leave a gap. See setRowClass for why the *timing* of that collapse (not
  // the property used) is what used to desync Kick's virtualized list.
  function markEmpty(entry, immediate, text) {
    if (!S.hideEmpty) {
      setRowClass(entry, 'bpk-empty', false, immediate);
      return;
    }

    if (!text) {
      setRowClass(entry, 'bpk-empty', true, immediate);
      return;
    }

    let empty = false;

    // Primary rule, and the one that does not care how Kick names anything:
    // the separator sits between the name and the message, so if the row
    // renders a ":" with nothing after it, nothing was said. Uses the FIRST
    // colon, so a message that itself ends in ":" still counts as text.
    const colon = text.indexOf(':');
    if (colon >= 0) empty = !text.slice(colon + 1).trim();

    if (!empty) {
      const ident = entry.querySelector(IDENT_SEL);
      if (ident) {
        // Drop the username wherever it sits, see whether anything is left.
        const name = (ident.textContent || '').trim().replace(/:$/, '');
        let rest = text;
        const at = name ? rest.indexOf(name) : -1;
        if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + name.length);
        empty = rest.replace(/[\s:]+/g, '') === '';
      }
    }

    // Last resort for a row with no colon and no recognisable username.
    if (!empty) empty = LONE_NAME_RE.test(text);

    setRowClass(entry, 'bpk-empty', empty, immediate);
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

  // Kick's ":" separator often lives in a node we hide. Re-add it via CSS
  // ::after so the injected colon never leaks into textContent.
  function ensureColon(entry) {
    const ident = entry.querySelector(IDENT_SEL);
    if (!ident) return;
    const name = (ident.textContent || '').trim().replace(/:$/, '');
    if (!name) return;
    const txt = (entry.textContent || '').replace(/\s+/g, ' ');
    if (txt.includes(name + ':') || txt.includes(name + ' :')) {
      removeClass(ident, 'bpk-colon');
    } else {
      addClass(ident, 'bpk-colon');
    }
  }

  /* ------------------------------------------------------------------ */
  /* repeated messages (copypasta)                                       */
  /* ------------------------------------------------------------------ */

  // Once the exact same message has been posted REPEAT_LIMIT times inside
  // REPEAT_WINDOW_MS, that text is banned: the copies already on screen are
  // collapsed and every later copy is collapsed on sight, for the rest of the
  // page session. Matching is on the WHOLE message, so "crazy!" being banned
  // does not touch "man that was crazy!" — only people parroting the exact
  // line are dropped.
  const REPEAT_LIMIT = 10;
  const REPEAT_WINDOW_MS = 10 * 60 * 1000;
  const REPEAT_MAX_KEYS = 4000; // distinct phrases tracked before pruning
  const SEEN_MAX = 5000;        // messages remembered for double-count defence

  const repeatHits = new Map();     // phrase -> timestamps inside the window
  const bannedText = new Set();     // phrase -> collapse on sight
  const seenIds = new Map();        // dedup id -> true (insertion ordered)
  const seenByNode = new WeakMap(); // fallback for rows carrying no id at all
  let repeatPath = location.pathname;

  const MSG_ID_SEL =
    '[data-chat-entry],[data-chat-id],[data-message-id],[data-chat-entry-id]';

  function messageId(entry) {
    let el = null;
    try {
      el = entry.matches(MSG_ID_SEL) ? entry : entry.querySelector(MSG_ID_SEL);
    } catch {
      return null;
    }
    if (!el) return null;
    return (
      el.getAttribute('data-chat-entry') ||
      el.getAttribute('data-chat-id') ||
      el.getAttribute('data-message-id') ||
      el.getAttribute('data-chat-entry-id') ||
      null
    );
  }

  // The message on its own. renderedText() already drops timestamps and
  // anything under an identity element, but Kick's ":" separator still lands
  // in it — and on a skin where IDENT_SEL misses, so does the username.
  // Returns "" for anything that cannot be read as "someone said something"
  // (sub events, system notices, rows we cannot parse): those are never
  // counted and never hidden by this feature.
  function messageText(entry, text) {
    if (!text) return '';
    const ident = entry.querySelector(IDENT_SEL);
    const name = ident ? (ident.textContent || '').trim().replace(/:$/, '') : '';
    let stripped = text;
    let named = false;
    if (name) {
      const at = stripped.indexOf(name);
      if (at >= 0) {
        stripped = stripped.slice(0, at) + stripped.slice(at + name.length);
        named = true;
      }
    }
    if (!named) {
      // No identity element matched, so fall back to markEmpty's assumption
      // that "name:" opens the row. A colon far into the line is punctuation
      // inside a message, not a separator — such a row is not parseable here.
      const colon = stripped.indexOf(':');
      if (colon < 0 || colon > 32) return '';
      stripped = stripped.slice(colon + 1);
    }
    return stripped.replace(/^[\s:]+/, '').trim();
  }

  function repeatKey(entry, text) {
    const msg = messageText(entry, text);
    if (!msg) return '';
    return msg.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // A message must only ever be counted once, no matter how many times Kick
  // re-renders its row or how often the row is re-examined. A real message id
  // is unique forever, so it dedupes on its own. Failing that, Kick's list
  // index is stable while a message stays in the list, so index+text is the
  // next best key: it survives re-renders and scrolling, while an index that
  // gets recycled onto a different message still counts.
  function alreadyCounted(entry, key) {
    const id = messageId(entry);
    const idx = entry.getAttribute('data-index');
    const dedup = id ? 'id:' + id : idx != null ? 'ix:' + idx + '|' + key : null;
    if (dedup === null) {
      if (seenByNode.get(entry) === key) return true;
      seenByNode.set(entry, key);
      return false;
    }
    if (seenIds.has(dedup)) return true;
    seenIds.set(dedup, true);
    if (seenIds.size > SEEN_MAX) {
      let drop = seenIds.size - SEEN_MAX + 1000;
      for (const k of seenIds.keys()) {
        seenIds.delete(k);
        if (--drop <= 0) break;
      }
    }
    return false;
  }

  function countRepeat(entry, key) {
    if (bannedText.has(key)) return; // already banned, nothing left to count
    if (alreadyCounted(entry, key)) return;
    const now = Date.now();
    let hits = repeatHits.get(key);
    if (!hits) {
      hits = [];
      repeatHits.set(key, hits);
    }
    hits.push(now);
    const cut = now - REPEAT_WINDOW_MS;
    while (hits.length && hits[0] < cut) hits.shift(); // rolling window
    if (hits.length >= REPEAT_LIMIT) {
      repeatHits.delete(key);
      bannedText.add(key);
      sweepRepeats(); // the copies already on screen go too
      return;
    }
    if (repeatHits.size > REPEAT_MAX_KEYS) pruneRepeats(cut);
  }

  function pruneRepeats(cut) {
    for (const [k, hits] of repeatHits) {
      if (!hits.length || hits[hits.length - 1] < cut) repeatHits.delete(k);
    }
    // Still oversized: a chat busy enough to hold 4000 distinct live phrases.
    // Drop the oldest keys — they are the ones closest to expiring anyway.
    if (repeatHits.size > REPEAT_MAX_KEYS) {
      let drop = repeatHits.size - REPEAT_MAX_KEYS;
      for (const k of repeatHits.keys()) {
        repeatHits.delete(k);
        if (--drop <= 0) break;
      }
    }
  }

  // A phrase only becomes banned on its 10th copy, by which point the earlier
  // nine are already on screen — re-evaluate every tagged row so they go too.
  // Coalesced to one pass per frame: several phrases can tip over together.
  let sweepScheduled = false;
  function sweepRepeats() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
      sweepScheduled = false;
      for (const el of document.querySelectorAll('.bpk-entry')) {
        // Deliberately not immediate: these rows are already painted and
        // measured, so the collapse goes through setRowClass's debounce like
        // every other late change.
        scheduleScan(el, false);
      }
    });
  }

  function markRepeat(entry, immediate, text) {
    if (!S.hideRepeats) {
      setRowClass(entry, 'bpk-repeat', false, immediate);
      return;
    }
    const key = repeatKey(entry, text);
    if (!key) {
      setRowClass(entry, 'bpk-repeat', false, immediate);
      return;
    }
    countRepeat(entry, key);
    setRowClass(entry, 'bpk-repeat', bannedText.has(key), immediate);
  }

  // Counts belong to one chat. Kick is a SPA, so switching channel keeps this
  // script alive — the tallies have to be dropped by hand.
  function resetRepeats() {
    if (location.pathname === repeatPath) return;
    repeatPath = location.pathname;
    repeatHits.clear();
    bannedText.clear();
    seenIds.clear();
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
        if (isKickGreen(cs.getPropertyValue(prop))) addClass(el, cls + suffix);
      }
    }
  }

  function repaint(el) {
    if (!S.purpleTheme || !el || el.nodeType !== 1) return;
    if (paintGen.get(el) === generation) return;
    paintGen.set(el, generation);

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return;
    }
    if (!cs || !cs.color) return;

    for (const prop of COLOR_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (isKickGreen(v)) el.style.setProperty(prop, PURPLE, 'important');
    }
    // A <stop> lives inside <defs>, which the UA stylesheet gives display:none.
    // Computed style is still defined there, but reading the attribute as well
    // costs one property check per element and does not depend on the engine
    // resolving presentation attributes for an unrendered subtree.
    if (el.localName === 'stop' && isKickGreen(el.getAttribute('stop-color'))) {
      el.style.setProperty('stop-color', PURPLE, 'important');
    }
    for (const prop of ['box-shadow', 'background-image', 'text-shadow']) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== 'none' && isKickGreen(v)) {
        el.style.setProperty(prop, greenToPurple(v), 'important');
      }
    }
    repaintPseudo(el);
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

  function scan(root) {
    if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return;
    tagChatrooms(root);
    tagEntries(root);
    hideLabelledControls(root);
    purpleLogos(root);
    queueRepaint(root.nodeType === 9 ? root.documentElement : root);
  }

  // Attribute churn is constant on a React page, so an attribute change only
  // re-examines that one element — never its whole subtree.
  function scanShallow(el) {
    if (!el || el.nodeType !== 1) return;
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
    try {
      tagEntries(node);
    } catch {
      /* one bad subtree must not take down the batch */
    }
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData') {
        const entry = rec.target.parentElement?.closest('.bpk-entry');
        if (entry) scheduleScan(entry, false);
        continue;
      }
      if (rec.type === 'attributes') {
        // A class change is the main way an element's colours change, so let
        // the repaint pass look at it again rather than trusting the verdict
        // it reached under the old class list.
        if (rec.attributeName === 'class') paintGen.delete(rec.target);
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
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function applyFlags() {
    const html = document.documentElement;
    if (!html) return;
    for (const [key, attr] of Object.entries(FLAGS)) {
      html.setAttribute(attr, S[key] ? 'on' : 'off');
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
      // 'style' is deliberately not observed: repaint() writes inline styles,
      // and observing them would feed our own writes straight back in.
      // 'data-index' changes when Kick's virtual list recycles a row into a
      // different message, so the row must be re-evaluated then.
      attributeFilter: ['class', 'data-chat-entry', 'data-index', 'title', 'aria-label']
    });
    // Kick swaps whole panels on channel navigation; a slow sweep catches
    // anything a mutation batch missed.
    setInterval(() => {
      resetRepeats(); // channel change: the copypasta tallies are per chat
      // Re-open every element to the repaint pass. Colours are not settled at
      // first sight — a browse card hydrates into its live state well after
      // it is inserted — so a once-only check leaves greens behind. Nothing
      // happens in a background tab, and the queue is budgeted per frame, so
      // the re-check costs a couple of frames every 4s on a visible page.
      if (!document.hidden) generation++;
      scan(document.body || document);
    }, 4000);
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
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      if (!chrome.runtime.lastError && stored) S = Object.assign({}, DEFAULTS, stored);
      applyFlags();
      boot();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (k in S) S[k] = newValue;
      }
      applyFlags();
      // The logo swap is a src rewrite, not a CSS rule, so it is the one
      // thing a flag change cannot undo on its own.
      if (!S.purpleTheme) restoreLogos();
      scan(document);
    });
  } catch {
    boot(); // storage unavailable (e.g. sandboxed frame) — run with defaults
  }
})();
