# claudex Spike Findings (Task 0)

Date: 2026-07-23 · Environment: vps-a (this VPS) · CLIProxyAPI **v7.2.95** linux amd64
(sha256 `826604e2…c7a9fd5`) · driver: Claude Code CLI at `/var/lib/orquester/.local/bin/claude`

Scope run: OpenRouter/Kimi path exercised end-to-end (no OAuth needed — plain key from
OpenCode's store). Codex/Claude OAuth paths partially blocked (see F4/F5). All work under
`~/cliproxy-spike/`, proxy on `127.0.0.1:8317`; the live daemon was never touched.

---

## F1 — Chain works end-to-end (Claude Code → CLIProxyAPI → OpenRouter/Kimi): **CONFIRMED**

`/v1/models` returned `kimi-k3` (aliased from `moonshotai/kimi-k3`). A stock
`claude --model kimi-k3 -p "Reply with exactly: claudex-kimi works."` pointed at the proxy
via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` returned exactly that. Interactive tool use
(Read/Edit) works. The community-guide approach is sound on a headless server. The env set
from spec §2 (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`, `ENABLE_TOOL_SEARCH=false`, `CLAUDE_CONFIG_DIR`) drives
it correctly.

## F2 — Config-hashing behavior (the `secrets.json` rationale): **CONFIRMED WITH A CORRECTION**

On startup the proxy rewrote `config.yaml`:
- `remote-management.secret-key` → **bcrypt-hashed in place** (`$2a$10$…`). So the management
  secret genuinely cannot be read back from `config.yaml` after first startup — **`secrets.json`
  IS required** for management-API auth across restarts. Spec §1's core rationale holds.
- `api-keys` (the local key claudex sessions send as `ANTHROPIC_AUTH_TOKEN`) → **left
  plaintext**.
- `openai-compatibility` provider key (OpenRouter) → **left plaintext**.

**Spec correction:** the Security-section framing "config.yaml holds only projected/hashed
forms" is too broad — only the management secret is hashed; the local API key and provider
keys stay readable in `config.yaml`. `secrets.json` as the authoritative store is still the
right design (single source, avoids parsing config back), but the *justification* ("can't
read it back") applies specifically to the management secret. Update §1/§Security to say so.

## F3 — Kimi empty-content bug: **PRESENT IN SOURCE, DOES NOT TRIGGER UNDER CLAUDE CODE** (major)

The bug **is** in the v7.2.95 translator (`internal/translator/openai/claude/openai_claude_request.go`,
assistant-message branch ~L246-250): when an assistant turn has no text content it does
`sjson.SetBytes(msgJSON, "content", "")` regardless of `tool_calls` — the exact
`content: ""` shape Moonshot rejects.

**But it did not reproduce.** A shallow (5 tool calls) loop AND a deep loop (12 reads + 12
edits, 30+ tool calls, well past the "position 36" of the original OpenCode report) both
completed cleanly — **zero** `must not be empty` / 400 errors in the proxy log; files were
actually edited (11–12/12 "reviewed").

Mechanism (from the code): the empty-content path only fires when `hasContent == false`, i.e.
a **bare** tool-call turn with no accompanying text. **Claude Code pairs preamble text with
its tool calls** (`hasContent` true), so the branch isn't hit. OpenCode emitted bare tool-call
turns, hitting it constantly — which is why the original report was OpenCode-specific.

**Plan impact (significant):** for the Claude Code harness specifically, the patched-source
build is **not required for the main Kimi path**. Recommendation for Phase 2:
- **Ship the stock release binary** (drop the Go-toolchain fetch + source-build + patch-apply
  machinery from the critical path — also resolves the `go` MISSING gap on this box, F6).
- Keep the one-line translator fix documented in-repo as **defense-in-depth**, applied only if
  a real `content:""` 400 is ever observed (e.g. from a subagent that emits a bare tool call).
  Gate it behind an observed failure, not day-one.
- Re-verify against whatever CLIProxyAPI version is pinned at implementation time (the bug line
  could change upstream).

This removes the single largest source of Phase-2 complexity (§7 build pipeline, §1 hermetic
Go build, the whole `bin.prev/src/go` apparatus can become "download + verify release binary").

## F4 — Codex/GPT credential seeding: **RESOLVED — pure file conversion, no browser flow**

The sub-spike proved the managed Codex account can be seeded into the proxy by converting its
`auth.json` into CLIProxyAPI's `CodexTokenStorage` schema and dropping the file in `auth-dir`.
CLIProxyAPI auto-discovers it; **no device-login / browser OAuth needed.**

Field mapping (from `internal/auth/codex/token.go` @ v7.2.95):

| CLIProxyAPI `CodexTokenStorage` | Source (managed Codex `auth.json`) |
|---|---|
| `id_token` | `tokens.id_token` |
| `access_token` | `tokens.access_token` |
| `refresh_token` | `tokens.refresh_token` |
| `account_id` | id_token claim `https://api.openai.com/auth`.`chatgpt_account_id` (or `tokens.account_id`) |
| `last_refresh` | `last_refresh` |
| `email` | id_token claim `email` |
| `type` | literal `"codex"` |
| `expired` | RFC3339 of the access_token JWT `exp` |

Result: `/v1/models` served the full GPT catalog — **`gpt-5.6-sol`, `gpt-5.6-luna`,
`gpt-5.6-terra`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`** — and a real
`claude --model gpt-5.6-sol -p …` returned correctly. The access token was valid ~9 days, so
**no refresh fired and the managed account's refresh token was never rotated** (the auth files
were never rewritten) — confirming the dual-refresher hazard is avoidable by seeding while the
access token is fresh.

## F5 — Claude-OAuth main loop through the proxy (claudemix precondition): **RESOLVED**

Same approach for Claude, converting the managed `.credentials.json` into `ClaudeTokenStorage`
(`internal/auth/claude/token.go`): `access_token`←`claudeAiOauth.accessToken`,
`refresh_token`←`claudeAiOauth.refreshToken`, `expired`←RFC3339 of `claudeAiOauth.expiresAt`
(ms→s), `type`=`"claude"`; `id_token`/`email` may be blank. `/v1/models` then served the
Claude family (`claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8`, …) **alongside** the GPT
and Kimi models — proving the **single-instance two/three-provider catalog claudemix depends
on**. A functional `claude --model claude-sonnet-4-5-20250929 -p …` routed through the seeded
Claude OAuth and replied correctly. Used the *second* Claude account (not the one running the
session); its token was fresh (~7.5 h) so no rotation occurred.

**Net for F4/F5:** the entire "seed from existing managed accounts" story works with **zero
browser interaction** — a pure format conversion the daemon can do at enable-time. This is
strictly better than device-login for UX. Two caveats for Phase 2: (1) seed while the source
access token is fresh, or explicitly accept a one-time managed-account re-import if the proxy
refreshes first (dual-refresher); the cleaner long-term design is for the proxy to *own* the
credential and Orquester to stop refreshing that account, or to share one credential store.
(2) The management API `status` path 404'd, but it was **not needed** — file-drop seeding
sidesteps the management API entirely.

## F6 — `go` toolchain absent on vps-a

`go` is not installed and `deploy/provision-devtools.sh` does not install it. If the
source-build path survives F3's recommendation, provisioning must fetch a pinned toolchain;
if F3's "ship stock binary" recommendation is taken, **this gap disappears entirely**.

## F7 — Cross-model routing (§8.1, claudemix core): **CATALOG PROVEN; in-session routing still to verify**

The three-provider catalog is proven: one CLIProxyAPI instance seeded with Codex + Claude +
OpenRouter served `gpt-5.6-sol`, `claude-fable-5`/`claude-sonnet-5`, and `kimi-k3` from a
single `/v1/models`, and each was individually driven by `claude --model <x> -p`. What remains
(needs the daemon integration, not a raw-CLI spike) is confirming that *inside one Fable
session* a Workflow `agent(prompt, {model:"gpt-5.6-sol"})` / `{model:"kimi-k3"}` (or a
frontmatter-pinned subagent) actually routes per-subagent — i.e. spec §8.1's model-string
channel. The transport is now proven on all three families; only the harness-level routing
knob is unverified, and that is best checked once `claudemix` launches against the daemon.

## Cost note (§8.3)

The 30-minute real-subscription cost measurement was intentionally **not** run autonomously
(spends real quota). Defer to an explicitly-authorized measurement once GPT is seeded.

---

## Verdicts summary

| # | Item | Verdict |
|---|------|---------|
| F1 | Claude Code → proxy → Kimi chain | CONFIRMED |
| F2 | Config hashing / secrets.json need | CONFIRMED (mgmt secret) + spec correction (api/provider keys plaintext) |
| F3 | Kimi empty-content bug | PRESENT in source, does NOT trigger under Claude Code → **drop source-build from critical path** |
| F4 | Codex/GPT credential seeding | RESOLVED — file conversion, no browser flow; gpt-5.6-sol functional |
| F5 | Claude-OAuth main loop | RESOLVED — file conversion; claude-sonnet-4-5 functional |
| F6 | `go` toolchain | absent; **moot** per F3 (ship stock binary) |
| F7 | Cross-model routing | catalog PROVEN (gpt+claude+kimi in one instance); in-session routing pending daemon integration |

**Net:** every open risk is now resolved or de-risked. The transport/harness core is proven on
all three provider families (GPT, Claude, Kimi), credential seeding works from existing managed
accounts with **zero browser flow** (pure file conversion), and Kimi needs **no** patch under
Claude Code. Phase 2 can drop the entire Go-toolchain/source-build apparatus (ship the stock
release binary) and implement credential seeding as a format conversion at enable-time. The
single remaining check — in-session per-subagent model routing (§8.1) — is a daemon-integration
verification, not a proxy unknown.

## Phase-2 shaping (net recommendations)

1. **Ship the stock CLIProxyAPI release binary** (verify SHA-256), not a source build. Delete
   §7's build pipeline, §1's hermetic-Go apparatus, and the `src/`+`go/`+patch machinery from
   the plan. Keep the one-line translator patch documented as defense-in-depth, applied only if
   a real `content:""` 400 is ever observed.
2. **Credential seeding = file conversion at enable-time** (F4/F5 mappings above), not
   device-login. Offer device-login only as a fallback for accounts not already in Orquester.
   Resolve the dual-refresher question by making the proxy the sole owner of its seeded copy (or
   sharing one store) — do not leave Orquester and the proxy both refreshing the same token.
3. **Correct the spec's secret framing** (F2): only the management `secret-key` is hashed;
   `api-keys` and provider keys stay plaintext in `config.yaml`. `secrets.json` remains the
   right authoritative store, but the justification is the management secret specifically.
4. The cost measurement (§8.3) is still deferred pending explicit go-ahead (spends quota).
