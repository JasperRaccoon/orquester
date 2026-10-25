# OpenCode and shared adapters test audit

Audit scope: 21 assigned test files; 11,858 baseline test lines; **331 actual named declarations**, with parameterized declarations counted once. The root regex inventory also included two `scanValue` callback arguments named `value` at fixture-redaction.test.ts:186; they are not tests and are excluded. All assigned tests and relevant production owners were read before disposition.

The case table below records the exact baseline name and its specific credible failure/oracle. Shared six-bar evidence in each file section supplies the independent source, stable seam, independent oracle, refactor resistance, unique ownership and non-test caller/risk rationale. KEEP means that specific scenario survives after this review; it is not inferred from passing baseline output.

## Implemented changes

- CLI inventory parser coverage feeds independent raw stdout/status at the external child-process boundary; real stream parsing, sequential orchestration and retries remain. The actual CLI-launch owner survives in snapshot-budget.test.ts. Virtual retry time removes three real one-second waits. Removed temporary scripts/files, 13 MessageChannels and 52 repeated fixture child launches from this file.
- Private fork-planner cases consolidate into public fork cuts; the missing-boundary case moves to public refusal-before-POST. Removed planner and boundary-error exports after repository-wide caller searches.
- Healthy/noisy readiness adoption shares one actual child with authenticated-health verification.
- Removed a redundant sampled hash-pair matrix and private returned-array identity test; provider-interpreted isolation and no-tools wire integration survive.
- Three teardown scenarios consolidate into stronger existing tests with both approval and question cards. Preserved failed/interrupted states, exit kinds/recoverability, settle-before-abort and before-exit ordering.
- Eight valuable revival tests now treat generated activation ids as opaque, proving uniqueness/consistent correlation and real roster state. A disconnect test proves pending-stop blocking after deterministic loop drain and drops order arranged by awaiting stop. Pending-seed coverage retains unknown status/auth and classifier recognition while dropping a private wording suffix assertion.

Baseline disposition totals (declarations, including removed and surviving consolidation rows): **DELETE 2**, **REWRITE 13**, **OPTIMIZE 13**, **CONSOLIDATE 12**, **KEEP 291**. Nine baseline declarations disappear and one rewritten public refusal declaration replaces its private predecessor: net eight fewer declarations. Two rows marked DELETE have no unique contract; six removed rows marked CONSOLIDATE retain all assertions at their stated owners. Net test LOC: **−109** across the seven changed test files; production LOC is unchanged (two unused exports made private). No fixtures/snapshots/dependencies/configuration are orphaned by these changes.

## Validation and measured cost

Root baseline: pnpm test, default four-file concurrency within each package; Node 24 and TSX_DISABLE_CACHE=1. No assigned case failed in the captured baseline. The three CLI retry/failure cases took 1,565.49 ms, 1,564.43 ms and 1,328.10 ms; the sampled hash matrix took 146.67 ms. The redundant healthy peer startup took 553.70 ms. Remaining expensive contracts include Grok committed-fixture privacy scanning (1,554.55 ms, scanning every byte/decoded array/joined stream is the security contract), real keyed-server restart (1,372.74 ms) and keyed recycle/isolation (1,328.99 ms): actual process/env/shutdown ownership justifies those costs. These baseline numbers are observed case durations under the full loaded run, not isolated speedup claims. Final file-level measurements and regression controls follow. Root owns the whole-suite comparison; these measurements do not establish a whole-suite or CI speedup.

### Completed scheduled validation

Root reported that the affected targets passed the changed-file gate before this slot. This owner then ran three alternating baseline/final CLI pairs, followed sequentially by two mutation controls. No extra broad suite was run.

Exact measured command, from `apps/daemon`, in both the frozen baseline checkout and final checkout:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 --test-timeout=600000 src/agent-host/adapters/opencode/cli-inventory.test.ts
```

Environment: Node **v24.22.1**, Linux, four-file runner cap, no assertion/mock-timer preloads, TSX compilation cache disabled. Each invocation starts a new Node process; filesystem/OS caching was not reset. Baseline and final runs alternated to reduce time-order bias. All six runs passed **13/13**, with zero skips/cancellations.

| Round | Baseline wall seconds | Final wall seconds |
| --- | ---: | ---: |
| 1 | 5.882137 | 0.163962 |
| 2 | 6.333805 | 0.164228 |
| 3 | 4.927065 | 0.163918 |
| Median | **5.882137** | **0.163962** |
| Range | 4.927065–6.333805 | 0.163918–0.164228 |

Median saving: **5.718174 seconds (97.21%)** for this test file. Baseline variance is substantial; final invocations varied by 0.000310 seconds in this sample. Slowest individual case across these comparable runs: retry recovery **1,455.69 ms** before; model-catalogue parsing **6.22 ms** after. Removing fixture subprocess/file construction and replacing the three retry waits with virtual time explains the measured reduction. The observed baseline case timings earlier in this report came from a loaded whole-suite run and are not mixed into this paired calculation. No CI resource measurement was made.

Regression controls used the same runner with a 30-second per-test timeout and a name filter:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 --test-concurrency=4 --test-name-pattern='models --verbose yields' src/agent-host/adapters/opencode/cli-inventory.test.ts
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=30000 --test-concurrency=4 --test-name-pattern='stop waits for the pending disconnect' src/agent-host/adapters/opencode/session.test.ts
```

- Changing the production slug split from first slash to last slash failed the retained independent catalogue assertion: actual provider `openrouter/google`, expected `openrouter`. One intended assertion failed; no import/runtime failure.
- Changing awaited session-tools disconnect to fire-and-forget failed the rewritten pending-stop assertion: actual `stopped=true`, expected `false`. One intended assertion failed; no import/runtime failure.
- Both controls restored source in `finally`; SHA-256 values before/after matched exactly for both production files. Both logs were read and checked for the intended assertion diagnostics, rather than accepting any nonzero exit. The six passing runs and mutant logs were also checked programmatically for expected counts/diagnostics.

Execution drivers: `python /tmp/orquester-test-audit/opencode-cli-ab.py` and, from `apps/daemon`, `python /tmp/orquester-test-audit/opencode-mutations.py` inside an outer hash-verification wrapper. Raw per-run logs, JSON timing results and restoration evidence remain in the task's external audit-artifact directory. Scoped `git diff --check` passed after restoration. No new failures or order dependence were observed; final full-suite/typecheck/build and remote delivery evidence are owned by the root report.

## apps/daemon/src/agent-host/adapters/attachment-lines.test.ts

Independent contract source: §4.1/§4.5/§6.2 of docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md; attachment dispatch follow-up docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md; the retained historical ReDoS input documented beside the test.

Six-bar shared rationale and risk: Shared text/answer/history transformation functions, called by all four adapters and the orchestrator. Literal host-path/text examples and relative malformed-input timing are independent oracles. Provider integration tests prove wiring; they do not exhaust shared hostile-name, strip-recognition or split-dispatch contracts. Refactoring helpers or callers preserves these inputs/outputs; risk is attachment omission or forged user text.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| appends an `Attached files:` block as a suffix, one `- name: path` line per attachment | KEEP | Slash-command placement and complete path/name preservation: the literal two-file suffix catches a missing or prefixed attachment. |
| is the block alone when the text is empty, so an attachment-only turn still says something | KEEP | An attachment-only message must contain readable file evidence; empty text must not swallow its only attachment. |
| skips a path the text already names — the composer put it there (§7.4) — and returns the text by identity when nothing is left | KEEP | Already-typed paths must not duplicate; the mixed named/unnamed input catches filtering all attachments or adding all again. |
| collapses a run of control characters in a name to one space, so a name cannot forge a line of the turn | KEEP | Uploader-controlled C0/DEL line breaks must not forge prompt lines; literal flattened names are the oracle. |
| flattens C1 controls and Unicode line separators too, trims, caps a name at 255 and never leaves it empty | KEEP | C1/Unicode separators, bounded filenames, whole Unicode codepoints and empty-name fallback protect untrusted attachment labels. |
| names an answer's file on one line, with its path or as not available (§6.2) | KEEP | Question answers must preserve either the resolved file path or explicit unavailability; a missing file must not disappear. |
| reads `namedIn` for a path already named, and still appends to `text` (§4.6.8) | KEEP | A skill dispatch checks paths in the complete input while appending only to leading prose; catches duplicate dispatch attachments. |
| removes a literal persisted trailing attachment block | KEEP | Native transcript replay must remove the adapter's trailing suffix while preserving the user's original prose. |
| keeps a block that is the whole message: a replay has no attachment chips to show instead | KEEP | An attachment-only native transcript must remain visible when replay has no attachment chips. |
| returns text without a trailing block by identity, including a mid-text mention | KEEP | Ordinary prose and mid-message attachment mentions must survive stripping unchanged. |
| answers in linear time when a block-shaped run fails at its last line | KEEP | Credible historical exponential regex input must remain linear relative to equivalent ordinary input; also preserves names containing colon-space. The relative timing guard uniquely protects event-loop responsiveness. |
| recognises persisted attachment-only blocks | KEEP | The shared block recognizer must accept complete one/multiple-file persisted blocks, including colon-space names. |
| is false for anything around the block — leading blank lines, trailing prose — and for empty text | KEEP | The recognizer must reject prose, incomplete blocks and extra surrounding lines; protects user text from being misclassified as adapter scaffolding. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/attachment-lines.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/auth-status.test.ts

Independent contract source: Agent GUI spec §7.7 plus committed Claude/Codex/OpenCode probe response shapes, documented in each provider fixture README.

Six-bar shared rationale and risk: Real snapshot/probe outputs for raw provider evidence. Explicit unknown/authenticated/unauthenticated values are independently required by the account UI. Provider-specific replay suites prove populated capture handling; these cases uniquely distinguish absent, ambiguous and positive credentials without a real account. Helpers are production-called by their adapters; no test-only auth export is retained. Risk is false sign-out or missed auth failure.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| is `unknown` when the probe itself failed | KEEP | A failed Claude probe is ambiguous; it must not trigger a false signed-out verdict. |
| is `unknown` — never `unauthenticated` — when the init carried no account | KEEP | Claude initialization without account metadata also works with API-key/Bedrock credentials; unknown is the independent auth oracle. |
| keeps the api provider on the ambiguous verdict, for the card to label | KEEP | An ambiguous Bedrock verdict must retain the provider label used by the account card. |
| is `authenticated` only once the init POSITIVELY yields credentials | KEEP | Positive Claude email or plan evidence must report authenticated and retain its identity metadata. |
| is `unknown` when `account/read` could not be read at all | KEEP | Unavailable Codex account/read must report unknown instead of claiming the user signed out. |
| is `unauthenticated` ONLY when the CLI says an OpenAI login is required | KEEP | Only a positive requiresOpenaiAuth response with no account proves unauthenticated; explicit no-requirement remains unknown. |
| is `authenticated` for every account shape it recognises | KEEP | Both documented ChatGPT and API-key Codex account shapes are positive authentication evidence. |
| is `unknown` with nothing connected — there is no `opencode auth list` to ask | KEEP | An empty OpenCode connected-provider list proves no login verdict; the card must remain unknown. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/auth-status.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/fixture-redaction.test.ts

Independent contract source: Every provider fixtures/README.md redaction promise and AGENTS.md prohibition on committed credentials and identifying capture data.

Six-bar shared rationale and risk: The public artifact is committed fixture bytes, including decoded byte arrays and protocol-joined content. Independent allowlisted documented fakes and forbidden token/path shapes are the oracle; production redaction algorithms are not reused. The real join-vs-complete comparison catches inconsistent partial redaction. This source/artifact inspection guards private bytes and survives identifier renames. It does not replace provider behavior tests; production runtime redaction cannot protect already committed captures. No external helper caller exists: all scanner support is owned by these retained privacy checks.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| covers every fixture set | KEEP | Every committed fixture directory must have a protocol-aware scanner; adding a directory cannot silently bypass redaction checks. The oracle is actual directory inventory, not production exports. |
| `${set}: no line, decoded byte array or joined stream holds a host-identifying value` | KEEP | Committed bytes, decoded arrays and joined provider streams must contain no undocumented credentials/home/account identifiers. The README allowlist is independent and protocol joining catches fragmented leaks missed by line scanning. |
| claude: every streamed block joins to what its complete frame holds | KEEP | Claude streamed text/tool JSON must agree with complete frames after redaction; prevents inconsistent partial redaction from leaking or changing replay behavior. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/fixture-redaction.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/mcp-app-capture.test.ts

Independent contract source: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §3 and Appendix A; app document/size/reference contracts in packages/api/src/agent-chat/mcp-app.ts; append-only host-log ordering in AGENTS.md.

Six-bar shared rationale and risk: Shared capture/hold/cache APIs used by Claude and Codex adapters. Independent deferred reads, literal output order, attachment identities and clock values establish oracles; stubs supply resource/store boundaries, never the queueing/dedup behavior being asserted. Provider integration owns event wiring while these lowest shared seams own nested capture/error/teardown/cache semantics. Refactors preserve document/ref/order outcomes without private collaborator counts. Risk is timeline disorder, stale resources, post-close writes or duplicate multi-megabyte storage.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| frames wait behind a capture and replay in arrival order after its completion | KEEP | A pending resource capture must keep later frames behind its completion in arrival order; otherwise durable event order changes. |
| a replayed frame that starts a capture keeps the rest waiting, still ahead of later frames | KEEP | A second capture started while replaying must keep the remaining queue before subsequently arriving frames. |
| a failed capture completes without a value; close lets go at once and refuses new holds | KEEP | Read failure and teardown must release every held frame once, abort the read and ignore a late resource result. |
| a server request waits too, and answers once replayed | KEEP | A provider request requiring a reply must remain pending during capture and return its result when released. |
| a replay that throws is reported and never stops the others | KEEP | One throwing replay handler must report its error without losing subsequent frames. |
| stores the prepared document and answers the reference | KEEP | A valid app resource must become a stored prepared CSP document and a call-scoped attachment reference. |
| answers nothing for a read that fails or times out, a non-app or oversized document, a failed store, no store | KEEP | Failure, timeout, invalid/oversized resource and unavailable/invalid storage must return no app, preserving a plain tool row. Each distinct external failure is checked against undefined. |
| stores nothing once the session closed during the read | KEEP | A session closed during a resource read must not store the late result. |
| stores an unchanged document once per thread + server + URI, while the thread still has it | KEEP | Unchanged app bytes deduplicate only within thread/server/URI while the attachment remains live; changed documents, other owners and swept files must store afresh. |
| capture goes through it when given one | KEEP | The public capture path must actually use snapshot deduplication: two equivalent resource reads cause one store. |
| answers within its time-to-live, forgets after it or on clear, and stays bounded | KEEP | A bounded per-session cache must expire at its caller-supplied TTL, evict the oldest entry and clear invalidated data. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/mcp-app-capture.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/cli-inventory.test.ts

Independent contract source: Agent GUI spec §4.5 catalogue fallbacks; OpenCode fixture README records real 1.18.5 CLI stdout and the observed truncation/SQLite-lock behavior.

Six-bar shared rationale and risk: loadInventoryFromCli remains the real production seam. ChildProcess spawn is the external CLI boundary: independent raw stdout/exit statuses pass through real stream collection, parsing, sequential orchestration and retry policy. Literal model/agent/skill results can disagree with parser code. Snapshot-budget cwd-less refresh retains actual real-child CLI launch; support/spawn tests own supervision. This avoids test-only parser exports and preserves refactor resistance at the callable inventory API. Risk is catalogue loss, wrong identities or overlapping SQLite clients; peak fake child lifetime detects concurrency, while outputs do not simulate parsing.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| models --verbose yields providers, models and the connected list | OPTIMIZE | The CLI model catalogue must preserve first-slash provider/model splitting, model names, reasoning variants and connected providers. |
| a body line that looks like a slug does not flush the model | OPTIMIZE | A slash-bearing JSON string inside a model body must not be misread as another slug header and lose the model. |
| an unparseable body drops that one model, never the catalogue | OPTIMIZE | A malformed model body costs one model, while valid models before and after it survive. |
| empty output is an empty catalogue, not a throw | OPTIMIZE | A successful empty models response is an empty catalogue, not an exception. |
| agent list yields name, mode and the hidden flag the CLI omits | OPTIMIZE | CLI agent headers must preserve mode/name and hide known internal title agents omitted by the CLI's flags. |
| agent list tolerates an empty body and trailing whitespace | OPTIMIZE | A header-only agent and an empty agent response are accepted without fabricated rows. |
| debug skill yields name/description/location and drops the huge body | OPTIMIZE | Skill identity/location survives while huge content and nameless objects are omitted from the snapshot contract. |
| a TRUNCATED skill array still yields every skill that arrived whole | OPTIMIZE | A genuinely truncated JSON array must retain complete skill objects and drop only the severed object. |
| malformed skill output degrades to an empty list | OPTIMIZE | Malformed, wrong-shape and empty skill stdout must degrade to an empty optional list. |
| the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file | OPTIMIZE | CLI probes must not overlap because the external CLI shares SQLite; the transport records peak in-flight child lifetimes, not parser internals. |
| a non-zero exit is retried once and recovers the catalogue sequentially | OPTIMIZE | A transient models exit retries once, succeeds and remains sequential; the parser still computes the returned catalogue from raw CLI bytes. |
| agents and skills may each degrade to an empty list | OPTIMIZE | Failed optional agents and skills probes must not discard successful model evidence. |
| a models failure rejects — that one IS the catalogue | OPTIMIZE | A permanently failed models probe must reject specifically for its exit status after one retry, not pass on an unrelated error. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/cli-inventory.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/fork-session-tools.test.ts

Independent contract source: Session tools design §1.2/§6 and unified MCP §12.1; native fork copies provider permission settings, documented by OpenCode capture observations.

Six-bar shared rationale and risk: Public AgentAdapter fork/start over a real pool child forwarding real HTTP to a small provider store. Independent grants and rule decisions prove parent/child isolation; fake copied permissions only reproduce the external provider dependency, not the isolation asserted. Helper rules cannot detect adapter wiring, and ordinary session startup cannot detect inherited parent permissions. No mutable fixture is shared between tests. Real peer cleanup/exit ownership remains. Risk is a fork using its parent bearer or exposing a denied server after grant failure.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| a fork's child registers its own server under its own grant, and its ruleset allows only that server | KEEP | A fork's child must receive its own grant/server registration and replace inherited permissions without changing the parent's access; real peer startup uniquely verifies adapter/pool/fork wiring. |
| the thread's denied MCP servers are disconnected and ruled out — also without a grant (§12.1) | KEEP | Manifest-denied MCP servers must be disconnected and denied even if issuing the caller's own grant failed; a real peer tests registration failure wiring that helper rules cannot. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/fork-session-tools.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/fork.test.ts

Independent contract source: Agent GUI rollback API; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6; OpenCode fixture README observations 10 and17 for exclusive cut and re-minted ids.

Six-bar shared rationale and risk: forkOpenCodeSession reads the provider wire and returns native identity. Explicit source exchanges and copied counts independently establish the opening user prompt and exclusive boundary. Session rollback has separate orchestration but does not own forkConversation cleanup; those public helper cases remain. Private planner shape tests are consolidated or moved to the public fork refusal seam; their helper/error exports have no non-test external caller and are removed. Refactors may alter planning representation or read counts while preserving wire cut/refusal/source safety. Risk is lost retained history or orphan upstream sessions.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| cuts before the prompt that opens the first removed turn | CONSOLIDATE | Private planner output duplicates the verified fork wire boundary below, including live-prompt and historical-assistant cuts; remove direct private structure ownership. |
| keeps everything when nothing is removed | CONSOLIDATE | The whole-session public fork already checks omission of messageID; a private expectedCount assertion adds no independent protection. |
| refuses an id the session does not hold | REWRITE | The real contract is refusal before any fork POST for a missing boundary; move that assertion to forkOpenCodeSession and remove the private export. |
| forks with the cut's messageID and the thread's directory, then checks the count | CONSOLIDATE | The public fork must send the first removed turn's opening prompt and target directory, then accept only the expected kept history. Source mutation remains forbidden; private GET counts are removed. |
| refuses a fork that did not keep exactly the cut, and deletes the session it made | REWRITE | A fork preserving the wrong boundary must fail and delete only its newly created session, leaving source history intact. Preserve delete-target assertions while removing unrelated exact GET/POST inventory so additional verification reads are harmless. |
| deletes the fork it cannot read back, and still refuses with the read's failure | KEEP | An unreadable newly created fork must be cleaned up and retain the original read failure even if deletion also fails. |
| forks the whole session without a messageID | CONSOLIDATE | A whole-session fork must omit messageID and preserve the complete source history; this owns the deleted planner length case. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/fork.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/history.test.ts

Independent contract source: Agent GUI §4.1 resume/history, §§5.4/5.5 rewind identities; fixture README native GET/message bodies and observations on synthetic background prompts; host continuation protocol.

Six-bar shared rationale and risk: Captured native bodies enter through actual OpenCodeThreadSession.readThread and public history projection. Explicit message text/status/types and historical provenance are independent fixture-derived oracles. Live normalization cannot cover native persisted grouping/filtering; generic fold tests do not know provider message shapes. The projector is production-called by index.ts, and readThread by daemon history/rewind. Refactors preserve displayed history and attribution rather than private call shape. The small injected transport retains readThread-to-projector integration, including unanswered prompts and hidden host/system scaffolding.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| fixture 10: the captured history replays as turn markers around completed items | KEEP | Captured native history must preserve answered and unanswered user prompts, assistant text and turn ordering with completed items. |
| fixture 10: every replayed turn reports usage as unavailable, never a guess | KEEP | Historical turns must be completed with unavailable usage, never fabricated live accounting from ambiguous step records. |
| fixture 10: every projected event is stamped historical and carries the turn id | KEEP | Every projected row must carry historical provenance and correct thread/turn identity, keeping resumed history out of live attention and pushes. |
| fixture 10: an empty fork projects to no events at all | KEEP | A genuinely empty native fork must project no phantom turns or messages. |
| fixture 10: a replayed prompt loses the `Attached files:` block the adapter appended | KEEP | Replay strips only adapter-added trailing user suffixes, preserving assistant-authored text and attachment-only evidence. |
| fixture 10: a synthetic user text part replays as nothing, never as the user's words | KEEP | Synthetic provider-written user parts must never impersonate the user, while mixed real user parts survive and replay adds no live roster work. |
| fixture 3: a completed tool call replays under its lifecycle type with its callID | KEEP | A captured completed command must retain output, stable tool call identity and one prompt despite multiple assistant replies. |
| fixture 6: reasoning replays as its own item and an aborted tool call is failed | KEEP | Reasoning must remain separate, an aborted command failed, and history must reopen neither approvals nor streaming buffers. |
| fixture 10: the per-turn system addendum — session-tool instructions included — never replays | KEEP | Per-turn runtime/session-tool system instructions must never leak into a resumed transcript message. |
| fixture 10: the host's own prompt after a restart replays as nothing, never as the user's words | KEEP | The host's crash-continuation prompt must not replay as the user's own words. |
| fixture 10: a prompt no reply names — the user sent another first — still replays as theirs | KEEP | A prompt with no assistant parent reference must still remain visible in history rather than disappear behind a later prompt. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/history.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/normalize.replay.test.ts

Independent contract source: Agent GUI §§4.2/4.5/7.6; workflows design §5.4 typed auth/usage-limit failures; OpenCode fixture README observations18–29, backed by captured frames and explicitly labeled newer-provider source observations.

Six-bar shared rationale and risk: normalizeOpenCodeEvent maps raw provider wire frames to shared RuntimeEvents; selected cross-layer regressions also use real ingestion/fold/joinToolOutput. Oracles are captured literal text/tokens/ids and explicit external lifecycle outcomes, not calculations copied from owner branches. Session tests own HTTP timing/abort/probe coordination, while this cheapest seam uniquely owns per-frame decoding, child result ownership, windowed output and usage isolation. Generic API/ingestion tests do not know OpenCode envelopes. All normalizer/state seams retained have session production callers. Synthetic activation strings are rewritten to opaque identity/uniqueness/consistent-propagation oracles so a harmless ID algorithm refactor survives. Risk is lost/duplicate text, crossed agents, orphan runs or misleading usage.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| no capture produces a runtime.warning for a known-ignored frame | KEEP | Every observed fixture frame must have a defined supported disposition without unknown-frame warnings; this protects compatibility across the committed real captures rather than an export inventory. |
| an unrecognised frame takes the fallback rather than a catch-all drop | KEEP | A new unknown protocol event must surface runtime.warning rather than vanish; the event name identifies the otherwise lost data. |
| a re-stated title is mirrored once, not on every session.updated | KEEP | Session title changes must mirror once, suppress duplicates, and propagate an actual later rename. |
| server.heartbeat is known and silent | KEEP | Observed undocumented server heartbeats must produce neither timeline events nor lifecycle signals; reconnect maintenance cannot spam or settle a turn. |
| 02: text arrives as deltas and the closing snapshot emits nothing extra | KEEP | Captured text deltas must render hello world once; the terminal full snapshot cannot duplicate streamed text. |
| 03: a permission ask opens a card whose workspace option names the widened pattern | KEEP | A captured approval must preserve command identity, all decisions and the exact pattern/scope of a directory-wide grant. |
| 03: the bash tool part runs its whole pending -> running -> completed lifecycle | KEEP | The captured bash call must progress from started to completed with real output and stable tool call identity. |
| 04: reject maps to decline and always maps to acceptForSession | KEEP | External permission replies reject/always must become decline/acceptForSession, preserving another client's actual decision. |
| 05: a question opens with normalised ids and resolves with the chosen label | KEEP | A captured question must retain its stable answer identity and options, then resolve to its selected answer. |
| 05: a rejected question resolves with no answers | KEEP | A rejected question must resolve with empty answers rather than retain an old selection. |
| 07: todos become a plan, and `field:"text"` deltas on a reasoning part stream as reasoning | KEEP | Captured todo progress must become a plan, and text-field deltas on reasoning must stay reasoning rather than ordinary assistant text. |
| 08: an `agent: "plan"` turn emits no proposal event of any kind | KEEP | Provider plan mode has no proposal protocol; its normal text must stream without fabricating a proposal event. |
| 09: session.compacted becomes thread.state.changed {compacted} | KEEP | Compaction must mark thread state without fabricated before/after token counts unavailable in this protocol. |
| 11: command.executed becomes a completed activity row | KEEP | A native slash-command completion must become one activity preserving its actual arguments. |
| 12: a co-tenant session's frames are dropped, not mixed into this thread | KEEP | Concurrent co-tenant frames must never appear in the other thread's emitted raw events; positive events on both sides prevent an empty-replay false positive. |
| 12: a child session is a roster task: one start, one end, then the run's result | KEEP | A native child must start once, settle on its own idle and receive its late result on the same call identity. |
| 12: every task row repeats the whole linkage, and never stamps agentKind | KEEP | Every task lifecycle row must independently preserve subagent linkage while leaving host-owned agentKind unstamped. |
| 12: the parent's `task` tool part supplies the role, the model and the tool call | KEEP | The launching task must enrich child roster metadata with its role, model and original call identity. |
| 12: the child's own tool work reaches the roster as progress | KEEP | A child's own completed tool work must become progress on that child's roster. |
| 12: the child's own steps are its roster usage, and never the parent's meter | KEEP | A child's usage must be its own roster usage without being attributed to the parent's meter. |
| 12: a child's items and text are stamped with agentId; the parent's are not | KEEP | Child items and assistant text must carry their agent owner while parent items remain parent-owned. |
| 12: the parent's own `task` row still renders as a collab-agent call | KEEP | The parent's task call must remain a collab-agent activity rather than disappear when its child is shown. |
| 12: a child's step-finish tokens never reach the parent turn's usage summary | KEEP | A parent turn's total usage must exclude child step tokens and report unavailable main-agent usage when only children spent tokens. |
| a `task_id` resume of a settled child launches it again, and its own idle settles it | KEEP | Resuming a settled task_id must reopen one run under the new call and settle from the child's own idle, with its later result attached once. |
| after a relaunch, a stale part of the previous call is neither a run nor its end | KEEP | An old call's delayed frames must neither reopen nor end a newer live run. |
| a second call on a LIVE child is not a relaunch, and its end does not settle it | KEEP | A second call handed to an already-live child must not become another activation or settle its current run. |
| once a relaunched run settled, a late frame of ANY earlier call is stale | KEEP | After resumed work ends, late frames of any prior or handed-over call must not reopen it. |
| a child's title change is a progress row; a re-stated title is not (observation 19) | KEEP | A child's real rename must produce one roster progress update, while an identical repeated title produces none. |
| a task part answered in the background does not settle the child it launched | KEEP | An immediately answered background task tool call must not mark its still-running child complete. |
| a run gets its result once: the same part again adds nothing | KEEP | Repeating an already consumed completion frame must not duplicate the child's result. |
| a resumed run's result is its own; a late part of the first call adds nothing | KEEP | A resumed child's result must replace its previous run's answer; a late first-call completion cannot overwrite it in the real host fold. |
| a part that errors after the child's idle gives the run its error, ending nothing | KEEP | A parent tool error arriving after a child's own completion is result text for that run, without changing its completed status. |
| a result is the text inside the task tool's envelope; other output stands as it is | KEEP | Task-result envelopes must expose only the enclosed answer while plain/malformed output remains literal; embedded delimiter text must survive. |
| a part that settles BEFORE the child's idle ends the run itself, with its result | KEEP | A task part completing before the child's idle must end the run once with its answer; later idle adds no second end. |
| no result after a run the child's own session.error ended | KEEP | A provider session.error must fail its child once and suppress the later task-result completion. |
| a child an abort cancels ends stopped, never failed, when its own abort error or its call's cleanup beats the adapter's close — a grandchild too | KEEP | Provider abort error or interrupted task cleanup must close children/grandchildren stopped, while an ordinary task failure remains failed; the real roster distinguishes interruption from failure. |
| no result after a run the host stopped | KEEP | A host-stopped child cannot acquire a result from subsequent idle/completion leftovers. |
| a background run's answer, injected into the parent, becomes its result, once | KEEP | A synthetic background result injected into the parent must become exactly one child result, never a user or assistant message. |
| a child relaunched on the server's word still takes its own call's answer: the parent's part ends the reopened run, naming its new launch | REWRITE | A server-confirmed revival must receive its own task call's eventual answer on the reopened activation. |
| after an adapter relaunch, a provider relaunch names its own new call | KEEP | A later provider task_id launch must use that provider call identity after an adapter-created revival has ended. |
| a child whose own frames beat its launching part names the provider's call on every row once the part is read, and a relaunch still reopens it | REWRITE | Child frames arriving before their launching part must later use the real provider call identity and still reopen correctly after a confirmed revival. |
| a child no part ever named, resumed by a `task_id` call once settled, is relaunched: a start naming the call, running, then completed with its answer | REWRITE | A previously unnamed but settled child resumed by task_id must reopen with a new provider launch and produce its own answer in the real host roster. |
| a `task_id` call on a child no part named is no launch of its run: while it works, and never adopted as its call | KEEP | A task_id extension of an unnamed live child must not retroactively claim its activation identity or add a launch. |
| a background answer that arrives before the child's idle rides the run's own end | KEEP | A background answer received before child idle must stay pending until the child's own terminal row carries it. |
| an injected envelope naming no child of this thread, or not synthetic, is no result | KEEP | Unrelated-child envelopes and user-authored unsynthetic text must not become a result for another child's run. |
| a previous background run's late answer never becomes a relaunched run's result | KEEP | A prior background answer cannot contaminate a foreground resumed run's result. |
| a background run takes no answer written for another run's task | KEEP | A background resumed task with a new description must reject the prior task's injected answer and retain its own later answer. |
| a reply to a prompt the host already claimed opens no new turn | KEEP | A delayed reply to an already claimed host prompt cannot create a phantom extra turn. |
| a reply with no `busy` since the parent's last idle — no run behind it — opens no turn | KEEP | A reply without fresh busy evidence cannot create an unfinishable woken turn; fresh busy permits it and a subsequent idle invalidates stale evidence. |
| running bash parts yield chunks whose concatenation is the final output | KEEP | Growing command metadata must emit only new output chunks once, preserve call/turn ownership and store the final complete result. |
| a resumed subagent's growing bash output streams under it, every chunk once | KEEP | A resumed child's command output must stream exactly once under that child and its current parent turn. |
| a tool that is not a command streams nothing from its metadata | KEEP | A non-command tool's metadata output must not masquerade as command stdout. |
| a tail window re-bases on what it keeps, and never repeats a character | KEEP | Sliding provider tail windows must emit each printed character once across the real 30000-character boundary. |
| a window that keeps nothing already shown is shown whole, its head marking the gap | KEEP | A disjoint tail window must retain the provider's gap marker rather than pretend earlier unseen output was delivered. |
| a value that rewinds adds nothing, and the output goes on from the most shown | KEEP | Rewound/truncated metadata cannot repeat output already shown; subsequent growth resumes at the furthest observed text. |
| a value of no known shape shares nothing provable: it re-bases and adds nothing | KEEP | A redrawn non-prefix output must rebase safely and only stream subsequently proven new text. |
| a repeating output that slides into itself loses the repeat, never shows it twice | KEEP | Highly repetitive sliding output must not duplicate overlapping content when its boundaries cannot distinguish repeated characters. |
| a timeout's note reaches the stream, before the completion closes it | KEEP | A timeout annotation present only in final output must be streamed before the completion closes the call. |
| a windowed output killed at the timeout: its note reaches the joined output | KEEP | A windowed timed-out command must preserve its real output, timeout annotation and saved-file pointer through ingestion and joined output reads. |
| a cut final output closes the stream with where the whole output was saved | KEEP | A truncated final command must expose the saved full-output location even without a recognizable overlap; an uncut output adds no pointer. |
| a completion whose final output the tool cut is stored marked cut; any other is not | KEEP | Only genuinely cut command completions must be marked truncated; missing stream history, quoted notes and non-command output must not mislabel storage. |
| a command's completion the generic truncation cut — the head kept, its note at the end — is stored marked cut too | KEEP | Generic head-preserving truncation of command-named MCP output must also be marked cut, without misreading a quoted note or non-command result. |
| a final output that neither extends the stream nor holds its end adds nothing | KEEP | A final value without a trustworthy stream overlap must not append ambiguous/duplicate output, for both short and long streams. |
| a command that printed nothing, or failed, adds nothing at its end | KEEP | A silent command cannot append a synthetic no-output marker to its stream, and an errored command cannot invent final stdout. |
| 13: three session.error frames for one bad model collapse to one runtime.error | KEEP | Repeated provider error frames for one failed model must collapse to one diagnostic without Bun stack traces or class prefixes. |
| an account failure on session.error carries a structured reason (workflows §5.4) | KEEP | Typed provider auth/429 failures must expose structured auth/usage-limit reasons and documented retry reset times; ambiguous error prose must not become a false structured verdict. |
| 03: every owned step-finish reports the window it carried | KEEP | A context meter uses the current step's actual window usage and catalogue denominator while total processed accumulates across steps. |
| 03: a model the catalogue never described degrades to a bare count | KEEP | A model absent from the catalogue must retain its observed token count without guessing a maximum context size. |
| 01: the committed /provider capture yields the meter's denominators | KEEP | The captured provider catalogue must supply the exact known model denominator and no denominator for an unknown model. |
| 12: a child session's step-finish tokens never reach the parent's meter | KEEP | A child's step-finish must not change the parent's context meter, even on a shared server. |
| 12: the child's start carries the prompt its launching `task` part gave it; no other task row does | KEEP | Only a child's start may carry its launching prompt; later task rows must not repeat expensive/private prompt context. |
| a `task_id` resume's start carries the resume's own prompt, never the first launch's | KEEP | A resumed task's start must carry the new prompt rather than the previous launch's instructions. |
| a grandchild's start carries the prompt its parent child's `task` part gave it | KEEP | A nested child's prompt must come from its own launching parent call, separately from its description. |
| a start no part named yet carries no prompt, and neither does a revive of a run that already had one | REWRITE | An unnamed child start and a revival without a new prompt must omit prompt data rather than fabricate/repeat the original instructions. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/normalize.replay.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/project-key.test.ts

Independent contract source: README Agent Profiles/OpenCode account limitation; shared per-project server architecture from agent GUI spec §3.2/§4.5.

Six-bar shared rationale and risk: Public AgentAdapter.startSession rejects a requested per-thread managed account home before creating any provider session. The expected refusal is independent of implementation and distinct from project-path normalization or profile keying. Other pool tests cannot prove this account-start gate. Production host launches call this API; no special test seam. Risk is silently running under another account.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| a non-system account home is REFUSED, never silently dropped | KEEP | A shared OpenCode project server cannot bind a per-thread account home; start must explicitly refuse rather than silently use another identity, with no session created. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/project-key.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts

Independent contract source: Credible capture-05 ordering documented in fixture README and this regression: question.asked precedes late closing snapshot.

Six-bar shared rationale and risk: Recorded provider frames, with one part-kind change, pass through the real normalizer, ingestion and thread fold. The closing fixture text is independent of all owner logic and asserts one complete bubble plus a separate answer. Normalizer-only delta checks cannot detect host ingestion duplicating text across prompt closure; generic ingestion tests do not own this provider ordering. No test-only production seam; all components have real host callers. Risk is visible duplicated commentary after an approval/question.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| fixture 05: commentary closed by the question ask folds to its text exactly once | KEEP | Captured pre-tool commentary closed by a question must fold to one nonstreaming bubble with its exact fixture text; a late closing snapshot must not append it a second time. The subsequent answer remains distinct. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/recycle.test.ts

Independent contract source: Agent profile design §4.8 recycling and §§6/6.5 keyed launch; README keep conversations across profile changes; host session ownership/append-only event rules.

Six-bar shared rationale and risk: Public AgentAdapter recycle/start/send/read/rollback/catalog calls over real pool children/HTTP and real host ingestion/liveness. Independent provider session identities, environment receipts, deferred reads and final folds establish outcomes. Pool tests cannot prove adapter binding restoration, silent recycle events or per-thread catalogue routing; session tests lack process/key integration. Actual process cost is retained because shutdown/restart/env isolation is its contract. Production host/config-change routes call these APIs. Risk is dropped conversations, falsely stopped threads, interrupted reads or profile leakage.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| an idle project's server is stopped now, with no session.exited, and the thread's next start gets a fresh server | KEEP | Recycling an idle project must stop its actual process without marking the thread stopped; subsequent resume and send retain upstream identity on a fresh server. |
| a busy server is deferred, recycled once when its turn ends, and not again on later idles | KEEP | A busy recycle must defer until turn completion, run once, and consume its mark so future idle turns stay alive. |
| a turn that reaches a recycled thread before its restart brings the session back itself | KEEP | A turn arriving before the host explicitly restarts a recycled thread must restore its existing provider session itself. |
| nothing running means nothing recycled; a user's session stop after a recycle forgets the thread | KEEP | An explicit user stop after recycling must forget the thread so a subsequent send cannot resurrect it. |
| history reads and rewind on a recycled idle thread bring its session back (the host calls them without ensureSession) | KEEP | History and rewind operations must restore recycled sessions even without the host ensureSession path. |
| a recycle never stops the server under a history read; it goes once the read ends | KEEP | A recycle cannot interrupt a live history read; its completion releases the server for deferred shutdown. |
| threads share a resolved project server, falling back to cwd for malformed legacy project keys | KEEP | Equivalent/resolved/legacy project keys must share one project server while preserving each thread's distinct directory. |
| a keyed thread's own catalog is its server's, never the global server's (Agent Profiles composer) | KEEP | A keyed thread's live command/skill catalogue must come from its own server and never Global. |
| a keyed thread runs on its own server of the project with its env, and a keyed recycle leaves the global server alone | KEEP | A keyed thread's env, stream and turn must remain on its profile server; recycling that key leaves Global alive and later resumes the same upstream identity. |
| a profile switch moves the thread to the new key's server on the same upstream session; a superseded version's server is left idle | KEEP | Switching profiles/versions must move the existing upstream conversation to the new keyed process and leave superseded processes independently recyclable. |
| a profile thread runs only on its prepared version's keyed server: a start or fork without that key is refused | KEEP | A profile launch or fork without its matching prepared version/key must refuse before any server starts; a validated matching profile must launch. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/recycle.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/ruleset.test.ts

Independent contract source: Agent GUI design §4.3 decision table, §4.4 permission table and §4.6 command catalog; OpenCode fixture README cross-session always-grant evidence.

Six-bar shared rationale and risk: Ruleset/decision/snapshot APIs feed actual transport calls. Literal independent table rows and named sensitive permissions are the oracle, not copied owner constants. Session integration only checks that rules are sent and selected route wiring; these lowest-seam cases uniquely enumerate public approval policies. Exact permission strings and reply bytes are protocol/security contracts. Production session/normalizer/index call these functions. Risk is overbroad grants, inaccessible tools or unsupported controls.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| §4.3: every decision maps to the reply the OpenCode column names | KEEP | The approval decision table maps every public decision to its documented once/always/reject wire value; mistakes would grant or deny the wrong scope. |
| §4.3: the card falls back to the default four when the ask names no patterns | KEEP | An ask without widened patterns must still provide all actionable decisions and disclose cross-session workspace scope. |
| §4.3: a permission maps to a canonical request type | KEEP | Read/edit/other permissions must become the correct canonical request type so the user sees the appropriate actionable card. |
| §4.4 full access: `*`→allow plus an explicit external_directory allow | KEEP | Full access must allow both wildcard operations and external-directory operations; OpenCode's special permission requires both wire rules. |
| §4.4 supervised: `*`→ask, reads allow except `.env` | KEEP | Supervised mode must permit ordinary reads while asking about edits and sensitive env files, allowing env examples. |
| §4.4 accept edits permits edits while shell and sensitive reads still ask | KEEP | Accept-edits mode must permit edits while retaining shell and sensitive-read approval. |
| §4.4 auto keeps supervised approval for edits, shell and sensitive reads | KEEP | Auto mode without a reviewer must fall back to supervised approval for edits, shell and secrets. |
| §4.4: the read-only and always-allowed tools are exactly the documented set | KEEP | Documented read-only/always-allowed permissions must stay usable while dangerous/network/external-directory operations still ask. |
| §4.6.3: a real command list keeps `/compact` first and drops skill-sourced rows | KEEP | The host compact command must not be shadowed by provider compact or duplicated skill commands, while argument hints survive. |
| R2-11: a not-installed snapshot advertises no `/effort` either | KEEP | An unavailable provider with no model descriptors must advertise only the host compact command and no unsupported effort control. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/ruleset.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/server.test.ts

Independent contract source: Agent GUI spec §3.1 supervision, §3.2 per-project ownership, §4.5 health/auth/version/startup; docs/superpowers/specs/2026-10-18-agent-profiles-design.md keyed server isolation.

Six-bar shared rationale and risk: Public OpenCodeServerPool/handles use real spawned peer processes, HTTP health/env reads, controlled timers and actual exit receipts. Expected pids/URLs/env/lifecycle differ independently from pool implementation. Adapter recycle/fork tests own session handover; the pool is the lowest owner for reference counting, coalescing, crash diagnostics and protected launch-env validation. One redundant healthy child is removed; its unique noisy-readiness/version assertions move to authenticated health. Production adapter index.ts calls the pool. Refactors preserve process ownership and observable lifecycle without private data inspection. Real processes remain necessary for kill/auth/env/start ordering.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| a healthy peer is adopted, and the URL comes off stdout | CONSOLIDATE | Healthy adoption, noisy stdout URL parsing, pid and version evidence are consolidated into the authenticated-health owner; this duplicate real process adds no distinct failure. |
| recycle (agent profile §4.8) stops only an unheld server, and the next start waits for the old child to be gone | KEEP | Recycle must refuse held servers, stop released servers before replacement and exclude the old child from warm reuse. |
| `/global/health` is reached WITH the credential, as the real server demands | CONSOLIDATE | The adopted server must parse readiness despite noise, prove its health with a nonempty Basic opencode credential and deny an unauthenticated request; this also owns the removed healthy-adoption checks. |
| a server below the minimum is REFUSED with the required version in the message | KEEP | A provider below the independently documented minimum version must be refused with a recognizable version diagnostic. |
| an unhealthy server is refused rather than adopted | KEEP | A false health response must not be adopted as a usable server. |
| a peer that dies before printing a ready line fails with its stderr excerpt | KEEP | A child dying before readiness must fail acquisition with its exit status and stderr diagnostic rather than hang. |
| a bad binary fails the acquire instead of hanging | KEEP | A missing executable must produce a spawn failure rather than an indefinitely starting provider. |
| a host abort cancels acquisition of a silent peer | KEEP | Host shutdown must cancel a live silent child's readiness wait; the stderr receipt proves the child was actually waiting. |
| threads of one project share one server, ref-counted, closed after the last release | KEEP | One project's references share a process; releasing one cannot stop another's server, and the documented idle window closes only the final released server. |
| a re-acquire inside the idle window cancels the close | KEEP | Reacquiring within the idle window must cancel shutdown and preserve a usable server, not hand out a dying pid. |
| two projects get two servers | KEEP | Different project identities must not share provider processes or URLs. |
| concurrent acquires for one project collapse onto a single start | KEEP | Concurrent acquisition of one project must collapse to one startup instead of racing duplicate servers. |
| a dead server is not reported as live by pool.list() | KEEP | A crashed child must immediately disappear from public pool diagnostics even before another acquire. |
| a second stopAll waits for the first's kills: the host's two teardown calls both return only once the servers are gone | KEEP | Every concurrent stopAll caller must wait for the actual child teardown, preventing host exit while servers remain. |
| two keys of one project are two servers, one key is shared, and a key's env reaches only its own server | KEEP | Profile keys within one project must isolate servers and launcher/profile env overrides while equal keys share references. |
| recycle and the idle close act per (project, key): the project's other server is untouched | KEEP | Recycle and idle shutdown for one profile key must leave another held key running; its replacement retains that profile's env. |
| a keyed server whose child crashed is restarted on the next acquire of that key only | KEEP | A crashed profile process must restart only that key, retaining its env while Global remains alive. |
| a spec the pool cannot apply as written is refused, and leaves no server behind | KEEP | Reserved/empty keys and overrides of launch-critical env must fail without leaving a server, preserving host authentication and ownership. |
| a key reused with a different env keeps the running server and warns | KEEP | A reused key with conflicting env cannot silently mutate a running server: keep the bound env and report the conflict. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/server.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/session-tools.test.ts

Independent contract source: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §1.2; docs/orquester-mcp.md external server naming; unified MCP spec §12.1 denials; provider 1.18.34 matching/subagent inheritance evidence recorded in file.

Six-bar shared rationale and risk: Permission output is interpreted using an independent transcription of OpenCode wildcard/last-rule/inheritance semantics, not the Orquester helper implementation. Offered tool identities and public API server-name grammar establish security outcomes. Integration verifies wire registration/fork permissions; lowest helper owner verifies semantics across modes/denials/external namespaces. Large sampled hash pairs add no unique behavior and no-tools returned-array identity is private; both are deleted. Non-test callers remain session.ts/index.ts and shared API parsers. Risk is cross-thread credential exposure; decisive security semantics remain.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| the server name is fixed-width, stable and the thread's own | KEEP | The session-tool name is a stable per-thread identity matching the shared API parser's fixed-width protocol spelling; a changed/random key would prevent precise isolation or reconnect. |
| `thread A is offered its own tools and never thread B's (${mode})` | KEEP | With either approval policy, provider wildcard precedence must offer only the caller's own tools, hide another thread's tools and deny session tools to native subagents. |
| every tool of a denied server is dropped, its own tools kept (§12.1) | KEEP | Explicit MCP denials must hide all tools of each sanitized server and override earlier allows while keeping unrelated tools. |
| a thread whose own grant failed is still kept off every co-tenant's tools | KEEP | A failed own grant must still deny every co-tenant's tools; full access cannot become a cross-thread credential escape. |
| the external /mcp under the name docs/orquester-mcp.md suggests keeps every tool | KEEP | The documented external MCP name must retain all external tools despite per-thread isolation; the documented conflicting spelling demonstrates the boundary. |
| no thread's allow can reach another's server, whatever their hashes share | DELETE | The large random hash-pair matrix repeats the already-proved fixed-width pattern and two-thread isolation; it adds no independently specified behavior or unique failure, and couples to hash sampling. |
| without session tools, the ruleset and the system addendum are untouched | DELETE | Reference identity of a returned rules array is private implementation structure; unchanged wire rules and system text are already asserted by session.test.ts without-session-tools integration. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/session-tools.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/session.test.ts

Independent contract source: Agent GUI §§3.1/4.1/4.5/6.2, structured runtime contracts in packages/api, session tools design §1 and denials §12.1; OpenCode fixture README premature-idle, abort/orphan/fork/background observations.

Six-bar shared rationale and risk: OpenCodeThreadSession public start/send/respond/interrupt/stop/compact/read/rollback API over real HTTP-client serialization and manually controlled SSE frames/HTTP receipts. Literal responses, distinct turn/call identities, independent promise gates and real ingestion/fold/liveness establish external state/order oracles. Raw normalization lacks async admission/probe/interrupt races; process-pool tests lack turn/request semantics. Three duplicate teardown executions consolidate all their assertions into stronger both-card owners. Revival tests retain only identity uniqueness/propagation, and held disconnect now proves blocking after event-loop drain instead of asserting ordering arranged by the test. Real production adapter calls every retained API; existing retry-delay injection remains used for deterministic synchronization, no new seam. Risk is data loss, stuck drains, misattributed requests or unsafe abort/denial ordering.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| a fresh session is created WITH the ruleset in the create body | KEEP | Session creation must send supervised permissions on the provider wire and publish the actual lifecycle events. |
| resume in the same directory reuses the session and RE-ASSERTS the ruleset | KEEP | Same-directory resume must reuse upstream identity and reassert permissions instead of starting an empty conversation. |
| resume against a confirmed 404 falls through to a fresh session | KEEP | Only a confirmed missing-session 404 permits a fresh upstream session. |
| resume against a 500 PROPAGATES — a blip must never reset a live thread | KEEP | A server 500 must propagate without silently discarding live history by creating a replacement session. |
| a cursor carrying unknown extra fields still resumes | KEEP | Unknown future cursor fields must not prevent compatible resume of persisted conversation identity. |
| a cursor of the wrong shape means `no resume`, never an error | KEEP | An unsupported cursor schema must safely create a fresh session instead of treating invalid data as a valid resume. |
| a cwd change forks rather than minting an empty session | KEEP | Moving directories must native-fork the saved conversation and reapply permissions rather than lose its history. |
| a turn submits prompt_async with a minted id, the system addendum and the variant | REWRITE | Prompt submission must send the provider's accepted minted message id, model/variant/agent/system fields and preserve user text, without unsupported reasoning fields. Runtime instructions must exist separately from the user text; their cosmetic heading is not contractual and is no longer pinned. |
| an xlsx rides as a path line in the text part; a csv is still a native file part (§4.5) | KEEP | Mixed non-native spreadsheet and native CSV attachments must reach the provider via path suffix and native file part respectively. |
| an attachment-only turn with a non-native file no longer throws: the block is the text | KEEP | An attachment-only non-native turn must still submit its path as its only text part. |
| a text file over the native cap rides as a path line, not a file part (§4.5) | KEEP | An oversized text attachment must fall back to a readable path instead of exceeding native upload limits. |
| an attachment whose path cannot be resolved fails the turn instead of vanishing | KEEP | An unresolved attachment must fail before opening a turn or submitting any prompt; silently losing the file is forbidden. |
| plan mode rides the `agent` field, per turn | KEEP | A plan interaction must select OpenCode's plan agent on the submitted turn. |
| a turn completes on idle, with accumulated usage and cost | KEEP | A real turn must complete on idle with its own text, step usage, cached token accounting and cost. |
| the premature-idle race still completes the turn (machine 3) | KEEP | The observed premature-idle-before-assistant race must still settle the admitted turn rather than hang forever. |
| a second sendTurn during a live turn STEERS: same turn id, one turn.started | KEEP | A second user send during a live run is steering: retain the same turn identity while submitting both messages. |
| a refused submit settles the turn as failed rather than leaving it running | KEEP | A refused prompt submission must fail and settle its turn rather than leave a running session. |
| a name in `command.list` is dispatched through session.command | KEEP | A known native slash command must use the command endpoint with its string-model wire shape and no unsupported system addendum. |
| a name that is NOT in `command.list` falls through to an ordinary prompt | KEEP | An unknown slash command must remain literal user text on prompt_async rather than fail or dispatch a nonexistent command. |
| a native command with a non-native file carries the path block in its arguments (§4.5) | KEEP | Native command attachment fallback must append the path block to arguments while omitting unsupported native file parts. |
| an approval reply reaches `POST /permission/{id}/reply`, never the SDK trap route | KEEP | Approval responses must reach the documented working permission route with the intended workspace grant and resolution. |
| a redirecting decline rejects WITH the redirect message; a plain decline rejects bare | KEEP | A redirecting denial must carry feedback, while a plain denial sends only reject; neither may silently allow the action. |
| a child session's permission names its subagent, and a decline with the user's words rejects with them | KEEP | Child approvals must identify their requester and preserve trimmed user feedback; parent approvals must not claim child ownership. |
| interrupt SETTLES every open request before the abort reaches the provider | CONSOLIDATE | Settle-before-abort is consolidated into the stronger interrupt-with-both-parked-card owner; its wire ordering assertion is retained there. |
| interrupt is turn-scoped: a Stop on a settled turn cannot kill the next one | KEEP | A stale turn-scoped Stop must not abort a newer active run. |
| a question is answered on its reply route and dismissed on its reject route | KEEP | Question selection and dismissal must use the distinct reply and reject routes with the selected answers. |
| compaction is REFUSED while a turn runs — the server has no such backstop | KEEP | The host must refuse compaction during active work before sending summarize, because OpenCode provides no server-side safety backstop. |
| compaction on an idle session posts summarize with auto:false | KEEP | Idle compaction must use the selected provider/model and auto:false rather than start an unrelated prompt turn. |
| rollback forks, verifies the boundary count, re-applies the ruleset and re-points | KEEP | Rollback must cut at the removed prompt, verify copied history, move the resume cursor and restore permissions. |
| rollback refuses when the fork did not preserve the boundary | KEEP | An invalid rewind boundary count must refuse, keep the current conversation and delete only the unusable fork. |
| rollback by turn ID forks at the NAMED turn's prompt, wherever the count points | KEEP | A named historical turn must determine rewind position even when unobserved provider history makes the count disagree. |
| a live turn is named by the prompt that opened it, so a rewind finds it again | KEEP | A live turn's provider prompt identity must remain usable as a later rewind boundary despite multiple assistant messages. |
| rollback refuses a turn ID the session no longer holds, before forking anything | KEEP | A no-longer-present turn id must fail without forking, patching permissions or repointing the thread. |
| a second rewind finds a turn the first one kept, under the fork's re-minted ids | KEEP | A second rewind must translate retained turn identities through provider re-minting and continue refusing already-dropped turns. |
| a dead server settles the turn and the requests BEFORE session.exited | CONSOLIDATE | Dead-server turn failure, recoverability and ordering are consolidated into the stronger both-card crash-withdrawal owner. |
| a host-initiated stop settles the turn as interrupted and exits gracefully | CONSOLIDATE | Graceful host-stop turn state and parent-before-children abort ordering are consolidated into the both-card stop owner. |
| a live subagent is closed `stopped` before session.exited | KEEP | Stopping a live child must close its roster row before session.exited and remove it from live-subagent tracking. |
| a child session's question rides no turn, and so does its answer; the parent's own ride its turn | KEEP | A child's question and its answer must outlive the parent's turn without being attributed to it; parent questions keep their own turn. |
| interrupting a turn closes its subagents too | KEEP | Interrupting a turn must close its native subagents stopped before the turn abort row. |
| §6.2: an interrupt with NO active turn still stops all background work | KEEP | Session-scoped Stop between turns must stop background work, release liveness and reach the provider. |
| §6.2: a session-scoped interrupt with nothing live is a clean no-op | KEEP | A session-scoped Stop with no turn/child must not invent task or turn terminal rows. |
| stop is idempotent and emits exactly one session.exited | KEEP | Repeated stop calls must emit exactly one session.exited. |
| a background answer wakes the parent: its reply runs as a turn named by the injected prompt, and the run's idle settles it | KEEP | A background result must open one correctly identified running turn before reply text, report its own usage and settle ready at idle. |
| a session.error during the woken reply fails its turn, as it fails any | KEEP | A provider error during an unsolicited woken reply must fail that reply's turn with its actual diagnostic. |
| the user's message during the woken reply steers it: one turn, which the run's idle ends | KEEP | A user steer during a woken run must join the existing turn and accumulate both replies' usage. |
| a second answer that arrives while the woken reply runs joins its turn: one turn, one completion | KEEP | Another injected background answer during a live woken run must join it rather than create another turn/completion. |
| a Stop during the woken reply aborts its turn, and what the aborted run still sends opens nothing | KEEP | Stopping a woken run must abort provider work, return ready and suppress late replies from that stopped run. |
| a Stop's leftovers end once a later turn fails: a background answer after it still wakes the parent into a turn | KEEP | A previous Stop's stale flags must not suppress a new background wake after an intervening genuine turn failure. |
| a rewind ends a relaunched child the fork leaves behind: aborted, its call and then its run closed, and nothing of it comes back | KEEP | Rewind must abort and close a revived child's open calls/run, release drain and suppress late frames regardless of host revert ordering. |
| a rewind closes a left-behind child's calls on the turns it keeps only: a call whose rows ride a removed turn goes with them, and leaves no lone closer | KEEP | Rewind must close only child calls on retained/no-turn rows, remove dropped-turn calls without lone closers and yield a consistent host fold in either event order. |
| a rewind ends a background child still running between turns: aborted, closed, and the drain released | KEEP | Rewind between turns must stop a still-running background child, close only its open calls and prevent late idle from reopening work. |
| a child whose abort frames beat the Stop's own close ends stopped — its own abort error, or its call's cleanup — never failed | KEEP | Abort error or interrupted-call cleanup arriving before Stop's own closure must yield one stopped child rather than failed/double completion. |
| a background child outlives its launching turn's failure — running in the roster and in liveness — and ends by its own idle and answer | KEEP | A real background child must survive its parent turn's provider failure, keep roster/liveness running, then end with its own answer. |
| a foreground child of a failed turn is still closed stopped | KEEP | A foreground child of a failed parent turn must still close stopped rather than remain phantom working. |
| a Stop closes every child — a background one too: the abort cancels its job | KEEP | Stop must close both foreground and background children and clear live-subagent state. |
| a child that survives the Stop is relaunched on the server's word: the roster reads it running, then completed with its own answer | REWRITE | A provider-confirmed surviving child must reopen the real roster, hold drain and receive its own answer before releasing liveness. |
| a second Stop closes a relaunched child, and a confirmed report relaunches it again under its next id | REWRITE | Repeated Stop/revival must use distinct activation identities, close the current activation once and reopen the next correctly. |
| a NESTED subagent that survives the Stop is relaunched too: its first start names its call, and it reads running, then completed with its own answer | REWRITE | A nested surviving subagent must retain parent-agent linkage, reopen independently and receive its answer through its immediate parent. |
| after a failed admission a relaunched child holds the drain, but reads interrupted: that session reads error, which the roster takes for dead | REWRITE | A failed prompt admission leaves the parent transport doubtful: revived child work holds drain while the roster correctly treats the errored parent session as interrupted. |
| a child the Stop ended sends its leftovers: the server says it runs nothing, and it stays ended | KEEP | Late leftover frames from a confirmed dead child must not reopen it; each burst triggers bounded status work and a genuinely new busy may be checked again. |
| a child the Stop closed that reports while the server cannot say counts live again: the drain outranks a duplicate row | KEEP | If status probing fails, a reported surviving child must conservatively hold drain rather than lose active background work. |
| a report from a child the Stop closed, arriving while a later Stop is under way, is judged after that Stop: its abort may end the child | KEEP | A child report during another Stop must await that abort before checking whether its run survived, preventing a false revival. |
| a Stop that begins and ends while the server is asked about a child makes that answer stale: it asks again, and does not relaunch a child it ended | KEEP | A complete Stop during an in-flight status read invalidates that stale busy answer and forces a new check. |
| a child whose own idle arrives while the server is asked about it is not revived: that report was its last | KEEP | A child's own idle arriving during a survival check must prevent a stale busy response from reopening it. |
| the session stopping during the woken reply settles its turn before session.exited | KEEP | Stopping during a woken reply must settle its turn interrupted before session.exited. |
| the host's own /compact runs no turn: its summary streams while summarize runs, and opens nothing | KEEP | Host-requested compaction summary frames must never fabricate a user turn while summarize is in flight. |
| a woken run that compacts first runs as one turn from its summary on, which the run's idle settles | KEEP | An unsolicited run that compacts before replying must remain one running turn through summary/reply, counting only real reply usage. |
| a rewind's fork is the past: its copied messages, delivered late, open no turn | KEEP | Late copied messages in a rewind fork are history and must not open new live turns. |
| after a Stop, a background answer's run is a new run: its reply is written on its own woken turn, the stopped run's late frames still dropped | KEEP | After Stop's teardown boundary, a genuinely new background run must open its own turn while old frames remain absent. |
| after a Stop, a new run whose busy arrives before the abort answers still gets its woken turn once the abort is over | KEEP | A new run's busy arriving before the abort HTTP response must remain valid after abort settlement and allow its later woken reply. |
| while a Stop is under way, a run the abort then cancels says busy after an idle: its reply opens no turn, before the abort answers or after | KEEP | A run actually cancelled by an in-flight abort must never open a woken turn, even if its busy follows an earlier idle. |
| when the stream wins the race and the boundary is crossed early, the cancelled run's own abort error is an echo: no failure, no error | KEEP | One late abort-error echo may be suppressed across the early boundary; a second unexplained abort must become a real runtime error. |
| the echo is expected only until the parent's next idle, in either spelling: after a real new run, an abort error nobody here sent is reported | KEEP | Either supported idle spelling ends the echo window; a later external abort must be reported rather than ignored indefinitely. |
| a host turn sent after a Stop is no abort's victim: an abort error mid-turn fails it, whichever of its busy and its prompt's answer comes first | KEEP | After a real new host prompt is admitted, an external abort must fail its own turn regardless of busy/HTTP ordering. |
| an abort error that may still be the Stop's echo fails no host turn: before the stopped run's idle came, or before the turn's prompt was taken | KEEP | An abort still possibly belonging to the previous Stop must not fail a new host turn before old idle evidence or prompt admission establishes ownership. |
| after a Stop whose abort request failed, an abort error before the run's idle is still the Stop's echo: it fails nothing, and the idle then ends the turn as the Stop would have | KEEP | A failed abort HTTP call may still produce its own error echo; suppress that echo and settle the stopped turn when actual idle arrives. |
| a Stop whose abort request failed: the stream's or the server's word that the run ended settles the turn as the abort would have — two idle frames or a lone one, before the failure or after it, or a reconnect's status poll; without that word, the next Stop asks the server again — and the next run is a new one | KEEP | Failed Stop recovery must honor each independently observed end receipt, permit an explicit retry without an end receipt and clear state for a later new run. |
| a steer after a failed Stop takes the turn back: the run's own end completes it, and the background work it started runs on | KEEP | A user steer after failed Stop must reclaim the still-running turn, complete normally and leave its new background child running until a later Stop. |
| the end of a Stop whose abort request failed closes the children, then aborts them: a child's report in between asks the server only once that abort is over, so a child it ends is never relaunched — the run's idle or a reconnect's status poll | KEEP | Deferred completion of a failed Stop must wait for descendant aborts before judging child reports, whether discovered through stream idle or reconnect status. |
| the end of a Stop whose abort request failed: a request from a child that end is aborting is judged after that abort — an ask it ends gets no card | KEEP | A held child ask arriving while failed-Stop cleanup aborts that child must wait until abort completion, then reject without showing a dead card. |
| a child's report the server is being asked about when a failed Stop's run ends is asked about again once that end's abort is over: the answer from before it is stale | KEEP | A child survival reply from before a failed-Stop descendant abort is stale; wait and recheck instead of transiently reopening cancelled work. |
| after a Stop, a busy from before the stopped run's idle ends nothing: a reply to an unclaimed prompt after it still opens no turn | KEEP | A stale busy from before the stopped run's first idle is insufficient to establish an unrelated new woken run. |
| a reconnect clears a stale busy: a reply the host never started, after the gap, opens no turn | KEEP | Reconnect must discard pre-gap busy evidence so a late reply cannot create a turn with no run to end it. |
| a reconnect keeps what a live run says after it: a busy after the gap still opens the woken turn | KEEP | Fresh post-reconnect busy evidence must still allow a real woken run and its completion. |
| after a Stop, a question from a child the abort never reached is shown on no turn, and its answer reaches the server | KEEP | A surviving background child's question must remain actionable without a parent turn and disappear from the real pending-card fold after its reply. |
| after a Stop, a live asker's approval is shown — on the turn running then, none here — and answered on its reply route | KEEP | A surviving asker's approval after Stop must show the right card and send only its chosen one-time reply. |
| after a Stop, a request whose asker the abort ended is rejected on the wire and writes no card — nor a row when it closes | KEEP | A dead asker's late approval/question must reject on the provider wire without creating either opening or closing log rows. |
| after a Stop, a request answered elsewhere while the server is asked about it is dropped: no card, no row, nothing sent | KEEP | An ask answered elsewhere during its status/list check must vanish without another reply or phantom card. |
| after a Stop, an older server's orphan — still listed, its session idle — is rejected too, and shown nowhere | KEEP | Old-provider orphaned asks still listed after abort must be rejected when their session is idle, matching the captured compatibility behavior. |
| a request that arrives while the Stop's abort is in flight is judged after it: an asker the abort ended gets no card on the stopped turn | KEEP | A request arriving during abort must be judged after it, not shown based on the asker's stale pre-abort busy state. |
| a request that arrives once the next turn is sent, before its run says busy, is judged too: the stopped run's leftover is no card on the new turn | KEEP | A stopped run's leftover ask before the next prompt's busy receipt cannot be attached to the new turn. |
| an ask that arrives while the Stop withdraws the parked cards is held too: judged after the abort, no card on the stopped turn | KEEP | A request arriving during parked-card withdrawal must also wait for the complete Stop before its dead asker is rejected. |
| after a prompt admission fails and aborts the session, a request is judged as after a Stop: the aborted run's is rejected, a live asker's shown | KEEP | Failed prompt admission's own abort must apply the same late-request rules: reject an ended asker and preserve a genuinely waiting one. |
| a Stop that begins and ends while the server is asked about a held request makes that answer stale: it asks again | KEEP | A Stop completed during a held request's read invalidates that stale listed/busy answer and requires a current judgement. |
| after a Stop, a request the server cannot say anything about is shown: the user answers it, never a reject on their behalf | KEEP | Unavailable provider evidence must show the user the request instead of rejecting it on their behalf. |
| full access: a live asker's request after a Stop is answered once, as any; a reply the server refuses shows the card once | KEEP | Full access after Stop must answer a surviving ask once, never always, and fall back to one card when automatic response fails. |
| full access: an automatic reply the server refuses falls back to the card while a turn runs | KEEP | A refused automatic reply during an ordinary live turn must leave an actionable card attributed to that turn. |
| malformed model selections fail before opening or submitting a turn | KEEP | Malformed provider/model selection must fail before turn creation or provider submission. |
| answers prefer question ids, then headers, then question text, preserving multiple selections | KEEP | Question answers must prefer stable ids over headers over text and preserve each multi-selection in the provider wire array. |
| Q1 #21: a co-tenant thread's ask is probed ONCE, not polled forever | KEEP | A confirmed foreign-root ask must be checked once, never retried forever or shown on this thread. |
| Q1 #21: an unreadable session is retried, but the chain is CAPPED | KEEP | Transient unreadable ancestry must retry only to its bounded cap and then stop generating provider reads. |
| Q1 #21: closing the thread abandons an in-flight ancestry chain | KEEP | Closing a thread must abort an ancestry chain currently waiting to retry, with no later read. |
| a stop withdraws every parked card, once each | CONSOLIDATE | Both parked cards must withdraw once; this surviving owner also proves interrupted/graceful turn exit and parent-before-children abort ordering. |
| an interrupt withdraws every parked card, once each | CONSOLIDATE | Both parked cards must withdraw once on interrupt before the provider abort, and later stop cannot withdraw them again. |
| a dead server withdraws every parked card once, before session.exited | CONSOLIDATE | Both parked cards must withdraw once before crash exit; this surviving owner also proves failed turn state, recoverability and all terminal ordering. |
| the user's own answers are never withdrawn — and the server's echo adds no row | KEEP | User answers, including explicit cancellation, must not be marked withdrawn and provider echoes must not duplicate closing rows. |
| session tools: the thread's own server is registered before its session, isolated by its ruleset | KEEP | Session-tool registration must occur before session creation with its bearer, isolation rules, timeout and system instructions; teardown revokes and disconnects the credential. |
| session tools: a resumed session gets the isolation rules re-asserted | KEEP | Resuming an existing session must replace inherited permission state with its current session-tool isolation. |
| session tools: a failed registration costs the tools, never the thread | KEEP | A failed own MCP registration must not prevent a chat session from opening. |
| session tools: a thread whose grant failed still sends the deny, and no allow | KEEP | Failure to obtain an own tool grant must still send deny-only co-tenant isolation rather than expose other threads' tools. |
| session tools: a denial by disconnect alone (an overlapping name) is re-asserted at every turn start, and ruled once it cannot be | KEEP | An overlapping denied server must be disconnected on every turn and fail closed with a rule only when exact disconnect fails. |
| session tools: a rule whose send failed is not taken as sent — the next turn start sends it again | KEEP | A permission rule whose PATCH failed must be retried on the next turn, which must never submit while the denial was unsent. |
| session tools: a relaunch registers only after the stopped session's disconnect | REWRITE | The useful contract is stop awaiting its pending disconnect. Drain asynchronous continuations before proving it blocked; remove the second-start ordering assertion arranged by awaiting stop in the test itself. |
| without session tools nothing is registered and the ruleset is unchanged | KEEP | Global/no-tools sessions must submit ordinary rules/instructions and perform no per-thread MCP registration; this owns deleted helper identity assertions. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/session.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/snapshot-budget.test.ts

Independent contract source: Agent GUI §4.5 catalogue fallback, §4.6 degraded snapshots; historical cold-probe defect documented in file and actual readiness/version/body receipts.

Six-bar shared rationale and risk: Public adapter.refreshSnapshot against a real scripted child and real HTTP. Gated readiness and independently controlled CLI version/binary rewrite establish outputs without wall-clock sleeps. Server-pool tests own child adoption; provider-snapshots tests own registry deadline override; these uniquely own adapter cold/warm/cwd-less/degradation/cache behavior. makePeer is retained with real-child callers in server/recycle/fork tests. Refactors preserve ready/degraded/model/auth results and startup identity. Risk is an empty or stale Settings catalogue.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| E9: a COLD probe waits for the server to report ready, then reads the catalogue | KEEP | A cold refresh must await the actual readiness receipt before reading the server catalogue; a gated real child catches early failure/empty snapshots without elapsed sleeps. |
| E9: the second probe is warm — the start cost is paid once per project | KEEP | Equivalent project spellings must reuse the warm server; a second gated startup would expose duplicate cold work. |
| R4 #7: the cwd-less refresh reads the CLI catalogue without creating a session | KEEP | A background cwd-less refresh must obtain models/auth/skills through the actual CLI launch without manufacturing a thread session. |
| E9: a catalogue failure degrades the snapshot while retaining available skills | KEEP | A failed provider HTTP catalogue must degrade models while retaining independently available skills instead of losing the whole snapshot. |
| an unread version is not served from the cache: the next refresh reads it again | KEEP | An unreadable version must not poison the TTL cache; a later successful version probe must recover immediately. |
| an update that rewrites the binary is re-probed, not answered from the TTL cache | KEEP | An in-place binary rewrite must invalidate the cached version so an explicit refresh observes the update. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/snapshot-budget.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/snapshot.test.ts

Independent contract source: Agent GUI spec §7.6 token meter and provider models.dev limit.context wire field in the committed /provider capture.

Six-bar shared rationale and risk: Public provider snapshot output and the live session denominator lookup. Literal positive/zero/missing limits test independent known inputs; provider replay checks real capture format separately. Pure catalogue conversion owns invalid/missing denominators, while normalization owns usage attribution. All APIs have production callers in index.ts. Refactors preserve model/limit values without internal order/call assertions. Risk is a misleading context meter.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| each connected model carries its `limit.context` as its context window, when it states one | KEEP | Model context denominators must come from positive provider limit.context values, retaining no guessed window for missing/zero limits; both snapshot and live-meter inputs must agree. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/snapshot.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/opencode/sse.test.ts

Independent contract source: The SSE framing protocol and AGENTS.md preserve provider wire behavior; fixture README documents decoded captures do not exercise raw framing.

Six-bar shared rationale and risk: readSseFrames over independent byte streams is the lowest stable wire parser seam. Literal data/event values, termination and stream cancellation are independent of parser internals. Decoded fixture replay never tests raw chunks/CRLF/BOM or abandoned fetch bodies. Production session pump calls this generator; private SseParser remains unexported. Refactors may replace the parser while preserving framing/resource outcomes. Risk is dropped/corrupted provider events or leaked sockets per reconnect.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| a frame split across chunk boundaries is reassembled | KEEP | Network chunks may split a data field, its value or frame delimiter; reassembly must emit one exact payload. |
| multi-line data is joined with newlines, per the SSE spec | KEEP | The SSE wire contract joins successive data fields with newline characters. |
| `:`-comment keep-alives produce no frame and do not break the next one | KEEP | Comment keep-alives must emit no frame and cannot corrupt the next data frame. |
| CRLF line endings decode the same as LF | KEEP | CRLF input must retain the same event/data semantics as LF. |
| one leading space after the colon is stripped, further ones are data | KEEP | Exactly one optional space after a field colon is syntax; further spaces belong to the payload. |
| a field with no colon, and unknown fields, are ignored | KEEP | Unknown fields and colon-less fields cannot discard a valid data frame. |
| a blank line with no data emits nothing | KEEP | Blank/event-only frames have no data and must emit nothing. |
| an unterminated trailing frame is NOT emitted until its blank line | KEEP | EOF must not dispatch an unterminated data frame; its terminating blank line completes it. |
| a BOM is stripped once, at the start of the STREAM | KEEP | A byte-order mark applies only at stream start, not at each network chunk boundary. |
| a BOM mid-stream is preserved verbatim in the data | KEEP | A byte-order character inside a later payload must remain literal user data. |
| readSseFrames yields every frame and ends at EOF | KEEP | Every complete frame is yielded in order and iteration ends cleanly on EOF. |
| readSseFrames CANCELS the body when the consumer breaks out | KEEP | Breaking iteration must cancel the response body so each reconnect cannot leak a fetch connection. |
| readSseFrames cancels the body when the consumer throws | KEEP | A consumer exception must preserve the original error and cancel its abandoned body too. |
| readSseFrames on a null body ends immediately | KEEP | A null fetch body must terminate iteration without inventing a frame. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/opencode/sse.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/pending.test.ts

Independent contract source: Agent GUI spec §3.2 startup snapshot layers, §7.7 auth ambiguity; agent-host/README.md boot-readiness rules.

Six-bar shared rationale and risk: Adapter registry pendingSnapshot factories and cache-classifier result. Caller-supplied time and explicit initial values are independent expectations. Cache tests exercise storage/refresh; these are the shared cross-provider seed-vs-real-result collision owner. Pending-seed recognition and rejection of genuine probe data with identical status fields protect caching without pinning the private message wording. Production registry and all providers call these APIs. Risk is missing provider rows, false sign-in notifications or discarded probe cache.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| is synchronous and self-describing | KEEP | Every registered provider must exist synchronously before I/O, with its own registry id and the caller's timestamp; prevents a missing startup provider card. |
| claims no verdict: status unknown, auth unknown, the T3 message | REWRITE | Unknown status/auth and public pending recognition survive; removed exact message-tail copy because a coordinated wording change preserves behavior and should not fail this test. Real probe collisions remain independently rejected below. |
| isPendingSnapshot rejects a real probe result | KEEP | Ready, missing-provider and message-less probe results must not collide with a pending seed; otherwise cache hydration silently discards usable verdicts. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/pending.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.

## apps/daemon/src/agent-host/adapters/profile-manifest.test.ts

Independent contract source: docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§2,6,6.5 and README Agent Profiles fail-closed launch behavior.

Six-bar shared rationale and risk: Shared adapter manifest-loader API over real temporary prepared manifests. Independent profile/revision/agent identities and ProfileLaunchError are the oracle. Schema-store tests own tolerant manifest serialization; adapter integration owns provider launch arguments; these cases uniquely guarantee loader translation/refusal instead of Global fallback. All adapters call the loader; no production test seam is created. Risk is silently launching global instructions/credentials.

| Exact baseline test name | Disposition | Specific behavioral failure, independent oracle, or surviving owner |
| --- | --- | --- |
| answers null for a Global thread, without touching the disk | KEEP | A Global launch must require no prepared profile and return null; adapters must keep working without profile files. |
| answers the agent's section of a matching manifest | KEEP | A prepared section is valid only for the requested profile/revision/agent; missing or mismatched manifests must fail with ProfileLaunchError, preventing silent Global fallback. |


Validation target: from apps/daemon, `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/adapters/profile-manifest.test.ts`. Root owns runner preloads and the final full-suite/typecheck gates; this report does not claim an unexecuted command passed.
