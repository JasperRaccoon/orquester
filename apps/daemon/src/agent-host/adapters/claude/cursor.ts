/**
 * Claude adapter — the resume cursor (spec §4.1).
 *
 * `resumeCursor` is `unknown` by contract: this adapter owns its shape and it
 * is the only thing persisted for resume. **A cursor that fails its own shape
 * check means "no resume", never an error** — a thread with a corrupt cursor
 * starts a fresh session rather than refusing to open.
 *
 * Claude's shape is `{threadId, resume, resumeSessionAt?, turnCount,
 * turnStartMessageIds[], turnBoundaries[]}`. The boundaries are the whole basis
 * of rollback: every turn stamps its own `turnId` as the `SDKUserMessage.uuid`,
 * so the native transcript id equals our turn id and a fork can be anchored on
 * it (fixtures/claude README observation 8 confirms a client-supplied uuid is
 * a valid `resumeSessionAt` anchor).
 *
 * `turnBoundaries` pairs each of our turn ids with the transcript uuid its turn
 * starts at (a synthetic turn — background output between prompts — starts at
 * the assistant message that opened it). For a turn `sendTurn` opened the two
 * are equal until the first rewind: a fork rewrites every uuid, so only the
 * pair still says which turn a fork uuid starts — and a rewind names its cut
 * by turn id (fixtures/claude README observation 21).
 * `turnStartMessageIds` is the legacy positional list of the same uuids; it is
 * still written, because an older host reads nothing else.
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

/**
 * One turn boundary: OUR turn id — the fold's, the one a `RollbackTarget`
 * names — and the native transcript uuid that turn starts at. `uuid: null` =
 * the turn is known but where it starts is not.
 */
export interface ClaudeTurnBoundary {
  turnId: string;
  uuid: string | null;
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
  /**
   * One native message uuid per turn start, in order. `null` = unknown. The
   * legacy positional list: an older host reads only this.
   */
  turnStartMessageIds?: Array<string | null>;
  /**
   * The same boundaries paired with the turn ids they start, in start order,
   * re-paired onto the fork's uuids by every rewind. Absent from a cursor
   * written before the pairs existed — {@link claudeTurnBoundariesFromCursor}
   * derives them from the legacy list then.
   */
  turnBoundaries?: ClaudeTurnBoundary[];
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
  const turnBoundaries = readTurnBoundaries(record.turnBoundaries);

  return {
    ...(threadId !== undefined ? { threadId } : {}),
    resume,
    ...(resumeSessionAt !== undefined ? { resumeSessionAt } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(turnStartMessageIds !== undefined ? { turnStartMessageIds } : {}),
    ...(turnBoundaries !== undefined ? { turnBoundaries } : {})
  };
}

/**
 * `turnBoundaries`, validated field-wise. An entry without a non-empty string
 * `turnId` names no turn and is dropped; a `uuid` that is not a non-empty
 * string becomes `null` — the turn is known, where it starts is not — exactly
 * as the legacy list treats its own entries. A field that is not an array is
 * absent, so the session falls back to the legacy list.
 */
function readTurnBoundaries(value: unknown): ClaudeTurnBoundary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const boundaries: ClaudeTurnBoundary[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const { turnId, uuid } = entry as { turnId?: unknown; uuid?: unknown };
    if (typeof turnId !== "string" || turnId.length === 0) {
      continue;
    }
    boundaries.push({ turnId, uuid: typeof uuid === "string" && uuid.length > 0 ? uuid : null });
  }
  return boundaries;
}

/**
 * The pairs a session starts from: the cursor's own `turnBoundaries` when it
 * carries them, else identity pairs over the legacy `turnStartMessageIds` — a
 * cursor written before the pairs existed recorded only uuids, and for a turn
 * this adapter started the uuid IS the turn id. A `null` there pairs with
 * nothing and is skipped; the legacy positional list keeps it.
 */
export function claudeTurnBoundariesFromCursor(
  cursor: ClaudeResumeCursor | undefined
): ClaudeTurnBoundary[] {
  if (cursor?.turnBoundaries !== undefined) {
    return cursor.turnBoundaries.map(({ turnId, uuid }) => ({ turnId, uuid }));
  }
  return (cursor?.turnStartMessageIds ?? []).flatMap((uuid) =>
    uuid === null ? [] : [{ turnId: uuid, uuid }]
  );
}

export function buildClaudeResumeCursor(input: {
  threadId: string;
  sessionId: string;
  resumeSessionAt?: string;
  turnStartMessageIds: ReadonlyArray<string | null>;
  turnBoundaries?: ReadonlyArray<ClaudeTurnBoundary>;
}): ClaudeResumeCursor {
  return {
    threadId: input.threadId,
    resume: input.sessionId,
    ...(input.resumeSessionAt !== undefined ? { resumeSessionAt: input.resumeSessionAt } : {}),
    turnCount: input.turnStartMessageIds.length,
    turnStartMessageIds: [...input.turnStartMessageIds],
    ...(input.turnBoundaries !== undefined
      ? { turnBoundaries: input.turnBoundaries.map(({ turnId, uuid }) => ({ turnId, uuid })) }
      : {})
  };
}
