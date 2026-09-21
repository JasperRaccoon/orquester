/**
 * The label a timeline spawn row shows for a batch of agents (§7.6).
 *
 * The implementation lives in W11's `lib/agent-chat/roster.logic.ts`, beside
 * the rest of the roster selectors, and this module is the path the timeline
 * imports it by — one function, one behaviour, two surfaces.
 *
 * Why it is a *selector* and not a stored field: the spawn row keeps only ids —
 * the batch's `workflowId` and its member task ids — and resolves its label,
 * live flag and member list **from the roster model at render time**, because a
 * persisted count goes stale the moment a member finishes. The rule that falls
 * out of that: **a missing agent is never read as completed.** If the row names
 * five members and the roster knows three, the summary says "Status
 * unavailable" rather than claiming success it cannot see.
 *
 * *T3: `apps/web/src/components/chat/agentSpawnSummary.ts:8-64`;
 * `session-logic.ts:85-94`; `MessagesTimeline.tsx:4594-4664`.*
 */

export {
  deriveAgentSpawnSummary,
  resolveSpawnRowAgents,
  type AgentSpawnSummary
} from "../../../lib/agent-chat/roster.logic";

/** The tone a spawn row paints with — `AgentSpawnSummary["tone"]`, named. */
export type AgentSpawnTone = "working" | "failed" | "completed" | "inactive";
