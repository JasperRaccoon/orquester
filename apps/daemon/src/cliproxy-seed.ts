// The grok CLI's public OIDC client — shared with the refresh path so seed-time
// conversion and the daemon refresher can never disagree on identity constants.
import { GROK_OIDC_ISSUER, GROK_OIDC_CLIENT_ID } from "./agent-account-refresh.ts";
import { grokAuthEntry } from "./agent-account-identity.ts";

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

const XAI_TOKEN_ENDPOINT = `${GROK_OIDC_ISSUER}/oauth2/token`;
const XAI_BASE_URL = "https://api.x.ai/v1";

/**
 * Convert a managed grok `auth.json` (the `"<issuer>::<client>"` keyed map the
 * grok CLI writes) into a CLIProxyAPI `XaiTokenStorage` object plus a filename.
 * Deliberately NO `prefix` field: xAI launch models are always emitted bare —
 * CLIProxyAPI routes them to its xai credentials internally (spec 2026-08-05
 * §B.3), so a routing prefix could only misroute. Throws on invalid shape.
 */
export function grokStorageFromAuthJson(
  authJson: unknown,
  accountId?: string
): { file: string; storage: Record<string, unknown> } {
  const entry = grokAuthEntry(authJson);
  const accessToken = typeof entry?.key === "string" ? entry.key : "";
  const refreshToken = typeof entry?.refresh_token === "string" ? entry.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error("grok auth.json missing tokens");
  }
  const expiresAt = typeof entry?.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  const createdAt = typeof entry?.create_time === "string" ? Date.parse(entry.create_time) : NaN;
  const storage: Record<string, unknown> = {
    type: "xai",
    auth_kind: "oauth",
    base_url: XAI_BASE_URL,
    token_endpoint: XAI_TOKEN_ENDPOINT,
    token_type: "Bearer",
    disabled: false,
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: "",
    email: typeof entry?.email === "string" ? entry.email : "",
    sub: typeof entry?.user_id === "string" ? entry.user_id : "",
    expired: Number.isFinite(expiresAt) ? rfc3339FromMs(expiresAt) : "",
    last_refresh: Number.isFinite(createdAt) ? rfc3339FromMs(createdAt) : "",
    // Access-token lifetime derived from the credential's own stamps (no wall
    // clock — deterministic); xai issues 6 h tokens when neither stamp parses.
    expires_in:
      Number.isFinite(expiresAt) && Number.isFinite(createdAt) && expiresAt > createdAt
        ? Math.round((expiresAt - createdAt) / 1000)
        : 21600
  };
  return { file: `xai-${accountPrefix(accountId)}.json`, storage };
}

/**
 * The reverse conversion, for device-link adoption: a proxy-written
 * `XaiTokenStorage` becomes a grok-CLI-shaped `auth.json` object, so the linked
 * account can also serve managed Grok Build sessions (GROK_HOME). Identity
 * fields the storage lacks (team, names) are omitted — the CLI treats them as
 * optional profile data. Throws when the storage carries no usable token pair.
 */
export function grokAuthJsonFromStorage(storage: unknown): Record<string, unknown> {
  const root = asRecord(storage);
  const accessToken = typeof root.access_token === "string" ? root.access_token : "";
  const refreshToken = typeof root.refresh_token === "string" ? root.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error("xai storage missing tokens");
  }
  const entry: Record<string, unknown> = {
    key: accessToken,
    auth_mode: "oidc",
    refresh_token: refreshToken,
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: GROK_OIDC_CLIENT_ID
  };
  if (typeof root.email === "string" && root.email) entry.email = root.email;
  if (typeof root.sub === "string" && root.sub) entry.user_id = root.sub;
  if (typeof root.expired === "string" && root.expired) entry.expires_at = root.expired;
  if (typeof root.last_refresh === "string" && root.last_refresh) entry.create_time = root.last_refresh;
  return { [`${GROK_OIDC_ISSUER}::${GROK_OIDC_CLIENT_ID}`]: entry };
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
