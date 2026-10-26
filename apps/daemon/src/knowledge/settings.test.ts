import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import Fastify from "fastify";
import { KNOWLEDGE_DEFAULT_ACCOUNT_POLICY, KNOWLEDGE_DEFAULT_SETTINGS, KNOWLEDGE_GRAPH_PLUGIN_ID, knowledgeRoutes } from "@orquester/api";
import { pluginsConfigPath, type AccountPolicy } from "@orquester/config";
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
const ACCOUNTS = [
  { id: "claude-1", agent: "claude" },
  { id: "codex-1", agent: "codex" },
  { id: "claude-2", agent: "claude" }
];
const CLAUDE = ["claude-1", "claude-2"];
const AUTO = KNOWLEDGE_DEFAULT_ACCOUNT_POLICY;
/** A host with Claude accounts and nothing stored: automatic over them. */
const DEFAULTS = KNOWLEDGE_DEFAULT_SETTINGS;
const fixed = (accounts: string[], extra: Partial<AccountPolicy> = {}): AccountPolicy => ({ ...AUTO, strategy: "fixed", accounts, ...extra });

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
  const settings = new KnowledgeSettingsService({ plugins, accounts: { list: () => ({ accounts: ACCOUNTS }) } });
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

async function refused(promise: Promise<unknown>, pattern: RegExp, code = "KNOWLEDGE_INVALID"): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KnowledgeSettingsError);
    assert.equal(error.status, 400);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}
const invalid = (promise: Promise<unknown>, pattern: RegExp) => refused(promise, pattern);
const unknownAccount = (promise: Promise<unknown>, pattern: RegExp) => refused(promise, pattern, "KNOWLEDGE_UNKNOWN_ACCOUNT");

test("defaults until set; a stored value of the wrong type or out of range reads as its default", () => {
  assert.deepEqual(knowledgeSettingsFrom(undefined, CLAUDE), DEFAULTS);
  assert.deepEqual(knowledgeSettingsFrom({ accountId: "a", model: "m", concurrency: 8 }, CLAUDE), {
    accountPolicy: fixed(["a", ...CLAUDE]),
    accountId: "a",
    model: "m",
    concurrency: 8
  });
  assert.deepEqual(knowledgeSettingsFrom({ accountId: 3, model: "", concurrency: 99 }, CLAUDE), DEFAULTS);
  assert.deepEqual(knowledgeSettingsFrom({ concurrency: 0 }, CLAUDE), DEFAULTS);
  assert.deepEqual(knowledgeSettingsFrom([1], CLAUDE), DEFAULTS);
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: "fixed" }, CLAUDE), DEFAULTS);
});

test("a legacy accountId reads as the policy it meant", () => {
  // Automatic: the least used Claude account; the System login only while there is none.
  assert.deepEqual(knowledgeSettingsFrom({ accountId: null }, CLAUDE).accountPolicy, AUTO);
  assert.deepEqual(knowledgeSettingsFrom({ accountId: null }, []).accountPolicy, { ...AUTO, includeSystem: true });
  assert.deepEqual(knowledgeSettingsFrom(undefined, []).accountPolicy, { ...AUTO, includeSystem: true });
  // A chosen account first, every other Claude account after it.
  assert.deepEqual(knowledgeSettingsFrom({ accountId: "claude-2" }, CLAUDE), { ...DEFAULTS, accountPolicy: fixed(["claude-2", "claude-1"]), accountId: "claude-2" });
  assert.deepEqual(knowledgeSettingsFrom({ accountId: "system" }, CLAUDE).accountPolicy, fixed(["system", ...CLAUDE], { includeSystem: true }));
});

test("a stored policy is read field by field, and wins unless an older build changed accountId after it", () => {
  const policy = fixed(["claude-2", "claude-1"], { maxWeeklyPct: 80, future: 1 } as Partial<AccountPolicy>);
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: policy, accountId: "claude-2" }, CLAUDE), { ...DEFAULTS, accountPolicy: policy, accountId: "claude-2" });
  // No accountId beside it (or one of the wrong type) is no sign of an older build.
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: policy }, CLAUDE).accountPolicy, policy);
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: policy, accountId: 7 }, CLAUDE).accountPolicy, policy);
  // Bad fields read as their defaults.
  assert.deepEqual(
    knowledgeSettingsFrom({ accountPolicy: { strategy: "soonest-reset", maxSessionPct: 400, unknownUsage: 3 }, accountId: null }, CLAUDE).accountPolicy,
    { ...AUTO, strategy: "soonest-reset" }
  );
  // An older build chose another account (or automatic) since: its choice wins.
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: policy, accountId: "claude-1" }, CLAUDE).accountPolicy, fixed(["claude-1", "claude-2"]));
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: policy, accountId: null }, CLAUDE).accountPolicy, AUTO);
  assert.deepEqual(knowledgeSettingsFrom({ accountPolicy: { strategy: "least-used" }, accountId: "claude-2" }, CLAUDE).accountId, "claude-2");
});

test("an update is validated, merged into the record and kept beside keys another build wrote", async (t) => {
  const h = await harness(t, { version: 1, plugins: { [ID]: { settings: { future: "kept", model: "old" }, other: 1 } } });
  assert.deepEqual(h.settings.get(), { ...DEFAULTS, model: "old" });

  const next = await h.settings.update({ accountId: "claude-1", concurrency: 2, unknownField: "ignored" });
  assert.deepEqual(next, { accountPolicy: fixed(["claude-1", "claude-2"]), accountId: "claude-1", model: "old", concurrency: 2 });
  assert.deepEqual((await h.onDisk()).settings, { future: "kept", model: "old", accountId: "claude-1", concurrency: 2 });
  assert.equal((await h.onDisk()).other, 1);

  assert.deepEqual(await h.settings.update({ accountId: null, model: "  claude-sonnet-4-5  " }), {
    ...DEFAULTS,
    model: "claude-sonnet-4-5",
    concurrency: 2
  });
  assert.deepEqual(await h.settings.update({ model: null }), { ...DEFAULTS, concurrency: 2 });
  assert.deepEqual(await h.settings.update({}), { ...DEFAULTS, concurrency: 2 });
});

test("a policy update is stored with the accountId an older build would run; a legacy accountId update drops it", async (t) => {
  const h = await harness(t, { version: 1, plugins: { [ID]: { settings: { future: "kept" } } } });
  // Schema defaults filled, duplicates dropped, unknown keys kept; the System login is allowed.
  const sent = { strategy: "fixed", accounts: ["claude-2", "system", "claude-2"], maxWeeklyPct: 90, newer: true };
  const stored = { ...AUTO, strategy: "fixed", accounts: ["claude-2", "system"], maxWeeklyPct: 90, newer: true };
  const next = await h.settings.update({ accountPolicy: sent, accountId: "claude-1" });
  assert.deepEqual(next, { ...DEFAULTS, accountPolicy: stored, accountId: "claude-2" });
  assert.deepEqual((await h.onDisk()).settings, { future: "kept", accountPolicy: stored, accountId: "claude-2" });

  // Not a fixed order: an older build runs automatic.
  const leastUsed = { ...AUTO, accounts: ["claude-1"], includeSystem: true, maxSessionPct: 50, scoped: [{ label: "Fable", maxPct: 70, onlyForModels: ["opus"] }] };
  assert.deepEqual(await h.settings.update({ accountPolicy: leastUsed }), { ...DEFAULTS, accountPolicy: leastUsed, accountId: null });
  assert.equal((await h.onDisk()).settings.accountId, null);
  assert.deepEqual((await h.settings.update({ accountPolicy: { strategy: "fixed", accounts: ["system"] } })).accountId, "system");

  // An older client's accountId: the record then means what it chose.
  assert.deepEqual(await h.settings.update({ accountId: "claude-2" }), { ...DEFAULTS, accountPolicy: fixed(["claude-2", "claude-1"]), accountId: "claude-2" });
  assert.deepEqual((await h.onDisk()).settings, { future: "kept", accountId: "claude-2" });
});

test("refusals: concurrency out of bounds, a bad policy, a non-Claude or unknown account, an empty model, a non-object", async (t) => {
  const h = await harness(t);
  await invalid(h.settings.update({ concurrency: 0 }), /from 1 to 8/);
  await invalid(h.settings.update({ concurrency: 9 }), /from 1 to 8/);
  await invalid(h.settings.update({ concurrency: 2.5 }), /whole number/);
  await invalid(h.settings.update({ concurrency: "4" }), /whole number/);
  await unknownAccount(h.settings.update({ accountId: "codex-1" }), /codex account; indexing runs on Claude accounts/);
  await unknownAccount(h.settings.update({ accountId: "nope" }), /no agent account "nope"/);
  await invalid(h.settings.update({ accountId: "" }), /accountId/);
  await invalid(h.settings.update({ accountPolicy: "fixed" }), /accountPolicy/);
  await invalid(h.settings.update({ accountPolicy: [] }), /accountPolicy/);
  await invalid(h.settings.update({ accountPolicy: null }), /accountPolicy/);
  await invalid(h.settings.update({ accountPolicy: { strategy: "round-robin" } }), /accountPolicy\.strategy/);
  await invalid(h.settings.update({ accountPolicy: { maxWeeklyPct: 101 } }), /accountPolicy\.maxWeeklyPct/);
  await invalid(h.settings.update({ accountPolicy: { accounts: [""] } }), /accountPolicy\.accounts\.0/);
  await invalid(h.settings.update({ accountPolicy: { scoped: [{ label: "Fable" }] } }), /accountPolicy\.scoped\.0\.maxPct/);
  await unknownAccount(h.settings.update({ accountPolicy: { accounts: ["claude-1", "codex-1"] } }), /"codex-1" is a codex account/);
  await unknownAccount(h.settings.update({ accountPolicy: { strategy: "fixed", accounts: ["gone"] } }), /no agent account "gone"/);
  await invalid(h.settings.update({ model: "" }), /model/);
  await invalid(h.settings.update({ model: 5 }), /model/);
  await invalid(h.settings.update({ model: "x".repeat(201) }), /longer than 200/);
  await invalid(h.settings.update(null), /JSON object/);
  await invalid(h.settings.update([1]), /JSON object/);
  // One bad field writes nothing.
  await unknownAccount(h.settings.update({ concurrency: 2, accountId: "codex-1" }), /Claude/);
  await invalid(h.settings.update({ concurrency: 2, accountPolicy: { strategy: "x" } }), /strategy/);
  assert.deepEqual(h.settings.get(), DEFAULTS);
});

test("the port: enabled follows the plugin, and onChange fires on a toggle or a settings change only", async (t) => {
  const h = await harness(t);
  assert.equal(h.settings.enabled(), false);
  await h.settings.update({ concurrency: 3 });
  assert.equal(h.changes.length, 1);
  await h.settings.update({ concurrency: 3 });
  assert.equal(h.changes.length, 1, "no change, no signal");
  await h.settings.update({ accountPolicy: { strategy: "soonest-reset" } });
  assert.equal(h.changes.length, 2);

  await h.plugins.update(ID, { enabled: true });
  await h.plugins.settled();
  assert.equal(h.settings.enabled(), true);
  assert.equal(h.changes.length, 3);

  await h.plugins.update("excalidraw", { enabled: true });
  await h.plugins.settled();
  assert.equal(h.changes.length, 3, "another plugin's change is not ours");
});

test("GET and PUT the settings route; refusals are { code, message }", async (t) => {
  const h = await harness(t);
  const get = await h.app.inject({ method: "GET", url: knowledgeRoutes.settings });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), DEFAULTS);

  const put = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { concurrency: 6 } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { ...DEFAULTS, concurrency: 6 });

  const policy = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { accountPolicy: { strategy: "fixed", accounts: ["claude-2"] } } });
  assert.equal(policy.statusCode, 200);
  assert.deepEqual(policy.json(), { ...DEFAULTS, accountPolicy: fixed(["claude-2"]), accountId: "claude-2", concurrency: 6 });

  const bad = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { accountId: "codex-1" } });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(Object.keys(bad.json()).sort(), ["code", "message"]);
  assert.equal(bad.json().code, "KNOWLEDGE_UNKNOWN_ACCOUNT");

  const badPolicy = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { accountPolicy: { strategy: 1 } } });
  assert.equal(badPolicy.statusCode, 400);
  assert.equal(badPolicy.json().code, "KNOWLEDGE_INVALID");
});

test("an unreadable plugins.json is reported and never written over", async (t) => {
  const h = await harness(t, "{ not json");
  const put = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, payload: { concurrency: 2 } });
  assert.equal(put.statusCode, 500);
  assert.equal(put.json().code, "PLUGINS_UNREADABLE");
  const get = await h.app.inject({ method: "GET", url: knowledgeRoutes.settings });
  assert.deepEqual(get.json(), DEFAULTS);
});

test("settings route: bad JSON, an oversized body and a wrong media type answer { code, message }", async (t) => {
  const h = await harness(t);
  const json = { "content-type": "application/json" };
  const answer = async (headers: Record<string, string>, payload: string) => {
    const response = await h.app.inject({ method: "PUT", url: knowledgeRoutes.settings, headers, payload });
    return { status: response.statusCode, body: response.json() as { code: string; message: string } };
  };
  const badJson = await answer(json, '{"model": secret');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.code, "KNOWLEDGE_INVALID");
  assert.ok(badJson.body.message.length > 0 && !badJson.body.message.includes("secret"));
  const tooLarge = await answer(json, JSON.stringify({ model: "x".repeat(2 * 1024 * 1024) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, "KNOWLEDGE_TOO_LARGE");
  const plain = await answer({ "content-type": "text/plain" }, "model");
  assert.equal(plain.status, 400);
  assert.equal(plain.body.code, "KNOWLEDGE_INVALID");
});
