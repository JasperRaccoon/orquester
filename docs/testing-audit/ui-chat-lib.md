# UI agent-chat library test audit

Baseline `beb7516b`; scope: all 46 agent-chat library test files, 637 test declarations (parameterized inputs remain within their declaration). Prior evidence in `docs/test-audit/ui-chat-lib.txt`, `ui-chat-store.txt`, and `ui-chat-rows.txt` was cross-checked against current contracts and callers; the ledger below uses current baseline names, including later additions.

Result: 2 DELETE, 8 CONSOLIDATE (four removed executions and four surviving owners), 11 REWRITE, 616 KEEP. 631 declarations remain; test/code diff is net −66 lines. No production behavior changes. Two helpers are now private: `isQueuedMessageDue`, `toolApprovalOutcomeText`; retained checks use existing production-consumed queue/presentation seams. No deleted fixtures/snapshots/dependencies or orphaned helper infrastructure resulted.

The JSON companion records original path/line/name identities, dispositions and shared evidence for integration accounting. Each file paragraph below supplies bars 1, 4 and 6; its named row identifies the exact credible failure (bar 2). Expected semantic outputs are independent hand-authored protocol, state, persisted-data or error examples (bar 3), rather than owner-generated expected transformations. The assertions survive identifier-only refactors and preserve explicit wire keys/bytes and independently documented limits (bar 5). No benchmark speedup is inferred from line/test reduction.

Isolated-unit credible failure inventory: wrong route/cursor/host identity; corrupted streamed framing or output joins; cross-agent/account attribution; lost or duplicate sent/queued content; stale pending controls; incorrect approval/consent/goal eligibility; stale data after revocation; malformed or old persisted data reaching typed state; incorrect retention/eviction or late async writes. These are the reasons the retained selectors/parsers exist, not branch-coverage goals.

Expensive retention/history/reload scenarios remain: they cross actual fold/window/version/generation boundaries with deterministic frames or virtual time. Reload cases replace module memory while preserving browser storage, which simple object resets would not verify. Bounded storage tests retain large entries only where the serialized-size rejection is the behavior. The existing isolated-page namespace recycling already preserves state isolation while allowing transform reuse.

Validation is centrally scheduled by the root agent to respect one test process per worktree. Exact focused command: from `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-concurrency=4 src/lib/agent-chat/*.test.ts`. No standalone test run has been launched by this agent yet. Root report owns baseline/final full-suite measurements and environment limitations.

## packages/ui/src/lib/agent-chat/account-switch.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§3.4,7.4; docs/superpowers/specs/2026-09-24-agent-goals-design.md §§5.5,5.7. Stable seam/callers: account-switch.ts selectors consumed by AgentChatView account controls.

Recognizable failures: cross-family identity choices, a switch racing work, or stale goal/hold verdicts opening or permanently closing identity changes. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| offers System plus the launcher's OWN family | KEEP | Six-bar file evidence above; unique failure/condition: offers System plus the launcher's OWN family. |
| OpenCode has no per-thread account, decided without waiting for a snapshot | KEEP | Six-bar file evidence above; unique failure/condition: OpenCode has no per-thread account, decided without waiting for a snapshot. |
| opens only when nothing is in flight | KEEP | Six-bar file evidence above; unique failure/condition: opens only when nothing is in flight. |
| closes for every in-flight shape | KEEP | Six-bar file evidence above; unique failure/condition: closes for every in-flight shape. |
| an active goal on a provider that starts its own turns is continuing — and only that | KEEP | Six-bar file evidence above; unique failure/condition: an active goal on a provider that starts its own turns is continuing — and only that. |
| final wave (8): only on a live session — a stopped or errored one may switch | KEEP | Six-bar file evidence above; unique failure/condition: final wave (8): only on a live session — a stopped or errored one may switch. |
| final wave (8): the host's own verdict wins whenever the view has it | KEEP | Six-bar file evidence above; unique failure/condition: final wave (8): the host's own verdict wins whenever the view has it. |
| goals §5.7: a goal a deploy HELD is continuing — paused or not, whatever the session says | KEEP | Six-bar file evidence above; unique failure/condition: goals §5.7: a goal a deploy HELD is continuing — paused or not, whatever the session says. |
| goals §5.7: held without a continuing verdict still closes the chip, as the host refuses it | KEEP | Six-bar file evidence above; unique failure/condition: goals §5.7: held without a continuing verdict still closes the chip, as the host refuses it. |
| goals §5.7: the head's hold mark continues nothing the provider would not set going again | KEEP | Six-bar file evidence above; unique failure/condition: goals §5.7: the head's hold mark continues nothing the provider would not set going again. |
| goals §5.7: the host's verdict still wins over the head's hold mark | KEEP | Six-bar file evidence above; unique failure/condition: goals §5.7: the host's verdict still wins over the head's hold mark. |
| the system identity's two spellings map onto the menu's one id | KEEP | Six-bar file evidence above; unique failure/condition: the system identity's two spellings map onto the menu's one id. |

## packages/ui/src/lib/agent-chat/agent-prompt.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.3,7.6. Stable seam/callers: drillInWindow/agentPromptOf consumed by drill-in.logic.ts and timeline readers.

Recognizable failures: missing or duplicate launch prompts, wrong agent ownership, wrong launch ordering or truncated-prompt readback metadata. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| puts a Claude launch's prompt — a PARENT row — before the agent's own rows | KEEP | Six-bar file evidence above; unique failure/condition: puts a Claude launch's prompt — a PARENT row — before the agent's own rows. |
| keeps a launch the agent's own row stamps (Codex, OpenCode, Grok), the prompt first | KEEP | Six-bar file evidence above; unique failure/condition: keeps a launch the agent's own row stamps (Codex, OpenCode, Grok), the prompt first. |
| invents nothing: a launch with no prompt, a blank one, or another agent's adds no row | KEEP | Six-bar file evidence above; unique failure/condition: invents nothing: a launch with no prompt, a blank one, or another agent's adds no row. |
| a launch delivered twice is one prompt: the first start of a launch wins | KEEP | Six-bar file evidence above; unique failure/condition: a launch delivered twice is one prompt: the first start of a launch wins. |
| a re-emitted start with NO launch id is still one prompt: keyed by what the start says | KEEP | Six-bar file evidence above; unique failure/condition: a re-emitted start with NO launch id is still one prompt: keyed by what the start says. |
| two starts with no launch id that say different things are two prompts | KEEP | Six-bar file evidence above; unique failure/condition: two starts with no launch id that say different things are two prompts. |
| says what the log kept: cut on the wire (the item holds all of it), or cut at rest | KEEP | Six-bar file evidence above; unique failure/condition: says what the log kept: cut on the wire (the item holds all of it), or cut at rest. |
| names the agent's latest launch too — any start naming it, with a prompt or not | KEEP | Six-bar file evidence above; unique failure/condition: names the agent's latest launch too — any start naming it, with a prompt or not. |
| heads the coordinator's drill-in with its script, marked as one | KEEP | Six-bar file evidence above; unique failure/condition: heads the coordinator's drill-in with its script, marked as one. |

## packages/ui/src/lib/agent-chat/agent-rows.logic.test.ts

Independent contract: packages/api/src/agent-chat/agent-rows.ts public on-demand request/frame protocol; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3. Stable seam/callers: AgentRowsLoader consumed by store.ts.

Recognizable failures: missing active/drilled-in rows, repeated or oversized requests, treating transient/auth errors as missing routes, and reconnect loops. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| asks for the wanted, the touched and the active omitted agents only, once per stream | KEEP | Six-bar file evidence above; unique failure/condition: asks for the wanted, the touched and the active omitted agents only, once per stream. |
| asks nothing before the stream is live, and nothing for an agent no longer omitted | DELETE | Fails unique-protection bar: store.agent-rows drill-in workflow proves before-live refusal and no repeat request once loaded; first loader test independently filters a wanted non-omitted id. Owner: store.agent-rows.test.ts: a drill-in asks on the live stream, never before it is live, batched, and its rows land. |
| splits a request past the cap | KEEP | Six-bar file evidence above; unique failure/condition: splits a request past the cap. |
| a lost answer is asked again after a backoff; a gone stream only on the next one | KEEP | Six-bar file evidence above; unique failure/condition: a lost answer is asked again after a backoff; a gone stream only on the next one. |
| any other refusal — a route miss above all — stops it and asks for the whole thread, once | CONSOLIDATE | Stronger multi-batch 404/405 owner now also verifies disabled loader and no requests on subsequent stream; remove separate single 404 execution. Owner: agent-rows.logic.test.ts: a route miss reads the thread whole once, however many batches fail. |
| a live stream with omitted rows and no id to ask on reads the thread whole, once | KEEP | Six-bar file evidence above; unique failure/condition: a live stream with omitted rows and no id to ask on reads the thread whole, once. |
| a dropped frame's agents are asked for again | KEEP | Six-bar file evidence above; unique failure/condition: a dropped frame's agents are asked for again. |
| a proxy's 502/504, a 429 and a 500 are retried after a backoff, never taken for a missing route | KEEP | Six-bar file evidence above; unique failure/condition: a proxy's 502/504, a 429 and a 500 are retried after a backoff, never taken for a missing route. |
| a 401 waits for the next stream: not retried here, not unsupported | KEEP | Six-bar file evidence above; unique failure/condition: a 401 waits for the next stream: not retried here, not unsupported. |
| a route miss reads the thread whole once, however many batches fail | CONSOLIDATE | Surviving owner. Stronger multi-batch 404/405 owner now also verifies disabled loader and no requests on subsequent stream; remove separate single 404 execution. Owner: agent-rows.logic.test.ts. |
| an agent whose request is lost with its stream, stream after stream, is read whole instead — once | KEEP | Six-bar file evidence above; unique failure/condition: an agent whose request is lost with its stream, stream after stream, is read whole instead — once. |
| a frame that lands clears what was lost | KEEP | Six-bar file evidence above; unique failure/condition: a frame that lands clears what was lost. |

## packages/ui/src/lib/agent-chat/composer.logic.test.ts

Independent contract: AGENTS.md persisted validation; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4. Stable seam/callers: draft/quote parsing and persistence consumed by store.ts and composer-outbox.ts.

Recognizable failures: lost quote-only drafts, malformed localStorage reaching typed state, dropped valid attachment paths or malformed paths leaking into sends. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| keeps the well-formed quotes of a partly-malformed list, narrowed to their own fields | KEEP | Six-bar file evidence above; unique failure/condition: keeps the well-formed quotes of a partly-malformed list, narrowed to their own fields. |
| reads anything that is not a list as no quotes, and keeps every quote of a long one | KEEP | Six-bar file evidence above; unique failure/condition: reads anything that is not a list as no quotes, and keeps every quote of a long one. |
| loads a draft's quotes, and leaves the field off a draft without any | KEEP | Six-bar file evidence above; unique failure/condition: loads a draft's quotes, and leaves the field off a draft without any. |
| keeps a draft of quotes alone in storage, and reads it back | KEEP | Six-bar file evidence above; unique failure/condition: keeps a draft of quotes alone in storage, and reads it back. |
| survives garbage without letting it reach typed code | KEEP | Six-bar file evidence above; unique failure/condition: survives garbage without letting it reach typed code. |
| keeps the valid entries of a partly-malformed blob | KEEP | Six-bar file evidence above; unique failure/condition: keeps the valid entries of a partly-malformed blob. |
| keeps a string path on a persisted ref and drops a malformed one, so an old blob still loads | KEEP | Six-bar file evidence above; unique failure/condition: keeps a string path on a persisted ref and drops a malformed one, so an old blob still loads. |

## packages/ui/src/lib/agent-chat/continue-in.logic.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6 lineage; packages/api/src/agent-chat/handoff.ts public continuation contract. Stable seam/callers: continuation selectors consumed by ContinueInDialog and fork submission.

Recognizable failures: wrong agent/account/model request, inaccurate handoff selection at fork points, or retry IDs reused across different continuation targets. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| offers installed chat agents, the source's own first | KEEP | Six-bar file evidence above; unique failure/condition: offers installed chat agents, the source's own first. |
| the plain same-agent fork sends today's request; a model alone stays native | KEEP | Six-bar file evidence above; unique failure/condition: the plain same-agent fork sends today's request; a model alone stays native. |
| another account or agent is a handoff, carrying agent, account and model | KEEP | Six-bar file evidence above; unique failure/condition: another account or agent is a handoff, carrying agent, account and model. |
| grok forking itself is its own transcript fork | KEEP | Six-bar file evidence above; unique failure/condition: grok forking itself is its own transcript fork. |
| counts what the handoff carries up to the fork point | KEEP | Six-bar file evidence above; unique failure/condition: counts what the handoff carries up to the fork point. |
| sizes the count for the picked model's context window | KEEP | Six-bar file evidence above; unique failure/condition: sizes the count for the picked model's context window. |
| keeps continuation retries apart from plain forks and other target models | KEEP | Six-bar file evidence above; unique failure/condition: keeps continuation retries apart from plain forks and other target models. |

## packages/ui/src/lib/agent-chat/delegates.logic.test.ts

Independent contract: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §4.1; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6. Stable seam/callers: delegate-group row projection and child view consumed by timeline and composer delegate controls.

Recognizable failures: duplicate or hidden delegated children, wrong work/input/failure states, wrong parent scoping or unreadable preview data. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| collapses consecutive delegating calls of one turn into one group, each child once | KEEP | Six-bar file evidence above; unique failure/condition: collapses consecutive delegating calls of one turn into one group, each child once. |
| splits groups at another tool call and across turns | KEEP | Six-bar file evidence above; unique failure/condition: splits groups at another tool call and across turns. |
| shows a delegating call still opening its chat as a starting child, and the same call once it opened it | KEEP | Six-bar file evidence above; unique failure/condition: shows a delegating call still opening its chat as a starting child, and the same call once it opened it. |
| leaves a plain create_session, and a failed delegating call, as ordinary tool rows | KEEP | Six-bar file evidence above; unique failure/condition: leaves a plain create_session, and a failed delegating call, as ordinary tool rows. |
| keeps the strip visible after its turn settles (never hidden in the 'Worked for' fold) | KEEP | Six-bar file evidence above; unique failure/condition: keeps the strip visible after its turn settles (never hidden in the 'Worked for' fold). |
| reads delegate: true from the arguments however the provider lays them out | KEEP | Six-bar file evidence above; unique failure/condition: reads delegate: true from the arguments however the provider lays them out. |
| merges a call's lifecycle rows into one child, its completed row winning | KEEP | Six-bar file evidence above; unique failure/condition: merges a call's lifecycle rows into one child, its completed row winning. |
| reads each child's status off its tab | KEEP | Six-bar file evidence above; unique failure/condition: reads each child's status off its tab. |
| says "4 working · 1 done · 1 failed", what needs the user first | KEEP | Six-bar file evidence above; unique failure/condition: says "4 working · 1 done · 1 failed", what needs the user first. |
| times the group from its first start, live while any child works, to the latest end once none does | KEEP | Six-bar file evidence above; unique failure/condition: times the group from its first start, live while any child works, to the latest end once none does. |
| counts the composer-side pill: 2/5 working, then 5 done | KEEP | Six-bar file evidence above; unique failure/condition: counts the composer-side pill: 2/5 working, then 5 done. |
| cuts the live preview to one line of at most the preview length | KEEP | Six-bar file evidence above; unique failure/condition: cuts the live preview to one line of at most the preview length. |
| names a closed child by the call's title and an open one by its live tab | KEEP | Six-bar file evidence above; unique failure/condition: names a closed child by the call's title and an open one by its live tab. |
| lists only delegates of this parent, oldest first, and those waiting for their user | KEEP | Six-bar file evidence above; unique failure/condition: lists only delegates of this parent, oldest first, and those waiting for their user. |

## packages/ui/src/lib/agent-chat/drill-in.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6. Stable seam/callers: drillInTimelineRows consumed by AgentDrillIn.

Recognizable failures: showing another agent’s work, losing shell output or launch context, stale task state or incorrect per-launch timing/folding. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| re-derives when only the context moved: the agent settling settles its words | KEEP | Six-bar file evidence above; unique failure/condition: re-derives when only the context moved: the agent settling settles its words. |
| keeps only the selected child's rows when the agent selection changes | KEEP | Six-bar file evidence above; unique failure/condition: keeps only the selected child's rows when the agent selection changes. |
| once the thought settles, its fold closes on its final duration | KEEP | Six-bar file evidence above; unique failure/condition: once the thought settles, its fold closes on its final duration. |
| a completed call and one still running: the running one is live (probe 1 B) | KEEP | Six-bar file evidence above; unique failure/condition: a completed call and one still running: the running one is live (probe 1 B). |
| a live agent a call blocked on an approval still shows: an in-progress call on no turn at all | KEEP | Six-bar file evidence above; unique failure/condition: a live agent a call blocked on an approval still shows: an in-progress call on no turn at all. |
| with nothing in progress the list ends with the placeholder, timed from the run's start | KEEP | Six-bar file evidence above; unique failure/condition: with nothing in progress the list ends with the placeholder, timed from the run's start. |
| a live agent with no rows yet is never an empty timeline | KEEP | Six-bar file evidence above; unique failure/condition: a live agent with no rows yet is never an empty timeline. |
| a streaming thought is an active group, with no fold coming and going (probes 1 D, 5) | KEEP | Six-bar file evidence above; unique failure/condition: a streaming thought is an active group, with no fold coming and going (probes 1 D, 5). |
| only its CURRENT run unfolds: a run before it keeps its fold | KEEP | Six-bar file evidence above; unique failure/condition: only its CURRENT run unfolds: a run before it keeps its fold. |
| a nested agent's live batch is the live spawn row (probe 6) | KEEP | Six-bar file evidence above; unique failure/condition: a nested agent's live batch is the live spawn row (probe 6). |
| a settled agent renders as before: no placeholder, no live row, its turns folded | KEEP | Six-bar file evidence above; unique failure/condition: a settled agent renders as before: no placeholder, no live row, its turns folded. |
| a live session is part of it: an agent the roster still says runs, on a dead session, reads settled | KEEP | Six-bar file evidence above; unique failure/condition: a live session is part of it: an agent the roster still says runs, on a dead session, reads settled. |
| a loop or a goal drives work and does none: its drill-in never reads as working | KEEP | Six-bar file evidence above; unique failure/condition: a loop or a goal drives work and does none: its drill-in never reads as working. |
| a toggle's patch becomes the collapsed list: closing adds the turn, opening removes it | KEEP | Six-bar file evidence above; unique failure/condition: a toggle's patch becomes the collapsed list: closing adds the turn, opening removes it. |
| a relaunch's prompt heads the current run; the run before it folds under its own prompt | KEEP | Six-bar file evidence above; unique failure/condition: a relaunch's prompt heads the current run; the run before it folds under its own prompt. |
| a prompt is never mistaken for the thread's own `/compact`: it renders whatever it says | KEEP | Six-bar file evidence above; unique failure/condition: a prompt is never mistaken for the thread's own `/compact`: it renders whatever it says. |
| a background agent whose first rows rode no turn: a later turn's fold is its own rows' span | KEEP | Six-bar file evidence above; unique failure/condition: a background agent whose first rows rode no turn: a later turn's fold is its own rows' span. |
| and so while the agent is live on a third run: the earlier runs' folds keep their own spans | KEEP | Six-bar file evidence above; unique failure/condition: and so while the agent is live on a third run: the earlier runs' folds keep their own spans. |
| the thread's own timeline is unchanged: its prompt still times a turn whose first rows rode none | KEEP | Six-bar file evidence above; unique failure/condition: the thread's own timeline is unchanged: its prompt still times a turn whose first rows rode none. |
| each run folds and is timed on its own, under its own prompt | KEEP | Six-bar file evidence above; unique failure/condition: each run folds and is timed on its own, under its own prompt. |
| the first run's last answer is terminal in its run: its meta shows, and it is no fold's hidden commentary | KEEP | Six-bar file evidence above; unique failure/condition: the first run's last answer is terminal in its run: its meta shows, and it is no fold's hidden commentary. |
| collapsing one run's fold hides that run's work alone | KEEP | Six-bar file evidence above; unique failure/condition: collapsing one run's fold hides that run's work alone. |
| expanding one group in place of another re-derives the rows | KEEP | Six-bar file evidence above; unique failure/condition: expanding one group in place of another re-derives the rows. |
| the roster's row while it has one — the newer, and current — and the row last seen once the roster drops it | KEEP | Six-bar file evidence above; unique failure/condition: the roster's row while it has one — the newer, and current — and the row last seen once the roster drops it. |
| a remembered row of another agent is none of this one's | KEEP | Six-bar file evidence above; unique failure/condition: a remembered row of another agent is none of this one's. |

## packages/ui/src/lib/agent-chat/entries.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.2,7.3,7.6; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §1.5; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §7.3. Stable seam/callers: deriveTimelineEntriesFromItems/deriveWorkLogEntries consumed by store.ts/rows.logic.ts.

Recognizable failures: lost or duplicated output, cross-agent attribution, malformed history data, incorrect request provenance, goal and tool reference extraction. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| promotes only the allow-listed payload fields | KEEP | Six-bar file evidence above; unique failure/condition: promotes only the allow-listed payload fields. |
| promotes an Agent Profile switch as IDS (null = Global), never a name | KEEP | Six-bar file evidence above; unique failure/condition: promotes an Agent Profile switch as IDS (null = Global), never a name. |
| promotes the §3.4 account switch as IDS, never a label | KEEP | Six-bar file evidence above; unique failure/condition: promotes the §3.4 account switch as IDS, never a label. |
| reads a continued chat's source off its thread.forked row; an ordinary fork's row has none | KEEP | Six-bar file evidence above; unique failure/condition: reads a continued chat's source off its thread.forked row; an ordinary fork's row has none. |
| drops the kinds that have their own surfaces | KEEP | Six-bar file evidence above; unique failure/condition: drops the kinds that have their own surfaces. |
| hides routine hooks but keeps failed and cancelled hooks | KEEP | Six-bar file evidence above; unique failure/condition: hides routine hooks but keeps failed and cancelled hooks. |
| collapses one tool call's in-progress and completed updates into one row | KEEP | Six-bar file evidence above; unique failure/condition: collapses one tool call's in-progress and completed updates into one row. |
| collapses a spawn batch into ONE row anchored at the spawn point | KEEP | Six-bar file evidence above; unique failure/condition: collapses a spawn batch into ONE row anchored at the spawn point. |
| collapses a Claude workflow run — coordinator and `:wf:` members — into ONE row | KEEP | Six-bar file evidence above; unique failure/condition: collapses a Claude workflow run — coordinator and `:wf:` members — into ONE row. |
| a background task's start is no row, and its launch call keeps its own; an agent's replaces it | KEEP | Six-bar file evidence above; unique failure/condition: a background task's start is no row, and its launch call keeps its own; an agent's replaces it. |
| is dropped once an update, a completion or a denial of the call is in the input, before or after it | KEEP | Six-bar file evidence above; unique failure/condition: is dropped once an update, a completion or a denial of the call is in the input, before or after it. |
| an unkeyed start, and a start with neither a turn nor an owner, are dropped as before | KEEP | Six-bar file evidence above; unique failure/condition: an unkeyed start, and a start with neither a turn nor an owner, are dropped as before. |
| an ExitPlanMode start is a plan boundary like the call's other rows, not a tool row | KEEP | Six-bar file evidence above; unique failure/condition: an ExitPlanMode start is a plan boundary like the call's other rows, not a tool row. |
| a detail that only looks like the echo is kept whole: an OpenCode completion's output, "config: {}" | KEEP | Six-bar file evidence above; unique failure/condition: a detail that only looks like the echo is kept whole: an OpenCode completion's output, "config: {}". |
| a start never offers Load full output: what the read cut there is the call's input, not its output | KEEP | Six-bar file evidence above; unique failure/condition: a start never offers Load full output: what the read cut there is the call's input, not its output. |
| a chunk is headed like its call's row when a lifecycle row of the call is in the input: its command and title | KEEP | Six-bar file evidence above; unique failure/condition: a chunk is headed like its call's row when a lifecycle row of the call is in the input: its command and title. |
| a chunk takes its call's command from the row's `data` when the row names none of its own | KEEP | Six-bar file evidence above; unique failure/condition: a chunk takes its call's command from the row's `data` when the row names none of its own. |
| a chunk of a command's output says so; a file change's result text, or a chunk naming no call, never | KEEP | Six-bar file evidence above; unique failure/condition: a chunk of a command's output says so; a file change's result text, or a chunk naming no call, never. |
| every lifecycle row of a call whose command output the input holds says so, wherever its chunks lie | KEEP | Six-bar file evidence above; unique failure/condition: every lifecycle row of a call whose command output the input holds says so, wherever its chunks lie. |
| a command that streamed nothing, and a file change whose result text streamed, say nothing | KEEP | Six-bar file evidence above; unique failure/condition: a command that streamed nothing, and a file change whose result text streamed, say nothing. |
| a Claude background shell's rows say so with no chunk in view: its output only ever streams | KEEP | Six-bar file evidence above; unique failure/condition: a Claude background shell's rows say so with no chunk in view: its output only ever streams. |
| folds an answered question out of the message list | KEEP | Six-bar file evidence above; unique failure/condition: folds an answered question out of the message list. |
| folds a proposed plan out of the activity stream into its own entry | KEEP | Six-bar file evidence above; unique failure/condition: folds a proposed plan out of the activity stream into its own entry. |
| retires a proposal by the turn that implements it, not by a click | KEEP | Six-bar file evidence above; unique failure/condition: retires a proposal by the turn that implements it, not by a click. |
| marks a proposal whose markdown the wire cut at 16 KiB (§5.6), and only that one | KEEP | Six-bar file evidence above; unique failure/condition: marks a proposal whose markdown the wire cut at 16 KiB (§5.6), and only that one. |
| keeps the rows the drill-in's own agent owns and still drops every other agent's | KEEP | Six-bar file evidence above; unique failure/condition: keeps the rows the drill-in's own agent owns and still drops every other agent's. |
| a tool.output chunk becomes the entry's detail, untrimmed | KEEP | Six-bar file evidence above; unique failure/condition: a tool.output chunk becomes the entry's detail, untrimmed. |
| a stamped chunk never enters the parent's entries and joins its agent's completion row | KEEP | Six-bar file evidence above; unique failure/condition: a stamped chunk never enters the parent's entries and joins its agent's completion row. |
| an UNSTAMPED chunk of an agent's call — an older log — follows its call's owner | KEEP | Six-bar file evidence above; unique failure/condition: an UNSTAMPED chunk of an agent's call — an older log — follows its call's owner. |
| an unstamped chunk follows its call's owner when only the payload names it | KEEP | Six-bar file evidence above; unique failure/condition: an unstamped chunk follows its call's owner when only the payload names it. |
| an unstamped PARENT chunk still joins its parent row | KEEP | Six-bar file evidence above; unique failure/condition: an unstamped PARENT chunk still joins its parent row. |
| derives the agent's assistant row in its entries and never in the parent's | KEEP | Six-bar file evidence above; unique failure/condition: derives the agent's assistant row in its entries and never in the parent's. |
| the child's drill-in: its own call, and no bot row for itself | KEEP | Six-bar file evidence above; unique failure/condition: the child's drill-in: its own call, and no bot row for itself. |
| drops `progress` from the work log and keeps every other change | KEEP | Six-bar file evidence above; unique failure/condition: drops `progress` from the work log and keeps every other change. |
| keeps a goal row it cannot read as the generic row, with its summary (goals §9) | KEEP | Six-bar file evidence above; unique failure/condition: keeps a goal row it cannot read as the generic row, with its summary (goals §9). |
| a host `/goal` answer and a failed goal command are generic info and error rows | KEEP | Six-bar file evidence above; unique failure/condition: a host `/goal` answer and a failed goal command are generic info and error rows. |
| a projection that starts repairing is rebuilt, not served from the unrepaired memo | KEEP | Six-bar file evidence above; unique failure/condition: a projection that starts repairing is rebuilt, not served from the unrepaired memo. |
| labels a row the host marked as its own session tool's, under every provider's shape | KEEP | Six-bar file evidence above; unique failure/condition: labels a row the host marked as its own session tool's, under every provider's shape. |
| links a thread or delegation tool's row to the thread its result names (threadRef) | KEEP | Six-bar file evidence above; unique failure/condition: links a thread or delegation tool's row to the thread its result names (threadRef). |
| labels the visual-replies tools in words: a preview, and a render while it runs or when it failed | KEEP | Six-bar file evidence above; unique failure/condition: labels the visual-replies tools in words: a preview, and a render while it runs or when it failed. |
| a gated call's row reads its toolApproval reference (unified MCP §7.3); an unmarked row never does | KEEP | Six-bar file evidence above; unique failure/condition: a gated call's row reads its toolApproval reference (unified MCP §7.3); an unmarked row never does. |
| a request_secret row reads its record — name and outcome, never a value | KEEP | Six-bar file evidence above; unique failure/condition: a request_secret row reads its record — name and outcome, never a value. |
| leaves every unmarked MCP call alone — a user's same-named external server's included | KEEP | Six-bar file evidence above; unique failure/condition: leaves every unmarked MCP call alone — a user's same-named external server's included. |
| a streamed answer that ends as a copy of its turn's opening one leaves the streamed-text path | KEEP | Six-bar file evidence above; unique failure/condition: a streamed answer that ends as a copy of its turn's opening one leaves the streamed-text path. |

## packages/ui/src/lib/agent-chat/full-output.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.6,6.3,7.6. Stable seam/callers: viewer read/content selection consumed by timeline/row-chrome.ts and ChatTimeline.

Recognizable failures: showing a cut preview as whole output, treating running output as complete, losing legacy readback fallback, stale viewer reads or prompt JSON instead of prompt text. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| shows the whole output of a command whose early chunks the window evicted, not what it still holds | KEEP | Six-bar file evidence above; unique failure/condition: shows the whole output of a command whose early chunks the window evicted, not what it still holds. |
| a running call's output is what exists now, and a join past the host's cap is its head: both said | KEEP | Six-bar file evidence above; unique failure/condition: a running call's output is what exists now, and a join past the host's cap is its head: both said. |
| reads the item where the host has no join (a 404) or the call streamed nothing: never an error | KEEP | Six-bar file evidence above; unique failure/condition: reads the item where the host has no join (a 404) or the call streamed nothing: never an error. |
| a row whose payload the wire cut reads its item alone: the join is never asked | KEEP | Six-bar file evidence above; unique failure/condition: a row whose payload the wire cut reads its item alone: the join is never asked. |
| a join read that fails is the viewer's error, not a quiet fallback | KEEP | Six-bar file evidence above; unique failure/condition: a join read that fails is the viewer's error, not a quiet fallback. |
| reads the call's join before its item's head: the host holds the whole output | KEEP | Six-bar file evidence above; unique failure/condition: reads the call's join before its item's head: the host holds the whole output. |
| shows the head as the command printed it, saying only part was kept, where no join answers | KEEP | Six-bar file evidence above; unique failure/condition: shows the head as the command printed it, saying only part was kept, where no join answers. |
| a completion that kept its whole output still reads it, and never asks the join | KEEP | Six-bar file evidence above; unique failure/condition: a completion that kept its whole output still reads it, and never asks the join. |
| an update stored cut reads the join too, then (nothing streamed) its payload, never its preview | KEEP | Six-bar file evidence above; unique failure/condition: an update stored cut reads the join too, then (nothing streamed) its payload, never its preview. |
| with no join to give, shows the part the tool kept as text, saying only part was kept — never that it is the start | KEEP | Six-bar file evidence above; unique failure/condition: with no join to give, shows the part the tool kept as text, saying only part was kept — never that it is the start. |
| anything else as the viewer always showed it: a message's text, a string payload, JSON, else the summary | KEEP | Six-bar file evidence above; unique failure/condition: anything else as the viewer always showed it: a message's text, a string payload, JSON, else the summary. |
| a new read retires the one before it, and closing the viewer retires the last | KEEP | Six-bar file evidence above; unique failure/condition: a new read retires the one before it, and closing the viewer retires the last. |
| shows the prompt itself, never its launch row as JSON | KEEP | Six-bar file evidence above; unique failure/condition: shows the prompt itself, never its launch row as JSON. |
| a task row is no tool output: the prompt has its own read, the prompt row's | KEEP | Six-bar file evidence above; unique failure/condition: a task row is no tool output: the prompt has its own read, the prompt row's. |

## packages/ui/src/lib/agent-chat/goal.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-24-agent-goals-design.md §§5.7,8.3,9. Stable seam/callers: goalSummaryMarker/isGoalHeldForUpdate consumed by goal chip/account controls/session status dot.

Recognizable failures: stale deploy-hold markers, invalid old-host goals crashing typed state, ended goals appearing active or broken Unicode in bounded accessible names. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| draws nothing for no goal or a finished one | KEEP | Six-bar file evidence above; unique failure/condition: draws nothing for no goal or a finished one. |
| validates the wire field-wise: anything it cannot read draws nothing, never a crash | KEEP | Six-bar file evidence above; unique failure/condition: validates the wire field-wise: anything it cannot read draws nothing, never a crash. |
| never splits a surrogate pair | KEEP | Six-bar file evidence above; unique failure/condition: never splits a surrogate pair. |
| paused in the fold while the host still reports it continuing: held | KEEP | Six-bar file evidence above; unique failure/condition: paused in the fold while the host still reports it continuing: held. |
| paused and NOT continuing is an ordinary pause — the user's, a Stop's, a stall's | KEEP | Six-bar file evidence above; unique failure/condition: paused and NOT continuing is an ordinary pause — the user's, a Stop's, a stall's. |
| an active goal is never held — the chip reads the fold, whatever the summary still says | KEEP | Six-bar file evidence above; unique failure/condition: an active goal is never held — the chip reads the fold, whatever the summary still says. |
| the head's mark decides only when the view has no summary verdict | KEEP | Six-bar file evidence above; unique failure/condition: the head's mark decides only when the view has no summary verdict. |
| a summary that has not caught up with the fold's pause is not a hold | KEEP | Six-bar file evidence above; unique failure/condition: a summary that has not caught up with the fold's pause is not a hold. |
| only a paused goal can be held: no goal, or one that stopped some other way, is not | KEEP | Six-bar file evidence above; unique failure/condition: only a paused goal can be held: no goal, or one that stopped some other way, is not. |
| reads the summary field-wise: what is not a verdict leaves the head's mark to decide | KEEP | Six-bar file evidence above; unique failure/condition: reads the summary field-wise: what is not a verdict leaves the head's mark to decide. |

## packages/ui/src/lib/agent-chat/gone.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3 THREAD_NOT_FOUND and chat-creation lifecycle; README chat sessions. Stable seam/callers: GoneWatches/goneDisplay/nextGoneWatch consumed by AgentChatView.

Recognizable failures: newly-created chats falsely reported gone, missing confirmation reconnects or infinite retry loops on a genuinely absent thread. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| THREAD_NOT_FOUND while pending is "starting"; the confirming update reconnects it | KEEP | Six-bar file evidence above; unique failure/condition: THREAD_NOT_FOUND while pending is "starting"; the confirming update reconnects it. |
| the host confirmed before the stream met the miss: one retry, no gone notice | KEEP | Six-bar file evidence above; unique failure/condition: the host confirmed before the stream met the miss: one retry, no gone notice. |
| a thread that is really gone says so after that one retry | KEEP | Six-bar file evidence above; unique failure/condition: a thread that is really gone says so after that one retry. |
| an old tab whose thread is gone is gone at once, and retries when its record changes | KEEP | Six-bar file evidence above; unique failure/condition: an old tab whose thread is gone is gone at once, and retries when its record changes. |
| the record stopped being pending while no view watched: starting, and one retry | KEEP | Six-bar file evidence above; unique failure/condition: the record stopped being pending while no view watched: starting, and one retry. |
| an old tab's record changed while no view watched: starting, and one retry | KEEP | Six-bar file evidence above; unique failure/condition: an old tab's record changed while no view watched: starting, and one retry. |
| nothing changed while unmounted: still gone, no retry | KEEP | Six-bar file evidence above; unique failure/condition: nothing changed while unmounted: still gone, no retry. |

## packages/ui/src/lib/agent-chat/grok-spawn-rows.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 quiet parent timeline; Grok launch protocol fixtures. Stable seam/callers: deriveWorkLogEntries consumed by parent timeline.

Recognizable failures: duplicate launcher rows or disappearance of the only failed-launch signal. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| is the agent's row: the launch call's own rows are hidden behind it | KEEP | Six-bar file evidence above; unique failure/condition: is the agent's row: the launch call's own rows are hidden behind it. |
| keeps a failed launch visible — the only terminal signal must not vanish | KEEP | Six-bar file evidence above; unique failure/condition: keeps a failed launch visible — the only terminal signal must not vanish. |

## packages/ui/src/lib/agent-chat/history.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md client/history pages; docs/superpowers/specs/2026-09-23-fold-performance-design.md history bridge; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.3,7.6. Stable seam/callers: history selectors/projections consumed by store.ts and reducer.logic.ts.

Recognizable failures: history gaps or duplicates at live-window boundaries, stale cursors after eviction, incorrect rewind ownership or lost completed data. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| offers nothing for a malformed bounds block rather than a broken button | KEEP | Six-bar file evidence above; unique failure/condition: offers nothing for a malformed bounds block rather than a broken button. |
| is read with the bounds when it is a cursor, and is none otherwise | KEEP | Six-bar file evidence above; unique failure/condition: is read with the bounds when it is a cursor, and is none otherwise. |
| rides a cursorless first page only: once the window evicted, or with no cursor left | KEEP | Six-bar file evidence above; unique failure/condition: rides a cursorless first page only: once the window evicted, or with no cursor left. |
| lists every page's items once, oldest page first — the newest page's copy of anything but a message | KEEP | Six-bar file evidence above; unique failure/condition: lists every page's items once, oldest page first — the newest page's copy of anything but a message. |
| keeps the LONGER text of a message two pages share — never a concatenation | KEEP | Six-bar file evidence above; unique failure/condition: keeps the LONGER text of a message two pages share — never a concatenation. |
| renders a stable-id row the bridge received twice at its first place, with its last content | KEEP | Six-bar file evidence above; unique failure/condition: renders a stable-id row the bridge received twice at its first place, with its last content. |
| hands over a denial that closes a call a page began, so its start never renders running in the history | KEEP | Six-bar file evidence above; unique failure/condition: hands over a denial that closes a call a page began, so its start never renders running in the history. |
| hands over the later rows of a task whose launch row lies before the cut | KEEP | Six-bar file evidence above; unique failure/condition: hands over the later rows of a task whose launch row lies before the cut. |
| keeps a spawn batch whole when the cut falls between its launch rows | KEEP | Six-bar file evidence above; unique failure/condition: keeps a spawn batch whole when the cut falls between its launch rows. |
| drops them for a bridge prompt whose turn the rewind removes — a prompt carries no turn id | KEEP | Six-bar file evidence above; unique failure/condition: drops them for a bridge prompt whose turn the rewind removes — a prompt carries no turn id. |
| drops them for a turn-less prompt a page shows that no kept turn claims — the fold's fallback may drop it | KEEP | Six-bar file evidence above; unique failure/condition: drops them for a turn-less prompt a page shows that no kept turn claims — the fold's fallback may drop it. |
| drops them for such a prompt on the bridge too | KEEP | Six-bar file evidence above; unique failure/condition: drops them for such a prompt on the bridge too. |
| keeps them for a page's prompt a kept turn claims, and for a subagent's turn-less words | KEEP | Six-bar file evidence above; unique failure/condition: keeps them for a page's prompt a kept turn claims, and for a subagent's turn-less words. |
| notes nothing when the window only dropped rows the parent timeline never showed | KEEP | Six-bar file evidence above; unique failure/condition: notes nothing when the window only dropped rows the parent timeline never showed. |
| keeps only the rows the parent timeline renders — an agent's own rows live in its drill-in | KEEP | Six-bar file evidence above; unique failure/condition: keeps only the rows the parent timeline renders — an agent's own rows live in its drill-in. |
| recounts the cut when a rewind confined to the window removes a row before it | KEEP | Six-bar file evidence above; unique failure/condition: recounts the cut when a rewind confined to the window removes a row before it. |
| takes whichever rule reaches further, and falls back when the window no longer holds that row | KEEP | Six-bar file evidence above; unique failure/condition: takes whichever rule reaches further, and falls back when the window no longer holds that row. |
| reads the page's end field-wise — a string or null as sent, anything else as absent | KEEP | Six-bar file evidence above; unique failure/condition: reads the page's end field-wise — a string or null as sent, anything else as absent. |
| drops the OLDEST pages first, and 'load older' then asks for exactly the block that went | KEEP | Six-bar file evidence above; unique failure/condition: drops the OLDEST pages first, and 'load older' then asks for exactly the block that went. |
| never drops the newest page on its own: past the cap with it, everything goes and fresh bounds are asked for | KEEP | Six-bar file evidence above; unique failure/condition: never drops the newest page on its own: past the cap with it, everything goes and fresh bounds are asked for. |
| drops everything when the bridge alone passes the cap | KEEP | Six-bar file evidence above; unique failure/condition: drops everything when the bridge alone passes the cap. |
| a goal marker is a row its turn owns (goals §8.4) | KEEP | Six-bar file evidence above; unique failure/condition: a goal marker is a row its turn owns (goals §8.4). |
| drops an old Claude log's re-emitted copy from the history rows when the store asks | KEEP | Six-bar file evidence above; unique failure/condition: drops an old Claude log's re-emitted copy from the history rows when the store asks. |
| keeps a turn's work in log order across a page boundary | KEEP | Six-bar file evidence above; unique failure/condition: keeps a turn's work in log order across a page boundary. |
| a running turn's answer up here still streams | KEEP | Six-bar file evidence above; unique failure/condition: a running turn's answer up here still streams. |
| is withheld where the index and the fold disagree about the turn's place | KEEP | Six-bar file evidence above; unique failure/condition: is withheld where the index and the fold disagree about the turn's place. |
| is withheld on every page once the live window holds a settled compaction | KEEP | Six-bar file evidence above; unique failure/condition: is withheld on every page once the live window holds a settled compaction. |
| reads a turn listed on two pages by the newest page's copy | KEEP | Six-bar file evidence above; unique failure/condition: reads a turn listed on two pages by the newest page's copy. |
| offers rewind on a prompt that came through the bridge by the fold's own numbering; a page prompt stays gated | KEEP | Six-bar file evidence above; unique failure/condition: offers rewind on a prompt that came through the bridge by the fold's own numbering; a page prompt stays gated. |
| anchors a spawn row on the window's launch row, not on a progress row the bridge got after it | KEEP | Six-bar file evidence above; unique failure/condition: anchors a spawn row on the window's launch row, not on a progress row the bridge got after it. |
| this client's fold evicted rows since that snapshot — any row, an agent's included | KEEP | Six-bar file evidence above; unique failure/condition: this client's fold evicted rows since that snapshot — any row, an agent's included. |
| recounts the window cut over the replaced list: rows the frame put before it count, rows it took out do not | KEEP | Six-bar file evidence above; unique failure/condition: recounts the window cut over the replaced list: rows the frame put before it count, rows it took out do not. |

## packages/ui/src/lib/agent-chat/hooks.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 status timer and settled session/turn states. Stable seam/callers: useAgentChatStatus actual React consumer backed by retained thread store.

Recognizable failures: elapsed status clock continues after a turn/session settles or loses its active turn start. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| ticks only while the turn is unsettled AND the session is live | KEEP | Six-bar file evidence above; unique failure/condition: ticks only while the turn is unsettled AND the session is live. |
| stops on every settled turn state | KEEP | Six-bar file evidence above; unique failure/condition: stops on every settled turn state. |
| stops when the session left `running`, even if the turn row still says running | KEEP | Six-bar file evidence above; unique failure/condition: stops when the session left `running`, even if the turn row still says running. |

## packages/ui/src/lib/agent-chat/keybindings.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.4,7.5 documented shortcuts. Stable seam/callers: resolveChatShortcut consumed by composer/view keyboard handlers.

Recognizable failures: wrong destructive keyboard action, modifier collision or held-key repeat triggering extra commands. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| interrupts on a bare Escape | KEEP | Six-bar file evidence above; unique failure/condition: interrupts on a bare Escape. |
| sends the head of the queue on mod+Shift+Enter | KEEP | Six-bar file evidence above; unique failure/condition: sends the head of the queue on mod+Shift+Enter. |
| uses mod+Shift+M for the mode picker — mod+Shift+A is the Attention Center's | KEEP | Six-bar file evidence above; unique failure/condition: uses mod+Shift+M for the mode picker — mod+Shift+A is the Attention Center's. |
| opens the model and effort controls | KEEP | Six-bar file evidence above; unique failure/condition: opens the model and effort controls. |
| ignores a held key and an Alt chord | KEEP | Six-bar file evidence above; unique failure/condition: ignores a held key and an Alt chord. |
| ignores an unbound chord | KEEP | Six-bar file evidence above; unique failure/condition: ignores an unbound chord. |

## packages/ui/src/lib/agent-chat/lineage.logic.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §4.1. Stable seam/callers: lineage selectors/ForkRetryKeys consumed by lineage UI and app store forkChatTab.

Recognizable failures: wrong parent/child links, another agent’s answer offered for merge, stale fork IDs after selective closure or unknown relation counts disappearing. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| finds the parent and the children, oldest first | KEEP | Six-bar file evidence above; unique failure/condition: finds the parent and the children, oldest first. |
| words the relation and a child's status | REWRITE | Remove repeated fork/delegate caption checks; keep child work/input/settled state selection. Relation captions already owned by opened-chat case. |
| offers the last finished answer of the main conversation | KEEP | Six-bar file evidence above; unique failure/condition: offers the last finished answer of the main conversation. |
| offers a reply whose stream a dead host or an ended turn left open | KEEP | Six-bar file evidence above; unique failure/condition: offers a reply whose stream a dead host or an ended turn left open. |
| closing a fork forgets only the kept id of the point it was forked from | KEEP | Six-bar file evidence above; unique failure/condition: closing a fork forgets only the kept id of the point it was forked from. |
| a fork with no recorded point forgets every kept id of its parent; a delegate forgets none | KEEP | Six-bar file evidence above; unique failure/condition: a fork with no recorded point forgets every kept id of its parent; a delegate forgets none. |
| closing the parent forgets every kept id taken from it | KEEP | Six-bar file evidence above; unique failure/condition: closing the parent forgets every kept id taken from it. |
| an answered fork frees its point; an unknown outcome keeps it | DELETE | Fails unique-protection bar: actual app-store fork workflow verifies reused id after HOST_UNAVAILABLE/network failure and fresh id after success/refusal. Owner: packages/ui/src/store/fork-retry.test.ts: first two forkChatTab retry cases. |
| read as opened, never as forks | KEEP | Six-bar file evidence above; unique failure/condition: read as opened, never as forks. |
| a parent counts its children by relation | KEEP | Six-bar file evidence above; unique failure/condition: a parent counts its children by relation. |

## packages/ui/src/lib/agent-chat/mcp-app-actions.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §3 app consent/security; README secrets and authenticated daemon boundaries. Stable seam/callers: app action callbacks/consent queue consumed by McpAppFrame and ChatBannerDock.

Recognizable failures: an unapproved tool/message/download runs, a hidden tool becomes callable, wrong-server download or post-unmount action bypasses consent. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| a read-only tool runs without asking | KEEP | Six-bar file evidence above; unique failure/condition: a read-only tool runs without asking. |
| any other tool waits on the user's consent, with its arguments shown | KEEP | Six-bar file evidence above; unique failure/condition: any other tool waits on the user's consent, with its arguments shown. |
| a declined tool never runs | KEEP | Six-bar file evidence above; unique failure/condition: a declined tool never runs. |
| a tool hidden from apps is refused before anyone is asked | KEEP | Six-bar file evidence above; unique failure/condition: a tool hidden from apps is refused before anyone is asked. |
| with no dock to ask, nothing runs and the app is told so | KEEP | Six-bar file evidence above; unique failure/condition: with no dock to ask, nothing runs and the app is told so. |
| a message always asks, then is sent as the user | KEEP | Six-bar file evidence above; unique failure/condition: a message always asks, then is sent as the user. |
| a download asks, reads a linked file from the app's server, and keeps the size bound | KEEP | Six-bar file evidence above; unique failure/condition: a download asks, reads a linked file from the app's server, and keeps the size bound. |
| reads and model context ask nothing; daemon refusals reach the app verbatim | KEEP | Six-bar file evidence above; unique failure/condition: reads and model context ask nothing; daemon refusals reach the app verbatim. |
| links open only while the app may act | KEEP | Six-bar file evidence above; unique failure/condition: links open only while the app may act. |
| the queue: one session's requests, withdrawn with their frame, unanswerable once the dock goes | KEEP | Six-bar file evidence above; unique failure/condition: the queue: one session's requests, withdrawn with their frame, unanswerable once the dock goes. |

## packages/ui/src/lib/agent-chat/mcp-app-consent.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §3 consent; GUI attention behavior. Stable seam/callers: McpAppConsentQueue.waiting/consentActivity/withConsentAttention consumed by frame/banner dock/app activity.

Recognizable failures: pending consent never raises attention, settled or withdrawn requests keep attention stuck, or another session’s activity is overwritten. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| the queue says which sessions wait, and since when, until answered | KEEP | Six-bar file evidence above; unique failure/condition: the queue says which sessions wait, and since when, until answered. |
| withdrawing the frame or unmounting the dock clears it | KEEP | Six-bar file evidence above; unique failure/condition: withdrawing the frame or unmounting the dock clears it. |
| a session that waits reads as needing input — the attention bucket | KEEP | Six-bar file evidence above; unique failure/condition: a session that waits reads as needing input — the attention bucket. |
| folds only the waiting sessions | KEEP | Six-bar file evidence above; unique failure/condition: folds only the waiting sessions. |

## packages/ui/src/lib/agent-chat/mcp-app-host.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §3 MCP Apps protocol/security; public MCP Apps method/style names. Stable seam/callers: McpAppHost request/notification interface consumed by McpAppFrame.

Recognizable failures: incorrect initialization/call results, unsupported unsafe links/messages, invalid display mode, unbounded requests, stale teardown or broken standardized style variables. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| initialize answers the host's capabilities and context, then replays the call once initialized | KEEP | Six-bar file evidence above; unique failure/condition: initialize answers the host's capabilities and context, then replays the call once initialized. |
| model context is not offered where the agent cannot take it | KEEP | Six-bar file evidence above; unique failure/condition: model context is not offered where the agent cannot take it. |
| tools/call and resources/read reach the callbacks; results are normalised | KEEP | Six-bar file evidence above; unique failure/condition: tools/call and resources/read reach the callbacks; results are normalised. |
| a refusal's message reaches the app as the error | KEEP | Six-bar file evidence above; unique failure/condition: a refusal's message reaches the app as the error. |
| only http(s) links open and only user text messages are sent | KEEP | Six-bar file evidence above; unique failure/condition: only http(s) links open and only user text messages are sent. |
| display modes switch only between modes both sides offer | KEEP | Six-bar file evidence above; unique failure/condition: display modes switch only between modes both sides offer. |
| host context changes are sent only after initialization, and only what changed | KEEP | Six-bar file evidence above; unique failure/condition: host context changes are sent only after initialization, and only what changed. |
| size, teardown requests and unknown methods | KEEP | Six-bar file evidence above; unique failure/condition: size, teardown requests and unknown methods. |
| an oversized message is refused and a disposed host posts nothing | KEEP | Six-bar file evidence above; unique failure/condition: an oversized message is refused and a disposed host posts nothing. |
| teardown waits for the app's answer, or resolves at once before initialization | KEEP | Six-bar file evidence above; unique failure/condition: teardown waits for the app's answer, or resolves at once before initialization. |
| too many requests in flight are refused, not queued | KEEP | Six-bar file evidence above; unique failure/condition: too many requests in flight are refused, not queued. |
| downloads are read from embedded resources and links | KEEP | Six-bar file evidence above; unique failure/condition: downloads are read from embedded resources and links. |
| theme tokens map to the spec's standardized style names | KEEP | Six-bar file evidence above; unique failure/condition: theme tokens map to the spec's standardized style names. |

## packages/ui/src/lib/agent-chat/persistent-cache.test.ts

Independent contract: AGENTS.md persisted state/privacy; README revocation; public ThreadCacheBackend contract; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3; docs/superpowers/specs/2026-09-23-fold-performance-design.md retained-window semantics. Stable seam/callers: linkThreadCache/loadPersistedThread/backend boundary consumed by store.ts; clearThreadCache consumed by sign-out/remove-remote flows.

Recognizable failures: cross-daemon content disclosure, revival after sign-out, malformed or old-version copies trusted, torn snapshot/cursor pairs, unbounded cache or blocked chat opening. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| names a daemon by kind and endpoint, ignoring a trailing slash | KEEP | Six-bar file evidence above; unique failure/condition: names a daemon by kind and endpoint, ignoring a trailing slash. |
| never lets two daemons share an entry, and clears one daemon's alone | KEEP | Six-bar file evidence above; unique failure/condition: never lets two daemons share an entry, and clears one daemon's alone. |
| links nothing for a transport bound to no connection, or with no storage | KEEP | Six-bar file evidence above; unique failure/condition: links nothing for a transport bound to no connection, or with no storage. |
| ignores and deletes a record of another format or fold version | KEEP | Six-bar file evidence above; unique failure/condition: ignores and deletes a record of another format or fold version. |
| ignores and deletes a record whose halves do not validate | KEEP | Six-bar file evidence above; unique failure/condition: ignores and deletes a record whose halves do not validate. |
| saves the window only, with a cursor-less bound once the window has evicted | KEEP | Six-bar file evidence above; unique failure/condition: saves the window only, with a cursor-less bound once the window has evicted. |
| keeps nothing of a headless, deleted or unfolded thread | KEEP | Six-bar file evidence above; unique failure/condition: keeps nothing of a headless, deleted or unfolded thread. |
| `keeps the ${THREAD_CACHE_MAX_ENTRIES} most recently used threads` | KEEP | Six-bar file evidence above; unique failure/condition: `keeps the ${THREAD_CACHE_MAX_ENTRIES} most recently used threads`. |
| keeps the total under the size bound, newest first | KEEP | Six-bar file evidence above; unique failure/condition: keeps the total under the size bound, newest first. |
| drops records it cannot read | KEEP | Six-bar file evidence above; unique failure/condition: drops records it cannot read. |
| evicts through a save | KEEP | Six-bar file evidence above; unique failure/condition: evicts through a save. |
| writes 500 ms after the first change, then at most once per 10 s | KEEP | Six-bar file evidence above; unique failure/condition: writes 500 ms after the first change, then at most once per 10 s. |
| never writes a state the host has not confirmed, nor one before any host | KEEP | Six-bar file evidence above; unique failure/condition: never writes a state the host has not confirmed, nor one before any host. |
| holds a changed host's state until its re-read lands | KEEP | Six-bar file evidence above; unique failure/condition: holds a changed host's state until its re-read lands. |
| writes what is pending when the generation closes — unless a clear came first | KEEP | Six-bar file evidence above; unique failure/condition: writes what is pending when the generation closes — unless a clear came first. |
| writes nothing while a turn runs, then once it settles — or as the page hides | KEEP | Six-bar file evidence above; unique failure/condition: writes nothing while a turn runs, then once it settles — or as the page hides. |
| never writes the device's own copy before the host confirmed it, even reconnecting | KEEP | Six-bar file evidence above; unique failure/condition: never writes the device's own copy before the host confirmed it, even reconnecting. |
| refuses a write once another tab cleared the scope | KEEP | Six-bar file evidence above; unique failure/condition: refuses a write once another tab cleared the scope. |
| does not rewrite the copy it was painted from | KEEP | Six-bar file evidence above; unique failure/condition: does not rewrite the copy it was painted from. |
| drops the entry when the host says the thread is gone, or it is deleted | KEEP | Six-bar file evidence above; unique failure/condition: drops the entry when the host says the thread is gone, or it is deleted. |
| does not keep a thread larger than the per-entry bound | KEEP | Six-bar file evidence above; unique failure/condition: does not keep a thread larger than the per-entry bound. |
| answers none after the bound when storage does not answer | KEEP | Six-bar file evidence above; unique failure/condition: answers none after the bound when storage does not answer. |
| answers none when storage fails | KEEP | Six-bar file evidence above; unique failure/condition: answers none when storage fails. |
| never touches a newer save back to the meta it read | KEEP | Six-bar file evidence above; unique failure/condition: never touches a newer save back to the meta it read. |
| touches what it reads, so it is the last to be evicted | KEEP | Six-bar file evidence above; unique failure/condition: touches what it reads, so it is the last to be evicted. |
| is absent without IndexedDB | KEEP | Six-bar file evidence above; unique failure/condition: is absent without IndexedDB. |
| reads back what it wrote, both halves, and removes both | KEEP | Six-bar file evidence above; unique failure/condition: reads back what it wrote, both halves, and removes both. |
| answers none where opening the database throws (a private mode) | KEEP | Six-bar file evidence above; unique failure/condition: answers none where opening the database throws (a private mode). |
| a partial copy is saved as its own version with whose rows it lacks, and restored with them | KEEP | Six-bar file evidence above; unique failure/condition: a partial copy is saved as its own version with whose rows it lacks, and restored with them. |
| a record whose version and omitted list disagree is not read | KEEP | Six-bar file evidence above; unique failure/condition: a record whose version and omitted list disagree is not read. |
| rewrites the copy when an agent's rows load, though its cursor did not move | KEEP | Six-bar file evidence above; unique failure/condition: rewrites the copy when an agent's rows load, though its cursor did not move. |

## packages/ui/src/lib/agent-chat/plan.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.6,7.3 plan state and full-plan copy/download. Stable seam/callers: plan selectors/wholePlanMarkdown consumed by plan card and composer follow-up.

Recognizable failures: wrong turn’s plan, disappearing follow-up plan, malformed steps crashing view, or copying/downloading cut plan text. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| prefers the current turn's plan | KEEP | Six-bar file evidence above; unique failure/condition: prefers the current turn's plan. |
| falls back to the most recent plan from ANY turn so a follow-up does not blank it | KEEP | Six-bar file evidence above; unique failure/condition: falls back to the most recent plan from ANY turn so a follow-up does not blank it. |
| is null when no plan was ever reported | KEEP | Six-bar file evidence above; unique failure/condition: is null when no plan was ever reported. |
| tolerates a malformed step list | KEEP | Six-bar file evidence above; unique failure/condition: tolerates a malformed step list. |
| docks only under all five conditions | KEEP | Six-bar file evidence above; unique failure/condition: docks only under all five conditions. |
| picks the current turn's proposal, else the newest of any turn | KEEP | Six-bar file evidence above; unique failure/condition: picks the current turn's proposal, else the newest of any turn. |
| returns an intact plan synchronously without reading it | KEEP | Six-bar file evidence above; unique failure/condition: returns an intact plan synchronously without reading it. |
| reads a truncated proposal by id and never falls back to its cut text | KEEP | Six-bar file evidence above; unique failure/condition: reads a truncated proposal by id and never falls back to its cut text. |

## packages/ui/src/lib/agent-chat/presentation.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 running-output failure rule; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §7.1 After labels. Stable seam/callers: workEntryDisplayIndicatesToolFailure/workEntryDisplayLabel consumed by rows and ActivityRows.

Recognizable failures: ordinary in-progress output misreported as failure, missing denied/granted/not-delivered outcome or user denial reason/grant scope lost. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| an in-progress call is not failed by its output, however it reads | KEEP | Six-bar file evidence above; unique failure/condition: an in-progress call is not failed by its output, however it reads. |
| a gated call's row says how its card ended | REWRITE | Verify denial reason, grant scope and non-delivery through workEntryDisplayLabel consumed by UI; private outcome formatter no longer exported. Exact outcome labels are independently specified by unified MCP §7.1. |

## packages/ui/src/lib/agent-chat/providers.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§6.3,7.7 and additive surviving-host compatibility. Stable seam/callers: loadProviders/refreshProvider/providersStore consumed by app/store/composer.

Recognizable failures: misleading sign-in demands, missing installed-provider refresh, rate-limit attribution lost or older-host snapshot shape crashing every composer. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| says nothing at all for an `unknown` provider that merely is not installed | KEEP | Six-bar file evidence above; unique failure/condition: says nothing at all for an `unknown` provider that merely is not installed. |
| is silent for a PENDING snapshot — nobody has looked at that provider yet | KEEP | Six-bar file evidence above; unique failure/condition: is silent for a PENDING snapshot — nobody has looked at that provider yet. |
| says nothing at all for a healthy catalog | KEEP | Six-bar file evidence above; unique failure/condition: says nothing at all for a healthy catalog. |
| appends rather than silently dropping it | KEEP | Six-bar file evidence above; unique failure/condition: appends rather than silently dropping it. |
| still replaces one it already has | KEEP | Six-bar file evidence above; unique failure/condition: still replaces one it already has. |
| reports a snapshot's windows under each registry id it serves | KEEP | Six-bar file evidence above; unique failure/condition: reports a snapshot's windows under each registry id it serves. |
| toasts end-to-end when the host writes `auth: unauthenticated` | KEEP | Six-bar file evidence above; unique failure/condition: toasts end-to-end when the host writes `auth: unauthenticated`. |
| still surfaces `status: error` with auth unresolved — but never as a sign-in demand | KEEP | Six-bar file evidence above; unique failure/condition: still surfaces `status: error` with auth unresolved — but never as a sign-in demand. |
| stays silent for `status: degraded`, which is not a credential verdict | KEEP | Six-bar file evidence above; unique failure/condition: stays silent for `status: degraded`, which is not a credential verdict. |
| reports a refresh's auth error too, not just the catalog read | KEEP | Six-bar file evidence above; unique failure/condition: reports a refresh's auth error too, not just the catalog read. |
| defaults a missing `capabilities` block to the withholding shape | KEEP | Six-bar file evidence above; unique failure/condition: defaults a missing `capabilities` block to the withholding shape. |
| keeps what a partial `capabilities` block does carry | KEEP | Six-bar file evidence above; unique failure/condition: keeps what a partial `capabilities` block does carry. |
| defaults the list fields so `.map` on them cannot throw | KEEP | Six-bar file evidence above; unique failure/condition: defaults the list fields so `.map` on them cannot throw. |
| repairs a missing `auth` block into `unknown` rather than toasting or crashing | KEEP | Six-bar file evidence above; unique failure/condition: repairs a missing `auth` block into `unknown` rather than toasting or crashing. |
| drops only the rows that cannot be repaired, keeping the rest of the catalog | KEEP | Six-bar file evidence above; unique failure/condition: drops only the rows that cannot be repaired, keeping the rest of the catalog. |
| a row from the catalog read is repaired the same way | KEEP | Six-bar file evidence above; unique failure/condition: a row from the catalog read is repaired the same way. |

## packages/ui/src/lib/agent-chat/queue.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 client queue. Stable seam/callers: takeQueued/nextDueQueuedMessage/latestCompletedToolActivityId consumed by store.ts.

Recognizable failures: a queued message taken twice, sent while approval/question or initial connection blocks it, or released against wrong completed-call boundary. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| answers null when another caller already took it | KEEP | Six-bar file evidence above; unique failure/condition: answers null when another caller already took it. |
| guard 3: nothing flushes while a request is pending | REWRITE | Assert no due queued message through nextDueQueuedMessage, actual store-consumed boundary; private predicate no longer exported. |
| never sends while connecting — the gap between a send and pick-up | REWRITE | Assert no due queued message through nextDueQueuedMessage, actual store-consumed boundary; private predicate no longer exported. |
| picks the newest completed tool call, ignoring position | KEEP | Six-bar file evidence above; unique failure/condition: picks the newest completed tool call, ignoring position. |

## packages/ui/src/lib/agent-chat/reducer.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.1,6.3; docs/superpowers/specs/2026-09-24-agent-goals-design.md §4.4; packages/api/src/agent-chat/agent-rows.ts protocol. Stable seam/callers: applyFrame consumed by store.ts.

Recognizable failures: resolved requests reopen, absent/invalid goals trusted, replay-progress spinner stuck, wrong stream identity or agent rows lost across reconnect. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| re-tombstones resolved requests so a replayed request cannot reopen a card | KEEP | Six-bar file evidence above; unique failure/condition: re-tombstones resolved requests so a replayed request cannot reopen a card. |
| adopts the snapshot's goal, validated, and reads a missing one as none (goals §4.4) | KEEP | Six-bar file evidence above; unique failure/condition: adopts the snapshot's goal, validated, and reads a missing one as none (goals §4.4). |
| a snapshot's answers mark their requests answered until the resolution lands | KEEP | Six-bar file evidence above; unique failure/condition: a snapshot's answers mark their requests answered until the resolution lands. |
| shows a replay until it is done, and drops a stale one on (re)synchronizing | KEEP | Six-bar file evidence above; unique failure/condition: shows a replay until it is done, and drops a stale one on (re)synchronizing. |
| a snapshot's omitted agents are read field-wise, and a later snapshot without them clears them | KEEP | Six-bar file evidence above; unique failure/condition: a snapshot's omitted agents are read field-wise, and a later snapshot without them clears them. |
| a frame loads its agents, and the last of them leaves nothing omitted | KEEP | Six-bar file evidence above; unique failure/condition: a frame loads its agents, and the last of them leaves nothing omitted. |
| the stream's id comes with every synchronized marker, the live one's included | KEEP | Six-bar file evidence above; unique failure/condition: the stream's id comes with every synchronized marker, the live one's included. |
| a reconnect's snapshot that leaves a loaded agent out keeps its rows until the frame replaces them | KEEP | Six-bar file evidence above; unique failure/condition: a reconnect's snapshot that leaves a loaded agent out keeps its rows until the frame replaces them. |
| carries nothing over a snapshot that rewound a turn or went back, nor for an agent never loaded | KEEP | Six-bar file evidence above; unique failure/condition: carries nothing over a snapshot that rewound a turn or went back, nor for an agent never loaded. |
| a truncated frame marks its agent, a whole one clears the mark | KEEP | Six-bar file evidence above; unique failure/condition: a truncated frame marks its agent, a whole one clears the mark. |

## packages/ui/src/lib/agent-chat/resume-compaction.logic.test.ts

Independent contract: packages/config/src configuration schema idle-compaction modes; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md compaction/send lifecycle. Stable seam/callers: resumeCompactionOffer/compactsBeforeSend/sendAfterCompaction consumed by composer.

Recognizable failures: a warm/busy/wrong-provider chat compacts unexpectedly, typed /compact executes twice, refused compaction loses send or send errors get swallowed. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| a large Claude chat whose cache expired offers to compact, with its size | KEEP | Six-bar file evidence above; unique failure/condition: a large Claude chat whose cache expired offers to compact, with its size. |
| no offer while the cache is warm, its expiry unknown, the chat small or busy, another agent, or Never | KEEP | Six-bar file evidence above; unique failure/condition: no offer while the cache is warm, its expiry unknown, the chat small or busy, another agent, or Never. |
| the offer's own wake is the expiry, only while it is ahead | KEEP | Six-bar file evidence above; unique failure/condition: the offer's own wake is the expiry, only while it is ahead. |
| a send under the offer compacts first, and a refused compaction still sends | REWRITE | Constrain failed-send propagation to original refusal object; an unrelated rejection can no longer satisfy negative assertion. |
| a typed /compact, bare or instructed, never gets a bare compaction first | KEEP | Six-bar file evidence above; unique failure/condition: a typed /compact, bare or instructed, never gets a bare compaction first. |

## packages/ui/src/lib/agent-chat/rewind.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.5 rewind and double-Escape confirmation. Stable seam/callers: rewind targets/escape-sequence API consumed by thread rewind controls.

Recognizable failures: wrong user prompt offered as a rewind target, wrong dropped-turn count or accidental first/late Escape triggers destructive rewind. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| lists rewindable user messages newest first, with the turns each drops | KEEP | Six-bar file evidence above; unique failure/condition: lists rewindable user messages newest first, with the turns each drops. |
| is a projection of the rows: a row without revertTurnCount is not a target | KEEP | Six-bar file evidence above; unique failure/condition: is a projection of the rows: a row without revertTurnCount is not a target. |
| completes on the second press inside the window and then starts over | KEEP | Six-bar file evidence above; unique failure/condition: completes on the second press inside the window and then starts over. |
| a press outside the window is a first press | KEEP | Six-bar file evidence above; unique failure/condition: a press outside the window is a first press. |
| reset forgets the first press | KEEP | Six-bar file evidence above; unique failure/condition: reset forgets the first press. |

## packages/ui/src/lib/agent-chat/roster.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 roster and per-task stop API. Stable seam/callers: roster/dock/spawn/stop selectors consumed by agent roster and drill-in.

Recognizable failures: workflow coordinator counted as member, live work hidden, shell mistaken for agent, stopped tasks still actionable or unrelated task failures clear controls. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| prefers progress while live and reverses that order once settled | KEEP | Six-bar file evidence above; unique failure/condition: prefers progress while live and reverses that order once settled. |
| keeps a workflow coordinator live between member launches | KEEP | Six-bar file evidence above; unique failure/condition: keeps a workflow coordinator live between member launches. |
| counts the members, never the coordinator, including members the timeline never saw | KEEP | Six-bar file evidence above; unique failure/condition: counts the members, never the coordinator, including members the timeline never saw. |
| preserves a known member count before roster details arrive | KEEP | Six-bar file evidence above; unique failure/condition: preserves a known member count before roster details arrive. |
| summarizes a stopped workflow as inactive | KEEP | Six-bar file evidence above; unique failure/condition: summarizes a stopped workflow as inactive. |
| reports failure when a member or coordinator failed | KEEP | Six-bar file evidence above; unique failure/condition: reports failure when a member or coordinator failed. |
| fades settled rows once the turn ends | KEEP | Six-bar file evidence above; unique failure/condition: fades settled rows once the turn ends. |
| exempts a live background row from collapsing AND from fading | KEEP | Six-bar file evidence above; unique failure/condition: exempts a live background row from collapsing AND from fading. |
| does fade a SETTLED background row | KEEP | Six-bar file evidence above; unique failure/condition: does fade a SETTLED background row. |
| a Claude shell: its own command item, `bgshell:<id>` — its start, or a chunk alone | KEEP | Six-bar file evidence above; unique failure/condition: a Claude shell: its own command item, `bgshell:<id>` — its start, or a chunk alone. |
| a Grok shell, or any shell's launch: task rows naming it, of a shell's kind | KEEP | Six-bar file evidence above; unique failure/condition: a Grok shell, or any shell's launch: task rows naming it, of a shell's kind. |
| never an agent, a loop, a goal — nor an id with nothing in the window | KEEP | Six-bar file evidence above; unique failure/condition: never an agent, a loop, a goal — nor an id with nothing in the window. |
| shows on a live run where the provider can stop one task, and reads Stopping… while in flight | KEEP | Six-bar file evidence above; unique failure/condition: shows on a live run where the provider can stop one task, and reads Stopping… while in flight. |
| hides where the provider cannot, on a member, and on a run that settled | KEEP | Six-bar file evidence above; unique failure/condition: hides where the provider cannot, on a member, and on a run that settled. |
| drops evicted pending stops and preserves other tasks when one fails | KEEP | Six-bar file evidence above; unique failure/condition: drops evicted pending stops and preserves other tasks when one fails. |
| ignores unrelated activities and malformed task-stop failures | KEEP | Six-bar file evidence above; unique failure/condition: ignores unrelated activities and malformed task-stop failures. |

## packages/ui/src/lib/agent-chat/rows.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.2,7.3,7.6; docs/superpowers/specs/2026-09-24-agent-goals-design.md §8.4; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §§2.5,3. Stable seam/callers: deriveTimelineRowsWithState consumed by store.ts and ChatTimeline.

Recognizable failures: visible messages/output lost or duplicated, stale live/fold state, wrong rewind target, goal/page/app hidden or wrong-server capture shown. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| hoists an error out of the group rather than hiding it in a summary | KEEP | Six-bar file evidence above; unique failure/condition: hoists an error out of the group rather than hiding it in a summary. |
| hoists a spawn row and an answered question | KEEP | Six-bar file evidence above; unique failure/condition: hoists a spawn row and an answered question. |
| shows commentary between tool calls while the turn runs | KEEP | Six-bar file evidence above; unique failure/condition: shows commentary between tool calls while the turn runs. |
| never treats commentary as the turn's terminal assistant message | KEEP | Six-bar file evidence above; unique failure/condition: never treats commentary as the turn's terminal assistant message. |
| breaks a group on a turn-id change | KEEP | Six-bar file evidence above; unique failure/condition: breaks a group on a turn-id change. |
| a settled turn works for its own duration, from the fold's turn row — a row that lands in it late stretches nothing | KEEP | Six-bar file evidence above; unique failure/condition: a settled turn works for its own duration, from the fold's turn row — a row that lands in it late stretches nothing. |
| emits a compaction marker carrying the token counts | KEEP | Six-bar file evidence above; unique failure/condition: emits a compaction marker carrying the token counts. |
| carries the provider's summary onto the marker row | KEEP | Six-bar file evidence above; unique failure/condition: carries the provider's summary onto the marker row. |
| puts the changed-files card at the end of the turn it belongs to | KEEP | Six-bar file evidence above; unique failure/condition: puts the changed-files card at the end of the turn it belongs to. |
| offers rewind only where the adapter supports rollback | KEEP | Six-bar file evidence above; unique failure/condition: offers rewind only where the adapter supports rollback. |
| offers a fork before a prompt only once its turn started (spec 2026-10-14 §6) | KEEP | Six-bar file evidence above; unique failure/condition: offers a fork before a prompt only once its turn started (spec 2026-10-14 §6). |
| no longer reads the rewind off the checkpoint list | KEEP | Six-bar file evidence above; unique failure/condition: no longer reads the rewind off the checkpoint list. |
| counts a promptless turn in its place, and a replayed duplicate once | KEEP | Six-bar file evidence above; unique failure/condition: counts a promptless turn in its place, and a replayed duplicate once. |
| withholds it from a message that opened no turn | KEEP | Six-bar file evidence above; unique failure/condition: withholds it from a message that opened no turn. |
| never offers it on the verbatim /compact, which renders as no bubble at all | KEEP | Six-bar file evidence above; unique failure/condition: never offers it on the verbatim /compact, which renders as no bubble at all. |
| never offers it on a user row the provider's transcript wrote itself | KEEP | Six-bar file evidence above; unique failure/condition: never offers it on a user row the provider's transcript wrote itself. |
| gives a pending turn's prompt none until the provider starts it | KEEP | Six-bar file evidence above; unique failure/condition: gives a pending turn's prompt none until the provider starts it. |
| withholds every message before the last settled compaction, and only those | KEEP | Six-bar file evidence above; unique failure/condition: withholds every message before the last settled compaction, and only those. |
| treats the legacy settled marker as a compaction too | KEEP | Six-bar file evidence above; unique failure/condition: treats the legacy settled marker as a compaction too. |
| is not withheld by a compaction that failed or is still running — neither dropped anything | KEEP | Six-bar file evidence above; unique failure/condition: is not withheld by a compaction that failed or is still running — neither dropped anything. |
| never represents a running turn by an empty timeline | KEEP | Six-bar file evidence above; unique failure/condition: never represents a running turn by an empty timeline. |
| appends every queued message as a ghost bubble, oldest first | KEEP | Six-bar file evidence above; unique failure/condition: appends every queued message as a ghost bubble, oldest first. |
| a running command and its N chunks are ONE live row, labelled with the command | KEEP | Six-bar file evidence above; unique failure/condition: a running command and its N chunks are ONE live row, labelled with the command. |
| a failure-looking output chunk stays attached to the running call | KEEP | Six-bar file evidence above; unique failure/condition: a failure-looking output chunk stays attached to the running call. |
| a settled streamed call remains directly accessible under its command | KEEP | Six-bar file evidence above; unique failure/condition: a settled streamed call remains directly accessible under its command. |
| a parent call a turn adopts is that turn's live row; what a rewind of that turn leaves of it renders nothing | KEEP | Six-bar file evidence above; unique failure/condition: a parent call a turn adopts is that turn's live row; what a rewind of that turn leaves of it renders nothing. |
| renders a running turn live in a projection the timeline continues below — the tail is the window's | KEEP | Six-bar file evidence above; unique failure/condition: renders a running turn live in a projection the timeline continues below — the tail is the window's. |
| leaves the thinking placeholder to the projection that ends the timeline | KEEP | Six-bar file evidence above; unique failure/condition: leaves the thinking placeholder to the projection that ends the timeline. |
| puts the running turn's header where the timeline's last prompt is | KEEP | Six-bar file evidence above; unique failure/condition: puts the running turn's header where the timeline's last prompt is. |
| needs no placeholder when a live row above shows the turn working, and reports its own | KEEP | Six-bar file evidence above; unique failure/condition: needs no placeholder when a live row above shows the turn working, and reports its own. |
| never renders the in-flight marker as a divider — it is a phase, not an event | KEEP | Six-bar file evidence above; unique failure/condition: never renders the in-flight marker as a divider — it is a phase, not an event. |
| renders a failed compaction as its own divider, carrying the reason | KEEP | Six-bar file evidence above; unique failure/condition: renders a failed compaction as its own divider, carrying the reason. |
| stamps the thinking placeholder and the live activity-group header too | KEEP | Six-bar file evidence above; unique failure/condition: stamps the thinking placeholder and the live activity-group header too. |
| re-derives when only the phase moved — the streaming fast path must not swallow it | KEEP | Six-bar file evidence above; unique failure/condition: re-derives when only the phase moved — the streaming fast path must not swallow it. |
| the running turn's answer streams; a settled turn's stuck answer reads settled and its turn folds | KEEP | Six-bar file evidence above; unique failure/condition: the running turn's answer streams; a settled turn's stuck answer reads settled and its turn folds. |
| a streaming answer holds its turn's fold open while it can still be written | KEEP | Six-bar file evidence above; unique failure/condition: a streaming answer holds its turn's fold open while it can still be written. |
| a moved context re-derives: the streamed-text fast path never keeps a stale streaming row | KEEP | Six-bar file evidence above; unique failure/condition: a moved context re-derives: the streamed-text fast path never keeps a stale streaming row. |
| a streamed token keeps the row's liveness through the fast path | KEEP | Six-bar file evidence above; unique failure/condition: a streamed token keeps the row's liveness through the fast path. |
| a delta on an answer that reads settled rebuilds: its turn's fold is timed by it | KEEP | Six-bar file evidence above; unique failure/condition: a delta on an answer that reads settled rebuilds: its turn's fold is timed by it. |
| a thought a later row follows moves nothing: the fold ends on that row | KEEP | Six-bar file evidence above; unique failure/condition: a thought a later row follows moves nothing: the fold ends on that row. |
| of two thoughts streaming in one fold, only the last one's tokens move its label | KEEP | Six-bar file evidence above; unique failure/condition: of two thoughts streaming in one fold, only the last one's tokens move its label. |
| a goal update is its own marker row, carrying its label, change and objective | KEEP | Six-bar file evidence above; unique failure/condition: a goal update is its own marker row, carrying its label, change and objective. |
| only an achieved or failed marker carries the stats of the goal that ended | KEEP | Six-bar file evidence above; unique failure/condition: only an achieved or failed marker carries the stats of the goal that ended. |
| a marker is never folded into an activity group, a tool group or the live tool row | KEEP | Six-bar file evidence above; unique failure/condition: a marker is never folded into an activity group, a tool group or the live tool row. |
| a settled turn's fold hides its work but never its goal markers | KEEP | Six-bar file evidence above; unique failure/condition: a settled turn's fold hides its work but never its goal markers. |
| a marker after the answer changes nothing about what else folds | KEEP | Six-bar file evidence above; unique failure/condition: a marker after the answer changes nothing about what else folds. |
| a host `/goal` answer is its own row, never hidden in a tool group or an activity group | KEEP | Six-bar file evidence above; unique failure/condition: a host `/goal` answer is its own row, never hidden in a tool group or an activity group. |
| an old log's re-emitted opening paragraph neither hides nor replaces the real answer | KEEP | Six-bar file evidence above; unique failure/condition: an old log's re-emitted opening paragraph neither hides nor replaces the real answer. |
| a turn whose every message is commentary still shows its last one | KEEP | Six-bar file evidence above; unique failure/condition: a turn whose every message is commentary still shows its last one. |
| a completed html_render call is one visual row in place of its tool row, for every provider | KEEP | Six-bar file evidence above; unique failure/condition: a completed html_render call is one visual row in place of its tool row, for every provider. |
| a failed or still-running html_render call stays an ordinary tool row | KEEP | Six-bar file evidence above; unique failure/condition: a failed or still-running html_render call stays an ordinary tool row. |
| a page is never swallowed by an activity group, a tool group or the live tool row | KEEP | Six-bar file evidence above; unique failure/condition: a page is never swallowed by an activity group, a tool group or the live tool row. |
| a settled turn's fold hides its work but never its page, and the page changes nothing else that folds | KEEP | Six-bar file evidence above; unique failure/condition: a settled turn's fold hides its work but never its page, and the page changes nothing else that folds. |
| a completed call with a captured app is one mcp-app row in place of its tool row, named by its completed row | KEEP | Six-bar file evidence above; unique failure/condition: a completed call with a captured app is one mcp-app row in place of its tool row, named by its completed row. |
| two calls of an unchanged app share its snapshot and are still two rows | KEEP | Six-bar file evidence above; unique failure/condition: two calls of an unchanged app share its snapshot and are still two rows. |
| another server's app on a row, or a failed call, stays an ordinary tool row | KEEP | Six-bar file evidence above; unique failure/condition: another server's app on a row, or a failed call, stays an ordinary tool row. |
| an orquester html_render row is its page, never an app — even carrying an mcpApp | KEEP | Six-bar file evidence above; unique failure/condition: an orquester html_render row is its page, never an app — even carrying an mcpApp. |
| a settled turn's fold never hides its app | KEEP | Six-bar file evidence above; unique failure/condition: a settled turn's fold never hides its app. |

## packages/ui/src/lib/agent-chat/secret-requests.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §5 request_secret; README secret privacy. Stable seam/callers: secretRequestsStore event/load boundary consumed by secret-request UI.

Recognizable failures: closed cards revive under late events/load races, wrong-session cards appear, malformed events enter state or a stale connection response restores requests. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| opens and closes on bus events, oldest first, per session | KEEP | Six-bar file evidence above; unique failure/condition: opens and closes on bus events, oldest first, per session. |
| ignores anything that is not a well-formed secret-request event | KEEP | Six-bar file evidence above; unique failure/condition: ignores anything that is not a well-formed secret-request event. |
| a load replaces the session's list, keeps what opened meanwhile, never revives what closed | KEEP | Six-bar file evidence above; unique failure/condition: a load replaces the session's list, keeps what opened meanwhile, never revives what closed. |
| an answered card leaves at once; a reset drops everything and any load in flight | KEEP | Six-bar file evidence above; unique failure/condition: an answered card leaves at once; a reset drops everything and any load in flight. |
| a failed load leaves the copy as it was | KEEP | Six-bar file evidence above; unique failure/condition: a failed load leaves the copy as it was. |

## packages/ui/src/lib/agent-chat/status.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 compaction/context status; public context-window/identity protocol. Stable seam/callers: latestContextWindowActivity/isCompactingThread consumed by hooks.ts.

Recognizable failures: status misses latest usable usage, another account’s cache expiry survives a switch, or compaction remains active after terminal marker/session/turn end. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| reads the newest context-window activity and skips malformed ones | KEEP | Six-bar file evidence above; unique failure/condition: reads the newest context-window activity and skips malformed ones. |
| carries the last request's cache expiry past a restarted session's out-of-turn read, as the daemon does | KEEP | Six-bar file evidence above; unique failure/condition: carries the last request's cache expiry past a restarted session's out-of-turn read, as the daemon does. |
| ends on `compacted` | CONSOLIDATE | Surviving owner. One terminal-marker table retains successful and failed compaction inputs, removing duplicated setup and irrelevant wording/token fields. Owner: status.logic.test.ts. |
| ends on `compaction-failed` | CONSOLIDATE | One terminal-marker table retains successful and failed compaction inputs, removing duplicated setup and irrelevant wording/token fields. Owner: status.logic.test.ts: ends on `compacted`. |
| ends when the turn settles even though no terminal marker ever arrived | KEEP | Six-bar file evidence above; unique failure/condition: ends when the turn settles even though no terminal marker ever arrived. |
| ends when the session is no longer live | KEEP | Six-bar file evidence above; unique failure/condition: ends when the session is no longer live. |
| is off for an old log, which only ever recorded the settled marker | KEEP | Six-bar file evidence above; unique failure/condition: is off for an old log, which only ever recorded the settled marker. |
| reads the LATEST marker, so a second compaction re-enters the phase | KEEP | Six-bar file evidence above; unique failure/condition: reads the LATEST marker, so a second compaction re-enters the phase. |
| ignores everything that is not a compaction marker | KEEP | Six-bar file evidence above; unique failure/condition: ignores everything that is not a compaction marker. |

## packages/ui/src/lib/agent-chat/store.agent-rows.test.ts

Independent contract: packages/api/src/agent-chat/agent-rows.ts public on-demand protocol; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3. Stable seam/callers: actual thread-store actions and frame boundary used by drill-in.

Recognizable failures: loader not wired to real slice, requests use a dead/unconfirmed stream, parent requests disappear or old host fallback drops rows. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| opts in on its stream and its reads, preserving parent messages and pending requests | KEEP | Six-bar file evidence above; unique failure/condition: opts in on its stream and its reads, preserving parent messages and pending requests. |
| a drill-in asks on the live stream, never before it is live, batched, and its rows land | KEEP | Six-bar file evidence above; unique failure/condition: a drill-in asks on the live stream, never before it is live, batched, and its rows land. |
| a live event of an omitted agent loads it by itself | KEEP | Six-bar file evidence above; unique failure/condition: a live event of an omitted agent loads it by itself. |
| a reconnect's new snapshot says what is omitted now, and an open drill-in asks again on the new stream | KEEP | Six-bar file evidence above; unique failure/condition: a reconnect's new snapshot says what is omitted now, and an open drill-in asks again on the new stream. |
| a resume by cursor keeps what was omitted, and asks on the resumed stream | KEEP | Six-bar file evidence above; unique failure/condition: a resume by cursor keeps what was omitted, and asks on the resumed stream. |
| a gone stream is not asked again; the next one is | KEEP | Six-bar file evidence above; unique failure/condition: a gone stream is not asked again; the next one is. |
| a host from before the route: the store reads the thread whole, without the opt-in | KEEP | Six-bar file evidence above; unique failure/condition: a host from before the route: the store reads the thread whole, without the opt-in. |
| a copy with omitted rows resumed on a host that names no stream reads the thread whole | KEEP | Six-bar file evidence above; unique failure/condition: a copy with omitted rows resumed on a host that names no stream reads the thread whole. |
| a frame a snapshot read beside the stream outran is dropped and asked for again | KEEP | Six-bar file evidence above; unique failure/condition: a frame a snapshot read beside the stream outran is dropped and asked for again. |
| never asks on the connection a changed host instance made it close | KEEP | Six-bar file evidence above; unique failure/condition: never asks on the connection a changed host instance made it close. |

## packages/ui/src/lib/agent-chat/store.device-cache.test.ts

Independent contract: AGENTS.md persistence/privacy; README revocation; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.3. Stable seam/callers: actual thread store reopened with durable storage and fresh module memory.

Recognizable failures: cached pending actions execute before confirmation, device copy overwrites live host updates, wrong host cursor used or signed-out content returns. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| paints the copy before any frame, resumes by cursor and applies the replay | KEEP | Six-bar file evidence above; unique failure/condition: paints the copy before any frame, resumes by cursor and applies the replay. |
| keeps a bounded snapshot's history cursor and cut: the copy loads older from them after a reload | KEEP | Six-bar file evidence above; unique failure/condition: keeps a bounded snapshot's history cursor and cut: the copy loads older from them after a reload. |
| offers nothing pending from the copy until the host confirms the thread | KEEP | Six-bar file evidence above; unique failure/condition: offers nothing pending from the copy until the host confirms the thread. |
| answers a request once the host has confirmed it still stands | KEEP | Six-bar file evidence above; unique failure/condition: answers a request once the host has confirmed it still stands. |
| re-reads the thread over a fresh stream when the host restarted, and replaces the device copy | KEEP | Six-bar file evidence above; unique failure/condition: re-reads the thread over a fresh stream when the host restarted, and replaces the device copy. |
| never rolls a host change back over events the stream already delivered | KEEP | Six-bar file evidence above; unique failure/condition: never rolls a host change back over events the stream already delivered. |
| acts on nothing in the copy - rewind, Stop, a task's Stop - until the host confirms it | KEEP | Six-bar file evidence above; unique failure/condition: acts on nothing in the copy - rewind, Stop, a task's Stop - until the host confirms it. |
| stops a live thread's writes for good when its daemon is signed out of | KEEP | Six-bar file evidence above; unique failure/condition: stops a live thread's writes for good when its daemon is signed out of. |
| holds a clear another tab recorded, and a clear whose deletes never ran | KEEP | Six-bar file evidence above; unique failure/condition: holds a clear another tab recorded, and a clear whose deletes never ran. |
| caches nothing where clears cannot be recorded | KEEP | Six-bar file evidence above; unique failure/condition: caches nothing where clears cannot be recorded. |
| drops the copy of a thread the host no longer has | KEEP | Six-bar file evidence above; unique failure/condition: drops the copy of a thread the host no longer has. |
| ignores a copy another app version wrote, and loads cold | KEEP | Six-bar file evidence above; unique failure/condition: ignores a copy another app version wrote, and loads cold. |
| behaves exactly as before with no device storage | KEEP | Six-bar file evidence above; unique failure/condition: behaves exactly as before with no device storage. |
| forgets the daemon's copies on sign-out | KEEP | Six-bar file evidence above; unique failure/condition: forgets the daemon's copies on sign-out. |

## packages/ui/src/lib/agent-chat/store.fixwave.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.6,7.3,7.4. Stable seam/callers: actual thread-store queue/full-plan actions.

Recognizable failures: queue drains multiple messages at one tool boundary or full-plan actions silently substitute clipped/missing proposal text. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| sends exactly one queued message per tool-call boundary | KEEP | Six-bar file evidence above; unique failure/condition: sends exactly one queued message per tool-call boundary. |
| marks the actionable proposal truncated and reads the whole plan back by its id | KEEP | Six-bar file evidence above; unique failure/condition: marks the actionable proposal truncated and reads the whole plan back by its id. |
| never reads an intact proposal back | KEEP | Six-bar file evidence above; unique failure/condition: never reads an intact proposal back. |
| refuses, rather than answer the cut text, when the read-back fails or brings no plan | REWRITE | Assert full-plan-unavailable refusal reason in both cases; TypeErrors or unrelated failures no longer pass. |

## packages/ui/src/lib/agent-chat/store.history.test.ts

Independent contract: docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md client/history page requests; docs/superpowers/specs/2026-09-23-fold-performance-design.md history bridge. Stable seam/callers: actual thread-store history/load/reveal/rewind actions.

Recognizable failures: page request race loses data, gaps at retention boundary, reveals scroll to wrong turn, stale load spinners/requests survive remount or meaningful older rows never load. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| pages by the oldest page's cursor and keeps the pages oldest first | KEEP | Six-bar file evidence above; unique failure/condition: pages by the oldest page's cursor and keeps the pages oldest first. |
| shares one request between overlapping loads | KEEP | Six-bar file evidence above; unique failure/condition: shares one request between overlapping loads. |
| asks nothing when the snapshot offers nothing older | KEEP | Six-bar file evidence above; unique failure/condition: asks nothing when the snapshot offers nothing older. |
| recovers from a transport that throws before it answers, and can page again | KEEP | Six-bar file evidence above; unique failure/condition: recovers from a transport that throws before it answers, and can page again. |
| discards a page that lands after the snapshot it was asked against was replaced | KEEP | Six-bar file evidence above; unique failure/condition: discards a page that lands after the snapshot it was asked against was replaced. |
| renders a call once, at the page's position, with the window's completion | KEEP | Six-bar file evidence above; unique failure/condition: renders a call once, at the page's position, with the window's completion. |
| renders a task once, at the page's position, with the window's completion | KEEP | Six-bar file evidence above; unique failure/condition: renders a task once, at the page's position, with the window's completion. |
| gates history rewinds by its position, not wholesale | KEEP | Six-bar file evidence above; unique failure/condition: gates history rewinds by its position, not wholesale. |
| rewinds to a prompt only a page holds, and hands it back once it is gone | KEEP | Six-bar file evidence above; unique failure/condition: rewinds to a prompt only a page holds, and hands it back once it is gone. |
| scrolls to a turn the window already holds, without a request | KEEP | Six-bar file evidence above; unique failure/condition: scrolls to a turn the window already holds, without a request. |
| loads older pages until the turn is on screen, then reveals it | KEEP | Six-bar file evidence above; unique failure/condition: loads older pages until the turn is on screen, then reveals it. |
| pages on past a page that lists the turn but shows none of it — a subagent's late row alone | KEEP | Six-bar file evidence above; unique failure/condition: pages on past a page that lists the turn but shows none of it — a subagent's late row alone. |
| pages on past a window that holds a row of the turn but not its prompt — a bounded snapshot's kept row | KEEP | Six-bar file evidence above; unique failure/condition: pages on past a window that holds a row of the turn but not its prompt — a bounded snapshot's kept row. |
| gives up at once on a turn the thread no longer has | KEEP | Six-bar file evidence above; unique failure/condition: gives up at once on a turn the thread no longer has. |
| gives up after 25 pages | KEEP | Six-bar file evidence above; unique failure/condition: gives up after 25 pages. |
| waits for the thread to synchronize before looking | KEEP | Six-bar file evidence above; unique failure/condition: waits for the thread to synchronize before looking. |
| drops an unhandled reveal whose row a new snapshot no longer has | KEEP | Six-bar file evidence above; unique failure/condition: drops an unhandled reveal whose row a new snapshot no longer has. |
| clears the reveal only for the nonce the timeline handled | KEEP | Six-bar file evidence above; unique failure/condition: clears the reveal only for the nonce the timeline handled. |
| brings a thread back with its pages, and never with a dead request's spinner | KEEP | Six-bar file evidence above; unique failure/condition: brings a thread back with its pages, and never with a dead request's spinner. |
| keeps pages, bridge and window ONE contiguous stretch while retention trims under them — nothing lost, nothing twice, in order | KEEP | Six-bar file evidence above; unique failure/condition: keeps pages, bridge and window ONE contiguous stretch while retention trims under them — nothing lost, nothing twice, in order. |
| renders the rows the first page repeats from the window ONCE — at the page's place, with the newest content — before and after the window evicts them to the bridge | KEEP | Six-bar file evidence above; unique failure/condition: renders the rows the first page repeats from the window ONCE — at the page's place, with the newest content — before and after the window evicts them to the bridge. |
| drops pages and bridge once the bridge no longer fits beside the newest page, and reads fresh bounds — the stream stays live | KEEP | Six-bar file evidence above; unique failure/condition: drops pages and bridge once the bridge no longer fits beside the newest page, and reads fresh bounds — the stream stays live. |
| refuses a re-read older than what the stream has folded since, and the next load asks without a cursor | KEEP | Six-bar file evidence above; unique failure/condition: refuses a re-read older than what the stream has folded since, and the next load asks without a cursor. |
| drops pages AND bridge for a rewind that removes a bridge row's turn, and keeps both for one confined to the window | KEEP | Six-bar file evidence above; unique failure/condition: drops pages AND bridge for a rewind that removes a bridge row's turn, and keeps both for one confined to the window. |
| reveals a turn only the bridge still shows, without loading a page | KEEP | Six-bar file evidence above; unique failure/condition: reveals a turn only the bridge still shows, without loading a page. |
| keeps what the window evicts while the FIRST page is on its way, and joins it to the page once it lands | KEEP | Six-bar file evidence above; unique failure/condition: keeps what the window evicts while the FIRST page is on its way, and joins it to the page once it lands. |
| lets that bridge go when the first page fails, and the retry asks without the snapshot's cursor | KEEP | Six-bar file evidence above; unique failure/condition: lets that bridge go when the first page fails, and the retry asks without the snapshot's cursor. |
| drops pages, bridge and cut on a new snapshot | KEEP | Six-bar file evidence above; unique failure/condition: drops pages, bridge and cut on a new snapshot. |
| brings the bridge back with its pages on a remount — and a first page's orphan bridge never | KEEP | Six-bar file evidence above; unique failure/condition: brings the bridge back with its pages on a remount — and a first page's orphan bridge never. |
| offers 'Load older' as soon as the window evicts a row, though the snapshot said nothing was older — and asks without a cursor | KEEP | Six-bar file evidence above; unique failure/condition: offers 'Load older' as soon as the window evicts a row, though the snapshot said nothing was older — and asks without a cursor. |
| renders the window's old prompts and answers in log order above a page — with no bridge yet | KEEP | Six-bar file evidence above; unique failure/condition: renders the window's old prompts and answers in log order above a page — with no bridge yet. |
| renders the window's older rows above a page that shares NONE of them — a prompt, an agent's launch, a compaction marker — in log order | KEEP | Six-bar file evidence above; unique failure/condition: renders the window's older rows above a page that shares NONE of them — a prompt, an agent's launch, a compaction marker — in log order. |
| asks for the next page while a page shows nothing the timeline did not, and stops at the first that shows an older row — busy throughout | KEEP | Six-bar file evidence above; unique failure/condition: asks for the next page while a page shows nothing the timeline did not, and stops at the first that shows an older row — busy throughout. |
| loads at most five pages in one click, and the next click goes on below the oldest | KEEP | Six-bar file evidence above; unique failure/condition: loads at most five pages in one click, and the next click goes on below the oldest. |
| stops at a page that reaches the thread's start, and at a failed one — keeping what landed | KEEP | Six-bar file evidence above; unique failure/condition: stops at a page that reaches the thread's start, and at a failed one — keeping what landed. |
| keeps a running turn live across history eviction, then settles it | KEEP | Six-bar file evidence above; unique failure/condition: keeps a running turn live across history eviction, then settles it. |

## packages/ui/src/lib/agent-chat/store.rebind.test.ts

Independent contract: README revocable sessions; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md authenticated stream resume contract. Stable seam/callers: retainThreadStore/ensureThreadStore actual transport replacement.

Recognizable failures: open chat retries revoked token forever, uses old transport for upload, loses cursor, or opens on stale transport before deferred setup. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| moves an open slice onto a new transport: the stream resumes there, commands go there | REWRITE | Assert cursor/host identity and transport routing without freezing unrelated optional stream options. |
| a slice whose stream has not opened yet opens it on the new transport | REWRITE | Assert cold cursor/host absence rather than exact options object; keeps stale-transport refusal. |

## packages/ui/src/lib/agent-chat/store.reload.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 draft/outbox reload and command receipt contract. Stable seam/callers: fresh module pages with surviving session/local storage and actual store commands.

Recognizable failures: messages vanish or send twice across reload, stale sends are auto-posted after replay window, held queue order changes or failures overwrite newer drafts. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| re-posts a send the page was still posting under the SAME commandId, once, the thread reading Sending meanwhile | KEEP | Six-bar file evidence above; unique failure/condition: re-posts a send the page was still posting under the SAME commandId, once, the thread reading Sending meanwhile. |
| a compact-first send is in the outbox while its /compact runs: a reload then re-posts the message | KEEP | Six-bar file evidence above; unique failure/condition: a compact-first send is in the outbox while its /compact runs: a reload then re-posts the message. |
| does not re-post a send older than the replay bound: it comes back to the thread's draft | KEEP | Six-bar file evidence above; unique failure/condition: does not re-post a send older than the replay bound: it comes back to the thread's draft. |
| gives several stale sends back in the order they were sent, ahead of what the draft holds | KEEP | Six-bar file evidence above; unique failure/condition: gives several stale sends back in the order they were sent, ahead of what the draft holds. |
| hands a stale send to the composer that shows the thread, saying why it is back | KEEP | Six-bar file evidence above; unique failure/condition: hands a stale send to the composer that shows the thread, saying why it is back. |
| gives nothing back for a stale Implement: its prompt was the composer's, and the plan is still there | KEEP | Six-bar file evidence above; unique failure/condition: gives nothing back for a stale Implement: its prompt was the composer's, and the plan is still there. |
| puts a refused re-post back into the draft, as any send that did not go out | KEEP | Six-bar file evidence above; unique failure/condition: puts a refused re-post back into the draft, as any send that did not go out. |
| tells the composer that shows the thread why a refused re-post is back — a message from before the reload | KEEP | Six-bar file evidence above; unique failure/condition: tells the composer that shows the thread why a refused re-post is back — a message from before the reload. |
| brings queued messages back as queued, in order, under the commandIds they were queued with | KEEP | Six-bar file evidence above; unique failure/condition: brings queued messages back as queued, in order, under the commandIds they were queued with. |
| leaves nothing for a reload once a send settled — delivered, or given back to the draft | KEEP | Six-bar file evidence above; unique failure/condition: leaves nothing for a reload once a send settled — delivered, or given back to the draft. |
| re-posts first, under its own id, the queued send a page was posting when it reloaded | KEEP | Six-bar file evidence above; unique failure/condition: re-posts first, under its own id, the queued send a page was posting when it reloaded. |
| does not bring back as queued what Stop returned to the composer | KEEP | Six-bar file evidence above; unique failure/condition: does not bring back as queued what Stop returned to the composer. |
| holds a stale queued send at the front instead of re-posting it, the queue behind it | KEEP | Six-bar file evidence above; unique failure/condition: holds a stale queued send at the front instead of re-posting it, the queue behind it. |
| brings back a queue its page showed less than ten minutes ago as it was, to go out by itself | KEEP | Six-bar file evidence above; unique failure/condition: brings back a queue its page showed less than ten minutes ago as it was, to go out by itself. |
| holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself | KEEP | Six-bar file evidence above; unique failure/condition: holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself. |
| measures that absence from when the page last showed the queue, never from when a message was queued | KEEP | Six-bar file evidence above; unique failure/condition: measures that absence from when the page last showed the queue, never from when a message was queued. |
| stamps the queue as last shown when the page is hidden | KEEP | Six-bar file evidence above; unique failure/condition: stamps the queue as last shown when the page is hidden. |
| does not move that stamp at a teardown while the page is hidden | KEEP | Six-bar file evidence above; unique failure/condition: does not move that stamp at a teardown while the page is hidden. |
| stamps the queue as last shown on pagehide | KEEP | Six-bar file evidence above; unique failure/condition: stamps the queue as last shown on pagehide. |
| lets a queue kept in the page go on by itself when its thread comes back within ten minutes | KEEP | Six-bar file evidence above; unique failure/condition: lets a queue kept in the page go on by itself when its thread comes back within ten minutes. |
| holds a queue kept in the page when its thread comes back more than ten minutes later | KEEP | Six-bar file evidence above; unique failure/condition: holds a queue kept in the page when its thread comes back more than ten minutes later. |
| holds a queued send that fails with no live generation at the front of the kept queue, reason and all — the next generation shows it there | KEEP | Six-bar file evidence above; unique failure/condition: holds a queued send that fails with no live generation at the front of the kept queue, reason and all — the next generation shows it there. |
| brings a message held before the reload back held, with the reason it waits | KEEP | Six-bar file evidence above; unique failure/condition: brings a message held before the reload back held, with the reason it waits. |
| re-posts a thread's in-flight leftovers one at a time, in the order they were posted — a composer send among them | KEEP | Six-bar file evidence above; unique failure/condition: re-posts a thread's in-flight leftovers one at a time, in the order they were posted — a composer send among them. |
| holds the in-flight leftovers whose re-posts fail in the order they were posted, ahead of the rest | KEEP | Six-bar file evidence above; unique failure/condition: holds the in-flight leftovers whose re-posts fail in the order they were posted, ahead of the rest. |
| never holds a failed re-post behind a waiting message once the user has sent the one held before it | KEEP | Six-bar file evidence above; unique failure/condition: never holds a failed re-post behind a waiting message once the user has sent the one held before it. |
| holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them | KEEP | Six-bar file evidence above; unique failure/condition: holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them. |
| keeps the order of consecutive failures that land with no live generation | KEEP | Six-bar file evidence above; unique failure/condition: keeps the order of consecutive failures that land with no live generation. |
| never leaves a thread reading Sending when giving a refused re-post back throws — and still re-posts the rest | KEEP | Six-bar file evidence above; unique failure/condition: never leaves a thread reading Sending when giving a refused re-post back throws — and still re-posts the rest. |
| opens the thread's stream even when giving a stale send back throws: the outbox is a safety net, never a failure | KEEP | Six-bar file evidence above; unique failure/condition: opens the thread's stream even when giving a stale send back throws: the outbox is a safety net, never a failure. |
| does not trust a kept queue whose last write failed: the retained snapshot has what came after | KEEP | Six-bar file evidence above; unique failure/condition: does not trust a kept queue whose last write failed: the retained snapshot has what came after. |
| takes a held message only the kept queue has into the snapshot's queue after a failed write | KEEP | Six-bar file evidence above; unique failure/condition: takes a held message only the kept queue has into the snapshot's queue after a failed write. |

## packages/ui/src/lib/agent-chat/store.retention.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§6.3,7.2 retained snapshot; docs/superpowers/specs/2026-09-23-fold-performance-design.md bounded live state. Stable seam/callers: actual destroy/remount thread-store lifecycle.

Recognizable failures: remount loses state/queue/disclosures, stale generation overwrites newer one, expired state resumes by stale cursor or dismissed transient error returns. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| paints the retained state on remount and resumes with after=<seq> | KEEP | Six-bar file evidence above; unique failure/condition: paints the retained state on remount and resumes with after=<seq>. |
| does a full load once the idle TTL has elapsed | KEEP | Six-bar file evidence above; unique failure/condition: does a full load once the idle TTL has elapsed. |
| refuses a write from a generation a newer store has replaced | KEEP | Six-bar file evidence above; unique failure/condition: refuses a write from a generation a newer store has replaced. |
| keeps the held queue and disclosure state on remount | KEEP | Six-bar file evidence above; unique failure/condition: keeps the held queue and disclosure state on remount. |
| never paints a retained error banner | KEEP | Six-bar file evidence above; unique failure/condition: never paints a retained error banner. |

## packages/ui/src/lib/agent-chat/store.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§6.2,6.3,7.2–7.5; public /task/stop and profile/account routes. Stable seam/callers: actual per-thread store actions, transport frames and persisted draft/outbox.

Recognizable failures: lost/duplicate commands, lost drafts/queued sends, stale approval locks, unsupported rewind completion, wrong identity/profile command or task-stop pending state. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| a thread the host does not hold is `gone`, not reconnecting, until the user tries again | KEEP | Six-bar file evidence above; unique failure/condition: a thread the host does not hold is `gone`, not reconnecting, until the user tries again. |
| never counts a live loop or goal as background work — the host treats both as inert | KEEP | Six-bar file evidence above; unique failure/condition: never counts a live loop or goal as background work — the host treats both as inert. |
| drops a Claude log's re-emitted copy and leaves another provider's repeat alone | KEEP | Six-bar file evidence above; unique failure/condition: drops a Claude log's re-emitted copy and leaves another provider's repeat alone. |
| reads a message's liveness through the rule: a stuck answer is settled, the running turn's streams | KEEP | Six-bar file evidence above; unique failure/condition: reads a message's liveness through the rule: a stuck answer is settled, the running turn's streams. |
| mints a commandId per command and sends no optimistic row | KEEP | Six-bar file evidence above; unique failure/condition: mints a commandId per command and sends no optimistic row. |
| setAccount posts the daemon-owned route with a minted commandId (§3.4) | KEEP | Six-bar file evidence above; unique failure/condition: setAccount posts the daemon-owned route with a minted commandId (§3.4). |
| setProfile posts the daemon-owned profile route with a minted commandId (agent profiles §5.3) | KEEP | Six-bar file evidence above; unique failure/condition: setProfile posts the daemon-owned profile route with a minted commandId (agent profiles §5.3). |
| setProfile retries HOST_UNAVAILABLE with the same id | KEEP | Six-bar file evidence above; unique failure/condition: setProfile retries HOST_UNAVAILABLE with the same id. |
| setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal | KEEP | Six-bar file evidence above; unique failure/condition: setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal. |
| locks the row while a decision is in flight and clears it in a finally | KEEP | Six-bar file evidence above; unique failure/condition: locks the row while a decision is in flight and clears it in a finally. |
| omits turnId unless the session is running | KEEP | Six-bar file evidence above; unique failure/condition: omits turnId unless the session is running. |
| posts `revert`, stays inert until the truncation lands, then hands the message back | KEEP | Six-bar file evidence above; unique failure/condition: posts `revert`, stays inert until the truncation lands, then hands the message back. |
| settles at once when the truncation was folded before the command answered | KEEP | Six-bar file evidence above; unique failure/condition: settles at once when the truncation was folded before the command answered. |
| rejects with the reason of a NEW rewind failure, and clears `reverting` | KEEP | Six-bar file evidence above; unique failure/condition: rejects with the reason of a NEW rewind failure, and clears `reverting`. |
| falls back to the failure row's summary when it carries no detail | KEEP | Six-bar file evidence above; unique failure/condition: falls back to the failure row's summary when it carries no detail. |
| rejects a message it cannot find — or one that is not the user's — without posting | KEEP | Six-bar file evidence above; unique failure/condition: rejects a message it cannot find — or one that is not the user's — without posting. |
| refuses a second rewind while one is in flight — one `/revert`, one message back | KEEP | Six-bar file evidence above; unique failure/condition: refuses a second rewind while one is in flight — one `/revert`, one message back. |
| unlocks the composer after two minutes without claiming the rewind completed | KEEP | Six-bar file evidence above; unique failure/condition: unlocks the composer after two minutes without claiming the rewind completed. |
| settles when its store is destroyed mid-wait, handing the message back to the persisted draft | KEEP | Six-bar file evidence above; unique failure/condition: settles when its store is destroyed mid-wait, handing the message back to the persisted draft. |
| remembers a dismissal per (thread, message) — a DIFFERENT error still shows | KEEP | Six-bar file evidence above; unique failure/condition: remembers a dismissal per (thread, message) — a DIFFERENT error still shows. |
| retries a lost response with the SAME commandId | KEEP | Six-bar file evidence above; unique failure/condition: retries a lost response with the SAME commandId. |
| writes the scroll/disclosure LRU and mirrors follow from atEnd | KEEP | Six-bar file evidence above; unique failure/condition: writes the scroll/disclosure LRU and mirrors follow from atEnd. |
| writes a saved draft straight through to storage, under its own thread id | KEEP | Six-bar file evidence above; unique failure/condition: writes a saved draft straight through to storage, under its own thread id. |
| seeds a fresh store from storage — which is what a reload is | KEEP | Six-bar file evidence above; unique failure/condition: seeds a fresh store from storage — which is what a reload is. |
| drops the entry when the draft is cleared, so a sent message never returns | KEEP | Six-bar file evidence above; unique failure/condition: drops the entry when the draft is cleared, so a sent message never returns. |
| with no slice open, lands in storage, where the thread's next slice seeds from, and moves no other thread's draft | KEEP | Six-bar file evidence above; unique failure/condition: with no slice open, lands in storage, where the thread's next slice seeds from, and moves no other thread's draft. |
| with a slice open, goes through that slice, whose draft the next composer mount loads | KEEP | Six-bar file evidence above; unique failure/condition: with a slice open, goes through that slice, whose draft the next composer mount loads. |
| a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId | KEEP | Six-bar file evidence above; unique failure/condition: a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId. |
| an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever | KEEP | Six-bar file evidence above; unique failure/condition: an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever. |
| a queued send that fails after its generation was destroyed is held at the front of the thread's live generation | KEEP | Six-bar file evidence above; unique failure/condition: a queued send that fails after its generation was destroyed is held at the front of the thread's live generation. |
| the live generation waits for the torn-down one's queued send in flight before sending the next | KEEP | Six-bar file evidence above; unique failure/condition: the live generation waits for the torn-down one's queued send in flight before sending the next. |
| when the torn-down generation's queued send fails, it is held at the front and the next one still waits | KEEP | Six-bar file evidence above; unique failure/condition: when the torn-down generation's queued send fails, it is held at the front and the next one still waits. |
| with no live generation, a queued send that fails after the teardown goes back to the persisted draft | KEEP | Six-bar file evidence above; unique failure/condition: with no live generation, a queued send that fails after the teardown goes back to the persisted draft. |
| a rewind torn down before the host answered merges into the thread's live slice, never over its newer draft | KEEP | Six-bar file evidence above; unique failure/condition: a rewind torn down before the host answered merges into the thread's live slice, never over its newer draft. |
| an answer in flight across a teardown never locks the next generation's card | KEEP | Six-bar file evidence above; unique failure/condition: an answer in flight across a teardown never locks the next generation's card. |
| with no composer mounted, a Stop returning two full queued messages keeps all sixteen files for the next mount | KEEP | Six-bar file evidence above; unique failure/condition: with no composer mounted, a Stop returning two full queued messages keeps all sixteen files for the next mount. |
| with a composer mounted, the returned message reaches it without a hidden persisted copy | KEEP | Six-bar file evidence above; unique failure/condition: with a composer mounted, the returned message reaches it without a hidden persisted copy. |
| a file the composer still refuses is written into its draft as its path, never parked behind it | KEEP | Six-bar file evidence above; unique failure/condition: a file the composer still refuses is written into its draft as its path, never parked behind it. |
| posts the task's id and holds its Stop pending until the row settles | KEEP | Six-bar file evidence above; unique failure/condition: posts the task's id and holds its Stop pending until the row settles. |
| lets the Stop go at once when the host refuses it, and says why on the banner | KEEP | Six-bar file evidence above; unique failure/condition: lets the Stop go at once when the host refuses it, and says why on the banner. |
| offers the Stop again when the provider failed it | KEEP | Six-bar file evidence above; unique failure/condition: offers the Stop again when the provider failed it. |

## packages/ui/src/lib/agent-chat/stream.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.1,6.3; packages/api/src/agent-chat/wire.ts and agent-rows.ts. Stable seam/callers: NdjsonLineBuffer/parseStreamLine consumed by transport.ts and api-client.ts.

Recognizable failures: network chunk boundaries corrupt NDJSON, malformed frames enter reducer or additive/legacy valid frames get dropped. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| splits a stream the same however it is chunked, a long line included | CONSOLIDATE | Surviving owner. Absorb empty-chunk and reset-with-unfinished-tail assertions into chunk-invariance case; newline/empty-line/chunk parsing already covered there. Owner: stream.logic.test.ts. |
| closes a line held across many chunks, and keeps empty lines and a reset | CONSOLIDATE | Absorb empty-chunk and reset-with-unfinished-tail assertions into chunk-invariance case; newline/empty-line/chunk parsing already covered there. Owner: stream.logic.test.ts: splits a stream the same however it is chunked, a long line included. |
| skips blank lines | KEEP | Six-bar file evidence above; unique failure/condition: skips blank lines. |
| rejects malformed JSON and structurally wrong frames without throwing | KEEP | Six-bar file evidence above; unique failure/condition: rejects malformed JSON and structurally wrong frames without throwing. |
| accepts a history-import progress frame and rejects a malformed one | KEEP | Six-bar file evidence above; unique failure/condition: accepts a history-import progress frame and rejects a malformed one. |
| decodes the host's error line, its code kept only when it is a known one | KEEP | Six-bar file evidence above; unique failure/condition: decodes the host's error line, its code kept only when it is a known one. |
| accepts an agent-rows frame by its structure, and rejects one it could not apply | KEEP | Six-bar file evidence above; unique failure/condition: accepts an agent-rows frame by its structure, and rejects one it could not apply. |
| keeps a synchronized marker whose stream id it cannot read, without the id | KEEP | Six-bar file evidence above; unique failure/condition: keeps a synchronized marker whose stream id it cannot read, without the id. |
| accepts an event whose payload carries fields this bundle does not know | KEEP | Six-bar file evidence above; unique failure/condition: accepts an event whose payload carries fields this bundle does not know. |

## packages/ui/src/lib/agent-chat/thread-catalog.test.ts

Independent contract: README Agent Profiles Global/profile isolation; docs/superpowers/specs/2026-10-18-agent-profiles-design.md composer catalog. Stable seam/callers: withThreadCatalog/parseThreadCatalogResponse consumed by composer catalog loading.

Recognizable failures: Global commands leak into profile chat during loading/error, another thread’s catalog accepted or malformed entries crash menu. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| a Global chat keeps the provider's catalog untouched | KEEP | Six-bar file evidence above; unique failure/condition: a Global chat keeps the provider's catalog untouched. |
| a profile chat shows its own catalog, and never the Global one — not even while it loads | KEEP | Six-bar file evidence above; unique failure/condition: a profile chat shows its own catalog, and never the Global one — not even while it loads. |
| source none on a profile chat (a daemon that could not read the profile) is empty, never the Global catalog | KEEP | Six-bar file evidence above; unique failure/condition: source none on a profile chat (a daemon that could not read the profile) is empty, never the Global catalog. |
| parses only a well-formed answer for the asked thread, dropping malformed rows | KEEP | Six-bar file evidence above; unique failure/condition: parses only a well-formed answer for the asked thread, dropping malformed rows. |

## packages/ui/src/lib/agent-chat/timeline-position.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 persistent per-thread scroll/disclosure LRU; AGENTS.md localStorage validation. Stable seam/callers: TimelinePositionStore/parseTimelinePositions consumed by store/hooks.

Recognizable failures: wrong thread position restored, old data crashes view, invalid disclosures reach state or LRU evicts a recently revisited thread. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| evicts the oldest past the limit | CONSOLIDATE | Stronger refreshed-entry LRU scenario also verifies newest retained and persisted 100-entry bound, replacing independent generic-eviction setup. Owner: timeline-position.test.ts: delete-then-set moves an entry to the end so it survives eviction. |
| delete-then-set moves an entry to the end so it survives eviction | CONSOLIDATE | Surviving owner. Stronger refreshed-entry LRU scenario also verifies newest retained and persisted 100-entry bound, replacing independent generic-eviction setup. Owner: timeline-position.test.ts. |
| persists as an ordered array, and replaying it rebuilds the same order | KEEP | Six-bar file evidence above; unique failure/condition: persists as an ordered array, and replaying it rebuilds the same order. |
| keeps the remembered row's turn, and reads a record without one as before | KEEP | Six-bar file evidence above; unique failure/condition: keeps the remembered row's turn, and reads a record without one as before. |
| forgets a thread | KEEP | Six-bar file evidence above; unique failure/condition: forgets a thread. |
| degrades to nothing remembered on garbage, never a crash | KEEP | Six-bar file evidence above; unique failure/condition: degrades to nothing remembered on garbage, never a crash. |
| keeps the valid rows of a partly-malformed payload | KEEP | Six-bar file evidence above; unique failure/condition: keeps the valid rows of a partly-malformed payload. |
| repairs a row an older bundle wrote with missing fields | KEEP | Six-bar file evidence above; unique failure/condition: repairs a row an older bundle wrote with missing fields. |
| drops non-string ids and non-numeric offsets from the disclosure set | KEEP | Six-bar file evidence above; unique failure/condition: drops non-string ids and non-numeric offsets from the disclosure set. |
| caps a persisted payload that is already over the limit | KEEP | Six-bar file evidence above; unique failure/condition: caps a persisted payload that is already over the limit. |

## packages/ui/src/lib/agent-chat/title.logic.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.7 client-seeded title including documented 50-character bound. Stable seam/callers: deriveThreadTitleSeed consumed by first-send/create workflow.

Recognizable failures: titles contain raw context markup/code, exceed documented bound or attachment-only conversations lose their identifying seed. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| uses the first message, stripped of context references | KEEP | Six-bar file evidence above; unique failure/condition: uses the first message, stripped of context references. |
| truncates at 50 characters | KEEP | Six-bar file evidence above; unique failure/condition: truncates at 50 characters. |
| falls back to the first image, then the first file, then a chip | KEEP | Six-bar file evidence above; unique failure/condition: falls back to the first image, then the first file, then a chip. |
| collapses fenced code and whitespace rather than seeding a wall of code | KEEP | Six-bar file evidence above; unique failure/condition: collapses fenced code and whitespace rather than seeding a wall of code. |

## packages/ui/src/lib/agent-chat/transport.test.ts

Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§6.2,6.3,6.6; packages/api/src/agent-chat/wire.ts public paths/query/errors; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md attachment reads. Stable seam/callers: createAgentChatTransport/openAgentChatStream over public Transporter interface.

Recognizable failures: wrong route/cursor/request bytes, replay duplicates, revoked token reconnect loops, lost errors/abort, unsafe output-window joins or binary attachments routed through JSON. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| opens without a cursor from a cold start and decodes frames in order | KEEP | Six-bar file evidence above; unique failure/condition: opens without a cursor from a cold start and decodes frames in order. |
| hands one chunk's frames over together when the caller takes batches | KEEP | Six-bar file evidence above; unique failure/condition: hands one chunk's frames over together when the caller takes batches. |
| resumes from the highest applied sequence after a drop | KEEP | Six-bar file evidence above; unique failure/condition: resumes from the highest applied sequence after a drop. |
| a wake (back online, page visible) redials a waiting stream at once | KEEP | Six-bar file evidence above; unique failure/condition: a wake (back online, page visible) redials a waiting stream at once. |
| drops a replayed event so a reconnect duplicates nothing | KEEP | Six-bar file evidence above; unique failure/condition: drops a replayed event so a reconnect duplicates nothing. |
| asks for a snapshot when the host instance changed | KEEP | Six-bar file evidence above; unique failure/condition: asks for a snapshot when the host instance changed. |
| stops reconnecting once the host says the thread does not exist, until retry() | KEEP | Six-bar file evidence above; unique failure/condition: stops reconnecting once the host says the thread does not exist, until retry(). |
| stops reconnecting on a 401: the token is revoked, and every retry would feed the login throttle | KEEP | Six-bar file evidence above; unique failure/condition: stops reconnecting on a 401: the token is revoked, and every retry would feed the login throttle. |
| any other error line still ends in an ordinary reconnect | KEEP | Six-bar file evidence above; unique failure/condition: any other error line still ends in an ordinary reconnect. |
| reports the reconnect and stops for good on close | KEEP | Six-bar file evidence above; unique failure/condition: reports the reconnect and stops for good on close. |
| closes a wedged stream once the heartbeat window lapses | KEEP | Six-bar file evidence above; unique failure/condition: closes a wedged stream once the heartbeat window lapses. |
| drops a live stream on the daemon's fast heartbeat after 20 s of silence | KEEP | Six-bar file evidence above; unique failure/condition: drops a live stream on the daemon's fast heartbeat after 20 s of silence. |
| keeps the patient window before synchronized: a snapshot in flight is not thrown away | KEEP | Six-bar file evidence above; unique failure/condition: keeps the patient window before synchronized: a snapshot in flight is not thrown away. |
| keeps the patient window for the host's own 15 s beats and for beats a proxy held together | KEEP | Six-bar file evidence above; unique failure/condition: keeps the patient window for the host's own 15 s beats and for beats a proxy held together. |
| a wake resumes a live stream that went silent, and leaves a delivering one alone | KEEP | Six-bar file evidence above; unique failure/condition: a wake resumes a live stream that went silent, and leaves a delivering one alone. |
| a wake leaves a host-cadence stream alone until its stall window has passed | KEEP | Six-bar file evidence above; unique failure/condition: a wake leaves a host-cadence stream alone until its stall window has passed. |
| posts to the right route and returns the receipt | KEEP | Six-bar file evidence above; unique failure/condition: posts to the right route and returns the receipt. |
| turns an error envelope into a typed error | KEEP | Six-bar file evidence above; unique failure/condition: turns an error envelope into a typed error. |
| marks HOST_UNAVAILABLE retryable — the same commandId may be re-posted | KEEP | Six-bar file evidence above; unique failure/condition: marks HOST_UNAVAILABLE retryable — the same commandId may be re-posted. |
| defaults the turn diff to showing whitespace, and hides it only when asked | KEEP | Six-bar file evidence above; unique failure/condition: defaults the turn diff to showing whitespace, and hides it only when asked. |
| asks a thread read for the window and cursor it was given, and nothing else | KEEP | Six-bar file evidence above; unique failure/condition: asks a thread read for the window and cursor it was given, and nothing else. |
| asks for an older page by cursor and turn count | KEEP | Six-bar file evidence above; unique failure/condition: asks for an older page by cursor and turn count. |
| omits the cursor for the first page below the window | KEEP | Six-bar file evidence above; unique failure/condition: omits the cursor for the first page below the window. |
| searches every thread with the query, the limit and an optional project | KEEP | Six-bar file evidence above; unique failure/condition: searches every thread with the query, the limit and an optional project. |
| forwards the abort signal on both reads | KEEP | Six-bar file evidence above; unique failure/condition: forwards the abort signal on both reads. |
| maps INDEX_UNAVAILABLE to a typed, non-retryable error | KEEP | Six-bar file evidence above; unique failure/condition: maps INDEX_UNAVAILABLE to a typed, non-retryable error. |
| pages a window chain to the end and answers the whole join | KEEP | Six-bar file evidence above; unique failure/condition: pages a window chain to the end and answers the whole join. |
| says what the last window says: a running call's output so far, a join cut at the host's cap | KEEP | Six-bar file evidence above; unique failure/condition: says what the last window says: a running call's output so far, a join cut at the host's cap. |
| answers an empty join empty — the call streamed nothing | KEEP | Six-bar file evidence above; unique failure/condition: answers an empty join empty — the call streamed nothing. |
| takes the whole join a host from before windows answers, whatever the query asked | KEEP | Six-bar file evidence above; unique failure/condition: takes the whole join a host from before windows answers, whatever the query asked. |
| answers null on a 404: the host's ITEM_NOT_FOUND, or a host from before the route | KEEP | Six-bar file evidence above; unique failure/condition: answers null on a 404: the host's ITEM_NOT_FOUND, or a host from before the route. |
| keeps any other failure's code | KEEP | Six-bar file evidence above; unique failure/condition: keeps any other failure's code. |
| refuses a body of neither shape, and windows that do not meet end to end | REWRITE | Require streamed-output refusal reason plus exact stopping request count, preventing unrelated errors from passing malformed/join-integrity checks. |
| refuses a window wider than one read takes, and a join past the host's cap | REWRITE | Require window-integrity refusal reason and single read; unrelated runtime failures no longer satisfy bound checks. |
| takes a whole join arriving mid-chain (an older host back after a rollback) as the answer | KEEP | Six-bar file evidence above; unique failure/condition: takes a whole join arriving mid-chain (an older host back after a rollback) as the answer. |
| answers null on a 404 mid-chain — the thread deleted between two reads — dropping what it had | KEEP | Six-bar file evidence above; unique failure/condition: answers null on a 404 mid-chain — the thread deleted between two reads — dropping what it had. |
| forwards the abort signal on every page | KEEP | Six-bar file evidence above; unique failure/condition: forwards the abort signal on every page. |
| carries a chat upload's server-minted AttachmentRef verbatim (the host answers the ref itself) | KEEP | Six-bar file evidence above; unique failure/condition: carries a chat upload's server-minted AttachmentRef verbatim (the host answers the ref itself). |
| turns an upload response into metadata only — never bytes, never a data URL | KEEP | Six-bar file evidence above; unique failure/condition: turns an upload response into metadata only — never bytes, never a data URL. |
| keeps the host's absolute path so the composer can name the file in the prompt (§7.4) | KEEP | Six-bar file evidence above; unique failure/condition: keeps the host's absolute path so the composer can name the file in the prompt (§7.4). |
| reads an attachment's bytes back over requestBytes, and refuses where the transporter has none (§7.4) | REWRITE | Require unsupported-connection refusal while preserving no JSON fallback and binary-byte/status assertions. |
| opts the stream in on every connection, a resume included, and passes the agent-rows frame through without moving the cursor | KEEP | Six-bar file evidence above; unique failure/condition: opts the stream in on every connection, a resume included, and passes the agent-rows frame through without moving the cursor. |
| reads the thread with the opt-in, and posts a request for an agent's rows | KEEP | Six-bar file evidence above; unique failure/condition: reads the thread with the opt-in, and posts a request for an agent's rows. |

## packages/ui/src/lib/agent-chat/usage-limit.logic.test.ts

Independent contract: packages/config/src/chat-usage-limit.ts persisted mode contract; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md usage-limit/send behavior. Stable seam/callers: usage-limit selectors consumed by chat controls.

Recognizable failures: incorrect availability/limit state causes denied sends or hides a recoverable condition. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| countdowns are floored to the minute and never negative | KEEP | Six-bar file evidence above; unique failure/condition: countdowns are floored to the minute and never negative. |
| the clock reads today's time alone, a weekday within the week, a date beyond | KEEP | Six-bar file evidence above; unique failure/condition: the clock reads today's time alone, a weekday within the week, a date beyond. |
| the status line follows the automatic resume | KEEP | Six-bar file evidence above; unique failure/condition: the status line follows the automatic resume. |
| the banner: title, detail, toggle and switch | KEEP | Six-bar file evidence above; unique failure/condition: the banner: title, detail, toggle and switch. |
| switching is offered only with another usable account of the same agent, never for OpenCode | KEEP | Six-bar file evidence above; unique failure/condition: switching is offered only with another usable account of the same agent, never for OpenCode. |
| account labels, the failover notice and the Limited marker | KEEP | Six-bar file evidence above; unique failure/condition: account labels, the failover notice and the Limited marker. |

## packages/ui/src/lib/agent-chat/visual-frame.test.ts

Independent contract: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §§2.2,2.4 security, URL and specified zoom limits. Stable seam/callers: visual URL/cache/key/request/zoom helpers consumed by visual frame/viewer.

Recognizable failures: signed frame uses wrong connection, stale URL reused, unfocused or untrusted frame replays app actions, prohibited shortcut forwarded or documented zoom range breaks. Unique coverage: Each baseline-named case below supplies its distinct input/transition. API/daemon fixtures cannot prove UI selection; transport fakes do not implement this owner. Explicit duplicate owners are recorded on DELETE/CONSOLIDATE rows.

| Baseline test | Disposition | Reason / surviving coverage |
| --- | --- | --- |
| the web frames a page from its own endpoint | KEEP | Six-bar file evidence above; unique failure/condition: the web frames a page from its own endpoint. |
| the desktop frames a page through its page scheme, local or remote | KEEP | Six-bar file evidence above; unique failure/condition: the desktop frames a page through its page scheme, local or remote. |
| no frame where the connection cannot carry one, or for a path that is no page | KEEP | Six-bar file evidence above; unique failure/condition: no frame where the connection cannot carry one, or for a path that is no page. |
| a cached URL is reused only with more than five minutes left | KEEP | Six-bar file evidence above; unique failure/condition: a cached URL is reused only with more than five minutes left. |
| only the allowed app chords are replayed from a page | KEEP | Six-bar file evidence above; unique failure/condition: only the allowed app chords are replayed from a page. |
| a page's request acts only from its focused frame, after the reader used the app | KEEP | Six-bar file evidence above; unique failure/condition: a page's request acts only from its focused frame, after the reader used the app. |
| the viewer zooms 50–200 % in 25 % steps | KEEP | Six-bar file evidence above; unique failure/condition: the viewer zooms 50–200 % in 25 % steps. |
