/**
 * Agent host — command rejections (spec §6.2 "Failures").
 *
 * Ported from T3 Code (MIT): `apps/server/src/orchestration/Errors.ts`
 * (`OrchestrationCommandInvariantError`, `…CommandIdConflictError`,
 * `…CommandPreviouslyRejectedError`), collapsed into one error class because
 * the wire carries a closed code list rather than a tagged union.
 *
 * A *provider-side* failure is never one of these: `/turn` answers as soon as
 * the command is recorded, and a provider that then refuses appends an
 * activity with tone `error` (§6.2).
 */

import type { AgentChatErrorCode, AgentChatErrorEnvelope } from "@orquester/api/agent-chat";

const STATUS_BY_CODE: Readonly<Record<AgentChatErrorCode, number>> = {
  INVALID_COMMAND: 400,
  THREAD_NOT_FOUND: 404,
  COMMAND_ID_CONFLICT: 409,
  COMMAND_REJECTED: 409,
  COMPACTION_UNAVAILABLE: 409,
  HOST_UNAVAILABLE: 503,
  // The thread index is missing or being rebuilt: only `GET …/history`
  // answers it (`GET /search` answers 200 `indexed:false` instead), and
  // nothing about the live thread is affected. Not a recorded rejection — it
  // is a read, and it clears itself.
  INDEX_UNAVAILABLE: 503,
  // `GET …/items/:itemId/output` alone: no such item, or it names no tool
  // call. Its own code, so a route miss on an older host (a generic 404
  // `THREAD_NOT_FOUND`) can be told apart. A read, never recorded.
  ITEM_NOT_FOUND: 404
};

/**
 * Codes whose rejection is **recorded as a receipt**, so retrying the same
 * `commandId` replays the rejection instead of turning a validation failure
 * into a second attempt (§5.1 "Receipts").
 *
 * `COMMAND_ID_CONFLICT` is excluded because the conflicting receipt already
 * exists and belongs to another thread; `HOST_UNAVAILABLE` is excluded because
 * §6.2 tells the client to retry the same `commandId` once the host is back.
 */
const RECORDED_REJECTION_CODES: ReadonlySet<AgentChatErrorCode> = new Set<AgentChatErrorCode>([
  "INVALID_COMMAND",
  "THREAD_NOT_FOUND",
  "COMMAND_REJECTED",
  "COMPACTION_UNAVAILABLE"
]);

export class AgentChatCommandError extends Error {
  readonly code: AgentChatErrorCode;
  readonly detail?: unknown;

  constructor(code: AgentChatErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AgentChatCommandError";
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  /** True when the rejection is persisted as a receipt and replayed on retry. */
  get recorded(): boolean {
    return RECORDED_REJECTION_CODES.has(this.code);
  }

  toEnvelope(): AgentChatErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail !== undefined ? { detail: this.detail } : {})
      }
    };
  }
}

export function isAgentChatCommandError(value: unknown): value is AgentChatCommandError {
  return value instanceof AgentChatCommandError;
}

export const invalidCommand = (message: string, detail?: unknown): AgentChatCommandError =>
  new AgentChatCommandError("INVALID_COMMAND", message, detail);

export const threadNotFound = (threadId: string): AgentChatCommandError =>
  new AgentChatCommandError("THREAD_NOT_FOUND", `Thread '${threadId}' was not found.`);

export const commandRejected = (message: string, detail?: unknown): AgentChatCommandError =>
  new AgentChatCommandError("COMMAND_REJECTED", message, detail);

export const compactionUnavailable = (message: string): AgentChatCommandError =>
  new AgentChatCommandError("COMPACTION_UNAVAILABLE", message);

export const hostUnavailable = (message: string): AgentChatCommandError =>
  new AgentChatCommandError("HOST_UNAVAILABLE", message);

/** Rebuild the recorded rejection of a previously-rejected `commandId` (§6.2). */
export function replayRecordedRejection(error: {
  code: string;
  message: string;
  detail?: unknown;
}): AgentChatCommandError {
  const code = (
    Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, error.code)
      ? error.code
      : "COMMAND_REJECTED"
  ) as AgentChatErrorCode;
  return new AgentChatCommandError(code, error.message, error.detail);
}

export function statusForCode(code: AgentChatErrorCode): number {
  return STATUS_BY_CODE[code];
}
