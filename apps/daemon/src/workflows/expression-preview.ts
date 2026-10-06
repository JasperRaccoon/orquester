// Automated workflows — the expression preview (`POST /api/workflows/:id/expression-preview`).
//
// Renders `{{ … }}` templates the way a block would, against data already on record: a past run's
// outputs and/or the workflow's pinned outputs. Nothing runs and nothing is written.
//
// The context is the engine's (engine.ts `baseContext`): `nodes` holds every FINISHED block by name
// ({output, status, error?}), `input` is the output of the block's live upstream — one source as
// is, several as `{ [name]: output }`; in a workflow with no trigger, a starting block reads the
// run's input (engine.ts computeForced) — and trigger/run/project/workflow as a run gives them. Taking
// a block's point of view leaves that block and everything after it out of `nodes`: they have not
// finished when it renders. Pinned outputs replace recorded ones as a test run seeds them (a block
// that finishes on "success", never the block itself).
//
// Secret values never leave: the context's DATA is redacted before rendering (a value `| json` or
// `| upper` transforms would no longer match a pass over the text) — block names and the roots' own
// fields stay keys as the engine gives them; keys inside outputs and payloads are data and are
// redacted — `{{ secrets.X }}` renders as `«secret:X»`, and what is rendered (text, value, warnings,
// errors) is redacted once more (as renderSessionTitle does). A render stops at the byte cap.

import { basename, dirname } from "node:path";
import {
  downstreamOf,
  EXPRESSION_PREVIEW_LIMITS,
  isTriggerType,
  outputHandles,
  parseTemplate,
  renderTemplate,
  renderTemplateValue,
  type ExpressionContext,
  type PreviewWorkflowExpressionRequest,
  type PreviewWorkflowExpressionResponse,
  type Workflow,
  type WorkflowBlockError,
  type WorkflowBlockRun,
  type WorkflowExpressionPreviewResult,
  type WorkflowExpressionShape,
  type WorkflowNode,
  type WorkflowRun
} from "@orquester/api";
import type { NodeExecutionContext } from "./contracts.ts";
import { isFinishedBlockStatus, truncateUtf8 } from "./run-context.ts";
import { createRedactor, redactContextValue, secretPlaceholder, type SecretRedactor } from "./sandbox/redact.ts";

/** The run a preview reads, and how its whole outputs are fetched (the run may hold previews only). */
export interface ExpressionPreviewRun {
  run: WorkflowRun;
  how: "requested" | "reached-node" | "latest";
  /** Why this run was taken over a newer one, for the notes. */
  note?: string;
  /** A block's whole output (its output file when the run kept a preview). */
  output(nodeId: string): Promise<unknown>;
}

export interface ExpressionPreviewInput {
  workflow: Workflow;
  request: PreviewWorkflowExpressionRequest;
  /** The block whose point of view is taken, or null. */
  node: WorkflowNode | null;
  source: ExpressionPreviewRun | null;
  /** Resolved secret values (name → value): redacted, never returned. */
  secrets: Readonly<Record<string, string>>;
  now: Date;
}

/** Warnings (and parse errors) per template, as a block keeps them (engine.ts MAX_BLOCK_WARNINGS). */
const MAX_WARNINGS = 50;
/** Keys an outline lists per object. */
const MAX_OUTLINE_KEYS = 40;

/** The payload a test run's trigger carries (engine.ts testNode): what a preview with no run reads. */
const TEST_TRIGGER_PAYLOAD = { kind: "manual", input: null };

interface BlockState {
  name: string;
  status: string;
  handle?: string;
  output: unknown;
  error?: WorkflowBlockError;
  /** The output is the run's inline preview of a larger one (not read whole). */
  previewOnly: boolean;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A value's type in one word or two: "string", "array (3)", "object (5 keys)". */
function typeLabel(value: unknown): string {
  if (Array.isArray(value)) return `array (${value.length})`;
  if (isRecord(value)) return `object (${Object.keys(value).length} keys)`;
  return jsonType(value);
}

function keysOf(value: Record<string, unknown>): { keys: Record<string, string>; keysOmitted?: number } {
  const entries = Object.entries(value);
  const keys: Record<string, string> = {};
  for (const [key, item] of entries.slice(0, MAX_OUTLINE_KEYS)) keys[key] = typeLabel(item);
  return entries.length > MAX_OUTLINE_KEYS ? { keys, keysOmitted: entries.length - MAX_OUTLINE_KEYS } : { keys };
}

/** A value's shallow shape; undefined for a value that is not there. */
function shapeOf(value: unknown): WorkflowExpressionShape | undefined {
  if (value === undefined) return undefined;
  const shape: WorkflowExpressionShape = { type: jsonType(value) };
  if (isRecord(value)) Object.assign(shape, keysOf(value));
  if (Array.isArray(value)) {
    shape.length = value.length;
    if (isRecord(value[0])) shape.itemKeys = keysOf(value[0]).keys;
  }
  return shape;
}

/** The block names templates read through `nodes`; `all` when one reads `nodes` itself. */
function nodeReferences(templates: readonly string[]): { all: boolean; names: Set<string>; roots: Set<string>; branch: boolean } {
  const names = new Set<string>();
  const roots = new Set<string>();
  let all = false;
  let branch = false;
  for (const template of templates) {
    for (const segment of parseTemplate(template).segments) {
      if (segment.kind !== "expr") continue;
      roots.add(segment.root);
      if (segment.root === "project" && segment.path[0] === "branch") branch = true;
      if (segment.root !== "nodes") continue;
      const first = segment.path[0];
      if (typeof first === "string") names.add(first);
      else all = true;
    }
  }
  return { all, names, roots, branch };
}

/** engine.ts `handleOf`: the handle a finished block left by. */
function handleOf(state: Pick<BlockState, "handle" | "status">): string | undefined {
  return state.handle ?? (state.status === "succeeded" ? "success" : state.status === "failed" ? "error" : undefined);
}

/** engine.ts `liveInputsOf`: the upstream blocks whose taken edge reaches `nodeId`. */
function liveInputs(workflow: Workflow, states: ReadonlyMap<string, BlockState>, nodeId: string): string[] {
  const out: string[] = [];
  for (const edge of workflow.edges) {
    if (edge.target !== nodeId || out.includes(edge.source)) continue;
    const state = states.get(edge.source);
    if (!state || (state.status !== "succeeded" && state.status !== "failed")) continue;
    if (handleOf(state) !== edge.sourceHandle) continue;
    out.push(edge.source);
  }
  return out;
}

/**
 * engine.ts computeForced: in a workflow with no trigger, every block no connection reaches starts
 * the run and reads the run's input (a manual or sub-workflow run's `trigger.input`).
 */
function isForcedWithRunInput(workflow: Workflow, node: WorkflowNode): boolean {
  const executable = workflow.nodes.filter((candidate) => candidate.type !== "note");
  if (node.type === "note" || executable.some((candidate) => isTriggerType(candidate.type))) return false;
  const ids = new Set(executable.map((candidate) => candidate.id));
  return !workflow.edges.some((edge) => edge.target === node.id && ids.has(edge.source));
}

/** The render budget in UTF-16 units: at most 3 UTF-8 bytes each, cut to the byte cap after. */
const MAX_RENDER_LENGTH = EXPRESSION_PREVIEW_LIMITS.maxRenderedBytes;

function capText(text: string): { text: string; bytes: number; truncated?: true } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= EXPRESSION_PREVIEW_LIMITS.maxRenderedBytes) return { text, bytes };
  return { text: truncateUtf8(text, EXPRESSION_PREVIEW_LIMITS.maxRenderedBytes), bytes, truncated: true };
}

/** Messages redacted and deduplicated, at most MAX_WARNINGS, with how many more there were. */
function capMessages(messages: readonly string[], redactor: SecretRedactor, skip?: ReadonlySet<string>): { list: string[]; omitted: number } {
  const all = new Set<string>();
  for (const message of messages) if (!skip?.has(message)) all.add(redactor.text(message));
  const list = [...all];
  return { list: list.slice(0, MAX_WARNINGS), omitted: Math.max(0, list.length - MAX_WARNINGS) };
}

/** A structural record (its keys are names the engine gives, not data): the values redacted, the keys kept. */
function redactValues(record: Readonly<Record<string, unknown>>, redactor: SecretRedactor): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, redactContextValue(value, redactor)]));
}

export async function previewExpressions(input: ExpressionPreviewInput): Promise<PreviewWorkflowExpressionResponse> {
  const { workflow, request, node, source } = input;
  const redactor = createRedactor(input.secrets);
  const placeholders = Object.fromEntries(Object.keys(input.secrets).map((name) => [name, secretPlaceholder(name)]));
  const refs = nodeReferences(request.templates);
  const notes: string[] = [];

  // Which blocks a template here can read: never the block itself or what comes after it.
  const hidden = new Set<string>();
  if (node) {
    hidden.add(node.id);
    for (const id of downstreamOf(workflow, node.id)) hidden.add(id);
  }

  // Every readable block's state: its pin (usePinned), else what the run recorded.
  const states = new Map<string, BlockState>();
  const pinnedNames: string[] = [];
  for (const candidate of workflow.nodes) {
    if (hidden.has(candidate.id)) continue;
    const pins = workflow.pinned;
    if (request.usePinned && pins && Object.hasOwn(pins, candidate.id) && outputHandles(candidate).includes("success")) {
      states.set(candidate.id, { name: candidate.name, status: "succeeded", handle: "success", output: pins[candidate.id], previewOnly: false });
      pinnedNames.push(candidate.name);
      continue;
    }
    const block: WorkflowBlockRun | undefined = source?.run.blocks[candidate.id];
    if (!block || !isFinishedBlockStatus(block.status)) continue;
    const state: BlockState = { name: candidate.name, status: block.status, output: block.output, previewOnly: block.outputTruncated === true };
    if (block.handle !== undefined) state.handle = block.handle;
    if (block.error !== undefined) state.error = block.error;
    states.set(candidate.id, state);
  }

  // Whole outputs for what the templates read: the named blocks and the block's inputs.
  const inputIds = node ? liveInputs(workflow, states, node.id) : [];
  if (source) {
    for (const [id, state] of states) {
      if (!state.previewOnly) continue;
      if (!refs.all && !refs.names.has(state.name) && !inputIds.includes(id)) continue;
      state.output = await source.output(id);
      state.previewOnly = false;
    }
  }

  // Redacted BEFORE rendering — a transformed value (`| json` escapes, `| upper`) would slip past a
  // text pass — but only the data: block names and the roots' own fields stay keys as the engine
  // gives them, else a name that contains a secret value would read nothing (or not be found).
  const nodes: ReturnType<NodeExecutionContext["expressionContext"]>["nodes"] = {};
  for (const state of states.values()) {
    nodes[state.name] = {
      output: redactContextValue(state.output, redactor),
      status: state.status,
      ...(state.error ? { error: redactValues(state.error as unknown as Record<string, unknown>, redactor) as unknown as WorkflowBlockError } : {})
    };
  }
  const run = source?.run;
  const trigger = run ? run.triggerPayload : TEST_TRIGGER_PAYLOAD;

  // engine.ts inputOf: the live inputs; else, for a block a run forces with the run's input
  // (computeForced: the starting blocks of a workflow with no trigger), that input.
  let blockInput: unknown;
  let rootInput = false;
  if (inputIds.length === 1) blockInput = nodes[states.get(inputIds[0]!)!.name]!.output;
  else if (inputIds.length > 1) blockInput = Object.fromEntries(inputIds.map((id) => [states.get(id)!.name, nodes[states.get(id)!.name]!.output]));
  else if (node && isForcedWithRunInput(workflow, node) && trigger && (trigger.kind === "manual" || trigger.kind === "subworkflow") && trigger.input !== undefined) {
    blockInput = redactContextValue(trigger.input, redactor);
    rootInput = true;
  }

  const attempt = node && run?.blocks[node.id] ? Math.max(1, run.blocks[node.id]!.attempt) : 1;
  const projectPath = run?.projectPath ?? (workflow.project.kind === "existing" ? workflow.project.projectPath : "");
  const redacted: ReturnType<NodeExecutionContext["expressionContext"]> = {
    input: blockInput,
    nodes,
    trigger: isRecord(trigger) ? redactValues(trigger, redactor) : trigger,
    run: redactValues(
      run
        ? { id: run.id, startedAt: run.startedAt ?? run.queuedAt, workflowId: run.workflowId, workflowName: run.workflowName, attempt }
        : { id: "preview", startedAt: input.now.toISOString(), workflowId: workflow.id, workflowName: workflow.name, attempt },
      redactor
    ) as ReturnType<NodeExecutionContext["expressionContext"]>["run"],
    project: redactValues(
      { path: projectPath, name: projectPath ? basename(projectPath) : "", workspace: projectPath ? basename(dirname(projectPath)) : "" },
      redactor
    ) as ReturnType<NodeExecutionContext["expressionContext"]>["project"],
    workflow: redactValues({ id: workflow.id, name: workflow.name }, redactor) as ReturnType<NodeExecutionContext["expressionContext"]>["workflow"]
  };
  const context: ExpressionContext = { ...redacted, secrets: placeholders };

  const hiddenNames = new Map(workflow.nodes.filter((n) => hidden.has(n.id)).map((n) => [n.name, n]));
  const results = request.templates.map((template): WorkflowExpressionPreviewResult => {
    const parsed = parseTemplate(template);
    const errors = capMessages(parsed.errors.map((error) => error.message), redactor);
    const parseWarnings = new Set(parsed.errors.map((error) => `Template error: ${error.message}`));
    const messages = (rendered: readonly string[]) => {
      const warnings = capMessages([...extra, ...rendered], redactor, parseWarnings);
      return {
        warnings: warnings.list,
        ...(warnings.omitted > 0 ? { warningsOmitted: warnings.omitted } : {}),
        errors: errors.list,
        ...(errors.omitted > 0 ? { errorsOmitted: errors.omitted } : {})
      };
    };
    const extra: string[] = [];
    if (node) {
      for (const name of nodeReferences([template]).names) {
        if (!hiddenNames.has(name)) continue;
        extra.push(name === node.name
          ? `nodes.${name} is ${node.name} itself: a block cannot read its own output.`
          : `nodes.${name} runs after ${node.name}: it has no output yet when ${node.name} renders this.`);
      }
    }
    if (request.mode === "value") {
      const rendered = renderTemplateValue(template, context, { maxLength: MAX_RENDER_LENGTH });
      if (rendered.value === undefined) return { missing: true, bytes: 0, ...messages(rendered.warnings) };
      const value = redactContextValue(rendered.value, redactor);
      const json = JSON.stringify(value) ?? "";
      const capped = capText(json);
      const result: WorkflowExpressionPreviewResult = { valueType: jsonType(value), bytes: capped.bytes, ...messages(rendered.warnings) };
      if (capped.truncated || rendered.truncated) Object.assign(result, { valueJson: capped.text, truncated: true });
      else result.value = value;
      return result;
    }
    // The render stops at the cap: a template of many large expressions never builds a huge text.
    const rendered = renderTemplate(template, context, { maxLength: MAX_RENDER_LENGTH });
    const capped = capText(redactor.text(rendered.text));
    return { text: capped.text, bytes: capped.bytes, ...(capped.truncated || rendered.truncated ? { truncated: true } : {}), ...messages(rendered.warnings) };
  });

  // What the context held, shallowly (redacted: keys can carry a value too).
  const outlineNodes: PreviewWorkflowExpressionResponse["available"]["nodes"] = {};
  for (const state of states.values()) {
    const entry = redacted.nodes[state.name]!;
    const view: PreviewWorkflowExpressionResponse["available"]["nodes"][string] = { status: entry.status };
    if (state.previewOnly) {
      view.output = { type: "unknown", note: `A large output the run kept apart: read by no template here. {{ nodes.${state.name}.output | json }} previews it whole.` };
    } else {
      const shape = shapeOf(entry.output);
      if (shape) view.output = shape;
    }
    if (isRecord(entry.error) && typeof entry.error.message === "string") view.error = `${String(entry.error.kind)}: ${entry.error.message.slice(0, 300)}`;
    outlineNodes[state.name] = view;
  }
  const inputShape = shapeOf(redacted.input);
  const triggerShape = shapeOf(redacted.trigger);
  const available: PreviewWorkflowExpressionResponse["available"] = {
    ...(inputShape ? { input: inputShape } : {}),
    ...(triggerShape ? { trigger: triggerShape } : {}),
    nodes: outlineNodes,
    run: { ...redacted.run },
    project: { ...redacted.project },
    workflow: { ...redacted.workflow },
    secrets: Object.keys(input.secrets).sort()
  };

  if (!run) {
    notes.push(
      pinnedNames.length > 0
        ? "No run on record was used: nodes hold only pinned outputs, and trigger reads as a test run's {kind:\"manual\", input:null}."
        : "No run of this workflow is on record: nodes is empty and trigger reads as a test run's {kind:\"manual\", input:null}. Run it (or pin outputs and pass usePinned) to preview real data."
    );
  } else if (run.status === "queued" || run.status === "running") {
    notes.push(`Run ${run.id} is still running: blocks that have not finished are absent from nodes.`);
  }
  if (source?.note) notes.push(source.note);
  if (rootInput && node) {
    notes.push(`${node.name} starts a workflow with no trigger: its input is the run's input (trigger.input).`);
  } else if (node && blockInput === undefined && !isTriggerType(node.type) && node.type !== "note") {
    notes.push(
      isForcedWithRunInput(workflow, node)
        ? `${node.name} starts a workflow with no trigger: its input is the run's input (trigger.input), and this data has none.`
        : `${node.name} received no input in this data: no block before it finished on the handle its edge takes.`
    );
  }
  if (!node && refs.roots.has("input")) notes.push("input reads nothing without a point of view: pass node (the block this template belongs to).");
  if (refs.branch) notes.push("project.branch is not read here: a run reads the project's current branch when the block starts.");
  if (!node || node.type === "agent") {
    notes.push("An agent prompt then replaces its {variables} ({project}, {branch}, …): this preview renders only {{ … }}.");
  }
  if (refs.roots.has("secrets")) notes.push("{{ secrets.NAME }} renders as «secret:NAME» here; a run inserts the value.");

  return {
    results,
    node: node ? { id: node.id, name: node.name, type: node.type } : null,
    source: {
      run: source ? source.how : "none",
      runId: run?.id ?? null,
      ...(run ? { runStatus: run.status, runTest: run.test, runQueuedAt: run.queuedAt } : {}),
      pinned: pinnedNames
    },
    available,
    notes
  };
}
