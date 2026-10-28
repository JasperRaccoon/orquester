/**
 * Temporary boxes for agent chats (Ephemeral AI VMs spec §13) — the daemon side of the box MCP
 * tools: the ownership rule, and every operation the tools reach through `DaemonApi` and the
 * temporary-box routes (`./routes.ts`).
 *
 * - **Ownership, enforced here.** A request carrying an agent principal reaches only the boxes its
 *   chat created (`BoxSummary.threadId`); another chat's box, a project box and an unknown id all
 *   read the same `BOX_NOT_FOUND`. A person (no principal) reaches every temporary box; an
 *   external MCP client none.
 * - **The box service is injected late** ({@link TemporaryBoxTools.connect}): until it is, every
 *   operation answers `BOXES_DISABLED`, and the box tools are not advertised to chats.
 * - **Files are streamed**: a file as its bytes, a directory as a tar stream made and unpacked by
 *   the host's `tar`; host paths are checked against the calling chat's project after realpath. A
 *   download never writes git metadata (a `.git` path, a git directory, or a directory carrying
 *   either): its config or hooks would run on the host. A box project's files live in its own
 *   box, so they are relayed through the daemon (project box ⇄ daemon ⇄ temporary box) with the
 *   same rules, checked by the project box's file system (`BoxProjectFs`): the tar is made by the
 *   project box's `tar` and unpacked by its `writeTar`.
 * - **Background jobs** run detached in the box (they survive link drops; the output is followed
 *   again from the offset last seen when the box reconnects) and their output tail is kept here.
 * - **Port forwards reach where the chat runs**: a host loopback port for a host project; for a box
 *   project, a listener in its own box (`./project-forwards.ts`), plus a host port while its
 *   Browser tab runs on the host. A forward that could not be reached is refused, not returned.
 * - **Lifetime.** A closed chat's boxes are destroyed (`chat-closed`, {@link chatClosed}); a
 *   destroyed box's port forwards close and its jobs are forgotten.
 *
 * Waits are event-driven (box changes, process events) and bounded by deadlines on the injected
 * clock; nothing here sleeps. Nothing here logs a command, an output or a path's contents.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  isBoxKind,
  isBoxProviderId,
  TEMPORARY_BOX_MAX_LIFETIME_MINUTES,
  TEMPORARY_BOX_MIN_LIFETIME_MINUTES,
  TEMPORARY_BOX_PURPOSE_MAX_CHARS,
  type BoxDestroyedReason,
  type BoxErrorCode,
  type BoxSummary,
  type BoxSysInfo,
  type CreateTemporaryBoxRequest,
  type TemporaryBoxDestroyReason
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";

import type { BoxConnection, BoxHub, BoxProcess, BoxRegistry } from "../contracts.ts";
import { BoxFsUnavailableError } from "../remote/fs/errors.ts";
import { locateProjectFs, type BoxProjectFs, type ProjectFsLocation } from "../remote/fs/project-fs.ts";
import type {
  BoxExecRequest,
  BoxExecResult,
  BoxForwardResult,
  BoxJobOutput,
  BoxOutputTail,
  BoxShell,
  BoxTransferResult,
  TemporaryBoxes
} from "./contract.ts";
import { ProjectBoxForwardError, type ProjectBoxForward, type ProjectBoxForwards } from "./project-forwards.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The tail of each foreground stream returned to the agent (the tool result is capped at 60 000 bytes). */
export const EXEC_STDOUT_TAIL_BYTES = 24 * 1024;
export const EXEC_STDERR_TAIL_BYTES = 12 * 1024;
/** The tail of a background job's output kept on the host. */
export const JOB_OUTPUT_TAIL_BYTES = 32 * 1024;
/** Running background jobs per box. */
export const MAX_RUNNING_JOBS_PER_BOX = 16;
/** Open port forwards per box. */
export const MAX_FORWARDS_PER_BOX = 16;
/** One download's size cap (a file's bytes or a directory's tar stream). */
const BOX_DOWNLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** After SIGTERM (timeout, cancel), how long before SIGKILL. */
export const KILL_GRACE_MS = 5_000;
/** After the process exited, how long its output streams may take to end. */
export const OUTPUT_DRAIN_MS = 5_000;
/** How long a started process may take to report it spawned. */
export const SPAWN_REPORT_MS = 30_000;
/** Re-following a job after a daemon restart: how long its buffered output may take to replay. */
export const JOB_REPLAY_MS = 10_000;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** An answer or a refusal written for the agent (the `DaemonOutcome` shape, plus the route's HTTP status). */
export type BoxOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string; status: number };

const refuse = (status: number, code: string, message: string): { ok: false; code: string; message: string; status: number } => ({ ok: false, code, message, status });
const done = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const BOX_ERROR_STATUS: Readonly<Record<BoxErrorCode, number>> = {
  BOXES_DISABLED: 503,
  BOX_NOT_FOUND: 404,
  BOX_IS_PROJECT: 409,
  BOX_NOT_READY: 409,
  BOX_PROVIDER_NOT_CONFIGURED: 409,
  BOX_PROVIDER_ERROR: 502,
  BOX_INVALID_REQUEST: 400,
  BOX_CONNECTION_NOT_CONFIGURED: 409,
  BOX_UNSUPPORTED: 400,
  BOX_TAILSCALE_NEEDS_PERMISSION: 409,
  BOX_CONFIG_CHANGE_NOT_FOUND: 404,
  BOX_CONFIG_CHANGE_DECIDED: 409,
  BOX_DESTROYED: 410,
  BOX_IN_USE: 409
};

const DISABLED = refuse(503, "BOXES_DISABLED", "Temporary boxes are not available: the Ephemeral AI VMs plugin is off or still starting.");
const NOT_FOUND = refuse(404, "BOX_NOT_FOUND", "No temporary box of this chat has that id (list_boxes shows this chat's boxes).");

/** The longest service or box message passed on to the agent. */
const MAX_MESSAGE_CHARS = 600;

function clip(text: string, max = MAX_MESSAGE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** An error's name and code only, for logs: messages can quote paths or provider text. */
function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? ` ${code}` : ""}`;
  }
  return typeof error;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** The timer source: injected so tests drive deadlines without sleeping. */
export interface TemporaryBoxClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const SYSTEM_CLOCK: TemporaryBoxClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface TemporaryBoxToolsDeps {
  /** Whether a chat is still open: a create that finishes after its chat closed is torn down. */
  isChatOpen?(threadId: string): boolean;
  clock?: TemporaryBoxClock;
  newId?: () => string;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

/** What the box service hands {@link TemporaryBoxTools.connect}. */
export interface TemporaryBoxesConnection {
  boxes: TemporaryBoxes;
  hub: Pick<BoxHub, "get">;
  /** Tells a box project's host stub apart (its files live in its own box, not on this host). */
  registry?: Pick<BoxRegistry, "locate">;
  /** Forwards listening in a box project's own box (`./project-forwards.ts`); without it a box project's chat cannot forward. */
  projectForwards?: Pick<ProjectBoxForwards, "open">;
  /** Whether a box project's Browser tab runs its Chromium in the project box (`BoxBrowsers.runsInBox`); else it runs on the host. */
  browserRunsInBox?: (projectPath: string) => boolean;
}

/** Call options of the operations: who acts (forced by `withPrincipal`), and the call's abort. */
export interface BoxCallOptions {
  principal?: CallerPrincipal;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Output tails
// ---------------------------------------------------------------------------

/** The last `cap` bytes of a stream, and how many bytes it carried in all. */
class OutputTail {
  private chunks: Buffer[] = [];
  private held = 0;
  total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.held += chunk.length;
    // Compact once the held bytes reach twice the cap: amortised, and never more than 2 × cap in memory.
    if (this.held >= this.cap * 2) {
      const tail = Buffer.concat(this.chunks).subarray(-this.cap);
      this.chunks = [Buffer.from(tail)];
      this.held = tail.length;
    }
  }

  snapshot(): BoxOutputTail {
    let bytes = Buffer.concat(this.chunks);
    if (bytes.length > this.cap) bytes = bytes.subarray(bytes.length - this.cap);
    const truncated = this.total > bytes.length;
    // A cut tail may start inside a UTF-8 character: drop its continuation bytes.
    if (truncated) {
      let start = 0;
      while (start < bytes.length && start < 3 && (bytes[start]! & 0xc0) === 0x80) start += 1;
      bytes = bytes.subarray(start);
    }
    return { text: bytes.toString("utf8"), bytes: this.total, truncated };
  }
}

// ---------------------------------------------------------------------------
// Box paths and shells
// ---------------------------------------------------------------------------

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A path in the box: absolute as given, `~` / relative from the box user's home. Null when unusable. */
export function boxPathFor(sys: Pick<BoxSysInfo, "os" | "home">, path: string | undefined): string | null {
  if (path === undefined || path === "") return sys.home;
  if (path.includes("\0")) return null;
  if (sys.os === "win32") {
    if (WINDOWS_ABSOLUTE.test(path)) return path;
    const rest = path === "~" ? "" : path.replace(/^~[\\/]/, "");
    return rest === "" ? sys.home : `${sys.home.replace(/[\\/]+$/, "")}\\${rest.replace(/\//g, "\\")}`;
  }
  if (path.startsWith("/")) return path;
  const rest = path === "~" ? "" : path.replace(/^~\//, "");
  return rest === "" ? sys.home : `${sys.home.replace(/\/+$/, "")}/${rest}`;
}

/** The last segment of a box path (either separator). */
function boxBasename(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

const GIT_METADATA_REFUSAL =
  "local_path is inside git metadata (a .git directory or a git directory): box_download never writes there. Choose a path in the project's working files.";
const GIT_TREE_REFUSAL =
  "The directory holds git metadata (a .git entry or a git directory): box_download never copies that. Send a git bundle or a patch instead, or download the files without .git.";
const NOT_A_DIRECTORY_REFUSAL = "remote_path is a symbolic link to a directory, not the directory itself: name the directory it points to.";

/** A path segment git reads as `.git`: any case (case-insensitive file systems), trailing dots or spaces dropped (as Windows does). */
export function isGitSegment(segment: string): boolean {
  return segment.replace(/[. ]+$/, "").toLowerCase() === ".git";
}

/**
 * How the git-metadata rules read the file system the project's files live on (paths are host
 * paths): this host's, or a box project's over its link ({@link boxGitMetadataFs}). Nothing here
 * follows a symlink.
 */
export interface GitMetadataFs {
  /** An entry's kind, the entry itself (a symlink is `symlink`; null when nothing readable is there). */
  kind(path: string): Promise<"file" | "dir" | "symlink" | "other" | null>;
  /** A directory's entries. */
  list(dir: string): Promise<{ name: string; dir: boolean }[]>;
}

const HOST_GIT_METADATA_FS: GitMetadataFs = {
  kind: async (path) => {
    const stats = await lstat(path).catch(() => null);
    return stats === null ? null : stats.isDirectory() ? "dir" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other";
  },
  list: async (dir) => (await readdir(dir, { withFileTypes: true })).map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
};

/** The git-metadata rules' view of a box project (one `fs.stat` / `fs.readdir` per question, never through a symlink). */
function boxGitMetadataFs(fs: BoxProjectFs): GitMetadataFs {
  const windows = fs.connection.paths.kind === "windows-prefix";
  return {
    kind: async (path) => {
      try {
        const stats = await fs.stat(path, { followSymlinks: false });
        return stats === null ? null : stats.kind === "dir" || stats.kind === "file" || stats.kind === "symlink" ? stats.kind : "other";
      } catch (error) {
        // An unreadable entry reads as absent, like the host's lstat; a dropped link fails the transfer.
        if (error instanceof BoxFsUnavailableError) throw error;
        return null;
      }
    },
    list: async (dir) => {
      // The box's own answer, unfiltered: an entry skipped here could hide a `.git` below it.
      const entries = await fs.connection.request("fs.readdir", { path: fs.toBox(dir) });
      return entries.map((entry) => {
        if (entry.name === "" || entry.name === "." || entry.name === ".." || /[/\0]/.test(entry.name) || (windows && entry.name.includes("\\"))) {
          throw new Error("The project's box listed an entry that is not a file name.");
        }
        return { name: entry.name, dir: entry.kind === "dir" };
      });
    }
  };
}

/**
 * Whether `dir` is laid out as a git directory (what git's discovery accepts as one: `HEAD` with
 * `objects`/`refs`/`commondir`, or `objects` and `refs` a `HEAD` would complete). Git follows
 * symlinks there (`objects -> o` still makes one), so a symlink of one of those names counts as
 * present wherever it points; nothing is followed here.
 */
async function looksLikeGitDir(dir: string, fs: GitMetadataFs): Promise<boolean> {
  const [head, objects, refs, commondir] = await Promise.all(["HEAD", "objects", "refs", "commondir"].map((name) => fs.kind(join(dir, name))));
  const present = (kind: Awaited<ReturnType<GitMetadataFs["kind"]>>, wanted: "file" | "dir"): boolean => kind === wanted || kind === "symlink";
  if (present(objects, "dir") && present(refs, "dir")) return true;
  return present(head, "file") && (present(objects, "dir") || present(refs, "dir") || present(commondir, "file"));
}

/**
 * Whether a download target lies in git metadata: a `.git` segment in the path as asked or as
 * resolved (realpath, inside `projectRoot`), or a directory from its parent up to the project root
 * that is a git directory (a bare repository, a worktree's or submodule's gitdir).
 */
export async function insideGitMetadata(projectRoot: string, requested: string, resolved: string, fs: GitMetadataFs = HOST_GIT_METADATA_FS): Promise<boolean> {
  if (requested.split(/[\\/]+/).some(isGitSegment)) return true;
  const rel = relative(projectRoot, resolved);
  if (rel.split(sep).some(isGitSegment)) return true;
  for (let dir = dirname(resolved); ; dir = dirname(dir)) {
    if (await looksLikeGitDir(dir, fs)) return true;
    if (dir === projectRoot || dirname(dir) === dir || relative(projectRoot, dir).startsWith("..")) return false;
  }
}

/** Directories of one tree level checked at once (a box project answers each over its link). */
const GIT_SCAN_PARALLEL = 16;

/** Whether an unpacked tree (`root` a real directory) holds a `.git` entry anywhere or a directory laid out as a git directory (symlinks are not followed). */
export async function containsGitMetadata(root: string, fs: GitMetadataFs = HOST_GIT_METADATA_FS): Promise<boolean> {
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += GIT_SCAN_PARALLEL) {
      const found = await Promise.all(
        level.slice(start, start + GIT_SCAN_PARALLEL).map(async (dir) => {
          if (await looksLikeGitDir(dir, fs)) return true;
          for (const entry of await fs.list(dir)) {
            if (isGitSegment(entry.name)) return true;
            if (entry.dir) next.push(join(dir, entry.name));
          }
          return false;
        })
      );
      if (found.includes(true)) return true;
    }
    level = next;
  }
  return false;
}

/** The default shell of a box: PowerShell on Windows, bash elsewhere. */
export function defaultShell(os: BoxSysInfo["os"]): BoxShell {
  return os === "win32" ? "powershell" : "bash";
}

/** The argv a command line runs with in `shell` on a box of `os`; null when the shell does not exist there. */
export function shellArgv(shell: BoxShell, os: BoxSysInfo["os"], command: string): { command: string; args: string[] } | null {
  switch (shell) {
    case "bash":
      // A login shell: the box user's profile (PATH additions of installed toolchains) applies.
      return { command: "bash", args: ["-lc", command] };
    case "sh":
      return { command: "sh", args: ["-c", command] };
    case "powershell":
      // UTF-8 out, whatever the console code page.
      return {
        command: os === "win32" ? "powershell.exe" : "pwsh",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`]
      };
    case "cmd":
      return os === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", command] } : null;
  }
}

// ---------------------------------------------------------------------------
// Jobs and forwards
// ---------------------------------------------------------------------------

interface Job {
  readonly jobId: string;
  readonly boxId: string;
  readonly tail: OutputTail;
  /** Output bytes received (the offset a re-follow resumes from). */
  received: number;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lost: string | null;
  /** Whether the box's buffer was released after the exit was seen. */
  released: boolean;
  /** Woken on every output chunk and on the exit. */
  readonly waiters: Set<() => void>;
  /** Undoes the current process's listeners and any reconnect subscription. */
  detach: () => void;
}

type Waitable = { waiters: Set<() => void> };

function wake(target: Waitable): void {
  for (const waiter of [...target.waiters]) waiter();
}

// ---------------------------------------------------------------------------
// The tools' backend
// ---------------------------------------------------------------------------

export class TemporaryBoxTools {
  private connection: TemporaryBoxesConnection | null = null;
  /** The chat-close cleanup's view of the box service, independent of {@link connect}. */
  private cleanupBoxes: Pick<TemporaryBoxes, "list" | "destroyBox"> | null = null;
  private unsubscribeBoxes: (() => void) | null = null;
  private readonly availability = new Set<() => void>();
  private readonly jobs = new Map<string, Job>();
  private readonly forwards = new Map<string, Map<number, Promise<{ hostPort: number; boxPort: number; close(): Promise<void> }>>>();
  /** Per temporary box and port: the listener in the calling chat's project box (box projects). */
  private readonly projectForwards = new Map<string, Map<number, Promise<ProjectBoxForward>>>();
  /** Box cleanups in flight (a destroy and its change event both ask for one). */
  private readonly closing = new Map<string, Promise<void>>();
  /** Per project box: download staging paths it could not remove, removed when it reconnects ({@link leaveStaging}). */
  private readonly leftStaging = new Map<string, { fs: BoxProjectFs; paths: Set<string>; unsubscribe: () => void }>();
  private readonly clock: TemporaryBoxClock;

  constructor(private readonly deps: TemporaryBoxToolsDeps = {}) {
    this.clock = deps.clock ?? SYSTEM_CLOCK;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * Attach the box service (it calls this once its records are loaded). From then on the box tools
   * are advertised to chats and every operation reaches it. Returns the disconnect.
   */
  connect(connection: TemporaryBoxesConnection): () => void {
    this.unsubscribeBoxes?.();
    this.connection = connection;
    this.unsubscribeBoxes = connection.boxes.onChange((boxId) => this.boxChanged(boxId));
    this.availabilityChanged();
    return () => {
      if (this.connection !== connection) return;
      this.unsubscribeBoxes?.();
      this.unsubscribeBoxes = null;
      this.connection = null;
      void this.closeEverything();
      this.availabilityChanged();
    };
  }

  /**
   * The box service for the chat-close cleanup only ({@link chatClosed}), set once at startup and
   * kept whatever the plugin switch says: a box rented before the plugin was turned off still
   * bills, so its chat closing still destroys it. Nothing else reaches the boxes through it.
   */
  setCleanup(boxes: Pick<TemporaryBoxes, "list" | "destroyBox">): void {
    this.cleanupBoxes = boxes;
  }

  /** Whether boxes can be rented now (the box tools are advertised only then). */
  available(): boolean {
    return this.connection !== null;
  }

  /** Called whenever {@link available} may have changed (the daemon re-sends chat tool manifests). */
  onAvailabilityChange(listener: () => void): () => void {
    this.availability.add(listener);
    return () => this.availability.delete(listener);
  }

  /** Daemon stop: close the host-side forwards; detached jobs keep running in their boxes. */
  async shutdown(): Promise<void> {
    this.unsubscribeBoxes?.();
    this.unsubscribeBoxes = null;
    await this.closeEverything();
  }

  /**
   * A chat closed (spec §13.3): destroy every temporary box it created and has not destroyed yet,
   * with reason `chat-closed`. Never throws; failures are logged (the box shows `destroy-failed`).
   */
  chatClosed(threadId: string): void {
    // Not only while connected: with the plugin off the boxes keep billing, so a closed chat's still go.
    const boxes = this.connection?.boxes ?? this.cleanupBoxes;
    if (!boxes) return;
    for (const box of boxes.list()) {
      if (box.purpose !== "temporary" || box.threadId !== threadId) continue;
      if (box.state === "destroyed" || box.state === "destroying") continue;
      this.destroyQuietly(boxes, box.id, "chat-closed");
    }
  }

  // -------------------------------------------------------------------------
  // Records (the routes)
  // -------------------------------------------------------------------------

  /** An agent: its chat's temporary boxes; a person: every temporary box, or one chat's. */
  list(principal: CallerPrincipal, threadId?: string): BoxOutcome<BoxSummary[]> {
    const boxes = this.connection?.boxes;
    if (!boxes) return DISABLED;
    if (principal.kind === "external") return refuse(403, "PERMISSION_DENIED", "The box tools are for agent chats only.");
    const owner = principal.kind === "agent" ? principal.threadId : threadId;
    return done(boxes.list().filter((box) => box.purpose === "temporary" && (owner === undefined || box.threadId === owner)));
  }

  get(principal: CallerPrincipal, boxId: string): BoxOutcome<BoxSummary> {
    return this.owned(principal, boxId);
  }

  /** An APPROVED `create_box` (agent principals only): the record is created and provisioning starts. */
  async create(principal: CallerPrincipal, body: unknown): Promise<BoxOutcome<BoxSummary>> {
    const boxes = this.connection?.boxes;
    if (!boxes) return DISABLED;
    if (principal.kind !== "agent") {
      return refuse(403, "PERMISSION_DENIED", "Temporary boxes are created only by an agent chat's create_box, after the owner approved it.");
    }
    const threadId = principal.threadId;
    if (this.deps.isChatOpen && !this.deps.isChatOpen(threadId)) return refuse(404, "THREAD_NOT_FOUND", "This chat is no longer open.");
    const request = parseCreateRequest(body);
    if (typeof request === "string") return refuse(400, "BOX_INVALID_REQUEST", request);
    let box: BoxSummary;
    try {
      box = await boxes.createTemporaryBox({
        threadId,
        kind: request.kind,
        provider: request.provider,
        size: request.size,
        region: request.region,
        ...(request.image !== undefined ? { image: request.image } : {}),
        lifetimeMinutes: request.lifetimeMinutes,
        purposeNote: request.purposeNote
      });
    } catch (error) {
      return this.serviceRefusal(error, "The box could not be created.");
    }
    // The chat closed while the box was being created: it never gets used, so it goes now.
    if (this.deps.isChatOpen && !this.deps.isChatOpen(threadId)) {
      this.destroyQuietly(boxes, box.id, "chat-closed");
      return refuse(404, "THREAD_NOT_FOUND", "This chat closed while its box was being created; the box is being destroyed.");
    }
    return done(box);
  }

  /** Destroy an owned box and wait for the provider to confirm. Idempotent. */
  async destroy(principal: CallerPrincipal, boxId: string, reason: TemporaryBoxDestroyReason = "agent"): Promise<BoxOutcome<BoxSummary>> {
    const found = this.owned(principal, boxId);
    if (!found.ok) return found;
    const boxes = this.connection!.boxes;
    if (found.value.state !== "destroyed") {
      try {
        await boxes.destroyBox(boxId, reason);
      } catch (error) {
        return this.serviceRefusal(error, "The provider did not confirm the destroy; the box may still be billing. Try destroy_box again.");
      }
    }
    await this.boxGone(boxId);
    return done(boxes.get(boxId) ?? found.value);
  }

  // -------------------------------------------------------------------------
  // Operations (DaemonApi)
  // -------------------------------------------------------------------------

  /**
   * Wait until an owned box is `ready` (event-driven: box changes), it fails, `timeoutMs` passes,
   * or the call is aborted.
   */
  async waitReady(boxId: string, timeoutMs: number, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxSummary>> {
    const principal = options.principal ?? { kind: "user" };
    const first = this.owned(principal, boxId);
    if (!first.ok) return first;
    const boxes = this.connection!.boxes;
    return await new Promise<BoxOutcome<BoxSummary>>((resolve) => {
      let finished = false;
      let unsubscribe: () => void = () => {};
      const finish = (outcome: BoxOutcome<BoxSummary>): void => {
        if (finished) return;
        finished = true;
        unsubscribe();
        this.clock.clearTimer(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const check = (): void => {
        const box = boxes.get(boxId);
        if (!box) return finish(refuse(409, "BOX_PROVISIONING_FAILED", "The box's record disappeared while it was starting."));
        if (box.state === "ready") return finish(done(box));
        if (box.state === "destroyed" || box.state === "destroying" || box.state === "destroy-failed") {
          // The failed step says why ("no instances available"); the state reason only says what
          // happens next ("Destroying…").
          const failed = (box.setup ?? []).find((step) => step.state === "failed");
          const why = failed?.message ? `${failed.label}: ${failed.message}` : (box.stateReason ?? box.destroyedReason ?? box.state);
          return finish(refuse(409, "BOX_PROVISIONING_FAILED", `The box did not start: ${clip(why.replace(/[.…]+$/, ""))}.`));
        }
      };
      const onAbort = (): void => finish(refuse(499, "CANCELLED", "The wait was cancelled."));
      const timer = this.clock.setTimer(
        () => finish(refuse(504, "BOX_NOT_READY", `The box was not ready within ${Math.round(timeoutMs / 60_000)} minutes.`)),
        timeoutMs
      );
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      unsubscribe = boxes.onChange((changed) => {
        if (changed === boxId) check();
      });
      check();
    });
  }

  /** Run a command in an owned, ready box: in the foreground (output tails returned) or as a background job. */
  async exec(boxId: string, request: BoxExecRequest, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxExecResult>> {
    const ready = this.readyConnection(options.principal ?? { kind: "user" }, boxId);
    if (!ready.ok) return ready;
    const connection = ready.value;
    const shell = request.shell ?? defaultShell(connection.sys.os);
    const argv = shellArgv(shell, connection.sys.os, request.command);
    if (argv === null) return refuse(400, "INVALID_ARGUMENT", `The ${shell} shell exists only on Windows boxes; this box runs ${connection.sys.os}.`);
    const cwd = boxPathFor(connection.sys, request.cwd);
    if (cwd === null) return refuse(400, "INVALID_ARGUMENT", "cwd is not a usable path.");
    if (options.signal?.aborted) return refuse(499, "CANCELLED", "The call was cancelled.");
    if (request.background) return await this.startJob(boxId, connection, shell, argv, cwd);
    return await this.runForeground(connection, shell, argv, cwd, request.timeoutSeconds * 1000, options.signal);
  }

  /**
   * A background job's state and output tail. `waitMs` > 0 waits (event-driven) until it exits, the
   * wait ends or the call is aborted. A job this daemon does not follow (it restarted) is followed
   * again from the box's buffer.
   */
  async jobOutput(boxId: string, jobId: string, waitMs: number, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxJobOutput>> {
    const found = this.owned(options.principal ?? { kind: "user" }, boxId);
    if (!found.ok) return found;
    let job = this.jobs.get(jobId);
    if (job && job.boxId !== boxId) job = undefined;
    if (!job) {
      const recovered = await this.recoverJob(boxId, jobId);
      if (!recovered.ok) return recovered;
      job = recovered.value;
    }
    if (waitMs > 0 && job.running && job.lost === null) await this.waitFor(job, () => !job!.running || job!.lost !== null, waitMs, options.signal);
    return done(jobSnapshot(job));
  }

  /** Copy a file or directory from the calling chat's project into an owned box. */
  async upload(boxId: string, request: { localPath: string; remotePath: string }, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxTransferResult>> {
    const principal = options.principal ?? { kind: "user" };
    const project = this.chatProject(principal);
    if (!project.ok) return project;
    const ready = this.readyConnection(principal, boxId);
    if (!ready.ok) return ready;
    const connection = ready.value;
    if (project.value.box) return await this.uploadFromBoxProject(project.value.box, project.value.root, connection, request, options.signal);
    const local = await this.insideProject(project.value.root, request.localPath);
    if (!local.ok) return local;
    const remote = boxPathFor(connection.sys, request.remotePath);
    if (remote === null || request.remotePath.trim() === "") return refuse(400, "INVALID_ARGUMENT", "remote_path is not a usable path.");
    let stats;
    try {
      stats = await lstat(local.value);
    } catch {
      return refuse(404, "NOT_FOUND", `Nothing at local_path ${clip(request.localPath, 200)}.`);
    }
    const counter = byteCounter(Number.POSITIVE_INFINITY);
    try {
      if (stats.isFile()) {
        const source = createReadStream(local.value);
        abortWith(options.signal, () => source.destroy(new Error("cancelled")));
        await connection.writeFile(remote, source.pipe(counter.stream), { mkdirs: true, mode: stats.mode & 0o777 });
        return done({ kind: "file", bytes: counter.bytes(), localPath: local.value, remotePath: remote });
      }
      if (stats.isDirectory()) {
        // The directory's CONTENTS: unpacked into `remote`, which becomes the copy.
        // COPYFILE_DISABLE: macOS bsdtar would add AppleDouble `._*` entries for extended attributes.
        const tar = spawn("tar", ["-cf", "-", "-C", local.value, "."], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
        const exited = processExit(tar);
        abortWith(options.signal, () => tar.kill("SIGTERM"));
        try {
          await connection.writeTar(remote, tar.stdout.pipe(counter.stream));
        } catch (error) {
          tar.kill("SIGTERM");
          await exited.catch(() => undefined);
          throw error;
        }
        const { code, stderr } = await exited;
        if (code !== 0) return refuse(500, "BOX_TRANSFER_FAILED", `tar could not read the directory${stderr ? `: ${clip(stderr, 300)}` : ""}.`);
        return done({ kind: "directory", bytes: counter.bytes(), localPath: local.value, remotePath: remote });
      }
      return refuse(400, "INVALID_ARGUMENT", "local_path must be a file or a directory.");
    } catch (error) {
      if (options.signal?.aborted) return refuse(499, "CANCELLED", "The upload was cancelled; the box may hold part of it.");
      return refuse(502, "BOX_TRANSFER_FAILED", `The upload failed: ${clip(transferMessage(error), 300)}`);
    }
  }

  /**
   * Copy a file or directory from an owned box into the calling chat's project. `localPath` is the
   * new item's path: an existing file is replaced, an existing directory is refused. Written to a
   * temporary sibling first and renamed into place, so a failed download leaves nothing half done.
   */
  async download(boxId: string, request: { remotePath: string; localPath: string }, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxTransferResult>> {
    const principal = options.principal ?? { kind: "user" };
    const project = this.chatProject(principal);
    if (!project.ok) return project;
    const ready = this.readyConnection(principal, boxId);
    if (!ready.ok) return ready;
    const connection = ready.value;
    if (project.value.box) return await this.downloadIntoBoxProject(project.value.box, project.value.root, connection, request, options.signal);
    const target = await this.insideProject(project.value.root, request.localPath);
    if (!target.ok) return target;
    const projectRoot = await assertInsideFsRoot(project.value.root, project.value.root);
    if (target.value === projectRoot) return refuse(400, "INVALID_ARGUMENT", "local_path is the project itself: name a new file or directory inside it.");
    // A box's bytes never land in git metadata: a planted config (core.fsmonitor) or hook would
    // run on the host the next time anything runs git in the project.
    if (await insideGitMetadata(projectRoot, request.localPath, target.value)) return refuse(403, "PERMISSION_DENIED", GIT_METADATA_REFUSAL);
    const remote = boxPathFor(connection.sys, request.remotePath);
    if (remote === null || request.remotePath.trim() === "") return refuse(400, "INVALID_ARGUMENT", "remote_path is not a usable path.");
    let remoteStat;
    try {
      remoteStat = await connection.request("fs.stat", { path: remote }, { ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      return refuse(502, "BOX_TRANSFER_FAILED", `The box could not read remote_path: ${clip(transferMessage(error), 300)}`);
    }
    if (remoteStat === null) return refuse(404, "NOT_FOUND", `Nothing at remote_path ${clip(remote, 200)} in the box.`);
    if (remoteStat.kind !== "file" && remoteStat.kind !== "dir") return refuse(400, "INVALID_ARGUMENT", "remote_path must be a file or a directory.");
    const existing = await lstat(target.value).catch(() => null);
    if (existing && (remoteStat.kind === "dir" || !existing.isFile())) {
      return refuse(409, "ALREADY_EXISTS", `local_path already exists${existing.isDirectory() ? " as a directory" : ""}: name a new path, or remove it first.`);
    }
    const parent = dirname(target.value);
    const id = (this.deps.newId ?? randomUUID)();
    const counter = byteCounter(BOX_DOWNLOAD_MAX_BYTES);
    let staging: string | null = null;
    try {
      await mkdir(parent, { recursive: true });
      if (remoteStat.kind === "file") {
        staging = join(parent, `.orq-download-${id}`);
        // A bounded read: the stat's size, at most one byte past the cap (so the counter trips on it).
        const length = Math.min(remoteStat.size, BOX_DOWNLOAD_MAX_BYTES + 1);
        const source = await connection.readFile(remote, { length, ...(options.signal ? { signal: options.signal } : {}) });
        abortWith(options.signal, () => source.destroy(new Error("cancelled")));
        await pipeline(source, counter.stream, createWriteStream(staging, { mode: (remoteStat.mode & 0o111) !== 0 ? 0o755 : 0o644, flags: "wx" }));
        await rename(staging, target.value);
        staging = null;
        return done({ kind: "file", bytes: counter.bytes(), localPath: target.value, remotePath: remote });
      }
      staging = await mkdtemp(join(parent, `.orq-download-`));
      const source = await connection.readTar(remote);
      abortWith(options.signal, () => source.destroy(new Error("cancelled")));
      // Unpacked by the host's tar into a fresh, private directory (tar refuses members that climb
      // out with `..` or absolute names, and links cannot redirect writes into existing paths there).
      const tar = spawn("tar", ["-xf", "-", "-C", staging, "--no-same-owner"], { stdio: ["pipe", "ignore", "pipe"] });
      const exited = processExit(tar);
      // Tar may stop at its end markers before the box finishes the stream. Keep reading and
      // counting that tail: a later box error or an oversized stream must still fail the download.
      const input = new PassThrough();
      let inputError: Error | null = null;
      tar.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") return;
        inputError = error;
        if (!input.writableFinished) input.destroy(error);
      });
      tar.stdin.once("close", () => {
        input.unpipe(tar.stdin);
        input.resume();
      });
      input.pipe(tar.stdin);
      void exited.then(
        ({ code, stderr }) => {
          if (code !== 0 && !input.writableFinished) input.destroy(new Error(`tar could not unpack the directory${stderr ? `: ${stderr}` : ""}`));
        },
        (error: Error) => {
          if (!input.writableFinished) input.destroy(error);
        }
      );
      try {
        await pipeline(source, counter.stream, input);
      } catch (error) {
        tar.kill("SIGTERM");
        await exited.catch(() => undefined);
        throw error;
      }
      const { code, stderr } = await exited;
      if (inputError !== null) throw inputError;
      if (code !== 0) throw new Error(`tar could not unpack the directory${stderr ? `: ${stderr}` : ""}`);
      const item = await this.unpackedItem(connection, remote, staging, options.signal);
      if (item === null) return refuse(400, "INVALID_ARGUMENT", NOT_A_DIRECTORY_REFUSAL);
      // A directory that carries git metadata (a `.git`, or is itself a git directory) would bring
      // its config and hooks onto the host: refused whole, nothing is moved into the project.
      if (await containsGitMetadata(item)) {
        return refuse(403, "PERMISSION_DENIED", GIT_TREE_REFUSAL);
      }
      await rename(item, target.value);
      const emptied = staging;
      staging = null;
      // The download is written: removing the emptied staging directory is best effort.
      if (item !== emptied) {
        await rm(emptied, { recursive: true, force: true }).catch((error: unknown) => {
          this.deps.logger?.warn?.("boxes: a download's emptied staging directory could not be removed", errorName(error));
        });
      }
      return done({ kind: "directory", bytes: counter.bytes(), localPath: target.value, remotePath: remote });
    } catch (error) {
      if (options.signal?.aborted) return refuse(499, "CANCELLED", "The download was cancelled; nothing was written.");
      if (counter.over()) return refuse(413, "TOO_LARGE", `The download is over ${BOX_DOWNLOAD_MAX_BYTES / 1024 ** 3} GiB; pack or split it in the box first.`);
      return refuse(502, "BOX_TRANSFER_FAILED", `The download failed: ${clip(transferMessage(error), 300)}`);
    } finally {
      if (staging !== null) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Expose an owned box's port where the calling chat can reach it (reused for the same port;
   * closed when the box goes): on a host loopback port, or — for a box project's chat — on its
   * project box's loopback, plus a host loopback port while its Browser tab runs on the host.
   * Refused rather than answered with a URL the chat could not open.
   */
  async forwardPort(boxId: string, port: number, options: BoxCallOptions = {}): Promise<BoxOutcome<BoxForwardResult>> {
    const principal = options.principal ?? { kind: "user" };
    const ready = this.readyConnection(principal, boxId);
    if (!ready.ok) return ready;
    const projectPath = principal.kind === "agent" ? principal.projectPath : "";
    let location: ProjectFsLocation;
    try {
      location = locateProjectFs(this.connection?.registry, projectPath);
    } catch (error) {
      // The project's box is gone or away: no URL in it, and a host one would not be reachable from it.
      if (error instanceof BoxFsUnavailableError) return projectBoxRefusal(error);
      throw error;
    }
    if (location.kind !== "box") {
      const host = await this.hostForward(principal, boxId, ready.value, port);
      return host.ok ? done({ url: loopbackUrl(host.value.hostPort), hostPort: host.value.hostPort, boxPort: host.value.boxPort }) : host;
    }
    const inProjectBox = await this.projectBoxForward(principal, boxId, ready.value, port, location.boxId);
    if (!inProjectBox.ok) return inProjectBox;
    const result: BoxForwardResult = { url: loopbackUrl(inProjectBox.value.boxPort), boxPort: port, projectBoxPort: inProjectBox.value.boxPort };
    if (this.connection?.browserRunsInBox?.(projectPath) === true) return done(result);
    // The Browser tab of this project runs on the host: it needs a host loopback port too.
    const host = await this.hostForward(principal, boxId, ready.value, port);
    return host.ok ? done({ ...result, browserUrl: loopbackUrl(host.value.hostPort), hostPort: host.value.hostPort }) : host;
  }

  /**
   * Around the awaits of {@link forwardPort}: the box is still the caller's, ready, and not being
   * cleaned up. Forwards are made only then, and put in the box's map at once, so a box's cleanup
   * closes every forward made for it; a call that finds the box gone after its forward opened
   * refuses (the cleanup closed it).
   */
  private stillForwardable(principal: CallerPrincipal, boxId: string): BoxOutcome<BoxSummary> {
    const found = this.owned(principal, boxId);
    if (!found.ok) return found;
    if (found.value.state !== "ready") return refuse(409, "BOX_NOT_READY", notReadyMessage(found.value));
    if (this.closing.has(boxId)) return refuse(409, "BOX_NOT_READY", "The box is going away; its port forwards were closed.");
    return found;
  }

  /** The listener in the project box `projectBoxId` piping to the temporary box's `port` (made on first use). */
  private async projectBoxForward(principal: CallerPrincipal, boxId: string, connection: BoxConnection, port: number, projectBoxId: string): Promise<BoxOutcome<ProjectBoxForward>> {
    const owner = this.connection?.projectForwards;
    if (!owner) return refuse(400, "BOX_UNSUPPORTED", "This chat's project runs in a box of its own, and forwarding into it is not available here: a host URL would not be reachable from it.");
    const known = this.projectForwards.get(boxId)?.get(port);
    // One that ended with its project box (destroyed, another box now, or refused on a reconnect) is made again.
    const settled = known ? await known.catch(() => null) : null;
    const alive = settled ? await settled.alive() : false;
    const still = this.stillForwardable(principal, boxId);
    if (!still.ok) return still;
    if (settled && (!alive || settled.projectBoxId !== projectBoxId)) {
      const ports = this.projectForwards.get(boxId);
      if (ports && ports.get(port) === known) ports.delete(port);
      void settled.close().catch(() => undefined);
    }
    let perBox = this.projectForwards.get(boxId);
    if (!perBox) {
      perBox = new Map();
      this.projectForwards.set(boxId, perBox);
    }
    let forward = perBox.get(port);
    if (!forward) {
      if (perBox.size >= MAX_FORWARDS_PER_BOX) return refuse(409, "FORWARD_LIMIT", `This box already has ${MAX_FORWARDS_PER_BOX} forwarded ports.`);
      forward = owner.open(projectBoxId, port, () => connection.openTcp(port));
      perBox.set(port, forward);
      const ports = perBox;
      // A failed forward is not remembered.
      forward.catch(() => {
        if (ports.get(port) === forward) ports.delete(port);
      });
    }
    try {
      const opened = await forward;
      const still = this.stillForwardable(principal, boxId);
      return still.ok ? done(opened) : still;
    } catch (error) {
      if (error instanceof BoxFsUnavailableError) return projectBoxRefusal(error);
      if (error instanceof ProjectBoxForwardError && error.code === "PROJECT_BOX_NOT_CONNECTED") {
        return refuse(409, "BOX_NOT_READY", "This chat's project runs in a box of its own, which is not connected right now (reconnecting…): the port could not be forwarded into it. Try again shortly.");
      }
      return refuse(502, "BOX_FORWARD_FAILED", `The port could not be opened in this chat's project box: ${clip(transferMessage(error), 300)}`);
    }
  }

  /** A host loopback port piping to the box's `port` (made on first use). */
  private async hostForward(principal: CallerPrincipal, boxId: string, connection: BoxConnection, port: number): Promise<BoxOutcome<{ hostPort: number; boxPort: number }>> {
    // A box project's call comes here after awaiting its project box's forward: the box may have gone since.
    const ready = this.stillForwardable(principal, boxId);
    if (!ready.ok) return ready;
    let perBox = this.forwards.get(boxId);
    if (!perBox) {
      perBox = new Map();
      this.forwards.set(boxId, perBox);
    }
    let forward = perBox.get(port);
    if (!forward) {
      if (perBox.size >= MAX_FORWARDS_PER_BOX) return refuse(409, "FORWARD_LIMIT", `This box already has ${MAX_FORWARDS_PER_BOX} forwarded ports.`);
      forward = connection.forwardToHost(port);
      perBox.set(port, forward);
      // A failed forward is not remembered.
      forward.catch(() => {
        if (perBox!.get(port) === forward) perBox!.delete(port);
      });
    }
    try {
      const open = await forward;
      const still = this.stillForwardable(principal, boxId);
      return still.ok ? done({ hostPort: open.hostPort, boxPort: open.boxPort }) : still;
    } catch (error) {
      return refuse(502, "BOX_FORWARD_FAILED", `The port could not be forwarded: ${clip(transferMessage(error), 300)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The ownership rule: the box, if this principal may reach it. */
  private owned(principal: CallerPrincipal, boxId: string): BoxOutcome<BoxSummary> {
    const boxes = this.connection?.boxes;
    if (!boxes) return DISABLED;
    if (principal.kind === "external") return refuse(403, "PERMISSION_DENIED", "The box tools are for agent chats only.");
    const box = boxes.get(boxId);
    if (!box || box.purpose !== "temporary") return NOT_FOUND;
    if (principal.kind === "agent" && box.threadId !== principal.threadId) return NOT_FOUND;
    return done(box);
  }

  /** An owned box that is ready and connected, as its connection. */
  private readyConnection(principal: CallerPrincipal, boxId: string): BoxOutcome<BoxConnection> {
    const found = this.owned(principal, boxId);
    if (!found.ok) return found;
    const box = found.value;
    if (box.state !== "ready") return refuse(409, "BOX_NOT_READY", notReadyMessage(box));
    const connection = this.connection!.hub.get(boxId);
    if (!connection || !connection.connected) return refuse(409, "BOX_NOT_READY", "The box is not connected right now (reconnecting…); try again shortly.");
    return done(connection);
  }

  /**
   * The calling chat's project, for file transfers: its root (a host path) and, for a box project,
   * the file system of its box (which must be connected).
   */
  private chatProject(principal: CallerPrincipal): BoxOutcome<{ root: string; box: BoxProjectFs | null }> {
    if (principal.kind !== "agent") return refuse(403, "PERMISSION_DENIED", "Files move between a box and the project of the agent chat that owns it.");
    if (principal.projectPath === "") return refuse(400, "NO_PROJECT", "This chat has no project, so there is nowhere on the host to move files from or to.");
    let location: ProjectFsLocation;
    try {
      location = locateProjectFs(this.connection?.registry, principal.projectPath);
    } catch (error) {
      if (error instanceof BoxFsUnavailableError) return projectBoxRefusal(error);
      throw error;
    }
    return done({ root: principal.projectPath, box: location.kind === "box" ? location.fs : null });
  }

  /** `path` resolved (realpath, symlinks included) inside `project`, or a refusal. */
  private async insideProject(project: string, path: string): Promise<BoxOutcome<string>> {
    if (path.trim() === "" || path.includes("\0")) return refuse(400, "INVALID_ARGUMENT", "local_path is not a usable path.");
    try {
      return done(await assertInsideFsRoot(project, path));
    } catch (error) {
      if (error instanceof FsSandboxError) return refuse(403, "PERMISSION_DENIED", "local_path must lie inside this chat's project.");
      throw error;
    }
  }

  /**
   * Which path of an unpacked tar is the downloaded directory itself. A box may pack the directory
   * (one top entry, its own name) or its contents (its entries at the top): a single top entry with
   * the directory's name is the directory, unless the box's listing says that name is its only
   * child — then two levels of that name mean the directory itself was packed. Null when the item
   * is not a real directory (a remote_path that is a symlink to one is packed as the symlink):
   * nothing is followed through it, scanned or moved into the project.
   */
  private async unpackedItem(
    connection: BoxConnection,
    remote: string,
    staging: string,
    signal: AbortSignal | undefined,
    fs: GitMetadataFs = HOST_GIT_METADATA_FS
  ): Promise<string | null> {
    const names = (await fs.list(staging)).map((entry) => entry.name);
    const name = boxBasename(remote);
    if (names.length !== 1 || names[0] !== name) return staging;
    const top = join(staging, name);
    const topIsDir = (await fs.kind(top)) === "dir";
    const listing = await connection.request("fs.readdir", { path: remote }, { ...(signal ? { signal } : {}) });
    const ownOnlyChild = listing.length === 1 && listing[0]!.name === name;
    if (ownOnlyChild) {
      // A top entry that is no real directory is one of the contents, not the packed directory.
      if (!topIsDir) return staging;
      const inner = await fs.list(top).catch(() => []);
      return inner.length === 1 && inner[0]!.name === name ? top : staging;
    }
    return topIsDir ? top : null;
  }

  /**
   * {@link upload} from a box project: the source is read in the project box (a file as its bytes,
   * a directory as the project box's `tar` of its contents) and streamed on into the temporary box.
   */
  private async uploadFromBoxProject(
    fs: BoxProjectFs,
    root: string,
    connection: BoxConnection,
    request: { localPath: string; remotePath: string },
    signal: AbortSignal | undefined
  ): Promise<BoxOutcome<BoxTransferResult>> {
    try {
      const local = await this.insideBoxProject(fs, root, request.localPath);
      if (!local.ok) return local;
      const remote = boxPathFor(connection.sys, request.remotePath);
      if (remote === null || request.remotePath.trim() === "") return refuse(400, "INVALID_ARGUMENT", "remote_path is not a usable path.");
      const stats = await fs.stat(local.value, { followSymlinks: false });
      if (stats === null) return refuse(404, "NOT_FOUND", `Nothing at local_path ${clip(request.localPath, 200)}.`);
      if (stats.kind !== "file" && stats.kind !== "dir") return refuse(400, "INVALID_ARGUMENT", "local_path must be a file or a directory.");
      const counter = byteCounter(Number.POSITIVE_INFINITY);
      try {
        if (stats.kind === "file") {
          const source = await fs.readStream(local.value, signal ? { signal } : {});
          abortWith(signal, () => source.destroy(new Error("cancelled")));
          await relay(source, counter.stream, connection.writeFile(remote, counter.stream, { mkdirs: true, mode: stats.mode & 0o777 }));
          return done({ kind: "file", bytes: counter.bytes(), localPath: local.value, remotePath: remote });
        }
        // The directory's CONTENTS (`tar -cf - .` in it, as on the host): unpacked into `remote`, which becomes the copy.
        // macOS's bsdtar would add AppleDouble `._*` entries for extended attributes unless told not to.
        const os = fs.connection.sys.os;
        const tar = fs.exec({
          command: os === "win32" ? "tar.exe" : "tar",
          args: ["-cf", "-", "."],
          cwd: local.value,
          ...(os === "darwin" ? { env: { COPYFILE_DISABLE: "1" } } : {})
        });
        tar.stdin.end();
        const exited = boxProcessExit(tar);
        abortWith(signal, () => {
          tar.kill("SIGTERM");
          counter.stream.destroy(new Error("cancelled"));
        });
        try {
          await relay(tar.stdout, counter.stream, connection.writeTar(remote, counter.stream));
        } catch (error) {
          tar.kill("SIGTERM");
          await exited.catch(() => undefined);
          throw error;
        }
        const { code, stderr } = await exited;
        if (code !== 0) {
          if (!fs.connection.connected) return projectBoxRefusal(fs.notConnected());
          return refuse(500, "BOX_TRANSFER_FAILED", `tar could not read the directory${stderr ? `: ${clip(stderr, 300)}` : ""}.`);
        }
        return done({ kind: "directory", bytes: counter.bytes(), localPath: local.value, remotePath: remote });
      } catch (error) {
        if (signal?.aborted) return refuse(499, "CANCELLED", "The upload was cancelled; the box may hold part of it.");
        throw error;
      }
    } catch (error) {
      if (error instanceof BoxFsUnavailableError) return projectBoxRefusal(error);
      if (!fs.connection.connected) return projectBoxRefusal(fs.notConnected());
      return refuse(502, "BOX_TRANSFER_FAILED", `The upload failed: ${clip(transferMessage(error), 300)}`);
    }
  }

  /**
   * {@link download} into a box project, with the host's rules checked in the project box: a file
   * streamed into a staging sibling there, a directory unpacked there by its `writeTar`, then
   * renamed into place (the staging is removed on every failure; one the project box could not
   * remove, its link down, is removed when it reconnects: {@link removeStaging}).
   */
  private async downloadIntoBoxProject(
    fs: BoxProjectFs,
    root: string,
    connection: BoxConnection,
    request: { remotePath: string; localPath: string },
    signal: AbortSignal | undefined
  ): Promise<BoxOutcome<BoxTransferResult>> {
    const gitFs = boxGitMetadataFs(fs);
    let staging: string | null = null;
    const counter = byteCounter(BOX_DOWNLOAD_MAX_BYTES);
    try {
      const target = await this.insideBoxProject(fs, root, request.localPath);
      if (!target.ok) return target;
      const projectRoot = await fs.assertInside(root, root);
      if (target.value === projectRoot) return refuse(400, "INVALID_ARGUMENT", "local_path is the project itself: name a new file or directory inside it.");
      // Git in the project box runs that config and those hooks just the same.
      if (await insideGitMetadata(projectRoot, request.localPath, target.value, gitFs)) return refuse(403, "PERMISSION_DENIED", GIT_METADATA_REFUSAL);
      const remote = boxPathFor(connection.sys, request.remotePath);
      if (remote === null || request.remotePath.trim() === "") return refuse(400, "INVALID_ARGUMENT", "remote_path is not a usable path.");
      let remoteStat;
      try {
        remoteStat = await connection.request("fs.stat", { path: remote }, { ...(signal ? { signal } : {}) });
      } catch (error) {
        return refuse(502, "BOX_TRANSFER_FAILED", `The box could not read remote_path: ${clip(transferMessage(error), 300)}`);
      }
      if (remoteStat === null) return refuse(404, "NOT_FOUND", `Nothing at remote_path ${clip(remote, 200)} in the box.`);
      if (remoteStat.kind !== "file" && remoteStat.kind !== "dir") return refuse(400, "INVALID_ARGUMENT", "remote_path must be a file or a directory.");
      const existing = await gitFs.kind(target.value);
      if (existing !== null && (remoteStat.kind === "dir" || existing !== "file")) {
        return refuse(409, "ALREADY_EXISTS", `local_path already exists${existing === "dir" ? " as a directory" : ""}: name a new path, or remove it first.`);
      }
      const parent = dirname(target.value);
      staging = join(parent, `.orq-download-${(this.deps.newId ?? randomUUID)()}`);
      await fs.mkdir(parent, { recursive: true });
      if (remoteStat.kind === "file") {
        // A bounded read: the stat's size, at most one byte past the cap (so the counter trips on it).
        const length = Math.min(remoteStat.size, BOX_DOWNLOAD_MAX_BYTES + 1);
        const source = await connection.readFile(remote, { length, ...(signal ? { signal } : {}) });
        abortWith(signal, () => source.destroy(new Error("cancelled")));
        await relay(source, counter.stream, fs.writeFile(staging, counter.stream, { mode: (remoteStat.mode & 0o111) !== 0 ? 0o755 : 0o644 }));
        await fs.rename(staging, target.value);
        staging = null;
        return done({ kind: "file", bytes: counter.bytes(), localPath: target.value, remotePath: remote });
      }
      await fs.mkdir(staging);
      const source = await connection.readTar(remote);
      abortWith(signal, () => source.destroy(new Error("cancelled")));
      // Unpacked by the project box's tar into the fresh staging directory (the host's rules: no
      // members out of it, links cannot redirect writes into existing paths there).
      await relay(source, counter.stream, fs.connection.writeTar(fs.toBox(staging), counter.stream));
      const item = await this.unpackedItem(connection, remote, staging, signal, gitFs);
      if (item === null) return refuse(400, "INVALID_ARGUMENT", NOT_A_DIRECTORY_REFUSAL);
      if (await containsGitMetadata(item, gitFs)) return refuse(403, "PERMISSION_DENIED", GIT_TREE_REFUSAL);
      await fs.rename(item, target.value);
      const emptied = staging;
      staging = null;
      // The download is written: removing the emptied staging directory is best effort.
      if (item !== emptied) await this.removeStaging(fs, emptied);
      return done({ kind: "directory", bytes: counter.bytes(), localPath: target.value, remotePath: remote });
    } catch (error) {
      if (signal?.aborted) return refuse(499, "CANCELLED", "The download was cancelled; nothing was written.");
      if (counter.over()) return refuse(413, "TOO_LARGE", `The download is over ${BOX_DOWNLOAD_MAX_BYTES / 1024 ** 3} GiB; pack or split it in the box first.`);
      if (error instanceof BoxFsUnavailableError) return projectBoxRefusal(error);
      if (!fs.connection.connected) return projectBoxRefusal(fs.notConnected());
      return refuse(502, "BOX_TRANSFER_FAILED", `The download failed: ${clip(transferMessage(error), 300)}`);
    } finally {
      if (staging !== null) await this.removeStaging(fs, staging);
    }
  }

  /**
   * Remove a download's staging path in a project box. One it could not remove (its link dropped,
   * which also ends the transfer) is remembered and removed when that box reconnects, so an
   * unscanned tree is not left in the project. Like a host download's staging when the daemon exits
   * mid-transfer, one still remembered when the daemon stops stays behind.
   */
  private async removeStaging(fs: BoxProjectFs, path: string): Promise<void> {
    try {
      await fs.rm(path, { recursive: true, force: true });
    } catch {
      this.leaveStaging(fs, path);
    }
  }

  private leaveStaging(fs: BoxProjectFs, path: string): void {
    let left = this.leftStaging.get(fs.boxId);
    if (!left) {
      const boxId = fs.boxId;
      const entry = { fs, paths: new Set<string>(), unsubscribe: () => {} };
      entry.unsubscribe = fs.connection.onStatus((connected) => {
        if (connected) void this.removeLeftStaging(boxId);
      });
      this.leftStaging.set(boxId, entry);
      left = entry;
    }
    left.paths.add(path);
    // The link may have come back before this was remembered.
    if (fs.connection.connected) void this.removeLeftStaging(fs.boxId);
  }

  /** The staging paths a project box could not remove, removed now (each starts at once); those failing again wait for the next reconnect. */
  private async removeLeftStaging(boxId: string): Promise<void> {
    const left = this.leftStaging.get(boxId);
    if (!left) return;
    await Promise.all(
      [...left.paths].map(async (path) => {
        try {
          await left.fs.rm(path, { recursive: true, force: true });
          left.paths.delete(path);
        } catch (error) {
          this.deps.logger?.warn?.("boxes: a project box's download staging could not be removed yet", errorName(error));
        }
      })
    );
    if (left.paths.size === 0 && this.leftStaging.get(boxId) === left) {
      left.unsubscribe();
      this.leftStaging.delete(boxId);
    }
  }

  /** `path` resolved in the project box (realpath there, symlinks included) inside `root`, or a refusal. */
  private async insideBoxProject(fs: BoxProjectFs, root: string, path: string): Promise<BoxOutcome<string>> {
    if (path.trim() === "" || path.includes("\0")) return refuse(400, "INVALID_ARGUMENT", "local_path is not a usable path.");
    if (!path.startsWith("/")) return refuse(403, "PERMISSION_DENIED", "local_path must lie inside this chat's project.");
    try {
      return done(await fs.assertInside(root, path));
    } catch (error) {
      if (error instanceof FsSandboxError) return refuse(403, "PERMISSION_DENIED", "local_path must lie inside this chat's project.");
      throw error;
    }
  }

  private async runForeground(
    connection: BoxConnection,
    shell: BoxShell,
    argv: { command: string; args: string[] },
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal | undefined
  ): Promise<BoxOutcome<BoxExecResult>> {
    const started = this.clock.now();
    const stdout = new OutputTail(EXEC_STDOUT_TAIL_BYTES);
    const stderr = new OutputTail(EXEC_STDERR_TAIL_BYTES);
    let process: BoxProcess;
    try {
      process = connection.exec({ command: argv.command, args: argv.args, cwd });
    } catch (error) {
      return refuse(502, "BOX_EXEC_FAILED", `The command could not be started: ${clip(transferMessage(error), 300)}`);
    }
    // A process error after the answer must never be an unhandled 'error' event.
    process.on("error", ignore);
    process.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    let timedOut = false;
    let cancelled = false;
    const timers: unknown[] = [];
    const stop = (): void => {
      process.kill("SIGTERM");
      timers.push(this.clock.setTimer(() => process.kill("SIGKILL"), KILL_GRACE_MS));
    };
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(
      this.clock.setTimer(() => {
        timedOut = true;
        stop();
      }, timeoutMs)
    );
    const ended = await new Promise<{ code: number | null; signal: string | null } | { error: Error }>((resolve) => {
      let exit: { code: number | null; signal: string | null } | null = null;
      let open = 2;
      let settled = false;
      const settle = (value: { code: number | null; signal: string | null } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const streamEnded = (): void => {
        open -= 1;
        if (open === 0 && exit) settle(exit);
      };
      process.stdout.once("end", streamEnded);
      process.stderr.once("end", streamEnded);
      process.once("error", (error) => settle({ error }));
      process.once("exit", (code, exitSignal) => {
        exit = { code, signal: exitSignal };
        if (open === 0) return settle(exit);
        // Output streams that never end must not hold the answer.
        timers.push(this.clock.setTimer(() => settle(exit!), OUTPUT_DRAIN_MS));
      });
    });
    for (const timer of timers) this.clock.clearTimer(timer);
    signal?.removeEventListener("abort", onAbort);
    if ("error" in ended) return refuse(502, "BOX_EXEC_FAILED", `${argv.command} could not be started in the box: ${clip(ended.error.message, 300)}`);
    if (cancelled) return refuse(499, "CANCELLED", "The call was cancelled; the command was stopped.");
    return done({
      background: false,
      shell,
      exitCode: ended.code,
      signal: ended.signal,
      timedOut,
      connectionLost: !timedOut && ended.signal === "SIGHUP" && !connection.connected,
      durationMs: Math.max(0, this.clock.now() - started),
      stdout: stdout.snapshot(),
      stderr: stderr.snapshot()
    });
  }

  private async startJob(boxId: string, connection: BoxConnection, shell: BoxShell, argv: { command: string; args: string[] }, cwd: string): Promise<BoxOutcome<BoxExecResult>> {
    const running = [...this.jobs.values()].filter((job) => job.boxId === boxId && job.running).length;
    if (running >= MAX_RUNNING_JOBS_PER_BOX) return refuse(409, "JOB_LIMIT", `This box already runs ${MAX_RUNNING_JOBS_PER_BOX} background jobs; wait for one to finish.`);
    const jobId = `job-${(this.deps.newId ?? randomUUID)()}`;
    let process: BoxProcess;
    try {
      process = connection.exec({ command: argv.command, args: argv.args, cwd, detach: { procId: jobId } });
    } catch (error) {
      return refuse(502, "BOX_EXEC_FAILED", `The job could not be started: ${clip(transferMessage(error), 300)}`);
    }
    const startedAt = new Date(this.clock.now()).toISOString();
    const job: Job = {
      jobId,
      boxId,
      tail: new OutputTail(JOB_OUTPUT_TAIL_BYTES),
      received: 0,
      running: true,
      exitCode: null,
      signal: null,
      startedAt,
      finishedAt: null,
      lost: null,
      released: false,
      waiters: new Set(),
      detach: () => {}
    };
    // The spawn report (or an immediate failure) decides the answer; a box that never reports one is
    // taken as started after a deadline (the job then shows what happened).
    const failure = await new Promise<Error | null>((resolve) => {
      const timer = this.clock.setTimer(() => resolve(null), SPAWN_REPORT_MS);
      const settle = (error: Error | null): void => {
        this.clock.clearTimer(timer);
        process.off("spawn", onSpawn);
        process.off("error", onError);
        process.off("exit", onExit);
        resolve(error);
      };
      const onSpawn = (): void => settle(null);
      const onError = (error: Error): void => settle(error);
      const onExit = (): void => settle(null);
      process.once("spawn", onSpawn);
      process.once("error", onError);
      process.once("exit", onExit);
      // Output that arrives before the spawn report is the job's too.
      this.follow(job, connection, process);
    });
    if (failure) {
      job.detach();
      return refuse(502, "BOX_EXEC_FAILED", `${argv.command} could not be started in the box: ${clip(failure.message, 300)}`);
    }
    this.jobs.set(jobId, job);
    return done({ background: true, shell, jobId, startedAt });
  }

  /** Collect a job's output from `process`; re-follow from the last offset when the box reconnects. */
  private follow(job: Job, connection: BoxConnection, process: BoxProcess): void {
    job.detach();
    // A process error once nobody follows it must never be an unhandled 'error' event.
    process.on("error", ignore);
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      job.received += bytes.length;
      job.tail.push(bytes);
      wake(job);
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      job.running = false;
      job.exitCode = code;
      job.signal = exitSignal;
      job.finishedAt = new Date(this.clock.now()).toISOString();
      cleanup();
      wake(job);
      this.releaseJob(job, connection);
    };
    const onError = (error: Error): void => {
      if (!job.running) return;
      job.running = false;
      job.lost = `The job failed in the box: ${clip(error.message, 300)}`;
      cleanup();
      wake(job);
    };
    let unsubscribeStatus: (() => void) | null = null;
    const onDetached = (): void => {
      cleanup();
      // Follow again from the last byte seen once the link is back.
      unsubscribeStatus = connection.onStatus((connected) => {
        if (!connected) return;
        unsubscribeStatus?.();
        unsubscribeStatus = null;
        try {
          this.follow(job, connection, connection.attach(job.jobId, job.received));
        } catch (error) {
          job.running = false;
          job.lost = `The box reconnected, but the job could not be followed again: ${clip(transferMessage(error), 300)}`;
          wake(job);
        }
      });
      job.detach = () => {
        unsubscribeStatus?.();
        unsubscribeStatus = null;
      };
    };
    const cleanup = (): void => {
      process.stdout.off("data", onData);
      process.stderr.off("data", onData);
      process.off("exit", onExit);
      process.off("error", onError);
      process.off("detached", onDetached);
    };
    process.stdout.on("data", onData);
    process.stderr.on("data", onData);
    process.on("exit", onExit);
    process.on("error", onError);
    process.on("detached", onDetached);
    job.detach = cleanup;
  }

  /** The box's buffer of a finished job is freed once its exit is seen here (its tail stays on the host). */
  private releaseJob(job: Job, connection: BoxConnection): void {
    if (job.released) return;
    job.released = true;
    void connection.request("proc.release", { procId: job.jobId }).catch((error: unknown) => {
      this.deps.logger?.warn?.("boxes: a finished job's buffer could not be released", errorName(error));
    });
  }

  /** A job the box runs but this daemon does not follow (it restarted): followed again from the box's buffer. */
  private async recoverJob(boxId: string, jobId: string): Promise<BoxOutcome<Job>> {
    const unknown = refuse(404, "JOB_NOT_FOUND", "No background job with that id in this box (a job's record ends when the box is destroyed).");
    if (!/^job-[A-Za-z0-9-]{1,80}$/.test(jobId)) return unknown;
    const connection = this.connection?.hub.get(boxId);
    if (!connection || !connection.connected) return refuse(409, "BOX_NOT_READY", "The box is not connected right now (reconnecting…); try again shortly.");
    let info;
    try {
      info = (await connection.request("proc.list", {})).find((proc) => proc.procId === jobId);
    } catch (error) {
      return refuse(502, "BOX_EXEC_FAILED", `The box could not list its jobs: ${clip(transferMessage(error), 300)}`);
    }
    if (!info) return unknown;
    const from = Math.max(info.bufferStart, info.outputBytes - JOB_OUTPUT_TAIL_BYTES);
    const job: Job = {
      jobId,
      boxId,
      tail: new OutputTail(JOB_OUTPUT_TAIL_BYTES),
      received: from,
      running: info.running,
      exitCode: info.exitCode,
      signal: info.signal,
      startedAt: null,
      finishedAt: null,
      lost: null,
      released: false,
      waiters: new Set(),
      detach: () => {}
    };
    let process: BoxProcess;
    try {
      process = connection.attach(jobId, from);
    } catch (error) {
      return refuse(502, "BOX_EXEC_FAILED", `The job could not be followed again: ${clip(transferMessage(error), 300)}`);
    }
    // Output before `from` is no longer in the box's buffer or was beyond the kept tail.
    job.tail.total = from;
    this.follow(job, connection, process);
    this.jobs.set(jobId, job);
    // The buffered output replays first: wait for it (bounded) so this answer shows it.
    await this.waitFor(job, () => job.received >= info.outputBytes || !job.running, JOB_REPLAY_MS, undefined);
    return done(job);
  }

  /** Resolve once `ready()` holds, `ms` passed, or `signal` aborted — woken by the job's events. */
  private waitFor(target: Waitable, ready: () => boolean, ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ready() || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        target.waiters.delete(check);
        this.clock.clearTimer(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const check = (): void => {
        if (ready()) finish();
      };
      const timer = this.clock.setTimer(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
      target.waiters.add(check);
    });
  }

  private boxChanged(boxId: string): void {
    const box = this.connection?.boxes.get(boxId);
    // A machine of the owner's lent to a chat and given back is no longer the chat's either.
    if (!box || box.state === "destroying" || box.state === "destroyed" || box.purpose !== "temporary") void this.boxGone(boxId);
  }

  /** A box went: its forwards close and its jobs are forgotten. Concurrent calls share one cleanup. */
  private boxGone(boxId: string): Promise<void> {
    const running = this.closing.get(boxId);
    if (running) return running;
    const cleanup = this.cleanUpBox(boxId).finally(() => {
      if (this.closing.get(boxId) === cleanup) this.closing.delete(boxId);
    });
    this.closing.set(boxId, cleanup);
    return cleanup;
  }

  private async cleanUpBox(boxId: string): Promise<void> {
    for (const [jobId, job] of this.jobs) {
      if (job.boxId !== boxId) continue;
      job.detach();
      if (job.running) {
        job.running = false;
        job.lost = "The box was destroyed.";
      }
      wake(job);
      this.jobs.delete(jobId);
    }
    const perBox = this.forwards.get(boxId) ?? new Map();
    this.forwards.delete(boxId);
    const inProjectBoxes = this.projectForwards.get(boxId) ?? new Map();
    this.projectForwards.delete(boxId);
    await Promise.all(
      [...perBox.values(), ...inProjectBoxes.values()].map(async (forward: Promise<{ close(): Promise<void> }>) => {
        try {
          await (await forward).close();
        } catch {
          // A forward that never opened, or one already closed: nothing to close.
        }
      })
    );
  }

  private async closeEverything(): Promise<void> {
    const boxIds = new Set([...this.forwards.keys(), ...this.projectForwards.keys(), ...[...this.jobs.values()].map((job) => job.boxId)]);
    for (const job of this.jobs.values()) job.detach();
    this.jobs.clear();
    await Promise.all([...boxIds].map((boxId) => this.boxGone(boxId)));
  }

  private availabilityChanged(): void {
    for (const listener of [...this.availability]) {
      try {
        listener();
      } catch (error) {
        this.deps.logger?.warn?.("boxes: an availability listener failed", errorName(error));
      }
    }
  }

  private destroyQuietly(boxes: Pick<TemporaryBoxes, "destroyBox">, boxId: string, reason: BoxDestroyedReason): void {
    void boxes.destroyBox(boxId, reason).then(
      () => this.boxGone(boxId),
      (error: unknown) => this.deps.logger?.error?.(`boxes: destroying box ${boxId} (${reason}) failed`, errorName(error))
    );
  }

  /** A box-service error as the agent reads it: its own message for a known code, else a generic one. */
  private serviceRefusal(error: unknown, fallback: string): { ok: false; code: string; message: string; status: number } {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(BOX_ERROR_STATUS, code)) {
      const message = error instanceof Error && error.message.trim() !== "" ? clip(error.message) : fallback;
      return refuse(BOX_ERROR_STATUS[code as BoxErrorCode], code, message);
    }
    this.deps.logger?.error?.("boxes: the box service failed", errorName(error));
    return refuse(500, "INTERNAL", fallback);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ignore = (): void => {};

function jobSnapshot(job: Job): BoxJobOutput {
  return {
    jobId: job.jobId,
    running: job.running,
    exitCode: job.exitCode,
    signal: job.signal,
    output: job.tail.snapshot(),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lost: job.lost
  };
}

function notReadyMessage(box: BoxSummary): string {
  switch (box.state) {
    case "provisioning":
      return "The box is still starting; wait for create_box to return.";
    case "unreachable":
      return "The box is unreachable right now (reconnecting…); try again shortly.";
    case "destroying":
      return "The box is being destroyed.";
    case "destroy-failed":
      return "Destroying the box failed; call destroy_box again.";
    case "destroyed":
      return `The box was destroyed${box.destroyedReason ? ` (${box.destroyedReason})` : ""}; create a new one if you still need one.`;
    default:
      return `The box is ${box.state}.`;
  }
}

/** The create body, validated, or the reason it is refused. */
function parseCreateRequest(body: unknown): CreateTemporaryBoxRequest | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "The body must be an object.";
  const b = body as Record<string, unknown>;
  if (!isBoxKind(b.kind)) return "kind is not a box kind.";
  if (!isBoxProviderId(b.provider)) return "provider is not a box provider.";
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
  if (!text(b.size, 200) || !text(b.region, 200)) return "size and region are required.";
  if (b.image !== undefined && !text(b.image, 200)) return "image must be an image id.";
  const lifetime = b.lifetimeMinutes;
  if (typeof lifetime !== "number" || !Number.isInteger(lifetime) || lifetime < TEMPORARY_BOX_MIN_LIFETIME_MINUTES || lifetime > TEMPORARY_BOX_MAX_LIFETIME_MINUTES) {
    return `lifetimeMinutes must be a whole number from ${TEMPORARY_BOX_MIN_LIFETIME_MINUTES} to ${TEMPORARY_BOX_MAX_LIFETIME_MINUTES}.`;
  }
  if (!text(b.purposeNote, TEMPORARY_BOX_PURPOSE_MAX_CHARS)) return `purposeNote is required (at most ${TEMPORARY_BOX_PURPOSE_MAX_CHARS} characters).`;
  return {
    kind: b.kind,
    provider: b.provider,
    size: b.size,
    region: b.region,
    ...(b.image !== undefined ? { image: b.image as string } : {}),
    lifetimeMinutes: lifetime,
    purposeNote: b.purposeNote
  };
}

/** A pass-through stream that counts bytes and fails once more than `max` went through. */
function byteCounter(max: number): { stream: Transform; bytes(): number; over(): boolean } {
  let bytes = 0;
  let over = false;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > max) {
        over = true;
        callback(new Error("too large"));
        return;
      }
      callback(null, chunk);
    }
  });
  return { stream, bytes: () => bytes, over: () => over };
}

/** Run `fn` once when `signal` aborts (now, if it already has). */
function abortWith(signal: AbortSignal | undefined, fn: () => void): void {
  if (!signal) return;
  if (signal.aborted) fn();
  else signal.addEventListener("abort", fn, { once: true });
}

/** A child's exit code and the end of its stderr (for the message). */
function processExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    let held = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (held < 4096) {
        stderr.push(chunk);
        held += chunk.length;
      }
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8").trim() }));
  });
  // Awaited later, after the stream it feeds: a spawn failure meanwhile must not be an unhandled rejection.
  exited.catch(() => undefined);
  return exited;
}

/**
 * Stream `source` through `through` into `write` (the box write consuming `through`). Settles once
 * both ended: a box that commits before the source ends still waits for it (a later source error or
 * the byte cap fails the transfer); a failure on either side destroys the other.
 */
async function relay(source: Readable, through: Transform, write: Promise<void>): Promise<void> {
  const piped = pipeline(source, through);
  piped.catch(() => undefined);
  try {
    await Promise.all([write, piped]);
  } catch (error) {
    source.destroy();
    through.destroy();
    throw error;
  }
}

/** A box process's exit (a link drop ends it with SIGHUP) and the start of its stderr (for the message). */
function boxProcessExit(process: BoxProcess): Promise<{ code: number | null; stderr: string }> {
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    let held = 0;
    process.stderr.on("data", (chunk: Buffer | string) => {
      if (held < 4096) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr.push(bytes);
        held += bytes.length;
      }
    });
    process.once("error", reject);
    process.once("exit", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8").trim() }));
  });
  exited.catch(() => undefined);
  return exited;
}

/** The project box cannot be reached: the refusal names the chat's project box, not the temporary one. */
function projectBoxRefusal(error: BoxFsUnavailableError): { ok: false; code: string; message: string; status: number } {
  return refuse(error.status, error.code, `This chat's project lives in its own box (${error.boxId}). ${error.message}`);
}

/** The URL of a loopback port (the host's or a box's, depending on where it is opened). */
function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** A transfer error's message (the box's or a stream's), without anything that is not text. */
function transferMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
