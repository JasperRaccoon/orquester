# Incoming API, capacity recovery, and session manifest audit

Incoming identity: `923b3a51b594ef668483a5bd320af41187899e34`; original audit baseline `beb7516b10a3c4472399e0f6f2f2b0a187a61186`.

All three incoming packages/api test files and the five incoming/modified limit-recovery and two manifest cases affected by beb7516b..923b3a51. Exact identities use the incoming remote tree, before cleanup. Unchanged baseline declarations remain in the original area ledgers.

All 10 affected declarations survive: 6 REWRITE, 4 KEEP, no new or removed declarations. Test LOC relative to the incoming merge: +21/-18 = +3. No production behavior, exports, fixtures, dependencies, snapshots, helpers, or configuration changed in this follow-up.

The shared API merge selector owns oldest timestamp, timezone instant, deterministic ID tie, and tolerant-date behavior. The UI owner removes duplicate wrapper chronology and implementation-versus-implementation equality probes. The MCP owner keeps public request normalization and scope validation. Capacity retry protection remains at its real scheduling and daemon-command boundary.

## Validation and performance

Both selected normal regression controls passed. Both process-local production mutants were applied and failed at the intended behavioral assertion. All four original production/test SHA256s remained unchanged. Broad package/repository gates and suite performance measurements are owned by the root coordinator; this area report does not claim they completed.

These changes strengthen independent regression detection and refactor resistance. They do not reduce test executions, so no performance improvement is claimed. Capacity tests retain their deterministic fake clock and `recovery.idle()` synchronization; no real waits or network services were introduced. Incoming baseline and final suite timings are owned by the root audit coordinator.

Required focused commands, only after the shared runner slot opens:

```sh
# packages/api
TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/knowledge.test.ts src/agent-chat/failure-reason.test.ts src/agent-chat/usage-limit.test.ts
# apps/daemon
node ../../scripts/ensure-node-native.mjs
TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/agent-chat/limit-recovery.test.ts src/session-tools/manifest.test.ts
# repository gates coordinated by root
pnpm check:changed --no-cache
pnpm check
pnpm test
```

## Focused mutation validation

The main worktree was uncontended for four sequential selected-test processes. Each normal control passed; each intended mutant failed one test with no skips or unrelated failure. This is regression-detection validation, not a before/after speed claim.

| Run | Exit | Process wall time | Result |
| --- | ---: | ---: | --- |
| capacity-control | 0 | 2.962s | PASS normal control |
| capacity-mutant | 1 | 3.151s | Intended failure: `never switches accounts`, actual 1, expected 0 |
| newer-limit-control | 0 | 0.265s | PASS normal control |
| newer-limit-mutant | 1 | 0.264s | Intended failure: `limited?.activityId`, undefined versus `a4` |

The capacity mutant preserves ordinary account-limit behavior and changes only overloaded retries to enter the existing account-switch path. Simply deleting the capacity conjunct would leave `ownFree` blocking that path at the retry deadline, so it would not test the prohibited behavior. With the viable Codex alternative, the applied mutant sends one account command and reaches the explicit `never switches accounts` assertion. The nullable newer-limit mutant preserves the initial overloaded projection, then proves the new activity-ID assertion rejects an entirely missing newer notice.

Exact executed commands (each uses `TSX_DISABLE_CACHE=1`; mutant commands also set the named environment variable):

```sh
# cwd: apps/daemon
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 '--test-name-pattern=^an overload is retried shortly:' src/agent-chat/limit-recovery.test.ts
# cwd: apps/daemon
ORQUESTER_API_AUDIT_MUTATION=capacity-failover TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/incoming-api-mutation-loader.mjs --test --test-timeout=600000 '--test-name-pattern=^an overload is retried shortly:' src/agent-chat/limit-recovery.test.ts
# cwd: packages/api
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 '--test-name-pattern=^a provider.s capacity failure is reported as an overloaded notice;' src/agent-chat/usage-limit.test.ts
# cwd: packages/api
ORQUESTER_API_AUDIT_MUTATION=drop-newer-account-limit TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/incoming-api-mutation-loader.mjs --test --test-timeout=600000 '--test-name-pattern=^a provider.s capacity failure is reported as an overloaded notice;' src/agent-chat/usage-limit.test.ts
```

The process-local loader was `/tmp/orquester-test-audit/incoming-api-mutation-loader.mjs`; both logs include their exact `AUDIT MUTATION APPLIED` marker. No production or test source was written for mutation validation. SHA256s of both production owners and both test files matched before and after all four processes; exact hashes and results are in the JSON ledger.

The per-case evidence below explains all six behavioral-bar requirements. Line numbers name the incoming remote declaration, before these edits.

## 1. REWRITE — knowledgeMergeKeep: the oldest by savedAt instant; the same instant keeps the smaller id; an unreadable date counts as oldest

`packages/api/src/knowledge.test.ts:6` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Preserve both input-order permutations, timezone-instant, same-time tie, unreadable date, and empty input; compare returned IDs to literal expected IDs.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md:243-247 (A2: default oldest savedAt, smaller-ID tie, shared daemon/panel chooser); packages/api/src/knowledge.ts:225-227 public API documentation specifies unreadable-date oldest and empty input returns null by nullable public signature.
2. **Recognizable regression:** Choosing newest; comparing ISO strings instead of timestamp instants; input-order-dependent equal-time choice; dropping legacy undated entry; invalid empty result.
3. **Independent oracle:** Literal entry IDs ke_bbbbbbbbbbbb, ke_cccccccccccc, ke_aaaaaaaaaaaa, ke_zzzzzzzzzzzz, and null. Do not derive expected winner from comparisons or use object reference identity.
4. **Stable seam:** Public shared knowledgeMergeKeep(entries) API.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain. Replace identity checks so cloning the selected record passes.
6. **Unique protection:** Lowest shared chronology owner. UI panel wrapper chronology/helper-equality cases are being removed by UI owner; UI navigation/confirmation and store atomic merge tests retain their distinct contracts.

Non-test callers: apps/daemon/src/knowledge/store/store.ts:646 default survivor; packages/ui/src/components/knowledge/panel.logic.ts:144 chooser for confirmation/navigation.

Execution cost: Small pure selector, three entries maximum; no startup or IO. No measured performance claim.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 2. KEEP — an overload is the provider's failure: never an account failure, read by its own reader

`packages/api/src/agent-chat/failure-reason.test.ts:76` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Retain all existing added assertions.

1. **Independent contract:** 2034d20d feature commit: provider capacity is not an account failure for workflows; packages/api/src/agent-chat/runtime-events.ts RuntimeFailureReason wire classification; packages/api/src/agent-chat/failure-reason.ts exported AccountFailureReason and overloadOfActivity public protocol reader.
2. **Recognizable regression:** Workflow switches accounts for provider-wide outage; nonterminal overload warning becomes a terminal retry; usage_limit mistaken for capacity failure.
3. **Independent oracle:** Literal reason overloaded, literal provider message and null exclusions; no classification result calculated by production helper.
4. **Stable seam:** Exported activity-to-account/provider failure readers over persisted activity protocol.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** Retry integration starts from a prepared notice and cannot catch misclassification of persisted activity or workflow reader acceptance. Usage projection tests do not exercise warning exclusion or direct account-reader refusal.

Non-test callers: apps/daemon/src/workflows/agent outcome readers use failureReasonOfActivity; packages/api/src/agent-chat/usage-limit.ts uses overloadOfActivity to build notices.

Execution cost: Four tiny reader operations; no IO. No measured performance claim.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 3. REWRITE — a provider's capacity failure is reported as an overloaded notice; a newer usage limit wins

`packages/api/src/agent-chat/usage-limit.test.ts:144` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Preserve overloaded notice and later-user clearing; replace newer-limit optional-chain-only assertion with the literal newer activity ID plus absent-kind checks, or the full independent literal notice.

1. **Independent contract:** 2034d20d feature commit: reason overloaded is reported as overloaded usage-limit notice; packages/api/src/agent-chat/usage-limit.ts public ThreadUsageLimitNotice projection contract: current main-thread failure, latest wins and later user input clears.
2. **Recognizable regression:** Capacity row missing/wrong kind or payload; older capacity notice masks newer account limit; later user input leaves automatic retry armed.
3. **Independent oracle:** Literal overloaded notice shape; actual newer activity ID must be present, with absent kind. Existing optional-chain kind===undefined also accepts null and is insufficient.
4. **Stable seam:** Public usageLimitNoticeOf(items,turns), the host summary wire projection.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** Failure reader cannot prove full notice projection or precedence; retry integration consumes prepared notices. Existing usage-limit user-clear test protects shared scan but this fixture proves overload participates in same cancellation semantics.

Non-test callers: apps/daemon/src/agent-host/ingestion thread summary notice projection; apps/daemon/src/agent-chat/summary.ts transports notices to ChatLimitRecovery.

Execution cost: Three small projections; no IO. No measured performance claim.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 4. KEEP — the summary's usageLimit is read tolerantly

`apps/daemon/src/agent-chat/limit-recovery.test.ts:506` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Retain incoming unknown-kind rejection and overloaded-kind preservation.

1. **Independent contract:** AGENTS.md preserve daemon/agent-host handover compatibility and validate bridge payloads; packages/api/src/agent-chat/usage-limit.ts UsageLimitKind absent/account or overloaded/capacity; apps/daemon/src/agent-chat/summary.ts transport validator contract.
2. **Recognizable regression:** Unknown future notice kind triggers account cooldown/failover, or known overloaded discriminator is discarded across handover.
3. **Independent oracle:** Unknown literal solar-flare must return null; known overloaded must retain exact discriminator. Existing malformed fields and valid literal notice remain.
4. **Stable seam:** Exported summary payload sanitizer at daemon-host trust/compatibility boundary.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** API readers operate on typed activity rows, retry scenarios bypass malformed transport payloads. This validator alone protects unknown future kind fail-closed behavior.

Non-test callers: apps/daemon/src/agent-chat/summary.ts:351 summary polling before recovery.onNotice.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 5. REWRITE — an overload is retried shortly: no cooldown, no account switch, the continue message after the base wait

`apps/daemon/src/agent-chat/limit-recovery.test.ts:525` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Replace expected OVERLOAD_RETRY_BASE_MS and USAGE_LIMIT_CONTINUE_MESSAGE with independent literal30000 and Continue where you left off.; give h.accounts valid codex acc1/acc2 fixtures before report so incorrect failover has a viable target. Retain predeadline/no-side-effect and command-ID checks.

1. **Independent contract:** 2034d20d commit explicitly specifies retry after30s, no account cooldown or switch; AGENTS.md command IDs/receipts and persistence ordering; packages/api/src/agent-chat/usage-limit.ts public continue message and overloaded state contract.
2. **Recognizable regression:** Automatic capacity retry sent early/late; account incorrectly cooled or moved; usage-limit45s margin applied; state discriminator lost during persistence; retry not idempotently identified.
3. **Independent oracle:** Use literal30000ms and commandId timestamp T0+30000, literal Continue where you left off.; independent empty cooldown/no account-post observations. Supply real Codex account alternatives to make no-switch negative meaningful.
4. **Stable seam:** ChatLimitRecovery.onNotice through real ChatSessionManager persistent records to DaemonApi /account and /turn boundary with deterministic Clock.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** API tests only project notices. Other overload tests target doubling, goal command, replay/settings; this one uniquely protects first-retry boundary, cooldown isolation, no account switching and persisted discriminator.

Non-test callers: apps/daemon/src/agent-chat/service wiring of ChatLimitRecovery; summary polling invokes onNotice; GUI actions invoke retry service.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Medium fixture correction: currently refId codex has only Claude account fixtures, so no-switch assertion can pass if buggy failover finds no valid target. Setting both fixtures to codex isolates intended refusal. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 6. REWRITE — an overload met again after a retry waits twice as long, up to the cap; a quiet spell starts over

`apps/daemon/src/agent-chat/limit-recovery.test.ts:544` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Replace MAX cap and BASE reset expected constants with literal300000 and30000, preserve all six retry observations and quiet reset.

1. **Independent contract:** 2034d20d commit explicitly specifies30s doubling per repeat, max5min; apps/daemon/src/agent-chat/limit-recovery.ts public service behavior: quiet period restarts streak.
2. **Recognizable regression:** Unbounded rapid retry loop; cap not applied; failed retry does not increase wait; quiet chat remains permanently at long delay.
3. **Independent oracle:** Literal waits [30000,60000,120000,240000,300000,300000] and literal30000 after independently advanced1h quiet interval. Subject resumeAt can drive orchestration but never computes expected vector.
4. **Stable seam:** Real recovery service scheduling and emitted turn commands over injected stable Clock/DaemonApi boundaries.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** Single-shot retry/goal/settings tests cannot catch repeated streak pacing, cap and quiet reset. API declaration inventory would not exercise service timing.

Non-test callers: same production ChatLimitRecovery service as initial-retry owner.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 7. REWRITE — an overload that blocked a Codex goal is retried with /goal resume

`apps/daemon/src/agent-chat/limit-recovery.test.ts:561` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Only replace BASE timer advance with literal30000. Retain head fixture and literal /goal resume output.

1. **Independent contract:** 2034d20d feature commit: blocked Codex goal resumed by /goal resume; Codex goal commands are provider-visible chat protocol.
2. **Recognizable regression:** Sending generic continue leaves blocked goal dormant; goal state ignored when retrying.
3. **Independent oracle:** Literal /goal resume command after independently advanced30000ms, not derived from implementation command constant.
4. **Stable seam:** Real recovery reading ThreadHead goal through DaemonApi and posting /turn command.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** First retry has no goal, backoff case no goal, replay/settings no goal; provider adapter goal parsing tests cannot prove recovery picks its command.

Non-test callers: ChatLimitRecovery.resume on automatic notice retry reads actual host ThreadHead.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 8. REWRITE — an overload seen late (a daemon restart) is retried at once; with the setting off it is only recorded

`apps/daemon/src/agent-chat/limit-recovery.test.ts:569` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Replace BASE rearm expectation with literal30000; preserve late notice, disabled setting/no timer and rearm assertions.

1. **Independent contract:** 2034d20d feature: capacity retry is governed by autoResumeLimitedChats; apps/daemon/src/agent-chat/limit-recovery.ts documented passed-while-down retry-at-once and persisted replay behavior; AGENTS.md idempotent commands and durable recovery.
2. **Recognizable regression:** Restart waits another full base delay after original deadline; disabled auto-resume still posts or keeps a timer; manual rearm incorrectly adds account-limit margin.
3. **Independent oracle:** Literal current fake-clock instant for late notice, one emitted turn, disabled state/no pending timer, and literal T0+30000 for rearm.
4. **Stable seam:** Real recovery public onNotice/setAutoResume, stored tab state and emitted API commands using independent Clock.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** Old account-limit reboot test uses usage reset+margin, with different late-limit semantics. Other capacity cases all start on-time and auto-resume enabled.

Non-test callers: summary replay to recovery after daemon/host restart; GUI setAutoResume action.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 9. KEEP — knowledge gating matrix: plugin off/on × Global / profile with collections / profile without × worker / not

`apps/daemon/src/session-tools/manifest.test.ts:139` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Retain incoming knowledge_merge in expected searchable tools and absent from blind/worker/off states; no new declaration needed.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-knowledge-retrieval-phase0-1-design.md:243-247 merge Act tier advertised with search/get; Knowledge plugin agent tools and visibility spec; AGENTS.md keep runtime ownership and authorization server-side.
2. **Recognizable regression:** Merge omitted for searchable chats, exposed to a blind profile/plugin-disabled chat, or user tools leak into indexer-only worker session.
3. **Independent oracle:** Literal externally advertised tool names and visibility states from spec, using actual catalogFor(chat); not asserting a declaration against itself.
4. **Stable seam:** buildSessionToolsManifest public provider-session transport manifest with real MCP catalog.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** MCP merge executor guards access after tool invocation; this owner alone prevents incorrect advertisement across plugin/profile/worker boundaries. UI tests do not inspect provider-session manifests.

Non-test callers: apps/daemon/src/session-tools/session-tools-refresh.ts and host session manifest route.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.

## 10. KEEP — knowledge: a workflow-owned chat keeps the knowledge tools (none is Admin) and gets both lines, under the raised cap

`apps/daemon/src/session-tools/manifest.test.ts:190` at `923b3a51b594ef668483a5bd320af41187899e34`.

Completed action: Retain incoming knowledge_merge in lawful workflow-owned advertised set and semantic instruction/budget checks.

1. **Independent contract:** Knowledge retrieval spec A2: merge Act tier, no card, advertised with search/get; Unified MCP spec §5.4 workflow-owned chats exclude always-Admin tools; Per-session instruction byte-budget contract.
2. **Recognizable regression:** Workflow-owned chat accidentally loses lawful merge/read tools as if Admin, or long scoped knowledge instructions exceed bounded manifest payload.
3. **Independent oracle:** Literal public tool names, workflow/knowledge semantic markers and independently documented2304-byte instruction bound under100collection labels.
4. **Stable seam:** Actual chat catalog through buildSessionToolsManifest public host transport contract.
5. **Refactor resistance:** Only input/output values, stable command envelopes, persisted state, and observable side effects are relevant. No private collaborator shape, source text, class tree, or implementation call-count assumptions remain.
6. **Unique protection:** Previous matrix exercises worker ownership and ordinary searchable profiles; this distinct case protects nonworker workflow ownership and long combined instruction budget.

Non-test callers: host requests/refreshes per-thread manifest for workflow-owned provider sessions.

Execution cost: Not individually profiled in this read-only audit. No real sleeps: deterministic fake clock and recovery.idle() drain for recovery cases; other cases are small pure transformations.

Risk and validation: Low: preserve all behavioral assertions; only independently justify their oracle and fixture. Use the relevant package command listed above; selected control/mutation results are recorded above, and broad gates are coordinated by root.
