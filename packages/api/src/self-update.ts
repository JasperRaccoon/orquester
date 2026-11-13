// Self-update of a VPS install (spec docs/superpowers/specs/2026-11-13-self-update-design.md).
//
// The daemon compares the commit it runs with the head of its checkout's `origin` branch on GitHub
// (at boot and hourly) and reports it at `GET /api/self-update`. `POST /api/self-update` asks the
// host's root `orquester-update.service` (started by a systemd path unit) to run the deploy's
// update cycle; that service records its run in a status file the daemon reads back as `run`.

export const selfUpdateRoutes = {
  /** GET: {@link SelfUpdateStatusResponse}. POST: start an update — 202 {@link SelfUpdateStartResponse}, 409 when busy or unavailable. */
  status: "/api/self-update"
} as const;

export type SelfUpdateRunState = "running" | "succeeded" | "failed" | "reverted";

/** The host updater's last run, as its status file records it. */
export interface SelfUpdateRun {
  state: SelfUpdateRunState;
  /** The commit the run started from (full sha); null when the updater could not read it. */
  from: string | null;
  /** ISO time the run started. */
  startedAt: string;
  /** ISO time the run ended; absent while `running`. */
  finishedAt?: string;
  /** `remote-update.sh`'s exit code: 0 succeeded, 3 reverted to the previous release, other failed. */
  exitCode?: number;
}

export interface SelfUpdateStatusResponse {
  /** The commit the daemon runs (full sha); null when unknown. */
  current: string | null;
  /** The branch the install tracks and is compared with. */
  branch: string;
  /** `owner/name` of the checkout's GitHub origin; null when origin is not on GitHub or unreadable. */
  repo: string | null;
  /** The branch head's commit at the last successful check; null before one. */
  latest: string | null;
  /** How many commits `current` is behind `latest`; 0 when up to date, ahead, diverged or unknown. */
  behindBy: number;
  /** ISO time of the last successful check; null before one. */
  checkedAt: string | null;
  /** Why the last check failed (or cannot run); null after a successful one. */
  error: string | null;
  /** Whether this install can update itself (the host has the update units installed). */
  canUpdate: boolean;
  /** The host updater's last run; null when it never ran or the install cannot update itself. */
  run: SelfUpdateRun | null;
}

export interface SelfUpdateStartResponse {
  started: true;
}

/** Refusal codes of `POST /api/self-update` (409, `{ code, message }`). */
export type SelfUpdateErrorCode = "SELF_UPDATE_BUSY" | "SELF_UPDATE_UNAVAILABLE";

const RUN_STATES: readonly SelfUpdateRunState[] = ["running", "succeeded", "failed", "reverted"];
const SHA = /^[0-9a-f]{40}$/;

/**
 * A status-file record as a {@link SelfUpdateRun}, or null when it is not one (unknown state, no
 * start time). Tolerant of extra fields an other updater version may write; a malformed optional
 * field is dropped rather than failing the record.
 */
export function parseSelfUpdateRun(value: unknown): SelfUpdateRun | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (typeof state !== "string" || !(RUN_STATES as readonly string[]).includes(state)) return null;
  if (typeof record.startedAt !== "string" || !record.startedAt) return null;
  const run: SelfUpdateRun = {
    state: state as SelfUpdateRunState,
    from: typeof record.from === "string" && SHA.test(record.from) ? record.from : null,
    startedAt: record.startedAt
  };
  if (typeof record.finishedAt === "string" && record.finishedAt) run.finishedAt = record.finishedAt;
  if (typeof record.exitCode === "number" && Number.isInteger(record.exitCode)) run.exitCode = record.exitCode;
  return run;
}
