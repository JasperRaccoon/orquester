# T3 Code — Server-Side Provider Layer

Research report for Orquester. Scope: `apps/server/src/provider/**`, the provider-touching parts of
`apps/server/src/orchestration/**`, `packages/effect-acp/**`, `packages/effect-codex-app-server/**`,
`apps/server/src/mcp/**`, and the provider docs.

All paths are relative to the t3code checkout root. Line numbers are from the shallow clone at the
commit analysed.

---

## 0. Executive summary

T3 Code drives **six** agent runtimes through **four distinct wire protocols**:

| Provider | driverKind | Transport | Protocol |
|---|---|---|---|
| Claude Code | `claudeAgent` | child process, owned by the vendor SDK | `@anthropic-ai/claude-agent-sdk` `query()` → CLI in `--input-format stream-json --output-format stream-json` |
| Codex | `codex` | child process stdio | `codex app-server` — **NDJSON JSON-RPC-ish** (no `jsonrpc` field), generated from `openai/codex` at a pinned commit |
| Cursor | `cursor` | child process stdio | ACP (`cursor-agent acp`) + vendor extensions |
| Grok | `grok` | child process stdio | ACP (`grok agent stdio`) + xAI extensions |
| Antigravity | `antigravity` | child process stdio | ACP (Google's ACP agent) + Antigravity extensions |
| OpenCode | `opencode` | **HTTP + SSE** | `opencode serve --hostname --port`, `@opencode-ai/sdk` v2 client |

Driver kinds are declared at `apps/server/src/provider/Drivers/{Codex,Claude,Cursor,Grok,OpenCode,Antigravity}Driver.ts`
(`ProviderDriverKind.make(...)` at `CodexDriver.ts:76`, `ClaudeDriver.ts:66`, `CursorDriver.ts:61`,
`GrokDriver.ts:40`, `OpenCodeDriver.ts:62`, `AntigravityDriver.ts:64`) and registered in
`apps/server/src/provider/builtInDrivers.ts:49-56`.

**The single most important structural finding for a port:** T3 has *one* normalized event algebra
(`ProviderRuntimeEvent`, 49 event variants in `packages/contracts/src/providerRuntime.ts:1176-1226`)
and *one* adapter interface (`ProviderAdapterShape`, `apps/server/src/provider/Services/ProviderAdapter.ts:67-158`).
Everything provider-specific — process spawn, protocol, permission flags, approvals, model lists,
auth — lives behind that boundary. Orchestration, persistence and all three clients never branch on
provider kind. `docs/internals/providers.md:3-7` states this as a rule.

**Second finding:** only two of the six protocols use a vendor SDK
(`@anthropic-ai/claude-agent-sdk ^0.3.276`, `@opencode-ai/sdk ^1.3.15` — `apps/server/package.json:26,30`).
The other four are hand-built on `effect`'s process + stream primitives, with the schemas
**code-generated from upstream sources at pinned refs**. That generated protocol knowledge is the most
directly portable artifact in the repo.

---

## 1. The provider abstraction

### 1.1 Two SPIs: `ProviderDriver` (instances) and `ProviderAdapter` (protocol)

`apps/server/src/provider/ProviderDriver.ts` deliberately models drivers as **plain values, not Effect
services**, because a service tag is singleton-per-runtime and T3 needs many instances of one driver
(e.g. `codex_personal` + `codex_work`) — `ProviderDriver.ts:1-22`:

```ts
// ProviderDriver.ts:134-172
export interface ProviderDriver<Config, R = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
}
```

`create` materializes one `ProviderInstance` — an id, a driver kind, and **three captured closures**
(`ProviderDriver.ts:67-89`):

```ts
export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ServerProviderShape;              // status/models/auth probe
  readonly snapshotForCwd?: (cwd: string) => Effect.Effect<ServerProvider, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly consumeResetCredit?: () => Effect.Effect<ProviderConsumeResetCreditOutcome, ProviderDriverError>;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;   // the protocol
  readonly textGeneration: TextGeneration.TextGeneration["Service"]; // titles/commits/PRs
  readonly auth?: ProviderAuthController;              // GUI login, optional
}
```

`continuationIdentity` (`ProviderDriver.ts:91-104`) is the key that decides whether an existing thread
may be moved to a different instance. Default is `"<driverKind>:instance:<instanceId>"`; Claude
overrides it to `claude:home:<resolved CLAUDE_CONFIG_DIR>` (`ClaudeDriver.ts:256-259`, `ClaudeHome.ts:56-64`)
and Codex to a CODEX_HOME-derived key (`CodexDriver.ts:139`), so two accounts sharing a home can
continue each other's threads.

### 1.2 `ProviderAdapterShape` — the protocol contract every adapter implements

`apps/server/src/provider/Services/ProviderAdapter.ts:67-158`, verbatim:

```ts
export interface ProviderAdapterShape<TError> {
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  readonly startSession: (input: ProviderSessionStartInput) => Effect.Effect<ProviderSession, TError>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Effect.Effect<ProviderTurnStartResult, TError>;
  readonly compaction?: ProviderCompaction<TError>;
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;
  readonly respondToRequest: (
    threadId: ThreadId, requestId: ApprovalRequestId, decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;
  readonly respondToUserInput: (
    threadId: ThreadId, requestId: ApprovalRequestId, answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;
  readonly rollbackThread: (threadId: ThreadId, numTurns: number) => Effect.Effect<ProviderThreadSnapshot, TError>;
  readonly uploadFeedback?: (input: ProviderUploadFeedbackInput) => Effect.Effect<ProviderUploadFeedbackResult, TError>;
  readonly stopAll: () => Effect.Effect<void, TError>;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
```

Capability negotiation (`ProviderAdapter.ts:28-55`):

```ts
export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export type ProviderCompaction<TError> =
  | { readonly type: "native"; readonly start: (threadId, modelSelection?) => Effect.Effect<void, TError> }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  readonly promptlessTurnContinuation?: boolean;   // can resume with no synthetic prompt
  readonly supportsConversationRollback?: boolean; // false ⇒ revert is refused before touching files
}
```

Observed values: Claude `sessionModelSwitch:"in-session"` + `compaction:{type:"slash-command",command:"/compact"}`
(`ClaudeAdapter.ts:5570-5573`); OpenCode `"in-session"` (`OpenCodeAdapter.ts:4027-4029`) with native
compaction via `POST /session/{id}/summarize`; Codex native compaction via `thread/compact/start`
(`CodexSessionRuntime.ts:2499`); Antigravity `supportsConversationRollback:false`
(`docs/internals/providers.md:63-66` — "Antigravity can capture workspace checkpoints but cannot roll
back its conversation").

### 1.3 The turn/session input contracts

`packages/contracts/src/provider.ts:54-96`:

```ts
export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),   // opaque, adapter-owned
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  continuation: Schema.optional(Schema.Boolean),   // internal restart-recovery signal
  input: Schema.optional(TrimmedNonEmptyString.check(isMaxLength(120_000))),
  attachments: Schema.optional(Schema.Array(ChatAttachment).check(isMaxLength(8))),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),  // "default" | "plan"
});

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId, turnId: TurnId, resumeCursor: Schema.optional(Schema.Unknown),
});
```

`resumeCursor` is **`Schema.Unknown` on purpose** — each adapter defines its own shape and it is the only
thing persisted for resume. Examples: Codex `{threadId: string}` (`CodexSessionRuntime.ts:82-84`);
OpenCode `{schemaVersion:1, sessionId}` (`OpenCodeAdapter.ts:71-91`); Claude
`{threadId, resume: <uuid>, resumeSessionAt, turnCount, turnStartMessageIds[]}` (`ClaudeAdapter.ts:969-1012`);
ACP providers `{sessionId}`.

Approval/decision vocabulary (`packages/contracts/src/orchestration.ts:139-163`):

```ts
ProviderRequestKind      = "command" | "file-read" | "file-change" | "mcp-elicitation" | "permission"
ProviderApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
ProviderApprovalOption   = { decision, label, warning? }
ProviderUserInputAnswers = Record<string, unknown>
RuntimeMode              = "approval-required" | "auto-accept-edits" | "auto" | "full-access"  (default "full-access")
ProviderInteractionMode  = "default" | "plan"
ProviderApprovalPolicy   = "untrusted" | "on-failure" | "on-request" | "never"
ProviderSandboxMode      = "read-only" | "workspace-write" | "danger-full-access"
```

Note `ProviderApprovalOption.warning` — "Provider-supplied caution shown next to the option, such as a
prompt injection warning" (`orchestration.ts:157-158`). `docs/internals/providers.md:68-69`: "Native
permission and question option IDs must also survive normalization; a display label is not necessarily
a valid reply."

### 1.4 The normalized event algebra

One discriminated union, `ProviderRuntimeEvent` = `ProviderRuntimeEventV2`
(`packages/contracts/src/providerRuntime.ts:1176-1229`). Shared base (`:195-215`):

```ts
{ eventId, provider, providerInstanceId?, threadId, createdAt,
  turnId?, itemId?, requestId?,
  providerRefs?: { providerTurnId?, providerItemId?, providerRequestId? },
  raw?: { source, method?, messageType?, payload } }
```

`raw.source` is a closed enum naming the native protocol (`providerRuntime.ts:23-33`) — this is what
makes the NDJSON debug log replayable:

```ts
"codex.app-server.notification" | "codex.app-server.request" | "codex.eventmsg"
| "claude.sdk.message" | "claude.sdk.permission" | "codex.sdk.thread-event"
| "opencode.sdk.event" | "acp.jsonrpc" | `acp.${string}.extension`
```

The 49 event types, grouped:

- **session**: `session.started`, `session.configured`, `session.state.changed`, `session.exited`
- **thread**: `thread.started`, `thread.state.changed`, `thread.metadata.updated`,
  `thread.token-usage.updated`, plus five `thread.realtime.*` (Codex voice)
- **turn**: `turn.started`, `turn.completed`, `turn.aborted`, `turn.plan.updated`,
  `turn.proposed.delta`, `turn.proposed.completed` (plan-mode markdown), `turn.diff.updated`
- **items**: `item.started` / `item.updated` / `item.completed` with `ItemLifecyclePayload`
- **content**: `content.delta` with `streamKind ∈ {assistant_text, reasoning_text,
  reasoning_summary_text, plan_text, command_output, file_change_output, unknown}`
- **approvals/questions**: `request.opened`, `request.resolved`, `user-input.requested`,
  `user-input.resolved`
- **subagents/background**: `task.started` / `task.progress` / `task.updated` / `task.completed`
- **hooks**: `hook.started` / `hook.progress` / `hook.completed`
- **tools**: `tool.progress`, `tool.summary`, `tool.denied`
- **account**: `auth.status`, `account.updated`, `account.rate-limits.updated`
- **misc**: `mcp.status.updated`, `mcp.oauth.completed`, `model.rerouted`, `config.warning`,
  `deprecation.notice`, `files.persisted`, `runtime.warning`, `runtime.error`

Canonical item types (`providerRuntime.ts:106-132`) — the vocabulary every adapter must map its tools
onto:

```ts
"user_message" | "assistant_message" | "reasoning" | "plan"
| "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call"
| "collab_agent_tool_call" | "web_search" | "image_view"
| "review_entered" | "review_exited" | "context_compaction" | "error" | "unknown"
```

Canonical request types (`:134-148`):

```ts
"command_execution_approval" | "file_read_approval" | "file_change_approval"
| "apply_patch_approval" | "exec_command_approval" | "mcp_elicitation_approval"
| "permission_approval" | "tool_user_input" | "dynamic_tool_call"
| "auth_tokens_refresh" | "unknown"
```

Structured user questions (`:475-494`) — the shape every provider's "ask the user" maps to:

```ts
UserInputQuestion = { id, header, question, options: [{label, description, value?}],
                      allowCustomAnswer?, multiSelect? }
UserInputRequestedPayload = { questions: UserInputQuestion[], responseMode?: "message" }
```

`responseMode:"message"` is the **async-question discriminator** (see §2.2.5).

### 1.5 `ProviderService` — the cross-provider facade

`apps/server/src/provider/Layers/ProviderService.ts` (2431 lines) is what transports call.
Interface at `Services/ProviderService.ts:40-…`. It:

- resolves an instance → adapter via `ProviderAdapterRegistry.getByInstance`
  (`Services/ProviderAdapterRegistry.ts:31-60`),
- validates the workspace directory exists **before** calling the adapter, so a moved folder does not
  surface as a misleading "failed to spawn <binary>" (`ProviderService.ts:1507-1520`),
- mints/revokes the per-thread MCP credential around session start/stop
  (`prepareMcpSession` / `clearMcpSession`, `:943-963`),
- rewrites attachments into on-disk paths inside the prompt text before handing the turn to the adapter
  (`:1594-1640`),
- persists a `ProviderRuntimeBinding` after every turn (`:1751-1764`),
- republishes every adapter's `streamEvents` on one PubSub, tapping the canonical NDJSON logger
  (`publishRuntimeEvent`, `:965-975`),
- records analytics and OTel spans per turn.

Attachments policy (`ProviderService.ts:1594-1640`): *every* attachment gets an on-disk path injected
into the prompt **and** is forwarded to the adapter, which decides its native format. Pasted text gets
a distinct phrasing. `docs/internals/providers.md:88-92`: "A path in the prompt does not grant
filesystem access. Keep provider sandbox and approval rules in force."

---

## 2. Per provider

### 2.1 Claude Code (`claudeAgent`)

**The headline: T3 does not build a `claude` argv for agent sessions.** It links
`@anthropic-ai/claude-agent-sdk` (pinned `^0.3.276`, `apps/server/package.json:26`) and calls
`query({ prompt, options })`. The SDK spawns the CLI in
`--input-format stream-json --output-format stream-json` mode and owns the argv. T3's protocol knowledge
lives in (a) the `Options` object, (b) the `SDKUserMessage` JSON pushed onto the prompt async-iterable,
and (c) an exhaustive `SDKMessage` demux.

**Binary resolution** (`Drivers/ClaudeExecutable.ts:61-90`): default `"claude"`
(`packages/contracts/src/settings.ts:627`), `~`-expanded (`ClaudeDriver.ts:126`). POSIX passes it
through verbatim; Windows resolves against PATH/PATHEXT and follows `.cmd/.bat/.ps1` npm shims to the
real entry (`ClaudeExecutable.ts:23-26`), because "the SDK spawns the given path without a shell and
without Windows PATH/PATHEXT resolution… the SDK offers no such escape hatch" (`:46-59`).

**Env** (`Drivers/ClaudeHome.ts:36-54`) — exactly one variable, and `HOME` is deliberately *not*
overridden:

```ts
return { ...resolvedBaseEnv, CLAUDE_CONFIG_DIR: resolvedHomePath };
// "Overriding HOME also relocates the macOS login keychain lookup
//  ($HOME/Library/Keychains), so the spawned CLI can't find its stored
//  OAuth credentials and reports 'Not logged in'."   (ClaudeHome.ts:46-51)
```

**The full session options object** (`Layers/ClaudeAdapter.ts:4913-4966`):

```ts
const queryOptions: ClaudeQueryOptions = {
  ...(input.cwd ? { cwd: input.cwd } : {}),
  ...(apiModelId ? { model: apiModelId } : {}),
  pathToClaudeCodeExecutable: claudeBinaryPath,
  systemPrompt: { type: "preset", preset: "claude_code",
                  append: buildRuntimeInstructions({ harness: "Claude Code" }) },
  settingSources: ["user", "project", "local"],           // ClaudeAdapter.ts:1545-1549
  ...(effectiveEffort ? { effort: effectiveEffort } : {}),
  ...(thinkingDisplay === "summarized" ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
  ...(permissionMode ? { permissionMode } : {}),
  ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
  ...(Object.keys(settings).length > 0 ? { settings } : {}),   // → CLI --settings <json>
  ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
  ...(newSessionId ? { sessionId: newSessionId } : {}),
  includePartialMessages: true,
  canUseTool, onUserDialog, supportedDialogKinds: ["resume_return"],
  env: McpProviderSession.withAgentDeviceEnvironment(claudeEnvironment, mcpSession),
  additionalDirectories,                                   // cwd + attachments dir
  ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
  ...(mcpSession ? { mcpServers: { "t3-code": { type: "http", url: mcpSession.endpoint,
        headers: { Authorization: mcpSession.authorizationHeader } } } } : {}),
};
```

`additionalDirectories` = `[cwd, serverConfig.attachmentsDir]` (`:4909-4912`) — the attachments grant is
what lets the agent `Read` a pasted image without an approval prompt. `buildRuntimeInstructions`
(`provider/RuntimeInstructions.ts:7-19`) appends a `<runtime_info>` block plus a
`<pull_request_linking>` directive pointing at the `t3-code` MCP server.

The argv the SDK derives from these is pinned against a **real fake-CLI subprocess** in
`Layers/ClaudeCapabilitiesProbe.test.ts:175-186`: `--strict-mcp-config`,
`--setting-sources=user,project,local`, `--settings <json>`, `--mcp-config <path-or-json>` (absent when
`mcpServers` is `{}`). User launch args round-trip through `extraArgs`
(`{verbose: null, "thinking-display": "summarized"}` → `--verbose --thinking-display summarized`,
`ClaudeAdapter.test.ts:500-503`).

**Process lifetime:** one CLI process per **session = per thread**, long-lived across turns
(`sessions: Map<ThreadId, ClaudeSessionContext>`, `ClaudeAdapter.ts:2108`, `5063`; one stream fiber at
`:5109-5126`). Turns are just messages pushed into the persistent stdin queue.

**stdin wire** (`ClaudeAdapter.ts:1568-1580`, queue at `:4428-4436`) — one NDJSON line per turn:

```ts
{ type: "user", session_id: "", parent_tool_use_id: null,
  message: { role: "user", content: sdkContent },
  uuid: <turnId> }   // only for a fresh (non-steering) turn, :5276
```

Content block order is load-bearing (`:1608-1675`): optional leading text, then base64 image blocks
(`{type:"image", source:{type:"base64", media_type, data}}`, `:1582-1594`; gif/jpeg/png/webp only,
`:1539-1544`), then the **final** text block last — "the Claude CLI only reads a streamed user message
as a slash-command invocation when the last content block is text" (`:1666-1670`).

**stdout demux** (`ClaudeAdapter.ts:4145-4198`), abridged:

| SDK message | → normalized |
|---|---|
| `stream_event/content_block_delta/text_delta` | `content.delta{assistant_text}` (`:2912-2964`) |
| `…/thinking_delta` | `content.delta{reasoning_summary_text}` — never `reasoning_text`, "Claude never returns the raw chain of thought" (`:1725-1731`) |
| `…/input_json_delta` | `item.updated` (re-parses partial JSON, fingerprint-deduped); `turn.plan.updated` for `TodoWrite` (`:2967-3066`) |
| `content_block_start` (tool_use/server_tool_use/mcp_tool_use) | `item.started`, type from `classifyToolItemType` (`:1027-1075`) |
| `assistant` | backfill text/thinking; `ExitPlanMode` → `turn.proposed.completed` (`:3333-3481`) |
| `user` (tool results) | `item.updated` → `content.delta{command_output|file_change_output}` → `item.completed` (`:3170-3331`) |
| `result` | `thread.token-usage.updated` + `turn.completed` (`:3483-3504`, `completeTurn` `:2660-2853`) |
| `system/init` \| `status` \| `compact_boundary` | `session.configured` \| `session.state.changed` \| `thread.state.changed{compacted, beforeTokens, afterTokens}` (`:3620-3669`) |
| `system/hook_*` | `hook.started/progress/completed` (`:3670-3706`) |
| `system/task_*` | `task.started/progress/updated/completed` (`:3707-3873`) |
| `rate_limit_event` | `account.rate-limits.updated` (+ `runtime.warning` when blocking) (`:4081-4142`) |
| unknown | `message satisfies never` typecheck guard + runtime `runtime.warning` (`:3997-4011`) |

**Interrupt is a hard session kill, not a control interrupt** (`ClaudeAdapter.ts:5289-5297`):

```ts
// interrupt() can acknowledge while resumed background tasks keep the
// CLI alive. Stop is a hard session boundary for Claude, so close the
// query and let the SDK escalate to SIGKILL when graceful exit fails.
yield* stopSessionInternal(context);
```

**Approvals** go through the SDK `canUseTool` callback (the `can_use_tool` control request), **not**
`--permission-prompt-tool`. `canUseToolEffect` (`:4663-4824`) returns `{behavior:"allow", updatedInput}` /
`{behavior:"deny", message}`; round trip is `request.opened` → `Deferred.await` → `respondToRequest`
(`:5488-5503`) → `request.resolved`. `"acceptForSession"` returns Claude's own `updatedPermissions`
rescoped to `destination:"session"` (they usually target `.claude/settings.local.json`); with no
suggestion (common for MCP tools) it synthesizes
`[{type:"addRules", rules:[{toolName}], behavior:"allow", destination:"session"}]` (`:312-331`).

**`AskUserQuestion`** is intercepted before any approval logic (`:4679-4681`) and surfaced as
`user-input.requested`. Critical wire detail: the question `id` **must be the full question text** —
"Claude SDK >= 2.1.121 looks up answers by question text in `mapToolResultToToolResultBlockParam`"
(`:4463-4467`). Reply: `{behavior:"allow", updatedInput:{questions:<original>, answers:{<questionText>:<label>}}}`
(`:4584-4590`).

**`ExitPlanMode` is always denied on purpose**, after capturing the plan (`:4683-4703`) — the denial
message tells the model to stop and wait for user feedback.

**Model switch mid-session**: `context.query.setModel(apiModelId)` (`:5164-5172`). **Plan toggling**:
`setPermissionMode("plan")` per turn, restoring `basePermissionMode ?? "default"` (`:5191-5201`).

**Resume**: with a cursor UUID → `resume`; otherwise T3 **generates** a v4 UUID and passes `sessionId`
(`:4421-4422`, `:4944-4945`). `--continue` and `--fork-session` are never used. Cursor is validated as a
strict UUID (`:482-484`).

**On-disk history — two separate subsystems:**

1. **`claudeHistoryWorker`** (`apps/server/src/claudeHistoryWorker.ts`, entry
   `apps/server/src/claude-history-worker.ts`, CLI subcommand `apps/server/src/cli/claudeHistory.ts`) is a
   **7-line shim around the Agent SDK's `getSessionMessages` / `forkSession`** — it does *not* parse
   JSONL. It exists only because those helpers read `process.env`, so when `CLAUDE_CONFIG_DIR` differs
   from the server's own, T3 runs them in a subprocess rather than mutating the server env while other
   providers are running (`ClaudeAdapter.ts:5339-5375`):

   ```ts
   ChildProcess.make(process.execPath,
     [...historyWorkerArguments, method, historySessionId, encodeHistoryArgs(args)],
     { env: { ...claudeEnvironment, ELECTRON_RUN_AS_NODE: "1" } })
   // historyWorkerArguments = ["__claude-history"] inside the single-executable, else the .mjs path
   ```

   It is used only by `rollbackThread` (`:5306-5486`): read history → find human-turn starts
   (`isClaudeHumanTurnStart`, `:149-165`) → `forkSession(sessionId, {dir, upToMessageId})` → **re-read the
   fork and re-align boundaries** because "native forks rewrite every UUID"
   (`remapClaudeForkTurnBoundaries`, `:180-225`).

2. **`AgentSessionScanner.ts`** is the `~/.claude/projects/*/*.jsonl` scanner, used for
   **onboarding/import**, not resume. `discoverClaudeTranscripts` (`:924-974`) lists them newest-first,
   capped at `MAX_TRANSCRIPTS_PER_SOURCE = 5000` (`:73`); per record it skips
   `isSidechain|isMeta|isCompactSummary` and takes `sessionId`, `aiTitle`, `message.model` (ignoring the
   `"<synthetic>"` sentinel) and `cwd` (`:398-424`). An imported session *is* resumable —
   `AgentSessionImporter.ts:233-236` writes `resumeCursor:{threadId, resume: providerSessionId}` — but only
   if the session id is a real UUID (`:32-33, 176-184`).

**Models** come from the versioned manifest, not the CLI (`ClaudeModelCatalog.ts:63-70`); each entry
carries a `claudeCode` runtime profile (`effortMap`, `modelSuffixes`, context windows —
`ClaudeModelManifest.ts:6-18`) and a `minVersion`/`maxVersionExclusive` range (`:32-45`) filtered against
`claude --version` (`ClaudeProvider.ts:458-462`).

**Auth detection is the SDK init handshake**, not `claude auth status`: `probeClaudeCapabilities`
(`ClaudeProvider.ts:331-401`) starts a query whose prompt async-generator **never yields** — "the Claude
Code subprocess completes its local initialization IPC… but never starts an API request to Anthropic"
(`:318-330`) — awaits `initializationResult()` (25 s), then `usage_EXPERIMENTAL_…()`, then aborts.
Cached per instance, TTL 5 min, keyed `binaryPath\0resolvedHome\0cwd` (`ClaudeDriver.ts:67,169-181`).

**There is no in-GUI login for Claude.** On `authentication_failed` the adapter emits instructions to
run the CLI manually (`ClaudeHome.ts:81-90`, triggered from `ClaudeAdapter.ts:3458-3463`).

**Skills** (`Drivers/ClaudeSkills.ts:308-384`): scan `<configDir>/skills` then `<cwd>/.claude/skills`;
**first root wins**, identity is the **directory name, not frontmatter `name`** (verified against the
CLI, `:344-351`); `.agents/skills` is explicitly not scanned (`:8-11`). Re-scanned on every `sendTurn`
(`ClaudeAdapter.ts:5245-5257`). Dispatch (`ClaudeSkillDispatch.ts:49-80`): Claude Code only expands a
`/name` that is the **first character of the last text block**, so the prompt is split into
`[leadingText, "/name <trailing>"]`.

**Subagents** are reconstructed entirely from `parent_tool_use_id` correlation
(`ClaudeAdapter.ts:3750-3762`, `:1337-1350`); subagent narration is dropped from the parent transcript
while tool blocks are kept (`:2865-2889`).

**Usage limits** (`Layers/claudeUsageLimits.ts`): two sources unified onto the same window ids — the
`get_usage` control request (percentages 0-100, ISO `resets_at`, `:157-190`) and the streamed
`rate_limit_event` (`utilization` is a **0-1 fraction**, `resetsAt` is **epoch seconds**, `:103-107,142`).
Model-scoped weeklies are read *structurally* from `rate_limits.model_scoped[]` because they shipped
after the pinned typings (`:86-101`).

**Quirks worth carrying:** interrupt mid-tool yields `terminal_reason:"aborted_tools"` with an internal
`[ede_diagnostic]` error that must never become the user-facing banner (`:1595-1618, 1706-1714`);
repeated 529 overloads arrive as a **success** result with `api_error_status:529` (`:1684-1687`);
`system` messages with subtype `hook_*` carry no durable `session_id` and must not update the resume
cursor (`:490-500`); a `result` with no active turn deliberately emits **no** `turn.completed`
(`:2747-2766`); a `sendTurn` during a live turn is a **steer** (same turnId, `:5153-5162`); a
usage-limited turn parks inside the SDK with no further messages, so the thread keeps showing "working"
(`docs/user/providers-claude.md:56-62`).

### 2.2 Codex (`codex`)

**Argv is always `codex app-server`.** `codex mcp` is never used; `codex exec` only for text generation.

```ts
// Layers/codexLaunchArgs.ts:12-15
export const codexAppServerArgs = (launchArgs?: string) => ["app-server", ...codexLaunchArgv(launchArgs)];
```

**Spawn** (`Layers/CodexSessionRuntime.ts:1313-1346`):

```ts
const env = { ...options.environment, ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}) };
const appServerArgs = codexSessionAppServerArgs(options.appServerArgs, options.launchArgs);
spawner.spawn(ChildProcess.make(cmd, args, {
  cwd: options.cwd, env, extendEnv,
  forceKillAfter: "2 seconds",        // CODEX_APP_SERVER_FORCE_KILL_AFTER, :58
  shell: spawnCommand.shell,
}))
```

`~` in `CODEX_HOME` must be expanded manually — `child_process.spawn` does not shell-expand env values,
and codex errors with "CODEX_HOME points to '~/.codex_work', but that path does not exist"
(`CodexProvider.ts:369-372`).

**One process per thread** (`makeCodexSessionRuntime` per `startSession`; `sessions: Map<ThreadId, …>` at
`CodexAdapter.ts:2252`), **plus** short-lived one-shot processes per probe/account action
(`withCodexAppServerClient`, `CodexProvider.ts:362-410`).

**Multi-account CODEX_HOME overlay** (`Drivers/CodexHomeLayout.ts:445-467`): `mode: "direct" | "authOverlay"`.
In overlay mode `CODEX_HOME` points at `shadowHomePath`, where everything except `auth.json` and
`models_cache.json` (`:433`) is symlinked into the shared home (`sessions`, `archived_sessions`, `sqlite`,
`shell_snapshots`, `worktrees`, `skills`, `plugins`, `cache`, `logs`, `mcp-oauth-locks`, `:420-431`) — so
two accounts share rollouts but have separate logins. `auth.json` must be a real file, never a symlink
(`:696-719`).

**Handshake** (every process):

```ts
// CodexProvider.ts:343-354 / :407-408
client.request("initialize", { clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop",
                                             version: packageJson.version },
                               capabilities: { experimentalApi: true } });
client.notify("initialized", undefined);
// CLI version parsed out of the result: initialize.userAgent.match(/\/([^\s]+)/)  (:423-424)
```

**Methods actually used** (of ~120 in the generated catalog): `initialize`, `account/read`, `skills/list`,
`model/list` (paginated), `account/rateLimits/read`, `account/rateLimitResetCredit/consume`,
`thread/start`, `thread/resume` (raw), `turn/start` (raw), `turn/interrupt`, `thread/compact/start`,
`thread/read`, `thread/turns/list` (raw, **not in generated meta**), `thread/rollback`, `thread/revert`
(raw), `feedback/upload`, `config/mcpServer/reload`. The only client notification is `initialized`
(`meta.gen.ts:101-103`). Notably **unused**: the pre-v2 `newConversation`/`sendUserTurn`/
`interruptConversation`/`execApproval`/`applyPatchApproval`/`loginChatGpt`/`listConversations`/
`resumeConversation`/`setDefaultModel`.

Turn params (`CodexSessionRuntime.ts:649-658`):

```ts
{ threadId, input: turnInput, approvalPolicy, approvalsReviewer,
  sandboxPolicy: runtimeModeToTurnSandboxPolicy(runtimeMode),
  model?, serviceTier?, effort?, collaborationMode? }
```

`turnInput` items are `{type:"text", text}` plus `{type:"localImage", path}` — **images by path, never
base64** (`CodexAdapter.ts:2518-2522`). `collaborationMode` carries the plan-mode settings and T3's own
`developer_instructions` block (`CodexDeveloperInstructions.ts`), and is **not in the pinned schema** —
bolted on with `Schema.fieldsAssign` and an explicit TODO (`CodexSessionRuntime.ts:143-152`).

**Notification handling** (`CodexSessionRuntime.ts:2352-2370`): every generated server-notification method
is registered generically into one queue. Four additionally mutate session state: `thread/started`,
`turn/started`, `turn/completed`, `error`. Mapping table (`CodexAdapter.ts:1304-2223`):
`item/agentMessage/delta` → `content.delta{assistant_text}`; `item/reasoning/textDelta` →
`{reasoning_text}`; `item/reasoning/summaryTextDelta` → `{reasoning_summary_text}`;
`item/commandExecution/outputDelta` → `{command_output}`; `item/fileChange/outputDelta` →
`{file_change_output}`; `item/plan/delta` → `turn.proposed.delta`; `item/started|completed` →
`item.*` with `toCanonicalItemType` (`:644-663`, fuzzy substring match on a de-camel-cased type string);
`turn/diff/updated` → `turn.diff.updated{unifiedDiff}`; `thread/tokenUsage/updated` →
`thread.token-usage.updated`. Web search and MCP tool calls are *items*, not dedicated notifications.

**Token counting**: `thread/tokenUsage/updated` carries *cumulative* thread totals, so the adapter diffs
per turn (`CodexAdapter.ts:538-617`) and stamps the result on `turn.completed`/`turn.aborted`
(`:2417-2444`).

**Approvals are inbound JSON-RPC requests answered by returning a result** — never a new client request
(`CodexSessionRuntime.ts:2056-2346`): `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `mcpServer/elicitation/request`, `item/permissions/requestApproval`,
`item/tool/requestUserInput`. Anything else → `-32601` (`:2348-2350`). The GUI answers by resolving the
parked `Deferred` (`:2628-2656`). `acceptAlways` is downgraded to `acceptForSession` on command/file
approvals — Codex has no permanent grant there (`:2107, 2165`).

> **Deadlock hazard, documented and handled:** the transport answers server requests inline on the stdin
> read loop, so an open approval card blocks *all* inbound traffic including the `turn/interrupt`
> response. `interruptTurn` therefore settles every parked approval **before** sending `turn/interrupt`
> (`CodexSessionRuntime.ts:2561-2603`, comment at `:2565-2571`).

**Async questions** (`docs/internals/providers.md:52-60`) arrive as a *notification*, on `item/completed`
when the agent message declares `delivery:"async"` with `questions[]` (`CodexAdapter.ts:1691-1710`):

```ts
type: "user-input.requested",
requestId: `codex-async:${threadId}:${item.id}`,
payload: { responseMode: "message", questions: item.questions.map((q,i) => ({
  id: String(i), header: "Question", question: q.title,
  options: (q.options ?? []).map((label) => ({label, description: ""})),
  allowCustomAnswer: true, multiSelect: false })) }
```

`responseMode:"message"` is the discriminator; the decider then commits `user-input.resolved` **and** a
`thread.turn.start` carrying the answers as a new user message, atomically
(`apps/server/src/orchestration/decider.ts:1633-1700`). Only `responseMode === "message"` questions may be
dismissed unanswered (`decider.ts:1769-1793`). `delivery`/`questions` are not in the pinned upstream
schema — patched in by the generator (`generate.ts:681-729`).

**Resume**: the cursor is just `{threadId}`; `~/.codex/sessions/*.jsonl` rollouts are never read. With a
cursor → **raw** `thread/resume {threadId, ...startParams, excludeTurns:true}` (raw because older servers
return history that would fail strict decoding, `:744-752`); a failure matching
`not found|missing thread|no such thread|unknown thread|does not exist|no rollout found` (`:59-66`)
**silently falls back to `thread/start`** (`:765-773`).

**Interrupt** (`:2561-2603`): settle approvals → settle user inputs → interrupt each live *child* turn
(concurrency 8, 3 s each, 10 s overall, all ignored) → `turn/interrupt {threadId, turnId}` for the parent.

**Multi-agent (collab) children** are full app-server threads on the *same* connection
(`interceptCollabChildNotification`, `:1560-1861`), re-emitted as synthetic `collabAgent/*` events mapped
to `task.*` (`CodexAdapter.ts:1048-1303`). The routing table is pinned against a real wire capture
(`testFixtures/codexMultiAgentWire.json`, codex-cli 0.145.0) in `CodexCollabWire.test.ts`.

**Auth**: detection via `account/read` → `{account, requiresOpenaiAuth}` (`CodexProvider.ts:426, 532-559`).
**Login is not performed from the GUI** — no call to `account/login/start|cancel` or `account/logout`
anywhere; the documented flow is `CODEX_HOME=~/.codex_personal codex login`
(`docs/user/providers-codex.md:16-19`).

**Usage** (`Layers/codexUsageLimits.ts`): `primary`/`secondary` are *positions, not durations* (`:65-69`);
duration comes from `windowDurationMins`. Only `limitId === "codex"` is shown (`:75`). `resetsAt` is epoch
**seconds** (`:49-53`). Updates are *partial* and merged field-by-field (`:168-186`).

**Quirks:** two history modes, legacy (`thread/read {includeTurns:true}`) vs paginated
(`thread/turns/list` cursor loop + `thread/revert {beforeTurnId}`) (`:1215-1288`); Codex emits
`subAgentActivity {agentPath:"/root"}` *about the root thread*, and registering it as its own child made
threads hang "working" forever (`:1622-1636`); unknown child methods default to "pass to parent", not
"drop", because two shipped bugs came from a catch-all (`:1080-1131`); two known-benign stderr `ERROR`
lines are filtered (`:54-57`); `reason` on approval params is "sent only sometimes, and sent blank rather
than absent often enough to matter" (`CodexAdapter.ts:795-800`).

### 2.3 OpenCode (`opencode`)

**HTTP + SSE, not stdio.** Everything goes through `@opencode-ai/sdk/v2`'s `createOpencodeClient` — a thin
`hey-api` wrapper over `fetch` — so a plain-Node port needs only `fetch` and an SSE reader.

**Serve argv** (`provider/opencodeRuntime.ts:688`):

```ts
const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
// hostname defaults 127.0.0.1 (:83, :674); port from netService.findAvailablePort(0) (:676-686)
```

**Env** (`:696-714`): `OPENCODE_SERVER_PASSWORD` when set, plus `OPENCODE_CONFIG_CONTENT` which falls back
to `"{}"` **only** if neither caller env nor `process.env` set it — setting it unconditionally used to
clobber the user's config and hide providers/models (`:704-711`). `detached: true` on POSIX.

**`cwd` is not a spawn option** — the working directory travels per-request as the client-level
`directory`, which becomes header `x-opencode-directory` (rewritten to `?directory=` for GET/HEAD).

**Readiness**: scan stdout for `"opencode server listening"` and extract the URL via `/on\s+(https?:\/\/[^\s]+)/`
(`:81, 290-299, 751-772`), 30 s timeout; then `GET /global/health` must return `{healthy:true, version}`
with semver ≥ **1.14.19** within 5 s (`:42-49, 143-179`). After ready both pipes keep draining but output
is discarded — "Stopping the readers can block OpenCode when its output buffers fill" (`:837-841`).
Teardown kills the whole process group: `process.kill(-pid, SIGTERM)` → 1 s → `SIGKILL` (`:728-745`).

**Process-per-what:**
- **Chat: one server per thread** (`OpenCodeAdapter.ts:2846-2863`). Reason
  (`docs/internals/providers.md:13-15`): "Its MCP registrations are directory-scoped, while T3's MCP
  connection is thread-scoped. Sharing a chat server between threads in one directory would let them
  replace each other's connection."
- **Catalog + text generation: one instance-owned helper**, ref-counted, closed 30 s after the last
  borrower (`OpenCodeServerOwner.ts:11, 85-155`).
- **External server** (`serverUrl` set): no spawn, just health-verify.

**Endpoints used**: `/global/health`, `/provider`, `/agent`, `/skill`, `/command`, `/event` (SSE),
`/session` (POST), `/session/{id}` (GET/PATCH), `/session/{id}/children`, `/session/status`,
`/session/{id}/message`, `/session/{id}/message/{msgId}`, `/session/{id}/prompt_async`,
`/session/{id}/command`, `/session/{id}/fork`, `/session/{id}/abort`, `/session/{id}/summarize`,
`/permission`, `/permission/{id}/reply`, `/question`, `/question/{id}/reply`, `/mcp`.
`/config`, `/config/providers`, `/find`, `/file` are **not** used — models come from `/provider`.

**Turn start** (`OpenCodeAdapter.ts:3274-3291`):

```ts
client.session.promptAsync({
  sessionID: context.openCodeSessionId,
  messageID: messageId,          // T3-minted, msg_<48-bit time><14 random>, :996-1026
  model: { providerID, modelID },
  ...(context.activeAgent ? { agent: context.activeAgent } : {}),   // "plan" in plan mode, :3207
  ...(context.activeVariant ? { variant: context.activeVariant } : {}),
  system: buildRuntimeInstructions({ harness: "OpenCode", model: `${providerID}/${modelID}` }),
  parts: [...(text ? [{ type: "text", text }] : []), ...fileParts],
}, { signal })   // wrapped in Effect.timeout("10 seconds")
```

Attachments (`opencodeRuntime.ts:475-506`): PNG/JPEG/GIF/WebP, `text/*`, `application/pdf`, ≤ 20 MB
become `{type:"file", mime, filename, url: pathToFileURL(path).href}`; everything else rides as a path in
the prompt text.

**Completion detection is the hard part.** `promptAsync` returns immediately; the turn ends on
`session.status` `idle` for the active turn (`:2622-2642` → `completeOpenCodeTurn` `:1112-1168`). Because
idle can race the prompt, there is a **prompt-admission state machine** (`:215-235, 1342-1503`): an idle
seen before the user message is confirmed schedules a reconciliation that polls `GET /session/status`
(1 s timeout, 1 retry, 250 ms→5 s backoff) and only completes the turn when the map says idle
(`:1170-1275`). After 5 failed rounds the turn fails with "OpenCode accepted the prompt, but T3 Code
could not confirm its message or session status." (`:1288`).

**Text parts are snapshots, not deltas**, and OpenCode permits edits to completed parts; T3 keeps
`emittedText` per part and emits only the changed suffix, treating a shrinking snapshot as stale
(`:604-656, 1616-1665`).

**Permissions** are pushed as a `PermissionRuleset` at session create/update
(`opencodeRuntime.ts:508-544`, quoted in §6). Ask arrives as `permission.asked` and becomes
`request.opened` with three options (`:1757-1774`):

```ts
[ { decision: "accept",           label: "Allow once" },
  { decision: "acceptForSession", label: "Allow for workspace",
    warning: "Applies to matching requests in other OpenCode sessions in this workspace." },
  { decision: "decline",          label: "Deny" } ]
```

Reply is `POST /permission/{requestID}/reply {reply}` with `accept→once`,
`acceptForSession|acceptAlways→always`, `decline|cancel→reject` (`:546-560`). **Full-access auto-reply
uses `once`, not `always`** (`OpenCodeAdapter.ts:1777-1804`):

> "two upstream paths never consult the session ruleset we send: doom-loop detection … and subagent
> sessions… Reply "once", not "always": OpenCode stores "always" grants per directory, so on a shared
> external server an "always" from a full-access thread would silently widen what a supervised thread on
> the same directory is allowed to do."

**Interrupt** (`:3603-3741`): interrupt the in-flight prompt fiber → `POST /session/{id}/abort` (10 s)
raced against a `session.error` with `name === "MessageAbortedError"` → walk `GET /session/{id}/children`
and abort each (concurrency 8, cycle-guarded).

**Resume**: cursor `{schemaVersion:1, sessionId}`; `GET /session/{id}`; a **confirmed 404 only** starts
fresh — `isOpenCodeNotFound` walks `cause/body/error/data` ≤32 nodes and an explicit non-404 status seals
its subtree (`:104-142`, citing upstream issue #3604 silent context loss). If the session exists under a
different cwd it is **forked** into the new directory rather than recreated (`:2926-2947`).

**`rollbackThread` deliberately does not use `/revert`** (`:3914-4008`): "Native revert also rewrites
workspace files. Fork only the retained conversation so T3 alone decides whether filesystem changes
survive."

**Auth**: there is **no** `opencode auth list` call. Login state is inferred from
`providerList.connected.length > 0` (`OpenCodeProvider.ts:543-567`). Usage limits are OpenCode-Go-only and
local-only: read `$XDG_DATA_HOME/opencode/auth.json` → `["opencode-go"].key` → bearer
`GET https://opencode.ai/zen/go/v1/usage` (`openCodeUsageLimits.ts:31-108`).

**CLI fallback** for the catalog (`opencodeRuntime.ts:962-1060`) runs `opencode models --verbose`,
`opencode agent list`, `opencode debug skill` **sequentially**, because "Every OpenCode CLI command opens
the same shared SQLite database… causes 'database is locked' failures" (`:987-988`). The live path prefers
`app.skills` over `opencode debug skill` because the Bun-compiled binary doesn't flush past one 64 KB pipe
buffer to a non-TTY stdout, truncating the JSON (`OpenCodeDriver.ts:171-178`).

### 2.4 The three ACP providers — shared engine

Cursor, Grok and Antigravity all run on one engine:
`apps/server/src/provider/acp/AcpSessionRuntime.ts` (1342 lines, JSON-RPC over the child's stdio via
`effect-acp`) + `AcpRuntimeModel.ts` (session/update → normalized events) + `AcpCoreRuntimeEvents.ts`
(normalized → `ProviderRuntimeEvent`). Per-provider files supply only: argv/env, an `authMethodId`,
client capabilities, vendor extension handlers, and a few normalizers.

**Spawn** (`AcpSessionRuntime.ts:458-480`): `resolveSpawnCommand(command, args, {env, extendEnv})` then
`ChildProcess.make(cmd, args, {cwd, env, extendEnv: opts.extendEnv ?? true, shell})`. stderr is drained
separately and kept as a 4 KiB redacted tail (`AcpStderr.ts:5,14-37` — masks the home dir, `…/pair#…`
URLs, `Bearer`, `x-api-key`, `sk-*`/`ghp_*`/`xox*`) that is folded onto `AcpProcessExitedError`
(`:380-400`). **One child process = one ACP session = one T3 thread**, for all three.

**Handshake** (`AcpSessionRuntime.ts:596-608, 726-748`):

```ts
const initializeClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false, ...options.clientCapabilities?.fs },
  terminal: options.clientCapabilities?.terminal ?? false,
  ...(auth ? {auth} : {}), ...(elicitation ? {elicitation} : {}), ...(_meta ? {_meta} : {}),
};
const initializePayload = { protocolVersion: 1, clientCapabilities: initializeClientCapabilities,
                            clientInfo: options.clientInfo };  // {name:"t3-code", version:"0.0.0"}
// then unconditionally:
runLoggedRequest("authenticate", { methodId: options.authMethodId }, …);
```

**Session setup — three branches** (`:755-880`):

- `session/resume {sessionId, cwd, mcpServers, additionalDirectories?}` — only when
  `initializeResult.agentCapabilities.sessionCapabilities.resume` (`:756-762`); 90 s timeout. Antigravity.
- `session/load {sessionId, cwd, mcpServers}` — races the RPC against a **replay-idle detector**
  (`:822-828`, `AcpRuntimeModel.ts:709-729`): if replay `session/update`s stop for 2 s, a *synthetic*
  `LoadSessionResponse` is fabricated from `initialize._meta.modeState/.modelState`
  (`AcpRuntimeModel.ts:743-758`). Replay updates (`_meta.isReplay === true`) are dropped. Cursor, Grok.
- `session/new {cwd, mcpServers, additionalDirectories?}` — fresh.

**MCP** is always the same single entry:
`[{type:"http", name:"t3-code", url: mcp.endpoint, headers:[{name:"Authorization", value: mcp.authorizationHeader}]}]`
(`CursorAdapter.ts:563-579`, `GrokAdapter.ts:1013-1029`, `AntigravityAdapter.ts:801-810`).

**`session/update` variants handled** (`AcpRuntimeModel.ts:795-884`, verbatim switch):
`config_option_update`, `available_commands_update`, `current_mode_update`, `plan` (entries →
`{step,status}`, `in_progress`→`inProgress`), `tool_call` (fallbackStatus `"pending"`),
`tool_call_update`, `agent_message_chunk` (text only) → `ContentDelta`, `agent_thought_chunk` →
`ThoughtDelta`. **Everything else is dropped — `user_message_chunk` is not handled.**

Assistant text is bracketed into synthetic items `assistant:<sessionId>:runtime:<uuid>:segment:<n>`
(`:1279-1280`), closed on any tool call or prompt boundary.

**Tool-call bounding/coalescing** (`AcpRuntimeModel.ts:282-298, 588-666`) — hardening driven by Grok:
content capped at 8 000 chars tail with `"[Earlier output truncated]\n\n"`; `rawOutput.{content,stdout,
stderr,output}` bounded; emission coalesced unless status is terminal, title/status changed, or progress
grew ≥ 256 chars, with a forced flush every 10 skips. Comment at `:283-286`: a redrawing tool call sends
its **whole output on every `tool_call_update` instead of a delta**.

**Normalization** (`AcpCoreRuntimeEvents.ts:37-50`, `AcpRuntimeModel.ts:452-466`): tool kind →
`execute→command_execution`, `edit|delete|move→file_change`, `search|fetch→web_search`, else
`dynamic_tool_call`; permission kind → `exec_command_approval | file_read_approval |
file_change_approval | dynamic_tool_call`.

#### 2.4.1 Cursor (`cursor`)

```ts
// acp/CursorAcpSupport.ts:49-65
{ command: cursorSettings?.binaryPath || "cursor-agent",
  args: [ ...(apiEndpoint ? ["-e", apiEndpoint] : []), ...cursorAcpPermissionArgs(runtimeMode), "acp" ],
  cwd, ...(environment ? { env: environment } : {}) }
// :22-31
auto → ["--auto-review"] ; full-access → ["--force"] ; others → []
```

Default argv is exactly `cursor-agent acp` (`CursorAcpSupport.test.ts:52-58`). No env var is set or
removed. `authMethodId: "cursor_login"`; client capabilities add
`_meta: { parameterizedModelPicker: true }` (`CursorProvider.ts:165-169`). Resume via `session/load`,
cursor `{schemaVersion:1, sessionId}`.

**Vendor extensions** (`acp/CursorAcpExtension.ts`, documented at `cursor.com/docs/cli/acp#cursor-extension-methods`):

| Method | Direction | → T3 |
|---|---|---|
| `cursor/ask_question` | agent→client **request** `{toolCallId, title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}` | `user-input.requested`, answers back as `{answers}` (`CursorAdapter.ts:595-636`) |
| `cursor/create_plan` | request `{toolCallId, name?, overview?, plan, todos[], phases?}` | `turn.proposed.completed{planMarkdown}`, answers `{accepted:true}` (`:637-662`) |
| `cursor/update_todos` | **notification** `{toolCallId, todos[], merge}` | `turn.plan.updated` (`CursorAcpExtension.ts:89-112`) |
| `cursor/list_available_models` | client→agent request `{}` → `{models:[{value,name,configOptions?}]}` | model catalog (`CursorProvider.ts:647-661`) |

**Turn** (`CursorAdapter.ts:1021-1108`): `{type:"text"}` then **images only**
(`{type:"image", data:base64, mimeType}`); a trailing runtime-instructions text block is appended
**unless** the prompt is a slash command (`/^\/[^\s/]+(?:\s|$)/`). Model per turn:
`setModel(resolveCursorAcpBaseModelId(model))` (strips the T3 slug's `[...]` suffix, empty → `"default"`,
`CursorProvider.ts:567-571`), then per-option `session/set_config_option` for reasoning/context/fast/
thinking (`:573-645`). Concurrent `sendTurn` is a **steer** — reuses `activeTurnId`, does not cancel.

**Approvals**: `session/request_permission` handler at `:687-757`. `full-access` auto-selects
`allow_always` else `allow_once` optionId (`:310-324`). Otherwise the answer uses **hard-coded option ids,
not the advertised ones** (`acp/AcpAdapterSupport.ts:47-57`):

```ts
acceptForSession → "allow-always" | accept → "allow-once" | decline/default → "reject-once"
cancel → { outcome: { outcome: "cancelled" } }
```

**Mode mapping** is separate from approvals (`CursorAdapter.ts:230-259`): interaction `plan` → a mode
matching `plan|architect`; `approval-required` → `ask`; otherwise `code|agent|default|chat|implement`.

**Models + auth**: `cursor-agent about --format json` (falling back to plain `about` with ANSI-stripped
two-space columns, `CursorProvider.ts:695-708, 1086-1097`); `userEmail: null` or `"Not logged in"` →
`unauthenticated` with "Run `agent login`" (`:932-1053`). The model list needs a **dedicated probe ACP
process** — `cursor-agent [-e ep] acp` with `clientInfo.name = "t3-code-provider-probe"` — that does a
full `start()` (so it *does* authenticate and open `session/new`) then `cursor/list_available_models`
(`:497-523`); 15 s timeout, cached 30 min keyed on `[version, auth]`.

**`CursorTransportFailure.ts`** is a streaming classifier: an assistant item consisting *entirely* of
`Error: RetriableError: …`, `Error: ConnectError: [unavailable|aborted|deadline_exceeded]…`, or the
literal "Something went wrong communicating with the server. Please try again." is treated as a transport
failure; any other non-blank line disqualifies it (so a code sample quoting the string doesn't trip it).
On settlement the `sendTurn` fails with "Cursor reported a transport failure." (`CursorAdapter.ts:1111-1119`).

**Limits**: `supportsConversationRollback:false` — `rollbackThread` always fails "Cursor ACP sessions do
not support provider-side rollback" (`:1221-1236`). Compaction = `/compress`. Skills are scanned from
disk rather than the ACP command catalog, because the catalog only appears after a real session
(`CursorSkills.ts:1-10`).

#### 2.4.2 Grok (`grok`)

```ts
// acp/GrokAcpSupport.ts:33-63
{ command: grokSettings?.binaryPath || "grok",
  args: grokAcpSpawnArgs(runtimeMode), cwd,
  env: { ...environment, GROK_OAUTH2_REFERRER: "t3code" } }
// :34-46
approval-required → ["--permission-mode","default",    "agent","stdio"]
auto-accept-edits → ["--permission-mode","acceptEdits","agent","stdio"]
auto              → ["--permission-mode","auto",       "agent","stdio"]
full-access       → ["agent","--always-approve","stdio"]
default           → ["agent","stdio"]
```

Note it is **`grok agent stdio`**, not `grok --acp`. `authMethodId` is chosen from env:
`XAI_API_KEY` set → `"xai.api_key"`, else `"cached_token"` (`:14-18`). Resume via `session/load`.

**xAI extensions** (`acp/XAiAcpExtension.ts`) — every method exists in a bare *and* an
underscore-prefixed form, and params may additionally be **wrapped** as `{method, params}` (`:56-64`);
T3 registers both names and unwraps (`GrokAdapter.ts:1045-1046, 1104-1105`):

| Method | → T3 |
|---|---|
| `x.ai/ask_user_question` (+ `_x.ai/…`) `{sessionId, toolCallId, questions:[{id?, question, options:[{label, description?, preview?, id?}], multiSelect?}], mode}` | `user-input.requested`; answer `{outcome:"accepted", answers:{<questionText>:[labels]}, annotations?}` — unmatched free text becomes label `"Other"` + `notes` (`:130-196`) |
| `x.ai/exit_plan_mode` (+ `_x.ai/…`) | captures the plan, then **abandons** the native gate: `{outcome:"abandoned", feedback:"The client captured your proposed plan…"}` (`:249-267`) |
| `_x.ai/session/prompt_complete` (**notification**) `{sessionId, promptId?, stopReason?, agentResult?}` | prompt-completion fallback |

The **prompt-completion fallback** is why Grok's runtime is wrapped (`XAiAcpExtension.ts:418-489`): every
`session/prompt` carries `_meta:{promptId, requestId:"t3-xai-prompt-N"}` and races the RPC against the
notification. `stopReason:"rate_limit"` → `AcpRequestError(-32003, "Grok usage limit reached. Try again
later.")`; a missing `stopReason` is normalized to `end_turn` and tagged `_meta.xAiStopReasonMissing`
(`:648-682`), which the adapter reports as `stopReason: null`.

**plan.md sniffing** (`:322-408`): `isGrokPlanMarkdownPath` matches
`~/.grok/sessions/<encoded-cwd>/<session-id>/plan.md` (plus `$GROK_HOME`, `$USERPROFILE`, canonical
`/home|/Users|C:/Users`), deliberately *not* a workspace `docs/plan.md`. Write/edit tool calls to that
path surface the plan live while plan mode is active.

**Approvals** (`GrokAdapter.ts:1147-1240`): preferred kind `allow_always|allow_once|reject_once`, but
**Grok 4.6 often omits `allow_always`**, so `acceptForSession` falls back to the `allow_once` id and T3
remembers the operation itself: `approvalKey = stableStringify({kind,title,command,input,locations})`
with `rawInput.description` stripped for `variant:"Bash"` (`:1153-1166, 1223-1229`). Identical later
operations auto-answer `accept`. This is exactly the docs' "For Grok, **Always allow this session**
remembers the matching command or tool input" (`docs/user/permission-modes.md:27-28`).

**Model per turn** uses the unstable `session/set_model` rather than config options
(`AcpSessionRuntime.ts:1109-1123`, `GrokAcpSupport.ts:156-187`). The T3 slug `grok-build` is a product
name and is never sent — it means "keep the session's model" (`:101-111`). An invalid reasoning-effort
token sends **no** `_meta` so the CLI default isn't clobbered (`:180-184`).

**Auth probes never trigger a login** — three of them, none authenticating (`GrokProvider.ts`):
`grok --version` (4 s); `grok models` (regex `you are logged in` / `not authenticated|not logged in`,
bullet list for slugs, `:258-293`); and an **`initialize`-only ACP probe** (`:342-364`) explicitly
documented as never calling `authenticate` or `session/new`, so it "cannot open a browser login or boot
the workspace's MCP servers". It reads `initialize._meta.modelState` for models and
`initialize._meta.availableCommands` for slash commands, dropping `always-approve` and `context`.
This is `docs/internals/providers.md:44-48` ("Setup must not happen as a health-check side effect").

**Background tasks** (`acp/XAiBackgroundTasks.ts:61-155`): Grok returns discriminated tool results —
`{type:"Monitor", taskId}`, `{type:"BackgroundTaskStarted", task_id|taskId, command}`,
`{type:"TaskOutput"|"KillTask"}` — turned into `task.started/progress/completed`.

**Why the adapter is 2 207 lines** — not protocol surface, but concurrency and liveness:
- a **turn liveness watchdog** (`:779-818`): 10 min inactivity for text, 30 min while any tool call is
  open, because ACP does not expose Grok's private `streaming_reasoning` phase; pending approvals pause
  the clock; a stall cancels and fails with "Grok ACP turn stalled without content or tool progress…".
- prompt epoch/steer machinery: `promptsInFlight`, `promptEpoch`, `discardBeforeEpoch`,
  `promptLifecycle` semaphore, `interruptedTurnIds`, `settlePromptInFlight`
  (`:155-176, 579-720, 1728-2013`), plus deliberate `yieldNow` loops so cancellation wins races.

Usage limits (`grokUsageLimits.ts`) bail to `unsupported` when `XAI_API_KEY` or any of 12
alternate-deployment env vars are set (`:66-87`), or when config files declare `[auth]`/`[endpoints]`
(`:93-110`); otherwise read `~/.grok/auth.json` (only the two known issuer keys) and
`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`. `rollbackThread` fails.

#### 2.4.3 Antigravity (`antigravity`)

```ts
// antigravityAuthSupport.ts:422-449
{ command: installation.executablePath,   // <base>/tools/antigravity-acp/<plat>-<arch>/versions/<sha256>/agy_acp_server[.par|.exe]
  args: profile.platform === "linux" ? ["--uid="] : [],
  cwd,
  env: { ...antigravityEnvironment(...), ANTIGRAVITY_HARNESS_PATH: installation.harnessPath },
  extendEnv: false }            // <-- full env replacement, the only provider that does this
```

`antigravityEnvironment` (`:64-82, 206-242`) **removes** (case-insensitively) `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`,
`GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_GENAI_USE_VERTEXAI`, `GCLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`,
`AGY_ACP_*`, `GEMINI_HOME`, `BROWSER`, `PYTHONUNBUFFERED`, `ELECTRON_RUN_AS_NODE` — and **sets**
`GEMINI_HOME=<profileDir>`, `AGY_ACP_FORCE_FILE_STORAGE=1`, `PYTHONUNBUFFERED=1`,
`ELECTRON_RUN_AS_NODE=1`, `TMPDIR=<runtimeTempDir>`, and a `BROWSER` shim. This is
`docs/internals/providers.md:24-27`: "The launch environment removes ambient Google credentials, so an
instance cannot silently use another account or billing project."

`BROWSER` is a Node one-liner that prints `__T3_ANTIGRAVITY_AUTH_URL__"<url>"` to **stderr** and exits 0,
so Python never opens a real browser (`:27-62`). It must contain no `:`/`;` because Python splits
`BROWSER` on the path separator before parsing quotes (`:55-57`), and it is **preflighted** by actually
running the helper and byte-comparing its output before any agent spawn (`:350-387`).

**Profile isolation**: `<stateDir>/providers/antigravity/<sha256(instanceId)>` — sha256 so a
case-insensitive filesystem can't merge two instances (`:189-195`); `0o700` throughout; `settings.json`
is rewritten every launch with `{auth:{type}, gcp?:{project,location}}` and **never holds a credential**
(`:153-168`). Global skills are restored by symlinking (Windows: `junction`)
`<profile>/config/skills` and `<profile>/antigravity-cli/skills` → `~/.gemini/<same>` (`:252-292`).

**Handshake** (`acp/AntigravityAcpSupport.ts:55-89`):

```ts
authMethodId: input.authMethod ?? "oauth-personal",  // | oauth-business | gemini-api-key | agent-platform
resumeMethod: "resume",                              // session/resume, not session/load
cancelBehavior: "wait-for-prompt",
clientCapabilities: { fs: { readTextFile: clientFileSystem === true, writeTextFile: same }, terminal: false },
transformStdout: makeAntigravityStdoutTransform({ onAuthorizationUrl? }),
onStderr:        makeAntigravityStderrHandler({ onAuthorizationUrl? }),
transformSessionUpdate: normalizeAntigravitySessionUpdate,
```

`clientFileSystem: true` only for chat sessions (`AntigravityAdapter.ts:795`) — it makes the agent route
workspace writes through T3, turning each edit into a `session/request_permission` carrying the content
(`AntigravityAcpSupport.ts:44-49`). `fs/read_text_file`/`fs/write_text_file` are containment-checked
against `[cwd, attachmentsDir]` with parent-`realpath` symlink resolution and an 8 MiB cap
(`AntigravityAdapter.ts:216-302`).

**Non-standard: the sign-in URL arrives out-of-band on stdout** as a protocol line
`"Open the following link to authenticate the ACP server: <url>"`; `transformStdout` splits stdout into
lines, intercepts that prefix and **removes it from the protocol stream** (`antigravityAuthSupport.ts:489-553`).
Without an `onAuthorizationUrl` callback (a normal chat launch) the runtime fails with "Sign in to
Antigravity in Settings before you continue." (`:30-31, 504-506`). The 32 KiB stderr chunk cap exists
because "Antigravity can emit an accepted 16 KiB Google authorization URL on stderr"
(`AcpSessionRuntime.ts:70-71`).

**Turn** — the only adapter that sends real multimodal ACP content
(`buildAntigravityPrompt`, `AntigravityAcpSupport.ts:250-379`):

- text → `{type:"text"}`
- image (`bmp|jpeg|png|webp`) → `{type:"image", data:base64, mimeType}`
- audio (`aac,flac,mp3,mpeg,mp4,m4a,x-m4a,ogg,wav,x-wav,webm`) → `{type:"audio", data:base64, mimeType}`
- PDF → `{type:"resource_link", uri:file://…, name, mimeType}` (lazy, not embedded)
- text files → `{type:"resource", resource:{uri, mimeType, text}}`, UTF-8-strict, rejected on `\0`

Limits 1 MiB text / 10 MiB image / 20 MiB audio / 50 MiB PDF+total (`:171-247`), matching
`docs/user/providers-antigravity.md:95-99`. Anything else is a hard `invalidParams`.

**Approvals** use real native option kinds (`acp/AntigravityProtocol.ts:48-59`): `accept→allow_once`,
`decline→reject_once`, `acceptForSession→allow_always`, `cancel→{outcome:"cancelled"}`. **T3 only
advertises decisions the request can honor** (`:87-112`), and it surfaces Google's prompt-injection
warning from `option._meta["agy.security.warning"].{message|title}` as the `acceptForSession` option's
`warning` text, truncated to 512 chars (`:62-84`) — this is the `ProviderApprovalOption.warning` field's
reason for existing. If the user picks something the agent didn't offer, `respondToRequest` fails with a
validation error rather than guessing (`AntigravityAdapter.ts:1189-1200`).

**Questions ride the same method**: `toolCall.toolCallId.startsWith("interaction_")` means it's a user
question, not an approval — options become answer choices keyed by `optionId`, and the response is
`{outcome:{outcome:"selected", optionId}}` (`AntigravityProtocol.ts:42-46, 125-176`). This is the
docs' "Questions with fixed choices still need one of the offered answers, even in Full access"
(`docs/user/providers-antigravity.md:77-78`).

**Payload normalization** (`AntigravityProtocol.ts:189-344`) runs in `transformSessionUpdate`, i.e.
*before* the runtime retains anything: a node budget of 512 and text budget of 64 000/32 000, drops
`data:image/…` strings and `image.data|blob`, drops `formatted_output` duplicating `combinedOutput`,
bounds each string to 8 000 chars tail-first, and copies truncated strings through
`Buffer.from(text,"utf16le")` **so V8 can't retain a slice of the original giant string** (`:114-116`).
`normalizeAntigravityToolCall` folds Google's many casings
(`CommandLine|command_line|commandLine|command`, `Cwd|WorkingDirectory|working_dir|workingDir|cwd`,
`combinedOutput|combined_output`, `exitCode|exit_code`) into one canonical shape (`:291-344`).

**Subagents** (`:352-375`): ACP 1.1.1 exposes them as ordinary tools, so they are recognized by title
`"Running start_subagent"` / `"Run start_subagent?"`; they become `task.*` under a synthetic
`subagent_batch` task and settle to `idle` with "Turn ended. Individual agent status is unavailable."

**Interruption**: `cancelBehavior: "wait-for-prompt"` is the strict path (`AcpSessionRuntime.ts:978-1003`) —
`session/cancel`, then `Fiber.await` the prompt, await completion, `drainEvents`; if that doesn't finish
within 15 s the child is **killed** and the runtime retired with "The ACP agent did not finish
cancellation. Its process was stopped."

**Installer / release / lease** (`antigravityRelease.ts`, `AntigravityInstallation.ts`) — the most
elaborate supervision in the repo:

- `agy_acp_server_1.1.1` pinned per `platform-arch` with URL, sha256, archive bytes and exact member
  sizes (linux-x64: 681 969 407 B archive → `agy_acp_server.par` 1 880 360 328 B + `localharness_external`
  128 966 920 B).
- Layout `<baseDir>/tools/antigravity-acp/<platform>-<arch>/versions/<sha256>/` + an `active.json`
  pointer; activation is an atomic temp-file `rename` (`:283-290, 534-567`).
- Download streams with running sha256 and a hard size ceiling, rejecting a mismatched `content-length`
  **only when the body is identity-encoded**, because dl.google.com gzips the zip (`:610-659`); 45 min.
- Extraction requires **exactly 2 entries**, no path separators, no encryption, store/deflate only,
  exact uncompressed sizes (`:662-728`).
- Validation spawns the new binary in a throwaway profile and asserts `agentInfo.name ===
  "antigravity-acp"`, the exact version, `protocolVersion === 1`, `loadSession`,
  `sessionCapabilities.resume`, `auth.logout`, and an `oauth-personal` auth method (`:468-517`).
- **Leases**: `acquire()` refcounts the version dir for the life of the spawned process's scope
  (`:446-466`); `remove()` refuses while `leases.size > 0`, while an install runs, or when any instance's
  custom `binaryPath` points inside the managed tree (`:869-923`). This is
  `docs/internals/providers.md:36-40`.
- The health probe deliberately **does not spawn** and returns a synthetic `InitializeResponse` where
  only `agentInfo.version` is real — "the agent is a PyInstaller one-file bundle that unpacks about 1 GB
  per launch, and the health check runs every minute" (`AntigravityDriver.ts:313-354`).

**Loopback OAuth with return-URL forwarding** — the one provider with a real in-GUI login
(`AntigravityAuth.ts`, `antigravityAuthSupport.ts:452-487`, `antigravityCallback.ts`):

- `parseAntigravityAuthorizationUrl` accepts only `https://accounts.google.com/o/oauth2/v2/auth`, no
  credentials/hash, exactly one `state` (≤512, no whitespace), `response_type=code`, and a
  `redirect_uri` matching `^http://127\.0\.0\.1:[1-9][0-9]{0,4}/$` with port ≥ 1024.
- The GUI shows that URL. From a remote device the `127.0.0.1` page fails, so the user pastes the full
  return URL; `validateAntigravityCallbackUrl` checks it against the pending request — same origin/path,
  exactly one matching `state`, exactly one of `code` xor `error`, optional `iss` must be
  `https://accounts.google.com` (`antigravityCallback.ts:13-63`).
- `forwardAntigravityCallback` replays it as a single `GET` with `agent:false` (no proxy, no redirects,
  no response logging), 10 s (`:66-115`).
- 300 s expiry, single-owner-session visibility, duplicate-URL rejection, process-admission gating
  around sign-out (`AntigravityAuth.ts:90-102, 240-295, 441-517`). `logout` is an extension request
  `runtime.request("logout", {})`, gated on `initialize.agentCapabilities.auth.logout` (`:474-481`).

This matches `docs/internals/providers.md:50-56`: "Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished."

**Cannot roll back**: `supportsConversationRollback:false`; conversation state lives in the agent's own
SQLite-backed session files (`<profile>/antigravity-acp/conversations/<uuid>.db{,-wal,-shm,-journal}` +
`.meta` + `brain/<uuid>/`, `AntigravitySessionFiles.ts:23-40`) and ACP exposes no truncation call.
Session files are only deleted for *disposable* setup sessions, and only after matching the `.meta` `cwd`
to the unique temp cwd T3 created — proof of ownership (`:11-31`).

---

## 3. `packages/effect-acp` — the ACP package

### What it is

A **generated + hand-written ACP implementation for both roles**: a client (`src/client.ts`, 616 lines)
*and* an agent (`src/agent.ts`, 538 lines). Pinned to **ACP schema release `v0.11.3`, protocol version 1**
(`src/_generated/meta.gen.ts:2, 35`).

The schema is generated by `scripts/generate.ts` from the upstream release assets
(`scripts/generate.ts:16, 86-89`):

```ts
const CURRENT_SCHEMA_RELEASE = "v0.11.3";
const baseUrl = `https://github.com/agentclientprotocol/agent-client-protocol/releases/download/${tag}`;
downloadFile(`${baseUrl}/schema.unstable.json`, upstreamSchemaPath);
downloadFile(`${baseUrl}/meta.unstable.json`,   upstreamMetaPath);
```

→ `src/_generated/schema.gen.ts` (10 375 lines of Effect Schema) + `meta.gen.ts` (the method tables).

### The full method surface (`_generated/meta.gen.ts:4-35`)

```ts
AGENT_METHODS = { authenticate, initialize, logout,
  session_cancel: "session/cancel", session_close, session_fork, session_list, session_load,
  session_new, session_prompt, session_resume, session_set_config_option,
  session_set_mode, session_set_model }

CLIENT_METHODS = { fs_read_text_file, fs_write_text_file,
  session_elicitation: "session/elicitation", session_elicitation_complete,
  session_request_permission, session_update,
  terminal_create, terminal_kill, terminal_output, terminal_release, terminal_wait_for_exit }

PROTOCOL_VERSION = 1
```

`src/rpc.ts` turns those into two `RpcGroup`s — `AgentRpcs` (12 calls, `:148-161`) and `ClientRpcs`
(10 calls, `:163-174`, including a compatibility `elicitation/create` alias, `:104-116`).

### Transport (`src/protocol.ts`, 632 lines)

Newline-delimited JSON-RPC 2.0 over the child's stdio, built on `RpcSerialization.ndJsonRpc()`
(`:88`). Highlights worth porting:

- Server requests (agent→client) and client requests (client→agent) share one duplex; a decoded
  `Request` with `id === ""` is a **notification** and is routed to the notification queue, everything
  else goes to the RPC server or the extension handler (`:297-377`).
- `session/update` and `session/elicitation/complete` are decoded to typed notifications; anything else
  becomes `ExtNotification` (`:299-347`).
- A sliding buffer of 32 raw notifications so a fast agent can't grow the queue unboundedly (`:89, 107-109`).
- **Outbound notifications must not carry an `id`** — the comment at `:561-563` is a real bug report:
  "Encoding a Request without `isNotification` emits an `id`, which real agents (Grok CLI) parse as a
  malformed request and silently drop. That made `session/cancel` a no-op against Grok while the lenient
  mock agent accepted it."
- `@effect/rpc/Interrupt` frames are dropped because ACP has no such method (`:137-140`).
- Termination fails every pending deferred once, emits a `ClientProtocolError`, and calls `onTermination`
  (`:236-254`).

`src/_internal/stdio.ts:13-22` wires a `ChildProcessHandle` into an Effect `Stdio` (child stdout → our
stdin, our writes → child stdin, child stderr → drained separately).

### Which providers go through it

Cursor, Grok and Antigravity (`AcpSessionRuntime.ts:19-22`). Codex does **not** (it has its own
package), Claude does **not** (vendor SDK), OpenCode does **not** (HTTP).

### Could a third party reuse it standalone?

**The protocol knowledge: yes, and it's the most portable artifact in the repo.** The package is a clean,
complete, spec-faithful ACP implementation generated from the official release assets, and
`scripts/generate.ts` is ~90 % plain fetch + JSON-schema munging.

**The code: no, not as-is.** `package.json` is `"private": true` with source-only exports (no build), the
sole dependency is `effect` (catalog `4.0.0-rc.115` — an unreleased v4 RC), and every module is
Effect-native (`Effect`, `Stream`, `Queue`, `Deferred`, `Schema`, `Scope`, `Layer`, `Stdio`,
`RpcClient`/`RpcServer`, `ChildProcessSpawner`). A third party would reimplement ~200 lines of framing
over `readline` + `JSON.parse` and consume the upstream `schema.unstable.json` directly (or via the
official TypeScript ACP SDK, which exists).

**Genericity check:** nothing in `effect-acp` is Cursor/Grok/Antigravity-specific. The three vendor
extension sets live entirely in `apps/server/src/provider/acp/{CursorAcpExtension,XAiAcpExtension,
AntigravityProtocol}.ts` and hang off the generic `handleExtRequest` / `handleExtNotification` /
`handleUnknownExtRequest` registrations (`client.ts:249-276`). That extension seam is the reason all
three fit one engine.

---

## 4. `packages/effect-codex-app-server` — the Codex package

### What it is

Generated from **`openai/codex`'s own `codex-rs/app-server-protocol`, pinned to a commit**
(`scripts/generate.ts:20-23`):

```ts
const UPSTREAM_REF = "678157acaa819d5510adfe359abb5d0392cfe461";
const GITHUB_API_BASE = "https://api.github.com/repos/openai/codex/contents/codex-rs/app-server-protocol";
```

The generator fetches every `schema/json/**.json` (root, `v1/`, `v2/`), flattens/renames definitions
(`ExportName__DefinitionName`), rewrites `$ref`s across namespaces, normalizes `type:[X,"null"]` →
`anyOf`, strips `default:null`, then runs `@effect/openapi-generator` to emit
`src/_generated/schema.gen.ts` (**43 644 lines**). Method tables come from regex-parsing the upstream
TypeScript files `ClientRequest.ts`, `ClientNotification.ts`, `ServerRequest.ts`, `ServerNotification.ts`
(`:774-790`) into `meta.gen.ts` (790 lines).

Hand-maintained patches fill gaps the pinned ref lacks: `ManualSchemas` for
`getAuthStatus`/`getConversationSummary`/`gitDiffToRemote` (`:73-146`), `Codex0150DefinitionSchemas` for
multi-agent enums and `PlanType` (`:148-195`), `CodexErrorInfo` compatibility values (`:197-210`), and
the async-question `delivery`/`questions` fields (`:681-729`, comment: "Codex 0.153 adds async questions
to agent messages").

### Protocol surface

`meta.gen.ts` exposes four tables. **~120 client request methods** including `initialize`, `thread/*`
(start/resume/fork/archive/delete/read/list/rollback/compact/inject_items/name/goal/metadata),
`turn/{start,steer,interrupt}`, `review/start`, `model/list`, `skills/*`, `hooks/list`, `plugin/*`,
`marketplace/*`, `app/*`, `fs/*` (readFile/writeFile/createDirectory/getMetadata/readDirectory/remove/
copy/watch/unwatch), `command/exec{,/write,/terminate,/resize}`, `config/*`, `mcpServer*`,
`windowsSandbox/*`, `account/{read,login/start,login/cancel,logout,rateLimits/read,
rateLimitResetCredit/consume,usage/read,workspaceMessages/read}`, `feedback/upload`,
`externalAgentConfig/*`, and four legacy camelCase leftovers (`getConversationSummary`, `gitDiffToRemote`,
`getAuthStatus`, `fuzzyFileSearch`).

**One client notification**: `initialized`.

**10 server requests** (agent→client): `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`,
`item/permissions/requestApproval`, `item/tool/call`, `account/chatgptAuthTokens/refresh`,
`attestation/generate`, and the v1 leftovers `applyPatchApproval` / `execCommandApproval`.

**~70 server notifications** covering thread lifecycle, turn lifecycle, item lifecycle, per-stream
deltas (`item/agentMessage/delta`, `item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}`,
`item/commandExecution/outputDelta`, `item/fileChange/{outputDelta,patchUpdated}`, `item/plan/delta`,
`command/exec/outputDelta`, `process/{outputDelta,exited}`), approvals (`item/autoApprovalReview/*`,
`serverRequest/resolved`), account (`account/{updated,rateLimits/updated,login/completed}`), MCP,
`model/{rerouted,verification,safetyBuffering/updated}`, `fs/changed`, eight `thread/realtime/*` voice
notifications, and `{error, warning, guardianWarning, deprecationNotice, configWarning}`.

T3 uses roughly 20 of the ~120 requests and handles 5 of the 10 server requests (§2.2).

### Framing

Newline-delimited JSON, one object per line, **no `Content-Length` and no `"jsonrpc":"2.0"` field**
(`src/protocol.ts:100-104, 460-474`):

```ts
offerOutgoing({ id: requestId, method, ...(payload !== undefined ? { params: payload } : {}) });
// notification: { method, params? }
// response:     { id, result }  |  { id, error: {code, message, data?} }
```

Ids are a monotonic integer from 1 (`:166, 452-455`). Incoming messages are classified **structurally**:
`method` + valid `id` → request; `method`, no `id` → notification; `{id, result?|error?}` → response
(`:82-95, 353-359`). The line splitter keeps a `remainder` buffer, strips a trailing `\r`, and flushes
the tail on EOF (`:398-446`).

### Process lifecycle

**One `codex app-server` process per thread**, plus one short-lived process per probe/account action
(§2.2). `forceKillAfter: "2 seconds"` (`CodexSessionRuntime.ts:58`).

**There is no reconnect and no restart in the package.** On stdin EOF or read error, `handleTermination`
fails every pending deferred, ends the outgoing queue, and closes the request-handler scope exactly once
(`:196-218`); the terminal error is `CodexAppServerProcessExitedError{code,pid}` when the exit code is
readable, else `CodexAppServerTransportError`. Any subsequent send fails immediately with the stored
error (`:220-244`). The adapter translates those into `ProviderAdapterSessionClosedError`
(`CodexAdapter.ts:141-147`) — **restart is the caller's job** (a new `startSession`).

**No timeouts in the transport**: `request` awaits an unbounded `Deferred` (`:465-467`); callers impose
deadlines (auth probe, 3 s rate limits, 5 s child metadata, 3 s/10 s child interrupts, 20 s reset credit).
**Backpressure**: notification/request queues are `sliding(32)` and at most 32 concurrent inbound request
handlers run before the transport answers `-32001 "Too many Codex requests are already active."`
(`protocol.ts:18, 160-164, 304-313`).

### Reusability

Same verdict as `effect-acp`: the protocol knowledge transfers fully (NDJSON, no `jsonrpc` field, integer
ids, the `meta.gen.ts` method tables, and the generator script itself); the code does not
(`"private": true`, source-only exports, Effect-native throughout).

---

## 5. Process lifecycle & supervision

### 5.1 Layers of ownership

1. **`ProviderInstanceRegistry`** (`Layers/ProviderInstanceRegistryLive.ts`) owns
   `Map<InstanceId, ProviderInstance>`. **Every live instance runs inside its own child `Scope`**
   (`:28-31, 168-174`), so `reconcile` can replace or remove one instance without touching the rest
   (`:252`). Closing the registry's parent scope closes every instance.
2. **`ProviderAdapterRegistry`** (`Services/ProviderAdapterRegistry.ts`) is a pure lookup from
   `ProviderInstanceId` → `ProviderAdapterShape`, returning `ProviderUnsupportedError` for both "never
   configured" and "configured but this build doesn't ship the driver".
3. **Each adapter** owns a `Map<ThreadId, SessionContext>` with a per-session `Scope`; closing that scope
   kills the child. This is the same shape in all six adapters.
4. **`ProcessRunner`** (`apps/server/src/processRunner.ts`) is the **one-shot** command runner (probes,
   `--version`, CLI fallbacks): 60 s default timeout, 8 MiB output cap, `error`/`truncate` modes, a
   `timedOutResult` mode, Windows "command not found" detection including six localized message patterns
   (`:152-172`). Long-lived provider processes do **not** go through it — they use
   `effect/unstable/process/ChildProcessSpawner` directly inside the session scope.

### 5.2 Processes per thread

| Provider | Long-lived per thread | Extra |
|---|---|---|
| Claude | 1 CLI (SDK-owned) | short-lived probe, `--version`, history worker, `claude -p` text-gen |
| Codex | 1 `codex app-server` | short-lived app-server per probe / account action / skills probe |
| Cursor | 1 `cursor-agent acp` | a **separate probe ACP process** for the model list; `cursor-agent about` |
| Grok | 1 `grok agent stdio` | `grok --version`, `grok models`, `grok inspect --json`, an initialize-only ACP probe |
| Antigravity | 1 `agy_acp_server` | validation spawn on install; no health-check spawn (too expensive) |
| OpenCode | 1 `opencode serve` **per thread** | 1 instance-owned helper server (30 s idle close); CLI fallbacks |

### 5.3 Idle reaping

`Layers/ProviderSessionReaper.ts`: sweeps every **5 min**, stops sessions idle for **30 min**
(`:17-18`). It skips a session with an `activeTurnId` (`:75-81`) and — importantly — one with
`thread.backgroundLiveness` set (`:88-`):

> "The turn can settle while background work runs on (subagent fleets, workflow runs, Monitor watch
> loops). Those live inside the provider process, so stopping the session would kill them silently, and
> nothing bumps `lastSeenAt` between turns."

Idle is computed as `max(binding.lastSeenAt, thread.session.updatedAt)` so a long turn gets a full window
after it settles (`:63-70`).

### 5.4 What happens to a running turn when the server restarts

**The provider child dies with the server** — nothing is detached or re-attachable (contrast with
Orquester's tmux model). Recovery is `reconcileProviderSessions` (`apps/server/src/serverRuntimeStartup.ts:482-745`):

1. List threads whose persisted session is `starting`/`running`, or has a non-null `activeTurnId`, or is
   `ready` and carries a prepared-continuation marker (`:536-545`).
2. For each, read its `ProviderRuntimeBinding` from `ProviderSessionDirectory`.
3. If continuation is enabled (a user setting, resolvable per project, `:489-502`) **and** the binding has
   a `resumeCursor` **and** the thread is not archived/deleted, mark
   `runtimePayload.continueAfterServerUpdate` durably, set the session to `starting`, then fork a task
   that calls `providerService.sendTurn(...)` with either `{continuation: true}` (adapters advertising
   `promptlessTurnContinuation`) or `{input: "Continue where you left off."}` (`:694-710`).
4. Otherwise settle the session as an error:
   `"Provider session did not survive a server restart. Send a new message to continue."` (`:345-347`).

The continuation marker is written **before** the send and cleared only on success, so a second crash
mid-recovery still recovers (`:660-666`).

### 5.5 Session restarts on mode change

`ProviderService.startSession` notes: **"Changing runtime mode restarts the session"**
(`Layers/ProviderService.ts:1561-1564`), and `ProviderCommandReactor` implements it — a
`thread.runtime-mode-set` event calls `ensureSessionForThread` with the cached model selection under a
workspace lease (`orchestration/Layers/ProviderCommandReactor.ts:1789-1804`). This is why every provider
can express permission mode as *launch flags* rather than needing a live mode-change RPC.

### 5.6 Orchestration touch points

Only four orchestration files reference `ProviderService`:
`ProviderCommandReactor.ts` (1942 lines — commands → adapter calls),
`ProviderRuntimeIngestion.ts` (2720 lines — normalized events → persisted orchestration events),
`CheckpointReactor.ts`, `ThreadDeletionReactor.ts`. The command dispatch table is
`ProviderCommandReactor.ts:1779-1840`: `thread.meta-updated`, `thread.session-set`,
`thread.runtime-mode-set`, `thread.turn-start-requested`, `thread.turn-interrupt-requested`,
`thread.approval-response-requested`, `thread.user-input-response-requested`,
`thread.session-stop-requested`, `thread.settled`.

### 5.7 Debug observability

`Layers/ProviderEventLoggers.ts` exposes **two** NDJSON views of the same rotating per-thread log:
`native` (provider-protocol events as the SDK emits them, written from inside each adapter) and
`canonical` (after `ProviderService` normalized them). Shared batching/rotation/retention
(`EventNdjsonLogger.ts`: 10 MiB/file, 10 files, 512 MiB total, 14 days, 1 s batch window; transient delta
event types are filtered, `:43-62`). Both fields are optional — "observability must not prevent startup".
This pairs with `raw.source`/`raw.method` on every runtime event, so a captured log is replayable.

---

## 6. Permission modes — the complete mapping

T3's user-facing modes (`docs/user/permission-modes.md`) are `RuntimeMode`
(`packages/contracts/src/orchestration.ts:128-135`), default `full-access`:

| UI label | `RuntimeMode` |
|---|---|
| Supervised | `approval-required` |
| Auto-accept edits | `auto-accept-edits` |
| Auto | `auto` |
| Full access | `full-access` |

Plan mode is a **separate axis** (`ProviderInteractionMode = "default" | "plan"`), not a permission mode.

| RuntimeMode | Claude | Codex | Cursor | Grok | Antigravity | OpenCode |
|---|---|---|---|---|---|---|
| `approval-required` | *(no flag — CLI default, all tools hit `canUseTool`)* | `approvalPolicy:"untrusted"` + `sandbox:"read-only"` + `approvalsReviewer:"user"` | no extra argv; mode `ask` | `--permission-mode default agent stdio` | mode `"default"` | ruleset: `*`→ask, reads allow (except `.env`) |
| `auto-accept-edits` | `permissionMode:"acceptEdits"` | `on-request` + `workspace-write` + `user` | no extra argv | `--permission-mode acceptEdits agent stdio` | mode `"auto_edit"` | same ruleset with `edit`→allow |
| `auto` | `permissionMode:"auto"` | `on-request` + `workspace-write` + **`approvalsReviewer:"auto_review"`** | `--auto-review` | `--permission-mode auto agent stdio` | mode `"default"` (no equivalent) | same as supervised (no AI reviewer) |
| `full-access` | `permissionMode:"bypassPermissions"` + `allowDangerouslySkipPermissions:true`; `canUseTool` short-circuits to allow | `never` + `danger-full-access` + `user` | `--force` | `agent --always-approve stdio` | mode `"yolo"` | ruleset `*`→allow + `external_directory`→allow |

Citations: Claude `ClaudeAdapter.ts:4879-4891, 4940-4942, 4705-4711`; Codex
`CodexSessionRuntime.ts:509-543`; Cursor `acp/CursorAcpSupport.ts:22-31`; Grok
`acp/GrokAcpSupport.ts:34-46`; Antigravity `acp/AntigravityAcpSupport.ts:91-101`; OpenCode
`opencodeRuntime.ts:508-544`.

Docs corroborate the two gaps: "**Auto** uses automatic review on Codex, Claude, and Cursor; providers
without an equivalent, including OpenCode and Antigravity, fall back to asking"
(`permission-modes.md:23-25`).

**Plan mode** is likewise per-provider: Claude `setPermissionMode("plan")` + always-deny `ExitPlanMode`
(`ClaudeAdapter.ts:4683-4703, 5191-5201`); Codex `collaborationMode:{mode:"plan", settings}`
(`CodexSessionRuntime.ts:583-606`); Cursor a mode matching `plan|architect`
(`CursorAdapter.ts:230-259`); Grok an `x.ai/exit_plan_mode` extension answered `{outcome:"abandoned"}`
(`XAiAcpExtension.ts:249-267`); OpenCode the `plan` **agent** (`OpenCodeAdapter.ts:3207`); Antigravity —
**unsupported**, use its own `/plan` (`docs/user/providers-antigravity.md:75-76`), and
`showInteractionModeToggle` is off.

`ProviderApprovalDecision` maps to each provider's native vocabulary very differently, and the two
awkward cases are worth flagging for a port:

- **Codex** downgrades `acceptAlways` → `acceptForSession` on command/file approvals — it has no
  permanent grant there (`CodexSessionRuntime.ts:2107, 2165`).
- **Grok** often omits `allow_always` entirely, so T3 fakes session-scoped grants client-side with a
  `stableStringify` operation key (`GrokAdapter.ts:1153-1180`).
- **Cursor** ignores the advertised option ids and sends hard-coded `allow-always`/`allow-once`/
  `reject-once` (`AcpAdapterSupport.ts:47-57`) — the opposite of Antigravity, which only ever sends ids
  the request actually advertised (`AntigravityProtocol.ts:87-112`).

---

## 7. MCP inside providers

### 7.1 The server

T3 **runs its own MCP server** (`apps/server/src/mcp/McpHttpServer.ts`, 635 lines, built on
`effect/unstable/ai`'s `McpServer`) mounted at `/mcp` on the same HTTP server, **outside the environment
auth stack** — it is guarded solely by a per-thread bearer credential (`McpSessionRegistry.ts:69-74`).

Credential lifecycle (`McpSessionRegistry.ts`): `issue({threadId, providerInstanceId, capabilities})`
mints a random token (base64url), stores only its SHA-256, and returns an
`McpProviderSessionConfig` with `{environmentId, threadId, providerSessionId, providerInstanceId,
endpoint, authorizationHeader, capabilities, agentDeviceEnvironment?}`
(`McpProviderSession.ts:3-18`). Endpoint is `http://<host>:<port>/mcp`, with a wildcard bind announced as
`127.0.0.1` because provider subprocesses run on loopback (`:82-86`). Liveness window is **24 h** from
the last sign of life, refreshed both by MCP traffic and by `touch` on **every provider turn**
(`ProviderService.ts:1715-1720` — "The MCP credential is minted once at session start and cannot be
rotated into an already-spawned agent process… sessions that go a long time between browser tool calls
used to lose the toolkit outright").

### 7.2 Toolkits (what it's *for*)

Three capabilities (`McpInvocationContext.ts:11`): `"preview" | "device" | "pull-requests"`, gated
per-call by `requireMcpCapability` (`:47-56`). Capabilities are resolved from server settings per thread
(`ProviderService.ts:906-914`) — `pull-requests` always, `preview` and `device` only if the agent-access
settings allow them.

- **preview** (`mcp/toolkits/preview/tools.ts`) — browser automation:
  `preview_status`, `preview_open`, `preview_navigate`, `preview_resize`, `preview_set_appearance`,
  `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
  `preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop`.
- **device** (`toolkits/device/tools.ts`) — `device_list`, `device_open`, `device_screenshot`,
  `device_close`. Device driving additionally injects an `agent-device` CLI **shim directory onto the
  provider subprocess's `PATH`** so "the agent never handles a token"
  (`McpProviderSession.ts:11-33`, `withAgentDeviceEnvironment`).
- **pull-requests** (`toolkits/pullRequests/tools.ts`) — `link_pull_request`, `unlink_pull_request`,
  `list_thread_pull_requests`. The agent is *told* to use these by the system-prompt block in
  `provider/RuntimeInstructions.ts:1-5`, which every adapter appends.

**Asking the user questions is NOT MCP** — every provider has a native mechanism (Claude's
`AskUserQuestion` tool via `canUseTool`, Codex's `item/tool/requestUserInput` + async
`delivery:"async"`, Cursor's `cursor/ask_question`, Grok's `x.ai/ask_user_question`, Antigravity's
`interaction_*` permission requests, OpenCode's `/question` endpoint). Attachments are likewise not MCP —
they are inlined natively plus an on-disk path in the prompt.

### 7.3 Registration, per provider

| Provider | Mechanism | Shape |
|---|---|---|
| Claude | SDK `mcpServers` option (→ CLI `--mcp-config`) | `{"t3-code": {type:"http", url, headers:{Authorization}}}` (`ClaudeAdapter.ts:4953-4965`) |
| Codex | **`-c` config overrides on argv** + an env var | `-c mcp_servers.t3-code.url=<endpoint>` / `-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`, with `T3_MCP_BEARER_TOKEN` in env — **the token never appears on the command line** (`CodexAdapter.ts:2291-2307`) |
| Cursor / Grok / Antigravity | ACP `session/new`/`load`/`resume` param | `mcpServers:[{type:"http", name:"t3-code", url, headers:[{name:"Authorization", value}]}]` |
| OpenCode | **runtime API call** `POST /mcp` after connect | `{name:"t3-code", config:{type:"remote", url, headers:{Authorization}, oauth:false}}` — **only for T3-managed servers**, never external (`OpenCodeAdapter.ts:2869-2883`) |

Note the size constraint baked into the preview toolkit (`McpHttpServer.ts:117-121`): "Claude Code drops
every MCP result above 25k tokens (~100 KB of text) and hands the agent a truncation notice instead."

---

## 8. Dependency footprint & portability

### 8.1 What the provider layer actually depends on

`apps/server/package.json:24-37` — the whole server has **12 runtime dependencies**:

```json
"@anthropic-ai/claude-agent-sdk": "^0.3.276",   // Claude protocol
"@opencode-ai/sdk": "^1.3.15",                  // OpenCode HTTP client
"@effect/platform-node": "catalog:",
"@effect/platform-node-shared": "catalog:",
"effect": "catalog:",                            // 4.0.0-rc.115  (pnpm-workspace.yaml:47)
"@ff-labs/fff-node": "0.9.4",
"node-pty": "^1.1.0",                            // terminals, not providers
"stream-chain": "^4.2.5", "stream-json": "3.6.0",
"diff": "8.0.3", "yaml": "catalog:", "yauzl": "^3.4.0"   // yauzl = Antigravity zip extraction
```

plus the two workspace protocol packages `effect-acp` and `effect-codex-app-server` (dev deps because
they are source-only).

**The provider layer uses exactly two third-party protocol clients.** Everything else is built on Effect
primitives: `Effect`, `Stream`, `Queue`, `Deferred`, `Ref`/`SynchronizedRef`, `Scope`, `Layer`,
`Schema`, `Semaphore`, `Fiber`, `PubSub`, `Schedule`, `Duration`, `Clock`, `Crypto`, `FileSystem`,
`Path`, and the **unstable** namespaces `effect/unstable/process` (`ChildProcess`, `ChildProcessSpawner`),
`effect/unstable/rpc` (`RpcClient`, `RpcServer`, `RpcSerialization`, `RpcMessage`),
`effect/unstable/http`, `effect/unstable/ai` (`McpServer`, `Tool`), `effect/unstable/cli`,
`effect/unstable/net`. `effect/Schema` is the schema library everywhere (no zod).

### 8.2 How hard is the port?

**Effect is the hard part, not the protocols.** The codebase is on `effect@4.0.0-rc.115`, an unreleased
v4 RC whose `unstable/*` namespaces (process spawning, RPC, MCP, CLI) have no stable API yet. Lifting any
file verbatim means adopting that. Conversely, *none* of the protocol knowledge is Effect-shaped.

Rough difficulty per protocol, for a plain Node/Fastify codebase:

| Protocol | Port difficulty | Why |
|---|---|---|
| **OpenCode** | **Easiest.** `@opencode-ai/sdk` is a `fetch` wrapper; drop it in, or hand-write ~20 `fetch` calls + an SSE reader. | The hard parts are semantic, not transport: prompt-admission/idle reconciliation (`OpenCodeAdapter.ts:1342-1503`) and snapshot-vs-delta text handling (`:604-656`). Budget those, not the HTTP. |
| **Claude Code** | **Easy-ish.** `@anthropic-ai/claude-agent-sdk` is plain npm and does the spawning; `query({prompt, options})` + an async-iterable of `SDKUserMessage`. | The port is essentially copying the `Options` object and the `SDKMessage` switch. The traps are the content-block ordering rule and the "question id must be the question text" rule. |
| **Codex** | **Medium.** ~200 lines of NDJSON framing over `readline`, then the method tables. | `meta.gen.ts` is directly usable as data. `scripts/generate.ts` is ~90 % fetch + regex and could be re-pointed at zod/TS output. Traps: no `jsonrpc` field; approvals answered inline on the read loop (deadlock); `collaborationMode` and async-question fields are generator patches, not in the pinned schema. |
| **ACP (Cursor/Grok/Antigravity)** | **Medium for the transport, high for the vendor quirks.** ACP itself is small and has an official TS SDK. | The real work is the three extension sets (`CursorAcpExtension`, `XAiAcpExtension`, `AntigravityProtocol` — ~1 800 lines combined) plus the liveness/steering machinery in `GrokAdapter.ts` and the Antigravity installer/lease/OAuth system (~2 000 lines). |

**Directly liftable artifacts** (data, not code):

- `packages/effect-codex-app-server/src/_generated/meta.gen.ts` — the Codex method catalog.
- `packages/effect-acp/src/_generated/meta.gen.ts` — the ACP method catalog + protocol version.
- Both `scripts/generate.ts` — they document exactly where upstream schemas live and how to pin them.
- The per-provider **argv/env tables** in §2 and the **permission-mode matrix** in §6.
- `apps/server/src/provider/model-manifest.json` + `ModelManifest.ts` — the remote-with-bundled-fallback
  model catalog pattern (fetched from `raw.githubusercontent.com/pingdotgg/t3code/main/...`, 1 h TTL,
  5 min retry floor, "a newer bundle outranks the cached remote manifest by `updatedAt`").
- The `ProviderRuntimeEvent` union itself (`packages/contracts/src/providerRuntime.ts`) — the normalized
  algebra is the single best design artifact to copy, independent of Effect Schema.

**Not liftable:** anything touching `effect/unstable/*`, the Layer/Scope supervision tree, and the
`RpcClient`/`RpcServer` duplex trick in `effect-acp/src/protocol.ts` (which reuses Effect's RPC machinery
to serve *and* call over one stdio pipe).

---

## 9. Known limitations & quirks, per provider

### Claude Code
- **No in-GUI login.** On auth failure T3 emits instructions to run `claude auth login` manually with the
  right `CLAUDE_CONFIG_DIR` (`ClaudeHome.ts:81-90`).
- **Interrupt kills the process**; there is no graceful control interrupt, because "interrupt() can
  acknowledge while resumed background tasks keep the CLI alive" (`ClaudeAdapter.ts:5289-5297`).
- `HOME` must not be overridden or macOS keychain lookup breaks ("Not logged in", `ClaudeHome.ts:46-51`).
- A usage-limited turn parks inside the SDK with no further messages, so the thread keeps showing
  "working" (`docs/user/providers-claude.md:56-62`).
- Repeated 529 overloads arrive as a **success** result with `api_error_status: 529` and an empty error
  list (`ClaudeAdapter.ts:1684-1687`).
- `[ede_diagnostic] …` internal errors must never become the user-facing banner (`:1706-1714`).
- Skills marked `disable-model-invocation` must be invoked one per message
  (`docs/user/providers-claude.md:70-73`).
- `workflow_progress` on `task_progress` is wire-real but absent from `sdk.d.ts`; parsed defensively with
  caps (`:1401-1462`).
- Threads can only move between instances sharing a `CLAUDE_CONFIG_DIR`; "Claude does not have Codex's
  shared-home and shadow-home arrangement" (`docs/user/providers-claude.md:32-34`).

### Codex
- **No in-GUI login** — `account/login/start|cancel|logout` exist in the protocol but are never called;
  the documented flow is a shell `codex login` (`docs/user/providers-codex.md:16-19`).
- **Approval handlers run on the stdin read loop**, so an open approval card blocks all inbound traffic
  including the `turn/interrupt` response (`CodexSessionRuntime.ts:2565-2571`).
- `~` in `CODEX_HOME` must be expanded manually (`CodexProvider.ts:369-372`); the shadow-home `auth.json`
  must be a real file, never a symlink, and an OS credential store breaks multi-account
  (`CodexHomeLayout.ts:696-719`, `docs/user/providers-codex.md:32-34`).
- `thread/resume` may return full history despite `excludeTurns:true` on older servers, so it is issued
  raw and undecoded (`:744-752`).
- `collaborationMode`, async-question `delivery`/`questions`, multi-agent enums and two `CodexErrorInfo`
  values are **generator patches**, not in the pinned upstream schema.
- Codex emits `subAgentActivity {agentPath:"/root"}` about the root thread; registering it as a child
  made threads hang "working" forever (`:1622-1636`).
- Async questions require a Codex version that supports them (`docs/user/providers-codex.md:52-56`).
- `acceptAlways` is downgraded to `acceptForSession` — no permanent grant on command/file approvals.
- Codex ingests **images only**; other attachments arrive as a path line in the prompt.
- `codex update` operates on the *shared* home even under an auth overlay (`CodexDriver.ts:130-146`).

### Cursor
- **`supportsConversationRollback: false`** — `rollbackThread` always fails
  (`CursorAdapter.ts:1221-1236`).
- The model list needs a **full authenticated probe session** (`session/new`), unlike Grok's
  initialize-only probe (`CursorProvider.ts:497-523`).
- Answers use hard-coded option ids rather than the advertised ones (`AcpAdapterSupport.ts:47-57`).
- Skills are scanned from disk because the ACP command catalog only appears after a real session
  (`CursorSkills.ts:1-10`).
- Parameterized model picker requires CLI ≥ `2026.04.08` **and** channel `lab` in
  `~/.cursor/cli-config.json` (`CursorProvider.ts:871-910`).
- Usage limits are refused when `CURSOR_API_KEY` is set or credentials live in the macOS keychain
  (`cursorUsageLimits.ts:72-88`).
- Transport failures arrive as ordinary assistant text and must be classified heuristically
  (`CursorTransportFailure.ts`).

### Grok
- `rollbackThread` fails: "Grok ACP sessions do not support provider-side rollback yet."
- **Grok 4.6 often omits `allow_always`**, so "always allow this session" is emulated client-side by
  hashing the operation (`GrokAdapter.ts:1153-1180`; `docs/user/permission-modes.md:27-28`).
- ACP does not expose Grok's `streaming_reasoning` phase, so a 10 min / 30 min liveness watchdog is
  needed to tell "thinking" from "stalled" (`GrokAdapter.ts:779-818`).
- Extension methods exist in bare *and* underscore-prefixed forms, with optionally wrapped params —
  both must be registered (`XAiAcpExtension.ts:56-64`).
- `session/prompt` may never return; completion is recovered from the
  `_x.ai/session/prompt_complete` notification (`:418-489`).
- A redrawing tool call re-sends its **whole output** on every `tool_call_update`
  (`AcpRuntimeModel.ts:283-286`).
- Usage limits bail to `unsupported` for API-key or self-hosted deployments (`grokUsageLimits.ts:66-110`).
- `/always-approve` typed by the user is rejected with "Change permissions with T3's permission selector
  instead" (`GrokAdapter.ts:1524-1530`).
- `grok-build` is a product name, not a model id, and is never sent over the wire
  (`GrokAcpSupport.ts:101-111`).

### Antigravity
- **Cannot roll back its conversation** — revert and edit-and-resubmit are unavailable
  (`AntigravityAdapter.ts:1250, 1269-1276`; `docs/user/providers-antigravity.md:80-82`). The checkpoint
  boundary rejects revert *before* touching files (`docs/internals/providers.md:63-66`).
- **T3's Plan mode is unavailable**; use Antigravity's native `/plan` (`docs:75-76`).
- It can still send native approval requests in **Full access**, and fixed-choice questions still require
  one of the offered answers (`docs/user/permission-modes.md:32-34`, `providers-antigravity.md:77-78`).
- **Subagents are opaque**: you cannot open or control individual children, and an idle batch does not
  confirm every child succeeded (`docs:101-106`).
- The health probe deliberately does not spawn — the binary is a PyInstaller bundle that unpacks ~1 GB per
  launch and the check runs every minute (`AntigravityDriver.ts:313-354`).
- The `BROWSER` shim must contain no `:`/`;` because Python splits on the path separator before parsing
  quotes (`antigravityAuthSupport.ts:55-57`), and it is preflighted byte-for-byte before any agent spawn.
- Remote sign-in requires manually pasting the full `127.0.0.1` return URL; "a successful callback page
  alone does not confirm account access" (`docs:36-45`, `docs/internals/providers.md:50-56`).
- Managed installation supports Apple Silicon macOS, Linux x64/ARM64, Windows x64/ARM64 only; Intel Macs
  must connect to a remote environment (`docs:66-68`).
- Removal is refused while a runtime is leased, installing, or referenced by a custom `binaryPath`
  (`AntigravityInstallation.ts:869-923`).
- `~/.agents/skills` is never read (`docs:89-93`); attachment limits are lower than the general upload
  limit and "uploading a file does not mean this provider can use it" (`docs:95-99`).
- `api key` is stored **in plain text** in settings on the environment (`docs:57-59`).
- Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can run
  before the prompt, so profiles with such configuration are rejected before launch
  (`docs/internals/providers.md:57-61`).

### OpenCode
- Requires **OpenCode ≥ 1.14.19**, including for an external server
  (`docs/user/providers-opencode.md:5-7`, `opencodeRuntime.ts:42-49`).
- **Auto ≡ Supervised** — "OpenCode has no AI approval reviewer" (`docs:27-29`).
- "Allow for workspace" grants are **per directory, not per thread**, and are broader than the current
  thread on a shared external server (`docs:30-33`) — which is why full-access auto-replies use `once`.
- **Denying an action does not stop the whole turn** (`docs:33`).
- `promptAsync` returns before the turn starts; completion needs an idle-reconciliation state machine and
  can fail with "OpenCode accepted the prompt, but T3 Code could not confirm its message or session
  status." (`OpenCodeAdapter.ts:1288`).
- Text parts are **snapshots, not deltas**, and completed parts can be edited (`:604-656`).
- CLI fallbacks must run **sequentially** — concurrent CLI commands hit "database is locked" on the
  shared SQLite (`opencodeRuntime.ts:987-988`); the Bun-compiled binary truncates JSON past one 64 KB pipe
  buffer to a non-TTY stdout (`OpenCodeDriver.ts:171-178`).
- Native config can stay cached while the helper runs; a 30 s idle window is required before a refresh
  reloads files, and an external server may need its own restart (`docs:42-46`).
- Existing threads keep a model after it leaves the catalog; OpenCode may then reject it (`docs:48-49`).
- Hidden agents `compaction/summary/title` are not flagged by `agent list`, so they are hard-coded
  (`opencodeRuntime.ts:305-307`).
- Usage limits are OpenCode-Go-only and local-only.

---

## 10. Cross-cutting design notes worth stealing

1. **One normalized event algebra + `raw.{source,method,payload}` on every event.** The NDJSON logger
   writes both the native and canonical views of the same stream to one rotating per-thread file, making
   any provider session replayable for debugging (`Layers/ProviderEventLoggers.ts`).
2. **Instance ≠ driver.** `ProviderDriverKind` is an **open** branded slug validated only for shape, never
   for "we ship this driver" (`packages/contracts/src/providerInstance.ts:58-70`); unknown drivers decode
   fine and become "unavailable shadow snapshots" so settings round-trip across fork/branch rollbacks.
   Routing is always by `ProviderInstanceId`.
3. **`continuationIdentity`** decides whether a thread may move between instances — Claude keys on
   `CLAUDE_CONFIG_DIR`, Codex on `CODEX_HOME`. A clean answer to the multi-account problem.
4. **`resumeCursor: Schema.Unknown`.** The orchestration layer persists an opaque adapter-owned blob; no
   central code knows what a resume token is.
5. **Capability flags gate features before side effects.** `supportsConversationRollback:false` makes the
   checkpoint layer reject a revert *before* touching the filesystem
   (`docs/internals/providers.md:63-66`).
6. **Probes must not authenticate.** Grok's initialize-only ACP probe and Antigravity's spawn-free health
   check both exist because "Opening a provider session can start MCP servers, run hooks, or launch a
   login browser" (`docs/internals/providers.md:42-48`).
7. **Changing permission mode restarts the session.** That single decision lets every provider express
   permissions as launch flags instead of needing a live mode-change RPC
   (`ProviderService.ts:1561-1564`).
8. **Model manifest = bundled JSON + remote refresh from `main`.** Offline startup works; model metadata
   can change between releases; a newer bundle outranks a cached remote copy by `updatedAt`
   (`ModelManifest.ts:1-48`, `docs/internals/model-manifest.md`).
9. **Secrets never reach a command line.** Codex passes the MCP bearer token via
   `bearer_token_env_var` + env; the device CLI is exposed as a PATH shim so "the agent never handles a
   token" (`McpProviderSession.ts:11-18`).
10. **Every wire-shape assumption is pinned by a test against a real capture or a real subprocess** —
    `CodexCollabWire.test.ts` + `testFixtures/codexMultiAgentWire.json` (codex-cli 0.145.0),
    `ClaudeCapabilitiesProbe.test.ts` (fake CLI asserting the SDK's derived argv),
    `acp-mock-peer.ts` / `codex-app-server-mock-peer.ts`. That is how the protocol knowledge stays true.
