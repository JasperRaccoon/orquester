# Checkpoint test cleanup

Implemented cleanup decisions, recorded before editing. Baseline: **61/61 passed** with the daemon package Node import hooks.

Read AGENTS.md, README, daemon scripts, agent-host module map, checkpoint owners (`git`, `refs`, `numstat`, `capture`, `service`, test support) and GUI design §5.4–§5.5 before decisions.

## `apps/daemon/src/agent-host/checkpoints/baseline-dispatch.test.ts`

Independent contract: GUI design §5.4 capture before provider execution; checkpoint failure must never fail the turn.
Production callers and stable seam: orchestration turn dispatch through CheckpointService; real service/capture/Git for baseline artifact.
Failure modes listed before retention: provider startup edits disappear into baseline; unavailable Git blocks message delivery.
Stronger remaining coverage: orchestration/fix-wave duplicate call-order test deleted by owner; checkpoint service sparse-count test and orchestration placeholder tests retain ready-baseline behavior.
Full retention bar, applied to every explicitly named KEEP/REWRITE below: (1) the concrete protocol/storage/security source above independently establishes the named behavior; (2) its failure loses data, breaks a caller operation or violates isolation rather than merely changing code shape; (3) fixed files, counts, paths and errors are independent expected outcomes, with copied constants/round trips removed where noted; (4) observations use CheckpointService/GitRunner APIs, persisted ref bytes or external Git framing; (5) subprocess plumbing, helper identifiers, cache strategy and staging internals may change while these results remain valid; (6) duplicated lower assertions and private collaborator checks are removed, leaving the lowest owner of each distinct contract.

Risk: production behavior remains unchanged; arbitrary cache reuse, UUID collisions and timed semaphore traces intentionally lose test enforcement because the old tests did not establish a stable caller contract. Validation: focused file with daemon Node import hooks, then all five checkpoint files and repository gates by root.

- **REWRITE** `R5 #6: the pre-turn baseline is captured before the provider is asked` — Replace adapter call-list ordering with real Git baseline bytes and a diff including a provider start write.
- **DELETE** `R5 #6: an already-published baseline is not read as 'no checkpoints here'` — Duplicate direct placeholder helper inspection; service sparse-baseline test proves a published baseline remains ready, orchestration owner retains placeholder running-id/ordinal contracts.
- **KEEP** `R5 #6: a baseline failure never blocks the turn` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.

## `apps/daemon/src/agent-host/checkpoints/git.test.ts`

Independent contract: GUI design §5.4 bounded Git subprocess contract and §3.1 explicit environment; process abort deadline boundary.
Production callers and stable seam: capture.ts and service.ts invoke GitRunner.run; fake executable uses real OS spawn/stdin/stdout/exit via configured PATH.
Failure modes listed before retention: ambient secrets leak into Git; credentials prompt blocks process; nonzero exit lost; timeout leaves operation unresolved; output silently truncated; capture lock errors never retry or non-capture retries; bytes corrupted; aborted job spawns; active abort ignored; streamed records replayed.
Stronger remaining coverage: service.test.ts real repositories own Git content behavior; these cases uniquely own child environment, bounds and stream outcomes.
Full retention bar, applied to every explicitly named KEEP/REWRITE below: (1) the concrete protocol/storage/security source above independently establishes the named behavior; (2) its failure loses data, breaks a caller operation or violates isolation rather than merely changing code shape; (3) fixed files, counts, paths and errors are independent expected outcomes, with copied constants/round trips removed where noted; (4) observations use CheckpointService/GitRunner APIs, persisted ref bytes or external Git framing; (5) subprocess plumbing, helper identifiers, cache strategy and staging internals may change while these results remain valid; (6) duplicated lower assertions and private collaborator checks are removed, leaving the lowest owner of each distinct contract.

Risk: production behavior remains unchanged; arbitrary cache reuse, UUID collisions and timed semaphore traces intentionally lose test enforcement because the old tests did not establish a stable caller contract. Validation: focused file with daemon Node import hooks, then all five checkpoint files and repository gates by root.

- **KEEP** `the child env is exactly what was configured, plus the runner's defaults` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a non-zero exit throws unless the caller allows it` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a hung child is killed at the deadline` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `output over the cap truncates, or fails when the answer must be whole` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a transient lock failure is retried, and only when the caller asked` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `stdin reaches the child byte for byte` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `the permit pool never lets more than its count run at once` — 60ms child timing trace is a scheduling-dependent permit test with no deterministic completion handshake; violates no sleep orchestration rule. Real service concurrent-capture test retains repository-isolation behavior.
- **DELETE** `Semaphore hands out exactly its permits and releases once` — Private Semaphore test duplicates permit implementation and its double-release assertion cannot detect an extra leaked permit because no fourth acquisition is checked.
- **REWRITE** `R5 #13: a streaming scanner is never replayed by the retry` — Emit real child output before transient failure so scanner assertion cannot pass on an empty stream.
- **KEEP** `Q1 #44: an already-aborted signal never spawns a process` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **REWRITE** `Q1 #44: an abort mid-run kills the child and reports the abort` — Wait for real child stdout readiness before aborting; current test aborts before spawn and duplicates pre-aborted signal.
- **REWRITE** `only real lock/ENOENT noise is classified as transient` — Exercise transient classification through run() failure/error.retryable instead of test-only classifier export.

## `apps/daemon/src/agent-host/checkpoints/numstat.test.ts`

Independent contract: git diff --numstat -z external byte protocol; GUI design §5.4 binary file reporting and stable changed paths.
Production callers and stable seam: service.ts captureTurnEnd summary parser.
Failure modes listed before retention: rename consumes wrong next path, binary file vanishes, malformed records crash, newline splits a real filename.
Stronger remaining coverage: service.test.ts turn end diffs against baseline covers ordinary additions/deletions.
Full retention bar, applied to every explicitly named KEEP/REWRITE below: (1) the concrete protocol/storage/security source above independently establishes the named behavior; (2) its failure loses data, breaks a caller operation or violates isolation rather than merely changing code shape; (3) fixed files, counts, paths and errors are independent expected outcomes, with copied constants/round trips removed where noted; (4) observations use CheckpointService/GitRunner APIs, persisted ref bytes or external Git framing; (5) subprocess plumbing, helper identifiers, cache strategy and staging internals may change while these results remain valid; (6) duplicated lower assertions and private collaborator checks are removed, leaving the lowest owner of each distinct contract.

Risk: production behavior remains unchanged; arbitrary cache reuse, UUID collisions and timed semaphore traces intentionally lose test enforcement because the old tests did not establish a stable caller contract. Validation: focused file with daemon Node import hooks, then all five checkpoint files and repository gates by root.

- **DELETE** `reads NUL-delimited numstat records` — Ordinary textual additions/deletions are already proved through real Git by service.test.ts turn-end diff; keep only distinct parser framing edge cases.
- **KEEP** `a rename spends two extra records on the source and the destination` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a binary file reports zero counts rather than being dropped` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `empty and malformed output yields no files` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a path containing a newline survives, because records are NUL-delimited` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.

## `apps/daemon/src/agent-host/checkpoints/refs.test.ts`

Independent contract: GUI design §5.4 persisted refs/orquester/checkpoints/<base64url(threadId)>/turn/<n> contract and namespace isolation.
Production callers and stable seam: service.ts capture, list, prune and delete; ref names survive application versions.
Failure modes listed before retention: new code cannot read historic refs, unsafe thread characters escape namespace, invalid count accepted, another thread/user ref pruned.
Stronger remaining coverage: Service tests derive setup refs from this helper; only these literal byte tests independently protect the persisted format.
Full retention bar, applied to every explicitly named KEEP/REWRITE below: (1) the concrete protocol/storage/security source above independently establishes the named behavior; (2) its failure loses data, breaks a caller operation or violates isolation rather than merely changing code shape; (3) fixed files, counts, paths and errors are independent expected outcomes, with copied constants/round trips removed where noted; (4) observations use CheckpointService/GitRunner APIs, persisted ref bytes or external Git framing; (5) subprocess plumbing, helper identifiers, cache strategy and staging internals may change while these results remain valid; (6) duplicated lower assertions and private collaborator checks are removed, leaving the lowest owner of each distinct contract.

Risk: production behavior remains unchanged; arbitrary cache reuse, UUID collisions and timed semaphore traces intentionally lose test enforcement because the old tests did not establish a stable caller contract. Validation: focused file with daemon Node import hooks, then all five checkpoint files and repository gates by root.

- **REWRITE** `a checkpoint ref is the thread's base64url namespace plus its turn` — Use literal persisted ref bytes instead of rebuilding base64url with production constants.
- **REWRITE** `the namespace stays inside git's safe ref alphabet for an awkward thread id` — Use literal fixed prefix instead of deriving expected prefix from production declaration.
- **KEEP** `an empty thread id or a bad turn count is refused rather than encoded` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **REWRITE** `turn counts round-trip, and nothing else is read as a checkpoint` — Parse fixed historic ref strings rather than writer/reader round-trip from same implementation.

## `apps/daemon/src/agent-host/checkpoints/service.test.ts`

Independent contract: GUI design §5.4 checkpoint trees, 200-ref retention, noninterference, summary/diff protocol; §5.5 conversation-only rollback, sparse turn ordinals and legacy dense refs; host path redaction rule.
Production callers and stable seam: main.ts creates service; orchestration calls CheckpointService methods; Git refs/trees and returned summary/patch/errors are observed.
Failure modes listed before retention: user index/HEAD/branches/stash/reflog altered; ignored file captured; tracked/untracked file lost; wrong diff; baseline fabricated; placeholder or replay shifts numbering; stale turn captures; arbitrary ref pruned; nonrepo capture fails turn; sparse checkout records false deletion; concurrent captures collide; capture/prune error falsely succeeds; post-revert late capture survives; host HOME leaks; resumed turn ordinal wrong.
Stronger remaining coverage: No lower owner can establish real repository noninterference and capture/prune integration; parser tests retain only byte framing edge cases.
Full retention bar, applied to every explicitly named KEEP/REWRITE below: (1) the concrete protocol/storage/security source above independently establishes the named behavior; (2) its failure loses data, breaks a caller operation or violates isolation rather than merely changing code shape; (3) fixed files, counts, paths and errors are independent expected outcomes, with copied constants/round trips removed where noted; (4) observations use CheckpointService/GitRunner APIs, persisted ref bytes or external Git framing; (5) subprocess plumbing, helper identifiers, cache strategy and staging internals may change while these results remain valid; (6) duplicated lower assertions and private collaborator checks are removed, leaving the lowest owner of each distinct contract.

Risk: production behavior remains unchanged; arbitrary cache reuse, UUID collisions and timed semaphore traces intentionally lose test enforcement because the old tests did not establish a stable caller contract. Validation: focused file with daemon Node import hooks, then all five checkpoint files and repository gates by root.

- **KEEP** `captures tracked, staged and untracked files and never an ignored one` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **REWRITE** `the user's index, HEAD, refs, stash and reflog are byte-identical afterwards` — Preserve complete pre-capture user ref values as well as rejecting new refs outside the checkpoint namespace; the previous assertion missed branch deletion. The full six-part bar above applies, with the independent expected value supplied by the untouched pre-action repository.
- **KEEP** `turn end diffs against the baseline and reports the changed files` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a missing baseline keeps the post ref and records an empty file list` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `a baseline is idempotent: the second call captures nothing` — Existing-baseline idempotence and unchanged commit are covered by the stronger sparse 26→27 scenario, including next turn reusing published completion.
- **KEEP** `a placeholder checkpoint is reused at its own turn count` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a turn that already has a real checkpoint is skipped` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `only the session's active turn produces a completion checkpoint` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `readTurnDiff: equal turns short-circuit without touching git` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `readTurnDiff ignores whitespace by default and can be told not to` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `readTurnDiff caches by (thread, from, to, whitespace)` — Artificially deleting a ref and expecting cached data pins cache strategy; behavior-preserving removal of cache would fail.
- **KEEP** `readTurnDiff refuses a turn above the thread's highest checkpoint` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **REWRITE** `captures prune to the 200-ref cap, oldest first` — Use literal independently specified 200-ref limit instead of deriving setup and expectation from production limit.
- **KEEP** `pruneAbove deletes every ref above the target and nothing else` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `deleteThreadRefs removes every ref under the thread's prefix and nothing else` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a non-git directory is a silent no-op on every path` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `an untracked embedded repository does not break capture` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a cone sparse checkout captures skipped files instead of deleting them` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `concurrent captures on two threads of one repo do not corrupt each other` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a repository with no commits at all still captures a baseline` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `a capture failure is reported, never thrown into the turn` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `assertRollbackSupported refuses grok and allows every other adapter` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `R5 #10: a turn whose baseline is missing diffs against HEAD, not 404` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `R5 #10: a baseline pruned by the cap still answers a diff` — Deleting the baseline simulates the same missing-from-ref branch already covered by missing-baseline HEAD fallback; no distinct retained failure.
- **KEEP** `R5 #10: with no HEAD at all the fallback is the empty tree` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `R5 #11: a stale turn end for a turn that never started is refused` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `R5 #11: a replayed turn end is refused even with no fold rows to check` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `R5 #20: a non-cone sparse checkout that cannot be rebuilt fails the capture` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `R5 #20: a stale temp-index lock does not poison the next capture` — Manufactures a repeated UUID through a test-only hook. Production generates unique temporary names; real concurrent captures retain cleanup/isolation checks.
- **KEEP** `Q1 #42: a ref that survives deletion fails the prune instead of reporting success` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `E2E #E8: a capture for a turn a revert truncated is dropped` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **DELETE** `R5 #14/Q1 #43: the diff cache is bounded by bytes, not only by entries` — Never drives cache byte eviction; compares exported constants and repeats cached-data-after-ref-deletion behavior.
- **REWRITE** `S1 #9: a failure detail collapses the host's home path to ~` — Require actual ~ replacement as positive control as well as absence of raw HOME; an empty detail must not satisfy redaction.
- **KEEP** `§5.5: a named turn count numbers the baseline and the turn end — a sparse 26 → 27 pair` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `§5.5: a named turn count wins over a placeholder's count and over the derived counter` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `§5.5: a turn count no ref can carry is ignored, never thrown into the turn` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.
- **KEEP** `§5.5: pruneAbove also deletes the dropped turns' own counts, however low` — Retains the concrete failure/expected outcome stated by this case; the full six-part bar above applies at this owner.

## Removed production seams and support

- Removed binary-resolver injection (fake executable now uses configured PATH), deterministic UUID option and CaptureInput UUID, unused concurrency override, private Semaphore/classifier/resolver exports and cache-limit export inventory. Production still uses its original eight permits, native UUIDs, PATH resolution, timeouts and caps.
- Removed stale UUID fixture, timed trace mode and direct semaphore setup. Real temporary-repository helpers remain used. The remaining trace mode only proves pre-aborted work never spawns.

## Validation

Baseline command from `apps/daemon`: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/agent-host/checkpoints/*.test.ts` — 61 passed. Final command (same five files): **52 passed, 0 failed**. Log: `/tmp/orquester-test-cleanup/host-checkpoints-final.log`. All checkpoint production/test diffs reviewed; final repository gates are owned by the root agent.

Additional dead-seam decisions before removal: repository-wide reference searches found no production caller of `GitRunner.env`, exported Git bounds/retry constants, `CHECKPOINT_REFS_PREFIX`, service limit constants, `Semaphore`, classifier/resolver exports, or capture's internal helper/type exports. The checkpoint barrel is used only for `createCheckpointService`, `CheckpointRefUnavailableError`, and `CheckpointTurnRangeError`; its other forwarding exports only enlarged the internal test-facing surface. Remove those unused exports/observer fields along with the planned injection options. Keep GitRunner's real per-operation timeout/output limits, abort signal and stdout scanner: capture and service use them for bounded recovery, complete diffs and index scans.

Final scope: **9 DELETE, 10 REWRITE, 42 KEEP** (61 original named cases; 52 remain). The repeated six-part records above apply individually to the listed cases; fixture setup was changed from binary-resolver injection to the configured PATH across runner cases without changing their assertions. Historical “E2E #E8” is a checkpoint-service Git integration regression, not an extra end-to-end replay of a GUI workflow. The deleted one-permit override test never exercised the specified production limit of eight; it only pinned a test-configured schedule.

Cross-scope rewrite recorded before editing: extend the existing real Git baseline-dispatch regression to include the next turn and an in-flight steer. The independent §5.5 ordinal contract requires both to retain the prior completion at turn/1 rather than capture premature turn/2. Observe literal Git tree bytes and ref absence after real orchestrator commands; no collaborator count expectations. This absorbs `orchestration/orchestrator.test.ts`'s private `baselineRequests [1,1]` assertion, which its owner deletes. The independent failure is a partial tree published as the new turn's completion; ordinary service supplied-ordinal tests cannot catch the caller selecting the wrong ordinal.

Final-review rewrite recorded before editing: the repository noninterference case checked only *new* refs and could miss deleting a user's existing branch. Compare the complete non-checkpoint ref inventory to the pre-capture snapshot as well. The fixed pre-action repository is the independent expected result, and deleting or rewriting `main`/`feature` now fails through real Git state. This upgrades that case from KEEP to REWRITE without introducing a new seam.

Validation follow-up: the extended real-Git dispatch/steer case passed (**2/2** file cases). `pnpm --filter @orquester/daemon typecheck` reported no checkpoint errors, but failed on parallel edits outside this scope (`summary.settleMs`, `main.buildRefIdIndex`, goals ingestion observer, slash test arity, workflow timer options and MCP schema export); root owns the final integrated typecheck. `git diff --check -- apps/daemon/src/agent-host/checkpoints docs/test-cleanup/host-checkpoints.md` passed.
The final noninterference assertion rewrite was verified with the focused service file: **32 passed, 0 failed** (`host-checkpoints-service-final.log`). Focused file commands were run from `apps/daemon`, using the Node imports shown above.
