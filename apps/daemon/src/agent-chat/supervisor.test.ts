import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_HOST_PROTOCOL_VERSION, AGENT_HOST_SERVICE_SESSION } from "../agent-host/host-protocol.ts";
import {
  AgentHostSupervisor,
  MAX_RESPAWNS,
  UNREACHABLE_PROBES_BEFORE_RESTART,
  UNREACHABLE_PROBES_BEFORE_RESTART_BUSY,
  buildAgentHostEnv,
  type ProbeOutcome,
  type SupervisorTmux
} from "./supervisor.ts";

// The §3.1 boot-adoption state machine, against a fake host. No process is
// ever spawned: every side effect is injected, because this package may not
// launch a daemon or a host at all.

interface Harness {
  supervisor: AgentHostSupervisor;
  /** Queue of probe answers; the last one repeats. */
  probes: ProbeOutcome[];
  spawns: Array<{ killFirst: boolean; args: string[] }>;
  stopRequests: number;
  tokenPath: string;
  /** Advance the injected clock past a backoff window. */
  advance(ms: number): void;
  /** Flip to make the next spawn throw, as a real tmux failure does. */
  spawnThrows: boolean;
  /** Overrides the queued probe answer when it returns something. */
  probeHook?: () => ProbeOutcome | undefined;
  /** Ordered record of probe / kill / spawn. */
  order: string[];
  /** The token file's content at the moment the new session was created. */
  tokenAtSpawn: string | null;
  /** How many times `onProvidersRevision` fired. */
  providerRevisions: number;
  /**
   * How many `hasServiceSession` polls after the stop request the fake host's
   * PROCESS takes to exit (its tmux session ends with it). `null` = never.
   */
  hostExitsAfterPolls: number | null;
  /** Whether the service session still existed at the moment it was killed. */
  killedSessionWasAlive: boolean | null;
  /** Agent goals §5.7: `POST /goals/hold` requests that reached the fake host. */
  holdRequests: number;
  /**
   * What the fake host answers a hold request; absent = holds nothing. May
   * throw synchronously or reject, as a failed request does.
   */
  holdHook?: () => Promise<readonly string[] | null>;
  /** Every line the supervisor logged. */
  logs: Array<{ level: "log" | "warn" | "error"; text: string }>;
  cleanup(): Promise<void>;
}

const healthy = (
  overrides: Partial<{
    version: number;
    active: string[];
    instance: string;
    providersRevision: number;
    codeStamp: string | null;
    /** Threads with live background work (a subagent fleet, a background shell). */
    background: string[];
  }> = {}
): ProbeOutcome => ({
  ok: true,
  health: {
    ok: true,
    protocolVersion: overrides.version ?? AGENT_HOST_PROTOCOL_VERSION,
    hostInstanceId: overrides.instance ?? "host-1",
    liveThreadIds: [],
    activeTurnThreadIds: overrides.active ?? [],
    ...(overrides.background === undefined
      ? {}
      : { backgroundWorkThreadIds: overrides.background }),
    pid: 4242,
    startedAt: "2026-09-21T00:00:00.000Z",
    ...(overrides.codeStamp === undefined ? {} : { codeStamp: overrides.codeStamp }),
    ...(overrides.providersRevision === undefined
      ? {}
      : { providersRevision: overrides.providersRevision })
  }
});

/**
 * Reality for a version-mismatch restart: the old host keeps answering the
 * mismatched version (it is the same process) until the replacement is
 * spawned, and the replacement answers the current version. A fixed queue
 * cannot model that, because the supervisor now probes more than once.
 */
function mismatchUntilReplaced(h: Harness, active: string[] = []): () => ProbeOutcome | undefined {
  return () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active })
      : healthy({ instance: "host-2" });
}

async function makeHarness(
  probes: ProbeOutcome[],
  opts: {
    tmux?: boolean;
    seedToken?: string;
    spawnThrows?: boolean;
    codeStamp?: string | null;
    /** The daemon's own liveness view (`SupervisorAdapters.backgroundWorkThreadIds`). */
    daemonBackground?: () => readonly string[] | null;
  } = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-agent-host-"));
  const tokenPath = join(dir, "agent-host.token");
  if (opts.seedToken) {
    await writeFile(tokenPath, `${opts.seedToken}\n`, { mode: 0o600 });
  }
  let clock = 1_000_000;
  const harness: Harness = {
    probes: [...probes],
    spawns: [],
    stopRequests: 0,
    tokenPath,
    supervisor: null as unknown as AgentHostSupervisor,
    spawnThrows: opts.spawnThrows === true,
    order: [],
    tokenAtSpawn: null,
    providerRevisions: 0,
    hostExitsAfterPolls: null,
    killedSessionWasAlive: null,
    holdRequests: 0,
    logs: [],
    advance: (ms) => {
      clock += ms;
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
  let sessionExists = opts.tmux === true && opts.seedToken !== undefined;
  // Record whether the kill-first branch actually ran, rather than hardcoding
  // `false`: that branch is the one that produces the duplicate-session throw.
  let killedSinceSpawn = false;
  const tmux: SupervisorTmux | null =
    opts.tmux === false
      ? null
      : {
          hasServiceSession: async (name) => {
            if (name !== AGENT_HOST_SERVICE_SESSION) return false;
            // After a stop request the fake host takes N polls to exit, and its
            // session ends with the process — the real teardown's shape.
            if (sessionExists && harness.stopRequests > 0 && harness.hostExitsAfterPolls !== null) {
              if (harness.hostExitsAfterPolls <= 0) sessionExists = false;
              else harness.hostExitsAfterPolls -= 1;
            }
            return sessionExists;
          },
          killServiceSession: async () => {
            harness.killedSessionWasAlive = sessionExists;
            sessionExists = false;
            killedSinceSpawn = true;
            harness.order.push("kill");
          },
          newServiceSession: async ({ args }) => {
            if (harness.spawnThrows) throw new Error("duplicate session: orqsvc-agent-host");
            sessionExists = true;
            harness.tokenAtSpawn = await readFile(tokenPath, "utf8").then(
              (raw) => raw.trim(),
              () => null
            );
            harness.order.push("spawn");
            harness.spawns.push({ killFirst: killedSinceSpawn, args });
            killedSinceSpawn = false;
          }
        };
  harness.supervisor = new AgentHostSupervisor({
    appdir: dir,
    tokenPath,
    cwd: dir,
    env: {},
    nodeBin: "/usr/bin/node",
    mainPath: "/opt/orquester/apps/daemon/src/agent-host/main.ts",
    preparedTimeoutMs: 50,
    exitGraceMs: 500,
    ...(opts.codeStamp === undefined ? {} : { codeStamp: opts.codeStamp }),
    adapters: {
      probe: async () => {
        harness.order.push("probe");
        const hooked = harness.probeHook?.();
        if (hooked) return hooked;
        return harness.probes.length > 1 ? harness.probes.shift()! : harness.probes[0];
      },
      onProvidersRevision: () => {
        harness.providerRevisions++;
      },
      ...(opts.daemonBackground ? { backgroundWorkThreadIds: opts.daemonBackground } : {}),
      requestStop: async () => {
        harness.stopRequests++;
      },
      // Not `async`: a hook that throws synchronously must reach the
      // supervisor as a synchronous throw.
      requestHoldGoals: () => {
        harness.holdRequests++;
        harness.order.push("hold");
        return harness.holdHook ? harness.holdHook() : Promise.resolve([]);
      },
      logger: {
        log: (...a) => harness.logs.push({ level: "log", text: a.map(String).join(" ") }),
        warn: (...a) => harness.logs.push({ level: "warn", text: a.map(String).join(" ") }),
        error: (...a) => harness.logs.push({ level: "error", text: a.map(String).join(" ") })
      },
      tmux,
      spawnDirect: (_bin, args) => {
        if (harness.spawnThrows) throw new Error("spawn failed");
        harness.spawns.push({ killFirst: killedSinceSpawn, args });
        killedSinceSpawn = false;
        return { kill: () => undefined, pid: 9191 };
      },
      // An injected clock: the readiness deadline and the respawn backoff are
      // both real windows, and a test must never wait on one.
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      }
    }
  });
  return harness;
}

test("case 2: healthy + same protocol version adopts without spawning", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok" });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.spawns.length, 0, "an adopted host is never respawned");
  assert.equal(h.supervisor.currentToken(), "tok", "a live host's token must keep working");
  assert.equal(h.supervisor.status().hostInstanceId, "host-1");
  await h.cleanup();
});

test("case 3: a version mismatch adopts first, then restarts once drained", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  h.probeHook = mismatchUntilReplaced(h);
  await h.supervisor.init();
  assert.equal(h.stopRequests, 1, "the old host writes its continuation markers first");
  assert.equal(h.spawns.length, 1, "a replacement is spawned");
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.supervisor.status().pendingVersionRestart, false);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  await h.cleanup();
});

test("case 3: a moved CODE stamp is a drain-restart too, not only a protocol bump", async () => {
  // A deploy that changes only host code used to leave the surviving host on
  // the old code for as long as it lived (the protocol version was the only
  // signal). The old host reports the commit it started from; the daemon
  // knows its own.
  const h = await makeHarness([], { seedToken: "tok", tmux: true, codeStamp: "b".repeat(40) });
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ codeStamp: "a".repeat(40) })
      : healthy({ instance: "host-2", codeStamp: "b".repeat(40) });
  await h.supervisor.init();
  assert.equal(h.stopRequests, 1, "the old host writes its continuation markers first");
  assert.equal(h.spawns.length, 1, "a replacement is spawned");
  assert.equal(h.supervisor.status().pendingVersionRestart, false);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  await h.cleanup();
});

test("the same code stamp, or an unknown one on either side, adopts without restarting", async () => {
  const same = await makeHarness([healthy({ codeStamp: "a".repeat(40) })], {
    seedToken: "tok",
    tmux: true,
    codeStamp: "a".repeat(40)
  });
  await same.supervisor.init();
  assert.equal(same.spawns.length, 0);
  assert.equal(same.supervisor.status().pendingVersionRestart, false);
  await same.cleanup();

  const unknownHost = await makeHarness([healthy({ codeStamp: null })], {
    seedToken: "tok",
    tmux: true,
    codeStamp: "a".repeat(40)
  });
  await unknownHost.supervisor.init();
  assert.equal(unknownHost.spawns.length, 0, "an older host that reports nothing is not restarted");
  await unknownHost.cleanup();

  const unknownDaemon = await makeHarness([healthy({ codeStamp: "a".repeat(40) })], {
    seedToken: "tok",
    tmux: true,
    codeStamp: null
  });
  await unknownDaemon.supervisor.init();
  assert.equal(unknownDaemon.spawns.length, 0, "a daemon outside a checkout never restarts on it");
  await unknownDaemon.cleanup();
});

test("case 3: a version mismatch with an ACTIVE turn adopts and waits", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  h.probeHook = mismatchUntilReplaced(h, ["thread-1"]);
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy", "the in-flight turn keeps running");
  assert.equal(h.spawns.length, 0, "no restart while a thread has an active turn");
  assert.equal(h.supervisor.status().pendingVersionRestart, true);
  await h.cleanup();
});

test("a settled turn reopens the drain window without waiting for the health tick", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let active: string[] = ["thread-1"];
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active })
      : healthy({ instance: "host-2" });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 0);
  // The turn settles: the next health snapshot has no active turn.
  active = [];
  await h.supervisor.checkHealth();
  assert.equal(h.stopRequests, 1, "the old host writes its continuation markers");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  await h.cleanup();
});

test("handleTurnSettled is inert unless a version restart is pending", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.supervisor.handleTurnSettled();
  await h.supervisor.restartNow().catch(() => undefined);
  // restartNow always restarts; what matters is that handleTurnSettled alone
  // did not, so exactly one spawn happened.
  assert.equal(h.spawns.length, 1);
  await h.cleanup();
});

test("case 4: a token rejection from a process that is not ours is FOREIGN — never killed", async () => {
  const h = await makeHarness([{ ok: false, reachable: true, rejected: true }], {
    seedToken: "tok",
    tmux: false
  });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "foreign");
  assert.equal(h.spawns.length, 0, "a foreign listener is never killed or replaced");
  await h.cleanup();
});

test("a token rejection from OUR OWN service session is a stale token, not a stranger", async () => {
  // Ownership is verified by the tmux service-session name, which a foreign
  // process cannot be in; this is the lost-token-file recovery path.
  const h = await makeHarness([{ ok: false, reachable: true, rejected: true }, healthy()], {
    seedToken: "tok",
    tmux: true
  });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.spawns.length, 1);
  assert.notEqual(h.supervisor.currentToken(), "tok", "a fresh token is minted for the new host");
  await h.cleanup();
});

test("case 5: nothing answers → spawn and poll READINESS", async () => {
  const h = await makeHarness([{ ok: false, reachable: false }, healthy()], { tmux: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.spawns.length, 1);
  const args = h.spawns[0].args;
  assert.deepEqual(args.slice(0, 2), ["--import", "tsx"], "the host runs TS through tsx, like the daemon");
  assert.ok(args.includes("--appdir"));
  const token = (await readFile(h.tokenPath, "utf8")).trim();
  assert.equal(h.supervisor.currentToken(), token);
  assert.ok(token.length >= 32);
  await h.cleanup();
});

test("a host that never reaches readiness leaves the supervisor stopped, not healthy", async () => {
  const h = await makeHarness([{ ok: false, reachable: false }], { tmux: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "stopped");
  assert.equal(h.supervisor.isHealthy(), false);
  await h.cleanup();
});

test("a replacement that becomes ready after its deadline is adopted without another restart", async () => {
  const h = await makeHarness([], {
    seedToken: "tok",
    tmux: true,
    codeStamp: "b".repeat(40)
  });
  let replacementReady = false;
  h.hostExitsAfterPolls = 0;
  h.probeHook = () => {
    if (h.spawns.length === 0) {
      return healthy({ codeStamp: "a".repeat(40) });
    }
    return replacementReady
      ? healthy({ instance: "host-2", codeStamp: "b".repeat(40) })
      : { ok: false, reachable: true, rejected: false };
  };

  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "error", "the initial readiness deadline elapsed");
  assert.equal(h.spawns.length, 1);

  replacementReady = true;
  await h.supervisor.checkHealth();

  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  assert.equal(h.spawns.length, 1, "the now-ready replacement is adopted, not killed and respawned");
  await h.cleanup();
});

test("health supervision respawns a dead host and latches error after the cap", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");
  h.probes = [{ ok: false, reachable: false }];
  // Each respawn attempt now needs UNREACHABLE_PROBES_BEFORE_RESTART misses.
  for (let i = 0; i < MAX_RESPAWNS * (UNREACHABLE_PROBES_BEFORE_RESTART + 1); i++) {
    h.advance(120_000); // past the bounded backoff window
    await h.supervisor.checkHealth();
  }
  assert.equal(h.supervisor.status().state, "error");
  assert.equal(h.supervisor.status().reason, "agent host down");
  // Once latched, supervision stops hammering the host.
  const spawnsAtLatch = h.spawns.length;
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, spawnsAtLatch);
  await h.cleanup();
});

test("a changed hostInstanceId is observable (a restart is not a reconnect)", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.probes = [healthy({ instance: "host-9" })];
  await h.supervisor.checkHealth();
  assert.equal(h.supervisor.status().hostInstanceId, "host-9");
  await h.cleanup();
});

test("the host pid is in the kill guard's protected set", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  assert.deepEqual(h.supervisor.protectedPids(), [4242]);
  await h.cleanup();
});

test("the no-tmux fallback spawns a direct child and protects its pid", async () => {
  const h = await makeHarness([{ ok: false, reachable: false }, healthy()], { tmux: false });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 1);
  assert.ok(h.supervisor.protectedPids().includes(9191));
  await h.cleanup();
});

test("a throwing tmux spawn NEVER rejects out of checkHealth (it would kill the daemon)", async () => {
  // `checkHealth` runs behind a bare `void` on a 15 s interval. `transition()`
  // catches only its own queue copy, so a rejection here is unhandled — and
  // Node ≥15 exits the process on one, dropping every live terminal WebSocket
  // and `/events` stream. "duplicate session: orqsvc-agent-host" is the common
  // trigger: a kill racing the respawn.
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");

  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    h.probes = [{ ok: false, reachable: false }];
    h.spawnThrows = true;
    h.advance(120_000);
    await h.supervisor.checkHealth(); // miss 1 of 2 — no spawn yet
    h.advance(120_000);
    // Exactly how the interval calls it — the returned promise is discarded.
    void h.supervisor.checkHealth();
    // Let the microtask queue and one macrotask turn drain, which is when an
    // unhandled rejection would be reported.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, [], "a spawn failure must never reject out of checkHealth");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  // The `void`ed call is still in flight; a second call queues behind it, so
  // awaiting that proves the first settled — no sleeping on a guess.
  h.advance(120_000);
  await h.supervisor.checkHealth();
  // And it stays RETRYABLE — not latched — so the next tick tries again.
  assert.equal(h.supervisor.status().state, "stopped");
  assert.match(String(h.supervisor.status().reason), /spawn failed/);
  h.spawnThrows = false;
  h.probes = [healthy({ instance: "host-2" })];
  h.advance(120_000);
  await h.supervisor.checkHealth();
  assert.equal(h.supervisor.status().state, "healthy");
  await h.cleanup();
});

test("a spawn that throws during boot adoption leaves the supervisor retryable", async () => {
  const h = await makeHarness([{ ok: false, reachable: false }], { tmux: true, spawnThrows: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "stopped");
  assert.equal(h.supervisor.isHealthy(), false);
  await h.cleanup();
});

test("handleTurnSettled never rejects either", async () => {
  const h = await makeHarness([healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1 })], {
    seedToken: "tok",
    tmux: true
  });
  h.spawnThrows = true;
  await h.supervisor.init();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    h.supervisor.handleTurnSettled();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  await h.cleanup();
});

test("a leftover service session is killed before the respawn", async () => {
  // The branch that produces the duplicate-session throw above; the harness
  // used to hardcode `killFirst: false`, so it was never exercised.
  const h = await makeHarness([{ ok: false, reachable: false }, healthy()], {
    seedToken: "tok",
    tmux: true
  });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].killFirst, true, "a wedged host must not hold the socket");
  await h.cleanup();
});

test("a fresh spawn with no leftover session does NOT kill first", async () => {
  const h = await makeHarness([{ ok: false, reachable: false }, healthy()], { tmux: true });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].killFirst, false);
  await h.cleanup();
});

test("the drain-restart re-probes: a stale 'no active turn' never kills a live turn", async () => {
  // `handleTurnSettled` fires on ANY thread's turn settling, so the cached
  // health can be up to a 15 s interval old: probe at T shows no active turn,
  // thread A starts one at T+2 s, thread B settles at T+4 s — and the stale
  // empty list would kill the host with A's turn live.
  const h = await makeHarness([healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1 })], {
    seedToken: "tok",
    tmux: true
  });
  await h.supervisor.init();
  // Boot adopted with an empty list; the host is busy NOW.
  h.probes = [healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active: ["thread-A"] })];
  const spawnsAfterInit = h.spawns.length;
  h.supervisor.handleTurnSettled();
  // `checkHealth` queues behind the fire-and-forget transition, so awaiting it
  // proves that transition finished — no sleeping on a guess.
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, spawnsAfterInit, "a fresh probe showed a live turn — no restart");
  assert.equal(h.supervisor.status().pendingVersionRestart, true, "the restart is still owed");
  await h.cleanup();
});

test("one missed probe does NOT kill a healthy-but-busy host", async () => {
  // A host whose event loop is blocked past the 5 s probe timeout — a large
  // cold fold, a big readThread — looks exactly like a dead one. Restarting on
  // the first miss takes down every live turn.
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.probes = [{ ok: false, reachable: false }];
  h.advance(120_000);
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 0, "the first miss is not evidence of death");
  h.advance(120_000);
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 1, "two consecutive misses do restart it");
  await h.cleanup();
});

test("a busy host gets MORE patience before it is killed", async () => {
  const h = await makeHarness([healthy({ active: ["thread-A"] })], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.probes = [{ ok: false, reachable: false }];
  for (let i = 0; i < UNREACHABLE_PROBES_BEFORE_RESTART; i++) {
    h.advance(120_000);
    await h.supervisor.checkHealth();
  }
  assert.equal(h.spawns.length, 0, "the last good health reported an active turn");
  for (let i = UNREACHABLE_PROBES_BEFORE_RESTART; i < UNREACHABLE_PROBES_BEFORE_RESTART_BUSY; i++) {
    h.advance(120_000);
    await h.supervisor.checkHealth();
  }
  assert.equal(h.spawns.length, 1);
  await h.cleanup();
});

test("a single answered probe clears the missed-probe streak", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.probes = [{ ok: false, reachable: false }];
  h.advance(120_000);
  await h.supervisor.checkHealth();
  h.probes = [healthy()];
  h.advance(120_000);
  await h.supervisor.checkHealth();
  h.probes = [{ ok: false, reachable: false }];
  h.advance(120_000);
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 0, "the streak restarted, so this is miss 1 of 2");
  await h.cleanup();
});

test("the old host is given a grace window to EXIT before its session is killed — a closed socket is not enough", async () => {
  // `/stop` answers once the continuation markers are written; the teardown
  // that follows closes the SOCKET FIRST and only then stops the provider
  // children (§3.1: settle the turn, close every live task `stopped`, then
  // `session.exited`). Killing the tmux session the moment the socket went
  // quiet cut that teardown short — owner incident 2026-09-23: one "Task
  // stopped" row landed out of five, the other threads got nothing, and the
  // roster kept reading "running" for subagents that were already dead. The
  // supervisor therefore waits for the PROCESS: the service session ends when
  // its command exits.
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  h.hostExitsAfterPolls = 3;
  h.probeHook = () => {
    if (h.spawns.length > 0) return healthy({ instance: "host-2" });
    if (h.stopRequests === 0) return healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1 });
    // The socket is already closed: that is the first step of the teardown.
    return { ok: false, reachable: false };
  };
  await h.supervisor.init();
  assert.equal(h.stopRequests, 1);
  assert.equal(h.hostExitsAfterPolls, 0, "the supervisor polled until the process was gone");
  assert.equal(h.killedSessionWasAlive, false, "the kill came only after the session had ended");
  assert.equal(h.spawns.length, 1);
  await h.cleanup();
});

test("the grace window is bounded — a host that never exits is killed anyway", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  // Always answers healthy and its session never ends: it never exits.
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1 })
      : healthy({ instance: "host-2" });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 1, "the bounded grace lapsed and the restart proceeded");
  assert.equal(h.killedSessionWasAlive, true, "the wedged host was killed with its session alive");
  await h.cleanup();
});

test("case 3: live BACKGROUND work blocks the drain exactly like an active turn", async () => {
  // A subagent fleet or a background shell keeps running inside the provider
  // process after the turn that launched it settled (the host's liveness
  // registry, §3.1). The deploy of 2026-09-23 restarted the host the moment
  // the parent's turn settled and killed five subagents mid-work; the CLI
  // reported every one as "didn't finish before the previous session ended"
  // on the next message, and nothing had warned the user in between.
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let background: string[] = ["thread-1"];
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, background })
      : healthy({ instance: "host-2" });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy", "the fleet keeps running");
  assert.equal(h.spawns.length, 0, "no restart while a thread has live background work");
  assert.equal(h.supervisor.status().pendingVersionRestart, true);
  // A turn settling somewhere does not open the window: the fresh probe still
  // shows the work.
  h.supervisor.handleTurnSettled();
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 0);
  // The fleet finishes: the next health tick hands over.
  background = [];
  await h.supervisor.checkHealth();
  assert.equal(h.stopRequests, 1, "the old host writes its continuation markers");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  await h.cleanup();
});

test("an older host that omits the background field is still held by the daemon's own liveness view", async () => {
  // The host a deploy replaces predates `backgroundWorkThreadIds`. The
  // daemon's §6.4 summary poll already reads each thread's
  // `backgroundLiveness`, so the very next deploy after this fix must not
  // kill a fleet either.
  let daemonBackground: string[] = ["thread-1"];
  const h = await makeHarness([], {
    seedToken: "tok",
    tmux: true,
    daemonBackground: () => daemonBackground
  });
  h.probeHook = mismatchUntilReplaced(h);
  await h.supervisor.init();
  assert.equal(h.spawns.length, 0, "the daemon's own view blocks the drain");
  assert.equal(h.supervisor.status().pendingVersionRestart, true);
  daemonBackground = [];
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 1, "the fleet finished; the next tick hands over");
  await h.cleanup();
});

test("an older host is held while the daemon's view is still UNKNOWN — boot adoption runs before the first poll", async () => {
  // `init()` adopts and evaluates the drain before `AgentChatSummaryService`
  // has polled once. For a host that reports no background field, an empty
  // daemon view would read as "nothing running" and the very deploy shipping
  // this rule would still kill a fleet.
  let daemonView: readonly string[] | null = null;
  const h = await makeHarness([], { seedToken: "tok", tmux: true, daemonBackground: () => daemonView });
  h.probeHook = mismatchUntilReplaced(h);
  await h.supervisor.init();
  assert.equal(h.spawns.length, 0, "unknown is not 'none'");
  assert.equal(h.supervisor.status().pendingVersionRestart, true);
  daemonView = [];
  await h.supervisor.checkHealth();
  assert.equal(h.spawns.length, 1, "the first poll round found nothing running; hand over");
  await h.cleanup();
});

test("a host that reports the background field itself is never held by an unknown daemon view", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true, daemonBackground: () => null });
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, background: [] })
      : healthy({ instance: "host-2" });
  await h.supervisor.init();
  assert.equal(h.spawns.length, 1, "the host's own report is authoritative");
  await h.cleanup();
});

test("a host with only background work gets the same extra patience as a busy one", async () => {
  const h = await makeHarness([healthy({ background: ["thread-A"] })], {
    seedToken: "tok",
    tmux: true
  });
  await h.supervisor.init();
  h.probes = [{ ok: false, reachable: false }];
  for (let i = 0; i < UNREACHABLE_PROBES_BEFORE_RESTART; i++) {
    h.advance(120_000);
    await h.supervisor.checkHealth();
  }
  assert.equal(h.spawns.length, 0, "the last good health reported live background work");
  for (let i = UNREACHABLE_PROBES_BEFORE_RESTART; i < UNREACHABLE_PROBES_BEFORE_RESTART_BUSY; i++) {
    h.advance(120_000);
    await h.supervisor.checkHealth();
  }
  assert.equal(h.spawns.length, 1);
  await h.cleanup();
});

// Agent goals §5.7: a continuing Codex goal starts its next turn within
// milliseconds of the last, so a deploy's drain used to wait out the whole
// goal — possibly hours. While the drain is blocked the supervisor asks the
// host to hold its continuing goals between two turns, and keeps asking: the
// hold is a lease the host drops once the asking stops.

/** The supervisor's goal-hold lines at one level. */
function goalHoldLogs(h: Harness, level: "log" | "warn" = "log"): string[] {
  return h.logs.filter((line) => line.level === level && /goal/.test(line.text)).map((line) => line.text);
}

test("agent goals §5.7: every blocked drain evaluation asks the host to hold its continuing goals", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let active: string[] = ["thread-G"];
  let background: string[] = ["thread-F"];
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active, background })
      : healthy({ instance: "host-2" });
  await h.supervisor.init();
  assert.equal(h.holdRequests, 1, "boot adoption's own evaluation asks at once");
  assert.deepEqual(h.order.slice(-2), ["probe", "hold"], "asked only after a FRESH probe found the drain blocked");
  // A fleet in another tab blocks the drain too; whether goals are all that is
  // in the way is the host's call, so the daemon asks whatever the blocker.
  await h.supervisor.checkHealth();
  assert.equal(h.holdRequests, 2, "the 15 s health tick renews the lease");
  background = [];
  h.supervisor.handleTurnSettled();
  // Queued behind the settled turn's transition: awaiting it proves both ran.
  await h.supervisor.checkHealth();
  assert.equal(h.holdRequests, 4, "a settled turn, or ended background work, renews it too");
  assert.equal(h.spawns.length, 0, "nothing was cut while the drain was blocked");
  // The held goal's running turn settles and no next one starts: drained.
  active = [];
  h.supervisor.handleTurnSettled();
  await h.supervisor.checkHealth();
  assert.equal(h.stopRequests, 1, "the drain went ahead");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  assert.equal(h.holdRequests, 4, "a drained host is restarted, never asked to hold");
  await h.cleanup();
});

test("agent goals §5.7: no hold is asked for without a deploy waiting, or on a drained host", async () => {
  // Busy, but nothing is waiting on it.
  const idle = await makeHarness([healthy({ active: ["thread-G"] })], { seedToken: "tok", tmux: true });
  await idle.supervisor.init();
  await idle.supervisor.checkHealth();
  idle.supervisor.handleTurnSettled();
  await idle.supervisor.checkHealth();
  assert.equal(idle.holdRequests, 0, "no version restart is pending");
  await idle.cleanup();

  // A deploy is waiting on a host that is already drained: the restart goes ahead.
  const drained = await makeHarness([], { seedToken: "tok", tmux: true });
  drained.probeHook = mismatchUntilReplaced(drained);
  await drained.supervisor.init();
  assert.equal(drained.spawns.length, 1);
  assert.equal(drained.holdRequests, 0);
  await drained.cleanup();
});

test("agent goals §5.7: a manual restart never asks for a hold, even with a deploy's restart pending", async () => {
  // `POST /api/agent-host/stop` restarts at once; the host's `/stop` writes the
  // §5.5 resume marks that carry a continuing goal across it.
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  h.probeHook = mismatchUntilReplaced(h, ["thread-G"]);
  await h.supervisor.init();
  assert.equal(h.holdRequests, 1, "the blocked boot evaluation asked");
  await h.supervisor.restartNow();
  assert.equal(h.stopRequests, 1);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.holdRequests, 1, "the manual restart itself asked nothing");
  await h.cleanup();
});

test("agent goals §5.7: a failing hold request never stops the drain, and is logged once per reason", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let active: string[] = ["thread-G"];
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active })
      : healthy({ instance: "host-2" });
  let answer: () => Promise<readonly string[] | null> = () =>
    Promise.reject(new Error("agent host request timed out"));
  h.holdHook = () => answer();
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy", "a failed hold never fails boot adoption");
  await h.supervisor.checkHealth();
  h.supervisor.handleTurnSettled();
  await h.supervisor.checkHealth();
  assert.equal(h.holdRequests, 4, "every blocked evaluation still asks");
  assert.equal(goalHoldLogs(h, "warn").length, 1, "logged once, not on every tick");

  // A new reason is news — a synchronous throw included.
  const refused = (): never => {
    throw new Error("agent host answered 503 to the goal hold");
  };
  answer = refused;
  await h.supervisor.checkHealth();
  await h.supervisor.checkHealth();
  assert.equal(goalHoldLogs(h, "warn").length, 2);
  // So is the same reason again after an answer in between.
  answer = async () => [];
  await h.supervisor.checkHealth();
  answer = refused;
  await h.supervisor.checkHealth();
  assert.equal(goalHoldLogs(h, "warn").length, 3);

  // The goal's turn settles with the hold still failing: the drain goes ahead.
  active = [];
  await h.supervisor.checkHealth();
  assert.equal(h.stopRequests, 1);
  assert.equal(h.spawns.length, 1);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  assert.deepEqual(
    h.logs.filter((line) => line.level === "error"),
    [],
    "no hold failure ever escaped a transition"
  );
  await h.cleanup();
});

test("agent goals §5.7: a host that predates the route is not asked again, but another instance is", async () => {
  // The deploy that ships §5.7 finds a host without the route: its route-miss
  // 404 reads `null`, and that deploy waits as it always did.
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let instance = "host-1";
  h.probeHook = () =>
    healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active: ["thread-G"], instance });
  let answer: readonly string[] | null = null;
  h.holdHook = async () => answer;
  await h.supervisor.init();
  await h.supervisor.checkHealth();
  h.supervisor.handleTurnSettled();
  await h.supervisor.checkHealth();
  assert.equal(h.holdRequests, 1, "asked once, then remembered");
  assert.equal(goalHoldLogs(h).filter((line) => /predates/.test(line)).length, 1, "and said once");
  // Another instance — adopted in place, still stale, still busy — may know it.
  instance = "host-1b";
  answer = ["thread-G"];
  await h.supervisor.checkHealth();
  assert.equal(h.holdRequests, 2);
  assert.ok(goalHoldLogs(h).includes("agent host holding 1 continuing goal(s) for the restart"));
  await h.cleanup();
});

test("agent goals §5.7: the held set is logged when it changes, never per tick", async () => {
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  h.probeHook = () => healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active: ["thread-G"] });
  let held: readonly string[] = [];
  h.holdHook = async () => held;
  await h.supervisor.init();
  assert.deepEqual(goalHoldLogs(h), [], "nothing held is nothing to say");
  held = ["thread-G"];
  await h.supervisor.checkHealth();
  await h.supervisor.checkHealth();
  held = ["thread-H", "thread-G"];
  await h.supervisor.checkHealth();
  held = ["thread-G", "thread-H", "thread-G"]; // the same set, another spelling
  await h.supervisor.checkHealth();
  // The user took both back (`/goal …`, a Stop): the host holds nothing now.
  held = [];
  await h.supervisor.checkHealth();
  await h.supervisor.checkHealth();
  assert.deepEqual(goalHoldLogs(h), [
    "agent host holding 1 continuing goal(s) for the restart",
    "agent host holding 2 continuing goal(s) for the restart",
    "agent host no longer holding goals for the restart"
  ]);
  await h.cleanup();
});

test("agent goals §5.7: a hold in flight is never overtaken by the restart", async () => {
  // The hold is awaited inside the transition queue, so a turn settling while
  // the host is still pausing goals re-evaluates only once it has answered: a
  // `/stop` never races a hold the host is applying.
  const h = await makeHarness([], { seedToken: "tok", tmux: true });
  let active: string[] = ["thread-G"];
  h.probeHook = () =>
    h.spawns.length === 0
      ? healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active })
      : healthy({ instance: "host-2" });
  let asked!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let answer!: (held: readonly string[]) => void;
  h.holdHook = () => {
    asked();
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const booted = h.supervisor.init();
  await inFlight;
  active = [];
  h.supervisor.handleTurnSettled();
  // One event-loop turn: the fake probe and stop are pure microtasks, so a
  // restart that overtook the hold would already have asked for the stop.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.stopRequests, 0, "the settled turn waits for the hold's answer");
  answer(["thread-G"]);
  await booted;
  // Queued behind the settled turn's transition: awaiting it proves that ran.
  await h.supervisor.checkHealth();
  assert.equal(h.stopRequests, 1, "then the drained host is restarted");
  assert.equal(h.spawns.length, 1);
  assert.equal(h.holdRequests, 1, "and the drained evaluation asked nothing more");
  await h.cleanup();
});

test("the token is regenerated AFTER the old session is killed, never before", async () => {
  // §3.1: "regenerated only when no host is alive". Rewriting it while the old
  // host still answers leaves the daemon unable to authenticate to the host it
  // is waiting on.
  const h = await makeHarness([{ ok: false, reachable: false }, healthy()], {
    seedToken: "tok",
    tmux: true
  });
  await h.supervisor.init();
  assert.deepEqual(
    h.order.filter((step) => step !== "probe"),
    ["kill", "spawn"],
    "the leftover session is killed before anything else"
  );
  assert.notEqual(h.tokenAtSpawn, "tok", "the new host starts with a freshly minted token");
  assert.equal(h.tokenAtSpawn, h.supervisor.currentToken());
  await h.cleanup();
});

test("a moved providersRevision raises agent.providers.changed", async () => {
  // §4.6.4: the host's OWN session-start / background refresh must broadcast
  // too, not just the explicit refresh route.
  const h = await makeHarness([healthy({ providersRevision: 1 })], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  assert.equal(h.providerRevisions, 0, "the first sighting is not a change");
  h.probes = [healthy({ providersRevision: 1 })];
  await h.supervisor.checkHealth();
  assert.equal(h.providerRevisions, 0, "an unchanged revision is not an event");
  h.probes = [healthy({ providersRevision: 2 })];
  await h.supervisor.checkHealth();
  assert.equal(h.providerRevisions, 1);
  await h.cleanup();
});

test("an older host with no providersRevision never raises the event", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  h.probes = [healthy()];
  await h.supervisor.checkHealth();
  assert.equal(h.providerRevisions, 0);
  await h.cleanup();
});

test("the launch environment is built explicitly, never from process.env", () => {
  const env = buildAgentHostEnv({
    sessionPath: "/home/u/.local/bin:/usr/bin",
    tmpdir: "/var/lib/orquester/tmp",
    home: "/var/lib/orquester",
    npmConfigPrefix: "/var/lib/orquester/.npm-global",
    appdir: "/var/lib/orquester",
    socketPath: "/var/lib/orquester/daemon/agent-host.sock"
  });
  assert.equal(env.PATH, "/home/u/.local/bin:/usr/bin");
  assert.equal(env.TMPDIR, "/var/lib/orquester/tmp");
  assert.equal(env.HOME, "/var/lib/orquester");
  assert.equal(env.NPM_CONFIG_PREFIX, "/var/lib/orquester/.npm-global");
  assert.equal(env.ORQUESTER_APPDIR, "/var/lib/orquester");
  // Nothing else: the daemon's own environment holds the cliproxy and push
  // secrets, and the host must never inherit them.
  assert.equal(env.ORQUESTER_HTTP_PASSWORD, undefined);
  const optional = buildAgentHostEnv({
    sessionPath: "/usr/bin",
    appdir: "/a",
    socketPath: "/a/s.sock"
  });
  assert.equal(optional.TMPDIR, undefined);
  assert.equal(optional.HOME, undefined);
});
