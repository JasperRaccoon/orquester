// Automated workflows — a summary row's error fields from a validation's problems. Apart from
// `validate.ts` so a client reading summaries (the rail, the sidebar) does not load the validator.

import { WORKFLOW_SUMMARY_MAX_ERRORS, type WorkflowProblem, type WorkflowSummary } from "./types.ts";

/**
 * A `WorkflowSummary`'s error fields from a validation: the count, the first errors (each copied
 * field-wise), and how many of them are left out. `errors` / `errorsOmitted` are absent when empty.
 * One derivation for the daemon's rows and a client's own row from a write answer.
 */
export function workflowSummaryErrors(
  problems: readonly WorkflowProblem[]
): Pick<WorkflowSummary, "errorCount" | "errors" | "errorsOmitted"> {
  const errors = problems.filter((problem) => problem.severity === "error");
  if (errors.length === 0) return { errorCount: 0 };
  const shown = errors.slice(0, WORKFLOW_SUMMARY_MAX_ERRORS).map((problem) => {
    const copy: WorkflowProblem = { severity: "error", code: problem.code, message: problem.message };
    if (problem.nodeId !== undefined) copy.nodeId = problem.nodeId;
    if (problem.edgeId !== undefined) copy.edgeId = problem.edgeId;
    if (problem.field !== undefined) copy.field = problem.field;
    return copy;
  });
  const omitted = errors.length - shown.length;
  return { errorCount: errors.length, errors: shown, ...(omitted > 0 ? { errorsOmitted: omitted } : {}) };
}
