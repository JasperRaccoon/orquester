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
| ${requestType} -> ${expected ?? "unmapped"} | KEEP | Contract/failure: ${requestType} -> ${expected ?? "unmapped"}. A violation changes the emitted or folded caller-visible data/state described by this case. |
| request.opened keeps BOTH the canonical kind and the raw requestType | KEEP | Contract/failure: request.opened keeps BOTH the canonical kind and the raw requestType. A violation changes the emitted or folded caller-visible data/state described by this case. |
| tool_user_input is dropped from BOTH request arms — it is a question, not an approval | KEEP | Contract/failure: tool_user_input is dropped from BOTH request arms — it is a question, not an approval. A violation changes the emitted or folded caller-visible data/state described by this case. |
| request.resolved carries the decision | KEEP | Contract/failure: request.resolved carries the decision. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an unmapped request type still produces a row, with no requestKind | KEEP | Contract/failure: an unmapped request type still produces a row, with no requestKind. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an approval: one 'Request cancelled' row, on the turn its card rode | KEEP | Contract/failure: an approval: one 'Request cancelled' row, on the turn its card rode. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a question: one 'Question cancelled' row, turnless when its card was | KEEP | Contract/failure: a question: one 'Question cancelled' row, turnless when its card was. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a withdrawn tool_user_input resolution is still no row: a question closes by its own event | KEEP | Contract/failure: a withdrawn tool_user_input resolution is still no row: a question closes by its own event. A violation changes the emitted or folded caller-visible data/state described by this case. |
| ${itemType} produces tool.started / tool.updated / tool.completed | KEEP | Contract/failure: ${itemType} produces tool.started / tool.updated / tool.completed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| ${itemType} is dropped from the activity path | KEEP | Contract/failure: ${itemType} is dropped from the activity path. A violation changes the emitted or folded caller-visible data/state described by this case. |
| toolUseId is stable across a call's whole lifecycle | KEEP | Contract/failure: toolUseId is stable across a call's whole lifecycle. A violation changes the emitted or folded caller-visible data/state described by this case. |
| agentId, parentToolUseId and status are promoted out of the payload | KEEP | Contract/failure: agentId, parentToolUseId and status are promoted out of the payload. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an item whose adapter stored only a head of its output says so on the row (`truncated`, §5.6) | KEEP | Contract/failure: an item whose adapter stored only a head of its output says so on the row (`truncated`, §5.6). A violation changes the emitted or folded caller-visible data/state described by this case. |
| thread.token-usage.updated becomes context-window.updated | KEEP | Contract/failure: thread.token-usage.updated becomes context-window.updated. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a negative usedTokens is dropped | KEEP | Contract/failure: a negative usedTokens is dropped. A violation changes the emitted or folded caller-visible data/state described by this case. |
| only the compacted thread state produces a row, and it carries the token counts | KEEP | Contract/failure: only the compacted thread state produces a row, and it carries the token counts. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the compaction PHASE is a row too, so a /compact turn is not a blank 'Working' | KEEP | Contract/failure: the compaction PHASE is a row too, so a /compact turn is not a blank 'Working'. A violation changes the emitted or folded caller-visible data/state described by this case. |
| carries the provider's summary, whole, so the marker can reveal it | KEEP | Contract/failure: carries the provider's summary, whole, so the marker can reveal it. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a failed compaction is an error row carrying the provider's own reason | KEEP | Contract/failure: a failed compaction is an error row carrying the provider's own reason. A violation changes the emitted or folded caller-visible data/state described by this case. |
| agentKind is stamped once, here | DELETE | Only calls a forwarding helper with classifier inputs; the public classifyTaskAgentKind matrix in packages/api/src/agent-chat/contracts.test.ts owns classification, and task linkage rows plus the retained background-shell integration own stamping. |
| ${type} carries the whole linkage bundle | KEEP | Contract/failure: ${type} carries the whole linkage bundle. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.started keeps an agent's launch prompt verbatim — never the 180-character detail cap | KEEP | Contract/failure: task.started keeps an agent's launch prompt verbatim — never the 180-character detail cap. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.started keeps a prompt of exactly 32_000 whole, and cuts a longer one there | KEEP | Contract/failure: task.started keeps a prompt of exactly 32_000 whole, and cuts a longer one there. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.started never cuts a prompt through a surrogate pair | KEEP | Contract/failure: task.started never cuts a prompt through a surrogate pair. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.started without a prompt, or with a blank one, has no prompt key | KEEP | Contract/failure: task.started without a prompt, or with a blank one, has no prompt key. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.progress splits activity and usage onto two stable ids | KEEP | Contract/failure: task.progress splits activity and usage onto two stable ids. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a usage-only task.progress produces the usage row alone | KEEP | Contract/failure: a usage-only task.progress produces the usage row alone. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.completed is titled from the remembered description | DELETE | Supplies the title through a test option and reads it back; index.test.ts remembers a task description through real start/completion events. |
| a failed task row is toned error | KEEP | Contract/failure: a failed task row is toned error. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.completed carries a shell's exit code — a signal's negative one included | KEEP | Contract/failure: task.completed carries a shell's exit code — a signal's negative one included. A violation changes the emitted or folded caller-visible data/state described by this case. |
| task.completed carries the adapter's left-running marker, and only when set | KEEP | Contract/failure: task.completed carries the adapter's left-running marker, and only when set. A violation changes the emitted or folded caller-visible data/state described by this case. |
| parent-conversation tool.progress is ephemeral; only agent-owned heartbeats persist | KEEP | Contract/failure: parent-conversation tool.progress is ephemeral; only agent-owned heartbeats persist. A violation changes the emitted or folded caller-visible data/state described by this case. |
| tool.denied is an error row | KEEP | Contract/failure: tool.denied is an error row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| runtime.error keeps its class; runtime.warning uses the message as the label | KEEP | Contract/failure: runtime.error keeps its class; runtime.warning uses the message as the label. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an account failure's reason and reset reach the activity payload (workflows §5.4) | KEEP | Contract/failure: an account failure's reason and reset reach the activity payload (workflows §5.4). A violation changes the emitted or folded caller-visible data/state described by this case. |
| hooks, plans and reroutes become rows | KEEP | Contract/failure: hooks, plans and reroutes become rows. A violation changes the emitted or folded caller-visible data/state described by this case. |
| questions become their own rows | KEEP | Contract/failure: questions become their own rows. A violation changes the emitted or folded caller-visible data/state described by this case. |
| one thread.goal.updated is ONE goal.updated row carrying the payload verbatim | KEEP | Contract/failure: one thread.goal.updated is ONE goal.updated row carrying the payload verbatim. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a goal outside a turn is turnless, and no row ever names an agent | KEEP | Contract/failure: a goal outside a turn is turnless, and no row ever names an agent. A violation changes the emitted or folded caller-visible data/state described by this case. |
| only a failed goal is error-toned | KEEP | Contract/failure: only a failed goal is error-toned. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a cleared goal's row keeps the goal that ended, verbatim | KEEP | Contract/failure: a cleared goal's row keeps the goal that ended, verbatim. A violation changes the emitted or folded caller-visible data/state described by this case. |
| every hidden progress row of a thread shares ONE stable id — the latest replaces it in place | DELETE | Exact ID formatting repeats the stronger fold-integration goal replacement regression, which checks the current goal and preserved chronological position. |
| a goal event replayed out of the provider's history produces nothing | KEEP | Contract/failure: a goal event replayed out of the provider's history produces nothing. A violation changes the emitted or folded caller-visible data/state described by this case. |
| session, turn and content events produce no activity of their own | KEEP | Contract/failure: session, turn and content events produce no activity of their own. A violation changes the emitted or folded caller-visible data/state described by this case. |

## apps/daemon/src/agent-host/ingestion/assistant-phase.test.ts

**Independent source (bar 1):** Codex fixture README observation 18 and captures; GUI design §§5.1/7.3; D3/D4 documented dropped-text/abandoned-item regressions.

**Stable seam, production callers, and refactor independence (bars 4–5):** real Codex normalizer/history → ingestion → public fold; fixture bytes are the independent oracle.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The normalizer does not generate expectations: recorded raw frame text/phase and literal regression text do. Corpus replay includes both presence and content checks. Synthetic cases cover absent deltas, phase-word text, abandoned/same/anonymous items, or owner ordering absent from the captures.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| files commentary as commentary and the answer as the answer, both texts intact | DELETE | the retained phase-word Codex history regression proves both phase mappings plus exact text preservation on the harder previously lost input; lower Codex history tests own production projection. |
| never drops a replayed message whose whole text is its own phase word | KEEP | Contract/failure: never drops a replayed message whose whole text is its own phase word. A violation changes the emitted or folded caller-visible data/state described by this case. |
| live, streamed then completed (OpenCode's shape): ${JSON.stringify(text)} | KEEP | Contract/failure: live, streamed then completed (OpenCode's shape): ${JSON.stringify(text)}. A violation changes the emitted or folded caller-visible data/state described by this case. |
| live, a completion standing in for deltas that never came: ${JSON.stringify(text)} | KEEP | Contract/failure: live, a completion standing in for deltas that never came: ${JSON.stringify(text)}. A violation changes the emitted or folded caller-visible data/state described by this case. |
| history (Grok's and OpenCode's shape): ${JSON.stringify(text)} | KEEP | Contract/failure: history (Grok's and OpenCode's shape): ${JSON.stringify(text)}. A violation changes the emitted or folded caller-visible data/state described by this case. |
| 04: the commentary narration and the answer, exactly as recorded | DELETE | The all-captures replay includes fixture 04 and checks every assistant message against independently captured text and phase. |
| every capture: each assistant bubble is ONE recorded agentMessage, of its phase, with its own text | KEEP | Contract/failure: every capture: each assistant bubble is ONE recorded agentMessage, of its phase, with its own text. A violation changes the emitted or folded caller-visible data/state described by this case. |
| (a) abandoned commentary, then the final answer: two messages, and lastReply reads the answer alone | KEEP | Contract/failure: (a) abandoned commentary, then the final answer: two messages, and lastReply reads the answer alone. A violation changes the emitted or folded caller-visible data/state described by this case. |
| (b) fixture 05: the interrupted agentMessage and its re-sample are two bubbles, each its own text | DELETE | The all-captures replay includes fixture 05 with the same abandoned-item text oracle; the synthetic final-answer variant separately protects answer classification. |
| (c) a restarted SAME item keeps its one message | KEEP | Contract/failure: (c) a restarted SAME item keeps its one message. A violation changes the emitted or folded caller-visible data/state described by this case. |
| (c) an item.started that names no item proves no abandonment | KEEP | Contract/failure: (c) an item.started that names no item proves no abandonment. A violation changes the emitted or folded caller-visible data/state described by this case. |
| (c) a subagent's assistant item leaves the parent's open message alone | KEEP | Contract/failure: (c) a subagent's assistant item leaves the parent's open message alone. A violation changes the emitted or folded caller-visible data/state described by this case. |
| (c) …and a parent's new item leaves a subagent's open message alone | KEEP | Contract/failure: (c) …and a parent's new item leaves a subagent's open message alone. A violation changes the emitted or folded caller-visible data/state described by this case. |
| data.text stands in for deltas that never arrived, even beside a marker detail | KEEP | Contract/failure: data.text stands in for deltas that never arrived, even beside a marker detail. A violation changes the emitted or folded caller-visible data/state described by this case. |
| …and never prints a streamed message twice | KEEP | Contract/failure: …and never prints a streamed message twice. A violation changes the emitted or folded caller-visible data/state described by this case. |

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
| slims a row on its way out, and stamps truncated | KEEP | Contract/failure: slims a row on its way out, and stamps truncated. A violation changes the emitted or folded caller-visible data/state described by this case. |
| slimActivityEvent slims an activity event and passes everything else through | KEEP | Contract/failure: slimActivityEvent slims an activity event and passes everything else through. A violation changes the emitted or folded caller-visible data/state described by this case. |
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
| the turn settles from session status, and the head tracks the session | KEEP | Contract/failure: the turn settles from session status, and the head tracks the session. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an interrupted session settles the turn as interrupted | DELETE | The retained E3/R5 parameterized Stop regression includes turn.aborted and both turn.completed interruption states with stronger error-state assertions. |
| an approval opens and closes in the pending set the fold derives | DELETE | Repeats activity mapper request-open/request-resolution protocol assertions and API pending-request derivation tests; no new ingestion-specific transition. |
| a tool_user_input request never reaches the pending set | DELETE | The activity mapper tests both request arms, including withdrawal, at the owning transformation seam. |
| a question opens as a pending user input and a resolution closes it | DELETE | Activity mapper question emission plus API pending-request tests own the producer and consumer contracts. |
| the roster rebuilds from the linkage ingestion stamps on EVERY task row | DELETE | Despite its title, does not evict any start row; linkage mapping is exhaustively checked at the mapper, and API roster/retention tests own rebuilding. |
| a background shell folds as background, not as a subagent | KEEP | Contract/failure: a background shell folds as background, not as a subagent. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a task stopped by a dying session folds to interrupted | DELETE | packages/api/src/agent-chat/roster.test.ts directly owns stopped-to-interrupted mapping; retained mapper task lifecycle/linkage checks own emitted status. No ingestion-specific state is added here. |
| the tool lifecycle folds into rows the timeline can group | DELETE | Reasserts mapper tool lifecycle kind, ID and status; fold does not transform these activity fields. |
| a task.progress row replaces the previous one instead of piling up | KEEP | Contract/failure: a task.progress row replaces the previous one instead of piling up. A violation changes the emitted or folded caller-visible data/state described by this case. |
| goal progress rows collapse into one, and the goal follows every replacement | KEEP | Contract/failure: goal progress rows collapse into one, and the goal follows every replacement. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the compaction marker keeps its token counts through the fold | DELETE | Exact duplicate of the mapper compaction token-count case across a fold that preserves the payload. |
| the §7.3 badge fields survive the fold onto the message item | DELETE | Raw/summary metadata is covered by index.test.ts and answer/commentary metadata through the stronger phase capture replay. |
| a later delta that omits the fields never strips them | KEEP | Contract/failure: a later delta that omits the fields never strips them. A violation changes the emitted or folded caller-visible data/state described by this case. |
| E3/R5 #2: a user Stop via ${label} settles the turn INTERRUPTED | KEEP | Contract/failure: E3/R5 #2: a user Stop via ${label} settles the turn INTERRUPTED. A violation changes the emitted or folded caller-visible data/state described by this case. |
| E10: turn.completed's tokenUsage and cost reach Turn | KEEP | Contract/failure: E10: turn.completed's tokenUsage and cost reach Turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| E10: an interrupted turn keeps the usage it managed to report | KEEP | Contract/failure: E10: an interrupted turn keeps the usage it managed to report. A violation changes the emitted or folded caller-visible data/state described by this case. |
| E10: a replayed terminal event never rewrites a settled turn's numbers | KEEP | Contract/failure: E10: a replayed terminal event never rewrites a settled turn's numbers. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the provider's title reaches the head | DELETE | Duplicates index.test.ts automatic-title rule and the API thread metadata fold contract. |
| ${shape.adapter}: a relaunch reads running (run 2), then its new result | DELETE | Hand-built adapter-shaped rows repeat packages/api/src/agent-chat/roster.test.ts new-launch/reactivation contracts. Retained relaunch-after-retention case adds the actual composed eviction failure. |
| ${shape.adapter}: a relaunched run survives 300 agent-owned tool calls | KEEP | Contract/failure: ${shape.adapter}: a relaunched run survives 300 agent-owned tool calls. A violation changes the emitted or folded caller-visible data/state described by this case. |
| Claude: the notification's `(exit code N)` is the roster row's exit code | DELETE | Normalizer exit-code parsing, mapper exit-code propagation (including negative signal values), and API roster exit-code reading have lower owners. |
| 07: every output row of an agent-owned call carries the call's agentId | DELETE | The retained background-agent after-parent-result regression checks every lifecycle/output row owner for both turned and turnless calls, plus settled message text. |
| a background agent's call keeps one turn and one owner past the parent's result, and its words settle | KEEP | Contract/failure: a background agent's call keeps one turn and one owner past the parent's result, and its words settle. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a woken parent's call rides its synthetic turn — its held stream replayed into it — and a rewind to before that turn removes it | KEEP | Contract/failure: a woken parent's call rides its synthetic turn — its held stream replayed into it — and a rewind to before that turn removes it. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a call an interrupted message's tail streams after its turn ended is that turn's, closed on it — the next turn holds none of it | KEEP | Contract/failure: a call an interrupted message's tail streams after its turn ended is that turn's, closed on it — the next turn holds none of it. A violation changes the emitted or folded caller-visible data/state described by this case. |

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
| a historical turn settles WITHOUT touching session status | KEEP | Contract/failure: a historical turn settles WITHOUT touching session status. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a half-replayed transcript leaves NO running turn | KEEP | Contract/failure: a half-replayed transcript leaves NO running turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an interrupted historical turn replays as interrupted, not completed | KEEP | Contract/failure: an interrupted historical turn replays as interrupted, not completed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| history feeds neither liveness nor the checkpoint service | REWRITE | Replace swallowed throwing checkpoint hook with a recorded invocation and a valid checkpoint response; assert no call occurred and query real liveness state instead of mock call history. The original negative could pass when the forbidden call threw and was swallowed. |
| a replayed provider name never retitles the thread | KEEP | Contract/failure: a replayed provider name never retitles the thread. A violation changes the emitted or folded caller-visible data/state described by this case. |
| replayed messages are complete, never streaming | KEEP | Contract/failure: replayed messages are complete, never streaming. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the FULL text wins over an elided detail | KEEP | Contract/failure: the FULL text wins over an elided detail. A violation changes the emitted or folded caller-visible data/state described by this case. |
| one user message per replayed turn, however many items echo it | KEEP | Contract/failure: one user message per replayed turn, however many items echo it. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a replayed tool call is still an activity row | KEEP | Contract/failure: a replayed tool call is still an activity row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| replaying the same transcript twice rewrites the rows, never duplicates them | KEEP | Contract/failure: replaying the same transcript twice rewrites the rows, never duplicates them. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the provider echoing the prompt does not duplicate what /turn appended | KEEP | Contract/failure: the provider echoing the prompt does not duplicate what /turn appended. A violation changes the emitted or folded caller-visible data/state described by this case. |

## apps/daemon/src/agent-host/ingestion/index.test.ts

**Independent source (bar 1):** GUI design §§3.1/5.1/5.4/5.6/7.3/10; public Ingestion service and AppendableDomainEvent protocol.

**Stable seam, production callers, and refactor independence (bars 4–5):** createIngestion ingest/drain/flush/forget and emitted domain events; production construction in orchestration/orchestrator.ts.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** Exact event text, order, persisted identifiers, lifecycle state, controlled time bounds, and explicit no-event cases are independent oracles. Retained timing counts are specified write budgets, not geometry. State setup exercises real ingestion; RecordingSink only records output.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| mints assistant:<itemId> for the first segment of a turn | DELETE | Repeated by the delta/completion wire-contract test and phase corpus replay, both of which require the same persisted identity while checking real content. |
| falls back to the turn id, then the event id | KEEP | Contract/failure: falls back to the turn id, then the event id. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a second assistant block in one turn gets :segment:1 | DELETE | Does not exercise the segment suffix its title promises; the phase corpus and abandoned-item regressions prove distinct provider items remain separate messages. |
| a summary trace and a raw trace over one item become two reasoning messages | KEEP | Contract/failure: a summary trace and a raw trace over one item become two reasoning messages. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a delta carries ONLY the new text and a completion carries empty text | KEEP | Contract/failure: a delta carries ONLY the new text and a completion carries empty text. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a completion with nothing buffered and nothing projected writes no message at all | DELETE | The retained Q1 #9 settled-turn then reused-ID regression checks the same no-ghost-message contract after a stronger state transition. |
| an item.completed snapshot stands in for deltas that never arrived | DELETE | The phase-word completion fallback cases in assistant-phase.test.ts exercise the same contract through the real fold, including the historic text-loss input. |
| an item.completed snapshot NEVER duplicates text that already streamed | DELETE | The phase-word streamed completion cases and prompt-closed regression check text exactly once through the real fold. |
| a whole-block reasoning snapshot with no stream gets its own snapshot id | DELETE | Only checks repeated generated IDs; the retained whole-block reasoning snapshot test checks actual preserved text and absence of invented stream metadata. |
| holds a partial line until the 250 ms window expires | KEEP | Contract/failure: holds a partial line until the 250 ms window expires. A violation changes the emitted or folded caller-visible data/state described by this case. |
| delivers early on a paragraph boundary once the pacing window has passed | KEEP | Contract/failure: delivers early on a paragraph boundary once the pacing window has passed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| never splits a code block: an open fence holds past the window | KEEP | Contract/failure: never splits a code block: an open fence holds past the window. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the 8 KB valve wins over the fence rule | KEEP | Contract/failure: the 8 KB valve wins over the fence rule. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a token-by-token provider becomes a handful of events per second | DELETE | Repeats the exact 250 ms hold/pacing contracts with a loose count and partial text oracle; deterministic boundary tests and the wire delta test are stronger. |
| reasoning deltas are buffered on the same machinery | KEEP | Contract/failure: reasoning deltas are buffered on the same machinery. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a new reasoning part index inserts the blank line that separates traces | KEEP | Contract/failure: a new reasoning part index inserts the blank line that separates traces. A violation changes the emitted or folded caller-visible data/state described by this case. |
| command output deltas are buffered per item id (§5.6) | KEEP | Contract/failure: command output deltas are buffered per item id (§5.6). A violation changes the emitted or folded caller-visible data/state described by this case. |
| request.opened flushes AND finalises before the approval row is appended | KEEP | Contract/failure: request.opened flushes AND finalises before the approval row is appended. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a BLOCKING user-input.requested flushes; a message-mode one does not | KEEP | Contract/failure: a BLOCKING user-input.requested flushes; a message-mode one does not. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a completion NEVER re-sends text that a prompt already closed | KEEP | Contract/failure: a completion NEVER re-sends text that a prompt already closed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the prompt-closed record is per turn: another turn's snapshot still stands in | KEEP | Contract/failure: the prompt-closed record is per turn: another turn's snapshot still stands in. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a tool item.started closes the active reasoning segment | KEEP | Contract/failure: a tool item.started closes the active reasoning segment. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a NON-tool item.started leaves the thinking block open | KEEP | Contract/failure: a NON-tool item.started leaves the thinking block open. A violation changes the emitted or folded caller-visible data/state described by this case. |
| assistant text closes the thinking block that preceded it | KEEP | Contract/failure: assistant text closes the thinking block that preceded it. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a settled turn flushes and closes everything it opened | KEEP | Contract/failure: a settled turn flushes and closes everything it opened. A violation changes the emitted or folded caller-visible data/state described by this case. |
| collapses a burst for one call to the latest row | KEEP | Contract/failure: collapses a burst for one call to the latest row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| coalesces per turn, not per thread | KEEP | Contract/failure: coalesces per turn, not per thread. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a call with no stable id passes through unchanged | KEEP | Contract/failure: a call with no stable id passes through unchanged. A violation changes the emitted or folded caller-visible data/state described by this case. |
| any non-update event closes the window immediately, so ordering is preserved | KEEP | Contract/failure: any non-update event closes the window immediately, so ordering is preserved. A violation changes the emitted or folded caller-visible data/state described by this case. |
| 512 pending rows close the window early | KEEP | Contract/failure: 512 pending rows close the window early. A violation changes the emitted or folded caller-visible data/state described by this case. |
| drain flushes a window that has not expired | KEEP | Contract/failure: drain flushes a window that has not expired. A violation changes the emitted or folded caller-visible data/state described by this case. |
| ${streamKind} -> reasoningKind ${expected} | KEEP | Contract/failure: ${streamKind} -> reasoningKind ${expected}. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a whole-block reasoning snapshot carries NO reasoningKind | KEEP | Contract/failure: a whole-block reasoning snapshot carries NO reasoningKind. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the phase stamps a message that ALREADY started streaming | KEEP | Contract/failure: the phase stamps a message that ALREADY started streaming. A violation changes the emitted or folded caller-visible data/state described by this case. |
| Codex's phase-marker detail is metadata, NOT the message text | DELETE | The phase corpus replay rejects invented bubbles and checks every actual bubble against provider capture text. |
| commentary on one item does not leak onto the turn's next message | DELETE | The phase corpus and abandoned-commentary/final-answer regression assert the same ownership of phase with independently recorded provider frames. |
| a dead session forgets the remembered phases | KEEP | Contract/failure: a dead session forgets the remembered phases. A violation changes the emitted or folded caller-visible data/state described by this case. |
| writes nothing to the thread and hands them to the host instead | KEEP | Contract/failure: writes nothing to the thread and hands them to the host instead. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a throwing host hook never escapes ingest | KEEP | Contract/failure: a throwing host hook never escapes ingest. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a tool.updated row reaches the log slimmed, the completion in full | KEEP | Contract/failure: a tool.updated row reaches the log slimmed, the completion in full. A violation changes the emitted or folded caller-visible data/state described by this case. |
| retitles an auto-generated thread | KEEP | Contract/failure: retitles an auto-generated thread. A violation changes the emitted or folded caller-visible data/state described by this case. |
| NEVER overwrites a manual rename | KEEP | Contract/failure: NEVER overwrites a manual rename. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an empty name is not a rename | KEEP | Contract/failure: an empty name is not a rename. A violation changes the emitted or folded caller-visible data/state described by this case. |
| forwards task.* and clears on session.exited | REWRITE | Replace mock collaborator-call inventory with the real liveness registry: start exposes live work, completion removes it, and exit clears unfinished work. |
| remembers a task description so the completion row is titled | KEEP | Contract/failure: remembers a task description so the completion row is titled. A violation changes the emitted or folded caller-visible data/state described by this case. |
| dedupes an unchanged status, so Claude's 3-per-turn status frames write one row | KEEP | Contract/failure: dedupes an unchanged status, so Claude's 3-per-turn status frames write one row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| runtime.error writes BOTH a session-set and an activity row | KEEP | Contract/failure: runtime.error writes BOTH a session-set and an activity row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| session.exited flushes buffered text before the stop and forgets the turn state | KEEP | Contract/failure: session.exited flushes buffered text before the stop and forgets the turn state. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the head SEEDS the session state, so a restart keeps the active turn | KEEP | Contract/failure: the head SEEDS the session state, so a restart keeps the active turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| after seeding, ingestion's own memory wins over a head W1 has not applied yet | KEEP | Contract/failure: after seeding, ingestion's own memory wins over a head W1 has not applied yet. A violation changes the emitted or folded caller-visible data/state described by this case. |
| buffers turn.proposed deltas onto one stable row and completes it | KEEP | Contract/failure: buffers turn.proposed deltas onto one stable row and completes it. A violation changes the emitted or folded caller-visible data/state described by this case. |
| plan deltas are BATCHED: a token-by-token plan is not one row per token | KEEP | Contract/failure: plan deltas are BATCHED: a token-by-token plan is not one row per token. A violation changes the emitted or folded caller-visible data/state described by this case. |
| plan_text content deltas feed the same buffer | KEEP | Contract/failure: plan_text content deltas feed the same buffer. A violation changes the emitted or folded caller-visible data/state described by this case. |
| the completion's markdown stands in when nothing was streamed | KEEP | Contract/failure: the completion's markdown stands in when nothing was streamed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| emits thread.turn-diff-completed when the host resolves a turn count | KEEP | Contract/failure: emits thread.turn-diff-completed when the host resolves a turn count. A violation changes the emitted or folded caller-visible data/state described by this case. |
| emits nothing when the host declines, and nothing when no hook is wired | KEEP | Contract/failure: emits nothing when the host declines, and nothing when no hook is wired. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #3: the placeholder checkpoint never synthesises an assistantMessageId | KEEP | Contract/failure: R5 #3: the placeholder checkpoint never synthesises an assistantMessageId. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #3: it DOES carry the turn's real anchor when one is open | KEEP | Contract/failure: R5 #3: it DOES carry the turn's real anchor when one is open. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #7: reasoning with NO turn id is buffered, not silently discarded | KEEP | Contract/failure: R5 #7: reasoning with NO turn id is buffered, not silently discarded. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #8: a proposal streamed by a subagent keeps its agentId | KEEP | Contract/failure: R5 #8: a proposal streamed by a subagent keeps its agentId. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #9: both output streams of ONE item share one buffer and one row | KEEP | Contract/failure: R5 #9: both output streams of ONE item share one buffer and one row. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #17: every event is stamped with the thread's adapterKey | KEEP | Contract/failure: R5 #17: every event is stamped with the thread's adapterKey. A violation changes the emitted or folded caller-visible data/state described by this case. |
| R5 #17: no adapter in context leaves adapterKey absent | KEEP | Contract/failure: R5 #17: no adapter in context leaves adapterKey absent. A violation changes the emitted or folded caller-visible data/state described by this case. |
| Q1 #9: forget() releases a thread, drops its buffers and clears liveness | REWRITE | Keep the caller-visible contract that draining after deletion never appends buffered text; remove the mock clear-call assertion, which could fail after an equivalent liveness implementation change. Real exit/liveness state is checked by the rewritten registry integration. |
| Q1 #9: a settled turn releases `projected`, so a later bare completion is inert | KEEP | Contract/failure: Q1 #9: a settled turn releases `projected`, so a later bare completion is inert. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a malformed payload becomes a runtime.warning activity, not a throw | KEEP | Contract/failure: a malformed payload becomes a runtime.warning activity, not a throw. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an event with no thread id is logged and dropped, never thrown | KEEP | Contract/failure: an event with no thread id is logged and dropped, never thrown. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a failing sink never escapes ingest | KEEP | Contract/failure: a failing sink never escapes ingest. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a throwing liveness registry never escapes ingest | KEEP | Contract/failure: a throwing liveness registry never escapes ingest. A violation changes the emitted or folded caller-visible data/state described by this case. |
| delivers domain events to the sink in the order they were produced | KEEP | Contract/failure: delivers domain events to the sink in the order they were produced. A violation changes the emitted or folded caller-visible data/state described by this case. |
| keeps threads independent | DELETE | Sequential writes only verify that the sink received the input thread IDs; they do not test independence or blocked concurrent lanes. The retained event ordering test owns append order; host goal-hold tests exercise multiple threads with distinct live work. This sequential call inventory did not protect the claimed independence. |
| frees a task title once the task it names has completed | DELETE | Infers a private map deletion from a repeated completion losing its title, which is not a caller contract or a memory measurement. The retained real start/completion test owns title preservation. |
| drains a tool-output buffer at item completion, then releases its metadata | KEEP | Contract/failure: drains a tool-output buffer at item completion, then releases its metadata. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a subagent's text and thinking never open, close or join the parent's segments | KEEP | Contract/failure: a subagent's text and thinking never open, close or join the parent's segments. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an agent-owned message never takes the id of a parent message of the same turn | KEEP | Contract/failure: an agent-owned message never takes the id of a parent message of the same turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a turn end closes an agent's open segment too | KEEP | Contract/failure: a turn end closes an agent's open segment too. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a turnless agent ${itemType} settles on its own item.completed | KEEP | Contract/failure: a turnless agent ${itemType} settles on its own item.completed. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a turnless completion settles only the message its own deltas opened | REWRITE | Open the unrelated message BEFORE the unrelated completion; the original ordering could pass even if a completion closed all currently open messages. |
| a turnless owned command output is a turnless owned tool.output row (lock) | KEEP | Contract/failure: a turnless owned command output is a turnless owned tool.output row (lock). A violation changes the emitted or folded caller-visible data/state described by this case. |

## apps/daemon/src/agent-host/ingestion/session-status.test.ts

**Independent source (bar 1):** GUI design §§3.1/5.1 session/turn lifecycle; AGENTS.md resume cursor preservation.

**Stable seam, production callers, and refactor independence (bars 4–5):** nextSessionState runtime-to-domain reducer consumed by createIngestion, independent of queue/buffer internals.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The state machine can independently fail by dropping resume identity, leaving dead work active, misclassifying errors, retaining stale errors, or resetting an active turn on a delayed provider start. Each case covers one such lifecycle failure.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| a failed turn leaves running for error, with the message | KEEP | Contract/failure: a failed turn leaves running for error, with the message. A violation changes the emitted or folded caller-visible data/state described by this case. |
| an interrupted turn leaves no lastError on the head | KEEP | Contract/failure: an interrupted turn leaves no lastError on the head. A violation changes the emitted or folded caller-visible data/state described by this case. |
| session.exited always clears the active turn | KEEP | Contract/failure: session.exited always clears the active turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a graceful exit carries no error | KEEP | Contract/failure: a graceful exit carries no error. A violation changes the emitted or folded caller-visible data/state described by this case. |
| thread.started during an active turn preserves running and records the provider id | KEEP | Contract/failure: thread.started during an active turn preserves running and records the provider id. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a session state that cannot hold a turn drops the active turn | KEEP | Contract/failure: a session state that cannot hold a turn drops the active turn. A violation changes the emitted or folded caller-visible data/state described by this case. |
| session.started keeps the resume cursor the adapter reported | KEEP | Contract/failure: session.started keeps the resume cursor the adapter reported. A violation changes the emitted or folded caller-visible data/state described by this case. |

## apps/daemon/src/agent-host/ingestion/text-boundary.test.ts

**Independent source (bar 1):** GUI design §5.6 markdown flush safety; CommonMark fenced blocks, list starts, and ASCII blank-line semantics.

**Stable seam, production callers, and refactor independence (bars 4–5):** splitBufferedText markdown parser consumed by DeltaBufferSet; parser grammar cases are below timing/batching integration.

**Oracle, observable failure, and coverage ownership (bars 2–3, 6):** The parser can incorrectly close an info-bearing fence, miss a list-indented fence, flush a nonblank no-break-space paragraph, or hold tight list items indefinitely. Literal markdown examples supply the grammar oracle.

| Original test title | Disposition | Reason / actual failure / remaining stronger owner |
| --- | --- | --- |
| a fence indented past a list marker still opens and closes | KEEP | Contract/failure: a fence indented past a list marker still opens and closes. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a closing fence with an info string does not close the block | KEEP | Contract/failure: a closing fence with an info string does not close the block. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a tight list breaks on each item start, including the partial last line | KEEP | Contract/failure: a tight list breaks on each item start, including the partial last line. A violation changes the emitted or folded caller-visible data/state described by this case. |
| a no-break space is paragraph content, not a blank line | KEEP | Contract/failure: a no-break space is paragraph content, not a blank line. A violation changes the emitted or folded caller-visible data/state described by this case. |

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
