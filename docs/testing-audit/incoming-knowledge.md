# Incoming knowledge test audit

Incoming commit: `923b3a51b594ef668483a5bd320af41187899e34`; comparison base: `beb7516b`.

Changed/new test registrations in the eight non-search knowledge test files from beb7516b to incoming923b3a51. Unchanged pre-existing registrations are covered by knowledge-desktops.json; incoming search/** belongs to other owners.

All 25 affected test registrations were read with their production owners and the retrieval design. Dispositions: 13 KEEP, 11 REWRITE, 1 CONSOLIDATE; 24 affected registrations survive. Five test files changed, with 54 net test lines removed. This is separate from the original 341-registration knowledge/desktops audit.

The six evidence fields below apply to each listed test individually. A shared refactor-resistance statement means the retained assertion checks public data/state/files or protocol outcomes; it does not depend on private call shape, object identity, cosmetic wording or the old fake-index override.

Implemented cleanup:

- Rewrite routes-data.similarity harness through public KnowledgeSearch constructor with controlled KnowledgeEmbedder (title-leading passages→fixed fixture vectors, thresholds supplied at embedder port), removing private similarityIndex override and fake store-event vector updates. Use null embedder for facets-only cases.
- Remove duplicate algorithm-level exact scores/order/reasons from route tests, preserving route field forwarding, principal scope, same-save exclusion, model-less author fallback and graph validation. Replace self-derived fallback expected entry by known comparisonID.
- Consolidate failed plugin model-repair integrity/runtime assertions into existing failed hourly retry test; delete redundant full-install case. Keep success automatic and rollback cases with distinct trigger/failure modes.
- Trim installer split-readiness repeated runtime metadata/lexical pin inventories, retaining true/false readiness and independently required E5 default model config/asset path/URL contract.
- Remove direct API encoder equality assertion from entries route case; real query roundtrip remains. Replace merge object-identity assertion by public response timestamp check.
- Remove uncontracted MCP merge wording assertions; preserve actual kept/deleted body/search/scope/manifest outcomes.

Private-wrapper removal belongs to the search owner: the route consumer is gone and the owner was notified. The shared fake vector helper still has legitimate lower-level similarity callers and is retained. The installer runtime helper still has non-removed test callers; no dependency, fixture or snapshot became orphaned here.

The critical merge end-to-end scenario remains because it uniquely checks catalog execution, caller identity, real HTTP/store/search effects and tool visibility. Model-only upgrade, rollback, integrity and retry cases retain their distinct externally visible failure paths.

## Dispositions

### REWRITE: `apps/daemon/src/knowledge/e2e-tools.test.ts:491`

knowledge_merge end to end: a hidden id refuses the whole merge; the kept entry gets every collection, the rest leave search; who is advertised it

Remove incidental result wording checks (Merged/in/cite framing) while retaining actual kept/deleted search/read states, hidden-ID whole-operation refusal and manifest advertising. Existing MCP renderer owner owns any documented output formatting.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 / Compatibility and safety
- **Recognizable regression**: The catalog→principal→HTTP→store/search merge chain must honor visibility and delete only requested entries; a missing tool binding or dropped principal fails actual reads/searches.
- **Independent oracle**: Known independent supplied bodies, kept/deleted IDs and visible collection metadata; wording is not the oracle.
- **Stable seam**: Catalog executor and real InjectDaemonApi/KnowledgeService; public tool outcomes/read/search/manifest.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Lower store/route tests bypass MCP catalog/principal/manifest composition.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/e2e-tools.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/install/installer.test.ts:452`

readiness splits myKG from the model: another model's install runs but lacks this model

Keep split readiness and independently required E5 model ID/prefix/token-limit/path/URL checks. Remove repeated knowledgeRuntimeOf mapping assertions already protected by tracker install/old-model tests and embedder runtime-source owner; remove pin hash/revision lexical inventories that cannot establish asset correctness.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.1 / P0.2
- **Recognizable regression**: An old-model runtime must still make myKG available while the required new model is unready; the default pin must select multilingual E5 with its asymmetric input settings.
- **Independent oracle**: Literal true/false readiness, required multilingual model key, query:/passage: bytes and512 limit.
- **Stable seam**: Installer readiness helpers against independently installed old-model fixture and production default model configuration.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Existing full-readiness tests do not prove myKG remains available separately from model readiness; tracker/model tests own copied runtime metadata and actual asset/eval correctness.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/installer.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/install/installer.test.ts:478`

an install with another model is repaired with the model alone, the rest of the version untouched

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 / tolerant manifest persistence
- **Recognizable regression**: A model-only repair rebuilds venv, drops unrelated manifest fields, retains stale model bytes or mistakenly repairs another wheel/overlay.
- **Independent oracle**: Old venv mtime, original unknown fields/install time and independently provided model files/hashes; no uv subprocess/model-only URLs.
- **Stable seam**: Actual installer model-only upgrade over real runtime/manifest/files and network/process ports.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Plugin tests trigger repair but do not enumerate file/manifest compatibility; this is the lowest installer owner.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/installer.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/install/installer.test.ts:525`

a model download that does not match its hash is refused and leaves the version as it was

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 / integrity and cancellation guarantees
- **Recognizable regression**: Partial model upgrade corrupts installed assets, cancellation publishes stale/incomplete new model or a vanished version is recreated.
- **Independent oracle**: Original manifest/model bytes remain identical, typed model/install step and explicitsha256/HTTP/cancel reasons.
- **Stable seam**: installKnowledgeModel real temp directories, independently supplied corrupted/missing download bytes and cancelled signal.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Generic full installer failure test does not traverse model-only staged swap path.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/installer.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/install/plugin.test.ts:159`

turning it on installs the pinned runtime in its own lane; the runtime port follows

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.1/P0.2 runtime configuration plus original plugin lifecycle
- **Recognizable regression**: Runtime loses new prefix/token-limit/threshold/readiness metadata when publishing installed model.
- **Independent oracle**: Literal supplied fixture model input metadata, current installed version and emitted runtime DTO.
- **Stable seam**: Real PluginsService/KnowledgeRuntimeTracker and persisted files.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Embedder helper receives a runtime already built; this owns producer/tracker propagation of new fields.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/install/plugin.test.ts:357`

an install from before the model change keeps linking; the hourly check brings the model alone

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 automatic upgrade
- **Recognizable regression**: A normal hourly check never repairs an existing old-model install or makes linking unavailable before model upgrade.
- **Independent oracle**: Current myKG version stays present, readiness false→true, no uv runs and only independent model download URLs.
- **Stable seam**: Real updater/runtime-tracker over old installed model and virtual hourly clock.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Installer direct tests do not prove automatic trigger selection or tracker model readiness transition.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts` (from `apps/daemon`; pending root execution).

### CONSOLIDATE: `apps/daemon/src/knowledge/install/plugin.test.ts:387`

a model download that fails its hash records a model error; the runtime keeps linking without the model

Delete separate full plugin-install execution; move its unique manifest-old-model preservation, embeddingModelReady:false and sha256 failure-reason assertions into the following failed-model-repair retry test after its first failed hourly attempt.

Surviving owner: `apps/daemon/src/knowledge/install/plugin.test.ts :: a failed model repair is not retried every hour; turning on and a manual check retry it`. Unique protection: the next test executes the same failed model upgrade and now also checks its integrity reason, readiness and original manifest.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 / Install and updates
- **Recognizable regression**: Failed model repair must leave the installed myKG runtime usable, preserve old model metadata and expose a model integrity error.
- **Independent oracle**: Original model ID, known bad download bytes, model error reason and false model readiness.
- **Stable seam**: PluginsService updater + KnowledgeRuntimeTracker persisted public lifecycle.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Installer integrity owner protects atomic bytes; following retry test already performs the identical failed upgrade and can own all remaining runtime/error assertions.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/install/plugin.test.ts:405`

a failed model repair is not retried every hour; turning on and a manual check retry it

Absorb integrity/runtime/manifest assertions from the deleted duplicate case at first failure. Keep virtual-hour non-retry and enable/manual recovery checks unchanged.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2; updater documented large-download retry discipline
- **Recognizable regression**: An hourly failed repair must not download130MB repeatedly, explicit starts/manual checks must retry, and myKG must remain usable throughout.
- **Independent oracle**: Literal attempt counts across distinct trigger events, known original manifest model ID and subsequent ready/error states.
- **Stable seam**: PluginsService and KnowledgeRuntimeTracker with real temp files and controlled network/clock.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: This is the lowest public orchestration owner for distinct hourly/enable/manual trigger behavior; installer helpers do not schedule or persist plugin errors.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/install/plugin.test.ts:451`

rollback to a version with the old model still works; the next check gives it the new model

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 rollback compatibility
- **Recognizable regression**: Rollback rejects old-model runtime or repair upgrades to the rejected/skipped version instead of repairing selected one.
- **Independent oracle**: Explicit current/previous versions, skipped newer version, old model false readiness followed by true.
- **Stable seam**: Plugin rollback/check/current/previous/skipped state plus runtime tracker/files.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Ordinary repair does not exercise rollback candidate gates and skipped-version preservation.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/install/plugin.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:128`

POST /facets counts what the caller sees, narrowed by collections and filters

Replace shared private similarityIndex monkeypatch with public-constructor controlled embedder/native index; use no embedder for facets-only scenarios. Trim duplicated complete facet-label/sort snapshots; retain actual counts, request narrowing and both session/principal privacy outcomes.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R4 / Compatibility and safety
- **Recognizable regression**: Each public facet endpoint must apply caller visibility and filters and omit hidden collection/author data.
- **Independent oracle**: Literal fixture entry counts and known visible/hidden labels, independent of helper return values.
- **Stable seam**: Real Fastify request and actual store/search/compute facets, constructor dependency only.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Facets unit owner validates normalization/order formulas; only route case verifies HTTP body, principal and narrowing are supplied to that computation.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:171`

POST /facets refusals: bad shapes and filters are KNOWLEDGE_INVALID; hidden collections are unknown; the plugin gate

Remove private fixture override; facets-only setup uses no embedder. Preserve typed invalid/hidden/unfiled/disabled route refusal cases.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R4 / Compatibility and safety
- **Recognizable regression**: Malformed public facet requests are refused; hidden collections remain indistinguishable from unknown ones and disabled plugin gates the endpoint.
- **Independent oracle**: Literal400/409 codes, independent malformed inputs and absence of hidden collection names in hints.
- **Stable seam**: Real Fastify injection and typed HTTP status/error-code output.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Filter helper tests bypass HTTP schema/gate/principal behavior; other URLs cannot prove this route was registered with the gate.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:188`

entry details carry similar entries and possible duplicates, scoped to the caller

Use controlled public embedding dependency/native index. Remove repeated exact cosine/order/reason algorithm expectations owned by similarity.test.ts; keep known candidate IDs, self/unrelated exclusion and caller-visible similar/duplicate results through both entry/item routes.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R5 / Compatibility and safety
- **Recognizable regression**: Entry and item transport must include computed similarity/duplicates without exposing hidden entries or collections.
- **Independent oracle**: Independent document IDs and explicit visible/hidden fixture membership.
- **Stable seam**: Real GET entry/item endpoints, real KnowledgeSearch/KnowledgeSimilarity/native index.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Similarity unit owns scoring/reasons/caps; route owns DTO augmentation and principal-derived scope.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:213`

save: each saved entry lists visible near-duplicates outside the same save; duplicates of the request carry none

Use controlled embedder/native index; drop exact0.9108/0.9851 score calculations and second Global-save top-three replay already owned by similarityForSaved unit. Preserve index-before-read, stamped caller privacy, same-save exclusion, duplicate-result omission and citation identity.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R6 / Compatibility and safety
- **Recognizable regression**: A save reports only already-visible external near duplicates after its indexing wait, never other entries from the same request.
- **Independent oracle**: Known saved and pre-existing IDs, hidden billing ID, same-batch twin IDs and duplicate status.
- **Stable seam**: Real save HTTP handler→store→native index→similarity result.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Unit helper cannot prove save route waits for indexing or supplies request IDs/principal scope; helper owns mathematical ranking/top3.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:251`

without an embedding model: no meaning or duplicates (concepts and author still apply); save similar is []

Remove private fixture seam and self-derived expected entry (`entry: detail.similar[0].entry`). Assert known same-author comparison ID plus null similarity/author reason; retain empty saved suggestions and public empty graph counts.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 / R5 / R6 / R7
- **Recognizable regression**: Retrieval routes remain useful without model vectors: author similarity remains and meaning/duplicates disappear without throwing.
- **Independent oracle**: Known same-author candidate ID, null cosine and empty duplicate/graph results.
- **Stable seam**: Public entry/save/graph HTTP endpoints with null embedder source.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Similarity unit owns fallback algorithm; this route test owns its composition with an actually model-less index and save handler.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.similarity.test.ts:265`

GET /similarity-graph: visible nodes only, narrowing, and query validation

Use controlled embedder/native index, remove exact cluster-size assertion owned by similarity graph unit; retain public node/edge privacy, narrowed limit/truncation, scoped collections, numeric validation and disabled-plugin gate.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R7 / Compatibility and safety
- **Recognizable regression**: Similarity graph HTTP parameters and principal must select only authorized embedded entries and preserve documented limits.
- **Independent oracle**: Known node/edge endpoint IDs, visible collection IDs and literal error codes/limits.
- **Stable seam**: Real GET graph route over native vector index, no private patches.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Graph unit owns spanning tree/cluster mathematics; route uniquely owns query parsing/coercion/narrowing/principal/gate.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.similarity.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/routes-data.test.ts:367`

search takes filters, examples, sort, paging and facets; bad values are refused

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R2 validation/filters/cursors/examples/facets
- **Recognizable regression**: Route strips new optional query fields, rejects validnulls, leaks hidden examples or accepts scope-mismatched cursor.
- **Independent oracle**: Independent seed IDs, expected totals/page unions, hidden example404 and scope-mismatch400.
- **Stable seam**: Real search HTTP request schema and real search owner.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Search unit owns algorithms; only HTTP tests own public request translation/nullish/schema rejection.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.test.ts:422`

entries list takes the search filters as query params

Remove direct encodeKnowledgeFilterList string-equality helper assertion; retain client-encoder→HTTP parser roundtrip for comma-containing/escaped names, case/date filters, invalid values and privacy.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §R3 / filter serialization contract
- **Recognizable regression**: The public entries URL accepts typed filter lists including literal commas, escaped values and scope while refusing malformed encodings.
- **Independent oracle**: Known fixture author names/IDs and literal400 invalid codes; expected results are independent of encoder implementation.
- **Stable seam**: Shared API encoder used as request input→real Fastify entries route.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: API unit owns exact encoding bytes; route needs actual parsing/visibility behavior, including long valid encoded lists.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/routes-data.test.ts:503`

merge: one call edits the kept entry and deletes the rest; a hidden id or a bad request changes nothing

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 / visibility/all-before-change guarantee
- **Recognizable regression**: Route forgets preflight visibility, forwards wrong title/keep, fails to index merged title/deletion or emits wrong public IDs.
- **Independent oracle**: Explicit kept/deleted IDs, independent title/collection union, original state on refusal, actual search index updates.
- **Stable seam**: Merge HTTP route with real store/search and public change events.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Store has no caller principal and cannot own route auth/preflight/index/event composition.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.test.ts` (from `apps/daemon`; pending root execution).

### REWRITE: `apps/daemon/src/knowledge/routes-data.test.ts:545`

merge: without keep the oldest stays (same instant: the smaller id); a kept entry that already has it all is not rewritten

Replace private getMeta object-identity assertion by public merged.kept.entry.updatedAt equality; retain default kept ID, deleted ID and externally published changed IDs. Lower store test owns byte/no-op persistence.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 / no-op persistence
- **Recognizable regression**: An omitted keep chooses documented oldest/tie-break entry; no-op kept metadata remains unchanged while the deleted entry is announced.
- **Independent oracle**: Independently selected min fixture ID and pre-operation public updatedAt value.
- **Stable seam**: Real merge HTTP DTO and changed event, not store object identity.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Store tests own physical no-op; this route case uniquely protects optional keep/default and its public event/response translation.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/routes-data.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/service.test.ts:207`

the status says whether the embedding model is installed and loadable

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §P0.2 / model readiness status contract
- **Recognizable regression**: Status reports old/missing/broken model ready or drops readiness from public status update.
- **Independent oracle**: Literal installed vs model-ready flags and actual successful fallback search after model failure.
- **Stable seam**: KnowledgeService.status and registered status/search HTTP routes with controlled runtime/embedder source.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Installer/tracker tests only know asset presence; service owns loaded-index failure and public readiness transport.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/service.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/store/store.test.ts:486`

merge: keeps the oldest by default, unions collections (its own first, then the others' in order), deletes the rest

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 merge semantics and physical persistence
- **Recognizable regression**: Wrong default keep/union/delete or stale mirror/index/data after successful merge.
- **Independent oracle**: Known chronological fixture IDs, explicit ordered collection union, deleted IDs and actual surviving files.
- **Stable seam**: KnowledgeStore.mergeEntries over actual persisted entries and myKG mirror.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: HTTP/MCP composition does not enumerate ordered union and actual disk/mirror invariants.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/store/store.test.ts:512`

merge: an explicit keep, a new title and a combined body are applied to the kept entry

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 explicit keep/title/body
- **Recognizable regression**: Explicit keep ignored, merge drops new content or fails to queue re-extraction.
- **Independent oracle**: Independent selected middle ID, literal new title/body and edited/linkState pending.
- **Stable seam**: KnowledgeStore.mergeEntries stable request/result plus persisted mirror.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Default merge case leaves text intact and cannot prove explicit overwrite path.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/store/store.test.ts:528`

merge: a kept entry that already has every collection and gets no new title or text is not rewritten

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 preserve-kept entry; no-op write/event contract
- **Recognizable regression**: No-op merge rewrites kept entry or emits edited/relabelled, causing unnecessary linking/re-embedding.
- **Independent oracle**: Exact pre-operation file bytes and public stored timestamp, only deleted event.
- **Stable seam**: Store merge result, actual entry bytes/updatedAt and change events.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Route tests cannot own physical write/no-op guarantee and are being decoupled from object identity.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/store/store.test.ts:544`

merge: entries saved at the same instant keep the smaller id

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 documented deterministic savedAt tie-break
- **Recognizable regression**: Default tie picks input order/largest ID instead of documented minID.
- **Independent oracle**: Independent lexicographic order of randomized IDs with equal savedAt.
- **Stable seam**: KnowledgeStore.mergeEntries with a single simultaneous-save batch.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Chronological three-entry merge fixture never has equal timestamps.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts` (from `apps/daemon`; pending root execution).

### KEEP: `apps/daemon/src/knowledge/store/store.test.ts:560`

merge: refusals are checked before anything changes

Retain; the incoming change protects the independently specified behavior below without a lower stable owner that supersedes this case.

- **Independent source/contract**: docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md §A2 atomic preflight; public limits/validation
- **Recognizable regression**: Bad ID/keep/title/body/duplicate/limit input edits/deletes part of batch before refusal.
- **Independent oracle**: Literal error codes, original file list and metadata/noevents.
- **Stable seam**: KnowledgeStore.mergeEntries over independent invalid requests and original disk state.
- **Refactor resistance**: Retained assertions target public files/DTO/state/protocol outcomes; proposed rewrites remove private overrides, reference identity, helper-derived expected values and cosmetic wording.
- **Unique protection / stronger owner**: Route schemas reject shapes but direct store/multiple callers require store-level all-before-change gate.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/knowledge/store/store.test.ts` (from `apps/daemon`; pending root execution).

## Validation and performance

Scoped `git diff --check` passed. This workstream did not run incoming tests or typechecks while the root-owned reference suite had the exclusive execution slot. Focused affected files, typechecks, full-suite correctness and comparable timings remain root-owned final gates. No incoming speedup, CI saving or successful gate is claimed here.

The earlier original-baseline linking diagnostic is recorded in `knowledge-desktops.md`; it does not validate the incoming retrieval/model code. Final root validation and delivery results supersede these pending statuses.
