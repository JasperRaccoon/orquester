# Workflow agents and triggers test cleanup

Status: completed cleanup; dispositions were recorded before implementation. Every original test is listed. This scope has no check scripts or snapshots.

## Six-part retention rationale

Each KEEP/REWRITE row uses the source, seam, callers and ownership in its file section. **B1**: the cited independent requirement/protocol/regression supplies the behavior. **B2**: the row names the caller-visible failure. **B3**: expectations are literal scenario data, API states, payloads, persisted bytes or times; none are calculated by calling the subject. **B4**: the named interface is used by production (rewrites remove internal export assertions). **B5**: tests permit changes to loops, state organization and helper names while preserving that contract. **B6**: the owner column explains why remaining tests at other layers cannot catch this distinct failure. For DELETE rows one or more of these fails; no retained case relies on deleting a baseline failure.

Isolated-unit failure inventory: selection can pick the wrong identity/model or disregard exclusions/limits; cooldowns can target the wrong quota or persist an invalid expiry; codecs can leak/corrupt secrets; baseline readers can consume another block's rows; event detection can lose/duplicate or misclassify a transition; resolver can choose the wrong workspace identity. Only cases distinguishing those failures survive.

Validation command for every row: `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/quiet-mock-timers.mjs --test src/workflows/agent/*.test.ts src/workflows/triggers/*.test.ts` from `apps/daemon`. Root agent owns repository check/test gates.

## `apps/daemon/src/workflows/agent/cooldowns.test.ts`

Independent source (B1): §5.4 shared cooldowns and persisted workflow-state schema; credible invalid provider reset timestamps and repeated unknown-reset limits.
Stable seam and non-test callers (B4/B5): CooldownStore get/list/set and buildCooldown; createWorkflowEngine and executor failover use these.
Lowest owner / stronger remaining coverage (B6): Executor uses a memory store and does not prove durable pruning; cooldown bounds are isolated here.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour | Remove private representation/implementation-derived expected text; retain the same public contract: cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour |
| REWRITE | cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does | Remove private representation/implementation-derived expected text; retain the same public contract: cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does |

## `apps/daemon/src/workflows/agent/executor.test.ts`

Independent source (B1): §5.1–5.5 agent output, prompt, unattended requests, lifecycle, account selection; held provider wake and stale catalog regressions.
Stable seam and non-test callers (B4/B5): NodeExecutor.execute via Scenario; WorkflowEngine executes this interface; DaemonApi requests are external protocol effects.
Lowest owner / stronger remaining coverage (B6): Selector and chat-client tests do not drive block lifecycle; higher engine tests cover persistence and orchestration.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message | Remove private representation/implementation-derived expected text; retain the same public contract: happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message |
| REWRITE | continue-session mode: a follow-up turn into the upstream block's session; its text only | Remove private representation/implementation-derived expected text; retain the same public contract: continue-session mode: a follow-up turn into the upstream block's session; its text only |
| REWRITE | questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed | Remove private representation/implementation-derived expected text; retain the same public contract: questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed |
| REWRITE | a plan card is implemented with the plan implementation prompt | Remove private representation/implementation-derived expected text; retain the same public contract: a plan card is implemented with the plan implementation prompt |
| DELETE | a continue block never implements a plan an earlier block left behind | Wrong-reason negative: setup executes the first block and already implements its plan, so no unimplemented old plan remains for the continuing block. Ordinary continue-session and autonomous-plan tests remain; this fixture does not prove the claimed old-plan regression. |

## `apps/daemon/src/workflows/agent/failover.test.ts`

Independent source (B1): §5.4 account failures never end a block while an eligible candidate remains; provider isolation and long-reset regressions.
Stable seam and non-test callers (B4/B5): NodeExecutor.execute and FailoverDeps/CooldownStore contracts; engine/executor callers.
Lowest owner / stronger remaining coverage (B6): Selection tests cannot prove session reuse, interruption, prompt handoff, or executing the selected account.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | limit at create (the provider never starts): switch account in the same session | Remove private representation/implementation-derived expected text; retain the same public contract: limit at create (the provider never starts): switch account in the same session |
| REWRITE | limit at turn start: switch account | Remove private representation/implementation-derived expected text; retain the same public contract: limit at turn start: switch account |
| REWRITE | limit mid-turn: the partial work stays in the session and the new account continues it | Remove private representation/implementation-derived expected text; retain the same public contract: limit mid-turn: the partial work stays in the session and the new account continues it |
| REWRITE | limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched | Remove private representation/implementation-derived expected text; retain the same public contract: limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched |
| DELETE | a legacy limit row (no reason field, only the adapter's prefix) still fails over | DELETE: legacy prefix normalization belongs to shared API failure classifier; ordinary failover scenario already proves normalized limit handling. |
| REWRITE | limit during background work: the whole thread is interrupted, then switched | Remove private representation/implementation-derived expected text; retain the same public contract: limit during background work: the whole thread is interrupted, then switched |
| REWRITE | a switch refused once (something still in flight) waits for idle again, then switches | Remove private representation/implementation-derived expected text; retain the same public contract: a switch refused once (something still in flight) waits for idle again, then switches |
| REWRITE | a switch the host keeps refusing hands off to a NEW session on the same agent's next account | Remove private representation/implementation-derived expected text; retain the same public contract: a switch the host keeps refusing hands off to a NEW session on the same agent's next account |
| REWRITE | cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status) | Remove private representation/implementation-derived expected text; retain the same public contract: cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status) |
| REWRITE | an auth handoff says the login failed and never passes the provider's error text as the agent's messages | Remove private representation/implementation-derived expected text; retain the same public contract: an auth handoff says the login failed and never passes the provider's error text as the agent's messages |
| DELETE | a same-family switch after a refused login says so, not 'usage limit' | DELETE: exact implementation-imported continuation copy, no distinct action/result assertion; auth failover and auth handoff cover the observable failure cause. |
| REWRITE | wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate | Remove private representation/implementation-derived expected text; retain the same public contract: wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate |

## `apps/daemon/src/workflows/agent/families.test.ts`

Independent source (B1): §5.4 cooldown quota identity.
Stable seam and non-test callers (B4/B5): cooldownSubject/cooldownKey used by selector, failover and cooldown store.
Lowest owner / stronger remaining coverage (B6): select provider-isolation and failover coolDown tests assert the actual affected quota; these key-format checks duplicate them.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| DELETE | cooldownSubject: one key per quota — accountless launches keyed by provider | DELETE: key composition mirrors representation; actual provider isolation and cooldown application remain in select/failover suites. No exclusive contract lost. |

## `apps/daemon/src/workflows/agent/helpers.test.ts`

Independent source (B1): §5.1 output, §5.4 baseline-scoped failures and handoff, §5.5 activity; credible lagging summary/window truncation bugs.
Stable seam and non-test callers (B4/B5): classify helpers consumed by watcher; clip helpers consumed by prompt/executor; retained output cap moves to NodeExecutor.execute.
Lowest owner / stronger remaining coverage (B6): Shared assistantTextForTurn owns message reduction; executor happy/continue/failover tests own create and session outcomes.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | failures are read structurally, only after the baseline, with the legacy prefix only for reason-less rows | Remove private representation/implementation-derived expected text; retain the same public contract: failures are read structurally, only after the baseline, with the legacy prefix only for reason-less rows |
| DELETE | the output is the latest settled turn's parent answer: commentary only when it is all, agents' words never, re-emitted Claude copies dropped | DELETE: direct private output reducer assertions duplicate chat-client assistantTextForTurn and executor happy/continue/wake behavior; remove finalText export after moving unique cap assertion. |
| REWRITE | the output text is capped at 2 MiB | Remove private representation/implementation-derived expected text; retain the same public contract: the output text is capped at 2 MiB |
| REWRITE | the handoff reads the parent's words since the block began in the session | Run a continued agent block that fails over through NodeExecutor.execute; assert its handoff keeps current parent work and excludes earlier-block/subagent text. This catches context contamination not covered by the ordinary initial-session handoff. Remove private reducer export. |
| DELETE | the create body: explicit account, full access, owner; the model only in the chat selection | DELETE: create body private collaborator shape duplicates executor happy-path API request assertions, which exercise the actual outgoing request. |
| DELETE | exclusions: tried accounts only while their cooldown runs; unusable ones for good | DELETE: private failover memory shape duplicates resumed cooldown and auth-unusable lifecycle coverage. |
| REWRITE | the activity line reads tool calls and assistant text, never a provider's stderr or warnings | Remove private representation/implementation-derived expected text; retain the same public contract: the activity line reads tool calls and assistant text, never a provider's stderr or warnings |

## `apps/daemon/src/workflows/agent/resume.test.ts`

Independent source (B1): AGENTS.md persist wait state before side effects, idempotent command IDs; §5.7 secrets and §5.8 restart recovery.
Stable seam and non-test callers (B4/B5): NodeExecutor.execute with serialized WaitingOn and DaemonApi; engine resumes this interface.
Lowest owner / stronger remaining coverage (B6): Host receipt tests prove dedup itself; these prove executor reuses durable IDs and avoids duplicate launches across interruption boundaries.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| KEEP | `restart at ${phase} ... (${kind}), the ack after ${lostAck} lost` — 22 explicit CASES | Each persisted phase is an externally durable resume format: selecting, creating, sending, watching, output; lost create/send acknowledgments; answering and lost answer acknowledgment; interrupting, waiting-idle, failing-over, switching and lost switch acknowledgment; subsequent sends/watches; handing-off/second create and its lost acknowledgment; waiting-reset/reselection/resend. Fails on missing result, duplicate session/message or changed replayed command ID/body. Distinct durability boundaries; no test of host dedup logic itself. |
| KEEP | `a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value` — creating/sending | A secret value in persisted WaitingOn leaks credentials; a resumed send must restore its value exactly once. Durable bytes and submitted command data provide independent oracles. |

## `apps/daemon/src/workflows/agent/secret-text.test.ts`

Independent source (B1): AGENTS.md secrets remain host-only; §5.7 plus persisted prompt-marker compatibility and overlapping-secret regression.
Stable seam and non-test callers (B4/B5): protectSecrets/revealSecrets consumed by executor persistence and outgoing request handling.
Lowest owner / stronger remaining coverage (B6): Executor restart tests cover use of codec; these own overlapping values, marker migration and missing-secret behavior.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text | Remove private representation/implementation-derived expected text; retain the same public contract: protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text |

## `apps/daemon/src/workflows/agent/select.test.ts`

Independent source (B1): §5.2 owner account-selection examples and public AccountSelectionDecision contract.
Stable seam and non-test callers (B4/B5): selectAccount consumed by account preview and failover; burntWindowResetAt consumed by cooldown logic.
Lowest owner / stronger remaining coverage (B6): Executor does not exhaust usage policy combinations; deleted sameFamilyAlternatives has no production caller.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | soonest-reset on the session window: unknown resets go last | Remove private representation/implementation-derived expected text; retain the same public contract: soonest-reset on the session window: unknown resets go last |
| REWRITE | least-used (max) picks jasperinuwu | Remove private representation/implementation-derived expected text; retain the same public contract: least-used (max) picks jasperinuwu |
| REWRITE | least-used ties break on the soonest weekly reset, then the label | Remove private representation/implementation-derived expected text; retain the same public contract: least-used ties break on the soonest weekly reset, then the label |
| REWRITE | unknown usage is tried after every known account — or dropped with unknownUsage: exclude | Remove private representation/implementation-derived expected text; retain the same public contract: unknown usage is tried after every known account — or dropped with unknownUsage: exclude |
| REWRITE | system: the family's system row, or its head row when it has no managed accounts | Remove private representation/implementation-derived expected text; retain the same public contract: system: the family's system row, or its head row when it has no managed accounts |
| DELETE | sameFamilyAlternatives: the next eligible account of the same chain entry, never another entry | DELETE: wrapper has no production caller; executor uses pickCandidate and selectAccount.onlyChainIndex directly. Remove wrapper entirely. |

## `apps/daemon/src/workflows/agent/validation-catalog.test.ts`

Independent source (B1): §7.2 unknown_agent/unknown_model validation; unprobed fallback models must not reject valid definitions.
Stable seam and non-test callers (B4/B5): ValidationCatalog.current/ready consumed by daemon workflow write validation.
Lowest owner / stronger remaining coverage (B6): Executor catalog checks are per-run; store validation reads this synchronous catalog and has its own unknown-provider behavior.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | a provider's models count only once it has been probed | Remove private representation/implementation-derived expected text; retain the same public contract: a provider's models count only once it has been probed |

## `apps/daemon/src/workflows/triggers/git-events.test.ts`

Independent source (B1): §6.2 configured ref globs, persisted dedup-ring size, PR transitions and legacy persisted cursors.
Stable seam and non-test callers (B4/B5): event detectors and glob matcher consumed by GitPoller; deterministic cursor-to-event protocol.
Lowest owner / stronger remaining coverage (B6): Poller tests cover ordinary transitions; these cover absent-page PRs, page-order high water, rollback/reopen and abbreviation edge cases.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

## `apps/daemon/src/workflows/triggers/git-poller.test.ts`

Independent source (B1): §6.2 git trigger payload, cadence, authentication, baseline, dedup, retry and credential redaction; ETag commit regression.
Stable seam and non-test callers (B4/B5): GitPoller start/stop/triggerState with TriggerHost fire and GitRemoteReader external protocol; runtime starts it.
Lowest owner / stronger remaining coverage (B6): Detector tests cannot prove scheduling, durable cursor+ETag writes, credentials at remote boundary, lifecycle or public fire effects.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

## `apps/daemon/src/workflows/triggers/repo-resolve.test.ts`

Independent source (B1): §6.2 project/url/temp repository and workspace credential selection; AGENTS.md project scope.
Stable seam and non-test callers (B4/B5): ResolveRepo consumed by GitPoller; workspace path parsing consumed by resolver.
Lowest owner / stronger remaining coverage (B6): Poller URL fixture cannot prove project account selection; late-origin test uniquely proves periodic resolution.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

| Disposition | Original title | Failure / reason (B2/B3) |
|---|---|---|
| REWRITE | workspaceOfProject takes exactly <workspacesDir>/<ws>/<project> | Exercise ResolveRepo with invalid project paths and a valid available git origin, so rejection cannot pass merely because the fixture has no remote. Catch wrong-depth/traversal/outside-root project-to-credential resolution; valid workspace account is covered by the existing-project case. Remove private parser export. |

## `apps/daemon/src/workflows/triggers/scheduler.test.ts`

Independent source (B1): §6.1 cron timezone/fire/grace and cursor persistence; write failures must not permanently stop future runs.
Stable seam and non-test callers (B4/B5): Scheduler start/stop/triggerState; TriggerHost fire and real WorkflowStateStore bytes; runtime consumes scheduler.
Lowest owner / stronger remaining coverage (B6): Schedule parsing tests cannot prove timed execution, recovery, lost-run/dedup ordering or definition changes.
Risk: low for deleted duplicate/representation assertions; retained data, persistence and protocol contracts continue to fail on independently observable regressions.

## Planned seam/support removal

- Remove dead `sameFamilyAlternatives` wrapper and `holdsSecret` helper after repository caller search.
- Stop exporting internal ranking helpers, output reducers and catalog conversion once callers use stable production interfaces.
- Remove now-unused imports, local fixtures and fake support only after searching all daemon callers; shared Scenario/FakeChatHost remain needed by executor and restart coverage.

Original cases: 154 expanded tests in 13 files; final disposition: 8 DELETE, 28 REWRITE, 118 KEEP; 146 retained tests in 12 files. Parameterized restart and security cases are listed separately above.

Additional pre-edit support audit: the deleted legacy failover case is the sole caller of FakeChatHost ProviderStep.legacy; remove that unused flag and branch. The workspace path parser has no production consumer outside its resolver module (only a barrel re-export), so retain path-boundary behavior through ResolveRepo instead.

Final caller search before seam edits: `AUTONOMY_NOTE`, `CONTINUE_AFTER_SWITCH`, `CONTINUE_AFTER_AUTH_SWITCH` and `handoffNotice` now have only same-module production users after removing implementation-derived copy expectations. Make them private. The `snap` helper's adapter argument was only used by deleted reducer tests; remove that unused fixture option.

## Completion and evidence

- Independent requirement reference: [automated workflows design](../superpowers/specs/2026-09-28-automated-workflows-design.md), checked against current owner and wire/config types before judging. AGENTS.md provides the durable wait, command idempotency, secrets and project-boundary requirements.
- Stronger retained owners were confirmed with their scope agents: `packages/api/src/agent-chat/failure-reason.test.ts` owns legacy prefix parsing/unknown-reason refusal; `apps/daemon/src/mcp/views.test.ts` owns parent/commentary/re-emitted assistant text reduction. Workflow tests retain distinct baseline, execution and persistence effects.
- Exact autonomy and custom-answer wording remains asserted only where the independent design specifies those literal strings (§5.1/§5.5). Expectations no longer import the subject's constants. Protocol request bodies remain legitimate assertions at DaemonApi, which is the production boundary, not private collaborator calls.
- Removed production code: unused `sameFamilyAlternatives` wrapper and `holdsSecret` helper. Removed external exports from selection's internal ranking/usage/threshold helpers and types, executor output/state parsers, cooldown timestamp calculation, hop counting, catalog conversion, repository-path parser/barrel, and prompt copy helpers/constants. Production functions and wire behavior remain unchanged.
- Removed dead support: the entire family-key test file; unused executor account/chain fixtures and imports; fake-host listener-count probe; unused legacy-provider-step option and branch; obsolete snapshot adapter fixture option. No fixture captures or snapshots became orphaned. Shared Scenario/FakeChatHost/trigger clocks remain required by retained cases.
- Focused agent + trigger suites: **146 passed, 0 failed** (initial cleanup run). Subsequent handoff/catalog/path rewrites and affected failover scenarios: **35 passed, 0 failed**. The old-plan wrong-reason deletion and private-export/unused-fixture reductions add no behavior.
- Scoped `git diff --check` passed; final production/test/support diff inspected. Daemon typecheck result is recorded below when complete; root owns final repository gates.

Daemon typecheck: `pnpm --filter @orquester/daemon typecheck` **passed (exit 0)**. Final scoped code diff: 114 additions / 266 deletions (**net −152 LOC**, report excluded). No production behavior change or baseline product failure was observed.
