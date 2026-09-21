import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_HOST_PROTOCOL_VERSION, AGENT_HOST_SERVICE_SESSION } from "../agent-host/host-protocol.ts";
import {
  AgentHostSupervisor,
  MAX_RESPAWNS,
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
  cleanup(): Promise<void>;
}

const healthy = (overrides: Partial<{ version: number; active: string[]; instance: string }> = {}): ProbeOutcome => ({
  ok: true,
  health: {
    ok: true,
    protocolVersion: overrides.version ?? AGENT_HOST_PROTOCOL_VERSION,
    hostInstanceId: overrides.instance ?? "host-1",
    liveThreadIds: [],
    activeTurnThreadIds: overrides.active ?? [],
    pid: 4242,
    startedAt: "2026-09-21T00:00:00.000Z"
  }
});

async function makeHarness(
  probes: ProbeOutcome[],
  opts: { tmux?: boolean; seedToken?: string } = {}
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
    advance: (ms) => {
      clock += ms;
    },
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
  let sessionExists = opts.tmux === true && opts.seedToken !== undefined;
  const tmux: SupervisorTmux | null =
    opts.tmux === false
      ? null
      : {
          hasServiceSession: async (name) => name === AGENT_HOST_SERVICE_SESSION && sessionExists,
          killServiceSession: async () => {
            sessionExists = false;
          },
          newServiceSession: async ({ args }) => {
            sessionExists = true;
            harness.spawns.push({ killFirst: false, args });
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
    adapters: {
      probe: async () => (harness.probes.length > 1 ? harness.probes.shift()! : harness.probes[0]),
      requestStop: async () => {
        harness.stopRequests++;
      },
      tmux,
      spawnDirect: (_bin, args) => {
        harness.spawns.push({ killFirst: false, args });
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
  const h = await makeHarness(
    [healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1 }), healthy({ instance: "host-2" })],
    { seedToken: "tok", tmux: true }
  );
  await h.supervisor.init();
  assert.equal(h.stopRequests, 1, "the old host writes its continuation markers first");
  assert.equal(h.spawns.length, 1, "a replacement is spawned");
  assert.equal(h.supervisor.status().state, "healthy");
  assert.equal(h.supervisor.status().pendingVersionRestart, false);
  assert.equal(h.supervisor.status().hostInstanceId, "host-2");
  await h.cleanup();
});

test("case 3: a version mismatch with an ACTIVE turn adopts and waits", async () => {
  const h = await makeHarness(
    [healthy({ version: AGENT_HOST_PROTOCOL_VERSION + 1, active: ["thread-1"] })],
    { seedToken: "tok", tmux: true }
  );
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy", "the in-flight turn keeps running");
  assert.equal(h.spawns.length, 0, "no restart while a thread has an active turn");
  assert.equal(h.supervisor.status().pendingVersionRestart, true);
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

test("health supervision respawns a dead host and latches error after the cap", async () => {
  const h = await makeHarness([healthy()], { seedToken: "tok", tmux: true });
  await h.supervisor.init();
  assert.equal(h.supervisor.status().state, "healthy");
  h.probes = [{ ok: false, reachable: false }];
  for (let i = 0; i < MAX_RESPAWNS; i++) {
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
