import { FsSandboxError } from "@orquester/config/fs";
import { TodoError } from "../todos.ts";
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
 * `text` in at most `max` code points, the last of them a "…" when anything was cut: how the tools shorten a text they
 * quote in a message — a caller's value (an item, a tool name, an id) or a list's own text. (transcript.ts keeps its
 * own copy, `capped`.)
 */
export function clipText(text: string, max: number): string {
  return capText(text, max).truncated ? `${capText(text, max - 1).text}…` : text;
}

/** The most of a caller's value — an id, a tool name, an item — a message quotes back, in code points. */
export const MAX_ECHO_CHARS = 100;

/**
 * The most an error's message takes, in code points. A message quotes what the caller sent — an id, a path, a name —
 * and an error is not a result: ok()'s cap never sees it, so a 2 MiB argument echoed back would make a 2 MiB error.
 * The messages built to be long stay under it for any input, so it never cuts their tail: an INVALID_ARGUMENT names at
 * most five fields of ≤ 200 code points (about 1 050 in all); a todo refusal quotes at most 100 code points of the
 * caller's, JSON-escaped — up to 602 characters, as a control character or a lone surrogate escapes to six — and lists
 * at most 40 items of ≤ 70, 3 701 in all at worst for a 3 000-item list (todo-tools.test.ts builds that case).
 */
export const MAX_ERROR_MESSAGE_CHARS = 4_000;

/** A value's size as a result, as ok() measures it: its JSON text, in UTF-8 bytes. */
export const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** A string's size inside a JSON result: escaped, UTF-8, without its quotes. */
export const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

/** The longest prefix of `text` (never splitting a character) whose JSON size fits `budget` bytes. */
export function fitJsonBytes(text: string, budget: number): { text: string; truncated: boolean } {
  if (jsonBytes(text) <= budget) return { text, truncated: false };
  // Every character costs at least one byte, so the answer is at most `budget` characters long.
  let lo = 0;
  let hi = Math.max(0, budget);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(capText(text, mid).text) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { text: capText(text, lo).text, truncated: true };
}

/** How many bytes the UTF-8 character a lead byte starts takes (1 for ASCII, or for a byte no character starts with). */
export function utf8SequenceLength(lead: number): number {
  return lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}

/**
 * How many leading bytes of `bytes` end on a UTF-8 character boundary: all of them, unless the last character is cut
 * short, in which case it is left out whole. Judged from the bytes present only — a lead byte announces its
 * character's length — so a reader can cut a window without the byte after it. Bytes that are not UTF-8 are not cut.
 */
export function wholeUtf8Length(bytes: Uint8Array): number {
  const n = bytes.length;
  // The last character's lead byte is at most 3 continuation bytes (10xxxxxx) back.
  for (let i = n - 1; i >= 0 && i >= n - 4; i -= 1) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue;
    return i + utf8SequenceLength(b) <= n ? n : i;
  }
  return n;
}

/** The cap as the notes spell it: "60 000". */
const CAP_LABEL = String(MAX_RESULT_BYTES).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * A successful tool result: the object as text AND as structuredContent, capped at MAX_RESULT_BYTES. Over it is the
 * last resort — every tool that can grow bounds itself first, so any tool may land here and the note names none of
 * their parameters. The text keeps the JSON's leading bytes, cut on a character boundary, and ENDS with the note, where
 * the model reads it; a cut object is no JSON, so structuredContent keeps only `truncated` and the note.
 */
export function ok(value: Record<string, unknown>): { content: [TextContent]; structuredContent: Record<string, unknown> } {
  const text = JSON.stringify(value);
  const size = Buffer.byteLength(text, "utf8");
  if (size <= MAX_RESULT_BYTES) return { content: [{ type: "text", text }], structuredContent: value };
  const over = size - MAX_RESULT_BYTES;
  const marker = `… [truncated: ${over} bytes over the ${CAP_LABEL}-byte cap]`;
  const head = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES - Buffer.byteLength(marker, "utf8"));
  return {
    content: [{ type: "text", text: `${head.subarray(0, wholeUtf8Length(head)).toString("utf8")}${marker}` }],
    structuredContent: { truncated: true, truncationNote: `The result was ${over} bytes over the ${CAP_LABEL}-byte cap and was cut; narrow the request.` }
  };
}

/**
 * Map any thrown error to an isError result with a SAFE message (no path/stack leak), capped at MAX_ERROR_MESSAGE_CHARS
 * whatever it quotes.
 */
export function toSafeToolError(err: unknown): { content: [TextContent]; structuredContent: { code: string; message: string; detail?: unknown }; isError: true } {
  let code = "INTERNAL";
  let message = "Internal error handling the tool call.";
  let detail: unknown;
  if (err instanceof ToolError) {
    ({ code, message, detail } = err);
  } else if (err instanceof FsSandboxError) {
    code = "PATH_NOT_ALLOWED";
    message = "Path is not allowed (outside the sandbox).";
  } else if (err instanceof TodoError) {
    // The todo store's own messages ("todo not found", "invalid scope") carry no path or stack.
    code = err.status === 404 ? "NOT_FOUND" : err.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT";
    message = err.message;
  } else {
    console.error("[mcp] unexpected tool error", err);
  }
  message = clipText(message, MAX_ERROR_MESSAGE_CHARS);
  const structured: { code: string; message: string; detail?: unknown } = { code, message };
  if (detail !== undefined) structured.detail = detail;
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: structured, isError: true };
}
