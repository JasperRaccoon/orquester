import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { boxConfigChangesPath } from "@orquester/config";

import { BoxConfigChangeStore, BoxSyncBaselines } from "./store.ts";

test("config-changes.json keeps unknown fields, unknown states and unreadable entries on rewrite", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  const path = boxConfigChangesPath(appdir);
  await mkdir(dirname(path), { recursive: true });
  const future = { id: "f1", boxId: "b1", createdAt: "2026-10-20T00:00:00.000Z", state: "quarantined", files: [], extra: { kept: true } };
  await writeFile(path, JSON.stringify({ version: 1, newer: "field", changes: [future, { not: "a set" }] }));
  const store = new BoxConfigChangeStore(appdir);
  await store.load();
  await store.add({ id: "c1", boxId: "b1", threadId: null, createdAt: new Date().toISOString(), decidedAt: null, state: "pending", files: [] });
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.newer, "field");
  assert.deepEqual(written.changes.find((set: { id?: string }) => set.id === "f1"), future);
  assert.ok(written.changes.some((entry: { not?: string }) => entry.not === "a set"));
  assert.ok(written.changes.some((set: { id?: string }) => set.id === "c1"));
});

test("an unreadable config-changes.json is moved aside, not overwritten", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  const path = boxConfigChangesPath(appdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json");
  const store = new BoxConfigChangeStore(appdir);
  await store.load();
  assert.deepEqual(store.list(), []);
  const names = await readdir(dirname(path));
  assert.ok(names.some((name) => name.startsWith("config-changes.json.unreadable-")));
});

test("baselines round-trip and drop unreadable entries", async () => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  const baselines = new BoxSyncBaselines(appdir, 10);
  const map = await baselines.get("b1");
  map.set("/h/a", { h: "x".repeat(64), s: 3, m: 4 });
  baselines.markDirty("b1");
  await baselines.flush();
  const again = await new BoxSyncBaselines(appdir).get("b1");
  assert.deepEqual(again.get("/h/a"), { h: "x".repeat(64), s: 3, m: 4 });
  await baselines.forget("b1");
  assert.equal((await new BoxSyncBaselines(appdir).get("b1")).size, 0);
});
