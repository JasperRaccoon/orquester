export type DetectedAgent = "claude" | "codex";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function detectAgentFromBlob(parsed: unknown): DetectedAgent | null {
  if (!isRecord(parsed)) return null;
  if (isRecord(parsed.claudeAiOauth)) return "claude";
  if (isRecord(parsed.tokens) && typeof parsed.tokens.access_token === "string") return "codex";
  return null;
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
