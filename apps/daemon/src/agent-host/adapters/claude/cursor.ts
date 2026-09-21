/**
 * Claude adapter — the resume cursor (spec §4.1).
 *
 * `resumeCursor` is `unknown` by contract: this adapter owns its shape and it
 * is the only thing persisted for resume. **A cursor that fails its own shape
 * check means "no resume", never an error** — a thread with a corrupt cursor
 * starts a fresh session rather than refusing to open.
 *
 * Claude's shape is `{threadId, resume, resumeSessionAt?, turnCount,
 * turnStartMessageIds[]}`. `turnStartMessageIds` is the whole basis of
 * rollback: every turn stamps its own `turnId` as the `SDKUserMessage.uuid`,
 * so the native transcript id equals our turn id and a fork can be anchored on
 * it (fixtures/claude README observation 8 confirms a client-supplied uuid is
 * a valid `resumeSessionAt` anchor).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same shape rule the host's §6.1 create-time resume
 * (`orchestration/resume.ts`) and the terminal launch path (`resumeLaunchArgs`
 * in `apps/daemon/src/sessions.ts`) apply: the leading character excludes `-`,
 * so an id can never arrive as a flag, and no `..` segment survives.
 *
 * It is deliberately **not** a uuid check. Claude's own session ids are uuids
 * today, but the cursor also arrives in the minimal `{threadId, resume}` form
 * the resume picker builds, and a uuid-only rule would silently degrade a
 * perfectly good resume into a fresh session — the one outcome §6.1 exists to
 * prevent.
 */
const RESUME_ID_PATTERN = /^[\w.][\w.\-/]*$/;

export function isResumeId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  if (!RESUME_ID_PATTERN.test(value)) {
    return false;
  }
  return !value.split("/").includes("..");
}

export interface ClaudeResumeCursor {
  /** Our thread id, so a cursor copied onto the wrong thread is rejected. */
  threadId?: string;
  /** The native Claude session id to resume. */
  resume: string;
  /** A transcript uuid to resume at — set only by a rollback. */
  resumeSessionAt?: string;
  /** How many turns the cursor covers. */
  turnCount?: number;
  /** One native message uuid per turn start, in order. `null` = unknown. */
  turnStartMessageIds?: Array<string | null>;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Validate a persisted cursor. Anything that does not check out returns
 * `undefined`, which the caller reads as "start a fresh session".
 *
 * Both the **full** cursor this adapter writes and the **minimal**
 * `{threadId, resume}` form the host builds for a create-time resume (§6.1,
 * `orchestration/resumeCursorFor`) are accepted: every field beyond `resume`
 * is optional and the adapter refreshes them itself on the first turn.
 */
export function readClaudeResumeCursor(
  value: unknown,
  /**
   * The thread this cursor is about to be used for. A cursor that names a
   * DIFFERENT thread is rejected: "one live session per thread, a resume cursor
   * must never be advanced by two processes" (§3.1) depends on it, and the
   * field's whole purpose is to catch a cursor copied onto the wrong thread.
   * Optional so a caller that is only validating a shape need not have one.
   */
  expectedThreadId?: string
): ClaudeResumeCursor | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const resume = record.resume;
  if (!isResumeId(resume)) {
    return undefined;
  }
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  if (
    expectedThreadId !== undefined &&
    threadId !== undefined &&
    threadId !== expectedThreadId
  ) {
    return undefined;
  }
  const resumeSessionAt = isResumeId(record.resumeSessionAt)
    ? record.resumeSessionAt
    : undefined;
  const turnCount =
    typeof record.turnCount === "number" && Number.isInteger(record.turnCount) && record.turnCount >= 0
      ? record.turnCount
      : undefined;
  const rawIds = record.turnStartMessageIds;
  const turnStartMessageIds = Array.isArray(rawIds)
    ? rawIds.map((entry) => (typeof entry === "string" && entry.length > 0 ? entry : null))
    : undefined;

  return {
    ...(threadId !== undefined ? { threadId } : {}),
    resume,
    ...(resumeSessionAt !== undefined ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(turnStartMessageIds !== undefined ? { turnStartMessageIds } : {})
  };
}

export function buildClaudeResumeCursor(input: {
  threadId: string;
  sessionId: string;
  resumeSessionAt?: string;
  turnStartMessageIds: ReadonlyArray<string | null>;
}): ClaudeResumeCursor {
  return {
    threadId: input.threadId,
    resume: input.sessionId,
    ...(input.resumeSessionAt !== undefined ? { resumeSessionAt: input.resumeSessionAt } : {}),
    turnCount: input.turnStartMessageIds.length,
    turnStartMessageIds: [...input.turnStartMessageIds]
  };
}
