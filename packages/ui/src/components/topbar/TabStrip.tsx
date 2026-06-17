import React from "react";
import { Circle, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { getRegistryIcon } from "../../icons";
import { useActiveSessionId, useAppStore, useProjectSessions } from "../../store/app";

/** Tabs for the current project — each is a live daemon session. */
export const TabStrip: React.FC = () => {
  const sessions = useProjectSessions();
  const activeTabId = useActiveSessionId();
  const activateTab = useAppStore((s) => s.activateTab);
  const closeTab = useAppStore((s) => s.closeTab);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="app-no-drag flex items-center gap-1">
      {sessions.map((session) => {
        const active = session.id === activeTabId;
        return (
          <div
            key={session.id}
            role="tab"
            aria-selected={active}
            onClick={() => activateTab(session.id)}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1 text-xs",
              active
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
            )}
          >
            <span className="text-neutral-500">{getRegistryIcon(session.kind, session.refId, 13)}</span>
            <span className="max-w-[140px] truncate">{session.title}</span>
            {session.status === "exited" ? (
              <Circle size={7} className="ml-0.5 fill-neutral-600 text-neutral-600" />
            ) : null}
            <button
              type="button"
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                void closeTab(session.id);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-neutral-500 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
