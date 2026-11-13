import assert from "node:assert/strict";
import test from "node:test";
import type { StorageNode, StorageNodeActions, StorageScanSummary } from "@orquester/api";

import { subtree, type SavedScan, type ScanNode } from "./tree.ts";
import type { StorageGuardPort } from "./types.ts";

const ALLOWED: StorageNodeActions = { delete: null, rename: null, download: null, confirmDelete: true };

const guard: StorageGuardPort = {
  actionsFor: (path) => (path === "/" || path === "/var" ? { ...ALLOWED, delete: "protected", rename: "protected" } : ALLOWED),
  projectFor: (path) =>
    path.startsWith("/srv/ws/demo/app")
      ? { workspace: "demo", project: "app", projectPath: "/srv/ws/demo/app" }
      : undefined
};

function file(name: string, size: number): ScanNode {
  return { name, size, apparent: size, items: 1, dir: false };
}

function dir(name: string, children: ScanNode[], extra: Partial<ScanNode> = {}): ScanNode {
  const sorted = [...children].sort((a, b) => b.size - a.size);
  const smaller = extra.smaller;
  return {
    name,
    dir: true,
    children: sorted,
    size: sorted.reduce((sum, child) => sum + child.size, smaller?.size ?? 0),
    apparent: sorted.reduce((sum, child) => sum + child.apparent, smaller?.apparent ?? 0),
    items: sorted.reduce((sum, child) => sum + child.items, 1 + (smaller?.items ?? 0)),
    ...extra
  };
}

function summary(scanned: number, used: number | null): StorageScanSummary {
  return {
    startedAt: "2026-11-13T03:00:00.000Z",
    finishedAt: "2026-11-13T03:04:00.000Z",
    durationMs: 240_000,
    trigger: "schedule",
    scannerVersion: "v5.39.0",
    scannedBytes: scanned,
    apparentBytes: scanned,
    items: 0,
    unreadableDirs: 1,
    usedBytesAtScan: used,
    unaccountedBytes: used === null ? 0 : Math.max(0, used - scanned)
  };
}

function rootScan(): SavedScan {
  const app = dir("app", [file("model.bin", 400_000_000), dir("node_modules", [file("x", 50_000_000)])]);
  const root = dir("/", [
    dir("var", [dir("lib", [dir("big", [file("blob", 2_000_000_000)]), dir("locked", [], { unreadable: true })])]),
    dir("srv", [dir("ws", [dir("demo", [app])])]),
    file("swapfile", 1_000_000_000)
  ]);
  return { volume: "/", root, summary: summary(root.size, root.size + 500_000_000) };
}

function names(node: StorageNode | undefined): string[] {
  return (node?.children ?? []).map((child) => child.name);
}

test("the volume root answers depth levels of children, biggest first, with the unaccounted block and annotations", () => {
  const response = subtree(rootScan(), { guard });
  const root = response.root;
  assert.equal(root.path, "/");
  assert.equal(root.name, "/");
  assert.deepEqual(response.ancestors, []);
  // The root adds up to the disk's used space.
  assert.equal(root.sizeBytes, 3_450_000_000 + 500_000_000);
  assert.deepEqual(names(root), ["var", "swapfile", "Unaccounted (not readable)", "srv"]);
  const unaccounted = root.children![2]!;
  assert.deepEqual(
    [unaccounted.kind, unaccounted.path, unaccounted.sizeBytes, unaccounted.actions],
    ["unaccounted", "/", 500_000_000, undefined]
  );
  assert.equal(root.actions?.delete, "protected");
  // Default depth 3: /var/lib/big is listed but its children are not.
  const big = root.children![0]!.children![0]!.children![0]!;
  assert.equal(big.path, "/var/lib/big");
  assert.equal(big.children, undefined);
  assert.equal(big.hasChildren, true);
  // Too small to draw, but folding a lone entry would only rename it.
  const locked = root.children![0]!.children![0]!.children!.find((child) => child.name === "locked");
  assert.deepEqual([locked?.unreadable, locked?.hasChildren], [true, false]);
});

test("a subtree has a breadcrumb, no unaccounted block, project annotations and no double slashes", () => {
  const response = subtree(rootScan(), { path: "/srv/ws/demo/app", depth: 1, guard });
  assert.deepEqual(response.ancestors, [
    { name: "/", path: "/" },
    { name: "srv", path: "/srv" },
    { name: "ws", path: "/srv/ws" },
    { name: "demo", path: "/srv/ws/demo" }
  ]);
  const root = response.root;
  assert.equal(root.sizeBytes, 450_000_000);
  assert.deepEqual(
    root.children!.map((child) => [child.path, child.kind, child.children === undefined]),
    [
      ["/srv/ws/demo/app/model.bin", "file", true],
      ["/srv/ws/demo/app/node_modules", "dir", true]
    ]
  );
  assert.deepEqual(root.children![1]!.project, { workspace: "demo", project: "app", projectPath: "/srv/ws/demo/app" });
  assert.deepEqual(response.root.project?.workspace, "demo");
});

test("depth is clamped to 1…6 and a path outside the saved scan is not found", () => {
  let node: ScanNode = file("leaf", 10);
  for (let level = 9; level >= 1; level--) node = dir(`d${level}`, [node]);
  const scan: SavedScan = { volume: "/data", root: dir("/data", [node]), summary: summary(10, null) };
  const levels = (depth: number) => {
    let current: StorageNode | undefined = subtree(scan, { depth, guard }).root;
    let count = 0;
    while (current?.children?.length) {
      current = current.children[0];
      count++;
    }
    return count;
  };
  assert.equal(levels(0), 1);
  assert.equal(levels(2), 2);
  assert.equal(levels(99), 6);
  assert.equal(subtree(scan, { guard }).root.children![0]!.path, "/data/d1");
  assert.throws(() => subtree(scan, { path: "/data/nope", guard }), { code: "STORAGE_PATH_NOT_FOUND" });
  assert.throws(() => subtree(scan, { path: "/datastore", guard }), { code: "STORAGE_PATH_NOT_FOUND" });
  assert.throws(() => subtree(scan, { path: "/data/d1/../d1", guard }), { code: "STORAGE_PATH_NOT_FOUND" });
});

test("children too small to draw, or beyond 150, fold into one other node; a dir's smaller entries are a child", () => {
  const many = Array.from({ length: 300 }, (_, index) => file(`f${index}`, 100_000_000 + index));
  const crowded = dir("crowded", [...many, file("huge", 10_000_000_000), file("tiny", 1)], {
    smaller: { size: 2_000_000_000, apparent: 2_000_000_000, items: 4000 }
  });
  const scan: SavedScan = { volume: "/", root: dir("/", [crowded]), summary: summary(crowded.size, null) };
  const response = subtree(scan, { path: "/crowded", depth: 1, guard });
  const children = response.root.children!;
  assert.equal(children.length, 151);
  assert.deepEqual(
    children.slice(0, 2).map((child) => [child.name, child.kind, child.path, child.items, child.actions]),
    [
      ["huge", "file", "/crowded/huge", 1, ALLOWED],
      ["4,000 smaller entries", "smaller", "/crowded", 4000, undefined]
    ]
  );
  const other = children.at(-1)!;
  assert.equal(other.kind, "other");
  assert.equal(other.path, "/crowded");
  // 300 + huge + tiny + smaller = 303 entries; 150 shown.
  assert.equal(other.name, "153 other entries");
  assert.equal(other.items, 153);
  const shown = children.slice(0, -1).reduce((sum, child) => sum + child.sizeBytes, 0);
  assert.equal(shown + other.sizeBytes, response.root.sizeBytes);
  for (let index = 1; index < children.length - 1; index++) {
    assert.ok(children[index - 1]!.sizeBytes >= children[index]!.sizeBytes);
  }
});
