# Agent Profiles (Orquester-managed, per-session) — design

Status: implemented (Orquester `feat/agent-profiles`, 2026-10-18). Where the build differs from
the text below, §12 "Implementation notes and deviations" is authoritative; module docs live in
`apps/daemon/src/session-profiles/README.md`, `apps/daemon/src/agent-isolation/README.md` and the
agent-host README. Supersedes the user-facing placement of
`2026-09-28-agent-profile-design.md`: the per-agent global-config editor described there keeps its
behavior but moves from the right rail to **Settings → Agent config** (§5.4). Everything else in that
spec stays valid for that editor.

## 1. Intent

Orquester's agents will be used for more than coding (video editing, 3D, research, …). Every skill,
plugin, MCP server, hook and instruction an agent CLI loads costs context tokens in every session,
whether or not the session uses it. Today an agent loads its whole global setup (`~/.claude`,
`~/.codex`, …) in every chat, so a coding chat pays for Blender tools and an editing chat pays for
database skills.

**Agent Profiles** are Orquester-owned kits for one kind of work ("Developer", "Editor",
"Research"). A chat started with a profile loads **only** that profile's items, on any of the four
agents (Claude, Codex, Grok, OpenCode). A chat without a profile ("Global") behaves exactly as today.

Success: open an editing chat and its skill list and tool list contain only editing things; open a
coding chat next to it, with the same agent and account, and it sees only coding things.

## 2. Goals, non-goals, anti-goals

Goals
1. Create, edit and delete Orquester-owned profiles holding instructions, skills, MCP servers,
   plugins, hooks and commands.
2. Pick a profile per chat from the composer; switch it in a running chat.
3. Full isolation from the agent's **global** customizations for profile chats, on all four agents.
4. Concurrent chats with different profiles (same agent, same account) never affect each other.
5. Keep logins, chat history, resume and fork working exactly as they do for Global chats.

Non-goals
- Profile inheritance, parent/base profiles, or anything shared between profiles. A skill used by
  two profiles is two copies.
- An "inherit global + profile on top" mode. Every profile is isolated; there is no mode setting.
- Applying profiles to legacy terminal-agent sessions (they can no longer be created from the UI).
- Hiding a project's own files (repo `CLAUDE.md`, `.mcp.json`, `.claude/`, `.codex/`, …).
- Making profiles a security sandbox. An MCP server in a profile has the same machine access as
  today.
- Controlling Orquester's own in-chat tools per profile (they stay always-on, as today).

Anti-goals (a failure even if it "works")
- A profile chat that *looks* isolated but still loads global items. If an agent cannot be isolated
  (preparation failed, CLI changed), the launch **fails with a clear message**; it never silently
  falls back to the global setup.
- Writing into or otherwise modifying the user's global agent configs or a managed account's
  credential files to make a profile work. (Prepared directories may *link to* an account's login
  file and the shared history folder, as account homes already do; the CLI's own token refresh
  writing through that link is expected.)
- Copying credentials into profile directories.
- A first profile chat that stalls for seconds/minutes while an agent builds caches.

## 3. Terms

- **Profile:** an Orquester-owned record + directory of items. Identified by `profileId` (stable
  slug/uuid; display name editable).
- **Global:** the absence of a profile. The agent's own global config, edited in Settings → Agent
  config (the existing agent-profile editor).
- **Item kinds:** `instructions` (one markdown document), `skill`, `mcp`, `plugin`, `hook`,
  `command`. Each non-instruction item has an `enabled` flag and an **agent scope** (§4.2).
- **Prepared directory:** the agent-native files Orquester generates from a profile for one agent
  (and, for Codex, one account), from which profile chats launch (§6).

## 4. Profile content model

### 4.1 Items

| Kind | Content | Agents |
|---|---|---|
| Instructions | One markdown document | All four |
| Skill | A directory with `SKILL.md` (+ files) | All four |
| MCP server | name, transport (stdio/http/sse), command/args/cwd/env or url/headers | All four (transport permitting) |
| Plugin | A plugin of one specific agent (Claude marketplace plugin, Codex plugin, Grok plugin, OpenCode JS plugin) | Exactly one agent |
| Hook | An event + handler, in one agent's own hook format | Exactly one agent (like plugins) |
| Command | Markdown + frontmatter (`git/pr` style names) | Claude, Grok, OpenCode natively; **Codex: shipped as a skill** |

### 4.2 Agent scope (owner decision)

Every item carries the set of agents it applies to. Default for skills, MCP servers, instructions,
commands: all agents. A plugin is always single-agent ("Claude only"); a Claude-only plugin in
Developer means Codex/Grok/OpenCode chats on Developer simply don't have it. The UI shows the scope
on every row ("all agents", "Claude only"). An item the adapter cannot express for an agent (e.g. an
MCP transport the agent lacks) is skipped for that agent and the profile editor says so; it never
blocks the other agents.

Hooks are single-agent too (my call): each hook is written in its agent's own event vocabulary and
format, reusing the existing per-agent hook editors; there is no cross-agent hook translation.
OpenCode has no hook kind (its hooks are JS plugins — add them as an OpenCode plugin). "Import from
Global" copies a hook with its agent fixed.

### 4.3 Profile settings

Name, icon, description, and (my call) per-agent switches:
- **Hide built-in skills** — default **on** (§6.1, §6.2, §6.3 explain the per-agent mechanism and
  measured savings).
- **Claude Workflow tool** — default **on**. Turning it off saves ~1.5k more tokens per Claude chat
  (§6.1).

### 4.4 Storage (builder's layout, these constraints)

- Under the appdir via a new `packages/config` path helper (e.g. `<appdir>/daemon/agent-profiles/`);
  never a hardcoded path. Per profile: a manifest (`profile.json`, validated in `packages/config`,
  tolerant of unknown fields), `instructions.md`, and item directories (skills, commands, plugin
  copies, hook definitions).
- Optimistic concurrency with a revision per profile (two clients cannot silently overwrite each
  other), matching the existing agent-profile service's `revision` pattern.
- **Secrets:** MCP `env`/`headers` values are host-only. Stored in 0600 files under 0700 dirs,
  returned masked by the API, never logged, never in argv, never in exports. Prepared directories
  that must contain them (Codex/Grok/OpenCode config files) are 0700/0600.

### 4.5 Filling a profile (owner's mockup)

- **Add** an item by hand (same editors as the current agent-profile panel).
- **Import from Global:** pick items from an agent's global setup; they are **copied** into the
  profile (converted with the existing `convert.ts` rules where the target agent differs).
- **Git / .zip / .md import:** the existing import pipeline (`agent-profile/import.ts`), targeting a
  profile instead of a global home.
- **Copy from profile:** copy items from another profile.
- **Plugins:** chosen from the agent's known marketplaces and copied into an Orquester-owned
  per-profile plugin cache. Installing never goes through the account/global `plugins/` dirs
  (Claude's are symlinked to the global one; installing there would change Global).

No migration is needed: existing users simply have no profiles and every chat stays Global.

## 5. User-facing behavior

### 5.1 Right rail → Agent Profiles (library)

Replaces the current right-rail "Agent profile" panel.
- A search box and a **+ New** button.
- **Global** listed first (dashed card), not editable here; it explains it's each agent's own setup
  and links to Settings → Agent config.
- One card per profile: icon, name, description, counts (skills / MCPs / plugins), and a status pill
  while it is being prepared ("Preparing Codex…") or if preparation failed for an agent.
- Clicking a card drills into the profile; a back arrow returns. Library and editor are never shown
  side by side in the rail.

### 5.2 Profile editor (owner chose "Option A")

- Header: back arrow, icon, name, a **gear** button for profile settings (§4.3) and a `⋯` menu
  (rename, duplicate, delete, export).
- Per-agent readiness line (Claude · Codex · Grok · OpenCode, each ready / preparing / failed with
  reason on hover).
- **Instructions** row above the categories; opens the markdown editor.
- An **icon segmented bar** with five equal cells — MCP, Skills, Plugins, Hooks, Commands — each an
  icon, the item count, and a small label; the selected cell is raised. Settings is not a tab (it's
  the gear).
- Below: "N of M on" and **+ Add <kind>**, then the item rows with toggle and agent-scope tag.
- Quick actions: Import from Global, Git / .zip, Copy from profile.

### 5.3 Composer profile chip

- A chip in the composer controls row, between the access/plan controls and the account chip,
  showing the profile icon + name (or "Global"). The menu lists Global, a separator, then profiles
  with their counts.
- **Remembered per agent**, like the model and account preferences (`preferredAccountByAgent` /
  `preferredModelSelectionByAgent` pattern in `packages/ui/src/store/app.ts`, localStorage,
  validated on load). Default Global.
- **New chat:** starts with the remembered profile for that agent.
- **Resuming an old conversation** (the empty-chat "Recent conversations" list,
  `ProjectOverview.tsx` `resume`): continues with the **currently selected** profile, like model
  and effort do. History files don't record a profile and don't need to.
- **Switching in a running chat** restarts the agent with the new profile and keeps the
  conversation, exactly like the account chip's switch (`agent-chat/service.ts` identity switch,
  `SetThreadIdentityRequest` path). New skills/MCPs apply immediately; Claude and Grok may keep the
  previous *instructions* until the conversation is next compacted (they record the system prompt
  once per conversation). The chip's menu says so in one line.
- A profile not prepared for the chat's agent (preparing/failed) shows disabled with the reason.

### 5.4 Settings → Agent config

The existing per-agent global editor (Claude/Codex/Grok/OpenCode tabs, MCP/Skills/Plugins/
Marketplaces/Hooks/Commands, CLAUDE.md) moves here unchanged. It is how Global is managed.

### 5.5 Other ways chats are created (my call)

Everything that creates or re-launches a chat carries the profile: the "+" new-tab menu, the
empty-chat resume list, fork / fork-reconcile, account switch, the MCP `create_session` tool (new
optional `profile` argument, by id or name; `get_session`/`list_sessions` report it), and the
workflow agent block (optional profile field). Omitted = Global, as today.

Unattended launches (MCP `create_session`, workflow runs) whose profile is missing, deleted, or
failed to prepare **fail with an error**; they never fall back to Global (my call — nobody is there
to see a notice). Deleting a profile that workflows reference warns and lists them, following the
saved-prompt `expectWorkflowUses` pattern.

### 5.6 Editing and deleting (my call)

- Saving a profile re-prepares it in the background (§6.5). New chats use the new version; running
  chats keep what they launched with until their agent restarts (resume, switch, daemon restart).
- Deleting a profile asks for confirmation and lists how many open chats use it. Those chats keep
  running; at their next agent (re)launch they fall back to **Global with a visible notice** in the
  chat (this is an explicit user action, not a silent downgrade).

## 6. Isolation per agent (verified)

### 6.0 Runtime settings carry over from Global (owner decision)

Isolation covers what reaches the model's context: instructions, skills, MCP servers, plugins,
hooks, commands, memory, and agent-shipped extras (synced skills, connectors, remote plugins).
**Runtime settings that add nothing to the context carry over from Global** so a profile chat
behaves like a Global chat apart from its kit: model/provider definitions, approval/sandbox and
permission policy (allow-lists), `env`, `apiKeyHelper`-style auth helpers, status line, notify
hooks of the CLI itself, trust entries. Per agent:
- **Claude:** read the account's user `settings.json` at launch and pass it through the SDK
  `settings` (flag tier) **minus** the item keys (`hooks`, `enabledPlugins`,
  `extraKnownMarketplaces`, plugin/skill/MCP/memory keys); the recipe's own keys win.
- **Codex / Grok / OpenCode:** the prepared config file is the global one (`config.toml`,
  `config.toml`, `opencode.json`) with the item sections removed (`mcp_servers`, plugins, skills,
  hooks; OpenCode `mcp`, `plugin`, `instructions`, `command`, `agent`, skill paths) and the
  profile's sections plus the recipe's isolation keys merged in.
- The builder fixes the exact key lists per agent (from each CLI's config reference) and tests
  them; an unknown key carries over (it's a runtime setting until shown otherwise).
- A change to a Global config file re-prepares profiles (the existing agent-profile service already
  watches those files).

All recipes below were verified on this host (Claude Code 2.1.285 / Agent SDK 0.3.278, codex-cli
0.159.0, Grok CLI `@xai-official/grok` 1.0.46, OpenCode 1.18.34), with real logins for Claude, Codex
and Grok, mock endpoints for refresh paths, and before/after checks that global files were
untouched. **What a profile chat loads, on every agent:** the profile's items for that agent; the
project's own files exactly as a Global chat loads them (repo `AGENTS.md`/`CLAUDE.md`, `.mcp.json`,
`.claude/skills`, `.agents/skills`, `.codex/`, `.grok/`, `.opencode/`); runtime settings (§6.0);
the agent's built-in tools; the chat's selected
account; Orquester's in-chat tools. **Nothing** from the user's global setup.

### 6.1 Claude — launch options only, no new directory

Keep the account's `CLAUDE_CONFIG_DIR` (credentials and transcripts stay where they are; no second
config dir). In `adapters/claude/launch.ts`, for a profile chat:
- `settingSources: ["project", "local"]` (drops user `CLAUDE.md`, `rules/`, skills, commands,
  agents, user MCP servers, user hooks, user settings).
- `mcpServers: { ...profileServers, orquester }` and `strictMcpConfig: true`.
- `plugins`: one Orquester-generated local plugin holding the profile's skills and commands, plus
  each selected Claude plugin by path from the profile's plugin cache.
- `skills`: the profile's skill names **plus its plugin commands** (`plugin:cmd`) — otherwise the
  commands vanish from the model's listing — **plus `"workflow-authoring"`** while the Workflow tool
  is on. Omitting `workflow-authoring` with the Workflow tool on makes Claude inline the whole
  authoring guide into the Workflow tool (~4.8k tokens). When the profile turns the Workflow tool
  off: `settings.disableWorkflows: true` and leave `workflow-authoring` out.
- `settings`: `{ hooks: profileHooks, autoMemoryEnabled: false, syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false, disableClaudeAiConnectors: true, ...existing thinking/denied keys }`.
- env: `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

Verified: claude.ai-synced skills (14 in baseline) and the claude.ai "Claude Docs" connector are
gone; auto-memory is off (dropping the user source alone would turn it back on); the model lists
only the profile's skills/commands/MCP tools plus built-ins. Measured request size vs. showing
built-ins: hide built-ins + keep Workflow ≈ −1.45k tokens; hide built-ins + Workflow off ≈ −3.0k.
`disallowedTools: Skill(x)` does **not** hide skills; `--disable-slash-commands` hides the profile's
too. Not verifiable here: claude.ai-synced *plugins* (no account has any yet; the setting is in place).
Project `enabledPlugins` (verified by the builder, no model call): a project's
`.claude/settings.json` `enabledPlugins` DOES turn on a globally installed plugin under
`settingSources: ["project", "local"]`; the launch sets `enabledPlugins: {<id>: false}` at the flag
tier for every plugin in the account's `installed_plugins.json` and every id the project's settings
name (the profile's own plugins load by path as `<name>@inline` and are unaffected). Also found:
the `skills` allow-list hides the project's own `.claude/` skills and commands, and
`strictMcpConfig` drops the project's `.mcp.json` and plugin MCP servers, so the launch adds the
project's names to the list and passes project servers (minus `disabledMcpjsonServers`) and the
profile plugins' servers (lifted at preparation) explicitly. Settings and MCP servers go through
0600 files (`--settings <file>`, `--mcp-config <file>`): the SDK puts both in argv otherwise.
Runtime user settings carry over per §6.0.

### 6.2 Codex — one prepared `CODEX_HOME` per (account, profile)

`$CODEX_HOME/AGENTS.md` can only be excluded by a different `CODEX_HOME`, so a profile needs its own
home. Layout:
- `auth.json` → **symlink** to the account home's `auth.json`. Verified: a real session works, the
  link survives, and a token refresh writes **through** the link into the account's file (in-place
  truncate+write, no rename).
- `sessions/` → symlink to the account's `sessions/` (which already links to the shared global
  one), so history, "Recent conversations" (`agent-conversations.ts` reads rollout files, not
  Codex's index), usage scanning and resume are unchanged.
- Real `config.toml`: profile MCP servers; `[skills.bundled] enabled = false` (when hiding
  built-ins); `[features] apps = false, remote_plugin = false` (and `plugins = false` when the profile
  has no Codex plugins). Without these, the account's 5 remote plugins download into the profile home
  (~37 skills and a 106-tool MCP server). Copy the global config's `projects."<path>".trust_level`
  entries so project `.codex/config.toml` loads as it does in Global; model defaults as today.
- Real `AGENTS.md` (profile instructions), real `skills/` (profile skills + commands-as-skills),
  `hooks.json` (Orquester's managed hooks + profile hooks, with `hooks.state` trust entries keyed by
  this home's path).
- Profile plugins: copied into `plugins/cache/<marketplace>/<name>/<version>` with
  `[plugins."<id>"] enabled = true` (verified: loads in that home only).

At thread start/resume (thread `config`, nested objects — quoted dotted keys are silently ignored):
call `skills/list` and send `skills.config` disables for every skill under `$HOME/.agents/skills`
(Codex reads it from `$HOME` regardless of `CODEX_HOME`). Thread config is not persisted, so it is
re-sent on every `thread/resume`.

**Index seeding (no first-start delay).** A fresh home's state DB backfills from every rollout in
`sessions/` (1,699 files / 7.4 GB here: 29–37 s measured, up to ~275 s on a loaded machine), the app
server answers nothing meanwhile, and a second process gives up after 30 s. Preparation therefore
creates `sessions/` as an **empty real directory**, runs `codex app-server` through `initialize` once
(~0.5 s), and only then replaces it with the symlink. Later starts take ~0.2 s and never rescan; old
threads resume via Codex's filename fallback (verified). Re-seed whenever the expected
`state_*.sqlite` file is missing (a Codex upgrade that changes the DB format). Never start two
processes on a home before its first `initialize` returned. Do **not** point `sqlite_home` at the
account's DBs (instant too, but it writes profile paths into the account's `threads` table).

The daemon's token refresher must treat a profile home as its account (so it doesn't refresh an
account that is live through a profile home).

**System account (no managed account)** is supported the same way (my call): "the account home" is
then the system `CODEX_HOME` (`~/.codex`), so `auth.json` and `sessions/` link there, and Grok's
`GROK_AUTH_PATH` points at `~/.grok/auth.json`. Nothing is written into those homes by Orquester;
the daemon's refresher does not manage System today and still doesn't. Prepared homes are keyed by
account id, with System as its own key.

### 6.3 Grok — one prepared `GROK_HOME` per profile

Spawn (`adapters/grok/launch.ts` / `session.ts`):
- `GROK_HOME=<prepared profile home>`; `GROK_AUTH_PATH=<accountHome>/auth.json` (undocumented but
  verified: reads only that file, refresh takes `dirname/auth.json.lock` and renames a temp file over
  the same path — the account's own file, coordinated with sibling processes). No `auth.json` in the
  profile home.
- `GROK_{CLAUDE,CURSOR}_{RULES,AGENTS,MCPS,HOOKS}_ENABLED=false` and `GROK_CURSOR_SKILLS_ENABLED=false`
  (Claude **skills** compat stays on — see project files below).
- argv adds `--no-leader` (a shared leader process would break isolation); the existing
  `GROK_CONFIG_PATH` overlay continues unchanged.

Home contents (real files): `AGENTS.md`/`rules/` (instructions), `skills/`, `commands/`, and a
`config.toml` (§6.0 carry-over plus) `[cli] auto_update = false, use_leader = false`; every
`[compat.claude.*]` and `[compat.cursor.*]` cell `false` **except `compat.claude.skills = true`**;
`[skills] ignore = ["~/.claude/skills", "~/.agents/skills", "~/.agents/commands",
"~/.claude/commands", "<home>/bundled/skills"]` (the last only when hiding built-ins) **plus,
computed at every spawn, every entry of `~/.claude/skills`, `~/.agents/skills`,
`~/.claude/commands` and `~/.agents/commands` by absolute path, and for each symlinked entry its
resolved target too** — Grok's directory ignore skips real entries but follows symlinked ones, and
`compat.claude.skills` also loads `~/.claude/commands/*.md` as user skills (verified with `grok
inspect`: a real and a symlinked user command both listed as `vendor: claude, enabled` until listed;
the repo's `.claude/commands` still load, as in Global) (verified live: 9 symlinked global skills leaked into the model's context until each
was listed; with them listed the model saw only the repo's and the profile's skills); the profile's `[mcp_servers]` (or
send them as ACP `mcpServers`); and `[plugins] disabled = [<exact name of every discovered plugin
that isn't the profile's>]`, built from `grok inspect --json` `.plugins[].name` under the profile
home (Grok enables Claude-installed plugins on its own; `compat.claude.hooks=false` does **not**
stop their hooks, `["*"]` doesn't work, only exact names — verified with a firing probe hook).
Profile hooks ship as a plugin via `--plugin-dir` (verified to fire). `sessions/` and
`trusted_folders.toml` symlink to the shared ones so history and resume match Global.

**Project files (verified with `grok inspect --json` in a trusted repo):** with these settings the
global `~/.claude/CLAUDE.md`, `~/.claude/skills` and `~/.claude.json` MCP servers are disabled, while
the repo's `AGENTS.md`, `CLAUDE.md`, `.mcp.json` and `.claude/skills` all load, exactly as in
Global. (With `compat.claude.skills = false` the repo's `.claude/skills` would be lost too; adding it
back through `[skills] paths` doesn't work — Grok still tags it as a disabled Claude source — hence
skills compat on + ignoring the user path.)

Grok rewrites its `config.toml` itself: regenerate it at every spawn (builder: if concurrent spawns
racing on one file proves a problem, use per-thread homes). The plugin deny list must be rebuilt
whenever plugins are installed globally (on spawn is simplest). Use the debug log, not `grok inspect`,
to confirm a plugin is disabled (inspect lists disabled plugins as enabled).

### 6.4 OpenCode — one server per (project, profile)

Today `OpenCodeServerPool` runs one `opencode serve` per project, shared by all its chats; config is
read once per server, so per-chat config is impossible on a shared server. The pool key becomes
`(projectDir, profileId | global)`; Global keeps today's server unchanged. A profile server's env:
- `XDG_CONFIG_HOME=<profile>/xdg` — a directory that symlinks every entry of the real `~/.config`
  **except** `opencode`, so tools run by the agent (`gh`, git's XDG config, …) keep working while
  the global OpenCode config is never read.
- `OPENCODE_CONFIG_DIR=<profile>/opencode` with `opencode.json` (MCP), `AGENTS.md`, `skills/`,
  `plugin/` (profile plugins **plus a copy of Orquester's `orquester-status.js`**), `commands/`,
  `agents/`. OpenCode writes `package.json`/`node_modules`/`.gitignore` there; it must be writable
  and Orquester-owned.
- `OPENCODE_TEST_HOME=<profile>/home` (an empty dir): OpenCode reads `<home>/.opencode` as a config
  dir whatever `XDG_CONFIG_HOME`/`OPENCODE_CONFIG_DIR` say, with `<home>` =
  `OPENCODE_TEST_HOME ?? os.homedir()` (verified on 1.18.34: MCP servers and commands of a temp
  `~/.opencode` leaked until it was set). Undocumented, so preparation probes the installed binary
  and records whether it honours it; while unproven, a `~/.opencode` holding config refuses the
  profile at preparation and at every launch.
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` (not the broad
  `OPENCODE_DISABLE_CLAUDE_CODE`, which also drops a repo's own `CLAUDE.md`); the config dir's
  `AGENTS.md` is always written (empty without instructions — OpenCode skips an empty file), since
  OpenCode reads the first existing of `<config dir>/AGENTS.md` and `~/.claude/CLAUDE.md`; keep `XDG_DATA_HOME`
  (auth.json and the session DB stay shared — verified concurrent servers on one data dir) and
  `OPENCODE_CONFIG_CONTENT` as today.
- `opencode.json` (§6.0 carry-over plus) `"skills": { "paths": [".claude/skills", ".agents/skills"] }`
  so the **repo's** Claude/agents skill folders load again (verified: the two disable flags drop
  them along with the user ones; project-relative paths bring back only the project's). The repo's
  `AGENTS.md` loads as in Global (OpenCode reads `CLAUDE.md` only when there is no `AGENTS.md`).
  Builder: confirm `.mcp.json` handling matches Global.
- When hiding built-ins: a profile agent with a `permission.skill` allow-list (removes
  `customize-opencode`).

A profile edit recycles that profile's servers (existing `recycle()` per key). Also fix the wrong
assumption in `agent-hooks.ts` and `agent-profile/homes.ts` that `OPENCODE_CONFIG_DIR` replaces
`~/.config/opencode` — it is additive.

### 6.5 Preparation lifecycle

- Prepared directories live under the appdir (path helper), one per (profile, agent) — per
  (profile, account) for Codex — owned by the daemon, 0700. They are **never** a symlink target or
  merge source of `syncAccountHome` (that would leak profile items into Global).
- Preparation runs in the background on profile create/save, on first use for a new account, and on
  daemon start for missing/stale dirs. Per-agent state: preparing / ready / failed(reason), shown in
  the library card, the editor's readiness line and the composer menu.
- Preparation is atomic: build into a staging directory, validate (Codex: `initialize` OK; Grok:
  `grok inspect --json` shows only profile items; OpenCode: config debug), then swap into place. A
  launch never sees a half-written directory.
- A launch with a profile that is not ready for that agent waits for preparation already in flight;
  if preparation failed, the launch fails with the reason (anti-goal: no silent fallback).

## 7. Plumbing (from the code survey; file references are current)

- **One seam:** extend the `resolveAgentLaunchEnv` context (`apps/daemon/src/index.ts` ~521) with
  the profile. It feeds chat create, fork, fork-reconcile, account switch and terminal launches, and
  its output persists in the thread's `launch.json` (`orchestration/launch-config.ts`), so a host
  started after a daemon restart relaunches with the same env/home. Codex/Grok/OpenCode isolation is
  env + home + argv; Claude's SDK options (`settingSources`, `plugins`, `skills`, …) are not env and
  need a field on the host thread/launch record that `claude/launch.ts` reads.
- **Contracts first** (`packages/api`): `profileId` on `CreateSessionRequest`,
  `CreateAgentChatSessionFields` (`agent-chat/wire.ts`), `CreateHostThreadRequest`
  (`host-protocol.ts`) and the identity-switch request; new profile CRUD/import/prepare-status
  routes under `agentChatRoutes`-style constants. Host protocol changes stay compatible with daemon
  handovers.
- **Persistence** (`packages/config`): `profileId` on the session/chat record and the thread head
  (`agentThreadHeadSchema` strips unknown keys — add the field there). Older records without it =
  Global.
- **Resume identity:** `homePath` follows the account variable; for Codex/Grok profile chats it is
  the prepared home. Because `sessions/` is shared, transcripts are visible from Global and every
  profile; `providerInstanceId` / account-switch detection must not treat a profile change as an
  account switch.
- **Naming:** the new feature takes the user-facing name "Agent Profiles"; the existing
  `agent-profile` module/API is the global editor (Settings → Agent config). Pick code names that
  can't be confused (builder's call), and update AGENTS.md's "Agent profile" term accordingly.
- **Reuse:** the agent-profile infra (`markdown-items.ts`, `frontmatter.ts`, `fs-write.ts`, the
  per-agent `mcp.ts` mappers, `toml-patch.ts`, `jsonc.ts`, `convert.ts`, `import.ts`) writes into any
  root; use it to build prepared directories rather than instantiating the global adapters (which
  scan global homes and spawn CLIs).

## 8. Verification

Tests for every behavior, parsing, persistence and protocol change (AGENTS.md). In particular:
- Profile store: schema tolerance, revision conflicts, secret masking (never in responses/logs).
- Per-agent preparation output (golden files of generated configs).
- Isolation checks that need no model call, runnable in CI against fake HOME/global dirs: Claude SDK
  `initializationResult()`/`mcpServerStatus()`; Codex `skills/list` + MCP status on a thread;
  `grok inspect --json` (+ debug log for plugin hooks); OpenCode `debug config`/`debug skill`. Each
  asserts global items are absent and profile items present.
- Fixtures include **symlinked** global skills/plugins (real setups use them; Grok follows them).
- Two chats, same agent and account, different profiles, concurrently: distinct effective sets.
- Resume after daemon restart keeps the profile; profile switch mid-chat relaunches with the new set;
  deleting a profile falls back to Global with a notice.
- Codex: seeded home starts in < 2 s with the shared `sessions/`; never two processes before the
  first `initialize`.
- Global chats unchanged (regression).

## 9. Risks and unverified points

- Relies on undocumented/experimental knobs that a CLI update could change: Grok `GROK_AUTH_PATH`;
  OpenCode `OPENCODE_TEST_HOME` (probed at preparation, refused when unproven and needed);
  Codex `skills.bundled`, `features.apps/remote_plugin`; Claude's `skills` option interplay with
  the Workflow tool. Preparation's validation step (§6.5) must catch a regression and fail loudly.
- Claude: claude.ai-synced plugins unverified (none exist yet). Project `enabledPlugins` is
  verified and overridden (§6.1).
- Codex: refresh writes `auth.json` in place (non-atomic) — same as today's shared homes.
- Grok: deny list must track every globally discovered plugin by exact name, and the skills
  ignore list every global skill entry incl. symlinks (both rebuilt per spawn). A global skill
  symlink added while a Grok chat runs could appear if Grok reloads skills mid-chat; the isolation
  test must include a symlinked global skill.
- OpenCode: one extra server (and its MCP processes) per project × profile in use.

## 10. Left to the builder

Storage file layout within §4.4's constraints; code module names (§7); exact UI component split and
icons within §5 (mockups in the conversation: library card, editor with the icon segmented bar,
composer chip menu); whether Grok homes are per profile or per thread (§6.3); how the prepared-dir
staleness is tracked (hash of profile revision + CLI version is a reasonable key); export format.

## 11. Calls made during design (not owner-stated — check these)

- Hide built-in skills by default; Claude keeps the Workflow tool by default (§4.3).
- Background preparation on save; launch fails if preparation failed (§6.5).
- Deleting a profile → its chats fall back to Global with a notice at next launch (§5.6).
- Profiles flow through MCP `create_session`, workflows, fork and account switch (§5.5).
- Plugins come from an Orquester-owned per-profile cache, never installed into account/global dirs
  (§4.5).
- Hooks are single-agent items in each agent's own format; no cross-agent hook translation (§4.2).
- Unattended launches with a missing/failed profile fail instead of falling back; deleting a
  profile warns about workflows that use it (§5.5).
- Profile chats work on the System account too, linking to the system home's login and history
  (§6.2).

## 12. Implementation notes and deviations

Decisions made while building, each checked against the code. Code names use the
`SessionProfile…` prefix (`apps/daemon/src/session-profiles/`) so nothing collides with
`agent-profile/`, which is now the Global editor (Settings → Agent config).

**Storage and preparation (§4.4, §6.5)**
- Profiles live under `<appdir>/daemon/session-profiles/` (`profiles/<id>/`, `prepared/`, `staging/`;
  `packages/config` path helpers), not `agent-profiles/`.
- Prepared directories are **versioned and immutable**: one key per (profile, agent, account key)
  — per account for Codex only, `shared` for the others — holding `current.json` and
  `v-<fingerprint>-<time>-<random>/` version dirs. A preparation builds in `staging/`, writes
  `manifest.json` last, is renamed to a new version and flips `current.json`; a published version
  is never modified (a running Codex/Grok/OpenCode process may be using it). The fingerprint is
  the profile revision + the preparer's `version` + the CLI version + the content of the Global
  files the preparer reads (`inputs`), so a Global config change re-prepares.
- Old versions are garbage-collected only when unleased: the agent host reports the prepared dirs
  of live sessions and starts in flight (`GET /profiles/leases`), plus a 10-minute grace after
  `ensureReady` hands one out; when the host cannot answer, the pass removes nothing. At most two
  preparations run at once.
- **Refresh at every session start** (beyond §5.6/§7): before any provider start of a profile
  thread (first start, resume, crash restart, host-restart rehydrate, switch) the host asks the
  daemon's socket-only `threadLaunchProfile` route for the current version and launch fields and
  rewrites `launch.json`. An edited profile therefore applies at the next start, and a GC'd
  version never fails one. If the daemon cannot be asked, the persisted profile is used only while
  its manifest still validates; otherwise the start fails (never Global).
- Validation (§6.5) is per agent rather than a uniform CLI run at preparation: Codex validates the
  seeded, linked home; Grok's `grok inspect --json` runs at every spawn (an inspect failure fails
  the start); Claude and OpenCode are covered by their opt-in live checks
  (`*.live.test.ts`) and the launch-time manifest read.
- The daemon refuses profile launches while the agent host lacks the `sessionProfiles`
  capability (an older host would run them as Global).
- Deleted profile (§5.6): an interactive chat's next start answers the account's own launch with a
  `runtime.warning` notice naming the profile; unattended chats (`unattended` persisted on the tab,
  inherited by forks) are refused instead. `PROFILE_NOT_READY` / `PROFILE_UNSUPPORTED_AGENT` never
  fall back.

**Claude (§6.1)**
- A prepared dir is shared by every account: the generated local plugin (profile skills and
  commands), copied plugins, `instructions.md`, and an MCP file with the profile's servers and its
  plugins' servers lifted at preparation (plugins then load with `skipMcpDiscovery`).
- The profile's instructions are **appended to the system prompt**, not written as a CLAUDE.md.
- `strictMcpConfig` would drop the project's `.mcp.json`, so the launch passes the project's
  servers (minus `disabledMcpjsonServers`) explicitly; the `skills` allow-list would hide the
  project's `.claude/` skills and commands, so their names are added to it.
- `enabledPlugins: {<id>: false}` at the flag tier for every plugin in the account's
  `installed_plugins.json` and every id the project's settings enable.
- Flag-tier settings and MCP servers go through 0600 files under
  `<appdir>/tmp/claude-profile-launch/<threadId>/` (`--settings`, `--mcp-config`), never argv.

**Codex (§6.2)**
- Seeding runs **inside `prepare`, in the staging dir** (the state DB records no path of its home,
  so it survives the rename, and nothing can start on an unpublished home); `auth.json` is linked
  only after the seed.
- A preparer's `unusableReason` (state DB missing, e.g. after a Codex upgrade) makes every
  `ensureReady` prepare a new version instead of answering the current one; the launch
  contribution and the adapter also refuse an unseeded home.
- The adapter forces `CODEX_HOME` to the prepared dir, fails a start whose `initialize` reports
  another home, and switches off `$HOME/.agents/skills` (and any user skill outside the home) with
  nested `skills.config` at every `thread/start` and `thread/resume`.
- No opt-in live check against the real CLI exists for Codex; seeding is tested against a fake
  `codex app-server`.

**Grok (§6.3)**
- **One shared `GROK_HOME` per prepared version**, not per thread. `config.toml` is rendered from
  `profile/config.base.toml` **at every spawn** (fresh `[skills] ignore` incl. symlink targets, a
  `[plugins] disabled` list from `grok inspect --json` run with cwd = the home), serialized per
  home and swapped in by rename; the render does not depend on the thread, project or account.
- Profile plugins are copied under `profile/plugins/` (so Grok's own plugin scan never sees them
  twice) and passed with `--plugin-dir`, as is a generated plugin carrying the profile's hooks.

**OpenCode (§6.4)**
- Built-in skills are hidden with a last `permission.skill` rule denying `customize-opencode`, not
  with an allow-list profile agent.
- The server key is `profile:<profileId>:<version dir>`: an edit (a new version) moves a thread to
  a new server at its next start and the old one closes once idle, instead of recycling the
  profile's servers.
- The `XDG_CONFIG_HOME` shadow is built at preparation and refreshed by the launch contribution at
  every launch (the real `~/.config` changes without a profile edit); OpenCode's own writes
  (`package.json`, `node_modules/`, …) stay inside the version dir.
- `$HOME/.opencode` (always a config dir for OpenCode) is kept out with the undocumented
  `OPENCODE_TEST_HOME` pointed at an empty `<version>/home`. Verified on 1.18.34 that it moves only
  that lookup (plus the `~/.claude` fallbacks a profile turns off anyway): auth and the session DB
  under `XDG_DATA_HOME`, `{file:~/…}` and `permission` `~` paths keep the real HOME. Preparation
  probes the registry's binary (a canary command in a sandboxed fake `~/.opencode`, loaded without
  the variable and not with it, ~3 s once per binary); when unproven, a `~/.opencode` with config
  files or item dirs refuses preparation and every launch with `PROFILE_NOT_READY`.
- Instructions (verified on 1.18.34 by reading the system prompt OpenCode sends a local fake
  provider): `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` replaces `OPENCODE_DISABLE_CLAUDE_CODE=1`, and
  `<version>/opencode/AGENTS.md` is always written (empty without instructions), so the user's
  `~/.claude/CLAUDE.md` never loads (it would as the fallback when that file is missing;
  `OPENCODE_TEST_HOME` also moves that lookup) while the repo's `AGENTS.md`, else its `CLAUDE.md`,
  loads exactly as in Global. The launch refuses a version without the file.
- Known limits (1.18.34): `$HOME/.opencode` relies on an undocumented variable (above);
  OpenCode reads no project `.mcp.json` in Global or in a profile; npm plugins are not copyable.

**Verification (§8)** — per-agent preparer and launch unit tests; opt-in live checks
(`ORQUESTER_CLAUDE_LIVE=1`, `ORQUESTER_GROK_LIVE=1` with `ORQUESTER_GROK_LIVE_AUTH`,
`ORQUESTER_OPENCODE_LIVE=1`); and `apps/daemon/src/session-profiles/integration.test.ts`, which
drives the real store, lifecycle, preparers, launch resolver, `AgentChatService`, agent-host
server and each adapter's profile launch code against a temp HOME with symlinked Global skills:
concurrent profiles per agent, Global unchanged, restart + edit, switch, delete, failed
preparation.
