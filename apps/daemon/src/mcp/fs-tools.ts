import { open, opendir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";
import { utf8SequenceLength } from "@orquester/api/agent-chat";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";
import { wholeUtf8Length } from "./result.ts";
// boxes: a path in a box project is read in its box (spec §8.7).
import type { BoxRegistry } from "../boxes/contracts.ts";
import { BoxFsUnavailableError, errnoOf } from "../boxes/remote/fs/errors.ts";
import { locateProjectFs, type BoxProjectFs } from "../boxes/remote/fs/project-fs.ts";

export const MAX_FS_ENTRIES = 500;
export const DEFAULT_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;

type FsEntryKind = "dir" | "file" | "symlink" | "other";

export type ListFilesResult = {
  path: string;
  entries: { name: string; kind: FsEntryKind; size: number }[];
  truncated: boolean;
};

/** `readFileWindow` on a directory: `read_file` lists it instead (`listFiles`). */
export class FsDirectoryError extends ToolError {
  constructor() {
    super("INVALID_ARGUMENT", "Path is a directory.");
    this.name = "FsDirectoryError";
  }
}

export type ReadFileWindowResult = {
  path: string;
  text: string;
  size: number;
  offset: number;
  truncated: boolean;
  /** The bytes `text` covers, from `offset`: the next window starts at `offset + consumed`. */
  consumed: number;
};

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.floor(offset));
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(maxBytes)));
}

export class FsTools {
  /** `boxes`: where box projects are (absent: every path is a host path). */
  constructor(private readonly opts: { fsRoot: string; boxes?: () => BoxRegistry | undefined }) {}

  async listFiles(path: string): Promise<ListFilesResult> {
    const box = await this.boxPath(path);
    if (box) return boxListFiles(box.fs, box.safe);
    const safe = await this.resolvePath(path);
    let dirents: Dirent[];
    let truncated = false;
    try {
      dirents = [];
      const dir = await opendir(safe);
      try {
        for await (const entry of dir) {
          if (dirents.length >= MAX_FS_ENTRIES) {
            truncated = true;
            break;
          }
          dirents.push(entry);
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT") {
        throw new ToolError("INVALID_ARGUMENT", "Directory not found.");
      }
      if (code === "ENOTDIR") {
        throw new ToolError("INVALID_ARGUMENT", "Path is not a directory.");
      }
      throw new ToolError("INVALID_ARGUMENT", "Unable to list directory.");
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const entries = await Promise.all(
      dirents.map(async (entry) => {
        const kind = entryKind(entry);
        const size = kind === "file" ? await fileSize(join(safe, entry.name)) : 0;
        return { name: entry.name, kind, size };
      })
    );

    return { path: safe, entries, truncated };
  }

  async readFileWindow(
    path: string,
    opts?: { offset?: number; maxBytes?: number }
  ): Promise<ReadFileWindowResult> {
    const box = await this.boxPath(path);
    if (box) return boxReadFileWindow(box.fs, box.safe, opts);
    const safe = await this.resolvePath(path);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(safe);
    } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ToolError("INVALID_ARGUMENT", "File not found.");
      }
      throw new ToolError("INVALID_ARGUMENT", "Unable to read file.");
    }

    if (fileStat.isDirectory()) {
      throw new FsDirectoryError();
    }
    if (!fileStat.isFile()) {
      throw new ToolError("INVALID_ARGUMENT", "Path is not a regular file.");
    }

    const offset = normalizeOffset(opts?.offset);
    const maxBytes = normalizeMaxBytes(opts?.maxBytes);
    const file = await open(safe, "r").catch(() => {
      throw new ToolError("INVALID_ARGUMENT", "Unable to read file.");
    });
    try {
      await assertTextFile(file, fileStat.size);
      const readLength = offset < fileStat.size ? Math.min(maxBytes, fileStat.size - offset) : 0;
      // Up to 3 bytes past the window, so a window narrower than its first character can still take it whole.
      const extra = Math.max(0, Math.min(3, fileStat.size - offset - readLength));
      const buffer = Buffer.allocUnsafe(readLength + extra);
      const { bytesRead } = readLength > 0 ? await file.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
      return windowResult(safe, buffer, bytesRead, readLength, offset, fileStat.size);
    } finally {
      await file.close();
    }
  }

  /**
   * boxes: the box and the contained host path when `path` is in a box project; null for a host path. As the file
   * routes: the project's folder inside `fsRoot` (on the host, its stub), the target inside the folder (in the box).
   */
  private async boxPath(path: string): Promise<{ fs: BoxProjectFs; safe: string } | null> {
    const target = isAbsolute(path) ? path : join(this.opts.fsRoot, path);
    let location;
    try {
      location = locateProjectFs(this.opts.boxes?.(), target);
    } catch (error) {
      if (error instanceof BoxFsUnavailableError) throw new ToolError(error.code, error.message);
      throw error;
    }
    if (location.kind === "host") return null;
    try {
      await assertInsideFsRoot(this.opts.fsRoot, location.projectRoot);
      return { fs: location.fs, safe: await location.fs.assertInside(location.projectRoot, target) };
    } catch (error) {
      if (error instanceof FsSandboxError) throw new FsSandboxError("Path is not allowed (outside the sandbox).");
      if (error instanceof BoxFsUnavailableError) throw new ToolError(error.code, error.message);
      throw error;
    }
  }

  private async resolvePath(path: string): Promise<string> {
    const target = isAbsolute(path) ? path : join(this.opts.fsRoot, path);
    try {
      return await assertInsideFsRoot(this.opts.fsRoot, target);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        throw new FsSandboxError("Path is not allowed (outside the sandbox).");
      }
      throw error;
    }
  }
}

/** The window `buffer` (`bytesRead` bytes read from `offset`, `readLength` asked) answers, ending on a character boundary. */
function windowResult(safe: string, buffer: Buffer, bytesRead: number, readLength: number, offset: number, size: number): ReadFileWindowResult {
  const windowBytes = Math.min(bytesRead, readLength);
  let consumed = windowBytes;
  if (offset + windowBytes < size) {
    // The window ends before the file does: end it on a character boundary, never inside a character. One narrower
    // than the character it starts with takes that character whole (at most 4 bytes), so paging always advances.
    consumed = wholeUtf8Length(buffer.subarray(0, windowBytes));
    if (consumed === 0 && windowBytes > 0) consumed = Math.min(bytesRead, utf8SequenceLength(buffer[0]!));
  }
  return {
    path: safe,
    text: buffer.subarray(0, consumed).toString("utf8"),
    size,
    offset,
    truncated: offset + consumed < size,
    consumed,
  };
}

// boxes: the two reads for a box project, with the host versions' limits and agent-facing errors.

async function boxListFiles(fs: BoxProjectFs, safe: string): Promise<ListFilesResult> {
  let listed;
  try {
    listed = await fs.readdir(safe);
  } catch (error) {
    if (error instanceof BoxFsUnavailableError) throw new ToolError(error.code, error.message);
    const code = errnoOf(error);
    if (code === "ENOENT") throw new ToolError("INVALID_ARGUMENT", "Directory not found.");
    if (code === "ENOTDIR") throw new ToolError("INVALID_ARGUMENT", "Path is not a directory.");
    throw new ToolError("INVALID_ARGUMENT", "Unable to list directory.");
  }
  const truncated = listed.length > MAX_FS_ENTRIES;
  const entries = listed
    .slice(0, MAX_FS_ENTRIES)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, kind: entry.kind, size: entry.kind === "file" ? entry.size : 0 }));
  return { path: safe, entries, truncated };
}

async function boxReadFileWindow(fs: BoxProjectFs, safe: string, opts?: { offset?: number; maxBytes?: number }): Promise<ReadFileWindowResult> {
  const failed = (error: unknown): never => {
    if (error instanceof BoxFsUnavailableError) throw new ToolError(error.code, error.message);
    throw new ToolError("INVALID_ARGUMENT", "Unable to read file.");
  };
  let fileStat;
  try {
    fileStat = await fs.stat(safe);
  } catch (error) {
    if (errnoOf(error) === "ENOTDIR") throw new ToolError("INVALID_ARGUMENT", "File not found.");
    return failed(error);
  }
  if (fileStat === null) throw new ToolError("INVALID_ARGUMENT", "File not found.");
  if (fileStat.kind === "dir") throw new FsDirectoryError();
  if (fileStat.kind !== "file") throw new ToolError("INVALID_ARGUMENT", "Path is not a regular file.");
  const offset = normalizeOffset(opts?.offset);
  const maxBytes = normalizeMaxBytes(opts?.maxBytes);
  const sniffLength = Math.min(8 * 1024, fileStat.size);
  if (sniffLength > 0) {
    const head = await fs.read(safe, { length: sniffLength }).catch(failed);
    if (head.includes(0)) throw new ToolError("INVALID_ARGUMENT", "Refusing to read binary file.");
  }
  const readLength = offset < fileStat.size ? Math.min(maxBytes, fileStat.size - offset) : 0;
  // Up to 3 bytes past the window, as on the host.
  const extra = Math.max(0, Math.min(3, fileStat.size - offset - readLength));
  const buffer = readLength > 0 ? await fs.read(safe, { offset, length: readLength + extra }).catch(failed) : Buffer.alloc(0);
  return windowResult(safe, buffer, buffer.length, readLength, offset, fileStat.size);
}

function entryKind(entry: Dirent): FsEntryKind {
  if (entry.isDirectory()) {
    return "dir";
  }
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function assertTextFile(file: Awaited<ReturnType<typeof open>>, size: number): Promise<void> {
  const sniffLength = Math.min(8 * 1024, size);
  if (sniffLength === 0) {
    return;
  }
  const buffer = Buffer.allocUnsafe(sniffLength);
  const { bytesRead } = await file.read(buffer, 0, sniffLength, 0);
  if (buffer.subarray(0, bytesRead).includes(0)) {
    throw new ToolError("INVALID_ARGUMENT", "Refusing to read binary file.");
  }
}
