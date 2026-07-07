import { open, opendir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./terminal-control.ts";

export const MAX_FS_ENTRIES = 500;
export const DEFAULT_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;

type FsEntryKind = "dir" | "file" | "symlink" | "other";

export type ListFilesResult = {
  path: string;
  entries: { name: string; kind: FsEntryKind; size: number }[];
  truncated: boolean;
};

export type ReadFileWindowResult = {
  path: string;
  text: string;
  size: number;
  offset: number;
  truncated: boolean;
};

function safeSandboxError(): FsSandboxError {
  return new FsSandboxError("Path is not allowed (outside the sandbox).");
}

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
  constructor(private readonly opts: { fsRoot: string }) {}

  async listFiles(path: string): Promise<ListFilesResult> {
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
        throw new ToolError("Directory not found.");
      }
      if (code === "ENOTDIR") {
        throw new ToolError("Path is not a directory. Use read_file instead.");
      }
      throw new ToolError("Unable to list directory.");
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
    const safe = await this.resolvePath(path);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(safe);
    } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ToolError("File not found.");
      }
      throw new ToolError("Unable to read file.");
    }

    if (fileStat.isDirectory()) {
      throw new ToolError("Path is a directory. Use list_files instead.");
    }
    if (!fileStat.isFile()) {
      throw new ToolError("Path is not a regular file.");
    }

    const offset = normalizeOffset(opts?.offset);
    const maxBytes = normalizeMaxBytes(opts?.maxBytes);
    const file = await open(safe, "r").catch(() => {
      throw new ToolError("Unable to read file.");
    });
    try {
      await assertTextFile(file, fileStat.size);
      const readLength = offset < fileStat.size ? Math.min(maxBytes, fileStat.size - offset) : 0;
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = readLength > 0 ? await file.read(buffer, 0, readLength, offset) : { bytesRead: 0 };
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        path: safe,
        text,
        size: fileStat.size,
        offset,
        truncated: offset + bytesRead < fileStat.size,
      };
    } finally {
      await file.close();
    }
  }

  private async resolvePath(path: string): Promise<string> {
    const target = isAbsolute(path) ? path : join(this.opts.fsRoot, path);
    try {
      return await assertInsideFsRoot(this.opts.fsRoot, target);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        throw safeSandboxError();
      }
      throw error;
    }
  }
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
    throw new ToolError("Refusing to read binary file.");
  }
}
