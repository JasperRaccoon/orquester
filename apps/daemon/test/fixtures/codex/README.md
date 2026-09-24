# Codex `app-server` protocol fixtures

Real NDJSON traffic between a client and `codex app-server`, captured once per scenario by
driving the installed CLI over its own stdio transport. There is no record mode: these were
produced by a throwaway Node harness speaking the protocol exactly as T3 Code does, against a
throwaway git repo, and committed. Nothing is hand-written or reshaped.

| | |
|---|---|
| CLI | **`codex-cli 0.154.0`** (`codex app-server`, stdio transport, `initialize` `capabilities: {experimentalApi: true}`) |
| Captured | **2026-09-21** |
| Model | `gpt-5.5` unless a file's own `note` says otherwise; `effort: "medium"` unless stated |
| Account | ChatGPT Pro (`account/read` → `{"account":{"type":"chatgpt", …,"planType":"pro"}}`) |
| cwd | a throwaway git repo (`README.md`, `a.ts`), never a real project |
| Host quirk | this capture host **cannot run codex's bubblewrap sandbox** — every capture opens with `configWarning: "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces."`, and an in-sandbox `apply_patch` fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Where that changed a capture, the file's own `note` says so. |

## Format

One JSON object per line:

```json
{"t": <ms since capture start>, "dir": "send"|"recv"|"stderr"|"note", "frame": <verbatim JSON or string>}
```

`send`/`recv` frames are the wire bytes verbatim — whatever was written to, or read from, the
child's stdio, re-serialised with no key reordering or field filtering. `stderr` is one line of
the child's stderr. `note` is harness commentary (scenario description, which decision was sent,
where a turn boundary is); notes are the only non-protocol lines and are safe to skip.

### Redaction

Applied uniformly, after capture, before commit:

- the capture host's home (`/var/lib/orquester`) → `~`, everywhere it appears (session rollout
  paths, `codexHome`, skill/hook paths, cwds);
- the account email → `user@example.invalid`; `installationId` → all-zero UUID;
  `remoteControl/status/changed`'s `serverName` → `<redacted-hostname>`;
- **three whole results are replaced by a `note`**: `mcpServerStatus/list` (435 KB of the capture
  host's MCP tool catalogue), `config/read` (the full `config.toml` — it echoes every configured
  MCP server's `env`, which on this host held live third-party credentials) and
  `account/usage/read` (the account's lifetime/daily token history). Each replacement note lists
  the result's top-level keys so the shape is still on record.

Thread ids, turn ids, item ids and JSON-RPC request ids are **not** redacted: they are the
protocol's own correlation handles and the fixtures are worthless without them.

A leak scan (`ATATT…`, `sk-…`, JWTs, the home path, the email, named credential env vars) runs
over every file as the last step of redaction and fails the run rather than writing a fixture.

## The files

| File | Scenario | Requests sent | What it demonstrates |
|---|---|---|---|
| `01-initialize-thread-start-text-turn.ndjson` | 1 | `initialize`, `initialized`, `thread/start`, `turn/start` | The handshake and a plain text turn end to end: `thread/started`, `thread/settings/updated`, `turn/started`, the `userMessage` → `reasoning` → `agentMessage` item lifecycle, `item/agentMessage/delta` streaming, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `turn/completed`. |
| `02-command-approval-accept.ndjson` | 2 | same + `turn/start` for `ls -1`; answers `item/commandExecution/requestApproval` with `{"decision":"accept"}` | The supervised configuration (`approvalPolicy:"untrusted"`, `sandbox:"read-only"`, `approvalsReviewer:"user"`) raising a command approval; the exact params incl. `availableDecisions`; `serverRequest/resolved`; the command item going `inProgress` → `completed` with `aggregatedOutput`. Launched with `-c model_reasoning_summary=detailed`. |
| `03-command-approval-decline-cancel-session.ndjson` | 3 | four `turn/start`s on one thread; the same approval answered `decline`, `cancel`, `acceptForSession`, then re-asked | The three non-accept decisions side by side, and proof that `acceptForSession` really is remembered: the fourth turn runs the identical command with **no** approval request. |
| `04-file-change-approval.ndjson` | 4 | `thread/start` (`sandbox:"workspace-write"`) + `turn/start`; answers `item/fileChange/requestApproval` with `{"decision":"accept"}` | The apply-patch approval: a `fileChange` item carrying `changes:[{path,kind:{type:"add"},diff}]`, then a *separate, much thinner* `item/fileChange/requestApproval` that carries no diff at all. |
| `05-tool-request-user-input.ndjson` | 5 | two `turn/start`s with `collaborationMode:{mode:"plan"}`; answers `item/tool/requestUserInput` twice | The blocking RPC question path: the real `questions[]` shape and the `{answers:{<id>:{answers:[…]}}}` reply. The file's opening note records that the default collaboration mode refuses the tool. |
| `06-interrupt-with-pending-approval.ndjson` | 6 | `turn/start`, then `turn/interrupt` **while an approval is unanswered**, then the late answer | What `turn/interrupt` settles and what it does not. |
| `07-thread-resume-new-process.ndjson` | 7 | process A: `thread/start` + `turn/start`, exit. process B: `initialize`, `thread/resume`, `thread/turns/list`, `turn/start` | Resume across a fresh `codex app-server`, including that `excludeTurns:true` returns `turns: []` and history must be hydrated with `thread/turns/list`. The follow-up turn recalls the codeword, proving the context really came back. |
| `08-compaction.ndjson` | 8 | `turn/start`, `thread/compact/start`, `turn/start` | Native compaction, and the fact that it runs as a whole extra turn. |
| `09-plan-mode-and-per-turn-overrides.ndjson` | 9 | turn A with `collaborationMode:{mode:"plan"}`; turn B with `model`/`effort`/`serviceTier`; turn C with none of them | Plan mode (`item/plan/delta`, the `plan` item) and the stickiness of every per-turn override. |
| `10-probe-no-turn.ndjson` | 10 | `initialize`, `account/read`, `model/list`, `skills/list`, `account/rateLimits/read`, `account/usage/read`, `config/read`, `configRequirements/read`, `getAuthStatus`, `hooks/list`, `experimentalFeature/list`, `permissionProfile/list`, `collaborationMode/list`, `thread/list`, `mcpServerStatus/list` | Everything the §4.5 probe needs, with no turn and no tokens spent. |
| `11-turn-diff-workspace-write.ndjson` | 11 | `thread/start` (`sandbox:"danger-full-access"`) + one `turn/start` making two edits | Cumulative `turn/diff/updated`. Uses full access because of the host's bubblewrap failure (see the file's note). |
| `12-rollback-and-revert.ndjson` | 12 | two turns, `thread/turns/list`, `thread/rollback`, `thread/turns/list`, `thread/revert`, `thread/turns/list` | Both rollback paths on a `historyMode:"paginated"` thread — one fails, one works. |
| `13-error-envelopes.ndjson` | 13 | an unknown method; a wrong param type; a missing required param; a bad model on `thread/start` and on `turn/start`; `turn/interrupt` for an unknown turn; a server→client approval answered `-32601` | Every error shape, request-level and turn-level. |
| `14-sigterm-mid-turn.ndjson` | 14 | `turn/start`, then SIGTERM to the child with an approval open | What the child writes (nothing) and how it exits. |
| `15-mcp-elicitation-approval.ndjson` | extra | two `turn/start`s driving a write-capable MCP tool; answers `mcpServer/elicitation/request` `accept` then `decline` | The fifth server→client request T3 implements, which none of the 14 listed scenarios reaches. |

`15` is beyond the requested list; it is here because `mcpServer/elicitation/request` is one of
the five handlers the Codex adapter must implement (§4.5) and nothing else in the set triggers it.

### What the set covers

Server→client requests actually observed: `item/commandExecution/requestApproval` (9×),
`mcpServer/elicitation/request` (2×), `item/tool/requestUserInput` (2×),
`item/fileChange/requestApproval` (1×). **Never seen**, so the adapter must not assume their
shapes from these fixtures: `item/permissions/requestApproval`, `item/tool/call`,
`account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`, and the two
legacy ones (`applyPatchApproval`, `execCommandApproval`).

Notifications observed, with counts across all files:

```
turn/started 26   turn/completed 25   turn/diff/updated 5
item/started 89   item/completed 87   item/agentMessage/delta 535   item/plan/delta 66
thread/started 15  thread/settings/updated 17  thread/status/changed 76
thread/tokenUsage/updated 46  thread/reverted 1  thread/goal/cleared 1
hook/started 140  hook/completed 140   serverRequest/resolved 11
mcpServer/startupStatus/updated 190   account/rateLimits/updated 45
configWarning 16  remoteControl/status/changed 16  deprecationNotice 1  warning 1  error 1
```

Item types observed on `item/started`: `userMessage`, `reasoning`, `agentMessage`,
`commandExecution`, `fileChange`, `mcpToolCall`, `contextCompaction`, `plan`.

Never observed, although the catalogue defines them: `item/reasoning/textDelta`,
`item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`,
`item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `thread/compacted`,
`item/mcpToolCall/progress`, `turn/plan/updated`, every `thread/realtime/*`.

---

# Protocol observations

Everything below is a difference between **codex-cli 0.154.0's real behaviour** and what spec
§4.5 (Codex) or T3 Code's `CodexSessionRuntime.ts` / `CodexAdapter.ts` assume. Frames are quoted
verbatim from the files in this directory. This is the section to read before writing the
adapter.

## 1. `thread/start` does not return `{threadId}` — it returns `{thread: {...}}` plus the whole resolved config

The spec and T3 both speak of a thread id coming back from `thread/start`. What actually arrives
(`01-…`, response to request `id: 2`, abridged):

```json
{"id":2,"result":{
  "thread":{"id":"01a0c19d-e1f9-7e73-8dc5-a0d355d3d232","sessionId":"01a0c19d-…","forkedFromId":null,
            "parentThreadId":null,"preview":"","ephemeral":false,"historyMode":"paginated",
            "modelProvider":"openai","model":"gpt-5.5","reasoningEffort":"xhigh",
            "status":{"type":"idle"},"path":"~/.codex/sessions/2026/09/21/rollout-….jsonl",
            "cwd":"~/tmp/…/repo","cliVersion":"0.154.0","originator":"orquester","source":"vscode",
            "canAcceptDirectInput":true,"gitInfo":null,"name":null,"turns":[]},
  "model":"gpt-5.5","modelProvider":"openai","serviceTier":null,"cwd":"~/tmp/…/repo",
  "runtimeWorkspaceRoots":["~/tmp/…/repo"],"instructionSources":["~/.codex/AGENTS.md"],
  "approvalPolicy":"untrusted","approvalsReviewer":"user",
  "sandbox":{"type":"readOnly","networkAccess":false},"activePermissionProfile":null,
  "reasoningEffort":"xhigh","multiAgentMode":"explicitRequestOnly"}}
```

Read the id as `result.thread.id`. Three fields on that object matter beyond the id:

- **`historyMode`** — `"paginated"` on every thread this CLI creates. That single field decides
  which rollback path is legal (observation 7).
- **`reasoningEffort: "xhigh"`** — the *thread* default comes from `~/.codex/config.toml`
  (`model_reasoning_effort`), **not** from the `effort` you send on `turn/start`. The turn-level
  value shows up in `thread/settings/updated` instead. Do not read thread-level
  `reasoningEffort` back as "what the last turn used".
- **`instructionSources`** — the AGENTS.md files actually loaded. Nothing in the spec consumes it,
  but it is the only place the resolved instruction set is reported.

Same shape for `thread/resume` (`07-…`), which additionally carries `turnsBackwardsCursor` and
`itemsBackwardsCursor`. `turn/start` likewise returns `{"turn":{...}}`, not a bare turn id:

```json
{"id":3,"result":{"turn":{"id":"01a0c19d-e2dc-7893-91bb-f8f28883d808","items":[],
                          "itemsView":"notLoaded","status":"inProgress","error":null,
                          "startedAt":null,"completedAt":null,"durationMs":null}}}
```

## 2. `availableDecisions` — the provider's own button set — exists, and it is **not** what T3 sends

Every `item/commandExecution/requestApproval` in `02-…`/`03-…` carries:

```json
{"method":"item/commandExecution/requestApproval","id":0,"params":{
  "kind":"command","threadId":"…","turnId":"…","itemId":"call_wLTa0AdvcVcfQVMB4HsiXNOo",
  "startedAtMs":1789954849163,"environmentId":"local",
  "command":"/usr/bin/bash -lc 'ls -1'","cwd":"~/tmp/…/repo",
  "commandActions":[{"type":"listFiles","command":"ls -1","path":null}],
  "proposedExecpolicyAmendment":["ls","-1"],
  "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls","-1"]}},"cancel"]}}
```

Four consequences:

1. **`availableDecisions` is real and should drive §4.3's per-request `options`.** It is missing
   from the *stable* `generate-ts` output — only `--experimental` declares it — which is why the
   committed bindings are the experimental ones (see `../../src/agent-host/adapters/codex/_generated/README.md`).
2. **The advertised set is narrower than the type.** `CommandExecutionApprovalDecision` is
   `"accept" | "acceptForSession" | {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment} | "decline" | "cancel"`,
   but the server advertised only `accept`, `acceptWithExecpolicyAmendment` and `cancel` — **no
   `acceptForSession`, no `decline`**.
3. **Both unadvertised decisions are nevertheless accepted.** `03-…` sends `decline`, `cancel`
   and `acceptForSession` in turn, and all three are honoured. So `availableDecisions` is a
   *presentation* hint, not a validation whitelist. Render from it; do not gate on it.
4. **There is a structured decision arm nobody implements.**
   `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["ls","-1"]}}` — "allow this command
   shape permanently" — is the nearest thing Codex has to §4.3's `acceptAlways`, and the server
   offers it first-class, paired with `proposedExecpolicyAmendment` in the params. The spec's rule
   ("Codex downgrades `acceptAlways` to `acceptForSession`") loses a capability the CLI now has.
   There is a matching `{"applyNetworkPolicyAmendment":…}` arm with a
   `proposedNetworkPolicyAmendments` params field, for managed-network prompts.

`item/fileChange/requestApproval` is a different, much thinner shape (`04-…`) — no
`availableDecisions`, no diff, and its decision enum has no amendment arms
(`FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"`):

```json
{"method":"item/fileChange/requestApproval","id":0,"params":{
  "threadId":"…","turnId":"…","itemId":"call_nndWFWxO6hj4AG4qcwMkQyO1",
  "startedAtMs":1789954918010,"reason":null,"grantRoot":null}}
```

The diff lives on the `item/started` `fileChange` item that precedes it, so an approval card must
be rendered by joining on `itemId`, not from the request alone:

```json
{"method":"item/started","params":{"item":{"type":"fileChange","id":"call_nndWFWxO6hj4AG4qcwMkQyO1",
  "changes":[{"path":"~/tmp/…/repo/fixture.txt","kind":{"type":"add"},"diff":"banana\n"}],
  "status":"inProgress"}, …}}
```

## 3. `decline` and `cancel` are genuinely different answers — `cancel` kills the turn

`03-…`, the same command approved three ways:

- `{"decision":"decline"}` → the item completes as `"status":"declined"`, the model is told, and
  the turn continues and ends `"status":"completed"` with the agent explaining it could not run
  the command.
- `{"decision":"cancel"}` → the item **also** completes as `"status":"declined"` (same item
  status! the distinction is not visible there), but the turn ends:

  ```json
  {"method":"turn/completed","params":{"threadId":"…","turn":{
    "id":"01a0c1a0-126e-7f03-bdc4-f4816aba3e98","items":[],"itemsView":"notLoaded",
    "status":"interrupted","error":null,"startedAt":1789954888,"completedAt":1789954890,
    "durationMs":2345}}}
  ```

  — `status: "interrupted"`, `items: []`, `itemsView: "notLoaded"`. A client that folds
  `turn/completed.turn.items` as the authoritative turn content must not clear its accumulated
  items on an interrupted turn, or a cancelled turn erases itself from the timeline.
- `{"decision":"acceptForSession"}` → runs, and the **next** turn's identical command produces no
  approval request at all. The session grant is real and thread-scoped.

## 4. The "waiting on you" state is on the wire — do not re-derive it

`thread/status/changed` carries an `activeFlags` array, and an open approval sets it:

```json
{"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"active","activeFlags":["waitingOnApproval"]}}}
```

…and clears it the instant the request is answered. §4.2 says `waiting` "is derived from an
unresolved request, never emitted" — for Codex it *is* emitted, and it is more reliable than a
derivation because it also covers server-side waits the client never sees a request for. The
status union observed: `{"type":"idle"}` and `{"type":"active","activeFlags":[…]}`.

## 5. `turn/interrupt` does **not** settle open approvals — but it does not need them settled first either

The spec's §4.5 ordering is "(1) settle pending approvals as `cancel` … (4) `turn/interrupt`".
`06-…` deliberately inverts it: the approval is left unanswered and the interrupt is sent anyway.

```json
{"id":4,"method":"turn/interrupt","params":{"threadId":"…","turnId":"01a0c1a2-8433-7452-9ba0-f87f87af50e4"}}
{"id":4,"result":{}}
{"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"idle"}}}
{"method":"turn/completed","params":{"threadId":"…","turn":{"id":"01a0c1a2-8433-…","items":[],
  "itemsView":"notLoaded","status":"interrupted","error":null,"startedAt":1789955048,
  "completedAt":1789955054,"durationMs":5999}}}
```

Three things follow:

- The interrupt succeeds immediately (`result: {}`); there is no precondition.
- **No `serverRequest/resolved` is emitted for the orphaned approval**, and the
  `commandExecution` item that was `inProgress` **never gets an `item/completed`**. Both dangle
  forever from the client's point of view. This is the concrete reason the host must settle
  pending requests itself — not because the server rejects the interrupt, but because the server
  silently abandons them.
- Answering afterwards is still accepted and *does* produce the resolution notification:

  ```json
  {"id":0,"result":{"decision":"cancel"}}
  {"method":"serverRequest/resolved","params":{"threadId":"…","requestId":0}}
  ```

  So "settle, then interrupt" and "interrupt, then settle" both work; only "interrupt and never
  settle" leaks. Keep the spec's ordering — it is the one that also cleans up the UI.

`turn/interrupt` requires both `threadId` **and** `turnId` (`missing field \`turnId\`` otherwise),
and a stale turn id is a hard error, not a no-op: `{"code":-32600,"message":"no active turn to
interrupt"}` (`13-…`). §4.1's "interrupt is turn-scoped and a no-op when that turn is no longer
active" must therefore be enforced **client-side**; the server answers with an error.

`serverRequest/resolved` itself is worth wiring up: it is the server's acknowledgement that a
server→client request is closed, and it fires for every answered request in these captures. It is
in T3's notification catalogue but has no mapping in §4.2.

## 6. Token usage already carries the per-turn delta — the baseline diff T3 does is unnecessary

§4.5 says `thread/tokenUsage/updated` "carries *cumulative thread* totals, so the adapter keeps a
baseline and diffs per turn". In 0.154.0 the notification carries **both**:

```json
{"method":"thread/tokenUsage/updated","params":{"threadId":"…","turnId":"…","tokenUsage":{
  "total":{"totalTokens":28848,"inputTokens":28784,"cachedInputTokens":19200,
           "cacheWriteInputTokens":0,"outputTokens":64,"reasoningOutputTokens":0},
  "last": {"totalTokens":14454,"inputTokens":14445,"cachedInputTokens":13696,
           "cacheWriteInputTokens":0,"outputTokens":9,"reasoningOutputTokens":0},
  "modelContextWindow":258400}}}
```

`total` is the thread, `last` is the most recent model call, `modelContextWindow` is the context
size §7.6's ring needs. Note it fires **several times per turn** (three to five in these
captures), once per model call, so "the last one before `turn/completed`" is the turn total, not
the sum of the `last` values.

`turn/completed` itself carries **no** token usage at all — only
`{id, items, itemsView, status, error, startedAt, completedAt, durationMs}`. §4.2's
`turn.completed {tokenUsage?}` must be stamped by the adapter from the last observed usage
notification, exactly as T3 does.

**The context meter's numerator is `last`, not `total`** (§7.6). `total` is the thread's
cumulative spend across every turn and grows without bound — measuring it against
`modelContextWindow` made a long thread read 100 % while its actual context was a fraction of the
window. Codex's own TUI computes `last.total_tokens − last.reasoning_output_tokens`: reasoning
output is billed but dropped from the next request, so it never occupies the window. `total` is
still the honest answer for §7.6's *total processed across the thread*. In fixture 15's last
notification that is `22 132 − 0 = 22 132` used of `258 400`, with `130 371` processed.

## 7. `thread/rollback` is dead on every thread this CLI creates

`12-…`. The thread reports `historyMode: "paginated"`, and:

```json
{"id":6,"method":"thread/rollback","params":{"threadId":"…","numTurns":1}}
{"error":{"code":-32600,"message":"paginated threads do not support thread/rollback"},"id":6}
{"method":"deprecationNotice","params":{"summary":"thread/rollback is deprecated and will be removed soon","details":null}}
```

The generated type agrees: `/** DEPRECATED: `thread/rollback` will be removed soon. */`. The
working path is the one §4.5 calls the "paginated" path, and it is no longer a raw call —
`thread/turns/list` and `thread/revert` are both first-class generated methods now:

```json
{"id":5,"method":"thread/turns/list","params":{"threadId":"…","limit":10}}
  → turns newest-first: 01a0c1a7-51c7-… , 01a0c1a7-3c22-…
{"id":7,"method":"thread/revert","params":{"threadId":"…","beforeTurnId":"01a0c1a7-51c7-…"}}
  → {"thread":{…,"turns":[]},"turnsBackwardsCursor":"{\"requestedThreadId\":\"…\",\"rolloutOrdinal\":1,\"includeAnchor\":true,\"scope\":{\"kind\":\"turns\"}}","itemsBackwardsCursor":…}
{"method":"thread/reverted","params":{"threadId":"…"}}
  → thread/turns/list now returns only 01a0c1a7-3c22-…
```

Practical notes: `thread/revert`'s response has `turns: []` **always** (by documented design — you
re-hydrate through `thread/turns/list`), the cursors it returns are opaque JSON strings, and
`thread/reverted` is a new notification since T3's pin that an adapter must handle. Also note
`thread/list` takes `limit`, not `pageSize`, and accepts a `cwd` filter.

Neither endpoint touches the working tree — the doc comment is explicit: *"This only changes
persisted conversation history. It does not revert local file changes."* §5.5's checkpoint restore
remains entirely Orquester's job.

## 8. Compaction runs as a whole extra turn, and `thread/compacted` never fires

`08-…`:

```json
{"id":4,"method":"thread/compact/start","params":{"threadId":"…"}}
{"id":4,"result":{}}
{"method":"turn/started","params":{"threadId":"…","turn":{"id":"01a0c1a3-4897-7bf2-b475-1e899de02fed",…}}}
{"method":"item/started","params":{"item":{"type":"contextCompaction","id":"01a0c1a3-48f5-…"},…}}
{"method":"thread/tokenUsage/updated","params":{… "last":{"totalTokens":5547,"inputTokens":0,…}}}
{"method":"item/completed","params":{"item":{"type":"contextCompaction","id":"01a0c1a3-48f5-…"},…}}
{"method":"turn/completed","params":{"threadId":"…","turn":{"id":"01a0c1a3-4897-…","items":[],
  "itemsView":"notLoaded","status":"completed",…,"durationMs":2414}}}
```

- The request returns `{}` immediately; completion is observed through the turn lifecycle.
- **`thread/compacted` (the `ContextCompactedNotification`) is never emitted** — the capture waited
  120 s for it. The signal is the `contextCompaction` **item**, which is already in §4.2's closed
  `itemType` enum. Do not gate the UI on `thread/compacted`.
- Because it is a real turn with a real `turnId`, a client that shows "a turn is running" will
  light up during compaction. §4.2's `thread.state.changed {state:"compacted", beforeTokens,
  afterTokens}` has to be synthesised from the surrounding token-usage notifications.
- Compaction also happens **unprompted**: `09-…` contains a `contextCompaction` item in the middle
  of an ordinary turn, with no `thread/compact/start` anywhere.

## 9. Plan mode is thread state, not per-turn — and the server writes the developer instructions

§4.4 says "Plan mode is per turn: … Codex `collaborationMode: {mode: "plan"}` per turn". In
0.154.0 it is sticky. `09-…` sends `collaborationMode` on turn A only; turn B sends none, and:

```json
{"method":"thread/settings/updated","params":{"threadId":"…","threadSettings":{
  …,"model":"gpt-5.6-luna","serviceTier":"priority","effort":"low","summary":null,
  "collaborationMode":{"mode":"plan","settings":{"model":"gpt-5.6-luna","reasoning_effort":"low",
    "developer_instructions":"# Plan Mode (Conversational)\n\nYou work in 3 phases…"}},
  "multiAgentMode":"explicitRequestOnly","personality":"pragmatic"}}}
```

Turn B is still in plan mode. **Leaving `collaborationMode` off does not return the thread to
`default`** — you must send `{"mode":"default"}` explicitly to leave plan mode. A per-turn toggle
implemented as "send it when on, omit it when off" silently traps the thread in plan mode forever.

Second half of the same observation: the harness sent `developer_instructions: null`, and the
server filled in its own ~9 KB plan-mode prompt. T3 builds and sends
`buildCodexDeveloperInstructions(...)`; that is no longer required, and sending your own now
*replaces* a maintained upstream prompt. Send `null` and let the server own it.

`collaborationMode/list` enumerates what exists (`10-…`):

```json
{"data":[{"name":"Plan","mode":"plan","model":null,"reasoning_effort":"medium"},
         {"name":"Default","mode":"default","model":null,"reasoning_effort":null}]}
```

Plan mode produces a dedicated `plan` item plus `item/plan/delta` streaming, with the id derived
from the turn:

```json
{"method":"item/completed","params":{"item":{"type":"plan","id":"01a0c1a6-8fb8-7770-be7b-ada4aad1aea7-plan",
  "text":"**Add LICENSE**\n\n- Confirm the intended license text plus copyright holder/year…"},…}}
```

`turn/plan/updated` — which §4.2 maps to `turn.plan.updated` (the step checklist) — never fired;
that is the `update_plan` *tool*, which the plan-mode instructions explicitly forbid using while
in plan mode.

## 10. Per-turn `model`, `effort` and `serviceTier` are sticky, confirmed

`09-…` turn C sends `turn/start` with neither `model` nor `effort` nor `serviceTier`. **No
`thread/settings/updated` is emitted at all** — the thread simply keeps turn B's
`gpt-5.6-luna` / `low` / `priority`. This confirms §4.5's "overriding for this turn and subsequent
turns", and it means in-session model switching needs no RPC — but also that a UI which lets the
user set a model once must keep re-sending it or accept that it persists.

## 11. `item/tool/requestUserInput`: the field is `question`, not `prompt`, and options have no `value`

`05-…`:

```json
{"method":"item/tool/requestUserInput","id":0,"params":{
  "threadId":"…","turnId":"…","itemId":"call_SLCmEVNUkBioJczm717uh94q",
  "questions":[{"id":"license_choice","header":"License",
    "question":"Which license should the new LICENSE file use?",
    "isOther":true,"isSecret":false,
    "options":[{"label":"MIT (Recommended)","description":"Short, permissive, and widely recognized for open source projects."},
               {"label":"Apache-2.0","description":"Permissive license with explicit patent grant and more detailed terms."}]}],
  "isBlocking":true,"autoResolutionMs":null}}
```

Answered with exactly T3's shape, and accepted:

```json
{"id":0,"result":{"answers":{"license_choice":{"answers":["MIT (Recommended)"]}}}}
```

Differences from §4.5's description of T3's hard filter ("id, header, **prompt** and at least one
option whose label *and* description are both non-empty"):

- the prompt field is **`question`**; a filter keyed on `prompt` drops every question;
- `ToolRequestUserInputOption` is `{label, description}` — **no `value`**, so §4.1's
  `options: [{label, description, value?}]` will always have `value` undefined for Codex, and the
  answer must be the *label*;
- two new booleans the UI should honour: **`isOther`** (offer a free-text "other" field — §4.1's
  `allowCustomAnswer`) and **`isSecret`** (mask the input);
- `options` is nullable (`Array<…> | null`), so a free-text-only question is expressible;
- **`multiSelect` does not exist** on the wire; `ToolRequestUserInputAnswer.answers` is an array
  anyway, so T3's hard-coded `multiSelect: false` is still right;
- **`isBlocking: boolean` is the new signal** and `autoResolutionMs` is marked
  `@deprecated Use isBlocking to decide whether the request should block`.

**The tool is mode-gated.** In the default collaboration mode codex answered, in plain prose:
*"I tried to call `request_user_input`, but it's unavailable in the current mode."* It only became
available under `collaborationMode: {mode: "plan"}`, whose server-supplied instructions say
"Strongly prefer using the `request_user_input` tool to ask any questions". So the question card
is, in practice, a plan-mode feature.

**The reply-less path was not reproduced.** `AgentMessageDelivery` is the single-member union
`"async"` and `AsyncUserInputQuestion` is `{title, options: Array<string> | null}` (note: a
different shape from the RPC path's question), but across all 15 captures every `agentMessage`
item carried `"delivery":null,"questions":null`. §4.5's second question path exists in the schema
and is untested here.

## 12. `mcpServer/elicitation/request` is far richer than `{decision}` — and fires only for non-read-only tools

`15-…`. §4.5 says this handler answers `{decision}` with an `accept|decline|cancel` enum. The real
response type is `{action, content, _meta}` (`McpServerElicitationRequestResponse`), and the
params are a rendered form:

```json
{"method":"mcpServer/elicitation/request","id":1,"params":{
  "threadId":"…","turnId":"…","serverName":"serena","mode":"form",
  "_meta":{"codex_approval_kind":"mcp_tool_call","persist":["session","always"],
           "tool_title":"Replace In Files","tool_description":"Replaces occurrences of a pattern across multiple files in ONE call.…",
           "arguments":[{"name":"relative_path","value":"a.ts","display_name":"relative_path"},
                        {"name":"repl","value":"export const a = 4;","display_name":"repl"}]},
  "message":"Allow the serena MCP server to run tool \"replace_in_files\"?",
  "requestedSchema":{"type":"object","properties":{}}}}
```

Answered `{"action":"accept","content":null,"_meta":null}` → the tool runs; answered
`{"action":"decline","content":null,"_meta":null}` → the item completes
`"status":"failed","error":{"message":"user rejected MCP tool call"}`.

Notes for the adapter:

- `_meta.codex_approval_kind: "mcp_tool_call"` is what tells you this elicitation is an approval
  rather than a real MCP form; `_meta.persist: ["session","always"]` is the provider telling you
  which scopes it would accept — the raw material for §4.3's option set.
- `message` is the provider's own wording and should be the card's title.
- **Only write-capable tools raise it.** The first attempt at this capture used
  `get_symbols_overview`, whose item carries `"readOnlyHint":true`, and it ran with no elicitation
  at all. `replace_in_files` has `"readOnlyHint":false` and always asks.
- MCP tool calls are plain `mcpToolCall` **items**, as §4.5 says
  (`{type,id,server,tool,status,arguments,readOnlyHint,result,error,durationMs}`), and the
  `arguments` are echoed in full — useful for the timeline row, and a reminder that this payload
  can be large.

## 13. Error envelopes are all `-32600`, and a bad model fails at the turn, not at the request

`13-…`, request-level errors — note there is **no `jsonrpc` field** in any of them, and every
single one is `-32600`, including the ones JSON-RPC would spell `-32601`/`-32602`:

```json
{"error":{"code":-32600,"message":"Invalid request: unknown variant `thread/definitelyNotAMethod`, expected one of `initialize`, `server/diagnostics`, …"},"id":2}
{"error":{"code":-32600,"message":"Invalid request: invalid type: integer `42`, expected a string"},"id":3}
{"error":{"code":-32600,"message":"Invalid request: missing field `turnId`"},"id":4}
{"error":{"code":-32600,"message":"no active turn to interrupt"},"id":8}
```

The unknown-method message enumerates the entire client-request catalogue (≈8 KB) — do not log it
verbatim. Never classify a Codex failure by JSON-RPC code; the code is always `-32600` and only
the `message` distinguishes "bad shape" from "bad state".

A bad model is accepted twice and fails a third time, at the turn:

- `thread/start {model:"gpt-not-a-real-model"}` → **succeeds**, a thread is created;
- `turn/start` with it → **succeeds**, returns a turn, and a notification lands:
  ```json
  {"method":"warning","params":{"threadId":"…","message":"Model metadata for `gpt-not-a-real-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
  ```
- then the upstream call fails and the turn dies:
  ```json
  {"method":"error","params":{"error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-not-a-real-model' model is not supported when using Codex with a ChatGPT account.\"}}","codexErrorInfo":"other","additionalDetails":null,"misalignment":null},"willRetry":false,"threadId":"…","turnId":"…"}}
  {"method":"turn/completed","params":{"threadId":"…","turn":{…,"status":"failed","error":{"message":"{…}","codexErrorInfo":"other",…}}}}
  ```

So: **`error` carries `willRetry`**, which maps directly onto §10's "retryable provider errors are
`runtime.warning`, terminal ones `runtime.error`" — no heuristic needed. `turn/completed` can
carry `status: "failed"` with the same error object (T3's union has `failed`; §4.2 lists it).
The error `message` is a **JSON string**, not prose — it needs a second parse before it is
presentable, and it may not be JSON at all.

`warning` (distinct from `configWarning`, `guardianWarning`, `deprecationNotice`) is thread-scoped
and is the right source for §4.2's `runtime.warning`.

## 14. Answering a server→client request with `-32601` is safe and well-defined

`13-…` (g) and `11-…`. With no handler registered, the harness answers:

```json
{"id":0,"error":{"code":-32601,"message":"methodNotFound"}}
```

The server treats it as a refusal, not a protocol violation: the `commandExecution` item completes
`"status":"failed"`, the agent is told ("I couldn't run `ls -1` because the approval request was
rejected"), and the turn ends `"status":"completed"`. The same for an MCP elicitation
(`"error":{"message":"user rejected MCP tool call"}`). T3's catch-all `-32601` for unhandled
server requests is therefore correct and cheap — an unknown future server→client request degrades
to "the model was refused", never to a wedged turn.

## 15. Server→client request ids are small integers starting at **0**, per connection

`{"id":0,…}`, `{"id":1,…}`, `{"id":2,…}` across the whole connection, incrementing over *all*
server→client requests regardless of method. They are numbers, and they collide with the client's
own request ids (which the harness also starts at 1) — the two id spaces are independent and are
only disambiguated by direction. A transport that keys one pending-request map by id for both
directions will mis-route. T3's protocol layer keeps them separate; keep that.

## 16. Process exit on SIGTERM is clean and silent

`14-…`: SIGTERM is sent mid-turn with an approval open.

```
{"t":6095,"dir":"note","frame":"approval #0 opened; leaving it open and sending SIGTERM"}
{"t":6095,"dir":"note","frame":"sending SIGTERM"}
{"t":6140,"dir":"note","frame":"child exit code=0 signal=null"}
{"t":6141,"dir":"note","frame":"exit={\"code\":0,\"signal\":null}"}
```

**Exit code 0, no signal, ~45 ms, and not one further byte on stdout or stderr.** No
`turn/aborted`, no `turn/completed`, no goodbye frame. Every in-flight request and every
`inProgress` item simply stops. §3.1's supervision must therefore treat "child exited" as the
only signal — a clean `code: 0` after a SIGTERM is indistinguishable from a graceful shutdown, so
the host has to remember that it was the one who sent the signal. Since the conversation is
persisted in the rollout file, the recovery path is `thread/resume` (observation 17), not replay.

## 17. `thread/resume` works across processes but hands back an empty history

`07-…`: process A runs a turn, exits; process B resumes.

```json
{"id":2,"method":"thread/resume","params":{"threadId":"01a0c1a2-f62c-…","cwd":"~/tmp/…/repo",
  "approvalPolicy":"untrusted","sandbox":"read-only","approvalsReviewer":"user",
  "model":"gpt-5.5","excludeTurns":true}}
{"id":2,"result":{"thread":{…,"preview":"Remember the codeword…","turns":[]}, …}}
{"method":"thread/goal/cleared","params":{"threadId":"…"}}
{"id":3,"method":"thread/turns/list","params":{"threadId":"…","limit":5}}
{"id":3,"result":{"data":[{"id":"01a0c1a2-f6c6-…","items":[{"type":"userMessage",…},{"type":"agentMessage","text":"ok",…}],…}],"nextCursor":null,"backwardsCursor":…}}
```

and the follow-up turn answers `pineapple-42`, so the model's context is genuinely restored.
Points for the adapter:

- `excludeTurns: true` is the documented path for paginated threads ("Full-history hydration is
  **deprecated** for paginated threads"), and `turns` comes back `[]`. §4.1's `ThreadSnapshot`
  must be assembled from `thread/turns/list` (or from `initialTurnsPage`, a params field that
  bundles the first page into the resume response — one round trip instead of two).
- The resume **did not error**, so §4.5's recoverable-error matcher (the English-substring one the
  spec says not to copy verbatim) was not exercised. Treat it as unverified.
- `thread/goal/cleared` arrives unprompted right after a resume — a notification T3 does not map.
  It is the resume's goal snapshot (observation 20).
- Every launch param (`approvalPolicy`, `sandbox`, `approvalsReviewer`, `model`) is accepted on
  `thread/resume`, which is what makes §4.4's "always send `approvalsReviewer` explicitly, including
  on resume" expressible.

## 18. Smaller things worth knowing

- **`initialize` response.** `{"userAgent":"orquester/0.154.0 (Ubuntu 24.4.0; x86_64) tmux-256color
  (orquester; 0.0.0)","codexHome":"~/.codex","platformFamily":"unix","platformOs":"linux"}` —
  §4.5's "the response's `userAgent` is the **only** source of the Codex version" still holds
  (`/\/([^\s]+)/` → `0.154.0`), but `codexHome` is now returned too, which is a cheap way to verify
  that a `CODEX_HOME` override actually landed. Note the `userAgent` prefix is *your* `clientInfo.name`.
- **`agentMessage` has a `phase`.** `"final_answer"` vs `"commentary"` — the running "I'll do X
  next" narration is `commentary`, the answer is `final_answer`. Rendering both as assistant text
  produces a very chatty timeline; §7.3 should treat `commentary` as an activity row.
- **`reasoning` items appear with empty content.** `{"type":"reasoning","id":"rs_…","summary":[],
  "content":[]}` on both `item/started` and `item/completed`, with no
  `item/reasoning/*Delta` at all, even with `-c model_reasoning_summary=detailed` and
  `reasoningOutputTokens > 0`. A reasoning row must tolerate having no text ever.
- **`commandExecution` items mutate their own `source`.** `"source":"agent"` while awaiting
  approval, `"source":"unifiedExecStartup"` once running. Output arrives whole in
  `item/completed.aggregatedOutput` for short commands — `item/commandExecution/outputDelta` never
  fired in these captures — so `content.delta {command_output}` cannot be the only path to command
  output. `commandActions` is the parsed command (`{"type":"listFiles","command":"ls -1","path":null}`,
  or `{"type":"unknown","command":"sleep 30 && ls -1"}` when it cannot parse).
- **`turn/diff/updated` is cumulative and repeats.** `11-…` has five notifications for two
  distinct diffs; the diff is a full `diff --git` blob including index hashes, and each one
  supersedes the last. De-duplicate on content, not on arrival.
- **Hooks are loud.** 140 `hook/started` + 140 `hook/completed` across these captures, from the
  host's own `~/.codex/hooks.json`. §4.2 marks the hook events "Claude only" — they are a Codex
  notification too, and on an Orquester host they will always be present because the daemon
  installs its own agent hooks.
- **MCP startup noise.** `mcpServer/startupStatus/updated` fires per server per turn (190 across
  these files) with `status: "starting"|"ready"` — worth suppressing rather than rendering.
- **Context and cost.** With this host's MCP servers and skills loaded, a trivial turn costs
  ~14 300 input tokens before the prompt. `modelContextWindow` was 258 400 for `gpt-5.5`.
- **`account/rateLimits/updated` piggybacks on turns**, with the same body as
  `account/rateLimits/read`: `{"rateLimits":{"limitId":"codex","primary":{"usedPercent":30,
  "windowDurationMins":10080,"resetsAt":1790220221},"secondary":null,"credits":{…},
  "planType":"pro",…}}`. `limitId` is the stable per-window id §4.1's usage merge needs;
  `windowDurationMins: 10080` is the weekly window.
- **The probe is free and complete.** `10-…` shows `account/read`, `model/list` (single page,
  `nextCursor: null`, five models, each with `supportedReasoningEfforts` as objects
  `{reasoningEffort, description}` — note §4.1's "Codex `effort` is a plain non-empty string, not
  an enum" is still true on the wire), `skills/list {cwds:[…]}`, `account/rateLimits/read`,
  `getAuthStatus`, `hooks/list`, `permissionProfile/list`
  (`:read-only` / `:workspace` / `:danger-full-access`), `collaborationMode/list` and
  `thread/list`. All without a turn.
- **`configWarning` and `remoteControl/status/changed` arrive before you ask for anything** — both
  land between `initialize` and the first request, so a client that only starts listening after
  `thread/start` will miss them.

## 19. An `agentMessage` can be abandoned mid-stream, and a NEW item restates it

`05-…`, first turn. A `commentary` message streams 27 deltas and stops mid-sentence, the model
call's usage lands 15 ms after the last delta, and the item **never gets an `item/completed`**.
2.8 s later a new `agentMessage` restates the same thought and completes normally (abridged, `t`
in ms):

```
17754 item/started             {"type":"agentMessage","id":"msg_…bfd06c10b98","phase":"commentary",…}
17754 item/agentMessage/delta  ×27  "The read-only command batch was rejected … mark the one repo-derived"
18236 thread/tokenUsage/updated
21063 item/started             {"type":"agentMessage","id":"msg_…840b954d7ce","phase":"commentary",…}
21063 item/agentMessage/delta  ×45  "The read-only command was blocked by the sandbox approval layer, so I’m going to try …"
22109 item/completed           {"type":"agentMessage","id":"msg_…840b954d7ce",…}
```

Nothing sits between the two items — no tool call, no `error`, nothing on stderr — and Codex's own
rollout for the session (`~/.codex/sessions/2026/09/21/rollout-…-01a0c201-5e6c-….jsonl`) records
only the second message: the first was a sampling attempt the CLI discarded. It is the only one of
the set's 32 `agentMessage` items with no completion; left alone it dangles like observation 5's
command until the turn completes, 12 s later.

- Deltas are keyed by `itemId`, but a consumer that holds "the turn's open message" until that
  message completes appends the restatement to the abandoned one: two texts glued with no
  separator, under the first item's id and **its** phase. A restated `final_answer` arrives
  dressed as `commentary`, and is never taken for the turn's answer.
- No other item ever starts while an `agentMessage` is open anywhere in the set — tool calls do
  overlap each other (this same turn starts three `exec_command` items back to back), messages
  never do. So the next `item/started` of the same turn is a safe signal that an open message was
  abandoned; the normaliser closes it there, text-less, exactly as `turn/completed` would.
- The server never retracts the partial text. The abandoned item's deltas are the only record of
  it.

## 20. Goals (`thread/goal/*`) — read off the 0.155.1 sources, not captured

No capture here sets a goal. The only goal frame on record is the `thread/goal/cleared` after the
resume in `07-…` (line 75), and `10-…` lists `goals` as a stable feature, enabled by default
(`experimentalFeature/list`). Everything below was read off `codex-rs` at `rust-v0.155.1`
(`app-server/src/request_processors/thread_goal_processor.rs` and `thread_lifecycle.rs`,
`ext/goal/src/`, `state/src/runtime/goals.rs`, the TUI's `app/thread_goal_actions.rs`). It is what
the adapter (`goal.ts`, `session.ts`) relies on — goals spec §3.2 and §6.2.

- **The reply first, then the notification — and notifications can trail replies.**
  `thread/goal/set` answers `{goal}`, then sends `thread/goal/updated {threadId, turnId: null,
  goal}`. `thread/goal/clear` answers `{cleared}` and sends `thread/goal/cleared` only when it
  removed something. `thread/goal/get` answers `{goal: ThreadGoal | null}` and sends nothing.
  - The ordering problem: a reply is written directly, while the goal notifications go out
    through the thread's listener and event queues. So an `updated` queued BEFORE a set — a
    progress flush still saying `active` — can arrive AFTER the set's reply.
  - The adapter's rule: it reads the goal off only the replies no notification follows — a `get`,
    and a `clear` that found nothing (`cleared: false`). A set's or a successful clear's change is
    taken from its own notification. Reading it off the reply made a Stop's pause flicker
    `paused` → `resumed` → `paused`.
- **The resume snapshot.** After `thread/resume`'s reply (and its token-usage replay) the server
  sends `updated` when the thread has a goal and `cleared` when it has none — the frame in `07-…`.
  Then it runs its idle lifecycle, which starts a continuation turn when the goal is active. A goal
  store that cannot be read sends no snapshot at all. `thread/start` sends none either, because a
  new thread has no goal.
- **Continuation is the server's.** While the goal is active, every idle point starts a turn with a
  hidden prompt and no `userMessage` item: a turn's end (interrupted ones included), right after a
  resume, and right after a set that leaves it active. `turn/interrupt` does not pause the goal
  (openai/codex #28104), and the TUI pauses before it interrupts.
- **Set semantics.**
  - A set with an `objective` while a goal exists edits it in place: same row, same `createdAt`,
    counters kept.
  - With no goal, it creates a new row: `createdAt` is now, the counters start at 0 and the status
    defaults to `active`.
  - A missing `status` keeps the current one. A budget-limited goal cannot be paused or blocked; it
    stays `budgetLimited`. Setting `active` at or over the budget lands `budgetLimited`.
  - The model's `create_goal` rewrites a COMPLETE goal in place with a fresh `createdAt`, and
    refuses while a goal is unfinished.
  - A clean replace is `clear` then `set`, which is the TUI's rule.
- **Refusals** are `-32600` like everything else (observation 13), and only the message tells them
  apart: `goals feature is disabled`, `ephemeral thread does not support goals: <id>`,
  `cannot update goal for thread <id>: no goal exists`, and an objective outside 1–4000
  characters. The adapter reads exactly one of them, `no goal exists`, to answer `/goal pause`
  with `No goal is set.` instead of an error.
- **A goal's turns run on the thread's own settings.**
  `thread/settings/update {threadId, model?, effort?, serviceTier?, …}` answers `{}` and applies,
  without a turn, the same sticky overrides `turn/start` carries (observation 10). It is the only
  way a model picked together with a host `/goal` reaches the turns Codex starts by itself; the
  adapter sends it before the goal request (goals §4.6).
- **A collab child's own goal is announced on the child's thread id.** Children get the goal tools
  too (only review subagents do not), so `child-routing.ts` drops both goal notifications for a
  child rather than folding them onto the parent's goal.
- **Times are unix SECONDS**: `createdAt`, `updatedAt` and `timeUsedSeconds`.
- **Goals live in `goals_1.sqlite` under the thread's `CODEX_HOME`.** Another home is another goal
  store, which is why an account switch re-creates the goal there (goals spec §6.2.2).
