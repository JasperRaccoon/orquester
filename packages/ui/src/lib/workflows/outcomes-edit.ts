/**
 * The agent block's Outcomes and Outputs editors (spec 2026-11-10 §5.1) as
 * pure edits over a definition: an outcome's id is part of its handle
 * (`outcome:<id>`), so renaming one carries its connections along, removing
 * one drops them, and turning outcomes on or off moves the block's `success`
 * connections onto the first outcome and back. Ids and names are kept valid
 * as they are typed — the daemon cannot store a definition whose ids break
 * the schema — and a typed id that would collide is refused.
 */

import { WORKFLOW_OUTCOME_ID_PATTERN, WORKFLOW_VALUE_NAME_PATTERN } from "@orquester/config";
import {
  WORKFLOW_LIMITS,
  outcomeHandle,
  type AgentBlockConfig,
  type Workflow,
  type WorkflowOutcomeDecl,
  type WorkflowOutputDecl,
  type WorkflowOutputType
} from "@orquester/api";

type Graph = Pick<Workflow, "nodes" | "edges">;

/** Text typed as an outcome id, made into one: lowercase, other characters as `_`, starting with a letter, ≤ 40. Null when nothing is left. */
export function toOutcomeId(text: string): string | null {
  const id = text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
  return WORKFLOW_OUTCOME_ID_PATTERN.test(id) ? id : null;
}

/** Text typed as an output name, made into one (letters keep their case). Null when nothing is left. */
export function toOutputName(text: string): string | null {
  const name = text
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, 40);
  return WORKFLOW_VALUE_NAME_PATTERN.test(name) ? name : null;
}

/** The first `base`, `base_2`, `base_3`… not in `taken`. */
function freeId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 36)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The outcomes a block gets when outcomes are turned on: the usual pair. */
export const DEFAULT_OUTCOMES: readonly WorkflowOutcomeDecl[] = [
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked", description: "It could not finish the task." }
];

/** A new outcome after the others, with an id none of them has. */
export function newOutcome(outcomes: readonly WorkflowOutcomeDecl[]): WorkflowOutcomeDecl {
  const id = freeId("outcome", new Set(outcomes.map((outcome) => outcome.id)));
  return { id };
}

/** A new output after the others, a text by default. */
export function newOutput(outputs: readonly WorkflowOutputDecl[]): WorkflowOutputDecl {
  return { name: freeId("value", new Set(outputs.map((output) => output.name))), type: "string" };
}

export function canAddOutcome(outcomes: readonly WorkflowOutcomeDecl[]): boolean {
  return outcomes.length < WORKFLOW_LIMITS.outcomes.max;
}

export function canRemoveOutcome(outcomes: readonly WorkflowOutcomeDecl[]): boolean {
  return outcomes.length > WORKFLOW_LIMITS.outcomes.min;
}

export function canAddOutput(outputs: readonly WorkflowOutputDecl[]): boolean {
  return outputs.length < WORKFLOW_LIMITS.maxOutputs;
}

function configOf(graph: Graph, nodeId: string): AgentBlockConfig | null {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === "agent" ? node.config : null;
}

function withConfig<G extends Graph>(graph: G, nodeId: string, config: AgentBlockConfig): G {
  return { ...graph, nodes: graph.nodes.map((node) => (node.id === nodeId && node.type === "agent" ? { ...node, config } : node)) };
}

/** Move edges from one handle of `nodeId` to another (null drops them), never leaving two equal edges. */
function moveEdges<G extends Graph>(graph: G, nodeId: string, from: string, to: string | null): G {
  const seen = new Set(graph.edges.filter((edge) => edge.source === nodeId && edge.sourceHandle !== from).map((edge) => `${edge.sourceHandle}\u0000${edge.target}`));
  const edges = graph.edges.flatMap((edge) => {
    if (edge.source !== nodeId || edge.sourceHandle !== from) return [edge];
    if (to === null) return [];
    const key = `${to}\u0000${edge.target}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, sourceHandle: to }];
  });
  return { ...graph, edges };
}

/** Turn outcomes on (the default pair): the block's `success` connections go to the first outcome. */
export function enableOutcomes<G extends Graph>(graph: G, nodeId: string): G {
  const config = configOf(graph, nodeId);
  if (!config || (config.outcomes?.length ?? 0) > 0) return graph;
  const outcomes = DEFAULT_OUTCOMES.map((outcome) => ({ ...outcome }));
  return moveEdges(withConfig(graph, nodeId, { ...config, outcomes }), nodeId, "success", outcomeHandle(outcomes[0]!.id));
}

/** Turn outcomes off: the first outcome's connections become `success` ones, the others' go. */
export function disableOutcomes<G extends Graph>(graph: G, nodeId: string): G {
  const config = configOf(graph, nodeId);
  if (!config || config.outcomes === undefined) return graph;
  const { outcomes, ...rest } = config;
  let next = withConfig(graph, nodeId, rest as AgentBlockConfig);
  outcomes.forEach((outcome, index) => {
    next = moveEdges(next, nodeId, outcomeHandle(outcome.id), index === 0 ? "success" : null);
  });
  return next;
}

/**
 * Rename the outcome at `index` from typed text. Its connections follow it. Refused (null) when
 * the text makes no id, or the id is another outcome's.
 */
export function renameOutcome<G extends Graph>(graph: G, nodeId: string, index: number, text: string): G | null {
  const config = configOf(graph, nodeId);
  const outcomes = config?.outcomes;
  const current = outcomes?.[index];
  if (!config || !outcomes || !current) return null;
  const id = toOutcomeId(text);
  if (id === null || outcomes.some((outcome, i) => i !== index && outcome.id === id)) return null;
  if (id === current.id) return graph;
  const next = withConfig(graph, nodeId, { ...config, outcomes: outcomes.map((outcome, i) => (i === index ? { ...outcome, id } : outcome)) });
  return moveEdges(next, nodeId, outcomeHandle(current.id), outcomeHandle(id));
}

/** Remove the outcome at `index` and its connections (never below the minimum of 2). */
export function removeOutcome<G extends Graph>(graph: G, nodeId: string, index: number): G {
  const config = configOf(graph, nodeId);
  const outcomes = config?.outcomes;
  const removed = outcomes?.[index];
  if (!config || !outcomes || !removed || !canRemoveOutcome(outcomes)) return graph;
  const next = withConfig(graph, nodeId, { ...config, outcomes: outcomes.filter((_, i) => i !== index) });
  return moveEdges(next, nodeId, outcomeHandle(removed.id), null);
}

/** Swap the outcome at `index` with its neighbour (`delta` ±1): the handles' order on the canvas follows. */
export function moveOutcome<G extends Graph>(graph: G, nodeId: string, index: number, delta: -1 | 1): G {
  const config = configOf(graph, nodeId);
  const outcomes = config?.outcomes;
  const target = index + delta;
  if (!config || !outcomes || target < 0 || target >= outcomes.length) return graph;
  const moved = [...outcomes];
  [moved[index], moved[target]] = [moved[target]!, moved[index]!];
  return withConfig(graph, nodeId, { ...config, outcomes: moved });
}

/** An output's type changed: `values` belong to an enum only (an enum starts with one to fill in). */
export function withOutputType(output: WorkflowOutputDecl, type: WorkflowOutputType): WorkflowOutputDecl {
  const { values, ...rest } = output;
  if (type !== "enum") return { ...rest, type };
  return { ...rest, type, values: values && values.length > 0 ? values : ["option"] };
}

/** Enum values from the comma- or line-separated text the editor shows: trimmed, empties and repeats left out. */
export function parseEnumValues(text: string): string[] {
  const values: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const value = raw.trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

/** The editor's one-line summary of an agent block's outcomes and outputs. */
export function reportSummary(config: Pick<AgentBlockConfig, "outcomes" | "outputs">): string {
  const outcomes = config.outcomes ?? [];
  const outputs = config.outputs ?? [];
  if (outcomes.length === 0 && outputs.length === 0) return "No report: one “success” output";
  const parts: string[] = [];
  if (outcomes.length > 0) parts.push(`${outcomes.length} outcomes: ${outcomes.map((outcome) => outcome.label?.trim() || outcome.id).join(", ")}`);
  if (outputs.length > 0) parts.push(`${outputs.length} ${outputs.length === 1 ? "output" : "outputs"}: ${outputs.map((output) => output.name).join(", ")}`);
  return parts.join(" · ");
}
