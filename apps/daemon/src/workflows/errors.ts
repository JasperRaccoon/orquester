// Automated workflows — the one error type every workflow route answers with (spec §8.1).
//
// A `WorkflowError` carries its HTTP status, a stable machine code (`WorkflowErrorCode`) and a
// message for people; `INVALID_WORKFLOW` also carries the validation problems. The routes turn it
// into `{ error: { code, message, problems? } }` (`WorkflowErrorBody`). Anything else a route
// throws is a 500 with a generic message — never the exception's text, which could quote a value
// the daemon holds (a secret, a path outside the sandbox).

import type { WorkflowErrorBody, WorkflowErrorCode, WorkflowProblem } from "@orquester/api";

export type WorkflowErrorStatus = 400 | 404 | 409 | 413 | 500 | 503;

export class WorkflowError extends Error {
  constructor(
    readonly status: WorkflowErrorStatus,
    readonly code: WorkflowErrorCode,
    message: string,
    readonly problems?: WorkflowProblem[],
    /** The op (patch) or entry (create: nodes, then edges) a refusal names. */
    readonly opIndex?: number
  ) {
    super(message);
    this.name = "WorkflowError";
  }

  body(): WorkflowErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.problems !== undefined ? { problems: this.problems } : {}),
        ...(this.opIndex !== undefined ? { opIndex: this.opIndex } : {})
      }
    };
  }
}

/** A user-supplied string quoted in an error message, bounded. */
export function excerpt(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const workflowNotFound = (id: string): WorkflowError =>
  new WorkflowError(404, "WORKFLOW_NOT_FOUND", `No workflow with id ${excerpt(id)}.`);

export const runNotFound = (runId: string): WorkflowError =>
  new WorkflowError(404, "RUN_NOT_FOUND", `No workflow run with id ${excerpt(runId)}.`);

export const nodeNotFound = (nodeId: string): WorkflowError =>
  new WorkflowError(404, "NODE_NOT_FOUND", `No block with id ${excerpt(nodeId)}.`);

export const invalidRequest = (message: string): WorkflowError => new WorkflowError(400, "INVALID_REQUEST", message);

export const engineUnavailable = (): WorkflowError =>
  new WorkflowError(503, "ENGINE_UNAVAILABLE", "The workflow engine is not running yet; try again in a moment.");
