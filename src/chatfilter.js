/* Simple Chat for Kick — chat message filter.
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
 * Plain chat messages are never dropped here. "Just chat" (justchat.js)
 * draws its own list and gets every frame through onFrame() below, so it
 * needs no help from this file and Kick's own list is left complete.
 */
(() => {
  'use strict';

  if (window.__bpkChatFilter) return;
  window.__bpkChatFilter = true;

  const NativeWS = window.WebSocket;
  if (typeof NativeWS !== 'function') return;

  const DBG = '[Simple Chat for Kick filter]';
  const stats = { frames: 0, dropped: 0, events: 0 };
  let spying = false;

  // Strict 'on': an absent attribute means content.js has not run, and the
  // safe reading of "I don't know" is to filter nothing.
  const on = (attr) => document.documentElement.getAttribute(attr) === 'on';

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

  // Kick's socket has spoken two dialects. The old one (Pusher) sends one
  // event per frame: {event, data}. The current one (Centrifugo) wraps the
  // same event in a push, {push: {channel, pub: {data: {event, data}}}}, and
  // may batch several replies into one frame, one JSON object per line.
  // Returns [{name, msg}] for every event found; unknown lines are skipped.
  function eventsIn(raw) {
    const out = [];
    for (const lineText of raw.split('\n')) {
      if (!lineText) continue;
      let frame;
      try {
        frame = JSON.parse(lineText);
      } catch {
        continue; // not JSON — not ours to touch
      }
      const inner =
        frame && frame.push && frame.push.pub && frame.push.pub.data
          ? frame.push.pub.data
          : frame;
      const name = inner && typeof inner.event === 'string' ? inner.event : '';
      if (!name) continue;
      let msg = inner.data;
      if (typeof msg === 'string') {
        try {
          msg = JSON.parse(msg);
        } catch {
          msg = null;
        }
      }
      out.push({ name, msg });
    }
    return out;
  }

  // A frame is dropped only when every event in it is one we drop — a batch
  // holding anything else is delivered whole.
  function dropsFrame(raw) {
    if (typeof raw !== 'string' || raw.length > 200000) return false;
    const events = eventsIn(raw);
    if (!events.length) return false;
    let drop = true;
    for (const ev of events) {
      if (!dropsEvent(ev.name, ev.msg)) drop = false;
    }
    return drop;
  }

  function dropsEvent(name, msg) {
    // Protocol internals, never content: pusher:ping, pusher:connection_
    // established, pusher_internal:subscription_succeeded. That last one
    // contains the word "subscription" and would otherwise match the sub
    // rule below — swallowing it tells the client its channel never
    // subscribed, which does not hide sub messages, it kills the chat.
    if (/^pusher/i.test(name)) return false;

    if (spying) console.log(DBG, 'frame', name, msg);

    // The deleted-message log reads the same frames. It is a passive
    // observer wrapped in its own try: it must never be able to decide
    // whether a message is delivered, and a bug in it must not cost a chat.
    // Deliberately runs before the drop rules below, so a message this file
    // filters out is still recoverable if a moderator later deletes it.
    try {
      if (window.__bpkLog) window.__bpkLog.record(name, msg);
    } catch (err) {
      if (!dropsEvent.logWarned) {
        dropsEvent.logWarned = true;
        console.warn(DBG, 'deleted-message log threw:', err);
      }
    }

    // Just chat reads the same way and under the same rule: it only ever
    // observes, and it sees every message, including ones dropped below.
    try {
      if (window.__bpkJust) window.__bpkJust.onFrame(name, msg);
    } catch (err) {
      if (!dropsEvent.justWarned) {
        dropsEvent.justWarned = true;
        console.warn(DBG, 'just chat threw:', err);
      }
    }

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
          dropSubs: on('data-bpk-subs'),
          dropPinned: on('data-bpk-pinned')
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
