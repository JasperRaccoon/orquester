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
 * A changed manifest the daemon pushes (`agentHostRoutes.sessionToolsRefresh`) is
 * applied in-session where the provider re-lists on `tools/list_changed` (Claude's in-process
 * server, {@link SessionToolsHost.launchInProcess}); any other live session is marked stale and the
 * orchestrator restarts it with resume at its next idle point ({@link SessionToolsHost.needsRestart}).
 *
 * When the daemon cannot be asked (down, restarting, or it cannot read the daemon-pointing MCP
 * servers: 503), a session launches with a FALLBACK keyed by (agent, account home, project): the
 * thread's own last manifest for that key, else that key's last manifest of another thread —
 * logged and surfaced on the thread as a warning (`onWarning`), never another home's denials (Codex
 * refuses a thread whose config names a server it does not have). With neither, the denials are
 * UNKNOWN and the session never launches without them (§12.1): the launch waits, bounded by
 * {@link DENIALS_WAIT_MS} from its start, for a manifest — one the daemon pushes for the thread
 * (`applyManifest`, which the daemon sends to a thread it refused once its read succeeds) or one
 * another launch of the same key reads — and otherwise fails with the retryable
 * {@link SessionToolsDenialsUnknownError} (a "turn start failed" row; the next message retries).
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
import type { AgentAdapterId } from "@orquester/api/agent-chat";

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
  /** Equal for equal lists, instructions and denials: a session restarts only when it moved. */
  readonly key: string;
  /** The daemon's manifest sequence and boot epoch (`SessionToolsManifest.seq` / `.epoch`), when it sent them. */
  readonly seq?: number;
  readonly epoch?: string;
  /**
   * `manifest`: the daemon's; `legacy`: the frozen old definitions (a daemon without the route);
   * `fallback`: the daemon could not be asked — the last list read for this launch key.
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
   * A thread's session starts degraded (no manifest: the last denials known for its launch key):
   * surfaced on the thread (a `runtime.warning` row, `main.ts`). Must not throw.
   */
  onWarning?: (threadId: string, message: string) => void;
  /** Overrides {@link DENIALS_WAIT_MS} (tests). */
  denialsWaitMs?: number;
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
  /** The launch key (agent, home, project) it launched under. */
  launchKey: string;
}

const keyOf = (tools: readonly Tool[], instructions: string, deny: readonly string[]): string =>
  createHash("sha256")
    .update(JSON.stringify([tools.map((tool) => tool.name), instructions, [...deny]]))
    .digest("hex");

/** The warning a fallback launch is surfaced with: the denials are the last ones read, not fresh. */
export const DENIAL_DEGRADED_WARNING =
  "Orquester could not check which MCP servers point at it just now, so this chat's session started with the MCP servers it last denied for this agent, account and project. A server added since is denied once Orquester answers (the session restarts at its next idle point after a change).";

/** The longest a launch whose denials are unknown waits for a manifest, from its start. */
export const DENIALS_WAIT_MS = 15_000;

/**
 * What a launch refused for unknown denials says: a retry helps when the check was only late (the
 * daemon starting, a slow read), and the daemon's log names a check that keeps failing.
 */
export const DENIALS_UNKNOWN_MESSAGE =
  "Orquester could not check your MCP servers yet, so this chat's session did not start (it never runs without denying the ones that point at Orquester). Send your message again in a moment; if this keeps happening, the daemon's log says why the check fails.";

/**
 * A launch whose MCP denials are unknown (no manifest, and none known for its agent, account home
 * and project) after {@link DENIALS_WAIT_MS}: the session is not started. Retryable — the next
 * message starts it once the daemon answers.
 */
export class SessionToolsDenialsUnknownError extends Error {
  readonly code = "SESSION_TOOLS_DENIALS_UNKNOWN";
  readonly retryable = true;
  constructor() {
    super(DENIALS_UNKNOWN_MESSAGE);
    this.name = "SessionToolsDenialsUnknownError";
  }
}

export function isSessionToolsDenialsUnknown(error: unknown): error is SessionToolsDenialsUnknownError {
  return error instanceof SessionToolsDenialsUnknownError;
}

/**
 * A launch reading its manifest: a manifest pushed for its thread meanwhile, or one another launch
 * of its key read, is delivered here — and wakes it when it waits for its denials.
 */
interface LaunchMailbox {
  readonly launchKey: string;
  /** The thread was deleted or its turn interrupted: a wait for its denials ends now. */
  cancelled?: boolean;
  pushed?: SessionToolsManifest;
  keyed?: PreparedSessionTools;
  wake?: () => void;
}

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
  /** The launch key of the session each `desired` list was pushed for. */
  const desiredLaunchKey = new Map<string, string>();
  const want = (threadId: string, next: PreparedSessionTools): void => {
    desired.set(threadId, next);
    const launchKey = launched.get(threadId)?.launchKey;
    if (launchKey !== undefined) desiredLaunchKey.set(threadId, launchKey);
    else desiredLaunchKey.delete(threadId);
  };
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
  /**
   * The order this host first took a stamp of each daemon epoch in: epochs are opaque, and in a
   * handover the old daemon's late push may land after the new daemon's first one — an epoch first
   * seen EARLIER is the older daemon's, never a newer one. An epoch never seen counts as newest.
   */
  const epochOrder = new Map<string, number>();
  const epochKey = (stamp: Stamp): string => stamp.epoch ?? "";
  const orderOf = (stamp: Stamp): number => epochOrder.get(epochKey(stamp)) ?? Number.POSITIVE_INFINITY;
  /** `a`'s epoch is a later daemon's than `b`'s. */
  const laterEpoch = (a: Stamp, b: Stamp): boolean => retiredEpochs.has(epochKey(b)) || orderOf(a) > orderOf(b);
  /**
   * True when `stamp` is no newer than the thread's last one: the same daemon epoch and a sequence
   * no higher, an epoch retired host-wide, or an epoch first seen before the thread's last one's.
   */
  const isStale = (threadId: string, stamp: Stamp | undefined): boolean => {
    if (stamp === undefined) return false;
    if (retiredEpochs.has(epochKey(stamp))) return true;
    const last = lastSeq.get(threadId);
    if (last === undefined) return false;
    if (last.epoch !== stamp.epoch) return !laterEpoch(stamp, last);
    return stamp.seq <= last.seq;
  };
  /** `a` is newer than `b` (a missing `b`, or `b` from an earlier daemon epoch than `a`'s, counts as older). */
  const newerThan = (a: Stamp | undefined, b: Stamp | undefined): boolean => {
    if (a === undefined) return false;
    if (b === undefined) return true;
    if (a.epoch !== b.epoch) return laterEpoch(a, b);
    return a.seq > b.seq;
  };
  /**
   * Record `stamp` as the thread's newest. Only a LATER epoch than the thread's last one (not stale,
   * so first seen after it, or never seen) retires that one host-wide.
   */
  let epochClock = 0;
  const noteSeq = (threadId: string, stamp: Stamp | undefined, fromPull = false): void => {
    if (stamp === undefined) return;
    const key = epochKey(stamp);
    const last = lastSeq.get(threadId);
    if (fromPull && last?.epoch !== stamp.epoch) {
      // A manifest the host ASKED for comes from the daemon its socket reaches now: that epoch is
      // the newest, whatever a late push of an epoch never seen before made the host believe.
      retiredEpochs.delete(key);
      epochOrder.set(key, (epochClock += 1));
    }
    if (isStale(threadId, stamp)) return;
    if (!epochOrder.has(key)) epochOrder.set(key, (epochClock += 1));
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
    source: PreparedSessionTools["source"]
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
      key: keyOf(tools, instructions, deny),
      source
    };
  };

  const fromManifest = async (threadId: string, manifest: SessionToolsManifest): Promise<PreparedSessionTools> => {
    const prepared = await build(threadId, manifest.tools, manifest.instructions, manifest.deny, "manifest");
    return manifest.seq !== undefined ? { ...prepared, seq: manifest.seq, ...(manifest.epoch !== undefined ? { epoch: manifest.epoch } : {}) } : prepared;
  };

  /**
   * The daemon could not be asked: the denials last known for this launch key — the thread's own
   * last manifest for it, else another thread's of the same key (same agent, home and project: its
   * denials are this config's) — warned; null when none is known. Never another key's denials:
   * Codex fails a thread whose config lacks a denied name.
   */
  const lastKnown = (threadId: string, launchKey: string): PreparedSessionTools | null => {
    // The thread's own last manifest first — only for the same launch (an account switch moved it).
    const own = lastByThread.get(threadId);
    // A newer list the daemon pushed for this thread's session of the same key (a change pending
    // its restart) comes first: launching with an older one would lose the change.
    const pending = desiredLaunchKey.get(threadId) === launchKey ? desired.get(threadId) : undefined;
    if (pending !== undefined) {
      // Adopted: it is this key's last list from now on, so a second fallback keeps it too.
      lastByThread.set(threadId, { launchKey, prepared: pending });
      lastByLaunch.set(launchKey, pending);
    }
    // A fallback orders nothing: its stamp is the daemon's word on a launch long past (and
    // another thread's stamp orders THAT thread's refreshes, never this one's).
    const source = pending ?? (own && own.launchKey === launchKey ? own.prepared : lastByLaunch.get(launchKey));
    if (source === undefined) return null;
    const { seq: _seq, epoch: _epoch, ...copy } = source;
    return { ...copy, threadId, source: "fallback" };
  };

  /** Threads warned for their current degraded state: warned again only after a good manifest. */
  const degradedWarned = new Set<string>();
  const warnFallback = (threadId: string): void => {
    if (degradedWarned.has(threadId)) return;
    degradedWarned.add(threadId);
    try {
      options.onWarning?.(threadId, DENIAL_DEGRADED_WARNING);
    } catch {
      // Surfacing is best effort; the log stands.
    }
  };

  /** Every launch of `threadId` reading its manifest right now. */
  const mailboxes = new Map<string, Set<LaunchMailbox>>();
  /** What a launch read from the daemon itself (not a push it adopted): its epoch is the live daemon's. */
  const pulled = new WeakSet<PreparedSessionTools>();
  /** What a launch read from a daemon socket no longer current when it answered: no stamp recorded. */
  const stalePulls = new WeakSet<PreparedSessionTools>();
  /** Manifests a waiting launch took from a refresh: that refresh then has nothing left to apply. */
  const adopted = new WeakSet<SessionToolsManifest>();

  /** A refresh for a thread whose launch is reading its manifest: hand it over (the newest wins). */
  const offerPushed = (threadId: string, manifest: SessionToolsManifest): void => {
    // A push older than what the thread already launched with (or from a retired daemon) is no answer.
    if (isStale(threadId, stampOf(manifest))) return;
    for (const box of mailboxes.get(threadId) ?? []) {
      if (box.pushed !== undefined && !newerThan(stampOf(manifest), stampOf(box.pushed))) continue;
      box.pushed = manifest;
      box.wake?.();
    }
  };

  /** The thread was deleted, or its turn interrupted: a launch waiting for its denials gives up now. */
  const cancelLaunchWaits = (threadId: string): void => {
    for (const box of mailboxes.get(threadId) ?? []) {
      box.cancelled = true;
      box.wake?.();
    }
  };

  /** A launch read a manifest for `launchKey`: the other launches of that key waiting for denials take it. */
  const offerKeyed = (launchKey: string, prepared: PreparedSessionTools): void => {
    for (const boxes of mailboxes.values()) {
      for (const box of boxes) {
        if (box.launchKey !== launchKey) continue;
        box.keyed = prepared;
        box.wake?.();
      }
    }
  };

  /** A manifest this launch read or was handed: what it advertises, recorded as its key's last. */
  const recordManifest = async (threadId: string, launchKey: string, manifest: SessionToolsManifest): Promise<PreparedSessionTools> => {
    const prepared = await fromManifest(threadId, manifest);
    // A good manifest ends the thread's degraded state: a later fallback is warned again.
    degradedWarned.delete(threadId);
    lastByLaunch.set(launchKey, prepared);
    lastByThread.set(threadId, { launchKey, prepared });
    offerKeyed(launchKey, prepared);
    return prepared;
  };

  /**
   * No manifest, and no denials known for this launch key: wait (until `deadline`) for a manifest
   * pushed for the thread or read by another launch of the key; else refuse the launch.
   */
  const awaitDenials = async (threadId: string, launchKey: string, box: LaunchMailbox, deadline: Promise<void>): Promise<PreparedSessionTools> => {
    let expired = false;
    void deadline.then(() => {
      expired = true;
      box.wake?.();
    });
    for (;;) {
      if (box.pushed !== undefined) {
        const manifest = box.pushed;
        adopted.add(manifest);
        return recordManifest(threadId, launchKey, manifest);
      }
      if (box.keyed !== undefined) {
        const { seq: _seq, epoch: _epoch, ...copy } = box.keyed;
        return { ...copy, threadId, source: "fallback" };
      }
      if (expired || stopped || box.cancelled) {
        options.logger?.warn("session tools: no MCP denials known for this launch; the session is not started", { threadId });
        throw new SessionToolsDenialsUnknownError();
      }
      await new Promise<void>((resolve) => (box.wake = resolve));
      box.wake = undefined;
    }
  };

  const readPrepared = async (threadId: string, launch: SessionToolsLaunch): Promise<PreparedSessionTools> => {
    const launchKey = launchKeyOf(launch);
    const box: LaunchMailbox = { launchKey };
    const boxes = mailboxes.get(threadId) ?? new Set<LaunchMailbox>();
    boxes.add(box);
    mailboxes.set(threadId, boxes);
    // The bound covers the whole read: the daemon's own answer (bounded itself) and the wait.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.denialsWaitMs ?? DENIALS_WAIT_MS);
    });
    try {
      const answer = await options.manifest(threadId);
      switch (answer.kind) {
        case "manifest": {
          const prepared = await recordManifest(threadId, launchKey, answer.manifest);
          // From the daemon the host's socket names now: its epoch is the live one. An answer from
          // a socket that is no longer current is stale — used for this launch, its stamp unrecorded.
          if (answer.current === false) stalePulls.add(prepared);
          else pulled.add(prepared);
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
          return await build(threadId, [], "", [], "manifest");
        case "unavailable": {
          // A refresh that reached this thread while the daemon was asked is the daemon's word.
          if (box.pushed !== undefined) return await awaitDenials(threadId, launchKey, box, deadline);
          const known = lastKnown(threadId, launchKey);
          if (known !== null) {
            options.logger?.warn("session tools: no manifest from the daemon; this session uses the denials last known for its launch key", { threadId });
            warnFallback(threadId);
            return known;
          }
          options.logger?.warn("session tools: no manifest from the daemon and no denials known for this launch; waiting for them", { threadId, agent: launch.agent });
          return await awaitDenials(threadId, launchKey, box, deadline);
        }
      }
    } finally {
      clearTimeout(timer);
      boxes.delete(box);
      if (boxes.size === 0 && mailboxes.get(threadId) === boxes) mailboxes.delete(threadId);
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
      launched.set(threadId, { prepared, owner, launchKey: launchKeyOf(launch), ...(live ? { live } : {}) });
      // A refresh that claimed a NEWER manifest while this read was in flight keeps what it wants —
      // unless this launch could not ask the daemon at all: a restart would only fall back again
      // (restart churn at every idle point); the daemon's next answer or push brings the change.
      const wanted = desired.get(threadId);
      if (prepared.source === "fallback" || wanted === undefined || !newerThan(stampOf(wanted), stampOf(prepared))) desired.delete(threadId);
      forced.delete(threadId);
      if (prepared.source !== "fallback" && !stalePulls.has(prepared)) noteSeq(threadId, stampOf(prepared), pulled.has(prepared));
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
      // A launch reading its manifest right now takes it if the daemon cannot answer it (it waits
      // for its denials); otherwise the refresh is judged against what it launches with.
      offerPushed(threadId, manifest);
      const inFlight = launching.get(threadId);
      if (inFlight) await inFlight;
      // The launch launched with this very manifest: nothing is left to apply.
      if (adopted.has(manifest)) return launched.has(threadId) ? "unchanged" : "next-start";
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
      // The daemon answers again: the thread's degraded state is over.
      degradedWarned.delete(threadId);
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
          want(threadId, next);
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
      want(threadId, next);
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
      let prepared: PreparedSessionTools;
      try {
        prepared = await launchWith(threadId, launch, issued.grantId);
      } catch (error) {
        // No session starts on it (its denials are unknown): the credential dies here.
        credentials.revokeGrant(issued.grantId);
        throw error;
      }
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
    abortThreadCalls(threadId) {
      abortWhere((call) => call.threadId === threadId);
      cancelLaunchWaits(threadId);
    },
    forgetThread(threadId) {
      cancelLaunchWaits(threadId);
      degradedWarned.delete(threadId);
      desiredLaunchKey.delete(threadId);
      lastByThread.delete(threadId);
      lastSeq.delete(threadId);
      desired.delete(threadId);
      forced.delete(threadId);
    },
    async stop() {
      stopped = true;
      // A launch waiting for its denials gives up now.
      for (const boxes of mailboxes.values()) for (const box of boxes) box.wake?.();
      credentials.revokeAll();
      abortWhere(() => true);
      launched.clear();
      desired.clear();
      desiredLaunchKey.clear();
      forced.clear();
      lastByLaunch.clear();
      lastByThread.clear();
      degradedWarned.clear();
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
 * and handed back (§12.1 does not fail open). Denials that stay unknown
 * ({@link SessionToolsDenialsUnknownError}) are thrown: the session does not start.
 * `{prepared: null}` without session tools.
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
    // Unknown denials refuse the session itself (§12.1), never only its tools.
    if (isSessionToolsDenialsUnknown(error)) throw error;
    context.logger.warn("session tools: no credential for this session; it runs without them (its MCP denials still apply)", {
      threadId,
      error: error instanceof Error ? error.message : String(error)
    });
    const prepared = await host.prepare(threadId, launch).catch((failure: unknown) => {
      if (isSessionToolsDenialsUnknown(failure)) throw failure;
      return null;
    });
    const deniedUrl = await host.deniedUrl();
    return { prepared, ...(deniedUrl !== undefined ? { deniedUrl } : {}) };
  }
}

export { SessionToolCredentials } from "./credentials.ts";
export { createDaemonForwarder, createDaemonManifestClient } from "./forwarder.ts";
