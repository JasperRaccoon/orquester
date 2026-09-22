import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";

/** Claude Code discards MCP results above ~25k tokens; stay well under (spec §4.5). */
export const MAX_RESULT_BYTES = 60_000;

type TextContent = { type: "text"; text: string };

/** Cut `text` to at most `maxChars` characters, counted and cut in code points so a surrogate pair never splits. */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }; // never more code points than UTF-16 units
  let chars = 0;
  let end = 0;
  for (const char of text) {
    if (chars >= maxChars) return { text: text.slice(0, end), truncated: true };
    chars += 1;
    end += char.length;
  }
  return { text, truncated: false };
}

/**
 * A successful tool result: the object as text AND as structuredContent, capped at
 * MAX_RESULT_BYTES. Over budget is a last-resort shed (the tool should have bounded itself):
 * the object gains `truncated` + `truncationNote`. When even that is too big, the text keeps the
 * capped JSON's leading bytes (cut on a character boundary, then "...") so the model still
 * sees the start, and structuredContent keeps only those two fields.
 */
export function ok(value: Record<string, unknown>): { content: [TextContent]; structuredContent: Record<string, unknown> } {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return { content: [{ type: "text", text }], structuredContent: value };
  const truncationNote = `Result exceeded ${MAX_RESULT_BYTES} bytes; narrow the request (fewer turns, smaller maxChars).`;
  const capped = { ...value, truncated: true, truncationNote };
  const cappedText = JSON.stringify(capped);
  if (Buffer.byteLength(cappedText, "utf8") <= MAX_RESULT_BYTES) return { content: [{ type: "text", text: cappedText }], structuredContent: capped };
  // A cut through a multibyte character decodes to a trailing U+FFFD; drop it so the cut is a whole character.
  const head = Buffer.from(cappedText, "utf8").subarray(0, MAX_RESULT_BYTES - 3).toString("utf8").replace(/\uFFFD+$/u, "");
  return { content: [{ type: "text", text: `${head}...` }], structuredContent: { truncated: true, truncationNote } };
}

/** Map any thrown error to an isError result with a SAFE message (no path/stack leak). */
export function toSafeToolError(err: unknown): { content: [TextContent]; structuredContent: { code: string; message: string; detail?: unknown }; isError: true } {
  let code = "INTERNAL";
  let message = "Internal error handling the tool call.";
  let detail: unknown;
  if (err instanceof ToolError) {
    ({ code, message, detail } = err);
  } else if (err instanceof FsSandboxError) {
    code = "PATH_NOT_ALLOWED";
    message = "Path is not allowed (outside the sandbox).";
  } else {
    console.error("[mcp] unexpected tool error", err);
  }
  const structured: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) structured.detail = detail;
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: structured, isError: true };
}
