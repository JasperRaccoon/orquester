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
  TASK_STOP_FAILED_ACTIVITY_KIND,
  TERMINAL_SUBAGENT_STATUSES,
  taskStopRefusal,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type ThreadItem
} from "@orquester/api/agent-chat";

export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
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
 * is not a state a shell can be in — it either runs or it does not. The one
 * summary a stopped shell shows is the adapter's own, marked
 * `leftRunning` (Grok's "Left running when the agent host stopped — stop it
 * from Settings → Host status."): never the provider's.
 */
function backgroundShellActivityText(
  shell: Pick<RuntimeSubagent, "status" | "progress" | "exitCode"> & {
    result?: string | null;
    leftRunning?: boolean;
  }
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
    case "interrupted": {
      // A stop the adapter wrote at an end that left the process running — a
      // deploy, a restart, a crash (Grok) — says so and where to stop it: a
      // bare "Stopped" read as done for a dev server that runs on. Only that
      // note, by its marker: any other summary — the CLI's stop sentence, its
      // output's first or last line — is the provider's, and says nothing
      // about the row.
      const said = shell.leftRunning === true ? shell.result?.trim() : undefined;
      return said !== undefined && said.length > 0 ? said : "Stopped";
    }
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
 * A row that DRIVES work rather than doing it (§7.6): a provider's scheduled
 * prompt (`loop`, a Grok `/loop`) or its autonomous goal (`goal`, a Grok
 * `/goal`). Background, but never a shell: it prints nothing and exits with no
 * code, and its fires, turns and agents — the work — are rows of their own.
 */
export function isLoopOrGoalRow(agent: { kind?: RuntimeSubagent["kind"] }): boolean {
  return agent.kind === "loop" || agent.kind === "goal";
}

/**
 * A shell row — a command the agent ran in the background, listed in the same
 * roster (§7.6, the deliberate difference from T3).
 *
 * Deliberately **status-blind**, unlike the roster's live-background test: the
 * exemption from the collapse is about a row that outlives its turn, while
 * this is about what the row *is*. A finished shell is still a shell, and it
 * must keep the terminal glyph, the "shell" chip and its exit code while it
 * fades. A loop and a goal are background too, and never shells: they print
 * nothing and exit with no code ({@link isLoopOrGoalRow}). Here rather than
 * beside the roster's rows because the drill-in's projection asks it too: a
 * shell's drill-in is one row, projected apart (`roster/background-shell.ts`).
 */
export function isBackgroundShellRow(
  agent: Pick<RuntimeSubagent, "agentKind"> & { kind?: RuntimeSubagent["kind"] }
): boolean {
  return agent.agentKind === "background" && !isLoopOrGoalRow(agent);
}

/** A task's own rows: its start, its progress and patches, its end. */
const TASK_ROW_KINDS: ReadonlySet<string> = new Set([
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed"
]);

/**
 * Whether `agentId` is a background shell by the thread's items alone — for a
 * drill-in whose agent has no roster row at all (the roster keeps 100 rows and
 * evicts the oldest settled ones first; final review C, M2): a Claude shell's
 * own command item (`bgshell:<agentId>`, the call the adapter gives a surfaced
 * shell — its start, or any chunk retention left), or task rows naming it
 * that the roster folds to a shell's row: none of them names it an `agent`
 * (the roster's rule: one such row promotes it), and none names a loop's or a
 * goal's task type ({@link isLoopOrGoalRow}). A walk of the window, so the
 * drill-in asks it only while it has no row to read.
 */
export function isBackgroundShellItems(items: readonly ThreadItem[], agentId: string): boolean {
  const shellCall = `bgshell:${agentId}`;
  let taskRows = false;
  for (const item of items) {
    if (item.kind !== "activity") {
      continue;
    }
    const payload =
      item.payload !== null && typeof item.payload === "object" && !Array.isArray(item.payload)
        ? (item.payload as Record<string, unknown>)
        : null;
    if (payload === null) {
      continue;
    }
    if (payload.toolUseId === shellCall) {
      return true;
    }
    if (!TASK_ROW_KINDS.has(item.activityKind) || payload.taskId !== agentId) {
      continue;
    }
    if (payload.agentKind === "agent" || payload.taskType === "scheduled" || payload.taskType === "goal") {
      return false;
    }
    taskRows = true;
  }
  return taskRows;
}

/**
 * A loop's or a goal's second line (§7.6). While live, what it last did — a
 * loop's latest fire, a goal's phase — else that it stands: a loop between its
 * fires is `Scheduled`, not working; a goal is `Active`. Once over, how it
 * ended, in the provider's words ("Token budget reached: 48386 of 20000
 * tokens", "Deleted") — a shell's bare "Stopped" hid exactly that — and the
 * state word only when there are none.
 */
function loopOrGoalActivityText(
  row: Pick<RuntimeSubagent, "kind" | "status" | "progress" | "result" | "error">
): string {
  const first = (values: ReadonlyArray<string | null>): string | undefined => {
    for (const value of values) {
      const text = value?.trim();
      if (text !== undefined && text.length > 0) return text;
    }
    return undefined;
  };
  if (isActiveSubagentStatus(row.status)) {
    return first([row.progress]) ?? (row.kind === "loop" ? "Scheduled" : "Active");
  }
  const said = first([row.error, row.result, row.progress]);
  if (said !== undefined) return said;
  switch (row.status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "idle":
      return "Idle";
    default:
      return "Stopped";
  }
}

/**
 * The row's second line: prefer live `progress`, then the last tool, then
 * result/error **while live**, and reverse that order once settled — unless
 * the row is a loop or a goal, or a background shell, which have lines of
 * their own above.
 *
 * *T3: `AgentsPanel.tsx:120-137`.*
 */
export function agentActivityText(agent: RuntimeSubagent): string | null {
  if (isLoopOrGoalRow(agent)) {
    return loopOrGoalActivityText(agent);
  }
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

/**
 * Resolve a spawn row's ids against the live roster, at render time: its
 * agents in roster order, its workflow's coordinator apart, and how many
 * agents it launched.
 *
 * The coordinator is never one of the agents — it is their container, and
 * counting it read "Kicked off 4 subagents · 1 working" for three members
 * between phases. A workflow's agents are the rows naming it their parent as
 * well as the ids the timeline saw: members come and go by progress snapshot
 * and never need a timeline row of their own. `agentCount` never drops below
 * the ids seen, so a member the roster's cap evicted still counts.
 */
export function resolveSpawnRowAgents(
  roster: readonly RuntimeSubagent[],
  spawn: { workflowId: string | null; agentTaskIds: readonly string[] }
): { agents: RuntimeSubagent[]; coordinator: RuntimeSubagent | null; agentCount: number } {
  const { workflowId } = spawn;
  const memberIds = new Set(spawn.agentTaskIds.filter((taskId) => taskId !== workflowId));
  let coordinator: RuntimeSubagent | null = null;
  const agents: RuntimeSubagent[] = [];
  for (const agent of roster) {
    if (workflowId !== null && agent.id === workflowId) {
      coordinator = agent;
    } else if (memberIds.has(agent.id) || (workflowId !== null && agent.parentAgentId === workflowId)) {
      agents.push(agent);
    }
  }
  return { agents, coordinator, agentCount: Math.max(agents.length, memberIds.size) };
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

const ROSTER_VISIBLE_ROWS = 5;

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

/**
 * The `working` banner's title, kind-aware like the roster's count line: a
 * background shell is not an agent, so "9 agents working" for eight subagents
 * and one shell was a lie about what the user had running (owner report,
 * 2026-09-28). "N agents working" alone, "N agents and M shells running"
 * together, "M shells running" alone, "Background work" when nothing is named.
 */
export function workingLivenessTitle(liveAgentCount: number, liveShellCount = 0): string {
  const agents = Math.max(0, liveAgentCount);
  const shells = Math.max(0, liveShellCount);
  const agentLabel = `${agents} ${agents === 1 ? "agent" : "agents"}`;
  const shellLabel = `${shells} ${shells === 1 ? "shell" : "shells"}`;
  if (agents > 0 && shells > 0) return `${agentLabel} and ${shellLabel} running`;
  if (agents > 0) return `${agentLabel} working`;
  if (shells > 0) return `${shellLabel} running`;
  return "Background work";
}

// ---------------------------------------------------------------------------
// Per-task Stop (`/task/stop`)
// ---------------------------------------------------------------------------

/** What a roster row's own Stop shows: nothing, a Stop, or "Stopping…". */
export type TaskStopControl = "hidden" | "ready" | "stopping";

/**
 * A row's own Stop: offered only where the provider can stop one task
 * (`supportsTaskStop`) and the host would take this one — the shared
 * `taskStopRefusal`, so a workflow's member, a settled row or a loop never
 * shows a button the host would refuse. "Stopping…" from the click until the
 * row settles ({@link pendingTaskStops}), not until the command returns: an
 * accepted stop is not yet a stopped task.
 */
export function taskStopControl(
  agents: readonly RuntimeSubagent[],
  taskId: string,
  input: { canStopTasks: boolean; stoppingTaskIds: readonly string[] }
): TaskStopControl {
  if (!input.canStopTasks || taskStopRefusal(agents, taskId) !== null) return "hidden";
  return input.stoppingTaskIds.includes(taskId) ? "stopping" : "ready";
}

/**
 * The stops still in flight after a frame: a task stays "Stopping…" while its
 * row is still at work, and is let go once it settles, leaves the roster, or
 * the provider failed its stop (`failedTaskId`, from a
 * {@link TASK_STOP_FAILED_ACTIVITY_KIND} row) — so the button offers the stop
 * again. Returns `stopping` itself when nothing changed.
 */
export function pendingTaskStops(
  stopping: readonly string[],
  agents: readonly RuntimeSubagent[],
  failedTaskId: string | null = null
): readonly string[] {
  if (stopping.length === 0) return stopping;
  const still = stopping.filter(
    (id) =>
      id !== failedTaskId &&
      agents.some((agent) => agent.id === id && ACTIVE_SUBAGENT_STATUSES.has(agent.status))
  );
  return still.length === stopping.length ? stopping : still;
}

/** The task a {@link TASK_STOP_FAILED_ACTIVITY_KIND} row names, or null for any other item. */
export function failedTaskStopId(item: ThreadItem): string | null {
  if (item.kind !== "activity" || item.activityKind !== TASK_STOP_FAILED_ACTIVITY_KIND) return null;
  const payload = item.payload;
  const target =
    typeof payload === "object" && payload !== null
      ? (payload as { targetTaskId?: unknown }).targetTaskId
      : undefined;
  return typeof target === "string" && target.length > 0 ? target : null;
}
