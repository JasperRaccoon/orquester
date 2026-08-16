import React from "react";
import { MessagesSquare, Plus } from "lucide-react";
import type { AgentConversationSummary, RegistryEntry } from "@orquester/api";
import { canResumeAgent } from "@orquester/registry";
import { getRegistryIcon } from "../../icons";
import { useRegistry } from "../../hooks";
import { useAppStore } from "../../store/app";
import { launchWithNotice } from "../../lib/launch-notice";
import { relativeTime } from "../../lib/relative-time";
import { isResumableConversation, resumeAccountId } from "../../lib/resume-account";

const SkeletonRow: React.FC = () => (
  <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
    <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-neutral-800/70" />
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="h-3 w-2/5 animate-pulse rounded bg-neutral-800/70" />
      <div className="h-2.5 w-1/5 animate-pulse rounded bg-neutral-800/50" />
    </div>
  </div>
);

/**
 * Shown instead of a bare "no tabs open" message when a project has none: the
 * past agent conversations for this project, newest first, one click from
 * resuming — plus a quick-start row for the installed agents.
 *
 * The scan is server-side and slow-ish (~1s on a busy project), so it goes
 * through the store's per-project cache; a missing cache entry (not an empty
 * array) is what "still loading" means here.
 */
export const ProjectOverview: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const registry = useRegistry();
  const loadAgentConversations = useAppStore((s) => s.loadAgentConversations);
  const cached = useAppStore((s) => s.agentConversationsByProject[projectPath]);
  const openTab = useAppStore((s) => s.openTab);
  const preferredAccountByAgent = useAppStore((s) => s.preferredAccountByAgent);

  React.useEffect(() => {
    void loadAgentConversations(projectPath);
  }, [projectPath, loadAgentConversations]);

  const agents = registry.agents;
  const quickStart = agents.filter((a) => a.enabled);

  /**
   * A conversation is offerable only when its agent is installed AND has a
   * resume flag — otherwise the click could only end in the daemon's
   * `RESUME_UNAVAILABLE` (or a launch failure), so it is better never shown.
   * `isResumableConversation` drops the proxy-home rows for the same reason.
   */
  const resumable = React.useMemo(() => {
    const byId = new Map<string, RegistryEntry>(agents.map((a) => [a.id, a]));
    return (cached ?? []).filter((c) => {
      const entry = byId.get(c.agentRefId);
      return Boolean(entry?.enabled) && canResumeAgent(c.agentRefId) && isResumableConversation(c);
    });
  }, [cached, agents]);

  const agentName = (refId: string) => agents.find((a) => a.id === refId)?.name ?? refId;

  const resume = (conversation: AgentConversationSummary) => {
    // Identity matters on a resume: the transcript only exists inside one HOME.
    // Prefer the home the daemon read the row out of; otherwise fall back to the
    // same per-agent account the "+" menu would launch with (a bare launch would
    // take the daemon default instead, which may be a different home).
    launchWithNotice(
      openTab(
        "agent",
        conversation.agentRefId,
        agentName(conversation.agentRefId),
        resumeAccountId(conversation, preferredAccountByAgent[conversation.agentRefId]),
        undefined,
        conversation.id
      ),
      agentName(conversation.agentRefId)
    );
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-2xl flex-col px-6 py-8">
      <div className="mb-3 shrink-0">
        <p className="text-sm font-medium text-neutral-200">Recent conversations</p>
        <p className="mt-0.5 text-xs text-neutral-600">
          Pick one up where you left off, or start something new below.
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {cached === undefined && Array.from({ length: 4 }, (_, i) => <SkeletonRow key={i} />)}

        {cached !== undefined && resumable.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
            <MessagesSquare size={32} strokeWidth={1.25} className="text-neutral-700" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-neutral-300">No conversations yet</p>
              <p className="max-w-sm text-xs text-neutral-600">
                Start one below, or with the &quot;+&quot; button in the top bar.
              </p>
            </div>
          </div>
        )}

        {resumable.map((conversation) => (
          <button
            key={`${conversation.agentRefId}:${conversation.id}`}
            type="button"
            onClick={() => resume(conversation)}
            title={conversation.preview || conversation.title}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-900"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-neutral-900 text-neutral-400">
              {getRegistryIcon("agent", conversation.agentRefId, 15)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-neutral-200">
                {conversation.title}
              </span>
              <span className="block truncate text-[11px] text-neutral-600">
                {agentName(conversation.agentRefId)}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-neutral-600">
              {relativeTime(conversation.updatedAt)}
            </span>
          </button>
        ))}
      </div>

      {quickStart.length > 0 && (
        <div className="mt-4 flex shrink-0 flex-wrap gap-1.5 border-t border-neutral-800 pt-4">
          {quickStart.map((agent) => (
            <button
              key={agent.id}
              type="button"
              // No account/model pin: those are the "+" menu's chips. A bare
              // launch takes the daemon's configured defaults, which is exactly
              // what "quick start" should mean.
              onClick={() => launchWithNotice(openTab("agent", agent.id, agent.name), agent.name)}
              className="flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-[12px] text-neutral-400 transition-colors hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-200"
            >
              <Plus size={12} />
              {getRegistryIcon("agent", agent.id, 13)}
              {agent.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
