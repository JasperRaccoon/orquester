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

  providers: "/providers",
  providerRefresh: (adapterId: string): string =>
    `/providers/${encodeURIComponent(adapterId)}/refresh`,


  /**
   * The intentional stop of §3.3: write every continuation marker for a
   * running thread with a usable cursor, then drain and stop. If the stop is
   * aborted, every marker written for it is cleared, so a cancelled restart
   * does not inject a phantom "Continue where you left off." on the next boot.
   */
  stop: "/stop"
} as const;

/** `GET /health` on the host socket. */
export interface AgentHostHealthResponse {
  ok: true;
  protocolVersion: number;
  hostInstanceId: string;
  /** Threads the host currently holds a live session for. */
  liveThreadIds: string[];
  /** Threads with an active turn — the drain-restart of §3.1 waits on this. */
  activeTurnThreadIds: string[];
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
