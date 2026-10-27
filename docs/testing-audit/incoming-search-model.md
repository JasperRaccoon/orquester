# Incoming retrieval model, similarity and evaluation audit

Source: remote commit `923b3a51b594ef668483a5bd320af41187899e34`. All 30 incoming test declarations across 5 files were read with their production owners and the [approved retrieval design](../superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md). Disposition counts refer to those source declarations: `{"DELETE": 4, "CONSOLIDATE": 1, "REWRITE": 9, "KEEP": 13, "OPTIMIZE": 3}`. 25 survive; net test LOC -173. This ledger supplements the original repository audit without double-counting its cases.

Edits are complete. Scoped `git diff --check` passed. Root reported the integrated embedder/model/eval files passed their enabled cases; actual native model asset execution/skip status remains root-owned. The initial graph node-count failure was corrected by repairing fixture identity. Corrected performance checks, repeated graph runs and all intended mutation failures are recorded below. No baseline speedup is claimed; final full gates remain root-owned. Root owns integration and Git delivery.

## Shared boundaries and cleanup

- `embedder.ts`: Internalized6 test-only helper/type exports; modelDir/openSession now private, removing subclass injection seam. Actual production inference path unchanged. EmbeddingSession remains an internal adapter with production callers.
- `similarity.ts`: Internalized3 constants with no external production/test consumers; production values unchanged.
- `fake-vector-index.ts`: Removed entryVectorCalls/scored recorder fields and writes, all former consumers removed. Kept input-vector port fixture for real algorithms/routes.
- `eval/corpus.ts`: Retained hand-judged bilingual/cross-language fixtures needed by actual model quality gate; removed declaration inventory test.
- `eval/harness.ts`: Retained required evaluator/calibration/search harness; no orphaned helpers from removed cases.
- `test-fakes.ts`: Shared legitimate store/embedder fixtures remain. No edits in this workstream.

## Performance disposition

Graph corpus5000→1001rows for1000drawn nodes, concepts2000→400proportionally; removed copied O(n²d) floor and redundant warm request. Perf now also exercises real indexing during setup rather than private fake-index substitution.18body/header chunk-fit combinations use pinned tokenizer without repeated neural inference; removed900-word inference asserting only row count.

The retained expensive checks cover 5,000-entry detail/facets p95 < 100 ms; a 1,000-node cold graph < 2 s with event-loop progress; 20 real model warm inference samples with median < 200 ms; and real bilingual recall@5 ≥ .8 plus model calibration.

Native model checks require ORQUESTER_KG_MODEL_DIR and remain explicitly skipped without assets. The literal 2 s graph budget passed the corrected exclusive run and three repeats; no limit was raised. No CI impact measured.

The adaptive floor copied the production 4-accumulator kernel into the expected acceptable runtime. It failed the independent-oracle bar and executed a second quadratic pass. The replacement retains the independent literal 2,000 ms requirement and callback progress. The warm/cold quarter ratio had no independently specified contract and was removed. Lower graph tests verify changed public edges, concepts, metadata and title-derived labels after cache invalidation.

## Validation follow-up: fixture identity

The initial 1,001-row graph setup produced only 471 nodes (812 ms), so that observation is not a valid 1,000-node timing. The inherited ID generator replaced base32 digits `0`–`9` with letters `a`–`j` while preserving existing letters: input indices 0 and 10 therefore shared an ID and overwrote records. It also underfilled the claimed 5,000-entry detail/facet baseline fixture.

The fixture now preserves padded base32 digits, which the public ID schema accepts, making identities injective. The graph retains 1,001 actual entries, the strict 1,000-node assertion and truncation; detail/facet setup now contains the advertised 5,000 actual records. The corrected workload passed root-controlled retiming below. It contains more real detail records than the old, underfilled fixture. No production behavior, runtime budget or meaningful assertion was changed.

## Corrected performance validation

The exclusive sequential two-file run passed all three tests with actual 5,000-entry search/detail fixtures and 1,000 graph nodes. Wall time was 10.44 s; user CPU 10.41 s, system CPU 1.29 s, maximum RSS 424,308 KB. Search p50/p95 was 13.8/25.7 ms, entry detail p95 15.5 ms, facets p95 6.8 ms, and graph cold time 270 ms with six event-loop turns. These are scoped final measurements, not a valid source-to-final speedup comparison.

Three additional graph-only processes passed at 293, 291 and 287 ms cold (6 ms range), each drawing exactly 1,000 nodes, 2,107 edges and 60 clusters with six event-loop turns. Their process wall times were 1.57, 1.46 and 1.49 s. No performance assertion or workload-size guard was relaxed.

Executed from `apps/daemon`:

```sh
TSX_DISABLE_CACHE=1 /usr/bin/time -f '\nwall=%e cpu_user=%U cpu_system=%S max_rss_kb=%M' node --import tsx --test --test-concurrency=1 src/knowledge/search/similarity.perf.test.ts src/knowledge/search/search.perf.test.ts > /tmp/orquester-test-audit/corrected-retrieval-perf.log 2>&1
TSX_DISABLE_CACHE=1 /usr/bin/time -f '\nwall=%e cpu_user=%U cpu_system=%S max_rss_kb=%M' node --import tsx --test --test-name-pattern='similarity graph over' src/knowledge/search/similarity.perf.test.ts > /tmp/orquester-test-audit/corrected-similarity-graph-N.log 2>&1
```

The second command ran three times sequentially with `N=1`, `2`, `3`. The source fixture underfilled both advertised workloads; its initial 471-node timing cannot supply a comparable baseline. Overall-suite and CI improvements remain unmeasured by this workstream.

## Regression-detection validation

Each process-local mutation below exited 1 for the intended assertion, without modifying production files:

- **Pooling amplitudes:** replacing hidden-state amplitudes with signs produced `[.70710677,.70710677]`; the public embedding test rejected it against literal `[.6,.8]`.
- **Padding:** including padded native positions produced `[.70884198,.70536727]`; the same test rejected it against literal `[.8,.6]`.
- **Yielding:** delaying every graph yield produced the same 1,000-node workload in 293 ms with zero event-loop turns; the public responsiveness assertion failed.

```sh
ORQUESTER_MODEL_AUDIT_MUTATION=pooling-amplitudes TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/incoming-model-mutation-loader.mjs --test --test-name-pattern='embed preserves' src/knowledge/search/embedder.test.ts > /tmp/orquester-test-audit/mutation-pooling-amplitudes.log 2>&1
ORQUESTER_MODEL_AUDIT_MUTATION=pooling-padding TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/incoming-model-mutation-loader.mjs --test --test-name-pattern='embed preserves' src/knowledge/search/embedder.test.ts > /tmp/orquester-test-audit/mutation-pooling-padding.log 2>&1
ORQUESTER_MODEL_AUDIT_MUTATION=graph-yield TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/incoming-model-mutation-loader.mjs --test --test-name-pattern='similarity graph over' src/knowledge/search/similarity.perf.test.ts > /tmp/orquester-test-audit/mutation-graph-yield.log 2>&1
```

## Test-by-test dispositions

### `apps/daemon/src/knowledge/search/embedder.test.ts:105`

**DELETE** — the frame comes from the tokenizer: <s> … </s> and <pad>, not BERT's ids

Private helper inspection duplicates public embed boundary. Unsupported fallback combinations have no independently required public caller.

Execution removed; stronger surviving owner is identified below.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 tokenizer-defined special tokens
- **Credible failure:** Private helper inspection duplicates public embed boundary. Unsupported fallback combinations have no independently required public caller.
- **Independent oracle:** Fails: self-inventory/private helper or duplicate; see reason.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Delete private structure/declaration assertions.
- **Unique protection / stronger owner:** Private helper inspection duplicates public embed boundary. Unsupported fallback combinations have no independently required public caller.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:113`

**DELETE** — truncation keeps the start and closes with the model's end token

Private frameIds branch restatement; public oversize embed owns framing and truncation. Hypothetical two-EOS max5 is outside constructor-supported min8.

Execution removed; stronger surviving owner is identified below.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 maximum-token truncation
- **Credible failure:** Private frameIds branch restatement; public oversize embed owns framing and truncation. Hypothetical two-EOS max5 is outside constructor-supported min8.
- **Independent oracle:** Fails: self-inventory/private helper or duplicate; see reason.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Delete private structure/declaration assertions.
- **Unique protection / stronger owner:** Private frameIds branch restatement; public oversize embed owns framing and truncation. Hypothetical two-EOS max5 is outside constructor-supported min8.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:121`

**CONSOLIDATE** — mean pooling counts only the real tokens of each row, then L2-normalizes

Move independently specified weighted masked-state outcome into the public embed case; remove helper-only execution and export.

Execution removed; stronger surviving owner is identified below.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 attention-mask-aware mean pooling then L2 normalization
- **Credible failure:** Move independently specified weighted masked-state outcome into the public embed case; remove helper-only execution and export.
- **Independent oracle:** Hand-picked literals, actual tokenizer/native model data, or documented fixed performance/quality budget; remove production-derived expected calculations as described.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Move independently specified weighted masked-state outcome into the public embed case; remove helper-only execution and export.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:130`

**REWRITE** — embed applies the kind's prefix, the tokenizer's special tokens and its padding

Keep public vectors and literal protocol input/mask expectations at native ONNX boundary; remove private sorted-batch shape and copied generic mean/L2 expected algorithm. Add weighted literal .6/.8 outcome from donor.

Surviving owner: `embed preserves input order, prefixes and tokenizer framing, and normalizes a masked mean` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 query/passage prefixes, model-defined framing and masked pooling
- **Credible failure:** Keep public vectors and literal protocol input/mask expectations at native ONNX boundary; remove private sorted-batch shape and copied generic mean/L2 expected algorithm. Add weighted literal .6/.8 outcome from donor.
- **Independent oracle:** Literal native framed token IDs and masks derived from independently supplied fixture tokenizer JSON; literal 3-4-5 triangle outputs [.6,.8]/[.8,.6] with large padding states, fixed256 legacy cap and disposed rejection; runtime thresholds are explicit supplied configuration.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Keep public vectors and literal protocol input/mask expectations at native ONNX boundary; remove private sorted-batch shape and copied generic mean/L2 expected algorithm. Add weighted literal .6/.8 outcome from donor.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Root integrated enabled normal target passed; process-local pooling-amplitudes and pooling-padding mutants both failed intended literal vector assertions.

### `apps/daemon/src/knowledge/search/embedder.test.ts:167`

**REWRITE** — inputs past maxTokens are truncated, closed with </s>, and counted in one warning per call (no text)

Keep bounded input, terminal EOS, one warning covering truncated count, no body leakage, no warning for a subsequent short call; drop incidental whole warning wording and last-sorted-row assumption.

Surviving owner: `oversize inputs close at maxTokens and log only a truncation count` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 maxTokens truncation; P0.3 counts-only warning without content
- **Credible failure:** Keep bounded input, terminal EOS, one warning covering truncated count, no body leakage, no warning for a subsequent short call; drop incidental whole warning wording and last-sorted-row assumption.
- **Independent oracle:** Literal native framed token IDs and masks derived from independently supplied fixture tokenizer JSON; literal 3-4-5 triangle outputs [.6,.8]/[.8,.6] with large padding states, fixed256 legacy cap and disposed rejection; runtime thresholds are explicit supplied configuration.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Keep bounded input, terminal EOS, one warning covering truncated count, no body leakage, no warning for a subsequent short call; drop incidental whole warning wording and last-sorted-row assumption.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:182`

**REWRITE** — a symmetric model has no prefixes; the defaults are all-MiniLM-L6-v2's

Keep unprefixed native input and actual default limit behavior; remove imported threshold-object self-comparison.

Surviving owner: `legacy symmetric model inputs are unprefixed and limited to 256 tokens by default` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 legacy MiniLM compatibility: symmetric inputs and 256-token legacy limit
- **Credible failure:** Keep unprefixed native input and actual default limit behavior; remove imported threshold-object self-comparison.
- **Independent oracle:** Literal native framed token IDs and masks derived from independently supplied fixture tokenizer JSON; literal 3-4-5 triangle outputs [.6,.8]/[.8,.6] with large padding states, fixed256 legacy cap and disposed rejection; runtime thresholds are explicit supplied configuration.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Keep unprefixed native input and actual default limit behavior; remove imported threshold-object self-comparison.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:192`

**KEEP** — dispose releases the session; a disposed embedder refuses

Native session released once and later embed rejects disposed, catching leaked native state or use-after-dispose through public dispose/embed.

Surviving owner: `dispose releases the native session and refuses further embedding` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: Public KnowledgeEmbedder resource lifecycle
- **Credible failure:** Native session released once and later embed rejects disposed, catching leaked native state or use-after-dispose through public dispose/embed.
- **Independent oracle:** Literal native framed token IDs and masks derived from independently supplied fixture tokenizer JSON; literal 3-4-5 triangle outputs [.6,.8]/[.8,.6] with large padding states, fixed256 legacy cap and disposed rejection; runtime thresholds are explicit supplied configuration.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Native session released once and later embed rejects disposed, catching leaked native state or use-after-dispose through public dispose/embed.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.test.ts:219`

**REWRITE** — the runtime source passes the model's prefixes, limit and thresholds; none while the model is missing

Always-running owner for missing model, ready model and runtime replacement; exercise configured prefix/limit at public embed native boundary, remove constructor property mirrors and duplicate real-model runtime case.

Surviving owner: `runtime availability and model changes configure actual embedding and preserve legacy defaults` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: Runtime compatibility/model-ready configuration contract P0.1/P0.2
- **Credible failure:** Always-running owner for missing model, ready model and runtime replacement; exercise configured prefix/limit at public embed native boundary, remove constructor property mirrors and duplicate real-model runtime case.
- **Independent oracle:** Literal native framed token IDs and masks derived from independently supplied fixture tokenizer JSON; literal 3-4-5 triangle outputs [.6,.8]/[.8,.6] with large padding states, fixed256 legacy cap and disposed rejection; runtime thresholds are explicit supplied configuration.
- **Stable seam:** Public OnnxSentenceEmbedder.embed/dispose or runtimeEmbedderSource; actual HuggingFace Tokenizer and ONNX InferenceSession/Tensor external input/output protocol. Only InferenceSession.create is mocked; no private helper imports or production subclass hook.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Always-running owner for missing model, ready model and runtime replacement; exercise configured prefix/limit at public embed native boundary, remove constructor property mirrors and duplicate real-model runtime case.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.model.test.ts:31`

**OPTIMIZE** — the pinned model on onnxruntime-node: 384-d normalized vectors, semantically ordered across languages, fast when warm

Retain actual 384d normalized output, EN/ES semantic ordering and 20 measured warm samples; delete 900-word long-inference loop asserting only output count (no unique behavioral protection).

Surviving owner: `the pinned model on onnxruntime-node: 384-d normalized vectors, semantically ordered across languages, fast when warm` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.1 pinned real ONNX dimensions/normalization; cross-language semantic quality and documented warm latency
- **Credible failure:** Retain actual 384d normalized output, EN/ES semantic ordering and 20 measured warm samples; delete 900-word long-inference loop asserting only output count (no unique behavioral protection).
- **Independent oracle:** Hand-picked literals, actual tokenizer/native model data, or documented fixed performance/quality budget; remove production-derived expected calculations as described.
- **Stable seam:** KnowledgeEmbedder.embed/dispose, KnowledgeSimilarity public methods, real KnowledgeSearch retrieval, or explicit eval quality gate; ONNX/tokenizer APIs are external boundaries.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Retain actual 384d normalized output, EN/ES semantic ordering and 20 measured warm samples; delete 900-word long-inference loop asserting only output count (no unique behavioral protection).

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.model.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.model.test.ts:73`

**OPTIMIZE** — token-dense bodies chunk under the model's limit: header + prefix + chunk is never truncated

Use pinned actual Tokenizer.encode including special tokens and literal <=512, over same hostile body/header fixtures. Remove repeated ONNX inference: token fit is tokenizer contract, not neural computation. Public truncation case still owns warning.

Surviving owner: `contextual passages fit the pinned tokenizer's 512-token limit, including prefix and special tokens` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.3 prefixed contextual chunks must fit actual model 512-token cap without truncation
- **Credible failure:** Use pinned actual Tokenizer.encode including special tokens and literal <=512, over same hostile body/header fixtures. Remove repeated ONNX inference: token fit is tokenizer contract, not neural computation. Public truncation case still owns warning.
- **Independent oracle:** Hand-picked literals, actual tokenizer/native model data, or documented fixed performance/quality budget; remove production-derived expected calculations as described.
- **Stable seam:** KnowledgeEmbedder.embed/dispose, KnowledgeSimilarity public methods, real KnowledgeSearch retrieval, or explicit eval quality gate; ONNX/tokenizer APIs are external boundaries.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Use pinned actual Tokenizer.encode including special tokens and literal <=512, over same hostile body/header fixtures. Remove repeated ONNX inference: token fit is tokenizer contract, not neural computation. Public truncation case still owns warning.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.model.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/embedder.model.test.ts:114`

**DELETE** — the runtime source makes the embedder lazily and swaps it when the runtime changes

Duplicates always-on runtime case for control flow and pinned model case for successful native embedding; generic nonexistent-path rejection has no independent failure reason.

Execution removed; stronger surviving owner is identified below.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: Runtime source laziness/replacement
- **Credible failure:** Duplicates always-on runtime case for control flow and pinned model case for successful native embedding; generic nonexistent-path rejection has no independent failure reason.
- **Independent oracle:** Fails: self-inventory/private helper or duplicate; see reason.
- **Stable seam:** Fails unique stable-owner criterion; see stronger owner.
- **Refactor resistance:** Delete private structure/declaration assertions.
- **Unique protection / stronger owner:** Duplicates always-on runtime case for control flow and pinned model case for successful native embedding; generic nonexistent-path rejection has no independent failure reason.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/embedder.model.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:80`

**KEEP** — similar: meaning, concepts and author reasons together, ordered by similarity, shared concepts, then newest

Literal vectors and hand-selected concept/author candidates detect missing semantic/concept/author union, wrong relative ordering or wrong metadata summary. Real forEntry computes similarities; fake only supplies vector/storage ports.

Surviving owner: `similar: meaning, concepts and author reasons together, ordered by similarity, shared concepts, then newest` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R5 union/reasons/ranking
- **Credible failure:** Literal vectors and hand-selected concept/author candidates detect missing semantic/concept/author union, wrong relative ordering or wrong metadata summary. Real forEntry computes similarities; fake only supplies vector/storage ports.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Literal vectors and hand-selected concept/author candidates detect missing semantic/concept/author union, wrong relative ordering or wrong metadata summary. Real forEntry computes similarities; fake only supplies vector/storage ports.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:114`

**KEEP** — similar and duplicates never include an entry the caller cannot see

Hand-named hidden entry absent from both similar and duplicates. Direct lowest stable service owns algorithm scope; route tests own authorization/wiring separately.

Surviving owner: `similar and duplicates never include an entry the caller cannot see` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R5/R6 caller visibility privacy
- **Credible failure:** Hand-named hidden entry absent from both similar and duplicates. Direct lowest stable service owns algorithm scope; route tests own authorization/wiring separately.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Hand-named hidden entry absent from both similar and duplicates. Direct lowest stable service owns algorithm scope; route tests own authorization/wiring separately.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:122`

**KEEP** — the author reason matches a display name when there is no handle

Display name matches despite absent handle; independent metadata cases detect author normalization regression not hit by handle fixture.

Surviving owner: `the author reason matches a display name when there is no handle` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R5 normalized author identity fallback
- **Credible failure:** Display name matches despite absent handle; independent metadata cases detect author normalization regression not hit by handle fixture.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Display name matches despite absent handle; independent metadata cases detect author normalization regression not hit by handle fixture.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:131`

**KEEP** — at most 8 similar entries, best first; at most 3 duplicates

More qualifying inputs than limits and literal best-first IDs prove <=8 similar and <=3 duplicates, independent of implementation constants.

Surviving owner: `at most 8 similar entries, best first; at most 3 duplicates` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R5/R6 response cardinalities
- **Credible failure:** More qualifying inputs than limits and literal best-first IDs prove <=8 similar and <=3 duplicates, independent of implementation constants.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** More qualifying inputs than limits and literal best-first IDs prove <=8 similar and <=3 duplicates, independent of implementation constants.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:145`

**KEEP** — without an index or a model: concepts and author only, similarity null, no duplicates

Real concept/author candidates remain with null cosine and no duplicate claims; catches total fallback disappearance or invented similarity.

Surviving owner: `without an index or a model: concepts and author only, similarity null, no duplicates` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R5 unavailable model/index graceful degradation
- **Credible failure:** Real concept/author candidates remain with null cosine and no duplicate claims; catches total fallback disappearance or invented similarity.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Real concept/author candidates remain with null cosine and no duplicate claims; catches total fallback disappearance or invented similarity.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:157`

**REWRITE** — similarForSaved: visible near-duplicates outside the save, closest first, at most 3

Literal ranked visible IDs, max3, excludes every entry in same save, no-vectors empty; remove production-derived knowledgeCitation expected object when already covered by citation owner.

Surviving owner: `similarForSaved: visible near-duplicates outside the save, closest first, at most 3` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R6 save near-duplicate detection
- **Credible failure:** Literal ranked visible IDs, max3, excludes every entry in same save, no-vectors empty; remove production-derived knowledgeCitation expected object when already covered by citation owner.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Literal ranked visible IDs, max3, excludes every entry in same save, no-vectors empty; remove production-derived knowledgeCitation expected object when already covered by citation owner.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:227`

**KEEP** — graph: k-NN edges, the spanning forest marked tree (one edge per pair), clusters and labels

Small literal vectors produce explicitly named edges/weights/tree roles/degrees, k-sensitive membership and cluster identities; independent expected geometry is public graph data not UI appearance.

Surviving owner: `graph: k-NN edges, the spanning forest marked tree (one edge per pair), clusters and labels` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 graph k-NN plus maximum spanning forest, deduped pairs and title fallback clusters
- **Credible failure:** Small literal vectors produce explicitly named edges/weights/tree roles/degrees, k-sensitive membership and cluster identities; independent expected geometry is public graph data not UI appearance.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Small literal vectors produce explicitly named edges/weights/tree roles/degrees, k-sensitive membership and cluster identities; independent expected geometry is public graph data not UI appearance.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:263`

**KEEP** — graph: an entry hidden from the caller is never a node or an edge end

Hidden entries never nodes or edge endpoints and collection narrowing yields literal totals; catches scope leaks not graph algorithm ordering.

Surviving owner: `graph: an entry hidden from the caller is never a node or an edge end` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 graph visibility/narrowing privacy
- **Credible failure:** Hidden entries never nodes or edge endpoints and collection narrowing yields literal totals; catches scope leaks not graph algorithm ordering.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Hidden entries never nodes or edge endpoints and collection narrowing yields literal totals; catches scope leaks not graph algorithm ordering.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:276`

**KEEP** — graph: a cluster is named by its linked entries' most common concept

Literal concept-linked fixture wins over title fallback; detects incorrect label source/majority.

Surviving owner: `graph: a cluster is named by its linked entries' most common concept` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 cluster most-common concept label
- **Credible failure:** Literal concept-linked fixture wins over title fallback; detects incorrect label source/majority.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Literal concept-linked fixture wins over title fallback; detects incorrect label source/majority.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:287`

**REWRITE** — graph: the most recent `limit` embedded entries; truncated; k and limit are clamped

Preserve literal most-recent IDs, embedded/visible totals, truncation and zero-limit clamp. Rename/remove false k-clamped-to8 claim: with only3 nodes k99 cannot prove exact upper clamp.

Surviving owner: `graph: the most recent embedded entries respect the limit and report truncation` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 most-recent embedded limit/truncation and minimum supported limit
- **Credible failure:** Preserve literal most-recent IDs, embedded/visible totals, truncation and zero-limit clamp. Rename/remove false k-clamped-to8 claim: with only3 nodes k99 cannot prove exact upper clamp.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Preserve literal most-recent IDs, embedded/visible totals, truncation and zero-limit clamp. Rename/remove false k-clamped-to8 claim: with only3 nodes k99 cannot prove exact upper clamp.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:297`

**REWRITE** — graph: cached until the index generation, the graph revision or the drawn entries change

Remove entryVector call counters and redundant warm equality request. Retain changed vector edges and new concept label. Rename all3 titles in the existing unlinked cluster to Pricing research and assert new public cluster label pricing research plus refreshed node metadata, proving metadata cache invalidation through actual output.

Surviving owner: `graph: changed vectors, graph concepts and entry metadata replace stale results` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 cache invalidation after vector generation, graph revision or metadata change
- **Credible failure:** Stale graph structure after index generation changes, stale concept label after graph reload, or stale title-derived cluster label after metadata changes.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Keep changed edges/relabelled clusters/renamed public metadata; remove private entryVector call counts and redundant warm equality execution. Algorithm cache implementation is replaceable.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:327`

**KEEP** — graph: an entry deleted while the graph is computed is left out with its edges

Removal while async graph computation is pending removes node and all endpoints while other edges survive; independent lifecycle outcome not reproduced by static visibility case.

Surviving owner: `graph: an entry deleted while the graph is computed is left out with its edges` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 concurrent entry deletion must not expose dangling graph nodes/edges
- **Credible failure:** Removal while async graph computation is pending removes node and all endpoints while other edges survive; independent lifecycle outcome not reproduced by static visibility case.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Removal while async graph computation is pending removes node and all endpoints while other edges survive; independent lifecycle outcome not reproduced by static visibility case.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.test.ts:337`

**KEEP** — graph: no index or no model answers the visible total and nothing drawn

Literal empty structure and total preserve graceful API fallback and avoid invalid semantic topology; distinct from forEntry fallback.

Surviving owner: `graph: no index or no model answers the visible total and nothing drawn` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: R7 unavailable model/index empty graph plus visible total
- **Credible failure:** Literal empty structure and total preserve graceful API fallback and avoid invalid semantic topology; distinct from forEntry fallback.
- **Independent oracle:** Hand-picked literal candidate IDs, cosine values, reasons, fixed8/3 limits, graph edges/roles/clusters/labels/totals and visible/hidden/deleted identities; no production constants used as expected values.
- **Stable seam:** KnowledgeSimilarity.forEntry/similarForSaved/graph, using its production KnowledgeVectorIndex/store/graph ports. Fake supplies only normalized input vectors and stored data; real owner computes cosine/order/topology.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Literal empty structure and total preserve graceful API fallback and avoid invalid semantic topology; distinct from forEntry fallback.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/similarity.perf.test.ts:80`

**REWRITE** — entry detail with similar entries and duplicates, and facets, over 5,000 entries: p95 under 100 ms

Keep literal documented budget and real similarity/facet computation with output sanity checks. Remove private search.similarityIndex monkeypatch via legitimate port/controlled embedding. Ensure actual expensive setup is included in reports. Correct inherited fixture ID collisions by preserving the injective base32 digits; otherwise names0and10 overwrite each other and advertised workload size is false.

Surviving owner: `entry detail with similar entries and duplicates, and facets, over 5,000 entries: p95 under 100 ms` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: Performance budgets: detail including similar/duplicates and facets p95<100ms at5000entries
- **Credible failure:** Keep literal documented budget and real similarity/facet computation with output sanity checks. Remove private search.similarityIndex monkeypatch via legitimate port/controlled embedding. Ensure actual expensive setup is included in reports.
- **Independent oracle:** Literal approved p95<100ms or cold<2000ms and independent event-loop callback progress; no copied pairwise kernel, adaptive ratio or quarter-of-current-runtime expected value.
- **Stable seam:** Real KnowledgeSearch constructor, real vector indexing with a controlled KnowledgeEmbedder port, entryDetail, KnowledgeSimilarity.graph and computeKnowledgeFacets public data functions.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Keep literal documented budget and real similarity/facet computation with output sanity checks. Remove private search.similarityIndex monkeypatch via legitimate port/controlled embedding. Ensure actual expensive setup is included in reports.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.perf.test.ts`. Corrected exclusive perf run passed; graph case passed3additional repeats at287–293ms/1000nodes/6turns; graph-yield mutant failed intended public event-loop assertion. Initial471-node fixture failure corrected without relaxing assertions.

### `apps/daemon/src/knowledge/search/similarity.perf.test.ts:145`

**OPTIMIZE** — similarity graph over 1,000 entries: within 2 s cold, yielding to the event loop, then cached

Use1001rows for1000drawn/truncated instead5000; remove copied production4-accumulator pairwiseFloor and adaptive 2.5 multiplier (independent-oracle violation), remove implementation-derived warm/cold ratio/repeat; retain fixed2000ms and event-loop progress. Cache correctness/invalidation belongs lower stable graph case. Correct inherited fixture ID collisions by preserving the injective base32 digits; otherwise names0and10 overwrite each other and advertised workload size is false.

Surviving owner: `similarity graph over 1,000 entries: within 2 s cold and yielding to the event loop` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: Performance budgets/R7:1000node graph <2000ms cold idle and event-loop yields
- **Credible failure:** Use1001rows for1000drawn/truncated instead5000; remove copied production4-accumulator pairwiseFloor and adaptive 2.5 multiplier (independent-oracle violation), remove implementation-derived warm/cold ratio/repeat; retain fixed2000ms and event-loop progress. Cache correctness/invalidation belongs lower stable graph case.
- **Independent oracle:** Literal approved p95<100ms or cold<2000ms and independent event-loop callback progress; no copied pairwise kernel, adaptive ratio or quarter-of-current-runtime expected value.
- **Stable seam:** Real KnowledgeSearch constructor, real vector indexing with a controlled KnowledgeEmbedder port, entryDetail, KnowledgeSimilarity.graph and computeKnowledgeFacets public data functions.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Use1001rows for1000drawn/truncated instead5000; remove copied production4-accumulator pairwiseFloor and adaptive 2.5 multiplier (independent-oracle violation), remove implementation-derived warm/cold ratio/repeat; retain fixed2000ms and event-loop progress. Cache correctness/invalidation belongs lower stable graph case.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/similarity.perf.test.ts`. Corrected exclusive perf run passed; graph case passed3additional repeats at287–293ms/1000nodes/6turns; graph-yield mutant failed intended public event-loop assertion. Initial471-node fixture failure corrected without relaxing assertions.

### `apps/daemon/src/knowledge/search/eval/eval.test.ts:18`

**DELETE** — the evaluation set: ~30 entries and ~20 queries, English, Spanish and across, every expected id real

Declaration inventory against itself; count/language/type shape is not caller behavior. Relevant hand-authored expected IDs remain inputs to actual quality evaluation.

Execution removed; stronger surviving owner is identified below.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.4 fixed approximately30entries/20queries bilingual relevance corpus
- **Credible failure:** Declaration inventory against itself; count/language/type shape is not caller behavior. Relevant hand-authored expected IDs remain inputs to actual quality evaluation.
- **Independent oracle:** Fails: self-inventory/private helper or duplicate; see reason.
- **Stable seam:** Fails unique stable-owner criterion; see stronger owner.
- **Refactor resistance:** Delete private structure/declaration assertions.
- **Unique protection / stronger owner:** Declaration inventory against itself; count/language/type shape is not caller behavior. Relevant hand-authored expected IDs remain inputs to actual quality evaluation.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/eval/eval.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/eval/eval.test.ts:36`

**KEEP** — recall@k and MRR count every expected entry in the top k and the first one's rank

Hand-ranked literal [0.5,0.5],[1,1],[0,0] and aggregate.5 verify truncation, all expected denominator and first relevant reciprocal rank. This uniquely validates independently defined quality-gate oracle; fake/full-model evaluations cannot detect a metric reporting false success themselves.

Surviving owner: `recall@k and MRR count every expected entry in the top k and the first one's rank` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.4 specified recall@k/MRR evaluation oracle
- **Credible failure:** Hand-ranked literal [0.5,0.5],[1,1],[0,0] and aggregate.5 verify truncation, all expected denominator and first relevant reciprocal rank. This uniquely validates independently defined quality-gate oracle; fake/full-model evaluations cannot detect a metric reporting false success themselves.
- **Independent oracle:** Hand-ranked outcomes .5/.5,1/1,0/0 and aggregate .5; never calculated by production scorer or copied from evaluate implementation.
- **Stable seam:** Explicitly required P0.4 evaluation oracle, evaluate(rank, queries, k); its independent quality-gate caller runs real KnowledgeSearch and native model.
- **Refactor resistance:** Defined recall@k and reciprocal rank results survive replacing evaluator internals or the retrieval system; protects quality-gate false success, not helper call shape.
- **Unique protection / stronger owner:** Hand-ranked literal [0.5,0.5],[1,1],[0,0] and aggregate.5 verify truncation, all expected denominator and first relevant reciprocal rank. This uniquely validates independently defined quality-gate oracle; fake/full-model evaluations cannot detect a metric reporting false success themselves.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/eval/eval.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/eval/eval.test.ts:58`

**REWRITE** — the harness runs the set through KnowledgeSearch (fake embedder): text and meaning both rank

Retain full fixed bilingual corpus indexing through real KnowledgeSearch; assert top5 includes literal known English screenshots and Spanish free-trial answers. Remove arbitrary60% quality threshold, 20 unasserted query executions, self-counted calibration combinations and embedder call inventories.

Surviving owner: `the evaluation harness retrieves known English and Spanish answers from the indexed corpus` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.4 explicitly requires always-running fake KnowledgeSearch harness
- **Credible failure:** Harness returns before corpus indexing, loses entry IDs/body/header data or maps query results incorrectly: known English/Spanish answers are missing from top5.
- **Independent oracle:** Two independently hand-judged query→entry pairs from fixed corpus; literal ke_app_aso_screenshots and ke_paywall_trial IDs.
- **Stable seam:** openEvalSearch.rank over the explicitly required fake-embedder corpus harness, real KnowledgeSearch/text/vector index, and metadata entry IDs.
- **Refactor resistance:** Only top5 relevant IDs are asserted, with no exact order, model calls, internal array shape or output formatting.
- **Unique protection / stronger owner:** P0.4 explicitly requires an always-running harness; lower isolated search tests do not exercise corpus→harness→ranker assembly, while real quality test is asset-gated.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/eval/eval.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.

### `apps/daemon/src/knowledge/search/eval/eval.test.ts:87`

**KEEP** — the pinned model: recall@5 ≥ 0.8 on the evaluation set, and thresholds that fit its calibration

Hand-labelled bilingual/cross-language expected entry IDs supply independent relevance oracle. Real native model/search ranks corpus; cosine bands must separate known answers, near copies and nonanswers. No fake/lower seam owns actual asset quality; explicit skip when files unavailable must be reported.

Surviving owner: `the pinned model: recall@5 ≥ 0.8 on the evaluation set, and thresholds that fit its calibration` in the same file.

- **Independent contract/source:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md: P0.4 real pinned multilingual quality recall@5>=.8 and calibrated model-specific thresholds
- **Credible failure:** Hand-labelled bilingual/cross-language expected entry IDs supply independent relevance oracle. Real native model/search ranks corpus; cosine bands must separate known answers, near copies and nonanswers. No fake/lower seam owns actual asset quality; explicit skip when files unavailable must be reported.
- **Independent oracle:** Hand-picked literals, actual tokenizer/native model data, or documented fixed performance/quality budget; remove production-derived expected calculations as described.
- **Stable seam:** KnowledgeEmbedder.embed/dispose, KnowledgeSimilarity public methods, real KnowledgeSearch retrieval, or explicit eval quality gate; ONNX/tokenizer APIs are external boundaries.
- **Refactor resistance:** Final assertions must depend on vectors/public data/errors/fixed budget, not internal helper exports, subclass hooks, sort shape or collaborator call counts.
- **Unique protection / stronger owner:** Hand-labelled bilingual/cross-language expected entry IDs supply independent relevance oracle. Real native model/search ranks corpus; cosine bands must separate known answers, near copies and nonanswers. No fake/lower seam owns actual asset quality; explicit skip when files unavailable must be reported.

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/search/eval/eval.test.ts`. Normal-file integrated/final gate status is owned by root; this workstream executed only the corrected performance and explicit mutation commands recorded above. Actual model assets were not run by this workstream.
