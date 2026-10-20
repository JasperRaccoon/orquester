/**
 * Archive listing (`/api/fs/archive`) and folder zips (`/api/fs/download` of a
 * directory) for box projects: the same tools, arguments and parsers as the
 * host (`archive.ts`, `zip.ts`), run in the box. The archive or folder never
 * crosses the link whole: a listing returns text, a zip streams out of the
 * tool's stdout.
 */

import { posix } from "node:path";

import type { FsArchiveResponse } from "@orquester/api";

import { MAX_ENTRIES, TOOL_TIMEOUT_MS, parse7z, parseBsdtar } from "../../../archive.ts";
import { zipArgv, type ZipTool } from "../../../zip.ts";
import type { BoxProcess } from "../../contracts.ts";
import { boxTools, runBoxCommand, type BoxTools } from "./exec.ts";
import type { BoxProjectFs } from "./project-fs.ts";

/** The archive tool a box has, in the host's order of preference (7-Zip, then bsdtar). */
export function archiveToolOf(tools: BoxTools): { bin: string; kind: "7z" | "bsdtar" } | null {
  if (tools.sevenZip) return { bin: tools.sevenZip, kind: "7z" };
  if (tools.bsdtar) return { bin: tools.bsdtar, kind: "bsdtar" };
  return null;
}

/** The zip-writing tool a box has, in the host's order of preference (bsdtar, zip, 7-Zip). */
export function zipToolOf(tools: BoxTools): ZipTool | null {
  if (tools.bsdtar) return { bin: tools.bsdtar, kind: "bsdtar" };
  if (tools.zip) return { bin: "zip", kind: "zip" };
  if (tools.sevenZip) return { bin: tools.sevenZip, kind: "7z" };
  return null;
}

/** `listArchiveEntries` for a file in a box project (`path`: its contained host path). */
export async function listBoxArchiveEntries(fs: BoxProjectFs, path: string): Promise<FsArchiveResponse> {
  const tool = archiveToolOf(await boxTools(fs));
  if (!tool) {
    return { supported: false, entries: [], truncated: false, reason: "No archive tool (7z/bsdtar) in the project's box." };
  }
  const boxPath = fs.toBox(path);
  const args = tool.kind === "7z" ? ["l", "-slt", "-p", "--", boxPath] : ["-tvf", boxPath];
  try {
    const run = await runBoxCommand(fs, { command: tool.bin, args, timeoutMs: TOOL_TIMEOUT_MS, maxStdoutBytes: 32 * 1024 * 1024 });
    if (run.code !== 0) {
      const reason = run.timedOut
        ? `${tool.bin} timed out.`
        : run.overflow
          ? `${tool.bin} listed more than 32 MB.`
          : run.stderr.trim().split(/\r?\n/)[0] || `${tool.bin} exited with code ${run.code}.`;
      return { supported: false, entries: [], truncated: false, tool: tool.bin, reason };
    }
    const stdout = run.stdout.toString("utf8");
    const entries = tool.kind === "7z" ? parse7z(stdout) : parseBsdtar(stdout);
    const truncated = entries.length > MAX_ENTRIES;
    return { supported: true, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated, tool: tool.bin };
  } catch (error) {
    return {
      supported: false,
      entries: [],
      truncated: false,
      tool: tool.bin,
      reason: error instanceof Error ? error.message.split("\n")[0] : "Cannot read archive."
    };
  }
}

/**
 * Start the box's zip tool writing a zip of `dir` (a contained host path) to
 * stdout, from the folder's parent so in-zip paths start at the folder. Null
 * when the box has no zip tool. Symlinks are stored as links, never followed
 * (the flags of `zip.ts`), so nothing outside the folder is read into the zip.
 */
export async function spawnBoxDirZip(fs: BoxProjectFs, dir: string): Promise<BoxProcess | null> {
  const tool = zipToolOf(await boxTools(fs));
  if (!tool) return null;
  const proc = fs.exec({ command: tool.bin, args: zipArgv(tool.kind, posix.basename(dir)), cwd: posix.dirname(dir) });
  proc.stdin.end();
  return proc;
}
