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
  alive: boolean;
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
  logs: string[];
  /** Advance the mocked clock and fire due timers, then let the supervisor's queue drain. */
  passTime(ms: number): Promise<void>;
  registry(): Promise<AgentHostRegistryEntry[] | null>;
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
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
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

async function makeHarness(t: TestContext): Promise<Harness> {
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
    cleanup: async () => {
      h.supervisor.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
  const tmux: SupervisorTmux = {
    hasServiceSession: async (name) => h.sessions.has(name),
    killServiceSession: async (name) => {
      h.sessions.delete(name);
      const host = h.hosts.get(generationOfSession(name));
      if (host) host.alive = false;
    },
    newServiceSession: async ({ name, env }) => {
      const generation = Number(env[AGENT_HOST_ENV.generation]);
      const foreignPath = env[AGENT_HOST_ENV.foreignThreads];
      const foreign = foreignPath
        ? (JSON.parse(await readFile(foreignPath, "utf8")) as { threadIds: string[] }).threadIds
        : null;
      h.spawns.push({ generation, env, foreign });
      h.sessions.add(name);
      h.hosts.set(generation, fakeHost(generation, { instance: `host-g${generation}-spawn${h.spawns.length}`, alive: h.spawnReady }));
    }
  };
  const live = (generation: number): FakeHost | null => {
    const host = h.hosts.get(generation);
    return host?.alive ? host : null;
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
        return host.owned;
      },
      requestUnretire: async (generation) => {
        h.unretires.push(generation);
        const host = live(generation);
        if (!host) throw new Error("agent host unavailable");
        host.retiring = false;
        host.owned = [];
      },
      requestAdopt: (generation, threadId) => {
        h.adoptions.push([generation, threadId]);
        return h.adoptHook ? h.adoptHook(generation, threadId) : Promise.resolve("adopted");
      },
      tmux,
      spawnDirect: () => {
        throw new Error("this harness runs under tmux");
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

async function seedRegistry(h: Harness, entries: AgentHostRegistryEntry[]): Promise<void> {
  await writeHostRegistry(agentHostRegistryPath(h.dir), { entries, unparsed: [], extra: {} });
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
  // Released, but the poll has not seen it yet.
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
