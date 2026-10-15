/**
 * The chat transport's daemon half of toolsets (unified MCP design 2026-10-15 §9.3, §9.4):
 *
 * - **The manifest route** (`daemonRoutesForHost.sessionToolsManifest`, socket-only, the agent
 *   host's bearer): `{tools, instructions, deny}` for one provider session of a thread, built from
 *   the thread's tab, its resolved toolsets, the workflow-owned trait (owner + lineage walk) and the
 *   daemon-pointing MCP servers (`GET /api/agent-profile/daemon-mcp-servers`, Task 11's read; none
 *   until it answers). What a `launch` hands out is what the thread advertises
 *   (`AgentToolsService.setAdvertisedToolsets` → the Tools chip's `appliesAtNextIdle`).
 * - **Refresh**: on `onToolsetsChanged` (a chat's toolsets, or every chat's on a settings change)
 *   the new manifest is pushed to the host (`agentHostRoutes.sessionToolsRefresh`). The listener
 *   runs after a toolset card settled but BEFORE the awaiting call resumes (and `request_toolset`
 *   answers `now` / `after-restart` from `appliesAtNextIdle`): where the provider re-lists on
 *   `tools/list_changed` (Claude) the advertised set moves at once and the host replaces the list
 *   in-session; any other live session keeps its list, the push is deferred to a later macrotask,
 *   and the host restarts it with resume at its NEXT idle point (the next turn's send), never under
 *   a running turn.
 * - **The automatic continue turn** (§9.3): after an approved `request_toolset` card in a chat whose
 *   provider cannot take the tools in-session, wait for the turn that asked to settle; then, unless
 *   the user spoke first (a user message since, or another turn ran), post `[Orquester] The <label>
 *   tools are now available. Continue the task you were doing.` with the `toolset-continue` chip, in
 *   the chat's interaction mode at request time, `ifIdle` (a racing user turn wins), no `causedBy`.
 *   Its send is what restarts the session with the new tools.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import {
  AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE,
  isToolsetId,
  toolsetById,
  type DaemonMcpServersResponse,
  type DaemonPointingServer,
  type SessionSummary
} from "@orquester/api";
import {
  buildToolsetContinueMessage,
  isThreadAuthoredMessage,
  isMergeBackMessage,
  isToolsetContinueMessage,
  toolsetContinueContext,
  type AgentAdapterId,
  type InteractionMode,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import {
  daemonRoutesForHost,
  type SessionToolsManifest,
  type SessionToolsManifestRequest,
  type SessionToolsRefreshResponse
} from "../agent-host/host-protocol.ts";
import type { AnyOrquesterTool, ThreadCaller } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { isWorkflowOwned } from "../mcp/gate/scope.ts";
import { listSessions, readThread, sendCommand } from "../mcp/reads.ts";
import { turnBaseline, waitForTurn } from "../mcp/wait.ts";
import { buildSessionToolsManifest, toolsetAvailability, type ManifestThread } from "./manifest.ts";

/** How long a scheduled continue waits for the asking turn to settle; past it nothing is posted. */
export const TOOLSET_CONTINUE_WAIT_MS = 60 * 60 * 1000;

/** How long a read of the daemon-pointing servers is reused (the read walks every account home). */
export const DAEMON_POINTING_CACHE_MS = 30_000;

export interface ToolsetRefreshThread {
  agentId: AgentAdapterId;
  /** `"system"` or the managed account id the thread runs as. */
  home: string;
  /** The tab's project root ("" when unbound). */
  projectPath: string;
  /** Its canonical spelling, when the daemon resolves one. */
  canonicalProjectPath?: string;
}

export interface ToolsetRefreshDeps {
  /** The open chat thread, or null (closed, unknown, not a chat, no known adapter). */
  thread(threadId: string): ToolsetRefreshThread | null;
  /** Every open chat thread (a settings change refreshes them all). */
  openThreads(): string[];
  resolvedToolsets(threadId: string, agent: AgentAdapterId): readonly string[];
  /** Settings › Agent tools' master switch. */
  agentToolsEnabled(): boolean;
  /** The chat audience of the catalog. */
  catalog(): readonly AnyOrquesterTool[];
  /** The daemon's in-process API (null while it does not exist yet). */
  api(): DaemonApi | null;
  /**
   * Push a manifest to the host; null when the host is down or predates the route (the change then
   * applies at the thread's next session start). Never throws.
   */
  pushToHost(threadId: string, manifest: SessionToolsManifest): Promise<SessionToolsRefreshResponse | null>;
  now?: () => number;
  /** Schedules the refresh on a LATER macrotask (default `setImmediate`); tests drive it. */
  defer?: (run: () => void) => void;
  logger?: { log?(message: string): void; warn?(message: string, detail?: unknown): void };
}

/** One scheduled continue. */
interface PendingContinue {
  controller: AbortController;
  toolset: string;
}

const isUserAuthored = (item: ThreadSnapshotPayload["items"][number]): boolean =>
  item.kind === "message" &&
  item.role === "user" &&
  !isThreadAuthoredMessage(item) &&
  !isMergeBackMessage(item) &&
  !isToolsetContinueMessage(item);

/** The ids of the user's own messages in a snapshot (chips from other chats or Orquester excluded). */
export function userMessageIds(snapshot: ThreadSnapshotPayload): Set<string> {
  return new Set(snapshot.items.filter(isUserAuthored).map((item) => item.id));
}

export class SessionToolsRefresher {
  private readonly advertised = new Map<string, readonly string[]>();
  private readonly continues = new Map<string, PendingContinue>();
  private pointing: { at: number; servers: readonly DaemonPointingServer[] } | null = null;
  private stopped = false;

  constructor(private readonly deps: ToolsetRefreshDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** What each chat's provider session was last handed (`AgentToolsService.setAdvertisedToolsets`). */
  advertisedToolsets(threadId: string): readonly string[] | null {
    return this.advertised.get(threadId) ?? null;
  }

  /** A closed chat: forget it, and drop its scheduled continue. */
  forget(threadId: string): void {
    this.advertised.delete(threadId);
    this.cancelContinue(threadId);
  }

  stop(): void {
    this.stopped = true;
    for (const threadId of [...this.continues.keys()]) this.cancelContinue(threadId);
  }

  /**
   * The daemon-pointing servers (Task 11's read), reused for {@link DAEMON_POINTING_CACHE_MS}. A
   * failed read keeps the last good list (a 404 from a daemon without the detection is "none").
   */
  async daemonPointing(): Promise<readonly DaemonPointingServer[]> {
    const cached = this.pointing;
    if (cached && this.now() - cached.at < DAEMON_POINTING_CACHE_MS) return cached.servers;
    const api = this.deps.api();
    if (!api) return cached?.servers ?? [];
    try {
      const res = await api.request("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE);
      if (res.status === 404) {
        this.pointing = { at: this.now(), servers: [] };
        return [];
      }
      const servers = (res.body as Partial<DaemonMcpServersResponse> | null)?.servers;
      if (res.status !== 200 || !Array.isArray(servers)) return cached?.servers ?? [];
      const valid = servers.filter(
        (server): server is DaemonPointingServer =>
          server !== null && typeof server === "object" && typeof server.name === "string" && typeof server.agent === "string" && typeof server.home === "string"
      );
      this.pointing = { at: this.now(), servers: valid };
      return valid;
    } catch {
      return cached?.servers ?? [];
    }
  }

  /** A new or changed MCP server config: the next manifest reads the servers afresh. */
  invalidateDaemonPointing(): void {
    this.pointing = null;
  }

  /** The thread's manifest, or null when it is no open chat. */
  async manifest(threadId: string, purpose: "launch" | "check" = "launch"): Promise<SessionToolsManifest | null> {
    const thread = this.deps.thread(threadId);
    if (!thread) return null;
    const api = this.deps.api();
    // The workflow-owned trait walks lineage through closed tabs (the gate's own walk): fail
    // closed — an unreadable list counts as owned, so no Admin tool is advertised.
    let workflowOwned = true;
    if (api) {
      try {
        workflowOwned = isWorkflowOwned(await listSessions(api), threadId);
      } catch {
        workflowOwned = true;
      }
    }
    const manifestThread: ManifestThread = {
      agentId: thread.agentId,
      home: thread.home,
      projectPaths: [thread.projectPath, thread.canonicalProjectPath ?? ""].filter((path) => path !== ""),
      workflowOwned
    };
    const toolsets = this.deps.resolvedToolsets(threadId, thread.agentId);
    const manifest = buildSessionToolsManifest({
      thread: manifestThread,
      toolsets,
      agentToolsEnabled: this.deps.agentToolsEnabled(),
      catalog: this.deps.catalog(),
      daemonPointing: await this.daemonPointing()
    });
    if (purpose === "launch") this.advertised.set(threadId, [...toolsets]);
    return manifest;
  }

  /**
   * `onToolsetsChanged`: a chat's (`threadId`) or every chat's (`null`) toolsets changed. It runs
   * after a toolset card settled and BEFORE the awaiting `request_toolset` call resumes — which
   * reads `appliesAtNextIdle` (the advertised set against the resolved one) to answer `now` or
   * `after-restart`. So, synchronously, per chat:
   * - a provider that re-lists in-session (Claude): the advertised set becomes the new one and the
   *   manifest is pushed at once (the host replaces the list and sends `list_changed`; nothing
   *   restarts, the running call is untouched);
   * - any other: the advertised set stays what the live session launched with (unknown → none), and
   *   the push is deferred to a later macrotask; the host restarts that session with resume at its
   *   next idle point.
   */
  toolsetsChanged(threadId: string | null): void {
    if (this.stopped) return;
    const ids = threadId === null ? this.deps.openThreads() : [threadId];
    const deferred: string[] = [];
    for (const id of ids) {
      const thread = this.deps.thread(id);
      if (!thread) continue;
      if (toolsetAvailability(thread.agentId) === "now") {
        if (this.advertised.has(id)) this.advertised.set(id, [...this.deps.resolvedToolsets(id, thread.agentId)]);
        this.pushLogged(id);
      } else {
        // The live session keeps what it launched with until it restarts.
        if (!this.advertised.has(id)) this.advertised.set(id, []);
        deferred.push(id);
      }
    }
    if (deferred.length === 0) return;
    const defer = this.deps.defer ?? ((run: () => void) => void setImmediate(run));
    defer(() => {
      for (const id of deferred) this.pushLogged(id);
    });
  }

  private pushLogged(threadId: string): void {
    void this.refresh(threadId).catch((error: unknown) =>
      this.deps.logger?.warn?.("session-tools: refresh failed", error instanceof Error ? error.message : String(error))
    );
  }

  /** Push the new manifest of one chat, or of every open chat. Returns what each host answered. */
  async refresh(threadId: string | null): Promise<Map<string, SessionToolsRefreshResponse["applied"] | "no-host">> {
    const answers = new Map<string, SessionToolsRefreshResponse["applied"] | "no-host">();
    const ids = threadId === null ? this.deps.openThreads() : [threadId];
    for (const id of ids) {
      if (this.stopped) break;
      const manifest = await this.manifest(id, "check");
      if (!manifest) continue;
      const answer = await this.deps.pushToHost(id, manifest);
      answers.set(id, answer?.applied ?? "no-host");
      if (answer?.applied === "live" || answer?.applied === "unchanged") {
        // What the live session advertises now.
        this.advertised.set(id, manifest.toolsets ?? []);
      } else if (answer?.applied === "next-idle" && this.advertised.has(id) && toolsetAvailability(this.deps.thread(id)?.agentId ?? "") === "now") {
        // An in-session provider that could not take it live (its denials moved): pending again.
        this.advertised.set(id, []);
      }
    }
    return answers;
  }

  /**
   * `executorPorts.onToolsetApproved`: a `request_toolset` card was approved while the call runs.
   * Where the provider cannot take the tools in-session, the automatic continue is scheduled.
   */
  toolsetApproved(caller: ThreadCaller, toolset: string): void {
    // Mirrors `appliesAtNextIdle`, which `request_toolset` answers from: the listener ran before
    // this, so an in-session provider's advertised set is already the new one ("now").
    const advertised = this.advertised.get(caller.threadId);
    const resolved = this.deps.resolvedToolsets(caller.threadId, caller.agentId);
    const pending = advertised !== undefined && (advertised.length !== resolved.length || resolved.some((id) => !advertised.includes(id)));
    if (this.stopped || !pending) return;
    void this.scheduleContinue(caller.threadId, toolset, caller.planning ? "plan" : "default").catch((error: unknown) =>
      this.deps.logger?.warn?.("session-tools: the automatic continue failed", error instanceof Error ? error.message : String(error))
    );
  }

  private cancelContinue(threadId: string): void {
    const pending = this.continues.get(threadId);
    if (!pending) return;
    this.continues.delete(threadId);
    pending.controller.abort();
  }

  /**
   * Wait for the asking turn to settle, then post the continue unless the user spoke first. Returns
   * what happened (for the log and the tests).
   */
  async scheduleContinue(threadId: string, toolset: string, interactionMode: InteractionMode): Promise<"posted" | "skipped" | "cancelled"> {
    const api = this.deps.api();
    if (!api) return "skipped";
    // One continue per chat: a later approval supersedes the earlier one (it names the newest toolset).
    this.cancelContinue(threadId);
    const controller = new AbortController();
    this.continues.set(threadId, { controller, toolset });
    const done = (result: "posted" | "skipped" | "cancelled") => {
      if (this.continues.get(threadId)?.controller === controller) this.continues.delete(threadId);
      return result;
    };
    try {
      const [sessions, before] = await Promise.all([listSessions(api), readThread(api, threadId)]);
      const summary = sessions.find((session: SessionSummary) => session.id === threadId);
      if (!summary) return done("skipped");
      const baseline = turnBaseline(summary);
      const seen = userMessageIds(before);
      const { outcome, summary: after } = await waitForTurn(api, threadId, baseline, {
        timeoutMs: TOOLSET_CONTINUE_WAIT_MS,
        signal: controller.signal,
        now: this.deps.now ?? Date.now
      });
      if (controller.signal.aborted) return done("cancelled");
      // Only a turn that finished on its own: a Stop, a failure, a plan or a question is the user's.
      if (outcome !== "completed" || !after || after.latestTurn?.turnId !== baseline.turnId) return done("skipped");
      const settled = await readThread(api, threadId);
      if ([...userMessageIds(settled)].some((id) => !seen.has(id))) return done("skipped");
      if (controller.signal.aborted) return done("cancelled");
      const label = (isToolsetId(toolset) ? toolsetById(toolset)?.label : undefined) ?? toolset;
      try {
        await sendCommand(api, threadId, "turn", {
          input: buildToolsetContinueMessage(label),
          interactionMode,
          context: [toolsetContinueContext(toolset)],
          // A user turn that raced in wins: no steer into it (TURN_NOT_IDLE, never a receipt).
          ifIdle: true
        }, { commandId: `toolset-continue-${randomUUID()}` });
      } catch (error) {
        this.deps.logger?.log?.(`session-tools: no continue for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return done("skipped");
      }
      return done("posted");
    } catch (error) {
      if (controller.signal.aborted) return done("cancelled");
      throw error;
    }
  }
}

/** The manifest route's dependencies. */
export interface SessionToolsManifestRouteDeps {
  authorizeHost(authorization: string | undefined): boolean;
  refresher: SessionToolsRefresher;
}

/**
 * `POST daemonRoutesForHost.sessionToolsManifest` — SOCKET-ONLY (registered on the unix-socket app
 * alone), and the agent host's bearer besides: the manifest names a thread's deny list.
 */
export function registerSessionToolsManifestRoute(app: FastifyInstance, deps: SessionToolsManifestRouteDeps): void {
  app.post(daemonRoutesForHost.sessionToolsManifest, async (request, reply) => {
    if (!deps.authorizeHost(request.headers.authorization)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "Only the agent host may read session-tool manifests." });
    }
    const body = request.body as Partial<SessionToolsManifestRequest> | null;
    const threadId = body?.threadId;
    if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "threadId is required." });
    }
    const manifest = await deps.refresher.manifest(threadId, body?.purpose === "check" ? "check" : "launch");
    if (!manifest) return reply.code(404).send({ code: "THREAD_NOT_FOUND", message: "No chat thread with that id." });
    return reply.code(200).send(manifest);
  });
}
