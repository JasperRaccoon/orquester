# Agent goals — implementation plan

Spec (binding): `docs/superpowers/specs/2026-09-24-agent-goals-design.md` ("the goals spec").
Background: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` ("the chat spec") and
`AGENTS.md` (the agent-chat gotchas are required reading for any task under `agent-host/`).

Order: Task 1 alone first. Tasks 2–6 then run IN PARALLEL in the same working tree — each owns a
disjoint set of files. Task 7 last.

## Global Constraints

- **File ownership is exclusive.** Edit only the files your task lists (plus new files inside the
  directories it owns). Another agent is editing the other areas at the same time. If you need a
  change outside your list, do not make it: say so in your report (status DONE_WITH_CONCERNS or
  NEEDS_CONTEXT) with the exact change you need.
- **Never start, stop or restart the Orquester daemon or agent host**, never bind 127.0.0.1:47831
  or any `daemon.sock`/`agent-host.sock`, never `systemctl`. Never run a provider CLI (claude,
  codex, grok, opencode) in a way that calls a model. Verify with tests and typecheck only.
- **Do not commit** and do not create branches. Leave changes in the working tree.
- **Contracts are the goals spec §4, verbatim**: names, field names, literal values, file
  locations. Do not rename or reshape them.
- **Persisted/wire shapes are additive only** (chat spec §8 rollback boundary): new optional
  fields, never required ones, never a repurposed name. Anything read from the wire or disk is
  validated field-wise with a fallback — raw JSON never reaches typed code.
- **No silent drops, exhaustiveness preserved**: every `switch` that uses `satisfies never` /
  `const x: never` stays exhaustive; an unknown provider message still becomes a
  `runtime.warning`, except the ones the goals spec now maps.
- **No lazy dynamic `import()` anywhere under `apps/daemon/src/agent-host/`.**
- **Style**: match the surrounding code — comment density and tone, naming, module layout. Cite
  the goals spec as `(goals §N)` where the existing code cites the chat spec. No T3 citations for
  goal code (T3 has none) unless you cite a closed T3 PR finding the spec names.
- **Tests**: `node:test`, run from the package directory, e.g.
  `cd apps/daemon && node --import tsx --test src/agent-host/adapters/claude/goal.test.ts`
  (UI: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test <file>`).
  Typecheck with `pnpm --filter @orquester/<api|daemon|ui> typecheck`. While other tasks are in
  flight, typecheck errors in files you do not own are not yours: list them in the report, do not
  fix them. Write tests first where practical (TDD) and show RED/GREEN evidence in the report.
- Serena's symbol tools may return nothing for this repo's TypeScript; use the built-in
  Read/Grep/Edit tools then. `grep` here is ugrep (it rejects long `.{0,N}` spans).
- Real provider evidence (read-only; never modify): Claude transcript
  `/var/lib/orquester/.claude/projects/-var-lib-orquester-workspaces-jaspersito-MatsSmile/08f59265-4b3e-4a3f-9864-7f582e330b2e.jsonl`
  (rows ~452-455 and 2013-2014/2057-2058); Grok goal session
  `/var/lib/orquester/.grok/sessions/%2Fvar%2Flib%2Forquester%2Fworkspaces%2Fjaspersito%2FMatsSmile2/01a05780-1220-7ee0-863c-3eed47284f9e/`
  (`updates.jsonl`, `goal/state.json`); Codex sources `/var/lib/orquester/tmp/openai-codex-0.155.1/codex-rs`
  and schemas `/var/lib/orquester/tmp/codex-goal-schema/`. Raw logs under
  `/var/lib/orquester/daemon/agent/threads/` contain secrets: print only types and goal fields.

## Task 1: Foundation contracts, fold, ingestion

Goals spec §4 (all of it) and §9. Owns:

- `packages/api/src/agent-chat/goal.ts` (new) and `goal.test.ts` (new)
- `packages/api/src/agent-chat/{runtime-events,thread,adapter-types,fold,fold-snapshot,slim,wire,index}.ts`
  and their existing tests (add `fold.goal.test.ts` for the fold rules)
- `packages/api/src/index.ts` (`SessionSummary.goal` in the agent-chat block, re-exports)
- `apps/daemon/src/agent-host/adapter.ts` (§4.6 types, `goalCommand?`, `StartSessionInput.knownGoal/carryGoal`)
- `apps/daemon/src/agent-host/ingestion/activities.ts` (+ its test) — §4.3 mapping
- `packages/ui/src/lib/agent-chat/reducer.logic.ts` — ONLY `foldStateFromSnapshot` adopting
  `snapshot.goal ?? null` (+ a test)
- Any other file where adding `"thread.goal.updated"` to the `RuntimeEvent` union breaks an
  exhaustive switch: add the minimal case there (no behaviour — e.g. "handled by ingestion"
  comment) so all three packages typecheck. Name each such file in the report.

Requirements:
1. Implement §4.1–§4.5 and §4.7's type (`AgentChatGoalSummary`, `AgentChatSessionSummaryFields.goal`,
   `SessionSummary.goal`) exactly. Helpers of §4.1 in `goal.ts`, fully unit-tested (valid, missing,
   wrong-typed, negative/NaN numbers, unknown keys dropped, unknown status/change rejected).
2. Ingestion (§4.3): one `goal.updated` activity per runtime event, summary text per the table,
   objective truncation to 200 chars with `…`, tone `error` only for `failed`, payload verbatim.
   A historical-source goal event (`HISTORICAL_RAW_SOURCE`) produces nothing.
3. Slim allow-list keeps `goal`, `change`, `previous` (§4.3) — test through `slimActivityPayload`.
4. Fold (§4.4): `goal` field, derivation, unparseable rows ignored for state, untouched by
   retention and `thread.reverted`, snapshot field, serialize/deserialize, `FOLD_SNAPSHOT_VERSION`
   3. Determinism: extend the existing determinism suites (or add one) so a log with goal rows folds
   to the same `goal` from any snapshot split.
5. `pnpm --filter @orquester/api typecheck`, `pnpm --filter @orquester/daemon typecheck` and
   `pnpm --filter @orquester/ui typecheck` all clean; `packages/api` tests all pass; the daemon's
   ingestion tests pass.

## Task 2: Claude adapter

Goals spec §3.1, §6 (preamble) and §6.1. Owns `apps/daemon/src/agent-host/adapters/claude/**`
(new modules allowed, e.g. `goal.ts` for parsing/transcript reading) and
`apps/daemon/test/fixtures/claude/README.md` (add an observation describing the goal frames).

Requirements: every numbered item of §6.1, the §6 preamble (last-emitted goal per session seeded
from `StartSessionInput.knownGoal`, `sameGoalState` suppression, 30 s progress throttle), the
capability of §4.5. Tests: each `/goal` output text (set, replace, bare with/without rounds and last
check, clear, no goal, both refusals, unrelated local command), synthetic text emitted before any
`result`, Stop-hook feedback (matching and non-matching condition, truncated condition prefix),
check-in, `active_goal` value and null, the transcript reader (incremental offsets, met, failed,
sentinel, restore rule, missing file), background-work `waiting-background` phase. Existing Claude
tests must keep passing — update expectations only where the fix legitimately changes timing, and
say which in the report.

## Task 3: Codex adapter

Goals spec §3.2, §6 (preamble) and §6.2. Owns `apps/daemon/src/agent-host/adapters/codex/**`
except `_generated/`, and `apps/daemon/test/fixtures/codex/README.md`.

Requirements: every numbered item of §6.2 and the capability of §4.5, including `goalCommand`
(§4.6) with deadlines, the pause-before-interrupt order, the resume snapshot comparison against
`knownGoal` and the `carryGoal` re-create, stale-`get` discard, progress throttle. Tests against
the existing mock app-server (`testing.ts`): mapping of every status, change classification,
cleared-with/without tracked goal, each `goalCommand` kind incl. replace (get → clear → set) and a
protocol error, interrupt sends `thread/goal/set {status:"paused"}` before `turn/interrupt` and
still interrupts when the pause times out or fails, resume equal/different/none/carry.

## Task 4: Grok adapter

Goals spec §3.3, §6 (preamble) and §6.3. Owns `apps/daemon/src/agent-host/adapters/grok/**` and
`apps/daemon/test/fixtures/grok/README.md`.

Requirements: every numbered item of §6.3 and the capability of §4.5. Model test frames on the real
`goal_updated` rows in the Grok goal session named in the Global Constraints (copy the shape, invent
the text). Tests: both method names, dedupe, every status and `last_event` mapping, replayed rows
emit nothing live and the post-load comparison emits at most one update, the goal `<system-reminder>`
user block projects as `/goal <objective>`, no `runtime.warning` for `goal_updated`.

## Task 5: Host orchestration, watchdog, summaries

Goals spec §4.7 (host/daemon parts), §5 (all), §7 items 5–6. Owns
`apps/daemon/src/agent-host/orchestration/**` (incl. `slash.ts`, `orchestrator.ts`,
`turn-watchdog.ts`, `provider-snapshots.ts`), `apps/daemon/src/agent-host/support/deadline.ts`,
`apps/daemon/src/agent-host/server/**`, and `apps/daemon/src/agent-chat/**`.

Requirements: `parseHostGoalCommand` + `decideGoalCommand` exactly per §5.1 (no pending turn row;
status/failed rows); watchdog `goalMs` + `isGoalActive` (§5.2); `knownGoal`/`carryGoal` on every
`startSession` (§5.3; find where the account-switch restart reason is known); provider-snapshot
capability overlay (§5.4); host `summary()` `goal` with `continuing` (§4.7); daemon `summary.ts`
field-wise parse, `chat-sessions.ts` `applyFields` + `sameDerivedFields`, activity ladder
`continuing` rule. Tests: parser table (every subcommand, case, `edit` without objective, 4000/4001
chars, attachments, `/goals` not matched, non-Codex adapter untouched), `decideGoalCommand` with a
fake adapter (message only, no turn-start row; status row; failure row; refused before commit),
watchdog window with/without goal, knownGoal/carryGoal plumbing, overlay of a cached row, summary
and ladder behaviour.

## Task 6: UI

Goals spec §8 (all). Owns `packages/ui/src/**` EXCEPT `reducer.logic.ts`'s
`foldStateFromSnapshot` (Task 1).

Requirements: store/hook exposure of `goal`; `sanitizeProviderSnapshot` validating
`capabilities.goals`; `status/goal-chip.ts` (pure, tested) + `status/GoalChip.tsx` + the popover
with the §8.2 action matrix, wired so an action submits through the composer's own send path;
`ChatStatusLine` slot; `SessionStatusDot` `goal` prop + every caller that passes
`backgroundLiveness`; timeline marker rows for `goal.updated` (hidden `progress`), generic rows for
`goal.status`/`goal.command.failed`; composer menu `goal` host command for `command: "host"`.
Follow the existing patterns (`ContextMeter` popover, compaction marker row, `*.check.ts` render
checks). Tests: chip model table, action matrix per adapter × status × running/idle × liveness,
sanitising, timeline entries, menu entry, a render check for the chip and the dot.

## Task 7: Documentation

Goals spec as a whole. Owns `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` and
`AGENTS.md`.

Requirements: in the chat spec, update §4.6.6's `/goal` row (Claude F + tracked, Codex H →
`thread/goal/*`, OpenCode F\* untracked, Grok F + tracked) and add a *Built:* line under "Neither
`/goal` nor `/loop` is a host command" pointing to the goals spec; add an AGENTS.md agent-chat
gotcha "Goals are provider-owned …" covering: the `goal.updated` activity → fold `goal` field
(FOLD_SNAPSHOT_VERSION 3), Claude's met/failed only in the transcript and its background-work
deferral, Codex pause-before-interrupt / host `/goal` / per-`CODEX_HOME` goals, Grok's in-turn goal
and the 60-minute goal watchdog window, OpenCode has none; and a "Where to look first" row.
