/**
 * Session tools — a TEST-ONLY toolkit. Never listed in `index.ts`: the
 * framework's tests register it through `createSessionToolRegistry` to drive
 * every path (context echo, image content, a handler error, a wait that only
 * cancellation ends).
 */

import { z } from "zod";

import {
  defineSessionTool,
  defineSessionToolkit,
  SESSION_TOOL_MUTATING,
  SESSION_TOOL_READ_ONLY
} from "./contract.ts";
import { createSessionToolRegistry, type SessionToolRegistry } from "./registry.ts";
import { imageResult, jsonResult, ToolError } from "./results.ts";

/** A 1×1 transparent PNG. */
export const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const TEST_TOOLKIT_INSTRUCTIONS = "Test toolkit: call `echo` to see your own context.";

export const testSessionToolkit = defineSessionToolkit({
  id: "test",
  instructions: TEST_TOOLKIT_INSTRUCTIONS,
  tools: [
    defineSessionTool({
      name: "echo",
      title: "Echo",
      description: "Returns the text and the caller's context as the daemon derived it.",
      input: { text: z.string().max(1000) },
      annotations: SESSION_TOOL_READ_ONLY,
      resultKind: "json",
      run: async (args, ctx) =>
        jsonResult({
          text: args.text,
          threadId: ctx.threadId,
          projectPath: ctx.projectPath,
          cwd: ctx.cwd,
          agentId: ctx.agentId,
          callId: ctx.callId
        })
    }),
    defineSessionTool({
      name: "wait_for_cancel",
      title: "Wait for cancel",
      description: "Waits until the call is cancelled, then reports it.",
      input: {},
      annotations: SESSION_TOOL_READ_ONLY,
      resultKind: "json",
      run: (_args, ctx) =>
        new Promise((resolve) => {
          const done = () => resolve(jsonResult({ cancelled: true }));
          if (ctx.signal.aborted) done();
          else ctx.signal.addEventListener("abort", done, { once: true });
        })
    }),
    defineSessionTool({
      name: "pixel",
      title: "Pixel",
      description: "Returns a 1×1 PNG and its size.",
      input: {},
      annotations: SESSION_TOOL_READ_ONLY,
      resultKind: "image",
      run: async () => imageResult({ data: TEST_PNG_BASE64, mimeType: "image/png" }, { width: 1, height: 1 })
    }),
    defineSessionTool({
      name: "fail",
      title: "Fail",
      description: "Always fails with a coded error.",
      input: {},
      annotations: SESSION_TOOL_MUTATING,
      resultKind: "text",
      run: async () => {
        throw new ToolError("CONFLICT", "This tool always fails.");
      }
    })
  ]
});

export function testSessionToolRegistry(): SessionToolRegistry {
  return createSessionToolRegistry([testSessionToolkit]);
}
