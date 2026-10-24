# 02 — Provider adapters and agent runtime: T3 Code vs Orquester

Analyst domain: which agents each product drives, per-provider capabilities (models, effort,
permission modes, plan mode, subagents, MCP, skills, usage limits), Claude idle compaction,
auth/login, resume, usage-limit recovery, and how hard it is to add a provider.

- T3 Code: `t3code_codebase` at `ed9b7ca9` (new range `e8d87689..HEAD`, 652 commits, dated
  2026-10-19 to 2026-10-21). "(new)" marks items introduced in that range.
- Orquester: repo root at `dcab9eed`.
- Method: every claim was checked in source. T3 paths are relative to `t3code_codebase/`.
  Orquester paths are relative to the repo root.

## 0. Baseline: who supports what

| Agent | T3 Code | Orquester (GUI chat) |
|---|---|---|
| Claude Code | `claudeAgent`, Agent SDK (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, 10.5k lines) | `claude`, Agent SDK (`apps/daemon/src/agent-host/adapters/claude/`, about 28.6k lines incl. tests) |
| Codex | `codex`, app-server JSON-RPC (`CodexAdapterV2.ts`, 7.5k lines; `packages/effect-codex-app-server`) | `codex`, app-server (`adapters/codex/`, about 19.4k lines) |
| OpenCode | 1.x **and 2.x** runtimes (`packages/provider-opencode/src/server/adapter.ts`, `v2/adapter.ts`; picked by `versionProbe.ts:33`) | 1.x only, floor `1.14.19` (`adapters/opencode/semver.ts:62`) |
| Grok Build | ACP over `grok agent stdio` (`packages/provider-grok`) | ACP (`adapters/grok/`, with its own ACP peer in `adapters/grok/acp/`) |
| Cursor | `@cursor/sdk` local agent (`packages/provider-cursor/src/server/adapter.ts`, 2.7k lines) | **none.** Cursor appears only as an IDE in `packages/registry/src/index.ts`, `id: "cursor", kind: "ide"` |
| Antigravity | dedicated driver on the generic ACP adapter (`AntigravityAdapterV2.ts`, `AntigravityAuth.ts`, `AntigravityInstallation.ts`) | **none.** IDE entry only (`packages/registry/src/index.ts`, `id: "antigravity", kind: "ide"`) |
| Pi | `pi --mode rpc` (`packages/provider-pi`, 6k lines) | none |
| Muse Code (beta) | `@muse-code/sdk` (`packages/provider-muse`, 4.1k lines) | none |
| Any ACP agent (Gemini/Antigravity ACP, Copilot, Devin, Droid, claude-agent-acp, Mistral vibe, Qwen, ...) | ACP Registry driver plus "Local ACP command" (`packages/provider-acp-registry`, `packages/provider-acp`, `packages/effect-acp`) | none. DeepSeek is a detect-only terminal entry (`packages/registry/src/index.ts`, `id: "deepseek"`, no `chat` adapter) |

The Orquester adapter registry is the static four-entry map in
`apps/daemon/src/agent-host/adapters/index.ts` (`ADAPTER_FACTORIES`). The id union is
`AgentAdapterId = "claude" | "codex" | "opencode" | "grok"` in
`packages/api/src/agent-chat/adapter-types.ts:19`. T3's list is `BUILT_IN_DRIVERS` in
`apps/server/src/provider/builtInDrivers.ts:30-40`. Every T3 driver was already present at
`e8d87689`, so none of the providers is new; only fixes and features inside them are.

Orquester's adapter interface and much of its capability vocabulary was ported from T3. See the
header of `apps/daemon/src/agent-host/adapter.ts` ("Ported from T3 Code (MIT)"), the `*T3:*`
notes in `packages/api/src/agent-chat/adapter-types.ts`, and the headers of
`adapters/claude/skills.ts`, `adapters/claude/usage.ts` and `adapters/grok/acp/connection.ts`.
For the four shared agents the two products are close to parity. The gaps are mostly about breadth
and a few newer runtime refinements.

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (evidence) | User value | Port effort |
|---|---|---|---|---|
| **Generic ACP agents from the ACP Registry**: search, install (pinned version, SHA-256 when published) and run any ACP agent, plus a **Local ACP command** (e.g. DeepSeek Harness `dsh --profile acp`) | `packages/provider-acp-registry/src/server/{driver.ts,AcpRegistrySupport.ts,adapter.ts}`. Registry URL `AcpRegistrySupport.ts:50`; install dir `tools/<id>/<version>` `:533`; checksum `:1451-1490`; local source `driver.ts:201`. Generic adapter `packages/provider-acp/src/server/adapter.ts` (8.5k lines); v2-then-v1 negotiation `packages/effect-acp/src/client.ts:667,755,1048-1063`. Docs `docs/user/providers-acp.md` | **Missing.** The ACP peer exists but is Grok-only (`apps/daemon/src/agent-host/adapters/grok/acp/{connection,peer}.ts`, about 1.7k lines, plus generated schema in `acp/_generated`). The Grok normaliser (`grok/normalize.ts`) assumes xAI extensions. DeepSeek is detect-only with no chat (`packages/registry/src/index.ts`) | H | L (M for a "local ACP command" only adapter that reuses `grok/acp/peer.ts`) |
| **Cursor agent** in the GUI (SDK local agent, browser sign-in that mints an API key, Auto-review mapping, usage and limits from Cursor's API) | `packages/provider-cursor/src/server/{adapter.ts,auth.ts:188,usageLimits.ts:22,accountUsage.ts:89,CursorAgentSdk.ts:114-120}`; `docs/user/cursor.md`. Windows sandbox fallback doc change in range (new) | **Missing** as an agent (IDE launcher only) | M | L (2.7k-line adapter, new SDK dependency) |
| **Pi agent** (RPC mode, native fork/rollback via Pi session files, extension dialogs) | `packages/provider-pi/src/server/adapter.ts:95-189,2222,2920,2988`; `status.ts:54` | Missing | L–M | M–L |
| **Antigravity agent** with a managed installer (content-addressed releases and **leases** so updates never replace a running binary), per-instance profile isolation, Google/Vertex/API-key sign-in | `apps/server/src/provider/AntigravityInstallation.ts:89,175,453,527,574`; `antigravityAuthSupport.ts:183-193`; `AntigravityAuth.ts:257,403-417`; `antigravityUsageLimits.ts:19-20` | Missing (IDE launcher only) | M | L |
| **OpenCode 2.x runtime** (one server per instance, per-thread MCP entry, session-scoped permission rules) | `packages/provider-opencode/src/server/versionProbe.ts:33`; `v2/{adapter.ts,OpenCode2Server.ts,OpenCode2Client.ts}`; `docs/internals/providers.md` "Process and account isolation". Fix in range: v2 turns show provider retries (`aac28657`, new) | **Missing.** Orquester gates on a 1.x minimum and pools one `opencode serve` per project (`adapters/opencode/semver.ts:62`, `adapters/opencode/server.ts`). Behaviour on a 2.x install is untested | M (rising as 2.x ships) | L |
| **Idle Claude compaction before the prompt cache expires (beta)**. Settings: `onReturn` / `beforeCacheExpires` / `off`, with a global default and a per-instance override | `apps/server/src/orchestration-v2/IdleCompaction.ts`, `IdleCompactionService.ts` (`5d3875d7`, new); per-instance override `packages/contracts/src/settings.ts:647-675,726,1383` (`d13fc846`, new); TTL capture `ClaudeAdapterV2.ts:206-272`. Mechanism in §1a below | **Missing.** Orquester answers Claude's `resume_return` dialog (`adapters/claude/session.ts:1885-1955`, `adapters/claude/launch.ts:244-245`). It records no cache expiry: `ThreadTokenUsage` has no TTL field (`packages/api/src/agent-chat/runtime-events.ts:496-512`). It has no idle timer and no `off` switch for the resume prompt | M–H for heavy Claude users (saves a full uncached re-read of 200k+ tokens) | S–M |
| **Claude "Auto-compact after" setting** (`autoCompactWindow`, 100k–1M), passed as SDK settings | `packages/contracts/src/settings.ts:645,713`; `ClaudeAdapterV2.ts:1326-1332`; context meter shows it (`15c92789`, new) | **Missing as a setting.** Orquester only *displays* the threshold Claude reports (`packages/ui/src/components/agent-chat/status/context-meter.ts:26,111-131`). No match for `autoCompactWindow` / `AUTO_COMPACT_WINDOW` anywhere in `apps/` or `packages/` | M | S |
| **"Why did Claude ask?" on approvals in Full access**. Shows `decisionReason`, flags `ask_rule` vs `provider_check`, hides "always allow" when `suppressAlwaysAllowRule` is set | `ClaudeAdapterV2.ts` `claudeApprovalPresentation` and `packages/contracts/src/providerPolicy.ts` `ProviderApprovalFullAccessOverride` (`e7492453`, new); `docs/user/permission-modes.md` "Claude can still ask in Full access" (new) | **Missing.** Orquester's `canUseTool` reads only `toolUseID`, `requestId`, `description`, `suggestions` and `mcpServer` (`adapters/claude/session.ts:1675-1744`). `decision_reason` reaches only *denials* (`adapters/claude/normalize.ts:2671`) | M (a Full-access user who gets a prompt is confused without it) | S |
| **Claude plugin skills discovery**: enabled installed plugins contribute `plugin:skill` entries to the skill menu | `apps/server/src/provider/Drivers/ClaudeSkills.ts:221-347` (`installed_plugins.json` + `enabledPlugins`) (`c2b127f8`, new) | **Partial.** `adapters/claude/skills.ts:10-15` scans user and project roots only. Plugin skills can still appear as SDK slash commands, but without path, scope or flags | M | S |
| **Codex 429 retry exhaustion counted as a usage limit** (`responseTooManyFailedAttempts{httpStatusCode:429}`) | `CodexAdapterV2.ts:1118-1133` `codexExhaustionHttpStatus`, used at `:5654` (`58b48274`, new) | **Partial.** `failureReasonOf` maps only `usageLimitExceeded` / `rateLimitExceeded` / `sessionBudgetExceeded`. `responseTooManyFailedAttempts` becomes `transport_error` (`adapters/codex/normalise.ts:2080-2112`), so auto-resume and account failover never fire for it | M | S |
| **Provider updates that only run through the installer that provably owns the binary**, with a re-read version check after the update and a "behind latest" advisory | `apps/server/src/provider/providerMaintenanceRunner.ts` (606 lines), `providerMaintenanceCommandCoordinator.ts`, `packages/provider-core/src/server/maintenanceResolver*`; `docs/internals/providers.md` "Provider updates run only through the owning installer". In range: failed updates say why (`f0878100`), Codex no longer offers updates it can't detect (`c25ba721`), mise/Vite+ ownership (`762813c1`, `d1b4ce93`) (new) | **Partial.** Fixed commands per agent (`packages/registry/src/index.ts`: `npm update -g @openai/codex`, `claude update`, ...). They run blindly and count exit 0 as success (`apps/daemon/src/registry.ts:243-279`). No latest-version check: `versionAdvisory` is only the Claude minimum-version gate (`adapters/claude/probe.ts:388`) | M (a wrong-installer update leaves two copies or silently no-ops) | M |
| **Model manifest with `minVersion`**: models announced before the installed CLI knows them, `updateRequiredModels` in the picker ("update to unlock"), fetched remotely with a bundled fallback | `apps/server/src/provider/ModelManifest.ts`, `model-manifest.json`; `docs/internals/model-manifest.md`; `packages/contracts/src/server.ts:271` | **Different approach.** Orquester reads the live catalog from the CLI (`adapters/claude/models.ts` via `supportedModels()`; Codex `model/list`). It has no "newer model needs an update" signal | L–M | M |
| **Custom model IDs per instance** (models the agent hides or doesn't list) | `CustomModelSetting` in `packages/contracts/src/settings.ts:634`; `docs/user/providers-acp.md` "Custom models" | Missing (no `customModel` anywhere in daemon, UI or API) | L (M once generic ACP lands) | S |
| **Configurable provider instances**: several instances per driver, each with env overrides, launch args, binary and home path; per-project enable/disable | `apps/server/src/provider/ProviderInstanceRegistry.ts`; `makeProviderSettingsSchema` (`packages/contracts/src/settings.ts`, e.g. `order: ["binaryPath","homePath","autoCompactWindow","idleCompaction","launchArgs"]` `:741`); `resolveProjectProviderInstanceEnabled` (used by `IdleCompactionService.ts`) | **Partial, via different concepts.** Managed *accounts* per family (`AgentAccount`, `packages/api/src/index.ts:1294-1312`; Claude/Codex/Grok only) and *Agent Profiles* (kits). No user env overrides, launch args or binary override for chat launches. The registry `args` are terminal-only (`apps/daemon/src/agent-host/adapter.ts:44-47`) | M | M |
| **Codex/Claude reset credits** ("Use reset" redeems a banked quota reset) | `apps/server/src/provider/resetCreditCoordinator.ts`, `claudeResetCredits.ts`; `docs/user/usage.md` "Track subscription limits" | **Missing.** Orquester explicitly asks Codex to omit them: `account/rateLimits/read {excludeResetCreditDetails:true}` (`adapters/codex/probe.ts:449`) | M | S–M |
| **Usage limits for OpenCode Go, Cursor, Antigravity** | `packages/provider-opencode/src/server/usageLimits.ts:121`; `packages/provider-cursor/src/server/usageLimits.ts:22`; `antigravityUsageLimits.ts:19` | **Partial.** Claude, Codex and Grok only (`apps/daemon/src/usage-sources.ts:8-11`). No OpenCode account family (`apps/daemon/src/agent-chat/provider-auth-overlay.ts`: "OpenCode has none") | L | M |
| **Per-provider supported permission modes**: unsupported modes are hidden and run as Supervised instead of being imitated | `supportedRuntimeModes` (`packages/provider-grok/src/server/acpSupport.ts:44`, `packages/provider-pi/src/server/status.ts:54`, Muse `status.ts:29`); fallback `apps/server/src/orchestration-v2/RuntimePolicy.ts:62-71`; plus `runtimePolicy.enforcement: native \| client-boundary` (`packages/contracts/src/orchestrationV2.ts:316-320,341-345`) | **Partial.** All four modes are offered for every agent (`packages/ui/src/components/agent-chat/composer/ComposerChips.tsx:318`). Grok's `auto-accept-edits` is answered by the host (`adapters/grok/permissions.ts:182-190`). OpenCode `auto` silently keeps asking (`adapters/opencode/ruleset.ts:32-44`) | L–M | S |
| **One prompt fanned out to several models** (multiple-model send, one thread each) | `apps/web/src/components/chat/useMultipleModelSend.ts` (moved to its own hook in `ac23b74d`; the feature predates the range); `draftFanoutSelectionsAtom` | Missing (no fan-out in the composer) | M | M |

### 1a. How T3's idle Claude compaction works (new, beta)

1. **Capturing the cache expiry.** On every Claude `message_start` / `message_delta` usage, the
   adapter reads `usage.cache_creation`. `claudePromptCacheTtlMs` returns 1h if
   `ephemeral_1h_input_tokens > 0`, else 5m if `ephemeral_5m_input_tokens > 0`, else unknown
   (`ClaudeAdapterV2.ts:206-218`). `claudeProviderTurnTokenUsage` stamps
   `promptCacheTtlMs` and `promptCacheExpiresAt = requestedAt + ttl` on the turn's token usage.
   Expiry is measured from the request, not the response (`:240-272`; contract fields at
   `packages/contracts/src/orchestrationV2.ts:174-176`). A request served fully from cache
   reports no TTL, so the expiry is left unknown and that thread is skipped.
2. **Eligibility** (`IdleCompaction.ts:32-103`, pure). The thread qualifies when all of these hold:
   - it is not deleted, archived, settled, snoozed, or a subagent child;
   - its latest run is `completed`, and that run's user message was not itself `/compact`
     (so one idle spell compacts at most once);
   - it has no pending approval or question, no pending merge-back, and no pending background
     work (that work reports into the next turn);
   - its active provider thread is still the same `claudeAgent` session and instance;
   - its newest token usage is at least `COMPACTION_SUGGESTION_MIN_TOKENS = 200_000`
     (`packages/shared/src/claudeCompaction.ts`), matching Claude Code's own `idleCompaction`
     default.

   The window is `[expiresAt - 2 min, expiresAt)`.
3. **Scheduling** (`IdleCompactionService.ts`). The service subscribes to domain events. On
   `run.updated{status:"completed"}` it starts a per-thread fiber in a `FiberMap`, so a newer
   run replaces the waiting timer. The fiber sleeps until `startMs`, then re-reads settings and
   records. If the window still belongs to the same run and the instance resolves to
   `beforeCacheExpires`, it dispatches a visible `/compact` message. The message has
   `createdBy:"agent"`, `creationSource:"server"`, and the idempotent command id
   `server:idle-compact:<thread>:<run>`.
4. **Settings** (`packages/contracts/src/settings.ts:647-675`). `IDLE_COMPACTION_MODES` are
   `onReturn` (default), `beforeCacheExpires (beta)` and `off`. A legacy boolean
   `compactIdleThreads` decodes to these modes. Per instance: `idleCompaction: default | ...`,
   resolved by `resolveIdleCompaction` (`:1383`). `off` also auto-answers Claude's
   `resume_return` dialog with "continue" (`ClaudeAdapterV2.ts:9036-9052`). `onReturn` keeps the
   existing composer **Compact** chip, shown when the thread is over 200k tokens and its cache
   has expired (`docs/user/providers-claude.md:44-68`).
5. **Limits.** Timers live in memory, so a server restart drops pending compactions
   (`IdleCompactionService.ts:124-129`). Pricing intent: compacting costs one cached read now
   instead of a full uncached read of over 200k tokens when the user comes back.

Related (new): delegated Claude children now follow the user's subagent prompt-cache TTL
(`066c8fc0`; `ClaudeAdapterV2.ts:1253-1267` sets `CLAUDE_CODE_PROMPT_CACHE_TTL`).

---

## 2. They do it better

1. **Adding a provider is a package, and ACP agents need no code at all.** Each T3 provider is
   `packages/provider-<name>` with `./settings`, `./client` (browser- and React-Native-safe
   label, icon, settings schema), `./server` (driver + adapter driver) and `./testing`. It talks
   to the server only through `ProviderHost` (`docs/internals/adding-a-provider.md` "Where a
   driver plugs in"). Registry ACP agents are pure data. Orquester instead hard-codes the four ids
   in a union (`packages/api/src/agent-chat/adapter-types.ts:19`), a static factory map
   (`apps/daemon/src/agent-host/adapters/index.ts`), registry entries, account families
   (`provider-auth-overlay.ts` `ACCOUNT_FAMILY_BY_ADAPTER`), profile adapters
   (`apps/daemon/src/agent-profile/adapters/{claude,codex,grok,opencode}`), box launchers and UI
   fallbacks. The literal `"grok"` appears in 68 non-test files and `"opencode"` in 52. T3's
   `apps/server` + `apps/web` + `client-runtime` + `contracts` have 12 and 18. Adding a fifth agent
   to Orquester means touching dozens of files.
2. **Honest capabilities and degradation policies.** T3's
   `OrchestrationV2ProviderCapabilities` (`packages/contracts/src/orchestrationV2.ts:329-346`)
   has 11 groups: sessions, threads, turns, streaming, tools, approvals, planning, subagents,
   context, checkpointing and identity. It adds `runtimePolicy.enforcement`, defaulting to
   `client-boundary` on old events so replay never over-claims. Each feature has a written
   fallback (`docs/orchestration-v2/provider-capability-system.md` "Degradation Policies").
   Orquester's `AdapterCapabilities` (`adapter-types.ts:346-395`) is a flat set of about 12 flags,
   and some decisions still branch on adapter id. For example, the comment on
   `supportsConversationRollback` says "`assertRollbackSupported` goes by adapter id, not this
   flag". This matters only as the provider count grows.
3. **Provider update safety.** See the table row. T3 resolves which installer owns the binary,
   re-checks ownership right before running, and verifies the refreshed version
   (`providerMaintenanceRunner.ts`). Orquester runs a hard-coded `npm update -g ...`, which can
   install a second copy beside a Homebrew or native install, then re-resolves the bin
   (`apps/daemon/src/registry.ts:262-279`).
4. **Permission-mode honesty.** T3 refuses to imitate a mode the agent cannot enforce ("T3's
   check is weaker than the agent's own enforcement", `docs/internals/adding-a-provider.md`)
   and runs it as Supervised (`RuntimePolicy.ts:62-71`). Orquester offers every mode for every
   agent and fills the Grok `auto-accept-edits` gap in the host (`adapters/grok/permissions.ts:182`).
5. **Model catalog ahead of the CLI.** Through `minVersion`, T3 can show a model the user's CLI
   is too old for and say which update unlocks it (`docs/internals/model-manifest.md`). Orquester
   can only show what the installed CLI reports.
6. **Native diagnostics with bounded payloads.** T3 keeps a native event log that drops token
   deltas and duplicate frames before redaction, with a 64 KiB per-payload budget that preserves
   routing ids and error fields (`apps/server/src/provider/EventNdjsonLogger.ts`;
   `docs/internals/providers.md` "Provider diagnostics"). Orquester keeps `raw` on runtime events
   and bounds session-tool payloads (`boundSessionToolData`). It has no separate bounded
   native-frame diagnostics log. This is a debugging-ergonomics difference, not a user feature.

---

## 3. Worth copying (ranked by value / effort)

1. **"Why Claude asked" on approvals (S, new in T3).** In `adapters/claude/session.ts`
   `canUseTool`, read `callbackOptions.decisionReason`, `matchedAskRule` and
   `suppressAlwaysAllowRule`. Strip VT control codes, drop the reason when it equals the prompt,
   and add `reason` plus `fullAccessOverride: "ask_rule" | "provider_check"` to the approval
   request payload in `packages/api/src/agent-chat/runtime-events.ts`. When
   `suppressAlwaysAllowRule` is set, offer only Approve/Decline. Render a one-line reason in the
   approval card under `packages/ui/src/components/agent-chat/`. Crib from
   `ClaudeAdapterV2.ts` `claudeApprovalPresentation` (commit `e7492453`) and
   `packages/contracts/src/providerPolicy.ts`. Add a Claude fixture replay under
   `apps/daemon/test/fixtures/claude`.
2. **Classify Codex 429 retry exhaustion as `usage_limit` (S, new).** In
   `adapters/codex/normalise.ts` `failureReasonOf`, treat an object `CodexErrorInfo` whose
   inner `httpStatusCode === 429` as `usage_limit`, and keep `transport_error` for the other
   statuses. Also honor the completion's HTTP status as T3 does (`codexExhaustionHttpStatus`,
   `CodexAdapterV2.ts:1118-1133`; tests `exhausted-429`, `exhausted-500`, commit `58b48274`). The existing
   `apps/daemon/src/agent-chat/limit-recovery.ts` then arms auto-resume and account failover
   with no other change.
3. **Idle Claude compaction before the cache expires, plus an "Auto-compact after" setting
   (S–M, new).**
   - (a) In `adapters/claude/usage.ts` / `normalize.ts`, derive `promptCacheTtlMs` from
     `cache_creation.ephemeral_{1h,5m}_input_tokens` and stamp `promptCacheExpiresAt` (from the
     request time) on `ThreadTokenUsage` (`packages/api/src/agent-chat/runtime-events.ts:496`).
   - (b) Add `apps/daemon/src/agent-chat/idle-compaction.ts` beside `limit-recovery.ts` and
     reuse its pattern: persisted intent, timers rebuilt on start, idempotent command id
     `idle-compact:<session>:<turn>`, and a send through `DaemonApi` to
     `agentChatRoutes.compact(sessionId)` (`packages/api/src/agent-chat/wire.ts:130`).
   - (c) Port the eligibility rules from `IdleCompaction.ts` verbatim: completed latest turn
     that was not itself a compaction, nothing pending, no live background work or delegates,
     at least 200k tokens, start 2 minutes before expiry.
   - (d) Add `claudeIdleCompaction: "onReturn" | "beforeCacheExpires" | "off"` and
     `claudeAutoCompactWindow` to the agent prefs in `packages/config/src/index.ts` (next to
     `claudeSubagentCacheTtl`, `:777`). Expose them in
     `packages/ui/src/components/settings/AgentsSettings.tsx`. Pass `autoCompactWindow` through
     the SDK `settings` in `adapters/claude/launch.ts`. Make `off` answer `resume_return` with
     `continue` in `session.ts:1885`.

   Persisting timers would be an improvement over T3, whose timers are lost on restart.
4. **Claude plugin skills (S, new).** Extend `adapters/claude/skills.ts` to read
   `<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json` and `enabledPlugins` from settings, then
   scan each enabled plugin's `skills/` as `scope: "plugin"` with `plugin:name` naming. Crib
   from `apps/server/src/provider/Drivers/ClaudeSkills.ts:221-347` (`c2b127f8`). Agent Profiles
   already model plugins (`apps/daemon/src/agent-isolation/claude-plugin.ts`), so a profile
   thread should scan the profile's plugin dir rather than the global one.
5. **Generic ACP adapter, first as "Local ACP command", later the ACP Registry (M then L).**
   - Factor `adapters/grok/acp/{peer,connection}.ts` into
     `apps/daemon/src/agent-host/adapters/acp/` (shared).
   - Write a generic normaliser over standard `session/update` variants: text, thought, tool
     call, plan, available commands, config options, usage. Keep the xAI-specific parts in
     `grok/normalize.ts`.
   - Add an `acp` adapter id whose `StartSessionInput` carries `{command, args, env}` from a new
     registry entry kind.
   - Negotiate capabilities from `initialize` (`loadSession` → resume, `sessionCapabilities.fork`).
     Map approvals by runtime mode the way T3's `clientPolicy.ts:85,184` does. Map plan mode to
     an advertised `plan`/`architect` mode.
   - Crib from `packages/provider-acp/src/server/adapter.ts:471-601` (capability negotiation)
     and `packages/effect-acp/src/client.ts` (v2→v1 fallback).
   - The Registry layer (`packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`:
     fetch, exact-version npx/uvx prefixes, SHA-256, `tools/<id>/<version>`) is a later step. It
     belongs in `apps/daemon/src/registry.ts` with paths from `packages/config`.

   This unlocks DeepSeek Harness, Gemini/Antigravity ACP, Copilot, Droid and other ACP agents
   in one go.
6. **Installer-ownership-aware updates (M).** Replace the fixed `updateCmd` strings in
   `packages/registry/src/index.ts` with a resolver in `apps/daemon/src/registry.ts`:
   - realpath the resolved bin; detect a Homebrew keg/cask, `<prefix>/lib/node_modules/<pkg>`,
     pnpm/bun/volta/mise layouts and native installers;
   - otherwise fall back to the agent's own updater (`claude update`, `codex update`,
     `opencode upgrade`, `grok update`), and keep mise installs manual;
   - re-check ownership just before running, and report success only if the re-read version
     changed.

   Crib from `apps/server/src/provider/providerMaintenanceRunner.ts` and
   `packages/provider-core/src/server/maintenanceResolver.ts`. Add a "behind latest" advisory
   (npm registry / `brew info`) to `ProviderVersionAdvisory`, which already exists
   (`packages/api/src/agent-chat/adapter-types.ts:457-465`).
7. **Codex reset credits (S–M).** Drop `excludeResetCreditDetails: true`
   (`adapters/codex/probe.ts:449`). Surface `RateLimitResetCredit` (already generated in
   `adapters/codex/_generated/protocol/v2/`) on `ProviderUsageLimits`, and add a "Use reset"
   action that calls `ConsumeAccountRateLimitResetCredit` through a daemon route. Crib from
   `apps/server/src/provider/resetCreditCoordinator.ts`.
8. **Declare supported runtime modes per adapter (S).** Add
   `supportedRuntimeModes?: RuntimeMode[]` to `AdapterCapabilities`. Filter `RUNTIME_MODES` in
   `ComposerChips.tsx:318` and `NewTabMenu.tsx:406`. Run an unsupported stored mode as
   `approval-required` in the host, as T3's `RuntimePolicy.ts:62-71` does. At minimum, label
   OpenCode `auto` as "asks like Supervised".

Lower priority:
- OpenCode 2.x runtime (L). Watch OpenCode's release status, because a 2.x install may break the
  1.x pooling in `adapters/opencode/server.ts`.
- Cursor SDK adapter (L).
- Custom model IDs per agent (S).
- Multi-model fan-out (M, composer domain). In T3, Shift-click in a new thread's model picker
  starts one thread per model, each in its own worktree (`docs/user/thread-sidebar.md:41-44`).
- A `/usage-limits` composer command that shows the cached Limits snapshot without running the
  agent (S; `apps/web/src/components/chat/useUsageLimitsPanel.ts`,
  `packages/shared/src/usageLimits.ts:588-595`).

---

## 4. We do it better / they lack

- **Usage-limit recovery with account failover.** Orquester persists limit state on the tab
  record before acting. It rebuilds timers after a restart, resumes on the provider's reset +
  45s through receipted command ids, and can opt in to **switching the chat to another account
  of the same family** that isn't cooling down, shared with the workflows' cooldown store
  (`apps/daemon/src/agent-chat/limit-recovery.ts` header;
  `packages/api/src/agent-chat/usage-limit.ts`; prefs `autoResumeLimitedChats`,
  `switchAccountOnUsageLimit` in `packages/config/src/index.ts:797,804`). T3 has auto-resume and
  snooze (`OrchestrationV2LimitRecovery`, `packages/contracts/src/orchestrationV2.ts:349-355`;
  `autoResumeLimitedThreads` `settings.ts:1209`, default **off**; the sweep is in
  `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts`). T3 has no failover (no match
  for failover or account rotation in `apps/server/src` or contracts).
- **In-app sign-in without a terminal** for all three account families. Claude.ai OAuth PKCE
  with paste-back (`apps/daemon/src/claude-oauth.ts`), Codex device code
  (`codex-device-auth.ts`) and Grok RFC 8628 device code (`grok-device-auth.ts`), with a
  background token refresher (`agent-account-refresh.ts`) and managed account homes. T3 has a
  managed ChatGPT OAuth flow for Codex, including a remote-to-primary handoff
  (`apps/server/src/provider/CodexChatGptAuth.ts:104`, `CodexChatGptHandoff.ts:11`), and flows
  for Antigravity, Cursor and ACP. It has **no managed Claude sign-in**: users run
  `claude auth login` themselves (`docs/user/providers-claude.md:12-29`). Grok sign-in is the
  `grok login` CLI.
- **Automatic subagent prompt-cache TTL.** `claudeSubagentCacheTtl: "auto"` picks 1h vs 5m from
  14 days of the user's own subagent cache reads and writes (`apps/daemon/src/subagent-cache-ttl.ts`:
  `WINDOW_DAYS = 14`, `MIN_REQUESTS = 500`, `MARGIN_PCT = 5`). T3 only passes a user-set value
  through (`066c8fc0`, `ClaudeAdapterV2.ts:1253-1267`).
- **Turns survive server restarts.** The adapters run in a separate agent-host process that
  outlives daemon deploys (`apps/daemon/src/agent-host/README.md`, "Why separate"). That process
  also tracks leftover provider processes and work across launches (`support/leftover-processes.ts`,
  `support/leftover-work.ts`). T3's in-memory idle-compaction timers, by its own comment, do not
  survive a restart (`IdleCompactionService.ts:127-128`).
- **Agent Profiles** (per-chat isolated kits of instructions, skills, MCP, plugins, hooks;
  `apps/daemon/src/agent-profile/adapters/*`, `adapters/profile-manifest.ts`) and **box
  launches** (agent CLIs in ephemeral VMs, `apps/daemon/src/agent-host/boxes/`). T3's
  per-instance home is coarser.
- **Claude task tools: parity, with one open question.** Both products fold `TaskCreate` /
  `TaskUpdate` / `TaskList` and `TodoWrite` into a task list (Orquester
  `adapters/claude/classify.ts:26-43`, `normalize.ts:215,1719`; T3
  `ClaudeAdapterV2.ts:3766-3809,8262`). T3 tells users to set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
  for SDK sessions (`docs/user/providers-claude.md:90-95`, new). Orquester never sets that
  variable. Check live whether SDK chats on the current CLI still emit task tools without it.
- **Parity worth noting** (not a gap), all checked in source:
  - steering into a running turn, with a steer/queue follow-up setting and a per-message inversion
    (`agent-host/orchestration/orchestrator.ts:347,2598`;
    `packages/ui/src/lib/agent-chat/queue.logic.ts:225-236`). T3 has the same
    (`apps/server/src/orchestration-v2/CommandPolicy.ts:190,285`), with ACP agents limited to
    interrupt-and-restart;
  - "Continue in another agent" budgeted handoff (`packages/api/src/agent-chat/handoff.ts`, after
    T3's `handoffBudget.ts`);
  - listing and resuming past Claude/Codex/Grok CLI conversations
    (`apps/daemon/src/agent-conversations.ts`; T3 also supports ACP native session import);
  - Claude `resume_return` compaction dialog (`adapters/claude/session.ts:1885`);
  - probes that never authenticate or open a session (`adapters/claude/probe.ts:11`);
  - per-provider replay fixtures with READMEs (`apps/daemon/test/fixtures/{claude,codex,grok,opencode}`);
  - goals for Claude, Codex and Grok (`AdapterGoalSupport`, `adapter-types.ts:290-304`);
  - Codex service tiers (`adapters/codex/probe.ts:337-348`);
  - Claude fast mode (`adapters/claude/models.ts:81,98`);
  - four permission modes with native Claude `auto` (`adapters/claude/launch.ts:49-54`).

## Verification notes

Everything above was read from source on both sides. Nothing was run: no daemon, builds or tests,
per the read-only rule. Line numbers are as of T3 `ed9b7ca9` and Orquester `dcab9eed`. The
per-provider capability summaries for Cursor, Pi, Muse, Antigravity and ACP Registry come from
adapter capability objects (`packages/provider-cursor/src/server/adapter.ts:85-177`,
`packages/provider-pi/src/server/adapter.ts:95-189`,
`packages/provider-muse/src/server/adapter.ts:99-189`, `AntigravityAdapterV2.ts:46-61`,
`packages/provider-acp/src/server/adapter.ts:471-601`).
