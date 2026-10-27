# Knowledge phase 2: the concept graph and the similarity graph feed each other

Builds on `2026-10-27-knowledge-retrieval-phase0-1-design.md`. Contracts are committed with this spec
(`packages/api/src/knowledge.ts`, `apps/daemon/src/knowledge/ports.ts` `KnowledgePairCheck*`,
`apps/daemon/src/knowledge/search/gaps.ts`); the code and those contracts win where this text is vague.

## Why

The two graphs barely touch. The concept graph (myKG, LLM extraction) has 4,161 concepts for 126
entries, many of them the same thing under slightly different names, and the extractor never sees
what similar entries already said. The similarity graph (embeddings) knows which entries are about
the same thing but cannot say why. Each can fill the other's blind spot, and crossing them surfaces
insights neither shows alone: contradictions, bridges, single-source claims, link gaps.

## Goals

1. Fewer duplicate concepts, so the concept graph is denser and better connected.
2. Linking that reuses existing concepts and sees related entries, for new entries and, automatically,
   for every entry linked before this phase.
3. Similar entries and the similarity graph that know which concepts tie entries together and which
   entries disagree.
4. An Insights surface (route, agent tool, UI) listing contradictions, bridges, single-source
   concepts and link gaps.
5. Navigation between the two graphs.
6. Trustworthy token accounting for linking (today every run records 0 tokens).

## Non-goals

No change to myKG itself or its package; no new LLM provider path (LLM work goes through the existing
worker inbox and worker chats); no paid or external services; no full rebuild requirement.

## Facts this design relies on (pipeline map, 2026-10-27)

- The daemon only reads myKG's `output/{nodes,edges}.jsonl`; myKG rewrites them, its
  `name_normalization.json` and its node ids on every run. Anything the daemon changes must live in a
  daemon-side overlay re-applied at every `KnowledgeGraph.load`.
- Concept ids are `stable_id(type, name)`; concepts of different types never merge.
- Entry ↔ concept links come from each node's `source_files`.
- The relation vocabulary is per session; `contradicts` already exists (Tactic → Tactic, 95 edges, with
  a `context` attribute the daemon currently drops).
- LLM tasks are files in `intermediate/agent_inbox/<id>.task.json` leased by `InboxBroker` to worker
  chats; answers are cached by prompt + label, so a re-link of an unchanged entry needs its manifest
  keys dropped and a different prompt (or its cache entries cleared).
- `WorkerPool.finishWorker` reads usage after `port.stop` already deleted the session: tokens are 0.

## C — Concept merges (workstream W1)

- **Concept vectors.** Embed each concept as `passage` text `"<type>: <name>. <aliases>. <description>"`
  with the active embedder, in small batches, cached in `<indexDir>/concepts/` via `VectorCache`
  (own `chunker`/`input` version strings), keyed by the text hash; recompute after every graph load
  and model change, in the background, never blocking load or search.
- **Calibration.** Concept-name similarity differs from entry similarity: calibrate thresholds on the
  live graph (copy `nodes.jsonl` read-only to a temp dir) with the pinned model, documented next to
  the constants: `merge` (auto-merge bar) and `similar` (shown as similar concepts).
- **Auto-merge rule** (all must hold): same type; cosine ≥ `merge`; a lexical guard (normalized token
  sets: one contains the other, or Jaccard ≥ 0.5); every number in either name appears in the other
  ("48-hour" ≠ "72-hour"); never for type `Person` unless the names are equal after normalization.
  Merges are transitive within a type (union-find); the kept concept is the one with the most
  entries, then the shortest name, then the smallest id.
- **Overlay.** Persist merges in `<plugin dir>/concept-merges.json` (path helper in `packages/config`,
  tolerant schema, unknown fields kept): `{id, type, into, merged[], similarity, createdAt}` by
  concept id. Apply in `KnowledgeGraph.load`/snapshot build: re-point edges, union `entryIds`,
  aliases (merged names become aliases), drop self-loops and duplicate edges. Keep the edges'
  `context` attribute for `contradicts` edges (needed by C3 notes).
- **Re-apply** after every load (ids are stable, so merges survive myKG runs); a merge whose concepts
  no longer exist is dropped from the effective set but kept on disk.
- **Undo.** `DELETE knowledgeRoutes.conceptMerge(id)` removes it and records it in a `rejected`
  list so the same pair is never auto-merged again. `GET knowledgeRoutes.conceptMerges` lists them
  (visible concepts only for scoped callers). Graph revision bumps on change and publishes
  `knowledge.changed {graph:true}`.
- **Concept detail** gains `mergedFrom` and `similarConcepts` (same type, ≥ `similar`, < `merge`, up to 5).
- **Status** gains `conceptMerges` (count in effect).

## L — Linking with context, automatic re-linking, pair checks, tokens (workstream W2)

- **Token accounting first.** Read a worker's usage before stopping/deleting its session; regression test.
- **Neighbour context.** For `pass2` tasks, `InboxBroker.view` adds, after the document, a block
  `KNOWN CONCEPTS FROM SIMILAR ENTRIES` listing up to 40 existing concepts (type: name) from the
  entry's 5 nearest embedded neighbours (by entry vector), with an instruction to reuse a listed
  name when it denotes the same thing and never to extract a listed concept the document does not
  mention. Keep the task id/cache key unchanged. Overlay prompt changes only if strictly needed
  (they force a reinstall via the overlay digest); prefer the view.
- **Context version.** Each entry records the linking-context version it was linked with
  (frontmatter field or linking state; tolerant of records without it). `LINK_CONTEXT_VERSION = 1`.
- **Automatic re-linking** (the user asked for it automatic): entries linked with an older (or no)
  context version are re-linked in the background through the normal run cadence, in batches of at
  most 25 entries per update run, after new saves are served first. For each batch: drop the entries'
  keys from `file_manifest.json` and the committed copy, and clear their cached myKG answers so the
  new prompt is used. Resumable across restarts, idempotent, pauses with the existing pause reasons
  (usage limit, no account, plugin off). Status `relink: {pending, done, total}`.
- **Link gaps.** After each graph load, `findLinkGaps` (search/gaps.ts; minimum = model `strong`)
  over all entries; both entries of each new gap pair are queued for re-linking once (persist the
  pair keys handled, with the entries' content hashes, so a pair is retried only after an edit).
- **Pair checks (contradictions an LLM confirms).** Candidates: pairs of linked entries with
  similarity ≥ `good` that share ≥ 1 concept of type Tactic/Rule/Guideline/Metric/Result, or are
  joined by a `contradicts` concept edge; at most 30 new pairs per run, closest first; each pair
  checked once per content-hash pair. A pair check is a daemon-written inbox task (new step name,
  e.g. `pair-check`) with both entries' title + body (trimmed to ~2,000 chars each) asking for JSON
  `{verdict: "contradicts"|"consistent"|"unrelated", note: string}`; validated like other answers.
  Results persist in `<plugin dir>/pair-checks.json` (path helper, tolerant schema) and are exposed
  through `KnowledgePairChecksPort` (ports.ts). Runs only when workers are available; counts tokens.

## X — Cross-graph derivations and insights (workstream W3)

- **Hybrid similarity.** For each pair considered by `forEntry` and by similarity-graph edges:
  `sharedConcepts` and the distinctive ones among them (concepts linked to ≤ max(2, 3% of visible
  entries)). Similar-entry order: meaning similarity plus a small bonus per distinctive shared
  concept (cap so meaning still dominates), documented constant. The `concepts` reason lists
  distinctive ones in `distinctive`. Similarity-graph edges carry `sharedConcepts`.
- **Contradictions.** `graph`: a concept of A `contradicts` a concept of B (either direction, after
  merges), A ≠ B, both visible; note = the edge's `context`. `checked`: a `contradicts` pair check.
  Shown as a `contradicts` reason in similar entries (listed even below the meaning bar), as
  `contradicts: true` on similarity-graph edges between drawn nodes (add the edge if absent), and in
  insights.
- **Cluster concepts.** Each cluster gets `concepts` (most distinctive, tf-idf style, excluding
  Person/Organization), up to 5 — consistent with the label rule of the cluster fix.
- **Bridges.** An entry whose concepts are shared with entries in ≥ 2 other clusters (distinctive
  concepts only), ranked by the number of clusters then distinctive concepts.
- **Single-source concepts.** Concepts of type Tactic/Rule/Guideline/Result/Metric linked to exactly
  one visible entry that sits in a cluster of size ≥ 3 (claims nobody else backs).
- **Novelty.** Entry detail `novelty`: concepts only this entry has (visible scope), and its cluster.
  Save result `cluster`: the cluster of the saved entry's nearest embedded neighbours (computed from
  the cached similarity graph when available, else null; never blocks the save beyond the existing wait).
- **Insights route.** `GET knowledgeRoutes.insights` (`KnowledgeInsightsQuery`) → `KnowledgeInsightsResponse`,
  scoped exactly like the similarity graph (sessionId/agent principal, collections narrowing,
  `KNOWLEDGE_UNKNOWN_COLLECTION`), cached on graph revision + index generation + pair-check changes +
  scope. Gaps come from `findLinkGaps` with `queued` from the re-linker's state (via a small port).

## A — Agent tools (workstream W4)

- New read-only `knowledge_insights` tool: `collections?`, `limit?` (≤ 20); renders each list with
  cite links, contradictions first with their notes.
- `knowledge_get`: a "Disagrees with" block (contradicts reasons, with notes) before "Similar";
  "New here" line from `novelty`; concept items show "Merged from" and "Similar concepts".
- `knowledge_save`: "joins cluster <label> (N entries)" per saved entry when `cluster` is present.
- Stay inside the knowledge family byte budget; raise it minimally with the reason if needed.
- Older daemons (fields absent) render as before.

## U — UI (workstream W5)

- **Insights view.** A third option in the Knowledge view toggle (Graph | List | Insights) with four
  sections (Contradictions, Bridges, Single source, Link gaps), counts from `totals`, each item
  opening the entry/concept in the side panel; collection chips narrow it like the other views;
  phone-friendly (the toolbar patterns from the mobile fix).
- **Entry panel.** A "Disagrees with" section above Similar (note + concept pairs), distinctive
  concept chips, a "New here" line (novelty).
- **Concept panel.** "Merged from" (with Undo per merge, confirm first) and "Similar concepts".
- **Graph cross-navigation.** Similarity layer: the legend line of a cluster shows its top concepts;
  clicking one switches to the Concepts layer focused on it. Concepts layer: a selected concept
  offers "Show its entries in Similarity", switching layers with those entries highlighted.
  Contradicting entries' edges in the similarity layer are drawn in the destructive colour.
- **Status bar.** "Re-linking 37/126" while `relink` is non-null; merges count in the plugin
  settings section.
- Validators tolerate every new field being absent (older daemon).

## Compatibility

All new response fields are optional; new routes answer 404 on older daemons and the UI hides what
needs them. Persisted files are new and tolerant. No change to entry files beyond an optional
linking-context field.

## Performance

Concept embedding: background, batched (≤ 16 strings per call), yields between batches.
Insights: ≤ 300 ms p95 at 2,000 entries cached-cold excluding gaps; gaps yield to the event loop.
Entry detail stays within its 100 ms p95 budget at 5,000 entries.

## Testing

Each workstream adds unit tests for its rules, route tests for scoping/validation, and (where a real
model matters: concept calibration, gaps) model-gated tests using `ORQUESTER_KG_MODEL_DIR`.
`pnpm check:changed` per workstream; full `pnpm check` and `pnpm test` before merging to main.

## Workstreams and file ownership

| Stream | Owns |
|---|---|
| W1 concepts | `search/graph.ts` (overlay apply), new `search/concept-vectors.ts`, `search/concept-merges.ts`, concept routes appended to `routes-data.ts`, `packages/config` path + schema for concept merges, `service.ts` wiring for merges/status `conceptMerges` |
| W2 linking | `linking/*` (service, inbox, workers, mykg-files, new `relink.ts`, `pair-checks.ts`), `store` linking-context field, `packages/config` linking state + pair-checks schema, status `relink` |
| W3 insights | `search/similarity.ts`, new `search/insights.ts`, `search/search.ts` `entryDetail` novelty only, insights route appended to `routes-data.ts`, save handler `cluster` |
| W4 tools | `mcp/tools/knowledge.ts` and its tests, `mcp/catalog/registry.test.ts` budget, `session-tools/manifest.ts`, `packages/api/src/agent-tools.ts`, presentation labels |
| W5 UI | `packages/ui/src/components/knowledge/*`, `lib/knowledge/*`, `lib/api-client.ts` knowledge section |

Shared seams (integrator): `service.ts` wiring of the pair-checks port into search (W2 provides it,
W3 consumes it through `KnowledgePairChecksPort`) and of the re-linker's queued-gap state into insights.
