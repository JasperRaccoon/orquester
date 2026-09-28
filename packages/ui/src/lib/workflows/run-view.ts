/**
 * Automated workflows — the run view's words and shapes (workflows spec §7.3,
 * §7.4, §5.4): the vertical timeline of a run's steps, a block's hops and
 * account decision in words, its input, the status vocabulary of blocks and
 * runs, live durations, and the runs list's filter.
 *
 * Pure: every clock is a parameter, nothing reads a store, so the run
 * components and the tests read the same sentences.
 */

import {
  isRunActive,
  isTriggerType,
  topologicalOrder,
  workflowHandleLabel,
  SYSTEM_ACCOUNT_ID,
  WORKFLOW_NODE_CATEGORY,
  type AccountSelectionDecision,
  type AccountSkip,
  type AccountSkipReason,
  type AgentHop,
  type RunWorkflowRequest,
  type WorkflowBlockErrorKind,
  type WorkflowBlockRun,
  type WorkflowBlockStatus,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeCategory,
  type WorkflowNodeType,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowTriggerPayload
} from "@orquester/api";

import { formatDuration, runElapsedMs, runStatusLabel, type RunTone } from "./format";
import { displayOutline } from "./outline-display";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

const pad = (value: number): string => String(value).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * A moment in the viewer's local time, as short as it can be said relative to
 * `now`: "22:40" today, "tomorrow 09:00" / "yesterday 18:02", "Tue 14:45"
 * within the week, else "Oct 3 14:45". "" for no parseable time.
 */
export function formatClock(iso: string | null | undefined, now: number): string {
  const time = parse(iso);
  if (time === null) return "";
  const date = new Date(time);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days === 1) return `tomorrow ${clock}`;
  if (days === -1) return `yesterday ${clock}`;
  if (Math.abs(days) < 7) return `${DAYS[date.getDay()]} ${clock}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`;
}

/**
 * A duration with its seconds while they still matter: "0.4s", "8s",
 * "3m 12s", "1h 4m", "2d 3h" ("" for an unusable value).
 */
export function formatStepDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return ms < 100 ? "<0.1s" : `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  return formatDuration(ms);
}

/** How long a block took — or, still running or waiting, has taken so far. `null` when it never started. */
export function blockElapsedMs(
  block: Pick<WorkflowBlockRun, "status" | "startedAt" | "endedAt"> | null | undefined,
  now: number
): number | null {
  if (!block) return null;
  const start = parse(block.startedAt);
  if (start === null) return null;
  const live = isBlockLive(block.status);
  const end = live ? now : parse(block.endedAt);
  if (end === null) return null;
  return Math.max(0, end - start);
}

/** A block still at work: its duration ticks and its row pulses. */
export function isBlockLive(status: WorkflowBlockStatus): boolean {
  return status === "running" || status === "waiting" || status === "queued";
}

/** Whether anything on screen needs a ticking clock (a live run or block). */
export function runNeedsTicker(
  run: Pick<WorkflowRunSummary, "status"> | null | undefined,
  blocks?: Readonly<Record<string, Pick<WorkflowBlockRun, "status">>> | null
): boolean {
  if (run && isRunActive(run.status)) return true;
  if (!blocks) return false;
  return Object.values(blocks).some((block) => isBlockLive(block.status));
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/** The icon a status draws (the component maps these to lucide icons). */
export type StatusIcon =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "stopped"
  | "interrupted";

export interface StatusView {
  tone: RunTone;
  label: string;
  icon: StatusIcon;
  /** Pulses / spins, and its duration ticks. */
  live: boolean;
}

const BLOCK_STATUS: Record<WorkflowBlockStatus, StatusView> = {
  pending: { tone: "neutral", label: "Pending", icon: "pending", live: false },
  queued: { tone: "info", label: "Queued", icon: "queued", live: true },
  running: { tone: "info", label: "Running", icon: "running", live: true },
  waiting: { tone: "warn", label: "Waiting", icon: "waiting", live: true },
  succeeded: { tone: "ok", label: "Succeeded", icon: "succeeded", live: false },
  failed: { tone: "danger", label: "Failed", icon: "failed", live: false },
  skipped: { tone: "neutral", label: "Skipped", icon: "skipped", live: false },
  cancelled: { tone: "warn", label: "Cancelled", icon: "cancelled", live: false }
};

export function blockStatusView(status: WorkflowBlockStatus): StatusView {
  return BLOCK_STATUS[status] ?? BLOCK_STATUS.pending;
}

const RUN_ICON: Record<WorkflowRunStatus, StatusIcon> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  stopped: "stopped",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  interrupted: "interrupted"
};

const RUN_TONE: Record<WorkflowRunStatus, RunTone> = {
  queued: "info",
  running: "info",
  succeeded: "ok",
  stopped: "ok",
  failed: "danger",
  interrupted: "danger",
  cancelled: "warn",
  skipped: "neutral"
};

/** A run's status as the run view shows it. A Stop block's end is a success here (§3.4). */
export function runStatusView(run: Pick<WorkflowRunSummary, "status" | "skipReason">): StatusView {
  return {
    tone: RUN_TONE[run.status] ?? "neutral",
    label: runStatusLabel(run),
    icon: RUN_ICON[run.status] ?? "pending",
    live: isRunActive(run.status)
  };
}

const BLOCK_TYPE_LABEL: Record<WorkflowNodeType, string> = {
  "trigger.manual": "Manual trigger",
  "trigger.schedule": "Schedule",
  "trigger.git": "Git event",
  agent: "Agent",
  code: "Code",
  shell: "Shell",
  http: "HTTP request",
  if: "If",
  switch: "Switch",
  merge: "Merge",
  stop: "Stop",
  wait: "Wait",
  workflow: "Run workflow",
  note: "Note"
};

/** "Agent", "Shell", "HTTP request", … */
export function blockTypeLabel(type: WorkflowNodeType): string {
  return BLOCK_TYPE_LABEL[type] ?? type;
}

const ERROR_KIND_LABEL: Record<WorkflowBlockErrorKind, string> = {
  all_burnt: "Every account is out of usage",
  agent_error: "Agent error",
  timeout: "Timed out",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  exit_code: "Non-zero exit code",
  exception: "Exception",
  http_status: "HTTP error status",
  network: "Network error",
  expression: "Expression error",
  validation: "Invalid block",
  project_missing: "Project missing",
  child_run_failed: "Sub-workflow failed",
  stopped: "Stopped",
  limit_exceeded: "Limit exceeded",
  internal: "Internal error"
};

export function blockErrorKindLabel(kind: WorkflowBlockErrorKind | string): string {
  return ERROR_KIND_LABEL[kind as WorkflowBlockErrorKind] ?? "Error";
}

// ---------------------------------------------------------------------------
// Outcome in words
// ---------------------------------------------------------------------------

/**
 * One sentence for a run: "Succeeded in 3m", "Failed after 12m — <error>",
 * "Skipped — the previous run was still going", "Running · Step 3/7 · Review · 12m".
 */
export function runOutcomeText(run: WorkflowRunSummary, now: number): string {
  const elapsed = runElapsedMs(run, now);
  const took = elapsed === null ? "" : formatDuration(elapsed);
  const error = run.error?.trim();
  switch (run.status) {
    case "queued":
      return took ? `Queued · ${took}` : "Queued";
    case "running": {
      const current = run.current;
      const parts = ["Running"];
      if (current && current.total > 0) {
        parts.push(`Step ${Math.min(Math.max(current.index, 1), current.total)}/${current.total}`);
        if (current.name) parts.push(current.name);
      }
      if (took) parts.push(took);
      return parts.join(" · ");
    }
    case "succeeded":
      return took ? `Succeeded in ${took}` : "Succeeded";
    case "stopped":
      return took ? `Stopped by a Stop block after ${took}` : "Stopped by a Stop block";
    case "failed": {
      const head = took ? `Failed after ${took}` : "Failed";
      return error ? `${head} — ${error}` : head;
    }
    case "cancelled":
      return took ? `Cancelled after ${took}` : "Cancelled";
    case "interrupted":
      return error ? `Interrupted — ${error}` : "Interrupted — it could not be resumed after a restart";
    case "skipped":
      if (run.skipReason === "overlap") return "Skipped — the previous run was still going";
      if (run.skipReason === "missed") return "Skipped — the daemon was down when it was due";
      return "Skipped";
  }
}

/** Why a skipped run row is muted: its reason in a few words. */
export function runSkipReasonText(run: Pick<WorkflowRunSummary, "status" | "skipReason">): string | null {
  if (run.status !== "skipped") return null;
  if (run.skipReason === "overlap") return "still running";
  if (run.skipReason === "missed") return "missed";
  return "skipped";
}

// ---------------------------------------------------------------------------
// Accounts and hops (§5.2, §5.4)
// ---------------------------------------------------------------------------

/** "claude/jasperclaude"; the daemon user's own login reads "claude/system login". */
export function accountText(agent: string, accountId: string, label?: string): string {
  const who =
    label && label.trim().length > 0
      ? label.trim()
      : accountId === SYSTEM_ACCOUNT_ID || accountId === ""
        ? "system login"
        : accountId;
  return `${agent}/${who}`;
}

/** Why a hop ended, in words: "usage limit (resets 22:40)", "sign-in failed". */
export function hopReasonText(hop: Pick<AgentHop, "reason" | "resetsAt">, now: number): string | null {
  if (!hop.reason) return null;
  const base = hop.reason === "usage_limit" ? "usage limit" : "sign-in failed";
  const resets = formatClock(hop.resetsAt, now);
  return resets ? `${base} (resets ${resets})` : base;
}

/** How the block's latest hop stands, by the block's status. */
function hopEnding(status: WorkflowBlockStatus | undefined, last: AgentHop): string {
  switch (status) {
    case "running":
    case "queued":
      return "working";
    case "waiting":
      return "waiting for a reset";
    case "succeeded":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return last.endedAt ? "finished" : "working";
  }
}

/**
 * The hops in one line:
 * "claude/therealeduard465 → usage limit (resets 22:40) → claude/jasperclaude → finished".
 * "" for no hops.
 */
export function hopsText(
  hops: readonly AgentHop[] | null | undefined,
  options: { status?: WorkflowBlockStatus; now?: number } = {}
): string {
  if (!hops || hops.length === 0) return "";
  const now = options.now ?? Date.now();
  const parts: string[] = [];
  hops.forEach((hop, index) => {
    parts.push(accountText(hop.agent, hop.accountId, hop.accountLabel));
    const last = index === hops.length - 1;
    const reason = hopReasonText(hop, now);
    if (!last) {
      parts.push(reason ?? "moved on");
    } else if (reason && options.status !== "running" && options.status !== "succeeded") {
      parts.push(reason);
    } else {
      parts.push(hopEnding(options.status, hop));
    }
  });
  return parts.join(" → ");
}

/** "2 hops", or "" for a block that never moved accounts. */
export function hopCountText(hops: readonly AgentHop[] | null | undefined): string {
  const moves = Math.max(0, (hops?.length ?? 0) - 1);
  if (moves === 0) return "";
  return moves === 1 ? "1 hop" : `${moves} hops`;
}

const HOP_VIA: Record<AgentHop["via"], string> = {
  initial: "started",
  switched: "switched account",
  handoff: "handed off (new session)",
  resumed: "resumed after reset"
};

export function hopViaText(via: AgentHop["via"]): string {
  return HOP_VIA[via] ?? via;
}

const SKIP_WHY: Record<AccountSkipReason, string> = {
  needsReauth: "needs signing in again",
  notSeeded: "not linked to the model proxy",
  threshold: "over its usage threshold",
  cooldown: "cooling down",
  unknownUsage: "usage unknown",
  catalog: "model not available",
  unavailable: "unavailable"
};

/** Why an account was passed over: "therealeduard465 — over its usage threshold (weekly 90% ≥ 85%)". */
export function skipText(skip: AccountSkip): string {
  const who = accountText(skip.agent, skip.accountId, skip.label);
  const why = SKIP_WHY[skip.why] ?? skip.why;
  const detail = skip.detail.trim();
  return detail ? `${who} — ${why} (${detail})` : `${who} — ${why}`;
}

/** The account decision in one line: "claude/jasperclaude · Opus — soonest weekly reset …". */
export function selectionText(decision: AccountSelectionDecision | null | undefined, now = Date.now()): string {
  if (!decision) return "";
  const reason = decision.reason.trim();
  if (decision.chosen) {
    const chosen = decision.chosen;
    const who = accountText(chosen.agent, chosen.accountId, chosen.accountLabel);
    const head = chosen.model ? `${who} · ${chosen.model}` : who;
    return reason ? `${head} — ${reason}` : head;
  }
  const until = formatClock(decision.earliestResetAt, now);
  const head = "No eligible account";
  const tail = [reason, until ? `earliest reset ${until}` : ""].filter(Boolean).join(" · ");
  return tail ? `${head} — ${tail}` : head;
}

/** The live line of an agent block: "Working · 12m", "Waiting for a reset · until 22:40". */
export function agentLiveLine(block: WorkflowBlockRun, now: number): string | null {
  const elapsed = blockElapsedMs(block, now);
  const took = elapsed === null ? "" : formatDuration(elapsed);
  if (block.status === "running") return took ? `Working · ${took}` : "Working";
  if (block.status === "queued") return "Queued — waiting for a free agent slot";
  if (block.status === "waiting") {
    const until = formatClock(block.waitingUntil, now);
    return until ? `Waiting for a reset · until ${until}` : "Waiting for a reset";
  }
  return null;
}

/** A Wait block: "Waiting until 22:40 · 3h left". */
export function waitLine(block: WorkflowBlockRun, now: number): string | null {
  if (block.status !== "waiting") return null;
  const until = parse(block.waitingUntil);
  if (until === null) return "Waiting";
  const left = until - now;
  const clock = formatClock(block.waitingUntil, now);
  return left > 0 ? `Waiting until ${clock} · ${formatDuration(left)} left` : `Waiting until ${clock}`;
}

// ---------------------------------------------------------------------------
// The timeline (§7.4)
// ---------------------------------------------------------------------------

type TimelineNode = Pick<WorkflowNode, "id" | "type" | "name" | "position"> & {
  config?: unknown;
  disabled?: boolean;
};
type TimelineEdge = Pick<WorkflowEdge, "id" | "source" | "sourceHandle" | "target">;

export interface TimelineWorkflow {
  nodes: readonly TimelineNode[];
  edges: readonly TimelineEdge[];
}

export interface TimelineRunState {
  status?: WorkflowRunStatus;
  blocks: Readonly<Record<string, WorkflowBlockRun>>;
  deadEdges?: readonly string[];
  takenEdges?: readonly string[];
}

export interface TimelineItem {
  /** Unique within the timeline. */
  key: string;
  kind: "step" | "join-ref";
  nodeId: string;
  name: string;
  type: WorkflowNodeType;
  category: WorkflowNodeCategory;
  isTrigger: boolean;
  /** Indentation, as in the Steps outline. */
  depth: number;
  /** The output of the parent this row hangs from, in words ("failure", "true", "case 1 · Big"), when it branches. */
  branchLabel?: string;
  /** 1-based position among executable blocks in topological order (`null` for a cyclic definition). */
  step: number | null;
  total: number;
  status: WorkflowBlockStatus;
  view: StatusView;
  /** Never reached: the run ended before this block had a state. */
  notReached: boolean;
  attempt: number;
  startedAt?: string;
  endedAt?: string;
  durationMs: number | null;
  /** The handle it finished on, in words, when that is worth saying (not plain success). */
  finishedOn?: string;
  hopCount: number;
  hopsSummary: string;
  /** The account the agent works (or worked) on, e.g. "claude/jasperclaude". */
  account?: string;
  error?: string;
  errorKind?: string;
  skippedReason?: string;
  /** The latest activity line of a working agent, or a live wait/queue line. */
  liveLine?: string;
  sessionId?: string;
  childRunId?: string;
  disabled: boolean;
  unreachable: boolean;
  pinned: boolean;
}

function skippedReasonFor(
  node: TimelineNode,
  byId: ReadonlyMap<string, TimelineNode>,
  edges: readonly TimelineEdge[],
  blocks: Readonly<Record<string, WorkflowBlockRun>>
): string {
  if (node.disabled) return "Disabled";
  if (isTriggerType(node.type)) return "Another trigger started this run";
  const incoming = edges.filter((edge) => edge.target === node.id);
  for (const edge of incoming) {
    const source = byId.get(edge.source);
    const block = blocks[edge.source];
    if (!source || !block) continue;
    if (block.handle && block.handle !== edge.sourceHandle) {
      const took = workflowHandleLabel(source, block.handle);
      return `${source.name} went ${took === "success" ? "on success" : `to ${took}`}`;
    }
    if (block.status === "succeeded" && !block.handle && edge.sourceHandle !== "success") {
      return `${source.name} succeeded`;
    }
  }
  if (incoming.length > 0) return "Its branch was not taken";
  return "Not connected to a trigger";
}

/** Why a skipped block did not run, in words ("Review went to failure", "Disabled", …). */
export function blockSkipReason(
  workflow: TimelineWorkflow,
  blocks: Readonly<Record<string, WorkflowBlockRun>>,
  nodeId: string
): string | null {
  const nodes = workflow.nodes.filter((node) => node.type !== "note");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(nodeId);
  if (!node) return null;
  const edges = workflow.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  return skippedReasonFor(node, byId, edges, blocks);
}

/** The handle a block finished on, in words ("failure", "true", "case 1 · Big"). */
export function finishedHandleText(node: TimelineNode | undefined, handle: string | undefined): string | null {
  if (!handle || handle === "success") return null;
  return node ? workflowHandleLabel(node, handle) : handle === "error" ? "failure" : handle;
}

/**
 * The run as a vertical list of steps, in the Steps outline's order (a depth-
 * first walk from the triggers, branches indented under their handle, a join
 * once after its branches) — each with its state, timing, attempt, hops and
 * error. Blocks with no state yet read `pending`; once the run is over they
 * read "not reached".
 */
export function runTimeline(
  run: TimelineRunState,
  workflow: TimelineWorkflow,
  now: number = Date.now()
): TimelineItem[] {
  const nodes = workflow.nodes.filter((node) => node.type !== "note");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = workflow.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const order = topologicalOrder({ nodes, edges });
  const stepOf = new Map((order ?? []).map((id, index) => [id, index + 1]));
  const total = nodes.length;
  const runOver = run.status !== undefined && !isRunActive(run.status);
  const outline = displayOutline({ nodes, edges });

  const items: TimelineItem[] = [];
  for (const entry of outline) {
    const node = byId.get(entry.nodeId);
    if (!node) continue;
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    const branchLabel =
      parent && entry.viaHandle !== undefined && entry.labelled
        ? workflowHandleLabel(parent, entry.viaHandle)
        : entry.failureJoin
          ? "failure"
          : undefined;
    const block = run.blocks[node.id];
    const notReached = block === undefined && runOver;
    const status: WorkflowBlockStatus = block?.status ?? (notReached ? "skipped" : "pending");
    const base = {
      nodeId: node.id,
      name: block?.name || node.name,
      type: node.type,
      category: WORKFLOW_NODE_CATEGORY[node.type] ?? "flow",
      isTrigger: isTriggerType(node.type),
      depth: entry.displayDepth,
      ...(branchLabel !== undefined ? { branchLabel } : {}),
      step: order ? (stepOf.get(node.id) ?? null) : null,
      total
    };
    if (entry.kind === "join-ref") {
      items.push({
        ...base,
        key: entry.key,
        kind: "join-ref",
        status,
        view: blockStatusView(status),
        notReached,
        attempt: block?.attempt ?? 0,
        durationMs: null,
        hopCount: 0,
        hopsSummary: "",
        disabled: node.disabled === true,
        unreachable: entry.unreachable === true,
        pinned: false
      });
      continue;
    }
    const hops = block?.hops ?? [];
    const lastHop = hops.at(-1);
    const chosen = block?.selection?.chosen;
    const account = lastHop
      ? accountText(lastHop.agent, lastHop.accountId, lastHop.accountLabel)
      : chosen
        ? accountText(chosen.agent, chosen.accountId, chosen.accountLabel)
        : undefined;
    let finishedOn: string | undefined;
    if (block?.handle && block.handle !== "success" && (block.status === "succeeded" || block.status === "failed")) {
      finishedOn = workflowHandleLabel(node, block.handle);
    }
    let liveLine: string | undefined;
    if (block) {
      if (block.status === "running" && block.activity?.trim()) liveLine = block.activity.trim();
      else if (block.status === "waiting")
        liveLine = (node.type === "wait" ? waitLine(block, now) : agentLiveLine(block, now)) ?? undefined;
      else if (block.status === "queued") liveLine = node.type === "agent" ? "Waiting for a free agent slot" : "Queued";
    }
    const item: TimelineItem = {
      ...base,
      key: entry.key,
      kind: "step",
      status,
      view: blockStatusView(status),
      notReached,
      attempt: block?.attempt ?? 0,
      durationMs: blockElapsedMs(block, now),
      hopCount: Math.max(0, hops.length - 1),
      hopsSummary: hopsText(hops, { status: block?.status, now }),
      disabled: node.disabled === true,
      unreachable: entry.unreachable === true,
      pinned: block?.pinned === true
    };
    if (block?.startedAt) item.startedAt = block.startedAt;
    if (block?.endedAt) item.endedAt = block.endedAt;
    if (finishedOn !== undefined) item.finishedOn = finishedOn;
    if (account !== undefined && node.type === "agent") item.account = account;
    if (block?.error) {
      item.error = block.error.message;
      item.errorKind = block.error.kind;
    }
    if (status === "skipped") {
      item.skippedReason = notReached ? "Not reached" : skippedReasonFor(node, byId, edges, run.blocks);
    }
    if (liveLine !== undefined) item.liveLine = liveLine;
    if (block?.sessionId) item.sessionId = block.sessionId;
    if (block?.childRunId) item.childRunId = block.childRunId;
    items.push(item);
  }
  return items;
}

/** The step a run view selects first: a failed block, else the running one, else the last one that ran. */
export function defaultSelectedStep(items: readonly TimelineItem[]): string | null {
  const steps = items.filter((item) => item.kind === "step");
  const failed = steps.find((item) => item.status === "failed");
  if (failed) return failed.nodeId;
  const live = steps.find((item) => item.view.live);
  if (live) return live.nodeId;
  const ran = [...steps].reverse().find((item) => item.attempt > 0 || item.startedAt !== undefined);
  return ran?.nodeId ?? steps[0]?.nodeId ?? null;
}

// ---------------------------------------------------------------------------
// A block's input (§3.2)
// ---------------------------------------------------------------------------

export interface BlockInputView {
  /** "trigger" for a trigger block (the event), "single" / "merge" by live inputs, "none" before any arrived. */
  kind: "trigger" | "single" | "merge" | "none";
  value: unknown;
  /** Some upstream output is only a preview. */
  truncated: boolean;
  /** The upstream blocks whose output this is. */
  from: { nodeId: string; name: string }[];
}

/**
 * What a block read as `input`: the output of its single live upstream, or
 * `{[name]: output}` across several (the merge object) — live meaning the
 * source finished and took that edge. A trigger's is the event itself.
 */
export function blockInput(
  run: TimelineRunState & { triggerPayload?: WorkflowTriggerPayload | null },
  workflow: TimelineWorkflow,
  nodeId: string
): BlockInputView {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (node && isTriggerType(node.type)) {
    return { kind: "trigger", value: run.triggerPayload ?? null, truncated: false, from: [] };
  }
  const taken = run.takenEdges ? new Set(run.takenEdges) : null;
  const live = workflow.edges.filter((edge) => {
    if (edge.target !== nodeId) return false;
    if (taken?.has(edge.id)) return true;
    const source = run.blocks[edge.source];
    if (!source) return false;
    if (source.status !== "succeeded" && source.status !== "failed") return false;
    return (source.handle ?? (source.status === "failed" ? "error" : "success")) === edge.sourceHandle;
  });
  const sources: { nodeId: string; name: string; block: WorkflowBlockRun }[] = [];
  for (const edge of live) {
    const block = run.blocks[edge.source];
    if (!block || sources.some((source) => source.nodeId === edge.source)) continue;
    const name = workflow.nodes.find((candidate) => candidate.id === edge.source)?.name ?? block.name;
    sources.push({ nodeId: edge.source, name, block });
  }
  const from = sources.map(({ nodeId: id, name }) => ({ nodeId: id, name }));
  const truncated = sources.some((source) => source.block.outputTruncated === true);
  if (sources.length === 0) return { kind: "none", value: undefined, truncated: false, from };
  if (sources.length === 1) return { kind: "single", value: sources[0]!.block.output, truncated, from };
  const merged: Record<string, unknown> = {};
  for (const source of sources) merged[source.name] = source.block.output;
  return { kind: "merge", value: merged, truncated, from };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Blocks a "Retry from failed block" would start at. */
export function failedBlocksOf(blocks: Readonly<Record<string, WorkflowBlockRun>>): WorkflowBlockRun[] {
  return Object.values(blocks).filter((block) => block.status === "failed" || block.status === "cancelled");
}

export interface RunActionAvailability {
  cancel: boolean;
  retry: boolean;
  retryFromFailed: boolean;
  deleteTempProject: boolean;
}

/** Which run actions make sense now. */
export function runActions(
  run: WorkflowRunSummary,
  blocks: Readonly<Record<string, WorkflowBlockRun>>
): RunActionAvailability {
  const active = isRunActive(run.status);
  const ended = !active;
  const unhappy = run.status === "failed" || run.status === "interrupted" || run.status === "cancelled";
  return {
    cancel: active,
    retry: ended,
    retryFromFailed: ended && unhappy && failedBlocksOf(blocks).length > 0,
    deleteTempProject: ended && run.tempProject !== undefined && !run.tempProject.deleted
  };
}

/**
 * "Retry run": a new run with the same input — a manual (or sub-workflow)
 * run's input again; a schedule or git run re-runs from its trigger with the
 * same event (`retryOf` + `fromNodeId` = the trigger that fired). A test run
 * stays a test run.
 */
export function retryRunRequest(
  run: Pick<WorkflowRunSummary, "id" | "trigger" | "test">,
  triggerPayload: WorkflowTriggerPayload | null | undefined
): RunWorkflowRequest | null {
  const request: RunWorkflowRequest = {};
  if (run.test) request.test = true;
  if (triggerPayload === undefined) {
    // The run is not loaded yet, so its input is unknown: never retry with
    // none. Re-running from its trigger replays the same event/input; with no
    // trigger to name, the caller must wait for the run to load.
    if (!run.trigger.nodeId) return null;
    request.retryOf = run.id;
    request.fromNodeId = run.trigger.nodeId;
    return request;
  }
  if (triggerPayload && (triggerPayload.kind === "manual" || triggerPayload.kind === "subworkflow")) {
    if (triggerPayload.input !== undefined) request.input = triggerPayload.input;
    return request;
  }
  if ((triggerPayload?.kind === "git" || triggerPayload?.kind === "schedule") && run.trigger.nodeId) {
    request.retryOf = run.id;
    request.fromNodeId = run.trigger.nodeId;
  }
  return request;
}

/** "Retry from failed block": reuse this run's succeeded outputs, start at its failed blocks. */
export function retryFromFailedRequest(run: Pick<WorkflowRunSummary, "id" | "test">): RunWorkflowRequest {
  return run.test ? { retryOf: run.id, test: true } : { retryOf: run.id };
}

// ---------------------------------------------------------------------------
// Runs list filter
// ---------------------------------------------------------------------------

export type RunStatusFilter = "all" | "active" | "succeeded" | "failed" | "cancelled" | "skipped";

export const RUN_STATUS_FILTERS: readonly { id: RunStatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Running" },
  { id: "failed", label: "Failed" },
  { id: "succeeded", label: "Succeeded" },
  { id: "cancelled", label: "Cancelled" },
  { id: "skipped", label: "Skipped" }
];

export function runMatchesFilter(run: Pick<WorkflowRunSummary, "status">, filter: RunStatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return isRunActive(run.status);
    case "succeeded":
      return run.status === "succeeded" || run.status === "stopped";
    case "failed":
      return run.status === "failed" || run.status === "interrupted";
    case "cancelled":
      return run.status === "cancelled";
    case "skipped":
      return run.status === "skipped";
  }
}

export function filterRuns<T extends Pick<WorkflowRunSummary, "status">>(
  runs: readonly T[],
  filter: RunStatusFilter
): T[] {
  return runs.filter((run) => runMatchesFilter(run, filter));
}

/** How many loaded runs each filter holds (the chips' counts). */
export function runFilterCounts(runs: readonly Pick<WorkflowRunSummary, "status">[]): Record<RunStatusFilter, number> {
  const counts: Record<RunStatusFilter, number> = {
    all: 0,
    active: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0
  };
  for (const run of runs) {
    for (const { id } of RUN_STATUS_FILTERS) if (runMatchesFilter(run, id)) counts[id] += 1;
  }
  return counts;
}

/**
 * The runs a paged list shows: the store's live first page merged with older
 * pages fetched since, one row per id (the store's copy wins — it is live),
 * newest first.
 */
export function mergeRunPages(
  live: readonly WorkflowRunSummary[],
  older: readonly WorkflowRunSummary[],
  known?: (runId: string) => WorkflowRunSummary | undefined
): WorkflowRunSummary[] {
  const byId = new Map<string, WorkflowRunSummary>();
  for (const run of older) byId.set(run.id, known?.(run.id) ?? run);
  for (const run of live) byId.set(run.id, run);
  const time = (run: WorkflowRunSummary): number => {
    const value = Date.parse(run.startedAt ?? run.queuedAt);
    return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
  };
  return [...byId.values()].sort((a, b) => time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
