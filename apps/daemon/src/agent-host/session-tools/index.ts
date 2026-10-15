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
 * When the daemon cannot be asked (down, restarting, or it cannot read the daemon-pointing MCP
 * servers: 503), a session launches with a FALLBACK keyed by (agent, account home, project): that
 * key's last manifest, else the agent's defaults with no denial — logged and surfaced on the thread
 * as a warning (`onWarning`), never silent, never another home's denials (Codex refuses a thread
 * whose config names a server it does not have).
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

/** Where a provider session runs: what its fallback is keyed on. */
export interface SessionToolsLaunch {
  agent: AgentAdapterId;
  /** `"system"` or the managed account id (the daemon's manifest key for the home). */
  home: string;
  /** The thread's project root (else its cwd). */
  project: string;
}

/** `"system"` or the account id of a resolved account home. */
export function launchHomeKey(home: { kind: string; accountId?: string }): string {
  return home.kind === "account" && home.accountId ? home.accountId : "system";
}

/** A manifest's ordering stamp: its sequence within its daemon epoch. */
interface Stamp {
  seq: number;
  epoch: string | undefined;
}

const stampOf = (value: { seq?: number; epoch?: string }): Stamp | undefined =>
  value.seq === undefined ? undefined : { seq: value.seq, epoch: value.epoch };

const launchKeyOf = (launch: SessionToolsLaunch): string => `${launch.agent}\u0000${launch.home}\u0000${launch.project}`;

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
  /**
   * False when the denials could not be derived for THIS launch (no manifest and no fallback for
   * its agent, home and project): `deny` is then empty and the denial is degraded (warned).
   */
  readonly denyKnown: boolean;
  /** Equal for equal lists, instructions and denials: a session restarts only when it moved. */
  readonly key: string;
  /** The daemon's manifest sequence and boot epoch (`SessionToolsManifest.seq` / `.epoch`), when it sent them. */
  readonly seq?: number;
  readonly epoch?: string;
  /**
   * `manifest`: the daemon's; `legacy`: the frozen old definitions (a daemon without the route);
   * `fallback`: the daemon could not be asked — this launch key's last list, else the defaults.
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

/** What an endpoint provider's session starts with: its grant when one was issued, its denials ALWAYS. */
export interface SessionToolsLaunchResult {
  /** Absent when no credential could be issued (the session runs without Orquester's tools). */
  grant?: SessionToolsGrant;
  /** The thread's list and denials — present even without a grant (§12.1 never fails open). */
  prepared: PreparedSessionTools | null;
  /** The inert endpoint for shadows, when the endpoint is up (Grok falls back to an unreachable one). */
  deniedUrl?: string;
}

export interface SessionToolsCallInput {
  threadId: string;
  name: string;
  arguments: unknown;
  callId?: string;
  signal?: AbortSignal;
}

/** What a refresh did (`SessionToolsRefreshResponse.applied`). */
export type SessionToolsApplied = "live" | "next-idle" | "next-start" | "unchanged" | "superseded";

/**
 * A live session that takes a new list in-session (Claude): told the new list, it tells its client
 * and resolves true once the client re-listed (bounded), false when it did not in time.
 */
export type LiveSessionToolsListener = (prepared: PreparedSessionTools) => boolean | Promise<boolean>;

export interface SessionToolsHost {
  /** Always true for a host an adapter is handed; kept for tests. */
  readonly enabled: boolean;
  /** Every name this host may advertise (catalog ∪ legacy) — the provenance marker of rows. */
  readonly knownNames: ReadonlySet<string>;
  /** Read the thread's manifest (nothing recorded: a look). */
  prepare(threadId: string, launch: SessionToolsLaunch): Promise<PreparedSessionTools>;
  /**
   * An in-process session starts (Claude): read the thread's manifest and record it as what the
   * session advertises, with `listener` told every new list {@link applyManifest} hands over
   * in-session (it answers `live` once the client re-listed). `release` when the session ends.
   */
  launchInProcess(threadId: string, launch: SessionToolsLaunch, listener: LiveSessionToolsListener): Promise<{ prepared: PreparedSessionTools; release(): void }>;
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
  issue(threadId: string, launch: SessionToolsLaunch): Promise<SessionToolsGrant>;
  /** The inert endpoint's URL, when the endpoint is (or can be) up; undefined otherwise. Never throws. */
  deniedUrl(): Promise<string | undefined>;
  /** Abort every call `threadId` has in flight (its turn was interrupted). */
  abortThreadCalls(threadId: string): void;
  /** The thread was deleted: drop its fallbacks and sequence bookkeeping. */
  forgetThread(threadId: string): void;
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
   * A thread's session starts degraded (no manifest, and no denials known for its launch key):
   * surfaced on the thread (a `runtime.warning` row, `main.ts`). Must not throw.
   */
  onWarning?: (threadId: string, message: string) => void;
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

/** The warning a degraded launch is surfaced with. */
export const DENIAL_DEGRADED_WARNING =
  "Orquester could not read which MCP servers point at it, so this chat's session started without denying them. They are denied again once Orquester answers (the session restarts at its next idle point after a change).";

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
  /** Live sessions that must restart at their next idle point although their key did not move (a live apply the client never re-listed). */
  const forced = new Set<string>();
  /** A thread whose session is being launched (its manifest read in flight): a refresh waits for it. */
  const launching = new Map<string, Promise<unknown>>();
  /** The last manifest per launch key — (agent, home, project) — the fallback for other threads of that key. */
  const lastByLaunch = new Map<string, PreparedSessionTools>();
  /** Each thread's own last manifest and the launch key it was read for — the first fallback. */
  const lastByThread = new Map<string, { launchKey: string; prepared: PreparedSessionTools }>();
  /** The newest manifest stamp each thread launched with, applied or CLAIMED: older refreshes are superseded. */
  const lastSeq = new Map<string, Stamp>();
  /**
   * Daemon epochs some thread has moved on from (host-wide): a daemon that restarted never comes
   * back, so a stamp from a retired epoch — a push that outlived its daemon — is always stale.
   */
  const retiredEpochs = new Set<string>();
  const epochKey = (stamp: Stamp): string => stamp.epoch ?? "";
  /** True when `stamp` is no newer than the thread's last one (same daemon epoch), or from a retired epoch. */
  const isStale = (threadId: string, stamp: Stamp | undefined): boolean => {
    if (stamp === undefined) return false;
    if (retiredEpochs.has(epochKey(stamp))) return true;
    const last = lastSeq.get(threadId);
    if (last === undefined || last.epoch !== stamp.epoch) return false;
    return stamp.seq <= last.seq;
  };
  /** `a` is newer than `b` (a missing `b`, or `b`'s epoch retired by `a`'s, counts as older). */
  const newerThan = (a: Stamp | undefined, b: Stamp | undefined): boolean => {
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a.epoch !== b.epoch) return retiredEpochs.has(epochKey(b));
    return a.seq > b.seq;
  };
  /** Record `stamp` as the thread's newest; a new epoch retires the thread's previous one host-wide. */
  const noteSeq = (threadId: string, stamp: Stamp | undefined): void => {
    if (stamp === undefined || isStale(threadId, stamp)) return;
    const last = lastSeq.get(threadId);
    if (last !== undefined && last.epoch !== stamp.epoch) retiredEpochs.add(epochKey(last));
    lastSeq.set(threadId, stamp);
  };
  let endpoint: Promise<SessionToolsEndpoint> | null = null;
  let stopped = false;

  const abortWhere = (predicate: (call: InFlightCall) => boolean): void => {
    for (const call of [...inFlight]) {
      if (predicate(call)) call.controller.abort();
    }
  };
  const forget = (threadId: string): void => {
    launched.delete(threadId);
    forced.delete(threadId);
    // `desired` stays: the thread's NEXT launch drops it only when it read that change or a newer one.
  };
  credentials.onRevoke((scope) => {
    abortWhere((call) => call.grantId === scope.grantId);
    // The session that grant served has ended: it advertises nothing any more.
    if (launched.get(scope.threadId)?.owner === scope.grantId) forget(scope.threadId);
  });

  const build = async (
    threadId: string,
    names: readonly string[],
    instructions: string,
    deny: readonly string[],
    source: PreparedSessionTools["source"],
    denyKnown = true
  ): Promise<PreparedSessionTools> => {
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
      denyKnown,
      key: keyOf(tools, instructions, deny),
      source
    };
  };

  const fromManifest = async (threadId: string, manifest: SessionToolsManifest): Promise<PreparedSessionTools> => {
    const prepared = await build(threadId, manifest.tools, manifest.instructions, manifest.deny, "manifest");
    return manifest.seq !== undefined ? { ...prepared, seq: manifest.seq, ...(manifest.epoch !== undefined ? { epoch: manifest.epoch } : {}) } : prepared;
  };

  /**
   * The daemon could not be asked: this launch key's last manifest (same agent, home and project —
   * its denials are this config's), else the agent's catalogue defaults with NO denial, warned.
   * Never another key's denials: Codex fails a thread whose config lacks a denied name.
   */
  const fallback = async (threadId: string, launch: SessionToolsLaunch): Promise<PreparedSessionTools> => {
    const launchKey = launchKeyOf(launch);
    // The thread's own last manifest first — only for the same launch (an account switch moved it).
    const own = lastByThread.get(threadId);
    if (own && own.launchKey === launchKey) {
      // A fallback orders nothing: its stamp is the daemon's word on a launch long past.
      const { seq: _seq, epoch: _epoch, ...copy } = own.prepared;
      return { ...copy, source: "fallback" };
    }
    const last = lastByLaunch.get(launchKey);
    if (last) {
      // Another thread's manifest: its stamp orders THAT thread's refreshes, never this one's.
      const { seq: _seq, epoch: _epoch, ...copy } = last;
      return { ...copy, threadId, source: "fallback" };
    }
    // Safe values where the thread's own are unknown: workflow-owned (no Admin tool, no
    // approval line), and no toolset can be asked for.
    const on = new Set(TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[launch.agent] === true).map((toolset) => toolset.id));
    const names = catalogFor("chat").filter((tool) => on.has(tool.toolset) && tool.tier !== "admin").map((tool) => tool.name);
    const instructions = composeOrquesterInstructions({ enabledToolsets: on, workflowOwned: true, canRequestToolsets: false });
    options.logger?.warn("session tools: no denials known for this launch; MCP server denial is degraded", { threadId, agent: launch.agent });
    try {
      options.onWarning?.(threadId, DENIAL_DEGRADED_WARNING);
    } catch {
      // Surfacing is best effort; the log above stands.
    }
    return build(threadId, names, instructions, [], "fallback", false);
  };

  const readPrepared = async (threadId: string, launch: SessionToolsLaunch): Promise<PreparedSessionTools> => {
    const answer = await options.manifest(threadId);
    switch (answer.kind) {
      case "manifest": {
        const prepared = await fromManifest(threadId, answer.manifest);
        const launchKey = launchKeyOf(launch);
        lastByLaunch.set(launchKey, prepared);
        lastByThread.set(threadId, { launchKey, prepared });
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
          denyKnown: true,
          key: keyOf(tools, LEGACY_SESSION_TOOL_INSTRUCTIONS, []),
          source: "legacy"
        };
      }
      case "no-thread":
        return build(threadId, [], "", [], "manifest");
      case "unavailable":
        options.logger?.warn("session tools: no manifest from the daemon; this session uses its launch key's last list or the defaults", { threadId });
        return fallback(threadId, launch);
    }
  };

  /**
   * Read and record what a starting session advertises. A refresh landing while the manifest is
   * read waits for the record, then is judged against what the session really launched with (an
   * equal list is `unchanged`; an older one `superseded`; a newer one leaves it stale).
   */
  const launchWith = async (threadId: string, launch: SessionToolsLaunch, owner: string, live?: LiveSessionToolsListener): Promise<PreparedSessionTools> => {
    const reading = readPrepared(threadId, launch);
    const done = reading.then(
      () => undefined,
      () => undefined
    );
    launching.set(threadId, done);
    try {
      const prepared = await reading;
      launched.set(threadId, { prepared, owner, ...(live ? { live } : {}) });
      // A refresh that claimed a NEWER manifest while this read was in flight keeps what it wants.
      const wanted = desired.get(threadId);
      if (wanted === undefined || !newerThan(stampOf(wanted), stampOf(prepared))) desired.delete(threadId);
      forced.delete(threadId);
      if (prepared.source !== "fallback") noteSeq(threadId, stampOf(prepared));
      return prepared;
    } finally {
      if (launching.get(threadId) === done) launching.delete(threadId);
    }
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
    prepare: (threadId, launch) => readPrepared(threadId, launch),
    async launchInProcess(threadId, launch, listener) {
      const owner = `in-process-${randomUUID()}`;
      const prepared = await launchWith(threadId, launch, owner, listener);
      return {
        prepared,
        release: () => {
          if (launched.get(threadId)?.owner === owner) forget(threadId);
        }
      };
    },
    current: (threadId) => launched.get(threadId)?.prepared ?? null,
    listSource,
    async applyManifest(threadId, manifest) {
      // A launch reading its manifest right now: judge the refresh against what it launches with.
      const inFlight = launching.get(threadId);
      if (inFlight) await inFlight;
      // Out of order (a settings refresh and an approval racing): never roll a list back. The
      // stamp is CLAIMED before any await, so an older refresh queued behind this one is
      // superseded however their awaits interleave.
      const stamp = stampOf(manifest);
      if (isStale(threadId, stamp)) return "superseded";
      noteSeq(threadId, stamp);
      const claimed = lastSeq.get(threadId);
      const overtaken = (): boolean => stamp !== undefined && lastSeq.get(threadId) !== claimed;
      const next = await fromManifest(threadId, manifest);
      if (overtaken()) return "superseded";
      const session = launched.get(threadId);
      if (!session) return "next-start";
      if (session.prepared.key === next.key && !forced.has(threadId)) {
        desired.delete(threadId);
        return "unchanged";
      }
      // In-session: the tool list (and the bookkeeping of the block) change live; the denials ride
      // the launch, so a change of them waits for the restart.
      const sameDeny = session.prepared.deny.join("\u0000") === next.deny.join("\u0000");
      if (session.live && sameDeny) {
        launched.set(threadId, { ...session, prepared: next });
        desired.delete(threadId);
        let relisted = false;
        try {
          relisted = await session.live(next);
        } catch (error) {
          options.logger?.warn("session tools: a live session could not take its new list", { threadId, error: String(error) });
        }
        const now = launched.get(threadId);
        if (now === undefined) return "next-start";
        if (now.owner !== session.owner) {
          // The session relaunched while the client was being told: it read its own manifest.
          if (now.prepared.key === next.key) return "unchanged";
          const relaunchStamp = stampOf(now.prepared);
          if (stamp !== undefined && relaunchStamp !== undefined && relaunchStamp.epoch === stamp.epoch && relaunchStamp.seq >= stamp.seq) {
            // The relaunch read this change or a newer one: nothing of this refresh is owed.
            return "superseded";
          }
          desired.set(threadId, next);
          return "next-idle";
        }
        if (overtaken()) return "superseded";
        if (relisted) {
          forced.delete(threadId);
          return "live";
        }
        // The client did not re-list in time: the list is served, but only a restart is certain.
        forced.add(threadId);
        return "next-idle";
      }
      desired.set(threadId, next);
      return "next-idle";
    },
    needsRestart(threadId) {
      const have = launched.get(threadId)?.prepared;
      if (have === undefined) return false;
      if (forced.has(threadId)) return true;
      const want = desired.get(threadId);
      return want !== undefined && want.key !== have.key;
    },
    call: (input) => run(input, undefined),
    async issue(threadId, launch) {
      if (stopped) throw new Error("session tools: the host is stopping");
      const { url, deniedUrl } = await ensureEndpoint();
      // Issue first (it revokes the thread's earlier grant, ending that session's list), then read
      // and record what this session advertises.
      const issued = credentials.issue(threadId);
      const prepared = await launchWith(threadId, launch, issued.grantId);
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
    async deniedUrl() {
      if (stopped) return undefined;
      return ensureEndpoint()
        .then((open) => open.deniedUrl)
        .catch(() => undefined);
    },
    abortThreadCalls: (threadId) => abortWhere((call) => call.threadId === threadId),
    forgetThread(threadId) {
      lastByThread.delete(threadId);
      lastSeq.delete(threadId);
      desired.delete(threadId);
      forced.delete(threadId);
    },
    async stop() {
      stopped = true;
      credentials.revokeAll();
      abortWhere(() => true);
      launched.clear();
      desired.clear();
      forced.clear();
      lastByLaunch.clear();
      lastByThread.clear();
      lastSeq.clear();
      retiredEpochs.clear();
      const open = endpoint;
      endpoint = null;
      if (open !== null) {
        await open.then((server) => server.close()).catch(() => undefined);
      }
    }
  };
}

/**
 * An endpoint provider's way into its session: the context's service issues a grant, and a
 * failure (the endpoint could not bind, the host is stopping) costs the session its TOOLS —
 * logged — never its start, and never its DENIALS: the thread's list and denials are still read
 * and handed back (§12.1 does not fail open). `{prepared: null}` without session tools.
 */
export async function issueSessionToolsGrant(
  context: { sessionTools?: SessionToolsHost; logger: { warn(message: string, detail?: unknown): void } },
  threadId: string,
  launch: SessionToolsLaunch
): Promise<SessionToolsLaunchResult> {
  const host = context.sessionTools;
  if (host === undefined) {
    return { prepared: null };
  }
  try {
    const grant = await host.issue(threadId, launch);
    return { grant, prepared: grant.prepared, deniedUrl: grant.deniedUrl };
  } catch (error) {
    context.logger.warn("session tools: no credential for this session; it runs without them (its MCP denials still apply)", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
    const prepared = await host.prepare(threadId, launch).catch(() => null);
    const deniedUrl = await host.deniedUrl();
    return { prepared, ...(deniedUrl !== undefined ? { deniedUrl } : {}) };
  }
}

export { SessionToolCredentials } from "./credentials.ts";
export { createDaemonForwarder, createDaemonManifestClient } from "./forwarder.ts";
