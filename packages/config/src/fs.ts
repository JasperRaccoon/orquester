// Node-only filesystem-sandbox helpers. Kept OUT of index.ts because that module
// is imported by the browser packages (@orquester/ui, @orquester/web), whose
// tsconfig has no Node types — a `node:fs`/`node:path` import there breaks
// `pnpm check`. The daemon imports this from `@orquester/config/fs`.
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join as pathJoin, relative, resolve, sep } from "node:path";

/** Thrown when a path escapes its sandbox root. */
export class FsSandboxError extends Error {}

/**
 * Resolve `target` to a realpath and confirm it is inside `root` (also a
 * realpath). Rejects `..` traversal and symlink escapes. For not-yet-existing
 * targets the deepest existing ancestor is realpath'd, then the remaining
 * segments are appended. Throws FsSandboxError when outside the root.
 */
export async function assertInsideFsRoot(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const resolved = resolve(target);
  let ancestor = resolved;
  for (;;) {
    try {
      await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  const realAncestor = await realpath(ancestor).catch(() => ancestor);
  const tail = relative(ancestor, resolved);
  const finalPath = tail ? pathJoin(realAncestor, tail) : realAncestor;
  const rel = relative(realRoot, finalPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FsSandboxError(`Path is outside the sandbox: ${target}`);
  }
  return finalPath;
}
