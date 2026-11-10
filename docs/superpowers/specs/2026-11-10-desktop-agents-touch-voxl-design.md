# Desktops for agents and touch, and voxl streaming

Status: approved for build (2026-11-10). Builds on
[2026-09-30-desktop-tab-design.md](2026-09-30-desktop-tab-design.md) (the desktop tab, "the v1 spec")
and borrows the handoff model of the devices specs (2026-10-2x-devices-*).

Inspired by [tembo/voxl](https://github.com/tembo/voxl) (MIT, Rust H.264 desktop streamer) and its
native clients [voxl-pocket-ios](https://github.com/ericmigi/voxl-pocket-ios) /
[voxl-pocket-android](https://github.com/ericmigi/voxl-pocket-android) (MIT).

## 0. Summary

| Phase | Goal | Depends on |
|---|---|---|
| 1 | Agents can **see** (screenshot), **use** (pointer, keys, text, clipboard) and **wait on** (idle / change) any desktop, local or in a VM | — |
| 2 | A clear **handoff** between an agent and the user on a desktop: who controls it, what the agent did, take over / give back | 1 |
| 3 | **Touch-first** viewing on phones and tablets: trackpad mode, local zoom, a real key bar | — (UI only) |
| 4 | **voxl** as an optional per-desktop H.264 video backend, with automatic fallback to RFB/noVNC | 3's stream seam |

Non-goals (future work, §9): an accessibility tree (AT-SPI refs) for desktops, screen recording,
microphone into desktops, file transfer through the desktop view, macOS/Windows box desktops.

## 1. Terms

- **Desktop**, **app**, **window**, **tracker**: as in the v1 spec.
- **Display size**: the X screen's current size in pixels (`DesktopSummary.size`).
- **Automation**: the daemon's per-desktop X11 client that captures, injects input and tracks damage
  (§2). It is separate from the window tracker's connection.
- **Actor**: who issued an automation action: `{ kind: "chat", threadId, label }` for an agent chat, or
  `{ kind: "external", label }` for an external MCP client. `label` is a short display name ("Claude",
  "Codex", "MCP client").
- **Control**: who currently controls a desktop's input: an agent, the user, or nobody (§3).
- **Screen sequence (`seq`)**: a per-desktop counter the automation increments on every X Damage
  notification; a screenshot and every wait report the `seq` they observed.
- **Stream client**: the browser-side adapter that renders one desktop and sends its input (§4.1);
  `rfb` (noVNC) and `voxl` (§5) implement it.

## 2. Phase 1 — agent eyes and hands

### 2.1 Requirements

R1.1 An agent (chat or external MCP client) can take a screenshot of any running desktop it can see
through `get_desktops`, local or in a VM, and gets an image plus the facts needed to act on it: image
size, display size, the scale between them, a `screenshot_id`, the `seq`, and the pointer position.

R1.2 An agent can move the pointer, click (left/right/middle, single/double/triple, with modifiers),
press and release a button, drag, scroll (vertical and horizontal), press key combinations, type
arbitrary Unicode text, and set and read the clipboard (text).

R1.3 Coordinates are in **the screenshot's pixel space** when the action names a `screenshot_id`
(the daemon maps them through that screenshot's scale and origin), else in display pixels. An action
naming a `screenshot_id` whose display size no longer matches fails `DESKTOP_RESIZED` (the agent must
take a new screenshot). Coordinates outside the display fail `INVALID_ARGUMENT`.

R1.4 An agent can wait, without polling, until the screen (or a region) has been still for N ms, or
until it changes after a given `seq`, with a timeout. It returns `{ changed, timed_out, seq, waited_ms }`.

R1.5 Any input action may ask for `screenshot: true`: after the input the daemon waits until the
screen is idle for 300 ms (at most 3 s) and returns a screenshot with the result.

R1.6 `get_desktops` reports each window's on-screen bounds, so an agent can target or crop a window.
A screenshot may be cropped to a region or to a window.

R1.7 Nothing new is spawned: no xdotool, no ffmpeg, no new packages. Everything is done by the
daemon's own X11 client, over the same transport the tracker uses (the X socket locally, the box
`unix` channel for a VM).

R1.8 Results fit the MCP image cap (4 MiB base64): PNG when it fits, else the device pipeline's JPEG
re-encode and halving (`devices/screenshot-image.ts`, run in the image workers, never on the event
loop). The default image is downscaled so its long edge is ≤ 1920 px; `max_size` (320–3840) changes
that bound.

R1.9 Input is refused while the user controls the desktop (§3), and every action is logged (§3.3).

R1.10 Everything goes through `DaemonApi` / HTTP routes (D-1); no MCP code reaches into services.

### 2.2 X11 protocol additions (`apps/daemon/src/desktops/x11/`)

The existing hand-written client (`connection.ts`, `protocol.ts`, `xres.ts`) gains encoders/decoders
for, all byte-order-aware and unit-tested against hand-built byte fixtures:

- Core: `GetImage` (ZPixmap, root window, a rectangle; depth 24/32, 32 bpp — anything else fails
  `DESKTOP_UNSUPPORTED_VISUAL`), `QueryPointer`, `GetKeyboardMapping`, `ChangeKeyboardMapping`,
  `GetModifierMapping`, `TranslateCoordinates`, `GetGeometry` (exists), `SetSelectionOwner`,
  `GetSelectionOwner`, `ConvertSelection`, `SendEvent` (SelectionNotify), `ChangeProperty`,
  `DeleteProperty`, `CreateWindow` (an unmapped 1×1 InputOnly helper window for selections),
  `GetInputFocus` (exists, used as a sync barrier).
- `XTEST` extension (`QueryExtension "XTEST"`, `GetVersion`, `FakeInput` for KeyPress/KeyRelease/
  ButtonPress/ButtonRelease/MotionNotify).
- `DAMAGE` extension (`QueryVersion` 1.1, `Create` on the root with level `RawRectangles`,
  `Destroy`, `DamageNotify` event decoding) and `XFIXES` `QueryVersion` (DAMAGE requires it).
- Large replies: `GetImage` replies can be tens of MB; the reply reader must not copy per chunk
  (gather chunks, one concat), and a capture of the whole screen is done in horizontal bands of at
  most 4 MiB per request so a single reply stays bounded and the box link's credit keeps flowing.

### 2.3 Automation engine (`apps/daemon/src/desktops/automation/`)

One `DesktopAutomation` per running desktop, created lazily on the first automation call and closed
after 5 minutes without calls, when the desktop stops, or when its X connection drops (the next call
reopens it). It opens its **own** X11 connection with the desktop's Xauthority (locally the
`/tmp/.X11-unix/X<n>` socket; in a VM through `BoxDesktopHost`'s unix channel, exactly as the tracker
connects).

- **Capture**: `screenshot({ region? }) → { width, height, data: BGRX→RGB buffer, seq, cursor }`.
  Pixel conversion uses the server's byte order and the visual's masks (handle both
  LSBFirst/MSBFirst). Encoding to PNG/JPEG and scaling run in the image workers (`image-pool.ts`):
  add a "raw RGB → fitted PNG/JPEG with max long edge" job next to the device one.
- **Damage**: a `DamageCreate(root, RawRectangles)`; each `DamageNotify` increments `seq` and marks
  16×16 blocks with the time of last change (a `Float64Array` of `ceil(w/16)·ceil(h/16)`, rebuilt on
  resize). After each batch of notifications it sends `DamageSubtract(damage, None, None)`. A resize
  (root ConfigureNotify or RandR) resets the grid and increments `seq`.
- **Wait**: `wait({ for: "idle" | "change", idleMs, region?, since?, timeoutMs, signal })`.
  - `idle`: resolves when no block in the region changed for `idleMs` (default 500, 100–10 000).
  - `change`: resolves when a block in the region changed after `since` (default: the `seq` at call
    time).
  - Both are driven by damage events plus one timer for the idle deadline; **no polling**. Timeout
    default 10 s, max 60 s; returns `timed_out: true` instead of failing. Aborted by the request's
    signal.
- **Input**: XTEST FakeInput only.
  - Pointer: `move(x, y)` (absolute, root), `button(b, down)` (1 left, 2 middle, 3 right, 4/5 wheel
    up/down, 6/7 wheel left/right), clicks with `count` 1–3 at 60 ms apart, `drag(from, to, button)`
    in ≥ 10 interpolated motion steps over ~200 ms, scroll as N wheel clicks (`amount` 1–50,
    default 3).
  - Keys: keysym → keycode through the keyboard mapping (cached; invalidated on `MappingNotify`). A
    keysym with no keycode is bound to a spare keycode (one with no keysyms) with
    `ChangeKeyboardMapping`, used, and **restored** after the action (keep a small LRU of 8 temporary
    bindings, restored when the automation closes). If it is only reachable at the shifted level,
    Shift is held around it. Unicode characters map to keysyms as `0x01000000 + codepoint` unless they
    have a Latin-1 keysym (codepoints 0x20–0x7e and 0xa0–0xff map to themselves).
  - `type(text)` (≤ 4000 chars): `\n` → Return, `\t` → Tab, other control characters refused; a
    `GetInputFocus` sync barrier every 50 events so the server never queues unboundedly.
  - `key(combo)`: `"ctrl+shift+t"`, `"Return"`, `"super"`, `"alt+F4"`; names are case-insensitive,
    `+`-separated; modifiers `ctrl|control`, `shift`, `alt|option`, `super|cmd|meta|win`; named keys
    include `enter|return`, `esc|escape`, `tab`, `space`, `backspace`, `delete|del`, `insert`,
    `home`, `end`, `pageup|page_up`, `pagedown|page_down`, `up`, `down`, `left`, `right`, `f1`–`f24`,
    `menu`, `print`, `capslock`, plus any X keysym name in the table and any single character.
    `repeat` 1–20. Modifiers are pressed in order and released in reverse.
  - Every input call ends with a sync barrier and releases anything it pressed even when it fails
    halfway (try/finally); on close the automation releases all buttons/keys it holds.
- **Clipboard** (CLIPBOARD selection, `UTF8_STRING`, fallback `STRING`):
  - `setClipboard(text)` (≤ 1 MiB): own the selection with the helper window and answer
    `SelectionRequest`s (`TARGETS`, `UTF8_STRING`, `STRING`, `TEXT`) until another client takes
    ownership (`SelectionClear`) or the automation closes. No INCR.
  - `getClipboard()`: `ConvertSelection` into a property on the helper window, wait (≤ 2 s) for
    `SelectionNotify`, read it with `GetProperty`; INCR transfers are refused with a clear message;
    at most 1 MiB.
- **Window bounds**: the tracker adds `bounds: { x, y, width, height }` (root coordinates, from
  `GetGeometry` + `TranslateCoordinates` of the frame/client window) to each `DesktopWindow`, refreshed
  on ConfigureNotify of the windows it already watches.

### 2.4 Daemon routes (`apps/daemon/src/desktops/http-routes.ts`)

All under the existing auth. Bodies/responses are the contracts in `packages/api/src/desktops.ts`.

- `POST desktopRoutes.actions(id)` — body `DesktopActionRequest` → `DesktopActionResponse`. Runs one
  action. `409 DESKTOP_CONTROLLED_BY_USER` for an input action while the user controls the desktop;
  `409 DESKTOP_RESIZED`; `409 DESKTOP_NOT_RUNNING`; `400 INVALID_ARGUMENT`; `504` never (waits return
  `timed_out`).
- `GET desktopRoutes.screenshot(id, screenshotId)` — the stored image bytes (for chat thumbnails).
  Screenshots are kept per desktop under `<appdir>/daemon/desktops/<id>/screenshots/` (0700 dir, 0600
  files), at most 50 per desktop (oldest deleted), removed with the desktop. Use a `packages/config`
  path helper.
- `GET desktopRoutes.actionLog(id)` → `DesktopActionLogResponse` (§3.3).
- `PUT desktopRoutes.control(id)` — body `DesktopControlRequest` → `DesktopSummary` (§3).

### 2.5 MCP (`apps/daemon/src/mcp/tools/desktops.ts`)

A new tool **`desktop_action`** (audiences chat and external, toolset `desktops`), and `get_desktops`
now includes window bounds and `control`.

- Params: `desktopId` (required), `action` (`screenshot | wait | move | click | mouse_down | mouse_up
  | drag | scroll | key | type | clipboard_get | clipboard_set`), and per action: `x, y`,
  `screenshot_id`, `button`, `count`, `modifiers[]`, `to_x, to_y`, `direction` (up/down/left/right),
  `amount`, `keys`, `repeat`, `text`, `region {x,y,width,height}`, `window_id`, `max_size`,
  `for` (idle/change), `idle_ms`, `since`, `timeout_ms`, `screenshot` (bool). Unknown fields for an
  action are refused (as `control_desktop` does).
- Tier: `read` for `screenshot`, `wait`, `clipboard_get`; `act` for the rest. No approval card.
- Result: JSON `{ desktopId, action, summary, seq, display: {width, height}, ... }`, and for an image
  an MCP image block with `screenshot: { screenshot_id, width, height, scale, origin, mime_type }` and
  `cursor`. A `desktopRef` (`{ desktopId, projectPath, screenshotId?, action, summary }`) is kept
  through result slimming so the chat row can render after reload (as `deviceRef`).
- The description teaches the loop: *screenshot → act with `screenshot_id` → `wait` (or
  `screenshot: true`) → screenshot*, and that input fails `DESKTOP_CONTROLLED_BY_USER` while the user
  has control (wait or ask).

### 2.6 Tests (Phase 1)

- Protocol encoders/decoders: byte fixtures for each new request/reply/event, both byte orders.
- Automation against a **fake X server** speaking the subset (as `connection.test.ts` does): keysym
  mapping with a temporary binding restored, shift-level handling, release-on-failure, damage-driven
  idle/change waits with `mock.timers`, selection ownership answering a `SelectionRequest`.
- Integration (skipped when `Xvnc` is missing, like `windows.integration.test.ts`): a real Xvnc;
  screenshot of a known pattern, type into an `xterm`-free target (a tiny X client written in the
  test that records key events), clipboard round-trip, wait for change after drawing.
- Routes: argument validation, `DESKTOP_RESIZED`, `DESKTOP_CONTROLLED_BY_USER`, screenshot storage
  cap.
- MCP: per-action field validation, tier, image result shape, `desktopRef`.

## 3. Phase 2 — agent ↔ user handoff

### 3.1 Requirements

R2.1 Every desktop has a **control** state, runtime only (not persisted; resets to none on daemon
restart): `null` (nobody claimed it) or `{ controller: "agent" | "user", actor?: DesktopActor, since }`.
It is part of `DesktopSummary` and changes go out as `desktop.updated`.

R2.2 Rules (pure functions in `desktops/control.ts`, unit-tested):
- An agent input action when control is `null` or `agent` sets `agent` (with that actor).
- An agent input action when control is `user` fails `DESKTOP_CONTROLLED_BY_USER`. Reads always work.
- The user takes control explicitly (`PUT control {controller:"user"}`, "Take over") or implicitly:
  the UI calls it on the user's first pointer/key input in the viewer **while an agent controls it**.
- "Give back" (`PUT control {controller:"agent"}`) returns control to the last agent actor; if there
  is none, it clears control. `PUT control {controller:null}` clears it.
- Plain user input when control is `null` changes nothing (a desktop used without agents never shows
  handoff UI).
- Agent control lapses to `null` 2 minutes after the agent's last action (a timer, no polling), so a
  finished agent leaves no stale pill.

R2.3 While an agent controls a desktop, viewers must not change the display size: the UI suspends
Fit-mode resizing and text-size presets, and shows "Size locked while <label> works".

R2.4 The user sees, in the desktop tab:
- A **control pill** in the toolbar: "<label> is controlling · Take over" / "You have control · Give
  back". Hidden when control is `null`.
- An **agent overlay** (pointer-events: none) drawing each agent action at its display position,
  scaled to the view: click ripples (right-click a different colour, count shown), drag trails, scroll
  chevrons, typed-text bubbles (truncated to 60 chars), key chips ("Ctrl+Shift+T"). Each fades in
  ~1.2 s. Honors `prefers-reduced-motion` (static markers, no animation).
- An **action log** popover (toolbar "Activity" button with a count badge since last opened): the last
  50 actions, newest first, with time, actor and summary; screenshot rows show a thumbnail.
- After an implicit takeover, a toast "You took control from <label>" with a **Give back** action.

R2.5 Following the agent: when an agent in the chat the user is looking at starts acting on a desktop
whose tab is not active, show a non-blocking chip in the chat's composer area — "<label> is using
<desktop title> · Show" — that switches to the desktop tab. It never switches tabs by itself. It
disappears when control lapses.

R2.6 Chat timeline rows for `desktop_action` show the summary ("Clicked at 412, 300", "Typed “hello”",
"Pressed Ctrl+S", "Took a screenshot"), the screenshot thumbnail when there is one (from
`desktopRoutes.screenshot`), and a "Show desktop" link opening the tab. `get_desktops` /
`control_desktop` rows link to the desktop too.

### 3.2 Events

`desktop.action` on the `desktop` channel: `DesktopActionEventPayload` (`{ desktopId, entry }`), sent
for every action (reads included). `desktop.updated` carries `control` changes.

### 3.3 Action log

Per desktop in memory, last 50 `DesktopActionEntry` (`id`, `at`, `actor`, `kind`, `summary`,
`point?`, `to?`, `button?`, `count?`, `text?` (≤ 60 chars, never clipboard contents), `keys?`,
`screenshotId?`, `ok`, `error?`). Dropped when the desktop closes.

### 3.4 Tests (Phase 2)

- `control.ts` rules and the lapse timer (`mock.timers`).
- Route: takeover → agent input refused → give back → agent input works.
- UI logic (`*.logic.ts`): pill state, overlay geometry mapping (display → view with scale/offset and
  local zoom), follow-chip visibility, log badge counting.

## 4. Phase 3 — touch-first viewing

### 4.1 Stream seam (`packages/ui/src/components/desktop/stream/`)

`DesktopView` stops talking to noVNC directly. `types.ts` defines `DesktopStreamClient` (see the
file); `rfb-client.ts` wraps noVNC behind it (keeping today's behaviour: RTT-driven quality, resize
trick, paste chord, clipboard events). Phase 3 input and Phase 4 voxl both build on it. When touch
input is enabled, noVNC's own gesture handling is bypassed: pointer events are captured on the view's
wrapper (capture phase) and translated by the gesture layer into `DesktopInputSink` calls.

### 4.2 Requirements

R3.1 **Input modes** on touch devices (`(pointer: coarse)` or any touch input seen): **Trackpad**
(default) and **Touch**, toggled in the View menu, persisted in `desktop-prefs` (validated on read).

| Gesture | Trackpad | Touch |
|---|---|---|
| 1-finger tap | Left click at the cursor | Move to the finger, left click |
| 2-finger tap | Right click at the cursor | Right click at the finger |
| 3-finger tap | Middle click | Middle click |
| Long press (400 ms) | Left button down, drag moves, release lets go (drag lock) | Right click (haptic where supported) |
| 1-finger drag | Relative move, delta × 1.5 × display-px-per-css-px | Left drag from the touch point |
| 2-finger drag | Scroll, natural direction, in display pixels (wheel steps) | Same |
| Pinch (> 15 % change) | Local zoom 1–5× around the midpoint; two-finger pan while zoomed; snaps to 1× below 1.05× | Same |
| Double-tap (1 finger) | Double click | Double click |

Tap = < 350 ms and within 10 css px. Sticky modifiers (R3.3) apply to taps and clicks (Shift-tap =
Shift-click).

R3.2 **Local cursor** in Trackpad mode: an arrow drawn above the video at the pointer position
(hotspot at the tip), so the finger never hides the target. While zoomed, the view follows the
cursor, keeping it 40 css px inside the visible edges and above the soft keyboard.

R3.3 **Key bar** (shown while the soft keyboard is up on touch devices, and togglable): `Esc Tab |
Shift Ctrl Alt Super | ← ↑ ↓ → | Home End PgUp PgDn | Fn ▸ (F1–F12) | Alt+Tab Ctrl+Alt+Del | Paste |
Hide`. Modifiers latch like the terminal's: one tap = armed for the next key or click, double-tap =
locked until tapped again; visible off/armed/locked states. Reuse the terminal key-bar styling
(`MobileKeyBar`) and generalise the latch state machine in `lib/terminal-keys.ts` (shared, not
copied). Buttons act on `pointerdown` with `preventDefault` so the keyboard stays up. Paste reads
`navigator.clipboard.readText()` on the button's gesture and sends it as the desktop's clipboard
plus the paste chord.

R3.4 **Soft keyboard placement**: the viewer sizes itself to `visualViewport` so the keyboard never
covers the desktop (`hooks/use-soft-keyboard-open.ts`); text input keeps working through
`beforeinput`/composition (Android `keyCode 229`).

R3.5 **Text size presets** on touch devices (View menu): Fit (current behaviour), Large (css px × 1),
Medium (css px × (1 + dpr) / 2), More space (css px × dpr), rounded to even numbers and clamped to the
desktop size limits, debounced 250 ms, only while this viewer drives the size and no agent controls
the desktop (R2.3).

R3.6 **Sharp fit**: when the desktop fits the view at ≤ 1.25× stretch, show it 1:1 (device pixels),
corner snapped to device pixels.

R3.7 iOS/Android browser pitfalls handled: `touch-action: none`, `-webkit-touch-callout: none`,
`user-select: none`, `contextmenu` suppressed in the view, `gesturestart`/`gesturechange`
`preventDefault`, keys released on `visibilitychange`/`pagehide`/blur, `e.repeat` ignored for
hardware keys (the host repeats).

R3.8 Desktop (mouse) users see no change except the moved code; all of this is off for fine pointers.

### 4.3 Tests (Phase 3)

Pure gesture recogniser (`desktop-gestures.logic.ts`) fed synthetic pointer sequences → expected sink
calls (tap/two-finger tap/long press drag lock/scroll/pinch thresholds); latch state machine shared
with the terminal; size-preset maths; zoom/follow-cursor maths.

## 5. Phase 4 — voxl as an optional video backend

### 5.1 Requirements

R4.1 A desktop can stream through **voxl** (H.264 + WebCodecs) instead of RFB/noVNC. The choice is per
desktop (`video: "rfb" | "voxl"`, persisted, tolerant: unknown/absent = `rfb`), default `voxl` for new
desktops when the host (or the VM) has a working voxl **and** the viewer supports it; settable in the
create dialog's advanced options and from the desktop's View menu ("Video: Fast (H.264) / Compatible
(VNC)"), which restarts only the stream, not the desktop or its apps.

R4.2 Xvnc stays the X server (the tracker needs XRes; RFB stays available as the fallback at any
time). voxl attaches to the same display. Both can stream at once (one viewer on each is allowed).

R4.3 voxl listens on **127.0.0.1 only**, on a port the daemon allocates, with basic auth on and a
random per-desktop password stored as a 0600 file in the desktop directory and passed to voxl through
the environment (`VOXL_PASSWORD`), never argv, never an API response, never a log line. File transfer
off (`--file-transfers none`), audio off in voxl (Orquester's own audio pipeline stays the single
audio path), clipboard both ways, `--enable-resize` on.

R4.4 The browser never talks to voxl and never sees its password. The daemon serves
`desktopRoutes.voxlSocket(id)` (`/ws-desktop-voxl/<id>`, Orquester `?token=` auth like the other desktop
sockets), dials voxl's `/ws` itself as a WebSocket client with `Authorization: Bearer <pw>`, `Host:
127.0.0.1:<port>`, no `Origin`, permessage-deflate off, and relays frames 1:1 preserving text/binary
type and boundaries, with the same high-water-mark backpressure as the RFB relay. For a VM desktop
the upstream TCP connection goes through the box link's `tcp` channel.

R4.5 The UI renders voxl desktops with a `voxl-client.ts` `DesktopStreamClient` ported from voxl's
web client (MIT notice kept in the file header and in the licence notices): one `VideoDecoder` per
stripe in a worker, acks, keyframe requests, ping replies, cursor bitmap, clipboard both ways (remote
clipboard is offered in the Clipboard popover; it is written to the local clipboard only on a user
gesture), resize via `sz`. It mounts inside the existing view (no iframe), sized by a
`ResizeObserver` on its container, and tears down completely (`dispose()` terminates the worker,
closes sockets, removes listeners). The Phase 3 gesture layer and key bar drive it through the same
`DesktopInputSink`.

R4.6 Fallback: if the viewer lacks WebCodecs H.264 (probe with `VideoDecoder.isConfigSupported`), is
not a secure context, voxl is not installed / fails to start / its socket fails 3 times in a row, the
view uses RFB and shows a one-line notice in the Info dialog (never a blocking error).

R4.7 Host status reports voxl as an optional tool (`DesktopHostStatus.voxl`: available, version, path
or reason). The daemon looks for `voxl` at `ORQUESTER_VOXL_BIN`, then `<appdir>/bin/voxl`, then PATH.

R4.8 Packaging: `deploy/install-voxl.sh` (run as root by provision and every deploy, like
`install-go.sh`) installs voxl's runtime libraries with apt and a **pinned** voxl version built from
the crate (build dependencies installed and the build done once per version, output cached at
`/opt/orquester-tools/voxl/<version>/voxl`, symlinked to `/usr/local/bin/voxl`); a failure only
warns (`voxl=FAILED…` in the deploy summary) and desktops fall back to RFB. For a VM desktop the
daemon copies the host's voxl binary into the VM through the content-hashed desktop-assets mechanism
and installs the runtime libraries with the box GUI installer; when it does not run there (probe:
`voxl --version`), that VM's desktops use RFB.

R4.9 voxl process lifecycle: started by `desktop-host.sh` after Xvnc is ready when the desktop's
`video` is `voxl` and a voxl binary is given; it runs in the same process group (torn down with the
desktop). Readiness is the daemon dialing `/healthz` once voxl's log prints its listen line (watched
with `fs.watch` on its log file, no polling loop); if voxl exits, the host script does **not** take
the desktop down — the daemon marks the stream unavailable and viewers fall back to RFB.

R4.10 Agent tools are backend-independent: Phase 1 automation is used for both `rfb` and `voxl`
desktops.

### 5.2 Tests (Phase 4)

- Daemon: voxl argument/env building (no password in argv), relay frame type/boundary preservation
  and backpressure with a fake upstream WS, auth (no token → 1008), fallback when voxl is absent, port
  allocation, host-status probe.
- UI: voxl protocol parser/serialiser (video header, cursor, hello, ping/ack) with byte fixtures,
  stripe reassembly ordering, capability probe → backend choice.
- Integration (skipped when voxl/Xvnc are absent): start a desktop with `video: voxl`, connect through
  the relay, receive `hello` and a keyframe.

## 6. Contracts (`packages/api/src/desktops.ts`)

Added (see the file for exact types): `DesktopActor`, `DesktopControl`, `DesktopControlRequest`,
`DesktopActionKind` + `DESKTOP_ACTION_KINDS` + `DESKTOP_READ_ONLY_ACTIONS`, `DesktopActionRequest`,
`DesktopActionResponse`, `DesktopScreenshotInfo`, `DesktopActionEntry`, `DesktopActionLogResponse`,
`DesktopActionEventPayload`, `DesktopVideoBackend`, `DesktopVoxlStatus`, `DesktopWindow.bounds`,
`DesktopSummary.control` / `.video` / `.voxl`, routes `actions`, `screenshot`, `actionLog`, `control`,
`voxlSocket`, the `/ws-desktop-voxl/` prefix, the `desktop.action` event type, error codes, and limits.

## 7. Security

- Automation runs only on desktops the caller can already reach; it has no file access.
- Clipboard contents are never logged and never kept in the action log.
- voxl: loopback only, per-desktop password, host-only secret, browser never sees it (R4.3–R4.4); its
  `Host`/`Origin` checks pass because the daemon sends a loopback Host and no Origin.
- The screenshot route serves only files named by the store's own ids (no path input).

## 8. Build order

Contracts and this spec first (one commit), then in parallel worktrees: (A) X11 + automation engine,
(B) routes, control, action log, MCP tool, (C) handoff UI, (D) stream seam + touch UI, (E) voxl daemon
+ deploy, (F) voxl stream client. Integration merges A→B→E, then D→F→C.

## 9. Future work (recorded, not built)

AT-SPI accessibility snapshots with element refs; screen recording (voxl `/record` or ffmpeg
`x11grab`); microphone into the desktop (voxl mic → PulseAudio pipe source); file drag-and-drop into
the desktop via the daemon's file routes; macOS/Windows VM desktops through voxl's native capture;
Electron-over-Unix-socket desktop tabs through the device relay.
