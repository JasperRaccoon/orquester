/**
 * Agent host — the daemon ↔ host protocol (spec §3.1, §6, §8).
 *
 * The host serves a small HTTP-over-unix-socket API at
 * `<appdir>/daemon/agent-host.sock`. The daemon proxies every `/api/sessions/:id/*`
 * chat route onto it; nothing here is ever reachable from a browser.
 *
 * Both sides import this module, so a route name or a header can only be
 * changed in one place.
 */

import { agentHostSocketPath, agentHostTokenPath } from "@orquester/config";
import type {
  ThreadForkStrategy,
  ThreadForkTarget,
  ThreadHead,
  ThreadLineage
} from "@orquester/api/agent-chat";

/**
 * Re-exported so the daemon and the host resolve the socket and the token from
 * one import rather than two.
 */
export { agentHostSocketPath, agentHostTokenPath };

/**
 * Bumped whenever the daemon ↔ host wire changes.
 *
 * Boot sequence in `startDaemon`, after `sessions.reattach()` (§3.1):
 * 1. probe the socket with the token;
 * 2. healthy and the same version — adopt;
 * 3. healthy but a version mismatch (after a deploy) — adopt, then restart the
 *    host as soon as no thread has an active turn (the drain rule);
 * 4. the socket answers but rejects the token — a foreign process. Log an
 *    error, **never kill or adopt**;
 * 5. nothing answers — spawn, poll readiness, then adopt.
 */
export const AGENT_HOST_PROTOCOL_VERSION = 1;

/** The tmux service session the host runs in, like the other `orqsvc-*` service sessions (§3.1). */
export const AGENT_HOST_SERVICE_SESSION = "orqsvc-agent-host";

/** Bearer token header. The token file is 0600 and regenerated only when no host is alive. */
export const AGENT_HOST_AUTH_HEADER = "authorization";

export function agentHostAuthValue(token: string): string {
  return `Bearer ${token}`;
}

/** The `Host:` value used on unix-socket requests (the authority is meaningless). */
export const AGENT_HOST_HTTP_HOST = "agent-host.localhost";

/** 15 s unref'd health interval with bounded backoff (§3.1). */
export const AGENT_HOST_HEALTH_INTERVAL_MS = 15_000;

/**
 * The daemon holds this deadline on a replacement host reaching readiness; on
 * failure the old host is left running and the deploy is reported as **not
 * switched** rather than silently half-applied (§8).
 */
export const AGENT_HOST_PREPARED_TIMEOUT_MS = 120_000;

/**
 * A restarted host is not a reconnect (§8). The instance id changes on every
 * start, is returned on `GET /api/agent/providers` and is stamped on the
 * `synchronized` stream frame. A client that reconnects to a different
 * instance id **re-reads the thread** instead of resuming by sequence.
 */
export function newHostInstanceId(): string {
  return `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

const thread = (threadId: string): string => `/threads/${encodeURIComponent(threadId)}`;

/**
 * Every route the host serves. The per-thread ones mirror §6.2 and §6.3
 * one-for-one — the daemon is a proxy, not a translator, so a command body
 * crosses unchanged.
 */
export const agentHostRoutes = {
  /**
   * Readiness. Answered **only after the command gate opens** (§3.1), so "the
   * socket answers" and "the host can take work" are the same fact.
   */
  health: "/health",

  /** Create the thread after the daemon has written the tab record (§6.1). */
  createThread: "/threads",
  deleteThread: (threadId: string): string => thread(threadId),
  /** The §6.1 rename; appends `thread.meta-updated`. */
  updateThread: (threadId: string): string => thread(threadId),
  /**
   * §3.4's account switch. Not a §6.2 command route: the daemon owns the
   * client-facing `POST /api/sessions/:id/account`, validates the account,
   * recomposes the launch environment and prepares the home, and only then
   * calls this — so the host is handed a resolved identity, never an id it
   * would have to look up.
   */
  setThreadIdentity: (threadId: string): string => `${thread(threadId)}/identity`,
  /**
   * Thread lineage (spec 2026-10-14 §6): `POST` {@link ForkHostThreadRequest}
   * on the PARENT → {@link ForkHostThreadResponse}. Creates the child thread
   * as `createThread` does, its conversation the parent's up to the fork
   * point. Additive: a host that predates it answers its generic route-miss
   * 404 `THREAD_NOT_FOUND` ("No route for …") until its drain-restart, which
   * the daemon reports as "needs the host update" — `AGENT_HOST_PROTOCOL_VERSION`
   * did not move for it.
   */
  forkThread: (parentThreadId: string): string => `${thread(parentThreadId)}/fork`,

  // §6.2 commands, one route per command.
  turn: (threadId: string): string => `${thread(threadId)}/turn`,
  interrupt: (threadId: string): string => `${thread(threadId)}/interrupt`,
  approval: (threadId: string): string => `${thread(threadId)}/approval`,
  answer: (threadId: string): string => `${thread(threadId)}/answer`,
  dismiss: (threadId: string): string => `${thread(threadId)}/dismiss`,
  revert: (threadId: string): string => `${thread(threadId)}/revert`,
  compact: (threadId: string): string => `${thread(threadId)}/compact`,
  background: (threadId: string): string => `${thread(threadId)}/background`,
  /**
   * Stop one live task (`TaskStopCommandBody`). Additive: a host that predates
   * it answers its generic route-miss 404 `THREAD_NOT_FOUND` until its
   * drain-restart — and reports no `supportsTaskStop`, so no client offers it
   * there. `AGENT_HOST_PROTOCOL_VERSION` did not move for it.
   */
  taskStop: (threadId: string): string => `${thread(threadId)}/task/stop`,
  mode: (threadId: string): string => `${thread(threadId)}/mode`,
  sessionStop: (threadId: string): string => `${thread(threadId)}/session/stop`,

  // §6.3 reads.
  read: (threadId: string): string => `${thread(threadId)}/thread`,
  /**
   * `GET ?replyChars=` → `ThreadHeadResponse`: the thread's head (`threadHeadOf` over the in-memory
   * fold, no log read beyond a cold thread's ordinary load). Additive: a host that predates it
   * answers its generic route-miss 404 `THREAD_NOT_FOUND` ("No route for …"); the daemon then reads
   * {@link agentHostRoutes.read} and derives the same head itself, and asks that host instance no
   * more — `AGENT_HOST_PROTOCOL_VERSION` did not move for it.
   */
  head: (threadId: string): string => `${thread(threadId)}/head`,
  events: (threadId: string): string => `${thread(threadId)}/events`,
  turnDiff: (threadId: string, turnCount: number): string =>
    `${thread(threadId)}/turns/${turnCount}/diff`,
  item: (threadId: string, itemId: string): string =>
    `${thread(threadId)}/items/${encodeURIComponent(itemId)}`,
  /**
   * `GET` → `ThreadItemOutputResponse`: the streamed output of the tool call
   * the item belongs to, joined from the log; with `?offset=&maxBytes=`,
   * `ThreadItemOutputWindowResponse`, one window of it from the store's cache.
   * 404 `ITEM_NOT_FOUND` when the item names no call. A host that predates the
   * route answers its generic route-miss 404 `THREAD_NOT_FOUND` until its
   * drain-restart, and one that predates windows ignores the query and answers
   * the whole join — additive both ways, so `AGENT_HOST_PROTOCOL_VERSION` did
   * not move for it.
   */
  itemOutput: (threadId: string, itemId: string): string =>
    `${thread(threadId)}/items/${encodeURIComponent(itemId)}/output`,

  providers: "/providers",
  providerRefresh: (adapterId: string): string =>
    `/providers/${encodeURIComponent(adapterId)}/refresh`,

  // Indexed history and search (design 2026-09-23 "thread index and lazy boot").
  /** `GET ?before=<cursor>&turns=<n>` → `ThreadHistoryPage`, or 503 `INDEX_UNAVAILABLE`. */
  history: (threadId: string): string => `${thread(threadId)}/history`,
  /** `GET ?q=&limit=&projectPath=` → `ThreadSearchResponse`. */
  search: "/search",
  /**
   * `GET ?before=<cursor>&limit=<n>` → `ThreadPromptsResponse`: the thread's
   * own prompts, newest first (the right rail's History) — 200 `indexed:
   * false` (+ `catchingUp` while the index catches up with the thread) when
   * the index cannot list it whole, 503 `INDEX_UNAVAILABLE` when a read
   * failed. A host that predates the route answers its generic route-miss 404
   * `THREAD_NOT_FOUND` until its drain-restart.
   */
  prompts: (threadId: string): string => `${thread(threadId)}/prompts`,
  /**
   * `GET` → `ThreadPromptTextResponse`, one prompt's whole text; 404
   * `PROMPT_NOT_FOUND` when the index holds the whole thread and has no such
   * prompt, 503 `INDEX_UNAVAILABLE` whenever it cannot say.
   */
  promptText: (threadId: string, messageId: string): string =>
    `${thread(threadId)}/prompts/${encodeURIComponent(messageId)}`,


  /**
   * The intentional stop of §3.3: write every continuation marker for a
   * running thread with a usable cursor, then drain and stop. If the stop is
   * aborted, every marker written for it is cleared, so a cancelled restart
   * does not inject a phantom "Continue where you left off." on the next boot.
   */
  stop: "/stop",

  /**
   * Agent goals §5.7: `POST` → {@link AgentHostHoldGoalsResponse}. A deploy's
   * drain is waiting, so hold every continuing goal between its turns once
   * goals are all that is left in the way — a lease, extended by every request
   * to `GOAL_HOLD_LEASE_MS`, after which the host resumes what it held. A host
   * that predates the route answers its generic route-miss 404, which the
   * daemon ignores.
   */
  holdGoals: "/goals/hold",

  /**
   * Agent goals §5.7, a legacy handover's other half: `POST`
   * {@link AgentHostResumeGoalSessionsRequest} →
   * {@link AgentHostResumeGoalSessionsResponse}. A host from before the goal
   * hold cannot pause a goal, so the daemon stopped these Codex threads'
   * sessions at a turn boundary to let the deploy go ahead; their goals are
   * still active in Codex's own store. This host resumes each session WITHOUT
   * a turn, as for a §5.5 handover mark, and Codex continues the goal by
   * itself.
   */
  resumeGoalSessions: "/goals/resume-sessions",

  /**
   * Agent profile §4.8: `POST` → {@link AgentHostRecycleOpenCodeResponse}.
   * `opencode serve` caches its global config for its whole life, so after the
   * agent profile writes OpenCode config the daemon asks the host to stop
   * every OpenCode server with nothing running (the next turn starts a fresh
   * one) and to recycle each busy one once it goes idle. Additive: a host that
   * predates the route answers its generic route-miss 404, which the daemon
   * ignores — `AGENT_HOST_PROTOCOL_VERSION` did not move for it.
   */
  recycleIdleOpenCode: "/opencode/recycle-idle",

  /**
   * Agent Profiles (spec 2026-10-18 §6.5): `GET` → {@link AgentHostProfileLeasesResponse}, the
   * prepared directories this host's live provider sessions (and the session starts in flight)
   * launched from. The daemon's preparation lifecycle never deletes a prepared version named here
   * (`PreparedDirLeases.inUse()`, `session-profiles/launch.ts`). Additive: a host that predates
   * it answers its generic route-miss 404, and the daemon then treats every lease as unknown.
   */
  profileLeases: "/profiles/leases",

  /**
   * Unified MCP design 2026-10-15 §9.3/§9.4: `POST` {@link SessionToolsRefreshRequest} →
   * {@link SessionToolsRefreshResponse}. The daemon hands the thread's NEW manifest (its denials
   * became known, or the tool list changed): a provider that re-lists on `notifications/tools/list_changed` (Claude, probed) gets
   * the new list at once; any other live session is restarted with resume at its next idle point
   * (the next turn's send — never under a running turn); a thread with no live session takes it at
   * its next start. Additive: a host that predates it answers its generic route-miss 404, and the
   * change then applies whenever the thread's session next starts.
   */
  sessionToolsRefresh: (threadId: string): string => `${thread(threadId)}/session-tools/refresh`
} as const;

// ---------------------------------------------------------------------------
// The other direction: routes the HOST calls on the DAEMON's unix socket
// ---------------------------------------------------------------------------

/**
 * Routes the agent host calls on the daemon's own unix socket
 * (`ORQUESTER_DAEMON_SOCK`, else `defaultSocketPath(appdir)`). Registered ONLY
 * on the daemon's unix-socket app, never on remote HTTP, and each one checks
 * the agent-host bearer ({@link agentHostAuthValue}) besides: the socket is
 * trusted local control, but a session-tool call acts as a thread, and only
 * the host may say which.
 *
 * Additive in both directions — `AGENT_HOST_PROTOCOL_VERSION` did not move:
 * a daemon that predates a route answers 404, which the host turns into an
 * error result for the one call; a host that predates it never calls.
 */
export const daemonRoutesForHost = {
  /**
   * `POST` {@link SessionToolCallRequest} → 200 with the tool's MCP
   * `CallToolResult` (a tool's own failure is an `isError` result, still
   * 200); 401 without the host's bearer; 404 `THREAD_NOT_FOUND` for a thread
   * the daemon has no chat tab for; 503 while the daemon cannot run it. The
   * call is cancelled when the host drops the connection.
   */
  sessionToolCall: "/api/agent-host/session-tools/call",
  /**
   * Unified MCP design 2026-10-15 §9.4: `POST` {@link SessionToolsManifestRequest} → 200
   * {@link SessionToolsManifest}, the chat tools, instruction block and MCP-server denials ONE
   * provider session of the thread launches with; 401 without the host's bearer; 404
   * `THREAD_NOT_FOUND` for a thread with no chat tab. A daemon that predates the route answers its
   * generic 404 too — the host then advertises the frozen legacy definitions
   * (`session-tools/legacy-definitions.ts`) its old handlers match (spec §14.1).
   */
  sessionToolsManifest: "/api/agent-host/session-tools/manifest",
  /**
   * Agent Profiles (spec 2026-10-18 §5.6, §6.5): `POST` {@link ThreadLaunchProfileRequest} → 200
   * {@link ThreadLaunchProfileResponse}. Asked before EVERY provider-session start of a thread
   * that names a profile (create's first start, resume, crash restart, a host restart's
   * rehydrate, a switch), so the start launches from the profile's CURRENT prepared version and
   * the launch environment its agent's contribution derives from it; the host rewrites
   * `launch.json` with the answer before it starts. A refusal (409 `{code, message}`:
   * `PROFILE_NOT_READY`, `PROFILE_UNSUPPORTED_AGENT`, `PROFILE_NOT_FOUND` for an unattended chat,
   * `LAUNCH_UNAVAILABLE`) fails the start with its message. 401 without the host's bearer; 404
   * `THREAD_NOT_FOUND` for a thread with no chat tab. Unreachable, 5xx, or a daemon that predates
   * the route (its generic 404): the host launches from the persisted profile only if its
   * manifest still validates, else the start fails — never Global.
   */
  threadLaunchProfile: "/api/agent-host/threads/launch-profile"
} as const;

/** Body of `POST /api/agent-host/threads/launch-profile`. */
export interface ThreadLaunchProfileRequest {
  threadId: string;
  /** The profile the thread's launch config (else its head) names. */
  profileId: string;
}

/**
 * The launch a profile thread's next session start uses: the launch fields REPLACE
 * `launch.json`'s (as {@link SetThreadIdentityRequest}'s do), and `profile` is the prepared
 * version to launch from — `null` when the profile was deleted and the interactive chat falls
 * back to Global, in which case `fallback` names the notice the host appends beside the
 * `thread.meta-updated {profileId: ""}` it writes.
 */
export interface ThreadLaunchProfileResponse {
  profile: HostThreadProfile | null;
  launchEnv?: Record<string, string>;
  unsetEnv?: string[];
  homePath?: string;
  serverPool?: HostThreadServerPool;
  fallback?: { previousProfileId: string; notice: string };
}

/** Body of `POST /api/agent-host/session-tools/manifest`. */
export interface SessionToolsManifestRequest {
  threadId: string;
  /**
   * `launch` (default): a provider session is starting with it. `check`: a look only (the
   * daemon's own pushes).
   */
  purpose?: "launch" | "check";
}

/**
 * What one provider session of a thread is given (spec §9.4). Provider-neutral: each adapter turns
 * `deny` into its own denial (Claude `disallowedTools` + `deniedMcpServers`, Codex
 * `mcp_servers.<name>.enabled = false`, Grok a same-named inert ACP entry, OpenCode `<name>_*`
 * deny rules).
 */
export interface SessionToolsManifest {
  /** The chat tools to advertise, by bare name (the host filters its static catalog by them). */
  tools: string[];
  /** The "Orquester" instruction block for this thread (spec §10, ≤ 2 048 bytes). */
  instructions: string;
  /**
   * MCP server names, as the thread's CLI config names them, to deny in this chat: every server of
   * the thread's agent, in the thread's account home or its project's config, that points at this
   * daemon's full-trust `/mcp` (spec §12.1). Empty when none is known.
   */
  deny: string[];
  /**
   * LEGACY: older daemons sent the thread's resolved toolsets (their own bookkeeping); the host
   * ignores it, and this daemon no longer sends it. Kept so either side of a handover still reads.
   */
  toolsets?: string[];
  /**
   * Monotonic per daemon and increasing across daemon restarts (milliseconds-based): the host
   * ignores a refresh older than the last manifest it applied or launched with for the thread
   * (`superseded`), so pushes finishing out of order never roll a list back. Absent from an older
   * daemon: never superseded.
   */
  seq?: number;
  /**
   * The daemon process that stamped `seq` (a random id per boot): sequences compare only within
   * one epoch — a new epoch is accepted and restarts the comparison, so a wall clock stepping back
   * across a daemon restart never rejects refreshes. Absent with `seq` from an older build.
   */
  epoch?: string;
}

/**
 * The longest the host takes to answer a refresh: a launch's manifest read it waits for (the
 * host's own manifest timeout, 10 s) plus Claude's bounded re-list wait (5 s). The daemon's push
 * is bounded above it ({@link SESSION_TOOLS_REFRESH_TIMEOUT_MS}), so an answer is never lost to a
 * timeout.
 */
export const SESSION_TOOLS_REFRESH_HOST_MAX_MS = 15_000;

/** The daemon's bound on a refresh push. */
export const SESSION_TOOLS_REFRESH_TIMEOUT_MS = SESSION_TOOLS_REFRESH_HOST_MAX_MS + 5_000;

/** Body of `POST /threads/:id/session-tools/refresh`. */
export interface SessionToolsRefreshRequest {
  manifest: SessionToolsManifest;
}

/** `POST /threads/:id/session-tools/refresh`. */
export interface SessionToolsRefreshResponse {
  /**
   * `live`: the running session's list was replaced and the provider told (`list_changed`);
   * `next-idle`: the live session restarts with resume at its next idle point; `next-start`: no live
   * session — its next start fetches the manifest; `unchanged`: the session already advertises it;
   * `superseded`: an older manifest than one already applied for the thread — ignored.
   */
  applied: "live" | "next-idle" | "next-start" | "unchanged" | "superseded";
}

/** Body of `POST /api/agent-host/session-tools/call` (design 2026-10-14 §1.1). */
export interface SessionToolCallRequest {
  /**
   * The calling thread, as the HOST resolved it — from the credential the
   * provider presented, or the in-process server the thread was launched
   * with. Never taken from the tool's arguments.
   */
  threadId: string;
  /** Unique per call (the provider's tool-call id where it sends one). */
  callId: string;
  /** Bare tool name. */
  name: string;
  /** The tool's arguments as the provider sent them; the daemon validates them. */
  arguments: unknown;
}

/** `GET /profiles/leases` (Agent Profiles). */
export interface AgentHostProfileLeasesResponse {
  /** Absolute prepared directories (`HostThreadProfile.preparedDir`) in use, deduplicated. */
  preparedDirs: string[];
}

/**
 * Body of `POST /opencode/recycle-idle` (agent profile §4.8). Empty recycles
 * every OpenCode server; `poolKey` only the servers of that
 * {@link HostThreadServerPool} key. Additive: an older host ignores the body
 * and recycles every server, which is a safe superset.
 */
export interface AgentHostRecycleOpenCodeRequest {
  poolKey?: string;
}

/** `POST /opencode/recycle-idle` (agent profile §4.8). */
export interface AgentHostRecycleOpenCodeResponse {
  /** OpenCode servers stopped by this request. */
  recycled: number;
  /** Servers with work running, marked to be recycled once when they go idle. */
  deferred: number;
}

/** `POST /goals/hold` (agent goals §5.7). */
export interface AgentHostHoldGoalsResponse {
  /** Every thread the host holds after this request, the ones held before it included. */
  heldThreadIds: string[];
}

/** `POST /goals/resume-sessions` (agent goals §5.7). */
export interface AgentHostResumeGoalSessionsRequest {
  threadIds: string[];
}

/** `POST /goals/resume-sessions` (agent goals §5.7). */
export interface AgentHostResumeGoalSessionsResponse {
  /** The threads this host took: known, not deleted. Their resume runs after the answer. */
  threadIds: string[];
}

/** `GET /health` on the host socket. */
export interface AgentHostHealthResponse {
  ok: true;
  protocolVersion: number;
  hostInstanceId: string;
  /** Threads the host currently holds a live session for. */
  liveThreadIds: string[];
  /** Threads with an active turn — the drain-restart of §3.1 waits on this. */
  activeTurnThreadIds: string[];
  /**
   * Threads with live BACKGROUND work — a subagent fleet or a background shell
   * that keeps running inside the provider process after the turn that
   * launched it settled (the §3.1 liveness registry). The drain-restart waits
   * on these exactly as on `activeTurnThreadIds`: a restart kills the provider
   * children, and the CLI then reports every one of them as "didn't finish
   * before the previous session ended" on the next message. Optional: an
   * older host omits it and the daemon drains on active turns alone.
   */
  backgroundWorkThreadIds?: string[];
  pid: number;
  startedAt: string;
  /**
   * The commit the host's code was read from (`support/code-stamp.ts`), so a
   * code-only deploy is a §3.1 case-3 drain-restart, not just a protocol bump.
   * Optional: an older host omits it, and `null` means "could not read".
   */
  codeStamp?: string | null;
  /**
   * Monotonic counter the host bumps whenever a provider snapshot actually
   * changes (§4.6.4: the host's OWN session-start / turn-reuse refresh must
   * broadcast `agent.providers.changed` too, not just the explicit refresh
   * route). The daemon already polls `/health` every
   * {@link AGENT_HOST_HEALTH_INTERVAL_MS}, so a moving number is enough for a
   * coarse event the client re-reads on. Optional: an older host omits it and
   * the daemon simply never raises the event from this path.
   */
  providersRevision?: number;
  /**
   * What this host build can do beyond {@link AGENT_HOST_PROTOCOL_VERSION}, for features added
   * without a version bump. Optional: an older host omits it, which means "none of them" — read
   * it through {@link agentHostSupports}, never as `capabilities.x !== undefined`.
   */
  capabilities?: AgentHostCapabilities;
}

/**
 * {@link AgentHostHealthResponse.capabilities}. Each entry is the level the host implements, a
 * positive integer, so a feature can grow a second level without a new name.
 */
export interface AgentHostCapabilities {
  /**
   * Agent Profiles (spec 2026-10-18): `1` = the host persists `profile` in the thread's
   * `launch.json`, records `profileId` in the log, hands `StartSessionInput.profile` to every
   * session start (create, resume, crash restart, a host restart's rehydrate, an identity switch,
   * a fork's child) and takes a profile switch on `setThreadIdentity`; it asks the daemon's
   * `threadLaunchProfile` before each such start and answers `profileLeases`. A host without it
   * would run a profile thread as Global — the daemon must not send it one.
   */
  sessionProfiles?: number;
}

/** The capabilities this host build advertises on `/health`. */
export const AGENT_HOST_CAPABILITIES: Readonly<Required<AgentHostCapabilities>> = Object.freeze({
  sessionProfiles: 1
});

/**
 * True when a host's `/health` advertises `capability` at `level` or above. `null` (no host
 * adopted) and a host that predates capabilities both answer false.
 */
export function agentHostSupports(
  health: Pick<AgentHostHealthResponse, "capabilities"> | null | undefined,
  capability: keyof AgentHostCapabilities,
  level = 1
): boolean {
  const value = health?.capabilities?.[capability];
  return typeof value === "number" && Number.isFinite(value) && value >= level;
}

/**
 * Which long-lived provider server a thread runs on, for an adapter that
 * shares one server between threads (OpenCode: one `opencode serve` per
 * project, spec §3.2). Without it the thread uses the project's GLOBAL server,
 * started with the launcher env alone — exactly as before this field existed.
 *
 * - `key` — opaque, non-empty, never `"global"` (reserved). Threads of one
 *   project naming the same key share one server, so a key must always stand
 *   for the same `env` / `unsetEnv` (the daemon derives both from what the key
 *   names, e.g. an agent profile's prepared directories).
 * - `env` — layered over that server's launcher env, after `unsetEnv` is
 *   removed from it. Never `PATH`, `HOME`, `TMPDIR` or
 *   `OPENCODE_SERVER_PASSWORD`. Absolute values, like every launch env value.
 *
 * Applied to the SERVER, not to `launchEnv`: the global server's env is
 * composed from a project's threads' `launchEnv`, so anything placed there
 * would leak into it. Persisted in the thread's `launch.json`, so a resumed
 * thread is put back on a server with the same key and env after a host
 * restart or handover. Additive: an older host ignores it, and its threads
 * run on the global server.
 */
export interface HostThreadServerPool {
  key: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
}

/** Body of `POST /threads`. */
export interface CreateHostThreadRequest {
  threadId: string;
  /**
   * The PROJECT ROOT — the `<workspacesDir>/<ws>/<project>` dir the tab belongs
   * to, never a subdirectory. Any per-project pooling (OpenCode runs one server
   * per project) must key on **this**, not on `cwd`: a thread opened on a
   * subdirectory would otherwise spawn a second server for the same checkout.
   */
  projectPath: string;
  /** Working directory for the provider child. Usually equals `projectPath`. */
  cwd: string;
  title: string;
  /** Registry id; the host maps it to an adapter via the catalog's `chat`. */
  refId: string;
  accountId: string;
  home: "system" | "account";
  modelSelection: unknown;
  runtimeMode: unknown;
  /** §6.1: refused with `RESUME_UNAVAILABLE` when the adapter cannot use it. */
  resume?: { home: "system" | "account"; conversationId: string };
  /**
   * The launcher-specific environment §3.1 requires a chat thread to get —
   * **exactly** what a terminal launch of the same registry entry gets today.
   *
   * The daemon composes it, because only the daemon has the sources: the
   * registry entry's own `env` plus its per-launcher env file
   * (`<appdir>/daemon/env/<id>.env`, e.g. `opencode.env`), and the
   * `resolveExtraEnv` contributors — the managed account home and the Claude
   * timeout.
   *
   * The host layers it **over** what `buildProviderEnv()` produces and keeps
   * `unsetEnv` as the ambient-credential denylist, so a thread can never
   * silently bill a different identity. Values are already absolute: nothing
   * expands `~` or `$VAR` for a spawned child.
   */
  launchEnv?: Record<string, string>;
  /** Ambient vars to remove for this launch (the `unset` half of §3.1). */
  unsetEnv?: string[];
  /** Absolute home dir for `home`, resolved daemon-side. Never on a client wire. */
  homePath?: string;
  /** The thread's keyed provider server ({@link HostThreadServerPool}); omitted for the global one. */
  serverPool?: HostThreadServerPool;
  /**
   * The thread's parent (spec 2026-10-14 §6), recorded on `thread.created`.
   * Additive: an older host ignores it, and the daemon's tab record still
   * carries the lineage.
   */
  lineage?: ThreadLineage;
  /**
   * The Agent Profile the thread launches with (`@orquester/api` `session-profiles.ts`). Absent =
   * Global. Additive: an older host ignores it (and then launches Global — the daemon must not
   * send a profile thread to a host that does not advertise
   * {@link AgentHostCapabilities.sessionProfiles}).
   *
   * A mirror of `profile.profileId`: `profile` is what the host reads. A `profileId` without a
   * `profile`, or one naming another profile, is refused (`INVALID_COMMAND`) — the thread would
   * otherwise launch as Global.
   */
  profileId?: string;
  /**
   * Where the profile was prepared for this thread's agent and account; see
   * {@link HostThreadProfile}. Persisted in the thread's `launch.json`, handed to every session
   * start as `StartSessionInput.profile`, and its `profileId` recorded on `thread.created`.
   */
  profile?: HostThreadProfile;
}

/**
 * A profile thread's prepared directory, resolved daemon-side (never on a client wire). The
 * host's adapters read `<preparedDir>/manifest.json` (`session-profiles/manifest.ts`,
 * `readPreparedManifest`) and launch from it; `profileId` and `revision` must match the
 * manifest's, else the launch fails — never falls back to Global (spec §2 anti-goals).
 */
export interface HostThreadProfile {
  profileId: string;
  revision: string;
  preparedDir: string;
}

/**
 * Body of `POST /threads/:parentId/fork` (spec 2026-10-14 §6). The create
 * fields are the child's; `modelSelection` / `runtimeMode` left out are the
 * parent's (a fork runs "with the same agent/model/options"), and
 * `projectPath`, `cwd`, the account and the launch environment are the
 * parent's as the daemon resolved them — a provider's resume identity stays
 * in the home that created it. `resume` and `lineage` are ignored: the host
 * builds both.
 */
export interface ForkHostThreadRequest extends Omit<CreateHostThreadRequest, "profileId" | "profile"> {
  fork: ThreadForkTarget;
  /**
   * The child's Agent Profile. Absent: the PARENT's, as its `launch.json` holds it (a fork runs
   * "with the same agent/model/options", and the account — so the prepared directory — is the
   * parent's too). `null`: Global. A {@link HostThreadProfile}: that one.
   */
  profile?: HostThreadProfile | null;
  /** A mirror of `profile`'s id (`null` for Global), checked like create's. */
  profileId?: string | null;
  /**
   * The daemon's reconcile of a fork whose answer it lost: answer the child
   * `threadId` names if this host holds it (or once the fork creating it is
   * done), and never create one — 404 `THREAD_NOT_FOUND` when there is none.
   * Additive. A host from before it ignores the flag and forks as asked, so
   * the daemon always sends the lost fork's WHOLE request with it — the same
   * cut and the launch environment recomposed as the fork composed it — and
   * such a host creates exactly the child the lost request would have: the
   * convergence of a retry under the same key. (Only builds of this feature
   * before the flag existed have the fork route without it.)
   */
  confirmOnly?: boolean;
}

export interface ForkHostThreadResponse {
  head: ThreadHead;
  strategy: ThreadForkStrategy;
  lineage: ThreadLineage;
}

/**
 * Body of `POST /threads/:id/identity` — §3.4's account switch, applied on the
 * thread's next message.
 *
 * The launch fields (`launchEnv`, `unsetEnv`, `homePath`, `serverPool`) are the
 * SAME shapes {@link CreateHostThreadRequest} carries, because they replace
 * exactly what create wrote: the host rewrites
 * `launch.json` from them **before** it records the new identity on the head,
 * so a host that dies in between relaunches under the environment the head
 * still names rather than under a half-applied one. `main.ts`'s `buildEnv` and
 * `resolveHome` both read the live launch config, so the next session start
 * picks the new identity up with no further plumbing.
 */
export interface SetThreadIdentityRequest {
  /** The client-minted idempotency key, exactly as a §6.2 command's. */
  commandId: string;
  /** The managed account id, or `""` for the system identity. */
  accountId: string;
  /** The home kind: `"account"` for a managed account, else `"system"`. */
  home: "system" | "account";
  launchEnv?: Record<string, string>;
  unsetEnv?: string[];
  homePath?: string;
  /**
   * The thread's keyed provider server from now on ({@link HostThreadServerPool}). A launch
   * field like the three above: it REPLACES what `launch.json` held, so absent = the global
   * server. Only OpenCode reads it, and OpenCode only takes a profile switch, which moves the
   * thread to the server keyed by the new profile. Additive: an older host ignores it.
   */
  serverPool?: HostThreadServerPool;
  /**
   * The Agent Profile switch (spec 2026-10-18 §5.3, "switching in a running chat"):
   *
   * - absent — the thread keeps the profile it has (an account-only switch);
   * - `null` — the thread switches to Global;
   * - a {@link HostThreadProfile} — the thread switches to it.
   *
   * A switch may change the profile only, the account only, or both. A profile-only switch keeps
   * the account's resume identity (transcripts and session stores are shared across profiles),
   * so the restart it causes carries the resume cursor and is not an account switch. An
   * account-only switch of a thread whose profile is prepared per account (Codex) must still
   * send the profile prepared for the NEW account. Additive: an older host ignores it — the
   * daemon must check {@link AgentHostCapabilities.sessionProfiles} before it sends one.
   */
  profile?: HostThreadProfile | null;
  /** A mirror of `profile`'s id (`null` for Global); refused when it disagrees with `profile`. */
  profileId?: string | null;
}

/**
 * The literal continuation prompt for an adapter without
 * `promptlessTurnContinuation` (§3.3 step 3).
 */
export const CONTINUATION_PROMPT = "Continue where you left off.";

/**
 * §3.3 — the ORPHAN settle: a running thread the restart found with nothing
 * behind it and no way to continue it (no cursor, a closed tab, a project that
 * opted out, a marker from another turn).
 *
 * *T3: `serverRuntimeStartup.ts:345-346` — `ORPHANED_PROVIDER_SESSION_ERROR`.*
 */
export const CONTINUATION_FAILED_MESSAGE =
  "The agent did not survive a restart. Send a new message to continue.";

/**
 * §3.3 step 4 — a continuation that WAS attempted and failed. Distinct from
 * {@link CONTINUATION_FAILED_MESSAGE} on purpose: the user is told the thread
 * could not be picked up, not that it was never eligible.
 *
 * *T3: `serverRuntimeStartup.ts:723-725` — the literal settled on a failed
 * continuation exit.*
 */
export const CONTINUATION_SEND_FAILED_MESSAGE =
  "Could not continue this thread after the server restart. Send a new message to continue.";

/** §3.4 — a queued message whose compaction failed is never silently dropped. */
export const COMPACTION_FAILED_MESSAGE =
  "Context compaction failed. Send this message again to continue.";
