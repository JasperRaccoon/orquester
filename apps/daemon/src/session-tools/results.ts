/**
 * Session tools — result helpers. A handler returns one of these; nothing
 * else builds a `CallToolResult` by hand.
 *
 * The JSON form is the external `/mcp` server's (`../mcp/result.ts` `ok`): the
 * object as text AND as `structuredContent`, capped at 60 000 bytes. The text
 * copy matters: Claude's `tool_result` and OpenCode's output keep only the
 * text, and the timeline reads a tool's reference fields back out of it
 * (`@orquester/api` `session-tools.ts`).
 */

import { ToolError } from "../mcp/errors.ts";
import { ok, toSafeToolError } from "../mcp/result.ts";
import type { SessionToolResult } from "./contract.ts";

export { ToolError };

/** A JSON result: `value` as text and as `structuredContent` (60 000-byte cap, `ok`). */
export function jsonResult(value: Record<string, unknown>): SessionToolResult {
  return ok(value);
}

/** A plain-text result. */
export function textResult(text: string): SessionToolResult {
  return { content: [{ type: "text", text }] };
}

/** One image, inline. */
export interface SessionToolImage {
  /** Base64, no `data:` prefix. */
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

/**
 * An image result (MCP image content), optionally followed by a JSON object
 * as text and `structuredContent` — e.g. a screenshot with its measurements.
 * The image comes first, as providers render content in order.
 */
export function imageResult(image: SessionToolImage, value?: Record<string, unknown>): SessionToolResult {
  if (value === undefined) {
    return { content: [{ type: "image", data: image.data, mimeType: image.mimeType }] };
  }
  const json = ok(value);
  return {
    content: [{ type: "image", data: image.data, mimeType: image.mimeType }, ...json.content],
    structuredContent: json.structuredContent
  };
}

/** An `isError` result with a code, as `ToolError` would produce. */
export function errorResult(code: string, message: string): SessionToolResult {
  return toSafeToolError(new ToolError(code, message));
}

/**
 * The text a call answers with while the daemon cannot be reached (§1.1): an
 * error result the agent can act on, never a crash or a hang.
 */
export const DAEMON_UNAVAILABLE_MESSAGE = "Orquester is restarting; retry in a few seconds.";

export function daemonUnavailableResult(): SessionToolResult {
  return { content: [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }], isError: true };
}

/** What a call answers once it was cancelled (the provider stopped waiting for it). */
export function cancelledResult(): SessionToolResult {
  return errorResult("CANCELLED", "The call was cancelled.");
}
