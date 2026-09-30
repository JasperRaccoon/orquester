# Scope 13: checkpoint, index and thread-store cleanup

Completed-cleanup ledger, prepared before test edits. Every original declaration is listed below, including template declarations. No production behavior changes were made. The baseline command was started before editing.

## Full retention bar shared by each named KEEP / REWRITE

1. **Independent requirement:** the source listed for the file group specifies the named case's behavior; persisted format, protocol, security and documented recovery rules are requirements. Existing comments were checked against current source and those contracts, not treated as evidence by themselves.
2. **Visible failure:** each case's oracle below names the incorrect file, bytes, search/history result, resume state, error or process outcome a caller/user would observe.
3. **Independent oracle:** expected literals, deliberately planted disk corruption, file modes, actual Git state, independent newline scanning and hand-authored event order can disagree with the owner. Production reducers/serializers used to construct valid inputs are not the expected result for their own behavior; snapshot serialization parity belongs to the API suite, and the retained store round-trip instead exercises actual cross-instance persistence.
4. **Stable seam:** the entrypoints and non-test callers are listed per group. File/Git/SQLite artifacts and documented returned records are stable storage/protocol boundaries. Fault injection changes actual OS I/O success/failure; no mock supplies the expected resulting state.
5. **Refactor tolerance:** retained checks constrain returned data and durable effects, never private method counts, calls, class names, or temporary-index filenames. The rewrite cases remove the latter where present. Schema corruption fixtures intentionally retain the historical persisted layout they simulate.
6. **Lowest distinct owner:** pure protocol/format rules remain at parser/merger seams; disk recovery remains at the store/index/service interface. Orchestration tests are retained only for ordering/failure-isolation across the provider boundary. Higher history/UI/fold tests do not verify real persisted byte positions, Git state, database transactions or read failures. Per-case distinct failure/oracle below is the reason no remaining test is a stronger owner of that scenario; explicit duplicates are DELETE.

Risk: retained storage/security failures are high consequence, so no catch-up, append integrity, malformed-log, cursor, isolation, or redaction contract is removed. Pruned cases are redundant or assert private implementation artifacts. Each REWRITE retains its listed independently sourced outcome and uses the same public/durable seam, oracle independence, refactor tolerance and distinct ownership rules above.

Validation for every row: from repository root, `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test --test-concurrency=2 <the file path>`; the focused scope run supplies all sixteen files. Root integration owns `pnpm check` and `pnpm test`.

## `apps/daemon/src/agent-host/checkpoints/baseline-dispatch.test.ts`

Checkpoint contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 5.4, 5.5; Those sections specify turn-order numbering and preservation of user Git state; AGENTS.md also requires append-only durable ordering and rebuildable caches.

`CheckpointService` is consumed by `orchestration/orchestrator.ts`; service.ts calls git.ts, capture.ts, refs.ts and numstat.ts. The dispatch tests alone own ordering against provider startup. Real Git state/ref bytes are independent oracles; the fake executable in git.test.ts is an OS peer, not an implementation of retry/timeout logic.

- **KEEP** `R5 #6: the pre-turn baseline is captured before the provider is asked` — The real checkpoint tree contains the pre-start file, reports the provider startup edit, and steering publishes no unfinished ref; detects capturing after provider startup.
- **KEEP** `R5 #6: a baseline failure never blocks the turn` — A thrown Git capture leaves the public turn command delivered to the provider; detects diagnostic failure blocking user work.

## `apps/daemon/src/agent-host/checkpoints/git.test.ts`

Checkpoint contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 5.4, 5.5; Those sections specify turn-order numbering and preservation of user Git state; AGENTS.md also requires append-only durable ordering and rebuildable caches.

`CheckpointService` is consumed by `orchestration/orchestrator.ts`; service.ts calls git.ts, capture.ts, refs.ts and numstat.ts. The dispatch tests alone own ordering against provider startup. Real Git state/ref bytes are independent oracles; the fake executable in git.test.ts is an OS peer, not an implementation of retry/timeout logic.

- **KEEP** `the child env is exactly what was configured, plus the runner's defaults` — Child output contains configured HOME and index override, omits the ambient canary and explicitly removed LC_ALL, and disables prompts; detects secret inheritance or hanging Git authentication.
- **KEEP** `a non-zero exit throws unless the caller allows it` — Exit 3 rejects as GitExitError unless allowed, in which case stderr and exit status survive; detects swallowed process failures.
- **KEEP** `a hung child is killed at the deadline` — A genuinely running child rejects with GitTimeoutError at its deadline; detects a hung checkpoint child blocking its caller.
- **KEEP** `output over the cap truncates, or fails when the answer must be whole` — Oversized output is bounded and marked, while whole-answer mode rejects; detects silently incomplete diffs or unbounded output.
- **KEEP** `a transient lock failure is retried, and only when the caller asked` — A real child failing twice recovers on attempt three only when requested; permanent lock failure still rejects; detects absent or unbounded retries.
- **KEEP** `stdin reaches the child byte for byte` — A real child's hex stdout matches independently encoded NUL-bearing stdin bytes; detects corruption of update-ref batch input.
- **KEEP** `R5 #13: a streaming scanner is never replayed by the retry` — A child emits one NUL record and exits transiently; scanner receives one record and counter is one; detects replaying a stateful stream on retry.
- **KEEP** `Q1 #44: an already-aborted signal never spawns a process` — An already-aborted request leaves no trace file and rejects with GitAbortedError; detects spawning work after its budget expired.
- **KEEP** `Q1 #44: an abort mid-run kills the child and reports the abort` — Abort after the child's ready output settles GitAbortedError even with allowed nonzero exits; detects ignoring live cancellation.
- **KEEP** `only real lock/ENOENT noise is classified as transient` — Actual lock/ENOENT stderr is retryable while pathspec failure is not; detects retrying semantic failures or missing transient recovery.

## `apps/daemon/src/agent-host/checkpoints/numstat.test.ts`

Checkpoint contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 5.4, 5.5; Those sections specify turn-order numbering and preservation of user Git state; AGENTS.md also requires append-only durable ordering and rebuildable caches.

`CheckpointService` is consumed by `orchestration/orchestrator.ts`; service.ts calls git.ts, capture.ts, refs.ts and numstat.ts. The dispatch tests alone own ordering against provider startup. Real Git state/ref bytes are independent oracles; the fake executable in git.test.ts is an OS peer, not an implementation of retry/timeout logic.

- **KEEP** `a rename spends two extra records on the source and the destination` — Literal Git -z rename records produce destination new/name.ts and independent counts, followed by other.ts; detects consuming rename records as ordinary paths.
- **KEEP** `a binary file reports zero counts rather than being dropped` — Literal binary numstat produces assets/logo.png with zero numeric counts; detects hiding changed binary files.
- **KEEP** `empty and malformed output yields no files` — Empty/malformed numstat yields no invented file; detects malformed Git output becoming a bogus diff entry.
- **KEEP** `a path containing a newline survives, because records are NUL-delimited` — A literal newline in a NUL-delimited filename survives; detects line-based parsing that splits valid Git paths.

## `apps/daemon/src/agent-host/checkpoints/refs.test.ts`

Checkpoint contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 5.4, 5.5; Those sections specify turn-order numbering and preservation of user Git state; AGENTS.md also requires append-only durable ordering and rebuildable caches.

`CheckpointService` is consumed by `orchestration/orchestrator.ts`; service.ts calls git.ts, capture.ts, refs.ts and numstat.ts. The dispatch tests alone own ordering against provider startup. Real Git state/ref bytes are independent oracles; the fake executable in git.test.ts is an OS peer, not an implementation of retry/timeout logic.

- **KEEP** `a checkpoint ref is the thread's base64url namespace plus its turn` — The persisted ref byte string for thread-1/7 is refs/orquester/checkpoints/dGhyZWFkLTE/turn/7; detects breaking existing checkpoint namespace compatibility.
- **KEEP** `the namespace stays inside git's safe ref alphabet for an awkward thread id` — An awkward thread id encodes to Git-safe alphabet and decodes losslessly; detects invalid refs or collisions from sanitization.
- **KEEP** `an empty thread id or a bad turn count is refused rather than encoded` — Empty identity and negative/fractional counts throw TypeError; detects constructing unsafe or unusable checkpoint references.
- **KEEP** `turn counts round-trip, and nothing else is read as a checkpoint` — Only canonical nonnegative turn suffixes in the owning thread namespace parse; detects pruning a foreign, padded, negative, or unrelated ref.

## `apps/daemon/src/agent-host/checkpoints/service.test.ts`

Checkpoint contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 5.4, 5.5; Those sections specify turn-order numbering and preservation of user Git state; AGENTS.md also requires append-only durable ordering and rebuildable caches.

`CheckpointService` is consumed by `orchestration/orchestrator.ts`; service.ts calls git.ts, capture.ts, refs.ts and numstat.ts. The dispatch tests alone own ordering against provider startup. Real Git state/ref bytes are independent oracles; the fake executable in git.test.ts is an OS peer, not an implementation of retry/timeout logic.

- **KEEP** `captures tracked, staged and untracked files and never an ignored one` — Real Git tree paths are exactly tracked, staged, untracked and .gitignore, excluding ignored.log; detects incomplete or overbroad captures.
- **KEEP** `the user's index, HEAD, refs, stash and reflog are byte-identical afterwards` — Independent before/after Git index digest, HEAD, stash, status and reflog remain identical; only hidden checkpoint refs appear; detects damage to user Git state.
- **KEEP** `turn end diffs against the baseline and reports the changed files` — Changed-file list contains created/tracked/deleted files and handwritten +2/-0 and +0/-1 counts; detects comparing the wrong trees.
- **KEEP** `a missing baseline keeps the post ref and records an empty file list` — Without a baseline the completion ref exists with empty summary; detects losing future capture continuity or inventing a baseline.
- **KEEP** `a placeholder checkpoint is reused at its own turn count` — A missing placeholder keeps its count and assistant id, with the actual tracked-file diff; detects incrementing beyond the placeholder.
- **KEEP** `a turn that already has a real checkpoint is skipped` — An existing ready checkpoint returns null and creates no new completion ref; detects duplicate durable checkpoints after recovery.
- **KEEP** `only the session's active turn produces a completion checkpoint` — A stale active-turn id is rejected while the live id captures; detects attributing one turn's edits to another.
- **KEEP** `readTurnDiff: equal turns short-circuit without touching git` — Equal counts return an empty diff even for a nonexistent cwd; detects unnecessary Git dependency on an identity diff.
- **KEEP** `readTurnDiff ignores whitespace by default and can be told not to` — Whitespace-only edits vanish by default but appear in exact mode; detects ignoring the caller's whitespace policy.
- **KEEP** `readTurnDiff refuses a turn above the thread's highest checkpoint` — A request above the highest count rejects with requested=4, available=0; detects treating missing future checkpoints as empty diffs.
- **KEEP** `captures prune to the 200-ref cap, oldest first` — After planting 200 refs, capture removes only turn/0 and retains turn/1 and turn/200; detects wrong cap or eviction order.
- **KEEP** `pruneAbove deletes every ref above the target and nothing else` — Prune keeps only target/smaller refs, another thread, and main; detects deleting retained or unrelated refs.
- **KEEP** `deleteThreadRefs removes every ref under the thread's prefix and nothing else` — Thread deletion removes even stray refs under its own prefix while preserving other thread and main; detects leaking refs or collateral deletion.
- **KEEP** `a non-git directory is a silent no-op on every path` — Plain/missing directories skip captures and cleanup, while a nonempty diff request rejects range; detects non-Git projects failing turns.
- **KEEP** `an untracked embedded repository does not break capture` — An uncommitted nested repository is excluded while tracked.txt is captured; detects Git add failure disabling checkpoints.
- **KEEP** `a cone sparse checkout captures skipped files instead of deleting them` — A real cone sparse checkout preserves skipped/b.txt in its tree; detects false deletions of sparse files.
- **REWRITE** `concurrent captures on two threads of one repo do not corrupt each other` — Concurrent captures produce independent complete trees for both threads; detects cross-thread index corruption. Remove the private temporary-index filename assertion.
- **KEEP** `a repository with no commits at all still captures a baseline` — An unborn repository captures first.txt without creating a user branch; detects requiring HEAD or changing user history.
- **KEEP** `a capture failure is reported, never thrown into the turn` — An unwritable real Git directory returns error captures with detail and no files instead of throwing; detects checkpoint failure aborting a turn.
- **KEEP** `assertRollbackSupported refuses grok and allows every other adapter` — Grok rollback raises the capability error; Claude/Codex/OpenCode accept; detects exposing unsupported conversation rewind.
- **KEEP** `R5 #10: a turn whose baseline is missing diffs against HEAD, not 404` — A missing baseline still produces an actual HEAD-relative added line; future counts remain invalid; detects incorrect 404 fallback.
- **KEEP** `R5 #10: with no HEAD at all the fallback is the empty tree` — With no HEAD, the fallback diff adds only.txt from the empty tree; detects failed diffs in newly initialized repositories.
- **KEEP** `R5 #11: a stale turn end for a turn that never started is refused` — A remembered started turn rejects a different completion then accepts its own; detects late stale callbacks minting refs.
- **KEEP** `R5 #11: a replayed turn end is refused even with no fold rows to check` — Repeated completion without fold checkpoint rows yields one durable completion ref; detects duplicate-delivery drift.
- **KEEP** `R5 #20: a non-cone sparse checkout that cannot be rebuilt fails the capture` — Non-cone sparse checkout with manual flags returns error and publishes no ref; detects publishing false deletions when rebuild is unsafe.
- **KEEP** `Q1 #42: a ref that survives deletion fails the prune instead of reporting success` — A genuinely undeletable ref makes prune reject with the surviving ref still present; detects a successful response for an incomplete rewind.
- **KEEP** `E2E #E8: a capture for a turn a revert truncated is dropped` — A completion from a reverted in-flight turn is ignored, while a fresh turn still captures at 2; detects undoing a rewind or permanently blocking new captures.
- **KEEP** `S1 #9: a failure detail collapses the host's home path to ~` — Real Git failure detail contains ~ but omits configured host home; detects leaking private host paths to the timeline.
- **KEEP** `§5.5: a named turn count numbers the baseline and the turn end — a sparse 26 → 27 pair` — Explicit ordinal 27 produces refs 26/27, idempotent baseline preserves its commit, and actual diff adds two/new file; detects dense-counter numbering after resume.
- **KEEP** `§5.5: a named turn count wins over a placeholder's count and over the derived counter` — Named count 3 wins over placeholder 5 and derived 1 while retaining assistant linkage; detects using the wrong numbering authority.
- **KEEP** `§5.5: a turn count no ref can carry is ignored, never thrown into the turn` — Invalid named counts fall back to valid derived refs 0,1,2 rather than throwing; detects untrusted caller counts breaking a turn.
- **KEEP** `§5.5: pruneAbove also deletes the dropped turns' own counts, however low` — Legacy dropped count 2 is removed even below target27, while retained1/other-thread survive; detects resurrecting dense legacy checkpoints.

## `apps/daemon/src/agent-host/index/index.test.ts`

Index contract: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` §C and invariants1/4/6/7/8; GUI design §§5.5, 6.3; `packages/api/src/agent-chat/wire.ts` history/search/prompt responses.

`main.ts` feeds catch-up and shutdown; `orchestration/orchestrator.ts` consumes `ThreadIndex` history/search/prompt queries. All retained cases call that stable interface with real SQLite. `TestLog` supplies independent serialized byte positions, not index-derived expected turns. Schema corruption cases target persisted-cache compatibility, the permitted storage seam.

- **KEEP** `recovers every turn from a large log while yielding to the event loop` — Catch-up indexes all 150 known turns and 1,201 events while a queued immediate runs; detects starving host health or missing log tail.
- **KEEP** `continues catch-up from a persisted cursor` — A persisted two-turn prefix catches up to five exact ids; detects restarting catch-up from an incorrect cursor.
- **KEEP** `re-indexes from byte 0 when the log no longer matches the cursor` — A rewritten longer log removes old search text and yields exactly the new turn ids; detects treating stale byte positions as authoritative.
- **KEEP** `re-indexes a log that got SHORTER than the index (cursor ahead of logSeq)` — A shorter replacement log yields one turn and its own cursor; detects never repairing an index ahead of the durable log.
- **KEEP** `leaves unreadable logs behind after catch-up returns` — An unreadable log leaves a null cursor and behind coverage; detects falsely claiming complete prompt/history data.
- **KEEP** `fills the hole a live batch found before the boot catch-up reached its thread` — A skipped initial log prefix is repaired by catch-up after a live batch arrived first; detects permanent boot indexing holes.
- **KEEP** `a live observe queued during a catch-up applies after it, in order` — A gated catch-up followed by live observe yields three ordered turns and final cursor; detects interleaving that loses a live append.
- **KEEP** `deletes the rows at once and drops what was queued or in flight for the thread` — Deletion removes rows/search text, leaves another thread, and prevents queued/in-flight work resurrecting the deleted thread.
- **KEEP** `a driver error rolls its batch back without poisoning later ones; catch-up repairs the hole` — Real SQLite write locking rolls back a failed batch; catch-up later restores both exact turns and search text; detects poisoned write lanes.
- **KEEP** `a turn not started yet survives a failed write: the catch-up adopts it at its prompt` — A pending request survives SQLite rollback and is adopted at its original prompt; detects losing turn identity when memory must reload.
- **KEEP** `never throws out of observe, even for a malformed batch` — Malformed positions cannot throw out of observe; the corrected real batch later indexes successfully; detects optional index corruption stopping host commits.
- **KEEP** `ends a catch-up at its next chunk boundary, applies what was queued before, then closes` — Stop refuses late work, persists already queued work, leaves a partial cursor, then a reopened index catches up all150; detects losing committed work or blocking shutdown on full catch-up.
- **KEEP** `a catch-up still reading when the stop lands applies nothing of what it read` — Stop while log reading applies none of the gated read to the reopened database; detects continuing work after shutdown.
- **KEEP** `still deletes a thread's rows while it stops` — Deletion during stop remains absent in a reopened database; detects stale rows for threads no boot catch-up can visit.
- **DELETE** `is inert: ${name}` — An unseeded method inventory asserts the unavailable object's own constant returns; closed/stopped variants could return empty because no data ever existed. Populated close/stop and unavailable prompt behavior remain in this file and queries.test.ts.

## `apps/daemon/src/agent-host/index/indexer.test.ts`

Index contract: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` §C and invariants1/4/6/7/8; GUI design §§5.5, 6.3; `packages/api/src/agent-chat/wire.ts` history/search/prompt responses.

`main.ts` feeds catch-up and shutdown; `orchestration/orchestrator.ts` consumes `ThreadIndex` history/search/prompt queries. All retained cases call that stable interface with real SQLite. `TestLog` supplies independent serialized byte positions, not index-derived expected turns. Schema corruption cases target persisted-cache compatibility, the permitted storage seam.

- **KEEP** `derives turn rows: ordinals, timestamps, prompt, and byte ranges that tile the log` — Known two-turn transcript yields ordinals1/2, exact prompt/timestamps and adjacent byte ranges; detects missing prompts/checkpoints or wrong rewind order.
- **KEEP** `indexes finished messages and every activity write, with item positions and markers` — Search returns known prompt, assistant and activity ids with correct roles/turn ids and highlighted literal words; detects incorrect indexed content or ownership.
- **KEEP** `is idempotent: a replayed batch changes nothing` — Refeeding the same batches and whole log leaves two turns and one parser hit; detects duplicated projection rows on replay.
- **KEEP** `drops a batch that skips ahead of the cursor, and resumes once the hole is filled` — An ahead batch cannot index bravo until the missing sequence arrives; detects skipping durable events permanently.
- **KEEP** `anchors a replayed history turn at its prompt, though its row is minted at its end` — Imported history rows anchor at their earlier prompts with explicit byte bounds; detects pages omitting replayed prompts.
- **KEEP** `follows the fold's text rule: a final text replaces, an empty one keeps, a reopened message continues` — Final polished text replaces draft; reopened Hello continues with world; reasoning retains role; detects stale or incomplete searchable text.
- **KEEP** `keeps the last write of an activity, and moves its marker with it` — Latest tool update replaces Running with finished/errors at seq3; detects stale activity search hits.
- **KEEP** `a hidden goal progress row keeps its place in the log but never reaches the search` — Hidden goal progress is absent from search while the visible set objective remains searchable; detects progress noise flooding search.
- **KEEP** `a revert drops the removed turns and everything from their first line on, and closes every range` — Revert removes bravo/charlie and compaction, retains alpha and sealed first range through restart; detects search/history resurrecting removed turns.
- **KEEP** `thread.deleted removes every row of the thread` — A durable thread.deleted event removes that thread's turns/search while another survives; detects ignored log tombstones.
- **KEEP** `a restart mid-turn resumes the open turn from its rows` — Restart before settle/checkpoint retains correct two turn ranges through the tail; detects dropping the open turn on reload.
- **KEEP** `a message's first line survives a restart in the middle of its stream` — Message streamed across restart retains firstSeq5/firstByte and final lastSeq; detects history clipping earlier message chunks.
- **KEEP** `a turn the provider never started leaves its rows with the turn before it` — A refused unstarted turn creates no ordinal and belongs to prior range until next valid prompt; detects phantom rewind counts.
- **KEEP** `a capture that lands after the next turn began still falls inside its turn: ranges overlap` — Late diff and capture rows remain inside turn1's actual page despite turn2 starting; overlap survives reload; detects losing late checkpoint history.
- **KEEP** `a capture that lands between the next prompt and the next turn's start stays with its turn` — Late capture between prompt2 and adoption stays in turn1 and both prompts remain pageable; detects cutting a range too early.
- **KEEP** `an unknown prompt starts the turn at its row; a turn adopted from a session-set at that event` — Missing prompt and provider-only continuation anchor at request/session events respectively; detects absent history for unprompted turns.
- **KEEP** `nothing extends a range across a revert — not even a late event naming the turn` — A late event after revert cannot regrow a sealed range, including after restart; detects loading the revert into an old page.
- **KEEP** `a revert clips a surviving turn at the cut: a late event's stretch never brings the removed turns back` — Revert clips a previously overlapping survivor before turn2 and keeps it clipped after restart; detects removed turns returning through stretched ranges.
- **KEEP** `a late event far past the next turn's start does not stretch the earlier turn` — A >2MiB late reference cannot stretch an old turn's range; detects unbounded history pages for long-lived background tasks.
- **KEEP** `a restart between a turn's request and its adoption keeps the turn at its prompt` — Restart between request and adoption preserves prompt2 at its original boundary; detects swallowing a prompt into prior turn.
- **KEEP** `a prompt remembered before a restart still anchors the turn that claims it after` — An imported prompt preceding restart still anchors its later replayed turn at seq2; detects forgetting unclaimed history prompts.
- **KEEP** `queued turns survive restarts in order, and each adoption takes the oldest` — Two queued requests survive multiple restarts and adopt u2 then u3; detects swapping or losing queued turn ownership.
- **KEEP** `a turn requested before a replayed history keeps its place among the replayed turns` — A live request predating imported history keeps ordinal order live,h1,h2 after restart; detects rewind count drift on resume.
- **KEEP** `a turn that settled without ever starting is not kept, and moves no ordinal or range` — A stopped unstarted request produces no extra turn after restart; detects persisting already settled pending rows.
- **KEEP** `an in-flight state that does not read back is ignored whole: an empty one, never a crash` — Eleven corrupt inflight variants rebuild empty pending state without failing subsequent adoption or cursor advance; detects partial recovery inventing prompt ownership.
- **KEEP** `never drops a thread with a turn not started yet or a message mid-stream, however many pass` — Many other threads cannot evict an active stream's text or pending prompt; detects lost messages/turn anchors under memory pressure.
- **KEEP** `never indexes half a surrogate pair — not even one a chunk boundary split at the cap` — Whole/streamed/activity text cut at 128KiB retains needle without replacement characters or excluded suffix; detects malformed Unicode or cap escape.

## `apps/daemon/src/agent-host/index/queries.test.ts`

Index contract: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` §C and invariants1/4/6/7/8; GUI design §§5.5, 6.3; `packages/api/src/agent-chat/wire.ts` history/search/prompt responses.

`main.ts` feeds catch-up and shutdown; `orchestration/orchestrator.ts` consumes `ThreadIndex` history/search/prompt queries. All retained cases call that stable interface with real SQLite. `TestLog` supplies independent serialized byte positions, not index-derived expected turns. Schema corruption cases target persisted-cache compatibility, the permitted storage seam.

- **KEEP** `pages from the newest turns down, oldest first within a page` — Seven known turns page as5/6/7 then2/3/4 and1/2 before third; detects pagination gaps/order errors.
- **KEEP** `the cursor wins over beforeTurn, and a foreign cursor reads as none` — A same-thread cursor overrides beforeTurn; a foreign cursor falls back to explicit sixth turn; detects cross-thread paging contamination.
- **KEEP** `a cursor whose turn is gone still means 'older than its anchor'` — A missing cursor turn uses its content anchor to return1/2/3; detects broken saved cursors after revert/rebuild.
- **KEEP** `pages by the log's order even when turn timestamps tie or run backwards` — Tied timestamps still page t-z,t-a,t-m in log order with adjacent ranges; detects lexical/time ordering replacing turn order.
- **KEEP** `withholds exactly the turns a settled compaction lies after — mid-turn included` — A settled compaction in turn2 forbids rewind to1/2 but allows3; detects rewind promises the provider cannot fulfill.
- **KEEP** `an in-flight or failed compaction dropped nothing and withholds nothing` — In-flight and failed compaction leave rewind available; detects premature gating without actual history loss.
- **KEEP** `the legacy marker — thread.state.changed {state: compacted} — withholds the turns before it` — Legacy compacted marker gates1/2 but ordinary running state does not gate3; detects old-log compatibility loss.
- **KEEP** `a subagent's own compaction withholds nothing, whether the row or its payload names the agent` — Compaction owned by subagent in either supported location leaves all parent turns rewindable; detects cross-agent history gating.
- **KEEP** `matches operators, quotes and punctuation as plain text, never as syntax` — Literal quotes/operators/Unicode/diacritics/punctuation search returns handwritten ids; detects FTS query injection or invalid syntax dropping legitimate results.
- **KEEP** `an empty or whitespace query finds nothing` — Empty/whitespace query returns no hits even with indexed content; detects accidental broad search.
- **KEEP** `clamps the limit to [1, 50] across both tables` — Combined message/activity results obey requested5, cap50, minimum1 and NaN default; detects per-table cap allowing excess data.
- **KEEP** `filters by project and names each hit's thread` — Two project threads search together, but beta scope returns only beta id/path/title; detects project data leakage.
- **KEEP** `follows a renamed thread` — Old message hit follows the latest thread title; detects stale user-visible search metadata.
- **KEEP** `itemPosition: an activity's latest line` — Latest x1 line isseq14, x2seq6; message/missing/other-thread are absent; detects reading obsolete item bytes.
- **KEEP** `itemPositionBySeq: only an activity's latest line answers` — Only latest activity sequence resolves; older x1seq5/message/invalid seq cannot; detects duplicate old activity reads.
- **KEEP** `hasItemsBefore` — With current items6/13/14/15, boundary6 is false and7 true; detects incorrect hasOlder caused by obsolete item writes.
- **KEEP** `activitySeqBefore: `count` back, else the oldest, else null` — Walking items15/14/13/6 returns requested kth or oldest/null with exclusive bounds; detects gaps or oversized activity history pages.
- **KEEP** `turnsInSeqRange: every turn whose range meets [from, to), ordinal order` — Half-open range intersection returns exact turn ids, including overlapping1/2; detects missing/extra turns during activity paging.
- **KEEP** `turnOfSeq: the containing turn, the newest start when ranges overlap` — Overlapping seq11/14 belongs to newer turn2 while preturn seq1 belongs to none; detects wrong search navigation target.
- **KEEP** `turnOfSeq: a row a revert left between its survivor and the next turn gets the survivor` — Post-revert gap row maps to surviving turn1 without claiming range overlap; detects orphaned history navigation.
- **KEEP** `latestRevertSeq and firstBoundaryAfter: where a page may end just past the latest revert` — Latest revert advances and first boundary is prompt then activity, skipping session-only events; detects page boundary cutting wrong event kind.
- **KEEP** `turnByPrompt: the turn that names a message as its opening prompt` — Prompt u2 maps to turn2 then becomes absent after rewind; retained u1 stays; detects wrong prompt navigation.
- **KEEP** `keepsUserMessage: a user message until a revert drops it by the fold's rule` — Revert retains u1 and removes u2/unclaimed note; assistant/missing/foreign never count as user; detects serving discarded user messages.
- **KEEP** `a message streamed in three chunks around activity boundaries reports its span` — Three message chunks around tools report seq5..10 and full literal searchable text; detects history truncating streamed content.
- **KEEP** `messagesSpanning: a boundary inside the message returns it, one outside returns nothing` — Boundaries6/8/10 report spanning m1 while5/11/3 do not; detects duplicate or missing text at page edges.
- **KEEP** `eventPositionBySeq answers for an activity line and a message's first line, nothing else` — Activity and first-message lines resolve to bytes; middle/final chunks and turn rows do not; detects invalid page anchors.
- **KEEP** `every message has a span, text or not; a reopened one keeps where it began` — An empty message retains a span, and a reopened message preserves its first line/timestamp; detects empty/reopened message loss.
- **KEEP** `a revert drops the spans of the messages it removed` — Revert removes a2/u2 spans but keeps a1; detects page planners resurrecting removed messages.
- **KEEP** `lists the parent's prompts newest first, each with the turn it opened` — Three parent prompts list newest-first with exact text/ordinal/seq/timestamp and no cursor; detects wrong recalled prompt metadata.
- **KEEP** `lists a steer on the turn it steered, and a prompt no turn has started yet, with no ordinal` — Steer belongs to turn1 without opening an ordinal; unstarted u2 has no ordinal; detects allowing rewind on non-opening prompts.
- **KEEP** `a replayed prompt opens the replayed turn that names it` — Imported user:h1 links to replayed h1 ordinal1 before live2; detects unrewindable imported prompts.
- **KEEP** `refuses what the user did not type, and strips image placeholders from what they did` — Provider notifications/commands/plan scaffold/images/blank/assistant are refused; typed text strips placeholders and /goal remains; detects recalling machine-generated instructions.
- **KEEP** `never lists a subagent's user message; an empty owner is the parent's own` — Author comes from first message line, so subagent message remains excluded and parent remains included across later owner edits; detects leaking delegated prompts.
- **KEEP** `a revert takes the reverted turns' prompts and their steers with it` — Revert removes prompts and steers for turns2/3, retains1 and renumbers new4 as2; detects stale prompt recall after rewind.
- **DELETE** `gives each prompt the history page's rewind rule for the turn it opened` — Replays the exact compaction-in-turn2 scenario already owned by the rewindable tests, with only the prompt-entry projection layered on top. Prompt list ownership/ordinal/rewindable presence remain tested in neighboring cases.
- **KEEP** `pages by its cursor, and refused rows never cost a page a slot` — Refused rows do not consume slots across three cursor pages7/6/5,4/3/2,1; detects skipped prompts at filtered boundaries.
- **KEEP** `clamps the limit to [1, 500], and anything not a number is the default` — Prompt page limits honor minimum1, floor2.9, cap500 and default100; detects unbounded responses or invalid limit behavior.
- **KEEP** `cuts an entry's text at 4_000, never inside a surrogate pair` — Text is capped at4000 without splitting the astral pair, while by-id returns whole text; detects malformed displayed recall text.
- **KEEP** `reads a malformed or foreign cursor as a first page` — Malformed/foreign cursors return first page, valid cursor returns older u1 and tolerates unknown fields; detects unsafe cursor parsing or rebuild incompatibility.
- **KEEP** `answers a read it cannot make with null or failed — never an empty page; no prompts is an empty page` — Unavailable/closed populated indexes answer failed/null, while a healthy empty thread returns an empty page; detects telling users their history is empty after an index failure.
- **KEEP** `coverage: whole once every line is indexed; catching up while a catch-up will close the gap; behind when none will` — Coverage distinguishes complete/catching-up/behind through boot sweep, queued writes and actual holes; detects premature empty history or endless loading.
- **KEEP** `prompt(): a listed prompt by id, with its line; null for anything the list would not show` — By-id lookup returns stripped user text and exact durable line, rejects assistant/owned/reverted/missing/foreign ids; detects exposing non-recallable text.
- **KEEP** `prompt(): says when the index's copy may be only the head of a longer prompt` — 128KiB copies mark cut and distinguish one-line vs rewritten sources so callers can recover full prompt; detects treating truncated prompt as complete.
- **KEEP** `a revert drops a turn-less prompt no turn claims, before the cut — as the fold does` — Unclaimed idle /goal prompt before the cut disappears on rewind; detects position-only retention disagreeing with conversation.
- **KEEP** `…unless the fold's fallback restores it, for retained turns that have no prompt` — A retained provider-started turn lacking prompt restores the oldest unclaimed prompt; detects dropping fallback recall history.
- **KEEP** `a resumed thread's first live prompt, requested before the replay, goes with its turn` — A resumed live prompt preceding imported history survives target1 but disappears target0; detects applying byte position instead of turn ownership.
- **KEEP** `continues a short page after the prompt scan budget is exhausted` — 3000 refused rows return a resumable empty short page then the real older prompt; detects scan-budget starvation losing history permanently.
- **KEEP** `walks past a user message that never had text, counting it` — A user message without an FTS text row is skipped between valid prompts; detects inner/outer join handling breaking prompt pagination.

## `apps/daemon/src/agent-host/index/sqlite.test.ts`

Index contract: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` §C and invariants1/4/6/7/8; GUI design §§5.5, 6.3; `packages/api/src/agent-chat/wire.ts` history/search/prompt responses.

`main.ts` feeds catch-up and shutdown; `orchestration/orchestrator.ts` consumes `ThreadIndex` history/search/prompt queries. All retained cases call that stable interface with real SQLite. `TestLog` supplies independent serialized byte positions, not index-derived expected turns. Schema corruption cases target persisted-cache compatibility, the permitted storage seam.

- **KEEP** `bootstraps a fresh private WAL database and its parent directories` — Fresh file becomes usable WAL at the configured nested path with 0600 mode; detects unreadable index or leaked conversation text.
- **KEEP** `reopens an intact file without rebuilding it` — A second real connection retains the prior cursor; detects needlessly discarding a compatible cache.
- **KEEP** `tightens a pre-existing file to 0600` — Reopening a0644 existing file tightens it to0600; detects exposure left by older versions or manual chmod.
- **REWRITE** `replaces a file with incompatible schema version ${version} and starts empty` — Old schema1 and future999 replace the file and remove existing cursor/search text; redundant old versions2/3/4 are removed, retaining both compatibility directions.
- **KEEP** `replaces a file that is not a database at all` — Non-SQLite bytes are replaced by an index accepting new events; detects startup failure after corrupted cache files.
- **KEEP** `replaces a file that claims the version but lacks a table` — A file missing markers becomes available again; detects trusting version alone when an essential table is gone.
- **KEEP** `rebuilds a file at this version whose tables predate a column this build writes` — A same-version legacy message_docs table lacking columns is rebuilt and usable; detects statement-prepare failure disabling the index.
- **KEEP** `runs unavailable when the file can be neither opened nor recreated` — A directory at the SQLite filename yields unavailable mode rather than crashing; detects unrecoverable cache paths stopping host startup.

## `apps/daemon/src/agent-host/store/attachments.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `a thread segment is sanitised to [a-z0-9_-] and bounded` — Thread segment Thread/One becomes thread-one, unusable input rejects and200 chars bounds to80; detects incompatible stored attachment names or unsafe path fragments.
- **KEEP** `the reserved pending segment can never be claimed by a thread` — Thread pending uses _pending rather than shared pending namespace; detects cross-thread ownership and premature sweep.
- **KEEP** `an id names its owning thread and round-trips` — Persisted id bytes encode normalized owner/UUID/png and parse back owner/extension; detects existing attachment id incompatibility.
- **KEEP** `an unusable extension collapses to bin rather than riding along` — An invalid extension becomes bin, while legacy omission stays suffixless; detects unsafe suffixes or legacy id breakage.
- **KEEP** `a traversal-shaped id never parses` — Traversal/slash/dot/NUL-shaped ids never parse an owner; detects arbitrary attachment lookup.
- **KEEP** `.part is reserved, so a stored archive.part becomes .bin` — .part is mapped to.bin while PNG lowercases and missing/long suffix uses.bin; detects sweep deleting successfully uploaded .part files.
- **KEEP** `an id is recovered from a stored file name` — Stored filename recovers exact id, while missing suffix and nested paths reject; detects orphan sweep misidentifying file ownership.

## `apps/daemon/src/agent-host/store/binding.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `an omitted field is UNCHANGED — the rule the cursor exists for` — Status-only patch keeps resume/account/adapter/runtime/provider identity fields; detects restarting a fresh conversation on a status change.
- **KEEP** `an explicit `undefined` is also unchanged, never a clear` — Explicit undefined preserves cursor and adapter; detects accidental erase from optional-object fields.
- **KEEP** `null` clears, and is distinguishable from an omission` — Explicit null clears every nullable identity field; detects resuming an explicitly forgotten provider session.
- **KEEP** `a first write with no existing binding takes the fallback adapter and null defaults` — First binding uses caller fallback adapter, stopped status and nullable defaults while preserving fresh cursor; detects undefined initial provider identity.
- **KEEP** `an absent cursor is stored as null, never as undefined` — First status-only write stores resumeCursor:null explicitly; detects ambiguity between absent persisted cursor and omitted update.
- **KEEP** `lastSeenAt` is always the write's own stamp` — New write timestamp replaces prior lastSeenAt with the supplied clock value; detects stale resume identity observation time.
- **KEEP** `bindingResumeCursor reports null and a missing binding the same way — `undefined` — Missing/null cursor is exposed as undefined and real cursor stays intact; detects adapters receiving a misleading resume argument.
- **KEEP** `round-trips a cursor through disk and merges the next write field-wise` — A second store reads cursor from real disk, merges status and a third observes preserved cursor; detects serialization/wiring loss beyond the pure merge contract.
- **KEEP** `a binding that does not decode reads as absent, never as an error` — Corrupt JSON binding returns null without marking the thread error; detects one bad resume cache hiding the conversation.
- **KEEP** `a thread with no binding file reads as null` — Legacy thread with no binding file returns null; detects older persisted threads failing resume fallback.
- **KEEP** `deleting the thread takes its binding with it` — Deleting a bound thread removes file and cached binding; detects resurrecting deleted provider identity.

## `apps/daemon/src/agent-host/store/raw-log.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `high-rate delta frames are dropped, not written` — Literal high-rate provider frames, including wrapped frames, are dropped while turn/completed persists; detects raw logs growing with every token.
- **KEEP** `an MCP env map is redacted key-wise — a token shape never matches it` — An MCP env map with an ordinary unshaped secret writes only redaction values; detects credential leakage not caught by token regexes.
- **KEEP** `credential-shaped keys and text are both scrubbed` — apiKey/access_token/header text and configured home are scrubbed while NDJSON stays parseable; detects malformed redaction or leaked credentials.
- **KEEP** `a long string is capped per record` — A >64KiB string is bounded and visibly marked; detects unbounded per-frame storage.
- **KEEP** `a cyclic frame is bounded by the depth cap, not fatal` — Cyclic input stays bounded and the following valid record survives; detects diagnostic serialization taking down logging.
- **KEEP** `the file rotates past 10 MiB and keeps at most 10 generations` — A preexisting10MiB file rotates with only10 generations and expected oldest replacement; detects unlimited retained raw files.
- **KEEP** `a writer that cannot open its file degrades to a no-op` — A directory at the raw filename cannot throw on current or later writes/flush; detects best-effort diagnostics failing agent work.
- **KEEP** `the buffer thresholds flush without waiting for the timer` — Large records trigger a byte-budget flush before timer/record threshold; detects unbounded pending memory for large frames.
- **KEEP** `the record threshold flushes on its own too` — 512 small records flush without timer; detects unbounded pending record buffers.
- **KEEP** `the ceiling is enforced ACROSS threads, which rotation alone cannot do` — Six128MiB thread logs evict two oldest to512MiB while newest remains; detects falsely applying a global ceiling per thread.
- **KEEP** `a live file whose thread has an open writer is never unlinked` — An open writer's live file survives while idle file is evicted under pressure; detects unlinking output still being appended.
- **KEEP** `a rung past the age bound is removed even when the ceiling is not reached` — A30-day rotated file is removed below byte ceiling while fresh survives; detects ignoring age retention.
- **KEEP** `a missing threads root is not an error` — A nonexistent thread root returns empty sweep without throwing; detects first-boot diagnostics cleanup failing.

## `apps/daemon/src/agent-host/store/store.positions.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `append reports each line's byte offset and length, counted in UTF-8 bytes` — Returned positions equal independently scanned newline-byte boundaries and physical file size with multibyte text; detects counting UTF16 units as file offsets.
- **KEEP** `a second append continues the offsets where the first one ended` — A second in-process batch continues the prior end and all positions match physical bytes; detects resetting append offsets on a warm store.
- **KEEP** `a reopened store continues from the log's length on disk, not from zero` — A reopened store appends after actual log length, independently scanned; detects resetting durable offsets after host replacement.
- **KEEP** `an append with no events reports no positions and the current length` — Receipt-only append returns no positions and unchanged real length; detects phantom bytes for rejected commands.
- **KEEP** `an append whose fsync fails leaves no trace, so the next one starts clean` — Injected real fsync failure rolls bytes and seq back, then a successful append yields only created/m2; detects unacknowledged durable events.
- **KEEP** `an append whose rollback fails too re-reads its counters from disk — no gap, no collision` — Write+rollback failure re-reads actual disk counters and next seq3 without collision; detects guessing counters after double I/O failure.
- **KEEP** `a fragment the rollback could not cut is cut before the next append writes — or that append writes nothing` — A failed partial-write rollback prevents any new append until repair, then seq2 is clean; detects gluing new events onto a torn fragment.
- **KEEP** `readEventsFrom returns exactly the events after a recorded cursor, with their positions` — Cursor read returns exact m2/m3 positions/seq4 on reopen, and cursor0 returns all messages; detects skipped/duplicated resumed tail events.
- **KEEP** `readEventsFrom at the end of the log is an empty tail, not a mismatch` — At EOF and absent empty log the tail is empty without mismatch; detects unnecessary cache invalidation at a valid end cursor.
- **KEEP** `a cursor whose line does not carry afterSeq + 1 is a mismatch` — Both older and newer afterSeq against a real seq3 line return mismatch and no events; detects accepting stale cursors.
- **KEEP** `a log shorter than the cursor's offset is a mismatch` — Offsets beyond existing/missing log length return mismatch; detects trusting a cache ahead of the record.
- **KEEP** `a cursor on a newline of a rewritten log is a mismatch: an empty line is never the next line the store wrote` — A rewritten line moves newline exactly onto old cursor; read rejects despite following seq being plausible; detects false continuity after replacement.
- **KEEP** `an offset inside a line is a mismatch` — Offset inside a valid JSON line returns mismatch; detects parsing fragment tails as valid continuation.
- **KEEP** `a cursor that is not a byte offset at all is a mismatch` — Negative/fractional/NaN offset and invalid seq return mismatch before reading; detects OS special offsets becoming fake positions.
- **KEEP** `readEventsFrom stops at a malformed line, with logBytes past the last good one` — Malformed third line truncates tail at m1 and reports exact last valid byte boundary; detects serving later corrupt-log rows.
- **KEEP** `a write seen mid-way is not an event: truncated, and logBytes stops before it` — A fragment appearing after load is truncated read-only and never treated as committed event; detects exposing writes in flight.
- **KEEP** `readEventRange returns exactly the events whose positions it was given` — A half-open byte range spanning appends returns m2/m3/m4 and seq3/4/5; detects range off-by-one history gaps.
- **KEEP** `a range that starts inside a line is truncated, never a misread` — Range starting within a line returns no events and truncated; detects misreading stale page boundaries.
- **KEEP** `a range that ends inside a line drops that line and is truncated` — Range ending before final newline omits the incomplete line and marks truncated; detects rendering incomplete history as whole.
- **KEEP** `a range past the end of the log reads what is there and says it is short` — Range beyond EOF returns available m1 and truncated, missing log likewise short; detects silent incomplete pages.
- **KEEP** `an empty range is empty; an unusable one is refused before any read` — Zero-length range is empty, while invalid/reversed ranges reject RangeError; detects dangerous OS read bounds.
- **KEEP** `lastSeq and logLength answer from the log's last line and length, not a full read` — lastSeq/logLength use durable last record/size despite middle corruption, while full read stops earlier; detects sequence reuse from a truncated fold.
- **KEEP** `a torn trailing fragment is cut on load, so the next append gets a line of its own` — Cold-load repair cuts trailing fragment before next append, producing decodable seq1/2/3 and consistent read methods; detects permanent log corruption after crash.
- **KEEP** `a log that is nothing but a fragment is cut to empty` — All-fragment file resets to0 and accepts first event atbyte0/seq1; detects retaining unusable crash bytes in a new thread.
- **KEEP** `a complete line that does not decode is left alone — only a fragment is cut` — Malformed complete line remains byte-identical and only truncates reading; detects destructive repair of acknowledged durable data.
- **KEEP** `the cut walks back window by window to the last newline, however far it is` — A200000-byte fragment is cut to independently known19-byte UTF8 prefix; all-fragment/missing cases empty; detects single-window tail repair losing good records.

## `apps/daemon/src/agent-host/store/store.snapshot.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `a saved fold snapshot loads back as written, on a reopened store` — Saved snapshot reopens with exact caller state/extras/time/seq and a cursor the log honors; detects persistence loss independent of API serializer unit tests.
- **REWRITE** `state.json sits where @orquester/config says, 0600, written by rename` — Configured state.json path exists with 0600 mode; remove no-temp-file assertion that cannot prove atomicity and only constrains write strategy. Retained title: `state.json is stored at the configured path with mode 0600`.
- **KEEP** `a missing, corrupt, other-version or other-thread snapshot loads as null` — Missing/corrupt/wrong-version/wrong-thread/non-fold caches return null; detects trusting incompatible caches over logs.
- **KEEP** `loadFoldSnapshot never throws, even for an unusable thread id` — Traversal/empty/slash thread ids return null without throwing; detects optional cache path errors escaping startup.
- **KEEP** `a snapshot file AHEAD of the log is discarded, never trusted` — Self-consistent but ahead seq or byte claims are discarded; detects skipped durable events after restoring an older log.
- **KEEP** `a save the log cannot honour is never written` — Impossible saves do not replace an earlier valid cache; detects writing caches the committed log cannot support.
- **KEEP** `a save whose state is not folded to its seq is refused loudly` — State.seq mismatch rejects and creates no snapshot; detects permanently unreadable cache records.
- **KEEP** `a snapshot save queued behind a delete does not bring the thread back` — Queued save after thread deletion leaves no directory or listed thread; detects cache writes resurrecting deleted conversations.
- **KEEP** `the snapshot is what the caller handed over at call time` — Mutation of caller extras after save invocation cannot change stored value; detects queue-time aliasing corrupting snapshot position/state agreement.
- **KEEP** `two saves land in call order: the later one wins` — Two asynchronous saves persist the laterseq despite queueing; detects older snapshots overwriting newer state.
- **KEEP** `the snapshot attachment sweep retains references after tail reverts` — Snapshot+tail sweep keeps A/C, removes reverted D/E, retains newF and handles plainG; detects deleting live files or preserving reverted attachment refs.
- **KEEP** `a snapshot whose cursor the log does not honour is ignored: the sweep reads the whole log` — Snapshot with a false state and broken byte cursor is ignored; only actual log attachments a/c survive; detects stale cache authority deleting correct files.

## `apps/daemon/src/agent-host/store/store.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **KEEP** `append stamps a per-thread monotonic seq and returns what it persisted` — Thread1 returns/persists seq1/2 while another starts1; detects global or reused sequence numbers.
- **KEEP** `concurrent appends never reuse a sequence` — 25 concurrent appends yield unique seq2..26 and26 total records; detects write-lane races corrupting history.
- **KEEP** `a first-touch read racing a first-touch append never re-uses a seq` — Reopened simultaneous read+append continues seq4 and disk1/2/3/4; detects first-load race overwriting existing sequence ids.
- **KEEP** `an event type from a NEWER host folds inertly and never truncates (R1-8, §8)` — A future unknown event allows known later messages and appendseq5 with no truncation/error; detects rollback-version data loss.
- **KEEP** `an unknown type as the LAST line still seeds seq, so no append re-uses it` — A final unknown event seeds nextseq4 and disk1/2/3/4; detects seq reuse when newer events end the log.
- **KEEP** `genuinely malformed lines still truncate — §5.1's rule is unchanged` — Invalid JSON and invalid envelopes truncate to the prior valid event; detects treating corruption as forward-compatible events.
- **KEEP** `a malformed middle line truncates the fold at that point` — A malformed middle record hides all later rows and sets truncated; detects bypassing corruption in complete log reads.
- **KEEP** `a thread whose meta.json is corrupt is marked error and still readable` — Corrupt meta marks only that thread, preserves both its log and a healthy neighbor; detects whole-host failure or lost durable history.
- **KEEP** `a meta.json that does not match the schema marks the thread error` — Schema-invalid meta returns null with schema error; detects trusting malformed persisted head data.
- **KEEP** `a metadata-only head read never scans a malformed event log` — Metadata-only read returns valid head despite malformed event tail; detects accidentally folding histories on the readiness path.
- **KEEP** `a metadata-only head read never rolls a seeded thread's head back to meta.json` — Metadata-only read of an already seeded thread keeps newerseq2 despite diskseq1; detects overwriting in-memory progress with stale head cache.
- **REWRITE** `meta.json is checkpointed every 50 events and rewritten atomically` — Head checkpoint writes at 50 events with correct thread and seq 50; remove temp-file absence claim that cannot establish atomicity. Retained title: `meta.json is checkpointed every 50 events`.
- **KEEP** `saveHead wins over the store's own projection and survives a reopen` — continueAfterRestart marker with timestamp survives real reopen; detects losing crash/deploy continuation state outside event projection.
- **KEEP** `the goal-resume marker is head-only state that survives a reopen (goals §5.5)` — Goal resume marker survives append, metadata-only reopen and full reopen, then explicit save clears it; detects losing autonomous goal continuation.
- **KEEP** `the goal-hold marker is head-only state that survives a reopen (goals §5.7)` — Goal hold marker survives append and both reopen modes, then explicit clear persists; detects losing handover lease continuation.
- **KEEP** `a failing ref cleanup aborts the delete rather than orphaning refs` — Failing checkpoint cleanup rejects deletion and retains whole directory/list membership; detects orphaning refs with no retryable thread.
- **KEEP** `listThreads names every directory on disk; deleteThread removes one whole` — Listing yields two disk threads then deletion removes exactly one directory; detects phantom/deleted thread tabs.
- **KEEP** `a receipt is written with the events and replays their sequence` — Accepted receipt persists eventseq2 and can be read after reopening, unknown id absent; detects retrying already executed commands.
- **KEEP** `a rejected receipt is persisted too, so a retry replays the rejection` — Rejected receipt survives disk with TURN_ACTIVE error; detects retries rerunning a rejected command inconsistently.
- **KEEP** `the receipt ring evicts oldest-first at 500` — 520 receipts evict oldest to500 while newestseq519 survives; detects unbounded dedup storage or wrong eviction.
- **KEEP** `an unreadable receipts file costs at most a replayed command, never a thread` — Corrupt receipt file does not break thread append and a new valid receipt works; detects optional dedup cache disabling chats.
- **KEEP** `putAttachment copies the file, names the thread in the id and stats the size` — Upload reports actual size/path and editing stored copy leaves source64 bytes; detects incorrect attachment bytes or hard-link source mutation.
- **KEEP** `resolveAttachment reads legacy ids without an extension suffix` — Legacy id lacking suffix resolves actual old.png content; detects breaking historical attachment access.
- **KEEP** `an attachment id belonging to another thread is refused, not looked up` — Foreign-owner/traversal ids reject before lookup while own file succeeds; detects cross-thread/arbitrary attachment reads.
- **REWRITE** `bounds are checked against the stat'd file, per kind` — Use a .bin filename with image/png to isolate the MIME image cap; the extension-cap regression owns .png behavior. Large genuine binary remains allowed. Retained title: `an image MIME type applies the image size cap even to a binary filename`.
- **KEEP** `pruneAttachments keeps referenced files and sweeps stale orphans` — Within upload grace orphan survives; after48h orphan vanishes while referenced file remains; detects racing unsent uploads or leaking true orphans.
- **KEEP** `pruneAttachments sweeps .part files after an hour and pending uploads after a day` — Partial upload expires after1h and pending after24h, with positive pre-expiry checks; detects premature or absent cleanup.
- **DELETE** `a revert's truncation is what the attachment sweep recomputes against` — Replays the attachment-after-revert decision already exercised with real files by store.snapshot.test.ts snapshot+tail sweep; full-log fallback remains independently covered there.
- **KEEP** `readItem serves the FULL payload, even for a row past the fold's window` — An activity beyond retention retains all40000 output chars on demand and missing id returns null; detects treating a slim/resident cache as durable output.
- **KEEP** `an unusable thread id is refused before it reaches path.join or rm -rf` — Unsafe ids reject delete/load before path operations; detects arbitrary recursive deletion/read.
- **KEEP** `the image cap follows the stored extension, not just the declared mime` — Spoofed nonimage MIME cannot bypass .png image cap while genuine.bin remains allowed; detects size-limit bypass on upload.
- **KEEP** `the host-wide sweep removes stale raw-log files` — Deep host-wide sweep actually removes an aged raw rung; detects forgetting global diagnostics retention at scheduler entrypoint.
- **KEEP** `the startup sweep avoids history folds and leaves completed attachments for the deep sweep` — Startup removes partial/raw files but leaves completed orphan until deep sweep; detects readiness folding or prematurely deleting completed uploads.

## `apps/daemon/src/agent-host/store/tool-output.test.ts`

Storage contract: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §§3.1, 3.3, 4.1, 5.1, 5.5, 6.3, 8, 10; snapshot design §A2; goal design §§5.5/5.7; AGENTS.md append-only log, cache authority, field-wise bindings, path isolation and secret redaction rules.

`main.ts` constructs the store; orchestration and HTTP handlers consume `ThreadStore`. store/index.ts consumes attachments, binding, files, raw-log, tool-output and tool-output-cache modules. `bindingResumeCursor`, `joinToolOutput` and `toolOutputWindow` also have real orchestrator callers. These are storage/parsing/byte contracts, not UI shape tests.

- **DELETE** `joins every chunk of the item's call verbatim in log order, and reports complete once the call's completion exists` — Pure happy-path join/selection duplicates real ingestion-to-store output and byte-window tests in this file; those use independently arranged expected text and interleaved foreign calls. The running-call scenario retains foreign-completion isolation.
- **KEEP** `a call that streamed nothing answers an empty output; an item naming no call, a message and an unknown id answer null` — An empty-stream call has complete empty output while messages/no-call/blank/missing ids are null; detects confusing no output with no tool call.
- **KEEP** `the item's newest write names the call, as readItem reads it` — A rewritten item's latest payload selects new-call output rather than old-call; detects stale tool identity selection.
- **DELETE** `a rewind does not unprint output: chunks written in the turns a revert removed are still joined` — Pure rewind scenario repeats the retained warm-cache rewind case; that case asserts both whole-output and window read results so raw-log contract stays covered at the store seam.
- **KEEP** `the cap cuts the join in-band, on a character boundary, and the completion after the cut is still reported` — 8MiB cap stops before a whole multibyte character and still sees later completion; detects oversized or broken UTF8 downloads.
- **KEEP** `a lone high surrogate at the join's end reads as U+FFFD, and becomes the 4-byte pair when its low half arrives` — Incremental unmatched surrogate reads U+FFFD then becomes emoji with later low half, while malformed halves remain replacements; detects corrupt output across chunks.
- **KEEP** `toolOutputWindow windows a whole join: the default and widest sizes, the end, and the flags` — Fallback window cutter honors byte offsets, progress, end and documented default64KiB/max1MiB including invalid numbers; detects non-cache pagination disagreeing with protocol.
- **KEEP** `a background shell's output, as ingestion writes it, is joined back whole by the store — its completion holds none` — Real ingestion emits only chunk output, then store reconstructs shell text from start/completion ids excluding interleaved foreign call; detects slimming away the sole output copy.
- **KEEP** `readToolOutputWindow pages a call's join to the byte: the windows are the whole join's bytes, for any window size` — Stored multibyte/split-surrogate output pages byte-for-byte for five window sizes, with exact metadata and character-safe inside/end offsets; detects page gaps, duplication or mojibake.
- **REWRITE** `a running call's windows continue across appends: totalBytes grows, and complete flips when its completion lands` — Warm windows grow through appends, ignore another call's completion, and complete only after their own completion row; detects stale cache tails/flags and cross-call completion leakage. The deleted pure join case's foreign-completion distinction is preserved in this real-store scenario.
- **REWRITE** `a revert appended after the cache filled changes nothing: a rewind unprints nothing` — Warm output survives reverted turns and later chunks; assert both whole and window APIs equal the same literal output. This absorbs the duplicate pure rewind case.
- **KEEP** `deleteThread drops the thread's cache: a thread recreated under the same id answers its own output and items` — Delete/recreate same ids yields only new item title and output, with null while absent; detects cross-generation cached data leaks.
- **KEEP** `a torn fragment on disk (a crash mid-append) is cut before the first window, and never appears in one` — Crash fragment is cut before first window, never joined, and next append follows whole output; detects initial cache reading torn bytes.
- **KEEP** `concurrent windows of one call never join a chunk twice` — Concurrent windows and append race produce each chunk once, then exact complete tail; detects concurrent cache scans double-applying output.
- **KEEP** `readItem follows updated item payloads and thread recreation` — Updated activity returns v2, multipart message yields Hello, unknown absent, recreation yields v3; detects stale item cursors or reading only final message delta.
- **KEEP** `readItem reconstructs a multipart message whose earlier deltas aged out of the resident window` — Message deltas separated beyond retention reconstruct first last; detects window eviction permanently losing earlier message text.
- **KEEP** `full message reads preserve rewind survival and exclusion after window retention` — Full message read keeps retained answer and rejects reverted answer after retention pressure; detects fallback history bypassing rewind semantics.
- **KEEP** `an item line that no longer checks out under its cursor is read from the whole log, and the cursor starts over` — An item line rewritten under a cached cursor falls back to the previous real item and stays correct on repeat; detects wrong-id line trust.
- **KEEP** `a line that does not decode ends the join for good, as it ends readLog: nothing past it is ever joined or re-read` — Malformed log line permanently ends whole/window/item reads despite later appends; detects cache reading past corruption.
- **KEEP** `a log that does not continue an entry's cursor — rewritten, or shorter — is read again from its start` — Changed-length/replaced/shortened log rebuilds from beginning and drops old text; detects stale cursor authority.
- **KEEP** `a thread deleted while its output is read returns only the recreated thread's output` — Deletion while a real filesystem read is gated returns only recreated output; detects publishing a scan from a deleted generation.
- **KEEP** `a line whose seq does not climb ends a cold build's join for good, as it ends readLog` — Repeated sequence in a cold log stops both whole/window output before corrupt chunk and later append stays excluded; detects sequence integrity bypass.
- **KEEP** `an append that fails and is rolled back never reaches the cache — not even read while its bytes were on disk` — Fsync failure exposes bytes physically but warm window excludes them, rollback restores length and next tail is one/two; detects indexing unacknowledged output.

## Support and production seams

Before removal, repository-wide references were searched. `gitCommonDirEntries` has only the concurrent-capture assertion as a caller; removed it and its `readdir` import from checkpoints/test-support.ts. Retained production helper exports all have real callers (listed above); none is removed merely because tests also import it. Local imports made unused by deletions and the unused `logged` revert overload are removed. No fixture/snapshot files are orphaned.

## Validation result

The complete sixteen-file focused run passed: **271 tests, 18 suites, zero failures/skips**. The interrupted pre-edit baseline had reached 76 top-level cases without a reported failure; it was not rerun after the host interruption. The final single-file tool-output rerun passed **21/21**, verifying the last foreign-completion consolidation. `git diff --check` passed for the scope; the final source diff was reviewed. Root integration runs repository typecheck/test gates.

Original declaration dispositions: **263 KEEP, 7 REWRITE, 5 DELETE** (275 total). The unavailable-index declaration expanded to three cases; seven expanded cases plus three redundant schema-version variants were deleted. Seven test files changed, along with one dead support helper: **11 lines added and 203 removed (net −192)**. Production behavior is unchanged.
