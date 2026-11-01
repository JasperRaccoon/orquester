import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HostRegistryUnreadableError, readHostRegistry, writeHostRegistry } from "./host-registry.ts";

// Host updates (spec 2026-11-01 P2.2): the registry is tolerant like every persisted store — a
// rewrite by this daemon keeps what a newer one recorded.

test("a rewrite keeps unknown fields, and entries it cannot parse, as they were", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-host-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "daemon", "agent-hosts.json");
  assert.equal(await readHostRegistry(path), null, "no file: the single-host layout");

  const future = { generation: 7, role: "draining", note: "a newer daemon's role" };
  await writeFile(
    join(dir, "agent-hosts.json"),
    JSON.stringify({
      version: 3,
      hosts: [{ generation: 0, role: "retiring", ownedThreadIds: ["t-1"], futureField: { x: 1 } }, future, "garbage"]
    })
  );
  const registry = await readHostRegistry(join(dir, "agent-hosts.json"));
  assert.deepEqual(registry?.entries.map((entry) => entry.generation), [0], "only what it understands is live");

  await writeHostRegistry(path, {
    ...registry!,
    entries: registry!.entries.map((entry) => ({ ...entry, ownedThreadIds: [] }))
  });
  const written = JSON.parse(await readFile(path, "utf8")) as { version: number; hosts: unknown[] };
  assert.equal(written.version, 3);
  assert.deepEqual(written.hosts, [
    { generation: 0, role: "retiring", ownedThreadIds: [], futureField: { x: 1 } },
    future,
    "garbage"
  ]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a file that is not a registry is unreadable, not missing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-host-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "agent-hosts.json");
  await writeFile(path, "{ not json");
  await assert.rejects(readHostRegistry(path), HostRegistryUnreadableError);
});
