# Orquester MCP — history, search and transcript parity with the merged GUI

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task runs in its own git
> worktree on its own branch; the controller reviews and merges. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The merge of `origin/main` (`ad1060b`) gave the chat GUI three things the Orquester MCP cannot do yet —
load a thread's older history, search every chat, and show command output / failed hooks / Codex commentary the way
the timeline now does — and left one rule ("is this the conversation's settled compaction marker?") decided in three
places that disagree. This plan brings the MCP back to "everything a user can do in the GUI, the MCP can do", and
makes the compaction rule one function.

**Architecture:** Everything reuses what the host already serves. `read_transcript` pages older turns from
`GET /api/sessions/:id/history` (the host's thread index) and merges them under the snapshot's retained window;
a new `search_sessions` tool wraps `GET /api/agent/search`; the transcript's tool rows use one command-output helper
moved from the UI into `@orquester/api`; the compaction rule moves into `@orquester/api` and the UI, the MCP and the
host's indexer all call it.

**Tech stack:** TypeScript 5.8 ESM via tsx, `node --test`, zod v3, `@modelcontextprotocol/sdk` 1.29, better-sqlite3
(the host's index only).

**Authorities (read the parts a task names, nothing more):**
- MCP: `docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md` (§7 tool table, §7.6 transcript) and the user
  guide `docs/orquester-mcp.md`. The v2 contract is "the GUI's behaviour, through the daemon's own routes".
- History / search / index: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` and
  `docs/superpowers/specs/2026-09-23-fold-performance-design.md`; wire types in `packages/api/src/agent-chat/wire.ts`
  (`ThreadHistoryPage`, `ThreadSearchResponse`, `THREAD_HISTORY_MAX_TURNS = 100`, `THREAD_SEARCH_MAX_RESULTS = 50`,
  `THREAD_SEARCH_MAX_QUERY_CHARS = 200`), `ThreadSnapshotPayload.history` / `ThreadHistoryBounds` in
  `packages/api/src/agent-chat/thread.ts`, the cursor in `packages/api/src/agent-chat/history-cursor.ts`.
- GUI behaviour to mirror: `packages/ui/src/lib/agent-chat/entries.logic.ts` (`commandOutputPreview`,
  `repeatsCommandPreview`, `derivedWorkLogEntry`'s `displayDetail`, `deriveWorkLogEntries`' hook rule,
  `isCompactionActivity`, `compactionMarkerState`, `isAgentInternalActivity`), `rows.logic.ts`
  (`isCommentaryAssistantMessage`, `buildRevertTurnCountByUserMessageId`),
  `packages/ui/src/components/command-palette/conversation-search.ts`.

## Design (decided — implement exactly this)

1. **One compaction rule** (Task 1). A row is "the conversation's settled compaction marker" when it is an activity,
   `isCompactionActivity` (a `context-compaction` row, or the legacy `thread.state.changed` with
   `payload.state === "compacted"`), `compactionMarkerState(...) === "compacted"` (anything but `compacting` /
   `compaction-failed` — an unreadable state is settled), and it is NOT owned by a subagent (neither `item.agentId`
   nor `payload.agentId` is a non-blank string — the ownership half of the UI's `isAgentInternalActivity`). The UI's
   window gate already behaves this way (agent-owned rows never reach the parent timeline); the MCP ignored
   `payload.agentId`; the host's indexer indexed only `context-compaction` rows, subagent-owned ones included, and
   never the legacy form. All three now call the shared functions; the index derivation changes, so
   `INDEX_SCHEMA_VERSION` goes 2 → 3 (the index is a disposable cache and is rebuilt from the logs on a version
   mismatch — verify that path, do not add a migration).

2. **`search_sessions`** (Task 2) — the palette's `?` mode. Input `{ query, project?, limit? = 20 }`; `query` is
   trimmed and must be 1..`THREAD_SEARCH_MAX_QUERY_CHARS` code units after trimming (refused otherwise, never
   silently clipped); `project` resolves like `list_sessions`' (`resolveProject`) and becomes `projectPath`; `limit`
   is an int in 1..`THREAD_SEARCH_MAX_RESULTS`. It calls `GET /api/agent/search?q=&limit=&projectPath=` through
   `DaemonApi`, keeps only hits whose `threadId` is a chat session that exists now (`listSessions`), and answers
   `{ query, hits: [{ sessionId, title, projectPath, turn, kind, role?, activityKind?, snippet, at }], truncated,
   indexed, hint? }` — `title` is the session's own (list_sessions') title, `turn` the hit's `ordinal` (null for a
   turnless row), `role` only on a message hit, `activityKind` only on an activity hit, `snippet` keeps the host's
   `«`/`»` match marks. `indexed: false` (no usable index) is a normal answer with no hits and a `hint` saying search
   is unavailable on this host right now. The tool bounds itself under `MAX_RESULT_BYTES` like every MCP tool: title
   and snippet capped (marked with `…`), then lowest-ranked hits dropped from the end, with `truncated: true` and
   `omittedHits: N` when it dropped any. Registered right after the session tools; the tool count becomes **30**.

3. **Older history in `read_transcript`** (Task 3). New optional input `beforeTurn` (int ≥ 2): the `turns` turns
   that come just before that turn number; default = the latest `turns`. `beforeTurn > turnCount + 1` or `< 2` is
   `INVALID_ARGUMENT` naming the valid range. The range is `[start, end]` with `end = (beforeTurn ?? turnCount + 1) −
   1` and `start = max(1, end − turns + 1)`.
   - **When to page:** only when `snap.history?.indexed === true`, `snap.history.hasOlder === true`,
     `oldestRetainedOrdinal !== null` and `start <= oldestRetainedOrdinal` (the window's oldest turn may be partial).
   - **First page:** `GET agentChatRoutes.history(id)` with `turns = min(end − start + 1,
     THREAD_HISTORY_MAX_TURNS)` and, when `end + 1 < oldestRetainedOrdinal`, `before =
     encodeHistoryCursor({ threadId, beforeAnchorAt: T.requestedAt, beforeTurnId: T.turnId })` for `T` = started turn
     `end + 1` (turn records are never evicted, so the snapshot's `turns` has it); otherwise no cursor (the page ends
     at the window's boundary).
   - **Next pages:** follow `page.page.beforeCursor` while it is non-null. Decode it (`decodeHistoryCursor`) to the
     turn `k` it names: stop when turn `start` is whole — `k <= start` without `beforeSeq`, `k < start` with it. At
     most `HISTORY_PAGES_PER_READ = 5` pages per call.
   - **Merge:** items by id, page rows first and the window's copy winning (it is the newer state of the same row);
     then a stable sort by `createdAt`. Checkpoints the same way, keyed by `turnId`. The transcript is built from
     that merged snapshot exactly as today.
   - **Honesty:** the result gains `olderTurns` (started turns before `start` — the caller pages back with
     `beforeTurn: start`) and, only when some turns of the range could not be read whole, `unavailableTurns:
     [from, to]` plus a hint: the index was unavailable (`503 INDEX_UNAVAILABLE`, or `history.indexed === false`
     while turns of the range have no row in the window), or the page limit ran out. A page request that fails for
     any reason is never a tool error — the window's rows are still served. A host that predates `history`
     (no field) behaves like today, plus `olderTurns`.
   - Rows with no turn (a failure before the provider named the turn) belong to the range when their `createdAt` is
     at or after turn `start`'s `requestedAt` (from the very start when `start === 1`) and, when `end < turnCount`,
     before turn `end + 1`'s `requestedAt`.

4. **Transcript details** (Task 4).
   - **Command output:** a command tool row's `detail` is what the GUI's row shows: move `commandOutputPreview`,
     `repeatsCommandPreview` and the `displayDetail` decision out of `entries.logic.ts` into one exported function in
     `@orquester/api` (new `packages/api/src/agent-chat/command-output.ts`, e.g.
     `commandDisplayDetail(payload): string | undefined` — the provider's `detail`, or the output preview when that
     detail is empty, repeats the command or repeats the title, or nothing when it only echoes the command). The UI
     calls it (no behaviour change there); the MCP transcript uses it for `itemType === "command_execution"` rows.
   - **Hooks:** a `hook.completed` row whose `payload.outcome` is not `"success"` becomes a transcript row (the GUI
     keeps it): `kind` `"error"` when its tone is `error`, else `"warning"`, text as the other rows (`rowText`).
     `hook.started`, `hook.progress` and successful completions stay skipped.
   - **Commentary:** an assistant entry whose message has `messageKind === "commentary"` carries `commentary: true`
     (narration, never the turn's answer; `lastReply` already leaves it out).

## Global Constraints

- **Never launch, restart or stop the daemon or the agent host**, never bind `127.0.0.1:47831` or a daemon socket
  (AGENTS.md). Verify with `pnpm check` and the package tests: `pnpm --filter @orquester/daemon test`,
  `pnpm --filter @orquester/api test`, `pnpm --filter @orquester/ui test` for every package you touch.
- **Absolute paths only** in shell commands: your worktree is not the main checkout, and a relative `cd` once wrote
  into main.
- MCP invariants (AGENTS.md "Orquester MCP"): tools reach the daemon only through `DaemonApi` (no services, no host
  client); every result is one JSON object capped at 60 000 bytes and a tool that can outgrow it bounds itself first
  and says what it cut; errors are `<CODE>: <message>`; arguments are parsed strictly (unknown names refused).
- No lazy dynamic `import()` anywhere under `apps/daemon/src/agent-host/`.
- `@orquester/api` is shared with the browser: no Node APIs in it.
- Tests are `node:test` files under `src/` next to the code. Nothing waits on a sleep (wait on events/promises; fake
  clocks where the code takes one).
- Docs are part of the task: `docs/orquester-mcp.md` (user guide), the MCP v2 spec (a `*Built: …*` note or table
  row), `AGENTS.md` where it states a fact the task changes, and the index design spec for Task 1. Keep the house
  style: prose that states the rule and why, no marketing words.
- Commit on your task branch with a descriptive message (`fix(mcp): …`, `feat(mcp): …`); do not merge, do not push,
  do not create other branches. Subagents never run on Sonnet or Haiku, and an implementer never spawns subagents.

## Task ordering and parallelism

- Wave 1, in parallel worktrees: **Task 1**, **Task 2**, **Task 3** (disjoint code; docs merge by hand).
- Wave 2: **Task 4**, from main after Tasks 1 and 3 are merged (it edits `transcript.ts` after Task 3 and
  `entries.logic.ts` / the api index after Task 1).
- Then the final whole-branch review.

---

### Task 1: One compaction-marker rule, shared by the UI, the MCP and the host index

**Files:**
- Create: `packages/api/src/agent-chat/compaction.ts` (+ `compaction.test.ts`); export from
  `packages/api/src/agent-chat/index.ts`.
- Modify: `packages/ui/src/lib/agent-chat/entries.logic.ts` (use/re-export the moved functions; keep every existing
  import site compiling), anything in `packages/ui` importing `CompactionMarkerState` if the type moves.
- Modify: `apps/daemon/src/mcp/tools/sessions.ts` (`isSettledCompaction` → the shared predicate) + its test.
- Modify: `apps/daemon/src/agent-host/index/indexer.ts` (which activities become `markers` rows, and their kind),
  `apps/daemon/src/agent-host/index/schema.ts` (`INDEX_SCHEMA_VERSION` 2 → 3, and the `markers.kind` doc) + tests.
- Docs: `docs/superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md` (a *Built* note: the marker rule is
  the shared one, legacy markers count, subagent markers do not, schema 3), MCP v2 spec (the `revert_session` row's
  Built note names the shared rule), `AGENTS.md` if it states the marker rule.

**Requirements:** Design 1. Exports (names may be adjusted only if a name already exists): `isCompactionActivity`,
`compactionMarkerState`, the `CompactionMarkerState` type, and `isSettledConversationCompaction(item: ThreadItem):
boolean`. The indexer applies the same predicate to the activity it indexes (a marker row exactly for the rows the
parent timeline shows as compaction markers, with `compactionMarkerState` as its kind). Behaviour of the UI does not
change.

**Tests:**
- api: `context-compaction` with no state / `compacted` / `compacting` / `compaction-failed`; legacy
  `thread.state.changed {state:"compacted"}` counts, `{state:"running"}` does not; `agentId` on the item or on the
  payload excludes it; a message is never one.
- indexer/queries: a legacy marker withholds `rewindable` for the turns before it; a subagent-owned marker withholds
  nothing; existing index tests still pass; an index file at schema version 2 is discarded and rebuilt (use the
  existing version-mismatch path and its tests — extend one if none covers 2 → 3).
- MCP: `revert_session` allows a cut across a marker whose `payload.agentId` is set (a subagent's own compaction);
  add that case next to the existing `agentId` case in `sessions.test.ts`.

---

### Task 2: `search_sessions` — full-text search over every chat session

**Files:**
- Create: `apps/daemon/src/mcp/tools/search.ts` (+ `search.test.ts`) exporting `searchTools: ToolDef[]`.
- Modify: `apps/daemon/src/mcp/server.ts` (`allTools()` order: catalog, sessions, **search**, messages, …; the
  comment's count; `SERVER_INSTRUCTIONS` gains one short clause — the whole string must stay ≤ 2 KB), the
  `server.test.ts` expected tool list (30).
- Docs: `docs/orquester-mcp.md` (tool count 29 → 30 wherever stated, the tool list, a section for the tool with an
  example call and answer), the MCP v2 spec §7 table (a new row, marked as added after v2 shipped) and any "29"
  it states, `AGENTS.md` ("29 tools" → 30, and "search" in the list of what the tools cover).

**Requirements:** Design 2. Annotations as the other read tools (`READ_ONLY`, `openWorldHint: false`). The
description tells the caller how to open a hit: `read_transcript { sessionId, beforeTurn: turn + 1, turns: 1 }`
(Task 3 adds `beforeTurn`; the description may name it — the tools ship together). Refusals: blank or over-long
`query` and an unknown `project` are `INVALID_ARGUMENT` / the existing `resolveProject` codes; a non-2xx from the
daemon goes through `daemonError`.

**Tests (FakeDaemonApi):** hits mapped and filtered to existing chat sessions (a terminal tab's id and an unknown id
dropped); `role`/`activityKind` only on their kind; `indexed:false` → no hits + hint; the query/limit/projectPath
reach the route (project resolved to its path); blank and 201-char queries refused; a result over the byte cap is cut
from the end with `truncated` + `omittedHits`, and stays under `MAX_RESULT_BYTES`; tools/list shows 30 tools.

---

### Task 3: `read_transcript` pages older history from the thread index

**Files:**
- Create: `apps/daemon/src/mcp/history.ts` (+ `history.test.ts`) — the I/O half: given the api, the session id, the
  snapshot and `[start, end]`, fetch the pages (Design 3), merge, and report `unavailable`.
- Modify: `apps/daemon/src/mcp/transcript.ts` (`TranscriptOptions.beforeTurn`; the range selection and the turnless
  rows' rule; `TranscriptResult.olderTurns` and `unavailableTurns?`, counted in the byte frame), `tools/messages.ts`
  (`read_transcript`'s input `beforeTurn`, its description, calling `history.ts`, the hint), and tests
  (`transcript.test.ts`, `tools/messages.test.ts`).
- Maybe modify: `apps/daemon/src/mcp/testing.ts` (the fake answers the history route) — keep the fake's existing
  behaviour for every other route.
- Docs: `docs/orquester-mcp.md` (`read_transcript`: `beforeTurn`, `olderTurns`, `unavailableTurns`, how older
  history is read and when it is not available), the MCP v2 spec (§7 `read_transcript` row + a Built note in §7.6),
  `AGENTS.md` (the MCP paragraph: `read_transcript` pages the host's index).

**Requirements:** Design 3, exactly. `HISTORY_PAGES_PER_READ = 5` exported from `history.ts`. The page request goes
through `DaemonApi.request("GET", agentChatRoutes.history(id), { query })`. `transcriptEntries` stays pure.

**Tests:**
- transcript (pure): `beforeTurn` selects the range; `olderTurns`; turnless rows inside/outside the range; a merged
  snapshot's rows sort into log order.
- history.ts with a fake api: no paging when the window covers the range, when `history` is absent, or when
  `hasOlder` is false; a first page with no cursor when the range reaches into the window's oldest turn, and with the
  cursor of turn `end + 1` otherwise (decode it in the test); following `beforeCursor` until the start turn is whole
  (both the `beforeSeq` and the plain case); the 5-page limit → `unavailable`; a 503 → `unavailable` and the window's
  rows still served; window copy wins on a duplicate id.
- read_transcript end to end (FakeDaemonApi): a 3-turn window over a 10-turn thread with `turns: 5` returns turns
  6–10 with rows from a page; `beforeTurn` out of range refused; `olderTurns` and the hint.

---

### Task 4: Transcript details the timeline now shows — command output, failed hooks, commentary

**Files:**
- Create: `packages/api/src/agent-chat/command-output.ts` (+ test); export from the api index.
- Modify: `packages/ui/src/lib/agent-chat/entries.logic.ts` (use the moved function; no UI behaviour change — its
  existing tests must pass unchanged), `apps/daemon/src/mcp/transcript.ts` (tool rows' detail, hook rows,
  `commentary`), `TranscriptEntry` type, tests (`transcript.test.ts`).
- Docs: `docs/orquester-mcp.md` (the entry kinds and fields: command output in `tool.detail`, failed hook rows,
  `commentary: true`), the MCP v2 spec §7.6 (Built note).

**Requirements:** Design 4. The moved function keeps the UI's exact semantics (same candidates, same order, same
echo rule); add api tests that pin them (Codex `item.aggregatedOutput`, Grok `rawOutput.stdout/stderr` and ACP
`content` blocks, the echo-only case, the title-repeat case). In the transcript, a command row's `detail` is updated
from each of its activities with the shared function, never cleared by an echo-only activity.

**Tests:** transcript: a Grok-shaped command whose `detail` repeats the command shows its output; a Codex command
shows `aggregatedOutput`; a failed `hook.completed` (tone error) is an `error` row, a cancelled one a `warning` row, a
successful one no row, `hook.started`/`hook.progress` no row; a commentary message is `assistant` with
`commentary: true`, a final answer has no such field.

---

## Review focus

1. Task 3's merge: a row present in both the page and the window must appear once, with the window's state, in log
   order; the range's first turn must be whole or reported in `unavailableTurns`.
2. Task 3's page loop always terminates (null cursor, the start turn whole, or the page limit) and never throws out
   of `read_transcript` for a page failure.
3. Task 1's schema bump: an existing index is rebuilt, never half-trusted, and nothing else about the index changes.
4. Task 2's filter: a hit whose session is gone or is a terminal tab is never returned.
5. Every result stays ≤ 60 000 bytes whatever the host sends.
