# Remote Phase 1 — Daemon Hardening, Username Auth, Client Changes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the daemon's public HTTP transport for the remote-VPS deployment and add a username to the credential. The bearer/WS token becomes `base64("<username>:<bcryptHash>")`, verified in constant time with no username enumeration and no early return. Add a per-IP login throttle, a filesystem sandbox for the `/api/fs/*` browser API, remove the wildcard CORS, raise the bcrypt cost, trim public info disclosure, and carry the combined credential through the web client. Seed the VPS as a default remote on the desktop app while keeping its bundled local daemon.

**Architecture:** Phase 1 of the remote-VPS design (`docs/superpowers/specs/2026-06-19-remote-vps-deployment-design.md`, §1.1–1.9 + Security model). The HTTP transport already exists (`createServer(..., { authRequired: true, mode: "remote", serveWeb })`) with a bcrypt-hash bearer and a `/ws?token=` handshake. This plan adds a `username` to `transports.http`, replaces the single-string bearer comparison with a `decodeCredential` + dual constant-time check applied to **both** the `onRequest` hook and the `/ws` handshake, sandboxes the FS API to a configurable `fsRoot` (default = workspaces dir), and threads the combined credential through `lib/auth.ts` → `AuthModal` → `store/app.ts` → the HTTP + WS transporters.

**Tech Stack:** TypeScript, Fastify (daemon), node `crypto` (`timingSafeEqual` + `createHash`), `bcryptjs`, Zod (config), React 18 + Zustand (web), Electron (desktop).

## Global Constraints

- **No test runner exists.** Verification is `pnpm check` (workspace typecheck, = `pnpm -r typecheck`) + runtime `curl`/Playwright checks. Do NOT add a test framework.
- **Ops-only items are out of scope here:** `fail2ban`, the Caddy CSP/Permissions-Policy/security headers, `unattended-upgrades`, TLS, and the systemd unit live in Phase 0 / the Caddyfile, not in this code. This plan implements only the §1.9 items that are daemon/client code: CORS removal, bcrypt cost 12, `/health` trim, in-daemon throttle, log redaction.
- **No invented APIs.** Modify the real code quoted below; match its comment density and naming (terse `//` rationale comments, JSDoc on exported/helper functions).
- **The credential is never reversible to the password.** The raw password is hashed client-side (`deriveAuthHash`) before it ever leaves the form; only the derived hash + plain username are persisted in `localStorage`, and the wire credential is `base64("<username>:<hash>")`.
- **`normalize` = `trim().toLowerCase()`** for usernames, applied identically on the config side (when storing `expectedUsername`) and the request side (when decoding the supplied username).
- **Constant-time, no early return:** compute `userOk` AND `passOk` (both via `timingSafeEqual` over fixed-length `sha256` digests) before deciding, then emit a single identical 401 for every failure mode (wrong username, wrong password, wrong length, malformed credential, missing header).
- **The unix-socket `mode: "local"` path stays unauthenticated** (`authRequired: false`); it is not network-exposed. Throttle + redaction apply only to the remote HTTP transport.
- The dev daemon (`pnpm dev:daemon`, `ORQUESTER_APPDIR=./.stage`) runs on `127.0.0.1:47831` via `tsx watch` and hot-reloads on save. Its `.stage/daemon/daemon.json` has `passwordHash = $2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe` (the bcrypt of password `123456`; salt prefix `$2b$10$d/t5uzBqvZnjBASDICtJue`). It has **no `username`** configured yet, so the default `"mapacho"` applies after Task 1.
- **Curl bearer is now base64.** Build it once per shell:
  ```bash
  HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # bcrypt of "123456"
  TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')             # GNU: base64 -w0
  ```
  `$TOKEN` then goes in `Authorization: Bearer $TOKEN` and `?token=$TOKEN`.

---

### Task 1: Config — `username` + `fsRoot` on `transports.http`

**Files:**
- Modify: `packages/config/src/index.ts` (`httpTransportSchema` ~lines 113-121; `createDefaultDaemonConfig` ~lines 172-190)

**Interfaces:**
- Produces: `HttpTransportConfig.username: string` (default `"mapacho"`, env override `ORQUESTER_HTTP_USERNAME`, stored `trim().toLowerCase()`); `HttpTransportConfig.fsRoot?: string` (optional; default resolved to `workspacesDir` in the daemon, Task 5).
- Consumed by: the auth hook + `/ws` (Task 2), `/api/auth/info` (Task 3), FS sandbox (Task 5).

- [ ] **Step 1: Add `username` + `fsRoot` to `httpTransportSchema`** — replace the schema (lines 113-121) with:

```ts
export const httpTransportSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().min(1).default(DEFAULT_HTTP_HOST),
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
  /**
   * The username half of the credential. The wire bearer is
   * base64("<username>:<passwordHash>"); the server compares this (normalized:
   * trim + lowercase) in constant time. Defaults to "mapacho".
   */
  username: z
    .string()
    .min(1)
    .transform((value) => value.trim().toLowerCase())
    .default("mapacho"),
  /** Transient plaintext input (env / settings). Migrated to `passwordHash`. */
  password: z.string().min(8).optional(),
  /** bcrypt hash of the password — what's persisted at rest. */
  passwordHash: z.string().optional(),
  /**
   * Filesystem-browser sandbox root: `/api/fs/*` rejects paths whose realpath
   * is outside this dir. Optional here; the daemon defaults it to the resolved
   * workspaces dir when unset (see resolved.fsRoot).
   */
  fsRoot: z.string().min(1).optional()
});
```

- [ ] **Step 2: Seed `username` from env in `createDefaultDaemonConfig`** — in the `transports.http` object (lines 182-187), add the `username` line so `ORQUESTER_HTTP_USERNAME` is honored (the schema lowercases/trims it and falls back to `"mapacho"` when the env var is unset):

```ts
    transports: {
      http: {
        enabled: env.ORQUESTER_HTTP_ENABLED === "true",
        host: env.ORQUESTER_HTTP_HOST ?? DEFAULT_HTTP_HOST,
        port: env.ORQUESTER_HTTP_PORT ?? String(DEFAULT_HTTP_PORT),
        username: env.ORQUESTER_HTTP_USERNAME,
        password: env.ORQUESTER_HTTP_PASSWORD
      }
    }
```

(Passing `undefined` when the env var is unset lets the schema apply its `"mapacho"` default. `fsRoot` is intentionally not seeded here — it stays `undefined` unless explicitly set in `daemon.json`, and the daemon resolves it at runtime.)

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `@orquester/config` compiles cleanly. The rest of the workspace also still passes (the new fields are additive: `username` is defaulted, `fsRoot` is optional). PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): add transports.http.username + fsRoot"
```

---

### Task 2: Daemon — credential decode + dual constant-time auth (hook + /ws)

**Files:**
- Modify: `apps/daemon/src/index.ts` (crypto import ~line 56; auth hook ~lines 265-273; `/ws` handshake ~lines 691-698; helpers near `safeEqual` ~lines 902-907)

**Interfaces:**
- Consumes: `config.transports.http.username` + `.passwordHash` (Task 1).
- Produces: `decodeCredential(token)` → `{ user, hash }`; `authorizeCredential(token, expectedUsername, expectedHash)` → `boolean` (constant-time, no early return). Applied to both the HTTP `onRequest` hook and the `/ws` handshake.
- The on-the-wire credential format is now `base64("<username>:<bcryptHash>")` for `Authorization: Bearer …` AND `?token=…`. **Breaks the existing single-string bearer** — `pnpm check` stays green (types unchanged) but runtime auth with the old plain-hash bearer will now 401 until the client (Task 7) sends the combined credential. Curl checks in this task use the new base64 form.

- [ ] **Step 1: Add `createHash` to the crypto import** — replace line 56:

```ts
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
```

- [ ] **Step 2: Add `decodeCredential` + `authorizeCredential` helpers** — insert immediately after `safeEqual` (after line 907, before `migrateHttpPassword`):

```ts
/**
 * Decode a credential bearer/token of the form base64("<username>:<hash>").
 * Splits on the FIRST ":" (a bcrypt hash contains no ":", but be defensive).
 * Returns empty strings when the input is missing or not valid base64 — the
 * caller still runs the full constant-time check so a malformed credential is
 * indistinguishable from a wrong one.
 */
function decodeCredential(token: string | undefined): { user: string; hash: string } {
  if (!token) {
    return { user: "", hash: "" };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch {
    return { user: "", hash: "" };
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    return { user: "", hash: "" };
  }
  return { user: decoded.slice(0, sep), hash: decoded.slice(sep + 1) };
}

/** Normalize a username for comparison (matches the config-side transform). */
function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Fixed-length sha256 digest so timingSafeEqual gets equal-length buffers. */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time credential check with NO early return: both the username and
 * the password-hash comparisons are always computed, so wrong-username,
 * wrong-length and wrong-password are indistinguishable (no enumeration).
 */
function authorizeCredential(
  token: string | undefined,
  expectedUsername: string,
  expectedHash: string | undefined
): boolean {
  if (!expectedHash) {
    return false;
  }
  const { user, hash } = decodeCredential(token);
  const userOk = timingSafeEqual(sha256(normalizeUsername(user)), sha256(expectedUsername));
  const passOk = timingSafeEqual(sha256(hash), sha256(expectedHash));
  return userOk && passOk;
}
```

(`expectedUsername` is already normalized by the config schema, Task 1; `normalizeUsername` here mirrors it for the supplied value. `safeEqual` stays — `decodeCredential`/`authorizeCredential` supersede it for auth, but it remains used nowhere else; leave it in place, it is small and harmless.)

- [ ] **Step 3: Use `authorizeCredential` in the `onRequest` hook** — replace the auth block (lines 265-273) with:

```ts
    const authorized = authorizeCredential(
      request.headers.authorization?.replace(/^Bearer\s+/i, ""),
      config.transports.http.username,
      config.transports.http.passwordHash
    );
    if (!authorized) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required for this daemon transport."
      });
    }
```

- [ ] **Step 4: Use `authorizeCredential` in the `/ws` handshake** — replace the auth block inside `instance.get("/ws", ...)` (lines 691-698) with:

```ts
      if (options.authRequired) {
        const token = (request.query as { token?: string }).token;
        if (!authorizeCredential(token, config.transports.http.username, config.transports.http.passwordHash)) {
          socket.close(1008, "unauthorized");
          return;
        }
      }
```

- [ ] **Step 5: Typecheck**

Run: `pnpm check`
Expected: `apps/daemon` compiles cleanly (helpers + call sites are type-correct). PASS for the whole workspace (UI is untouched so far).

- [ ] **Step 6: Runtime verify — identical 401 for wrong username AND wrong password** (dev daemon hot-reloads; it has no `username` in `.stage/daemon/daemon.json`, so the default `"mapacho"` applies):

```bash
HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'   # bcrypt of "123456"
GOOD=$(printf 'mapacho:%s'   "$HASH" | base64 | tr -d '\n')
BADUSER=$(printf 'wronguser:%s' "$HASH" | base64 | tr -d '\n')
BADPASS=$(printf 'mapacho:%s' '$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | base64 | tr -d '\n')

# correct credential → 200
curl -sS -o /dev/null -w "good:    %{http_code}\n" -H "Authorization: Bearer $GOOD"    http://127.0.0.1:47831/api/workspaces
# wrong username → 401 (identical body to wrong password)
curl -sS         -w "\nbadUser: %{http_code}\n"    -H "Authorization: Bearer $BADUSER" http://127.0.0.1:47831/api/workspaces
# wrong password → 401 (identical body)
curl -sS         -w "\nbadPass: %{http_code}\n"    -H "Authorization: Bearer $BADPASS" http://127.0.0.1:47831/api/workspaces
# missing/garbage bearer → 401 (identical body)
curl -sS         -w "\nnoAuth:  %{http_code}\n"                                        http://127.0.0.1:47831/api/workspaces
```
Expected: `good: 200`; `badUser`, `badPass`, and `noAuth` all return `401` with the **identical** JSON body `{"code":"UNAUTHORIZED","message":"A valid bearer token is required for this daemon transport."}`. (The point: wrong username is indistinguishable from wrong password.)

- [ ] **Step 7: Runtime verify — /ws handshake honors the combined token**

```bash
# good token → server keeps the socket open (no immediate 1008 close).
npx -y wscat -c "ws://127.0.0.1:47831/ws?token=$GOOD" --wait 1 --close 2>&1 | head -5 || \
  echo "(no wscat — skip; the curl checks above already prove authorizeCredential)"
# bad-username token → closed with 1008 unauthorized.
npx -y wscat -c "ws://127.0.0.1:47831/ws?token=$BADUSER" 2>&1 | head -5 || true
```
Expected: the good token connects (open); the bad-username token is rejected (closed `1008`). If `wscat` is unavailable, the Step 6 curl checks plus the shared `authorizeCredential` helper are sufficient evidence — note that and move on.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): username+password credential, constant-time no-enumeration auth"
```

---

### Task 3: Daemon + API — `requiresUsername` on `/api/auth/info` (never echo the username)

**Files:**
- Modify: `packages/api/src/index.ts` (`AuthInfoResponse` ~lines 96-100)
- Modify: `apps/daemon/src/index.ts` (`/api/auth/info` handler ~lines 278-283)

**Interfaces:**
- Produces: `AuthInfoResponse.requiresUsername: boolean` — a UI hint that is `true` exactly when auth is required (a username is always configured for the remote transport). **The username string is never returned by any endpoint.**
- Consumed by: `store/app.ts` `establish` (Task 7).

- [ ] **Step 1: Add `requiresUsername` to `AuthInfoResponse`** — replace the interface (lines 95-100):

```ts
/** Public auth metadata for the HTTP transport (no secrets). */
export interface AuthInfoResponse {
  authRequired: boolean;
  /** bcrypt salt prefix the client uses to derive the bearer hash, or null. */
  salt: string | null;
  /**
   * Whether the credential also needs a username (UI hint; shows the username
   * field). True when auth is required. The username itself is never returned.
   */
  requiresUsername: boolean;
}
```

- [ ] **Step 2: Populate `requiresUsername` in the daemon handler** — replace `/api/auth/info` (lines 278-283):

```ts
  // Public: tells the web client whether auth is needed and the bcrypt salt to
  // derive the bearer (the same hash the daemon stores). Never exposes the hash
  // OR the username — only whether a username is required.
  app.get("/api/auth/info", async () => {
    const authRequired = options.mode === "remote" && Boolean(config.transports.http.passwordHash);
    return {
      authRequired,
      salt: config.transports.http.passwordHash
        ? config.transports.http.passwordHash.slice(0, 29)
        : null,
      requiresUsername: authRequired
    };
  });
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `@orquester/api` + `apps/daemon` compile. `packages/ui` (`api-client.ts` returns `AuthInfoResponse`) still compiles because the new field is additive and consumers don't yet read it. PASS.

- [ ] **Step 4: Runtime verify — auth-info shape, username NOT present**

```bash
curl -sS http://127.0.0.1:47831/api/auth/info; echo
```
Expected: `{"authRequired":true,"salt":"$2b$10$d/t5uzBqvZnjBASDICtJue","requiresUsername":true}` — note `salt` is exactly 29 chars and there is **no** `username`/`user` key anywhere in the JSON.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/index.ts apps/daemon/src/index.ts
git commit -m "feat(daemon/api): auth/info exposes requiresUsername (never the username)"
```

---

### Task 4: Daemon — per-IP login throttle + token log redaction

**Files:**
- Modify: `apps/daemon/src/index.ts` (Fastify construction ~lines 234-236; `onRequest` hook ~line 238; helpers section ~after line 990)

**Interfaces:**
- Produces: an in-daemon `LoginThrottle` (per-IP failed-attempt counter with escalating lockout: 5 fails → 15 min) keyed on `X-Forwarded-For` (Caddy's client IP; trusted for the IP only, never for auth). A 401 records a failure; a 200/authorized request clears the IP. A locked IP gets `429` before the credential is even checked.
- Produces: request-log redaction of the `token` query param (it lands in Fastify's request log otherwise).
- Scope: applies only to the remote HTTP transport (`options.authRequired`).

- [ ] **Step 1: Add a `LoginThrottle` class** — insert in the helpers area near the bottom of the file (after `isNodeError`, after line 990):

```ts
/**
 * Per-IP failed-login throttle with escalating lockout. Single-user, so real
 * failures are rare: 5 fails within the window → locked out, with the lockout
 * doubling on each subsequent breach (15 min, 30, 60 … capped). Keyed on the
 * proxy-supplied client IP (X-Forwarded-For); this is defense-in-depth on top
 * of fail2ban (OS-layer ban on the daemon's 401 log lines, Phase 0).
 */
class LoginThrottle {
  private readonly state = new Map<string, { fails: number; lockedUntil: number; strikes: number }>();
  private static readonly MAX_FAILS = 5;
  private static readonly BASE_LOCKOUT_MS = 15 * 60 * 1000;
  private static readonly MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;

  /** Ms remaining on an active lockout for this IP, or 0 if not locked. */
  retryAfterMs(ip: string): number {
    const entry = this.state.get(ip);
    if (!entry || entry.lockedUntil <= Date.now()) {
      return 0;
    }
    return entry.lockedUntil - Date.now();
  }

  /** Record a failed attempt; locks the IP once MAX_FAILS is reached. */
  recordFailure(ip: string): void {
    const entry = this.state.get(ip) ?? { fails: 0, lockedUntil: 0, strikes: 0 };
    entry.fails += 1;
    if (entry.fails >= LoginThrottle.MAX_FAILS) {
      const lockout = Math.min(
        LoginThrottle.BASE_LOCKOUT_MS * 2 ** entry.strikes,
        LoginThrottle.MAX_LOCKOUT_MS
      );
      entry.lockedUntil = Date.now() + lockout;
      entry.strikes += 1;
      entry.fails = 0;
    }
    this.state.set(ip, entry);
  }

  /** Clear an IP's failure count after a successful auth. */
  recordSuccess(ip: string): void {
    this.state.delete(ip);
  }
}

/** Client IP from Caddy's X-Forwarded-For (first hop), falling back to the socket. */
function clientIp(request: { headers: Record<string, unknown>; ip: string }): string {
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",")[0]!.trim();
  }
  return request.ip;
}
```

- [ ] **Step 2: Redact the `token` query param from request logs** — replace the Fastify construction (lines 234-236) with a serializer that strips `?token=…` from the logged URL:

```ts
  const app = Fastify({
    logger: {
      level: "info",
      stream: logStream,
      serializers: {
        // Strip the WS `?token=` from request logs (TLS protects it on the wire,
        // but it must never land in plaintext logs). Other query params are kept.
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url.replace(/([?&]token=)[^&]*/i, "$1[redacted]") };
        }
      }
    }
  });

  const throttle = new LoginThrottle();
```

- [ ] **Step 3: Enforce + record the throttle in the `onRequest` hook** — in the auth block from Task 2 Step 3, wrap the credential check with the lockout gate and the failure/success recording. Replace that block with:

```ts
    const ip = clientIp(request);
    const retryAfterMs = throttle.retryAfterMs(ip);
    if (retryAfterMs > 0) {
      reply.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      return reply.code(429).send({
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many failed login attempts. Try again later."
      });
    }

    const authorized = authorizeCredential(
      request.headers.authorization?.replace(/^Bearer\s+/i, ""),
      config.transports.http.username,
      config.transports.http.passwordHash
    );
    if (!authorized) {
      throttle.recordFailure(ip);
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required for this daemon transport."
      });
    }
    throttle.recordSuccess(ip);
```

(The `/ws` handshake is not throttled here — it shares the same credential and is reached only after the SPA loaded over the gated `/api`; a WS lockout would also need its own IP plumbing through the websocket plugin, which is out of scope for Phase 1. fail2ban covers the OS layer.)

- [ ] **Step 4: Typecheck**

Run: `pnpm check`
Expected: `apps/daemon` compiles (the `req` serializer + `clientIp` arg types line up with what Fastify passes). PASS.

- [ ] **Step 5: Runtime verify — lockout after repeated failures + log redaction**

> Note: this trips a 15-minute lockout for `127.0.0.1` on the dev daemon. Restart it afterward to clear (`Ctrl-C` the `pnpm dev:daemon` and re-run), since the throttle is in-memory.

```bash
HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'
BADPASS=$(printf 'mapacho:%s' '$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | base64 | tr -d '\n')
GOOD=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')
# 5 bad attempts → each 401; the 6th is 429 (locked).
for i in 1 2 3 4 5 6; do
  curl -sS -o /dev/null -w "attempt $i: %{http_code}\n" -H "Authorization: Bearer $BADPASS" http://127.0.0.1:47831/api/workspaces
done
# even a GOOD credential is now refused while locked → 429.
curl -sS -o /dev/null -w "good-while-locked: %{http_code}\n" -H "Authorization: Bearer $GOOD" http://127.0.0.1:47831/api/workspaces
```
Expected: attempts 1–5 print `401`, attempt 6 prints `429`, and `good-while-locked: 429`.

```bash
# Log redaction: hit /ws with a token, then confirm the day's log shows [redacted].
curl -sS -o /dev/null "http://127.0.0.1:47831/ws?token=$GOOD" || true
grep -h "token=" .stage/daemon/logs/*.log | tail -2
```
Expected: the logged line shows `"url":".../ws?token=[redacted]"` — the raw base64 token does not appear.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): per-IP login throttle + token query-param log redaction"
```

---

### Task 5: Daemon — FS sandbox (`/api/fs*` realpath-prefix check against `fsRoot`)

**Files:**
- Modify: `apps/daemon/src/index.ts` (`ResolvedPaths` ~lines 63-72; `resolved` build ~lines 106-114; the four `/api/fs` routes ~lines 451-532; helpers ~near `listFiles` line 846)

**Interfaces:**
- Consumes: `config.transports.http.fsRoot` (Task 1) — when unset, defaults to `resolved.workspacesDir`.
- Produces: `resolved.fsRoot: string`; an `assertInsideFsRoot(path)` guard that resolves the request path to a realpath and rejects (403) anything outside `fsRoot`. Applied to `GET /api/fs`, `GET /api/fs/read`, `PUT /api/fs/write`, `POST /api/fs/create`.
- **Documented caveat (matches spec §1.6):** a terminal is a real shell and can `cd` anywhere; the sandbox constrains only the file-browser API.

- [ ] **Step 1: Import `realpath`** — extend the `node:fs/promises` import (line 52). Replace it with:

```ts
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
```

- [ ] **Step 2: Add `fsRoot` to `ResolvedPaths`** — in the interface (lines 63-72) add the field after `workspacesDir`:

```ts
interface ResolvedPaths {
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  workspacesDir: string;
  /** Sandbox root for the /api/fs browser API (default = workspacesDir). */
  fsRoot: string;
  logsDir: string;
  vars: ConfigVars;
}
```

- [ ] **Step 3: Resolve `fsRoot` when building `resolved`** — in the `resolved` object (lines 106-114) add the `fsRoot` line (expand `$vars`, default to the workspaces dir):

```ts
  const resolved: ResolvedPaths = {
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    fsRoot: config.transports.http.fsRoot
      ? expandVars(config.transports.http.fsRoot, paths.vars)
      : expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars),
    vars: paths.vars
  };
```

(Keep `fsRoot` in sync with `workspacesDir` in the live-reload path: in the `PUT /api/config/daemon` handler, right after `resolved.workspacesDir = expandVars(merged.workspacesDir, resolved.vars);` at line 364, add: `resolved.fsRoot = merged.transports.http.fsRoot ? expandVars(merged.transports.http.fsRoot, resolved.vars) : resolved.workspacesDir;`)

- [ ] **Step 4: Add the `assertInsideFsRoot` guard** — insert just before `listFiles` (before line 846):

```ts
/**
 * Resolve `target` to a realpath and confirm it is inside `root` (also a
 * realpath). Rejects `..` traversal and symlink escapes. For not-yet-existing
 * targets (create/write) the deepest existing ancestor is realpath'd instead,
 * then the remaining segments are appended, so a brand-new file under the root
 * still passes. Throws FsSandboxError when outside the root.
 */
async function assertInsideFsRoot(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  let resolved = resolve(target);
  let existing = resolved;
  // Walk up to the nearest existing ancestor so create/write of a new path works.
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        existing = resolve(target);
        break;
      }
      existing = parent;
    }
  }
  // Re-attach the non-existing tail (if any) to the realpath'd ancestor.
  const tail = resolved.slice(existing === resolve(target) ? resolved.length : existing.length);
  resolved = existing + tail;
  const withSep = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
  if (resolved !== realRoot && !resolved.startsWith(withSep)) {
    throw new FsSandboxError(`Path is outside the sandbox: ${target}`);
  }
  return resolved;
}

/** Thrown when an /api/fs path escapes fsRoot. */
class FsSandboxError extends Error {}
```

- [ ] **Step 5: Apply the guard in all four FS routes** — wrap each route body. Replace `GET /api/fs` (lines 451-467):

```ts
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs",
    async (request, reply): Promise<FsListResponse | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        await assertInsideFsRoot(resolved.fsRoot, path);
        return await listFiles(path);
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot read directory."
        });
      }
    }
  );
```

Replace `GET /api/fs/read` (lines 470-493):

```ts
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs/read",
    async (request, reply): Promise<FsReadResponse | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        await assertInsideFsRoot(resolved.fsRoot, path);
        const buffer = await readFile(path);
        const cap = 1024 * 1024;
        return {
          path,
          content: buffer.subarray(0, cap).toString("utf8"),
          size: buffer.length,
          truncated: buffer.length > cap
        };
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot read file."
        });
      }
    }
  );
```

Replace `PUT /api/fs/write` (lines 496-510):

```ts
  app.put("/api/fs/write", async (request, reply): Promise<{ ok: true } | void> => {
    const body = (request.body ?? {}) as Partial<FsWriteRequest>;
    if (!body.path || typeof body.content !== "string") {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and content required." });
    }
    try {
      await assertInsideFsRoot(resolved.fsRoot, body.path);
      await writeFile(body.path, body.content, "utf8");
      return { ok: true };
    } catch (error) {
      if (error instanceof FsSandboxError) {
        return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
      }
      return reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot write file."
      });
    }
  });
```

Replace `POST /api/fs/create` (lines 513-532):

```ts
  app.post("/api/fs/create", async (request, reply): Promise<{ ok: true } | void> => {
    const body = (request.body ?? {}) as Partial<FsCreateRequest>;
    if (!body.path || (body.kind !== "file" && body.kind !== "dir")) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and kind required." });
    }
    try {
      await assertInsideFsRoot(resolved.fsRoot, body.path);
      if (body.kind === "dir") {
        await mkdir(body.path, { recursive: true });
      } else {
        await mkdir(dirname(body.path), { recursive: true });
        await writeFile(body.path, "", { flag: "wx" });
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof FsSandboxError) {
        return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
      }
      return reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot create entry."
      });
    }
  });
```

- [ ] **Step 6: Typecheck**

Run: `pnpm check`
Expected: `apps/daemon` compiles. PASS.

- [ ] **Step 7: Runtime verify — inside allowed, outside rejected** (dev `fsRoot` = `.stage/workspaces`)

> If the throttle from Task 4 locked `127.0.0.1`, restart the dev daemon first.

```bash
HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'
TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')
WS="$PWD/.stage/workspaces"
mkdir -p "$WS"
# inside the sandbox → 200
curl -sS -o /dev/null -w "inside:  %{http_code}\n" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/fs?path=$WS"
# outside (parent of fsRoot) → 403
curl -sS         -w "\noutside: %{http_code}\n"    -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/fs?path=/etc"
# traversal escape → 403
curl -sS         -w "\ntravers: %{http_code}\n"    -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/fs?path=$WS/../../"
# create a NEW file inside the sandbox → 200 (deepest-existing-ancestor logic)
curl -sS -o /dev/null -w "newfile: %{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"path\":\"$WS/sandbox-probe.txt\",\"kind\":\"file\"}" http://127.0.0.1:47831/api/fs/create
rm -f "$WS/sandbox-probe.txt"
```
Expected: `inside: 200`; `outside`, `travers` both `403` with body `{"code":"FS_FORBIDDEN",...}`; `newfile: 200`.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): sandbox /api/fs* to fsRoot via realpath-prefix check"
```

---

### Task 6: Daemon — §1.9 hardening (drop CORS wildcard, bcrypt cost 12, trim /health)

**Files:**
- Modify: `apps/daemon/src/index.ts` (CORS `cors`/`corsHeaders` ~lines 228-232; CORS block in `onRequest` ~lines 244-253; `corsHeaders` spreads in `/api/sessions/:id/output` ~line 636 and `/events` ~line 660; `/health` ~lines 285-291; `hashPassword` ~lines 897-900)
- Modify: `packages/api/src/index.ts` (`HealthResponse` ~lines 14-20)

**Interfaces:**
- Removes: the `Access-Control-Allow-Origin: *` CORS logic entirely (same-origin behind Caddy).
- Changes: `hashPassword` bcrypt cost 10 → 12; `HealthResponse` trimmed to `{ ok: true }` (daemon details dropped from the public endpoint).
- Consumed by: `store/app.ts` only reads `health()` for liveness (it ignores the body), so trimming is safe.

- [ ] **Step 1: Remove the `cors`/`corsHeaders` declarations** — delete lines 228-232 (the `const { registry, sessions } = services;` line stays; the two comment lines + `cors` + `corsHeaders` go). After the edit, the top of `createServer`'s body reads:

```ts
  const { registry, sessions } = services;

  const app = Fastify({
```

- [ ] **Step 2: Remove the CORS block from the `onRequest` hook** — delete the `if (cors) { … }` block (lines 244-253). The hook's `/ws` early-return (lines 239-243) and the auth logic (Task 2/4) stay; the body now goes straight from the `/ws` skip to the `needsAuth` computation:

```ts
  app.addHook("onRequest", async (request, reply) => {
    // The multiplexed session WebSocket authenticates itself via a query token
    // (browsers can't set WS headers) and must skip the bearer logic below.
    if (request.url.split("?")[0] === "/ws") {
      return;
    }

    // Only the API + event stream are token-gated; the static web client, its
    // assets and the public auth-info endpoint load freely (the web app then
    // authenticates its API calls with the credential bearer).
    const url = request.url.split("?")[0];
    const needsAuth =
      (url.startsWith("/api") || url.startsWith("/events")) && url !== "/api/auth/info";
    if (!options.authRequired || !needsAuth) {
      return;
    }

    const ip = clientIp(request);
    // … throttle + authorizeCredential block from Task 4 Step 3 …
  });
```

- [ ] **Step 3: Drop the `...corsHeaders` spreads** — in `GET /api/sessions/:id/output` (line ~636) remove `...corsHeaders` from the `writeHead` object (leaving the three content/cache headers), and likewise in `GET /events` (line ~660). Each `writeHead` becomes:

```ts
    reply.raw.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no"
    });
```

(and for `/events`, `"content-type": "application/x-ndjson"` with the same two trailing headers — just delete the `...corsHeaders` line in both).

- [ ] **Step 4: Trim `HealthResponse`** — replace the interface in `packages/api/src/index.ts` (lines 14-20):

```ts
export interface HealthResponse {
  ok: true;
}
```

- [ ] **Step 5: Trim the `/health` handler** — replace it in `apps/daemon/src/index.ts` (lines 285-291):

```ts
  // Public liveness only. Daemon id / version / mode / transports are not
  // disclosed to unauthenticated callers (moved behind /api/info, which is gated).
  app.get("/health", async (): Promise<HealthResponse> => ({ ok: true }));
```

- [ ] **Step 6: Raise the bcrypt cost to 12** — replace `hashPassword` (lines 897-900):

```ts
/** bcrypt-hash a plaintext password (stable hash persisted at rest). Cost 12
 *  slows offline cracking / per-guess derivation if a hash ever leaks; the
 *  expensive hash runs only at password-set and client-side login, so
 *  per-request auth stays cheap. */
function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, bcrypt.genSaltSync(12));
}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: `@orquester/api` + `apps/daemon` compile. `packages/ui` still compiles — `ApiClient.health()` returns the narrower `HealthResponse`, and the store only awaits it for liveness (never reads `.daemonId`/`.version`/etc.). Grep to confirm nothing reads the dropped fields:

Run: `grep -rn "\.daemonId\|health().*version\|\.transports\b" packages/ui/src apps/desktop/src | grep -iv "config\|daemonConfig"`
Expected: no hits that read a `HealthResponse` field (the desktop tray reads `transports.http.enabled` off the **daemon config**, not `/health` — that is fine). PASS.

- [ ] **Step 8: Runtime verify — no CORS header, trimmed /health**

> Restart the dev daemon if Task 4 locked the IP.

```bash
HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'
TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')
# /health is now a bare {"ok":true} with NO access-control-allow-origin header.
curl -sS -D - -o /tmp/health.json "http://127.0.0.1:47831/health" | grep -i "access-control" || echo "no CORS header (expected)"
cat /tmp/health.json; echo
# an authenticated API response also carries no CORS header.
curl -sS -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:47831/api/workspaces" | grep -i "access-control" || echo "no CORS header on API (expected)"
```
Expected: both `grep`s print "no CORS header …"; `/health` body is exactly `{"ok":true}`.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/index.ts packages/api/src/index.ts
git commit -m "feat(daemon): drop CORS wildcard, bcrypt cost 12, trim public /health"
```

---

### Task 7: Client — build + carry the combined credential (auth.ts, transporters, store, AuthModal)

**Files:**
- Modify: `packages/ui/src/lib/auth.ts` (add `buildCredential` + username storage)
- Modify: `packages/ui/src/lib/transporters/http-transporter.ts` (`password` → `credential`)
- Modify: `packages/ui/src/lib/transporters/ws-session-channel.ts` (`password` → `credential`, `setPassword` → `setCredential`)
- Modify: `packages/ui/src/lib/transporters/index.ts` (`createTransporter` passes `credential`)
- Modify: `packages/ui/src/store/app.ts` (`apiWithPassword` → `apiWithCredential`; `submitPassword` → `submitCredentials`; `establish` reads `requiresUsername`)
- Modify: `packages/ui/src/components/auth/AuthModal.tsx` (add username field; call `submitCredentials`)

**Interfaces:**
- Produces: `buildCredential(username, hash)` = `btoa(\`${username}:${hash}\`)`; `loadStoredUsername`/`storeUsername` (plain username in `localStorage`, alongside the per-endpoint hash).
- Produces: `submitCredentials(username, password)` (replaces `submitPassword(password)`).
- Renames: the transporter-layer bearer `password` → `credential` (it has always carried the wire bearer; it is now the combined base64 value, not a bare hash). **`UiConnection.password` keeps its name** (it is the stored bearer; documented as "combined credential") to avoid an unbounded rename through `connections.ts`/`ServerSwitcher`/`remotes.json`.
- **`pnpm check` will be GREEN at the end of this task** (all call sites updated together). Within the task, between sub-steps, the workspace will transiently fail — finish the whole task before checking.

- [ ] **Step 1: `lib/auth.ts` — add `buildCredential` + username storage** — append to the file (after `clearStoredHash`), and add `buildCredential` near `deriveAuthHash`:

```ts
/**
 * The wire credential for the HTTP transport: base64("<username>:<hash>")
 * (HTTP `Authorization: Bearer …` and WS `?token=…`), mirroring HTTP Basic with
 * the derived bcrypt hash standing in for the raw password. The raw password
 * never leaves the client.
 */
export function buildCredential(username: string, hash: string): string {
  return btoa(`${username}:${hash}`);
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
```

(`btoa` is the browser-native base64 encoder, available in every target; it matches the daemon's `Buffer.from(token,"base64")` decode. The username is the **plain** username — not a secret — and lives separately from the per-endpoint hash key.)

- [ ] **Step 2: `http-transporter.ts` — rename `password` → `credential`** — update the options interface, the field, the constructor, and the three usages. The diff:

```ts
export interface HttpTransporterOptions {
  baseUrl: string;
  /** Bearer sent as `Authorization: Bearer <credential>` when present. The
   *  credential is base64("<username>:<hash>"). */
  credential?: string;
  /** Defaults to a {@link FetchHttpClient}. */
  httpClient?: HttpClient;
}
```

```ts
  private readonly baseUrl: string;
  private readonly credential?: string;
  private readonly client: HttpClient;

  constructor(options: HttpTransporterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credential = options.credential;
    this.client = options.httpClient ?? new FetchHttpClient();
  }
```

In `request(...)` (line 43-45):

```ts
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }
```

In `openStream(...)` (line 74-77):

```ts
    const headers: Record<string, string> = {};
    if (this.credential) {
      headers.Authorization = `Bearer ${this.credential}`;
    }
```

In `sessionChannel()` (line 113):

```ts
    return getSessionChannel(this.baseUrl, this.credential);
```

- [ ] **Step 3: `ws-session-channel.ts` — rename `password` → `credential`, `setPassword` → `setCredential`** — update the constructor param, `setPassword`, `url()`, and the module factory. Diffs:

```ts
  constructor(
    private readonly wsUrl: string,
    private credential?: string
  ) {
    this.connect();
  }

  /** Update the credential (e.g. after auth) and reconnect if it changed. */
  setCredential(credential?: string): void {
    if (credential === this.credential) {
      return;
    }
    this.credential = credential;
    this.reconnect();
  }
```

`url()` (line 57-59):

```ts
  private url(): string {
    return this.credential
      ? `${this.wsUrl}?token=${encodeURIComponent(this.credential)}`
      : this.wsUrl;
  }
```

The module-level factory (lines 160-170):

```ts
export function getSessionChannel(httpBaseUrl: string, credential?: string): WsSessionChannel {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
  const existing = channels.get(wsUrl);
  if (existing) {
    existing.setCredential(credential);
    return existing;
  }
  const channel = new WsSessionChannel(wsUrl, credential);
  channels.set(wsUrl, channel);
  return channel;
}
```

- [ ] **Step 4: `transporters/index.ts` — pass `credential`** — in `createTransporter` (lines 24-30), rename the prop passed to `HttpTransporter`:

```ts
  if (connection.endpoint.startsWith("http://") || connection.endpoint.startsWith("https://")) {
    return new HttpTransporter({
      baseUrl: connection.endpoint,
      credential: connection.password,
      httpClient: options.httpClient
    });
  }
```

(`connection.password` is the stored bearer field on `UiConnection`; it now holds the combined credential. The field keeps its name; only the transporter option is `credential`.)

- [ ] **Step 5: `store/app.ts` — rename `apiWithPassword` → `apiWithCredential`, add `submitCredentials`, read `requiresUsername`** —

  (a) Update the import from `../lib/auth` (line 6) to include the new helpers:

```ts
import {
  buildCredential,
  clearStoredHash,
  clearStoredUsername,
  deriveAuthHash,
  loadStoredHash,
  loadStoredUsername,
  storeHash,
  storeUsername
} from "../lib/auth";
```

  (b) Rename the helper (lines 112-116) — it now sets the connection's bearer (the combined credential) and rebuilds the client:

```ts
/** Rebuild an ApiClient for the same connection but with a bearer credential. */
function apiWithCredential(api: ApiClient, credential: string): ApiClient {
  const connection: UiConnection = { ...api.connection, password: credential };
  return new ApiClient(connection, buildTransporter(connection));
}
```

  (c) Add `requiresUsername` to `AppState` (after `authSalt: string | null;`, line ~167):

```ts
  authSalt: string | null;
  /** Whether the active connection's auth needs a username (UI hint). */
  authRequiresUsername: boolean;
```

  and to the initial state (after `authSalt: null,`, line 249): `authRequiresUsername: false,`

  (d) Change the `submitPassword` declaration on `AppState` (line 211) to:

```ts
  submitCredentials: (username: string, password: string) => Promise<void>;
```

  (e) Replace all three `apiWithPassword(...)` call sites with `apiWithCredential(...)`:
  - `establish` (line 307): `active = apiWithCredential(active, hash);` — but note `hash` is now the **stored combined credential** (see (f)).
  - `handleDisconnect` (line 356): `const fresh = apiWithCredential(current, current.connection.password ?? "");`
  - `signOut` (line 453): `api: apiWithCredential(api, ""),`

  (f) Rewrite `establish`'s auth gate (lines 296-310) to read `requiresUsername` and restore the stored combined credential (built from the stored username + hash when present):

```ts
    // Auth gate: derive/restore the bearer credential (web) or prompt.
    let active = api;
    const info = await active.authInfo().catch(() => null);
    set({ authSalt: info?.salt ?? null, authRequiresUsername: info?.requiresUsername ?? false });
    if (info?.authRequired) {
      // The bearer is base64("<username>:<hash>"). Prefer one already on the
      // connection; else rebuild it from the per-endpoint stored username+hash.
      const endpoint = active.connection.endpoint;
      const storedHash = loadStoredHash(endpoint);
      const storedUser = loadStoredUsername(endpoint);
      const credential =
        active.connection.password ??
        (storedHash ? buildCredential(storedUser ?? "", storedHash) : undefined);
      if (!credential) {
        stopHealthProbe();
        set({ connectionStatus: "error", reconnectAttempt: 0, authPrompt: { connectionId: active.connection.id } });
        return;
      }
      if (active.connection.password !== credential) {
        active = apiWithCredential(active, credential);
        set({ api: active });
      }
    }
```

  (g) Replace `submitPassword` (lines 431-443) with `submitCredentials`:

```ts
  submitCredentials: async (username, password) => {
    const api = get().api;
    const salt = get().authSalt;
    if (!api || !salt) {
      return;
    }
    // Derive the same bcrypt hash the daemon stores; persist the hash + the
    // plain username (never the plaintext password). The wire bearer is
    // base64("<username>:<hash>").
    const normalizedUser = username.trim().toLowerCase();
    const hash = deriveAuthHash(password, salt);
    const credential = buildCredential(normalizedUser, hash);
    storeHash(api.connection.endpoint, hash);
    storeUsername(api.connection.endpoint, normalizedUser);
    set({ api: apiWithCredential(api, credential), authPrompt: null });
    await get().connect();
  },
```

  (h) In `signOut` (lines 445-459), also clear the stored username:

```ts
  signOut: () => {
    const api = get().api;
    if (api) {
      stopHealthProbe();
      reconnecting = false;
      closeEvents();
      clearStoredHash(api.connection.endpoint);
      clearStoredUsername(api.connection.endpoint);
      set({
        api: apiWithCredential(api, ""),
        connectionStatus: "error",
        reconnectAttempt: 0,
        authPrompt: { connectionId: api.connection.id }
      });
    }
  },
```

  (i) In `loadWorkspaces`'s 401 handler (lines 516-518), also clear the stored username so a stale credential fully resets:

```ts
      if (error instanceof ApiError && error.status === 401) {
        clearStoredHash(api.connection.endpoint);
        clearStoredUsername(api.connection.endpoint);
        set({ connectionStatus: "error", authPrompt: { connectionId: api.connection.id } });
      } else {
```

- [ ] **Step 6: `AuthModal.tsx` — add a username field, call `submitCredentials`** — replace the component body. The username field sits above password and defaults to the stored username (or `"mapacho"`); it is shown only when `authRequiresUsername`:

```tsx
import React, { useState } from "react";
import { Lock } from "lucide-react";
import { Button, Input, Modal } from "../ui";
import { useAppStore } from "../../store/app";

/**
 * Credential prompt for a token-protected daemon (web). The password is turned
 * into a bcrypt hash (using the daemon's salt) and combined with the username
 * into a base64 bearer; only the hash + plain username are stored, never the
 * plaintext password.
 */
export const AuthModal: React.FC = () => {
  const authPrompt = useAppStore((s) => s.authPrompt);
  const connections = useAppStore((s) => s.connections);
  const requiresUsername = useAppStore((s) => s.authRequiresUsername);
  const submitCredentials = useAppStore((s) => s.submitCredentials);
  const [username, setUsername] = useState("mapacho");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!authPrompt) {
    return null;
  }

  const connection = connections.find((c) => c.id === authPrompt.connectionId);

  const submit = async () => {
    if (!password || busy) {
      return;
    }
    setBusy(true);
    await submitCredentials(username, password);
    setBusy(false);
    setPassword("");
  };

  return (
    <Modal
      open
      onClose={() => useAppStore.setState({ authPrompt: null })}
      className="max-w-sm"
    >
      <div className="w-full p-5">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-800 text-neutral-300">
            <Lock size={16} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-100">Authentication required</p>
            <p className="truncate text-xs text-neutral-500">{connection?.name ?? "Server"}</p>
          </div>
        </div>

        {requiresUsername ? (
          <Input
            autoFocus
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void submit();
              }
            }}
            className="mb-2"
          />
        ) : null}

        <Input
          autoFocus={!requiresUsername}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submit();
            }
          }}
        />

        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => useAppStore.setState({ authPrompt: null })}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={!password || busy} onClick={() => void submit()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};
```

(Confirm `Input` forwards `className` — it is used elsewhere with `className`. If not, wrap the username `Input` in a `<div className="mb-2">` instead.)

- [ ] **Step 7: Typecheck**

Run: `pnpm check`
Expected: PASS across the whole workspace (api, config, daemon, ui all clean). If a stray `password`/`setPassword`/`submitPassword`/`apiWithPassword` reference remains, the compiler points at it — fix and re-run. Sanity grep:

Run: `grep -rn "submitPassword\|apiWithPassword\|setPassword\b\|\.password\b" packages/ui/src/lib/transporters packages/ui/src/store/app.ts packages/ui/src/components/auth`
Expected: no `submitPassword`/`apiWithPassword`/`setPassword` left; the only `.password` hits are on `UiConnection`/`connection.password` (the retained field name), which is intentional.

- [ ] **Step 8: Runtime verify — login with username + password in the browser** (Playwright via system Chrome, or manual against `pnpm dev:web` on :5173 → daemon :47831)

Drive: load the web app → the AuthModal shows a **Username** field (prefilled `mapacho`) above Password → enter username `mapacho` + password `123456` → Connect → workspaces load (connected). Then in DevTools Application → Local Storage confirm two keys exist for the endpoint: `orquester.auth:<endpoint>` (the bcrypt hash) and `orquester.user:<endpoint>` (the plain `mapacho`); confirm the **raw password `123456` is not stored anywhere**. Reload → it reconnects without re-prompting (credential rebuilt from storage). Negative: sign out, enter username `wrong` + password `123456` → stays on the prompt / shows the connection error (401), identical to entering the right username + wrong password.
Expected: correct credential connects and persists across reload; wrong username and wrong password are both rejected identically; only the hash + plain username (never the password) are in `localStorage`.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/lib/auth.ts packages/ui/src/lib/transporters/http-transporter.ts packages/ui/src/lib/transporters/ws-session-channel.ts packages/ui/src/lib/transporters/index.ts packages/ui/src/store/app.ts packages/ui/src/components/auth/AuthModal.tsx
git commit -m "feat(ui): username+password credential through auth, transporters, store, modal"
```

---

### Task 8: Desktop — seed the VPS as a default remote (keep the bundled local daemon)

**Files:**
- Modify: `apps/desktop/src/main.ts` (`ensureAppFiles` ~lines 64-78)

**Interfaces:**
- Produces: a default remote `{ id, name, kind: "remote", baseUrl: ORQUESTER_REMOTE_URL }` seeded into `remotes.json` on first launch when the file does not exist. The bundled local daemon (`preload.cjs` `defaultConnection`) is unchanged and stays the launch connection; the remote is added to the Server Switcher list.
- The remote URL comes from `ORQUESTER_REMOTE_URL` (so a build can bake in `https://orquester.example.com`); when unset, no remote is seeded (avoids hardcoding a placeholder into every dev build).

- [ ] **Step 1: Seed the default remote in `ensureAppFiles`** — replace the `remotes.json` block (lines 73-76) with:

```ts
  const remotesPath = path.join(dir, "remotes.json");
  if (!fs.existsSync(remotesPath)) {
    // Seed the VPS as a selectable remote (kept alongside the bundled local
    // daemon). The URL is build/env-provided so we never bake a placeholder in.
    const remoteUrl = process.env.ORQUESTER_REMOTE_URL;
    const remotes = remoteUrl
      ? [{ id: "vps", name: "Orquester VPS", kind: "remote", baseUrl: remoteUrl }]
      : [];
    fs.writeFileSync(remotesPath, `${JSON.stringify({ version: 1, remotes }, null, 2)}\n`);
  }
```

(`baseUrl` matches `remoteConnectionSchema` in `packages/config`; `password` is omitted so the user authenticates via the AuthModal on first connect. The local connection remains `activeConnectionId` per the existing `app.json` default, so nothing changes for a user who doesn't set `ORQUESTER_REMOTE_URL`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: `@orquester/desktop` compiles (the seeded object is plain JSON written via `fs.writeFileSync`; no type coupling). PASS for the whole workspace.

- [ ] **Step 3: Runtime verify — remotes.json seeded when the env var is set**

```bash
TMPDIR_DESK=$(mktemp -d)
# Simulate first-launch ensureAppFiles by checking the written file shape.
ORQUESTER_REMOTE_URL=https://orquester.example.com node -e '
  const fs = require("node:fs"), path = require("node:path");
  const dir = path.join(process.env.TMPDIR_DESK, "app");
  fs.mkdirSync(dir, { recursive: true });
  const remotesPath = path.join(dir, "remotes.json");
  const remoteUrl = process.env.ORQUESTER_REMOTE_URL;
  const remotes = remoteUrl ? [{ id: "vps", name: "Orquester VPS", kind: "remote", baseUrl: remoteUrl }] : [];
  fs.writeFileSync(remotesPath, JSON.stringify({ version: 1, remotes }, null, 2) + "\n");
  console.log(fs.readFileSync(remotesPath, "utf8"));
' TMPDIR_DESK="$TMPDIR_DESK"
rm -rf "$TMPDIR_DESK"
```
Expected: prints `remotes.json` with one remote `{ "id": "vps", "name": "Orquester VPS", "kind": "remote", "baseUrl": "https://orquester.example.com" }`. (This mirrors the exact code path; a full Electron launch is optional — the seeded JSON is what the renderer reads via `/api/config/remotes`.)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): seed VPS as a default remote (ORQUESTER_REMOTE_URL), keep local daemon"
```

---

## Notes for the implementer

- The dev daemon (`pnpm dev:daemon`) and web app (`pnpm dev:web`) hot-reload; no restart is needed after most edits. **Exception:** the in-memory `LoginThrottle` (Task 4) persists across hot reloads of the file but is cleared by a full daemon restart — restart (`Ctrl-C` + re-run `pnpm dev:daemon`) if a verify step locked `127.0.0.1`.
- Curl bearer is the base64 credential, not a bare hash: `TOKEN=$(printf 'mapacho:%s' "$HASH" | base64 | tr -d '\n')` (GNU coreutils: `base64 -w0`). The stage `HASH` is `$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe` (bcrypt of `123456`).
- After Task 2, the **old bare-hash bearer no longer authenticates** — only the combined base64 credential does. `pnpm check` stays green throughout (type-compatible), but a browser session that hasn't re-logged-in with the new client (Task 7) will 401 until then; this is expected staging, not a regression.
- Within Task 7, `pnpm check` transiently fails between sub-steps (a rename touches multiple files); only Step 7 is the green checkpoint. Every other task ends green.
- `safeEqual` (daemon) is retained but unused after Task 2 — leave it; it is small and may be reused. Do not delete it (avoids an unrelated diff).
- The spec's §1.9 ops items — Caddy CSP/headers, `fail2ban`, `unattended-upgrades`, TLS, the localhost bind in prod `daemon.env`, the 32+ char password — are **Phase 0 / Caddyfile**, not this plan. The fail-closed start guard (`validateTransportConfig`, daemon `index.ts:958-964`) already exists and is unchanged.
