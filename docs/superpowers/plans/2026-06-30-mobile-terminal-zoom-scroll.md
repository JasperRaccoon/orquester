# Mobile Terminal Zoom + Drag-to-Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile, open terminals at a smaller default font with `A−`/`A+` zoom buttons (persisted per device), and let a one-finger drag scroll the scrollback.

**Architecture:** A new client-local persistence module (`terminal-font.ts`, mirroring `view-mode.ts`) holds one global terminal font size; the zustand store exposes it plus set/nudge actions and a selector hook. `TerminalView` reads the size as its initial xterm `fontSize` and reacts to changes via a dedicated effect (mutate + refit + resize, without tearing down the session), and gains touch drag-to-scroll handlers. `MobileKeyBar` gains the `A−`/`A+` controls. No daemon, wire-protocol, or desktop-behavior changes.

**Tech Stack:** TypeScript (strict, ESM), React 18, zustand, `@xterm/xterm` 6 + `@xterm/addon-fit`, Tailwind.

## Global Constraints

- **No test runner in this repo.** The pre-commit gate is `pnpm check` (`pnpm -r typecheck`, `tsc --noEmit`). "Done" = `pnpm check` clean **and** behavior verified by driving the app. Do not add a test framework. (AGENTS.md)
- **⛔ Never launch, restart, or stop the daemon** (`pnpm dev`, `dev:daemon`, `dev:web`'s daemon, `cli.ts`, the daemon port/socket, `systemctl`). Verify via `pnpm check` + the already-running app / Playwright in a mobile viewport. (AGENTS.md)
- **Commits go to the current branch as-is.** Do NOT create a new branch, even on `main`. (AGENTS.md)
- **Mirror the `view-mode.ts` persistence pattern** for the new module and store wiring.
- **Font:** storage key `orquester:terminal-font-size`; range **8–22 px**, step **1 px**; defaults **mobile 11 / desktop 13**; one **global** size (all terminals share it).
- **Mobile signal:** `!useIsDesktop()` (`useMediaQuery("(min-width: 768px)")`, `packages/ui/src/hooks/use-media-query.ts`).
- **ESM everywhere**, TS `strict`. All four files live under `packages/ui/src`.

---

### Task 1: `terminal-font.ts` persistence module

**Files:**
- Create: `packages/ui/src/lib/terminal-font.ts`

**Interfaces:**
- Consumes: nothing (pure module; browser globals are feature-detected).
- Produces:
  - `TERMINAL_FONT_MIN = 8`, `TERMINAL_FONT_MAX = 22`, `TERMINAL_FONT_STEP = 1` (all `number`)
  - `clampTerminalFontSize(size: number): number`
  - `defaultTerminalFontSize(): number`
  - `loadTerminalFontSize(): number`
  - `saveTerminalFontSize(size: number): void`

- [ ] **Step 1: Create the module**

Create `packages/ui/src/lib/terminal-font.ts`:

```ts
/**
 * Terminal font size (px) — a single client-local viewing preference, persisted
 * per device. Mirrors the view-mode.ts persistence pattern (safe defaults on any
 * failure; storage errors swallowed). The stored value is absolute px, exactly
 * what xterm's `fontSize` option wants.
 */

const STORAGE_KEY = "orquester:terminal-font-size";

export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 22;
export const TERMINAL_FONT_STEP = 1;

const DESKTOP_DEFAULT = 13;
const MOBILE_DEFAULT = 11;

/** Round to an integer px and clamp into [MIN, MAX]. */
export function clampTerminalFontSize(size: number): number {
  const rounded = Math.round(size);
  if (rounded < TERMINAL_FONT_MIN) {
    return TERMINAL_FONT_MIN;
  }
  if (rounded > TERMINAL_FONT_MAX) {
    return TERMINAL_FONT_MAX;
  }
  return rounded;
}

/**
 * Device-appropriate default: smaller on phones (more columns), 13 on desktop.
 * SSR-safe — falls back to the desktop default when matchMedia is unavailable.
 */
export function defaultTerminalFontSize(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return DESKTOP_DEFAULT;
  }
  return window.matchMedia("(min-width: 768px)").matches ? DESKTOP_DEFAULT : MOBILE_DEFAULT;
}

/** Load the persisted size (clamped), or the device default on any failure. */
export function loadTerminalFontSize(): number {
  try {
    if (typeof localStorage === "undefined") {
      return defaultTerminalFontSize();
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaultTerminalFontSize();
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return defaultTerminalFontSize();
    }
    return clampTerminalFontSize(parsed);
  } catch {
    return defaultTerminalFontSize();
  }
}

/** Persist the size; a storage failure is non-fatal (stays in-memory only). */
export function saveTerminalFontSize(size: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    /* ignore quota/availability errors — size stays in-memory only */
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS (no type errors).

- [ ] **Step 3: Smoke-test the pure logic (no committed test; tsx one-liner)**

Run:
```bash
node --import tsx -e "import('./packages/ui/src/lib/terminal-font.ts').then(m => console.log(m.clampTerminalFontSize(99), m.clampTerminalFontSize(1), m.clampTerminalFontSize(11.6)))"
```
Expected output: `22 8 12` (clamped high, clamped low, rounded).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/terminal-font.ts
git commit -m "feat(terminal): persisted terminal font-size module"
```

---

### Task 2: Store wiring (`terminalFontSize` state + actions + hook)

**Files:**
- Modify: `packages/ui/src/store/app.ts` (import ~line 16; state interface ~line 476; actions interface ~line 535; init ~line 587; action impls after `setViewMode` ~line 1299; hook after `useViewMode` ~line 1766)

**Interfaces:**
- Consumes: `clampTerminalFontSize`, `loadTerminalFontSize`, `saveTerminalFontSize` (Task 1).
- Produces:
  - store state `terminalFontSize: number`
  - store actions `setTerminalFontSize(size: number): void`, `nudgeTerminalFontSize(delta: number): void`
  - hook `useTerminalFontSize(): number`

- [ ] **Step 1: Add the import**

In `packages/ui/src/store/app.ts`, immediately after the existing line 16:

```ts
import { loadViewModes, saveViewModes, type ViewMode } from "../lib/view-mode";
```

add:

```ts
import {
  clampTerminalFontSize,
  loadTerminalFontSize,
  saveTerminalFontSize
} from "../lib/terminal-font";
```

- [ ] **Step 2: Add the state field**

In the store state interface, immediately after line 476:

```ts
  /** Per-project layout choice (tab view vs grid view); persisted client-side. */
  viewModeByProject: Record<string, ViewMode>;
```

add:

```ts
  /** Global terminal font size (px); persisted client-side, per device. */
  terminalFontSize: number;
```

- [ ] **Step 3: Add the action signatures**

In the actions interface, immediately after line 535 (`setViewMode: (mode: ViewMode) => void;`), add:

```ts
  setTerminalFontSize: (size: number) => void;
  nudgeTerminalFontSize: (delta: number) => void;
```

- [ ] **Step 4: Initialize the state**

In the store creator's initial state, immediately after line 587 (`viewModeByProject: loadViewModes(),`), add:

```ts
  terminalFontSize: loadTerminalFontSize(),
```

- [ ] **Step 5: Implement the actions**

Immediately after the `setViewMode` implementation (it ends with `}),` at line 1299), add:

```ts
  setTerminalFontSize: (size) =>
    set(() => {
      const next = clampTerminalFontSize(size);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),

  nudgeTerminalFontSize: (delta) =>
    set((state) => {
      const next = clampTerminalFontSize(state.terminalFontSize + delta);
      saveTerminalFontSize(next);
      return { terminalFontSize: next };
    }),
```

- [ ] **Step 6: Add the selector hook**

Immediately after the `useViewMode` hook (closes at line 1766), add:

```ts
export function useTerminalFontSize(): number {
  return useAppStore((s) => s.terminalFontSize);
}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: PASS. (If it complains that `terminalFontSize`/the actions are missing from the store object or interface, you missed one of Steps 2–5 — every interface member must have an initializer/impl.)

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/store/app.ts
git commit -m "feat(terminal): store wiring for global terminal font size"
```

---

### Task 3: `TerminalView` applies the font size and reacts to changes

**Files:**
- Modify: `packages/ui/src/components/terminal/TerminalView.tsx` (import line 6; component body ~line 80; `new Terminal({...})` `fontSize` line 105; after `term.loadAddon(fit)` line 127; new effect after the creation effect closes at line 415)

**Interfaces:**
- Consumes: `useTerminalFontSize` (Task 2), `FitAddon` (already imported), `api.resizeSession` (existing).
- Produces: nothing new for later tasks (Task 5 is independent of this).

- [ ] **Step 1: Import the hook**

Change line 6 from:

```ts
import { useAppStore } from "../../store/app";
```

to:

```ts
import { useAppStore, useTerminalFontSize } from "../../store/app";
```

- [ ] **Step 2: Read the size + add refs**

In the component body, immediately after `const api = useApi();` (line 80) and the existing `const containerRef = useRef<HTMLDivElement>(null);` / `const termRef = useRef<Terminal | null>(null);` lines, add:

```ts
  const fontSize = useTerminalFontSize();
  // Initial size is read through a ref so the terminal-creation effect (keyed on
  // [api, session.id]) does NOT re-run when the size changes — that would tear
  // down the session stream. Live changes are handled by a separate effect below.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const fitRef = useRef<FitAddon | null>(null);
```

- [ ] **Step 3: Use the size at terminal creation**

Change line 105 from:

```ts
      fontSize: 13,
```

to:

```ts
      fontSize: fontSizeRef.current,
```

- [ ] **Step 4: Stash the fit addon**

Immediately after line 127 (`term.loadAddon(fit);`), add:

```ts
    fitRef.current = fit;
```

- [ ] **Step 5: Add the live-update effect**

Immediately after the terminal-creation `useEffect` closes — it ends with `}, [api, session.id]);` at line 415 — add a new effect:

```ts
  // Apply a live font-size change (from the mobile A−/A+ buttons) without
  // recreating the terminal: mutate the option, refit (recomputes cols/rows),
  // and push the new size to the daemon PTY — the same path applyFit() uses.
  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      /* container not measurable yet */
    }
    void api.resizeSession(session.id, term.cols, term.rows);
  }, [fontSize, api, session.id]);
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/components/terminal/TerminalView.tsx
git commit -m "feat(terminal): apply persisted font size + react to live changes"
```

---

### Task 4: `MobileKeyBar` zoom controls (`A−` / readout / `A+`)

**Files:**
- Modify: `packages/ui/src/components/terminal/MobileKeyBar.tsx` (imports lines 3–6; button row ~line 97, inserting between the `{isAgent && (…)}` block (ends line 124) and `{KEYS.map(…)}` (line 125))

**Interfaces:**
- Consumes: `useTerminalFontSize` + store action `nudgeTerminalFontSize` (Task 2); `TERMINAL_FONT_MIN/MAX/STEP` (Task 1).
- Produces: nothing for later tasks.

- [ ] **Step 1: Add imports**

Change the store import on line 5 from:

```ts
import { useActiveTabId, useProjectTabs } from "../../store/app";
```

to:

```ts
import { useActiveTabId, useAppStore, useProjectTabs, useTerminalFontSize } from "../../store/app";
```

Then add, immediately after line 6 (`import { uploadFilesToSession, type UploadStatus } from "../../lib/session-upload";`):

```ts
import { TERMINAL_FONT_MIN, TERMINAL_FONT_MAX, TERMINAL_FONT_STEP } from "../../lib/terminal-font";
```

- [ ] **Step 2: Read size + action in the component body**

Immediately after the existing `const activeId = useActiveTabId();` (line 47), add:

```ts
  const fontSize = useTerminalFontSize();
  const nudgeTerminalFontSize = useAppStore((s) => s.nudgeTerminalFontSize);
```

- [ ] **Step 3: Render the zoom group**

In the button row, insert the zoom group between the closing `)}` of the `{isAgent && ( … )}` block (line 124) and the `{KEYS.map((key) => (` line (line 125):

```tsx
        <div className="flex shrink-0 items-stretch gap-1">
          <button
            type="button"
            aria-label="Decrease terminal text size"
            disabled={fontSize <= TERMINAL_FONT_MIN}
            // onPointerDown + preventDefault keeps the soft keyboard up (no focus steal).
            onPointerDown={(e) => {
              e.preventDefault();
              nudgeTerminalFontSize(-TERMINAL_FONT_STEP);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 font-mono text-sm text-neutral-200 active:bg-neutral-700 disabled:opacity-40"
          >
            A−
          </button>
          <span className="flex h-9 w-7 shrink-0 items-center justify-center font-mono text-xs text-neutral-400">
            {fontSize}
          </span>
          <button
            type="button"
            aria-label="Increase terminal text size"
            disabled={fontSize >= TERMINAL_FONT_MAX}
            onPointerDown={(e) => {
              e.preventDefault();
              nudgeTerminalFontSize(TERMINAL_FONT_STEP);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 font-mono text-sm text-neutral-200 active:bg-neutral-700 disabled:opacity-40"
          >
            A+
          </button>
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Behavioral check (mobile viewport, no daemon launch)**

In the already-running app (or Playwright/browser devtools at a <768 px viewport): open a session, confirm `A−`/`A+` shrink/grow the terminal text live, the readout tracks the value, the soft keyboard (if open) stays up, and the size **persists across a page reload**. Buttons disable at 8 and 22.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/terminal/MobileKeyBar.tsx
git commit -m "feat(terminal): A-/A+ font zoom buttons in mobile key bar"
```

---

### Task 5: `TerminalView` one-finger drag-to-scroll

**Files:**
- Modify: `packages/ui/src/components/terminal/TerminalView.tsx` (module constant after `REPAINT_NUDGE_MS` ~line 18; touch handlers + listeners inside the creation effect, added after the right-click listeners at line 226; matching cleanup in the effect's `return` at ~line 398)

**Interfaces:**
- Consumes: the in-effect `term` (xterm `Terminal`) and `container` (the host div); `term.buffer.active.type`, `term.scrollLines`, `term.rows`, `term.options.fontSize` (xterm 6 public API).
- Produces: nothing for later tasks.

- [ ] **Step 1: Add the slop constant**

Immediately after the `REPAINT_NUDGE_MS` constant (line 18), add:

```ts
// Pixels a touch must travel before we claim it as a scroll gesture. Below this,
// touches pass through to xterm so tap-to-focus, mouse-report clicks, and
// long-press selection still work.
const SCROLL_SLOP_PX = 6;
```

- [ ] **Step 2: Add the touch handlers inside the creation effect**

Immediately after the right-click listener registrations at line 226:

```ts
    container.addEventListener("mousedown", onRightMouseDown, true);
    container.addEventListener("contextmenu", onContextMenu, true);
```

add:

```ts
    // --- Touch drag-to-scroll (mobile) -------------------------------------
    // The scrollable .xterm-viewport sits UNDER .xterm-screen, and xterm's
    // touch→mouse shim turns a drag into a selection/mouse-report event — so a
    // drag never scrolls natively. Translate a one-finger vertical drag into
    // term.scrollLines(). Direction is content-follows-finger (finger down →
    // older history). Touch events only fire on touch input, so desktop
    // mouse/trackpad (xterm's own wheel handler) is unaffected.
    let touchY: number | null = null; // last clientY of the active 1-finger drag
    let touchAccum = 0; // unconsumed vertical px delta
    let touchRowHeight = 0; // px per row, measured at touchstart
    let touchDragging = false; // crossed the slop threshold → we own the gesture
    const onTouchStart = (event: TouchEvent) => {
      // Ignore multi-touch (pinch) and full-screen TUIs (alt-screen has no
      // scrollback — leave those touches to xterm).
      if (event.touches.length !== 1 || term.buffer.active.type === "alt") {
        touchY = null;
        return;
      }
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      touchRowHeight =
        screen && term.rows > 0
          ? screen.clientHeight / term.rows
          : (term.options.fontSize ?? 13) * 1.2;
      touchY = event.touches[0].clientY;
      touchAccum = 0;
      touchDragging = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchY === null || event.touches.length !== 1) {
        return;
      }
      const y = event.touches[0].clientY;
      touchAccum += touchY - y; // finger up → positive → scroll toward newer
      touchY = y;
      if (!touchDragging && Math.abs(touchAccum) < SCROLL_SLOP_PX) {
        return; // small move: let xterm have tap / long-press
      }
      touchDragging = true;
      event.preventDefault(); // stop native scroll + xterm's touch→mouse select
      event.stopPropagation(); // stop the document-level shim (bubble phase)
      if (touchRowHeight > 0 && Math.abs(touchAccum) >= touchRowHeight) {
        const lines = Math.trunc(touchAccum / touchRowHeight);
        term.scrollLines(lines);
        touchAccum -= lines * touchRowHeight;
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (touchDragging) {
        event.preventDefault(); // swallow the synthetic tap/click after a drag
        event.stopPropagation();
      }
      touchY = null;
      touchDragging = false;
    };
    // passive:false so preventDefault() works inside the move handler.
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);
    container.addEventListener("touchcancel", onTouchEnd);
```

- [ ] **Step 3: Add the cleanup**

In the effect's `return () => { … }` cleanup, immediately after the existing line 399:

```ts
      container.removeEventListener("contextmenu", onContextMenu, true);
```

add:

```ts
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
```

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Behavioral check (mobile viewport, no daemon launch)**

In the already-running app (or Playwright/devtools touch emulation at <768 px): in a **shell** session with scrollback, drag one finger up/down → the buffer scrolls in the natural direction; a quick tap still focuses (keyboard opens). In a **full-screen agent TUI** (alt-screen), a drag does not hijack/garble the screen. Pinch (two fingers) is not captured by the terminal.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/terminal/TerminalView.tsx
git commit -m "feat(terminal): one-finger drag-to-scroll on mobile"
```

---

### Task 6: Final integration verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck gate**

Run: `pnpm check`
Expected: PASS across all packages.

- [ ] **Step 2: End-to-end mobile pass (no daemon launch)**

Against the already-running app / Playwright at a phone viewport, confirm together:
- terminal opens at **11 px** on mobile (more columns than the old 13 px), **13 px** on desktop;
- `A−`/`A+` adjust live, readout tracks, value **persists across reload**, disables at 8 / 22, keyboard stays up;
- one-finger drag scrolls a shell's scrollback (natural direction); taps/long-press still work; alt-screen TUI unaffected; pinch not hijacked.

- [ ] **Step 3: Desktop regression**

At a ≥768 px viewport: no zoom buttons (the whole `MobileKeyBar` is `null`); font stays 13 px; wheel-scroll and selection/copy unchanged.

---

## Self-Review

**Spec coverage** (each spec section → task):
- terminal-font.ts module (spec §1) → Task 1. ✓
- Store wiring: state, set/nudge, hook (spec §2) → Task 2. ✓
- TerminalView initial size + `[fontSize]` effect + `fitRef` (spec §3) → Task 3. ✓
- MobileKeyBar A−/A+ + readout, no-focus, disabled at ends (spec §4) → Task 4. ✓
- TerminalView touch drag-to-scroll: single-finger, alt-screen skip, slop, direction, row-height, passive:false, cleanup (spec §5) → Task 5. ✓
- UX details / edge cases / testing (spec) → folded into Tasks 4–6 behavioral checks. ✓
- Files touched (spec) = the four files in Tasks 1–5. ✓

**Placeholder scan:** none — every code step has complete code; every command has expected output.

**Type consistency:** `clampTerminalFontSize`/`loadTerminalFontSize`/`saveTerminalFontSize`/`defaultTerminalFontSize` and `TERMINAL_FONT_MIN`/`MAX`/`STEP` are used identically in Tasks 2 and 4 as defined in Task 1. `terminalFontSize` (state), `setTerminalFontSize`/`nudgeTerminalFontSize` (actions), `useTerminalFontSize` (hook) are defined in Task 2 and consumed with the same names/types in Tasks 3–4. `fitRef`/`fontSizeRef` are introduced and used within Task 3; touch locals are self-contained in Task 5.
