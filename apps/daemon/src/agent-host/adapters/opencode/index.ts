/**
 * Agent host — the OpenCode adapter (spec §4.5 OpenCode).
 *
 * One `opencode serve` **per project**, shared by that project's threads and
 * ref-counted inside this adapter (§3.2 — a deliberate divergence from T3's
 * per-thread server). HTTP + SSE, every call with a deadline, no cwd on the
 * process: the directory travels per request.
 *
 * Module map for this directory:
 *
 * | File | What it owns |
 * |---|---|
 * | `protocol.ts` | The wire shapes, the handled-event union and the known-ignored allow-list |
 * | `http.ts` | `fetch` client: Basic auth, `?directory=`, deadlines, `isOpenCodeNotFound` |
 * | `sse.ts` | The `GET /event` reader |
 * | `routes.ts` | Every route path and request body, in one place |
 * | `ruleset.ts` | §4.4's rule list and §4.3's decision map |
 * | `state.ts` | Per-thread mutable state, text merging, usage accumulation |
 * | `normalize.ts` | The pure frame → `RuntimeEvent` demux (replayed by the tests) |
 * | `session.ts` | The three completion machines, turns, interrupt, compaction, rollback |
 * | `server.ts` | The ref-counted per-project server pool |
 * | `snapshot.ts` | `GET /provider` → models + auth + commands + skills |
 * | `cli-inventory.ts` | The machine-level CLI catalogue, for a cwd-less probe |
 * | `smoke.ts` | A manual one-turn drive against the real CLI (`ORQ_AGENT_SMOKE=1`) |
 *
 * **`StartSessionInput.home` is deliberately not honoured.** The server is
 * shared by a project's threads (§3.2), and `OPENCODE_DATA` is a property of
 * that one process — so a per-thread account home is not expressible without
 * giving up the sharing. Every OpenCode server therefore runs under the system
 * identity, and a non-`system` home is **refused** rather than silently
 * ignored, so an account selection can never look applied when it is not.
 * There is no OpenCode account family today, so nothing reaches that refusal.
 *
 * No lazy dynamic `import()` anywhere (§8): every import above is static.
 */

import { resolve as resolvePath } from "node:path";

import type {
  AdapterCapabilities,
  AgentAdapterId,
  ApprovalDecision,
  ProviderSession,
  ProviderSnapshot,
  RuntimeEvent,
  ThreadSnapshot,
  WorkspaceSnapshot
} from "@orquester/api/agent-chat";

import type {
  AdapterContext,
  AdapterFactory,
  AgentAdapter,
  SendTurnInput,
  SendTurnResult,
  StartSessionInput
} from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import { StderrCapture } from "../../support/stderr.ts";
import { OpenCodeThreadSession } from "./session.ts";
import { OpenCodeServerPool, type OpenCodeServerHandle } from "./server.ts";
import { meetsMinimumOpenCodeVersion, parseSemver } from "./semver.ts";
import { loadInventoryFromCli } from "./cli-inventory.ts";
import {
  OPENCODE_CAPABILITIES,
  buildSnapshot,
  keepNonEmpty,
  loadOpenCodeInventory,
  retainWorkspaceSnapshots,
  unusableSnapshot,
  type OpenCodeInventory
} from "./snapshot.ts";
import { Mutex } from "./util.ts";

const ADAPTER_ID: AgentAdapterId = "opencode";
const OPENCODE_REF_ID = "opencode";

/**
 * How long a computed snapshot is served without re-probing. §3.2: snapshots
 * refresh on a slow interval, not per request, and refreshes are serialised so
 * two clients opening Settings cannot run two probes — moving ~5 MB each.
 */
const SNAPSHOT_TTL_MS = 5 * 60_000;

interface CachedSnapshot {
  snapshot: ProviderSnapshot;
  at: number;
}

class OpenCodeAdapterImpl implements AgentAdapter {
  readonly id = ADAPTER_ID;
  readonly capabilities: AdapterCapabilities = OPENCODE_CAPABILITIES;

  private readonly ctx: AdapterContext;
  private readonly pool: OpenCodeServerPool;
  private readonly sessions = new Map<string, OpenCodeThreadSession>();
  private readonly starting = new Map<string, Promise<OpenCodeThreadSession>>();
  private readonly servers = new Map<string, OpenCodeServerHandle>();
  private readonly workspaceSnapshots = new Map<string, WorkspaceSnapshot>();
  private readonly snapshotLock = new Mutex();
  private readonly queue: RuntimeEvent[] = [];
  private queueWaiters: (() => void)[] = [];
  private cachedSnapshot: CachedSnapshot | undefined;
  /**
   * `opencode --version` is a Bun cold start (~1–2 s) and the binary does not
   * change between refreshes, so it is cached for the same window as the
   * snapshot. Re-spawning it on every probe was a large part of E9's budget.
   */
  private cachedVersion:
    | { value: { installed: boolean; version: string | null }; at: number }
    | undefined;
  /** The machine-level CLI catalogue: three Bun spawns and several MB (E9). */
  private cachedCliInventory: { value: OpenCodeInventory; at: number } | undefined;
  private binPath: string | undefined;
  private stopped = false;

  constructor(ctx: AdapterContext) {
    this.ctx = ctx;
    this.pool = new OpenCodeServerPool({
      logger: ctx.logger,
      resolveBin: () => this.resolveBin(),
      buildEnv: ({ projectDir }) =>
        ctx.buildEnv({
          // The server is shared by a project's threads, so it is stamped with
          // the project rather than any one thread's session id. The host
          // resolves the project's launcher env from `projectPath`; the
          // `project:<dir>` thread id is the older convention it still
          // honours, kept here so this works either way.
          //
          // `projectPath` is passed through a SPREAD on purpose: the field is
          // additive on `AdapterContext.buildEnv` and lands with W1's change,
          // and a spread is not subject to excess-property checking — so this
          // compiles against both shapes and needs no follow-up edit.
          ...{ projectPath: projectDir },
          threadId: `project:${projectDir}`,
          home: { kind: "system", path: process.env.HOME ?? "/" }
        }),
      signal: ctx.signal,
      onStderr: (projectDir, line) => {
        // A shared server's stderr belongs to no single thread, so it is
        // logged rather than injected into an arbitrary timeline. It is
        // already ANSI-stripped, classified and REDACTED by `StderrCapture`.
        if (line.class === "error") {
          ctx.logger.error("opencode server stderr", { projectDir, line: line.text });
        } else {
          ctx.logger.warn("opencode server stderr", { projectDir, line: line.text });
        }
      }
    });
    ctx.signal.addEventListener(
      "abort",
      () => {
        // `stopAll` awaits every session's `stop()`, and a `stop()` can reject
        // (an abort RPC, a settle write). Unhandled here it becomes a host-wide
        // unhandled rejection on the shutdown path — exactly when the host can
        // least afford one.
        void this.stopAll().catch((error: unknown) => {
          ctx.logger.warn("opencode stopAll failed during shutdown", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      },
      { once: true }
    );
  }

  // -- events --------------------------------------------------------------

  /**
   * The adapter's canonical event stream. One consumer: the host's ingestion.
   * Backed by an unbounded FIFO so a slow consumer can never make the SSE pump
   * drop a frame — the ingestion layer (§5.6) is what batches.
   */
  get events(): AsyncIterable<RuntimeEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
        for (;;) {
          while (self.queue.length > 0) {
            yield self.queue.shift()!;
          }
          if (self.stopped) {
            return;
          }
          await new Promise<void>((resolve) => {
            self.queueWaiters.push(resolve);
          });
        }
      }
    };
  }

  private emit(event: RuntimeEvent): void {
    this.queue.push(event);
    const waiters = this.queueWaiters;
    this.queueWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  // -- binary --------------------------------------------------------------

  private async resolveBin(): Promise<string> {
    if (this.binPath !== undefined) {
      return this.binPath;
    }
    const resolved = await this.ctx.resolveBin(OPENCODE_REF_ID);
    if (resolved === null || resolved.length === 0) {
      throw new Error("OpenCode is not installed: no `opencode` binary on the session PATH.");
    }
    this.binPath = resolved;
    return resolved;
  }

  /** `opencode --version`, bounded, never a shell, and cached for the TTL. */
  private async probeVersion(): Promise<{ installed: boolean; version: string | null }> {
    const cached = this.cachedVersion;
    if (cached !== undefined && Date.now() - cached.at < SNAPSHOT_TTL_MS) {
      return cached.value;
    }
    const probed = await this.probeVersionUncached();
    this.cachedVersion = { value: probed, at: Date.now() };
    return probed;
  }

  private async probeVersionUncached(): Promise<{ installed: boolean; version: string | null }> {
    let bin: string;
    try {
      bin = await this.resolveBin();
    } catch {
      return { installed: false, version: null };
    }
    const child = spawnProviderChild({
      command: bin,
      args: ["--version"],
      env: this.ctx.buildEnv({
        threadId: "probe",
        home: { kind: "system", path: process.env.HOME ?? "/" }
      }),
      cwd: this.ctx.tmpDir()
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(0, 4096);
    });
    const stderr = new StderrCapture();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    try {
      await withDeadline(child.exited, {
        label: "opencode --version",
        timeoutMs: AGENT_HOST_DEADLINES.probeMs,
        onTimeout: () => void child.kill().catch(() => undefined)
      });
    } catch {
      return { installed: true, version: null };
    }
    const parsed = parseSemver(stdout);
    return {
      installed: true,
      version: parsed === null ? null : `${parsed.major}.${parsed.minor}.${parsed.patch}`
    };
  }

  // -- snapshot ------------------------------------------------------------

  /**
   * One call, not two (§4.1). Probes **never authenticate** and never open a
   * real session: the whole inventory comes off `GET /provider` and friends on
   * a server this adapter may already be running for the project.
   *
   * The gate runs on **both** `opencode --version` and the server's own health
   * response, because an already-running server can be older than the binary
   * on PATH (§3.2).
   */
  async refreshSnapshot(input?: { cwd?: string }): Promise<ProviderSnapshot> {
    return await this.snapshotLock.run(async () => {
      const cwd = input?.cwd === undefined ? undefined : resolvePath(input.cwd);
      const cached = this.cachedSnapshot;
      const fresh = cached !== undefined && Date.now() - cached.at < SNAPSHOT_TTL_MS;
      // A cwd already present is never re-probed (§4.6.4).
      if (fresh && (cwd === undefined || this.workspaceSnapshots.has(cwd))) {
        return cached.snapshot;
      }

      const checkedAt = this.ctx.clock.nowIso();
      const probe = await this.probeVersion();
      if (!probe.installed) {
        const snapshot = unusableSnapshot({ installed: false, version: null, checkedAt });
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      }
      if (!meetsMinimumOpenCodeVersion(probe.version)) {
        const snapshot = unusableSnapshot({
          installed: true,
          version: probe.version,
          checkedAt
        });
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      }

      if (cwd === undefined) {
        // §4.5 "Catalogue fallbacks": with no project directory there is no
        // server to start, so the machine-level catalogue comes from the CLI.
        // Without this the host's background refresh — which never carries a
        // cwd — would leave the OpenCode card with no models and unknown auth
        // until a thread opened.
        const snapshot = await this.machineSnapshotFromCli({
          version: probe.version,
          checkedAt,
          previous: cached?.snapshot
        });
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      }

      // E9: the cold probe measured 10 435 ms against the host's 10 s budget,
      // so the user's FIRST visit to Settings showed no OpenCode at all. The
      // cost was four SEQUENTIAL catalogue reads on top of the server start;
      // `loadOpenCodeInventory` now issues them concurrently, which brings a
      // cold probe comfortably inside the budget and a warm one to ~20 ms.
      //
      // The CLI inventory is deliberately NOT used here as a fast path: it and
      // `opencode serve` open the same SQLite database, and running them
      // together makes the server fail to start with `database is locked` —
      // measured, not theorised. It stays where it is needed and safe: the
      // cwd-less probe, which starts no server at all.
      let server: OpenCodeServerHandle | undefined;
      try {
        server = await this.pool.acquire(cwd);
        const inventory = await loadOpenCodeInventory(server.client(cwd));
        const merged = this.mergeInventory(inventory, cached?.snapshot);
        const workspace: WorkspaceSnapshot = {
          cwd,
          checkedAt,
          slashCommands: merged.slashCommands,
          skills: merged.skills
        };
        this.workspaceSnapshots.delete(cwd);
        this.workspaceSnapshots.set(cwd, workspace);
        const snapshot = buildSnapshot({
          version: server.version,
          checkedAt,
          inventory,
          workspaceSnapshots: retainWorkspaceSnapshots(this.workspaceSnapshots)
        });
        snapshot.slashCommands = merged.slashCommands;
        snapshot.skills = merged.skills;
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger.warn("opencode snapshot probe failed", { cwd, error: message });
        const snapshot =
          cached?.snapshot !== undefined
            ? { ...cached.snapshot, checkedAt, status: "degraded" as const, message }
            : unusableSnapshot({
                installed: true,
                version: probe.version,
                checkedAt,
                message,
                status: "error"
              });
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      } finally {
        server?.release();
      }
    });
  }

  /**
   * The machine-level snapshot, from the CLI rather than from a server
   * (§4.5 "Catalogue fallbacks"). The probe runs in the appdir tmp dir on
   * purpose: `opencode` walks **up** from its cwd for project config, and a
   * directory with none is what makes this catalogue machine-level.
   *
   * A failure never blanks a good snapshot (§4.6.4) — it degrades the status
   * and keeps the last models, commands and skills.
   */
  private async machineSnapshotFromCli(input: {
    version: string | null;
    checkedAt: string;
    previous: ProviderSnapshot | undefined;
  }): Promise<ProviderSnapshot> {
    const { version, checkedAt, previous } = input;
    try {
      const cachedInventory = this.cachedCliInventory;
      let inventory: OpenCodeInventory;
      if (cachedInventory !== undefined && Date.now() - cachedInventory.at < SNAPSHOT_TTL_MS) {
        inventory = cachedInventory.value;
      } else {
        const bin = await this.resolveBin();
        inventory = await loadInventoryFromCli({
          bin,
          cwd: this.ctx.tmpDir(),
          env: this.ctx.buildEnv({
            threadId: "probe",
            home: { kind: "system", path: process.env.HOME ?? "/" }
          }),
          logger: this.ctx.logger,
          signal: this.ctx.signal
        });
        this.cachedCliInventory = { value: inventory, at: Date.now() };
      }
      const snapshot = buildSnapshot({
        version: version ?? "0.0.0",
        checkedAt,
        inventory,
        ...(this.workspaceSnapshots.size > 0
          ? { workspaceSnapshots: retainWorkspaceSnapshots(this.workspaceSnapshots) }
          : {})
      });
      // The CLI has no `command.list` equivalent, so a machine-level probe
      // keeps whatever commands the last server-backed probe found.
      snapshot.slashCommands = keepNonEmpty(snapshot.slashCommands, previous?.slashCommands);
      snapshot.skills = keepNonEmpty(snapshot.skills, previous?.skills);
      return snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn("opencode CLI inventory failed", { error: message });
      if (previous !== undefined) {
        return { ...previous, installed: true, version, checkedAt, status: "degraded", message };
      }
      return unusableSnapshot({
        installed: true,
        version,
        checkedAt,
        message,
        status: "error"
      });
    }
  }

  private mergeInventory(
    inventory: OpenCodeInventory,
    previous: ProviderSnapshot | undefined
  ): { slashCommands: ProviderSnapshot["slashCommands"]; skills: ProviderSnapshot["skills"] } {
    const built = buildSnapshot({
      version: previous?.version ?? "0.0.0",
      checkedAt: this.ctx.clock.nowIso(),
      inventory
    });
    return {
      slashCommands: keepNonEmpty(built.slashCommands, previous?.slashCommands),
      skills: keepNonEmpty(built.skills, previous?.skills)
    };
  }

  // -- sessions ------------------------------------------------------------

  listSessions(): ProviderSession[] {
    return [...this.sessions.values()].map((session) => session.session);
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  async startSession(input: StartSessionInput): Promise<ProviderSession> {
    const existing = this.starting.get(input.threadId);
    if (existing !== undefined) {
      const session = await existing;
      return session.session;
    }
    const live = this.sessions.get(input.threadId);
    if (live !== undefined) {
      // One live session per thread (§3.1): a restart stops the old one first,
      // so a resume cursor is never advanced by two processes.
      await live.stop({ reason: "restarted", hostInitiated: true });
    }

    const start = this.doStartSession(input).finally(() => {
      this.starting.delete(input.threadId);
    });
    this.starting.set(input.threadId, start);
    const session = await start;
    return session.session;
  }

  private async doStartSession(input: StartSessionInput): Promise<OpenCodeThreadSession> {
    if (input.home.kind !== "system") {
      // Refuse rather than drop: see the module header. A shared server has one
      // `OPENCODE_DATA`, so honouring a per-thread home is not possible while
      // the project's threads share a process.
      throw new Error(
        `OpenCode runs one server per project under the system identity, so it cannot bind the '${input.home.kind}' account home. Use the system identity for OpenCode threads.`
      );
    }
    const cwd = resolvePath(input.cwd);
    // The SERVER is keyed by the project; the thread's own `cwd` still travels
    // per request as the client-level `directory` (§4.5 "there is no cwd on
    // the process"), so a subdirectory thread shares the project's server
    // while still scoping every call to itself.
    const server = await this.pool.acquire(projectDirFor(input));
    this.servers.set(input.threadId, server);
    try {
      const session = await OpenCodeThreadSession.start(
        {
          ctx: this.ctx,
          emit: (event) => this.emit(event),
          onClosed: (threadId) => {
            this.sessions.delete(threadId);
            this.servers.delete(threadId);
          }
        },
        {
          threadId: input.threadId,
          cwd,
          ...(input.title !== undefined ? { title: input.title } : {}),
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          server
        }
      );
      this.sessions.set(input.threadId, session);
      // §4.6.4: the per-cwd catalogue refresh is forked so it never delays the
      // turn that follows.
      void this.refreshSnapshot({ cwd }).catch(() => undefined);
      return session;
    } catch (error) {
      server.release();
      this.servers.delete(input.threadId);
      throw error;
    }
  }

  /**
   * §4.1 "Lazy recovery": a turn on a thread with no live session starts one
   * from the persisted cursor first. A crashed, OOM-killed or restarted
   * session is indistinguishable from a fresh one.
   */
  async sendTurn(input: SendTurnInput): Promise<SendTurnResult> {
    const session = this.sessions.get(input.threadId);
    if (session === undefined) {
      throw new Error(
        `OpenCode has no live session for thread ${input.threadId}; start one first.`
      );
    }
    if (input.continuation === true && input.input.trim().length === 0) {
      // §4.1: promptless continuation is validated, not assumed — OpenCode
      // does not declare `promptlessTurnContinuation`.
      throw new Error("OpenCode does not support a continuation turn with no prompt.");
    }
    return await session.sendTurn(input);
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    await this.sessions.get(threadId)?.interruptTurn(turnId);
  }

  async respondToApproval(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision
  ): Promise<void> {
    const session = this.require(threadId);
    await session.respondToApproval(requestId, decision);
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void> {
    const session = this.require(threadId);
    await session.respondToUserInput(requestId, answers);
  }

  async compact(threadId: string): Promise<void> {
    await this.require(threadId).compact();
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    return await this.require(threadId).readThread();
  }

  /**
   * §4.1 two-phase rollback: `assertRollbackSupported` runs before anything is
   * touched. OpenCode **can** roll back (by forking, never by
   * `session.revert`), so the only refusal here is a missing session.
   */
  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot> {
    const session = this.require(threadId);
    if (!Number.isInteger(numTurns) || numTurns <= 0) {
      throw new Error("OpenCode rollback needs a positive number of turns.");
    }
    return await session.rollbackThread(numTurns);
  }

  async stopSession(threadId: string): Promise<void> {
    await this.sessions.get(threadId)?.stop({ reason: "stopped by host", hostInitiated: true });
  }

  async stopAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map(async (session) =>
        session.stop({ reason: "host is shutting down", hostInitiated: true })
      )
    );
    await this.pool.stopAll();
    this.stopped = true;
    const waiters = this.queueWaiters;
    this.queueWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  private require(threadId: string): OpenCodeThreadSession {
    const session = this.sessions.get(threadId);
    if (session === undefined) {
      throw new Error(`OpenCode has no live session for thread ${threadId}.`);
    }
    return session;
  }
}

/**
 * The project directory a thread belongs to — the pool's key, and the whole
 * basis of §3.2's "one `opencode serve` **per project**, shared by its
 * threads".
 *
 * It reads `projectPath` **structurally** rather than off `StartSessionInput`,
 * because the field is the host's to add: until it lands, a thread at
 * `/p/packages/ui` would otherwise key its own server and a project would run
 * as many `opencode serve` children, ports and ~4.3 MB catalogue probes as it
 * has threads. `cwd` is the fallback, which is exactly the old behaviour, so
 * this is correct before and after the seam exists.
 *
 * The path is resolved, never trusted verbatim: a directory that does not
 * exist is **not** rejected by the server — it silently serves a different
 * instance scope (fixtures README observation 21).
 */
export function projectDirFor(input: StartSessionInput): string {
  const candidate = (input as { projectPath?: unknown }).projectPath;
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    return resolvePath(candidate);
  }
  return resolvePath(input.cwd);
}

export const createOpenCodeAdapter: AdapterFactory = async (
  context: AdapterContext
): Promise<AgentAdapter> => {
  // Acquiring an adapter happens before the command gate opens (§3.1), so the
  // factory may resolve a binary — but must not start a provider session, and
  // a missing binary must not fail the whole host.
  const adapter = new OpenCodeAdapterImpl(context);
  return await Promise.resolve(adapter);
};

export { OpenCodeAdapterImpl };
