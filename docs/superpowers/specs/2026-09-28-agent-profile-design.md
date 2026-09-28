# Agent profile — manage the agents' skills, MCP servers, plugins, hooks, commands and instructions

Status: design approved by the owner on 2026-09-28, section by section (approach A, native-first
adapters; the coverage matrix with its two amendments; the daemon architecture; the panel with the
responsive addendum; linking, import/copy, errors and testing). This document is the written spec
awaiting the owner's review.

Research inputs (2026-09-28, CLIs as installed on the owner's VPS): the right rail and the saved
prompts section end to end; how Orquester owns the agents' homes (managed account homes, what is
symlinked, every place the daemon writes agent config); Claude Code 2.1.280, Codex 0.155.1, Grok
Build 1.0.34 and OpenCode 1.18.32 configuration formats, read from their docs, their binaries and
this host's real files; a verification pass on each CLI's native per-item disable mechanisms.

## 1. Problem and goal

Changing what an agent loads — removing an MCP server, turning a skill off, installing a plugin,
editing the global instruction file — today means asking an agent session to edit several config
files in several formats by hand (the Serena removal of 2026-09-28 touched ten files across four
agents plus the account homes). The goal is a fourth right-rail section, **Agent profile**, where
the owner lists, adds, edits, turns on/off and deletes each agent's items directly.

### 1.1 Requirements (the owner's)

1. A fourth right-rail section named **Agent profile**, for Claude, Codex, Grok and OpenCode.
2. Manage skills, MCP servers, plugins, hooks and the system-prompt append, plus instruction files,
   slash commands and plugin marketplaces. (Subagents were dropped by the owner during review.)
3. Add, edit, turn on/off, delete — easily, per item.
4. Add a skill/command by writing it in an editor, importing from a Git URL, uploading a
   file/folder/zip, or copying from another agent.
5. **Global only**: one profile per agent, applying to every account and every project. No project
   scope.
6. "System prompt append" **is** the global instruction file (`CLAUDE.md` / `AGENTS.md`), which
   applies to chats and terminal tabs alike. No separate Orquester-injected text.
7. Fix the account-home gaps so a global edit reaches every managed account.
8. **Do not touch claudex / claudemix** (being removed in another line of work): their proxy homes
   are never read or written and they never appear in the panel.
9. It must look good, work on mobile and be responsive.

### 1.2 Out of scope

Project-scoped items (`.mcp.json`, `<repo>/.claude/…`, `.codex/config.toml`, …); claudex and
claudemix; Claude output styles and `~/.claude/rules/`; per-session enabling of an item; a UI for
the write backups; tools for the Orquester MCP; **subagents** (custom agent definitions —
`~/.claude/agents`, `~/.codex/agents`, `~/.grok/agents`, OpenCode `agents/`), removed from scope
by the owner on review, including linking those directories into account homes.

## 2. Approach

**A — native-first adapters.** The CLIs' own files are the only source of truth: every snapshot is
read from them, so an edit made by hand or by a session shows up at once. Every write goes through
the path the vendor maintains where one exists (Claude's `plugin` CLI and its `.claude.json` lock;
Codex's app-server config API; Grok's `mcp`/`plugin` CLI; OpenCode's own JSONC editing library).
"Off" uses a native flag where the CLI has one and a stash (the item moved aside by Orquester,
restored byte for byte) only where it has none.

Rejected: B, hand-editing every file directly (re-implements plugin install bookkeeping and Codex's
hook trust, loses TOML comments); C, an Orquester-owned canonical profile projected into each CLI
(two sources of truth; edits made outside Orquester are overwritten or drift).

## 3. Coverage matrix

Item kinds: `instructions`, `mcp`, `skill`, `plugin`, `marketplace`, `hook`, `command`. Paths are
the daemon user's own homes (`HOME=/var/lib/orquester` in production), each resolved to its realpath before any write. "Stash" = `<appdir>/daemon/agent-profile/stash/…`
(§4.4).

| Kind | Claude | Codex | Grok | OpenCode |
|---|---|---|---|---|
| **instructions** (editor, no toggle) | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md`; warn when a non-empty `AGENTS.override.md` shadows it | `~/.grok/AGENTS.md`; offer to migrate a dead `~/.grok/GROK.md` (Grok never reads it) | `~/.config/opencode/AGENTS.md` |
| **mcp** | `~/.claude.json` top-level `mcpServers`; off = `deniedMcpServers: [{serverName}]` in `~/.claude/settings.json` | `[mcp_servers.<n>]`; off = `enabled = false` | `[mcp_servers.<n>]` in `~/.grok/config.toml`; off = `disabled_mcp_servers` (via `grok mcp disable`) | `mcp.<n>` in `opencode.jsonc`; off = `enabled: false` |
| **skill** | `~/.claude/skills/<n>/SKILL.md`; off = `skillOverrides.<n> = "off"` in user settings | `~/.codex/skills/<n>/SKILL.md` (bundled `.system` skills listed as *Bundled*); off = `skills/config/write` | `~/.grok/skills/<n>/SKILL.md`; off = `[skills] disabled` | `~/.config/opencode/skills/<n>/SKILL.md`; off = `permission.skill.<n> = "deny"` |
| **plugin** | `claude plugin install/uninstall --scope user`; off = `enabledPlugins["<id>"] = false` | `plugin/install`, `plugin/uninstall`; off = `[plugins."<id>"] enabled = false` | `grok plugin install/uninstall`; off = `[plugins] disabled` (`grok plugin disable`) | `plugin[]` entries and `plugin/*.{js,ts}` files; off = stash |
| **marketplace** | `claude plugin marketplace add/remove` | `marketplace/add`, `marketplace/remove` | `grok plugin marketplace add/remove` (`[[marketplace.sources]]`) | — (none) |
| **hook** | `hooks` in `~/.claude/settings.json`; off = stash (Claude has no per-hook disable) | `~/.codex/hooks.json`; off = `[hooks.state."<key>"] enabled = false`; trust hash written on add (§4.6) | `~/.grok/hooks/*.json`; off = stash | — (OpenCode hooks are plugin code) |
| **command** | `~/.claude/commands/**/*.md`; off = stash | legacy `~/.codex/prompts/*.md`: listed read-only, deletable (deprecated, no longer loaded) | `~/.grok/commands/*.md`; off = `[skills] disabled` | `~/.config/opencode/commands/**/*.md`; off = stash |

### 3.1 Cross-cutting rules

- **Inherited items** — items an agent loads from somewhere it does not own: Grok and OpenCode read
  `~/.claude/skills` (and Grok `~/.claude.json`'s MCP servers); Codex, Grok and OpenCode read
  `~/.agents/skills`; every plugin's own skills, hooks, commands and MCP servers. They
  are listed with a source badge (*From Claude*, *Shared · ~/.agents*, *Plugin · superpowers*).
  Edit and Delete belong to the owner ("Manage in Claude", "Manage in plugin"). The switch works
  only where the listing agent has its own native per-item disable for it, and then affects only
  that agent: Grok `disabled_mcp_servers` (compat and plugin servers included) and `[skills]
  disabled`; OpenCode `permission.skill`; Codex `skills/config/write` by name. Otherwise the switch
  is disabled with a tooltip.
- **Locked items** — Orquester's own and the CLIs' own: every `agent-hook.sh` hook group
  (`isManagedGroup`) in Claude's `settings.json` and Codex's `hooks.json` and their `hooks.state`
  entries; `~/.grok/hooks/orquester.json`; `~/.config/opencode/plugin/orquester-status.js`; the
  CLI-owned `synced/` directories under `~/.claude/skills` and `~/.claude/plugins`. Listed with a
  lock, refused with 403 `ITEM_LOCKED`.
- **Reach** — changes apply to new sessions and turns; running chats are not restarted. OpenCode is
  the exception that needs help: `opencode serve` caches its global config forever, so after an
  OpenCode write the daemon asks the agent host to recycle idle OpenCode servers (§4.8).
- **claudex / claudemix** proxy homes (`<appdir>/daemon/cliproxy/claude-home-*`) are never read or
  written.

## 4. Daemon

### 4.1 Module

`apps/daemon/src/agent-profile/`:

| File | Role |
|---|---|
| `service.ts` | `AgentProfileService`: one mutation queue per agent, revisions, change detection, lifecycle events. |
| `adapters/types.ts` | `ProfileAdapter` interface: `snapshot()`, `readItem(id)`, `create(draft)`, `update(id, draft)`, `setEnabled(id, on)`, `remove(id)`, `readInstructions()`, `writeInstructions(text)`, `watchPaths()`. |
| `adapters/{claude,codex,grok,opencode}.ts` | All format knowledge. Nothing else reads or writes a CLI file. |
| `claude-json.ts` | `~/.claude.json` edits under Claude's own lock (`proper-lockfile`, lock path `<file>.lock`, `realpath: false`): re-read inside the lock, patch only the keys this module owns, write atomically, mode 0600 kept. |
| `codex-config-client.ts` | A short-lived `codex app-server` (daemon user's `CODEX_HOME`) for `config/read`, `config/batchWrite` (`expectedVersion`, `reloadUserConfig: true`), `skills/list`, `skills/config/write`, `hooks/list`, `plugin/*`, `marketplace/*`. Spawned on demand, reused while calls are pending, closed after 30 s idle, every call under a deadline. Reuses the codex adapter's NDJSON JSON-RPC framing; the generated bindings are regenerated from the installed 0.155.1 first. |
| `cli-runner.ts` | Runs `claude plugin …` and `grok mcp|plugin …`: argv only (no shell), explicit env built like `sessionEnvBase` with `HOME` = the daemon user's home and no `CLAUDE_CONFIG_DIR`/`GROK_HOME`, a deadline, `--json` where the CLI has it, stderr redacted before it is returned. Never `claude mcp list/get` (they spawn servers). |
| `jsonc.ts` | `jsonc-parser` `modify` + `applyEdits` (2-space indent, comments kept) — OpenCode's own library. |
| `toml-patch.ts` | Comment-preserving TOML edits for Grok (`@decimalturn/toml-patch`), used for `[skills] disabled`, `[plugins]` and table deletes the CLI does not do. |
| `frontmatter.ts` | YAML frontmatter parse/serialize (`yaml`) for SKILL.md, agents and commands. |
| `stash.ts` | §4.4. |
| `backups.ts` | Before every write the previous file (or the directory for a directory delete) is copied to `<appdir>/daemon/agent-profile/backups/<agent>/<stamp>-<name>`; a ring of the last 50 per agent. |
| `import.ts`, `convert.ts` | §6. |
| `routes.ts` | `registerAgentProfileRoutes(app, deps)`, like the workflows registrar. |

New dependencies: `proper-lockfile`, `jsonc-parser`, `@decimalturn/toml-patch`, `yaml`.

### 4.2 Wiring

In `startDaemon` next to the saved-prompts service: construct `AgentProfileService` with getters
for the homes and `<appdir>`, the registry (to know which agents are installed and their bins),
the agent-chat service (for §4.8) and a logger; `publishAgentProfileEvents(service, broadcaster)`;
register the routes on both transports; `stop()` closes the watchers and any codex app-server.

### 4.3 Items, ids and revisions

```ts
type AgentProfileAgentId = "claude" | "codex" | "grok" | "opencode";
type ProfileItemKind = "mcp" | "skill" | "plugin" | "marketplace" | "hook" | "command";
interface ProfileItem {
  id: string;                  // stable, see below
  kind: ProfileItemKind;
  name: string;
  description?: string;
  enabled: boolean;
  toggleable: boolean;         // false for locked, and for inherited items without a native disable
  editable: boolean;           // false for locked, inherited, bundled, legacy
  deletable: boolean;
  source: { type: "user" | "plugin" | "inherited" | "bundled" | "orquester" | "cli";
            label: string };    // "User", "Plugin · superpowers", "From Claude", …
  locked: boolean;
  path?: string;               // display only
  warnings: string[];          // "Not trusted by Codex", "Plugin cache missing", …
}
interface AgentProfileSnapshot {
  agent: AgentProfileAgentId;
  installed: boolean; version?: string;
  revision: string;
  instructions: { path: string; exists: boolean; bytes: number; lines: number; mtime?: string;
                  warning?: string };
  items: ProfileItem[];
  fileErrors: { path: string; message: string }[];
}
```

Ids are derived from content, never positions: `<kind>:<name>` for named items
(`mcp:jira-cloud`, `plugin:superpowers@claude-plugins-official`); hooks
`hook:<event>:<sha256 of the normalized {matcher, handler}>` truncated to 16 hex. The revision is
a hash over the size, mtime and inode of every file and directory entry the adapter reads; every
mutation carries the revision the client saw and a mismatch answers 409 `PROFILE_CONFLICT` with the
fresh snapshot.

### 4.4 Stash

Only for kinds with no native disable (§3). `stash/<agent>/<kind>/<id>/` holds the item exactly as
it was (a file, a directory, or a JSON fragment for a hook entry) plus `manifest.json`
`{kind, name, originalPath | {event, matcher}, stashedAt}`. Off moves the item there (a rename on
the same filesystem, else copy + fsync + delete) and removes a hook entry from its settings group;
on restores it to its original path (a hook back into a group with the same matcher, or a new
group), refusing with 409 `STASH_CONFLICT` when something now occupies that path. Stashed items are
part of the snapshot, `enabled: false`. Delete of an off item deletes the stash entry.

### 4.5 Writes, validation and safety

- Per-agent mutation queue: two writes to one agent never interleave; the snapshot is re-read at
  the start of each mutation.
- Every write targets the realpath of the system-home file (the `writeFileAtomic` rule, never a
  write through an account-home symlink), keeps the file's mode, and is preceded by a backup (§4.1).
- After each direct write the file is re-parsed with the same parser the adapter reads with; a
  file that no longer parses is restored from its backup and the mutation fails with 500
  `WRITE_VERIFY_FAILED`.
- Names are validated per CLI before anything is written: Grok MCP `[A-Za-z_][A-Za-z0-9_-]*` not
  ending in `_`; skill names `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 64 (OpenCode, Codex, Grok; Claude
  accepts the same); file names never contain `/`, `..` or NUL.
- Frontmatter is validated before writing (OpenCode throws on a bad command frontmatter and loses
  its whole config).
- A file the adapter cannot parse makes the snapshot partial (`fileErrors`), and every mutation
  that would write that file answers 409 `CONFIG_UNREADABLE` — never a guess, never an overwrite.
- An agent that is not installed answers 404 `AGENT_NOT_INSTALLED`; a CLI call that times out or
  exits non-zero answers 502 `AGENT_CLI_FAILED` with its redacted stderr.
- Errors are `{error: {code, message}}` like the workflow routes.

### 4.6 Per-agent notes

**Claude.** MCP definitions go to `~/.claude.json` through `claude-json.ts`; each managed account
home re-copies the top-level `mcpServers` at every launch (`seedClaudeConfig`), so no per-account
write is needed. `deniedMcpServers` also blocks a project server of the same name — the UI says so
on the off switch's tooltip. Plugin and marketplace install/uninstall go through `claude plugin …
--scope user` (exact flags confirmed against `claude plugin --help` in the plan); toggles write
`enabledPlugins` directly in `~/.claude/settings.json`. Every settings write preserves the hook
groups `isManagedGroup` recognises and every key this module does not own.

**Codex.** `config.toml` changes go through `config/batchWrite` only (comments kept, versions
checked, the whole config validated). `hooks.json` is plain JSON the daemon edits itself; then
`hooks.state` is rewritten through `config/batchWrite`: a hook's key embeds the `hooks.json` path
**as seen**, so the trust entry (`trusted_hash`, computed by the existing `codexTrustHash`) and
`enabled` are written for the system path and for every managed account home's path, and because
keys are positional every existing state entry is re-keyed after a group is inserted or removed by
matching its `trusted_hash` to the hook's new position (the manual repair of 2026-09-28, done
properly). A hook `hooks/list` reports `modified` or `untrusted` shows a warning with a **Trust**
action.

**Grok.** MCP add/remove/enable/disable and plugin install/uninstall/enable/disable and
marketplace add/remove go through `grok …`; `[skills] disabled` and
anything else through `toml-patch.ts`. `[compat.claude] hooks = false` is never changed (Claude's
hooks would double-report status). The per-thread `GROK_CONFIG_PATH` overlay is untouched.

**OpenCode.** All config edits through `jsonc.ts` on `~/.config/opencode/opencode.jsonc` (or
`opencode.json` when that is the file in use); the `$schema` line OpenCode inserts is kept.

### 4.7 Change detection and events

`fs.watch` on the realpath of every file and directory in each adapter's `watchPaths()`, debounced
500 ms, recomputes that agent's revision and publishes `agentProfile.changed {agent, revision}` on
the `agent-profile` channel when it moved. Our own mutations publish the same event when they
finish. A watcher that errors is re-armed on the next snapshot read; watching is best-effort — the
revision check on every mutation is the correctness guarantee.

### 4.8 OpenCode server recycling

A new agent-host route `POST /opencode/recycle-idle` stops every `opencode serve` the host owns
that has no active turn (the next turn in that project starts a fresh server, which reads the new
config); a server with a turn running is marked and recycled when it goes idle. The daemon calls it
after every OpenCode mutation, fire-and-forget; a host from before the route answers 404, which is
ignored, and the notice then says "applies once OpenCode's server restarts".

## 5. Account-home linking

`syncAccountHome` (`apps/daemon/src/agent-accounts.ts`) gains, with the existing
`ensureSharedDirSymlink` / `ensureSharedFileSymlink` rules:

| Agent | New shared links | Already shared |
|---|---|---|
| Claude | `CLAUDE.md`, `commands/` | `skills/`, `plugins/`, `settings.json`, `projects/` |
| Codex | `skills/` | `config.toml`, `hooks.json`, `sessions/` |
| Grok | `AGENTS.md`, `commands/`, `rules/` | `config.toml`, `trusted_folders.toml`, `hooks/`, `plugins/`, `skills/`, `sessions/` |

An account home that already has its own real copy is merged into the shared one first, as
`projects/` is today; on a name collision both are kept, the account's copy suffixed
`-<accountId prefix>`. Codex's bundled `.system` skills stay per home: the shared `skills/` link is
made only once the account's `skills/.system` has been merged (Codex re-creates it at start). Proxy
homes are untouched.

## 6. Import and copy

- **Write** — the editor (§7.4).
- **Git URL** — `git clone --depth 1` (argv, no shell) into `<appdir>/tmp/agent-profile-import-*`,
  60 s deadline, 50 MB cap; a `…/tree/<ref>/<path>` URL selects a subfolder. The clone is scanned
  for `SKILL.md` directories (or `.md` command files); the owner picks which to import;
  symlinks inside the repo are refused; files are copied (the item is not linked to the repo); the
  clone is deleted afterwards.
- **Upload** — `.zip` or `.md` streamed to disk like the existing uploads (octet-stream body,
  `MAX_UPLOAD_BYTES`); zip entries are checked for absolute paths, `..` and symlinks before
  extraction; folder uploads use the existing relative-path upload into a temp dir.
- **Copy from / to another agent** — `convert.ts`:
  - skills copied as they are (all four use `SKILL.md`), frontmatter keys the target does not know
    dropped with a note, the name checked against the target's rule;
  - MCP servers converted between Claude JSON, Codex/Grok TOML and OpenCode JSONC (stdio ↔
    `command` array, `env` ↔ `environment`, http `url`/`headers`); secret values moved daemon-side;
    fields the target has no equivalent for listed in the result;
  - commands copied as `.md`; a command copied to Codex becomes a skill.
- A name collision asks: **Replace**, **Keep both** (suffixed) or **Cancel**.

## 7. UI

### 7.1 Registration

`RightRailPanelId` gains `"profile"`; registry entry `{id: "profile", title: "Agent profile",
shortTitle: "Profile", Icon: SlidersHorizontal}`; `RIGHT_RAIL_PANEL_ORDER` appends it;
`isRightRailPanelId` and the render checks' hard-coded counts are updated. On phones it is the
fifth bottom-bar item (the bar's maximum, so no "More").

### 7.2 Client state

`packages/ui/src/lib/agent-profile/store.ts`, a vanilla zustand store like
`lib/saved-prompts/store.ts`: per-agent snapshots with load status, single-flight loads, a
`notice`, the last picked agent (module-remembered and persisted in localStorage with field-wise
validation), `agentProfile.changed` routed from `applyEvent` (refetch that agent when the revision
differs), stale on reconnect, reset on sign-out and connection switch. Wire snapshots are sanitized
field by field. `ApiClient` methods for every route in §8.

### 7.3 Panel layout

Top to bottom:

1. **Agent picker** — a segmented control (icon + name) of the four agents; not-installed agents
   disabled. Defaults to the visible chat tab's agent (`providerForRefId` on the tab's `refId`),
   else the last picked.
2. **Search** and a single horizontally scrolling row of **kind chips with counts** (All · MCP ·
   Skills · Plugins · Hooks · Commands · Marketplaces — only the kinds that agent
   has).
3. **Instructions card** — "CLAUDE.md · 42 lines · edited 2h ago", opening the instructions editor;
   its warning (override file, dead `GROK.md`) as a chip.
4. **Grouped list** — a section label per kind; each row: name, one-line description, source badge,
   the on/off switch (the workflows `EnabledSwitch`), a "…" `AdaptiveMenu` (Edit · Copy to… ·
   Copy file path · Delete). Off rows dimmed; locked rows with a lock and tooltip; inherited rows
   with "Manage in …"; warnings as amber chips (with an action where one exists, e.g. Trust).
   A `fileErrors` banner offers the file path.
5. **Footer** — a full-width **+ Add** button opening a menu of the kinds this agent supports, and
   a one-line hint.

States each designed: loading, agent not installed ("Install it from Settings → Agents"), empty
kind ("No MCP servers yet. Add one"), no search matches, load error with Retry, partial snapshot.
Feedback through the inline notice row ("Saved — applies to new sessions"; OpenCode: "OpenCode
servers restart when idle"); a 409 refreshes the list and says so. Delete asks through
`ConfirmDialog` when docked and on the card itself in the phone section, as saved prompts do.

### 7.4 Editors

Mounted once through a bridge host (`AgentProfileEditorHost`, like `SavedPromptEditorHost`); a
`Modal` on desktop, a full-screen sheet on phones.

- **Skill / command** — a source switcher (Write · Git URL · Upload · Copy from agent).
  Write: the known frontmatter fields for that agent and kind as inputs, the body in CodeMirror
  markdown. A skill with other files: `SKILL.md` edited, the rest listed read-only.
- **MCP server** — name; transport (stdio / http); command and arguments (a list); env and headers
  as key/value rows where an existing secret shows "••• set" with Replace and Remove; URL; timeout;
  an **Advanced** disclosure for per-agent fields (Codex `enabled_tools`/`disabled_tools`/
  `startup_timeout_sec`/`tool_timeout_sec`, Grok `startup_timeout_sec`, OpenCode `timeout`).
- **Hook** — event (the agent's own event list), matcher, command, timeout.
- **Plugin** — a marketplace, then a plugin from its catalogue (read from the marketplace clone);
  OpenCode: an npm spec or a file.
- **Marketplace** — GitHub `owner/repo`, git URL or local path.
- **Instructions** — a large CodeMirror markdown editor; a save against a file that changed on disk
  offers **Reload** or **Overwrite**.

### 7.5 Responsive and mobile (requirements)

- Layout follows the panel's own width (a width hook), not the viewport: the dock spans 260–560 px
  and the phone section is the whole screen.
- Agent picker: segmented with icon + name when it fits; below ~300 px a single dropdown
  ("Claude ▾") — "OpenCode" is never clipped.
- Kind chips: one horizontally scrolling row with edge fades, never wrapping.
- Rows: the name truncates with an ellipsis (full name in a tooltip), the description is clamped to
  one line, the badge shrinks first; the switch and "…" keep fixed widths; touch targets ≥ 40 px in
  the phone section.
- MCP env/header rows: key | value side by side when wide, stacked when narrow.
- Phones: the panel is a full-screen section; "…" menus are bottom sheets; editors are full-screen
  sheets with a sticky header (title, Cancel), a scrolling body and a sticky Save bar that stays
  above the soft keyboard (the existing visual-viewport sizing); CodeMirror fills the remaining
  height; safe-area insets follow the repo rule (in-flow components never pad them again, fixed
  overlays pad their own).
- Only the rail primitives and the `neutral` palette, so all seven colour schemes × light/dark
  work; amber/red only for warnings and destructive actions; switches carry `aria-label="Turn off
  <name>"`; visible focus rings; the dock's keyboard rules (`useOpenLayer` for every portaled
  overlay, Escape handled by an overlay calls `preventDefault()`).

## 8. API

Wire types and the route builder `agentProfileRoutes` in `packages/api/src/agent-profile.ts`;
both transports, bearer auth on HTTP.

| Route | |
|---|---|
| `GET /api/agent-profile` | `{agents: [{agent, installed, version?, counts}]}` |
| `GET /api/agent-profile/:agent` | `AgentProfileSnapshot` |
| `GET /api/agent-profile/:agent/items/:id` | the item's editable detail (frontmatter fields + body; MCP definition with secret values replaced by `{set: true}`) |
| `POST /api/agent-profile/:agent/items` | create: `{revision, kind, draft}` or `{revision, kind, from: {git: {url}} \| {agent, itemId} \| {upload: uploadId}, pick?, onConflict?}`; plugin and marketplace installs |
| `POST /api/agent-profile/:agent/uploads` | streamed `.zip`/`.md` → `{uploadId, found: [{kind, name}]}` |
| `POST /api/agent-profile/:agent/imports/scan` | `{git: {url}}` → `{importId, found: [{kind, name, path}]}` |
| `PUT /api/agent-profile/:agent/items/:id` | `{revision, draft}` |
| `POST /api/agent-profile/:agent/items/:id/enabled` | `{revision, enabled}` |
| `DELETE /api/agent-profile/:agent/items/:id?revision=` | |
| `POST /api/agent-profile/:agent/items/:id/copy` | `{toAgent, onConflict?}` |
| `GET` / `PUT /api/agent-profile/:agent/instructions` | `{text, revision}` |
| `POST /api/agent-profile/:agent/items/:id/trust` | Codex hooks only |

MCP secrets: a draft's env/header entry is `{key, value}` (set or replace), `{key, keep: true}`
(unchanged) or absent (removed); values never appear in any response, event or log.

Events on `agent-profile`: `agentProfile.changed {agent, revision}`.

## 9. Testing

- Adapter tests on a temp HOME per agent, with fixture configs shaped like this host's real files
  (secrets replaced): list, create, edit, on/off round trip, delete, locked refusals, inherited
  toggles, stash restore conflicts, unknown keys and comments surviving an edit (TOML, JSONC),
  `.claude.json` lock honoured, the Codex `hooks.state` re-keying, the trust hash against hashes
  the real CLI stored.
- A fake `codex app-server` and fake `claude` / `grok` binaries on PATH, so no test touches a real
  agent or a real home.
- Converter tests for every MCP / command pair; import tests (zip traversal and symlink
  refusal, git subfolder selection with a local bare repo).
- Account-home linking tests (merge, collision suffixing, Codex `.system`).
- Route tests through `inject` on a temp appdir; store tests; `*.check.ts` render checks for every
  row state, every empty/loading/error state and every editor, docked and sheet.
- Screenshot pass with Playwright at 360×740, 390×844, 768×1024 and 1440×900, the dock at 260 and
  560 px, light and dark — against a separate checkout and daemon on another port, started only
  with the owner's explicit approval (AGENTS.md forbids a daemon on this checkout).
- `pnpm check` and `pnpm test` clean.

## 10. Verification items the plan resolves first

1. Exact `claude plugin` / `claude plugin marketplace` flags (`--scope user`, `--json`, non-
   interactive confirmation) and the `grok mcp|plugin` equivalents, from `--help`.
2. Regenerate the Codex app-server bindings from 0.155.1 and confirm `config/batchWrite` against a
   symlinked `config.toml` writes the target file.
3. `@decimalturn/toml-patch` against a copy of the real `~/.grok/config.toml`: comments, the
   `[plugins]` array, `[[marketplace.sources]]` and a table delete.

## 11. Build order

1. Wire types, config paths, the four new dependencies; verification items §10.
2. Infrastructure: backups, stash, `claude-json.ts`, `jsonc.ts`, `toml-patch.ts`,
   `frontmatter.ts`, `cli-runner.ts`, `codex-config-client.ts`.
3. Adapters: OpenCode, Grok, Claude, Codex — each with its tests.
4. Service, routes, events, wiring; the agent-host recycle route.
5. Account-home linking.
6. Import and copy.
7. Client store and `ApiClient`.
8. The panel (registration, list, rows, states).
9. The editors.
10. Responsive pass and the screenshot review; AGENTS.md updated (a feature line, the module, the
    gotchas: native-first writes, the Codex `hooks.state` re-keying, the stash, the locked items).
