# t3-5 — Adapter audit: draft section 2 vs T3 Code's actual source

Date: 2026-09-20. Method: read the T3 Code source directly (read-only clone at
`…/scratchpad/t3code`), not the earlier analyst reports. Every claim below cites `file:line`
relative to that clone root.

Scope: audit `draft-section-2.md` (adapter interface + normalised event union + permission-mode
mapping) against `ProviderAdapterShape`, `ProviderRuntimeEvent`, the approval/user-input
contracts, and the Claude / Codex / OpenCode / Grok adapters. Cursor and Antigravity are out of
scope by instruction.

Verdict in one line: **the draft's shape is right but it is roughly one third of the contract.**
The interface is missing 6 operations and 2 of 3 capability flags, the turn input is missing 4 of
its 6 fields, the event union is missing ~20 variants that matter for v1 (token usage / context
window, rate limits, model reroute, subagent + background task lifecycle, thread title, thread
compaction state, tool denial, hook lifecycle), the permission table has two factual errors, and
three draft items describe things T3 does differently or not at all.

---

## A. Full `ProviderRuntimeEvent` inventory

Source of truth: `packages/contracts/src/providerRuntime.ts:1177-1228` (the 49-member union).
Every variant carries `ProviderRuntimeEventBase` (`providerRuntime.ts:202-216`):
`eventId`, `provider`, `providerInstanceId?`, `threadId`, `createdAt`, `turnId?`, `itemId?`,
`requestId?`, `providerRefs?` (`providerTurnId`/`providerItemId`/`providerRequestId`,
`providerRuntime.ts:47-51`), `raw?` (the untranslated provider frame, tagged with one of 9
`RuntimeEventRawSource` values, `providerRuntime.ts:23-42`).

"Emitters" column is a mechanical grep of `type: "<variant>"` across the four in-scope adapters
(`ClaudeAdapter.ts`, `CodexAdapter.ts` + `CodexSessionRuntime.ts`, `OpenCodeAdapter.ts`,
`GrokAdapter.ts` + `acp/AcpCoreRuntimeEvents.ts`).

| # | Variant | Payload fields (schema line) | Emitters | In draft? | v1? |
|---|---|---|---|---|---|
| 1 | `session.started` | `message?`, `resume?` (`:219-222`) | C, Cx, O, G | yes (`session.started`) | **yes** — `resume` is the resume cursor handed back at start |
| 2 | `session.configured` | `config: Record<string,unknown>` (`:225-227`) | Claude only (`ClaudeAdapter.ts` ×2) | no | no — debug echo of the negotiated config |
| 3 | `session.state.changed` | `state: starting\|ready\|running\|waiting\|stopped\|error`, `reason?`, `detail?` (`:230-234`, enum `:54-61`) | C, Cx, G | no (draft has only started/stopped/error) | **yes** — this is the session status line the UI binds to. Note `"waiting"` is declared but **never emitted** anywhere in the server (grep `state: "waiting"` → 0 hits); waiting is derived from an unresolved `request.opened` |
| 4 | `session.exited` | `reason?`, `recoverable?`, `exitKind: graceful\|error` (`:237-241`) | C, Cx, O, G | partial (`session.stopped`) | **yes** — `recoverable` decides auto-restart vs surface-an-error |
| 5 | `thread.started` | `providerThreadId?` (`:244-246`) | C, Cx, O, G | no | **yes** — the provider-side conversation id, i.e. the resume cursor's payload |
| 6 | `thread.state.changed` | `state: active\|idle\|archived\|closed\|compacted\|error`, `beforeTokens?`, `afterTokens?`, `detail?` (`:249-253`, enum `:64-71`) | C, Cx, O | no | **yes** — `compacted` + before/after tokens is how a compaction is shown in the timeline |
| 7 | `thread.metadata.updated` | `name?`, `metadata?` (`:257-260`) | Cx, O | no | **yes** — provider-generated thread title (Codex and OpenCode both push one) |
| 8 | `thread.token-usage.updated` | `usage: ThreadTokenUsageSnapshot` — 16 fields incl. `usedTokens`, `maxTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `last*` variants, `toolUses`, `durationMs`, `compactsAutomatically`, `autoCompactThreshold` (`:263-285`) | C, Cx | **no** | **yes** — the context-window meter. `ServerProvider.reportsContextWindow` (`packages/contracts/src/server.ts:202`) exists purely so clients can reserve space for it |
| 9 | `thread.realtime.started` | `realtimeSessionId?` (`:288-290`) | Cx | no | **no** — Codex voice mode |
| 10 | `thread.realtime.item-added` | `item: unknown` (`:293-295`) | Cx | no | no — voice |
| 11 | `thread.realtime.audio.delta` | `audio: unknown` (`:298-300`) | Cx | no | no — voice |
| 12 | `thread.realtime.error` | `message` (`:303-305`) | Cx | no | no — voice |
| 13 | `thread.realtime.closed` | `reason?` (`:308-310`) | Cx | no | no — voice |
| 14 | `turn.started` | `model?`, `effort?` (`:313-316`) | C, Cx, O, G | yes | **yes** — note `effort` is echoed per turn |
| 15 | `turn.completed` | `state: completed\|failed\|interrupted\|cancelled`, `stopReason?`, `usage?`, `modelUsage?`, `totalCostUsd?`, `errorMessage?`, `tokenUsage: TurnTokenUsage` (`:348-356`) | C, Cx, O, G | yes | **yes** — `TurnTokenUsage` (`:325-345`) is a tagged union: `usageStatus: complete` requires input+output, `partial`/`unavailable` make them optional, and `hasSubagents` is mandatory so the UI can say "excludes subagents" |
| 16 | `turn.aborted` | `reason`, `tokenUsage?` (`:359-362`) | Cx, O | no (draft folds abort into `turn.completed`) | **yes** — T3 keeps abort distinct from a completed turn with a stop reason |
| 17 | `turn.plan.updated` | `explanation?`, `plan: [{step, status: pending\|inProgress\|completed}]` (`:365-374`) | C, Cx, O, ACP (`acp/AcpCoreRuntimeEvents.ts:137`) | **no** | **yes** — this is the live TODO/plan checklist; distinct from the plan-mode proposal below |
| 18 | `turn.proposed.delta` | `delta: string` (`:377-379`) | Cx only (`CodexAdapter.ts:1769`) | no | maybe — streaming of the plan-mode proposal text |
| 19 | `turn.proposed.completed` | `planMarkdown` (`:382-384`) | C (`ClaudeAdapter.ts:2604`), Cx (`:1721`), G (`GrokAdapter.ts:908,1128`) | yes (`plan.proposed`) | **yes** — this is the draft's `plan.proposed`. Note: **OpenCode never emits it** |
| 20 | `turn.diff.updated` | `unifiedDiff: string` (`:387-389`) | Cx (`CodexAdapter.ts:1664-1672`, `CodexSessionRuntime.ts` ×3) | no | maybe — cumulative turn diff; only Codex produces it natively |
| 21 | `item.started` | `ItemLifecyclePayload` (`:432-448`) | C, Cx, O, G, ACP | partial (`activity`) | **yes** |
| 22 | `item.updated` | same | C, Cx, O, ACP | partial | **yes** |
| 23 | `item.completed` | same | C, Cx, O, G, ACP | partial | **yes** |
| — | `ItemLifecyclePayload` fields | `itemType: CanonicalItemType`, `status: inProgress\|completed\|failed\|declined` (`:80`), `title?`, `detail?`, `toolSurface? (browser\|computer)`, `toolIcon?`, `toolSource?`, `data?`, `agentId?`, `parentToolUseId?` | | draft has only "kind" + payload | `agentId`/`parentToolUseId` are **load-bearing**: they re-home subagent activity out of the main timeline (`:441-447`) |
| — | `CanonicalItemType` (`:123-134`) | `user_message`, `assistant_message`, `reasoning`, `plan`, `command_execution`, `file_change`, `mcp_tool_call`, `dynamic_tool_call`, `collab_agent_tool_call`, `web_search`, `image_view`, `review_entered`, `review_exited`, `context_compaction`, `error`, `unknown` | | draft's list omits `image_view`, `web_search`, `mcp_tool_call`, `dynamic_tool_call`, `review_entered/exited`, `context_compaction` | closed enum + `unknown`, **not** the draft's open string |
| 24 | `content.delta` | `streamKind: assistant_text\|reasoning_text\|reasoning_summary_text\|plan_text\|command_output\|file_change_output\|unknown`, `delta`, `contentIndex?`, `summaryIndex?` (`:451-455`, enum `:83-91`) | C, Cx, O, ACP | partial (`message.delta`) | **yes** — one delta channel for **six** stream kinds, incl. **command output** and **file-change output**. The draft's `message.delta` covers only two of them |
| 25 | `request.opened` | `requestType: CanonicalRequestType`, `detail?`, `appName?`, `options?: ProviderApprovalOption[]`, `args?` (`:459-465`) | C, Cx, O, ACP | yes (`approval.requested`) | **yes** |
| 26 | `request.resolved` | `requestType`, `decision?`, `resolution?` (`:468-472`) | C, Cx, O, ACP | yes (`approval.resolved`) | **yes** |
| — | `CanonicalRequestType` (`:137-149`) | `command_execution_approval`, `file_read_approval`, `file_change_approval`, `apply_patch_approval`, `exec_command_approval`, `mcp_elicitation_approval`, `permission_approval`, `tool_user_input`, `dynamic_tool_call`, `auth_tokens_refresh`, `unknown` | | draft says only "the options the provider advertised" | note there are **two** vocabularies — this one, and the 5-value `ProviderRequestKind` (`orchestration.ts:139-146`) used on the legacy `ProviderEvent` |
| 27 | `user-input.requested` | `questions: UserInputQuestion[]`, `responseMode?: "message"` (`:494-497`) | C, Cx, O, G | yes (`question.asked`) | **yes** — see §C |
| 28 | `user-input.resolved` | `answers: Record<string,unknown>` (`:500-502`) | C, Cx, O, G | yes | **yes** |
| 29 | `task.started` | `taskId`, `description?` + the 18-field `taskAgentLinkage` block (`:623-627`, linkage `:580-618`) | C, Cx | **no** (draft folds "subagent spawned" into `activity`) | **yes** — subagents and background shells are a first-class roster, not a timeline row |
| 30 | `task.progress` | `taskId`, `description`, `summary?`, `usage?`, `typedUsage: RuntimeTaskUsage`, `lastToolName?`, `status?`, `error?` + linkage (`:642-653`) | C, Cx | no | **yes** |
| 31 | `task.updated` | `taskId`, `status?: RuntimeTaskStatus`, `description?`, `error?`, `endedAt?`, `isBackgrounded?` + linkage (`:661-669`) | C, Cx (×8) | no | **yes** — non-terminal status patch; `killed→cancelled`, `paused→idle` normalised at the adapter (`:656-660`) |
| 32 | `task.completed` | `taskId`, `status: completed\|failed\|stopped`, `summary?`, `usage?`, `typedUsage?` + linkage (`:672-679`) | C | no | **yes** |
| — | task linkage fields (`:580-618`) | `taskType`, `agentKind` (server-stamped `agent`\|`background`, `classifyTaskAgentKind` `:561-572`), `agentId`, `title`, `role`, `model`, `effort`, `toolUseId`, `parentAgentId`, `workflowName`, `agentIndex`, `phaseIndex`, `phaseTitle`, `phases[]`, `attempt`, `runHandles` (`runId`/`scriptPath`/`transcriptDir`/`sessionUrl`), `outputFile`, `agentPath`, `timelineBypass` | | none of this is in the draft | repeated on **every** row (not just start) so a client fold can rebuild an agent whose start row aged out (`:574-579`) |
| 33 | `hook.started` | `hookId`, `hookName`, `hookEvent` (`:682-686`) | C | no | maybe — Orquester already installs managed hooks; this is the surface that shows them running |
| 34 | `hook.progress` | `hookId`, `output?`, `stdout?`, `stderr?` (`:689-694`) | C | no | maybe |
| 35 | `hook.completed` | `hookId`, `outcome: success\|error\|cancelled`, `output?`, `stdout?`, `stderr?`, `exitCode?` (`:697-704`) | C | no | maybe |
| 36 | `tool.progress` | `toolUseId?`, `toolName?`, `summary?`, `elapsedSeconds?`, `taskId?`, `parentToolUseId?` (`:707-715`) | C, Cx | no | **yes** — the "still running, 42s" line on a long tool |
| 37 | `tool.summary` | `summary`, `precedingToolUseIds?[]` (`:718-721`) | C | no | no — Claude's "collapsed group" summary text |
| 38 | `auth.status` | `isAuthenticating?`, `output?: string[]`, `error?` (`:724-728`) | C (×3) | no | **yes** — login state surfacing mid-session (Claude's `/login` inside a turn) |
| 39 | `account.updated` | `account: unknown` (`:731-733`) | Cx | no | maybe |
| 40 | `account.rate-limits.updated` | `limits: ProviderUsageLimitsUpdate` = `{windows: ServerProviderUsageWindow[]}` — each `{id, kind: session\|weekly\|monthly\|other, label, usedPercent, resetsAt?, windowDurationMins?}` (`:740-742`; `providerUsageLimits.ts:20-27,69-72`) | C, Cx | **no** | **yes** — Orquester already has a usage-bar surface; sparse turn-driven updates merge by window `id` onto the probe snapshot (`providerUsageLimits.ts:63-68`) |
| 41 | `mcp.status.updated` | `status: unknown` (`:745-747`) | **nobody** (0 emitters server-wide) | no | no — dead variant |
| 42 | `mcp.oauth.completed` | `success`, `name?`, `error?` (`:750-754`) | Cx | no | no |
| 43 | `model.rerouted` | `fromModel`, `toModel`, `reason` (`:757-761`) | Cx, `CodexSessionRuntime.ts` ×4 | **no** | **yes** — silent downgrade (quota / unavailable model). Without it the UI lies about which model answered |
| 44 | `config.warning` | `summary`, `details?`, `path?`, `range?` (`:764-769`) | Cx | no | no |
| 45 | `deprecation.notice` | `summary`, `details?` (`:772-775`) | Cx | no | no |
| 46 | `files.persisted` | `files: [{filename, fileId}]`, `failed?: [{filename, error}]` (`:778-793`) | C | no | maybe — agent-produced files (image outputs) landing in the asset store |
| 47 | `tool.denied` | `toolName`, `toolUseId?`, `reason?`, `agentId?` (`:796-801`) | C | **no** | **yes** — a deny that did **not** come from a user approval (policy/hook denial); without it the timeline shows a tool that started and never ended |
| 48 | `runtime.warning` | `message`, `detail?` (`:804-807`) | C, Cx (×4), O (×8) | no | **yes** — the catch-all for "something odd but the turn continues" |
| 49 | `runtime.error` | `message`, `class: provider_error\|transport_error\|permission_error\|validation_error\|unknown`, `detail?` (`:810-814`, enum `:97-103`) | C, Cx (×4), O (×3) | partial (`session.error`) | **yes** — `class` is what decides retry vs surface vs re-auth |

### Not in the union at all (so the draft's absence is correct)

- **Citations.** `AssistantCitation` (`packages/contracts/src/assistantCitations.ts:12-30`) is a
  *user* quoting assistant text for a follow-up, not a provider-emitted source citation. Not a
  runtime event.
- **Slash-command / skills catalog.** Not an event. It lives on the provider *snapshot*:
  `ServerProvider.slashCommands` / `.skills` / `.workspaceSnapshots[]` (`server.ts:229-233`),
  refreshed per-cwd through `ProviderRegistry.refreshWorkspaceSnapshot`
  (`provider/Services/ProviderRegistry.ts:51-54`, `provider/Layers/ProviderRegistry.ts:806-829`).
  `ServerProviderSkill` carries `userInvocationOnly` / `userInvocable` (`server.ts:103-114`) —
  the two inverse Claude Code flags that decide whether a skill appears under `/` or only to the
  model.
- **Thread title generation.** `ThreadTitleState` (`orchestration.ts:673-677`) is orchestration
  state produced by a `TextGeneration` call; only a provider-pushed title arrives as
  `thread.metadata.updated`.
- **The open-kinded activity row.** `OrchestrationThreadActivity` (`orchestration.ts:641-650`:
  `id, tone: info|tool|approval|error, kind: string, summary, payload: unknown, turnId,
  sequence?, createdAt`) is what the draft describes as "`activity` with an open-ended kind
  string, full payload persisted, slimmed one on the wire" — but it is the **projection/
  persistence** layer, one level *above* the runtime union. T3 has two layers here and the draft
  collapses them into one (see §E.4).

---

## B. Adapter interface diff

Source: `apps/server/src/provider/Services/ProviderAdapter.ts` (the whole file, 158 lines) and
`packages/contracts/src/provider.ts`.

### B.1 Operations the draft is missing

| T3 operation | Signature | Why it matters |
|---|---|---|
| `readThread` | `(threadId) => ProviderThreadSnapshot` (`ProviderAdapter.ts:132`; snapshot shape `:57-65` = `{threadId, turns: [{id, items: unknown[]}]}`) | Reconcile after a restart/reconnect without replaying a transcript into the provider. All four in-scope adapters implement it |
| `listSessions` | `() => ProviderSession[]` (`:122`) | The reaper and the "is this thread live" check both go through it (`ProviderSessionReaper.ts:38`) |
| `hasSession` | `(threadId) => boolean` (`:127`) | Routing: which adapter owns a thread |
| `stopAll` | `() => void` (`:152`) | Shutdown path |
| `compaction` | optional `ProviderCompaction` = `{type:"native", start(threadId, modelSelection?)}` \| `{type:"slash-command", command:"/…"}` (`:35-43`, field `:89`) | **Per-provider divergence the draft has nothing for.** Claude `{slash-command, "/compact"}` (`ClaudeAdapter.ts:5573`), Codex `{native, compactThread}` (`CodexAdapter.ts:2729`), OpenCode `{native, compactThread}` (`OpenCodeAdapter.ts:4032`), Grok `{slash-command, "/compact"}` (`GrokAdapter.ts:2192`) |
| `uploadFeedback` | optional `(input) => {feedbackId}` (`:145-147`) | Codex-only (`CodexAdapter.ts:2633-2635`). Skippable for v1 |

Above the adapter, `ProviderService` adds two more the draft has no analogue for:
`compactThread(threadId, modelSelection?, requestId?)` (`Services/ProviderService.ts:57-61`) and
**`assertConversationRollbackSupported(threadId)`** (`:109-114`) — "Reject unsupported rewind
**before files change**, without resuming the session". The rewind flow is two-phase:
assert support (`orchestration/Layers/CheckpointReactor.ts:813`) → restore the git checkpoint →
roll back the conversation. File restore is additionally refused outside an isolated worktree
(`CheckpointReactor.ts:826-835`).

### B.2 Capability flags

T3's `ProviderAdapterCapabilities` (`ProviderAdapter.ts:45-55`) has exactly three fields:

- `sessionModelSwitch: "in-session" | "unsupported"` (`:49`) — **not** the draft's
  `"in-session" | "restart"`. All four in-scope adapters declare `"in-session"`
  (`ClaudeAdapter.ts:5571`, `CodexAdapter.ts:2724`, `OpenCodeAdapter.ts:4028`,
  `GrokAdapter.ts:2191`). The restart is an *orchestration* consequence of the flag, not a flag
  value (see §D/§4).
- `promptlessTurnContinuation?: boolean` (`:50-52`) — **missing from the draft entirely.** Codex
  is the only one that sets it (`CodexAdapter.ts:2725`). It gates whether a recovery turn can be
  sent with **no user prompt**; adapters without it get the literal string
  `"Continue where you left off."` (`serverRuntimeStartup.ts:348`, used at `:704-710`; enforced
  as a validation error at `Layers/ProviderService.ts:1692-1702`).
- `supportsConversationRollback?: boolean` (`:53-54`) — absent means supported. Grok sets
  `false` (`GrokAdapter.ts:2191`). The draft calls this `supportsRollback`; same idea, but the
  draft's `supportsPlanMode` **does not exist** (see §E.2).

### B.3 Turn input — `ProviderSendTurnInput` (`packages/contracts/src/provider.ts:69-83`)

Draft: `sendTurn(thread, {parts, attachments})`. Actual fields:

| Field | Type / bound | In draft? |
|---|---|---|
| `threadId` | — | implied |
| `input?` | trimmed non-empty string, **≤ 120 000 chars** (`PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, `orchestration.ts:165`) | "parts" — but T3 sends **one flat string**, not parts |
| `attachments?` | `ChatAttachment[]`, **≤ 8** (`orchestration.ts:166`) | yes |
| `modelSelection?` | `{instanceId, model, options?: [{id, value: string\|boolean}]}` (`orchestration.ts:75-79`, `model.ts:49-53`) | **no** |
| `interactionMode?` | `"default" \| "plan"` (`orchestration.ts:136-138`) | **no** — plan mode is a *per-turn* field, not a session-level toggle |
| `continuation?` | boolean, internal recovery signal (`provider.ts:71-73`) | **no** |

`ChatAttachment` is a **union of three** (`orchestration.ts:367-371`): `ChatImageAttachment`
(`:302-309`, mime must match `^image/`, ≤ 10 MiB), `ChatFileAttachment` (`:315-328`, ≤ 50 MiB),
and `ChatUnknownAttachment` (`:341-350`) — a deliberate forward-compat catch-all so a newer
producer cannot break an older decoder. Attachments are **references, not bytes**: `{id, name,
mimeType, sizeBytes}` only; the adapter resolves the id against the server-side attachment store
(`resolveAttachmentPath`, `apps/server/src/attachmentStore.ts:120-132`; used at
`ClaudeAdapter.ts:1634-1646`, `GrokAdapter.ts:1582-1586`). Claude additionally grants the
attachments dir as an `additionalDirectory` so the agent can read pasted images without an
approval prompt (`ClaudeAdapter.ts:4905-4911`).

**Context references are not an adapter input.** `ComposerContextRecord` /
`OrchestrationMessageContext` (`packages/contracts/src/composerContext.ts:239-281`) are persisted
alongside the *message* for re-render (`persistence/Layers/ProjectionThreadMessages.ts:26`); the
provider only ever receives the flattened `input` string. Worth copying — it keeps the adapter
boundary narrow.

`sendTurn` returns `ProviderTurnStartResult = {threadId, turnId, resumeCursor?}`
(`provider.ts:85-89`) — the draft says "returns a turn id" and misses that **the resume cursor is
refreshed per turn**, and is persisted on every turn
(`Layers/ProviderService.ts:1751-1766`).

### B.4 Session start input — `ProviderSessionStartInput` (`provider.ts:54-66`)

`threadId`, `provider?`, `providerInstanceId?`, `cwd?`, **`title?`**, `modelSelection?`,
`resumeCursor?`, **`approvalPolicy?`**, **`sandboxMode?`**, **`runtimeMode`** (required).

The draft's `{cwd, home, model, permissionMode, resumeCursor?}` is missing `title`,
`approvalPolicy`, `sandboxMode`, and the instance id; `home` has no T3 analogue (it is an
Orquester managed-account concept and is legitimately additive). `startSession` returns the whole
`ProviderSession` (`provider.ts:35-51`: `provider, providerInstanceId?, status (connecting|ready|
running|error|closed), runtimeMode, cwd?, model?, threadId, resumeCursor?, activeTurnId?,
createdAt, updatedAt, lastError?`), not just a cursor as the draft says.

### B.5 `listModels()` / `probe()` — T3 has neither

There is no `listModels` or `probe` on the adapter. Both live on the **driver/instance** side as
**one** snapshot: `ServerProviderShape` (`Services/ServerProvider.ts:6-25`) exposes
`getSnapshot` / `refresh` / `streamChanges` / `applyUsageLimits` / `resolveMaintenance`, and
`ProviderInstance` adds optional `snapshotForCwd(cwd)`, `refreshModels()`, `consumeResetCredit()`
(`ProviderDriver.ts:74-88`). One `ServerProvider` (`server.ts:188-238`) carries **all** of:
`installed`, `version`, `status`, `auth {status: authenticated|unauthenticated|unknown, type?,
label?, email?}`, `models[]`, `slashCommands[]`, `skills[]`, `workspaceSnapshots[]`,
`usageLimits`, `versionAdvisory`, `updateState`, `availability`. See §E.3.

---

## C. Approval and user-input contracts

### C.1 Decision vocabulary

`ProviderApprovalDecision` (`packages/contracts/src/orchestration.ts:147-154`) — exactly five:

```
"accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
```

So the draft's implicit "accept once / accept always / decline" is missing **`acceptForSession`**
and **`cancel`**. `cancel` is what the adapter uses to settle a pending request when the turn is
interrupted or the session dies — not a user choice (see §C.4).

**The options are advertised per request, not assumed.** `RequestOpenedPayload.options` is
`ProviderApprovalOption[]` (`providerRuntime.ts:463`), where each option is
`{decision, label, warning?}` (`orchestration.ts:155-161`) — `warning` is "a provider-supplied
caution shown next to the option, such as a prompt injection warning". The draft gets this right
("with the options the provider actually advertised"); it just needs to carry `label` and
`warning` too, because the *provider's own wording* is what the user sees.

### C.2 Request kinds

Two vocabularies, deliberately:

- `CanonicalRequestType` (11 values, `providerRuntime.ts:137-149`) on the runtime event —
  `command_execution_approval`, `file_read_approval`, `file_change_approval`,
  `apply_patch_approval`, `exec_command_approval`, `mcp_elicitation_approval`,
  `permission_approval`, `tool_user_input`, `dynamic_tool_call`, `auth_tokens_refresh`,
  `unknown`.
- `ProviderRequestKind` (5 values, `orchestration.ts:139-146`) — `command`, `file-read`,
  `file-change`, `mcp-elicitation`, `permission` — on the older `ProviderEvent` envelope
  (`provider.ts:156`).

There is **no dedicated plan-exit request kind**: Claude's ExitPlanMode arrives as
`permission_approval`.

### C.3 The user-input (question) contract

`UserInputQuestion` (`providerRuntime.ts:482-491`):

```ts
{ id, header, question, options: [{label, description, value?}], allowCustomAnswer?, multiSelect? }
```

`UserInputRequestedPayload` (`:494-497`) is `{questions: UserInputQuestion[], responseMode?:
"message"}` — i.e. **multi-question forms** in one request, each option carrying a
**description** (not just a label), per-question `allowCustomAnswer` and `multiSelect`
(defaulting to `false` via a constructor default, `:488-490`).

Answers go back as `ProviderRespondToUserInputInput` (`provider.ts:110-116`):
`{threadId, requestId, answers: Record<string, unknown>, attachmentsByQuestionId?:
UserInputAttachments}`. `UserInputAttachments` (`orchestration.ts:374-379`) is
`Record<questionId, (ChatImageAttachment|ChatFileAttachment)[]>`, capped at 8 per question — so
**answers can carry attachments**, which the draft's `respondToQuestion(thread, requestId,
answers)` has no room for. Note the adapter-level `respondToUserInput`
(`ProviderAdapter.ts:108-112`) takes only `answers`; the attachments are folded into the answer
text by the layer above (`UserInputAttachmentAnswerPayload`, `orchestration.ts:382-388`, which
also carries `questionTextById` so the answer can be rendered without the original request).

Nothing in the contract marks a question "dismissible"; `responseMode: "message"` is the escape
hatch — the answer is delivered as an ordinary turn instead of a structured response.

### C.4 Pending-request settlement is universal, not a Codex quirk

The draft attributes "interrupt must settle pending approvals first" to Codex only. Every
request-bearing adapter does it: `settlePendingApprovalsAsCancelled` +
`settlePendingUserInputsAsCancelled` are called on both stop and interrupt in
`GrokAdapter.ts:182-192, 938-939` and `CursorAdapter.ts:156-169, 476-477, 1168-1169`. Grok even
uses "are there pending approvals?" as part of its liveness test (`GrokAdapter.ts:508`).

---

## D. Per-provider facts the draft omits

The draft's §"Quirks carried over" is four sentences. Below is what a fresh implementation
actually has to know, per provider, beyond those four.

### D.1 Claude (`claudeAgent`) — `provider/Layers/ClaudeAdapter.ts` (5589 lines)

**Launch.** The SDK `Options` object is built at `ClaudeAdapter.ts:4913-4966` and handed to
`query({prompt, options})` (`:2097-2106, 4993-4998`). Fields actually set:

| Option | Value | Line |
|---|---|---|
| `cwd` | `input.cwd` | 4914 |
| `model` | `resolveClaudeCatalogApiModelId(catalog, modelSelection)` — slug **plus manifest suffix**, e.g. `claude-opus-5[1m]` for the 1M context window | 4849-4851, 4915; `ClaudeModelCatalog.ts:233-250` |
| `pathToClaudeCodeExecutable` | `resolveClaudeSdkExecutablePath(settings.binaryPath, env)`, resolved once per adapter | 2083-2086, 4916 |
| `systemPrompt` | `{type:"preset", preset:"claude_code", append: buildRuntimeInstructions({harness:"Claude Code"})}` — model/effort deliberately left out of the append because they change per turn | 4917-4922; `RuntimeInstructions.ts:6-16` |
| `settingSources` | `["user","project","local"]` | 1545-1549, 4923 |
| `effort` | normalised through the manifest `effortMap` | 4874-4878, 4926-4930 |
| `thinking` | `{type:"adaptive", display:"summarized"}` when summaries are wanted | 4931-4938 |
| `permissionMode` | see below | 4939 |
| `allowDangerouslySkipPermissions` | true iff `permissionMode === "bypassPermissions"` | 4940-4942 |
| `settings` | `{alwaysThinkingEnabled?, showThinkingSummaries?, fastMode?, ultracode?, autoCompactWindow?}` | 4892-4900, 4943 |
| `resume` / `sessionId` | resume uuid from the cursor, or a freshly generated uuid | 4420-4422, 4944-4945 |
| `includePartialMessages` | `true`, always | 4946 |
| `canUseTool` | the approval callback | 4947 |
| `onUserDialog` / `supportedDialogKinds` | `["resume_return"]` — the CLI's "this resume is old, compact?" dialog is turned into an AskUserQuestion | 4593-4661, 4948-4949 |
| `env` | base env + `CLAUDE_CONFIG_DIR` only, **never `HOME`** | 2080-2082, 4950; `ClaudeHome.ts:36-54` |
| `additionalDirectories` | `[cwd?, serverConfig.attachmentsDir]` | 4905-4912, 4951 |
| `extraArgs` | parsed from `settings.launchArgs`, minus `permission-mode` / `dangerously-skip-permissions` (folded into `permissionMode` instead, so argv order can't lose) | 4834-4838, 4952 |
| `mcpServers` | `{"t3-code": {type:"http", url, headers:{Authorization}}}` only when a thread-scoped MCP session exists | 4904, 4953-4965 |

**Never set** (verified by grep over `provider/`): `hooks`, `allowedTools`, `disallowedTools`,
`maxTurns`, `fallbackModel`, `agents`, `stderr`, `abortController`, `executable`,
`strictMcpConfig`, `maxThinkingTokens`. There are **no SDK hooks** — the `hook.*` runtime events
are the *user's own* configured hooks reported back as system messages. `setMaxThinkingTokens`
exists on the runtime wrapper (`:462`) and is never called.

**Prompt feeding is a long-lived streaming input.** One unbounded `Queue` per session
(`:4428`) → `Stream.fromQueue → filter → map → toAsyncIterable` (`:4429-4436`) is the SDK prompt.
`sendTurn` only offers onto that queue (`:5272-5278`); `query()` is **never re-made per turn**.
Content block order is load-bearing: optional leading text (skill dispatch) → image blocks →
final text block, and the final text block must be last or the CLI will not treat a leading
`/command` as a slash command (`:1666-1675`). The SDKUserMessage is stamped `uuid: turnId`
(`:5276`) so the native transcript id equals the T3 turn id — this is the basis of rollback.

**Permission modes.** `auto-accept-edits→acceptEdits`, `auto→auto`,
`full-access→bypassPermissions` (`:4879-4883`). **`approval-required` is deliberately absent
from the map** — `permissionMode` stays `undefined` (SDK default) and gating happens entirely
through `canUseTool`. The draft's "Supervised = default, approval callback" is right; the table
just hides that it is an *absence*, not a value. `interactionMode` is applied **in-session** via
`query.setPermissionMode("plan")` / `setPermissionMode(basePermissionMode)` (`:5187-5201`) — no
restart. RuntimeMode change *does* restart, because `canUseTool` closes over the start-time
`runtimeMode` (`:4705`).

**`canUseTool` details the draft has none of** (`:4663-4824`):
- `AskUserQuestion` is intercepted and becomes the `user-input.requested` flow; the question `id`
  **must equal the full question text** because the SDK ≥2.1.121 looks answers up by text
  (`:4463-4471`). It returns `{behavior:"allow", updatedInput:{questions, answers}}` (`:4584-4590`).
- `ExitPlanMode` emits `turn.proposed.completed` and then **always denies** with a fixed message
  telling the model to stop and wait (`:4683-4703`). Plan mode is a *client-owned* card, never
  the SDK's own plan gate.
- `full-access` short-circuits to allow with **no event at all** (`:4705-4711`).
- Decision mapping (`:4802-4823`): `accept`→allow; `acceptForSession`→allow **plus**
  `updatedPermissions: toSessionPermissionUpdates(...)`; `cancel`→deny "User cancelled tool
  execution."; **everything else, including `acceptAlways`, → deny.**
- `toSessionPermissionUpdates` (`:312-331`) reuses the SDK's `suggestions` but **rewrites every
  `destination` to `"session"`** (the SDK's own suggestions target `localSettings`, i.e.
  `.claude/settings.local.json`, and would persist permanently), and falls back to
  `{type:"addRules", rules:[{toolName}], behavior:"allow", destination:"session"}` when there are
  no suggestions (common for MCP tools).

**Model listing and auth are both non-obvious.** Models come from a **static JSON manifest**
(`provider/model-manifest.json`, `ModelManifest.ts:36,138-139`), optionally refreshed from a
GitHub raw URL with a 1 h TTL and a disk cache — never from a CLI or API call. Auth is probed by
starting a **second `query()` whose prompt is a never-yielding async generator**
(`ClaudeProvider.ts:348-350`) so the CLI finishes local init IPC but never calls the API, then
reading `await q.initializationResult()` (`:358`) for `account.{email, subscriptionType,
tokenSource, apiProvider}` and aborting (`:393-397`). 25 s timeout, cached 5 min keyed on
`binaryPath\0configDir\0cwd`. Install/version is a plain `--version` spawn, 4 s.
Usage limits come from the same probe via
`q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (`ClaudeProvider.ts:366-374`).

**Skills / slash commands.** Skills are a **filesystem scan**, no SDK call: `<configDir>/skills`
(scope `user`) and `<cwd>/.claude/skills` (scope `project`), one dir per skill with `SKILL.md`
frontmatter, overrides merged from five settings files (`ClaudeSkills.ts:308-384, 189-268`),
re-scanned **on every `sendTurn`** (`ClaudeAdapter.ts:5245-5257`). Slash commands come from the
SDK init handshake (`ClaudeProvider.ts:246-307`). Dispatch is **plain text, never a control
request**: `$name` chips are rewritten and the last one becomes a trailing `/name …` text block
(`ClaudeSkillDispatch.ts:49-80`).

**Interrupt is a full teardown.** `interruptTurn` does **not** call `query.interrupt()` — it
calls `stopSessionInternal` (`:5289-5297`), because `interrupt()` can acknowledge while resumed
background tasks keep the CLI alive. Teardown cancels every pending approval with `"cancel"`,
cancels pending user-inputs, emits `task.completed {status:"stopped"}` for live tasks, and
completes the turn as `"interrupted"` (`:4262-4369`). **For Claude, "stop" and "interrupt" are
the same operation**, and the next turn needs a restart from the resume cursor.

**Rollback is a native fork with a hard failure mode** (`:5306-5486`). Read native history via
`getSessionMessages` — run **in a child process** when `CLAUDE_CONFIG_DIR` differs from the
server's, because the SDK helpers read `process.env` (`:5337-5393`). Boundaries come from the
stamped turn uuids. Then `forkSession(sessionId, {upToMessageId})`. The fork **rewrites every
uuid**, so `remapClaudeForkTurnBoundaries` (`:180-225`) re-aligns conversation-only messages from
the truncated end by offset and requires a **deep-equal body + role match** for every retained
message (role-only matching once mistook restored steering messages for turn starts). Any
mismatch, any missing boundary, or a compaction in between ⇒ a hard
`ProviderAdapterRequestError` telling the user to start a new thread (`:5422-5433, 5453-5468`).
The draft says "re-align turn boundaries"; the real rule is **refuse rather than guess**.

**Steering.** A `sendTurn` during a live turn is a steer: same `turnId`, message queued into the
running loop, no new turn boundary. A stale *synthetic* turn (auto-started by background
assistant output) is auto-closed first (`:5153-5162, 3371-3421`).

### D.2 Grok (`grok`) — `provider/Layers/GrokAdapter.ts` + `provider/acp/*`

**Launch argv is runtime-mode dependent and the flag position changes**
(`acp/GrokAcpSupport.ts:33-46`): `["--permission-mode","default","agent","stdio"]`,
`…"acceptEdits"…`, `…"auto"…`, but `full-access` is `["agent","--always-approve","stdio"]` —
flag **after** `agent`. Env adds `GROK_OAUTH2_REFERRER: "t3code"` (`:15-16, 48-63`).
`XAI_API_KEY` is read but never written — it only picks the ACP auth method id
(`"xai.api_key"` vs `"cached_token"`, `:65-69`). `GROK_HOME` is **not** set by the adapter.

**Handshake.** `initialize {protocolVersion: 1, clientCapabilities, clientInfo}`
(`acp/AcpSessionRuntime.ts:726-735`; version const `packages/effect-acp/src/_generated/
meta.gen.ts:35`). **Grok declares no client capabilities** — `fs.readTextFile/writeTextFile:
false`, `terminal: false` (`AcpSessionRuntime.ts:596-608`), so the agent never calls `fs/*` or
`terminal/*` back. `authenticate {methodId}` is always sent next (`:740-748`) and the agent's own
advertised `authMethods` are **not consulted**. The agent's typed capabilities are barely used;
what matters is **`initialize._meta`** — `modelState` → models, `availableCommands` → slash
commands, `modeState` (`acp/AcpRuntimeModel.ts:735-747`, `GrokProvider.ts:315-340`).

**Resume is `session/load`, not `session/resume`** (`GrokAdapter.ts:1011`,
`AcpSessionRuntime.ts:792-796`), and it races the RPC response against a **2 s replay-idle gate**
because the CLI replays history as notifications and may never answer the RPC: replay
notifications (`_meta.isReplay`) are dropped but bump a liveness clock, and after 2 s idle a
**synthetic** `LoadSessionResponse` is fabricated from `initialize._meta`
(`AcpSessionRuntime.ts:804-864`, `AcpRuntimeModel.ts:709-758`), 90 s overall timeout. Resume
cursor is `{schemaVersion: 1, sessionId}` (`GrokAdapter.ts:92, 282-287, 1280-1283`).

**`session/prompt` may never return.** Two independent safety nets exist:
`_x.ai/session/prompt_complete`, an agent→client **notification** raced against the RPC
(`acp/XAiAcpExtension.ts:429-438, 468-471`), and a **turn liveness watchdog** — 10 min with no
activity, 30 min while a tool call is in progress, paused while an approval or question is
pending, not started until the first observable ACP progress (`GrokAdapter.ts:97,101,443-446,
507-518, 729-818`). `stopReason` vocabulary is five values, not four:
`end_turn | max_tokens | max_turn_requests | refusal | cancelled`
(`_generated/schema.gen.ts:9871`).

**Tool output must be bounded and coalesced or it floods the bus.** Grok resends the *whole*
accumulated output on every `tool_call_update`, so content and `rawOutput.{content,stdout,stderr,
output}` are truncated to an 8000-char tail with an `"[Earlier output truncated]"` marker
(`AcpRuntimeModel.ts:289-320, 338-442`), and emission is coalesced: always on completed/failed or
a title/status change, otherwise only when progress grew ≥256 chars or 10 updates were skipped
(`:594-595, 645-666`).

**The `allow_always` workaround — the draft's one-liner understates it.** `selectGrokPermissionOptionId`
(`GrokAdapter.ts:289-313`) prefers the matching `kind`, and when `acceptForSession` finds no
`allow_always` it falls back to the `allow_once` option. The "always" part is then enforced by
T3, keyed on a **stable hash of the operation, not the tool-call id** (`:1152-1166`):
`stableStringify({kind, title, command, input: operationInput, locations})`, where a Bash
`rawInput` has its `description` field **stripped first** because it varies per call. The key is
only recorded when the user actually chose `acceptForSession`, and a `rawInput` with no keys and
no command yields **no key at all** (a generic title cannot identify an operation safely). The
set is per-session (`:983`). **`acceptAlways` falls through to `reject_once`** (`:293-298`) —
currently harmless only because Grok never advertises approval options to the UI: Grok passes
**no `approvalOptions`** into `request.opened` (`:1187-1203`), so T3 shows its own fixed decision
set rather than the provider's labels. That directly contradicts the draft's "with the options
the provider actually advertised" for this provider.

**x.ai extension methods** (registered under **both** `x.ai/` and `_x.ai/` spellings):
- `x.ai/ask_user_question` — the structured-question channel (`XAiAcpExtension.ts:35-64`);
  answers are keyed **by question text**, unmatched free text becomes `["Other"]` plus an
  annotation note (`:130-196`).
- `x.ai/exit_plan_mode` — T3 **abandons the native gate**: emits `turn.proposed.completed` and
  replies `{outcome:"abandoned", feedback:"The client captured your proposed plan…"}`
  (`:206-267`). Outcome vocabulary is `approved | abandoned | request_changes`.
- `_x.ai/session/prompt_complete` — the fallback above; `stopReason:"rate_limit"` becomes a
  typed error with JSON-RPC code **-32003** (`:33, 587-594`).

**Plan mode is detected, not declared.** `GrokProvider.ts:51` sets
`showInteractionModeToggle: false`, yet the adapter still emits `turn.proposed.completed` —
from `enter_plan_mode`-shaped tool calls (`GrokAdapter.ts:233-272`) and from writes to
`~/.grok/sessions/**/plan.md` promoted into a proposal (`:1425-1446`, path matcher
`XAiAcpExtension.ts:322-353`, which refuses `..` segments and workspace-local `plan.md`).

**Model switching** uses the **unstable `session/set_model` RPC** (`AcpSessionRuntime.ts:1109-1123`),
not `session/set_config_option`; the product slug `"grok-build"` is **never sent over the wire** —
it means "keep the session's current model" (`GrokAcpSupport.ts:164-166`). Reasoning effort rides
as `_meta.reasoningEffort` on that request, token-validated and *dropped* rather than forwarded
when invalid, and an absent preference is never sent as an explicit clear (`:113-122, 178-187`).

**Model listing / login state** is a three-step probe (`GrokProvider.ts:366-556`):
`grok --version` (4 s) → **`grok models`** (10 s, text-parsed: `/you are logged in/i`,
`/not authenticated|not logged in/i`, `* `/`- ` bullet lines, `(default)` marker, `:258-286`) →
an **`initialize`-only ACP probe** (8 s) that deliberately sends no `authenticate` and no
`session/new` so it cannot trigger a browser login or boot MCP servers (`:342-364`). Auth verdict
precedence: `XAI_API_KEY` → CLI text → unknown (`:486-492`). Two advertised slash commands are
filtered out by name: `always-approve` (permission changes must go through T3) and `context`
(its ACP handler completes without emitting output) (`:328-330`). Skills come from
`grok inspect --json` (`GrokSkills.ts:50-92`), 4 s, with typed probe errors so a failure never
caches an empty catalog.

**Background tasks / subagents** are reconstructed from `rawOutput` discriminants on
`tool_call_update` — `Monitor`, `BackgroundTaskStarted`, `TaskOutput`, `KillTask`
(`acp/XAiBackgroundTasks.ts:61-155`) — and are emitted **even after the turn ends**
(`GrokAdapter.ts:1343-1366`).

**Interrupt** marks `interruptedTurnIds` **synchronously before taking the thread lock** so late
notifications and a late prompt result are dropped (`:2018-2040`), settles pending approvals and
user-inputs as cancelled **first** (`:2065-2066`, satisfying the ACP rule that a cancel must
answer every pending permission request with `cancelled`, `schema.gen.ts:7782`), then sends the
`session/cancel` **notification** and settles the turn. `rollbackThread` always fails
(`:2142-2157`), matching `supportsConversationRollback: false`.

**Lifecycle:** one `grok agent stdio` child **per thread**, kept alive indefinitely, **no
adapter-level idle reaper**; per-thread `Semaphore(1)` with a documented lock-ordering rule
(never hold the prompt-lifecycle lock and the thread lock together, `:1786-1787`).

**Generic ACP machinery a fresh implementation must rebuild** (`acp/AcpSessionRuntime.ts`):
the client-side method registry the agent can call back into — `fs/read_text_file`,
`fs/write_text_file`, `session/elicitation(/complete)`, `session/request_permission`,
`session/update`, `terminal/{create,kill,output,release,wait_for_exit}`
(`_generated/meta.gen.ts:21-33`); assistant-message **segmentation is synthesized client-side**
(`assistant:<sessionId>:runtime:<uuid>:segment:<n>`, opened on the first delta, closed on a tool
call / prompt end / drain, `AcpSessionRuntime.ts:1204-1208, 1279-1342`); a `drainEvents` barrier
pushed through the queue and acknowledged by the adapter so final chunks land before turn
settlement (`:941-957`); stderr kept as a redacted 4 KiB rolling tail (pairing URLs, `Bearer`,
`x-api-key`, `sk-`/`ghp_`/`xox?-`, home dir) attached to the first termination error
(`acp/AcpStderr.ts:5-37`, `AcpSessionRuntime.ts:380-419`); and native protocol logging that
**summarises payloads, never logs them raw** (`acp/AcpNativeLogging.ts:18-44`).

### D.3 OpenCode (`opencode`) — `provider/Layers/OpenCodeAdapter.ts` (4047 lines) + `provider/opencodeRuntime.ts`

**Server lifecycle — and the trap.** `opencode serve --hostname=<h> --port=<p>`
(`opencodeRuntime.ts:667-699`), spawned `detached: true` off Windows. Readiness is a **stdout
scrape**: a line starting `"opencode server listening"` with the URL pulled by
`/on\s+(https?:\/\/[^\s]+)/` (`:81, 290-299, 751-765`), 30 s timeout, startup capture capped at
64 KiB and then set to `null` while the pipes keep draining so OpenCode can't block on a full
buffer (`:837-841`). Auth is `Authorization: Basic base64("opencode:<password>")` (`:657-663`).
`OPENCODE_CONFIG_CONTENT` must be set explicitly because `extendEnv` is false — clobbering it
once hid the user's own providers (`:704-711`). A post-start `GET /api/health` enforces
`MINIMUM_OPENCODE_VERSION = "1.14.19"` (`:42, 143-179`). Shutdown is SIGTERM to the **process
group** (`process.kill(-pid)`), 1 s, then SIGKILL (`:728-745`).

There is no cwd on the process — the working directory is a **per-client `directory`** passed to
`createOpencodeClient` and sent as a query param (`:653-665`).

**The "one shared server" design does not apply to the adapter.** `OpenCodeServerOwner`
(`provider/OpenCodeServerOwner.ts:85-165`) is a ref-counted, 30-second-idle-TTL server **per
provider instance** — but it is used only by the snapshot probe, per-cwd skill/command probes and
text generation (`Drivers/OpenCodeDriver.ts:140-170, 213-223`). Every `startSession` calls
`connectToOpenCodeServer` itself against the session's own `directory`, bound to that session's
scope (`OpenCodeAdapter.ts:2846-2863, 3005-3037`). **On a default install that is one
`opencode serve` child process per thread.** For Orquester this is the single most important
number in the OpenCode adapter.

**Resume cursor** is `{schemaVersion: 1, sessionId}` (`:71, 2997-3000`); a wrong version or empty
id means "no resume", never an error (`:79-91`). Resume re-adopts the upstream session id, and
only a **structurally confirmed 404** may fall through to a fresh session — `isOpenCodeNotFound`
walks `cause/body/error/data` for up to 32 steps and an explicit non-404 status **seals its
subtree** (`:104-142`). Same directory ⇒ reuse in place **and re-assert the permission ruleset**;
different directory ⇒ `session.fork({sessionID, directory})` + re-assert (`:2901-2947`).

**Prompting.** Only `session.promptAsync` (`POST /session/{id}/prompt_async`) is used
(`:3274-3291`); the blocking `session.prompt` is **never called**, because turn completion comes
from `session.status: idle`, not from the HTTP response. The submit call itself is capped at 10 s
(`:3291-3305`). Body: `{sessionID, messageID, model:{providerID, modelID}, agent?, variant?,
system, parts}`. The **user message id is minted client-side** in OpenCode's sortable native
shape ``msg_${48-bit-hex-time}${14 random alnum}`` (`:996-1026`) so prompt-admission events can
be matched. A slash command goes down a different route entirely — `session.command`
(`POST /session/{id}/command`), which **accepts no `system` addendum** (`:3248-3266`).

**Snapshot-to-delta is the draft's one correct OpenCode quirk, but the rule is subtler.**
`mergeOpenCodeAssistantText` (`:640-656`) does three things: `resolveLatestAssistantText` keeps
the **previous** text when it is longer *and* prefixes the incoming one — so a truncated snapshot
never rewinds output (`:633-638`); the prefix length is `previous.length` when the latest starts
with it, otherwise a real `commonPrefixLength`; and `emitAssistantTextDelta` sets **both**
`emittedText` and `text` before emitting so the same bytes can never go out twice (`:1617-1644`).
A *non-text* part update for a known part clears `text` but **keeps `emittedText`** (`:2476-2483`).
`message.part.delta` (`field === "text"` only) is genuinely incremental and appends instead of
diffing (`:658-669, 2426-2445`).

**Idle reconciliation is the largest piece of the adapter, and the draft's one-liner hides three
machines.** Idle is *deferred* when a cancellation is in flight, when a prompt admission is still
open, while `awaitingBusyAfterInterruption`, or while a reconciliation is already scheduled
(`:2622-2640`).
- `scheduleIdleReconciliation` (`:1170-1275`) polls `GET /session/status` with a 1 s timeout and
  one retry; a **missing entry** counts as idle; `busy`/`retry` abandons unless a newer idle
  marked it dirty; undecidable emits one `runtime.warning` and backs off `min(250·2^n, 5000)`.
- `schedulePromptAdmissionRecovery` (`:1342-1503`) handles **idle arriving before `promptAsync`
  returns**: confirm the user message exists via `GET /session/{id}/message/{msgId}`, poll status,
  and require **two consecutive idle confirmations** before completing; 5 attempts, then a hard
  failure with `turn.completed{state:"failed"}` + `runtime.error{transport_error}` and the detail
  "OpenCode accepted the prompt, but T3 Code could not confirm its message or session status."
- A reconnect (`server.connected`, not first) marks usage incomplete and re-arms both (`:2204-2212`).

**Permissions are a rule list, not the `edit/bash/webfetch` map the draft implies.**
`buildOpenCodePermissionRules(runtimeMode)` (`opencodeRuntime.ts:508-544`) returns
`{permission, pattern, action}[]`: `full-access` ⇒ `[{*,*,allow},{external_directory,*,allow}]`;
otherwise base `{*,*,ask}` plus `read` allow **except `*.env` / `*.env.*` which ask** (and
`*.env.example` allow), `glob/grep/lsp/skill/todowrite/question` allow, `bash` ask, and
**`edit` allow only for `auto-accept-edits`**. **`"auto"` deliberately keeps asking**
(`:516-519`) — which is what the draft's "falls back to Supervised" means, but the reason is a
choice in this table, not a missing feature. The ruleset is written on create, on resume-in-place,
after a cwd fork and after a rollback fork — a plain HTTP `PATCH /session/{id}`, **no server
restart** — but there is **no in-session mutate path**, so a RuntimeMode change still only lands
at the next `startSession`.

Reply route is `POST /permission/{requestID}/reply` (`:3762-3769`), *not* the
`/session/:id/permissions/:permissionID` route that also exists in the SDK. Decision mapping
(`opencodeRuntime.ts:546-560`): `accept→"once"`, **`acceptForSession` and `acceptAlways` both →
`"always"`**, everything else → `"reject"`. The UI labels it "Allow for workspace" **with a
warning that it applies to other sessions in the same workspace** (`OpenCodeAdapter.ts:1764-1772`).
In `full-access`, asks are auto-answered **`"once"` and never `"always"`**, because OpenCode
stores `always` per directory and doom-loop detection plus subagent sessions ignore the session
ruleset (`:1777-1804`).

**Models / auth.** No `opencode auth list`. Models come from `GET /provider`, **skipping any
provider not in `providerList.connected`**, slug `"${provider.id}/${model.id}"`
(`OpenCodeProvider.ts:258-289`), and **login state is inferred from
`providerList.connected.length > 0`** (`:543-567`). Installed/version is `opencode --version`
(4 s). A CLI fallback inventory exists and must run its three commands **sequentially** because
concurrent runs hit the shared SQLite "database is locked" (`opencodeRuntime.ts:962-1060`); the
driver prefers the SDK `GET /skill` because the Bun-compiled binary truncates non-TTY stdout at
one 64 KB pipe buffer (`OpenCodeDriver.ts:171-189`).

**Compaction is native**: `POST /session/{id}/summarize` with `auto:false` and a **10-minute**
timeout, under the prompt semaphore, and it **refuses while a turn is active**
(`OpenCodeAdapter.ts:3537-3602`). The follow-up event is `session.compacted` →
`thread.state.changed{state:"compacted"}` (`:2314-2328`).

**Effort is the `variant` field, not a reasoning-effort parameter** — surfaced as a select
labelled "Reasoning" built from `model.variants`, or synthesised `low/medium/high/xhigh`
(`OpenCodeProvider.ts:202-256`), passed as `variant` on both submit paths. **No
`reasoningEffort`/`thinking` field is ever sent.**

**Plan mode**: `showInteractionModeToggle: false` (`OpenCodeProvider.ts:32-35`), but
`interactionMode === "plan"` does send `agent: "plan"` when no explicit agent is chosen
(`OpenCodeAdapter.ts:3207`). OpenCode never emits `turn.proposed.*`.

**Interrupt**: `POST /session/{id}/abort` (10 s) **then walk `GET /session/{id}/children` and
abort every descendant**, concurrency 8, cycle-guarded, 404s ignored (`:785-852, 3675-3697`). The
acknowledgement can arrive either as the HTTP reply *or* as a `session.error` carrying
`MessageAbortedError` (`:300-307, 2650-2660`). Success emits **`turn.aborted`**, not
`turn.completed`. Teardown aborts the parent **first** so it can't spawn a new child (`:854-866`).

**Rollback is a fork, deliberately not `session.revert`** — native revert also rewrites workspace
files, so T3 forks only the retained conversation (`:3938-3939`). It verifies the fork kept
exactly the expected message count and errors otherwise (`:3956-3966`), then re-applies the
ruleset and mints a new cursor.

**Child-session event routing**: parent-session events pass; **child-session events pass only if
they are permission or question events** (`:2215-2265`), behind an ancestry-resolution retry loop
(250 ms→5 s backoff; asked-events retry forever, terminal events give up after 5).

### D.4 Codex (`codex`) — `provider/Layers/CodexAdapter.ts` + `CodexSessionRuntime.ts`

**Launch.** `codex app-server` plus tokenized user launch args
(`Layers/codexLaunchArgs.ts:12-15`; `T3CODE_CODEX_LAUNCH_ARGS` env overrides the setting, `:3-8`).
Env sets **`CODEX_HOME`, tilde-expanded in the adapter**, because `child_process.spawn` does not
shell-expand env values and `CODEX_HOME=~/.codex_work` reaches codex verbatim
(`CodexSessionRuntime.ts:1315-1319`, same note at `CodexProvider.ts:369-373`).
**One `codex app-server` child per thread session** — the runtime is created inside
`startSession` and bound to a per-session `Scope` (`CodexAdapter.ts:2317-2336`).

**Handshake** (`CodexSessionRuntime.ts:2434-2435`):
`request("initialize", {clientInfo:{name:"t3code_desktop", title:"T3 Code Desktop", version},
capabilities:{experimentalApi: true}})` (`CodexProvider.ts:343-354`), then
`notify("initialized", undefined)`. The response's `userAgent` is the **only** source of the
Codex version — parsed with `/\/([^\s]+)/` (`CodexProvider.ts:423-424`).

**Thread open.** `thread/start {cwd, approvalPolicy, sandbox, approvalsReviewer, model?,
serviceTier?}` (`CodexSessionRuntime.ts:545-560`). Resume is
`thread/resume {threadId, ...startParams, excludeTurns: true}` — and on a *recoverable* resume
error it **falls back to a fresh `thread/start`** rather than failing the session
(`:723-775`). `approvalsReviewer` is always sent explicitly, because omitting it on resume keeps
the thread's previous reviewer and leaves `auto_review` sticky after a mode switch (`:512-514`).

**RuntimeMode → policy** (`runtimeModeToThreadConfig`, `:509-540`) — this confirms the draft's
Codex column and adds the third axis:

| RuntimeMode | approvalPolicy | sandbox | approvalsReviewer |
|---|---|---|---|
| `approval-required` | `untrusted` | `read-only` | `user` |
| `auto-accept-edits` | `on-request` | `workspace-write` | `user` |
| `auto` | `on-request` | `workspace-write` | **`auto_review`** |
| `full-access` | `never` | `danger-full-access` | (default) |

There is a **second, per-turn** sandbox policy with a different spelling —
`{type:"readOnly" | "workspaceWrite" | "dangerFullAccess"}` (`:562-580`).

**Turn.** `turn/start` (`buildTurnStartParams`, `:612-660`) with `input` items
`{type:"text", text}` plus `{type:"localImage", path}` per attachment, the thread config, and —
when `interactionMode` is set — a `collaboration_mode` block
`{mode, settings:{model, reasoning_effort, developer_instructions}}` built by
`buildCodexCollaborationMode` (`:583-606`), whose instructions come from
`provider/CodexDeveloperInstructions.ts`. **Plan mode for Codex is a per-turn collaboration mode
with its own model, effort and system instructions** — not a session flag. Before each turn,
`config/mcpServer/reload` is issued when MCP servers are configured, best-effort
(`:2504-2511`).

**Approvals — Codex is the only provider that natively speaks T3's decision vocabulary.** Five
server-request handlers: `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `mcpServer/elicitation/request`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`
(`:2089, 2147, 2215, 2270, 2319`); anything else is answered `methodNotFound` (`:2348-2350`).
The approval response is literally `{decision}` with **`acceptAlways` normalised down to
`acceptForSession`** (`:2107, 2165`) — the only place in T3 where `acceptAlways` survives past
the contract. `item/tool/requestUserInput` answers `{answers}` via `toCodexUserInputAnswers`,
mapping a per-question validation failure to `invalidParams` (`:2336-2345`).

The resume cursor is simply `{threadId: <provider thread id>}`, returned on every turn result
(`:2556-2559`).

**Interrupt — the draft's quirk is right, but its stated reason is stale in T3's own source**
(`:2561-2602`). The order is:
1. `settlePendingApprovals("cancel")`. The in-source comment says "The transport answers server
   requests inline on its stdin read loop, so a pending command/file/app-permission prompt blocks
   every incoming message, including the `turn/interrupt` response itself — cancelling after the
   RPC would deadlock Stop exactly when a card is open" (`:2565-2572`). That is the sentence the
   draft inherited, and **the transport no longer works that way**: every inbound server request
   is forked into `requestHandlerScope`
   (`packages/effect-codex-app-server/src/protocol.ts:159, 338`; asserted at
   `protocol.test.ts:438`), so a parked approval does not block the read loop. The ordering is
   still load-bearing, for a different reason: in-flight server requests are capped at 32, beyond
   which the peer is answered `-32001 "Too many Codex requests are already active."`
   (`protocol.ts:18, 304-314`). Carry the rule, not the explanation.
2. `settlePendingUserInputs({})` — they block the same way (`:2573-2574`).
3. **Interrupt every live child turn first**, because collab children are full threads with their
   own turns and interrupting only the parent leaves the fleet running — bounded at 3 s per child
   and 10 s overall, concurrency 8, because the transport awaits an unbounded Deferred per
   request and a wedged child would otherwise block the parent interrupt forever, exactly during
   the runaway fleet where Stop matters most (`:2575-2594`).
4. Only then `turn/interrupt {threadId, turnId}` (`:2599-2602`).

**Compaction is native**: `thread/compact/start {threadId}` (`:2497-2500`); `compaction:
{type:"native", start: compactThread}` (`CodexAdapter.ts:2729`).

**Rollback has two code paths** (`rollbackCodexThread`, `:1271-1288`): legacy threads use
`thread/rollback {threadId, numTurns}`; **paginated** threads do not support the count-based
endpoint, so T3 reads the thread and issues `thread/revert {threadId, beforeTurnId}` at the
computed boundary. A fresh implementation that only knows `thread/rollback` will silently fail on
newer Codex histories.

**Models, auth, skills, usage** all come from a **short-lived probe app-server**
(`withCodexAppServerClient`, `CodexProvider.ts:362-410`, shared by the status probe, the skills
probe and reset-credit redemption): `account/read` → `{account, requiresOpenaiAuth}` and an early
return when unauthenticated (`:426-434`); `model/list` **paginated by `cursor`** (`:330-338`);
`skills/list {cwds:[cwd]}` (`:438-440`); `account/rateLimits/read` treated as an *enrichment* —
timeout or failure degrades to "no usage this probe" rather than costing the account and model
list (`:442-461`), and it also returns `rateLimitResetCredits`, the banked-reset-credit feature
behind `ProviderInstance.consumeResetCredit` (`ProviderDriver.ts:77-85`).

**Capabilities**: `{sessionModelSwitch:"in-session", promptlessTurnContinuation: true}`
(`CodexAdapter.ts:2723-2726`) — the only adapter with the latter. `uploadFeedback` is
Codex-only: `feedback/upload {classification:"bug", includeLogs:true, reason?, threadId}`
(`CodexSessionRuntime.ts:2618-2626`).

**stderr becomes events.** Lines matching Codex's own log format are parsed and re-emitted as
`process/stderr` notifications, with a benign-snippet denylist (`state db missing rollout path
for thread`, `record_discrepancy … falling_back`) so routine noise never surfaces
(`:52-57, 2372-2400`).

**Further Codex specifics worth knowing before implementing:**

- **`CODEX_HOME` has two layouts** (`Drivers/CodexHomeLayout.ts:44-66`). `direct` uses the shared
  home; `authOverlay` builds a **shadow home of symlinks** into it — `sessions`,
  `archived_sessions`, `sqlite`, `shell_snapshots`, `worktrees`, `skills`, `plugins`, `cache`,
  `logs`, `mcp-oauth-locks` are shared (`:19-30`), while `auth.json` and `models_cache.json` stay
  private (`:32`, and `auth.json` in the shadow **must be a real file, never a symlink**,
  `:295-318`) and `log`, `memories`, `tmp` stay shadow-local (`:33`). The continuation key is
  `"codex:home:<sharedHomePath>"` (`:55, 64, 417-422`), which is how two instances sharing a home
  can continue each other's threads.
- **MCP is wired through `-c` config overrides**, not a params field:
  `-c mcp_servers.t3-code.url=<endpoint>` and
  `-c 'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"'` appended to argv
  (`CodexAdapter.ts:2300-2305`), with the token in env (`:2298`).
- **The transport has no request timeouts at all** and writes no `jsonrpc` field
  (`protocol.ts:104, 460-474`). Callers add their own deadlines; most Codex calls in T3 have none.
- **Three incompatible approval enums coexist upstream.** The v2 methods T3 uses take
  `accept | acceptForSession | decline | cancel`; elicitation takes `accept | decline | cancel`;
  the legacy `applyPatchApproval` / `execCommandApproval` take
  `approved | approved_for_session | denied | timed_out | abort`. T3 speaks only the first two and
  answers **six** legitimately-sendable server-request methods with `-32601`
  (`CodexSessionRuntime.ts:2348-2350` vs `_generated/meta.gen.ts:105-116`), including
  `item/fileRead/requestApproval` and `account/chatgptAuthTokens/refresh`.
- **`item/permissions/requestApproval`** answers `{permissions, scope}` — `scope:"session"` only
  for `acceptForSession` (`:2287-2294`).
- **User-input questions are filtered hard**: a question is dropped unless it has id, header,
  prompt **and** at least one option whose label *and* description are both non-empty, and
  `multiSelect` is hard-coded `false` (`CodexAdapter.ts:895-906`); if every question is dropped
  the event is suppressed. The reply shape is
  `{answers: Record<questionId, {answers: string[]}>}` (`CodexSessionRuntime.ts:2336-2344`).
  There is a **second, reply-less** question path: an `item/completed` `agentMessage` with
  `delivery:"async"` and `questions[]` becomes `user-input.requested{responseMode:"message"}` with
  a synthetic id — the answer goes back as an ordinary turn, not a JSON-RPC response
  (`CodexAdapter.ts:1691-1711`).
- **Why in-session model switching needs no RPC**: `turn/start`'s `model`/`effort`/`serviceTier`
  are documented upstream as overriding "for this turn **and subsequent turns**"
  (`_generated/schema.gen.ts:43364-43409`), so the per-turn override is sticky.
  `effort` is a plain non-empty string, **not an enum** (`schema.gen.ts:10633`).
- **Plan mode does not tighten the sandbox.** `interactionMode` maps only into
  `collaborationMode.mode` and the developer-instruction prose
  (`provider/CodexDeveloperInstructions.ts:46-177`); a plan-mode turn under `full-access` still
  ships `danger-full-access`. "Don't mutate" is prompt-enforced only.
- Codex advertises exactly **two** slash commands — `compact` and `feedback`
  (`CodexProvider.ts:680-687`) — and has no custom-prompt catalog.
- Two fragile spots to not copy verbatim: recoverable-resume detection matches **English
  substrings** (`CodexSessionRuntime.ts:59-66`), and item classification is a **substring
  heuristic over a de-camel-cased type name**, not a switch (`CodexAdapter.ts:633-663`).

**Codex is the sole emitter** of `turn.diff.updated`, `turn.proposed.delta`, `model.rerouted`,
`account.updated`, `mcp.oauth.completed`, `config.warning`, `deprecation.notice` and all five
`thread.realtime.*` variants — worth knowing when deciding which of those to implement.

---

## E. Draft items that are wrong or unnecessary

### E.1 `startSession(...)` "returns a resume cursor" — wrong shape, and the cursor is per-turn

T3 returns the whole `ProviderSession` (`packages/contracts/src/provider.ts:35-51`), and the
cursor is **refreshed on every turn**: `ProviderTurnStartResult.resumeCursor` (`:85-89`), which
`ProviderService` persists after each `sendTurn` (`Layers/ProviderService.ts:1751-1766`). Claude
updates it on every assistant message (`ClaudeAdapter.ts:2186-2205`). If Orquester persists the
cursor only at session start it will resume at the wrong place after a crash.

### E.2 `supportsPlanMode` does not exist, and plan mode is **not** supported by all four

There is no such capability. The plan-mode affordance is a **presentation** flag on the provider
snapshot, `ServerProvider.showInteractionModeToggle` (`packages/contracts/src/server.ts:199`),
and it is **`true` for Claude (`ClaudeProvider.ts:57`) and Codex (`CodexProvider.ts:68`),
`false` for OpenCode (`OpenCodeProvider.ts:34`) and Grok (`GrokProvider.ts:51`)**. OpenCode has a
partial substitute (`agent: "plan"` per turn, `OpenCodeAdapter.ts:3207`) and never emits
`turn.proposed.*`; Grok has an *inferred* plan mode (tool-call shapes and `plan.md` writes,
`GrokAdapter.ts:233-272, 1425-1446`) that does emit `turn.proposed.completed` but no toggle.
Rewrite that line as: **plan mode is first-class only on Claude and Codex.**

Related: the plan concept is **two** runtime events, not one. `turn.proposed.*` is the plan-mode
*proposal* (the draft's `plan.proposed`); `turn.plan.updated` is the live TODO checklist that
Claude, Codex, OpenCode and generic ACP all emit. The draft has no place for the latter, which is
the more frequently seen of the two.

### E.3 "changing mode restarts the session" — only for RuntimeMode, not for plan mode

The restart decision is made in orchestration, not in the adapter
(`orchestration/Layers/ProviderCommandReactor.ts:752-818`). It restarts when **any** of:
`runtimeMode` changed, `cwd` changed, the provider *instance* changed, the model changed on an
adapter whose `sessionModelSwitch === "unsupported"`, **or** (Claude only) the whole
`modelSelection` object changed — `preferredProvider === "claudeAgent" && !Equal.equals(previous,
requested)` (`:767-770`), which catches option changes such as thinking level that Claude bakes
into launch. The resume cursor is carried across every restart **except** the
model-change-on-unsupported case, which deliberately starts fresh (`:783-785`).

`interactionMode` is **not** in that list. It is a per-turn field
(`ProviderSendTurnInput.interactionMode`) applied live: Claude calls
`query.setPermissionMode("plan")` / `setPermissionMode(base)` (`ClaudeAdapter.ts:5187-5201`),
Codex builds a per-turn `collaboration_mode` block with its own model/effort/developer
instructions (`CodexSessionRuntime.ts:583-606, 642-647`), OpenCode sets `agent` per turn.

### E.4 `modelSwitch: "in-session" | "restart"` — wrong enum, and the value is the same for all four

T3's flag is `"in-session" | "unsupported"` (`Services/ProviderAdapter.ts:28`). **All four
in-scope adapters declare `"in-session"`.** The flag's only job is to decide whether a model
change forces a restart; "restart" is the consequence, never the declared value. Keeping
`"restart"` as a value invites putting the orchestration policy in the adapter.

The draft is also missing the third flag entirely: **`promptlessTurnContinuation`**
(`ProviderAdapter.ts:50-52`), set only by Codex (`CodexAdapter.ts:2725`). Without it there is
nowhere to express "this provider can resume a turn with no synthetic prompt", and every restart
recovery has to inject a fake user message.

### E.5 `probe()` and `listModels()` do not exist as separate adapter operations

Neither is on `ProviderAdapterShape`. Both are the **same** driver-level call: one
`ServerProvider` snapshot (`packages/contracts/src/server.ts:188-238`) that carries `installed`,
`version`, `status`, `auth`, `models[]`, `slashCommands[]`, `skills[]`, `usageLimits`,
`versionAdvisory`, `updateState` and `availability`, produced by `ServerProviderShape.refresh`
and pushed on `streamChanges` (`Services/ServerProvider.ts:6-25`). Per-cwd data (workspace skills
and slash commands) is a *second, narrower* call, `snapshotForCwd` / `refreshWorkspaceSnapshot`
(`ProviderDriver.ts:75`, `Services/ProviderRegistry.ts:51-54`).

Splitting `probe()` from `listModels()` in Orquester would double the cost of the expensive part.
Per provider, the models and the login state come from the *same* expensive operation: Claude's
never-yielding `query()` probe returns `account` and usage in one shot
(`ClaudeProvider.ts:331-401`); Grok's `grok models` text output carries *both* the model list and
the login sentence (`GrokProvider.ts:258-286`); OpenCode infers login purely from
`providerList.connected.length` on the same `GET /provider` that lists models
(`OpenCodeProvider.ts:258-289, 543-567`). Only Claude's model list is cheap and independent — it
is a static JSON manifest (`ModelManifest.ts:36, 138-139`).

The draft's requirement that these "must never authenticate or open a real session" is sound and
matches T3, but it is enforced by *how the probe is written*, not by splitting the API: the Claude
probe feeds a never-yielding async generator so the CLI finishes local init and never calls the
API (`ClaudeProvider.ts:348-350`); the Grok probe sends `initialize` and **deliberately no
`authenticate` and no `session/new`**, so it cannot trigger a browser login or boot MCP servers
(`GrokProvider.ts:342-364`). Copy those two tricks, not the API split.

### E.6 `rollbackThread(thread, toTurn)` returning a cursor — wrong signature and wrong return

T3's is `rollbackThread(threadId, numTurns: number) => ProviderThreadSnapshot`
(`ProviderAdapter.ts:137-140`): a **count of turns to drop**, returning `{threadId, turns:[{id,
items}]}`. The new cursor is internal. There is also a separate `readThread` (`:132`) for reading
the snapshot without rewinding, and a separate **pre-flight**,
`assertConversationRollbackSupported` (`Services/ProviderService.ts:109-114`), whose entire
purpose is to refuse "before files change" — called by `CheckpointReactor.ts:813` *before* the
git checkpoint is restored. The draft's "returns the new resume cursor, or refuses" collapses a
two-phase protocol into one call; if Orquester keeps per-turn git checkpoints, it needs the same
ordering or a refused rewind will leave the working tree rolled back and the conversation not.

### E.7 The open-ended `activity` kind belongs one layer up, not at the adapter

At the adapter boundary T3 uses a **closed** `CanonicalItemType` enum with an `unknown` member
(`providerRuntime.ts:123-134`) plus a `RuntimeItemStatus` of
`inProgress|completed|failed|declined`. The open `kind: string` + `tone` + full `payload` shape
the draft describes is `OrchestrationThreadActivity` (`orchestration.ts:641-650`), produced by
`runtimeEventToActivities` (`orchestration/Layers/ProviderRuntimeIngestion.ts:469-1000+`), which
also *drops* non-tool item types (`:980-983`) and rewrites request types into a friendlier
`requestKind` (`:484-502`). Both layers are worth keeping — but putting the open string at the
adapter loses the exhaustiveness checking that catches an unmapped provider message (Claude's
`default` branch is a `satisfies never` guard that emits `runtime.warning`,
`ClaudeAdapter.ts:4185-4196`).

### E.8 `message.delta` / `message.completed` under-serves streaming

T3's `content.delta` has **six** stream kinds, two of which are not messages at all:
`command_output` and `file_change_output` (`providerRuntime.ts:83-91`). Claude routes tool
results into those (`ClaudeAdapter.ts:1862-1871, 3227-3251`). A draft union where deltas only
exist for assistant text and reasoning has nowhere to stream a long `bash` command's output, and
will end up bolting it onto `activity` payloads as full snapshots.

Also: T3 separates **reasoning text** from **reasoning summary text**. Claude deliberately emits
`reasoning_summary_text`, because it never returns a raw chain of thought
(`ClaudeAdapter.ts:1725-1731, 2926-2935`); Grok emits `reasoning_text` (`GrokAdapter.ts:1449-1461`).
Collapsing them means labelling a summary as the model's thinking.

### E.9 The quirk list: two attributions are wrong

- **"Codex answers approvals inline on its read loop (interrupt must settle pending approvals
  first)."** Two problems. First, the "inline on its read loop" half is **no longer true of T3's
  own transport** — inbound server requests are forked into a scope
  (`packages/effect-codex-app-server/src/protocol.ts:159, 338`); the adapter's comment saying
  otherwise (`CodexSessionRuntime.ts:2565-2571`) is stale, and the real constraint is the 32
  in-flight server-request cap (`protocol.ts:18, 304-314`). Second, the settle-pending-first rule
  is **universal**, not a Codex quirk. Claude's
  `stopSessionInternal` resolves every pending approval with `"cancel"` and emits
  `request.resolved` (`ClaudeAdapter.ts:4304-4328`); Grok settles approvals **and** user-inputs
  as cancelled before sending `session/cancel` (`GrokAdapter.ts:2065-2066`), which the ACP spec
  actually requires (`_generated/schema.gen.ts:7782`); Cursor does the same
  (`CursorAdapter.ts:476-477, 1168-1169`); OpenCode closes every pending permission and question
  inside `interruptOpenCodeTurn` (`OpenCodeAdapter.ts:1539-1550`). Make it a rule of the
  interface, not a per-provider note.
- **"Grok often omits allow_always (fake session-scoped grants by hashing the operation)."**
  Correct, but the draft's own "with the options the provider actually advertised" is violated by
  this very adapter: Grok passes **no `approvalOptions`** into `request.opened`
  (`GrokAdapter.ts:1187-1203`), so the UI shows T3's fixed decision set, not the agent's labels.
  The interface needs to allow both — advertised options *when present*, a provider-declared
  default set otherwise. And the hash key matters: `{kind, title, command, input, locations}` with
  a Bash `rawInput`'s `description` field **stripped** because it varies per call, and **no key at
  all** when there is neither a command nor a non-empty `rawInput` (`:1152-1166`).

Two more quirks are right but incomplete: Claude's rollback fork does not merely "rewrite message
ids" — the recovery requires a **deep-equal body + role match** for every retained message and
**hard-fails** rather than guessing (`ClaudeAdapter.ts:180-225, 5453-5468`); and OpenCode's
"prompt returns immediately" understates that the 10 s submit cap, the two-confirmation admission
recovery and the polled status reconciliation are three separate machines (§D.3).

### E.10 Missing from the draft altogether (not "wrong", but load-bearing)

1. **Compaction.** No operation, no capability, no event. T3 has `ProviderCompaction` with two
   strategies, a 10-minute completion timeout, and a terminal-state wait
   (`Layers/ProviderService.ts:232-233, 1883-1912`). Claude `/compact`, Grok `/compact`, Codex
   native, OpenCode native-and-refuses-while-a-turn-is-running.
2. **Steering.** A `sendTurn` during a live turn is not an error and not a queued second turn —
   it reuses the active turn id and is injected into the running loop
   (`ClaudeAdapter.ts:5153-5162`, `GrokAdapter.ts:1539, 1749-1757`, `OpenCodeAdapter.ts:3164-3167`).
   Grok additionally *cancels* the in-flight prompt to do it. An interface with no steering
   concept will either reject the user's second message or silently start a second turn.
3. **Restart recovery.** On boot, T3 either resumes the interrupted turn or settles the thread as
   an error, never leaving a spinner: it marks `continueAfterServerUpdate` on the binding, then
   sends a continuation turn — promptless where the capability allows, otherwise the literal
   `"Continue where you left off."` (`serverRuntimeStartup.ts:345-348, 660-730`). Directly
   relevant to Orquester, where `systemctl restart` kills any stdio child.
4. **Lazy session recovery.** `ProviderService.sendTurn` re-resolves with `allowRecovery: true`
   when the routed session is not active (`Layers/ProviderService.ts:1687-1709`), so a reaped or
   crashed session transparently re-adopts its cursor on the next turn. This is what makes
   reaping safe at all.
5. **Answers can carry attachments** — `attachmentsByQuestionId` (§C.3).
6. **Turn-level token accounting with an explicit unavailable state** — `TurnTokenUsage`'s
   `usageStatus: complete | partial | unavailable` and mandatory `hasSubagents`
   (`providerRuntime.ts:325-345`). A single optional `usage` blob (what the draft has) cannot
   express "these numbers are real but incomplete".

### E.11 Unnecessary — safe to drop for v1

- The five `thread.realtime.*` variants (Codex voice mode).
- `mcp.status.updated` — **zero emitters** anywhere in T3's server.
- `RuntimeSessionState`'s `"waiting"` — declared but never emitted; waiting is derived from an
  unresolved `request.opened`.
- `tool.summary`, `config.warning`, `deprecation.notice`, `account.updated`,
  `mcp.oauth.completed`, `uploadFeedback` (Codex-only), `CanonicalItemType`'s
  `review_entered`/`review_exited` (Codex reviewer mode).
- `ProviderRequestKind` (the 5-value legacy vocabulary) — use `CanonicalRequestType` only.

### E.12 One decision the draft should record explicitly: not reaping has a per-provider cost

T3 **does** reap: `ProviderSessionReaper` sweeps every 5 minutes and stops any binding idle for
30 minutes, skipping threads with an `activeTurnId` or live `backgroundLiveness` — because
subagent fleets, workflow runs and Monitor watch loops live inside the provider process and
nothing bumps `lastSeenAt` between turns (`Layers/ProviderSessionReaper.ts:17-18, 57-114`).
Choosing not to reap is defensible for a single-user box, but the cost is not uniform:

| Provider | Process footprint per live thread |
|---|---|
| Claude | one `query()`/CLI child, one long-lived `query()` reused for every turn (`ClaudeAdapter.ts:4993-5006`) |
| Grok | one `grok agent stdio` child **per thread**, no adapter-level reaper (`GrokAdapter.ts:998, 369`) |
| OpenCode | **one `opencode serve` child per thread** on a default install, because the adapter bypasses the ref-counted `OpenCodeServerOwner` (`OpenCodeAdapter.ts:2846-2863` vs `OpenCodeDriver.ts:140-147`) |
| Codex | see §D.4 |

If Orquester keeps every thread alive, the OpenCode case is the one that needs a deliberate
answer — either point every session at one shared `opencode serve` via the `serverUrl` setting
(`packages/contracts/src/settings.ts:822-871`), or accept one HTTP server per open chat tab. And
whatever is decided, T3's *lazy recovery* (E.10.4) is worth copying anyway: it makes a session
that died for any reason (crash, restart, OOM) indistinguishable from one that was reaped.
