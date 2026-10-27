import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  KNOWLEDGE_GRAPH_PLUGIN_ID,
  type PluginInfo,
  type PluginsResponse,
  TS_RUST_PLUGIN_ID
} from "@orquester/api";
import { knowledgeRuntimeDir, pluginsConfigPath } from "@orquester/config";
import { PLUGIN_CHECK_INTERVAL_MS, PluginsError, PluginsService } from "../../plugins/plugins-service.ts";
import { combinedRegistryDeps, fakeRegistry } from "../../plugins/testing.ts";
import { TS_CHECKER_ENGINE_SPECS } from "../../plugins/ts-rust/installer.ts";
import type { KnowledgeRuntime } from "../ports.ts";
import { knowledgeVersionDir } from "./installer.ts";
import { MYKG_PINNED_VERSION, MYKG_PINNED_WHEEL_SHA256, tiktokenCacheKey } from "./pins.ts";
import { KnowledgeRuntimeTracker } from "./runtime.ts";
import { type FakeKnowledgeHost, fakeKnowledgeHost, makeModel, makeUvBuild, pypiWheel, tempRoot } from "./testing.ts";
import { createKnowledgeGraphUpdater } from "./updater.ts";

// "Knowledge Graph" through the generalized PluginsService: install on first
// enable, checks offering newer patches of the pinned line only, rollback,
// remove downloads, lastError, its own job lane beside ts-rust's, the hourly
// check, and KnowledgeRuntimePort following it all. A fake uv/PyPI/model host
// (./testing.ts) stands in for the network and the children.

const ID = KNOWLEDGE_GRAPH_PLUGIN_ID;
const NEWER = "0.4.11";
const NEWER_SHA = "b".repeat(64);

interface Harness {
  baseDir: string;
  runtimeDir: string;
  file: string;
  host: FakeKnowledgeHost;
  model: ReturnType<typeof makeModel>;
  service: PluginsService;
  tracker: KnowledgeRuntimeTracker;
  events: PluginsResponse[];
  runtimes: Array<KnowledgeRuntime | null>;
  tsRustCalls: () => number;
}

async function harness(t: TestContext, options: { platform?: string; seed?: unknown } = {}): Promise<Harness> {
  const root = await tempRoot("orq-kg-plugin-");
  const baseDir = join(root, "appdir");
  await mkdir(join(root, "workspaces"), { recursive: true });
  const file = pluginsConfigPath(baseDir);
  if (options.seed !== undefined) {
    await mkdir(join(baseDir, "daemon"), { recursive: true });
    await writeFile(file, JSON.stringify(options.seed));
  }
  const uv = await makeUvBuild(root);
  const model = makeModel();
  const host = fakeKnowledgeHost({ uv, model });
  const registries = (["tsrs", "tsc-rs"] as const).map((engine) =>
    fakeRegistry(undefined, TS_CHECKER_ENGINE_SPECS[engine])
  );
  const platform = options.platform ?? "linux";
  const service = new PluginsService({
    baseDir,
    workspacesDir: () => join(root, "workspaces"),
    writeJson: async (path, value) => {
      await mkdir(join(baseDir, "daemon"), { recursive: true });
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    },
    installer: combinedRegistryDeps(registries),
    env: { PATH: process.env.PATH },
    platform,
    arch: "x64",
    libc: "glibc",
    writePreload: async () => {},
    setSessionPreload: () => {},
    knowledgeGraph: createKnowledgeGraphUpdater({
      baseDir,
      platform,
      arch: "x64",
      libc: "glibc",
      env: { PATH: process.env.PATH },
      deps: host.deps,
      uv: platform === "linux" ? uv.build : null,
      model: model.spec,
      encodings: host.encodings
    }),
    logger: { warn: () => {}, error: () => {} }
  });
  const events: PluginsResponse[] = [];
  service.events.on("changed", (response: PluginsResponse) => events.push(response));
  const tracker = new KnowledgeRuntimeTracker({ baseDir, plugins: service, model: model.spec, logger: { warn: () => {} } });
  const runtimes: Array<KnowledgeRuntime | null> = [];
  tracker.onChange((runtime) => runtimes.push(runtime));
  t.after(async () => {
    tracker.stop();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  await service.start();
  await service.settled();
  await tracker.start();
  return {
    baseDir,
    runtimeDir: knowledgeRuntimeDir(baseDir),
    file,
    host,
    model,
    service,
    tracker,
    events,
    runtimes,
    tsRustCalls: () => registries.reduce((sum, registry) => sum + registry.calls.latest + registry.calls.meta.length, 0)
  };
}

async function info(h: Harness): Promise<PluginInfo> {
  return h.service.get(ID);
}

async function settle(h: Harness): Promise<void> {
  await h.service.settled();
  await h.tracker.settled();
}

async function onDisk(h: Harness): Promise<any> {
  return JSON.parse(await readFile(h.file, "utf8")).plugins[ID];
}

async function versions(h: Harness): Promise<string[]> {
  return readdir(join(h.runtimeDir, "versions")).then(
    (names) => names.sort(),
    () => []
  );
}

async function refusal(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PluginsError, String(error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function publishNewer(h: Harness): void {
  h.host.pypi.set(NEWER, [pypiWheel(NEWER, NEWER_SHA)]);
}

test("off by default, no installed version or active job; nothing fetched", async (t) => {
  const h = await harness(t);
  const plugin = await info(h);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.current, null);
  assert.equal(plugin.previous, null);
  assert.equal(plugin.job, "idle");
  assert.deepEqual(h.host.calls, { json: [], downloads: [], texts: [], run: [] });
  assert.equal(h.tracker.current(), null);
});

test("turning it on installs the pinned runtime in its own lane; the runtime port follows", async (t) => {
  const h = await harness(t);
  const on = await h.service.update(ID, { enabled: true });
  assert.equal(on.enabled, true);
  await settle(h);

  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.current?.integrity, `sha256:${MYKG_PINNED_WHEEL_SHA256}`);
  assert.equal(plugin.lastCheckAt, "2026-10-23T12:00:00.000Z");
  assert.equal(plugin.job, "idle");
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION]);
  const stored = await onDisk(h);
  assert.equal(stored.enabled, true);
  assert.equal(stored.current.version, MYKG_PINNED_VERSION);

  // Its jobs went out as its own; ts-rust stayed idle and fetched nothing.
  const jobs = h.events.map((event) => event.plugins.find((p) => p.id === ID)?.job);
  assert.deepEqual(jobs, ["idle", "checking", "installing", "idle"]);
  assert.ok(h.events.every((event) => event.plugins.find((p) => p.id === TS_RUST_PLUGIN_ID)?.job === "idle"));
  assert.equal(h.tsRustCalls(), 0);

  const runtime = h.tracker.current();
  const dir = knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION);
  assert.deepEqual(runtime, {
    mykgVersion: MYKG_PINNED_VERSION,
    mykgBin: join(dir, "venv", "bin", "mykg"),
    pythonBin: join(dir, "venv", "bin", "python"),
    embeddingModelDir: join(dir, "models"),
    embeddingModelId: "Fixture/mini-model",
    embeddingDimensions: 384,
    embeddingModelReady: true,
    embeddingQueryPrefix: "query: ",
    embeddingPassagePrefix: "passage: ",
    embeddingMaxTokens: 512,
    embeddingThresholds: { minimum: 0.8, good: 0.84, strong: 0.88, duplicate: 0.95 },
    tiktokenCacheDir: join(dir, "tiktoken")
  });
  assert.deepEqual(h.runtimes, [runtime]);

  // On again: nothing more to install.
  const downloads = h.host.calls.downloads.length;
  await h.service.update(ID, { enabled: true });
  await settle(h);
  assert.equal(h.host.calls.downloads.length, downloads);
});

test("the first install is the pinned version even when PyPI has a newer patch; the next check offers that", async (t) => {
  const h = await harness(t);
  publishNewer(h);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  let plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION, "the tested version first");
  assert.equal(plugin.current?.integrity, `sha256:${MYKG_PINNED_WHEEL_SHA256}`);
  assert.deepEqual(h.host.calls.json, [], "resolved from the pin, no PyPI lookup");

  await h.service.checkNow(ID);
  await settle(h);
  plugin = await info(h);
  assert.equal(plugin.current?.version, NEWER);
  assert.equal(plugin.previous?.version, MYKG_PINNED_VERSION);

  // After "Remove downloads", turning it on again is a first install again.
  await h.service.update(ID, { enabled: false });
  await h.service.removeDownloads(ID);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.previous, null);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION]);
});

test("checks offer newer patches of the pinned line only; updates keep current and previous", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);

  h.host.pypi.set("0.5.0", [pypiWheel("0.5.0", "f".repeat(64))]);
  await h.service.checkNow(ID);
  await settle(h);
  assert.equal((await info(h)).current?.version, MYKG_PINNED_VERSION, "0.5.0 is not offered");

  publishNewer(h);
  await h.service.checkNow(ID);
  await settle(h);
  let plugin = await info(h);
  assert.equal(plugin.current?.version, NEWER);
  assert.equal(plugin.previous?.version, MYKG_PINNED_VERSION);
  assert.equal(h.tracker.current()?.mykgVersion, NEWER);

  h.host.pypi.set("0.4.12", [pypiWheel("0.4.12", "c".repeat(64))]);
  await h.service.checkNow(ID);
  await settle(h);
  plugin = await info(h);
  assert.equal(plugin.current?.version, "0.4.12");
  assert.equal(plugin.previous?.version, NEWER);
  assert.deepEqual(await versions(h), [NEWER, "0.4.12"], "older versions are pruned");
  assert.deepEqual(
    h.runtimes.map((runtime) => runtime?.mykgVersion),
    [MYKG_PINNED_VERSION, NEWER, "0.4.12"]
  );
});

test("rollback swaps current and previous and skips the version rolled back from", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  publishNewer(h);
  await h.service.checkNow(ID);
  await settle(h);

  const rolled = await h.service.rollback(ID);
  await settle(h);
  assert.equal(rolled.current?.version, MYKG_PINNED_VERSION);
  assert.equal(rolled.previous?.version, NEWER);
  assert.equal(rolled.skippedVersion, NEWER);
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);

  // The skipped version is not reinstalled by a check.
  const downloads = h.host.calls.downloads.length;
  await h.service.checkNow(ID);
  await settle(h);
  assert.equal((await info(h)).current?.version, MYKG_PINNED_VERSION);
  assert.equal(h.host.calls.downloads.length, downloads);

  // A rollback target whose files are gone is refused.
  await rm(knowledgeVersionDir(h.runtimeDir, NEWER), { recursive: true });
  await refusal(h.service.rollback(ID), 409, "NO_PREVIOUS_VERSION");
});

/** Make `version` look installed by an Orquester build that shipped another prompt overlay. */
async function staleOverlay(h: Harness, version: string): Promise<string> {
  const path = join(knowledgeVersionDir(h.runtimeDir, version), "runtime.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.overlay.digest = "0".repeat(64);
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

test("a previous version installed with an older overlay is still a rollback target; the next check repairs it", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  publishNewer(h);
  await h.service.checkNow(ID);
  await settle(h);
  const manifest = await staleOverlay(h, MYKG_PINNED_VERSION);

  const rolled = await h.service.rollback(ID);
  await settle(h);
  assert.equal(rolled.current?.version, MYKG_PINNED_VERSION);
  assert.equal(rolled.skippedVersion, NEWER);
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);

  // The check reinstalls the version rolled back to (with the shipped overlay), not the skipped one.
  await h.service.checkNow(ID);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.previous?.version, NEWER);
  assert.equal(plugin.skippedVersion, NEWER);
  assert.notEqual(JSON.parse(await readFile(manifest, "utf8")).overlay.digest, "0".repeat(64));
});

test("an update over a current version with an older overlay keeps it as the rollback target", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await staleOverlay(h, MYKG_PINNED_VERSION);
  publishNewer(h);
  await h.service.checkNow(ID);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, NEWER);
  assert.equal(plugin.previous?.version, MYKG_PINNED_VERSION);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION, NEWER]);
});

/**
 * Make `version` look installed by an Orquester build that shipped all-MiniLM-L6-v2: its manifest
 * names that model and only that model's files are in `models/`.
 */
async function oldModel(h: Harness, version: string): Promise<void> {
  const dir = knowledgeVersionDir(h.runtimeDir, version);
  const path = join(dir, "runtime.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.embeddingModel = { id: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", dimensions: 384 };
  await writeFile(path, JSON.stringify(manifest));
  await rm(join(dir, "models"), { recursive: true });
  await mkdir(join(dir, "models", "Xenova", "all-MiniLM-L6-v2", "onnx"), { recursive: true });
  await writeFile(join(dir, "models", "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx"), "old model");
}

const uvRuns = (h: Harness) => h.host.calls.run.filter((call) => call.command.endsWith("/uv")).length;
const modelUrls = (h: Harness) => h.model.spec.files.map((file) => h.model.spec.fileUrl(file.path));

test("an install from before the model change keeps linking; the hourly check brings the model alone", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await oldModel(h, MYKG_PINNED_VERSION);
  h.service.boxToolingChanged(); // any plugins.changed makes the port look again
  await settle(h);
  // myKG is intact: the runtime stays (linking runs); the model is not there (search on text).
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);
  assert.equal(h.tracker.current()?.embeddingModelReady, false);

  const uv = uvRuns(h);
  const downloads = h.host.calls.downloads.length;
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.previous, null, "a repair is no update");
  assert.equal(plugin.lastError, null);
  assert.equal(uvRuns(h), uv, "no venv rebuilt");
  assert.deepEqual(h.host.calls.downloads.slice(downloads), modelUrls(h), "only the model was downloaded");
  const runtime = h.tracker.current();
  assert.equal(runtime?.embeddingModelReady, true);
  assert.equal(runtime?.embeddingModelId, h.model.spec.id);
  assert.equal(runtime?.embeddingQueryPrefix, "query: ");
  assert.deepEqual(await readdir(join(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION), "models")), ["Fixture"]);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION]);
});

test("a model download that fails its hash records a model error; the runtime keeps linking without the model", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await oldModel(h, MYKG_PINNED_VERSION);
  h.host.downloads.set(h.model.spec.fileUrl("onnx/model_quantized.onnx"), Buffer.from("tampered"));
  await h.service.checkNow(ID);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.lastError?.step, "model");
  assert.match(plugin.lastError?.message ?? "", /does not match its sha256/);
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);
  assert.equal(h.tracker.current()?.embeddingModelReady, false);
  const manifest = JSON.parse(await readFile(join(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION), "runtime.json"), "utf8"));
  assert.equal(manifest.embeddingModel.id, "Xenova/all-MiniLM-L6-v2", "the version was left as it was");
});

test("a failed model repair is not retried every hour; turning on and a manual check retry it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await oldModel(h, MYKG_PINNED_VERSION);
  h.service.boxToolingChanged();
  await settle(h);
  const modelUrl = h.model.spec.fileUrl("onnx/model_quantized.onnx");
  const good = h.host.downloads.get(modelUrl)!;
  h.host.downloads.set(modelUrl, Buffer.from("tampered"));
  const before = h.host.calls.downloads.filter((url) => url === modelUrl).length;
  const modelTries = () => h.host.calls.downloads.filter((url) => url === modelUrl).length - before;

  // The first automatic attempt runs, and fails.
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.equal(modelTries(), 1);
  assert.equal((await info(h)).lastError?.step, "model");
  assert.equal((await onDisk(h)).lastError.version, MYKG_PINNED_VERSION);

  // The next hourly checks leave it (each try is a ~130 MB download); the error stays.
  const json = h.host.calls.json.length;
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.ok(h.host.calls.json.length > json, "the hourly checks ran");
  assert.equal(modelTries(), 1, "no model download every hour");
  assert.equal((await info(h)).lastError?.step, "model");
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION, "linking keeps running");

  // Turning the plugin on again retries it (as a start does).
  await h.service.update(ID, { enabled: false });
  await h.service.update(ID, { enabled: true });
  await settle(h);
  assert.equal(modelTries(), 2);

  // A manual check retries it too; with a good download the model is in place.
  h.host.downloads.set(modelUrl, good);
  await h.service.checkNow(ID);
  await settle(h);
  assert.equal((await info(h)).lastError, null);
  assert.equal(h.tracker.current()?.embeddingModelReady, true);
});

test("rollback to a version with the old model still works; the next check gives it the new model", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  publishNewer(h);
  await h.service.checkNow(ID);
  await settle(h);
  await oldModel(h, MYKG_PINNED_VERSION);

  const rolled = await h.service.rollback(ID);
  await settle(h);
  assert.equal(rolled.current?.version, MYKG_PINNED_VERSION);
  assert.equal(rolled.previous?.version, NEWER);
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);
  assert.equal(h.tracker.current()?.embeddingModelReady, false);

  const uv = uvRuns(h);
  const downloads = h.host.calls.downloads.length;
  await h.service.checkNow(ID);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION, "the version rolled back to, not the skipped one");
  assert.equal(plugin.previous?.version, NEWER);
  assert.equal(plugin.skippedVersion, NEWER);
  assert.equal(uvRuns(h), uv);
  assert.deepEqual(h.host.calls.downloads.slice(downloads), modelUrls(h));
  assert.equal(h.tracker.current()?.embeddingModelReady, true);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION, NEWER]);
});

test("a failed install records its step and version; the hourly check does not retry it, a manual one does", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);

  publishNewer(h);
  h.host.omitPrompts.add("pass2/system.txt");
  await h.service.checkNow(ID);
  await settle(h);
  let plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION, "current kept");
  assert.equal(plugin.lastError?.step, "overlay");
  assert.match(plugin.lastError?.message ?? "", /pass2\/system\.txt/);
  assert.equal((await onDisk(h)).lastError.version, NEWER);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION]);
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);

  const downloads = h.host.calls.downloads.length;
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.ok(h.host.calls.json.length > 0, "the hourly check ran");
  assert.equal(h.host.calls.downloads.length, downloads, "it did not download the failed release again");
  assert.equal((await info(h)).lastError?.step, "overlay", "its error stays");

  h.host.omitPrompts.clear();
  await h.service.checkNow(ID);
  await settle(h);
  plugin = await info(h);
  assert.equal(plugin.current?.version, NEWER);
  assert.equal(plugin.lastError, null);
});

test("a first install that failed is retried by the hourly check", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  h.host.failUv.set("pip", "network unreachable");
  await h.service.update(ID, { enabled: true });
  await settle(h);
  assert.equal((await info(h)).lastError?.step, "packages");
  assert.equal((await info(h)).current, null);

  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.equal((await info(h)).current?.version, MYKG_PINNED_VERSION);
});

test("a myKG that rejects the generated config records a smoke-test error and keeps the working version", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  publishNewer(h);
  h.host.configCheck = { exitCode: 1, stdout: "", stderr: "Traceback (most recent call last):\nKeyError: 'batch_per_file'\n", timedOut: false };
  await h.service.checkNow(ID);
  await settle(h);
  const plugin = await info(h);
  assert.equal(plugin.current?.version, MYKG_PINNED_VERSION);
  assert.equal(plugin.lastError?.step, "smoke-test");
  assert.equal(
    plugin.lastError?.message,
    "myKG 0.4.11 rejected the generated config (profile agent-claude-code): Traceback (most recent call last): | KeyError: 'batch_per_file'"
  );
  assert.equal((await onDisk(h)).lastError.version, NEWER);
  assert.deepEqual(await versions(h), [MYKG_PINNED_VERSION]);
});

test("a runtime missing its tiktoken encoding is repaired by the next check", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  const cache = h.tracker.current()?.tiktokenCacheDir ?? "";
  await rm(join(cache, tiktokenCacheKey(h.host.encodings[0]?.url ?? "")));
  const downloads = h.host.calls.downloads.length;
  await h.service.checkNow(ID);
  await settle(h);
  assert.ok(h.host.calls.downloads.length > downloads, "reinstalled");
  assert.equal((await info(h)).current?.version, MYKG_PINNED_VERSION);
  assert.equal((await info(h)).previous, null, "a repair is no update");
  assert.equal((await readdir(cache)).length, 1);
});

test("remove downloads is refused while on, then deletes the runtime and keeps the settings", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await h.service.updatePluginSettings(ID, { concurrency: 2 });
  await refusal(h.service.removeDownloads(ID), 409, "PLUGIN_ENABLED");

  await h.service.update(ID, { enabled: false });
  const removed = await h.service.removeDownloads(ID);
  await settle(h);
  assert.equal(removed.current, null);
  assert.equal(await stat(h.runtimeDir).catch(() => null), null);
  assert.deepEqual((await onDisk(h)).settings, { concurrency: 2 });
  assert.equal(h.tracker.current(), null);
  assert.deepEqual(h.runtimes.at(-1), null);
});

test("a runtime whose files vanished is repaired by the next check; the port drops it meanwhile", async (t) => {
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  await rm(join(knowledgeVersionDir(h.runtimeDir, MYKG_PINNED_VERSION), "venv", "bin", "mykg"));
  h.service.boxToolingChanged(); // any plugins.changed makes the port look again
  await settle(h);
  assert.equal(h.tracker.current(), null);

  await h.service.checkNow(ID);
  await settle(h);
  assert.equal((await info(h)).current?.version, MYKG_PINNED_VERSION);
  assert.equal((await info(h)).previous, null, "a repair is no update");
  assert.equal(h.tracker.current()?.mykgVersion, MYKG_PINNED_VERSION);
});

test("the hourly timer runs for Knowledge Graph alone, and only while it is on", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  await h.service.update(ID, { enabled: true });
  await settle(h);
  const lookups = () => h.host.calls.json.filter((url) => url.endsWith("/mykg/json")).length;
  const before = lookups();
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.equal(lookups(), before + 1);

  await h.service.update(ID, { enabled: false });
  t.mock.timers.tick(PLUGIN_CHECK_INTERVAL_MS);
  await settle(h);
  assert.equal(lookups(), before + 1);
  assert.equal(h.tsRustCalls(), 0);
});

test("an unsupported host: no turning on, no checks", async (t) => {
  const h = await harness(t, { platform: "freebsd" });
  assert.equal((await info(h)).platform, "unsupported");
  await refusal(h.service.update(ID, { enabled: true }), 409, "PLUGIN_UNSUPPORTED");
  await refusal(h.service.checkNow(ID), 409, "PLUGIN_UNSUPPORTED");
  await h.service.update(ID, { enabled: false });
  assert.deepEqual(h.host.calls.json, []);
});

test("settings live on the record: merged, unknown keys kept, unreadable state never written", async (t) => {
  const h = await harness(t, {
    seed: { version: 1, plugins: { [ID]: { settings: { model: "m", future: { a: 1 } }, extra: true } } }
  });
  assert.deepEqual(h.service.pluginSettings(ID), { model: "m", future: { a: 1 } });
  assert.equal(h.service.isEnabled(ID), false);
  await h.service.updatePluginSettings(ID, { concurrency: 3, model: undefined });
  const stored = await onDisk(h);
  assert.deepEqual(stored.settings, { future: { a: 1 }, concurrency: 3 });
  assert.equal(stored.extra, true);
  assert.equal(h.events.length > 0, true, "the change was broadcast");
});
