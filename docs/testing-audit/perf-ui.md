# Incoming UI performance changes: test disposition

Scope: six declarations newly added in ee5c32495c88e39ff8cfef73dce8d43e59f4483f versus 610d3c53, plus a consolidation into one existing rollback owner. Prior existing tests retain their earlier ledgers.

Disposition: DELETE 3, CONSOLIDATE 1, REWRITE 2. Two incoming declarations survive; zero new replacement declarations. Test LOC is −77 against the integrated incoming tree. Existing rollback-owner modification overrides its prior row, adding no audit/test count.

Cleanup and native graph dictionary fix implemented and focused validation completed. Internal dictionaries have no inherited keys; public results remain plain objects. Net scope delta is −78 LOC: tests −77, production −1.

Two focused rows+graph controls passed 66/66, zero failures/cancellations/skips. The new graph case first failed the unchanged implementation for the intended missing __proto__ own key. Both graph-revert and omitted-rollback-context mutants failed intended direct assertions; source hashes restored exactly in finally. Graph benchmark confirmed exact ordinary chain/star/disconnected positions/order against ee5. Public object prototype/own-key probe passed. Scoped syntax/diff checks passed. No full-package/typecheck gates run by this child; root coordinates those.

The graph regression protects an independently verified native input contract: daemon parseConcept and UI parseConceptRef accept any nonempty ID string. Inherited NaN/property-order expectations were removed. The fix preserves normal coordinates and ordinary plain returned objects; both were checked.

Benches remain documented manual development tools, outside the test runner. Their prior/current self-comparisons are diagnostic equivalence checks rather than independent regression oracles. No test-suite speedup is claimed without matching focused baseline timing. Registry icon change is a React.lazy props generic only and requires normal UI typechecking.

## packages/ui/src/lib/agent-chat/rows.logic.test.ts:101 — reuses the projection when entries and every rendering input stayed the same

**DELETE**.

Projection-object identity is a memoization implementation detail. The later stable-row owner preserves actual rendered row data; no independently specified caller requires the wrapper object to be the same object. Public streaming/liveness contracts remain below.

Failed bar: independent contract, stable externally meaningful seam, unique protection.

## packages/ui/src/lib/agent-chat/rows.logic.test.ts:107 — invalidates unchanged entries when any rendering context moves

**CONSOLIDATE**.

The17-field patch inventory mirrors shallowEqualInput and requires new object identity even where rendered data do not change. Comparing incremental rows to a cold call of the same implementation is not an independent oracle. Preserve a meaningful capability-change invalidation by making the existing rollback owner pass its first projection into the second call.

Failed bar: independent oracle, refactor resistance, unique protection.

Remaining owner(s): packages/ui/src/lib/agent-chat/rows.logic.test.ts: offers rewind only where the adapter supports rollback; packages/ui/src/lib/agent-chat/rows.logic.test.ts: gives a pending turn's prompt none until the provider starts it; packages/ui/src/lib/agent-chat/rows.logic.test.ts: a moved context re-derives: the streamed-text fast path never keeps a stale streaming row; packages/ui/src/lib/agent-chat/rows.logic.test.ts: re-derives when only the phase moved — the streaming fast path must not swallow it.

## packages/ui/src/lib/agent-chat/rows.logic.test.ts:129 — leaves every reasoning group untouched while the assistant streams

**DELETE**.

Group object identity at the intermediate projection is a performance implementation probe, while the output assertion derives expectations from the same projector. Existing streamed-token owner asserts literal updated assistant text/liveness; the rewritten multi-group owner preserves actual group text and earlier snapshots.

Failed bar: independent contract, independent oracle, unique protection.

## packages/ui/src/lib/agent-chat/rows.logic.test.ts:143 — updates multiple reasoning groups and the assistant together without mutating their previous rows

**REWRITE**.

- contract: GUI design §7.2–7.3 messages retain separate reasoning groups across commentary boundaries; a streamed update must display every changed message and retained previous projections must remain valid inputs for stable React rows.

- credibleFailure: Only one changed reasoning group is rebuilt, a replacement overwrites another group, assistant text stays stale, or mutation of old group entries defeats stable-row change detection.

- oracle: Fixed authored text pairs first/second thought and answer before and after updates, selected by known message IDs. Do not compute expected rows through a second projector or compare private array identity.

- seam: Actual deriveTimelineEntriesFromItems→deriveTimelineRowsWithState over successive frames, which store/hooks consume.

- refactorResistance: Assert semantic text and unchanged previous text, allowing row object allocation/identity and implementation strategy to change.

- uniqueProtection: Existing two-thought clock cases update thoughts inside one fold and assert durations; assistant case updates one answer. Neither checks simultaneous message data in two reasoning groups plus an answer.

- rewrite: Drop structuredClone-wide row equality, group-count and object/array identity assertions, and the cold projector oracle. Keep only independently authored per-message old/new text assertions.

## packages/ui/src/components/knowledge/graph-layout.test.ts:123 — preserves the positions and node order across branching rounds, cycles and disconnected concepts

**DELETE**.

Captured old coordinates/property-order are implementation snapshots, not external visual requirements. Existing public finite-node, no-overlap and warm-start coordinate reuse owners protect meaningful outcomes; final native-ID case checks cold/warm results without generated coordinates.

Failed bar: independent contract, independent oracle, refactor resistance, unique protection.

Remaining owner(s): packages/ui/src/components/knowledge/graph-layout.test.ts: places every concept at finite points, ignoring edges it cannot draw; packages/ui/src/components/knowledge/graph-layout.test.ts: keeps concepts from overlapping above the old 150-concept layout boundary; packages/ui/src/components/knowledge/graph-layout.test.ts: reuses shown coordinates when the graph grows or trims, but starts a different graph afresh.

## packages/ui/src/components/knowledge/graph-layout.test.ts:153 — keeps the existing lookup semantics for prototype-named seeds and neighbours

**REWRITE** → returns finite own positions for prototype-named concepts in cold and warm graphs.

The old test’s inherited NaN/prototype side effects and captured coordinates are invalid oracles. But arbitrary nonempty concept ID strings are independently accepted by daemon graph parser and UI bridge validator, so prototype-named IDs are a real native input contract. Rewrite through public computeLayout to require each requested ID as an own key at a finite position, covering cold and warm inputs without freezing exact coordinates.

- contract: Positions for every requested concept, including valid __proto__/constructor IDs, after bridge validation.

- contractSource: apps/daemon/src/knowledge/search/graph.ts: parseConcept accepts any nonempty string ID; packages/ui/src/lib/knowledge/validate.ts: parseConceptRef accepts any nonempty string ID; packages/ui/src/components/knowledge/graph-layout.ts: computeLayout documents positions for every node

- credibleFailure: __proto__ assignment changes the result prototype rather than creating its own position; inherited object members are incorrectly treated as previous positions or neighbouring seeds.

- oracle: Fixed requested ID set and Number.isFinite coordinates; no old implementation values, property order or NaN expectation.

- seam: Public computeLayout and warmStart with authored graph and initial positions, used by graph worker/canvas.

- refactorResistance: Allows any numerical layout algorithm or object allocation preserving requested nodes and finite positions.

- uniqueProtection: Existing finite-point test only uses ordinary a/b/c IDs. It cannot detect inherited-key collisions that are accepted by the actual transport validators.

- productionFix: Use own-property-safe internal dictionaries/lookups for previous/seeding/final positions, preserving ordinary graph behavior and plain returned objects where needed; no new test hook. This corrects an independently verified native-input bug, rather than changing production to keep an invalid NaN assertion.

Remaining owner(s): packages/ui/src/components/knowledge/graph-layout.test.ts: places every concept at finite points, ignoring edges it cannot draw.

## Existing consolidation owner

packages/ui/src/lib/agent-chat/rows.logic.test.ts — offers rewind only where the adapter supports rollback (**REWRITE**, override only).

- contractSource: GUI design §5.5 adapter rollback support and ordered started-turn rewind targets.

- credibleFailure: Provider capability becomes available while entries remain identical, but cached rows continue hiding the rewind action.

- oracle: Literal user prompt um1 has no revert count before support, then count0 after support; no checkpoint list is needed.

- seam: Public row projection reused through previous argument, with unchanged entry array and turns.

- refactorResistance: No identity assertion or collaborator inventory; only allowed action state changes.

- uniqueProtection: Existing static positive/negative owner already contains all fixture setup; turning its second pass into incremental protects new unchanged-entry fast path without another test.

## Manual benchmarks

- packages/ui/src/lib/agent-chat/rows.logic.bench.ts — KEEP_DEV_TOOL: Documented manual production-function benchmark for unchanged/assistant/reasoning projections. Upstream merge records measured use; not imported or run by CI. Its cold/self comparisons are benchmark sanity diagnostics, not accepted regression oracles. Existing shared fixture imports remain in use elsewhere.

- packages/ui/src/components/knowledge/graph-layout.bench.ts — KEEP_DEV_TOOL: Documented manual chain/star/disconnected seed benchmark, including optional safely structured git-show baseline; upstream records actual measurement. No CI cost. Exact old/current coordinates are equivalence diagnostics only and do not justify golden coordinate tests.

## Validation commands

```sh
cd packages/ui && TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=30000 --test-concurrency=4 src/lib/agent-chat/rows.logic.test.ts src/components/knowledge/graph-layout.test.ts
```

UI typechecking remains with the root gates; this child did not run pnpm --filter @orquester/ui typecheck.

Baseline proof: the new native-ID case failed before the fix because the result’s own keys omitted __proto__. SHA256 0a3dfb5b9f64b9cfb33685ef929bab75ce9d6a2faa8c8a8fb08787b2da2abff8 matched the untouched saved source. Then two focused controls passed 66/66, zero cancellations/skips. Reverting the dictionary fix killed the native-ID assertion; omitting rollback capability invalidation killed the consolidated rollback assertion (undefined versus 0). Mutant scripts restored both source files in finally and verified hashes; the final full focused control passed. Root coordinates full-package and typecheck gates.


Final focused wall times: 1.49s/1.34s (runner 1.443s/1.281s). No matching pre-cleanup focused suite was measured, so no suite speedup is claimed. Manual benchmark exact ordinary coordinates/property-order equivalence passed against ee5 for chain/star/disconnected 2000-node workloads. Its seven warmed samples measured ee5→current medians 3.955→2.819ms chain,2.498→2.928ms star,1.644→1.777ms disconnected; sequential variance prevents attributing small timing differences to this fix. Public shape probe checked Object.prototype and own __proto__/constructor keys on computeLayout, warmStart and seedPositions.

Exact proof/mutant commands use the focused loader/options above with --test-name-pattern="returns finite own positions" for graph-layout.test.ts or --test-name-pattern="offers rewind only where the adapter supports rollback" for rows.logic.test.ts. Benchmark command:

```sh
cd packages/ui && TSX_DISABLE_CACHE=1 node --import tsx src/components/knowledge/graph-layout.bench.ts ee5c32495c88e39ff8cfef73dce8d43e59f4483f
```

Logs and source-hash evidence: /tmp/orquester-test-audit/perf-ui-native-baseline.tap, perf-ui-control-{1,2}.tap/.time, perf-ui-mutant-{native-graph-keys,rollback-context}.tap, perf-ui-mutants.json and perf-ui-graph-benchmark.json.
