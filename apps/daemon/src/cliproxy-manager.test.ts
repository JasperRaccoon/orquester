import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CliProxyModelOverrides,
  type CliProxyState,
  type RouterProvider,
  cliproxyDir,
  cliproxySecretsFile,
  cliproxyStateFile,
  createDefaultCliProxyState,
  migrateLegacyOpenRouter,
  parseCliProxyState
} from "@orquester/config";
import Fastify from "fastify";
import { writeProjections } from "./cliproxy-files.ts";
import { setRouterKey as realSetRouterKey } from "./cliproxy-secrets.ts";
import type { CliProxyProviderStatus, CliProxyStatus, CliProxyXaiLink } from "@orquester/api";
import { SYSTEM_ACCOUNT_ID } from "@orquester/api";
import type { RegistryService } from "./registry.ts";
import { Broadcaster } from "./broadcaster.ts";
import { CliProxyManager } from "./cliproxy.ts";
import type { XaiManagementApi } from "./cliproxy-xai.ts";
import {
  cliproxyContributor,
  composeExtraEnv,
  registerCliProxyRoutes,
  resolveLaunchModel
} from "./index.ts";

type ProbeResult = { ok: boolean; reachable?: boolean; models?: string[] };

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (payload: object) => `x.${b64url(payload)}.y`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orq-cliproxy-mgr-"));
  const daemonDir = join(root, "daemon");

  const registryCalls: Array<{ id: string; enabled: boolean; disabledReason?: string }> = [];
  const registry = {
    setRuntimeState: (id: string, s: { enabled: boolean; disabledReason?: string }) => {
      registryCalls.push({ id, enabled: s.enabled, disabledReason: s.disabledReason });
    },
    reresolve: async (_id: string) => {}
  } as unknown as RegistryService;

  const events: Array<{ type: string; payload: unknown }> = [];
  const broadcaster = new Broadcaster();
  broadcaster.add({ send: (d) => events.push(JSON.parse(d)) });

  let hasService = false;
  const tmuxCalls = { newService: 0, killService: 0 };
  const tmux = {
    newServiceSession: async () => {
      tmuxCalls.newService++;
    },
    hasServiceSession: async () => hasService,
    killServiceSession: async () => {
      tmuxCalls.killService++;
    }
  };

  let probeResult: ProbeResult = { ok: false, reachable: false };
  let probeFn: (() => Promise<ProbeResult>) | null = null;
  const probe = async (): Promise<ProbeResult> => (probeFn ? probeFn() : probeResult);

  let clock = Date.now();
  let liveCount = 0;

  let installCount = 0;
  let installImpl: () => Promise<{ version: string }> = async () => {
    installCount++;
    await writeBin(daemonDir);
    return { version: "v7.2.95" };
  };
  let rollbackCount = 0;
  let rollbackImpl: () => Promise<boolean> = async () => false;
  let verifyRouterImpl: (
    provider: RouterProvider,
    key: string
  ) => Promise<"ok" | "rejected" | "unknown"> = async () => "unknown";
  let fetchRouterModelsImpl: (
    provider: RouterProvider,
    key: string
  ) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }> = async () => ({
    ok: false,
    error: "not stubbed"
  });
  const sysDir = join(root, "sysclaude");

  // xAI device flow: the management API is faked wholesale (no network, no proxy).
  let xaiLive: number | null = null;
  const xaiCalls = { authUrl: 0, poll: 0, cancel: [] as string[] };
  let authUrlImpl: XaiManagementApi["requestAuthUrl"] = async () => ({ ok: false, error: "not stubbed" });
  let pollImpl: XaiManagementApi["pollAuthStatus"] = async () => ({ ok: true, value: { status: "wait" } });
  const xaiManagement: XaiManagementApi = {
    requestAuthUrl: (port, secret) => {
      xaiCalls.authUrl++;
      return authUrlImpl(port, secret);
    },
    pollAuthStatus: (port, secret, state) => {
      xaiCalls.poll++;
      return pollImpl(port, secret, state);
    },
    cancelSession: async (_port, _secret, state) => {
      xaiCalls.cancel.push(state);
    }
  };

  const mgr = new CliProxyManager({
    daemonDir,
    appdir: root,
    registry,
    broadcaster,
    adapters: {
      probe,
      tmux,
      spawnDirect: () => null,
      liveDependentSessionCount: () => liveCount,
      liveXaiSessionCount: () => (xaiLive === null ? liveCount : xaiLive),
      xaiManagement,
      now: () => clock,
      sleep: async () => {},
      verifyRouterKey: (provider: RouterProvider, key: string) => verifyRouterImpl(provider, key),
      fetchRouterModels: (provider: RouterProvider, key: string) => fetchRouterModelsImpl(provider, key),
      install: () => installImpl(),
      rollback: () => {
        rollbackCount++;
        return rollbackImpl();
      },
      systemClaudeDir: () => sysDir,
      systemClaudeConfigFile: () => join(sysDir, ".claude.json"),
      managedCredentialPath: (provider: "codex" | "claude", accountId: string) =>
        join(root, "managed-creds", `${provider}-${accountId}.json`)
    }
  });

  return {
    mgr,
    root,
    daemonDir,
    registryCalls,
    events,
    tmuxCalls,
    setHasService: (v: boolean) => {
      hasService = v;
    },
    setProbe: (r: ProbeResult) => {
      probeResult = r;
      probeFn = null;
    },
    setProbeFn: (f: () => Promise<ProbeResult>) => {
      probeFn = f;
    },
    advance: (d: number) => {
      clock += d;
    },
    setLive: (n: number) => {
      liveCount = n;
    },
    setXaiLive: (n: number) => {
      xaiLive = n;
    },
    setXaiAuthUrl: (f: XaiManagementApi["requestAuthUrl"]) => {
      authUrlImpl = f;
    },
    setXaiPoll: (f: XaiManagementApi["pollAuthStatus"]) => {
      pollImpl = f;
    },
    xaiCalls,
    installCount: () => installCount,
    setInstall: (f: () => Promise<{ version: string }>) => {
      installImpl = f;
    },
    rollbackCount: () => rollbackCount,
    setRollback: (f: () => Promise<boolean>) => {
      rollbackImpl = f;
    },
    setVerifyRouter: (
      f: (provider: RouterProvider, key: string) => Promise<"ok" | "rejected" | "unknown">
    ) => {
      verifyRouterImpl = f;
    },
    setFetchRouterModels: (
      f: (
        provider: RouterProvider,
        key: string
      ) => Promise<{ ok: true; models: string[] } | { ok: false; error: string }>
    ) => {
      fetchRouterModelsImpl = f;
    },
    sysDir
  };
}

async function writeEnabledState(daemonDir: string, patch: Partial<CliProxyState> = {}): Promise<void> {
  const state = { ...createDefaultCliProxyState(), enabled: true, ...patch };
  await mkdir(cliproxyDir(daemonDir), { recursive: true });
  await writeFile(cliproxyStateFile(daemonDir), JSON.stringify(state), "utf8");
}

/** Seed a secrets.json so init() adopts a pre-existing key set (legacy or routerKeys). */
async function writeSecretsFile(daemonDir: string, patch: Record<string, unknown>): Promise<void> {
  await mkdir(cliproxyDir(daemonDir), { recursive: true });
  await writeFile(
    cliproxySecretsFile(daemonDir),
    JSON.stringify({ apiKey: "test-api-key", managementSecret: "test-mgmt", ...patch }),
    { mode: 0o600 }
  );
}

/** A minimal valid RouterProvider record for state fixtures. */
function routerProvider(id: string, patch: Partial<RouterProvider> = {}): RouterProvider {
  return {
    id,
    label: id,
    baseUrl: `https://${id}.example/v1`,
    preset: null,
    models: [{ name: `vendor/${id}-model` }],
    keyVerifiedAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    ...patch
  };
}

async function writeBin(daemonDir: string): Promise<void> {
  const binDir = join(cliproxyDir(daemonDir), "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "cli-proxy-api"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test("boot: port answers + our key accepted → persistence-lost (not foreign)", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(false);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  const st = h.mgr.status();
  assert.equal(st.state, "degraded");
  assert.ok(st.reasons.includes("persistence-lost"), `reasons=${JSON.stringify(st.reasons)}`);
  // Ownership-verified adoption must NOT kill or (re)spawn an already-live proxy.
  assert.equal(h.tmuxCalls.newService, 0);
  assert.equal(h.tmuxCalls.killService, 0);
});

test("persistence-lost proxy is re-parented under tmux once sessions drain AND the port frees, not just relabeled", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(false);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  // Boot-adopt an out-of-tmux own proxy (probe ok, no tmux session) → persistence-lost.
  await h.mgr.init();
  assert.ok(h.mgr.status().reasons.includes("persistence-lost"), "boots into persistence-lost");

  // A live dependent session: a health tick must NOT clear external / relabel healthy.
  h.setLive(1);
  await h.mgr.checkHealth();
  assert.ok(
    h.mgr.status().reasons.includes("persistence-lost"),
    "still persistence-lost while a session is bound to the external proxy"
  );
  assert.equal(h.tmuxCalls.newService, 0, "no re-parent spawn while sessions are live");

  // Sessions drain and the survivor exits: the port stays quiet until OUR tmux
  // spawn brings it back. Re-parent then spawns exactly once and clears external
  // only AFTER the tmux-hosted spawn probes healthy.
  h.setLive(0);
  h.setProbeFn(async () =>
    h.tmuxCalls.newService > 0
      ? { ok: true, reachable: true, models: ["gpt-5.6-sol"] }
      : { ok: false, reachable: false }
  );
  h.mgr.handleSessionSetChanged();
  await h.mgr.checkHealth(); // settle: chains onto the transition queue after the re-parent
  assert.equal(h.tmuxCalls.newService, 1, "re-parented under tmux exactly once");
  assert.ok(
    !h.mgr.status().reasons.includes("persistence-lost"),
    "external cleared after a tmux-hosted spawn"
  );
});

test("boot: port answers + key rejected → error 'port conflict', no kill/adopt", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(false);
  h.setProbe({ ok: false, reachable: true });

  await h.mgr.init();

  const st = h.mgr.status();
  assert.equal(st.state, "error");
  assert.ok(st.reasons.some((r) => r.includes("port conflict")), `reasons=${JSON.stringify(st.reasons)}`);
  assert.equal(h.tmuxCalls.killService, 0);
  assert.equal(h.tmuxCalls.newService, 0);
});

test("corrupt secrets.json → state error, secrets file untouched, no config rewrite", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  const secFile = cliproxySecretsFile(h.daemonDir);
  await mkdir(dirname(secFile), { recursive: true });
  const garbage = "{ this is not valid json";
  await writeFile(secFile, garbage, { mode: 0o600 });

  await h.mgr.init();

  const st = h.mgr.status();
  assert.equal(st.state, "error");
  assert.ok(st.reasons.some((r) => /corrupt|secret/i.test(r)), `reasons=${JSON.stringify(st.reasons)}`);
  // Fail-closed: never regenerate over a corrupt store, never rewrite config.yaml.
  assert.equal(await readFile(secFile, "utf8"), garbage);
  assert.equal(existsSync(join(cliproxyDir(h.daemonDir), "config.yaml")), false);
});

test("crash supervision: 3 failed respawns → error latch + single notification event", async () => {
  const h = setup();
  await writeBin(h.daemonDir);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "healthy");

  h.setProbe({ ok: false, reachable: false });
  for (let i = 0; i < 3; i++) {
    h.advance(1_000_000);
    await h.mgr.checkHealth();
  }
  assert.equal(h.mgr.status().state, "error");

  // A further poll after the latch must not re-notify.
  h.advance(1_000_000);
  await h.mgr.checkHealth();

  const crashed = h.events.filter((e) => e.type === "cliproxy.crashed");
  assert.equal(crashed.length, 1);
});

test("enable: a throwing install does not persist enabled:true (generic catch path)", async () => {
  const h = setup();
  h.setInstall(async () => {
    throw new Error("sha256 mismatch");
  });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "error");
  // init() gates bootAdopt() on the persisted flag, so a failed enable must fail closed.
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(persisted.enabled, false, "a failed enable must not persist enabled:true");
});

test("enable: a proxy that never probes healthy does not persist enabled:true (proxy-down path)", async () => {
  const h = setup();
  h.setProbe({ ok: false, reachable: false });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "error");
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(persisted.enabled, false);
});

test("enable: a slow-binding proxy that answers on a later probe attempt becomes healthy (startup race)", async () => {
  const h = setup();
  // The real binary fetches remote catalogs before binding (~1-2 s): the first
  // probes hit connection-refused, then the port comes up. Single-shot probing
  // misread this as "proxy down" — enable must poll the startup window instead.
  let calls = 0;
  h.setProbeFn(async () => {
    calls++;
    if (calls < 4) return { ok: false, reachable: false };
    return { ok: true, reachable: true, models: ["gpt-5.6-sol"] };
  });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "healthy");
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(persisted.enabled, true);
});

test("enable: a proxy that never probes healthy is reaped — no orphan left holding the port", async () => {
  const h = setup();
  h.setProbe({ ok: false, reachable: false });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "error");
  // One kill reclaiming any stale service session before spawn, one reaping the
  // spawned-but-unready proxy on failure. Without the reap, the orphan keeps the
  // port while the manager reports "off", and the next enable collides.
  assert.equal(h.tmuxCalls.killService, 2);
});

test("disable without force + 2 live sessions → {ok:false, affectedSessions:2}; with force → kills service session", async () => {
  const h = setup();
  await writeBin(h.daemonDir);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  h.setLive(2);

  const killsBefore = h.tmuxCalls.killService;
  const soft = await h.mgr.disable(false);
  assert.deepEqual(soft, { ok: false, affectedSessions: 2 });
  assert.equal(h.tmuxCalls.killService, killsBefore, "soft disable must not kill");

  const forced = await h.mgr.disable(true);
  assert.equal(forced.ok, true);
  assert.ok(h.tmuxCalls.killService > killsBefore, "force disable kills the service session");
  assert.equal(h.mgr.status().state, "off");
  // A normal tmux-owned disable emits NO warning (guards against always-warning regression).
  assert.deepEqual(h.mgr.status().reasons, []);
});

test("disable: an externally-adopted proxy can't be killed → off with a port warning, launchers disabled", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(false);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  // Boot-adopt an out-of-tmux own proxy (probe ok, no tmux session) → persistence-lost/external.
  await h.mgr.init();
  assert.ok(h.mgr.status().reasons.includes("persistence-lost"), "boots into persistence-lost");

  const res = await h.mgr.disable(false);
  assert.equal(res.ok, true);
  assert.equal(h.mgr.status().state, "off");
  const reasons = h.mgr.status().reasons;
  assert.ok(reasons.length >= 1, `expected a warning, got ${JSON.stringify(reasons)}`);
  assert.ok(
    reasons.some((r) => /external proxy/.test(r) && r.includes(String(8317))),
    `expected an external-proxy warning naming the port, got ${JSON.stringify(reasons)}`
  );
  // Warn-only: never respawns to reclaim the port.
  assert.equal(h.tmuxCalls.newService, 0);
});

test("validateModel: request model wins over default; unknown model fails naming provider; probe hang → bounded failure ≤2s", async (t) => {
  // (a) request model wins over the configured default.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["model-a", "gpt-5.6-sol"] });
    const r = await h.mgr.validateModel("claudex", "model-a");
    assert.deepEqual(r, { ok: true, effectiveModel: "model-a", catalog: ["model-a", "gpt-5.6-sol"] });
  }
  // (b) a model absent from the catalog fails, naming the provider.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["model-a"] });
    const r = await h.mgr.validateModel("claudex", "totally-unknown");
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.error, /provider|offered|unknown/i);
  }
  // (c) a hanging probe resolves to a bounded failure within 2s (fake timer).
  {
    const h = setup();
    await writeBin(h.daemonDir);
    h.setProbe({ ok: true, reachable: true, models: ["model-a"] });
    await h.mgr.enable(); // load secrets so validateModel has no fs await before the race
    h.setProbeFn(() => new Promise<ProbeResult>(() => {})); // never resolves
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = h.mgr.validateModel("claudex", "model-a");
    t.mock.timers.tick(2000);
    const r = await pending;
    assert.equal(r.ok, false);
    t.mock.timers.reset();
  }
  // (d) omitted model resolves the configured default and validates it against the catalog.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol", "model-a"] });
    const r = await h.mgr.validateModel("claudex");
    assert.deepEqual(r, { ok: true, effectiveModel: "gpt-5.6-sol", catalog: ["gpt-5.6-sol", "model-a"] });
  }
  // (e) omitted model whose resolved default is absent from the catalog fails, naming the provider.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["model-a"] }); // default "gpt-5.6-sol" not offered
    const r = await h.mgr.validateModel("claudex");
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.error, /gpt-5\.6-sol|provider|offered/i);
  }
});

test("validateModel: claudemix with no request model resolves claudeDefaultModel, NOT defaultModel", async () => {
  // (a) claudemix + no request model + a catalog offering the claude default → ok,
  // resolving "claude-fable-5" (would previously have failed probing gpt-5.6-sol).
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["claude-fable-5", "claude-sonnet-5"] });
    const r = await h.mgr.validateModel("claudemix");
    assert.deepEqual(r, { ok: true, effectiveModel: "claude-fable-5", catalog: ["claude-fable-5", "claude-sonnet-5"] });
  }
  // (b) claudemix + a catalog WITHOUT any claude model → fails, naming the claude model.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol"] });
    const r = await h.mgr.validateModel("claudemix");
    assert.equal(r.ok, false);
    if (r.ok === false) assert.match(r.error, /claude/i);
  }
  // (c) claudex is unchanged — it still resolves defaultModel (gpt-5.6-sol).
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol"] });
    const r = await h.mgr.validateModel("claudex");
    assert.deepEqual(r, { ok: true, effectiveModel: "gpt-5.6-sol", catalog: ["gpt-5.6-sol"] });
  }
});

test("preflightModels: partitions referenced models into ok/missing against a fresh catalog", async (t) => {
  // Referenced models split into those the catalog offers and those it doesn't.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol", "kimi-k3"] });
    const r = await h.mgr.preflightModels(["gpt-5.6-sol", "nope-1"]);
    assert.deepEqual(r, { ok: ["gpt-5.6-sol"], missing: ["nope-1"] });
  }
  // All present → nothing missing.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol", "kimi-k3", "claude-fable-5"] });
    const r = await h.mgr.preflightModels(["gpt-5.6-sol", "kimi-k3"]);
    assert.deepEqual(r, { ok: ["gpt-5.6-sol", "kimi-k3"], missing: [] });
  }
  // Best-effort: an unreachable proxy can't confirm anything → everything is missing.
  {
    const h = setup();
    h.setProbe({ ok: false, reachable: false });
    const r = await h.mgr.preflightModels(["gpt-5.6-sol"]);
    assert.deepEqual(r, { ok: [], missing: ["gpt-5.6-sol"] });
  }
  // Empty input → empty partitions (no probe needed).
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["gpt-5.6-sol"] });
    const r = await h.mgr.preflightModels([]);
    assert.deepEqual(r, { ok: [], missing: [] });
  }
  // A hanging probe resolves to a bounded failure within 2s (fake timer) → all missing.
  {
    const h = setup();
    await writeBin(h.daemonDir);
    h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
    await h.mgr.enable(); // load secrets so preflightModels has no fs await before the race
    h.setProbeFn(() => new Promise<ProbeResult>(() => {})); // never resolves
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = h.mgr.preflightModels(["gpt-5.6-sol"]);
    t.mock.timers.tick(2000);
    const r = await pending;
    assert.deepEqual(r, { ok: [], missing: ["gpt-5.6-sol"] });
    t.mock.timers.reset();
  }
});

test("healthy → registry claudex/claudemix enabled; probe loss → disabled with 'proxy down'", async () => {
  const h = setup();
  await writeBin(h.daemonDir);
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const enabledCalls = h.registryCalls.filter((c) => c.enabled === true);
  assert.ok(enabledCalls.some((c) => c.id === "claudex"), "claudex enabled on healthy");
  assert.ok(enabledCalls.some((c) => c.id === "claudemix"), "claudemix enabled on healthy");

  h.setProbe({ ok: false, reachable: false });
  for (let i = 0; i < 3; i++) {
    h.advance(1_000_000);
    await h.mgr.checkHealth();
  }
  assert.equal(h.mgr.status().state, "error");

  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
  assert.deepEqual(lastClaudex, { id: "claudex", enabled: false, disabledReason: "proxy down" });
  assert.deepEqual(lastClaudemix, { id: "claudemix", enabled: false, disabledReason: "proxy down" });
});

test("enable installs, projects config+token+env, seeds both homes, spawns, enables launchers", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.enable();

  assert.equal(h.installCount(), 1, "install adapter runs exactly once");
  const dir = cliproxyDir(h.daemonDir);
  assert.ok(existsSync(join(dir, "config.yaml")), "config.yaml projected");
  assert.ok(existsSync(join(dir, "token")), "token projected");
  assert.ok(
    existsSync(join(dir, "claude-home-claudex", ".orq-cliproxy-home")),
    "claudex home seeded with marker"
  );
  assert.ok(
    existsSync(join(dir, "claude-home-claudemix", ".orq-cliproxy-home")),
    "claudemix home seeded with marker"
  );
  assert.equal(h.mgr.status().state, "healthy");
  assert.ok(
    h.registryCalls.some((c) => c.id === "claudex" && c.enabled === true),
    "claudex enabled after enable"
  );
  assert.ok(
    h.registryCalls.some((c) => c.id === "claudemix" && c.enabled === true),
    "claudemix enabled after enable"
  );
});

test("corrupt secrets.json → enable latches error, installs nothing, writes no config", async () => {
  const h = setup();
  const secFile = cliproxySecretsFile(h.daemonDir);
  await mkdir(dirname(secFile), { recursive: true });
  await writeFile(secFile, "{ not json", { mode: 0o600 });
  h.setInstall(async () => {
    throw new Error("should not install");
  });

  await h.mgr.enable();

  const st = h.mgr.status();
  assert.equal(st.state, "error");
  assert.ok(st.reasons.some((r) => /corrupt|secret/i.test(r)), `reasons=${JSON.stringify(st.reasons)}`);
  assert.equal(h.installCount(), 0, "corrupt secrets must install nothing");
  assert.equal(existsSync(join(cliproxyDir(h.daemonDir), "config.yaml")), false, "no config rewrite");
});

test("enable: a throwing install latches error (never wedged in 'starting') and stays retriable", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  h.setInstall(async () => {
    throw new Error("sha256 mismatch");
  });

  await h.mgr.enable();

  const st = h.mgr.status();
  assert.notEqual(st.state, "starting", "a throw must not wedge the manager in 'starting'");
  assert.equal(st.state, "error");
  assert.ok(st.reasons.some((r) => /sha256 mismatch/.test(r)), `reasons=${JSON.stringify(st.reasons)}`);

  // Retriable: a working install now reaches healthy.
  h.setInstall(async () => {
    await writeBin(h.daemonDir);
    return { version: "v7.2.95" };
  });
  await h.mgr.enable();
  assert.equal(h.mgr.status().state, "healthy", "enable can be retried after the failure clears");
});

test("bootAdopt: a throw during (re)probe latches error, never stuck in 'starting'", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(true);
  let n = 0;
  h.setProbeFn(async () => {
    n++;
    if (n === 1) return { ok: false, reachable: true };
    throw new Error("reprobe blew up");
  });

  await h.mgr.init();

  const st = h.mgr.status();
  assert.notEqual(st.state, "starting", "a throw after setState('starting') must not wedge");
  assert.equal(st.state, "error");
  assert.ok(st.reasons.some((r) => /reprobe blew up/.test(r)), `reasons=${JSON.stringify(st.reasons)}`);
});

// --- Task 5: provider status + credential seeding with freshness guard ---------

test("seedProvider writes a prefixed auth file 0600, records the account, marks the provider ok", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const accountId = "65eebd90-01d1-4063-b743-c4a5713f5519";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const authJson = {
    tokens: {
      id_token: fakeJwt({ email: "a@b.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } }),
      access_token: fakeJwt({ exp }),
      refresh_token: "rt",
      account_id: "raw"
    },
    last_refresh: "2026-07-22T07:30:06Z"
  };
  const status = await h.mgr.seedProvider({ provider: "codex", accountId }, async () => authJson);
  assert.equal(status.provider, "codex");
  assert.equal(status.state, "ok");

  const authFile = join(cliproxyDir(h.daemonDir), "auth", "codex-acc65eebd90.json");
  assert.ok(existsSync(authFile), "auth file written under auth/");
  assert.equal(statSync(authFile).mode & 0o777, 0o600, "auth file is 0600");

  const acct = h.mgr.status().accounts.find((a) => a.id === accountId);
  assert.ok(acct, "account recorded in status");
  assert.equal(acct?.provider, "codex");
  assert.equal(acct?.email, "a@b.com");

  const codex = h.mgr.status().providers.find((p) => p.provider === "codex");
  assert.equal(codex?.state, "ok");
});

test("seedProvider refuses a stale token with 'expired' and writes no auth file (no dual-refresh)", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const accountId = "14137047-98b2-4cf1-9b54-b18a22a85a62";
  const staleExp = Math.floor(Date.now() / 1000) - 3600;
  const authJson = {
    tokens: {
      id_token: fakeJwt({ email: "s@t.com" }),
      access_token: fakeJwt({ exp: staleExp }),
      refresh_token: "rt"
    }
  };
  const status = await h.mgr.seedProvider({ provider: "codex", accountId }, async () => authJson);
  assert.equal(status.state, "expired");

  const authFile = join(cliproxyDir(h.daemonDir), "auth", "codex-acc14137047.json");
  assert.equal(existsSync(authFile), false, "stale token must not be seeded");
  assert.equal(h.mgr.status().accounts.length, 0, "no account recorded on refusal");
});

test("status per-provider state gates launchers: codex seeded → claudex on, claude absent → claudemix off", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const accountId = "65eebd90-01d1-4063-b743-c4a5713f5519";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const authJson = {
    tokens: {
      id_token: fakeJwt({ email: "a@b.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }),
      access_token: fakeJwt({ exp }),
      refresh_token: "rt"
    }
  };
  await h.mgr.seedProvider({ provider: "codex", accountId }, async () => authJson);

  const providers = h.mgr.status().providers;
  assert.equal(providers.find((p) => p.provider === "codex")?.state, "ok");
  assert.equal(providers.find((p) => p.provider === "claude")?.state, "missing");

  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
  assert.equal(lastClaudex?.enabled, true, "claudex enabled: codex present");
  assert.equal(lastClaudemix?.enabled, false, "claudemix disabled: no claude credential");
  assert.ok(lastClaudemix?.disabledReason, "claudemix carries a disabledReason");
});

test("unseedProvider removes the auth file, drops the account, degrades the provider, broadcasts", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const accountId = "65eebd90-01d1-4063-b743-c4a5713f5519";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const authJson = {
    tokens: {
      id_token: fakeJwt({ email: "a@b.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
      access_token: fakeJwt({ exp }),
      refresh_token: "rt"
    }
  };
  await h.mgr.seedProvider({ provider: "codex", accountId }, async () => authJson);
  const authFile = join(cliproxyDir(h.daemonDir), "auth", "codex-acc65eebd90.json");
  assert.ok(existsSync(authFile), "auth file written by seed");
  assert.equal(h.mgr.status().accounts.length, 1);

  const marker = h.events.length;
  const status = await h.mgr.unseedProvider({ provider: "codex", accountId });

  assert.equal(status.provider, "codex");
  assert.equal(status.state, "missing");
  assert.equal(existsSync(authFile), false, "auth file removed");
  assert.equal(h.mgr.status().accounts.length, 0, "account dropped from status");
  assert.equal(h.mgr.status().providers.find((p) => p.provider === "codex")?.state, "missing");
  // Removing the last credential returns the manager to the pre-seed optimistic
  // state (no provider info to gate on), so the launchers re-couple as enabled.
  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, true, "claudex re-coupled optimistically once no provider info remains");
  assert.equal(lastClaudex?.disabledReason, undefined, "no disabledReason in the optimistic state");
  assert.ok(
    h.events.slice(marker).some((e) => e.type === "cliproxy.changed"),
    "a cliproxy.changed event is broadcast on the un-seed"
  );
  const persisted = parseCliProxyState(JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8")));
  assert.deepEqual(persisted.seededAccounts, [], "persisted seededAccounts emptied");
  // persist() must route through writeHardened (atomic temp+rename with mode 0o600),
  // not a plain writeFile: the 0o600 mode is the discriminating signal — a bare
  // writeFile would leave the umask default (typically 0o644). This proves the
  // torn-write-safe write path is actually taken, not just that a file exists.
  assert.equal(
    statSync(cliproxyStateFile(h.daemonDir)).mode & 0o777,
    0o600,
    "state.json written 0600 by writeHardened's atomic path"
  );
});

test("unseedProvider is idempotent on an unknown id", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();

  const marker = h.events.length;
  const status = await h.mgr.unseedProvider({ provider: "codex", accountId: "does-not-exist" });

  assert.equal(status.provider, "codex");
  assert.equal(status.state, "missing");
  assert.equal(h.mgr.status().accounts.length, 0, "no accounts to remove");
  assert.equal(
    h.events.slice(marker).filter((e) => e.type === "cliproxy.changed").length,
    0,
    "no broadcast on an unknown id"
  );
});

// --- Task 4: data-driven router providers on the manager ----------------------

test("status().routerProviders reports keyState none/set/verified from routerKeys + keyVerifiedAt", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, {
    routerProviders: [
      routerProvider("keyless"),
      routerProvider("stored"),
      routerProvider("checked", { keyVerifiedAt: "2026-07-01T00:00:00.000Z" })
    ]
  });
  await writeSecretsFile(h.daemonDir, { routerKeys: { stored: "sk-1", checked: "sk-2" } });
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  const rows = h.mgr.status().routerProviders;
  assert.deepEqual(
    rows.map((p) => [p.id, p.keyState]),
    [
      ["keyless", "none"],
      ["stored", "set"],
      ["checked", "verified"]
    ]
  );
  // The key itself never crosses the status boundary — only its state.
  assert.equal(JSON.stringify(rows).includes("sk-1"), false, "no key material on the wire");
  assert.equal(rows[2]?.keyVerifiedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(rows[0]?.baseUrl, "https://keyless.example/v1");
});

test("init(): a legacy openRouterKey migrates into an openrouter router provider, mirror kept", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, { openRouterKeyVerifiedAt: "2026-07-01T00:00:00.000Z" });
  await writeSecretsFile(h.daemonDir, { openRouterKey: "sk-or-legacy" });
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  const migrated = h.mgr.status().routerProviders.find((p) => p.id === "openrouter");
  assert.ok(migrated, "the openrouter provider is seeded from the legacy key");
  assert.equal(migrated.keyState, "verified");
  assert.equal(migrated.keyVerifiedAt, "2026-07-01T00:00:00.000Z");
  assert.deepEqual(migrated.models[0], {
    name: "moonshotai/kimi-k3",
    alias: "kimi-k3",
    contextWindow: 1_048_576,
    compactWindow: 450_000
  });

  const secrets = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets.routerKeys.openrouter, "sk-or-legacy", "key moved under routerKeys");
  assert.equal(secrets.openRouterKey, "sk-or-legacy", "legacy field stays mirrored at rest");

  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(persisted.routerProviders.length, 1, "migration persisted to state.json");
});

test("probe unions every keyed provider's model names AND aliases into the catalog", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, {
    routerProviders: [
      routerProvider("openrouter", {
        models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }]
      }),
      // Keyless → its models must NOT enter the catalog (they aren't in config.yaml).
      routerProvider("keyless", { models: [{ name: "vendor/ghost" }] })
    ]
  });
  await writeSecretsFile(h.daemonDir, { routerKeys: { openrouter: "sk-or-1" } });
  h.setHasService(true); // adopt under tmux → healthy, so the catalog is stored
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();
  assert.equal(h.mgr.status().state, "healthy");

  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.deepEqual(persisted.modelCatalog?.models.sort(), [
    "gpt-5.6-sol",
    "kimi-k3",
    "moonshotai/kimi-k3"
  ]);
  assert.equal(
    (await h.mgr.validateModel("claudex", "moonshotai/kimi-k3")).ok,
    true,
    "the full router model name passes catalog validation"
  );
});

test("claudex coupling: a keyed router provider satisfies the codex-or-router gate", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, {
    routerProviders: [routerProvider("tokenrouter", { models: [{ name: "moonshotai/kimi-k3-free" }] })]
  });
  await writeSecretsFile(h.daemonDir, { routerKeys: { tokenrouter: "sk-tr-1" } });
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, true, "claudex enabled by the router credential alone");
  assert.equal(lastClaudex?.disabledReason, undefined);
});

test("claudex coupling: a KEYLESS router provider + a claude account → disabled 'no codex, router or Grok credential'", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, {
    // A seeded claude account makes provider info known, so the gate applies.
    seededAccounts: [
      {
        provider: "claude",
        accountId: "65eebd90-01d1-4063-b743-c4a5713f5519",
        label: "claude a",
        prefix: "acc65eebd90"
      }
    ],
    routerProviders: [routerProvider("tokenrouter")]
  });
  await writeSecretsFile(h.daemonDir, {});
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, false);
  assert.equal(lastClaudex?.disabledReason, "no codex, router or Grok credential");
  const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
  assert.equal(lastClaudemix?.enabled, true, "claudemix still satisfied by the claude account");
});

// --- Task 5: router provider mutations (upsert/delete/key/catalog) ------------

/** Boot a healthy, tmux-adopted manager over a persisted router-provider set. */
async function initWithRouters(
  h: ReturnType<typeof setup>,
  providers: RouterProvider[],
  routerKeys: Record<string, string> = {},
  statePatch: Partial<CliProxyState> = {}
): Promise<void> {
  await writeEnabledState(h.daemonDir, { routerProviders: providers, ...statePatch });
  await writeSecretsFile(h.daemonDir, { routerKeys });
  h.setHasService(true); // adopt an already-running proxy → healthy (mutations are restart-gated)
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.init();
}

test("upsertRouterProvider: validates the record, restart-gates a KEYED change, and persists", async () => {
  const h = setup();
  await initWithRouters(
    h,
    [routerProvider("tokenrouter", { models: [{ name: "vendor/a" }] })],
    { tokenrouter: "sk-tr" }
  );
  assert.equal(h.mgr.status().state, "healthy");

  const reserved = await h.mgr.upsertRouterProvider(
    { id: "codex", label: "Codex", baseUrl: "https://x.example/v1", models: [] },
    false
  );
  assert.equal(reserved.ok, false);
  assert.match(reserved.error ?? "", /reserved/);

  // A model already served by another provider would make routing ambiguous.
  const clash = await h.mgr.upsertRouterProvider(
    { id: "other", label: "Other", baseUrl: "https://o.example/v1", models: [{ name: "vendor/a" }] },
    false
  );
  assert.equal(clash.ok, false);
  assert.match(clash.error ?? "", /vendor\/a/);

  const badUrl = await h.mgr.upsertRouterProvider(
    { id: "other", label: "Other", baseUrl: "ftp://o.example", models: [] },
    false
  );
  assert.equal(badUrl.ok, false);
  assert.ok(badUrl.error, "a schema failure reports an error, not a session gate");

  // Nothing invalid reached the state.
  assert.deepEqual(h.mgr.status().routerProviders.map((p) => p.id), ["tokenrouter"]);

  // Editing a KEYED provider re-projects config.yaml → restart-gated.
  const edit = {
    id: "tokenrouter",
    label: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1",
    models: [{ name: "vendor/a" }, { name: "vendor/b" }]
  };
  h.setLive(2);
  const gated = await h.mgr.upsertRouterProvider(edit, false);
  assert.deepEqual(gated, { ok: false, affectedSessions: 2 });

  const spawnsBefore = h.tmuxCalls.newService;
  const forced = await h.mgr.upsertRouterProvider(edit, true);
  assert.equal(forced.ok, true);
  assert.equal(forced.affectedSessions, 2);
  assert.ok(h.tmuxCalls.newService > spawnsBefore, "a keyed provider change restarts the proxy");

  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  const saved = persisted.routerProviders.find((p) => p.id === "tokenrouter");
  assert.equal(saved?.label, "TokenRouter");
  assert.equal(saved?.baseUrl, "https://api.tokenrouter.com/v1");
  assert.deepEqual(saved?.models.map((m) => m.name), ["vendor/a", "vendor/b"]);
  assert.equal(saved?.createdAt, "2026-08-04T00:00:00.000Z", "createdAt survives an edit");
});

test("upsertRouterProvider: a KEYLESS provider is not restart-gated (it never reaches config.yaml)", async () => {
  const h = setup();
  await initWithRouters(h, [], {});
  h.setLive(3);
  const spawnsBefore = h.tmuxCalls.newService;
  const res = await h.mgr.upsertRouterProvider(
    { id: "tokenrouter", label: "TokenRouter", baseUrl: "https://api.tokenrouter.com/v1", models: [{ name: "vendor/a" }] },
    false
  );
  assert.equal(res.ok, true, "no key → no projection change → no session gate");
  assert.equal(h.tmuxCalls.newService, spawnsBefore, "and no proxy restart");
  assert.equal(h.mgr.status().routerProviders.find((p) => p.id === "tokenrouter")?.keyState, "none");
});

test("setRouterKey: rejected refuses, unknown stores unverified, ok stamps keyVerifiedAt + legacy mirror", async () => {
  const h = setup();
  await initWithRouters(h, [
    routerProvider("openrouter", {
      label: "OpenRouter",
      preset: "openrouter",
      models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }]
    })
  ]);

  const unknown = await h.mgr.setRouterKey("nope", "sk-1", true);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown provider/);

  h.setVerifyRouter(async () => "rejected");
  const rejected = await h.mgr.setRouterKey("openrouter", "sk-bad", true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "OpenRouter rejected this key");
  const secrets1 = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets1.routerKeys.openrouter, undefined, "a rejected key is never stored");

  // Inconclusive (network) verification stores the key but leaves it unverified.
  h.setVerifyRouter(async () => "unknown");
  const inconclusive = await h.mgr.setRouterKey("openrouter", "sk-maybe", true);
  assert.equal(inconclusive.ok, true);
  assert.equal(
    h.mgr.status().routerProviders.find((p) => p.id === "openrouter")?.keyState,
    "set"
  );

  h.setVerifyRouter(async () => "ok");
  const good = await h.mgr.setRouterKey("openrouter", "sk-good", true);
  assert.equal(good.ok, true);
  const row = h.mgr.status().routerProviders.find((p) => p.id === "openrouter");
  assert.equal(row?.keyState, "verified");
  assert.ok(row?.keyVerifiedAt);

  const secrets2 = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets2.routerKeys.openrouter, "sk-good");
  assert.equal(secrets2.openRouterKey, "sk-good", "legacy at-rest mirror maintained");
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(
    persisted.openRouterKeyVerifiedAt,
    row?.keyVerifiedAt,
    "legacy state mirror follows the openrouter verification"
  );
});

test("setRouterKey: restart-gated while dependent sessions are live", async () => {
  const h = setup();
  await initWithRouters(h, [routerProvider("tokenrouter", { models: [{ name: "vendor/tr" }] })]);
  h.setLive(2);
  const gated = await h.mgr.setRouterKey("tokenrouter", "sk-tr", false);
  assert.deepEqual(gated, { ok: false, affectedSessions: 2 });
  const secrets = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets.routerKeys.tokenrouter, undefined, "nothing stored while gated");
});

test("clearRouterKey: keeps the provider row, drops the key, and un-satisfies the claudex gate", async () => {
  const h = setup();
  await initWithRouters(
    h,
    [routerProvider("tokenrouter", { models: [{ name: "vendor/tr" }] })],
    { tokenrouter: "sk-tr" },
    {
      // A seeded claude account makes provider info known, so the gate applies.
      seededAccounts: [
        {
          provider: "claude",
          accountId: "65eebd90-01d1-4063-b743-c4a5713f5519",
          label: "claude a",
          prefix: "acc65eebd90"
        }
      ]
    }
  );
  assert.equal(
    [...h.registryCalls].reverse().find((c) => c.id === "claudex")?.enabled,
    true,
    "the keyed router satisfies the codex-or-router gate"
  );

  const unknown = await h.mgr.clearRouterKey("nope", true);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown provider/);

  const res = await h.mgr.clearRouterKey("tokenrouter", true);
  assert.equal(res.ok, true);
  const row = h.mgr.status().routerProviders.find((p) => p.id === "tokenrouter");
  assert.equal(row?.keyState, "none", "the provider row survives, keyless");
  assert.equal(row?.keyVerifiedAt, null);
  const secrets = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets.routerKeys.tokenrouter, undefined);
  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, false);
  assert.equal(lastClaudex?.disabledReason, "no codex, router or Grok credential");
});

test("deleteRouterProvider: removes provider + key and resets a model pick that pointed at it", async () => {
  const h = setup();
  await initWithRouters(
    h,
    [routerProvider("tokenrouter", { models: [{ name: "vendor/tr" }] })],
    { tokenrouter: "sk-tr" },
    { defaultModel: "vendor/tr" }
  );
  assert.equal(h.mgr.status().defaultModel, "vendor/tr");

  const unknown = await h.mgr.deleteRouterProvider("nope", true);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown provider/);

  h.setLive(1);
  const gated = await h.mgr.deleteRouterProvider("tokenrouter", false);
  assert.deepEqual(gated, { ok: false, affectedSessions: 1 });
  assert.equal(h.mgr.status().routerProviders.length, 1, "nothing removed while gated");

  const res = await h.mgr.deleteRouterProvider("tokenrouter", true);
  assert.equal(res.ok, true);
  assert.deepEqual(h.mgr.status().routerProviders, []);
  assert.equal(
    h.mgr.status().defaultModel,
    "gpt-5.6-sol",
    "a model pick that no longer resolves falls back to the curated default"
  );
  const secrets = JSON.parse(await readFile(cliproxySecretsFile(h.daemonDir), "utf8"));
  assert.equal(secrets.routerKeys.tokenrouter, undefined, "the provider's key goes with it");
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.deepEqual(persisted.routerProviders, []);
  assert.equal(persisted.defaultModel, "gpt-5.6-sol");
});

test("fetchRouterCatalog: unknown id, missing key, adapter success and upstream failure", async () => {
  const h = setup();
  await initWithRouters(h, [routerProvider("tokenrouter"), routerProvider("keyless")], {
    tokenrouter: "sk-tr"
  });

  const unknown = await h.mgr.fetchRouterCatalog("nope");
  assert.deepEqual(unknown, { ok: false, code: "unknown", error: "unknown provider" });

  const noKey = await h.mgr.fetchRouterCatalog("keyless");
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.equal(noKey.code, "no-key");

  const seen: Array<{ id: string; key: string }> = [];
  h.setFetchRouterModels(async (provider, key) => {
    seen.push({ id: provider.id, key });
    return { ok: true, models: ["vendor/a", "vendor/b"] };
  });
  const ok = await h.mgr.fetchRouterCatalog("tokenrouter");
  assert.deepEqual(ok, { ok: true, models: ["vendor/a", "vendor/b"] });
  assert.deepEqual(seen, [{ id: "tokenrouter", key: "sk-tr" }], "the stored key never leaves the daemon");

  h.setFetchRouterModels(async () => ({ ok: false, error: "upstream responded 500" }));
  const bad = await h.mgr.fetchRouterCatalog("tokenrouter");
  assert.deepEqual(bad, { ok: false, code: "upstream", error: "upstream responded 500" });
});

const SYNC_ACCOUNT = "14137047-98b2-4cf1-9b54-b18a22a85a62";

/** Persist an enabled state with one seeded claude account, plus both credential
 *  copies, then init() — which runs the sync inside refreshSeededFreshness. */
async function setupClaudeSync(
  h: ReturnType<typeof setup>,
  opts: { proxyExpiry: number; managedExpiry: number }
): Promise<{ authFile: string; credPath: string }> {
  const state = {
    ...createDefaultCliProxyState(),
    enabled: true,
    seededAccounts: [
      { provider: "claude", accountId: SYNC_ACCOUNT, label: "j@x.com", prefix: "acc14137047" }
    ]
  };
  await mkdir(cliproxyDir(h.daemonDir), { recursive: true });
  await writeFile(cliproxyStateFile(h.daemonDir), JSON.stringify(state));
  const authFile = join(cliproxyDir(h.daemonDir), "auth", "claude-acc14137047.json");
  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(
    authFile,
    JSON.stringify({
      type: "claude",
      access_token: "PROXY_ACCESS",
      refresh_token: "PROXY_REFRESH",
      email: "j@x.com",
      expired: new Date(opts.proxyExpiry).toISOString(),
      prefix: "acc14137047"
    })
  );
  const credPath = join(h.root, "managed-creds", `claude-${SYNC_ACCOUNT}.json`);
  await mkdir(dirname(credPath), { recursive: true });
  await writeFile(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.managedExpiry > opts.proxyExpiry ? "MANAGED_ACCESS" : "",
        refreshToken: opts.managedExpiry > opts.proxyExpiry ? "MANAGED_REFRESH" : "",
        expiresAt: opts.managedExpiry,
        scopes: ["user:inference"],
        subscriptionType: "max"
      }
    })
  );
  return { authFile, credPath };
}

test("credential sync: a proxy-refreshed token is written back into the managed home (repairs a wiped login)", async () => {
  const h = setup();
  const now = Date.now();
  // Managed copy wiped-on-401 (empty tokens, expiresAt 0); proxy copy fresh.
  const { credPath } = await setupClaudeSync(h, { proxyExpiry: now + 8 * 3600_000, managedExpiry: 0 });
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });
  await h.mgr.init();
  const cred = JSON.parse(await readFile(credPath, "utf8"));
  assert.equal(cred.claudeAiOauth.accessToken, "PROXY_ACCESS");
  assert.equal(cred.claudeAiOauth.refreshToken, "PROXY_REFRESH");
  assert.ok(cred.claudeAiOauth.expiresAt > now, "expiry propagated");
  assert.equal(cred.claudeAiOauth.subscriptionType, "max", "non-token fields preserved");
});

test("credential sync: a session-refreshed managed token is written back into the proxy auth file", async () => {
  const h = setup();
  const now = Date.now();
  // Managed copy refreshed by a live session (later expiry); proxy copy stale.
  const { authFile } = await setupClaudeSync(h, {
    proxyExpiry: now - 3600_000,
    managedExpiry: now + 6 * 3600_000
  });
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });
  await h.mgr.init();
  const storage = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(storage.access_token, "MANAGED_ACCESS");
  assert.equal(storage.refresh_token, "MANAGED_REFRESH");
  assert.equal(storage.email, "j@x.com", "proxy-maintained metadata preserved");
  assert.ok(Date.parse(storage.expired) > now, "expiry propagated");
});

test("seeded accounts persist: a manager over a state file with a seeded codex account reports codex ok + enables claudex, no re-seed", async () => {
  const h = setup();
  // A persisted state file: enabled + one seeded codex account (routing projection
  // only, no token material) — exactly what a prior daemon would have written.
  const state = {
    ...createDefaultCliProxyState(),
    enabled: true,
    seededAccounts: [
      { provider: "codex", accountId: "65eebd90-01d1-4063-b743-c4a5713f5519", label: "a@b.com", prefix: "acc65eebd90" }
    ]
  };
  await mkdir(cliproxyDir(h.daemonDir), { recursive: true });
  await writeFile(cliproxyStateFile(h.daemonDir), JSON.stringify(state), "utf8");
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();

  // Provider availability is rebuilt from persisted state — no re-seed needed.
  assert.equal(h.mgr.status().providers.find((p) => p.provider === "codex")?.state, "ok");
  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, true, "claudex enabled from the persisted codex account");
});

test("boot: a persisted seeded account with a STALE on-disk auth file degrades to 'expired' and disables its launcher; a fresh file stays ok/enabled", async () => {
  const accountId = "14137047-98b2-4cf1-9b54-b18a22a85a62";
  const authFileName = "claude-acc14137047.json";
  const persistedState = () => ({
    ...createDefaultCliProxyState(),
    enabled: true,
    seededAccounts: [{ provider: "claude", accountId, label: "s@t.com", prefix: "acc14137047" }]
  });

  // (a) STALE auth file → provider degrades to expired, claudemix disabled.
  {
    const h = setup();
    await mkdir(join(cliproxyDir(h.daemonDir), "auth"), { recursive: true });
    await writeFile(cliproxyStateFile(h.daemonDir), JSON.stringify(persistedState()), "utf8");
    await writeFile(
      join(cliproxyDir(h.daemonDir), "auth", authFileName),
      JSON.stringify({ type: "claude", expired: new Date(Date.now() - 3_600_000).toISOString() }),
      "utf8"
    );
    h.setHasService(true);
    h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });

    await h.mgr.init();

    assert.equal(h.mgr.status().providers.find((p) => p.provider === "claude")?.state, "expired");
    const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
    assert.equal(lastClaudemix?.enabled, false, "claudemix disabled: stale claude credential");
  }

  // (b) FRESH auth file → provider stays ok, claudemix enabled.
  {
    const h = setup();
    await mkdir(join(cliproxyDir(h.daemonDir), "auth"), { recursive: true });
    await writeFile(cliproxyStateFile(h.daemonDir), JSON.stringify(persistedState()), "utf8");
    await writeFile(
      join(cliproxyDir(h.daemonDir), "auth", authFileName),
      JSON.stringify({ type: "claude", expired: new Date(Date.now() + 3_600_000).toISOString() }),
      "utf8"
    );
    h.setHasService(true);
    h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });

    await h.mgr.init();

    assert.equal(h.mgr.status().providers.find((p) => p.provider === "claude")?.state, "ok");
    const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
    assert.equal(lastClaudemix?.enabled, true, "claudemix enabled: fresh claude credential");
  }
});

test("poll: a seeded credential that expires at runtime degrades to 'expired', disables its launcher, and broadcasts cliproxy.changed", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });
  await h.mgr.enable();

  const accountId = "14137047-98b2-4cf1-9b54-b18a22a85a62";
  const seeded = await h.mgr.seedProvider({ provider: "claude", accountId }, async () => ({
    claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 }
  }));
  assert.equal(seeded.state, "ok");
  assert.equal(h.mgr.status().providers.find((p) => p.provider === "claude")?.state, "ok");
  assert.equal(
    [...h.registryCalls].reverse().find((c) => c.id === "claudemix")?.enabled,
    true,
    "claudemix enabled after a fresh seed"
  );

  // The proxy-owned auth file goes stale out-of-band (a real expiry the proxy could
  // not refresh). The next health poll must re-derive freshness and degrade it.
  await writeFile(
    join(cliproxyDir(h.daemonDir), "auth", "claude-acc14137047.json"),
    JSON.stringify({ type: "claude", expired: new Date(Date.now() - 1000).toISOString() }),
    "utf8"
  );
  const marker = h.events.length;

  await h.mgr.checkHealth();

  assert.equal(h.mgr.status().providers.find((p) => p.provider === "claude")?.state, "expired");
  assert.equal(
    [...h.registryCalls].reverse().find((c) => c.id === "claudemix")?.enabled,
    false,
    "claudemix disabled once the claude credential expires"
  );
  assert.ok(
    h.events.slice(marker).some((e) => e.type === "cliproxy.changed"),
    "a cliproxy.changed event is broadcast on the degradation"
  );
});

test("enable: a freshly-installed binary that never probes healthy rolls back to bin.prev and respawns", async () => {
  const h = setup();
  // The fresh install lands a binary but the proxy never comes up; a prior binary
  // survives in bin.prev/. Model that as: probe fails until rollback restores it.
  let rolledBack = false;
  h.setRollback(async () => {
    rolledBack = true;
    return true; // bin.prev existed → restored
  });
  h.setProbeFn(async () =>
    rolledBack
      ? { ok: true, reachable: true, models: ["gpt-5.6-sol"] }
      : { ok: false, reachable: false }
  );

  await h.mgr.enable();

  assert.equal(h.rollbackCount(), 1, "rollback attempted exactly once");
  assert.ok(rolledBack, "rollback restored the previous binary");
  assert.equal(h.mgr.status().state, "healthy", "healthy after the rollback respawn");
});

test("reparent: an external survivor still answering on drain stays persistence-lost — no spawn, no error latch", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  h.setHasService(false);
  // The out-of-tmux survivor keeps answering with our key throughout.
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();
  assert.ok(h.mgr.status().reasons.includes("persistence-lost"), "boots persistence-lost");

  // Sessions drain, but the port is still held by a proxy we hold no handle to:
  // re-parenting must NOT spawn into the conflict; it stays degraded, warn-only.
  h.setLive(0);
  h.mgr.handleSessionSetChanged();
  await h.mgr.checkHealth(); // settle: chains after the re-parent attempt

  const st = h.mgr.status();
  assert.equal(st.state, "degraded", "not error-latched");
  assert.ok(st.reasons.includes("persistence-lost"), "still persistence-lost");
  assert.equal(h.tmuxCalls.newService, 0, "no spawn into a port still held by the survivor");
});

test("setConfig: modelOverrides persist without a restart and surface on status", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  const spawnsBefore = h.tmuxCalls.newService;
  h.setLive(2); // live sessions must NOT gate an overrides-only change
  const res = await h.mgr.setConfig({ modelOverrides: { "kimi-k3": { compactWindow: 500000 } } }, false);
  assert.equal(res.ok, true);
  assert.equal(h.tmuxCalls.newService, spawnsBefore, "no proxy restart for overrides");
  assert.deepEqual(h.mgr.status().modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.deepEqual(persisted.modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
});

// --- Task 9: /api/cliproxy routes + launch-env composition + model gate --------

function fakeRouteManager(daemonDir?: string) {
  const calls = {
    enable: 0,
    disable: [] as boolean[],
    setConfig: [] as Array<{ cfg: unknown; force: boolean }>,
    routerKey: [] as Array<{ id: string; key: string; force: boolean }>,
    seed: [] as Array<{ req: { provider: "codex" | "claude"; accountId: string }; cred: unknown }>,
    unseed: [] as Array<{ provider: "codex" | "claude"; accountId: string }>
  };
  const status: CliProxyStatus = {
    state: "off",
    reasons: [],
    detail: null,
    version: null,
    defaultModel: "gpt-5.6-sol",
    backgroundModel: "gpt-5.6-sol",
    modelOverrides: {},
    providers: [],
    routerProviders: [],
    xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null },
    accounts: [],
    activeSessionCount: 0,
    testedClaudeCliVersion: null
  };
  const manager = {
    status: () => status,
    enable: async () => {
      calls.enable++;
    },
    disable: async (force: boolean) => {
      calls.disable.push(force);
      return { ok: true, affectedSessions: 0 };
    },
    setConfig: async (
      cfg: {
        defaultModel?: string;
        backgroundModel?: string;
        claudeDefaultModel?: string;
        modelOverrides?: CliProxyModelOverrides;
      },
      force: boolean
    ) => {
      calls.setConfig.push({ cfg, force });
      // Restart-gated like the real manager: refuse while live sessions exist
      // unless forced.
      const live = status.activeSessionCount;
      if (live > 0 && !force) return { ok: false, affectedSessions: live };
      return { ok: true, affectedSessions: force ? live : 0 };
    },
    // Mirrors the real manager's persist → re-project → gate cycle so the route
    // test's on-disk assertions (secrets.json + config.yaml) stay meaningful while
    // the route merely delegates + maps the {ok} gate to HTTP codes.
    setRouterKey: async (id: string, key: string, force: boolean) => {
      calls.routerKey.push({ id, key, force });
      const live = status.activeSessionCount;
      if (live > 0 && !force) return { ok: false, affectedSessions: live };
      const stored = await realSetRouterKey(daemonDir!, id, key);
      let st = createDefaultCliProxyState();
      try {
        st = parseCliProxyState(JSON.parse(await readFile(cliproxyStateFile(daemonDir!), "utf8")));
      } catch {
        // no persisted state — defaults stand
      }
      // A key alone projects nothing: config.yaml only renders providers that
      // exist in state. For `openrouter` the real manager materializes the record
      // from the legacy key, which is exactly what the migration helper does.
      const migrated = migrateLegacyOpenRouter(st, stored, "2026-08-04T00:00:00.000Z");
      await writeProjections(daemonDir!, migrated.secrets, migrated.state);
      return { ok: true, affectedSessions: force ? live : 0 };
    },
    // The remaining router mutations are exercised against their own fake in
    // cliproxy-config.test.ts; here they only have to exist for the route
    // manager's structural type.
    upsertRouterProvider: async (_input: unknown, force: boolean) => ({
      ok: true,
      affectedSessions: force ? status.activeSessionCount : 0
    }),
    deleteRouterProvider: async (_id: string, force: boolean) => ({
      ok: true,
      affectedSessions: force ? status.activeSessionCount : 0
    }),
    clearRouterKey: async (_id: string, force: boolean) => ({
      ok: true,
      affectedSessions: force ? status.activeSessionCount : 0
    }),
    fetchRouterCatalog: async (_id: string) =>
      ({ ok: true, models: [] }) as { ok: true; models: string[] },
    // Same story for the xAI link routes: exercised against their own fake in
    // cliproxy-config.test.ts, present here only for the structural type.
    linkXai: async () =>
      ({ ok: true, link: { url: "https://x.ai/device", userCode: "ABCD-EFGH", expiresAt: "2026-08-05T00:30:00Z" } }) as
        | { ok: true; link: CliProxyXaiLink }
        | { ok: false; code: "conflict" | "upstream"; error: string; status?: number },
    cancelOrUnlinkXai: async (opts: { force?: boolean }) => ({
      ok: true,
      affectedSessions: opts.force ? status.activeSessionCount : 0
    }),
    seedProvider: async (
      req: { provider: "codex" | "claude"; accountId: string },
      read: (provider: "codex" | "claude", accountId: string) => Promise<unknown>
    ): Promise<CliProxyProviderStatus> => {
      const cred = await read(req.provider, req.accountId);
      calls.seed.push({ req, cred });
      return { provider: req.provider, state: "ok", lastVerifiedAt: "2026-07-23T00:00:00Z" };
    },
    unseedProvider: async (
      req: { provider: "codex" | "claude"; accountId: string }
    ): Promise<CliProxyProviderStatus> => {
      calls.unseed.push({ provider: req.provider, accountId: req.accountId });
      return { provider: req.provider, state: "missing", lastVerifiedAt: null };
    }
  };
  return { manager, calls, status };
}

/** A minimal AgentAccountsService stand-in for the seed route (homePath + markProxyOwned). */
function fakeAgentAccounts(home: string) {
  const marks: Array<{ id: string; owned: boolean }> = [];
  const agentAccounts = {
    homePath: (_agent: string, _id: string) => home,
    markProxyOwned: async (id: string, owned: boolean) => {
      marks.push({ id, owned });
    }
  };
  return { agentAccounts, marks };
}

test("cliproxy mutations: 403 on local mode, reach the handler on remote mode", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-routes-")), "daemon");
  // Local (unix socket): the mutating route is registered but refuses.
  {
    const { manager, calls } = fakeRouteManager();
    const { agentAccounts } = fakeAgentAccounts(daemonDir);
    const app = Fastify();
    registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/cliproxy/enable" });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /HTTP transport/);
    assert.equal(calls.enable, 0, "local mutation must not reach the manager");
    await app.close();
  }
  // Remote (authenticated HTTP): the same route runs and returns status.
  {
    const { manager, calls } = fakeRouteManager();
    const { agentAccounts } = fakeAgentAccounts(daemonDir);
    const app = Fastify();
    registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/cliproxy/enable" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, "off");
    assert.equal(calls.enable, 1);
    await app.close();
  }
});

test("GET /api/cliproxy returns the CliProxyStatus shape incl. reasons[]", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-status-")), "daemon");
  const { manager } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/api/cliproxy" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.reasons), "reasons[] present");
  assert.equal(body.state, "off");
  assert.equal(typeof body.defaultModel, "string");
  assert.equal(typeof body.activeSessionCount, "number");
  await app.close();
});

test("seed route (remote): reads the managed credential, seeds, marks proxy-owned, returns status", async () => {
  const root = mkdtempSync(join(tmpdir(), "orq-cliproxy-seed-"));
  const daemonDir = join(root, "daemon");
  const accountId = "14137047-1111-2222-3333-444455556666";
  const home = join(root, "acct-home");
  await mkdir(home, { recursive: true });
  const cred = { claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999_000 } };
  await writeFile(join(home, ".credentials.json"), JSON.stringify(cred), "utf8");

  const { manager, calls, status } = fakeRouteManager();
  status.state = "healthy"; // seed route is gated on the proxy being launchable
  const { agentAccounts, marks } = fakeAgentAccounts(home);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/seed",
    payload: { provider: "claude", accountId }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().provider, "claude");
  assert.equal(res.json().state, "ok");
  assert.equal(calls.seed.length, 1, "seedProvider called once");
  assert.deepEqual(calls.seed[0].req, { provider: "claude", accountId });
  assert.deepEqual(calls.seed[0].cred, cred, "route reads the managed .credentials.json via agentAccounts");
  assert.deepEqual(marks, [{ id: accountId, owned: true }], "account marked proxy-owned after a successful seed");
  await app.close();
});

test("seed route refuses (409) when the proxy is not running; no seed, no ownership flip", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-seed-down-")), "daemon");
  const { manager, calls, status } = fakeRouteManager(); // status.state defaults to "off"
  const { agentAccounts, marks } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/seed",
    payload: { provider: "claude", accountId: "14137047-1111-2222-3333-444455556666" }
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().state, status.state);
  assert.equal(calls.seed.length, 0, "no auth file written when the proxy is down");
  assert.equal(marks.length, 0, "ownership never claimed when the proxy is down");
  await app.close();
});

test("seed route returns 404 (not 500) for a charset-valid accountId with no on-disk credential", async () => {
  const root = mkdtempSync(join(tmpdir(), "orq-cliproxy-seed-missing-"));
  const daemonDir = join(root, "daemon");
  const home = join(root, "acct-home");
  await mkdir(home, { recursive: true }); // home exists but has NO .credentials.json
  const accountId = "14137047-1111-2222-3333-444455556666";

  const { manager, calls, status } = fakeRouteManager();
  status.state = "healthy"; // clears the 409 proxy-health gate
  const { agentAccounts, marks } = fakeAgentAccounts(home);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/seed",
    payload: { provider: "claude", accountId }
  });
  assert.equal(res.statusCode, 404, "missing credential → clean 404, not an uncaught ENOENT 500");
  assert.equal(res.json().accountId, accountId);
  assert.equal(calls.seed.length, 0, "read throws before the fake records a seed call");
  assert.equal(marks.length, 0, "ownership never flipped on the 404 path");
  await app.close();
});

test("seed route is refused over the unix socket (403); no seed, no ownership flip", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-seed-local-")), "daemon");
  const { manager, calls } = fakeRouteManager();
  const { agentAccounts, marks } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/seed",
    payload: { provider: "claude", accountId: "x" }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /HTTP transport/);
  assert.equal(calls.seed.length, 0);
  assert.equal(marks.length, 0);
  await app.close();
});

test("unseed route (remote): calls unseedProvider, marks proxy-owned false, returns status", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-unseed-")), "daemon");
  const accountId = "14137047-1111-2222-3333-444455556666";
  const { manager, calls } = fakeRouteManager();
  const { agentAccounts, marks } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/unseed",
    payload: { provider: "claude", accountId }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().provider, "claude");
  assert.equal(res.json().state, "missing");
  assert.equal(calls.unseed.length, 1, "unseedProvider called once");
  assert.deepEqual(calls.unseed[0], { provider: "claude", accountId });
  assert.deepEqual(marks, [{ id: accountId, owned: false }], "account ownership restored to Orquester");
  await app.close();
});

test("unseed route is refused over the unix socket (403); no unseed, no ownership flip", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-unseed-local-")), "daemon");
  const { manager, calls } = fakeRouteManager();
  const { agentAccounts, marks } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/accounts/unseed",
    payload: { provider: "claude", accountId: "x" }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /HTTP transport/);
  assert.equal(calls.unseed.length, 0);
  assert.equal(marks.length, 0);
  await app.close();
});

test("router key route stores the key, re-projects config.yaml, and is restart-gated", async () => {
  const root = mkdtempSync(join(tmpdir(), "orq-cliproxy-or-"));
  const daemonDir = join(root, "daemon");
  const { manager, status } = fakeRouteManager(daemonDir);
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();

  // Restart-gated: the key lives in config.yaml (a projection the proxy reads only
  // at startup), so a live dependent session blocks the change unless forced.
  status.activeSessionCount = 2;
  const gated = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/openrouter/key",
    payload: { key: "sk-or-abc" }
  });
  assert.equal(gated.statusCode, 409);
  assert.equal(gated.json().affectedSessions, 2);
  assert.equal(existsSync(cliproxySecretsFile(daemonDir)), false, "nothing stored while gated");

  // Forced through: stores the key and re-projects config.yaml with the openrouter block.
  const forced = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/openrouter/key",
    payload: { key: "sk-or-abc", force: true }
  });
  assert.equal(forced.statusCode, 200);
  const secrets = JSON.parse(await readFile(cliproxySecretsFile(daemonDir), "utf8"));
  assert.equal(secrets.openRouterKey, "sk-or-abc");
  const config = await readFile(join(cliproxyDir(daemonDir), "config.yaml"), "utf8");
  assert.match(config, /openrouter/);
  assert.match(config, /sk-or-abc/);

  // A missing key is a client error.
  const bad = await app.inject({ method: "POST", url: "/api/cliproxy/providers/openrouter/key", payload: {} });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("router key route is refused over the unix socket (403)", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-or-local-")), "daemon");
  const { manager } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/openrouter/key",
    payload: { key: "sk-or-abc" }
  });
  assert.equal(res.statusCode, 403);
  assert.equal(existsSync(cliproxySecretsFile(daemonDir)), false, "socket refusal writes nothing");
  await app.close();
});

test("PUT /api/cliproxy/config: success resolves the full CliProxyStatus (not the {ok} gate result); restart-gated → 409", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-config-")), "daemon");
  const { manager, calls, status } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();

  // Success: the route must return the CliProxyStatus shape the wire contract
  // promises — providers[]/defaultModel/reasons — not {ok, affectedSessions}.
  const ok = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/config",
    payload: { defaultModel: "kimi-k3" }
  });
  assert.equal(ok.statusCode, 200);
  const body = ok.json();
  assert.ok(Array.isArray(body.providers), "providers[] present → it is a CliProxyStatus");
  assert.ok(Array.isArray(body.reasons), "reasons[] present");
  assert.equal(typeof body.defaultModel, "string");
  assert.equal(body.ok, undefined, "the internal gate result must not leak to the wire");
  assert.deepEqual(calls.setConfig.at(-1), {
    cfg: { defaultModel: "kimi-k3", backgroundModel: undefined, claudeDefaultModel: undefined },
    force: false
  });

  // Restart-gated: a live dependent session blocks the change unless forced.
  status.activeSessionCount = 2;
  const gated = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/config",
    payload: { defaultModel: "kimi-k3" }
  });
  assert.equal(gated.statusCode, 409);
  assert.equal(gated.json().affectedSessions, 2);

  // Forced through → back to a 200 CliProxyStatus.
  const forced = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/config",
    payload: { defaultModel: "kimi-k3", force: true }
  });
  assert.equal(forced.statusCode, 200);
  assert.ok(Array.isArray(forced.json().providers));

  // Invalid model name is a client error before the manager is consulted.
  const bad = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/config",
    payload: { defaultModel: "bad model name!" }
  });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("PUT /api/cliproxy/config is refused over the unix socket (403); the manager is never consulted", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-config-local-")), "daemon");
  const { manager, calls } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/config",
    payload: { defaultModel: "kimi-k3" }
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /HTTP transport/);
  assert.equal(calls.setConfig.length, 0, "local mutation must not reach the manager");
  await app.close();
});

test("cliproxyContributor: a real account prefixes the effective model; System/undefined does not", () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-contrib-")), "daemon");

  // A real managed account stamps the deterministic per-account routing prefix.
  const withAccount = cliproxyContributor(
    "claudex",
    { accountId: "14137047-1111-2222-3333-444455556666", model: "gpt-5.6-sol" },
    daemonDir
  );
  assert.ok(withAccount);
  assert.equal(withAccount.env.ANTHROPIC_MODEL, "acc14137047/gpt-5.6-sol");
  assert.equal(
    withAccount.env.CLAUDE_CODE_SUBAGENT_MODEL,
    undefined,
    "no subagent pin — subagents inherit the current main model"
  );

  // No account → the effective model is unprefixed (keyless OpenRouter/Kimi path).
  const noAccount = cliproxyContributor("claudex", { model: "gpt-5.6-sol" }, daemonDir);
  assert.ok(noAccount);
  assert.equal(noAccount.env.ANTHROPIC_MODEL, "gpt-5.6-sol");

  // The System sentinel is the host identity — treated as no account (no prefix).
  const system = cliproxyContributor(
    "claudemix",
    { accountId: SYSTEM_ACCOUNT_ID, model: "claude-sonnet-4" },
    daemonDir
  );
  assert.ok(system);
  assert.equal(system.env.ANTHROPIC_MODEL, "claude-sonnet-4");

  // A non-managed launcher never contributes.
  assert.equal(cliproxyContributor("claude", { accountId: "abc-1", model: "x" }, daemonDir), null);
});

test("cliproxyContributor: a router-provider model is emitted bare even with an account; other models are prefixed", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-kimi-")), "daemon");
  const accountId = "14137047-1111-2222-3333-444455556666";
  // Routing is decided by the persisted router-provider index, not the name shape.
  await writeEnabledState(daemonDir, {
    routerProviders: [
      routerProvider("openrouter", {
        preset: "openrouter",
        models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }]
      })
    ]
  });

  // Kimi is served by the router's own key → NO account prefix, even when a real
  // managed account was picked (a stale pick must not misroute it).
  const kimi = cliproxyContributor("claudex", { accountId, model: "kimi-k3" }, daemonDir);
  assert.ok(kimi);
  assert.equal(kimi.env.ANTHROPIC_MODEL, "kimi-k3");
  assert.equal(kimi.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, "no subagent pin");

  // A non-router model with the same account IS prefixed (the routing default).
  const gpt = cliproxyContributor("claudex", { accountId, model: "gpt-5.6-sol" }, daemonDir);
  assert.ok(gpt);
  assert.equal(gpt.env.ANTHROPIC_MODEL, "acc14137047/gpt-5.6-sol");
});

test("composeExtraEnv: cliproxy env wins on collision, accountId preserved, unsets concatenated", () => {
  const a = { env: { CLAUDE_CONFIG_DIR: "/home/a", FOO: "1" }, unset: ["A_UNSET"], accountId: "acc-1" };
  const b = { env: { CLAUDE_CONFIG_DIR: "/proxy-home", ANTHROPIC_AUTH_TOKEN: "tok" }, unset: ["B_UNSET"] };
  const r = composeExtraEnv(a, b);
  assert.ok(r);
  assert.equal(r.env.CLAUDE_CONFIG_DIR, "/proxy-home", "b wins on collision");
  assert.equal(r.env.FOO, "1");
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, "tok");
  assert.equal(r.accountId, "acc-1", "accountId preserved from a");
  assert.deepEqual(r.unset, ["A_UNSET", "B_UNSET"], "unsets concatenated");
  assert.equal(composeExtraEnv(null, null), null);
  // A managed-account contribution with no cliproxy contribution passes through.
  const only = composeExtraEnv({ env: { CODEX_HOME: "/h" }, accountId: "x" }, null);
  assert.deepEqual(only, { env: { CODEX_HOME: "/h" }, accountId: "x" });
});

test("session model gate: model on refId 'claude' → 400; 'claudex' passes through validateModel", async () => {
  const seen: Array<{ entryId: string; model?: string }> = [];
  const validateModel = async (entryId: string, model: string | undefined) => {
    seen.push({ entryId, model });
    return { ok: true as const, effectiveModel: model ?? "gpt-5.6-sol" };
  };

  const rejected = await resolveLaunchModel("claude", "kimi-k3", validateModel);
  assert.equal(rejected.ok, false);
  if (rejected.ok === false) assert.match(String(rejected.body.error), /claudex\/claudemix/);
  assert.equal(seen.length, 0, "validateModel is not consulted for non-managed launchers");

  const passed = await resolveLaunchModel("claudex", "kimi-k3", validateModel);
  assert.equal(passed.ok, true);
  if (passed.ok) assert.equal(passed.effectiveModel, "kimi-k3");
  assert.deepEqual(seen, [{ entryId: "claudex", model: "kimi-k3" }], "claudex is routed through validateModel");
});

test("seedProvider: a managed-account label wins over converted email/UUID (claude has no email)", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });
  await h.mgr.enable();
  const accountId = "7f46e45d-1111-2222-3333-444455556666";
  const creds = {
    claudeAiOauth: {
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000
    }
  };
  const status = await h.mgr.seedProvider(
    { provider: "claude", accountId, label: "therealeduard465@gmail.com" },
    async () => creds
  );
  assert.equal(status.state, "ok");
  const acct = h.mgr.status().accounts.find((a) => a.id === accountId);
  assert.equal(acct?.label, "therealeduard465@gmail.com", "label from the managed account, not the UUID");
  const persisted = parseCliProxyState(
    JSON.parse(await readFile(cliproxyStateFile(h.daemonDir), "utf8"))
  );
  assert.equal(
    persisted.seededAccounts.find((a) => a.accountId === accountId)?.label,
    "therealeduard465@gmail.com"
  );
});

test("seedProvider: second claude account seeds ALONGSIDE the first (multi-account routing)", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });
  await h.mgr.enable();
  const mk = (at: string) => ({
    claudeAiOauth: { accessToken: at, refreshToken: "rt", expiresAt: Date.now() + 3600_000 }
  });
  await h.mgr.seedProvider({ provider: "claude", accountId: "14137047-aaaa-bbbb-cccc-ddddeeeeffff", label: "a@x.com" }, async () => mk("a1"));
  await h.mgr.seedProvider({ provider: "claude", accountId: "7f46e45d-aaaa-bbbb-cccc-ddddeeeeffff", label: "b@x.com" }, async () => mk("b1"));
  const claude = h.mgr.status().accounts.filter((a) => a.provider === "claude");
  assert.equal(claude.length, 2, "both claude accounts seeded");
  assert.ok(existsSync(join(cliproxyDir(h.daemonDir), "auth", "claude-acc14137047.json")));
  assert.ok(existsSync(join(cliproxyDir(h.daemonDir), "auth", "claude-acc7f46e45d.json")));
});

// --- xAI (Grok) OAuth account: spec 2026-08-05 §B ----------------------------

/** Write a CLIProxyAPI-shaped xai auth file (the proxy owns these; the daemon
 *  only ever reads them). */
async function writeXaiAuth(
  daemonDir: string,
  opts: { email?: string; expired?: string; file?: string; raw?: string } = {}
): Promise<void> {
  const dir = join(cliproxyDir(daemonDir), "auth");
  await mkdir(dir, { recursive: true });
  const file = join(dir, opts.file ?? `xai-${opts.email ?? "grok"}.json`);
  if (opts.raw !== undefined) {
    await writeFile(file, opts.raw, "utf8");
    return;
  }
  await writeFile(
    file,
    JSON.stringify({
      type: "xai",
      auth_kind: "oauth",
      access_token: "at",
      refresh_token: "rt",
      email: opts.email ?? "grok@example.com",
      expired: opts.expired ?? new Date(Date.now() + 3600_000).toISOString()
    }),
    { mode: 0o600 }
  );
}

/** The link poll runs OUTSIDE the transition queue, so tests wait on its effect. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("xai status: derived from the auth dir — none, linked (email/expiry), corrupt files ignored", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  await writeSecretsFile(h.daemonDir, {});
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });

  await h.mgr.init();
  assert.deepEqual(h.mgr.status().xai, {
    state: "none",
    email: null,
    expiredAt: null,
    lastQuotaError: null,
    lastLinkError: null,
    link: null
  });

  const expiredAt = new Date(Date.now() + 3600_000).toISOString();
  await writeXaiAuth(h.daemonDir, { email: "pilot@example.com", expired: expiredAt });
  await writeXaiAuth(h.daemonDir, { file: "xai-broken.json", raw: "{not json" });

  const h2 = setup();
  // Same appdir contents, fresh manager: state must come from the files alone.
  await writeEnabledState(h2.daemonDir);
  await writeSecretsFile(h2.daemonDir, {});
  await writeXaiAuth(h2.daemonDir, { email: "pilot@example.com", expired: expiredAt });
  await writeXaiAuth(h2.daemonDir, { file: "xai-broken.json", raw: "{not json" });
  h2.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h2.mgr.init();
  const xai = h2.mgr.status().xai;
  assert.equal(xai.state, "linked", "a corrupt sibling must not hide the good account");
  assert.equal(xai.email, "pilot@example.com");
  assert.equal(xai.expiredAt, expiredAt);
});

test("xai status: every auth file past its stamp reads expired, even with the proxy off", async () => {
  const h = setup();
  await writeXaiAuth(h.daemonDir, {
    email: "stale@example.com",
    expired: new Date(Date.now() - 60_000).toISOString()
  });

  // No enabled state on disk → init() short-circuits before adoption; the xai
  // view is still derived (the Settings card must show it while the proxy is off).
  await h.mgr.init();
  assert.equal(h.mgr.status().state, "off");
  assert.equal(h.mgr.status().xai.state, "expired");
  assert.equal(h.mgr.status().xai.email, "stale@example.com");
});

test("claudex coupling: a linked Grok account alone satisfies the gate", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, {
    // A seeded claude account makes provider info known, so the gate applies.
    seededAccounts: [
      {
        provider: "claude",
        accountId: "65eebd90-01d1-4063-b743-c4a5713f5519",
        label: "claude a",
        prefix: "acc65eebd90"
      }
    ]
  });
  await writeSecretsFile(h.daemonDir, {});
  await writeXaiAuth(h.daemonDir, { email: "pilot@example.com" });
  h.setProbe({ ok: true, reachable: true, models: ["claude-fable-5"] });

  await h.mgr.init();

  const lastClaudex = [...h.registryCalls].reverse().find((c) => c.id === "claudex");
  assert.equal(lastClaudex?.enabled, true, "the linked Grok account satisfies claudex");
  assert.equal(lastClaudex?.disabledReason, undefined);
  // xai says nothing about the claude credential claudemix needs.
  const lastClaudemix = [...h.registryCalls].reverse().find((c) => c.id === "claudemix");
  assert.equal(lastClaudemix?.enabled, true);
});

test("probe union: grok ids validate while linked (no catalog dependency)", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir);
  await writeSecretsFile(h.daemonDir, {});
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.init();

  const before = await h.mgr.validateModel("claudex", "grok-build-0.1");
  assert.equal(before.ok, false, "not offered while nothing is linked");

  await writeXaiAuth(h.daemonDir, { email: "pilot@example.com" });
  await h.mgr.checkHealth(); // the health poll re-derives the xai view
  const after = await h.mgr.validateModel("claudex", "grok-build-0.1");
  assert.equal(after.ok, true, "unioned into the live catalog while linked");
  assert.ok(after.ok && after.catalog.includes("grok-4.5"), "both curated ids join");
});

test("linkXai: refuses while the proxy is off, and 409-shapes an already-linked account", async () => {
  const h = setup();
  await h.mgr.init(); // disabled → state "off"
  const off = await h.mgr.linkXai();
  assert.equal(off.ok, false);
  assert.equal(off.ok === false && off.code, "conflict");
  assert.match(off.ok === false ? off.error : "", /must be running/);
  assert.equal(h.xaiCalls.authUrl, 0, "no management call while the proxy is down");

  const h2 = setup();
  await writeXaiAuth(h2.daemonDir, { email: "pilot@example.com" });
  h2.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h2.mgr.enable();
  const already = await h2.mgr.linkXai();
  assert.equal(already.ok, false);
  assert.equal(already.ok === false && already.code, "conflict");
  assert.match(already.ok === false ? already.error : "", /already linked/);
});

test("linkXai: management-API failure surfaces as an upstream result carrying the status", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  h.setXaiAuthUrl(async () => ({ ok: false, error: "management API responded 500", status: 500 }));

  const res = await h.mgr.linkXai();
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "upstream");
  assert.equal(res.ok === false ? res.status : undefined, 500);
  assert.equal(h.mgr.status().xai.state, "none", "a failed start leaves no linking session");
});

test("linkXai: device flow → linking status, then the proxy's auth file completes it", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  h.setXaiAuthUrl(async () => ({
    ok: true,
    value: { url: "https://x.ai/device", userCode: "ABCD-EFGH", state: "sess-1", expiresIn: 1800 }
  }));
  let polls = 0;
  h.setXaiPoll(async () => {
    polls++;
    if (polls < 2) return { ok: true, value: { status: "wait" } };
    // The proxy's own goroutine writes the auth file on success.
    await writeXaiAuth(h.daemonDir, { email: "pilot@example.com" });
    return { ok: true, value: { status: "ok" } };
  });

  const started = await h.mgr.linkXai();
  assert.equal(started.ok, true);
  assert.equal(started.ok && started.link.url, "https://x.ai/device");
  assert.equal(started.ok && started.link.userCode, "ABCD-EFGH");
  const linking = h.mgr.status().xai;
  assert.equal(linking.state, "linking");
  assert.equal(linking.link?.url, "https://x.ai/device");

  await waitFor(() => h.mgr.status().xai.state === "linked", "the link to complete");
  const linked = h.mgr.status().xai;
  assert.equal(linked.email, "pilot@example.com");
  assert.equal(linked.link, null, "the in-flight prompt is cleared");
  // Second link attempt while one is in flight is a 409-shaped conflict.
  const duplicate = await h.mgr.linkXai();
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.ok === false && duplicate.code, "conflict");
});

test("linkXai: an in-flight session is cancelled through the management API", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  h.setXaiAuthUrl(async () => ({
    ok: true,
    value: { url: "https://x.ai/device", userCode: "ABCD-EFGH", state: "sess-9", expiresIn: 1800 }
  }));
  h.setXaiPoll(async () => ({ ok: true, value: { status: "wait" } }));

  assert.equal((await h.mgr.linkXai()).ok, true);
  const cancelled = await h.mgr.cancelOrUnlinkXai({});
  assert.equal(cancelled.ok, true);
  assert.ok(h.xaiCalls.cancel.includes("sess-9"), "the proxy-side session is dropped");
  assert.equal(h.mgr.status().xai.state, "none");
});

test("linkXai: a failed verdict lands on xai.lastLinkError and a fresh attempt clears it", async () => {
  const h = setup();
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.enable();
  h.setXaiAuthUrl(async () => ({
    ok: true,
    value: { url: "https://x.ai/device", userCode: "ABCD-EFGH", state: "sess-2", expiresIn: 1800 }
  }));
  h.setXaiPoll(async () => ({ ok: true, value: { status: "error", error: "authorization denied" } }));

  assert.equal((await h.mgr.linkXai()).ok, true);
  await waitFor(() => h.mgr.status().xai.state === "none", "the failed flow to settle");
  // The verdict lives on the xai block, NOT the proxy-health `detail` (which
  // every setState — incl. the periodic becomeHealthy — wipes within a poll).
  assert.equal(h.mgr.status().xai.lastLinkError, "authorization denied");
  assert.equal(h.mgr.status().detail, null, "proxy health detail is not abused for the verdict");
  assert.ok(h.xaiCalls.cancel.includes("sess-2"), "the proxy-side session is dropped");

  assert.equal((await h.mgr.linkXai()).ok, true);
  assert.equal(h.mgr.status().xai.lastLinkError, null, "a fresh attempt supersedes the verdict");
});

test("cancelOrUnlinkXai: live Grok sessions refuse the unlink; force deletes the auth files", async () => {
  const h = setup();
  await writeEnabledState(h.daemonDir, { defaultModel: "grok-build-0.1" });
  await writeSecretsFile(h.daemonDir, {});
  await writeXaiAuth(h.daemonDir, { email: "pilot@example.com" });
  h.setProbe({ ok: true, reachable: true, models: ["gpt-5.6-sol"] });
  await h.mgr.init();
  assert.equal(h.mgr.status().xai.state, "linked");

  const configBefore = await readFile(join(cliproxyDir(h.daemonDir), "config.yaml"), "utf8");

  h.setXaiLive(2);
  const refused = await h.mgr.cancelOrUnlinkXai({});
  assert.equal(refused.ok, false);
  assert.equal(refused.affectedSessions, 2);
  assert.equal(h.mgr.status().xai.state, "linked", "nothing removed on a refusal");

  const forced = await h.mgr.cancelOrUnlinkXai({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.affectedSessions, 2);
  assert.equal(h.mgr.status().xai.state, "none");
  assert.ok(!existsSync(join(cliproxyDir(h.daemonDir), "auth", "xai-pilot@example.com.json")));
  assert.equal(h.mgr.status().defaultModel, "gpt-5.6-sol", "a dangling grok pick resets");
  // …and the reset must reach the env projection: claudex.env pins
  // ANTHROPIC_MODEL, so a stale grok id there launches every new modelless
  // session against a credential that no longer exists.
  const claudexEnv = await readFile(join(h.daemonDir, "env", "claudex.env"), "utf8");
  assert.ok(claudexEnv.includes("ANTHROPIC_MODEL=gpt-5.6-sol\n"), "claudex.env follows the reset pick");
  assert.ok(!claudexEnv.includes("grok-build-0.1"), "no stale grok id survives in the launch env");
  // No config.yaml change and no restart in either direction (spec §B.2): xai
  // contributes nothing to it, so the re-render is byte-identical.
  assert.equal(await readFile(join(cliproxyDir(h.daemonDir), "config.yaml"), "utf8"), configBefore);
  assert.equal(h.tmuxCalls.newService, 0);
  // Idempotent: unlinking again is a no-op ok.
  assert.equal((await h.mgr.cancelOrUnlinkXai({ force: true })).ok, true);
});
