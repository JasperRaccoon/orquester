// Route-level coverage for the storage status, scan and tree routes through Fastify inject:
// the `{ code, message }` refusals, request validation, and the guard's annotations on the
// tree. The service is the real one with a fake scanner; nothing runs gdu.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions } from "fastify";
import { storageRoutes, type StorageNodeActions, type StorageStatusResponse, type StorageTreeResponse } from "@orquester/api";

import { parseGduExport, type ParsedScan } from "./export-parser.ts";
import { ScanCancelledError } from "./gdu.ts";
import { registerStorageRoutes } from "./routes.ts";
import { StorageScanService } from "./scan-service.ts";
import type { StorageGuardPort } from "./types.ts";

const EXPORT = `[1,2,{"progname":"gdu","progver":"v5.39.0"},
[{"name":"/","asize":3000000,"dsize":3008192},
[{"name":"var","asize":3000000,"dsize":3004096},{"name":"cache.db","asize":3000000,"dsize":3000000}]]]`;

const REFUSED: StorageNodeActions = { delete: "This is a system directory.", rename: "This is a system directory.", download: null, confirmDelete: true };
const ALLOWED: StorageNodeActions = { delete: null, rename: null, download: null, confirmDelete: true };
const guard: StorageGuardPort = {
  actionsFor: (path) => (path === "/" || path === "/var" ? REFUSED : ALLOWED),
  projectFor: () => undefined
};

async function harness(t: TestContext, options: { supported?: boolean; scanner?: boolean } = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), "storage-routes-"));
  let finish: ((scan: ParsedScan) => void) | null = null;
  let started: () => void = () => undefined;
  const scanStarted = new Promise<void>((resolve) => (started = resolve));
  let changed: (status: StorageStatusResponse) => void = () => undefined;
  const service = new StorageScanService({
    baseDir,
    supported: options.supported ?? true,
    listVolumes: async () => [
      { id: "/", mountPoint: "/", device: "/dev/md2", fsType: "ext4", totalBytes: 100_000_000, usedBytes: 4_000_000, freeBytes: 96_000_000 }
    ],
    volumeSpace: async () => ({ totalBytes: 100_000_000_000, usedBytes: 4_000_000, freeBytes: 96_000_000_000, inodesUsed: 10 }),
    locateScanner: async () => (options.scanner === false ? null : { path: "/usr/local/bin/gdu", version: "v5.39.0" }),
    runScanner: (run) =>
      new Promise<ParsedScan>((resolve, reject) => {
        run.signal.addEventListener("abort", () => reject(new ScanCancelledError()), { once: true });
        finish = resolve;
        started();
      }),
    publish: (_channel, _type, payload) => changed(payload as StorageStatusResponse)
  });
  await service.start();
  const app = Fastify();
  registerStorageRoutes(app, { service, guard });
  t.after(async () => {
    await app.close();
    await service.dispose();
    await rm(baseDir, { recursive: true, force: true });
  });
  return {
    app,
    scanStarted,
    finishScan: async () => {
      const idle = new Promise<void>((resolve) => {
        changed = (status) => {
          if (status.scan.state === "idle") resolve();
        };
      });
      finish!(await parseGduExport([Buffer.from(EXPORT)], { minKeepBytes: 1 }));
      await idle;
    }
  };
}

test("off Linux the status says unsupported and every other route answers 501", async (t) => {
  const { app } = await harness(t, { supported: false });
  const status = await app.inject({ method: "GET", url: storageRoutes.status });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json<StorageStatusResponse>().supported, false);
  for (const request of [
    { method: "POST" as const, url: storageRoutes.scan, payload: { volume: "/" } },
    { method: "DELETE" as const, url: storageRoutes.scan },
    { method: "GET" as const, url: `${storageRoutes.tree}?volume=/` }
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 501, `${request.method} ${request.url}`);
    assert.equal(response.json().code, "STORAGE_UNSUPPORTED");
  }
});

test("without gdu a scan is refused as scanner missing", async (t) => {
  const { app } = await harness(t, { scanner: false });
  const status = (await app.inject({ method: "GET", url: storageRoutes.status })).json<StorageStatusResponse>();
  assert.deepEqual(status.scanner, { installed: false, version: null, path: null });
  const response = await app.inject({ method: "POST", url: storageRoutes.scan, payload: { volume: "/" } });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().code, "STORAGE_SCANNER_MISSING");
});

test("bad requests are 400 and an unknown volume or unscanned volume 404", async (t) => {
  const { app } = await harness(t);
  const cases: Array<[InjectOptions, number, string]> = [
    [{ method: "POST", url: storageRoutes.scan, payload: {} }, 400, "INVALID_REQUEST"],
    [{ method: "POST", url: storageRoutes.scan, payload: { volume: "/nope" } }, 404, "STORAGE_UNKNOWN_VOLUME"],
    [{ method: "GET", url: storageRoutes.tree }, 400, "INVALID_REQUEST"],
    [{ method: "GET", url: `${storageRoutes.tree}?volume=/&depth=deep` }, 400, "INVALID_REQUEST"],
    [{ method: "GET", url: `${storageRoutes.tree}?volume=/&path=var` }, 400, "INVALID_REQUEST"],
    [{ method: "GET", url: `${storageRoutes.tree}?volume=/nope` }, 404, "STORAGE_UNKNOWN_VOLUME"],
    [{ method: "GET", url: `${storageRoutes.tree}?volume=/` }, 404, "STORAGE_NO_SCAN"]
  ];
  for (const [request, statusCode, code] of cases) {
    const response = await app.inject(request);
    assert.deepEqual([response.statusCode, response.json().code], [statusCode, code], JSON.stringify(request));
    assert.equal(typeof response.json().message, "string");
  }
});

test("scan, refuse a second, then read the tree with the guard's annotations", async (t) => {
  const h = await harness(t);
  const started = await h.app.inject({ method: "POST", url: storageRoutes.scan, payload: { volume: "/" } });
  assert.equal(started.statusCode, 200);
  assert.equal(started.json<StorageStatusResponse>().scan.state, "scanning");
  await h.scanStarted;
  const second = await h.app.inject({ method: "POST", url: storageRoutes.scan, payload: { volume: "/" } });
  assert.deepEqual([second.statusCode, second.json().code], [409, "STORAGE_SCAN_RUNNING"]);
  await h.finishScan();

  const response = await h.app.inject({ method: "GET", url: `${storageRoutes.tree}?volume=/&path=/var/&depth=1` });
  assert.equal(response.statusCode, 200);
  const tree = response.json<StorageTreeResponse>();
  assert.deepEqual(tree.ancestors, [{ name: "/", path: "/" }]);
  assert.deepEqual(tree.root.actions, REFUSED);
  assert.deepEqual(
    tree.root.children!.map((child) => [child.path, child.kind, child.actions]),
    [["/var/cache.db", "file", ALLOWED]]
  );
  const missing = await h.app.inject({ method: "GET", url: `${storageRoutes.tree}?volume=/&path=/var/gone` });
  assert.deepEqual([missing.statusCode, missing.json().code], [404, "STORAGE_PATH_NOT_FOUND"]);

  const cancelled = await h.app.inject({ method: "DELETE", url: storageRoutes.scan });
  assert.equal(cancelled.statusCode, 200);
  assert.deepEqual(cancelled.json<StorageStatusResponse>().scan, { state: "idle" });
});
