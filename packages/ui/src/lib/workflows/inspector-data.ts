/**
 * The inspector's Data tab (workflows spec §7.2, §7.6): what a block received
 * and produced in a run. A run records each block's output; its input is what
 * the engine hands it — the output of its single live upstream block, or, with
 * several, `{ [blockName]: output }` of every one that took the edge.
 *
 * Pure.
 */

import type { Workflow, WorkflowBlockRun } from "@orquester/api";

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

/** Parse a pinned-output editor's text: JSON, or an error to show. */
export function parsePinnedText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: false, error: "Write the output as JSON, e.g. { \"text\": \"…\" }." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
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
