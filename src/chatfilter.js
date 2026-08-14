/* Better Kick — chat message filter.
 *
 * Runs in the PAGE world at document_start, before any of Kick's own code.
 *
 * This is the answer to the flicker, and it is a different answer from the
 * rest of the extension. Everything else here removes things from the DOM
 * after Kick has rendered them. For a chat *row* that does not work: Kick's
 * message list is virtualised off remembered row heights, and it simply
 * cannot recalculate around a row that disappears underneath it. The list
 * ends up with a height model that disagrees with the DOM, computes scroll
 * positions from the wrong numbers, renders the wrong window of rows,
 * repositions them, and does it again — the flicker and the broken scroll.
 * No amount of hiding, collapsing or scroll correction fixes that, because
 * the list is the thing doing the moving.
 *
 * So do not make it recalculate. Kick's chat arrives over a WebSocket; this
 * intercepts those frames and drops the messages we do not want *before*
 * they are handed to Kick's code. Kick never learns they existed, renders no
 * row for them, and its model stays exactly right. There is nothing to hide
 * and nothing to recover from.
 *
 * Rules of the house, because this sits in front of somebody's chat:
 *   - Fail OPEN. Anything unparsed, unrecognised or unexpected is delivered
 *     untouched. A bug here must cost a filtered message, never a chat.
 *   - Drop only what the settings already ask to be hidden — the same four
 *     toggles, read live off <html data-bpk-*> (content.js writes them).
 *   - Never drop an event Kick needs for state (bans, deletes, chatroom
 *     updates). Only the cosmetic ones are listed.
 *
 * kick.css still collapses rows as a safety net: the first screenful of
 * history arrives over HTTP rather than the socket, and anything this file
 * fails to recognise has to be caught somewhere.
 */
(() => {
  'use strict';

  if (window.__bpkChatFilter) return;
  window.__bpkChatFilter = true;

  const NativeWS = window.WebSocket;
  if (typeof NativeWS !== 'function') return;

  const DBG = '[Better Kick filter]';
  const stats = { frames: 0, dropped: 0, empty: 0, events: 0, repeats: 0 };
  let spying = false;

  // Strict 'on': an absent attribute means content.js has not run, and the
  // safe reading of "I don't know" is to filter nothing.
  const on = (attr) => document.documentElement.getAttribute(attr) === 'on';

  /* ------------------------------------------------------------------ */
  /* what counts as an empty message                                     */
  /* ------------------------------------------------------------------ */

  // Kick sends emotes as markup inside the message text, e.g.
  // "gg [emote:37226:EZ]". Strip the markup and the unicode emoji and see
  // whether the person actually said anything.
  const MARKUP_RE = /\[(?:emote|emoji|sticker|gif|img)[:|][^\]]*\]/gi;

  // Copy of content.js's emoji matcher — the two files share no scope, and
  // a divergence here would mean the socket and the DOM disagree about what
  // "empty" means.
  const EMOJI_RE = new RegExp(
    '[\\u{1F3FB}-\\u{1F3FF}]' +
      '|[0-9#*]\\uFE0F?\\u20E3' +
      '|[\\u{1F1E6}-\\u{1F1FF}]' +
      '|\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?' +
      '(\\u200D\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?)*' +
      '|[\\uFE0F\\uFE0E\\u200D]',
    'gu'
  );

  function spoken(content) {
    return String(content || '')
      .replace(MARKUP_RE, ' ')
      .replace(EMOJI_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------------ */
  /* copypasta                                                           */
  /* ------------------------------------------------------------------ */

  // Same rule as content.js: once the exact same line has been posted 10
  // times inside 10 minutes it is banned for the rest of the page session.
  // Counting here rather than in the DOM means copies 11 and up never arrive
  // at all; the ten already on screen are still collapsed by kick.css.
  const LIMIT = 10;
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_KEYS = 4000;
  const hits = new Map();
  const banned = new Set();
  let path = location.pathname;

  function isBanned(text) {
    if (location.pathname !== path) {
      // Channel change: the tallies belong to one chat.
      path = location.pathname;
      hits.clear();
      banned.clear();
    }
    const key = text.toLowerCase();
    if (!key) return false;
    if (banned.has(key)) return true;
    const now = Date.now();
    let list = hits.get(key);
    if (!list) {
      list = [];
      hits.set(key, list);
    }
    list.push(now);
    const cut = now - WINDOW_MS;
    while (list.length && list[0] < cut) list.shift();
    if (list.length >= LIMIT) {
      hits.delete(key);
      banned.add(key);
      // Deliberately delivered, not dropped. content.js runs the same tally
      // against the DOM and only sweeps the copies already on screen when it
      // sees the tenth. Swallow that one here and its counter stops at nine
      // forever, so the nine visible copies never go. Let it through; every
      // copy after it is stopped at the socket.
      return false;
    }
    if (hits.size > MAX_KEYS) {
      for (const [k, v] of hits) {
        if (!v.length || v[v.length - 1] < cut) hits.delete(k);
      }
      let drop = hits.size - MAX_KEYS;
      for (const k of hits.keys()) {
        if (drop-- <= 0) break;
        hits.delete(k);
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* which frames go                                                     */
  /* ------------------------------------------------------------------ */

  // Cosmetic events only. Anything not named here — bans, deletes, chatroom
  // updates, polls, whatever Kick adds next — is delivered untouched.
  const COSMETIC = [
    {
      flag: 'data-bpk-subs',
      re: /Subscription|GiftedSubscriptions|LuckyUsersWhoGotGift|GiftsLeaderboard|Kicks(Gifted)?|GiftedKicks/i
    },
    {
      flag: 'data-bpk-pinned',
      re: /PinnedMessageCreated|StreamHost|Celebration|RewardRedeemed/i
    }
  ];

  // A chat message's own "this is not really a message" marker.
  const EVENT_TYPE_RE = /celebration|subscription|gift|kicks|host|raid|reward/i;

  function dropsFrame(raw) {
    if (typeof raw !== 'string' || raw.length > 200000) return false;
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return false; // not JSON — not ours to touch
    }
    const name = frame && typeof frame.event === 'string' ? frame.event : '';
    if (!name) return false;

    // Protocol internals, never content: pusher:ping, pusher:connection_
    // established, pusher_internal:subscription_succeeded. That last one
    // contains the word "subscription" and would otherwise match the sub
    // rule below — swallowing it tells the client its channel never
    // subscribed, which does not hide sub messages, it kills the chat.
    if (/^pusher/i.test(name)) return false;

    let msg = frame.data;
    if (typeof msg === 'string') {
      try {
        msg = JSON.parse(msg);
      } catch {
        msg = null;
      }
    }

    if (spying) console.log(DBG, 'frame', name, msg);

    for (const kind of COSMETIC) {
      if (kind.re.test(name)) {
        if (!on(kind.flag)) return false;
        stats.events++;
        return true;
      }
    }

    // From here on, only actual chat messages.
    if (!/ChatMessage/i.test(name)) return false;
    if (!msg || typeof msg.content !== 'string') return false; // unknown shape

    if (msg.type && EVENT_TYPE_RE.test(String(msg.type)) && on('data-bpk-subs')) {
      stats.events++;
      return true;
    }

    const text = spoken(msg.content);

    if (!text) {
      // Nothing but emotes, emoji or a gif: the row would render as a lone
      // "username:".
      if (!on('data-bpk-empty')) return false;
      stats.empty++;
      return true;
    }

    if (on('data-bpk-repeat') && isBanned(text)) {
      stats.repeats++;
      return true;
    }

    return false;
  }

  /* ------------------------------------------------------------------ */
  /* the interception                                                    */
  /* ------------------------------------------------------------------ */

  const wrappers = new WeakMap();

  // Wrapping the listener rather than the socket keeps the event object,
  // its ordering and its `this` exactly as Kick expects for everything we
  // let through — a dropped message is simply a handler that is not called.
  function guard(listener) {
    const cached = wrappers.get(listener);
    if (cached) return cached;
    const isObj = typeof listener === 'object' && listener && typeof listener.handleEvent === 'function';
    if (typeof listener !== 'function' && !isObj) return listener;
    const fn = function (ev) {
      try {
        stats.frames++;
        if (ev && dropsFrame(ev.data)) {
          stats.dropped++;
          return undefined;
        }
      } catch (err) {
        // A filter that throws must not take chat with it.
        if (!guard.warned) {
          guard.warned = true;
          console.warn(DBG, 'filter threw, passing everything through:', err);
        }
      }
      return isObj ? listener.handleEvent.call(listener, ev) : listener.apply(this, arguments);
    };
    wrappers.set(listener, fn);
    return fn;
  }

  class BpkWebSocket extends NativeWS {
    addEventListener(type, listener, options) {
      if (type === 'message' && listener) {
        return super.addEventListener(type, guard(listener), options);
      }
      return super.addEventListener(type, listener, options);
    }

    removeEventListener(type, listener, options) {
      if (type === 'message' && listener && wrappers.has(listener)) {
        return super.removeEventListener(type, wrappers.get(listener), options);
      }
      return super.removeEventListener(type, listener, options);
    }
  }

  // `ws.onmessage = fn` is the other half of the API and Pusher clients use
  // it, so it has to route through the same guard. Backed by a real
  // listener, which keeps assignment idempotent the way the native property
  // is (assigning twice must not fire twice).
  Object.defineProperty(BpkWebSocket.prototype, 'onmessage', {
    configurable: true,
    enumerable: true,
    get() {
      return this.__bpkOnMessage || null;
    },
    set(fn) {
      const prev = this.__bpkOnMessage;
      if (prev) NativeWS.prototype.removeEventListener.call(this, 'message', guard(prev));
      this.__bpkOnMessage = typeof fn === 'function' ? fn : null;
      if (this.__bpkOnMessage) {
        NativeWS.prototype.addEventListener.call(this, 'message', guard(this.__bpkOnMessage));
      }
    }
  });

  try {
    window.WebSocket = BpkWebSocket;
  } catch {
    return; // locked down — the CSS net is still in place
  }

  /* ------------------------------------------------------------------ */
  /* diagnosis                                                           */
  /* ------------------------------------------------------------------ */

  window.__bpkFilter = {
    report() {
      const out = Object.assign(
        {
          version: '1.4.0',
          patched: window.WebSocket === BpkWebSocket,
          dropEmpty: on('data-bpk-empty'),
          dropRepeats: on('data-bpk-repeat'),
          dropSubs: on('data-bpk-subs'),
          dropPinned: on('data-bpk-pinned'),
          bannedPhrases: banned.size
        },
        stats
      );
      console.log(DBG, out);
      return out;
    },
    // Logs every socket frame's event name and payload. This is how to find
    // out what Kick actually sends if the names above ever stop matching:
    // frames:0 in the report means the socket is not being seen at all,
    // frames high with dropped:0 means the names are wrong.
    spy(v) {
      spying = v !== false;
      console.log(DBG, spying ? 'spying on socket frames' : 'spy off');
    }
  };
})();
