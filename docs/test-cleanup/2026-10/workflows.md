# Workflow tests — October 2026 cleanup

Scope: all 38 assigned workflow test files, 382 baseline named declarations (404 runtime cases after expanding the 22-phase restart and two secret phases), initially 9,179 test LOC. Every test body was read alongside its owner/interface, with source requirements checked against current wire/schema contracts. Reports from earlier cleanups were used only for navigation.

Disposition counts by baseline declaration: {'KEEP': 359, 'REWRITE': 9, 'DELETE': 5, 'CONSOLIDATE': 7, 'OPTIMIZE': 2}. CONSOLIDATE includes three surviving owners and four eliminated duplicate declarations; DELETE removes five more declarations. Nine declarations are removed overall. Parameterized restart cases retain their distinct durable-state fixtures; their additional rows below are KEEP and are not double-counted in these declaration totals.

Implementation complete (validation pending); net test LOC: **−125** (28 added, 153 removed across 10 test files). The only production edit removes one test-only export.

Completed changes: two extra sandbox code children folded into one real result/log fixture; duplicate sandbox shell stream/exit journey removed (integration owns it); workflow-name/prompt/title E2E folded into real restart E2E; duplicate direct handoff-budget wrapper removed (API `handoffBudgetBytes` remains its arithmetic owner); production-derived budget/env oracles replaced by literal expected bytes; child-ID self-equality/shape test removed and all child fixtures use persisted parent/attempt metadata; test-only `childRunIdFor` export removed; defensive cache snapshot mutation probe removed; direct reference-index lifecycle consolidated into real store/reload owner, including renamed prompt-block metadata. No production behavior changed; the export visibility is the only production edit. The expression-preview expansion fixture now uses 1,024 repeated expressions rather than 50,000: this still exceeds the public 256 KiB cap, without tens of thousands of redundant parse operations. The timezone-until fixture jumps the existing manual clock to one millisecond before its asserted deadline, rather than replaying 1,260 identical one-minute wakeups; both before/at deadline assertions remain. The orphaned inline `SECRETS` fixture was removed; no dependency, snapshot, external fixture or mock becomes orphaned.

All six retention requirements are supplied by the file-level evidence plus each row: independent documented/API/storage/security contract; recognizable concrete failure; input/output oracle independent of implementation; stable semantic seam; no private collaborator call shape or incidental representation; unique failure fixture beyond surviving owners. Exact prompt bytes are retained only where they are sent to an agent as instructions/security framing, not as arbitrary UI wording. Filesystem formats/permissions, process identity, error codes, caps and event ordering are behavioral protocol/privacy contracts.

Performance: global baseline/final runner measurements and exact gates are coordinated by the root agent. This report must be updated with actual results before delivery. Saved work consists of five fewer child launches (two folded code launches, the duplicated shell pair and one redundant invalid-export example), one fewer real daemon runtime startup, and no additional production testing hooks. Three negative code cases now require the intended diagnostic reason instead of accepting any nonempty error. Do not interpret this operation count as a measured timing claim. Baseline identifies the 50,000-expansion expression case at 10,515.795 ms and timezone-until at 1,122.107 ms. The SIGTERM-resistant process test intentionally spends the real five-second grace to verify escalation; 50 MiB stream and 16 MiB output fixtures verify externally specified caps and remain.

Baseline evidence: the original unmodified root-run log records all 380 static workflow declarations plus 22 restart and two secret phase cases passing (404 runtime cases); no baseline workflow failure was observed.

Validation status: implementation is applied; awaiting the root's scheduled focused runner slot. No tests were run during the shared baseline profiling. `git diff --check -- apps/daemon/src/workflows docs/test-cleanup/2026-10/workflows.md` passes. The expression-cap mutation preloader is prepared in `/tmp/orquester-test-audit/workflows-no-expression-cap.mjs`; it changes the cap only inside an isolated test process.

## `apps/daemon/src/workflows/agent/cooldowns.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.4. Stable seam: createCooldownStore against a real WorkflowStateStore and buildCooldown policy values. Non-test callers and coverage ownership: executor/failover uses this policy; the Scenario cooldown fake does not exercise durable namespaced pruning. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| the cooldown store keys <family>:<accountId>, serves only active ones and prunes expired on write | KEEP | Detects: Provider/account cooldowns collide, expire late, or remain on disk after pruning. |
| cooldownUntil: resetsAt, else the burnt window's reset, else an hour; auth always an hour | KEEP | Detects: Provider resets or burnt-window reset are ignored, allowing launches before quota refills. |
| cooldownUntil: a limit with no known reset escalates per strike (1 h, 2 h, 4 h at most); a known reset never does | KEEP | Detects: Unknown resets cause repeated hourly retries instead of bounded strike escalation. |

## `apps/daemon/src/workflows/agent/executor.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.1–5.5; [Agent Profiles design](../../superpowers/specs/2026-10-18-agent-profiles-design.md) §5.5. Stable seam: NodeExecutor.execute result and DaemonApi session/command protocol. Non-test callers and coverage ownership: real executor normalizes deterministic provider responses; fake host supplies independent chat input, not expected workflow outcomes. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| happy path: creates the session like the MCP, sends the prompt with the autonomy note, returns the last message | KEEP | Detects: Launch drops unattended policy, workflow ownership, selected account/model, or returns commentary instead of the final answer. |
| continue-session mode: a follow-up turn into the upstream block's session; its text only | KEEP | Detects: Follow-up creates another session or returns a previous block's answer after a silent turn. |
| continue-session mode without an upstream session fails as a validation error | KEEP | Detects: Missing upstream session starts unrelated work rather than failing validation. |
| a saved prompt + append renders {{…}} first, escaped for the {variables} pass, then the variables | KEEP | Detects: Untrusted inserted braces execute saved-prompt variables or append text renders in the wrong order. |
| pull-request text is sent framed as untrusted data; the template's own text is not | KEEP | Detects: PR content escapes its untrusted frame or executes slash/skill instructions. |
| a failed variable read fails the block naming it, and no session is created | KEEP | Detects: A failed diff read submits an incomplete prompt or creates a session. |
| a missing saved prompt fails the block | KEEP | Detects: Deleted prompt references launch an empty task. |
| questions are answered autonomously: custom text where allowed, else (Recommended), else the first option — message-mode too, never dismissed | KEEP | Detects: Unattended questions hang, use incorrect recommended values, or dismiss message-mode input. |
| an approval is accepted | KEEP | Detects: Approval cards prevent the unattended agent from completing. |
| a plan card is implemented with the plan implementation prompt | KEEP | Detects: Plan-only completion ends the block without implementing the proposed plan. |
| whenOnlyWatchLoopsRemain: finish ends after a 60 s grace; wait keeps waiting until maxMinutes | KEEP | Detects: Monitoring-only tasks hold finish-mode forever or prematurely end wait-mode. |
| a wake that becomes a turn only 20 s after the background work ended is still waited for (a held Claude wake) | KEEP | Detects: Delayed provider wake loses the actual helper result. |
| background work that ended with no wake finishes after the 90 s wake window | KEEP | Detects: Background completion without a wake never settles after its safety window. |
| a quiet window catches a wake that comes right after the turn settles | KEEP | Detects: A wake immediately after settle is missed and stale output returned. |
| maxMinutes interrupts the agent and fails the block with timeout | KEEP | Detects: Block deadline leaves its agent running or reports success. |
| the run's cancel interrupts the agent and ends the block cancelled | KEEP | Detects: Run cancellation leaves its agent working. |
| a failed turn without a limit/auth reason is an agent_error with the host's message | KEEP | Detects: Provider crash is mislabeled as quota failure or loses useful diagnostic. |
| the live fields: selection, sessionId, hops and a throttled activity line | KEEP | Detects: Run view misses current account/session/activity while the block works. |
| a host that is restarting (503 on create) is retried on the clock; one session results | KEEP | Detects: Transient host restart duplicates sessions or fails the block. |
| an account the daemon would not launch (gone from its catalogue) is passed over by the catalogue check, never sent | KEEP | Detects: Stale account selection sends an account the launch catalog refuses. |
| a stored chain naming an agent this host does not offer (a removed launcher) passes it over and runs the next entry | KEEP | Detects: Removed launcher prevents fallback to an offered agent. |
| Agent Profiles §5.5: a block's profileId rides the create as an unattended launch | KEEP | Detects: Workflow profile is lost or launched interactively. |
| Agent Profiles §5.5: a missing profile fails the run at once with a clear error — no other account or agent is tried, never Global | KEEP | Detects: Missing profile silently falls back to Global or another account. |
| Agent Profiles §5.5: a profile that failed to prepare fails the run with the preparation's reason | KEEP | Detects: Broken preparation starts a Global chat or drops the preparation diagnostic. |

## `apps/daemon/src/workflows/agent/failover.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.2–5.5. Stable seam: agent execute result, public session commands and persisted cooldown effects. Non-test callers and coverage ownership: selection unit cases cannot prove actual session reuse, interruption, handoff, recovery or provider-specific accounting. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| limit at create (the provider never starts): switch account in the same session | KEEP | Detects: Startup quota failure terminates work before trying another account. |
| limit mid-turn: the partial work stays in the session and the new account continues it | KEEP | Detects: Mid-turn quota failure loses partial session work. |
| limit while parked (Claude's warning, turn still running): cooled until resetsAt, interrupted, switched | KEEP | Detects: A parked warning is ignored until timeout or wrong reset is persisted. |
| limit during background work: the whole thread is interrupted, then switched | KEEP | Detects: Background quota failure interrupts only a completed turn, leaving child work running. |
| a switch refused once (something still in flight) waits for idle again, then switches | KEEP | Detects: Transient in-flight refusal skips a usable same-session switch. |
| a switch the host keeps refusing hands off to a NEW session on the same agent's next account | KEEP | Detects: Permanent switch refusal loops instead of making a usable replacement session. |
| cross-family handoff: a new session with the handoff prompt (original prompt, notice, last messages, git status) | KEEP | Detects: Cross-family handoff loses task, recent work, owner, or working-tree context. |
| an auth handoff says the login failed and never passes the provider's error text as the agent's messages | KEEP | Detects: Authentication diagnostic is mislabeled or forwarded as prior assistant instructions. |
| the handoff caps the previous messages at 32 KiB (newest kept) and git status at 8 KiB | KEEP | Detects: Handoff discards newest text or exceeds documented transcript/git bounds. |
| the handoff carries less into a small context window: what the window leaves after the prompt (newest kept) | REWRITE | Detects: Small-window handoff exceeds the room available for the destination model. |
| the handoff budget: the 32 KiB cap, a known window, the fallback and a prompt that fills the window | DELETE | Fails unique protection / independent contract: Wrapper arithmetic and prompt clipping duplicate API budget cases and the adjacent real handoff scenarios. |
| OpenCode has no accounts: a limit goes to the next chain entry | KEEP | Detects: Accountless provider attempts unsupported account switching or poisons unrelated providers. |
| chain exhausted: fails all_burnt with every hop and skip | KEEP | Detects: Exhausted chain loses failure reason and attempted/skipped account records. |
| wait-for-reset: waits until the earliest reset, then resumes in the same session on that account | KEEP | Detects: Reset waiting either terminates work or creates a second session after quota refills. |
| wait-for-reset refuses a reset beyond maxWaitHours | KEEP | Detects: Quota reset outside the allowed wait budget keeps the run waiting. |
| an auth failure skips the account (1 h cooldown, unusable for the run) and fails over | KEEP | Detects: Authentication-failed account is immediately reused. |
| at most 12 hops: a chain of 14 burnt accounts gives up with limit_exceeded | KEEP | Detects: A failing chain cycles past its documented hop cap. |
| the cooldown is shared: the next block skips the burnt account | KEEP | Detects: The next block immediately reuses an account already known burnt. |
| a model the catalogue does not list skips its chain entry (why: catalog) and the next entry runs | KEEP | Detects: Unknown model prevents trying a valid later chain entry. |
| wait-for-reset over 48 h with limits that never name a reset: resumed hops are not counted, cooldowns escalate | KEEP | Detects: Reset waits consume working deadline/hop budget or fail to escalate repeated unknown resets. |
| coolDown keys accountless launches by provider and never reads another quota's reset | KEEP | Detects: OpenCode quota failure reads Codex's quota clock or cools all accountless providers. |

## `apps/daemon/src/workflows/agent/helpers.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.3–5.5, §5.7–5.9. Stable seam: normalized thread snapshots, executor output, rendered public session titles. Non-test callers and coverage ownership: window eviction, lagging summary, filtered activity and transformed-secret title fixtures are absent from ordinary end-to-end scenarios. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| only failures after this block's baseline count | KEEP | Detects: An old account failure causes a new block to fail over. |
| a baseline row that left the window falls back to the time cut | KEEP | Detects: Retained-window eviction hides new failures or attributes stale rows to this block. |
| the baseline takes the thread's latest turn over a lagging summary | KEEP | Detects: Lagging summary makes an already finished turn appear newly completed. |
| the output text is capped at 2 MiB | KEEP | Detects: Agent output exceeds its wire/storage cap or splits UTF-8. |
| the handoff reads the parent's words since the block began in the session | KEEP | Detects: Handoff includes prior blocks' or subagents' text instead of this block's parent work. |
| wait-for-reset honours maxWaitHours from the first wait | KEEP | Detects: Repeated reset waits extend maxWaitHours from each new wait. |
| the activity line reads tool calls and assistant text, never a provider's stderr or warnings | KEEP | Detects: Provider stderr replaces useful tool/assistant activity in the run view. |
| a chat title renders its {{…}} like the prompt, but never a secret's value | KEEP | Detects: A title fails template resolution, leaks direct secret refs, or flattens text incorrectly. |
| a chat title never shows a secret the render escaped, transformed or nested | KEEP | Detects: Escaping, filters, nested values, or keys expose transformed secret bytes in titles. |
| a chat title drops control and format characters | KEEP | Detects: ANSI/bidi/control bytes reach user-facing session titles. |

## `apps/daemon/src/workflows/agent/resume.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8. Stable seam: durable WaitingOn protocol rehydrated by a fresh executor and emitted chat command receipts. Non-test callers and coverage ownership: each durable phase is a supported stored checkpoint; ordinary execute coverage never resumes at these crash cuts. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| name | KEEP | Detects: Restart loses the pending action/output or repeats an already accepted side effect; distinct durable phases are detailed below. |
| a persisted state this version cannot read ends the block interrupted | KEEP | Detects: An unreadable future state is silently replayed or marked successful. |
| the deadline is wall-clock: a resumed block does not get its maxMinutes again | KEEP | Detects: Restart grants a fresh block deadline. |
| a secret in the prompt is never persisted, and a restart at ${phase} still sends the real value | KEEP | Detects: Resumed prompt state leaks secret bytes or sends markers instead of the current secret. |
| a handoff prompt carrying the secret keeps it out of the state and sends the real value | KEEP | Detects: Cross-family restart persists the secret-bearing handoff or sends its markers. |

## `apps/daemon/src/workflows/agent/secret-text.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8. Stable seam: reversible text used in durable agent WaitingOn, with legacy marker input for removal compatibility. Non-test callers and coverage ownership: remaining collision and deleted-secret fixtures protect serialization compatibility beyond the ordinary persisted prompt cases. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text | DELETE | Fails unique protection / independent contract: Private marker bytes are pinned despite runtime prompt-resume and redactor tests already protecting secrecy, reversibility and longest-match redaction. |
| a secret whose value is another secret's name never corrupts a marker | KEEP | Detects: Overlapping secret names/values corrupt a restored prompt. |
| a marker for a secret that no longer exists is sent as nothing; text without markers is untouched | KEEP | Detects: Removed secret references send stale credential bytes or corrupt ordinary text. |

## `apps/daemon/src/workflows/agent/select.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.2. Stable seam: pure selection decision consumed by preview and executor. Non-test callers and coverage ownership: factory/preview/failover are non-test callers; the documented owner fixture, thresholds and ranking policies have independent chosen-account values. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| owner's example: soonest weekly reset under 85% picks jasperclaude and skips therealeduard465 | KEEP | Detects: Owner's explicitly documented account example chooses the over-threshold account. |
| soonest-reset without a threshold takes the earliest weekly reset | KEEP | Detects: Soonest-reset policy chooses a later eligible weekly reset. |
| soonest-reset on the session window: unknown resets go last | KEEP | Detects: Unknown session-reset time outranks a known usable reset. |
| least-used (max) picks jasperinuwu | KEEP | Detects: Least-used policy chooses a more heavily used account. |
| least-used ties break on the soonest weekly reset, then the label | KEEP | Detects: Equal usage becomes unstable or ignores reset/label tie breaks. |
| fixed order [therealeduard465, jasperclaude] under 85% weekly picks jasperclaude — by label or by id | KEEP | Detects: Fixed account order ignores label/id allow-list or its threshold. |
| an allow-list filters the family, and names what it cannot find | KEEP | Detects: Selection escapes the allow-list or hides a deleted account. |
| a scoped threshold applies only to the models it names | KEEP | Detects: Model-specific usage caps disable unrelated models. |
| a window at 100% is always burnt; a burnt scoped window stops only the models it covers | KEEP | Detects: Burnt session/scoped quota is ignored or disables unaffected model families. |
| expired windows are ignored: a pre-reset 100% no longer blocks | KEEP | Detects: Refilled quotas remain excluded using stale pre-reset percentages. |
| unknown usage is tried after every known account — or dropped with unknownUsage: exclude | KEEP | Detects: Unavailable/stale/missing usage prevents fallback or bypasses explicit exclusion. |
| needsReauth, cooldowns and the exclude set drop candidates | KEEP | Detects: Reauth, prior tries, or another family's cooldown are confused. |
| an expired cooldown no longer counts | KEEP | Detects: Expired cooldown leaves a usable account excluded. |
| cross-family fallback: claude (all burnt or cooling) → codex (reauth, burnt) → grok | KEEP | Detects: Earlier ineligible families block a usable later agent. |
| nothing eligible anywhere: chosen null and the earliest instant a candidate frees | KEEP | Detects: All-burnt selection waits for the wrong earliest eligible reset. |
| a threshold breach with an unknown reset contributes no earliest instant | KEEP | Detects: Unknown reset generates a fictional wake deadline. |
| opencode has no accounts: one system candidate, only its cooldown applies | KEEP | Detects: Accountless launch applies managed-account policy or ignores its own cooldown. |
| system: the family's system row, or its head row when it has no managed accounts | KEEP | Detects: Managed and system quota rows are joined to the wrong login. |
| chosen carries the entry's model options | KEEP | Detects: Selected effort/model options are dropped. |
| burntWindowResetAt: the latest reset among burnt windows | KEEP | Detects: Latest exhausted quota reset is lost while a different window remains burnt. |
| accountless cooldowns are per provider: one provider's limit never cools another's entries | KEEP | Detects: One OpenCode provider's limit disables another provider or Codex. |

## `apps/daemon/src/workflows/agent/validation-catalog.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.2, §8.1. Stable seam: catalog available to definition validation after DaemonApi responses and clock changes. Non-test callers and coverage ownership: daemon-wiring/routes call ready/current/expire; provider-change E2E does not exercise late attachment or failed-read backoff. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| nothing is known before the client is attached; ready() then reads the host's catalogue | KEEP | Detects: Pre-attachment startup fabricates a known catalog or fails to load models once attached. |
| a failed read is not retried on every request, only once the refresh window has passed | KEEP | Detects: Registry failure causes every request to retry and overload an unavailable host. |
| expire() reads again at once — even inside a failure's backoff — and keeps the last reading until then | KEEP | Detects: Catalog change remains stale during backoff or temporarily becomes unknown. |

## `apps/daemon/src/workflows/catalog-events.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.1–7.2, §8.1. Stable seam: real daemon wiring, GET workflow rows and broadcast workflow.upserted events. Non-test callers and coverage ownership: uniquely verifies registry-bus invalidation reaches already-open clients without a definition save. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a provider change re-judges the rows: the problem goes out, and comes back, without an edit | KEEP | Detects: Provider refresh does not remove/reinstate the published workflow model problem until the user edits. |

## `apps/daemon/src/workflows/e2e-agent.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.1, §5.3, §5.8. Stable seam: real daemon routes/stores/wiring re-opened over the same appdir. Non-test callers and coverage ownership: only real agent-runtime handover coverage; pure Scenario resume does not exercise persisted run.json plus engine registration. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a restart while the agent works resumes the watcher and never sends the turn twice | CONSOLIDATE | Real stores/wiring fail to resume an agent watcher once, or lose workflow expressions while rebuilding the runtime; surviving owner the real agent restart case also asserts this contract without repeating a separate fixture. |
| an agent prompt and its chat title read {{ workflow.… }} as every other block does | CONSOLIDATE | Workflow expression/title setup repeats the same real runtime journey; moved into surviving restart scenario; surviving owner the real agent restart case also asserts this contract without repeating a separate fixture. |

## `apps/daemon/src/workflows/e2e-mcp.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §8.2–8.3; [MCP public contract](../../orquester-mcp.md) §12. Stable seam: public MCP JSON-RPC tools/call through real routes and services. Non-test callers and coverage ownership: MCP fake-route tests cannot detect translation/service incompatibility or broken published examples. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| the published Jira create and edit example stays valid on the real routes | KEEP | Detects: Published authoring commands cannot create/edit a valid real workflow. |
| create_workflow and update_workflow {dryRun: true} validate on the real route and save nothing | KEEP | Detects: MCP dry-run mutates real state or validates the wrong project/patch. |
| run_workflow waits for a real run and its stored output can be read by node name | KEEP | Detects: MCP wait returns before the real run finishes or loses name-addressed persisted output. |

## `apps/daemon/src/workflows/e2e.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.4, §5.6–5.8, §6. Stable seam: real routes, filesystem artifacts, detached children and local HTTP. Non-test callers and coverage ownership: retained critical complete journeys exercise wiring gaps between independently tested engine, process, transport and trigger owners. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a manual pipeline produces its final output and redacts secrets in public and durable artifacts | KEEP | Detects: Real route-to-sandbox-to-HTTP flow loses data or exposes a secret through durable/public artifacts. |
| the runtime stops while a shell block sleeps; a new one over the same appdir resumes it | KEEP | Detects: Real detached process dies on runtime handover or is spawned a second time. |
| nextRunAt reaches the rail, the scheduler fires the run on time, the next time follows | KEEP | Detects: Scheduler wiring never starts runs or omits nextRunAt from public summaries. |
| the poller baselines, fires once on a push, and a failing poll shows on the rail | KEEP | Detects: Poller wiring repeats baselines, drops push payloads, or hides provider failure from public summaries. |

## `apps/daemon/src/workflows/engine-fixes.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.4, §5.6–5.8, §5.10. Stable seam: runtime engine run/resume/stop and stored/public run outcomes. Non-test callers and coverage ownership: barriers inject credible crash/I/O races without implementing the engine result; baseline graph cases cannot expose these ordering failures. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| an HTTP POST reached after stop() is not sent; the resumed run sends it exactly once | KEEP | Detects: Stopped engine submits an unrecorded POST or its successor submits it twice. |
| a runner spawned while the engine stopped is adopted from its handle, never spawned twice | KEEP | Detects: Stop between process launch and acknowledgement respawns external work. |
| a parent's secret rendered into a sub-workflow's input is redacted in the child run | KEEP | Detects: Child run stores a parent's workflow-local credential in its input. |
| a code runner stopped from outside fails the block; the run does not succeed | KEEP | Detects: Externally stopped runner is reported as a successful block. |
| a block that answers cancelled while nothing cancelled the run fails it | KEEP | Detects: Unrequested executor cancellation leaves the workflow falsely successful. |
| a missing existing project fails the run with errorKind project_missing | KEEP | Detects: Deleted project failure loses its machine-readable error kind in history. |
| a restart during the creation: the pending path is on disk, removed, and made again | KEEP | Detects: Restart leaks or reuses an incompletely created temp project. |
| a failed creation removes what it left and records nothing pending | KEEP | Detects: Failed clone leaves an orphan temp directory or pending marker. |
| a run whose saved state cannot be read is due for the sweeper | KEEP | Detects: Unreadable run state leaks its retained temp directory forever. |
| stopping during the finalize's delete leaves the project due for the sweeper | KEEP | Detects: Shutdown during cleanup loses the only scheduled deletion record. |
| a release event clones at its tag; a PR head the clone cannot resolve is retried at the PR branch | KEEP | Detects: Release clone uses the wrong commit/tag or abbreviated PR failure never falls back to its branch. |
| a run is not active until its record exists; a failed create leaves nothing active | KEEP | Detects: Disk failure leaves a phantom active run blocking later work. |
| a stored run naming a block `__proto__` is interrupted, never walked | KEEP | Detects: Persisted prototype block identifiers execute or pollute ordinary objects. |
| an invalid URL quoting a long secret is redacted before it is cut | KEEP | Detects: Invalid URL truncation leaks a prefix of a long credential. |

## `apps/daemon/src/workflows/engine-resume.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.8. Stable seam: fresh engine over persisted run state, observing attempts, child records and final results. Non-test callers and coverage ownership: covers each external effect recovery kind and uncertain storage result; generic agent resume cannot protect graph/child/process recovery. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a Wait block's timer resumes at the same wall-clock instant | KEEP | Detects: Restart resets a persisted wait duration. |
| a retry delay resumes, then the next attempt runs | KEEP | Detects: Retry delay is lost or the attempt counter starts again. |
| a code process that ended while the daemon was down: its exit.json is read | KEEP | Detects: An offline process failure is reported as successful or loses its recorded exception. |
| a process gone without a record is interrupted — retried when the policy allows | KEEP | Detects: Missing exit record is trusted as success or bypasses retry policy. |
| a child run is re-subscribed by its parent | KEEP | Detects: Parent never resumes when its already-running child finishes. |
| an HTTP GET is re-issued; a POST fails interrupted | KEEP | Detects: Restart repeats a potentially side-effecting POST or fails to reissue a safe GET. |
| a block running without a WaitingOn: a pure block re-runs as the same attempt | KEEP | Detects: Pure block crash causes interruption or reruns succeeded upstream work. |
| the engine stopping while a block persists its wait state: the run is not failed, and resumes after the restart | KEEP | Detects: Shutdown while persisting a wait records a spurious block failure. |
| a block reached while the engine stops never starts: it stays pending and runs after the restart (not interrupted) | KEEP | Detects: Stop during graph advancement marks an unstarted block interrupted. |
| a Run workflow block whose child the stopping engine refused (ENGINE_UNAVAILABLE) is no validation failure: it runs again after the restart | KEEP | Detects: Stopping engine's refused child launch becomes permanent validation failure. |
| a Run workflow block found running without its WaitingOn adopts the child it did start (never a second one) | KEEP | Detects: Lost child acknowledgement executes a second child. |
| a Run workflow block's child is bound to its attempt: attempt 2, cut off before its launch, runs its own child — never adopts attempt 1's | REWRITE | Detects: Retry adopts the preceding attempt's child; persisted parentAttempt provides an independent oracle. |
| a child recorded by an older build (no binding) is still adopted when it was queued since the attempt started | REWRITE | Detects: Legacy unbound child is replayed instead of adopted; fixture selects recorded metadata rather than generated IDs. |
| whether the attempt started a child cannot be read: the block is interrupted, never re-run — even with retries left | KEEP | Detects: Uncertain child existence is treated as definite absence and duplicated. |
| a failed child lookup fails the run only after its children are linked: a sibling block's live child is cancelled with it | REWRITE | Detects: Lookup failure leaves sibling child work running; fixture selects actual persisted child identities. |
| runChild cannot tell whether the attempt's child exists: the block fails interrupted, never retried, no child started | KEEP | Detects: Fresh child lookup I/O error is retried as an ordinary validation failure. |
| an older build's child listed but unreadable is no definite absence: the block is interrupted, not re-run | REWRITE | Detects: Unreadable legacy child is duplicated instead of failing closed; fixture locates the recorded child independently. |
| child run ids are deterministic, UUID-shaped and hash-first (full-entropy 8-character prefixes) | DELETE | Fails oracle/stable-seam/refactor-resistance: Self-equality and arbitrary hash/UUID shape detect representation changes; exact-once adoption and attempt-isolation cases remain. |
| a side-effecting block running without a WaitingOn is interrupted (no retry) | KEEP | Detects: Unrecorded side-effecting block is replayed automatically. |
| queued runs start after a restart; a run whose definition cannot be read is marked interrupted | KEEP | Detects: Queued work vanishes on restart or malformed definition blocks recovery of other runs. |
| stop() persists the last state and writes nothing after | KEEP | Detects: Old engine writes over successor state after handover. |

## `apps/daemon/src/workflows/engine.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.4, §4, §5.8–5.11, §7.6. Stable seam: WorkflowEngine run/fire/cancel/testNode/nodeOutput/history/events. Non-test callers and coverage ownership: controlled executor returns only block result inputs; real engine owns graph routing, lifecycle, queueing, retention decisions and public state. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| IF takes one branch; the other is skipped with its edges dead | KEEP | Detects: Unchosen IF branch executes or fails to propagate dead paths. |
| Switch: the first matching case wins, the fallback takes the rest, no fallback kills every edge | KEEP | Detects: Switch selects the wrong output or executes an unmatched branch. |
| independent branches run concurrently; Merge (all) waits for every live input | KEEP | Detects: Concurrent inputs serialize or all-mode merge fires before all live inputs. |
| Merge (first) runs on the first arrival and ignores the later one | KEEP | Detects: First-mode merge runs again on a late arrival. |
| a block with several live inputs and no Merge reads the merge object | KEEP | Detects: A multi-input block loses one upstream branch. |
| a failure with an error edge routes down it and the run succeeds | KEEP | Detects: Error edges lose partial output/diagnostic or route as ordinary success. |
| a failure without an error edge fails the run and cancels the running siblings | KEEP | Detects: Unhandled failure leaves sibling work running. |
| retries wait their delay on a persisted timer, then succeed | KEEP | Detects: Retry executes before its durable delay or retains stale error after success. |
| all_burnt and limit_exceeded failures are never retried | KEEP | Detects: Known unrecoverable cap/account exhaustion is retried. |
| an agent waiting for a usage reset (kind agent, phase waiting-reset) reads waiting and resumes as such | KEEP | Detects: Usage-reset waiting appears active instead of waiting in run state. |
| retries exhausted: the last failure stands | KEEP | Detects: Final retry failure vanishes or retry count is ignored. |
| a disabled block passes its input through as success without running | KEEP | Detects: Disabled block executes or drops upstream data. |
| Stop as failure fails the run with its message and value | KEEP | Detects: Failure Stop drops configured output/message or leaves siblings running. |
| code's stop() ends the run as stopped | KEEP | Detects: Code Stop walks downstream or emits wrong final status. |
| a trigger-less workflow starts at its roots with the manual input | KEEP | Detects: Manual roots receive no input when workflow has no explicit trigger. |
| a fired trigger runs; the others are skipped | KEEP | Detects: Firing one trigger executes unrelated trigger branches. |
| a run with validation errors is refused (manual) or recorded as failed (trigger) | KEEP | Detects: Invalid manual run executes work or scheduled invalid fire vanishes from history. |
| expectedRevision: a manual run starts only on that revision, refused before any block otherwise | KEEP | Detects: Revision-pinned caller runs a newer workflow than it approved. |
| a projectOverride block runs in that project; a missing one fails the block | KEEP | Detects: Per-block project override is ignored or a deleted override runs elsewhere. |
| an executor that throws or answers nonsense fails its block as internal | KEEP | Detects: Unexpected executor failure escapes the run instead of becoming a block error. |
| a big output goes to a file with an inline preview; downstream and nodeOutput read it whole | KEEP | Detects: Spilled output leaks its host path or downstream receives only the preview. |
| an output over the hard cap fails the block with limit_exceeded | KEEP | Detects: Oversized executor output is accepted and stored. |
| a secret appearing in an output, an error or a warning is redacted everywhere | KEEP | Detects: Persisted/published output/error/warning exposes a secret. |
| the per-run update events are throttled; the final state is always published | KEEP | Detects: Burst updates lose latest activity/final state or publish finished before final update. |
| cancel mid-block aborts it and ends the run cancelled | KEEP | Detects: Cancellation remains active, repeats notification, or executes downstream. |
| a block that ignores its abort cannot hold a cancelled run forever | KEEP | Detects: Uncooperative block holds a cancelled run indefinitely. |
| the run timeout fails the run and cancels what runs | KEEP | Detects: Run deadline leaves its blocks active. |
| skip: a second fire records a skipped stub; force runs anyway | KEEP | Detects: Skip overlap omits visible skipped history or force cannot proceed. |
| queue: one pending fire waits for the active run; a further fire is skipped | KEEP | Detects: Queue policy starts too many pending runs or fails to release its one queued run. |
| parallel: up to maxConcurrent, then skipped | KEEP | Detects: Parallel overlap exceeds configured maxConcurrent. |
| the global run cap queues runs beyond it, FIFO | KEEP | Detects: Global run cap loses FIFO queued work. |
| a queued run can be cancelled before it starts | KEEP | Detects: Queued cancellation starts work or invents startedAt. |
| agent blocks and sandbox processes wait behind their global caps | KEEP | Detects: Agent/process resource limits fail to queue/release pending blocks. |
| an agent block's timer wait releases its slot; waking takes it back | KEEP | Detects: Reset wait holds an agent slot and starves later blocks. |
| usePinned: a pinned block is not executed and downstream reads its pin | KEEP | Detects: Pinned output executes the block or fails to feed downstream. |
| without usePinned, pins are ignored | KEEP | Detects: Ordinary runs silently execute stale pinned test data. |
| fromNodeId runs that block and its downstream; upstream from pins, else the latest run | KEEP | Detects: Run-from-block uses wrong upstream data or executes upstream blocks. |
| testNode executes only that block, even with no upstream data | KEEP | Detects: Single-block test executes downstream or invents input without upstream data. |
| testNode seeds only the tested block's upstream: downstream and side branches stay skipped | KEEP | Detects: Single-block test seeds unrelated/downstream outputs from a previous run. |
| retryOf reuses the succeeded blocks and re-runs the failed ones | KEEP | Detects: Retry reruns successful upstream work or loses trigger input. |
| retryOf + fromNodeId on the fired trigger re-runs everything with the same event | KEEP | Detects: Retry-from-trigger reuses stale blocks or triggers unrelated branch. |
| retryOf + a non-trigger fromNodeId runs from there on that run's upstream outputs | KEEP | Detects: Retry-from-block reads a later run's outputs. |
| retryOf does not reuse a success that sits below a block being re-run | KEEP | Detects: Retried branch incorrectly retains a formerly successful error handler. |
| created per run, deleted when the run succeeds | KEEP | Detects: Successful temporary workflow leaks its per-run checkout. |
| kept keepFailedTempDays when the run fails; Delete now removes it | KEEP | Detects: Failure retention deletes project too early or Delete now leaves it. |
| a git trigger on the project repo clones at the event's sha | KEEP | Detects: Git-triggered temp run clones a moving branch instead of event commit. |
| the child's final output is the block's output; runs are linked both ways | KEEP | Detects: Parent loses child output or persisted run linkage. |
| a child given text someone else wrote is marked untrusted, so its prompts frame it | KEEP | Detects: Untrusted child input bypasses prompt framing. |
| a failing child fails the block with child_run_failed | KEEP | Detects: Failed child is reported as successful parent block. |
| the depth limit and cycles are refused at run time | KEEP | Detects: Runtime recursion creates unbounded cycles/depth. |
| cancelling the parent cancels the child | KEEP | Detects: Parent cancel leaves its child active. |
| sub-workflow definitions are frozen when the top-level run starts: a child (and a grandchild) edited mid-run runs as it was | KEEP | Detects: Mid-run edits change the child/grandchild code being executed. |
| a sub-workflow deleted after the run started fails its block; none frozen when there are no sub-workflows | KEEP | Detects: Deleted frozen child executes silently or plain workflow stores unrelated snapshots. |
| child runs bypass the global run cap (no deadlock) | KEEP | Detects: Sub-workflow chain deadlocks at the top-level run cap. |
| deleting a workflow cancels its runs and stops writing them | KEEP | Detects: Late block result recreates data after workflow deletion. |
| enabledTriggers lists enabled workflows' live trigger nodes; definition changes are forwarded | KEEP | Detects: Disabled triggers are returned to schedulers or definition changes do not propagate. |
| recordSkipped writes a visible stub | KEEP | Detects: Missed trigger disappears instead of producing inspectable skipped history. |

## `apps/daemon/src/workflows/git-remote/clone-ref.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10; git clone/ls-remote argument and object-ID protocol. Stable seam: clone ref validation and exact git argv bytes. Non-test callers and coverage ownership: AccountsService and workflow project cloning use these production helpers; preserving -- and full-versus-short object IDs is a real process/security boundary. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| cloneRefProblem accepts branches, tags and shas | KEEP | Detects: Legitimate branch/tag/full commit ref is refused before git. |
| cloneRefProblem refuses empty, long, option-like, whitespace and control characters | KEEP | Detects: Ref becomes a git option or contains process-argument control/whitespace. |
| sha detection: only full ids skip --branch; short hex may be either | KEEP | Detects: Short hex branch is mistaken for a detached commit or SHA-256 commit treated as branch. |
| cloneArgs: a name rides --branch, a sha and no ref clone plainly, the URL follows -- | KEEP | Detects: Clone loses -- separator or applies --branch to a full commit. |
| isMissingRemoteRef recognises git's messages | KEEP | Detects: Missing-ref fallback runs on an authentication failure. |
| resolveAbbreviatedSha: one commit by prefix, null when none or ambiguous | KEEP | Detects: Ambiguous abbreviated commit resolves to arbitrary advertised object. |

## `apps/daemon/src/workflows/git-remote/ls-remote.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2; git ls-remote wire format. Stable seam: external stdout parser. Non-test callers and coverage ownership: remote readers consume this parser; FakeRemote-based poller tests bypass textual Git serialization. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| parseLsRemote reads heads, lightweight and annotated tags, and the HEAD symref | KEEP | Detects: Git heads, HEAD symref or annotated-tag commit is parsed incorrectly. |
| parseLsRemote: a peeled line before its tag, CRLF, junk and uppercase shas | KEEP | Detects: CRLF/uppercase/junk or peeled-before-tag listing yields wrong refs. |
| parseLsRemote: no HEAD line → no defaultBranch; a __proto__ branch stays an own key | KEEP | Detects: Hostile branch name mutates object prototype or absent HEAD invents default. |
| parseLsRemote: SHA-256 object ids | KEEP | Detects: SHA-256 repository heads disappear from polling. |

## `apps/daemon/src/workflows/git-remote/remote-url.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10, §6.2; credential containment rule in AGENTS.md. Stable seam: remote identity, permitted process transports and sanitized URL/error bytes. Non-test callers and coverage ownership: cloning/providers/poller call these helpers; canonical identity and transport security require adversarial strings beyond ordinary trigger journeys. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| repoKeyOf: every GitHub form of one repo has one key | KEEP | Detects: Equivalent GitHub transport/browse forms create separate repository identities. |
| repoKeyOf: Bitbucket Cloud's old and new SSH hosts are one host | KEEP | Detects: Old/new Bitbucket SSH hosts get separate cursors. |
| repoKeyOf: Bitbucket Server/DC forms reduce to host/project/repo | KEEP | Detects: DC context/browse/SSH forms identify different repositories. |
| repoKeyOf: other hosts keep their whole path (GitLab subgroups) | KEEP | Detects: GitLab subgroup information is discarded. |
| repoKeyOf: refuses what git would not be handed | KEEP | Detects: Unsafe/local/option URL is handed to git by key derivation. |
| repoDisplayName keeps the original case | KEEP | Detects: Trigger repository display loses user-visible case/path. |
| remoteUrlProblem accepts the four transports and refuses the rest | KEEP | Detects: Unsafe git transport reaches remote process invocation. |
| stripUrlCredentials drops the whole http(s) userinfo (a token may be the user) and an ssh password | KEEP | Detects: Credential userinfo persists in stored remote URL. |
| redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins | KEEP | Detects: Provider stderr exposes token-as-user/password but drops necessary SSH login. |

## `apps/daemon/src/workflows/integration.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.2–3.3, §5.6, §5.9. Stable seam: real shell children/local HTTP reached through WorkflowEngine. Non-test callers and coverage ownership: owns actual env/process/HTTP semantics; controlled executors and fake fetch cannot prove encoding, aborting, redirect or OS exit behavior. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a shell block gets its env (secrets included), never a rendered script; exit codes map | KEEP | Detects: Real shell receives interpolated executable data, drops env/streams, or loses nonzero exit output. |
| cancelling a run kills its shell promptly | KEEP | Detects: Cancelling engine reports completion while its real process remains alive. |
| JSON responses are parsed; query and headers are rendered (secrets allowed, redacted after) | KEEP | Detects: Real HTTP request misencodes query/headers or fails to parse JSON. |
| text stays text; redirects are followed or not; statuses map | KEEP | Detects: Redirect/status configuration is ignored or failed response body is lost. |
| bodies: JSON rendered from a value, form fields, text | KEEP | Detects: JSON/form/text request bodies reach the server incorrectly or invalid JSON is sent. |
| the body cap, the timeout and a network error each fail the block with their kind | KEEP | Detects: Oversized/hung/disconnected/unsupported HTTP requests lose distinct failure kinds. |

## `apps/daemon/src/workflows/nodes/nodes.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §4, §5.6, §5.9. Stable seam: real engine Wait outputs/deadlines and real shell output/log. Non-test callers and coverage ownership: timezone precedence and tail-versus-durable-log contracts differ from generic timer recovery and raw stream caps. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| until HH:MM waits for the next such time in the block's time zone | OPTIMIZE | Detects: Wait-until ignores block timezone or resumes at wrong date. |
| the workflow's own time zone applies when the block names none | KEEP | Detects: Missing block timezone ignores workflow timezone. |
| stdout and stderr are the tails within the cap, with a warning; the whole log stays on disk | KEEP | Detects: Shell output keeps head instead of tail, silently truncates, or discards durable full log. |

## `apps/daemon/src/workflows/nodes/regex-worker.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.3, §5.9; daemon event-loop responsiveness/security. Stable seam: real matcher worker result/timeout and async rule warnings. Non-test callers and coverage ownership: API evaluator tests use injected matcher and cannot prove worker isolation/recovery; warning case owns redaction before clip. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| an ordinary pattern answers | KEEP | Detects: Worker cannot return both matching and nonmatching results with flags. |
| a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works | KEEP | Detects: Catastrophic user regex blocks daemon, survives its timeout, or poisons next request. |
| a clipped value is redacted before the clip | KEEP | Detects: Rule diagnostic clips a credential before redaction and exposes its prefix. |

## `apps/daemon/src/workflows/reference-index.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §8.1–8.3; [MCP public contract](../../orquester-mcp.md) §12; [Agent Profiles design](../../superpowers/specs/2026-10-18-agent-profiles-design.md) §5.5. Stable seam: reference answers, real service persistence and HTTP preconditions. Non-test callers and coverage ownership: WorkflowService maintains index; session-tool authorization consumes it. Direct graph cases own cycles/transitivity; store cases own atomic synchronization; routes own wire metadata. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| index: direct and transitive callers, cycles, calls each once; prompt uses with their blocks, a disabled block too | KEEP | Detects: Transitive/cyclic callers, disabled saved-prompt uses, or non-agent false positives are misreported. |
| index: create, update, delete and re-target of sub-workflow and prompt references keep it exact; the version moves with each | CONSOLIDATE | Index reference lifecycle repeats store-level integration's mutations and rebuild; uniquely named-block/order assertions are retained there if consolidated; surviving owner the real store/reload reference case also asserts this contract without repeating a separate fixture. |
| index fails closed: before a rebuild, while the file is unreadable, and for any id an unreadable record mentions | KEEP | Detects: Unknown startup/corrupt definition is reported as safe to edit with no callers. |
| index: Agent Profile uses — agent blocks with a profileId, a disabled one too; re-targeted, deleted, and unknown when an unreadable record names it | KEEP | Detects: Profile edit/delete safety misses disabled launches, stale retargets, or unknown future references. |
| the store keeps the index through create, patch, replace, duplicate and delete; a reload rebuilds the same answers from disk | CONSOLIDATE | Definition write and reference map diverge across real persistence/reload; surviving owner the real store/reload reference case also asserts this contract without repeating a separate fixture. |
| startup tolerates other builds' records: an unreadable one that names a workflow makes its callers unknown; an unreadable file makes every answer unknown | KEEP | Detects: Unreadable newer definitions permit edits/deletes on guessed caller absence. |
| race: an answer never lags a save that landed, and a write whose callers changed since the card is refused (CALLERS_CHANGED), nothing saved | KEEP | Detects: Approval based on older callers mutates workflow despite newly landed usage. |
| routes: GET the references of a workflow, a saved prompt and an Agent Profile; DELETE ?expectCallers= is the same precondition | KEEP | Detects: Wire reference metadata/precondition parsing differs from service rules. |
| a load that fails part-way never leaves a known index: every answer is unknown, and the error is rethrown | KEEP | Detects: Partial load leaves trusted reference answers despite failing startup. |
| routes without a wired projectPathFilter name no guessed workspace for an existing project (a temp project's stays) | KEEP | Detects: Unwired resolver invents a workspace from an untrusted path layout. |

## `apps/daemon/src/workflows/routes.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §7.1–7.3, §8.1; [MCP public contract](../../orquester-mcp.md) §12. Stable seam: Fastify inject HTTP status/code/body/headers and one real chunked socket. Non-test callers and coverage ownership: route fallback, binding, cascade, preview viewpoint and redaction cannot be inferred from lower-level parser or store tests. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| without the engine: acting routes answer 503 ENGINE_UNAVAILABLE | KEEP | Detects: Acting endpoint runs without an available engine instead of stable 503. |
| without the engine: history, run detail and outputs are read from the run store | KEEP | Detects: Engine outage hides persisted history/full output or exposes host bookkeeping. |
| validate uses the daemon's saved-prompt catalog and reports malformed or missing resources | KEEP | Detects: Saved-prompt catalog is omitted from route validation. |
| the list filters by project: the existing project, plus temp workflows of its workspace | KEEP | Detects: Project listing leaks unrelated project/workspace workflows. |
| block types and the schedule preview | KEEP | Detects: Schedule preview accepts invalid cron or ignores result cap. |
| secrets: names only, write-only values, scoped to an existing workflow | KEEP | Detects: Secrets endpoint leaks values or permits unknown workflow scope. |
| delete cascades: active runs cancelled through the engine, runs and secrets removed | KEEP | Detects: Delete fails to cancel/cascade only target runs/secrets or leaks global secret list for missing scope. |
| with the engine: runs, tests, cancels and summaries go through it | KEEP | Detects: Transport loses missing-workflow/node/inactive-run refusal codes. |
| log windows are redacted and report their position | KEEP | Detects: Log route leaks raw secret or reports wrong resumable byte cursor. |
| log follow streams as the file grows and redacts a secret split across writes | KEEP | Detects: Real chunked HTTP follow leaks credential fragments across writes. |
| an engine refusal keeps its status, code and problems (never a generic 500) | KEEP | Detects: Engine errors become generic 500 and lose actionable problems. |
| DELETE of a secret refuses prototype names and unknown workflows | KEEP | Detects: Secret DELETE accepts prototype-name operations or invalid scope. |
| write routes take a body past 1 MiB, and one past their limit answers LIMIT_EXCEEDED | KEEP | Detects: Default server body limit rejects supported definitions, or oversized writes lose LIMIT_EXCEEDED. |
| account-preview refuses a chain entry it cannot read (400, never 500) | KEEP | Detects: Malformed account preview raises 500. |
| the delete cascade keeps a run record whose temp project it could not delete; deletes it directly when it can | KEEP | Detects: Workflow deletion loses last cleanup record when project delete unavailable. |
| expression preview: returns node-relative data, missing/error state and source metadata | KEEP | Detects: Expression route drops render/missing/parse metadata or exposes non-upstream node. |
| expression preview: secrets render as placeholders and a secret inside an output is redacted | KEEP | Detects: Secret references and transformed/nested outputs leak through expression preview. |
| expression preview: the block's point of view decides input; several inputs are keyed by name | KEEP | Detects: Preview computes input from wrong block's viewpoint. |
| expression preview: value mode keeps a number a number and says when nothing was read | KEEP | Detects: Typed value preview coerces JSON number to text or hides missing state. |
| expression preview: pinned outputs replace recorded ones; with no run they are the only data | KEEP | Detects: Pins override when disabled or upstream-only pin filtering is lost. |
| expression preview: the default run is the latest that reached the block; big outputs are read whole | KEEP | Detects: Preview chooses wrong reached run, loads a preview as full output, or fails to cap expansion. |
| expression preview: refusals use the workflow error codes | KEEP | Detects: Preview failures use wrong workflow/node/run/request code. |
| expression preview: a block name containing a secret value stays readable (only values are redacted) | KEEP | Detects: Secret redaction mutates block/project field names instead of values. |
| expression preview: a starting block of a workflow with no trigger reads the run's input (engine computeForced) | KEEP | Detects: Triggerless roots lose input or disconnected triggered nodes receive data. |
| expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped | OPTIMIZE | Detects: Expression cap fails to bound expansion/diagnostics or double-counts repeated parse errors. |
| expression preview: without a block, a queued newest run gives way to the newest with finished blocks | KEEP | Detects: Newest queued run masks usable data from a prior finished run. |

## `apps/daemon/src/workflows/run-store.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7–5.8, §5.9. Stable seam: FileRunStore over actual run directories/events and public wire conversion. Non-test callers and coverage ownership: engine uses fake RunStore in most tests; actual file permissions, cursor semantics, write ordering and containment need this owner. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| create/save: run.json is atomic and 0600, the last save wins, the index follows | KEEP | Detects: Concurrent saves land out of order, permit loose file mode, or leave active index stale. |
| init rebuilds the index from the run directories; an unreadable run.json is skipped | KEEP | Detects: Stale index cache overrides directory authority or unreadable record breaks history. |
| paging: `before` is a run id cursor, newest first; an unknown cursor is a first page | KEEP | Detects: History cursor duplicates/skips rows or fails unknown-cursor fallback. |
| sweep keeps the newest 100 and nothing older than 30 days, preserving active runs | KEEP | Detects: Retention deletes active work, retains excess/ancient runs, or late writes recreate removed data. |
| sweep keeps a run whose temporary project is still there, until the project is deleted | KEEP | Detects: Retention removes the only record of an undeleted temp project. |
| events append as NDJSON; attempt dirs and output files live under the run | KEEP | Detects: Event order changes, path escapes run containment, or whole output loses private mode. |
| deleteForWorkflow removes every run of that workflow only | KEEP | Detects: Deleting one workflow removes another's runs. |
| persistedRunToWire: frozen sub-workflow definitions cross the wire as their revisions only; a run without them has none | KEEP | Detects: Frozen child code leaks over wire instead of only its approved revision. |
| toRunSummary / persistedRunToWire: bookkeeping stripped, outputs cut to the preview | KEEP | Detects: Public run/summary leaks pending state/host path or breaks UTF-8 preview. |
| exists: a recorded run (readable or not) is true; a missing one false; another I/O error throws; deleted and invalid ids are false | KEEP | Detects: Unreadable exists is confused with absence and can duplicate side effects. |

## `apps/daemon/src/workflows/sandbox/env.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6; plugins session-preload configuration contract. Stable seam: environment sent to sandbox process. Non-test callers and coverage ownership: sandbox spawn uses buildSandboxEnv; plugin preload composition is separate from the normal daemon-secret exclusion fixture. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| no preload active: NODE_OPTIONS is the block's own, or absent | KEEP | Detects: Daemon NODE_OPTIONS leaks into a workflow or explicit block options are dropped. |
| a preload active: required alone, or appended after the block's NODE_OPTIONS | REWRITE | Detects: Plugin preload is lost or overwrites block NODE_OPTIONS; literal expected --require bytes replace production-derived oracle. |

## `apps/daemon/src/workflows/sandbox/log-reader.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6–5.7, §7.3. Stable seam: byte-positioned log window and async follow interface against actual files. Non-test callers and coverage ownership: HTTP route owns transport binding while reader owns every UTF-8/secret boundary and abort/liveness interaction. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| windows of any size cut at character boundaries and join to the whole text | KEEP | Detects: Byte cursor splits UTF-8 or drops/duplicates log text. |
| a secret is never split across windows | KEEP | Detects: Log windows expose a whole credential or pieces across boundaries. |
| an offset inside a secret serves its placeholder, never its tail | KEEP | Detects: Caller-chosen offset exposes credential tail. |
| holdTail keeps back a partial character and a possible secret prefix | KEEP | Detects: Live append serves an incomplete character/credential before it can be safely redacted. |
| a missing file reads as empty | KEEP | Detects: Missing attempt log raises instead of serving empty window. |
| yields as the file grows and ends once it is not live and fully read | KEEP | Detects: Streaming loses append data/redaction or never ends after writer exit. |
| an abort ends a live follow | KEEP | Detects: Aborted client remains attached to live log. |

## `apps/daemon/src/workflows/sandbox/redact.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.7. Stable seam: plain-text/deep-value sanitizer. Non-test callers and coverage ownership: engine, titles and log serving call it; other tests do not combine prefix collision, literal regex characters, immutable inputs and value-only recursion. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| text: every value ≥ 4 chars, longest first | KEEP | Detects: Short-token policy or overlapping longest-match protection corrupts redaction. |
| value: deep through arrays and objects, values only | KEEP | Detects: Nested output redaction leaks values, mutates keys, or changes caller input. |
| special regex characters in a value are literal | KEEP | Detects: Regex-like credential is interpreted as a pattern. |

## `apps/daemon/src/workflows/sandbox/sandbox.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.6, §5.8, §5.9. Stable seam: real detached sandbox process, durable result/exit/log and OS process identity. Non-test callers and coverage ownership: createSandboxRunner has production node executors and remote sandbox callers. FakeSandbox cannot prove OS process groups, installed traps, child exit or actual JS module execution. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a return value is the result; log() and console.log reach stdout | CONSOLIDATE | Actual code host loses result/log/context, rejects top-level await, or remains alive after return due to an open interval; surviving owner the first sandbox code result/log case also asserts this contract without repeating a separate fixture. |
| undefined returns as null | KEEP | Detects: Undefined JS result is lost instead of valid JSON null. |
| a throw is a failure with message and stack | KEEP | Detects: Code exception loses its failure/stack. |
| stop() ends the run as stopped, with its reason, even from a promise chain | KEEP | Detects: Code catches stop() and performs work after requested termination. |
| require resolves the project's own node_modules | KEEP | Detects: Project-local dependencies resolve in daemon rather than requested project. |
| a module with top-level await works | CONSOLIDATE | Separate TLA child startup consolidated into existing result/log contract; surviving owner the first sandbox code result/log case also asserts this contract without repeating a separate fixture. |
| a non-serializable return is an error | REWRITE | Detects: Non-JSON result silently succeeds. |
| a return over maxOutputBytes is an error | REWRITE | Detects: Oversized code return exceeds durable result cap. |
| a default export that is not a function is a clear error | REWRITE | Detects: Invalid module export succeeds or cannot report failure. |
| a syntax error is a failure | KEEP | Detects: Unparseable user module is reported successful. |
| an open handle does not hold the attempt | CONSOLIDATE | Separate open-handle child startup consolidated into result/log contract; surviving owner the first sandbox code result/log case also asserts this contract without repeating a separate fixture. |
| stdout, stderr and the exit code | DELETE | Fails unique protection / independent contract: Duplicate real shell stream/exit journeys already owned by integration.test.ts. |
| sh works too, and the cwd is the request's | KEEP | Detects: Requested sh/cwd contract is ignored. |
| each stream is capped with one notice line | KEEP | Detects: Stream bytes exceed 50 MiB cap or truncation duplicates notices. |
| the environment is built, never inherited | KEEP | Detects: Daemon credentials leak or workflow identity env can be spoofed. |
| an invalid env name refuses the spawn | KEEP | Detects: Invalid env identifiers reach process spawn. |
| a missing cwd refuses the spawn | KEEP | Detects: Missing cwd silently runs in daemon/project fallback directory. |
| the runner enforces the deadline itself | KEEP | Detects: Detached runner depends on live daemon to enforce its deadline. |
| a work that ignores SIGTERM is SIGKILLed after the grace | KEEP | Detects: Uncooperative child survives cancellation beyond termination grace. |
| a cancel kills the whole group, grandchildren included | KEEP | Detects: Process-group cancellation leaves grandchildren alive. |
| kill() ends a running attempt | KEEP | Detects: Explicit kill returns while work remains active. |
| a runner killed outright reads as interrupted, and its work is ended | KEEP | Detects: Killed runner leaves orphan work or invents a successful exit. |
| a restarted daemon adopts a running attempt and reads its exit | KEEP | Detects: Restarted runner cannot adopt durable process handle and exit record. |
| isAlive refuses a recycled pid (starttime mismatch) | KEEP | Detects: Recycled pid is treated as the original work and risks signaling unrelated process. |

## `apps/daemon/src/workflows/secrets.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.7. Stable seam: WorkflowSecretsService public names/scope and real private file. Non-test callers and coverage ownership: routes consume names and engine resolves values; filesystem privacy, quarantine and scoped fallback need the real store. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| values are stored 0600 (also after an existing file was looser) and never listed | KEEP | Detects: Secret values reach listing/logs or loose permissions survive rewrite. |
| a workflow's own secret shadows a global one; list shows both scopes; deleteForWorkflow removes its own | KEEP | Detects: Scoped value leaks across workflows or deletion removes global fallback. |
| names and values are validated: 400 SECRET_INVALID | KEEP | Detects: Invalid/oversized credential records are persisted. |
| a foreign-version file is moved aside, without quoting a value | KEEP | Detects: Future-version credential file is overwritten or quoted in diagnostics. |
| an unreadable path makes the store read-only (503) and preserves existing content | KEEP | Detects: Unreadable secret file is replaced by a writable empty store. |

## `apps/daemon/src/workflows/service.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §7.2, §8.1–8.2. Stable seam: WorkflowService CRUD/revision errors, actual stored files and lifecycle broadcasts. Non-test callers and coverage ownership: routes and engine consume service; schema-only tests cannot prove durable tolerant writes, conflict refusal or atomic multi-operation patch. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| create → read back; persisted atomically at 0600; a reload lists it | KEEP | Detects: Create/reload loses definition, private mode, or safe disabled default. |
| tolerant load: rejected entries and unknown keys are written back verbatim and never listed | KEEP | Detects: Save erases unknown fields/rejected/newer records. |
| a corrupt or foreign-version file is moved aside, never overwritten | KEEP | Detects: Corrupt/newer-version definitions file is overwritten. |
| an unreadable path blocks mutation with 503 WORKFLOWS_UNAVAILABLE and preserves content | KEEP | Detects: Unreadable definitions path allows destructive mutation. |
| revisions: +1 on every write, a stale revision is a 409 naming the current one | KEEP | Detects: Stale edits overwrite newer changes. |
| a bad patch op is 400 INVALID_WORKFLOW naming the op, and changes nothing | KEEP | Detects: Later failing patch commits earlier operations. |
| a definition with errors saves disabled, but can never be (or stay) enabled | KEEP | Detects: Invalid workflow is enabled or remains enabled after bad edit. |
| a schema-invalid replace is refused whole | KEEP | Detects: Schema-invalid replacement partially mutates definition. |
| limits: the workflow count and the definition size are LIMIT_EXCEEDED | KEEP | Detects: Workflow/definition bounds are bypassed. |
| duplicate: new ids for the workflow, blocks and connections; disabled; pins follow | KEEP | Detects: Duplicate retains live IDs/enabled state or loses pin-edge bindings. |
| events: upserted after every write, deleted after a delete; the bridge publishes summaries | KEEP | Detects: Definition events lose current summaries, revisions, or deletion identity. |

## `apps/daemon/src/workflows/services.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.4, §5.4, §5.10–5.11. Stable seam: ProjectOps daemon HTTP, notifier delivery, slot acquisition and sweeper public effects. Non-test callers and coverage ownership: factory/engine use these production services; engine fakes do not own project containment, actual route requests, push policy or retention of user-used tabs. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| resolveExisting accepts exactly <workspacesDir>/<ws>/<project> | KEEP | Detects: Workflow project escapes workspace/project containment or selects a subdirectory. |
| createTemp and deleteProject go through the daemon's routes | KEEP | Detects: Temporary clone bypasses daemon routes, unattended policy, or missing-project delete idempotency. |
| a refused create names the daemon's code | KEEP | Detects: Project failure drops daemon error code or silently proceeds detached. |
| gitStatusShort renders porcelain-style lines within the byte cap | KEEP | Detects: Handoff working-tree text loses staged/unstaged/rename meaning or byte bound. |
| pushes per settings.notify, debounced per workflow and kind | KEEP | Detects: Notification settings/debounce spam failures or notify children/test/cancelled runs. |
| FIFO past the cap; aborted waiters leave the queue; force skips it | KEEP | Detects: Concurrency slots lose FIFO order, hold aborted waiter, or release twice. |
| deletes temp projects past deleteAfter and closes old workflow tabs nobody wrote in | KEEP | Detects: Cleanup deletes user-used/live/new tabs or leaks due temporary projects. |
| runs hourly on the injected clock and stops cleanly | KEEP | Detects: Hourly cleanup stops scheduling or continues after stop. |

## `apps/daemon/src/workflows/state-store.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.4, §6. Stable seam: WorkflowStateStore durable cursor updates against actual files. Non-test callers and coverage ownership: scheduler/poller/cooldowns consume this store; their in-memory fixtures cannot detect coalesced-write loss or filesystem recovery. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a missing file loads empty, silently; updates persist atomically at 0600 | KEEP | Detects: Missing state cannot boot or updates fail private durable reload. |
| get() is a snapshot | DELETE | Fails unique protection / independent contract: Defensive clone-shape test has no independent workflow contract and mutation is absent from production callers. |
| a corrupt file starts empty, is moved aside and logged — never thrown | KEEP | Detects: Corrupt cursor file prevents boot or is destroyed without backup. |
| bad entries are dropped by the tolerant parse, good ones kept | KEEP | Detects: Malformed cache entry prevents valid cursor recovery. |
| an unreadable path starts empty and logs | KEEP | Detects: Unreadable cursor state prevents boot. |
| concurrent updates are immediately visible and all become durable | KEEP | Detects: Concurrent updates lose another workflow's cursor/cooldown. |
| a throwing mutator changes nothing; a failed write retains changes for the next write | KEEP | Detects: Throwing mutator partially applies or failed-write state is lost on recovery. |

## `apps/daemon/src/workflows/storage-fixes.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §3.1, §5.7–5.8; AGENTS.md tolerant persistence and prototype containment. Stable seam: actual schemas/stores with independently authored newer/corrupt records. Non-test callers and coverage ownership: owns nested forward compatibility, credential-map safety and real index-before-run-write crash ordering absent from ordinary reload cases. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a newer build's nested fields survive this build's parse (a save never erases them) | KEEP | Detects: Read/save under older build erases newer nested definition fields. |
| block and connection ids that could key Object.prototype are refused, by the schema and by validation | KEEP | Detects: Prototype-shaped node/edge IDs enter persisted graph maps. |
| the secrets file keeps what this build cannot read, verbatim, across a write | KEEP | Detects: Credential save destroys future metadata or rejected records. |
| the secrets store never indexes past its own maps | KEEP | Detects: Prototype map lookup mutates inherited object members. |
| an unfinished run remains recoverable when the index lands before its pending save | KEEP | Detects: Index-first write race makes unfinished run unrecoverable after restart. |

## `apps/daemon/src/workflows/summary.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.11, §7.1, §8.1. Stable seam: wire WorkflowSummary.notify consumed by open clients. Non-test callers and coverage ownership: buildWorkflowSummary serves routes/engine/events; notifier tests protect delivery policy but cannot detect omission of public settings. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| the summary carries settings.notify so open clients honour it | KEEP | Detects: Wire summary omits notification preferences and already-open clients apply wrong policy. |

## `apps/daemon/src/workflows/triggers/git-events.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2. Stable seam: normalized provider listings/ref glob/dedup event decisions. Non-test callers and coverage ownership: poller consumes these decisions; adversarial transitions, old state and out-of-order PR pages are absent from ordinary polling scenarios. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| glob: anchored, `*` stops at `/`, `**` crosses it, `?` is one character | KEEP | Detects: Ref glob accidentally matches nested/unanchored branches or pathological pattern hangs. |
| sameSha compares an abbreviation (Bitbucket Cloud's 12 hex) as a prefix | KEEP | Detects: Abbreviated Bitbucket ID is treated as changed commit or arbitrary tiny prefix equated. |
| pushFired keeps the newest 1000 | KEEP | Detects: Dedup history drops newest event or grows beyond documented ring. |
| pull requests: an old PR scrolling into the page is recorded silently; one opened and merged between polls yields both | KEEP | Detects: Older PR scrolling into page triggers work or merged-between-polls PR loses opened transition. |
| pull requests: a lower-numbered new PR walked after a higher one still opens (the mark is the page's base) | KEEP | Detects: Listing order drops lower-numbered new PR after observing higher number. |
| pull requests: dedup keys name the transition — a force-push rollback and a second close after a reopen fire | KEEP | Detects: Force-push rollback/reopen-close transition is incorrectly deduplicated, including legacy state. |
| push: a force-push rollback (A..B then B..A) is a new dedup key, not a repeat of the first push to A | KEEP | Detects: Rollback to previous commit is lost against a pre-upgrade dedup key. |

## `apps/daemon/src/workflows/triggers/git-poller.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.2. Stable seam: clock-driven remote request boundary, persisted cursors and emitted trigger payloads. Non-test callers and coverage ownership: daemon-wiring calls poller; remote fake emits independent provider state but real poller owns dedup, cadence, ETags, backoff, filtering and lifecycle. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| push: the first poll only baselines; a later push fires once with previousSha..sha | KEEP | Detects: First poll triggers old work or unchanged head repeatedly fires. |
| push: branch globs; a new matching branch fires with no previousSha; deleted branches are ignored | KEEP | Detects: Branch matching misses new branch or fires on unrelated/deleted refs. |
| push: branches [] watches the default branch, read only when unknown and every 10th poll | KEEP | Detects: Default branch change keeps polling old branch or causes baseline burst. |
| tag: one run per new matching tag (version order), at most 10 per poll, the rest skipped; moved tags ignored | KEEP | Detects: Tag polling repeats/misorders/overfires past per-poll cap or re-fires moved tag. |
| release: drafts never, pre-releases only when asked for | KEEP | Detects: Draft/prerelease policy or promotion dedup is ignored. |
| release on a provider without releases shows an error and fires nothing | KEEP | Detects: Unsupported release provider silently appears healthy. |
| pull_request: opened, updated, merged and closed; the base filter; payload and text | KEEP | Detects: PR state transitions/base filters or event payload fields are wrong. |
| pull_request: Bitbucket Cloud's 12-char head sha compares consistently, first polls within 60 s and then every 180 s | KEEP | Detects: Bitbucket polling quota interval or abbreviated-sha stability regresses. |
| ETags: a baselined listing sends its ETag; a 304 fires nothing and still counts as a poll | KEEP | Detects: Conditional listing omits ETag or changed page never fires new PR. |
| dedup survives a restart: a new poller over the same state never re-fires, and still fires what is new | KEEP | Detects: Restart/dedup ring replays already-fired push. |
| a changed filter or repo re-baselines; a disabled or deleted trigger is pruned | KEEP | Detects: Edited repo/filter runs stale cursor or disabled trigger continues polling. |
| two triggers on one repo share one poller (one ls-remote per poll); another account is another poller | KEEP | Detects: Equivalent URL identities duplicate remote traffic or different account shares credentials. |
| failures back off exponentially to 15 min, show on the trigger, honour Retry-After and never fire | KEEP | Detects: Provider failure causes retry storm, ignores Retry-After, or loses missed work on recovery. |
| a PR listing without the scope says which scope is missing; push triggers on the same repo keep polling | KEEP | Detects: PR scope error hides remedy or stops independent push watcher. |
| an unresolvable repository shows why and polls nothing; stop() leaves no timer | KEEP | Detects: Invalid/unresolved repo reaches remote process. |
| stop() mid-poll commits and fires nothing | KEEP | Detects: Late stopped poll commits state or fires work. |
| a token typed as the URL's user never reaches the poll, the payload or the error text | KEEP | Detects: Token typed in URL reaches remote/payload/provider diagnostic. |
| ETags: a new ETag is written in the same state update as the cursors that judged its page | KEEP | Detects: Committed ETag skips a page whose event cursors were never saved. |
| the pulls poll names the PRs its triggers last saw open (so a DC listing can look them up) | KEEP | Detects: DC closed-PR followup omits previously open numbers. |
| pull_request: an abbreviated head (Bitbucket Cloud) is completed from the branch heads before it fires | KEEP | Detects: Abbreviated PR event launches clone without resolvable full commit. |

## `apps/daemon/src/workflows/triggers/repo-resolve.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §5.10, §6.2. Stable seam: repository/account selection from project layout and independent metadata. Non-test callers and coverage ownership: poller/daemon-wiring consume resolver; FakeRemote-based tests inject a byUrl resolver and cannot protect origin/workspace identity mapping. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| project repositories reject paths outside the workspace project layout | KEEP | Detects: Repository discovery reads outside the configured workspace/project layout. |
| repo kind url: as given, with its account or none | KEEP | Detects: Explicit remote/account is changed or missing public account invented. |
| repo kind project: an existing project's origin + its workspace's account | KEEP | Detects: Project origin is polled under wrong workspace git identity. |
| repo kind project on a temp workflow: its clone URL + that workspace's account; an empty temp project has none | KEEP | Detects: Temporary empty project creates bogus repo or clone loses workspace account. |
| a project whose origin appears later is picked up by the periodic re-resolve | KEEP | Detects: Adding origin after startup never starts monitoring. |

## `apps/daemon/src/workflows/triggers/scheduler.test.ts`

Independent source: [Workflow design](../../superpowers/specs/2026-09-28-automated-workflows-design.md) §6.1, §5.8. Stable seam: clock-driven trigger fire/public triggerState plus real cursor persistence. Non-test callers and coverage ownership: daemon-wiring calls scheduler; end-to-end only proves ordinary scheduling and cannot detect outage grace, edit rearming or write failure ordering. The retained assertions use independently authored inputs and literal expected status, data, timestamps, error codes, bytes or externally observed effects; none computes the expected outcome by invoking the owner. These semantic interfaces survive internal renames/restructuring. Each retained row below names a distinct caller-visible failure that the adjacent or higher-level coverage does not exercise; deletion risk is the loss of that listed fixture, not generic line coverage. Validation: daemon test runner on this file (and its listed surviving owner for deleted scenarios).

| Exact baseline declaration | Disposition | Specific failure / evidence |
| --- | --- | --- |
| a new trigger is scheduled from now and fires at its time, once, with the schedule payload | KEEP | Detects: New schedule fires early/twice or publishes wrong scheduled event time. |
| the cursor is persisted before the fire | KEEP | Detects: Trigger fires before cursor reaches disk and can repeat after restart. |
| the timer never sleeps more than 60 s, and a clock jump is noticed within a minute | KEEP | Detects: Host wake/clock jump leaves missed schedule dormant until old timeout. |
| boot: a run missed by less than the grace fires once; beyond it one missed stub, never a burst | KEEP | Detects: Long outage creates catch-up storm or short outage loses permitted fire. |
| edits rearm: a changed cron or zone recomputes from now; disable prunes, re-enable never fires a stale time; delete prunes | KEEP | Detects: Cron/timezone edit, disable/re-enable, or deletion reuses stale cursor. |
| an unrelated edit keeps the cursor; a disabled node is not scheduled; an invalid cron warns once and never fires | KEEP | Detects: Unrelated edit rearms cursor or invalid/disabled node fires. |
| a failed cursor write skips that one run but never stops the timer | KEEP | Detects: Failed cursor save stops scheduler forever or permits unrecorded fire. |
| a failed write while reconciling still arms the timer | KEEP | Detects: Initial reconciliation disk failure prevents recovered timer from firing. |

## Expanded durable agent restart cases

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

The two expanded secret cases stop at `creating` and `sending`: each checks all first/second-executor persisted states contain no credential value and exactly one posted prompt contains the literal current credential. Both are KEEP because initial creation and pending turn payload have different persisted representations.

## Root validation evidence

This record supersedes the earlier pending validation note. The root agent ran the retained public-route case with `TSX_DISABLE_CACHE=1` from `apps/daemon`:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped' src/workflows/routes.test.ts
```

It passed: one test, zero failures, exit 0; wall time **0.869660 s**, named case **103.025061 ms**. Evidence: `/tmp/orquester-test-audit/workflow-budget-positive.log` and `/tmp/orquester-test-audit/root-regression-probes.json`.

The root then ran the same retained assertion with the expression output cap disabled inside that isolated Node process:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/workflows-no-expression-cap.mjs --test --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=expression preview: rendering stops at the byte cap and parse errors are deduplicated and capped' src/workflows/routes.test.ts
```

The expected exit was 1 and the actual exit was 1; wall time **0.761945 s**. The route still passed its HTTP 200 assertion, then the existing assertion at `routes.test.ts:757` failed with `ERR_ASSERTION`: `result.truncated` was `undefined`, expected `true`. The preloader used only `Reflect.set(EXPRESSION_PREVIEW_LIMITS, 'maxRenderedBytes', Number.MAX_SAFE_INTEGER)` before importing the route owner. It changed no source file or live daemon state. This proves the reduced 1,024-expression fixture still exceeds the real public-route output cap and detects removal of that cap for the intended truncation reason. Evidence: `/tmp/orquester-test-audit/workflow-budget-mutant.log` and the same probe JSON.

The root also ran `pnpm check:changed --no-cache`. Its typecheck passed, and the affected workflow cases passed. The daemon test group had three failures outside workflows, so this was not an overall passing repository gate; their resolution belongs to the root's integration report. The gate log records the optimized expression case at **396.454157 ms**, timezone-until at **304.841762 ms**, and the consolidated real sandbox module case passing. Evidence: `/tmp/orquester-test-audit/check-changed.log` and `/tmp/orquester-test-audit/check-changed.time`.

The original full-run expression observation was 10,515.795 ms; the final changed-gate and isolated observations above use different suite/load conditions. They are useful case-level evidence, not a controlled whole-scope wall-clock comparison or a measured CI speedup. Whole-suite baseline/final measurements and remaining repository gates are recorded by the root. No additional tests were run by this scope agent for this evidence update.
