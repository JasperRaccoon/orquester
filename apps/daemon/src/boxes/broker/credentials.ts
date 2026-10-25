/**
 * Reading a managed account's credential file for the token broker (spec 2026-10-19 boxes §7):
 * which file each CLI keeps, how to pull ONLY the access token (and the non-secret facts a box
 * CLI needs next to it) out of it, and the node:fs implementation of {@link CredentialFiles}.
 *
 * A grant is always built field by field from the parsed file — never by spreading or copying a
 * parsed object — so a refresh token or an id token can never ride along.
 */

import { watch } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { decodeJwtPayload, grokAuthEntry } from "../../agent-account-identity.ts";
import { assertOwnedAccountHome } from "../../agent-account-paths.ts";
import type { AgentTokenGrant, BoxAgentId } from "../contracts.ts";

/** The file each CLI keeps its login in, inside the account home (`agent-accounts.ts`). */
export const CREDENTIAL_FILENAME: Readonly<Record<BoxAgentId, string>> = {
  claude: ".credentials.json",
  codex: "auth.json",
  grok: "auth.json"
};

export function credentialPath(home: string, agent: BoxAgentId): string {
  return join(home, CREDENTIAL_FILENAME[agent]);
}

export { CLAUDE_REFRESH_LOCK_STALE_MS, claudeRefreshLockPaths } from "../../agent-account-refresh.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The grant a credential file's text holds, or null when the file has no usable access token.
 *
 * - Claude: `claudeAiOauth.accessToken` and `expiresAt`; `extra` carries `subscriptionType`,
 *   `rateLimitTier` and `scopes` (space-separated). They are not secrets: with them the box can
 *   write a `.credentials.json` holding no refresh token that still selects the subscription's
 *   default model (the spike found a bare `CLAUDE_CODE_OAUTH_TOKEN` falls back to Sonnet).
 * - Codex: `tokens.access_token`, its JWT `exp`; `extra.chatgptAccountId` from `tokens.account_id`
 *   (else the token's `chatgpt_account_id` claim). `app-server`'s `chatgptAuthTokens` login needs
 *   nothing else — no id token.
 * - Grok: the preferred `issuer::client` entry's `key` and `expires_at`. `auth_provider_command`
 *   needs only `{access_token, expires_in}`; no issuer or client keys.
 */
export function grantFromCredentials(agent: BoxAgentId, text: string): AgentTokenGrant | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (agent === "claude") {
    const oauth = parsed.claudeAiOauth;
    if (!isRecord(oauth)) return null;
    const accessToken = nonEmptyString(oauth.accessToken);
    if (!accessToken) return null;
    const extra: Record<string, string> = {};
    const subscriptionType = nonEmptyString(oauth.subscriptionType);
    if (subscriptionType) extra.subscriptionType = subscriptionType;
    const rateLimitTier = nonEmptyString(oauth.rateLimitTier);
    if (rateLimitTier) extra.rateLimitTier = rateLimitTier;
    if (Array.isArray(oauth.scopes)) {
      const scopes = oauth.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
      if (scopes.length > 0) extra.scopes = scopes.join(" ");
    }
    const expiresAt = typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
    return { accessToken, expiresAt, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
  }

  if (agent === "codex") {
    const tokens = parsed.tokens;
    if (!isRecord(tokens)) return null;
    const accessToken = nonEmptyString(tokens.access_token);
    if (!accessToken) return null;
    const claims = decodeJwtPayload(accessToken);
    const auth = claims && isRecord(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
    const chatgptAccountId = nonEmptyString(tokens.account_id) ?? nonEmptyString(auth?.chatgpt_account_id);
    // `chatgptAuthTokens` cannot log in without the workspace id: a file without one is unusable.
    if (!chatgptAccountId) return null;
    const exp = claims?.exp;
    const expiresAt = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
    return { accessToken, expiresAt, extra: { chatgptAccountId } };
  }

  const entry = grokAuthEntry(parsed);
  const accessToken = nonEmptyString(entry?.key);
  if (!entry || !accessToken) return null;
  const at = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  return { accessToken, expiresAt: Number.isFinite(at) ? at : null };
}

/** The file operations the broker needs, injectable for tests. */
export interface CredentialFiles {
  /** `assertOwnedAccountHome`: the home is the account's own, not a symlink, marker matches. Throws otherwise. */
  assertOwnedHome(agent: BoxAgentId, accountId: string, home: string): Promise<void>;
  /** The file's text, or null when it does not exist. */
  read(path: string): Promise<string | null>;
  /** Milliseconds since the newest of `paths` was modified; null when none exists. */
  ageOfNewest(paths: string[]): Promise<number | null>;
  /**
   * Calls `onChange` whenever `path` is created, rewritten or replaced by a rename (the CLIs and
   * the daemon refresher do both). Returns the unsubscribe function.
   */
  watch(path: string, onChange: () => void): () => void;
}

export function nodeCredentialFiles(accountsDir: string, now: () => number = Date.now): CredentialFiles {
  return {
    assertOwnedHome: (agent, accountId, home) => assertOwnedAccountHome(accountsDir, agent, accountId, home),
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async ageOfNewest(paths) {
      let newest: number | null = null;
      for (const path of paths) {
        const stats = await lstat(path).catch(() => null);
        if (stats && (newest === null || stats.mtimeMs > newest)) newest = stats.mtimeMs;
      }
      return newest === null ? null : Math.max(0, now() - newest);
    },
    watch(path, onChange) {
      // The directory, not the file: a rename-replace gives the file a new inode, which a watch on
      // the old one would never report.
      const name = basename(path);
      try {
        const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
          if (filename === null || String(filename) === name) onChange();
        });
        // A watch that dies (the home was removed) only loses the early wake-up; the caller's
        // deadline still ends the wait.
        watcher.on("error", () => watcher.close());
        return () => watcher.close();
      } catch {
        return () => undefined;
      }
    }
  };
}
