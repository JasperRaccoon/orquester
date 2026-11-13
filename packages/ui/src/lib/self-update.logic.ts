import type { SelfUpdateRun, SelfUpdateStatusResponse } from "@orquester/api";

/**
 * The client's side of a self-update (spec 2026-11-13-self-update-design.md): what to show while
 * the host updater runs, and which out-of-date toast the user has already dismissed.
 */
export type UpdatePhase = "idle" | "updating" | "done" | "failed" | "reverted";

const SHA = /^[0-9a-f]{40}$/;

/**
 * After an update started from `fromCommit`: what the latest poll means. `status` is null when the
 * request failed — the daemon is down for minutes while the update restarts it, so that is still
 * "updating". The server running another commit is "done". A failed or reverted run counts only
 * when it is this update's: right after the request the status file may still hold an older run
 * until the updater writes "running" — one from another commit, or `staleRun`, the run the server
 * reported before the request (a retry after a failure starts from the same commit).
 */
export function nextUpdatePhase(
  fromCommit: string,
  status: SelfUpdateStatusResponse | null,
  staleRun: SelfUpdateRun | null = null
): UpdatePhase {
  if (!status) return "updating";
  if (typeof status.current === "string" && SHA.test(status.current) && status.current !== fromCommit) return "done";
  const run = status.run;
  if (!run || run.from !== fromCommit || (staleRun && run.startedAt === staleRun.startedAt)) return "updating";
  return run.state === "failed" || run.state === "reverted" ? run.state : "updating";
}

/**
 * The out-of-date toast's identity — the branch head the server is behind — or null when there is
 * nothing to offer. Only an install that can update itself gets the toast; a dev checkout or the
 * desktop app's daemon still shows "behind" in Settings without nagging.
 */
export function updateToastKey(status: SelfUpdateStatusResponse): string | null {
  return status.canUpdate && status.behindBy > 0 && status.latest ? status.latest : null;
}

/** Dismissals are per connection: dismissing one server's update must not hide another's. */
const dismissedKey = (connectionId: string): string => `orquester:dismissed-update:${connectionId}`;

/** The branch head whose toast the user dismissed for this connection, or null (none, garbage, storage error). */
export function readDismissedUpdate(storage: Pick<Storage, "getItem">, connectionId: string): string | null {
  try {
    const value = storage.getItem(dismissedKey(connectionId));
    return typeof value === "string" && SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remember the dismissed branch head for this connection; a storage failure leaves it in memory only. */
export function writeDismissedUpdate(storage: Pick<Storage, "setItem">, connectionId: string, latest: string): void {
  try {
    storage.setItem(dismissedKey(connectionId), latest);
  } catch {
    /* quota or unavailable storage: the dismissal lasts for this page only */
  }
}
