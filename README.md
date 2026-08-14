# Better Kick

A Chrome extension that strips Kick.com chat down to `username: plain text` and
repaints the site in purple.

## What it does

**Chat becomes plain text.** Emotes, unicode emoji, badges, avatars, gifs,
stickers, icons, logos, embeds and link previews are all gone. What's left is
the username, a colon, and the message. If Kick's own `:` separator was inside
something we hid, the extension re-adds one via CSS so the line still reads
right.

**Emote-only messages disappear completely.** If someone sent nothing but
emotes, emoji or a gif, there's no text left to show — so the whole row is
dropped, username included, rather than leaving a stranded `bob:` or a blank
gap. The check is live in both directions: a row un-hides if text turns up
later, and re-hides if the text goes away.

**Dropped messages are stopped at the socket, not hidden in the page.** This
is the important one, and it's why the chat no longer flickers. Kick's
message list is virtualised off remembered row heights, and it cannot
recalculate around a row that vanishes underneath it: its height model stops
matching the DOM, every scroll position it computes from that model is wrong,
so it aims past the real end, decides it isn't at the bottom, renders the
wrong window of rows, repositions them, and repeats. Hiding a row *better*
doesn't help — the list is the thing doing the moving.

So the messages never reach it. Chat arrives over a WebSocket, and
`src/chatfilter.js` intercepts those frames in the page world before Kick's
own code is handed them: emote-only messages, banned copypasta and
sub/gift/Kicks/pinned events are dropped there. Kick never learns they
existed, renders no row, and its model stays exactly right. Nothing to hide,
nothing to recalculate, nothing to flicker.

It fails **open** by design — anything unparsed, unrecognised or unexpected is
delivered untouched, and Pusher's own protocol frames are excluded before any
matching happens (`pusher_internal:subscription_succeeded` contains the word
"subscription"; swallowing it wouldn't hide sub messages, it would kill the
chat). A bug in there costs a filtered message, never a working chat.

**The DOM rules are still the safety net** — the first screenful of history
arrives over HTTP rather than the socket, and anything the filter doesn't
recognise has to be caught somewhere. Two rules govern that, both about the
same virtualised list:

- **Never `display: none`.** The list measures each row and remembers the
  height. A `display: none` row has no box and no `offsetParent`, so it can't
  be measured — the list keeps the height it remembers for a row that now
  occupies nothing, and from that moment its model and the DOM disagree.
  Every scroll position it computes off that model is wrong: it aims past the
  real end, decides it isn't at the bottom, renders the wrong window of rows,
  repositions them, and repeats. Dropped rows are collapsed to **zero height**
  instead (`kick.css` section 10) — same visual result, no gap, nothing
  painted, but the row keeps its box, so a fresh measurement reads 0 and the
  list gets to be right.
- **Judge the row before it paints.** All the other work in `content.js` is
  deferred to `requestAnimationFrame`; row tagging is not. A MutationObserver
  callback is a microtask — after the DOM changed, before the frame's layout
  and paint — so a row tagged there never appears at all. Deferring it by one
  frame means every dropped message flashes at full height first, *and* hands
  the list a full-height measurement of a row that's about to be zero.

A row's very first tagging applies instantly; a row that already painted only
re-collapses once its new verdict has held steady for ~220ms. Kick's own
re-renders churn row attributes constantly, and without that debounce a badge
briefly vanishing mid-render reads as "message just went empty" and flaps the
collapse on and off.

**Chat scrolling is taken over completely.** Dropping rows is exactly what
Kick's virtualised list can't cope with: it remembers each row's height, so
the moment a row is collapsed its idea of "the bottom" no longer matches the
DOM. Its auto-scroll then aims at a position that doesn't exist, misses,
concludes it isn't at the bottom, and fights itself — the jumping and the
stuck "N new messages" chip. So the extension takes the scroller away from
it: Kick's scroll-to-bottom calls are swallowed and the follow logic is
re-done against a measurement that can't be wrong — the on-screen bottom edge
of the last row that is actually rendered. Kick's native scrollbar is hidden
and replaced with a slim overlay one that fades in while you're in chat and
can be dragged. Scrolling up pauses following, as usual; the "N new messages"
chip still works (its click is caught and performed by us).

**Subs, gift subs and Kicks disappear.** Subscribe buttons, gift-sub buttons,
sub upsells, sub-only prompts, the "X gifted 5 subs" / "Y just subscribed"
event lines in chat, plus Kicks (donation) UI: the recent-senders pill bar
above chat, send-Kicks buttons, and "sent N Kicks" event rows.

Two of these hide by exact `data-testid` rather than by word, because the
obvious hooks aren't there. The subscribe button is `data-testid="sub-button"`
— the string "subscribe" appears nowhere on it, and its only text is localised
("Abone Ol" on a Turkish account), so both the `[*="subscribe"]` rules and the
English label matching in `content.js` walked straight past it. The gift-sub
leaderboard (the scrolling "top gifter" marquee above chat) says "gift" only
in an image path and an `alt`, so it's matched on
`button[aria-label*="leaderboard"]`, `[class*="leaderboard"]` and
`img[src*="/gift-ranks/"]`, with a `:has()` rule to take the two wrappers that
would otherwise stay behind as an empty 33px strip. The channel-points button
(`data-testid="channel-points-button"`) rides the drops toggle — same family,
a passive accrual counter.

**The player is locked to 1080p.** Kick remembers the chosen quality in
`sessionStorage.stream_quality`, which is per tab and gets wiped or reset to
"Auto" on a reload, a channel change or a stream restart — so the preference
is always gone by the time the player reads it. `quality.js` runs in the page
world before Kick's bundle boots, keeps the real preference in `localStorage`
(which does survive reloads, tabs and restarts), copies it into
`sessionStorage` in time for the player to read, and holds it there: any later
write that would lower it is replaced with 1080 instead of being stored, and
deletes are ignored. It learns the exact spelling Kick uses (`1080`, `1080p`,
`1080p60`) from Kick's own writes rather than guessing one.

As a fallback for streams that start below 1080 anyway, the extension also
checks the stream's actual resolution (`video.videoHeight`) every few seconds;
if it's low it walks the player's settings menu and clicks the 1080p option
itself. The menu is kept invisible while that happens, so nothing flashes. If
a stream simply has no 1080p option, it gives up on that stream instead of
retrying forever.

`__bpkQuality.report()` in the page console shows what is pinned and how often
it had to be re-applied; `__bpkQuality.pin('720p60')` locks a different rung.

**Browse filters are remembered.** Kick keeps the browse filters in the query
string (`/browse?language=armenian&sort=viewers_high_to_low`), so a refresh
holds them — but the *Browse* link in the nav points at a bare `/browse`, so
coming back from a stream throws the whole selection away. `browse.js` stores
whatever query string the page settles on and puts it back on the way in.

Two restore paths, because there are two ways into the page. On a hard load
(refresh, pasted link, new tab) it rewrites the URL with `replaceState` at
`document_start`, before Kick's bundle boots — so the first paint is already
filtered, at no extra request. On an in-app click of a bare browse link it
cancels the SPA navigation and goes to the remembered URL instead: one
navigation, and the address bar can never claim filters the page isn't
applying. A `router.push` that never involves a link is caught by a slow poll
and costs a reload, which is why it's the last resort.

It stores the query string as-is and never parses it, so it keeps working if
Kick renames `sort` or adds a filter — nothing in there knows what "armenian"
means. The memory is keyed on the **exact path**, one entry per page. Grouping
whole sections under one key was the first version's bug and it broke the
feature twice over: sibling tabs (`/browse`, `/categories`, `/clips`)
overwrote each other's filters, and a click from one tab to another looked
like a click to the page you're already on — which is the single case restore
is suppressed for, since it means you're deliberately resetting. Filters are
also saved the moment the page loads rather than on the next poll, so picking
a filter set and immediately clicking away no longer loses it.

Clearing the filters while you're on the page is remembered
too: an empty query is only recorded when you were already there, so arriving
on a bare URL can't erase what's about to be restored. `__bpkBrowse.report()`
shows what's stored; `__bpkBrowse.forget()` wipes it.

**Drops and the daily-reward chest disappear.** The chest button in the top
bar that claims a daily reward, and the *Drops* entry in the left sidebar —
the sidebar row's wrapper goes with it, so there's no gap left in the nav.
The chest is icon-only, so its `aria-label` is the only text it has and that
label is localised: both the English and the Turkish wording ("Günlük Ödülünü
Al") are matched.

**Quick emotes go with plain-text chat.** Kick's one-click emote strip above
the chat box (`#quick-emotes-holder`) is hidden along with the emote and gif
pickers, and so is the flex column it sits alone in — that column keeps its
own bottom padding otherwise and stays behind as a thin bar.

**Pinned and hyped stuff disappears.** Pinned messages, highlighted messages,
celebrations, confetti, announcements, raids, polls and predictions.

**No animations** in the chat area.

**Purple theme.** Kick's `#53FC18` green becomes `#9147FF`.
This works two ways: a stylesheet overrides Kick's design tokens, and a runtime
pass reads computed styles and repaints anything still coming out green —
including gradients and shadows — so it holds up when Kick ships new class
names. The theme recolours accents only; it does not repaint the chat panel's
background.

The Kick wordmark is repainted too, and it needs a third mechanism: the logo
is an `<img>` pointing at `/img/kick-logo.svg`, so its green lives inside a
separate document that no stylesheet of ours can reach and the computed-style
pass can't see. The file is fetched once (same origin, straight out of the
HTTP cache), its greens are rewritten to `#9147FF`, and the result goes back
on the element as a `data:` URI. A logo drawn with `currentColor` instead of a
literal green has every shape forced purple — but only for a file whose name
actually says `kick-logo`, so a sponsor logo is never repainted wholesale. The
original `src` is kept on the element, so switching the theme off puts the
green wordmark straight back without a reload.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder
4. Open any `kick.com` page

Works in Chrome, Edge, Brave, Opera — anything Chromium with Manifest V3.

## Options

Click the extension icon. Every toggle applies live, no reload needed.

| Option | Default | |
|---|---|---|
| Force 1080p | on | Locks the player to 1080p — restored on every reload |
| Remember browse filters | on | Language, sort and the rest come back next time you open Browse |
| Smooth chat scrolling | on | Replaces Kick's auto-scroll and scrollbar with our own |
| Plain text chat | on | Hides emotes, badges, images, icons, logos |
| Strip emoji | on | Removes unicode emoji from message text |
| Drop emote-only messages | on | Hides the row when nothing but emotes/emoji was sent |
| Drop repeated messages | on | Once a line is posted 10× in 10 minutes, hides it and every later copy |
| Delete links entirely | **off** | See note below |
| Kill subs, gift subs & Kicks | on | Buttons, prompts, sub/gift events, Kicks donations |
| Hide drops & daily rewards | on | The daily-reward chest in the top bar, Drops in the sidebar |
| Hide pinned & highlights | on | Pinned, celebrations, polls, raids |
| No animations | on | Freezes chat transitions and effects |
| Purple theme | on | Repaints Kick green as `#9147FF` |
| Flat usernames | off | One colour for every name |
| Hide timestamps | off | Drops the time column |

**About links:** by default a URL stays visible as plain, unclickable,
uncoloured, unstyled text — it's still "plain text", just inert. Flip
*Delete links entirely* if you'd rather the URL not appear at all.

Toggling something **off** restores it live, except emoji: text already
stripped from a message only comes back on reload.

## How it works

`src/kick.css` does essentially all the hiding, gated on `data-bpk-*`
attributes that the content script writes to `<html>`. `src/content.js` only
does what CSS can't:

- tag chat rows and containers so the CSS has a stable hook
- strip unicode emoji out of text nodes
- add the `:` when Kick's separator was hidden
- hide sub/gift and drops controls that are only identifiable by their label
  text, and collapse the sidebar wrapper a hidden entry leaves behind
- fetch the Kick wordmark's SVG and hand it back recoloured
- count identical messages over a rolling 10-minute window and tag the
  copypasta rows once a line crosses 10 posts
- repaint green computed colours to purple

**About repeated messages:** matching is on the *whole* message, so banning
`crazy!` leaves `man that was crazy!` alone — only people parroting the exact
line get dropped. Comparison ignores case and extra spacing. Each message is
counted once no matter how often Kick re-renders its row, and a ban lasts for
the rest of the page session; reloading or switching channel clears the
tallies.

Hiding is done with CSS rather than by deleting nodes on purpose: Kick's chat
is a virtualised React list that recycles DOM nodes, and node surgery there
both fights the framework and can leave the wrong rows hidden after a recycle.
Stateless selectors survive it.

`src/quality.js`, `src/browse.js`, `src/chatfilter.js`, `src/chatscroll.js` and
`src/diag.js` are the odd ones out: all five are declared with `"world": "MAIN"`,
so they run in the *page's* JS context rather than the extension's isolated
one. That isn't a preference — an isolated-world script gets its own
`Storage.prototype`, its own `history`, and its own JS wrappers for DOM nodes,
so patching any of them there would only ever intercept our own calls, never
Kick's. That rules out all three jobs: pinning `stream_quality`, seeing the
SPA's `pushState`, and taking the chat scroller away from the virtual list.
Each reads its on/off state from an `<html data-bpk-*>` attribute, since the
two worlds share the DOM and nothing else.

What `chatscroll.js` does, in order:

- finds the chat scroller by walking out from `#chatroom-messages`
- redefines `scrollTop` / `scrollTo` / `scrollBy` / `scrollIntoView` on it:
  while chat is following the bottom, page-side scroll writes are
  *redirected* to the position we measured, not swallowed — a virtual list
  whose scroll request never happens keeps retrying and re-rendering its rows
  each time, and that fight is visible as twitching even when the final
  position is right. While you're scrolled up reading, only *downward* writes
  are dropped, so Kick can still correct the position when it trims old
  messages off the top.
- pins to the bottom itself, computed as "the scrollTop at which the last row
  that actually has client rects sits flush with the bottom edge" — a
  `display:none` row reports no rects, which is precisely the thing Kick's
  remembered heights get wrong
- applies that correction synchronously in the MutationObserver callback, so
  it lands before the frame's layout and paint. Deferring to `rAF` paints the
  collapsed row once at its old offset first, which is a one-frame jump.
- follows **instantly**, never eased. An eased catch-up spends several frames
  at positions the list considers wrong and it re-renders at each of them.
  Smoothness is for scrolling you asked for: the wheel, the thumb, and the
  jump-to-bottom.
- draws the replacement scrollbar as a `position: fixed` overlay at `<body>`
  level, tracking the scroller's rect. It's deliberately not a child of the
  chat: React owns that subtree and would reconcile a foreign node away.
  It's shown for pointer input only — flashing it on every incoming message
  is its own kind of flicker.

Browser scroll anchoring is deliberately left **on**: while you're scrolled
up, it's the thing that keeps the view still when a row above the viewport is
collapsed 220ms after painting.

`__bpkFilter.report()` shows what the socket filter is doing — how many
frames it has seen and how many it dropped. `frames: 0` means the socket
isn't being intercepted at all; a high frame count with `dropped: 0` means
Kick's event names have changed, and `__bpkFilter.spy()` logs every frame's
event name and payload so they can be corrected.

On a live channel, `__bpkScroll.report()` in the page console dumps what it
thinks is going on — which element it took over, our bottom vs the native
one (`deadSpace` is the giveaway for a stale height model), how many rows are
currently hidden, and how many corrections it's had to make.
`__bpkScroll.off()` hands the scroller back without touching settings, for
an A/B on a live chat.

`__bpkDiag()` (from `src/diag.js`) is the one to reach for first on any "it
didn't work" report: it prints the current URL, which of the page-world
scripts loaded, every `data-bpk-*` flag, the browse memory and the trail of
URLs it has seen, and a table of every element still painted brand green —
each with the property, the computed value, and whether an inline style was
ever written to it. Green with no inline style means the repaint pass never
reached that element; green *with* one means something later overrode it.
It lives in the page world because that's the console you get on kick.com —
anything `content.js` exposes is in the isolated world and can't be typed at.

Two things about the repaint pass that are easy to get wrong, both of which
were once bugs here:

- **Elements are re-checked, not checked once.** Colours aren't settled the
  first time an element is seen — React restyles, a stylesheet lands late, a
  browse card hydrates into its live state — so a one-shot check left LIVE
  pills and buttons green forever. `paintGen` records the sweep generation an
  element was last examined in; the 4s sweep bumps the counter (only when the
  tab is visible) and the budgeted queue works through everything again.
- **`::before` / `::after` need a different mechanism.** They take no inline
  style, and `getComputedStyle(el)` doesn't report them, so the repaint pass
  was blind to them — and the dot on a LIVE pill is exactly that. `repaint()`
  reads them with the pseudo argument and, when it finds green, tags the host
  with `bpk-pb-*` / `bpk-pa-*`; `kick.css` does the recolouring through those
  classes.
- **Not every green is a colour property.** The verified badge is an `<svg>`
  whose `<path>` is filled with `url(#VerifiedBadge__a)` — computed `fill` is
  that URL, never a colour, and the actual green (`#1EFF00` → `#00FF8C`) lives
  in `<stop stop-color>` inside a `<linearGradient>`. `stop-color` is now in
  `COLOR_PROPS`, and because `<stop>` sits inside a `<defs>` that the UA
  stylesheet hides, the attribute is read directly as well rather than relying
  on the engine resolving presentation attributes in an unrendered subtree.
  That is also why the green test parses hex: computed styles are always
  `rgb()`, but SVG presentation attributes never go through the cascade.

Two details worth knowing if you edit this:

- The observer does **not** watch the `style` attribute. `repaint()` writes
  inline styles, so watching them would feed our own writes back in as a loop.
- The animation rules deliberately leave `transform` alone — virtualised chat
  lists position rows with `translateY()`, and clearing it collapses the list.

## Current Kick DOM (2025+)

Kick's chat was rebuilt on Tailwind with a virtualised list, and almost nothing
carries a telling class name anymore. The extension keys on what that DOM does
expose:

- rows are `[data-index]` wrappers whose body has an inline
  `font-size: var(--chatroom-font-size)` style
- badges are `div[data-testid="identity-badge-*"]` wrappers around an `<svg>`,
  with their box size in a `size-[...]` utility class — the wrapper is hidden,
  not just the svg, or its reserved box stays behind as a gap
- the username is a classless `<button data-prevent-expand>` carrying the chat
  colour inline
- the `:` separator span is `aria-hidden="true"` (visible on screen, hidden
  from screen readers), which is why `aria-hidden` is *not* treated as
  invisible text
- the timestamp span is recognised by its inline
  `--chatroom-timestamps-display` style variable

A `data-index` change (the virtual list recycling a row into a different
message) triggers re-evaluation of that row. The plain-chat hide rules also
exist in a second, JS-free form scoped to `#chatroom-messages` and the
`--chatroom-font-size` rows, so images/badges stay hidden even if row tagging
ever misses.

## Notes on the matching

Chat-row detection is intentionally loose (several selector families, plus a
"outermost element holding at most one username" rule) so it survives Kick
renaming classes. Two consequences:

- A row is only treated as a sub/gift *event* if it has no username element, so
  a viewer typing "subscribe to my youtube" keeps their message.
- "Nothing was said" is judged on text that isn't the username, the timestamp
  or a hidden decoration. Punctuation counts as text, so `!!!`, `:)` and `w`
  are all kept — only genuinely blank rows go. If the username element isn't
  one the extension recognises, it falls back to spotting a row that renders
  as a single bare token plus a colon. The trailing colon is required, so a
  one-word system notice like "Reconnecting" is not mistaken for a stranded
  username.
- Decoration is collapsed structurally: the outermost element in a row that
  renders no text is hidden, wrapper included. Hiding only the inner `<img>`
  is what left badge-shaped gaps before. Spans holding only whitespace are
  kept, since those are real spacers between the name and the message.
- Screen-reader-only text (`sr-only`, `visually-hidden`, `aria-hidden`, svg
  `<title>`) is not counted as text anywhere. A badge is typically
  `<span><img><span class="sr-only">Moderator</span></span>`, and that
  invisible label is why badge wrappers used to survive as blank gaps and why
  badge-only rows looked like they had something to say.
- Drops are matched on the element's *whole* label, not a substring, so a
  channel or a message called "drops" is never touched — and `drop` on its own
  is deliberately not matched, since `[data-testid*="drop"]` would take every
  dropdown on the site with it. The sidebar wrapper is only collapsed while
  the hidden entry is its parent's only child, so a whole nav section can't go
  down with one item.
- The sub/gift selectors match on substrings like `gift`, so unrelated UI with
  `gift` in its class name would also be hidden. That's the tradeoff for
  catching sub UI that gets renamed; turn off *Kill subs & gift subs* if it
  ever hides something you want.
