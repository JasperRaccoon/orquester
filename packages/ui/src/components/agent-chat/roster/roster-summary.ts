/**
 * The roster's kind-aware counts and labels (spec §7.6).
 *
 * A background shell is listed in the roster on purpose — the deliberate
 * difference from T3, which keeps shells in the work log — so the roster has
 * two kinds of row, and every number it prints must say which kind it
 * counted: "5 agents" for four subagents and one background command was a lie
 * about what the user had running (owner report, 2026-09-22). Pure, so the
 * folded summary, the section caption and the footer cannot drift apart.
 */

import type { AgentPanelWorkflowGroup, RuntimeSubagent } from "@orquester/api/agent-chat";
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus
} from "../../../lib/agent-chat/roster.logic";

type MaybeKind = { kind?: RuntimeSubagent["kind"] };

/** A row's identity and parent, where a caller has them: what tells a workflow's container. */
type MaybeLineage = { id?: string; parentAgentId?: string | null };

export interface RosterKindCounts {
  /**
   * Subagents, workflow members and a workflow with no member rows yet —
   * everything that is not a shell, a loop or a goal. A workflow coordinator
   * WITH members is their container, not an agent: it reports running for the
   * whole run, so counting it read one more agent working than there was
   * (the panel model's rule, `deriveAgentPanelModel`).
   */
  agents: number;
  /** Background commands (`agentKind: "background"`, not a loop or a goal). */
  shells: number;
  /** Scheduled prompts (`kind: "loop"`). */
  loops: number;
  /** Autonomous goals (`kind: "goal"`). */
  goals: number;
  /** Agents in one of the three in-flight statuses. */
  liveAgents: number;
  /** Shells still running. */
  liveShells: number;
}

export function rosterKindCounts(
  rows: readonly (Pick<RuntimeSubagent, "agentKind" | "status"> & MaybeKind & MaybeLineage)[]
): RosterKindCounts {
  const counts: RosterKindCounts = { agents: 0, shells: 0, loops: 0, goals: 0, liveAgents: 0, liveShells: 0 };
  const parents = new Set<string>();
  for (const row of rows) {
    if (row.parentAgentId) parents.add(row.parentAgentId);
  }
  for (const row of rows) {
    if (row.kind === "workflow" && row.id !== undefined && parents.has(row.id)) continue;
    const live = isActiveSubagentStatus(row.status);
    if (row.kind === "loop") {
      counts.loops += 1;
    } else if (row.kind === "goal") {
      counts.goals += 1;
    } else if (row.agentKind === "background") {
      counts.shells += 1;
      if (live) counts.liveShells += 1;
    } else {
      counts.agents += 1;
      if (live) counts.liveAgents += 1;
    }
  }
  return counts;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The roster's count line: `4 agents (2 working) · 1 shell (1 running)`.
 */
export function rosterCountLabels(counts: RosterKindCounts): {
  agents: string | null;
  working: string | null;
  shells: string | null;
  running: string | null;
  /** `1 loop · 1 goal`: neither is an agent or a shell, so neither joins their counts. */
  drivers: string | null;
} {
  const drivers = [
    counts.loops > 0 ? plural(counts.loops, "loop") : null,
    counts.goals > 0 ? plural(counts.goals, "goal") : null
  ].filter((part): part is string => part !== null);
  return {
    agents: counts.agents > 0 ? plural(counts.agents, "agent") : null,
    working: counts.liveAgents > 0 ? `${counts.liveAgents} working` : null,
    shells: counts.shells > 0 ? plural(counts.shells, "shell") : null,
    running: counts.liveShells > 0 ? `${counts.liveShells} running` : null,
    drivers: drivers.length > 0 ? drivers.join(" · ") : null
  };
}

/** What a workflow group's header says of its run. */
interface WorkflowGroupSummary {
  /** Member rows: the agents of the run. Zero until the first one is reported. */
  agents: number;
  settled: number;
  failed: number;
  /**
   * The members' tokens, or the coordinator's own while it has none: its
   * usage aggregates the whole run, so adding it to theirs counted every
   * token twice. *T3: `AgentsPanel.tsx:466-471`.*
   */
  totalTokens: number;
}

export function workflowGroupSummary(group: AgentPanelWorkflowGroup): WorkflowGroupSummary {
  const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
  let settled = 0;
  let failed = 0;
  let totalTokens = members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0;
  for (const member of members) {
    if (isTerminalSubagentStatus(member.status)) settled += 1;
    if (member.status === "failed") failed += 1;
    totalTokens += member.usage?.totalTokens ?? 0;
  }
  return { agents: members.length, settled, failed, totalTokens };
}

export function collapsedRosterLabel(counts: RosterKindCounts): string {
  const labels = rosterCountLabels(counts);
  const parts: string[] = [];
  if (labels.agents) parts.push(labels.agents + (labels.working ? ` (${labels.working})` : ""));
  if (labels.shells) parts.push(labels.shells + (labels.running ? ` (${labels.running})` : ""));
  if (labels.drivers) parts.push(labels.drivers);
  return parts.length > 0 ? parts.join(" · ") : "Agents";
}

/** The caption above the shell rows, and how many of them still run. */
export function shellSectionLabel(counts: RosterKindCounts): { title: string; detail: string | null } {
  return {
    title: counts.shells === 1 ? "Shell" : "Shells",
    detail: counts.liveShells > 0 ? `${counts.liveShells} running` : null
  };
}

/**
 * Split rendered rows by kind. The selection has already put active rows
 * first; this keeps that order within the agent and shell sections. A loop
 * and a goal render with the agents — rows of three lines, chipped as what
 * they are — never under the shells' caption.
 */
export function partitionRosterRows<
  T extends { agent: Pick<RuntimeSubagent, "agentKind"> & MaybeKind }
>(rows: readonly T[]): { agentRows: T[]; shellRows: T[] } {
  const agentRows: T[] = [];
  const shellRows: T[] = [];
  for (const row of rows) {
    const shell =
      row.agent.agentKind === "background" && row.agent.kind !== "loop" && row.agent.kind !== "goal";
    (shell ? shellRows : agentRows).push(row);
  }
  return { agentRows, shellRows };
}
