/**
 * The docked panel: between the tab content and the icon rail (desktop), a
 * resizable column with a header — the panel's icon and title — over the
 * active panel.
 *
 * **The contract with the panels** (`SavedPromptsPanel`, `PromptHistoryPanel`,
 * both taking `RightRailPanelProps`):
 * - The dock draws the chrome — the left border, the header (`px-3`), the
 *   resize handle — and renders the panel into a body
 *   `div.flex.min-h-0.flex-1.flex-col.text-sm`. The panel's ROOT fills that
 *   body (`flex min-h-0 flex-1 flex-col`) and manages its own scrolling: a
 *   `min-h-0 flex-1 overflow-y-auto` region inside it, never a height of its
 *   own. Its padding is its own (both panels use `px-3`, which lines up with
 *   the header). The dock clips horizontal overflow, and its width is the
 *   user's — content never sizes it. The resize handle's grip covers the
 *   dock's leftmost 12px.
 * - Props: `variant="docked"`, `projectPath` (the open project), `sessionId`
 *   (the visible chat tab, `useActiveChatTarget()`, or `null`), and no
 *   `onDelivered`. Only the active panel is mounted: switching panels
 *   unmounts the other, so state that must survive a switch lives in a store.
 * - Keys: handle them with React handlers inside the panel. An Escape the
 *   panel acts on must `preventDefault()` (or stop it), as `RailSearchInput`
 *   does when it clears itself; an Escape nothing handled leaves the dock,
 *   focus back in the visible chat's composer. Every other keydown that starts
 *   inside the dock stops at the dock: document-level listeners never see it
 *   (`dock-keyboard.ts`).
 */

import React from "react";

import { activeChatTab } from "../../lib/agent-chat-active-tab";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { composerHandle, focusComposer } from "../agent-chat/composer/composer-bridge";
import { ResizeHandle } from "../ui/resize-handle";
import { useActiveChatTarget } from "./chat-target";
import { dockKeyAction, useDockKeyboardLayer, useFocusInside } from "./dock-keyboard";
import { RIGHT_RAIL_DOCK_ID, RIGHT_RAIL_PANEL_REGISTRY, type RightRailPanelRegistry } from "./panels";
import {
  RIGHT_RAIL_CSS_MAX_WIDTH,
  RIGHT_RAIL_CSS_MIN_WIDTH,
  clampRightRailWidth,
  resetRightRailWidth,
  rightRailState,
  setRightRailWidth
} from "./right-rail-state";
import type { RightRailPanelId, RightRailPanelProps } from "./types";

const TITLE_ID = `${RIGHT_RAIL_DOCK_ID}-title`;

export interface RightRailDockProps {
  panel: RightRailPanelId;
  /** The open project's directory. */
  projectPath: string;
  /** The stored width (px); the render also caps it against the row. */
  width: number;
  /** The row the dock shares with the tab content and the rail: its width caps the dock's. */
  rowRef?: { readonly current: HTMLElement | null };
  /** The panels by id (the real ones unless a check passes fakes). */
  panels?: RightRailPanelRegistry;
}

/**
 * Hand the keyboard back after an Escape nothing in the dock handled: to the
 * visible chat's composer, caret at the end — else, with no chat on screen or
 * its composer not mounted, by blurring, which lets the dock's layer go.
 */
function leaveDock(dock: HTMLElement): void {
  const sessionId = activeChatTab();
  if (sessionId !== null && composerHandle(sessionId) !== null) {
    focusComposer(sessionId);
  }
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && dock.contains(focused)) {
    focused.blur();
  }
}

/**
 * The panel itself, memoised on what it renders from: a width drag re-renders
 * the dock every frame, and the list inside must not follow it.
 */
const DockBody = React.memo(function DockBody({
  Component,
  projectPath
}: {
  Component: React.ComponentType<RightRailPanelProps>;
  projectPath: string;
}) {
  const sessionId = useActiveChatTarget();
  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm">
      <Component sessionId={sessionId} projectPath={projectPath} variant="docked" />
    </div>
  );
});

export const RightRailDock: React.FC<RightRailDockProps> = ({
  panel,
  projectPath,
  width,
  rowRef,
  panels = RIGHT_RAIL_PANEL_REGISTRY
}) => {
  const { title, Icon, Component } = panels[panel];
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  // A keyboard layer while focus is inside: the chat's Escape arms and
  // Ctrl+Shift+A stand down while the user works in the panel.
  const focusInside = useFocusInside(node);
  const otherLayerOpen = useDockKeyboardLayer(focusInside);

  // The row's width, measured once per drag, at pointer-down — not on every
  // pointer move: it caps the drag so the tab content keeps its floor.
  const dragRowWidth = React.useRef<number | null>(null);
  // The width as drawn: on a narrowed window the CSS bounds below hold it
  // under the stored one, and a drag must start from what the user sees.
  const drawnWidth = (): number => node?.getBoundingClientRect().width || rightRailState().width;
  const startDrag = (): number => {
    dragRowWidth.current = rowRef?.current?.getBoundingClientRect().width ?? null;
    return -drawnWidth();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const dock = event.currentTarget;
    const target = event.target;
    const action = dockKeyAction({
      key: event.key,
      repeat: event.repeat,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
      targetInsideDock: target instanceof Node && dock.contains(target),
      otherLayerOpen
    });
    if (action === "ignore") return;
    event.stopPropagation();
    if (action === "leave") {
      event.preventDefault();
      leaveDock(dock);
    }
  };

  return (
    <aside
      ref={setNode}
      id={RIGHT_RAIL_DOCK_ID}
      aria-labelledby={TITLE_ID}
      // Focusable itself, so a click anywhere in the panel keeps the
      // keyboard in the dock rather than dropping it on <body> (where a
      // bare Escape interrupts the running turn). Focus pulled back to it
      // after its element went away shows, for a keyboard user, as a ring.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The chat's chords stand down for keys typed in here (`lib/keyboard-surfaces.ts`).
      {...KEYBOARD_SURFACE_PROPS}
      className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
      style={{
        width,
        // The render-time guard behind the drag clamp, against the live
        // row: a window narrowed after the drag still leaves the tab
        // content its floor, which wins over the dock's minimum — the dock
        // gives way (down to nothing) and the rail stays whole.
        minWidth: RIGHT_RAIL_CSS_MIN_WIDTH,
        maxWidth: RIGHT_RAIL_CSS_MAX_WIDTH
      }}
    >
      {/* The handle grows its value to the RIGHT (`base + (x − start)`); the
          dock sits on the right and grows to the LEFT, so the handle drives
          the NEGATED width — dragging left widens it. Live frames update the
          state only; the release persists (the sidebar's pattern). It sits
          INSIDE the dock, on its left edge, its grip (the `separator`) running
          12px in from the seam rather than straddling it: straddling, its left
          half lay on the chat's — or a terminal's — scrollbar. The dock's
          `overflow-hidden` clips the grip to the dock, so nothing ever covers
          the tab content, nor the rail when a narrow row squeezes the dock
          to nothing. */}
      <ResizeHandle
        orientation="vertical"
        aria-label="Resize side panel"
        className="absolute inset-y-0 left-0 [&>[role=separator]]:left-0 [&>[role=separator]]:translate-x-0"
        getCurrent={startDrag}
        clamp={(next) => -clampRightRailWidth(-next, dragRowWidth.current)}
        onResize={(next) => setRightRailWidth(-next, { persist: false, rowWidth: dragRowWidth.current })}
        onCommit={(next) => setRightRailWidth(-next, { persist: true, rowWidth: dragRowWidth.current })}
        onReset={resetRightRailWidth}
      />
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Icon size={16} aria-hidden className="shrink-0 text-neutral-300" />
        <h2 id={TITLE_ID} className="min-w-0 truncate text-[15px] font-medium text-neutral-100">
          {title}
        </h2>
      </header>
      <DockBody Component={Component} projectPath={projectPath} />
    </aside>
  );
};
