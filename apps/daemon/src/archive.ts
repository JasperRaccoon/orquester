/**
 * Archive content listing for the file browser's preview. Shells out to a host
 * archive tool (7-Zip preferred, libarchive's bsdtar as a fallback) to list
 * entries WITHOUT extracting. No tool / unreadable format -> { supported: false }.
 *
 * The tool is spawned with an argument array (no shell), and the archive path is
 * already sandbox-validated by the caller (assertInsideFsRoot), so there is no
 * command-injection or path-escape surface here.
 */
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import { promisify } from "node:util";
import type { ArchiveEntry, FsArchiveResponse } from "@orquester/api";

const run = promisify(execFile);

/** Max entries returned; protects the client from a pathological archive. */
const MAX_ENTRIES = 5000;
/** Backstop so an encrypted/corrupt archive that prompts can't hang the daemon. */
const TOOL_TIMEOUT_MS = 15_000;

type Tool = { bin: string; kind: "7z" | "bsdtar" };
let resolvedTool: Tool | null | undefined;

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".EXE", ".CMD", ".BAT", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(`${dir}/${bin}${ext}`, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

/** First available archive tool on PATH, resolved once and cached. */
function resolveTool(): Tool | null {
  if (resolvedTool !== undefined) return resolvedTool;
  for (const bin of ["7z", "7zz", "7za"]) {
    if (onPath(bin)) return (resolvedTool = { bin, kind: "7z" });
  }
  if (onPath("bsdtar")) return (resolvedTool = { bin: "bsdtar", kind: "bsdtar" });
  return (resolvedTool = null);
}

/** Parse `7z l -slt` technical listing (blocks of "Key = Value" lines). */
function parse7z(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    // The header block before the file list has "Path = <the archive itself>";
    // it has no "Size"/"Folder"/"Attributes" file fields — skip blocks missing them.
    const sizeStr = /^Size = (\d+)$/m.exec(block)?.[1];
    const attr = /^Attributes = (.+)$/m.exec(block)?.[1];
    const folder = /^Folder = (.+)$/m.exec(block)?.[1];
    if (sizeStr === undefined && attr === undefined && folder === undefined) continue;
    const dir = (attr?.includes("D") ?? false) || folder === "+";
    entries.push({ name: path, size: sizeStr ? Number(sizeStr) : 0, dir });
  }
  return entries;
}

/** Parse `bsdtar -tvf` verbose listing. */
function parseBsdtar(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // e.g. "drwxr-xr-x  0 user group   0 Jun 24 12:00 dir/name/"
    const m = /^([\w-]{10})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, perms, sizeStr, name] = m;
    entries.push({ name, size: Number(sizeStr), dir: perms.startsWith("d") || name.endsWith("/") });
  }
  return entries;
}

export async function listArchiveEntries(absPath: string): Promise<FsArchiveResponse> {
  const tool = resolveTool();
  if (!tool) {
    return { supported: false, entries: [], truncated: false, reason: "No archive tool (7z/bsdtar) on PATH." };
  }
  try {
    const opts = { maxBuffer: 32 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS };
    let entries: ArchiveEntry[];
    if (tool.kind === "7z") {
      // -slt: technical listing; -p: empty password (don't prompt); --: end switches.
      const { stdout } = await run(tool.bin, ["l", "-slt", "-p", "--", absPath], opts);
      entries = parse7z(stdout);
    } else {
      const { stdout } = await run(tool.bin, ["-tvf", absPath], opts);
      entries = parseBsdtar(stdout);
    }
    const truncated = entries.length > MAX_ENTRIES;
    return {
      supported: true,
      entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
      truncated,
      tool: tool.bin
    };
  } catch (error) {
    // Tool ran but couldn't read it (encrypted, corrupt, unknown format, timeout).
    return {
      supported: false,
      entries: [],
      truncated: false,
      tool: tool.bin,
      reason: error instanceof Error ? error.message.split("\n")[0] : "Cannot read archive."
    };
  }
}
