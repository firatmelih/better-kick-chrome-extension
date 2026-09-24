/* Simple Chat for Kick — "Just chat".
 *
 * Runs in the PAGE world at document_start, next to chatfilter.js.
 *
 * Every earlier attempt at plain-text chat edited Kick's own rows: hide the
 * badges, strip the emoji, collapse the emote-only lines, collapse the
 * copypasta. Kick's message list is virtualised off measured row heights,
 * so each of those edits changed a height it had already measured, and the
 * list re-laid itself out around it — the flicker. There was no version of
 * "edit the row" that did not do that.
 *
 * So this does not touch Kick's rows at all. It keeps its own list, fed from
 * the same data Kick renders from:
 *   - the chat history request (web.kick.com/api/v1/chat/<id>/history),
 *     read from a clone of the response as Kick fetches it;
 *   - live messages, deletions and bans off the WebSocket, handed over by
 *     chatfilter.js (which owns the socket patch) through onFrame().
 * and draws it as nothing but "username: text" over Kick's list, which
 * kick.css hides with visibility so Kick's layout never changes.
 *
 * Deleted messages (and a banned user's messages) are kept and highlighted
 * rather than removed. Clicking a name opens that user's history on this
 * channel.
 *
 * Messages are collected whether or not the mode is on, so switching it on
 * mid-stream shows the chat as it is rather than an empty box.
 */
(() => {
  'use strict';

  if (window.__bpkJust) return;

  const DBG = '[Simple Chat for Kick just chat]';
  const MAX = 300;          // lines kept while following the bottom
  const MAX_PAUSED = 1000;  // lines kept while scrolled up reading
  const STICK_PX = 30;      // this close to the bottom counts as following
  const KEEP = 20000;       // messages kept per channel for user histories

  const on = () => document.documentElement.getAttribute('data-bpk-just') === 'on';

  /* ------------------------------------------------------------------ */
  /* text                                                                */
  /* ------------------------------------------------------------------ */

  // Emotes, gifs and stickers arrive as markup in the text: "gg [emote:1:EZ]".
  const MARKUP_RE = /\[(?:emote|emoji|sticker|gif|img)[:|][^\]]*\]/gi;
  const EMOJI_RE = new RegExp(
    '[\\u{1F3FB}-\\u{1F3FF}]' +
      '|[0-9#*]\\uFE0F?\\u20E3' +
      '|[\\u{1F1E6}-\\u{1F1FF}]' +
      '|\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?' +
      '(\\u200D\\p{Extended_Pictographic}(\\uFE0F|\\uFE0E)?)*' +
      '|[\\uFE0F\\uFE0E\\u200D]',
    'gu'
  );

  function clean(content) {
    return String(content || '')
      .replace(MARKUP_RE, ' ')
      .replace(EMOJI_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Only plain chat messages. Sub, gift, host and reward notices carry their
  // own type and are not something anybody said.
  const EVENT_TYPE_RE = /celebration|subscription|gift|kicks|host|raid|reward/i;

  function parse(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.content !== 'string') return null;
    if (msg.type && EVENT_TYPE_RE.test(String(msg.type))) return null;
    const s = msg.sender;
    const user = s && String(s.username || s.slug || '').trim();
    if (!user) return null;
    const text = clean(msg.content);
    if (!text) return null; // nothing but emotes/emoji: it would read "username:"
    const t = Date.parse(msg.created_at);
    return {
      id: msg.id != null ? String(msg.id) : '',
      user,
      userId: s.id != null ? String(s.id) : '',
      color: (s.identity && s.identity.color) || '',
      text,
      t: Number.isFinite(t) ? t : Date.now()
    };
  }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  // One chat at a time: Kick is a single-page app, so a channel change is
  // noticed by the path changing and everything from before is dropped.
  // (Messages carry no id that ties them to the page: history's chat_id is
  // the channel id, a live message's chatroom_id is another number.)
  //
  // Two lists over the same message objects: `msgs` is what the chat shows
  // (short), `all` is what a user's history is read from (long). Sharing the
  // objects means a deletion marked once shows up in both.
  let msgs = [];        // on screen, oldest first
  let all = [];         // everything seen on this channel, oldest first
  const byId = new Map();
  let path = location.pathname;

  function checkChannel() {
    if (location.pathname === path) return;
    path = location.pathname;
    msgs = [];
    all = [];
    byId.clear();
    closeUser();
    rebuild();
  }

  function remember(m) {
    if (m.id) byId.set(m.id, m);
    all.push(m);
    if (all.length > KEEP) {
      for (const old of all.splice(0, all.length - KEEP)) {
        if (old.id && byId.get(old.id) === old) byId.delete(old.id);
      }
    }
  }

  function known(m) {
    return !!(m.id && byId.has(m.id));
  }

  /* ------------------------------------------------------------------ */
  /* the view                                                            */
  /* ------------------------------------------------------------------ */

  let box = null;
  let list = null;
  let more = null;
  let follow = true;

  function makeBox() {
    box = document.createElement('div');
    box.id = 'bpk-justchat';
    box.className = 'bpk-ui'; // content.js skips its own UI: no tagging, no repaint
    list = document.createElement('div');
    more = document.createElement('button');
    more.type = 'button';
    more.className = 'bpk-jc-more';
    more.textContent = 'More messages below';
    more.addEventListener('click', () => {
      follow = true;
      box.classList.remove('bpk-jc-paused');
      toBottom();
    });
    box.append(list, more);
    box.addEventListener('scroll', () => {
      follow = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
      if (follow) box.classList.remove('bpk-jc-paused');
    }, { passive: true });
    list.addEventListener('click', (e) => {
      const name = e.target.closest && e.target.closest('.bpk-jc-name');
      if (!name) return;
      const who = name.parentElement.dataset.user;
      if (panel && panel.isConnected && panelUser === who) closeUser();
      else openUser(who);
    });
  }

  // Kick re-creates the chat panel on navigation and React may drop foreign
  // children, so this is checked often and simply puts the box back.
  function mount() {
    if (!on()) return;
    const kick = document.getElementById('chatroom-messages');
    const host = kick && kick.parentElement;
    if (!host) return;
    if (!box) makeBox();
    if (box.parentElement !== host) {
      host.appendChild(box);
      follow = true;
      toBottom();
    }
  }

  function toBottom() {
    if (box) box.scrollTop = box.scrollHeight;
  }

  function line(m) {
    const row = document.createElement('div');
    row.className = m.deleted ? 'bpk-jc-line bpk-jc-deleted' : 'bpk-jc-line';
    row.dataset.id = m.id;
    row.dataset.user = m.user.toLowerCase();
    const name = document.createElement('span');
    name.className = 'bpk-jc-name';
    name.textContent = m.user;
    if (m.color) name.style.color = m.color;
    row.append(name, document.createTextNode(': ' + m.text));
    return row;
  }

  function trim() {
    const cap = follow ? MAX : MAX_PAUSED;
    if (msgs.length > cap) msgs.splice(0, msgs.length - cap);
    if (!list) return;
    let extra = list.childElementCount - cap;
    if (extra <= 0) return;
    let removed = 0;
    while (extra-- > 0 && list.firstElementChild) {
      removed += list.firstElementChild.offsetHeight;
      list.firstElementChild.remove();
    }
    // Keep the text a reader is looking at where it is.
    if (!follow && box) box.scrollTop -= removed;
  }

  function rebuild() {
    if (!list) return;
    const frag = document.createDocumentFragment();
    for (const m of msgs) frag.appendChild(line(m));
    list.replaceChildren(frag);
    if (follow) toBottom();
  }

  function append(m) {
    msgs.push(m);
    remember(m);
    if (list) {
      list.appendChild(line(m));
      if (follow) toBottom();
      else if (box) box.classList.add('bpk-jc-paused');
    }
    trim();
    if (panelUser === m.user.toLowerCase()) renderUser();
  }

  // Deleted messages stay, highlighted: the row is marked in place, so
  // nothing on screen moves.
  function markDeleted(test) {
    let hit = false;
    for (const m of all) {
      if (m.deleted || !test(m)) continue;
      m.deleted = true;
      hit = true;
      if (list && m.id) {
        const row = list.querySelector('[data-id="' + CSS.escape(m.id) + '"]');
        if (row) row.classList.add('bpk-jc-deleted');
      }
    }
    if (hit && panel && panel.isConnected) renderUser();
  }

  /* ------------------------------------------------------------------ */
  /* one user's history                                                  */
  /* ------------------------------------------------------------------ */

  // Everything this person said on this channel since the page opened (plus
  // whatever the initial history held), deleted messages included.
  let panel = null;
  let panelBody = null;
  let panelTitle = null;
  let panelUser = '';

  function clock(t) {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function makePanel() {
    panel = document.createElement('div');
    panel.id = 'bpk-jc-user';
    panel.className = 'bpk-ui';
    const head = document.createElement('div');
    head.className = 'bpk-jc-user-head';
    panelTitle = document.createElement('span');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'bpk-jc-user-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', closeUser);
    head.append(panelTitle, close);
    panelBody = document.createElement('div');
    panelBody.className = 'bpk-jc-user-body';
    panel.append(head, panelBody);
  }

  function openUser(who) {
    if (!who || !box || !box.parentElement) return;
    if (!panel) makePanel();
    panelUser = who;
    if (panel.parentElement !== box.parentElement) box.parentElement.appendChild(panel);
    renderUser();
  }

  function closeUser() {
    panelUser = '';
    if (panel) panel.remove();
  }

  function renderUser() {
    if (!panel || !panelUser) return;
    const showDeleted = document.documentElement.getAttribute('data-bpk-dellog') !== 'off';
    const mine = all.filter(
      (m) => m.user.toLowerCase() === panelUser && (showDeleted || !m.deleted)
    );
    const first = mine[mine.length - 1];
    const deleted = mine.filter((m) => m.deleted).length;
    panelTitle.replaceChildren();
    const name = document.createElement('span');
    name.className = 'bpk-jc-name';
    name.textContent = first ? first.user : panelUser;
    if (first && first.color) name.style.color = first.color;
    const count = document.createElement('span');
    count.className = 'bpk-jc-user-count';
    count.textContent =
      ' · ' + mine.length + (mine.length === 1 ? ' message' : ' messages') +
      (deleted ? ', ' + deleted + ' deleted' : '');
    panelTitle.append(name, count);

    const frag = document.createDocumentFragment();
    if (!mine.length) {
      const none = document.createElement('div');
      none.className = 'bpk-jc-user-empty';
      none.textContent = 'Nothing from them since this page opened.';
      frag.appendChild(none);
    }
    for (const m of mine) {
      const row = document.createElement('div');
      row.className = m.deleted ? 'bpk-jc-line bpk-jc-deleted' : 'bpk-jc-line';
      const time = document.createElement('span');
      time.className = 'bpk-jc-time';
      time.textContent = clock(m.t);
      row.append(time, document.createTextNode(m.text));
      frag.appendChild(row);
    }
    panelBody.replaceChildren(frag);
    panelBody.scrollTop = panelBody.scrollHeight;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && panel.isConnected) closeUser();
  });

  /* ------------------------------------------------------------------ */
  /* input: history                                                      */
  /* ------------------------------------------------------------------ */

  const HISTORY_RE = /\/api\/v\d+\/(?:chat\/\d+\/history|channels\/\d+\/messages)/;

  function onHistory(url, body) {
    if (!HISTORY_RE.test(url)) return;
    checkChannel();
    const raw = body && body.data && Array.isArray(body.data.messages) ? body.data.messages : [];
    let added = 0;
    for (const r of raw) {
      const m = parse(r);
      if (!m || known(m)) continue;
      msgs.push(m);
      remember(m);
      added++;
    }
    if (!added) return;
    // history comes newest first
    msgs.sort((a, b) => a.t - b.t);
    all.sort((a, b) => a.t - b.t);
    trim();
    rebuild();
    if (panel && panel.isConnected) renderUser();
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const p = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
        if (HISTORY_RE.test(url)) {
          p.then((res) => res.clone().json())
            .then((body) => onHistory(url, body))
            .catch(() => {});
        }
      } catch {
        /* never cost Kick its request */
      }
      return p;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const u = String(url);
      if (HISTORY_RE.test(u)) {
        this.addEventListener('load', () => {
          try {
            const body = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            onHistory(u, body);
          } catch {
            /* not JSON — ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return nativeOpen.apply(this, arguments);
  };

  /* ------------------------------------------------------------------ */
  /* input: the socket (called by chatfilter.js for every frame)         */
  /* ------------------------------------------------------------------ */

  function onFrame(name, msg) {
    if (!msg || typeof msg !== 'object') return;
    checkChannel();
    if (/ChatMessage/i.test(name)) {
      const m = parse(msg);
      if (!m || known(m)) return;
      append(m);
    } else if (/MessageDeleted/i.test(name)) {
      const id = String((msg.message && msg.message.id) || msg.message_id || msg.id || '');
      if (id) markDeleted((m) => m.id === id);
    } else if (/UserBanned/i.test(name) && !/Unbanned/i.test(name)) {
      const u = msg.user || {};
      const uid = u.id != null ? String(u.id) : '';
      const uname = String(u.username || u.slug || '').toLowerCase();
      if (uid || uname) {
        markDeleted((m) => (uid && m.userId === uid) || (uname && m.user.toLowerCase() === uname));
      }
    } else if (/ChatroomClear|ClearChat/i.test(name)) {
      markDeleted(() => true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  function sync() {
    checkChannel();
    if (!on()) return;
    const fresh = !box;
    mount();
    if (fresh && box) rebuild();
  }

  new MutationObserver(() => {
    if (on()) {
      sync();
      follow = true;
      toBottom();
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-bpk-just'] });
  setInterval(sync, 500);

  window.__bpkJust = {
    onFrame,
    report() {
      const out = { on: on(), messages: msgs.length, kept: all.length, mounted: !!(box && box.isConnected), follow };
      console.log(DBG, out);
      return out;
    }
  };
})();
