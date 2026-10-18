import { createHash, randomBytes } from "node:crypto";
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from "./agent-account-refresh.ts";

/**
 * The Claude.ai login of `claude auth login` in its manual-redirect form
 * (constants and request shapes read from the Claude Code 2.1.285 bundle):
 * an OAuth authorization-code grant with PKCE whose redirect is Anthropic's
 * own callback page, which shows the user a `code#state` string to paste back.
 * There is no device-code flow for Claude.ai accounts.
 */

const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** The CLI's Claude.ai login scopes; `user:inference` marks a subscription
 *  login the CLI will persist. */
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins"
];
/** Organization type → the CLI's `subscriptionType`. */
const SUBSCRIPTION_TYPES: Record<string, string> = {
  claude_max: "max",
  claude_pro: "pro",
  claude_enterprise: "enterprise",
  claude_team: "team"
};
const REQUEST_TIMEOUT_MS = 30_000;

export interface ClaudeOAuthPkce {
  verifier: string;
  state: string;
}

export interface ClaudeOAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  email?: string;
}

export interface ClaudeProfile {
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export function createClaudeOAuthPkce(): ClaudeOAuthPkce {
  return { verifier: randomBytes(32).toString("base64url"), state: randomBytes(32).toString("base64url") };
}

export function claudeAuthorizeUrl(pkce: ClaudeOAuthPkce): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", MANUAL_REDIRECT_URL);
  url.searchParams.append("scope", SCOPES.join(" "));
  url.searchParams.append("code_challenge", createHash("sha256").update(pkce.verifier).digest("base64url"));
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", pkce.state);
  return url.toString();
}

/**
 * Split what the user pasted into the authorization code and its state: the
 * callback page's `code#state`, or the callback URL itself.
 */
export function parseClaudeAuthorizationCode(input: string): { code: string; state: string } | null {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      return code && state ? { code, state } : null;
    } catch {
      return null;
    }
  }
  const [code, state] = text.split("#");
  return code && state ? { code, state } : null;
}

export async function exchangeClaudeAuthorizationCode(
  code: string,
  pkce: ClaudeOAuthPkce
): Promise<{ ok: true; tokens: ClaudeOAuthTokens } | { ok: false; error: string; invalidCode: boolean }> {
  let res: Response;
  try {
    res = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: MANUAL_REDIRECT_URL,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: pkce.verifier,
        state: pkce.state
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return { ok: false, error: `Claude token exchange failed: ${error instanceof Error ? error.message : String(error)}`, invalidCode: false };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const invalidCode = res.status === 400 || res.status === 401;
    const detail =
      typeof body.error_description === "string" && body.error_description
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
    return {
      ok: false,
      error: invalidCode ? `That code was not accepted (${detail}). Open the link again for a fresh one.` : `Claude token exchange failed: ${detail}`,
      invalidCode
    };
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  if (!accessToken || !refreshToken) return { ok: false, error: "Claude returned no usable token pair", invalidCode: false };
  const account = body.account && typeof body.account === "object" ? (body.account as Record<string, unknown>) : null;
  const email = account && typeof account.email_address === "string" && account.email_address ? account.email_address : undefined;
  return {
    ok: true,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(typeof body.expires_in === "number" ? { expires_in: body.expires_in } : {}),
      ...(typeof body.refresh_token_expires_in === "number" ? { refresh_token_expires_in: body.refresh_token_expires_in } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(email ? { email } : {})
    }
  };
}

/** The plan fields the CLI stores next to its tokens. A failed lookup only
 *  leaves them unknown; the login itself stands. */
export async function fetchClaudeProfile(accessToken: string): Promise<ClaudeProfile> {
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return { subscriptionType: null, rateLimitTier: null };
    const body = (await res.json()) as { organization?: { organization_type?: unknown; rate_limit_tier?: unknown } };
    const type = body.organization?.organization_type;
    const tier = body.organization?.rate_limit_tier;
    return {
      subscriptionType: typeof type === "string" ? (SUBSCRIPTION_TYPES[type] ?? null) : null,
      rateLimitTier: typeof tier === "string" ? tier : null
    };
  } catch {
    return { subscriptionType: null, rateLimitTier: null };
  }
}

/** The Claude CLI's native `.credentials.json`, as its own login saves it. */
export function claudeCredentialsFromTokens(
  tokens: ClaudeOAuthTokens,
  profile: ClaudeProfile,
  now: number = Date.now()
): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      ...(typeof tokens.expires_in === "number" ? { expiresAt: now + tokens.expires_in * 1000 } : {}),
      ...(typeof tokens.refresh_token_expires_in === "number"
        ? { refreshTokenExpiresAt: now + tokens.refresh_token_expires_in * 1000 }
        : {}),
      scopes: (tokens.scope ?? SCOPES.join(" ")).split(" ").filter(Boolean),
      subscriptionType: profile.subscriptionType,
      rateLimitTier: profile.rateLimitTier
    }
  };
}
