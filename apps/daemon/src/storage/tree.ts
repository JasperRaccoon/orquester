import type { StorageNode, StorageScanSummary, StorageTreeResponse } from "@orquester/api";
import { STORAGE_TREE_DEFAULT_DEPTH, STORAGE_TREE_MAX_DEPTH } from "@orquester/api";

import { storageErrors } from "./errors.ts";
import type { StorageGuardPort } from "./types.ts";

/**
 * A saved scan's pruned tree. Paths are never stored: a node's path is its
 * ancestors' names joined under the volume's mount point, so a rename touches
 * one node and every descendant follows.
 */
export interface ScanNode {
  name: string;
  /** Disk usage (hard links counted once). */
  size: number;
  apparent: number;
  /** Entries under a directory, itself included (recursive); 1 for a file. */
  items: number;
  dir: boolean;
  unreadable?: true;
  /** Kept entries of a directory, biggest first. */
  children?: ScanNode[];
  /** A directory's entries too small to keep, folded together. */
  smaller?: { size: number; apparent: number; items: number };
}

export interface SavedScan {
  volume: string;
  summary: StorageScanSummary;
  /** The volume root; its `name` is ignored (the volume id names it). */
  root: ScanNode;
}

/** Response children narrower than this share of the response root fold into `other`. */
const MIN_DRAW_SHARE = 0.0015;
/** At most this many children per directory are returned; the rest fold into `other`. */
const MAX_CHILDREN = 150;

export const UNACCOUNTED_LABEL = "Unaccounted (not readable)";

export function childPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

/** Path segments of `path` below `volume`, or null when it is not inside it. */
export function segmentsBelow(volume: string, path: string): string[] | null {
  if (path === volume) return [];
  const prefix = volume === "/" ? "/" : `${volume}/`;
  if (!path.startsWith(prefix)) return null;
  const segments = path.slice(prefix.length).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") ? segments : null;
}

/** `node` with the chain of its ancestors (volume root first), or null. */
export function findNode(scan: SavedScan, path: string): { node: ScanNode; ancestors: ScanNode[] } | null {
  const segments = segmentsBelow(scan.volume, path);
  if (!segments) return null;
  let node = scan.root;
  const ancestors: ScanNode[] = [];
  for (const segment of segments) {
    const next = node.children?.find((child) => child.name === segment);
    if (!next) return null;
    ancestors.push(node);
    node = next;
  }
  return { node, ancestors };
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

interface QueryContext {
  guard: StorageGuardPort;
  minDrawBytes: number;
}

function hasChildren(node: ScanNode): boolean {
  return node.dir && ((node.children?.length ?? 0) > 0 || (node.smaller?.items ?? 0) > 0);
}

function toStorageNode(node: ScanNode, name: string, path: string, depthLeft: number, context: QueryContext): StorageNode {
  const kind = node.dir ? "dir" : "file";
  const out: StorageNode = {
    name,
    path,
    kind,
    sizeBytes: node.size,
    apparentBytes: node.apparent,
    items: node.items,
    hasChildren: hasChildren(node),
    actions: context.guard.actionsFor(path, kind)
  };
  if (node.unreadable) out.unreadable = true;
  const project = context.guard.projectFor(path);
  if (project) out.project = project;
  if (node.dir && depthLeft > 0) out.children = childrenOf(node, path, depthLeft - 1, context);
  return out;
}

/** Sorted, size-capped children; whatever is too small to draw folds into one `other`. */
function childrenOf(node: ScanNode, path: string, depthLeft: number, context: QueryContext): StorageNode[] {
  type Entry = { node: ScanNode } | { smaller: NonNullable<ScanNode["smaller"]> };
  const entries: Entry[] = (node.children ?? []).map((child) => ({ node: child }));
  if (node.smaller && node.smaller.items > 0) entries.push({ smaller: node.smaller });
  const sizeOf = (entry: Entry) => ("node" in entry ? entry.node.size : entry.smaller.size);
  entries.sort((a, b) => sizeOf(b) - sizeOf(a));
  let cut = 0;
  while (cut < entries.length && cut < MAX_CHILDREN && sizeOf(entries[cut]!) >= context.minDrawBytes) cut++;
  // Folding a single entry would only rename it.
  if (entries.length - cut === 1) cut = entries.length;
  const out: StorageNode[] = entries.slice(0, cut).map((entry) =>
    "node" in entry
      ? toStorageNode(entry.node, entry.node.name, childPath(path, entry.node.name), depthLeft, context)
      : {
          name: plural(entry.smaller.items, "smaller entry", "smaller entries"),
          path,
          kind: "smaller" as const,
          sizeBytes: entry.smaller.size,
          apparentBytes: entry.smaller.apparent,
          items: entry.smaller.items,
          hasChildren: false
        }
  );
  if (cut < entries.length) {
    let size = 0;
    let apparent = 0;
    let items = 0;
    for (const entry of entries.slice(cut)) {
      if ("node" in entry) {
        size += entry.node.size;
        apparent += entry.node.apparent;
        items += entry.node.items;
      } else {
        size += entry.smaller.size;
        apparent += entry.smaller.apparent;
        items += entry.smaller.items;
      }
    }
    out.push({
      name: plural(entries.length - cut, "other entry", "other entries"),
      path,
      kind: "other",
      sizeBytes: size,
      apparentBytes: apparent,
      items,
      hasChildren: false
    });
  }
  return out;
}

export interface SubtreeQuery {
  /** Absolute path; default the volume root. */
  path?: string;
  /** Levels of children below the root; default {@link STORAGE_TREE_DEFAULT_DEPTH}, clamped to 1…{@link STORAGE_TREE_MAX_DEPTH}. */
  depth?: number;
  guard: StorageGuardPort;
}

/**
 * The part of a saved scan the treemap draws. At the volume root, used space
 * the scan could not see is one more child (`unaccounted`), and the root's size
 * includes it, so the map adds up to the disk's used space.
 */
export function subtree(scan: SavedScan, query: SubtreeQuery): StorageTreeResponse {
  const path = query.path ?? scan.volume;
  const found = findNode(scan, path);
  if (!found) throw storageErrors.pathNotFound(path);
  const depth = Math.min(STORAGE_TREE_MAX_DEPTH, Math.max(1, Math.floor(query.depth ?? STORAGE_TREE_DEFAULT_DEPTH)));
  const atVolumeRoot = found.ancestors.length === 0;
  const unaccounted = atVolumeRoot ? scan.summary.unaccountedBytes : 0;
  const rootSize = found.node.size + unaccounted;
  const context: QueryContext = { guard: query.guard, minDrawBytes: rootSize * MIN_DRAW_SHARE };
  const root = toStorageNode(found.node, atVolumeRoot ? scan.volume : found.node.name, path, depth, context);
  if (unaccounted > 0) {
    root.sizeBytes = rootSize;
    const children = root.children ?? [];
    const node: StorageNode = {
      name: UNACCOUNTED_LABEL,
      path: scan.volume,
      kind: "unaccounted",
      sizeBytes: unaccounted,
      apparentBytes: unaccounted,
      items: 0,
      hasChildren: false
    };
    const at = children.findIndex((child) => child.sizeBytes < unaccounted);
    children.splice(at < 0 ? children.length : at, 0, node);
    root.children = children;
  }
  const ancestors: StorageTreeResponse["ancestors"] = [];
  let ancestorPath = scan.volume;
  found.ancestors.forEach((ancestor, index) => {
    if (index > 0) ancestorPath = childPath(ancestorPath, ancestor.name);
    ancestors.push({ name: index === 0 ? scan.volume : ancestor.name, path: ancestorPath });
  });
  return { volume: scan.volume, scan: scan.summary, root, ancestors };
}

function resort(children: ScanNode[], moved: ScanNode): void {
  const from = children.indexOf(moved);
  if (from < 0) return;
  children.splice(from, 1);
  const at = children.findIndex((child) => child.size < moved.size);
  children.splice(at < 0 ? children.length : at, 0, moved);
}

function countUnreadable(node: ScanNode): number {
  let count = node.unreadable ? 1 : 0;
  for (const child of node.children ?? []) count += countUnreadable(child);
  return count;
}

/**
 * Drop `path` from the scan, subtracting it from every ancestor and the
 * summary. False when the scan does not hold it (or it is the volume root).
 */
export function removeFromScan(scan: SavedScan, path: string): boolean {
  const found = findNode(scan, path);
  if (!found || found.ancestors.length === 0) return false;
  const { node, ancestors } = found;
  const parent = ancestors.at(-1)!;
  parent.children!.splice(parent.children!.indexOf(node), 1);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const ancestor = ancestors[index]!;
    ancestor.size = Math.max(0, ancestor.size - node.size);
    ancestor.apparent = Math.max(0, ancestor.apparent - node.apparent);
    ancestor.items = Math.max(1, ancestor.items - node.items);
    if (index > 0) resort(ancestors[index - 1]!.children!, ancestor);
  }
  const summary = scan.summary;
  summary.scannedBytes = scan.root.size;
  summary.apparentBytes = scan.root.apparent;
  summary.items = scan.root.items;
  summary.unreadableDirs = Math.max(0, summary.unreadableDirs - countUnreadable(node));
  // The space freed leaves "used" too, so what the scan could not see stays the same.
  if (summary.usedBytesAtScan !== null) summary.usedBytesAtScan = Math.max(0, summary.usedBytesAtScan - node.size);
  return true;
}

/**
 * `from` was renamed to `to` (same directory): rename its node (an entry it
 * replaced is dropped first). A move to another directory is not tracked and
 * drops the node. False when the scan does not hold `from`.
 */
export function renameInScan(scan: SavedScan, from: string, to: string): boolean {
  const found = findNode(scan, from);
  if (!found || found.ancestors.length === 0) return false;
  const slash = to.lastIndexOf("/");
  const toParent = slash <= 0 ? "/" : to.slice(0, slash);
  const fromSlash = from.lastIndexOf("/");
  const fromParent = fromSlash <= 0 ? "/" : from.slice(0, fromSlash);
  const newName = to.slice(slash + 1);
  if (toParent !== fromParent || newName === "") return removeFromScan(scan, from);
  if (findNode(scan, to)) removeFromScan(scan, to);
  found.node.name = newName;
  return true;
}
