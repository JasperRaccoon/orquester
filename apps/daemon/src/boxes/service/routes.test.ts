import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BoxesResponse, BoxProvidersResponse, ProjectSummary } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { createServer } from "../../index.ts";
import type { BoxService } from "./index.ts";
import { connectProvider, FakeAdapter, testBoxService, type TestService } from "./testing.ts";

// The project routes (index.ts) and the plugin's routes, through the real fastify handlers with a
// box service over fakes. The fake hub never connects a box here: setup stops at `connect`, which
// is all these routes need (the lifecycle tests run setup to the end).

type CreateServerArgs = Parameters<typeof createServer>;

interface Harness extends TestService {
  root: string;
  workspacesDir: string;
  adapter: FakeAdapter;
  inject: ReturnType<typeof createServer>["inject"];
}

async function harness(t: test.TestContext, options: { publicOrigin?: string | null; fetch?: typeof fetch } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "orq-box-routes-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(workspacesDir, "acme"), { recursive: true });
  const adapter = new FakeAdapter();
  const test = testBoxService({
    baseDir: root,
    adapters: [adapter],
    overrides: {
      publicOrigin: () => (options.publicOrigin === undefined ? "https://orq.example.test" : options.publicOrigin),
      ...(options.fetch ? { fetch: options.fetch } : {})
    }
  });
  await test.service.start();
  const resolved = {
    daemonDir: join(root, "daemon"),
    workspacesDir,
    workspacesMetaFile: join(root, "daemon", "workspaces.json"),
    fsRoot: workspacesDir
  } as unknown as CreateServerArgs[1];
  const noop = async () => undefined;
  const services = {
    boxes: test.service,
    sessions: { create: async () => ({ id: "s", projectPath: "" }), closeByProjectPrefix: () => undefined },
    browsers: { closeForProject: noop },
    desktops: { closeForProject: noop },
    todos: { deleteByProjectPath: noop, deleteByWorkspace: noop },
    savedPrompts: { deleteForProject: noop, deleteForWorkspace: noop },
    accounts: { unbindWorkspace: noop }
  } as unknown as CreateServerArgs[4];
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await test.service.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...test, root, workspacesDir, adapter, inject: app.inject.bind(app) };
}

/** Resolves once `predicate` holds for the box (checked on every record change). */
function until(service: BoxService, boxId: string, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate()) return resolve();
    const off = service.registry.onChange((id) => {
      if (id === boxId && predicate()) {
        off();
        resolve();
      }
    });
  });
}

const location = { kind: "box", boxKind: "linux", provider: "hetzner", size: "big", region: "ash" } as const;

test("creating a project in a box answers at once with the project and its provisioning box", async (t) => {
  const h = await harness(t);
  await connectProvider(h.service, h.adapter);
  const res = await h.inject({ method: "POST", url: "/api/workspaces/acme/projects", payload: { source: "empty", name: "app", location } });
  assert.equal(res.statusCode, 200, res.body);
  const project = res.json() as ProjectSummary;
  assert.equal(project.path, join(h.workspacesDir, "acme", "app"));
  assert.equal(project.box?.state, "provisioning");
  assert.equal(project.box?.provider, "hetzner");
  assert.deepEqual(await readdir(project.path), [], "an empty host stub");

  const list = await h.inject({ method: "GET", url: "/api/workspaces/acme/projects" });
  const listed = (list.json() as ProjectSummary[]).find((entry) => entry.name === "app");
  assert.equal(listed?.box?.boxId, project.box?.boxId);
});

test("a cloned box project lists its repo fields from the record and keeps the template command", async (t) => {
  const h = await harness(t);
  await connectProvider(h.service, h.adapter);
  // The workspace's git account comes from workspaces.json.
  await mkdir(join(h.root, "daemon"), { recursive: true });
  await writeFile(
    join(h.root, "daemon", "workspaces.json"),
    JSON.stringify({ version: 1, workspaces: [{ name: "acme", createdAt: "2026-01-01T00:00:00.000Z", isArchived: false, archivedProjects: [], gitAccountId: "acct" }] })
  );
  const cloned = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "clone", url: "git@github.com:acme/app.git", location }
  });
  assert.equal(cloned.statusCode, 200, cloned.body);
  const list = (await h.inject({ method: "GET", url: "/api/workspaces/acme/projects" })).json() as ProjectSummary[];
  const app = list.find((entry) => entry.name === "app")!;
  assert.equal(app.repoKey, "github.com/acme/app");
  assert.equal(app.repoName, "acme/app");
  assert.equal(app.cloneUrl, "git@github.com:acme/app.git");
  assert.equal(h.service.registry.get(app.box!.boxId)!.project!.gitAccountId, "acct");

  const templated = await h.inject({
    method: "POST",
    url: "/api/workspaces/acme/projects",
    payload: { source: "empty", name: "site", location, templateCommand: "npx create-next-app@latest ." }
  });
  assert.equal(templated.statusCode, 200, templated.body);
  const record = h.service.registry.get((templated.json() as ProjectSummary).box!.boxId)!;
  assert.equal(record.project!.source, "template");
  assert.equal(record.project!.templateCommand, "npx create-next-app@latest .");
});

test("the location is validated before anything is created", async (t) => {
  const h = await harness(t);
  const post = (payload: object) => h.inject({ method: "POST", url: "/api/workspaces/acme/projects", payload });
  const notConnected = await post({ name: "a", location });
  assert.equal(notConnected.statusCode, 409);
  assert.equal(notConnected.json().code, "BOX_PROVIDER_NOT_CONFIGURED");
  await connectProvider(h.service, h.adapter);
  const cases: [object, number, string][] = [
    [{ ...location, provider: "nope" }, 400, "BOX_INVALID_REQUEST"],
    [{ ...location, boxKind: "macos" }, 400, "BOX_UNSUPPORTED"],
    [{ ...location, size: "huge" }, 400, "BOX_INVALID_REQUEST"],
    [{ ...location, size: "small", region: "ash" }, 400, "BOX_INVALID_REQUEST"],
    [{ ...location, region: undefined }, 400, "BOX_INVALID_REQUEST"]
  ];
  for (const [bad, status, code] of cases) {
    const res = await post({ name: "a", location: bad });
    assert.equal(res.statusCode, status, `${JSON.stringify(bad)} → ${res.body}`);
    assert.equal(res.json().code, code);
  }
  const multiline = await post({ name: "a", location, templateCommand: "echo hi\nrm -rf /" });
  assert.equal(multiline.statusCode, 400, multiline.body);
  assert.equal(multiline.json().code, "BOX_INVALID_REQUEST");
  const clone = await post({ source: "clone", url: "git@github.com:a/b.git", location });
  assert.equal(clone.statusCode, 400, "no git account on the workspace");
  assert.equal(h.adapter.creates.length, 0);
  assert.equal(h.service.registry.list().length, 0);
  assert.deepEqual(await readdir(join(h.workspacesDir, "acme")), [], "no stub left behind");

  h.setEnabled(false);
  const off = await post({ name: "a", location });
  assert.equal(off.statusCode, 409);
  assert.equal(off.json().code, "BOXES_DISABLED");
});

test("without a route to this daemon no box project can be created", async (t) => {
  const h = await harness(t, { publicOrigin: null });
  await connectProvider(h.service, h.adapter);
  const res = await h.inject({ method: "POST", url: "/api/workspaces/acme/projects", payload: { name: "a", location } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "BOX_CONNECTION_NOT_CONFIGURED");
});

test("deleting a box project destroys the box first; a failed destroy keeps the project", async (t) => {
  const h = await harness(t);
  await connectProvider(h.service, h.adapter);
  const created = (await h.inject({ method: "POST", url: "/api/workspaces/acme/projects", payload: { name: "app", location } })).json() as ProjectSummary;
  const boxId = created.box!.boxId;
  await until(h.service, boxId, () => h.service.registry.get(boxId)?.providerRef !== undefined);

  h.adapter.failDestroy = new Error("provider is down");
  const failed = await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/app" });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().code, "BOX_PROVIDER_ERROR");
  assert.ok((await stat(created.path)).isDirectory(), "the project is kept");
  assert.equal(h.service.registry.get(boxId)!.state, "destroy-failed");
  const row = ((await h.inject({ method: "GET", url: "/api/workspaces/acme/projects" })).json() as ProjectSummary[])[0]!;
  assert.equal(row.box?.state, "destroy-failed");

  h.adapter.failDestroy = null;
  const retried = await h.inject({ method: "DELETE", url: "/api/workspaces/acme/projects/app" });
  assert.equal(retried.statusCode, 204);
  await assert.rejects(stat(created.path));
  const record = h.service.registry.get(boxId)!;
  assert.equal(record.state, "destroyed");
  assert.equal(record.destroyedReason, "deleted");
  assert.equal(typeof record.projectDeletedAt, "string");
  assert.equal(h.adapter.instances.size, 0);
  // The path is free again: a new project of the same name is not taken for the old box's.
  assert.equal(h.service.registry.locate(created.path).kind, "host");
});

test("plugin routes: boxes, providers, kinds and offers, connection, refusals", async (t) => {
  let fetched = "";
  const h = await harness(t, {
    fetch: (async (url: string | URL) => {
      fetched = String(url);
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch
  });
  const bad = await h.inject({ method: "PUT", url: "/api/boxes/providers/hetzner", payload: { credentials: { apiKey: "wrong-key-0000" } } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "BOX_PROVIDER_ERROR");
  assert.equal(h.service.settings.configured("hetzner"), false, "nothing saved");
  const missing = await h.inject({ method: "PUT", url: "/api/boxes/providers/hetzner", payload: { credentials: {} } });
  assert.equal(missing.statusCode, 400);

  const good = await h.inject({ method: "PUT", url: "/api/boxes/providers/hetzner", payload: { credentials: { apiKey: h.adapter.validKey } } });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(good.json().status, "connected");
  assert.equal(good.json().keyHint, "1234");
  assert.ok(!good.body.includes(h.adapter.validKey), "the key never comes back");
  const providers = (await h.inject({ method: "GET", url: "/api/boxes/providers" })).json() as BoxProvidersResponse;
  assert.equal(providers.providers[0]!.status, "connected");

  const kinds = (await h.inject({ method: "GET", url: "/api/boxes/kinds" })).json();
  const linux = kinds.kinds.find((entry: { kind: string }) => entry.kind === "linux");
  assert.deepEqual(linux, { kind: "linux", providers: ["hetzner"], fromHourlyUsd: 0.05, maxLifetimeMinutes: null, unavailableReason: null });
  assert.match(kinds.kinds.find((entry: { kind: string }) => entry.kind === "macos").unavailableReason, /No connected provider/);
  const offers = await h.inject({ method: "GET", url: "/api/boxes/providers/hetzner/offers?kind=linux" });
  assert.equal(offers.statusCode, 200);
  assert.equal(offers.json().sizes.length, 2);
  assert.equal(h.adapter.offersCalls, 1, "kinds and offers share the cached fetch");
  assert.equal((await h.inject({ method: "GET", url: "/api/boxes/providers/hetzner/offers?kind=windows" })).statusCode, 400);

  // A project box cannot be destroyed on its own.
  const created = (await h.inject({ method: "POST", url: "/api/workspaces/acme/projects", payload: { name: "app", location } })).json() as ProjectSummary;
  const boxes = (await h.inject({ method: "GET", url: "/api/boxes" })).json() as BoxesResponse;
  assert.equal(boxes.boxes.length, 1);
  assert.equal(boxes.totals.activeCount, 1);
  assert.equal(boxes.totals.hourlyUsd, 0.2);
  const refused = await h.inject({ method: "DELETE", url: `/api/boxes/${created.box!.boxId}` });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "BOX_IS_PROJECT");
  assert.equal((await h.inject({ method: "GET", url: "/api/boxes/nope" })).statusCode, 404);
  const log = await h.inject({ method: "GET", url: `/api/boxes/${created.box!.boxId}/setup-log` });
  assert.equal(log.statusCode, 200);
  assert.match(log.headers["content-type"] as string, /text\/plain/);
  // Its provider cannot be forgotten while the box exists.
  assert.equal((await h.inject({ method: "DELETE", url: "/api/boxes/providers/hetzner" })).statusCode, 409);

  // Connection: the default public URL is the daemon's origin; the test expects Orquester's 401.
  const connection = (await h.inject({ method: "GET", url: "/api/boxes/connection" })).json();
  assert.equal(connection.mode, "public-url");
  assert.equal(connection.publicUrl, "https://orq.example.test");
  assert.equal((await h.inject({ method: "PUT", url: "/api/boxes/connection", payload: { publicUrl: "http://plain.example" } })).statusCode, 400);
  assert.equal((await h.inject({ method: "PUT", url: "/api/boxes/connection", payload: { tailscaleOAuthClientId: "only-id" } })).statusCode, 400);
  const put = await h.inject({ method: "PUT", url: "/api/boxes/connection", payload: { publicUrl: "https://boxes.example.test/", tailscaleApiToken: "tskey-api-secretvalue" } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().publicUrl, "https://boxes.example.test");
  assert.equal(put.json().tailscale.configured, true);
  assert.ok(!put.body.includes("tskey-api-secretvalue"));
  const tested = (await h.inject({ method: "POST", url: "/api/boxes/connection/test" })).json();
  assert.equal(fetched, "https://boxes.example.test/api/boxes/agent/linux-x64");
  assert.equal(tested.reachable, "ok");

  // Off: reads still answer, changes do not.
  h.setEnabled(false);
  assert.equal((await h.inject({ method: "GET", url: "/api/boxes/providers" })).statusCode, 200);
  assert.equal((await h.inject({ method: "GET", url: "/api/boxes" })).statusCode, 200);
  for (const [method, url] of [
    ["PUT", "/api/boxes/providers/hetzner"],
    ["GET", "/api/boxes/kinds"],
    ["POST", "/api/boxes/connection/test"],
    ["DELETE", `/api/boxes/${created.box!.boxId}`]
  ] as const) {
    const res = await h.inject({ method, url, payload: method === "PUT" ? { credentials: {} } : undefined });
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    assert.equal(res.json().code, "BOXES_DISABLED");
  }
});
