/**
 * Folder → zip for the file browser's download feature. Spawns a host zip tool
 * (libarchive's bsdtar preferred, then Info-ZIP `zip`, then 7-Zip) that writes a
 * .zip to STDOUT, so the route can stream it without buffering the whole archive
 * in memory. The tool is run with an argument array (no shell) and a cwd of the
 * folder's PARENT with the folder's basename as the single entry, so in-zip
 * paths are relative to the folder.
 *
 * SECURITY: every tool is invoked with store-symlinks-as-links flags (NOT
 * follow). The folder path is already assertInsideFsRoot'd by the caller, but a
 * symlink INSIDE the folder could point outside fsRoot — following it would let
 * the daemon read out-of-sandbox files into the zip. Storing the link is both
 * safe and the correct/standard archive behavior (also keeps symlink-heavy trees
 * like pnpm node_modules small).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, dirname } from "node:path";
import { onPath } from "./archive";

export type ZipTool = { bin: string; kind: "bsdtar" | "zip" | "7z" };

let resolvedZip: ZipTool | null | undefined;

/** First available zip-writing tool on PATH, resolved once and cached. */
export function resolveZipTool(): ZipTool | null {
  if (resolvedZip !== undefined) return resolvedZip;
  // bsdtar stores symlinks by default and reliably writes a zip to stdout.
  if (onPath("bsdtar")) return (resolvedZip = { bin: "bsdtar", kind: "bsdtar" });
  if (onPath("zip")) return (resolvedZip = { bin: "zip", kind: "zip" });
  for (const bin of ["7z", "7zz", "7za"]) {
    if (onPath(bin)) return (resolvedZip = { bin, kind: "7z" });
  }
  return (resolvedZip = null);
}

/**
 * Spawn the resolved tool to write a zip of `absDir` to stdout. Returns null
 * when no tool is on PATH. The caller pipes `child.stdout` to the response,
 * drains `child.stderr`, kills the child on client disconnect, and destroys the
 * response on `child` error.
 */
export function spawnDirZip(absDir: string): ChildProcessWithoutNullStreams | null {
  const tool = resolveZipTool();
  if (!tool) return null;
  const cwd = dirname(absDir);
  const base = basename(absDir);
  const argv =
    tool.kind === "bsdtar"
      ? ["-c", "--format", "zip", "-f", "-", base] // -f - : write to stdout
      : tool.kind === "zip"
        ? ["-r", "-y", "-q", "-", "--", base] // -y store symlinks; "-" archive == stdout; -- ends switches
        : // 7z: -so writes to stdout, but its parser still consumes the first
          // non-switch token as the (ignored) archive name. Pass a dummy archive
          // name so `base` stays a FILE arg; without it 7z archives the whole cwd
          // (the folder's parent) and leaks sibling files. -snl stores symlinks.
          ["a", "-tzip", "-snl", "-so", "dummy.zip", "--", base];
  return spawn(tool.bin, argv, { cwd });
}
