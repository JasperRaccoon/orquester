# Workflow test dispositions

Scope: all 38 current workflow test files, 373 baseline test declarations (395 runtime cases after expanding 22 durable restart cases and 2 privacy phases). Final source has 36 files and 369 declarations (391 runtime cases). Test source changes: 23 additions/71 removals, net −48 LOC. One production bug was exposed by the consolidated privacy scenario and fixed in agent/secret-text.ts; no production export changed.

Dispositions of baseline declarations: {'KEEP': 362, 'CONSOLIDATE': 8, 'REWRITE': 2, 'OPTIMIZE': 1}. CONSOLIDATE includes surviving owners and relocated coverage; four declarations are eliminated. No external fixture, snapshot, dependency or configuration becomes unused. Removed local infrastructure: summary-only run-store stub, secret roundtrip fixture/imports, direct reset helper import, API-only regex context factory/imports.

Each row below combines with its file evidence to establish all six requirements: (1) independent documented/wire/config/security source; (2) specific caller-visible failure named by the row; (3) authored literal values, actions, error categories, byte limits or durable side effects rather than an expected answer calculated by the owner; (4) the named semantic seam; (5) no dependence on private calls, identifiers or markup; (6) the stated unique fixture beyond other remaining owners. Unit contracts have credible failure modes listed individually below; helper-level overlaps are consolidated. KEEP rows were rechecked against current tests and production owners; earlier ledgers supplied navigation and existing failure descriptions, not automatic dispositions.

All retained security and persistence cases remain required: secret-free durable WaitingOn state, host-only credentials, prototype-safe/tolerant stores, atomic writes, command receipt replay, first-wait time budgets and process identity. The real runtime journeys remain because only they compose routes, actual stores, daemon wiring and detached OS children. Their retained artifact helper writes verifiable run summaries when requested by the existing test-artifact environment.

Production regression found during validation: the new alias-name fixture failed both creating/sending restart cases in the root changed gate. The executor protects template, rendered prompt, pending input and command body at successive persisted stages. The original protectSecrets scanned existing marker names again, so a second secret with value API_TOKEN nested another marker inside the API_TOKEN marker; revealSecrets then posted an unrevealed outer marker. The deleted single protect→reveal roundtrip never exercised this repeat. protectSecrets now preserves existing marker spans and redacts only ordinary spans, keeping the persisted format and deleted-secret compatibility. The real restart fixture and its independent secret-free-state/exact-posted-text assertions are unchanged. Evidence: /tmp/orquester-test-audit/check-changed.log, failures at creating and sending. This is a previously present product defect exposed by stronger surviving coverage, not a test made green by weakening its contract. Focused rerun and mutation checks are pending the root runner slot.

Performance changes: two fewer Node/tsx worker startups and no repeated shell sleep forks during the required 5 s escalation grace. These are operation counts, not a measured speedup. Whole-suite baseline/final measurements are root-coordinated and reported centrally. The 5 s SIGTERM→SIGKILL grace, 50 MiB log cap, 16 MiB output cap and 32 MiB HTTP cap remain actual process/byte tests because smaller mocks cannot prove their specified limits.

Validation: no tests were run while the baseline or another workstream owned the runner. `git diff --check -- apps/daemon/src/workflows` passed after edits. Focused execution and regression mutations are pending the root runner slot. Required focused command from apps/daemon: `TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 src/workflows/agent/failover.test.ts src/workflows/agent/helpers.test.ts src/workflows/agent/resume.test.ts src/workflows/agent/validation-catalog.test.ts src/workflows/nodes/regex-worker.test.ts src/workflows/routes.test.ts src/workflows/sandbox/sandbox.test.ts`. API consolidation validation: existing packages/api rules.test.ts numeric-comparison case.

## `apps/daemon/src/workflows/agent/cooldowns.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.4. Stable seam: createCooldownStore against a real WorkflowStateStore and buildCooldown policy values. Unique owner and production consumers: executor/failover uses this policy; the Scenario cooldown fake does not exercise durable namespaced pruning.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L17 · the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write | KEEP | Provider/account cooldowns collide, expire late, or remain on disk after pruning. |
| L40 · cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour | KEEP | Provider resets or burnt-window reset are ignored, allowing launches before quota refills. |
| L51 · cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does | KEEP | Unknown resets cause repeated hourly retries instead of bounded strike escalation. |

## `apps/daemon/src/workflows/agent/executor.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.1–5.5; [Agent Profiles design](../superpowers/specs/2026-10-18-agent-profiles-design.md) §5.5. Stable seam: NodeExecutor.execute result and DaemonApi session/command protocol. Unique owner and production consumers: real executor normalizes deterministic provider responses; fake host supplies independent chat input, not expected workflow outcomes.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L13 · happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message | KEEP | Launch drops unattended policy, workflow ownership, selected account/model, or returns commentary instead of the final answer. |
| L51 · continue-session mode: a follow-up turn into the upstream block's session; its text only | KEEP | Follow-up creates another session or returns a previous block's answer after a silent turn. |
| L76 · continue-session mode without an upstream session fails as a validation error | KEEP | Missing upstream session starts unrelated work rather than failing validation. |
| L85 · a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables | KEEP | Untrusted inserted braces execute saved-prompt variables or append text renders in the wrong order. |
| L94 · pull-request text is sent framed as untrusted data; the template's own text is not | KEEP | PR content escapes its untrusted frame or executes slash/skill instructions. |
| L109 · a failed variable read fails the block naming it, and no session is created | KEEP | A failed diff read submits an incomplete prompt or creates a session. |
| L120 · a missing saved prompt fails the block | KEEP | Deleted prompt references launch an empty task. |
| L127 · questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed | KEEP | Unattended questions hang, use incorrect recommended values, or dismiss message-mode input. |
| L154 · an approval is accepted | KEEP | Approval cards prevent the unattended agent from completing. |
| L162 · a plan card is implemented with the plan implementation prompt | KEEP | Plan-only completion ends the block without implementing the proposed plan. |
| L172 · whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes | KEEP | Monitoring-only tasks hold finish-mode forever or prematurely end wait-mode. |
| L186 · a wake that becomes a turn only 20 s after the background work ended is still waited for (a held Claude wake) | KEEP | Delayed provider wake loses the actual helper result. |
| L197 · background work that ended with no wake finishes after the 90 s wake window | KEEP | Background completion without a wake never settles after its safety window. |
| L209 · a quiet window catches a wake that comes right after the turn settles | KEEP | A wake immediately after settle is missed and stale output returned. |
| L221 · maxMinutes interrupts the agent and fails the block with timeout | KEEP | Block deadline leaves its agent running or reports success. |
| L231 · the run's cancel interrupts the agent and ends the block cancelled | KEEP | Run cancellation leaves its agent working. |
| L241 · a failed turn without a limit/auth reason is an agent_error with the host's message | KEEP | Provider crash is mislabeled as quota failure or loses useful diagnostic. |
| L249 · the live fields: selection, sessionId, hops and a throttled activity line | KEEP | Run view misses current account/session/activity while the block works. |
| L261 · a host that is restarting (503 on create) is retried on the clock; one session results | KEEP | Transient host restart duplicates sessions or fails the block. |
| L269 · an account the daemon would not launch (gone from its catalogue) is passed over by the catalogue check, never sent | KEEP | Stale account selection sends an account the launch catalog refuses. |
| L285 · a stored chain naming an agent this host does not offer (a removed launcher) passes it over and runs the next entry | KEEP | Removed launcher prevents fallback to an offered agent. |
| L297 · Agent Profiles §5.5: a block's profileId rides the create as an unattended launch | KEEP | Workflow profile is lost or launched interactively. |
| L306 · Agent Profiles §5.5: a missing profile fails the run at once with a clear error — no other account or agent is tried, never Global | KEEP | Missing profile silently falls back to Global or another account. |
| L320 · Agent Profiles §5.5: a profile that failed to prepare fails the run with the preparation's reason | KEEP | Broken preparation starts a Global chat or drops the preparation diagnostic. |

## `apps/daemon/src/workflows/agent/failover.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.2–5.5. Stable seam: agent execute result, public session commands and persisted cooldown effects. Unique owner and production consumers: selection unit cases cannot prove actual session reuse, interruption, handoff, recovery or provider-specific accounting.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L50 · limit at create (the provider never starts): switch account in the same session | KEEP | Startup quota failure terminates work before trying another account. |
| L58 · limit mid-turn: the partial work stays in the session and the new account continues it | KEEP | Mid-turn quota failure loses partial session work. |
| L68 · limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched | KEEP | A parked warning is ignored until timeout or wrong reset is persisted. |
| L81 · limit during background work: the whole thread is interrupted, then switched | KEEP | Background quota failure interrupts only a completed turn, leaving child work running. |
| L96 · a switch refused once (something still in flight) waits for idle again, then switches | KEEP | Transient in-flight refusal skips a usable same-session switch. |
| L104 · a switch the host keeps refusing hands off to a NEW session on the same agent's next account | KEEP | Permanent switch refusal loops instead of making a usable replacement session. |
| L113 · cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status) | KEEP | Cross-family handoff loses task, recent work, owner, or working-tree context. |
| L136 · an auth handoff says the login failed and never passes the provider's error text as the agent's messages | KEEP | Authentication diagnostic is mislabeled or forwarded as prior assistant instructions. |
| L155 · the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB | KEEP | Handoff discards newest text or exceeds documented transcript/git bounds. |
| L168 · the handoff carries less into a small context window: what the window leaves after the prompt (newest kept) | KEEP | Small-window handoff exceeds the room available for the destination model. |
| L189 · OpenCode has no accounts: a limit goes to the next chain entry | KEEP | Accountless provider attempts unsupported account switching or poisons unrelated providers. |
| L200 · chain exhausted: fails all_burnt with every hop and skip | KEEP | Exhausted chain loses failure reason and attempted/skipped account records. |
| L212 · wait-for-reset: waits until the earliest reset, then resumes in the same session on that account | KEEP | Reset waiting either terminates work or creates a second session after quota refills. |
| L229 · wait-for-reset refuses a reset beyond maxWaitHours | CONSOLIDATE | Surviving owner receives a reset in 3 h, resumes, then receives another reset 3 h away under a total 5 h policy. It must fail all_burnt after the first wait. Design §5.4 independently bounds total waiting; literal outcome/time bounds catch granting a fresh budget on each wait. The bounded third provider answer makes a mutant fail by incorrect success rather than hanging. The existing happy reset fixture does not test budget exhaustion. Survives in: agent/failover.test.ts — wait-for-reset refuses a reset beyond maxWaitHours measured from the first wait. |
| L237 · an auth failure skips the account (1 h cooldown, unusable for the run) and fails over | KEEP | Authentication-failed account is immediately reused. |
| L251 · at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded | KEEP | A failing chain cycles past its documented hop cap. |
| L259 · the cooldown is shared: the next block skips the burnt account | KEEP | The next block immediately reuses an account already known burnt. |
| L271 · a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs | KEEP | Unknown model prevents trying a valid later chain entry. |
| L280 · wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate | KEEP | Reset waits consume working deadline/hop budget or fail to escalate repeated unknown resets. |
| L297 · coolDown keys accountless launches by provider and never reads another quota's reset | KEEP | OpenCode quota failure reads Codex's quota clock or cools all accountless providers. |

## `apps/daemon/src/workflows/agent/helpers.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.3–5.5, §5.7–5.9. Stable seam: normalized thread snapshots, executor output, rendered public session titles. Unique owner and production consumers: window eviction, lagging summary, filtered activity and transformed-secret title fixtures are absent from ordinary end-to-end scenarios.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L38 · only failures after this block's baseline count | KEEP | An old account failure causes a new block to fail over. |
| L46 · a baseline row that left the window falls back to the time cut | KEEP | Retained-window eviction hides new failures or attributes stale rows to this block. |
| L52 · the baseline takes the thread's latest turn over a lagging summary | KEEP | Lagging summary makes an already finished turn appear newly completed. |
| L60 · the output text is capped at 2 MiB | KEEP | Agent output exceeds its wire/storage cap or splits UTF-8. |
| L70 · the handoff reads the parent's words since the block began in the session | KEEP | Handoff includes prior blocks' or subagents' text instead of this block's parent work. |
| L87 · wait-for-reset honours maxWaitHours from the first wait | CONSOLIDATE | Direct helper arithmetic is superseded by the existing executor failover scenario now receiving a second reset beyond the total first-wait budget. The normal reset success case owns an allowed reset; selection failures own no eligible reset. Removing the helper test leaves its only meaningful policy regression protected through a caller boundary. Survives in: agent/failover.test.ts — wait-for-reset refuses a reset beyond maxWaitHours measured from the first wait. |
| L95 · the activity line reads tool calls and assistant text, never a provider's stderr or warnings | KEEP | Provider stderr replaces useful tool/assistant activity in the run view. |
| L105 · a chat title renders its {{…}} like the prompt, but never a secret's value | KEEP | A title fails template resolution, leaks direct secret refs, or flattens text incorrectly. |
| L131 · a chat title never shows a secret the render escaped, transformed or nested | KEEP | Escaping, filters, nested values, or keys expose transformed secret bytes in titles. |
| L172 · a chat title drops control and format characters | KEEP | ANSI/bidi/control bytes reach user-facing session titles. |

## `apps/daemon/src/workflows/agent/resume.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8. Stable seam: durable WaitingOn protocol rehydrated by a fresh executor and emitted chat command receipts. Unique owner and production consumers: each durable phase is a supported stored checkpoint; ordinary execute coverage never resumes at these crash cuts.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L95 · name | KEEP | Restart loses the pending action/output or repeats an already accepted side effect; distinct durable phases are detailed below. |
| L124 · a persisted state this version cannot read ends the block interrupted | KEEP | An unreadable future state is silently replayed or marked successful. |
| L134 · the deadline is wall-clock: a resumed block does not get its maxMinutes again | KEEP | Restart grants a fresh block deadline. |
| L151 · `a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value` | CONSOLIDATE | Surviving owner now includes another secret whose value equals API_TOKEN. Design §5.7–§5.8 requires secret-free persisted state and restored network text; the real executor is exercised through durable WaitingOn checkpoints at creating and sending. Literal secret/no-marker oracles catch privacy failures even if protect/reveal are both identity. The name-collision scenario is absent from ordinary sends and handoffs. Survives in: agent/resume.test.ts — same dynamic test (creating and sending). |
| L166 · a handoff prompt carrying the secret keeps it out of the state and sends the real value | KEEP | Cross-family restart persists the secret-bearing handoff or sends its markers. |

## `apps/daemon/src/workflows/agent/secret-text.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8. Stable seam: reversible text used in durable agent WaitingOn, with legacy marker input for removal compatibility. Unique owner and production consumers: remaining collision and deleted-secret fixtures protect serialization compatibility beyond the ordinary persisted prompt cases.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L5 · a secret whose value is another secret's name never corrupts a marker | CONSOLIDATE | The protect→reveal roundtrip can pass if both methods return their input, so it fails an independent privacy oracle. Its credible alias-name collision fixture is now part of the existing restart/prompt privacy scenario, which independently asserts absence of credential bytes in durable state and exact restored posted text. Survives in: agent/resume.test.ts — a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value. |
| L12 · a marker for a secret that no longer exists is sent as nothing; text without markers is untouched | CONSOLIDATE | Moved the unique deleted-secret persistence compatibility assertion into resume.test.ts, eliminating a worker. Its literal persisted marker must resolve to empty text, independent of protectSecrets. Generic non-marker identity assertions duplicate ordinary executor prompt sending and are removed. The semantic deleted-secret contract survives identifier refactors. Survives in: agent/resume.test.ts — a marker for a secret that no longer exists is sent as nothing. |

## `apps/daemon/src/workflows/agent/select.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.2. Stable seam: pure selection decision consumed by preview and executor. Unique owner and production consumers: factory/preview/failover are non-test callers; the documented owner fixture, thresholds and ranking policies have independent chosen-account values.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L93 · owner's example: soonest weekly reset under 85% picks jasperclaude and skips therealeduard465 | KEEP | Owner's explicitly documented account example chooses the over-threshold account. |
| L103 · soonest-reset without a threshold takes the earliest weekly reset | KEEP | Soonest-reset policy chooses a later eligible weekly reset. |
| L109 · soonest-reset on the session window: unknown resets go last | KEEP | Unknown session-reset time outranks a known usable reset. |
| L114 · least-used (max) picks jasperinuwu | KEEP | Least-used policy chooses a more heavily used account. |
| L119 · least-used ties break on the soonest weekly reset, then the label | KEEP | Equal usage becomes unstable or ignores reset/label tie breaks. |
| L134 · fixed order [therealeduard465, jasperclaude] under 85% weekly picks jasperclaude — by label or by id | KEEP | Fixed account order ignores label/id allow-list or its threshold. |
| L145 · an allow-list filters the family, and names what it cannot find | KEEP | Selection escapes the allow-list or hides a deleted account. |
| L151 · a scoped threshold applies only to the models it names | KEEP | Model-specific usage caps disable unrelated models. |
| L163 · a window at 100% is always burnt; a burnt scoped window stops only the models it covers | KEEP | Burnt session/scoped quota is ignored or disables unaffected model families. |
| L182 · expired windows are ignored: a pre-reset 100% no longer blocks | KEEP | Refilled quotas remain excluded using stale pre-reset percentages. |
| L188 · unknown usage is tried after every known account — or dropped with unknownUsage: exclude | KEEP | Unavailable/stale/missing usage prevents fallback or bypasses explicit exclusion. |
| L217 · needsReauth, cooldowns and the exclude set drop candidates | KEEP | Reauth, prior tries, or another family's cooldown are confused. |
| L240 · an expired cooldown no longer counts | KEEP | Expired cooldown leaves a usable account excluded. |
| L245 · cross-family fallback: claude (all burnt or cooling) → codex (reauth, burnt) → grok | KEEP | Earlier ineligible families block a usable later agent. |
| L280 · nothing eligible anywhere: chosen null and the earliest instant a candidate frees | KEEP | All-burnt selection waits for the wrong earliest eligible reset. |
| L299 · a threshold breach with an unknown reset contributes no earliest instant | KEEP | Unknown reset generates a fictional wake deadline. |
| L306 · opencode has no accounts: one system candidate, only its cooldown applies | KEEP | Accountless launch applies managed-account policy or ignores its own cooldown. |
| L319 · system: the family's system row, or its head row when it has no managed accounts | KEEP | Managed and system quota rows are joined to the wrong login. |
| L340 · chosen carries the entry's model options | KEEP | Selected effort/model options are dropped. |
| L345 · burntWindowResetAt: the latest reset among burnt windows | KEEP | Latest exhausted quota reset is lost while a different window remains burnt. |
| L361 · accountless cooldowns are per provider: one provider's limit never cools another's entries | KEEP | One OpenCode provider's limit disables another provider or Codex. |

## `apps/daemon/src/workflows/agent/validation-catalog.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.2, §8.1. Stable seam: catalog available to definition validation after DaemonApi responses and clock changes. Unique owner and production consumers: daemon-wiring/routes call ready/current/expire; provider-change E2E does not exercise late attachment or failed-read backoff.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L7 · nothing is known before the client is attached; ready() then reads the host's catalogue | KEEP | Pre-attachment startup fabricates a known catalog or fails to load models once attached. |
| L31 · a failed read is not retried on every request, only once the refresh window has passed | KEEP | Registry failure causes every request to retry and overload an unavailable host. |
| L52 · expire() reads again at once — even inside a failure's backoff — and keeps the last reading until then | REWRITE | Replace cached-object identity assertions with data equality. Last-known catalog data during refresh/failure is the caller contract, not object reuse. Independent source is the live validation/catalog freshness contract; literal host fixtures and request backoff detect stale/unknown data, a clone-based refactor passes, and provider-change E2E lacks failed-refresh backoff coverage. |

## `apps/daemon/src/workflows/catalog-events.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.1–7.2, §8.1. Stable seam: real daemon wiring, GET workflow rows and broadcast workflow.upserted events. Unique owner and production consumers: uniquely verifies registry-bus invalidation reaches already-open clients without a definition save.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L21 · a provider change re-judges the rows: the problem goes out, and comes back, without an edit | KEEP | Provider refresh does not remove/reinstate the published workflow model problem until the user edits. |

## `apps/daemon/src/workflows/e2e-agent.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.1, §5.3, §5.8. Stable seam: real daemon routes/stores/wiring re-opened over the same appdir. Unique owner and production consumers: only real agent-runtime handover coverage; pure Scenario resume does not exercise persisted run.json plus engine registration.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L68 · a restart while the agent works resumes the watcher and never sends the turn twice | KEEP | Real stores/wiring fail to resume an agent watcher once, or lose workflow expressions while rebuilding the runtime; surviving owner the real agent restart case also asserts this contract without repeating a separate fixture. |

## `apps/daemon/src/workflows/e2e-mcp.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §8.2–8.3; [MCP public contract](../orquester-mcp.md) §12. Stable seam: public MCP JSON-RPC tools/call through real routes and services. Unique owner and production consumers: MCP fake-route tests cannot detect translation/service incompatibility or broken published examples.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L53 · the published Jira create and edit example stays valid on the real routes | KEEP | Published authoring commands cannot create/edit a valid real workflow. |
| L72 · create_workflow and update_workflow {dryRun: true} validate on the real route and save nothing | KEEP | MCP dry-run mutates real state or validates the wrong project/patch. |
| L110 · run_workflow waits for a real run and its stored output can be read by node name | KEEP | MCP wait returns before the real run finishes or loses name-addressed persisted output. |

## `apps/daemon/src/workflows/e2e.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.4, §5.6–5.8, §6. Stable seam: real routes, filesystem artifacts, detached children and local HTTP. Unique owner and production consumers: retained critical complete journeys exercise wiring gaps between independently tested engine, process, transport and trigger owners.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L97 · a manual pipeline produces its final output and redacts secrets in public and durable artifacts | KEEP | Real route-to-sandbox-to-HTTP flow loses data or exposes a secret through durable/public artifacts. |
| L200 · the runtime stops while a shell block sleeps; a new one over the same appdir resumes it | KEEP | Real detached process dies on runtime handover or is spawned a second time. |
| L262 · nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows | KEEP | Scheduler wiring never starts runs or omits nextRunAt from public summaries. |
| L316 · the poller baselines, fires once on a push, and a failing poll shows on the rail | KEEP | Poller wiring repeats baselines, drops push payloads, or hides provider failure from public summaries. |

## `apps/daemon/src/workflows/engine-fixes.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.4, §5.6–5.8, §5.10. Stable seam: runtime engine run/resume/stop and stored/public run outcomes. Unique owner and production consumers: barriers inject credible crash/I/O races without implementing the engine result; baseline graph cases cannot expose these ordering failures.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L54 · an HTTP POST reached after stop() is not sent; the resumed run sends it exactly once | KEEP | Stopped engine submits an unrecorded POST or its successor submits it twice. |
| L83 · a runner spawned while the engine stopped is adopted from its handle, never spawned twice | KEEP | Stop between process launch and acknowledgement respawns external work. |
| L115 · a parent's secret rendered into a sub-workflow's input is redacted in the child run | KEEP | Child run stores a parent's workflow-local credential in its input. |
| L130 · a code runner stopped from outside fails the block; the run does not succeed | KEEP | Externally stopped runner is reported as a successful block. |
| L142 · a block that answers cancelled while nothing cancelled the run fails it | KEEP | Unrequested executor cancellation leaves the workflow falsely successful. |
| L151 · a missing existing project fails the run with errorKind project_missing | KEEP | Deleted project failure loses its machine-readable error kind in history. |
| L166 · a restart during the creation: the pending path is on disk, removed, and made again | KEEP | Restart leaks or reuses an incompletely created temp project. |
| L195 · a failed creation removes what it left and records nothing pending | KEEP | Failed clone leaves an orphan temp directory or pending marker. |
| L205 · a run whose saved state cannot be read is due for the sweeper | KEEP | Unreadable run state leaks its retained temp directory forever. |
| L231 · stopping during the finalize's delete leaves the project due for the sweeper | KEEP | Shutdown during cleanup loses the only scheduled deletion record. |
| L247 · a release event clones at its tag; a PR head the clone cannot resolve is retried at the PR branch | KEEP | Release clone uses the wrong commit/tag or abbreviated PR failure never falls back to its branch. |
| L300 · a run is not active until its record exists; a failed create leaves nothing active | KEEP | Disk failure leaves a phantom active run blocking later work. |
| L319 · a stored run naming a block `__proto__` is interrupted, never walked | KEEP | Persisted prototype block identifiers execute or pollute ordinary objects. |
| L348 · an invalid URL quoting a long secret is redacted before it is cut | KEEP | Invalid URL truncation leaks a prefix of a long credential. |

## `apps/daemon/src/workflows/engine-resume.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.8. Stable seam: fresh engine over persisted run state, observing attempts, child records and final results. Unique owner and production consumers: covers each external effect recovery kind and uncertain storage result; generic agent resume cannot protect graph/child/process recovery.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L69 · a Wait block's timer resumes at the same wall-clock instant | KEEP | Restart resets a persisted wait duration. |
| L93 · a retry delay resumes, then the next attempt runs | KEEP | Retry delay is lost or the attempt counter starts again. |
| L112 · a code process that ended while the daemon was down: its exit.json is read | KEEP | An offline process failure is reported as successful or loses its recorded exception. |
| L133 · a process gone without a record is interrupted — retried when the policy allows | KEEP | Missing exit record is trusted as success or bypasses retry policy. |
| L167 · a child run is re-subscribed by its parent | KEEP | Parent never resumes when its already-running child finishes. |
| L194 · an HTTP GET is re-issued; a POST fails interrupted | KEEP | Restart repeats a potentially side-effecting POST or fails to reissue a safe GET. |
| L226 · a block running without a WaitingOn: a pure block re-runs as the same attempt | KEEP | Pure block crash causes interruption or reruns succeeded upstream work. |
| L262 · the engine stopping while a block persists its wait state: the run is not failed, and resumes after the restart | KEEP | Shutdown while persisting a wait records a spurious block failure. |
| L313 · a block reached while the engine stops never starts: it stays pending and runs after the restart (not interrupted) | KEEP | Stop during graph advancement marks an unstarted block interrupted. |
| L344 · a Run workflow block whose child the stopping engine refused (ENGINE_UNAVAILABLE) is no validation failure: it runs again after the restart | KEEP | Stopping engine's refused child launch becomes permanent validation failure. |
| L401 · a Run workflow block found running without its WaitingOn adopts the child it did start (never a second one) | KEEP | Lost child acknowledgement executes a second child. |
| L430 · a Run workflow block's child is bound to its attempt: attempt 2, cut off before its launch, runs its own child — never adopts attempt 1's | KEEP | Retry adopts the preceding attempt's child; persisted parentAttempt provides an independent oracle. |
| L463 · a child recorded by an older build (no binding) is still adopted when it was queued since the attempt started | KEEP | Legacy unbound child is replayed instead of adopted; fixture selects recorded metadata rather than generated IDs. |
| L497 · whether the attempt started a child cannot be read: the block is interrupted, never re-run — even with retries left | KEEP | Uncertain child existence is treated as definite absence and duplicated. |
| L538 · a failed child lookup fails the run only after its children are linked: a sibling block's live child is cancelled with it | KEEP | Lookup failure leaves sibling child work running; fixture selects actual persisted child identities. |
| L578 · runChild cannot tell whether the attempt's child exists: the block fails interrupted, never retried, no child started | KEEP | Fresh child lookup I/O error is retried as an ordinary validation failure. |
| L600 · an older build's child listed but unreadable is no definite absence: the block is interrupted, not re-run | KEEP | Unreadable legacy child is duplicated instead of failing closed; fixture locates the recorded child independently. |
| L642 · a side-effecting block running without a WaitingOn is interrupted (no retry) | KEEP | Unrecorded side-effecting block is replayed automatically. |
| L659 · queued runs start after a restart; a run whose definition cannot be read is marked interrupted | KEEP | Queued work vanishes on restart or malformed definition blocks recovery of other runs. |
| L683 · stop() persists the last state and writes nothing after | KEEP | Old engine writes over successor state after handover. |

## `apps/daemon/src/workflows/engine.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.4, §4, §5.8–5.11, §7.6. Stable seam: WorkflowEngine run/fire/cancel/testNode/nodeOutput/history/events. Unique owner and production consumers: controlled executor returns only block result inputs; real engine owns graph routing, lifecycle, queueing, retention decisions and public state.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L23 · IF takes one branch; the other is skipped with its edges dead | KEEP | Unchosen IF branch executes or fails to propagate dead paths. |
| L49 · Switch: the first matching case wins, the fallback takes the rest, no fallback kills every edge | KEEP | Switch selects the wrong output or executes an unmatched branch. |
| L77 · independent branches run concurrently; Merge (all) waits for every live input | KEEP | Concurrent inputs serialize or all-mode merge fires before all live inputs. |
| L100 · Merge (first) runs on the first arrival and ignores the later one | KEEP | First-mode merge runs again on a late arrival. |
| L125 · a block with several live inputs and no Merge reads the merge object | KEEP | A multi-input block loses one upstream branch. |
| L139 · a failure with an error edge routes down it and the run succeeds | KEEP | Error edges lose partial output/diagnostic or route as ordinary success. |
| L167 · a failure without an error edge fails the run and cancels the running siblings | KEEP | Unhandled failure leaves sibling work running. |
| L185 · retries wait their delay on a persisted timer, then succeed | KEEP | Retry executes before its durable delay or retains stale error after success. |
| L215 · all_burnt and limit_exceeded failures are never retried | KEEP | Known unrecoverable cap/account exhaustion is retried. |
| L227 · an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such | KEEP | Usage-reset waiting appears active instead of waiting in run state. |
| L257 · retries exhausted: the last failure stands | KEEP | Final retry failure vanishes or retry count is ignored. |
| L267 · a disabled block passes its input through as success without running | KEEP | Disabled block executes or drops upstream data. |
| L277 · Stop as failure fails the run with its message and value | KEEP | Failure Stop drops configured output/message or leaves siblings running. |
| L294 · code's stop() ends the run as stopped | KEEP | Code Stop walks downstream or emits wrong final status. |
| L305 · a trigger-less workflow starts at its roots with the manual input | KEEP | Manual roots receive no input when workflow has no explicit trigger. |
| L315 · a fired trigger runs; the others are skipped | KEEP | Firing one trigger executes unrelated trigger branches. |
| L341 · a run with validation errors is refused (manual) or recorded as failed (trigger) | KEEP | Invalid manual run executes work or scheduled invalid fire vanishes from history. |
| L352 · expectedRevision: a manual run starts only on that revision, refused before any block otherwise | KEEP | Revision-pinned caller runs a newer workflow than it approved. |
| L365 · a projectOverride block runs in that project; a missing one fails the block | KEEP | Per-block project override is ignored or a deleted override runs elsewhere. |
| L383 · an executor that throws or answers nonsense fails its block as internal | KEEP | Unexpected executor failure escapes the run instead of becoming a block error. |
| L399 · a big output goes to a file with an inline preview; downstream and nodeOutput read it whole | KEEP | Spilled output leaks its host path or downstream receives only the preview. |
| L423 · an output over the hard cap fails the block with limit_exceeded | KEEP | Oversized executor output is accepted and stored. |
| L432 · a secret appearing in an output, an error or a warning is redacted everywhere | KEEP | Persisted/published output/error/warning exposes a secret. |
| L461 · the per-run update events are throttled; the final state is always published | KEEP | Burst updates lose latest activity/final state or publish finished before final update. |
| L491 · cancel mid-block aborts it and ends the run cancelled | KEEP | Cancellation remains active, repeats notification, or executes downstream. |
| L507 · a block that ignores its abort cannot hold a cancelled run forever | KEEP | Uncooperative block holds a cancelled run indefinitely. |
| L520 · the run timeout fails the run and cancels what runs | KEEP | Run deadline leaves its blocks active. |
| L539 · skip: a second fire records a skipped stub; force runs anyway | KEEP | Skip overlap omits visible skipped history or force cannot proceed. |
| L556 · queue: one pending fire waits for the active run; a further fire is skipped | KEEP | Queue policy starts too many pending runs or fails to release its one queued run. |
| L578 · parallel: up to maxConcurrent, then skipped | KEEP | Parallel overlap exceeds configured maxConcurrent. |
| L588 · the global run cap queues runs beyond it, FIFO | KEEP | Global run cap loses FIFO queued work. |
| L609 · a queued run can be cancelled before it starts | KEEP | Queued cancellation starts work or invents startedAt. |
| L621 · agent blocks and sandbox processes wait behind their global caps | KEEP | Agent/process resource limits fail to queue/release pending blocks. |
| L644 · an agent block's timer wait releases its slot; waking takes it back | KEEP | Reset wait holds an agent slot and starves later blocks. |
| L665 · usePinned: a pinned block is not executed and downstream reads its pin | KEEP | Pinned output executes the block or fails to feed downstream. |
| L678 · without usePinned, pins are ignored | KEEP | Ordinary runs silently execute stale pinned test data. |
| L686 · fromNodeId runs that block and its downstream; upstream from pins, else the latest run | KEEP | Run-from-block uses wrong upstream data or executes upstream blocks. |
| L707 · testNode executes only that block, even with no upstream data | KEEP | Single-block test executes downstream or invents input without upstream data. |
| L721 · testNode seeds only the tested block's upstream: downstream and side branches stay skipped | KEEP | Single-block test seeds unrelated/downstream outputs from a previous run. |
| L746 · retryOf reuses the succeeded blocks and re-runs the failed ones | KEEP | Retry reruns successful upstream work or loses trigger input. |
| L767 · retryOf + fromNodeId on the fired trigger re-runs everything with the same event | KEEP | Retry-from-trigger reuses stale blocks or triggers unrelated branch. |
| L795 · retryOf + a non-trigger fromNodeId runs from there on that run's upstream outputs | KEEP | Retry-from-block reads a later run's outputs. |
| L809 · retryOf does not reuse a success that sits below a block being re-run | KEEP | Retried branch incorrectly retains a formerly successful error handler. |
| L833 · created per run, deleted when the run succeeds | KEEP | Successful temporary workflow leaks its per-run checkout. |
| L844 · kept keepFailedTempDays when the run fails; Delete now removes it | KEEP | Failure retention deletes project too early or Delete now leaves it. |
| L856 · a git trigger on the project repo clones at the event's sha | KEEP | Git-triggered temp run clones a moving branch instead of event commit. |
| L877 · the child's final output is the block's output; runs are linked both ways | KEEP | Parent loses child output or persisted run linkage. |
| L891 · a child given text someone else wrote is marked untrusted, so its prompts frame it | KEEP | Untrusted child input bypasses prompt framing. |
| L907 · a failing child fails the block with child_run_failed | KEEP | Failed child is reported as successful parent block. |
| L916 · the depth limit and cycles are refused at run time | KEEP | Runtime recursion creates unbounded cycles/depth. |
| L940 · cancelling the parent cancels the child | KEEP | Parent cancel leaves its child active. |
| L953 · sub-workflow definitions are frozen when the top-level run starts: a child (and a grandchild) edited mid-run runs as it was | KEEP | Mid-run edits change the child/grandchild code being executed. |
| L992 · a sub-workflow deleted after the run started fails its block; none frozen when there are no sub-workflows | KEEP | Deleted frozen child executes silently or plain workflow stores unrelated snapshots. |
| L1008 · child runs bypass the global run cap (no deadlock) | KEEP | Sub-workflow chain deadlocks at the top-level run cap. |
| L1021 · deleting a workflow cancels its runs and stops writing them | KEEP | Late block result recreates data after workflow deletion. |
| L1037 · enabledTriggers lists enabled workflows' live trigger nodes; definition changes are forwarded | KEEP | Disabled triggers are returned to schedulers or definition changes do not propagate. |
| L1057 · recordSkipped writes a visible stub | KEEP | Missed trigger disappears instead of producing inspectable skipped history. |

## `apps/daemon/src/workflows/git-remote/clone-ref.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10; git clone/ls-remote argument and object-ID protocol. Stable seam: clone ref validation and exact git argv bytes. Unique owner and production consumers: AccountsService and workflow project cloning use these production helpers; preserving -- and full-versus-short object IDs is a real process/security boundary.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L15 · cloneRefProblem accepts branches, tags and shas | KEEP | Legitimate branch/tag/full commit ref is refused before git. |
| L21 · cloneRefProblem refuses empty, long, option-like, whitespace and control characters | KEEP | Ref becomes a git option or contains process-argument control/whitespace. |
| L39 · sha detection: only full ids skip --branch; short hex may be either | KEEP | Short hex branch is mistaken for a detached commit or SHA-256 commit treated as branch. |
| L50 · cloneArgs: a name rides --branch, a sha and no ref clone plainly, the URL follows -- | KEEP | Clone loses -- separator or applies --branch to a full commit. |
| L68 · isMissingRemoteRef recognises git's messages | KEEP | Missing-ref fallback runs on an authentication failure. |
| L74 · resolveAbbreviatedSha: one commit by prefix, null when none or ambiguous | KEEP | Ambiguous abbreviated commit resolves to arbitrary advertised object. |

## `apps/daemon/src/workflows/git-remote/ls-remote.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2; git ls-remote wire format. Stable seam: external stdout parser. Unique owner and production consumers: remote readers consume this parser; FakeRemote-based poller tests bypass textual Git serialization.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L11 · parseLsRemote reads heads, lightweight and annotated tags, and the HEAD symref | KEEP | Git heads, HEAD symref or annotated-tag commit is parsed incorrectly. |
| L31 · parseLsRemote: a peeled line before its tag, CRLF, junk and uppercase shas | KEEP | CRLF/uppercase/junk or peeled-before-tag listing yields wrong refs. |
| L44 · parseLsRemote: no HEAD line → no defaultBranch; a __proto__ branch stays an own key | KEEP | Hostile branch name mutates object prototype or absent HEAD invents default. |
| L52 · parseLsRemote: SHA-256 object ids | KEEP | SHA-256 repository heads disappear from polling. |

## `apps/daemon/src/workflows/git-remote/remote-url.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10, §6.2; credential containment rule in AGENTS.md. Stable seam: remote identity, permitted process transports and sanitized URL/error bytes. Unique owner and production consumers: cloning/providers/poller call these helpers; canonical identity and transport security require adversarial strings beyond ordinary trigger journeys.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L6 · repoKeyOf: every GitHub form of one repo has one key | KEEP | Equivalent GitHub transport/browse forms create separate repository identities. |
| L30 · repoKeyOf: Bitbucket Cloud's old and new SSH hosts are one host | KEEP | Old/new Bitbucket SSH hosts get separate cursors. |
| L43 · repoKeyOf: Bitbucket Server/DC forms reduce to host/project/repo | KEEP | DC context/browse/SSH forms identify different repositories. |
| L58 · repoKeyOf: other hosts keep their whole path (GitLab subgroups) | KEEP | GitLab subgroup information is discarded. |
| L63 · repoKeyOf: refuses what git would not be handed | KEEP | Unsafe/local/option URL is handed to git by key derivation. |
| L79 · repoDisplayName keeps the original case | KEEP | Trigger repository display loses user-visible case/path. |
| L86 · remoteUrlProblem accepts the four transports and refuses the rest | KEEP | Unsafe git transport reaches remote process invocation. |
| L102 · stripUrlCredentials drops the whole http(s) userinfo (a token may be the user) and an ssh password | KEEP | Credential userinfo persists in stored remote URL. |
| L113 · redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins | KEEP | Provider stderr exposes token-as-user/password but drops necessary SSH login. |

## `apps/daemon/src/workflows/integration.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.3, §5.6, §5.9. Stable seam: real shell children/local HTTP reached through WorkflowEngine. Unique owner and production consumers: owns actual env/process/HTTP semantics; controlled executors and fake fetch cannot prove encoding, aborting, redirect or OS exit behavior.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L41 · a shell block gets its env (secrets included), never a rendered script; exit codes map | KEEP | Real shell receives interpolated executable data, drops env/streams, or loses nonzero exit output. |
| L73 · cancelling a run kills its shell promptly | KEEP | Cancelling engine reports completion while its real process remains alive. |
| L159 · JSON responses are parsed; query and headers are rendered (secrets allowed, redacted after) | KEEP | Real HTTP request misencodes query/headers or fails to parse JSON. |
| L176 · text stays text; redirects are followed or not; statuses map | KEEP | Redirect/status configuration is ignored or failed response body is lost. |
| L192 · bodies: JSON rendered from a value, form fields, text | KEEP | JSON/form/text request bodies reach the server incorrectly or invalid JSON is sent. |
| L205 · the body cap, the timeout and a network error each fail the block with their kind | KEEP | Oversized/hung/disconnected/unsupported HTTP requests lose distinct failure kinds. |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §4, §5.6, §5.9. Stable seam: real engine Wait outputs/deadlines and real shell output/log. Unique owner and production consumers: timezone precedence and tail-versus-durable-log contracts differ from generic timer recovery and raw stream caps.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L16 · until HH:MM waits for the next such time in the block's time zone | KEEP | Wait-until ignores block timezone or resumes at wrong date. |
| L35 · the workflow's own time zone applies when the block names none | KEEP | Missing block timezone ignores workflow timezone. |
| L66 · stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk | KEEP | Shell output keeps head instead of tail, silently truncates, or discards durable full log. |

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.3, §5.9; daemon event-loop responsiveness/security. Stable seam: real matcher worker result/timeout and async rule warnings. Unique owner and production consumers: API evaluator tests use injected matcher and cannot prove worker isolation/recovery; warning case owns redaction before clip.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L14 · an ordinary pattern answers | KEEP | Worker cannot return both matching and nonmatching results with flags. |
| L19 · a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works | KEEP | Catastrophic user regex blocks daemon, survives its timeout, or poisons next request. |
| L35 · a clipped value is redacted before the clip | CONSOLIDATE | This case invokes only the shared API and never the daemon regex worker. Its unique privacy assertions (false result, no long-secret prefix, placeholder present) are folded into the existing API numeric-comparison case at the lowest owner. The two real regex worker timeout/recovery tests remain. Survives in: packages/api/src/workflows/rules.test.ts — numeric comparisons parse numbers and warn on non-numbers. |

## `apps/daemon/src/workflows/reference-index.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §8.1–8.3; [MCP public contract](../orquester-mcp.md) §12; [Agent Profiles design](../superpowers/specs/2026-10-18-agent-profiles-design.md) §5.5. Stable seam: reference answers, real service persistence and HTTP preconditions. Unique owner and production consumers: WorkflowService maintains index; session-tool authorization consumes it. Direct graph cases own cycles/transitivity; store cases own atomic synchronization; routes own wire metadata.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L64 · index: direct and transitive callers, cycles, calls each once; prompt uses with their blocks, a disabled block too | KEEP | Transitive/cyclic callers, disabled saved-prompt uses, or non-agent false positives are misreported. |
| L92 · index fails closed: before a rebuild, while the file is unreadable, and for any id an unreadable record mentions | KEEP | Unknown startup/corrupt definition is reported as safe to edit with no callers. |
| L113 · index: Agent Profile uses — agent blocks with a profileId, a disabled one too; re-targeted, deleted, and unknown when an unreadable record names it | KEEP | Profile edit/delete safety misses disabled launches, stale retargets, or unknown future references. |
| L162 · the store keeps the index through create, patch, replace, duplicate and delete; a reload rebuilds the same answers from disk | KEEP | Definition write and reference map diverge across real persistence/reload; surviving owner the real store/reload reference case also asserts this contract without repeating a separate fixture. |
| L204 · startup tolerates other builds' records: an unreadable one that names a workflow makes its callers unknown; an unreadable file makes every answer unknown | KEEP | Unreadable newer definitions permit edits/deletes on guessed caller absence. |
| L234 · race: an answer never lags a save that landed, and a write whose callers changed since the card is refused (CALLERS_CHANGED), nothing saved | KEEP | Approval based on older callers mutates workflow despite newly landed usage. |
| L268 · routes: GET the references of a workflow, a saved prompt and an Agent Profile; DELETE ?expectCallers= is the same precondition | KEEP | Wire reference metadata/precondition parsing differs from service rules. |
| L314 · a load that fails part-way never leaves a known index: every answer is unknown, and the error is rethrown | KEEP | Partial load leaves trusted reference answers despite failing startup. |
| L328 · routes without a wired projectPathFilter name no guessed workspace for an existing project (a temp project's stays) | KEEP | Unwired resolver invents a workspace from an untrusted path layout. |

## `apps/daemon/src/workflows/routes.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.1–7.3, §8.1; [MCP public contract](../orquester-mcp.md) §12. Stable seam: Fastify inject HTTP status/code/body/headers and one real chunked socket. Unique owner and production consumers: route fallback, binding, cascade, preview viewpoint and redaction cannot be inferred from lower-level parser or store tests.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L170 · without the engine: acting routes answer 503 ENGINE_UNAVAILABLE | KEEP | Acting endpoint runs without an available engine instead of stable 503. |
| L188 · without the engine: history, run detail and outputs are read from the run store | KEEP | Engine outage hides persisted history/full output or exposes host bookkeeping. |
| L226 · validate uses the daemon's saved-prompt catalog and reports malformed or missing resources | KEEP | Saved-prompt catalog is omitted from route validation. |
| L241 · the list filters by project: the existing project, plus temp workflows of its workspace | CONSOLIDATE | Surviving public owner preserves exact project filtering and default/custom notification flags on actual HTTP rows. Independent source is workflow design §5.11/§7.1; a dropped notify projection changes client notifications. Literal flags disagree with a broken summary, and the route survives helper refactors. No other retained route observes both flags. Survives in: routes.test.ts — same test. |
| L257 · block types and the schedule preview | KEEP | Schedule preview accepts invalid cron or ignores result cap. |
| L270 · secrets: names only, write-only values, scoped to an existing workflow | KEEP | Secrets endpoint leaks values or permits unknown workflow scope. |
| L295 · delete cascades: active runs cancelled through the engine, runs and secrets removed | KEEP | Delete fails to cancel/cascade only target runs/secrets or leaks global secret list for missing scope. |
| L324 · with the engine: runs, tests, cancels and summaries go through it | KEEP | Transport loses missing-workflow/node/inactive-run refusal codes. |
| L341 · log windows are redacted and report their position | KEEP | Log route leaks raw secret or reports wrong resumable byte cursor. |
| L362 · log follow streams as the file grows and redacts a secret split across writes | KEEP | Real chunked HTTP follow leaks credential fragments across writes. |
| L410 · an engine refusal keeps its status, code and problems (never a generic 500) | KEEP | Engine errors become generic 500 and lose actionable problems. |
| L429 · DELETE of a secret refuses prototype names and unknown workflows | KEEP | Secret DELETE accepts prototype-name operations or invalid scope. |
| L438 · write routes take a body past 1 MiB, and one past their limit answers LIMIT_EXCEEDED | KEEP | Default server body limit rejects supported definitions, or oversized writes lose LIMIT_EXCEEDED. |
| L449 · account-preview refuses a chain entry it cannot read (400, never 500) | KEEP | Malformed account preview raises 500. |
| L457 · the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can | KEEP | Workflow deletion loses last cleanup record when project delete unavailable. |
| L525 · expression preview: returns node-relative data, missing/error state and source metadata | KEEP | Expression route drops render/missing/parse metadata or exposes non-upstream node. |
| L555 · expression preview: secrets render as placeholders and a secret inside an output is redacted | KEEP | Secret references and transformed/nested outputs leak through expression preview. |
| L584 · expression preview: the block's point of view decides input; several inputs are keyed by name | KEEP | Preview computes input from wrong block's viewpoint. |
| L600 · expression preview: value mode keeps a number a number and says when nothing was read | KEEP | Typed value preview coerces JSON number to text or hides missing state. |
| L612 · expression preview: pinned outputs replace recorded ones; with no run they are the only data | KEEP | Pins override when disabled or upstream-only pin filtering is lost. |
| L632 · expression preview: the default run is the latest that reached the block; big outputs are read whole | KEEP | Preview chooses wrong reached run, loads a preview as full output, or fails to cap expansion. |
| L667 · expression preview: refusals use the workflow error codes | KEEP | Preview failures use wrong workflow/node/run/request code. |
| L686 · expression preview: a block name containing a secret value stays readable (only values are redacted) | KEEP | Secret redaction mutates block/project field names instead of values. |
| L722 · expression preview: a starting block of a workflow with no trigger reads the run's input (engine computeForced) | KEEP | Triggerless roots lose input or disconnected triggered nodes receive data. |
| L750 · expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped | KEEP | Expression cap fails to bound expansion/diagnostics or double-counts repeated parse errors. |
| L771 · expression preview: without a block, a queued newest run gives way to the newest with finished blocks | KEEP | Newest queued run masks usable data from a prior finished run. |

## `apps/daemon/src/workflows/run-store.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8, §5.9. Stable seam: FileRunStore over actual run directories/events and public wire conversion. Unique owner and production consumers: engine uses fake RunStore in most tests; actual file permissions, cursor semantics, write ordering and containment need this owner.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L61 · create/save: run.json is atomic and 0600, the last save wins, the index follows | KEEP | Concurrent saves land out of order, permit loose file mode, or leave active index stale. |
| L87 · init rebuilds the index from the run directories; an unreadable run.json is skipped | KEEP | Stale index cache overrides directory authority or unreadable record breaks history. |
| L119 · paging: `before` is a run id cursor, newest first; an unknown cursor is a first page | KEEP | History cursor duplicates/skips rows or fails unknown-cursor fallback. |
| L136 · sweep keeps the newest 100 and nothing older than 30 days, preserving active runs | KEEP | Retention deletes active work, retains excess/ancient runs, or late writes recreate removed data. |
| L159 · sweep keeps a run whose temporary project is still there, until the project is deleted | KEEP | Retention removes the only record of an undeleted temp project. |
| L178 · events append as NDJSON; attempt dirs and output files live under the run | KEEP | Event order changes, path escapes run containment, or whole output loses private mode. |
| L205 · deleteForWorkflow removes every run of that workflow only | KEEP | Deleting one workflow removes another's runs. |
| L218 · persistedRunToWire: frozen sub-workflow definitions cross the wire as their revisions only; a run without them has none | KEEP | Frozen child code leaks over wire instead of only its approved revision. |
| L226 · toRunSummary / persistedRunToWire: bookkeeping stripped, outputs cut to the preview | KEEP | Public run/summary leaks pending state/host path or breaks UTF-8 preview. |
| L261 · exists: a recorded run (readable or not) is true; a missing one false; another I/O error throws; deleted and invalid ids are false | KEEP | Unreadable exists is confused with absence and can duplicate side effects. |

## `apps/daemon/src/workflows/sandbox/env.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6; plugins session-preload configuration contract. Stable seam: environment sent to sandbox process. Unique owner and production consumers: sandbox spawn uses buildSandboxEnv; plugin preload composition is separate from the normal daemon-secret exclusion fixture.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L17 · no preload active: NODE_OPTIONS is the block's own, or absent | KEEP | Daemon NODE_OPTIONS leaks into a workflow or explicit block options are dropped. |
| L29 · a preload active: required alone, or appended after the block's NODE_OPTIONS | KEEP | Plugin preload is lost or overwrites block NODE_OPTIONS; literal expected --require bytes replace production-derived oracle. |

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6–5.7, §7.3. Stable seam: byte-positioned log window and async follow interface against actual files. Unique owner and production consumers: HTTP route owns transport binding while reader owns every UTF-8/secret boundary and abort/liveness interaction.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L46 · windows of any size cut at character boundaries and join to the whole text | KEEP | Byte cursor splits UTF-8 or drops/duplicates log text. |
| L57 · a secret is never split across windows | KEEP | Log windows expose a whole credential or pieces across boundaries. |
| L71 · an offset inside a secret serves its placeholder, never its tail | KEEP | Caller-chosen offset exposes credential tail. |
| L79 · holdTail keeps back a partial character and a possible secret prefix | KEEP | Live append serves an incomplete character/credential before it can be safely redacted. |
| L95 · a missing file reads as empty | KEEP | Missing attempt log raises instead of serving empty window. |
| L102 · yields as the file grows and ends once it is not live and fully read | KEEP | Streaming loses append data/redaction or never ends after writer exit. |
| L127 · an abort ends a live follow | KEEP | Aborted client remains attached to live log. |

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7. Stable seam: plain-text/deep-value sanitizer. Unique owner and production consumers: engine, titles and log serving call it; other tests do not combine prefix collision, literal regex characters, immutable inputs and value-only recursion.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L9 · text: every value ≥ 4 chars, longest first | KEEP | Short-token policy or overlapping longest-match protection corrupts redaction. |
| L17 · value: deep through arrays and objects, values only | KEEP | Nested output redaction leaks values, mutates keys, or changes caller input. |
| L36 · special regex characters in a value are literal | KEEP | Regex-like credential is interpreted as a pattern. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6, §5.8, §5.9. Stable seam: real detached sandbox process, durable result/exit/log and OS process identity. Unique owner and production consumers: createSandboxRunner has production node executors and remote sandbox callers. FakeSandbox cannot prove OS process groups, installed traps, child exit or actual JS module execution.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L77 · an async module returns its result and logs, then exits despite an open handle | KEEP | Real code-host import, top-level await, context arguments, return/log bytes and open-handle exit fail together; no fake engine case proves actual JavaScript child execution or teardown. |
| L90 · undefined returns as null | KEEP | Undefined JS result is lost instead of valid JSON null. |
| L95 · a throw is a failure with message and stack | KEEP | Code exception loses its failure/stack. |
| L103 · stop() ends the run as stopped, with its reason, even from a promise chain | KEEP | Code catches stop() and performs work after requested termination. |
| L112 · require resolves the project's own node_modules | KEEP | Project-local dependencies resolve in daemon rather than requested project. |
| L122 · a non-serializable return is an error | KEEP | Non-JSON result silently succeeds. |
| L128 · a return over maxOutputBytes is an error | KEEP | Oversized code return exceeds durable result cap. |
| L134 · a default export that is not a function is a clear error | KEEP | Invalid module export succeeds or cannot report failure. |
| L140 · a syntax error is a failure | REWRITE | Require a SyntaxError stack as well as a failed result. Previously any unrelated host failure could pass. JavaScript module syntax plus workflow design §5.6 establishes the independent bad-module diagnostic; real child-process/durable-result seam survives internal code-host refactors. A user throw exercises invocation, not import parsing. |
| L148 · sh works too, and the cwd is the request's | KEEP | Requested sh/cwd contract is ignored. |
| L154 · each stream is capped with one notice line | KEEP | Stream bytes exceed 50 MiB cap or truncation duplicates notices. |
| L165 · the environment is built, never inherited | KEEP | Daemon credentials leak or workflow identity env can be spoofed. |
| L199 · an invalid env name refuses the spawn | KEEP | Invalid env identifiers reach process spawn. |
| L207 · a missing cwd refuses the spawn | KEEP | Missing cwd silently runs in daemon/project fallback directory. |
| L217 · the runner enforces the deadline itself | KEEP | Detached runner depends on live daemon to enforce its deadline. |
| L228 · a work that ignores SIGTERM is SIGKILLed after the grace | OPTIMIZE | Replace the shell loop that forks sleep every 50 ms with exec tail -f /dev/null after installing the same ignored SIGTERM disposition and ready marker. POSIX exec preserves ignored signal disposition. Real OS SIGKILL/cancelled assertions and the specified real 5 s grace remain. No fake sandbox test can prove escalation of an actual signal-resistant process. This removes repeated process creation without weakening isolation or changing production. |
| L247 · a cancel kills the whole group, grandchildren included | KEEP | Process-group cancellation leaves grandchildren alive. |
| L274 · kill() ends a running attempt | KEEP | Explicit kill returns while work remains active. |
| L285 · a runner killed outright reads as interrupted, and its work is ended | KEEP | Killed runner leaves orphan work or invents a successful exit. |
| L302 · a restarted daemon adopts a running attempt and reads its exit | KEEP | Restarted runner cannot adopt durable process handle and exit record. |
| L323 · isAlive refuses a recycled pid (starttime mismatch) | KEEP | Recycled pid is treated as the original work and risks signaling unrelated process. |

## `apps/daemon/src/workflows/secrets.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.7. Stable seam: WorkflowSecretsService public names/scope and real private file. Unique owner and production consumers: routes consume names and engine resolves values; filesystem privacy, quarantine and scoped fallback need the real store.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L31 · values are stored 0600 (also after an existing file was looser) and never listed | KEEP | Secret values reach listing/logs or loose permissions survive rewrite. |
| L54 · a workflow's own secret shadows a global one; list shows both scopes; deleteForWorkflow removes its own | KEEP | Scoped value leaks across workflows or deletion removes global fallback. |
| L84 · names and values are validated: 400 SECRET_INVALID | KEEP | Invalid/oversized credential records are persisted. |
| L97 · a foreign-version file is moved aside, without quoting a value | KEEP | Future-version credential file is overwritten or quoted in diagnostics. |
| L111 · an unreadable path makes the store read-only (503) and preserves existing content | KEEP | Unreadable secret file is replaced by a writable empty store. |

## `apps/daemon/src/workflows/service.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §7.2, §8.1–8.2. Stable seam: WorkflowService CRUD/revision errors, actual stored files and lifecycle broadcasts. Unique owner and production consumers: routes and engine consume service; schema-only tests cannot prove durable tolerant writes, conflict refusal or atomic multi-operation patch.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L73 · create → read back; persisted atomically at 0600; a reload lists it | KEEP | Create/reload loses definition, private mode, or safe disabled default. |
| L92 · tolerant load: rejected entries and unknown keys are written back verbatim and never listed | KEEP | Save erases unknown fields/rejected/newer records. |
| L117 · a corrupt or foreign-version file is moved aside, never overwritten | KEEP | Corrupt/newer-version definitions file is overwritten. |
| L136 · an unreadable path blocks mutation with 503 WORKFLOWS_UNAVAILABLE and preserves content | KEEP | Unreadable definitions path allows destructive mutation. |
| L147 · revisions: +1 on every write, a stale revision is a 409 naming the current one | KEEP | Stale edits overwrite newer changes. |
| L168 · a bad patch op is 400 INVALID_WORKFLOW naming the op, and changes nothing | KEEP | Later failing patch commits earlier operations. |
| L189 · a definition with errors saves disabled, but can never be (or stay) enabled | KEEP | Invalid workflow is enabled or remains enabled after bad edit. |
| L217 · a schema-invalid replace is refused whole | KEEP | Schema-invalid replacement partially mutates definition. |
| L231 · limits: the workflow count and the definition size are LIMIT_EXCEEDED | KEEP | Workflow/definition bounds are bypassed. |
| L262 · duplicate: new ids for the workflow, blocks and connections; disabled; pins follow | KEEP | Duplicate retains live IDs/enabled state or loses pin-edge bindings. |
| L284 · events: upserted after every write, deleted after a delete; the bridge publishes summaries | KEEP | Definition events lose current summaries, revisions, or deletion identity. |

## `apps/daemon/src/workflows/services.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.4, §5.4, §5.10–5.11. Stable seam: ProjectOps daemon HTTP, notifier delivery, slot acquisition and sweeper public effects. Unique owner and production consumers: factory/engine use these production services; engine fakes do not own project containment, actual route requests, push policy or retention of user-used tabs.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L74 · resolveExisting accepts exactly <workspacesDir>/<ws>/<project> | KEEP | Workflow project escapes workspace/project containment or selects a subdirectory. |
| L84 · createTemp and deleteProject go through the daemon's routes | KEEP | Temporary clone bypasses daemon routes, unattended policy, or missing-project delete idempotency. |
| L106 · a refused create names the daemon's code | KEEP | Project failure drops daemon error code or silently proceeds detached. |
| L114 · gitStatusShort renders porcelain-style lines within the byte cap | KEEP | Handoff working-tree text loses staged/unstaged/rename meaning or byte bound. |
| L146 · pushes per settings.notify, debounced per workflow and kind | KEEP | Notification settings/debounce spam failures or notify children/test/cancelled runs. |
| L171 · FIFO past the cap; aborted waiters leave the queue; force skips it | KEEP | Concurrency slots lose FIFO order, hold aborted waiter, or release twice. |
| L220 · deletes temp projects past deleteAfter and closes old workflow tabs nobody wrote in | KEEP | Cleanup deletes user-used/live/new tabs or leaks due temporary projects. |
| L272 · runs hourly on the injected clock and stops cleanly | KEEP | Hourly cleanup stops scheduling or continues after stop. |

## `apps/daemon/src/workflows/state-store.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.4, §6. Stable seam: WorkflowStateStore durable cursor updates against actual files. Unique owner and production consumers: scheduler/poller/cooldowns consume this store; their in-memory fixtures cannot detect coalesced-write loss or filesystem recovery.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L26 · a missing file loads empty, silently; updates persist atomically at 0600 | KEEP | Missing state cannot boot or updates fail private durable reload. |
| L45 · a corrupt file starts empty, is moved aside and logged — never thrown | KEEP | Corrupt cursor file prevents boot or is destroyed without backup. |
| L60 · bad entries are dropped by the tolerant parse, good ones kept | KEEP | Malformed cache entry prevents valid cursor recovery. |
| L70 · an unreadable path starts empty and logs | KEEP | Unreadable cursor state prevents boot. |
| L79 · concurrent updates are immediately visible and all become durable | KEEP | Concurrent updates lose another workflow's cursor/cooldown. |
| L90 · a throwing mutator changes nothing; a failed write retains changes for the next write | KEEP | Throwing mutator partially applies or failed-write state is lost on recovery. |

## `apps/daemon/src/workflows/storage-fixes.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.7–5.8; AGENTS.md tolerant persistence and prototype containment. Stable seam: actual schemas/stores with independently authored newer/corrupt records. Unique owner and production consumers: owns nested forward compatibility, credential-map safety and real index-before-run-write crash ordering absent from ordinary reload cases.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L43 · a newer build's nested fields survive this build's parse (a save never erases them) | KEEP | Read/save under older build erases newer nested definition fields. |
| L68 · block and connection ids that could key Object.prototype are refused, by the schema and by validation | KEEP | Prototype-shaped node/edge IDs enter persisted graph maps. |
| L90 · the secrets file keeps what this build cannot read, verbatim, across a write | KEEP | Credential save destroys future metadata or rejected records. |
| L114 · the secrets store never indexes past its own maps | KEEP | Prototype map lookup mutates inherited object members. |
| L130 · an unfinished run remains recoverable when the index lands before its pending save | KEEP | Index-first write race makes unfinished run unrecoverable after restart. |

## `apps/daemon/src/workflows/summary.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.11, §7.1, §8.1. Stable seam: wire WorkflowSummary.notify consumed by open clients. Unique owner and production consumers: buildWorkflowSummary serves routes/engine/events; notifier tests protect delivery policy but cannot detect omission of public settings.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L9 · the summary carries settings.notify so open clients honour it | CONSOLIDATE | The isolated projection duplicates the route owner after both default and custom notify values are asserted in the existing list/filter request. The default-values factory and run-store stub add no unique failure. Survives in: routes.test.ts — the list filters by project: the existing project, plus temp workflows of its workspace. |

## `apps/daemon/src/workflows/triggers/git-events.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2. Stable seam: normalized provider listings/ref glob/dedup event decisions. Unique owner and production consumers: poller consumes these decisions; adversarial transitions, old state and out-of-order PR pages are absent from ordinary polling scenarios.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L7 · glob: anchored, `*` stops at `/`, `**` crosses it, `?` is one character | KEEP | Ref glob accidentally matches nested/unanchored branches or pathological pattern hangs. |
| L31 · sameSha compares an abbreviation (Bitbucket Cloud's 12 hex) as a prefix | KEEP | Abbreviated Bitbucket ID is treated as changed commit or arbitrary tiny prefix equated. |
| L39 · pushFired keeps the newest 1000 | KEEP | Dedup history drops newest event or grows beyond documented ring. |
| L64 · pull requests: an old PR scrolling into the page is recorded silently; one opened and merged between polls yields both | KEEP | Older PR scrolling into page triggers work or merged-between-polls PR loses opened transition. |
| L76 · pull requests: a lower-numbered new PR walked after a higher one still opens (the mark is the page's base) | KEEP | Listing order drops lower-numbered new PR after observing higher number. |
| L90 · pull requests: dedup keys name the transition — a force-push rollback and a second close after a reopen fire | KEEP | Force-push rollback/reopen-close transition is incorrectly deduplicated, including legacy state. |
| L114 · push: a force-push rollback (A..B then B..A) is a new dedup key, not a repeat of the first push to A | KEEP | Rollback to previous commit is lost against a pre-upgrade dedup key. |

## `apps/daemon/src/workflows/triggers/git-poller.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2. Stable seam: clock-driven remote request boundary, persisted cursors and emitted trigger payloads. Unique owner and production consumers: daemon-wiring calls poller; remote fake emits independent provider state but real poller owns dedup, cadence, ETags, backoff, filtering and lifecycle.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L77 · push: the first poll only baselines; a later push fires once with previousSha..sha | KEEP | First poll triggers old work or unchanged head repeatedly fires. |
| L118 · push: branch globs; a new matching branch fires with no previousSha; deleted branches are ignored | KEEP | Branch matching misses new branch or fires on unrelated/deleted refs. |
| L142 · push: branches [] watches the default branch, read only when unknown and every 10th poll | KEEP | Default branch change keeps polling old branch or causes baseline burst. |
| L163 · tag: one run per new matching tag (version order), at most 10 per poll, the rest skipped; moved tags ignored | KEEP | Tag polling repeats/misorders/overfires past per-poll cap or re-fires moved tag. |
| L192 · release: drafts never, pre-releases only when asked for | KEEP | Draft/prerelease policy or promotion dedup is ignored. |
| L237 · release on a provider without releases shows an error and fires nothing | KEEP | Unsupported release provider silently appears healthy. |
| L264 · pull_request: opened, updated, merged and closed; the base filter; payload and text | KEEP | PR state transitions/base filters or event payload fields are wrong. |
| L311 · pull_request: Bitbucket Cloud's 12-char head sha compares consistently, first polls within 60 s and then every 180 s | KEEP | Bitbucket polling quota interval or abbreviated-sha stability regresses. |
| L336 · ETags: a baselined listing sends its ETag; a 304 fires nothing and still counts as a poll | KEEP | Conditional listing omits ETag or changed page never fires new PR. |
| L358 · dedup survives a restart: a new poller over the same state never re-fires, and still fires what is new | KEEP | Restart/dedup ring replays already-fired push. |
| L387 · a changed filter or repo re-baselines; a disabled or deleted trigger is pruned | KEEP | Edited repo/filter runs stale cursor or disabled trigger continues polling. |
| L419 · two triggers on one repo share one poller (one ls-remote per poll); another account is another poller | KEEP | Equivalent URL identities duplicate remote traffic or different account shares credentials. |
| L442 · failures back off exponentially to 15 min, show on the trigger, honour Retry-After and never fire | KEEP | Provider failure causes retry storm, ignores Retry-After, or loses missed work on recovery. |
| L477 · a PR listing without the scope says which scope is missing; push triggers on the same repo keep polling | KEEP | PR scope error hides remedy or stops independent push watcher. |
| L492 · an unresolvable repository shows why and polls nothing; stop() leaves no timer | KEEP | Invalid/unresolved repo reaches remote process. |
| L503 · stop() mid-poll commits and fires nothing | KEEP | Late stopped poll commits state or fires work. |
| L524 · a token typed as the URL's user never reaches the poll, the payload or the error text | KEEP | Token typed in URL reaches remote/payload/provider diagnostic. |
| L545 · ETags: a new ETag is written in the same state update as the cursors that judged its page | KEEP | Committed ETag skips a page whose event cursors were never saved. |
| L569 · the pulls poll names the PRs its triggers last saw open (so a DC listing can look them up) | KEEP | DC closed-PR followup omits previously open numbers. |
| L580 · pull_request: an abbreviated head (Bitbucket Cloud) is completed from the branch heads before it fires | KEEP | Abbreviated PR event launches clone without resolvable full commit. |

## `apps/daemon/src/workflows/triggers/repo-resolve.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10, §6.2. Stable seam: repository/account selection from project layout and independent metadata. Unique owner and production consumers: poller/daemon-wiring consume resolver; FakeRemote-based tests inject a byUrl resolver and cannot protect origin/workspace identity mapping.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L28 · project repositories reject paths outside the workspace project layout | KEEP | Repository discovery reads outside the configured workspace/project layout. |
| L35 · repo kind url: as given, with its account or none | KEEP | Explicit remote/account is changed or missing public account invented. |
| L45 · repo kind project: an existing project's origin + its workspace's account | KEEP | Project origin is polled under wrong workspace git identity. |
| L60 · repo kind project on a temp workflow: its clone URL + that workspace's account; an empty temp project has none | KEEP | Temporary empty project creates bogus repo or clone loses workspace account. |
| L68 · a project whose origin appears later is picked up by the periodic re-resolve | KEEP | Adding origin after startup never starts monitoring. |

## `apps/daemon/src/workflows/triggers/scheduler.test.ts`

Independent source: [Workflow design](../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.1, §5.8. Stable seam: clock-driven trigger fire/public triggerState plus real cursor persistence. Unique owner and production consumers: daemon-wiring calls scheduler; end-to-end only proves ordinary scheduling and cannot detect outage grace, edit rearming or write failure ordering.

| Baseline line / exact declaration | Disposition | Specific failure, surviving coverage and risk |
| --- | --- | --- |
| L28 · a new trigger is scheduled from now and fires at its time, once, with the schedule payload | KEEP | New schedule fires early/twice or publishes wrong scheduled event time. |
| L56 · the cursor is persisted before the fire | KEEP | Trigger fires before cursor reaches disk and can repeat after restart. |
| L72 · the timer never sleeps more than 60 s, and a clock jump is noticed within a minute | KEEP | Host wake/clock jump leaves missed schedule dormant until old timeout. |
| L88 · boot: a run missed by less than the grace fires once; beyond it one missed stub, never a burst | KEEP | Long outage creates catch-up storm or short outage loses permitted fire. |
| L118 · edits rearm: a changed cron or zone recomputes from now; disable prunes, re-enable never fires a stale time; delete prunes | KEEP | Cron/timezone edit, disable/re-enable, or deletion reuses stale cursor. |
| L154 · an unrelated edit keeps the cursor; a disabled node is not scheduled; an invalid cron warns once and never fires | KEEP | Unrelated edit rearms cursor or invalid/disabled node fires. |
| L174 · a failed cursor write skips that one run but never stops the timer | KEEP | Failed cursor save stops scheduler forever or permits unrecorded fire. |
| L196 · a failed write while reconciling still arms the timer | KEEP | Initial reconciliation disk failure prevents recovered timer from firing. |

## Expanded runtime cases


Each row is KEEP under §5.8: fresh executor resumes the stored checkpoint, literal expected answer/session count and host user-message records prove completion and exactly-once submission; command receipts additionally prove lost-ack replay uses the previously recorded ID. Runtime data here is the persisted checkpoint protocol, not private method-call shape.

| Expanded case | Failure caught |
| --- | --- |
| restart at selecting (plain) | Lost or duplicated side effect/output after selection state; ordinary execution never reloads this durable cut. |
| restart at creating (plain) | Lost or duplicated side effect/output after pending session creation; ordinary execution never reloads this durable cut. |
| restart at sending (plain) | Lost or duplicated side effect/output after pending turn submission; ordinary execution never reloads this durable cut. |
| restart at watching (plain) | Lost or duplicated side effect/output after already-running turn baseline; ordinary execution never reloads this durable cut. |
| restart at output (plain) | Lost or duplicated side effect/output after settled output checkpoint; ordinary execution never reloads this durable cut. |
| restart at sending (plain), the ack after creating lost | Lost or duplicated side effect/output after lost create acknowledgement; ordinary execution never reloads this durable cut. |
| restart at watching (plain), the ack after sending lost | Lost or duplicated side effect/output after lost turn acknowledgement; ordinary execution never reloads this durable cut. |
| restart at answering (question) | Lost or duplicated side effect/output after pending input answer; ordinary execution never reloads this durable cut. |
| restart at watching #2 (question), the ack after answering lost | Lost or duplicated side effect/output after lost answer acknowledgement; ordinary execution never reloads this durable cut. |
| restart at interrupting (switch) | Lost or duplicated side effect/output after pending interruption; ordinary execution never reloads this durable cut. |
| restart at waiting-idle (switch) | Lost or duplicated side effect/output after provider idle wait; ordinary execution never reloads this durable cut. |
| restart at failing-over (switch) | Lost or duplicated side effect/output after cooled candidate transition; ordinary execution never reloads this durable cut. |
| restart at switching (switch) | Lost or duplicated side effect/output after pending account command; ordinary execution never reloads this durable cut. |
| restart at sending #2 (switch), the ack after switching lost | Lost or duplicated side effect/output after lost account-switch acknowledgement; ordinary execution never reloads this durable cut. |
| restart at sending #2 (switch) | Lost or duplicated side effect/output after continuation command checkpoint; ordinary execution never reloads this durable cut. |
| restart at watching #2 (switch) | Lost or duplicated side effect/output after post-switch turn baseline; ordinary execution never reloads this durable cut. |
| restart at handing-off (handoff) | Lost or duplicated side effect/output after new-family handoff checkpoint; ordinary execution never reloads this durable cut. |
| restart at creating #2 (handoff) | Lost or duplicated side effect/output after second-family session creation; ordinary execution never reloads this durable cut. |
| restart at sending #2 (handoff), the ack after creating lost | Lost or duplicated side effect/output after lost second-family create acknowledgement; ordinary execution never reloads this durable cut. |
| restart at waiting-reset (reset) | Lost or duplicated side effect/output after durable reset wake time; ordinary execution never reloads this durable cut. |
| restart at failing-over #2 (reset) | Lost or duplicated side effect/output after post-reset selection; ordinary execution never reloads this durable cut. |
| restart at sending #2 (reset) | Lost or duplicated side effect/output after post-reset continuation; ordinary execution never reloads this durable cut. |

The two expanded secret cases stop at `creating` and `sending`: each checks all first/second-executor persisted states contain no credential value and exactly one posted prompt contains the literal current credential. Both are surviving CONSOLIDATE owners because initial creation and pending turn payload have different persisted representations.
