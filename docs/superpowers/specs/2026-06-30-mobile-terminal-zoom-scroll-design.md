# Mobile terminal zoom + drag-to-scroll — design

**Date:** 2026-06-30
**Status:** approved, pending implementation plan
**Related:** `2026-06-24-mobile-agent-file-attach-design.md` (the `MobileKeyBar` this extends)

## Summary

Two mobile-only fixes for the xterm terminal, both confined to the client UI:

1. **"Zoomed in" text.** `TerminalView` hardcodes `fontSize: 13` for every device
   (`TerminalView.tsx:105`). On a ~390 px-wide phone that is only ~45 columns, so output meant
   for 80 columns wraps hard and reads as blown-up. This adds a **device-appropriate default**
   (mobile 11 px, desktop unchanged at 13 px) plus **`A−` / `A+` zoom buttons in the mobile
   control-key bar** (`MobileKeyBar`) that adjust the size live and **persist it per device**.

2. **Can't drag-to-scroll.** xterm v6's scrollable layer (`.xterm-viewport`) sits *underneath*
   the `.xterm-screen` that receives touches, and xterm's built-in touch→mouse shim turns a
   one-finger drag into a text-selection / mouse-report event — so a drag never scrolls. This
   adds an explicit **one-finger touch drag-to-scroll** handler on the terminal host.

No daemon changes. Desktop behavior is unchanged (no buttons; stays 13 px).

## Background

- **Terminal.** `packages/ui/src/components/terminal/TerminalView.tsx` creates one xterm
  `Terminal` per session inside a `useEffect` keyed on `[api, session.id]` (line 415). The
  terminal options — including `fontSize: 13` (line 105) and `lineHeight: 1.2` — are set at
  creation. A `FitAddon` (`fit`) is created locally in that effect; `applyFit()` (line ~152)
  calls `fit.fit()` then `api.resizeSession(session.id, term.cols, term.rows)`. A
  `ResizeObserver` re-runs `applyFit` on container resize. The xterm host is the inner div
  (`TerminalView.tsx:443`): `<div ref={containerRef} className="h-full w-full overflow-hidden
  bg-[#0a0a0a] p-2" />`. `fontSize` is the **only** font-size in the whole UI codebase — there is
  no responsive handling today.

- **Mobile signal.** `useIsDesktop()` (`packages/ui/src/hooks/use-media-query.ts`) is
  `useMediaQuery("(min-width: 768px)")`. Mobile = `!useIsDesktop()`.

- **Control-key bar.** `packages/ui/src/components/terminal/MobileKeyBar.tsx` is a mobile-only
  (`useIsDesktop()` false), session-only toolbar. Its control keys use `onPointerDown` +
  `e.preventDefault()` so they send bytes **without stealing focus** (the soft keyboard stays
  up). It already renders a thin status line above a horizontally-scrolling button row
  (`overflow-x-auto`), and reads the active session/tab from the zustand store.

- **Client-local persistence pattern.** `packages/ui/src/lib/view-mode.ts` is the house pattern
  for a small persisted client preference: a `STORAGE_KEY`, a `load*()` that returns a safe
  default on **any** failure (including `typeof localStorage === "undefined"`), and a `save*()`
  that swallows quota/availability errors. It is wired into `store/app.ts` as state initialized
  from `load*()` (line 587), a setter that updates + persists (`setViewMode`, line 1290), and a
  selector hook (`useViewMode`, line 1762). This spec mirrors that pattern exactly.

- **Why drag doesn't scroll (xterm internals).** `.xterm-viewport` has `overflow-y: scroll` and
  is `position: absolute` filling `.xterm`; `.xterm-screen` is a later sibling painted on top, so
  touches land on the screen, not the scrollable viewport. xterm v6 also installs a touch→mouse
  dispatcher on `document` (bubble phase, `passive: false`) that converts a touch-drag into a
  synthetic mouse drag — i.e. text selection (shell) or a mouse-report drag (agent). Neither path
  scrolls. Because that shim listens in the **bubble** phase on `document`, a handler on the host
  container can `stopPropagation()` a move before it reaches the shim.

## Goals

- Mobile terminals open smaller (more columns; less "zoomed in"), without changing desktop.
- `A−` / `A+` buttons in `MobileKeyBar` adjust the terminal font size live and persist it.
- One-finger drag on a mobile terminal scrolls its scrollback, in the natural direction.
- Purely client-side; no daemon, wire-protocol, or desktop-behavior changes.

## Non-goals

- No pinch-to-zoom gesture (zoom buttons were chosen over it).
- No per-session font sizes — one global terminal font size (see Decisions).
- No desktop zoom UI (desktop stays at the 13 px default; the buttons are mobile-only).
- No change to scrollback depth, the resize/SIGWINCH "repaint nudge", or selection/copy behavior.
- No attempt to scroll a full-screen agent TUI's alt-screen (it has no scrollback — see Decisions).

## Design

### 1. New shared module: `packages/ui/src/lib/terminal-font.ts`

Mirrors `view-mode.ts`. Exports:

```ts
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_FONT_STEP = 1;
const DESKTOP_DEFAULT = 13;
const MOBILE_DEFAULT = 11;

export function clampTerminalFontSize(n: number): number; // round + clamp to [MIN, MAX]
export function defaultTerminalFontSize(): number;         // device-appropriate (see below)
export function loadTerminalFontSize(): number;            // stored (clamped) or default
export function saveTerminalFontSize(size: number): void;  // best-effort, errors swallowed
```

- `STORAGE_KEY = "orquester:terminal-font-size"`.
- `defaultTerminalFontSize()`: `DESKTOP_DEFAULT` when `window`/`matchMedia` is unavailable
  (SSR-safe), else `window.matchMedia("(min-width: 768px)").matches ? DESKTOP_DEFAULT :
  MOBILE_DEFAULT`. localStorage is per-device, so a phone and a laptop keep independent sizes;
  the only overlap is one browser resized across 768 px (acceptable — a single per-device
  preference).
- `loadTerminalFontSize()`: returns `clampTerminalFontSize(parsed)` when a finite number is
  stored, else `defaultTerminalFontSize()`; returns the default on any throw or when
  `localStorage` is undefined.
- `saveTerminalFontSize(size)`: `localStorage.setItem(STORAGE_KEY, String(size))` in a try/catch;
  no-op when `localStorage` is undefined.

The persisted value is a single number (absolute px), not a scale factor — that is exactly what
xterm's `fontSize` option wants, with no conversion.

### 2. Store wiring in `packages/ui/src/store/app.ts`

Mirrors `viewModeByProject` / `setViewMode` / `useViewMode`:

- Import `{ loadTerminalFontSize, saveTerminalFontSize, clampTerminalFontSize, TERMINAL_FONT_STEP }`.
- State field `terminalFontSize: number`, initialized to `loadTerminalFontSize()`.
- Action `setTerminalFontSize(size: number)` — absolute set, using the `set((…) => …)` updater
  form `setViewMode` uses (clamp + persist + return):
  ```ts
  setTerminalFontSize: (size) =>
    set(() => {
      const next = clampTerminalFontSize(size);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),
  ```
- Action `nudgeTerminalFontSize(delta: number)` — same updater form, but reads the current value
  off `state` (no `get()`), so the buttons never need MIN/MAX:
  ```ts
  nudgeTerminalFontSize: (delta) =>
    set((state) => {
      const next = clampTerminalFontSize(state.terminalFontSize + delta);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),
  ```
  Buttons call it with `±TERMINAL_FONT_STEP`.
- Selector hook `useTerminalFontSize(): number` → `useAppStore((s) => s.terminalFontSize)`.

One global size for all terminals (every `TerminalView` reads the same value).

### 3. `TerminalView.tsx` — apply the size, and react to changes

The creation effect must **not** depend on font size (re-running it tears down the session
stream and scrollback). So:

- `const fontSize = useTerminalFontSize();`
- Read the **initial** size via a ref so the creation effect stays keyed on `[api, session.id]`:
  ```ts
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  ```
  In `new Terminal({ … })`, use `fontSize: fontSizeRef.current` instead of the literal `13`.
- Stash the fit addon so a later effect can refit: `const fitRef = useRef<FitAddon | null>(null);`
  set `fitRef.current = fit;` right after `term.loadAddon(fit)`.
- New effect, **separate** from creation, keyed on `[fontSize]`:
  ```ts
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    try { fitRef.current?.fit(); } catch { /* not measurable yet */ }
    void api.resizeSession(session.id, term.cols, term.rows);
  }, [fontSize, api, session.id]);
  ```
  Mutating `term.options.fontSize` then refitting recomputes cols/rows and pushes the new size to
  the daemon PTY (same path `applyFit` already uses). On first mount this effect runs once with
  the same value the terminal was created with — a harmless extra refit.

### 4. `MobileKeyBar.tsx` — the `A−` / `A+` zoom controls

- Read `const fontSize = useTerminalFontSize();` and `nudgeTerminalFontSize` from the store.
- A small leading group in the existing button row (before the control keys; after the agent
  attach button if present): **`A−`**, a non-interactive readout of the current px, **`A+`**.
- Both buttons use `onPointerDown={(e) => { e.preventDefault(); nudgeTerminalFontSize(∓STEP); }}`
  — the same no-focus idiom the control keys use, so the soft keyboard stays up while zooming.
- Styling matches the existing keys (`h-9 shrink-0 … rounded-md bg-neutral-800 … active:bg-neutral-700`);
  the readout is a centered `font-mono text-xs text-neutral-400` showing `fontSize`. Disable
  `A−` at `TERMINAL_FONT_MIN` and `A+` at `TERMINAL_FONT_MAX` (visual affordance only; the store
  clamps regardless). Buttons carry `aria-label="Decrease/Increase terminal text size"`.
- Mobile-only already: the whole bar returns `null` when `useIsDesktop()`.

### 5. `TerminalView.tsx` — one-finger drag-to-scroll

Add touch handlers on the host `container` inside the creation effect (cleaned up in its existing
teardown). Sketch:

```ts
let touchY: number | null = null;   // last clientY of the active 1-finger drag
let touchAccum = 0;                  // unconsumed pixel delta
let rowHeight = 0;                   // px per terminal row, measured at touchstart
let dragging = false;                // crossed the slop threshold → we own the gesture

const onTouchStart = (e: TouchEvent) => {
  if (e.touches.length !== 1) { touchY = null; return; }       // ignore multi-touch
  if (term.buffer.active.type === "alt") { touchY = null; return; } // full-screen TUI: leave it to xterm
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  rowHeight = screen && term.rows > 0 ? screen.clientHeight / term.rows : term.options.fontSize! * 1.2;
  touchY = e.touches[0].clientY;
  touchAccum = 0;
  dragging = false;
};
const onTouchMove = (e: TouchEvent) => {
  if (touchY === null || e.touches.length !== 1) return;
  const y = e.touches[0].clientY;
  touchAccum += touchY - y;          // finger up → positive → scroll toward newer
  touchY = y;
  if (!dragging && Math.abs(touchAccum) < SCROLL_SLOP_PX) return; // let small taps/long-press through
  dragging = true;
  e.preventDefault();                // stop native scroll + xterm's touch→mouse selection
  e.stopPropagation();               // stop the document-level shim (it listens in bubble phase)
  if (rowHeight > 0 && Math.abs(touchAccum) >= rowHeight) {
    const lines = Math.trunc(touchAccum / rowHeight);
    term.scrollLines(lines);
    touchAccum -= lines * rowHeight;
  }
};
const onTouchEnd = (e: TouchEvent) => {
  if (dragging) { e.preventDefault(); e.stopPropagation(); } // swallow the synthetic tap/click
  touchY = null;
  dragging = false;
};
container.addEventListener("touchstart", onTouchStart, { passive: false });
container.addEventListener("touchmove", onTouchMove, { passive: false }); // non-passive → preventDefault works
container.addEventListener("touchend", onTouchEnd);
container.addEventListener("touchcancel", onTouchEnd);
```

- `SCROLL_SLOP_PX` (≈ 6) is a module constant: below it we don't claim the gesture, so a tap
  (focus / mouse-report click) and a long-press (selection) still reach xterm.
- **Direction:** `term.scrollLines(n)` scrolls toward the bottom/newer for `n > 0`. Finger moving
  **up** yields positive accum → scroll toward newer; finger **down** → negative → older history.
  That is the natural content-follows-finger direction.
- **Row height** is measured from the rendered `.xterm-screen` height ÷ `term.rows` (accurate,
  DPR-correct), falling back to `fontSize * lineHeight` if the element isn't present yet.
- These listeners are added regardless of device — touch events only fire on touch input, so a
  desktop mouse/trackpad is unaffected (xterm's own wheel handler still drives desktop scroll).

### Component tree (unchanged placement)

```
AppShell
└─ main column
   ├─ TopBar
   ├─ MainView        → TerminalView per session tab (xterm host; font effect + touch-scroll live here)
   └─ MobileKeyBar    ← A− / A+ zoom buttons added here (mobile-only)
```

## UX details

- **Default sizes:** mobile 11 px, desktop 13 px. Range 8–22 px, step 1 px.
- **Zoom feedback:** the readout between `A−`/`A+` shows the current px; the terminal reflows
  immediately on each tap. Buttons disable at the range ends.
- **Keyboard stays up** while zooming (no-focus `onPointerDown`).
- **Persistence:** the chosen size survives reload and is per device (localStorage).
- **Scroll feel:** content follows the finger; small touches still tap/select (slop threshold).

## Edge cases

- **localStorage unavailable / corrupt / out-of-range:** `loadTerminalFontSize()` falls back to
  the device default; out-of-range stored values are clamped.
- **Multi-touch (pinch):** ignored by the scroll handler (`touches.length !== 1`), so browser
  page-zoom is not hijacked.
- **Full-screen agent TUI (alt-screen):** scroll handler bails at `touchstart`
  (`buffer.active.type === "alt"`), leaving touches to xterm — no scrollback exists there anyway.
- **Tap vs drag:** the `SCROLL_SLOP_PX` threshold means a tap (≤ slop) is never swallowed, so
  focus and mouse-report clicks still work; only a real drag is claimed.
- **Font change mid-session:** handled by the dedicated `[fontSize]` effect (mutate + refit +
  resize); the session stream and scrollback are untouched because the creation effect doesn't
  re-run.
- **resize ↔ font interplay:** the `ResizeObserver`'s `applyFit` and the font effect both end in
  `fit()` + `resizeSession` with the live `term.options.fontSize`, so they compose without
  fighting.

## Testing / verification

- `pnpm check` (typecheck — the repo's only pre-commit gate).
- Manual mobile (narrow viewport / device, web SPA):
  - terminal opens at 11 px (visibly more columns than before);
  - `A+` / `A−` change the size live, the readout tracks, and the size **persists across reload**;
  - one-finger drag up/down scrolls scrollback in the natural direction in a **shell** session;
  - on a full-screen **agent** TUI, dragging does not hijack/garble the screen;
  - the soft keyboard stays up when tapping the zoom buttons.
- Manual desktop regression: font stays 13 px, no zoom buttons, wheel-scroll and selection/copy
  unchanged.

## Files touched

- `packages/ui/src/lib/terminal-font.ts` — **new** (constants, clamp, default, load/save).
- `packages/ui/src/store/app.ts` — `terminalFontSize` state, `setTerminalFontSize` /
  `nudgeTerminalFontSize` actions, `useTerminalFontSize` hook.
- `packages/ui/src/components/terminal/TerminalView.tsx` — initial size from the store; `[fontSize]`
  effect (mutate + refit + resize); `fitRef`; touch drag-to-scroll handlers + a `SCROLL_SLOP_PX`
  constant.
- `packages/ui/src/components/terminal/MobileKeyBar.tsx` — `A−` / `A+` buttons + px readout.

## Decisions

- **One global font size, not per-session.** Terminal text size is a viewing preference, not a
  property of a session; a single persisted value is simpler and matches how a user thinks about
  "zoom." Every `TerminalView` reads it.
- **Zoom buttons over pinch-to-zoom.** Discoverable, no gesture conflict with drag-to-scroll or
  browser page-zoom, and they live naturally in the existing `MobileKeyBar`.
- **Device-appropriate default via `matchMedia`, single stored value.** Desktop keeps 13 px with
  zero UI; mobile starts at 11 px. Per-device localStorage keeps them independent without a
  second setting.
- **Drag-to-scroll skips the alt-screen.** A full-screen agent TUI has no scrollback; hijacking
  its touches would only garble it, so those touches pass through to xterm. Shells (normal
  buffer) get drag-scroll.
- **Claim the gesture only past a slop threshold.** Keeps tap-to-focus, mouse-report clicks, and
  long-press selection working; only a deliberate drag scrolls.
