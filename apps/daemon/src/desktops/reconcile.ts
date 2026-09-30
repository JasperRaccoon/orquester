import type { DesktopRecord } from "@orquester/config";
import { DESKTOP_HOST_WINDOW, appWindowName, desktopSessionName } from "./host-env.ts";

// Boot reconciliation (desktop spec §5.6), pure: records × live tmux sessions
// and windows × the ready/exit files → statuses, plus the sessions to kill.
// Status is never trusted from disk; the stored app status and pgid are hints.

export interface ReconcileInput {
  records: DesktopRecord[];
  /** Names of the live `orqsvc-desktop-*` sessions. */
  liveSessions: string[];
  /** Window names of each live session. */
  windowsBySession: Map<string, string[]>;
  /** Display number in each desktop's `ready` file (absent: no readable file). */
  readyFiles: Map<string, number>;
  /** Desktops whose `host.exit` exists. */
  hostExitFiles: Set<string>;
  /** Per desktop: app id → exit status in its `.exit` file (null: unreadable). */
  appExitFiles: Map<string, Map<string, number | null>>;
  /** The index loaded cleanly; when false, unrecorded sessions are never reaped. */
  indexLoaded: boolean;
  /** Ids of records this build could not parse (kept in the file): their sessions are never reaped. */
  claimedIds?: string[];
}

export interface ReconciledApp {
  id: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export interface ReconciledDesktop {
  id: string;
  status: "running" | "stopped";
  display: number | null;
  apps: ReconciledApp[];
  /** A live session whose host is gone or never came up: kill what is left of it. */
  killSession: boolean;
}

export interface ReconcileResult {
  desktops: ReconciledDesktop[];
  /** Live desktop sessions no record claims (empty unless the index loaded). */
  reap: string[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const live = new Set(input.liveSessions);
  const claimed = new Set<string>((input.claimedIds ?? []).map(desktopSessionName));
  const desktops: ReconciledDesktop[] = [];

  for (const record of input.records) {
    const session = desktopSessionName(record.id);
    claimed.add(session);
    const exits = input.appExitFiles.get(record.id) ?? new Map<string, number | null>();
    const display = input.readyFiles.get(record.id);
    const windows = new Set(input.windowsBySession.get(session) ?? []);
    const hostAlive =
      live.has(session) &&
      display !== undefined &&
      !input.hostExitFiles.has(record.id) &&
      windows.has(DESKTOP_HOST_WINDOW);

    if (!hostAlive) {
      desktops.push({
        id: record.id,
        status: "stopped",
        display: null,
        apps: record.apps.map((app) => exitedApp(app, exits)),
        killSession: live.has(session)
      });
      continue;
    }

    desktops.push({
      id: record.id,
      status: "running",
      display: display,
      apps: record.apps.map((app): ReconciledApp => {
        if (exits.has(app.id)) {
          return { id: app.id, status: "exited", exitCode: exits.get(app.id) ?? null };
        }
        if (app.status !== "exited" && windows.has(appWindowName(app.id))) {
          return { id: app.id, status: "running", exitCode: null };
        }
        return exitedApp(app, exits);
      }),
      killSession: false
    });
  }

  const reap = input.indexLoaded ? input.liveSessions.filter((name) => !claimed.has(name)) : [];
  return { desktops, reap };
}

/** An app that is not running: its exit file's code, else what was recorded when it exited, else null. */
function exitedApp(
  app: DesktopRecord["apps"][number],
  exits: Map<string, number | null>
): ReconciledApp {
  if (exits.has(app.id)) {
    return { id: app.id, status: "exited", exitCode: exits.get(app.id) ?? null };
  }
  return { id: app.id, status: "exited", exitCode: app.status === "exited" ? app.exitCode : null };
}
