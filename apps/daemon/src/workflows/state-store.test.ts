import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowStateStore } from "./state-store.ts";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orquester-wf-state-"));
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
  const store = new WorkflowStateStore({ path: "/x", write: async () => undefined });
  const snapshot = store.get();
  snapshot.cooldowns["claude:a"] = cooldown;
  assert.deepEqual(store.get().cooldowns, {});
});

test("a corrupt file starts empty, is moved aside and logged — never thrown", async () => {
  const dir = await scratch();
  const path = join(dir, "workflow-state.json");
  await writeFile(path, "{ nope", "utf8");
  const { lines, logger } = quietLogger();
  const store = new WorkflowStateStore({ path, logger, now: () => new Date("2026-09-28T12:00:00.000Z") });
  await store.load();
  assert.deepEqual(store.get().cooldowns, {});
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^warn: workflow-state\.json is corrupt/);
  const files = await readdir(dir);
  assert.deepEqual(files, ["workflow-state.json.corrupt-2026-09-28T12-00-00-000Z"]);
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
  assert.match(lines[0]!, /could not be read \(EISDIR\)/);
});

test("updates apply at once, writes are serialized and coalesced", async () => {
  const writes: string[] = [];
  let release: (() => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  const store = new WorkflowStateStore({
    path: "/x",
    write: async (_p, content) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (writes.length === 0) await new Promise<void>((resolve) => (release = resolve));
      writes.push(content);
      inFlight--;
    }
  });
  const first = store.update((d) => void (d.cooldowns["claude:1"] = cooldown));
  assert.ok(store.get().cooldowns["claude:1"], "visible before the write lands");
  // Let the first write start (it blocks), then queue three more.
  await new Promise((resolve) => setImmediate(resolve));
  const rest = [2, 3, 4].map((n) => store.update((d) => void (d.cooldowns[`claude:${n}`] = cooldown)));
  assert.equal(rest[0], rest[2], "one queued write carries every change made while it waits");
  release!();
  await Promise.all([first, ...rest]);
  await store.flush();
  assert.equal(maxInFlight, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(writes[1]!).cooldowns), ["claude:1", "claude:2", "claude:3", "claude:4"]);
});

test("a throwing mutator changes nothing; a failed write rejects, keeps the change and the next write carries it", async () => {
  const writes: string[] = [];
  let fail = true;
  const { lines, logger } = quietLogger();
  const store = new WorkflowStateStore({
    path: "/x",
    logger,
    write: async (_p, content) => {
      if (fail) throw new Error("disk full");
      writes.push(content);
    }
  });
  await assert.rejects(
    store.update((d) => {
      d.cooldowns["claude:x"] = cooldown;
      throw new Error("boom");
    }),
    /boom/
  );
  assert.deepEqual(store.get().cooldowns, {});
  await assert.rejects(store.update((d) => void (d.cooldowns["claude:a"] = cooldown)), /disk full/);
  assert.match(lines.at(-1)!, /^error: workflow-state\.json could not be written: disk full/);
  await store.flush();
  fail = false;
  await store.update((d) => void (d.cooldowns["claude:b"] = cooldown));
  assert.deepEqual(Object.keys(JSON.parse(writes[0]!).cooldowns), ["claude:a", "claude:b"]);
});

test("the default writer writes a file the next load reads", async () => {
  const dir = await scratch();
  const path = join(dir, "workflow-state.json");
  const store = new WorkflowStateStore({ path });
  await store.update((d) => void (d.etags["https://api.github.com/x"] = { etag: "W/1", body: { a: 1 } }));
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).etags, { "https://api.github.com/x": { etag: "W/1", body: { a: 1 } } });
});
