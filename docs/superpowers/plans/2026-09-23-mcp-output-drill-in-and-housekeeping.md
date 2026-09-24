# Full tool output in the MCP, drill-in honesty, and four follow-ups

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task runs in its own git
> worktree on its own branch; the controller reviews and merges. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the follow-ups the owner asked for on 2026-09-23 after the MCP history/search parity work:
1. the MCP reads a tool's FULL output, as the GUI's "Load full output" does (the transcript only carries the one-line
   preview the read path keeps);
2. a subagent drill-in with no thread index, or after paging, names the turns whose agent rows were lost even when the
   parent's rows survive;
3. an agent with no row left gets a span bounded by its own lifetime, not by the oldest row any agent kept;
4. the fold keeps the legacy compaction marker (`thread.state.changed {state:"compacted"}`) out of eviction, as it
   keeps `context-compaction`;
5. the `ExperimentalWarning` MockTimers prints stops soiling the test output;
6. a failed GUI send restores its draft to the thread it was sent from, even after a tab switch or an unmount.

**Authorities:** `AGENTS.md` ("Agent chat GUI", "Orquester MCP"); the MCP v2 spec
`docs/superpowers/specs/2026-09-22-orquester-mcp-v2-design.md` (§7 tool table, §7.6 transcript) and the user guide
`docs/orquester-mcp.md`; the GUI spec `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` (§5.1 retention,
§5.6 slimming and `GET …/items/:itemId`, §7.4 composer); the fold design
`docs/superpowers/specs/2026-09-23-fold-performance-design.md`.

## Design (decided — implement exactly this)

1. **`read_tool_output`** (Task 1).
   - `read_transcript`'s tool entries gain `outputItemId?: string`: the id of the latest activity of that tool whose
     payload the read path cut (`payload.truncated === true`, the slimmer's promise — `packages/api/src/agent-chat/slim.ts`);
     absent when nothing was cut. It is exactly the row the GUI's "Load full output" button reads
     (`ActivityRows.tsx`, `entry.truncated` → `onLoadFullOutput(entry.id)`).
   - New tool `read_tool_output` (`apps/daemon/src/mcp/tools/output.ts`, registered right after the message tools;
     the tool count becomes 31): input `{ sessionId, itemId, offset? = 0, maxBytes? = 40_000 (1..55_000) }`. It reads
     `GET agentChatRoutes.item(sessionId, itemId)` through `DaemonApi` (the unslimmed item, §5.6) and answers
     `{ itemId, kind, text, offset, totalBytes, nextOffset? }`:
     - `kind: "command-output"` — for an activity whose `payload.itemType === "command_execution"` with output: the
       command's whole output from the unslimmed payload, found through the SAME candidate order the shared preview
       uses (one exported function in `packages/api/src/agent-chat/command-output.ts`, e.g. `commandOutputText(data)`,
       which `commandOutputPreview` then builds on — never a second copy of the candidate list), without the
       preview's trimming of the inside;
     - else `kind: "message"` (a message's text) or `"payload"` (a string payload as it is, else the payload as
       `JSON.stringify(payload, null, 2)`, else the row's summary) — the GUI viewer's `fullOutputText`
       (`AgentChatView.tsx`).
     - `offset`/`nextOffset`/`totalBytes` are UTF-8 byte offsets into that text; a window never splits a code point;
       `nextOffset` is present only when more remains; an `offset` past the end is `INVALID_ARGUMENT` naming
       `totalBytes`. The result stays under `MAX_RESULT_BYTES`.
     - A 404 from the item route (the host answers `THREAD_NOT_FOUND` "No item '<id>'.") is `NOT_FOUND` with a message
       saying the item is gone or never existed and that item ids come from `read_transcript` (`outputItemId`); any
       other failure goes through `daemonError`.
   - Docs: the guide (tool count 31, the tool list, a section with an example, `outputItemId` under read_transcript),
     the MCP v2 spec (§7 table row "added after v2 shipped", §7.6 note on `outputItemId`), `AGENTS.md` (29/30 → 31).
     `SERVER_INSTRUCTIONS` may gain one short clause and must stay ≤ 2 KB; every description ≤ 400 characters.

2. **Drill-in honesty with no index and after paging** (Task 2, `apps/daemon/src/mcp/history.ts`).
   - `indexed === false` with `agentId`: name the agent span — the rule `behindIndex` already applies to a drill-in
     (from the agent's launch turn to where its rows begin to be whole) — instead of `missingTurns`, which reads any
     row, a parent's included.
   - An EMPTY page (no items) with a null `beforeCursor`, while turn `start` is not yet whole, is a failed read
     (`reason: "unavailable"`) for both views — it is what the host answers where it could not plan a block or read
     one back whole — and no longer counts as "the thread's first turn reached".
   - The parent view keeps `missingTurns` as its extra net after a walk; a drill-in skips it (an agent has no row in
     the turns it did not run in, so "no row" says nothing there).
   - `keptWhateverItsAge`: a compaction marker is any `isCompactionActivity` row (`packages/api/src/agent-chat/compaction.ts`),
     the legacy spelling included — Task 4 makes the fold keep it.

3. **An agent with no row left** (Task 2, same file). Its span ends at the turn of its last `task.completed` row when
   its LAST task row (`task.started` / `task.completed` naming it, by `taskId` or stamped `agentId`) is a completion —
   its rows all lie between its launch and its completion — else, as today, at the oldest row any agent kept. An agent
   with rows left is unchanged (its oldest row left, anchors aside).

4. **The fold keeps the legacy compaction marker** (Task 3, `packages/api/src/agent-chat/fold.ts`). The parent
   window's exemption (`isCompactionMarkerRow`) becomes `isCompactionActivity` (the shared rule), so
   `thread.state.changed {state:"compacted"}` is kept whatever its age, as `context-compaction` is.
   `FOLD_SNAPSHOT_VERSION` goes up by one so a `state.json` folded under the old retention is discarded and re-folded
   from the log (lazily, on each thread's next load). Nothing else about retention changes. Docs: `AGENTS.md` (the
   exemption sentence), the fold-performance spec and the GUI spec's retention note.

5. **Quiet MockTimers** (Task 4). A preload per package — `apps/daemon/test/quiet-mock-timers.mjs`,
   `packages/ui/test/quiet-mock-timers.mjs` — wraps `process.emitWarning` and drops ONLY an `ExperimentalWarning` whose
   message starts with `The MockTimers API`; every other warning still prints. It is added with `--import` to the
   `test` scripts of `apps/daemon` and `packages/ui` (the UI's `.check.ts` loop too, for symmetry). `node --test` hands
   its `--import` flags to the child processes it spawns — verify the warning is gone from BOTH full runs and that
   another `ExperimentalWarning` still prints.

6. **A failed send restores to its own thread** (Task 5, `packages/ui/src/components/agent-chat/composer/`). When a
   send fails and `draftAfterSend` returns a draft to restore, the restore goes to the thread the message was sent
   FROM: while the composer is still mounted and still shows that thread, into its live draft as today; otherwise
   (a tab or project switch unmounted it, or it now shows another thread) into that thread's persisted draft in the
   thread store — the same `draftAfterSend` merged over the persisted draft (loaded as the composer loads it,
   `loadComposerDraft`), written back through that thread's own draft actions (`saveDraft`) — so the text and chips
   are never lost and never land in another thread. Docs: a Built note in GUI spec §7.4.

7. **Streamed output** (Task 6, added after Task 1's review). A Claude background shell's output — tailed from the
   CLI's file, at most 1 MiB plus a notice — and a running command's output so far exist ONLY as `tool.output`
   chunks (`payload.delta`), which the GUI joins onto the row (`joinLifecycleDetails`, `row-chrome.ts`). The snapshot
   cannot give them back whole (per-agent windows evict chunks, each chunk is capped on the wire, history pages are
   slimmed), so the host serves them:
   - Host: `readToolOutput(threadId, itemId)` next to `readItem`, in the same single log pass: resolve the item's
     `payload.toolUseId`, join the `payload.delta` of every `tool.output` row with that `toolUseId` verbatim in log
     order, and report `complete` (a `tool.completed` exists for the call). A hard cap (8 MiB) with an in-band
     `truncated`. Route: host `GET /threads/:id/items/:itemId/output`, proxied by the daemon as
     `GET /api/sessions/:id/items/:itemId/output` (`agentChatRoutes` / `agentHostRoutes` entries next to `item`), with
     a not-found code of its own — an older host answers the route miss as `404 THREAD_NOT_FOUND "No route for GET …"`,
     the same code as "No item", so the new route must not reuse it.
   - Transcript: record the `toolUseId` of each in-scope `tool.output` row before it is skipped; a tool entry with
     chunks but no cut completion gets `outputItemId` = its latest lifecycle row (a shell's completion, a running
     call's latest update or start).
   - `read_tool_output` precedence: (1) the item's own unslimmed data through `commandOutputText`, unless the item is
     stored slimmed (`payload.truncated === true`); (2) else, for a tool row with a `toolUseId`, the joined chunks from
     the new route as `command-output`, with `running: true` when the call is not complete and `truncated: true` when
     the host's cap cut it; (3) else `payload`. On a route miss (an older host, until its drain-restart) step 2 is
     skipped, never an error.
   - Folded in from Task 1's review: the whole output is "the first place, in the preview's reading order, that holds
     output in the unslimmed item" (not "always the text the preview was cut from" — command-output.ts, spec, guide);
     the docs name what streamed output is and how it is read; the `tool.denied` half of the `outputItemId` rule is
     forward-compatible (say so in the comment); `AGENTS.md` wraps near 100 columns.

## Global Constraints

- **Never launch, restart or stop the daemon or the agent host**; verify with `pnpm check` and the package tests of
  every package you touch (`pnpm --filter @orquester/daemon test`, `pnpm --filter @orquester/api test`,
  `pnpm --filter @orquester/ui test`).
- **Absolute paths only** in shell commands; your worktree is not the main checkout.
- MCP invariants (AGENTS.md "Orquester MCP"): tools reach the daemon only through `DaemonApi`; every result ≤ 60 000
  bytes and self-bounded; errors `<CODE>: <message>`; strict arguments; `apps/daemon/src/mcp/testing.ts` is not
  edited (tests register routes with `FakeDaemonApi.on`).
- `@orquester/api` is shared with the browser: no Node APIs. No lazy `import()` under `apps/daemon/src/agent-host/`.
- Tests are `node:test` files under `src/`; nothing waits on a sleep. Test output must be pristine.
- Docs are part of each task. Commit on your task branch with a descriptive message; do not merge, push or create
  other branches. Subagents never run on Sonnet or Haiku, and an implementer never spawns subagents.

## Task ordering

All five tasks run in parallel worktrees from main: they touch disjoint code (Task 1: mcp tools/output + transcript;
Task 2: mcp history; Task 3: api fold; Task 4: test scripts; Task 5: ui composer/store). Shared docs
(`docs/orquester-mcp.md`, the MCP spec, `AGENTS.md`) are merged by hand if git cannot.

---

### Task 1: `read_tool_output` — a tool's whole output, as "Load full output" reads it

**Files:** create `apps/daemon/src/mcp/tools/output.ts` (+ `output.test.ts`); modify `apps/daemon/src/mcp/transcript.ts`
(`outputItemId` on tool entries) + `transcript.test.ts`; `packages/api/src/agent-chat/command-output.ts` (+ test)
for the shared full-output extractor; `apps/daemon/src/mcp/server.ts` + `server.test.ts` (31 tools); docs per Design 1.

**Requirements:** Design 1. Tests: `outputItemId` present on a cut tool row (the latest cut activity) and absent
otherwise; the tool answers `command-output` for a Codex `item.aggregatedOutput`, a Grok `rawOutput` (stdout then
stderr) and ACP `content` blocks, `message` for a message, `payload` (pretty JSON / string) otherwise; byte windows
never split a code point, chain through `nextOffset` to the end, and an offset past the end is refused; a 404 maps to
`NOT_FOUND`; the result ≤ `MAX_RESULT_BYTES`; tools/list has 31 tools; the UI's existing command-output tests still
pass unchanged.

### Task 2: drill-in honesty with no index and after paging; spans of agents with no row left

**Files:** `apps/daemon/src/mcp/history.ts` + `history.test.ts` (+ an end-to-end case in `tools/messages.test.ts` if
useful); docs: `docs/orquester-mcp.md` (the unavailable-turns section), MCP v2 spec §7.6.

**Requirements:** Designs 2 and 3. Tests in the SERVED shape (tool.started + tool.completed per call, fewer than 200
rows, launch anchors): no-index drill-in names the agent span where the old rule named nothing; an empty null-cursor
page is `unavailable` in both views; the parent view's `missingTurns` net still works; a drill-in no longer reads a
parent row as presence; an agent with no row left whose last task row is a completion is bounded by it, one whose last
task row is a (re)launch is bounded by the oldest row any agent kept; a legacy compaction marker is kept whatever its
age in `keptWhateverItsAge`.

### Task 3: the fold keeps the legacy compaction marker

**Files:** `packages/api/src/agent-chat/fold.ts`, the file declaring `FOLD_SNAPSHOT_VERSION`
(`packages/api/src/agent-chat/fold-snapshot.ts`), their tests; docs per Design 4.

**Requirements:** Design 4. Tests: a legacy `thread.state.changed {state:"compacted"}` older than the parent window
survives retention (and a non-marker `thread.state.changed` does not); a `state.json` stamped with the previous
version is discarded (the existing version-mismatch path); the fold determinism and snapshot + tail tests still pass.

### Task 4: quiet MockTimers

**Files:** create `apps/daemon/test/quiet-mock-timers.mjs`, `packages/ui/test/quiet-mock-timers.mjs`; modify the
`test` scripts in `apps/daemon/package.json` and `packages/ui/package.json`.

**Requirements:** Design 5. Evidence: the full daemon and UI runs contain no `ExperimentalWarning` line (grep), all
tests still pass, and a one-off check shows another `ExperimentalWarning` still prints with the preload loaded.

### Task 5: a failed send restores its draft to the thread it was sent from

**Files:** `packages/ui/src/components/agent-chat/composer/ChatComposer.tsx`, `composer-submission.ts` (and/or the
store module that owns persisted drafts), their tests; docs per Design 6.

**Requirements:** Design 6. Tests: the pure decision (which target: live draft vs the thread's persisted draft) and the
store write (the persisted draft of thread A gains the failed text and chips after the composer moved to thread B or
unmounted; thread B's draft is untouched; what A's persisted draft already held stays, behind the restored text, as
`draftAfterSend` orders it).

### Task 6: streamed output — a background shell's and a running command's output, joined by the host

**Files:** host `apps/daemon/src/agent-host/store/index.ts` (next to `readItem`) and/or the orchestrator's item read,
`apps/daemon/src/agent-host/server/http-server.ts` (the route), `apps/daemon/src/agent-host/host-protocol.ts` or wherever
`agentHostRoutes` lives; daemon `apps/daemon/src/agent-chat/proxy-routes.ts`; api `packages/api/src/agent-chat/wire.ts`
(route + response type); MCP `apps/daemon/src/mcp/transcript.ts`, `tools/output.ts`; tests at each layer; docs
(guide, MCP v2 spec, AGENTS.md routes table + the MCP paragraph, GUI spec §6.3 reads if it lists routes).

**Requirements:** Design 7. No lazy `import()` under agent-host. Tests: the host joins a shell's chunks in log order
and reports `complete`; the cap truncates in-band; the route and the proxy pass it through with their own not-found
code; the transcript offers `outputItemId` for a call with chunks and no cut completion; `read_tool_output` returns the
joined chunks as `command-output` (`running` while not complete), prefers the item's own unslimmed output when it has
one, never labels a stored-slimmed update as `command-output`, and falls back without an error on an older host's
route miss.

## Review focus

1. Task 1: the full-output text for a command is the unslimmed output (not the preview), windows are exact and
   UTF-8 safe, and every answer stays ≤ 60 000 bytes.
2. Task 2: no path names fewer turns than before; an empty null-cursor page can no longer end a walk as complete.
3. Task 3: nothing but the legacy marker's exemption changes, and old snapshots are re-folded, never half-trusted.
4. Task 4: only the MockTimers warning is dropped.
5. Task 5: a failed send's text can never be lost or restored into another thread.
