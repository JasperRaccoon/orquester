# Agent-host ingestion test cleanup

Status: cleanup implemented; dispositions were recorded before pruning. All eight original test files and all 202 original test declarations (236 expanded cases) were read with their production owners. Parameterized declarations list their title template; each input arm was examined.

No live daemon, provider process, network service, or deployment is started.

Independent sources: [agent-chat GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [agent goals design](../superpowers/specs/2026-09-24-agent-goals-design.md), [Codex fixture provenance](../../apps/daemon/test/fixtures/codex/README.md), [Claude fixture provenance](../../apps/daemon/test/fixtures/claude/README.md), and shared API/runtime contracts.

Parameterized cases: request kinds cover command_execution_approval, exec_command_approval, file_read_approval, file_change_approval, apply_patch_approval, mcp_elicitation_approval, permission_approval, dynamic_tool_call, auth_tokens_refresh, and unknown; tool kinds cover command_execution, file_change, mcp_tool_call, dynamic_tool_call, collab_agent_tool_call, web_search, and image_view; omitted kinds cover user_message, assistant_message, reasoning, plan, review_entered, review_exited, context_compaction, error, and unknown. Task linkage covers started, updated, completed. Reasoning kinds cover raw/text and summary; turnless owned blocks cover assistant and reasoning. Phase-word variants cover `commentary` and `Final_Answer` on streamed live, completion-only live, and history paths. Stop variants cover interrupted/cancelled turn.completed and turn.aborted. Relaunch variants cover OpenCode and Codex.

## Shared six-bar justification

Every KEEP/REWRITE table row combines its exact contract/failure with the corresponding file rationale below: **1** independent design/protocol/regression source; **2** emitted/folded state or data is the observable failure, not call shape; **3** literal input/output or raw capture oracle can disagree with implementation; **4** the stated public service, persisted-protocol projection, reducer, or parser seam; **5** no source inspection, private map access, allocation assertion, markup or layout dependency; **6** the lowest relevant owning transformation, with generic duplicated layers explicitly deleted. Stronger owners for deletions are named per row. For retained composed tests, lower mapper tests cannot detect the identified disagreement between producer and consumer.

Risks: test-only pruning should not change runtime behavior. Private export removal is safe only after repository-wide caller search; taskLinkageActivityFields retains its export because leftover-work is a production caller. No fixture is removed while any adapter replay still consumes it.

Focused validation (from repository root): `node --import tsx --import ./scripts/test/assert-ok.mjs --import ./apps/daemon/test/quiet-mock-timers.mjs --test apps/daemon/src/agent-host/ingestion/*.test.ts`. Root agent runs repository `pnpm check` and `pnpm test`.

## apps/daemon/src/agent-host/ingestion/activities.test.ts

**Independent source (bar 1):** GUI design §§4.2/5.1/7.6; agent-goals design §4.3; public RuntimeEvent and ThreadActivityItem persisted protocol.

**Stable seam, production callers, and refactor independence (bars 4–5):** runtimeEventToActivities, the runtime-to-persisted activity mapper used by createIngestion; taskLinkageActivityFields also serves orchestration/leftover-work.ts.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Distinct payload/status/identity mappings belong to this transformation; fold-wide repetitions are removed. Expected protocol enums and preservation of input values are not calculated by invoking the implementation.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| agentKind is stamped once, here | DELETE | Only calls a forwarding helper with classifier inputs; the public classifyTaskAgentKind matrix in packages/api/src/agent-chat/contracts.test.ts owns classification, and task linkage rows plus the retained background-shell integration own stamping. |
| task.completed is titled from the remembered description | DELETE | Supplies the title through a test option and reads it back; index.test.ts remembers a task description through real start/completion events. |
| every hidden progress row of a thread shares ONE stable id — the latest replaces it in place | DELETE | Exact ID formatting repeats the stronger fold-integration goal replacement regression, which checks the current goal and preserved chronological position. |

## apps/daemon/src/agent-host/ingestion/assistant-phase.test.ts

**Independent source (bar 1):** Codex fixture README observation 18 and captures; GUI design §§5.1/7.3; D3/D4 documented dropped-text/abandoned-item regressions.

**Stable seam, production callers, and refactor independence (bars 4–5):** real Codex normalizer/history → ingestion → public fold; fixture bytes are the independent oracle.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The normalizer does not generate expectations: recorded raw frame text/phase and literal regression text do. Corpus replay includes both presence and content checks. Synthetic cases cover absent deltas, phase-word text, abandoned/same/anonymous items, or owner ordering absent from the captures.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| files commentary as commentary and the answer as the answer, both texts intact | DELETE | the retained phase-word Codex history regression proves both phase mappings plus exact text preservation on the harder previously lost input; lower Codex history tests own production projection. |
| 04: the commentary narration and the answer, exactly as recorded | DELETE | The all-captures replay includes fixture 04 and checks every assistant message against independently captured text and phase. |
| (b) fixture 05: the interrupted agentMessage and its re-sample are two bubbles, each its own text | DELETE | The all-captures replay includes fixture 05 with the same abandoned-item text oracle; the synthetic final-answer variant separately protects answer classification. |

## apps/daemon/src/agent-host/ingestion/coalesce.test.ts

**Independent source (bar 1):** GUI design §5.6 snapshot coalescing/slimming and legacy persisted activity compatibility.

**Stable seam, production callers, and refactor independence (bars 4–5):** projectSnapshotActivities and slimActivityEvent used by orchestration/orchestrator.ts and server/stream.ts; implementation helpers have no external production callers.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Projection output IDs/kept rows and byte bounds are caller-visible; no map/key helper API remains in tests. Cases cover distinct temporal order, turn boundary, legacy identity, malformed usage, and outbound truncation paths.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| reads a nested data.toolUseId too | REWRITE | Replace private identity-helper assertions with nested-ID snapshot projection; the caller-visible failure is losing or retaining the wrong persisted tool update. |
| drops an update a LATER completion in the same turn supersedes | REWRITE | Call the production read projection, preserving the independently specified earlier-update drop and later-update survival. |
| does not drop across turns | REWRITE | Call the production read projection; a completion in another turn must not erase an update that a rewind still needs. |
| falls back to the itemType/label/detail triple, normalising a trailing 'complete' | REWRITE | Call the production read projection for legacy rows without stable call IDs; duplicated finished tool updates remain visible if matching regresses. |
| keeps only the newest resolvable row per turn | REWRITE | Call the production read projection; stale usage must not replace the latest valid per-turn context reading. |
| a malformed row passes through and never shadows a valid earlier one | REWRITE | Call the production read projection; malformed usage must not hide the last usable context measurement. |

## apps/daemon/src/agent-host/ingestion/fold-integration.test.ts

**Independent source (bar 1):** GUI design §§5.1/7.6; agent-goals §4.3; Claude fixture README observations 18/22; persisted fold/roster/transcript contracts.

**Stable seam, production callers, and refactor independence (bars 4–5):** real ingestion → public fold/roster/transcript; retained composed regressions need the producing and consuming protocols together.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Retained cases protect specific cross-protocol state: settled completed/interrupted turns, replacement-row goals/tasks, legacy badge preservation, usage/cost, relaunch after eviction, background ownership, or synthetic-turn rewind. Generic mapper-plus-fold repetitions are removed.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| streamed deltas concatenate into one settled assistant message | DELETE | Repeats index.test.ts delta/empty-completion wire contract and the retained phase corpus real-fold text checks. |
| a Claude usage limit's reason and reset reach the folded activity (workflows §5.4) | DELETE | The mapper account-failure reason/reset cases own ingestion; Claude normalizer tests own conversion of rate-limit frames, and the fold copies activity payloads without interpreting them. |
| reasoning folds as a sibling message, never into the assistant one | DELETE | The retained reasoning/assistant flush and parent/subagent isolation cases own distinct message roles and content. |
| an interrupted session settles the turn as interrupted | DELETE | The retained E3/R5 parameterized Stop regression includes turn.aborted and both turn.completed interruption states with stronger error-state assertions. |
| an approval opens and closes in the pending set the fold derives | DELETE | Repeats activity mapper request-open/request-resolution protocol assertions and API pending-request derivation tests; no new ingestion-specific transition. |
| a tool_user_input request never reaches the pending set | DELETE | The activity mapper tests both request arms, including withdrawal, at the owning transformation seam. |
| a question opens as a pending user input and a resolution closes it | DELETE | Activity mapper question emission plus API pending-request tests own the producer and consumer contracts. |
| the roster rebuilds from the linkage ingestion stamps on EVERY task row | DELETE | Despite its title, does not evict any start row; linkage mapping is exhaustively checked at the mapper, and API roster/retention tests own rebuilding. |
| a task stopped by a dying session folds to interrupted | DELETE | packages/api/src/agent-chat/roster.test.ts directly owns stopped-to-interrupted mapping; retained mapper task lifecycle/linkage checks own emitted status. No ingestion-specific state is added here. |
| the tool lifecycle folds into rows the timeline can group | DELETE | Reasserts mapper tool lifecycle kind, ID and status; fold does not transform these activity fields. |
| the compaction marker keeps its token counts through the fold | DELETE | Exact duplicate of the mapper compaction token-count case across a fold that preserves the payload. |
| the §7.3 badge fields survive the fold onto the message item | DELETE | Raw/summary metadata is covered by index.test.ts and answer/commentary metadata through the stronger phase capture replay. |
| the provider's title reaches the head | DELETE | Duplicates index.test.ts automatic-title rule and the API thread metadata fold contract. |
| ${shape.adapter}: a relaunch reads running (run 2), then its new result | DELETE | Hand-built adapter-shaped rows repeat packages/api/src/agent-chat/roster.test.ts new-launch/reactivation contracts. Retained relaunch-after-retention case adds the actual composed eviction failure. |
| Claude: the notification's `(exit code N)` is the roster row's exit code | DELETE | Normalizer exit-code parsing, mapper exit-code propagation (including negative signal values), and API roster exit-code reading have lower owners. |
| 07: every output row of an agent-owned call carries the call's agentId | DELETE | The retained background-agent after-parent-result regression checks every lifecycle/output row owner for both turned and turnless calls, plus settled message text. |

## apps/daemon/src/agent-host/ingestion/history.test.ts

**Independent source (bar 1):** GUI design §4.5 resume/history and §5.1; adapters projectHistory protocol and HISTORICAL_RAW_SOURCE contract.

**Stable seam, production callers, and refactor independence (bars 4–5):** RuntimeEvent with the historical marker → ingestion and real fold; adapter-native projectHistory mapping is owned by each adapter history test.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Replayed messages, interrupted/partial history, user deduplication, full-text preference, and isolation from live state are independent caller contracts; generic replay cases exercise the public runtime protocol; native transcript smoke scenarios are deleted in favor of their adapter owners.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| claude: the user's own prompts survive the replay | DELETE | lower adapter project-history.test.ts capture replay owns native text/source conversion; retained generic historical full-text and user-deduplication cases own ingestion. This repeats that path with weaker nonempty assistant checking. |
| claude: a replayed compaction summary is a marker row, not a giant user bubble | DELETE | lower Claude project-history.test.ts explicitly checks marker summary and exclusion from user messages; activities.test.ts owns compaction summary propagation, and generic historical activity tests own replay dispatch. |
| codex: user and assistant items both become messages | DELETE | lower Codex history.test.ts owns captured user/assistant text and historical tagging; retained phase-word history regression and generic historical message cases own ingestion without repeating the adapter smoke scenario. |
| opencode: a user text part becomes the user's message | DELETE | lower OpenCode history.test.ts fixture-10 exact user/assistant text contract and retained generic historical text tests are stronger than another handwritten transcript replay. |
| grok: every replayed event carries the shared historical source | DELETE | lower Grok history.test.ts explicitly checks capture text and every historical marker; retained generic ingestion history isolation checks real liveness/session state and forbidden checkpoint calls. |
| history feeds neither liveness nor the checkpoint service | REWRITE | Replace swallowed throwing checkpoint hook with a recorded invocation and a valid checkpoint response; assert no call occurred and query real liveness state instead of mock call history. The original negative could pass when the forbidden call threw and was swallowed. |

## apps/daemon/src/agent-host/ingestion/index.test.ts

**Independent source (bar 1):** GUI design §§3.1/5.1/5.4/5.6/7.3/10; public Ingestion service and AppendableDomainEvent protocol.

**Stable seam, production callers, and refactor independence (bars 4–5):** createIngestion ingest/drain/flush/forget and emitted domain events; production construction in orchestration/orchestrator.ts.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Exact event text, order, persisted identifiers, lifecycle state, controlled time bounds, and explicit no-event cases are independent oracles. Retained timing counts are specified write budgets, not geometry. State setup exercises real ingestion; RecordingSink only records output.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| mints assistant:<itemId> for the first segment of a turn | DELETE | Repeated by the delta/completion wire-contract test and phase corpus replay, both of which require the same persisted identity while checking real content. |
| a second assistant block in one turn gets :segment:1 | DELETE | Does not exercise the segment suffix its title promises; the phase corpus and abandoned-item regressions prove distinct provider items remain separate messages. |
| a completion with nothing buffered and nothing projected writes no message at all | DELETE | The retained Q1 #9 settled-turn then reused-ID regression checks the same no-ghost-message contract after a stronger state transition. |
| an item.completed snapshot stands in for deltas that never arrived | DELETE | The phase-word completion fallback cases in assistant-phase.test.ts exercise the same contract through the real fold, including the historic text-loss input. |
| an item.completed snapshot NEVER duplicates text that already streamed | DELETE | The phase-word streamed completion cases and prompt-closed regression check text exactly once through the real fold. |
| a whole-block reasoning snapshot with no stream gets its own snapshot id | DELETE | Only checks repeated generated IDs; the retained whole-block reasoning snapshot test checks actual preserved text and absence of invented stream metadata. |
| a token-by-token provider becomes a handful of events per second | DELETE | Repeats the exact 250 ms hold/pacing contracts with a loose count and partial text oracle; deterministic boundary tests and the wire delta test are stronger. |
| Codex's phase-marker detail is metadata, NOT the message text | DELETE | The phase corpus replay rejects invented bubbles and checks every actual bubble against provider capture text. |
| commentary on one item does not leak onto the turn's next message | DELETE | The phase corpus and abandoned-commentary/final-answer regression assert the same ownership of phase with independently recorded provider frames. |
| forwards task.* and clears on session.exited | REWRITE | Replace mock collaborator-call inventory with the real liveness registry: start exposes live work, completion removes it, and exit clears unfinished work. |
| Q1 #9: forget() releases a thread, drops its buffers and clears liveness | REWRITE | Keep the caller-visible contract that draining after deletion never appends buffered text; remove the mock clear-call assertion, which could fail after an equivalent liveness implementation change. Real exit/liveness state is checked by the rewritten registry integration. |
| keeps threads independent | DELETE | Sequential writes only verify that the sink received the input thread IDs; they do not test independence or blocked concurrent lanes. The retained event ordering test owns append order; host goal-hold tests exercise multiple threads with distinct live work. This sequential call inventory did not protect the claimed independence. |
| frees a task title once the task it names has completed | DELETE | Infers a private map deletion from a repeated completion losing its title, which is not a caller contract or a memory measurement. The retained real start/completion test owns title preservation. |
| a turnless completion settles only the message its own deltas opened | REWRITE | Open the unrelated message BEFORE the unrelated completion; the original ordering could pass even if a completion closed all currently open messages. |

## apps/daemon/src/agent-host/ingestion/session-status.test.ts

**Independent source (bar 1):** GUI design §§3.1/5.1 session/turn lifecycle; AGENTS.md resume cursor preservation.

**Stable seam, production callers, and refactor independence (bars 4–5):** nextSessionState runtime-to-domain reducer consumed by createIngestion, independent of queue/buffer internals.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The state machine can independently fail by dropping resume identity, leaving dead work active, misclassifying errors, retaining stale errors, or resetting an active turn on a delayed provider start. Each case covers one such lifecycle failure.

## apps/daemon/src/agent-host/ingestion/text-boundary.test.ts

**Independent source (bar 1):** GUI design §5.6 markdown flush safety; CommonMark fenced blocks, list starts, and ASCII blank-line semantics.

**Stable seam, production callers, and refactor independence (bars 4–5):** splitBufferedText markdown parser consumed by DeltaBufferSet; parser grammar cases are below timing/batching integration.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The parser can incorrectly close an info-bearing fence, miss a list-indented fence, flush a nonblank no-break-space paragraph, or hold tight list items indefinitely. Literal markdown examples supply the grammar oracle.

## Production seams and support

Completed: coalesce tests now enter through `projectSnapshotActivities`; removed unused external exports for `stableToolCallId`, `dropStaleContextWindowActivities`, `dropSupersededToolUpdatedActivities`, and `slimActivity`. Their runtime implementations are unchanged. Kept `taskLinkageActivityFields` exported for `orchestration/leftover-work.ts`. Removed unused imports, empty suites, the obsolete relaunch expected-result field, the fixture-only lifecycle set, and the fold-integration clock-advance/timer-mock setup. Shared fixtures and test-harness support retain adapter, store, MCP, and ingestion callers; no exclusively unused fixture remains. Removing the last call-shape assertion made `RecordingLiveness.observed` and `.cleared` unused across the repository; those dead recorders are removed, leaving the minimal registry stub required by surviving callers.

Disposition totals: 38 DELETE, 10 REWRITE, 154 KEEP declarations. Two rewritten negative tests now detect forbidden historical checkpoint invocation and an unrelated completion closing an already-open turnless message. The liveness rewrite observes live work through the real registry rather than its collaborator call shape.

## Validation and completion

- Baseline focused suite: **236/236 passed** (`/tmp/host-ingestion-baseline.tap`). No baseline product failure was deleted.
- First post-prune full ingestion suite: **204/204 passed** (`/tmp/host-ingestion-final.tap`), using the documented command with `--test-concurrency=1`.
- After cross-owner duplicate review, the three affected files (`history`, `assistant-phase`, `fold-integration`) were rerun: **42/42 passed** (`/tmp/host-ingestion-revised.tap`). Combined with the unchanged already-passing files, all **197 retained expanded cases** are validated.
- Daemon typecheck: first attempt raced another agent deleting `agent-profile/adapters/grok/hooks.test.ts` and failed with TS6053 for that disappearing file; final rerun reached two cross-scope diagnostics only: `agent-profile/service.test.ts:595` TS2339 (`agent` on `never`) and `workflows/engine.test.ts:585` TS7022 (`waiting` initializer). Both were reported to the root agent; the final repository gate runs after those owners finish.
- Final removal of the private forget/clear-call assertion: targeted regression **1/1 passed** (`/tmp/host-ingestion-forget.tap`; other 69 cases were intentionally skipped by the name filter).
- `git diff --check` passed; final scope diff reviewed. Runtime edits only remove unused exports. Test/support LOC decreased by **1,078 lines**; repository-wide gates and commit/push belong to the root agent.
