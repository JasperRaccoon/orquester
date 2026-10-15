// Catalog family module `files` (read_file) — plan Task 9 (unified MCP design 2026-10-15 §4 row 20, §5.1 ruling S6,
// D-19): a file (paged) or a directory listing, through `DaemonApi.readFileRange` / `listDirectory`.
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { DEFAULT_READ_BYTES, FsDirectoryError, MAX_FS_ENTRIES, MAX_READ_BYTES, type ListFilesResult } from "../fs-tools.ts";
import { MAX_RESULT_BYTES, resultBytes } from "../result.ts";

/**
 * A listing that fits one result (ok() cuts anything over MAX_RESULT_BYTES and loses its fields):
 * over budget, the entries after the last one that fits are dropped and truncated is set.
 */
function fitListing(listing: ListFilesResult): ListFilesResult {
  if (resultBytes(listing) <= MAX_RESULT_BYTES) return listing;
  let used = resultBytes({ ...listing, entries: [], truncated: true });
  let kept = 0;
  for (const entry of listing.entries) {
    const cost = resultBytes(entry) + (kept > 0 ? 1 : 0); // the separating comma
    if (used + cost > MAX_RESULT_BYTES) break;
    used += cost;
    kept += 1;
  }
  return { ...listing, entries: listing.entries.slice(0, kept), truncated: true };
}

/**
 * The path a call reads: a chat caller's relative path is taken from its working directory (the one the gate
 * classified, §5.1), an external caller's from the sandbox root (as `read_file` always took it).
 */
function targetPath(path: string, caller: ToolCaller): string {
  return caller.kind === "thread" && !isAbsolute(path) ? resolve(caller.cwd || "/", path) : path;
}

/** The two `DaemonApi` file reads, or UNAVAILABLE where the seam has none (a test double). */
function fileApi(api: DaemonApi): Required<Pick<DaemonApi, "listDirectory" | "readFileRange">> {
  if (!api.listDirectory || !api.readFileRange) throw new ToolError("UNAVAILABLE", "File reads are not available here.");
  return { listDirectory: api.listDirectory.bind(api), readFileRange: api.readFileRange.bind(api) };
}

const readFile = defineTool({
  name: "read_file",
  title: "Read a file or directory",
  // A window never splits a character (fs-tools.ts): one narrower than the character at `offset` takes that character
  // whole — up to 4 bytes, past a maxBytes under 4 — so paging always advances.
  description: `A text file as a byte window from \`offset\` (≤ maxBytes, whole characters; truncated: more at nextOffset), or a directory's entries (name, kind, size; ≤ ${MAX_FS_ENTRIES}). Binary files are refused.`,
  chatNote: "Only inside a project; relative to this chat's directory.",
  externalNote: "In the sandbox; relative to its root.",
  input: {
    path: z.string().min(1),
    offset: z.number().int().min(0).default(0),
    maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(DEFAULT_READ_BYTES)
  },
  audiences: ["external", "chat"],
  toolset: "files-git",
  tier: "read",
  // The gate classifies the path (inside a project DIRECTORY, else PERMISSION_DENIED — a file beside the projects,
  // `<ws>/notes.txt`, included: `classifyPath`) and judges its project's content read.
  async scope(args) {
    return { projects: [], sessions: [], reads: "content", writes: false, causesTurnIn: [], paths: [args.path] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, { api, caller }) {
    const files = fileApi(api);
    const path = targetPath(args.path, caller);
    // FsTools reads byte windows, so the window is what shrinks until the result fits: each pass scales it by the room
    // left for the text, and always by at least one byte.
    let window = args.maxBytes;
    for (;;) {
      let read;
      try {
        read = await files.readFileRange(path, { offset: args.offset, maxBytes: window });
      } catch (error) {
        if (error instanceof FsDirectoryError) return { kind: "directory", ...fitListing(await files.listDirectory(path)) };
        throw error;
      }
      // A window ends on a character boundary, so it can cover fewer bytes than asked: the next one starts right after
      // the bytes it consumed, never at offset + window. nextOffset says so; `consumed` is not repeated.
      const { consumed, ...page } = read;
      const result: Record<string, unknown> = read.truncated ? { kind: "file", ...page, nextOffset: read.offset + consumed } : { kind: "file", ...page };
      const size = resultBytes(result);
      if (size <= MAX_RESULT_BYTES || window === 1) return result;
      const overhead = resultBytes({ ...result, text: "" });
      window = Math.max(1, Math.min(window - 1, Math.floor((window * (MAX_RESULT_BYTES - overhead)) / (size - overhead))));
    }
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const filesFamily: readonly AnyOrquesterTool[] = [readFile];
