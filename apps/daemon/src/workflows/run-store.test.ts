import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { after, test } from "node:test";
import { workflowRecordSchema } from "@orquester/config";
import type { PersistedRun } from "./contracts.ts";
import { FileRunStore, persistedRunToWire, runSummaryOf } from "./run-store.ts";

const roots: string[] = [];
after(async () => {
  // A store's debounced index write can still land while the tree is removed (ENOTEMPTY): retry.
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-wf-runs-"));
  roots.push(dir);
  return dir;
}

function quiet() {
  const lines: string[] = [];
  return { lines, logger: { warn: (...a: unknown[]) => void lines.push(a.join(" ")), error: (...a: unknown[]) => void lines.push(a.join(" ")) } };
}

const definition = workflowRecordSchema.parse({
  id: "wf-1",
  name: "Nightly",
  project: { kind: "existing", projectPath: "/w/ws/app" },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z"
});

function run(id: string, overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    version: 1,
    id,
    workflowId: "wf-1",
    workflowName: "Nightly",
    status: "succeeded",
    trigger: { kind: "manual" },
    test: false,
    queuedAt: "2026-09-28T10:00:00.000Z",
    definition,
    triggerPayload: { kind: "manual", input: null },
    blocks: {},
    takenEdges: [],
    deadEdges: [],
    depth: 0,
    ...overrides
  };
}

/** Queued `minutesAgo` before 2026-09-28T12:00Z. */
function at(minutesAgo: number): string {
  return new Date(Date.parse("2026-09-28T12:00:00.000Z") - minutesAgo * 60_000).toISOString();
}

test("create/save: run.json is atomic and 0600, the last save wins, the index follows", async () => {
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  const r = run("run-a", { status: "running", startedAt: at(1) });
  await store.create(r);
  const file = join(dir, "run-a", "run.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(store.activeForWorkflow("wf-1").length, 1);

  // Many saves in a row: coalesced, never out of order.
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 20; i += 1) {
    saves.push(store.save({ ...r, current: { nodeId: "n", name: "Step", index: i + 1, total: 20 } }));
  }
  saves.push(store.save({ ...r, status: "succeeded", endedAt: at(0) }));
  await Promise.all(saves);
  const onDisk = JSON.parse(await readFile(file, "utf8")) as PersistedRun;
  assert.equal(onDisk.status, "succeeded");
  assert.deepEqual((await readdir(join(dir, "run-a"))).filter((f) => f.endsWith(".tmp")), []);
  assert.equal(store.activeForWorkflow("wf-1").length, 0);
  assert.equal(store.latestForWorkflow("wf-1")!.status, "succeeded");
  assert.deepEqual((await store.load("run-a"))!.status, "succeeded");
  assert.equal(await store.load("../etc"), null);
});

test("init rebuilds the index from the run directories; an unreadable run.json is skipped", async () => {
  const dir = await scratch();
  const first = new FileRunStore({ dir, logger: quiet().logger });
  await first.init();
  await first.create(run("run-old", { queuedAt: at(30) }));
  await first.create(run("run-new", { queuedAt: at(10), status: "running" }));
  await first.create(run("run-other", { workflowId: "wf-2", queuedAt: at(5) }));
  await first.flush();
  await mkdir(join(dir, "run-broken"));
  await writeFile(join(dir, "run-broken", "run.json"), "{nope");
  await mkdir(join(dir, "run-empty"));
  // A stale index.json must not win over the directories.
  await writeFile(join(dir, "index.json"), JSON.stringify({ version: 1, runs: { ghost: { size: 1, mtimeMs: 1, summary: { id: "ghost", workflowId: "wf-1", queuedAt: at(1), status: "running" } } } }));

  const { lines, logger } = quiet();
  const second = new FileRunStore({ dir, logger });
  await second.init();
  const page = await second.listForWorkflow("wf-1", { limit: 10 });
  assert.deepEqual(page.runs.map((r) => r.id), ["run-new", "run-old"]);
  assert.equal(page.before, null);
  assert.deepEqual(second.activeForWorkflow("wf-1").map((r) => r.id), ["run-new"]);
  assert.deepEqual((await second.listUnfinished()).map((r) => r.id), ["run-new"]);
  assert.equal(second.latestForWorkflow("wf-2")!.id, "run-other");
  assert.ok(lines.some((line) => line.includes("run-broken")));

  // The rewritten cache is reused on the next boot (same answer).
  await second.flush();
  const third = new FileRunStore({ dir, logger: quiet().logger });
  await third.init();
  assert.deepEqual((await third.listForWorkflow("wf-1", { limit: 10 })).runs.map((r) => r.id), ["run-new", "run-old"]);
});

test("paging: `before` is a run id cursor, newest first; an unknown cursor is a first page", async () => {
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  for (let i = 0; i < 5; i += 1) await store.create(run(`run-${i}`, { queuedAt: at(50 - i) }));
  const one = await store.listForWorkflow("wf-1", { limit: 2 });
  assert.deepEqual(one.runs.map((r) => r.id), ["run-4", "run-3"]);
  assert.equal(one.before, "run-3");
  const two = await store.listForWorkflow("wf-1", { limit: 2, before: one.before! });
  assert.deepEqual(two.runs.map((r) => r.id), ["run-2", "run-1"]);
  const three = await store.listForWorkflow("wf-1", { limit: 2, before: two.before! });
  assert.deepEqual(three.runs.map((r) => r.id), ["run-0"]);
  assert.equal(three.before, null);
  assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 2, before: "gone" })).runs.map((r) => r.id), ["run-4", "run-3"]);
  assert.deepEqual(await store.listForWorkflow("nobody", { limit: 2 }), { runs: [], before: null });
});

test("sweep keeps the newest 100 and nothing older than 30 days, preserving active runs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T12:00:00.000Z") });
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  for (let i = 0; i < 102; i += 1) {
    await store.create(run(`run-${i}`, { queuedAt: at(i * 10), endedAt: at(i * 10) }));
  }
  await store.create(run("run-active", { queuedAt: at(1100), status: "running" }));
  await store.create(run("run-ancient", { workflowId: "wf-2", queuedAt: at(31 * 24 * 60), endedAt: at(31 * 24 * 60) }));
  await store.create(run("run-ancient-active", { workflowId: "wf-2", queuedAt: at(32 * 24 * 60), status: "queued" }));
  await store.sweep();
  assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 200 })).runs.map((r) => r.id), [...Array.from({ length: 100 }, (_, i) => `run-${i}`), "run-active"]);
  assert.deepEqual((await store.listForWorkflow("wf-2", { limit: 10 })).runs.map((r) => r.id), ["run-ancient-active"]);
  assert.equal(await store.load("run-100"), null);
  assert.equal(await store.load("run-101"), null);
  assert.equal(await store.load("run-ancient"), null);
  await store.save(run("run-101"));
  await store.appendEvent("run-101", { type: "late" });
  assert.ok(!(await readdir(dir)).includes("run-101"));
  await store.flush();
});

test("sweep keeps a run whose temporary project is still there, until the project is deleted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-28T12:00:00.000Z") });
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  const kept = { path: "/w/ws/wf-kept", deleted: false, deleteAfter: at(-60) };
  await store.create(run("run-new", { queuedAt: at(0), endedAt: at(0), status: "succeeded" }));
  await store.create(run("run-kept", { queuedAt: at(31 * 24 * 60), endedAt: at(31 * 24 * 60), status: "failed", tempProject: kept }));
  await store.create(run("run-plain", { queuedAt: at(32 * 24 * 60), endedAt: at(32 * 24 * 60), status: "failed" }));
  await store.sweep();
  assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 10 })).runs.map((r) => r.id), ["run-new", "run-kept"]);
  // The sweeper deleted the project: the next retention sweep takes the run.
  const loaded = (await store.load("run-kept"))!;
  loaded.tempProject = { path: kept.path, deleted: true };
  await store.save(loaded);
  await store.sweep();
  assert.deepEqual((await store.listForWorkflow("wf-1", { limit: 10 })).runs.map((r) => r.id), ["run-new"]);
});

test("events append as NDJSON; attempt dirs and output files live under the run", async () => {
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  await store.create(run("run-x"));
  await Promise.all([store.appendEvent("run-x", { n: 1 }), store.appendEvent("run-x", { n: 2 }), store.appendEvent("run-x", { n: 3 })]);
  const lines = (await readFile(join(dir, "run-x", "events.ndjson"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ n: 1 }, { n: 2 }, { n: 3 }]);

  const attempt = await store.attemptDir("run-x", "node-1", 2);
  assert.equal(attempt, join(dir, "run-x", "nodes", "node-1", "2"));
  assert.ok((await stat(attempt)).isDirectory());
  const escaped = await store.attemptDir("run-x", "../../evil", 1);
  const underRun = relative(join(dir, "run-x", "nodes"), escaped);
  assert.ok(!isAbsolute(underRun) && underRun !== ".." && !underRun.startsWith(`..${sep}`));
  assert.ok((await stat(escaped)).isDirectory());

  const big = { text: "y".repeat(100_000) };
  const path = await store.writeOutputFile("run-x", "node-1", 2, big);
  assert.equal(path, join(attempt, "output.json"));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.readOutputFile(path), big);
  const outside = join(await scratch(), "outside.json");
  await writeFile(outside, '{"secret":"host-only"}');
  await assert.rejects(store.readOutputFile(outside));
});

test("deleteForWorkflow removes every run of that workflow only", async () => {
  const dir = await scratch();
  const store = new FileRunStore({ dir, logger: quiet().logger });
  await store.init();
  await store.create(run("run-a"));
  await store.create(run("run-b", { status: "running" }));
  await store.create(run("run-c", { workflowId: "wf-2" }));
  await store.deleteForWorkflow("wf-1");
  assert.equal(store.latestForWorkflow("wf-1"), undefined);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith("run-")), ["run-c"]);
  assert.equal(store.summaryOf("run-a"), undefined);
});

test("runSummaryOf / persistedRunToWire: bookkeeping stripped, outputs cut to the preview", () => {
  const big = "é".repeat(40_000);
  const persisted = run("run-w", {
    status: "failed",
    error: "boom",
    retryOf: "run-v",
    seededOutputs: { a: 1 },
    blocks: {
      a: { nodeId: "a", name: "A", type: "code", status: "succeeded", attempt: 1, output: { small: true } },
      b: { nodeId: "b", name: "B", type: "code", status: "succeeded", attempt: 1, output: big, outputFile: "/x/output.json" },
      c: {
        nodeId: "c",
        name: "C",
        type: "wait",
        status: "waiting",
        attempt: 1,
        waitingOn: { kind: "timer", until: at(0), purpose: "wait" }
      }
    }
  });
  const summary = runSummaryOf(persisted);
  assert.equal(summary.status, "failed");
  assert.equal(summary.error, "boom");
  assert.equal(summary.retryOf, "run-v");
  assert.ok(!("definition" in summary) && !("triggerPayload" in summary) && !("blocks" in summary));
  const wire = persistedRunToWire(persisted);
  assert.ok(!("version" in wire) && !("depth" in wire) && !("seededOutputs" in wire));
  assert.deepEqual(wire.blocks.a!.output, { small: true });
  assert.equal(wire.blocks.a!.outputTruncated, undefined);
  assert.equal(wire.blocks.b!.outputTruncated, true);
  assert.equal(wire.blocks.b!.output, '"' + "é".repeat(32_767));
  assert.ok(!("outputFile" in wire.blocks.b!));
  assert.ok(!("waitingOn" in wire.blocks.c!));
});
