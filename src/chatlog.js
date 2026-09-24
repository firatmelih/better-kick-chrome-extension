/* Simple Chat for Kick — deleted-message log.
 *
 * Page world, document_start, alongside chatfilter.js — for the same reason
 * that file exists: a deleted message is gone from the DOM before anyone can
 * read it, and Kick never tells the page what it was. The only place the text
 * still exists is the WebSocket frame that delivered it, so this keeps a small
 * cache of everything that came down the socket and, when a deletion event
 * arrives, pairs the two up.
 *
 * chatfilter.js already owns the WebSocket patch (one patch, one place), so
 * this file only exposes record() and that file calls it for every frame.
 *
 * What Kick actually sends, and therefore what can be known:
 *   ChatMessageEvent    — id, sender, content. The message itself.
 *   MessageDeletedEvent — the deleted message's id, and (when Kick's
 *                         auto-moderation did it) an AI flag and the rules
 *                         that were violated. It does NOT name a moderator.
 *   UserBannedEvent     — victim, `banned_by`, and an expiry for a timeout.
 *                         This one DOES name the moderator, and a ban also
 *                         takes the user's messages off screen.
 *
 * So "who deleted it" is answerable for bans and unanswerable for a plain
 * single-message delete — except that a moderator who deletes a message and
 * then bans the author does both within a second or two, and that ban names
 * them. A ban landing shortly after a delete backfills the name onto those
 * entries, marked as an attribution rather than a fact. Everything the UI
 * shows is either read straight out of a frame or explicitly hedged; nothing
 * is invented.
 *
 * The log lives here rather than in content.js because this is where the data
 * is; content.js gets a copy of every entry by postMessage and owns the UI.
 */
(() => {
  'use strict';

  if (window.__bpkLog) return;

  const DBG = '[Simple Chat for Kick log]';

  // Every message on screen and a good deal of scrollback: the cache only has
  // to outlive the gap between a message and its deletion.
  const MAX_CACHE = 3000;
  const MAX_LOG = 400;
  // A ban sweeps the user's messages off screen; these bound how much of
  // their history is treated as swept.
  const BAN_LOOKBACK_MS = 30 * 60 * 1000;
  const BAN_MAX_MESSAGES = 20;
  // A ban this soon after a delete is the same moderator action.
  const MOD_MATCH_MS = 15000;

  // Same strict reading as chatfilter.js: no attribute means content.js has
  // not run, and recording somebody's chat is not something to do by guess.
  const on = (attr) => document.documentElement.getAttribute(attr) === 'on';

  const cache = new Map(); // message id -> { id, user, userId, color, text, sentAt }
  const logged = new Set(); // message ids already in the log — never log twice
  const log = [];
  let seq = 0;
  let channel = location.pathname;

  const ORIGIN = location.origin && location.origin !== 'null' ? location.origin : '*';

  function post(type, payload) {
    try {
      window.postMessage(Object.assign({ __bpk: 'log', type }, payload), ORIGIN);
    } catch {
      /* nothing to do — the panel just stays empty */
    }
  }

  /* ------------------------------------------------------------------ */
  /* reading Kick's payloads                                             */
  /* ------------------------------------------------------------------ */

  function nameOf(u) {
    if (!u || typeof u !== 'object') return '';
    return String(u.username || u.slug || u.name || '').trim();
  }

  function idOf(u) {
    if (!u || typeof u !== 'object') return '';
    return u.id != null ? String(u.id) : '';
  }

  function timeOf(v) {
    if (!v) return 0;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }

  function duration(ms) {
    if (!(ms > 0)) return '';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  }

  // Kick's auto-moderation reports the rules it matched; the shape has changed
  // before (strings, then objects), so both are read.
  function rulesOf(msg) {
    const raw = msg.violatedRules || msg.violated_rules;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r) => (typeof r === 'string' ? r : r && (r.title || r.name || r.rule || r.type)))
      .filter(Boolean)
      .map(String);
  }

  /* ------------------------------------------------------------------ */
  /* the log                                                             */
  /* ------------------------------------------------------------------ */

  function add(entry) {
    entry.seq = ++seq;
    if (entry.id) logged.add(entry.id);
    log.push(entry);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    post('entry', { entry });
  }

  function remember(msg) {
    const id = msg.id != null ? String(msg.id) : '';
    if (!id || typeof msg.content !== 'string') return;
    cache.set(id, {
      id,
      user: nameOf(msg.sender) || '(unknown)',
      userId: idOf(msg.sender),
      color: (msg.sender && msg.sender.identity && msg.sender.identity.color) || '',
      text: msg.content,
      sentAt: timeOf(msg.created_at) || Date.now()
    });
    if (cache.size > MAX_CACHE) {
      // Map iterates in insertion order, so the first key is the oldest.
      const over = cache.size - MAX_CACHE;
      let n = 0;
      for (const k of cache.keys()) {
        cache.delete(k);
        logged.delete(k);
        if (++n >= over) break;
      }
    }
  }

  function onDeleted(msg) {
    const id = String(
      (msg.message && msg.message.id) || msg.messageId || msg.message_id || msg.id || ''
    );
    if (id && logged.has(id)) return; // already accounted for (a ban sweep, say)
    const src = id ? cache.get(id) : null;

    // Only fields that unambiguously mean "the moderator". `user` is not one
    // of them — on a delete event it is at least as likely to be the author.
    const by = nameOf(msg.deleted_by || msg.deletedBy || msg.moderator || msg.mod);

    // Left empty when Kick gave no reason at all — the UI says "deleted at
    // <time> by an unknown moderator" on its own, and padding that out with
    // the word "deleted" again would be noise pretending to be information.
    const ai = msg.aiModerated === true || msg.ai_moderated === true;
    const rules = rulesOf(msg);
    let why = ai ? 'removed by AutoMod' : '';
    const reason = typeof msg.reason === 'string' ? msg.reason.trim() : '';
    if (rules.length) why += (why ? ' — ' : 'broke ') + rules.join(', ');
    else if (reason) why += (why ? ' — ' : '') + reason;

    add({
      kind: 'delete',
      id,
      user: src ? src.user : '',
      color: src ? src.color : '',
      text: src ? src.text : '',
      known: !!src,
      sentAt: src ? src.sentAt : 0,
      at: Date.now(),
      by,
      guessed: false,
      why
    });
  }

  function onBanned(msg) {
    const victim = nameOf(msg.user);
    const by = nameOf(msg.banned_by || msg.bannedBy || msg.moderator);
    const until = timeOf(msg.expires_at || msg.expiresAt);
    const mins = Number(msg.duration);
    const perm =
      msg.permanent === true || (!until && !(mins > 0) && msg.permanent !== false);
    const now = Date.now();
    const span = until ? duration(until - now) : mins > 0 ? duration(mins * 60000) : '';
    const what = perm ? 'banned' : 'timed out' + (span ? ' for ' + span : '');

    // A moderator who deletes a message and then bans its author does both in
    // one action; the ban is the half that carries their name.
    if (by && victim) {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log[i];
        if (now - e.at > MOD_MATCH_MS) break;
        // Not onto an AutoMod removal: that one already says who did it, and
        // it was not this moderator.
        if (/AutoMod/i.test(e.why || '')) continue;
        if (e.kind === 'delete' && !e.by && e.user === victim) {
          e.by = by;
          e.guessed = true;
          post('update', { entry: e });
        }
      }
    }

    if (!victim) return;

    // A ban takes the user's messages off screen, so they were deleted too —
    // by this moderator, and that part is not a guess.
    const mine = [];
    for (const m of cache.values()) {
      if (m.user !== victim || logged.has(m.id)) continue;
      if (now - m.sentAt > BAN_LOOKBACK_MS) continue;
      mine.push(m);
    }
    const shown = mine.slice(-BAN_MAX_MESSAGES);

    add({
      kind: 'notice',
      id: '',
      user: victim,
      color: shown.length ? shown[shown.length - 1].color : '',
      text: '',
      known: true,
      sentAt: 0,
      at: now,
      by,
      guessed: false,
      why:
        what +
        (mine.length
          ? ' — ' +
            mine.length +
            ' message' +
            (mine.length === 1 ? '' : 's') +
            ' removed' +
            (mine.length > shown.length ? ' (' + shown.length + ' shown below)' : '')
          : '')
    });

    for (const m of shown) {
      add({
        kind: 'ban',
        id: m.id,
        user: m.user,
        color: m.color,
        text: m.text,
        known: true,
        sentAt: m.sentAt,
        at: now,
        by,
        guessed: false,
        why: 'author ' + what
      });
    }
  }

  function onCleared() {
    add({
      kind: 'notice',
      id: '',
      user: '',
      color: '',
      text: '',
      known: true,
      sentAt: 0,
      at: Date.now(),
      by: '',
      guessed: false,
      why: 'chat cleared by a moderator'
    });
  }

  function reset() {
    cache.clear();
    logged.clear();
    log.length = 0;
    post('reset', {});
  }

  /* ------------------------------------------------------------------ */
  /* entry point — called by chatfilter.js for every parsed frame        */
  /* ------------------------------------------------------------------ */

  function record(name, msg) {
    if (!on('data-bpk-dellog')) return;
    if (location.pathname !== channel) {
      // Another channel: this log belongs to one chat.
      channel = location.pathname;
      reset();
    }
    if (!msg || typeof msg !== 'object' || typeof name !== 'string') return;
    if (/ChatMessage/i.test(name)) return remember(msg);
    if (/MessageDeleted/i.test(name)) return onDeleted(msg);
    // "UserUnbannedEvent" does not contain "UserBanned", but the guard is
    // cheap and the cost of getting it wrong is an unban logged as a ban.
    if (/UserBanned/i.test(name) && !/Unbanned/i.test(name)) return onBanned(msg);
    if (/ChatroomClear|ClearChat/i.test(name)) return onCleared();
  }

  // content.js asks for the whole log when its panel opens (it may have been
  // reloaded, or the panel may be opening for the first time this page) and
  // tells us when the user clears it, so a later sync does not bring it back.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__bpk !== 'log') return;
    if (d.type === 'sync') post('list', { entries: log.slice() });
    else if (d.type === 'clear') {
      // The user emptied the window. The message cache stays — it is what
      // makes the *next* deletion readable.
      log.length = 0;
      logged.clear();
      post('reset', {});
    } else if (d.type === 'off') {
      // The feature was switched off. Then nothing is kept, cache included.
      reset();
    }
  });

  window.__bpkLog = {
    record,
    list: () => log.slice(),
    clear: () => {
      log.length = 0;
      logged.clear();
      post('reset', {});
    },
    report() {
      const out = {
        version: '1.10.1',
        recording: on('data-bpk-dellog'),
        cached: cache.size,
        entries: log.length
      };
      console.log(DBG, out);
      return out;
    }
  };
})();
