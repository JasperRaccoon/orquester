# Ephemeral AI VMs — spike findings: agent logins in a box, paths

Spikes 1, 2, 3 and part of 5 of the design (`2026-10-19-ephemeral-ai-vms-design.md` §14), run
2026-10-19 (UTC) for the token broker (`apps/daemon/src/boxes/broker/`). Other tracks depend on
these facts: the agent-host adapters (spawn and auth wiring per CLI), transcript sync, and the
broker's refresh rules.

## Setup

- One Hetzner Cloud `cx23` (2 vCPU, 4 GB, x86) in `fsn1`, Ubuntu 24.04.4, name
  `orq-test-t8-eb632f0e`, label `orq-test=t8`. Reached over SSH with a throwaway key (this spike
  only). Created 22:55:39Z, deleted 23:09:48Z; the server list and the SSH-key list were checked
  empty afterwards. The private key was shredded.
- CLIs at the live host's versions, official distribution channels, run as a non-root user `box`:
  Claude Code **2.1.285** (`claude.ai/install.sh`), Codex CLI **0.159.0** (`@openai/codex`; the
  daemon's generated bindings are from 0.154.0 and every method and field below matches them),
  Grok **1.0.46** (`@xai-official/grok`).
- Credentials: managed accounts of the live daemon, read-only. A host-side script read ONLY the
  access token (+ expiry, + Codex `account_id`, + Claude's non-secret `scopes`/`subscriptionType`/
  `rateLimitTier`) and piped it straight into a `0600` file on the VM's tmpfs. No refresh token or
  id token was read into any output, copied anywhere, or printed; no credential file was written.
- Project path mirrored the host shape: `/var/lib/orquester/workspaces/x/y`.

## (a) Claude Code with an access token only

| Test | Result |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN=<access>` (fresh `CLAUDE_CONFIG_DIR`, no credentials file), `claude -p "…" --model opus --output-format stream-json --verbose` | Works. `system/init`: `model: "claude-opus-5-5"`, `apiKeySource: "none"`; result `success`, `modelUsage: ["claude-opus-5-5"]`. Subscription models are available. |
| Same, **without `--model`** | Default model is `claude-sonnet-5-5`: from the env token alone the CLI does not know the subscription type. |
| `.credentials.json` = `{"claudeAiOauth": {accessToken, expiresAt, scopes, subscriptionType, rateLimitTier}}`, **no `refreshToken`** | Works, and the default model is `claude-opus-5-5`, as on the host (it reads `subscriptionType: "max"`). The CLI left the file unchanged (same field set after the run). |
| That file with `expiresAt` one hour in the **past** (token itself still valid) | Works; no refresh attempted (no `oauth`/`refresh` lines in `--debug-file`). |
| Invalid token (env var or file) | Exit code 1. Stream: two `system/api_retry` `{error_status: 401, error: "authentication_failed"}`, then an `assistant` message with `model: "<synthetic>"`, `error: "authentication_failed"`, text `Failed to authenticate. API Error: 401 OAuth access token is invalid.`, then `result` `{subtype: "success", is_error: true, api_error_status: 401}`. Debug log: `Failed to fetch oauth profile from OAuth token … 401`. |
| Restart with resume | A session started with credentials file A was resumed (`--resume <id>`) by a new process given only `CLAUDE_CODE_OAUTH_TOKEN` of a **different** managed account, same config dir: same `session_id`, history intact (it recalled a code word from turn 1). |

A genuinely expired token was not tried: every token had hours left and the spike must not refresh.
Expect the same 401 path with a different message text **(unverified)**.

**The CLI never refreshes without a refresh token.** The refresh routine in the 2.1.285 bundle
(`Qa`, the caller of the `grant_type: "refresh_token"` POST) returns `"no_refresh_token"` before
any network call when the stored credential has no `refreshToken`, on both the first read and the
re-read under its lock. The debug logs of the runs above contain no refresh attempt.

**A running Claude CLI re-reads `.credentials.json`.** One long-running CLI driven like the Agent
SDK (`-p --input-format stream-json --output-format stream-json --verbose`), access-token-only
file, another process rewriting the file (temp + rename) between turns, `strace -e openat`:

| Start | Rewritten to | Turn 2 | `.credentials.json` opens (turn 1 → after turn 2) |
|---|---|---|---|
| valid | invalid token | **401** | 28 → 41 |
| invalid token | valid | **success** | 27 → 32 |
| valid, `expiresAt` inside the 5-min window | invalid, far `expiresAt` | **401** | 28 → 41 |

So the CLI picks up the rewritten file on its next request, in both directions.

For a host CLI that still holds a refresh token (not testable live without spending one), the
bundle shows the order of operations: when its in-memory token is inside the refresh window
(`GL`: `now + 300000 >= expiresAt`, i.e. the last 5 minutes), it invalidates its cache and re-reads
the file; if the file's `accessToken` differs from the one it was using it adopts it
(`tengu_oauth_token_refresh_race_resolved`) and does not refresh; otherwise it takes a
proper-lockfile lock on `<CLAUDE_CONFIG_DIR>/.oauth_refresh.lock` and the legacy
`<CLAUDE_CONFIG_DIR>.lock` (stale 60 s, refreshed every 5 s), re-reads and compares again under the
lock, and only then posts its refresh token.

**Consequences.**
- Claude-in-box is possible as designed. Prefer a refresh-token-free `.credentials.json` (with
  `scopes`, `subscriptionType`, `rateLimitTier`, which the broker returns in `extra`) over
  `CLAUDE_CODE_OAUTH_TOKEN`, or always pass the model explicitly: the env token silently changes
  the default model.
- A running box CLI can be given a fresh token by rewriting that file between turns; a restart
  with resume is not required (it also works). The file holds an access token at rest in the box —
  no refresh token. Using `CLAUDE_CODE_OAUTH_TOKEN` instead keeps it out of the box's disk but needs
  the restart.
- Host side: a running host CLI adopts a daemon-refreshed file before it would spend its own
  refresh token, so the broker refreshes an account a host-local Claude session holds — but only
  while the token has more than 10 minutes left (the CLI cannot be inside its own 5-minute window)
  and neither refresh lock is fresh. Otherwise it waits for the CLI.

## (b) Codex `app-server` with `chatgptAuthTokens`

JSON-RPC over stdio, fresh `CODEX_HOME`, no `auth.json`:

1. `initialize` `{clientInfo: {name, title, version}, capabilities: {experimentalApi: true, requestAttestation: false}}` → `{userAgent, codexHome, platformFamily, platformOs}`; then the `initialized` notification.
2. `account/login/start` `{type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType: null}` → `{type: "chatgptAuthTokens"}`; notifications `account/login/completed` `{loginId: null, success: true, error: null, onboardingEntrypoint: null}` and `account/updated` `{authMode: "chatgptAuthTokens", planType: "pro"}` (plan derived from the token's claims).
3. `account/read` → `{account: {type: "chatgpt", email, planType: "pro"}, requiresOpenaiAuth: true, workspaceRouting: {chatgptAccountId, backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT"}}`.
4. `thread/start` `{cwd, approvalPolicy: "never", sandbox: "read-only"}`, then two `turn/start` → both `turn/completed` `status: "completed"`.

**Refresh request.** Logged in with a token whose JWT signature was altered (claims readable, the
server rejects it), Codex sent the server → client request
`account/chatgptAuthTokens/refresh` with params `{reason: "unauthorized", previousAccountId: "<workspace id>"}`
right away (while validating the login, before `account/login/completed`). Answering
`{accessToken, chatgptAccountId, chatgptPlanType: null}` completed the login and both turns.
With a valid token there was no refresh request in two turns: Codex asks only after a 401 (no
proactive refresh seen). Managed Codex access tokens currently live about 10 days.

- `auth.json` is never written: the tokens stay in the app-server's memory. Nothing lands on disk.
- Without bubblewrap Codex emits a `configWarning` and uses its bundled sandbox helper; box images
  should install `bubblewrap`.
- Files: rollout `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<UTC time>-<threadId>.jsonl`; its first
  line is `session_meta` with `cwd: "/var/lib/orquester/workspaces/x/y"` (the absolute path) and
  `cli_version`, `originator`, `model_provider`, … State: `state_5.sqlite`,
  `thread_history_1.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`,
  `queue_1.sqlite` (each with `-wal`/`-shm`), `shell_snapshots/<threadId>.*.sh`,
  `thread-writer-locks/`, `models_cache.json`, `installation_id`.
- **Resume from synced rollouts:** only `sessions/` copied into a fresh `CODEX_HOME` (no SQLite),
  `thread/resume` `{threadId, cwd, approvalPolicy, sandbox}` → ok, `thread.turns.length === 2`; a
  new turn listed both earlier replies. The state databases were rebuilt by Codex. Spec §8.5's
  "rebuilt in the box, never copied" holds.

**A running host Codex re-reads `auth.json` before it spends its own refresh token** (verified in
the 0.163.0 source, `codex-rs/login/src/auth/manager.rs`): `refresh_token()` — its proactive
refresh, once the access token is inside its last 5 minutes — does a guarded reload first and skips
the refresh when the file changed; after a 401, `UnauthorizedRecovery` runs a `Reload` step before
its `RefreshToken` step. The reload is skipped (a permanent error) when the file's account id no
longer matches, so a daemon refresh must keep `tokens.account_id` and replace the file by rename.
The broker therefore refreshes a host-held Codex account like a Claude one: above the 10-minute floor.

## (c) Grok `auth_provider_command`

Config (`$GROK_HOME/config.toml`; also `GROK_AUTH_PROVIDER_COMMAND`):

```toml
[auth]
auth_provider_command = "/path/to/orq-agent-token-wrapper"
```

The command printed `{"access_token": "<grok.com subscription access token>", "expires_in": <seconds>}`.

- **A sign-in is required first.** Headless `grok -p` with no stored credential does not run the
  provider: `Error: Not signed in. To authenticate without a browser, run: grok login --device-code`.
  `grok login </dev/null` runs the provider once (`GROK_AUTH_EXPIRED` unset) → `✓ Signed in as <email>`.
  Over ACP (`grok agent stdio`, as the adapter runs it): `session/new` → error `-32000`
  `Authentication required` (`data: "no auth method id provided"`); `initialize` lists
  `authMethods: [{id: "grok.com"}]` (plus `{id: "cached_token"}` once a credential is stored);
  `authenticate` `{methodId: "grok.com"}` runs the provider and returns
  `_meta.auth_mode: "External"`, `subscription_tier: "supergrok_heavy"`; then sessions and prompts
  work (`grok-4.7`). The box adapter must authenticate this way (or run `grok login` once) before
  `session/new`.
- Prompts run on the subscription: `grok -p` answered with `grok-4.7-build`; ACP prompts with `grok-4.7`.
- **Grok stores the provider's output** in `$GROK_HOME/auth.json` (mode 0600): `key`,
  `expires_at`, identity fields — **no `refresh_token`**. An access token therefore sits on the
  box's disk while Grok runs (the same exposure as Claude's credentials-file variant).
- **Headless refresh:** with `expires_in: 320` (default early invalidation 300 s) a running ACP
  session re-ran the command with `GROK_AUTH_EXPIRED=1` ~33 s after sign-in, between two prompts;
  both succeeded. Docs: on `GROK_AUTH_EXPIRED=1` the command must not prompt and gets a few seconds;
  on failure Grok falls back to the sign-in flow.
- A running Grok and a rewritten `auth.json`: with a valid token in memory, rewriting the file with
  an invalid key (even with a later `expires_at`) changed nothing — later prompts kept working. When
  it started with an invalid key and the file was then rewritten with the valid one, the next prompt
  succeeded: it re-reads the file after a 401. Its docs ("Hot Reload") say external `auth.json`
  changes are picked up. **It re-reads before spending its own OIDC refresh token** (1.0.67's own log
  lines; the binary is closed): it refreshes under `auth.json.lock` ("could not acquire auth.json.lock
  within timeout" → "returning transient to avoid refresh token reuse"), "disk has valid AT, adopting
  instead of consuming RT", after a 401 "disk has a different token, accepting", and after a lost
  race "adopted sibling token after PermanentFailure". It refreshes on its own 5 minutes before
  expiry (`GROK_AUTH_EARLY_INVALIDATION_SECS`, default 300).
- Issuer/client keys are not needed by the command's output.

## (d) Paths

- Claude: cwd `/var/lib/orquester/workspaces/x/y` → `$CLAUDE_CONFIG_DIR/projects/-var-lib-orquester-workspaces-x-y/<sessionId>.jsonl`,
  the same encoding the host uses (`projects/-var-lib-orquester-workspaces-jaspersito-…`); each
  line's `cwd` is the path as given (`realpath` was identical on this Linux box). macOS
  (`/private/var`) was not part of this spike.
- Codex: see (b) — absolute cwd in `session_meta`, date-sharded rollouts, SQLite rebuilt on resume.
- Grok: `$GROK_HOME/sessions/<percent-encoded cwd>/<sessionId>/` (e.g.
  `%2Fvar%2Flib%2Forquester%2Fworkspaces%2Fx%2Fy/<id>/{prompt_context.json, tool_definitions.json, usage.json, system_prompt.txt, …}`)
  plus `prompt_history.jsonl` per cwd.

## What the broker does with this

| CLI | Host-local session holds the account and the token is short |
|---|---|
| Claude | Daemon refreshes (`refreshNow` with `allowHeld`) when > 10 min are left; below that it hands out the current token while > 5 min are left and it was not rejected, else refreshes. While the CLI's refresh lock is fresh: no refresh — the current token if usable, else waits for the CLI's rewrite. |
| Codex | Same as Claude (no refresh lock to check). |
| Grok | Same as Codex. |

The hourly refresher renews a held account of these CLIs too, once its token is inside
`HELD_REFRESH_MARGIN_MS` (85 min) and above the 10-minute floor — a window longer than one tick — so
while the daemon runs a held token never runs down to where only its CLI renews it. A daemon refresh
that gets `invalid_grant` for a refresh token the file no longer holds lost a race to a CLI: it reads
as that CLI's refresh, not as a login to redo.

With no host-local holder the daemon refreshes on demand. Box sessions never count as holders.

## Nothing found impossible

All three CLIs run with an access token only. Two design points need adjusting by the adapter
tracks: (1) Claude's env-token variant changes the default model — use the credentials file or an
explicit model; (2) Grok needs an explicit `authenticate {methodId: "grok.com"}` and writes the
access token to `auth.json` in the box.

## Spend

Hetzner `cx23` in `fsn1` at €0.0088/h gross for about 15 minutes (billed as one hour), plus its
primary IPv4: about €0.01 (≈ $0.01). Inference ran on the accounts' subscriptions.
