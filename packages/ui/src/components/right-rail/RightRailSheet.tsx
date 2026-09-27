/**
 * The right rail on a phone: no rail and no dock, but a bookmark button in the
 * top bar that opens both panels in a bottom sheet, under a Prompts | History
 * switch that remembers its last tab.
 *
 * **The contract with the panels**, on top of the dock's (`RightRailDock.tsx`):
 * - Props: `variant="sheet"`, and `onDelivered`, which closes the sheet —
 *   call it once an Insert or a Send landed.
 * - The panel renders into a fixed-height `flex min-h-0 flex-1 flex-col` body
 *   under the switch, inside the sheet's own `px-2` padding. Its root fills
 *   that body exactly as in the dock and scrolls inside it; the sheet around
 *   it never scrolls.
 * - Layers: a Dropdown, Tooltip or ContextMenu (z-[120]) opens above the sheet,
 *   but a Modal or ConfirmDialog (z-[100]) would open UNDER it (z-[110]). The
 *   sheet steps aside by itself when the saved-prompt editor opens; any other
 *   confirmation in the sheet variant belongs inline.
 * - The sheet holds its own keyboard layer and safe-area padding (`ui/sheet`).
 *   Escape closes it unless the panel stops the key (as `RailSearchInput`
 *   does when it clears itself): the sheet's listener is on `document`.
 */

import React from "react";
import { Bookmark } from "lucide-react";

import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { IconButton } from "../ui/icon-button";
import { BottomSheet } from "../ui/sheet";
import { useActiveChatTarget } from "./chat-target";
import { RIGHT_RAIL_PANEL_ORDER, RIGHT_RAIL_PANEL_REGISTRY, type RightRailPanelRegistry } from "./panels";
import { RailSegmented } from "./primitives";
import { setRightRailSheetPanel, useRightRailState } from "./right-rail-state";
import { subscribeSavedPromptEditorOpened } from "./saved-prompts/editor-bridge";

/**
 * The body's height: the sheet's own cap (`max-h-[75vh]`) less its chrome —
 * the grab handle's row, the content padding and its border (2rem, with a few
 * px to spare) and the bottom padding (`max(0.5rem, safe-area inset)`) — so the
 * panel fills a fixed box and the sheet around it never grows a second
 * scrollbar. Fixed rather than content-sized: filtering a list must not make
 * the sheet jump.
 */
const SHEET_BODY_HEIGHT = "calc(75vh - 2rem - max(0.5rem, env(safe-area-inset-bottom)))";

export interface RightRailSheetBodyProps {
  /** The open project's directory. */
  projectPath: string;
  /** An Insert or a Send landed: the sheet closes. */
  onDelivered: () => void;
  /** The panels by id (the real ones unless a check passes fakes). */
  panels?: RightRailPanelRegistry;
}

/** The sheet's content: the Prompts | History switch over the active panel. */
export const RightRailSheetBody: React.FC<RightRailSheetBodyProps> = ({
  projectPath,
  onDelivered,
  panels = RIGHT_RAIL_PANEL_REGISTRY
}) => {
  const { sheet } = useRightRailState();
  const sessionId = useActiveChatTarget();
  const { Component } = panels[sheet];
  const options = RIGHT_RAIL_PANEL_ORDER.map((id) => ({
    id,
    label: panels[id].shortTitle,
    title: panels[id].title
  }));
  return (
    <div
      // The chat's chords stand down for keys typed in here (`lib/keyboard-surfaces.ts`).
      {...KEYBOARD_SURFACE_PROPS}
      className="flex min-h-0 flex-col gap-2 text-sm"
      style={{ height: SHEET_BODY_HEIGHT }}
    >
      <div className="shrink-0 px-1 pt-1">
        <RailSegmented
          label="Prompts and history"
          options={options}
          value={sheet}
          onChange={setRightRailSheetPanel}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Component
          sessionId={sessionId}
          projectPath={projectPath}
          variant="sheet"
          onDelivered={onDelivered}
        />
      </div>
    </div>
  );
};

export interface RightRailSheetProps {
  open: boolean;
  /** Must be stable: the sheet re-registers its listeners when it changes. */
  onClose: () => void;
  projectPath: string;
}

export const RightRailSheet: React.FC<RightRailSheetProps> = ({ open, onClose, projectPath }) => {
  // The saved-prompt editor is a Modal (z-[100]) and would open UNDER this
  // sheet (z-[110]), so the sheet steps aside once a host has opened it — the
  // precedent is ServerSwitcher's remove confirm. It listens on the OPENED
  // list, never as a host: that would make an open with no editor read as one.
  React.useEffect(
    () => (open ? subscribeSavedPromptEditorOpened(onClose) : undefined),
    [open, onClose]
  );
  return (
    <BottomSheet open={open} onClose={onClose} label="Prompts and history">
      <RightRailSheetBody projectPath={projectPath} onDelivered={onClose} />
    </BottomSheet>
  );
};

/**
 * The phone's entry point (the top bar's tab row, with a project open): a
 * bookmark button that opens the sheet. Its open state is its own, so the
 * sheet closes by itself when the top bar swaps to the desktop layout.
 */
export const RightRailSheetButton: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <>
      <IconButton
        label="Prompts & history"
        className="app-no-drag"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Bookmark size={16} />
      </IconButton>
      <RightRailSheet open={open} onClose={close} projectPath={projectPath} />
    </>
  );
};
