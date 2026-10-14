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
  PLUGINS_CHANNEL,
  TS_RUST_PLUGIN_ID,
  pluginRoutes
} from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, pluginsConfigPath } from "@orquester/config";
import type { InjectOptions } from "fastify";
import { Broadcaster } from "../broadcaster.ts";
import { createServer } from "../index.ts";
import { PluginsService, publishPluginEvents } from "./plugins-service.ts";
import { fakeRegistry, publish, tempRoot } from "./testing.ts";

// Route-level coverage for /api/plugins (spec §5.3) through the daemon's own
// router — the real createServer and a real PluginsService over a temp appdir,
// an in-memory registry and a stub preload writer: validation (404/400/409),
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
  const registry = fakeRegistry();
  await publish(registry, root, "0.7.0");
  registry.latest = "0.7.0";

  const plugins = new PluginsService({
    baseDir,
    workspacesDir: () => workspacesDir,
    writeJson: async (path, value) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(value), "utf8");
    },
    installer: registry.deps,
    env: {},
    platform: "linux",
    arch: "x64",
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
    body.plugins.map((plugin) => [plugin.id, plugin.name, plugin.platform, plugin.job]),
    [[ID, "Better TS Typecheck", "supported", "idle"]]
  );
});

test("refusals: unknown plugin 404, bad workspace name 400, unknown workspace 404, bad body 400", async (t) => {
  const h = await harness(t);
  const expect = async (request: InjectOptions, status: number, code: string) => {
    const res = await h.inject(request);
    assert.equal(res.statusCode, status, `${request.method} ${request.url}: ${res.body}`);
    assert.equal((res.json() as { code: string }).code, code);
    assert.equal(typeof (res.json() as { message: string }).message, "string");
  };
  await expect({ method: "PUT", url: pluginRoutes.workspace("nope", "acme"), payload: { enabled: true } }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.check("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "POST", url: pluginRoutes.rollback("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "DELETE", url: pluginRoutes.downloads("nope") }, 404, "PLUGIN_NOT_FOUND");
  await expect({ method: "PUT", url: pluginRoutes.workspace(ID, ".hidden"), payload: { enabled: true } }, 400, "INVALID_NAME");
  await expect({ method: "PUT", url: pluginRoutes.workspace(ID, "a\\b"), payload: { enabled: true } }, 400, "INVALID_NAME");
  await expect({ method: "PUT", url: pluginRoutes.workspace(ID, "ghost"), payload: { enabled: true } }, 404, "WORKSPACE_NOT_FOUND");
  // A file directly under the workspaces root is not a workspace.
  await expect({ method: "PUT", url: pluginRoutes.workspace(ID, "notes.txt"), payload: { enabled: true } }, 404, "WORKSPACE_NOT_FOUND");
  await expect({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: "yes" } }, 400, "INVALID_REQUEST");
  await expect({ method: "POST", url: pluginRoutes.rollback(ID) }, 409, "NO_PREVIOUS_VERSION");
  assert.equal(h.registry.calls.latest, 0);
});

test("enabling a workspace answers its state, installs tsc-rs, and broadcasts every step", async (t) => {
  const h = await harness(t);
  const res = await h.inject({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: true } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as PluginInfo).enabledWorkspaces, ["acme"]);
  await h.plugins.settled();

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

  // Remove downloads is refused while a workspace is enabled.
  const removed = await h.inject({ method: "DELETE", url: pluginRoutes.downloads(ID) });
  assert.equal(removed.statusCode, 409);
  assert.equal((removed.json() as { code: string }).code, "PLUGIN_ENABLED");
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
  const put = await h.inject({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: true } });
  assert.equal(put.statusCode, 500);
  assert.equal((put.json() as { code: string }).code, "PLUGINS_UNREADABLE");
});

test("the remote transport serves the routes to authenticated clients only", async (t) => {
  const h = await harness(t, { mode: "remote" });
  assert.equal((await h.rawInject({ method: "GET", url: pluginRoutes.list })).statusCode, 401);
  assert.equal(
    (await h.rawInject({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: true } })).statusCode,
    401
  );
  assert.equal((await h.inject({ method: "GET", url: pluginRoutes.list })).statusCode, 200);
  const put = await h.inject({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: false } });
  assert.equal(put.statusCode, 200);
});

test("creating, renaming and deleting workspaces re-decides the session preload and broadcasts", async (t) => {
  const h = await harness(t);
  const enabled = await h.inject({ method: "PUT", url: pluginRoutes.workspace(ID, "acme"), payload: { enabled: true } });
  assert.equal(enabled.statusCode, 200);
  await h.plugins.settled();
  const preload = h.sessionPreload.at(-1);
  assert.equal(typeof preload, "string");
  const lastEnabled = () => (h.published.at(-1)?.payload as PluginsResponse).plugins[0]?.enabledWorkspaces;

  assert.equal((await h.inject({ method: "DELETE", url: "/api/workspaces/acme" })).statusCode, 204);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), null);
  assert.deepEqual(lastEnabled(), []);

  assert.equal((await h.inject({ method: "POST", url: "/api/workspaces", payload: { name: "acme" } })).statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);
  assert.deepEqual(lastEnabled(), ["acme"]);

  // A rename in the file browser moves the workspace away and back.
  const rename = (path: string, newName: string) =>
    h.inject({ method: "POST", url: "/api/fs/rename", payload: { path, newName } });
  assert.equal((await rename(join(h.workspacesDir, "acme"), "renamed")).statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), null);
  assert.equal((await rename(join(h.workspacesDir, "renamed"), "acme")).statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);

  // So do a folder deleted and created at the workspaces root through the file browser.
  const deleted = await h.inject({
    method: "DELETE",
    url: "/api/fs",
    query: { path: join(h.workspacesDir, "acme") }
  });
  assert.equal(deleted.statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), null);
  const created = await h.inject({
    method: "POST",
    url: "/api/fs/create",
    payload: { path: join(h.workspacesDir, "acme"), kind: "dir" }
  });
  assert.equal(created.statusCode, 200);
  await h.plugins.settled();
  assert.equal(h.sessionPreload.at(-1), preload);
});
