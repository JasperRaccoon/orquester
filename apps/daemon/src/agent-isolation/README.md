# Agent isolation primitives

Per-agent building blocks for Agent Profile chats (design spec
`docs/superpowers/specs/2026-10-18-agent-profiles-design.md` §6). They know
nothing about profiles: inputs and outputs are paths, parsed config objects and
strings. No dynamic `import()` here, since the agent host may import this module.
Facts below were checked against Claude Code 2.1.285 / Agent SDK 0.3.278,
codex-cli 0.159.0, Grok 1.0.46 and OpenCode 1.18.

**Runtime-settings carry-over (`runtime-settings.ts`, §6.0).**
`claudeRuntimeSettings`, `codexRuntimeConfig`, `grokRuntimeConfig` and
`opencodeRuntimeConfig` take the agent's parsed global config and return a deep
copy without the item keys: instructions, skills, MCP servers, plugins, hooks,
commands, agents and memory, plus anything that switches the user's own items on
or off. Every other key is kept, including unknown ones. Each dropped key and
the reason for dropping it is in the exported `*_DROPPED_*` maps. Claude also
loses the `{serverName}` entries of `deniedMcpServers`, because that is how the
Agent config editor disables a global server. Codex keeps `projects.*` trust
entries and filters each `[profiles.<name>]` the same way. Codex also drops
`[agents.<role>]` tables but keeps scalar limits such as `agents.max_threads`,
and drops `sqlite_home` (a profile home must never use the account's DBs).
Grok keeps `marketplace`, so Grok does not auto-install the official marketplace
again. Callers merge the recipe's keys over the result, and the recipe wins.

**Codex state-DB seeding (`codex-seed.ts`, §6.2).** A fresh `CODEX_HOME`
backfills its state DB from every rollout under `sessions/`. That takes tens of
seconds or more, and Codex answers nothing until it finishes. `seedCodexHome`
first creates `sessions/` as an empty real directory. It then runs `codex
app-server` through `initialize`, closes stdin (Codex exits cleanly; it is
killed if it lingers) and atomically links `sessions/` to the shared target.
Observed on a temp home: `state_5.sqlite` (`CODEX_STATE_DB_FILE`) exists when
`initialize` answers. If that file is missing afterwards, the call fails, so a
DB rename in a Codex upgrade is noticed. `codexStateDbPresent` tells callers to
re-seed. A missing DB with an existing link means unlink, seed, then relink. A
non-empty real `sessions/` is never replaced. Concurrent calls for the same home
share one run, so two processes never start before the first `initialize`.

**Grok exclusions (`grok.ts`, §6.3).** Grok's `[skills] ignore` skips real
subdirectories of an ignored directory but follows symlinked ones. So
`grokSkillIgnoreList` lists the `~` roots, then every entry of
`~/.claude/skills` and `~/.agents/skills` by absolute path. A symlinked entry
also adds its realpath; a dangling one adds only its own path. It adds
`<grokHome>/bundled/skills` when built-ins are hidden. Grok enables
Claude-installed plugins on its own, and only exact names in `[plugins]
disabled` stop them: `compat.claude.hooks=false` and `["*"]` do not.
`grokDiscoveredPluginNames` runs `grok inspect --json` and returns
`.plugins[].name`. It never throws; a failure comes back as `{ ok: false, error
}`. Inspect lists disabled plugins as enabled, so use the debug log to confirm
one is off. `renderGrokProfileConfigToml` writes the profile `config.toml` with
`[cli] auto_update/use_leader = false`. Every `compat.claude/cursor` cell is
false except `compat.claude.skills`: without it the repo's `.claude/skills` is
lost. It also writes `[skills] ignore`, `[plugins] disabled` and
`[mcp_servers]`. Grok rewrites its config itself, so render it at every spawn.
`GROK_PROFILE_ENV` turns off the same compat cells through the environment, but
never `GROK_CLAUDE_SKILLS_ENABLED`. `GROK_AUTH_PATH_ENV` names the variable
that points Grok at an `auth.json` outside its home (the account's). Grok 1.0.46 also has `compat.codex.*` cells.
They are documented as inert and are not written.

**OpenCode XDG shadow (`xdg-shadow.ts`, §6.4).** `OPENCODE_CONFIG_DIR` adds to
`~/.config/opencode` rather than replacing it. So a profile server gets
`XDG_CONFIG_HOME=<shadow>`, and `buildXdgConfigShadow` fills that shadow with a
symlink to every entry of the real `~/.config` except the excluded names.
Tools such as `gh` and git keep their config. The function is idempotent. Every
symlink in the shadow belongs to it, so it removes stale links and retargets
wrong ones. It leaves real files that a tool created in the shadow alone, never
writes into the real directory, and refuses overlapping paths.

**Claude local plugin (`claude-plugin.ts`, §6.1).** A profile chat drops the
user setting source, so its skills and commands arrive as one generated local
plugin: `.claude-plugin/plugin.json`, `skills/<name>/` and
`commands/<name>.md`. The plugin is built in a staging directory and swapped in
whole. Claude names a plugin skill `<plugin>:<dir>`. It names a plugin command
`<plugin>:<sub>:<stem>`, so `git/pr` becomes `<plugin>:git:pr`. The SDK `skills`
allow-list matches an exact name or a `:<entry>` suffix.
`generateClaudeLocalPlugin` returns the qualified ids as `allowlist`. Plugin
commands must be on that list, or they vanish from the model's listing.

**Claude names (`claude-names.ts`, §6.1).** A profile chat's `skills`
allow-list hides every skill or command not on it, and `strictMcpConfig`
drops the project's `.mcp.json` and plugin MCP servers, so the launcher names
what must stay. Observed on 2.1.285 without a model call: a skill is its
`SKILL.md` frontmatter `name`, else its directory; a command is its path with
`:` between folders; a plugin's entries are prefixed `<plugin>:`, its
`plugin.json` `skills` paths add to `skills/` and its `commands` paths replace
`commands/`. Project skills and commands come from `.claude/` of the cwd and
each ancestor below `$HOME`; project `.mcp.json` files from the cwd up to `/`,
the nearest winning, loaded without approval in an SDK session minus
`disabledMcpjsonServers`. `claudeInstalledPluginIds` reads
`plugins/installed_plugins.json`: a project's `enabledPlugins` turns those on
even without the user source, so the launcher switches them off.
