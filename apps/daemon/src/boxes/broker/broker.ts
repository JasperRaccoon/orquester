/**
 * The agent token broker (spec 2026-10-19 boxes §7): a box CLI gets the current ACCESS token of the
 * managed account it was launched with — never a refresh token — and nothing but the existing
 * single refresher ever spends that account's refresh token.
 *
 * One request, in order:
 *
 * 1. Validate it and check the box may have the account: a live project box with a chat (or PTY
 *    session) in its project launched with that account, or a temporary box whose owning chat
 *    uses it. The System account is refused: its logins belong to CLIs outside Orquester.
 * 2. Read the account's credential file (after `assertOwnedAccountHome`). Enough life left
 *    (`minValidSeconds`, default 45 min) → return it.
 * 3. Otherwise, when no HOST-LOCAL session holds the account, refresh through
 *    `AgentAccountsService.refreshNow` (its per-account dedupe and `invalid_grant` → `needsReauth`)
 *    and return the new token. Concurrent requests for one account share one refresh.
 * 4. When a host-local session holds it, that CLI is the refresher. Claude CLIs adopt a credential
 *    file another process rewrote, and re-read it (twice, the second time under their refresh
 *    lock) before spending their own refresh token, so the daemon refreshes directly — but only
 *    while the token has more than {@link HELD_REFRESH_FLOOR_MS} left and no CLI holds the refresh
 *    lock, so the two never post the same refresh token. Codex and Grok, and Claude below that
 *    floor, wait: the credential file is watched for the CLI's rewrite, the holder set for the
 *    session ending (then the daemon refreshes), until the request's signal ends the wait.
 *
 * Evidence for step 4 and the per-CLI facts: docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-spikes.md.
 * Nothing here logs a token; errors name codes and accounts only.
 */

import { SYSTEM_ACCOUNT_ID } from "@orquester/api";

import { AgentAccountError } from "../../agent-account-paths.ts";
import type { AccountRefreshOutcome } from "../../agent-accounts.ts";
import type { AgentTokenBroker, AgentTokenGrant, BoxAgentId, BoxRegistry } from "../contracts.ts";
import {
  CLAUDE_REFRESH_LOCK_STALE_MS,
  claudeRefreshLockPaths,
  credentialPath,
  grantFromCredentials,
  type CredentialFiles
} from "./credentials.ts";

/** The default life a token must have left when it is handed out (the box restarts or re-asks before it runs out). */
export const DEFAULT_MIN_VALID_SECONDS = 45 * 60;
/** Upper bound for `minValidSeconds`: providers issue tokens for hours, not days. */
export const MAX_MIN_VALID_SECONDS = 24 * 60 * 60;
/**
 * A held Claude account is refreshed by the daemon only while its token has more than this left.
 * The Claude CLI refreshes only inside the last 5 minutes (2.1.285: `now + 300000 >= expiresAt`),
 * so above 10 minutes it cannot be posting the same refresh token at the same moment.
 */
export const HELD_REFRESH_FLOOR_MS = 10 * 60_000;

/**
 * Per CLI: whether a RUNNING host CLI adopts a credential file the daemon refreshed before it
 * spends its own copy of the refresh token (spike findings). Only then may the daemon refresh an
 * account a host-local session holds.
 */
export const HOST_CLI_ADOPTS_DAEMON_REFRESH: Readonly<Record<BoxAgentId, boolean>> = {
  claude: true,
  codex: false,
  grok: false
};

const BOX_AGENTS: readonly BoxAgentId[] = ["claude", "codex", "grok"];
const GONE_STATES = new Set(["destroying", "destroy-failed", "destroyed"]);

export type AgentTokenErrorCode =
  | "TOKEN_INVALID_REQUEST"
  | "TOKEN_FORBIDDEN"
  | "TOKEN_ACCOUNT_NOT_FOUND"
  | "TOKEN_NEEDS_REAUTH"
  | "TOKEN_UNAVAILABLE"
  | "TOKEN_WAIT_TIMEOUT";

/** A refusal the box (`res.error`) and the socket route (`{ code, message }`) get verbatim. Never names a token. */
export class AgentTokenError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503 | 504,
    readonly code: AgentTokenErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentTokenError";
  }
}

export interface AgentTokenRequest {
  boxId: string;
  agent: BoxAgentId;
  accountId: string;
  minValidSeconds?: number;
}

/** Runtime check of a request from a box or the socket route (both untrusted shapes). */
export function parseTokenRequest(raw: unknown): Required<AgentTokenRequest> {
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  const invalid = (message: string) => new AgentTokenError(400, "TOKEN_INVALID_REQUEST", message);
  if (!body) throw invalid("The token request must be an object.");
  const { boxId, agent, accountId, minValidSeconds } = body;
  if (typeof boxId !== "string" || boxId.length === 0) throw invalid("boxId is required.");
  if (typeof agent !== "string" || !(BOX_AGENTS as readonly string[]).includes(agent)) {
    throw invalid("agent must be claude, codex or grok.");
  }
  if (typeof accountId !== "string" || accountId.length === 0) throw invalid("accountId is required.");
  if (
    minValidSeconds !== undefined &&
    (typeof minValidSeconds !== "number" || !Number.isFinite(minValidSeconds) || minValidSeconds < 0 || minValidSeconds > MAX_MIN_VALID_SECONDS)
  ) {
    throw invalid(`minValidSeconds must be between 0 and ${MAX_MIN_VALID_SECONDS}.`);
  }
  return { boxId, agent: agent as BoxAgentId, accountId, minValidSeconds: minValidSeconds ?? DEFAULT_MIN_VALID_SECONDS };
}

/** The slice of `AgentAccountsService` the broker uses. */
export interface TokenBrokerAccounts {
  getRecord(id: string): { id: string; agent: string } | undefined;
  homePath(agent: string, id: string): string;
  refreshNow(agent: BoxAgentId, id: string, options: { allowHeld?: boolean }): Promise<AccountRefreshOutcome>;
}

/** A session as the router lists it (`SessionSummary` has these fields). */
export interface TokenBrokerSession {
  id: string;
  projectPath: string;
  accountId?: string;
}

export interface AgentTokenBrokerDeps {
  accounts: TokenBrokerAccounts;
  registry: Pick<BoxRegistry, "get" | "locate">;
  /** Every session (PTY and chat), for the "a launch in this box uses the account" check. */
  sessions(): Iterable<TokenBrokerSession>;
  /** `ChatAwareSessionManager.hostLocalAccountIds()`: accounts whose CLI on this host refreshes them. */
  hostLocalAccountIds(): ReadonlySet<string>;
  /** Fires when a session is created, updated, exits or closes (the holder set may have changed). */
  onSessionsChanged(listener: () => void): () => void;
  files: CredentialFiles;
  now?: () => number;
}

/**
 * A wake-up that cannot be missed: `arm()` before reading state, `wait()` after deciding to wait;
 * a `fire()` in between makes `wait()` return at once.
 */
class ChangeLatch {
  private fired = false;
  private wake: (() => void) | null = null;

  readonly fire = (): void => {
    this.fired = true;
    const wake = this.wake;
    this.wake = null;
    wake?.();
  };

  arm(): void {
    this.fired = false;
  }

  wait(signal: AbortSignal): Promise<void> {
    if (this.fired) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.wake = null;
        reject(signal.reason);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
    });
  }
}

function waitTimeout(): AgentTokenError {
  return new AgentTokenError(
    504,
    "TOKEN_WAIT_TIMEOUT",
    "Timed out waiting for a fresh login token: a chat on this host is using the account and has not renewed its login yet."
  );
}

export function createAgentTokenBroker(deps: AgentTokenBrokerDeps): AgentTokenBroker {
  const now = deps.now ?? Date.now;
  /** Account id → the refresh this broker started for it; concurrent requests share it. */
  const refreshing = new Map<string, Promise<AccountRefreshOutcome>>();

  function refreshOnce(agent: BoxAgentId, accountId: string, allowHeld: boolean): Promise<AccountRefreshOutcome> {
    const inFlight = refreshing.get(accountId);
    if (inFlight) return inFlight;
    const run = deps.accounts.refreshNow(agent, accountId, { allowHeld }).finally(() => refreshing.delete(accountId));
    refreshing.set(accountId, run);
    return run;
  }

  /** Whether one of the box's own launches uses the account (step 1). */
  function boxUsesAccount(box: NonNullable<ReturnType<BoxRegistry["get"]>>, accountId: string): boolean {
    for (const session of deps.sessions()) {
      if (session.accountId !== accountId) continue;
      if (box.purpose === "project") {
        const location = deps.registry.locate(session.projectPath);
        if (location.kind === "box" && location.boxId === box.id) return true;
      } else if (box.purpose === "temporary" && typeof box.threadId === "string" && session.id === box.threadId) {
        return true;
      }
    }
    return false;
  }

  function authorize(request: Required<AgentTokenRequest>): void {
    if (request.accountId === SYSTEM_ACCOUNT_ID) {
      throw new AgentTokenError(403, "TOKEN_FORBIDDEN", "Box chats use managed accounts only; the System account's logins stay on this host.");
    }
    const box = deps.registry.get(request.boxId);
    if (!box || GONE_STATES.has(box.state)) {
      throw new AgentTokenError(403, "TOKEN_FORBIDDEN", "This box is not active.");
    }
    const account = deps.accounts.getRecord(request.accountId);
    if (!account) throw new AgentTokenError(404, "TOKEN_ACCOUNT_NOT_FOUND", "That agent account no longer exists.");
    if (account.agent !== request.agent) {
      throw new AgentTokenError(403, "TOKEN_FORBIDDEN", `That account is not a ${request.agent} account.`);
    }
    if (!boxUsesAccount(box, request.accountId)) {
      throw new AgentTokenError(403, "TOKEN_FORBIDDEN", "No session in this box was launched with that account.");
    }
  }

  async function readGrant(agent: BoxAgentId, path: string): Promise<AgentTokenGrant | null> {
    const text = await deps.files.read(path);
    return text === null ? null : grantFromCredentials(agent, text);
  }

  /** Step 4's rule: may the daemon spend the refresh token while a host-local session holds the account? */
  async function mayRefreshHeld(agent: BoxAgentId, home: string, grant: AgentTokenGrant | null): Promise<boolean> {
    if (!HOST_CLI_ADOPTS_DAEMON_REFRESH[agent]) return false;
    if (grant === null || grant.expiresAt === null || grant.expiresAt - now() <= HELD_REFRESH_FLOOR_MS) return false;
    if (agent === "claude") {
      const lockAge = await deps.files.ageOfNewest(claudeRefreshLockPaths(home));
      if (lockAge !== null && lockAge < CLAUDE_REFRESH_LOCK_STALE_MS) return false; // the CLI is refreshing right now
    }
    return true;
  }

  return {
    async getToken(raw, signal) {
      const request = parseTokenRequest(raw);
      authorize(request);
      const { agent, accountId } = request;
      const minValidMs = request.minValidSeconds * 1000;
      const home = deps.accounts.homePath(agent, accountId);
      try {
        await deps.files.assertOwnedHome(agent, accountId, home);
      } catch (error) {
        if (error instanceof AgentAccountError) {
          throw new AgentTokenError(503, "TOKEN_UNAVAILABLE", "That account's login files are missing or not where Orquester keeps them.");
        }
        throw error;
      }
      const path = credentialPath(home, agent);

      // Subscribed before the first read, so a rewrite or a session ending between a read and the
      // wait still wakes it.
      const change = new ChangeLatch();
      const stopWatch = deps.files.watch(path, change.fire);
      const stopSessions = deps.onSessionsChanged(change.fire);
      try {
        for (;;) {
          if (signal.aborted) throw waitTimeout();
          change.arm();
          const grant = await readGrant(agent, path);
          const held = deps.hostLocalAccountIds().has(accountId);
          if (grant !== null) {
            // An unknown expiry cannot be judged: a holder's CLI owns it; otherwise refresh once.
            if (grant.expiresAt === null ? held : grant.expiresAt - now() >= minValidMs) return grant;
          }
          if (!held || (await mayRefreshHeld(agent, home, grant))) {
            const outcome = await refreshOnce(agent, accountId, held);
            if (outcome === "refreshed") {
              const fresh = await readGrant(agent, path);
              if (fresh !== null && (fresh.expiresAt === null || fresh.expiresAt > now())) return fresh;
              throw new AgentTokenError(503, "TOKEN_UNAVAILABLE", "The account was refreshed but its new login could not be read.");
            }
            if (outcome === "invalid-grant") {
              throw new AgentTokenError(409, "TOKEN_NEEDS_REAUTH", "This account's login has expired. Sign in to it again in Settings → Agent accounts.");
            }
            if (outcome === "unavailable") {
              throw new AgentTokenError(503, "TOKEN_UNAVAILABLE", "This account has no login Orquester can renew. Sign in to it again in Settings → Agent accounts.");
            }
            if (outcome === "failed") {
              throw new AgentTokenError(503, "TOKEN_UNAVAILABLE", "Could not reach the sign-in service to renew this account's login. Try again in a moment.");
            }
            // "held": a host-local session took the account meanwhile; its CLI refreshes — wait for it.
          }
          await change.wait(signal).catch(() => {
            throw waitTimeout();
          });
        }
      } finally {
        stopWatch();
        stopSessions();
      }
    }
  };
}
