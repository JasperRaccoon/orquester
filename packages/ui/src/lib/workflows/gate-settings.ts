/**
 * The gate inspector's edits, as pure recipes (spec 2026-11-10 §6.1): a new
 * choice with a fresh id, renaming a choice's id (the edges drawn from its
 * `choice:<id>` output and the timeout naming it follow), removing one (its
 * edges go with it), and the sections' one-line summaries.
 */

import type { GateBlockConfig, Workflow, WorkflowGateChoice, WorkflowGateDecider } from "@orquester/api";
import { WORKFLOW_CHOICE_ID_PATTERN } from "@orquester/config";

import { formatMinutes } from "./durations";

/** A choice id from a label: "Ship it!" → "ship_it", "2nd" → "c_2nd"; "" when nothing usable is left. */
export function choiceIdFrom(label: string): string {
  let id = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (id && !/^[a-z]/.test(id)) id = `c_${id}`.slice(0, 40);
  return WORKFLOW_CHOICE_ID_PATTERN.test(id) ? id : "";
}

/** The next choice: "Choice N" with an id no other choice has. */
export function newChoice(ids: readonly string[]): WorkflowGateChoice {
  let n = ids.length + 1;
  while (ids.includes(`choice_${n}`)) n += 1;
  return { id: `choice_${n}`, label: `Choice ${n}`, comment: "none" };
}

function gateConfig(workflow: Workflow, nodeId: string): GateBlockConfig | null {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  return node && node.type === "gate" ? node.config : null;
}

function withConfig(workflow: Workflow, nodeId: string, config: GateBlockConfig): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => (node.id === nodeId && node.type === "gate" ? { ...node, config } : node))
  };
}

/**
 * Choice `from` becomes `to`: its config entry, every edge leaving
 * `choice:<from>`, and a timeout that takes it. Unchanged when `to` is not a
 * valid, unused id.
 */
export function renameChoice(workflow: Workflow, nodeId: string, from: string, to: string): Workflow {
  const config = gateConfig(workflow, nodeId);
  if (!config || from === to || !WORKFLOW_CHOICE_ID_PATTERN.test(to)) return workflow;
  if (!config.choices.some((choice) => choice.id === from) || config.choices.some((choice) => choice.id === to)) return workflow;
  const timeout =
    config.timeout?.then.kind === "choice" && config.timeout.then.choice === from
      ? { ...config.timeout, then: { ...config.timeout.then, choice: to } }
      : config.timeout;
  const next: GateBlockConfig = {
    ...config,
    choices: config.choices.map((choice) => (choice.id === from ? { ...choice, id: to } : choice)),
    ...(timeout ? { timeout } : {})
  };
  const renamed = withConfig(workflow, nodeId, next);
  return {
    ...renamed,
    edges: renamed.edges.map((edge) =>
      edge.source === nodeId && edge.sourceHandle === `choice:${from}` ? { ...edge, sourceHandle: `choice:${to}` } : edge
    )
  };
}

/** Choice `id` goes, with the edges drawn from its output. A timeout naming it is left for validation to point at. */
export function removeChoice(workflow: Workflow, nodeId: string, id: string): Workflow {
  const config = gateConfig(workflow, nodeId);
  if (!config || !config.choices.some((choice) => choice.id === id)) return workflow;
  const removed = withConfig(workflow, nodeId, { ...config, choices: config.choices.filter((choice) => choice.id !== id) });
  return { ...removed, edges: removed.edges.filter((edge) => !(edge.source === nodeId && edge.sourceHandle === `choice:${id}`)) };
}

/** "You", "A reviewer agent · at most 1 h · Profile", "The chat that started the run · at most 1 h". */
export function gateDeciderSummary(decider: WorkflowGateDecider, profileLabel: (profileId: string | undefined) => string): string {
  if (decider.kind === "human") return "You";
  const limit = `at most ${formatMinutes(decider.maxMinutes)}, then you`;
  if (decider.kind === "launcher") return `The chat that started the run · ${limit}`;
  return [`A reviewer agent`, limit, ...(decider.profileId ? [profileLabel(decider.profileId)] : [])].join(" · ");
}

/** "Fails after 7 days" / "After 1 day: takes “Reject”" / "After 2 h: fails". */
export function gateTimeoutSummary(config: Pick<GateBlockConfig, "timeout" | "choices">): string {
  const timeout = config.timeout;
  if (!timeout) return "Fails after 7 days";
  const after = `After ${formatMinutes(timeout.minutes)}`;
  if (timeout.then.kind === "fail") return `${after}: fails`;
  const choice = timeout.then.choice;
  const label = config.choices.find((candidate) => candidate.id === choice)?.label || choice;
  return `${after}: takes “${label}”`;
}
