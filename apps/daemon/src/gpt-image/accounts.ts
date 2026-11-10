/**
 * Which Codex account GPT Image uses, and its login (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §5).
 *
 * - **Eligible:** a Codex account that is not `needsReauth` and whose plan is not Free. The plan comes
 *   from the access token's claims (`parseCodexPlan`), else the account record; unknown counts as
 *   eligible (the upstream refusal then says so, §11).
 * - **`auto`:** the eligible accounts in Settings order; the caller fails over once on an exhausted
 *   limit. **A pinned account** is the only candidate and never fails over.
 * - **The login** is read through `AgentAccountsService.codexLogin` and renewed only through
 *   `refreshNow("codex", id, { allowHeld: true })` — the daemon's one refresher, safe beside a live
 *   Codex chat because Codex adopts a daemon-refreshed `auth.json`. Nothing here posts a refresh
 *   token or writes `auth.json`.
 */

import type { AgentAccount, GptImageAccountBlock, GptImageAccountInfo } from "@orquester/api";

import { REFRESH_MARGIN_MS } from "../agent-account-refresh.ts";
import type { AccountRefreshOutcome } from "../agent-accounts.ts";
import { FREE_PLAN_MESSAGE, GptImageError, needsSignInMessage, NO_ACCOUNT_MESSAGE } from "./errors.ts";
import type { UpstreamCredentials } from "./upstream.ts";

export interface CodexLogin {
  accessToken: string;
  chatgptAccountId: string | null;
  expiresAt: number | null;
  plan: string | null;
}

/** What GPT Image needs of `AgentAccountsService`. */
export interface GptImageAccountsPort {
  list(): { accounts: AgentAccount[] };
  codexLogin(id: string): Promise<CodexLogin | null>;
  refreshNow(agent: "codex", id: string, options: { allowHeld?: boolean }): Promise<AccountRefreshOutcome>;
  markNeedsReauth(id: string, value: boolean): Promise<void>;
}

/** A Codex account as selection sees it. */
export interface CodexAccountView {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  needsReauth: boolean;
}

/** The Codex accounts in Settings order, with the freshest plan known (`plans`: id → the token's). */
export function codexAccountViews(accounts: readonly AgentAccount[], plans: ReadonlyMap<string, string | null>): CodexAccountView[] {
  return accounts
    .filter((account) => account.agent === "codex")
    .map((account) => ({
      id: account.id,
      label: account.label,
      email: account.email,
      plan: plans.get(account.id) ?? account.plan ?? null,
      needsReauth: account.needsReauth
    }));
}

/** Why an account cannot make images now, or undefined when it can. */
export function accountBlock(account: CodexAccountView): GptImageAccountBlock | undefined {
  if (account.needsReauth) return "needs-reauth";
  if (account.plan === "free") return "free-plan";
  return undefined;
}

export function accountInfo(account: CodexAccountView): GptImageAccountInfo {
  const blocked = accountBlock(account);
  return { id: account.id, label: account.label, email: account.email, plan: account.plan, ...(blocked ? { blocked } : {}) };
}

/**
 * The accounts one call may use, in order, and whether the setting pinned one. Throws the §11
 * refusal when none can: a pinned account that is gone, needs signing in or is on Free; no eligible
 * account for `auto`.
 */
export function candidateAccounts(accounts: readonly CodexAccountView[], setting: string): { candidates: CodexAccountView[]; pinned: boolean } {
  if (setting !== "auto") {
    const pinned = accounts.find((account) => account.id === setting);
    if (!pinned) {
      throw new GptImageError("GPT_IMAGE_NO_ACCOUNT", "The ChatGPT account chosen for GPT Image no longer exists. Pick another in Settings → Plugins → GPT Image.");
    }
    const blocked = accountBlock(pinned);
    if (blocked === "needs-reauth") throw new GptImageError("GPT_IMAGE_NEEDS_SIGN_IN", needsSignInMessage(pinned.label));
    if (blocked === "free-plan") throw new GptImageError("GPT_IMAGE_FREE_PLAN", FREE_PLAN_MESSAGE);
    return { candidates: [pinned], pinned: true };
  }
  const eligible = accounts.filter((account) => accountBlock(account) === undefined);
  if (eligible.length === 0) {
    if (accounts.length > 0 && accounts.every((account) => accountBlock(account) === "free-plan")) throw new GptImageError("GPT_IMAGE_FREE_PLAN", FREE_PLAN_MESSAGE);
    throw new GptImageError("GPT_IMAGE_NO_ACCOUNT", NO_ACCOUNT_MESSAGE);
  }
  return { candidates: eligible, pinned: false };
}

/** The first account `auto` (or the pinned id) would use now, or null. */
export function activeAccountId(accounts: readonly CodexAccountView[], setting: string): string | null {
  try {
    return candidateAccounts(accounts, setting).candidates[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** A token with less than this left is renewed before use. */
export const TOKEN_REFRESH_MARGIN_MS = REFRESH_MARGIN_MS;
/** A token whose renewal failed for a passing reason is still used while it has this much left. */
const STALE_TOKEN_FLOOR_MS = 2 * 60_000;

/** The account's login is gone: flag it (`needsReauth`) and refuse. */
async function needsSignIn(port: GptImageAccountsPort, account: CodexAccountView): Promise<never> {
  await port.markNeedsReauth(account.id, true).catch(() => undefined);
  throw new GptImageError("GPT_IMAGE_NEEDS_SIGN_IN", needsSignInMessage(account.label));
}

/**
 * Credentials for one call: the current login, renewed through `refreshNow` when it expires within
 * {@link TOKEN_REFRESH_MARGIN_MS} or when `force` (the endpoint refused the token). `refreshed`: the
 * token was renewed now, so a 401 with it means the login itself is gone.
 */
export async function credentialsFor(
  port: GptImageAccountsPort,
  account: CodexAccountView,
  now: number,
  options: { force?: boolean } = {}
): Promise<{ credentials: UpstreamCredentials; plan: string | null; refreshed: boolean }> {
  let login = await port.codexLogin(account.id);
  if (!login) return needsSignIn(port, account);
  let refreshed = false;
  const expiring = login.expiresAt !== null && login.expiresAt - now < TOKEN_REFRESH_MARGIN_MS;
  if (options.force || expiring) {
    const outcome = await port.refreshNow("codex", account.id, { allowHeld: true });
    if (outcome === "refreshed") {
      login = await port.codexLogin(account.id);
      if (!login) return needsSignIn(port, account);
      refreshed = true;
    } else if (outcome === "invalid-grant") {
      // The sign-in service refused the refresh token: the login itself is gone (refreshNow flagged it already).
      return needsSignIn(port, account);
    } else {
      // No renewal now, but nothing says the login is gone: `failed` (the sign-in service could not be reached),
      // `held` (a live Codex chat holds the account and renews it; an `allowHeld` caller can get it from a refresh
      // another caller started) or `unavailable` (no refresh token to read just now). The current token while it still
      // works, as the box broker does; else a passing refusal — never a flag that signs the account out everywhere.
      const usable = !options.force && (login.expiresAt === null || login.expiresAt - now > STALE_TOKEN_FLOOR_MS);
      if (!usable) {
        const why = outcome === "held" ? "is being renewed by a running Codex chat" : "could not be renewed just now";
        throw new GptImageError("GPT_IMAGE_UNAVAILABLE", `The ChatGPT login of ${account.label} ${why}. Try again shortly.`);
      }
    }
  }
  return { credentials: { accessToken: login.accessToken, chatgptAccountId: login.chatgptAccountId }, plan: login.plan, refreshed };
}
