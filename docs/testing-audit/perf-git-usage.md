# Incoming Git and Codex quota performance change audit

Source: `ee5c32495c88e39ff8cfef73dce8d43e59f4483f` (`ee5c3249`) versus `610d3c53`.

This supplement covers all ten newly added test identities, their production owners and two manual benchmarks. It also updates the older Git overflow owner used for consolidation. That older owner is already counted by the daemon-root audit; do not add it to repository baseline counts again. Prior daemon-root cleanup remains intact.

## Completed cleanup

- Ten new declarations become five survivors; the existing strengthened error owner remains one declaration. Across the eleven scoped declarations, six survive and five executions/fixtures are removed.
- Dispositions across those eleven identities: DELETE 1, CONSOLIDATE 4, REWRITE 5, KEEP 1. The incoming ten alone are DELETE 1, CONSOLIDATE 4, REWRITE 4, KEEP 1.
- Test LOC this round: 855 → 816 (-39). The measurement starts immediately after the merge/release, so earlier cleanup is excluded from this delta.
- No production behavior or optimization changed. Both manual benchmark files are byte-identical to the incoming commit. No dependency, snapshot or new production seam was introduced.
- Removed duplicate scratch fixtures, private exact invocation/count assertions and the now-unused tokenCount payload parameter. Every remaining filesystem fixture registers teardown.

## Every audited identity

Each heading names the exact test identity at `ee5c3249`. Current names and consolidation owners are explicit below. The JSON companion contains the same evidence in machine-readable form.

### apps/daemon/src/git.test.ts — status reads a work tree in one git invocation and preserves porcelain paths

Disposition: **REWRITE**.

Current owner: `apps/daemon/src/git.test.ts:81` — status preserves porcelain branch metadata and paths.

- **Independent contract:** GitStatusResponse transport contract in packages/api/src/index.ts:634; GitService.status documented nonrepo empty state; Git porcelain-v2 -z wire format and GitError native diagnostics; AGENTS.md preserve remote routing errors.
- **Real regression:** Git panel loses spaced/renamed/original paths, staged-vs-unstaged flags or branch/upstream divergence while reading native porcelain-v2 records.
- **Independent oracle:** Literal expected public object independently specified by the supplied wire records; no production parser used to derive it.
- **Stable seam:** public GitService.status at native Git stdout protocol
- **Refactor resistance:** Surviving verification observes public GitService.status at native Git stdout protocol and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Existing real box status case covers ordinary modified paths but not this exact spaced rename old-path wire encoding and branch.ab projection.

Implemented: Rename to status preserves porcelain branch metadata and paths; remove exact calls==[[status,...]] assertion. Fixture must answer valid rev-parse with true as well as status records so a behavior-preserving preflight refactor does not fail. No independently specified exact subprocess count; benchmark reports cost instead.

### apps/daemon/src/git.test.ts — status retains its empty state for non-repositories and bare repositories

Disposition: **KEEP**.

Current owner: `apps/daemon/src/git.test.ts:102` — status retains its empty state for non-repositories and bare repositories.

- **Independent contract:** GitStatusResponse transport contract in packages/api/src/index.ts:634; GitService.status documented nonrepo empty state; Git porcelain-v2 -z wire format and GitError native diagnostics; AGENTS.md preserve remote routing errors.
- **Real regression:** Status returns HTTP500 instead of documented empty repo state for ordinary folders or native bare repos after eliminating preflight.
- **Independent oracle:** Literal isRepo:false/null metadata/zero divergence/empty files from two real filesystem states; native git --bare fixture sets up the unsupported worktree state.
- **Stable seam:** public GitService.status with actual native Git process and temporary directory
- **Refactor resistance:** Surviving verification observes public GitService.status with actual native Git process and temporary directory and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Existing workingDiff nonrepo test invokes another public operation; real box status test has a valid worktree. Neither catches this compatibility branch.

Retained unchanged. Retain current fixture: no commit/server startup, one minimal native bare init and deterministic cleanup.

### apps/daemon/src/git.test.ts — status preserves a work tree failure's original details

Disposition: **CONSOLIDATE**.

Surviving owner: git.test.ts :: status failures preserve uncapped overflow and native error details.

- **Independent contract:** GitStatusResponse transport contract in packages/api/src/index.ts:634; GitService.status documented nonrepo empty state; Git porcelain-v2 -z wire format and GitError native diagnostics; AGENTS.md preserve remote routing errors.
- **Real regression:** Failed status is swallowed into empty nonrepo state or original diagnostic lost despite worktree being valid.
- **Independent oracle:** Literal status500 and fatal: unable to read index are now asserted by the existing shared status-failure owner, separately from its stdout maxBuffer length exceeded case.
- **Stable seam:** public GitService.status error result at native Git process boundary
- **Refactor resistance:** Surviving verification observes public GitService.status error result at native Git process boundary and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Current incoming argv call sequence is private structure. Unique needed status/error detail can be owned by existing maxBuffer failure scenario.

Implemented: removed this duplicate declaration and private exact CLI call matrix. Existing strengthened error owner now checks two independently meaningful native failure modes: uncapped stdout overflow (message fallback) and status failure with stderr (stderr precedence); both must preserve status500 and exact external diagnostic.

### apps/daemon/src/git.test.ts — status propagates box routing errors without retrying

Disposition: **DELETE**.

Surviving owner: apps/daemon/src/boxes/remote/exec/git.test.ts :: a box that is not connected is a 409 BOX_NOT_READY GitError; host projects keep the host runner.

- **Independent contract:** GitStatusResponse transport contract in packages/api/src/index.ts:634; GitService.status documented nonrepo empty state; Git porcelain-v2 -z wire format and GitError native diagnostics; AGENTS.md preserve remote routing errors.
- **Real regression:** Disconnected box routing metadata wrongly converted to nonrepo state.
- **Independent oracle:** Literal GitError409/BOX_NOT_READY are meaningful, routes==1 is private call count without independently specified retry policy.
- **Stable seam:** public GitService.status route error
- **Refactor resistance:** Surviving verification observes public GitService.status route error and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Superseded by boxes/remote/exec/git.test.ts real disconnected registry case with the same public409/code and host/box routing boundary.

Implemented: Delete incoming duplicate. Keep existing real disconnected-box owner; do not retain exact route collaborator count as perf regression test.

### apps/daemon/src/git.test.ts — an overflow on a read that did not ask for a cap is still an error

Disposition: **REWRITE**.

Current owner: `apps/daemon/src/git.test.ts:502` — status failures preserve uncapped overflow and native error details.

- **Independent contract:** GitStatusResponse transport contract in packages/api/src/index.ts:634; GitService.status documented nonrepo empty state; Git porcelain-v2 -z wire format and GitError native diagnostics; AGENTS.md preserve remote routing errors.
- **Real regression:** A truncated status read is accepted as partial success, swallowed into empty nonrepo state, or replaced with unrelated diagnostic.
- **Independent oracle:** Literal status500 plus stdout maxBuffer length exceeded for empty-stderr overflow, and fatal: unable to read index rather than status failed for native stderr precedence. Error inputs and expected messages are fixed fixture data, independent from GitService implementation.
- **Stable seam:** public GitService.status at native process failure boundary
- **Refactor resistance:** Surviving verification observes public GitService.status at native process failure boundary and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Owns uncapped output failure, preservation of original status error and stderr precedence. WorkingDiff intentionally accepts bounded output and cannot supersede this. One declaration shares fixture structure without sharing mutable GitService state.

Implemented: renamed survivor to status failures preserve uncapped overflow and native error details. Separate fresh GitService per each of two supplied native errors: overflow with no stderr and failure with stderr. Literal status500 and expected diagnostic required; no calls/count/argv assertions.

### apps/daemon/src/usage-sources.test.ts — Codex fallback keeps the newest reading with CRLF, malformed trailing lines, and no final newline

Disposition: **CONSOLIDATE**.

Surviving owner: usage-sources.test.ts :: Codex fallback finds a reading before multiple chunks of newer non-usage events.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Valid newest quota is lost behind whitespace, incomplete trailing line or CRLF splitting.
- **Independent oracle:** Literal percent37 from last valid matching event; older10 must not win.
- **Stable seam:** public createCodexSource over on-disk rollout JSONL
- **Refactor resistance:** Surviving verification observes public createCodexSource over on-disk rollout JSONL and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Simple newest-line/malformed handling already lower-owner usage-parse.check.ts; fold CRLF/no-final-newline into independently necessary multi-chunk source scenario without another temp fixture.

Implemented: Delete standalone case after folding two distinct readings, CRLF and malformed nonterminated tail into multi-chunk-noise owner.

### apps/daemon/src/usage-sources.test.ts — Codex fallback finds a reading before multiple chunks of newer non-usage events

Disposition: **REWRITE**.

Current owner: `apps/daemon/src/usage-sources.test.ts:25` — Codex fallback finds a reading before multiple chunks of newer non-usage events.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Backward scan gives up before older quota event when recent tool-output records have no quota, or selects earlier valid value.
- **Independent oracle:** Literal quota12 from most recent matching record despite later JSONL noise; earlier10 distinguishes ordering, independent of scanner implementation.
- **Stable seam:** public createCodexSource over persisted multi-record rollout file
- **Refactor resistance:** Surviving verification observes public createCodexSource over persisted multi-record rollout file and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Small parser unit arrays do not exercise multiple physical reads; long-single-record owner tests byte reconstruction instead of scanning many newer complete records.

Implemented: Retain bounded ~400KiB fixture; add CRLF/older reading/malformed nonterminated tail here and remove redundant standalone small formatting test.

### apps/daemon/src/usage-sources.test.ts — Codex fallback joins UTF-8 bytes split across the backward read boundary

Disposition: **CONSOLIDATE**.

Surviving owner: usage-sources.test.ts :: Codex fallback handles a long token-count record with a split UTF-8 plan.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Independently decoding chunks corrupts observed non-ASCII plan label while JSON remains syntactically valid.
- **Independent oracle:** Literal Pro🦝 plan and21 percent; expected label does not come from scanner.
- **Stable seam:** public createCodexSource returned plan and quota
- **Refactor resistance:** Surviving verification observes public createCodexSource returned plan and quota and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Important unique observed byte preservation, safely combine with large-record scenario using observed plan emoji at deliberate boundary; ignored emoji alone does not catch lossy decoding.

Implemented: Delete standalone after folding its observed plan assertion/boundary placement into long-record owner; preserve calculated fixture alignment, not production-derived expected output.

### apps/daemon/src/usage-sources.test.ts — Codex fallback handles a token-count record longer than several chunks

Disposition: **REWRITE**.

Current owner: `apps/daemon/src/usage-sources.test.ts:31` — Codex fallback handles a long token-count record with a split UTF-8 plan.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Valid long JSONL record is truncated/discarded or observed UTF-8 plan byte sequence decoded separately across reads.
- **Independent oracle:** Literal quota42 and Pro🦝 label from one >320KiB valid JSON record, plus known unparseable tail. Place observed emoji across current read boundary; changing reader chunk size leaves valid fixture and expected result unchanged.
- **Stable seam:** public createCodexSource over a complete long UTF-8 JSONL record
- **Refactor resistance:** Surviving verification observes public createCodexSource over a complete long UTF-8 JSONL record and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Many ordinary short records do not exercise multi-read assembly of one line; byte codec checks lack filesystem read boundary. Combines two originally distinct regression modes into one fixture.

Implemented: Keep large ignored string to cross several reads; add observable plan_type and align its emoji across boundary before malformed trailing filler. Assert quota42+planPro🦝 once, one source call.

### apps/daemon/src/usage-sources.test.ts — Codex fallback preserves the newest matching event even when its rate limits are unusable

Disposition: **REWRITE**.

Current owner: `apps/daemon/src/usage-sources.test.ts:45` — Codex fallback preserves the newest matching event even when its rate limits are unusable.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Unusable newest quota silently resurrects older same-file value; fallback to earlier rollout fails; signed-in/no-readable-quota incorrectly reported as logged out.
- **Independent oracle:** Noauth+latestinvalid ->null despite prior7; write auth_modechatgpt ->literal available/stale/null-window object; older rollout19 ->19. File mtimes fixed independently.
- **Stable seam:** public createCodexSource fallback/auth state and persisted rollout ordering
- **Refactor resistance:** Surviving verification observes public createCodexSource fallback/auth state and persisted rollout ordering and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** usage-sources.check.ts older-file fallback starts newest file with no token event; it cannot catch invalid latest matching event incorrectly falling back inside same rollout. Signed-only state distinguishes authenticated updating UI.

Implemented: Keep invalid/latest and older-rollout assertions; fold no-usable-reading signed-in state from final new case before writing older rollout. No real network token fixture. Remove duplicate empty/no-match large fixture.

### apps/daemon/src/usage-sources.test.ts — Codex fallback keeps empty and no-match rollouts signed in only when auth says so

Disposition: **CONSOLIDATE**.

Surviving owner: usage-sources.test.ts :: Codex fallback preserves the newest matching event even when its rate limits are unusable.

- **Independent contract:** Persisted Codex rollout JSONL token_count/rate_limits format; createCodexSource public quota fallback compatibility; usage-parse.check.ts last matching event oracle; usage-sources.check.ts API-unavailable/auth/home fallbacks; UTF-8 JSON text preservation.
- **Real regression:** Codex widget reports not linked despite auth when no quota payload exists, or claims sign-in without auth.
- **Independent oracle:** Literal signed-in stale no-window object is unique; repeated empty/null/no-match calls and200KiB irrelevant string add no distinct owner protection.
- **Stable seam:** public createCodexSource authenticated no-usable-reading state
- **Refactor resistance:** Surviving verification observes public createCodexSource authenticated no-usable-reading state and literal public outcomes, so internal function names, chunk sizes, extra preflights and implementation subdivision may change without breaking it.
- **Unique protection:** Consolidate auth state into invalid-latest payload owner; empty and nonmatching records ultimately have same documented no-usable-reading behavior, and no-match traversal already exercised by multi-chunk owner.

Implemented: Delete standalone after adding auth state assertion to latest-unusable-event case; no giant no-match string needed.

## Existing owners retained

- `usage-parse.check.ts`, lines 77–86: the simple JSONL codec selects the last matching token-count event and ignores empty or malformed entries. New filesystem scenarios add long-read, line reconstruction and byte preservation failure modes.
- `usage-sources.check.ts`, `codexTests`: API 500 fallback to an older rollout, subscription/API-key distinction, missing-auth or missing-token scrape fallback, full plan/weekly/asOf projection. Its prior scratch-directory cleanup remains intact.
- `boxes/remote/exec/git.test.ts`, “a box that is not connected is a 409 BOX_NOT_READY GitError; host projects keep the host runner”: real registry routing owns the failure code. The incoming route callback counter adds no independent contract.

## Production and developer tooling

Status executes native porcelain read first; on uncoded generic500 only checks isRepo to distinguish nonrepo/bare from valid worktree and rethrows original failure. Coded route errors retain status/code without second route. Keep production optimization; caller-visible contract unchanged.

Private lastCodexRateLimits reads backward in64KiB chunks, joins pending raw byte pieces once to avoid repeated giant-line prepends, scans newest complete lines and always closes handle in finally. Retains newest matching unusable payload and outer next-rollout fallback. Keep optimization; no test-only export added.

- **apps/daemon/src/git.bench.ts: KEEP developer tool (outside suite accounting)**. Explicit reproducible disposable native repositories; warmups,15 batches×10calls, median/p95 batch mean and observed subprocesses/call; optional module path supports real revision comparison. Real runner injection is existing remote production API. Opt-in .bench.ts is not matched by test/check package gates. Snapshot repeated assertions are equivalence controls, not independent regression-protection claims. Do not delete useful profiling tool merely because not default-called. No bench executed by auditor; measured speedup not claimed. Snapshots derived per loaded implementation validate intra-run consistency; compare output between revisions before any performance claim.
- **apps/daemon/src/usage-sources.bench.ts: KEEP developer tool (outside suite accounting)**. Disposable credential-free rollout fixtures, setup excluded,3warmups+10measured runs of1/16/64MiB histories/no-match/long-record; wall and CPU medians; optional module path supports before/after. Existing public createCodexSource, no new production hook. Deliberately expensive opt-in benchmark never required CI. No bench executed. Full expected snapshot comes from initial small reading, so it controls semantic equivalence across scenarios, not complete independent source validation. Real native tests own behavior.

These opt-in `.bench.ts` programs are outside the required `.test.ts`/`.check.ts` gates. Their repeated equality checks control measurement equivalence; they are not counted as independently protective regression tests. Their measurements have not been run or claimed in this supplement.

## Validation and performance

`git diff --check -- apps/daemon/src/git.test.ts apps/daemon/src/usage-sources.test.ts` passed. Manual benchmark files were compared with `ee5c3249` and have no differences.

No tests, typechecks or benchmarks were executed by this delegate because root owns the single validation slot and the matching baseline run. No runtime, CI savings or flakiness claim is made. Required focused commands for root:

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/git.test.ts src/usage-sources.test.ts
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/usage-sources.check.ts
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/usage-parse.check.ts
```

Root owns full validation, comparable baseline/final performance measurement, staging, commit and push. No git delivery actions were performed by this delegate.
