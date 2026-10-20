/**
 * Local image inlining for `html_render` / `html_preview` when the thread's
 * project lives in a box (spec §8.9): the agent's page names images by the
 * paths it sees in the box, so they are realpath'd, checked and read there,
 * with the guarantees of the host reader (`html-render-publish.ts`): only a
 * regular file whose realpath is inside the project, at most limit + 1 bytes,
 * and proven afterwards to still be that file inside the project (the box
 * reads by path, so a swap is caught after the read instead of by O_NOFOLLOW).
 */

import { posix } from "node:path";

import type { LocalImageReader } from "../../../agent-chat/html-render-publish.ts";
import type { BoxRegistry } from "../../contracts.ts";
import { BoxFsUnavailableError } from "./errors.ts";
import { locateProjectFs, type BoxProjectFs, type ProjectFsStat } from "./project-fs.ts";

function isInside(root: string, child: string): boolean {
  const relative = posix.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !posix.isAbsolute(relative));
}

function sameFile(a: ProjectFsStat | null, b: ProjectFsStat): boolean {
  if (a === null || a.kind !== "file") return false;
  if (a.identity !== null && b.identity !== null) return a.identity === b.identity;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** A box can't be reached: no image resolves (the page reports them as unreadable). */
const UNREACHABLE: LocalImageReader = {
  realpath: async () => null,
  stat: async () => null,
  readInside: async () => null
};

export function boxLocalImageReader(fs: BoxProjectFs): LocalImageReader {
  // A Windows box's agent writes `C:\orq\…` paths; everything else is already a host path.
  const hostPathOf = (path: string): string | null => (/^[a-z]:[\\/]/i.test(path) ? fs.paths.toHost(path) : path);
  return {
    realpath: async (path) => {
      const host = hostPathOf(path);
      return host === null ? null : fs.realpath(host).catch(() => null);
    },
    stat: async (real) => {
      const found = await fs.stat(real).catch(() => null);
      return found ? { isFile: found.kind === "file", size: found.size } : null;
    },
    readInside: async (real, root, limit) => {
      try {
        const before = await fs.stat(real, { followSymlinks: false });
        if (before === null || before.kind !== "file") return null;
        const bytes = await fs.read(real, { length: limit + 1 });
        const again = await fs.realpath(real);
        const after = await fs.stat(real, { followSymlinks: false });
        if (again !== real || !isInside(root, again) || !sameFile(after, before)) return null;
        return bytes;
      } catch {
        return null;
      }
    }
  };
}

/** The reader for a project dir in a box, or undefined for a host project (the host's own reader applies). */
export function boxImageReader(registry: BoxRegistry | undefined, projectDir: string): LocalImageReader | undefined {
  try {
    const location = locateProjectFs(registry, projectDir);
    return location.kind === "box" ? boxLocalImageReader(location.fs) : undefined;
  } catch (error) {
    if (error instanceof BoxFsUnavailableError) return UNREACHABLE;
    throw error;
  }
}
