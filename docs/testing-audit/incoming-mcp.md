# Incoming MCP retrieval/merge audit

Remote identity: `923b3a51b594ef668483a5bd320af41187899e34`. Covers15 incoming/revisited declarations:12 new declarations and three existing owners. Outcomes: CONSOLIDATE 2, REWRITE 9, KEEP 3, OPTIMIZE 1. One duplicate declaration removed;11 new declarations survive. These rows supersede corresponding older rows and are not additive to original audit counts.

## Implemented cleanup

- Preserved all incoming retrieval/filter/example/window/batch/similar/merge behavior and public schemas. The sole knowledge.ts conflict was resolved by retaining the incoming algorithms and our private helper scope. A static comparison confirms the production file differs from remote only in unused export modifiers.
- Removed the duplicate old-daemon search fixture and execution; its no-fabricated-metadata oracle lives in the existing query/projection owner.
- Replaced whole human-text snapshots, exact separators and private byte-share allocation with ids, supplied records/citations, API side effects, source bytes, documented limits and actionable continuation data. Valid later and final cursor pages remain; fake successful replies to malformed cursors were removed because the independently specified backend refuses them.
- Reduced repeated five-entry bodies from60,000 to6,000 euros each:18,000 bytes still exceed each body share and90,000 total bytes still exceed48,000. Repeated huge strings use60,005 characters rather than150,000. Metadata pressure and all five continuation results remain checked. No measured speedup is claimed.
- Internalized six unused incoming exports: `renderSearch`, `renderItems`, `renderMerge`, `toSearchFilters`, `KnowledgeSearchAsked`, `KnowledgeGetOutcome`. The actual `knowledgeFamily` API remains exported; no external callers were removed.
- Deleted the obsolete knowledge-family8KiB assertion/comment/local measurement. Current A1 permits7KiB, and no independently authored current8KiB requirement was found. Other documented catalog/per-tool/description/instruction/worker caps, audience keys and annotations remain. Production help strings were not edited to satisfy a numeric gate.

Against the incoming remote in the two test files:66 lines added,125 removed, net−59. This includes one line already removed in the original semantic Knowledge rewrite; incoming cleanup alone is net−58. No snapshots, dependency or persistent fixture becomes orphaned.

## Validation and measurement

`git diff --check` passed. Production merge-content comparison passed after ignoring unused export modifiers. No tests, compiler runs or timings were started: root requested an uncontended incoming baseline. All required validation remains centrally scheduled; pending notes here must be superseded by the final root report.

Focused target:

```sh
cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 --test-timeout=600000 src/mcp/tools/knowledge.test.ts src/mcp/catalog/registry.test.ts
```

Full required commands: `pnpm check:changed --no-cache`, `pnpm check`, `pnpm test`. Catalog byte measurement and before/after timing remain unmeasured here; no speedup/CI saving or invented8KiB threshold is reported.

## Six-bar proof

Independent source: [retrieval A1/A2](../superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md), [Knowledge agent tools](../superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md), shared API request/response contracts and original MCP§9.5 catalog constraints.

Independent oracles are literal request values, supplied backend records/citation/source bytes, typed errors and documented bounds; fixture byte/count arithmetic measures input data rather than reproducing owner logic. Stable seams are executeToolCall/DaemonApi requests and caller-consumed text results, or actual SDK/host tools/list serialization. Semantic data/effects preserve identifier/control-flow refactor resistance. Each row supplies its unique real failure or the failed deletion bar. Dependency fakes supply records and verdicts, not the rendering/validation/authorization under assertion. API owner retains the merge-choice chronology/tie codec separately; it does not supersede MCP request normalization or scope.

### apps/daemon/src/mcp/tools/knowledge.test.ts:82

Remote declaration: **knowledge_search: posts the query with the calling session; compact hits with collection names, one-line snippets and citations**. Disposition: **CONSOLIDATE**.

Existing public query/projection fixture already supplies an older-daemon response with no match/total/cursor/concept-title additions. Move only the absent-metadata compatibility assertions here from the newly duplicated older-daemon case; preserve literal request bytes, supplied ids/citations/content/order.

**Unique protection / survivor:** tools/knowledge.test.ts:617 is removed; this existing owner survives.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:115

Remote declaration: **knowledge_get: the entry whole with its citation, concepts and related entries (an older daemon); the session in the query**. Disposition: **REWRITE**.

Keep original old-daemon entry metadata/body/citation and related-entry compatibility through actual knowledge_get. Remove newly added exact Related heading, whole-body-at-end and decorative missing-section/footer comparisons; existing independent supplied record/body assertions already prove the data.

**Unique protection / survivor:** Separate long-window owner now owns continuation; this owns small older-daemon entry projection.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:137

Remote declaration: **knowledge_get: a long body is cut at 48 000 bytes on a character boundary, with the offset to read on from; from reads on**. Disposition: **REWRITE**.

Keep independently specified48,000-byte body window, exact returned source bytes, UTF-16 from offsets, no split surrogate pair, continuation reconstruction, header/citation identity and past-end outcome. Replace full separator/footer/header wording snapshots with body data and documented continuation key/numbers. No smaller seam owns knowledge_get window rendering.

**Unique protection / survivor:** Preserve both2-byte and4-byte source classes and odd-surrogate start; do not shrink below actual48k bound.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:326

Remote declaration: **knowledge_merge: one POST with the session, ids once each; answers the kept entry, its citation and what was deleted; no card**. Disposition: **REWRITE**.

Atomic merge must issue one POST with distinct ids/session identity, trim supplied title, forward optional keep/body, leave omitted keep to backend, return kept citation/title and identify deleted ids without a card. Replace exact4-line prose snapshot with semantic identity/status/citation assertions and explicit single-POST count.

**Unique protection / survivor:** Store merge tests own atomic persistence; this public tool owns normalization, scope and result projection.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:351

Remote declaration: **knowledge_merge: 2..10 distinct entry ids, keep among them, the save limits; the daemon's refusals pass through**. Disposition: **KEEP**.

Public merge schema requires2..10 distinct entry ids, keep within ids, save-compatible title/body fields and no unknown collections argument. Invalid inputs reach no POST; missing/hidden inputs preserve backend KNOWLEDGE_NOT_FOUND. Literal invalid requests and code/no-effect assertions detect caller-visible acceptance or wrong error.

**Unique protection / survivor:** Executor/tool boundary is distinct from store validation; no stronger current test supersedes this mapping/guard owner.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:483

Remote declaration: **knowledge_search: typed filters, examples, sort and cursor map onto the request — lists once each, empty ones left out**. Disposition: **REWRITE**.

Retain exact independently specified REST mapping for normalized top-level query/example/filter/sort/cursor arguments, deduplicated lists and omitted empty lists. Remove two empty-response prose regexes and an extra newest-search action used only to freeze empty-result wording.

**Unique protection / survivor:** Existing no-hit owner protects empty results; this uniquely proves new typed argument mapping and example-only search.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:529

Remote declaration: **knowledge_search: refuses what the daemon would — no query and no examples, unlike alone, bad ids, years, dates, sort or cursor — before any request**. Disposition: **KEEP**.

Public retrieval arguments require query or positive examples, unlike only with similarTo, bounded lowercase entry ids/filter lists/metadata, ISO dates/years, valid sort and bounded nonempty cursor. Concrete malformed requests cause INVALID_ARGUMENT before a backend request, while boundary-valid payload succeeds.

**Unique protection / survivor:** No-query/example relationship and top-level schema differ from backend SearchRequest; independent literal inputs/code oracle is not supplied by the fake.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:568

Remote declaration: **knowledge_search: each entry hit shows its band and signals, title, snippet, passage and citation (never the matched terms); concept hits name their entries; the footer pages**. Disposition: **REWRITE**.

Retain band/signals/title/snippet/citation, passage offsets/chunk ordinals, concept-entry names, weak-evidence guidance and real cursor/total/range values at public text-result boundary. Drop whole multiline prose/indentation snapshot, repeated one-page decoration scenario and unsupported positive responses to malformed cursor (spec requires KNOWLEDGE_INVALID). Keep valid later/last page fixtures using valid cursors.

**Unique protection / survivor:** This owns MCP projection of backend match metadata, not search ranking; old-daemon absence consolidates into original projection owner.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

Current declaration: knowledge_search: entry match data, concept titles and citations survive; the footer pages.

### apps/daemon/src/mcp/tools/knowledge.test.ts:617

Remote declaration: **knowledge_search: an older daemon (no match, total, cursor or concept titles) renders without bands or a footer**. Disposition: **CONSOLIDATE**.

Fails unique protection after moving its only distinct absence assertions to existing line82 query/projection owner. Both already use older-daemon entry/concept data without optional match/total/cursor/entry-title fields. Delete duplicate backend fixture and public tool execution.

**Unique protection / survivor:** Surviving tools/knowledge.test.ts:82 verifies no fabricated bands, passage or page cursor while retaining actual old data.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:633

Remote declaration: **knowledge_get: similar entries with every reason, possible duplicates once, at most 8 similar; related only from an older daemon**. Disposition: **REWRITE**.

Retain every similarity reason, supplied ids/names/citations, duplicate deduplication, documented maximum8 similar entries and replacing legacy related data. Drop exact heading/order/line slices, duplicate-instruction sentence and empty-header-only replay. Assert semantic records, one duplicate citation and ids omitted by the public bound.

**Unique protection / survivor:** Search compact hits do not own full get-related reason/citation projection; legacy entry owner separately protects old related records.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:687

Remote declaration: **knowledge_get: ids reads several at once — one request each, numbered, a refused one reported inline; all refused is the daemon's error**. Disposition: **REWRITE**.

Batch get must issue one session-scoped read per distinct id, preserve order/identity, show successful bodies and mixed concept data, report per-item error codes, fail when all reads fail and allow continuation with a single id in ids. Replace numbered separators/full inline-error sentences/exact47,990-char allocation with content/error identity and aggregate48k body budget plus actionable continuation.

**Unique protection / survivor:** Exact water-filling allocation is not specified; shared body budget, progress and data preservation are.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

Current declaration: knowledge_get: ids reads each distinct item in order, preserves partial success and fails when all fail.

### apps/daemon/src/mcp/tools/knowledge.test.ts:723

Remote declaration: **knowledge_get: exactly one of id and ids, at most 5 ids, from a whole offset and only for one entry**. Disposition: **KEEP**.

Public get requires exactly one of id/ids,1..5 ids, an integer nonnegative from offset and continuation for one distinct item only. Literal malformed args must produce INVALID_ARGUMENT before any item lookup.

**Unique protection / survivor:** This tool cross-field schema/dispatch seam is not covered by backend individual item reads or API type declarations.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:743

Remote declaration: **knowledge_get: five full entries or five huge concepts stay under the result cap**. Disposition: **OPTIMIZE**.

Retain actual five-entry shared byte-window budget, all five continuation footers, Unicode correctness and five-concept overall cap/truthful truncation. Reduce repeated entry bodies from60,000 euros to6,000 (18k bytes each still exceed individual share and total48k), and huge repeated strings from150k to just over60k where sufficient; keep distinct metadata pressure and final fallback.

**Unique protection / survivor:** Unique combined body/head budget and concept-only fallback branches; compare runtime before/after when authorized and do not claim unmeasured speedup.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/tools/knowledge.test.ts:787

Remote declaration: **knowledge_save: a saved entry close in meaning to one already there gets a possible-duplicate line; an older daemon's answer has none**. Disposition: **REWRITE**.

Saved-entry results must expose backend possible-duplicate ids/titles/similarity and knowledge_merge guidance, attach them to the saved item, and remain compatible with missing/empty similar fields. Replace exact3-line copy snapshot/next-row adjacency with semantic supplied values, one occurrence of each duplicate id and absence of invented recommendations for other saved records.

**Unique protection / survivor:** Store duplicate detection does not prove MCP save-result recommendation projection.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.

### apps/daemon/src/mcp/catalog/registry.test.ts:83

Remote declaration: **tools/list and instructions preserve audience names, MCP annotations and context byte budgets**. Disposition: **REWRITE**.

DELETE only the obsolete8KiB knowledge-family numeric gate: no independent current8KiB requirement exists (current A1 permits7KiB). Preserve all independently specified overall/per-tool/description/instruction/worker budgets, audience key checks and MCP annotations. Remove dead measurement local/history comment; measure actual catalog bytes in report without inventing a threshold.

**Unique protection / survivor:** Current public-schema/security and other documented byte-budget owners remain. No production help-string changes to satisfy obsolete gate.

**Stable seam / oracle / refactor resistance:** Actual executeToolCall public tool boundary with DaemonApi input/output; actual SDK/host serialized tools/list for registry. Literal request payloads, backend-supplied source records/citation bytes, documented numeric bounds, error codes and independent UTF8/source-byte counts; exact prose and private allocation expected values are removed. Retain semantic identities/status/bytes/effects and public keys; remove separators, punctuation, heading/line placement and unsupported fake-success branch assumptions.
