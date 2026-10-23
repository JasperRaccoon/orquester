import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  EPHEMERAL_VMS_PLUGIN_ID,
  EXCALIDRAW_PLUGIN_ID,
  KNOWLEDGE_GRAPH_PLUGIN_ID,
  SECRET_FILES_PLUGIN_ID,
  type PluginInfo,
  type PluginsResponse,
  TS_RUST_PLUGIN_ID,
  type TsCheckerEngine
} from "@orquester/api";
import { pluginsConfigPath, tsRustPluginDir, tsRustPreloadPath, tsrsEngineDir } from "@orquester/config";
import { PLUGIN_CHECK_INTERVAL_MS, PluginsError, PluginsService } from "./plugins-service.ts";
import { type FakeRegistry, combinedRegistryDeps, fakeRegistry, publish, tempRoot } from "./testing.ts";
import { type HostLibc, TS_CHECKER_ENGINE_SPECS } from "./ts-rust/installer.ts";
import type { TsRustPreloadOptions } from "./ts-rust/preload.ts";
import { createTsRustToolingPlugin } from "./ts-rust/box-tooling.ts";

// The plugins service over a temp appdir and workspaces root, in-memory npm
// registries of both engines with fixture tarballs (./testing.ts) and stubbed
// preload writer and session-env setter: plugins.json ownership, the job
// queue, the timer, the engine choice, and the preload / session-env decisions.
// The default host is linux-x64 with glibc, where tsrs is the default engine;
// the tests not about engines run against it.

const ID = TS_RUST_PLUGIN_ID;
const ENGINES: readonly TsCheckerEngine[] = ["tsrs", "tsc-rs"];

interface Harness {
  root: string;
  baseDir: string;
  workspacesDir: { current: string };
  file: string;
  /** The host's default engine. */
  engine: TsCheckerEngine;
  /** The default engine's dir: its versions/ and .tmp/. */
  engineDir: string;
  /** Each engine's dir. */
  engineDirs: Record<TsCheckerEngine, string>;
  /** The default engine's registry. */
  registry: FakeRegistry;
  registries: Record<TsCheckerEngine, FakeRegistry>;
  service: PluginsService;
  /** Every `writePreload` call. */
  preloadWrites: Array<{ path: string; options: TsRustPreloadOptions }>;
  /** Every `setSessionPreload` call. */
  sessionPreload: Array<string | null>;
  /** Every plugins.json write, in order. */
  writes: unknown[];
  /** Every `"changed"` payload. */
  events: PluginsResponse[];
  /** Set to make the next plugins.json write fail. */
  failNextWrite: { value: boolean };
  /** Set to make every preload write fail. */
  failPreload: { value: boolean };
  /** Build (and start) a fresh service over the same dirs, as a restart does. */
  restart: () => Promise<PluginsService>;
}

async function harness(
  t: TestContext,
  options: {
    platform?: string;
    arch?: string;
    libc?: HostLibc;
    start?: boolean;
    seed?: unknown;
    workspaces?: string[];
  } = {}
): Promise<Harness> {
  const platform = options.platform ?? "linux";
  const arch = options.arch ?? "x64";
  const libc = options.libc ?? "glibc";
  const root = await tempRoot("orq-plugins-service-");
  const baseDir = join(root, "appdir");
  const workspacesDir = { current: join(root, "workspaces") };
  for (const name of options.workspaces ?? ["acme", "beta"]) {
    await mkdir(join(workspacesDir.current, name), { recursive: true });
  }
  const file = pluginsConfigPath(baseDir);
  if (options.seed !== undefined) {
    await mkdir(join(baseDir, "daemon"), { recursive: true });
    await writeFile(file, typeof options.seed === "string" ? options.seed : JSON.stringify(options.seed), "utf8");
  }
  // Each engine's registry serves this host's platform package (a stand-in where the engine has none).
  const registries = Object.fromEntries(
    ENGINES.map((engine) => {
      const spec = TS_CHECKER_ENGINE_SPECS[engine];
      return [engine, fakeRegistry(undefined, spec, spec.platformPackage(platform, arch, libc) ?? `@${engine}/none`)];
    })
  ) as Record<TsCheckerEngine, FakeRegistry>;
  const engine: TsCheckerEngine =
    TS_CHECKER_ENGINE_SPECS.tsrs.platformPackage(platform, arch, libc) !== null ? "tsrs" : "tsc-rs";
  const engineDirs: Record<TsCheckerEngine, string> = { "tsc-rs": tsRustPluginDir(baseDir), tsrs: tsrsEngineDir(baseDir) };
  const installer = combinedRegistryDeps(ENGINES.map((id) => registries[id]));
  const h: Harness = {
    root,
    baseDir,
    workspacesDir,
    file,
    engine,
    engineDir: engineDirs[engine],
    engineDirs,
    registry: registries[engine],
    registries,
    service: undefined as never,
    preloadWrites: [],
    sessionPreload: [],
    writes: [],
    events: [],
    failNextWrite: { value: false },
    failPreload: { value: false },
    restart: async () => {
      await h.service.stop();
      h.service = build();
      await h.service.start();
      await h.service.settled();
      return h.service;
    }
  };
  const build = () => {
    const service = new PluginsService({
      baseDir,
      workspacesDir: () => workspacesDir.current,
      writeJson: async (path, value) => {
        if (h.failNextWrite.value) {
          h.failNextWrite.value = false;
          throw new Error("ENOSPC: no space left on device");
        }
        h.writes.push(JSON.parse(JSON.stringify(value)));
        await mkdir(join(baseDir, "daemon"), { recursive: true });
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      },
      installer,
      env: { PATH: process.env.PATH, ORQUESTER_APPDIR: baseDir },
      platform,
      arch,
      libc,
      writePreload: async (path, preloadOptions) => {
        if (h.failPreload.value) throw new Error("EACCES: permission denied");
        h.preloadWrites.push({ path, options: preloadOptions });
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "// preload\n", "utf8");
      },
      setSessionPreload: (path) => h.sessionPreload.push(path),
      logger: { warn: () => {}, error: () => {} }
    });
    service.events.on("changed", (response: PluginsResponse) => h.events.push(response));
    return service;
  };
  h.service = build();
  t.after(async () => {
    await h.service.stop();
    await rm(root, { recursive: true, force: true });
  });
  if (options.start !== false) {
    await h.service.start();
    await h.service.settled();
  }
  return h;
}

async function plugin(h: Harness, id: PluginInfo["id"] = ID): Promise<PluginInfo> {
  const response = await h.service.list();
  assert.deepEqual(
    response.plugins.map((p) => p.id),
    [ID, EXCALIDRAW_PLUGIN_ID, SECRET_FILES_PLUGIN_ID, EPHEMERAL_VMS_PLUGIN_ID, KNOWLEDGE_GRAPH_PLUGIN_ID]
  );
  return response.plugins.find((p) => p.id === id) as PluginInfo;
}

async function onDisk(h: Harness): Promise<any> {
  return JSON.parse(await readFile(h.file, "utf8"));
}

/** An engine's versions in the stored ts-rust record (the default engine's by default). */
function engineRecord(h: Harness, stored: any, engine: TsCheckerEngine = h.engine): any {
  return engine === "tsrs" ? (stored.tsrs ?? {}) : stored;
}

async function versions(h: Harness, engine: TsCheckerEngine = h.engine): Promise<string[]> {
  return readdir(join(h.engineDirs[engine], "versions")).then(
    (names) => names.sort(),
    () => []
  );
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

async function refusal(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PluginsError, `expected a PluginsError, got ${String(error)}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

/** The engine options the preload is written with on a host where both engines have a build. */
const BOTH_ENGINES = { supportedEngines: ["tsrs", "tsc-rs"], defaultEngine: "tsrs" } as const;

/** Turn the plugin on and wait for the first install it queues. */
async function enable(h: Harness): Promise<PluginInfo> {
  const info = await h.service.update(ID, { enabled: true });
  await h.service.settled();
  return info;
}

async function check(h: Harness): Promise<void> {
  await h.service.checkNow(ID);
  await h.service.settled();
}

test("a first start with no plugins.json: nothing written, nothing fetched, no preload", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await plugin(h), {
    id: ID,
    name: "Better TS Typecheck",
    description: "Use tsrs or tsc-rs, native ports of TypeScript 7, instead of tsc for faster typechecking.",
    source: { label: "oxc-project/tsrs", url: "https://github.com/oxc-project/tsrs" },
    provider: "Community",
    scope: "global",
    updates: true,
    platform: "supported",
    enabled: false,
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle",
    engine: "tsrs",
    engines: [
      {
        id: "tsrs",
        label: "tsrs",
        description: "The fastest. For Linux and Apple Silicon Macs.",
        source: { label: "oxc-project/tsrs", url: "https://github.com/oxc-project/tsrs" },
        platform: "supported"
      },
      {
        id: "tsc-rs",
        label: "tsc-rs",
        description: "Also runs on Windows and Intel Macs.",
        source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
        platform: "supported"
      }
    ]
  });
  assert.equal(await exists(h.file), false);
  assert.equal(h.registry.calls.latest, 0);
  assert.deepEqual(h.preloadWrites, []);
  assert.deepEqual(h.sessionPreload, [null]);
});

test("turning the plugin on writes the preload, turns on the session preload and installs the default engine", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";

  const info = await enable(h);
  assert.equal(info.enabled, true);
  assert.deepEqual(info.enabledWorkspaces, []);
  assert.deepEqual(h.preloadWrites, [
    {
      path: tsRustPreloadPath(h.baseDir),
      options: { statePath: h.file, workspacesRoot: await realpath(h.workspacesDir.current), ...BOTH_ENGINES }
    }
  ]);
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));

  const after = await plugin(h);
  assert.equal(after.current?.version, "0.7.0");
  assert.equal(after.current?.installedAt, "2026-10-14T12:00:00.000Z");
  assert.equal(after.previous, null);
  assert.equal(after.lastCheckAt, "2026-10-14T12:00:00.000Z");
  assert.equal(after.job, "idle");
  assert.deepEqual(await versions(h), ["0.7.0"]);
  const stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.tsrs.current.version, "0.7.0");
  assert.equal(stored.current, undefined, "tsc-rs's own fields are untouched");
  assert.equal(stored.engine, undefined, "the default engine is not written");
  assert.equal(stored.enabled, true);
  assert.equal("enabledWorkspaces" in stored, false, "no per-workspace list is written");

  // Progress went out in order: the toggle, then checking → installing → idle with the install.
  const jobs = h.events.map((event) => event.plugins[0]?.job);
  assert.deepEqual(jobs, ["idle", "checking", "installing", "idle"]);
  assert.equal(h.events.at(-1)?.plugins[0]?.current?.version, "0.7.0");

  // Turning it on again installs nothing more.
  await enable(h);
  assert.equal(h.registry.calls.latest, 1);
  assert.equal((await plugin(h)).enabled, true);
});

test("turning tsc-rs off clears the session preload and the timer, and keeps the install", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await enable(h);
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));

  const off = await h.service.update(ID, { enabled: false });
  await h.service.settled();
  assert.equal(off.enabled, false);
  assert.equal(off.current?.version, "0.7.0");
  assert.equal(h.sessionPreload.at(-1), null);
  assert.equal((await onDisk(h)).plugins[ID].enabled, undefined);
  assert.equal(h.events.at(-1)?.plugins[0]?.enabled, false);

  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 1, "the hourly check is disarmed");
});

test("updates move current to previous and prune everything older", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0", "0.9.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);

  h.registry.latest = "0.8.0";
  await check(h);
  let info = await plugin(h);
  assert.equal(info.current?.version, "0.8.0");
  assert.equal(info.previous?.version, "0.7.0");
  assert.deepEqual(await versions(h), ["0.7.0", "0.8.0"]);

  h.registry.latest = "0.9.0";
  await check(h);
  info = await plugin(h);
  assert.equal(info.current?.version, "0.9.0");
  assert.equal(info.previous?.version, "0.8.0");
  assert.deepEqual(await versions(h), ["0.8.0", "0.9.0"]);
});

test("a check when latest is current downloads nothing and clears an old error", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await enable(h);

  h.registry.failWith = "getaddrinfo ENOTFOUND registry.npmjs.org";
  await check(h);
  assert.deepEqual((await plugin(h)).lastError, {
    at: "2026-10-14T12:00:00.000Z",
    step: "registry",
    message: "getaddrinfo ENOTFOUND registry.npmjs.org"
  });

  h.registry.failWith = null;
  await check(h);
  const info = await plugin(h);
  assert.equal(info.lastError, null);
  assert.equal(info.current?.version, "0.7.0");
  assert.equal(h.registry.calls.tarballs.length, 1);
});

test("a failed install keeps current, previous and versions/ as they were and records the step", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  await publish(h.registry, h.root, "0.8.0", { claimedIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}` });
  await publish(h.registry, h.root, "0.9.0", { script: "#!/bin/sh\nexit 1\n" });
  h.registry.latest = "0.7.0";
  await enable(h);
  const before = engineRecord(h, (await onDisk(h)).plugins[ID]).current;

  h.registry.latest = "0.8.0";
  await check(h);
  let info = await plugin(h);
  assert.equal(info.lastError?.step, "integrity");
  assert.deepEqual(engineRecord(h, (await onDisk(h)).plugins[ID]).current, before);
  assert.equal(info.previous, null);

  h.registry.latest = "0.9.0";
  await check(h);
  info = await plugin(h);
  assert.equal(info.lastError?.step, "smoke-test");
  assert.equal(info.current?.version, "0.7.0");
  assert.deepEqual(await versions(h), ["0.7.0"]);
  assert.deepEqual(await readdir(join(h.engineDir, ".tmp")), []);
});

test("rollback swaps current and previous, skips the version rolled back from until latest moves past it", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0", "0.9.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);
  await refusal(h.service.rollback(ID), 409, "NO_PREVIOUS_VERSION");

  h.registry.latest = "0.8.0";
  await check(h);
  const rolled = await h.service.rollback(ID);
  assert.equal(rolled.current?.version, "0.7.0");
  assert.equal(rolled.previous?.version, "0.8.0");
  assert.equal(rolled.skippedVersion, "0.8.0");
  assert.deepEqual(await versions(h), ["0.7.0", "0.8.0"]);

  // latest is still the skipped version: nothing is downloaded.
  await check(h);
  assert.equal(h.registry.calls.tarballs.length, 2);
  assert.equal((await plugin(h)).current?.version, "0.7.0");

  h.registry.latest = "0.9.0";
  await check(h);
  const info = await plugin(h);
  assert.equal(info.current?.version, "0.9.0");
  assert.equal(info.previous?.version, "0.7.0");
  assert.equal(info.skippedVersion, null);
  assert.deepEqual(await versions(h), ["0.7.0", "0.9.0"]);
});

test("rollback is refused when the previous version's files are gone", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);
  h.registry.latest = "0.8.0";
  await check(h);
  await rm(join(h.engineDir, "versions", "0.7.0"), { recursive: true });
  await refusal(h.service.rollback(ID), 409, "NO_PREVIOUS_VERSION");
  assert.equal((await plugin(h)).current?.version, "0.8.0");
});

test("remove downloads is refused while enabled, then clears the versions but never the preload", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);
  h.registry.latest = "0.8.0";
  await check(h);
  await h.service.rollback(ID);

  await refusal(h.service.removeDownloads(ID), 409, "PLUGIN_ENABLED");
  await h.service.update(ID, { enabled: false });
  assert.equal(h.sessionPreload.at(-1), null);

  const info = await h.service.removeDownloads(ID);
  assert.equal(info.current, null);
  assert.equal(info.previous, null);
  assert.equal(info.skippedVersion, null);
  assert.equal(await exists(join(h.engineDir, "versions")), false);
  assert.equal(await exists(tsRustPreloadPath(h.baseDir)), true);
  const stored = engineRecord(h, (await onDisk(h)).plugins[ID]);
  assert.equal("current" in stored || "previous" in stored || "skippedVersion" in stored, false);
});

test("start turns a per-workspace record on for the whole server, keeping its list until turned off", async (t) => {
  const h = await harness(t, {
    start: false,
    seed: { version: 1, plugins: { [ID]: { enabledWorkspaces: ["gone", "acme"], newerField: "x" } } }
  });
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await h.service.start();
  await h.service.settled();

  const info = await plugin(h);
  assert.equal(info.enabled, true);
  assert.deepEqual(info.enabledWorkspaces, []);
  assert.equal(info.current?.version, "0.7.0", "the start-up check installs it");
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));
  let stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.enabled, true);
  assert.deepEqual(stored.enabledWorkspaces, ["gone", "acme"]);
  assert.equal(stored.newerField, "x");

  // Turned off, the old list goes too, so neither a restart nor an older build turns it back on.
  await h.service.update(ID, { enabled: false });
  stored = (await onDisk(h)).plugins[ID];
  assert.equal("enabled" in stored || "enabledWorkspaces" in stored, false);
  await h.restart();
  assert.equal((await plugin(h)).enabled, false);
  assert.equal(h.sessionPreload.at(-1), null);
  await h.service.removeDownloads(ID);
});

test("an empty per-workspace list stays off and is not rewritten", async (t) => {
  const seed = { version: 1, plugins: { [ID]: { enabledWorkspaces: [] } } };
  const h = await harness(t, { seed });
  assert.equal((await plugin(h)).enabled, false);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(await onDisk(h), seed);
  assert.equal(h.registry.calls.latest, 0);
});

test("unknown fields and unknown plugin ids survive a write", async (t) => {
  const h = await harness(t, {
    seed: {
      version: 1,
      futureTopLevel: { keep: true },
      plugins: {
        "other-plugin": { enabledWorkspaces: ["acme"], extra: 1 },
        [ID]: { newerField: "x" }
      }
    }
  });
  await h.service.update(ID, { enabled: false });
  assert.deepEqual(h.writes, [], "a no-op change writes nothing");
  h.registry.latest = "9.9.9";
  await h.service.update(ID, { enabled: true });
  await h.service.settled();
  const stored = await onDisk(h);
  assert.deepEqual(stored.futureTopLevel, { keep: true });
  assert.deepEqual(stored.plugins["other-plugin"], { enabledWorkspaces: ["acme"], extra: 1 });
  assert.equal(stored.plugins[ID].newerField, "x");
  assert.equal(stored.plugins[ID].enabled, true);
});

test("the bundled Excalidraw plugin: an enabled flag only, no jobs, kept beside ts-rust", async (t) => {
  const h = await harness(t, {
    seed: { version: 1, plugins: { [ID]: { enabled: true, newerField: "x" } } }
  });
  const initial = await plugin(h, EXCALIDRAW_PLUGIN_ID);
  assert.equal(initial.scope, "global");
  assert.equal(initial.updates, false);
  assert.equal(initial.enabled, false);
  assert.equal((await plugin(h)).enabled, true);

  const on = await h.service.update(EXCALIDRAW_PLUGIN_ID, { enabled: true });
  assert.equal(on.enabled, true);
  assert.deepEqual(on.enabledWorkspaces, []);
  assert.equal(on.job, "idle");
  let stored = await onDisk(h);
  assert.deepEqual(stored.plugins[EXCALIDRAW_PLUGIN_ID], { enabled: true });
  assert.equal(stored.plugins[ID].enabled, true);
  assert.equal(stored.plugins[ID].newerField, "x");
  await h.service.settled();
  assert.equal(h.events.at(-1)?.plugins.find((p) => p.id === EXCALIDRAW_PLUGIN_ID)?.enabled, true);

  await h.service.update(EXCALIDRAW_PLUGIN_ID, { enabled: false });
  stored = await onDisk(h);
  assert.equal(stored.plugins[EXCALIDRAW_PLUGIN_ID].enabled, undefined);

  await refusal(h.service.checkNow(EXCALIDRAW_PLUGIN_ID), 409, "PLUGIN_BUNDLED");
  await refusal(h.service.rollback(EXCALIDRAW_PLUGIN_ID), 409, "PLUGIN_BUNDLED");
  await refusal(h.service.removeDownloads(EXCALIDRAW_PLUGIN_ID), 409, "PLUGIN_BUNDLED");
});

test("a malformed excalidraw record is unreadable and kept", async (t) => {
  const malformed = JSON.stringify({ version: 1, plugins: { [EXCALIDRAW_PLUGIN_ID]: { enabled: "yes" } } });
  const h = await harness(t, { seed: malformed });
  await refusal(h.service.update(EXCALIDRAW_PLUGIN_ID, { enabled: false }), 500, "PLUGINS_UNREADABLE");
  assert.equal(await readFile(h.file, "utf8"), malformed);
});

test("a corrupt plugins.json is never overwritten, and every operation reports it", async (t) => {
  const h = await harness(t, { seed: "{ not json" });
  await refusal(h.service.list(), 500, "PLUGINS_UNREADABLE");
  await refusal(h.service.update(ID, { enabled: true }), 500, "PLUGINS_UNREADABLE");
  await refusal(h.service.checkNow(ID), 500, "PLUGINS_UNREADABLE");
  await refusal(h.service.rollback(ID), 500, "PLUGINS_UNREADABLE");
  await refusal(h.service.removeDownloads(ID), 500, "PLUGINS_UNREADABLE");
  assert.equal(await readFile(h.file, "utf8"), "{ not json");
  assert.deepEqual(h.writes, []);
  assert.equal(h.registry.calls.latest, 0);
  assert.equal(h.sessionPreload.at(-1), null);

  // A file of a version this build does not know is just as untouchable.
  await writeFile(h.file, JSON.stringify({ version: 2, plugins: {} }), "utf8");
  await refusal(h.service.list(), 500, "PLUGINS_UNREADABLE");

  // Repaired by hand: the next request reads it again.
  await writeFile(h.file, JSON.stringify({ version: 1, plugins: {} }), "utf8");
  assert.equal((await plugin(h)).enabled, false);
});

test("memory changes only once the write landed", async (t) => {
  const h = await harness(t);
  h.failNextWrite.value = true;
  await assert.rejects(h.service.update(ID, { enabled: true }), /ENOSPC/);
  assert.equal((await plugin(h)).enabled, false);
  assert.deepEqual(h.preloadWrites, []);
  assert.equal(h.registry.calls.latest, 0);
});

test("the session preload stays off when the preload could not be written", async (t) => {
  const h = await harness(t);
  h.failPreload.value = true;
  h.registry.latest = "9.9.9";
  await enable(h);
  assert.equal(h.sessionPreload.at(-1), null);

  // The next refresh (here: the workspaces dir moving) retries the write.
  h.failPreload.value = false;
  await h.service.workspacesChanged();
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));
});

test("a moved workspaces dir rewrites the preload with the new root", async (t) => {
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  await enable(h);
  const moved = join(h.root, "elsewhere");
  await mkdir(join(moved, "acme"), { recursive: true });
  h.workspacesDir.current = moved;
  await h.service.workspacesChanged();
  assert.deepEqual(
    h.preloadWrites.map((write) => write.options.workspacesRoot),
    [await realpath(join(h.root, "workspaces")), await realpath(moved)]
  );
});

test("a symlinked workspaces dir bakes both its real path and the configured one", async (t) => {
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  const linked = join(h.root, "workspaces-link");
  await symlink(join(h.root, "workspaces"), linked);
  h.workspacesDir.current = linked;
  await enable(h);
  assert.deepEqual(
    h.preloadWrites.map((write) => write.options),
    [{ statePath: h.file, workspacesRoot: await realpath(linked), configuredWorkspacesRoot: linked, ...BOTH_ENGINES }]
  );
});

test("moving to another symlink of the same workspaces dir rewrites the preload", async (t) => {
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  const first = join(h.root, "workspaces-link");
  const second = join(h.root, "workspaces-other-link");
  await symlink(join(h.root, "workspaces"), first);
  await symlink(join(h.root, "workspaces"), second);
  h.workspacesDir.current = first;
  await enable(h);
  h.workspacesDir.current = second;
  await h.service.workspacesChanged();
  await h.service.settled();
  const real = await realpath(first);
  assert.deepEqual(
    h.preloadWrites.map((write) => write.options),
    [
      { statePath: h.file, workspacesRoot: real, configuredWorkspacesRoot: first, ...BOTH_ENGINES },
      { statePath: h.file, workspacesRoot: real, configuredWorkspacesRoot: second, ...BOTH_ENGINES }
    ]
  );
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));
});

test("start: staging emptied, preload rewritten, and a check while enabled", async (t) => {
  const h = await harness(t, { start: false, seed: { version: 1, plugins: { [ID]: { enabled: true } } } });
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await mkdir(join(h.engineDir, ".tmp", "0.6.0-left-over"), { recursive: true });

  await h.service.start();
  await h.service.settled();
  assert.equal(await exists(join(h.engineDir, ".tmp", "0.6.0-left-over")), false);
  assert.equal(h.preloadWrites.length, 1);
  assert.equal((await plugin(h)).current?.version, "0.7.0");

  // Off: a restart still rewrites the existing preload, but checks nothing.
  await h.service.update(ID, { enabled: false });
  await h.restart();
  assert.equal(h.preloadWrites.length, 2);
  assert.equal(h.registry.calls.latest, 1);
  assert.equal(h.sessionPreload.at(-1), null);
});

test("the hourly check runs only while the plugin is on", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  await enable(h);
  assert.equal(h.registry.calls.latest, 1);

  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 2);

  await h.service.update(ID, { enabled: false });
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 2);

  // A manual check runs anyway.
  await check(h);
  assert.equal(h.registry.calls.latest, 3);
});

test("a check already queued is not queued again; rollback and remove are refused while a job runs", async (t) => {
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  const fetchJson = h.registry.deps.fetchJson;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  h.registry.deps.fetchJson = async (url, signal) => {
    if (first) {
      first = false;
      await blocked;
    }
    return fetchJson(url, signal);
  };

  await h.service.checkNow(ID); // running, blocked in the registry call
  await h.service.checkNow(ID); // queued
  await h.service.checkNow(ID); // already queued: dropped
  assert.equal((await plugin(h)).job, "checking");
  await refusal(h.service.rollback(ID), 409, "PLUGIN_BUSY");
  await refusal(h.service.removeDownloads(ID), 409, "PLUGIN_BUSY");

  release();
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 2);
  assert.equal((await plugin(h)).job, "idle");
});

test("stop cancels a running download without recording an error", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  let started!: () => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.registry.deps.fetchTarball = (_url, _dest, signal) =>
    new Promise((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason));
    });

  await h.service.update(ID, { enabled: true });
  await downloading;
  await h.service.stop();
  const stored = engineRecord(h, (await onDisk(h)).plugins[ID]);
  assert.equal(stored.lastError, undefined);
  assert.equal(stored.current, undefined);
  assert.deepEqual(await readdir(join(h.engineDir, ".tmp")), []);
});

test("an unsupported platform: no turning on, no checks, no network", async (t) => {
  const h = await harness(t, { platform: "freebsd" });
  assert.equal((await plugin(h)).platform, "unsupported");
  await refusal(h.service.update(ID, { enabled: true }), 409, "PLUGIN_UNSUPPORTED");
  await refusal(h.service.checkNow(ID), 409, "PLUGIN_UNSUPPORTED");
  assert.equal(h.registry.calls.latest, 0);
  assert.deepEqual(h.preloadWrites, []);
  // Turning off stays possible (a plugins.json carried over from a supported host).
  await h.service.update(ID, { enabled: false });
  // The bundled plugin does not depend on tsc-rs having a build.
  assert.equal((await h.service.update(EXCALIDRAW_PLUGIN_ID, { enabled: true })).enabled, true);
});

test("workspaces coming and going leave the plugin on, with no broadcast", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await enable(h);
  const preload = tsRustPreloadPath(h.baseDir);
  assert.equal(h.sessionPreload.at(-1), preload);

  const quiet = h.events.length;
  await rm(join(h.workspacesDir.current, "acme"), { recursive: true });
  await h.service.workspacesChanged();
  await mkdir(join(h.workspacesDir.current, "gamma"));
  await h.service.workspacesChanged();
  await h.service.settled();
  assert.equal(h.events.length, quiet);
  assert.equal(h.sessionPreload.at(-1), preload);
  assert.equal(h.preloadWrites.length, 1, "the root did not move");
  assert.equal((await plugin(h)).enabled, true);
});

test("a plugins.json repaired by hand brings the runtime back: preload, timer and the held-back install", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t, { seed: "{ broken" });
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  assert.equal(h.sessionPreload.at(-1), null);
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 0, "no timer while the file is unreadable");

  // Repaired with a per-workspace record: it is turned on as at start.
  await writeFile(h.file, JSON.stringify({ version: 1, plugins: { [ID]: { enabledWorkspaces: ["acme"] } } }), "utf8");
  const info = await plugin(h);
  assert.equal(info.enabled, true);
  assert.equal((await onDisk(h)).plugins[ID].enabled, true);
  await h.service.settled();
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));
  assert.equal((await plugin(h)).current?.version, "0.7.0");
  assert.equal(h.events.at(-1)?.plugins[0]?.current?.version, "0.7.0");

  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 2, "the hourly check is armed again");
});

test("a malformed ts-rust record is unreadable and kept; another plugin's record of any shape is not", async (t) => {
  const malformed = JSON.stringify({ version: 1, plugins: { [ID]: { enabledWorkspaces: "acme" } } });
  const h = await harness(t, { seed: malformed });
  await assert.rejects(h.service.list(), (error: unknown) => {
    assert.ok(error instanceof PluginsError);
    assert.equal(error.code, "PLUGINS_UNREADABLE");
    assert.match(error.message, /malformed "ts-rust" record/);
    return true;
  });
  await refusal(h.service.update(ID, { enabled: false }), 500, "PLUGINS_UNREADABLE");
  assert.equal(await readFile(h.file, "utf8"), malformed);

  const other = { enabledWorkspaces: 7, nested: [{ a: null }] };
  await writeFile(h.file, JSON.stringify({ version: 1, plugins: { "future-plugin": other, odd: "x" } }), "utf8");
  h.registry.latest = "9.9.9";
  await enable(h);
  const stored = await onDisk(h);
  assert.deepEqual(stored.plugins["future-plugin"], other);
  assert.equal(stored.plugins.odd, "x");
  assert.equal(stored.plugins[ID].enabled, true);
});

test("a current version whose binary is gone is reinstalled by the next check, previous untouched", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);
  h.registry.latest = "0.8.0";
  await check(h);

  await rm(join(h.engineDir, "versions", "0.8.0"), { recursive: true });
  await check(h);
  const info = await plugin(h);
  assert.equal(info.current?.version, "0.8.0");
  assert.equal(info.previous?.version, "0.7.0");
  assert.equal(info.lastError, null);
  assert.deepEqual(await versions(h), ["0.7.0", "0.8.0"]);
  assert.equal(h.registry.calls.tarballs.length, 3);
});

test("a missing current is repaired at start, keeping a rollback's skip; a newer release is not paired with it", async (t) => {
  const h = await harness(t);
  for (const version of ["0.7.0", "0.8.0", "0.9.0"]) await publish(h.registry, h.root, version);
  h.registry.latest = "0.7.0";
  await enable(h);
  h.registry.latest = "0.8.0";
  await check(h);
  await h.service.rollback(ID); // current 0.7.0, previous 0.8.0, skipping 0.8.0

  // latest is still the skipped 0.8.0: the start-up check reinstalls the rolled-back-to 0.7.0.
  await rm(join(h.engineDir, "versions", "0.7.0"), { recursive: true });
  await h.restart();
  let info = await plugin(h);
  assert.equal(info.current?.version, "0.7.0");
  assert.equal(info.previous?.version, "0.8.0");
  assert.equal(info.skippedVersion, "0.8.0");
  assert.deepEqual(await versions(h), ["0.7.0", "0.8.0"]);

  // Missing again, and a newer release is out: it becomes current, and the missing one is not
  // made the rollback target.
  await rm(join(h.engineDir, "versions", "0.7.0"), { recursive: true });
  h.registry.latest = "0.9.0";
  await check(h);
  info = await plugin(h);
  assert.equal(info.current?.version, "0.9.0");
  assert.equal(info.previous?.version, "0.8.0");
  assert.equal(info.skippedVersion, null);
  assert.deepEqual(await versions(h), ["0.8.0", "0.9.0"]);
});

// ---- the engine choice ---------------------------------------------------------------------------

test("the default engine is tsrs where it has a build, else tsc-rs; the plugin is supported when either is", async (t) => {
  const cases: Array<[string, string, HostLibc, TsCheckerEngine, Record<TsCheckerEngine, string>]> = [
    ["linux", "x64", "glibc", "tsrs", { tsrs: "supported", "tsc-rs": "supported" }],
    ["linux", "arm64", "musl", "tsrs", { tsrs: "supported", "tsc-rs": "supported" }],
    ["darwin", "arm64", "glibc", "tsrs", { tsrs: "supported", "tsc-rs": "supported" }],
    ["darwin", "x64", "glibc", "tsc-rs", { tsrs: "unsupported", "tsc-rs": "supported" }],
    ["win32", "x64", "glibc", "tsc-rs", { tsrs: "unsupported", "tsc-rs": "supported" }],
    ["freebsd", "x64", "glibc", "tsc-rs", { tsrs: "unsupported", "tsc-rs": "unsupported" }]
  ];
  for (const [platform, arch, libc, engine, support] of cases) {
    const h = await harness(t, { platform, arch, libc });
    const info = await plugin(h);
    const where = `${platform}/${arch}/${libc}`;
    assert.equal(info.engine, engine, where);
    assert.deepEqual(Object.fromEntries((info.engines ?? []).map((e) => [e.id, e.platform])), support, where);
    assert.equal(info.platform, support["tsc-rs"], where);
    assert.equal(info.source.label, engine === "tsrs" ? "oxc-project/tsrs" : "pingdotgg/ts-rust", where);
    await h.service.stop();
  }
});

test("the preload is told which engines this host has and its default", async (t) => {
  const h = await harness(t, { platform: "darwin", arch: "x64" });
  h.registry.latest = "9.9.9";
  await enable(h);
  assert.deepEqual(
    h.preloadWrites.map((write) => [write.options.supportedEngines, write.options.defaultEngine]),
    [[["tsc-rs"], "tsc-rs"]]
  );
});

test("switching engine while on installs the new one when it has nothing; each keeps its own versions", async (t) => {
  const h = await harness(t);
  const { tsrs, "tsc-rs": tscRs } = h.registries;
  await publish(tsrs, h.root, "0.16.0-ts7.1.0-dev.20260929");
  tsrs.latest = "0.16.0-ts7.1.0-dev.20260929";
  await publish(tscRs, h.root, "0.7.0");
  tscRs.latest = "0.7.0";
  await enable(h);
  assert.equal((await plugin(h)).current?.version, "0.16.0-ts7.1.0-dev.20260929");
  assert.equal(tscRs.calls.latest, 0);

  const switched = await h.service.update(ID, { engine: "tsc-rs" });
  assert.equal(switched.engine, "tsc-rs");
  assert.equal(switched.current, null, "tsc-rs has nothing installed yet");
  assert.equal(switched.source.label, "pingdotgg/ts-rust");
  await h.service.settled();
  let info = await plugin(h);
  assert.equal(info.current?.version, "0.7.0");
  assert.equal(info.enabled, true);
  assert.deepEqual(await versions(h, "tsc-rs"), ["0.7.0"]);
  assert.deepEqual(await versions(h, "tsrs"), ["0.16.0-ts7.1.0-dev.20260929"], "tsrs's install stays");
  let stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.engine, "tsc-rs");
  assert.equal(stored.current.version, "0.7.0");
  assert.equal(stored.tsrs.current.version, "0.16.0-ts7.1.0-dev.20260929");
  assert.equal(h.events.at(-1)?.plugins[0]?.engine, "tsc-rs");

  // Back to tsrs: installed already, so nothing is fetched.
  info = await h.service.update(ID, { engine: "tsrs" });
  await h.service.settled();
  assert.equal(info.current?.version, "0.16.0-ts7.1.0-dev.20260929");
  assert.equal(tsrs.calls.latest, 1);
  stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.engine, "tsrs");
  assert.equal(stored.current.version, "0.7.0");
});

test("switching engine while off installs nothing; turning on then installs the chosen engine", async (t) => {
  const h = await harness(t);
  await publish(h.registries["tsc-rs"], h.root, "0.7.0");
  h.registries["tsc-rs"].latest = "0.7.0";
  const info = await h.service.update(ID, { engine: "tsc-rs" });
  await h.service.settled();
  assert.equal(info.enabled, false);
  assert.equal(info.engine, "tsc-rs");
  assert.equal(h.registries["tsc-rs"].calls.latest + h.registries.tsrs.calls.latest, 0);

  // Both at once: one write, and the install is the chosen engine's.
  const on = await h.service.update(ID, { enabled: true, engine: "tsc-rs" });
  assert.equal(on.enabled, true);
  await h.service.settled();
  assert.equal((await plugin(h)).current?.version, "0.7.0");
  assert.equal(h.registries.tsrs.calls.latest, 0);
});

test("an engine without a build here is refused and nothing is written; a bundled plugin has no engine", async (t) => {
  const h = await harness(t, { platform: "darwin", arch: "x64" });
  await refusal(h.service.update(ID, { engine: "tsrs" }), 409, "PLUGIN_UNSUPPORTED");
  await refusal(h.service.update(ID, { enabled: true, engine: "tsrs" }), 409, "PLUGIN_UNSUPPORTED");
  await refusal(h.service.update(EXCALIDRAW_PLUGIN_ID, { engine: "tsc-rs" }), 400, "INVALID_REQUEST");
  assert.deepEqual(h.writes, []);
  assert.equal((await h.service.update(ID, { engine: "tsc-rs" })).engine, "tsc-rs");
});

test("a carried-over engine without a build here, or an unknown one, reads as the default and is kept", async (t) => {
  const h = await harness(t, {
    platform: "win32",
    seed: { version: 1, plugins: { [ID]: { engine: "tsrs", tsrs: { current: { version: "0.16.0", integrity: "x", installedAt: "t" } } } } }
  });
  let info = await plugin(h);
  assert.equal(info.engine, "tsc-rs");
  assert.equal(info.current, null, "tsrs's version is not shown as tsc-rs's");

  const linux = await harness(t, { seed: { version: 1, plugins: { [ID]: { engine: "tsgo", newerField: 1 } } } });
  info = await plugin(linux);
  assert.equal(info.engine, "tsrs");
  linux.registry.latest = "9.9.9";
  await enable(linux);
  const stored = (await onDisk(linux)).plugins[ID];
  assert.equal(stored.engine, "tsgo", "a newer build's engine is kept");
  assert.equal(stored.newerField, 1);
});

test("a record from before the engine choice: tsrs becomes active and is installed, tsc-rs's version stays recorded", async (t) => {
  const tscRsCurrent = { version: "0.7.0", integrity: "sha512-old", installedAt: "2026-10-14T10:00:00.000Z" };
  const h = await harness(t, {
    start: false,
    seed: { version: 1, plugins: { [ID]: { enabled: true, current: tscRsCurrent, lastCheckAt: "2026-10-14T10:00:00.000Z" } } }
  });
  // tsc-rs 0.7.0's files, as an older build installed them.
  const oldBinary = join(h.engineDirs["tsc-rs"], "versions", "0.7.0", "tsc");
  await mkdir(join(oldBinary, ".."), { recursive: true });
  await writeFile(oldBinary, "#!/bin/sh\n", { mode: 0o755 });
  await publish(h.registries.tsrs, h.root, "0.16.0-ts7.1.0-dev.20260929");
  h.registries.tsrs.latest = "0.16.0-ts7.1.0-dev.20260929";

  await h.service.start();
  await h.service.settled();
  const info = await plugin(h);
  assert.equal(info.engine, "tsrs");
  assert.equal(info.current?.version, "0.16.0-ts7.1.0-dev.20260929", "the start-up check installed tsrs");
  assert.equal(info.previous, null, "tsc-rs's version is no tsrs rollback target");
  assert.equal(h.registries["tsc-rs"].calls.latest, 0);
  const stored = (await onDisk(h)).plugins[ID];
  assert.deepEqual(stored.current, tscRsCurrent);
  assert.equal(stored.lastCheckAt, "2026-10-14T10:00:00.000Z");
  assert.equal(stored.engine, undefined);
  assert.equal(stored.tsrs.current.version, "0.16.0-ts7.1.0-dev.20260929");
  assert.equal(await exists(oldBinary), true);
});

test("rollback, skip and errors are the active engine's; remove downloads clears both engines", async (t) => {
  const h = await harness(t);
  const { tsrs, "tsc-rs": tscRs } = h.registries;
  for (const version of ["0.15.0", "0.16.0"]) await publish(tsrs, h.root, version);
  await publish(tscRs, h.root, "0.7.0");
  tsrs.latest = "0.15.0";
  tscRs.latest = "0.7.0";
  await enable(h);
  tsrs.latest = "0.16.0";
  await check(h);
  await h.service.update(ID, { engine: "tsc-rs" });
  await h.service.settled();

  // tsc-rs has one version: no rollback, though tsrs has a previous one.
  await refusal(h.service.rollback(ID), 409, "NO_PREVIOUS_VERSION");
  tscRs.failWith = "ECONNRESET";
  await check(h);
  assert.equal((await plugin(h)).lastError?.message, "ECONNRESET");

  await h.service.update(ID, { engine: "tsrs" });
  let info = await plugin(h);
  assert.equal(info.lastError, null, "tsc-rs's error is not tsrs's");
  info = await h.service.rollback(ID);
  assert.equal(info.current?.version, "0.15.0");
  assert.equal(info.skippedVersion, "0.16.0");
  let stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.current.version, "0.7.0");
  assert.equal(stored.skippedVersion, undefined);
  assert.equal(stored.lastError.message, "ECONNRESET");

  await h.service.update(ID, { enabled: false });
  info = await h.service.removeDownloads(ID);
  assert.equal(info.current, null);
  assert.equal(await exists(join(h.engineDirs.tsrs, "versions")), false);
  assert.equal(await exists(join(h.engineDirs["tsc-rs"], "versions")), false);
  assert.equal(await exists(tsRustPreloadPath(h.baseDir)), true);
  stored = (await onDisk(h)).plugins[ID];
  for (const record of [stored, stored.tsrs]) {
    assert.equal("current" in record || "previous" in record || "skippedVersion" in record, false);
  }
  assert.equal(stored.engine, "tsrs", "the choice survives");
});

test("start empties both engines' staging dirs", async (t) => {
  const h = await harness(t, { start: false });
  for (const engine of ENGINES) await mkdir(join(h.engineDirs[engine], ".tmp", "left-over"), { recursive: true });
  await h.service.start();
  await h.service.settled();
  for (const engine of ENGINES) assert.equal(await exists(join(h.engineDirs[engine], ".tmp", "left-over")), false);
});

test("boxes: the tooling state follows on/off, the engine and installs; a box's status shows in PluginInfo.boxes", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.16.0");
  h.registry.latest = "0.16.0";
  assert.deepEqual(h.service.tsRustToolingState(), { enabled: false, engine: undefined, current: { tsrs: null, "tsc-rs": null } });

  // The box plugin hears only about what boxes get, not about job progress.
  const tooling = createTsRustToolingPlugin({ source: h.service, registry: h.registry.deps });
  let changes = 0;
  const unsubscribe = tooling.onChange(() => (changes += 1));
  await enable(h);
  assert.deepEqual(h.service.tsRustToolingState(), { enabled: true, engine: undefined, current: { tsrs: "0.16.0", "tsc-rs": null } });
  assert.equal(changes, 2, "turned on, then installed");
  // tsc-rs's registry has no release: the switch is a change, its failed install is not.
  await h.service.update(ID, { engine: "tsc-rs" });
  await h.service.settled();
  assert.equal(h.service.tsRustToolingState()?.engine, "tsc-rs");
  assert.equal(changes, 3);
  unsubscribe();
  await h.service.update(ID, { enabled: false });
  await h.service.settled();
  assert.equal(changes, 3, "unsubscribed");

  assert.equal("boxes" in (await plugin(h)), false, "no box, no field");
  const statuses = [
    { boxId: "b1", state: "failed" as const, message: "smoke-test: tsc-rs --version exited with code 1", updatedAt: "2026-10-20T00:00:00.000Z" }
  ];
  h.service.setBoxToolingStatusSource((id) => (id === ID ? statuses : []));
  const before = h.events.length;
  h.service.boxToolingChanged();
  await h.service.settled();
  assert.equal(h.events.length, before + 1, "a box status change is broadcast");
  assert.deepEqual(h.events.at(-1)?.plugins[0]?.boxes, statuses);
  assert.deepEqual((await plugin(h)).boxes, statuses);
  assert.equal("boxes" in (await plugin(h, EXCALIDRAW_PLUGIN_ID)), false);
});
