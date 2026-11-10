/**
 * "<label> is using <desktop> · Show" near a chat's composer (spec 2026-11-10 R2.5): this chat's
 * agent works on a desktop whose tab is not on screen. **Show** opens that tab; it never switches
 * by itself. Dismissing it, or opening the tab any other way, hides it for that agent stint; it
 * goes when control lapses. The rules are `lib/desktops/follow-chip.logic.ts`.
 */

import React from "react";
import { Monitor, X } from "lucide-react";

import { desktopActionsStore } from "../../../lib/desktops/actions-store";
import { desktopFollowChip, followedStints, type FollowChipDesktop } from "../../../lib/desktops/follow-chip.logic";
import { jumpToProject, resolveProjectRef } from "../../../lib/session-nav";
import { serverViewOpen, useAppStore } from "../../../store/app";

// Stints dismissed or followed in this page (desktop ids are a daemon's: stale keys never match).
const dismissed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function dismiss(keys: readonly string[]): void {
  const fresh = keys.filter((key) => !dismissed.has(key));
  if (fresh.length === 0) return;
  for (const key of fresh) dismissed.add(key);
  version += 1;
  for (const listener of listeners) listener();
}

function subscribeDismissed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function DesktopFollowChip({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const desktops = useAppStore((s) => s.desktops);
  const currentPath = useAppStore((s) => s.currentProject?.path ?? null);
  const activeTabs = useAppStore((s) => s.activeTabByProject);
  const serverView = useAppStore(serverViewOpen);
  const rings = React.useSyncExternalStore(desktopActionsStore.subscribe, () => desktopActionsStore.getState().rings);
  React.useSyncExternalStore(subscribeDismissed, () => version);

  const tabShown = React.useCallback(
    (desktop: FollowChipDesktop) => !serverView && currentPath === desktop.projectPath && activeTabs[desktop.projectPath] === desktop.id,
    [serverView, currentPath, activeTabs]
  );

  // Looking at the desktop counts as following it: the chip does not come back for that stint.
  React.useEffect(() => dismiss(followedStints(desktops, tabShown)), [desktops, tabShown]);

  const chip = desktopFollowChip({
    threadId: sessionId,
    desktops,
    latestAction: (desktopId) => rings[desktopId]?.entries.at(-1),
    tabShown,
    dismissed
  });
  if (!chip) return null;

  const show = () => {
    const state = useAppStore.getState();
    dismiss([chip.key]);
    jumpToProject({ project: resolveProjectRef(chip.projectPath, state.workspaces, state.projects), sessionId: chip.desktopId });
  };

  return (
    <div className="pointer-events-auto relative z-10 mx-auto flex w-full min-w-0 max-w-3xl justify-center px-3 pb-1.5 sm:px-5">
      <div
        role="status"
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-neutral-900/95 py-0.5 pl-2.5 pr-0.5 text-[12px] text-neutral-300 shadow-sm ring-1 ring-warn-500/30 backdrop-blur"
        data-desktop-follow={chip.desktopId}
      >
        <span aria-hidden className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-warn" />
        </span>
        <Monitor size={12} aria-hidden className="shrink-0 text-neutral-500" />
        <span className="min-w-0 truncate">{chip.text}</span>
        <button
          type="button"
          onClick={show}
          aria-label={`Show ${chip.title}`}
          className="shrink-0 rounded-full bg-warn/90 px-2.5 py-0.5 text-[11.5px] font-medium text-neutral-950 transition-colors hover:bg-warn focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Show
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => dismiss([chip.key])}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          <X size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
