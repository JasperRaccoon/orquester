# Incoming history-query performance audit: 9983fb4f

Reviewed `7feff9eb..9983fb4f` in `apps/daemon/src/agent-host/index/{queries.ts,queries.test.ts,queries.bench.ts}`. Root merged the incoming commit at `50c4c1f3`. The cleanup below is applied to that merged source; production query optimization and the manual benchmark are preserved. No tests, typechecks, builds or benchmark runs were executed during this audit because the root's baseline run owns the validation slot.

## Contract and surviving owner

The thread-index design `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` §C defines search hits joined to the owning turn/ordinal, log-order turn numbering, thread-local records, and null reveal targets for unclaimed messages. `packages/api/src/agent-chat/wire.ts` documents `ThreadSearchHit.turnId` as the owning turn, null for a turnless row. The public `ThreadHeadResponse.matchedTurns` contract in `packages/api/src/agent-chat/thread-head.ts` independently specifies the FIRST matching turn in window order when a prompt appears more than once; this is also used by public thread-head tests and by reveal/fork logic. Thus reversing the lexical turn IDs does not invent an order based on the SQL under review.

Credible failures are: choosing a lexical or latest duplicate claim instead of the first ordinal; borrowing a same-ID prompt's lower-ordinal turn from another thread; overriding an answer's explicit turn; manufacturing a turn/ordinal for an unclaimed note; treating an answer as an opening prompt; returning removed turns after revert; and losing the retained first turn. No other retained query test combines the duplicate prompt claims and cross-thread collision. The existing indexer search integration protects normal single-turn indexing, not these lookup ambiguities. Existing `turnByPrompt` null/revert assertions remain in the surviving owner.

The shared setup already opens a real SQLite index, submits real event logs through `ThreadIndex.observe`, and waits on its public `drain`. The fixture doubles only provide authored event bytes and timestamps; real indexing, SQL, SQLite sorting/filtering and result shaping remain under test. Expected IDs, ordinals and nulls are literals independently chosen from event order; neither expected SQL nor a production constant computes them. Assertions observe only public `ThreadIndex.search` and `turnByPrompt` results and survive helper/SQL/index renames or algorithm changes. There is one stable owner for the combined contracts, without a second database/schema lifecycle.

## Every affected declaration

| Path | Exact declaration | Disposition | Reason and surviving coverage |
| --- | --- | --- | --- |
| `apps/daemon/src/agent-host/index/queries.test.ts` | `finds a prompt's first turn in ordinal order, scoped to its thread` | CONSOLIDATE — removed declaration | Real unique search/ambiguity contracts were trapped in an additional execution that repeated the existing prompt-lookup owner's setup. Move its entire two-thread fixture and all five literal hit/lookup assertions into the existing owner below. No contract or meaningful assertion is dropped. |
| `apps/daemon/src/agent-host/index/queries.test.ts` | `turnByPrompt: the turn that names a message as its opening prompt` | CONSOLIDATE — surviving owner | Retain real lookup/search behavior through the public index: shared prompt → `[z-first,2]`, explicit answer → `[a-second,3]`, unclaimed note → `[null,null]`, and the other thread's same prompt → `other-first`. Retain the former answer-is-not-a-prompt and revert-removes-only-later-turn lookup assertions, adapted to the same authored fixture. This independent output seam catches the concrete failures above without inspecting SQL call shape or timing. The stronger owner removes one repeated SQLite lifecycle and remains unique versus normal indexing/revert tests. |

Relative to incoming source: one declaration removed, test source **−10 LF lines** (1149→1139). Relative to `7feff9eb`, the file adds **18 LF lines** for the newly protected distinct ambiguity contracts and adds no declaration. No fixture, helper, dependency or configuration becomes orphaned. The patch is also saved at `/tmp/orquester-test-audit/incoming-query-performance/cleanup.patch`.

## Production and manual benchmark review

`queries.ts` now directs the existing prompt lookup and both search fallback subqueries through the existing `(thread_id,user_message_id)` index. It retains thread/prompt predicates, explicit ordinal sorting, explicit-turn precedence and null handling. No schema or persisted row changes are made; `turns_by_prompt` is already part of the indexed schema, so an added migration or schema-version bump is unnecessary. No production-facing API or test-only seam is added or removed by this cleanup.

`queries.bench.ts` is **KEEP as a manual diagnostic utility**, not a CI regression test or an additional named declaration. Commit `9983fb4f` records an independently reproducible 10,000-turn/50-hit query hotspot; the utility creates the real schema and FTS data, measures synchronous SQLite work in memory, reports query plans, and compares seven-sample medians for search and prompt lookup. It does not enter package test scripts and imposes no recurring CI startup or timing threshold. Its positive workload/count checks reject empty work, and the normal test owner independently protects result semantics.

The benchmark deliberately constructs a diagnostic baseline by removing only the explicit prompt-index clause from the same queries. Its two-output equality assertions are equivalence sanity checks, not a claim of an independent correctness oracle; correctness belongs to the retained real-index contract test. Its SQL-text capture and `EXPLAIN` inspection are implementation-aware diagnostics, not change-detector assertions in a required gate. Retaining this small utility lets a developer reproduce the documented performance mechanism without preserving a second copy of production SQL, adding production hooks, or running costly histories in CI. The audit makes no new speedup claim, since it has not run the utility. No benchmark deletion or rewrite is justified by its filename or by applying CI-test retention rules to a manual measurement instrument.

## Pending validation

Root should run the focused target after granting the shared slot, then its required integrated gates:

```sh
# apps/daemon
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/agent-host/index/queries.test.ts
```

Practical isolated negative controls: reverse ordinal selection in both prompt fallbacks; remove a search fallback's thread predicate; and give an unclaimed note a synthetic ordinal. The surviving literal assertions must fail for those intended errors. Removing only the index choice is behavior-preserving and should not fail the correctness test; its cost is measured by the manual benchmark, without arbitrary CI duration assertions.

The documented manual workload, if root chooses a measurement slot, is:

```sh
# apps/daemon
TSX_DISABLE_CACHE=1 node --import tsx src/agent-host/index/queries.bench.ts 10000 50
```

`git diff --check` passed for the changed query test and this ledger. No actual runtime or performance result is claimed by this incoming audit.
