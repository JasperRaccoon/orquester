# Resizable Panels — Design

Date: 2026-07-07. Status: approved.

Mouse/touch-draggable borders to resize UI panels in the shared React UI (`packages/ui`):
sidebar width, grid-view column/row tracks, git-tab pane splits, file-browser pane split.
Client-only; no daemon, API, or config-schema changes. Zero new dependencies.

## Decisions (settled with the user)

1. **Grid view = track resizing**, not Ghostty-style tree splits. Dragging a vertical divider
   resizes that whole column; horizontal divider resizes that whole row. The uniform CSS grid
   stays; only the track templates become explicit.
2. **Pointer Events + touch**: one code path (`pointerdown` → `setPointerCapture` →
   rAF-coalesced `pointermove` → `pointerup`), `touch-action: none` on the handle element only.
   Works for mouse, touch (tablets ≥768px), and pen.
3. **Dividers render nothing below 768px** (`md`). Below that, panes are already full-width
   master/detail stacks and grid view does not exist. Gate each divider the same way its panes
   are gated: CSS `md:` classes for git/file panes, `useIsDesktop()` for the sidebar.
4. **Verification is static**: `pnpm check` + multi-agent adversarial code review. No daemon or
   dev server is ever started in this checkout (live-instance rule). The user tests by hand
   after rebuild/deploy.

## New shared primitives (packages/ui)

### `src/lib/panel-sizes.ts`
Persistence module cloned from the `view-mode.ts` / `terminal-font.ts` mold: SSR-safe
(`typeof localStorage === "undefined"` guards), swallows storage errors, validates and clamps
on load. Per-device localStorage; deliberately NOT synced via daemon app config (sizes are
viewport-specific).

Keys and shapes:
- `orquester:sidebar-width` → `number` (global scalar).
- `orquester:pane-sizes-by-project` → `Record<projectPath, { fileTree?: number;
  gitChanges?: number; gitHistoryCommits?: number; gitHistoryFiles?: number }>` (px widths).
- `orquester:grid-tracks-by-project` → `Record<projectPath, { cols: number[]; rows: number[] }>`
  (positive fraction weights, analogous to `fr` units; sum is arbitrary, normalized at render).

Load-time validation: non-finite/≤0 numbers dropped; arrays with wrong types dropped. A stored
grid entry whose `cols.length`/`rows.length` doesn't match the current grid's column/row count
is ignored for rendering (grid falls back to uniform) — do not delete it eagerly; overwrite on
next drag.

Defaults & clamps:
- Sidebar: default 256 (today's `w-64`), clamp 180–480.
- File tree: default 256 (`w-64`); git panes: default 288 (`w-72`); clamp all 180–560.
- Grid tracks: default uniform. Min track size enforced during drag: ≥140px columns, ≥100px rows.

### `src/hooks/use-resize-drag.ts` + `src/components/ui/resize-handle.tsx`
- `useResizeDrag`: takes orientation, a `getCurrent()` size accessor, min/max (or a clamp fn),
  `onResize(next)` per-frame callback, `onCommit(final)` on release, optional `onReset` for
  double-click. Implements: `onPointerDown` (primary button/touch only) → `setPointerCapture`
  → `pointermove` deltas coalesced with `requestAnimationFrame` (at most one `onResize` per
  frame) → `pointerup`/`pointercancel` commits and releases capture. Cleans up listeners and
  any pending rAF on unmount. Swallows the click that follows a real drag (the FileBrowser
  long-press / TerminalView touch-shim precedent). A drag-slop threshold is unnecessary since
  the handle is not scrollable content.
- `ResizeHandle` component: renders the divider — a 1px visible line (match existing
  `border-neutral-800` seams) inside a wider invisible hit area (~10–16px straddling the
  border, via negative margins or absolute positioning so layout is unaffected),
  `cursor-col-resize` / `cursor-row-resize`, `touch-action: none` (inline style or arbitrary
  class), `app-no-drag` (inert on web, protects Electron titlebar band), hover/active highlight
  consistent with existing neutral palette, `role="separator"` + `aria-orientation`.
  Double-click → reset to default.

## Store wiring (`src/store/app.ts`)

New state initialized from `loadPanelSizes()` (same spot as `loadViewModes()`):
- `sidebarWidth: number`
- `paneSizesByProject: Record<string, PaneSizes>`
- `gridTracksByProject: Record<string, GridTracks>`

Setters (`setSidebarWidth`, `setPaneSize(projectPath, key, px)`,
`setGridTracks(projectPath, tracks)`, plus matching `reset*`) mirror `setViewMode`: update the
map immutably and persist via `panel-sizes.ts`. Persistence writes happen on **commit**
(pointerup / double-click reset), not per move; live drag feedback flows through the same store
fields (per-frame `set` is fine — React 18 batches — but `localStorage` writes only on commit).
`clearProjectLocalState` prunes `paneSizesByProject` and `gridTracksByProject` entries and
re-persists, exactly like `viewModeByProject`.

## The five seams

1. **Sidebar** — `components/sidebar/Sidebar.tsx:22`: desktop `<aside>` drops `w-64` for
   `style={{ width: sidebarWidth }}` (keeps `shrink-0`); `ResizeHandle` sits at its right edge,
   rendered only in the desktop branch (JS-gated, like the aside itself). Mobile drawer untouched.
2. **File browser** — `components/files/FileBrowser.tsx:338`: tree pane's `md:w-64` becomes a
   controlled width applied at `md+` only (mobile keeps `w-full` stacking); divider between tree
   and content, `hidden md:block`.
3. **Git Changes** — `components/git/ChangesPanel.tsx:215`: same treatment for the `md:w-72`
   list column vs diff.
4. **Git History** — `components/git/HistoryPanel.tsx:224, :307`: two independent dividers —
   commit list vs right area, and (nested inside the right area) files list vs diff.
   Each persists under its own key.
5. **Grid view** — `components/main/MainView.tsx:99-102`: when `grid` is true, build
   `gridTemplateColumns` / `gridTemplateRows` from the persisted fraction arrays (uniform when
   absent/mismatched), e.g. `minmax(0, ${w}fr)` per track with explicit row count
   (`Math.ceil(tabs.length / columns)`) replacing `auto-rows-fr`. **The tab-cell children and
   their keys/nesting must not change** — terminals must never remount (constraint documented
   at `MainView.tsx:43-48`). Divider handles are additional absolutely-positioned overlay
   siblings inside the grid container, placed at track boundaries computed from the fraction
   arrays (percent offsets); dragging one shifts weight between the two adjacent tracks,
   clamped so no track goes below its min px (using live container size from a ref). Row count
   1 → no horizontal dividers; column count 1 → no vertical dividers. Double-click a grid
   divider → reset that axis to uniform. When tab count changes the computed column count,
   stored arrays of the wrong length are ignored (uniform) — acceptable reset semantics.

Widths applied via inline `style` (dynamic px values; the codebase precedent is
`AppWrapper.tsx:20`). Mobile classes (`hidden`, `w-full`, drawer) stay exactly as they are:
inline `width` must not leak into the mobile branches (apply it conditionally, e.g. only when
`isDesktop` for JS-gated spots, or via a wrapper that only sets width at `md+`).

## Terminal safety

- Per-frame (rAF) layout updates bound the ResizeObserver → FitAddon → `resizeSession` flood to
  ≤1 per frame per terminal during drags; release produces the final fit naturally. No changes
  to `TerminalView` fit logic.
- Min track sizes keep every cell above `hasLayoutBox` degeneracy; `minmax(0, Xfr)` +
  `min-w-0 min-h-0` cells remain, so nothing overflows.
- `setPointerCapture` keeps the drag alive over xterm's mouse-reporting regions and the
  sandboxed HTML-preview iframe.

## Non-goals

No dividers below 768px; no Ghostty split-tree; no cross-device sync of sizes; no daemon/API
changes; no keyboard-arrow resizing (separator is focusable-free for now); no new dependencies.

## Verification

`pnpm check` clean + adversarial multi-agent review (terminal-remount safety, drag math/leaks,
persistence/store hygiene, responsive regressions, conventions). Manual behavioral testing by
the user after rebuild/deploy of the live instance.
