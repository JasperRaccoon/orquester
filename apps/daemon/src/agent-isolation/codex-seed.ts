/**
 * Agent isolation — seeding a prepared `CODEX_HOME`'s state DB before its
 * `sessions/` is linked to the shared one (spec §6.2 "Index seeding").
 *
 * A fresh home's state DB backfills from every rollout under `sessions/`
 * (tens of seconds to minutes on a large history), and the app server
 * answers nothing meanwhile. Seeding starts `codex app-server` once against
 * an EMPTY real `sessions/` directory, waits for `initialize` (the DB file
 * exists by the time it answers — observed with codex-cli 0.159.0 on a temp
 * home: `state_5.sqlite` present at the reply, clean exit on stdin EOF), stops
 * it, and only then replaces `sessions/` with the symlink. Later starts never
 * rescan, and old threads resume through Codex's filename fallback.
 *
 * The transport is the chat adapter's (`spawnProviderChild`, `CodexPeer`,
 * `withDeadline`) with the same `initialize` / `initialized` handshake.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readlink, rename, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodexPeer, CodexRequestRefusal } from "../agent-host/adapters/codex/protocol.ts";
import { withDeadline } from "../agent-host/support/deadline.ts";
import { describeExit, spawnProviderChild } from "../agent-host/support/spawn.ts";

/**
 * The state DB codex-cli 0.159.0 creates in `CODEX_HOME` (the number is the
 * DB format generation; a Codex upgrade that changes it leaves the file
 * missing, and {@link codexStateDbPresent} tells the caller to re-seed).
 */
export const CODEX_STATE_DB_FILE = "state_5.sqlite";

const DEFAULT_SEED_TIMEOUT_MS = 30_000;
/** How long a child that got stdin EOF may take to exit before it is killed. */
const EXIT_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 2048;

export interface SeedCodexHomeOptions {
  /** The prepared profile home (it must exist). */
  codexHome: string;
  /** What `<codexHome>/sessions` will link to: the account home's `sessions/`. */
  sessionsTarget: string;
  /** Absolute path to the `codex` binary. */
  codexBin: string;
  /** The child's complete environment (PATH, HOME, …); `CODEX_HOME` is set here. */
  env: Readonly<Record<string, string>>;
  /** Deadline for spawn → `initialize` reply (default 30 s). */
  timeoutMs?: number;
  /** Arguments to `codexBin`; `["app-server"]` unless a test runs a fake. */
  args?: readonly string[];
  /** How long the child may take to exit after stdin EOF before it is killed (default 5 s). */
  exitGraceMs?: number;
}

export type SeedCodexHomeResult =
  /** `sessions/` already linked to `sessionsTarget` and the state DB present: nothing done. */
  | { action: "none" }
  /** The DB was present; only the link was created or retargeted. */
  | { action: "linked" }
  /** `codex app-server` ran through `initialize` on an empty `sessions/`, then the link was made. */
  | { action: "seeded" };

/** Whether `<codexHome>/state_5.sqlite` exists (see {@link CODEX_STATE_DB_FILE}). */
export async function codexStateDbPresent(codexHome: string): Promise<boolean> {
  try {
    return (await lstat(join(codexHome, CODEX_STATE_DB_FILE))).isFile();
  } catch {
    return false;
  }
}

/** One seed per home at a time, in this process; a second caller joins the first. */
const inFlight = new Map<string, Promise<SeedCodexHomeResult>>();

/**
 * Makes `<codexHome>/sessions` a symlink to `sessionsTarget` with the state
 * DB already built, seeding it first when needed (see the module header).
 * Idempotent; concurrent calls for the same home share one run. Throws an
 * `Error` naming the problem when Codex cannot be started, does not answer in
 * time, or answers without creating the expected DB; `sessions/` is then left
 * an empty real directory, so the next call seeds again. A non-empty real
 * `sessions/` directory is never deleted: that throws too.
 */
export function seedCodexHome(options: SeedCodexHomeOptions): Promise<SeedCodexHomeResult> {
  const key = resolve(options.codexHome);
  const running = inFlight.get(key);
  if (running !== undefined) {
    return running;
  }
  const run = seed(options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

type SessionsState =
  | { kind: "missing" }
  | { kind: "link"; target: string }
  | { kind: "dir"; empty: boolean }
  | { kind: "other" };

async function sessionsState(path: string): Promise<SessionsState> {
  let st;
  try {
    st = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (st.isSymbolicLink()) return { kind: "link", target: await readlink(path) };
  if (st.isDirectory()) return { kind: "dir", empty: (await readdir(path)).length === 0 };
  return { kind: "other" };
}

async function seed(options: SeedCodexHomeOptions): Promise<SeedCodexHomeResult> {
  const sessions = join(options.codexHome, "sessions");
  const state = await sessionsState(sessions);
  const dbPresent = await codexStateDbPresent(options.codexHome);

  if (state.kind === "other") {
    throw new Error(`${sessions} is neither a directory nor a symlink.`);
  }
  if (state.kind === "dir" && !state.empty) {
    throw new Error(`${sessions} is a non-empty directory; refusing to replace it with a link.`);
  }
  if (dbPresent) {
    // The DB is built (a finished seed, or one that crashed before linking):
    // Codex never rescans an existing DB, so only the link may be missing.
    if (state.kind === "link" && state.target === options.sessionsTarget) {
      return { action: "none" };
    }
    await placeLink(options.codexHome, options.sessionsTarget);
    return { action: "linked" };
  }

  // Seed: an empty real `sessions/` while Codex builds its DB.
  if (state.kind === "link") {
    await unlink(sessions);
  }
  if (state.kind !== "dir") {
    await mkdir(sessions, { mode: 0o700 });
  }
  await initializeOnce(options);
  if (!(await codexStateDbPresent(options.codexHome))) {
    throw new Error(
      `codex app-server answered initialize but ${CODEX_STATE_DB_FILE} was not created in ${options.codexHome}; ` +
        "the Codex state DB name may have changed (update CODEX_STATE_DB_FILE)."
    );
  }
  await placeLink(options.codexHome, options.sessionsTarget);
  return { action: "seeded" };
}

/** Replaces `<home>/sessions` (an empty dir, a link, or nothing) with a link to `target`. */
async function placeLink(codexHome: string, target: string): Promise<void> {
  const sessions = join(codexHome, "sessions");
  const tag = randomBytes(6).toString("hex");
  const tmpLink = join(codexHome, `.sessions.link-${tag}`);
  await symlink(target, tmpLink);
  try {
    const state = await sessionsState(sessions);
    if (state.kind === "dir") {
      // rename(2) cannot put a link over a directory: move the (seed-only)
      // directory aside first, then drop it once the link is in place.
      const aside = join(codexHome, `.sessions.seed-${tag}`);
      await rename(sessions, aside);
      await rename(tmpLink, sessions);
      await rmdir(aside).catch(() => rm(aside, { recursive: true, force: true }));
      return;
    }
    // A link (or nothing) is replaced in one rename.
    await rename(tmpLink, sessions);
  } catch (error) {
    await unlink(tmpLink).catch(() => undefined);
    throw error;
  }
}

/** Spawns the app-server, completes the handshake under the deadline, and stops it. */
async function initializeOnce(options: SeedCodexHomeOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;
  const child = spawnProviderChild({
    command: options.codexBin,
    args: options.args ?? ["app-server"],
    env: { ...options.env, CODEX_HOME: options.codexHome },
    cwd: options.codexHome
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  const peer = new CodexPeer({
    stdin: child.stdin,
    stdout: child.stdout,
    handlers: {
      onRequest: (request) => Promise.reject(CodexRequestRefusal.methodNotFound(request.method)),
      onNotification: () => undefined,
      onUnknownFrame: () => undefined,
      onMalformedLine: () => undefined
    }
  });
  void child.exited.then((reason) => {
    peer.close(describeExit(reason));
  });
  try {
    await withDeadline(
      () =>
        peer.request("initialize", {
          clientInfo: { name: "orquester", title: "Orquester", version: "1" },
          capabilities: { experimentalApi: false, requestAttestation: false }
        }),
      {
        label: "codex app-server initialize (state DB seeding)",
        timeoutMs,
        onTimeout: () => {
          void child.kill();
        }
      }
    );
    // `initialized` takes no params; the server rejects an explicit null.
    peer.notify("initialized");
  } catch (error) {
    await child.kill();
    const tail = stderr.trim().split("\n").slice(-5).join("\n");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Seeding ${options.codexHome} failed: ${message}${tail.length > 0 ? `\n${tail}` : ""}`);
  }
  // Clean shutdown: the app-server exits on stdin EOF; kill it if it lingers.
  child.stdin.end();
  const graceful = await withDeadline(child.exited, { label: "codex app-server exit", timeoutMs: options.exitGraceMs ?? EXIT_GRACE_MS }).catch(
    () => null
  );
  if (graceful === null) {
    await child.kill();
  }
}
