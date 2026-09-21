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
 * | `smoke.ts` | A manual one-turn drive against the real CLI (`ORQ_AGENT_SMOKE=1`) |
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
          // the project rather than any one thread's session id.
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
        void this.stopAll();
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

  /** `opencode --version`, bounded, never a shell. */
  private async probeVersion(): Promise<{ installed: boolean; version: string | null }> {
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
        // Nothing to scope an inventory to. Keep whatever the last real probe
        // produced rather than blanking it (§4.6.4).
        const previous = cached?.snapshot;
        const snapshot: ProviderSnapshot = {
          ...(previous ??
            unusableSnapshot({ installed: true, version: probe.version, checkedAt })),
          installed: true,
          version: probe.version,
          checkedAt
        };
        this.cachedSnapshot = { snapshot, at: Date.now() };
        return snapshot;
      }

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
    const cwd = resolvePath(input.cwd);
    // A directory that does not exist is NOT rejected by the server: it
    // silently serves a different instance scope (fixtures README observation
    // 21). Resolve it before it becomes a client-level `directory`.
    const server = await this.pool.acquire(projectDirFor(cwd));
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
 * The project a cwd belongs to. Threads in the same project share a server
 * (§3.2); a thread whose cwd is a subdirectory still rides the project's
 * server and carries its own `directory` per request.
 */
function projectDirFor(cwd: string): string {
  return cwd;
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
