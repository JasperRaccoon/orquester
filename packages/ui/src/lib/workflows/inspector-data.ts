/**
 * The inspector's Data tab (workflows spec §7.2, §7.6): what a block received
 * and produced in a run. A run records each block's output; its input is what
 * the engine hands it — the output of its single live upstream block, or, with
 * several, `{ [blockName]: output }` of every one that took the edge.
 *
 * Pure.
 */

import {
  isTriggerType,
  outputHandles,
  WORKFLOW_LIMITS,
  type RunWorkflowResponse,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowNode
} from "@orquester/api";

export type BlockInput =
  | { kind: "none" }
  | { kind: "single"; from: string; value: unknown }
  | { kind: "merged"; value: Record<string, unknown> };

/** The input `nodeId` saw in a run with these block records (edges from the run's frozen definition). */
export function blockInputOf(
  blocks: Readonly<Record<string, WorkflowBlockRun>>,
  workflow: Pick<Workflow, "nodes" | "edges">,
  nodeId: string,
  takenEdges?: readonly string[]
): BlockInput {
  const taken = takenEdges && takenEdges.length > 0 ? new Set(takenEdges) : null;
  const live = new Map<string, unknown>();
  for (const edge of workflow.edges) {
    if (edge.target !== nodeId) continue;
    const source = blocks[edge.source];
    if (!source || (source.status !== "succeeded" && source.status !== "failed")) continue;
    if (taken ? !taken.has(edge.id) : (source.handle ?? (source.status === "succeeded" ? "success" : "error")) !== edge.sourceHandle) continue;
    const name = workflow.nodes.find((node) => node.id === edge.source)?.name ?? source.name;
    live.set(name, source.output);
  }
  if (live.size === 0) return { kind: "none" };
  if (live.size === 1) {
    const [from, value] = [...live.entries()][0]!;
    return { kind: "single", from, value };
  }
  return { kind: "merged", value: Object.fromEntries(live) };
}

/** Parse a pinned-output editor's text: JSON within the pinned-data size limit, or an error to show. */
export function parsePinnedText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: false, error: "Write the output as JSON, e.g. { \"text\": \"…\" }." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  // `set_pinned` with null removes the pin, so null can't be a pinned output.
  if (value === null) return { ok: false, error: "null can't be pinned (pinning nothing removes the pin). Write a value, e.g. {}." };
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > WORKFLOW_LIMITS.maxPinnedBytes) {
    return { ok: false, error: `Too big to pin: pinned data is limited to ${WORKFLOW_LIMITS.maxPinnedBytes / 1024} KiB of JSON.` };
  }
  return { ok: true, value };
}

/**
 * Whether a block's output can be pinned — used in place of running it when a
 * block after it is tested. Only blocks that finish on a plain "success"
 * output: the engine never uses a pin on a trigger, an If / Switch (they pick
 * a branch) or a Stop (nothing comes after it).
 */
export function canPin(node: Pick<WorkflowNode, "id" | "type" | "config">): boolean {
  return !isTriggerType(node.type) && node.type !== "note" && outputHandles(node).includes("success");
}

/**
 * The text a new pinned output starts from: the latest run's output when it
 * is there whole (a preview is not the real answer) and pinnable (not null),
 * else an empty object.
 */
export function pinDraftText(block: Pick<WorkflowBlockRun, "output" | "outputTruncated"> | undefined): string {
  if (block && pinnableValue(block.output) && !block.outputTruncated) return JSON.stringify(block.output, null, 2) ?? "{}";
  return "{}";
}

/** Whether a value can be pinned: `set_pinned` treats null (and a missing value) as "unpin". */
export function pinnableValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** `{{ nodes.<Name>.output }}` — how a later block reads this one's output. */
export function outputReference(name: string): string {
  return `{{ nodes.${name}.output }}`;
}

/** What "Test block" says once the daemon has answered. */
export function testStartedNote(answer: RunWorkflowResponse): string {
  if (answer.runId) return "Test run started.";
  if (answer.skipped === "overlap") return "Not started: this workflow is already running, and its overlap setting skips new runs.";
  if (answer.skipped === "missed") return "Not started: the daemon skipped it.";
  return "Not started: the daemon started no run.";
}

/**
 * The output to pin from a run's block: its recorded output when it is whole;
 * when the run kept only a preview (`outputTruncated`), the whole output read
 * from the daemon — never the preview, which a test run would then use as if
 * it were the block's real answer.
 */
export async function pinnableOutputOf(
  block: Pick<WorkflowBlockRun, "output" | "outputTruncated">,
  readWhole: () => Promise<{ output?: unknown } | unknown>
): Promise<unknown> {
  if (!block.outputTruncated) return block.output;
  const answer = await readWhole();
  if (answer === null || typeof answer !== "object" || !("output" in answer)) {
    throw new Error("The daemon did not return the whole output.");
  }
  return (answer as { output: unknown }).output;
}
