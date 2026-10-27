# Knowledge retrieval, Phases 0 and 1: better embeddings, Qdrant-style queries, in-process

Status: approved for implementation (2026-10-27). Builds on the Knowledge Graph plugin
(`2026-10-23-knowledge-graph-plugin-design.md`, "the plugin spec"). Phase 2 (an optional Qdrant
backend) is out of scope here; this spec only makes sure Phase 2 can plug in later.

## Why

A study of Qdrant (v1.20.0, benchmarked on this host) and of the plugin's code found:

- At the plugin's scale (hundreds to tens of thousands of entries) a vector database is not
  faster than the in-process search: Qdrant did not even build an HNSW index at 50k × 384-d.
- Qdrant's *query model* is what is worth having: query-by-example ("more like this", "less like
  that"), typed payload filters with facet counts, grouping chunks into documents, MMR diversity,
  recency boosts, score thresholds, and a distance matrix for similarity graphs. All of them are
  cheap over the vectors the plugin already keeps in memory.
- The biggest quality gap is not the engine but the embeddings: the English-only
  all-MiniLM-L6-v2 on a knowledge base that is partly Spanish; titles and authors not embedded;
  chunks silently truncated at 256 tokens.
- Humans have search only in the Graph view; agents cannot filter, page past 25 hits, ask for
  similar entries, or read past 48 KB of an entry. "Related entries" exist only after LLM linking.

## Goals

1. **Phase 0 — retrieval quality.** A multilingual embedding model, contextual chunks, no silent
   truncation, and an evaluation set that measures recall.
2. **Phase 1 — Qdrant-style retrieval, in-process.** A vector-index port; filters, facets, sort,
   paging, match explanations, diversity, recency, query-by-example; similar entries and possible
   duplicates on every entry; near-duplicate reporting on save; a similarity graph layer.
3. **Best UX for both audiences.** Humans: one search everywhere, filter chips with counts,
   explained results, similar entries, duplicate merge, a similarity layer, rediscovery. Agents:
   the same power through the existing tools, compact and explained output, paging, passages.

## Non-goals

- Running Qdrant or any other server (Phase 2).
- New MCP tools. The existing six grow parameters instead (Anthropic tool guidance: consolidate).
- `structuredContent` in tool results, saved searches, spaced-repetition review, per-collection
  instructions, LLM reranking.
- Changing linking (myKG), the store format, or visibility rules.

## Shared contracts (committed before implementation)

- `packages/api/src/knowledge.ts`: `KnowledgeSearchFilters` (incl. `years`), `KnowledgeSearchSort`,
  the extended `KnowledgeSearchRequest`/`Response`, `KnowledgeEntryMatch`, `KnowledgeMatchBand`,
  `KnowledgeMatchSignal`, concept hits' `entries`, `KnowledgeFacets*`, `KnowledgeSimilarEntry`,
  `KnowledgeRelatedReason`, `KnowledgeEntryDetail.similar/possibleDuplicates`,
  `KnowledgeSaveResult.similar`, `KnowledgeEntriesQuery` filter params, the similarity-graph types,
  the new limits, and routes `knowledgeRoutes.facets` (POST) and `knowledgeRoutes.similarityGraph` (GET).
  Every new response field is optional so an older daemon still validates.
- `apps/daemon/src/knowledge/ports.ts`: `KnowledgeVectorIndex`, `KnowledgeVectorHit`,
  `KnowledgeVectorThresholds`.
- `apps/daemon/src/knowledge/search/embedder.ts`: `KnowledgeEmbedder.thresholds`,
  `embed(texts, kind?: "query" | "passage")`, `KnowledgeSimilarityThresholds`, `MINILM_THRESHOLDS`.
- `apps/daemon/src/knowledge/search/text.ts`: `embeddingHeader(meta)`, `embeddingPassage(header,
  chunk)`, `EMBEDDING_INPUT_VERSION`.
- `packages/ui/src/components/knowledge/query-state.ts`: `KnowledgeQuery` and helpers.

Contracts may be extended by an implementer when strictly needed, never changed incompatibly.

## Phase 0 — retrieval quality

### P0.1 Multilingual model

- Replace all-MiniLM-L6-v2 with **multilingual-e5-small** (384 dims, so memory and the cache
  layout are unchanged): the quantized ONNX export (`onnx/model_quantized.onnx`) plus its
  tokenizer files, pinned by Hugging Face revision and sha256 like today (`install/pins.ts`).
  Prefer the `Xenova/multilingual-e5-small` repo; if its files are unusable, another repo hosting
  the same model's ONNX export at a pinned revision.
- e5 is asymmetric: queries are embedded as `"query: " + text`, passages as `"passage: " + text`.
  The model spec carries the two prefixes; `embed(texts, kind)` applies them.
- Max tokens: 512 (e5's limit). Special tokens come from the tokenizer (`<s>`, `</s>`, `<pad>`
  for XLM-R), never hard-coded BERT ids; truncation closes with the model's own end token.
- Pooling: mean over the attention mask, then L2 normalization (e5's recipe).
- **Similarity thresholds** for the model (`KnowledgeSimilarityThresholds`: `minimum`, `good`,
  `strong`, `duplicate`) are calibrated on the evaluation set (P0.4) and committed with the pin.
  Unrelated text scores high on e5 (~0.7), so every cut-off comes from the model, never a constant.
- Linux x64/arm64 and macOS arm64 hosts (the runtime's platforms); onnxruntime-node and
  @huggingface/tokenizers stay the runtime (both already daemon dependencies).

### P0.2 Upgrading existing installs

- An installed runtime whose manifest names the old model counts as needing repair: the next
  update check (start, hourly, manual, or switching the plugin on) brings the new model in without
  user action. Prefer downloading only the model files into the existing runtime version (the
  myKG venv and uv are unchanged); a full repair install is acceptable only if model-only is not
  possible within the updater's one-target design — document which was chosen.
- Until the new model is present, nothing breaks: search runs on BM25 and the graph (the
  existing fallback), linking keeps running if myKG itself is intact.
- Vectors from another model are never mixed: the cache is keyed by model id, chunker version and
  embedding input version, so it rebuilds in the background (backfill) after the switch.
- Rollback to the previous runtime version keeps working.

### P0.3 Contextual chunks, no silent truncation

- Every chunk is embedded as `embeddingPassage(embeddingHeader(meta), chunkText)`: title, author
  and handle, kind, then the chunk (collections excluded: relabelling never re-embeds).
- The vector cache key of an entry is the sha256 of `embeddingHeader(meta) + "\u0000" + body`
  (so a title/author/kind edit re-embeds), and the cache is versioned with `CHUNKER_VERSION` and
  `EMBEDDING_INPUT_VERSION`.
- Chunking (`chunkBody`, new `CHUNKER_VERSION`) keeps word windows with overlap but also caps each
  chunk's characters, so token-dense text (code, JSON, URLs, non-Latin scripts) stays under 512
  tokens including the header and prefix. The embedder counts inputs it had to truncate and logs
  the count once per batch at warn level (never per entry), so truncation is visible, not silent.
- Search snippets and `passage` offsets still refer to the body only (never the header).

### P0.4 Evaluation set

- A fixed corpus of ~30 short entries (English and Spanish, overlapping topics like the real
  knowledge base: SEO, ads, apps, TikTok, paywalls) and ~20 queries (English, Spanish and
  cross-language) with their expected entry ids, under `apps/daemon/src/knowledge/search/eval/`.
- A test computes recall@5 and MRR through `KnowledgeSearch` with the **real** model when it is
  installed locally (skipped with a clear message otherwise, like the existing model test), and
  asserts recall@5 ≥ 0.8. A second, always-running test exercises the harness with the fake embedder.
- The same harness prints the calibration data (cosine of matched vs unmatched pairs) used to set
  the thresholds; the chosen numbers are recorded in a comment next to the pin.

## Phase 1 — Qdrant-style retrieval, in-process

### The vector index port (R1)

- `KnowledgeVectorIndex` (ports.ts) is the only way search, similarity and facets touch vectors.
  The in-process implementation lives in `search/vector-index.ts`: it owns the per-entry chunk
  vectors, the `VectorCache`, the embed queue/backfill, and brute-force scoring (unchanged
  algorithm). `KnowledgeSearch` keeps BM25, the graph expansion, fusion and the read views.
- `entryVector(id)` is the L2-normalized mean of the entry's chunk vectors, cached until the
  entry's vectors change. `generation()` increments on every vector change.
- `search(q, accept, limit, minimum?)` scores only accepted entries (visibility and filters are
  applied *before* the dot products — spec goal "scoping inside search", and cheaper).
- Phase 2 can add a Qdrant implementation of this port without touching callers.

### Search (R2)

Request/response: see contracts. Semantics:

- **Validation.** At least one of `query` (trimmed, ≤ 1000 chars) and `similarTo`. Ids in
  `similarTo`/`unlike` must be visible entries (unknown or hidden → `KNOWLEDGE_NOT_FOUND` naming
  the id). Filter lists ≤ KNOWLEDGE_FILTER_MAX_VALUES; bad dates → `KNOWLEDGE_INVALID`.
- **Filters** (`KnowledgeSearchFilters`) are evaluated with visibility in the same accept
  predicate for BM25, vectors, expansion and concepts' entries. Kinds compare case-insensitively
  and trimmed; authors match `author` (case-insensitive, whitespace-collapsed) or `handle`
  (case-insensitive, leading "@" ignored); years match the first 4 chars of `postedAt ?? savedAt`;
  date bounds compare `YYYY-MM-DD` prefixes when either side is a bare date, else full ISO strings.
- **Candidates.** Each signal list keeps up to 100 candidates (was 50). Signals: `keyword` (BM25),
  `meaning` (vector), `concept` (one-hop expansion; unchanged seeds), `similar` (query-by-example).
- **Query by example.** Target = normalize(mean(entryVector(similarTo))). Search the index with it
  (minimum = model `minimum`), excluding the examples and the unlike ids. With `unlike`, reorder
  those matches by s′(target) − max(0, s′(away) − s′(target)), away = normalize(mean(entryVector(
  unlike))), where s′ rescales a similarity from [minimum, 1] to [0, 1] (below minimum → 0): only
  entries closer to the unlike ones than to the examples drop, so the examples' topic stays on top. Steering the order, not the target:
  a sentence model puts all texts in a narrow cone (e5 scores any two entries 0.73–0.99), so
  subtracting a vector from the target drops every entry below `minimum`. If no example has vectors, fall back to BM25 over the
  examples' titles and first 60 body words. With `query` too, the `similar` list is fused with the
  others (weight 1). Without `query`, only `similar` (plus nothing else) ranks.
- **Fusion** stays RRF (k = 60, weights keyword 1, meaning 1, similar 1, concept-expansion 0.5).
- **Sort.** `relevance`: fused score. `recent`: fused score × (0.5 + 0.5 · 2^(−ageDays/90)),
  age from `postedAt ?? savedAt`. `newest`: every fused match ordered by `savedAt` desc, then id.
- **Diversity (MMR)**, when `diverse !== false` and sort ≠ `newest`: over the ranked entries
  (≤ KNOWLEDGE_SEARCH_MAX_RESULTS), greedily pick by λ·rel − (1−λ)·max cosine(entryVector) to
  already-picked, λ = 0.7, rel = score / best score. Entries without vectors have similarity 0.
  Applied before paging so pages are stable.
- **Paging.** The ranked entry list is capped at KNOWLEDGE_SEARCH_MAX_RESULTS; `total` = its length.
  `nextCursor` = base64url of `{v:1, o: nextOffset, h: fingerprint}` where the fingerprint hashes
  the normalized request (query, resolved collections, filters, examples, sort, diverse) and the
  caller's visibility; a mismatched or malformed cursor → `KNOWLEDGE_INVALID`. Concept hits appear
  on the first page only, at most floor(limit/3) as today, and count toward that page's `limit`.
- **Match explanation** (`match`): `via` in the fixed order keyword, meaning, similar, concept;
  `terms` = distinct query words (as typed, lowercased) whose tokens occur in title/body/author;
  `passage` = best meaning chunk's body offsets, index and count (null when not matched by meaning);
  `concepts` = up to 3 expansion seeds that led to it.
- **Match bands.** s = best-chunk cosine (meaning) or cosine to the example target (similar);
  c = share of the query's distinct tokens present in the entry.
  `strong` if s ≥ thresholds.strong, or (c = 1 and `via` has ≥ 2 signals);
  `good` if s ≥ thresholds.good, or c ≥ 0.5, or `via` includes concept;
  else `weak`. Without embeddings only c and via decide.
- **Concept hits** add `entries: {id, title}[]` for their `entryIds`.
- **Facets** with `facets: true`: counts over the whole ranked entry list (all pages).
- `score` stays the normalized fused score (0..1).

### Entries list filters (R3)

`GET /api/knowledge/entries` accepts the filter params of `KnowledgeEntriesQuery` (comma-separated
lists, ISO bounds) with the same semantics as search; cursor paging unchanged.

### Facets (R4)

`POST /api/knowledge/facets` (`KnowledgeFacetsRequest`): counts over every visible entry the
narrowing and filters keep. Kinds by kind (label = kind); authors by handle when present, else
author (label "Name (@handle)" / "Name" / "@handle"); collections by visible collection id (label
= name) plus `unfiled` for `all` callers; years by `postedAt ?? savedAt`, newest first; others by
count desc then label. At most KNOWLEDGE_FACET_MAX_VALUES each.

### Similar entries and possible duplicates (R5)

`entryDetail` (`GET /items/:id`, `GET /entries/:id`) adds:
- `similar`: union of (a) up to 8 nearest entries by `entryVector` (minimum = thresholds.good),
  (b) concept-related entries (`graph.relatedEntries`, with up to 3 shared concept refs and the
  shared count), (c) up to 2 most recent entries by the same author/handle. Each item lists every
  reason that applies (meaning first). Order: similarity desc (null last), shared concepts desc,
  savedAt desc. At most 8. Only visible entries; never the entry itself.
- `possibleDuplicates`: up to 3 visible entries with entry-vector cosine ≥ thresholds.duplicate.
- `related` is unchanged (older clients).

### Near-duplicates on save (R6)

After the save route's indexing wait, for each `saved` result whose entry has vectors: up to 3
caller-visible entries (not in the same save request) with entry-vector cosine ≥
thresholds.duplicate, as `similar` with citation. Never blocks the save beyond the existing wait.

### Similarity graph (R7)

`GET /api/knowledge/similarity-graph` (`KnowledgeSimilarityGraphQuery`):
- Nodes: visible embedded entries in the narrowing, most recent `limit` (default 1000, max 2000).
- Edges: for every node its top-`k` neighbours (cosine of entry vectors, ≥ thresholds.minimum),
  de-duplicated; plus a maximum spanning forest (Kruskal) over the candidate set of each node's
  top-max(k, 8) neighbours, marked `tree: true` (a tree edge may also be a k-NN edge: one edge,
  tree = true).
- Clusters: connected components over edges with similarity ≥ thresholds.good, largest first;
  label = most common concept name among the cluster's linked entries, else the two most
  distinctive title tokens (frequency in the cluster's titles over document frequency), null for
  singletons.
- Computation yields to the event loop at least every 50 ms; results are cached per (visibility,
  narrowing, k, limit, index generation, graph revision). Budget: ≤ 2 s cold at 1,000 entries.
- Works before any linking run (no concepts needed).

### Agent tools (A1)

No new tools. In `apps/daemon/src/mcp/tools/knowledge.ts`:

- `knowledge_search`: `query` becomes optional; add `similarTo`, `unlike` (entry ids),
  `kinds`, `authors`, `years`, `postedAfter`, `postedBefore`, `savedAfter`, `savedBefore`
  (top-level, typed — the self-query pattern), `sort` (`relevance|recent|newest`), `cursor`.
  Refuse a call with neither query nor similarTo (`INVALID_ARGUMENT`). Output per entry hit:
  `N. ke_… · kind · Author (@h) · date · in Collections · <band> · via meaning+keyword`, then
  `   "Title"`, the snippet line, `   passage: chars A–B of L (chunk i/n)` when present, then
  `   cite: …`. Concept hits list their entries as `ke_… "Title"`. Footer:
  `Showing a–b of total.` plus `Next page: cursor "…".` when there is one, and a narrowing hint
  when total > shown. Weak hits are kept but labelled; the description tells the agent not to
  cite weak hits as evidence.
- `knowledge_get`: add `ids` (≤ 5, instead of `id`) and `from` (character offset into the body).
  The body window is 48,000 bytes total split across the requested entries; when cut, the footer
  says `[chars X–Y of Z — continue with from=Y]`. Entry output adds `Similar:` (≤ 8 lines:
  `- ke_… "Title" · meaning 0.91 · shares concepts A, B · same author` + cite) and
  `Possible duplicates:` lines.
- `knowledge_save`: each saved item with `similar` gets
  `  possible duplicate of ke_… "Title" (0.95) — if it is the same content, knowledge_merge the two`.
- `knowledge_merge(ids[2..10], keep?, title?, body?)` (A2): one `POST /api/knowledge/entries/merge`.
  The kept entry (`keep`, else the oldest by `savedAt`, ties to the smaller id — `knowledgeMergeKeep`,
  shared with the panel) gets the union of all collections (its own first) and `title`/`body` when
  given; the others are deleted. Every id must be visible; everything is checked before anything
  changes. Act tier, no card, advertised with search and get.
- Descriptions stay within the registry budgets; the knowledge family budget may rise to 7 KiB
  if needed, with the reason in the test comment. Field descriptions ≤ 160 bytes.

### Human UI (U1–U3)

Shared: `KnowledgeView` owns one `KnowledgeQuery` (query-state.ts) used by the List view, the
Graph view search box, and the panel's "More like this". Props between components:
- `KnowledgePanel`: `onFindSimilar?: (entryId: string) => void` (opens the List view searching
  `similarTo: [id]`).
- `KnowledgeGraphView`: `query` / `onQueryChange` and `onOpenInList?: () => void` ("Show all
  results" switches to the List view with the same query).
- `KnowledgeListView`: `query` / `onQueryChange`.

**List view (U1)**
- A search box (debounced 250 ms) and the filter bar: Kind, Author, Year chips (multi-select
  popovers listing facet values with counts from `POST /facets`, scoped to the selected collection
  and the other filters), a Sort control (Relevance / Recent / Newest; Newest is the only option
  when not searching), and "Clear".
- Not searching: the entries list (filters via `GET /entries` params), newest first, paged as now.
  Searching: search hits (filters, sort, `similarTo`/`unlike`), paged with `nextCursor`
  ("Load more"), with the total ("31 results").
- Each hit card: title and snippet with query terms highlighted (`match.terms`), a band chip
  (strong/good/weak), via badges (Keyword, Meaning, Similar, Concept X), the passage location for
  long entries, collections, link state.
- A "More like this" query shows its examples as removable chips ("Like: Title ×", "Not like:
  Title ×"); each result card offers "Less like this" (adds to `unlike`).
- "Rediscover" strip when not searching and no filters: up to 5 entries saved more than 30 days
  ago that are similar to entries saved in the last 7 days (search `similarTo` = up to 5 most
  recent ids, `savedBefore` = now − 30 days). Hidden when empty; dismissible for the session.
- Keyboard: ↑/↓ move between results, Enter opens, Esc clears the search box.

**Entry panel and citations (U2)**
- Entry body rendered as Markdown with the chat's renderer (safe links, no raw HTML), with a
  "Plain text" toggle.
- "Similar" section from `detail.similar`, each with reason chips ("Meaning 91%", "Concepts: A, B",
  "Same author"), falling back to `related` from an older daemon. A "More like this" action
  (`onFindSimilar`).
- Possible duplicates banner: "Looks like the same content as <Title> (95%)", actions Open,
  Merge (confirm dialog: keeps the older entry, adds this entry's collections to it, deletes this
  one — one call to the merge route, which refuses before changing anything), and Keep
  both (hides the banner for this entry for the session).
- Knowledge citation chips in chat get a hover/focus card: title, byline, date, collections, a
  2-line snippet (entry detail fetched lazily, cached with the existing citation cache); a deleted
  entry shows "deleted".

**Graph view (U3)**
- Search dropdown: ↑/↓ with `aria-selected`, Enter opens the highlighted hit, band + via badges,
  highlighted terms, "Show all N results" (→ `onOpenInList`).
- A layer switch "Concepts | Similarity". Similarity: entries as nodes from
  `GET /similarity-graph` (collection chips apply), coloured by cluster (a "Colour by: cluster |
  collection" toggle), tree edges solid, k-NN edges thinner/dashed, cluster legend with labels and
  sizes, click a node → entry panel, hover → title. Reuses the canvas and the force layout (worker).
  Empty states: no embedded entries ("Embeddings are being computed…" when the runtime is
  installed, "Install the runtime to see similarity" otherwise). Refetch on `knowledge.changed`.

## Compatibility and safety

- Every new response field is optional; UI validators tolerate their absence (older daemon).
- Old clients ignore new fields; `related` stays.
- Visibility is unchanged and enforced inside ranking for every new path (examples, facets,
  similar, duplicates, graph): a hidden entry never appears and is refused like an unknown one.
- No new network access at query time; model downloads only through the installer.
- Logs never include entry bodies.

## Performance budgets (5,000 entries, fake embedder, CI host)

- Search p95 < 300 ms (existing perf test), including filters, MMR and facets.
- Entry detail (similar + duplicates) p95 < 100 ms.
- Facets p95 < 100 ms.
- Similarity graph ≤ 2 s cold at 1,000 entries on an idle host; cached afterwards. The perf test also times the bare pairwise dot products in the same run and allows 2.5× that floor, so a busy host does not fail it while an algorithmic regression still does.

## Testing

Each workstream adds unit tests beside its files and extends the existing ones (search.test.ts,
routes-data.test.ts, e2e-tools.test.ts, knowledge.test.ts for tools, UI logic tests). Required:
filters × visibility (a hidden entry never leaks through any new path), cursor round-trip and
mismatch refusal, MMR determinism, band rules, example search with and without vectors, facets
counts, similar/duplicate reasons, save similarity, similarity-graph edges/tree/clusters/cache,
installer upgrade path (old model → new), embedder prefixes/special tokens/truncation counting,
eval harness, tool rendering and input validation, UI validators for new fields, List/Graph/panel
logic. `pnpm check:changed` passes on the merged branch.

## Workstreams and file ownership

| Stream | Owns |
|---|---|
| P0 model & quality | `install/*` (pins, installer, runtime, updater), `search/embedder.ts`, `search/text.ts` chunker, `search/eval/**`, embedder/installer tests |
| D1 search core | `search/vector-index.ts` (new), `search/vector-cache.ts`, `search/search.ts` (search, list filters, all but `entryDetail`), `routes-data.ts` search/entries schemas, search tests |
| D2 similarity & facets | `search/similarity.ts`, `search/facets.ts` (new), `search.ts` `entryDetail` only, `routes-data.ts` new routes and the save handler's `similar`, their tests |
| A1 agent tools | `apps/daemon/src/mcp/tools/knowledge.ts` and its tests, registry budget |
| U1 list & shared UI lib | `KnowledgeView.tsx`, `KnowledgeListView.tsx`, `knowledge.logic.ts`, `lib/knowledge/**` search/facets/entries functions and validators |
| U2 panel & citations | `KnowledgePanel.tsx`, `KnowledgeCitation.tsx`, `lib/knowledge/citations.ts`, entry-detail validators |
| U3 graph | `KnowledgeGraphView.tsx`, `KnowledgeGraphCanvas.tsx`, `graph.logic.ts`, `graph-layout*`, similarity-graph client and validators |
