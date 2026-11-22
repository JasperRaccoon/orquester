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

/**
 * POST {@link authRoutes.tokens}. On the remote transport the caller re-proves the owner: `password`
 * always, and `code` too while the second factor is on (a wrong one → 403 `INVALID_PROOF`). Over the
 * unix socket neither is needed.
 */
export interface CreateApiTokenRequest extends AuthSecondFactorProof {
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

// ---------------------------------------------------------------------------
// Second factor: authenticator (TOTP) codes + one-time recovery codes
// ---------------------------------------------------------------------------
//
// Design: docs/superpowers/specs/2026-11-22-login-second-factor-design.md.
//
// - With the factor on, a correct password at `login` answers an {@link AuthSecondFactorChallenge}
//   instead of a token; `secondFactorLogin` trades the challenge plus a `code` for the token.
// - Wherever a `code` is accepted it is EITHER a 6-digit authenticator code OR an unused recovery
//   code (`xxxxx-xxxxx`; case, spaces and dashes are ignored). A recovery code is used up.
// - Management routes are bearer-gated. On the remote transport they need the owner's proof
//   ({@link AuthSecondFactorProof}); over the unix socket none. A wrong proof answers 403
//   `INVALID_PROOF` (never 401: the caller's session is still good) with `field` naming it.

/** `login`'s answer while the second factor is on and the password was right. */
export interface AuthSecondFactorChallenge {
  secondFactorRequired: true;
  /** Opaque, single use; pass it to `secondFactorLogin`. */
  challenge: string;
  /** ISO time after which the challenge is refused (`CHALLENGE_EXPIRED`). */
  expiresAt: string;
}

/** POST {@link authRoutes.login} answers one of these. */
export type AuthLoginResponse = AuthIssuedTokenResponse | AuthSecondFactorChallenge;

export function isSecondFactorChallenge(value: unknown): value is AuthSecondFactorChallenge {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { secondFactorRequired?: unknown }).secondFactorRequired === true &&
    typeof (value as { challenge?: unknown }).challenge === "string" &&
    typeof (value as { expiresAt?: unknown }).expiresAt === "string"
  );
}

/** POST {@link authRoutes.secondFactorLogin}: public, throttled. */
export interface AuthSecondFactorLoginRequest {
  challenge: string;
  /** An authenticator code or a recovery code. */
  code: string;
  /** Optional device label; the daemon falls back to the request's user agent. */
  label?: string;
}

/** What a remote caller sends to re-prove it is the owner. Ignored over the unix socket. */
export interface AuthSecondFactorProof {
  password?: string;
  /** Required while the second factor is on. */
  code?: string;
}

/** A correct password followed by a wrong code: the password has leaked. */
export interface AuthSecondFactorFailedChallenge {
  /** ISO time of the latest such attempt. */
  at: string;
  /** Client IP it came from. */
  ip: string;
}

/** GET {@link authRoutes.secondFactor}. Never carries the secret or the recovery codes. */
export interface AuthSecondFactorStatusResponse {
  enabled: boolean;
  /** ISO time it was turned on; `null` while off. */
  enabledAt: string | null;
  /** Unused recovery codes; 0 while off. */
  recoveryCodesRemaining: number;
  /**
   * The second-factor file exists but cannot be read or parsed: the factor counts as ON and no
   * password login can finish until it is fixed or reset (`deploy.sh reset-2fa`). `enabled` is true.
   */
  unavailable: boolean;
  /** Latest correct-password-wrong-code attempt, until dismissed; `null` when none. */
  lastFailedChallenge: AuthSecondFactorFailedChallenge | null;
}

/** POST {@link authRoutes.secondFactorSetup}: needs `password` remotely; 409 `SECOND_FACTOR_ENABLED` when already on. */
export interface AuthSecondFactorSetupRequest {
  password?: string;
}

/** A pending enrollment for the caller, held in daemon memory until `expiresAt`. */
export interface AuthSecondFactorSetupResponse {
  /** RFC 4648 base32, no padding: for typing into an authenticator by hand. */
  secret: string;
  /** `otpauth://totp/...`: what the QR code encodes. */
  otpauthUri: string;
  expiresAt: string;
}

/**
 * POST {@link authRoutes.secondFactorEnable}: a code from the PENDING secret. 409
 * `NO_PENDING_SETUP` when the caller has none (expired, or never started); 403 `INVALID_PROOF`
 * (`field: "code"`) when the code is wrong. Turning on revokes every other device session.
 */
export interface AuthSecondFactorEnableRequest {
  code: string;
}

/** The new recovery codes, shown once (the daemon keeps only digests). */
export interface AuthRecoveryCodesResponse {
  recoveryCodes: string[];
}

/** Error `code`s the auth routes answer (in the JSON body's `code`). */
export const authErrorCodes = {
  invalidCredentials: "INVALID_CREDENTIALS",
  tooManyAttempts: "TOO_MANY_ATTEMPTS",
  /** `secondFactorLogin`: wrong code (the challenge may still be retried). 401. */
  invalidCode: "INVALID_CODE",
  /** `secondFactorLogin`: unknown, expired, used or exhausted challenge — start over with the password. 401. */
  challengeExpired: "CHALLENGE_EXPIRED",
  /** The second-factor file is unreadable: password logins cannot finish. 503. */
  secondFactorUnavailable: "SECOND_FACTOR_UNAVAILABLE",
  /** A management route's password or code is missing or wrong. 403, with `field`. */
  invalidProof: "INVALID_PROOF",
  secondFactorEnabled: "SECOND_FACTOR_ENABLED",
  secondFactorDisabled: "SECOND_FACTOR_DISABLED",
  noPendingSetup: "NO_PENDING_SETUP"
} as const;

/** Longest label a session or API token keeps. */
export const AUTH_SESSION_LABEL_MAX = 120;

export const authRoutes = {
  /** GET → `AuthInfoResponse`. Public. */
  info: "/api/auth/info",
  /**
   * POST {@link AuthLoginRequest} → {@link AuthLoginResponse}: a token, or a second-factor
   * challenge while the factor is on. Public, throttled per IP.
   */
  login: "/api/auth/login",
  /** POST {@link AuthSecondFactorLoginRequest} → {@link AuthIssuedTokenResponse}. Public, throttled. */
  secondFactorLogin: "/api/auth/login/second-factor",
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
  tokens: "/api/auth/tokens",
  /** GET → {@link AuthSecondFactorStatusResponse}. */
  secondFactor: "/api/auth/second-factor",
  /** POST {@link AuthSecondFactorSetupRequest} → {@link AuthSecondFactorSetupResponse}. */
  secondFactorSetup: "/api/auth/second-factor/setup",
  /** POST {@link AuthSecondFactorEnableRequest} → {@link AuthRecoveryCodesResponse}. */
  secondFactorEnable: "/api/auth/second-factor/enable",
  /** POST {@link AuthSecondFactorProof} → {@link AuthRecoveryCodesResponse}; the old codes stop working. */
  secondFactorRecoveryCodes: "/api/auth/second-factor/recovery-codes",
  /** POST {@link AuthSecondFactorProof} → 204. 409 `SECOND_FACTOR_DISABLED` when already off. */
  secondFactorDisable: "/api/auth/second-factor/disable",
  /** POST → 204. Clears `lastFailedChallenge`. */
  secondFactorDismissAlert: "/api/auth/second-factor/dismiss-alert"
} as const;

/** DELETE → 204. Revokes one session or API token. */
export function authSessionPath(id: string): string {
  return `${authRoutes.sessions}/${encodeURIComponent(id)}`;
}
