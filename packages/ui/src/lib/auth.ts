import bcrypt from "bcryptjs";

/**
 * Web auth for the HTTP transport: the daemon stores a bcrypt hash of the
 * password and publishes its salt. The client derives the SAME hash from the
 * typed password + salt and uses it as the bearer — so the plaintext password
 * is never sent nor stored; only the derived hash lives in localStorage.
 */
export function deriveAuthHash(password: string, salt: string): string {
  return bcrypt.hashSync(password, salt);
}

/**
 * The wire credential for the HTTP transport: base64("<username>:<hash>")
 * (HTTP `Authorization: Bearer …` and WS `?token=…`), mirroring HTTP Basic with
 * the derived bcrypt hash standing in for the raw password. The raw password
 * never leaves the client.
 */
export function buildCredential(username: string, hash: string): string {
  return btoa(`${username}:${hash}`);
}

const keyFor = (endpoint: string) => `orquester.auth:${endpoint}`;

export function loadStoredHash(endpoint: string): string | undefined {
  try {
    return localStorage.getItem(keyFor(endpoint)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeHash(endpoint: string, hash: string): void {
  try {
    localStorage.setItem(keyFor(endpoint), hash);
  } catch {
    /* storage unavailable */
  }
}

export function clearStoredHash(endpoint: string): void {
  try {
    localStorage.removeItem(keyFor(endpoint));
  } catch {
    /* storage unavailable */
  }
}

const usernameKeyFor = (endpoint: string) => `orquester.user:${endpoint}`;

export function loadStoredUsername(endpoint: string): string | undefined {
  try {
    return localStorage.getItem(usernameKeyFor(endpoint)) ?? undefined;
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

export function clearStoredUsername(endpoint: string): void {
  try {
    localStorage.removeItem(usernameKeyFor(endpoint));
  } catch {
    /* storage unavailable */
  }
}
