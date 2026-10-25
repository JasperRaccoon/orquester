// Catalog family module `workflows` (Workflows) — owned by plan Task 10 (unified MCP design
// 2026-10-15 §4 rows 26–37, §4.1 "Workflows", §7, D-22, D-25).
// Automated workflows through the MCP (docs/superpowers/specs/2026-09-28-automated-workflows-design.md §8.3).
//
// Every tool is an in-process client of the daemon's workflow routes (`workflowRoutes`), through DaemonApi only. The
// waits ride the bus (`workflowRun.*` on the "workflows" channel) with a periodic re-read as the safety net, never a
// sleep. Every result is bounded below the 60 000-byte cap by the tool itself and says what it cut.
//
// For chat callers (the executor's gate, `../gate/policy.ts`): reads (`list_workflows`, `get_workflow`,
// `get_workflow_runs`, …) claim the workflow's HOME project; every change — create, update (enable/disable
// included), delete, run, a secret — is Admin and claims the workflow's whole project UNION
// (`./workflow-preview.ts`), so any member other than the caller's own project makes the card ungrantable. The card's
// preview is complete (§7.1) and pins the workflow revision and the shown prompt bodies (§7.2): `run` re-verifies
// them (`PREVIEW_STALE`). `set_workflow_secret` takes no value from a chat caller: the user types it into the card.
// External callers are full trust (no card); their behaviour is the pre-catalog tools' except where §4/§11 changed it.

import { z } from "zod";
import { WORKFLOW_SECRET_MAX_VALUE_BYTES, WORKFLOW_SECRET_NAME_PATTERN } from "@orquester/config";
import {
  applyWorkflowPatch,
  savedPromptIdsOf,
  approvalPreviewBytes,
  TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES,
  createWorkflowFromRequest,
  EXPRESSION_PREVIEW_LIMITS,
  isRunActive,
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_NAME_PATTERN,
  WORKFLOWS_CHANNEL,
  WorkflowPatchError,
  workflowRoutes,
  type ApprovalPreviewSection,
  type CreateWorkflowRequest,
  type GetWorkflowNodeOutputResponse,
  type GetWorkflowResponse,
  type GetWorkflowRunResponse,
  type ListWorkflowRunsResponse,
  type ListWorkflowSecretsResponse,
  type ListWorkflowsResponse,
  type PreviewWorkflowExpressionResponse,
  type RunWorkflowResponse,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowBlockTypeInfo,
  type WorkflowBlockTypesResponse,
  type WorkflowExpressionShape,
  type WorkflowNode,
  type WorkflowPatchOp,
  type WorkflowProblem,
  type WorkflowProject,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowWriteResponse
} from "@orquester/api";
import { basename, join } from "node:path";

import { resolveProject } from "../addressing.ts";
import {
  defineTool,
  DESTRUCTIVE,
  MUTATING,
  MUTATING_IDEMPOTENT,
  READ_ONLY,
  type AnyOrquesterTool,
  type ApprovalPreview,
  type ScopeClaim,
  type ScopeContext
} from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, jsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes, wholeUtf8Length } from "../result.ts";
import {
  agentLabel,
  connectionsOf,
  definitionSections,
  expectWorkflowOk,
  graphDiff,
  homeScope,
  isRecord,
  passedPhrase,
  previewPins,
  problemSections,
  problemsView,
  readWorkflow,
  resolveSavedPrompts,
  sanitizeProblems,
  unionScope,
  unionSections,
  validateDefinition,
  verifyPins,
  workflowError,
  unionGrantable,
  unionGrantFields,
  changesSecretUse,
  SECRET_USE_NOTE,
  callerParts,
  callersPin,
  expectedCallers,
  workflowCallers,
  frozenChildMismatch,
  workflowFields,
  workflowPin,
  workflowProjectLabel,
  workflowUnion,
  type PassedBy,
  type ReferencedPrompt,
  type WorkflowUnion
} from "./workflow-preview.ts";
import { WORKFLOW_AUTHORING_GUIDE } from "./workflows-guide.ts";

/** What a workflow tool plans its result to: the cap less room for ok()'s own framing and a few keys added last. */
const WORKFLOW_RESULT_BUDGET = MAX_RESULT_BYTES - 4_000;
/** The shortest a definition's long text is cut to before the whole result is left to ok()'s last-resort cut. */
const MIN_FIELD_CHARS = 200;
/** How often a run wait re-reads the run whatever the bus says (the safety net). */
const RUN_REREAD_MS = 10_000;
/** A block output or log window read with get_workflow_runs {runId, nodeId}. */
const OUTPUT_WINDOW_BYTES = 48_000;
/** The longest wait a call may ask for (spec §5.6). */
const MAX_WAIT_SECONDS = 600;

/**
 * Every Admin tool's chat note (spec §7.2). Short: the chat's instruction block already says to batch related changes
 * and not to retry a denial.
 */
const ADMIN_NOTE = "Needs the user's approval.";
/** create/update: a dry run is a read (no card). */
const ADMIN_DRY_RUN_NOTE = "Needs the user's approval, except with dryRun.";

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

const NOTHING: ScopeClaim = Object.freeze({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }) as ScopeClaim;
const claim = (over: Partial<ScopeClaim>): ScopeClaim => ({ ...NOTHING, ...over });
const isChat = (ctx: Pick<ScopeContext, "caller">): boolean => ctx.caller.kind === "thread";

/** A read of `metadata` (§5.2: workflow definitions and runs) in the workflow's home. */
async function homeRead(ctx: ScopeContext, project: WorkflowProject | undefined): Promise<ScopeClaim> {
  return claim({ ...(await homeScope(ctx.api, project)), reads: "metadata" });
}

/** The caller's own project as a `project` argument, for chat callers that named none. */
function ownProjectArg(ctx: ScopeContext): string | null {
  const caller = ctx.caller;
  if (caller.kind !== "thread" || !caller.projectPath || !caller.workspace) return null;
  return join(ctx.api.workspacesDir, caller.workspace, basename(caller.projectPath));
}

function runSummaryView(r: WorkflowRunSummary): Record<string, unknown> {
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
  view.project = workflowProjectLabel(w.project, workspacesDir);
  if (w.project.kind === "existing") view.projectPath = w.project.projectPath;
  view.triggers = w.triggers.map((t) => clipText(`${t.text}${t.lastError ? ` · error: ${t.lastError}` : ""}`, 300));
  view.nodeCount = w.nodeCount;
  view.errorCount = w.errorCount;
  if (w.lastRun) view.lastRun = { runId: w.lastRun.id, status: w.lastRun.status, ...(w.lastRun.endedAt ? { endedAt: w.lastRun.endedAt } : {}), ...(w.lastRun.error ? { error: clipText(w.lastRun.error, 200) } : {}) };
  view.activeRuns = w.activeRuns.length;
  view.updatedAt = w.updatedAt;
  return view;
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
function definitionView(workflow: Workflow, extra: Record<string, unknown>): Record<string, unknown> {
  const budget = WORKFLOW_RESULT_BUDGET;
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
  // The fitting planned to `budget`; what matters now is ok()'s hard cap (its last-resort cut).
  const hardRoom = Math.max(budget, MAX_RESULT_BYTES - 1_000);
  if (resultBytes(view) <= hardRoom) return view;
  // Even with every long text cut the blocks do not fit (a big workflow): list them as an outline
  // and point at the per-block read, rather than leave the result to ok()'s last-resort byte cut.
  const outline: Record<string, unknown> = {
    ...shown,
    nodes: workflow.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type, ...(n.disabled ? { disabled: true } : {}) }))
  };
  const outlined: Record<string, unknown> = {
    ...head,
    workflow: outline,
    ...flags,
    blocksOutlined: true,
    outlineNote: "The definition is too big for one result: blocks are listed as {id, name, type}. get_workflow {workflowId, node} reads one block's config."
  };
  if (resultBytes(outlined) <= hardRoom) return outlined;
  // Still too big: the edges go too (`connections` keeps them by name while it fits).
  delete outline.edges;
  outlined.edgesOmitted = true;
  if (resultBytes(outlined) > hardRoom) {
    delete outlined.connections;
    outlined.connectionsOmitted = true;
  }
  return outlined;
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
function fitOutputs(result: Record<string, unknown>, slots: OutputSlot[], budget: number): boolean {
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

const OUTPUT_NOTE = "Outputs marked outputTruncated are cut (outputText is the head of their JSON): read one whole with get_workflow_runs {runId, nodeId}.";

/** A whole run: summary, every block with its output fitted to the budget, and the final output. */
function runView(run: WorkflowRun, opts: { includeOutputs: boolean; extra?: Record<string, unknown> }): Record<string, unknown> {
  const blocks = orderedBlocks(run);
  const views = blocks.map(blockView);
  const summary = runSummaryView(run);
  // The sub-workflow revisions the run froze as it started (what its Run workflow blocks run).
  if (run.subWorkflowRevisions && Object.keys(run.subWorkflowRevisions).length > 0) summary.subWorkflowRevisions = { ...run.subWorkflowRevisions };
  const result: Record<string, unknown> = { ...(opts.extra ?? {}), run: summary, blocks: views };
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
function outputWindow(text: string, offset: number, maxBytes: number): { text: string; offset: number; totalBytes: number; nextOffset?: number } {
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
class RunEndTap {
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
async function waitForRunEnd(api: DaemonApi, tap: RunEndTap, runId: string, opts: { timeoutMs: number; signal: AbortSignal }): Promise<{ run: WorkflowRun | null; ended: boolean }> {
  const rereadMs = RUN_REREAD_MS;
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
const reasonArg = z.string().max(300).optional().describe("Why, in a sentence: shown on the approval card.");
const dryRunArg = z.boolean().default(false).describe("Only validate (returns the problems); nothing is saved.");
/** A block by id or name. A fresh schema per use: a shared one is advertised as a long `$ref` path. */
const nodeRef = () => z.string().min(1);
const nodeName = () => z.string().regex(WORKFLOW_NODE_NAME_PATTERN, "a block name is a letter, then letters, digits or _ (at most 40)");

// A block as an author sends it. Its keys are checked here (a typo is refused), but the values of `type`, `position`
// and `retry` are left to the daemon's own add (`Patcher.addNode` in packages/api/src/workflows/patch.ts, which the
// create and patch routes and this tool's local replay all run): it refuses an unknown type by listing the types and
// checks the rest against the stored block schema. Advertising them in full would repeat list_workflow_block_types'
// contract in every create and edit.
const nodeInputSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.string().min(1).describe("A type from list_workflow_block_types."),
  name: nodeName().optional().describe("Minted when omitted."),
  config: z.record(z.unknown()).optional().describe("Merged over the type's defaults."),
  position: z.unknown().optional().describe("{x, y}; omit to auto-layout."),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  retry: z.unknown().optional().describe("{maxTries 1–10, delaySeconds 0–3600}"),
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
  z.object({ op: z.literal("update_node"), node: nodeRef(), set: z.record(z.unknown()) }).strict(),
  z.object({ op: z.literal("remove_node"), node: nodeRef() }).strict(),
  z.object({ op: z.literal("rename_node"), node: nodeRef(), to: nodeName() }).strict(),
  z.object({ op: z.literal("connect"), source: nodeRef(), sourceHandle: z.string().min(1).optional(), target: nodeRef() }).strict(),
  z.object({ op: z.literal("disconnect"), edgeId: z.string().min(1).optional(), source: nodeRef().optional(), sourceHandle: z.string().min(1).optional(), target: nodeRef().optional() }).strict(),
  z.object({ op: z.literal("set_settings"), settings: settingsSchema }).strict(),
  z.object({ op: z.literal("set_project"), project: projectArgSchema }).strict(),
  z.object({ op: z.literal("set_enabled"), enabled: z.boolean() }).strict(),
  z.object({ op: z.literal("set_name"), name: z.string().min(1).max(WORKFLOW_LIMITS.maxNameLength), description: z.string().nullable().optional() }).strict(),
  z.object({ op: z.literal("set_pinned"), node: nodeRef(), output: z.unknown() }).strict()
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

/**
 * The ops as the daemon takes them: every project a caller names resolved (`set_project`, an added
 * block's `projectOverride`, and one an `update_node` sets) — PROJECT_NOT_FOUND before anything.
 */
async function convertOps(api: DaemonApi, raw: readonly OpArg[]): Promise<WorkflowPatchOp[]> {
  const ops: WorkflowPatchOp[] = [];
  for (const op of raw) {
    if (op.op === "set_project") ops.push({ op: "set_project", project: await toWorkflowProject(api, op.project) });
    else if (op.op === "add_node") ops.push({ op: "add_node", node: (await toNodeInput(api, op.node)) as Extract<WorkflowPatchOp, { op: "add_node" }>["node"] });
    else if (op.op === "update_node" && typeof op.set.projectOverride === "string") {
      ops.push({ ...op, set: { ...op.set, projectOverride: (await resolveProject(api, op.set.projectOverride)).path } });
    } else if (op.op === "disconnect" && op.edgeId === undefined && (op.source === undefined || op.target === undefined)) {
      throw new ToolError("INVALID_ARGUMENT", `ops[${ops.length}] (disconnect): name the connection by edgeId, or by source and target (sourceHandle optional).`);
    } else ops.push(op as WorkflowPatchOp);
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Local replays: what a create or an edit WOULD save (the daemon's own pure functions)
// ---------------------------------------------------------------------------

/** Ids minted by a local replay: never saved. */
function replayEnv(now: number) {
  let n = 0;
  return { mintId: () => `draft-${(n += 1)}`, now: new Date(now) };
}

interface CreateArgs {
  name: string;
  description?: string;
  project: ProjectArg;
  settings?: z.infer<typeof settingsSchema>;
  nodes: NodeInput[];
  edges: { source: string; sourceHandle?: string; target: string }[];
  enabled: boolean;
}

interface CreatePlan {
  request: CreateWorkflowRequest;
  /** The definition the create would save (ids are placeholders), or null when it cannot apply. */
  draft: Workflow | null;
  error: ToolError | null;
}

async function planCreate(api: DaemonApi, args: CreateArgs, now: number): Promise<CreatePlan> {
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
  try {
    return { request, draft: createWorkflowFromRequest(request, replayEnv(now)), error: null };
  } catch (error) {
    if (!(error instanceof WorkflowPatchError)) throw error;
    const refusal = new ToolError("INVALID_WORKFLOW", `Item ${error.opIndex}: ${error.message}.`, { opIndex: error.opIndex });
    return { request, draft: null, error: indexedCreateError(refusal, args.nodes.length) };
  }
}

interface UpdatePlan {
  current: Workflow;
  ops: WorkflowPatchOp[];
  /** The definition the edit would save, or null when it cannot apply (`error`). */
  after: Workflow | null;
  error: ToolError | null;
}

async function planUpdate(api: DaemonApi, args: { workflowId: string; revision: number; ops: OpArg[] }, now: number): Promise<UpdatePlan> {
  const ops = await convertOps(api, args.ops);
  const { workflow: current } = await readWorkflow(api, args.workflowId);
  if (current.revision !== args.revision) {
    const message = `The workflow is at revision ${current.revision}, not ${args.revision}`;
    return { current, ops, after: null, error: workflowError({ status: 409, body: { error: { code: "REVISION_CONFLICT", message } } }) };
  }
  try {
    const after = applyWorkflowPatch(current, ops, replayEnv(now));
    return { current, ops, after: { ...after, id: current.id, revision: current.revision + 1, createdAt: current.createdAt }, error: null };
  } catch (error) {
    if (!(error instanceof WorkflowPatchError)) throw error;
    const index = error.opIndex;
    const op = ops[index]?.op ?? "op";
    return { current, ops, after: null, error: new ToolError("INVALID_WORKFLOW", `ops[${index}] (${op}) failed: ${error.message}. Nothing was saved.`, { opIndex: index, op }) };
  }
}

/** An enabled definition with errors is refused by the save (the daemon's rule): say so before any card. */
function assertSavable(workflow: Workflow, problems: readonly WorkflowProblem[]): void {
  const errors = problems.filter((p) => p.severity === "error");
  if (workflow.enabled && errors.length > 0) {
    throw workflowError({
      status: 400,
      body: { error: { code: "INVALID_WORKFLOW", message: `An enabled workflow cannot have errors (${errors.length}). Fix them, or save it disabled`, problems } }
    });
  }
}

/** The prompts a preview shows: those the given agent blocks reference. */
async function promptsFor(api: DaemonApi, workflow: Pick<Workflow, "nodes">, only?: ReadonlySet<string>): Promise<Map<string, ReferencedPrompt | null>> {
  const nodes = only ? workflow.nodes.filter((node) => only.has(node.id)) : workflow.nodes;
  return resolveSavedPrompts(api, savedPromptIdsOf({ nodes }));
}

const unionLabel = (union: WorkflowUnion): string => {
  const names = [...union.projects.map((path) => path.split("/").slice(-2).join("/")), ...union.pendingWorkspaces.map((ws) => `a temporary project in ${ws}`)];
  if (names.length === 0) return "No project";
  return `${names.length === 1 ? "Project" : "Projects"} ${names.join(", ")}`;
};

/** The daemon's own "Operation N: " / "Item N: " prefix, dropped where the tool names the entry itself. */
function withoutEntryPrefix(message: string): string {
  return message.replace(/^(?:Operation|Item) \d+: /, "");
}

/** A create refusal naming a failing entry: the daemon's opIndex counts the nodes, then the edges. */
function indexedCreateError(error: ToolError, nodeCount: number): ToolError {
  const detail = isRecord(error.detail) ? error.detail : null;
  const index = detail && typeof detail.opIndex === "number" ? detail.opIndex : undefined;
  if (index === undefined) return error;
  const where = index < nodeCount ? `nodes[${index}]` : `edges[${index - nodeCount}]`;
  return new ToolError(error.code, `${where}: ${withoutEntryPrefix(error.message)}`, { ...detail, entry: where });
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
  const base = withoutEntryPrefix(error.message);
  const already = new RegExp(`\\bops?\\s*\\[?#?${index}\\b`, "i").test(base);
  const message = already ? base : `ops[${index}] (${ops[index]!.op}) failed: ${base}`;
  return new ToolError(error.code, `${message} Nothing was saved.`, { ...detail, opIndex: index, op: ops[index]!.op });
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
  description: "Read this before authoring a workflow: every block type (config schema, example, output shape and handles), the {{ }} expression guide and an authoring guide with a worked example. `type` returns one block's full contract: its whole config schema (even one the list omitted: configSchemasOmitted) and its guide sections.",
  input: { type: z.string().min(1).optional().describe("Only this block type.") },
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "read",
  scope: async () => NOTHING,
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api }) {
    const body = expectWorkflowOk<WorkflowBlockTypesResponse>(await api.request("GET", workflowRoutes.blockTypes));
    const types = Array.isArray(body.types) ? body.types : [];
    if (args.type !== undefined) {
      const one = types.find((t) => t.type === args.type);
      if (!one) throw new ToolError("NOT_FOUND", `The daemon lists no block type "${clipText(args.type, MAX_ECHO_CHARS)}" (types: ${types.map((t) => t.type).join(", ")}).`);
      // Its contract (arguments, result, limits…) too: the full listing carries every contract in the
      // authoring guide already. An older daemon sends none.
      const guide = Array.isArray(one.guide) && one.guide.length > 0 ? { guide: one.guide } : {};
      return { types: [{ ...blockTypeView(one, true), ...guide }], expressionGuide: body.expressionGuide };
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

/** list_workflows' project: the argument, else (chat) the caller's own; null = every workflow (external only). */
async function listProject(ctx: ScopeContext, project: string | undefined): Promise<string | null> {
  if (project !== undefined) return (await resolveProject(ctx.api, project)).path;
  if (!isChat(ctx)) return null;
  const own = ownProjectArg(ctx);
  if (own === null) throw new ToolError("INVALID_ARGUMENT", "This chat has no project of its own: pass project (\"<workspace>/<project>\", list_projects).");
  return (await resolveProject(ctx.api, own)).path;
}

const listWorkflows = defineTool({
  name: "list_workflows",
  title: "List automated workflows",
  description: "A project's automated workflows: id, name, enabled, revision, triggers, last run, active runs and error count.",
  chatNote: "Default: this chat's project.",
  externalNote: "Without project: every workflow.",
  input: { project: z.string().optional().describe("An absolute path or \"<workspace>/<project>\".") },
  audiences: ["external", "chat"],
  toolset: "reads",
  tier: "read",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    const path = await listProject(ctx, args.project);
    return claim({ projects: path ? [path] : [], reads: "metadata" });
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const projectPath = await listProject(ctx, args.project);
    const body = expectWorkflowOk<ListWorkflowsResponse>(await api.request("GET", workflowRoutes.list, projectPath !== null ? { query: { projectPath } } : undefined));
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
  description: "A workflow's definition (blocks, edges, settings), its revision (update_workflow and run_workflow need it) and validation problems. `connections` lists edges by block name. Long texts are cut to fit (truncatedFields); `node` reads one block with more room.",
  input: {
    workflowId: workflowIdArg,
    node: z.string().min(1).optional().describe("Only this block (id or name).")
  },
  audiences: ["external", "chat"],
  toolset: "reads",
  tier: "read",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    return homeRead(ctx, (await readWorkflow(ctx.api, args.workflowId)).workflow.project);
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api }) {
    const { workflow, problems } = await readWorkflow(api, args.workflowId);
    const head = { workflowId: workflow.id, name: workflow.name, revision: workflow.revision, enabled: workflow.enabled, project: workflowProjectLabel(workflow.project, api.workspacesDir) };
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
  if (!w.enabled) next.push("It is disabled: its schedule/git triggers do not fire until update_workflow ops [{\"op\":\"set_enabled\",\"enabled\":true}]; run_workflow {workflowId, revision} runs it now.");
  const extra = { [verb]: true, workflowId: w.id, name: w.name, revision: w.revision, enabled: w.enabled, project: workflowProjectLabel(w.project, api.workspacesDir), ...problems, ...(next.length ? { next: next.join(" ") } : {}) };
  return definitionView(w, extra);
}

/** A dry run's answer: the problems the save would see, and the projects it would run in. */
function dryRunResult(problems: readonly WorkflowProblem[], union: WorkflowUnion, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const view = problemsView(problems);
  return { dryRun: true, saved: false, valid: view.errorCount === 0, ...extra, ...view, projects: unionLabel(union) };
}

const createInput = {
  name: z.string().min(1).max(WORKFLOW_LIMITS.maxNameLength),
  description: z.string().optional().describe("What it does, in a sentence."),
  project: projectArgSchema.describe("Where it runs: an existing project (\"<workspace>/<project>\"), or temp: a fresh project per run."),
  settings: settingsSchema.optional().describe("Defaults: overlap skip, maxConcurrent 2, timezone the host's (IANA)."),
  nodes: z.array(nodeInputSchema).max(WORKFLOW_LIMITS.maxNodes),
  edges: z.array(z.object({ source: nodeRef(), sourceHandle: z.string().min(1).optional(), target: nodeRef() }).strict()).max(WORKFLOW_LIMITS.maxEdges).default([]).describe("By block name or id; sourceHandle defaults to success."),
  enabled: z.boolean().default(false).describe("Enable its triggers at once (refused while it has errors)."),
  dryRun: dryRunArg,
  reason: reasonArg
};

const createWorkflow = defineTool({
  name: "create_workflow",
  title: "Create a workflow",
  description: "Create an automated workflow from blocks and edges (read list_workflow_block_types first). Edges and {{ nodes.<Name>.output… }} use block names. Created disabled unless enabled:true. dryRun:true only validates. Returns the definition, its revision and validation problems.",
  chatNote: ADMIN_DRY_RUN_NOTE,
  input: createInput,
  chatOnlyInput: ["reason"],
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: (args) => (args.dryRun ? "read" : "admin"),
  adminFamily: "workflows",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    const plan = await planCreate(ctx.api, args, ctx.now());
    const union = await workflowUnion(ctx.api, [plan.draft ?? { project: plan.request.project, nodes: (plan.request.nodes ?? []) as WorkflowNode[] }]);
    return claim({ ...unionScope(union), reads: "metadata", writes: !args.dryRun });
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const { api } = ctx;
    const plan = await planCreate(api, args, ctx.now());
    if (plan.error || !plan.draft) throw plan.error ?? new ToolError("INVALID_WORKFLOW", "The workflow cannot be built.");
    const draft = plan.draft;
    const problems = await validateDefinition(api, draft);
    assertSavable(draft, problems);
    const union = await workflowUnion(api, [draft]);
    const prompts = await promptsFor(api, draft);
    // (A create always cards — no grant covers a workflow before it exists; its later edits of a
    // secret-reading block are never granted: `changesSecretUse` on update.)
    const sections: ApprovalPreviewSection[] = [
      ...(draft.enabled ? [{ kind: "warning" as const, level: "caution" as const, text: "Created ENABLED: its schedule and git triggers start firing at once." }] : []),
      workflowFields(draft, api.workspacesDir),
      ...(await unionSections(api, union, ctx.caller, { childrenJoinGrant: await unionGrantable(api, union, ctx.caller) })),
      ...definitionSections(draft, prompts, api.workspacesDir),
      ...problemSections(problems)
    ];
    return {
      title: `${agentLabel(ctx.caller)} wants to create the workflow "${draft.name}"${draft.enabled ? " and enable it" : ""}`,
      scopeLabel: unionLabel(union),
      sections,
      pins: previewPins(null, prompts, union),
      ...unionGrantFields(union)
    };
  },
  annotations: MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const plan = await planCreate(api, args, ctx.now());
    if (args.dryRun) {
      if (plan.error || !plan.draft) throw plan.error ?? new ToolError("INVALID_WORKFLOW", "The workflow cannot be built.");
      const union = await workflowUnion(api, [plan.draft]);
      return dryRunResult(await validateDefinition(api, plan.draft), union);
    }
    // What the user approved is what is saved: the prompts the card showed are unchanged (§7.2).
    if (ctx.approval?.pins) await verifyPins(api, ctx.approval.pins, { creating: true, via: ctx.approval.outcome });
    const res = await api.request("POST", workflowRoutes.create, { body: plan.request });
    if (res.status >= 400) throw indexedCreateError(workflowError(res), args.nodes.length);
    return writeResult(api, res.body as WorkflowWriteResponse, "created");
  }
});

const updateWorkflow = defineTool({
  name: "update_workflow",
  title: "Edit a workflow",
  description: "Edit a workflow with patch ops, applied in order and atomically (prefer this to recreating it). `revision` must be the current one (else REVISION_CONFLICT: re-read with get_workflow). Blocks are named by id or name. update_node's `set` takes name, config, disabled, notes, retry, timeoutMinutes, projectOverride, position; config merges one level deep; null clears a key. rename_node rewrites references to the block. disconnect takes edgeId, or source and target. set_pinned with output null unpins. dryRun:true only validates. A failing op is named by index and nothing is saved.",
  chatNote: ADMIN_DRY_RUN_NOTE,
  input: {
    workflowId: workflowIdArg,
    revision: z.number().int().nonnegative().describe("From get_workflow or the last write."),
    ops: z.array(opSchema).min(1).max(500),
    dryRun: dryRunArg,
    reason: reasonArg
  },
  chatOnlyInput: ["reason"],
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: (args) => (args.dryRun ? "read" : "admin"),
  adminFamily: "workflows",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    const plan = await planUpdate(ctx.api, args, ctx.now());
    // The union of before and after: an edit touches where the workflow ran and where it will run.
    const after = plan.after ?? { project: undefined, nodes: plan.ops.flatMap((op) => (op.op === "add_node" ? [op.node as WorkflowNode] : [])) };
    const extra = plan.after ? [] : plan.ops.flatMap((op) => (op.op === "set_project" ? [{ project: op.project }] : []));
    const union = await workflowUnion(ctx.api, [plan.current, after, ...extra]);
    return claim({ ...unionScope(union), reads: "metadata", writes: !args.dryRun });
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const { api } = ctx;
    const plan = await planUpdate(api, args, ctx.now());
    if (plan.error || !plan.after) throw plan.error ?? new ToolError("INVALID_WORKFLOW", "The edit cannot apply.");
    const { current, after } = plan;
    const problems = await validateDefinition(api, after);
    assertSavable(after, problems);
    const union = await workflowUnion(api, [current, after]);
    const diff = graphDiff(current, after, api.workspacesDir);
    // Enabling arms every block, and moving the workflow runs every block somewhere new: then the
    // whole definition is shown; otherwise the blocks the edit adds or changes, in full.
    const enables = after.enabled && !current.enabled;
    const everything = enables || JSON.stringify(current.project) !== JSON.stringify(after.project);
    const only = everything ? undefined : diff.touched;
    const prompts = await promptsFor(api, after, only);
    // Adding or changing a block that reads a secret, or retargeting one: never granted.
    const secretUse = changesSecretUse(after, diff.touched);
    // Workflows that run this one: the edit changes what they run (covered only with them).
    const callerList = await workflowCallers(api, current.id);
    const callers = callerParts(callerList, "change");
    const sections: ApprovalPreviewSection[] = [
      ...(enables ? [{ kind: "warning" as const, level: "caution" as const, text: "Enables the workflow: its schedule and git triggers start firing." }] : []),
      ...(secretUse ? [SECRET_USE_NOTE] : []),
      ...diff.sections,
      ...callers.sections,
      { kind: "code", title: "Ops", language: "json", text: JSON.stringify(args.ops, null, 2) },
      workflowFields(after, api.workspacesDir, "The workflow after the change"),
      ...(await unionSections(api, union, ctx.caller, { childrenJoinGrant: !secretUse && (await unionGrantable(api, union, ctx.caller)) })),
      ...definitionSections(after, prompts, api.workspacesDir, only),
      ...problemSections(problems)
    ];
    const verb = enables ? "enable" : !after.enabled && current.enabled ? "disable" : "change";
    return {
      title: `${agentLabel(ctx.caller)} wants to ${verb} the workflow "${current.name}"`,
      scopeLabel: unionLabel(union),
      sections,
      workflowId: current.id,
      // The callers too: the write is refused if they changed since (CALLERS_CHANGED → PREVIEW_STALE).
      pins: { ...previewPins(current, prompts, union), ...callersPin(current.id, callerList) },
      // A grant covers the edit only if it covers every sub-workflow it wires in (§7.6), and every
      // workflow that runs this one.
      ...unionGrantFields(union),
      ...callers.grant,
      ...(secretUse || callers.grant.ungrantable ? { ungrantable: true as const } : {})
    };
  },
  annotations: MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    if (args.dryRun) {
      const plan = await planUpdate(api, args, ctx.now());
      if (plan.error || !plan.after) throw plan.error ?? new ToolError("INVALID_WORKFLOW", "The edit cannot apply.");
      const union = await workflowUnion(api, [plan.current, plan.after]);
      const changes = graphDiff(plan.current, plan.after, api.workspacesDir).sections[0];
      return dryRunResult(await validateDefinition(api, plan.after), union, { revision: plan.current.revision, ...(changes?.kind === "changes" ? { changes: changes.items } : {}) });
    }
    const ops = await convertOps(api, args.ops);
    if (ctx.approval?.pins) {
      const { workflow: current } = await readWorkflow(api, args.workflowId);
      await verifyPins(api, ctx.approval.pins, { current, via: ctx.approval.outcome });
    }
    const expectCallers = expectedCallers(ctx.approval?.pins, args.workflowId);
    const res = await api.request("POST", workflowRoutes.patch(args.workflowId), { body: { revision: args.revision, ops, ...(expectCallers ? { expectCallers } : {}) } });
    if (res.status >= 400) {
      const error = workflowError(res);
      // Edited between the card and this write: the user approved another revision (§7.2).
      if (ctx.approval && error.code === "REVISION_CONFLICT") throw new ToolError("PREVIEW_STALE", `The workflow changed ${passedPhrase(ctx.approval.outcome)}; nothing was saved. Re-read it (get_workflow) and call again.`);
      if (ctx.approval && error.code === "CALLERS_CHANGED") throw callersStale(ctx.approval.outcome);
      throw await indexedPatchError(api, args.workflowId, args.revision, ops, error);
    }
    return writeResult(api, res.body as WorkflowWriteResponse, "updated");
  }
});

/** The workflows that run this one changed between the card (or the grant's check) and the write. */
function callersStale(via: PassedBy): ToolError {
  return new ToolError("PREVIEW_STALE", `The workflows that run this one as a sub-workflow changed ${passedPhrase(via)}; nothing was done. Re-read it (get_workflow) and call again.`);
}

/** Every run of a workflow, paged to the end (the store keeps at most `runsPerWorkflow`). */
async function countRuns(api: DaemonApi, workflowId: string): Promise<{ total: number; active: number }> {
  let total = 0;
  let active = 0;
  let before: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const res = await api.request("GET", workflowRoutes.runs(workflowId), { query: { limit: "50", ...(before ? { before } : {}) } });
    if (res.status >= 400) break;
    const body = res.body as ListWorkflowRunsResponse;
    total += body.runs?.length ?? 0;
    active += (body.runs ?? []).filter((run) => isRunActive(run.status)).length;
    before = body.before ?? null;
    if (!before) break;
  }
  return { total, active };
}

const deleteWorkflow = defineTool({
  name: "delete_workflow",
  title: "Delete a workflow",
  description: "Delete a workflow for good, with its run history and own secrets; its active runs are cancelled. To pause it instead: update_workflow op set_enabled false.",
  chatNote: ADMIN_NOTE,
  input: {
    workflowId: workflowIdArg,
    confirm: z.literal(true).describe("Must be true: this cannot be undone."),
    reason: reasonArg
  },
  chatOnlyInput: ["reason"],
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "admin",
  adminFamily: "workflows",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    const union = await workflowUnion(ctx.api, [(await readWorkflow(ctx.api, args.workflowId)).workflow]);
    return claim({ ...unionScope(union), reads: "metadata", writes: true });
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const { api } = ctx;
    const { workflow } = await readWorkflow(api, args.workflowId);
    const union = await workflowUnion(api, [workflow]);
    const runs = await countRuns(api, workflow.id);
    const secretsRes = await api.request("GET", workflowRoutes.secrets, { query: { workflowId: workflow.id } });
    const own = secretsRes.status < 400 ? ((secretsRes.body as ListWorkflowSecretsResponse).secrets ?? []).filter((s) => s.scope === "workflow").map((s) => s.name) : [];
    const callerList = await workflowCallers(api, workflow.id);
    const callers = callerParts(callerList, "delete");
    return {
      title: `${agentLabel(ctx.caller)} wants to delete the workflow "${workflow.name}"`,
      scopeLabel: unionLabel(union),
      sections: [
        { kind: "warning", level: "danger", text: `Deletes the workflow for good${runs.active > 0 ? `, cancels its ${runs.active} active run(s)` : ""} and removes its ${runs.total} recorded run(s) and ${own.length} own secret(s). This cannot be undone.` },
        workflowFields(workflow, api.workspacesDir),
        { kind: "fields", title: "Removed with it", rows: [{ label: "Runs", value: String(runs.total) }, { label: "Its own secrets", value: own.length > 0 ? own.join(", ") : "none" }] },
        ...callers.sections,
        ...(await unionSections(api, union, ctx.caller))
      ],
      workflowId: workflow.id,
      pins: { ...previewPins(workflow, new Map()), ...callersPin(workflow.id, callerList) },
      ...callers.grant,
      ...(union.missing.length > 0 ? { ungrantable: true } : {})
    };
  },
  annotations: DESTRUCTIVE,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    if (ctx.approval?.pins) await verifyPins(api, ctx.approval.pins, { via: ctx.approval.outcome });
    const expectCallers = expectedCallers(ctx.approval?.pins, args.workflowId);
    const res = await api.request("DELETE", workflowRoutes.workflow(args.workflowId), expectCallers ? { query: { expectCallers: expectCallers.join(",") } } : undefined);
    if (res.status >= 400) {
      const error = workflowError(res);
      if (ctx.approval && error.code === "CALLERS_CHANGED") throw callersStale(ctx.approval.outcome);
      throw error;
    }
    return { deleted: true, workflowId: args.workflowId };
  }
});

/** An outline shape cut to its type (and a list's length): what is left when the keys do not fit. */
function bareShape(shape: WorkflowExpressionShape | undefined): WorkflowExpressionShape | undefined {
  if (!shape) return shape;
  return { type: shape.type, ...(shape.length !== undefined ? { length: shape.length } : {}), ...(shape.note ? { note: shape.note } : {}) };
}

const PREVIEW_TRUNCATION_NOTE = "Results listed in truncatedFields were cut to fit (they end in \"… [truncated]\"); preview fewer templates, or a narrower path, to see more.";

const previewExpression = defineTool({
  name: "preview_expression",
  title: "Preview a {{ }} template",
  description: "Render {{ }} templates against a workflow's recorded data (a past run and/or pinned outputs) without running anything. Returns each result, the warnings a run would record, parse errors, and `available`: what the context holds (input, trigger, readable blocks' output keys, secret names) for finding paths. Secrets render as «secret:NAME».",
  input: {
    workflowId: workflowIdArg,
    template: z.string().max(EXPRESSION_PREVIEW_LIMITS.maxTemplateLength).optional().describe("One template, e.g. \"{{ nodes.Claude.output.text }}\"; or pass templates."),
    templates: z.array(z.string().max(EXPRESSION_PREVIEW_LIMITS.maxTemplateLength)).min(1).max(EXPRESSION_PREVIEW_LIMITS.maxTemplates).optional(),
    node: z.string().min(1).optional().describe("The block (id or name) holding the template: it sets `input` and hides itself and its downstream. Omitted: `input` is empty."),
    runId: z.string().min(1).optional().describe("Default: the latest run that reached `node`, else the latest run."),
    usePinned: z.boolean().default(false).describe("Pinned outputs (set_pinned) replace recorded ones, as in a test run; works with no run."),
    mode: z.enum(["text", "value"]).default("text").describe("text: as a text field renders. value: a lone {{ }} keeps its raw value (rule sides, Stop values, sub-workflow input).")
  },
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "read",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    return homeRead(ctx, (await readWorkflow(ctx.api, args.workflowId)).workflow.project);
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api }) {
    if ((args.template === undefined) === (args.templates === undefined)) {
      throw new ToolError("INVALID_ARGUMENT", "Pass template (one text) or templates (a list), not both and not neither.");
    }
    const templates = args.templates ?? [args.template!];
    const body = {
      templates,
      mode: args.mode,
      usePinned: args.usePinned,
      ...(args.node !== undefined ? { node: args.node } : {}),
      ...(args.runId !== undefined ? { runId: args.runId } : {})
    };
    const res = await api.request("POST", workflowRoutes.expressionPreview(args.workflowId), { body });
    const preview = expectWorkflowOk<PreviewWorkflowExpressionResponse>(res);
    const results = (preview.results ?? []).map((r, i) => ({ template: clipText(templates[i] ?? "", 300), ...r }));
    const head: Record<string, unknown> = { workflowId: args.workflowId, node: preview.node?.name ?? null, source: preview.source };
    let available: Record<string, unknown> = { ...preview.available };
    const frame = (v: unknown, extra: Record<string, unknown> = {}) => ({ ...head, results: v, available, notes: preview.notes, ...extra });
    const budget = WORKFLOW_RESULT_BUDGET;
    // Too big: the outline goes down to types first (the results are what was asked for).
    if (resultBytes(frame(results)) > budget) {
      const nodes = preview.available?.nodes ?? {};
      available = {
        ...available,
        ...(preview.available?.input ? { input: bareShape(preview.available.input) } : {}),
        ...(preview.available?.trigger ? { trigger: bareShape(preview.available.trigger) } : {}),
        nodes: Object.fromEntries(Object.entries(nodes).map(([name, n]) => [name, { status: n.status, ...(n.output ? { output: bareShape(n.output) } : {}), ...(n.error ? { error: clipText(n.error, 120) } : {}) }])),
        keysOmitted: true
      };
    }
    const flags = { truncatedFields: [], truncationNote: PREVIEW_TRUNCATION_NOTE };
    const fitted = fitLongStrings(results, "results", budget, (v) => frame(v, flags));
    let shown = fitted.value as Record<string, unknown>[];
    // Still too big (a value of many small parts): values become the head of their JSON text.
    if (resultBytes(frame(shown, flags)) > budget) {
      const room = Math.max(0, budget - resultBytes(frame(shown.map(({ value: _value, ...rest }) => rest), flags)));
      const share = Math.floor(room / Math.max(1, shown.length)) - 64;
      shown = shown.map((r) => {
        if (r.value === undefined) return r;
        const { value, ...rest } = r;
        return { ...rest, valueJson: fitJsonBytes(JSON.stringify(value) ?? "", Math.max(0, share)).text, truncated: true };
      });
    }
    const out: Record<string, unknown> = frame(shown);
    if (fitted.cut.length > 0) {
      out.truncatedFields = fitted.cut.slice(0, 50).map((p) => clipText(p, 120));
      out.truncationNote = PREVIEW_TRUNCATION_NOTE;
    }
    return out;
  }
});

/**
 * A run's home: the project it runs in (a temp run's own directory once created), else its frozen
 * definition's project — so a deleted workflow's run still has one.
 */
async function runHome(ctx: ScopeContext, runId: string, writes: boolean): Promise<ScopeClaim> {
  const run = await readRun(ctx.api, runId);
  const ranIn = run.projectPath ? await homeScope(ctx.api, { kind: "existing", projectPath: run.projectPath }) : { projects: [] };
  const home = ranIn.projects.length > 0 ? ranIn : await homeScope(ctx.api, run.definition?.project);
  return claim({ ...home, reads: "metadata", writes });
}

const stalePreview = (message: string) => new ToolError("PREVIEW_STALE", `${message} Re-read it (get_workflow) and call again.`);


/**
 * A started run that froze another revision, or whose definition could not be read back: cancel it
 * and say truthfully what happened — including a cancel that failed.
 */
async function refuseStartedRun(api: DaemonApi, runId: string, asked: number, ran: number | undefined, via: PassedBy | undefined): Promise<never> {
  const cancel = await api.request("POST", workflowRoutes.runCancel(runId)).catch(() => null);
  const outcome = cancel === null || cancel.status >= 500
    ? `it could NOT be cancelled (the cancel failed): cancel it with cancel_workflow_run {runId: "${runId}"}`
    : cancel.status >= 400
      ? "it had already ended"
      : "it was cancelled";
  const detail = { runId, cancelled: cancel !== null && cancel.status < 400 };
  if (ran === undefined) {
    throw new ToolError("RUN_UNVERIFIED", `Run ${runId} started, but its definition could not be checked against revision ${asked}, so ${outcome}.`, detail);
  }
  const message = `The workflow changed (revision ${asked} → ${ran}) as run ${runId} started${via ? `, ${passedPhrase(via)}` : ""}; ${outcome}.`;
  throw via ? new ToolError("PREVIEW_STALE", `${message} Re-read it (get_workflow) and call again.`, detail) : new ToolError("REVISION_CONFLICT", message, detail);
}

/** A started run whose frozen sub-workflow is not the one pinned: cancelled, PREVIEW_STALE. */
async function refuseStaleChildRun(api: DaemonApi, runId: string, child: string, via: PassedBy): Promise<never> {
  const cancel = await api.request("POST", workflowRoutes.runCancel(runId)).catch(() => null);
  const outcome = cancel === null || cancel.status >= 500
    ? `it could NOT be cancelled (the cancel failed): cancel it with cancel_workflow_run {runId: "${runId}"}`
    : cancel.status >= 400
      ? "it had already ended"
      : "it was cancelled";
  throw new ToolError(
    "PREVIEW_STALE",
    `The sub-workflow ${child} changed as run ${runId} started, ${passedPhrase(via)}; ${outcome}. Re-read it (get_workflow) and call again.`,
    { runId, cancelled: cancel !== null && cancel.status < 400 }
  );
}

/** The revision a run must start from; a mismatch before any card is the caller's stale read. */
function revisionConflict(current: number, asked: number): ToolError {
  return workflowError({ status: 409, body: { error: { code: "REVISION_CONFLICT", message: `The workflow is at revision ${current}, not ${asked}` } } });
}

const runWorkflow = defineTool({
  name: "run_workflow",
  title: "Run a workflow",
  description: "Run the workflow now (works while disabled). Returns runId; wait:true waits up to timeoutSeconds for the end and returns each block's status, error and output (capped). The overlap policy may skip it (skipped: \"overlap\"); force:true runs anyway. Agent blocks can take hours: prefer get_workflow_runs {runId, waitSeconds} later.",
  chatNote: ADMIN_NOTE,
  input: {
    workflowId: workflowIdArg,
    revision: z.number().int().nonnegative().describe("From get_workflow: refused if the workflow changed since."),
    input: z.unknown().optional().describe("JSON for the trigger: {{ trigger.input }}."),
    wait: z.boolean().default(false),
    timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(300),
    force: z.boolean().default(false),
    reason: reasonArg
  },
  chatOnlyInput: ["reason"],
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "admin",
  adminFamily: "workflows",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    const union = await workflowUnion(ctx.api, [(await readWorkflow(ctx.api, args.workflowId)).workflow]);
    return claim({ ...unionScope(union), reads: "metadata", writes: true });
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const { api } = ctx;
    const { workflow, problems } = await readWorkflow(api, args.workflowId);
    if (workflow.revision !== args.revision) throw revisionConflict(workflow.revision, args.revision);
    const union = await workflowUnion(api, [workflow]);
    const prompts = await resolveSavedPrompts(api, savedPromptIdsOf(workflow));
    const runFields: ApprovalPreviewSection = {
      kind: "fields",
      title: "Run",
      rows: [
        { label: "Workflow", value: `${workflow.name} (${workflow.id})` },
        { label: "Revision", value: String(workflow.revision) },
        { label: "Enabled", value: workflow.enabled ? "yes" : "no (a manual run works anyway)" },
        { label: "Project", value: workflowProjectLabel(workflow.project, api.workspacesDir) },
        ...(args.force ? [{ label: "Overlap", value: "force: runs even if a run is active", state: "flagged" as const }] : [])
      ]
    };
    const inputText = args.input === undefined ? "null" : JSON.stringify(args.input, null, 2);
    const inputSection: ApprovalPreviewSection = { kind: "code", title: "Input ({{ trigger.input }})", language: "json", text: inputText };
    const problemParts = problemSections(problems);
    const title = `${agentLabel(ctx.caller)} wants to run the workflow "${workflow.name}"`;
    // (Callers are not checked here: running a workflow another workflow calls does not change what
    // that one runs — only an update or a delete does.)
    const base = { title, scopeLabel: unionLabel(union), workflowId: workflow.id, pins: previewPins(workflow, prompts, union) };
    const tooLargeInput = () =>
      new ToolError("PREVIEW_TOO_LARGE", "The run input is too large to show the user in one approval card. Pass a smaller input (let a block read the bulk from a file or an earlier block).");
    // The definition that will run, in full: a card only opens for a workflow no grant covers —
    // one this chat neither created nor was granted (often the user's own, or an external client's).
    const grantable = await unionGrantable(api, union, ctx.caller);
    const full: ApprovalPreviewSection[] = [
      runFields,
      inputSection,
      ...(await unionSections(api, union, ctx.caller, { childrenJoinGrant: grantable })),
      ...definitionSections(workflow, prompts, api.workspacesDir),
      ...problemParts
    ];
    // Measured whole, as the executor measures the card. A grant covers the run only if it covers every sub-workflow it calls (§7.6).
    if (approvalPreviewBytes(full) <= TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) return { ...base, sections: full, ...unionGrantFields(union) };
    // Over the cap. The input is the agent's and is never cut: when the definition alone would fit,
    // the input is what is too large — refused, the agent passes a smaller one.
    if (approvalPreviewBytes(full.filter((section) => section !== inputSection)) <= TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) throw tooLargeInput();
    // The DEFINITION is too large to show: an outline the user is told to review in Workflows, the
    // input whole, never grantable (nothing shown, nothing standing).
    const outline = workflow.nodes.filter((node) => node.type !== "note").map((node) => `${node.type} · ${node.name}${node.disabled ? " (disabled)" : ""}`);
    const compact: ApprovalPreviewSection[] = [
      { kind: "warning", level: "danger", text: "This workflow is too large to show here — open it in Workflows to review every block before approving." },
      runFields,
      inputSection,
      ...(await unionSections(api, union, ctx.caller)),
      { kind: "text", title: "Blocks", text: outline.join("\n") || "none" },
      ...(prompts.size > 0
        ? [{ kind: "fields" as const, title: "Saved prompts its agents use", rows: [...prompts].map(([id, prompt]) => ({ label: prompt ? prompt.title : id, value: prompt ? `${prompt.body.length} characters` : "missing — that block fails", ...(prompt ? {} : { state: "flagged" as const }) })) }]
        : []),
      ...problemParts
    ];
    if (approvalPreviewBytes(compact) > TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) throw tooLargeInput();
    return { ...base, sections: compact, ungrantable: true };
  },
  annotations: MUTATING,
  resultKind: "json",
  async run(args, ctx) {
    const { api, signal } = ctx;
    const { workflow } = await readWorkflow(api, args.workflowId);
    if (ctx.approval?.pins) await verifyPins(api, ctx.approval.pins, { current: workflow, via: ctx.approval.outcome });
    if (workflow.revision !== args.revision) throw revisionConflict(workflow.revision, args.revision);
    // Tap the bus before starting, so a run that ends before the POST answers is still heard.
    const tap = args.wait ? new RunEndTap(api) : null;
    try {
      // The engine refuses atomically, before any block starts, unless the workflow is still at this revision.
      const body = { expectedRevision: args.revision, ...(args.input !== undefined ? { input: args.input } : {}), ...(args.force ? { force: true } : {}) };
      const res = await api.request("POST", workflowRoutes.run(args.workflowId), { body });
      if (res.status >= 400) {
        const error = workflowError(res);
        if (ctx.approval && error.code === "REVISION_CONFLICT") throw stalePreview(`The workflow changed ${passedPhrase(ctx.approval.outcome)}; no run started.`);
        throw error;
      }
      const started = res.body as RunWorkflowResponse;
      if (started.runId === null || started.skipped) {
        return { runId: null, skipped: started.skipped ?? "overlap", message: "Not run: a run of this workflow is already active and its overlap policy skipped this one. Pass force:true to run anyway, or watch the active run (get_workflow_runs {workflowId})." };
      }
      // Defence in depth: the run froze the definition it started with. One that is not the revision
      // asked for (or approved), or that cannot be checked, is cancelled at once (fail closed).
      const first = await readRun(api, started.runId).catch(() => null);
      const ran = first?.definition?.revision;
      if (ran !== args.revision) await refuseStartedRun(api, started.runId, args.revision, ran, ctx.approval?.outcome);
      // The run froze its sub-workflows as it started: they must be the revisions the card (or the
      // grant's check) pinned, or the run is cancelled — what was approved is what runs.
      if (ctx.approval?.pins) {
        const child = frozenChildMismatch(ctx.approval.pins, args.workflowId, first?.subWorkflowRevisions);
        if (child !== null) await refuseStaleChildRun(api, started.runId, child, ctx.approval.outcome);
      }
      if (!tap) return { runId: started.runId, status: "started", revision: args.revision, next: "get_workflow_runs {runId, waitSeconds} watches it; run_workflow with wait:true waits for the end." };
      const { run, ended } = await waitForRunEnd(api, tap, started.runId, { timeoutMs: args.timeoutSeconds * 1_000, signal });
      if (!run) return { runId: started.runId, finished: false, timedOut: true, next: "get_workflow_runs {runId, waitSeconds} watches it." };
      const extra = ended ? { runId: run.id, finished: true } : { runId: run.id, finished: false, timedOut: true, next: "Still running: get_workflow_runs {runId, waitSeconds} later, or cancel_workflow_run." };
      return runView(run, { includeOutputs: true, extra });
    } finally {
      tap?.close();
    }
  }
});

/** A block's stdout/stderr window: the route answers plain text, `offset`/`maxBytes` in bytes of the log file. */
async function logWindow(api: DaemonApi, run: WorkflowRun, block: WorkflowBlockRun, stream: "stdout" | "stderr", offset: number | undefined, room: number): Promise<Record<string, unknown>> {
  const size = block.logs ? (stream === "stdout" ? block.logs.stdoutBytes : block.logs.stderrBytes) : 0;
  // Default: the tail, where a failure is.
  const start = offset ?? Math.max(0, size - room);
  const res = await api.request("GET", workflowRoutes.nodeLog(run.id, block.nodeId), { query: { stream, offset: String(start), maxBytes: String(room) } });
  if (res.status >= 400) throw workflowError(res);
  // The in-process client parses a body that happens to be JSON (a log of one number): put it back as text.
  const exactText = typeof res.body === "string" || res.body === null;
  const raw = typeof res.body === "string" ? res.body : res.body === null ? "" : JSON.stringify(res.body);
  const fitted = fitJsonBytes(raw, room);
  // Secret values are replaced by «secret:NAME» (by the daemon, as stored): offsets then drift from the text's length.
  const exact = exactText && !fitted.text.includes("«secret:");
  const next = start + (exact ? Buffer.byteLength(fitted.text, "utf8") : room);
  return {
    log: stream,
    text: fitted.text,
    offset: start,
    logBytes: size,
    ...(next < size ? { nextOffset: next, note: "The log continues: call again with outputOffset = nextOffset." } : {}),
    ...(exact ? {} : { offsetsApproximate: true })
  };
}

const getWorkflowRuns = defineTool({
  name: "get_workflow_runs",
  title: "Watch a workflow's runs",
  description: "Watch/debug runs. {workflowId}: runs, newest first. {runId}: each block's status, error, session and output (capped); waitSeconds waits for the end. {runId, nodeId}: a block's whole output (outputOffset pages), or its stdout/stderr log (default: the tail). Secrets read «secret:NAME».",
  input: {
    workflowId: z.string().min(1).optional().describe("List its runs."),
    runId: z.string().min(1).optional().describe("One run."),
    nodeId: z.string().min(1).optional().describe("One block (id or name)."),
    log: z.enum(["stdout", "stderr"]).optional().describe("Read this log, not the output."),
    outputOffset: z.number().int().min(0).optional().describe("Byte offset (the last nextOffset)."),
    before: z.string().min(1).optional().describe("Next page cursor."),
    limit: z.number().int().min(1).max(50).default(20).describe("Runs per page."),
    waitSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional().describe("Wait this long for the run to end.")
  },
  audiences: ["external", "chat"],
  toolset: "reads",
  tier: "read",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    if (args.runId !== undefined) return runHome(ctx, args.runId, false);
    if (args.workflowId !== undefined) return homeRead(ctx, (await readWorkflow(ctx.api, args.workflowId)).workflow.project);
    return NOTHING;
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, signal }) {
    if (args.runId === undefined) {
      if (args.workflowId === undefined) throw new ToolError("INVALID_ARGUMENT", "Pass workflowId (its runs) or runId (one run).");
      const stray = (["nodeId", "log", "outputOffset", "waitSeconds"] as const).filter((key) => args[key] !== undefined);
      if (stray.length > 0) throw new ToolError("INVALID_ARGUMENT", `${stray.join(", ")} need${stray.length === 1 ? "s" : ""} runId.`);
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
    if (args.log !== undefined && args.nodeId === undefined) throw new ToolError("INVALID_ARGUMENT", "log needs nodeId (the block whose log to read).");
    // Tap the bus before the first read when waiting, so an end between the read and the wait is heard.
    const tap = args.waitSeconds !== undefined ? new RunEndTap(api) : null;
    let run: WorkflowRun;
    let waited: Record<string, unknown> = {};
    try {
      run = await readRun(api, args.runId);
      if (args.workflowId !== undefined && run.workflowId !== args.workflowId) {
        throw new ToolError("INVALID_ARGUMENT", `Run ${clipText(run.id, MAX_ECHO_CHARS)} belongs to workflow ${clipText(run.workflowId, MAX_ECHO_CHARS)}, not ${clipText(args.workflowId, MAX_ECHO_CHARS)}.`);
      }
      if (tap && isRunActive(run.status)) {
        const { run: last, ended } = await waitForRunEnd(api, tap, run.id, { timeoutMs: args.waitSeconds! * 1_000, signal });
        if (last) run = last;
        waited = ended ? { finished: true } : { finished: false, timedOut: true };
      } else if (tap) {
        waited = { finished: true };
      }
    } finally {
      tap?.close();
    }
    if (args.nodeId === undefined) return runView(run, { includeOutputs: true, extra: waited });
    const block = findBlock(run, args.nodeId);
    const result: Record<string, unknown> = { ...waited, run: runSummaryView(run), block: blockView(block) };
    const room = Math.min(OUTPUT_WINDOW_BYTES, WORKFLOW_RESULT_BUDGET - resultBytes(result) - 200);
    if (args.log !== undefined) return { ...result, ...(await logWindow(api, run, block, args.log, args.outputOffset, Math.max(1_000, room))) };
    const res = await api.request("GET", workflowRoutes.nodeOutput(run.id, block.nodeId));
    const output = expectWorkflowOk<GetWorkflowNodeOutputResponse>(res).output;
    if (output === undefined) return { ...result, output: null, note: "This block has no output." };
    const offset = args.outputOffset ?? 0;
    if (offset === 0 && resultBytes({ ...result, output }) <= WORKFLOW_RESULT_BUDGET) return { ...result, output };
    const window = outputWindow(JSON.stringify(output), offset, Math.max(1_000, room));
    return { ...result, outputText: window.text, offset: window.offset, totalBytes: window.totalBytes, ...(window.nextOffset !== undefined ? { nextOffset: window.nextOffset, note: "The output's JSON text continues: call again with outputOffset = nextOffset." } : {}) };
  }
});

const cancelRun = defineTool({
  name: "cancel_workflow_run",
  title: "Cancel a workflow run",
  description: "Cancel an active run: running agents are interrupted and processes killed; the run ends cancelled. RUN_NOT_ACTIVE when it already ended.",
  input: { runId: z.string().min(1).describe("The run's id.") },
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "act",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    return runHome(ctx, args.runId, true);
  },
  annotations: MUTATING_IDEMPOTENT,
  resultKind: "json",
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
  description: "Workflow secret NAMES (never values): the global ones, plus a workflow's own with workflowId. Blocks read one as {{ secrets.NAME }} (HTTP fields, shell env values) or secrets.NAME in code.",
  input: { workflowId: z.string().min(1).optional().describe("Also list this workflow's own secrets.") },
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "read",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    if (args.workflowId === undefined) return claim({ reads: "metadata" });
    return homeRead(ctx, (await readWorkflow(ctx.api, args.workflowId)).workflow.project);
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api }) {
    const query = args.workflowId !== undefined ? { query: { workflowId: args.workflowId } } : undefined;
    const body = expectWorkflowOk<ListWorkflowSecretsResponse>(await api.request("GET", workflowRoutes.secrets, query));
    const secrets = (body.secrets ?? []).map((s) => ({ name: s.name, scope: s.scope, ...(s.workflowId ? { workflowId: s.workflowId } : {}), updatedAt: s.updatedAt, ...(s.short ? { short: true } : {}) }));
    return { secrets };
  }
});

/** The card's masked field: the one place a chat caller's secret value comes from (D-11). */
const SECRET_FIELD = "value";

const setSecret = defineTool({
  name: "set_workflow_secret",
  title: "Set a workflow secret",
  description: "Create, replace or delete (delete:true) a workflow secret: a workflow's own with workflowId, else global. Write-only: the value is never shown again.",
  chatNote: "You never see or send the value: the user types it into the approval card.",
  externalNote: "The value you pass stays in your transcript and tool logs: prefer asking the user to set it in Orquester.",
  input: {
    name: z.string().regex(WORKFLOW_SECRET_NAME_PATTERN, "a secret name is A-Z, 0-9 and _, starting with a letter (at most 64)").describe("e.g. JIRA_TOKEN"),
    workflowId: z.string().min(1).optional().describe("Scope it to this workflow; omit for a global secret."),
    delete: z.boolean().default(false),
    value: z.string().min(1).refine((v) => Buffer.byteLength(v, "utf8") <= WORKFLOW_SECRET_MAX_VALUE_BYTES, "a secret value is at most 64 KiB").optional().describe("Required unless delete."),
    reason: reasonArg
  },
  chatOnlyInput: ["reason"],
  externalOnlyInput: ["value"],
  audiences: ["external", "chat"],
  toolset: "workflow-authoring",
  tier: "admin",
  adminFamily: "workflow-secrets",
  async scope(args, ctx) {
    if (!isChat(ctx)) return NOTHING;
    // A workflow's own secret feeds its blocks wherever they run: the workflow's union. A global one is global.
    if (args.workflowId === undefined) return claim({ writes: true });
    const union = await workflowUnion(ctx.api, [(await readWorkflow(ctx.api, args.workflowId)).workflow]);
    return claim({ ...unionScope(union), writes: true });
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const { api } = ctx;
    const workflow = args.workflowId !== undefined ? (await readWorkflow(api, args.workflowId)).workflow : null;
    const listed = await api.request("GET", workflowRoutes.secrets, workflow ? { query: { workflowId: workflow.id } } : undefined);
    const names = listed.status < 400 ? ((listed.body as ListWorkflowSecretsResponse).secrets ?? []) : [];
    const exists = names.some((s) => s.name === args.name && (workflow ? s.scope === "workflow" : s.scope === "global"));
    const union = workflow ? await workflowUnion(api, [workflow]) : null;
    const scope = workflow ? `Workflow "${workflow.name}" (${workflow.id}) only` : "Global — every workflow's blocks can read it";
    const sections: ApprovalPreviewSection[] = [
      {
        kind: "fields",
        title: "Workflow secret",
        rows: [
          { label: "Name", value: args.name },
          { label: "Scope", value: scope, ...(workflow ? {} : { state: "flagged" as const }) },
          { label: "Action", value: args.delete ? (exists ? "delete it" : "delete it (no such secret now)") : exists ? "replace its value" : "create it" },
          ...(args.delete ? [] : [{ label: "Value", value: "typed by you below; the agent never sees it", state: "asked" as const }])
        ]
      },
      ...(args.delete ? [{ kind: "warning" as const, level: "caution" as const, text: `Blocks that read {{ secrets.${args.name} }} will fail or read nothing.` }] : []),
      ...(union ? await unionSections(api, union, ctx.caller) : [])
    ];
    return {
      title: args.delete ? `${agentLabel(ctx.caller)} wants to delete the workflow secret ${args.name}` : `${agentLabel(ctx.caller)} asks you to set the workflow secret ${args.name}`,
      scopeLabel: workflow ? `Workflow ${workflow.name}` : "Global — every workflow",
      sections,
      ...(args.delete ? {} : { secretFields: [{ key: SECRET_FIELD, label: `Value of ${args.name}` }] })
    };
  },
  annotations: DESTRUCTIVE,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const scoped = args.workflowId !== undefined ? { query: { workflowId: args.workflowId } } : {};
    const result: Record<string, unknown> = { name: args.name, scope: args.workflowId !== undefined ? "workflow" : "global", ...(args.workflowId !== undefined ? { workflowId: args.workflowId } : {}) };
    if (args.delete) {
      if (args.value !== undefined) throw new ToolError("INVALID_ARGUMENT", "Pass value or delete: true, not both.");
      expectWorkflowOk(await api.request("DELETE", workflowRoutes.secret(args.name), scoped));
      return { deleted: true, ...result };
    }
    // A chat caller's value comes only from the card (D-11); an external caller's from its arguments.
    const value = ctx.caller.kind === "thread" ? ctx.approval?.secrets?.[SECRET_FIELD] : args.value;
    if (value === undefined || value === "") {
      throw new ToolError("INVALID_ARGUMENT", ctx.caller.kind === "thread" ? "The approval card returned no value; nothing was set." : "value is required unless delete: true.");
    }
    if (Buffer.byteLength(value, "utf8") > WORKFLOW_SECRET_MAX_VALUE_BYTES) throw new ToolError("INVALID_ARGUMENT", "A secret value is at most 64 KiB.");
    expectWorkflowOk(await api.request("PUT", workflowRoutes.secret(args.name), { body: { value }, ...scoped }));
    if (value.length < 4) result.warning = "Values under 4 characters are not redacted from stored outputs and logs.";
    return { set: true, ...result };
  }
});

/** This family in the catalog (`../catalog/index.ts`), in spec §4 order. */
export const workflowsFamily: readonly AnyOrquesterTool[] = [
  listBlockTypes, listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  previewExpression, runWorkflow, getWorkflowRuns, cancelRun, listSecrets, setSecret
];
