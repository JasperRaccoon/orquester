import React from "react";
import { useRegistry } from "../../hooks";
import { getRegistryIcon } from "../../icons";
import { useAppStore } from "../../store/app";
import { RecentConversationsList } from "../main/ProjectOverview";

/** Newest-first rows the empty-thread panel lists; the rest stay in the overview. */
export const EMPTY_PANEL_LIMIT = 10;

/**
 * What an EMPTY thread shows instead of "No messages yet.": the provider's
 * name and icon, then this project's resumable conversations for that
 * provider, exactly as the project overview offers them when no tab is open.
 * Picking one opens the resumed tab and closes this empty one.
 *
 * Lives outside the timeline on purpose: it is the one piece of the chat that
 * knows about the registry (icons, names) and the resume picker, and the
 * timeline must stay importable by the render-smoke checks that cannot load
 * an SVG. The timeline only reserves the space and receives this as a node.
 */
export const EmptyThreadPanel: React.FC<{
  sessionId: string;
  projectPath: string;
  agentRefId: string;
  bottomInset: number;
}> = ({ sessionId, projectPath, agentRefId, bottomInset }) => {
  const registry = useRegistry();
  const closeTab = useAppStore((s) => s.closeTab);
  const entry = registry.agents.find((a) => a.id === agentRefId);
  const adapter = entry?.chat?.adapter;
  const agentName = entry?.name ?? agentRefId;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-1 pt-4" style={{ minHeight: 0 }}>
      <div className="mb-5 flex shrink-0 items-center justify-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-neutral-900 text-neutral-200">
          {getRegistryIcon("agent", agentRefId, 22)}
        </span>
        <h2 className="text-xl font-semibold tracking-tight text-neutral-100">{agentName}</h2>
      </div>
      <p className="shrink-0 text-sm font-medium text-neutral-200">Recent conversations</p>
      <p className="mb-2 mt-0.5 shrink-0 text-xs text-neutral-600">
        This project&apos;s {agentName} conversations, newest first. Pick one up, or just start typing below.
      </p>
      <div className="ac-scroll-thin min-h-0 flex-1 overflow-y-auto pr-1">
        <RecentConversationsList
          projectPath={projectPath}
          adapter={adapter}
          limit={EMPTY_PANEL_LIMIT}
          onPicked={() => void closeTab(sessionId)}
          empty={
            <p className="py-6 text-center text-sm italic text-neutral-600">
              No {agentName} conversations in this project yet.
            </p>
          }
        />
      </div>
      <div aria-hidden className="shrink-0" style={{ height: bottomInset + 12 }} />
    </div>
  );
};
