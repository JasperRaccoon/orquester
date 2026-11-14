/**
 * Supervision of the agent host process (spec §3.1 "Spawn and adoption",
 * "Readiness is a gate", "No-tmux hosts", "Kill guard"; §8).
 *
 * The host is a tmux *service* session (`orqsvc-agent-host`) so
 * `KillMode=process` leaves it running across a deploy, boot adoption is an **authenticated probe first** (so "the socket
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
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentHostRestartBlocker,
  AgentHostRetiringStatus,
  AgentHostStatusResponse
} from "@orquester/api/agent-chat";
import {
  agentHostForeignThreadsPath,
  agentHostRegistryPath,
  agentHostSocketPath,
  agentHostTokenPath,
  type AgentHostRegistryEntry,
  type RuntimePlatform
} from "@orquester/config";
import { codeStampsDiffer } from "../agent-host/support/code-stamp.ts";
import {
  AGENT_HOST_ENV,
  AGENT_HOST_PREPARED_TIMEOUT_MS,
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_RETIRE_MAX_MS,
  AGENT_HOST_UPDATE_GRACE_MS,
  MAX_RETIRING_HOSTS,
  agentHostServiceSession,
  agentHostSupports,
  type AgentHostCapabilities,
  type AgentHostHealthResponse
} from "../agent-host/host-protocol.ts";
import { AgentHostClient, type AgentHostClientOptions } from "./host-client.ts";
import type { HostDirectory, HostEndpoint, HostRole } from "./host-directory.ts";
import {
  HostRegistryUnreadableError,
  highestRecordedGeneration,
  readHostRegistry,
  writeForeignThreads,
  writeHostRegistry,
  type HostRegistryFile
} from "./host-registry.ts";

/** Path of the host entry point, resolved from this module, never from cwd. */
const AGENT_HOST_MAIN = fileURLToPath(new URL("../agent-host/main.ts", import.meta.url));

/** Spawn→readiness poll interval. The gate can take a moment to open. */
const SPAWN_PROBE_INTERVAL_MS = 250;

/** Exponential backoff base between supervised respawn attempts. */
const RESPAWN_BACKOFF_BASE_MS = 2_000;
const RESPAWN_BACKOFF_MAX_MS = 60_000;

/** After this many consecutive failed respawns the supervisor latches `error`. */
const MAX_RESPAWNS = 5;

/**
 * Consecutive unreachable probes before the supervisor kills and respawns.
 *
 * One miss is not evidence of death: the probe has a 5 s timeout, and a host
 * whose event loop is busy with a large cold fold or a big `readThread` answers
 * nothing. Restarting on that takes down every live turn (§8: "Restarting the
 * host interrupts live work"), which is precisely what the drain rule exists to
 * avoid. A supervised helper with no in-flight user work could restart on the
 * first miss; the host cannot.
 */
const UNREACHABLE_PROBES_BEFORE_RESTART = 2;

/** …and more patience when the last good health reported an active turn. */
const UNREACHABLE_PROBES_BEFORE_RESTART_BUSY = 4;

/**
 * 1-minute load average per CPU at or above which a silent host whose process
 * is still alive is treated as starved, not dead. Owner incident 2026-10-07:
 * agent builds and test runs drove the load to ~180 on 12 CPUs, the host
 * missed four 5 s probes, and the restart took down every live turn while the
 * replacement booted on the same saturated box.
 */
const SATURATED_LOAD_PER_CPU = 2;

/**
 * How long a starved-but-alive host is waited for, from the first miss of
 * its streak, before it is restarted anyway — a host that is genuinely wedged
 * while the box happens to be busy still recovers.
 */
const STARVED_HOST_PATIENCE_MS = 10 * 60_000;

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
const HOST_EXIT_GRACE_MS = 30_000;

/**
 * A pending drain-restart deferred this long gets a warning, repeated once per
 * this interval: a host that never drains keeps running old code silently.
 */
const RESTART_PENDING_WARN_MS = 6 * 60 * 60_000;
const HOST_EXIT_POLL_MS = 100;

/**
 * How long a pending wake (`AgentHostHealthResponse.pendingWakes`) holds a
 * drain. A provider starts the turn that hands the agent a finished background
 * task within seconds (Claude: 1-5 s); one that has not after this long may
 * never, and the deploy goes ahead — the host's mark survives the restart, and
 * the next host hands the agent the result itself.
 */
export const PENDING_WAKE_DRAIN_CAP_MS = 2 * 60_000;

/**
 * A host from before `pendingWakes` cannot say a wake is pending, so the drain
 * waits this long after a thread's background work ended — unless a turn of
 * that thread settled since, which was the wake.
 */
export const BACKGROUND_END_GRACE_MS = 60_000;

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
const LEGACY_GOAL_TURN_BOUNDARY_MS = 45_000;

/**
 * Agent goals §5.7, a host from before the goal hold: how soon after the
 * previous turn settled a turn must have started to be Codex continuing a
 * goal. Codex starts the next goal turn within milliseconds of the last one's
 * end; a turn with no user message that starts later — a `/compact` typed
 * after a goal turn, which such a host records the same way — is not
 * stopped.
 */
const LEGACY_GOAL_CONTINUATION_GAP_MS = 3_000;

/**
 * Host updates (spec 2026-11-01 P2.3 R20, P2.4 R26): how often each retiring host's `/health` is
 * read — the summary cadence — so a thread it released is adopted within about one poll.
 */
export const RETIRING_HOST_POLL_MS = 1_500;

/**
 * P2.4 R28: a retiring host whose process is alive but that has not answered for this long is
 * treated as dead — killed, and its threads adopted (the crash path continues them). As patient
 * as the primary's busy miss streak, since a retiring host is busy by definition.
 */
const RETIRING_HOST_UNRESPONSIVE_MS = 60_000;

/** P2.4 R26: an adoption that failed is tried again after this, doubling up to the max. */
const ADOPT_RETRY_BASE_MS = 1_000;
const ADOPT_RETRY_MAX_MS = 30_000;

/**
 * P2.4 R26: after this many failed attempts a thread's adoption is reported on the Host status
 * page (`stuckAdoptions`) and logged as an error — the chat is unreachable until it lands. It is
 * still retried.
 */
const ADOPT_ATTEMPTS_BEFORE_REPORTING = 5;

/**
 * I1/I4: how long a killed host has to be confirmed gone — its tmux session ended or its direct
 * child exited, and its socket silent — before the kill is escalated (SIGKILL, the session killed
 * again), and again after that before the kill counts as unconfirmed. A direct child's SIGTERM
 * teardown is bounded at 3 s by the host itself.
 */
const HOST_KILL_GRACE_MS = 10_000;

/** A host whose death could not be confirmed is killed again this long after the last attempt. */
const HOST_KILL_RETRY_MS = 30_000;

/** P2.3 R21: `/unretire` attempts before an update's failure falls back to a Phase 1 restart. */
const UNRETIRE_ATTEMPTS = 3;
const UNRETIRE_RETRY_MS = 1_000;

/**
 * P2.4 R23/R26: the longest {@link AgentHostSupervisor.hostForThread} holds a request for a
 * switch or an adoption in flight before answering "no host now" (a 503 the client retries) —
 * the bound a host request has anyway.
 */
const ROUTE_WAIT_MS = 20_000;

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
  /** SIGTERM unless `signal` says otherwise. */
  kill(signal?: NodeJS.Signals): void;
  pid?: number;
  /** False once the child has exited; absent when the spawner cannot tell. */
  isAlive?(): boolean;
}

export interface SupervisorTmux {
  /** False only when the session (or the server) is gone; throws when tmux cannot tell. */
  hasServiceSession(name: string): Promise<boolean>;
  /**
   * The live service sessions whose names start with `prefix`; throws when tmux cannot tell.
   * Optional: without it a registry the daemon cannot read is checked one generation at a time.
   */
  listServiceSessions?(prefix: string): Promise<string[]>;
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
  /**
   * Authenticated `GET /health` on the socket of host `generation` (spec 2026-11-01 P2.2; 0 =
   * the legacy names), through {@link AgentHostSupervisor.clientFor}. Must never throw.
   */
  probe(generation: number): Promise<ProbeOutcome>;
  /** Ask a healthy host to write continuation markers and drain (§3.3, §6.3). */
  requestStop(generation: number): Promise<void>;
  /**
   * Host updates (P2.3 R18): `POST /retire` on host `generation` → the threads it keeps. `null`
   * when the host predates the route (its route-miss 404); throws on any other failure. Bounded.
   * Without it the supervisor never retires a host: every update is a Phase 1 restart.
   */
  requestRetire?(generation: number): Promise<readonly string[] | null>;
  /** P2.3 R21: `POST /unretire` — undo a retire whose replacement failed. Bounded; throws on failure. */
  requestUnretire?(generation: number): Promise<void>;
  /**
   * P2.3 R17: `POST /threads/:id/adopt` on host `generation`. `adopted` / `owned` (it was not
   * foreign there: nothing done) / `missing` (no such thread: nothing to adopt). Bounded; throws
   * on any other failure, which is retried.
   */
  requestAdopt?(generation: number, threadId: string): Promise<"adopted" | "owned" | "missing">;
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
   * Run `fn` once after `ms`; the returned function cancels it. Defaults to an unref'd
   * `setTimeout`, so a test drives it with `mock.timers`. For deadlines that must fire without a
   * health tick: the update grace (spec 2026-11-01 P1.4 R12).
   */
  setTimer?(ms: number, fn: () => void): () => void;
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
  /**
   * The machine's 1-minute load average divided by its CPU count. Absent (or
   * 0, as on Windows) means "never saturated": a silent host is restarted on
   * the miss count alone.
   */
  loadPerCpu?(): number;
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
  adapters: SupervisorAdapters;
  /**
   * The stamp of the agent-host code in the DAEMON's checkout (`support/code-stamp.ts`). A
   * healthy host reporting a different known stamp is a §3.1 case-3
   * drain-restart exactly like a protocol mismatch: after a deploy the old
   * host would otherwise keep running old code for as long as it lived.
   */
  codeStamp?: string | null;
  /** {@link PENDING_WAKE_DRAIN_CAP_MS} unless set: how long one pending wake holds a drain. */
  pendingWakeCapMs?: number;
  /** {@link BACKGROUND_END_GRACE_MS} unless set: the older host's grace after background work ends. */
  backgroundEndGraceMs?: number;
  /**
   * The platform the host sockets are named for (`agentHostSocketPath`); the daemon's own unless
   * set. Generation 0's socket is the one `env` already names.
   */
  platform?: RuntimePlatform;
  /** Builds each generation's plain client ({@link HostEndpoint.client}); a real one unless set. */
  createClient?(options: AgentHostClientOptions): AgentHostClient;
}

/**
 * Host updates (spec 2026-11-01 P2.4): a previous-version host that keeps the threads that were
 * working when it retired, until each is idle.
 */
interface RetiringHost {
  readonly generation: number;
  health: AgentHostHealthResponse | null;
  /** What it owns, as last seen — only ever shrinks; what the primary adopts if it is gone. */
  owned: Set<string>;
  /** When it began retiring (epoch ms): the cap (R30) counts from here. */
  retiringSince: number;
  /** Start of its current unanswered-probe streak, or null. */
  firstMissAt: number | null;
  /** Being ended (drained, capped, dead): never ended twice. */
  ending: boolean;
  /**
   * I1: since when the daemon has been ending it without being able to confirm its process is
   * gone, or null. Until it is confirmed, its threads stay its own; it is killed again on the
   * poll, at most every {@link HOST_KILL_RETRY_MS}.
   */
  killUnconfirmedSince: number | null;
  /** When the next kill attempt is due (adapter clock), while {@link killUnconfirmedSince} is set. */
  nextKillAt: number;
}

/**
 * I1: a host the daemon tried to kill without being able to confirm it is gone, and that may own
 * threads no other host's foreign file lists — an update's failed replacement, or a recorded host
 * that did not answer at boot. While any exists, no host that would own every thread is spawned.
 */
interface UnstoppableHost {
  reason: string;
  nextKillAt: number;
  /** What the confirmed kill unblocks (an update's undo), run once. */
  onGone?: () => Promise<void>;
}

/** P2.4 R26: a thread whose adoption keeps failing. */
interface AdoptionFailure {
  attempts: number;
  since: number;
  error: string | null;
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
 * `startDaemon` after `sessions.reattach()`.
 */
export class AgentHostSupervisor implements HostDirectory {
  private state: AgentHostState = "stopped";
  private reason: string | null = null;
  /** The primary's last fresh health. */
  private health: AgentHostHealthResponse | null = null;
  /**
   * Host updates (spec 2026-11-01 P2.2): the primary's generation — every field above and below
   * that is not per generation describes this host. 0 until a registry or an update says else.
   */
  private primaryGeneration = 0;
  /** Each generation's token, read or regenerated (only while no host of it is alive). */
  private readonly tokens = new Map<number, string>();
  /** Each generation's direct child (the no-tmux fallback). */
  private readonly directHandles = new Map<number, DirectHostHandle>();
  /** Each generation's plain client, built once. */
  private readonly clients = new Map<number, AgentHostClient>();
  /** P2.4: the retiring hosts, by generation. At most {@link MAX_RETIRING_HOSTS}. */
  private readonly retiring = new Map<number, RetiringHost>();
  /**
   * True once the registry is in play — it existed at boot, or an update retired a host. Until
   * then nothing writes it, so a daemon that never updates keeps the single-host layout (R29).
   */
  private registryInUse = false;
  /** What the registry held that this daemon does not manage: written back as it was. */
  private registryKept: HostRegistryFile = { entries: [], unparsed: [], extra: {} };
  /** The highest generation ever seen or handed out; the next one is above it. */
  private highestGeneration = 0;
  /** Registry writes, one after another (each writes the state at its turn). */
  private registryWrites: Promise<unknown> = Promise.resolve();
  /** P2.4 R23: set while the primary retires and its replacement starts; settles when done. */
  private switching: Promise<void> | null = null;
  /**
   * …once the old primary's `/retire` answered: its generation, the threads it keeps, since
   * when, and the generation starting to replace it.
   */
  private switchKeeps: { generation: number; threadIds: Set<string>; since: number; starting: number } | null = null;
  /** Settles {@link switching}. */
  private switchDone: (() => void) | null = null;
  /**
   * Settles once the switching primary's `/retire` answered (or the switch ended): a request
   * waiting on the switch for a thread the old host keeps goes there then, not after the spawn.
   * Null once it has.
   */
  private retireAnswer: { promise: Promise<void>; resolve: () => void } | null = null;
  /** I1: hosts whose kill could not be confirmed and that may own unlisted threads, by generation. */
  private readonly unstoppable = new Map<number, UnstoppableHost>();
  /**
   * The registry was unreadable, or named hosts this daemon cannot parse, and a live host could
   * not be accounted for: why. Nothing is spawned or adopted until the boot is tried again and
   * accounts for every live host.
   */
  private bootBlocked: string | null = null;
  /** One {@link HostEndpoint} per generation and role. */
  private readonly endpoints = new Map<string, HostEndpoint>();
  /** P2.4 R26: each thread being adopted by the primary, until it is. */
  private readonly adoptions = new Map<string, Promise<void>>();
  /** Which run of each thread's adoption is current ({@link cancelAdoption} supersedes one). */
  private readonly adoptionTokens = new Map<string, object>();
  /**
   * I5: every thread whose adoption has not completed, persisted as the registry's
   * `pendingAdoptions` — removed only once the primary adopted it, so a daemon that dies in
   * between adopts it at boot.
   */
  private readonly pendingAdoptionIds = new Set<string>();
  /** P2.4 R26: the adoptions that failed, by thread, until they land. */
  private readonly adoptFailures = new Map<string, AdoptionFailure>();
  /** The `POST …/adopt` requests on the wire: a `/retire` waits for them (I2). */
  private readonly adoptRequests = new Set<Promise<unknown>>();
  /** The host instance whose retire or replacement failed: Phase 1 for it (P2.6). */
  private phase2RefusedInstance: string | null = null;
  /** Cancels the next retiring-host poll. */
  private cancelRetiringPoll: (() => void) | null = null;
  /** Set by {@link stop}: nothing is scheduled or retried after it. */
  private halted = false;
  private pendingVersionRestart = false;
  private respawnAttempts = 0;
  private nextRespawnAt = 0;
  /** Consecutive unreachable probes; cleared by any healthy adoption. */
  private missedProbes = 0;
  /** When the current missed-probe streak began; meaningful only while {@link missedProbes} > 0. */
  private firstMissAt = 0;
  /** The last logged reason a pending version restart was deferred. */
  private lastDrainDeferral: string | null = null;
  /** When the pending restart was first deferred (adapter clock), or null while none waits. */
  private pendingRestartSince: number | null = null;
  /** When {@link warnIfRestartLongPending} last warned, or null. */
  private lastPendingWarnAt: number | null = null;
  /** Cancels the timer that re-evaluates the drain when the update grace runs out (R12). */
  private cancelGraceTimer: (() => void) | null = null;
  /** What the host a deploy waits on answered to its §5.7 goal hold ({@link GoalHoldState}). */
  private goalHold: GoalHoldState | null = null;
  /** The §5.7 hold request still waiting for its answer, if any: one at a time. */
  private goalHoldInFlight: Promise<void> | null = null;
  /**
   * For a host from before `pendingWakes`: when each thread's background work
   * was last seen ending (adapter clock), until a turn of it settles or the
   * grace runs out ({@link BACKGROUND_END_GRACE_MS}).
   */
  private readonly backgroundEndedAt = new Map<string, number>();
  /** The threads with background work at the last fresh probe, to see an end between two. */
  private lastBackgroundThreads = new Set<string>();
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

  /** The primary's token. */
  private get token(): string | null {
    return this.tokens.get(this.primaryGeneration) ?? null;
  }

  private set token(token: string | null) {
    if (token === null) this.tokens.delete(this.primaryGeneration);
    else this.tokens.set(this.primaryGeneration, token);
  }

  /** The primary's direct child. */
  private get directHandle(): DirectHostHandle | null {
    return this.directHandles.get(this.primaryGeneration) ?? null;
  }

  private set directHandle(handle: DirectHostHandle | null) {
    if (handle === null) this.directHandles.delete(this.primaryGeneration);
    else this.directHandles.set(this.primaryGeneration, handle);
  }

  /** The token the primary's client authenticates with. Null before the first adoption/spawn. */
  currentToken(): string | null {
    return this.token;
  }

  /**
   * Every live host's token — the primary's and each retiring one's. A host calls back on the
   * daemon's socket with its own (design 2026-10-14 §1.1), so each must be accepted. Never logged.
   */
  hostTokens(): string[] {
    const live = new Set([this.primaryGeneration, ...this.retiring.keys()]);
    if (this.switchKeeps !== null) live.add(this.switchKeeps.starting);
    return [...live]
      .map((generation) => this.tokens.get(generation))
      .filter((token): token is string => typeof token === "string");
  }

  /**
   * The plain client of host `generation`: its own socket and token, no routing. What the
   * adapters probe, stop, retire and adopt through, and each {@link HostEndpoint.client}.
   */
  clientFor(generation: number): AgentHostClient {
    let client = this.clients.get(generation);
    if (client === undefined) {
      const options: AgentHostClientOptions = {
        socketPath: this.socketPathOf(generation),
        token: () => this.tokens.get(generation) ?? null
      };
      client = this.opts.createClient ? this.opts.createClient(options) : new AgentHostClient(options);
      this.clients.set(generation, client);
    }
    return client;
  }

  /** The primary's plain client — for the global calls a pending restart makes (the goal hold). */
  primaryClient(): AgentHostClient {
    return this.clientFor(this.primaryGeneration);
  }

  // --- HostDirectory (spec 2026-11-01 P2.4 R24) ------------------------------

  /** The primary, or null while none is ready — a restart, or an update's switch. */
  primary(): HostEndpoint | null {
    if (this.state !== "healthy" || this.switching !== null) return null;
    return this.endpoint(this.primaryGeneration, "primary");
  }

  /** The primary (when ready) first, then every retiring host — the old primary mid-switch too. */
  hosts(): readonly HostEndpoint[] {
    const hosts: HostEndpoint[] = [];
    const primary = this.primary();
    if (primary !== null) hosts.push(primary);
    // Mid-switch, and after a failed one whose replacement is not confirmed gone: the old primary.
    if (this.switching !== null || this.switchKeeps !== null) hosts.push(this.endpoint(this.primaryGeneration, "retiring"));
    for (const generation of [...this.retiring.keys()].sort((a, b) => b - a)) {
      hosts.push(this.endpoint(generation, "retiring"));
    }
    return hosts;
  }

  /**
   * The host `threadId`'s requests go to: the retiring host that owns it, else the primary —
   * once no switch and no adoption of it is in flight (I2). Null when no host can serve it within
   * {@link ROUTE_WAIT_MS} (no primary, or an adoption still failing): the caller answers 503.
   */
  async hostForThread(threadId: string): Promise<HostEndpoint | null> {
    const deadline = this.opts.adapters.now() + ROUTE_WAIT_MS;
    for (;;) {
      const owner = this.retiringOwnerOf(threadId);
      if (owner !== null) return this.endpoint(owner, "retiring");
      const keeps = this.switchKeeps;
      if (keeps?.threadIds.has(threadId)) return this.endpoint(keeps.generation, "retiring");
      // Until the old primary's `/retire` answers, any thread may be one it keeps: wait for that
      // answer, not for the whole switch (the old host serves what it keeps throughout).
      const pending =
        this.switching !== null
          ? (this.retireAnswer?.promise ?? this.switching)
          : (this.adoptions.get(threadId) ?? null);
      if (pending === null) return this.primary();
      const left = deadline - this.opts.adapters.now();
      if (left <= 0 || !(await this.settlesWithin(pending, left))) return null;
    }
  }

  /**
   * A host answered 409 `THREAD_NOT_OWNED` for `threadId` (from `generation`). Every retiring
   * host's owned set is re-read: one that released the thread before our poll saw it has it
   * adopted now, and a thread none of them still owns is the primary's to adopt. A thread a
   * retiring host still lists — or that cannot be re-read — is never moved on a 409 alone (I1).
   * Either way the adoption is awaited (bounded) before the caller retries once.
   */
  async ownershipStale(threadId: string, _generation: number): Promise<void> {
    await this.refreshRetiringOwnership();
    if (this.retiringOwnerOf(threadId) === null && !this.switchKeeps?.threadIds.has(threadId)) {
      this.startAdoption(threadId);
      await this.persistRegistry();
    }
    const adoption = this.adoptions.get(threadId);
    if (adoption !== undefined) await this.settlesWithin(adoption, ROUTE_WAIT_MS);
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

  /**
   * `GET /api/agent-host/status`: the host and the drain-restart a deploy left
   * pending — why, since when, and what it waits on per thread, off the last
   * fresh probe (at most one health interval old). Thread titles are the
   * caller's to add.
   */
  restartStatus(): AgentHostStatusResponse {
    const health = this.health;
    const status = this.status();
    const stuck = [...this.adoptFailures]
      .filter(([, failure]) => failure.attempts >= ADOPT_ATTEMPTS_BEFORE_REPORTING)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([threadId, failure]) => ({
        threadId,
        attempts: failure.attempts,
        since: new Date(failure.since).toISOString(),
        error: failure.error
      }));
    const base: AgentHostStatusResponse = {
      state: status.state,
      // A healthy primary beside a host that could not be stopped still says why nothing spawns.
      reason: status.reason ?? this.unstoppableReason(),
      ...(stuck.length > 0 ? { stuckAdoptions: stuck } : {}),
      hostInstanceId: status.hostInstanceId,
      pid: status.pid,
      codeStamp: typeof health?.codeStamp === "string" ? health.codeStamp : null,
      checkoutCodeStamp: this.opts.codeStamp ?? null,
      pendingRestart: null,
      generation: this.primaryGeneration,
      restartResumesChats: agentHostSupports(health, "continuationRevival"),
      retiringHosts: [...this.retiring.values()]
        .sort((a, b) => a.generation - b.generation)
        .map((host) => this.retiringStatus(host))
    };
    if (!this.pendingVersionRestart || health === null) return base;
    const blockers = restartBlockers(health, this.daemonBackgroundWork(), this.pendingWakeThreads(health));
    return {
      ...base,
      pendingRestart: {
        reason: this.staleReason(health),
        since: this.pendingRestartSince === null ? null : new Date(this.pendingRestartSince).toISOString(),
        deferredBy: this.lastDrainDeferral,
        blockers,
        restartsAt: isoOrNull(this.graceDeadline(health))
      }
    };
  }

  /** True only when the host can take work right now. */
  isHealthy(): boolean {
    return this.state === "healthy";
  }

  /**
   * True when the ADOPTED host advertises `capability` at `level` or above
   * (`AgentHostHealthResponse.capabilities`). False with no host, and for a host
   * that predates the capability — including the old host a deploy's
   * drain-restart is still waiting on, until the new one is adopted.
   */
  hostSupports(capability: keyof AgentHostCapabilities, level = 1): boolean {
    return this.state === "healthy" && agentHostSupports(this.health, capability, level);
  }

  /**
   * Pids the `/api/system/processes/kill` guard must refuse (§3.1 "Kill
   * guard"). With tmux the host lives in the `orqsvc-` service session the
   * guard already excludes; without it the host is a plain daemon child and
   * would otherwise be a legal target. **Provider children stay legal targets**
   * — only the host itself is protected.
   */
  protectedPids(): number[] {
    // Every host (P2.4 R28): the primary and each retiring one.
    const pids: number[] = [];
    const add = (pid: unknown): void => {
      if (typeof pid === "number" && pid > 0 && !pids.includes(pid)) pids.push(pid);
    };
    add(this.directHandle?.pid);
    add(this.health?.pid);
    for (const [generation, handle] of this.directHandles) {
      if (generation !== this.primaryGeneration) add(handle.pid);
    }
    for (const host of this.retiring.values()) add(host.health?.pid);
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
  init(options: { updateAfterBoot?: boolean } = {}): Promise<void> {
    return this.transition(async () => {
      this.supervising = true;
      this.updateAfterBoot = options.updateAfterBoot === true;
      try {
        await this.boot();
      } finally {
        this.updateAfterBoot = false;
      }
    });
  }

  /**
   * Set during an {@link init} asked to `updateAfterBoot`: a stale host found by the boot is updated
   * as the NEXT queued step instead of inside the boot, so `init()` returns with the old host
   * adopted and serving and the daemon's transports listen at once rather than after the
   * replacement is up (6–9 s on a VPS). The update is the same {@link restartIfDrained} the health
   * tick runs; a chat request in its gap is answered HOST_UNAVAILABLE, which clients retry.
   */
  private updateAfterBoot = false;

  /** The boot's update of a stale host: now, or queued right after the boot (see {@link updateAfterBoot}). */
  private async updateStaleHostAtBoot(): Promise<void> {
    if (!this.updateAfterBoot) {
      await this.restartIfDrained();
      return;
    }
    this.transition(async () => {
      if (this.supervising) await this.restartIfDrained();
    }).catch((error) => this.log("error", "agent host update failed", error));
  }

  /**
   * Host updates (spec 2026-11-01 P2.4 R29): a registry names the hosts a previous daemon left
   * running; without one, the single-host boot is unchanged. A registry that exists but cannot be
   * read, or names hosts this daemon cannot parse, is completed from the live hosts' own `/health`
   * first; while a live host cannot be accounted for, nothing boots (I1) and this is tried again
   * on every health tick.
   */
  private async boot(): Promise<void> {
    const loaded = await this.loadRegistry();
    let registry = loaded.registry;
    if (loaded.problem) {
      const accounted = await this.accountForLiveHosts(registry);
      if (typeof accounted === "string") {
        if (this.bootBlocked !== accounted) {
          this.log(
            "error",
            `agent host boot blocked: ${accounted}; no host is started that could own the chats it runs`
          );
        }
        this.bootBlocked = accounted;
        this.setState("error", accounted);
        return;
      }
      registry = accounted;
    }
    if (this.bootBlocked !== null) {
      this.log("log", "every live agent host is accounted for; booting");
      this.bootBlocked = null;
    }
    if (registry !== null) {
      this.registryInUse = true;
      this.registryKept = registry;
      this.highestGeneration = Math.max(this.highestGeneration, highestRecordedGeneration(registry));
      await this.bootFromRegistry(registry);
      return;
    }
    await this.bootPrimary();
  }

  /** The five §3.1 cases, for the primary's generation. */
  private async bootPrimary(): Promise<void> {
    this.token = await this.readToken(this.primaryGeneration);
    const probed = this.token ? await this.safeProbe() : ({ ok: false, reachable: false } as ProbeOutcome);

    if (probed.ok) {
      this.adopt(probed.health);
      this.log("log", `agent host adopted: ${describeHost(probed.health)}`);
      if (this.isStale(probed.health)) {
        // Case 3. Adopt now — every in-flight turn keeps running — and hand
        // over as soon as no thread has an active turn or live background
        // work (a subagent fleet, a background shell).
        this.pendingVersionRestart = true;
        this.log("warn", `${this.staleReason(probed.health)}; restarting once drained`);
        this.emit();
        await this.updateStaleHostAtBoot();
      }
      return;
    }

    if (probed.ok === false && probed.reachable && probed.rejected) {
      // Case 4 — unless it is demonstrably OURS: a host inside our own tmux
      // service session with a token we can no longer produce (the token file
      // was lost). Ownership is verified by the session name, which a foreign
      // process cannot be in, so restarting it is not "killing a stranger".
      // A tmux that cannot tell: not demonstrably ours, so never killed.
      const owned =
        (await this.opts.adapters.tmux
          ?.hasServiceSession(agentHostServiceSession(this.primaryGeneration))
          .catch(() => false)) ?? false;
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
    const leftover =
      (await this.opts.adapters.tmux
        ?.hasServiceSession(agentHostServiceSession(this.primaryGeneration))
        // A tmux that cannot tell: kill first, as for a leftover.
        .catch(() => true)) ?? false;
    if (await this.spawnAndWait(leftover || (probed.ok === false && probed.reachable)) && this.health !== null) {
      this.log("log", `agent host spawned: ${describeHost(this.health)}`);
    }
  }

  /**
   * Runtime supervision, driven by the daemon's 15 s unref'd interval
   * (the host-protocol health interval).
   */
  checkHealth(): Promise<void> {
    // The retiring-host poll keeps itself going; a tick restarts it if anything stopped it.
    this.scheduleRetiringPoll();
    return this.transition(async () => {
      if (!this.supervising) return;
      if (this.bootBlocked !== null) {
        await this.boot();
        return;
      }
      if (this.unstoppable.size > 0) {
        await this.retryUnstoppable(false);
        // A failed update still waits on its replacement's exit: the old host keeps what it kept,
        // and nothing else is decided (the old primary is retired, not adoptable as primary).
        if (this.switchKeeps !== null) return;
      }
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
      if (this.missedProbes === 0) this.firstMissAt = this.opts.adapters.now();
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

      // A host that is alive but starved of CPU answers late, not never; a
      // restart would only boot its replacement into the same contention.
      const load = this.loadPerCpu();
      if (
        load >= SATURATED_LOAD_PER_CPU &&
        this.opts.adapters.now() - this.firstMissAt < STARVED_HOST_PATIENCE_MS &&
        (await this.hostProcessAlive())
      ) {
        this.log(
          "warn",
          `agent host did not answer (${this.missedProbes}/${required}), but its process is alive and the system is saturated (load ${load.toFixed(1)} per CPU); not restarting a starved host`
        );
        return;
      }

      if (this.opts.adapters.now() < this.nextRespawnAt) return; // still backing off
      this.respawnAttempts++;
      this.log(
        "warn",
        `agent host did not answer (${this.missedProbes}/${required}); restarting it (attempt ${this.respawnAttempts}/${MAX_RESPAWNS})`
      );
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
   *
   * Host updates (spec 2026-11-01 P2.4 R30): with hosts retiring, it ends each of them at once,
   * as the retirement cap would (their `/stop` marks what they cut; the primary adopts and
   * continues it), and restarts the primary only when it is stale or not healthy — first, so
   * the threads it adopts land on the new one.
   */
  restartNow(): Promise<string | null> {
    return this.transition(async () => {
      // A host that could not be stopped is tried again first; while one is, nothing restarts (I1).
      if (this.unstoppable.size > 0) await this.retryUnstoppable(true);
      if (this.switchKeeps !== null) return null;
      const retiring = [...this.retiring.values()];
      if (retiring.length === 0 || this.state !== "healthy" || (this.health !== null && this.isStale(this.health))) {
        await this.drainAndRestart();
      }
      for (const host of retiring) {
        if (host.killUnconfirmedSince !== null) await this.forgetRetiringHost(host);
        else await this.endRetiringHost(host, "restart");
      }
      return this.health?.hostInstanceId ?? null;
    });
  }

  /**
   * Re-evaluate the drain window (§3.1 case 3). Called when a turn settles —
   * and when a thread's background work ends — so a deploy's version handover
   * happens the moment the host goes quiet rather than on the next 15 s tick.
   * Still blocked, it renews the agent goals §5.7 hold instead.
   */
  handleTurnSettled(threadId?: string): void {
    // A turn that settled after the thread's background work ended was the
    // wake an older host could not report: that thread waits no longer.
    if (threadId !== undefined) this.backgroundEndedAt.delete(threadId);
    this.evaluateDrainSoon();
  }

  /**
   * A thread's background work ended (the daemon's summary poll). It reopens
   * the drain window as a settled turn does — but for a host that cannot
   * report a pending wake, that thread first gets {@link BACKGROUND_END_GRACE_MS}
   * for the provider to start the turn that hands the agent its result.
   */
  handleBackgroundWorkEnded(threadId?: string): void {
    if (threadId !== undefined) this.backgroundEndedAt.set(threadId, this.opts.adapters.now());
    this.evaluateDrainSoon();
  }

  private evaluateDrainSoon(): void {
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
    this.halted = true;
    this.listeners.clear();
    this.clearGraceTimer();
    this.cancelRetiringPoll?.();
    this.cancelRetiringPoll = null;
    if (!this.opts.adapters.tmux) {
      // Every host is a direct child here (P2.2), retiring ones too.
      for (const handle of this.directHandles.values()) {
        try {
          handle.kill();
        } catch {
          /* already gone */
        }
      }
      this.directHandles.clear();
    }
  }

  // --- internals -----------------------------------------------------------

  private hostPid(): number | null {
    return this.directHandle?.pid ?? this.health?.pid ?? null;
  }

  /** {@link SupervisorAdapters.loadPerCpu}; a failing or absent reader reads as idle. */
  private loadPerCpu(): number {
    try {
      const load = this.opts.adapters.loadPerCpu?.() ?? 0;
      return Number.isFinite(load) ? load : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Whether our host's process still exists: its tmux service session (which
   * ends with its command), or the direct child. A host adopted from outside
   * our session reads as not alive, so it is restarted as before. A tmux that cannot tell reads
   * as alive: a death is never assumed (I1).
   */
  private async hostProcessAlive(generation = this.primaryGeneration): Promise<boolean> {
    const tmux = this.opts.adapters.tmux;
    if (tmux) {
      return tmux.hasServiceSession(agentHostServiceSession(generation)).catch(() => true);
    }
    return this.directHandles.get(generation)?.isAlive?.() === true;
  }

  /**
   * The daemon-side liveness view (`null` = not known yet); a failing reader
   * never blocks supervision, and no reader at all means "none". Only the
   * primary's threads: the summary merges every host's (P2.4 R25), and work on a
   * thread a retiring host owns neither holds the primary's drain nor is cut by
   * its restart.
   */
  private daemonBackgroundWork(): readonly string[] | null {
    const read = this.opts.adapters.backgroundWorkThreadIds;
    if (!read) return [];
    let view: readonly string[] | null;
    try {
      view = read();
    } catch {
      return [];
    }
    if (view === null || (this.retiring.size === 0 && this.switchKeeps === null)) return view;
    return view.filter((threadId) => this.retiringOwnerOf(threadId) === null && !this.switchKeeps?.threadIds.has(threadId));
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
    // I1: no replacement may start while a host that could not be stopped may own chats.
    if (this.unstoppable.size > 0) return;
    const probed = await this.safeProbe();
    if (!probed.ok) return; // not healthy right now — the health tick owns it
    this.adopt(probed.health);
    if (this.isStale(probed.health)) {
      this.pendingVersionRestart = true; // `adopt` clears it only on a match
    }
    if (!this.pendingVersionRestart) return;
    const daemonView = this.daemonBackgroundWork();
    this.observeBackgroundEnds(probed.health, daemonView);
    const blockers = drainBlockers(probed.health, daemonView, this.pendingWakeThreads(probed.health));
    if (blockers !== null) {
      // Host updates (spec 2026-11-01 P2.4 R23): a host that can retire keeps its working chats
      // while a new host on this checkout's code takes everything else — nothing is waited on or
      // interrupted. Phase 1 below is the fallback (P2.6).
      if (this.phase2Available(probed.health)) {
        const outcome = await this.retireAndSwitch(probed.health, blockers);
        if (outcome === "switched" || outcome === "blocked") return;
        if (outcome === "drained" || outcome === "restart") {
          this.lastDrainDeferral = null;
          // "restart": the old host stays retired (its unretire failed) — never left as the
          // primary; its /stop marks what it keeps for continuation, and a new host takes all.
          await this.drainAndRestart(outcome === "restart");
          return;
        }
      }
      // Once per change of reason, not once per 15 s tick.
      if (blockers !== this.lastDrainDeferral) {
        this.lastDrainDeferral = blockers;
        this.log("log", `agent host restart deferred: ${blockers}`);
      }
      this.warnIfRestartLongPending(blockers);
      // Spec 2026-11-01 P1.4 R12/R13: a host that resumes what a restart cuts waits for the
      // drain only for the update grace, then restarts through the same `/stop`, which marks
      // every working chat for continuation. One that cannot keeps waiting without limit.
      const deadline = this.graceDeadline(probed.health);
      if (deadline !== null) {
        if (this.opts.adapters.now() >= deadline) {
          this.log(
            "warn",
            `agent host update grace (${Math.round(AGENT_HOST_UPDATE_GRACE_MS / 60_000)} min) is over: restarting it under ${blockers}; working chats are resumed on the new host`
          );
          this.lastDrainDeferral = null;
          await this.drainAndRestart();
          return;
        }
        this.armGraceTimer(deadline);
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
   * Threads whose provider is about to wake the agent for a finished
   * background task, so a restart now would lose its result: what the host
   * reports (`pendingWakes`), each for at most the cap; for a host from before
   * that field, every thread whose background work ended within the grace and
   * no turn of which settled since.
   */
  private pendingWakeThreads(health: AgentHostHealthResponse): string[] {
    const now = this.opts.adapters.now();
    if (health.pendingWakes !== undefined) {
      const cap = this.opts.pendingWakeCapMs ?? PENDING_WAKE_DRAIN_CAP_MS;
      return [
        ...new Set(
          health.pendingWakes
            .filter((wake) => {
              const since = Date.parse(wake.since);
              return Number.isFinite(since) && now - since < cap;
            })
            .map((wake) => wake.threadId)
        )
      ];
    }
    const grace = this.opts.backgroundEndGraceMs ?? BACKGROUND_END_GRACE_MS;
    const waiting: string[] = [];
    for (const [threadId, endedAt] of this.backgroundEndedAt) {
      if (now - endedAt < grace) waiting.push(threadId);
      else this.backgroundEndedAt.delete(threadId);
    }
    return waiting;
  }

  /**
   * An end of background work seen between two fresh probes — the summary
   * poll may not have reported it ({@link handleBackgroundWorkEnded}) — starts
   * the older host's grace too; work seen running again ends it.
   */
  private observeBackgroundEnds(health: AgentHostHealthResponse, daemonView: readonly string[] | null): void {
    const now = new Set(backgroundWorkThreadIds(health, daemonView));
    for (const threadId of this.lastBackgroundThreads) {
      if (!now.has(threadId) && !this.backgroundEndedAt.has(threadId)) {
        this.backgroundEndedAt.set(threadId, this.opts.adapters.now());
      }
    }
    for (const threadId of now) this.backgroundEndedAt.delete(threadId);
    this.lastBackgroundThreads = now;
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
    if (this.pendingWakeThreads(health).length > 0) return;
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
  private async drainAndRestart(stopRetired = false): Promise<void> {
    this.clearGraceTimer();
    if (this.unstoppable.size > 0) {
      // I1: its replacement could not be started (`spawnAndWait`), so the host is not stopped.
      this.log("error", `agent host restart deferred: ${this.unstoppableReason()}`);
      return;
    }
    if (this.state === "healthy" || stopRetired) {
      try {
        await this.opts.adapters.requestStop(this.primaryGeneration);
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
    const previousCode = this.health?.codeStamp ?? null;
    this.pendingVersionRestart = false;
    this.pendingRestartSince = null;
    const ready = await this.spawnAndWait(true);
    if (!ready) {
      this.setState("error", "replacement agent host never reached readiness");
      this.log("error", "agent host restart did not switch: the replacement never became ready");
      return;
    }
    if (this.health !== null) {
      this.log(
        "log",
        `agent host restarted: code ${shortStamp(previousCode)} → ${shortStamp(this.health.codeStamp)}, instance ${this.health.hostInstanceId}, pid ${this.health.pid}`
      );
    }
    await this.resumeLegacyGoalSessions();
  }

  /**
   * Poll until the old host is GONE — its process has exited and its socket
   * no longer answers — bounded by {@link HOST_EXIT_GRACE_MS}. Returns true
   * when it is gone.
   */
  private async awaitHostExit(generation = this.primaryGeneration, graceMs = HOST_EXIT_GRACE_MS): Promise<boolean> {
    const deadline = this.opts.adapters.now() + graceMs;
    for (;;) {
      if (await this.hostGone(generation)) return true;
      if (this.opts.adapters.now() >= deadline) {
        if (graceMs === HOST_EXIT_GRACE_MS) this.log("warn", "agent host did not exit within the drain grace; killing it");
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
  private async hostGone(generation: number): Promise<boolean> {
    const tmux = this.opts.adapters.tmux;
    if (tmux) {
      const sessionAlive = await tmux
        .hasServiceSession(agentHostServiceSession(generation))
        // tmux itself failing to answer: not known to be gone (I1).
        .catch(() => true);
      if (sessionAlive) return false;
    } else if (this.directHandles.get(generation)?.isAlive?.() === true) {
      return false;
    }
    return !(await this.safeProbe(generation)).ok;
  }

  /**
   * Regenerate the token (only ever after the previous host is gone — §3.1's
   * "regenerated only when no host is alive"), spawn, and poll READINESS — not
   * the socket.
   */
  private async spawnAndWait(killFirst: boolean): Promise<boolean> {
    if (this.unstoppable.size > 0) {
      // I1: the new host would own every chat that one may still be writing.
      const reason = this.unstoppableReason()!;
      this.setState("error", reason);
      this.log("error", `${reason}; not starting an agent host until it is`);
      return false;
    }
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
      // I5 (spec 2026-11-01 P2.5): the registry names this host before it exists.
      if (!(await this.persistRegistry())) throw new Error("the agent host registry could not be written");
      // The token is regenerated AFTER the kill, immediately before the new
      // session: §3.1 says "regenerated only when no host is alive", and
      // rewriting it while the old host still answers would leave the daemon
      // unable to authenticate to the host it is waiting on.
      await this.spawn(this.primaryGeneration, killFirst);
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

  /**
   * Start host `generation`: its own tmux service session (or direct child), socket and token
   * (spec 2026-11-01 P2.2), regenerating the token after the kill. With hosts retiring, it boots
   * with a foreign-threads file naming every thread they own (I3), so it never touches one.
   */
  private async spawn(generation: number, killFirst: boolean): Promise<void> {
    const args = [
      "--import",
      "tsx",
      AGENT_HOST_MAIN,
      "--appdir",
      this.opts.appdir
    ];
    const tmux = this.opts.adapters.tmux;
    if (tmux) {
      if (killFirst) {
        await tmux.killServiceSession(agentHostServiceSession(generation)).catch(() => undefined);
      }
    } else {
      // No-tmux hosts (Windows, stock macOS dev): a direct child that dies with
      // the daemon (§3.1). The §3.3 reconcile recovers on the next boot.
      this.directHandles.get(generation)?.kill();
      this.directHandles.delete(generation);
    }
    this.tokens.set(generation, await this.regenerateToken(generation));
    const env = await this.hostEnv(generation);
    if (tmux) {
      await tmux.newServiceSession({
        name: agentHostServiceSession(generation),
        cwd: this.opts.cwd,
        env,
        bin: this.opts.nodeBin,
        args
      });
      return;
    }
    this.directHandles.set(generation, this.opts.adapters.spawnDirect(this.opts.nodeBin, args, env));
  }

  /**
   * The launch environment of host `generation` (§8, P2.3 R15): the daemon's explicit one, with
   * this generation's socket, token file and number, and — while other hosts own threads — the
   * foreign-threads file, written here. Generation 0 alone, as before generations, names none.
   */
  private async hostEnv(generation: number): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      ...this.opts.env,
      [AGENT_HOST_ENV.tokenPath]: this.tokenPathOf(generation),
      [AGENT_HOST_ENV.generation]: String(generation)
    };
    if (generation !== 0) env[AGENT_HOST_ENV.socket] = this.socketPathOf(generation);
    const foreign = new Set<string>();
    for (const host of this.retiring.values()) {
      if (host.generation !== generation) for (const threadId of host.owned) foreign.add(threadId);
    }
    const keeps = this.switchKeeps;
    if (keeps !== null && keeps.generation !== generation) for (const threadId of keeps.threadIds) foreign.add(threadId);
    // A thread whose adoption is pending reaches the new host through `/adopt` (which sweeps what
    // its previous host left running), not through its boot reconcile.
    for (const threadId of this.pendingAdoptionIds) foreign.add(threadId);
    if (this.retiring.size > 0 || keeps !== null || generation !== 0 || foreign.size > 0) {
      const path = agentHostForeignThreadsPath(this.opts.appdir, generation);
      await writeForeignThreads(path, foreign);
      env[AGENT_HOST_ENV.foreignThreads] = path;
    }
    return env;
  }

  /**
   * Poll until the host answers `/health` (which it does only once its command
   * gate is open) or the prepared deadline lapses. A bare probe right after a
   * spawn races the bind, so every spawn→verdict path must come through here.
   */
  private async probeUntilReady(generation = this.primaryGeneration): Promise<ProbeOutcome> {
    const deadline =
      this.opts.adapters.now() + AGENT_HOST_PREPARED_TIMEOUT_MS;
    let last: ProbeOutcome = { ok: false, reachable: false };
    for (;;) {
      last = await this.safeProbe(generation);
      if (last.ok) return last;
      // A token rejection cannot resolve itself by waiting.
      if (last.ok === false && last.reachable && last.rejected) return last;
      if (this.opts.adapters.now() >= deadline) return last;
      await this.opts.adapters.sleep(SPAWN_PROBE_INTERVAL_MS);
    }
  }

  private async safeProbe(generation = this.primaryGeneration): Promise<ProbeOutcome> {
    try {
      return await this.opts.adapters.probe(generation);
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
      this.pendingRestartSince = null;
      this.clearGraceTimer();
    }
    this.setState("healthy", null);
  }

  /**
   * Spec 2026-11-01 P1.4 R12/R13: when a pending restart of `health`'s host goes ahead although
   * the host has not drained — {@link AGENT_HOST_UPDATE_GRACE_MS} after the restart was first
   * deferred. Null before that, and for a host without `continuationRevival`: its `/stop` would
   * leave the chats it cut stopped, so it is never forced.
   */
  private graceDeadline(health: AgentHostHealthResponse | null): number | null {
    if (this.pendingRestartSince === null || !agentHostSupports(health, "continuationRevival")) return null;
    return this.pendingRestartSince + AGENT_HOST_UPDATE_GRACE_MS;
  }

  /** One timer at a time re-evaluates the drain at the grace deadline, without a health tick. */
  private armGraceTimer(deadline: number): void {
    if (this.cancelGraceTimer !== null) return;
    this.cancelGraceTimer = this.setTimer(Math.max(0, deadline - this.opts.adapters.now()), () => {
      this.cancelGraceTimer = null;
      this.evaluateDrainSoon();
    });
  }

  private clearGraceTimer(): void {
    this.cancelGraceTimer?.();
    this.cancelGraceTimer = null;
  }

  private setTimer(ms: number, fn: () => void): () => void {
    const own = this.opts.adapters.setTimer;
    if (own) return own(ms, fn);
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  }

  /**
   * A drain-restart deferred for {@link RESTART_PENDING_WARN_MS} or longer is
   * worth a warning — the host keeps running old code for as long as it waits
   * — once per that interval, never per 15 s tick. The clock starts at the
   * first deferred evaluation and stops when the restart happens or is no
   * longer needed.
   */
  private warnIfRestartLongPending(blockers: string): void {
    const now = this.opts.adapters.now();
    if (this.pendingRestartSince === null) {
      this.pendingRestartSince = now;
      this.lastPendingWarnAt = null;
      return;
    }
    const pendingMs = now - this.pendingRestartSince;
    if (pendingMs < RESTART_PENDING_WARN_MS) return;
    if (this.lastPendingWarnAt !== null && now - this.lastPendingWarnAt < RESTART_PENDING_WARN_MS) return;
    this.lastPendingWarnAt = now;
    this.log("warn", `agent host restart pending for ${Math.floor(pendingMs / 3_600_000)} h: ${blockers}`);
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

  private async readToken(generation: number): Promise<string | null> {
    try {
      const raw = (await readFile(this.tokenPathOf(generation), "utf8")).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /** 0600, written atomically. Only ever called when no host of `generation` is alive (§3.1). */
  private async regenerateToken(generation: number): Promise<string> {
    const path = this.tokenPathOf(generation);
    const token = randomBytes(32).toString("base64url");
    const tmp = `${path}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    return token;
  }

  // --- host updates (spec 2026-11-01 Phase 2) --------------------------------
  //
  // State: one primary (`primaryGeneration` and the fields above) and up to MAX_RETIRING_HOSTS
  // retiring hosts (`retiring`). An update moves the primary through `switching` (retire →
  // spawn the next generation → promote, or unretire on failure); each retiring host is polled
  // until it owns nothing (exit), dies (adopt what it owned), or reaches the cap (stop, adopt).
  // Every thread a retiring host stops owning is adopted by the primary before any request for
  // it reaches the primary (`adoptions`, `hostForThread`).

  private tokenPathOf(generation: number): string {
    return generation === 0 ? this.opts.tokenPath : agentHostTokenPath(this.opts.appdir, generation);
  }

  private socketPathOf(generation: number): string {
    const legacy = this.opts.env[AGENT_HOST_ENV.socket];
    if (generation === 0 && typeof legacy === "string" && legacy !== "") return legacy;
    return agentHostSocketPath(this.opts.appdir, this.opts.platform ?? process.platform, generation);
  }

  /** One stable endpoint object per generation and role. */
  private endpoint(generation: number, role: HostRole): HostEndpoint {
    const key = `${generation}:${role}`;
    let endpoint = this.endpoints.get(key);
    if (endpoint === undefined) {
      endpoint = { generation, role, client: this.clientFor(generation) };
      this.endpoints.set(key, endpoint);
    }
    return endpoint;
  }

  /** The retiring host that still owns `threadId` as last seen, or null. */
  private retiringOwnerOf(threadId: string): number | null {
    for (const host of this.retiring.values()) {
      if (host.owned.has(threadId)) return host.generation;
    }
    return null;
  }

  /** True once `pending` settles within `ms`; false when the time ran out first. */
  private settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const cancel = this.setTimer(ms, () => {
        if (done) return;
        done = true;
        resolve(false);
      });
      void pending.then(
        () => undefined,
        () => undefined
      ).then(() => {
        if (done) return;
        done = true;
        cancel();
        resolve(true);
      });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimer(ms, resolve);
    });
  }

  /** P2.6: whether a busy stale primary can retire instead of waiting for its drain. */
  private phase2Available(health: AgentHostHealthResponse): boolean {
    return (
      this.opts.adapters.requestRetire !== undefined &&
      agentHostSupports(health, "retire") &&
      // A protocol change is still a hard restart: the daemon cannot route to both versions.
      health.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
      this.phase2RefusedInstance !== health.hostInstanceId &&
      // I1/I3: a foreign file cannot list what a host that could not be stopped owns.
      this.unstoppable.size === 0
    );
  }

  private nextGeneration(): number {
    this.highestGeneration = Math.max(this.highestGeneration, this.primaryGeneration, ...this.retiring.keys()) + 1;
    return this.highestGeneration;
  }

  /**
   * P2.4 R23, the update flow. The busy stale primary retires (keeping K, its working threads),
   * the next generation starts with a foreign file naming every thread a retiring host keeps
   * (I3), and becomes the primary; on any failure the new host is killed, the old one unretired
   * and the registry restored, and the caller falls back to Phase 1. While it runs, `primary()`
   * is null and requests for threads outside K wait for it (`hostForThread`).
   *
   * `restart`: the old host could not be unretired, so it is never left as a retiring primary —
   * the caller restarts it (Phase 1, its `/stop` marks what it keeps). `blocked`: the new host's
   * kill could not be confirmed (I1), so the old one keeps K and takes nothing back until it is
   * ({@link retryUnstoppable}).
   */
  private async retireAndSwitch(
    health: AgentHostHealthResponse,
    blockers: string
  ): Promise<"switched" | "drained" | "unavailable" | "restart" | "blocked"> {
    const requestRetire = this.opts.adapters.requestRetire;
    if (!requestRetire) return "unavailable";
    const oldGeneration = this.primaryGeneration;
    // P2.2: room for one more — the oldest retiring host is ended through the cap path first.
    while (this.retiring.size >= MAX_RETIRING_HOSTS) {
      const oldest = [...this.retiring.values()]
        .filter((host) => !host.ending)
        .sort((a, b) => a.retiringSince - b.retiringSince)[0];
      // Every one is already being ended (a kill not confirmed): no room now; Phase 1 meanwhile.
      if (oldest === undefined) return "unavailable";
      await this.endRetiringHost(oldest, "limit");
      // …or this one's exit could not be confirmed: its chats stay there, and so does it.
      if (this.retiring.get(oldest.generation) === oldest) return "unavailable";
    }
    this.switching = new Promise<void>((resolve) => {
      this.switchDone = resolve;
    });
    let answered: () => void = () => undefined;
    this.retireAnswer = {
      promise: new Promise<void>((resolve) => {
        answered = resolve;
      }),
      resolve: () => answered()
    };
    this.setState("starting", "updating the agent host");
    try {
      // I2: an adoption already sent to this host lands (or fails) before it decides what it keeps.
      await Promise.allSettled([...this.adoptRequests]);
      let keep: readonly string[] | null;
      try {
        keep = await requestRetire(oldGeneration);
      } catch (error) {
        // A retire that landed but whose answer was lost is undone, so the host serves again.
        if (!(await this.unretire(oldGeneration))) return this.switchRestarts(health, "its /retire failed and it could not be unretired");
        return this.switchFellBack(health, "its /retire failed", error);
      }
      if (keep === null) return this.switchFellBack(health, "it predates /retire");
      if (keep.length === 0) {
        // Nothing runs any more: today's restart.
        this.endSwitch();
        this.setState("healthy", null);
        return "drained";
      }
      const generation = this.nextGeneration();
      this.switchKeeps = {
        generation: oldGeneration,
        threadIds: new Set(keep),
        since: this.opts.adapters.now(),
        starting: generation
      };
      // Requests for K that waited on the switch go to the old host now (`hostForThread`).
      this.settleRetireAnswer();
      // I1/I4: an adoption of a kept thread still waiting (in backoff) must never reach the new
      // primary while the old host runs it; its release starts a fresh one.
      for (const threadId of keep) this.cancelAdoption(threadId);
      this.log(
        "log",
        `agent host update: generation ${oldGeneration} retires keeping ${keep.length} working chat(s) (${blockers}); starting generation ${generation}`
      );
      // I5: the registry names both before the spawn.
      this.registryInUse = true;
      let ready: ProbeOutcome = { ok: false, reachable: false };
      let failure: unknown;
      if (await this.persistRegistry()) {
        try {
          await this.spawn(generation, true);
          ready = await this.probeUntilReady(generation);
        } catch (error) {
          failure = error;
        }
      } else {
        failure = new Error("the agent host registry could not be written");
      }
      if (!ready.ok) {
        const why = `generation ${generation} never became ready`;
        // I1: the new host may have booted far enough to own every chat the old one released;
        // the old one takes them back only once it is confirmed gone.
        if (!(await this.killHost(generation))) {
          const reason = `agent host generation ${generation}, started by an update that failed, could not be confirmed stopped`;
          const now = this.opts.adapters.now();
          this.unstoppable.set(generation, {
            reason,
            nextKillAt: now + HOST_KILL_RETRY_MS,
            onGone: async () => {
              const outcome = await this.undoSwitch(health, oldGeneration, generation, why, failure);
              if (outcome === "restart") await this.drainAndRestart(true);
            }
          });
          // The old host keeps serving K (`switchKeeps`); everything else waits for the kill.
          this.endSwitch(true);
          this.setState("error", `${reason}; chats outside the update are unavailable until it is`);
          return "blocked";
        }
        return await this.undoSwitch(health, oldGeneration, generation, why, failure);
      }
      // Promote. The old primary keeps K until each is idle; the new one serves everything else.
      this.addRetiringHost(oldGeneration, health, new Set(keep), this.switchKeeps.since);
      this.primaryGeneration = generation;
      this.health = null;
      this.lastDrainDeferral = null;
      this.goalHold = null;
      this.backgroundEndedAt.clear();
      this.lastBackgroundThreads = new Set();
      this.endSwitch();
      this.adopt(ready.health);
      // I5: persisted right after the promotion.
      await this.persistRegistry();
      this.log(
        "log",
        `agent host updated: generation ${generation} (${describeHost(ready.health)}) is primary; generation ${oldGeneration} finishes ${keep.length} chat(s)`
      );
      this.scheduleRetiringPoll();
      return "switched";
    } finally {
      if (this.switching !== null) this.endSwitch();
    }
  }

  /** Settle the switch (`switching`), keeping what the old primary keeps only when asked. */
  private endSwitch(keepKeeps = false): void {
    this.switching = null;
    if (!keepKeeps) this.switchKeeps = null;
    const done = this.switchDone;
    this.switchDone = null;
    done?.();
    this.settleRetireAnswer();
  }

  private settleRetireAnswer(): void {
    const answer = this.retireAnswer;
    this.retireAnswer = null;
    answer?.resolve();
  }

  /**
   * A failed update's replacement is confirmed gone: drop its files, give the old host back what
   * it released (P2.3 R21) and fall back to Phase 1 — or, when it cannot be unretired, restart it.
   */
  private async undoSwitch(
    health: AgentHostHealthResponse,
    oldGeneration: number,
    generation: number,
    why: string,
    failure: unknown
  ): Promise<"unavailable" | "restart"> {
    await this.removeHostFiles(generation);
    this.switchKeeps = null;
    const unretired = await this.unretire(oldGeneration);
    await this.persistRegistry();
    if (!unretired) return this.switchRestarts(health, `${why}, and the old host could not be unretired`);
    return this.switchFellBack(health, why, failure);
  }

  /** The update did not happen and the old host serves everything again: Phase 1 for it (P2.6). */
  private switchFellBack(health: AgentHostHealthResponse, why: string, error?: unknown): "unavailable" {
    this.log(
      "warn",
      `agent host update could not retire the old host (${why}); restarting it once drained instead`,
      ...(error === undefined ? [] : [error])
    );
    this.phase2RefusedInstance = health.hostInstanceId;
    this.endSwitch();
    this.setState("healthy", null);
    return "unavailable";
  }

  /** The old host stays retired: it is never reported as a healthy primary; the caller restarts it. */
  private switchRestarts(health: AgentHostHealthResponse, why: string): "restart" {
    this.log("error", `agent host update failed (${why}); restarting the agent host — working chats are resumed on the new one`);
    this.phase2RefusedInstance = health.hostInstanceId;
    this.endSwitch();
    return "restart";
  }

  /** P2.3 R21, retried a few times. False when the host still refuses (or cannot be reached). */
  private async unretire(generation: number): Promise<boolean> {
    const request = this.opts.adapters.requestUnretire;
    if (!request) return true;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await request(generation);
        return true;
      } catch (error) {
        this.log("warn", `agent host ${generation} could not be unretired (attempt ${attempt}/${UNRETIRE_ATTEMPTS})`, error);
        if (attempt >= UNRETIRE_ATTEMPTS) return false;
      }
      await this.opts.adapters.sleep(UNRETIRE_RETRY_MS);
    }
  }

  /**
   * I1: kill each host whose kill could not be confirmed again — when due, or at once when
   * `now` — and run what its confirmed death unblocks. Once none is left and no primary serves,
   * the primary boots as on a fresh start.
   */
  private async retryUnstoppable(now: boolean): Promise<void> {
    for (const [generation, host] of [...this.unstoppable]) {
      if (!now && this.opts.adapters.now() < host.nextKillAt) continue;
      if (!(await this.killHost(generation))) {
        host.nextKillAt = this.opts.adapters.now() + HOST_KILL_RETRY_MS;
        continue;
      }
      this.unstoppable.delete(generation);
      this.log("log", `agent host ${generation} is confirmed stopped`);
      if (host.onGone) await host.onGone();
      else await this.removeHostFiles(generation);
    }
    if (this.unstoppable.size === 0 && this.switchKeeps === null && this.state !== "healthy") {
      await this.bootPrimary();
    }
  }

  /** Why nothing may be spawned (I1), or null. */
  private unstoppableReason(): string | null {
    const reasons = [...this.unstoppable.values()].map((host) => host.reason);
    return reasons.length === 0 ? null : reasons.join("; ");
  }

  /** Poll every retiring host each {@link RETIRING_HOST_POLL_MS} while there is one. */
  private scheduleRetiringPoll(): void {
    if (this.halted || !this.supervising || this.cancelRetiringPoll !== null || this.retiring.size === 0) return;
    this.cancelRetiringPoll = this.setTimer(RETIRING_HOST_POLL_MS, () => {
      // Held while the poll runs, so a health tick cannot start a second loop.
      this.cancelRetiringPoll = () => undefined;
      this.transition(() => this.pollRetiringHosts())
        .catch((error) => this.log("error", "retiring agent host poll failed", error))
        .finally(() => {
          this.cancelRetiringPoll = null;
          this.scheduleRetiringPoll();
        });
    });
  }

  /**
   * One round over the retiring hosts (R26–R28, R30): adopt what each released, end one that
   * owns nothing or reached the cap, and take over the threads of one that died.
   */
  private async pollRetiringHosts(): Promise<void> {
    for (const host of [...this.retiring.values()]) {
      if (host.ending) {
        // Being ended, its exit not confirmed (I1): killed again when due; its chats stay there.
        if (host.killUnconfirmedSince !== null && this.opts.adapters.now() >= host.nextKillAt) {
          await this.forgetRetiringHost(host);
        }
        continue;
      }
      const probed = await this.safeProbe(host.generation);
      const now = this.opts.adapters.now();
      if (probed.ok) {
        if (probed.health.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          // P2.6: a protocol change is a hard restart — the daemon cannot route to that host.
          await this.endRetiringHost(host, "protocol");
          continue;
        }
        await this.applyRetiringHealth(host, probed.health);
        if (host.owned.size === 0) {
          await this.endRetiringHost(host, "drained");
          continue;
        }
      } else {
        if (!(await this.hostProcessAlive(host.generation))) {
          await this.retiringHostGone(host, "its process exited");
          continue;
        }
        host.firstMissAt ??= now;
        if (now - host.firstMissAt >= RETIRING_HOST_UNRESPONSIVE_MS) {
          await this.retiringHostGone(host, `it has not answered for ${Math.round((now - host.firstMissAt) / 1000)} s`);
          continue;
        }
      }
      if (now - host.retiringSince >= AGENT_HOST_RETIRE_MAX_MS) await this.endRetiringHost(host, "cap");
    }
  }

  /** A fresh `/health` of a retiring host: every thread missing from its owned set was released. */
  private async applyRetiringHealth(host: RetiringHost, health: AgentHostHealthResponse): Promise<void> {
    host.health = health;
    host.firstMissAt = null;
    if (!Array.isArray(health.ownedThreadIds)) return;
    const owned = new Set(health.ownedThreadIds);
    const released = [...host.owned].filter((threadId) => !owned.has(threadId));
    if (released.length > 0) await this.releaseThreads(host, released);
  }

  /** Re-read every retiring host's owned set now (a 409 said ours is stale). Never throws. */
  private async refreshRetiringOwnership(): Promise<void> {
    await Promise.all(
      [...this.retiring.values()].map(async (host) => {
        if (host.ending) return;
        const probed = await this.safeProbe(host.generation);
        if (probed.ok && this.retiring.get(host.generation) === host) await this.applyRetiringHealth(host, probed.health);
      })
    );
  }

  /** R26: `host` no longer owns these: the primary adopts each. */
  private async releaseThreads(host: RetiringHost, threadIds: readonly string[]): Promise<void> {
    for (const threadId of threadIds) {
      // The owner changes and the adoption is registered in the same tick: no request routes in
      // between. In this order, so the adoption's own check sees no retiring owner.
      host.owned.delete(threadId);
      this.startAdoption(threadId);
    }
    this.log("log", `agent host ${host.generation} released ${threadIds.length} chat(s); the current host adopts them`);
    await this.persistRegistry();
  }

  /**
   * R26: adopt `threadId` on the primary, retried with backoff until it is — never dropped. It
   * stays in the registry's `pendingAdoptions` until then (I5): the caller persists the registry
   * after registering it, and its completion persists it again.
   */
  private startAdoption(threadId: string): void {
    if (this.adoptions.has(threadId) || this.opts.adapters.requestAdopt === undefined) return;
    this.pendingAdoptionIds.add(threadId);
    const token = {};
    this.adoptionTokens.set(threadId, token);
    const current = (): boolean => this.adoptionTokens.get(threadId) === token;
    const run: Promise<void> = this.adoptUntilDone(threadId, current).then(async (outcome) => {
      // A cancelled run ({@link cancelAdoption}) touches nothing: a later one may own the entries.
      if (!current()) return;
      if (outcome !== "halted") {
        this.pendingAdoptionIds.delete(threadId);
        this.adoptFailures.delete(threadId);
        await this.persistRegistry();
      }
      if (current()) {
        this.adoptions.delete(threadId);
        this.adoptionTokens.delete(threadId);
      }
    });
    this.adoptions.set(threadId, run);
  }

  /**
   * I1/I4: `threadId` belongs to a retiring host again (its `/retire` kept it): an adoption of it
   * still waiting — in backoff, say — must never reach the primary. Its entries go; a later
   * release starts a fresh one.
   */
  private cancelAdoption(threadId: string): void {
    if (!this.adoptionTokens.has(threadId)) return;
    this.adoptionTokens.delete(threadId);
    this.adoptions.delete(threadId);
    this.pendingAdoptionIds.delete(threadId);
    this.adoptFailures.delete(threadId);
  }

  /**
   * `adopted` once the primary adopted it (or had it, or it is gone); `owned` when a retiring host
   * owns it now (nothing to adopt: never sent to the primary, I1/I4); `halted` when supervision
   * stopped or the run was cancelled.
   */
  private async adoptUntilDone(threadId: string, current: () => boolean): Promise<"adopted" | "owned" | "halted"> {
    const request = this.opts.adapters.requestAdopt;
    if (!request) return "halted";
    for (let attempt = 1; !this.halted; attempt += 1) {
      const switching = this.switching;
      if (switching !== null) await switching;
      if (!current()) return "halted";
      // Checked at every attempt, as boot does: an attempt that sleeps through a switch must not
      // take a thread the old primary kept, nor one a retiring host still lists.
      if (this.retiringOwnerOf(threadId) !== null || this.switchKeeps?.threadIds.has(threadId)) return "owned";
      const primary = this.primary();
      if (primary !== null) {
        const sent = request(primary.generation, threadId);
        this.adoptRequests.add(sent);
        try {
          const outcome = await sent;
          if (outcome === "adopted") this.log("log", `agent host ${primary.generation} adopted chat ${threadId}`);
          return "adopted";
        } catch (error) {
          if (current()) this.noteAdoptFailure(threadId, primary.generation, error);
        } finally {
          this.adoptRequests.delete(sent);
        }
      }
      await this.delay(Math.min(ADOPT_RETRY_MAX_MS, ADOPT_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
    return "halted";
  }

  /** One failed adoption: logged; reported (`stuckAdoptions`) once it keeps failing. */
  private noteAdoptFailure(threadId: string, generation: number, error: unknown): void {
    const failure = this.adoptFailures.get(threadId) ?? { attempts: 0, since: this.opts.adapters.now(), error: null };
    failure.attempts += 1;
    failure.error = error instanceof Error ? error.message : String(error);
    this.adoptFailures.set(threadId, failure);
    if (failure.attempts === ADOPT_ATTEMPTS_BEFORE_REPORTING) {
      this.log(
        "error",
        `agent host ${generation} has failed to adopt chat ${threadId} ${failure.attempts} times; it is unreachable until it does — still retrying`,
        error
      );
    } else {
      this.log("warn", `agent host ${generation} could not adopt chat ${threadId} (attempt ${failure.attempts}); retrying`, error);
    }
  }

  /**
   * End a retiring host (R27, R30, `restartNow`): `/stop` (which marks what it cuts for
   * continuation; nothing when it owns nothing), wait for its process to exit, then forget it —
   * the primary adopts what it still owned.
   */
  private async endRetiringHost(
    host: RetiringHost,
    why: "drained" | "cap" | "limit" | "restart" | "protocol"
  ): Promise<void> {
    if (host.ending || this.retiring.get(host.generation) !== host) return;
    host.ending = true;
    if (why === "drained") {
      this.log("log", `agent host ${host.generation} finished its last chat; stopping it`);
    } else {
      const cause =
        why === "cap"
          ? `it retired ${Math.round(AGENT_HOST_RETIRE_MAX_MS / 3_600_000)} h ago`
          : why === "limit"
            ? `more than ${MAX_RETIRING_HOSTS} hosts would be retiring`
            : why === "protocol"
              ? `it speaks agent host protocol ${host.health?.protocolVersion ?? "unknown"}, this daemon ${AGENT_HOST_PROTOCOL_VERSION}`
              : "a restart was asked for";
      this.log("warn", `ending agent host ${host.generation} (${cause}): its ${host.owned.size} chat(s) are interrupted and resumed on the current host`);
    }
    // I5: what it owns is on disk before the stop — a daemon that dies from here adopts it at boot.
    await this.persistRegistry();
    try {
      await this.opts.adapters.requestStop(host.generation);
    } catch (error) {
      this.log("warn", `agent host ${host.generation} stop request failed; killing it`, error);
    }
    await this.awaitHostExit(host.generation);
    await this.forgetRetiringHost(host);
  }

  /** R28: a retiring host died or stopped answering: its last-known threads move to the primary. */
  private async retiringHostGone(host: RetiringHost, reason: string): Promise<void> {
    if (host.ending) return;
    host.ending = true;
    this.log("warn", `retiring agent host ${host.generation} is gone (${reason}); the current host adopts its ${host.owned.size} chat(s)`);
    await this.forgetRetiringHost(host);
  }

  private async forgetRetiringHost(host: RetiringHost): Promise<void> {
    if (!(await this.killHost(host.generation))) {
      // I1: a host that may still run keeps its chats — it may still be writing them. It stays
      // listed (and in every foreign file); the poll kills it again.
      const now = this.opts.adapters.now();
      if (host.killUnconfirmedSince === null) {
        host.killUnconfirmedSince = now;
        this.log(
          "error",
          `retiring agent host ${host.generation} could not be confirmed stopped; its ${host.owned.size} chat(s) stay on it until it is`
        );
      }
      host.nextKillAt = now + HOST_KILL_RETRY_MS;
      return;
    }
    // The host leaves the set and each adoption is registered in the same tick (I2) — in this
    // order, so the adoption's own check sees no retiring owner. Its process is gone, so none of
    // its provider sessions is resumed twice (I4).
    this.retiring.delete(host.generation);
    for (const threadId of host.owned) this.startAdoption(threadId);
    await this.removeHostFiles(host.generation);
    await this.persistRegistry();
  }

  /**
   * Kill host `generation` — its tmux service session, or its direct child — and wait until it is
   * confirmed gone (I1/I4: nothing moves its threads while it may still write them, and a direct
   * child's SIGTERM teardown writes them). Not gone within {@link HOST_KILL_GRACE_MS}: SIGKILL,
   * the session killed again, and as long again. False when its death still is not confirmed.
   */
  private async killHost(generation: number): Promise<boolean> {
    const tmux = this.opts.adapters.tmux;
    const session = agentHostServiceSession(generation);
    const kill = async (signal?: NodeJS.Signals): Promise<void> => {
      await tmux?.killServiceSession(session).catch((error) => this.log("warn", `tmux could not kill ${session}`, error));
      try {
        this.directHandles.get(generation)?.kill(signal);
      } catch {
        /* already gone */
      }
    };
    await kill();
    let gone = await this.awaitHostExit(generation, HOST_KILL_GRACE_MS);
    if (!gone) {
      this.log("warn", `agent host ${generation} did not exit after it was killed; killing it with SIGKILL`);
      await kill("SIGKILL");
      gone = await this.awaitHostExit(generation, HOST_KILL_GRACE_MS);
    }
    if (gone) this.directHandles.delete(generation);
    return gone;
  }

  /** R27: a gone host's socket, token and foreign file, and what the daemon held of it. */
  private async removeHostFiles(generation: number): Promise<void> {
    const paths = [this.tokenPathOf(generation), agentHostForeignThreadsPath(this.opts.appdir, generation)];
    if ((this.opts.platform ?? process.platform) !== "win32") paths.push(this.socketPathOf(generation));
    await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
    this.tokens.delete(generation);
    this.clients.delete(generation);
    this.endpoints.delete(`${generation}:primary`);
    this.endpoints.delete(`${generation}:retiring`);
  }

  /**
   * Write the registry as the supervisor sees it now (P2.2, I5), keeping what it does not manage.
   * A no-op before the registry is in play. Resolves false when the write failed (logged).
   */
  private persistRegistry(): Promise<boolean> {
    if (!this.registryInUse) return Promise.resolve(true);
    const write = this.registryWrites.then(async () => {
      const kept = new Map(this.registryKept.entries.map((entry) => [entry.generation, entry]));
      const entry = (
        generation: number,
        fields: Pick<AgentHostRegistryEntry, "role" | "retiringSince" | "ownedThreadIds">
      ): AgentHostRegistryEntry => {
        const { role: _role, retiringSince: _since, ownedThreadIds: _owned, ...unknown } = kept.get(generation) ?? {};
        return {
          ...unknown,
          generation,
          ...fields,
          // For a reader's eyes; every name derives from the generation.
          socket: this.socketPathOf(generation),
          tokenPath: this.tokenPathOf(generation),
          tmuxSession: agentHostServiceSession(generation)
        };
      };
      const entries: AgentHostRegistryEntry[] = [];
      const keeps = this.switchKeeps;
      if (keeps !== null && keeps.generation === this.primaryGeneration) {
        entries.push(
          entry(keeps.generation, {
            role: "retiring",
            retiringSince: new Date(keeps.since).toISOString(),
            ownedThreadIds: [...keeps.threadIds].sort()
          }),
          entry(keeps.starting, { role: "starting" })
        );
      } else {
        entries.push(entry(this.primaryGeneration, { role: "primary" }));
      }
      for (const host of this.retiring.values()) {
        entries.push(
          entry(host.generation, {
            role: "retiring",
            retiringSince: new Date(host.retiringSince).toISOString(),
            ownedThreadIds: [...host.owned].sort()
          })
        );
      }
      try {
        await writeHostRegistry(agentHostRegistryPath(this.opts.appdir), {
          entries,
          unparsed: this.registryKept.unparsed,
          extra: this.registryKept.extra,
          pendingAdoptions: [...this.pendingAdoptionIds]
        });
        return true;
      } catch (error) {
        this.log("error", "could not write the agent host registry", error);
        return false;
      }
    });
    this.registryWrites = write.catch(() => undefined);
    return write;
  }

  /**
   * The registry a previous daemon left, or null for the single-host layout. `problem`: it exists
   * but cannot be read, or names hosts this daemon cannot parse — it may not list every live host.
   */
  private async loadRegistry(): Promise<{ registry: HostRegistryFile | null; problem: boolean }> {
    try {
      const registry = await readHostRegistry(agentHostRegistryPath(this.opts.appdir));
      if (registry !== null && registry.unparsed.length > 0) {
        this.log("warn", `the agent host registry names ${registry.unparsed.length} host record(s) this daemon cannot read`);
      }
      return { registry, problem: registry !== null && registry.unparsed.length > 0 };
    } catch (error) {
      if (!(error instanceof HostRegistryUnreadableError)) throw error;
      this.log("error", "the agent host registry is unreadable; accounting for the live agent hosts from their own health", error);
      return { registry: null, problem: true };
    }
  }

  /**
   * I1, a registry that may not list every live host: each live host session it does not name is
   * accounted for from the host's own `/health` — its generation, whether it retires, what it owns
   * — and added as an entry. The completed registry; null when only a plain generation 0 lives (the
   * single-host layout); or why a live host cannot be accounted for (it does not answer, or tmux
   * cannot list the sessions), in which case nothing may boot.
   */
  private async accountForLiveHosts(registry: HostRegistryFile | null): Promise<HostRegistryFile | null | string> {
    const tmux = this.opts.adapters.tmux;
    // Direct hosts are daemon children: none outlives the daemon that started it (P2.2).
    if (!tmux) return registry;
    const recorded = new Set(registry?.entries.map((entry) => entry.generation) ?? []);
    let live: number[];
    try {
      live = await this.liveHostGenerations(tmux, registry);
    } catch (error) {
      return `tmux cannot list the agent host sessions (${error instanceof Error ? error.message : String(error)})`;
    }
    const entries = [...(registry?.entries ?? [])];
    const unaccounted: number[] = [];
    for (const generation of live) {
      if (recorded.has(generation)) continue;
      const probed = await this.probeRecorded(generation);
      if (!probed.ok || (probed.health.retiring === true && !Array.isArray(probed.health.ownedThreadIds))) {
        unaccounted.push(generation);
        continue;
      }
      this.log("warn", `agent host ${generation} is live but not in the registry: ${describeHost(probed.health)}`);
      entries.push(
        probed.health.retiring === true
          ? { generation, role: "retiring", retiringSince: null, ownedThreadIds: [...probed.health.ownedThreadIds!] }
          : { generation, role: "primary" }
      );
    }
    if (unaccounted.length > 0) {
      return `agent host generation(s) ${unaccounted.join(", ")} run but the registry does not account for them and they do not answer`;
    }
    if (registry === null && entries.every((entry) => entry.generation === 0 && entry.role === "primary")) return null;
    return { entries, unparsed: registry?.unparsed ?? [], extra: registry?.extra ?? {}, pendingAdoptions: registry?.pendingAdoptions ?? [] };
  }

  /** The generations whose host session is live. Throws when tmux cannot tell. */
  private async liveHostGenerations(tmux: SupervisorTmux, registry: HostRegistryFile | null): Promise<number[]> {
    const base = agentHostServiceSession(0);
    if (tmux.listServiceSessions) {
      const generations: number[] = [];
      for (const name of await tmux.listServiceSessions(base)) {
        if (name === base) generations.push(0);
        const match = /^-(\d+)$/.exec(name.slice(base.length));
        if (match) generations.push(Number(match[1]));
      }
      return generations;
    }
    const highest = registry === null ? 0 : Math.max(0, highestRecordedGeneration(registry));
    const generations: number[] = [];
    for (let generation = 0; generation <= highest; generation += 1) {
      if (await tmux.hasServiceSession(agentHostServiceSession(generation))) generations.push(generation);
    }
    return generations;
  }

  /** Read a recorded generation's token and probe it. */
  private async probeRecorded(generation: number): Promise<ProbeOutcome> {
    const token = await this.readToken(generation);
    if (token === null) return { ok: false, reachable: false };
    this.tokens.set(generation, token);
    return this.safeProbe(generation);
  }

  /**
   * A recorded host that does not answer: kill whatever is left of it and its files. False when
   * its death could not be confirmed (I1): it is then {@link unstoppable} — killed again on the
   * health tick, and nothing that would own its chats is spawned meanwhile.
   */
  private async discardHost(generation: number): Promise<boolean> {
    if (!(await this.killHost(generation))) {
      const now = this.opts.adapters.now();
      const reason = `agent host generation ${generation}, recorded but not answering, could not be confirmed stopped`;
      this.log("error", reason);
      this.unstoppable.set(generation, { reason, nextKillAt: now + HOST_KILL_RETRY_MS });
      return false;
    }
    await this.removeHostFiles(generation);
    return true;
  }

  /**
   * P2.4 R29: boot from the registry. Every recorded host is probed and adopted in its role:
   *   - a live `starting` host (the daemon died mid-update, after the spawn) is the primary — it
   *     booted with the foreign file of that moment; a dead one is discarded;
   *   - a live retiring host keeps retiring; the threads it released while the daemon was down,
   *     and every thread of one that is gone, are adopted by the primary;
   *   - a live primary is adopted as today (stale ⇒ the update flow);
   *   - a primary that is gone while retiring hosts live is respawned as a NEW generation whose
   *     foreign file lists their owned sets; with none live it is respawned in place (§3.1).
   */
  private async bootFromRegistry(registry: HostRegistryFile): Promise<void> {
    const byRole = (role: AgentHostRegistryEntry["role"]): AgentHostRegistryEntry[] =>
      registry.entries.filter((entry) => entry.role === role).sort((a, b) => b.generation - a.generation);
    const now = this.opts.adapters.now();
    const toAdopt = new Set<string>();
    const candidates: Array<{ generation: number; health: AgentHostHealthResponse }> = [];
    for (const entry of byRole("starting")) {
      const probed = await this.probeRecorded(entry.generation);
      if (probed.ok && probed.health.retiring !== true) candidates.push({ generation: entry.generation, health: probed.health });
      else await this.discardHost(entry.generation);
    }
    let recordedPrimary: number | null = null;
    const retiringEntries = byRole("retiring");
    for (const entry of byRole("primary")) {
      const probed = await this.probeRecorded(entry.generation);
      if (probed.ok && probed.health.retiring === true) {
        retiringEntries.push(entry);
      } else if (probed.ok) {
        candidates.push({ generation: entry.generation, health: probed.health });
      } else if (recordedPrimary === null) {
        recordedPrimary = entry.generation;
      } else {
        await this.discardHost(entry.generation);
      }
    }
    // I5: adoptions a previous daemon started and did not see complete.
    for (const threadId of registry.pendingAdoptions ?? []) toAdopt.add(threadId);
    const otherProtocol: RetiringHost[] = [];
    for (const entry of retiringEntries) {
      const recorded = entry.ownedThreadIds ?? [];
      const probed = entry.role === "primary" ? await this.safeProbe(entry.generation) : await this.probeRecorded(entry.generation);
      const parsedSince = typeof entry.retiringSince === "string" ? Date.parse(entry.retiringSince) : Number.NaN;
      const since = Number.isFinite(parsedSince) ? parsedSince : now;
      if (probed.ok && probed.health.retiring === true) {
        const owned = new Set(probed.health.ownedThreadIds ?? recorded);
        // Released while no daemon watched: nobody adopted them yet.
        for (const threadId of recorded) if (!owned.has(threadId)) toAdopt.add(threadId);
        const host = this.addRetiringHost(entry.generation, probed.health, owned, since);
        this.log("log", `retiring agent host ${entry.generation} adopted: ${describeHost(probed.health)}, ${owned.size} chat(s)`);
        // P2.6: one this daemon cannot route to is ended through the cap path once a primary is up.
        if (probed.health.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) otherProtocol.push(host);
      } else if (probed.ok) {
        // Unretired, and the daemon died before it recorded that: a primary candidate.
        candidates.push({ generation: entry.generation, health: probed.health });
      } else if ((await this.hostProcessAlive(entry.generation)) || !(await this.discardHost(entry.generation))) {
        // Alive but silent — busy, or a tmux that cannot tell — or its kill not confirmed: one
        // missed probe is no death (R28). It keeps its chats; the poll's patience decides.
        const host = this.addRetiringHost(entry.generation, null, new Set(recorded), since);
        host.firstMissAt = now;
        this.unstoppable.delete(entry.generation);
        this.log("warn", `retiring agent host ${entry.generation} did not answer; it keeps its ${recorded.length} chat(s) for now`);
      } else {
        for (const threadId of recorded) toAdopt.add(threadId);
        this.log("warn", `retiring agent host ${entry.generation} is gone; the primary adopts its ${recorded.length} chat(s)`);
      }
    }
    // Pending before any primary is spawned, so its foreign file names them (`hostEnv`): each is
    // adopted (below), never reconciled at its boot.
    if (this.opts.adapters.requestAdopt !== undefined) {
      for (const threadId of toAdopt) if (this.retiringOwnerOf(threadId) === null) this.pendingAdoptionIds.add(threadId);
    }
    const [primary, ...extra] = candidates;
    if (primary !== undefined) {
      this.primaryGeneration = primary.generation;
      for (const other of extra) await this.retireExtraHost(other.generation, other.health);
      if (recordedPrimary !== null) await this.discardHost(recordedPrimary);
      this.adopt(primary.health);
      this.log("log", `agent host ${primary.generation} adopted as primary: ${describeHost(primary.health)}`);
      if (this.isStale(primary.health)) {
        this.pendingVersionRestart = true;
        this.log("warn", `${this.staleReason(primary.health)}; updating it`);
        this.emit();
      }
    } else if (this.retiring.size > 0) {
      // Never a host that reconciles every thread while retiring hosts own some (I3).
      if (recordedPrimary !== null) await this.discardHost(recordedPrimary);
      this.primaryGeneration = this.nextGeneration();
      this.log("warn", `the primary agent host is gone while ${this.retiring.size} retiring host(s) live; starting generation ${this.primaryGeneration}`);
      await this.bootPrimary();
    } else {
      this.primaryGeneration = recordedPrimary ?? 0;
      await this.bootPrimary();
    }
    for (const threadId of toAdopt) {
      if (this.retiringOwnerOf(threadId) === null) this.startAdoption(threadId);
    }
    await this.persistRegistry();
    for (const host of otherProtocol) await this.endRetiringHost(host, "protocol");
    this.scheduleRetiringPoll();
    if (this.pendingVersionRestart && primary !== undefined) await this.updateStaleHostAtBoot();
  }

  private addRetiringHost(
    generation: number,
    health: AgentHostHealthResponse | null,
    owned: Set<string>,
    retiringSince: number
  ): RetiringHost {
    const host: RetiringHost = {
      generation,
      health,
      owned,
      retiringSince,
      firstMissAt: null,
      ending: false,
      killUnconfirmedSince: null,
      nextKillAt: 0
    };
    this.retiring.set(generation, host);
    return host;
  }

  /**
   * A second live host that is not retiring (the daemon died between an unretire and the
   * registry write): it retires now; one that cannot is stopped (its `/stop` marks what it cuts).
   */
  private async retireExtraHost(generation: number, health: AgentHostHealthResponse): Promise<void> {
    let keep: readonly string[] | null = null;
    try {
      keep = (await this.opts.adapters.requestRetire?.(generation)) ?? null;
    } catch (error) {
      this.log("warn", `agent host ${generation} could not retire`, error);
    }
    if (keep !== null) {
      this.addRetiringHost(generation, health, new Set(keep), this.opts.adapters.now());
      return;
    }
    this.log("warn", `stopping agent host ${generation}: a second primary`);
    await this.opts.adapters.requestStop(generation).catch(() => undefined);
    await this.awaitHostExit(generation);
    await this.discardHost(generation);
  }

  /** R31: one retiring host as the Host status page lists it. */
  private retiringStatus(host: RetiringHost): AgentHostRetiringStatus {
    const health = host.health;
    const blockers =
      health === null
        ? []
        : restartBlockers(health, [], [...new Set((health.pendingWakes ?? []).map((wake) => wake.threadId))]).filter(
            (blocker) => host.owned.has(blocker.threadId)
          );
    return {
      generation: host.generation,
      hostInstanceId: health?.hostInstanceId ?? null,
      pid: health?.pid ?? this.directHandles.get(host.generation)?.pid ?? null,
      codeStamp: typeof health?.codeStamp === "string" ? health.codeStamp : null,
      retiringSince: new Date(host.retiringSince).toISOString(),
      endsAt: new Date(host.retiringSince + AGENT_HOST_RETIRE_MAX_MS).toISOString(),
      threads: [...host.owned].sort().map((threadId) => ({ threadId })),
      blockers,
      ...(host.killUnconfirmedSince !== null ? { stopUnconfirmedSince: new Date(host.killUnconfirmedSince).toISOString() } : {})
    };
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

/** An epoch-ms instant as ISO, or null. */
function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** A code stamp for a log line: its first 12 characters, or `unknown`. */
function shortStamp(stamp: string | null | undefined): string {
  return typeof stamp === "string" && stamp !== "" ? stamp.slice(0, 12) : "unknown";
}

/** One host's identity for a log line: instance, pid and code stamp. */
function describeHost(health: AgentHostHealthResponse): string {
  return `instance ${health.hostInstanceId}, pid ${health.pid}, code ${shortStamp(health.codeStamp)}`;
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

/**
 * Everything of `health`'s host a restart would cut, per thread: running turns, itemised
 * background tasks, background work it does not itemise, and pending wakes (`wakeThreads`).
 */
function restartBlockers(
  health: AgentHostHealthResponse,
  daemonView: readonly string[] | null,
  wakeThreads: readonly string[]
): AgentHostRestartBlocker[] {
  const blockers: AgentHostRestartBlocker[] = [];
  for (const threadId of new Set(health.activeTurnThreadIds)) {
    blockers.push({ threadId, kind: "turn" });
  }
  const itemised = new Set<string>();
  for (const task of health.backgroundTasks ?? []) {
    itemised.add(task.threadId);
    blockers.push({
      threadId: task.threadId,
      kind: task.kind === "agent" ? "agent" : "background",
      taskId: task.taskId,
      since: task.since,
      stoppable: task.stoppable,
      ...(task.title !== undefined ? { title: task.title } : {}),
      ...(task.command !== undefined ? { command: task.command } : {})
    });
  }
  for (const threadId of backgroundWorkThreadIds(health, daemonView)) {
    if (!itemised.has(threadId)) blockers.push({ threadId, kind: "work" });
  }
  const wakes = new Map((health.pendingWakes ?? []).map((wake) => [wake.threadId, wake.since]));
  for (const threadId of wakeThreads) {
    const since = wakes.get(threadId);
    blockers.push({ threadId, kind: "wake", ...(since !== undefined ? { since } : {}) });
  }
  return blockers;
}

/** True while any thread has an active turn or live background work. */
function hostHasWork(
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
function drainBlockers(
  health: AgentHostHealthResponse,
  daemonView: readonly string[] | null = [],
  pendingWakes: readonly string[] = []
): string | null {
  if (health.backgroundWorkThreadIds === undefined && daemonView === null) {
    return "background work not known yet (the host predates the health field; waiting for the first summary poll)";
  }
  const turns = health.activeTurnThreadIds.length;
  const background = backgroundWorkThreadIds(health, daemonView).length;
  const wakes = pendingWakes.length;
  if (turns === 0 && background === 0 && wakes === 0) return null;
  const parts: string[] = [];
  if (turns > 0) parts.push(`${turns} thread(s) with an active turn`);
  if (background > 0) parts.push(`${background} thread(s) with live background work`);
  if (wakes > 0) parts.push(`${wakes} thread(s) about to hand the agent a finished background task`);
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
 * spreading `process.env` — the daemon's own environment holds push and
 * daemon secrets.
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
  /**
   * The DAEMON's own unix socket, which the host calls back on for session
   * tools (design 2026-10-14 §1.1). Without it the host falls back to the
   * appdir's default socket path.
   */
  daemonSocketPath?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.sessionPath,
    ORQUESTER_APPDIR: input.appdir,
    ORQUESTER_AGENT_HOST: "1",
    ORQUESTER_AGENT_HOST_SOCK: input.socketPath,
    ...(input.daemonSocketPath !== undefined ? { ORQUESTER_DAEMON_SOCK: input.daemonSocketPath } : {}),
    // tsx writes its transpile cache to TMPDIR and `/tmp` is unavailable under
    // ProtectSystem=strict — the same reason the unit sets it for the daemon.
    NODE_ENV: "production"
  };
  if (input.tmpdir) env.TMPDIR = input.tmpdir;
  if (input.home) env.HOME = input.home;
  if (input.npmConfigPrefix) env.NPM_CONFIG_PREFIX = input.npmConfigPrefix;
  return env;
}
