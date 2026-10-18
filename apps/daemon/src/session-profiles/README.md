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
| `launch.ts` | The launch side: per-agent launch contributions (`profileLaunchContributors`), `applyProfileContribution`, `createProfileLaunchResolver` (what `AgentChatService` launches with), `PreparedDirLeases`, `SessionProfileNames` + the deleted-profile notice. |
| `service.ts` | `SessionProfileService`: wire mapping (secrets masked), events, prepare status, `resolveForAgent(profileId, agent)`. |
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
- Plugins: the store keeps the record and an empty `plugins/<itemId>/` slot
  (`store.pluginCacheDir`). The HTTP create route refuses `kind: "plugin"`; the marketplace flow
  fills the slot and creates the record through the store.

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
  `profile?: HostThreadProfile {profileId, revision, preparedDir}`. The agent host persists
  `profile` in the thread's `launch.json`, records `profileId` in the log, hands it to every
  session start as `StartSessionInput.profile` and switches it through `SetThreadIdentityRequest`
  (absent = unchanged, `null` = Global); adapters read their section with
  `agent-host/adapters/profile-manifest.ts`'s `loadProfileManifest(input, agent)` (see the
  agent-host README). The daemon must check `AgentChatService.hostSupportsSessionProfiles()`
  before sending a profile — an older host would run it as Global.

## Launching a chat with a profile (`launch.ts`, `agent-chat/service.ts`)

**Per-agent launch contributions.** `profileLaunchContributors: { [agent]: (ctx) =>
ProfileLaunchContribution }`, read through `profileLaunchContribution(agent)`. Every agent
contributes nothing today; each per-agent task replaces ITS entry (and nothing else):

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

**Leases.** `PreparedDirLeases { inUse(): Promise<ReadonlySet<string>> }` — implemented by
`AgentChatService.profileLeases()` over the host's `GET /profiles/leases` (the `preparedDir` of
every live provider session and every start in flight); it REJECTS when the host cannot say (down,
an older host's 404), and the GC must then delete nothing. Wiring point: the lifecycle's
construction in `index.ts` (`leases: { inUse: () => agentChat.profileLeases() }`, once the
lifecycle takes it).

- **Imports** (Global / git / zip / md / copy-from-profile / marketplace plugins): add routes under
  the paths reserved in `sessionProfileRoutes`' doc comment, and write through new store methods
  that take the profile queue and revision like `createItem` does.
- **UI**: everything through `sessionProfileRoutes` / `HttpOrquesterApiClient` methods
  (`listSessionProfiles`, `createSessionProfileItem`, …) and `/events` on `SESSION_PROFILES_CHANNEL`.
