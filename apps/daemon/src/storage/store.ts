import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageScanSummary } from "@orquester/api";

import { writeFileAtomic } from "../agent-hooks.ts";
import type { SavedScan, ScanNode } from "./tree.ts";

/**
 * One file per volume in `storageScansDir(appdir)`: `scan-<encoded mount
 * point>.json`, rewritten whole (temp + fsync + rename) after each scan or
 * action, so a full disk or a crash leaves the previous scan. Nodes are packed
 * as arrays to keep a few hundred thousand of them in a small file:
 *
 *   file → [name, size, apparent]
 *   dir  → [name, size, apparent, items, flags, [children…], smaller?]
 *          flags: 1 = unreadable; smaller = [size, apparent, items]
 *
 * Anything that does not validate — another format, a newer version, a torn
 * file — loads as "no scan".
 */

const FORMAT = "orquester.storage-scan";
const VERSION = 1;
const PREFIX = "scan-";
const SUFFIX = ".json";
/** gdu's export while a scan runs. */
export const EXPORT_SUFFIX = ".export.json";

type PackedFile = [string, number, number];
type PackedSmaller = [number, number, number];
type PackedDir = [string, number, number, number, number, PackedNode[], PackedSmaller?];
type PackedNode = PackedFile | PackedDir;

export function scanFileName(volume: string): string {
  return `${PREFIX}${encodeURIComponent(volume)}${SUFFIX}`;
}

function pack(node: ScanNode): PackedNode {
  if (!node.dir) return [node.name, node.size, node.apparent];
  const packed: PackedDir = [
    node.name,
    node.size,
    node.apparent,
    node.items,
    node.unreadable ? 1 : 0,
    (node.children ?? []).map(pack)
  ];
  if (node.smaller && node.smaller.items > 0) packed.push([node.smaller.size, node.smaller.apparent, node.smaller.items]);
  return packed;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

class Invalid extends Error {}

function unpack(value: unknown): ScanNode {
  if (!Array.isArray(value) || typeof value[0] !== "string" || !count(value[1]) || !count(value[2])) throw new Invalid();
  if (value.length === 3) return { name: value[0], size: value[1], apparent: value[2], items: 1, dir: false };
  if ((value.length !== 6 && value.length !== 7) || !count(value[3]) || !count(value[4]) || !Array.isArray(value[5])) {
    throw new Invalid();
  }
  const node: ScanNode = {
    name: value[0],
    size: value[1],
    apparent: value[2],
    items: value[3],
    dir: true,
    children: value[5].map(unpack)
  };
  if ((value[4] & 1) === 1) node.unreadable = true;
  if (value.length === 7) {
    const smaller = value[6];
    if (!Array.isArray(smaller) || smaller.length !== 3 || !smaller.every(count)) throw new Invalid();
    node.smaller = { size: smaller[0], apparent: smaller[1], items: smaller[2] };
  }
  return node;
}

function validSummary(value: unknown): value is StorageScanSummary {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.startedAt === "string" &&
    typeof s.finishedAt === "string" &&
    count(s.durationMs) &&
    (s.trigger === "manual" || s.trigger === "schedule") &&
    typeof s.scannerVersion === "string" &&
    count(s.scannedBytes) &&
    count(s.apparentBytes) &&
    count(s.items) &&
    count(s.unreadableDirs) &&
    (s.usedBytesAtScan === null || count(s.usedBytesAtScan)) &&
    count(s.unaccountedBytes)
  );
}

/** Parse a saved scan file's text; null for anything not a valid current-format scan. */
export function decodeSavedScan(text: string): SavedScan | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || value.format !== FORMAT || value.version !== VERSION) return null;
    if (typeof value.volume !== "string" || !value.volume.startsWith("/") || !validSummary(value.summary)) return null;
    const root = unpack(value.root);
    if (!root.dir) return null;
    const summary = value.summary;
    return {
      volume: value.volume,
      summary: {
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        trigger: summary.trigger,
        scannerVersion: summary.scannerVersion,
        scannedBytes: summary.scannedBytes,
        apparentBytes: summary.apparentBytes,
        items: summary.items,
        unreadableDirs: summary.unreadableDirs,
        usedBytesAtScan: summary.usedBytesAtScan,
        unaccountedBytes: summary.unaccountedBytes
      },
      root
    };
  } catch {
    return null;
  }
}

export function encodeSavedScan(scan: SavedScan): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, volume: scan.volume, summary: scan.summary, root: pack(scan.root) });
}

export async function writeSavedScan(dir: string, scan: SavedScan): Promise<void> {
  await writeFileAtomic(join(dir, scanFileName(scan.volume)), encodeSavedScan(scan), 0o600, false, { durable: true });
}

/**
 * Every readable saved scan in `dir`, keyed by volume. Removes what a previous
 * daemon left behind mid-write: gdu exports and atomic-write temp files.
 */
export async function loadSavedScans(dir: string): Promise<Map<string, SavedScan>> {
  const scans = new Map<string, SavedScan>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return scans;
  }
  for (const name of names) {
    if (name.endsWith(EXPORT_SUFFIX) || name.endsWith(".tmp")) {
      await rm(join(dir, name), { force: true }).catch(() => undefined);
      continue;
    }
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const text = await readFile(join(dir, name), "utf8").catch(() => null);
    const scan = text === null ? null : decodeSavedScan(text);
    if (scan && scanFileName(scan.volume) === name) scans.set(scan.volume, scan);
  }
  return scans;
}
