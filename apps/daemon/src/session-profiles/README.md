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
| `preparer.ts` + `preparers/<agent>.ts` | Per-agent preparer contract and registry (all `null` for now). |
| `lifecycle.ts` | `SessionProfileLifecycle`: builds, swaps, tracks and refreshes prepared dirs; `ensureReady` for launches. |
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
  prepared/<profileId>/<agent>/<accountKey>/      sessionProfilePreparedDir(...)
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
  `ctx.preparedDir` (the dir is renamed there; e.g. Codex hook trust).

## Preparation lifecycle (`lifecycle.ts`)

Wired in `index.ts` as `services.sessionProfileLifecycle`. One prepared dir per key
`(profileId, agent, accountKey)`: `sessionProfileAccountKey(accountId)` for a `perAccount`
preparer (System = `system`, its account home is the agent's system home), else `shared`.

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
  `deleted` → remove `prepared/<profileId>/` once its jobs settle), `start()` (boot: empty
  `staging/`, drop dirs of deleted profiles, re-check the rest in the background), `stop()`,
  `idle()` (drain for tests).
- Staleness fingerprint (in `manifest.json` `fingerprint`): revision + preparer `version` + CLI
  version (registry) + content hashes of `inputs`. Per-key serialization, at most 2 preparations
  at once. Failure reasons have the profile's MCP secret values redacted.
- **Launch plumbing**: `profileId` exists on `CreateSessionRequest`, `CreateAgentChatSessionFields`,
  `SessionChatRecord` (`sessionChatRecordSchema`), `ThreadHead`/`agentThreadHeadSchema`, and the
  host's `CreateHostThreadRequest`/`SetThreadIdentityRequest` together with
  `profile?: HostThreadProfile {profileId, revision, preparedDir}`. Not yet read or persisted by
  anyone (see the follow-ups in the T1 report).
- **UI**: everything through `sessionProfileRoutes` / `HttpOrquesterApiClient` methods
  (`listSessionProfiles`, `createSessionProfileItem`, …) and `/events` on `SESSION_PROFILES_CHANNEL`.
