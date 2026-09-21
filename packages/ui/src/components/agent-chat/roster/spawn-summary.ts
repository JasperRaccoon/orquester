// Ported from T3 Code (MIT): apps/web/src/components/chat/agentSpawnSummary.ts:8-64

/**
 * The label a timeline spawn row shows for a batch of agents (§7.6).
 *
 * It lives beside the roster, not in the timeline, because it must be derived
 * **from the roster model at render time**: the spawn row stores only ids —
 * the batch's `workflowId` and its member task ids — and persisting a count in
 * the row would go stale the moment a member finishes.
 * *T3: `session-logic.ts:85-94`; `MessagesTimeline.tsx:4594-4664` re-resolves
 * against the panel model on every render.*
 *
 * The one rule worth stating out loud: **a missing agent is never read as
 * completed.** If the row names five members and the roster only knows three,
 * the summary says "Status unavailable" rather than claiming success it cannot
 * see — the members may have aged out of activity retention, or the host may
 * have restarted mid-run.
 */

import {
  ACTIVE_SUBAGENT_STATUSES,
  TERMINAL_SUBAGENT_STATUSES,
  type RuntimeSubagent,
  type RuntimeSubagentStatus
} from "@orquester/api/agent-chat";

export type AgentSpawnTone = "working" | "failed" | "completed" | "inactive";

export interface AgentSpawnSummary {
  /** The batch is still going: the row's label shimmers. */
  live: boolean;
  /** "Kicked off 3 subagents" while live, "Ran 3 subagents" once settled. */
  lead: string;
  /** "2 working" / "1 failed" / "✓ completed" / "Status unavailable". */
  status: string;
  tone: AgentSpawnTone;
}

export function deriveAgentSpawnSummary(input: {
  /** The roster rows that could be resolved for this batch. */
  agents: readonly Pick<RuntimeSubagent, "kind" | "status">[];
  /** How many members the row was stamped with. */
  agentCount: number;
  /** A workflow coordinator keeps running between dynamic member launches. */
  coordinatorStatus?: RuntimeSubagentStatus;
}): AgentSpawnSummary {
  const { agents, agentCount, coordinatorStatus } = input;
  const working = agents.filter((agent) => ACTIVE_SUBAGENT_STATUSES.has(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted"
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;

  const live =
    coordinatorStatus !== undefined
      ? !TERMINAL_SUBAGENT_STATUSES.has(coordinatorStatus)
      : working > 0;

  const subjects = [
    individuals > 0 ? `${individuals} subagent${individuals === 1 ? "" : "s"}` : null,
    batches > 0
      ? `${batches} ${individuals > 0 ? "" : "subagent "}batch${batches === 1 ? "" : "es"}`
      : null
  ]
    .filter((part): part is string => part !== null)
    .join(" and ");
  const lead = `${batches > 0 ? "Launched" : live ? "Kicked off" : "Ran"} ${subjects || "subagents"}`;

  const status = live
    ? working > 0
      ? `${working} working`
      : "working"
    : coordinatorStatus === "failed"
      ? "Workflow failed"
      : coordinatorStatus === "cancelled" || coordinatorStatus === "interrupted"
        ? "Workflow stopped"
        : failed > 0
          ? `${failed} failed`
          : stopped > 0
            ? `${stopped} stopped`
            : idle > 0
              ? `${idle} idle`
              : coordinatorStatus !== "completed" &&
                  (agents.length === 0 || agents.length < agentCount)
                ? "Status unavailable"
                : "✓ completed";

  const tone: AgentSpawnTone = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === "✓ completed"
        ? "completed"
        : "inactive";

  return { live, lead, status, tone };
}
