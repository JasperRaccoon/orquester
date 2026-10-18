# Agent Profiles (`session-profiles/`)

Orquester-owned, per-session kits of instructions, skills, MCP servers, plugins, hooks and
commands (spec: `docs/superpowers/specs/2026-10-18-agent-profiles-design.md`). User-facing name
"Agent Profiles"; code prefix `SessionProfile…` so nothing collides with `agent-profile/` (the
per-agent GLOBAL config editor, user-facing "Agent config"). A chat without `profileId` is Global.

## Module map

| File | Role |
|---|---|
| `layout.ts` | File layout inside one profile's directory (`profileLayout(dir)`). |
| `store.ts` | `SessionProfileStore`: the only writer. CRUD of profiles and items, revisions, per-profile queue, secrets, `readSource`. |
| `resolve.ts` | `resolveForAgent(source, agent)` → `ResolvedAgentProfile` (pure). Settings defaults, scope/support rules. |
| `manifest.ts` + `manifest/<agent>.ts` | Prepared-dir `manifest.json` envelope + per-agent section schemas; read by the agent host. |
| `preparer.ts` + `preparers/<agent>.ts` | Per-agent preparer contract and registry (`null` = not supported yet). `preparers/codex.ts`: the prepared `CODEX_HOME` (see "Codex" below). |
| `contributions/<agent>.ts` | Per-agent launch contributions (what a profile chat adds to its account's launch); `contributions/codex.ts`: `CODEX_HOME` and `homePath` = the prepared home. |
| `lifecycle.ts` | `SessionProfileLifecycle`: builds and publishes immutable prepared versions, tracks and refreshes them, collects unleased old ones; `ensureReady` for launches. |
| `service.ts` | `SessionProfileService`: wire mapping (secrets masked), events, prepare status, `resolveForAgent(profileId, agent)`; the import entry points delegate to `imports.ts`. |
| `imports.ts` | `SessionProfileImports`: Import from Global (via Agent config), git / zip / md scans, copy from profile, plugins into the profile's cache, export / import of a profile. Gathers outside the queue, writes with ONE `store.importItems`. |
| `export.ts` | The export `.zip` format, its builder, and the strict reader behind "Import profile from file". |
| `files.ts` | `measureTree` (no symlinks, caps), `normalizeProfileModes`, the in-memory zip writer. |
| `routes.ts` | REST surface (`sessionProfileRoutes`), both transports. |
| `errors.ts` | `SessionProfileError` → `{error: {code, message}}`. |

Contracts: `@orquester/api` `session-profiles.ts` (wire types, `sessionProfileRoutes`,
`SESSION_PROFILES_CHANNEL`, scope helpers) and `@orquester/config` `session-profiles.ts`
(persisted manifest/secrets schemas) plus the path helpers in its `index.ts`.

## Storage

```
<appdir>/daemon/session-profiles/                 sessionProfilesDir(appdir)          0700
  profiles/<profileId>/                           sessionProfileDir(appdir, id)       0700
    profile.json   secrets.json   instructions.md   skills/<itemId>/   commands/<itemId>.md   plugins/<itemId>/
  prepared/<profileId>/                           sessionProfilePreparedProfileDir(appdir, id)
    <agent>/<accountKey>/                         sessionProfilePreparedKeyDir(...)          one KEY
      current.json                                SESSION_PROFILE_PREPARED_CURRENT_FILE      {"schema":1,"version":"<version>"}
      <version>/                                  sessionProfilePreparedDir(..., version)    one immutable preparation
  staging/                                        sessionProfileStagingDir(appdir)
```

- Item directories are keyed by item ID (stable across renames); the item's name is in the
  manifest (and a skill's `SKILL.md` `name`). Preparers copy to `<target>/<name>/`.
- `revision` is a counter in the manifest, a decimal string on the wire. Every mutation names it
  and bumps it; a stale one is 409 `PROFILE_CONFLICT`. Profile names are unique (case-insensitive).
- MCP env/header values are only in `secrets.json` (0600); views carry `{key, set: true}`, drafts
  `{key, value}` / `{key, keep: true}` / absent = removed. Only `store.readSource` (and so
  `resolveForAgent`) returns real values — never log them, never return them from a route.
- Unreadable items are kept verbatim and reported (`itemErrors`); unknown fields survive rewrites.
- Plugins: the store keeps the record and `plugins/<itemId>/` (`store.pluginCacheDir`). The HTTP
  create route refuses `kind: "plugin"`; plugins arrive only through `…/plugins`, Import from
  Global, copy from profile and profile import (see "Plugin cache" below).

## Plugin cache (what the per-agent preparers consume)

A plugin item is single-agent (`agents: [agent]`). `plugins/<itemId>/` holds the plugin's files
copied WHOLE (no symlinks; dirs 0700, files 0600, 0700 when executable) — never installed into
an account's or Global's plugin dirs. The record (`ResolvedPlugin`: `name`, `marketplace?`,
`version?`, `cacheDir`) plus provenance `record.plugin.source` (`SessionProfilePluginSource`:
`type` `marketplace`|`global`, `marketplace?`, `commit?`, `url?`, `ref?`, `copiedAt`).

| Agent | `cacheDir` holds | Record | Preparer does |
|---|---|---|---|
| Claude | the plugin ROOT, always with `.claude-plugin/plugin.json` (a catalogue-only `strict: false` plugin gets a minimal `{name, version?}` one) | `name` = plugin name (not `name@marketplace`), `marketplace`, `version` (catalogue → manifest → commit[0..12]) | pass `cacheDir` as a local SDK plugin (`plugins: [{type: "local", path: cacheDir}]`); `${CLAUDE_PLUGIN_ROOT}` resolves to it |
| Codex | the plugin ROOT of ONE version (`.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`; from Global: the reported version's directory of `plugins/cache/<mp>/<name>/`) | `name`, `marketplace` (needed for the id), `version` (may be absent: use `"local"`) | copy to `<CODEX_HOME>/plugins/cache/<marketplace>/<name>/<version>` and write `[plugins."<name>@<marketplace>"] enabled = true` |
| Grok | the plugin directory (`.grok-plugin/`, `.claude-plugin/` or `plugin.json` manifest, as found) | `name`, `marketplace?`, `version?` | `--plugin-dir <cacheDir>` (or copy to `<GROK_HOME>/plugins/<name>/`); keep its name out of the `[plugins] disabled` deny list |
| OpenCode | the plugin file(s) at the TOP level (`notify.js`, …), copied from a Global plugin file; npm plugins are not copyable | `name` = the file name | copy every top-level `*.js`/`*.ts`/`*.mjs` into `<OPENCODE_CONFIG_DIR>/plugin/` |

Remote marketplace sources (Claude catalogue `github` / `url` / `git` / `git-subdir`, Codex
`source.url`, Grok git/GitHub marketplaces resolved through the clone's catalogue) are fetched
with Agent config's safe `git clone` (`agent-profile/import/git-clone.ts`: https/ssh only, no
credentials, deadline); `.git` is removed before the copy. Sources that are not repositories
(npm, pip, Codex's remote-only catalogues) are refused with a pointer to Agent config.

## Imports, copies, export (`imports.ts`, `export.ts`)

- Routes: `…/:id/imports/global` (GET list, POST import), `…/:id/imports/git`, `…/:id/imports/upload`
  (octet-stream), `…/:id/imports/:importId` (take a scan), `…/:id/copy-from`, `…/:id/plugins`,
  `…/:id/export` (GET zip), `/api/session-profiles/import` (octet-stream, 201 new profile).
- Every import is ONE store mutation (`importItems`: revision checked, all-or-nothing). Conflicts:
  `fail` (409 `ITEM_EXISTS`) / `replace` / `keep-both` (`name-2`; plugins are skipped) / `skip`;
  every rename, replacement or skip is a `notes` line.
- Import from Global never writes Global (exports are temp copies; tests compare Global byte for
  byte). MCP secret values land in `secrets.json` only.
- Exports never carry secret values: `profile.json` keeps env/header KEYS; a profile imported from
  a file has those servers skipped at launch until the values are entered again (and says so).

## How later tasks plug in

- **Per-agent preparers** (one task per agent): implement `SessionProfilePreparer<"agent">` in
  `preparers/<agent>.ts` (`prepare(ctx) → agentSection`, optional `validate(ctx)`, `perAccount`)
  and extend `manifest/<agent>.ts` with the section it writes. Input is `ctx.resolved`
  (`ResolvedAgentProfile`: instructions, enabled in-scope items with source paths, settings,
  real secrets; Codex converts commands to skills itself). Build only inside `ctx.stagingDir`.
  The agent host's adapter reads `readPreparedManifest(preparedDir, {profileId, revision, agent})`
  and fails the launch on `PreparedManifestError`.
- **Preparers** also declare `version` (bump when the output changes for the same inputs) and
  `inputs(ctx)` (absolute paths of the Global files they read, §6.0); both feed staleness. Follow
  the PATH CONTRACT in `preparer.ts`: write in `ctx.stagingDir`, name the dir's own location as
  `ctx.preparedDir` (the new VERSION dir it is renamed to; e.g. Codex hook trust), and only read
  `ctx.previousPreparedDir` (the current version, maybe in use by a running chat).

- **Preparers that run the CLI** get it as `ctx.cliBin` (the lifecycle's `cliBin(agent)` option,
  the registry's resolved binary; `null` = not installed). A preparer whose published dir can stop
  being launchable declares `unusableReason(preparedDir)`: every job that would answer the current
  version (so every `ensureReady`) asks it first, and a reason prepares a new version instead.

## Codex (`preparers/codex.ts`, `contributions/codex.ts`, spec §6.2)

One prepared `CODEX_HOME` per (profile, account) — `perAccount`, System = the system home.
`auth.json` and `sessions/` are symlinks to the account home's (never copies); `config.toml` is
Global's runtime settings (`codexRuntimeConfig`) plus `[features] apps/remote_plugin = false`
(`plugins = false` without a Codex plugin), `[skills.bundled] enabled = false` when built-ins are
hidden, the profile's MCP servers and plugins, and `[hooks.state]` trust keyed by
`<ctx.preparedDir>/hooks.json`; `AGENTS.md`, `skills/` (commands become skills, `git/pr` →
`git-pr`), `hooks.json` (profile hooks, then Orquester's managed ones), `plugins/cache/…`.
**Seeding** runs inside `prepare`, in the staging dir: the state DB holds no path of its home, so
it survives the rename to the version dir, and nothing can start on the home before its first
`initialize` (it is not published yet). `auth.json` is linked after the seed. `inputs()` = the
Global `config.toml`; `unusableReason` = the state DB file is missing (re-seed = a new version).
The contribution sets `CODEX_HOME` and `homePath` to the prepared dir and refuses an unseeded
one. The adapter (`agent-host/adapters/codex/profile.ts`) forces that home, fails a start whose
`initialize` reports another, and switches off `$HOME/.agents/skills` (and any user skill outside
the home) per thread with nested `skills.config` at every `thread/start` and `thread/resume`.

## Preparation lifecycle (`lifecycle.ts`)

Wired in `index.ts` as `services.sessionProfileLifecycle`. Prepared dirs are per key
`(profileId, agent, accountKey)`: `sessionProfileAccountKey(accountId)` for a `perAccount`
preparer (System = `system`, its account home is the agent's system home), else `shared`.

**Versions.** For Codex and Grok a prepared dir IS a running chat's config home (state DBs, logs,
config the CLI rewrites) and OpenCode servers read theirs, so a published dir is never modified,
moved or replaced. Each preparation builds in `staging/`, writes `manifest.json` last, is renamed
to a NEW version dir `v-<fingerprint head>-<time>-<random>` (a name is never reused) and then the
key's `current.json` is replaced via temp + rename — a reader sees the old or the new version,
never none. New launches get the current version; running chats keep theirs until their agent
restarts (spec §5.6). Status, staleness and fingerprints read the current version only.

**Leases and GC.** A non-current version is removed only when no live session uses it:
- `SessionProfileLifecycleOptions.leases?: PreparedDirLeases` —
  `inUse(): Promise<ReadonlySet<string>>`, the absolute versioned `preparedDir`s of every live
  provider session. **Launch plumbing must implement it**: the agent host reports the
  `HostThreadProfile.preparedDir` of each live provider session (from the moment it accepts the
  create/resume), and the daemon passes that set as `inUse` in `index.ts`. Until then (option
  absent) GC removes no non-current version; if `inUse()` rejects, that pass removes nothing.
- A dir answered by `ensureReady` is also kept for `SESSION_PROFILE_HANDOUT_GRACE_MS` (10 min):
  the gap between a launch getting it and the host registering the session.
- Triggers: after each publish (that key), profile delete (its pointers go at once; unleased
  versions go now, leased ones at a later pass; empty dirs up to `prepared/` are removed),
  `start()` (after boot, in the background) and `gc()` on demand. A key's pass runs in the key's
  job chain, so never during its preparation; the leases are read before any key is locked.
- Legacy layout (the key dir itself held the files, `manifest.json` at its top): not a current
  version, so the key re-prepares; its content is collected like a version, leased by the key
  dir's own path.

- `ensureReady(profileId, agent, accountId | null) → Promise<{profileId, agent, accountKey,
  revision, preparedDir}>` — what a launch calls (→ `HostThreadProfile {profileId, revision,
  preparedDir}`). Waits for a preparation in flight; prepares now when missing or stale. Throws
  `SessionProfileError`: `PROFILE_UNSUPPORTED_AGENT` (no preparer), `PROFILE_NOT_FOUND` (deleted
  profile → the launch falls back to Global with a notice, spec §5.6), `PROFILE_NOT_READY`
  (preparation failed — the message is the reason —, account gone, daemon stopping). Never fall
  back to Global on the other codes.
- `status(profileId)` / `prepareStatusSource` (the service's `prepareStatus` option) and the
  `sessionProfile.prepareStatus` event (`publishSessionProfilePrepareEvents`): per agent, no
  preparer → `not-prepared` + reason; else across its keys failed > preparing > ready (a key
  ready for the current revision) > not-prepared.
- `markStale(profileId, agent, accountId)` — forces a re-preparation (Codex: state DB missing).
- `globalConfigChanged(agent)` — fed by Agent config's watcher (`agentProfile.lifecycle`
  `filesChanged`); keys whose `inputs` content moved re-prepare.
- `attach(service.events)` (`changed` → re-prepare known keys and seed the default ones;
  `deleted` → once its jobs settle, drop its pointers and collect its versions), `start()` (boot:
  empty `staging/`, drop pointers of deleted profiles, re-check the rest in the background, then
  GC), `gc()`, `stop()`, `idle()` (drain for tests).
- Staleness fingerprint (in `manifest.json` `fingerprint`): revision + preparer `version` + CLI
  version (registry) + content hashes of `inputs`. Per-key serialization, at most 2 preparations
  at once. Failure reasons have the profile's MCP secret values redacted.
- **Launch plumbing**: `profileId` exists on `CreateSessionRequest`, `CreateAgentChatSessionFields`,
  `SessionChatRecord` (`sessionChatRecordSchema`), `ThreadHead`/`agentThreadHeadSchema`, and the
  host's `CreateHostThreadRequest`/`SetThreadIdentityRequest` together with
  `profile?: HostThreadProfile {profileId, revision, preparedDir}` (`preparedDir` is a version dir:
  pass `ensureReady`'s answer as-is and report it back through the leases above). The agent host persists
  `profile` in the thread's `launch.json`, records `profileId` in the log, hands it to every
  session start as `StartSessionInput.profile` and switches it through `SetThreadIdentityRequest`
  (absent = unchanged, `null` = Global); adapters read their section with
  `agent-host/adapters/profile-manifest.ts`'s `loadProfileManifest(input, agent)` (see the
  agent-host README). The daemon must check `AgentChatService.hostSupportsSessionProfiles()`
  before sending a profile — an older host would run it as Global.
- **UI**: everything through `sessionProfileRoutes` / `HttpOrquesterApiClient` methods
  (`listSessionProfiles`, `createSessionProfileItem`, …) and `/events` on `SESSION_PROFILES_CHANNEL`.
