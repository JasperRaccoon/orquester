// Remote transport auth: revocable login sessions and API tokens.
//
// A password login (`authRoutes.login`) mints a random session token; the daemon keeps only its
// SHA-256 digest (`auth-sessions.json`, `@orquester/config`). Every remote bearer check — the HTTP
// `Authorization: Bearer`, `?token=` on `/ws`, the other WebSocket routes and the file download,
// and `/mcp` — accepts a live session or API token and nothing else. The unix socket needs none.

/** `device`: a password login with a sliding idle expiry. `api`: a named token that lasts until revoked. */
export type AuthSessionKind = "device" | "api";

/** Every token the daemon mints starts with this. */
export const AUTH_TOKEN_PREFIX = "orq_";

/** `orq_` + 32 random bytes as unpadded base64url. */
const AUTH_TOKEN_PATTERN = /^orq_[A-Za-z0-9_-]{43}$/;

/**
 * Whether `value` has the shape of a token the daemon mints. Shape only: whether it is live is the
 * daemon's call. Clients use it to drop stored values that cannot be one (an old build's
 * credential, a corrupt entry) before sending them.
 */
export function isAuthTokenShape(value: unknown): value is string {
  return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value);
}

/** A device login or API token as the management routes list it. Never carries the token. */
export interface AuthSessionSummary {
  id: string;
  /** The device (from its user agent) or the name given to an API token. */
  label: string;
  kind: AuthSessionKind;
  createdAt: string;
  lastUsedAt: string;
  /** Device sessions: when they lapse unless used again. `null` for API tokens. */
  expiresAt: string | null;
  /** The session this request authenticated with ("this device"). */
  current: boolean;
}

/** POST {@link authRoutes.login}: public, throttled per IP. */
export interface AuthLoginRequest {
  /** Required when `requiresUsername`; compared trimmed and lowercased. */
  username?: string;
  password: string;
  /** Optional device label; the daemon falls back to the request's user agent. */
  label?: string;
}

/** The token is shown once: the daemon keeps only its digest. */
export interface AuthIssuedTokenResponse {
  token: string;
  session: AuthSessionSummary;
}

export interface AuthSessionsResponse {
  sessions: AuthSessionSummary[];
}

/** POST {@link authRoutes.tokens}. */
export interface CreateApiTokenRequest {
  label: string;
}

export interface RevokeAuthSessionsResponse {
  revoked: number;
}

/** POST {@link authRoutes.verifyPassword}. */
export interface VerifyPasswordRequest {
  password: string;
}

export interface VerifyPasswordResponse {
  ok: boolean;
}

/** Longest label a session or API token keeps. */
export const AUTH_SESSION_LABEL_MAX = 120;

export const authRoutes = {
  /** GET → `AuthInfoResponse`. Public. */
  info: "/api/auth/info",
  /** POST {@link AuthLoginRequest} → {@link AuthIssuedTokenResponse}. Public, throttled per IP. */
  login: "/api/auth/login",
  /** POST → 204. Revokes the session the request authenticated with. */
  logout: "/api/auth/logout",
  /**
   * POST {@link VerifyPasswordRequest} → {@link VerifyPasswordResponse}. Retype-the-password gates
   * (the archived-data curtain); throttled per IP like a login.
   */
  verifyPassword: "/api/auth/verify-password",
  /** GET → {@link AuthSessionsResponse}. */
  sessions: "/api/auth/sessions",
  /** POST → {@link RevokeAuthSessionsResponse}. Revokes every session and API token but the current one. */
  revokeOthers: "/api/auth/sessions/revoke-others",
  /** POST {@link CreateApiTokenRequest} → {@link AuthIssuedTokenResponse}. */
  tokens: "/api/auth/tokens"
} as const;

/** DELETE → 204. Revokes one session or API token. */
export function authSessionPath(id: string): string {
  return `${authRoutes.sessions}/${encodeURIComponent(id)}`;
}
