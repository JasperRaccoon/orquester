# ORQ-2 — Agent plumbing around the session (everything that is not the PTY itself)

Repo: `/var/lib/orquester/workspaces/jaspersito/orquester` · branch `main` @ `07683b2`
Scope: registry/catalog, managed accounts + HOMEs, managed hooks, the model proxy
(cliproxy), conversations/resume, the MCP surface, browser-pick, session upload, usage.

Read this alongside `AGENTS.md`. Everything below is cited to file:line. Where I state
something the codebase does **not** say (e.g. an agent's programmatic protocol), it is
explicitly marked **[inferred — general knowledge, not from this repo]**.

---

## 0. The one-paragraph answer

The daemon's agent plumbing is, with three exceptions, **not** coupled to the PTY. It is a
pile of *file-system and environment-variable side effects* applied to a child process
immediately before it is spawned: point `$HOME`-ish config vars at a chosen directory,
write hook scripts + config JSON into that directory, write an `.env` file the registry
merges into the launch env, and then `exec` the CLI. Everything in that pipeline transfers
verbatim to a GUI/protocol-driven agent process, because a `claude -p --output-format
stream-json` child reads exactly the same `CLAUDE_CONFIG_DIR`, the same `settings.json`,
the same `.credentials.json` and the same `ANTHROPIC_BASE_URL`.

The three genuinely PTY-coupled things are: **(1)** the activity/attention state machine's
byte-stream fallback (`ansi-activity.ts`), **(2)** every "put this in front of the agent"
delivery path — session upload, browser-pick, `initialCommand` — which are all *bracketed
pastes typed into the pane*, and **(3)** the daemon's own MCP terminal-control tools, which
exist to let a remote agent drive an Orquester pane and are therefore PTY-shaped by
definition.

---

## 1. Per-agent launch, today

### 1.1 How a launch is assembled (the generic path)

1. `POST /api/sessions` (`apps/daemon/src/index.ts:3532`) validates `initialCommand`
   (`:3539-3552`), resolves the per-launch `model` — **claudex/claudemix only**
   (`:3553-3560`, `resolveLaunchModel` at `:1083`), refuses an unusable
   `resumeConversationId` with `RESUME_UNAVAILABLE` (`:3565-3573`), and gates a
   proxy launch that pins an unseeded managed account (`:3583-3602`).
2. `SessionManager.create` (`apps/daemon/src/sessions.ts:291`) looks the entry up in the
   runtime registry (`:292-295`) and calls the injected `resolveExtraEnv` seam
   (`:307-320`) — wired at `index.ts:395-414` to `buildAgentLaunchEnv`
   (`index.ts:1064-1075`), which composes three contributors:
   `agentAccounts.resolveLaunchEnv` + `claudeTimeoutEnv` + `cliproxyContributor`.
3. Base env: `TERM=xterm-256color`, `COLORTERM=truecolor`, plus the registry entry's own
   static `env` (`sessions.ts:369-373`). For `kind === "agent"` it also sets
   `ORQUESTER_SESSION_ID` and `ORQUESTER_DAEMON_SOCK` (`sessions.ts:375-379`) — these two
   are the *entire* hook transport contract.
4. `await onAgentLaunch(entry, extraEnv)` (`sessions.ts:383`) → `AgentHooks.ensureForEntry`
   (`index.ts:416`) installs the managed hooks into whatever config dir the resolved env
   points at, **before** the process spawns.
5. `buildLaunchCommand` (`sessions.ts:159-196`) = `resolvedBin` + `entry.args` +
   `resumeArgs` last (`:173-175`); `launchViaShell` entries get wrapped in a real login
   shell (`:177-193`).
6. The *addon* env (account/proxy credentials) is **not** passed via `tmux -e` because that
   is argv-visible; instead `writeAddonEnvLaunchScript` (`sessions.ts:225-267`) writes a
   0600 one-shot `/tmp/orquester-launch-*/launch.sh` that `unset`s + `export`s and
   `exec`s the real command, self-deleting on first line (`:250-252`).
7. `tmux.newSession` spawns it detached; the daemon attaches a streaming PTY
   (`sessions.ts:403`, `attach()` at `:439`). The pane inherits `sessionEnvBase()` — the
   daemon's env minus `TMUX`/`TMUX_PANE` and minus every `ORQUESTER_*` secret
   (`apps/daemon/src/tmux.ts:210-223`).
8. `initialCommand`, if any, is **typed** into the pane as keystrokes (`sessions.ts:425-428`,
   `initialCommandKeys` at `:59-62`).

### 1.2 The catalog, agent by agent

All from `packages/registry/src/index.ts` (static data) materialized by
`apps/daemon/src/registry.ts:135-150`. Every entry additionally picks up
`<appdir>/daemon/env/<id>.env` automatically if present (`registry.ts:408-418`,
`defaultEnvFilePath` `:489-494`) — this is how `claudex.env` / `claudemix.env` /
`opencode.env` reach the launch. Env values are redacted from `/api/registry`
(`publicEntry`, `registry.ts:505-508`).

| id | bin | args | static env | resumeArgs | install/update | managed HOME | hooks | usage |
|---|---|---|---|---|---|---|---|---|
| `claude` | `claude` (`:56`) | `--dangerously-skip-permissions --effort max --verbose` (`:59`) | `CLAUDE_CODE_NO_FLICKER=1` (`:62`) | `--resume {id}` (`:71`) | native installer `curl https://claude.ai/install.sh` (`:68`), `claude update` (`:70`) | `CLAUDE_CONFIG_DIR` (`agent-accounts.ts:209`) | yes (claude family) | yes |
| `codex` | `codex` (`:77`) | `--yolo` (`:78`) | — | `resume {id}` *subcommand* (`:83`) | `npm i -g @openai/codex` (`:80`) | `CODEX_HOME` (`agent-accounts.ts:214`) | yes | yes |
| `grok` | `grok` (`:161`) | `--yolo` (`:162`) | `GROK_DISABLE_AUTOUPDATER=1` (`:165`) | `--resume {id}` (`:170`) | `npm i -g @xai-official/grok` (`:167`) | `GROK_HOME` (`agent-accounts.ts:212`) | yes | yes |
| `opencode` | `opencode` (`:150`) | — (`launchViaShell: true`, `:151`) | — (+ `opencode.env` file) | `--session {id}` (`:155`) | `npm i -g opencode-ai` (`:153`) | **no** (only `OPENCODE_CONFIG_DIR` honoured if already in env, `agent-hooks.ts:216`) | yes (JS plugin) | no |
| `gemini` | `gemini` (`:128`) | — | — | **none** | `npm i -g @google/gemini-cli` (`:130`) | no | **no** | no |
| `cline` | `cline` (`:89`) | — | — | `--id {id}` (`:93`) | `npm i -g cline` (`:91`) | no | no | no |
| `kimi` | `kimi` (`:135`) | — | — | `--session {id}` (`:144`) | `curl code.kimi.com/…/install.sh` (`:141`), `kimi upgrade` (`:143`) | no | no | no |
| `agy` (Antigravity CLI) | `agy` (`:178`) | — | — | `--conversation {id}` (`:183`) | `curl antigravity.google/cli/install.sh` (`:180`), `agy update` (`:182`) | no | no | no |
| `deepcode` | `deepcode` (`:119`) | — | — | none | `npm i -g @vegamo/deepcode-cli` (`:121`) | no | no | no |
| `deepseek` | `deepseek` (`:110`) | — | — | none | **detect-only on purpose** (`:96-106`) | no | no | no |
| `claudex` | `claude` (`:192`) | `--dangerously-skip-permissions --effort high --verbose` (`:196`) | `CLAUDE_CODE_NO_FLICKER=1` + generated `claudex.env` | **none** (`enabledAtRest:false`, `:199`) | — | `CLAUDE_CONFIG_DIR=<cliproxy>/claude-home-claudex` (`index.ts:973`) | yes (claude family) | n/a |
| `claudemix` | `claude` (`:205`) | same as claudex (`:209`) | same + `claudemix.env` | none | — | `claude-home-claudemix` | yes | n/a |

Notes worth carrying into the design:

- **`resumeArgsFor` / `canResumeAgent`** (`packages/registry/src/index.ts:369-393`) are the
  single shared gate; `claudex`/`claudemix` deliberately have **no** `resumeArgs`, which is
  why their transcripts are filtered out of both resume surfaces
  (`packages/ui/src/lib/resume-account.ts:38-54`).
- **Only `claudex`/`claudemix` accept a per-launch `model`** — every other id 400s
  (`index.ts:1096-1099`).
- `enabledAtRest:false` + `RegistryService.setRuntimeState` (`registry.ts:230-239`) is how
  the CliProxyManager turns the two proxy launchers on/off at runtime;
  `computeEnabled` (`registry.ts:373-383`) is the single source of truth.
- `install()`/`update()` shell out with `exec()` and a 10-minute timeout
  (`registry.ts:558-566`) — no PTY involved. Version detection is `"<bin>" --version`
  (`registry.ts:347-357`).
- `gemini`, `cline`, `kimi`, `agy`, `deepcode`, `deepseek` have **zero** code outside the
  catalog row. A repo-wide grep for their ids finds only the catalog, the conversation
  listers, and two UI icon-name helpers.

### 1.3 Programmatic / headless protocols we could drive instead

**The codebase uses none of these today.** A repo-wide grep for `stream-json`,
`--output-format`, `app-server`, `--experimental-acp`, `opencode serve`, `--print`, `acp`
returns zero hits outside unrelated comments — every agent is launched as an interactive
TUI. The docs even say so explicitly for scaffolders
(`packages/registry/src/index.ts:474-487`: "TYPED INTO a fresh terminal tab … instead of
the daemon trying to capture headless output from a command that wants a TTY").

Everything in this subsection is **[inferred — general knowledge, not from this repo]**:

| agent | likely programmatic surface | notes |
|---|---|---|
| **Claude Code** (`claude`, and therefore `claudex`/`claudemix`) | `claude -p --output-format stream-json --input-format stream-json --verbose` (bidirectional NDJSON over stdio); the **Claude Agent SDK** (TS/Python) which is the same harness as a library; `claude mcp serve`; ACP adapters exist third-party. | Strongest option. Crucially the SDK/`-p` process reads the *same* `CLAUDE_CONFIG_DIR`, `settings.json`, `.credentials.json`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` — so §3's "already have" list transfers 1:1, including the whole cliproxy story. Hooks still fire in headless mode. |
| **Codex** (`codex`) | `codex exec --json` (one-shot, JSONL events) and `codex app-server` (persistent JSON-RPC over stdio — the protocol the IDE extension uses); `codex mcp` / `codex mcp-server`. | `app-server` is the right shape for a chat GUI. `CODEX_HOME` still selects the account. `codex exec resume <id>` mirrors the TUI resume. |
| **OpenCode** (`opencode`) | `opencode serve` exposes a local **HTTP + SSE** server with an OpenAPI schema; also an ACP mode. It is arguably the most GUI-friendly of the lot since it is *already* a client/server product. | Would make the daemon a client of opencode's server rather than a PTY owner. The existing `orquester-status.js` plugin (`agent-hooks.ts:594-678`) already runs inside opencode's JS runtime and talks to the daemon over the unix socket — that plugin transfers unchanged. |
| **Gemini CLI** (`gemini`) | `--output-format json`/`stream-json`, `-p/--prompt` headless mode, and `--experimental-acp` (Agent Client Protocol, the Zed-originated JSON-RPC agent protocol). | Gemini is currently the *least* integrated agent (no hooks, no resume, no accounts), so it would actually gain the most. |
| **Grok** (`grok`) | xAI's `grok` CLI has a non-interactive/`-p`-style mode and JSON output; no widely-documented persistent JSON-RPC server as of my knowledge. Lower confidence than the four above. | `GROK_HOME` + the hook file mechanism already give the daemon structural events, so a protocol port loses little. |
| **Cline** (`cline`) | The npm `cline` CLI is the headless face of the Cline extension; it has a host-bridge/gRPC protocol internally. Low confidence on a stable public JSON API. | |
| **Kimi Code** (`kimi`), **Antigravity CLI** (`agy`), **Deep Code** (`deepcode`) | Unknown / assume none. These are Claude-Code-alike harnesses; some ship a `-p`/print mode by convention but I would not design around it. | |
| **Cursor agent** (`cursor-agent`, not currently in the catalog) | Has a documented `--output-format stream-json`/`--print` headless mode and an MCP surface. | Would be a new catalog entry either way. |

The practical read: **Claude Code, Codex and OpenCode** (and Gemini via ACP) cover ~all of
the daemon's *integrated* agents — the ones with hooks, accounts, usage and resume. The
long tail (`kimi`, `agy`, `cline`, `deepcode`, `deepseek`) is catalog-only today and could
simply stay on the PTY path, or be dropped.

---

## 2. Subsystem-by-subsystem: PTY-coupled or not

| Subsystem | Verdict | What a GUI session must provide |
|---|---|---|
| Managed accounts / HOMEs (§2.1) | **agnostic** | pick an account; consume `{env, unset, accountId}`; report the held account id |
| Managed hooks (§2.2) | **agnostic** (and becomes redundant) | emit the same working/waiting/done classes natively |
| Activity / attention / push (§2.3) | **PTY-COUPLED** | produce `SessionActivity` (`state`, `attention`, `needsAttentionAt`) from protocol events instead of bells/titles/quiescence |
| Model proxy / cliproxy (§2.4, §2.4a) | **agnostic** | consume the same env; stay visible to `liveDependentSessionCount` |
| Conversations / resume (§2.5) | **agnostic** (listers), **small change** (launch) | call the protocol's resume/load-session instead of appending `--resume <id>` |
| MCP surface (§2.6) | **PTY-COUPLED by design** | re-express `read_terminal`/`write_input`/`send_keys`/`send_and_wait` as transcript-read / send-message / await-turn |
| Browser pick, Design Mode (§2.7) | **PTY-COUPLED (delivery)** | "send a message with attachments to session X" instead of a bracketed paste |
| Session upload (§2.8) | **PTY-COUPLED (delivery)** | "attach a file to the next message"; daemon-side storage reusable verbatim |
| `initialCommand` (§2.9) | **PTY-COUPLED** | "the first message of the conversation" |
| Usage / quota (§2.10) | **agnostic, confirmed** | nothing — only needs `liveAccountIds()` |
| Registry install/update/version (§1.2) | **agnostic** | nothing |

### 2.1 Managed agent accounts (`agent-accounts.ts`) — **protocol-agnostic**

Pure filesystem + env. `AgentAccountsService.resolveLaunchEnv(agent, accountId)`
(`agent-accounts.ts:189-215`) returns exactly one env var plus a list of vars to *unset*:

- claude → `CLAUDE_CONFIG_DIR=<home>`, unset `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `CLAUDE_CODE_OAUTH_TOKEN` (`:33`, `:209`)
- codex → `CODEX_HOME=<home>`, unset `OPENAI_API_KEY` (`:36`, `:214`)
- grok → `GROK_HOME=<home>`, unset `XAI_API_KEY` (`:39`, `:212`)

`home` = `<appdir>/daemon/agent-accounts/<family>/<uuid>/home` (`homePath`, `:87-89`),
0700, containing a `.orq-account` marker checked on every launch
(`agent-account-paths.ts:13-48` — rejects symlinked homes and wrong shapes).
Credential filenames: `.credentials.json` (claude), `auth.json` (codex, grok) (`:44`).

`syncAccountHome` (`:233-277`) is the interesting part — it makes a bare credential dir
look like a lived-in home so the CLI does not run its first-run wizard:

- claude: `seedClaudeConfig` copies the system `.claude.json` minus `oauthAccount`/`userID`
  and **forces `hasCompletedOnboarding: true`** (`:312-338`, specifically `:329-333`);
  symlinks `skills/`, `plugins/` (`:256-257`), shares `settings.json` by symlink
  (`:262`) and symlinks `projects/` back at the system history dir (`:265`).
- codex: symlinks `config.toml`, `hooks.json`, `sessions/` (`:270-272`) and copies the
  `.personality_migration` / `.sandbox_migration` marker files (`:273-275`).
- grok: symlinks `config.toml` (which carries `[compat.claude] hooks = false`),
  **`trusted_folders.toml` "keeps the workspace pre-trusted"** (`:240-244`), plus
  `hooks/`, `plugins/`, `skills/`, `sessions/` (`:247-251`).

Token refresh (`agent-account-refresh.ts`) is plain OAuth over `fetch`:
Claude `https://platform.claude.com/v1/oauth/token` (`:6-7`), Codex
`https://auth.openai.com/oauth/token` (`:11-12`), Grok `https://auth.x.ai/oauth2/token`
(`:15-17`). The refresher skips accounts a live session holds, via
`sessions.liveAccountIds()` (`sessions.ts:516-522`, selector `agent-account-refresh.ts:19-33`)
— the **only** session touchpoint, and it only needs a set of account ids, which a GUI
session would have just as easily.

**GUI requirement:** none. A GUI session needs to (a) pick an account, (b) get the same
env map, (c) report which account it is holding. All three are already API-shaped.

### 2.2 Managed hooks (`agent-hooks.ts`) — **protocol-agnostic, and strictly better off**

`agentFamily(entryId)` (`:16-31`) collapses `claude|claudex|claudemix → claude`,
`codex`, `opencode`, `grok`; anything else gets no hooks.

`ensureForEntry(entryId, launchEnv)` (`:184-206`) is awaited before spawn. It picks the
config dir from the *resolved launch env*, not from `$HOME` (`configTarget`, `:209-222`) —
so account-bound sessions get their hooks in the right home. Installs are idempotent,
coalesced per `entry:target`, and time-boxed to 5 s (`:47`, `:49-57`).

The transport is the load-bearing bit (`hookScript()`, `:85-103`): a `/bin/sh` script that
no-ops unless `$ORQUESTER_SESSION_ID` **and** `$ORQUESTER_DAEMON_SOCK` are set, then
`curl --unix-socket "$ORQUESTER_DAEMON_SOCK" POST /api/sessions/$ID/agent-event` with the
hook's stdin payload, and **always `exit 0`**. It is completely independent of how the
agent's UI is rendered.

Per-family install:

- **claude** (`:244-303`): merges a managed group into `settings.json` `hooks` for
  `UserPromptSubmit`, `PreToolUse*`, `PostToolUse*`, `PermissionRequest*`, `Notification`,
  `Stop` (`:267-274`). Replaces its own stale group in place, never touches user groups
  (`isManagedGroup` matches on the `agent-hook.sh` filename, `:76-78`). Refuses to write if
  the file is malformed (`:252-265`).
- **codex** (`:315-434`): writes `hooks.json` *and* the `[hooks.state."<key>"]` trust
  blocks in `config.toml` whose `trusted_hash` replicates codex-rs's
  `command_hook_hash` (`codexTrustHash`, `:522-532`). Refuses on multiline-TOML (`:332-336`).
- **opencode** (`:438-452`): writes `<configDir>/plugin/orquester-status.js`, a real
  OpenCode plugin (source at `:594-678`) that subscribes to `permission.asked`,
  `question.asked`, `session.status/idle/error` and POSTs over `node:http` to the socket.
- **grok** (`:462-476`): writes a solely-owned `<GROK_HOME>/hooks/orquester.json`
  (`grokHookDocument`, `:487-499`).

Route: `POST /api/sessions/:id/agent-event` is **unix-socket-only**
(`index.ts:3775-3797`), fail-open (204 on an unknown event, 404 on an unknown session).
It lands in `SessionManager.agentEvent` (`sessions.ts:571-582`) → `classifyAgentEvent`
(`agent-status.ts:9-24`) → `tracker.applyHookEvent`.

`classifyAgentEvent` per family (`agent-status.ts:42-107`) maps to three classes:
`working` / `waiting` / `done`. Claude's `PreToolUse` for `AskUserQuestion` is special-cased
to `waiting` (`:47-48`) because Claude auto-allows it; a generic `Notification` is only
`waiting` if its message regex-matches permission language (`:37-40`, `:51-52`). Grok's
`Stop` fires twice and only `reason:"end_turn"` counts (`:81-93`).

**GUI requirement:** none — in fact a protocol-driven session gets these state transitions
*natively* (stream-json/app-server events say exactly "tool call started", "awaiting
permission", "turn ended"), so the hook plumbing becomes an implementation detail rather
than an integration. The mapping table in `agent-status.ts` is the spec of what a GUI
session must produce.

### 2.3 The activity/attention state machine (`ansi-activity.ts`) — **PTY-COUPLED**

This is the single most PTY-bound subsystem. `ActivityTracker` (`:223`) fuses two signals:

- **Structural** hook events → `applyHookEvent` (`:316-335`): `working` clears attention,
  `waiting` sets `needs-input`, `done` sets `finished`.
- **Byte-stream heuristics** → `noteOutput(chunk)` (`:244-276`): a `BellScanner` (`:24`)
  parses the raw ANSI stream for BEL (`:50`) and OSC 0/2 window titles (`:140-148`);
  a bell raises `bell` attention, output is a "heartbeat" that keeps the session
  `working`, and 3 s of silence (`IDLE_MS`, `:155`) demotes it to `idle`. There is an
  elaborate "title-driven" mode (`:163`, `:182-186`) to stop a TUI spinner's repaints
  reading as endless work, plus echo-grace windows so the user's own keystrokes'
  echo doesn't wake a session (`:170`, `:180`).

`session.activity` events are broadcast to all clients and drive the Attention Center, the
tab dots, and Web Push (`index.ts:642-670`): structural hook attentions push per type;
**bells push only for agent sessions that have never delivered a hook event** (`:666`,
gated on `tracker.hasHookSource`, `ansi-activity.ts:240-242`). A process exit also raises
`finished` (`noteExit`, `:345`), stamped after the `session.exited` broadcast
(`sessions.ts:493-499`).

**GUI requirement:** a protocol session makes all of this *unnecessary* — the bell/title/
quiescence heuristics exist purely because a TUI emits no structured status. A GUI session
must still produce the same `SessionActivity` shape (`state` + `attention` +
`needsAttentionAt`) so the Attention Center, `Ctrl+Shift+A` cycling, tab dots and push
notifications keep working unchanged. Treat `applyHookEvent`'s three classes as the
contract; delete the byte-stream half.

Related PTY-fed feature (out of slice but same class): `UrlWatcher`
(`apps/daemon/src/url-watcher.ts:11-29`) scrapes dev-server URLs out of every session's
output stream (`index.ts:700-703`). A GUI session emits no such banner, so Design Mode's
URL suggestions would need another source (shell tabs still work).

### 2.4 The model proxy / cliproxy — **protocol-agnostic (env + files only)**

See §2.4a below for the full mechanical map. The summary from the launch side
(`cliproxyContributor`, `index.ts:967-1048`): for `claudex`/`claudemix` only, it sets

- `CLAUDE_CONFIG_DIR=<appdir>/daemon/cliproxy/claude-home-<entryId>` (`:973`)
- `ANTHROPIC_AUTH_TOKEN` read from the 0600 token projection, kept off argv (`:974-980`)
- `ANTHROPIC_MODEL` — the effective model, optionally prefixed `acc<hex>/` to pin one of
  several same-provider seeded credentials (`:1004-1006`), optionally suffixed `[1m]`
  to make Claude Code budget a 1M window for a prefixed claude id (`:1007-1019`)
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `compactEnvForModel` (`:1032-1044`)

…and the base URL + default model ride the generated `claudex.env`/`claudemix.env` that
the registry merges in (`registry.ts:408-418`).

Every one of those is an environment variable read by the Claude Code *harness*, which the
Agent SDK / `claude -p` reads identically. **Nothing here needs a terminal.**

Also purely env: `claudeTimeoutEnv` (`agent-timeout-env.ts:143-153`) sets
`API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`
for the whole claude family (keyed on `agentFamily`, `:144`) — the fix for Claude Code's
180 s no-bytes abort.

### 2.5 Conversations & resume (`agent-conversations.ts`) — **protocol-agnostic**

`listAgentConversations(projectPath, {daemonDir})` (`:65-84`) fans out one lister per
agent over a set of *home roots* (`agentHomeRoots`, `:157-199`): the system home
(`$CLAUDE_CONFIG_DIR`/`$CODEX_HOME`/`$GROK_HOME` or `~/.claude`, `~/.codex`, `~/.grok`,
`:160-162`), every managed account home (`:167-175`), and every
`cliproxy/claude-home-*` (`:176-187`), deduped by dir (`:188-197`).

Per-agent on-disk formats:

| agent | location | id |
|---|---|---|
| claude | `<home>/projects/<abs-path-with-/→->/<uuid>.jsonl` (`:210-241`) | filename stem |
| codex | `<home>/sessions/YYYY/MM/DD/*.jsonl` (`:315-330`, `:333-345`) | inside the file |
| grok | `<home>/sessions/<urlencoded-project>/<session>/summary.json` (`:469-502`) | `info.id` |
| kimi | `~/.kimi-code/session_index.jsonl` + per-session `state.json` (`:517-...`) | `sessionId` |
| opencode | `~/.local/share/opencode/opencode.db` — **stubbed `[]`** (`:563-566`) |
| cline | `~/.cline/data/db/sessions.db` — **stubbed `[]`** (`:568-571`) |
| antigravity | `~/.gemini/antigravity-cli/conversation_summaries.db` — **stubbed `[]`** (`:573-576`) |

The three stubs are SQLite and the daemon ships no native deps (`:11-12`). Gemini has no
lister at all.

Resume launch is two-layer: `resumeLaunchArgs` (`sessions.ts:208-218`) validates the id
against `/^[\w.][\w.\-/]*$/` with no `..` segment (`:206`, `:214`) and the route 400s
`RESUME_UNAVAILABLE` when the agent has no `resumeArgs` (`index.ts:3565-3573`).
Client-side, `resumeAccountId` (`packages/ui/src/lib/resume-account.ts:25-36`) decides which
managed identity the resume must launch under, and `isResumableConversation` (`:52-54`)
hides `cliproxy` rows because claudex/claudemix carry no `resumeArgs`.

**GUI requirement:** small and positive. The listers stay identical (they read files). The
*launch* changes from "append `--resume <id>` to argv" to "call the protocol's
resume/load-session method with `<id>`" — Claude Code's SDK and Codex's app-server both
have one. This is also the natural place to **fix the known `cliproxy` resume gap** noted
in `resume-account.ts:46-50`, since a protocol session addresses the home explicitly rather
than hoping a bare `claude --resume` finds the transcript.

### 2.6 The MCP surface (`apps/daemon/src/mcp/`) — **PTY-COUPLED by design**

This is *not* an MCP server the daemon installs into agents. It is the opposite: an MCP
server the daemon **exposes**, so an *external* agent can drive Orquester's tabs.

- Mounted as `POST /mcp`, MCP **Streamable HTTP, stateless**, a fresh `McpServer` built per
  request with an `AbortController` cancelling in-flight waits on disconnect
  (`mcp/server.ts:216-241`). 8 MiB body limit (`:218`).
- Registered **only on the remote/HTTP transport** (`index.ts:4400-4418`) — "the unix
  socket is unauthenticated, so full terminal drive must never be reachable there"
  (`:4400-4401`). It is in the `needsAuth` set (`index.ts:1641-1644`) and does **not**
  accept `?token=`.
- Tools (`mcp/server.ts:118-211`), grouped:
  - navigation: `list_workspaces`, `list_projects`, `list_tabs`, `list_launchers`
  - **terminal drive (PTY-shaped)**: `read_terminal` (`:138`), `write_input` (`:142`),
    `send_keys` (`:146`, "Enter, C-c, Up, Space, Tab, Escape"), `send_and_wait` (`:150`),
    `wait_for_idle` (`:154`), `create_tab` (`:158`), `close_tab` (`:162`),
    `wait_for_attention` (`:188`)
  - not PTY-coupled: `list_todos`/`create_todo`/`update_todo`/`delete_todo`/
    `toggle_todo_item`, `list_files`, `read_file`, `get_usage`
- The terminal tools go through the session-manager API, not raw streams:
  `sessions.captureText()` (`sessions.ts:550-560` → `tmux captureAnsi` + `renderText`) and
  `sessions.input(id, data, {programmatic:true})`. The `programmatic` flag
  (`sessions.ts:44-49`, honoured in `ansi-activity.ts:284-287`) exists so a tool that
  writes and then waits for a bell isn't blinded by its own write — a pure PTY artifact.

**How agents learn about `/mcp`: manually, by the user.** There is no code anywhere in
`apps/daemon` or `packages` that registers the daemon's own MCP URL into an agent config or
adds a CLI flag. The only `mcpServers` writes are **pass-through** of the user's existing
system list into a managed home (`agent-accounts.ts:333`, `cliproxy-files.ts:304` — both
`mcpServers: sys.mcpServers ?? existing.mcpServers ?? {}`). No `.mcp.json` is ever written.
The documented wiring is a hand-run `claude mcp add --transport http --scope user orquester
<URL> --header "Authorization: Bearer <CREDENTIAL>"` (`docs/terminal-control-mcp.md`, §1-§3).

**GUI requirement:** the terminal-drive half needs a decision. Either (a) keep shell tabs as
PTYs and scope these tools to them, or (b) re-express them against the GUI session model —
`read_terminal` → "read the conversation transcript", `write_input` → "send a message",
`send_keys`/`send_and_wait`/`wait_for_idle` → "send a message and await turn end",
`wait_for_attention` stays as-is (it already keys on `SessionActivity`). Option (b) is
*cleaner* than today: `send_keys` exists only because a TUI has no other way to answer a
permission prompt.

### 2.7 Browser pick / Design Mode — **PTY-COUPLED (injection path)**

Capture side is clean: the per-project headless Chromium gets an in-page picker installed
as a new-document script and an `Runtime.addBinding` named `__orquesterPick`
(`browsers.ts:502-505`, `:247-266`); the report is re-validated field-by-field daemon-side
by `clampBrowserPickPayload` (`browser-pick.ts:64-...`) with hard budgets (`:6-13`),
secret redaction (`:20-21`) and — critically — **control-byte stripping**:

```ts
// browser-pick.ts:29-33
// C0/C1 control chars minus \t and \n. Stripped because the picked payload is
// delivered into a PTY as a bracketed paste (\x1b[200~…\x1b[201~\r); a raw ESC
// in page text (e.g. the sequence \x1b[201~) would break out of the paste and
// let the following bytes run as typed keystrokes — a command injection.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
```

Delivery side is entirely client-driven and entirely PTY-shaped
(`packages/ui/src/components/browser/PickComposeSheet.tsx`): upload each screenshot PNG
to the target session (`:78`), format a markdown blob (`formatDesignFeedback`, `:87`), then

```ts
// PickComposeSheet.tsx:88
await api.sendSessionInput(targetId, `\x1b[200~${markdown}\x1b[201~\r`);
```

— one bracketed paste **with a trailing `\r`**, i.e. it submits. The target picker only
offers `kind === "agent"` sessions in the same project that are `running` (`:27-30`).

**GUI requirement:** replace with "send a message with attachments to session X". The
entire `CONTROL_RE` / bracketed-paste / escape-injection defence disappears, because a
structured `{role:"user", content:[{text}, {image}]}` message has no escaping surface at
all. This is the single clearest *win* of the migration.

### 2.8 Session file upload — **PTY-COUPLED (injection path)**

`POST /api/sessions/:id/upload` (`index.ts:3809-3845`) takes a raw
`application/octet-stream` body with `name`/`type` in the query, streams it to a temp file
and renames it into `<appdir>/daemon/uploads/<sessionId>/` (`sessionUploadsDir`,
`index.ts:4482`; dir created 0700 at `:3828`). The daemon owns the final basename entirely
(`uploadFileName`, `:4507-4517`: directory components stripped, charset reduced to
`[A-Za-z0-9._-]`, always prefixed with 8 hex chars — "never contain spaces (no shell
quoting needed)"). The response is the **absolute daemon-side path** (`:3841`). The dir is
deleted when the session exits/closes (`:628-635`, `removeSessionUploads` `:4534`) and
orphans are swept at boot (`:617-620`).

The agent is then told about the file by *typing the path into the pane*:

```ts
// packages/ui/src/lib/session-upload.ts:33-37
export function injectionForPaths(paths: string[]): string {
  const joined = paths.join(" ");
  return `\x1b[200~${joined}\x1b[201~`;   // bracketed paste, NO trailing Enter
}
// :91-92
await api.sendSessionInput(sessionId, injectionForPaths(paths));
```

No `\r` here on purpose — the path is *inserted* into the agent's prompt and the human
presses Enter (`:20-23`). Callers: the desktop terminal drag/paste handler and the mobile
attach button. The comment at `index.ts:3800-3802` states the contract: the daemon never
notifies the agent; injection is 100 % client-side.

**GUI requirement:** "attach a file to the next message". The daemon-side half (streaming
upload, sandboxed naming, lifecycle cleanup) is reusable verbatim; only the last line
changes. Note that agents differ in whether they want a path or inline bytes — Claude
Code's stream-json input accepts image content blocks directly **[inferred]**, which would
let us skip the on-disk hop for pasted screenshots.

### 2.9 `CreateSessionRequest.initialCommand` — **PTY-COUPLED**

Typed into the fresh pane as keystrokes (`sessions.ts:425-428`), bounded to 4096 chars and
no control bytes (`index.ts:3539-3552`). This is how project templates scaffold
(`packages/registry/src/index.ts:474-487`) and how the UI pre-fills a first prompt. For a
GUI agent session the equivalent is "the first message of the conversation"; for shell tabs
it must stay as-is.

### 2.10 Usage / quota — **protocol-agnostic, confirmed**

Confirmed: **nothing** in the usage path reads a PTY, terminal scrollback or session
output. Two source kinds only:

- **HTTP to first-party endpoints**: Claude `GET https://api.anthropic.com/api/oauth/usage`
  (`usage-sources.ts:8`, fetched `:76-83`); Codex
  `GET https://chatgpt.com/backend-api/wham/usage` (`:9`, `:508`); Grok
  `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (`:10`, `:307`) with
  spoofed first-party headers pinned at `GROK_CLIENT_VERSION = "0.2.118"` (`:14`,
  `:257-268`) — the endpoint 426s without them.
- **Files in an agent HOME**: credentials come from `<claudeHome>/.credentials.json`
  (`:39-51`), `<codexHome>/auth.json` (`:478-507`), and for grok a 3-tier precedence —
  proxy-owned `cliproxy/auth/xai-*.json` → managed grok account homes → the grok CLI's
  `~/.grok/auth.json` (`readGrokCredential`, `:152-207`). Codex's *fallback* scrapes the
  newest `<codexHome>/sessions/**/rollout-*.jsonl` (`:332-387`, `usage-parse.ts:251-266`)
  — the agent's own transcript log, not terminal output.

Multi-account fan-out polls the System home plus every managed account home
(`index.ts:481-525`) and folds with `aggregateWorstAccountUsage` (`:278-332`). The
token-cost scanner (`usage-tokens.ts`) walks `<claudeHome>/projects/**/*.jsonl` and
`<codexHome>/sessions/**/*.jsonl` incrementally by mtime/offset (`:336-364`, `:385-431`),
fed by `fs.watch` on those roots (`index.ts:559-588`).

The **only** session touchpoint in the entire usage subsystem is
`sessions.liveAccountIds()` (`index.ts:504`) → `ensureFreshForUsage`, so an idle account's
single-use refresh token isn't rotated while a live session holds it. That needs a set of
account ids, nothing more.

Usage exists for `claude`, `codex`, `grok` only
(`packages/ui/src/components/topbar/usage-format.ts:9`).

**GUI requirement:** none. This subsystem is untouched by the migration.

---

## 2.4a The model proxy (cliproxy), in mechanical detail

*(See §2.4 for the launch-side summary. Verdict up front: **almost all of this is
env-vars-and-files and transfers unchanged to a protocol-driven Claude Code.**)*

### File roles

| File | Role |
|---|---|
| `cliproxy.ts` (1940 L) | `CliProxyManager` — serialized state machine: state/secrets load, boot adoption, enable/disable, spawn/health/respawn, seeding, router CRUD, xAI link |
| `cliproxy-files.ts` (598 L) | All **projections**: `config.yaml`, `token`, `env/claudex.env`, `env/claudemix.env`, the two shell wrapper bins, and `seedHome()` |
| `cliproxy-secrets.ts` | `secrets.json` (0600) load/generate/mutate; fail-closed on corruption |
| `cliproxy-seed.ts` | Pure credential converters managed-account ⇄ CLIProxyAPI auth-file; `accountPrefix()` (`:29-31`) |
| `cliproxy-xai.ts` | Derived view of `cliproxy/auth/xai-*.json` + proxy-log quota-marker scan |
| `cliproxy-install.ts` | Pinned binary download (sha256-verified, `v7.2.95` / `826604e2…`, `:24-28`), optional patched source build, `bin.prev` rollback |
| `packages/config/src/index.ts:802-1297` | zod schemas (`routerProviderSchema`, `cliProxyStateSchema`, `cliProxySecretsSchema`), `compactEnvForModel`, path helpers |

### Env, in three layers

**A — registry static** (`packages/registry/src/index.ts:189-213`): `bin:["claude"]`,
`args:[--dangerously-skip-permissions --effort high --verbose]`,
`env:{CLAUDE_CODE_NO_FLICKER:"1"}`, `enabledAtRest:false`.

**B — the generated env file**, auto-loaded by the registry from
`<daemonDir>/env/<id>.env` (`registry.ts:408-418`, `:493`) and merged into `entry.env`
(`registry.ts:387-388`). Written 0600 by `writeProjections` (`cliproxy-files.ts:169-277`).

`claudex.env` exact keys (`cliproxy-files.ts:201-239`):

```
ANTHROPIC_BASE_URL                        = http://127.0.0.1:${state.port}   (:186,:202)
ANTHROPIC_MODEL                           = state.defaultModel               (:203)
ANTHROPIC_DEFAULT_HAIKU_MODEL{,_NAME,_DESCRIPTION} = state.backgroundModel   (:204-206)
ANTHROPIC_DEFAULT_OPUS_MODEL              = "gpt-5.6-sol"    (hardcoded)     (:211-213)
ANTHROPIC_DEFAULT_SONNET_MODEL            = "gpt-5.6-terra"                  (:214-216)
ANTHROPIC_DEFAULT_FABLE_MODEL             = "kimi-k3"  [only if a keyed router serves it] (:217-223)
CLAUDE_CODE_ALWAYS_ENABLE_EFFORT          = "1"                              (:228)
CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY      = "3"                              (:229)
ENABLE_TOOL_SEARCH                        = "true"                           (:236)
CLAUDE_CODE_NO_FLICKER                    = "1"                              (:237)
CLAUDE_CONFIG_DIR                         = cliproxyHomeDir(daemonDir,"claudex") (:238)
```

`claudemix.env` (`:240-256`) deliberately omits `ANTHROPIC_MODEL` (the Claude main loop
picks its own default) and instead exposes the GPT model as
`ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME,_DESCRIPTION}` (`:248-250`).

Deliberate absence (`:224-227`): **no `CLAUDE_CODE_SUBAGENT_MODEL`** — pinning it stranded
subagents on a 200k model after a `/model` switch to kimi (1M). Model names are validated
against `MODEL_NAME_RE` (`packages/config/src/index.ts:805`) before any write
(`cliproxy-files.ts:174-183`); provider labels go through `envSafeLabel` (`:133-136`) so a
newline cannot forge an extra `KEY=VALUE` row.

`ANTHROPIC_AUTH_TOKEN` is **not** in the env file — it is injected per launch from the 0600
`cliproxy/token` file (content = `secrets.apiKey + "\n"`, `cliproxy-files.ts:199`), which
is what keeps it off tmux `-e` and off argv.

**C — the per-launch contributor**, `cliproxyContributor` (`index.ts:967-1048`); see §2.4.
Contributor env wins every collision (documented ordering contract, `index.ts:1058-1062`)
and is delivered through the self-deleting 0600 `/tmp/orquester-launch-*/launch.sh`
(`sessions.ts:225-267`, used at `:401`).

**Wrapper bins**: `<appdir>/.npm-global/bin/claudex` and `.../claudemix`, 0700
(`cliproxy-files.ts:141-160`, `:267-276`) — parse the env file as data (no `source`), `cat`
the token file, accept a charset-validated `--model`, then `exec claude "$@"`. Explicitly
**manual-terminal-only**; the Orquester launch path never uses them (`:260-266`).

### The per-launcher Claude home

`cliproxyHomeDir(daemonDir, entryId) = <daemonDir>/cliproxy/claude-home-<entryId>`
(`packages/config/src/index.ts:1282-1284`) — a `CLAUDE_CONFIG_DIR`, not a `HOME`.
`seedHome()` (`cliproxy-files.ts:544-598`) is idempotent, runs on `enable()`
(`cliproxy.ts:380`), boot adoption (`:1384`) and every router/xai mutation tail
(`:1046`, `:1069`):

1. dir 0700 + marker `.orq-cliproxy-home` containing the entry id; refuses a symlinked
   home or a marker mismatch (`:563-589`).
2. `seedClaudeJson()` → `<home>/.claude.json` (`:281-309`).
3. symlink the system `skills/` and `plugins/` (`:592-593`).
4. `copyIfMissing` the system `settings.json` once (`:594`), then `mergeManagedSettings()`
   force-merges managed keys on *every* pass (`:595`, `:368-388`).
5. `seedManagedAgents()` → `<home>/agents/*.md` (`:596`, `:509-534`).
6. `seedManagedMemory()` → `<home>/CLAUDE.md`, **claudemix only** (`:597`, `:489-507`).
7. `projects/` is never touched — cross-entry transcript isolation is the point
   (`:540-542`). *(This is also why `cliproxy` conversations are unresumable — §2.5.)*

**Purely to suppress first-run / interactive prompts:**

- **`hasCompletedOnboarding = true`** forced on both the fresh-copy and merge branches
  (`cliproxy-files.ts:302`, `:304`): *"still force the onboarding flag, or Claude Code runs
  its first-run theme/login flow inside the fresh proxy home"* (`:286-288`). A comment at
  `:548-553` records that reading the wrong `.claude.json` path in production meant
  *"every proxy session got the onboarding flow."*
- `oauthAccount` / `userID` deleted from the copied config (`:300-301`).
- `--dangerously-skip-permissions` in the entry args (`registry/src/index.ts:196`, `:209`).
- `SCRUBBED_SETTINGS_ENV_KEYS` (`cliproxy-files.ts:355-366`) deletes
  `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_DEFAULT_*_MODEL`,
  `ANTHROPIC_CUSTOM_MODEL_OPTION` out of the home's `settings.json.env` every pass — a
  copied system settings.json once forced every proxy subagent onto opus in production
  (`:348-354`).
- `autoCompactEnabled: true` force-merged via `MANAGED_HOME_SETTINGS` (`:346`).

**Content written into the home** (not prompt suppression): `MANAGED_AGENTS`
(`cliproxy-files.ts:399-411`) writes `gpt-sol.md`, `gpt-terra.md`, `gpt-luna.md`, plus
gated `kimi.md` and `grok.md`; frontmatter `model:` is called the only per-subagent model
mechanism Claude Code supports (`renderManagedAgent`, `:413-426`). claudemix additionally
gets a generated `CLAUDE.md` (`:434-487`) telling the orchestrator which `subagent_type` /
`/model` ids reach the non-Claude models.

### `config.yaml` projection

`renderConfigYaml` (`cliproxy-files.ts:84-125`), written 0600 to `cliproxy/config.yaml`
(`:198`); the proxy runs with cwd = the cliproxy dir so paths are relative.

```yaml
host: "127.0.0.1"
port: <state.port>            # default 8317 (packages/config/src/index.ts:1124)
auth-dir: "auth"
logging: { dir: "logs", request-log: true,
           log-request-body: false, log-response-body: false }   # bodies off: would capture prompts+completions (:93)
remote-management: { secret-key: <secrets.managementSecret>, allow-remote: false }
api-keys: [ <secrets.apiKey> ]
openai-compatibility:
  - name: <provider.id>
    base-url: <provider.baseUrl>
    api-key-entries: [ { api-key: <key> } ]
    models: [ { name: <model.name>, alias: <model.alias> } ]   # PROVIDER-level sibling
```

One entry per router provider that has **both** a stored key and ≥1 model (`:102-104`).
Every emitted string goes through `JSON.stringify` (YAML-injection guard on user text).
Load-bearing comment at `:113-115`: nesting `models` under an api-key entry parses but
registers zero models, and every request then 502s `unknown provider for model <alias>`.
Seeded OAuth accounts do **not** appear here at all — they are dropped as files into
`cliproxy/auth/` and hot-discovered.

### Process supervision

- Binary `<daemonDir>/cliproxy/bin/cli-proxy-api` (`cliproxy.ts:1910-1912`).
- Spawn (`cliproxy.ts:1449-1464`): with tmux → `tmux.newServiceSession` named
  `orq-svc-cliproxy` (outside the reaped `orq-` namespace, `:67-68`, guard at
  `tmux.ts:508-512`); without tmux → `spawnDirect` = a plain `spawn(..., {detached:false,
  stdio:"ignore"})` returning `{kill, pid}` (`index.ts:725-731`).
- Health: `probeCliProxy` → `GET /v1/models` with the bearer, 2 s timeout
  (`index.ts:1106-1124`), distinguishing "port answered but rejected our key" (foreign
  listener) from healthy. `CliProxyManager.probe()` unions in router model names/aliases and
  the xAI ids because CLIProxyAPI never lists openai-compatibility models (`:1475-1499`).
- Boot adoption `bootAdopt()` (`:1379-1432`): owned tmux session + healthy probe → adopt;
  our key accepted but no owned session → `degraded ["persistence-lost"]`; key rejected →
  `error ["port conflict"]`, never killed.
- Crash supervision `checkHealth()` every 15 s (`index.ts:806-807`), exponential backoff,
  `MAX_RESPAWNS = 3` then latch `error` + publish `cliproxy.crashed` once
  (`cliproxy.ts:72`, `:1324-1367`).
- `protectedPids: () => cliproxy.directChildPid()` (`index.ts:3328-3331`,
  `cliproxy.ts:1445-1447`) keeps `/api/system/processes/kill` from killing the proxy on a
  no-tmux host.
- Every mutation runs through a serialized `transition()` queue (`:1931-1939`); `disable`
  and router/xai mutations refuse with `affectedSessions` while dependent sessions are
  live (`:478-504`, counters at `index.ts:732-748`).

### Seeding + two-way credential sync

`seedProvider()` (`cliproxy.ts:1098-1157`, route `index.ts:1355`): read the managed
account's credential, convert per family (`codexStorageFromAuthJson`
`cliproxy-seed.ts:60-94`, `grokStorageFromAuthJson` `:135-169`, else
`claudeStorageFromCredentials` `:100-123`), refuse if the access token expires within 5 min
(`SEED_FRESH_THRESHOLD_MS`, `cliproxy.ts:88`, `:1111-1114` — seeding a near-expired token
makes the proxy immediately refresh it and desync the rotating refresh token), then write
0600 `auth/codex-acc<hex>.json` / `claude-acc<hex>.json` / **`xai-acc<hex>.json`**
(`seededAuthFileName`, `:1639-1643`). Each storage carries a top-level `prefix` =
`accountPrefix(accountId)` = `"acc" + id.replace(/-/g,"").slice(0,8)`
(`cliproxy-seed.ts:29-31`), recomputed identically at launch so no map is stored. Grok
storages carry **no** `prefix` (`:128-133`). Only the routing projection
`{provider, accountId, label, prefix}` is persisted to `state.seededAccounts` — never token
material (`cliproxy.ts:1139-1144`). No restart needed; the proxy hot-discovers the file.

`syncSeededCredentials` (`cliproxy.ts:1696-1825`) runs on boot and on **every 15 s health
poll** (`:1336`). The problem it solves (`:1696-1709`): OAuth refresh tokens are single-use
and both CLIProxyAPI *and* Claude Code/Codex refresh independently — whichever goes first
invalidates the other, and *"'Login expired' wiping a live `.credentials.json` is exactly
how this shipped broken."* Resolution: compare both copies' access-token expiry; **later
expiry wins**; merge only the token fields, preserving everything else; equal expiry with
different tokens is undecidable and left alone (`:1760-1824`).

`adoptOrphanXaiFiles()` at boot (`:321`, `:887+`) converts an unbacked proxy-written
`xai-*.json` back to native shape (`grokAuthJsonFromStorage`, `cliproxy-seed.ts:178-197`),
imports it as a managed account and marks it proxy-owned. The xAI account view is purely
derived from scanning `auth/xai-*.json` (`cliproxy-xai.ts:45-71`) and never persisted; token
material is deliberately never read out of those files (`:19-20`).

### PTY-coupled vs. env-and-files, within cliproxy

**Transfers unchanged to an SDK/protocol-driven Claude Code:** all projections
(`cliproxy-files.ts:169-277`), `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`MODEL`, the compact env
(`index.ts:1032-1044`), the timeout env (`agent-timeout-env.ts:27-34`), the
`CLAUDE_CONFIG_DIR` home with its onboarding bypass and settings merge/scrub
(`cliproxy-files.ts:281-309`, `:368-388`), the managed `agents/*.md` + `CLAUDE.md`, all
seeding and two-way sync (`cliproxy.ts:1098-1157`, `:1696-1825`), and all process
supervision/install/rollback.

**Assumes an interactive CLI in a PTY:**

| Mechanism | Citation | Why |
|---|---|---|
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL{,_NAME,_DESCRIPTION}`, `ANTHROPIC_CUSTOM_MODEL_OPTION*` | `cliproxy-files.ts:207-223`, `:246-250` | These only remap rows in the interactive `/model` picker — meaningless without the TUI |
| `CLAUDE_CODE_NO_FLICKER=1` | `cliproxy-files.ts:237`, `:255` | Pure terminal-render flag |
| `--dangerously-skip-permissions --effort high --verbose` argv | `registry/src/index.ts:196`, `:209` | CLI argv; an SDK takes options |
| The `claudex`/`claudemix` wrapper bins | `cliproxy-files.ts:141-160`, `:260-266` | Documented as manual-shell-only |
| Env *delivery* (tmux `-e` + the self-deleting `/tmp` script) | `sessions.ts:225-267`, `:369-403` | Transport is shell/tmux-specific; the content is not |
| `bin:["claude"]` PATH resolution + `resolvedBin`/`enabled` coupling | `registry.ts:385-406`, `cliproxy.ts:1582-1617` | Gating assumes a PATH-resolvable binary is what launches |
| Live-session accounting gating `disable`/unlink/router mutations (`refId==="claudex" && status==="running"`) | `index.ts:732-748` | An SDK-driven agent *outside the session manager* would be invisible to these gates — a GUI session must still register as a session |
| `versionFlag:"--version"` / `testedClaudeCliVersion` | `registry/src/index.ts:198`, `config/index.ts:1146` | CLI-only |

**`compactEnvForModel`** (`packages/config/src/index.ts:1040-1103`) deserves its own note:
proactive auto-compaction is gated **off** behind a third-party `ANTHROPIC_BASE_URL`
(upstream claude-code #65585) unless `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, so arming it
is **mandatory on every launch** (`index.ts:1024-1031`,
`CLAUDE_ARMING_COMPACT_WINDOW = 1_048_576` at `config/index.ts:1016`). Resolution order on
the effective model, `acc<hex>/` prefix stripped (`:1045`): `claude*` → arming window only,
never `MAX_CONTEXT_TOKENS` (`:1046-1059`); router model by name **or** alias → override →
provider's stored windows (`:1062-1079`); xAI OAuth → `XAI_OAUTH_MODELS` (190k compact
window because xAI doubles the request price past 200k, `:1080-1091`); `CURATED_PROXY_MODELS`
(200k, 75 %) (`:1092-1102`); unknown → `null` (reactive compaction only). This is all
harness behaviour, not TUI behaviour — it survives the migration intact.

---

## 3. What the daemon already has that a GUI session can reuse

Essentially the entire "identity and configuration" layer. Concretely:

| Asset | Where it lives | Why it transfers |
|---|---|---|
| **Per-account auth homes** | `<appdir>/daemon/agent-accounts/<family>/<id>/home` + the marker/ownership assertion (`agent-account-paths.ts:13-48`) | A protocol-driven child reads `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GROK_HOME` identically. An in-process SDK reads the same files. |
| **Resolved launch env** | `buildAgentLaunchEnv` (`index.ts:1064-1075`) composing account + timeout + cliproxy contributors | Already a pure function returning `{env, unset, accountId}`. A GUI session calls the same seam. |
| **Account token freshness** | `agent-account-refresh.ts` + `liveAccountIds()` | Unchanged. |
| **Model picks / catalog** | cliproxy `state.json` (defaults, `modelOverrides`, `routerProviders`, `seededAccounts`), validated by `resolveLaunchModel` (`index.ts:1083-1100`) and surfaced as model chips (`NewTabMenu.tsx`) | A GUI's model selector is the same data; most protocols take a model per-request, which is *easier* than an env pin. |
| **Proxy base URL + auth token** | `claudex.env`/`claudemix.env` + the 0600 token file read at `index.ts:974-980` | `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` are read by the harness, not the TUI. |
| **Hook event taxonomy** | `agent-status.ts:9-107` — the working/waiting/done mapping per family | This *is* the spec for what a GUI session must emit. Protocol events map onto it more precisely than hooks do. |
| **Transcript locations per agent** | `agent-conversations.ts:157-199` + per-agent listers | Unchanged; resume becomes a protocol call instead of argv. |
| **Per-session id + socket for callbacks** | `ORQUESTER_SESSION_ID` / `ORQUESTER_DAEMON_SOCK` (`sessions.ts:375-379`) and the fail-open `agent-event` route (`index.ts:3775`) | A ready-made, already-hardened back-channel if the GUI session still wants out-of-band signals (e.g. opencode's plugin). |
| **Upload storage + lifecycle** | `<appdir>/daemon/uploads/<sessionId>/`, daemon-owned naming, auto-cleanup (`index.ts:3809-3845`, `:4482-4545`) | Reusable verbatim for attachments. |
| **Activity → push → Attention Center** | `sessions.lifecycle "activity"` → `broadcaster` + `push.notifyStructural` (`index.ts:642-670`) | Keep the event shape; swap the producer. |
| **Registry install/update/version** | `registry.ts:276-357` (plain `exec`) | Unchanged — still need the binary on disk for most protocols. |
| **Ordering, titles, tab strip, persistence** | `SessionSummary` + `sessions.json` | A GUI session is still "a tab in a project with an order and a title". |

---

## 4. Risks — things that only work because the CLI is interactive

1. **Claude and Codex account acquisition has no headless path.** The only way to add a
   Claude/Codex managed account is to **upload a credential file that some interactive
   login produced** (`AgentAccountsSettings.tsx:97-108`: "Upload a Claude
   `.credentials.json`, Codex `auth.json`…"), i.e. somebody ran `claude` → `/login` or
   `codex login` in a terminal tab first. Grok is the exception — it has a daemon-driven
   RFC 8628 device-code flow (`grok-device-auth.ts:14-27`) *and* an "import the server's own
   login" button (`XaiAccountCard.tsx:77-86`). **If tabs stop being PTYs, there is no longer
   anywhere to run `claude /login`.** Mitigations: keep a shell tab (cheapest), build
   device-code flows for Claude/Codex the way Grok has one, or keep an "interactive login"
   escape-hatch PTY. This is the #1 concrete blocker.

2. **`/login`, `/model`, `/effort`, `/compact` and every other slash command** are typed
   into the TUI today. Several are load-bearing in the current design — e.g. the claudex
   comment "`/effort` in-tab overrides per session" (`packages/registry/src/index.ts:194-196`).
   Protocol sessions expose *some* of these as API params and some not at all.

3. **Permission prompts are answered by keystrokes.** The whole reason `--dangerously-skip-permissions`
   (`:59`, `:196`) and `--yolo` (`:78`, `:162`) are in the catalog is that nobody wants to
   answer a TUI prompt. A GUI can do far better (structured permission requests), but note
   the current product *depends* on permissions being pre-bypassed — a protocol port that
   surfaces real permission requests changes the UX materially, and the MCP `send_keys`
   tool's "literal shortcut keys (1, y)" hint (`mcp/server.ts:142`) shows external agents
   are already answering prompts by typing digits.

4. **Trust-folder / first-run wizards are suppressed by writing files, and that suppression
   is fragile.** `hasCompletedOnboarding: true` is forced into every managed Claude home
   (`agent-accounts.ts:331`, `:333`), grok's `trusted_folders.toml` is symlinked in "so the
   workspace [stays] pre-trusted" (`:240-244`), and codex's `.personality_migration` /
   `.sandbox_migration` markers are copied (`:273-275`). If any vendor adds a new first-run
   gate, a headless session *hangs* instead of showing a prompt someone can click through —
   with a PTY the user at least sees it. Keep a visible raw-output view for this reason.

5. **Codex hook trust hash is a replicated private algorithm.** `codexTrustHash`
   (`agent-hooks.ts:522-532`) reimplements codex-rs's `command_hook_hash`; the code itself
   flags the accepted risk ("Codex owns the algorithm — if it drifts, hooks stop firing and
   sessions degrade to quiescence", `:311-313`). "Degrade to quiescence" means degrade to
   the *PTY heuristics* — which will not exist after the migration. Any GUI port must make
   status come from the protocol, not from hooks, or this failure mode becomes silent.

6. **Bell-only agents have no structural status at all.** `gemini`, `kimi`, `agy`, `cline`,
   `deepcode`, `deepseek` get no hooks (`agentFamily` returns null, `agent-hooks.ts:28-29`)
   and are carried entirely by the bell/quiescence fallback and `push.notifyAttention`
   (`index.ts:666`). Removing the PTY removes their only status signal. Either give them a
   protocol adapter or accept they become status-less.

7. **`claudex`/`claudemix` cannot resume at all today** (`resume-account.ts:38-53`) — their
   homes deliberately never share `projects/` with the system home
   (`cliproxy-files.ts:540-542`), so a plain `claude --resume <id>` in the daemon's own HOME
   cannot see the transcript. Their model pin is also an env var fixed at spawn
   (`index.ts:1005`), so changing model mid-session means `/model` in the TUI. A protocol
   port fixes both (address the home explicitly; pass the model per request) — but only if
   the design accounts for it.

8. **`launchViaShell` for OpenCode** (`packages/registry/src/index.ts:151`, honoured at
   `sessions.ts:177-193`) exists because OpenCode "on locked service users" needs to be a
   child of a real login shell. Any replacement spawner must preserve that, or OpenCode
   breaks on the VPS.

9. **tmux persistence is the product's headline feature** ("sessions survive daemon
   restarts", `AGENTS.md`). A GUI agent session driven over stdio by the daemon is a
   *child of the daemon* and dies with it — unless the protocol process is itself put in
   tmux (possible: `codex app-server` and `claude --input-format stream-json` are stdio
   programs, which do not multiplex through tmux naturally) or the daemon persists
   conversation state and re-attaches by resuming the transcript. **This is the second
   major design question after login.** Note the agents' own transcripts (§2.5) are
   already a durable store the daemon can read — resume-on-restart is plausible, but it is
   "replay the conversation", not "the process survived".

10. **Grok's proxy path impersonates the first-party CLI.** `GROK_CLIENT_VERSION` is pinned
    and spoofed for the usage endpoint (`usage-sources.ts:14`, `:257-268`) and CLIProxyAPI
    impersonates the grok CLI's OAuth client (`agent-account-refresh.ts:13-16`). Unchanged
    by the migration, but it is an existing accepted risk that a GUI does not reduce.
