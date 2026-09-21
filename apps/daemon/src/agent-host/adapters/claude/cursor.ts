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
 */
export function readClaudeResumeCursor(value: unknown): ClaudeResumeCursor | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const resume = record.resume;
  if (!isUuid(resume)) {
    return undefined;
  }
  const threadId = typeof record.threadId === "string" ? record.threadId : undefined;
  const resumeSessionAt = isUuid(record.resumeSessionAt) ? record.resumeSessionAt : undefined;
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
