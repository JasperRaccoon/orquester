// Integration: the real gdu binary (found as the daemon finds it: <appdir>/bin, PATH,
// /usr/local/bin) scans a temp dir end to end through the scan service. Skips when gdu
// is not installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { StorageNodeActions, StorageStatusResponse } from "@orquester/api";
import { storageScansDir } from "@orquester/config";

import { resolveGduBinary, runGduExport, ScanCancelledError } from "./gdu.ts";
import { StorageScanService } from "./scan-service.ts";
import type { StorageGuardPort } from "./types.ts";
import { volumeSpace } from "./volumes.ts";

const ALLOWED: StorageNodeActions = { delete: null, rename: null, download: null, confirmDelete: false };
const guard: StorageGuardPort = { actionsFor: () => ALLOWED, projectFor: () => undefined };
const asRoot = process.getuid?.() === 0;

async function fixture(t: TestContext): Promise<{ baseDir: string; root: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "storage-gdu-appdir-"));
  const root = await mkdtemp(join(tmpdir(), "storage-gdu-root-"));
  t.after(async () => {
    await chmod(join(root, "locked"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });
  await mkdir(join(root, "data", "nested"), { recursive: true });
  await writeFile(join(root, "data", "big.bin"), randomBytes(3 * 1024 * 1024));
  await link(join(root, "data", "big.bin"), join(root, "data", "nested", "same.bin"));
  await writeFile(join(root, "data", 'q"uo\nte <&> \u{1F600}.txt'), "x");
  await symlink("/etc", join(root, "link"));
  await mkdir(join(root, "locked"));
  await writeFile(join(root, "locked", "secret"), "s");
  await chmod(join(root, "locked"), 0o000);
  return { baseDir, root };
}

function duBytes(path: string): number {
  const result = spawnSync("du", ["-s", "-B1", path], { encoding: "utf8" });
  return Number(result.stdout.split("\t")[0]);
}

test("gdu scans a directory end to end: totals match du, hard links count once, unreadable dirs are flagged", async (t) => {
  const { baseDir, root } = await fixture(t);
  if (!resolveGduBinary({ baseDir })) {
    t.skip("gdu is not installed");
    return;
  }
  let finished: (status: StorageStatusResponse) => void = () => undefined;
  const idle = new Promise<StorageStatusResponse>((resolve) => (finished = resolve));
  const service = new StorageScanService({
    baseDir,
    listVolumes: async () => [{ id: root, mountPoint: root, device: "/dev/test", fsType: "ext4", totalBytes: null, usedBytes: null, freeBytes: null }],
    // The temp dir is not a whole filesystem: its disk's "used" would all read as unaccounted.
    volumeSpace: async (path) =>
      path === root ? { totalBytes: null, usedBytes: null, freeBytes: null, inodesUsed: null } : volumeSpace(path),
    publish: (_channel, _type, payload) => {
      if ((payload as StorageStatusResponse).scan.state === "idle") finished(payload as StorageStatusResponse);
    }
  });
  t.after(() => service.dispose());
  await service.start();
  const started = await service.startScan(root);
  assert.match(started.scanner.version ?? "", /^v\d+\.\d+/);
  const status = await idle;
  assert.equal(status.lastError, null);
  const summary = status.volumes[0]!.lastScan!;
  assert.equal(summary.scannerVersion, started.scanner.version);
  assert.equal(summary.scannedBytes, duBytes(root));
  // root, data, nested, big.bin, same.bin, the quoted file, link, locked (its file unseen).
  assert.equal(summary.items, asRoot ? 9 : 8);
  if (!asRoot) assert.equal(summary.unreadableDirs, 1);
  // gdu's export was removed once parsed; only the saved scan is left.
  assert.deepEqual(await readdir(storageScansDir(baseDir)), [`scan-${encodeURIComponent(root)}.json`]);

  const tree = await service.tree(root, { depth: 3, guard });
  const data = tree.root.children!.find((child) => child.name === "data")!;
  assert.equal(data.path, `${root}/data`);
  const big = data.children!.find((child) => child.name === "big.bin")!;
  assert.equal(big.apparentBytes, 3 * 1024 * 1024);
  // The second link (in nested/) costs nothing: nested is just its own block.
  const nested = data.children!.find((child) => child.name === "nested");
  assert.ok(!nested || nested.sizeBytes < 1024 * 1024);
  if (!asRoot) {
    // Kept in the saved scan though tiny, so the map can flag it when zoomed in.
    const locked = await service.tree(root, { path: `${root}/locked`, guard });
    assert.equal(locked.root.unreadable, true);
  }
});

test("an aborted gdu run rejects as cancelled", async (t) => {
  const { baseDir, root } = await fixture(t);
  const bin = resolveGduBinary({ baseDir });
  if (!bin) {
    t.skip("gdu is not installed");
    return;
  }
  const controller = new AbortController();
  const outFile = join(baseDir, "cancelled.export.json");
  const run = runGduExport({ bin, root, ignore: [], outFile, cwd: baseDir, signal: controller.signal });
  controller.abort();
  await assert.rejects(run, ScanCancelledError);
});
