/**
 * Checkpoint ref naming (spec §5.4).
 *
 * One hidden ref per turn:
 * `refs/orquester/checkpoints/<base64url(threadId)>/turn/<n>`. The namespace is
 * deliberately outside `refs/heads`, `refs/remotes`, `refs/notes` and `HEAD`,
 * which is exactly the set git's default `core.logAllRefUpdates` writes a
 * reflog for — so a capture never appears in the user's visible reflog either.
 *
 * Ported from T3 Code (MIT): apps/server/src/checkpointing/Utils.ts
 */

export const CHECKPOINT_REFS_PREFIX = "refs/orquester/checkpoints";

/**
 * The per-thread ref namespace. base64url keeps every thread id — which may
 * contain characters git refuses in a ref name — inside the tiny alphabet
 * `[A-Za-z0-9_-]`, and stays reversible.
 */
export function checkpointRefNamespace(threadId: string): string {
  if (threadId.length === 0) {
    throw new TypeError("checkpoint ref: threadId must not be empty");
  }
  return `${CHECKPOINT_REFS_PREFIX}/${Buffer.from(threadId, "utf8").toString("base64url")}`;
}

/** The ref holding the tree captured at the boundary of turn `turnCount`. */
export function checkpointRefForThreadTurn(threadId: string, turnCount: number): string {
  if (!Number.isSafeInteger(turnCount) || turnCount < 0) {
    throw new TypeError(`checkpoint ref: turnCount must be a non-negative integer (${turnCount})`);
  }
  return `${checkpointRefNamespace(threadId)}/turn/${turnCount}`;
}

/**
 * The turn count a ref of this thread names, or null when the ref is not one
 * of ours. Nothing is trusted: a ref under the prefix with a non-numeric,
 * negative or padded tail is ignored rather than parsed loosely, so a stray
 * ref someone wrote by hand can never be mistaken for a checkpoint.
 */
export function turnCountFromCheckpointRef(threadId: string, ref: string): number | null {
  const prefix = `${checkpointRefNamespace(threadId)}/turn/`;
  if (!ref.startsWith(prefix)) {
    return null;
  }
  const tail = ref.slice(prefix.length);
  if (!/^(?:0|[1-9][0-9]*)$/.test(tail)) {
    return null;
  }
  const turnCount = Number(tail);
  return Number.isSafeInteger(turnCount) ? turnCount : null;
}
