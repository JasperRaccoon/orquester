import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import Fastify from "fastify";
import { KNOWLEDGE_DEFAULT_SETTINGS, KNOWLEDGE_GRAPH_PLUGIN_ID, knowledgeRoutes } from "@orquester/api";
import { pluginsConfigPath } from "@orquester/config";
import { PluginsService } from "../plugins/plugins-service.ts";
import { fakeKnowledgeHost, makeModel, makeUvBuild, tempRoot } from "./install/testing.ts";
import { createKnowledgeGraphUpdater } from "./install/updater.ts";
import { registerKnowledgeSettingsRoutes } from "./settings-routes.ts";
import { KnowledgeSettingsError, KnowledgeSettingsService, knowledgeSettingsFrom } from "./settings.ts";

// The plugin's settings on its plugins.json record, through a real
// PluginsService over a temp appdir (the runtime install is faked): defaults,
// validation, persistence with unknown keys kept, the port's change signal,
// and the GET/PUT routes.

const ID = KNOWLEDGE_GRAPH_PLUGIN_ID;
const ACCOUNTS: Record<string, { agent: string }> = {
  "claude-1": { agent: "claude" },
  "codex-1": { agent: "codex" }
};

async function harness(t: TestContext, seed?: unknown) {
  const root = await tempRoot("orq-kg-settings-");
  const baseDir = join(root, "appdir");
  const file = pluginsConfigPath(baseDir);
  if (seed !== undefined) {
    await mkdir(join(baseDir, "daemon"), { recursive: true });
    await writeFile(file, typeof seed === "string" ? seed : JSON.stringify(seed));
  }
  const uv = await makeUvBuild(root);
  const model = makeModel();
  const host = fakeKnowledgeHost({ uv, model });
  const plugins = new PluginsService({
    baseDir,
    workspacesDir: () => join(root, "workspaces"),
    writeJson: async (path, value) => {
      await mkdir(join(baseDir, "daemon"), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    },
    env: {},
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    writePreload: async () => {},
    setSessionPreload: () => {},
    knowledgeGraph: createKnowledgeGraphUpdater({
      baseDir,
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      env: {},
      deps: host.deps,
      uv: uv.build,
      model: model.spec
    }),
    logger: { warn: () => {}, error: () => {} }
  });
  await plugins.start();
  const settings = new KnowledgeSettingsService({ plugins, accounts: { getRecord: (id) => ACCOUNTS[id] } });
  const changes: number[] = [];
  settings.onChange(() => changes.push(changes.length));
  const app = Fastify();
  registerKnowledgeSettingsRoutes(app, { settings, logger: { error: () => {} } });
  t.after(async () => {
    settings.dispose();
    await app.close();
    await plugins.stop();
    await rm(root, { recursive: true, force: true });
  });
  const onDisk = async () => JSON.parse(await readFile(file, "utf8")).plugins[ID];
  return { plugins, settings, changes, app, onDisk };
}

async function invalid(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KnowledgeSettingsError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "KNOWLEDGE_INVALID");
    assert.match(error.message, pattern);
    return true;
  });
}

test("defaults until set; a stored value of the wrong type or out of range reads as its default", () => {
  assert.deepEqual(knowledgeSettingsFrom(undefined), KNOWLEDGE_DEFAULT_SETTINGS);
  assert.deepEqual(knowledgeSettingsFrom({ accountId: "a", model: "m", concurrency: 8 }), {
    accountId: "a",
    model: "m",
    concurrency: 8
  });
  assert.deepEqual(knowledgeSettingsFrom({ accountId: 3, model: "", concurrency: 99 }), KNOWLEDGE_DEFAULT_SETTINGS);
  assert.deepEqual(knowledgeSettingsFrom({ concurrency: 0 }), KNOWLEDGE_DEFAULT_SETTINGS);
  assert.deepEqual(knowledgeSettingsFrom([1]), KNOWLEDGE_DEFAULT_SETTINGS);
});

test("an update is validated, merged into the record and kept beside keys another build wrote", async (t) => {
  const h = await harness(t, { version: 1, plugins: { [ID]: { settings: { future: "kept", model: "old" }, other: 1 } } });
  assert.deepEqual(h.settings.get(), { accountId: null, model: "old", concurrency: 4 });

  const next = await h.settings.update({ accountId: "claude-1", concurrency: 2, unknownField: "ignored" });
  assert.deepEqual(next, { accountId: "claude-1", model: "old", concurrency: 2 });
  assert.deepEqual((await h.onDisk()).settings, { future: "kept", model: "old", accountId: "claude-1", concurrency: 2 });
  assert.equal((await h.onDisk()).other, 1);

  assert.deepEqual(await h.settings.update({ accountId: null, model: "  claude-sonnet-4-5  " }), {
    accountId: null,
    model: "claude-sonnet-4-5",
    concurrency: 2
  });
  assert.deepEqual(await h.settings.update({ model: null }), { accountId: null, model: null, concurrency: 2 });
  assert.deepEqual(await h.settings.update({}), { accountId: null, model: null, concurrency: 2 });
});

test("refusals: concurrency out of bounds, a non-Claude or unknown account, an empty model, a non-object", async (t) => {
  const h = await harness(t);
  await invalid(h.settings.update({ concurrency: 0 }), /from 1 to 8/);
  await invalid(h.settings.update({ concurrency: 9 }), /from 1 to 8/);
  await invalid(h.settings.update({ concurrency: 2.5 }), /whole number/);
  await invalid(h.settings.update({ concurrency: "4" }), /whole number/);
  await invalid(h.settings.update({ accountId: "codex-1" }), /must be a Claude account/);
  await invalid(h.settings.update({ accountId: "nope" }), /no agent account "nope"/);
  await invalid(h.settings.update({ accountId: "" }), /accountId/);
  await invalid(h.settings.update({ model: "" }), /model/);
  await invalid(h.settings.update({ model: 5 }), /model/);
  await invalid(h.settings.update({ model: "x".repeat(201) }), /longer than 200/);
  await invalid(h.settings.update(null), /JSON object/);
  await invalid(h.settings.update([1]), /JSON object/);
  // One bad field writes nothing.
  await invalid(h.settings.update({ concurrency: 2, accountId: "codex-1" }), /Claude/);
  assert.deepEqual(h.settings.get(), KNOWLEDGE_DEFAULT_SETTINGS);
});

test("the port: enabled follows the plugin, and onChange fires on a toggle or a settings change only", async (t) => {
  const h = await harness(t);
  assert.equal(h.settings.enabled(), false);
  await h.settings.update({ concurrency: 3 });
  assert.equal(h.changes.length, 1);
  await h.settings.update({ concurrency: 3 });
  assert.equal(h.changes.length, 1, "no change, no signal");

  await h.plugins.update(ID, { enabled: true });
  await h.plugins.settled();
  assert.equal(h.settings.enabled(), true);
  assert.equal(h.changes.length, 2);

  await h.plugins.update("excalidraw", { enabled: true });
  await h.plugins.settled();
  assert.equal(h.changes.length, 2, "another plugin's change is not ours");
});

test("GET and PUT the settings route; refusals are { code, message }", async (t) => {
  const h = await harness(t);
  const get = await h.app.inject({ method: "GET", url: knowledgeRoutes.settings });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), KNOWLEDGE_DEFAULT_SETTINGS);

  const put = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { concurrency: 6 } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { accountId: null, model: null, concurrency: 6 });

  const bad = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { accountId: "codex-1" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.json()).sort(), ["code", "message"]);
  assert.equal(bad.json().code, "KNOWLEDGE_INVALID");
});

test("an unreadable plugins.json is reported and never written over", async (t) => {
  const h = await harness(t, "{ not json");
  const put = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { concurrency: 2 } });
  assert.equal(put.statusCode, 500);
  assert.equal(put.json().code, "PLUGINS_UNREADABLE");
  const get = await h.app.inject({ method: "GET", url: knowledgeRoutes.settings });
  assert.deepEqual(get.json(), KNOWLEDGE_DEFAULT_SETTINGS);
});
