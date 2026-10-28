/**
 * Temporary boxes for agent chats (Ephemeral AI VMs spec §13) — the seam to the box service and
 * the shapes of the streaming `DaemonApi` box operations.
 *
 * {@link TemporaryBoxes} is implemented by the box service (`boxes/service`) and handed to
 * `TemporaryBoxTools.connect` (`./tools.ts`) in the daemon's wiring; the routes (`./routes.ts`) and
 * the `DaemonApi` box operations are thin calls into it plus the ownership rule (a chat reaches
 * only the boxes it created). Types only.
 */

import type { BoxDestroyedReason, BoxKind, BoxProviderId, BoxSummary } from "@orquester/api";

/** What `create_box` asks the service for, once the owner approved it. */
export interface CreateTemporaryBoxInput {
  /** The calling chat (= session id): the box's owner. */
  threadId: string;
  kind: BoxKind;
  /** The approved provider/size/region/image (always set by the tools; optional for other callers). */
  provider?: BoxProviderId;
  size?: string;
  region?: string;
  image?: string;
  /** The time limit: the service sets `deadlineAt = now + lifetimeMinutes` and destroys the box then (`time-limit`). */
  lifetimeMinutes: number;
  /** The agent's short purpose (`BoxSummary.purposeNote`). */
  purposeNote: string;
}

/**
 * The box service's temporary-box surface. Errors: reject with an `Error` carrying `code` (a
 * `BoxErrorCode` from `@orquester/api`) and a message written for the agent and the owner — never a
 * secret; any other error is reported as an internal failure without its text.
 */
export interface TemporaryBoxes {
  /**
   * Persist the record (`purpose: "temporary"`, `threadId`, state `provisioning`) BEFORE any
   * billable provider call and start provisioning (create → connect → ready). Resolves with the
   * summary once the record exists; readiness and failure arrive as changes ({@link onChange}).
   */
  createTemporaryBox(input: CreateTemporaryBoxInput): Promise<BoxSummary>;
  /**
   * Destroy a box and wait for the provider to confirm. Idempotent: an already destroyed box
   * resolves. Rejects when the provider refused (the record is then `destroy-failed`).
   */
  destroyBox(boxId: string, reason: BoxDestroyedReason): Promise<void>;
  /** Every box the service knows (destroyed ones included, while their records last). */
  list(): BoxSummary[];
  get(boxId: string): BoxSummary | undefined;
  /** Fires on every change of a box (state, connection, setup step). Returns the unsubscribe. */
  onChange(listener: (boxId: string) => void): () => void;
}

// ---------------------------------------------------------------------------
// The DaemonApi box operations (`mcp/daemon-api.ts`)
// ---------------------------------------------------------------------------

export type BoxShell = "bash" | "sh" | "powershell" | "cmd";

export interface BoxExecRequest {
  command: string;
  /** Default: `bash` on Linux and macOS, `powershell` on Windows. */
  shell?: BoxShell;
  /** A path in the box; absolute, or relative to the box user's home. Default: that home. */
  cwd?: string;
  /** Foreground only: the command is stopped after this long. */
  timeoutSeconds: number;
  /** Start it detached and return a job id at once. */
  background: boolean;
}

/** The end of one output stream, as returned to the agent: its last bytes and how many there were in all. */
export interface BoxOutputTail {
  text: string;
  /** Every byte the stream produced. */
  bytes: number;
  /** `text` holds only the last part. */
  truncated: boolean;
}

export type BoxExecResult =
  | {
      background: false;
      shell: BoxShell;
      exitCode: number | null;
      signal: string | null;
      /** Stopped by the timeout. */
      timedOut: boolean;
      /** The link to the box dropped while it ran, which stopped it. */
      connectionLost: boolean;
      durationMs: number;
      stdout: BoxOutputTail;
      stderr: BoxOutputTail;
    }
  | { background: true; shell: BoxShell; jobId: string; startedAt: string };

export interface BoxJobOutput {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  /** stdout and stderr together, in arrival order. */
  output: BoxOutputTail;
  startedAt: string | null;
  finishedAt: string | null;
  /** Why the job can no longer be followed (the box dropped and the process is gone), when it cannot. */
  lost: string | null;
}

export interface BoxTransferResult {
  kind: "file" | "directory";
  /** Bytes moved (file bytes, or the tar stream's size for a directory). */
  bytes: number;
  /** The host path (canonical). */
  localPath: string;
  /** The box path. */
  remotePath: string;
}

export interface BoxForwardResult {
  /**
   * The URL that works where the calling chat runs — its shell, curl, and its Browser tab unless
   * `browserUrl` is set: `http://127.0.0.1:<hostPort>/` on the host for a host project,
   * `http://127.0.0.1:<projectBoxPort>/` inside the project's own box for a box project.
   */
  url: string;
  /** Only when the Browser tab needs another URL than `url`: a box project whose Browser tab runs on the host (`http://127.0.0.1:<hostPort>/`). */
  browserUrl?: string;
  /** The host loopback port piping to `boxPort`, when one listens (host projects; box projects whose Browser tab runs on the host). */
  hostPort?: number;
  /** The temporary box's port. */
  boxPort: number;
  /** Box projects: the port on the project box's 127.0.0.1 piping to `boxPort`. */
  projectBoxPort?: number;
}
