import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";

/** Claude Code discards MCP results above ~25k tokens; stay well under (spec §4.5). */
export const MAX_RESULT_BYTES = 60_000;

type TextContent = { type: "text"; text: string };

export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: Array.from(text).slice(0, maxChars).join(""), truncated: true };
}

/** A successful tool result: the object as text AND as structuredContent, capped. */
export function ok(value: Record<string, unknown>): { content: [TextContent]; structuredContent: Record<string, unknown> } {
  let text = JSON.stringify(value);
  let structured = value;
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    // Last-resort shed: the tool should have bounded itself; keep the shape honest.
    const capped = { ...value, truncated: true, truncationNote: `Result exceeded ${MAX_RESULT_BYTES} bytes; narrow the request (fewer turns, smaller maxChars).` };
    text = JSON.stringify(capped);
    structured = capped;
    if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
      text = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES - 3).toString("utf8").replace(/�+$/u, "") + "...";
    }
  }
  return { content: [{ type: "text", text }], structuredContent: structured };
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
