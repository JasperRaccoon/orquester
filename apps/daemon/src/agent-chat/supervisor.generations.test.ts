import { strict as assert } from "node:assert";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  agentHostForeignThreadsPath,
  agentHostRegistryPath,
  agentHostTokenPath,
  type AgentHostRegistryEntry
} from "@orquester/config";
import {
  AGENT_HOST_ENV,
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_RETIRE_MAX_MS,
  AGENT_HOST_UPDATE_GRACE_MS,
  agentHostServiceSession,
  type AgentHostCapabilities,
  type AgentHostHealthResponse
} from "../agent-host/host-protocol.ts";
import { writeHostRegistry } from "./host-registry.ts";
import { AgentHostSupervisor, RETIRING_HOST_POLL_MS, type ProbeOutcome, type SupervisorTmux } from "./supervisor.ts";

// Host updates (spec 2026-11-01 P2.4, P2.7 daemon tests): the multi-generation supervisor against
// fake hosts — one per generation, each in its own fake tmux session — with `mock.timers` driving
// the clock and every timer. No process is ever spawned.

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const FULL: AgentHostCapabilities = { continuationRevival: 1, retire: 1 };

interface FakeHost {
  generation: number;
  instance: string;
  /** Its process runs. */
  alive: boolean;
  /** …and answers `/health` (a busy or wedged host does not). */
  answers: boolean;
  protocolVersion: number;
  codeStamp: string;
  /** Threads with a running turn. */
  active: string[];
  retiring: boolean;
  /** What it owns while retiring. */
  owned: string[];
  capabilities: AgentHostCapabilities;
}

interface Harness {
  dir: string;
  supervisor: AgentHostSupervisor;
  hosts: Map<number, FakeHost>;
  sessions: Set<string>;
  spawns: Array<{ generation: number; env: Record<string, string>; foreign: string[] | null }>;
  stops: number[];
  retires: number[];
  unretires: number[];
  adoptions: Array<[number, string]>;
  /** What an adopt answers; absent = adopted at once. */
  adoptHook?: (generation: number, threadId: string) => Promise<"adopted" | "owned" | "missing">;
  /** Whether a spawned host comes up. */
  spawnReady: boolean;
  /** `tmux has-session` fails (tmux cannot tell). */
  tmuxBroken: boolean;
  /** No-tmux harness: the signals each direct child got, and the ones it dies of. */
  signals: Array<[number, string]>;
  directDiesOn: Set<string>;
  /** Runs inside `/retire` before the fake answers; may throw. */
  beforeRetire?: (host: FakeHost) => Promise<void>;
  unretireFails: boolean;
  /** Awaited by the spawn of a new tmux session, after `onSpawnStart`. */
  spawnGate?: Promise<void>;
  onSpawnStart?: () => void;
  logs: string[];
  /** Advance the mocked clock and fire due timers, then let the supervisor's queue drain. */
  passTime(ms: number): Promise<void>;
  registry(): Promise<AgentHostRegistryEntry[] | null>;
  pendingAdoptions(): Promise<string[]>;
  cleanup(): Promise<void>;
}

function generationOfSession(name: string): number {
  const prefix = `${agentHostServiceSession(0)}-`;
  return name.startsWith(prefix) ? Number(name.slice(prefix.length)) : 0;
}

function fakeHost(generation: number, fields: Partial<FakeHost> = {}): FakeHost {
  return {
    generation,
    instance: `host-g${generation}`,
    alive: true,
    answers: true,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    codeStamp: NEW,
    active: [],
    retiring: false,
    owned: [],
    capabilities: FULL,
    ...fields
  };
}

function healthOf(host: FakeHost): AgentHostHealthResponse {
  return {
    ok: true,
    protocolVersion: host.protocolVersion,
    hostInstanceId: host.instance,
    liveThreadIds: [],
    activeTurnThreadIds: host.active,
    backgroundWorkThreadIds: [],
    pendingWakes: [],
    pid: 1000 + host.generation,
    startedAt: "2026-11-01T00:00:00.000Z",
    codeStamp: host.codeStamp,
    capabilities: host.capabilities,
    generation: host.generation,
    retiring: host.retiring,
    ...(host.retiring ? { ownedThreadIds: host.owned } : {})
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  );
}

async function makeHarness(t: TestContext, opts: { direct?: boolean } = {}): Promise<Harness> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const dir = await mkdtemp(join(tmpdir(), "orq-host-gens-"));
  const h: Harness = {
    dir,
    supervisor: null as unknown as AgentHostSupervisor,
    hosts: new Map(),
    sessions: new Set(),
    spawns: [],
    stops: [],
    retires: [],
    unretires: [],
    adoptions: [],
    spawnReady: true,
    tmuxBroken: false,
    signals: [],
    directDiesOn: new Set(["SIGTERM", "SIGKILL"]),
    unretireFails: false,
    logs: [],
    passTime: async (ms) => {
      t.mock.timers.tick(ms);
      // Queued behind whatever the timers started; a current, healthy primary does nothing more.
      await h.supervisor.checkHealth();
    },
    registry: async () => {
      try {
        return (JSON.parse(await readFile(agentHostRegistryPath(dir), "utf8")) as { hosts: AgentHostRegistryEntry[] }).hosts;
      } catch {
        return null;
      }
    },
    pendingAdoptions: async () => {
      const raw = await readFile(agentHostRegistryPath(dir), "utf8");
      return (JSON.parse(raw) as { pendingAdoptions?: string[] }).pendingAdoptions ?? [];
    },
    cleanup: async () => {
      h.supervisor.stop();
      // An adoption that completed as the test ended may still be writing the registry: let that
      // write land (event-loop turns, no clock) before the directory goes.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt >= 50) throw error;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
  };
  // A spawned host's process runs; it answers only when `spawnReady`.
  const spawned = (generation: number, foreign: string[] | null, env: Record<string, string>): FakeHost => {
    h.spawns.push({ generation, env, foreign });
    const host = fakeHost(generation, { instance: `host-g${generation}-spawn${h.spawns.length}`, answers: h.spawnReady });
    h.hosts.set(generation, host);
    return host;
  };
  const foreignOf = async (env: Record<string, string>): Promise<string[] | null> => {
    const foreignPath = env[AGENT_HOST_ENV.foreignThreads];
    return foreignPath ? (JSON.parse(await readFile(foreignPath, "utf8")) as { threadIds: string[] }).threadIds : null;
  };
  const tmux: SupervisorTmux = {
    hasServiceSession: async (name) => {
      if (h.tmuxBroken) throw new Error("tmux has-session failed (1): lost server");
      return h.sessions.has(name);
    },
    listServiceSessions: async (prefix) => [...h.sessions].filter((name) => name.startsWith(prefix)),
    killServiceSession: async (name) => {
      h.sessions.delete(name);
      const host = h.hosts.get(generationOfSession(name));
      if (host) host.alive = false;
    },
    newServiceSession: async ({ name, env }) => {
      const generation = Number(env[AGENT_HOST_ENV.generation]);
      const foreign = await foreignOf(env);
      h.onSpawnStart?.();
      await h.spawnGate;
      h.sessions.add(name);
      spawned(generation, foreign, env);
    }
  };
  const live = (generation: number): FakeHost | null => {
    const host = h.hosts.get(generation);
    return host?.alive && host.answers ? host : null;
  };
  h.supervisor = new AgentHostSupervisor({
    appdir: dir,
    tokenPath: agentHostTokenPath(dir),
    cwd: dir,
    env: {},
    nodeBin: "/usr/bin/node",
    codeStamp: NEW,
    platform: "linux",
    adapters: {
      probe: async (generation): Promise<ProbeOutcome> => {
        const host = live(generation);
        return host ? { ok: true, health: healthOf(host) } : { ok: false, reachable: false };
      },
      requestStop: async (generation) => {
        h.stops.push(generation);
        const host = h.hosts.get(generation);
        if (host) host.alive = false;
        h.sessions.delete(agentHostServiceSession(generation));
      },
      requestRetire: async (generation) => {
        h.retires.push(generation);
        const host = live(generation);
        if (!host) throw new Error("agent host unavailable");
        host.retiring = true;
        host.owned = [...host.active];
        await h.beforeRetire?.(host);
        return host.owned;
      },
      requestUnretire: async (generation) => {
        h.unretires.push(generation);
        const host = live(generation);
        if (!host || h.unretireFails) throw new Error("agent host unavailable");
        host.retiring = false;
        host.owned = [];
      },
      requestAdopt: (generation, threadId) => {
        h.adoptions.push([generation, threadId]);
        return h.adoptHook ? h.adoptHook(generation, threadId) : Promise.resolve("adopted");
      },
      tmux: opts.direct ? null : tmux,
      spawnDirect: (_bin, _args, env) => {
        if (!opts.direct) throw new Error("this harness runs under tmux");
        const generation = Number(env[AGENT_HOST_ENV.generation]);
        const host = spawned(generation, null, env);
        return {
          pid: 2000 + generation,
          kill: (signal) => {
            h.signals.push([generation, signal ?? "SIGTERM"]);
            if (h.directDiesOn.has(signal ?? "SIGTERM")) host.alive = false;
          },
          isAlive: () => host.alive
        };
      },
      now: () => Date.now(),
      sleep: async (ms) => {
        t.mock.timers.tick(ms);
      },
      logger: {
        log: (...a) => h.logs.push(a.join(" ")),
        warn: (...a) => h.logs.push(a.join(" ")),
        error: (...a) => h.logs.push(a.join(" "))
      }
    }
  });
  return h;
}

/** A host left running by a previous daemon: its session, its token file. */
async function seedHost(h: Harness, host: FakeHost): Promise<void> {
  h.hosts.set(host.generation, host);
  h.sessions.add(agentHostServiceSession(host.generation));
  const path = agentHostTokenPath(h.dir, host.generation);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `tok-${host.generation}\n`, { mode: 0o600 });
}

async function seedRegistry(h: Harness, entries: AgentHostRegistryEntry[], pendingAdoptions: string[] = []): Promise<void> {
  await writeHostRegistry(agentHostRegistryPath(h.dir), { entries, unparsed: [], extra: {}, pendingAdoptions });
}

/** Generation 0, stale and running a turn in `t-busy`: what a deploy finds. */
async function staleBusyPrimary(h: Harness, fields: Partial<FakeHost> = {}): Promise<void> {
  await seedHost(h, fakeHost(0, { codeStamp: OLD, active: ["t-busy"], ...fields }));
}

test("update flow: a busy stale primary retires, keeping its working chats, while the next generation serves the rest", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();

  assert.deepEqual(h.retires, [0]);
  assert.deepEqual(h.stops, [], "nothing is interrupted");
  assert.equal(h.spawns.length, 1);
  const [spawn] = h.spawns;
  assert.equal(spawn!.generation, 1);
  assert.deepEqual(spawn!.foreign, ["t-busy"], "I3: the new host never touches what the old one keeps");
  assert.equal(spawn!.env[AGENT_HOST_ENV.tokenPath], agentHostTokenPath(h.dir, 1));
  assert.notEqual(spawn!.env[AGENT_HOST_ENV.socket], undefined);
  assert.equal(h.sessions.has(agentHostServiceSession(0)), true, "the old host keeps running");

  assert.equal(h.supervisor.primary()?.generation, 1);
  assert.deepEqual(
    h.supervisor.hosts().map((host) => [host.generation, host.role]),
    [
      [1, "primary"],
      [0, "retiring"]
    ]
  );
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 0);
  assert.equal((await h.supervisor.hostForThread("t-other"))?.generation, 1);
  assert.equal(h.supervisor.restartStatus().pendingRestart, null, "the update is applied: no restart pending");
  assert.deepEqual(h.supervisor.restartStatus().retiringHosts?.map((host) => [host.generation, host.threads]), [
    [0, [{ threadId: "t-busy" }]]
  ]);
  assert.equal(h.supervisor.hostTokens().length, 2, "both hosts may call the daemon back");
  assert.deepEqual(
    (await h.registry())?.map(({ generation, role, ownedThreadIds }) => ({ generation, role, ownedThreadIds })),
    [
      { generation: 0, role: "retiring", ownedThreadIds: ["t-busy"] },
      { generation: 1, role: "primary", ownedThreadIds: undefined }
    ]
  );
  await h.cleanup();
});

test("update flow: a replacement that never becomes ready is killed, the old host unretired, the registry restored — then Phase 1", async (t) => {
  const h = await makeHarness(t);
  h.spawnReady = false;
  await staleBusyPrimary(h);
  await h.supervisor.init();

  assert.deepEqual(h.retires, [0]);
  assert.deepEqual(h.unretires, [0]);
  assert.equal(h.sessions.has(agentHostServiceSession(1)), false, "the failed replacement is killed");
  assert.equal(await exists(agentHostTokenPath(h.dir, 1)), false);
  assert.equal(h.supervisor.primary()?.generation, 0, "the old host serves everything again");
  assert.deepEqual((await h.registry())?.map(({ generation, role }) => ({ generation, role })), [{ generation: 0, role: "primary" }]);
  const pending = h.supervisor.restartStatus().pendingRestart;
  assert.notEqual(pending, null, "the Phase 1 fallback: a restart is pending");
  assert.notEqual(pending?.restartsAt, null, "…bounded by the update grace");

  // Not retried on every evaluation: the grace restarts it through /stop.
  h.spawnReady = true;
  await h.passTime(AGENT_HOST_UPDATE_GRACE_MS);
  assert.deepEqual(h.retires, [0]);
  assert.deepEqual(h.stops, [0]);
  assert.equal(h.supervisor.status().state, "healthy");
  await h.cleanup();
});

test("release → adopt: a thread the retiring host releases is adopted by the primary before any request reaches it there", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h, { active: ["t-a", "t-b"] });
  await h.supervisor.init();
  const order: string[] = [];
  let finishAdoption: () => void = () => undefined;
  h.adoptHook = (_generation, threadId) => {
    order.push(`adopt ${threadId}`);
    return new Promise((resolve) => {
      finishAdoption = () => {
        order.push(`adopted ${threadId}`);
        resolve("adopted");
      };
    });
  };

  const old = h.hosts.get(0)!;
  old.owned = ["t-b"];
  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.deepEqual(h.adoptions, [[1, "t-a"]], "adopted on the primary");
  const routed = h.supervisor.hostForThread("t-a").then((host) => {
    order.push(`routed to ${host?.generation}`);
    return host;
  });
  finishAdoption();
  assert.equal((await routed)?.generation, 1);
  assert.deepEqual(order, ["adopt t-a", "adopted t-a", "routed to 1"], "I2: adopt happens-before the primary gets the thread");
  assert.equal((await h.supervisor.hostForThread("t-b"))?.generation, 0, "what it still owns stays there");
  assert.deepEqual((await h.registry())?.find((entry) => entry.generation === 0)?.ownedThreadIds, ["t-b"]);
  await h.cleanup();
});

test("release → adopt: a failed adoption is retried with backoff, never dropped", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  let failures = 2;
  h.adoptHook = async () => {
    if (failures-- > 0) throw new Error("agent host answered 503 to the adopt");
    return "adopted";
  };
  h.hosts.get(0)!.owned = [];
  h.hosts.get(0)!.active = [];
  await h.passTime(RETIRING_HOST_POLL_MS);
  await h.passTime(1_000);
  await h.passTime(2_000);
  assert.deepEqual(h.adoptions, [
    [1, "t-busy"],
    [1, "t-busy"],
    [1, "t-busy"]
  ]);
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 1);
  await h.cleanup();
});

test("a 409 THREAD_NOT_OWNED from the retiring host adopts the thread before the caller retries", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  // A 409 alone moves nothing while the retiring host still lists the thread as its own (I1).
  await h.supervisor.ownershipStale("t-busy", 0);
  assert.deepEqual(h.adoptions, []);
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 0);
  // Released, but the poll has not seen it yet.
  h.hosts.get(0)!.owned = [];
  await h.supervisor.ownershipStale("t-busy", 0);
  assert.deepEqual(h.adoptions, [[1, "t-busy"]]);
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 1);
  await h.cleanup();
});

test("exit: a retiring host that owns nothing is stopped, its session, socket, token and foreign file removed, and its record dropped", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  const old = h.hosts.get(0)!;
  old.owned = [];
  old.active = [];
  await h.passTime(RETIRING_HOST_POLL_MS);

  assert.deepEqual(h.stops, [0]);
  assert.equal(h.sessions.has(agentHostServiceSession(0)), false);
  assert.equal(await exists(agentHostTokenPath(h.dir, 0)), false);
  assert.deepEqual(h.adoptions, [[1, "t-busy"]], "its last thread was released, then adopted");
  assert.deepEqual(h.supervisor.hosts().map((host) => host.generation), [1]);
  assert.deepEqual((await h.registry())?.map(({ generation, role }) => ({ generation, role })), [{ generation: 1, role: "primary" }]);
  await h.cleanup();
});

test("supervision: a retiring host that dies has its last-known threads adopted by the primary", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h, { active: ["t-a", "t-b"] });
  await h.supervisor.init();
  h.hosts.get(0)!.alive = false;
  h.sessions.delete(agentHostServiceSession(0));
  await h.passTime(RETIRING_HOST_POLL_MS);

  assert.deepEqual(h.stops, [], "a dead host is not asked to stop");
  assert.deepEqual(h.adoptions.sort(), [
    [1, "t-a"],
    [1, "t-b"]
  ]);
  assert.deepEqual(h.supervisor.hosts().map((host) => host.generation), [1]);
  assert.deepEqual(h.supervisor.protectedPids(), [1001]);
  await h.cleanup();
});

test("the cap: a host retiring for 12 h is stopped (its /stop marks what it cuts) and its threads adopted", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  const status = h.supervisor.restartStatus().retiringHosts?.[0];
  assert.equal(status?.endsAt, new Date(Date.now() + AGENT_HOST_RETIRE_MAX_MS).toISOString());
  await h.passTime(AGENT_HOST_RETIRE_MAX_MS - RETIRING_HOST_POLL_MS);
  assert.deepEqual(h.stops, []);
  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.deepEqual(h.stops, [0]);
  assert.deepEqual(h.adoptions, [[1, "t-busy"]]);
  assert.deepEqual(h.supervisor.hosts().map((host) => host.generation), [1]);
  await h.cleanup();
});

test("restart now ends every retiring host, and leaves a current primary running", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  const instance = await h.supervisor.restartNow();
  assert.deepEqual(h.stops, [0]);
  assert.equal(instance, h.hosts.get(1)!.instance);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.adoptions, [[1, "t-busy"]]);
  await h.cleanup();
});

test("more than 3 retiring hosts: the oldest is ended through the cap path before the next retires", async (t) => {
  const h = await makeHarness(t);
  const since = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  for (const [generation, thread] of [
    [0, "t-0"],
    [1, "t-1"],
    [2, "t-2"]
  ] as const) {
    await seedHost(h, fakeHost(generation, { codeStamp: OLD, retiring: true, owned: [thread], active: [thread] }));
  }
  await seedHost(h, fakeHost(3, { codeStamp: OLD, active: ["t-3"] }));
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: since(3), ownedThreadIds: ["t-0"] },
    { generation: 1, role: "retiring", retiringSince: since(2), ownedThreadIds: ["t-1"] },
    { generation: 2, role: "retiring", retiringSince: since(1), ownedThreadIds: ["t-2"] },
    { generation: 3, role: "primary" }
  ]);
  await h.supervisor.init();

  assert.deepEqual(h.stops, [0], "the oldest retiring host is ended first");
  assert.deepEqual(h.adoptions, [[3, "t-0"]], "…its chat adopted (by the primary of that moment)");
  assert.equal(h.spawns[0]?.generation, 4);
  assert.deepEqual(h.spawns[0]?.foreign, ["t-1", "t-2", "t-3"]);
  assert.deepEqual(
    h.supervisor.hosts().map((host) => [host.generation, host.role]),
    [
      [4, "primary"],
      [3, "retiring"],
      [2, "retiring"],
      [1, "retiring"]
    ]
  );
  await h.cleanup();
});

test("daemon restart: every recorded host is adopted in its role; threads released or owned by a gone host are adopted", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(1));
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"] }));
  await seedRegistry(h, [
    // Released t-b while no daemon watched.
    { generation: 0, role: "retiring", retiringSince: new Date(Date.now() - 60_000).toISOString(), ownedThreadIds: ["t-a", "t-b"] },
    { generation: 1, role: "primary" },
    // Died while no daemon watched.
    { generation: 2, role: "retiring", retiringSince: new Date(Date.now() - 60_000).toISOString(), ownedThreadIds: ["t-c"] }
  ]);
  await h.supervisor.init();

  assert.equal(h.spawns.length, 0, "the live primary is adopted, not respawned");
  assert.equal(h.supervisor.primary()?.generation, 1);
  assert.equal((await h.supervisor.hostForThread("t-a"))?.generation, 0);
  assert.deepEqual(h.adoptions.sort(), [
    [1, "t-b"],
    [1, "t-c"]
  ]);
  assert.deepEqual((await h.registry())?.map(({ generation, role }) => ({ generation, role })), [
    { generation: 0, role: "retiring" },
    { generation: 1, role: "primary" }
  ]);
  await h.cleanup();
});

test("daemon restart: a primary gone while a retiring host lives is respawned as a NEW generation that leaves its chats alone", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"] }));
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: new Date().toISOString(), ownedThreadIds: ["t-a"] },
    { generation: 1, role: "primary" }
  ]);
  await h.supervisor.init();

  assert.deepEqual(
    h.spawns.map((spawn) => [spawn.generation, spawn.foreign]),
    [[2, ["t-a"]]],
    "never a host that reconciles every thread"
  );
  assert.equal(h.supervisor.primary()?.generation, 2);
  assert.equal((await h.supervisor.hostForThread("t-a"))?.generation, 0);
  await h.cleanup();
});

test("daemon restart: a host that came up mid-update (recorded as starting) is the primary", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"] }));
  await seedHost(h, fakeHost(1));
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: new Date().toISOString(), ownedThreadIds: ["t-a"] },
    { generation: 1, role: "starting" }
  ]);
  await h.supervisor.init();

  assert.equal(h.spawns.length, 0);
  assert.equal(h.supervisor.primary()?.generation, 1);
  assert.deepEqual((await h.registry())?.map(({ generation, role }) => ({ generation, role })), [
    { generation: 0, role: "retiring" },
    { generation: 1, role: "primary" }
  ]);
  await h.cleanup();
});

test("daemon restart: a dead mid-update host is discarded; its retiring predecessor keeps its chats under a new primary", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"] }));
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: new Date().toISOString(), ownedThreadIds: ["t-a"] },
    { generation: 1, role: "starting" }
  ]);
  await h.supervisor.init();

  assert.deepEqual(h.spawns.map((spawn) => [spawn.generation, spawn.foreign]), [[2, ["t-a"]]]);
  assert.equal(await exists(agentHostForeignThreadsPath(h.dir, 1)), false);
  await h.cleanup();
});

test("no registry: the single-host boot is unchanged and writes none", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(0));
  await h.supervisor.init();
  assert.equal(h.supervisor.primary()?.generation, 0);
  assert.equal(h.spawns.length, 0);
  await h.supervisor.restartNow();
  assert.deepEqual(h.spawns.map((spawn) => [spawn.generation, spawn.foreign]), [[0, null]], "in place, as before generations");
  assert.equal(await h.registry(), null);
  await h.cleanup();
});

test("a stale busy host without the retire capability is never retired", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h, { capabilities: { continuationRevival: 1, retire: 0 } });
  await h.supervisor.init();
  assert.deepEqual(h.retires, []);
  assert.equal(h.spawns.length, 0);
  assert.notEqual(h.supervisor.restartStatus().pendingRestart, null);
  await h.cleanup();
});

test("update flow, no tmux: the old host is unretired only once the failed replacement is confirmed gone — SIGKILL after SIGTERM", async (t) => {
  const h = await makeHarness(t, { direct: true });
  h.spawnReady = false;
  // A child that outlives both signals (its SIGTERM teardown would write the chats it took).
  h.directDiesOn = new Set();
  await staleBusyPrimary(h);
  await h.supervisor.init();

  assert.deepEqual(h.signals, [
    [1, "SIGTERM"],
    [1, "SIGKILL"]
  ]);
  assert.deepEqual(h.unretires, [], "I1: the old host takes nothing back while the new one may run");
  assert.equal(h.supervisor.status().state, "error");
  assert.equal(h.supervisor.primary(), null);
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 0, "what the old host kept stays served");

  h.hosts.get(1)!.alive = false;
  await h.passTime(30_000);
  assert.deepEqual(h.unretires, [0]);
  assert.equal(h.supervisor.primary()?.generation, 0);
  await h.cleanup();
});

test("update flow: a /retire that failed on a host that cannot be unretired restarts it (Phase 1), never leaving a retired primary", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  // The retire landed; its answer was lost.
  h.beforeRetire = async () => {
    throw new Error("socket hang up");
  };
  h.unretireFails = true;
  await h.supervisor.init();

  assert.ok(h.unretires.length > 1, "the unretire is retried");
  assert.deepEqual(h.stops, [0], "then the old host is stopped: its /stop marks what it kept for continuation");
  assert.deepEqual(h.spawns.map((spawn) => spawn.generation), [0]);
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.hosts.get(0)?.retiring, false, "the primary is the new, unretired host");
  await h.cleanup();
});

test("routing: a request for a chat the old host keeps goes there as soon as /retire answers, not after the switch", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  let answerRetire: () => void = () => undefined;
  const retireAnswered = new Promise<void>((resolve) => {
    answerRetire = resolve;
  });
  let retireAsked: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => {
    retireAsked = resolve;
  });
  h.beforeRetire = () => {
    retireAsked();
    return retireAnswered;
  };
  let openSpawn: () => void = () => undefined;
  h.spawnGate = new Promise((resolve) => {
    openSpawn = resolve;
  });
  const spawnStarted = new Promise<void>((resolve) => {
    h.onSpawnStart = resolve;
  });
  const booted = h.supervisor.init();
  await asked;
  let routed: number | null | undefined;
  void h.supervisor.hostForThread("t-busy").then((host) => {
    routed = host?.generation ?? null;
  });
  answerRetire();
  await spawnStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routed, 0, "served by the old host while the new one is still starting");
  openSpawn();
  await booted;
  await h.cleanup();
});

test("supervision: a silent retiring host whose death tmux cannot confirm keeps its chats until it can", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  h.hosts.get(0)!.answers = false;
  h.tmuxBroken = true;

  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.deepEqual(h.adoptions, [], "a tmux error is no death");
  await h.passTime(60_000);
  assert.deepEqual(h.adoptions, [], "silent for a minute: killed, but its exit cannot be confirmed — nothing moves (I1)");
  assert.equal((await h.supervisor.hostForThread("t-busy"))?.generation, 0);
  assert.equal(typeof h.supervisor.restartStatus().retiringHosts?.[0]?.stopUnconfirmedSince, "string");

  h.tmuxBroken = false;
  await h.passTime(30_000);
  assert.deepEqual(h.adoptions, [[1, "t-busy"]]);
  assert.deepEqual(h.supervisor.hosts().map((host) => host.generation), [1]);
  await h.cleanup();
});

test("daemon restart: a retiring host that misses its first probe is kept — the poll's patience decides, not one timeout", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(1));
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"], answers: false }));
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: new Date().toISOString(), ownedThreadIds: ["t-a"] },
    { generation: 1, role: "primary" }
  ]);
  await h.supervisor.init();

  assert.equal(h.sessions.has(agentHostServiceSession(0)), true, "not killed");
  assert.deepEqual(h.adoptions, []);
  assert.equal((await h.supervisor.hostForThread("t-a"))?.generation, 0);
  h.hosts.get(0)!.answers = true;
  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.equal(h.supervisor.restartStatus().retiringHosts?.[0]?.hostInstanceId, "host-g0");
  await h.cleanup();
});

test("daemon restart: a retiring host of another protocol version is ended through the cap path and its chats adopted", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(1));
  await seedHost(
    h,
    fakeHost(0, { protocolVersion: AGENT_HOST_PROTOCOL_VERSION + 1, retiring: true, owned: ["t-a"], active: ["t-a"] })
  );
  await seedRegistry(h, [
    { generation: 0, role: "retiring", retiringSince: new Date().toISOString(), ownedThreadIds: ["t-a"] },
    { generation: 1, role: "primary" }
  ]);
  await h.supervisor.init();

  assert.deepEqual(h.stops, [0], "its /stop marks what it cuts for continuation");
  assert.deepEqual(h.adoptions, [[1, "t-a"]]);
  assert.deepEqual(h.supervisor.hosts().map((host) => host.generation), [1]);
  await h.cleanup();
});

test("I5: a released chat stays in the registry until its adoption completes", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  let finish: () => void = () => undefined;
  h.adoptHook = () =>
    new Promise((resolve) => {
      finish = () => resolve("adopted");
    });
  h.hosts.get(0)!.owned = [];
  h.hosts.get(0)!.active = [];
  await h.passTime(RETIRING_HOST_POLL_MS);

  assert.deepEqual(await h.pendingAdoptions(), ["t-busy"], "a daemon that dies now still adopts it at boot");
  finish();
  await h.supervisor.hostForThread("t-busy");
  assert.deepEqual(await h.pendingAdoptions(), []);
  await h.cleanup();
});

test("daemon restart: adoptions the previous daemon did not see complete are adopted at boot", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(1));
  await seedRegistry(h, [{ generation: 1, role: "primary" }], ["t-x"]);
  await h.supervisor.init();
  assert.deepEqual(h.adoptions, [[1, "t-x"]]);
  await h.supervisor.hostForThread("t-x");
  assert.deepEqual(await h.pendingAdoptions(), []);
  await h.cleanup();
});

test("a chat whose adoption keeps failing is listed on the status page until it lands, and still retried", async (t) => {
  const h = await makeHarness(t);
  await staleBusyPrimary(h);
  await h.supervisor.init();
  let failing = true;
  h.adoptHook = async () => {
    if (failing) throw new Error("agent host answered 503 to the adopt");
    return "adopted";
  };
  h.hosts.get(0)!.owned = [];
  h.hosts.get(0)!.active = [];
  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.equal(h.supervisor.restartStatus().stuckAdoptions, undefined, "one failure is not reported yet");
  for (const ms of [1_000, 2_000, 4_000, 8_000]) await h.passTime(ms);
  assert.deepEqual(h.supervisor.restartStatus().stuckAdoptions?.map((stuck) => stuck.threadId), ["t-busy"]);

  failing = false;
  await h.passTime(16_000);
  await h.supervisor.hostForThread("t-busy");
  assert.equal(h.supervisor.restartStatus().stuckAdoptions, undefined);
  await h.cleanup();
});

test("daemon restart, unreadable registry: live hosts are accounted for from their own health; one that cannot be blocks the boot", async (t) => {
  const h = await makeHarness(t);
  await seedHost(h, fakeHost(1));
  await seedHost(h, fakeHost(0, { codeStamp: OLD, retiring: true, owned: ["t-a"], active: ["t-a"] }));
  await seedHost(h, fakeHost(2, { answers: false }));
  await writeFile(agentHostRegistryPath(h.dir), "{ not json");
  await h.supervisor.init();

  assert.equal(h.supervisor.status().state, "error", "generation 2 runs and cannot say what it owns");
  assert.equal(h.supervisor.primary(), null);
  assert.equal(h.spawns.length, 0, "no host is started that would own its chats");

  h.hosts.get(2)!.alive = false;
  h.sessions.delete(agentHostServiceSession(2));
  await h.passTime(15_000);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.supervisor.primary()?.generation, 1);
  assert.equal((await h.supervisor.hostForThread("t-a"))?.generation, 0, "the retiring host keeps its chat");
  await h.cleanup();
});

test("I1/I4: an adoption in backoff when its primary retires keeping the chat never reaches the new primary", async (t) => {
  const h = await makeHarness(t);
  // The previous daemon left t-busy's adoption pending; the stale, busy primary runs it now.
  await staleBusyPrimary(h);
  await seedRegistry(h, [{ generation: 0, role: "primary" }], ["t-busy"]);
  let calls = 0;
  h.adoptHook = async () => {
    calls += 1;
    if (calls === 1) throw new Error("agent host did not answer the adopt within 30 s");
    return "adopted";
  };
  await h.supervisor.init();
  assert.equal(h.supervisor.primary()?.generation, 1, "the update retired generation 0, keeping t-busy");

  await h.passTime(1_000);
  await h.passTime(2_000);
  assert.deepEqual(h.adoptions, [[0, "t-busy"]], "the retry is dropped: generation 0 still runs t-busy");
  assert.deepEqual(await h.pendingAdoptions(), []);

  // Its release starts a fresh adoption.
  h.hosts.get(0)!.owned = [];
  await h.passTime(RETIRING_HOST_POLL_MS);
  assert.deepEqual(h.adoptions, [
    [0, "t-busy"],
    [1, "t-busy"]
  ]);
  await h.cleanup();
});

test("daemon restart: a respawned primary boots with pending adoptions as foreign, and adopts them", async (t) => {
  const h = await makeHarness(t);
  await seedRegistry(h, [{ generation: 0, role: "primary" }], ["t-x"]);
  await h.supervisor.init();
  assert.deepEqual(
    h.spawns.map((spawn) => [spawn.generation, spawn.foreign]),
    [[0, ["t-x"]]],
    "t-x reaches it through /adopt, which sweeps what its previous host left, not its boot reconcile"
  );
  assert.deepEqual(h.adoptions, [[0, "t-x"]]);
  await h.cleanup();
});
