import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  type EventMessage,
  type PluginInfo,
  type PluginsResponse,
  PLUGINS_CHANGED_EVENT,
  EXCALIDRAW_PLUGIN_ID,
  SECRET_FILES_PLUGIN_ID,
  PLUGINS_CHANNEL,
  TS_RUST_PLUGIN_ID,
  pluginRoutes
} from "@orquester/api";
import { readFile } from "node:fs/promises";
import { createDefaultClientConfig, createDefaultDaemonConfig, pluginsConfigPath } from "@orquester/config";
import Fastify, { type InjectOptions } from "fastify";
import { Broadcaster } from "../broadcaster.ts";
import { createServer } from "../index.ts";
import { PluginsService, publishPluginEvents } from "./plugins-service.ts";
import { registerPluginRoutes } from "./routes.ts";
import { combinedRegistryDeps, fakeRegistry, publish, tempRoot } from "./testing.ts";
import { TSC_RS_ENGINE, TSRS_ENGINE } from "./ts-rust/installer.ts";

// Route-level coverage for /api/plugins (spec §5.3) through the daemon's own
// router — the real createServer and a real PluginsService over a temp appdir,
// in-memory registries of both engines (tsrs is the default on the linux-x64
// glibc host it fakes) and a stub preload writer: validation (404/400/409),
// enabling triggering the first install, the broadcast payload, and auth on
// the remote transport. Nothing listens.

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;
const ID = TS_RUST_PLUGIN_ID;

async function harness(t: TestContext, options: { mode?: "local" | "remote"; seed?: string } = {}) {
  const root = await tempRoot("orq-plugins-routes-");
  const baseDir = join(root, "appdir");
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(workspacesDir, "acme"), { recursive: true });
  await writeFile(join(workspacesDir, "notes.txt"), "a file, not a workspace");
  if (options.seed !== undefined) {
    await mkdir(join(baseDir, "daemon"), { recursive: true });
    await writeFile(pluginsConfigPath(baseDir), options.seed, "utf8");
  }
  const sessionPreload: Array<string | null> = [];
  const registry = fakeRegistry(undefined, TSRS_ENGINE);
  await publish(registry, root, "0.7.0");
  registry.latest = "0.7.0";
  const tscRsRegistry = fakeRegistry(undefined, TSC_RS_ENGINE);
  await publish(tscRsRegistry, root, "0.6.0");
  tscRsRegistry.latest = "0.6.0";

  const plugins = new PluginsService({
    baseDir,
    workspacesDir: () => workspacesDir,
    writeJson: async (path, value) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(value), "utf8");
    },
    installer: combinedRegistryDeps([registry, tscRsRegistry]),
    env: {},
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    writePreload: async (path) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "// preload\n", "utf8");
    },
    setSessionPreload: (path) => sessionPreload.push(path),
    logger: { warn: () => {}, error: () => {} }
  });
  const broadcaster = new Broadcaster();
  const published: EventMessage[] = [];
  broadcaster.add({ send: (data) => published.push(JSON.parse(data) as EventMessage) });
  publishPluginEvents(plugins, broadcaster);
  await plugins.start();

  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = {
    baseDir,
    daemonDir: join(baseDir, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(baseDir, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];
  const mode = options.mode ?? "local";
  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    {
      plugins,
      broadcaster,
      // The workspace delete route's other cascades, stubbed: only the plugins notification is under test.
      sessions: { closeByProjectPrefix: () => {} },
      browsers: { closeForProject: async () => {} },
      desktops: { closeForProject: async () => {} },
      accounts: { unbindWorkspace: async () => {} },
      todos: { deleteByWorkspace: async () => {} },
      savedPrompts: { deleteForWorkspace: async () => {} }
    } as unknown as CreateServerArgs[4],
    { authRequired: mode === "remote", mode }
  );
  t.after(async () => {
    await app.close();
    await plugins.stop();
    await rm(root, { recursive: true, force: true });
  });
  const headers = mode === "remote" ? { authorization: BEARER } : undefined;
  return {
    root,
    workspacesDir,
    sessionPreload,
    plugins,
    published,
    registry,
    tscRsRegistry,
    inject: (request: InjectOptions) => app.inject({ ...request, headers: { ...headers, ...request.headers } }),
    rawInject: app.inject.bind(app)
  };
}

test("GET lists the built-in plugins", async (t) => {
  const h = await harness(t);
  const res = await h.inject({ method: "GET", url: pluginRoutes.list });
  assert.equal(res.statusCode, 200);
  const body = res.json() as PluginsResponse;
  assert.deepEqual(
    body.plugins.map((plugin) => [plugin.id, plugin.name, plugin.scope, plugin.updates, plugin.platform, plugin.job]),
    [
      [ID, "Better TS Typecheck", "global", true, "supported", "idle"],
      [EXCALIDRAW_PLUGIN_ID, "Excalidraw Whiteboard", "global", false, "supported", "idle"],
      [SECRET_FILES_PLUGIN_ID, "Secret files", "global", false, "supported", "idle"]
    ]
  );
  assert.equal(body.plugins[0]?.enabled, false);
  assert.equal(body.plugins[1]?.enabled, false);
  assert.equal(body.plugins[2]?.enabled, false, "Secret files is off by default");
  assert.deepEqual(body.plugins[0]?.enabledWorkspaces, []);
});

test("a global plugin is switched for the whole server, persists, and broadcasts", async (t) => {
  const h = await harness(t);
  const res = await h.inject({ method: "PUT", url: pluginRoutes.plugin(EXCALIDRAW_PLUGIN_ID), payload: { enabled: true } });
  assert.equal(res.statusCode, 200);
  const info = res.json() as PluginInfo;
  assert.equal(info.enabled, true);
  assert.deepEqual(info.enabledWorkspaces, []);
  assert.equal(info.current, null);
  await h.plugins.settled();
  const last = h.published.at(-1)?.payload as PluginsResponse;
  assert.equal(last.plugins.find((plugin) => plugin.id === EXCALIDRAW_PLUGIN_ID)?.enabled, true);
  const saved = JSON.parse(await readFile(pluginsConfigPath(join(h.root, "appdir")), "utf8")) as {
    plugins: Record<string, { enabled?: boolean }>;
  };
  assert.equal(saved.plugins[EXCALIDRAW_PLUGIN_ID]?.enabled, true);
  // Nothing was downloaded for it.
  assert.equal(h.registry.calls.latest, 0);

  const off = await h.inject({ method: "PUT", url: pluginRoutes.plugin(EXCALIDRAW_PLUGIN_ID), payload: { enabled: false } });
  assert.equal((off.json() as PluginInfo).enabled, false);
});

test("version refusals: a bundled plugin's version routes 409; the per-workspace route is gone", async (t) => {
  const h = await harness(t);
  const expect = async (request: InjectOptions, status: number, code: string) => {
    const res = await h.inject(request);
    assert.equal(res.statusCode, status, `${request.method} ${request.url}: ${res.body}`);
    assert.equal((res.json() as { code: string }).code, code);
  };
  const X = EXCALIDRAW_PLUGIN_ID;
  await expect({ method: "PUT", url: pluginRoutes.plugin(X), payload: { enabled: 1 } }, 400, "INVALID_REQUEST");
  await expect({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: "yes" } }, 400, "INVALID_REQUEST");
  await expect({ method: "PUT", url: pluginRoutes.plugin("nope"), payload: { enabled: true } }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.check(X) }, 409, "PLUGIN_BUNDLED");
  await expect({ method: "POST", url: pluginRoutes.rollback(X) }, 409, "PLUGIN_BUNDLED");
  await expect({ method: "DELETE", url: pluginRoutes.downloads(X) }, 409, "PLUGIN_BUNDLED");
  const legacy = await h.inject({ method: "PUT", url: `${pluginRoutes.plugin(ID)}/workspaces/acme`, payload: { enabled: true } });
  assert.equal(legacy.statusCode, 404);
  assert.equal(h.registry.calls.latest, 0);
});

test("refusals: unknown plugin 404, no previous version 409", async (t) => {
  const h = await harness(t);
  const expect = async (request: InjectOptions, status: number, code: string) => {
    const res = await h.inject(request);
    assert.equal(res.statusCode, status, `${request.method} ${request.url}: ${res.body}`);
    assert.equal((res.json() as { code: string }).code, code);
    assert.equal(typeof (res.json() as { message: string }).message, "string");
  };
  await expect({ method: "PUT", url: pluginRoutes.plugin("nope"), payload: { enabled: true } }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.check("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.rollback("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "DELETE", url: pluginRoutes.downloads("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.rollback(ID) }, 409, "NO_PREVIOUS_VERSION");
  assert.equal(h.registry.calls.latest, 0);
});

test("turning tsc-rs on answers its state, installs it, turns on the session preload, and broadcasts every step", async (t) => {
  const h = await harness(t);
  const res = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: true } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as PluginInfo).enabled, true);
  assert.deepEqual((res.json() as PluginInfo).enabledWorkspaces, []);
  await h.plugins.settled();
  assert.equal(typeof h.sessionPreload.at(-1), "string");

  assert.ok(h.published.length > 0);
  for (const event of h.published) {
    assert.equal(event.channel, PLUGINS_CHANNEL);
    assert.equal(event.type, PLUGINS_CHANGED_EVENT);
  }
  const last = h.published.at(-1)?.payload as PluginsResponse;
  assert.equal(last.plugins[0]?.current?.version, "0.7.0");
  assert.equal(last.plugins[0]?.job, "idle");
  assert.deepEqual(
    h.published.map((event) => (event.payload as PluginsResponse).plugins[0]?.job),
    ["idle", "checking", "installing", "idle"]
  );
  const listed = (await h.inject({ method: "GET", url: pluginRoutes.list })).json() as PluginsResponse;
  assert.deepEqual(listed, last);

  // Remove downloads is refused while the plugin is on.
  const removed = await h.inject({ method: "DELETE", url: pluginRoutes.downloads(ID) });
  assert.equal(removed.statusCode, 409);
  assert.equal((removed.json() as { code: string }).code, "PLUGIN_ENABLED");

  const off = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: false } });
  assert.equal((off.json() as PluginInfo).enabled, false);
  assert.equal(h.sessionPreload.at(-1), null);
});

test("POST check is 202 with no body; rollback and DELETE downloads answer the updated PluginInfo", async (t) => {
  const h = await harness(t);
  const check = async () => {
    const accepted = await h.inject({ method: "POST", url: pluginRoutes.check(ID) });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.body, "");
    await h.plugins.settled();
  };
  const listed = async () =>
    ((await h.inject({ method: "GET", url: pluginRoutes.list })).json() as PluginsResponse).plugins[0];

  await check();
  assert.equal(h.registry.calls.latest, 1);
  assert.equal((await listed())?.current?.version, "0.7.0");
  await publish(h.registry, h.root, "0.8.0");
  h.registry.latest = "0.8.0";
  await check();
  assert.equal((await listed())?.current?.version, "0.8.0");

  const rolled = await h.inject({ method: "POST", url: pluginRoutes.rollback(ID) });
  assert.equal(rolled.statusCode, 200);
  const info = rolled.json() as PluginInfo;
  assert.equal(info.id, ID);
  assert.equal(info.current?.version, "0.7.0");
  assert.equal(info.previous?.version, "0.8.0");
  assert.equal(info.skippedVersion, "0.8.0");
  assert.deepEqual(info, await listed());

  const removed = await h.inject({ method: "DELETE", url: pluginRoutes.downloads(ID) });
  assert.equal(removed.statusCode, 200);
  assert.equal((removed.json() as PluginInfo).current, null);
  assert.equal((removed.json() as PluginInfo).previous, null);
});

test("a corrupt plugins.json is reported, not overwritten", async (t) => {
  const h = await harness(t, { seed: "{ corrupt" });
  const res = await h.inject({ method: "GET", url: pluginRoutes.list });
  assert.equal(res.statusCode, 500);
  assert.equal((res.json() as { code: string }).code, "PLUGINS_UNREADABLE");
  const put = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: true } });
  assert.equal(put.statusCode, 500);
  assert.equal((put.json() as { code: string }).code, "PLUGINS_UNREADABLE");
});

test("the remote transport serves the routes to authenticated clients only", async (t) => {
  const h = await harness(t, { mode: "remote" });
  assert.equal((await h.rawInject({ method: "GET", url: pluginRoutes.list })).statusCode, 401);
  assert.equal(
    (await h.rawInject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: true } })).statusCode,
    401
  );
  assert.equal((await h.inject({ method: "GET", url: pluginRoutes.list })).statusCode, 200);
  const put = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: false } });
  assert.equal(put.statusCode, 200);
});

test("creating, renaming and deleting workspaces leaves an enabled plugin on", async (t) => {
  const h = await harness(t);
  const enabled = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: true } });
  assert.equal(enabled.statusCode, 200);
  await h.plugins.settled();
  const preload = h.sessionPreload.at(-1);
  assert.equal(typeof preload, "string");
  const lastEnabled = () => (h.published.at(-1)?.payload as PluginsResponse).plugins[0]?.enabled;

  assert.equal((await h.inject({ method: "DELETE", url: "/api/workspaces/acme" })).statusCode, 204);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);
  assert.equal(lastEnabled(), true);

  assert.equal((await h.inject({ method: "POST", url: "/api/workspaces", payload: { name: "beta" } })).statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);

  const rename = (path: string, newName: string) =>
    h.inject({ method: "POST", url: "/api/fs/rename", payload: { path, newName } });
  assert.equal((await rename(join(h.workspacesDir, "beta"), "renamed")).statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);
  assert.equal(lastEnabled(), true);
});

test("PUT chooses the engine: it answers the plugin on the new engine, persists it, and installs it while on", async (t) => {
  const h = await harness(t);
  const listed = (await h.inject({ method: "GET", url: pluginRoutes.list })).json() as PluginsResponse;
  assert.equal(listed.plugins[0]?.engine, "tsrs");
  assert.deepEqual(
    listed.plugins[0]?.engines?.map((engine) => [engine.id, engine.platform]),
    [
      ["tsrs", "supported"],
      ["tsc-rs", "supported"]
    ]
  );
  assert.equal(listed.plugins[1]?.engine, undefined, "a bundled plugin has no engines");

  const on = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { enabled: true, engine: "tsc-rs" } });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal((on.json() as PluginInfo).engine, "tsc-rs");
  assert.equal((on.json() as PluginInfo).enabled, true);
  await h.plugins.settled();
  const after = ((await h.inject({ method: "GET", url: pluginRoutes.list })).json() as PluginsResponse).plugins[0];
  assert.equal(after?.current?.version, "0.6.0");
  assert.equal(h.registry.calls.latest, 0);

  const back = await h.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { engine: "tsrs" } });
  assert.equal(back.statusCode, 200);
  assert.equal((back.json() as PluginInfo).enabled, true, "choosing an engine leaves the plugin on");
  await h.plugins.settled();
  assert.equal(h.registry.calls.latest, 1, "tsrs was installed");
  const saved = JSON.parse(await readFile(pluginsConfigPath(join(h.root, "appdir")), "utf8")) as {
    plugins: Record<string, { engine?: string; current?: { version: string }; tsrs?: { current?: { version: string } } }>;
  };
  assert.equal(saved.plugins[ID]?.engine, "tsrs");
  assert.equal(saved.plugins[ID]?.current?.version, "0.6.0");
  assert.equal(saved.plugins[ID]?.tsrs?.current?.version, "0.7.0");
});

test("PUT refuses an unknown engine, an empty body and an engine for a bundled plugin (400)", async (t) => {
  const h = await harness(t);
  const expect = async (id: string, payload: unknown, status: number, code: string) => {
    const res = await h.inject({ method: "PUT", url: pluginRoutes.plugin(id), payload: payload as Record<string, unknown> });
    assert.equal(res.statusCode, status, `${JSON.stringify(payload)}: ${res.body}`);
    assert.equal((res.json() as { code: string }).code, code);
  };
  await expect(ID, { engine: "tsgo" }, 400, "INVALID_REQUEST");
  await expect(ID, { engine: 7 }, 400, "INVALID_REQUEST");
  await expect(ID, { enabled: true, engine: "TSRS" }, 400, "INVALID_REQUEST");
  await expect(ID, {}, 400, "INVALID_REQUEST");
  await expect(EXCALIDRAW_PLUGIN_ID, { engine: "tsrs" }, 400, "INVALID_REQUEST");
  assert.equal(h.registry.calls.latest + h.tscRsRegistry.calls.latest, 0);
});

test("PUT refuses an engine with no build on the daemon's platform (409)", async (t) => {
  const root = await tempRoot("orq-plugins-routes-unsupported-");
  const baseDir = join(root, "appdir");
  const plugins = new PluginsService({
    baseDir,
    workspacesDir: () => join(root, "workspaces"),
    writeJson: async (path, value) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(value), "utf8");
    },
    installer: fakeRegistry().deps,
    env: {},
    platform: "win32",
    arch: "x64",
    writePreload: async () => {},
    setSessionPreload: () => {},
    logger: { warn: () => {}, error: () => {} }
  });
  const app = Fastify();
  registerPluginRoutes(app, { plugins });
  t.after(async () => {
    await app.close();
    await plugins.stop();
    await rm(root, { recursive: true, force: true });
  });
  const res = await app.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { engine: "tsrs" } });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { code: string }).code, "PLUGIN_UNSUPPORTED");
  assert.match((res.json() as { message: string }).message, /tsrs has no build for win32\/x64/);
  const ok = await app.inject({ method: "PUT", url: pluginRoutes.plugin(ID), payload: { engine: "tsc-rs" } });
  assert.equal(ok.statusCode, 200);
});
