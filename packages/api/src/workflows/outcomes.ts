// Automated workflows — an agent block's typed outcomes and outputs (spec 2026-11-10 §5): whether a
// block needs a report, how a `report_step_result` call is checked against its declarations, and the
// handle a disabled or pinned block with outcomes takes (§7.5). Pure; shared by the daemon (the
// engine and the tool), the validator and the editor.

import { agentOutcomeIds, choiceHandle, gateChoiceIds, outcomeHandle, outputHandles } from "./graph.ts";
import { WORKFLOW_LIMITS, type WorkflowNode, type WorkflowOutcomeDecl, type WorkflowOutputDecl } from "./types.ts";

type NodeLike = Pick<WorkflowNode, "id" | "type"> & { config?: unknown };

/** What a block declares for its report (the agent config's `outcomes` / `outputs`). */
export interface StepReportDecl {
  outcomes?: readonly WorkflowOutcomeDecl[];
  outputs?: readonly WorkflowOutputDecl[];
}

/** The declarations of an agent block's config; other blocks declare none. */
export function stepReportDecl(node: NodeLike): StepReportDecl {
  if (node.type !== "agent") return {};
  const config = (node.config ?? {}) as { outcomes?: unknown; outputs?: unknown };
  return {
    ...(Array.isArray(config.outcomes) ? { outcomes: config.outcomes as WorkflowOutcomeDecl[] } : {}),
    ...(Array.isArray(config.outputs) ? { outputs: config.outputs as WorkflowOutputDecl[] } : {})
  };
}

/** A block that declared outcomes or outputs must report with `report_step_result` (§5.1). */
export function reportRequired(decl: StepReportDecl): boolean {
  return (decl.outcomes?.length ?? 0) > 0 || (decl.outputs?.length ?? 0) > 0;
}

/** An output's `required`: absent = true (unlike inputs). */
export function outputRequired(output: Pick<WorkflowOutputDecl, "required">): boolean {
  return output.required !== false;
}

/** "a", "a or b", "a, b or c" — a list of allowed values, each in backticks. */
function oneOf(values: readonly string[]): string {
  const quoted = values.map((value) => `\`${value}\``);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
}

/** An output's type in words, for the protocol block and the errors. */
export function outputTypeText(output: Pick<WorkflowOutputDecl, "type" | "values">): string {
  if (output.type === "enum") return `one of ${oneOf(output.values ?? [])}`;
  if (output.type === "json") return "any JSON value";
  return `a ${output.type}`;
}

/**
 * One value against its declared type: numbers and booleans may come as their text (`"42"`,
 * `"true"`/`"false"` — agents send strings), nothing else is coerced (§4.2). `json` takes anything.
 */
export function coerceOutputValue(output: Pick<WorkflowOutputDecl, "type" | "values">, value: unknown): { ok: true; value: unknown } | { ok: false } {
  switch (output.type) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : { ok: false };
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return { ok: true, value };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return { ok: true, value: Number(value.trim()) };
      return { ok: false };
    }
    case "boolean":
      if (typeof value === "boolean") return { ok: true, value };
      if (value === "true") return { ok: true, value: true };
      if (value === "false") return { ok: true, value: false };
      return { ok: false };
    case "enum":
      return typeof value === "string" && (output.values ?? []).includes(value) ? { ok: true, value } : { ok: false };
    case "json":
      return value === undefined ? { ok: false } : { ok: true, value };
    default:
      return { ok: false };
  }
}

/** A `report_step_result` call's arguments, as the agent sent them. */
export interface StepReportArgs {
  outcome?: unknown;
  summary?: unknown;
  outputs?: unknown;
}

export type StepReportCheck =
  | { ok: true; report: { outcome?: string; summary: string; outputs?: Record<string, unknown> } }
  | { ok: false; problems: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Check a report against the block's declarations (§5.2): the outcome is a declared id (required when
 * outcomes are declared, refused when none are), the summary is text of at most
 * `reportSummaryChars`, every required output is present, each output fits its type (with §4.2's
 * coercion) and enum values, and there is no undeclared output. Every problem is listed, each naming
 * what is allowed.
 */
export function checkStepReport(decl: StepReportDecl, args: StepReportArgs): StepReportCheck {
  const problems: string[] = [];
  const outcomes = (decl.outcomes ?? []).map((outcome) => outcome.id);
  const declaredOutputs = decl.outputs ?? [];

  let outcome: string | undefined;
  if (outcomes.length > 0) {
    if (args.outcome === undefined || args.outcome === null || args.outcome === "") {
      problems.push(`outcome is required: one of ${oneOf(outcomes)}.`);
    } else if (typeof args.outcome !== "string" || !outcomes.includes(args.outcome)) {
      problems.push(`outcome ${JSON.stringify(args.outcome).slice(0, 60)} is not one of this step's outcomes: use ${oneOf(outcomes)}.`);
    } else outcome = args.outcome;
  } else if (args.outcome !== undefined && args.outcome !== null && args.outcome !== "") {
    problems.push("This step declares no outcomes: leave outcome out.");
  }

  let summary = "";
  if (typeof args.summary !== "string" || args.summary.trim() === "") {
    problems.push("summary is required: a short text saying what you did and found.");
  } else if (args.summary.length > WORKFLOW_LIMITS.reportSummaryChars) {
    problems.push(`summary is ${args.summary.length} characters; at most ${WORKFLOW_LIMITS.reportSummaryChars}.`);
  } else summary = args.summary.trim();

  const outputs: Record<string, unknown> = {};
  const given = args.outputs === undefined || args.outputs === null ? {} : args.outputs;
  if (!isRecord(given)) {
    problems.push(
      declaredOutputs.length > 0
        ? `outputs must be an object with ${oneOf(declaredOutputs.map((output) => output.name))}.`
        : "This step declares no outputs: leave outputs out."
    );
  } else {
    const names = new Set(declaredOutputs.map((output) => output.name));
    const unknown = Object.keys(given).filter((key) => !names.has(key));
    if (unknown.length > 0) {
      problems.push(
        names.size > 0
          ? `Unknown output${unknown.length === 1 ? "" : "s"} ${oneOf(unknown.map((key) => key.slice(0, 40)))}: this step's outputs are ${oneOf([...names])}.`
          : "This step declares no outputs: leave outputs out."
      );
    }
    for (const output of declaredOutputs) {
      const has = Object.prototype.hasOwnProperty.call(given, output.name) && given[output.name] !== undefined && given[output.name] !== null;
      if (!has) {
        if (outputRequired(output)) problems.push(`outputs.${output.name} is required: ${outputTypeText(output)}.`);
        continue;
      }
      const coerced = coerceOutputValue(output, given[output.name]);
      if (!coerced.ok) problems.push(`outputs.${output.name} must be ${outputTypeText(output)}.`);
      else outputs[output.name] = coerced.value;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    report: {
      ...(outcome !== undefined ? { outcome } : {}),
      summary,
      ...(declaredOutputs.length > 0 ? { outputs } : {})
    }
  };
}

/**
 * The handle a disabled block passes through on (§7.5): a gate takes its first choice, an agent
 * block with outcomes its first outcome; every other block `success` (a trigger's only handle).
 */
export function passThroughHandle(node: NodeLike): string {
  // A disabled gate takes its first choice (spec 2026-11-10 §7.5).
  const choices = gateChoiceIds(node);
  if (choices.length > 0) return choiceHandle(choices[0]!);
  const outcomes = agentOutcomeIds(node);
  return outcomes.length > 0 ? outcomeHandle(outcomes[0]!) : "success";
}

/**
 * The handle a pinned output takes (§7.5): `success` for a block that has one; for an agent block
 * with outcomes, the pin's `outcome`, and for a gate its `choice` (each must be a declared id). Null when the pin cannot stand
 * in for the block (no `success` handle, or an agent pin without a valid `outcome`).
 */
export function pinnedHandle(node: NodeLike, value: unknown): string | null {
  // A pinned gate takes the choice its pin names (§7.5); a pin without a valid one is not used.
  if (node.type === "gate") {
    const choice = isRecord(value) ? value.choice : undefined;
    return typeof choice === "string" && gateChoiceIds(node).includes(choice) ? choiceHandle(choice) : null;
  }
  const outcomes = agentOutcomeIds(node);
  if (outcomes.length > 0) {
    const outcome = isRecord(value) ? value.outcome : undefined;
    return typeof outcome === "string" && outcomes.includes(outcome) ? outcomeHandle(outcome) : null;
  }
  return outputHandles(node).includes("success") ? "success" : null;
}

/** Why a pin on an agent block with outcomes cannot be used, or null when it can (the validator and the inspector). */
export function pinnedOutcomeProblem(node: NodeLike, value: unknown): string | null {
  const outcomes = agentOutcomeIds(node);
  if (outcomes.length === 0) return null;
  const outcome = isRecord(value) ? value.outcome : undefined;
  if (typeof outcome === "string" && outcomes.includes(outcome)) return null;
  return `pinned data must include "outcome": one of ${oneOf(outcomes)} — it picks the handle the run takes`;
}
