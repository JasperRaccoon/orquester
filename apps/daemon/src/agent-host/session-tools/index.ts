/**
 * Agent host — session tools, the host's half (design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §1; unified MCP design 2026-10-15 §9.4,
 * §12.1, §14.1).
 *
 * One {@link SessionToolsHost} per host process, handed to every adapter as
 * `AdapterContext.sessionTools`. It advertises a PER-THREAD list: at every provider-session start
 * the adapter asks {@link SessionToolsHost.prepare} (or {@link issueSessionToolsGrant}), which reads
 * the thread's manifest from the daemon (`{tools, instructions, deny}`) and filters the static
 * catalog (`definitions.ts`) by it — or, from a daemon that predates the manifest route, the frozen
 * legacy definitions (`legacy-definitions.ts`) its old handlers match. It files every call under
 * its thread, forwards it to the daemon (`forwarder.ts`) and aborts it when the provider cancels it,
 * the turn is interrupted, or the credential it came in on is revoked. Handlers never run here.
 *
 * A changed manifest (the thread's toolsets changed, `agentHostRoutes.sessionToolsRefresh`) is
 * applied in-session where the provider re-lists on `tools/list_changed` (Claude's in-process
 * server, {@link SessionToolsHost.launchInProcess}); any other live session is marked stale and the
 * orchestrator restarts it with resume at its next idle point ({@link SessionToolsHost.needsRestart}).
 *
 * Per provider (§1.2):
 * - Claude: an in-process SDK server bound to the thread at launch
 *   (`adapters/claude/session-tools.ts`) → {@link SessionToolsHost.call}.
 * - Codex, Grok, OpenCode: {@link SessionToolsHost.issue} a credential per
 *   provider session; the provider reaches the loopback endpoint
 *   (`endpoint.ts`) with it, and the adapter revokes it when the session ends.
 */

import { createHash, randomUUID } from "node:crypto";

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOOLSETS } from "@orquester/api";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import { catalogFor } from "../../mcp/catalog/index.ts";
import { composeOrquesterInstructions } from "../../session-tools/instructions.ts";
import { cancelledResult, errorResult } from "../../session-tools/results.ts";
import type { SessionToolsManifest } from "../host-protocol.ts";
import { SessionToolCredentials } from "./credentials.ts";
import { buildChatToolDefinitions, knownSessionToolNames, type AdvertisedTool, type ChatToolDefinitions } from "./definitions.ts";
import { startSessionToolsEndpoint, type SessionToolsEndpoint } from "./endpoint.ts";
import type { FetchSessionToolsManifest, ForwardSessionToolCall } from "./forwarder.ts";
import { LEGACY_SESSION_TOOL_DEFINITIONS, LEGACY_SESSION_TOOL_INSTRUCTIONS } from "./legacy-definitions.ts";
import type { SessionToolsListSource } from "./mcp-server.ts";

/** What ONE provider session of a thread advertises. */
export interface PreparedSessionTools {
  readonly threadId: string;
  /** `tools/list`, in catalog order. */
  readonly tools: readonly Tool[];
  readonly names: ReadonlySet<string>;
  /** The "Orquester" instruction block; "" for none. */
  readonly instructions: string;
  /** MCP server names to deny in this chat (§12.1), as its CLI's config names them. */
  readonly deny: readonly string[];
  /** Equal for equal lists, instructions and denials: a session restarts only when it moved. */
  readonly key: string;
  /**
   * `manifest`: the daemon's; `legacy`: the frozen old definitions (a daemon without the route);
   * `fallback`: the daemon could not be asked — the thread's last list, else its agent's defaults.
   */
  readonly source: "manifest" | "legacy" | "fallback";
}

/** One provider session's way in: what an adapter hands its provider, and its own revoke. */
export interface SessionToolsGrant {
  readonly threadId: string;
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  /** `http://127.0.0.1:<port>/mcp/denied` — the inert server a denied name is shadowed with (Grok). */
  readonly deniedUrl: string;
  /**
   * The raw credential. Goes to the provider through child env or a protocol
   * frame only — never argv, a log line, or a file.
   */
  readonly token: string;
  /** `Bearer <token>`. */
  readonly authorization: string;
  /** What this session advertises (the manifest it launched with). */
  readonly prepared: PreparedSessionTools;
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

/** What a refresh did (`SessionToolsRefreshResponse.applied`). */
export type SessionToolsApplied = "live" | "next-idle" | "next-start" | "unchanged";

/** A live session that takes a new list in-session (Claude): told the new list, it re-lists. */
export type LiveSessionToolsListener = (prepared: PreparedSessionTools) => void;

export interface SessionToolsHost {
  /** Always true for a host an adapter is handed; kept for tests. */
  readonly enabled: boolean;
  /** Every name this host may advertise (catalog ∪ legacy) — the provenance marker of rows. */
  readonly knownNames: ReadonlySet<string>;
  /** Read the thread's manifest (nothing recorded: a look). */
  prepare(threadId: string, agent: AgentAdapterId): Promise<PreparedSessionTools>;
  /**
   * An in-process session starts (Claude): read the thread's manifest and record it as what the
   * session advertises, with `listener` told every new list {@link applyManifest} hands over
   * in-session (it answers `live`). `release` when the session ends.
   */
  launchInProcess(threadId: string, agent: AgentAdapterId, listener: LiveSessionToolsListener): Promise<{ prepared: PreparedSessionTools; release(): void }>;
  /** What the thread's live session advertises now, or null without one. */
  current(threadId: string): PreparedSessionTools | null;
  /** The thread's current list as an MCP server reads it, per request. */
  listSource(threadId: string): SessionToolsListSource;
  /** A refresh from the daemon (`agentHostRoutes.sessionToolsRefresh`). */
  applyManifest(threadId: string, manifest: SessionToolsManifest): Promise<SessionToolsApplied>;
  /** The live session advertises another list than the thread's: restart it at its next idle point. */
  needsRestart(threadId: string): boolean;
  /** Run one call as `threadId` — Claude's in-process path, and the endpoint's. Never throws. */
  call(input: SessionToolsCallInput): Promise<CallToolResult>;
  /** Issue a credential for one provider session of `threadId`, revoking the thread's earlier ones. */
  issue(threadId: string, agent: AgentAdapterId): Promise<SessionToolsGrant>;
  /** Abort every call `threadId` has in flight (its turn was interrupted). */
  abortThreadCalls(threadId: string): void;
  /** Revoke everything and close the endpoint (the host's teardown). */
  stop(): Promise<void>;
}

export interface CreateSessionToolsHostOptions {
  forward: ForwardSessionToolCall;
  /** The daemon's manifest for a thread (`createDaemonManifestClient`). */
  manifest: FetchSessionToolsManifest;
  /** The advertised definitions (default: the static catalog's chat tools + the legacy ones). */
  definitions?: Promise<ChatToolDefinitions>;
  /** Every name a call may name (default: the static catalog's chat names + the legacy ones). */
  knownNames?: ReadonlySet<string>;
  credentials?: SessionToolCredentials;
  logger?: { warn(message: string, detail?: unknown): void };
  /**
   * Handed the secret values a tool's result carries (its definition's
   * `secretResultKeys`) BEFORE the result goes back to the provider, so the
   * host can mask them in everything of the thread it persists
   * (`secret-redaction.ts`).
   */
  onSecretValues?: (threadId: string, values: string[]) => void;
}

/** The string values at a tool's `secretResultKeys` in a result's `structuredContent`. */
export function secretValuesOf(tool: Pick<AdvertisedTool, "secretResultKeys"> | undefined, result: CallToolResult): string[] {
  const keys = tool?.secretResultKeys;
  const structured = result.structuredContent;
  if (keys === undefined || keys.length === 0 || structured === null || typeof structured !== "object") {
    return [];
  }
  return keys
    .map((key) => (structured as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

interface InFlightCall {
  readonly threadId: string;
  readonly grantId: string | undefined;
  readonly controller: AbortController;
}

/** What a thread's live session was launched with, and by which grant or live attach. */
interface LaunchedSession {
  prepared: PreparedSessionTools;
  /** The grant it came in on (endpoint providers) or the live attach (Claude). */
  owner: string;
  live?: LiveSessionToolsListener;
}

const keyOf = (tools: readonly Tool[], instructions: string, deny: readonly string[]): string =>
  createHash("sha256")
    .update(JSON.stringify([tools.map((tool) => tool.name), instructions, [...deny]]))
    .digest("hex");

export function createSessionToolsHost(options: CreateSessionToolsHostOptions): SessionToolsHost {
  const credentials = options.credentials ?? new SessionToolCredentials();
  const definitions = options.definitions ?? buildChatToolDefinitions();
  // Never an unhandled rejection: a failed build answers every prepare with no tools.
  definitions.catch((error: unknown) => options.logger?.warn("session tools: the catalog could not be serialised", { error: String(error) }));
  const knownNames = options.knownNames ?? knownSessionToolNames();
  const inFlight = new Set<InFlightCall>();
  /** The live session of each thread, by what it launched with. */
  const launched = new Map<string, LaunchedSession>();
  /** A newer list a live (non-in-session) session has not taken yet. */
  const desired = new Map<string, PreparedSessionTools>();
  /** The last denial list seen per agent: the fallback when the daemon cannot be asked. */
  const lastDeny = new Map<AgentAdapterId, readonly string[]>();
  /** The last list the daemon gave each thread (outlives its session): the first fallback. */
  const lastManifest = new Map<string, PreparedSessionTools>();
  let endpoint: Promise<SessionToolsEndpoint> | null = null;
  let stopped = false;

  const abortWhere = (predicate: (call: InFlightCall) => boolean): void => {
    for (const call of [...inFlight]) {
      if (predicate(call)) call.controller.abort();
    }
  };
  credentials.onRevoke((scope) => {
    abortWhere((call) => call.grantId === scope.grantId);
    // The session that grant served has ended: it advertises nothing any more.
    if (launched.get(scope.threadId)?.owner === scope.grantId) {
      launched.delete(scope.threadId);
      desired.delete(scope.threadId);
    }
  });

  const build = async (threadId: string, names: readonly string[], instructions: string, deny: readonly string[], source: PreparedSessionTools["source"]): Promise<PreparedSessionTools> => {
    const defs = await definitions.catch(() => null);
    const tools: Tool[] = [];
    for (const name of names) {
      const def = defs?.byName.get(name);
      // A name the host does not know (a daemon newer than this host) is not advertised.
      if (def) tools.push(def.entry);
    }
    return {
      threadId,
      tools,
      names: new Set(tools.map((tool) => tool.name)),
      instructions,
      deny: [...deny],
      key: keyOf(tools, instructions, deny),
      source
    };
  };

  const fromManifest = (threadId: string, manifest: SessionToolsManifest) =>
    build(threadId, manifest.tools, manifest.instructions, manifest.deny, "manifest");

  /** The thread's last list, else its agent's catalogue defaults with the agent's last denials. */
  const fallback = async (threadId: string, agent: AgentAdapterId): Promise<PreparedSessionTools> => {
    const last = lastManifest.get(threadId);
    if (last) return { ...last, source: "fallback" };
    // The agent's catalogue defaults; no Admin tool (the workflow-owned trait cannot be read).
    const on = new Set(TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[agent] === true).map((toolset) => toolset.id));
    const names = catalogFor("chat").filter((tool) => on.has(tool.toolset) && tool.tier !== "admin").map((tool) => tool.name);
    const instructions = composeOrquesterInstructions({ enabledToolsets: on, workflowOwned: false, canRequestToolsets: true });
    return build(threadId, names, instructions, lastDeny.get(agent) ?? [], "fallback");
  };

  const readPrepared = async (threadId: string, agent: AgentAdapterId): Promise<PreparedSessionTools> => {
    const answer = await options.manifest(threadId);
    switch (answer.kind) {
      case "manifest": {
        lastDeny.set(agent, answer.manifest.deny);
        const prepared = await fromManifest(threadId, answer.manifest);
        lastManifest.set(threadId, prepared);
        return prepared;
      }
      case "legacy": {
        // The old server's list VERBATIM (its schemas are what the old daemon's handlers parse).
        const tools = [...LEGACY_SESSION_TOOL_DEFINITIONS];
        return {
          threadId,
          tools,
          names: new Set(tools.map((tool) => tool.name)),
          instructions: LEGACY_SESSION_TOOL_INSTRUCTIONS,
          deny: [],
          key: keyOf(tools, LEGACY_SESSION_TOOL_INSTRUCTIONS, []),
          source: "legacy"
        };
      }
      case "no-thread":
        return build(threadId, [], "", [], "manifest");
      case "unavailable":
        options.logger?.warn("session tools: no manifest from the daemon; this session uses its last or default list", { threadId });
        return fallback(threadId, agent);
    }
  };

  const record = (prepared: PreparedSessionTools, owner: string, live?: LiveSessionToolsListener): void => {
    launched.set(prepared.threadId, { prepared, owner, ...(live ? { live } : {}) });
    desired.delete(prepared.threadId);
  };

  const run = async (input: SessionToolsCallInput, grantId: string | undefined): Promise<CallToolResult> => {
    if (!knownNames.has(input.name)) {
      return errorResult("TOOL_NOT_FOUND", `Session tool ${input.name.slice(0, 100)} not found.`);
    }
    const controller = new AbortController();
    const entry: InFlightCall = { threadId: input.threadId, grantId, controller };
    const abort = () => controller.abort();
    if (input.signal?.aborted) return cancelledResult();
    input.signal?.addEventListener("abort", abort, { once: true });
    inFlight.add(entry);
    try {
      const result = await options.forward(
        {
          threadId: input.threadId,
          callId: input.callId ?? `call-${randomUUID()}`,
          name: input.name,
          arguments: input.arguments
        },
        controller.signal
      );
      const defs = await definitions.catch(() => null);
      const secrets = secretValuesOf(defs?.byName.get(input.name), result);
      if (secrets.length > 0) {
        options.onSecretValues?.(input.threadId, secrets);
      }
      return result;
    } finally {
      inFlight.delete(entry);
      input.signal?.removeEventListener("abort", abort);
    }
  };

  const listSource = (threadId: string): SessionToolsListSource => ({
    list: () => launched.get(threadId)?.prepared.tools ?? [],
    accepts: (name) => knownNames.has(name)
  });

  const ensureEndpoint = (): Promise<SessionToolsEndpoint> => {
    endpoint ??= startSessionToolsEndpoint({
      credentials,
      listFor: (scope) => listSource(scope.threadId),
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
    enabled: true,
    knownNames,
    prepare: (threadId, agent) => readPrepared(threadId, agent),
    async launchInProcess(threadId, agent, listener) {
      const prepared = await readPrepared(threadId, agent);
      const owner = `in-process-${randomUUID()}`;
      record(prepared, owner, listener);
      return {
        prepared,
        release: () => {
          if (launched.get(threadId)?.owner === owner) {
            launched.delete(threadId);
            desired.delete(threadId);
          }
        }
      };
    },
    current: (threadId) => launched.get(threadId)?.prepared ?? null,
    listSource,
    async applyManifest(threadId, manifest) {
      const session = launched.get(threadId);
      const next = await fromManifest(threadId, manifest);
      if (!session) return "next-start";
      if (session.prepared.key === next.key) {
        desired.delete(threadId);
        return "unchanged";
      }
      // In-session: only the tool list can change live (the instruction block rides the system
      // prompt, the denials the launch); anything else waits for the restart.
      const sameDeny = session.prepared.deny.join("\u0000") === next.deny.join("\u0000");
      if (session.live && sameDeny) {
        launched.set(threadId, { ...session, prepared: next });
        desired.delete(threadId);
        try {
          session.live(next);
        } catch (error) {
          options.logger?.warn("session tools: a live session could not take its new list", { threadId, error: String(error) });
        }
        return "live";
      }
      desired.set(threadId, next);
      return "next-idle";
    },
    needsRestart(threadId) {
      const want = desired.get(threadId);
      const have = launched.get(threadId)?.prepared;
      return want !== undefined && have !== undefined && want.key !== have.key;
    },
    call: (input) => run(input, undefined),
    async issue(threadId, agent) {
      if (stopped) throw new Error("session tools: the host is stopping");
      const { url, deniedUrl } = await ensureEndpoint();
      // Issue first (it revokes the thread's earlier grant, ending that session's list), then read
      // and record what this session advertises.
      const issued = credentials.issue(threadId);
      const prepared = await readPrepared(threadId, agent);
      record(prepared, issued.grantId);
      return {
        threadId,
        url,
        deniedUrl,
        token: issued.token,
        authorization: `Bearer ${issued.token}`,
        prepared,
        revoke: () => credentials.revokeGrant(issued.grantId)
      };
    },
    abortThreadCalls: (threadId) => abortWhere((call) => call.threadId === threadId),
    async stop() {
      stopped = true;
      credentials.revokeAll();
      abortWhere(() => true);
      launched.clear();
      desired.clear();
      lastManifest.clear();
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
  threadId: string,
  agent: AgentAdapterId
): Promise<SessionToolsGrant | undefined> {
  if (context.sessionTools === undefined) {
    return undefined;
  }
  try {
    return await context.sessionTools.issue(threadId, agent);
  } catch (error) {
    context.logger.warn("session tools: no credential for this session; it runs without them", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

export { SessionToolCredentials } from "./credentials.ts";
export { createDaemonForwarder, createDaemonManifestClient } from "./forwarder.ts";
