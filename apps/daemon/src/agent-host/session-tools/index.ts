/**
 * Agent host — session tools, the host's half (design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §1).
 *
 * One {@link SessionToolsHost} per host process, handed to every adapter as
 * `AdapterContext.sessionTools` — and only when at least one toolkit is
 * registered: an adapter without it attaches no `orquester` server. The host
 * advertises the registered definitions, files every call under its thread,
 * forwards it to the daemon (`forwarder.ts`) and aborts it when the provider
 * cancels it, the turn is interrupted, or the credential it came in on is
 * revoked. Handlers never run here.
 *
 * Per provider (§1.2):
 * - Claude: an in-process SDK server bound to the thread at launch
 *   (`adapters/claude/session-tools.ts`) → {@link SessionToolsHost.call}.
 * - Codex, Grok, OpenCode: {@link SessionToolsHost.issue} a credential per
 *   provider session; the provider reaches the loopback endpoint
 *   (`endpoint.ts`) with it, and the adapter revokes it when the session ends.
 */

import { randomUUID } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionToolDefinition } from "../../session-tools/contract.ts";
import type { SessionToolRegistry } from "../../session-tools/registry.ts";
import { cancelledResult, errorResult } from "../../session-tools/results.ts";
import { SessionToolCredentials } from "./credentials.ts";
import { startSessionToolsEndpoint, type SessionToolsEndpoint } from "./endpoint.ts";
import type { ForwardSessionToolCall } from "./forwarder.ts";

/** One provider session's way in: what an adapter hands its provider, and its own revoke. */
export interface SessionToolsGrant {
  readonly threadId: string;
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  /**
   * The raw credential. Goes to the provider through child env or a protocol
   * frame only — never argv, a log line, or a file.
   */
  readonly token: string;
  /** `Bearer <token>`. */
  readonly authorization: string;
  /** Revoke it, aborting every call made with it. Idempotent. */
  revoke(): void;
}

export interface SessionToolsCallInput {
  threadId: string;
  name: string;
  arguments: unknown;
  callId?: string;
  signal?: AbortSignal;
}

export interface SessionToolsHost {
  /** Always true for a host an adapter is handed (the host hands none otherwise); kept for tests. */
  readonly enabled: boolean;
  readonly tools: readonly SessionToolDefinition[];
  /** The composed "Orquester" instruction block (§1.4). */
  readonly instructions: string;
  /** Run one call as `threadId` — Claude's in-process path, and the endpoint's. Never throws. */
  call(input: SessionToolsCallInput): Promise<CallToolResult>;
  /** Issue a credential for one provider session of `threadId`, revoking the thread's earlier ones. */
  issue(threadId: string): Promise<SessionToolsGrant>;
  /** Abort every call `threadId` has in flight (its turn was interrupted). */
  abortThreadCalls(threadId: string): void;
  /** Revoke everything and close the endpoint (the host's teardown). */
  stop(): Promise<void>;
}

export interface CreateSessionToolsHostOptions {
  registry: SessionToolRegistry;
  forward: ForwardSessionToolCall;
  credentials?: SessionToolCredentials;
  logger?: { warn(message: string, detail?: unknown): void };
}

interface InFlightCall {
  readonly threadId: string;
  readonly grantId: string | undefined;
  readonly controller: AbortController;
}

export function createSessionToolsHost(options: CreateSessionToolsHostOptions): SessionToolsHost {
  const credentials = options.credentials ?? new SessionToolCredentials();
  const inFlight = new Set<InFlightCall>();
  let endpoint: Promise<SessionToolsEndpoint> | null = null;
  let stopped = false;

  const abortWhere = (predicate: (call: InFlightCall) => boolean): void => {
    for (const call of [...inFlight]) {
      if (predicate(call)) call.controller.abort();
    }
  };
  credentials.onRevoke((scope) => abortWhere((call) => call.grantId === scope.grantId));

  const run = async (input: SessionToolsCallInput, grantId: string | undefined): Promise<CallToolResult> => {
    if (options.registry.get(input.name) === undefined) {
      return errorResult("NOT_FOUND", `Session tool ${input.name.slice(0, 100)} not found.`);
    }
    const controller = new AbortController();
    const entry: InFlightCall = { threadId: input.threadId, grantId, controller };
    const abort = () => controller.abort();
    if (input.signal?.aborted) return cancelledResult();
    input.signal?.addEventListener("abort", abort, { once: true });
    inFlight.add(entry);
    try {
      return await options.forward(
        {
          threadId: input.threadId,
          callId: input.callId ?? `call-${randomUUID()}`,
          name: input.name,
          arguments: input.arguments
        },
        controller.signal
      );
    } finally {
      inFlight.delete(entry);
      input.signal?.removeEventListener("abort", abort);
    }
  };

  const ensureEndpoint = (): Promise<SessionToolsEndpoint> => {
    endpoint ??= startSessionToolsEndpoint({
      credentials,
      tools: options.registry.tools,
      invoke: (scope, invocation) =>
        run(
          {
            threadId: scope.threadId,
            name: invocation.name,
            arguments: invocation.arguments,
            ...(invocation.callId !== undefined ? { callId: invocation.callId } : {}),
            signal: invocation.signal
          },
          scope.grantId
        ),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    }).catch((error: unknown) => {
      // A failed bind is retried by the next issue rather than cached.
      endpoint = null;
      throw error;
    });
    return endpoint;
  };

  return {
    enabled: options.registry.enabled,
    tools: options.registry.tools,
    instructions: options.registry.instructions,
    call: (input) => run(input, undefined),
    async issue(threadId) {
      if (stopped) throw new Error("session tools: the host is stopping");
      const { url } = await ensureEndpoint();
      const issued = credentials.issue(threadId);
      return {
        threadId,
        url,
        token: issued.token,
        authorization: `Bearer ${issued.token}`,
        revoke: () => credentials.revokeGrant(issued.grantId)
      };
    },
    abortThreadCalls: (threadId) => abortWhere((call) => call.threadId === threadId),
    async stop() {
      stopped = true;
      credentials.revokeAll();
      abortWhere(() => true);
      const open = endpoint;
      endpoint = null;
      if (open !== null) {
        await open.then((server) => server.close()).catch(() => undefined);
      }
    }
  };
}

/**
 * An adapter's way to get its grant: the context's service issues one, and
 * a failure (the endpoint could not bind, the host is stopping) costs the
 * session its tools — logged — never its start. Undefined without session
 * tools.
 */
export async function issueSessionToolsGrant(
  context: { sessionTools?: SessionToolsHost; logger: { warn(message: string, detail?: unknown): void } },
  threadId: string
): Promise<SessionToolsGrant | undefined> {
  if (context.sessionTools === undefined) {
    return undefined;
  }
  try {
    return await context.sessionTools.issue(threadId);
  } catch (error) {
    context.logger.warn("session tools: no credential for this session; it runs without them", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

export { SessionToolCredentials } from "./credentials.ts";
export { createDaemonForwarder } from "./forwarder.ts";
