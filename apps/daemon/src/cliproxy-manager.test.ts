import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cliproxyDir,
  cliproxySecretsFile,
  cliproxyStateFile,
  createDefaultCliProxyState
} from "@orquester/config";
import Fastify from "fastify";
import type { CliProxyProviderStatus, CliProxyStatus } from "@orquester/api";
import { SYSTEM_ACCOUNT_ID } from "@orquester/api";
import type { RegistryService } from "./registry.ts";
import { Broadcaster } from "./broadcaster.ts";
import { CliProxyManager } from "./cliproxy.ts";
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
    }
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

  let clock = 1000;
  let liveCount = 0;

  let installCount = 0;
  let installImpl: () => Promise<{ version: string }> = async () => {
    installCount++;
    await writeBin(daemonDir);
    return { version: "v7.2.95" };
  };
  const sysDir = join(root, "sysclaude");

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
      now: () => clock,
      install: () => installImpl(),
      systemClaudeDir: () => sysDir
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
    installCount: () => installCount,
    setInstall: (f: () => Promise<{ version: string }>) => {
      installImpl = f;
    },
    sysDir
  };
}

async function writeEnabledState(daemonDir: string): Promise<void> {
  const state = { ...createDefaultCliProxyState(), enabled: true };
  await mkdir(cliproxyDir(daemonDir), { recursive: true });
  await writeFile(cliproxyStateFile(daemonDir), JSON.stringify(state), "utf8");
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

test("persistence-lost proxy is re-parented under tmux once sessions drain, not just relabeled", async () => {
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

  // Sessions drain → re-parent: external cleared only AFTER a tmux-hosted spawn.
  h.setLive(0);
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
});

test("validateModel: request model wins over default; unknown model fails naming provider; probe hang → bounded failure ≤2s", async (t) => {
  // (a) request model wins over the configured default.
  {
    const h = setup();
    h.setProbe({ ok: true, models: ["model-a", "gpt-5.6-sol"] });
    const r = await h.mgr.validateModel("claudex", "model-a");
    assert.deepEqual(r, { ok: true, effectiveModel: "model-a" });
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
    assert.deepEqual(r, { ok: true, effectiveModel: "gpt-5.6-sol" });
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

// --- Task 9: /api/cliproxy routes + launch-env composition + model gate --------

function fakeRouteManager() {
  const calls = {
    enable: 0,
    disable: [] as boolean[],
    setConfig: [] as Array<{ cfg: unknown; force: boolean }>,
    seed: [] as Array<{ req: { provider: "codex" | "claude"; accountId: string }; cred: unknown }>
  };
  const status: CliProxyStatus = {
    state: "off",
    reasons: [],
    detail: null,
    version: null,
    defaultModel: "gpt-5.6-sol",
    backgroundModel: "gpt-5.6-sol",
    providers: [],
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
    setConfig: async (cfg: { defaultModel?: string; backgroundModel?: string }, force: boolean) => {
      calls.setConfig.push({ cfg, force });
      // Restart-gated like the real manager: refuse while live sessions exist
      // unless forced.
      const live = status.activeSessionCount;
      if (live > 0 && !force) return { ok: false, affectedSessions: live };
      return { ok: true, affectedSessions: force ? live : 0 };
    },
    seedProvider: async (
      req: { provider: "codex" | "claude"; accountId: string },
      read: (provider: "codex" | "claude", accountId: string) => Promise<unknown>
    ): Promise<CliProxyProviderStatus> => {
      const cred = await read(req.provider, req.accountId);
      calls.seed.push({ req, cred });
      return { provider: req.provider, state: "ok", lastVerifiedAt: "2026-07-23T00:00:00Z" };
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

  const { manager, calls } = fakeRouteManager();
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

test("openrouter/key route stores the key, re-projects config.yaml, and is restart-gated", async () => {
  const root = mkdtempSync(join(tmpdir(), "orq-cliproxy-or-"));
  const daemonDir = join(root, "daemon");
  const { manager, status } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "remote", daemonDir, agentAccounts });
  await app.ready();

  // Restart-gated: the key lives in config.yaml (a projection the proxy reads only
  // at startup), so a live dependent session blocks the change unless forced.
  status.activeSessionCount = 2;
  const gated = await app.inject({
    method: "POST",
    url: "/api/cliproxy/openrouter/key",
    payload: { key: "sk-or-abc" }
  });
  assert.equal(gated.statusCode, 409);
  assert.equal(gated.json().affectedSessions, 2);
  assert.equal(existsSync(cliproxySecretsFile(daemonDir)), false, "nothing stored while gated");

  // Forced through: stores the key and re-projects config.yaml with the openrouter block.
  const forced = await app.inject({
    method: "POST",
    url: "/api/cliproxy/openrouter/key",
    payload: { key: "sk-or-abc", force: true }
  });
  assert.equal(forced.statusCode, 200);
  const secrets = JSON.parse(await readFile(cliproxySecretsFile(daemonDir), "utf8"));
  assert.equal(secrets.openRouterKey, "sk-or-abc");
  const config = await readFile(join(cliproxyDir(daemonDir), "config.yaml"), "utf8");
  assert.match(config, /openrouter/);
  assert.match(config, /sk-or-abc/);

  // A missing key is a client error.
  const bad = await app.inject({ method: "POST", url: "/api/cliproxy/openrouter/key", payload: {} });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("openrouter/key route is refused over the unix socket (403)", async () => {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-or-local-")), "daemon");
  const { manager } = fakeRouteManager();
  const { agentAccounts } = fakeAgentAccounts(daemonDir);
  const app = Fastify();
  registerCliProxyRoutes(app, { manager, mode: "local", daemonDir, agentAccounts });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/api/cliproxy/openrouter/key",
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
  assert.deepEqual(calls.setConfig.at(-1), { cfg: { defaultModel: "kimi-k3", backgroundModel: undefined }, force: false });

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
  assert.equal(withAccount.env.CLAUDE_CODE_SUBAGENT_MODEL, "acc14137047/gpt-5.6-sol");

  // No account → the effective model is unprefixed (keyless OpenRouter/Kimi path).
  const noAccount = cliproxyContributor("claudex", { model: "gpt-5.6-sol" }, daemonDir);
  assert.ok(noAccount);
  assert.equal(noAccount.env.ANTHROPIC_MODEL, "gpt-5.6-sol");
  assert.equal(noAccount.env.CLAUDE_CODE_SUBAGENT_MODEL, "gpt-5.6-sol");

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
