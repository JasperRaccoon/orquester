export type DetectedAgent = "claude" | "codex" | "grok";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function detectAgentFromBlob(parsed: unknown): DetectedAgent | null {
  if (!isRecord(parsed)) return null;
  if (isRecord(parsed.claudeAiOauth)) return "claude";
  if (isRecord(parsed.tokens) && typeof parsed.tokens.access_token === "string") return "codex";
  if (grokAuthEntry(parsed)) return "grok";
  return null;
}

/**
 * The grok CLI's `auth.json` is keyed by `"<oidc issuer>::<client id>"` with the
 * token record as the value (`key` = access token). Prefer the auth.x.ai
 * (SuperGrok) entry when several accumulate — same rule as the usage source.
 */
export function grokAuthEntry(parsed: unknown): Record<string, unknown> | null {
  if (!isRecord(parsed)) return null;
  const entries = Object.entries(parsed).filter(
    ([k, v]) => k.includes("::") && isRecord(v) && typeof v.key === "string" && v.key
  );
  const found = entries.find(([k]) => k.includes("auth.x.ai")) ?? entries[0];
  return found ? (found[1] as Record<string, unknown>) : null;
}

export function parseGrokIdentity(parsed: unknown): { email: string | null; userId: string | null } {
  const entry = grokAuthEntry(parsed);
  if (!entry) return { email: null, userId: null };
  return {
    email: typeof entry.email === "string" && entry.email ? entry.email : null,
    userId: typeof entry.user_id === "string" && entry.user_id ? entry.user_id : null
  };
}

export function claudePlanFromBlob(parsed: unknown): string | null {
  if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return null;
  const t = parsed.claudeAiOauth.subscriptionType;
  return typeof t === "string" && t ? t : null;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return isRecord(obj) ? obj : null;
  } catch {
    return null;
  }
}

export function parseCodexIdentity(parsed: unknown): { email: string | null; accountId: string | null } {
  if (!isRecord(parsed) || !isRecord(parsed.tokens)) return { email: null, accountId: null };
  const tokens = parsed.tokens;
  const claims = typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : null;
  const email = claims && typeof claims.email === "string" ? claims.email : null;
  const accountId =
    typeof tokens.account_id === "string"
      ? tokens.account_id
      : claims && typeof claims.chatgpt_account_id === "string"
        ? claims.chatgpt_account_id
        : null;
  return { email, accountId };
}
