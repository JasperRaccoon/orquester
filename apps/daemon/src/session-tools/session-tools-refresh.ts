/**
 * The chat transport's daemon half of session-tool manifests (unified MCP design 2026-10-15 §9.4,
 * §12.1):
 *
 * - **The manifest route** (`daemonRoutesForHost.sessionToolsManifest`, socket-only, the agent
 *   host's bearer): `{tools, instructions, deny}` for one provider session of a thread, built from
 *   the thread's tab, the workflow-owned trait (owner + lineage walk) and the daemon-pointing MCP
 *   servers (`GET /api/agent-profile/daemon-mcp-servers`; none until it answers).
 *   Every chat tool is advertised to every chat (no always-Admin one to a workflow-owned chat).
 * - **Push** (`agentHostRoutes.sessionToolsRefresh`): a chat whose launch manifest was refused
 *   (503, its denials unknown) gets its manifest pushed once a daemon-pointing read succeeds — the
 *   host's launch waiting for its denials takes it — and {@link SessionToolsRefresher.refresh}
 *   pushes one chat's, or every open chat's ({@link REFRESH_CONCURRENCY} at a time), manifest. The
 *   host applies it in-session where the provider re-lists on `tools/list_changed` (Claude) and
 *   otherwise marks the live session stale (restart with resume at its next idle point, never
 *   under a running turn); an equal list is `unchanged`.
 */

import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import type { FastifyInstance } from "fastify";
import { AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, type DaemonMcpServersResponse, type DaemonPointingServer } from "@orquester/api";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import {
  daemonRoutesForHost,
  type SessionToolsManifest,
  type SessionToolsManifestRequest,
  type SessionToolsRefreshResponse
} from "../agent-host/host-protocol.ts";
import type { AnyOrquesterTool } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { isWorkflowOwned } from "../mcp/gate/scope.ts";
import { listSessions } from "../mcp/reads.ts";
import { KNOWLEDGE_WORKER_OWNER_KIND, ownerKindOf } from "../knowledge/visibility.ts";
import { buildSessionToolsManifest, isWithinDir, type ManifestKnowledge, type ManifestThread } from "./manifest.ts";

/** How long a read of the daemon-pointing servers is reused (the read walks every account home). */
export const DAEMON_POINTING_CACHE_MS = 30_000;

/** Chats refreshed at once by {@link SessionToolsRefresher.refresh} of every open chat. */
const REFRESH_CONCURRENCY = 4;

/**
 * How long the daemon-pointing read may take before the last good list (or "unavailable") answers.
 * With {@link MANIFEST_SESSIONS_READ_TIMEOUT_MS} it bounds a manifest well below the host's own
 * bound on asking for it (`MANIFEST_TIMEOUT_MS`, 10 s), so the host never gives up on an answer
 * the daemon is about to give.
 */
const DAEMON_POINTING_READ_TIMEOUT_MS = 4_000;

/** How long the session list read for the workflow-owned trait may take before it counts as owned. */
const MANIFEST_SESSIONS_READ_TIMEOUT_MS = 3_000;

/** How long the Knowledge Graph read of a chat may take before the manifest treats the plugin as off. */
export const KNOWLEDGE_INFO_TIMEOUT_MS = 2_000;

/** At most this many per-chat-cwd reads are cached (the all-projects read is always kept). */
const MAX_POINTING_SCOPES = 32;

/**
 * How long after a refused launch manifest (503) the chat's manifest is pushed to the host once a
 * daemon-pointing read succeeds: above the host's wait for denials (`DENIALS_WAIT_MS`, 15 s).
 */
export const REFUSED_PUSH_WINDOW_MS = 20_000;

/** What the host did with a pushed manifest; `no-host` — nothing reached a live session. */
export type RefreshAnswer = SessionToolsRefreshResponse["applied"] | "no-host";

export interface SessionToolsRefreshThread {
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

export interface SessionToolsRefreshDeps {
  /** The open chat thread, or null (closed, unknown, not a chat, no known adapter). */
  thread(threadId: string): SessionToolsRefreshThread | null;
  /** Every open chat thread ({@link SessionToolsRefresher.refresh} of them all). */
  openThreads(): string[];
  /** The chat audience of the catalog. */
  catalog(): readonly AnyOrquesterTool[];
  /** boxes: whether temporary boxes can be rented now (their tools are advertised only then). Absent: never. */
  boxesAvailable?(): boolean;
  /** Devices: whether the device tools are usable now (plugin on, agents allowed, a platform enabled). Absent: never. */
  devicesAvailable?(): boolean;
  /**
   * Knowledge Graph plugin: its view of one chat (thread id = session id) — on or off, worker or
   * not, what it sees (`knowledge/visibility.ts` `createKnowledgeForSession`). Read fresh for every
   * manifest; push a refresh when the plugin is switched, a collection is created, renamed or
   * deleted, or a profile's `knowledgeCollections` change. Absent, failing or slower than
   * {@link KNOWLEDGE_INFO_TIMEOUT_MS}: the plugin counts as off for that manifest — except that a
   * session the session list shows owned by the plugin (`owner.kind === "knowledge-indexer"`) is
   * still a worker, advertised only its two tools.
   */
  knowledgeForSession?(threadId: string): Promise<ManifestKnowledge>;
  /** The daemon's in-process API (null while it does not exist yet). */
  api(): DaemonApi | null;
  /**
   * Push a manifest to the host; null when the host is down or predates the route (the change then
   * applies at the thread's next session start). Never throws.
   */
  pushToHost(threadId: string, manifest: SessionToolsManifest): Promise<SessionToolsRefreshResponse | null>;
  now?: () => number;
  /** Overrides {@link DAEMON_POINTING_READ_TIMEOUT_MS} (tests). */
  pointingReadTimeoutMs?: number;
  /** Overrides {@link MANIFEST_SESSIONS_READ_TIMEOUT_MS} (tests). */
  sessionsReadTimeoutMs?: number;
  /** Overrides {@link KNOWLEDGE_INFO_TIMEOUT_MS} (tests). */
  knowledgeInfoTimeoutMs?: number;
  logger?: { log?(message: string): void; warn?(message: string, detail?: unknown): void };
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
  private stopped = false;

  constructor(private readonly deps: SessionToolsRefreshDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** A closed chat: forget it. */
  forget(threadId: string): void {
    this.refused.delete(threadId);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * The daemon-pointing servers — of every project, or with `scope`, of a chat's
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
      else void this.pushLogged(threadId);
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
    else if (refusedAt !== undefined && purpose === "launch") void this.pushLogged(threadId);
    const cwdPaths = scanned ? [thread.cwd ?? "", thread.canonicalCwd ?? ""].filter((path) => path !== "" && !projectPaths.some((root) => resolvePath(root) === resolvePath(path))) : [];
    const api = this.deps.api();
    // The workflow-owned trait walks lineage through closed tabs (the gate's own walk): fail
    // closed — an unreadable (or unanswered, bounded) list counts as owned, so no Admin tool is
    // advertised.
    let workflowOwned = true;
    // Knowledge Graph: a worker session says so in its owner too — the second signal that keeps it
    // to its two tools when the knowledge read fails, hangs or is not wired.
    let knowledgeWorker = false;
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
        else {
          workflowOwned = isWorkflowOwned(sessions, threadId);
          knowledgeWorker = ownerKindOf(sessions.find((session) => session.id === threadId)?.owner) === KNOWLEDGE_WORKER_OWNER_KIND;
        }
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
    const read = await this.knowledgeFor(threadId);
    const knowledge: ManifestKnowledge | undefined = knowledgeWorker && read?.worker !== true ? { enabled: read?.enabled === true, worker: true, searchable: false, visibleCollectionNames: [] } : read;
    const manifest = buildSessionToolsManifest({
      thread: manifestThread,
      catalog: this.deps.catalog(),
      daemonPointing,
      // boxes: the box tools only while a box can be rented.
      boxesAvailable: this.deps.boxesAvailable?.() === true,
      // Devices: the device tools only while devices can be used.
      devicesAvailable: this.deps.devicesAvailable?.() === true,
      ...(knowledge ? { knowledge } : {})
    });
    return { ...manifest, seq: this.nextSeq(), epoch: this.epoch };
  }

  /** Knowledge Graph: the plugin's view of the chat, or undefined (off) when unwired, failing or slow. Never throws. */
  private async knowledgeFor(threadId: string): Promise<ManifestKnowledge | undefined> {
    const read = this.deps.knowledgeForSession;
    if (!read) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        read(threadId),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.deps.knowledgeInfoTimeoutMs ?? KNOWLEDGE_INFO_TIMEOUT_MS);
        })
      ]);
      if (answer !== "timeout") return answer;
      this.deps.logger?.warn?.("session-tools: the knowledge read did not answer in time; the chat gets no knowledge tools");
    } catch (error) {
      this.deps.logger?.warn?.("session-tools: the knowledge read failed; the chat gets no knowledge tools", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    return undefined;
  }

  private pushLogged(threadId: string): Promise<RefreshAnswer> {
    return this.push(threadId).catch((error: unknown) => {
      this.deps.logger?.warn?.("session-tools: refresh failed", error instanceof Error ? error.message : String(error));
      return "no-host" as const;
    });
  }

  /** Push one chat's manifest to the host; what the host did with it (`no-host` when nothing reached one). */
  async push(threadId: string): Promise<RefreshAnswer> {
    const manifest = await this.manifest(threadId, "check");
    if (manifest === null || manifest === "unavailable") return "no-host";
    const answer = await this.deps.pushToHost(threadId, manifest);
    // It reached the host: a launch that waited for this chat's denials has them now.
    if (answer !== null) this.refused.delete(threadId);
    return answer?.applied ?? "no-host";
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
