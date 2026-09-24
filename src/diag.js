/* Simple Chat for Kick — diagnostics.
 *
 * Page world, because that is the console you get when you hit F12 on
 * kick.com: anything content.js exposes lives in the isolated world and
 * cannot be typed at from there.
 *
 * Exists because the two things that break this extension — what Kick puts in
 * the URL, and where Kick's green actually comes from — cannot be worked out
 * from outside the browser. `__bpkDiag()` prints both in one go, so a bug
 * report can be a single paste instead of a guessing round.
 */
(() => {
  'use strict';

  if (window.__bpkDiag) return;

  const RGB_RE = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/;

  // Same test content.js repaints by, kept in step deliberately: if this says
  // an element is green, the repaint pass should have caught it, and the fact
  // that it did not is the finding.
  function isKickGreen(value) {
    if (!value) return false;
    const m = RGB_RE.exec(value);
    if (!m) return false;
    const r = +m[1], g = +m[2], b = +m[3];
    return g > 150 && r < g - 60 && b < g - 60;
  }

  const PROPS = [
    'color', 'background-color', 'border-top-color', 'border-bottom-color',
    'border-left-color', 'border-right-color', 'outline-color', 'fill', 'stroke',
    'box-shadow', 'background-image'
  ];

  function where(el) {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls) parts.push('.' + cls.trim().split(/\s+/).slice(0, 4).join('.'));
    return parts.join('').slice(0, 160);
  }

  function greens(limit) {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (out.length >= limit) break;
      for (const pseudo of [null, '::before', '::after']) {
        let cs;
        try { cs = getComputedStyle(el, pseudo); } catch { continue; }
        if (!cs) continue;
        if (pseudo && cs.content === 'none') continue;
        for (const prop of PROPS) {
          const v = cs.getPropertyValue(prop);
          if (!isKickGreen(v)) continue;
          out.push({
            el: where(el) + (pseudo || ''),
            prop,
            value: v.slice(0, 60),
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
            // The one that matters: if repaint() ran and worked, the inline
            // style carries our purple and the computed value would not be
            // green. Green + no inline style = the pass never reached it.
            inline: el.style.getPropertyValue(prop) || '(none)'
          });
          break;
        }
      }
    }
    return out;
  }

  window.__bpkDiag = function (limit) {
    const html = document.documentElement;
    const flags = {};
    for (const a of html.getAttributeNames()) {
      if (a.startsWith('data-bpk-')) flags[a] = html.getAttribute(a);
    }
    const found = greens(typeof limit === 'number' ? limit : 30);

    console.log('=== Simple Chat for Kick diagnostics ===');
    console.log('url        ', location.pathname + location.search);
    console.log('scripts    ', {
      quality: !!window.__bpkQuality,
      browse: !!window.__bpkBrowse,
      scroll: !!window.__bpkScroll,
      chatlog: !!window.__bpkLog
    });
    // The deleted-message log has two halves in two worlds and either can be
    // the missing one: no recorder means the socket hook never ran, a
    // recorder with no button means content.js could not find the chat
    // footer to mount it in.
    console.log('deleted log', {
      recorder: window.__bpkLog ? window.__bpkLog.report() : 'MISSING — chatlog.js did not run',
      button: !!document.querySelector('.bpk-log-btn'),
      panelOpen: !!document.querySelector('.bpk-log.bpk-on')
    });
    console.log('html flags ', flags);
    if (window.__bpkBrowse) {
      console.log('browse     ', window.__bpkBrowse.report());
      console.log('nav trail  ');
      console.table(window.__bpkBrowse.trail);
    } else {
      console.log('browse      MISSING — browse.js did not run in this frame');
    }
    // Panel memory lives in localStorage, so it is readable from here even
    // though the code that writes it runs in the isolated world.
    let panels = null;
    try { panels = JSON.parse(localStorage.getItem('bpk_panels') || 'null'); } catch { /* junk */ }
    const width = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    console.log('panels     ', {
      remembered: panels || '(nothing learned yet — collapse one to teach it)',
      sidebarNow: width('nav, aside, [class*="sidebar" i]'),
      chatNow: width('#chatroom, #chatroom-messages, [data-testid*="chatroom" i]')
    });

    console.log('still green (' + found.length + ')');
    if (found.length) console.table(found);
    else console.log('  none — every brand green on this page was repainted');
    return { url: location.pathname + location.search, flags, greens: found };
  };
})();
