import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { StorageNodeActions, StorageStatusResponse } from "@orquester/api";
import { STORAGE_CHANGED_EVENT, STORAGE_EVENTS_CHANNEL } from "@orquester/api";
import { storageScansDir } from "@orquester/config";

import { parseGduExport, type ParsedScan } from "./export-parser.ts";
import { ScanCancelledError } from "./gdu.ts";
import { StorageScanService, type ScannerRun } from "./scan-service.ts";
import { encodeSavedScan, scanFileName } from "./store.ts";
import type { StorageGuardPort } from "./types.ts";
import type { VolumeInfo, VolumeSpace } from "./volumes.ts";

const GB = 1_000_000_000;
const ALLOWED: StorageNodeActions = { delete: null, rename: null, download: null, confirmDelete: false };
const guard: StorageGuardPort = { actionsFor: () => ALLOWED, projectFor: () => undefined };

function volume(id: string, usedBytes = 700 * GB): VolumeInfo {
  return { id, mountPoint: id, device: `/dev/${id.length}`, fsType: "ext4", totalBytes: 1000 * GB, usedBytes, freeBytes: 300 * GB };
}

// What gdu would export for `root`: /var/lib/blob (50 MB), /var/log.txt (9 MB), /swap (20 MB).
function exportOf(root: string): string {
  return `[1,2,{"progname":"gdu","progver":"v5.39.0"},
[{"name":${JSON.stringify(root)},"asize":79000000,"dsize":79020032},
[{"name":"var","asize":59000000,"dsize":59015168},
[{"name":"lib","asize":50000000,"dsize":50008064},{"name":"blob","asize":50000000,"dsize":50003968}],
{"name":"log.txt","asize":9000000,"dsize":9003008}],
{"name":"swap","asize":20000000,"dsize":20000768}]]`;
}

const SCANNED = 4096 * 3 + 50003968 + 9003008 + 20000768;

function parsed(root: string): Promise<ParsedScan> {
  return parseGduExport([Buffer.from(exportOf(root))], { minKeepBytes: 1024 * 1024 });
}

interface PendingRun {
  run: ScannerRun;
  resolve: (scan: ParsedScan) => void;
  reject: (error: Error) => void;
}

async function harness(
  t: TestContext,
  options: { volumes?: VolumeInfo[]; workDirFree?: number; usedAfter?: number; baseDir?: string } = {}
) {
  const baseDir = options.baseDir ?? (await mkdtemp(join(tmpdir(), "storage-service-")));
  if (!options.baseDir) t.after(() => rm(baseDir, { recursive: true, force: true }));
  const volumes = options.volumes ?? [volume("/"), volume("/data")];
  const runs: PendingRun[] = [];
  const runWaiters: Array<(run: PendingRun) => void> = [];
  const events: StorageStatusResponse[] = [];
  const eventWaiters: Array<{ match: (status: StorageStatusResponse) => boolean; resolve: (status: StorageStatusResponse) => void }> = [];
  const service = new StorageScanService({
    baseDir,
    supported: true,
    listVolumes: async () => volumes,
    volumeSpace: async (path): Promise<VolumeSpace> =>
      path === storageScansDir(baseDir)
        ? { totalBytes: 1000 * GB, usedBytes: 0, freeBytes: options.workDirFree ?? 100 * GB, inodesUsed: null }
        : { totalBytes: 1000 * GB, usedBytes: options.usedAfter ?? SCANNED + 5 * GB, freeBytes: 0, inodesUsed: 1_000_000 },
    locateScanner: async () => ({ path: "/usr/local/bin/gdu", version: "v5.39.0" }),
    runScanner: (run) =>
      new Promise<ParsedScan>((resolve, reject) => {
        run.signal.addEventListener("abort", () => reject(new ScanCancelledError()), { once: true });
        const pending = { run, resolve, reject };
        runs.push(pending);
        runWaiters.shift()?.(pending);
      }),
    publish: (channel, type, payload) => {
      assert.equal(channel, STORAGE_EVENTS_CHANNEL);
      assert.equal(type, STORAGE_CHANGED_EVENT);
      const status = payload as StorageStatusResponse;
      events.push(status);
      for (const waiter of [...eventWaiters]) {
        if (waiter.match(status)) {
          eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
          waiter.resolve(status);
        }
      }
    }
  });
  t.after(() => service.dispose());
  await service.start();
  return {
    baseDir,
    service,
    runs,
    events,
    nextRun: () => new Promise<PendingRun>((resolve) => runWaiters.push(resolve)),
    nextEvent: (match: (status: StorageStatusResponse) => boolean) =>
      new Promise<StorageStatusResponse>((resolve) => eventWaiters.push({ match, resolve }))
  };
}

const idle = (status: StorageStatusResponse) => status.scan.state === "idle";

test("a manual scan runs in the background, then its saved tree survives a restart", async (t) => {
  const h = await harness(t);
  const nextRun = h.nextRun();
  const started = await h.service.startScan("/");
  assert.deepEqual(started.scan, {
    state: "scanning",
    volume: "/",
    trigger: "manual",
    startedAt: (started.scan as { startedAt: string }).startedAt,
    expectedDurationMs: null,
    queued: []
  });
  const pending = await nextRun;
  // Other volumes below this one and the scans dir stay out of the scan; the keep threshold follows the disk.
  assert.deepEqual(pending.run.ignore, ["/data", storageScansDir(h.baseDir)]);
  assert.equal(pending.run.minKeepBytes, 1_400_000);
  const finished = h.nextEvent(idle);
  pending.resolve(await parsed("/"));
  const status = await finished;
  const summary = status.volumes.find((entry) => entry.id === "/")!.lastScan!;
  assert.deepEqual(
    [summary.trigger, summary.scannerVersion, summary.scannedBytes, summary.items, summary.unaccountedBytes],
    ["manual", "v5.39.0", SCANNED, 6, 5 * GB]
  );
  assert.equal(status.volumes.find((entry) => entry.id === "/data")!.lastScan, null);
  assert.deepEqual(await readdir(storageScansDir(h.baseDir)), [scanFileName("/")]);

  await h.service.dispose();
  const again = await harness(t, { baseDir: h.baseDir });
  const tree = await again.service.tree("/", { path: "/var", depth: 2, guard });
  assert.deepEqual(
    tree.root.children!.map((child) => [child.path, child.sizeBytes]),
    [
      ["/var/lib", 50003968 + 4096],
      ["/var/log.txt", 9003008]
    ]
  );
  assert.deepEqual(tree.scan, summary);
});

test("one scan at a time: a second start is refused until the first is cancelled, which leaves no error", async (t) => {
  const h = await harness(t);
  const nextRun = h.nextRun();
  await h.service.startScan("/");
  const pending = await nextRun;
  await assert.rejects(h.service.startScan("/data"), { code: "STORAGE_SCAN_RUNNING", status: 409 });
  const status = await h.service.cancelScan();
  assert.equal(pending.run.signal.aborted, true);
  assert.deepEqual([status.scan, status.lastError], [{ state: "idle" }, null]);
  assert.equal(status.volumes[0]!.lastScan, null);
  const restarted = h.nextRun();
  await h.service.startScan("/data");
  assert.equal((await restarted).run.volume.id, "/data");
});

test("a failed scan is the last error until that volume scans successfully", async (t) => {
  const h = await harness(t);
  let nextRun = h.nextRun();
  await h.service.startScan("/");
  let finished = h.nextEvent(idle);
  (await nextRun).reject(new Error("gdu exited with code 1: open /x: no space left on device"));
  const failed = await finished;
  assert.equal(failed.lastError?.volume, "/");
  assert.match(failed.lastError!.message, /no space left/);

  nextRun = h.nextRun();
  await h.service.startScan("/");
  finished = h.nextEvent(idle);
  (await nextRun).resolve(await parsed("/"));
  assert.equal((await finished).lastError, null);
});

test("a scan does not start when the export would not fit on the disk", async (t) => {
  const h = await harness(t, { workDirFree: 100 * 1024 * 1024 });
  await assert.rejects(h.service.startScan("/"), (error: Error & { code?: string }) => {
    assert.equal(error.code, "STORAGE_ERROR");
    assert.match(error.message, /Not enough free disk space/);
    return true;
  });
  assert.equal(h.runs.length, 0);
  assert.deepEqual((await h.service.status()).scan, { state: "idle" });
});

test("a corrupt saved scan loads as no scan, and a stale export is removed", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "storage-service-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const dir = storageScansDir(baseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, scanFileName("/")), '{"format":"orquester.storage-scan","version":1,"volume":"/","root":[');
  await writeFile(join(dir, scanFileName("/data")), JSON.stringify({ format: "orquester.storage-scan", version: 99 }));
  await writeFile(join(dir, "0b1c.export.json"), "[1,2,");
  const h = await harness(t, { baseDir });
  const status = await h.service.status();
  assert.deepEqual(
    status.volumes.map((entry) => entry.lastScan),
    [null, null]
  );
  await assert.rejects(h.service.tree("/", { guard }), { code: "STORAGE_NO_SCAN", status: 404 });
  await assert.rejects(h.service.tree("/nope", { guard }), { code: "STORAGE_UNKNOWN_VOLUME", status: 404 });
  assert.deepEqual((await readdir(dir)).sort(), [scanFileName("/"), scanFileName("/data")].sort());
});

test("the nightly run at 04:00 scans each volume in turn, skipping one scanned in the last 20 hours", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 10, 13, 12, 0, 0).getTime() });
  const baseDir = await mkdtemp(join(tmpdir(), "storage-service-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  // /data was scanned at 10:00 today: 18 h before tonight's run.
  const recent = await parsed("/data");
  await mkdir(storageScansDir(baseDir), { recursive: true });
  await writeFile(
    join(storageScansDir(baseDir), scanFileName("/data")),
    encodeSavedScan({
      volume: "/data",
      root: recent.root,
      summary: {
        startedAt: new Date(2026, 10, 13, 9, 50).toISOString(),
        finishedAt: new Date(2026, 10, 13, 10, 0).toISOString(),
        durationMs: 600_000,
        trigger: "manual",
        scannerVersion: "v5.39.0",
        scannedBytes: recent.root.size,
        apparentBytes: recent.root.apparent,
        items: recent.root.items,
        unreadableDirs: 0,
        usedBytesAtScan: recent.root.size,
        unaccountedBytes: 0
      }
    })
  );
  const h = await harness(t, { baseDir, volumes: [volume("/"), volume("/data"), volume("/srv")] });
  assert.equal((await h.service.status()).nextScheduledAt, new Date(2026, 10, 14, 4, 0, 0).toISOString());

  let nextRun = h.nextRun();
  t.mock.timers.tick(16 * 60 * 60 * 1000 - 1);
  assert.equal(h.runs.length, 0);
  t.mock.timers.tick(1);
  let pending = await nextRun;
  assert.equal(pending.run.volume.id, "/");
  const status = await h.service.status();
  assert.deepEqual(
    [status.scan.state, (status.scan as { trigger: string }).trigger, (status.scan as { queued: string[] }).queued],
    ["scanning", "schedule", ["/srv"]]
  );
  assert.equal(status.nextScheduledAt, new Date(2026, 10, 15, 4, 0, 0).toISOString());

  nextRun = h.nextRun();
  pending.resolve(await parsed("/"));
  pending = await nextRun;
  assert.equal(pending.run.volume.id, "/srv");
  const finished = h.nextEvent(idle);
  pending.resolve(await parsed("/srv"));
  const done = await finished;
  assert.deepEqual(
    done.volumes.map((entry) => [entry.id, entry.lastScan?.trigger]),
    [
      ["/", "schedule"],
      ["/data", "manual"],
      ["/srv", "schedule"]
    ]
  );
});

test("deletes and renames update the saved tree, its file and its watchers; one made mid-scan is replayed", async (t) => {
  const h = await harness(t);
  let nextRun = h.nextRun();
  await h.service.startScan("/");
  let finished = h.nextEvent(idle);
  (await nextRun).resolve(await parsed("/"));
  await finished;

  assert.equal(h.service.sizeOf("/var/lib/blob"), 50003968);
  assert.equal(h.service.sizeOf("/var/lib/missing"), 0);
  const changed = h.nextEvent(() => true);
  await h.service.applyDelete("/var/lib/blob");
  const afterDelete = await changed;
  const summary = afterDelete.volumes[0]!.lastScan!;
  assert.deepEqual(
    [summary.scannedBytes, summary.items, summary.unaccountedBytes],
    [SCANNED - 50003968, 5, 5 * GB]
  );
  await h.service.applyRename("/var", "/var2");
  const tree = await h.service.tree("/", { depth: 3, guard });
  const var2 = tree.root.children!.find((child) => child.name === "var2")!;
  assert.equal(var2.sizeBytes, 4096 * 2 + 9003008);
  assert.deepEqual(
    var2.children!.map((child) => child.path),
    ["/var2/log.txt", "/var2/lib"]
  );
  assert.equal(h.service.sizeOf("/var/log.txt"), 0);
  assert.equal(h.service.sizeOf("/var2/log.txt"), 9003008);

  // A restart sees the edited tree.
  await h.service.dispose();
  const again = await harness(t, { baseDir: h.baseDir });
  assert.equal(again.service.sizeOf("/var2/log.txt"), 9003008);
  assert.equal(again.service.sizeOf("/var2/lib/blob"), 0);

  // gdu may already have walked a path deleted while it runs: the result is corrected.
  nextRun = again.nextRun();
  await again.service.startScan("/");
  const pending = await nextRun;
  await again.service.applyDelete("/swap");
  finished = again.nextEvent(idle);
  pending.resolve(await parsed("/"));
  await finished;
  assert.equal(again.service.sizeOf("/swap"), 0);
  assert.equal(again.service.sizeOf("/var/lib/blob"), 50003968);
});

test("a delete made mid-scan, before the used space is read, leaves used and unaccounted as the disk reports them", async (t) => {
  // The disk's used space, read once gdu is done, no longer holds /var/lib/blob.
  const usedAfter = SCANNED - 50003968 + 5 * GB;
  const h = await harness(t, { usedAfter });
  const nextRun = h.nextRun();
  await h.service.startScan("/");
  const pending = await nextRun;
  await h.service.applyDelete("/var/lib/blob");
  const finished = h.nextEvent(idle);
  pending.resolve(await parsed("/"));
  const summary = (await finished).volumes.find((entry) => entry.id === "/")!.lastScan!;
  assert.deepEqual(
    [summary.scannedBytes, summary.usedBytesAtScan, summary.unaccountedBytes],
    [SCANNED - 50003968, usedAfter, 5 * GB]
  );
});
