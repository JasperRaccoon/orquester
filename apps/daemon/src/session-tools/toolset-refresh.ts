/**
 * The chat transport's daemon half of toolsets (unified MCP design 2026-10-15 §9.3, §9.4):
 *
 * - **The manifest route** (`daemonRoutesForHost.sessionToolsManifest`, socket-only, the agent
 *   host's bearer): `{tools, instructions, deny}` for one provider session of a thread, built from
 *   the thread's tab, its resolved toolsets, the workflow-owned trait (owner + lineage walk) and the
 *   daemon-pointing MCP servers (`GET /api/agent-profile/daemon-mcp-servers`, Task 11's read; none
 *   until it answers). What a `launch` hands out is what the thread advertises
 *   (`AgentToolsService.setAdvertisedToolsets` → the Tools chip's `appliesAtNextIdle`).
 * - **Refresh**: on `onToolsetsChanged` (a chat's toolsets, or every chat's on a settings change,
 *   {@link REFRESH_CONCURRENCY} chats at a time) the new manifest is pushed to the host
 *   (`agentHostRoutes.sessionToolsRefresh`). The host applies it in-session where the provider
 *   re-lists on `tools/list_changed` (Claude: answered `live` once the CLI re-listed, bounded) and
 *   otherwise marks the live session stale (`next-idle`: restart with resume at its next idle point,
 *   never under a running turn). The advertised set moves only on `live`/`unchanged`; any other
 *   answer leaves the change PENDING, so `appliesAtNextIdle` (what `request_toolset` answers
 *   from) never claims "now" falsely. An approved `request_toolset` card awaits that answer
 *   ({@link SessionToolsRefresher.toolsetApproved}) before the call resumes.
 * - **The automatic continue turn** (§9.3): after an approved `request_toolset` card whose push the
 *   host answered `next-idle` (a restart really is pending), wait for the turn that asked to settle; then, unless
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
  SESSION_TOOLS_REFRESH_TIMEOUT_MS,
  type SessionToolsManifest,
  type SessionToolsManifestRequest,
  type SessionToolsRefreshResponse
} from "../agent-host/host-protocol.ts";
import type { AnyOrquesterTool, ThreadCaller } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { isWorkflowOwned } from "../mcp/gate/scope.ts";
import { listSessions, readThread, sendCommand } from "../mcp/reads.ts";
import { turnBaseline, waitForTurn } from "../mcp/wait.ts";
import { buildSessionToolsManifest, type ManifestThread } from "./manifest.ts";

/** How long a scheduled continue waits for the asking turn to settle; past it nothing is posted. */
export const TOOLSET_CONTINUE_WAIT_MS = 60 * 60 * 1000;

/** How long a read of the daemon-pointing servers is reused (the read walks every account home). */
export const DAEMON_POINTING_CACHE_MS = 30_000;

/**
 * How long `request_toolset` waits for the host to apply its toolset: just above the push's own
 * bound, which is above the host's worst case (a launch read it waits for + Claude's re-list), so
 * an answer the host gives is never lost to this wait — the result stays truthful.
 */
export const TOOLSET_APPLY_WAIT_MS = SESSION_TOOLS_REFRESH_TIMEOUT_MS + 1_000;

/** Chats refreshed at once after a settings change. */
export const REFRESH_CONCURRENCY = 4;

/** What the host did with a pushed manifest; `no-host` — nothing reached a live session. */
export type RefreshAnswer = SessionToolsRefreshResponse["applied"] | "no-host";

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
  /** Overrides {@link TOOLSET_APPLY_WAIT_MS} (tests). */
  applyWaitMs?: number;
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
  /** The push in flight per chat (a `request_toolset` call awaits its answer). */
  private readonly pushes = new Map<string, Promise<RefreshAnswer>>();
  /** The last GOOD read of the daemon-pointing servers; `stale` once invalidated (re-read, but kept). */
  private pointing: { at: number; servers: readonly DaemonPointingServer[]; stale: boolean } | null = null;
  /** The manifest sequence clock: monotonic within this daemon process. */
  private seqClock = 0;
  /** This daemon process's epoch: the host compares sequences only within one epoch. */
  private readonly epoch = randomUUID();
  /** The newest push each chat got an answer for (a superseded `request_toolset` reads it). */
  private readonly latestAnswer = new Map<string, { seq: number; answer: RefreshAnswer }>();
  /** The newest sequence each chat's advertised set was taken from: an older answer never overwrites it. */
  private readonly advertisedSeq = new Map<string, number>();
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
    this.advertisedSeq.delete(threadId);
    this.latestAnswer.delete(threadId);
    this.cancelContinue(threadId);
  }

  stop(): void {
    this.stopped = true;
    for (const threadId of [...this.continues.keys()]) this.cancelContinue(threadId);
  }

  /**
   * The daemon-pointing servers (Task 11's read), reused for {@link DAEMON_POINTING_CACHE_MS}.
   * Fails CLOSED (§12.1): every failed read is a warning and answers the last GOOD list (also
   * after an invalidation, which only marks it stale), or `null` when none was ever read — the
   * manifest is then unavailable (503) and the host falls back to what it knows for that launch.
   * Only a route-miss 404 (a daemon without the detection: Fastify's own not-found body, no `code`)
   * means "none"; a 404 carrying our own error code is a failure.
   */
  async daemonPointing(): Promise<readonly DaemonPointingServer[] | null> {
    const cached = this.pointing;
    if (cached && !cached.stale && this.now() - cached.at < DAEMON_POINTING_CACHE_MS) return cached.servers;
    const failed = (why: string): readonly DaemonPointingServer[] | null => {
      this.deps.logger?.warn?.(`session-tools: the daemon-pointing MCP servers could not be read (${why}); ${cached ? "the last good list is reused" : "manifests are unavailable until a read succeeds"}`);
      return cached ? cached.servers : null;
    };
    const api = this.deps.api();
    if (!api) return failed("no API yet");
    try {
      const res = await api.request("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE);
      if (res.status === 404) {
        const body = res.body as { code?: unknown } | null;
        if (body !== null && typeof body === "object" && typeof body.code === "string") return failed(`404 ${body.code}`);
        this.pointing = { at: this.now(), servers: [], stale: false };
        return [];
      }
      const servers = (res.body as Partial<DaemonMcpServersResponse> | null)?.servers;
      if (res.status !== 200 || !Array.isArray(servers)) return failed(`HTTP ${res.status}`);
      const valid = servers.filter(
        (server): server is DaemonPointingServer =>
          server !== null && typeof server === "object" && typeof server.name === "string" && typeof server.agent === "string" && typeof server.home === "string"
      );
      this.pointing = { at: this.now(), servers: valid, stale: false };
      return valid;
    } catch (error) {
      return failed(error instanceof Error ? error.message : "request failed");
    }
  }

  /** A new or changed MCP server config: the next manifest reads the servers afresh (the last good list stays the fallback). */
  invalidateDaemonPointing(): void {
    if (this.pointing) this.pointing = { ...this.pointing, stale: true };
  }

  /** The next manifest sequence: strictly increasing within this process (its epoch orders restarts). */
  private nextSeq(): number {
    this.seqClock += 1;
    return this.seqClock;
  }

  /** Take `toolsets` as what a chat advertises, unless a newer manifest already set it. */
  private setAdvertised(threadId: string, toolsets: readonly string[], seq: number): void {
    if (seq < (this.advertisedSeq.get(threadId) ?? -Infinity)) return;
    this.advertisedSeq.set(threadId, seq);
    this.advertised.set(threadId, [...toolsets]);
  }

  /**
   * The thread's manifest; null when it is no open chat; `"unavailable"` when its denials cannot
   * be derived (no daemon-pointing read ever succeeded) — the route answers 503 then.
   */
  async manifest(threadId: string, purpose: "launch" | "check" = "launch"): Promise<SessionToolsManifest | null | "unavailable"> {
    const thread = this.deps.thread(threadId);
    if (!thread) return null;
    const daemonPointing = await this.daemonPointing();
    if (daemonPointing === null) return "unavailable";
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
      daemonPointing
    });
    const seq = this.nextSeq();
    if (purpose === "launch") this.setAdvertised(threadId, toolsets, seq);
    return { ...manifest, seq, epoch: this.epoch };
  }

  /**
   * `onToolsetsChanged`: a chat's (`threadId`) or every chat's (`null`) toolsets changed. It runs
   * after a toolset card settled and BEFORE the awaiting `request_toolset` call resumes; the push
   * only starts here — the host applies it in-session where the provider re-lists (Claude) or marks
   * the live session stale for a restart at its next idle point, never under the running call —
   * and the call itself awaits the host's answer through {@link toolsetApproved} before it reads
   * `appliesAtNextIdle`.
   */
  toolsetsChanged(threadId: string | null): void {
    if (this.stopped) return;
    if (threadId !== null) {
      this.pushLogged(threadId);
      return;
    }
    void this.refresh(null).catch((error: unknown) =>
      this.deps.logger?.warn?.("session-tools: refresh failed", error instanceof Error ? error.message : String(error))
    );
  }

  private pushLogged(threadId: string): Promise<RefreshAnswer> {
    return this.push(threadId).catch((error: unknown) => {
      this.deps.logger?.warn?.("session-tools: refresh failed", error instanceof Error ? error.message : String(error));
      return "no-host" as const;
    });
  }

  /**
   * Push one chat's manifest and record what its live session advertises now: the new set only
   * when the host applied it (`live`, `unchanged`); otherwise PENDING — the old set, or none — so
   * `appliesAtNextIdle` never claims "now" falsely.
   */
  push(threadId: string): Promise<RefreshAnswer> {
    const pending = (async (): Promise<RefreshAnswer> => {
      const manifest = await this.manifest(threadId, "check");
      if (manifest === null) return "no-host";
      if (manifest === "unavailable") {
        this.markPending(threadId);
        return "no-host";
      }
      const answer = await this.deps.pushToHost(threadId, manifest);
      const applied: RefreshAnswer = answer?.applied ?? "no-host";
      const seq = manifest.seq ?? this.nextSeq();
      // A newer push decided already: this answer changes nothing.
      if (applied === "superseded" || seq < (this.advertisedSeq.get(threadId) ?? -Infinity)) return applied;
      if (seq > (this.latestAnswer.get(threadId)?.seq ?? -Infinity)) this.latestAnswer.set(threadId, { seq, answer: applied });
      if (applied === "live" || applied === "unchanged") this.setAdvertised(threadId, manifest.toolsets ?? [], seq);
      else this.markPending(threadId);
      return applied;
    })();
    this.pushes.set(threadId, pending);
    void pending.finally(() => {
      if (this.pushes.get(threadId) === pending) this.pushes.delete(threadId);
    }).catch(() => undefined);
    return pending;
  }

  /** The live session keeps what it launched with (or, unknown, nothing): the change is pending. */
  private markPending(threadId: string): void {
    if (!this.advertised.has(threadId)) this.advertised.set(threadId, []);
  }

  /** Push the new manifest of one chat, or of every open chat ({@link REFRESH_CONCURRENCY} at a time). */
  async refresh(threadId: string | null): Promise<Map<string, RefreshAnswer>> {
    const answers = new Map<string, RefreshAnswer>();
    const ids = threadId === null ? this.deps.openThreads() : [threadId];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length && !this.stopped) {
        const id = ids[next++]!;
        answers.set(id, await this.pushLogged(id));
      }
    };
    await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, ids.length) }, worker));
    return answers;
  }

  /**
   * `executorPorts.onToolsetApproved`, awaited by the executor before `request_toolset` resumes:
   * wait (bounded) for the host's answer to the push the change started. `live` / `unchanged` —
   * the advertised set is the new one ("now"); `next-idle` — a restart really is pending: the
   * automatic continue is scheduled ("after-restart"); anything else (no host, no live session, no
   * answer in time) — pending, truthfully "after-restart", and NO continue (nothing would restart).
   */
  async toolsetApproved(caller: ThreadCaller, toolset: string): Promise<void> {
    if (this.stopped) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.deps.applyWaitMs ?? TOOLSET_APPLY_WAIT_MS);
    });
    let push = this.pushes.get(caller.threadId) ?? this.pushLogged(caller.threadId);
    let answer: RefreshAnswer | "timeout";
    try {
      // A push another one overtook answers `superseded`: the newest one decides.
      for (;;) {
        answer = await Promise.race([push, deadline]);
        if (answer !== "superseded") break;
        const newer = this.pushes.get(caller.threadId);
        if (newer !== undefined && newer !== push) {
          push = newer;
          continue;
        }
        // The newer push that overtook this one has finished already: ITS outcome is the change's.
        answer = this.latestAnswer.get(caller.threadId)?.answer ?? "superseded";
        break;
      }
    } finally {
      clearTimeout(timer);
    }
    if (answer === "timeout") {
      this.markPending(caller.threadId);
      return;
    }
    if (answer !== "next-idle") return;
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
    // §12.1 fails closed: no denials can be derived — the host falls back to what it knows for
    // this launch, and warns.
    if (manifest === "unavailable") return reply.code(503).send({ code: "UNAVAILABLE", message: "The daemon-pointing MCP servers cannot be read yet." });
    return reply.code(200).send(manifest);
  });
}
