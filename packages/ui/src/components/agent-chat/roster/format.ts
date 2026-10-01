// Ported from T3 Code (MIT): apps/web/src/components/AgentsPanel.tsx:120-190
// and packages/client-runtime/src/state/subagentRuntime.ts:869-892

/** Shared text formatting for roster rows, workflow summaries and drill-in headers. */

import type { RuntimeSubagent } from "@orquester/api/agent-chat";
import {
  agentActivityText as activityTextFor,
  isLoopOrGoalRow
} from "../../../lib/agent-chat/roster.logic";

/** The row's kind, where a caller has it: a loop and a goal present as themselves. */
type MaybeKind = { kind?: RuntimeSubagent["kind"] };

/** Strip provider/version suffixes from the model label and append effort when known. */
export function formatSubagentModelLabel(
  model: string | null | undefined,
  effort: string | null | undefined
): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}

/** Roster counts use a coarser scale than the context meter: exact below 1,000, then k and M. */
export function formatSubagentTokenCount(totalTokens: number | null | undefined): string {
  const value = typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : 0;
  if (value < 1000) return `${Math.max(0, Math.round(value))}`;
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Add a tool marker only when the selected activity text is a tool name. */
export function agentActivityText(
  agent: Pick<
    RuntimeSubagent,
    "agentKind" | "status" | "progress" | "lastToolName" | "result" | "error" | "exitCode" | "leftRunning"
  > &
    MaybeKind
): string | null {
  const text = activityTextFor(agent as RuntimeSubagent);
  if (text === null) return null;
  // Shells, loops and goals do not run tools themselves.
  if (agent.agentKind === "background" || isLoopOrGoalRow(agent)) return text;
  const tool = agent.lastToolName?.trim();
  return tool !== undefined && tool.length > 0 && text === tool ? `▸ ${text}` : text;
}

/** Workflow retries use provider attempts; other rows use activation counts. Hide the first run. */
function runMarker(agent: Pick<RuntimeSubagent, "activationCount"> & { attempt?: number | null }): string[] {
  if (typeof agent.attempt === "number") return agent.attempt > 1 ? [`attempt ${agent.attempt}`] : [];
  return agent.activationCount > 1 ? [`run ${agent.activationCount}`] : [];
}

/** Keep the token slot visible as "— tok" until usage arrives, so the row does not shift. */
export function rosterRowMetrics(
  agent: Pick<
    RuntimeSubagent,
    "agentKind" | "model" | "effort" | "usage" | "activationCount" | "exitCode"
  > &
    MaybeKind & { attempt?: number | null }
): string[] {
  const run = runMarker(agent);
  // Goals report aggregate usage; a loop's fires account for usage on their own rows.
  if (agent.kind === "loop") return ["scheduled prompt", ...run];
  if (agent.kind === "goal") {
    return [
      "goal",
      agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
      ...run
    ];
  }
  // Shells have an exit code instead of model or token usage.
  if (agent.agentKind === "background") {
    return typeof agent.exitCode === "number"
      ? ["background shell", `exit ${agent.exitCode}`]
      : ["background shell"];
  }
  const parts: string[] = [];
  const model = formatSubagentModelLabel(agent.model, agent.effort);
  if (model) parts.push(model);
  parts.push(agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok");
  if (agent.usage?.toolUses !== undefined) parts.push(`${agent.usage.toolUses} tools`);
  parts.push(...run);
  return parts;
}

/** Shells, loops and goals show their kind; agent roles matching the title are suppressed. */
export function rosterRoleChip(
  agent: Pick<RuntimeSubagent, "agentKind" | "title" | "role"> &
    MaybeKind & { phaseTitle?: string | null }
): string | null {
  if (agent.kind === "loop") return "loop";
  if (agent.kind === "goal") return "goal";
  if (agent.agentKind === "background") return "shell";
  const role = agent.role?.trim() || (agent.kind === "workflow_agent" ? agent.phaseTitle?.trim() : undefined);
  if (!role) return null;
  return role.toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase() ? null : role;
}
