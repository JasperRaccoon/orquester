/**
 * Pending snapshots seed the registry synchronously before cache reads and probes.
 * They use unknown status/auth and installed:false to avoid premature auth errors.
 * Include only model catalogs available without I/O.
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/makeManagedServerProvider.ts:69-73`
 * (`initialSnapshot(settings)`) and
 * `apps/server/src/provider/Layers/ClaudeProvider.ts:595-640`
 * (`makePendingClaudeProvider`).
 */

/** The sentence's invariant tail — the part that does not vary by provider. */
const PENDING_MESSAGE_SUFFIX = "provider status has not been checked in this session yet.";

/** T3's exact sentence, per provider. *T3: `ClaudeProvider.ts:634`.* */
export function pendingStatusMessage(label: string): string {
  return `${label} ${PENDING_MESSAGE_SUFFIX}`;
}

/**
 * True for a snapshot that has never been probed in this host process.
 *
 * The message distinguishes a pending seed from a probed, missing CLI, which
 * has the same status, auth and installed fields and must still be cached.
 */
export function isPendingSnapshot(snapshot: {
  status: string;
  auth: { status: string };
  installed: boolean;
  message?: string | undefined;
}): boolean {
  return (
    snapshot.status === "unknown" &&
    snapshot.auth.status === "unknown" &&
    snapshot.installed === false &&
    snapshot.message?.endsWith(PENDING_MESSAGE_SUFFIX) === true
  );
}
