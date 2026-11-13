import { readFile, statfs } from "node:fs/promises";
import type { StorageVolume } from "@orquester/api";

/**
 * The scannable volumes: real local filesystems from `/proc/self/mountinfo`, one
 * per device. Under systemd's `ProtectSystem=strict` the daemon's mount namespace
 * shows `/etc`, `/usr`, `/var` and `/tmp` as separate bind mounts of the root
 * device; collapsing by `major:minor` into the shortest mount point folds them
 * back into `/`, which gdu's `-x` (device-based) then scans in one go.
 */

export interface MountEntry {
  /** `major:minor`. */
  device: string;
  /** The mounted directory of the source filesystem (`/` unless a bind of a subdir). */
  root: string;
  mountPoint: string;
  fsType: string;
  source: string;
}

/** Block filesystems worth mapping; everything else (tmpfs, proc, overlay, nfs, vfat…) is skipped. */
const REAL_FILESYSTEMS = new Set([
  "ext2",
  "ext3",
  "ext4",
  "xfs",
  "btrfs",
  "zfs",
  "f2fs",
  "bcachefs",
  "jfs",
  "reiserfs",
  "nilfs2"
]);

/** Boot partitions, kernel/runtime trees, snap images and container layers. */
const EXCLUDED_TREES = ["/boot", "/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/docker", "/var/lib/containers"];

/** mountinfo escapes space, tab, newline and backslash as `\ooo`. */
function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** `/proc/<pid>/mountinfo` → one entry per well-formed line (others are skipped). */
export function parseMountInfo(text: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    if (separator < 0 || fields.length < separator + 3) continue;
    const device = fields[2]!;
    if (!/^\d+:\d+$/.test(device)) continue;
    entries.push({
      device,
      root: unescapeMountField(fields[3]!),
      mountPoint: unescapeMountField(fields[4]!),
      fsType: fields[separator + 1]!,
      source: unescapeMountField(fields[separator + 2]!)
    });
  }
  return entries;
}

function insideTree(path: string, tree: string): boolean {
  return path === tree || path.startsWith(`${tree}/`);
}

/**
 * Which of two mounts of one device names the volume: the one showing the whole
 * filesystem (root `/`) over a bind of a subdirectory, then the shortest path.
 */
function preferredMount(candidate: MountEntry, current: MountEntry): boolean {
  const candidateWhole = candidate.root === "/";
  if (candidateWhole !== (current.root === "/")) return candidateWhole;
  if (candidate.mountPoint.length !== current.mountPoint.length) return candidate.mountPoint.length < current.mountPoint.length;
  return candidate.mountPoint < current.mountPoint;
}

/** Real filesystems outside the excluded trees, one per device (see {@link preferredMount}). */
export function scannableMounts(entries: MountEntry[]): MountEntry[] {
  const byDevice = new Map<string, MountEntry>();
  for (const entry of entries) {
    if (!REAL_FILESYSTEMS.has(entry.fsType)) continue;
    if (!entry.mountPoint.startsWith("/")) continue;
    if (EXCLUDED_TREES.some((tree) => insideTree(entry.mountPoint, tree))) continue;
    const seen = byDevice.get(entry.device);
    if (!seen || preferredMount(entry, seen)) byDevice.set(entry.device, entry);
  }
  return [...byDevice.values()].sort(compareMountPoints);
}

/** `/` first, then by mount point. */
export function compareMountPoints(a: { mountPoint: string }, b: { mountPoint: string }): number {
  if (a.mountPoint === b.mountPoint) return 0;
  if (a.mountPoint === "/") return -1;
  if (b.mountPoint === "/") return 1;
  return a.mountPoint < b.mountPoint ? -1 : 1;
}

export type VolumeInfo = Omit<StorageVolume, "lastScan">;

export interface VolumeSpace {
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  /** Inodes in use (an estimate of how many entries a scan will export); null when unknown. */
  inodesUsed: number | null;
}

/** statfs of `path`: used = blocks − free (as df), free = what an unprivileged user can still write. */
export async function volumeSpace(path: string): Promise<VolumeSpace> {
  try {
    const stats = await statfs(path);
    return {
      totalBytes: stats.blocks * stats.bsize,
      usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
      inodesUsed: stats.files > 0 ? Math.max(0, stats.files - stats.ffree) : null
    };
  } catch {
    return { totalBytes: null, usedBytes: null, freeBytes: null, inodesUsed: null };
  }
}

/** The host's scannable volumes with their statfs totals now (no scan summary). */
export async function listVolumes(mountInfoPath = "/proc/self/mountinfo"): Promise<VolumeInfo[]> {
  let text: string;
  try {
    text = await readFile(mountInfoPath, "utf8");
  } catch {
    return [];
  }
  return Promise.all(
    scannableMounts(parseMountInfo(text)).map(async (mount) => {
      const space = await volumeSpace(mount.mountPoint);
      return {
        id: mount.mountPoint,
        mountPoint: mount.mountPoint,
        device: mount.source,
        fsType: mount.fsType,
        totalBytes: space.totalBytes,
        usedBytes: space.usedBytes,
        freeBytes: space.freeBytes
      };
    })
  );
}
