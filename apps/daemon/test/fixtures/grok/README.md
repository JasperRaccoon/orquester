# Grok ACP protocol fixtures

Real Agent Client Protocol traffic recorded from the Grok CLI installed on this host, so the
Grok adapter (`apps/daemon/src/agent-host/adapters/grok/`) and its ACP client are written
against what the CLI *does* rather than what the spec assumes.

The method/type catalog derived from these captures lives in
`apps/daemon/src/agent-host/adapters/grok/acp/_generated/` (see its own `README.md`).

## Provenance

| | |
|---|---|
| CLI | `grok 1.0.34 (3736acbc8658) [stable]` — `@xai-official/grok` |
| Capture date | 2026-09-21 |
| ACP protocol version negotiated | `1` |
| Agent-reported version | `initialize` → `_meta.agentVersion: "1.0.34"` |
| Model | `grok-4.6` (the CLI default; `grok-4.5` also advertised) |
| Reasoning effort | `low` via `--reasoning-effort low` unless a file's argv says otherwise; the agent still reports `reasoning_effort: "high"` (see observation 17) |
| Transport | `grok … agent stdio`, JSON-RPC 2.0, one JSON object per line, both directions |
| Working directory | a throwaway `git init` sandbox outside any real project (two files: `add.js`, `README.md`) |
| Account | the Orquester **managed** Grok account home bound with `GROK_HOME=<appdir>/daemon/agent-accounts/grok/<id>/home` — the host CLI's own `~/.grok/auth.json` does not exist (see observation 2) |
| Harness | a plain Node script kept **outside** the repo at `/var/lib/orquester/tmp/agent-chat-fixtures/grok/` (not committed, by design — §9 says there is no record mode) |

### Sandbox configuration that shaped the captures

The sandbox carries a project config layer at `<cwd>/.grok/config.toml`:

```toml
[ui]
permission_mode = "default"

[features]
support_permission = true
```

`support_permission` is what makes the CLI issue `session/request_permission` at all
(observation 5). Everything else came from the host's user-scope `~/.grok/config.toml`,
which the managed account home symlinks.

## File format

NDJSON, one object per line:

```json
{"t": <ms since process spawn>, "dir": "send"|"recv"|"stderr"|"note", "frame": <verbatim JSON or string>}
```

- `send` — client → agent (the harness acting as the ACP client)
- `recv` — agent → client
- `stderr` — one line of the child's stderr
- `note` — harness annotation; never a wire frame

Frames are verbatim apart from the redaction and elision below.

### Redaction

Applied at record time and again on export:

- absolute home paths → `~`
- e-mail addresses → `<redacted-email>`
- API tokens (Atlassian `ATATT3…`, `ghp_`/`gho_`, `xox?-`, `sk-`, `xai-`, JWTs) → `<redacted-token>`
- the hostname → `<host>`
- **every `env` value of every MCP server definition → `<redacted>`** — see observation 1; those
  frames carry the host's real credentials

### Elision

Two mechanical reductions, each marked in-band by a `note` frame that states exactly what was
removed. Nothing else is altered.

1. A run of more than 30 consecutive `agent_thought_chunk` / `agent_message_chunk` frames keeps
   the first 25 and last 5; the rest are replaced by one note.
2. A notification payload ≥ 4 KiB that is identical (ignoring `sessionId` and `_meta`) to one
   already present in an earlier file is replaced by a note pointing at the file and `t` that
   holds it verbatim. This is almost entirely `available_commands_update`, which is ~33 KiB and
   repeats 2–4 times per run; every *distinct* payload survives verbatim exactly once across the
   set. Without it the fixtures were 3.3 MiB; with it they are 1.4 MiB.

## The files

Every run begins `initialize` → `authenticate {methodId:"cached_token"}` → `session/new {cwd,
mcpServers: []}` unless stated otherwise. `argv` below excludes the binary path.

| File | argv | Prompt / calls | What it demonstrates |
|---|---|---|---|
| `01-initialize.ndjson` | `--permission-mode default agent stdio` | `initialize` only — then stop | The probe shape. Agent capabilities, `authMethods`, the whole `_meta` block (`modelState`, `availableCommands`, `agentVersion`, `defaultAuthMethodId`). Also the unsolicited `_x.ai/mcp/servers_updated` that follows. |
| `02-prompt-plain-text.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `"Reply with exactly: OK"` | The full happy path: `session/new` response, `available_commands_update`, thought + message chunk streaming with per-chunk `_meta`, `_x.ai/session/prompt_complete`, and the `session/prompt` result with its complete token usage block. |
| `03-permission-allow-once.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `"Create a file named notes.txt containing exactly the word hello. Then stop."` | `session/request_permission` for a file write, the three options the agent actually advertises, and the `{outcome:"selected", optionId:"allow-once"}` reply. |
| `03b-bash-output-accumulation.ndjson` | `--reasoning-effort low agent stdio` | turn 1 `"/always-approve off"`, turn 2 `"Run the shell command \`echo hi\`…"` | Two things: `/always-approve off` is accepted and changes nothing (observation 6), and `tool_call_update` resends the **whole accumulated** output every time (observation 12). |
| `04-permission-reject.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | same write prompt, answered `reject-once` | The rejection path: tool goes `failed` with `"User rejected the execution for tool \`write\`"` and the **whole turn** ends `stopReason: "cancelled"`. |
| `05-cancel-with-pending-permission.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | same write prompt; `session/cancel` sent with the permission request unanswered, answered `cancelled` 2.5 s later | What `session/cancel` does to a pending permission (observation 10). |
| `06-session-load-replay.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `session/load` of `02`'s session in a **fresh process**, then a follow-up prompt | Replay with `_meta.isReplay: true`, the `_x.ai/session/update` replay channel, the `session/load` response shape, and proof the history really came back. |
| `07-plan-mode-exit-plan.ndjson` | `--permission-mode plan --reasoning-effort low agent stdio` | `"Plan (do not implement) how to add a subtract function to add.js…"` | `_x.ai/exit_plan_mode` with a populated `planContent`, `current_mode_update` in both directions, `pending_interaction {kind:"plan_approval"}`, the `plan.md` write, and the declared `x.ai/tool.kind: "enter_plan"|"exit_plan"`. |
| `07b-ask-user-question.ndjson` | `agent --always-approve stdio`, env `GROK_ASK_USER_QUESTION=1` | `"…use your ask-user-question tool to ask me whether to name the new file alpha.txt or beta.txt…"` | `_x.ai/ask_user_question` params and our `{outcome:"accepted", answers:{<question text>: [label]}}` reply — **and a 116 s window of total ACP silence** mid-turn (observation 16). |
| `08-steering-second-prompt.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `"Count slowly from 1 to 20…"`, then `"Actually stop counting and just say DONE."` while the first is in flight | Concurrent `session/prompt` calls: both are accepted, both get their own response, the second is *queued* not interleaved, and `_x.ai/queue/changed` shows it. |
| `09a-permission-mode-acceptEdits.ndjson` | `--permission-mode acceptEdits --reasoning-effort low agent stdio` | `"Create a file named notes-a.txt…"` | `acceptEdits` **still asks** for the edit. |
| `09b-permission-mode-auto.ndjson` | `--permission-mode auto --reasoning-effort low agent stdio` | `"Create a file named notes-b.txt…"` | `auto` does not ask. |
| `09c-always-approve.ndjson` | `agent --always-approve stdio` | `"Create a file named notes-c.txt…"` | `--always-approve` after `agent` does not ask. |
| `10-compact-and-context.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `"Say OK."`, then `"/compact"`, then `"/context"` | The compaction boundary (`auto_compact_completed`) and `/context` completing in 15 ms with no output. |
| `11-background-task.ndjson` | `agent --always-approve stdio` | `"Start \`sleep 25\` as a BACKGROUND shell command…"` then 20 s of watching | `rawOutput.type: "BackgroundTaskStarted"`, the `background_tasks` roster notification, and the absence of any post-turn task event. |
| `13-errors-and-rpcs.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | 12 RPCs, no model calls | Error shapes for unknown methods, bad models, unknown sessions, plus `session/set_model`, `session/set_mode`, `session/list`, `session/close` and an unadvertised `authenticate`. |
| `14-sigterm-mid-prompt.ndjson` | `--permission-mode default --reasoning-effort low agent stdio` | `"Count slowly from 1 to 30…"`, SIGTERM after the first `agent_message_chunk` | Process behaviour on SIGTERM and the fate of the in-flight RPC. |
| `12-cli-text/` | — | `grok --version`, `grok models` (with and without a login), `grok inspect --json` | The snapshot inputs the provider probe parses. `grok-inspect.json` is redacted and its long host-specific arrays are truncated to three entries each. |

---

## Protocol observations

Every difference between this CLI's real behaviour and what spec §4.5 (Grok) or T3 Code's
`apps/server/src/provider/{Layers/Grok*,acp/*}.ts` assume. Frames are quoted from the files above.

### 1. `_x.ai/mcp/servers_updated` leaks the host's credentials — redact before logging

Unprompted, right after `initialize`, the agent pushes every MCP server it discovered **including
each server's environment**:

```json
{"jsonrpc":"2.0","method":"_x.ai/mcp/servers_updated","params":{"mcpServers":[
  {"name":"jira-cloud","source":"local","type":"stdio","command":"/usr/bin/node",
   "args":["~/.npm-global/lib/node_modules/@aaronsb/jira-cloud-mcp/build/index.js"],
   "env":[{"name":"JIRA_EMAIL","value":"<redacted>"},
          {"name":"JIRA_API_TOKEN","value":"<redacted>"},
          {"name":"JIRA_HOST","value":"<redacted>"}]}]}}
```

In the original capture those values were the real Atlassian token, password and e-mail. Spec
§3.1 says `raw.ndjson` holds "untranslated provider frames"; for Grok that is a credential sink.
**The raw writer must redact `mcpServers[].env[].value` before the line is written**, not after.
Nothing in T3 does this — it has no handler for the method at all, so the frame is dropped at the
adapter, but a raw logger sitting below the adapter would still persist it.

### 2. The auth method depends on whether a cached token exists, and `authMethods` is never validated

`GrokAcpSupport.resolveGrokAuthMethodId` picks `"xai.api_key"` when `XAI_API_KEY` is set and
`"cached_token"` otherwise, **without consulting** the agent's advertised `authMethods`. Both
halves of that are worth knowing:

- With the managed account home bound, the agent advertises **two** methods and names a default:

  ```json
  "authMethods":[{"id":"cached_token","name":"cached_token","description":"Cached token from ~/.grok/auth.json"},
                 {"id":"grok.com","name":"Grok","description":"Sign in with Grok"}],
  "_meta":{"defaultAuthMethodId":"cached_token", …}
  ```

- Without one (the host's own `~/.grok/auth.json` does not exist on this machine) the list
  collapses to `[{"id":"grok.com", …}]` and `"defaultAuthMethodId": null`.
- **`xai.api_key` is never advertised.** T3's other branch names a method id this CLI does not offer.
- It does not matter, because `authenticate` does not validate the id at all —
  `13-errors-and-rpcs.ndjson` calls it with the unadvertised `xai.api_key` and gets `{}` back.
  T3's unconditional `authenticate` is therefore safe here, but the adapter should still prefer
  `_meta.defaultAuthMethodId` over a hard-coded id, because that is the field that actually tracks
  the login state.

**Consequence for Orquester:** §3.1 binds the managed account with `GROK_HOME`, and that is what
makes `cached_token` appear. A thread launched without it reaches a CLI that is not logged in.

### 3. `sessionCapabilities.resume` **is** declared — the spec says it is not

Spec §4.5: *"never `session/resume` (that branch exists in the shared ACP runtime but is gated on
an agent capability Grok does not declare)"*. This CLI declares it:

```json
"agentCapabilities":{"loadSession":true,
  "promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},
  "mcpCapabilities":{"http":true,"sse":true},
  "sessionCapabilities":{"list":{},"resume":{},"close":{}},"auth":{}, …}
```

`session/list` and `session/close` also work (`13-errors-and-rpcs.ndjson`). The adapter should
keep using `session/load` — it is the documented path and it works (observation 9) — but the
capability check T3 relies on no longer distinguishes the two, so the choice must be explicit
rather than capability-driven.

Note also `promptCapabilities.image: false`: T3's "Grok ingests images only" attachment path
would be sending a content block the agent says it cannot take.

### 4. `initialize._meta.modeState` does not exist

Spec §4.5: *"What actually matters is `initialize._meta`: `modelState` → models,
`availableCommands` → slash commands, `modeState`."* The `_meta` block contains
`grokShell`, `defaultAuthMethodId`, `x.ai/mcp/sdk`, `x.ai/pluginDirs`, `currentWorkingDirectory`,
`agentVersion`, `agentId`, `agentInstanceId`, `hostname`, `modelState`, `mcpServers`, `mcpApps`,
`metadata`, `availableCommands`, `cancelRewind`, `sessionRecap`, `feedbackTraceOffer`, `voiceMode`
— and no `modeState`. T3's synthetic `LoadSessionResponse` would therefore always be built without
modes. Modes are still real (observation 8); they are just never announced here.

### 5. Permission requests are off by default — `[features] support_permission` gates them

This is the single biggest behavioural surprise. With the stock configuration, a file write under
`--permission-mode default` produces **no `session/request_permission` at all**. Instead the agent
resolves the interaction itself, 6 ms apart:

```json
{"method":"_x.ai/session_notification","params":{"update":{"sessionUpdate":"pending_interaction","tool_call_id":"call-…-0","kind":"permission"}}}
{"method":"_x.ai/session_notification","params":{"update":{"sessionUpdate":"interaction_resolved","tool_call_id":"call-…-0"}}}
```

The CLI's own docs list the switch under general settings:

```toml
[features]
support_permission = false   # prompt before tool execution
```

Every permission fixture here was captured with `support_permission = true` in the sandbox's
project config. **The agent host must write this key into the config layer it controls**, or the
approvals surface of §4.3 silently never fires and the user gets an agent that approves itself.
Neither the spec nor T3 mentions the setting.

### 6. The CLI-level permission flags do not mean what T3's argv table says

`GrokAcpSupport.grokAcpSpawnArgs` maps four runtime modes onto argv. Measured against a file write
with `support_permission = true`:

| argv | asks for the edit? | T3 expects |
|---|---|---|
| `--permission-mode default agent stdio` | **yes** | yes ✓ |
| `--permission-mode acceptEdits agent stdio` | **yes** | no ✗ |
| `--permission-mode auto agent stdio` | **no** | no ✓ |
| `agent --always-approve stdio` | **no** | no ✓ |
| `--permission-mode dontAsk agent stdio` | **no** | (not mapped) |

`acceptEdits` is a no-op for the ACP edit gate. `grok agent --help` does not list
`--permission-mode` at all — it is a *global* option that `agent stdio` honours for some values
and ignores for others. An adapter that offers "auto-accept edits" by passing `acceptEdits` will
show the user a mode that does not exist.

Also note: `/always-approve off` sent as a prompt is accepted and changes nothing
(`03b-bash-output-accumulation.ndjson`), so there is no in-session escape hatch either. T3 filters
`always-approve` out of the command catalog for policy reasons; here it is additionally useless.

### 7. Only some tools gate. `run_terminal_command` does not; `write` does

With `support_permission = true` and `--permission-mode default`, `echo hi` ran with no
`session/request_permission` (`03b`), while writing a file asked (`03`). Approval coverage is
per-tool inside the CLI and is not something the client can enumerate. An adapter must not assume
that "mode X ⇒ every tool asks".

### 8. The permission options — `allow_always` **is** offered

T3 carries the comment *"Grok 4.6 often omits allow_always"* and falls back to `allow_once`. For a
file write this CLI offers all three, in this order:

```json
"options":[
  {"optionId":"allow-edits-session","name":"Yes, allow all edits during this session","kind":"allow_always"},
  {"optionId":"allow-once","name":"Yes","kind":"allow_once"},
  {"optionId":"reject-once","name":"No, and tell Grok what to do differently","kind":"reject_once"}]
```

Note `allow_always` is **first**, so "pick options[0]" is a dangerous default. There is no
`reject_always`. The option ids are stable strings (`allow-edits-session` / `allow-once` /
`reject-once`) but the adapter must still echo back the `optionId` it was given, not a constant.
§4.3's four buttons map cleanly: Approve → `allow-once`, Always allow this session →
`allow-edits-session`, Decline → `reject-once`, Cancel → `{"outcome":"cancelled"}`.

### 9. `session/load` answers its RPC — the 2 s replay-idle race is no longer needed

Spec §4.5 describes a 2 s replay-idle gate and a synthetic `LoadSessionResponse` because *"the CLI
replays history as notifications and may never answer the RPC"*. Here the RPC answered in **266 ms**,
after 5 replayed notifications:

```json
{"models":{…},"configOptions":[…],"_meta":{"sessionId":"01a0c19e-…","codebaseIndexed":[],
  "x.ai/sessionConfig":{"options":[…]},
  "x.ai/sessionDetail":{"sessionId":"01a0c19e-…","kind":"build","cwd":"~/…/sandbox","currentModelId":"grok-4.6"},
  "x.ai/memoryMode":"v2"}}
```

There is no `modes` key. Keep the idle gate as a safety net — it costs nothing when the RPC
answers first — but the synthetic-response path must not be the design centre, and it must not
assume `modes` will ever be present.

### 10. Replay uses `_meta.isReplay` **and a different method name**

Replayed ACP-standard updates arrive as ordinary `session/update` with
`params._meta.isReplay: true`:

```json
{"method":"session/update","params":{"sessionId":"01a0c19e-…",
  "update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Reply with exactly: OK"}},
  "_meta":{"eventId":"01a0c19e-…-3","agentTimestampMs":1789954809695,"isReplay":true}}}
```

but the xAI-private events are replayed under **`_x.ai/session/update`**, not the
`_x.ai/session_notification` used live. Both carry `{sessionId, update, _meta}`. An adapter that
registers only `_x.ai/session_notification` silently loses the replayed `turn_completed`,
`hook_execution` and usage rows — which is exactly the data a resumed thread needs to rebuild its
history. Register both names.

Also: replay is **partial**. `02` produced 39 events; `session/load` replayed 5. The transcript is
not reconstructable from the replay alone.

### 11. `session/cancel` settles the turn by itself; a pending permission does not have to be answered first

Spec §4.5 and T3 both settle pending approvals as `cancelled` *before* sending the cancel, on the
grounds that "the ACP spec requires a cancel to answer every pending permission request with
`cancelled`". This CLI does not wait for it. With the permission request still open, the cancel
notification went out at `t=3995` and:

```
[3997] _x.ai/session_notification  {"sessionUpdate":"interaction_resolved","tool_call_id":"call-02831799-…-0"}
[3998] _x.ai/session_notification  {"sessionUpdate":"turn_completed","prompt_id":"203e5454-…","stop_reason":"cancelled", …}
[3999] session/prompt result       {"stopReason":"cancelled","_meta":{…}}
```

The late `{"outcome":{"outcome":"cancelled"}}` sent 2.5 s afterwards was accepted with no error.
So T3's ordering remains correct and safe — it is simply not load-bearing here, and the adapter
must be ready for the prompt to settle *before* it finishes answering.

### 12. A rejected tool ends the whole turn as `cancelled`, not `end_turn`

```
tool_call_update  status=failed  content=[{"type":"content","content":{"type":"text","text":"User rejected the execution for tool `write`"}}]
_x.ai/session_notification {"sessionUpdate":"hook_run_started","event_name":"permission_denied","tool_name":"write","count":1}
session/prompt result {"stopReason":"cancelled", …}
```

`stopReason: "cancelled"` is the ACP value reserved for "the client sent `session/cancel`". Here it
also means "the user declined a tool". An adapter that maps `cancelled` straight to "interrupted by
the user's Stop button" will label a declined approval as an interrupt. Disambiguate with the
`permission_denied` hook event or with the fact that no `session/cancel` was sent.

### 13. `tool_call_update` really does resend the whole accumulated output

Confirmed, so §4.5's truncate-and-coalesce rule is necessary. `03b`, one `echo hi`:

```
status=in_progress  content=[…{"text":""}]      rawOutput.output_for_prompt=""          total_bytes=0
status=in_progress  content=[…{"text":"hi\n"}]  rawOutput.output_for_prompt="hi\n"      total_bytes=3
status=completed    content=[…{"text":"hi\n"}]  rawOutput.output_for_prompt="exit: 0\nhi\n"  total_bytes=3
```

`content` and `rawOutput.output_for_prompt` are both cumulative, and `rawOutput` additionally
carries `output` as a **byte array** (`[104,105,10]`), `exit_code`, `signal`, `timed_out`,
`truncated`, `current_dir`, `output_file` and `total_bytes`. The byte array is not in T3's
`RAW_OUTPUT_TEXT_FIELDS` list and will grow unbounded on a chatty command — truncate it too.

### 14. Grok emits token usage everywhere. The spec says it emits none

Spec §4.5: *"**Grok emits no token usage at all** — no `thread.token-usage.updated`, no
`turn.completed.tokenUsage`. The context meter and per-turn cost are simply absent on Grok
(`reportsContextWindow: false`)."* That was true of the version T3 was written against. It is
false here, in four independent places.

**(a) Every streamed chunk carries the running context size.**

```json
{"method":"session/update","params":{"sessionId":"01a0c19e-…",
  "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"}},
  "_meta":{"totalTokens":1711,"eventId":"01a0c19e-…-34","agentTimestampMs":1789954811662,
           "promptId":"f8f85d1b-…","streamStartMs":1789954810533,"turnStartMs":1789954809712,
           "updateType":"AgentMessageChunk","chunkId":30}}}
```

**(b) The `session/prompt` response carries a complete per-turn usage block**, including cost:

```json
{"stopReason":"end_turn","_meta":{"sessionId":"01a0c19e-…","requestId":"f8f85d1b-…","promptId":"f8f85d1b-…",
  "totalTokens":22460,"modelId":"grok-4.6","inputTokens":22423,"outputTokens":30,
  "cachedReadTokens":6144,"reasoningTokens":29,
  "usage":{"inputTokens":22423,"outputTokens":30,"totalTokens":22453,"cachedReadTokens":6144,
           "cacheCreationTokens":0,"reasoningTokens":29,"modelCalls":1,"apiDurationMs":1977,
           "costUsdTicks":121754000,
           "modelUsage":{"grok-4.6-build":{…}},"numTurns":1}}}
```

`costUsdTicks` is USD × 1e9 — `121754000` is $0.121754.

**(c) `_x.ai/session_notification` `turn_completed` repeats the same `usage` object**, and
**(d) `response_completed` reports per-model-call usage** in snake_case
(`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`,
`reasoning_tokens`).

The context window is `initialize._meta.modelState.availableModels[]._meta.totalContextTokens`
(500 000 for both models). So `reportsContextWindow` should be **true** for Grok and the status
line should show a real meter. Note the two `totalTokens` fields mean different things: the one on
a chunk's `_meta` and on the prompt `_meta` is the **context size**, while `usage.totalTokens` is
the **turn's** input+output. A locally-handled slash command reports `"totalTokens":0` — treat 0 as
"no measurement", not "empty context".

ACP 0.11.3 also defines `Usage` / `UsageUpdate` and a `session/update` variant for them; this CLI
does not use them, preferring `_meta`.

### 15. Plan mode is **declared**, not heuristic

T3 detects `enter_plan_mode` by matching tool titles (`"enter_plan_mode"`, `"plan: enter"`,
`"plan mode entered"`) and `rawInput.variant === "EnterPlanMode"`. This CLI states it outright on
every tool call:

```json
{"sessionUpdate":"tool_call","toolCallId":"call-…-0","title":"enter_plan_mode","rawInput":{},
 "_meta":{"x.ai/tool":{"version":1,"name":"enter_plan_mode","kind":"enter_plan",
                       "namespace":"grok_build","label":"Enter Plan Mode","read_only":true}}}
```

`_meta["x.ai/tool"].kind` is the authoritative discriminant (`enter_plan`, `exit_plan`, `execute`,
`read`, `write`, `edit`, `search`, `list`, …) and `read_only` is a free safety signal. Use it
instead of title matching; fall back to the heuristic only if `_meta["x.ai/tool"]` is absent.

ACP's own `current_mode_update` also fires, in both directions:

```
[12374] {"sessionUpdate":"current_mode_update","currentModeId":"plan"}
[43246] {"sessionUpdate":"current_mode_update","currentModeId":"default"}
```

even though no `modeState` was ever advertised (observation 4). And `pending_interaction` has a
second kind for it: `{"sessionUpdate":"pending_interaction","tool_call_id":"…","kind":"plan_approval"}`.

The plan file is written to `$GROK_HOME/sessions/<percent-encoded-cwd>/<session-id>/plan.md` —
under the **managed account home**, so the literal `.grok` path component T3's canonical regex
requires (`/^(?:\/home\/[^/]+|\/Users\/[^/]+|…)\/\.grok\/sessions\/…/`) is absent. Match on
`$GROK_HOME` as the adapter sets it, never on `~/.grok`.

### 16. `_x.ai/exit_plan_mode` and `_x.ai/ask_user_question`: underscore spelling only, never wrapped

Both extension requests were observed, both in the `_x.ai/` spelling, both with **unwrapped**
params. The `{method, params}` envelope T3 unwraps defensively was never seen. Keep registering
both spellings and keep the unwrap — they are cheap — but do not build anything that depends on
the wrapped form existing.

`_x.ai/exit_plan_mode`, with `planContent` populated (T3's `XAI_EMPTY_PLAN_MARKDOWN` fallback did
not trigger):

```json
{"sessionId":"01a0c1a4-…","toolCallId":"call-38e301d3-…-10",
 "planContent":"# Add `subtract` to `add.js`\n\n**Goal:** Export a `subtract(a, b)` function…"}
```

`_x.ai/ask_user_question` matches T3's schema exactly, including the required `mode`:

```json
{"sessionId":"01a0c1ff-…","toolCallId":"call-cc7ef02f-…-0",
 "questions":[{"question":"Should the new file be named alpha.txt or beta.txt?",
   "options":[{"label":"alpha.txt","description":"Create the new file as alpha.txt"},
              {"label":"beta.txt","description":"Create the new file as beta.txt"}],
   "multiSelect":null}],
 "mode":"default"}
```

Note the question has **no `id`**, so T3's "key the answers map by question text" rule is the only
one that can work. It is gated behind `GROK_ASK_USER_QUESTION=1` in the child environment; without
that variable the model never called the tool in any capture.

### 17. A 116-second silent gap mid-turn — the §3.1 watchdog is justified, and 10 minutes is not generous

In `07b-ask-user-question.ndjson`, after the question was answered at `t=4824` the agent emitted
`session_info_update` at `t=9666` and then **nothing at all** until `t=125828`. No chunk, no tool
call, no `_x.ai` notification, no stderr. This is Grok's private `streaming_reasoning` phase, and
it is completely invisible to ACP:

```
[  4828] session/update:tool_call_update
[  9666] session/update:session_info_update
[125828] session/update:agent_thought_chunk      <-- 116 seconds of silence
[131224] _x.ai/session/prompt_complete
```

Spec §3.1's 10-minute inactivity window with a 30-minute widening while a tool is open is the right
shape, and the rule that the clock must not start until observable progress is essential. But the
observed gap is ~19 % of the 10-minute budget on a *trivial* prompt — do not shorten those windows.

### 18. `session/prompt` always returned, and `prompt_complete` always arrived first

Spec §4.5 says *"`session/prompt` may never return"*. Across 14 turns it always did. Where a
`_x.ai/session/prompt_complete` was emitted it preceded the RPC result by 1–3 ms, carrying the same
stop reason:

```
[2541] {"method":"_x.ai/session/prompt_complete","params":{"sessionId":"01a0c19e-…","promptId":"f8f85d1b-…","stopReason":"end_turn","agentResult":null}}
[2543] {"jsonrpc":"2.0","id":4,"result":{"stopReason":"end_turn","_meta":{…}}}
```

Racing the two remains correct, but the notification is a *duplicate*, not a substitute — and it is
the poorer of the two, because only the RPC result carries the usage block of observation 14. Prefer
the RPC result when both arrive. `agentResult` was `null` in every capture; `stopReason` was never
missing, so T3's `xAiStopReasonMissing` normalisation never triggered. Not every turn got a
`prompt_complete` at all: locally-handled slash commands (`/compact`, `/context`) produced none.

### 19. Concurrent prompts are legal and are queued, not steered

Two overlapping `session/prompt` requests both succeeded, in order, each with its own `promptId`:

```
[ 456] send session/prompt id=4   "Count slowly from 1 to 20…"
[4110] send session/prompt id=5   "Actually stop counting and just say DONE."
[4112] _x.ai/queue/changed  entries=[{"id":"2aea0a9d-…","version":0,"kind":"prompt","text":"Actually stop counting…","position":0}]
[4552] turn_completed prompt_id=6aee2eb2-…  stop=end_turn      <-- first turn
[6392] turn_completed prompt_id=2aea0a9d-…  stop=end_turn      <-- second turn
```

The second prompt did **not** interrupt the first; the model finished counting to 20 and only then
answered. So "steering" in the §7.4 sense is not available over ACP: a mid-turn message is a queued
follow-up turn. If the UI promises interruption it must send `session/cancel` first. `_x.ai/queue/changed`
is the wire signal for the queued-message UI.

Every `session/update` carries `_meta.promptId`, so chunks can be attributed to the right turn even
while two are outstanding.

### 20. The slash-command catalog from `initialize` is a tenth of the real one

`initialize._meta.availableCommands` lists **7**: `compact`, `always-approve`, `context`,
`session-info`, `deep-research`, `workflow`, `goal`. The `session/update:available_commands_update`
notifications that follow `session/new` list **69**, including every plugin and skill, some
namespaced: `hooks-trust`, `hooks-list`, `plugins`, `reload-plugins`, `feedback`, `loop`,
`user:docs`, `bundled:imagine`, `hookify:help`, `brainstorming`, `writing-plans`, `code-review`, …

T3's provider probe reads only the `initialize` list (it deliberately never calls `session/new`).
That keeps the probe cheap but means §4.6's catalog is missing ~90 % of the commands the user can
actually type. The catalog should be refreshed from `available_commands_update` once a session
exists, and the command list arrives **more than once** per session (it grows as plugins load), so
the last one wins rather than the first.

T3's two filtered names remain correct: `always-approve` is a no-op (observation 6) and `/context`
completes in 15 ms with no output at all:

```
[6574] turn_completed prompt_id=1a8bb4e1-… stop=end_turn elapsed_ms=15
[6574] /context result {"stopReason":"end_turn","_meta":{"totalTokens":0, …}}
```

### 21. `/compact` reports its boundary on the private channel

```json
{"method":"_x.ai/session_notification","params":{"sessionId":"01a0c1a6-…",
  "update":{"sessionUpdate":"auto_compact_completed","tokens_before":22462,"tokens_after":22462,"summary_preview":null}}}
```

That maps directly onto §4.5's `thread.state.changed {compacted, beforeTokens, afterTokens}`. The
turn itself settles `end_turn` with `_meta.totalTokens: 0`. (`tokens_before == tokens_after` here
only because the conversation was two messages long.) There is no ACP-standard signal for this;
without the `_x.ai` channel compaction is invisible.

### 22. `session/set_model` works, leaks a Rust `Result`, and rejects `grok-build`

```
send    {"method":"session/set_model","params":{"sessionId":"…","modelId":"grok-4.5","_meta":{"reasoningEffort":"low"}}}
recv    {"result":{"_meta":{"model":{"Ok":"grok-4.5"}}}}

send    {"method":"session/set_model","params":{"sessionId":"…","modelId":"grok-build"}}
recv    {"error":{"code":-32602,"message":"Invalid params","data":"unknown model id"}}
```

`_meta.reasoningEffort` is accepted exactly as T3 sends it. The response `_meta.model` is a
serialised Rust `Result` (`{"Ok": …}`) — do not parse it as a model object. And T3's `grok-build`
sentinel rule is **required**: sending the product slug is a hard `-32602`.

`session/set_config_option` exists too — `session/new` returns a `configOptions` array with
`model` and `reasoning_effort` selects — but it takes `configId`, not `configOptionId`. (The
capture's `-32602 "missing field \`configId\`"` is the harness getting the field name wrong, not a
CLI bug.) Either route works; `session/set_model` stays the simpler one.

### 23. Error shapes

From `13-errors-and-rpcs.ndjson`, all verbatim:

| Call | Response |
|---|---|
| `orquester/definitely_not_a_method` | `{"code":-32601,"message":"Method not found"}` |
| `x.ai/definitely_not_a_method` | `{"code":-32601,"message":"Method not found"}` |
| `session/set_model` with a bad id | `{"code":-32602,"message":"Invalid params","data":"unknown model id"}` |
| `session/prompt` with an unknown session | `{"code":-32602,"message":"Invalid params","data":"unknown session id"}` |
| `session/load` with an unknown session | `{"code":-32603,"message":"Path not found.","data":{"detail":"No such file or directory (os error 2)","code":"FS_NOT_FOUND"}}` |
| `session/set_mode {modeId:"plan"}` with no modes declared | `{}` — **silently accepted** |
| `authenticate {methodId:"xai.api_key"}` (unadvertised) | `{}` — **silently accepted** |
| `session/close` | `{"_meta":{"x.ai/closeOutcome":"closed"}}` |

The message text never names the offending method, and `-32601` carries no `data`. The two silent
acceptances matter: neither `set_mode` nor `authenticate` can be used to probe what the agent
supports. T3's typed `-32003` rate-limit error was never produced — no `stopReason: "rate_limit"`
occurred, so that path is unverified against this version.

An **unauthenticated** failure shape could not be captured without logging the user out, which the
brief forbids. The closest evidence is `grok models` printing `You are not authenticated.` while
`initialize` still succeeds and advertises only `grok.com` (observation 2) — i.e. the ACP handshake
does not fail on a missing login; the failure would surface later, on the first model call.

### 24. SIGTERM mid-prompt: clean exit 143 in 145 ms, in-flight RPC abandoned

```
[5960] note   first agent_message_chunk seen; sending SIGTERM mid-prompt
[6105] note   child exit: code=143 signal=null
[6105] note   prompt rejected: child exited
```

`code: 143` with `signal: null` means the CLI installs its own SIGTERM handler and exits
deliberately; Node reports an exit code, not a signal, so a supervisor keying on `signal ===
"SIGTERM"` will misclassify it. The in-flight `session/prompt` gets **no response and no error** —
the adapter owns settling that turn (§4.1's teardown). No SIGKILL escalation was needed in any run.

### 25. stderr is empty

Across every capture, the child wrote **zero** bytes to stderr during normal operation. The only
stderr line ever recorded was an update notice from the pre-update binary:

```
A new version of Grok Build is available: 1.0.3 -> 1.0.34 [stable]
```

T3's 4 KiB redacted rolling stderr tail is still the right safety net for a spawn/crash failure,
but it will be empty on a healthy run, so it can never be the primary diagnostic.

### 26. The CLI auto-updates itself underneath a running deployment

`~/.grok/config.toml` ships `[cli] auto_update = true`. Partway through this capture session the
binary replaced itself — the first `initialize` reported `"agentVersion":"1.0.3"` and every later
one `"agentVersion":"1.0.34"`, with different models (`grok-4.5` → `grok-4.6` default), different
`authMethods`, a new `xhigh` reasoning effort and an extra `feedbackTraceOffer` flag. `~/.grok/bin/`
holds both binaries and `grok -> grok-1.0.34` is a symlink.

Spec §10 says each adapter "pins the CLI version range it was validated against". For Grok the
version can change **between two spawns of the same thread**. The adapter must read
`initialize._meta.agentVersion` on every handshake — not cache it per host — and the deployment
guidance should recommend `auto_update = false` for the managed account home.

### 27. Observed `session/update` variants, and what the drop list costs

Across every capture, exactly these ACP-standard variants appeared:

| variant | count | T3 handles |
|---|---|---|
| `agent_thought_chunk` | 276 | yes |
| `agent_message_chunk` | 67 | yes |
| `available_commands_update` | 20 | yes (then discards — no case in the adapter switch) |
| `tool_call_update` | 9 | yes |
| `tool_call` | 4 | yes |
| `session_info_update` | 3 | **no — dropped** |
| `user_message_chunk` | 1 | **no — dropped by design** |
| `current_mode_update` | 2 (in `07`) | yes |

`session_info_update` carries the session title (`{"sessionUpdate":"session_info_update","title":"User
Requests Simple OK Response"}`) — worth surfacing as the thread name rather than dropping. The single
`user_message_chunk` was a **replay** frame; dropping it during live streaming is right, but during
`session/load` it is the only record of what the user said, so the replay path must keep it.

Never observed: `plan`, `config_option_update`, `elicitation`, any `terminal/*` or `fs/*` callback
(as expected — the client declares `fs.readTextFile: false`, `fs.writeTextFile: false`,
`terminal: false`). Grok's plan output arrives as `_x.ai/exit_plan_mode` and a `plan.md` write, never
as ACP's own `plan` variant, so §7.3's plan row has to be built from the extension.

### 28. The private `_x.ai` event channel is where most of the state lives

`_x.ai/session_notification` (live) and `_x.ai/session/update` (replay) carry an xAI-only
`sessionUpdate` vocabulary that does not overlap ACP's:

`model_changed`, `turn_completed`, `response_completed`, `tool_call_delta_chunk`,
`pending_interaction`, `interaction_resolved`, `hook_run_started`, `hook_execution`,
`background_tasks`, `auto_compact_completed`, `last_turn_summary`, `session_summary_generated`.

Plus these standalone notifications: `_x.ai/models/update`, `_x.ai/settings/update`,
`_x.ai/announcements/update`, `_x.ai/mcp/servers_updated`, `_x.ai/mcp/init_progress`,
`_x.ai/mcp/server_status`, `_x.ai/mcp_initialized`, `_x.ai/queue/changed`, `_x.ai/sessions/changed`,
`_x.ai/session/prompt_complete`, `_x.ai/task_backgrounded`.

T3 registers three of these (`ask_user_question`, `exit_plan_mode`, `prompt_complete`) and drops the
rest. Several are genuinely useful — `turn_completed` (usage), `background_tasks` (roster),
`auto_compact_completed` (compaction), `queue/changed` (queued messages), `last_turn_summary` (a
one-line turn summary the model writes itself). `_x.ai/announcements/update` and
`_x.ai/settings/update` are marketing/product payloads and must never reach the timeline.

The full table, with which spelling was observed, is
`apps/daemon/src/agent-host/adapters/grok/acp/_generated/xai.ts`.

### 29. Background tasks: the roster notification beats scraping `rawOutput`

T3 reconstructs background work from `rawOutput` discriminants. Both sources exist here.
`rawOutput` on the completing `tool_call_update`:

```json
{"type":"BackgroundTaskStarted","task_id":"01a0c1a7-3335-…","task_type":"bash",
 "output_file":"~/…/terminal/call-3bd55661-….log","status":"running","command":"sleep 25",
 "summary":"Background task 01a0c1a7-3335-… started",
 "retrieval_hint":"Use get_command_or_subagent_output with task_ids=[…] when you need the output.",
 "pid":3120632}
```

and, separately, a whole roster:

```json
{"method":"_x.ai/session_notification","params":{"update":{"sessionUpdate":"background_tasks",
  "tasks":[{"task_id":"01a0c1a7-3335-…","command":"sleep 25","description":"Start sleep 25 in background",
            "cwd":"~/…/sandbox","kind":"bash","status":"running",
            "started_at":"2026-09-21T01:49:15.445026965+00:00","output_file":"~/…/…log"}]}}}
```

and a third signal, a method of its very own rather than a `session_notification` variant:

```json
{"jsonrpc":"2.0","method":"_x.ai/task_backgrounded","params":{"sessionId":"01a0c1a7-…",
  "update":{"sessionUpdate":"task_backgrounded","tool_call_id":"call-3bd55661-…-0",
            "task_id":"01a0c1a7-3335-…","command":"sleep 25","cwd":"~/…/sandbox",
            "output_file":"~/…/terminal/call-3bd55661-….log","description":"Start sleep 25 in background"},
  "_meta":{"eventId":"01a0c1a7-…-61","agentTimestampMs":1789955355445}}}
```

That one is the cleanest join between a tool call and a task: it is the only frame that carries
`tool_call_id` **and** `task_id` together. `background_tasks` is a complete snapshot with `status`,
so §7.6's roster can fold it directly instead of inferring lifecycle from discriminants. Two details for whoever ports T3's reader:
the field is `task_id` (snake_case) — T3 reads `output.task_id ?? output.taskId`, which is right —
and the tool call that starts the task reports `status: "completed"` immediately, with the
**title rewritten** to `"[bg] sleep 25 (01a0c1a7)"`.

**Nothing was emitted after the turn settled.** Twenty seconds of watching produced no `TaskOutput`,
no completion event, nothing — the `sleep 25` finished silently. Grok surfaces background progress
only when the model *polls* with `get_command_or_subagent_output`. So §3.1's "background liveness
outlives the turn" registry will see a task go `running` and never hear it end. It needs its own
expiry, or the thread stays "monitoring" forever.

### 30. `session/new` boots every configured MCP server, and it is not fast

`session/new` returned in 37 ms, but MCP initialisation continued for another ~3 s *into the first
turn*, ending with:

```json
{"method":"_x.ai/mcp_initialized","params":{"sessionId":"01a0c19e-…","mcpToolCount":157,"elapsedMs":2648}}
```

157 tools from 4 servers, and the servers are discovered from the host's Claude Code configuration
(`~/.claude.json`) via `[compat.claude]`, not just from `~/.grok/`. That is why T3's provider probe
deliberately stops at `initialize`. Orquester's probe must do the same, and the launch environment
of §3.1 should decide explicitly which MCP servers a chat thread inherits rather than getting the
user's whole Claude Code fleet by default.

### 31. Odds and ends worth knowing

- `initialize` returns `agentCapabilities._meta["x.ai/hooks"]`:
  `{"blockingEvents":["pre_tool_use","stop","subagent_stop"],"decisions":["deny","block"],"stopSignals":["continue","stopReason","additionalContext"]}`.
  The user's own hooks then run inside the turn and report as `hook_run_started` / `hook_execution`
  on the private channel. §3.1 says managed hooks are not installed into chat sessions; the user's
  own still are, and their failures are visible only there.
- `agentCapabilities.mcpCapabilities` advertises `{"http":true,"sse":true}` — **no `stdio`** — even
  though every server it actually runs is stdio. Do not gate on that field.
- `_meta.agentId` is stable per host (`~/.grok/agent_id`) and `_meta.agentInstanceId` is per
  process. Treat `agentId` as an identifier and keep it out of logs.
- `_meta.currentModelId` / `modelState` are duplicated across `initialize`, `session/new`,
  `session/load` and `_x.ai/models/update`. They agreed in every capture.
- The reported `reasoning_effort` was `"high"` in `model_changed` even when the process was
  launched with `--reasoning-effort low`. Either the flag does not reach the ACP session or the
  notification reports the model's default. Do not trust `model_changed.reasoning_effort` as a
  confirmation of what was requested.
- `_x.ai/sessions/changed` exposes `activity: "working"` and `resident: true` per session — a
  ready-made signal for §6.4's coarse activity events.
- `session/list` works and returns `{sessionId, cwd, title, updatedAt, _meta["x.ai/session"]}` with
  git facets (`branch`, `gitRoot`, `repo`). A useful resume picker without touching the on-disk
  transcript format.

---

## Reproducing

The harness is deliberately not committed. To re-capture:

1. Put `/var/lib/orquester/.npm-global/bin` on `PATH`.
2. Bind an authenticated home: `GROK_HOME=<appdir>/daemon/agent-accounts/grok/<id>/home`.
3. Create a throwaway `git init` directory with a `.grok/config.toml` containing
   `[features] support_permission = true`.
4. Spawn `grok … agent stdio`, speak JSON-RPC 2.0 NDJSON on stdin/stdout, and log every line both
   ways plus stderr in the format above.
5. Redact as described, then export.

Never point the harness at a real project, and never copy `auth.json` — bind the home with
`GROK_HOME` and let the CLI refresh its own token.
