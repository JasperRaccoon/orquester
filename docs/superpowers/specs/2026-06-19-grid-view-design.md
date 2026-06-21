# Tab View ⇄ Grid View — Design

**Date:** 2026-06-19
**Status:** Approved (pending spec review)

## Overview

A project's terminals/agents/file-browser are currently shown one tab at a
time (the **tab view**). This feature adds a **grid view** that lays every
open tab of the current project out side-by-side so they can be watched and
driven simultaneously, plus a topbar toggle to switch between the two.

### Goal

One sentence: give each project a per-project, persisted choice between the
existing one-tab-at-a-time view and an all-tabs-at-once grid.

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Scope of the tab/grid choice | **Per project** (each project remembers its own) |
| Persistence | **Persist across reloads/restarts** (client-side `localStorage`) |
| What the grid shows | **Every open tab**, including the file browser |
| Platform | Toggle is **desktop-only**; mobile always uses tab view |

## Key architectural insight

`MainView` already mounts **every** tab of the current project at once and
merely toggles each one between `block` and `hidden` (see its existing
comment: *"Every tab of the current project is kept mounted … only the active
one is shown"*). `TerminalView` owns an xterm instance whose `ResizeObserver`
refits the terminal and resizes the daemon PTY whenever its container changes
size.

Therefore grid view is a **pure layout change on already-mounted terminals**:

- No `apps/daemon`, `packages/api`, or `packages/config` changes.
- No new session lifecycle; xterm instances and output streams are untouched.
- Terminals reflow into grid cells automatically via the existing
  `ResizeObserver` → `fit()` → `resizeSession()` path.

### Non-remounting requirement

Toggling between tabs and grid MUST NOT remount any `TerminalView` — a remount
would dispose the xterm instance and close the output stream, causing a flash
and a buffer replay. This is achieved by keeping a **single, structurally
stable render tree** for both modes and only swapping `className`/`style`:

- The cells wrapper is always the same `<div>` element (its class/style
  changes between a plain container and a CSS grid).
- Each tab is always rendered as `<TerminalView key={tab.id}>` (or
  `<FileBrowser>`) at the same position with the same `key`, so React keeps it
  mounted across the toggle.
- The per-cell header always exists in the DOM and is simply `hidden` in tab
  mode.

## State & persistence

### Store (`packages/ui/src/store/app.ts`)

Add to `AppState`:

- `viewModeByProject: Record<string, ViewMode>` — keyed by project path,
  initialized from `loadViewModes()` (see helper below). Absent key ⇒ `"tabs"`.
- `setViewMode: (mode: ViewMode) => void` — sets the mode for
  `currentProject.path`, then persists the whole map via `saveViewModes`.

Selector hook exported from the store:

```ts
export function useViewMode(): ViewMode {
  return useAppStore((s) =>
    s.currentProject ? (s.viewModeByProject[s.currentProject.path] ?? "tabs") : "tabs"
  );
}
```

`setViewMode` is a no-op when no project is open.

### Persistence helper (`packages/ui/src/lib/view-mode.ts`, new)

```ts
export type ViewMode = "tabs" | "grid";
const KEY = "orquester:view-mode-by-project";

export function loadViewModes(): Record<string, ViewMode> { /* JSON.parse, guarded */ }
export function saveViewModes(map: Record<string, ViewMode>): void { /* JSON.stringify, guarded */ }
```

- Backed by `localStorage`, which exists in **both** the web app and the
  Electron renderer and survives restarts — so a single mechanism covers
  desktop and web with no daemon or `packages/config` changes.
- Both functions are wrapped in `try/catch` and guard `typeof localStorage`,
  so a private-mode/quota failure degrades to in-memory only (never throws).

## Toggle UI

### `packages/ui/src/components/topbar/ViewModeToggle.tsx` (new)

A compact two-button segmented control:

- Button A — **tab view**: icon `Square` (single pane), `aria-label="Tab view"`.
- Button B — **grid view**: icon `LayoutGrid`, `aria-label="Grid view"`.
- The active mode's button is highlighted (`bg-neutral-800 text-neutral-100`);
  the inactive one uses the muted/hover treatment used elsewhere in the topbar.
- Each button sets its mode via `setViewMode` and exposes `aria-pressed`.
- Reads the current mode via `useViewMode()`.

(The exact icons are cosmetic; `Square` + `LayoutGrid` are the chosen pair.)

### Placement (`packages/ui/src/components/topbar/TopBar.tsx`)

- Desktop layout only: render `<ViewModeToggle />` in the right-hand cluster,
  immediately before `OpenOnMenu`, wrapped in an `app-no-drag` container, and
  only when `currentProject` is set.
- The mobile layout is unchanged (no toggle), so mobile cannot enter grid mode.
- Export `ViewModeToggle` from `packages/ui/src/components/topbar/index.ts`.

## MainView layout (`packages/ui/src/components/main/MainView.tsx`)

`MainView` reads `useViewMode()` and `useIsDesktop()` (the latter already used
by `TopBar`). Grid is active only when **both** hold:

```ts
const grid = useIsDesktop() && viewMode === "grid";
```

Gating on `useIsDesktop()` means a `grid` value stored on a wide window falls
back to tabs when the window is narrow/mobile.

The `!currentProject` and `tabs.length === 0` branches keep rendering the
existing `EmptyState`s unchanged. The has-tabs branch renders the stable tree:

```tsx
const cols = Math.min(4, Math.ceil(Math.sqrt(tabs.length)));

<main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
  <div
    className={cn("h-full w-full", grid && "grid auto-rows-fr gap-px")}
    style={grid ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
  >
    {tabs.map((tab) => {
      const active = tab.id === activeId;
      const show = grid || active; // tab mode: only active visible; grid: all visible
      return (
        <div
          key={tab.id}
          onClick={grid ? () => activateTab(tab.id) : undefined}
          className={cn(
            "flex min-h-0 flex-col",
            show ? "flex" : "hidden",
            grid && "overflow-hidden border border-neutral-800",
            grid && active && "ring-1 ring-neutral-500"
          )}
        >
          {/* header — always in DOM, hidden in tab mode to keep the tree stable */}
          <div className={cn("items-center gap-1.5 ...", grid ? "flex" : "hidden")}>
            <span className="text-neutral-500">{cellIcon(tab)}</span>
            <span className="flex-1 truncate text-xs">{cellTitle(tab)}</span>
            <button aria-label="Close tab" onClick={(e) => { e.stopPropagation(); void closeTab(tab.id); }}>
              <X size={12} />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {tab.type === "session"
              ? <TerminalView session={tab.session} />
              : <FileBrowser rootPath={currentProject.path} />}
          </div>
        </div>
      );
    })}
  </div>
</main>
```

- **Column count:** `Math.min(4, Math.ceil(Math.sqrt(n)))` ⇒ 1→1, 2→2, 3-4→2,
  5-9→3, 10-16→4, capped at 4. Rows are equal via `auto-rows-fr`. Columns use
  an inline `gridTemplateColumns` (avoids Tailwind dynamic-class safelisting).
- **Cell header helpers** mirror `TabStrip`:
  - `cellIcon(tab)`: session ⇒ `getRegistryIcon(tab.session.kind, tab.session.refId, 13)`;
    files ⇒ `<FolderTree size={13} />`.
  - `cellTitle(tab)`: session ⇒ `tab.session.title`; files ⇒ `tab.title`.
- **Focus/active:** clicking a cell calls `activateTab(tab.id)` (highlights it);
  clicking into the terminal focuses xterm as usual. The close button
  `stopPropagation`s so it doesn't also activate.
- **Tab mode** is byte-for-byte the current behavior: non-grid wrapper, only the
  active cell `flex` (else `hidden`), header `hidden`.

## Mobile behavior

- No toggle is shown (desktop-only placement).
- `MainView` forces tab view via the `useIsDesktop()` gate, so even a persisted
  `grid` renders as tabs on a narrow window.

## Files touched

**New**

- `packages/ui/src/lib/view-mode.ts` — `ViewMode` type + `loadViewModes`/`saveViewModes`.
- `packages/ui/src/components/topbar/ViewModeToggle.tsx` — the segmented control.

**Modified**

- `packages/ui/src/store/app.ts` — `viewModeByProject` state (init from
  `loadViewModes`), `setViewMode` action (persists), `useViewMode` selector.
- `packages/ui/src/components/main/MainView.tsx` — grid/tabs layout branch +
  desktop gate + cell headers.
- `packages/ui/src/components/topbar/TopBar.tsx` — mount `<ViewModeToggle />`
  in the desktop right cluster.
- `packages/ui/src/components/topbar/index.ts` — export `ViewModeToggle`.

**Untouched:** `apps/daemon`, `packages/api`, `packages/config`.

## Non-goals (YAGNI)

- No resizable or draggable grid panes — fixed auto-grid only.
- No per-cell rename or drag-reorder; those remain in the tab strip (still
  visible above the grid).
- No daemon-side persistence / cross-client sharing of the view mode (it is a
  client-local preference).
- No grid view on mobile.
- No virtualization or cell-count cap (a project's tab count is small).

## Edge cases

- **0 tabs / no project:** unchanged `EmptyState`s; the wrapper/grid branch is
  not reached.
- **1 tab in grid:** `cols = 1`, a single full-size cell — visually ≈ tab view.
  The toggle remains available.
- **Hidden cells & `fit()`:** identical to today — hidden cells report a 0×0
  container and the existing `try/catch` around `fit()` absorbs it; entering
  grid makes them visible so they fit. (No change to `TerminalView`.)
- **File browser in a small cell:** allowed per the "everything" decision; may
  be cramped — accepted.
- **Toggling preserves PTYs/streams:** guaranteed by the stable render tree.
- **Closing the active cell in grid:** the store's existing `reassignActive`
  promotes a new active tab; the grid keeps rendering the remaining cells.

## Verification

1. `pnpm check` (typecheck + lint + build, as used for prior features).
2. Playwright UI driver (extends the existing `/tmp/orq-driver` pattern):
   - Log in, open a project, open **3 Bash** sessions.
   - Click the **Grid view** toggle (`aria-label="Grid view"`); assert ≥2 `.xterm`
     instances are visible with distinct, non-overlapping bounding-box `x`
     positions (i.e. genuinely side-by-side); type into one cell and confirm
     input is accepted.
   - Click **Tab view**; assert exactly one cell is visible.
   - Reload; assert the project comes back in **grid** (3 cells visible) —
     proves persistence.
   - Optionally open a second project; assert it defaults to **tab** view —
     proves per-project independence.
   - Capture a screenshot of the grid and confirm it visually.

## Notes

- The repository is not a git repo and the user has asked to leave changes
  uncommitted, so the brainstorming skill's "commit the design doc" step is
  intentionally skipped.
</content>
</invoke>
