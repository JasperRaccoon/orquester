import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cliproxyDir,
  cliproxySecretsFile,
  cliproxyStateFile,
  createDefaultCliProxyState
} from "@orquester/config";
import type { RegistryService } from "./registry.ts";
import { Broadcaster } from "./broadcaster.ts";
import { CliProxyManager } from "./cliproxy.ts";

type ProbeResult = { ok: boolean; reachable?: boolean; models?: string[] };

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
      now: () => clock
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
    }
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
