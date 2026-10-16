/**
 * TodoListManager persistence: overlapping changes are written one after another through the one
 * tmp file, so none fails and the file on disk ends with every change (final review: the shared
 * `${indexPath}.tmp` race).
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TodoListManager } from "./todos.ts";

test("overlapping persists never share the tmp file: every change reaches the file, nothing fails, no tmp is left", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "todos-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = join(dir, "todos.json");
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  t.after(() => {
    console.error = original;
  });
  const todos = new TodoListManager(indexPath);
  const created = await Promise.all(Array.from({ length: 25 }, (_, i) => todos.create("project", "/w/acme/api", `T${i}`)));
  await Promise.all(created.map((record, i) => todos.update(record.id, { body: `- [x] item ${i}` })));
  assert.deepEqual(errors, [], "no write failed (a shared tmp renamed twice fails ENOENT)");
  const reloaded = new TodoListManager(indexPath);
  await reloaded.load();
  const listed = reloaded.list("project", "/w/acme/api");
  assert.equal(listed.length, 25);
  assert.ok(listed.every((record) => /^- \[x\] item \d+$/.test(record.body)), "the newest state is on disk");
  assert.deepEqual((await readdir(dir)).sort(), ["todos.json"]);
});
