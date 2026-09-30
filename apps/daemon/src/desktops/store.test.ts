import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopRecordSchema } from "@orquester/config";
import { DesktopStore } from "./store.ts";

const quiet = { warn: () => {}, error: () => {} };

async function tempFile(t: any): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "desktops.json") };
}

const desktop = (id: string) =>
  desktopRecordSchema.parse({ id, projectPath: "/w/p", createdAt: "2026-09-30T00:00:00.000Z" });

test("a missing file is an empty index that loaded cleanly; writes are 0600", async (t) => {
  const { file } = await tempFile(t);
  const store = new DesktopStore({ file, logger: quiet });
  const loaded = await store.load();
  assert.equal(store.loaded, true);
  assert.equal(store.readOnlyReason, null);
  assert.deepEqual(loaded.desktops, []);
  store.setSnapshot(() => ({ desktops: [desktop("d1")], recent: {} }));
  await store.persist();
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(
    JSON.parse(await readFile(file, "utf8")).desktops.map((d: { id: string }) => d.id),
    ["d1"]
  );
});

test("rejected records and unknown keys are written back verbatim", async (t) => {
  const { file } = await tempFile(t);
  const bad = { id: 42, projectPath: null };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      future: { keep: true },
      desktops: [{ id: "d1", projectPath: "/w/p", createdAt: "x", extraField: "kept" }, bad],
      recent: {}
    })
  );
  const store = new DesktopStore({ file, logger: quiet });
  const loaded = await store.load();
  assert.equal(store.loaded, true);
  assert.deepEqual(loaded.desktops.map((d) => d.id), ["d1"]);
  store.setSnapshot(() => ({ desktops: loaded.desktops, recent: loaded.recent }));
  await store.persist();
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written.future, { keep: true });
  assert.equal(written.desktops[0].extraField, "kept");
  assert.deepEqual(written.desktops[1], bad);
});

test("an outer-shape failure is quarantined and the store goes read-only", async (t) => {
  const { dir, file } = await tempFile(t);
  await writeFile(file, JSON.stringify({ version: 2, desktops: [] }));
  const store = new DesktopStore({ file, logger: quiet });
  await store.load();
  assert.equal(store.loaded, false);
  assert.match(store.readOnlyReason ?? "", /corrupt/);
  const names = await readdir(dir);
  assert.ok(names.some((name) => name.startsWith("desktops.json.corrupt-")), names.join(","));
  assert.ok(!names.includes("desktops.json"));
  // Nothing is written while read-only.
  store.setSnapshot(() => ({ desktops: [desktop("d1")], recent: {} }));
  await store.persist();
  assert.ok(!(await readdir(dir)).includes("desktops.json"));
});

test("unparseable JSON is quarantined too", async (t) => {
  const { dir, file } = await tempFile(t);
  await writeFile(file, "{ not json");
  const store = new DesktopStore({ file, logger: quiet });
  await store.load();
  assert.equal(store.loaded, false);
  assert.ok((await readdir(dir)).some((name) => name.startsWith("desktops.json.corrupt-")));
});

test("an unreadable file is left alone: read-only, not loaded", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads anything");
  const { file } = await tempFile(t);
  await writeFile(file, JSON.stringify({ version: 1, desktops: [] }));
  await chmod(file, 0o000);
  const store = new DesktopStore({ file, logger: quiet });
  await store.load();
  assert.equal(store.loaded, false);
  assert.match(store.readOnlyReason ?? "", /could not be read/);
  store.setSnapshot(() => ({ desktops: [desktop("d1")], recent: {} }));
  await store.persist();
  await chmod(file, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).desktops, []);
});

test("chained writes land in order: the last snapshot wins", async (t) => {
  const { file } = await tempFile(t);
  const store = new DesktopStore({ file, logger: quiet });
  await store.load();
  let current = [desktop("a")];
  store.setSnapshot(() => ({ desktops: current, recent: {} }));
  const first = store.persist();
  current = [desktop("a"), desktop("b")];
  const second = store.persist();
  await Promise.all([first, second]);
  assert.deepEqual(
    JSON.parse(await readFile(file, "utf8")).desktops.map((d: { id: string }) => d.id),
    ["a", "b"]
  );
});
