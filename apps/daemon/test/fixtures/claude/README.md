# Claude Code protocol fixtures

Real traffic captured from the Claude Code CLI installed on the build host, at the
`@anthropic-ai/claude-agent-sdk` **message level** — the level the Claude adapter
(`apps/daemon/src/agent-host/adapters/claude/**`, work package W6) consumes. They exist so the
adapter's normaliser gets replay tests against reality rather than against the design's guesses
(spec §9: *"a fixture is produced by driving the real CLI over its own transport once and
committing the result"*).

## Provenance

| | |
|---|---|
| CLI | `claude 2.1.210 (Claude Code)` |
| SDK | `@anthropic-ai/claude-agent-sdk` **0.3.278** |
| Node | v20.20.2, Linux |
| Captured | **2026-09-21** |
| Account | a first-party Claude **Max** subscription (`apiProvider: "firstParty"`, `apiKeySource: "none"`) |
| cwd | a throwaway git repo created for the capture, holding only `a.txt` (`alpha beta gamma`), `b.txt` (`hello world`) and `.claude/settings.json` |

The capture harness lived **outside** this repo and is not committed (spec §9: there is no record
mode). Each file was produced by one real run; a scenario was re-run only when the first run did
not demonstrate the behaviour, and that is noted below.

## File format

NDJSON, one object per line:

```jsonc
{"t": <ms since capture start>, "kind": "...", "data": <verbatim JSON>}
```

| `kind` | `data` |
|---|---|
| `sdk-message` | an `SDKMessage` yielded by `query()`, **verbatim** — not reshaped |
| `input` | the `SDKUserMessage` the harness pushed onto the streaming-input queue |
| `canUseTool` | `{toolName, input, options}` — the callback's arguments (`options.signal` is a placeholder; an `AbortSignal` is not serialisable) |
| `canUseToolResult` | `{toolName, result}` — the `PermissionResult` the harness returned |
| `control` | a control-protocol call: `{op, result?/error?, elapsedMs?}` (`initializationResult`, `interrupt`, `setPermissionMode`, `forkSession`, `supportedModels`, …) |
| `note` | harness commentary: the `Options` object used, phase markers, counters, expectations |

The first `note` line of every file carries the exact `Options` object (`options`, with `env`
redacted and functions stringified) and a `capturedWith` block. **That is the authoritative record
of how the frames were produced** — read it before asserting on a file.

## Redaction

Applied to every file before committing, verified by an automated post-check:

- the account email → `user@example.invalid`; the organization name derived from it → `<organization>`
- the managed-account home `/var/lib/orquester/daemon/agent-accounts/claude/<uuid>/home` → `~`
- that account uuid anywhere else → `<account-id>`
- the service user's home `/var/lib/orquester` → `~` (and its flattened form `-var-lib-orquester-…`,
  as it appears inside CLI cache directory names, → `-home-…`)

**Session ids are deliberately kept** — they are what makes the resume/fork fixture legible — and
none of them is a credential. No token, key or credential file was read, printed or copied.

## The scenarios

Common to all except `13`: `cwd` = the sandbox, `pathToClaudeCodeExecutable` = the installed
`claude`, `systemPrompt: {type:"preset", preset:"claude_code", append: "…Be terse."}`,
`settingSources: ["project","local"]`, `includePartialMessages: true`, streaming input kept open
for the whole session, `sessionId` = a freshly generated v4 uuid, `env` = the process env minus
nested-session variables (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, …)
plus `CLAUDE_CODE_AUTO_CONNECT_IDE=0`, `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=1`,
`ENABLE_CLAUDEAI_MCP_SERVERS=false`. `CLAUDE_CONFIG_DIR` was inherited, never set by the harness.

> **Deliberate deviation from the adapter's real config:** the spec's adapter sets
> `settingSources: ["user","project","local"]`. The captures drop `"user"` so the host's own
> user-level `settings.json` — which carries a `SessionStart` hook that reaps processes — could not
> run on a capture. Hook coverage was obtained instead from a project-level `.claude/settings.json`
> in the sandbox; see observation **9**.

| # | File | `Options` beyond the common set | Demonstrates |
|---|---|---|---|
| 1 | `01-init-plain-text.ndjson` | none (default model → `claude-opus-4-8[1m]`) | init + one plain-text turn: `system/init`, `rate_limit_event`, the full `stream_event` delta sequence, `assistant`, `result` with `usage`/`modelUsage`/`total_cost_usd`. Also carries the `initializationResult()` response. |
| 2 | `02-tool-read-auto-allowed.ndjson` | `model:"sonnet"`, `canUseTool` installed | `Read` (and an `ls` `Bash`) in the default mode: `tool_use` → `tool_result` blocks, and **zero** `canUseTool` calls — see observation **1**. |
| 3 | `03-bash-approval-accept.ndjson` | `model:"sonnet"`, `canUseTool` | a Bash call that really does prompt (`rm -f …`) → `accept` = `{behavior:"allow", updatedInput}`. Records the callback's full argument set incl. `suggestions`. |
| 4a | `04a-bash-approval-decline.ndjson` | same | `decline` = `{behavior:"deny", message:"User declined tool execution."}` |
| 4b | `04b-bash-approval-cancel.ndjson` | same | `cancel` = `{behavior:"deny", message:"User cancelled tool execution."}` — byte-identical wire shape to 4a apart from the message, plus the `permission_denials` row on the `result`. |
| 5 | `05-accept-for-session.ndjson` | same, 2 turns | `acceptForSession`: allow **+** `updatedPermissions` rescoped to `destination:"session"` (T3's `toSessionPermissionUpdates`), then the same tool in a second turn with **no** second prompt. The sandbox also had a slow (3 s) `PreToolUse` hook for this run. |
| 6 | `06-ask-user-question.ndjson` | `model:"sonnet"`, `canUseTool` | `AskUserQuestion` intercepted before any approval logic; answered by **question text**, and the CLI's echo proving the key is the text. |
| 7 | `07-subagent-task.ndjson` | `model:"sonnet"`, 2 turns | a subagent (`system/task_started` → `task_progress` → `task_updated` → `task_notification`, `parent_tool_use_id` on the nested messages) and a **background** Bash task (`system/background_tasks_changed`). |
| 8 | `08-todowrite.ndjson` | `model:"sonnet"` | the step-list tools — which are **`TaskCreate` / `TaskUpdate`**, not `TodoWrite`. See observation **3**. |
| 9 | `09-plan-mode-exitplanmode-denied.ndjson` | `model:"sonnet"`, `setPermissionMode("plan")` before the turn, back to `"default"` after | plan mode; `ExitPlanMode` arriving through `canUseTool` and being denied with T3's fixed message; the plan markdown **and** the new `planFilePath`. |
| 10 | `10-interrupt-mid-turn.ndjson` | `model:"sonnet"` | `query.interrupt()` mid-turn: the receipt it resolves to, the synthetic `[Request interrupted by user]` user message, the `result/error_during_execution` with `terminal_reason:"aborted_streaming"` and the `[ede_diagnostic]` error, and what `q.return()` yields afterwards. |
| 11 | `11-resume-and-fork.ndjson` | `model:"sonnet"`; then `resume`; then `forkSession()` and `resume`+`resumeSessionAt`+`forkSession:true` | three query lifetimes in one file: two turns, a resume by session id in a **new** `query()`, and the rollback path (both the standalone `forkSession()` helper and the `query()` option form). |
| 12 | `12-compact.ndjson` | `model:"sonnet"`, 3 turns | `/compact` sent as an ordinary streamed turn: `system/compact_boundary` with `compact_metadata`, and the odd `result` shape a compaction turn produces. |
| 13 | `13-probe-never-yielding.ndjson` | `persistSession:false`, `abortController`, `settings:{disableAllHooks:true}`, `allowedTools:[]`, `mcpServers:{}`, `strictMcpConfig:true`, `stderr:()=>{}` — **no `includePartialMessages`, no `canUseTool`**, and a prompt generator that never yields | the capability probe. `initializationResult`, `supportedCommands` (43), `supportedModels` (5), `supportedAgents` (5), `mcpServerStatus`, the usage API and `getContextUsage`. **No API call is made, so this one is free to re-capture.** |
| 14a | `14a-accept-edits-edit.ndjson` | `permissionMode:"acceptEdits"` | a `Write` plus a mutating `Bash` under accept-edits: **zero** `canUseTool` calls. |
| 14b | `14b-bypass-permissions-edit.ndjson` | `permissionMode:"bypassPermissions"` + `allowDangerouslySkipPermissions:true` | the same two tools under full access: also zero calls. |
| 15 | `15-rate-limits-and-usage.ndjson` | `model:"haiku"` | the `rate_limit_event` the CLI emits unprompted, plus the two read-only usage APIs mid-session. No quota was deliberately consumed. |
| 16 | `16-errors.ndjson` | phase A `model:"claude-does-not-exist-9"`; phase B `model:"sonnet"` | an unknown model (a `result` that says `subtype:"success"` while `is_error:true`), and two failing tools (`Bash` exiting 1, `Read` on a missing file). |

## What the capture contains, in aggregate

SDK message `type`/`subtype` values observed across all 18 files:

```
assistant                          command_lifecycle              rate_limit_event
result/success                     result/error_during_execution  stream_event
system/init                        system/status                  system/thinking_tokens
system/compact_boundary            system/background_tasks_changed
system/task_started                system/task_progress           system/task_updated
system/task_notification           user
```

`stream_event` shapes: `message_start`, `content_block_start:{text,thinking,tool_use}`,
`content_block_delta:{text_delta,thinking_delta,signature_delta,input_json_delta}`,
`content_block_stop`, `message_delta`, `message_stop`.

Tool names seen: `Agent`, `AskUserQuestion`, `Bash`, `ExitPlanMode`, `Read`, `TaskCreate`,
`TaskUpdate`, `ToolSearch`, `Write`.

---

# Protocol observations

Every place reality differs from spec §4.5 (Claude) / §4.4 / §4.2 or from T3's
`apps/server/src/provider/Layers/ClaudeAdapter.ts`. **This is the part the adapter author must
read.** Frames are quoted from the committed fixtures.

### 1. `canUseTool` is *not* the whole approval surface — the CLI gates first, silently

Spec §4.5: *"`canUseTool` is the whole approval surface."* It is not. In CLI 2.1.210 the callback
only fires for tool calls the CLI's **own** classifier decides to prompt about. Everything it
auto-allows, auto-denies or rewrites never reaches the adapter, and there is **no message on the
stream** saying so.

- `02-tool-read-auto-allowed.ndjson` — `permissionMode: "default"`, `canUseTool` installed. Two
  tool calls run (`Bash {"command":"ls a.txt 2>&1"}` and `Read`), both succeed, and the file
  contains **zero** `canUseTool` lines. `echo hi` behaved the same way in an earlier run of
  scenario 3, which is why the committed fixture uses `rm -f` instead.
- `10-interrupt-mid-turn.ndjson` — the CLI **denies** a tool on its own, with a `tool_result` the
  adapter never authorised:
  ```json
  {"type":"tool_result","content":"<tool_use_error>Blocked: sleep 120 followed by: echo woke. To wait for a condition, use Monitor with an until-loop …</tool_use_error>","is_error":true,"tool_use_id":"toolu_017W5vmVebxd2MGT713Qqsu7"}
  ```
  This is the `tool.denied` case (§4.2: *"a policy/hook deny with no user approval behind it"*) —
  but it arrives as an ordinary `user`/`tool_result` block, **not** as a
  `system/permission_denied` message. T3 only emits `tool.denied` from
  `system` subtype `permission_denied` (`ClaudeAdapter.ts:3977-3989`), which this capture never
  produced. An adapter that wants a `tool.denied` row here must detect
  `is_error && content startsWith "<tool_use_error>"` on the `tool_result`.

Consequence for the design: **the timeline cannot equate "a tool ran" with "we approved it"**, and
the approval card count is not the tool count.

### 2. `acceptEdits` and `bypassPermissions` both silence `canUseTool` completely — including for Bash

Spec §4.4 maps Accept-edits to `permissionMode: acceptEdits` and expects only *edits* to be
auto-accepted. In this CLI, `14a-accept-edits-edit.ndjson` runs **both** a `Write` **and**
`Bash {"command":"rm -f scratch-tmp.txt"}` — the exact command that prompts in `default` mode —
and records `{"note":"finished","canUseToolCalls":0,"mode":"acceptEdits"}`.
`14b-bypass-permissions-edit.ndjson` is the same: `canUseToolCalls: 0`.

So of the four `RuntimeMode`s, only **`approval-required`** ever produces an approval card through
`canUseTool`, and even then only for what the CLI chooses to ask about (observation 1). The
"`full-access` short-circuits to allow with no event" rule of §4.3 is therefore already the
*CLI's* behaviour in `acceptEdits` too — the adapter's own short-circuit is belt-and-braces.

### 3. There is no `TodoWrite` tool — it is `TaskCreate` + `TaskUpdate`

`08-todowrite.ndjson` was prompted with the literal words "use the TodoWrite tool". The model
never called it; it called **`TaskCreate`** three times and **`TaskUpdate`** five times:

```json
{"name":"TaskCreate","input":{"subject":"read a.txt","description":"Read contents of a.txt"}}
{"name":"TaskUpdate","input":{"taskId":"1","status":"in_progress"}}
```

`TaskUpdate.status` values seen: `in_progress`, `completed`. The task id is a **decimal string
counter** (`"1"`, `"2"`, `"3"`), not a uuid. Any `turn.plan.updated` fold keyed on a `TodoWrite`
tool name, or on a `todos: [{content, status, activeForm}]` input array, will produce nothing on
this CLI version. Note also that these are *not* the same ids as the `task_id` on
`system/task_*` (observation 4) — two unrelated id spaces both called "task".

### 4. The subagent tool is named `Agent`, not `Task`

Spec §4.5 and §4.2 say "a subagent via the Task tool". `07-subagent-task.ndjson`:

```json
{"name":"Agent","input":{"description":"Read b.txt first word","subagent_type":"Explore","prompt":"…","run_in_background":false}}
```

The `system/task_*` messages that describe it are correctly named, and carry the linkage §4.2
requires — but `task_started` / `task_progress` / `task_notification` carry `tool_use_id`,
`description`, `subagent_type`, `task_type` while **`task_updated` carries almost nothing**:

```json
{"type":"system","subtype":"task_started","task_id":"a50bfe4d113f2b3b2","tool_use_id":"toolu_018p31…","description":"Read b.txt first word","subagent_type":"Explore","task_type":"local_agent","prompt":"…","uuid":"…","session_id":"…"}
{"type":"system","subtype":"task_progress","task_id":"a50bfe4d113f2b3b2","tool_use_id":"toolu_018p31…","description":"Running Check if b.txt exists in target directory","subagent_type":"Explore","usage":{"total_tokens":11447,"tool_uses":1,"duration_ms":1424},"last_tool_name":"Bash","uuid":"…","session_id":"…"}
{"type":"system","subtype":"task_updated","task_id":"a50bfe4d113f2b3b2","patch":{"status":"completed","end_time":1789955074758},"uuid":"…","session_id":"…"}
{"type":"system","subtype":"task_notification","task_id":"a50bfe4d113f2b3b2","tool_use_id":"toolu_018p31…","status":"completed","output_file":"~/tmp/claude-999/…/tasks/a50bfe4d113f2b3b2.output","summary":"The first word in …/b.txt is:\n\n**hello**","usage":{"total_tokens":11762,"tool_uses":2,"duration_ms":4100},"uuid":"…"}
```

This directly contradicts §4.2's *"Task rows repeat their whole linkage block on **every** row, not
just `task.started`, so a client fold can rebuild an agent whose start row aged out."* **The
provider does not repeat it** — `task_updated` has `task_id` and a `patch` and nothing else. The
rule is still achievable, but it is the **adapter's** job: it must carry the identity forward from
its own `taskAgents` map (which is exactly what T3 does at `ClaudeAdapter.ts:3745-3760`). Do not
expect the provider to supply it.

Other notes on this group:

- **`task_progress.description` is the agent's live activity, not the task's name** — "Running
  Check if b.txt exists…", "Reading b.txt" above; a live 2.1.278 thread showed "Editing
  packages/ui/…/AgentDrillIn.tsx", "Grepping compaction contracts…". Only `task_started` names the
  task (`"Read b.txt first word"`). The adapter therefore never lets a progress frame overwrite a
  known description — it fills one only for a task that has none (a resumed subagent's
  `task_started` may carry no description) — because the description is the linkage `title` and
  every roster row was being retitled with whatever its agent was doing last.
- **A resumed subagent keeps its `task_id` and gets a NEW `tool_use_id`** (`task_started` again,
  `is_backgrounded: true`, same `task_id`, different `tool_use_id`). The roster fold reopens a
  terminal row only on that changed `tool_use_id`; a start row that names the old call after a
  terminal state is still the late/out-of-order delivery T3 guards against.
- `task_type` is `local_agent` for a subagent and **`local_bash`** for a backgrounded Bash — that
  is the discriminator behind §4.2's `agentKind: agent | background`.
- A background Bash emits `system/background_tasks_changed` **before** its `task_started`:
  ```json
  {"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b2udciqxi","task_type":"local_bash","description":"Sleep 20 seconds then print slept"}],…}
  ```
  Spec §4.2 lists no event for this; T3 consumes it at `ClaudeAdapter.ts` `case "background_tasks_changed"`.
  It is the only frame that reports the **whole** live background set — but it is a **level**, and
  it must NOT be correlated with the `task_started`/`task_notification` edges. See observation 18.
- The subagent's own narration arrives on the main stream stamped
  `parent_tool_use_id: "toolu_018p31…"` — on `assistant` messages **and** on a leading `user`
  message that is plain `text`, not a `tool_result`. §4.5's "subagent narration is dropped from the
  parent transcript while its tool blocks are kept" is a T3 *policy*, not something the provider does.
- **A subagent is never STREAMED, and its `thinking` is forwarded like its prose.** Every nested
  frame is a COMPLETE `assistant`/`user` message (a live 2.1.278 thread: 882 nested `tool_use`
  blocks, 179 nested `assistant` frames, **0** nested `stream_event`s), and those frames carry
  `text`, `tool_use` **and `thinking`** blocks — with `subagent_type` and `task_description` at the
  top level, which is the join for a resumed agent. The same thread held 50 nested `thinking`
  blocks; an adapter that reads only `text` drops every one of them, and the agent's drill-in shows
  the tools with none of the reasoning that chose them. Nested stream frames are therefore dropped
  whole by the adapter rather than half-handled: every piece of a normaliser's stream bookkeeping
  (the current `message_start` id, text blocks keyed by content index, in-flight tools keyed by
  index) belongs to the parent's message, and a subagent's indexes restart at 0 just like the
  parent's.
- `task_notification.output_file` points at a path under the CLI's own tmp tree, outside `cwd` and
  outside `fsRoot`. If the UI ever offers to open it, that read cannot go through `/api/fs/*`. It
  is `~`-abbreviated **in this capture only** because the capture's `TMPDIR` sat under `HOME`; in
  production the daemon sets `TMPDIR=/var/lib/orquester/tmp` and the path arrives absolute. A
  consumer must handle both (observation 18).

### 5. `system/init` is emitted **once per turn**, not once per session

Every multi-turn fixture shows it. `05-accept-for-session.ndjson` (2 turns) contains two
`system/init` messages; `12-compact.ndjson` (3 turns) contains four — one per turn plus one
immediately after the compaction boundary; `07-subagent-task.ndjson` two.

T3 maps `init` to a `session.configured` event (`ClaudeAdapter.ts:3620-3628`). Emitting a
session-configured event per turn would spam the timeline and, worse, re-announce a `model` /
`permissionMode` the user did not change. **Treat `system/init` as idempotent state, and diff it.**
Its keys in 2.1.210:

```
type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands,
apiKeySource, claude_code_version, output_style, agents, skills, plugins, capabilities,
analytics_disabled, product_feedback_disabled, uuid, memory_paths, fast_mode_state
```

`capabilities` is new and is where the interrupt-receipt contract is advertised:
`"capabilities":["interrupt_receipt_v1","msg_lifecycle_v1"]`. Note it is on the **`system/init`
message**, *not* on the `initializationResult()` control response — `10-interrupt-mid-turn.ndjson`
records `{"op":"initializationResult.capabilities","result":null}` for exactly that reason.

### 6. Three message types T3's demux switch does not handle at all

All three appear in almost every fixture, so they are not edge cases.

**`system/status`** — 53 occurrences. T3 *does* map this one
(`ClaudeAdapter.ts:3629-3639`, `status === "compacting" ? "waiting" : "running"`), but the only
value this CLI emitted is `"requesting"`:
```json
{"type":"system","subtype":"status","status":"requesting","uuid":"…","session_id":"…"}
```
T3's mapping turns every one of these into a `session.state.changed {state:"running"}`. At ~3 per
turn that is pure noise on the event bus; the ingestion layer (§5.1) must dedupe by state or the
adapter must only emit on a change.

`12-compact.ndjson` shows the **other** shape, the one a `/compact` turn produces, and a live
thread (2026-09-22) shows it six times in a row:
```json
{"type":"system","subtype":"status","status":"compacting","uuid":"…","session_id":"…"}
{"type":"system","subtype":"status","status":null,"compact_result":"success","uuid":"…","session_id":"…"}
```
`SDKStatusMessage` is `{status: 'compacting' | 'requesting' | null, compact_result?: 'success' |
'failed', compact_error?: string}`. Mapped to `running` alone, the client shows a generic
"Working" for the 10.3 s (much longer on a real thread) that the CLI spends rewriting the
conversation. The adapter therefore latches the FIRST `compacting` into a
`thread.state.changed {state:"compacting"}` and ends the phase on the next non-compacting status:
`compact_result: "failed"` becomes `compaction-failed` **plus a warning** — a failed compaction
emits **no `compact_boundary` at all**, so that status frame is the only notice the user will ever
get. A success is silent here because the boundary follows with the real before/after counts.

**`system/thinking_tokens`** — 23 occurrences, several per second during extended thinking:
```json
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"uuid":"…","session_id":"…"}
```
T3 has a `case "thinking_tokens":` that falls through to the shared "consumed deliberately" arm.
It is the only live signal of thinking progress when `thinking.display` is not `summarized`, so it
is a candidate for the shimmering "thinking…" label of §7.3 — but it is **high frequency** and must
be batched (§5.6), never turned into one event per frame.

**`command_lifecycle`** — 57 occurrences, two or three per turn:
```json
{"type":"command_lifecycle","command_uuid":"2666908a-…","state":"queued","uuid":"…","session_id":"…"}
{"type":"command_lifecycle","command_uuid":"2666908a-…","state":"started","uuid":"…","session_id":"…"}
```
States seen: `queued`, `started` (no terminal state was observed). This is a **top-level message
type**, not a `system` subtype, and it is **not in the SDK's exported `SDKMessage` union** in
0.3.278 — so a `satisfies never` exhaustiveness guard written against that union will *compile*
while the frame arrives at runtime and falls into the `runtime.warning` arm. T3 special-cases it
before the switch (`sdkMessageType(message) === "command_lifecycle"` → `return`), and the Orquester
adapter must do the same or every turn emits two spurious warnings.

### 7. A `user` message's `content` is sometimes a **plain string**, not a block array

`12-compact.ndjson`, immediately after the compaction boundary:

```json
{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. …"},"session_id":"…","parent_tool_use_id":null,"uuid":"…"}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"},"session_id":"…","parent_tool_use_id":null,"uuid":"…","timestamp":"…","isReplay":true}
```

Any normaliser that does `message.content.map(...)` or `for (const block of message.content)`
throws here — `.map is not a function` — and it throws on the **compaction** path, i.e. on a long
thread, i.e. exactly where it hurts. Guard every `content` read with `Array.isArray`.
Note the second one also carries `isReplay: true`, which is the marker for
"CLI-generated, not a real user turn" and must not become a user-message row.

### 8. Resume does **not** replay the transcript onto the message stream

`11-resume-and-fork.ndjson`, phase 2: a new `query({options:{resume: <sessionId>}})` over the same
session. The model answers correctly (`"ZEBRA, QUARTZ"`), so the history is loaded — but the
fixture records `{"note":"phase 2 replayed user-message uuids","replayUuids":[]}`: **not one**
`user` or `user_replay` message crossed the stream before the new turn. The same holds for the
fork in phase 3b (`forkUuids: []`).

This confirms §4.5's design — rollback must read native history out-of-band through
`getSessionMessages`, not by folding the stream — and it means `readThread`/`ThreadSnapshot`
reconciliation after a restart cannot be built from what `query()` yields.

Two things the capture settles positively:

- **A client-supplied `sessionId` is honoured verbatim.** `{"sessionIdWeGenerated":"b46b654b-57bb-40e4-8c82-d3536bd06a28","sessionIdTheCliReports":"b46b654b-57bb-40e4-8c82-d3536bd06a28"}`. The resume cursor can be generated host-side before the CLI starts.
- **A uuid we stamp on our own `SDKUserMessage` is a valid `resumeSessionAt` anchor**, which is what makes turn-granular rollback possible. Both forms work:
  ```json
  {"op":"forkSession","args":{"sessionId":"b46b654b-…","upToMessageId":"a8a2167c-…"},"result":{"sessionId":"d908c283-1c9a-45ee-9506-3ca4a69c8579"}}
  ```
  and the `query()` option form `{resume, resumeSessionAt, forkSession:true}`, which produced yet
  another new session id (`1cd693b5-…`) and a model that correctly recalled only `ZEBRA`. **Both
  mint a new session id**, so the persisted cursor must be rewritten after every rollback, and the
  original session is left intact.

### 9. Filesystem-configured hooks run, but emit **no** `system/hook_*` messages

Spec §4.5: *"There are no SDK hooks — the `hook.*` events are the user's own configured hooks
reported back as `system` messages."* Not in 2.1.210.

The sandbox's `.claude/settings.json` configured a `PreToolUse` hook on `Bash` that wrote a marker
file and slept 3 s. In `05-accept-for-session.ndjson` the hook demonstrably ran — the marker file
appeared, and the gap between the `tool_use` at `t=2924` and the `canUseTool` call at `t=5967` is
the hook's 3 s — yet the file contains **zero** `hook_started`, `hook_progress` or `hook_response`
messages. Same in `04a` with a fast hook.

Two consequences:

- The `hook.*` group of §4.2 has **no producer** on this CLI version for filesystem hooks. Either
  drop it from the Claude adapter's emit set for now, or accept that it only fires for hooks
  registered through the SDK's `hooks` option — which §4.5 forbids setting.
- **Hooks run before `canUseTool`.** A slow `PreToolUse` hook delays the approval card, not the
  tool. The "waiting for you" state of §7.6 must not be derived from "a tool_use block arrived".

> **Correction, found while implementing the adapter (W6).** The first bullet is wrong, and the
> cause is the capture's own deviation: these fixtures were taken with
> `settingSources: ["project","local"]`, dropping `"user"`. The adapter sets
> `["user","project","local"]` as §4.5 requires, and driving the real CLI that way
> (`smoke.ts`, claude **2.1.278**) produced `system/hook_started` and `system/hook_response`
> for the host's own user-level `SessionStart` hooks — four of each, with `hook_id`,
> `hook_name` (`SessionStart:startup`), `hook_event`, `outcome`, `exit_code` and `stdout`.
> So the `hook.*` group **does** have a producer, the Claude adapter emits it, and a re-capture
> with the user source enabled should record it.

Related trap discovered while setting this up: **project-level `.claude/settings.json` is silently
ignored in an untrusted directory.** Until the sandbox's `hasTrustDialogAccepted` was set, the
hooks did not run and no message said so. Orquester creates project directories, so every new chat
tab starts untrusted; project settings, project hooks and project skills will be invisible until
something trusts the directory, with no signal on the wire.

### 10. `ExitPlanMode` carries a `planFilePath`, and plan mode writes a file nobody approved

`09-plan-mode-exitplanmode-denied.ndjson`. `setPermissionMode("plan")` issued before the first turn
is honoured — the turn's `system/init` reports `"permissionMode":"plan"`. Then:

```json
{"name":"Write","input":{"file_path":"~/plans/plan-do-not-implement-fizzy-shell.md","content":"# Plan: Create c.txt\n…"}}
```

That `Write` **succeeded** and never reached `canUseTool`, in plan mode, to a path **outside `cwd`**
(under `CLAUDE_CONFIG_DIR`). Plan mode is not read-only. Then:

```json
{"name":"ExitPlanMode","input":{"plan":"# Plan: Create c.txt\n\n**Context:** …","planFilePath":"~/plans/plan-do-not-implement-fizzy-shell.md"}}
```

T3's `extractExitPlanModePlan` reads only `plan`. The new `planFilePath` should ride along on
`turn.proposed.completed` — it is the handle for "open the plan the CLI actually saved", and it is
the only way to correlate the plan card with the file the next turn may edit.

The deny works exactly as designed, and the denial is echoed on the `result`:

```json
"permission_denials":[{"tool_name":"ExitPlanMode","tool_use_id":"toolu_013B3vPWVLa1k9RsTV1R9wXk","tool_input":{"plan":"…","planFilePath":"…"}}]
```

`result.permission_denials` carries the **full tool input** — useful for reconstructing a declined
card after a reconnect, and something to keep out of any log that is not already trusted with tool
inputs.

The model also called **`ToolSearch`** (`{"query":"select:ExitPlanMode","max_results":1}`) to load
`ExitPlanMode`'s schema first. Deferred tools are a live part of this CLI's tool space; the
`itemType` classifier of §4.2 has no arm for a tool-loading call and will land it in `unknown`.

### 11. `canUseTool`'s third argument carries five fields T3 ignores, one of which matters

`03-bash-approval-accept.ndjson`:

```json
{"signal":"…","suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"rm -f scratch-tmp.txt"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["…/sandbox"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blockedPath":"…/sandbox/scratch-tmp.txt","displayName":"Bash","description":"Remove scratch-tmp.txt","toolUseID":"toolu_01PpiUNR3V2PoJVR419oroP9","requestId":"c2648055-c40a-4c3f-b3de-e65803eed8d0"}
```

T3 reads `signal`, `suggestions` and `toolUseID` only.

- **`requestId`** is the one that matters. The SDK's own doc for `Query.reinitialize()` says
  in-flight request ids are deduped SDK-side but *"callbacks should be idempotent per request_id
  since a request whose response was lost in the gap will be dispatched again."* Keying the
  adapter's `pendingApprovals` map on a freshly minted uuid (as T3 does) means a redelivered
  request opens a **second** approval card for the same tool call. Key on `requestId`, or at least
  dedupe on it.
- `displayName` / `description` / `blockedPath` are free, provider-authored strings for the
  approval card — `description` is the model's own one-line summary of the command, which is
  better than anything `summarizeToolRequest` can reconstruct, and `blockedPath` names the exact
  path that triggered the prompt.
- `suggestions` confirms §4.3's rationale: the first suggestion really does target
  `destination: "localSettings"`, so echoing it verbatim for `acceptForSession` would write a
  permanent rule into `.claude/settings.local.json`. The rescope to `"session"` is load-bearing.
  The capture also verifies it **works**: `05-accept-for-session.ndjson` records
  `canUseToolCalls: 1` after two turns that each ran the same `rm -f`.

`AskUserQuestion` and `ExitPlanMode` arrive with **no `suggestions` key at all** (`06`, `09`), so
`toSessionPermissionUpdates`'s fallback arm is the live path for them.

### 12. `AskUserQuestion`: the "id is the question text" rule is confirmed, and the option shape is fixed

`06-ask-user-question.ndjson`. The tool input:

```json
{"questions":[{"question":"Which file should I read?","header":"File choice","options":[{"label":"a.txt","description":"Read a.txt and report its first word"},{"label":"b.txt","description":"Read b.txt and report its first word"}],"multiSelect":false}]}
```

The reply (T3's shape, which works unchanged):

```json
{"behavior":"allow","updatedInput":{"questions":[…the original array…],"answers":{"Which file should I read?":"a.txt"}}}
```

and the CLI's echo, which is the proof the key is the text and not an index:

```json
{"type":"tool_result","content":"Your questions have been answered: \"Which file should I read?\"=\"a.txt\". You can now continue with these answers in mind.","tool_use_id":"toolu_01YaZd2nRni8zbMRSu5n7LPp"}
```

Notes: `multiSelect` is present on the wire (so §4.2's "defaults to `false`" is a fallback, not the
norm); options have `label` + `description` and **no `value`**, so §4.2's
`options: [{label, description, value?}]` will always see `value` absent for Claude; and the answer
is the option **`label`**, not an id. Because the key is free text, two questions with identical
text in one request are indistinguishable — the adapter should reject or disambiguate that case
rather than silently answering one.

### 13. `result` is not one shape — three variants in the capture, and `terminal_reason` is optional

| fixture | `subtype` | `is_error` | `stop_reason` | `terminal_reason` | note |
|---|---|---|---|---|---|
| `01`, `03`, … | `success` | `false` | `end_turn` | `completed` | the normal turn |
| `10` | `error_during_execution` | `true` | `tool_use` | `aborted_streaming` | interrupted |
| `12` (the `/compact` turn) | `success` | `false` | **`null`** | **absent** | `num_turns: 0`, `result: ""` |
| `16` phase A | **`success`** | **`true`** | `stop_sequence` | `api_error` | `api_error_status: 404` |

Three things follow.

- **`terminal_reason` is missing entirely on the compaction result.** T3 reads it unconditionally.
  A compaction turn must not be classified from it.
- **`subtype: "success"` does not mean success.** The unknown-model result is `subtype:"success"`
  with `is_error:true` and `api_error_status:404`, and the user-facing text is the CLI's own
  sentence: `"There's an issue with the selected model (claude-does-not-exist-9). It may not exist
  or you may not have access to it."` This generalises the §4.5 trap about 529s arriving as a
  success result: **always branch on `is_error` and `api_error_status`, never on `subtype`.**
- **The `[ede_diagnostic]` trap is real but the reason differs.** §4.5 says interrupting mid-tool
  yields `terminal_reason:"aborted_tools"`. The capture yields **`"aborted_streaming"`**, with:
  ```json
  "errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]
  ```
  Filter the `[ede_diagnostic]` prefix out of any user-facing banner, and do not match on
  `aborted_tools` alone.

`result` also carries, on every non-error turn: `total_cost_usd`, a `usage` block with
`cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens` and an `iterations[]` array, plus
**`modelUsage`, a per-model map**:

```json
"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":523,…,"contextWindow":200000,"maxOutputTokens":32000},"claude-opus-4-8[1m]":{"inputTokens":2,…,"contextWindow":1000000,"maxOutputTokens":64000}}
```

Two things there: the `[1m]` suffix appears in a **model-usage key**, so §4.5's manifest-suffix
model id round-trips; and a *cheap* model shows up in the map on nearly every turn (the CLI runs
haiku for its own internal calls), so "the model of this turn" must come from `turn.started` /
`system/init`, never from `Object.keys(modelUsage)`. `contextWindow` and `maxOutputTokens` are
reported per model here — the context meter of §7.6 can read its denominator straight off the
result instead of a manifest.

### 14. `interrupt()` resolves with a receipt; `q.return()` is instant

`10-interrupt-mid-turn.ndjson`:

```json
{"op":"interrupt","phase":"resolved","result":{"still_queued":[]}}
{"op":"query.return","elapsedMs":157,"result":{"done":true}}
```

`still_queued` is the `interrupt_receipt_v1` contract: the uuids of async user messages that
**will still run unless cancelled first**. §4.5 says Stop should close the query rather than call
`interrupt()` "because `interrupt()` can acknowledge while resumed background tasks keep the CLI
alive" — this receipt is how you *detect* that case, and it was empty here. The capture also shows
`q.return()` completing in 157 ms with `{done:true}`, and that the interrupt itself produces a
synthetic transcript entry the timeline should recognise:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,…}
```

Note this one has `content` as an array while the compaction ones (observation 7) do not — both
shapes occur for the same message type.

### 15. The probe works as designed, and returns more than §4.5 expects

`13-probe-never-yielding.ndjson`, with the exact options §4.5 prescribes. No API call is made; the
whole file costs nothing.

```
initializationResult                                      1195ms   ok
supportedCommands                                            0ms   43 items
supportedModels                                              0ms    5 items
supportedAgents                                              0ms    5 items
mcpServerStatus                                             49ms    0 items
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET  8908ms   ok
getContextUsage(summary)                                   650ms   ok
```

- `initializationResult()` keys: `commands, agents, output_style, available_output_styles, models,
  account, pid, remote_control_auto_enable, remote_control_auto_on_by_default,
  ide_rc_auto_enable_gate`. `account` is
  `{email, organization, subscriptionType, apiProvider}` — §4.5 expects
  `{email, subscriptionType, tokenSource, apiProvider}`; **`tokenSource` was absent** and
  `organization` is new. `subscriptionType` is the display string `"Claude Max"`, not a slug.
- **`supportedModels()` exists and is free** — §4.5's *"Models are a manifest, not a call"* is a
  T3 choice, not a necessity. Its shape is **not** §4.1's `{slug, name, shortName?, …}`:
  ```json
  {"value":"default","resolvedModel":"claude-opus-4-8[1m]","displayName":"Default (recommended)","description":"Opus 4.8 with 1M context · Best for everyday, complex tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsFastMode":true,"supportsAutoMode":true}
  ```
  `value` is the launch alias, `resolvedModel` the id that comes back in `modelUsage`.
  `supportedEffortLevels` is a per-model enum that includes **`xhigh`** and **`max`** — §4.1's
  `effort` descriptor must not hard-code low/medium/high. `supportsFastMode` and `supportsAutoMode`
  are per-model too, so §4.1's `fastMode` descriptor has to be gated on the selected model.
  The `haiku` entry omits every capability flag, i.e. absence means "not supported", not "unknown".
- The 8.9 s `usage_EXPERIMENTAL…` call justifies §4.5's separate deadline. Its
  `rate_limits.limits[]` is already exactly §4.1's `usageLimits.windows` shape:
  ```json
  {"kind":"session","group":"session","percent":83,"severity":"warning","resets_at":"…","scope":null,"is_active":true}
  {"kind":"weekly_all","group":"weekly","percent":66,…}
  {"kind":"weekly_scoped","group":"weekly","percent":59,"scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}
  ```
  Note `weekly_scoped` rows are distinguished **only** by `scope`, so §4.1's "stable `id` per
  window" must be derived as `kind` + a scope discriminator, or two weekly rows collapse onto each
  other. The response also carries `rate_limits_available`, a legacy `five_hour`/`seven_day` map
  beside `limits[]`, a dozen `null` codename windows (`nimbus_quill`, `cedar_ember`, …) that must
  be skipped rather than rendered, and an `extra_usage` block with a credit balance.

### 16. `rate_limit_event` arrives unprompted, once per session, before any assistant output

Present in **every** fixture that ran a turn (21 occurrences), typically ~700 ms after
`system/init`:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789969200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false},"uuid":"…","session_id":"…"}
```

`resetsAt` is **epoch seconds**, not the ISO string the usage API returns for the same window —
two different encodings of the same reset. The frame has **no percentage**: it carries `status`
(`allowed`), the window kind, and overage state only. So §4.2's
`account.rate-limits.updated {windows}` cannot be filled from this event alone; it is a
*trigger* to re-read `usage_EXPERIMENTAL…`, or at best a source for the reset time and a
"limited" flag. This is also the only rate-limit signal that arrives on the stream during a turn —
`15-rate-limits-and-usage.ndjson` shows a second one landing mid-turn after a later request.

> **Correction, found while implementing the adapter (W6).** "No percentage" holds for the
> unprompted `status: "allowed"` frames only. The **warning-level** frame in the same capture
> does carry one:
>
> ```json
> {"status":"allowed_warning","resetsAt":1789969200,"rateLimitType":"five_hour","utilization":0.98,"isUsingOverage":false,"surpassedThreshold":0.9}
> ```
>
> `utilization` is a **0–1 fraction** there, while the usage API's `limits[].percent` is 0–100.
> So `account.rate-limits.updated` *can* be filled from a streamed event — but only when one is
> present. The adapter maps the frame when it carries `utilization` and otherwise marks the cached
> snapshot stale for the next probe (`rateLimitEventToUpdate` in
> `apps/daemon/src/agent-host/adapters/claude/usage.ts`).

### 17. Miscellaneous, smaller

- **`assistant` messages carry `request_id`** (`type, message, parent_tool_use_id, session_id,
  uuid, request_id`), which is the Anthropic API request id — useful in `providerRefs` for
  correlating a captured log with a support ticket.
- **`stream_event` covers thinking too**: `content_block_start:thinking`,
  `content_block_delta:thinking_delta` and `content_block_delta:signature_delta`. §4.2's
  `streamKind` union has `reasoning_text` and `reasoning_summary_text`; the signature delta maps to
  neither and must be dropped explicitly rather than falling into `unknown`.
  `content_block_delta:input_json_delta` is by far the highest-volume frame (315 of 728 stream
  events) — it is the tool-input being typed out, and batching it (§5.6) is what keeps the
  timeline cheap.
- **Content indexes restart at 0 with every API message, and a turn has many of them.** One
  `message_start` per tool round-trip; each message's `content_block_*` indexes start again at 0
  (a thinking block at 0, the text at 1, the tool_use at 2, …). Any per-turn bookkeeping keyed on
  the bare index therefore joins a later message's text to an earlier message's block — which is
  exactly how a long turn's final summary once landed inside its opening bubble (live thread
  8b9a20c2: four messages' worth of text under one item id). The normaliser keys assistant text
  block state by `(message.id, index)`; the complete per-block `assistant` frames carry the same
  `message.id` as the stream's `message_start`, which is the join.
- **`compact_metadata` is richer than `beforeTokens`/`afterTokens`:**
  ```json
  {"trigger":"manual","pre_tokens":34995,"post_tokens":873,"cumulative_dropped_tokens":34122,"duration_ms":10330,"preserved_segment":{"head_uuid":"803f7bad-…","anchor_uuid":"63734266-…","tail_uuid":"803f7bad-…"},"preserved_messages":{"anchor_uuid":"63734266-…","uuids":["803f7bad-…"],"all_uuids":["803f7bad-…"]}}
  ```
  `trigger` distinguishes a user `/compact` from an auto-compaction (§4.2's
  `thread.state.changed {compacted}` has nowhere to put that today). `preserved_messages.all_uuids`
  is exactly what §4.5's rollback needs to decide "a compaction happened in between" — it names the
  uuids that survived, so a rollback anchor not in that set is unreachable and the adapter can say
  so precisely instead of failing the deep-equal scan.
- **A compaction turn emits its own `system/init` afterwards**, before the boundary message — one
  more reason not to treat `init` as session-scoped (observation 5).
- **`/compact` really does work as a plain turn**, with the text block last, exactly as §4.5
  describes. Its `result` reports `total_cost_usd: 0.075` against `modelUsage` for the *real*
  model, so a compaction is a billable turn and belongs in the cost line.
- **The stream carries no turn-boundary event.** There is no `turn.started` analogue; the only
  markers are the `input` we push and the `result` that ends it. Turn identity is entirely
  host-side, which is why §4.5's "stamp `uuid: turnId` on the `SDKUserMessage`" is not an
  optimisation but the only mechanism available.

### 18. Background shells: `is_backgrounded`, the level signal, and where the output actually goes

Observed on a **live** thread (2026-09-22), not in these captures — `07-subagent-task.ndjson`
predates `is_backgrounded` and its `task_started` carries no such field. Three things the adapter
now depends on:

**a. `is_backgrounded` is the foreground/background discriminator, and it is per task.**

```json
{"type":"system","subtype":"task_started","task_id":"brnajdlv7","tool_use_id":"toolu_014o…","is_backgrounded":false,"task_type":"local_bash",…}
{"type":"system","subtype":"task_started","task_id":"bvf4wz8g5","tool_use_id":"toolu_01St…","is_backgrounded":true,"task_type":"local_bash",…}
```

**Every ordinary Bash call raises a `local_bash` task**, not just a `run_in_background` one — the
foreground ones simply carry `is_backgrounded: false`. Surfacing those as tasks made every `ls`
flash a roster row that read like a subagent (owner report, 2026-09-22). A foreground `local_bash`
is the blocking tool call's own row and is not surfaced at all; a later
`task_updated {patch: {is_backgrounded: true}}` (the user's Ctrl+B) promotes it, and *that* is
where its roster life begins. `ambient` / `skip_transcript` tasks are likewise not activity — the
SDK says so outright. An **absent** field is not `false`: a capture from an older CLI (like 07)
must keep behaving as before.

**b. `background_tasks_changed` is a LEVEL. Do not correlate it with the edges.** The SDK doc is
explicit: *"Ordering relative to the bookends for the same transition is unspecified (in practice
the level precedes them) and the payload carries ids only, so do not correlate it with the edge
stream."* The live thread proves why:

```json
{"type":"system","subtype":"background_tasks_changed","tasks":[],…}                      ← first
{"type":"system","subtype":"task_updated","task_id":"bvf4wz8g5","patch":{"status":"completed","end_time":…}}
{"type":"system","subtype":"task_notification","task_id":"bvf4wz8g5","status":"completed","summary":"Background command \"…\" completed (exit code 0)",…}
```

Closing a live task on its absence from the level wrote `task.completed {status:"stopped"}` a
moment before the real completion, and the roster fold keeps the FIRST terminal status — so a shell
that finished cleanly read as interrupted forever. The level is still good for two things: naming a
task before its start edge (so the `task_started` that follows already has its linkage) and
clearing liveness promptly. Neither is a roster event. T3 ignores the level entirely
(`ClaudeAdapter.ts:3945-3959`).

**c. A background command's output is never on the SDK channel.** The launching Bash call's
`tool_result` is a placeholder naming a file:

```json
{"tool_use_id":"toolu_01St…","type":"tool_result","content":"Command running in background with ID: bvf4wz8g5. Output is being written to: /var/lib/orquester/tmp/claude-999/-var-lib-…/tasks/bvf4wz8g5.output. You will be notified when it completes. To check interim output, use Read on that file path.","is_error":false}
```

That line is the **only** place the path appears while the command runs — `task_notification`
reports `output_file` when it is already over (and `""` for a foreground task, which must not
overwrite what the launch line said). The adapter parses the path out of that text and the session
tails the file; without it the shell's drill-in read "This agent has not reported anything yet" for
the whole run. `task_notification.summary` carries the exit code as `(exit code N)` — the only
place the CLI reports it.

### 19. `getContextUsage({detail:"summary"})` is the CLI's own `/context`, and it is free

Scenario 13 captures it (650 ms, no API call — `summary` answers from the last response's usage
plus local estimates; only `detail:"full"` makes token-count requests, which is why T3 avoided the
call altogether):

```json
{"categories":[{"name":"System prompt","tokens":106,"color":"promptBorder"},
               {"name":"System tools (deferred)","tokens":13467,"color":"inactive","isDeferred":true},
               {"name":"Free space","tokens":984132,"color":"promptBorder"}],
 "totalTokens":15868,"maxTokens":1000000,"rawMaxTokens":1000000,"percentage":2,
 "autoCompactThreshold":967000,"isAutoCompactEnabled":true,
 "model":"claude-opus-4-8[1m]","apiUsage":null}
```

Three things the context meter (§7.6) depends on:

- **The denominator is `rawMaxTokens`**, not `maxTokens` — the SDK defines it as "the window
  usage is measured against: the resolved autocompact window", i.e. what the CLI's own percentage
  divides by. They agree here; they do not on a 1M-window model under a smaller compaction policy.
- **`autoCompactThreshold` is reported outright**, so the meter states the number the user will
  watch it approach instead of guessing; `isAutoCompactEnabled` is the only place the CLI says
  auto-compaction is *off*.
- **The captured `categories` carry no `kind` field.** The typed
  `SDKContextUsageCategory.kind` (`used`/`free`/`buffer`/`deferred`) is newer than this capture,
  so the "window minus the buffer rows" fallback sums to zero here and `autoCompactThreshold` is
  the only source. Classify on `kind` when it is there, never on the English name — and never
  require it.

An older CLI rejects the control request outright. It is a display refresh, so a rejection, a
timeout or an SDK with no such method is a debug line and the last known reading, never a
`runtime.warning` and never a failed turn.
### 20. The compaction summary is a synthetic `user` frame, and it is the marker's body

`12-compact.ndjson`, lines 47–49 — the three frames a successful `/compact` produces, in this
order and with nothing between them:

```json
{"type":"system","subtype":"compact_boundary","uuid":"f0c1c1a4-…","compact_metadata":{"trigger":"manual","pre_tokens":34995,"post_tokens":873,"preserved_segment":{"anchor_uuid":"63734266-…"},"preserved_messages":{"anchor_uuid":"63734266-…","all_uuids":["803f7bad-…"]}}}
{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n…\nContinue the conversation from where it left off…"},"parent_tool_use_id":null,"uuid":"63734266-…","isReplay":false,"isSynthetic":true}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"},"uuid":"65dbb734-…","isReplay":true}
```

Four things the adapter depends on:

- **The summary's `uuid` IS the boundary's `compact_metadata.preserved_messages.anchor_uuid`.**
  That is the only honest join between the two frames — `isSynthetic` alone does not say *which*
  compaction, and the preamble sentence is free text a user may paste. The adapter therefore
  HOLDS the boundary's `thread.state.changed {state:"compacted"}` for exactly one frame and
  releases it with `summary` when the next frame is that anchor; anything else (a `result`, a
  turn end, a closing session) releases it unchanged. The anchor match falls back to the preamble
  only for a boundary that named no anchor.
- **Its `content` is a plain string, not a block array** (observation 7 again), and on a real
  thread it is ~18 KB of markdown — the CLI's whole memory of everything it dropped. It must not
  become a user message: the timeline showed it as an 18 KB bubble the user never typed.
- **`isSynthetic: true` + `isReplay: false`** distinguish it from the `<local-command-stdout>`
  frame that follows (`isReplay: true`, still not a row). `SDKUserMessage.isSynthetic` is on the
  wire; `isCompactSummary` is **not** — that one exists only in the CLI's own transcript file, and
  is what `project-history.ts` keys on when a resumed thread replays the same summary out of
  native history.
- A **failed** compaction produces none of this: no boundary, no summary, only the
  `status {compact_result:"failed"}` frame (observation 6).

### 21. A rewind names its cut by turn id, and `turnBoundaries` is what resolves it

Not a capture — what observations 8, 17 and 20 imply for rollback, recorded where the next
adapter author will look. The resume cursor carries **`turnBoundaries`**: `{turnId, uuid}`
pairs, one per turn in start order, beside the legacy positional `turnStartMessageIds` (still
written, because an older host reads nothing else). `turnId` is **ours** — the fold's turn id,
the one the host names in `RollbackTarget.firstRemovedTurnId` — and `uuid` is the native
transcript uuid that turn starts at.

- For a turn `sendTurn` opened the two are **equal**: the `SDKUserMessage` is stamped
  `uuid: turnId` and the CLI keeps it (observation 8). A synthetic turn — assistant output
  between prompts — pairs its minted id with the assistant message that opened it.
- A fork **rewrites every uuid** (`11-resume-and-fork.ndjson`, phase 3b: *"the fork REWRITES
  every uuid"*), so after one rewind a kept turn starts at a uuid the host never saw. Every
  rewind therefore re-pairs each kept turn id with its fork uuid
  (`remapClaudeForkTurnBoundaries`); without the pair, a turn that survived one rewind could not
  be named by the next.
- At rewind time the transcript is read out-of-band (`getSessionMessages`) and the recorded pairs
  are merged, in transcript order, with an **identity pair for every human turn start no pair
  maps**: a turn of a resumed transcript that no cursor recorded is projected under its own uuid
  (`groupClaudeHistoryTurns`), so its id IS its uuid. A pair whose uuid the transcript no longer
  holds is stale and is dropped.

**Why the id wins over the host's `numTurns`.** The host counts over its fold; this adapter's
boundaries are a different list, and a count-based cut lands on the wrong turn **without
refusing**:

- A **resumed** thread (the §6.1 picker, or any cursor older than its history) has history turns
  in the host's fold that `turnStartMessageIds` never recorded — resume replays nothing onto the
  stream (observation 8). A rewind that reaches back into that history counts more turns than the
  cursor ever recorded, and the count path reads that as "roll back everything": a fresh session
  that forgets the history turns the user meant to keep.
- A **compaction** writes rows into the transcript that read as turn starts — the summary is a
  plain-string `user` row (observations 7 and 20) — while a live thread's fold turned that same
  summary into the compaction marker, not a turn.

The id resolves to exactly one turn start in the transcript, or the rewind refuses with the §4.5
"turn boundary is unavailable" text before any fork exists; a count that disagrees with it is
logged at debug and otherwise ignored.

## Re-capturing

Nothing here is generated; re-capturing means driving the real CLI again. Keep the format above,
re-run the redaction rules, and update the provenance block — a fixture whose CLI version is
unknown cannot be judged when the protocol moves (spec §9). Scenario 13 costs nothing and should be
re-run first whenever the CLI is upgraded: it alone will show a changed model list, a changed
account shape or a changed command set.
