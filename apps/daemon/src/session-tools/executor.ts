/**
 * Session tools — the daemon side of one call (design §1.1): look the tool
 * up, validate the arguments strictly, run the handler with the context the
 * route derived, and map whatever happens to a `CallToolResult`. Daemon-only:
 * the agent host never imports this module.
 */

import { z } from "zod";

import { ToolError } from "../mcp/errors.ts";
import { clipText, MAX_ECHO_CHARS, toSafeToolError } from "../mcp/result.ts";
import { argumentProblems } from "../mcp/server.ts";
import type { SessionToolContext, SessionToolResult } from "./contract.ts";
import type { SessionToolRegistry } from "./registry.ts";
import { cancelledResult } from "./results.ts";

/** A result is a record with a `content` array; anything else a handler returns is a bug. */
function isCallToolResult(value: unknown): value is SessionToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export async function executeSessionToolCall(
  registry: SessionToolRegistry,
  call: { name: string; arguments: unknown },
  ctx: SessionToolContext
): Promise<SessionToolResult> {
  const tool = registry.get(call.name);
  if (!tool) {
    return toSafeToolError(
      new ToolError("NOT_FOUND", `Session tool ${clipText(call.name, MAX_ECHO_CHARS)} not found.`)
    );
  }
  // Strict, as the external /mcp server: a misspelled key is refused rather
  // than silently taking a default. No `arguments` at all is `{}`.
  const parsed = await z.object(tool.input).strict().safeParseAsync(call.arguments ?? {});
  if (!parsed.success) {
    return toSafeToolError(new ToolError("INVALID_ARGUMENT", argumentProblems(tool.name, parsed.error)));
  }
  if (ctx.signal.aborted) {
    return cancelledResult();
  }
  try {
    const result = await tool.run(parsed.data, ctx);
    if (!isCallToolResult(result)) {
      throw new Error(`session tool ${tool.name} returned no CallToolResult`);
    }
    return result;
  } catch (error) {
    // A wait that ended because the caller went away is a cancellation, not
    // an internal error: nothing reads it, but it must not be logged as one.
    if (ctx.signal.aborted && !(error instanceof ToolError)) {
      return cancelledResult();
    }
    return toSafeToolError(error);
  }
}
