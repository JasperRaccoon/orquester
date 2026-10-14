/**
 * Test scaffolding only: a {@link SessionToolsHost} that records every call
 * and issue, over the framework's test-only toolkit
 * (`../../session-tools/testing.ts`). `wait_for_cancel` parks until its call
 * is cancelled.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionToolRegistry } from "../../session-tools/registry.ts";
import { testSessionToolRegistry } from "../../session-tools/testing.ts";
import type { SessionToolsCallInput, SessionToolsGrant, SessionToolsHost } from "./index.ts";

export interface RecordingSessionTools extends SessionToolsHost {
  readonly calls: SessionToolsCallInput[];
  /** Every grant issued, in order, with whether it was revoked. */
  readonly grants: Array<SessionToolsGrant & { revoked: boolean }>;
  readonly abortedThreads: string[];
  /** Resolves with the next call made from now on. */
  nextCall(): Promise<SessionToolsCallInput>;
}

export function recordingSessionTools(registry: SessionToolRegistry = testSessionToolRegistry()): RecordingSessionTools {
  const calls: SessionToolsCallInput[] = [];
  const callWaiters: Array<(call: SessionToolsCallInput) => void> = [];
  const grants: Array<SessionToolsGrant & { revoked: boolean }> = [];
  const abortedThreads: string[] = [];
  return {
    calls,
    grants,
    abortedThreads,
    nextCall: () => new Promise((resolve) => callWaiters.push(resolve)),
    enabled: true,
    tools: registry.tools,
    instructions: registry.instructions,
    async call(input): Promise<CallToolResult> {
      calls.push(input);
      callWaiters.splice(0).forEach((wake) => wake(input));
      if (input.name === "wait_for_cancel") {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { content: [{ type: "text", text: "cancelled" }], isError: true };
      }
      return { content: [{ type: "text", text: `ran ${input.name} for ${input.threadId}` }] };
    },
    async issue(threadId) {
      const token = `test-credential-${grants.length + 1}-${"x".repeat(32)}`;
      const grant = {
        threadId,
        url: "http://127.0.0.1:65000/mcp",
        token,
        authorization: `Bearer ${token}`,
        revoked: false,
        revoke: () => {
          grant.revoked = true;
        }
      };
      grants.push(grant);
      return grant;
    },
    abortThreadCalls: (threadId) => {
      abortedThreads.push(threadId);
    },
    stop: async () => {}
  };
}
