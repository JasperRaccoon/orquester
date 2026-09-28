import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { WorkflowStateStore } from "./state-store.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orquester-wf-state-"));
  roots.push(root);
  return root;
}

function quietLogger() {
  const lines: string[] = [];
  return { lines, logger: { warn: (m: string) => void lines.push(`warn: ${m}`), error: (m: string) => void lines.push(`error: ${m}`) } };
}

const cooldown = { until: "2026-09-28T13:00:00.000Z", reason: "usage_limit" as const, setAt: "2026-09-28T12:00:00.000Z" };

test("a missing file loads empty, silently; updates persist atomically at 0600", async () => {
  const dir = await scratch();
  const path = join(dir, "daemon", "workflow-state.json");
  const { lines, logger } = quietLogger();
  const store = new WorkflowStateStore({ path, logger });
  await store.load();
  assert.deepEqual(store.get(), { version: 1, schedules: {}, git: {}, cooldowns: {}, etags: {} });
  assert.deepEqual(lines, []);

  await store.update((draft) => {
    draft.cooldowns["claude:a"] = cooldown;
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reloaded = new WorkflowStateStore({ path, logger });
  await reloaded.load();
  assert.deepEqual(reloaded.get().cooldowns, { "claude:a": cooldown });
  assert.deepEqual((await readdir(join(dir, "daemon"))).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");
});

test("get() is a snapshot", async () => {
  const store = new WorkflowStateStore({ path: join(await scratch(), "state.json") });
  const snapshot = store.get();
  snapshot.cooldowns["claude:a"] = cooldown;
  assert.deepEqual(store.get().cooldowns, {});
});

test("a corrupt file starts empty, is moved aside and logged — never thrown", async () => {
  const dir = await scratch();
  const path = join(dir, "workflow-state.json");
  await writeFile(path, "{ nope", "utf8");
  const { lines, logger } = quietLogger();
  const store = new WorkflowStateStore({ path, logger });
  await store.load();
  assert.deepEqual(store.get().cooldowns, {});
  assert.ok(lines.length > 0);
  const files = await readdir(dir);
  const aside = files.find((name) => name.startsWith("workflow-state.json.corrupt-"));
  assert.ok(aside);
  assert.equal(await readFile(join(dir, aside), "utf8"), "{ nope");
});

test("bad entries are dropped by the tolerant parse, good ones kept", async () => {
  const dir = await scratch();
  const path = join(dir, "workflow-state.json");
  await writeFile(path, JSON.stringify({ version: 1, cooldowns: { "claude:a": cooldown, "claude:b": { until: "soon" } }, schedules: [] }), "utf8");
  const store = new WorkflowStateStore({ path, logger: quietLogger().logger });
  await store.load();
  assert.deepEqual(store.get().cooldowns, { "claude:a": cooldown });
  assert.deepEqual(store.get().schedules, {});
});

test("an unreadable path starts empty and logs", async () => {
  const dir = await scratch();
  const { lines, logger } = quietLogger();
  const store = new WorkflowStateStore({ path: dir /* a directory: EISDIR */, logger });
  await store.load();
  assert.deepEqual(store.get().cooldowns, {});
  assert.ok(lines.length > 0);
});

test("concurrent updates are immediately visible and all become durable", async () => {
  const path = join(await scratch(), "state.json");
  const store = new WorkflowStateStore({ path });
  const writes = [1, 2, 3, 4].map((n) => store.update((draft) => void (draft.cooldowns[`claude:${n}`] = cooldown)));
  assert.deepEqual(Object.keys(store.get().cooldowns), ["claude:1", "claude:2", "claude:3", "claude:4"]);
  await Promise.all(writes);
  const reloaded = new WorkflowStateStore({ path });
  await reloaded.load();
  assert.deepEqual(Object.keys(reloaded.get().cooldowns), ["claude:1", "claude:2", "claude:3", "claude:4"]);
});

test("a throwing mutator changes nothing; a failed write retains changes for the next write", async () => {
  const parent = join(await scratch(), "blocked");
  await writeFile(parent, "obstruction");
  const path = join(parent, "state.json");
  const store = new WorkflowStateStore({ path, logger: quietLogger().logger });
  await assert.rejects(store.update((draft) => {
    draft.cooldowns["claude:x"] = cooldown;
    throw new Error("boom");
  }), /boom/);
  assert.deepEqual(store.get().cooldowns, {});
  await assert.rejects(
    store.update((draft) => void (draft.cooldowns["claude:a"] = cooldown)),
    (error: unknown) => ["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
  assert.deepEqual(store.get().cooldowns, { "claude:a": cooldown });
  await store.flush();
  await rm(parent);
  await store.update((draft) => void (draft.cooldowns["claude:b"] = cooldown));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).cooldowns, { "claude:a": cooldown, "claude:b": cooldown });
});
