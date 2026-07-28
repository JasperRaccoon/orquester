# Claude agent stream timeout — daemon-wide setting

**Date:** 2026-07-29
**Status:** approved, ready for implementation plan

## Problem

Claude Code aborts a streaming request when no bytes arrive for 180 s, then renders
`[Request interrupted by user]` in the transcript. Long subagent generations routed
through the managed CLIProxyAPI hit this routinely: a workflow run on vps-a lost 37 of
52 subagents, and the idle gap between each agent's last transcript event and its
interrupt clustered hard on the constant — seven agents at exactly 180 s, the rest
between 198 s and 214 s (transcript entries are written at message boundaries, so the
recorded gap runs a few seconds longer than the true byte gap).

The value is `$Dh = 180000` in the Claude Code bundle. It is overridable per process by
`CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, alongside `CLAUDE_STREAM_IDLE_TIMEOUT_MS`
(300 s default) and `API_TIMEOUT_MS` (600 s streaming / 300 s non-streaming). All three
are clamped by the harness to a 1800000 ms ceiling (`ODh`).

CLIProxyAPI is **not** the cause and needs no change. Verified three ways: no timeout key
in `config.yaml`, none in the live effective config from `GET /v0/management/config`, and
none in the v7.2.95 source — `internal/api/server.go:409` constructs `http.Server{}` with
only `Addr` and `Handler` (Go zero values = unlimited), and every provider executor builds
its upstream client with timeout `0`. The proxy holds the stream open indefinitely and
merely observes the client hang up, which it logs as `200` with the elapsed time.

## Goal

One setting, daemon-side, that raises these timeouts for every Claude harness launched
through orquester — on every VPS that exists today and every VPS provisioned later,
with no per-host file editing.

## Non-goals

- Changing anything in CLIProxyAPI.
- Governing a `claude` process a user starts by hand over SSH. Only sessions launched
  through orquester are covered.
- Per-launcher or per-session overrides. One daemon-wide value.
- Raising `MCP_TIMEOUT` or the Bash tool timeouts. Those govern tool calls, not the API
  stream; a 30-minute value there turns a wedged MCP server into a 30-minute stall.

## Design

### 1. Data model — `packages/config/src/index.ts`

A new group on `appConfigSchema`, parallel to the existing `usage` group:

```ts
export const agentPrefsSchema = z.object({
  /** Claude harness stream/API timeout, minutes. Injected at session launch for
   *  every claude-family launcher. 30 is Claude Code's own hard clamp
   *  (ODh = 1800000) — higher values are silently floored by the harness. */
  claudeTimeoutMinutes: z.number().int().min(1).max(30).default(30)
});
```

On `appConfigSchema`: `agents: agentPrefsSchema.default({})`.

The `.default({})` is the mechanism for "every future VPS": a daemon booting against an
`app.json` with no `agents` key parses to 30 minutes. No migration, no provisioning step.

The ceiling is 30 rather than something larger because the harness clamps the two idle
timeouts at 1800000 regardless. Offering 60 would display a number that silently does
nothing.

### 2. Daemon — `apps/daemon/src/agent-timeout-env.ts` (new)

```ts
export function claudeTimeoutEnv(entryId: string, minutes: number): LaunchEnv | null
```

Returns `null` unless `agentFamily(entryId) === "claude"`. Otherwise emits
`API_TIMEOUT_MS`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, and
`CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, each `String(minutes * 60_000)`.

`agentFamily` (`apps/daemon/src/agent-hooks.ts:16`) already maps exactly `claude`,
`claudex`, and `claudemix` to `"claude"`, and its own comment establishes that config
targeting keys on family and never on raw id. Reusing it is what makes plain `claude`
covered alongside the two proxy launchers.

One exported function, no I/O, no dependency beyond `agentFamily` — unit-testable in
isolation and incapable of breaking a launch.

`LaunchEnv` is declared unexported in `index.ts:763`, and `index.ts` will import this
module — so this module must **not** import the type back from `index.ts`. Declare the
return shape locally (`{ env: Record<string, string> }`); it is structurally compatible
with what `composeExtraEnv` accepts, so no export and no import cycle is needed.

### 3. Daemon — wiring at `apps/daemon/src/index.ts:341`

Composed into the existing `resolveExtraEnv` seam as a third contributor:

```ts
composeExtraEnv(
  composeExtraEnv(await agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId),
                  claudeTimeoutEnv(entry.id, minutes)),
  cliproxyContributor(entry.id, ctx, resolved.daemonDir)
)
```

`cliproxyContributor` stays in the last position so it keeps winning key collisions per
its documented contract. The three timeout keys collide with nothing.

The value is read per launch via `readAppConfigFile(resolved.appConfigFile)`, wrapped so a
missing or corrupt `app.json` falls back to 30 rather than throwing — launch-env
resolution must never throw, matching the existing `readCliProxyState` contract. Reading
fresh per launch means a settings change applies to the next session with no daemon
restart.

### 4. API — no change

`GET/PUT /api/config/app` (`apps/daemon/src/index.ts:1853-1864`) already carries the whole
object: the PUT merges `{...current, ...body}` and re-parses through `parseAppConfig`, so
the new group rides along. Unlike `/api/config/daemon` it carries no transport guard, so it
is writable over remote HTTP today.

No new endpoint, no new remote-writable carve-out, no change to the security boundary
described in AGENTS.md.

### 5. UI — `AgentsSettings` in `packages/ui/src/components/settings/SettingsModal.tsx`

A settings block above the harness list: number input bounded 1–30, labelled
"Claude stream timeout", with help text stating that it applies to every Claude harness
launched here and that 30 minutes is the maximum the harness honors. Wired through the
existing `updateAppConfig` store action (`packages/ui/src/store/app.ts:1178`).

Also required: extend the load-time normalization at `store/app.ts:1148-1152` with a
`normalizeAgentPrefs` helper mirroring `normalizeUsagePrefs`. AGENTS.md makes this
mandatory for any new persisted client-side shape — raw `JSON.parse` output must never
reach typed code, because an `app.json` written by an older bundle outlives a deploy.

### 6. Cleanup

Four `settings.json` files were hand-edited during diagnosis and must be reverted from
their adjacent `.bak-timeouts` backups, so the daemon setting is the only writer:

- vps-a: `/var/lib/orquester/.claude/settings.json`,
  `…/cliproxy/claude-home-claudex/settings.json`,
  `…/cliproxy/claude-home-claudemix/settings.json`
- vps-b: `/var/lib/orquester/.claude/settings.json`

This is not cosmetic. Claude Code applies `settings.json` `env` on top of the inherited
process env, so those files would override the new setting. Both currently read
`1800000`, so nothing looks wrong — until the setting is lowered, at which point the
files silently pin it back to 30.

## Testing

`apps/daemon/src/agent-timeout-env.test.ts` (the daemon package has a real runner:
`node --import tsx --test`):

- returns `null` for `codex`, `opencode`, and an unknown id
- returns all three keys for each of `claude`, `claudex`, `claudemix`
- converts minutes to milliseconds correctly at the 1 and 30 bounds

Then `pnpm check`, `pnpm build` (the UI changed), `./deploy.sh deploy all`, and the
mandatory browser smoke test per AGENTS.md.

End-to-end verification is behavioural, not a green check: launch an agent and confirm the
three variables are present in its process environment, then run a workload with long
generations and confirm no agent transcript shows an interrupt at a ~180 s idle gap. The
measurement that diagnosed this — idle gap between last transcript event and interrupt,
across all agent JSONL files in a workflow run — is the same one that confirms the fix.

## Consequences

- A `claude` started by hand over SSH still gets the stock 180 s. Accepted.
- The setting can only ever lower the timeout from its default, since the default equals
  the harness ceiling. It exists to make the value visible and adjustable, not to raise it
  further.
- The "size every subagent task under ~3 minutes" rule recorded in workflow `PROGRESS.md`
  can be dropped once the fix is verified.
