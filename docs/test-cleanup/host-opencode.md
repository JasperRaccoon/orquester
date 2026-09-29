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
| 47: models --verbose yields providers, models and the connected list | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 61: a body line that looks like a slug does not flush the model | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 78: an unparseable body drops that one model, never the catalogue | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 92: empty output is an empty catalogue, not a throw | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 110: agent list yields name, mode and the hidden flag the CLI omits | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 123: agent list tolerates an empty body and trailing whitespace | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 135: debug skill yields name/description/location and drops the huge body | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 155: a TRUNCATED skill array still yields every skill that arrived whole | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 178: a skill object severed mid-string does not corrupt the ones before it | **DELETE** | The preceding truncated-array case already cuts a later object mid-string and checks every intact earlier skill. |
| 186: malformed skill output degrades to an empty list | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 240: the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 248: a non-zero exit is retried once and recovers the catalogue sequentially | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 256: agents and skills may each degrade to an empty list | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 264: a models failure rejects — that one IS the catalogue | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 99: fixture 10: the captured history replays as turn markers around completed items | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 130: fixture 10: `step-start` / `step-finish` are bookkeeping and project to nothing | **DELETE** | The exact captured-history event sequence already excludes all bookkeeping parts. |
| 142: fixture 10: every replayed turn reports usage as unavailable, never a guess | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 163: fixture 10: every projected event is stamped historical and carries the turn id | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 182: fixture 10: history replays identically after a whole-history fork, under the new ids | **DELETE** | The expected transcript is computed by the same projection being tested. The captured-history literal oracle and session second-rewind reminted-ID regression remain. |
| 201: fixture 10: an empty fork projects to no events at all | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 205: fixture 10: a replayed prompt loses the `Attached files:` block the adapter appended | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 232: fixture 10: a synthetic user text part replays as nothing, never as the user's words | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 278: fixture 3: a completed tool call replays under its lifecycle type with its callID | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 300: fixture 6: reasoning replays as its own item and an aborted tool call is failed | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 371: an unrecognised frame takes the fallback rather than a catch-all drop | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 392: a re-stated title is mirrored once, not on every session.updated | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 429: server.heartbeat is known and silent | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 449: 02: text arrives as deltas and the closing snapshot emits nothing extra | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 467: 02: the user's own message never becomes assistant content | **DELETE** | The preceding exact assistant delta list rejects both user echoes and duplicate terminal snapshots. |
| 476: 03: a permission ask opens a card whose workspace option names the widened pattern | **REWRITE** | Consolidate the documented directory-wide security warning into the captured permission card, alongside the widened pattern and actionable decisions. |
| 497: 03: the bash tool part runs its whole pending -> running -> completed lifecycle | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 516: 03: full access auto-answers `once` and never opens a card | **DELETE** | Private auto-reply/idle signals duplicate the actual HTTP once reply, card visibility, and Stop/late-abort outcomes retained in session.test.ts. |
| 534: 04: reject maps to decline and always maps to acceptForSession | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 547: 05: a question opens with normalised ids and resolves with the chosen label | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 566: 05: a rejected question resolves with no answers | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 577: 06: an abort arrives as MessageAbortedError, the Stop's own answer on the stream — never surfaced as an error | **DELETE** | Private auto-reply/idle signals duplicate the actual HTTP once reply, card visibility, and Stop/late-abort outcomes retained in session.test.ts. |
| 615: 07: todos become a plan, and `field:"text"` deltas on a reasoning part stream as reasoning | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 634: 08: an `agent: "plan"` turn emits no proposal event of any kind | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 644: 09: session.compacted becomes thread.state.changed {compacted} | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 656: 10: the premature-idle race shows up as an idle signal, never as a completed turn | **DELETE** | Checks private signal shape, while session premature-idle regression verifies actual completion. |
| 664: 11: command.executed becomes a completed activity row | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 673: 12: a co-tenant session's frames are dropped, not mixed into this thread | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 834: 12: every emitted event belongs to this thread | **DELETE** | Thread ID stamping is already required by retained co-tenant filtering and child attribution cases. |
| 842: 12: a child session is a roster task: one start, one end, then the run's result | **REWRITE** | Include the initiating call ID in the existing child lifecycle test and remove the duplicate test. |
| 868: 12: the child's first task.started names the call that launched it | **DELETE** | Merged the launch-call assertion into the existing child lifecycle contract. |
| 878: 12: every task row repeats the whole linkage, and never stamps agentKind | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 899: 12: the parent's `task` tool part supplies the role, the model and the tool call | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 914: 12: the child's own tool work reaches the roster as progress | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 928: 12: the child's own steps are its roster usage, and never the parent's meter | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 945: 12: a child's items and text are stamped with agentId; the parent's are not | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 971: 12: the parent's own `task` row still renders as a collab-agent call | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 984: 12: a child seen during a live turn marks the turn as having subagents | **REWRITE** | Observe hasSubagents on the emitted usage payload conversion instead of accumulator/map internals. |
| 1012: 12: a child's step-finish tokens never reach the PARENT turn's accumulator | **REWRITE** | Assert the caller-facing usage summary for child-only steps; remove private accumulator set-size assertions. |
| 1053: a live child is closed `stopped` when the session goes down (§3.1) | **DELETE** | Session shutdown regression verifies real task.stopped before session.exited. |
| 1090: a `task_id` resume of a settled child launches it again, and its own idle settles it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1150: after a relaunch, a stale part of the previous call is neither a run nor its end | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1165: a second call on a LIVE child is not a relaunch, and its end does not settle it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1187: once a relaunched run settled, a late frame of ANY earlier call is stale | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1208: a child's title change is a progress row; a re-stated title is not (observation 19) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1225: a relaunched child is closed `stopped` when the session goes down (§3.1) | **DELETE** | Session second-Stop/relaunched-child regression checks the actual operation and task events. |
| 1237: a task part answered in the background does not settle the child it launched | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1284: 12 end to end: the child's roster row ends with its task part's output as its result | **DELETE** | Lower replay lifecycle checks result ownership; generic task folding owns roster projection. |
| 1294: a run gets its result once: the same part again adds nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1299: a resumed run's result is its own; a late part of the first call adds nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1331: a part that errors after the child's idle gives the run its error, ending nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1348: a result is the text inside the task tool's envelope; other output stands as it is | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1372: a part that settles BEFORE the child's idle ends the run itself, with its result | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1401: no result after a run the child's own session.error ended | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1434: a child an abort cancels ends stopped, never failed, when its own abort error or its call's cleanup beats the adapter's close — a grandchild too | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1505: no result after a run the host stopped | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1579: a background run's answer, injected into the parent, becomes its result, once | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 1615: a background run's answer injected while a Stop's leftovers are still dropped is its result all the same | **DELETE** | Session Stop-leftovers and surviving-child regressions cover this through the operation boundary. |
| 1632: a child relaunched on the server's word still takes its own call's answer: the parent's part ends the reopened run, naming its new launch | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1678: after an adapter relaunch, a provider relaunch names its own new call | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1703: a child no task part names still starts under a launch id of its own: `opencode-child:<session>` | **DELETE** | The longer child-frames-before-launch-part case covers fallback launch and later linkage; unnamed-child resume also covers fallback identity. |
| 1719: a child whose own frames beat its launching part names the provider's call on every row once the part is read, and a relaunch still reopens it | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1795: a child no part ever named, resumed by a `task_id` call once settled, is relaunched: a start naming the call, running, then completed with its answer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1833: a `task_id` call on a child no part named is no launch of its run: while it works, and never adopted as its call | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1853: a revival whose run started with no launch id seeds one first, so the roster reopens: running, then completed — the defensive branch | **DELETE** | Explicitly unreachable defensive state, manufactured by deleting private state; no production input reaches it. |
| 1910: a background answer that arrives before the child's idle rides the run's own end | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1926: an injected envelope naming no child of this thread, or not synthetic, is no result | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1943: a previous background run's late answer never becomes a relaunched run's result | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1973: a background run takes no answer written for another run's task | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2075: a background answer wakes the parent: its reply opens a turn named by the injected prompt, and every row rides it | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2115: a reply the host asked for, a compaction's summary, or a message that already ended opens no turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2150: a woken run that compacts first runs as one turn from its summary on, the summary off the meter | **DELETE** | Session-level compaction-before-reply regression checks the real turn completion and usage instead of private flags. |
| 2192: a reply with no `busy` since the parent's last idle — no run behind it — opens no turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2221: no capture opens a turn of its own: every reply in them answers a prompt the host sent, or is a compaction | **DELETE** | The harness preclaims every prompt; direct host-owned/ended-reply negative and session compaction tests already own the contract. |
| 2231: while a turn runs, a reply to a prompt the server wrote belongs to it, and its steps count as the turn's | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2251: a second answer that arrives while the woken reply runs joins its turn | **DELETE** | Session second-background-answer test owns one-turn/one-completion behavior. |
| 2277: output that follows an interruption opens nothing, a woken reply's included | **DELETE** | Session Stop plus late-frame tests own suppression through the actual operation. |
| 2287: a request after an interruption waits for the server's word on its asker: no card, one signal; a repeat adds nothing, an answer meanwhile no row | **DELETE** | Private signal assertion; session held-request races verify card/reply outcomes. |
| 2391: 03: a running bash part streams what it printed, on its call, in its turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2407: running bash parts yield chunks whose concatenation is the final output | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2442: 12: a subagent's running bash streams under the subagent, like the call's rows | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2460: a resumed subagent's growing bash output streams under it, every chunk once | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2492: 12 through the host: the chunks are the child call's output, joined and closed | **DELETE** | Captured child command chunks remain tested; generic output integration owns joins and closing buffers. |
| 2516: a tool that is not a command streams nothing from its metadata | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2527: a tail window re-bases on what it keeps, and never repeats a character | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2552: a window that keeps nothing already shown is shown whole, its head marking the gap | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2574: a value that rewinds adds nothing, and the output goes on from the most shown | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2593: a value of no known shape shares nothing provable: it re-bases and adds nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2611: a repeating output that slides into itself loses the repeat, never shows it twice | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2665: a timeout's note reaches the stream, before the completion closes it | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2692: an abort's note reaches the stream too | **DELETE** | Timeout-note test exercises the identical arbitrary suffix preservation contract; abort lifecycle separately covered in session. |
| 2710: a completion that extends the last running value adds what the frames missed | **DELETE** | The cut-final-output case includes the same uncut-final-output extension vector. |
| 2732: a windowed output killed at the timeout: its note reaches the joined output | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2776: a cut final output closes the stream with where the whole output was saved | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2823: a completion whose final output the tool cut is stored marked cut; any other is not | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2896: a command's completion the generic truncation cut — the head kept, its note at the end — is stored marked cut too | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2933: a final output that neither extends the stream nor holds its end adds nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2966: a command that printed nothing, or failed, adds nothing at its end | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 2993: a co-tenant session that is NOT a child of this thread is still dropped | **DELETE** | Retained fixture-12 mixed co-tenant replay tests actual filtering; this checks only session.created and a private child map. |
| 3018: 13: three session.error frames for one bad model collapse to one runtime.error | **REWRITE** | Assert account-reason absence alongside the mandatory positive errors, rather than a separate vacuous loop. |
| 3032: 13: a session.error settles the turn through a signal | **DELETE** | Session asynchronous-error and woken-error cases verify turn failure; this observes a private signal only. |
| 3037: 13: the recorded errors name no account failure | **DELETE** | Merged account-reason absence into the positive error test that requires the two actual errors, removing vacuous-loop success. |
| 3044: an account failure on session.error carries a structured reason (workflows §5.4) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3095: 03: every owned step-finish reports the window it carried | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3117: 03: a model the catalogue never described degrades to a bare count | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3126: 01: the committed /provider capture yields the meter's denominators | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3146: 12: a child session's step-finish tokens never reach the parent's meter | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3174: 12: the child's start carries the prompt its launching `task` part gave it; no other task row does | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3185: a `task_id` resume's start carries the resume's own prompt, never the first launch's | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3195: a grandchild's start carries the prompt its parent child's `task` part gave it | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3231: a start no part named yet carries no prompt, and neither does a revive of a run that already had one | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 31: with no projectPath, the key falls back to the thread's cwd | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 37: the key is RESOLVED, because the server never validates a directory | **REWRITE** | Use literal canonical project path, not a second call to production as the oracle. |
| 48: a blank or non-string projectPath is ignored, not trusted | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 68: a non-system account home is REFUSED, never silently dropped | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

### `prompt-closed-text.replay.test.ts`

Path: `apps/daemon/src/agent-host/adapters/opencode/prompt-closed-text.replay.test.ts`.

1. Independent contract: Captured closing text snapshot and prompt ownership; GUI design §4.2 streaming completion.
2. Observable failure: each retained row names the missing, duplicated, misattributed, incorrectly authorized, or incorrectly settled caller outcome it detects.
3. Independent oracle: expected wire data, fixture payloads, explicit security decisions, event ordering/status, and OS process outcomes are fixed independently of the owner. Rewrites remove self-derived comparisons.
4. Stable seam and non-test callers: Owned provider text frames → complete streamed assistant text. Production: normalizer/session ingestion.
5. Refactor tolerance: retained cases observe protocol records/events/operation results, not private method calls, source text, import inventories, or structural snapshots. Rewrites remove selected private bookkeeping assertions.
6. Lowest owner: this file owns its adapter conversion, parser, lifecycle, or protocol operation. Generic host/UI tests do not exercise these provider frames; redundant adapter-to-generic replays are deleted as identified below. Distinct race cases retain their independently differing settlement/request outcomes.

Risk: low for deletes (duplicate or non-contract assertions); medium for protocol/race regressions, retained and validated through the focused suite. Validation: `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/adapters/opencode/*.test.ts`.

| Original line / test (failure input and outcome) | Disposition | Reason / remaining stronger coverage |
| --- | --- | --- |
| 72: fixture 05: commentary closed by the question ask folds to its text exactly once | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 333: a busy server is deferred, recycled once when its turn ends, and not again on later idles | **REWRITE** | Use the public adapter factory and actual child close event to prove defer-while-busy and recycle-after-completion. Drop the later-idle negative that depended on the private scheduler drain. |
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
| 37: §4.3: every decision maps to the reply the OpenCode column names | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 50: §4.3: a reply that arrives from elsewhere maps back to a decision | **DELETE** | Captured permission reply cases in normalize.replay assert once/always/reject outcomes at the request-event boundary. |
| 56: §4.3: `Allow for workspace` warns, and names the pattern it widens | **DELETE** | Captured permission-card test already verifies the actual widened pattern and directory-wide security warning. |
| 70: §4.3: the card falls back to the default four when the ask names no patterns | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 85: §4.3: a permission maps to a canonical request type | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 94: a bash ask shows its command; anything else shows the permission name | **DELETE** | Bash permission data is asserted on the captured request card; other-label prettification is implementation copy, not a specified contract. |
| 119: §4.4 full access: `*`→allow plus an explicit external_directory allow | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 127: §4.4 supervised: `*`→ask, reads allow except `.env` | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 137: §4.4 accept edits: the SAME list, with `edit`→allow | **REWRITE** | Assert independent allowed-edit and sensitive-read/shell approval rules; remove same-implementation list/position comparisons. |
| 153: §4.4 auto: falls back to Supervised, by deliberate choice and not by omission | **REWRITE** | Assert explicit supervised security decisions rather than comparing two calls to production. |
| 160: §4.4: the read-only and always-allowed tools are exactly the documented set | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 181: §4.6.3: a real command list keeps `/compact` first and drops skill-sourced rows | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 195: R2-11: a not-installed snapshot advertises no `/effort` either | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 62: the scrape ignores a line that merely mentions the phrase | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 70: a healthy peer is adopted, and the URL comes off stdout | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 87: recycle (agent profile §4.8) stops only an unheld server, and the next start waits for the old child to be gone | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 113: `/global/health` is reached WITH the credential, as the real server demands | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 139: a server below the minimum is REFUSED with the required version in the message | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 157: an unhealthy server is refused rather than adopted | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 170: a peer that dies before printing a ready line fails with its stderr excerpt | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 188: a bad binary fails the acquire instead of hanging | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 206: a host abort cancels acquisition of a silent peer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 238: threads of one project share one server, ref-counted, closed after the last release | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 268: a re-acquire inside the idle window cancels the close | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 303: §3.2: two threads in ONE project share one server, keyed by projectPath | **DELETE** | Manually composing projectDirFor and pool.acquire does not test adapter project wiring; project-key normalization and pool sharing tests own both contracts. |
| 350: two projects get two servers | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 381: concurrent acquires for one project collapse onto a single start | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 412: a dead server is not reported as live by pool.list() | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 444: the startup buffer is trimmed on a LINE boundary | **REWRITE** | Assert readiness bytes survive truncation and truncation cannot promote a phrase inside a warning into a readiness line. Remove line-layout assertions and the alternative-algorithm demonstration. |
| 474: a second stopAll waits for the first's kills: the host's two teardown calls both return only once the servers are gone | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
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
| 543: a fresh session is created WITH the ruleset in the create body | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 561: resume in the same directory reuses the session and RE-ASSERTS the ruleset | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 576: resume against a confirmed 404 falls through to a fresh session | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 586: resume against a 500 PROPAGATES — a blip must never reset a live thread | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 601: the host's §6.1 create-time cursor resumes, byte for byte | **DELETE** | Host cursor construction belongs to the generic resume owner; previous session resume test already sends this literal provider cursor. |
| 625: a cursor carrying unknown extra fields still resumes | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 643: a cursor of the wrong shape means `no resume`, never an error | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 653: a cwd change forks rather than minting an empty session | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 672: a turn submits prompt_async with a minted id, the system addendum and the variant | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 718: an xlsx rides as a path line in the text part; a csv is still a native file part (§4.5) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 753: an attachment-only turn with a non-native file no longer throws: the block is the text | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 771: a text file over the native cap rides as a path line, not a file part (§4.5) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 797: a non-native file whose path the text already names adds no block: the text is verbatim | **DELETE** | Shared attachment-lines tests own path deduplication; retained native/non-native send and command tests own the adapter wire integration. |
| 822: an attachment whose path cannot be resolved fails the turn instead of vanishing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 843: plan mode rides the `agent` field, per turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 858: a turn completes on idle, with accumulated usage and cost | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 894: the premature-idle race still completes the turn (machine 3) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 930: a second sendTurn during a live turn STEERS: same turn id, one turn.started | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 959: a refused submit settles the turn as failed rather than leaving it running | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 983: a name in `command.list` is dispatched through session.command | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1022: a name that is NOT in `command.list` falls through to an ordinary prompt | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1041: a native command with a non-native file carries the path block in its arguments (§4.5) | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1094: an approval reply reaches `POST /permission/{id}/reply`, never the SDK trap route | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1130: interrupt SETTLES every open request before the abort reaches the provider | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1161: interrupt emits turn.aborted, not turn.completed | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1181: interrupt is turn-scoped: a Stop on a settled turn cannot kill the next one | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1196: a question is answered on its reply route and dismissed on its reject route | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1246: compaction is REFUSED while a turn runs — the server has no such backstop | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1261: compaction on an idle session posts summarize with auto:false | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1275: rollback forks, verifies the boundary count, re-applies the ruleset and re-points | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1307: rollback refuses when the fork did not preserve the boundary | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1336: rollback by turn ID forks at the NAMED turn's prompt, wherever the count points | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1362: a live turn is named by the prompt that opened it, so a rewind finds it again | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1405: rollback refuses a turn ID the session no longer holds, before forking anything | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1432: a second rewind finds a turn the first one kept, under the fork's re-minted ids | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1481: a dead server settles the turn and the requests BEFORE session.exited | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1517: a host-initiated stop settles the turn as interrupted and exits gracefully | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1540: a live subagent is closed `stopped` before session.exited | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1570: a child session's question rides no turn, and so does its answer; the parent's own ride its turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1619: interrupting a turn closes its subagents too | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1641: §6.2: an interrupt with NO active turn still stops all background work | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1688: §6.2: a session-scoped interrupt with nothing live is a clean no-op | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1699: stop is idempotent and emits exactly one session.exited | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1761: a background answer wakes the parent: its reply runs as a turn named by the injected prompt, and the run's idle settles it | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1793: a session.error during the woken reply fails its turn, as it fails any | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1809: the user's message during the woken reply steers it: one turn, which the run's idle ends | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1842: a second answer that arrives while the woken reply runs joins its turn: one turn, one completion | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1863: a Stop during the woken reply aborts its turn, and what the aborted run still sends opens nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 1885: a Stop's leftovers end once a later turn fails: a background answer after it still wakes the parent into a turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2077: a rewind ends a relaunched child the fork leaves behind: aborted, its call and then its run closed, and nothing of it comes back | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2157: a rewind closes a left-behind child's calls on the turns it keeps only: a call whose rows ride a removed turn goes with them, and leaves no lone closer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2221: a rewind ends a background child still running between turns: aborted, closed, and the drain released | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2277: a child whose abort frames beat the Stop's own close ends stopped — its own abort error, or its call's cleanup — never failed | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2326: a background child outlives its launching turn's failure — running in the roster and in liveness — and ends by its own idle and answer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2375: a foreground child of a failed turn is still closed stopped | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2387: a Stop closes every child — a background one too: the abort cancels its job | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2471: a child that survives the Stop is relaunched on the server's word: the roster reads it running, then completed with its own answer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2535: a second Stop closes a relaunched child, and a confirmed report relaunches it again under its next id | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2568: a NESTED subagent that survives the Stop is relaunched too: its first start names its call, and it reads running, then completed with its own answer | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2620: after a failed admission a relaunched child holds the drain, but reads interrupted: that session reads error, which the roster takes for dead | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2648: a child the Stop ended sends its leftovers: the server says it runs nothing, and it stays ended | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2691: a child the Stop closed that reports while the server cannot say counts live again: the drain outranks a duplicate row | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2703: a report from a child the Stop closed, arriving while a later Stop is under way, is judged after that Stop: its abort may end the child | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2738: a Stop that begins and ends while the server is asked about a child makes that answer stale: it asks again, and does not relaunch a child it ended | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2770: a child whose own idle arrives while the server is asked about it is not revived: that report was its last | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2797: the session stopping during the woken reply settles its turn before session.exited | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2808: the host's own /compact runs no turn: its summary streams while summarize runs, and opens nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2842: a woken run that compacts first runs as one turn from its summary on, which the run's idle settles | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2886: a rewind's fork is the past: its copied messages, delivered late, open no turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 2922: end to end: through the host's real ingestion and fold, the woken reply reads as a running turn, then a settled one | **DELETE** | Provider woken-turn lifecycle is already asserted directly in this suite; generic ingestion/fold tests own running and settled projection. |
| 3057: after a Stop, a background answer's run is a new run: its reply is written on its own woken turn, the stopped run's late frames still dropped | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3096: after a Stop, a new run whose busy arrives before the abort answers still gets its woken turn once the abort is over | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3139: while a Stop is under way, a run the abort then cancels says busy after an idle: its reply opens no turn, before the abort answers or after | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3180: when the stream wins the race and the boundary is crossed early, the cancelled run's own abort error is an echo: no failure, no error | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3230: the echo is expected only until the parent's next idle, in either spelling: after a real new run, an abort error nobody here sent is reported | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3260: a host turn sent after a Stop is no abort's victim: an abort error mid-turn fails it, whichever of its busy and its prompt's answer comes first | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3319: an abort error that may still be the Stop's echo fails no host turn: before the stopped run's idle came, or before the turn's prompt was taken | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3387: after a Stop whose abort request failed, an abort error before the run's idle is still the Stop's echo: it fails nothing, and the idle then ends the turn as the Stop would have | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3417: a Stop whose abort request failed: the stream's or the server's word that the run ended settles the turn as the abort would have — two idle frames or a lone one, before the failure or after it, or a reconnect's status poll; without that word, the next Stop asks the server again — and the next run is a new one | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3539: a steer after a failed Stop takes the turn back: the run's own end completes it, and the background work it started runs on | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3626: the end of a Stop whose abort request failed closes the children, then aborts them: a child's report in between asks the server only once that abort is over, so a child it ends is never relaunched — the run's idle or a reconnect's status poll | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3670: the end of a Stop whose abort request failed: a request from a child that end is aborting is judged after that abort — an ask it ends gets no card | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3698: a child's report the server is being asked about when a failed Stop's run ends is asked about again once that end's abort is over: the answer from before it is stale | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3764: after a Stop, a busy from before the stopped run's idle ends nothing: a reply to an unclaimed prompt after it still opens no turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3815: a reconnect clears a stale busy: a reply the host never started, after the gap, opens no turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3835: a reconnect keeps what a live run says after it: a busy after the gap still opens the woken turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3892: after a Stop, a question from a child the abort never reached is shown on no turn, and its answer reaches the server | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3918: after a Stop, a live asker's approval is shown — on the turn running then, none here — and answered on its reply route | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3936: after a Stop, a request whose asker the abort ended is rejected on the wire and writes no card — nor a row when it closes | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3963: after a Stop, a request answered elsewhere while the server is asked about it is dropped: no card, no row, nothing sent | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 3995: after a Stop, an older server's orphan — still listed, its session idle — is rejected too, and shown nowhere | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4009: a request that arrives while the Stop's abort is in flight is judged after it: an asker the abort ended gets no card on the stopped turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4044: a request that arrives once the next turn is sent, before its run says busy, is judged too: the stopped run's leftover is no card on the new turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4058: an ask that arrives while the Stop withdraws the parked cards is held too: judged after the abort, no card on the stopped turn | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4103: after a prompt admission fails and aborts the session, a request is judged as after a Stop: the aborted run's is rejected, a live asker's shown | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4129: a Stop that begins and ends while the server is asked about a held request makes that answer stale: it asks again | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4164: after a Stop, a request the server cannot say anything about is shown: the user answers it, never a reject on their behalf | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4178: full access: a live asker's request after a Stop is answered once, as any; a reply the server refuses shows the card once | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4202: full access: an automatic reply the server refuses falls back to the card while a turn runs | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4221: a model slug splits on the FIRST slash, so a nested model id survives | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4232: answers are keyed by question id, header or text, in that order | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4323: Q1 #21: a co-tenant thread's ask is probed ONCE, not polled forever | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4351: Q1 #21: an unreadable session is retried, but the chain is CAPPED | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 4377: Q1 #21: closing the thread abandons an in-flight ancestry chain | **REWRITE** | Keep the named observable protocol outcome; remove ancillary private child/output bookkeeping or exact backoff-delay assertions. |
| 4459: a stop withdraws every parked card, once each | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4467: an interrupt withdraws every parked card, once each | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4477: a dead server withdraws every parked card once, before session.exited | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 4491: the user's own answers are never withdrawn — and the server's echo adds no row | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
| 106: E9: a COLD probe waits for the server to report ready, then reads the catalogue | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 136: E9: the second probe is warm — the start cost is paid once per project | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
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
| 23: one frame per blank line, in order | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 31: a frame split across chunk boundaries is reassembled | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 40: multi-line data is joined with newlines, per the SSE spec | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 45: `:`-comment keep-alives produce no frame and do not break the next one | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 53: CRLF line endings decode the same as LF | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 59: `event` and `id` are carried, then reset for the next frame | **DELETE** | No OpenCode caller consumes these fields. This asserts metadata handling rather than an observable adapter failure. |
| 67: one leading space after the colon is stripped, further ones are data | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 72: a field with no colon, and unknown fields, are ignored | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 80: a blank line with no data emits nothing | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 84: an unterminated trailing frame is NOT emitted until its blank line | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 93: a BOM is stripped once, at the start of the STREAM | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 109: a BOM mid-stream is preserved verbatim in the data | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 143: readSseFrames yields every frame and ends at EOF | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 152: readSseFrames CANCELS the body when the consumer breaks out | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 163: readSseFrames cancels the body when the consumer throws | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |
| 178: readSseFrames does NOT cancel after a clean EOF | **DELETE** | A closed ReadableStream does not call its cancel callback even if cancel() is invoked, so this negative passes for the wrong reason. |
| 186: readSseFrames on a null body ends immediately | **KEEP** | Retains the independent protocol/regression outcome described by this case; no stronger remaining test covers this input condition at this owner. |

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
- Removed `index.ts`'s concrete `OpenCodeAdapterImpl` export, `recycleSettled()` test drain, and `recycleWork` promise bookkeeping. No production caller used these. Recycle tests now construct through `createOpenCodeAdapter` and observe the real child's `close` event; spawn interception delegates unchanged to Node, is restored after each case, and implements none of the behavior asserted.
- Removed unused replay helpers `firstOfType` and `sseTypes`, unused `ABORT_NOTE` and `WHOLE_FORK` constants, and unused imports.
- Removed `testing/host.ts`'s unused `loggedActivities` helper and `startIso` option; made its local result interface private. Removed the unused exported timestamp alias in `testing/woken.ts` and made its local reply type private.
- Provider NDJSON fixtures remain consumed by retained replay/history tests and the shared redaction scanner. Shared `inferAuth` is preserved for its production caller and shared adapter auth-status coverage. Shared host/woken harnesses still have retained consumers.

Production behavior is unchanged. No provider protocol, permission/security rule, persisted cursor format, process lifecycle operation or runtime event was altered. Removing the unused promise set does not change the deferred recycle chain or its error handling.

## Validation and final diff

- Baseline: all 303 original OpenCode tests passed (`/tmp/opencode-cleanup-baseline.log`).
- Initial cleanup: all 263 then-retained tests passed; daemon package typecheck passed.
- After two additional signal-only duplicate deletions and the startup-protocol rewrite: all 95 normalizer/server cases passed (`/tmp/opencode-cleanup-refinement.log`).
- After replacing the production recycle drain: all 6 recycle cases passed (`/tmp/opencode-cleanup-recycle.log`).
- Final complete OpenCode suite: **261/261 passed**, zero failures/skips (`/tmp/opencode-cleanup-final.log`, 33.97 s).
- Final daemon typecheck reported only concurrent out-of-scope Codex errors: `adapters/codex/replay.test.ts:400,402` missing `RuntimeEvent`; parent notified. Earlier daemon typecheck passed. No OpenCode diagnostic was reported.
- AST unused-import/local/function scan across all OpenCode tests and support: clean. Global reference search confirmed removed support exports had no other consumer.
- `git diff --check` for this scope: passed. Final diff reviewed; net **1,224 source/test/support lines removed** (108 added, 1,332 deleted), excluding this report.
- No coverage or test-count gate conflict was found. Root agent owns repository-wide gates, commit, remote merge and push.
