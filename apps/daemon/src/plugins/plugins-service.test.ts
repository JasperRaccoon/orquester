import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type PluginInfo, type PluginsResponse, TS_RUST_PLUGIN_ID } from "@orquester/api";
import { pluginsConfigPath, tsRustPluginDir, tsRustPreloadPath } from "@orquester/config";
import { PLUGIN_CHECK_INTERVAL_MS, PluginsError, PluginsService } from "./plugins-service.ts";
import { type FakeRegistry, fakeRegistry, publish, tempRoot } from "./testing.ts";
import type { TsRustPreloadOptions } from "./ts-rust/preload.ts";

// The plugins service over a temp appdir and workspaces root, an in-memory npm
// registry with fixture tarballs (./testing.ts) and stubbed preload writer and
// session-env setter: plugins.json ownership, the job queue, the timer, and the
// preload / session-env decisions.

const ID = TS_RUST_PLUGIN_ID;

interface Harness {
  root: string;
  baseDir: string;
  workspacesDir: { current: string };
  file: string;
  pluginDir: string;
  registry: FakeRegistry;
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
  options: { platform?: string; start?: boolean; seed?: unknown; workspaces?: string[] } = {}
): Promise<Harness> {
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
  const registry = fakeRegistry();
  const h: Harness = {
    root,
    baseDir,
    workspacesDir,
    file,
    pluginDir: tsRustPluginDir(baseDir),
    registry,
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
      installer: registry.deps,
      env: { PATH: process.env.PATH, ORQUESTER_APPDIR: baseDir },
      platform: options.platform ?? "linux",
      arch: "x64",
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

async function plugin(h: Harness): Promise<PluginInfo> {
  const response = await h.service.list();
  assert.equal(response.plugins.length, 1);
  return response.plugins[0] as PluginInfo;
}

async function onDisk(h: Harness): Promise<any> {
  return JSON.parse(await readFile(h.file, "utf8"));
}

async function versions(h: Harness): Promise<string[]> {
  return readdir(join(h.pluginDir, "versions")).then(
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

/** Enable `workspace` and wait for the first install it queues. */
async function enable(h: Harness, workspace = "acme"): Promise<PluginInfo> {
  const info = await h.service.setWorkspaceEnabled(ID, workspace, true);
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
    description: "Use tsc-rs instead of tsc for faster TypeScript typechecking.",
    source: { label: "pingdotgg/ts-rust", url: "https://github.com/pingdotgg/ts-rust" },
    provider: "Community",
    platform: "supported",
    enabledWorkspaces: [],
    current: null,
    previous: null,
    skippedVersion: null,
    lastCheckAt: null,
    lastError: null,
    job: "idle"
  });
  assert.equal(await exists(h.file), false);
  assert.equal(h.registry.calls.latest, 0);
  assert.deepEqual(h.preloadWrites, []);
  assert.deepEqual(h.sessionPreload, [null]);
});

test("enabling a workspace writes the preload, turns on the session preload and installs tsc-rs", async (t) => {
  const h = await harness(t);
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";

  const info = await enable(h);
  assert.deepEqual(info.enabledWorkspaces, ["acme"]);
  assert.deepEqual(h.preloadWrites, [
    {
      path: tsRustPreloadPath(h.baseDir),
      options: { statePath: h.file, workspacesRoot: await realpath(h.workspacesDir.current) }
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
  assert.equal((await onDisk(h)).plugins[ID].current.version, "0.7.0");

  // Progress went out in order: the toggle, then checking → installing → idle with the install.
  const jobs = h.events.map((event) => event.plugins[0]?.job);
  assert.deepEqual(jobs, ["idle", "checking", "installing", "idle"]);
  assert.equal(h.events.at(-1)?.plugins[0]?.current?.version, "0.7.0");

  // Enabling a second workspace installs nothing more.
  await enable(h, "beta");
  assert.equal(h.registry.calls.latest, 1);
  assert.deepEqual((await plugin(h)).enabledWorkspaces, ["acme", "beta"]);
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
  const before = (await onDisk(h)).plugins[ID].current;

  h.registry.latest = "0.8.0";
  await check(h);
  let info = await plugin(h);
  assert.equal(info.lastError?.step, "integrity");
  assert.deepEqual((await onDisk(h)).plugins[ID].current, before);
  assert.equal(info.previous, null);

  h.registry.latest = "0.9.0";
  await check(h);
  info = await plugin(h);
  assert.equal(info.lastError?.step, "smoke-test");
  assert.equal(info.current?.version, "0.7.0");
  assert.deepEqual(await versions(h), ["0.7.0"]);
  assert.deepEqual(await readdir(join(h.pluginDir, ".tmp")), []);
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
  await rm(join(h.pluginDir, "versions", "0.7.0"), { recursive: true });
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
  await h.service.setWorkspaceEnabled(ID, "acme", false);
  assert.equal(h.sessionPreload.at(-1), null);

  const info = await h.service.removeDownloads(ID);
  assert.equal(info.current, null);
  assert.equal(info.previous, null);
  assert.equal(info.skippedVersion, null);
  assert.equal(await exists(join(h.pluginDir, "versions")), false);
  assert.equal(await exists(tsRustPreloadPath(h.baseDir)), true);
  const stored = (await onDisk(h)).plugins[ID];
  assert.equal("current" in stored || "previous" in stored || "skippedVersion" in stored, false);
});

test("a workspace that no longer exists stays persisted, is hidden, and does not block remove downloads", async (t) => {
  const h = await harness(t, {
    seed: {
      version: 1,
      plugins: { [ID]: { enabledWorkspaces: ["gone", "acme"] } }
    }
  });
  assert.deepEqual((await plugin(h)).enabledWorkspaces, ["acme"]);
  await h.service.setWorkspaceEnabled(ID, "acme", false);
  assert.deepEqual((await onDisk(h)).plugins[ID].enabledWorkspaces, ["gone"]);
  assert.deepEqual((await plugin(h)).enabledWorkspaces, []);
  assert.equal(h.sessionPreload.at(-1), null);
  await h.service.removeDownloads(ID);
  await refusal(h.service.setWorkspaceEnabled(ID, "gone", true), 404, "WORKSPACE_NOT_FOUND");
});

test("unknown fields and unknown plugin ids survive a write", async (t) => {
  const h = await harness(t, {
    seed: {
      version: 1,
      futureTopLevel: { keep: true },
      plugins: {
        "other-plugin": { enabledWorkspaces: ["acme"], extra: 1 },
        [ID]: { enabledWorkspaces: [], newerField: "x" }
      }
    }
  });
  await h.service.setWorkspaceEnabled(ID, "beta", false);
  assert.deepEqual(h.writes, [], "a no-op change writes nothing");
  h.registry.latest = "9.9.9";
  await enable(h, "beta");
  const stored = await onDisk(h);
  assert.deepEqual(stored.futureTopLevel, { keep: true });
  assert.deepEqual(stored.plugins["other-plugin"], { enabledWorkspaces: ["acme"], extra: 1 });
  assert.equal(stored.plugins[ID].newerField, "x");
  assert.deepEqual(stored.plugins[ID].enabledWorkspaces, ["beta"]);
});

test("a corrupt plugins.json is never overwritten, and every operation reports it", async (t) => {
  const h = await harness(t, { seed: "{ not json" });
  await refusal(h.service.list(), 500, "PLUGINS_UNREADABLE");
  await refusal(h.service.setWorkspaceEnabled(ID, "acme", true), 500, "PLUGINS_UNREADABLE");
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
  assert.equal((await plugin(h)).enabledWorkspaces.length, 0);
});

test("memory changes only once the write landed", async (t) => {
  const h = await harness(t);
  h.failNextWrite.value = true;
  await assert.rejects(h.service.setWorkspaceEnabled(ID, "acme", true), /ENOSPC/);
  assert.deepEqual((await plugin(h)).enabledWorkspaces, []);
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
  await h.service.workspacesDirChanged();
  assert.equal(h.sessionPreload.at(-1), tsRustPreloadPath(h.baseDir));
});

test("a moved workspaces dir rewrites the preload with the new root", async (t) => {
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  await enable(h);
  const moved = join(h.root, "elsewhere");
  await mkdir(join(moved, "acme"), { recursive: true });
  h.workspacesDir.current = moved;
  await h.service.workspacesDirChanged();
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
    [{ statePath: h.file, workspacesRoot: await realpath(linked), configuredWorkspacesRoot: linked }]
  );
});

test("start: staging emptied, preload rewritten, and a check when enabled anywhere", async (t) => {
  const h = await harness(t, { start: false, seed: { version: 1, plugins: { [ID]: { enabledWorkspaces: ["acme"] } } } });
  await publish(h.registry, h.root, "0.7.0");
  h.registry.latest = "0.7.0";
  await mkdir(join(h.pluginDir, ".tmp", "0.6.0-left-over"), { recursive: true });

  await h.service.start();
  await h.service.settled();
  assert.equal(await exists(join(h.pluginDir, ".tmp", "0.6.0-left-over")), false);
  assert.equal(h.preloadWrites.length, 1);
  assert.equal((await plugin(h)).current?.version, "0.7.0");

  // Disabled everywhere: a restart still rewrites the existing preload, but checks nothing.
  await h.service.setWorkspaceEnabled(ID, "acme", false);
  await h.restart();
  assert.equal(h.preloadWrites.length, 2);
  assert.equal(h.registry.calls.latest, 1);
  assert.equal(h.sessionPreload.at(-1), null);
});

test("the hourly check runs only while the plugin is enabled somewhere", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  h.registry.latest = "9.9.9";
  await enable(h);
  assert.equal(h.registry.calls.latest, 1);

  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await h.service.settled();
  assert.equal(h.registry.calls.latest, 2);

  await h.service.setWorkspaceEnabled(ID, "acme", false);
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

  await h.service.setWorkspaceEnabled(ID, "acme", true);
  await downloading;
  await h.service.stop();
  const stored = (await onDisk(h)).plugins[ID];
  assert.equal(stored.lastError, undefined);
  assert.equal(stored.current, undefined);
  assert.deepEqual(await readdir(join(h.pluginDir, ".tmp")), []);
});

test("an unsupported platform: no toggles, no checks, no network", async (t) => {
  const h = await harness(t, { platform: "freebsd" });
  assert.equal((await plugin(h)).platform, "unsupported");
  await refusal(h.service.setWorkspaceEnabled(ID, "acme", true), 409, "PLUGIN_UNSUPPORTED");
  await refusal(h.service.checkNow(ID), 409, "PLUGIN_UNSUPPORTED");
  assert.equal(h.registry.calls.latest, 0);
  assert.deepEqual(h.preloadWrites, []);
  // Turning off stays possible (a plugins.json carried over from a supported host).
  await h.service.setWorkspaceEnabled(ID, "acme", false);
});
