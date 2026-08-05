import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * xAI (Grok) support for the managed proxy: the auth-dir view Orquester DERIVES
 * (CLIProxyAPI owns the tokens and their refresh — nothing here is persisted by
 * us) plus a thin client for the proxy's loopback management API, which drives
 * the RFC 8628 device-code login end to end (no callback, no browser on the box).
 * Kept out of `cliproxy.ts` so the manager only carries wiring.
 */

/** Per-request bound on every management call — the proxy is on loopback, so a
 *  slow answer means it is wedged, not far away. */
const MANAGEMENT_TIMEOUT_MS = 5000;

/** Upstream 429 marker for a spent SuperGrok subscription. CLIProxyAPI then
 *  silently cools that account for 24 h; there is no quota readout to poll. */
const QUOTA_MARKER_RE = /[a-z0-9_.:-]*usage-exhausted/i;

/** Tail of the newest proxy log scanned for the quota marker. */
const LOG_TAIL_BYTES = 64 * 1024;

/** One CLIProxyAPI-owned `auth/xai-*.json`, reduced to the fields the status
 *  shows. Token material is deliberately never read. */
export interface XaiAuthFile {
  file: string;
  email: string | null;
  /** RFC3339 access-token expiry (`expired`), or null when absent/unparseable. */
  expired: string | null;
}

/** The account view derived from the auth dir (no `linking` — that is in-memory
 *  manager state layered on top). */
export interface XaiAccountView {
  state: "none" | "linked" | "expired";
  email: string | null;
  expiredAt: string | null;
}

function isXaiAuthName(name: string): boolean {
  return name.startsWith("xai-") && name.endsWith(".json");
}

/**
 * Read every `xai-*.json` in the proxy's auth dir. Corrupt/unreadable files are
 * skipped rather than thrown: this feeds `status()`, which must never fail
 * because the proxy was mid-write or a file was hand-edited.
 */
export async function scanXaiAuthFiles(authDir: string): Promise<XaiAuthFile[]> {
  let names: string[];
  try {
    names = await readdir(authDir);
  } catch {
    return []; // no auth dir yet — nothing linked
  }
  const out: XaiAuthFile[] = [];
  for (const name of names.filter(isXaiAuthName).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(authDir, name), "utf8"));
    } catch {
      continue; // unreadable/corrupt → as if absent (spec §B.6, fail-closed)
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    // Guard against a non-xai file that happens to be named xai-*.json.
    if (typeof record.type === "string" && record.type !== "xai") continue;
    out.push({
      file: name,
      email: typeof record.email === "string" && record.email ? record.email : null,
      expired: typeof record.expired === "string" && record.expired ? record.expired : null
    });
  }
  return out;
}

/**
 * Derive the account state from the scanned files. `expired` only when EVERY
 * file's `expired` stamp is parseable and in the past — the proxy refreshes with
 * a 5-minute lead, so a persistently past-due stamp means the refresh token is
 * dead and relinking is the recovery. A file whose stamp can't be read counts as
 * live (never demote an account on an unparseable field). The displayed
 * email/expiry come from the file with the LATEST expiry — the freshest identity
 * when several accumulate.
 */
export function deriveXaiAccount(files: readonly XaiAuthFile[], now: number): XaiAccountView {
  if (files.length === 0) return { state: "none", email: null, expiredAt: null };
  let best: { file: XaiAuthFile; at: number } | null = null;
  let allExpired = true;
  for (const file of files) {
    const at = file.expired ? Date.parse(file.expired) : Number.NaN;
    if (!Number.isFinite(at) || at > now) allExpired = false;
    if (Number.isFinite(at) && (best === null || at > best.at)) best = { file, at };
  }
  const chosen = best?.file ?? files[0];
  return {
    state: allExpired ? "expired" : "linked",
    email: chosen.email,
    expiredAt: chosen.expired
  };
}

/** Delete every `xai-*.json` (the unlink). The proxy hot-discovers the removal —
 *  no config change, no restart. Returns how many files were removed. */
export async function removeXaiAuthFiles(authDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(authDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter(isXaiAuthName)) {
    await rm(join(authDir, name), { force: true }).catch(() => undefined);
    removed++;
  }
  return removed;
}

/**
 * Best-effort quota signal: the proxy logs the upstream 429 body, whose marker is
 * `subscription:…-usage-exhausted`. There is NO quota readout anywhere upstream
 * (the management panel's fetch 400s), so this line is the only evidence the
 * account was cooled — reported informationally, never used to gate a launch.
 * Scans only the tail of the newest log file; any I/O problem yields null.
 * Returns only the regex-constrained marker token (e.g.
 * `subscription:heavy-usage-exhausted`), never the raw log line — this string
 * goes onto the wire and into the UI, so it must stay shape-bounded.
 */
export async function scanXaiQuotaError(logsDir: string): Promise<string | null> {
  let newest: { path: string; mtime: number } | null = null;
  try {
    for (const name of await readdir(logsDir)) {
      const path = join(logsDir, name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      if (!newest || st.mtimeMs > newest.mtime) newest = { path, mtime: st.mtimeMs };
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  let tail: string;
  try {
    const handle = await open(newest.path, "r");
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
      if (buf.length === 0) return null;
      await handle.read(buf, 0, buf.length, start);
      tail = buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  // Last match wins — the most recent exhaustion event.
  let found: string | null = null;
  for (const line of tail.split("\n")) {
    const m = QUOTA_MARKER_RE.exec(line);
    if (m) found = m[0];
  }
  return found ? found.slice(0, 100) : null;
}

/** `GET /v0/management/xai-auth-url` — the device-code prompt to show the user. */
export interface XaiAuthUrl {
  url: string;
  userCode: string;
  /** Opaque proxy-side session id; every later call keys on it. */
  state: string;
  /** Seconds the device code stays valid (proxy default: 1800). */
  expiresIn: number;
}

export type XaiAuthPollStatus = { status: "wait" | "ok" | "error"; error?: string };

/** `ok:false` carries the upstream HTTP status when there was one, so the route
 *  can surface a 502 with the real cause (mirrors the router-catalog contract). */
export type XaiManagementResult<T> = { ok: true; value: T } | { ok: false; error: string; status?: number };

/**
 * The proxy's loopback management API. Injected into the manager so tests never
 * touch the network; production uses {@link httpXaiManagementApi}.
 */
export interface XaiManagementApi {
  requestAuthUrl(port: number, secret: string): Promise<XaiManagementResult<XaiAuthUrl>>;
  pollAuthStatus(port: number, secret: string, state: string): Promise<XaiManagementResult<XaiAuthPollStatus>>;
  /** Best-effort abandonment of a device-code session; never throws. */
  cancelSession(port: number, secret: string, state: string): Promise<void>;
}

async function managementFetch(
  port: number,
  secret: string,
  path: string,
  method: "GET" | "DELETE"
): Promise<XaiManagementResult<unknown>> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v0/management${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS)
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `management API responded ${res.status}`, status: res.status };
    }
    return { ok: true, value: await res.json().catch(() => null) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Production management client. Loopback + bearer management secret only. */
export const httpXaiManagementApi: XaiManagementApi = {
  async requestAuthUrl(port, secret) {
    const res = await managementFetch(port, secret, "/xai-auth-url", "GET");
    if (!res.ok) return res;
    const body = (res.value ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url : "";
    const userCode = typeof body.user_code === "string" ? body.user_code : "";
    const state = typeof body.state === "string" ? body.state : "";
    if (!url || !state) return { ok: false, error: "management API returned no device-code prompt" };
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 1800;
    return { ok: true, value: { url, userCode, state, expiresIn } };
  },
  async pollAuthStatus(port, secret, state) {
    const res = await managementFetch(
      port,
      secret,
      `/get-auth-status?state=${encodeURIComponent(state)}`,
      "GET"
    );
    if (!res.ok) return res;
    const body = (res.value ?? {}) as Record<string, unknown>;
    const status = typeof body.status === "string" ? body.status : "";
    const error = typeof body.error === "string" && body.error ? body.error : undefined;
    if (status === "ok" || status === "error") return { ok: true, value: { status, ...(error ? { error } : {}) } };
    // Anything unrecognized keeps the flow waiting; the expiry bound ends it.
    return { ok: true, value: { status: "wait" } };
  },
  async cancelSession(port, secret, state) {
    await managementFetch(port, secret, `/oauth-session?state=${encodeURIComponent(state)}`, "DELETE");
  }
};
