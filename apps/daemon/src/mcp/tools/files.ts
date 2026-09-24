import { z } from "zod";
import { DEFAULT_READ_BYTES, MAX_FS_ENTRIES, MAX_READ_BYTES, type ListFilesResult } from "../fs-tools.ts";
import { MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import { defineTool, READ_ONLY, type ToolDef } from "../tool.ts";

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

const listFiles = defineTool({
  name: "list_files",
  title: "List files",
  description: `List a directory inside the workspaces sandbox (absolute path, or relative to the sandbox root): each entry's name, kind (dir, file, symlink, other) and size, sorted by name. At most ${MAX_FS_ENTRIES} entries, fewer when one result cannot hold them; truncated:true means some were left out.`,
  input: { path: z.string().min(1).describe("Directory path: absolute, or relative to the sandbox root.") },
  annotations: READ_ONLY,
  async run(args, ctx) {
    return fitListing(await ctx.files.listFiles(args.path));
  }
});

const readFile = defineTool({
  name: "read_file",
  title: "Read a file",
  // A window never splits a character (fs-tools.ts): one narrower than the character at `offset` takes that character
  // whole — up to 4 bytes, past a maxBytes under 4 — so paging always advances. Both descriptions say so.
  description: `Read a text file inside the workspaces sandbox (absolute path, or relative to the sandbox root) as a byte window: from \`offset\`, at most \`maxBytes\` (default ${DEFAULT_READ_BYTES}), or one whole character when maxBytes is smaller than it. A window too large for one result comes back shorter. truncated:true means more follows: call again with offset = nextOffset. Binary files are refused.`,
  input: {
    path: z.string().min(1).describe("File path: absolute, or relative to the sandbox root."),
    offset: z.number().int().min(0).default(0).describe("Byte offset to start at: 0, or the previous result's nextOffset."),
    maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(DEFAULT_READ_BYTES).describe(`Most bytes to read (max ${MAX_READ_BYTES}), or one whole character when maxBytes is smaller than it; fewer come back when one result cannot hold them.`)
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    // FsTools reads byte windows, so the window is what shrinks until the result fits: each pass scales it by
    // the room left for the text, and always by at least one byte.
    let window = args.maxBytes;
    for (;;) {
      const read = await ctx.files.readFileWindow(args.path, { offset: args.offset, maxBytes: window });
      // A window ends on a character boundary, so it can cover fewer bytes than asked: the next one starts right
      // after the bytes it consumed, never at offset + window. nextOffset says so; `consumed` is not repeated.
      const { consumed, ...page } = read;
      const result: Record<string, unknown> = read.truncated ? { ...page, nextOffset: read.offset + consumed } : { ...page };
      const size = resultBytes(result);
      if (size <= MAX_RESULT_BYTES || window === 1) return result;
      const overhead = resultBytes({ ...result, text: "" });
      window = Math.max(1, Math.min(window - 1, Math.floor((window * (MAX_RESULT_BYTES - overhead)) / (size - overhead))));
    }
  }
});

export const fileTools: ToolDef[] = [listFiles, readFile] as ToolDef[];
