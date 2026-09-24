# Relaunched subagents, a subagent's output, long-running calls, windowed output, and one send per thread

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task runs in its own git
> worktree on its own branch; the controller reviews and merges. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fix the follow-ups the owner listed on 2026-09-24, completely:
1. a resumed OpenCode subagent (and a re-engaged Codex one) reads as running while it works, then settles;
2. a Claude subagent's tool output carries the subagent's id, so it reaches its drill-in and never strays into the
   parent timeline;
3. a long-running parent command (Codex, > ~550 output chunks) keeps its opening row while it runs;
4. a windowed, cheap host route for a tool call's streamed output;
5. an evicted call's entry is titled from the call, not "Tool output";
6. a restored draft can hold more than 8 attachments without losing any;
7. a composer remounted while its thread's send is still retrying cannot send a second time.

**Architecture:** adapter normalisers emit the rows the roster fold already understands (a relaunch is a new
`task.started` with a new launch id); the Claude normaliser stamps a call's owner and start turn on every event of
the call and lets a background subagent's calls outlive the parent's turn; the fold's retention keeps the opening row
of running work (bounded); a host start closes whatever a dead process left open; the GUI shows a running call as
one titled row; the host serves streamed output one window at a time from an incremental cache; the composer's
in-flight send state lives outside the component, per thread.

**Tech stack:** TypeScript ESM run by tsx, node:test, Fastify, the agent host, React + zustand.

**Spec / authorities:** `AGENTS.md` ("Agent chat GUI" and its gotchas, "Orquester MCP"); the GUI spec
`docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`; the MCP v2 spec
`docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md` and guide `docs/orquester-mcp.md`; the fold design
`docs/superpowers/specs/2026-09-23-fold-performance-design.md`; the thread-index design
`docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md`. Root-cause evidence for every task was
gathered read-only on 2026-09-24 and is referenced per task (`/tmp/fix7/*.md`, with runnable scratch probes and
prototypes next to each); where a report and this plan differ, **this plan decides**.

## What the investigation changed

- **Claude background subagents are the default** (CLI 2.1.280: `run_in_background` defaults to true). On this
  host, 97 of 112 subagents in the biggest thread finished after the parent's turn ended. Between parent turns our
  normaliser drops every subagent output chunk (a `this.turnState` guard), force-completes at the parent's `result`
  every tool a background agent still has in flight (its real result is then dropped), and ingestion never settles a
  turnless subagent message (5 479 still read "Thinking" in one thread). Claude never streams a foreground Bash, so
  "running output" does not exist for it; the missing `agentId` is a one-line omission on the chunk.
- **A running command's opening row is evicted by its own chunks** (parent at chunk 550, an agent-owned call at 250,
  and under the cross-agent ceiling too), and a running background shell's `task.started` is evicted after 550
  parent rows, which drops the shell from the roster while it runs. Independently, the GUI's parent timeline never
  shows a `tool.started`, so a running Codex command never shows its title, and each chunk counts as a tool.
- **Neither OpenCode nor Codex ever emits a relaunch row**, and neither puts a launch id on an agent's first start,
  so the roster fold's existing reopen rule cannot fire. No fold change is needed.
- **Every `read_tool_output` page re-reads the whole thread log twice** on the host (the item read and the join) and
  ships the whole join (≤ 8 MiB); paging 8 MiB is ~300 whole-log reads.
- **The duplicate send is reproduced**: `sending` is component state; the store keeps retrying the same `commandId`
  after a project switch unmounts the composer; the new composer is idle and empty. A restore can hold 16 chips; the
  next load keeps 8 silently; a live draft of 16 posts and the host refuses it.

## Global Constraints

- **Never launch, restart or stop the Orquester daemon or agent host**, never bind 127.0.0.1:47831 or any
  daemon/agent-host socket, never run `pnpm dev*`, never run a real agent CLI against a model. Verify with
  `pnpm check` and the package tests of every package you touch (`pnpm --filter @orquester/daemon test`,
  `pnpm --filter @orquester/api test`, `pnpm --filter @orquester/ui test`); all must pass with pristine output (no
  warnings).
- **Absolute paths only** in shell commands; your worktree is not the main checkout. Commit on your task branch only;
  never merge, push, rebase onto main or create other branches. You never spawn subagents.
- **TDD**: every behaviour change starts with a failing test; the report shows RED and GREEN.
- **The log is the authority.** `events.ndjson` is outside every deploy rollback: no new domain event types, new
  fields optional, an older host must still fold what a newer one writes. The fold snapshot and the thread index are
  caches.
- **Only Task 3 changes what the fold produces** (`FOLD_SNAPSHOT_VERSION` 3 → 4). No task bumps
  `INDEX_SCHEMA_VERSION` or `AGENT_HOST_PROTOCOL_VERSION`.
- **The fold's per-event work must not grow with the window** (AGENTS.md): no per-event walk of `activities`; caches
  live in the fold's `WeakMap` and are never state; the determinism suites hold at every split point.
- `@orquester/api` is shared with the browser: no Node APIs there. No lazy `import()` under
  `apps/daemon/src/agent-host/`.
- MCP invariants: tools reach the daemon only through `DaemonApi`; every result ≤ 60 000 bytes and self-bounded;
  errors `<CODE>: <message>`; strict arguments; 31 tools; descriptions ≤ 400 characters; `SERVER_INSTRUCTIONS`
  ≤ 2 KB.
- Tests are `node:test` files under `src/`; nothing waits on a sleep (wait on a receipt, a drain, or an event).
- **Docs travel with the code**: `AGENTS.md` gotchas, the specs' `*Built:*` notes, the fixtures READMEs, the MCP guide.
  Write in the codebase's voice: say what is true now and why; name the file and function.
- Match the surrounding code: its comment density, naming and idioms.

## Review Focus

1. A Claude subagent in the background keeps working after the parent's turn ends: its drill-in shows every call
   with its output, its tools are never reported "completed" before they finish, and its words settle (Task 2).
2. A dev server started in the background runs for hours with thousands of chunks: its roster row, its drill-in row
   titled with the command, and its live output stay; the MCP pages its whole output cheaply (Tasks 3, 5, 6).
3. A Codex build streams thousands of lines: the GUI shows one "Running <command>" row, then "Ran 1 command"; the MCP
   has one entry with an `outputItemId` while it runs (Tasks 3, 5). *(Planned so; ruled otherwise at Task 5's review,
   minor 4: once done, the command renders exactly as one that streamed nothing — its row, labelled with its command —
   never a "Ran 1 command" toggle hiding its one row. The GUI spec §7.3 `*Built:*` note says so.)*
4. The host is killed mid-work: after it starts again no call, shell, agent or message is left "running" forever
   (Task 4).
5. The owner switches project mid-send and comes back: the composer reads "Sending" and refuses a second send; a
   failed send comes back once, with every file, and a draft over eight files cannot be sent until trimmed (Task 7).
6. An OpenCode subagent resumed with `task_id`, or a Codex agent re-engaged after it finished, reads running, then
   settles with its new result (Task 1).

## Task ordering

- **Wave 1, in parallel from main:** Tasks 1, 2, 3, 6, 7 — disjoint code (Task 1: OpenCode/Codex normalisers; Task 2:
  Claude normaliser, ingestion, GUI `entries.logic.ts`, MCP `transcript.ts`; Task 3: api fold + a new
  `open-work.ts`, MCP `history.ts`; Task 6: host store/route, proxy, wire, MCP `tools/output.ts`; Task 7: UI composer
  + thread store). Shared docs (`AGENTS.md`, the specs, the guide) and `ingestion/fold-integration.test.ts` are merged
  by hand if git cannot.
- **Wave 3, after Task 5 merged:** Task 8 (added after Task 4's review) — it edits the GUI readers Task 5 edits.
- **Wave 2, from main after wave 1 merged:** Tasks 4 and 5 — both consume Task 3's `open-work.ts`, and Task 5 edits
  what Task 2 edits in `entries.logic.ts` and `transcript.ts`.

---

### Task 1: a re-engaged subagent reopens and settles — OpenCode and Codex

**Evidence:** `/tmp/fix7/A-resumed-subagents.md` (validated patches on scratch copies:
`/tmp/fix7/scratch-A/proposed/patch-oc.mjs`, `patch-codex.mjs`; the OpenCode 1.18.32 `TaskTool` source slice
`/tmp/fix7/scratch-A/opencode-task-tool.js`).

**Files:**
- Modify: `apps/daemon/src/agent-host/adapters/opencode/normalize.ts` (+ `normalize.replay.test.ts`)
- Modify: `apps/daemon/src/agent-host/adapters/codex/normalise.ts` (+ `child-routing.test.ts` or a new
  `collab-relaunch.test.ts`; `session.test.ts` for Stop), and `codex/session.ts` only if `trackTask` needs it
- Modify: `apps/daemon/src/agent-host/ingestion/fold-integration.test.ts` (relaunch through the real ingestion + fold)
- Docs: `AGENTS.md` ("Agent rows must survive resumes and retention", rule 1), `apps/daemon/test/fixtures/opencode/README.md`
  and `apps/daemon/test/fixtures/codex/README.md` (new observations, marked as read from the CLI source, not captured),
  the doc comment of the completion-bound rule in `apps/daemon/src/mcp/history.ts` (~176-213) and its sentence in the
  MCP v2 spec (~765-773: rows after a stamped end remain possible in logs written before this change, so the floor
  stays), a `*Built:*` note in the GUI spec's roster section.

**Interfaces:** Consumes nothing new. Produces the contract below (no new exports).

**Design (decided):**
- The contract every agent-surfacing adapter now keeps — the roster fold (`packages/api/src/agent-chat/roster.ts`)
  already reopens a terminal agent on a `task.started` whose `toolUseId` differs from the previous start's, and an
  `idle` one on any start; **the fold does not change**:
  - I1: every agent's **first** `task.started` carries a `toolUseId` (a launch id);
  - I2: a re-engagement of an agent that is not live emits a **new** `task.started` whose `toolUseId` differs from the
    previous start's, before any row of the new run;
  - I3: the new run ends with the adapter's normal end row;
  - I4: no stale end row of an earlier run is emitted after a relaunch;
  - I5: the adapter's internal live sets reopen, so Stop and session exit close the new run `stopped`.
- **OpenCode** (`normalize.ts`; a `task` call with `task_id` re-prompts the existing child: no `session.created`, the
  new `task` part's `running` frame names the existing child in `state.metadata.sessionId`):
  1. `ensureChildAgent` sets `toolUseId` only when the agent has none; only a relaunch re-points it.
  2. `demuxChild`'s `session.created` no longer emits `task.started`; the parent's `running` task part (which
     follows it) emits the first start, carrying its `callID`. Every other child path still emits a start first,
     without a `toolUseId`, when none was emitted (a missed frame, a grandchild), so no child is ever rowless.
  3. `linkChildFromTaskPart`, for a known child whose recorded `toolUseId` differs from this part's `callID`: when
     the part is live (`pending`/`running`) and the child is settled (`completed`, or last status `idle`) it is a
     relaunch — re-point `toolUseId`, reset `completed`/`started`/`lastStatus` so the existing tail emits
     `task.started(new callID)` and the progress row; otherwise (a stale frame of an older call, or a second call on
     a LIVE child — 1.18.32's "Background task updated") return without emitting any task row.
  4. A `completed` task part whose `state.metadata.background === true` does not settle the child (the part
     completes at once while the child works; the child's own `session.idle` settles it).
- **Codex** (`normalise.ts`):
  1. `subAgentActivity` `started`: its `task.started` gains `toolUseId: "codex-launch:<item.id>"`; the child is
     recorded as launched in this session, with its linkage (agent path, title, agent kind) kept for later starts.
  2. A child's own `turn/started`, when the child has no turn in progress **and** either has a settled run behind it
     (its `turn/completed`, `thread/closed`, or a `subAgentActivity` `completed`/`interrupted`) or was never launched
     in this session (a resume after a host restart): emit `task.started {taskId: child, toolUseId:
     "codex-run:<turn.id>", …the recorded linkage}` **before** the progress row, and re-add the child's path to
     `knownAgentPaths` so the re-engaging parent turn gets `hasSubagents`.
  3. `subAgentActivity` `interacted`: the progress row no longer carries `status: "running"` (an interaction is no
     evidence of a run — `send_message` "does not trigger a new turn" — and it left the liveness registry reading
     "working" with nothing to settle it).
  4. Stop and exit close a re-engaged run (`trackTask` re-adds on any `task.started`; verify with a session test).
  5. The test "a collab child never hijacks the parent's turn" keeps its claim (the parent's turn is untouched); its
     expected events gain the relaunch start for a child never launched in this session.
- **Grok** surfaces no subagents (only background tasks); nothing changes there.
- **Legacy logs:** an agent first launched before this change has no launch id on its first start, so a relaunch
  from a terminal state does not reopen it (OpenCode falls back to the evictable `task.updated{running}`). Documented,
  not fixed (it would need a fold change that weakens the late-delivery guard).

**Tests (write first; from report A §4):**
- [ ] OpenCode (`normalize.replay.test.ts`, keep the `OpenCodeSessionState` after fixture 12 and feed resume frames
  cloned from its frames 140/142/148/156-160/177-180 with new ids and no `session.created`): (1) fixture 12's first
  `task.started` carries `call_107260`; (2) a `task_id` resume of a settled child emits exactly one new
  `task.started` naming the new call, before any child row of the run, then `task.updated running`, then
  `task.completed` at the child's `session.idle`; (3) a stale part of the previous call after a relaunch never emits
  `task.completed`; (4) a second call on a LIVE child is not a relaunch and its immediate `completed` part does not
  settle the child; (5) `closeLiveChildAgents` closes a relaunched child `stopped`; (6) a background task part
  (`metadata.background: true`) completing does not settle the child. Update "a live child is closed `stopped` when
  the session goes down" to assert on the `task.completed` element.
- [ ] Codex (built from `_generated/protocol/v2/` shapes): the launch record's start carries a launch id; a child's
  turn after its previous turn completed emits a relaunch start with a new id before its progress row; the same after
  `subAgentActivity completed` and after `thread/closed`; `interacted` alone does not make the agent live (feed the
  events to `createLivenessRegistry`: `liveness() === null`); Stop closes a re-engaged child `stopped`
  (`session.test.ts`).
- [ ] Fold seam (`fold-integration.test.ts`): a relaunch reads running (run 2), then settles with the new result; a
  relaunched run stays running under 300 agent-owned tool calls; a status-only reopen does NOT survive retention (pins
  why the adapters emit a start).
- [ ] Commit.

### Task 2: Claude — a subagent's calls keep their owner and their turn, and outlive the parent's turn

**Evidence:** `/tmp/fix7/B-claude-subagent-output.md` (§1-§6 the missing stamp; §7 background agents between parent
turns and `tool_progress`; failing-first probes in `/tmp/fix7/scratch-B/`, e.g. `invariant.test.mts`,
`outlive-probe.mts`).

**Files:**
- Modify: `apps/daemon/src/agent-host/adapters/claude/normalize.ts` (+ `normalize.test.ts`)
- Modify: `apps/daemon/src/agent-host/ingestion/index.ts` (+ `index.test.ts`); `ingestion/fold-integration.test.ts`
- Modify: `packages/ui/src/lib/agent-chat/entries.logic.ts` (+ `entries.logic.test.ts`)
- Modify: `apps/daemon/src/mcp/transcript.ts` (+ `transcript.test.ts`)
- Docs: `AGENTS.md` (a sixth rule under "Agent rows must survive resumes and retention"; the background-agent
  behaviour), `apps/daemon/test/fixtures/claude/README.md` (new observations: a subagent's `tool_result` names only
  `parent_tool_use_id`; agents run in the background by default on 2.1.280 and outlive the parent's `result`; nested
  `tool_progress` frames carry no `task_id`), `docs/orquester-mcp.md` (~733-739) and the MCP v2 spec follow-up line
  (~853-854), a `*Built:*` note in the GUI spec (drill-in ownership).

**Interfaces:** Consumes nothing new. Produces no new exports; the chunk contract becomes "a call's `tool.output`
rows carry the call's owner (`agentId`) and the call's start turn".

**Design (decided):**
1. **A call's turn is the turn it started in.** `ToolInFlight` gains `turnId` (the active turn at registration —
   `handleContentBlockStart` and `nestedAssistantEvents` — possibly undefined). Every event of that call —
   `item.updated`, the output `content.delta`, `tool.denied`, `item.completed`, and a force-completion — uses
   `tool.turnId`, never the turn active when it is emitted. Nested frames never open a synthetic turn.
2. **The output chunk carries the call's owner:** `...(tool.agentId !== undefined ? { agentId: tool.agentId } : {})`
   on the `content.delta` built from a `tool_result` (`handleUserMessage`), exactly as the call's item rows.
3. **No turn guard on the chunk:** a nested `tool_result` between parent turns emits its chunk (on the call's own
   turn, or turnless). A parent tool cannot reach this path without a turn.
4. **A background agent's tools outlive the parent's turn.** `completeTurn` (and the stale synthetic-turn auto-close
   that reaches it) neither force-completes nor forgets an in-flight tool whose owner is a live background task
   (`is_backgrounded === true`); such a tool closes (a) by its own `tool_result`; (b) on its owner's terminal edge —
   a new `closeInFlightToolsOf(taskId)` called from `handleTaskNotification` and a terminal `handleTaskUpdated`,
   **before** the task row, emitting `item.completed {status: "failed"}` on the tool's own turn and owner; (c) in
   `closeLiveTasks` at teardown. A foreground agent (`is_backgrounded` false or absent — fixture 07, older CLIs) keeps
   today's force-completion at the parent's turn end.
5. The CLI-denial path that finds no in-flight tool stamps the resolved nested owner on its `tool.denied`.
6. **`tool_progress` owner:** from the call (`inFlightToolById(tool_use_id)?.agentId`, else the nested owner of
   `parent_tool_use_id`); `message.task_id` is used only when it names a surfaced `local_agent` task; `taskId` and
   `agentId` are that owner; the event rides the tool's own turn. A parent tool's progress stays without `taskId` (not
   persisted, by design).
7. **Ingestion settles a turnless message:** a turnless `item.completed` for an `assistant_message`/`reasoning` item
   finalizes the turnless message its deltas created (the same id derivation — `segmentMessageId(…, 0, …)`, the
   reasoning `summary:`/`raw:` variants — and the same "fallback text only if nothing streamed" rule as the in-turn
   completion).
8. **Existing logs, read side only (no fold change):** an UNSTAMPED `tool.output` row inherits the owner of its
   call's lifecycle rows (`tool.started|updated|completed|denied` with the same `payload.toolUseId` and a non-blank
   `agentId`) found in the same derivation input. GUI: `deriveWorkLogEntries` skips it in a view whose owner differs
   (the parent view: whenever its call's owner is an agent), and `itemsForAgent(items, agentId)` includes it for its
   owner; MCP: `transcriptEntries`' scope sends it to its owner's drill-in only. The MCP parent view still never
   builds an entry from chunks alone.
- No `FOLD_SNAPSHOT_VERSION` or `INDEX_SCHEMA_VERSION` bump.

**Tests (write first; report B §5 and §7.6-7.7):**
- [ ] `normalize.test.ts`: every capture's `command_output`/`file_change_output` delta carries the `agentId` of its
  item's `item.started` (fails on 07 today); fixture 07's subagent chunk carries its task id and the parent's
  background-launch chunk carries none; a nested Bash and a nested Write inside `beginTurn` stamp their deltas; the
  buffered (`flushPendingNested`) and resumed (alias) paths stamp; a depth-2 agent's delta carries the innermost
  agent; a subagent's background-launch placeholder carries the subagent while `bgshell:` chunks keep the shell id; a
  CLI-denied subagent Bash stamps delta and `tool.denied`; the parent's deltas and approvals carry none.
- [ ] `normalize.test.ts`, "a background subagent outlives the parent's turn": a nested `tool_result` with no active
  turn emits a stamped delta; with `task_started {is_backgrounded: true}` the parent's `result` does not complete the
  agent's in-flight tool and its later `tool_result` yields `item.updated` → delta → `item.completed` with
  `data.result`, all on the call's start turn; the owner's `task_notification` first closes its open tools (`failed`)
  then emits `task.completed`; `closeLiveTasks()` closes every in-flight nested tool; a foreground agent's tools are
  still force-completed; a nested `tool_progress` without `task_id` yields `tool.progress {taskId: <owner>}`.
- [ ] `ingestion/index.test.ts`: a turnless owned assistant message and a turnless owned reasoning message each end in
  a `streaming: false` `thread.message-sent` on their own `item.completed`; a turnless stamped delta yields a turnless
  stamped `tool.output` (lock).
- [ ] `fold-integration.test.ts`: fixture 07 end to end — every `tool.output` of an agent-owned call carries the
  call's `agentId`; the outlive sequence gives one call on one turn key and owner, and settled agent messages.
- [ ] GUI (`entries.logic.test.ts`): a stamped chunk never enters the parent's entries and joins its agent's
  completion row in the drill-in; an UNSTAMPED chunk of an agent's call is skipped in the parent view and included by
  `itemsForAgent` for that agent only; an unstamped PARENT chunk still joins its parent row.
- [ ] MCP (`transcript.test.ts`): a drill-in with a stamped chunk of a non-cut completion offers `outputItemId` = the
  completion; the same with an UNSTAMPED chunk (old log); the parent view still builds no entry from a lone chunk.
- [ ] Commit.

### Task 3: the fold keeps the opening row of running work

**Evidence:** `/tmp/fix7/C-long-command-start-row.md` (§1.5 eviction points, §3 options; the validated prototype
`/tmp/fix7/scratch-C/fold-option-a.diff`, `fold-logs-long-calls.diff`, `api-copy/zz-open-call*.test.ts`).

**Files:**
- Create: `packages/api/src/agent-chat/open-work.ts` (+ `open-work.test.ts`), exported from the api package index
- Modify: `packages/api/src/agent-chat/fold.ts`, `fold-snapshot.ts` (`FOLD_SNAPSHOT_VERSION` 4 + its version-log
  entry), `fold.retention.test.ts` (and its reference model), `fold-logs.test-support.ts` (also fix its parked comment
  nit at ~802-803: "after it" → "after them"), a new `fold.determinism-open-work.test.ts`, `fold.caches.test.ts`,
  `fold-snapshot.test.ts`
- Modify: `apps/daemon/src/mcp/history.ts` (+ `history.test.ts`): the snapshot-only fallback mirrors the exemption
- Docs: `AGENTS.md` (the fold gotcha "The fold's work per event must not grow with the window": the new exemption,
  caps and version 4; "Background shells (Claude)": a running shell keeps its start and its roster row), a follow-up
  section in the fold-performance design, a `*Built:*` note in the GUI spec's retention section, the thread-index
  design's `FOLD_SNAPSHOT_VERSION` mention.

**Interfaces:**
- Produces (in `open-work.ts`, exported from `@orquester/api`), consumed by Tasks 4 and 5:
  - `CALL_OPENER_KINDS: ReadonlySet<string>` = `tool.started`, `tool.updated`;
    `CALL_CLOSER_KINDS: ReadonlySet<string>` = `tool.completed`, `tool.denied`.
  - `openWorkOf(activities)` → `{ calls: OpenCall[]; tasks: OpenBackgroundTask[] }`, pure, one pass, where
    `OpenCall = { toolUseId, opening, openingIndex, latestLifecycle, lastActiveIndex }` and
    `OpenBackgroundTask = { taskId, start, startIndex, lastActiveIndex }` (activity fields use the fold's activity
    type; indexes are list positions).
  - Definitions: a **call** is keyed by a non-blank `payload.toolUseId`; it is **open** when the list holds a
    `CALL_OPENER_KINDS` row of it and no `CALL_CLOSER_KINDS` row; its **opening row** is its first opener row in list
    order; `latestLifecycle` is its newest opener row; its **last activity** is the index of its newest `tool.*` row
    (`tool.output` included). A **background task** is keyed by `payload.taskId`; it is open when the list holds its
    `task.started` whose `agentKind` is not `"agent"` and no `task.completed` of it; its last activity is the index of
    its newest `task.*` row or of any row whose `agentId` equals the task id.
- Produces constants `OPEN_WORK_RETENTION_LIMIT = 16` and `OPEN_WORK_TOTAL_RETENTION_LIMIT = 64` (exported from
  `fold.ts`).

**Design (decided):**
- In the trim (`activitiesToDrop`), exactly like an open message-mode question: the opening rows of the
  `OPEN_WORK_RETENTION_LIMIT` most recently active open units (calls and background tasks together, ranked by last
  activity) whose opening row belongs to a window are kept by that window's trim (the parent's, each agent's); under
  the cross-agent ceiling the opening rows of the `OPEN_WORK_TOTAL_RETENTION_LIMIT` most recently active open units
  among agent-owned opening rows are kept. A kept row still counts in its class (the trigger is unchanged), so every
  trim still frees at least slack − cap rows and no step trims every event.
- Unchanged: the classes, the counters, `retentionTriggered`, the caches and `__foldCacheConsistency`, `trimWindow`,
  the roster engine, the host's `windowBoundary` (exempt rows are older than the positional cut; a page may repeat
  one, and readers dedupe by id).
- The walk that finds open work runs only inside a trim (rare); never per event.
- `FOLD_SNAPSHOT_VERSION` 3 → 4: every cached `state.json` is refused on its next load and the log re-folded once.
- MCP (`mcp/history.ts`): `keptWhateverItsAge` and `agentWindowOldestTurn` treat the opening row of every unit
  `openWorkOf` finds open in the snapshot as kept whatever its age (conservative: it can only name one partial turn
  too many), so the window's oldest turn is not read off an exempt opener.

**Tests (write first; report C §5 items 1-5 and 11):**
- [ ] `open-work.test.ts`: opening row, latest lifecycle and last activity per call and per background task; a closer
  closes; an agent task is never a background task; blank ids are ignored.
- [ ] `fold.retention.test.ts`: the opener of an open parent call survives 1 200 of its own chunks and the window stays
  ≤ 552 rows (fails today on chunk 550); the same for an agent-owned call after 520 parent rows (fails on 250) and
  under the ceiling (12 agents × 200+ rows); the opener is dropped by a later trim once `tool.completed` or
  `tool.denied` arrives, never before; 40 dangling starts plus one streaming call keep the streaming call's opener,
  keep ≤ 16 openers per window, and every trim frees ≥ slack − 16 rows; an open background task's `task.started`
  survives 600 parent rows and the roster keeps the shell (fails today: the roster empties); the reference model gains
  the rule, written independently, and matches over a long-call log.
- [ ] `fold-logs.test-support.ts`: `openCall`/`chunk`/`closeCall` actions (and a shell), `LONG_CALL_WEIGHTS`, and an
  `openWorkFate(events)` helper proving a log exercised the rule; `fold.determinism-open-work.test.ts`: JSON at every
  split, literal tails at the landmarks; `fold.caches.test.ts`: caches carried forward equal the rebuild on the
  long-call log (roster included); `fold-snapshot.test.ts`: the version is > 3.
- [ ] `history.test.ts` (snapshot-only path, `indexed: false`): an old open opener does not make `windowSpan` or
  `agentWindowOldestTurn` name its early turn.
- [ ] Commit.

### Task 4: a host start closes what a dead process left open

**Evidence:** `/tmp/fix7/C-long-command-start-row.md` (§3.3 "H1"), `/tmp/fix7/B-claude-subagent-output.md` (§7.4:
turnless messages still streaming), `AGENTS.md` ("A running state never outlives its process", "Boot folds only
orphaned threads").

**Files:**
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.ts` (next to `settleStalePendingTurns` /
  `settleOnFirstLoad` / `reconcileThread`) (+ its tests — find the orchestrator's reconcile and first-load tests)
- Docs: `AGENTS.md` (the two gotchas above), `apps/daemon/src/agent-host/README.md` if it describes the reconcile, a
  `*Built:*` note in the GUI spec §3.3/§3.4.

**Interfaces:** Consumes `openWorkOf`, `CALL_OPENER_KINDS`, `CALL_CLOSER_KINDS` from `@orquester/api` (Task 3).

**Design (decided):**
- A thread's first load in a host lifetime — the `bootSettlePending` settle in `loadRuntime` and the orphaned-thread
  path of `reconcileThread`, both after `settleStalePendingTurns` — also closes what the fold shows running, because
  no provider process of this host can own it yet. It never runs for a thread an adapter lists as live
  (`listSessions()`), and it runs before the runtime is published, so no reader ever sees the leftovers.
- What it appends, through the same commit path the settle uses, only for rows in the folded window:
  1. every open call (`openWorkOf(...).calls`): a `tool.completed` for its `toolUseId`, with the item type, title,
     turn and owner of its `latestLifecycle`, the status the adapters' own teardown writes for an item it closes
     (read `closeBackgroundShellItem` and Codex's `closeOpenItems` and use the same), detail "Stopped when the agent
     host restarted.";
  2. every roster task still `running`/`pending` (any agent kind; `idle` is left alone, as the fold's session-death
     rule leaves it): `task.completed {status: "stopped"}` with its linkage — a background shell's item closes before
     its task, the adapters' ordering;
  3. *(Amended after review — see Task 8.)* No message is written to. Settling a stuck `streaming: true` message
     with a `thread.message-sent` at the log's end moves its span in the thread index to that line, and history
     planning then pulls a page's end back to the message's first chunk: thousands of recent rows became
     unreachable from "Load older". A stuck flag is read as settled instead (Task 8).
- Best-effort, like `settleOnFirstLoad`: a failure is logged and the thread still loads. A second load appends
  nothing.

**Tests (write first):**
- [ ] A thread whose log holds an open parent call, an open background shell (item + task), a running subagent, an
  `idle` Codex-style agent and a turnless streaming message: its first load appends the closings above (in that order
  for the shell), the snapshot the first reader sees has nothing running, the `idle` agent is untouched.
- [ ] The same on the orphaned-thread reconcile path; a thread with a live adapter session is untouched; a second
  load appends nothing; a failure to append still loads the thread.
- [ ] Commit.

### Task 5: the GUI shows a running call as one titled row; placeholder titles

**Evidence:** `/tmp/fix7/C-long-command-start-row.md` (§2 GUI and MCP today, §3.3 F2 "G-1/G-2/G-3" and F3 "M-2", §4).

**Files:**
- Modify: `packages/ui/src/lib/agent-chat/entries.logic.ts` (+ test), `presentation.logic.ts` (+ test),
  `rows.logic.ts` (+ test), `packages/ui/src/components/agent-chat/timeline/row-chrome.ts` (+ test),
  `components/agent-chat/roster/background-shell.ts` (+ test), `AgentDrillIn.tsx`
- Modify: `apps/daemon/src/mcp/transcript.ts` (+ `transcript.test.ts`)
- Docs: GUI spec timeline `*Built:*` notes; `docs/orquester-mcp.md` and the MCP v2 spec §7.2 (the chunk-built entry's
  title).

**Interfaces:** Consumes `openWorkOf` / `CALL_OPENER_KINDS` / `CALL_CLOSER_KINDS` (Task 3) and Task 2's
`deriveWorkLogEntries`/`itemsForAgent` fallback.

**Design (decided):**
- **G-1:** a keyed `tool.started` stays its call's row while the derivation input holds no other lifecycle row of the
  call (`tool.updated`, `tool.completed`, `tool.denied`); an unkeyed start, or the start of a call that has another
  lifecycle row, is dropped as today. A start with neither a turn nor an owner (`agentId`) is also dropped as today
  (added after Task 2's review): a turnless PARENT start exists only when a Claude parent call starts before the turn
  its own message opens (its later rows carry that turn), so alone it is never a running call, and a rewind that cut
  its turn must not resurface it. (After Task 4 an open call is running; pages, bridge and window of one call
  are derived together, so the closing row is always in the same input as the start.)
- **G-2:** one definition, `isStreamedOutputEntry(entry)` (`sourceActivityKind === "tool.output"`), that
  `row-chrome.ts`'s `isToolOutputRow` re-exports; a chunk entry whose call has a non-chunk entry in the same list never
  breaks the live streak, never supplies the live row's label, and never counts as a tool or a hidden row in a
  group's summary — while `groupedEntries` still carries it so `joinLifecycleDetails` joins the output. A running
  command reads "Running <command>"; once done, "Ran 1 command". *(Planned so; ruled otherwise at Task 5's review,
  minor 4: the single-row branch decides on the list without the call's own output, so a settled streamed command
  renders exactly as one without chunks — its row, labelled with its command, e.g. "npm run build" — and not as a
  "Ran 1 command" toggle; GUI spec §7.3 `*Built:*` note.)*
- **G-3:** orphan chunks of one call join into ONE row (the first carries the joined text; nothing is lost);
  `backgroundShellRows(items, agentId, fallbackTitle?)` titles the shell's row from the roster row (`AgentDrillIn`
  passes `agent?.title`) when no lifecycle frame of the shell is left.
- **M-1b (added after Task 2's review):** the MCP transcript mirrors G-1's exception — a `tool.started` with neither a
  turn nor an owner, whose call has no other lifecycle row in the view, builds no entry.
- **Docs (added after Task 3's review):** the comment in `mcp/transcript.ts` on why the parent view builds no entry
  from chunks, and the MCP v2 spec's "Fix round 1" note, say what is true after Tasks 2-3.
- **M-2:** a chunk-built drill-in entry is titled `facts.title ?? <the drill-in's roster row title, when its
  agentKind is "background"> ?? facts.command ?? chunk.summary`; a subagent's roster title is never used (it names
  none of its calls). The parent view still builds no entry from chunks alone (Task 3 keeps the opener).

**Tests (write first; report C §5 items 6-10):**
- [ ] `entries.logic.test.ts`: a keyed start with no other lifecycle row is the call's entry (command, `inProgress`)
  and is dropped once an update, completion or denial of the call exists.
- [ ] `rows.logic.test.ts`: a running command plus N chunks is ONE `work-live` row labelled "Running npm"; a chunk
  reading "No such file or directory" neither splits the run nor marks it failed; a settled call plus 3 chunks reads
  "Ran 1 command" with `hiddenCount` 1. *(Superseded by the same ruling: the test pins that a settled call and its
  chunks render exactly as the call would without them — its row, labelled with its command.)*
- [ ] `row-chrome.test.ts`: several orphan chunks of one call join into one row with no text lost.
- [ ] `background-shell.test.ts`: with no lifecycle frame left, one row titled from `fallbackTitle`, with the joined
  output.
- [ ] `transcript.test.ts`: the chunk-built entry of a background task is titled from its roster row ("npm run dev");
  a subagent's roster row is never used; a real fold of a start plus 1 200 chunks, slimmed, keeps the parent entry
  with its title, command and `outputItemId`.
- [ ] Commit.

### Task 6: windowed streamed output, served from an incremental host cache

**Evidence:** `/tmp/fix7/D-windowed-output-route.md` (cost measurements, API design §3, rollout §4, tests §5; the
incremental-join prototype `/tmp/fix7/scratch-D/incremental.mts`, window parity `parity.mts`).

**Files:** `packages/api/src/agent-chat/wire.ts` (+ `contracts.test.ts`); `apps/daemon/src/agent-host/store/tool-output.ts`
(+ test), `store/index.ts`, `orchestration/orchestrator.ts` (next to `readToolOutput`), `server/http-server.ts`
(+ test); `apps/daemon/src/agent-chat/proxy-routes.ts` (+ test); `apps/daemon/src/mcp/tools/output.ts`
(+ `output.test.ts`, `output.integration.test.ts`); docs per report D §5.7 (`AGENTS.md` routes table, the MCP
paragraph and the caches gotcha; `apps/daemon/src/agent-host/README.md`; `docs/orquester-mcp.md`; the MCP v2 spec
§7.2 row; a GUI spec §6.3 `*Built:*` note; code comments listed there).

**Interfaces:**
- Produces in `wire.ts`: `ThreadItemOutputWindowQuery { offset?: number; maxBytes?: number }`,
  `THREAD_ITEM_OUTPUT_WINDOW_DEFAULT_BYTES = 64 * 1024`, `THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES = 1024 * 1024`,
  `ThreadItemOutputWindowResponse { toolUseId; offset; text; totalBytes; nextOffset?; complete; truncated }`, and
  `isThreadItemOutputWindow(body)` (no Node APIs). `ThreadItemOutputResponse` is unchanged.
- Produces on the host store/orchestrator: `readToolOutputWindow(threadId, itemId, window)`.

**Design (decided):** report D §3 and §2.4-2.5, with these rulings:
- Same route, additive: `GET …/items/:itemId/output?offset=&maxBytes=` is windowed iff either parameter is present;
  without both it answers today's whole join on today's code path, unchanged. A malformed `offset` is 400
  `INVALID_COMMAND`; `maxBytes` is clamped to `[1, THREAD_ITEM_OUTPUT_WINDOW_MAX_BYTES]`, defaulted when absent or
  unparseable; an offset past the end answers 200 with `offset = totalBytes`, empty text, no `nextOffset`. A window
  never splits a code point and holds at least one character.
- The host store keeps a bounded in-memory cache: joins keyed by `(threadId, toolUseId)` and item cursors keyed by
  `(threadId, itemId)`, each extended by reading only the committed log tail past its cursor, with readLog's decode
  rules, a continuity check (a mismatch rebuilds cold), per-key serialisation plus a `seq` guard, and `deleteThread`
  dropping the thread's entries (a per-thread generation guards in-flight scans). Budget: **32 MiB** of join buffers,
  **1 024** item cursors, entries idle for **10 minutes** expire when next touched (no timers); LRU eviction; an
  evicted entry rebuilds cold. Cold builds stream the log (no whole-file string).
- `readItem` for an activity is served through the item cursor (the committed tail plus one `pread` of the item's
  line, checked by `seq` and id; any mismatch falls back to today's whole-log path); a message keeps today's path.
- The daemon proxy forwards `offset`/`maxBytes` (string values only). The MCP asks for one window
  (`offset` clamped to 8 MiB + 1), accepts the windowed shape, windows a legacy whole-join body locally exactly as
  today (an older host that has the route but ignores the query), keeps the route-miss fallback (a host from before
  the route), and gives the calling agent byte-identical pages. Sanity checks on a window's bounds → `INTERNAL`.

**Tests (write first; report D §5.1-5.6):**
- [ ] `tool-output.test.ts`: the incremental join equals `joinToolOutput` at every split point (port the prototype's
  generator: interleaved calls, 1-4 byte characters, lone surrogates and a pair split across chunks, `""` and
  non-string deltas, `thread.reverted`, the cap crossed mid-chunk, an item re-pointed at another call or reused as a
  message id, an unknown item); a cold build decides the call from the newest write; `utf8Window` rules; the real
  store pages to the byte, continues across appends, reads only the tail on a warm page (a test seam), ignores a
  revert, drops on delete, never shows a torn fragment, evicts LRU under a small budget, builds once under concurrent
  windows; `readItem` answers the newest write through the cursor.
- [ ] `http-server.test.ts`, `proxy-routes.test.ts`, `contracts.test.ts`: the window query, the legacy body without
  it, the parameter rules, 404s, forwarding.
- [ ] `output.test.ts` / `output.integration.test.ts`: one window is asked for; a windowing host and a legacy host give
  the same pages byte for byte; a running shell grows between pages; `totalBytes: 0` falls through to the payload; the
  past-the-end error; insane windows are `INTERNAL`; the route-miss fallback still holds.
- [ ] Commit.

### Task 7: the composer — one send per thread across remounts; restored drafts keep every file

**Evidence:** `/tmp/fix7/E-composer-send-and-draft.md` (reproductions with the real `ChatComposer` in a throwaway jsdom
harness under `/tmp/fix7/scratch-E/` — usable to verify, never committed; the validated prototype
`/tmp/fix7/scratch-E/prototype.diff`).

**Files:**
- Create: `packages/ui/src/components/agent-chat/composer/composer-sends.ts` (+ `composer-sends.test.ts`),
  `composer/use-composer-sending.ts`, `composer/composer-send-render.check.ts`
- Modify: `ChatComposer.tsx`, `RewindControl.tsx`, `AgentChatView.tsx`, `packages/ui/src/lib/agent-chat/account-switch.ts`
  (+ test), `packages/ui/src/lib/agent-chat/store.ts` (+ tests), `composer-submission.ts` (+ test),
  `composer-draft.ts` (+ test), `composer-failed-send.ts` (+ test), `composer-bridge.ts`, the transport if the timeout
  needs a signal parameter
- Docs: GUI spec §7.4 `*Built:*` note (the send registry, the over-cap block, restores keep every file); the stale
  comments listed in report E §4.

**Interfaces:** Produces `beginComposerSend(sessionId): () => void`, `isComposerSending(sessionId): boolean`,
`subscribeComposerSends(listener): () => void`, `resetComposerSends(): void` (test seam) in `composer-sends.ts`;
`useComposerSending(sessionId): boolean` in `use-composer-sending.ts`; `attachmentCountBlockSend(attachments):
string | null` in `composer-submission.ts`.

**Design (decided):** report E §2 and §3.5, with these rulings:
- **The send registry** is module-level (it must outlive a thread-store generation, which is torn down 2 s after the
  tab unmounts while the POST keeps running): one token per send, keyed by the thread the send left FROM; `settle`
  closes only its own token, idempotently; `useSyncExternalStore` for readers. `ChatComposer` reads it instead of its
  `sending` state (the edits in report E §2.3; `submit` checks the live registry; the swap branch no longer resets
  anything); the failed-send restore still runs before `settle`.
- **Readers that must agree:** the send button and Enter, the rewind picker (`rewindPickerEnabled` gains `isSending`),
  `AgentChatView`'s `revertBusy`/`rewindAvailable` (row "Rewind to here" and Esc Esc), and the account chip
  (`canSwitchChatAccount` gains the same input). No extra notice on remount: the button's "Sending" spinner says it.
- **Retries:** a `turn` or `answer` command keeps retrying with the same `commandId` after its store generation was
  destroyed (receipts make it free); every command attempt gets a client timeout of **25 s** (a timed-out attempt is a
  retryable status-0 error), so no send can hold its thread "Sending" forever.
- **The cap:** a file coming back — a failed send, a returned queued message, a Stop drain, a rewind, a persisted draft
  — is never refused for the count and never dropped: `decideStagedAttachmentForRef` gains `enforceCount?: boolean`,
  `loadComposerDraft` stops truncating, and a draft over `MAX_TURN_ATTACHMENTS` blocks the send with the reason
  "A message can carry 8 attachments — remove N before sending." (`attachmentCountBlockSend`, part of
  `sendDisabledReason`; queueing is blocked too). New picks are still refused at 8. The live, bridge and persisted
  restores show that reason; the next mount of an over-cap draft shows it.
- **`appendToDraft`** (queue return, Stop drain, rewind, `sendQueuedNow` guard) shares one "merge a message into a
  draft" helper with `draftAfterSend`'s placeholder renumbering (so a returned message's `[Image #N]` never names the
  composer's own image); with a composer mounted each ref is staged as returning, and a ref it still refuses (a
  non-count bound) is written into the draft as its path through `insertComposerText` +
  `composerTextForDelivery`, never parked behind the composer.
- **Adjacent bugs fixed here:** a queued send that fails after its generation was destroyed goes back to the thread's
  live generation (front, held) or, with none, to the persisted draft — never lost; `respondingRequestIds` never
  carries a request into a generation that did not start it (a settled answer can never leave a card locked).
- Comment nits: `composer-failed-send.ts:6-9` and `composer-submission.ts:556-559` say the thread swap is defensive
  only (report E §4 wording), and the other stale comments in report E §4.3.

**Tests (write first; report E §5):**
- [ ] `composer-sends.test.ts` (4 tests in report E §5.1); `composer-send-render.check.ts` (a fresh composer for A
  renders "Sending" while A's send is open, B renders "Send message", the rewind button is disabled while sending).
- [ ] `store.test.ts`: a `turn` whose generation was destroyed mid-retry retries with the same `commandId`; an attempt
  that never answers times out and is retried; a queued send failing after teardown is held in the live generation,
  or in the persisted draft with none; an answer in flight across a teardown never locks the next generation's card;
  a Stop returning two full queued messages with no composer keeps all sixteen; with a composer mounted every returned
  file is staged as returning and nothing is parked.
- [ ] `composer-submission.test.ts`, `composer-draft.test.ts`, `composer-failed-send.test.ts`,
  `account-switch.test.ts`: `attachmentCountBlockSend`; `enforceCount: false`; the persisted restore of 8 + 8 loads 16
  and blocks the send; the chip is withheld while sending. Replace the test that pinned the silent truncation
  (`composer-draft.test.ts` ~105-117).
- [ ] Verify the two HEAD reproductions flip (`repro-duplicate.mts`, `repro-cap.mts` in `/tmp/fix7/scratch-E/`, run
  against your worktree as the report describes) and say so in the report.
- [ ] Commit.

### Task 8: a stuck streaming flag reads as settled

*(Added after Task 4's review.)* A message can keep `streaming: true` in the log forever: turnless subagent messages
before Task 2 (5 479 in one live thread), and any message a dead host left mid-stream. Settling them in the log breaks
history paging (Task 4's review), so every reader decides instead.

**Files:**
- Create: `packages/api/src/agent-chat/message-liveness.ts` (+ test), exported from `@orquester/api/agent-chat`
- Modify: every reader of a message's `streaming` flag that renders or reports liveness — the GUI's timeline, drill-in
  and history derivations and message rows (the "Thinking" shimmer, the live cursor, a turn fold kept open), and the
  MCP transcript if it reports streaming (+ their tests)
- Docs: `AGENTS.md` (the gotcha on a running state and a dead host), a `*Built:*` note in the GUI spec.

**Interfaces:** Produces `messageStreamingContext(state)` → `{ sessionLive, activeTurnId, activeAgentIds }` and
`isMessageStreaming(message, context): boolean`.

**Design (decided):**
- A message reads as streaming iff its flag says so AND the session is live (the notion the roster fold's
  session-death pass uses) AND either its `turnId` is the thread's running turn or its owner (`agentId`) is an agent the
  roster shows active (running, pending or waiting). Otherwise it reads as settled.
- Pure and read-side: no fold change (`FOLD_SNAPSHOT_VERSION` unchanged), no index change, no log write.
- Every GUI and MCP reader that shows liveness goes through it; the fold keeps the flag as the log wrote it.

**Tests (write first):**
- [ ] `message-liveness.test.ts`: a turnless agent message whose agent completed reads settled, one whose agent runs
  reads streaming; a parent message of a completed turn reads settled, of the running turn streaming; nothing reads
  streaming while the session is not live.
- [ ] GUI: a drill-in over an old log with a stuck turnless agent message shows no "Thinking" shimmer and keeps no fold
  open; a live one still streams.
- [ ] MCP (if it reports streaming): the same.
- [ ] Commit.
