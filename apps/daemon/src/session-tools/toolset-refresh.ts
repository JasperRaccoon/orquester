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
import { resolve as resolvePath } from "node:path";

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
import type { AnyOrquesterTool, ThreadCaller, ToolsetApplyOutcome } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { isWorkflowOwned } from "../mcp/gate/scope.ts";
import { listSessions, readThread, sendCommand } from "../mcp/reads.ts";
import { turnBaseline, waitForTurn } from "../mcp/wait.ts";
import { buildSessionToolsManifest, isWithinDir, type ManifestThread } from "./manifest.ts";

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

/**
 * How long the daemon-pointing read may take before the last good list (or "unavailable") answers.
 * With {@link MANIFEST_SESSIONS_READ_TIMEOUT_MS} it bounds a manifest well below the host's own
 * bound on asking for it (`MANIFEST_TIMEOUT_MS`, 10 s), so the host never gives up on an answer
 * the daemon is about to give.
 */
export const DAEMON_POINTING_READ_TIMEOUT_MS = 4_000;

/** How long the session list read for the workflow-owned trait may take before it counts as owned. */
export const MANIFEST_SESSIONS_READ_TIMEOUT_MS = 3_000;

/** At most this many per-chat-cwd reads are cached (the all-projects read is always kept). */
export const MAX_POINTING_SCOPES = 32;

/**
 * How long after a refused launch manifest (503) the chat's manifest is pushed to the host once a
 * daemon-pointing read succeeds: above the host's wait for denials (`DENIALS_WAIT_MS`, 15 s).
 */
export const REFUSED_PUSH_WINDOW_MS = 20_000;

/** One push in flight: its outcome, its stamp once its manifest is built, and when the host was asked. */
export interface PushHandle {
  done: Promise<RefreshAnswer>;
  stamp: { seq: number; epoch: string } | undefined;
  hostStarted: Promise<void>;
}

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
  /** The tab's cwd (the project root unless the chat was started in a directory inside it). */
  cwd?: string;
  /** Its canonical spelling, when the daemon resolves one. */
  canonicalCwd?: string;
}

/** A read of the daemon-pointing servers for a chat in a directory inside its project. */
interface PointingScope {
  projectPath: string;
  cwd: string;
}

type PointingRead = { servers: readonly DaemonPointingServer[] } | { failed: string } | { uncontained: true };

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
  /** Overrides {@link DAEMON_POINTING_READ_TIMEOUT_MS} (tests). */
  pointingReadTimeoutMs?: number;
  /** Overrides {@link MANIFEST_SESSIONS_READ_TIMEOUT_MS} (tests). */
  sessionsReadTimeoutMs?: number;
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

/**
 * Fastify's own 404 for a route the app does not have (`{message: "Route GET:<url> not found",
 * error: "Not Found", statusCode: 404}`, nothing else): the detection route does not exist. Any
 * other 404 body — an error envelope, a flat code — came from a route that does.
 */
export function isFastifyRouteMiss(body: unknown): boolean {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3 &&
    keys.join(",") === "error,message,statusCode" &&
    record.statusCode === 404 &&
    record.error === "Not Found" &&
    typeof record.message === "string" &&
    /^Route [A-Z]+:\S* not found$/.test(record.message)
  );
}

export class SessionToolsRefresher {
  private readonly advertised = new Map<string, readonly string[]>();
  private readonly continues = new Map<string, PendingContinue>();
  /** The push in flight per chat (a `request_toolset` call awaits its answer). */
  private readonly pushes = new Map<string, PushHandle>();
  /**
   * The last GOOD read of the daemon-pointing servers per scope (`""`: every project's; else a
   * chat's project and cwd); `stale` once invalidated (re-read, but kept).
   */
  private readonly pointing = new Map<string, { at: number; servers: readonly DaemonPointingServer[]; stale: boolean }>();
  /** The read in flight per scope: concurrent manifests share it, and it outlives their timeouts. */
  private readonly pointingReads = new Map<string, Promise<PointingRead>>();
  /**
   * Chats whose launch manifest was refused (503), and since when: pushed once a read succeeds, and
   * kept until a push really reached the host (or {@link REFUSED_PUSH_WINDOW_MS} passed).
   */
  private readonly refused = new Map<string, number>();
  /** The manifest sequence clock: monotonic within this daemon process. */
  private seqClock = 0;
  /** This daemon process's epoch: the host compares sequences only within one epoch. */
  private readonly epoch = randomUUID();
  /** The newest push each chat got an answer for, with its stamp (a superseded `request_toolset` reads it). */
  private readonly latestAnswer = new Map<string, { seq: number; epoch: string; answer: RefreshAnswer }>();
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
    this.refused.delete(threadId);
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
   * The daemon-pointing servers (Task 11's read) — of every project, or with `scope`, of a chat's
   * project down to its cwd — reused for {@link DAEMON_POINTING_CACHE_MS}. Concurrent callers share
   * ONE read per scope, which outlives a caller's bound ({@link DAEMON_POINTING_READ_TIMEOUT_MS}):
   * when it lands it is cached, and the chats refused meanwhile get their manifest pushed.
   * Fails CLOSED (§12.1): every failed read is a warning and answers the last GOOD list (also
   * after an invalidation, which only marks it stale), or `null` when none was ever read — the
   * manifest is then unavailable (503) and the host waits for its denials (bounded), else refuses
   * the launch. Only a route-miss 404 (a daemon without the detection) means "none", and only when
   * its body is exactly Fastify's default not-found body ({@link isFastifyRouteMiss}). Every answer
   * of the detection itself that is not a 200 list — its own 404 or 400 (e.g. a `projectPath`
   * outside the workspaces root) in any envelope — is a failed read.
   */
  daemonPointing(): Promise<readonly DaemonPointingServer[] | null>;
  /** `"uncontained"`: the detection refuses that scope for good (no per-cwd scan possible). */
  daemonPointing(scope: PointingScope): Promise<readonly DaemonPointingServer[] | null | "uncontained">;
  async daemonPointing(scope?: PointingScope): Promise<readonly DaemonPointingServer[] | null | "uncontained"> {
    const key = scope ? `${scope.projectPath}\u0000${scope.cwd}` : "";
    const cached = this.pointing.get(key);
    if (cached && !cached.stale && this.now() - cached.at < DAEMON_POINTING_CACHE_MS) return cached.servers;
    const failed = (why: string): readonly DaemonPointingServer[] | null => {
      this.deps.logger?.warn?.(`session-tools: the daemon-pointing MCP servers could not be read (${why}); ${cached ? "the last good list is reused" : "manifests are unavailable until a read succeeds"}`);
      return cached ? cached.servers : null;
    };
    const api = this.deps.api();
    if (!api) return failed("no API yet");
    let read = this.pointingReads.get(key);
    if (read === undefined) {
      const started = this.readPointing(api, key, scope);
      read = started;
      this.pointingReads.set(key, started);
      void started.finally(() => {
        if (this.pointingReads.get(key) === started) this.pointingReads.delete(key);
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const answer = await Promise.race([
      read,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.deps.pointingReadTimeoutMs ?? DAEMON_POINTING_READ_TIMEOUT_MS);
      })
    ]).finally(() => clearTimeout(timer));
    if (answer === "timeout") return failed("timed out");
    if ("uncontained" in answer) return "uncontained";
    return "failed" in answer ? failed(answer.failed) : answer.servers;
  }

  /** One read of the detection route; a good answer is cached and releases the refused chats. Never throws. */
  private async readPointing(api: DaemonApi, key: string, scope: PointingScope | undefined): Promise<PointingRead> {
    try {
      const res = await api.request("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, scope ? { query: { projectPath: scope.projectPath, cwd: scope.cwd } } : undefined);
      // A chat-cwd read the detection refuses outright (its project's or cwd's real path is not
      // inside the workspaces root): no per-cwd scan is possible — never a failure that lasts.
      const code = (res.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (scope && res.status === 400 && code === "PATH_NOT_CONTAINED") return { uncontained: true };
      let servers: DaemonPointingServer[];
      if (res.status === 404 && isFastifyRouteMiss(res.body)) servers = [];
      else {
        const listed = (res.body as Partial<DaemonMcpServersResponse> | null)?.servers;
        if (res.status !== 200 || !Array.isArray(listed)) return { failed: `HTTP ${res.status}` };
        servers = listed.filter(
          (server): server is DaemonPointingServer =>
            server !== null && typeof server === "object" && typeof server.name === "string" && typeof server.agent === "string" && typeof server.home === "string"
        );
      }
      this.pointing.delete(key);
      this.pointing.set(key, { at: this.now(), servers, stale: false });
      // Bounded: the oldest chat-cwd read goes first (the all-projects one, "", always stays).
      const scoped = [...this.pointing.keys()].filter((entry) => entry !== "");
      for (const old of scoped.slice(0, Math.max(0, scoped.length - MAX_POINTING_SCOPES))) this.pointing.delete(old);
      this.releaseRefused();
      return { servers };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : "request failed" };
    }
  }

  /**
   * A read succeeded: push the manifest of every chat whose launch was refused within
   * {@link REFUSED_PUSH_WINDOW_MS} — the host's launch waiting for its denials takes it.
   */
  private releaseRefused(): void {
    if (this.stopped) return;
    const now = this.now();
    for (const [threadId, at] of [...this.refused]) {
      // The entry goes once a push reached the host (`push`), or when the host stopped waiting.
      if (now - at > REFUSED_PUSH_WINDOW_MS) this.refused.delete(threadId);
      else this.pushLogged(threadId);
    }
  }

  /** A newer read is wanted (a new or changed MCP server config); the last good lists stay the fallback. */
  invalidateDaemonPointing(): void {
    for (const [key, entry] of this.pointing) this.pointing.set(key, { ...entry, stale: true });
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
    const projectPaths = [thread.projectPath, thread.canonicalProjectPath ?? ""].filter((path) => path !== "");
    // A chat started in a directory inside its project also loads the configs on the way down to
    // it — decided on REAL paths. A cwd whose real path leaves its project (a symlink out), or a
    // project whose real path leaves the workspaces root (the detection refuses it: 400
    // PATH_NOT_CONTAINED), cannot be told what its CLI loads: every daemon-pointing server of its
    // agent known in any scope is denied by name, plus what the real cwd's own location configures.
    const realProject = thread.canonicalProjectPath || thread.projectPath;
    const realCwd = thread.canonicalCwd || thread.cwd || "";
    const atRoot = realCwd === "" || resolvePath(realCwd) === resolvePath(realProject);
    const inside = thread.projectPath !== "" && thread.cwd !== undefined && !atRoot && isWithinDir(realCwd, realProject);
    const escapes = thread.projectPath !== "" && !atRoot && !inside;
    // A project reached through a symlink: its own read says whether it is contained.
    const linked = thread.projectPath !== "" && resolvePath(realProject) !== resolvePath(thread.projectPath);
    let uncontained = false;
    let daemonPointing: readonly DaemonPointingServer[] | null = null;
    if (inside || (linked && !escapes)) {
      // Its own read holds what a CLI loads at its cwd (Codex's ancestors included); the
      // all-projects read reads each project root as its own cwd.
      const scoped = await this.daemonPointing({ projectPath: thread.projectPath, cwd: inside ? thread.cwd! : thread.projectPath });
      if (scoped === "uncontained") uncontained = true;
      else daemonPointing = scoped;
    }
    if (!(inside || (linked && !escapes)) || uncontained) daemonPointing = await this.daemonPointing();
    const denyEveryKnown = escapes || uncontained;
    if (denyEveryKnown && daemonPointing !== null && realCwd !== "") {
      // What the real cwd's own location configures, when the detection may read it (inside the
      // workspaces root); outside it, the names known anywhere stand.
      const own = await this.daemonPointing({ projectPath: realCwd, cwd: realCwd });
      if (own === null) daemonPointing = null;
      else if (own !== "uncontained") daemonPointing = [...daemonPointing, ...own];
    }
    if (daemonPointing === null) {
      if (!this.refused.has(threadId)) this.refused.set(threadId, this.now());
      return "unavailable";
    }
    const scanned = inside && !uncontained;
    const refusedAt = this.refused.get(threadId);
    if (refusedAt !== undefined && this.now() - refusedAt > REFUSED_PUSH_WINDOW_MS) this.refused.delete(threadId);
    // Refused before (and maybe still waited for — the host may have given up on an earlier
    // answer): a push follows, and only its delivery clears the chat.
    else if (refusedAt !== undefined && purpose === "launch") this.pushLogged(threadId);
    const cwdPaths = scanned ? [thread.cwd ?? "", thread.canonicalCwd ?? ""].filter((path) => path !== "" && !projectPaths.some((root) => resolvePath(root) === resolvePath(path))) : [];
    const api = this.deps.api();
    // The workflow-owned trait walks lineage through closed tabs (the gate's own walk): fail
    // closed — an unreadable (or unanswered, bounded) list counts as owned, so no Admin tool is
    // advertised.
    let workflowOwned = true;
    if (api) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const sessions = await Promise.race([
          listSessions(api),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), this.deps.sessionsReadTimeoutMs ?? MANIFEST_SESSIONS_READ_TIMEOUT_MS);
          })
        ]);
        if (sessions === "timeout") this.deps.logger?.warn?.("session-tools: the session list did not answer in time; the chat counts as workflow-owned");
        else workflowOwned = isWorkflowOwned(sessions, threadId);
      } catch {
        workflowOwned = true;
      } finally {
        clearTimeout(timer);
      }
    }
    const manifestThread: ManifestThread = {
      agentId: thread.agentId,
      home: thread.home,
      projectPaths,
      ...(cwdPaths.length > 0 ? { cwdPaths } : {}),
      ...(denyEveryKnown ? { denyEveryKnown: true } : {}),
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

  private pushLogged(threadId: string): PushHandle {
    const handle = this.push(threadId);
    // The same handle (its stamp is filled in later), its outcome never a rejection.
    handle.done = handle.done.catch((error: unknown) => {
      this.deps.logger?.warn?.("session-tools: refresh failed", error instanceof Error ? error.message : String(error));
      return "no-host" as const;
    });
    return handle;
  }

  /**
   * Push one chat's manifest and record what its live session advertises now: the new set only
   * when the host applied it (`live`, `unchanged`); otherwise PENDING — the old set, or none — so
   * `appliesAtNextIdle` never claims "now" falsely. The handle names the push's stamp once its
   * manifest is built, and `hostStarted` resolves when the host is asked (or the push ends first).
   */
  push(threadId: string): PushHandle {
    let markStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => (markStarted = resolve));
    const handle: PushHandle = { done: Promise.resolve("no-host"), stamp: undefined, hostStarted };
    handle.done = (async (): Promise<RefreshAnswer> => {
      try {
        const manifest = await this.manifest(threadId, "check");
        if (manifest === null) return "no-host";
        if (manifest === "unavailable") {
          this.markPending(threadId);
          return "no-host";
        }
        const seq = manifest.seq ?? this.nextSeq();
        handle.stamp = { seq, epoch: this.epoch };
        markStarted();
        const answer = await this.deps.pushToHost(threadId, manifest);
        // It reached the host: a launch that waited for this chat's denials has them now.
        if (answer !== null) this.refused.delete(threadId);
        const applied: RefreshAnswer = answer?.applied ?? "no-host";
        // A newer push decided already: this answer changes nothing.
        if (applied === "superseded" || seq < (this.advertisedSeq.get(threadId) ?? -Infinity)) return applied;
        if (seq > (this.latestAnswer.get(threadId)?.seq ?? -Infinity)) this.latestAnswer.set(threadId, { seq, epoch: this.epoch, answer: applied });
        if (applied === "live" || applied === "unchanged") this.setAdvertised(threadId, manifest.toolsets ?? [], seq);
        else this.markPending(threadId);
        return applied;
      } finally {
        markStarted();
      }
    })();
    this.pushes.set(threadId, handle);
    void handle.done
      .finally(() => {
        if (this.pushes.get(threadId) === handle) this.pushes.delete(threadId);
      })
      .catch(() => undefined);
    return handle;
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
        answers.set(id, await this.pushLogged(id).done);
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
   * answer in time, a superseded push) — `pending`: the change waits for the session's next start,
   * and NO continue (nothing would restart). The answer is `request_toolset`'s (`ToolsetApplyOutcome`);
   * none for a call that went away.
   */
  async toolsetApproved(caller: ThreadCaller, toolset: string, signal?: AbortSignal): Promise<ToolsetApplyOutcome | undefined> {
    if (this.stopped || signal?.aborted) return undefined;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    let push = this.pushes.get(caller.threadId) ?? this.pushLogged(caller.threadId);
    const own = push;
    let answer: RefreshAnswer | "timeout" | "aborted";
    try {
      // The bound covers the HOST (its worst case is below it): it starts when the host is asked,
      // after the manifest was built (that build has its own bounds, `DAEMON_POINTING_READ_TIMEOUT_MS`).
      const started = await Promise.race([own.hostStarted, aborted]);
      if (started === "aborted") return undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.deps.applyWaitMs ?? TOOLSET_APPLY_WAIT_MS);
      });
      // A push another one overtook answers `superseded`: the newest one decides.
      for (;;) {
        answer = await Promise.race([push.done.catch(() => "no-host" as const), deadline, aborted]);
        if (answer !== "superseded") break;
        const newer = this.pushes.get(caller.threadId);
        if (newer !== undefined && newer !== push) {
          push = newer;
          continue;
        }
        // The newer push that overtook this one finished already: ITS outcome is the change's —
        // only when it really is newer than this call's own push (a relaunch that superseded it
        // owes nothing, and an older recorded answer is no answer to this change).
        const latest = this.latestAnswer.get(caller.threadId);
        const ownStamp = own.stamp;
        answer = latest !== undefined && ownStamp !== undefined && latest.epoch === ownStamp.epoch && latest.seq > ownStamp.seq ? latest.answer : "superseded";
        break;
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    // The call went away (Stop, the provider cancelled it): nothing is scheduled for it.
    if (answer === "aborted" || signal?.aborted) return undefined;
    if (answer === "timeout") {
      this.markPending(caller.threadId);
      return "pending";
    }
    if (answer === "live" || answer === "unchanged") return "now";
    if (answer !== "next-idle") return "pending";
    void this.scheduleContinue(caller.threadId, toolset, caller.planning ? "plan" : "default").catch((error: unknown) =>
      this.deps.logger?.warn?.("session-tools: the automatic continue failed", error instanceof Error ? error.message : String(error))
    );
    return "after-restart";
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
      // The user spoke first, or stopped the turn (its own record says so, whatever the summary read).
      if ([...userMessageIds(settled)].some((id) => !seen.has(id))) return done("skipped");
      const asked = settled.turns.find((turn) => turn.turnId === baseline.turnId);
      if (asked !== undefined && asked.state !== "completed") return done("skipped");
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
