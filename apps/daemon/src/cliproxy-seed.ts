/**
 * Managed-credential → CLIProxyAPI auth-file converters (seed-by-conversion, spec §4).
 *
 * These are pure functions: they take a managed account's on-disk credential blob
 * (Codex `auth.json` / Claude `.credentials.json`) and produce the CLIProxyAPI
 * `CodexTokenStorage` / `ClaudeTokenStorage` object plus a deterministic filename.
 * There is deliberately no device-auth/browser flow anywhere — conversion is the
 * sole credential path.
 *
 * Each converted file carries a top-level `prefix` (`Auth.Prefix`) derived
 * deterministically from the account id, so a `<prefix>/<model>` request routes to
 * exactly that seeded credential. The prefix is computed identically here (seed
 * time) and in the launch contributor (launch time), so no stored map is needed.
 *
 * No wall-clock is read: `expired` is derived from the token's own `exp`/`expiresAt`,
 * so conversion is fully deterministic and unit-testable with synthetic blobs.
 */

/**
 * Deterministic per-account routing prefix (spec §2): `acc` + the first 8 hex
 * characters of the dash-stripped account id. Slug-safe (matches a `MODEL_NAME_RE`
 * path segment). Computed identically at seed and launch time — no stored map.
 */
export function accountPrefix(accountId: string | undefined): string {
  return "acc" + String(accountId ?? "").replace(/-/g, "").slice(0, 8);
}

/** Base64url-decode a JWT's payload segment; `{}` on any malformed input. */
export function jwtClaims(jwt: string): Record<string, unknown> {
  const parts = typeof jwt === "string" ? jwt.split(".") : [];
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** RFC3339 (`YYYY-MM-DDTHH:mm:ssZ`, no fractional seconds) from an epoch-ms instant. */
function rfc3339FromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Convert a managed Codex `auth.json` (`{tokens:{...}, last_refresh}`) into a
 * CLIProxyAPI `CodexTokenStorage` object plus a filename. Throws if the shape is
 * invalid rather than emitting a garbage credential.
 */
export function codexStorageFromAuthJson(
  authJson: unknown,
  accountId?: string
): { file: string; storage: Record<string, unknown> } {
  const root = asRecord(authJson);
  const tokens = asRecord(root.tokens);
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : "";
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error("codex auth.json missing tokens");
  }
  const idClaims = jwtClaims(idToken);
  const authClaim = asRecord(idClaims["https://api.openai.com/auth"]);
  const accessClaims = jwtClaims(accessToken);
  const exp = typeof accessClaims.exp === "number" ? accessClaims.exp : 0;
  const prefix = accountPrefix(accountId);
  const storage: Record<string, unknown> = {
    type: "codex",
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id:
      typeof authClaim.chatgpt_account_id === "string"
        ? authClaim.chatgpt_account_id
        : typeof tokens.account_id === "string"
          ? tokens.account_id
          : "",
    email: typeof idClaims.email === "string" ? idClaims.email : "",
    last_refresh: typeof root.last_refresh === "string" ? root.last_refresh : "",
    expired: rfc3339FromMs(exp * 1000),
    prefix
  };
  return { file: `codex-${prefix}.json`, storage };
}

/**
 * Convert a managed Claude `.credentials.json` (`{claudeAiOauth:{...}}`) into a
 * CLIProxyAPI `ClaudeTokenStorage` object plus a filename. Throws on invalid shape.
 */
export function claudeStorageFromCredentials(
  creds: unknown,
  accountId?: string
): { file: string; storage: Record<string, unknown> } {
  const root = asRecord(creds);
  const oauth = asRecord(root.claudeAiOauth);
  const accessToken = typeof oauth.accessToken === "string" ? oauth.accessToken : "";
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  if (!accessToken || !("claudeAiOauth" in root)) {
    throw new Error("claude credentials missing claudeAiOauth");
  }
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  const prefix = accountPrefix(accountId);
  const storage: Record<string, unknown> = {
    type: "claude",
    id_token: "",
    access_token: accessToken,
    refresh_token: refreshToken,
    email: "",
    expired: rfc3339FromMs(expiresAt),
    prefix
  };
  return { file: `claude-${prefix}.json`, storage };
}

/**
 * Milliseconds until a converted storage's `expired` timestamp (negative if past).
 * The caller warns/blocks on a stale token before seeding, to avoid triggering a
 * proxy-side refresh of a nearly-expired token (dual-refresher rule).
 */
export function accessTokenFreshMs(storage: { expired: string }, now: number = Date.now()): number {
  const t = Date.parse(storage.expired);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t - now;
}
