/**
 * Test scaffolding only: a {@link SessionToolsHost} that records every call
 * and issue, over the framework's test-only toolkit
 * (`../../session-tools/testing.ts`). `wait_for_cancel` parks until its call
 * is cancelled. Every thread's "manifest" is the whole toolkit, the toolkit's
 * instruction block and `deny` (default none); `setManifest` changes one
 * thread's, as a refresh from the daemon would.
 */

import { createHash } from "node:crypto";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { legacyChatTools } from "../../mcp/catalog/legacy.ts";
import type { SessionToolRegistry } from "../../session-tools/registry.ts";
import { testSessionToolRegistry } from "../../session-tools/testing.ts";
import { serializeChatTools } from "./definitions.ts";
import type {
  LiveSessionToolsListener,
  PreparedSessionTools,
  SessionToolsApplied,
  SessionToolsCallInput,
  SessionToolsGrant,
  SessionToolsHost
} from "./index.ts";

export interface RecordingSessionTools extends SessionToolsHost {
  readonly calls: SessionToolsCallInput[];
  /** Every grant issued, in order, with whether it was revoked. */
  readonly grants: Array<SessionToolsGrant & { revoked: boolean }>;
  readonly abortedThreads: string[];
  /** The toolkit's instruction block (what every prepared list carries). */
  readonly instructions: string;
  /** Resolves with the next call made from now on. */
  nextCall(): Promise<SessionToolsCallInput>;
}

export interface RecordingSessionToolsOptions {
  /** MCP server names every thread denies. */
  deny?: readonly string[];
}

export function recordingSessionTools(
  registry: SessionToolRegistry = testSessionToolRegistry(),
  options: RecordingSessionToolsOptions = {}
): RecordingSessionTools {
  const calls: SessionToolsCallInput[] = [];
  const callWaiters: Array<(call: SessionToolsCallInput) => void> = [];
  const grants: Array<SessionToolsGrant & { revoked: boolean }> = [];
  const abortedThreads: string[] = [];
  const entries: Promise<Tool[]> = serializeChatTools(legacyChatTools(registry.tools));
  const knownNames = new Set(registry.tools.map((tool) => tool.name));
  const launched = new Map<string, { prepared: PreparedSessionTools; live?: LiveSessionToolsListener }>();

  const prepare = async (threadId: string, names?: readonly string[]): Promise<PreparedSessionTools> => {
    const all = await entries;
    const tools = names === undefined ? all : all.filter((tool) => names.includes(tool.name));
    const deny = [...(options.deny ?? [])];
    return {
      threadId,
      tools,
      names: new Set(tools.map((tool) => tool.name)),
      instructions: registry.instructions,
      deny,
      key: createHash("sha256").update(JSON.stringify([tools.map((tool) => tool.name), registry.instructions, deny])).digest("hex"),
      source: "manifest"
    };
  };

  return {
    calls,
    grants,
    abortedThreads,
    instructions: registry.instructions,
    nextCall: () => new Promise((resolve) => callWaiters.push(resolve)),
    enabled: true,
    knownNames,
    prepare: (threadId) => prepare(threadId),
    async launchInProcess(threadId, _agent, listener) {
      const prepared = await prepare(threadId);
      const entry = { prepared, live: listener };
      launched.set(threadId, entry);
      return {
        prepared,
        release: () => {
          if (launched.get(threadId) === entry) launched.delete(threadId);
        }
      };
    },
    current: (threadId) => launched.get(threadId)?.prepared ?? null,
    listSource: (threadId) => ({
      list: () => launched.get(threadId)?.prepared.tools ?? [],
      accepts: (name) => knownNames.has(name)
    }),
    async applyManifest(threadId, manifest): Promise<SessionToolsApplied> {
      const session = launched.get(threadId);
      if (!session) return "next-start";
      const next = await prepare(threadId, manifest.tools);
      if (session.live) {
        session.prepared = next;
        session.live(next);
        return "live";
      }
      return "next-idle";
    },
    needsRestart: () => false,
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
      const prepared = await prepare(threadId);
      launched.set(threadId, { prepared });
      const grant = {
        threadId,
        url: "http://127.0.0.1:65000/mcp",
        deniedUrl: "http://127.0.0.1:65000/mcp/denied",
        token,
        authorization: `Bearer ${token}`,
        prepared,
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
