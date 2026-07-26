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
 * Client-side check for the "Protect archived data" curtain: does the typed
 * password match the per-endpoint stored credential hash? A bcrypt hash embeds
 * its own salt, so this is a pure offline compare — nothing crosses the wire
 * and the plaintext never leaves this call.
 */
export function verifyLocalPassword(password: string, storedHash: string): boolean {
  try {
    return bcrypt.compareSync(password, storedHash);
  } catch {
    return false;
  }
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

/**
 * Pull the bcrypt hash back out of a wire credential (base64("<user>:<hash>")).
 * The in-memory credential is the authoritative copy — localStorage is only a
 * cache of it (writes are swallowed when storage is unavailable, and a seeded
 * remote carries its credential in remotes.json instead). Used as the fallback
 * source for the offline `verifyLocalPassword` compare so the archived-data
 * curtain still works — and still fails closed when there is no credential.
 */
export function hashFromCredential(credential: string | undefined): string | undefined {
  if (!credential) {
    return undefined;
  }
  try {
    const decoded = atob(credential);
    const separator = decoded.indexOf(":");
    const hash = separator >= 0 ? decoded.slice(separator + 1) : "";
    // bcrypt hashes start with $2a/$2b/$2y — anything else isn't comparable.
    return hash.startsWith("$2") ? hash : undefined;
  } catch {
    return undefined;
  }
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
