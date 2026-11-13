// Integration: the real gdu binary (found as the daemon finds it: <appdir>/bin, PATH,
// /usr/local/bin) scans a temp dir end to end through the scan service. Skips when gdu
// is not installed.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { StorageNodeActions, StorageStatusResponse } from "@orquester/api";
import { appBinDir, storageScansDir } from "@orquester/config";

import { GduProbe, resolveGduBinary, runGduExport, ScanCancelledError } from "./gdu.ts";
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
      const status = payload as StorageStatusResponse;
      // The first idle status is the one published once the (no) saved scans are loaded.
      if (status.scan.state === "idle" && (status.volumes[0]?.lastScan || status.lastError)) finished(status);
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

test("a gdu --version that failed is asked again instead of reading as not installed", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "storage-gdu-appdir-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  // Fails the first time it is asked, answers after that (the binary itself is unchanged).
  const asked = join(baseDir, "asked");
  await mkdir(appBinDir(baseDir), { recursive: true });
  await writeFile(
    join(appBinDir(baseDir), "gdu"),
    `#!/bin/sh\nif [ -e '${asked}' ]; then printf 'Version:\\t v5.39.0\\n'; exit 0; fi\n: > '${asked}'\nexit 1\n`,
    { mode: 0o755 }
  );
  const probe = new GduProbe({ baseDir });
  assert.equal((await probe.locate())?.version, null);
  assert.equal((await probe.locate())?.version, "v5.39.0");
});

test("a gdu a dead daemon left running is killed when the next daemon starts", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "storage-gdu-appdir-"));
  const root = await mkdtemp(join(tmpdir(), "storage-gdu-root-"));
  const tools = await mkdtemp(join(tmpdir(), "storage-gdu-tools-"));
  t.after(async () => {
    for (const dir of [baseDir, root, tools]) await rm(dir, { recursive: true, force: true });
  });
  // A stand-in gdu that says when it runs, then runs until killed.
  const running = join(tools, "running");
  assert.equal(spawnSync("mkfifo", [running]).status, 0);
  const fake = join(tools, "gdu");
  await writeFile(fake, `#!/bin/sh\necho running > '${running}'\nexec sleep infinity\n`, { mode: 0o755 });
  const options = {
    baseDir,
    supported: true,
    listVolumes: async () => [{ id: root, mountPoint: root, device: "/dev/test", fsType: "ext4", totalBytes: null, usedBytes: null, freeBytes: null }],
    volumeSpace,
    locateScanner: async () => ({ path: fake, version: "v5.39.0" })
  };
  let ended: (status: StorageStatusResponse) => void = () => undefined;
  const scanEnded = new Promise<StorageStatusResponse>((resolve) => (ended = resolve));
  const crashed = new StorageScanService({
    ...options,
    publish: (_channel, _type, payload) => {
      const status = payload as StorageStatusResponse;
      if (status.scan.state === "idle" && status.lastError) ended(status);
    }
  });
  t.after(() => crashed.dispose());
  await crashed.start();
  const gduRunning = readFile(running, "utf8");
  await crashed.startScan(root);
  await gduRunning;

  // The first daemon never stopped its scan (as after a SIGKILL); the next one starts.
  const next = new StorageScanService(options);
  t.after(() => next.dispose());
  await next.start();
  assert.match((await scanEnded).lastError?.message ?? "", /killed by SIGKILL/);
  assert.deepEqual(await readdir(storageScansDir(baseDir)), []);
});
