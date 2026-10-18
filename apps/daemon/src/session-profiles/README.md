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
- **Preparation lifecycle**: follows the flow in `preparer.ts`'s header (readSource → resolve →
  stage → prepare → validate → `writePreparedManifest` last → atomic swap). Supply
  `SessionProfileServiceOptions.prepareStatus` and publish `sessionProfile.prepareStatus` on
  `SESSION_PROFILES_CHANNEL`. Subscribe to `service.events` (`changed`/`deleted`) to re-prepare
  and to remove `prepared/<profileId>/` of a deleted profile. Keyed by
  `sessionProfileAccountKey(accountId)` or `SESSION_PROFILE_SHARED_ACCOUNT_KEY`.
- **Launch plumbing**: `profileId` exists on `CreateSessionRequest`, `CreateAgentChatSessionFields`,
  `SessionChatRecord` (`sessionChatRecordSchema`), `ThreadHead`/`agentThreadHeadSchema`, and the
  host's `CreateHostThreadRequest`/`SetThreadIdentityRequest` together with
  `profile?: HostThreadProfile {profileId, revision, preparedDir}`. Not yet read or persisted by
  anyone (see the follow-ups in the T1 report).
- **Imports** (Global / git / zip / md / copy-from-profile / marketplace plugins): add routes under
  the paths reserved in `sessionProfileRoutes`' doc comment, and write through new store methods
  that take the profile queue and revision like `createItem` does.
- **UI**: everything through `sessionProfileRoutes` / `HttpOrquesterApiClient` methods
  (`listSessionProfiles`, `createSessionProfileItem`, …) and `/events` on `SESSION_PROFILES_CHANNEL`.
