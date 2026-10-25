# Test-suite cleanup and performance record

Final required suite, changed-file gate, full typecheck, build, emitted-web smoke checks and intended-regression controls: **PASS**. Workstream-time pending notes in the linked ledgers are superseded by this final index.

Original audit base: `bff9af493890f24d07a71901ae23ff561d2ac00b`. All repository test/check sources and their production owners were assigned to 21 independent workstreams. Incoming upstream changes are audited separately before integration.

## Scope and accounting

The original audit covers **975 files, 10,936 named declarations and 184 standalone behavioral rows**. The table below gives final decisions for the original named inputs after applying the latest addenda. [Disposition precedence](disposition-precedence.json) maps the 16 revisited identities and avoids double-counting. Two of the 291 DELETE outcomes are obsolete policies removed upstream, rather than cleanup deletions. Every original declaration has exactly one final disposition, an independent contract or failed bar, and a concrete failure/oracle. File/family evidence supplies the six behavioral requirements, non-test callers, duplication owner, risk and validation seam. Source reconciliation found no missing, duplicate or unmatched rows. Parameterized declarations count once; runtime execution totals differ.

| Original named declarations | Count |
| --- | ---: |
| DELETE | 291 |
| REWRITE | 398 |
| OPTIMIZE | 139 |
| CONSOLIDATE | 256 |
| KEEP | 9,852 |

CONSOLIDATE includes removed repetitions and their surviving owners. The original cleanup leaves **10,512 declarations in 956 files**, a net reduction of 424 declarations. Standalone behavioral rows are counted separately: KEEP 138, DELETE 41, REWRITE 1, OPTIMIZE 4. No minimum test-count or coverage-percentage gate was used.

Test/check source LOC is **277,297 → 270,434 (−6,863)** before incoming changes. This counts physical lines in the original inventory and two new consolidated UI owner files; it excludes fixture corpora, helpers, production, manifests and this report.

## Test-by-test dispositions

Each linked ledger records exact baseline names/lines, dispositions and specific reasons. Shared file evidence plus each row explains independent source, recognizable regression, independent oracle, stable seam, refactor resistance and unique protection. These are source review decisions, not assumptions based on passing results. Latest incoming addenda take precedence for changed owners; the index records the authoritative final validation status, while scope notes preserve workstream-time evidence.

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

## Incoming integration audit

Merged `origin/main` through `9983fb4f` without conflicts or history rewriting, preserving the cleanup commit `0e61cd5d` (merges `e0e6270d` and `50c4c1f3`). Incoming production changes add supported renewal, tool-search, box-survival and large-snapshot contracts. Their test owners received separate incoming audits before final validation:

| Incoming scope | Addendum |
| --- | --- |
| Account renewal and credential compatibility | [accounts-incoming](accounts-incoming.md) |
| Token broker, credential watch, plugin direction and box survival | [incoming-boxes](incoming-boxes.md) |
| Claude settings precedence and SDK launch | [claude-incoming](claude-incoming.md) |
| Oversized initial snapshot versus live backlog | [host-runtime-incoming](host-runtime-incoming.md) |

The incoming addenda contain 46 disposition rows: KEEP 14, REWRITE 15, CONSOLIDATE 14 and DELETE 3, including 8 superseded originals and the existing reconnect consolidation owner. Their 31 distinct surviving incoming owners are KEEP 14, REWRITE 13 and CONSOLIDATE 4; these overlap the historical original rows and are not additive to that table. Static source/ledger reconciliation found no missing incoming declaration.

The first upstream merge adds 26 named declarations and 572 test lines relative to the first cleanup commit; its cleanup removes 7 declarations and 25 lines. Including the second wave and late repairs below, the integrated tree has **10,537 named declarations in 957 files, 271,226 test lines: net −399 declarations and −6,071 lines against the original baseline**. These figures are static source counts, separate from expanded runtime tests; incoming rows that modify or supersede original rows are not counted twice as new contracts.

A second upstream performance commit adds 12 static declarations and 312 test lines; its cleanup removes 6 declarations and 85 lines. Its 17 scenario/owner disposition rows are KEEP 1, REWRITE 5, CONSOLIDATE 8 and DELETE 3. The FileBrowser template expands into separately judged cases, so these rows are not summed with source declarations. The late original math and Knowledge synchronization repairs add 18 lines without new declarations. These adjustments are included once in the integrated totals above: 270,434 +572 −25 +312 −85 +18 =271,226 test lines.

| Second incoming scope | Addendum |
| --- | --- |
| Indexed history query ownership and ordering | [performance-history](performance-history-incoming.md) |
| Usage-cache invalidation and snapshot independence | [performance-usage](performance-usage-incoming.md) |
| Highlight syntax context across edits | [performance-highlight](performance-highlight-incoming.md) |
| Refreshed file metadata and preview navigation | [performance-files](performance-files-incoming.md) |

Five incoming manual benchmark/bundle diagnostics remain outside test gates, as originally introduced upstream. They have explicit invocations and measured-workload purposes; no meaningful test was moved out of required CI. Their supplied production-performance claims were not adopted as cleanup measurements.

One independently verified production bug was fixed during this audit: Claude keeps Windows local settings in the working directory, while incoming box resolution selected the repository root for all platforms. The adapter now uses the CLI's actual target OS. The existing settings owner covers conflicting root/cwd values for POSIX and Windows; the addendum links the official source. Other production cleanup removes dead helpers/exports while preserving behavior.

Independent source review found no dangling executable references to removed infrastructure and resolved 1,740 relative imports/exports across 474 changed TS/JS files. Active injection seams still needed by retained behavioral tests remain documented in their scope ledgers.

## Removed work and infrastructure

Removed declaration/source inventories, private collaborator/geometry/copy assertions, redundant replay workflows, unused exports and test-only controls. Surviving contracts use public wire/API, persistence, native process, UI state or semantic DOM boundaries. The ledgers identify the surviving owner for each consolidation.

Removed three universal Node 20 preloads (224 LOC), the assertion-patch regression file, render-probe instrumentation, orphan helper accessors/DI controls and two unused Grok raw captures (391,356 bytes). Fixture provenance points to the original Git archive where newer capture descriptions refer to them. No snapshots existed; no dependency or lockfile change was needed because remaining consumers still use those dependencies. Scope ledgers enumerate removed seams.

The changed-file runner now preserves package timeout and concurrency flags; its previous parser silently lost them when timeout preceded concurrency. Native Node 24 assertion/source-location and virtual-timer probes passed before removing the old preloads.

## Measurements and validation

Environment: Linux, Node 24.22.1, pnpm 10.12.1, package-serial orchestration, four test-file workers where package scripts configure the cap, TSX_DISABLE_CACHE=1. Desktop/web retain their existing runner allocation. Frozen original worktree and final checkout use the same installed dependency versions. The host also runs services and unrelated work, and the final tree includes intervening upstream production changes. Full-run deltas are descriptive; they cannot isolate cleanup effects or establish CI savings.

Completed original baseline: `/usr/bin/time -v pnpm test`, **2,426.37s (40:26.37)**, **11,208 tests, 11,205 pass, zero fail, three skipped**. User CPU 7,125.96s; system CPU 1,333.18s; GNU-time maximum RSS 1,015,652KiB (not summed tree memory). One earlier interrupted run is excluded from comparisons.

The three skipped cases require the pinned-runtime live install or ONNX model fixture. Opt-in Claude/Grok/OpenCode live suites also remain opt-in. No new skip, retry, timeout increase or gate removal was introduced. Successful spec logs provide case/container times and runner/package totals, not full per-file setup/teardown timings; nested durations are not summed as suite time.

Initial slowest individual cases were the Grok unanswered handshake 30.076s, desktop preconnect-WebSocket teardown 30.056s, and UI reload/in-flight send 18.724s. Their contracts remain, using deterministic deadline control, correct teardown and reusable compilation with fresh module instances. Expensive real child/process-tree, filesystem compatibility, binary-build and critical lifecycle scenarios remain where cheaper seams cannot prove the same behavior.

`pnpm check:changed --no-cache` passed: typecheck; box-agent1, daemon 223, desktop 5, web 1, API 12, config 5 and UI 101 test files; three selected root files. The first gate exposed three rewritten-fixture faults (array mocking, no-op ingestion, incidental approval-card order); all were corrected and their focused cases revalidated. Initial compile errors were also corrected before the passing gate. The final menu simplification separately passed all 10 menu/notification tests.

Before remote integration, `TSX_DISABLE_CACHE=1 pnpm build` passed in 207.30s, including both frontend bundles and the Linux AppImage; `node scripts/ensure-node-native.mjs` passed afterward. Build warnings include existing CJS import.meta and optional-platform packaging notices; build success does not assert native GUI behavior on every OS.

`node /tmp/orquester-test-audit/smoke-emitted-web.mjs <checkout> <artifact-dir>` passed clean storage and the historical legacy-usage preference record against actual emitted web assets, using only an isolated synthetic API/WebSocket surface. Screenshots, results.json, asset hashes and stopped-server evidence are in `/tmp/orquester-test-audit/emitted-web-smoke/`. No live daemon was started or restarted.

| Focused cohort, three paired runs | Baseline median wall | Final median wall | Median wall saved | Measured decrease |
| --- | ---: | ---: | ---: | ---: |
| Grok unanswered handshake process | 33.776s | 2.668s | 31.108s | 92.10% |
| OpenCode CLI inventory file | 5.882s | 0.164s | 5.718s | 97.21% |
| Four storage hot-path contracts | 18.312s | 0.668s | 17.644s | 96.35% |
| Six fresh UI pages per process | 22.780s | 9.070s | 13.710s | 60.18% |
| Consolidated app routing/log owners | 7.088s | 2.367s | 4.721s | 66.60% |

These cohorts use native assertions and matched runner flags on both versions. Ranges, CPU/RSS where measured, cache conditions and substantial host variance are in the owning ledgers. A separate three-pair navigation preload comparison did not establish a speedup; obsolete-preload removal is justified by Node 24 support and maintenance cost. Do not sum these overlapping cohort savings or extrapolate CI duration.

Mutations confirmed intended failures for stale graph loads, offline-download protection, hook-error turn completion, receipt eviction, durable HTML references, cursor byte budgets, provider child cleanup, CLI parsing/disconnect waits, fresh-page isolation/replay, terminal/TTL/backoff behavior, linear math parsing, expression output limits, theme mapping, resume markers and preload quoting. Every live source mutation was restored; isolated process/copy controls left production files unchanged.

The injected checker preload was regenerated during work, and the historical full baseline has no recorded prior checksum. A fresh frozen-source run recorded matching before/after fingerprints, but failed one existing stale-child fixture: fake-clock advancement raced real filesystem loading. A SIGTERM receipt now synchronizes that case, and its changed-file gate passed. The failed run took 2969.61s and did not execute every required package/root gate, so it is excluded from qualified full-suite comparisons. Its 11,120 reported Node tests had 11,116 pass, one fail and three skipped. Host contention varied materially (observed load averages 18–132); no causal whole-suite speedup or CI saving is inferred. The final integrated full suite subsequently passed with the same before/after preload fingerprint. The failed baseline is not used to claim a 40.33% speedup. Focused commands, mutation controls and paired benchmark distributions are already recorded in the owning ledgers; do not interpret focused timings as full-suite or CI savings.

## Final full-suite result and remaining cost

`TSX_DISABLE_CACHE=1 pnpm test` completed successfully in **1,772.02s (29:32.02)**. Node runner summaries total **10,806 cases: 10,803 pass, zero fail/cancelled, three unchanged skips**. Both Go packages passed (`go test -race ./...`; the wire package used Go's existing cache), and all 10 standalone `.check.ts` files completed through their normal package gates. Runtime expansion differs from named-declaration accounting.

| Whole-suite measurement | Successful original baseline | Final integrated tree |
| --- | ---: | ---: |
| Wall clock | 2,426.37s | 1,772.02s |
| User CPU | 7,125.96s | 5,329.78s |
| System CPU | 1,333.18s | 1,155.25s |
| GNU-time maximum RSS | 1,015,652KiB | 627,124KiB |
| Daemon runner elapsed | 1,466.171s | 1,352.506s |
| UI runner elapsed | 810.940s | 344.252s |

The observed historical wall-clock difference is **654.35s (10:54.35), 26.97% lower**. It is an unqualified descriptive difference, not a proven cleanup-only saving: the historical run lacks a preload checksum, shared-host load varied, the fingerprinted repeat baseline failed and omitted later gates, and incoming production changes also affect execution. The final fingerprint was unchanged throughout its run. No measured CI percentage is available. Focused paired cohorts above provide the controlled optimization evidence; they do not sum to a whole-suite estimate.

| Slowest final individual cases | Duration | Why the cost remains justified |
| --- | ---: | --- |
| [Screenshot size-cap fallback](../../../apps/daemon/src/html-preview/browser.test.ts), `keeps a screenshot under the size cap…` | 13.520s | Real Chromium must produce oversized PNG data and valid bounded JPEG bytes; a mocked capture cannot prove the output format, budget or aspect ratio. |
| [Representative hybrid search](../../../apps/daemon/src/knowledge/search/search.perf.test.ts), `hybrid search over 5,000 entries…` | 8.546s | Independently specified 5,000-entry/300ms p95 workload; actual index/search, 384-dimensional vectors and visibility filtering remain. Shrinking it would change the measured contract. |
| [Box Chromium failure cleanup](../../../apps/daemon/src/boxes/remote/browser/box-browsers.integration.test.ts), `a Chromium channel that fails after the launch…` | 7.624s | Real box/process/channel failure must close Chromium without crashing the daemon; a collaborator-call assertion would miss leaked native processes. |

Slowest final reported containers are `html preview browser` 46.979s, `CodexProfileAdapter` 41.874s, and `QuestionCard — the question and its options` 21.108s. They protect real rendering/byte limits, real config-protocol/persistence compatibility, and actual Markdown/focus/keyboard behavior respectively. The reload recovery container fell from the historical 224.578s to 19.920s in these two full runs. These are overlapping container times, not complete file wall times; setup/teardown attribution is unavailable in successful spec logs.

Real browser, child-process and configuration compatibility boundaries remain the principal expensive owners. Fresh UI module/store isolation remains intact; no mutable fixture state was shared across tests. No additional worker-allocation or CI improvement is claimed without a comparable experiment. Retained active dependency seams are documented in their scope ledgers rather than removed at the expense of unique workflows.

Raw logs, GNU-time records, before/after environment fingerprints and exact-path case/container rankings remain in `/tmp/orquester-test-audit/{baseline-complete,baseline-stable,final}.*` and `suite-metrics.json`. Repeated cohort ranges and mutation failure reasons are in the scope ledgers.

## Final validation commands

The integrated changed gate passed 16 daemon and 3 UI test files, including the stale-child repair. Full `pnpm check`, the integrated build, both emitted-web smoke scenarios, the real file-preview smoke, all four incoming regression-control drivers and the full required `pnpm test` passed. Commands run sequentially (the temporary file-preview harness was corrected and rerun as documented below):

```sh
pnpm check:changed --no-cache --base 0e61cd5dfed987e9bcbafe097e2582f90586ef4f
pnpm check
TSX_DISABLE_CACHE=1 pnpm build
node scripts/ensure-node-native.mjs
node /tmp/orquester-test-audit/smoke-emitted-web.mjs <checkout> /tmp/orquester-test-audit/emitted-web-smoke-integrated
node /tmp/orquester-test-audit/smoke-file-preview.mjs <checkout> /tmp/orquester-test-audit/file-preview-smoke
python3 /tmp/orquester-test-audit/highlight-incoming-mutation.py
python3 /tmp/orquester-test-audit/validate-incoming-stream.py
python3 /tmp/orquester-test-audit/incoming-claude-windows-probe.py
python3 /tmp/orquester-test-audit/validate-native-watch.py --guard-ms 10000
TSX_DISABLE_CACHE=1 pnpm test
git diff --check
```

The integrated wrapper exited nonzero only after its successful changed-file/typecheck/build/boot-smoke stages, because the first temporary preview API fixture decoded `?p=` paths incorrectly. Correcting that temporary fixture to use the shipped base64url path protocol made the browser smoke pass; no repository source or timeout changed. Four screenshots, emitted-chunk requests, `passed:true` and stopped-server evidence remain in `/tmp/orquester-test-audit/file-preview-smoke/`. Initial harness-failure evidence is archived separately.

Incoming negative controls failed on their intended assertions for stale highlighting classes, initial-snapshot budget charging, live-backlog budget exemption, lost snapshot content, Windows local-settings precedence and suppressed native credential-watch notification. Positive controls passed, all touched source bytes were restored, and the final full run used those restored bytes. The native-watch 10s guard applies only to an isolated audit copy, not repository tests. Windows precedence was exercised through the real target-OS config seam; no actual Windows CLI/GUI was run.

Additional completed gates: `TSX_DISABLE_CACHE=1 node --test scripts/check-changed.test.mjs scripts/ensure-node-native.test.mjs scripts/deploy-public-url.test.mjs deploy/lib/remote-update.test.mjs` (24/24), deployment-script Bash syntax checks, and repeated `git diff --check`. No new test skip/retry or timeout increase was introduced. Live provider/model/runtime-install cases were not enabled; build success is not native cross-platform GUI validation.

The probe drivers are temporary audit artifacts, not additional permanent test infrastructure. Their logs and exact child commands remain under `/tmp/orquester-test-audit/`. The normal required suite is `TSX_DISABLE_CACHE=1 pnpm test`, with package-defined worker limits and timeouts. No repository lint command is configured.

## Delivery state

Cleanup implementation, every original named-input disposition, both incoming audits and final integrated validation are complete on branch `main`. Original cleanup commit: `0e61cd5dfed987e9bcbafe097e2582f90586ef4f`. Upstream `9983fb4fb5f85b4b05f02bf79cae67cd969f171c` was integrated without conflicts or history rewriting via `e0e6270d` and `50c4c1f3`; the tested source is that integrated tree plus this final cleanup. The completion response records the final commit hash and verified push result, which cannot be embedded in the same commit's own contents. No implementation or validation blocker remains; opt-in live/platform checks and performance-comparison limits are disclosed above.
