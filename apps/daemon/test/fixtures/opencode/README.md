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

- Every absolute path under this host's home is rewritten to `~` — in its **percent-encoded**
  spelling too (`%2Fvar%2Flib%2F…`, either hex case), which every `?directory=` query uses for
  the cwd. Missed by the plain-path rule until 2026-09-26; that export applied it to every file
  (01–14), and nothing else in them changed. The adapter's own redactor (`support/stderr.ts`,
  which `raw.ndjson` goes through) collapses both spellings as well.
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

1.18.32 no longer leaves it there (read from the source, not captured): an ask whose run the
abort interrupts drops out of `GET /permission` and `GET /question` by itself, with no event
saying so — observation 29, which is also what a request reaching the thread after a Stop
is judged by.

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
T3 discards them.

**Orquester routes them instead** (the `demuxChild` branch of the adapter's normaliser), so
the roster shows whatever the provider reports. The mapping this capture supports:

| Frame | Becomes |
|---|---|
| child `session.created` | no row yet — it registers the child; `taskId` = `agentId` = the **child session id**, the only identifier every one of these frames carries |
| the parent's `task` part going `running` (next frame) | `task.started` with `toolUseId` = the part's `callID`, the launch id a relaunch is told apart by (observation 26), then `task.progress` |
| child `session.updated` | `task.progress` on a real title change (an unchanged title is re-stated on every recompute — observation 25) |
| child `session.status` | `task.updated {status: running \| idle}` |
| child `session.idle` | `task.completed {status:"completed"}` — the child's terminal signal; the parent's `task` part that follows it gives that end its result (observation 27) |
| child `session.error` | `task.completed {status:"failed"}` |
| child `message.part.updated` (tool) | `task.progress {lastToolName}` **and** an `item.*` row stamped `agentId`; while a command runs, its output as `command_output` chunks stamped the same (observation 28) |
| child text / reasoning parts | `content.delta` stamped `agentId` |
| child `todo.updated` | `task.progress` with an `n/m steps done` summary — a child's plan is its own, and must not overwrite the thread's `turn.plan` |

The identity comes from two places, and both are needed. The child's own
`session.created` carries `parentID`, `title` (`"list files (@explore subagent)"`) and
`agent` (`"explore"`); the **parent's** `task` tool part carries the rest, and only from
its `running` frame onwards — the `pending` one has an empty `input`:

```jsonc
{"type":"tool","tool":"task","callID":"call_107260",
 "state":{"title":"list files",
          "metadata":{"parentSessionId":"ses_f3dfd4e5…","sessionId":"ses_f3dfd3d8…",
                      "model":{"modelID":"google/gemini-3.1-flash-lite","providerID":"openrouter"}},
          "status":"running",
          "input":{"subagent_type":"explore","prompt":"List the files…","description":"list files"}}}
```

so `toolUseId` = `callID`, `role` = `subagent_type`, `model` = `providerID/modelID` and
`description` = `input.description`. Linkage is repeated on **every** task row (§4.2);
`agentKind` is left for the host to stamp at ingestion.

Two invariants worth restating: a child's `step-finish` tokens are a *different session's*
spend and never join the parent turn's accumulator (only `hasSubagents` is set), and a
child's permission/question frames keep the original routing — an approval belongs on the
parent thread whichever session raised it. The parent THREAD, not the parent's turn, for a
question: a child session's question and its resolution ride no turn (`questionTurnId`, Codex's
and Grok's rule), because a turn's end dismisses the questions on it in the log only and a
background child outlives the parent's turn. An approval rides the parent's open turn.

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

**That `total` is the context meter, and `GET /provider` is its denominator** — so §4.5's
`reportsContextWindow: false` is wrong for 1.18.5 and this adapter sets it **true**. Each owned
step's `tokens.total` is the size of the context *that* model call carried (38 543 then 38 490 in
fixture 03), and the catalogue carries the window beside every model:

```jsonc
"limit":{"context":1000000,"output":128000}
```

keyed `"<providerID>/<modelID>"`, the same slug a thread's `modelSelection.model` uses. Read once
per server and cached on its URL. Two rules carry over unchanged from observation 19: a **child**
session's steps are a different session's spend and never move the parent's meter (fixture 12's
child spent 3 538 / 3 585 on the same server while the parent read 43 803 / 43 950), and the
running sum of the parent's owned steps — not any one of them — is §7.6's *total processed*. A
model the catalogue does not describe emits the count with no `maxTokens`, and the client degrades
to a bare total rather than drawing a ring against a guess.

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

### 25. `session.updated` re-states an unchanged title on every recompute

Added by the **adapter** package (W8) from a live one-turn run against
`opencode/big-pickle` on 1.18.5, not from a committed capture. A session created
with `title: "orquester smoke"` produced four `session.updated` frames carrying
that same title — three during the turn and one after `session.idle`:

```jsonc
{"type":"session.updated","properties":{"sessionID":"ses_…","info":{"id":"ses_…","title":"orquester smoke",…}}}
```

T3 guards only against OpenCode's own *placeholder* titles
(`isOpenCodeDefaultTitle`), so a real title mirrors to
`thread.metadata.updated` once per frame. The adapter additionally remembers the
last title it mirrored and emits only on a genuine change; the guard is reset
when a fork re-points the session (`repointSession`), because the fork is a
different upstream session.

The same run confirms two things the captures already implied: a real model
emits `reasoning` parts whose deltas arrive as `field: "text"` (observation 4),
and `step-finish` usage accumulates to a `complete` turn total
(`input + cache.read + cache.write`, `output + reasoning`).

### 26. A `task` call with `task_id` resumes a child — no `session.created`, and a new call

**Read from the CLI's source, not captured.** Added with the relaunch contract
(plan `2026-09-24-subagent-output-long-calls-and-composer-sends`, Task 1) from the
`TaskTool` source embedded in the installed **1.18.32** binary. For 1.18.5 the
parameter is inferred: fixture 12's `task` output already carries the
`<task id="ses_…" state="completed">` envelope a resume reads its id from.

The `task` tool takes an optional `task_id` — *"This should only be set if you mean to
resume a previous task (you can pass a prior task_id and the task will continue the same
subagent session as before instead of creating a fresh one)"*. Its `execute`, in order:

1. `task_id` names an existing session → that session; otherwise
   `create({parentID, title: "<description> (@<agent> subagent)"})` — the only
   `session.created`, so **a resume emits none**;
2. `metadata({title, metadata: {parentSessionId, sessionId, model}})` — the part's
   `running` frame, naming the child, **before**
3. the child is prompted and its own frames begin; the part then completes with
   `<task id="…" state="completed">…</task>`.

Two more paths come out of the same function. A call naming a child whose job is still
running is handed to that job as more context and answers at once — `metadata.background:
true`, a `jobId`, and an output whose `state` is `running` ("Background task updated").
And `background: true`, honoured only with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
on the server, completes the part the same way while the child works ("Background task
started").

What the normaliser makes of it (`linkChildFromTaskPart`):

- The child's `session.created` emits no row; the parent's `running` part starts the run, so
  its `task.started` carries the `callID` — the id the roster fold compares to tell a
  relaunch from a late delivery (AGENTS.md, "Agent rows must survive resumes and
  retention").
- A live part naming a **settled** child under a `callID` never seen for it is a relaunch: a
  new `task.started` naming it, before any row of the new run; the child's own
  `session.idle` ends it, and the part's own end then gives that run its result
  (observation 27).
- Any other part whose `callID` is not the child's current launch — a frame of any call
  seen for it before (an earlier launch, a call handed over while it worked), a call on a
  child that is still working — emits no task row: it can neither start a run nor end one.
- A `completed` part with `metadata.background: true` does not settle the child.

A capture of a real `task_id` resume would confirm the frame order; none has been made.

### 27. A child's run ends before the part that carries its answer

Fixture 12, lines 177-180: the child settles, and only THEN does the parent's `task` part
complete with what the child said:

```jsonc
{"type":"session.status","properties":{"sessionID":"ses_f3dfd3d8…","status":{"type":"busy"}}}
{"type":"session.status","properties":{"sessionID":"ses_f3dfd3d8…","status":{"type":"idle"}}}
{"type":"session.idle","properties":{"sessionID":"ses_f3dfd3d8…"}}
{"type":"message.part.updated","properties":{"part":{"tool":"task","callID":"call_107260",
  "state":{"status":"completed","output":"<task id=\"ses_f3dfd3d8…\" state=\"completed\">\n<task_result>\nThe files in the current directory are:\n\n- README.md\n- a.ts\n</task_result>\n</task>",…}}}}
```

The child's `session.idle` is its run's end (observation 19), so that end carries no result,
and a second end was never written: every OpenCode roster row read `result: null`. The part
now gives the run's end its result — one more `task.completed` of the same run, same linkage,
`status: "completed"`, `summary` the text inside `<task_result>` — which the roster fold takes
the way it takes a result from any later completion of a settled row: status and times kept,
nothing reopened. Once per run: a repeated frame of the part, a stale part of an earlier call
(observation 26) and a background answer (`metadata.background`, "still working") add nothing.
A part that errors after the idle gives its error text the same way; the run's end stays the
child's `completed`. A part that settles FIRST ends the run itself, with the same text.

The envelope is the `task` tool's wrapping for the parent's model: `<task id="…" state="…">`,
an optional `<summary>` line, then `<task_result>` (or `<task_error>`) around the text. 1.18.5
writes it as above; 1.18.32's `TaskTool` builds the same one (`Ur`, read from the source, not
captured). An output of any other shape is the result as it stands.

**A background run's answer never rides its part.** Read from 1.18.32's `TaskTool` source, not
captured: a call run in the background completes at once with a `state="running"` envelope
("Background task started", `metadata.background: true`), and when the child's job settles,
`injectBackgroundResult` **prompts the session that made the call** with the answer — a user
message whose one text part is `synthetic: true`, its text the same envelope naming the child in
`id`, with a `<summary>Background task completed: <description></summary>` line
(`state="error"` and `<task_error>` for a failed job). The normaliser takes that part as the
run's result, once, as it takes a foreground part's output (`takeBackgroundResult`); an answer
that comes before the child's own `session.idle` rides that end instead. A part that is not
`synthetic`, or names no child of the thread, is no result.

Only a run whose launching part answered in the background takes such an answer, and only one
whose summary, where it names the call's description, names this run's: an answer that arrives
after a relaunch is the earlier run's, and never becomes the new run's result.

How that prompt renders: live, it is no row at all — the demux emits no user-role text part,
whoever wrote it (the host writes a thread's own prompts from its `/turn` commands, never from
the stream, and this one it never wrote at all). A thread adopted from OpenCode's own history
(`history.ts`) skips every `synthetic` user text part — the server wrote it, the user never
typed it — so a prompt made only of such parts replays no `You` row, and the reply keeps its
turn. History replays no roster rows at all (it reads the thread's own session, whose `task`
parts replay as plain collab-agent calls), so a background run's result is filled on the live
path only.

**That prompt wakes the parent, and its reply is a turn.** Read from 1.18.32's source, not
captured: `injectBackgroundResult` calls the session's `prompt` with no `messageID` — the server
mints the prompt's id — through `SessionPrompt.prompt`, the same path a `prompt_async` takes, so
the frames are the ones fixture 12 shows for any prompt (lines 122-123, then 186-202): the user
message and its `synthetic` part, the run's `busy`, the reply's assistant `message.updated` naming
the prompt as its `parentID` (the run answers the NEWEST user message, `MessageV2.latest`), its
parts and completion, then `busy` → `idle` → `session.idle` when the run ends. A prompt that
arrives while a run is going joins it (`SessionRunState.ensureRunning` awaits a running run), so
the run answers it before it goes idle.

The reply used to stream as rows with no turn, and the thread read idle while the parent's model
wrote it. Now the first `message.updated` of an assistant message decides whose reply it is
(`claimReply`): a reply to a prompt the host sent (`sendTurn` claims each one it mints before
sending it) or one a turn already claimed is that turn's; a reply to any other prompt is claimed
by the turn running when it begins, and while none runs it opens one — `turn.started` named by the
prompt's id, as a live turn is named by its prompt (a rewind finds it again), before any row of
the reply, and a `turn-woken` signal the session's record follows. From there it is any turn: the
run's idle settles it, a `session.error` fails it, a Stop aborts it, the session's stop closes it,
a message the user sends meanwhile steers it (OpenCode queues it into the same run), a second
answer arriving mid-run joins it, and a host that dies mid-reply leaves it to the next host's
reconcile, like any running turn. Its steps count as the turn's own (`promptMessageIds`).

It opens only with a run behind it: the parent's `busy` since its last `idle` (`parentBusy` —
`SessionPrompt.run` sets `busy` at the top of every loop iteration, before it writes a reply).
With no run, no `idle` would ever settle the turn, and `turn.started` alone never arms the host's
watchdog, so it would hold a deploy's drain until the user acted. A reconnect clears the evidence;
a live run says `busy` again at its next iteration. Never opened: a reply that has already
ended — a fork copies a session's messages whole, completed ones included (fixture 10), and a
rewind claims every prompt its fork copied, so a copy its dead run never completed opens nothing
either — and anything that follows an interruption, which the demux drops first. That last guard
lasts until a later turn settles, by ANY path: a later turn that failed (a rate limit) used to
leave the Stop's id behind for good (`completeTurn` alone cleared it), and every woken reply after
it was dropped — never written, the thread idle.

A compaction's summary (`summary: true`, fixture 09) answers no prompt of the conversation: its
prompt is claimed but never joins `promptMessageIds`, so the summary call stays off the meter and
the turn's usage. While no turn runs it is either the host's own `/compact` — `compact()` holds
`hostCompacting` up across its `summarize` request, which answers only once the compaction's run
ended — and stays turnless, or a woken run's own: a run whose last answer already overflows the
model's context compacts FIRST (`SessionPrompt.run` → `SessionCompaction.create {auto: true}`;
read from the source), so the summary opens the woken turn, named by the compaction's prompt, and
the thread reads working through the compaction. The reply to the prompt the compaction writes to
go on with — one `synthetic` text part marked `metadata.compaction_continue` — then joins it like
any mid-run prompt, and counts.

**A background run outlives a turn that fails.** Read from 1.18.32's source: a background job
ends by itself or by `SessionRunState.cancel` — which the `abort` route (`SessionHttpApi.abort` →
`SessionPrompt.cancel`) runs, cancelling every job the session launched (`cancelBackgroundJobs`,
children's children included) — and by nothing else: a turn that fails on its own (a
`session.error`, a rate limit) leaves it running, and its answer comes later as ever. The adapter
closed every live child `stopped` on any failed turn, so such a child read "interrupted" while it
worked, left the liveness a deploy's drain waits on, and found no run to take its answer as the
result. A turn that fails on its own now closes only the runs that fail with it — a child whose
launching part answered in the background (`answersInBackground`), or one running inside such a
child, lives on (`closeLiveChildAgents` with `scope: "foreground"`) and ends as any background run
does: its own idle and answer, a Stop, the session's stop or the exit. A failed admission still
closes every child: its abort IS `SessionRunState.cancel`. And the failed turn returns the session
to `ready`, as Claude's and Grok's do after every settled turn: an `error` session reads, to the
roster, as a dead one (every running row `interrupted`), and refuses the thread's commands until a
Stop, which would cancel the very job that lives on. The turn itself stays `failed`, and the
`runtime.error` the frame raised keeps the reason on the timeline.

**The child's end always precedes the answer's prompt.** Read from 1.18.32's source: a run
fiber's exit handler (the session runner's `onExit`) runs `onIdle` — which publishes the child's
`session.status {idle}` and `session.idle` — BEFORE it resolves the run's `done`; only then does
the child's `prompt` return, `TaskTool.runTask` end, the job complete, and
`notifyBackgroundResult` → `injectBackgroundResult` prompt the parent. So on the one ordered
event stream the child's `task.completed` is written while no turn runs (the launching turn has
ended, the woken one has not opened), and so is the result the answer carries — the woken turn
opens at the REPLY, never at the prompt. Were the order reversed, the child's end would ride the
woken turn, and a rewind of that turn would drop the agent's end while its start stayed on the
launching turn: the roster would read it running again. The adapter still takes an answer that
comes first (`pendingResult`) — defensively.

No capture holds a woken parent: the replay tests clone fixture 12's frames under new ids, and
assert that no capture opens a turn of its own.

### 28. A running `bash` part restates its whole output on every frame

Fixtures 03, 04 and 12: a command's `running` frames carry `state.metadata.output` — `""`
first, then everything printed so far — sometimes after a `running` frame with no metadata yet
(03 l.79, 04 l.76 and l.105, 12 l.157) and sometimes straight after `pending` (04 l.152-153); the
`completed` frame repeats the value in `metadata.output` and `output` (fixture 04, lines
110-114):

```jsonc
{"part":{"tool":"bash","callID":"tool_bash_ScHQ…","state":{"status":"running","metadata":{"output":""},…}}}
{"part":{"tool":"bash","callID":"tool_bash_ScHQ…","state":{"status":"running","metadata":{"output":"two\n"},…}}}
{"part":{"tool":"bash","callID":"tool_bash_ScHQ…","state":{"status":"completed","output":"two\n",
  "metadata":{"output":"two\n","exit":0,"truncated":false},"title":"echo two",…}}}
```

Identical frames repeat (fixture 04, lines 153-154). **Read from 1.18.32's source, not
captured:** `ShellTool.run` writes `metadata.output` once per chunk the process prints and
keeps at most 30 000 characters of it — past that the value is `"...\n\n"` and the last 30 000
(`Ze`), a window that slides instead of growing. The final `output` is built on its own, and is
not always the last running value: output past the tool's limits is cut by lines and bytes
behind `...output truncated...\n\nFull output saved to: <file>\n\n`; a command the tool stopped
gains `\n\n<shell_metadata>\n…\n</shell_metadata>` saying why (`shell tool terminated command
after exceeding timeout <n> ms. …`, `User aborted the command`); nothing printed reads
`(no output)`; the completion's `metadata.output` stays the last running value. A call still
running when its turn is aborted, and not done 250 ms later, is ended by the session instead:
`status: "error"`, `error: "Tool execution aborted"`, its metadata kept plus `interrupted: true`.

Nothing showed that output while the command ran: it rode the item row inside `data.state`,
which the wire slimmer drops. The normaliser now cuts each running frame of a command-like
part against the value it last saw for that part and emits what it adds as `content.delta
{command_output}` on the call's item, under the call's owner (a child's carry its `agentId`)
— the chunks ingestion joins onto the call's row (`advanceOutputMark`, `emitCommandOutput`):

| The new value | Emits |
|---|---|
| extends the last one (every captured frame) | the appended text |
| is a prefix of it, `""` included | nothing; the mark stays — a snapshot never rewinds output |
| a `"...\n\n"` window | what follows its longest overlap with the end of the last value |
| such a window keeping nothing of it (a burst longer than the window) | the whole window, its head marking the gap |
| anything else — no window head | nothing, the mark re-basing on it: without the head, an overlap proves nothing |

Never text already shown: output that repeats itself can overlap further than it really did,
and then a repeat is lost, not doubled.

The joined chunks are the call's output in the timeline, settled too, so the completion first
appends what its final `output` holds past them, before its own item event closes the call's
output buffer (`finalOutputRemainder`): the rest of a final output that extends the stream;
else what follows the LAST place it holds the stream's end — the stream's last 512 characters,
or all of a shorter one, and none under 64, which recur in any output by chance; else nothing,
and the stream stays short of the final output, which the completion row's data keeps whole.
A final output the tool cut opens with its own note —
`...output truncated...\n\nFull output saved to: <file>\n\n`, before the stream's end and so
never in what follows it — and that note's pointer, `\n\nFull output saved to: <file>`, closes
what the completion appends whichever way the rest went, after any `<shell_metadata>`: the
GUI's full-output viewer reads the join, and this is how it learns where the whole output was
saved. A final output that extends the stream was never cut, and needs none. A stream that
showed nothing adds nothing: its completion's own output is the row's. An errored part —
`Tool execution aborted` included — has no final output and adds nothing either: the stream is
the command's output, and the error is the call's status and detail, which the row's failed
status carries and the MCP transcript shows as text; it is never written into the stream. A
part's mark goes when it settles, when it is removed and when its message is.

A completion whose final output the tool cut — it opens with that note — holds only what the tool
kept, and that is the output's END: `es` in `ShellTool.run` walks the lines from the last one
(read from the source, not captured). The completion row keeps it in `data.result`, so the row is
marked `truncated` (`isCutFinalOutput`, the same note `finalOutputRemainder` reads): unmarked, the
MCP's `read_tool_output` answered that end as the whole output. Both readers now take the call's
join — every line the command printed — first, and show the kept end, as only part of the output,
only where no join answers (`storedCommandOutput`).

Only `bash` writes that note. Every other tool goes through the generic `Truncate.output` — read
from 1.18.32's source, not captured: `Tool.define` wraps each built-in tool whose result does not
set `metadata.truncated` itself (the shell does), and every MCP tool's result is cut by it too —
which keeps the HEAD (its default direction, the only one any tool asks for) and closes with its
own note: `\n\n...<n> lines|bytes truncated...\n\nThe tool call succeeded but the output was
truncated. Full output saved to: <file>\n` and one hint line — "Use Grep to search the full
content or Read with offset/limit to view specific sections." or, where the agent may delegate,
"Use the Task tool to have explore agent process this file with Grep and Read (with
offset/limit). Do NOT read the full file yourself - delegate to save context." A command-named
tool that is not the shell (an MCP server's `run_command`, say: the adapter reads any tool whose
name holds "bash" or "command" as a command) can therefore end its completion with that note, and
such a completion is marked `truncated` the same way (`isCutFinalOutput`). It streams nothing, so
no join answers: both readers show the kept head as only part of the output. Only at the very end:
the note anywhere else is output.

### 29. A Stop's abort ends what it reaches — and a request can still reach the thread after it

**Read from 1.18.32's source, not captured.** `POST /session/{id}/abort` (`SessionHttpApi.abort`)
is `SessionPrompt.cancel`, which is `SessionRunState.cancel`, and before it answers that:

1. cancels the session's background jobs (`cancelBackgroundJobs`): every job still `running`
   whose id, `metadata.sessionId` or `metadata.parentSessionId` names the session, then — adding
   each cancelled job's child session — the jobs those children launched, walking one snapshot of
   `BackgroundJob.list`. In 1.18.32 every `task` call runs as such a job, foreground or
   background, keyed by the child session's id with `{parentSessionId, sessionId}` in its
   metadata. Cancelling one closes the job's scope, which interrupts its run, whose `onInterrupt`
   cancels the child session the same way (`promptOps.cancel`);
2. interrupts the session's own run (its runner's `cancel`) and marks the session idle.

An asker it interrupts leaves nothing behind: `Permission.ask` and `Question.ask` await their
answer under `ensuring`, which deletes the request from the pending list, and nothing is
published — no `permission.replied`, no `question.rejected`. After the abort, `GET /permission`
and `GET /question` list no request of a run it ended, and a reply to one is a 404 (observation
12's `PermissionNotFoundError`). 1.18.5 kept such a request listed (observation 11).

What still reaches the thread after a Stop:

- **The frames of the asks it ended.** Each was published before the interrupt, and the stream
  and the abort's own HTTP answer race (fixture 06 shows the stream winning; nothing makes it
  win). Their asker is gone.
- **Asks of a run the abort never reached**, whose asker waits on them:
  - the parent's own, from a run started after it: a job that completed just before the Stop has
    its answer injected by a fiber of the `task` tool's own scope (`notifyBackgroundResult` →
    `injectBackgroundResult`, observation 27), and that prompt starts a new run when it lands
    after `cancel` found the runner idle;
  - a child whose run no job's interrupt cancels: a `task_id` resume of a child whose job still
    runs extends that job (`BackgroundJob.extend`), and the extension's run carries no
    `onInterrupt` — cancelling the job interrupts only the fiber awaiting the child's run, which
    `ensureRunning` forks into the runner's own scope, so the child runs on;
  - a job started after the snapshot step 1 walked.

  The adapter's own walk after the abort (`abortDescendants`: `GET …/children`, then an abort
  for each, bounded) reaches the children it lists in time, and no others.

The adapter used to mark every request that arrived while no turn ran after an interrupt resolved,
write nothing and answer nothing: a live asker waited for good, and so did the parent's next turn,
whose prompt joins the running run (`ensureRunning` awaits it). Now a request that arrives while
an interrupt is under way — a Stop from its first step, withdrawing the parked cards, which comes
before its abort; a failed admission's abort, which is `SessionRunState.cancel` too and now leaves
the lingering state a Stop does — or after one before any run has said `busy` (the windows in
which the parent's own output is dropped, `interruptionLingers`) is held (`holdsRequests`) and
judged once every interrupt is over (`judgeHeldRequest`), on the server's word:
`GET /permission` (or `/question`) and `GET /session/status`. Its asker is gone when the request
is no longer listed, or when the asker's session runs nothing — an older server's orphan, listed
and idle (fixture 06): no card, the request is rejected on the wire, which releases what an older
server kept listed, and its closing frame writes no row. Otherwise it is shown as any request is:
the card on the turn running then, if one does — a child's question on none — or, with full
access, a `once`. A read that fails decides nothing, and the card is shown: the user answers it,
and a reply to a gone request settles locally, whereas a reject would answer for them — and
1.18.32's `Permission.reply` rejects every other pending ask of that session with it. A request
answered elsewhere while it is judged leaves the hold with its closing frame, and writes no row.

---

## Reproducing

The capture harness is deliberately **not** in this repo — a fixture is produced by driving
the real CLI once and committing the result (spec §9, "there is no record mode"). It was a
plain Node script using `fetch` and a hand-rolled SSE reader, run against a throwaway repo
under `/tmp`. To re-capture after an OpenCode upgrade, re-drive the scenarios in the table
above, re-run the redaction, and update the version and date at the top of this file — a
capture whose origin is unknown cannot be judged when the protocol moves.
