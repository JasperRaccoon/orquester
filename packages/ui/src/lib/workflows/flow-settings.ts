/**
 * The pure side of the flow block forms (inspector/FlowSettings.tsx): rule
 * and case summaries, Switch case-label notes, the Merge output example, the
 * Wait block's kind switch and time zone labels.
 */

import type { Workflow, WorkflowRule } from "@orquester/api";

import { ruleText } from "./catalog-ui";

/** "input.status = "done"", "2 rules · all must hold", "3 rules · any one is enough". */
export function rulesSummary(combine: "all" | "any", rules: readonly WorkflowRule[]): string {
  if (rules.length === 0) return "No rules";
  if (rules.length === 1) return ruleText(rules[0]!);
  return `${rules.length} rules · ${combine === "all" ? "all must hold" : "any one is enough"}`;
}

/** What a Switch case's output is called (graph.ts `workflowHandleLabel`): its label, else "case N". */
export function caseOutputName(label: string, index: number): string {
  return label.trim().length > 0 ? label.trim() : `case ${index + 1}`;
}

/**
 * A note under a Switch case's label: none when it is unique; the name its
 * output falls back to when empty; a warning when another case has the same
 * label (their outputs would look alike on the canvas).
 */
export function caseLabelNote(labels: readonly string[], index: number): { hint: string | null; warning: string | null } {
  const label = labels[index]?.trim() ?? "";
  if (label.length === 0) return { hint: `No label — its output is called “case ${index + 1}”.`, warning: null };
  const twin = labels.findIndex((other, at) => at !== index && other.trim().toLowerCase() === label.toLowerCase());
  if (twin !== -1) return { hint: null, warning: `Case ${twin + 1} has the same label, so their outputs look alike on the canvas.` };
  return { hint: null, warning: null };
}

/** The names of the blocks wired into `nodeId`, once each, in connection order. */
export function incomingBlockNames(workflow: Pick<Workflow, "nodes" | "edges">, nodeId: string): string[] {
  const names: string[] = [];
  for (const edge of workflow.edges) {
    if (edge.target !== nodeId) continue;
    const source = workflow.nodes.find((candidate) => candidate.id === edge.source);
    if (source && !names.includes(source.name)) names.push(source.name);
  }
  return names;
}

/** `{ "Fetch": …, "Review": … }` — a Merge's output, by the names of the blocks wired into it (two stand-ins when none are). */
export function mergeOutputExample(names: readonly string[]): string {
  const shown = names.length > 0 ? names : ["BlockA", "BlockB"];
  return `{ ${shown.map((name) => `"${name}": …`).join(", ")} }`;
}

export type WaitConfig =
  | ({ kind: "duration"; minutes: number } & Record<string, unknown>)
  | ({ kind: "until"; time: string; timezone?: string } & Record<string, unknown>);

/**
 * A Wait config switched to `kind`: the other kind's own fields go, anything
 * else it carried (fields a newer version wrote) stays. A duration starts at
 * 5 min, a time of day at 09:00.
 */
export function waitConfigForKind(current: WaitConfig, kind: "duration" | "until"): WaitConfig {
  if (current.kind === kind) return current;
  const { kind: _kind, minutes: _minutes, time: _time, timezone: _timezone, ...rest } = current as Record<string, unknown>;
  return kind === "duration" ? { ...rest, kind: "duration", minutes: 5 } : { ...rest, kind: "until", time: "09:00" };
}

/** "America/New_York" → "America/New York". */
export function timeZoneLabel(zone: string): string {
  return zone.replace(/_/g, " ");
}
