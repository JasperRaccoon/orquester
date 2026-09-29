# OpenCode test cleanup

Status: completed cleanup. Dispositions were recorded before edits and refined before each additional cleanup. All 303 original tests are accounted for: 42 DELETE, 28 REWRITE, 233 KEEP. The resulting suite contains 261 tests.

Audited 303 original tests in 13 files. Every owner and all original test bodies were read. A case title below identifies the concrete failure input/outcome; protocol payload text is test data, not UI copy. This scope contains extensive request/Stop race regressions, which are retained only where the differing ordering changes caller-visible behavior.

## Sources and six-bar rationale

Sources: [agent chat GUI spec](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [agent profile spec](../superpowers/specs/2026-09-28-agent-profile-design.md), [provider fixture provenance](../../apps/daemon/test/fixtures/opencode/README.md). The provider README distinguishes captures from source-derived cases.

### `cli-inventory.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/cli-inventory.test.ts`.

1. Independent contract: OpenCode CLI models --verbose / agent list / debug skill data contract; fixture README observation 22; shared SQLite CLI concurrency failure.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: CLI stdout → parsed catalogue; real child process → catalogue/failure. Production: snapshot discovery in index.ts.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 178: a skill object severed mid-string does not corrupt the ones before it | **DELETE** | The preceding truncated-array case already cuts a later object mid-string and checks every intact earlier skill. |

### `completion-output.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/completion-output.test.ts`.

1. Independent contract: Provider normalization and generic MCP output reading contracts.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Deleted cross-layer harness; generic host/MCP consumers own the remaining contract.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 187: is stored marked cut, and read_tool_output reads the streamed join: all it printed, then where it was saved | **DELETE** | Duplicates adapter cut-output normalization in normalize.replay and generic MCP tools/output.test.ts plus output.integration.test.ts join/window ownership. |
| 211: with nothing streamed, answers the part the tool kept as command-output, marked cut — never as the whole | **DELETE** | Duplicates adapter cut-output normalization in normalize.replay and generic MCP tools/output.test.ts plus output.integration.test.ts join/window ownership. |
| 224: a command-named tool the GENERIC truncation cut answers its kept head as command-output, marked cut | **DELETE** | Duplicates adapter cut-output normalization in normalize.replay and generic MCP tools/output.test.ts plus output.integration.test.ts join/window ownership. |
| 258: a completion the tool did not cut is unchanged: its data answers its output whole, and the join is never asked | **DELETE** | Duplicates adapter cut-output normalization in normalize.replay and generic MCP tools/output.test.ts plus output.integration.test.ts join/window ownership. |

### `history.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/history.test.ts`.

1. Independent contract: GUI design §§4.2, 6.1 and fixture 10 fork/messages, fixture 03 tools, fixture 06 abort captures.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Provider GET message history → RuntimeEvent[]. Production: session.ts read-history/rewind.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 130: fixture 10: `step-start` / `step-finish` are bookkeeping and project to nothing | **DELETE** | The exact captured-history event sequence already excludes all bookkeeping parts. |
| 182: fixture 10: history replays identically after a whole-history fork, under the new ids | **DELETE** | The expected transcript is computed by the same projection being tested. The captured-history literal oracle and session second-rewind reminted-ID regression remain. |

### `normalize.replay.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/normalize.replay.test.ts`.

1. Independent contract: GUI design §§3.1, 4.2–4.5, 7.6; fixture README observations 4–19 and 23–29 (26–29 are explicitly source-derived protocol regressions, not captures).
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Provider SSE event → normalized RuntimeEvent and caller usage summary. Production: session.ts stream/recovery path; runtime ingestion consumes these events.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 357: no capture produces a runtime.warning for a known-ignored frame | **REWRITE** | Require no runtime.warning for known captured frames, removing a message-substring filter that could mask changed warnings. |
| 467: 02: the user's own message never becomes assistant content | **DELETE** | The preceding exact assistant delta list rejects both user echoes and duplicate terminal snapshots. |
| 476: 03: a permission ask opens a card whose workspace option names the widened pattern | **REWRITE** | Consolidate the documented directory-wide security warning into the captured permission card, alongside the widened pattern and actionable decisions. |
| 516: 03: full access auto-answers `once` and never opens a card | **DELETE** | Private auto-reply/idle signals duplicate the actual HTTP once reply, card visibility, and Stop/late-abort outcomes retained in session.test.ts. |
| 577: 06: an abort arrives as MessageAbortedError, the Stop's own answer on the stream — never surfaced as an error | **DELETE** | Private auto-reply/idle signals duplicate the actual HTTP once reply, card visibility, and Stop/late-abort outcomes retained in session.test.ts. |
| 656: 10: the premature-idle race shows up as an idle signal, never as a completed turn | **DELETE** | Checks private signal shape, while session premature-idle regression verifies actual completion. |
| 834: 12: every emitted event belongs to this thread | **DELETE** | Thread ID stamping is already required by retained co-tenant filtering and child attribution cases. |
| 842: 12: a child session is a roster task: one start, one end, then the run's result | **REWRITE** | Include the initiating call ID in the existing child lifecycle test and remove the duplicate test. |
| 868: 12: the child's first task.started names the call that launched it | **DELETE** | Merged the launch-call assertion into the existing child lifecycle contract. |
| 984: 12: a child seen during a live turn marks the turn as having subagents | **REWRITE** | Observe hasSubagents on the emitted usage payload conversion instead of accumulator/map internals. |
| 1012: 12: a child's step-finish tokens never reach the PARENT turn's accumulator | **REWRITE** | Assert the caller-facing usage summary for child-only steps; remove private accumulator set-size assertions. |
| 1053: a live child is closed `stopped` when the session goes down (§3.1) | **DELETE** | Session shutdown regression verifies real task.stopped before session.exited. |
| 1090: a `task_id` resume of a settled child launches it again, and its own idle settles it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1165: a second call on a LIVE child is not a relaunch, and its end does not settle it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1187: once a relaunched run settled, a late frame of ANY earlier call is stale | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1225: a relaunched child is closed `stopped` when the session goes down (§3.1) | **DELETE** | Session second-Stop/relaunched-child regression checks the actual operation and task events. |
| 1237: a task part answered in the background does not settle the child it launched | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1284: 12 end to end: the child's roster row ends with its task part's output as its result | **DELETE** | Lower replay lifecycle checks result ownership; generic task folding owns roster projection. |
| 1579: a background run's answer, injected into the parent, becomes its result, once | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1615: a background run's answer injected while a Stop's leftovers are still dropped is its result all the same | **DELETE** | Session Stop-leftovers and surviving-child regressions cover this through the operation boundary. |
| 1703: a child no task part names still starts under a launch id of its own: `opencode-child:<session>` | **DELETE** | The longer child-frames-before-launch-part case covers fallback launch and later linkage; unnamed-child resume also covers fallback identity. |
| 1853: a revival whose run started with no launch id seeds one first, so the roster reopens: running, then completed — the defensive branch | **DELETE** | Explicitly unreachable defensive state, manufactured by deleting private state; no production input reaches it. |
| 2150: a woken run that compacts first runs as one turn from its summary on, the summary off the meter | **DELETE** | Session-level compaction-before-reply regression checks the real turn completion and usage instead of private flags. |
| 2221: no capture opens a turn of its own: every reply in them answers a prompt the host sent, or is a compaction | **DELETE** | The harness preclaims every prompt; direct host-owned/ended-reply negative and session compaction tests already own the contract. |
| 2251: a second answer that arrives while the woken reply runs joins its turn | **DELETE** | Session second-background-answer test owns one-turn/one-completion behavior. |
| 2277: output that follows an interruption opens nothing, a woken reply's included | **DELETE** | Session Stop plus late-frame tests own suppression through the actual operation. |
| 2287: a request after an interruption waits for the server's word on its asker: no card, one signal; a repeat adds nothing, an answer meanwhile no row | **DELETE** | Private signal assertion; session held-request races verify card/reply outcomes. |
| 2407: running bash parts yield chunks whose concatenation is the final output | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2492: 12 through the host: the chunks are the child call's output, joined and closed | **DELETE** | Captured child command chunks remain tested; generic output integration owns joins and closing buffers. |
| 2665: a timeout's note reaches the stream, before the completion closes it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2692: an abort's note reaches the stream too | **DELETE** | Timeout-note test exercises the identical arbitrary suffix preservation contract; abort lifecycle separately covered in session. |
| 2710: a completion that extends the last running value adds what the frames missed | **DELETE** | The cut-final-output case includes the same uncut-final-output extension vector. |
| 2966: a command that printed nothing, or failed, adds nothing at its end | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2993: a co-tenant session that is NOT a child of this thread is still dropped | **DELETE** | Retained fixture-12 mixed co-tenant replay tests actual filtering; this checks only session.created and a private child map. |
| 3018: 13: three session.error frames for one bad model collapse to one runtime.error | **REWRITE** | Assert account-reason absence alongside the mandatory positive errors, rather than a separate vacuous loop. |
| 3032: 13: a session.error settles the turn through a signal | **DELETE** | Session asynchronous-error and woken-error cases verify turn failure; this observes a private signal only. |
| 3037: 13: the recorded errors name no account failure | **DELETE** | Merged account-reason absence into the positive error test that requires the two actual errors, removing vacuous-loop success. |

### `project-key.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/project-key.test.ts`.

1. Independent contract: GUI design §3.2 per-project server and §4.5 account binding; fixture README observation 21 directory scope.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Canonical project pool key and adapter.startSession account rejection. Production: index.ts refreshSnapshot/startSession.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 37: the key is RESOLVED, because the server never validates a directory | **REWRITE** | Use literal canonical project path, not a second call to production as the oracle. |

### `prompt-closed-text.replay.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts`.

1. Independent contract: Captured closing text snapshot and prompt ownership; GUI design §4.2 streaming completion.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Owned provider text frames → complete streamed assistant text. Production: normalizer/session ingestion.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

### `recycle.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/recycle.test.ts`.

1. Independent contract: Agent profile design §4.8 configuration-triggered idle recycle/defer-busy; GUI design §3.1 lifecycle.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: AgentAdapter recycle/start/send/history/rollback operations with real spawned peers. Production: profile config refresh invokes recycleIdleServers; host uses other operations.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 289: an idle project's server is stopped now, with no session.exited, and the thread's next start gets a fresh server | **REWRITE** | Exercise the public adapter factory and real process close event; remove the concrete-class/test-drain dependency. |
| 333: a busy server is deferred, recycled once when its turn ends, and not again on later idles | **REWRITE** | Use the public adapter factory and actual child close event to prove defer-while-busy and recycle-after-completion. Retain the later-idle regression with the existing deterministic scheduler drain: a consumed config-change mark must not recycle a later server. |
| 373: a turn that reaches a recycled thread before its restart brings the session back itself | **REWRITE** | Exercise the public adapter factory and real process close event; remove the concrete-class/test-drain dependency. |
| 390: nothing running means nothing recycled; a user's session stop after a recycle forgets the thread | **REWRITE** | Exercise the public adapter factory and real process close event; remove the concrete-class/test-drain dependency. |
| 408: history reads and rewind on a recycled idle thread bring its session back (the host calls them without ensureSession) | **REWRITE** | Use the public factory/process seam; require the specific missing-turn validation after reconnect instead of accepting every error except no-live-session. |
| 438: a recycle never stops the server under a history read; it goes once the read ends | **REWRITE** | Exercise the public adapter factory and real process close event; remove the concrete-class/test-drain dependency. |

### `ruleset.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/ruleset.test.ts`.

1. Independent contract: GUI design §4.3 decision mapping/security warning, §4.4 permission modes, §§4.6.3 and 4.6.5 command catalog.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Permission decisions/rules and catalogue descriptors. Production: session.ts HTTP requests, normalize.ts approval cards, snapshot.ts catalog.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 50: §4.3: a reply that arrives from elsewhere maps back to a decision | **DELETE** | Captured permission reply cases in normalize.replay assert once/always/reject outcomes at the request-event boundary. |
| 56: §4.3: `Allow for workspace` warns, and names the pattern it widens | **DELETE** | Captured permission-card test already verifies the actual widened pattern and directory-wide security warning. |
| 94: a bash ask shows its command; anything else shows the permission name | **DELETE** | Bash permission data is asserted on the captured request card; other-label prettification is implementation copy, not a specified contract. |
| 137: §4.4 accept edits: the SAME list, with `edit`→allow | **REWRITE** | Assert independent allowed-edit and sensitive-read/shell approval rules; remove same-implementation list/position comparisons. |
| 153: §4.4 auto: falls back to Supervised, by deliberate choice and not by omission | **REWRITE** | Assert explicit supervised security decisions rather than comparing two calls to production. |

### `server.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/server.test.ts`.

1. Independent contract: GUI design §§3.1–3.2 and §4.5 spawn/readiness/version/auth/lifecycle; fixture README observations 1, 20–22.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: OpenCodeServerPool acquire/release/recycle/stop, OS child exit and HTTP health. Production: index.ts per-project server ownership.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 55: the readiness scrape stays line-oriented past the unsecured-server warning | **DELETE** | The real spawned noisy-peer acquisition exercises this warning plus the readiness line. |
| 303: §3.2: two threads in ONE project share one server, keyed by projectPath | **DELETE** | Manually composing projectDirFor and pool.acquire does not test adapter project wiring; project-key normalization and pool sharing tests own both contracts. |
| 444: the startup buffer is trimmed on a LINE boundary | **REWRITE** | Assert readiness bytes survive truncation and truncation cannot promote a phrase inside a warning into a readiness line. Remove line-layout assertions and the alternative-algorithm demonstration. |
| 490: stopAll kills every server, refcount notwithstanding | **DELETE** | The preceding overlapping-stopAll regression already holds a reference and proves both teardown calls wait for process exit. |

### `session.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/session.test.ts`.

1. Independent contract: GUI design §§3.1, 4.1–4.5, 6.1–6.2; fixture README observations 5–17, 19, 26–29 request/idle/fork/interrupt/child protocol.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: OpenCodeSession operations plus actual HTTP/SSE wire records and normalized events. Production: index.ts delegates public AgentSession operations.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 601: the host's §6.1 create-time cursor resumes, byte for byte | **DELETE** | Host cursor construction belongs to the generic resume owner; previous session resume test already sends this literal provider cursor. |
| 797: a non-native file whose path the text already names adds no block: the text is verbatim | **DELETE** | Shared attachment-lines tests own path deduplication; retained native/non-native send and command tests own the adapter wire integration. |
| 2922: end to end: through the host's real ingestion and fold, the woken reply reads as a running turn, then a settled one | **DELETE** | Provider woken-turn lifecycle is already asserted directly in this suite; generic ingestion/fold tests own running and settled projection. |
| 4351: Q1 #21: an unreadable session is retried, but the chain is CAPPED | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 4377: Q1 #21: closing the thread abandons an in-flight ancestry chain | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |

### `snapshot-budget.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/snapshot-budget.test.ts`.

1. Independent contract: GUI design §§4.5–4.6 catalogue discovery and graceful partial snapshots; fixture README observation 22 cold/warm startup.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: AgentAdapter.refreshSnapshot with real spawned peer/CLI. Production: host provider discovery.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 162: R4 #7: the cwd-less refresh reads the CLI catalogue and starts NO server | **REWRITE** | Name only proven CLI-catalogue/no-session behavior; an empty session list does not establish absence of a server. |
| 187: E9: a catalogue failure degrades the snapshot; it never spends the budget | **REWRITE** | Retain degraded-snapshot behavior and partial skills; remove wall-time assertion that never exercises deadline expiry. |

### `sse.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/sse.test.ts`.

1. Independent contract: SSE data framing/chunking/BOM protocol and ReadableStream consumer cancellation resource contract.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: SSE feed/async iterable output and body cancellation. Production: session.ts consumes readSseFrames; no caller consumes event/id metadata.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 59: `event` and `id` are carried, then reset for the next frame | **DELETE** | No OpenCode caller consumes these fields. This asserts metadata handling rather than an observable adapter failure. |
| 178: readSseFrames does NOT cancel after a clean EOF | **DELETE** | A closed ReadableStream does not call its cancel callback even if cancel() is invoked, so this negative passes for the wrong reason. |

### `woken-turn.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/woken-turn.test.ts`.

1. Independent contract: Generic host durable-turn restart reconciliation.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Deleted cross-layer harness; generic host/MCP consumers own the remaining contract.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 58: is settled by the next host's reconcile, at the time its process last wrote, like any turn | **DELETE** | Host restart/reconcile ownership belongs to orchestration/reconcile.test.ts; session.test.ts retains provider-created turn lifecycle. |

## Support and production seams removed

- Deleted `completion-output.test.ts` and `woken-turn.test.ts`, including their inline MCP/store/restart harnesses. Generic MCP output and host reconciliation retain their own contracts.
- Made `session.ts`'s `parseOpenCodeResume` private after removing its last external test import. Its production caller remains session startup.
- Recycle tests construct through `createOpenCodeAdapter` and observe the real child's `close` event; spawn interception delegates unchanged to Node and is restored after each case. The concrete class has only a type export. Its existing `recycleSettled()` drain and `recycleWork` bookkeeping remain to prove a later idle does not repeat a deferred recycle, without sleeps or polling.
- Removed unused replay helpers `firstOfType` and `sseTypes`, unused `ABORT_NOTE` and `WHOLE_FORK` constants, and unused imports.
- Removed `testing/host.ts`'s unused `loggedActivities` helper and `startIso` option; made its local result interface private. Removed the unused exported timestamp alias in `testing/woken.ts` and made its local reply type private.
- Provider NDJSON fixtures remain consumed by retained replay/history tests and the shared redaction scanner. Shared `inferAuth` is preserved for its production caller and shared adapter auth-status coverage. Shared host/woken harnesses still have retained consumers.

Production behavior is unchanged. No provider protocol, permission/security rule, persisted cursor format, process lifecycle operation or runtime event was altered.

## Validation and final diff

- Baseline: all 303 original OpenCode tests passed.
- Initial cleanup: all 263 then-retained tests passed; daemon package typecheck passed.
- After two additional signal-only duplicate deletions and the startup-protocol rewrite: all 95 normalizer/server cases passed.
- After replacing the production recycle drain: all 6 recycle cases passed.
- Final complete OpenCode suite: **261/261 passed**, zero failures/skips (33.97 s).
- Final daemon typecheck reported only concurrent out-of-scope Codex errors: `adapters/codex/replay.test.ts:400,402` missing `RuntimeEvent`; parent notified. Earlier daemon typecheck passed. No OpenCode diagnostic was reported.
- AST unused-import/local/function scan across all OpenCode tests and support: clean. Global reference search confirmed removed support exports had no other consumer.
- `git diff --check` for this scope: passed. Final diff reviewed; net **1,224 source/test/support lines removed** (108 added, 1,332 deleted), excluding this report.
- No coverage or test-count gate conflict was found. Root agent owns repository-wide gates, commit, remote merge and push.
