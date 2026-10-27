import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { boxConfigChangesPath } from "@orquester/config";

import { BoxConfigChangeStore, BoxSyncBaselines } from "./store.ts";

test("config-changes.json keeps unknown fields, unknown states and unreadable entries on rewrite", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const path = boxConfigChangesPath(appdir);
  await mkdir(dirname(path), { recursive: true });
  const future = { id: "f1", boxId: "b1", createdAt: "2000-01-01T00:00:00.000Z", state: "quarantined", files: [], extra: { kept: true } };
  const oldDecided = ["approved", "denied", "stale"].map((state) => ({
    id: state, boxId: "b1", createdAt: "2000-01-01T00:00:00.000Z", decidedAt: "2000-01-01T00:00:00.000Z", state, files: []
  }));
  await writeFile(path, JSON.stringify({ version: 1, newer: "field", changes: [future, ...oldDecided, { not: "a set" }] }));
  const store = new BoxConfigChangeStore(appdir, () => new Date("2026-10-20T00:00:00.000Z"));
  await store.load();
  await store.add({ id: "c1", boxId: "b1", threadId: null, createdAt: "2026-10-20T00:00:00.000Z", decidedAt: null, state: "pending", files: [] });
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.newer, "field");
  assert.deepEqual(written.changes.find((set: { id?: string }) => set.id === "f1"), future);
  assert.ok(written.changes.some((entry: { not?: string }) => entry.not === "a set"));
  assert.ok(written.changes.some((set: { id?: string }) => set.id === "c1"));
  assert.equal(written.changes.some((set: { id?: string }) => oldDecided.some((old) => old.id === set.id)), false, "known decided records still expire");
});

test("an unreadable config-changes.json is moved aside, not overwritten", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const path = boxConfigChangesPath(appdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{ not json");
  const store = new BoxConfigChangeStore(appdir);
  await store.load();
  assert.deepEqual(store.list(), []);
  const names = await readdir(dirname(path));
  const backup = names.find((name) => name.startsWith("config-changes.json.unreadable-"));
  assert.ok(backup);
  assert.equal(await readFile(join(dirname(path), backup), "utf8"), "{ not json");
});

test("baselines survive a fresh store and disappear when their box is forgotten", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-sync-store-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
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
