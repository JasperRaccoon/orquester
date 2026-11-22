# Login second factor (authenticator codes + recovery codes)

## Intent

The remote daemon (e.g. `https://agents.jasperdev.io/`) is reachable by anyone on the internet, and
today a username and password are the only thing between a stranger and full control of the host
(terminals, agents, files, MCP). The owner wants sign-in to need something they *have* as well:
a 6-digit code from an authenticator app (Google Authenticator, 1Password, Aegis…), with one-time
recovery codes for when the phone is lost.

Guessing is already impractical (bcrypt cost 12, per-IP lockout of 5 tries → 15 min doubling to
24 h, a 32-byte random password from provisioning). The second factor protects against a password
that **leaks** (reused, shoulder-surfed, phished, read from a backup of `daemon.env`).

## Goals

- When enabled, a remote password login no longer yields a token by itself; it yields a short-lived
  challenge that only a valid authenticator code or an unused recovery code turns into a session.
- Set up, regenerate recovery codes and turn off from **Settings → Server → Remote access** in the
  web/desktop UI (the owner's choice), each guarded by the password **and** a current code.
- Close the two paths that would let a stolen session sidestep the factor (see "Gaps closed").
- A documented way back in when the phone **and** the recovery codes are lost: a server-side reset
  over ssh.

## Threat scope

- In scope: someone who has the **password** (and the URL) but no live session or API token.
- Out of scope: someone who already holds a live session or API token. A session opens terminals as
  the daemon's user, so it can read the TOTP secret from the appdir, delete the factor file, or
  change anything else; no login factor can defend against that. "Gaps closed" only stops a session
  from *quietly turning itself into a permanent credential* through the API, and keeps pre-factor
  sessions from outliving the switch-on.

## Non-goals

- Passkeys / WebAuthn (considered, see Approaches; a possible later addition on top of codes).
- Multiple users, per-user factors.
- Changing remote password change (still socket-only / `deploy.sh rotate-password`).
- Expiry for API tokens, session-lifetime changes, throttling failed WebSocket tokens.
- Requiring the second factor on the unix socket: it is trusted local control (AGENTS.md).
- "Remember this device for N days" — every new device session needs a code; an existing session
  already lasts 30 days idle.

## Anti-goals (a failure even if it "works")

- **Fail open.** A corrupt or unreadable second-factor file must never silently turn the factor off.
  (An *absent* file means "off" by design: deleting it is the server-side reset, and only someone who
  already has a shell on the host can delete it — see Threat scope.)
- Any remote route that turns the password alone into a token (or an API token) while the factor is on.
- The TOTP secret or recovery codes in an API response after setup, in a log, or in `daemon.json`
  GET output.
- Locking the owner out with no documented recovery.

## How it works today (relevant parts)

- Credentials: `transports.http.{username,passwordHash}` in `<appdir>/daemon/daemon.json`
  (`packages/config/src/index.ts:862-908`, bcrypt via `apps/daemon/src/daemon-config.ts`).
- `POST /api/auth/login` (`apps/daemon/src/auth/routes.ts`) checks the password through `guarded()`
  (per-IP `passwordThrottle`, one check in flight per IP) and mints a `device` session
  (`AuthSessionStore.create`, `auth/sessions.ts`) → `{token, session}`. Tokens are `orq_…`, kept
  as SHA-256 digests in `<appdir>/daemon/auth-sessions.json`.
- The bearer hook (`apps/daemon/src/index.ts:2392-2470`) gates `/api`, `/events`, `/mcp` except
  `authRoutes.info` and `authRoutes.login`. WebSockets check the same store via `authorizeSocket`.
- `POST /api/auth/tokens` mints a never-expiring API token for **any** live bearer, no re-check.
- UI: sign-in is `AuthModal` (`packages/ui/src/components/auth/AuthModal.tsx`) driven by
  `submitCredentials` / `signInError` in `packages/ui/src/store/app.ts`; the API client is
  `packages/ui/src/lib/api-client.ts`. Settings → Server is `ServerSettings.tsx` ("Remote access"
  card) with `AuthSessionsSettings.tsx` (devices, API tokens) below it. Desktop shows the same modal
  for remote daemons.
- No TOTP, QR or OTP-input code or dependency exists anywhere.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Own RFC 6238 TOTP on `node:crypto` (~40 lines, verified against the RFC test vectors); `qrcode` npm package in `packages/ui` only, to draw the enrollment QR | No third-party code in the daemon's auth path; one small UI dependency |
| B | Same, but the `otpauth` library computes codes | Less own code, but an external package inside the login check to trust and keep patched; the math is too small to justify it |
| C | Passkeys instead of codes | Phishing-proof, but the desktop app talks to remotes through its main process and passkeys bind to the page's origin, so desktop sign-in would need a workaround. Good later addition |

The owner picked **A**, and chose **web Settings** (not server-only) for enrollment and management.

## Design

### Factor parameters

- TOTP: HMAC-SHA1, 6 digits, 30 s step, accept the current step ±1. 20-byte secret from
  `randomBytes`, shown as RFC 4648 base32 (no padding). Codes compared with `timingSafeEqual`.
- Replay: persist `lastUsedStep`; a code whose step ≤ `lastUsedStep` is refused even if correct.
- Recovery codes: 10 codes, each 10 characters from a 32-symbol unambiguous alphabet
  (≈50 bits), displayed as `xxxxx-xxxxx`; input is normalised (case, spaces, dashes) before check.
  Stored as SHA-256 digests (high-entropy inputs + throttle make a slow hash unnecessary). Each is
  removed when used. Regenerating replaces all ten.
- Wherever the API takes `code`, it accepts **either** a 6-digit TOTP code or a recovery code.
- otpauth URI: `otpauth://totp/Orquester:<username>@<host>?secret=…&issuer=Orquester&algorithm=SHA1&digits=6&period=30`,
  where `<host>` is the request's `Host` header (so the authenticator entry names the server).

### Storage — `<appdir>/daemon/auth-second-factor.json`

- New path helper `authSecondFactorPath(baseDir)` and a tolerant zod schema in `packages/config`
  (own module, like `auth-sessions.ts`), version 1:
  `{ version: 1, totp?: { secret, enabledAt, lastUsedStep }, recoveryCodes: [{ digest }], lastFailedChallenge?: { at, ip } }`;
  unknown keys preserved and written back.
- Separate from `daemon.json` so the config GET sanitizer, socket config PUT and
  `deploy.sh rotate-password` never touch the secret, and separate from `auth-sessions.json`,
  whose contract is "this file never authenticates anyone".
- Writes: atomic, 0600, serialized (same pattern as `AuthSessionStore`, `writeFileAtomic`).
- **Fail closed:** file absent → factor off. File present but unreadable or unparsable → the daemon
  treats the factor as **on and unusable**: password logins answer 503
  `SECOND_FACTOR_UNAVAILABLE` ("run `deploy.sh reset-2fa`"); existing sessions keep working. The
  file is never moved aside or overwritten in this state.
- Loaded once at boot into a daemon-side store (`apps/daemon/src/auth/second-factor.ts`), which
  owns verify/consume/enable/disable and all writes.

### Login flow (remote transport)

1. `POST /api/auth/login` unchanged when the factor is off. When on, a correct password returns
   **200** `{ secondFactorRequired: true, challenge, expiresAt }` instead of a token
   (`AuthLoginResponse` becomes a union of this and `AuthIssuedTokenResponse`).
2. `POST /api/auth/login/second-factor` `{ challenge, code, label? }` → `AuthIssuedTokenResponse`.
   Public route: add it to the bearer hook's exemptions next to `authRoutes.login`.
3. Challenges: in memory only, random 32 bytes, 5 min TTL, single use, at most 5 code attempts,
   bound to the password fingerprint the password was checked against (a password change voids it,
   reusing `StalePasswordError` semantics) and to the client IP that passed the password.
4. Wrong codes have their **own** counters, separate from `passwordThrottle`, because the attacker in
   scope knows the password and `guarded()` clears an IP's count on every correct password (they
   could otherwise alternate "4 wrong codes, re-enter password" forever):
   - per IP: 5 wrong codes → code entry from that IP locked 15 min, doubling up to 24 h (reuse the
     `LoginThrottle` class as a second instance); a correct password does **not** clear it — only a
     completed sign-in (correct code) or the lockout lapsing does;
   - global (all IPs, defeats an attacker spreading guesses over many addresses): 20 wrong codes →
     **all** code entry locked 15 min, doubling up to 24 h. Trade-off accepted: someone with the
     password can stop new devices signing in for a while, but existing sessions keep working (see
     "Keeping the signed-in owner in"), and the owner is told (see "Telling the owner");
   - plus the per-challenge cap of 5 attempts (step 3).
   The password step itself still runs through `guarded()` / `passwordThrottle` as today. Errors:
   401 `INVALID_CODE`, 401 `CHALLENGE_EXPIRED` (unknown/expired/exhausted → client restarts at the
   password step), 429 as today.
5. A restart drops pending challenges; the user re-enters the password.

### Keeping the signed-in owner in (hard requirement)

The owner, already signed in, must never lose access because someone else is attacking the login.
Every lockout above guards **only the public sign-in steps** (`login`, `login/second-factor`):

- Bearer-authenticated requests, `/events`, every WebSocket and `/mcp` never consult the password
  or code counters. (They keep today's separate bearer throttle, which only counts *invalid
  tokens* from an IP, so an attacker's wrong passwords or codes cannot trip it for the owner.)
- The management routes (`setup`, `enable`, `recovery-codes`, `disable`, token minting) are
  reachable only with a live session, so an attacker without one cannot call them. They check the
  password and code with the per-IP limits only and **ignore the global code lockout**, so the owner
  can turn the factor off, regenerate codes, or rotate the password (socket / `deploy.sh`) in the
  middle of an attack.
- A global lockout never revokes, expires or pauses any existing session or API token.
- Tests: during a global code lockout, an existing session's API request, WebSocket connect and
  `disable` call all still succeed.

### Telling the owner

A correct password followed by a wrong code means the password has leaked, so the owner is told:

- On the first wrong code of a challenge, and on every global lockout: a warning in the daemon log
  (IP, no code) and a push notification to the owner's subscribed devices through the existing
  `PushService` ("Someone entered your Orquester password from <ip> but not a valid code. Change
  your password."), at most one per 15 minutes.
- The "Two-step sign-in" row in Settings shows the last such event ("Wrong code after a correct
  password from <ip>, <time>") until dismissed, with a pointer to rotating the password. Kept in the
  second-factor file as `lastFailedChallenge: { at, ip }`.

### Management routes (all gated by the bearer hook)

| Route | Body | Result |
|---|---|---|
| `GET /api/auth/second-factor` | — | `{ enabled, enabledAt, recoveryCodesRemaining, lastFailedChallenge }` |
| `POST /api/auth/second-factor/dismiss-alert` | — | 204; clears `lastFailedChallenge` |
| `POST /api/auth/second-factor/setup` | `{ password }` | `{ secret, otpauthUri }`; pending secret held in memory for 10 min, tied to the caller's session; 409 if already enabled |
| `POST /api/auth/second-factor/enable` | `{ code }` (TOTP from the pending secret) | `{ recoveryCodes: string[] }` shown once; persists; **revokes every other device session** |
| `POST /api/auth/second-factor/recovery-codes` | `{ password, code }` | `{ recoveryCodes }`, old ones invalid |
| `POST /api/auth/second-factor/disable` | `{ password, code }` | 204 |

- Remote: the password and code are checked through `guarded()` (throttled). Over the unix socket
  the proof fields are not required (trusted local control), matching how config PUT works there.
- Route constants and types go in `packages/api/src/auth.ts` (`authRoutes`), then daemon, then UI.

### Gaps closed

- **API token minting** (`POST /api/auth/tokens`): remote callers must now send `{ password }`, plus
  `code` when the factor is on. Otherwise a stolen device session could mint a permanent token.
  Existing API tokens are not revoked (embed hosts, MCP clients depend on them); Settings already
  lists them for manual revocation.
- **Sessions issued before the factor:** enabling revokes all device sessions except the caller's
  (the caller just proved password + code). API tokens are left alone, as above.

### Lost everything: server-side reset

- `deploy.sh reset-2fa <target>`: over ssh, removes `/var/lib/orquester/daemon/auth-second-factor.json`
  and restarts the service, mirroring `rotate-password`'s structure, error trapping and
  confirmation output. It must work as described in AGENTS.md for `deploy/lib` scripts.
- Documented in `deploy/README.md` next to `rotate-password`.

### UI

- **Sign-in (`AuthModal`)**: after a challenge response, the modal swaps to a code step: one field
  "Authentication code", `autoComplete="one-time-code"`, accepting digits or a recovery code, a
  hint "Or enter one of your recovery codes", Back to return to the password step. `signInError`
  gains `INVALID_CODE` ("That code didn't work.") and `CHALLENGE_EXPIRED` (back to the password
  step with "Sign-in timed out. Enter your password again."). Same modal on desktop for remotes.
- **Settings → Server → Remote access** gains a "Two-step sign-in" row (shown when remote access is
  on or the connection is remote):
  - Off → "Set up" → dialog: password → QR (from `otpauthUri`, rendered with `qrcode` to SVG) plus
    the secret as copyable text for manual entry → enter a code → recovery codes with Copy and
    Download (.txt) and a "I've saved these" button to close. Leaving before confirming discards it.
  - On → "On since <date>", "<n> recovery codes left" (warn at ≤3), "New recovery codes" and
    "Turn off", each prompting for password + code (prompts skipped on the local socket).
- **API token creation** in `AuthSessionsSettings`: prompts for password (+ code when on) before
  calling `createApiToken`, remote only.

## Tests (per AGENTS.md: behaviour through stable seams)

- TOTP against the RFC 6238 SHA-1 vectors (via the module's normal exports).
- Route tests (extend `auth/routes.test.ts` harness): factor on → correct password returns a
  challenge, not a token; challenge + correct code → token; replayed code refused; wrong-code
  attempts exhaust the challenge; re-entering the correct password does not reset the code
  lockout (the alternation attack); wrong codes spread over many IPs hit the global lockout; expired challenge; recovery code works
  once; enable revokes other device sessions; token minting without proof refused remotely;
  unparsable second-factor file → login 503, not password-only success.
- Config schema tolerance test for the new file (unknown keys round-trip).
- UI store test: login → challenge → code → connected; `CHALLENGE_EXPIRED` returns to password.

## Left to the builder

- Module layout inside `apps/daemon/src/auth/`, naming of internal helpers.
- Exact dialog layout and copy, within the flow above.
- Whether the challenge/pending-secret maps live in the second-factor store or the routes module.
- Clock source injection for tests (follow `AuthSessionStore`'s `now` option).

## Compatibility notes

- An older client against a factor-enabled daemon gets a login response without a token; its token
  shape check fails and it shows a generic error. Acceptable (single owner, upgrade both).
- No change to `auth-sessions.json` format, the WebSocket protocol, or socket-only routes.
