# Strict test cleanup: current implementation record

This is the current cleanup starting at `32c81248`. **Scoped cleanup has been implemented and verified where recorded below; repository completion, incoming integration, final gates, commit and push are still pending.** The older [cleanup index](../README.md) and its linked reports are historical evidence, not verification of this work.

The reconciled original inventory contains **5,896 named test declarations**. A parameterized declaration counts once here even when Node executes multiple cases. Standalone check-script scenarios and the two deployment smoke scenarios are recorded separately. Raw syntax extraction also found non-test expressions; those are excluded from the named-case inventory. Counts describe coverage of the review, not a deletion target or a runtime test total.

The original scope ledgers record decisions made before edits, then implementation and focused validation. A **completed cleanup** entry means the owner applied its dispositions, removed dead support and recorded verification. A **pending** entry below means the available ledger does not yet establish that full sequence. Neither label substitutes for the final repository gates. The separate incoming report is explicitly an **audit**, with implementation and validation still required after integration.

## Disposition method

The default is DELETE. A test survives only when all six requirements hold:

1. An independent requirement, bug, public API, protocol, configuration, migration, storage or security contract specifies the exact behavior.
2. A recognizable user-visible or caller-visible failure causes the assertion to fail.
3. The expected result is independently supplied and can disagree with the implementation.
4. The test observes a public interface or stable seam.
5. A behavior-preserving refactor leaves it valid.
6. It is the lowest stable owner of that distinct contract, without duplicating stronger retained coverage.

**DELETE** means a case fails that bar and its removal leaves no unique specified behavior unprotected. **REWRITE** is exceptional: a real contract was trapped in a poor assertion, and the retained setup/action/assertion now observes that contract. **KEEP** requires the complete six-part justification; a familiar test name or historical report is insufficient. Shared file/suite rationale supplies common specification, callers, seam and ownership evidence only together with each named case's concrete failure and oracle. Original names remain in the ledgers, with rename/consolidation mappings where needed.

Owners read the test and production owner, recorded stronger coverage, non-test callers, risk and validation before editing, then inspected the resulting diff. Isolated-unit failure modes were identified before retaining their cases. Durable data, protocol and security regressions remain; private call inventories, implementation-derived expectations, unrequired copy/layout assertions, vacuous negatives and duplicates are removed or narrowed. Production behavior is not changed merely to preserve a test. A credible retained failure belongs to the product owner rather than being deleted to make a gate pass.

## Original scope records

The verification column summarizes the evidence currently recorded by each owner. Follow-up runs in a ledger cover its later edits; their counts must not be added to the scope total.

| Scope | Area and full disposition ledger | Recorded implementation / focused verification |
| --- | --- | --- |
| 1 | [API chat, workflows and persisted config](scope-1.md) | Original cleanup completed; 441 runtime cases passed; API/config typechecks passed. |
| 2 | [UI chat store, transport, providers and output](scope-2.md) | Original cleanup completed; 178 cases passed. |
| 3 | [UI chat timeline, history and presentation logic](scope-3.md) | Cleanup completed; 238 cases passed. |
| 4 | [Chat components, composer and roster](scope-4.md) | Original cleanup completed; 271 runtime cases and three render checks passed. |
| 5 | [Workflow UI, inspector and client state](scope-5.md) | Cleanup completed; 202 cases passed, with support-removal follow-ups. |
| 6 | [UI support, right rail, preferences and transport](scope-6.md) | Cleanup completed; final 291 cases covered by focused/follow-up runs, four checks passed, and UI typecheck passed. |
| 7 | [Codex adapter](scope-7.md) | Cleanup completed; 323 runtime cases passed, with final targeted follow-up. |
| 8 | [Grok adapter](scope-8.md) | Cleanup completed; changed suites and final fixture checks passed; full pre-edit scope passed. |
| 9 | [Claude adapter](scope-9.md) | Original cleanup completed; 385 cases and fixture redaction passed; incoming work pending. |
| 10 | [OpenCode adapter](scope-10.md) | Cleanup completed; 250/250 cases and daemon typecheck passed. |
| 11 | [Host orchestration, recovery and goals](scope-11.md) | Original cleanup completed; 337/337 cases and daemon typecheck passed. |
| 12 | [Host liveness, provider snapshots and session policy](scope-12.md) | Cleanup completed; 99 cases passed. |
| 13 | [Checkpoints, index and thread storage](scope-13.md) | Cleanup completed; 271 runtime cases passed, plus final output follow-up. |
| 14 | [Host runtime, ingestion, process support and auth](scope-14.md) | Cleanup completed; 348 runtime cases passed. |
| 15 | [Agent profile services and native config adapters](scope-15.md) | Cleanup completed; 254 cases passed, with final process/cache/service follow-ups. |
| 16 | [MCP tools, transcript and public views](scope-16.md) | Original cleanup completed; 406 runtime cases passed; incoming work pending. |
| 17 | [Workflow agent execution and triggers](scope-17.md) | Cleanup completed; 205 runtime cases passed, with support and UTF-8 follow-ups. |
| 18 | [Workflow engine, routes and durable storage](scope-18.md) | Cleanup completed; 165 cases passed, plus shared-harness follow-up. |
| 19 | [Accounts, authentication, providers and usage](scope-19.md) | Cleanup completed; final 165 named cases covered by focused/follow-up runs; three checks passed. |
| 20 | [Daemon core, chat service, sessions and filesystem](scope-20.md) | Cleanup completed; 217 changed-file cases and two host-client cases passed. |

[Deployment smoke and shared runner dispositions](smoke-and-runner.md) retain fresh-browser startup and legacy-localStorage startup through the emitted web client. Each must leave a screenshot and `results.json`. The assertion hooks and mock-timer loaders still have real package-runner consumers. Retained host/workflow integration scenarios also leave durable-event or persisted-run evidence where their ledgers specify it.

## Removed support and production seams

These are scope-owner removal records, not changes to the wire or storage contracts. **Internalized** means an unused export disappeared while the runtime implementation remained. Entries from a scope awaiting final verification remain provisional until root reconciliation; the detailed ledger is authoritative for exact names and final follow-ups.

| Owners | Named removals or internalizations |
| --- | --- |
| [2](scope-2.md), [3](scope-3.md) | Removed unused `AgentChatActions.revert`, `ThreadRetentionCache.isOwner`, the duplicate library `resolvePlanFollowUpSubmission` and plan-prompt re-export. Internalized `authErrorNotice`, `ProviderAuthNotice`, `foldStateFromSnapshot`, provider sanitizers, retention/disposal constants, `turnStartedAt`, timeline-position parsers and private timeline derivation helpers. The GUI's `rewindTo`, shared API prompt builder and protocol revert remain. |
| [4](scope-4.md) | Internalized single-question answer/count helpers, menu filtering/ranking helpers, attachment/refusal helpers, and draft/outbox/paste constants; removed unused composer barrel re-exports. Tests use submitted answers, menu builders and persisted literals. |
| [5](scope-5.md) | Removed `DataTabView`/`DataTabViewProps`, its test-only injected readers/actions/clock, `useNow`'s unused fixed-clock option, `workflowRunLoadError` and its write-only error map, `plainGuideText`, `strategyName`, `markupText`, static render harnesses and LogViewer's static-check fallback. Internalized workflow model/inspector/copy helpers and inlined `returnFocusToProblemsChip` at its runtime caller. Real parent-supplied run/clock/stream composition remains. |
| [6](scope-6.md) | Removed unused `mergeComposerDeliveries`; internalized profile form parsers, `kindTabKeyTarget`, app/rail preference helpers, `normalizeGithubRepo`, `sanitizeProfileItem`, `latestSettledCompactionAt`, profile-query and rewind-copy helpers. Final scoped verification and UI typecheck passed. |
| [9](scope-9.md), [10](scope-10.md), [14](scope-14.md) | Removed test-only provider helper exports, including Claude transcript/attachment/skill helpers and auth builders. OpenCode removed `recycleSettled`, `recycleWork` bookkeeping and `OpenCodeAdapterImpl`'s test type export; CLI/SSE/history/parser helpers now stay behind their real adapter/session callers. Internalized `parseLeftoverWork`, NDJSON/leftover-work bounds and provider auth mapping helpers. |
| [13](scope-13.md) | Removed checkpoint test support `gitCommonDirEntries`, its `readdir` import, unused store imports and the unused logged-revert overload. No storage production behavior changed. |
| [15](scope-15.md) | Removed `AgentProfileService.idle`, `scanSkills`' unused `source`/`includeHidden` options, `ScannedSkill.source`, Codex client's test-only running/PID getters, CLI-bound exports and Grok inspect-TTL export. Removed unused fake-binary, comment-stripping and fake-secret/support options. |
| [17](scope-17.md) | Removed `ValidationCatalog`'s unused clock/TTL/custom-wait injections, `invalidate()` and conversion wrapper; real `expire()`/`ready()` remain. Internalized UTF-8/title/plan/cooldown bounds. Removed `fakePrompts.rendered`, `FakeContext.last`, `Scenario.runWithRestart.resumedFrom` and unused trigger-log recording. |
| [16](scope-16.md), [18](scope-18.md), [20](scope-20.md) | Removed source/guide scans, randomized expected-value and private budget-allocation helpers, duplicate route/fixture setup and unused monkeypatch support. Internalized `validationKey`, `deleteWorkflowCascade`, Jira example constants and unused harness exports. Real guide readers, route handlers, runtime dependencies and MCP size limits remain. |

Four unconsumed raw capture files are removed: Claude [`14a-accept-edits-edit.ndjson`](scope-9.md#dead-fixture-support), and Grok [`12-cli-text/grok-version.txt`, `grok-models-authenticated.txt`, `grok-models-unauthenticated.txt`](scope-8.md#intended-cleanup). Repository-wide reference checks found no substantive replay consumer; generic redaction scanning alone did not justify retention. Provider READMEs retain the relevant provenance/observations, and final redaction/inspect checks are recorded by those owners. The Grok inspect JSON and captured protocols still used by behavior tests remain. Incoming Workflow captures 17–19 are not deleted by this audit.

Other removals include orphaned local fixture builders, imports and inline markup harnesses. Scope 19 explicitly restored the real `TtlCache` owner after a binary-aware caller search found live Bitbucket imports; neither its implementation nor its contract tests is removed. This illustrates why reference patterns were leads rather than verdicts.

## Incoming remote tests

[Incoming Claude Workflow audit](incoming-workflows.md) covers **76 added declarations in 15 test files** from `9871b50f`. Its initial 14 DELETE / 34 REWRITE / 28 KEEP decisions are **preliminary**, not a claim of completed changes or final totals. The relevant scope-owner incoming addenda supersede preliminary choices when they identify a stronger owner or a distinct protocol/security requirement.

The incoming work also changes existing declarations, including proxy routing and capability/schema cases. Their original scope owners review those modifications separately; the 76-case report does not claim to cover every changed remote line. Application, containment-regression resolution, final disposition reconciliation and merged validation remain pending. No incoming security finding is considered fixed merely because the report identifies it.

## Final verification and delivery — root-owned

Focused scope results above are completed evidence only for their stated revision and files. Interrupted or partial baseline runs are not successful full-baseline gates. No final aggregate deletion/LOC total is asserted before all scopes and incoming changes reconcile.

| Required result | Current status / root result to record |
| --- | --- |
| Original inventory reconciliation: all 5,896 named declarations plus standalone scenarios | **Pending final root reconciliation** against final dispositions and tree. |
| Incoming application and audit of added/changed tests | **Pending**; include final remote revision and owner disposition totals. |
| `pnpm check` | **Pending final root gate**. |
| `pnpm test`, including standalone checks | **Pending final root gate**; record per-package totals and any failures/skips. |
| Lint / coverage / test-count gate conflict | **Pending final script/gate review**; a count or coverage threshold cannot justify retaining junk. |
| `pnpm build` for shared UI/emitted assets | **Pending final root gate**. |
| Isolated emitted-web smoke | **Pending**; record both scenarios and screenshot/JSON artifact location. |
| Final production/test diff review and `git diff --check` | **Pending integrated review**; scoped reviews do not replace it. |
| Final test/support LOC and declaration accounting | **Pending**; separate cleanup changes from incoming feature changes. |
| Commit, remote merge and push | **Pending**; record commit/merge IDs and confirmed push only after completion. |

No live daemon, deployment restart or authenticated live-user workflow is required by these verification records. Any check that cannot run must be recorded with its reason rather than implied to have passed.
