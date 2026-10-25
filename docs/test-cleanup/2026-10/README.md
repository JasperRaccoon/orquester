# Test-suite cleanup and performance record

Original audit base: `bff9af493890f24d07a71901ae23ff561d2ac00b`. All repository test/check sources and their production owners were assigned to 21 independent workstreams. Incoming upstream changes are audited separately before integration.

## Scope and accounting

The original audit covers **975 files, 10,936 named declarations and 184 standalone behavioral rows**. Every original declaration has exactly one disposition, an independent contract or failed bar, and a concrete failure/oracle. File/family evidence supplies the six behavioral requirements, non-test callers, duplication owner, risk and validation seam. Source reconciliation found no missing, duplicate or unmatched rows. Parameterized declarations count once; runtime execution totals differ.

| Original named declarations | Count |
| --- | ---: |
| DELETE | 289 |
| REWRITE | 394 |
| OPTIMIZE | 139 |
| CONSOLIDATE | 248 |
| KEEP | 9,866 |

CONSOLIDATE includes removed repetitions and their surviving owners. The original cleanup leaves **10,512 declarations in 956 files**, a net reduction of 424 declarations. Standalone behavioral rows are counted separately: KEEP138, DELETE41, REWRITE1, OPTIMIZE4. No minimum test-count or coverage-percentage gate was used.

Test/check source LOC is **277,297 → 270,434 (−6,863)** before incoming changes. This counts physical lines in the original inventory and two new consolidated UI owner files; it excludes fixture corpora, helpers, production, manifests and this report.

## Test-by-test dispositions

Each linked ledger records exact baseline names/lines, dispositions and specific reasons. Shared file evidence plus each row explains independent source, recognizable regression, independent oracle, stable seam, refactor resistance and unique protection. These are source review decisions, not assumptions based on passing results.

| Scope | Named baseline | Named after cleanup | Disposition ledger |
| --- | ---: | ---: | --- |
| root | 125 | 112 | [root](root.md) |
| accounts | 329 | 323 | [accounts](accounts.md) |
| chat service | 632 | 607 | [chat_service](chat_service.md) |
| daemon core | 703 | 690 | [daemon_core](daemon_core.md) |
| opencode | 331 | 323 | [opencode](opencode.md) |
| claude | 494 | 479 | [claude](claude.md) |
| codex | 334 | 315 | [codex](codex.md) |
| grok | 414 | 397 | [grok](grok.md) |
| host storage | 603 | 594 | [host_storage](host_storage.md) |
| host runtime | 743 | 731 | [host_runtime](host_runtime.md) |
| agent profile | 341 | 336 | [agent_profile](agent_profile.md) |
| boxes | 729 | 704 | [boxes](boxes.md) |
| knowledge profiles | 458 | 442 | [knowledge_profiles](knowledge_profiles.md) |
| mcp | 762 | 724 | [mcp](mcp.md) |
| workflows | 382 | 373 | [workflows](workflows.md) |
| api config | 846 | 818 | [api_config](api_config.md) |
| ui chat components | 607 | 536 | [ui_chat_components](ui_chat_components.md) |
| ui components | 547 | 486 | [ui_components](ui_components.md) |
| ui workflows | 199 | 196 | [ui_workflows](ui_workflows.md) |
| ui support | 627 | 614 | [ui_support](ui_support.md) |
| ui chat state | 730 | 712 | [ui_chat_state](ui_chat_state.md) |

## Removed work and infrastructure

Removed declaration/source inventories, private collaborator/geometry/copy assertions, redundant replay workflows, unused exports and test-only controls. Surviving contracts use public wire/API, persistence, native process, UI state or semantic DOM boundaries. The ledgers identify the surviving owner for each consolidation.

Removed three universal Node20 preloads (224 LOC), the assertion-patch regression file, render-probe instrumentation, orphan helper accessors/DI controls and two unused Grok raw captures (391,356 bytes). Fixture provenance points to the original Git archive where newer capture descriptions refer to them. No snapshots existed; no dependency or lockfile change was needed because remaining consumers still use those dependencies. Scope ledgers enumerate removed seams.

The changed-file runner now preserves package timeout and concurrency flags; its previous parser silently lost them when timeout preceded concurrency. Native Node24 assertion/source-location and virtual-timer probes passed before removing the old preloads.

## Measurements and validation

Environment: Linux, Node24.22.1, pnpm10.12.1, package-serial orchestration, four test-file workers where package scripts configure the cap, TSX_DISABLE_CACHE=1. Desktop/web retain their existing runner allocation. Frozen original worktree and final checkout use the same installed dependency versions. The host also runs services and unrelated work; full-run deltas are descriptive, with no exclusive-host or measured CI claim.

Completed original baseline: `/usr/bin/time -v pnpm test`, **2,426.37s (40:26.37)**, **11,208 tests, 11,205 pass, zero fail, three skipped**. User CPU7,125.96s; system CPU1,333.18s; GNU-time maximum RSS1,015,652KiB (not summed tree memory). One earlier interrupted run is excluded from comparisons.

The three skipped cases require the pinned-runtime live install or ONNX model fixture. Opt-in Claude/Grok/OpenCode live suites also remain opt-in. No new skip, retry, timeout increase or gate removal was introduced. Successful spec logs provide case/container times and runner/package totals, not full per-file setup/teardown timings; nested durations are not summed as suite time.

Initial slowest individual cases were the Grok unanswered handshake30.076s, desktop preconnect-WebSocket teardown30.056s, and UI reload/in-flight send18.724s. Their contracts remain, using deterministic deadline control, correct teardown and reusable compilation with fresh module instances. Expensive real child/process-tree, filesystem compatibility, binary-build and critical lifecycle scenarios remain where cheaper seams cannot prove the same behavior.

`pnpm check:changed --no-cache` passed: typecheck; box-agent1, daemon223, desktop5, web1, API12, config5 and UI101 test files; three selected root files. The first gate exposed three rewritten-fixture faults (array mocking, no-op ingestion, incidental approval-card order); all were corrected and their focused cases revalidated. Initial compile errors were also corrected before the passing gate. The final menu simplification separately passed all10 menu/notification tests.

`TSX_DISABLE_CACHE=1 pnpm build` passed in207.30s, including both frontend bundles and the Linux AppImage; `node scripts/ensure-node-native.mjs` passed afterward. Build warnings include existing CJS import.meta and optional-platform packaging notices; build success does not assert native GUI behavior on every OS.

`node /tmp/orquester-test-audit/smoke-emitted-web.mjs <checkout> <artifact-dir>` passed clean storage and the historical legacy-usage preference record against actual emitted web assets, using only an isolated synthetic API/WebSocket surface. Screenshots, results.json, asset hashes and stopped-server evidence are in `/tmp/orquester-test-audit/emitted-web-smoke/`. No live daemon was started or restarted.

| Focused cohort, three paired runs | Baseline median wall | Final median wall | Measured decrease |
| --- | ---: | ---: | ---: |
| Grok unanswered handshake process | 33.776s | 2.668s | 92.10% |
| OpenCode CLI inventory file | 5.882s | 0.164s | 97.21% |
| Four storage hot-path contracts | 18.312s | 0.668s | 96.35% |
| Six fresh UI pages per process | 22.780s | 9.070s | 60.18% |
| Consolidated app routing/log owners | 7.088s | 2.367s | 66.60% |

These cohorts use native assertions and matched runner flags on both versions. Ranges, CPU/RSS where measured, cache conditions and substantial host variance are in the owning ledgers. A separate three-pair navigation preload comparison did not establish a speedup; obsolete-preload removal is justified by Node24 support and maintenance cost. Do not sum these overlapping cohort savings or extrapolate CI duration.

Mutations confirmed intended failures for stale graph loads, offline-download protection, hook-error turn completion, receipt eviction, durable HTML references, cursor byte budgets, provider child cleanup, CLI parsing/disconnect waits, fresh-page isolation/replay, terminal/TTL/backoff behavior, linear math parsing, expression output limits, theme mapping, resume markers and preload quoting. Every live source mutation was restored; isolated process/copy controls left production files unchanged.

The injected checker preload was regenerated during work, and the historical full baseline has no recorded prior checksum. A fresh frozen-source run with before/after fingerprints will provide the qualified full-suite comparison. Final full-suite and integration results will be recorded here after the remaining gates complete. Focused commands, mutation controls and paired benchmark distributions are already recorded in the owning ledgers; do not interpret focused timings as full-suite or CI savings.

## Delivery state

Cleanup implementation and original-source audit are complete. Final integrated validation, commit integration and push are still in progress; no successful delivery is claimed in this interim record.
