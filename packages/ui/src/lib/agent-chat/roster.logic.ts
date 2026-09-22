/**
 * Agent chat — roster selectors and the spawn-row summary (spec §7.6).
 *
 * Ported from T3 Code (MIT):
 * `apps/web/src/components/chat/agentSpawnSummary.ts`,
 * `apps/web/src/components/AgentsPanel.tsx:120-137` (`agentActivityText`) and
 * `packages/client-runtime/src/state/subagentRuntime.ts` (the status sets).
 *
 * The fold itself is W2's `foldSubagentActivities` in
 * `@orquester/api/agent-chat`; this module is only what the *view* adds:
 * - **the timeline's spawn row stores only ids** and resolves its label, live
 *   flag and member list from the roster model at render time, because a
 *   persisted count goes stale the moment a member finishes;
 * - the dock's collapse-past-five and fade-on-turn-end, with the
 *   **live background row exempt from both** — it outlives the turn that
 *   started it, so it stays on screen until it ends or is stopped;
 * - the drill-in's per-agent filter.
 *
 * No React import.
 */

import {
  ACTIVE_SUBAGENT_STATUSES,
  TERMINAL_SUBAGENT_STATUSES,
  type RuntimeSubagent,
  type RuntimeSubagentStatus
} from "@orquester/api/agent-chat";

export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

/**
 * The three in-flight statuses — `pending`, `running`, `waiting` — all present
 * as **one steady "working" look**, because a queued or waiting subagent is
 * still the fleet doing its job. An **idle but resumable agent reads as settled
 * (muted)**, never as in-motion: a live-coloured idle dot reads as stuck.
 *
 * *T3: `AgentsPanel.tsx:32-49`.*
 */
export type RosterRowLook = "working" | "settled" | "failed" | "stopped";

export function rosterRowLook(status: RuntimeSubagentStatus): RosterRowLook {
  if (isActiveSubagentStatus(status)) {
    return "working";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled" || status === "interrupted") {
    return "stopped";
  }
  return "settled";
}

/**
 * A **background shell's** second line (§7.6).
 *
 * A shell is not a subagent and must not be described like one: the agent
 * precedence below would print the provider's own sentence — `Background
 * command "pnpm test" completed (exit code 0)` — which reads exactly like a
 * subagent's result and is what made a shell row indistinguishable from an
 * agent row. A shell has two facts worth a line: it is running, or it stopped
 * with an exit code.
 *
 * Never `null`: the line always says something, because "nothing reported yet"
 * is not a state a shell can be in — it either runs or it does not.
 */
export function backgroundShellActivityText(
  shell: Pick<RuntimeSubagent, "status" | "progress" | "exitCode">
): string {
  const exit = typeof shell.exitCode === "number" ? shell.exitCode : null;
  switch (shell.status) {
    case "pending":
    case "running":
    case "waiting": {
      // A provider that says what the shell is doing is more specific than the
      // state word, and a shell that was moved to the background mid-run keeps
      // whatever the launching tool had reported.
      const progress = shell.progress?.trim();
      return progress !== undefined && progress.length > 0 ? progress : "Running";
    }
    case "completed":
      return exit === null ? "Exited" : `Exited with code ${exit}`;
    case "failed":
      return exit === null ? "Failed" : `Failed · exit ${exit}`;
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "idle":
      return "Idle";
    default: {
      const exhaustive: never = shell.status;
      void exhaustive;
      return "Running";
    }
  }
}

/**
 * The row's second line: prefer live `progress`, then the last tool, then
 * result/error **while live**, and reverse that order once settled — unless
 * the row is a background shell, which has its own two-fact line above.
 *
 * *T3: `AgentsPanel.tsx:120-137`.*
 */
export function agentActivityText(agent: RuntimeSubagent): string | null {
  if (agent.agentKind === "background") {
    return backgroundShellActivityText(agent);
  }
  const live = isActiveSubagentStatus(agent.status);
  // While live the *result* precedes the error — a child that has already
  // produced something is described by it, and an error on a row that is still
  // running is usually a step that was retried. Once settled the order
  // reverses, because an error is then the outcome.
  // *T3: `AgentsPanel.tsx:120-137` — `progress ?? tool ?? result ?? error`
  // live, `error ?? result ?? progress ?? tool` settled.*
  const candidates = live
    ? [agent.progress, agent.lastToolName, agent.result, agent.error]
    : [agent.error, agent.result, agent.progress, agent.lastToolName];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The spawn row (§7.6)
// ---------------------------------------------------------------------------

export interface AgentSpawnSummary {
  live: boolean;
  lead: string;
  status: string;
  tone: "working" | "failed" | "completed" | "inactive";
}

/**
 * Summarise observed states **without treating idle or missing agents as
 * completed**.
 *
 * *T3: `agentSpawnSummary.ts:8-64`.*
 */
export function deriveAgentSpawnSummary(input: {
  agents: readonly Pick<RuntimeSubagent, "kind" | "status">[];
  agentCount: number;
  coordinatorStatus?: RuntimeSubagentStatus;
}): AgentSpawnSummary {
  const { agents, agentCount, coordinatorStatus } = input;
  const working = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const idle = agents.filter((agent) => agent.status === "idle").length;
  const stopped = agents.filter(
    (agent) => agent.status === "cancelled" || agent.status === "interrupted"
  ).length;
  const batches = agents.filter((agent) => agent.kind === "subagent_batch").length;
  const individuals = agentCount - batches;
  // A workflow coordinator can keep running between dynamic member launches.
  const live =
    coordinatorStatus !== undefined ? !isTerminalSubagentStatus(coordinatorStatus) : working > 0;

  const subjects = [
    individuals > 0 ? `${individuals} subagent${individuals === 1 ? "" : "s"}` : null,
    batches > 0
      ? `${batches} ${individuals > 0 ? "" : "subagent "}batch${batches === 1 ? "" : "es"}`
      : null
  ]
    .filter((value): value is string => value !== null)
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
              : coordinatorStatus !== "completed" && (agents.length === 0 || agents.length < agentCount)
                ? "Status unavailable"
                : "✓ completed";
  const tone: AgentSpawnSummary["tone"] = live
    ? "working"
    : failed > 0 || coordinatorStatus === "failed"
      ? "failed"
      : status === "✓ completed"
        ? "completed"
        : "inactive";
  return { live, lead, status, tone };
}

/** Resolve a spawn row's ids against the live roster, at render time. */
export function resolveSpawnRowAgents(
  roster: readonly RuntimeSubagent[],
  spawn: { workflowId: string | null; agentTaskIds: readonly string[] }
): { agents: RuntimeSubagent[]; coordinator: RuntimeSubagent | null } {
  const byId = new Map(roster.map((agent) => [agent.id, agent]));
  const agents = spawn.agentTaskIds
    .map((taskId) => byId.get(taskId))
    .filter((agent): agent is RuntimeSubagent => agent !== undefined);
  return {
    agents,
    coordinator: spawn.workflowId ? (byId.get(spawn.workflowId) ?? null) : null
  };
}

/** Task ids of every still-live agent — what the live activity row reads. */
export function liveAgentTaskIds(roster: readonly RuntimeSubagent[]): Set<string> {
  return new Set(
    roster.filter((agent) => isActiveSubagentStatus(agent.status)).map((agent) => agent.id)
  );
}

// ---------------------------------------------------------------------------
// The dock (§7.6)
// ---------------------------------------------------------------------------

export const ROSTER_VISIBLE_ROWS = 5;

export interface RosterDockView {
  /** Always rendered, in stable order. */
  visible: RuntimeSubagent[];
  /** Behind "N more". */
  hidden: RuntimeSubagent[];
  /** Live background rows: never collapsed, never faded, never counted (§7.6). */
  pinnedBackground: RuntimeSubagent[];
  hiddenCount: number;
}

/**
 * **Rows past five collapse behind "N more", and finished rows fade and
 * disappear when the turn ends — except a live background row**, which is
 * exempt from both: it is always rendered, it does not count towards the five,
 * and hiding or showing the rest never moves it (§7.6).
 *
 * Order is the fold's, which is `firstSeenAt`: updates and the retention
 * ranking **must never reshuffle rows that remain visible**.
 */
export function deriveRosterDockView(input: {
  roster: readonly RuntimeSubagent[];
  expanded: boolean;
  /** True once the turn settles: finished non-background rows fade out. */
  turnSettled: boolean;
}): RosterDockView {
  const pinnedBackground: RuntimeSubagent[] = [];
  const rest: RuntimeSubagent[] = [];
  for (const agent of input.roster) {
    if (agent.agentKind === "background" && isActiveSubagentStatus(agent.status)) {
      pinnedBackground.push(agent);
      continue;
    }
    if (input.turnSettled && isTerminalSubagentStatus(agent.status)) {
      continue;
    }
    rest.push(agent);
  }
  if (input.expanded || rest.length <= ROSTER_VISIBLE_ROWS) {
    return { visible: rest, hidden: [], pinnedBackground, hiddenCount: 0 };
  }
  const visible = rest.slice(0, ROSTER_VISIBLE_ROWS);
  const hidden = rest.slice(ROSTER_VISIBLE_ROWS);
  return { visible, hidden, pinnedBackground, hiddenCount: hidden.length };
}

// ---------------------------------------------------------------------------
// The liveness banner (§7.6)
// ---------------------------------------------------------------------------

export interface LivenessBannerView {
  visible: boolean;
  title: string;
  /** "Stopping…" holds until `backgroundLiveness` clears, not until the command returns. */
  stopLabel: string;
}

/**
 * While `backgroundLiveness` is non-null and **no turn is working**, a banner
 * sits in the notice stack at activity priority with one **Stop** button.
 * "N agents working" — or "Background work" when the live agent count is zero —
 * for `working`, "Monitoring" for `monitoring`.
 *
 * *T3: `apps/web/src/components/ChatView.tsx:6225-6303`.*
 */
export function deriveLivenessBanner(input: {
  backgroundLiveness: "working" | "monitoring" | null;
  isTurnWorking: boolean;
  liveAgentCount: number;
  stopping: boolean;
}): LivenessBannerView {
  if (input.backgroundLiveness === null || input.isTurnWorking) {
    return { visible: false, title: "", stopLabel: "Stop" };
  }
  const title =
    input.backgroundLiveness === "monitoring"
      ? "Monitoring"
      : input.liveAgentCount > 0
        ? `${input.liveAgentCount} agent${input.liveAgentCount === 1 ? "" : "s"} working`
        : "Background work";
  return { visible: true, title, stopLabel: input.stopping ? "Stopping…" : "Stop" };
}
