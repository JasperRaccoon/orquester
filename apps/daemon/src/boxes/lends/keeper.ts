/**
 * The keeper of one lent login (lending spec §6): on the host, it keeps the login file of an account
 * lent to a box current until the lend ends, with nothing on the box asking. It is the chat logic of
 * `BoxLaunch` without a chat, with the same token policy (`agent-host/boxes/token-policy.ts`).
 *
 * - **Short token:** a timer armed for the moment the token turns stale asks the broker again.
 * - **Host renewal:** renewing an account revokes its previous token at once, so a host login whose
 *   token differs from the box's is fetched and written right away.
 * - **Transient failure:** the box keeps its token, status `renewal-failing`, retried with backoff
 *   (1 minute doubling to 15, back to 1 on a success); a change to the host's login looks at once.
 * - **`TOKEN_NEEDS_REAUTH`, or an account the host already flags:** status `needs-login`, and nothing
 *   is asked until the host's login file holds something else: a refresh token the provider refused
 *   is never tried again, across restarts too.
 * - **A real login on the box** (`LEND_APPDIR_IN_USE`): never overwritten. Status `renewal-failing`
 *   with the reason, and no retries: only a host change or a reconnect looks again.
 * - **Unknown expiry:** the file claims an hour (`claudeBoxCredentials`), so it is rewritten with the
 *   same token before that runs out, with no refresh spent on it.
 * - **Box offline:** status `waiting-for-vm`, no attempts. The box's file may be stale when it
 *   returns, so it is always rewritten then, before the timer is armed again.
 *
 * All of one lend's work runs one pass at a time, and looks asked for meanwhile coalesce. {@link stop}
 * aborts a wait in the broker and resolves when the pass in flight is over, and every pass re-checks
 * after each await, so nothing is written once it resolved. Timers never keep the process alive. A
 * failure is logged with ids and error codes, never a token.
 */

import type { BoxLendAgent, BoxLentAccountStatus } from "@orquester/api";

import {
  BOX_TOKEN_MIN_VALID_SECONDS,
  BOX_TOKEN_RENEW_MAX_DELAY_MS,
  BOX_TOKEN_RESTART_MARGIN_MS,
  BOX_TOKEN_RENEW_RETRY_MS,
  type BoxTokenTracker
} from "../../agent-host/boxes/token-policy.ts";
import { AgentTokenError } from "../broker/broker.ts";
import { grantFromCredentials } from "../broker/credentials.ts";
import type { AgentTokenBroker, AgentTokenGrant } from "../contracts.ts";

/** How long one request may wait on the broker (a host CLI renewing) before it counts as a failure and is retried. */
const LEND_TOKEN_WAIT_MS = 2 * 60_000;
/** The longest wait between attempts after failures (they start at `BOX_TOKEN_RENEW_RETRY_MS`). */
const LEND_RETRY_MAX_MS = 15 * 60_000;

export interface LendKeeperState {
  status: BoxLentAccountStatus;
  statusMessage: string | null;
  /** Epoch ms of the token on the box; null when unknown. */
  tokenExpiresAt: number | null;
}

export interface LendKeeperDeps {
  lendId: string;
  boxId: string;
  agent: BoxLendAgent;
  accountId: string;
  broker: Pick<AgentTokenBroker, "getLentToken">;
  /** The text of the account's login file on this host; null when there is none. */
  readHostLogin(): Promise<string | null>;
  /** Hear of every change to that file. Returns the unsubscribe function. */
  watchHostLogin(onChange: () => void): () => void;
  /** The tracker shared by all keepers, keyed by lend id. */
  tracker: BoxTokenTracker;
  connected(): boolean;
  /** Whether the host already knows this account's login was refused. */
  accountNeedsLogin(): boolean;
  /** Rejects with code `LEND_APPDIR_IN_USE` when the box's login file is someone's real login. */
  checkBoxLogin(): Promise<void>;
  /** Writes the login file on the box unless `wanted()` turned false before the write started. */
  writeLogin(grant: AgentTokenGrant, wanted: () => boolean): Promise<void>;
  onStateChange(state: LendKeeperState, previous: LendKeeperState): void;
  warn(message: string): void;
}

/** A lend ended while it was being installed. */
export class LendStoppedError extends Error {
  constructor() {
    super("The lend ended.");
    this.name = "LendStoppedError";
  }
}

/** A code for a log line: the error's own, never its message (which may quote a path). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : typeof error;
}

export class LendKeeper {
  private state: LendKeeperState;
  private stopped = false;
  /** The box's file may not hold the login: new, or the box was away. Cleared by a write. */
  private boxStale = true;
  /** The token last written to the box. */
  private grant: AgentTokenGrant | null = null;
  /** The host's login file when the provider refused it: asked again only once it differs. */
  private refused: { text: string | null } | null = null;
  /** The host's login file at the last pass. */
  private seenHostLogin: { text: string | null } | null = null;
  /** Failed attempts in a row. */
  private failures = 0;
  private work: Promise<unknown> = Promise.resolve();
  private lookQueued = false;
  private attempt: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly deps: LendKeeperDeps,
    status: BoxLentAccountStatus
  ) {
    this.state = { status, statusMessage: null, tokenExpiresAt: null };
  }

  current(): LendKeeperState {
    return this.state;
  }

  /** The first login of a new lend: rejects when it could not be got or written. */
  install(): Promise<void> {
    const run = this.work.then(async () => {
      try {
        if (this.stopped) throw new LendStoppedError();
        await this.write(await this.ask());
      } catch (error) {
        throw this.stopped ? new LendStoppedError() : error;
      }
      if (this.stopped) throw new LendStoppedError();
    });
    this.work = run.catch(() => undefined);
    return run;
  }

  /** From now on the host's login is watched and the token kept; a look right away covers what changed so far. */
  start(): void {
    if (this.stopped || this.unwatch) return;
    this.unwatch = this.deps.watchHostLogin(() => void this.look());
    void this.look();
  }

  /** The box's link dropped. */
  disconnected(): void {
    void this.look();
  }

  /** The box's link is back: its file may be stale, so it is rewritten whatever the tokens say. */
  reconnected(): void {
    this.boxStale = true;
    void this.look();
  }

  /** Resolves when no pass is in flight (a drain for callers and tests). */
  idle(): Promise<unknown> {
    return this.work;
  }

  /** Nothing is written or asked once this resolves. */
  stop(): Promise<unknown> {
    this.stopped = true;
    this.attempt?.abort();
    this.clearTimer();
    this.unwatch?.();
    this.unwatch = null;
    this.deps.tracker.forget(this.deps.lendId);
    return this.work;
  }

  /** Queue one pass; a pass already queued covers this request too. */
  private look(): Promise<unknown> {
    if (this.stopped || this.lookQueued) return this.work;
    this.lookQueued = true;
    this.work = this.work.then(async () => {
      this.lookQueued = false;
      if (this.stopped) return;
      try {
        await this.pass();
      } catch (error) {
        this.deps.warn(`Box ${this.deps.boxId}: the lent login of account ${this.deps.accountId} could not be kept current (${errorCode(error)})`);
        if (!this.stopped) this.retryLater();
      }
    });
    return this.work;
  }

  private async pass(): Promise<void> {
    this.clearTimer();
    if (!this.deps.connected()) {
      this.boxStale = true;
      // No attempts while it is away; "needs-login" stays: it is what the owner has to act on.
      if (this.state.status !== "needs-login") this.setStatus("waiting-for-vm");
      return;
    }
    const hostLogin = await this.deps.readHostLogin().catch(() => null);
    if (this.stopped) return;

    const hostChanged = this.seenHostLogin !== null && this.seenHostLogin.text !== hostLogin;
    this.seenHostLogin = { text: hostLogin };

    if (this.refused !== null && this.refused.text === hostLogin) {
      await this.rewriteLastGrant();
      return;
    }
    // Refused before (a restart, or the host's own refresher): no provider post to learn it again.
    if (this.refused === null && !hostChanged && this.deps.accountNeedsLogin()) {
      this.refused = { text: hostLogin };
      this.setStatus("needs-login", "This account's login has expired. Sign in to it again in Settings → Agent accounts.");
      await this.rewriteLastGrant();
      return;
    }

    const hostGrant = hostLogin === null ? null : grantFromCredentials(this.deps.agent, hostLogin);
    // An unreadable file is one being rewritten: its last write brings another look.
    const hostDiffers = hostGrant !== null && hostGrant.accessToken !== this.grant?.accessToken;
    const nothingToDo =
      !this.boxStale &&
      this.refused === null &&
      this.state.status !== "renewal-failing" &&
      !hostDiffers &&
      !this.deps.tracker.stale(this.deps.lendId);
    if (nothingToDo) {
      if (this.grant?.expiresAt === null) {
        try {
          await this.write(this.grant);
        } catch (error) {
          if (!this.stopped) await this.askFailed(error, hostLogin);
          return;
        }
        if (this.stopped) return;
      }
      this.succeeded();
      return;
    }

    let grant: AgentTokenGrant;
    try {
      // Before the broker: a login this could never replace must not cost a refresh.
      await this.deps.checkBoxLogin();
      if (this.stopped) return;
      grant = await this.ask();
    } catch (error) {
      if (this.stopped) return;
      await this.askFailed(error, hostLogin);
      return;
    }
    if (this.stopped) return;
    this.refused = null;
    if (this.boxStale || grant.accessToken !== this.grant?.accessToken) {
      try {
        await this.write(grant);
      } catch (error) {
        if (!this.stopped) await this.askFailed(error, hostLogin);
        return;
      }
      if (this.stopped) return;
    } else {
      this.note(grant);
    }
    this.succeeded();
  }

  private succeeded(): void {
    this.failures = 0;
    this.setStatus("active");
    this.arm();
  }

  private async ask(): Promise<AgentTokenGrant> {
    const attempt = new AbortController();
    this.attempt = attempt;
    const limit = setTimeout(() => attempt.abort(), LEND_TOKEN_WAIT_MS);
    limit.unref();
    try {
      return await this.deps.broker.getLentToken(
        { boxId: this.deps.boxId, agent: this.deps.agent, accountId: this.deps.accountId, minValidSeconds: BOX_TOKEN_MIN_VALID_SECONDS },
        attempt.signal
      );
    } finally {
      clearTimeout(limit);
      this.attempt = null;
    }
  }

  private async write(grant: AgentTokenGrant): Promise<void> {
    await this.deps.writeLogin(grant, () => !this.stopped);
    if (this.stopped) return;
    this.note(grant);
    this.boxStale = false;
  }

  private note(grant: AgentTokenGrant): void {
    this.grant = grant;
    this.deps.tracker.note(this.deps.lendId, grant.expiresAt);
    this.setState({ ...this.state, tokenExpiresAt: grant.expiresAt });
  }

  private async askFailed(error: unknown, hostLogin: string | null): Promise<void> {
    if (errorCode(error) === "LEND_APPDIR_IN_USE") {
      this.deps.warn(`Box ${this.deps.boxId}: a real login is at the lent login's path of account ${this.deps.accountId}; it is left alone`);
      this.setStatus("renewal-failing", (error as Error).message);
      return;
    }
    if (error instanceof AgentTokenError && error.code === "TOKEN_NEEDS_REAUTH") {
      this.refused = { text: hostLogin };
      this.setStatus("needs-login", error.message);
      await this.rewriteLastGrant();
      return;
    }
    if (!this.deps.connected()) {
      this.boxStale = true;
      this.setStatus("waiting-for-vm");
      return;
    }
    this.deps.warn(`Box ${this.deps.boxId}: could not renew the lent login of account ${this.deps.accountId} (${errorCode(error)})`);
    await this.rewriteLastGrant();
    if (this.stopped) return;
    this.setStatus("renewal-failing", error instanceof AgentTokenError ? error.message : "Could not renew this login yet.");
    this.retryLater();
  }

  /** The box came back while no new token can be had: it gets the last one, which needs nobody's refresh token. */
  private async rewriteLastGrant(): Promise<void> {
    if (!this.boxStale || this.grant === null || !this.deps.connected()) return;
    await this.write(this.grant).catch((error: unknown) => {
      this.deps.warn(`Box ${this.deps.boxId}: could not write the lent login of account ${this.deps.accountId} (${errorCode(error)})`);
    });
  }

  private arm(): void {
    if (this.stopped) return;
    const until = this.deps.tracker.msUntilStale(this.deps.lendId);
    // An unknown expiry: back before the hour the file claims runs out. One days away: still looks at
    // the host's login now and then.
    const delay = until === null ? BOX_TOKEN_RESTART_MARGIN_MS : Math.min(until < 0 ? BOX_TOKEN_RENEW_RETRY_MS : until + 1, BOX_TOKEN_RENEW_MAX_DELAY_MS);
    this.setTimer(delay);
  }

  private retryLater(): void {
    this.setTimer(Math.min(BOX_TOKEN_RENEW_RETRY_MS * 2 ** this.failures, LEND_RETRY_MAX_MS));
    this.failures += 1;
  }

  private setTimer(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(status: BoxLentAccountStatus, statusMessage: string | null = null): void {
    this.setState({ ...this.state, status, statusMessage });
  }

  private setState(next: LendKeeperState): void {
    const previous = this.state;
    this.state = next;
    if (previous.status !== next.status || previous.statusMessage !== next.statusMessage || previous.tokenExpiresAt !== next.tokenExpiresAt) {
      this.deps.onStateChange(next, previous);
    }
  }
}
