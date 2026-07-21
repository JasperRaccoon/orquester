import type { AgentAccountRecord } from "@orquester/config";

export const REFRESH_INTERVAL_MS = 60 * 60_000;
export const REFRESH_MARGIN_MS = 15 * 60_000;

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function selectAccountsToRefresh(
  accounts: AgentAccountRecord[],
  live: Set<string>,
  expiries: Map<string, number | null>,
  now: number,
  marginMs: number
): AgentAccountRecord[] {
  return accounts.filter((a) => {
    if (a.agent !== "claude" && a.agent !== "codex") return false;
    if (live.has(a.id)) return false;
    const exp = expiries.get(a.id);
    if (exp == null) return true; // unknown expiry → refresh to be safe
    return exp <= now + marginMs;
  });
}

export function mergeClaudeRefreshedCreds(
  existing: any,
  refreshed: { access_token: string; refresh_token: string; expires_at?: number }
): any {
  const oauth = { ...(existing?.claudeAiOauth ?? {}) };
  oauth.accessToken = refreshed.access_token;
  oauth.refreshToken = refreshed.refresh_token;
  if (refreshed.expires_at !== undefined) oauth.expiresAt = refreshed.expires_at;
  return { ...existing, claudeAiOauth: oauth };
}

export async function refreshClaudeToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<
  { ok: true; access_token: string; refresh_token: string; expires_at?: number } | { ok: false; invalidGrant: boolean }
> {
  let res: Response;
  try {
    res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID })
    });
  } catch {
    return { ok: false, invalidGrant: false };
  }
  if (!res.ok) {
    let invalidGrant = false;
    try {
      invalidGrant = ((await res.json()) as { error?: string })?.error === "invalid_grant";
    } catch {
      /* ignore */
    }
    return { ok: false, invalidGrant };
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_at?: number };
  if (!body.access_token || !body.refresh_token) return { ok: false, invalidGrant: false };
  return { ok: true, access_token: body.access_token, refresh_token: body.refresh_token, expires_at: body.expires_at };
}
