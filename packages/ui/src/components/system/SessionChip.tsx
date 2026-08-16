import React from "react";
import { Terminal } from "lucide-react";
import { cn } from "../../lib/cn";
import { jumpToProject } from "../../lib/session-nav";
import { useAppStore } from "../../store/app";
import { resolveSessionOwner } from "./session-owner";

/**
 * "This pid belongs to <tab>" chip, clickable straight through to that tab.
 *
 * Renders nothing when the session is unknown to this client or lives behind the
 * archived-data curtain — see {@link resolveSessionOwner}.
 */
export const SessionChip: React.FC<{ sessionId: string; className?: string }> = ({ sessionId, className }) => {
  const sessions = useAppStore((s) => s.sessions);
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const owner = resolveSessionOwner(sessionId, sessions, workspaces, projects);
  if (!owner) {
    return null;
  }
  const { title, project } = owner;

  return (
    <button
      type="button"
      title={`Go to ${title} · ${project.workspace ? `${project.workspace}/` : ""}${project.name}`}
      onClick={() => {
        // The chip is reachable from inside the Settings modal; leaving it open
        // over the tab we just navigated to would hide the destination.
        setSettingsOpen(false);
        jumpToProject({ project, sessionId });
      }}
      className={cn(
        "inline-flex max-w-[10rem] items-center gap-1 rounded bg-neutral-800/80 px-1.5 py-0.5",
        "text-[10px] text-neutral-300 transition-colors hover:bg-neutral-700 hover:text-neutral-100",
        className
      )}
    >
      <Terminal size={10} className="shrink-0 text-neutral-500" />
      <span className="truncate">{title}</span>
    </button>
  );
};
