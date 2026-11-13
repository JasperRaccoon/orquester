import type { SelfUpdateRun, SelfUpdateStatusResponse } from "@orquester/api";

/**
 * The client's side of a self-update (spec 2026-11-13-self-update-design.md): what to show while
 * the host updater runs, and which out-of-date toast the user has already dismissed.
 */
export type UpdatePhase = "idle" | "updating" | "done" | "failed" | "reverted" | "stalled";

/** An update this client follows: the commit the server ran and when the update was requested. */
export interface FollowedRequest {
  /** The commit the server ran when the update was requested (`status.current`). */
  from: string;
  /**
   * The request's time on the server's clock (the POST's `requestedAt`; for a run found already
   * going, its `startedAt`): the updater's run that started at or after it is this update's.
   */
  requestedAt: string;
}

const SHA = /^[0-9a-f]{40}$/;

/** Whether `run` started at or after `requestedAt`; the updater stamps whole seconds, so compare to the second. */
function startedSince(run: SelfUpdateRun, requestedAt: string): boolean {
  const started = Date.parse(run.startedAt);
  const requested = Date.parse(requestedAt);
  return Number.isFinite(started) && Number.isFinite(requested) && started >= Math.floor(requested / 1000) * 1000;
}

/**
 * What the latest poll means for a followed update. `status` is null when the request failed — the
 * daemon is down for minutes while the update restarts it, so that is still "updating". The server
 * running another commit, or this update's run succeeding, is "done"; this update's run failing or
 * reverting is that. A run counts as this update's by its start time, not its commit: the status
 * file holds the previous run until the updater writes "running", and the checkout's commit can
 * differ from the one the daemon runs. A request the host updater never took is "stalled".
 */
export function nextUpdatePhase(update: FollowedRequest, status: SelfUpdateStatusResponse | null): UpdatePhase {
  if (!status) return "updating";
  if (typeof status.current === "string" && SHA.test(status.current) && status.current !== update.from) return "done";
  const run = status.run;
  if (run && run.state !== "running" && startedSince(run, update.requestedAt)) {
    return run.state === "succeeded" ? "done" : run.state;
  }
  if (status.requestStalled) return "stalled";
  return "updating";
}

/**
 * The outcome to show when no update is followed: the last run's failure or revert, when it started
 * from the commit the server still runs (a later deploy to another commit makes it history).
 */
export function lastRunFailure(status: SelfUpdateStatusResponse): "failed" | "reverted" | null {
  const run = status.run;
  if (!run || !status.current || run.from !== status.current) return null;
  return run.state === "failed" || run.state === "reverted" ? run.state : null;
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
