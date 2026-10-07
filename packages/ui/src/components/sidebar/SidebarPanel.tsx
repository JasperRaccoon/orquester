import React from "react";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import {
  RIGHT_RAIL_PANEL_REGISTRY,
  dockKeyDownHandler,
  useActiveChatTarget,
  useDockKeyboardLayer,
  useFocusInside,
  useOpenProjectPath
} from "../right-rail";

/**
 * A rail panel shown in the desktop sidebar — workflows or the agent profile —
 * under a header with its icon and title. It keeps the dock's contract
 * (`RightRailDock.tsx`): the panel fills the body and scrolls itself, keys
 * typed in it stay in it, and an Escape nothing in it handled goes back to
 * the visible chat's composer. With no project open the panel gets an empty
 * `projectPath`: the workflows panel then lists every workflow and offers no
 * per-project actions; the agent profile never needs one.
 */
export const SidebarPanel: React.FC<{ id: "workflows" | "profile" }> = ({ id }) => {
  const { title, Icon, Component } = RIGHT_RAIL_PANEL_REGISTRY[id];
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const focusInside = useFocusInside(node);
  const otherLayerOpen = useDockKeyboardLayer(focusInside);
  const sessionId = useActiveChatTarget();
  const projectPath = useOpenProjectPath() ?? "";
  const titleId = `sidebar-panel-${id}-title`;

  return (
    <section
      ref={setNode}
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={dockKeyDownHandler(otherLayerOpen)}
      {...KEYBOARD_SURFACE_PROPS}
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Icon size={16} aria-hidden className="shrink-0 text-neutral-300" />
        <h2 id={titleId} className="min-w-0 truncate text-[15px] font-medium text-neutral-100">
          {title}
        </h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col text-sm">
        <Component sessionId={sessionId} projectPath={projectPath} variant="docked" />
      </div>
    </section>
  );
};
