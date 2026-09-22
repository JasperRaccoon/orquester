/**
 * Supervision of the agent host process (spec §3.1 "Spawn and adoption",
 * "Readiness is a gate", "No-tmux hosts", "Kill guard"; §8).
 *
 * The shape follows `cliproxy.ts` deliberately: the host is a tmux *service*
 * session (`orqsvc-agent-host`) so `KillMode=process` leaves it running across
 * a deploy, boot adoption is an **authenticated probe first** (so "the socket
 * answers" and "the host can take work" are the same fact — the host answers
 * `/health` only after its command gate opens), a foreign listener is a hard
 * error and is never killed, and a 15 s unref'd health interval with bounded
 * backoff supervises it afterwards.
 *
 * Every side effect is injected so the whole state machine is testable without
 * a process: the daemon must never be launched from a test (and this package
 * may not launch one at all).
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codeStampsDiffer } from "../agent-host/support/code-stamp.ts";
import {
  AGENT_HOST_HEALTH_INTERVAL_MS,
  AGENT_HOST_PREPARED_TIMEOUT_MS,
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_SERVICE_SESSION,
  agentHostRoutes,
  type AgentHostHealthResponse
} from "../agent-host/host-protocol.ts";

/** Path of the host entry point, resolved from this module, never from cwd. */
export const AGENT_HOST_MAIN = fileURLToPath(new URL("../agent-host/main.ts", import.meta.url));

/** Spawn→readiness poll interval. The gate can take a moment to open. */
export const SPAWN_PROBE_INTERVAL_MS = 250;

/** Exponential backoff base between supervised respawn attempts. */
export const RESPAWN_BACKOFF_BASE_MS = 2_000;
export const RESPAWN_BACKOFF_MAX_MS = 60_000;

/** After this many consecutive failed respawns the supervisor latches `error`. */
export const MAX_RESPAWNS = 5;

/**
 * Consecutive unreachable probes before the supervisor kills and respawns.
 *
 * One miss is not evidence of death: the probe has a 5 s timeout, and a host
 * whose event loop is busy with a large cold fold or a big `readThread` answers
 * nothing. Restarting on that takes down every live turn (§8: "Restarting the
 * host interrupts live work"), which is precisely what the drain rule exists to
 * avoid. cliproxy restarts on the first miss, but it has no in-flight user work
 * to lose.
 */
export const UNREACHABLE_PROBES_BEFORE_RESTART = 2;

/** …and more patience when the last good health reported an active turn. */
export const UNREACHABLE_PROBES_BEFORE_RESTART_BUSY = 4;

/**
 * How long the daemon waits for a stopped host to actually exit before killing
 * its tmux session. Matches T3's `TERMINATE_GRACE_MS`: `/stop` returns once the
 * continuation markers are written, but the teardown that follows (four
 * adapters at a 2 s kill grace each, sequential) needs seconds.
 */
export const HOST_EXIT_GRACE_MS = 5_000;
export const HOST_EXIT_POLL_MS = 100;

export type AgentHostState =
  /** Never started, or intentionally stopped. */
  | "stopped"
  /** A spawn is in flight and readiness has not been reached. */
  | "starting"
  /** Adopted: the socket answers with our token and the gate is open. */
  | "healthy"
  /**
   * Something else owns the socket and rejects our token (§3.1 case 4). We
   * log, and never kill or adopt.
   */
  | "foreign"
  /** Latched after {@link MAX_RESPAWNS} failures, or a failed restart. */
  | "error";

export type ProbeOutcome =
  | { ok: true; health: AgentHostHealthResponse }
  /** The socket answered but rejected our token — a foreign process. */
  | { ok: false; reachable: true; rejected: true }
  /** The socket answered, our token was fine, but it is not ready/healthy. */
  | { ok: false; reachable: true; rejected: false; status?: number }
  /** Nothing is listening. */
  | { ok: false; reachable: false };

/** A directly-spawned host child (the no-tmux fallback). */
export interface DirectHostHandle {
  kill(): void;
  pid?: number;
}

export interface SupervisorTmux {
  hasServiceSession(name: string): Promise<boolean>;
  killServiceSession(name: string): Promise<void>;
  newServiceSession(opts: {
    name: string;
    cwd: string;
    env: Record<string, string>;
    bin: string;
    args: string[];
  }): Promise<void>;
}

export interface SupervisorAdapters {
  /** Authenticated `GET /health` on the socket. Must never throw. */
  probe(): Promise<ProbeOutcome>;
  /** Ask a healthy host to write continuation markers and drain (§3.3, §6.3). */
  requestStop(): Promise<void>;
  /** Null on a host without a usable tmux — the host then dies with the daemon. */
  tmux: SupervisorTmux | null;
  /** No-tmux fallback: a direct, non-detached child. */
  spawnDirect(bin: string, args: string[], env: Record<string, string>): DirectHostHandle;
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * The host reported a NEW `providersRevision` — its own background /
   * session-start refresh changed a snapshot (§4.6.4). The daemon raises the
   * coarse `agent.providers.changed` from here; without it only the explicit
   * `POST /api/agent/providers/:id/refresh` ever reaches the bus, and a client
   * keeps a stale catalog after a CLI upgrade or an expired login until a page
   * reload.
   */
  onProvidersRevision?(): void;
  logger?: { log?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

export interface SupervisorOptions {
  /** `<appdir>` — passed to the host as `--appdir`. */
  appdir: string;
  /** `<appdir>/daemon/agent-host.token`. */
  tokenPath: string;
  /** cwd for the host process. */
  cwd: string;
  /** The explicit launch environment (§3.1/§8: never a spread of `process.env`). */
  env: Record<string, string>;
  /** The node binary; `process.execPath` in production. */
  nodeBin: string;
  /** Overridable for tests; defaults to {@link AGENT_HOST_MAIN}. */
  mainPath?: string;
  adapters: SupervisorAdapters;
  /** Deadline on a replacement host reaching readiness (§8). */
  preparedTimeoutMs?: number;
  /** Grace for a stopped host to exit before its session is killed. */
  exitGraceMs?: number;
  /**
   * The commit the DAEMON's code was read from (`support/code-stamp.ts`). A
   * healthy host reporting a different known stamp is a §3.1 case-3
   * drain-restart exactly like a protocol mismatch: after a deploy the old
   * host would otherwise keep running old code for as long as it lived.
   */
  codeStamp?: string | null;
}

export interface AgentHostStatus {
  state: AgentHostState;
  hostInstanceId: string | null;
  protocolVersion: number | null;
  /** True while a version-mismatch host is adopted and waiting to drain (§3.1 case 3). */
  pendingVersionRestart: boolean;
  pid: number | null;
  reason: string | null;
}

/**
 * Owns the lifetime of the agent host. One instance per daemon; created in
 * `startDaemon` after `sessions.reattach()`, exactly where cliproxy is.
 */
export class AgentHostSupervisor {
  private state: AgentHostState = "stopped";
  private reason: string | null = null;
  private health: AgentHostHealthResponse | null = null;
  private token: string | null = null;
  private directHandle: DirectHostHandle | null = null;
  private pendingVersionRestart = false;
  private respawnAttempts = 0;
  private nextRespawnAt = 0;
  /** Consecutive unreachable probes; cleared by any healthy adoption. */
  private missedProbes = 0;
  /**
   * True once `init()` has run. Distinguishes "never started" from "a spawn
   * failed and the state is `stopped`" — without it the health interval would
   * see `stopped` and never retry, turning one failed spawn into a permanent
   * outage.
   */
  private supervising = false;
  /** Serialises every transition, so adoption, health and restart never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(status: AgentHostStatus) => void>();

  constructor(private readonly opts: SupervisorOptions) {}

  /** The token the host client authenticates with. Null before the first adoption/spawn. */
  currentToken(): string | null {
    return this.token;
  }

  status(): AgentHostStatus {
    return {
      state: this.state,
      hostInstanceId: this.health?.hostInstanceId ?? null,
      protocolVersion: this.health?.protocolVersion ?? null,
      pendingVersionRestart: this.pendingVersionRestart,
      pid: this.hostPid(),
      reason: this.reason
    };
  }

  /** True only when the host can take work right now. */
  isHealthy(): boolean {
    return this.state === "healthy";
  }

  /**
   * Pids the `/api/system/processes/kill` guard must refuse (§3.1 "Kill
   * guard"). With tmux the host lives in the `orqsvc-` service session the
   * guard already excludes; without it the host is a plain daemon child and
   * would otherwise be a legal target. **Provider children stay legal targets**
   * — only the host itself is protected.
   */
  protectedPids(): number[] {
    const pids: number[] = [];
    const direct = this.directHandle?.pid;
    if (typeof direct === "number") pids.push(direct);
    const reported = this.health?.pid;
    if (typeof reported === "number" && reported > 0 && !pids.includes(reported)) {
      pids.push(reported);
    }
    return pids;
  }

  /** Fires on every state change, including a `hostInstanceId` change (§8). */
  onChange(listener: (status: AgentHostStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Boot adoption — the five cases of §3.1, in order:
   *   1. probe the socket with the token;
   *   2. healthy and the same protocol version → adopt;
   *   3. healthy but a version mismatch → adopt, then drain-restart;
   *   4. the socket answers but rejects the token → foreign; log, never kill;
   *   5. nothing answers → spawn, poll READINESS (not just the socket), adopt.
   */
  init(): Promise<void> {
    return this.transition(async () => {
      this.supervising = true;
      this.token = await this.readToken();
      const probed = this.token ? await this.safeProbe() : ({ ok: false, reachable: false } as ProbeOutcome);

      if (probed.ok) {
        this.adopt(probed.health);
        if (this.isStale(probed.health)) {
          // Case 3. Adopt now — every in-flight turn keeps running — and hand
          // over as soon as no thread has an active turn.
          this.pendingVersionRestart = true;
          this.log("warn", `${this.staleReason(probed.health)}; restarting once drained`);
          this.emit();
          await this.restartIfDrained();
        }
        return;
      }

      if (probed.ok === false && probed.reachable && probed.rejected) {
        // Case 4 — unless it is demonstrably OURS: a host inside our own tmux
        // service session with a token we can no longer produce (the token file
        // was lost). Ownership is verified by the session name, which a foreign
        // process cannot be in, so restarting it is not "killing a stranger".
        const owned = (await this.opts.adapters.tmux?.hasServiceSession(AGENT_HOST_SERVICE_SESSION)) ?? false;
        if (!owned) {
          this.setState("foreign", "another process owns the agent host socket");
          this.log("error", `agent host socket rejected our token and is not ours — not killed, not adopted`);
          return;
        }
        this.log("warn", "our agent host rejected the token (lost token file) — restarting it");
        await this.spawnAndWait(true);
        return;
      }

      // Case 5 (and "answers but unhealthy"): spawn and poll readiness. Kill a
      // leftover service session first so a wedged host cannot hold the socket.
      const leftover = (await this.opts.adapters.tmux?.hasServiceSession(AGENT_HOST_SERVICE_SESSION)) ?? false;
      await this.spawnAndWait(leftover || (probed.ok === false && probed.reachable));
    });
  }

  /**
   * Runtime supervision, driven by the daemon's 15 s unref'd interval
   * ({@link AGENT_HOST_HEALTH_INTERVAL_MS}).
   */
  checkHealth(): Promise<void> {
    return this.transition(async () => {
      if (!this.supervising || this.state === "error") return;
      if (this.state === "foreign") {
        // Re-probe: a foreign listener may have gone away, and then the socket
        // is ours to take. Still rejected ⇒ stay foreign, still never kill.
        const again = await this.safeProbe();
        if (again.ok) {
          this.adopt(again.health);
          return;
        }
        if (again.ok === false && again.reachable && again.rejected) return;
        await this.spawnAndWait(false);
        return;
      }

      const probed = await this.safeProbe();
      if (probed.ok) {
        const previous = this.health?.hostInstanceId ?? null;
        this.adopt(probed.health);
        if (previous && previous !== probed.health.hostInstanceId) {
          // §8: a restarted host is not a reconnect. Subscribers re-read.
          this.log("log", `agent host instance changed ${previous} -> ${probed.health.hostInstanceId}`);
        }
        if (this.isStale(probed.health)) {
          this.pendingVersionRestart = true;
        }
        if (this.pendingVersionRestart) {
          await this.restartIfDrained();
        }
        return;
      }

      if (probed.ok === false && probed.reachable && probed.rejected) {
        this.setState("foreign", "another process owns the agent host socket");
        return;
      }

      // A host whose event loop is blocked past the 5 s probe timeout — a large
      // cold fold, a big `readThread`, the box under load — looks exactly like
      // a dead one. Killing it on the FIRST miss takes down every live chat
      // turn (and, before the grace above, leaked a detached OpenCode server on
      // the way out). Require consecutive misses, and never count a miss while
      // the last good health reported an active turn: that is positive evidence
      // the host had work, so give it the full window.
      this.missedProbes++;
      const required =
        (this.health?.activeTurnThreadIds.length ?? 0) > 0
          ? UNREACHABLE_PROBES_BEFORE_RESTART_BUSY
          : UNREACHABLE_PROBES_BEFORE_RESTART;
      if (this.missedProbes < required) {
        this.log(
          "warn",
          `agent host did not answer (${this.missedProbes}/${required}); not restarting yet`
        );
        return;
      }

      if (this.opts.adapters.now() < this.nextRespawnAt) return; // still backing off
      this.respawnAttempts++;
      const ready = await this.spawnAndWait(true);
      this.nextRespawnAt = this.opts.adapters.now() + this.backoffMs(this.respawnAttempts);
      if (ready) return;
      if (this.respawnAttempts >= MAX_RESPAWNS) {
        this.setState("error", "agent host down");
        this.log("error", `agent host failed to start after ${this.respawnAttempts} attempts`);
      }
    });
  }

  /**
   * The §6.3 `POST /api/agent-host/stop`: ask the host to write continuation
   * markers and drain, then restart it. Returns the new instance id, or null
   * when the replacement never reached readiness.
   */
  restartNow(): Promise<string | null> {
    return this.transition(async () => {
      await this.drainAndRestart();
      return this.health?.hostInstanceId ?? null;
    });
  }

  /**
   * Re-evaluate the drain window (§3.1 case 3). Called when a turn settles, so
   * a deploy's version handover happens the moment the host goes quiet rather
   * than on the next 15 s tick.
   */
  handleTurnSettled(): void {
    if (!this.pendingVersionRestart || this.state !== "healthy") return;
    // Fire-and-forget: `transition()` only catches its own QUEUE copy, so the
    // returned promise must be caught here or an unhandled rejection takes the
    // daemon down (Node ≥15 throws, and nothing installs a handler).
    this.transition(() => this.restartIfDrained()).catch((error) =>
      this.log("error", "agent host drain-restart failed", error)
    );
  }

  /**
   * Daemon shutdown. Under tmux the host is deliberately LEFT RUNNING — that is
   * the whole point of §3.1 — so this only stops supervising. The no-tmux
   * direct child is not detached and dies with the daemon regardless; killing
   * it explicitly just leaves nothing headless.
   */
  stop(): void {
    this.listeners.clear();
    if (!this.opts.adapters.tmux && this.directHandle) {
      try {
        this.directHandle.kill();
      } catch {
        /* already gone */
      }
      this.directHandle = null;
    }
  }

  // --- internals -----------------------------------------------------------

  private hostPid(): number | null {
    return this.directHandle?.pid ?? this.health?.pid ?? null;
  }

  /**
   * Restart only once the host is genuinely drained — decided on a FRESH probe,
   * never on `this.health`.
   *
   * `handleTurnSettled()` fires whenever *any* thread's turn settles, so the
   * cached snapshot can be up to a health interval (15 s) old: probe at T shows
   * no active turn, thread A starts one at T+2 s, thread B settles at T+4 s —
   * and the stale empty list would let the restart kill the host with A's turn
   * live. Readiness and drain are decided on a fresh report, never a cached one
   * (§8, T3 `server-updates.md`). The mirror case only costs a delay.
   */
  private async restartIfDrained(): Promise<void> {
    if (!this.pendingVersionRestart) return;
    const probed = await this.safeProbe();
    if (!probed.ok) return; // not healthy right now — the health tick owns it
    this.adopt(probed.health);
    if (this.isStale(probed.health)) {
      this.pendingVersionRestart = true; // `adopt` clears it only on a match
    }
    if (!this.pendingVersionRestart) return;
    if (probed.health.activeTurnThreadIds.length > 0) return;
    await this.drainAndRestart();
  }

  /**
   * §3.3 + §8. Ask the old host to write every continuation marker and drain,
   * then replace it and hold the prepared deadline on the replacement.
   *
   * *Differs from T3/§8:* T3 starts the replacement, waits for `prepared` and
   * keeps the old version on failure. Both hosts would have to bind the same
   * socket path here, so a trial-then-commit handover is not expressible; the
   * restart is instead **deferred until the host is drained** and a replacement
   * that fails to reach readiness latches `error` and is retried with backoff,
   * rather than silently half-applied.
   */
  private async drainAndRestart(): Promise<void> {
    if (this.state === "healthy") {
      try {
        await this.opts.adapters.requestStop();
      } catch (error) {
        this.log("warn", "agent host stop request failed; restarting anyway", error);
      }
      // `/stop` answers as soon as the continuation markers are written; the
      // host's real teardown (server close → `adapter.stopAll()` → orchestrator
      // drain → final head save) then runs asynchronously and needs SECONDS —
      // `DEFAULT_KILL_GRACE_MS` is 2 s per child, sequential over four
      // adapters. Killing the tmux session milliseconds later strands that
      // teardown, and OpenCode's server is spawned `detached: true`, i.e. in
      // its own process group, so it SURVIVES the kill holding its port and
      // sessions while the replacement host starts a second one per project.
      // Wait for the socket to stop answering, bounded by the same grace T3's
      // launcher uses before killing an old child (`TERMINATE_GRACE_MS`).
      await this.awaitHostExit();
    }
    this.pendingVersionRestart = false;
    const ready = await this.spawnAndWait(true);
    if (!ready) {
      this.setState("error", "replacement agent host never reached readiness");
      this.log("error", "agent host restart did not switch: the replacement never became ready");
    }
  }

  /**
   * Poll the socket until the old host stops answering, bounded by
   * {@link HOST_EXIT_GRACE_MS}. Returns true when it is gone.
   */
  private async awaitHostExit(): Promise<boolean> {
    const deadline = this.opts.adapters.now() + (this.opts.exitGraceMs ?? HOST_EXIT_GRACE_MS);
    for (;;) {
      const probed = await this.safeProbe();
      // Anything that is no longer a healthy answer means the listener is down
      // (or already replaced); either way the socket is free to rebind.
      if (!probed.ok) return true;
      if (this.opts.adapters.now() >= deadline) {
        this.log("warn", "agent host did not exit within the drain grace; killing it");
        return false;
      }
      await this.opts.adapters.sleep(HOST_EXIT_POLL_MS);
    }
  }

  /**
   * Regenerate the token (only ever after the previous host is gone — §3.1's
   * "regenerated only when no host is alive"), spawn, and poll READINESS — not
   * the socket.
   */
  private async spawnAndWait(killFirst: boolean): Promise<boolean> {
    this.setState("starting", null);
    this.health = null;
    // Both of these throw on ordinary operational failures — a full disk on the
    // token write, and `tmux new-session` exiting non-zero because a kill raced
    // the respawn ("duplicate session: orqsvc-agent-host"), the cwd vanished,
    // or the tmux socket died. Neither may escape: these run behind a bare
    // `void` from the 15 s health interval, Node ≥15 throws on an unhandled
    // rejection, and the daemon registers no handler — so one wedged respawn
    // would take the whole daemon down with every live terminal on it. The
    // contract is "latch error and retry", never "exit".
    try {
      // The token is regenerated AFTER the kill, immediately before the new
      // session: §3.1 says "regenerated only when no host is alive", and
      // rewriting it while the old host still answers would leave the daemon
      // unable to authenticate to the host it is waiting on.
      await this.spawn(killFirst, async () => {
        this.token = await this.regenerateToken();
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // `stopped`, not `error`: a duplicate-session or a transient tmux failure
      // must stay retryable. `checkHealth` counts the attempt and latches
      // `error` only at MAX_RESPAWNS, which is the documented cap.
      this.setState("stopped", `agent host spawn failed: ${reason}`);
      this.log("error", "agent host spawn failed", error);
      return false;
    }
    const probed = await this.probeUntilReady();
    if (probed.ok) {
      this.adopt(probed.health);
      return true;
    }
    if (probed.ok === false && probed.reachable && probed.rejected) {
      this.setState("foreign", "another process owns the agent host socket");
      return false;
    }
    this.setState("stopped", "agent host did not reach readiness");
    return false;
  }

  private async spawn(killFirst: boolean, beforeStart: () => Promise<void>): Promise<void> {
    const args = [
      "--import",
      "tsx",
      this.opts.mainPath ?? AGENT_HOST_MAIN,
      "--appdir",
      this.opts.appdir
    ];
    const tmux = this.opts.adapters.tmux;
    if (tmux) {
      if (killFirst) {
        await tmux.killServiceSession(AGENT_HOST_SERVICE_SESSION).catch(() => undefined);
      }
      await beforeStart();
      await tmux.newServiceSession({
        name: AGENT_HOST_SERVICE_SESSION,
        cwd: this.opts.cwd,
        env: this.opts.env,
        bin: this.opts.nodeBin,
        args
      });
      return;
    }
    // No-tmux hosts (Windows, stock macOS dev): a direct child that dies with
    // the daemon (§3.1). The §3.3 reconcile recovers on the next boot.
    this.directHandle?.kill();
    await beforeStart();
    this.directHandle = this.opts.adapters.spawnDirect(this.opts.nodeBin, args, this.opts.env);
  }

  /**
   * Poll until the host answers `/health` (which it does only once its command
   * gate is open) or the prepared deadline lapses. A bare probe right after a
   * spawn races the bind, so every spawn→verdict path must come through here.
   */
  private async probeUntilReady(): Promise<ProbeOutcome> {
    const deadline =
      this.opts.adapters.now() + (this.opts.preparedTimeoutMs ?? AGENT_HOST_PREPARED_TIMEOUT_MS);
    let last: ProbeOutcome = { ok: false, reachable: false };
    for (;;) {
      last = await this.safeProbe();
      if (last.ok) return last;
      // A token rejection cannot resolve itself by waiting.
      if (last.ok === false && last.reachable && last.rejected) return last;
      if (this.opts.adapters.now() >= deadline) return last;
      await this.opts.adapters.sleep(SPAWN_PROBE_INTERVAL_MS);
    }
  }

  private async safeProbe(): Promise<ProbeOutcome> {
    try {
      return await this.opts.adapters.probe();
    } catch {
      return { ok: false, reachable: false };
    }
  }

  private adopt(health: AgentHostHealthResponse): void {
    // A moved revision means the host refreshed a provider snapshot on its own
    // (§4.6.4). A host restart resets the counter, and the instance id changing
    // is itself a "re-read everything" signal, so only compare within one
    // instance.
    const sameInstance = this.health?.hostInstanceId === health.hostInstanceId;
    const previousRevision = sameInstance ? this.health?.providersRevision : undefined;
    if (
      typeof health.providersRevision === "number" &&
      typeof previousRevision === "number" &&
      health.providersRevision !== previousRevision
    ) {
      try {
        this.opts.adapters.onProvidersRevision?.();
      } catch {
        /* a listener must never break supervision */
      }
    }
    this.health = health;
    this.respawnAttempts = 0;
    this.nextRespawnAt = 0;
    this.missedProbes = 0;
    if (!this.isStale(health)) {
      this.pendingVersionRestart = false;
    }
    this.setState("healthy", null);
  }

  /** §3.1 case 3: a protocol mismatch, or a known code stamp that moved. */
  private isStale(health: AgentHostHealthResponse): boolean {
    return (
      health.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
      codeStampsDiffer(health.codeStamp, this.opts.codeStamp)
    );
  }

  private staleReason(health: AgentHostHealthResponse): string {
    if (health.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
      return `agent host protocol ${health.protocolVersion} != ${AGENT_HOST_PROTOCOL_VERSION}`;
    }
    return `agent host code ${String(health.codeStamp).slice(0, 12)} != ${String(this.opts.codeStamp).slice(0, 12)}`;
  }

  private setState(state: AgentHostState, reason: string | null): void {
    this.state = state;
    this.reason = reason;
    this.emit();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of [...this.listeners]) {
      try {
        listener(status);
      } catch {
        /* a listener must never break supervision */
      }
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(RESPAWN_BACKOFF_MAX_MS, RESPAWN_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  }

  private async readToken(): Promise<string | null> {
    try {
      const raw = (await readFile(this.opts.tokenPath, "utf8")).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /** 0600, written atomically. Only ever called when no host is alive (§3.1). */
  private async regenerateToken(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tmp = `${this.opts.tokenPath}.tmp`;
    await mkdir(dirname(this.opts.tokenPath), { recursive: true });
    await writeFile(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, this.opts.tokenPath);
    return token;
  }

  private log(level: "log" | "warn" | "error", ...args: unknown[]): void {
    this.opts.adapters.logger?.[level]?.(...args);
  }

  private transition<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/**
 * The explicit launch environment of §8: the host inherits `TMPDIR`,
 * `NPM_CONFIG_PREFIX`, `PATH` and `HOME` **by explicit copy**, never by
 * spreading `process.env` — the daemon's own environment holds the cliproxy
 * and push secrets.
 *
 * `PATH` is the SESSION path (wider than the daemon's own under systemd): the
 * host resolves provider binaries the user installed into `~/.local/bin`,
 * `~/.npm-global/bin` and friends, exactly as a terminal tab would.
 */
export function buildAgentHostEnv(input: {
  sessionPath: string;
  tmpdir?: string;
  home?: string;
  npmConfigPrefix?: string;
  appdir: string;
  socketPath: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.sessionPath,
    ORQUESTER_APPDIR: input.appdir,
    ORQUESTER_AGENT_HOST: "1",
    ORQUESTER_AGENT_HOST_SOCK: input.socketPath,
    // tsx writes its transpile cache to TMPDIR and `/tmp` is unavailable under
    // ProtectSystem=strict — the same reason the unit sets it for the daemon.
    NODE_ENV: "production"
  };
  if (input.tmpdir) env.TMPDIR = input.tmpdir;
  if (input.home) env.HOME = input.home;
  if (input.npmConfigPrefix) env.NPM_CONFIG_PREFIX = input.npmConfigPrefix;
  return env;
}

export { AGENT_HOST_HEALTH_INTERVAL_MS, AGENT_HOST_SERVICE_SESSION, agentHostRoutes };
