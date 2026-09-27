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
 * How long the daemon waits for a stopped host to actually EXIT before killing
 * its tmux session. `/stop` returns once the continuation markers are written;
 * the teardown that follows closes the socket first, then stops every provider
 * child (each with a 2 s kill grace, adapters in sequence), and only then
 * writes the last `session.exited`. The wait is on the process — the service
 * session ends when its command does — never on the socket going quiet, which
 * is the FIRST step of that teardown, not the last (owner incident
 * 2026-09-23: the session was killed ~400 ms after `/stop`, one "Task stopped"
 * row landed out of five, and the other threads got no notice at all). T3's
 * `TERMINATE_GRACE_MS` is 5 s against a socket that stays up through its
 * teardown; ours is generous because a wedged child costs the full grace.
 */
export const HOST_EXIT_GRACE_MS = 30_000;
export const HOST_EXIT_POLL_MS = 100;

/**
 * Agent goals §5.7, a host from before the goal hold: how young a Codex goal's
 * running turn must be for the daemon to stop that thread's session at the
 * turn's boundary (`stopLegacyGoalsAtTheirBoundary`) — at most this much of
 * its work is lost; an older one is left to finish, and its own boundary
 * comes. In a goal loop the next turn is already running when the summary
 * poll looks, so no settled turn re-evaluates the drain: the 15 s health tick
 * does, and the age is read after its probe and the snapshot reads (≤ 5 s
 * each). The window covers one tick and those reads with room to spare.
 */
export const LEGACY_GOAL_TURN_BOUNDARY_MS = 45_000;

/**
 * Agent goals §5.7, a host from before the goal hold: how soon after the
 * previous turn settled a turn must have started to be Codex continuing a
 * goal. Codex starts the next goal turn within milliseconds of the last one's
 * end; a turn with no user message that starts later — a `/compact` typed
 * after a goal turn, which such a host records the same way — is not
 * stopped.
 */
export const LEGACY_GOAL_CONTINUATION_GAP_MS = 3_000;

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
  /** False once the child has exited; absent when the spawner cannot tell. */
  isAlive?(): boolean;
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
  /**
   * Agent goals §5.7: `POST /goals/hold` — a deploy's drain is blocked, so ask
   * the host to hold every continuing goal between two of its turns. Each call
   * renews a lease the host drops `GOAL_HOLD_LEASE_MS` after the last one.
   * Resolves to every thread the host holds after the request, or `null` when
   * the host predates the route (its route-miss 404); throws on anything else.
   * Must be bounded. Never awaited by a transition — one request at a time,
   * the next evaluation asks again. Optional — without it the drain waits
   * exactly as it did before §5.7.
   */
  requestHoldGoals?(): Promise<readonly string[] | null>;
  /**
   * Agent goals §5.7, a host that predates `POST /goals/hold` — the one the
   * deploy shipping §5.7 replaces: one blocking thread's running turn, read
   * off the host's own snapshot (`GET /threads/:id/thread`). `null` when it
   * cannot be read. Bounded; never throws.
   */
  inspectLegacyGoalTurn?(threadId: string): Promise<LegacyGoalTurn | null>;
  /**
   * The chat adapter the daemon's own tab record names for a thread, or null
   * when it cannot tell. A cheap pre-filter for the legacy handover: a thread
   * it names as anything but Codex cannot be a Codex goal loop, so no
   * snapshot — a whole thread window — is read while one blocks the drain.
   */
  threadAdapter?(threadId: string): string | null;
  /** `POST /threads/:id/session/stop` on the host. Bounded; throws on a failure. */
  stopThreadSession?(threadId: string): Promise<void>;
  /**
   * `POST /goals/resume-sessions` (agent goals §5.7): resume these threads'
   * provider sessions WITHOUT a turn. Resolves to the threads the host took,
   * or `null` when it predates the route; throws on anything else. Bounded.
   */
  resumeGoalSessions?(threadIds: readonly string[]): Promise<readonly string[] | null>;
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
  /**
   * The daemon's OWN view of which threads have live background work — the
   * `backgroundLiveness` its §6.4 summary poll already reads per thread. It is
   * unioned with the host's `backgroundWorkThreadIds`, so a host from before
   * that field existed (the one a deploy is about to replace) is still drained
   * only once its fleets are done. `null` means "not known yet" (the poll has
   * not completed a round), which holds such a host rather than reading as
   * "nothing running".
   */
  backgroundWorkThreadIds?(): readonly string[] | null;
  logger?: { log?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void };
}

/**
 * Agent goals §5.7 on a host from before the goal hold: one blocking thread's
 * running turn, as that host's own snapshot records it.
 */
export interface LegacyGoalTurn {
  /**
   * A Codex goal's continuation: a Codex thread whose running turn AND the
   * turn before it had no user message behind them — turns Codex started by
   * itself — with no approval or question open.
   */
  goalLoop: boolean;
  /** The running turn's id, or null when unknown. */
  turnId: string | null;
  /** When the running turn started (epoch ms), or null when unknown. */
  startedAt: number | null;
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
 * Agent goals §5.7 bookkeeping for the host a pending version restart waits
 * on, so each fact is logged once rather than per evaluation. Scoped to ONE
 * host instance: whatever another instance answered says nothing about this one.
 */
interface GoalHoldState {
  hostInstanceId: string;
  /** The host answered its route-miss 404: it predates §5.7 and is not asked again. */
  unsupported: boolean;
  /** The held set last logged, sorted and space-joined; "" while nothing is held. */
  held: string;
  /** The failure last logged, or null since the last answer. */
  failure: string | null;
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
  /** The last logged reason a pending version restart was deferred. */
  private lastDrainDeferral: string | null = null;
  /** What the host a deploy waits on answered to its §5.7 goal hold ({@link GoalHoldState}). */
  private goalHold: GoalHoldState | null = null;
  /** The §5.7 hold request still waiting for its answer, if any: one at a time. */
  private goalHoldInFlight: Promise<void> | null = null;
  /**
   * Agent goals §5.7, a host from before the goal hold: the Codex threads whose
   * session this daemon stopped at a turn boundary so the deploy could go
   * ahead, their goals still active in Codex's own store — each owed a session
   * resume on the next host, which lets Codex continue the goal by itself.
   * In memory: a daemon restarted before the handover forgets them, and those
   * goals then wait for the user's next message.
   */
  private readonly legacyGoalResumes = new Set<string>();
  /** The running turn each legacy goal session was stopped in: never stopped twice for one turn. */
  private readonly legacyGoalStoppedTurns = new Map<string, string | null>();
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
   * Resolves once no agent goals §5.7 hold request is in flight. Supervision
   * itself never waits on one; this is for a caller that must see a request's
   * answer applied — a test.
   */
  goalHoldSettled(): Promise<void> {
    return this.goalHoldInFlight ?? Promise.resolve();
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
          // over as soon as no thread has an active turn or live background
          // work (a subagent fleet, a background shell).
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
      if (!this.supervising) return;
      // A replacement can miss the bounded prepared deadline and still finish
      // booting later. `error` used to be terminal, so the daemon kept
      // returning HOST_UNAVAILABLE even after that exact replacement answered
      // healthy; only a daemon restart could make it adoptable again. Keep the
      // respawn cap (do not hammer a genuinely dead host), but continue the
      // cheap health probe so a late-ready process can recover in place.
      if (this.state === "error") {
        const recovered = await this.safeProbe();
        if (recovered.ok) {
          this.adopt(recovered.health);
        }
        return;
      }
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
        } else {
          // A hand-over the replacement could not take yet is asked again.
          await this.resumeLegacyGoalSessions();
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
      // the last good health reported an active turn or live background work:
      // that is positive evidence the host had work, so give it the full
      // window.
      this.missedProbes++;
      const required =
        this.health !== null && hostHasWork(this.health, this.daemonBackgroundWork())
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
   *
   * It never asks for an agent goals §5.7 hold: a manual stop restarts at once
   * rather than waiting for a quiet moment, and the host's `/stop` writes the
   * §5.5 resume marks that carry a continuing goal across it.
   */
  restartNow(): Promise<string | null> {
    return this.transition(async () => {
      await this.drainAndRestart();
      return this.health?.hostInstanceId ?? null;
    });
  }

  /**
   * Re-evaluate the drain window (§3.1 case 3). Called when a turn settles —
   * and when a thread's background work ends — so a deploy's version handover
   * happens the moment the host goes quiet rather than on the next 15 s tick.
   * Still blocked, it renews the agent goals §5.7 hold instead.
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
   * The daemon-side liveness view (`null` = not known yet); a failing reader
   * never blocks supervision, and no reader at all means "none".
   */
  private daemonBackgroundWork(): readonly string[] | null {
    const read = this.opts.adapters.backgroundWorkThreadIds;
    if (!read) return [];
    try {
      return read();
    } catch {
      return [];
    }
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
   *
   * "Drained" means no active turn AND no live background work. A subagent
   * fleet or a background shell keeps running inside the provider process
   * after the turn that launched it settled, and a restart kills it exactly
   * as it kills a turn — the CLI then reports each one as "didn't finish
   * before the previous session ended" on the next message, and nothing
   * warned the user in between (owner incident 2026-09-23: a code-only deploy
   * restarted the host the moment the parent's turn settled, under five
   * working subagents). Background work ending is reported by the daemon's
   * summary poll (`onBackgroundWorkEnded`, wired to `handleTurnSettled`); the
   * 15 s health tick is the fallback.
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
    const blockers = drainBlockers(probed.health, this.daemonBackgroundWork());
    if (blockers !== null) {
      // Once per change of reason, not once per 15 s tick.
      if (blockers !== this.lastDrainDeferral) {
        this.lastDrainDeferral = blockers;
        this.log("log", `agent host restart deferred: ${blockers}`);
      }
      // Agent goals §5.7. A continuing Codex goal starts its next turn within
      // milliseconds of the last, so `activeTurnThreadIds` is almost never
      // empty and this drain used to wait out the whole goal — hours. Ask the
      // host to hold it between two turns: the running one finishes, none
      // follows, and that settle re-runs this on a drained host
      // (`handleTurnSettled`). Asked on EVERY blocked evaluation — boot
      // adoption, a settled turn, ended background work, the 15 s tick —
      // because the hold is a lease: when the asking stops (a withdrawn deploy)
      // the host resumes what it held. Whatever the blocker: only the host can
      // tell whether goals are all that is in the way, and it holds nothing
      // while a fleet in another tab would leave a goal idle for as long as it
      // ran. NOT awaited: supervision — boot adoption, before the daemon
      // listens, above all — never waits on the host's answer. A `/stop` that
      // overtakes a hold still being applied is safe: the host skips a pause
      // queued behind it and keeps the mark of one it cut short.
      this.renewGoalHold(probed.health.hostInstanceId);
      const hold = this.goalHold;
      if (hold?.unsupported === true && hold.hostInstanceId === probed.health.hostInstanceId) {
        await this.stopLegacyGoalsAtTheirBoundary(probed.health);
      }
      return;
    }
    this.lastDrainDeferral = null;
    await this.drainAndRestart();
  }

  /**
   * One agent goals §5.7 hold request against the host instance the drain
   * waits on. It never throws and decides nothing about the drain. A failure
   * is logged once per change of reason and simply asked again on the next
   * evaluation — the lease outlives several missed renewals. A host that
   * predates the route (`null`) is remembered and not asked again until a
   * different instance is adopted: the deploy that ships §5.7 falls back to
   * stopping Codex goal loops at their turn boundaries
   * ({@link stopLegacyGoalsAtTheirBoundary}), the next one holds. The held
   * set is logged when it changes, never per tick — the host answers the
   * whole set on every renewal.
   */
  private renewGoalHold(hostInstanceId: string): void {
    if (this.goalHoldInFlight !== null) return;
    this.goalHoldInFlight = this.requestGoalHold(hostInstanceId).finally(() => {
      this.goalHoldInFlight = null;
    });
  }

  private async requestGoalHold(hostInstanceId: string): Promise<void> {
    const request = this.opts.adapters.requestHoldGoals;
    if (!request) return;
    let hold = this.goalHold;
    if (hold === null || hold.hostInstanceId !== hostInstanceId) {
      // A replacement or a respawn starts over: another instance may know the
      // route, and it holds nothing yet.
      hold = { hostInstanceId, unsupported: false, held: "", failure: null };
      this.goalHold = hold;
    }
    if (hold.unsupported) return;
    try {
      const held = await request();
      // Answered after the supervisor moved on — the host replaced, or its
      // restart no longer pending: nothing to learn, and nothing to log.
      if (this.goalHold !== hold || !this.pendingVersionRestart) return;
      hold.failure = null;
      if (held === null) {
        hold.unsupported = true;
        this.log(
          "log",
          "agent host predates the goal hold; once Codex goal loops are all that keep the restart waiting, their sessions are stopped at a turn boundary and resumed on the next host"
        );
        return;
      }
      const ids = [...new Set(held)].sort();
      const key = ids.join(" ");
      if (key === hold.held) return;
      hold.held = key;
      this.log(
        "log",
        ids.length > 0
          ? `agent host holding ${ids.length} continuing goal(s) for the restart`
          : "agent host no longer holding goals for the restart"
      );
    } catch (error) {
      // A throw — synchronous or not — is logged, never passed on: nothing
      // awaits this. A failure after the supervisor moved on is no news.
      if (this.goalHold !== hold || !this.pendingVersionRestart) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== hold.failure) {
        hold.failure = reason;
        this.log("warn", "agent host goal hold request failed; the restart keeps waiting", error);
      }
    }
  }

  /**
   * Agent goals §5.7 for a host from before the goal hold (its route-miss
   * 404). Such a host knows nothing of goals and cannot pause one, and a
   * continuing Codex goal starts its next turn within milliseconds of the
   * last, so its drain would wait out the whole goal. So once the drain's ONLY
   * blockers are Codex goal loops — every running turn one Codex started by
   * itself, right after another it started — each goal thread's provider
   * session is stopped the moment its next turn has just begun (within
   * {@link LEGACY_GOAL_TURN_BOUNDARY_MS}), which loses seconds of that turn at
   * most, and remembered: the next host resumes the session without a turn,
   * and Codex continues the goal by itself — its own store kept it active
   * ({@link resumeLegacyGoalSessions}). A goal thread mid-turn is left for its
   * own boundary. Anything else in the way — a turn a user started,
   * background work anywhere or not known yet, a thread whose snapshot cannot
   * be read, an open approval or question — stops nothing, and the deploy
   * waits as it always did. A goal stopped while a sibling goal is still
   * mid-turn, or before other work starts, waits idle for the restart: such a
   * host cannot resume a session without a turn.
   */
  private async stopLegacyGoalsAtTheirBoundary(health: AgentHostHealthResponse): Promise<void> {
    const { inspectLegacyGoalTurn, stopThreadSession, resumeGoalSessions } = this.opts.adapters;
    if (!inspectLegacyGoalTurn || !stopThreadSession || !resumeGoalSessions) return;
    // Background work anywhere keeps the drain waiting whatever the goals do —
    // as does not knowing yet (`drainBlockers`' own rule).
    const daemonView = this.daemonBackgroundWork();
    if (health.backgroundWorkThreadIds === undefined && daemonView === null) return;
    if (backgroundWorkThreadIds(health, daemonView).length > 0) return;
    const active = [...new Set(health.activeTurnThreadIds)];
    if (active.length === 0) return;
    const adapterOf = this.opts.adapters.threadAdapter;
    if (
      adapterOf !== undefined &&
      active.some((threadId) => {
        const adapter = adapterOf(threadId);
        return adapter !== null && adapter !== "codex";
      })
    ) {
      return;
    }
    const turns = await Promise.all(
      active.map(async (threadId) => ({
        threadId,
        turn: await inspectLegacyGoalTurn(threadId).catch(() => null)
      }))
    );
    if (turns.some(({ turn }) => turn === null || !turn.goalLoop)) return;
    const now = this.opts.adapters.now();
    for (const { threadId, turn } of turns) {
      if (turn?.startedAt == null || now - turn.startedAt > LEGACY_GOAL_TURN_BOUNDARY_MS) continue;
      if (turn.turnId !== null && this.legacyGoalStoppedTurns.get(threadId) === turn.turnId) {
        continue;
      }
      // Handed over whatever the stop answers: a stop that timed out or lost
      // its reply may still have landed, and a session resumed that was never
      // stopped is only an idle one — while one stopped and never resumed
      // leaves its goal waiting for the user.
      this.legacyGoalResumes.add(threadId);
      try {
        await stopThreadSession(threadId);
      } catch (error) {
        this.log("warn", `could not stop Codex goal ${threadId}'s session for the restart; it keeps it waiting`, error);
        continue;
      }
      this.legacyGoalStoppedTurns.set(threadId, turn.turnId);
      this.log(
        "log",
        `agent host predates the goal hold: stopped Codex goal ${threadId}'s session at a turn boundary for the restart; the next host resumes it`
      );
    }
  }

  /**
   * Hand the host the goal sessions {@link stopLegacyGoalsAtTheirBoundary}
   * stopped: it resumes each without a turn, and Codex continues its goal. On
   * a healthy host with no restart pending — right after the replacement is
   * adopted, and again on every health tick until a host takes them. Never
   * throws.
   */
  private async resumeLegacyGoalSessions(): Promise<void> {
    const resume = this.opts.adapters.resumeGoalSessions;
    if (
      !resume ||
      this.legacyGoalResumes.size === 0 ||
      this.state !== "healthy" ||
      this.pendingVersionRestart
    ) {
      return;
    }
    const threadIds = [...this.legacyGoalResumes].sort();
    try {
      const taken = await resume(threadIds);
      // A host without the route cannot take them; a later one will.
      if (taken === null) return;
      for (const threadId of threadIds) this.legacyGoalResumes.delete(threadId);
      this.log(
        "log",
        `agent host resuming ${taken.length} Codex goal session(s) the restart stopped` +
          (taken.length < threadIds.length ? ` (${threadIds.length - taken.length} no longer there)` : "")
      );
    } catch (error) {
      this.log("warn", "could not hand the stopped Codex goal sessions to the agent host; asking again on the next check", error);
    }
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
      // teardown: the provider children die with the pane before their turns
      // are settled and their tasks closed `stopped`, so the thread reads
      // "running" for work that is already dead; and OpenCode's server is
      // spawned `detached: true`, i.e. in its own process group, so it SURVIVES
      // the kill holding its port and sessions while the replacement host
      // starts a second one per project. Wait for the PROCESS to exit — the
      // socket closing is the teardown's first step, not its last — bounded
      // by {@link HOST_EXIT_GRACE_MS}.
      await this.awaitHostExit();
    }
    this.pendingVersionRestart = false;
    const ready = await this.spawnAndWait(true);
    if (!ready) {
      this.setState("error", "replacement agent host never reached readiness");
      this.log("error", "agent host restart did not switch: the replacement never became ready");
      return;
    }
    await this.resumeLegacyGoalSessions();
  }

  /**
   * Poll until the old host is GONE — its process has exited and its socket
   * no longer answers — bounded by {@link HOST_EXIT_GRACE_MS}. Returns true
   * when it is gone.
   */
  private async awaitHostExit(): Promise<boolean> {
    const deadline = this.opts.adapters.now() + (this.opts.exitGraceMs ?? HOST_EXIT_GRACE_MS);
    for (;;) {
      if (await this.hostGone()) return true;
      if (this.opts.adapters.now() >= deadline) {
        this.log("warn", "agent host did not exit within the drain grace; killing it");
        return false;
      }
      await this.opts.adapters.sleep(HOST_EXIT_POLL_MS);
    }
  }

  /**
   * "Gone" is the process, not the listener: the host closes its socket
   * FIRST and stops its provider children after, so a quiet socket still has a
   * teardown running behind it. Under tmux the service session ends when its
   * command exits; the direct child reports its own exit. The socket is
   * checked as well, so a host running outside our session (a developer's
   * hand-started one) is never mistaken for an exited one.
   */
  private async hostGone(): Promise<boolean> {
    const tmux = this.opts.adapters.tmux;
    if (tmux) {
      const sessionAlive = await tmux
        .hasServiceSession(AGENT_HOST_SERVICE_SESSION)
        // tmux itself failing to answer: fall back to the socket alone.
        .catch(() => false);
      if (sessionAlive) return false;
    } else if (this.directHandle?.isAlive?.() === true) {
      return false;
    }
    return !(await this.safeProbe()).ok;
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
 * Threads with live background work: what the host reports (optional on the
 * wire — an older host omits it) unioned with the daemon's own liveness view.
 */
function backgroundWorkThreadIds(
  health: AgentHostHealthResponse,
  daemonView: readonly string[] | null
): string[] {
  return [...new Set([...(health.backgroundWorkThreadIds ?? []), ...(daemonView ?? [])])];
}

/** True while any thread has an active turn or live background work. */
export function hostHasWork(
  health: AgentHostHealthResponse,
  daemonView: readonly string[] | null = []
): boolean {
  return (
    health.activeTurnThreadIds.length > 0 || backgroundWorkThreadIds(health, daemonView).length > 0
  );
}

/**
 * Why the §3.1 drain cannot proceed yet, as one log-ready sentence, or null
 * when the host is drained. A host that does not report background work
 * itself is held while the daemon's own view is still unknown: at boot the
 * supervisor adopts before the summary poll has run, and an empty view would
 * otherwise read as "nothing running" and kill a fleet on the very deploy
 * that ships this rule.
 */
export function drainBlockers(
  health: AgentHostHealthResponse,
  daemonView: readonly string[] | null = []
): string | null {
  if (health.backgroundWorkThreadIds === undefined && daemonView === null) {
    return "background work not known yet (the host predates the health field; waiting for the first summary poll)";
  }
  const turns = health.activeTurnThreadIds.length;
  const background = backgroundWorkThreadIds(health, daemonView).length;
  if (turns === 0 && background === 0) return null;
  const parts: string[] = [];
  if (turns > 0) parts.push(`${turns} thread(s) with an active turn`);
  if (background > 0) parts.push(`${background} thread(s) with live background work`);
  return parts.join(", ");
}

/**
 * Agent goals §5.7: {@link LegacyGoalTurn} off what a host from before the
 * goal hold answered `GET /threads/:id/thread` — `{kind: "snapshot", thread}`,
 * another version's wire data, read field-wise. `null` when it names no
 * running turn to judge (the turn settled since `/health` was read, or the
 * body is not a snapshot). A turn "Codex started by itself" is a turn row
 * without a `userMessageId` — the host fills it only when a user message
 * opened the turn — and a goal CONTINUES only when it started within
 * {@link LEGACY_GOAL_CONTINUATION_GAP_MS} of the previous turn's end.
 */
export function legacyGoalTurnOf(body: unknown): LegacyGoalTurn | null {
  if (!isRecord(body) || body.kind !== "snapshot") return null;
  const snapshot = body.thread;
  if (!isRecord(snapshot) || !isRecord(snapshot.head)) return null;
  const head = snapshot.head;
  const session = isRecord(head.session) ? head.session : null;
  const activeTurnId = typeof session?.activeTurnId === "string" ? session.activeTurnId : null;
  if (activeTurnId === null) return null;
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  const at = turns.findIndex((turn) => turn.turnId === activeTurnId);
  const running = at >= 0 ? turns[at] : undefined;
  const previous = at > 0 ? turns[at - 1] : undefined;
  const pending = isRecord(snapshot.pending) ? snapshot.pending : {};
  const open =
    (Array.isArray(pending.approvals) ? pending.approvals.length : 0) +
    (Array.isArray(pending.userInputs) ? pending.userInputs.length : 0);
  const startedAt = typeof running?.startedAt === "string" ? Date.parse(running.startedAt) : Number.NaN;
  const previousEnded =
    typeof previous?.completedAt === "string" ? Date.parse(previous.completedAt) : Number.NaN;
  const providerStarted = (turn: Record<string, unknown> | undefined): boolean =>
    turn !== undefined && typeof turn.userMessageId !== "string";
  const continued =
    Number.isFinite(startedAt) &&
    Number.isFinite(previousEnded) &&
    startedAt - previousEnded <= LEGACY_GOAL_CONTINUATION_GAP_MS;
  return {
    goalLoop:
      head.adapter === "codex" &&
      providerStarted(running) &&
      providerStarted(previous) &&
      continued &&
      open === 0,
    turnId: activeTurnId,
    startedAt: Number.isFinite(startedAt) ? startedAt : null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
