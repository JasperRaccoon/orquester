import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { boxesStorePath, boxSecretsPath, type StoredBox } from "@orquester/config";

import { BoxError } from "./errors.ts";
import { BoxStore, ORPHAN_SWEEP_PAUSE_MS } from "./store.ts";

const quiet = { warn: () => undefined, error: () => undefined };

async function tempBase(t: test.TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "orq-box-store-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function record(id: string, extra: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "temporary",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "small",
    name: `orq-${id}`,
    createdAt: "2026-10-01T00:00:00.000Z",
    state: "ready",
    ...extra
  };
}

test("unknown fields, sections and unparseable records survive a rewrite", async (t) => {
  const base = await tempBase(t);
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      version: 7,
      futureTopLevel: { keep: true },
      boxes: {
        aaaaaaaaaaaa: { ...record("aaaaaaaaaaaa"), futureField: [1, 2] },
        // A newer build's record this one cannot parse (no `name`, unknown shape).
        bbbbbbbbbbbb: { id: "bbbbbbbbbbbb", state: "hibernating", weird: true }
      },
      providers: { hetzner: { status: "connected", futureSetting: "x" } }
    })
  );
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  assert.deepEqual(
    store.list().map((r) => r.id),
    ["aaaaaaaaaaaa"]
  );
  assert.deepEqual([...store.ids()].sort(), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);

  await store.update("aaaaaaaaaaaa", (next) => void (next.state = "destroyed"));
  await store.updateProviderSettings("hetzner", (settings) => void (settings.error = null));
  await store.insert(record("cccccccccccc"));

  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.version, 7);
  assert.deepEqual(written.futureTopLevel, { keep: true });
  assert.deepEqual(written.boxes.aaaaaaaaaaaa.futureField, [1, 2]);
  assert.equal(written.boxes.aaaaaaaaaaaa.state, "destroyed");
  assert.deepEqual(written.boxes.bbbbbbbbbbbb, { id: "bbbbbbbbbbbb", state: "hibernating", weird: true });
  assert.equal(written.providers.hetzner.futureSetting, "x");
  assert.ok(written.boxes.cccccccccccc, "the new record is written");
  // An unparseable record is never rewritten or removed through this build.
  assert.equal(await store.update("bbbbbbbbbbbb", (next) => void (next.state = "ready")), undefined);
  await store.remove(["bbbbbbbbbbbb"]);
  assert.ok(JSON.parse(await readFile(file, "utf8")).boxes.bbbbbbbbbbbb, "kept");
});

test("a corrupt boxes.json is moved aside, never written over", async (t) => {
  const base = await tempBase(t);
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "{ not json");
  const warnings: string[] = [];
  const store = new BoxStore({ baseDir: base, logger: { warn: (line: string) => warnings.push(line), error: () => undefined } });
  await store.load();
  assert.equal(store.list().length, 0);
  const aside = (await readdir(dirname(file))).filter((name) => name.startsWith("boxes.json.corrupt-"));
  assert.equal(aside.length, 1, "moved aside");
  assert.equal(await readFile(join(dirname(file), aside[0]!), "utf8"), "{ not json");
  assert.match(warnings.join("\n"), /moved it to/);
  await store.insert(record("dddddddddddd"));
  assert.ok(JSON.parse(await readFile(file, "utf8")).boxes.dddddddddddd);
});

test("a moved-aside boxes.json keeps its installation id and pauses the orphan sweep for a day", async (t) => {
  const base = await tempBase(t);
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  // Cut off mid-write: not JSON, but the id is still readable.
  await writeFile(file, '{"version":1,"installationId":"0badc0de","boxes":{"aaaaaaaaaaaa":{"id":"aaa');
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const store = new BoxStore({ baseDir: base, logger: quiet, now: () => now });
  await store.load();
  assert.equal(store.installationId(), "0badc0de");
  assert.equal(store.orphanSweepPausedUntil(), now + ORPHAN_SWEEP_PAUSE_MS);
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.installationId, "0badc0de");
  assert.equal(written.orphanSweepPausedUntil, new Date(now + ORPHAN_SWEEP_PAUSE_MS).toISOString());

  // It survives a restart, and ends on its own.
  const later = new BoxStore({ baseDir: base, logger: quiet, now: () => now + ORPHAN_SWEEP_PAUSE_MS - 1 });
  await later.load();
  assert.equal(later.orphanSweepPausedUntil(), now + ORPHAN_SWEEP_PAUSE_MS);
  const after = new BoxStore({ baseDir: base, logger: quiet, now: () => now + ORPHAN_SWEEP_PAUSE_MS });
  await after.load();
  assert.equal(after.orphanSweepPausedUntil(), null);
});

test("the installation id is made once, with the first box, and kept for records from before it", async (t) => {
  const base = await tempBase(t);
  const file = boxesStorePath(base);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, boxes: { aaaaaaaaaaaa: record("aaaaaaaaaaaa") } }));
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  assert.equal(store.installationId(), null, "an older build's store has none");
  assert.equal(store.orphanSweepPausedUntil(), null);
  const id = await store.ensureInstallationId();
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(await store.ensureInstallationId(), id);
  const reloaded = new BoxStore({ baseDir: base, logger: quiet });
  await reloaded.load();
  assert.equal(reloaded.installationId(), id);
  assert.ok(reloaded.get("aaaaaaaaaaaa"), "the older record is kept");
});

test("writes are fsynced: the file before the rename, its directory after", async (t) => {
  const base = await tempBase(t);
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  await store.insert(record("aaaaaaaaaaaa"));
  const probe = await open(boxesStorePath(base), "r");
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const sync = t.mock.method(proto, "sync");
  await store.update("aaaaaaaaaaaa", (next) => void (next.state = "destroyed"));
  assert.ok(sync.mock.callCount() >= 2, `synced ${sync.mock.callCount()} times`);
});

test("a boxes.json that cannot be read blocks every change", async (t) => {
  const base = await tempBase(t);
  // A directory where the file should be: reading fails with EISDIR, not ENOENT.
  await mkdir(boxesStorePath(base), { recursive: true });
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  assert.ok(store.blockedReason);
  await assert.rejects(store.insert(record("eeeeeeeeeeee")), (error: unknown) => error instanceof BoxError && error.status === 503);
  assert.ok((await stat(boxesStorePath(base))).isDirectory(), "left as it was");
});

test("box-secrets.json is written 0600 and secrets read back only through the store", async (t) => {
  const base = await tempBase(t);
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  await store.setProviderCredentials("hetzner", { apiKey: "secret-value-1234" });
  await store.setTailscale({ apiToken: "tskey-api-abcdefgh" });
  await store.setWindowsPassword("ffffffffffff", "P@ssw0rd-long-enough");
  const file = boxSecretsPath(base);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reloaded = new BoxStore({ baseDir: base, logger: quiet });
  await reloaded.load();
  assert.deepEqual(reloaded.providerCredentials("hetzner"), { apiKey: "secret-value-1234" });
  assert.deepEqual(reloaded.tailscale(), { apiToken: "tskey-api-abcdefgh" });
  assert.equal(reloaded.windowsPassword("ffffffffffff"), "P@ssw0rd-long-enough");
  await reloaded.setProviderCredentials("hetzner", null);
  assert.equal(reloaded.providerCredentials("hetzner"), null);
});

test("a failed write leaves memory unchanged", async (t) => {
  const base = await tempBase(t);
  const store = new BoxStore({ baseDir: base, logger: quiet });
  await store.load();
  await store.insert(record("aaaaaaaaaaaa"));
  // Replace the file with a directory: the atomic rename onto it fails.
  await rm(boxesStorePath(base));
  await mkdir(join(boxesStorePath(base), "x"), { recursive: true });
  await assert.rejects(store.update("aaaaaaaaaaaa", (next) => void (next.state = "destroyed")));
  assert.equal(store.get("aaaaaaaaaaaa")?.state, "ready");
});
