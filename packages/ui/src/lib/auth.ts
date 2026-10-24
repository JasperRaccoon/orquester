import { isAuthTokenShape } from "@orquester/api";

/**
 * Remote sign-in, client side. The password goes to the daemon's login route once (over TLS) and
 * comes back as a session token; only that token is stored, per endpoint. It is revocable on the
 * daemon (Settings → Server), lapses after 30 idle days, and is useless anywhere else. The client
 * never keeps the password or anything derived from it.
 */

/** A stored or configured bearer, if it can be a token at all (an old build's credential cannot). */
export function asSessionToken(value: unknown): string | undefined {
  return isAuthTokenShape(value) ? value : undefined;
}

const tokenKeyFor = (endpoint: string) => `orquester.session:${endpoint}`;
/** Older builds kept a bcrypt hash of the password here: a password-equivalent, so it is purged. */
const legacyHashKeyFor = (endpoint: string) => `orquester.auth:${endpoint}`;

/**
 * The endpoint's stored session token, validated: anything that is not token-shaped is dropped
 * from storage and reads as none. Also purges the endpoint's legacy password-hash entry.
 */
export function loadStoredToken(endpoint: string): string | undefined {
  try {
    localStorage.removeItem(legacyHashKeyFor(endpoint));
    const raw = localStorage.getItem(tokenKeyFor(endpoint));
    const token = asSessionToken(raw);
    if (raw !== null && token === undefined) localStorage.removeItem(tokenKeyFor(endpoint));
    return token;
  } catch {
    return undefined;
  }
}

export function storeToken(endpoint: string, token: string): void {
  try {
    localStorage.setItem(tokenKeyFor(endpoint), token);
  } catch {
    /* storage unavailable */
  }
}

export function clearStoredToken(endpoint: string): void {
  try {
    localStorage.removeItem(tokenKeyFor(endpoint));
    localStorage.removeItem(legacyHashKeyFor(endpoint));
  } catch {
    /* storage unavailable */
  }
}

const usernameKeyFor = (endpoint: string) => `orquester.user:${endpoint}`;

/** The username last signed in with (pre-fills the sign-in form; not a secret). */
export function loadStoredUsername(endpoint: string): string | undefined {
  try {
    const value = localStorage.getItem(usernameKeyFor(endpoint));
    return value && value.length <= 200 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function storeUsername(endpoint: string, username: string): void {
  try {
    localStorage.setItem(usernameKeyFor(endpoint), username);
  } catch {
    /* storage unavailable */
  }
}
