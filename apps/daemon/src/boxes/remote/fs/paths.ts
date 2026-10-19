/**
 * Host path ⇄ box path for the file features of box projects (spec §8.6, §8.7).
 *
 * Every path that enters or leaves a file route is a host path (POSIX, absolute):
 * the UI, the session records and every path-keyed store know only those. A box
 * on Linux or macOS uses the very same paths; a Windows box puts them under a
 * drive prefix (`box-protocol.ts` `hostToBoxPath`). This module is the one place
 * that converts, compares and splits box paths, so the Windows rules (backslashes,
 * case-insensitive comparison, a drive prefix) live here and nowhere else.
 */

import { posix, win32 } from "node:path";

import { boxToHostPath, hostToBoxPath, type BoxPathMap } from "@orquester/api";

export class BoxPaths {
  /** `path.win32` on a Windows box, `path.posix` everywhere else. */
  readonly api: typeof posix;
  private readonly windows: boolean;

  constructor(readonly map: BoxPathMap) {
    this.windows = map.kind === "windows-prefix";
    this.api = this.windows ? win32 : posix;
  }

  /** The box path of an absolute host path (normalized first: `..` and `//` never reach the box). */
  toBox(hostPath: string): string {
    return hostToBoxPath(this.map, posix.resolve(hostPath));
  }

  /** The host path of a box path, or null when the box path is outside the mapping. */
  toHost(boxPath: string): string | null {
    const host = boxToHostPath(this.map, this.windows ? win32.normalize(boxPath) : boxPath);
    return host === null ? null : posix.normalize(host);
  }

  /**
   * The segments of `child` below `root` (both box paths), `[]` for the root
   * itself, or null when `child` is not inside `root`. Windows paths compare
   * case-insensitively, as the file system does.
   */
  segmentsInside(root: string, child: string): string[] | null {
    const relative = this.api.relative(root, child);
    if (relative === "") return [];
    if (relative === ".." || relative.startsWith(`..${this.api.sep}`) || this.api.isAbsolute(relative)) return null;
    return relative.split(this.api.sep).filter((segment) => segment.length > 0);
  }

  /** Box path joined from a box directory and plain segments. */
  join(boxDir: string, ...segments: string[]): string {
    return this.api.join(boxDir, ...segments);
  }

  dirname(boxPath: string): string {
    return this.api.dirname(boxPath);
  }
}

/** Host path of `segments` below the host directory `hostRoot`. */
export function hostJoin(hostRoot: string, segments: readonly string[]): string {
  return segments.length === 0 ? hostRoot : posix.join(hostRoot, ...segments);
}
