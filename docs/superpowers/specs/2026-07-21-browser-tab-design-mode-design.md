# Server-side browser tabs + Design Mode (element picker → agent)

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan

## Problem

Orquester has no way to *see* the app an agent is building. The dev server runs on the
VPS loopback; the user's browser is on a laptop or phone talking to the daemon through
Caddy. There is no preview surface, and no way to point at a UI element and tell an agent
"fix this one".

Orca (github.com/stablyai/orca) ships this as "Design Mode": a real Chromium per
worktree, plus a "Grab" picker — click an element, and its HTML, CSS, and a cropped
screenshot land in the agent's prompt. Dissecting their source (MIT) shows a clean split
we can adopt and extend:

- **Pixels:** their remote/mobile path streams the browser via CDP `Page.startScreencast`
  (JPEG frames, per-frame ACK) with input returned as CDP `Input.dispatch*` events.
- **Picking:** *not* CDP Overlay — a plain JS string injected into the page
  (`grab-guest-script.ts`): a shadow-DOM overlay click-catcher, `elementFromPoint`
  hit-testing, and a budgeted, doubly-sanitized payload (outerHTML clamped to 4 KB, a
  verified-unique CSS selector, ~16 computed styles, bounding rects, accessibility info,
  and React `__reactFiber$`/`_debugSource` → `file:line:col`).
- **Delivery:** the payload rendered to Markdown and bracketed-pasted into the agent's
  PTY with a guarded Enter.
- **Their gap:** Grab is desktop-only (Electron-IPC-gated); it does not work over their
  own screencast path. Combining picking with remote streaming is the part we add.

An iframe cannot satisfy Orquester's requirements: the dev server is on VPS loopback, and
an iframe always renders in the *viewing* device's engine — a phone would reflow the page
as mobile, never showing true desktop rendering.

## Goals

1. A **browser tab** per project: a real Chromium running on the VPS, streamed as an
   interactive tab in the shared UI, on desktop and phone alike.
2. **Free navigation** — any URL (loopback dev servers *and* the public internet), with a
   URL bar, back/forward/reload.
3. **Server-authoritative viewport toggle**: desktop mode renders a genuine 1280×800
   desktop Chrome even when viewed from a phone (scaled, pinch-zoomable); mobile mode is
   real device emulation, toggleable from any client.
4. **Design Mode**: an element picker producing an Orca-grade payload (HTML, CSS,
   selector, React source location, cropped screenshot) delivered into a chosen agent
   session's PTY.
5. Chromium lifecycle follows tabs: no open browser tab in a project → no Chromium
   process for that project.

Non-goals (v1): binary streaming over the desktop app's Unix-socket transport (the
desktop app reaches a remote daemon over HTTP/WS, which is covered); `/proc/net/tcp`
port-to-project attribution (v2 — v1 uses PTY-output URL detection); browser sessions
surviving daemon restarts (tab records survive, the process does not); multi-user
cursors; extensions; DRM media; picker batching across *different* pages.

## Architecture overview

```
┌ laptop / phone (PWA) ─────────────────────────────┐
│  BrowserView (canvas + URL bar + toggles)         │
│  BrowserChannel  ── /ws-browser (wss, ?token=) ──┼──┐
└───────────────────────────────────────────────────┘  │
                                            Caddy 443  │
┌ VPS daemon ───────────────────────────────────────┐  │
│  /ws-browser handler ── BrowserManager            │◄─┘
│    per-project Chromium (headless, puppeteer-core │
│    launch, raw CDP): Page.startScreencast frames  │
│    out, Input.dispatch* in, Emulation for         │
│    viewport, Runtime.evaluate for the picker      │
│  browsers.json · browser.* events · registry gate │
└───────────────────────────────────────────────────┘
```

## Daemon: `BrowserManager` (`apps/daemon/src/browsers.ts`)

A sibling of the session manager, **not** an extension of `sessions.ts` — every method
there is PTY/tmux-shaped (`scrollback`, `attach`, `reattach`'s orphan reaping), and a
browser child would violate those invariants.

**Process model.** One headless Chromium **per project**, one CDP page (target) per
browser tab. Started lazily when the project's first browser tab is created (or first
subscribed after a daemon restart); killed when the project's last browser tab closes.
Idle Chromium with tabs open but no subscribers stays alive (cheap once screencast is
off) — the tab-open/closed rule, not the viewer, drives process lifetime.

**Launch.** `puppeteer-core` (new dependency, daemon only) pointed at the **host
chromium/chrome binary** — no bundled download. The binary comes from the existing
registry probe (`REGISTRY.browsers`: `chromium`, `chromium-browser`, `chrome`); the
feature is gated on that probe exactly as archive preview gates on `7z`/`bsdtar`, and
surfaced to clients via a `browser` capability flag. Flags: `--headless=new`, per-project
profile `--user-data-dir=<appdir>/daemon/browser-profiles/<project-hash>` (0700), plus
`--remote-debugging-pipe`. puppeteer-core is used for launch/lifecycle and `CDPSession`
handles; streaming, input, emulation, and picking are raw CDP commands on those sessions.

Sandbox: run sandboxed by default. If the kernel/userns config makes the sandbox
unavailable (launch fails with the known sandbox error), retry with `--no-sandbox` and
set a `sandboxed:false` flag on the browser state that the UI surfaces as a warning
badge — never silently.

**Persistence.** Tab records → `<appdir>/daemon/browsers.json` (atomic tmp+rename, like
`sessions.json`): `{id, projectPath, url, title, viewportMode, order, createdAt}`. On
boot, records load but no Chromium starts; first `sub` relaunches and re-navigates to the
recorded URL. Cookies/logins survive restarts via the profile dir.

**Events.** New `browser` channel on the existing `Broadcaster`: `browser.created`,
`browser.updated` (url/title/status/viewportMode changes), `browser.closed`. The client's
`applyEvent` gains one additive branch; no subscription plumbing needed.

**HTTP surface.** `POST /api/browsers` `{projectPath, url?}` → create tab (assigns
per-project order); `GET /api/browsers?projectPath=`; `PUT /api/browsers/:id`
(rename/reorder participation mirrors sessions); `DELETE /api/browsers/:id`. Available on
both transports (they're plain JSON); the *stream* is HTTP-transport-only in v1.

## Streaming: `GET /ws-browser`

A second multiplexed WebSocket beside `/ws`, same 6-line `?token=` auth guard, same
log-redaction. Kept separate so the terminal channel's text-only fast path is untouched
and the browser channel can use binary frames.

**Server → client:**
- **Binary frames** (pixels): `[u8 type=1][36-byte tabId (uuid ascii)][JPEG bytes]`.
- **JSON text** (state): `{t:"state", id, url, title, loading, canGoBack, canGoForward,
  viewportMode, sandboxed, status}`, `{t:"picked", id, payload}`, `{t:"end", id}`,
  `{t:"pong"}`.

**Client → server (JSON):** `{t:"sub"|"unsub", id}`; `{t:"pointer", id, kind:
"move"|"down"|"up"|"click", x, y, button, modifiers, clickCount}`; `{t:"wheel", id, x, y,
dx, dy}`; `{t:"key", id, kind:"down"|"up"|"char", key, code, text, modifiers}`;
`{t:"touch", id, kind, points}`; `{t:"nav", id, action:"goto"|"back"|"forward"|"reload",
url?}`; `{t:"viewport", id, mode:"desktop"|"mobile"}`; `{t:"pick", id, on}`;
`{t:"ping"}`. Coordinates are in the server viewport's CSS pixels — the client maps its
canvas coordinates through its own scale factor before sending.

**Screencast policy.** `Page.startScreencast({format:"jpeg", quality:60,
maxWidth/maxHeight: server viewport size})` starts on first subscriber for a tab, stops
on last unsubscribe. Every frame is ACKed (`screencastFrameAck`) so CDP self-throttles;
additionally, if the socket's `bufferedAmount` exceeds a high-water mark the daemon skips
sending (but still ACKs) — latest-frame-wins semantics, no queue. On subscribe, an
immediate `Page.captureScreenshot` primes the canvas so the tab never shows blank.
Unlike terminals there is no replay-on-reconnect: reconnect simply resumes with the next
frame.

**Client channel.** New `BrowserChannel` in `packages/ui` alongside `WsSessionChannel`,
reusing its reconnect/backoff/wake-on-visibility patterns, with an `ArrayBuffer`
`onmessage` branch. Subscription is tied to tab visibility: a hidden browser tab
unsubscribes (its last frame stays painted as a stale preview); the grid view shows that
frozen frame with a "live" badge only for the focused cell.

## Viewport model

Server-side and authoritative — identical for every viewer:

| Mode | CDP | UA |
|---|---|---|
| `desktop` (default) | `Emulation.setDeviceMetricsOverride({width:1280, height:800, deviceScaleFactor:1, mobile:false})` | desktop Chrome UA |
| `mobile` | `{width:390, height:844, deviceScaleFactor:2, mobile:true}` + `Emulation.setTouchEmulationEnabled(true)` | mobile Chrome UA |

The client canvas letterboxes and scales the stream to fit; on touch devices, pinch-zoom
and two-finger pan operate on the canvas (client-side transform — no CDP round-trip), and
single taps/drags forward as input. Desktop mode on a phone therefore shows true desktop
rendering, small but zoomable. Phone text entry uses a hidden `<input>` overlay focused
when the page focuses an editable element (signaled via the picker bootstrap's
focus-listener) — keystrokes forward as `Input.dispatchKeyEvent`/`insertText`.

`deviceScaleFactor:1` in desktop mode keeps frames at 1280×800 actual pixels — crisp
enough scaled down, and it caps bandwidth. Quality/DSF knobs live in one constants block
for later tuning; they are not user-facing settings in v1.

## UI: the browser tab

- `ProjectTab` union gains `{id, type:"browser"}`. Browser tabs are
  **server-authoritative** like sessions (they must be visible from every client and
  survive reloads), not client-local like files/git/todo. `useProjectTabs` merges them
  from the store's `browsers` array; order interleaves with sessions via the shared
  `order` field and the existing reorder flow.
- **`BrowserView`** component (sibling of `TerminalView`, same mount-once/hide pattern in
  `MainView`): canvas, URL bar (with dev-server suggestions), back/forward/reload,
  viewport toggle, picker toggle, status area (loading spinner, crashed → relaunch button,
  sandbox warning badge).
- New-tab menu gains "Browser", enabled only when the `browser` capability is present;
  otherwise greyed with an "Install chromium on the host" hint.

## Design Mode: the element picker

Orca's Grab, ported to CDP and made remote-capable.

**Arm.** Client sends `{t:"pick", on:true}`. Daemon injects the picker script via
`Runtime.evaluate` (and `Page.addScriptToEvaluateOnNewDocument` while armed, so it
survives navigation). The script — ported from Orca's `grab-guest-script.ts` design — is
a self-contained string: full-viewport shadow-DOM overlay (`z-index` max,
`cursor:crosshair`), `elementFromPoint` hit-testing on mousemove, highlight box + hover
label, click swallowed (`preventDefault`/`stopImmediatePropagation`).

**Capture.** On click the in-page script extracts, under hard budgets:
`outerHTML` (scripts stripped, ≤4 KB); a unique CSS selector (bottom-up,
`:nth-of-type`-disambiguated, verified via `querySelectorAll().length===1`); readable
element path; class list; attribute allow-list (id/class/name/type/role/href/src/alt/
title/placeholder/for/action/method/`aria-*`); ~16-property `getComputedStyle` subset;
`getBoundingClientRect` (viewport + page); accessibility role/name; nearby text; selected
text; and React metadata — walk `__reactFiber$*`, read `_debugSource` →
`{sourceFile: "file:line:col", componentNames}` when the dev build provides it. Page URL
is stored origin+path only (query/hash stripped).

The daemon then **re-validates server-side** (`clampBrowserPickPayload`): re-applies
length budgets, attribute allow-list, and secret-pattern redaction
(`access_token|api_key|authorization|cookie|csrf|password|secret|bearer`) — page output
is treated as hostile before it can reach an agent PTY. Finally the daemon captures the
crop: `Page.captureScreenshot({clip: elementRect padded 8px, format:"png"})` with the
overlay hidden (≤2 MB, omitted on overflow).

**Deliver.** Daemon emits `{t:"picked", payload}` (screenshot as base64 in the payload,
under the existing 2 MB cap). The UI opens a compose sheet: element summary, screenshot
thumbnail, free-text comment, intent (`fix|change|question`), and a **target agent
session selector** — agent-kind sessions in the same project, defaulting to the most
recently active. Multiple picks on the same page accumulate into one batch. On send, the
client reuses existing plumbing verbatim:

1. `POST /api/sessions/:agentId/upload` with the PNG (existing route; returns a daemon
   path, 0600, under the agent session's uploads dir);
2. session input (WS `{t:"input"}` or POST `/input`) with a bracketed-paste
   (`\x1b[200~…\x1b[201~`) Markdown block — Orca's `## Design Feedback` format ported:
   URL/viewport header, then per-element **Selector / Source / React / Bounds / Classes /
   Computed styles / HTML fence / Feedback**, with the screenshot's daemon path appended
   (agents like Claude Code read image paths natively — better than Orca's
   clipboard-only screenshot);
3. a trailing `\r` submits, reusing the paste-then-submit pattern from
   `session-upload.ts`.

No new daemon route is needed for delivery; the picker is the only new wire surface.

## Free navigation

The URL bar navigates anywhere: loopback dev servers, LAN, or the public internet. The
picker works on any loaded page. Known caveats (documented in the UI help, not worked
around in v1): some sites bot-detect headless Chrome (captchas, blocked Google sign-in) —
mitigated by `--headless=new` and a stock UA, and logins that succeed persist via the
project profile; Ubuntu chromium lacks proprietary codecs/DRM (YouTube generally works,
Netflix-class DRM does not); sites see the VPS's egress IP.

## Dev-server URL discovery (v1)

The daemon already streams every PTY chunk; a per-project `UrlWatcher` strips ANSI and
regexes `https?://(localhost|127\.0\.0\.1|0\.0\.0\.0):\d+` from session output, keeping
origins only (no paths/queries — avoids token leaks), most-recent-first, capped at 8 per
project. Exposed in `GET /api/browsers/suggestions?projectPath=` and shown as URL-bar
suggestions + a "Open in Browser" row in the new-tab menu. v2: Orca's `/proc/net/tcp`
listener scan with PID-cwd attribution and stale-PID eviction.

## Security

- `/ws-browser` copies `/ws`'s `?token=` constant-time auth and redaction; the Unix-socket
  transport (trusted) may attach without a token, matching existing policy.
- The Chromium runs as the `orquester` user, headless, sandboxed by default (see launch);
  it can reach loopback services by design, but only authenticated clients can drive it.
- Picker payloads are double-sanitized (in-page budgets + daemon clamp with secret
  redaction) before any agent PTY sees them.
- Profile dirs are 0700 under the appdir; they may hold cookies — they are never served
  by any API and live outside `fsRoot`, so the file browser cannot reach them.
- Screenshots ride the existing session-upload store (0600) and inherit its lifecycle.
- No CSP/Caddyfile changes: frames arrive over `wss:` (`connect-src` already allows) and
  paint into a canvas; `img-src blob:` already covers thumbnail rendering.

## Error handling

- Chromium exit/crash → `browser.updated {status:"crashed"}`; tab persists with a
  relaunch button; relaunch re-navigates to the recorded URL.
- Launch failure (missing libs, sandbox) → `status:"error"` with the launch stderr tail
  in the tab body; sandbox-only failures auto-retry with `--no-sandbox` + warning flag.
- Navigation failures render Chromium's own error page — streamed like any content.
- Stream stall: client watchdog (no frame for 10 s while subscribed and visible) sends
  re-`sub`, which forces a fresh `captureScreenshot` prime.
- Daemon shutdown: `stop()` closes Chromium processes (they are daemon children —
  documented asymmetry with tmux sessions); `browsers.json` written on every mutation, so
  tabs reappear after restart.

## Resource budget

~250–400 MB RSS per project Chromium + ~1 core during active screencast of animated
content; zero streaming cost when no client is subscribed. Screencast quality 60 JPEG at
1280×800 ≈ 0.5–2 Mbps during motion. Acceptable for 3–4 concurrent project browsers on a
4 GB VPS alongside the daemon; the lazy-launch/kill-on-last-tab-close rule keeps the
steady state at zero.

## Testing & verification

`pnpm check` clean, plus real-surface verification against a **separate checkout/staging
daemon** (never the live one, per repo rules):

1. Daemon API: create a browser tab pointed at a scratch Vite server; assert
   `browser.created` on `/events`, binary frames on `/ws-browser` after `sub`, `state`
   messages on navigation, process exit after last tab delete.
2. Input: dispatch pointer/key messages; assert page-side effects via CDP `Runtime.evaluate`.
3. Viewport: toggle modes; assert frame dimensions and UA change.
4. Picker: arm, synthesize a click via `Input.dispatchMouseEvent`, assert a `picked`
   payload with selector/outerHTML/React source on a known dev page; verify the composed
   Markdown lands in a scratch agent session's PTY (tmux capture-pane) with the
   screenshot path valid.
5. SPA: Playwright — open a browser tab, see frames paint, toggle viewport, run the
   picker flow end-to-end.
6. Mobile: manual PWA pass — desktop-mode rendering, pinch-zoom, hidden-input typing.

## Rollout

Registry-gated: hosts without chromium see the greyed menu entry only. The VPS
provisioning docs gain `chromium` (or `google-chrome-stable`) in the apt list — note
Ubuntu's `chromium` is a snap, which is problematic under systemd hardening; the runbook
should prefer Chrome's `.deb` or a non-snap chromium build, verified during
implementation on the actual VPS.
