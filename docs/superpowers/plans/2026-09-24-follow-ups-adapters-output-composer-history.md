# Follow-ups: Grok, OpenCode and Codex gaps, full streamed output, reload-safe sends, rewound history, legacy agents

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task runs in its own git
> worktree on its own branch; the controller reviews and merges. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix every follow-up the owner listed on 2026-09-24 after the relaunch/streamed-output/composer plan
(`docs/superpowers/plans/2026-09-24-subagent-output-long-calls-and-composer-sends.md`):
- Grok: background shells never count as live work; subagents are not surfaced; a late update re-emits a finished
  call's start.
- OpenCode: a subagent's roster result is always empty; a running tool's output is lost.
- Codex: a subagent's command output is dropped and its drill-in has no tool rows; a completion keeps 180 characters of
  output; a crash-closed file change lists no files.
- GUI: no "Load full output" for a call whose output was streamed.
- Composer: a reload mid-send can lose the message; a torn-down store generation's queued send can land after a newer
  one.
- Rewind: a kept turn's own late rows that fall after a revert's cut leave "Load older" once the window evicts them.
- Legacy agents launched before the relaunch fix never reopen; a crash-settled turn's duration counts the downtime; a
  drill-in's "Worked for …" goes stale behind a streaming thinking block.

**Architecture:** adapter-local fixes emit the rows the fold, GUI and MCP already understand (agent-owned tool rows,
`command_output` chunks, enriching `task.completed`); the host's first load (`leftover-work.ts`, the reconcile) repairs
what older hosts wrote without changing the fold; history planning serves rows by turn across a revert's gaps without
an index change; the GUI reads the windowed output route; the composer's in-flight sends and queue survive a reload and
a store generation.

**Tech stack:** TypeScript ESM run by tsx, node:test, Fastify, the agent host, React + zustand.

**Spec / authorities:** `AGENTS.md` ("Agent chat GUI" and its gotchas, "Orquester MCP"); the GUI spec
`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`; the MCP v2 spec
`docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md` and guide `docs/orquester-mcp.md`; the fold design
`docs/superpowers/specs/2026-09-23-fold-performance-design.md`; the thread-index design
`docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`; the fixtures READMEs under
`apps/daemon/test/fixtures/`. Prior read-only investigations with file:line evidence: `/tmp/fix7/A-resumed-subagents.md`
(OpenCode/Codex/Grok subagents, liveness), `/tmp/fix7/B-claude-subagent-output.md`, `/tmp/fix7/C-long-command-start-row.md`
(Codex 180-char completion, OpenCode running output, Codex children), `/tmp/fix7/D-windowed-output-route.md`,
`/tmp/fix7/E-composer-send-and-draft.md` (reload, queue generations). Every task starts by confirming the root cause
in today's code (systematic debugging) — the code moved since those reports; where a report and this plan differ,
**this plan decides**.

## Global Constraints

- **Never launch, restart or stop the Orquester daemon or agent host**, never bind 127.0.0.1:47831 or any
  daemon/agent-host socket (in-process test hosts on temp dirs, as existing tests use, are fine), never run
  `pnpm dev*`, **never run the root `pnpm build`** (it runs electron-builder against the shared `node_modules`; a
  bundle check is `pnpm --filter @orquester/web build`), never run a real agent CLI against a model.
- Verify with `pnpm check` and the package tests of every package you touch (`pnpm --filter @orquester/daemon test`,
  `pnpm --filter @orquester/api test`, `pnpm --filter @orquester/ui test` with its `*.check.ts`); all green, pristine
  output (no warnings).
- **Absolute paths only** in shell commands; your worktree is not the main checkout. Commit on your task branch only;
  never merge, push, rebase or create other branches. You never spawn subagents.
- **TDD**: every behaviour change starts with a failing test; the report shows RED and GREEN.
- **The log is the authority.** No new domain event types; new fields optional; an older host must still fold what a
  newer one writes. **No task changes what the fold produces for an existing log: `FOLD_SNAPSHOT_VERSION`,
  `INDEX_SCHEMA_VERSION` and `AGENT_HOST_PROTOCOL_VERSION` stay unchanged.** Appending rows at a thread's first load
  (Task 7) and writing different rows for new events (Tasks 1-3) is allowed; a rule that re-reads old logs differently
  lives in a reader (history planning, GUI, MCP), never in the fold.
- The fold's per-event work must not grow with the window; `@orquester/api` has no Node APIs; no lazy `import()` under
  `apps/daemon/src/agent-host/`.
- An unmapped provider message stays a `runtime.warning`, never a silent drop; a running state never outlives its
  process (adapters close what they open).
- Client-side persisted shapes (localStorage/sessionStorage) load through field-wise validation with a fallback
  (AGENTS.md).
- Tests are `node:test` files under `src/`; nothing waits on a sleep.
- **Docs travel with the code** (AGENTS.md gotchas, the specs' `*Built:*` notes, the fixtures READMEs — marked "not
  captured" when read from a CLI's source — the MCP guide), in the codebase's voice; match the surrounding code.

## Review Focus

1. A Grok dev server started in the background holds a deploy's drain and reads "monitoring"; a Grok subagent shows
   in the roster, runs, finishes with its result, and a resumed one reopens (Task 1).
2. An OpenCode subagent's roster row ends with its real result; a running OpenCode `bash` shows its output as it
   grows (Task 2).
3. A Codex subagent's drill-in shows its commands with their output; a long Codex command's whole output is readable
   after it completes even when its chunks were evicted (Tasks 3, 4).
4. The owner reloads the page while a message is sending (or queued): it is delivered exactly once, or comes back
   to the draft — never lost, never duplicated (Task 5).
5. After a rewind that kept turn T1, "Load older" serves every row of T1 (its late rows included) and none of the
   removed turns (Task 6).

## Task ordering

All eight tasks run in parallel worktrees from main: Task 1 `adapters/grok/` + `orchestration/liveness.ts`; Task 2
`adapters/opencode/`; Task 3 `adapters/codex/`; Task 4 the GUI's full-output viewer and transport; Task 5 the UI thread
store and composer; Task 6 the host's history planning; Task 7 the host's first load (`leftover-work.ts`, the
reconcile); Task 8 the GUI rows' fold timing. Shared docs are merged by hand.

---

### Task 1: Grok — live shells, surfaced subagents, no re-emitted start

**Evidence:** `/tmp/fix7/A-resumed-subagents.md` §1.3 (Grok: `spawn_subagent` with `resume_from`,
`send_subagent_message`, `get_command_or_subagent_output`; `SubagentSpawned/Progress/Finished` strings in the 1.0.34
binary; the side finding on liveness); `apps/daemon/test/fixtures/grok/README.md` (observations 13, 28-29, fixture
`11-background-task`).

**Files:** `apps/daemon/src/agent-host/adapters/grok/` (normalize.ts, and whatever the subagent surfacing needs) + tests;
`apps/daemon/src/agent-host/orchestration/liveness.ts` + test; the Grok fixtures README; AGENTS.md; the GUI spec.

**Design (decided):**
1. **Live shells:** the liveness registry treats a background task whose `agentId` equals its own `taskId` as the
   task's own row (Grok stamps a shell with itself), not as "a subagent's internal work" — it counts as monitoring work,
   bounded by the registry's existing TTL. Claude's shells (owner-stamped) are unchanged.
2. **No re-emitted start:** a late status-less `tool_call_update` for a call that already finished never becomes a new
   `item.started` (normalize.ts ~559, ~593); it is dropped (or folded into an update of the finished call) — remember
   finished call ids in a bounded set.
3. **Subagents:** first establish from the installed Grok CLI (the binary's embedded docs/strings, the ACP extension
   methods, the fixtures) what a client sees of a subagent: the `spawn_subagent` tool call (input, rawOutput, its
   completion — foreground and `background`), any `_x.ai/*` or `session/update` frame carrying subagent progress or
   completion, and `resume_from`. Surface each subagent in the roster from what is observable, keeping the relaunch
   contract (AGENTS.md "Agent rows must survive resumes and retention", rule 1): `task.started` (agentKind `agent`,
   `taskId` = the subagent's id when the tool reports one, else the call id; `toolUseId` = the launching call id) when
   the call starts; `task.completed` with the result when it finishes (foreground: the call's completion; background:
   whatever frame reports its end — if none is observable, say so and keep it open only while the parent session
   lives); a `resume_from` launch is a new start with the new call id. The launching `spawn_subagent` row is hidden
   behind the agent's row the way a Claude Agent call is. Frames the adapter cannot map stay `runtime.warning`s.
   **If the binary gives no reliable shape for something, implement what IS observable and report the rest** — never
   guess a frame shape.

**Tests (write first):** liveness: a Grok-shaped shell (`agentId === taskId`, monitor type) is live, a Claude subagent's
internal shell is not; normalize: a late status-less update after completion emits no `item.started` (and the roster /
timeline show one call); subagents: a foreground `spawn_subagent` call yields start → completion with its result, a
`background` one yields a start and settles when its end is reported, a `resume_from` launch reopens a settled agent
(fold seam through ingestion + the real fold), the launching row is hidden.
- [ ] Commit.

### Task 2: OpenCode — the roster result, and a running tool's output

**Evidence:** `/tmp/fix7/A-resumed-subagents.md` §1.1 side note (fixture 12: the child's `session.idle` completes the
task, line 179, before the parent part carrying the output arrives, line 180; the second completion is suppressed by
`emitTaskCompleted`'s `agent.completed` guard); `/tmp/fix7/C-long-command-start-row.md` §1.1 (OpenCode running parts
carry an accumulated `state.metadata.output` — fixture `opencode/04` — which the wire slimmer's allow-list drops,
`packages/api/src/agent-chat/slim.ts` ~463-540).

**Files:** `apps/daemon/src/agent-host/adapters/opencode/` (normalize.ts) + `normalize.replay.test.ts`; the OpenCode fixtures
README; AGENTS.md; the GUI spec.

**Design (decided):**
1. **Result:** when the parent's `task` part completes (or errors) for a child whose current run the child's own
   `session.idle` already settled, emit one enriching `task.completed` for that run carrying the part's output as the
   result (the roster fold enriches a terminal agent's result from a later completion, `roster.ts` ~550-560) — once
   per run, never for a stale part of an earlier call, never reopening anything.
2. **Running output:** a running tool part whose `state.metadata.output` grows becomes `content.delta
   {streamKind: "command_output"}` chunks carrying only what was appended since the last frame (a per-part high-water
   mark), for a command-like tool (itemType `command_execution`); a value that does not extend the previous one (a
   reset, a tail window) re-bases without duplicating text — decide and document the rule from the fixture's real
   shapes. The chunks follow the call's owner (a child's part → the child's `agentId`). The completion keeps
   `state.output` as today.

**Tests (write first):** fixture 12 end to end: the child's roster row ends with the parent part's output as its result;
a resumed run's result is its own; running `bash` parts (clones of fixture 04's frames with growing
`metadata.output`) yield chunks whose concatenation equals the final output, owner-stamped for a child; a non-extending
value does not duplicate.
- [ ] Commit.

### Task 3: Codex — a subagent's tool rows and output; the whole output at completion

**Evidence:** `/tmp/fix7/B-claude-subagent-output.md` §3 and `/tmp/fix7/A-resumed-subagents.md` §1.2 (a child's
`item/*` become only `task.progress`, `normalise.ts` ~884-975; `item/commandExecution/outputDelta` and
`item/fileChange/outputDelta` are child chatter, `child-routing.ts` ~55-73, dropped); `/tmp/fix7/C-long-command-start-row.md`
§1.3 (a completion's `detail` is `aggregatedOutput` cut to 180 characters at ingestion, `truncateDetail`, and `data`
holds no output, `adapters/codex/items.ts` ~117-131; the Codex README says `outputDelta` was never seen in the
captures, so for such a command the 180 characters are all that survives).

**Files:** `apps/daemon/src/agent-host/adapters/codex/` (normalise.ts, child-routing.ts, items.ts) + tests; the Codex
fixtures README; AGENTS.md; the GUI spec.

**Design (decided):**
1. **Child rows:** a child thread's `item/started`, `item/updated`/`item/completed` become agent-owned item events
   (`agentId` = the child's thread id) exactly as the parent's items do, with item ids namespaced by the child thread
   (a child's `item_1` must never collide with the parent's); the child's `outputDelta`s become agent-owned
   `content.delta` chunks on those items. The roster's `task.progress` (description, last tool) stays. Approvals of a
   child stay parent-level (existing rule). Retention and the drill-in take it from there.
2. **Whole output at completion:** a command's completion keeps its `aggregatedOutput` in `data` (bounded — pick a cap
   and say it; beyond it the stored text is cut on a UTF-8 boundary and the item says it was cut, so
   `read_tool_output` falls through to the streamed join instead of answering a cut text as whole — check
   `commandOutputText`'s precedence in `packages/api/src/agent-chat/command-output.ts` and `apps/daemon/src/mcp/tools/output.ts`).
   The row's `detail` stays the short preview.

**Tests (write first):** synthetic frames from `_generated/protocol/v2/` (child `item/started` / `outputDelta` /
`item/completed` for a `commandExecution`): the child's call is one agent-owned tool row with its output joined, no
parent row, ids namespaced; the parent's own items unchanged; a completion with a 5 000-character `aggregatedOutput`
stores it whole and `read_tool_output` answers it; one above the cap is cut, marked, and the join wins.
- [ ] Commit.

### Task 4: GUI — "Load full output" for a call whose output was streamed

**Evidence:** `/tmp/fix7/D-windowed-output-route.md` §3.6 ("Load full output" on a streamed call shows only the
payload; the GUI never calls `agentChatRoutes.itemOutput`); `/tmp/fix7/C-long-command-start-row.md` §2.1 (evicted chunks
are missing from the GUI's joined output and no "Load full output" is offered because a Codex completion is not
`truncated`).

**Files:** `packages/ui/src/lib/agent-chat/transport.ts` (+ test), the full-output viewer (`AgentChatView.tsx`'s
`fullOutputText` and its modal), `components/agent-chat/timeline/rows/ActivityRows.tsx` (the button), the entry shape if
it needs to know a call streamed (`entries.logic.ts`), + tests / render checks; the GUI spec.

**Design (decided):**
- A command call whose entry has streamed output (joined `tool.output` chunks, or a known `toolUseId` with chunks in
  the log) offers "Load full output" whether or not its own payload was cut. It reads
  `GET agentChatRoutes.itemOutput(sessionId, itemId)` with the window query, page by page
  (`THREAD_ITEM_OUTPUT_WINDOW_*`, `isThreadItemOutputWindow`), into the viewer (a running call shows what exists now
  and says it is still running; a cut join says it was cut at the host cap). An older host that ignores the query
  (the legacy whole-join body) or lacks the route (404) falls back to today's item read — never an error.
- A file change is never read through the join (its chunks are result text, not command output — the MCP's rule).

**Tests (write first):** the transport pages a window chain to the end and handles the legacy body and a 404; the
button appears for a streamed call and not for a plain one; the viewer shows the joined text of a call whose chunks
the window evicted; running/cut notes.
- [ ] Commit.

### Task 5: Composer — a reload never loses or duplicates a message; queued sends keep their order

**Evidence:** `/tmp/fix7/E-composer-send-and-draft.md` §2.5 ("a page reload mid-send": the persisted draft was cleared
at submit and the in-memory registry is gone — the message arrives only if the POST reached the host; possible
follow-up: keep `{sessionId, commandId, payload}` in `sessionStorage` and re-post the same `commandId`, receipts make it
idempotent) and §6 A1 (ordering: a destroyed generation's queued send can still be retrying while the new generation
sends the next queued message).

**Files:** `packages/ui/src/lib/agent-chat/store.ts` (+ tests), `components/agent-chat/composer/composer-sends.ts` (and a
new persistence module beside it if cleaner), the composer where it registers sends; the GUI spec §7.4.

**Design (decided):**
1. **Reload-safe sends:** every composer send (turn/steer) and every queued message still unsent is persisted in
   `sessionStorage` (per tab: a reload of this tab resumes it, another tab never replays it) with its `commandId`,
   thread and payload, and removed when it settles. On load, for each entry younger than a bound (pick it and say
   why — receipts are a ring of 500, so a stale entry could no longer dedupe), the store re-posts the SAME
   `commandId` (the host's receipt makes a delivered one a no-op) and the thread reads "Sending" meanwhile; an entry
   past the bound, or a refused/failed re-post, comes back to the thread's draft through the failed-send restore — never
   silently dropped, never sent twice. Queued messages come back as queued, in order. Loads validate field-wise with a
   fallback.
2. **Queue order across generations:** a thread's queued sends are serialised across store generations: while a
   destroyed generation's queued send is still in flight, the live generation does not send the next queued message
   (a module-level per-thread marker next to the send registry); when it settles (delivered → next goes; failed → held
   at the front, as today) the queue proceeds in order.

**Tests (write first):** a reload (fresh store + the persisted entries) re-posts the same `commandId` once; a delivered
entry is not duplicated (the receipt answer settles it); a stale entry returns to the draft; queued messages survive a
reload in order; a malformed stored value is ignored; across a teardown the new generation waits for the old
generation's in-flight queued send before sending the next one.
- [ ] Commit.

### Task 6: History — a kept turn's late rows past a revert's cut stay in "Load older"

**Evidence:** the final review of the previous plan: `applyRevert` now clips every surviving turn's range at the cut
(`apps/daemon/src/agent-host/index/indexer.ts`, `clipAtCut`, `INDEX_SCHEMA_VERSION` 4), so a kept turn's own rows
written after the cut (a late turn-end capture, a first-load closer, a background agent's late completion stamped
with its start turn) are served only by the window; once evicted, "Load older" never serves them. The reviewer's
suggestion: the gaps between consecutive (clipped) turn ranges delimit the removed regions, history blocks are
contiguous byte reads, so the planner/fold of a page could also fold a gap event that names a SURVIVING turn.

**Files:** the host's history planning (`orchestration/orchestrator.ts`: `readHistory`, `planHistoryBlock`,
`eventsOutsideRevertCuts` or its equivalent), the index queries it uses, + tests; AGENTS.md's history notes; the
thread-index design.

**Design (decided):** at query time only (no `INDEX_SCHEMA_VERSION` change): when a history page covers (or borders) a
revert's removed region, the lines in that region that name a turn the revert kept (and that are not the revert
itself) are folded into the page with that turn's rows; lines of removed turns never are. Pages stay lossless and
never duplicate a row the window or another page serves (ids dedupe; say how the page boundaries keep it exact).

**Tests (write first):** history walks (the existing lossless helpers, real index): a background agent's call started in
T1 and completed during T2, then a rewind to T1 — after the window evicted it, "Load older" serves T1's completion and
no row of T2; a first-load closer on an old turn likewise; several reverts; a thread with no revert unchanged.
- [ ] Commit.

### Task 7: Host first load — legacy agents can reopen; a crash-settled turn ends when its process died; a closed file change keeps its files

**Evidence:** the previous plan's rulings: an OpenCode/Codex agent first launched by a host older than the relaunch fix
has no launch id on its first `task.started`, so a later relaunch (a start with a new id) cannot reopen it — the
roster fold reopens a terminal agent only when the previous start's `toolUseId` is defined (`roster.ts` ~464-468);
a turn orphaned by a host crash is settled by the next host's reconcile with a `thread.session-set` whose
`occurredAt` is the restart time, and the fold settles the turn at `event.occurredAt` (`fold.ts` `sessionSetTurns`
~1498-1511), so its duration counts the downtime; `leftover-work.ts`'s call closer copies the latest row's `data`, which
for a Codex file change is `{}` once its changes are promoted to the top-level `changedFiles`, so the closed row lists no
files.

**Files:** `apps/daemon/src/agent-host/orchestration/leftover-work.ts` (+ test), `orchestration/orchestrator.ts` (the
first-load path and the reconcile's settle), `reconcile.test.ts`; AGENTS.md; the GUI spec §3.3/§3.4.

**Design (decided) — no fold change:**
1. **Legacy launch ids:** on a thread's first load (the same paths and guards as the leftover closings), for an
   OpenCode or Codex thread (the head's adapter), every agent whose latest `task.started` carries no `toolUseId` gets
   one appended `task.started` for the same task carrying `toolUseId: "legacy-launch:<taskId>"` and its linkage — on a
   terminal agent the fold only records the launch id (no reopen, no visible row: it is the same agent's anchor), so the
   next real relaunch (a different id) reopens it. Stamp it with the task's first start's turn. Once per agent; a
   second load appends nothing.
2. **Crash-settled turn end:** the reconcile settles an orphaned turn at the time the dead process last wrote — the
   settling `thread.session-set` carries `occurredAt` = the `occurredAt` of the thread's last event before the
   reconcile's own appends (never earlier than it, so the log's times stay non-decreasing); notices it appends keep
   their own time. State in the code why this is honest (the turn ended when its process died; it is noticed later).
3. **File-change closer:** the call closer carries the latest lifecycle row's top-level `changedFiles` (and any other
   top-level payload field the GUI or MCP reads for that item type — check), not only `data`.

**Tests (write first):** a legacy OpenCode agent (start without `toolUseId`, completed) gets the backfilled start on the
first load, reads completed, and a later relaunch start reopens it (through the real fold); a Claude thread gets none;
a second load appends nothing; an orphaned turn settled by the reconcile reads its duration to its last event, not to
the restart; a crash-closed Codex file change lists its files.
- [ ] Commit.

### Task 8: GUI — a drill-in's "Worked for …" follows a streaming thinking block

**Evidence:** the previous plan's Task 8 report (pre-existing, cosmetic): in a drill-in, a thinking block that is still
streaming (per `isMessageStreaming`) never holds its turn's fold open, so when it is the last row of a folded turn the
"Worked for …" label stays stale until the next non-text row.

**Files:** `packages/ui/src/lib/agent-chat/rows.logic.ts` (and `drill-in.logic.ts` if the drill-in needs it) + tests;
the GUI spec.

**Design (decided):** a message that reads as streaming by `isMessageStreaming` keeps its turn's fold live (label and
timing) in the drill-in as it does in the parent view, and the streamed-text fast path keeps the fold's label current;
nothing else about folds changes.

**Tests (write first):** a drill-in whose last row is a streaming thinking block shows a live label that follows the
tokens; the same block once settled closes the fold with its final duration; the parent view unchanged.
- [ ] Commit.
