/**
 * What the desktop routes ask of a box project that is not about one desktop:
 * whether its VM can run desktops at all, and the launch dialog's reads (the
 * VM's installed `.desktop` apps, the project's executables) through the box.
 */

import type { BoxSysInfo } from "@orquester/api";

import type { SuggestionsFs } from "../../../desktops/suggestions.ts";
import type { BoxProjectFs } from "../fs/project-fs.ts";

/** A `.desktop` file larger than this is no app entry. */
const MAX_DESKTOP_ENTRY_BYTES = 256 * 1024;

/** `build/` dirs visited for executables in a VM: each is a round trip. */
export const BOX_DESKTOP_MAX_BUILD_DIRS = 200;

/** Why a box cannot run desktops (they need Linux), or null when it can. */
export function boxDesktopRefusal(sys: Pick<BoxSysInfo, "os">): string | null {
  if (sys.os === "linux") return null;
  const name = sys.os === "darwin" ? "macOS" : "Windows";
  return `Desktops run only in Linux VMs; this project's VM runs ${name}.`;
}

/** The suggestions' reads over a box link (host paths, mapped by `BoxProjectFs`). */
export function boxSuggestionsFs(fs: BoxProjectFs): SuggestionsFs {
  return {
    list: async (path) => (await fs.readdir(path)).map((entry) => ({ name: entry.name, isDirectory: entry.kind === "dir" })),
    readText: async (path) => (await fs.read(path, { length: MAX_DESKTOP_ENTRY_BYTES })).toString("utf8"),
    stat: async (path) => {
      const info = await fs.stat(path);
      if (info === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return { isFile: info.kind === "file", mode: info.mode };
    }
  };
}
