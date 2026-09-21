# OpenCode protocol fixtures

Real HTTP + SSE traffic captured from `opencode serve`, for the OpenCode adapter
(spec §4.5 "OpenCode", §4.6, §9). Nothing here is hand-written: every record is a
verbatim frame from a live server, driven once per scenario against a throwaway git
repo outside any real project.

| | |
|---|---|
| CLI | `opencode` **1.18.5** (`GET /global/health` → `{"healthy":true,"version":"1.18.5"}`) |
| Captured | **2026-09-21** |
| Server | `opencode serve --hostname 127.0.0.1 --port 0`, cwd = the throwaway repo |
| Provider | OpenRouter (the one credential in this host's default auth store) |
| Stream | `GET /event` (SSE) in every scenario that runs a turn |

## File format

NDJSON, one record per line, in capture order:

```jsonc
{"t": 9598, "kind": "sse",  "data": { /* the SSE frame, verbatim */ }}
{"t": 2522, "kind": "http", "data": {"method":"POST","path":"/session/ses_…/prompt_async",
                                     "requestBody":{…},"status":204,"responseBody":""}}
{"t": 2043, "kind": "stdout", "data": "opencode server listening on http://127.0.0.1:4096"}
{"t": 8916, "kind": "note",  "data": "…what the harness did and why"}
```

`t` is milliseconds since the harness started. `kind: "note"` records are the only
non-verbatim lines — they are the capture's own commentary and carry no protocol data.
An `http` record may also carry `requestHeaders` when the headers were the point of the
call. A record tagged `__server` belongs to a second server started inside the same
scenario.

### What was redacted or trimmed

- Every absolute path under this host's home is rewritten to `~`.
- API keys, tokens and email addresses are replaced with `<redacted>`.
- **`GET /config` and `GET /config/providers` have their bodies replaced by a
  shape-only skeleton.** This host's real config carries MCP server credentials and
  provider API keys; only key names and value *types* survive.
- `GET /provider` (4.3 MB on the wire), `/command`, `/skill`, `/agent` and
  `/provider/auth` are trimmed to a few representative entries. Every trim is marked
  inline with a `<fixture: …>` string. `connected` and `default` on `/provider` are
  kept verbatim, because those are the fields the adapter binds to.
- The `authorization` headers in fixture 01 are **not** redacted: that server was
  started with the throwaway password `fixture-password` specifically to record the
  auth handshake.

`openapi.json` is the server's own `GET /doc`, complete and minified (479 KB):
162 routes and an 89-member `Event` union. It is the reference for anything the
scenarios below do not exercise.

## The fixtures

| File | Model | What it demonstrates |
|---|---|---|
| `01-server-start-and-snapshot.ndjson` | none (no turn) | Server start and the whole no-session snapshot: `/global/health`, `/path`, `/project/current`, `/config`, `/config/providers`, `/provider`, `/provider/auth`, `/agent`, `/command`, `/skill`, `/experimental/capabilities`, `/session`, `/session/status`, `/permission`, `/question`, `/doc`. Then the `?directory=` vs `x-opencode-directory` forms, an unreal directory, and **part 2**: the same server restarted with `OPENCODE_SERVER_PASSWORD` set, probed with no credential, a wrong Basic, T3's exact `Basic base64("opencode:<pw>")`, an empty username and a Bearer. |
| `02-session-create-and-plain-text-turn.ndjson` | `google/gemini-2.5-flash-lite` | `POST /session` with the supervised ruleset, then `prompt_async` for a text-only turn: the complete SSE stream from `server.connected` to `session.idle`, and the post-turn reads (`/session/status`, `/message`, `/message/{id}`, `/children`). **This is the snapshot-vs-delta answer.** |
| `03-permission-ask-reply-once.ndjson` | `google/gemini-2.5-flash-lite` | Supervised ruleset re-asserted with `PATCH /session/{id}`; a `bash` tool call raises `permission.asked`; answered `once` on `POST /permission/{requestID}/reply`; the tool part's full `pending → running → completed` lifecycle. |
| `04-permission-reply-reject-and-always.ndjson` | `google/gemini-2.5-flash-lite` | The same ask answered `reject` (and the resulting tool `error` state), then `always` — followed by a **second, brand-new session on the same server** running the same command and raising **zero** asks. Proof that `always` is a directory-wide grant. |
| `05-question-asked-reply-and-reject.ndjson` | `google/gemini-3.1-flash-lite` | The `question` tool raising `question.asked`, `GET /question`, an answer on `POST /question/{id}/reply {answers:[["red"]]}`, then a second question in a fresh session rejected on `POST /question/{id}/reject` — the route T3 never calls. |
| `06-abort-with-permission-pending.ndjson` | `google/gemini-3.1-flash-lite` | `POST /session/{id}/abort` issued while a permission ask is still open. Shows the abort acknowledgement arriving as `session.error {MessageAbortedError}` **before** the HTTP reply, and the orphaned request still listed by `GET /permission` afterwards. |
| `07-todo-updated.ndjson` | `google/gemini-3.1-flash-lite` | Two `todowrite` calls driving `todo.updated`, plus `GET /session/{id}/todo`. Also captures `message.part.delta {field:"text"}` being used for **`reasoning`** parts. |
| `08-agent-plan-turn.ndjson` | `google/gemini-3.1-flash-lite` | A turn sent with `agent: "plan"`: how it surfaces on the user and assistant `message.updated` frames (`agent`/`mode`), and that no proposal event exists. |
| `09-summarize-idle-and-while-busy.ndjson` | `google/gemini-3.1-flash-lite` | `POST /session/{id}/summarize {auto:false}` on an idle session → `session.compacted`; then the same call **during an active turn**. |
| `10-fork-rollback-and-messages.ndjson` | `google/gemini-3.1-flash-lite` | `POST /session/{id}/fork {messageID}` and `GET /session/{fork}/message` against T3's exclusive-boundary count assertion; plus a whole-history fork with no `messageID`. Contains the premature-idle race at `t=9185`. |
| `11-slash-command-via-session-command.ndjson` | `google/gemini-3.1-flash-lite` | `GET /command` lookup for T3's `/^\/([^\s/]+)(?:\s+([\s\S]*))?$/`, then `POST /session/{id}/command`, the `command.executed` event, and a non-existent slash command falling through to `prompt_async` as literal text. |
| `12-two-sessions-one-server-and-a-child-session.ndjson` | `google/gemini-3.1-flash-lite` | Two sessions prompting concurrently on one server with every frame attributed, then a third session (full-access ruleset) whose `task` tool spawns a **child session** — its `parentID`, `GET /session/{parent}/children`, and the eight event types the child emits. |
| `13-error-shapes.ndjson` | `google/gemini-3.1-flash-lite` | Prompt/read/abort/summarize/fork against a non-existent session, a malformed session id, a rejected-by-schema body, an unknown provider, an unknown model (→ `session.error`), and replies to non-existent permission and question ids. |
| `14-process-behaviour-and-sigterm.ndjson` | `google/gemini-3.1-flash-lite` | What `--port 0` actually binds, what a **second** `--port 0` server does, an explicit free port, and a SIGTERM to the process group **mid-turn** with an in-flight HTTP read and an open SSE stream. |

---

## Protocol observations

Every place opencode 1.18.5's real behaviour differs from — or sharpens — what spec
§4.5 (OpenCode) and T3's `opencodeRuntime.ts` / `OpenCodeAdapter.ts` assume.

### 1. Readiness is announced exactly as the spec says — with one line in front of it

Fixture 01/14, `stdout`:

```
Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
opencode server listening on http://127.0.0.1:4096
```

T3's `OPENCODE_SERVER_READY_PREFIX = "opencode server listening"` and
`/on\s+(https?:\/\/[^\s]+)/` both still match, and the scrape must stay **line-oriented**
(`startsWith` per line, as T3 does) because the warning precedes the readiness line on
the same stream. With `OPENCODE_SERVER_PASSWORD` set, the warning disappears and the
readiness line is the first output. **No change needed.**

### 2. `--port 0` does not mean "ephemeral" — it means "4096, or ephemeral if 4096 is taken"

Fixture 14 records all three cases on one run:

```
"requested --port 0, actually listening on http://127.0.0.1:4096 — NOT an ephemeral port"
{"__server":"second","line":"opencode server listening on http://127.0.0.1:36503"}
"asked for --port 43347, got http://127.0.0.1:43347"
```

The spec's "the port comes from an ephemeral-port probe and the real URL is taken from
the stdout line, never assumed from the requested port" is therefore **both halves
mandatory**, not belt-and-braces. Passing the literal `0` would make the first project's
server silently occupy the well-known 4096, where a co-tenant `opencode` (a TUI, another
tool) could already be listening — and the health/version check would then be answered by
a server this daemon does not own. Pass a probed free port; keep trusting the stdout URL.

### 3. There is now a parallel `/api/*` namespace. The routes T3 uses all still exist

`openapi.json` has 162 routes. Alongside every legacy route the adapter needs, 1.18.5
adds an `/api/…` family with a different shape for exactly the two things the spec warns
about:

```
POST /permission/{requestID}/reply                              ← T3's route, still correct
POST /session/{sessionID}/permissions/{permissionID}            ← the SDK trap the spec names
POST /api/session/{sessionID}/permission/{requestID}/reply      ← new in 1.18.5
POST /question/{requestID}/reply | /reject                      ← T3's routes, still correct
POST /api/session/{sessionID}/question/{requestID}/reply|reject  ← new in 1.18.5
```

So there are now **three** spellings of "reply to a permission". Fixture 03 confirms the
spec's choice is the working one: `POST /permission/{requestID}/reply` with
`{"reply":"once"}` → `200 true`. Keep the spec's wording and add the `/api/` form to the
list of routes not to use.

### 4. Text arrives as **both** — incremental deltas plus a terminal snapshot

This is the spec's open question. Fixture 02, one assistant text part, verbatim order:

```jsonc
{"type":"message.part.updated","properties":{"part":{"id":"prt_0c19d6189001ebsovMpCoPGjDH","type":"text","text":"","time":{"start":…}}}}
{"type":"message.part.delta","properties":{"partID":"prt_0c19d6189001ebsovMpCoPGjDH","field":"text","delta":"hello"}}
{"type":"message.part.delta","properties":{"partID":"prt_0c19d6189001ebsovMpCoPGjDH","field":"text","delta":" world"}}
{"type":"message.part.updated","properties":{"part":{"id":"prt_0c19d6189001ebsovMpCoPGjDH","type":"text","text":"hello world","time":{"start":…,"end":…}}}}
```

The **deltas are authoritative and genuinely incremental**; the snapshots are an empty
opener that creates the part and a terminal full copy that closes it (`time.end`). No
partial snapshot was ever observed mid-stream in any fixture.

T3's design survives this unchanged and for the right reason: the delta branch appends,
and because it writes **both** `emittedText` and `text` before emitting, the closing
snapshot fed through `mergeOpenCodeAssistantText` yields `deltaToEmit === ""` and emits
nothing. The prefix-diffing is defensive, not the primary path — keep it, but the adapter
must not be written as if snapshots were the only source.

Two sharpenings for the adapter:

- The opening snapshot has `text: ""`, which is *defined*. T3's delta guard
  (`existingPart?.text === undefined` → drop) therefore passes. An adapter that instead
  keyed on truthiness would drop the first delta of every part.
- **`field: "text"` deltas are also used for `reasoning` parts.** Fixture 07:
  ```jsonc
  {"type":"message.part.updated","properties":{"part":{"id":"prt_0c1a65986001XR11B6zaewB1eH","type":"reasoning","text":"","time":{"start":…}}}}
  {"type":"message.part.delta","properties":{"partID":"prt_0c1a65986001XR11B6zaewB1eH","field":"text","delta":"**Executing Tool Calls**\n\nI've initiated…"}}
  ```
  The stream kind must come from the **part's** `type`, never from the delta's `field`.

### 5. A single `session.status: idle` is not turn completion — the race is real in 1.18.5

Fixture 10, 30 ms after `prompt_async` returned and 55 ms after the user message was
admitted, **before any assistant message exists**:

```jsonc
{"t":9155,"…":{"type":"message.updated","properties":{"info":{"id":"msg_01a0c1a83a91q19ku9e0fdjqjv","role":"user"}}}}
{"t":9185,"…":{"type":"session.status","properties":{"status":{"type":"busy"}}}}
{"t":9185,"…":{"type":"session.status","properties":{"status":{"type":"idle"}}}}
{"t":9185,"…":{"type":"session.idle"}}
```

The same bare `busy`→`idle` pair is emitted on every status recompute, including the real
completion at `t=9083`. This is precisely the condition
`schedulePromptAdmissionRecovery` exists for ("idle arriving before `promptAsync`
returns"), and it is **not** a rare edge case — it fired in an ordinary two-turn capture.
The spec's three completion machines are required, not defensive.

The unambiguous per-turn marker, for tests and for the adapter's own bookkeeping, is the
assistant `message.updated` whose `parentID` is the client-minted user message id gaining
`time.completed`. Every fixture from 12 onwards waits on that instead of on idle.

### 6. `session.idle` is a separate event, and after an abort it is the *only* one

T3 keys idleness purely on `session.status` and never handles `session.idle`. In the
normal case both fire together, so that works. But fixture 06, after
`POST /session/{id}/abort`:

```jsonc
{"t":10703,"…":{"type":"session.error","properties":{"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}}}}
{"t":10703,"…":{"type":"session.idle","properties":{"sessionID":"ses_…"}}}
```

No `session.status {"type":"idle"}` follows. A client keying only on `session.status`
learns of the abort from the `MessageAbortedError` (which T3 does handle) or from the
status poll — but `session.idle` is the cheapest signal and is free to add.

### 7. `GET /session/status` behaves exactly as the reconciler assumes

Busy: `{"ses_f3e59fb7affeW8iTraEqOrrRL6":{"type":"busy"}}`. Idle: `{}` — the key is
simply absent. T3's "a **missing entry counts as idle**" and its loose
`Record(String, Struct({type: String}))` decode are both correct against 1.18.5. The
three status literals are `idle`, `busy`, `retry` (`SessionStatus` in `openapi.json`;
only `idle`/`busy` were observed live).

### 8. `prompt_async` answers `204` with an empty body

Fixture 02: `POST /session/{id}/prompt_async … -> 204 ""`. Nothing in the response
identifies the turn, which is why the client-minted `messageID` is load-bearing. The
minted id in T3's shape (`msg_` + 12 hex + 14 alnum) was accepted in every fixture and
comes back unchanged as `message.updated.properties.info.id`.

### 9. `permission.asked` carries two fields T3 never reads, and both are useful

Fixture 03, verbatim:

```jsonc
{"type":"permission.asked","properties":{
  "id":"per_0c19e021c001FcWaFIxZ1DySMs",
  "sessionID":"ses_f3e621707ffej6ZWX9gnB3hIjM",
  "permission":"bash",
  "patterns":["echo hi"],
  "metadata":{"command":"echo hi"},
  "always":["echo *"],
  "tool":{"messageID":"msg_0c19ded50001nNkc8pGBm0kuIK","callID":"tool_bash_hUFbWmc0v5dvHJZ6lgfR"}}}
```

- **`always`** is the pattern list an `always` reply would persist. The spec's
  "Allow for workspace **with a warning that it applies to other sessions in the same
  workspace**" can now name the pattern the user is actually widening (`echo *`, not
  `echo hi`).
- **`tool: {messageID, callID}`** links the ask to the exact tool part. The approval card
  can be attached to the right activity row without matching on text.

There is still **no** options/label array, so the spec's "when `options` is absent the UI
shows the default set of §4.3" applies to OpenCode as well as Grok.

### 10. `always` really is directory-wide and cross-session — captured, not inferred

Fixture 04 is the evidence behind spec §3.2's one-shot-grant rule and §4.3's
"OpenCode auto-answers each ask `once`, never `always`". Session A answered `always` for
`echo two`; a brand-new session B was then created on the **same server** with the
**same** supervised ruleset and prompted with the same command:

```
"session B raised 0 permission ask(s) for the command session A granted with `always`
 — 0 means the grant widened across sessions in this directory"
```

B's `bash` call went straight to `running`. The rule is not a precaution; violating it
demonstrably widens a co-tenant thread.

### 11. An aborted turn leaves its permission request open forever

Fixture 06, after the abort landed and the session went idle:

```jsonc
{"method":"GET","path":"/permission","status":200,
 "responseBody":[{"id":"per_0c1a6242c001R6cJIBJeds0s1l","sessionID":"ses_…","permission":"bash",…}]}
```

Nothing garbage-collects it. The spec's **"settle before interrupt"** rule (§4.1: every
pending approval resolved with `cancel` and emitted as `request.resolved` before
`interruptTurn` reaches the provider) is therefore correctness, not tidiness — without it
the next `GET /permission` recovery sweep re-opens a card for a turn that no longer exists.

Related: **`POST /session/<nonexistent>/abort` returns `200 true`** (fixture 13). Abort is
not 404-guarded, so a successful abort proves nothing about the session existing.

### 12. Three different error envelopes, and a malformed id is a 500 rather than a 404

Fixture 13:

```jsonc
// session routes, 404
{"name":"NotFoundError","data":{"message":"Session not found: ses_000000000000000000000000000"}}
// permission / question replies, 404 — a different envelope entirely
{"_tag":"PermissionNotFoundError","requestID":"per_0…","message":"Permission request not found: per_0…"}
{"_tag":"QuestionNotFoundError","requestID":"que_0…","message":"Question request not found: que_0…"}
// stream errors
{"type":"session.error","properties":{"error":{"name":"UnknownError","data":{"message":"Model not found: …"}}}}
```

and

```jsonc
{"method":"GET","path":"/session/not-a-session-id","status":500,
 "responseBody":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_7b10b4a8"}}}
```

The spec says only a **structurally confirmed 404** may fall through to a fresh session.
1.18.5 makes that easy — the status code alone is definitive and the body is flat, no
`cause`/`body` nesting to walk — but it also shows the failure this guards against: a
cursor holding a malformed id produces a **500**, which must never be read as
"session gone, start a new one".

### 13. A bad model is accepted, then fails asynchronously, three times, with stack traces

Fixture 13: `POST …/prompt_async` with `{"providerID":"openrouter","modelID":"definitely/not-a-real-model"}`
returns **204**. Then, on the stream:

```jsonc
{"type":"session.error","properties":{"error":{"name":"UnknownError","data":{"message":"Model not found: openrouter/definitely/not-a-real-model. Did you mean: …?"}}}}
{"type":"session.error","properties":{"error":{"name":"UnknownError","data":{"message":"ProviderModelNotFoundError: Model not found: …\n    at <anonymous> (/$bunfs/root/chunk-55r7fwsc.js:439:93384)\n    at SessionPrompt.getModel …"}}}}
```

Three frames for one prompt, two of them carrying a full bun stack trace inside
`data.message`, and the real error class (`ProviderModelNotFoundError`) appears only in
the message text — `name` is always `UnknownError`. The adapter must dedupe consecutive
`session.error` frames for one turn and truncate the message before it becomes a
`runtime.error {class: "provider_error"}` the user reads.

### 14. A prompt can be admitted, go busy, go idle and produce nothing at all

Observed twice while capturing (once in an earlier take of fixture 05, once in an earlier
take of fixture 12): the turn is accepted with 204, `session.status` goes `busy`, the
assistant `message.updated` is created, and then — with no `session.error`, no parts and
in one case zero tokens — the session goes idle with `finish:"unknown"`. This is the
silent failure `schedulePromptAdmissionRecovery` hard-fails on after 5 attempts
(`turn.completed {state:"failed"}` + `runtime.error {transport_error}`). Keep that
terminal path; without it the tab hangs with no explanation.

### 15. `session.command` is blocking, and its `command.executed` names the *assistant* message

Fixture 11. The call takes 4.5 s and returns the finished message:

```jsonc
{"method":"POST","path":"/session/ses_…/command",
 "requestBody":{"messageID":"msg_01a0c1a8536dph8pzsk4yaiw0t","command":"fixture","arguments":"hello there",
                "model":"openrouter/google/gemini-3.1-flash-lite","parts":[]},
 "status":200,"responseBody":{"info":{"id":"msg_0c1a85708001dnLKOl1Ka50mwa","role":"assistant",…},"parts":[…]}}
{"type":"command.executed","properties":{"name":"fixture","sessionID":"ses_…","arguments":"hello there",
                                          "messageID":"msg_0c1a85708001dnLKOl1Ka50mwa"}}
```

Three things the spec's paragraph should absorb:

- The `model` **string** vs `prompt_async`'s `{providerID, modelID}` **object** asymmetry
  is real and still present; the OpenAPI confirms it (`session.command.model: {type:"string"}`).
- `session.command` accepts no `system` field at all — the schema has none. The spec's
  "accepts no `system` addendum" is exact.
- **`command.executed.messageID` is the assistant message id, not the client-minted user
  id.** Matching prompt admission on that field would never resolve. The user message is
  still the minted `msg_01a0c1a8536d…`, visible in `GET /session/{id}/message`.

Command rows from `GET /command` carry `name`, `description`, `source`, `template`,
`hints`, and also `agent`, `model` and `subtask`. `hints` was present on every row, so
T3's unguarded `command.hints.join(" ")` is safe in 1.18.5 — but it is one optional field
away from throwing, and `source: "skill"` rows exist exactly as T3 expects.

### 16. The server does **not** refuse `summarize` during an active turn

Fixture 09. Idle session: `POST /session/{id}/summarize {"auto":false}` → `200 true`, then
`session.compacted`. Then, with a turn confirmed `busy`, the identical call:

```jsonc
{"method":"POST","path":"/session/ses_…/summarize",
 "requestBody":{"providerID":"openrouter","modelID":"google/gemini-3.1-flash-lite","auto":false},
 "status":200,"responseBody":true}
{"type":"session.compacted","properties":{"sessionID":"ses_…"}}
```

It compacts anyway, mid-turn. The spec's "an explicit refusal while a turn is active" is
therefore a **client-side invariant with no server backstop** — it must be enforced in the
adapter or a user can compact the context out from under a running turn.

Also: `session.compacted` carries only `{sessionID}`. There are no before/after token
counts on it, so `thread.state.changed {compacted, beforeTokens, afterTokens}` cannot be
filled from this event — the numbers have to come from the adapter's own accumulator.

### 17. Fork re-mints every message id

Fixture 10. The boundary fork behaved exactly as T3 asserts — forking at
`entries[0]` produced a session with **0** messages, so the exclusive-boundary count check
(`forkMessages.length === entries.indexOf(firstRemovedMessage)`) holds. But the
whole-history fork (no `messageID`, the cwd-change path) returned the same three messages
under **new ids**:

```
source: ["user:msg_01a0c1a820dejm111tv9pnrcc6","assistant:msg_0c1a825550011EKYcpxIULTkGe","user:msg_01a0c1a83a91q19ku9e0fdjqjv"]
fork:   ["user:msg_0c1a83b79001ZYCfr6tG7OmgX4","assistant:msg_0c1a83b7f001i1YwSfjJum93eB","user:msg_0c1a83b9e001k5WTlcLGKj2hnF"]
```

No client-held message id survives a fork. Anything the host persists that points at an
upstream message id — a checkpoint, a revert boundary, a prompt-admission key — must be
invalidated or remapped when `startSession` forks for a cwd change, not only on rollback.

`GET /session/{id}/message` also lags: at `t=9165` it returned three messages while the
fourth turn's user message had only just been admitted. Reads are not a substitute for
the stream.

### 18. `session.next.*` and `*.v2.*` are documented but dormant; `server.heartbeat` is the reverse

The documented `Event` union in `openapi.json` has **89** members. Of those, **32** are a
`session.next.*` family that looks like a future per-token streaming protocol
(`session.next.text.delta`, `tool.input.started/delta/ended`, `tool.called/progress/success/failed`,
`step.started/ended/failed`, `compaction.*`, `revert.*`, `prompt.admitted`), and five are
`permission.v2.asked/replied` and `question.v2.asked/replied/rejected`.

**None of the 37 fired in any capture.** 1.18.5 still emits the legacy
`message.part.updated` / `message.part.delta` / `permission.*` / `question.*` family on
`GET /event`. Treat them as a forward-compat surface: ignore, but do not let an
exhaustiveness check built from the OpenAPI assume they are live.

The reverse also holds — one event is emitted that the OpenAPI does **not** document:

```jsonc
{"id":"evt_0c1a62b77001ybIZuAO4vvkHCC","type":"server.heartbeat","properties":{}}
```

It arrives roughly every 10 s on an idle stream. Any `satisfies never` guard generated
from `openapi.json` will trip on it, so the adapter's fallback (surface + `runtime.warning`,
per spec §4.2) must be genuinely reachable — and `server.heartbeat` specifically should be
allow-listed as "known, ignored" rather than warned about every ten seconds.

Full list of event types observed live across the fixtures:

```
server.connected  server.heartbeat  session.created  session.updated  session.status
session.idle      session.diff      session.error    session.compacted
message.updated   message.part.updated  message.part.delta
permission.asked  permission.replied
question.asked    question.replied  question.rejected
todo.updated      command.executed
plugin.added      catalog.updated   reference.updated  integration.updated
```

The last four are startup/config chatter with no session id; they arrive in a burst during
the first turn while plugins load. `session.diff` (`{sessionID, diff: []}`) fires after
every turn and is not in T3's switch.

### 19. One server safely multiplexes the sessions of one project — confirmed

The spec's §3.2 divergence (one `opencode serve` **per project**, shared by its threads)
rests on frames being attributable. Fixture 12 ran two sessions' turns concurrently on one
server:

```
"frames by owning session after two concurrent turns: {"no-session-id":50,"A":23,"B":23}"
```

Every session-bearing frame carried its own `sessionID`; the 50 unattributed frames are the
`plugin.added` / `catalog.updated` / `server.*` startup chatter, which has no session by
design. `session.updated` and `session.created` carry it as `properties.info.id` rather
than `properties.sessionID`, so an extractor must read both (T3's `openCodeEventSessionId`
already does).

A child session is also cleanly identified. The `task` tool produced:

```jsonc
{"method":"GET","path":"/session/ses_f3dfd4e50ffe7r6H3Rf8jBDXUl/children","status":200,
 "responseBody":[{"id":"ses_f3dfd3d8fffeHrM6kT1FcC9I6q","parentID":"ses_f3dfd4e50ffe7r6H3Rf8jBDXUl",
                  "title":"list files (@explore subagent)",…}]}
```

and the child emitted **38 frames across eight types** on the shared stream:

```
{"session.created":1,"session.updated":5,"message.updated":9,"message.part.updated":12,
 "session.status":6,"session.diff":3,"message.part.delta":1,"session.idle":1}
```

**Not one of them is a permission or question event**, so T3's child filter drops all 38.
That is the whole mechanism behind the spec's "this is the reason the OpenCode roster is
thinner than Claude's" — the subagent's text, tool calls and status are on the wire and
are being deliberately discarded. If the roster (§7.6) should ever show OpenCode subagents,
the change is in that filter, not in the transport, and the child's title
(`"list files (@explore subagent)"`) already carries the agent name.

### 20. Auth: T3's Basic scheme is exact, and the username is checked

Fixture 01 part 2, against a server started with `OPENCODE_SERVER_PASSWORD=fixture-password`:

| Credential | Result |
|---|---|
| none, on `GET /global/health` | **401**, empty body |
| none, on `GET /agent` | **401**, empty body |
| `Basic base64("opencode:wrong")` | **401** |
| `Basic base64("opencode:fixture-password")` | **200** |
| `Basic base64(":fixture-password")` | **401** |
| `Bearer fixture-password` | **401** |

So the spec's `Authorization: Basic base64("opencode:<password>")` is right down to the
literal username, and the empty-username form is rejected. The important consequence:
**`/global/health` is behind the same gate**, so the post-start health-and-minimum-version
check must already carry the credential — it cannot be done before the password is known.

The env var is `OPENCODE_SERVER_PASSWORD`, and its absence is announced on stdout
(observation 1).

### 21. The `directory` travels on either the header or the query, and is not validated

Fixture 01. All four forms answered `200` with the same body on a `GET`:

| Form | Result |
|---|---|
| nothing | 200 |
| `?directory=<raw path>` | 200 |
| `x-opencode-directory: <raw path>` | 200 |
| `x-opencode-directory: <percent-encoded path>` | 200 |

The SDK's "rewrite the header to `?directory=` on GET/HEAD" is a client convention, not a
server requirement — the header works on GET too. And a directory that does not exist is
**not rejected**:

```jsonc
{"method":"GET","path":"/agent?directory=%2Fnope%2Fnot%2Fa%2Freal%2Fdir","status":200,…}
```

It silently serves a different instance scope. A typo in the per-project directory will not
surface as an error; it will surface as an empty or wrong project. Resolve the path before
it becomes a client-level `directory`.

### 22. The catalogue is enormous; the snapshot cache is a requirement

`GET /provider` on this host returned **4.3 MB** (172 providers, 342 OpenRouter models),
`/command` 242 KB, `/skill` 230 KB, `/config/providers` 263 KB, `/agent` 62 KB. Spec §3.2's
"provider snapshots refresh on a slow interval, not per request … serialised so two clients
opening Settings cannot run two probes" is a hard requirement at this size, and
`loadOpenCodeInventory`'s four unbounded-concurrency GETs will move ~5 MB every time.

Shapes the adapter binds to are unchanged from T3's assumptions:

- `{all, default, connected}` with `"connected":["openrouter","opencode"]` — login
  inference from `connected.length > 0` works.
- **`model.variants` is an object**, not an array — T3's `Object.keys` is correct. It is
  richer than T3 uses: the values carry the reasoning effort the variant maps to, so the
  "Reasoning" select can be built from real data instead of the synthesised
  `low/medium/high/xhigh` fallback. From the trimmed `/provider` in fixture 01:
  ```jsonc
  "google/gemini-2.5-flash-lite": {"variants":{"low":{"reasoning":{"effort":"low"}},"medium":{…},"high":{…}}}
  "google/gemini-3.1-flash-lite": {"variants":{"minimal":{…},"low":{…},"medium":{…},"high":{…}}}
  "qwen/qwen3.7-max":             {"variants":{}}
  ```
  Note `minimal` exists on newer models and is not in T3's synthesised list.
- Slug `"${provider.id}/${model.id}"` round-trips.
- Agents come back as `build(primary) compaction(primary,hidden) explore(subagent)
  general(subagent) plan(primary) summary(primary,hidden) title(primary,hidden)` — the
  `mode`/`hidden` filter and the `"build"` default both still apply.
- **`GET /config` and `GET /config/providers` return live credentials.** Neither is needed
  by the adapter; both must stay out of anything logged, cached or shipped. (They are the
  reason those two bodies are redacted in fixture 01.)

### 23. Token usage shape matches — every field T3 dereferences is present

`step-finish` parts, fixture 03:

```jsonc
{"type":"step-finish","reason":"tool-calls",
 "tokens":{"total":38543,"input":38482,"output":4,"reasoning":57,"cache":{"write":0,"read":0}},
 "cost":0.0038726}
```

`input`, `output`, `reasoning` and `cache.{read,write}` are all present on every step, so
`accumulateOpenCodeStepUsage`'s unguarded arithmetic is safe against 1.18.5. There is also
a `total` and a per-step `cost` that T3 ignores; `cost` would let the timeline show a real
per-turn figure without a price table. Assistant `message.updated` carries the same
`tokens` and `cost` rolled up, plus `finish` (`"stop"`, `"tool-calls"`, `"unknown"`).

### 24. Smaller notes

- `POST /session` takes the ruleset in the create body (`permission`), and `session.created`
  echoes it back in full. T3 only ever writes it with `PATCH /session/{id}`; both work, and
  sending it at create closes the window where a session exists with default permissions.
- The prompt body's `additionalProperties: false` is **not enforced at runtime**: sending a
  redundant `sessionID` in the `prompt_async` body returned `204`, not a 400 (fixture 13).
  Do not rely on the server to reject a malformed body.
- `GET /session/{id}/todo` returns the same rows as `todo.updated`, each with a `priority`
  field T3 does not read. Statuses observed: `pending`, `in_progress`, `completed`.
- `agent: "plan"` propagates onto both messages as `info.agent: "plan"` and the assistant's
  `info.mode: "plan"` (fixture 08). No proposal event of any kind is emitted — the spec's
  "OpenCode `agent: \"plan\"` (no proposal event)" is confirmed.
- `question.asked` payload (fixture 05) matches T3's reader, and carries the same
  `tool: {messageID, callID}` link as `permission.asked`:
  ```jsonc
  {"id":"que_0c1a41bac0011MlFBjn2GhkVie","sessionID":"ses_…",
   "questions":[{"question":"which colour do you prefer","header":"Colour Preference",
                 "options":[{"label":"red","description":"I prefer red"},{"label":"blue","description":"I prefer blue"}]}],
   "tool":{"messageID":"msg_…","callID":"call_34689"}}
  ```
  `POST /question/{id}/reply {"answers":[["red"]]}` → `200 true`, and
  `POST /question/{id}/reject` (no body) → `200 true` with a `question.rejected` event. The
  reject route works and is worth using for `/dismiss`, even though T3 never calls it.
- On SIGTERM to the process group mid-turn (fixture 14) the server prints **nothing** on the
  way out — no farewell line, no flush. The in-flight `GET` fails as a transport error
  (`fetch failed`) and the SSE stream ends with `terminated`. A client learns only from the
  transport, so the supervision in spec §3.1 cannot wait for an orderly signal.

---

## Reproducing

The capture harness is deliberately **not** in this repo — a fixture is produced by driving
the real CLI once and committing the result (spec §9, "there is no record mode"). It was a
plain Node script using `fetch` and a hand-rolled SSE reader, run against a throwaway repo
under `/tmp`. To re-capture after an OpenCode upgrade, re-drive the scenarios in the table
above, re-run the redaction, and update the version and date at the top of this file — a
capture whose origin is unknown cannot be judged when the protocol moves.
