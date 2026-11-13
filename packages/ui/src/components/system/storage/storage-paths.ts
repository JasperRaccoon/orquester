/** Pure path and error helpers behind the Storage tab. */

import type { StorageErrorCode } from "@orquester/api";

/**
 * The folder above `path` on `volume`, or null when that is the volume root
 * itself (the tab addresses the root as "no path").
 */
export function parentWithin(volume: string, path: string): string | null {
  const cut = path.lastIndexOf("/");
  const parent = cut <= 0 ? "/" : path.slice(0, cut);
  if (parent === volume || !isInside(volume, parent)) return null;
  return parent;
}

/** True when `path` is `root` or below it. */
export function isInside(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** `path` relative to the volume's mount point ("." for the mount point itself). */
export function relativeToVolume(volume: string, path: string): string {
  if (path === volume) return ".";
  if (!isInside(volume, path)) return path;
  return path.slice(volume.endsWith("/") ? volume.length : volume.length + 1);
}

/** `path` with the `from` prefix (itself or a folder above it) swapped for `to`. */
export function rebase(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** The storage refusal code of a thrown API error, duck-typed on `error.body.code`. */
export function storageErrorCode(error: unknown): StorageErrorCode | null {
  const code = ((error as { body?: unknown } | null | undefined)?.body as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? (code as StorageErrorCode) : null;
}

/** HTTP status of a thrown API error, or null. */
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : null;
}

/** What to show for a failed call: the daemon's own reason when it sent one. */
export function errorText(error: unknown): string {
  const message = (error as { serverMessage?: unknown } | null | undefined)?.serverMessage;
  if (typeof message === "string" && message) return message;
  return error instanceof Error ? error.message : String(error);
}
