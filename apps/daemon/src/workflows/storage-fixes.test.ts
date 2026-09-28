// Regression tests for the storage review fixes: forward-compatible definitions and secrets
// files and block/edge ids that can never key Object.prototype.

import assert from "node:assert/strict";
import fs, { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { validateWorkflow } from "@orquester/api";
import { parseWorkflowsFile, workflowRecordSchema } from "@orquester/config";

import { WorkflowSecretsService } from "./secrets.ts";
import type { PersistedRun } from "./contracts.ts";
import { FileRunStore } from "./run-store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-storage-"));
  roots.push(dir);
  return dir;
}

const quiet = { warn: () => undefined, error: () => undefined };

const record = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "wf-1",
  name: "Nightly",
  project: { kind: "temp", workspace: "ws", source: { kind: "empty" }, futureProjectKey: 1 },
  settings: { notify: { onFailure: true, futureNotifyKey: "slack" } },
  nodes,
  edges: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...extra
});

test("a newer build's nested fields survive this build's parse (a save never erases them)", () => {
  const parsed = workflowRecordSchema.parse(
    record([
      {
        id: "a",
        type: "http",
        name: "Call",
        position: { x: 0, y: 0, futureZ: 3 },
        retry: { maxTries: 2, delaySeconds: 1, futureBackoff: "exp" },
        config: { url: "https://x.test", futureTls: { pin: "abc" }, body: { kind: "text", value: "hi", futureEncoding: "gzip" } }
      },
      { id: "b", type: "trigger.git", name: "Git", position: { x: 0, y: 0 }, config: { repo: { kind: "project", futureRepoKey: true }, event: { kind: "push", futureEventKey: 1 } } }
    ])
  );
  const value = JSON.parse(JSON.stringify(parsed));
  assert.equal(value.project.futureProjectKey, 1);
  assert.equal(value.settings.notify.futureNotifyKey, "slack");
  assert.equal(value.nodes[0].position.futureZ, 3);
  assert.equal(value.nodes[0].retry.futureBackoff, "exp");
  assert.deepEqual(value.nodes[0].config.futureTls, { pin: "abc" });
  assert.equal(value.nodes[0].config.body.futureEncoding, "gzip");
  assert.equal(value.nodes[1].config.repo.futureRepoKey, true);
  assert.equal(value.nodes[1].config.event.futureEventKey, 1);
});

test("block and connection ids that could key Object.prototype are refused, by the schema and by validation", () => {
  const evil = record([{ id: "__proto__", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} }]);
  assert.equal(workflowRecordSchema.safeParse(evil).success, false);
  const file = parseWorkflowsFile({ version: 1, workflows: [evil] });
  assert.equal(file.workflows.length, 0);
  assert.equal(file.rejected.length, 1, "kept verbatim, never loaded");
  const problems = validateWorkflow(evil).problems;
  assert.ok(problems.some((p) => p.severity === "error" && p.code === "schema"), JSON.stringify(problems));
  const edge = validateWorkflow(
    record(
      [
        { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "c", type: "code", name: "Run", position: { x: 0, y: 0 }, config: { source: "" } }
      ],
      { edges: [{ id: "constructor", source: "t", sourceHandle: "success", target: "c" }] }
    )
  ).problems;
  assert.ok(edge.some((p) => p.code === "schema" && p.edgeId === "constructor"), JSON.stringify(edge));
  // Ordinary ids (uuids, "case:0"-style handles in edge ids) still pass.
  assert.equal(workflowRecordSchema.safeParse(record([{ id: "0f8c-9a:x_y.z", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} }])).success, true);
});

test("the secrets file keeps what this build cannot read, verbatim, across a write", async () => {
  const dir = await scratch();
  const file = join(dir, "workflow-secrets.json");
  const original = {
    version: 1,
    futureTopLevel: { a: 1 },
    global: { OLD: { value: "old-value", updatedAt: "2026-09-01T00:00:00.000Z", futureMeta: "m" }, "lower-case": { value: "v", updatedAt: "x" } },
    workflows: { "wf-1": { OWN: { value: "own-value", updatedAt: "2026-09-01T00:00:00.000Z" }, weird: 42 }, "wf-2": "not-an-object" }
  };
  await writeFile(file, JSON.stringify(original));
  const secrets = new WorkflowSecretsService({ file, logger: quiet });
  await secrets.load();
  assert.deepEqual(secrets.names("wf-1").sort(), ["OLD", "OWN"]);
  await secrets.set("NEW", "new-value");
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written.futureTopLevel, { a: 1 });
  assert.deepEqual(written.global["lower-case"], { value: "v", updatedAt: "x" });
  assert.equal(written.global.OLD.futureMeta, "m");
  assert.equal(written.global.NEW.value, "new-value");
  assert.equal(written.workflows["wf-1"].weird, 42);
  assert.equal(written.workflows["wf-1"].OWN.value, "own-value");
  assert.equal(written.workflows["wf-2"], "not-an-object");
});

test("the secrets store never indexes past its own maps", async () => {
  const dir = await scratch();
  const secrets = new WorkflowSecretsService({ file: join(dir, "s.json"), logger: quiet });
  await secrets.load();
  await secrets.set("TOKEN", "value-1234", "wf-1");
  assert.equal(await secrets.delete("hasOwnProperty", "__proto__"), false);
  assert.equal(await secrets.delete("TOKEN", "__proto__"), false);
  assert.equal(await secrets.delete("toString"), false);
  assert.deepEqual(secrets.resolve("__proto__"), {});
  assert.deepEqual(secrets.list("constructor"), []);
  assert.equal(typeof Object.prototype.hasOwnProperty, "function");
  assert.equal(typeof Object.prototype.toString, "function");
  assert.equal(await secrets.delete("TOKEN", "wf-1"), true);
});


test("an unfinished run remains recoverable when the index lands before its pending save", async (t) => {
  const dir = join(await scratch(), "runs");
  const store = new FileRunStore({ dir, logger: quiet });
  await store.init();
  const run: PersistedRun = {
    version: 1, id: "r1", workflowId: "wf-1", workflowName: "W", status: "running",
    trigger: { kind: "manual" }, test: false, queuedAt: "2026-09-28T10:00:00.000Z",
    definition: workflowRecordSchema.parse(record([])), triggerPayload: null,
    blocks: {}, takenEdges: [], deadEdges: [], depth: 0
  };
  await store.create(run);
  await store.flush();

  let releaseWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeStarted!: () => void;
  const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
  let indexWritten!: () => void;
  const indexed = new Promise<void>((resolve) => { indexWritten = resolve; });
  const rename = fs.rename;
  const intercepted = t.mock.method(fs, "rename", async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]) => {
    if (target === join(dir, "r1", "run.json")) {
      writeStarted();
      await pendingWrite;
    }
    await rename(source, target);
    if (target === join(dir, "index.json")) indexWritten();
  });
  syncBuiltinESMExports();
  t.after(async () => {
    releaseWrite();
    await store.flush();
    intercepted.mock.restore();
    syncBuiltinESMExports();
  });
  const saving = store.save({ ...run, status: "succeeded" });
  await writing;
  await store.create({ ...run, id: "r2", status: "succeeded" });
  await indexed;

  const reopened = new FileRunStore({ dir, logger: quiet });
  await reopened.init();
  assert.deepEqual((await reopened.listUnfinished()).map((entry) => ({ id: entry.id, status: entry.status })), [{ id: "r1", status: "running" }]);
  releaseWrite();
  await saving;
});
