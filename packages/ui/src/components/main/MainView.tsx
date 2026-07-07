import React from "react";
import { FolderTree, GitBranch, LayoutGrid, ListTodo, MousePointerClick, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { EmptyState } from "./EmptyState";
import { TerminalView } from "../terminal";
import { FileBrowser } from "../files";
import { GitView } from "../git";
import { TodoView } from "../todo";
import { getRegistryIcon } from "../../icons";
import { SessionStatusDot } from "../ui/session-status-dot";
import { ResizeHandle } from "../ui";
import { useIsDesktop } from "../../hooks";
import { GRID_MIN_COL_PX, GRID_MIN_ROW_PX, type GridTracks } from "../../lib/panel-sizes";
import {
  useActiveTabId,
  useAppStore,
  useCurrentContext,
  useGridTracks,
  useProjectTabs,
  useViewMode,
  type ProjectTab
} from "../../store/app";

/** Icon shown in a grid-cell header — mirrors the tab strip. */
function cellIcon(tab: ProjectTab): React.ReactNode {
  return tab.type === "session" ? (
    getRegistryIcon(tab.session.kind, tab.session.refId, 13)
  ) : tab.type === "git" ? (
    <GitBranch size={13} />
  ) : tab.type === "todo" ? (
    <ListTodo size={13} />
  ) : (
    <FolderTree size={13} />
  );
}

function cellTitle(tab: ProjectTab): string {
  return tab.type === "session" ? tab.session.title : tab.title;
}

/** Grid columns for a tab count: 1→1, 2-4→2, 5-9→3, 10+→4 (capped). */
function gridColumns(count: number): number {
  return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))));
}

/**
 * Positive fraction weights for one grid axis: the persisted array when it
 * matches the current track count, else uniform (the load layer already dropped
 * non-finite/≤0 values, so a length match is the only render-time check needed).
 */
function trackWeights(stored: number[] | undefined, count: number): number[] {
  if (stored && stored.length === count) {
    return stored;
  }
  return Array.from({ length: count }, () => 1);
}

/** A weight array is "uniform" only if every entry is exactly equal (drags never are). */
function isUniform(weights: number[]): boolean {
  return weights.every((w) => w === weights[0]);
}

/**
 * Main panel. Every tab of the current project is kept mounted (terminal output
 * streams stay open): tab view shows only the active one, grid view lays them
 * all out at once. Both modes share one render tree — only classes/styles
 * change — so toggling never tears a terminal (xterm + output stream) down.
 */
export const MainView: React.FC = () => {
  const ctx = useCurrentContext();
  const tabs = useProjectTabs();
  const activeId = useActiveTabId();
  const viewMode = useViewMode();
  const isDesktop = useIsDesktop();
  const gridTracks = useGridTracks();
  const gridRef = React.useRef<HTMLDivElement | null>(null);
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);

  // Grid is a desktop-only layout; a persisted "grid" falls back to tab view on
  // narrow viewports (the toggle isn't shown there either). A workspace context
  // never has a project, so useViewMode() returns "tabs" there — grid stays off.
  const grid = isDesktop && viewMode === "grid";

  if (!ctx) {
    return (
      <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
        <EmptyState
          icon={<LayoutGrid size={40} strokeWidth={1.25} />}
          title="No workspace selected"
          description="Pick a workspace from the sidebar."
        />
      </main>
    );
  }

  if (tabs.length === 0) {
    return (
      <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
        {ctx.kind === "project" ? (
          <EmptyState
            icon={<MousePointerClick size={40} strokeWidth={1.25} />}
            title="No tabs open"
            description='Use the "+" button in the top bar to open a terminal, agent or file browser.'
          />
        ) : (
          <EmptyState
            icon={<ListTodo size={40} strokeWidth={1.25} />}
            title="No to-do lists open"
            description='Use "+" or the sidebar to open a to-do list.'
          />
        )}
      </main>
    );
  }

  const projectPath = ctx.kind === "project" ? ctx.project.path : "";
  const columns = gridColumns(tabs.length);
  const rowCount = Math.ceil(tabs.length / columns);
  // Explicit fraction weights per axis (uniform when unset or count-mismatched).
  // These drive both the CSS templates and the overlay divider geometry, so a
  // live drag (which writes new weights to the store) re-renders both in sync.
  const colWeights = trackWeights(gridTracks?.cols, columns);
  const rowWeights = trackWeights(gridTracks?.rows, rowCount);
  const colTotal = colWeights.reduce((a, b) => a + b, 0);
  const rowTotal = rowWeights.reduce((a, b) => a + b, 0);
  const colTemplate = colWeights.map((w) => `minmax(0, ${w}fr)`).join(" ");
  const rowTemplate = rowWeights.map((w) => `minmax(0, ${w}fr)`).join(" ");

  // Fractional offsets (0..1) of the interior track boundaries. Rendered via a
  // calc() that folds in the `gap-px` budget: CSS grid sizes fr tracks from
  // (container − (n−1)·1px gaps) then inserts a 1px gap between each pair, so a
  // boundary sits at `trackFraction·(100% − totalGap) + priorGaps`. Fewer than
  // `count − 1` entries when a single column/row leaves no interior boundary.
  const colBoundaries: { i: number; frac: number }[] = [];
  for (let i = 0, acc = 0; i < columns - 1; i++) {
    acc += colWeights[i];
    colBoundaries.push({ i, frac: acc / colTotal });
  }
  const rowBoundaries: { i: number; frac: number }[] = [];
  for (let i = 0, acc = 0; i < rowCount - 1; i++) {
    acc += rowWeights[i];
    rowBoundaries.push({ i, frac: acc / rowTotal });
  }

  /**
   * Build the drag wiring for the divider between track `i` and `i+1` on one
   * axis. Weight is shifted only between those two adjacent tracks (their px sum
   * is preserved), so every other track — and thus this divider's left/top edge
   * — stays put across the per-frame re-renders a live drag triggers. Sizes flow
   * through the store live (persist=false) and land in localStorage on release.
   */
  const dividerProps = (axis: "col" | "row", i: number) => {
    const vertical = axis === "col";
    const count = vertical ? columns : rowCount;
    const minPx = vertical ? GRID_MIN_COL_PX : GRID_MIN_ROW_PX;
    // Live container extent + adjacent-track px geometry, recomputed each call
    // from the CURRENT store weights (never a stale render closure) so two
    // simultaneous drags — on either axis or on different pairs of the same
    // axis — always compose against fresh geometry instead of clobbering.
    const geom = () => {
      const stored = useAppStore.getState().gridTracksByProject[projectPath];
      const weights = vertical
        ? trackWeights(stored?.cols, columns)
        : trackWeights(stored?.rows, rowCount);
      const total = weights.reduce((a, b) => a + b, 0);
      const rect = gridRef.current?.getBoundingClientRect();
      const rectSize = rect ? (vertical ? rect.width : rect.height) : 0;
      // Subtract the `gap-px` budget ((count−1)·1px) so px sums match the space
      // CSS actually distributes to the fr tracks (the clamp mins line up too).
      const extent = Math.max(0, rectSize - (count - 1));
      const px = weights.map((w) => (total > 0 ? (w / total) * extent : 0));
      let leftEdge = 0;
      for (let k = 0; k < i; k++) {
        leftEdge += px[k];
      }
      return { extent, px, leftEdge, combined: px[i] + px[i + 1] };
    };
    // Clamp a proposed boundary position into the valid range for the geometry
    // `g`. When the two adjacent tracks together can't hold two min-sized tracks,
    // no boundary honors both mins (the min/max bounds cross), so pin the divider
    // at its current position instead of collapsing a track below min. Otherwise
    // the result lands in [leftEdge+minPx, leftEdge+combined-minPx], so both
    // resulting tracks are ≥ minPx (and thus positive).
    const clampBoundary = (next: number, g: ReturnType<typeof geom>): number => {
      if (g.combined < 2 * minPx) {
        return g.leftEdge + g.px[i];
      }
      return Math.max(g.leftEdge + minPx, Math.min(g.leftEdge + g.combined - minPx, next));
    };
    const write = (next: number, persist: boolean) => {
      const g = geom();
      // Freeze when the pair can't hold two min-sized tracks: any split would put
      // one track below its min, and `combined - sizeA` could even go negative,
      // which renders as `minmax(0, -Nfr)` (an invalid <flex>) and drops the whole
      // grid template until reload.
      if (g.extent <= 0 || g.combined < 2 * minPx) {
        return;
      }
      // Re-clamp `next` against THIS write's fresh geometry — never trust the
      // caller's value. `onResize`/`onCommit` may fire with a `next` computed
      // against older geometry (e.g. tab-count/container change mid-drag with no
      // subsequent pointermove to re-clamp it), so sanitizing here — the single
      // write choke point — guarantees no code path ever persists a track below
      // its min or a negative weight, regardless of geometry shifts.
      const sizeA = clampBoundary(next, g) - g.leftEdge;
      const track = [...g.px];
      track[i] = sizeA;
      track[i + 1] = g.combined - sizeA;
      // Mutate only this divider's two adjacent tracks; the rest of this axis
      // comes from `g.px` (fresh) and the OTHER axis is read fresh from the store
      // — never a render closure — so a concurrent drag on the other divider or
      // axis is preserved rather than overwritten with a stale value.
      const stored = useAppStore.getState().gridTracksByProject[projectPath];
      const other = vertical
        ? trackWeights(stored?.rows, rowCount)
        : trackWeights(stored?.cols, columns);
      const tracks: GridTracks = vertical
        ? { cols: track, rows: other }
        : { cols: other, rows: track };
      useAppStore.getState().setGridTracks(projectPath, tracks, persist);
    };
    return {
      orientation: vertical ? ("vertical" as const) : ("horizontal" as const),
      getCurrent: () => {
        const { leftEdge, px } = geom();
        return leftEdge + px[i];
      },
      clamp: (next: number) => clampBoundary(next, geom()),
      onResize: (next: number) => write(next, false),
      onCommit: (next: number) => write(next, true),
      // Double-click resets THIS axis only: preserve the other axis unless it is
      // also uniform/absent, in which case drop the whole entry (uniform × 2).
      onReset: () => {
        const state = useAppStore.getState();
        const cur = state.gridTracksByProject[projectPath];
        const other = vertical ? cur?.rows : cur?.cols;
        const otherLen = vertical ? rowCount : columns;
        const keepOther = other && other.length === otherLen && !isUniform(other) ? other : null;
        if (!keepOther) {
          state.resetGridTracks(projectPath);
          return;
        }
        const uniform = Array.from({ length: vertical ? columns : rowCount }, () => 1);
        state.setGridTracks(
          projectPath,
          vertical ? { cols: uniform, rows: keepOther } : { cols: keepOther, rows: uniform },
          true
        );
      }
    };
  };

  return (
    <main className="min-h-0 flex-1 overflow-hidden bg-neutral-950">
      <div
        ref={gridRef}
        className={cn("h-full w-full", grid && "relative grid gap-px")}
        style={grid ? { gridTemplateColumns: colTemplate, gridTemplateRows: rowTemplate } : undefined}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const show = grid || active; // tab view: only active; grid: every cell
          return (
            <div
              key={tab.id}
              onClick={grid ? () => activateTab(tab.id) : undefined}
              className={cn(
                "h-full w-full min-h-0 min-w-0 flex-col",
                show ? "flex" : "hidden",
                grid && "overflow-hidden border border-neutral-800",
                grid && active && "border-neutral-500 ring-1 ring-inset ring-neutral-500"
              )}
            >
              {/* Header lives in the DOM in both modes (hidden in tab view) so the
                  tree stays structurally stable and terminals never remount. */}
              <div
                className={cn(
                  "h-7 shrink-0 items-center gap-1.5 border-b border-neutral-800 bg-neutral-900/40 px-2",
                  grid ? "flex" : "hidden"
                )}
              >
                <span className="text-neutral-500">{cellIcon(tab)}</span>
                <span className="flex-1 truncate text-xs text-neutral-300">{cellTitle(tab)}</span>
                {tab.type === "session" ? (
                  <SessionStatusDot sessionId={tab.id} status={tab.session.status} />
                ) : null}
                <button
                  type="button"
                  aria-label="Close tab"
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.id);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                {tab.type === "session" ? (
                  <TerminalView session={tab.session} active={active} viewMode={viewMode} />
                ) : tab.type === "git" ? (
                  // active={show}: in grid view every VISIBLE cell stays live, not
                  // only the focused one (TerminalView keeps focus-only semantics).
                  // Git/Files tabs only ever exist in project context, so the
                  // ternary just satisfies the type — ctx.project.path is defined.
                  <GitView projectPath={ctx.kind === "project" ? ctx.project.path : ""} active={show} />
                ) : tab.type === "files" ? (
                  <FileBrowser rootPath={ctx.kind === "project" ? ctx.project.path : ""} active={show} />
                ) : (
                  <TodoView todoId={tab.todoId} active={active} />
                )}
              </div>
            </div>
          );
        })}
        {/* Divider overlays: absolutely-positioned siblings so they never alter
            the cell subtree (keys/order/nesting) — terminals must not remount.
            Grid-only; a single column/row yields no boundaries on that axis. */}
        {grid &&
          colBoundaries.map(({ i, frac }) => (
            <ResizeHandle
              key={`col-divider-${i}`}
              aria-label="Resize column"
              {...dividerProps("col", i)}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `calc((100% - ${columns - 1}px) * ${frac} + ${i}px)`
              }}
            />
          ))}
        {grid &&
          rowBoundaries.map(({ i, frac }) => (
            <ResizeHandle
              key={`row-divider-${i}`}
              aria-label="Resize row"
              {...dividerProps("row", i)}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: `calc((100% - ${rowCount - 1}px) * ${frac} + ${i}px)`
              }}
            />
          ))}
      </div>
    </main>
  );
};
