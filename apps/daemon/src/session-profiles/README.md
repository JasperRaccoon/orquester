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
| `preparer.ts` + `preparers/<agent>.ts` | Per-agent preparer contract and registry (`null` for an agent not done yet). Grok's (`preparers/grok.ts`) builds a whole `GROK_HOME`; its header lists the layout. |
| `contributions/<agent>.ts` | Per-agent launch contribution (what a profile chat adds to its account's launch env). Grok: `GROK_HOME`/`homePath` = the prepared dir, `GROK_AUTH_PATH` = the account's `auth.json`, `GROK_PROFILE_ENV`. |
| `lifecycle.ts` | `SessionProfileLifecycle`: builds and publishes immutable prepared versions, tracks and refreshes them, collects unleased old ones; `ensureReady` for launches. |
| `launch.ts` | The launch side: per-agent launch contributions (`profileLaunchContributors`), `applyProfileContribution`, `createProfileLaunchResolver` (what `AgentChatService` launches with), `SessionProfileNames` + the deleted-profile notice. |
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
| Grok | the plugin directory (`.grok-plugin/`, `.claude-plugin/` or `plugin.json` manifest, as found) | `name`, `marketplace?`, `version?` | copy to `profile/plugins/<itemId>/<name>/` of the prepared home and pass `--plugin-dir` (always trusted, enabled for the process); its name stays out of the `[plugins] disabled` deny list |
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

## OpenCode (`preparers/opencode.ts`, spec §6.4)

Shared by every account (`perAccount: false`); `inputs` = the Global `config.json`,
`opencode.json`, `opencode.jsonc`. A version dir holds `opencode/` (the server's
`OPENCODE_CONFIG_DIR`: `opencode.json` 0600 = the Global files merged as OpenCode merges them minus
the item keys, relative `{file:}` refs made absolute, plus the profile's `mcp`, `skills.paths`
`[".claude/skills", ".agents/skills"]` and, when built-ins are hidden, a last `permission.skill`
rule denying `customize-opencode`; `AGENTS.md`; `skills/`; `commands/` — a command OpenCode could
not decode is left out with a warning, it would fail the whole config —; `plugin/` with each
plugin's top-level `*.js`/`*.ts`/`*.mjs` and Orquester's `orquester-status.js`) and `xdg/` (the
server's `XDG_CONFIG_HOME`: `buildXdgConfigShadow` of the real `~/.config` minus `opencode`).
- **Writable config dirs.** OpenCode writes `.gitignore`, `package.json`, `bun.lock` and
  `node_modules/` into `opencode/` and into the shadow's own `xdg/opencode/` (which it creates).
  Both stay inside the version: the PATH CONTRACT lets the running CLI write there, nothing hashes
  a version's content, and the GC removes them with it.
- **Shadow timing.** Built at preparation (a version launches on its own, e.g. from a persisted
  `launch.json` when the daemon cannot be asked) and refreshed by the launch contribution at every
  launch (the real `~/.config` changes without a profile edit). The refresh only manages the
  shadow's symlinks — the one launch-time write into a published version.
- **Launch.** `serverPool {key: "profile:<profileId>:<version dir>", env: {XDG_CONFIG_HOME,
  OPENCODE_CONFIG_DIR, OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1"},
  unsetEnv: ["OPENCODE_CONFIG"]}`; the thread's `launchEnv`/`homePath` stay the account's (OpenCode's
  shared servers read the project's launcher env). `XDG_DATA_HOME` and `OPENCODE_CONFIG_CONTENT`
  are untouched (OpenCode merges the latter last). A new version is a new key: the thread moves at
  its next start and the old server closes once idle.
- **Status plugin.** The profile server's only copy is `opencode/plugin/orquester-status.js`
  (a profile plugin file of that name is skipped): the shadow never links `opencode`, so the real
  `~/.config/opencode/plugin/` is never read nor written through.
- **Known limits (1.18.34).** `OPENCODE_DISABLE_CLAUDE_CODE` also drops a repo's `CLAUDE.md`
  fallback (no `AGENTS.md` → no project instructions); `$HOME/.opencode` is still a config dir
  OpenCode reads (HOME is the host's). OpenCode reads no project `.mcp.json`, in Global or here.
- Live check (opt-in, real CLI, no login): `ORQUESTER_OPENCODE_LIVE=1` runs
  `preparers/opencode-isolation.live.test.ts` (`opencode debug skill|config|agent build`).

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
  provider session. Wired in `index.ts` as `AgentChatService.profileLeases()`: the agent host's
  `GET /profiles/leases` (the `HostThreadProfile.preparedDir` of every live provider session and
  every session start in flight). Option absent: GC removes no non-current version; if `inUse()`
  rejects (no healthy host, an older host's route miss), that pass removes nothing.
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

## Launching a chat with a profile (`launch.ts`, `agent-chat/service.ts`)

**Per-agent launch contributions.** `profileLaunchContributors: { [agent]: (ctx) =>
ProfileLaunchContribution }`, read through `profileLaunchContribution(agent)`. Grok's is
`contributions/grok.ts`; the others contribute nothing yet. Each per-agent task replaces ITS entry
(and nothing else):

```ts
ctx: { agent, profile: {profileId, revision, preparedDir}, manifestSection /* manifest/<agent>.ts */,
       accountId /* null = System */, accountHome /* the launch env's home var, else the System home */,
       projectPath, launchEnv /* the account's, read-only */ }
→ { env?, unsetEnv?, homePath?, serverPool? }        // may be async; a throw = PROFILE_NOT_READY
```

`applyProfileContribution(base, contribution, homeVar)` is the one composition rule: `env` over the
account's launch env (it wins), `unsetEnv` merged (and removed from the env; a contributed variable
is never unset by the account's list), `homePath` = the contribution's, else whatever the agent's
home variable (`ACCOUNT_HOME_ENV_VAR`) names after `env` — so Codex pointing `CODEX_HOME` at the
prepared home moves the resume identity's home with it —, `serverPool` = the contribution's, else
the account's. Expected: Codex `CODEX_HOME`; Grok `GROK_HOME`, `GROK_AUTH_PATH`, compat env;
OpenCode a `serverPool {key, env}` (key derived from the prepared version, never `"global"`).

**The seam.** `createProfileLaunchResolver({lifecycle, contributors?, accountHome?})` =
`ensureReady(profileId, agent, accountId)` → `readPreparedManifest` → contributor →
`applyProfileContribution`; it throws `SessionProfileError` only. `index.ts` hands it to
`AgentChatService.setSessionProfiles({resolve, profileName})`. Every chat launch path goes through
it: create (`profileId` top-level or `chat.profileId`), fork (the parent's profile unless
`ForkSessionRequest.profileId` names one, `null` = Global), the fork reconcile (`confirmOnly`
re-sends the child's), the account switch (the profile prepared for the NEW account), and the
profile switch. Each refuses (`COMMAND_REJECTED`) while `hostSupportsSessionProfiles()` is false,
sends `profile` (+ the contributed launch fields) to the host and mirrors `profileId` on the tab
record (`sessionChatRecordSchema.profileId`; `SessionSummary.profileId`, `null` = Global).

**Profile switch.** `POST /api/sessions/:id/profile` (`agentChatRoutes.profile`, both transports,
the account route's auth, refusals and receipts): `ProfileCommandBody {commandId, profileId |
null}` → the host's identity switch with `profile` (`null` = Global); a profile-only switch keeps
the resume cursor. Idempotent by `commandId` (a repeat shares the first's answer; the same id with
another profile is `COMMAND_ID_CONFLICT`; a refusal is forgotten so it may be retried).

**Refresh at every session start.** Before ANY provider session of a profile thread starts (the
first, a resume, a crash restart, a host restart's rehydrate, a switch), the agent host calls the
daemon's socket-only `POST /api/agent-host/threads/launch-profile` (`daemonRoutesForHost
.threadLaunchProfile`, host bearer) with `{threadId, profileId}` and rewrites `launch.json` from
the answer (`ThreadLaunchProfileResponse`: the current `profile` and launch fields) before it
starts — so an edited profile applies at the next start and a GC'd version never fails one. A
refusal (409 `PROFILE_NOT_READY` / `PROFILE_UNSUPPORTED_AGENT` / `PROFILE_NOT_FOUND` for an
unattended chat / `LAUNCH_UNAVAILABLE`) fails the start with its message. Daemon unreachable, 5xx,
or an older daemon's route miss: the host launches the persisted `launch.json` profile only if its
manifest still validates (`loadProfileManifest`), else the start fails — never Global. (It is a
separate route, not the session-tools manifest fetch: that one runs inside the adapter's start,
after the env and home are already built.)

**Deleted profile (§5.6).** At a refresh, `PROFILE_NOT_FOUND` for an INTERACTIVE chat answers the
account's own launch with `profile: null` and `fallback {previousProfileId, notice}`; the host
writes `thread.meta-updated {profileId: ""}` and a `runtime.warning` row whose summary is the
notice (`Agent Profile "X" was deleted; this chat now uses Global.` — the name from
`SessionProfileNames`, kept after the delete while the daemon runs), and the tab mirrors Global.
An account switch or a fork of such a chat goes ahead without naming the profile and leaves the
fallback to the next start's refresh. **Unattended** launches never fall back:
`CreateAgentChatSessionFields.unattended` / `ForkSessionRequest.unattended` (persisted as
`sessionChatRecordSchema.unattended`; a fork of an unattended chat is unattended) make every later
refresh refuse `PROFILE_NOT_FOUND`. A create naming a missing or failed profile fails either way.
`PROFILE_NOT_READY` / `PROFILE_UNSUPPORTED_AGENT` always fail with the reason.

**Leases.** `PreparedDirLeases` (above) is `AgentChatService.profileLeases()`, passed as the
lifecycle's `leases` in `index.ts`. The refresh at every session start always launches the
CURRENT version, so an old one is leased only while a session that started on it lives.
- **UI**: everything through `sessionProfileRoutes` / `HttpOrquesterApiClient` methods
  (`listSessionProfiles`, `createSessionProfileItem`, …) and `/events` on `SESSION_PROFILES_CHANNEL`.
