// Automated workflows — the agent block's reporting protocol (spec 2026-11-10 §5.3): the protocol
// block appended to a prompt when the block declares `outcomes` / `outputs`, the one reminder turn
// sent when a turn settles without a report, and the block output's report fields (§5.4).
//
// Kept apart from the executor's state machine on purpose: the executor only asks "does this block
// report?", "what to append", "what to remind with" and "what did it report?"; the loop work
// (spec §7.3, a follow-up turn into the previous pass's session) applies the same protocol again by
// calling `withStepProtocol` on its own message.

import {
  outcomeHandle,
  outputRequired,
  outputTypeText,
  reportRequired,
  WORKFLOW_LIMITS,
  type AgentBlockConfig,
  type WorkflowStepReport
} from "@orquester/api";

/** The block declares outcomes or outputs, so its agent must call `report_step_result`. */
export function blockReports(config: Pick<AgentBlockConfig, "outcomes" | "outputs">): boolean {
  return reportRequired(config);
}

/** One line of help text, flattened (an author's description may span lines). */
function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The protocol block (§5.3): the allowed outcomes with their descriptions, the outputs with their
 * types, the call to make as the last action, and not to end the turn to wait on background work.
 */
export function stepProtocolBlock(config: Pick<AgentBlockConfig, "outcomes" | "outputs">): string {
  const outcomes = config.outcomes ?? [];
  const outputs = config.outputs ?? [];
  const lines: string[] = ["This step reports its result with the `report_step_result` tool (Orquester)."];
  if (outcomes.length > 0) {
    lines.push("", "Pick exactly one `outcome`:");
    for (const outcome of outcomes) {
      const label = oneLine(outcome.label);
      const description = oneLine(outcome.description);
      lines.push(`- \`${outcome.id}\`${label && label !== outcome.id ? ` (${label})` : ""}${description ? `: ${description}` : ""}`);
    }
  }
  if (outputs.length > 0) {
    lines.push("", "Fill `outputs` with:");
    for (const output of outputs) {
      const description = oneLine(output.description);
      lines.push(`- \`${output.name}\` (${outputTypeText(output)}${outputRequired(output) ? ", required" : ", optional"})${description ? `: ${description}` : ""}`);
    }
  }
  lines.push(
    "",
    `Give a \`summary\` (at most ${WORKFLOW_LIMITS.reportSummaryChars} characters) of what you did and found.`,
    "Call `report_step_result` once your work is done, as your last action; if it refuses the call, fix what it names and call it again. Do not end your turn to wait on background work: finish it first."
  );
  return lines.join("\n");
}

/** A message plus the protocol block, when the block reports (else the message unchanged). */
export function withStepProtocol(text: string, config: Pick<AgentBlockConfig, "outcomes" | "outputs">): string {
  return blockReports(config) ? `${text}\n\n${stepProtocolBlock(config)}` : text;
}

/** The one reminder turn (§5.3): sent in the same session when a turn settled with no report. */
export function reminderMessage(config: Pick<AgentBlockConfig, "outcomes" | "outputs">): string {
  return `Your turn ended without a report. Call \`report_step_result\` now — it is required to finish this workflow step; without it the step fails.\n\n${stepProtocolBlock(config)}`;
}

/** The fields a report adds to the block's output (§5.4). */
export function reportOutputFields(report: WorkflowStepReport): { outcome?: string; summary: string; outputs?: Record<string, unknown> } {
  return {
    ...(report.outcome !== undefined ? { outcome: report.outcome } : {}),
    summary: report.summary,
    ...(report.outputs !== undefined ? { outputs: structuredClone(report.outputs) } : {})
  };
}

/** The handle a reported block finishes on: its outcome's, else `success` (outputs only). */
export function reportHandle(report: WorkflowStepReport): string {
  return report.outcome !== undefined ? outcomeHandle(report.outcome) : "success";
}

/** The `no_report` failure's message (§5.3). */
export function noReportMessage(): string {
  return "The agent ended its turn twice without calling report_step_result (once after a reminder), so this step has no result.";
}
