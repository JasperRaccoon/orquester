// Automated workflows through the MCP (docs/superpowers/specs/2026-09-28-automated-workflows-design.md §8.3).
//
// Every tool is an in-process client of the daemon's workflow routes (`workflowRoutes`), through DaemonApi only. The
// waits ride the bus (`workflowRun.*` on the "workflows" channel) with a periodic re-read as the safety net, never a
// sleep. Every result is bounded below the 60 000-byte cap by the tool itself and says what it cut.

import { z } from "zod";
import { WORKFLOW_NODE_TYPES, WORKFLOW_SECRET_MAX_VALUE_BYTES, WORKFLOW_SECRET_NAME_PATTERN } from "@orquester/config";
import {
  applyWorkflowPatch,
  isRunActive,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_NAME_PATTERN,
  WORKFLOWS_CHANNEL,
  WorkflowPatchError,
  workflowRoutes,
  type CreateWorkflowRequest,
  type GetWorkflowNodeOutputResponse,
  type GetWorkflowResponse,
  type GetWorkflowRunResponse,
  type ListWorkflowRunsResponse,
  type ListWorkflowSecretsResponse,
  type ListWorkflowsResponse,
  type RunWorkflowResponse,
  type ValidateWorkflowResponse,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowBlockTypeInfo,
  type WorkflowBlockTypesResponse,
  type WorkflowNode,
  type WorkflowPatchOp,
  type WorkflowProblem,
  type WorkflowProject,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowWriteResponse
} from "@orquester/api";
import { projectNamesFor, resolveProject } from "../addressing.ts";
import type { DaemonApi, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, jsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes, wholeUtf8Length } from "../result.ts";
import { defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolDef } from "../tool.ts";
import { WORKFLOW_AUTHORING_GUIDE } from "./workflows-guide.ts";

/** What a workflow tool plans its result to: the cap less room for ok()'s own framing and a few keys added last. */
export const WORKFLOW_RESULT_BUDGET = MAX_RESULT_BYTES - 4_000;
/** Problems listed in a result / an error's detail, and quoted in an error's text. */
const MAX_PROBLEMS = 100;
const MAX_PROBLEMS_IN_MESSAGE = 8;
/** The shortest a definition's long text is cut to before the whole result is left to ok()'s last-resort cut. */
const MIN_FIELD_CHARS = 200;
/** How often a run wait re-reads the run whatever the bus says (the safety net). */
export const RUN_REREAD_MS = 10_000;
/** A block output window read with get_workflow_run {nodeId}. */
const OUTPUT_WINDOW_BYTES = 48_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_HINTS: Record<string, string> = {
  WORKFLOW_NOT_FOUND: " list_workflows shows the workflows and their ids.",
  RUN_NOT_FOUND: " list_workflow_runs shows a workflow's runs.",
  NODE_NOT_FOUND: " get_workflow lists the blocks' ids and names.",
  REVISION_CONFLICT: " The workflow changed since you read it: re-read it with get_workflow (its current revision), then send your ops again.",
  INVALID_WORKFLOW: " Fix the problems listed; list_workflow_block_types shows each block's config.",
  RUN_NOT_ACTIVE: " The run already ended: get_workflow_run shows how.",
  SECRET_INVALID: " A secret name is A-Z, 0-9 and _, starting with a letter; a value is at most 64 KiB."
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Problems from a daemon body, kept only when they have the shape (a route from another build may send anything). */
export function sanitizeProblems(raw: unknown): WorkflowProblem[] {
  if (!Array.isArray(raw)) return [];
  const problems: WorkflowProblem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.code !== "string" || typeof entry.message !== "string") continue;
    const severity = entry.severity === "warning" || entry.severity === "info" ? entry.severity : "error";
    const problem: WorkflowProblem = { severity, code: entry.code, message: clipText(entry.message, 500) };
    if (typeof entry.nodeId === "string") problem.nodeId = entry.nodeId;
    if (typeof entry.edgeId === "string") problem.edgeId = entry.edgeId;
    if (typeof entry.field === "string") problem.field = clipText(entry.field, 200);
    problems.push(problem);
  }
  return problems;
}

const problemLine = (p: WorkflowProblem): string => clipText(`${p.severity} ${p.code}${p.field ? ` (${p.field})` : ""}: ${p.message}`, 300);

/** Errors first, then warnings, then infos — the order a reader fixes them in. */
function sortedProblems(problems: readonly WorkflowProblem[]): WorkflowProblem[] {
  const rank = { error: 0, warning: 1, info: 2 } as const;
  return [...problems].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** A result's problems: sorted, at most MAX_PROBLEMS, with counts. */
export function problemsView(problems: readonly WorkflowProblem[]): { problems: WorkflowProblem[]; errorCount: number; warningCount: number; problemsOmitted?: number } {
  const sorted = sortedProblems(problems);
  const view: { problems: WorkflowProblem[]; errorCount: number; warningCount: number; problemsOmitted?: number } = {
    problems: sorted.slice(0, MAX_PROBLEMS),
    errorCount: sorted.filter((p) => p.severity === "error").length,
    warningCount: sorted.filter((p) => p.severity === "warning").length
  };
  if (sorted.length > MAX_PROBLEMS) view.problemsOmitted = sorted.length - MAX_PROBLEMS;
  return view;
}

function opIndexOf(env: Record<string, unknown>): number | undefined {
  for (const holder of [env, env.detail, env.details]) {
    if (isRecord(holder) && typeof holder.opIndex === "number" && Number.isInteger(holder.opIndex) && holder.opIndex >= 0) return holder.opIndex;
  }
  return undefined;
}

/**
 * A failed workflow route as a ToolError. The workflow envelope `{error: {code, message, problems?}}` passes its code
 * through; its problems go into the text (the part every client shows) and, whole, into `detail.problems`. Anything
 * else falls back to the MCP's generic mapping (daemonError), which never echoes a 5xx body.
 */
export function workflowError(res: DaemonResponse): ToolError {
  const body = isRecord(res.body) ? res.body : null;
  const env = body && isRecord(body.error) ? body.error : null;
  if (!env || typeof env.code !== "string") return daemonError(res);
  const code = env.code;
  const problems = sortedProblems(sanitizeProblems(env.problems));
  let message = typeof env.message === "string" && env.message.trim() !== "" ? env.message.trim() : code;
  if (!/[.!?]$/.test(message)) message += ".";
  message += ERROR_HINTS[code] ?? "";
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_PROBLEMS_IN_MESSAGE).map(problemLine);
    message += ` Problems: ${shown.join("; ")}${problems.length > shown.length ? `; … (${problems.length - shown.length} more in detail.problems)` : ""}.`;
  }
  const detail: Record<string, unknown> = {};
  if (problems.length > 0) Object.assign(detail, problemsView(problems));
  const opIndex = opIndexOf(env);
  if (opIndex !== undefined) detail.opIndex = opIndex;
  return new ToolError(code, message, Object.keys(detail).length > 0 ? detail : undefined);
}

function expectWorkflowOk<T>(res: DaemonResponse): T {
  if (res.status >= 400) throw workflowError(res);
  return res.body as T;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** "ws/project" for an existing project, words for a temp one. */
export function projectLabel(project: WorkflowProject, workspacesDir: string): string {
  if (project.kind === "existing") {
    const names = projectNamesFor(project.projectPath, workspacesDir);
    return names.workspace && names.name ? `${names.workspace}/${names.name}` : project.projectPath;
  }
  const source = project.source.kind === "clone" ? `a clone of ${project.source.url}${project.source.ref ? ` at ${project.source.ref}` : ""}` : "empty";
  return `temporary project in workspace ${project.workspace} (${source})`;
}

export function runSummaryView(r: WorkflowRunSummary): Record<string, unknown> {
  const view: Record<string, unknown> = { runId: r.id, workflowId: r.workflowId, workflowName: r.workflowName, status: r.status };
  if (r.skipReason) view.skipReason = r.skipReason;
  view.trigger = r.trigger.text ?? r.trigger.kind;
  if (r.test) view.test = true;
  view.queuedAt = r.queuedAt;
  if (r.startedAt) view.startedAt = r.startedAt;
  if (r.endedAt) view.endedAt = r.endedAt;
  if (typeof r.durationMs === "number") view.durationMs = r.durationMs;
  if (r.current) view.current = `${r.current.name} (${r.current.index}/${r.current.total})`;
  if (r.error) view.error = clipText(r.error, 500);
  if (r.projectPath) view.projectPath = r.projectPath;
  if (r.tempProject) view.tempProject = r.tempProject;
  if (r.retryOf) view.retryOf = r.retryOf;
  if (r.parentRunId) view.parentRunId = r.parentRunId;
  return view;
}

function workflowSummaryView(w: WorkflowSummary, workspacesDir: string): Record<string, unknown> {
  const view: Record<string, unknown> = { workflowId: w.id, name: w.name };
  if (w.description) view.description = clipText(w.description, 300);
  view.enabled = w.enabled;
  view.revision = w.revision;
  view.project = projectLabel(w.project, workspacesDir);
  if (w.project.kind === "existing") view.projectPath = w.project.projectPath;
  view.triggers = w.triggers.map((t) => clipText(`${t.text}${t.lastError ? ` · error: ${t.lastError}` : ""}`, 300));
  view.nodeCount = w.nodeCount;
  view.errorCount = w.errorCount;
  if (w.lastRun) view.lastRun = { runId: w.lastRun.id, status: w.lastRun.status, ...(w.lastRun.endedAt ? { endedAt: w.lastRun.endedAt } : {}), ...(w.lastRun.error ? { error: clipText(w.lastRun.error, 200) } : {}) };
  view.activeRuns = w.activeRuns.length;
  view.updatedAt = w.updatedAt;
  return view;
}

/** Every edge in block names: "HasTickets (true) → FixTickets" — `(success)` left implicit. */
function connectionsOf(workflow: Pick<Workflow, "nodes" | "edges">): string[] {
  const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
  return workflow.edges.map((e) => `${names.get(e.source) ?? e.source}${e.sourceHandle === "success" ? "" : ` (${e.sourceHandle})`} → ${names.get(e.target) ?? e.target}`);
}

/** A copy of `value` with every string longer than `cap` code points cut (and marked); each cut's path in `cut`. */
function capStrings(value: unknown, cap: number, path: string, cut: string[]): unknown {
  if (typeof value === "string") {
    if (value.length <= cap) return value;
    const clipped = clipText(value, cap);
    if (clipped === value) return value;
    cut.push(path);
    return `${clipped} [truncated]`;
  }
  if (Array.isArray(value)) return value.map((item, i) => capStrings(item, cap, `${path}[${i}]`, cut));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capStrings(v, cap, `${path}.${k}`, cut)]));
  return value;
}

function longestString(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((max, item) => Math.max(max, longestString(item)), 0);
  if (isRecord(value)) return Object.values(value).reduce<number>((max, item) => Math.max(max, longestString(item)), 0);
  return 0;
}

const TRUNCATION_NOTE =
  "Texts listed in truncatedFields were cut to fit the result (they end in \"… [truncated]\"). get_workflow {workflowId, node} shows one block with more room. Never send a cut text back: update_node's set.config replaces only the top-level config keys you send.";

/**
 * Fit `frame(value)` into `budget` bytes by cutting `value`'s long strings to one common length — the longest length
 * that fits, found by bisection — so short texts stay whole and the long ones share the room. The paths cut are named.
 */
function fitLongStrings<T>(value: T, label: string, budget: number, frame: (v: unknown) => Record<string, unknown>): { value: unknown; cut: string[] } {
  if (resultBytes(frame(value)) <= budget) return { value, cut: [] };
  const fits = (cap: number) => resultBytes(frame(capStrings(value, cap, label, []))) <= budget;
  let lo = MIN_FIELD_CHARS;
  let hi = Math.max(MIN_FIELD_CHARS, longestString(value));
  if (!fits(lo)) hi = lo;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const cut: string[] = [];
  return { value: capStrings(value, lo, label, cut), cut };
}

/** The definition as a result shows it: pinned test outputs summarised when large, long texts cut to fit. */
export function definitionView(workflow: Workflow, extra: Record<string, unknown>, budget = WORKFLOW_RESULT_BUDGET): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  let shown: Record<string, unknown> = { ...workflow };
  if (workflow.pinned && resultBytes(workflow.pinned) > 4_096) {
    shown.pinned = Object.fromEntries(Object.entries(workflow.pinned).map(([id, v]) => [id, { pinnedBytes: resultBytes(v) }]));
    flags.pinnedOmitted = true;
  }
  const head = { ...extra, connections: connectionsOf(workflow) };
  const { value, cut } = fitLongStrings(shown, "workflow", budget, (v) => ({ ...head, workflow: v, ...flags, truncatedFields: [], truncationNote: TRUNCATION_NOTE }));
  shown = value as Record<string, unknown>;
  const view: Record<string, unknown> = { ...head, workflow: shown, ...flags };
  if (cut.length > 0) {
    view.truncatedFields = cut.slice(0, 50).map((p) => clipText(p, 120));
    view.truncationNote = TRUNCATION_NOTE;
  }
  return view;
}

// ---------------------------------------------------------------------------
// Run views and output fitting
// ---------------------------------------------------------------------------

interface OutputSlot {
  holder: Record<string, unknown>;
  value: unknown;
  /** The daemon already cut this output (its inline preview). */
  daemonTruncated: boolean;
  /** Where the value goes when it is whole: "output" or "finalOutput". */
  key: string;
}

/**
 * Give each slot as much of the budget as the result has left, smallest first (water-filling): an output that fits its
 * share is kept whole as a value; a larger one becomes the head of its JSON text (`<key>Text`) with `outputTruncated`.
 */
export function fitOutputs(result: Record<string, unknown>, slots: OutputSlot[], budget: number): boolean {
  const present = slots.filter((s) => s.value !== undefined);
  for (const s of present) if (s.daemonTruncated) s.holder.outputTruncated = true;
  let cutAny = false;
  const sizes = present.map((s) => resultBytes(s.value));
  const place = (available: number): void => {
    cutAny = false;
    const order = present.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!);
    let left = Math.max(0, available);
    order.forEach((i, rank) => {
      const s = present[i]!;
      delete s.holder[s.key];
      delete s.holder[`${s.key}Text`];
      const share = Math.floor(left / (order.length - rank));
      if (sizes[i]! <= share) {
        s.holder[s.key] = s.value;
        left -= sizes[i]!;
      } else {
        const text = JSON.stringify(s.value);
        const fitted = fitJsonBytes(text, Math.max(0, share - 40));
        s.holder[`${s.key}Text`] = fitted.text;
        s.holder.outputTruncated = true;
        cutAny = true;
        left -= jsonBytes(fitted.text) + 40;
      }
    });
  };
  for (const s of present) { delete s.holder[s.key]; }
  const base = resultBytes(result) + present.length * 40;
  let available = budget - base;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    place(available);
    const over = resultBytes(result) - budget;
    if (over <= 0) return cutAny || present.some((s) => s.daemonTruncated);
    available -= over + 64;
  }
  for (const s of present) { delete s.holder[s.key]; s.holder[`${s.key}Text`] = ""; s.holder.outputTruncated = true; }
  return true;
}

function blockView(b: WorkflowBlockRun): Record<string, unknown> {
  const view: Record<string, unknown> = { nodeId: b.nodeId, name: b.name, type: b.type, status: b.status, attempt: b.attempt };
  if (b.handle) view.handle = b.handle;
  if (b.startedAt) view.startedAt = b.startedAt;
  if (b.endedAt) view.endedAt = b.endedAt;
  if (b.error) view.error = { kind: b.error.kind, message: clipText(b.error.message, 2_000) };
  if (b.warnings?.length) {
    view.warnings = b.warnings.slice(0, 10).map((w) => clipText(w, 300));
    if (b.warnings.length > 10) view.warningsOmitted = b.warnings.length - 10;
  }
  if (b.activity) view.activity = clipText(b.activity, 200);
  if (b.sessionId) view.sessionId = b.sessionId;
  if (b.hops?.length) {
    view.hops = b.hops.slice(-12).map((h) => ({ agent: h.agent, model: h.model, accountId: h.accountId, ...(h.accountLabel ? { accountLabel: h.accountLabel } : {}), sessionId: h.sessionId, via: h.via, startedAt: h.startedAt, ...(h.endedAt ? { endedAt: h.endedAt } : {}), ...(h.reason ? { reason: h.reason } : {}), ...(h.resetsAt ? { resetsAt: h.resetsAt } : {}) }));
  }
  if (b.selection) {
    const s = b.selection;
    view.selection = {
      reason: clipText(s.reason, 300),
      chosen: s.chosen ? { agent: s.chosen.agent, model: s.chosen.model, accountId: s.chosen.accountId, ...(s.chosen.accountLabel ? { accountLabel: s.chosen.accountLabel } : {}) } : null,
      skipped: s.skipped.slice(0, 10).map((k) => ({ agent: k.agent, account: k.label ?? k.accountId, why: k.why, detail: clipText(k.detail, 120) })),
      ...(s.skipped.length > 10 ? { skippedOmitted: s.skipped.length - 10 } : {}),
      ...(s.earliestResetAt ? { earliestResetAt: s.earliestResetAt } : {})
    };
  }
  if (b.logs) view.logs = b.logs;
  if (b.waitingUntil) view.waitingUntil = b.waitingUntil;
  if (b.childRunId) view.childRunId = b.childRunId;
  if (b.pinned) view.pinned = true;
  return view;
}

/** The run's blocks in the definition's order (triggers first as authored), then any the definition no longer names. */
function orderedBlocks(run: WorkflowRun): WorkflowBlockRun[] {
  const blocks = run.blocks ?? {};
  const seen = new Set<string>();
  const out: WorkflowBlockRun[] = [];
  for (const node of run.definition?.nodes ?? []) {
    const b = blocks[node.id];
    if (b) { out.push(b); seen.add(node.id); }
  }
  for (const [id, b] of Object.entries(blocks)) if (!seen.has(id)) out.push(b);
  return out;
}

const OUTPUT_NOTE = "Outputs marked outputTruncated are cut (outputText is the head of their JSON): read one whole with get_workflow_run {runId, nodeId}.";

/** A whole run: summary, every block with its output fitted to the budget, and the final output. */
export function runView(run: WorkflowRun, opts: { includeOutputs: boolean; extra?: Record<string, unknown> }): Record<string, unknown> {
  const blocks = orderedBlocks(run);
  const views = blocks.map(blockView);
  const result: Record<string, unknown> = { ...(opts.extra ?? {}), run: runSummaryView(run), blocks: views };
  if (!opts.includeOutputs) return result;
  const slots: OutputSlot[] = blocks.map((b, i) => ({ holder: views[i]!, value: b.output, daemonTruncated: b.outputTruncated === true, key: "output" }));
  const runHolder = result.run as Record<string, unknown>;
  slots.push({ holder: runHolder, value: run.finalOutput, daemonTruncated: false, key: "finalOutput" });
  if (fitOutputs(result, slots, WORKFLOW_RESULT_BUDGET)) result.outputNote = OUTPUT_NOTE;
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readWorkflow(api: DaemonApi, workflowId: string): Promise<GetWorkflowResponse> {
  const body = expectWorkflowOk<GetWorkflowResponse>(await api.request("GET", workflowRoutes.workflow(workflowId)));
  return { workflow: body.workflow, problems: sanitizeProblems(body.problems) };
}

async function readRun(api: DaemonApi, runId: string): Promise<WorkflowRun> {
  return expectWorkflowOk<GetWorkflowRunResponse>(await api.request("GET", workflowRoutes.runDetail(runId))).run;
}

/** A block of a run by node id, else by name; NODE_NOT_FOUND names the run's blocks. */
function findBlock(run: WorkflowRun, ref: string): WorkflowBlockRun {
  const blocks = Object.values(run.blocks ?? {});
  const found = run.blocks?.[ref] ?? blocks.find((b) => b.name === ref);
  if (found) return found;
  const names = blocks.map((b) => b.name).slice(0, 40).join(", ");
  throw new ToolError("NODE_NOT_FOUND", `Run ${clipText(run.id, MAX_ECHO_CHARS)} has no block "${clipText(ref, MAX_ECHO_CHARS)}". Its blocks: ${names || "none yet"}.`);
}

/** A node of a definition by id, else by name. */
function findNode(workflow: Workflow, ref: string): WorkflowNode {
  const node = workflow.nodes.find((n) => n.id === ref) ?? workflow.nodes.find((n) => n.name === ref);
  if (node) return node;
  const names = workflow.nodes.map((n) => n.name).slice(0, 60).join(", ");
  throw new ToolError("NODE_NOT_FOUND", `Workflow "${clipText(workflow.name, MAX_ECHO_CHARS)}" has no block "${clipText(ref, MAX_ECHO_CHARS)}". Its blocks: ${names || "none"}.`);
}

/** One window of a JSON text by UTF-8 byte offset, cut on a character boundary and sized to fit a result. */
export function outputWindow(text: string, offset: number, maxBytes = OUTPUT_WINDOW_BYTES): { text: string; offset: number; totalBytes: number; nextOffset?: number } {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.min(Math.max(0, offset), bytes.length);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1; // never start inside a character
  const raw = bytes.subarray(start, Math.min(bytes.length, start + maxBytes));
  let window = raw.subarray(0, wholeUtf8Length(raw)).toString("utf8");
  // Escapes (quotes, control characters) grow a text inside JSON: shrink until the escaped window fits the room.
  window = fitJsonBytes(window, maxBytes).text;
  const end = start + Buffer.byteLength(window, "utf8");
  return { text: window, offset: start, totalBytes: bytes.length, ...(end < bytes.length ? { nextOffset: end } : {}) };
}

// ---------------------------------------------------------------------------
// The run wait
// ---------------------------------------------------------------------------

/**
 * A tap on the bus, opened BEFORE the run is started, so a run that ends before the POST answers is still heard. It
 * records every run the bus says has ended (a `workflowRun.finished`, or an update whose status is no longer active).
 */
export class RunEndTap {
  private readonly ended = new Set<string>();
  private wake: (() => void) | null = null;
  private readonly off: () => void;
  constructor(api: DaemonApi) {
    this.off = api.subscribe((event) => {
      if (event.channel !== WORKFLOWS_CHANNEL) return;
      if (event.type !== "workflowRun.finished" && event.type !== "workflowRun.updated") return;
      const run = isRecord(event.payload) && isRecord(event.payload.run) ? (event.payload.run as unknown as WorkflowRunSummary) : null;
      if (!run || typeof run.id !== "string") return;
      if (event.type === "workflowRun.finished" || (typeof run.status === "string" && !isRunActive(run.status))) {
        this.ended.add(run.id);
        this.notify();
      }
    });
  }
  hasEnded(runId: string): boolean { return this.ended.has(runId); }
  notify(): void { const w = this.wake; this.wake = null; w?.(); }
  /** Resolves on the next end heard, or after `ms` — at once when `ready()` already holds (an end heard mid-read). */
  next(ms: number, signal: AbortSignal, ready: () => boolean = () => false): Promise<void> {
    return new Promise((resolve) => {
      if (ready() || signal.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); this.wake = null; resolve(); };
      const timer = setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }
  close(): void { this.off(); this.notify(); }
}

/**
 * Wait for `runId` to end: woken by the bus, re-reading the run every `rereadMs` whatever the bus says. Resolves with
 * the run as last read and whether it ended; a timeout or an abort resolves `ended: false`. The tap stays the caller's.
 */
export async function waitForRunEnd(api: DaemonApi, tap: RunEndTap, runId: string, opts: { timeoutMs: number; signal: AbortSignal; rereadMs?: number }): Promise<{ run: WorkflowRun | null; ended: boolean }> {
  const rereadMs = opts.rereadMs ?? RUN_REREAD_MS;
  const started = performance.now();
  const remaining = () => opts.timeoutMs - (performance.now() - started);
  let nextRereadAt = started + rereadMs;
  let last: WorkflowRun | null = null;
  const read = async (): Promise<boolean> => {
    const run = await readRun(api, runId);
    last = run;
    return !isRunActive(run.status);
  };
  // A heard end is acted on once: when the read still says active (it raced the write), the schedule decides.
  let heardHandled = false;
  for (;;) {
    if (opts.signal.aborted) return { run: last, ended: false };
    const heard = tap.hasEnded(runId) && !heardHandled;
    if (heard || performance.now() >= nextRereadAt) {
      if (heard) heardHandled = true;
      nextRereadAt = performance.now() + rereadMs;
      if (await read()) return { run: last, ended: true };
    }
    const left = remaining();
    if (left <= 0) {
      // Timed out: one last read, so the answer says where the run is.
      if (!heard) {
        try {
          if (await read()) return { run: last, ended: true };
        } catch { /* keep the last known state */ }
      }
      return { run: last, ended: false };
    }
    await tap.next(Math.min(left, Math.max(0, nextRereadAt - performance.now())), opts.signal, () => tap.hasEnded(runId) && !heardHandled);
  }
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const workflowIdArg = z.string().min(1).describe("The workflow's id (list_workflows).");
const nodeRef = z.string().min(1);
const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const retrySchema = z.object({ maxTries: z.number().int().min(1).max(10), delaySeconds: z.number().min(0).max(3600) }).strict();
const nodeTypeSchema = z.enum(WORKFLOW_NODE_TYPES);
const nodeNameSchema = z.string().regex(WORKFLOW_NODE_NAME_PATTERN, "a block name is a letter, then letters, digits or _ (at most 40)");

const nodeInputSchema = z.object({
  id: z.string().min(1).optional(),
  type: nodeTypeSchema,
  name: nodeNameSchema.optional(),
  config: z.record(z.unknown()).optional(),
  position: positionSchema.optional(),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  retry: retrySchema.optional(),
  timeoutMinutes: z.number().positive().optional(),
  projectOverride: z.string().min(1).optional()
}).strict();
type NodeInput = z.infer<typeof nodeInputSchema>;

const projectArgSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), project: z.string().min(1) }).strict(),
  z.object({
    kind: z.literal("temp"),
    workspace: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("empty") }).strict(),
      z.object({ kind: z.literal("clone"), url: z.string().min(1), ref: z.string().min(1).optional() }).strict()
    ])
  }).strict()
]);
type ProjectArg = z.infer<typeof projectArgSchema>;

const settingsSchema = z.object({
  overlap: z.enum(["skip", "queue", "parallel"]).optional(),
  maxConcurrent: z.number().int().min(1).max(8).optional(),
  timezone: z.string().min(1).optional(),
  runTimeoutMinutes: z.number().positive().optional(),
  notify: z.object({ onFailure: z.boolean().optional(), onSuccess: z.boolean().optional() }).strict().optional(),
  keepFailedTempDays: z.number().int().min(0).max(30).optional()
}).strict();

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: nodeInputSchema }).strict(),
  z.object({ op: z.literal("update_node"), node: nodeRef, set: z.record(z.unknown()) }).strict(),
  z.object({ op: z.literal("remove_node"), node: nodeRef }).strict(),
  z.object({ op: z.literal("rename_node"), node: nodeRef, to: nodeNameSchema }).strict(),
  z.object({ op: z.literal("connect"), source: nodeRef, sourceHandle: z.string().min(1).optional(), target: nodeRef }).strict(),
  z.object({ op: z.literal("disconnect"), edgeId: z.string().min(1).optional(), source: nodeRef.optional(), sourceHandle: z.string().min(1).optional(), target: nodeRef.optional() }).strict(),
  z.object({ op: z.literal("set_settings"), settings: settingsSchema }).strict(),
  z.object({ op: z.literal("set_project"), project: projectArgSchema }).strict(),
  z.object({ op: z.literal("set_enabled"), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal("set_name"), name: z.string().min(1).max(WORKFLOW_LIMITS.maxNameLength), description: z.string().nullable().optional() }).strict(),
  z.object({ op: z.literal("set_pinned"), node: nodeRef, output: z.unknown() }).strict()
]);
type OpArg = z.infer<typeof opSchema>;

/** The daemon's WorkflowProject for an MCP project argument: an existing project resolved exactly as every tool does. */
async function toWorkflowProject(api: DaemonApi, project: ProjectArg): Promise<WorkflowProject> {
  if (project.kind === "existing") return { kind: "existing", projectPath: (await resolveProject(api, project.project)).path };
  return { kind: "temp", workspace: project.workspace, source: project.source };
}

async function toNodeInput(api: DaemonApi, node: NodeInput): Promise<NodeInput> {
  if (node.projectOverride === undefined) return node;
  return { ...node, projectOverride: (await resolveProject(api, node.projectOverride)).path };
}

/** The daemon host's own zone: what a schedule means when the caller names none. */
function hostTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** One block type, as listed: the daemon's info with the fields an author reads. */
function blockTypeView(t: WorkflowBlockTypeInfo, withSchema: boolean): Record<string, unknown> {
  return { type: t.type, category: t.category, title: t.title, description: t.description, handles: t.handles, output: t.output, example: t.example, ...(withSchema ? { configSchema: t.configSchema } : {}) };
}

const listBlockTypes = defineTool({
  name: "list_workflow_block_types",
  title: "List workflow block types",
  description: "Read this before authoring a workflow: every block type (config JSON schema, example, output shape, output handles), the {{ }} expression guide and an authoring guide with a worked example (the Jira fixer). Pass `type` for one block's full schema when the list omits schemas (configSchemasOmitted).",
  input: { type: nodeTypeSchema.optional().describe("Only this block type, with its whole config schema.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const body = expectWorkflowOk<WorkflowBlockTypesResponse>(await api.request("GET", workflowRoutes.blockTypes));
    const types = Array.isArray(body.types) ? body.types : [];
    if (args.type !== undefined) {
      const one = types.find((t) => t.type === args.type);
      if (!one) throw new ToolError("NOT_FOUND", `The daemon lists no block type "${args.type}".`);
      return { types: [blockTypeView(one, true)], expressionGuide: body.expressionGuide };
    }
    const result: Record<string, unknown> = { types: types.map((t) => blockTypeView(t, true)), expressionGuide: body.expressionGuide, authoringGuide: WORKFLOW_AUTHORING_GUIDE };
    // Over budget: drop config schemas, largest first — the examples and the guides stay.
    const omitted: string[] = [];
    const bySize = types.map((t, i) => ({ i, size: resultBytes(t.configSchema ?? null) })).sort((a, b) => b.size - a.size);
    const withNote = () => ({ ...result, configSchemasOmitted: omitted, schemaNote: "Schemas omitted to fit: list_workflow_block_types {type} returns one in full." });
    for (const { i } of bySize) {
      if (resultBytes(omitted.length ? withNote() : result) <= WORKFLOW_RESULT_BUDGET) break;
      const views = result.types as Record<string, unknown>[];
      delete views[i]!.configSchema;
      omitted.push(types[i]!.type);
    }
    return omitted.length ? withNote() : result;
  }
});

const listWorkflows = defineTool({
  name: "list_workflows",
  title: "List automated workflows",
  description: "Automated workflows, all or one project's: id, name, enabled, project, trigger texts, last run, active runs and validation error count. Use the workflowId with get_workflow, update_workflow and run_workflow.",
  input: { project: z.string().optional().describe("Only this project's workflows: an absolute path or \"<workspace>/<project>\".") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const query = args.project !== undefined ? { projectPath: (await resolveProject(api, args.project)).path } : undefined;
    const body = expectWorkflowOk<ListWorkflowsResponse>(await api.request("GET", workflowRoutes.list, query ? { query } : undefined));
    const rows = (body.workflows ?? []).map((w) => workflowSummaryView(w, api.workspacesDir));
    const result: Record<string, unknown> = { workflows: rows };
    let kept = rows.length;
    while (kept > 0 && resultBytes(result) > WORKFLOW_RESULT_BUDGET) {
      kept -= 1;
      result.workflows = rows.slice(0, kept);
      result.truncated = true;
      result.omitted = rows.length - kept;
    }
    if (result.truncated) result.note = "Workflows past the result size cap were left out: pass project to list fewer.";
    return result;
  }
});

const getWorkflow = defineTool({
  name: "get_workflow",
  title: "Get a workflow",
  description: "One workflow's definition (blocks with ids, names and configs; edges; settings), its revision (update_workflow needs it) and its validation problems. `connections` names every edge by block name. Long texts are cut to fit (truncatedFields); `node` reads one block with more room.",
  input: {
    workflowId: workflowIdArg,
    node: z.string().min(1).optional().describe("Only this block (id or name), its long texts cut later.")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const { workflow, problems } = await readWorkflow(api, args.workflowId);
    const head = { workflowId: workflow.id, name: workflow.name, revision: workflow.revision, enabled: workflow.enabled, project: projectLabel(workflow.project, api.workspacesDir) };
    if (args.node !== undefined) {
      const node = findNode(workflow, args.node);
      const own = problems.filter((p) => p.nodeId === node.id);
      const names = new Map(workflow.nodes.map((n) => [n.id, n.name]));
      const edges = workflow.edges.filter((e) => e.source === node.id || e.target === node.id)
        .map((e) => ({ edgeId: e.id, text: `${names.get(e.source) ?? e.source}${e.sourceHandle === "success" ? "" : ` (${e.sourceHandle})`} → ${names.get(e.target) ?? e.target}` }));
      const frame = (v: unknown) => ({ ...head, node: v, connections: edges, ...problemsView(own), truncatedFields: [], truncationNote: TRUNCATION_NOTE });
      const { value, cut } = fitLongStrings(node, "node", WORKFLOW_RESULT_BUDGET, frame);
      const result: Record<string, unknown> = { ...head, node: value, connections: edges, ...problemsView(own) };
      if (cut.length) { result.truncatedFields = cut.slice(0, 50); result.truncationNote = TRUNCATION_NOTE; }
      return result;
    }
    return definitionView(workflow, { ...head, ...problemsView(problems) });
  }
});

/** What a write answers: the definition (fitted), its revision and problems, and what to do next. */
function writeResult(api: DaemonApi, body: WorkflowWriteResponse, verb: "created" | "updated"): Record<string, unknown> {
  const problems = problemsView(sanitizeProblems(body.problems));
  const w = body.workflow;
  const next: string[] = [];
  if (problems.errorCount > 0) next.push("Fix the problems of severity \"error\" with update_workflow (the workflow cannot be enabled until then).");
  if (!w.enabled) next.push("It is disabled: its schedule/git triggers do not fire until update_workflow ops [{\"op\":\"set_enabled\",\"enabled\":true}]; run_workflow runs it now.");
  const extra = { [verb]: true, workflowId: w.id, name: w.name, revision: w.revision, enabled: w.enabled, project: projectLabel(w.project, api.workspacesDir), ...problems, ...(next.length ? { next: next.join(" ") } : {}) };
  return definitionView(w, extra);
}

const createWorkflow = defineTool({
  name: "create_workflow",
  title: "Create a workflow",
  description: "Create an automated workflow from named blocks and edges (call list_workflow_block_types first). Edges and {{ nodes.<Name>.output… }} use block names; positions are optional (auto-layout). Created disabled unless enabled:true. Returns the definition, its revision and validation problems.",
  input: {
    name: z.string().min(1).max(WORKFLOW_LIMITS.maxNameLength).describe("The workflow's name."),
    description: z.string().optional().describe("What it does, in a sentence."),
    project: projectArgSchema.describe("Where it runs: {kind:\"existing\", project:\"<workspace>/<project>\" or an absolute path}, or {kind:\"temp\", workspace, source:{kind:\"empty\"} | {kind:\"clone\", url, ref?}} for a fresh project per run."),
    settings: settingsSchema.optional().describe("overlap (skip|queue|parallel, default skip), maxConcurrent, timezone (IANA; default the daemon host's), runTimeoutMinutes, notify {onFailure, onSuccess}, keepFailedTempDays."),
    nodes: z.array(nodeInputSchema).max(WORKFLOW_LIMITS.maxNodes).describe("Blocks: {type, name?, config?, position?, disabled?, notes?, retry?, timeoutMinutes?, projectOverride?}. config is merged over the type's defaults; a name is minted when omitted."),
    edges: z.array(z.object({ source: nodeRef, sourceHandle: z.string().min(1).optional(), target: nodeRef }).strict()).max(WORKFLOW_LIMITS.maxEdges).default([]).describe("Connections {source, sourceHandle?, target} by block name (or id); sourceHandle defaults to success."),
    enabled: z.boolean().default(false).describe("Enable its triggers at once (refused while it has errors). Default false.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const project = await toWorkflowProject(api, args.project);
    const nodes = await Promise.all(args.nodes.map((n) => toNodeInput(api, n)));
    const request: CreateWorkflowRequest = {
      name: args.name,
      ...(args.description !== undefined ? { description: args.description } : {}),
      enabled: args.enabled,
      project,
      settings: { ...args.settings, timezone: args.settings?.timezone ?? hostTimeZone() } as CreateWorkflowRequest["settings"],
      nodes: nodes as CreateWorkflowRequest["nodes"],
      edges: args.edges,
      // Positions are the canvas's business: lay every block out unless the caller placed some itself.
      autoLayout: !nodes.some((n) => n.position !== undefined)
    };
    const res = await api.request("POST", workflowRoutes.create, { body: request });
    if (res.status >= 400) throw indexedCreateError(workflowError(res), args.nodes.length);
    return writeResult(api, res.body as WorkflowWriteResponse, "created");
  }
});

/** A create refusal naming a failing entry: the daemon's opIndex counts the nodes, then the edges. */
function indexedCreateError(error: ToolError, nodeCount: number): ToolError {
  const detail = isRecord(error.detail) ? error.detail : null;
  const index = detail && typeof detail.opIndex === "number" ? detail.opIndex : undefined;
  if (index === undefined) return error;
  const where = index < nodeCount ? `nodes[${index}]` : `edges[${index - nodeCount}]`;
  return new ToolError(error.code, `${where}: ${error.message}`, { ...detail, entry: where });
}

/**
 * Name the op a refused patch failed on. The daemon's body may carry it (`opIndex`); else, when the refusal is about
 * one op (no whole-workflow problems), the ops are replayed locally on the revision the caller named — the same
 * `applyWorkflowPatch` the daemon runs — to find it. A replay that applies cleanly names nothing.
 */
async function indexedPatchError(api: DaemonApi, workflowId: string, revision: number, ops: WorkflowPatchOp[], error: ToolError): Promise<ToolError> {
  const detail: Record<string, unknown> = isRecord(error.detail) ? { ...error.detail } : {};
  let index = typeof detail.opIndex === "number" ? detail.opIndex : undefined;
  const oneOp = !Array.isArray(detail.problems) || (detail.problems as unknown[]).length === 0;
  if (index === undefined && oneOp && !["REVISION_CONFLICT", "WORKFLOW_NOT_FOUND", "WORKFLOWS_UNAVAILABLE", "INTERNAL", "HOST_UNAVAILABLE"].includes(error.code)) {
    try {
      const res = await api.request("GET", workflowRoutes.workflow(workflowId));
      const current = res.status < 400 ? (res.body as GetWorkflowResponse).workflow : null;
      if (current && current.revision === revision) {
        let n = 0;
        applyWorkflowPatch(current, ops, { mintId: () => `replay-${(n += 1)}`, now: new Date() });
      }
    } catch (replay) {
      if (replay instanceof WorkflowPatchError) index = replay.opIndex;
    }
  }
  if (index === undefined || index < 0 || index >= ops.length) return error;
  const already = new RegExp(`\\bops?\\s*\\[?#?${index}\\b`, "i").test(error.message);
  const message = already ? error.message : `ops[${index}] (${ops[index]!.op}) failed: ${error.message}`;
  return new ToolError(error.code, `${message} Nothing was saved.`, { ...detail, opIndex: index, op: ops[index]!.op });
}

const updateWorkflow = defineTool({
  name: "update_workflow",
  title: "Edit a workflow",
  description: "Edit a workflow with atomic patch ops, in order: add_node, update_node, remove_node, rename_node, connect, disconnect, set_settings, set_project, set_enabled, set_name, set_pinned. Prefer this to recreating it. `revision` must be get_workflow's current one (else REVISION_CONFLICT: re-read). A failing op is named by index; then nothing is saved.",
  input: {
    workflowId: workflowIdArg,
    revision: z.number().int().nonnegative().describe("The revision get_workflow (or the last write) returned."),
    ops: z.array(opSchema).min(1).max(500).describe("Blocks are named by id or name. add_node {node}; update_node {node, set:{name?, config?, disabled?, notes?, retry?, timeoutMinutes?, projectOverride?, position?}} (config merged one level deep, null clears); remove_node {node}; rename_node {node, to} (rewrites references); connect {source, sourceHandle?, target}; disconnect {edgeId} or {source, sourceHandle?, target}; set_settings {settings}; set_project {project}; set_enabled {enabled}; set_name {name, description?}; set_pinned {node, output|null}.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    const ops: WorkflowPatchOp[] = [];
    for (const op of args.ops as OpArg[]) {
      if (op.op === "set_project") ops.push({ op: "set_project", project: await toWorkflowProject(api, op.project) });
      else if (op.op === "add_node") ops.push({ op: "add_node", node: (await toNodeInput(api, op.node)) as Extract<WorkflowPatchOp, { op: "add_node" }>["node"] });
      else if (op.op === "disconnect" && op.edgeId === undefined && (op.source === undefined || op.target === undefined)) {
        throw new ToolError("INVALID_ARGUMENT", `ops[${ops.length}] (disconnect): name the connection by edgeId, or by source and target (sourceHandle optional).`);
      } else ops.push(op as WorkflowPatchOp);
    }
    const res = await api.request("POST", workflowRoutes.patch(args.workflowId), { body: { revision: args.revision, ops } });
    if (res.status >= 400) throw await indexedPatchError(api, args.workflowId, args.revision, ops, workflowError(res));
    return writeResult(api, res.body as WorkflowWriteResponse, "updated");
  }
});

const validateWorkflowTool = defineTool({
  name: "validate_workflow",
  title: "Validate a workflow definition",
  description: "Check a whole definition without saving it (get_workflow's `workflow`, edited): its problems — errors block enabling, warnings do not. create_workflow and update_workflow return problems too; this is for drafts. A missing id, revision or timestamp is filled in.",
  input: { workflow: z.record(z.unknown()).describe("The definition: {name, project:{kind:\"existing\", projectPath}|…, settings?, nodes:[{id, type, name, position, config}], edges:[{id, source, sourceHandle, target}]} — ids, not names, in edges.") },
  annotations: READ_ONLY,
  async run(args, { api, now }) {
    const stamp = new Date(now()).toISOString();
    const workflow = { id: "draft", revision: 0, enabled: false, createdAt: stamp, updatedAt: stamp, ...args.workflow };
    const body = expectWorkflowOk<ValidateWorkflowResponse>(await api.request("POST", workflowRoutes.validate, { body: { workflow } }));
    const view = problemsView(sanitizeProblems(body.problems));
    return { valid: view.errorCount === 0, ...view };
  }
});

const deleteWorkflow = defineTool({
  name: "delete_workflow",
  title: "Delete a workflow",
  description: "Delete a workflow for good: cancels its active runs and deletes its run history and its own secrets. Requires confirm: true. To pause one instead, update_workflow [{op:\"set_enabled\", enabled:false}].",
  input: {
    workflowId: workflowIdArg,
    confirm: z.literal(true).describe("Must be true: deleting cannot be undone.")
  },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    expectWorkflowOk(await api.request("DELETE", workflowRoutes.workflow(args.workflowId)));
    return { deleted: true, workflowId: args.workflowId };
  }
});

const runWorkflow = defineTool({
  name: "run_workflow",
  title: "Run a workflow",
  description: "Start a workflow run now (manual; works while disabled). Returns runId; with wait:true, waits (≤ timeoutSeconds, bus-driven) for the run to end and returns each block's status, error and output (capped). The overlap policy may skip it (skipped: \"overlap\"); force:true runs anyway. Agent blocks can take hours: prefer get_workflow_run later.",
  input: {
    workflowId: workflowIdArg,
    input: z.unknown().optional().describe("JSON handed to the trigger: {{ trigger.input }} in the blocks."),
    wait: z.boolean().default(false).describe("Wait for the run to end (default false)."),
    timeoutSeconds: z.number().int().min(1).max(600).default(300).describe("How long wait:true waits (max 600)."),
    force: z.boolean().default(false).describe("Run even when the overlap policy would skip it.")
  },
  annotations: MUTATING,
  async run(args, { api, signal }) {
    // Tap the bus before starting, so a run that ends before the POST answers is still heard.
    const tap = args.wait ? new RunEndTap(api) : null;
    try {
      const body = { ...(args.input !== undefined ? { input: args.input } : {}), ...(args.force ? { force: true } : {}) };
      const started = expectWorkflowOk<RunWorkflowResponse>(await api.request("POST", workflowRoutes.run(args.workflowId), { body }));
      if (started.runId === null || started.skipped) {
        return { runId: null, skipped: started.skipped ?? "overlap", message: "Not run: a run of this workflow is already active and its overlap policy skipped this one. Pass force:true to run anyway, or wait for the active run (list_workflow_runs)." };
      }
      if (!tap) return { runId: started.runId, status: "started", next: "get_workflow_run {runId} shows its progress; run_workflow with wait:true waits for the end." };
      const { run, ended } = await waitForRunEnd(api, tap, started.runId, { timeoutMs: args.timeoutSeconds * 1_000, signal });
      if (!run) return { runId: started.runId, finished: false, timedOut: true, next: "get_workflow_run {runId} shows its progress." };
      const extra = ended ? { runId: run.id, finished: true } : { runId: run.id, finished: false, timedOut: true, next: "Still running: get_workflow_run {runId} later, or cancel_workflow_run." };
      return runView(run, { includeOutputs: true, extra });
    } finally {
      tap?.close();
    }
  }
});

const listRuns = defineTool({
  name: "list_workflow_runs",
  title: "List a workflow's runs",
  description: "A workflow's runs, newest first: status, trigger, times, error. Page with `before` (the previous result's `before`; null means no more). get_workflow_run shows one run's blocks.",
  input: {
    workflowId: workflowIdArg,
    before: z.string().min(1).optional().describe("The previous result's `before` cursor."),
    limit: z.number().int().min(1).max(50).default(20).describe("Runs per page (max 50).")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const query: Record<string, string> = { limit: String(args.limit) };
    if (args.before !== undefined) query.before = args.before;
    const body = expectWorkflowOk<ListWorkflowRunsResponse>(await api.request("GET", workflowRoutes.runs(args.workflowId), { query }));
    const rows = (body.runs ?? []).map(runSummaryView);
    const result: Record<string, unknown> = { runs: rows, before: body.before ?? null };
    let kept = rows.length;
    while (kept > 0 && resultBytes(result) > WORKFLOW_RESULT_BUDGET) {
      kept -= 1;
      result.runs = rows.slice(0, kept);
      result.truncated = true;
      result.omitted = rows.length - kept;
      result.note = "Runs past the size cap were left out: ask again with a smaller limit.";
    }
    return result;
  }
});

const getRun = defineTool({
  name: "get_workflow_run",
  title: "Get a workflow run",
  description: "One run: its status, and per block the status, handle taken, attempt, error, warnings, agent session, account choice and hops, and output (capped: outputTruncated). `nodeId` reads that one block's whole output, paged by outputOffset (nextOffset).",
  input: {
    runId: z.string().min(1).describe("The run's id (run_workflow, list_workflow_runs)."),
    includeOutputs: z.boolean().default(true).describe("Include block outputs (default true)."),
    nodeId: z.string().min(1).optional().describe("Read this block's whole output (its id or name)."),
    outputOffset: z.number().int().min(0).default(0).describe("With nodeId: the byte offset into the output's JSON text (the previous nextOffset).")
  },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const run = await readRun(api, args.runId);
    if (args.nodeId === undefined) return runView(run, { includeOutputs: args.includeOutputs });
    const block = findBlock(run, args.nodeId);
    const res = await api.request("GET", workflowRoutes.nodeOutput(run.id, block.nodeId));
    const output = expectWorkflowOk<GetWorkflowNodeOutputResponse>(res).output;
    const result: Record<string, unknown> = { run: runSummaryView(run), block: blockView(block) };
    if (output === undefined) return { ...result, output: null, note: "This block has no output." };
    if (args.outputOffset === 0 && resultBytes({ ...result, output }) <= WORKFLOW_RESULT_BUDGET) return { ...result, output };
    const room = Math.min(OUTPUT_WINDOW_BYTES, WORKFLOW_RESULT_BUDGET - resultBytes(result) - 200);
    const window = outputWindow(JSON.stringify(output), args.outputOffset, Math.max(1_000, room));
    return { ...result, outputText: window.text, offset: window.offset, totalBytes: window.totalBytes, ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset, note: "The output's JSON text continues: call again with outputOffset = nextOffset." } : {}) };
  }
});

const cancelRun = defineTool({
  name: "cancel_workflow_run",
  title: "Cancel a workflow run",
  description: "Cancel an active run: running agents are interrupted and processes killed; the run ends cancelled. RUN_NOT_ACTIVE when it already ended.",
  input: { runId: z.string().min(1).describe("The run's id.") },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    expectWorkflowOk(await api.request("POST", workflowRoutes.runCancel(args.runId)));
    const res = await api.request("GET", workflowRoutes.runDetail(args.runId));
    const run = res.status < 400 ? (res.body as GetWorkflowRunResponse).run : null;
    return { cancelRequested: true, runId: args.runId, ...(run ? { run: runSummaryView(run) } : {}) };
  }
});

const listSecrets = defineTool({
  name: "list_workflow_secrets",
  title: "List workflow secret names",
  description: "Workflow secret NAMES, never values: the global ones, plus one workflow's own with workflowId. Blocks read a secret as {{ secrets.NAME }} (HTTP fields, shell env values) or secrets.NAME in code.",
  input: { workflowId: z.string().min(1).optional().describe("Also list this workflow's own secrets.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const query = args.workflowId !== undefined ? { query: { workflowId: args.workflowId } } : undefined;
    const body = expectWorkflowOk<ListWorkflowSecretsResponse>(await api.request("GET", workflowRoutes.secrets, query));
    const secrets = (body.secrets ?? []).map((s) => ({ name: s.name, scope: s.scope, ...(s.workflowId ? { workflowId: s.workflowId } : {}), updatedAt: s.updatedAt, ...(s.short ? { short: true } : {}) }));
    return { secrets };
  }
});

const setSecret = defineTool({
  name: "set_workflow_secret",
  title: "Set a workflow secret",
  description: "Create or replace a workflow secret (write-only; with workflowId it is that workflow's own, else global). WARNING: the value you pass stays in YOUR transcript and tool logs — prefer asking the user to set it in Orquester's UI. Names: A-Z, 0-9 and _, starting with a letter.",
  input: {
    name: z.string().regex(WORKFLOW_SECRET_NAME_PATTERN, "a secret name is A-Z, 0-9 and _, starting with a letter (at most 64)").describe("The secret's name, e.g. JIRA_TOKEN."),
    value: z.string().min(1).refine((v) => Buffer.byteLength(v, "utf8") <= WORKFLOW_SECRET_MAX_VALUE_BYTES, "a secret value is at most 64 KiB").describe("The value (never shown again)."),
    workflowId: z.string().min(1).optional().describe("Scope it to this workflow; omit for a global secret.")
  },
  annotations: MUTATING_IDEMPOTENT,
  async run(args, { api }) {
    const opts = { body: { value: args.value }, ...(args.workflowId !== undefined ? { query: { workflowId: args.workflowId } } : {}) };
    expectWorkflowOk(await api.request("PUT", workflowRoutes.secret(args.name), opts));
    const result: Record<string, unknown> = { set: true, name: args.name, scope: args.workflowId !== undefined ? "workflow" : "global", ...(args.workflowId !== undefined ? { workflowId: args.workflowId } : {}) };
    if (args.value.length < 4) result.warning = "Values under 4 characters are not redacted from stored outputs and logs.";
    return result;
  }
});

export const workflowTools: ToolDef[] = [
  listBlockTypes, listWorkflows, getWorkflow, createWorkflow, updateWorkflow, validateWorkflowTool, deleteWorkflow,
  runWorkflow, listRuns, getRun, cancelRun, listSecrets, setSecret
] as ToolDef[];
