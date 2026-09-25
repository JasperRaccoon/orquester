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
 *    host as soon as no thread has an active turn (the drain rule cliproxy
 *    uses for re-parenting);
 * 4. the socket answers but rejects the token — a foreign process. Log an
 *    error, **never kill or adopt**;
 * 5. nothing answers — spawn, poll readiness, then adopt.
 */
export const AGENT_HOST_PROTOCOL_VERSION = 1;

/** The tmux service session the host runs in, like cliproxy's (§3.1). */
export const AGENT_HOST_SERVICE_SESSION = "orqsvc-agent-host";

/** Bearer token header. The token file is 0600 and regenerated only when no host is alive. */
export const AGENT_HOST_AUTH_HEADER = "authorization";

export function agentHostAuthValue(token: string): string {
  return `Bearer ${token}`;
}

/** The `Host:` value used on unix-socket requests (the authority is meaningless). */
export const AGENT_HOST_HTTP_HOST = "agent-host.localhost";

/** 15 s unref'd health interval with bounded backoff, as for cliproxy (§3.1). */
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

  // §6.2 commands, one route per command.
  turn: (threadId: string): string => `${thread(threadId)}/turn`,
  interrupt: (threadId: string): string => `${thread(threadId)}/interrupt`,
  approval: (threadId: string): string => `${thread(threadId)}/approval`,
  answer: (threadId: string): string => `${thread(threadId)}/answer`,
  dismiss: (threadId: string): string => `${thread(threadId)}/dismiss`,
  revert: (threadId: string): string => `${thread(threadId)}/revert`,
  compact: (threadId: string): string => `${thread(threadId)}/compact`,
  background: (threadId: string): string => `${thread(threadId)}/background`,
  mode: (threadId: string): string => `${thread(threadId)}/mode`,
  sessionStop: (threadId: string): string => `${thread(threadId)}/session/stop`,

  // §6.3 reads.
  read: (threadId: string): string => `${thread(threadId)}/thread`,
  events: (threadId: string): string => `${thread(threadId)}/events`,
  turnDiff: (threadId: string, turnCount: number): string =>
    `${thread(threadId)}/turns/${turnCount}/diff`,
  item: (threadId: string, itemId: string): string =>
    `${thread(threadId)}/items/${encodeURIComponent(itemId)}`,
  /**
   * `GET` → `ThreadItemOutputResponse`: the streamed output of the tool call
   * the item belongs to, joined from the log; 404 `ITEM_NOT_FOUND` when the
   * item names no call. A host that predates the route answers its generic
   * route-miss 404 `THREAD_NOT_FOUND` until its drain-restart.
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
  holdGoals: "/goals/hold"
} as const;

/** `POST /goals/hold` (agent goals §5.7). */
export interface AgentHostHoldGoalsResponse {
  /** Every thread the host holds after this request, the ones held before it included. */
  heldThreadIds: string[];
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
  home: "system" | "account" | "cliproxy";
  modelSelection: unknown;
  runtimeMode: unknown;
  /** §6.1: refused with `RESUME_UNAVAILABLE` when the adapter cannot use it. */
  resume?: { home: "system" | "account" | "cliproxy"; conversationId: string };
  /**
   * The launcher-specific environment §3.1 requires a chat thread to get —
   * **exactly** what a terminal launch of the same registry entry gets today.
   *
   * The daemon composes it, because only the daemon has the sources: the
   * registry entry's own `env` plus its per-launcher env file
   * (`<appdir>/daemon/env/<id>.env`, e.g. `opencode.env`), and the
   * `resolveExtraEnv` contributors — the managed account home, the cliproxy
   * launcher env for `claudex`/`claudemix` (`ANTHROPIC_BASE_URL`,
   * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the compaction window and the
   * Claude timeout), and the resolved per-launch model pin.
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
  /** The proxy launcher owning the home when `home` is `"cliproxy"`. */
  proxyRefId?: string;
}

/**
 * Body of `POST /threads/:id/identity` — §3.4's account switch, applied on the
 * thread's next message.
 *
 * The four launch fields are the SAME shapes {@link CreateHostThreadRequest}
 * carries, because they replace exactly what create wrote: the host rewrites
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
  /**
   * The home kind. It may never cross the cliproxy boundary: a thread's home
   * KIND is a function of its registry entry, which never changes.
   */
  home: "system" | "account" | "cliproxy";
  launchEnv?: Record<string, string>;
  unsetEnv?: string[];
  homePath?: string;
  proxyRefId?: string;
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
