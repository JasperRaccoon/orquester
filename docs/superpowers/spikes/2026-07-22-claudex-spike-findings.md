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

## F4 — Codex/GPT credentials: **BLOCKED (needs conversion or device-login)**

The managed Codex account is standard Codex-CLI `auth.json`
(`{auth_mode, tokens:{id_token, access_token, refresh_token, account_id}, last_refresh}`).
CLIProxyAPI stores its own `codex-*.json` in the auth-dir in a different schema; there is no
documented one-step import, and a `GET /v0/management/status` probe returned 404 (management
API surface/path unconfirmed). Not resolved in this pass. Phase-2 sub-spike needed to either
(a) map the Codex-CLI blob → CLIProxyAPI's codex JSON, or (b) drive `-codex-device-login` /
the management `codex-auth-url` flow. The GPT main path (spec §8.2/§8.3) is therefore
**unverified** — but F1 proves the *transport/harness* half; only the credential-seeding half
is open.

## F5 — Claude-OAuth main loop through the proxy (claudemix precondition): **NOT TESTED**

Same credential-seeding blocker as F4 (managed `.credentials.json` → CLIProxyAPI Anthropic
provider format unconfirmed). Deferred to the same Phase-2 sub-spike.

## F6 — `go` toolchain absent on vps-a

`go` is not installed and `deploy/provision-devtools.sh` does not install it. If the
source-build path survives F3's recommendation, provisioning must fetch a pinned toolchain;
if F3's "ship stock binary" recommendation is taken, **this gap disappears entirely**.

## F7 — Cross-model routing (§8.1, claudemix core): **NOT TESTED**

Requires ≥2 live providers in one catalog (e.g. kimi + a gpt model); only OpenRouter was
authenticated this pass (F4/F5 blocked). `CLAUDE_CODE_SUBAGENT_MODEL` was exercised only
single-model. The `agent({model})` / frontmatter routing that claudemix depends on needs the
Codex/Claude providers live first — carried into the Phase-2 sub-spike.

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
| F4 | Codex/GPT credential seeding | BLOCKED — Phase-2 sub-spike |
| F5 | Claude-OAuth main loop | NOT TESTED — same blocker |
| F6 | `go` toolchain | absent; likely moot per F3 |
| F7 | Cross-model routing | NOT TESTED — needs 2 providers |

**Net:** the transport/harness core is proven and simpler than feared (Kimi needs no patch
under Claude Code). The open risk collapsed to one thing: **seeding Codex/Claude OAuth into
the proxy** (F4/F5) — a focused sub-spike that gates the GPT and claudemix paths, while the
Kimi escape-hatch and all F1-proven mechanics can proceed on the stock binary.
