# Incoming streaming index and history-query cleanup

Source `ee5c32495c88e39ff8cfef73dce8d43e59f4483f`, compared with `610d3c53`. Audit scope is exactly two new test declarations and the new manual benchmark; existing index tests were read for stronger coverage and are not recounted as new audit rows.

Disposition: DELETE1, REWRITE1; one of two added test declarations survives. Net automated test LOC −70. Production indexing/query optimizations and `history.bench.ts` are unchanged.

Scoped `git diff --check` passed. The exclusive8-file backend control run passed193/193 in23suites, with no failures/skips. Intended wrong-fallback mutation failed and the restored control passed. No comparable baseline/CI speedup is claimed; the manual benchmark was not executed or changed.

## `apps/daemon/src/agent-host/index/indexer.test.ts:142`

**DELETE** — streamed rows follow the current open turn through adoption, revert and a new turn

Fails unique-protection bar6. Existing public database-owner tests already prove current-turn extension/adoption, frozen survivor ranges after revert, new ordinal reuse after revert, mid-stream text and multiple chunk updates. The new sequence adds no distinct independent state/error/output absent from these owners and never isolates a new cache-specific user-visible failure. No assertions of private WeakMap identity or scans should replace it.

- **independentContract:** docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md §C Maintenance/History page; apps/daemon/src/agent-host/README.md indexer/queries contracts; AGENTS durable log/cache rules: log-ordered byte ranges follow open turn and revert seals survivors.
- **realRegression:** Misattributed page bytes, missing streamed tail or reopening a reverted range are meaningful failures.
- **independentOracle:** Fixture TestLog supplies serialized byte positions independent of SQLite indexer; fixed t1/t2/t3 identities and row bounds are valid.
- **stableSeam:** ThreadIndex.observe/drain/turnByOrdinal over real temporary SQLite file.
- **refactorResistance:** Only persisted public rows/byte bounds, not WeakMap/cache collaborator shape.
- **uniqueProtection:** FAIL: stronger retained owners listed below already exercise these outcomes; no uniquely necessary assertion found.

Stronger retained owners:

- `apps/daemon/src/agent-host/index/indexer.test.ts:99` — derives turn rows: ordinals, timestamps, prompt, and byte ranges that tile the log: Exact first/last sequence+byte ranges across adoption and streamed writes, current cursor, turn IDs.
- `apps/daemon/src/agent-host/index/indexer.test.ts:298` — follows the fold's text rule: a final text replaces, an empty one keeps, a reopened message continues: Streamed chunks/reopened messages retain semantic text correctly.
- `apps/daemon/src/agent-host/index/indexer.test.ts:381` — a revert drops the removed turns and everything from their first line on, and closes every range: Preserved survivor bytes and new live turn at reused ordinal after revert/restart.
- `apps/daemon/src/agent-host/index/indexer.test.ts:643` — nothing extends a range across a revert — not even a late event naming the turn: Late referenced row cannot reopen retained survivor, including across restart.
- `apps/daemon/src/agent-host/index/indexer.test.ts:672` — a revert clips a surviving turn at the cut: a late event's stretch never brings the removed turns back: Actual byte clipping and page event membership, including restart and further late writes.
- `apps/daemon/src/agent-host/index/queries.test.ts:889` — a revert takes the reverted turns' prompts and their steers with it: Same-resident/no-restart revert followed by new adopted live turn reuses ordinal2 and persists new IDs while removing old turns/prompts.

Delete only the added30-line declaration. All its imports are used elsewhere; no supporting fixture or production cache seam becomes orphaned. Keep upstream openPositions optimization unchanged.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-host/index/indexer.test.ts src/agent-host/index/queries.test.ts`. Passed in the exclusive193-case backend control target; rewritten query failed the intended wrong-fallback mutation and passed restored control.

## `apps/daemon/src/agent-host/index/queries.test.ts:483`

**REWRITE** — turnOfSeq preserves containment priority, tied starts, gaps, and malformed-row rejection

Real independently specified history ownership/cache compatibility is trapped inside a copied legacy-SQL oracle and partly false-positive malformed-row fixture. Remove copied SQL and46query comparisons; retain minimal independently hand-derived IDs/nulls, and arrange malformed containing row so a wrong fallback would return a valid different row.

Final alias: `turnOfSeq resolves competing cached ranges and rejects malformed owners without fallback` at `apps/daemon/src/agent-host/index/queries.test.ts:481`.

- **independentContract:** docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md §C Maintenance/History page; apps/daemon/src/agent-host/README.md indexer/queries contracts; AGENTS durable log/cache rules: choose newest containing range; when none, nearest preceding start; tied starts use content ordinal; unreadable selected cache row is rejected. Cache may be written by another build, and cannot leak another thread.
- **realRegression:** Newest ended row incorrectly outranks an older containing row; wrong tied-start ordinal wins; a rejected malformed containing row silently falls back to valid ended history; malformed nearest gap row or foreign thread becomes a page anchor.
- **independentOracle:** Literal hand-chosen older/same-start-earlier/same-start-later/latest IDs for seq28/21/24/45 and null after specific persisted corruption. Delete exact copied old ORDER BY query as expected-value generator.
- **stableSeam:** Prefer existing ThreadIndex fixture/public turnOfSeq after writing explicit schema-compatible cache rows through a second SQLite connection to its temp index.sqlite. The persisted cache boundary is explicitly a retention exception.
- **refactorResistance:** No SQL text/statement count/query-plan assertion. Fixed public page-owner IDs/nulls survive replacing optimized query implementation.
- **uniqueProtection:** Existing overlap test has two containing ranges, but not an older still-containing range over several newer ended ones, tied starts with differing end validity, malformed containing vs valid nearest fallback, or malformed nearest gap row. Existing gap test establishes only normal gap behavior; its positive outcome here is needed as a non-vacuous control before corruption.

Implemented rewrite:

- Reuse current beforeEach temp index.sqlite, open a second native connection for explicit row insertion; observe existing public index.turnOfSeq, avoiding an extra in-memory schema and createThreadIndexQueries/SCHEMA_STATEMENTS imports.
- Use four current-thread rows: older ordinal1 seq2..40; same-start-earlier ordinal2 seq20..25; same-start-later ordinal3 seq20..22; latest ordinal4 seq30..35. Foreign row has seq20..100 ordinal99 so missing inner/outer thread filtering can actually affect the chosen result.
- Retain literal cases: seq28→older;21→same-start-later;24→same-start-earlier;45→latest. Existing test owns ordinary pre-first/overlap/gap semantics.
- Corrupt older.first_byte=-1, then seq28 must be null even though nearest preceding row is valid same-start-later. This fails incorrect `toIndexedTurn(containing) ?? toIndexedTurn(preceding)` fallback.
- Separately corrupt latest.first_byte=-1; seq45 must become null after earlier positive latest control. Ensure db.close in finally.
- Delete legacy statement/46-seq loop and unused direct query/schema imports; leave production seek SQL and cache schema unchanged.

The original negative case corrupted the latest containing row, which the fallback also selected. An incorrect fallback after decoding failure could therefore still return null and pass. The replacement corrupts an older containing range while leaving a valid newer ended range available: that bug now yields the wrong non-null owner.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/agent-host/index/queries.test.ts src/agent-host/index/indexer.test.ts`. Passed in the exclusive193-case backend control target; rewritten query failed the intended wrong-fallback mutation and passed restored control.

## Manual history benchmark

**KEEP as profiling utility** — `apps/daemon/src/agent-host/index/history.bench.ts`

Upstream measured performance commit b14610c8 explicitly uses real SQLite before/after benchmark and query plans; parent confirms preserve useful unrelated manual profiling work. Header documents command, representative10kturn/500chunks workload, per-chunk commits, cold-load exclusion and optional production-revision control. Not orphaned merely because no package test script calls .bench.ts.

Cursor/range/count/text and literal generated-turn checks only prevent accidentally benchmarking dropped work; they do not replace required test contracts or impose a timing gate. The copied historical SQL is explicitly an existing-implementation performance control, not an independent expected-result oracle; SQL plan/source instrumentation is profiling observation, not a change-detector regression test.

No edits. Preserve optional cross-revision execution, temporary-file cleanup, native real SQLite workload, medians and query-plan diagnostics.

Default workload seeds10000real unique turn rows,1cold streaming chunk+7×500measured chunks+finalclose, then7×50old-query control and7×50production boundary lookups. All opt-in; no required CI runtime added.

No execution in read-only phase. Upstream commit timing claims are provenance only, not measurements by this workstream. Historical mode replaces indexer/queries owners while using current schema/dependencies, so compare compatible revisions; do not claim full historical application latency. In-memory SQLite excludes disk append/WAL durability cost and cold initialization by design.

Its copied SQL is a named performance control; its query-plan instrumentation is diagnostic. Neither is counted as independent regression coverage. Workload cursor/range/count/text assertions and literal generated-turn identities prevent accidentally timing dropped work.

## Validated mutation

`cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/perf-index-mutation-loader.mjs --test --test-name-pattern='resolves competing cached ranges' src/agent-host/index/queries.test.ts`

Validated intended null-vs-valid-ended-row failure after applied marker; restored native control passes. Only process-local loader changes production code; repository source hashes unchanged.

## Remaining validation

Root owns final full repository gates and Git delivery. No production schema/cache behavior was changed and no helper/export was removed.


## Executed validation

The exclusive8-file backend target passed193tests/23suites with no failures or skips. Runner: Node24.22.1, TSX cache disabled,4test workers,600,000ms normal per-test cap. Wall9.35s; userCPU10.01s, system3.33s, maxRSS186,076KB. This combined target is not a comparable baseline performance measurement.

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 /usr/bin/time -f '\nwall=%e cpu_user=%U cpu_system=%S max_rss_kb=%M' node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/index/indexer.test.ts src/agent-host/index/queries.test.ts src/git.test.ts src/usage-sources.test.ts src/knowledge/search/search.test.ts src/knowledge/linking/service.test.ts src/devices/hosts/box/android-host.test.ts src/boxes/temporary/tools.test.ts > /tmp/orquester-test-audit/ee5-backend-controls.log 2>&1
```

The process-local wrong-fallback mutation printed its applied marker and failed the rewritten assertion: actual `same-start-later` ordinal3/seq20–22 was returned where the malformed containing row required null. The restored one-case control passed in18.800029ms.

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/perf-index-mutation-loader.mjs --test --test-name-pattern='resolves competing cached ranges' src/agent-host/index/queries.test.ts > /tmp/orquester-test-audit/ee5-query-fallback-mutation.log 2>&1
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-name-pattern='resolves competing cached ranges' src/agent-host/index/queries.test.ts > /tmp/orquester-test-audit/ee5-query-restored-control.log 2>&1
```

The first temporary loader attempt matched no target because tsx omitted the return semicolon. Only its out-of-tree regex was corrected; that loader error was not counted as regression detection. SHA256 hashes of indexer.ts, queries.ts and both test files matched before/after all executions; exact hashes are in the JSON ledger.
