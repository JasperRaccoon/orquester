# Agent goals — a visible, provider-owned goal on every chat that has one

Status: approved by the owner on 2026-09-24 ("build it ourselves … for claude codex grok and
opencode and the fixes"; OpenCode then descoped by the owner: "No goal for OpenCode").

Companion to the agent chat design (`2026-09-21-agent-chat-gui-design.md`, "the chat spec"). Where
this document and the chat spec disagree, this one wins for goals. The chat spec carries a *Built:*
pointer here at these places: §3.1's two watchdog windows; §3.3's reconcile input, its continuation
marker, its per-project opt-in and its lazy recovery; §3.4's compaction queue and its account-switch
gate; §4.1's adapter sketch and its turn-scoped interrupt; §4.5's Codex interrupt order; §4.6's rule
2 (the commands the host takes over); §4.6.3's synthesised entries; §4.6.5(b)'s one host command;
§4.6.6's `/goal` row (through the matrix legend) and its "Neither `/goal` nor `/loop` is a host
command" paragraph; §4.6.7's menu rules; §5.1's `ThreadHead` and its command-to-event mapping;
§6.2's `/interrupt` and its compaction rule; §6.3's thread snapshot and `/stop` route; §6.4's six
derived fields and its ladder; §7.1; §7.2; §7.4's steer-or-queue rule and its account chip; §8's
note on restarts interrupting live work. Where a ruling taken during the build changed a sentence of
this document, the sentence was edited in place and carries "(amended 2026-09-24: …)".

## 1. Problem

Typing `/goal <condition>` in a chat tab starts a provider's autonomous goal — the agent keeps
working until the condition is met — but nothing in the GUI says a goal exists, what it is, or how
far along it is. Worse, three providers already emit goal signals that Orquester mishandles:

- Claude's "Goal set: …" confirmation is held until the turn's `result`, i.e. until the whole goal
  run is over, because a never-streamed (`<synthetic>`) assistant message is only flushed then.
- Grok turns every `goal_updated` update into a `runtime.warning` row.
- Codex drops `thread/goal/*` outright; its Stop button interrupts a turn while the goal stays
  active, so Codex immediately starts another turn; `/goal …` reaches the model as plain text.

T3 Code (`pingdotgg/t3code` main `68fb7f4`, 2026-09-23) has no goal surface at all. Four community
PRs tried (#7320, #7935, #8615, #11516) and all were closed unmerged; open issues #9266 (Claude
goal stalls after the first round) and #13252 (Codex `/goal clear` sent as chat text) are the bugs
this design fixes for Orquester. Nothing here is ported from T3; the closed PRs are cited where a
reviewer's finding shaped a rule.

## 2. Scope

| Provider | Goal source | `/goal` | This design |
|---|---|---|---|
| Claude | CLI (session-scoped Stop hook, evaluated by a small model) | forwarded; the CLI parses it | mirror + fixes |
| Codex | app-server (`thread/goal/*`, server-driven continuation turns) | **parsed by the host**, mapped to `thread/goal/*` | mirror + host command + fixes |
| Grok | CLI (host workflow engine inside one prompt turn) | forwarded; the CLI parses it | mirror + fixes |
| OpenCode | none (upstream merged and reverted a plugin on 2026-09-18) | forwarded only if the user's config advertises one | **nothing** — no chip, no state |

Out of scope: an Orquester-run goal loop for providers without one; editing token budgets from the
UI; Claude's model-proposed goals (`ProposeGoal` is disabled in SDK sessions:
`isEnabled(){if(Te()||Qn())return!1…}`, and absent from every `system/init` `tools` list).

## 3. Provider facts this design rests on

All verified on this host on 2026-09-24 (Claude Code 2.1.280 / SDK 0.3.278, codex-cli 0.155.1 at
tag `rust-v0.155.1`, grok 1.0.34, opencode 1.18.32) by static analysis of the installed binaries
and upstream sources plus read-only inspection of real sessions. No provider was run for this.

### 3.1 Claude (SDK / stream-json)

- `/goal <cond>` registers a **prompt-type** Stop hook (`sessionHooksRegistry.add(…,"Stop","",
  {type:"prompt",prompt:cond})`) that the SDK's query loop DOES run — a small-fast-model evaluator,
  30 s timeout, schema `{ok, reason, impossible?}`. The "not yet supported outside REPL" strings
  belong to a different executor that never runs Stop hooks.
- **The evaluation is deferred whenever background work (a background agent or shell) is running at
  turn end**: the hook is skipped for that pass and the turn ends. In non-interactive sessions the
  idle check-in timer never runs, so the goal is only evaluated again when a later turn ends with
  nothing running in the background (a task-notification turn does that). Observed live on thread
  `6244aa57…`: two turn ends at 23:48Z and 00:13Z, both with subagents running, `stop_hook_summary`
  `hookCount: 2` (only command hooks), no `goal_status`, goal still active.
- Evaluator errors, timeouts and the per-turn block cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`) end the
  turn **silently** in SDK mode — the goal stays active, nothing is emitted.
- An interrupt leaves the goal active and unevaluated.
- **What reaches stdout** (plain SDK; `active_goal` is written ONLY when `CLAUDE_CODE_REMOTE` is
  set — never set it, it flips 183 remote-mode code sites):
  - **set / replace:** a synthetic assistant frame — `message.model: "<synthetic>"`, top-level
    `local_command_run: {command:"goal", args:"<cond>"}`, `local_command_source:
    "<local-command-stdout>Goal set: <cond></local-command-stdout>"`, content
    `[{type:"text",text:"Goal set: <cond>"}]`. A replace prints the identical text. The kickoff
    prompt is not echoed. The model turn follows.
  - **bare `/goal`:** same frame shape, text `` No goal set. Usage: `/goal <condition>` `` or
    ``Goal active: <cond> (not yet evaluated|<n> turn(s))`` optionally followed by
    `\nLast check: <reason>`; then a `result` with `num_turns: 0`.
  - **clear** (whole argument is one of `clear stop off reset none cancel`, any case): text
    `Goal cleared: <cond>` or `No goal set`; then a `result`.
  - **refusals:** `Goal condition is limited to 4000 characters (got <n>)`;
    `/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in
    settings or by policy).` — same frame shape; no goal change.
  - **a "not met" check:** a main-thread `user` frame, `isSynthetic: true`, string content
    `Stop hook feedback:\n[<cond>]: <reason>` (the condition is cut to 500 characters after the
    first time). A turn-end check-in arrives the same way, starting `Goal check-in: «`.
  - **met / impossible / cleared by an unrecoverable error: nothing on stdout.** Only the CLI's
    transcript records it: an `attachment` row `{type:"goal_status", met:true, condition,
    iterations, durationMs, tokens}`, or `{met:false, failed:true, condition, reason, …}`; the
    error path writes a met sentinel (`{met:true, sentinel:true}`, as `/goal clear` does). A set
    writes `{type:"goal_status", met:false, sentinel:true, condition}`. **The row is normally not
    on disk yet when `result` arrives** (amended 2026-09-24): it is queued for the transcript
    store's 100 ms write timer, and an SDK session flushes before `result` only under
    `CLAUDE_CODE_EAGER_FLUSH` / `CLAUDE_CODE_IS_COWORK`, which Orquester never sets — so the
    verdict lands about 100 ms after `result` (§6.1.4).
- **Resume:** `--resume` runs `restoreGoalFromTranscript`: the LAST `goal_status` row decides —
  met or failed ⇒ no goal; otherwise the goal is re-armed with `iterations: 0`, `origin:
  "restored"`. Nothing is emitted. Compaction keeps the goal (a post-compact sentinel is written).
  `/clear` drops it.

### 3.2 Codex (app-server)

- `thread/goal/set {threadId, objective?, status?, tokenBudget?}` → `{goal}` then
  `thread/goal/updated {threadId, turnId:null, goal}`; missing objective/status = keep; a new goal
  defaults to `active`; `tokenBudget`: missing = keep, `null` = clear, else a positive integer.
  Objective is trimmed, 1–4000 characters.
- `thread/goal/get {threadId}` → `{goal: ThreadGoal|null}`; `thread/goal/clear {threadId}` →
  `{cleared}` and `thread/goal/cleared {threadId}` only when `cleared` is true.
- `ThreadGoal = {threadId, objective, status, tokenBudget: number|null, tokensUsed,
  timeUsedSeconds, createdAt, updatedAt}`; `status ∈ active paused blocked usageLimited
  budgetLimited complete`. Errors are JSON-RPC -32600 ("goals feature is disabled", "ephemeral
  thread does not support goals", "no goal exists"). No opt-in; the `goals` feature is stable and
  on by default (fixture `10-probe-no-turn.ndjson:37`).
- **Codex drives continuation itself**: while a goal is `active`, every idle point (turn end,
  right after a `thread/resume`, right after a set that leaves it active) starts a new turn with a
  hidden prompt and no `userMessage` item. The model has `get_goal`, `create_goal
  {objective, token_budget?}` and `update_goal {status: complete|blocked|paused}` on every
  non-ephemeral thread — so a model-created goal can exist on any Codex thread today.
- `turn/interrupt` does NOT pause the goal; the next continuation starts at once (openai/codex
  #28104, fixed in the TUI by pausing first). Pause-then-interrupt is ordered per thread.
- `thread/goal/updated` fires after every set, on tool create/update, on progress flushes after
  each tool call and at turn stop/abort (with `turnId`), and on system status changes. Every
  `thread/resume` sends a snapshot: `updated` if a goal exists, else `cleared` (fixture
  `07-thread-resume-new-process.ndjson:75`).
- Goals persist in `goals_1.sqlite` under the thread's `CODEX_HOME`. Managed account homes share
  only `sessions/`, `config.toml` and `hooks.json`, so **an account switch loses the goal**.
- The TUI grammar: `/goal [<objective>|clear|edit|pause|resume]`, subcommands match the whole
  argument case-insensitively; replacing an unfinished or complete goal is `clear` then `set`.

### 3.3 Grok (ACP)

- Advertised: `{"name":"goal","description":"Set, manage, or check an autonomous goal",
  "input":{"hint":"<objective> [--budget <tokens>] | status | pause | resume | clear"}}`.
- The whole goal runs inside ONE `session/prompt` turn (planner → worker rounds → 1–3 "goal
  achievement skeptic" verifiers → summarizer); it can be silent for 10–20 minutes while
  verifiers run — longer than the 10-minute turn watchdog.
- Structured state: an xAI session update `sessionUpdate: "goal_updated"` (live under the xAI
  notification method, replayed as `_x.ai/session/update` with `isReplay: true` on `session/load`):
  `{goal_id, objective, status, phase, tokens_used, elapsed_ms, total_deliverables,
  completed_deliverables, total_worker_rounds, total_verify_rounds, token_baseline,
  finished_subagent_tokens, last_event, last_event_timestamp, …optional: planning,
  verifying_completion, last_event_detail, classifier_runs_attempted, classifier_max_runs,
  last_classifier_verdict (not_achieved|achieved), token_budget, live_*}`. `last_event ∈
  goal_created planning_completed planning_failed worker_started worker_completed worker_failed
  context_rotated goal_paused goal_resumed goal_completed goal_cleared budget_exceeded
  premature_stop_detected`. Observed statuses `active`, `complete`; the binary also names
  `user_paused back_off_paused no_progress_paused infra_paused blocked budget_limited`. Frames are
  sometimes duplicated.
- No goal RPC: `/goal status|pause|resume|clear` are prompts, queued behind a running goal turn.
- On replay, the goal's user message is a ~6 KB `<system-reminder>` block beginning `A goal has
  been set: …`, not the typed `/goal …`.
- The normaliser today raises `runtime.warning` for every `goal_updated`
  (`adapters/grok/normalize.ts`, `KNOWN_XAI_UPDATES`) — and, a goal run showed, for the run's
  other xAI updates too (amended 2026-09-24: "today" is the design's day; all are mapped now,
  §6.3.1).

## 4. Contracts (`@orquester/api`)

### 4.1 The goal shape — new module `packages/api/src/agent-chat/goal.ts`

```ts
export type AgentGoalStatus =
  | "active" | "paused" | "blocked" | "budget-limited" | "usage-limited" | "complete" | "failed";

/** One provider-native goal, normalised. Everything but objective/status is optional. */
export interface AgentGoal {
  objective: string;
  status: AgentGoalStatus;
  /** The provider's own id when it has one (Grok `goal_id`). */
  goalId?: string;
  /** Free-text provider phase: Grok's planning/executing/verifying/idle; Claude "waiting-background". */
  phase?: string;
  /** Evaluation rounds so far: Claude's "not met" checks, Grok's worker rounds. */
  rounds?: number;
  /** Why the last check said "not met" / the last event's detail. */
  lastCheck?: string;
  tokensUsed?: number;
  tokenBudget?: number | null;
  /** Active wall-clock time in ms. */
  elapsedMs?: number;
  /** When the goal was set (ISO). */
  setAt?: string;
}

export type AgentGoalChange =
  | "set" | "replaced" | "restored" | "progress" | "checked" | "paused" | "resumed"
  | "blocked" | "limited" | "achieved" | "failed" | "cleared";

/** The folded goal: the last `goal.updated` row wins. */
export interface ThreadGoal extends AgentGoal {
  /** When the row that produced this state was written (ISO). */
  updatedAt: string;
}

/** The activity kind every goal row is written under. */
export const GOAL_ACTIVITY_KIND = "goal.updated";
/** A host `/goal` status answer (Codex) — a visible info row. */
export const GOAL_STATUS_ACTIVITY_KIND = "goal.status";
/** A host `/goal` command that failed — a visible error row. */
export const GOAL_COMMAND_FAILED_ACTIVITY_KIND = "goal.command.failed";

/** Payload of a `goal.updated` activity (and of the runtime event). */
export interface GoalUpdatedPayload {
  /** The whole current goal, or null when the thread has none any more. */
  goal: AgentGoal | null;
  change: AgentGoalChange;
  /** The goal as it ended, on achieved/failed/cleared rows whose `goal` is null. */
  previous?: AgentGoal;
}
```

Helpers in the same module, each unit-tested:

- `parseAgentGoal(value: unknown): AgentGoal | null` — field-wise validation (objective a
  non-empty string; status in the enum; numbers finite and ≥ 0; strings non-empty; unknown keys
  dropped). Never throws.
- `parseGoalUpdatedPayload(value: unknown): GoalUpdatedPayload | null` — `goal` must be `null` or
  parse; `change` in the enum; `previous` optional and parsed.
- `goalActivitySummary(payload): string` — the row text (§4.3).
- `isHiddenGoalChange(change): boolean` — true for `progress` only.
- `isUnfinishedGoal(goal): boolean` — `goal !== null && goal.status !== "complete" && goal.status
  !== "failed"`. The chip and the tab marker show exactly the unfinished goals.
- `sameGoalState(a, b)` — objective + status + rounds + phase + lastCheck equal (used by adapters
  to suppress no-op emissions).
- Also exported (amended 2026-09-24, as built): `AGENT_GOAL_STATUSES` / `AGENT_GOAL_CHANGES` (the
  parsers' enums, for field-wise checks elsewhere), `parseThreadGoal` (a goal plus its string
  `updatedAt`) and `GOAL_SUMMARY_TEXT_CHARS = 200`.

### 4.2 Runtime event (adapter → host)

`runtime-events.ts` gains `RuntimeThreadGoalUpdatedEvent = Ev<"thread.goal.updated",
GoalUpdatedPayload>` in the closed union. It is **not** transient (it is written to `raw.ndjson`).
Adapters throttle `change: "progress"` themselves (§6) — ingestion does not coalesce it.

### 4.3 Persisted row — ingestion (`apps/daemon/src/agent-host/ingestion/activities.ts`)

`thread.goal.updated` becomes ONE `thread.activity-appended` with:

- `activityKind: "goal.updated"`, `tone: "error"` for `failed`, else `"info"`;
- `summary: goalActivitySummary(payload)`:
  - `set` → `Goal set: <objective>`; `replaced` → `Goal replaced: <objective>`;
    `restored` → `Goal restored: <objective>`; `progress` → `Goal progress`;
  - `checked` → `Goal check <rounds>: not met` + ` — <lastCheck>` when present;
  - `paused` → `Goal paused`; `resumed` → `Goal resumed`; `blocked` → `Goal blocked` +
    `: <lastCheck>`;
  - `limited` → `Goal stopped: token budget reached` (budget-limited) / `Goal stopped: usage limit
    reached` (usage-limited);
  - `achieved` → `Goal achieved: <objective>`; `failed` → `Goal can't be met` + `: <lastCheck>`;
  - `cleared` → `Goal cleared: <objective of previous>` or `Goal cleared`.
  Objectives in summaries are cut to 200 characters with `…` (amended 2026-09-24: at most 200
  including the `…`, and a `lastCheck` in a summary is cut the same way); the payload keeps the
  full text.
- `payload: GoalUpdatedPayload` exactly;
- `turnId`: the event's turn id (may be null); no `agentId`.
- `id`: the event's own id — except a hidden `progress` tick (amended 2026-09-24), which is written
  under ONE stable id per thread, `goal-progress:<threadId>` (`ingestion/message-ids.ts`), so the
  fold replaces it in place instead of spending a slot of the 500-row parent window on every tick
  (the `task-progress:` rule). The thread index (`agent-host/index/indexer.ts`) indexes its
  position but not its text: it reads "Goal progress" every time and only flooded search.

**§5.6 slimming must keep the goal payload**, and it does without a code change (amended
2026-09-24: there is no top-level allow-list — `packages/api/src/agent-chat/slim.ts` rebuilds only
`payload.data`, and every other top-level field survives, bar the per-string wire cap): `goal`,
`change` and `previous` are declared on `ThreadActivityPayloadFields`
(`packages/api/src/agent-chat/thread.ts`), so a client sees them on the snapshot, the live stream
and history pages.

A historical (`HISTORICAL_RAW_SOURCE`) goal event is never projected — adapters must not emit goal
events from replayed history (§6.3).

### 4.4 The fold (`packages/api/src/agent-chat/fold.ts`)

- `ThreadFoldState.goal?: ThreadGoal | null` (optional so an older constructor's state still
  folds; `undefined` reads as `null`). `createEmptyThreadState()` sets `goal: null`.
- On `thread.activity-appended` whose `activityKind === "goal.updated"`: parse the payload with
  `parseGoalUpdatedPayload`; when it parses, `state.goal = goal === null ? null : {...goal,
  updatedAt: activity.updatedAt}`; a row that does not parse leaves `state.goal` unchanged (the
  row itself is still appended as usual).
- `goal` is **not** touched by retention, by `thread.reverted`, or by history pages: it is the
  provider's state, not the conversation's, and the provider's next update corrects it.
- `toThreadSnapshot` → `ThreadSnapshotPayload.goal: ThreadGoal | null` (optional on the type, for
  older hosts). The client's snapshot adoption sets `state.goal` from it (`?? null`).
- `fold-snapshot.ts`: `serializeFoldState`/`deserializeFoldState` carry `goal`;
  **`FOLD_SNAPSHOT_VERSION` 3 → 4** (the fold now produces a field it did not before; amended
  2026-09-24 at the merge with `origin/main`, whose legacy compaction marker retention had taken 3
  in the meantime — the two bumps are distinct fold changes, so neither may reuse the other's
  number). A stored
  goal that the goal parser does not give back unchanged rejects the whole snapshot (amended
  2026-09-24): a cache miss, re-derived from the log — the cache rule, never a silent `null`.
- Determinism: snapshot + tail must equal the whole-log fold at every split, goal included.

### 4.5 Capabilities (`adapter-types.ts`)

```ts
export type GoalAction = "continue" | "pause" | "resume" | "clear";

export interface AdapterGoalSupport {
  /** "provider": `/goal …` is forwarded verbatim (Claude, Grok). "host": the host parses it (Codex). */
  command: "provider" | "host";
  /** Chip actions this provider honours (§8.2). */
  actions: readonly GoalAction[];
  /** The provider starts turns by itself while a goal is active (Codex). */
  continuesAcrossTurns: boolean;
}

AdapterCapabilities.goals?: AdapterGoalSupport;   // absent = no goal surface (OpenCode)
```

- Claude: `{command:"provider", actions:["continue","clear"], continuesAcrossTurns:false}`.
- Codex: `{command:"host", actions:["pause","resume","clear"], continuesAcrossTurns:true}`.
- Grok: `{command:"provider", actions:["resume","clear"], continuesAcrossTurns:false}`.

### 4.6 Host adapter interface (`apps/daemon/src/agent-host/adapter.ts`)

```ts
export type HostGoalCommand =
  | { kind: "status" }
  | { kind: "set"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" } | { kind: "resume" } | { kind: "clear" };

export interface GoalCommandResult {
  /** Human text for a visible `goal.status` row; "" when the provider's own updates tell the story. */
  summary: string;
}

/** What the host hands a `/goal …` besides the command (amended 2026-09-24). */
export interface GoalCommandOptions {
  /** The model picked with the command, when it differs from the thread's (§5.1). */
  modelSelection?: ModelSelection;
}

AgentAdapter.goalCommand?(threadId: string, command: HostGoalCommand,
  options?: GoalCommandOptions): Promise<GoalCommandResult>;

StartSessionInput.knownGoal?: AgentGoal | null;  // the fold's goal, so an adapter emits only real changes
StartSessionInput.carryGoal?: boolean;           // true only when the restart is an account switch
```

`goalCommand` is present exactly when `capabilities.goals?.command === "host"`. The host's own
pause of §5.6 passes no options.

### 4.7 Summary (tabs, sidebar, Attention Center, pushes)

- `AgentChatSessionSummaryFields.goal?: AgentChatGoalSummary | null` (`wire.ts`) with
  `AgentChatGoalSummary = { objective: string; status: AgentGoalStatus; continuing: boolean }`.
- The host's `summary()` sets it from the fold: `isUnfinishedGoal(state.goal)` ⇒ `{objective,
  status, continuing}`, else `null`. `continuing` (amended 2026-09-24; `goalContinuingNow` in
  `orchestration/orchestrator.ts`) is `status === "active" &&
  adapter.capabilities.goals?.continuesAcrossTurns === true` AND either a §5.5 resume mark is
  pending — whatever the session says: after a handover it may read `stopped` or `error` — or the
  session is live (a child this host serves, the head neither `stopped` nor `error`) with a turn
  running or the provider still within `GOAL_CONTINUATION_GRACE_MS` (60 s, `support/deadline.ts`)
  of an idle point it continues from: its last turn settling, or its session (re)starting. The
  grace keeps a continuation that never starts (plan mode, an upstream `NotSubmitted`) from
  reading "working" forever; the summary is recomputed on every read, so the grace ends without
  an event. It is also true while the host holds the goal for a deploy, and through the grace
  after the host sets a held goal going again while the fold still reads `paused` (§5.7, amended
  2026-09-24) — the only cases a `paused` goal is continuing.
- `SessionSummary.goal?: AgentChatGoalSummary | null` (`packages/api/src/index.ts`, in the agent
  chat block — now seven derived fields). The daemon's `summary.ts` validates it field-wise,
  `chat-sessions.ts` copies it in `applyFields` and compares it in `sameDerivedFields`.
- **Activity ladder** (`apps/daemon/src/agent-chat/activity-ladder.ts`): while `goal.continuing` is
  true, a settled latest turn is NOT "finished": the `goal-continuing` rung resolves the thread as
  working and no "finished" attention stamp or push is produced. The rung sits below approval,
  question, `starting` and a running turn, above plan-ready and both liveness rungs, and the
  `error` rung yields to it, taking the host's word: a failed turn does not end a Codex goal by
  itself — Codex blocks the goal on a turn error (upstream `ActiveGoalStopReason::TurnError`), and
  that goal update ends `continuing` — and an errored session reads continuing only while a resume
  mark is pending.
- **Deploys** (amended 2026-09-24): `continuing` never feeds `backgroundWorkThreadIds`, but a
  continuing goal's turns follow each other within milliseconds, so `activeTurnThreadIds` is
  almost never empty and a code-only deploy's drain would wait for the goal to pause, block or end.
  It does not: once goals are all that blocks the drain, the host HOLDS them between their turns
  and the next host picks them up again (§5.7). §5.5's mark covers a stop that comes anyway — a
  manual `POST /api/agent-host/stop`.

## 5. Host behaviour (`apps/daemon/src/agent-host/orchestration/**`)

### 5.1 Codex `/goal` is a host command

`orchestration/slash.ts` gains `parseHostGoalCommand(text, attachments = []): HostGoalCommand |
{ error: string } | null`, applied in `decide("turn")` right after the `/compact` check and only
when `adapter.capabilities.goals?.command === "host"`:

- The trimmed text must match `/^\/goal(\s|$)/i`, else `null` (not a goal command).
- Args are the rest, trimmed. `""` or `status` ⇒ status; `pause`/`resume`/`clear` (whole
  argument, case-insensitive) ⇒ those; `edit <objective>` ⇒ edit (empty objective ⇒ error
  `Usage: /goal edit <objective>`); anything else ⇒ set with that objective.
- Objectives are 1–4000 characters after trimming, else error `A goal is limited to 4000
  characters.` Attachments with a goal command ⇒ error `A goal can't include attachments.`
- An error is `invalidCommand(message)` — refused before anything is committed (R2-7).

`decideGoalCommand(runtime, head, commandId, {input, command, context, modelSelection})`:

- refused (amended 2026-09-24), before anything is committed, while a compaction runs or turns
  are queued behind one: `Wait for the compaction to finish before changing the goal.` — the
  moment `decideCompaction` refuses at; the effect queue would otherwise run the command after
  messages the user sent later, or after a failed compaction that dropped them.
- events: a `thread.meta-updated {modelSelection}` first when the command came with a model other
  than the thread's (amended 2026-09-24: recorded exactly as a turn records it, so the next turn
  Orquester starts runs on it too); then one `thread.message-sent` (role `user`, the text as
  typed, the composer's context, `turnId: session.activeTurnId`) — and NO
  `thread.turn-start-requested`: the host starts no turn. Any turn Codex starts is recorded by
  the fold's provider-initiated-turn path (`adoptActiveTurn`).
- schedule: `runEffect` → the session is ensured first, exactly as a turn ensures it (after a
  host restart or a crash nothing else would start one), then `adapter.goalCommand(threadId,
  command, {modelSelection})` with the changed model, else `{}` (amended 2026-09-24: Codex starts
  the goal's turns itself, on the thread's own settings, so the adapter applies the model before
  the goal request, §6.2.3); a non-empty `summary` ⇒ append a `goal.status` activity (tone
  `info`, summary = the text); a throw ⇒ append a `goal.command.failed` activity (tone `error`,
  summary `Goal command failed`, detail = the message). Goal state itself changes only through
  the adapter's `thread.goal.updated` events.

### 5.2 Watchdog

`support/deadline.ts` `TURN_LIVENESS_WINDOWS.goalMs = 60 * 60_000`. `TurnWatchdogOptions` gains
`isGoalActive?: () => boolean`; while it returns true the window is `max(goalMs, the normal
window)`. The orchestrator passes `() => runtime.state.goal?.status === "active"`. All adapters.

Three rules the build added (amended 2026-09-24):

- **The timer never sleeps past the normal window on the goal's word** (`turn-watchdog.ts`,
  `arm`): the goal row lands after the event that armed the timer, so a goal that just ended
  still reads active there. Every wake re-reads the window; a goal still active re-arms.
- **Armed lazily on `turn.started`.** A turn the provider starts by itself — a goal's
  continuation, the turn Codex starts after a host `/goal`, one after a create-time or §5.5 boot
  resume — never goes through `sendTurnEffect`, so its first live `turn.started` arms the
  watchdog (`consume` in `orchestrator.ts`). The explicit arms stay; a replayed turn is never
  watched.
- **One owner for a goal's turns.** While a Codex goal is active the adapter's own idle watchdog
  stands down (`goalOwnsLiveness`, `adapters/codex/session.ts`) and takes the turn back when the
  goal no longer is: its interrupt pauses nothing, so firing it would only make Codex continue
  the goal in a new turn. The host's stall interrupt goes through `interruptTurn`, which pauses
  the goal first (§6.2.4) — a stalled goal turn ends paused, never interrupted and continued.

### 5.3 Session start

The orchestrator passes `knownGoal: state.goal` (stripped of `updatedAt`) on every
`startSession`, and `carryGoal: true` when the restart reason is an account switch (§3.4 of the
chat spec) — and, for a start with no live session to compare against (amended 2026-09-24: the
switch applies on the next message, and the old session may be gone by then), when the binding's
last `providerInstanceId` names another identity than the one starting
(`accountMovedSinceLastSession`).

### 5.4 Provider snapshots carry live capabilities

A provider snapshot hydrated from `provider-snapshots.json` must not serve cached `capabilities`:
`provider-snapshots.ts` overlays the adapter's current `capabilities` on every served row (cached,
pending or probed), so `goals` appears the moment a new host starts.

### 5.5 A continuing goal survives host restarts and account switches (amendment, 2026-09-24)

A goal **continues** while the fold's goal is `active` on an adapter whose
`goals.continuesAcrossTurns` is true (Codex): the provider will start its next turn by itself, so
the gaps between its turns are not "idle". It is **continuing** — the summary's word, §4.7 —
while it also has a live session running a turn or still inside the grace, or a resume mark
pending (amended 2026-09-24), or while a deploy holds it or the host has just set a held goal
going again (§5.7).
The first implementation showed two ways a continuing goal silently stopped; both are closed here.

- **Account switch.** `identitySwitchRefusal` (`orchestration/session-policy.ts`) also refuses
  while the thread's goal is continuing — `goalContinuingNow`, the summary's own predicate, grace
  included — with `Pause the goal before switching accounts.`, after the compaction refusal and
  before the running-turn one (between a continuing goal's turns idle never comes, so waiting is
  the wrong advice). Otherwise a provider-started turn under the old account is killed by the
  next message's account restart. A stopped or errored session may switch (amended 2026-09-24:
  pausing a stopped Codex session would itself resume it and start a goal turn) — except one
  whose resume mark is still pending (after a handover it may read `stopped` or `error`), which
  reads as continuing (§4.7) — and so may a paused, blocked or limited goal; `carryGoal` (§5.3,
  §6.2.2) re-creates it on the new account. The same predicate turns `/compact`'s running-turn
  refusal into `Pause the goal before compacting.` — a compaction in flight, or turns queued
  behind one, still get the plain compaction refusal first. The client mirror
  `canSwitchChatAccount` (`packages/ui/src/lib/agent-chat/account-switch.ts`) gates the chip on
  `goalContinuing`, which `isGoalContinuing` (same file) decides: the summary's verdict whenever
  the view has one — `SessionSummary.goal.continuing`, and a `null` summary goal is itself a
  verdict, `false`, since the host then holds no unfinished goal — and only without one (a host
  that predates the field, a summary not yet received, a malformed one) a coarser form of the
  host's predicate: an `active` goal on a `continuesAcrossTurns` adapter with a live session
  (`starting`, `ready` or `running`) or a resume mark — no running-turn or grace check — or a
  `paused` or `active` goal whose head carries a deploy's hold mark, `goalHeldForHandover` (§5.7),
  whatever the session says; the summary's verdict still wins.
- **Deploy handover.** `markThreadsForContinuation` also marks a thread whose goal continues on a
  live session and has a usable resume cursor (the binding's, else the head's) — **without** the
  per-project continuation opt-in: setting a goal is the user's opt-in to autonomous work. It
  ignores the grace, so a late continuation is not lost, and it wants a live session: a goal
  whose session the user stopped is not revived by a deploy. The mark is a new optional head
  field `resumeGoalAfterRestart?: true` (`ThreadHead` in `thread.ts`, the `meta.json` schema in
  `packages/config`, the head check in `fold-snapshot.ts`) — additive, ignored by older builds. It
  is head-only state like `continueAfterRestart`: no domain event carries it. A deploy's drain
  holds a continuing goal between its turns (§5.7, amended 2026-09-24), so this mark serves a
  stop that comes anyway — a manual `POST /api/agent-host/stop`, or a host whose deploy has no
  hold route yet.
- **Boot.** The reconcile finds the mark on the same `meta.json` read `isOrphanedHead` makes
  (`goalResumePending`). After the gate opens — a macrotask later, never on the readiness path —
  every marked thread's provider session is resumed, side by side, through the same
  ensure-session path a turn uses, **without sending a turn** (Codex then continues the goal by
  itself, §3.2). The mark is cleared (head rewritten) on success, on failure (logged, never
  retried in a loop), for a closed tab and for a thread with no resume cursor; a thread that
  cannot even be loaded has it cleared off `meta.json` directly. It is KEPT when the host starts
  stopping during the resume — checked before the provider is asked and again once it answered —
  and a session that resume did start is stopped again: the next host owes the resume. A user's
  own session stop clears a mark the boot has not acted on yet.
- **Summary.** `continuing` is true while the mark is pending, whatever the session says (§4.7) —
  after a handover it may read `stopped`, or `error` when the restart itself failed the session;
  the resume recovers either — so the handover gap raises no "finished" stamp or push. A session
  start opens the grace window, so the resumed session reads continuing until Codex's first turn.
- A crash (no handover) writes no marker: the goal stays active in the provider's store and
  continues the next time the thread's session starts for any reason. (A SIGTERM-only stop that
  kills a resume's starting child can clear its mark the same way: no handover, no mark owed.)

### 5.6 Stop on a continuing goal (amendment, 2026-09-24)

A Stop (`/interrupt`) on a live thread whose goal continues (an `active` goal on a
`continuesAcrossTurns` adapter; the grace does not matter here) runs in this order
(`interruptEffect` → `stopContinuingGoal`, `orchestration/orchestrator.ts`):

1. **Pause the goal first**, through `adapter.goalCommand(threadId, {kind: "pause"})` with no
   options, bounded by `AGENT_HOST_DEADLINES.goalPauseMs` (1.5 s, `support/deadline.ts`); a
   failure or an expiry is logged and the Stop goes on. No row either way: the goal's own update
   says it is paused. It must come BEFORE any open card is cancelled — on Codex a card `cancel`
   ends the turn by itself, and a goal still active starts the next turn at once.
2. **Read the turn to stop again**: the provider may have ended the Stop's turn and started its
   next goal turn before the Stop, or while the pause was asked. No turn named, or the named turn
   still running ⇒ interrupt it. The named turn over (a stale Stop) ⇒ the pause stands, and the
   turn running now is interrupted only if the provider started it (a fold turn row with no
   `userMessageId`); a turn the user started keeps the staleness guard's protection, and with
   nothing running the pause was the whole Stop.
3. **Cancel the open cards, then interrupt** — the normal order (§4.1).

The adapter's own `interruptTurn` still pauses an `active` goal before `turn/interrupt` (§6.2.4);
after the host's pause it finds the goal paused, or pauses it a second time when that
notification trails the reply — harmless.

The same order applies to a goal set going again a moment ago whose `active` update has not
reached the fold yet (amended 2026-09-24, §5.7) — the host's own resume of a held goal, or the
user's own `/goal resume` (`goalResumedAt`, `goalJustResumed`, within the continuation grace): the
fold still reads `paused`, but Codex starts its next turn as soon as that update lands, so the Stop
pauses it all the same (`resumeInFlight`, read before the Stop's own release forgets the resume).

### 5.7 A deploy holds a continuing goal between its turns (amendment, 2026-09-24)

A continuing goal's turns follow each other within milliseconds, so `activeTurnThreadIds` is
almost never empty and a code-only deploy's drain (the chat spec's §3.1 case 3) waited for the
whole goal — possibly hours. A deploy now **holds** the goal between two of its turns instead: the
turn running finishes, no next one starts, the drain goes ahead, and the next host picks the goal
up again. Nothing running is cut, as the drain rule wants.

- **The signal.** While the supervisor holds a pending version restart and the drain is blocked,
  every re-evaluation — a settled turn, background work ending, the 15 s health tick — also sends
  `POST /goals/hold` (`agentHostRoutes.holdGoals`), answered `{heldThreadIds}`. It is a lease:
  each request extends it to `GOAL_HOLD_LEASE_MS` (120 s, `support/deadline.ts`) from now. A host
  that predates the route answers its route-miss 404, which the daemon ignores: the deploy that
  ships this waits as before; the next one has the route.
- **Only when goals are the last thing in the way.** The host holds nothing while anything else
  blocks the drain: its own `activeTurnThreadIds` ∪ `backgroundWorkThreadIds` must all be threads
  whose goal it can hold (below) or already holds. Otherwise a subagent fleet running in another
  tab would leave the goals idle for as long as it runs. Once that holds, EVERY holdable goal is
  held, including one in the gap between its turns, which would otherwise start its next turn the
  moment the others settle.
- **Holding.** A thread is holdable when its goal continues (§5.5 `goalContinues`) on a live
  session (`sessionIsLive`), it is not held already, and the user has not released it in this
  lease (below). In the thread's effect queue the host first writes the mark — the head field
  `goalHeldForHandover: true`, in memory and at once on `meta.json` (`saveHeadNow`) — and only then
  pauses the goal through `adapter.goalCommand(threadId, {kind:"pause"})`, bounded by
  `AGENT_HOST_DEADLINES.goalPauseMs`: a crash between a pause that landed and a mark written after
  it would leave a paused goal nobody resumes, while a mark on a goal the pause never reached is
  harmless (every resume of a held goal skips one that does not read `paused`). On success the
  thread is held and one `goal.status` row is appended: `Goal paused for an Orquester update. It
  resumes by itself once the agent host has restarted.` A pause stops only the NEXT continuation
  (§3.2): the running turn finishes as it would have. A pause that fails clears the mark again and
  is logged, and the next renewal tries again — unless this host's own stop cut it short (its
  teardown rejects the request): the request may have reached the provider, so the mark stays and
  the thread counts as held, for the next host's resume or, if that stop is aborted, this host's
  lease. Either resume asks the provider (below).
- **Continuing.** A held goal reads as continuing: `goalContinuingNow` answers true while the
  thread is held, whatever the fold's status says (it reads `paused` once Codex has answered). So
  the turn settling raises no "finished" stamp and no push, the tab reads working
  (`goal-continuing`), and the account switch stays refused (§5.5). The GUI names the hold rather
  than showing it as the user's own pause (§8.2, §8.3).
- **The handover.** The head field is the resume mark: `markThreadsForContinuation` leaves it as
  it is. The next host's reconcile treats `goalHeldForHandover` like `resumeGoalAfterRestart`
  (`goalResumePending`, off the same `meta.json` read). After the gate, `resumeGoalSession`
  resumes the provider session as §5.5 does and then RESUMES THE GOAL —
  `adapter.goalCommand(threadId, {kind:"resume"}, {onlyIfPaused: true})`, bounded — since a
  paused goal does not continue by itself; whether it is still paused is the PROVIDER's word (the
  fold can trail it, below). Both marks are cleared as §5.5 clears its own. A resume cut short by this
  host's own stop keeps them. A crash while holding leaves the head mark, and the next host
  resumes the goal the same way.
- **Release.** When the lease runs out with the host still up — the daemon stopped asking: the
  deploy was withdrawn, or a daemon with the host's own code adopted it — the host resumes every
  goal it holds, in the thread's effect queue, and clears the marks, then forgets the lease's
  releases (below). A goal that may still go on — the fold reads `paused`, or `active` while the
  pause's own update trails — has its session started again first if its provider died meanwhile
  (as a `/goal` command ensures it), then the same conditional resume as the handover's. A resume
  that does not happen says so, since the hold's row promised it: a failure, an expiry or a
  session that cannot be started again appends `The goal could not be resumed after the update.
  Send /goal resume to continue it.`, and a refusal in the provider's own words (no goal left, a
  goal at its budget) appends those words, the better advice there. The marks are cleared anyway,
  and the goal stays paused for the user to resume.
- **The user wins.** While a lease runs, any user action on a thread's goal — held at the time or
  not — releases that thread and resumes nothing: a host `/goal` command (which then runs as
  usual — `/goal resume` sets the goal going again, and the drain waits for it as it did before
  this amendment), a Stop, a session stop, deleting the thread. The marks are cleared, and
  renewals do not hold that thread again until the lease has run out: a hold queued behind the
  action was decided on a fold that has not heard of it yet (a pause's own update trails its
  reply), and must not undo it.
- **Scope.** Only `continuesAcrossTurns` adapters (Codex) hold. A Claude or Grok goal runs inside
  one turn, which the drain already waits for.
- **As built** (amended 2026-09-24; `holdContinuingGoals`, `goalHeld`, `releaseGoalHoldForUser`
  in `orchestration/orchestrator.ts`; the daemon's `requestGoalHold` in
  `apps/daemon/src/agent-chat/supervisor.ts`):
  - `/goal status` does not release a hold: it changes nothing, and releasing on a read would
    silently cancel the resume the row promises. Every other host `/goal` command does.
  - A held goal reads as continuing only while the fold says `paused` or `active`. One achieved,
    cleared, blocked or limited during its final turn holds nothing up, and its "finished" shows
    at once, not at the handover.
  - A pause the provider answers in words ("No goal is set.", a goal at its token budget) paused
    nothing: the mark is cleared again, no hold, no row, and the next renewal tries again.
    Holdable also requires the adapter to take goal commands at all.
  - A pause that runs past its deadline is not a refusal: it may land yet, and a goal it paused
    with no mark would never be resumed. So its mark is cleared, but one that lands late after all
    is adopted as a hold — mark, held, row — unless the thread was held again meanwhile, the user
    acted on its goal, or it is gone.
  - Every resume of a held goal is CONDITIONAL (`GoalCommandOptions.onlyIfPaused`, amended at
    the final review): the fold can trail the provider — a set's own update trails its reply
    (fixtures README observation 20), and a host can stop before it lands — so a fold reading
    `paused` or `active` hands the question to the provider, and any other status is the answer
    already. The Codex adapter reads the goal (`thread/goal/get`) and sets it going only when
    Codex's REPLY says `paused` — not its tracker, which a progress notification queued before the
    hold's pause can have set back to `active` during that `get` — and otherwise sends nothing and
    answers `notPaused`, which writes no row: the goal's own updates say what became of it. So a
    lease that runs out while the pause's update is still on its way resumes the goal, the next
    host resumes one whose pause never reached the old host's fold, and a goal Codex still runs (a
    crash between the mark and the pause) is left alone.
  - Every row the hold writes — the hold's own, the failed resume's, the provider's refusal —
    carries `payload.heldForUpdate: true` (`GOAL_HELD_FOR_UPDATE_KEY`): none answers a `/goal`
    the user sent, and the MCP's wait for a `/goal` answer skips them (§8.6).
  - Setting a held goal going again (a release, the next host) opens the same continuation grace
    a session start does, so the gap before Codex's next turn does not read "finished". Through
    that grace the goal reads continuing even while the fold still says `paused` — the provider's
    own update on its way — on a live session (`goalJustResumed`); the user's own goal action or
    Stop ends it at once, and a Stop in that moment still pauses the goal (§5.6). The user's own
    `/goal resume` opens the same moment.
  - The resume is bounded by `AGENT_HOST_DEADLINES.goalResumeMs` (12 s): right after a session
    start Codex first waits for its resume snapshot (up to 2 s) inside its own 10 s window. On the
    next host, a held goal whose session does not come back, or that has no resume cursor, gets
    the failure row too; a §5.5-only resume (never held) gets none — no row promised it.
  - The rule is applied on every renewal, not only to new holds. What is in the way is every
    thread with background work — a hold never ends background work, the goal's own thread's
    included — and every running turn that is neither held nor holdable. A held goal whose own
    turn has ended waits behind such work for at most `GOAL_HOLD_IDLE_MS` (3 min,
    `support/deadline.ts`): short work — a quick question in another tab — causes no pause-resume
    churn, and long work — a fleet — does not leave the goal idle. Past that, the host releases
    it as the lease's end does (a host release, not the user's): the goal goes on, and is held
    again once goals are the last thing in the way.
  - The daemon awaits the hold inside its serialized transition queue (5 s client timeout), so a
    restart never overtakes a hold still being applied; it asks whatever the blocker is (only the
    host can tell which are goals), including from its first check at boot, and remembers a host
    instance that answered 404.
  - Known limit: while a goal is held, `/compact` (with its last turn running) and the account
    switch still advise pausing a goal that is already paused — the refusal text is the host's,
    mirrored word for word by the GUI; the MCP names the hold in its own account-switch refusal
    (§8.6).
- **Compatibility.** `goalHeldForHandover?: true` is one more optional head field (`ThreadHead`,
  the `meta.json` schema in `packages/config`, the head check in `fold-snapshot.ts`), ignored by an
  older build — whose host then resumes neither the session nor the goal (a held goal reads
  `paused` at the `/stop`, so no `resumeGoalAfterRestart` is written for it either): the goal stays
  paused until the user resumes it. The route is additive; `AGENT_HOST_PROTOCOL_VERSION` is
  unchanged.

## 6. Adapters

Every adapter keeps, per session, the last goal it emitted (seeded from `knownGoal`), emits
`thread.goal.updated` only when `sameGoalState` says something changed (or on `achieved`/
`failed`/`cleared`), and throttles `progress` to at most one per 30 s per thread (a status or
objective change is never throttled). A held-back tick is never lost (amended 2026-09-24): Claude
keeps it and flushes it when its window ends; Codex and Grok let the next frame that still
differs carry it (Grok holds no timers by design; a tick still held when the session ends is the
next session's §6.3.4 comparison).

### 6.1 Claude (`adapters/claude/**`)

1. **Never-streamed synthetic text is emitted at once (fix).** An `assistant` frame with
   `message.model === "<synthetic>"` completes its text block(s) immediately — `item.started`,
   the `content.delta` with the text, `item.completed` — instead of parking the text as a
   fallback until `result`. Applies to every local-command output and CLI-synthesised message.
2. **`local_command_run.command === "goal"`** frames are parsed (text from the content, falling
   back to `local_command_source` without the `<local-command-stdout>` tags):
   - `Goal set: <cond>` ⇒ `set` (or `replaced` when a different unfinished goal is tracked) with
     `{objective: cond, status: "active", rounds: 0, setAt}`.
   - `Goal cleared: <cond>` ⇒ `cleared` (`goal: null`, `previous`).
   - `No goal set` / `No goal set. Usage: …` ⇒ `cleared` if a goal was tracked, else nothing.
   - `Goal active: <cond> (not yet evaluated|<n> turn(s))[\nLast check: <reason>]` ⇒ `restored`
     when nothing was tracked or the objective differs, else `progress` with `rounds: n`,
     `lastCheck`.
   - Refusals and any other text ⇒ no goal change (the text still renders, per 1).
3. **`Stop hook feedback:\n[<cond>]: <reason>`** (`user`, `isSynthetic: true`, string content,
   main thread) whose `<cond>` matches the tracked objective (equal, or a prefix of it — the CLI
   cuts it to 500) ⇒ `checked` with `rounds + 1`, `lastCheck: reason`, `phase` cleared. Such a
   frame must never render as a user message. `Goal check-in: «…` ⇒ `progress` (not rendered as
   a user message either), with `phase: "waiting-background"` only for the deferral check-in
   (`… because background work is still running`) — the idle one and the re-prompt after a turn
   an API error cut short mean the opposite, so they clear the phase (amended 2026-09-24).
   Stop-hook feedback for any other hook keeps today's behaviour.
4. **After every `result`** while an unfinished goal is tracked, read the CLI transcript
   (`<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<cliSessionId>.jsonl`) **incrementally** from the
   last offset read (≤ 1 MiB per read; start at the set point, else the tail) for
   `attachment.type === "goal_status"` rows — through a locator of its own (amended 2026-09-24:
   `locateClaudeTranscript`, `adapters/claude/goal-transcript.ts`; the history reader's SDK
   `getSessionMessages` returns `user`/`assistant`/`system` rows only, never an attachment), and
   JSON-parsing only a line that holds the bytes `"goal_status"`. `met: true` (not a sentinel) ⇒
   `achieved` with `previous: {…, status:"complete", rounds: iterations, elapsedMs: durationMs,
   tokensUsed: tokens, lastCheck: the evaluator's reason}`; `failed: true` ⇒ `failed` with
   `lastCheck: reason`; a `met` sentinel (an error-path clear) ⇒ `cleared`. Still unmet and
   background work live at turn end ⇒ `progress` with `phase: "waiting-background"`. A read
   failure is a debug log, never an error.
   - **The verdict is re-read** (amended 2026-09-24, the final review's critical finding): the
     row lands about 100 ms after `result` (§3.1), so a read at `result` alone missed it and the
     goal read "active" until the next turn ended. A turn end that the CLI did evaluate (nothing
     live in the background) and whose walk found no verdict reads again after
     `GOAL_VERDICT_REREAD_DELAYS_MS = [300, 1_200]` — about 0.3 s and 1.5 s after the turn end
     (`adapters/claude/session.ts`) — superseded by any newer walk, and dropped once the goal is
     over or its epoch moved. `CLAUDE_CODE_EAGER_FLUSH` is not the fix: the chat spec keeps
     Claude's env to `CLAUDE_CONFIG_DIR`, and the flag's side effects are unverified.
   - **Walks run one at a time, in order**, and each reads on from where the last one stopped.
     A goal **epoch** moves on stdout goal news that goes out, or that starts a run (`set`,
     `replaced`, `restored`) — never on a frame that changed nothing, a held-back progress, or
     anything the transcript said. A walk whose epoch moved by the time a chunk starts ends
     without reading, so it commits no position the next walk would then skip; a read asked for
     before the user cleared a goal can never resurrect it.
5. **Session start with a resume cursor:** apply `restoreGoalFromTranscript`'s rule to the
   transcript (last `goal_status` decides) and compare with `knownGoal`: a goal the CLI will
   re-arm but the fold lacks ⇒ `restored`; a goal the fold has but the transcript ended (met /
   failed) ⇒ `achieved` / `failed`; the fold's goal with no `goal_status` at all ⇒ `cleared`. A
   session started **without** a cursor holds no goal at all, so the fold's unfinished goal is
   `cleared` (amended 2026-09-24: a rewind to the very start, a lost cursor).
6. **`active_goal` (fix):** recognised before the exhaustiveness switch and never a
   `runtime.warning`; `value` ⇒ `progress`/`checked` (iterations → rounds, `last_reason` →
   lastCheck), or `restored` for a goal this session did not track (amended 2026-09-24); `null`
   ⇒ run the transcript check of 4.
7. Capability per §4.5. Interrupt changes nothing (the CLI keeps the goal active).

### 6.2 Codex (`adapters/codex/**`)

1. `thread/goal/updated` / `thread/goal/cleared` leave the "handled, no arm" list. Map
   `ThreadGoal` → `AgentGoal` (`usageLimited`→`usage-limited`, `budgetLimited`→`budget-limited`,
   `timeUsedSeconds*1000`→`elapsedMs`, `createdAt` (unix s) → `setAt` ISO). Change: first sight or
   a different objective after a clear ⇒ `set`; a different objective in place ⇒ `replaced`;
   status transitions ⇒ `paused`, `resumed` (to active from paused/blocked/limited), `blocked`,
   `limited`, `achieved` (to complete); same status and objective ⇒ `progress` (throttled).
   `cleared` ⇒ `cleared` if a goal was tracked, else nothing.
2. **Resume snapshot:** compare with `knownGoal` — equal ⇒ nothing (counters only ⇒ `progress`);
   different ⇒ `restored`; provider has none but `knownGoal` is unfinished ⇒ if `carryGoal`,
   re-create it (`set {objective, status: active if it was active else paused, tokenBudget}`,
   change `restored`) else `cleared`.
3. **`goalCommand`** implements §4.6 against a live session — the host ensured it (§5.1). ONE
   deadline, `CODEX_GOAL_COMMAND_MS` (10 s, `adapters/codex/goal.ts`), covers the whole command
   (amended 2026-09-24), so a wedged goal store cannot hold the thread's effect queue; inside it
   the command first waits up to `CODEX_GOAL_SETTLE_MS` (2 s) for this home's goal to settle — a
   resume snapshot or a carry still landing — which `pause` skips (idempotent, and a Stop waits
   on it). A model in `options.modelSelection` that differs from the session's is applied first
   with `thread/settings/update {threadId, model, effort?, serviceTier?}` — sticky like
   `turn/start`'s overrides, best-effort within half of what is left of the deadline, a failure
   logged (amended 2026-09-24). Then: `status` ⇒ `thread/goal/get` and a summary (`No goal is
   set.` / `Goal <status>: <objective> — <tokens> tokens, <time>`, the budget beside the tokens
   when there is one); `set` ⇒ `get`, then `clear` if any goal exists, then
   `set {objective, status:"active"}`; `edit` ⇒ `get`, and with no goal the answer `No goal is
   set. Use /goal <objective> to set one.` with nothing changed (amended 2026-09-24:
   `set {objective}` would CREATE an active goal; Codex's TUI refuses too), else
   `set {objective}`; `pause` ⇒ `set {status:"paused"}`, without a `get` — except a goal the
   adapter already knows is budget-limited, answered `This goal already stopped at its token
   budget.` with nothing sent (amended 2026-09-24: Codex keeps it budget-limited, and the unchanged
   update is no row, so the command would otherwise say nothing at all); `resume` ⇒ `get`, then
   `set {status:"active"}` — except a budget-limited goal, answered `This goal reached its token
   budget and can't be resumed. Set a new goal or clear it.` (amended 2026-09-24: Codex would
   land it `budgetLimited` again without a word); `clear` ⇒ `clear`. A `pause`, `resume` or
   `clear` that finds no goal answers `No goal is set.` (amended 2026-09-24). A `pause` or
   `resume` that Codex refuses for want of a goal also clears the goal the thread still shows
   (`cleared`, with `previous`) — no notification follows a refusal, so it is the only word that
   the goal is gone — unless the refusal is stale: a notification was observed since, or the
   resume snapshot has not been read yet (`CodexGoalTracker.isStale`, `adapters/codex/goal.ts`).
   The second case matters for `pause`, the one command that skips the settle wait: on an account
   switch it could otherwise clear the very goal the carry is about to re-create. Other protocol
   errors throw with the provider's message.
4. **Stop pauses the goal first (fix):** `interruptTurn` sends `thread/goal/set {status:"paused"}`
   (1.5 s deadline, failure logged, never blocking the interrupt) when the tracked goal is
   `active`, then `turn/interrupt`. Every interrupt through the adapter does (amended
   2026-09-24): the user's Stop — whose host-side pause of §5.6 comes earlier still, ahead of
   the card cancels — and the host watchdog's stall interrupt (§5.2). A session stop never pauses
   by itself: a deploy's hold (§5.7) has paused the goal before its drain-restart, and the next
   host resumes it; a stop without one (§5.5) leaves it active, and Codex continues it on resume.
5. A `get` result older than a later notification is discarded (#8615's stale re-emit); no goal
   request runs on session start except the carry of 2.
6. Capability per §4.5.
7. **The adapter's own idle watchdog stands down while its goal is active** (amended 2026-09-24,
   §5.2): the host's watchdog owns a goal's turns.

### 6.3 Grok (`adapters/grok/**`)

1. `goal_updated` joins `KNOWN_XAI_UPDATES` under every xAI method name the adapter already
   routes; identical consecutive frames are dropped. The rest of a goal run's traffic joins it
   too (amended 2026-09-24; `adapters/grok/normalize.ts`, fixtures README observation 37 — about
   120 warning rows per run before), each mapped to the closest existing concept:
   `subagent_spawned` / `subagent_finished` ⇒ a roster agent (`taskType: "subagent"` under the
   agent's own id) and its end, paired with the model's `spawn_subagent` call by the
   `subagent_id` that call's result names (else the oldest open call with the same description;
   the goal engine's own planner, workers, skeptics and summarizer have none), so the timeline
   shows one agent row instead of a tool row beside it; `retry_state` ⇒ one invisible
   `session.state.changed {running}` heartbeat per retry episode, inside a turn only — never a row
   (Claude's `api_retry` precedent); `task_completed` ⇒ the end of the background-shell roster row
   it names; `compaction_checkpoint` ⇒ nothing (`auto_compact_completed` carries the boundary).
2. Map: `objective`, `goal_id`→`goalId`, `phase`, `total_worker_rounds`→`rounds`,
   `tokens_used`, `token_budget`, `elapsed_ms`, and `lastCheck` (amended 2026-09-24): while a new
   `not_achieved` verdict stands, its own text `Verification: not achieved (attempt <n> of <m>)`
   (`classifier_runs_attempted` of `classifier_max_runs`, the attempt dropped when either is
   unknown) — never `last_event_detail`, which on a verdict frame is still the worker's summary
   of its round; otherwise `last_event_detail`; else `Verification: not achieved` when
   `last_classifier_verdict === "not_achieved"`. Status: `active`→active; `complete`→complete;
   `paused` and `*_paused`/`interrupted`→paused; `blocked`→blocked;
   `budget_limited`→budget-limited; `failed`→failed; anything else ⇒ keep the tracked status
   (debug log).
3. Change from `last_event`: `goal_created` ⇒ `set` (`replaced` if another unfinished `goalId` was
   tracked); `goal_paused` ⇒ `paused`; `goal_resumed` ⇒ `resumed`; `goal_completed` ⇒ `achieved`;
   `goal_cleared` ⇒ `cleared` (`goal: null`); `budget_exceeded` ⇒ `limited`;
   `premature_stop_detected` or a new `not_achieved` verdict ⇒ `checked` (a new verdict is a row
   even when `sameGoalState` sees no change, amended 2026-09-24); everything else ⇒ `progress`
   (throttled). A new objective under the same `goal_id` is `replaced`, whatever event it rides
   (amended 2026-09-24).
4. **Replay:** replayed `goal_updated` rows (`isReplay`, `session/load`, history projection) emit
   nothing as they arrive. Once the session is up, the provider's last state is compared with
   `knownGoal` and at most one update is emitted, live (amended 2026-09-24:
   `GrokGoalTracker.reconcile`, called with how the session opened):
   - a `session/load` that replayed no goal rows emits **nothing** — absence of evidence is not
     `cleared`: Grok 1.0.34 persisting `goal_updated` rows is unverified live, and a false
     `cleared` would hide a paused or blocked goal after every restart;
   - a fresh `session/new` has no goal by definition, so a stale unfinished goal is `cleared`;
   - the provider has none (fresh, or its last row cleared it) while the thread shows one
     unfinished ⇒ `cleared`;
   - the provider's last goal ENDED while the thread shows it running ⇒ `achieved`/`failed` for
     the same goal (§6.1.5's rule), `cleared` for another; a finished goal the thread never
     showed running ⇒ nothing;
   - the same goal, objective and status, only its counters moved ⇒ `progress`; anything else
     unfinished ⇒ `restored`.
5. **Replayed goal user message:** a replayed user message whose text starts with
   `<system-reminder>` and contains `A goal has been set:` projects as the user text
   `/goal <objective>` (objective extracted from the block; the whole block is never rendered).
6. Capability per §4.5.

### 6.4 OpenCode

No change: no `goals` capability, no events. `/goal` keeps §4.6.6's `F*` behaviour.

## 7. Fixes shipped with this

1. Claude never-streamed synthetic text appears immediately (6.1.1).
2. Claude `active_goal` is recognised, never a warning (6.1.6).
3. Grok `goal_updated` is recognised, never a warning (6.3.1).
4. Codex Stop pauses an active goal before interrupting (6.2.4).
5. Codex `/goal …` never reaches the model as text (5.1) — T3 #13252.
6. The turn watchdog does not cancel a goal run for silence under 60 minutes (5.2).
7. A Codex goal survives an account switch (6.2.2).
8. Claude's goal "Stop hook feedback" frames no longer render as user messages (6.1.3).
9. Claude's met / impossible verdict, written after `result`, is no longer missed (6.1.4,
   amended 2026-09-24).
10. A Grok goal run no longer writes a warning row for every frame of its other traffic (6.3.1,
    amended 2026-09-24).
11. A Codex Stop pauses a continuing goal before any card is cancelled, so no goal turn slips in
    between (5.6, amended 2026-09-24).

## 8. UI (`packages/ui/**`)

### 8.1 State

The thread store exposes `goal: ThreadGoal | null` from the fold (snapshot + live). The provider
row's `capabilities.goals` is validated field-wise in `sanitizeProviderSnapshot` (a malformed
block ⇒ absent).

### 8.2 The goal chip (status line)

`ChatStatusLine` gains a chip, in a stable slot before the plan chip, shown iff
`isUnfinishedGoal(goal)`. Pure logic in `status/goal-chip.ts` (tested); render in
`status/GoalChip.tsx` (lucide `Target`, 12 px):

- label `Goal` + detail: `active` ⇒ `waiting on background work` while the phase is
  `waiting-background` (amended 2026-09-24: it wins over the round — it is the "expected, not a
  stall" signal, and the popover shows both), else `round <n>` when `rounds > 0`, else the phase
  when set, else nothing; `paused`/`blocked` ⇒ that word; `budget-limited` ⇒ `budget`;
  `usage-limited` ⇒ `limit`; plus `<used>/<budget> tok` when both are known. Below `sm` — a
  360 px phone, amended 2026-09-24 — the background wait reads `waiting`, the detail truncates,
  the tokens are hidden and the chip's trigger may shrink, so the context meter is never pushed
  off screen.
- tone `info` while active (the label shimmers only while a turn is running), `warn` for
  paused/blocked/limited; `title` = the objective, capped at 200 characters like the spoken label
  (amended 2026-09-24).
- A goal a deploy HOLDS (§5.7) is not the user's pause (amended 2026-09-24): `isGoalHeldForUpdate`
  (`lib/agent-chat/goal.logic.ts`) reads it as held when the fold says `paused` and either the
  summary's verdict is `{status: "paused", continuing: true}` — the summary's own status, since
  the summary trails the fold by one 1.5 s poll and a user's Pause would otherwise flash as a hold —
  or, with no verdict, the head carries `goalHeldForHandover`. The chip then reads `paused for
  update` (`update` below `sm`) in the `info` tone, never live; the aria label and the popover's
  status say `Paused for an Orquester update — it resumes by itself`. The actions are a paused
  goal's: the user may still resume or clear it, and the host then releases the hold.
- Click opens a popover, a `dialog`: the full objective (wrapping, scrolls past ~12 lines), status
  and phase, rounds, last check, tokens (and budget), elapsed (`<1s` under a second, left out at
  zero — amended 2026-09-24), set time — each only when known — and the actions. It takes focus
  when it opens — its first action, or the panel when there is none or that action is `clear`,
  since a stray Enter must never clear a goal — gives it back to the chip, and is a keyboard layer
  (`lib/keyboard-layers.ts`): Escape closes it and does nothing else (amended 2026-09-24: Escape
  on the open popover used to interrupt the running turn — on Codex, pause the goal through Stop
  — and leave the popover open). It closes when the visible chat tab moves AWAY from its own
  thread, and stays open when its own tab is the one activated — in the grid view the click that
  opens it also activates its cell (amended 2026-09-24: `dismissWhenChatTabLeaves`,
  `lib/agent-chat-active-tab.ts`; the context meter and the composer's popovers follow the same
  rule). The actions:
  - `continue` (Claude): goal active, no turn running and no background liveness — sends
    `Continue working toward the goal.`
  - `pause` (Codex): status active — sends `/goal pause`.
  - `resume` (Codex, Grok): status paused, blocked or usage-limited — sends `/goal resume`.
  - `clear`: always for Codex; for Claude and Grok only when no turn is running — sends
    `/goal clear`.
  - Provider-command adapters (`command: "provider"`) show no action while a turn is running
    (amended 2026-09-24: not because their prompts queue — a `/goal …` typed while the turn runs is
    an ordinary message, which under the default steer setting steers the turn, and on Grok a
    steer cancels the running prompt, the whole goal run with it, which Grok then reports paused;
    only under the "queue" setting does it wait for the turn. An action offered then would do the
    same, so none is.)
  Actions send through the composer's own send path (`sendExternalText`) — its guards, the
  thread's mode and model, `/turn` — so they appear as the user's message and go through
  `decide("turn")`, with the draft left untouched. Not the exact submit path (amended
  2026-09-24): an action is never queued behind a running turn, whatever the follow-up setting
  says — a Codex Pause held until the goal's own turn ends would defeat it — and a host-parsed
  `/goal` action is never held back by an open approval or question card (the host starts no
  turn for it).

### 8.3 Tabs and sidebar

`SessionStatusDot` gains `goal?: AgentChatGoalSummary | null`; when set it draws a 9 px `Target`
before the dot (`text-info-300` active, `text-warn-300` otherwise), with `aria-label`/`title`
`Goal: <objective> (<status>)`, the objective capped at 200 characters (amended 2026-09-24). The
summary is read field-wise: a goal the client cannot read draws nothing. Every caller that passes
`backgroundLiveness` passes `goal`. A summary reading `{status: "paused", continuing: true}` is a
goal a deploy holds (§5.7): it draws the `info` tone, labelled `Goal: <objective> (paused for an
Orquester update — it resumes by itself)` (amended 2026-09-24).

### 8.4 Timeline

`goal.updated` rows whose change is not hidden render as a compact marker row (like the compaction
marker): `Target` icon + the summary; `achieved`/`failed` rows append a muted stats line —
`<rounds> rounds · <elapsed> · <tokens> tokens`, each part only when known. `progress` rows are
dropped from the work log. `goal.status` rows render as info rows, `goal.command.failed` as error
rows (the generic activity row is fine for both). Unlike a compaction marker, a goal marker stays
visible when its turn's work group is folded (amended 2026-09-24): the story of the goal — set,
checked, achieved — outlives the work it drove (`lib/agent-chat/rows.logic.ts`).

### 8.5 Composer menu

For `goals.command === "host"` the host commands gain `goal` — description `Set, check, pause,
resume or clear a goal`, hint `<objective> | pause | resume | clear | edit <objective>`. For
`provider` adapters the provider's own catalog entry is used, unchanged.

As built (amended 2026-09-24; `composer/composer-menu.ts`, `composer/composer-submission.ts`):

- Unlike the other host commands, which act and insert nothing, picking `goal` TYPES `/goal `
  into the draft and waits for the argument — the host parses the sent text, and a bare `/goal`
  is only a status query.
- It is offered only at the start of the prompt, like a provider command: anywhere else the text
  would reach the model — the bug it exists to fix. It replaces a provider row of the same name:
  one `/goal`, never two. Its hint rides beside the name, with the description below it.
- A typed host `/goal` is sent at once, even under the "queue" follow-up setting
  (`resolveFollowUpDisposition`), and an open approval or question card does not hold it back
  (`pendingRequestBlocksSend`) — the same rules as the chip's actions.

### 8.6 The Orquester MCP (amended 2026-09-24, at the merge with `origin/main`)

The Orquester MCP (`apps/daemon/src/mcp/`, `docs/orquester-mcp.md`), built in parallel, drives chat
sessions the way the GUI does, so goals reach it as the GUI shows them:

- **`send_message`** recognises a host `/goal` by this design's rules — `isGoalCommandText` and
  `capabilities.goals.command === "host"`, the capability read through `parseGoalSupport` (both in
  `@orquester/api`, shared with the host's parser and the composer). It posts it as a turn, as the
  composer does, lets it past an open request (`pendingRequestBlocksSend`), refuses one with
  attachments before any upload, and waits for NO turn — none starts (§5.1). It waits for the
  host's answer row instead — a `goal.status`, a visible `goal.updated`, or a `goal.command.failed`;
  ≤ 15 s once the session is up, half a second for a pause of a paused goal or a resume of an active
  one — and returns it as `answer` with `outcome: "goal"`, or `"failed"` for a failed command; a
  command that changes nothing writes no row and returns without one, with a hint. A deploy's own
  rows on a goal it holds (§5.7, `payload.heldForUpdate`) answer no `/goal` and are skipped. While
  the capabilities cannot be read, a `/goal` is refused: which side takes it is theirs to say.
- **Turn waits** never end on a turn that settles while the goal continues: the `goal-continuing`
  rung (§4.7) is not an outcome, so a message steering a continuing goal waits until the goal stops
  or the timeout. `wait_for_session` needs no change: the rung raises no attention.
- **`read_transcript`** shows the timeline's goal rows as `info` (a failed goal and a failed command
  as `error`), and never a `progress` tick (§8.4).
- **Views**: a session carries `chat.goal` — the summary's `{objective, status, continuing}` in a
  list (objective cut to 200), the fold's goal in a detail (a finished one where the provider's last
  update still carries it; `continuing` only beside `active`, the summary trailing the snapshot by a
  poll — or beside a `paused` goal a deploy holds, §5.7, which both views flag `heldForUpdate: true`
  as the GUI's `isGoalHeldForUpdate` reads it, the chip's "paused for update") — and an agent its
  `supports.goals`.
- **`update_session`** refuses an account switch while the goal continues (§5.5) — judged on the
  summary and on the snapshot just read, so a stale "continuing" after a pause does not refuse —
  before writing anything, and advises `interrupt_session` (a pause alone lets the running turn
  finish); a goal a deploy holds (§5.7) refuses it the same way, with its own advice — wait for the
  update, or take the goal back with `/goal pause` — and a mid-turn model or permission change under
  a held goal gets the plain turn advice, since it starts no next turn. `interrupt_session` and
  `compact_session` pass the host's goal rules through (§5.6).

## 9. Compatibility

- Additive only: no new domain event type, new optional fields, a new activity kind. An older build
  folds `goal.updated` as an ordinary activity and renders it as a generic row with its summary; an
  older client ignores `goal` on snapshots and summaries.
- `FOLD_SNAPSHOT_VERSION` 4 invalidates every `state.json` once (re-derived from the log;
  amended 2026-09-24: 4, not 3 — §4.4).
- The head's `resumeGoalAfterRestart` (§5.5) is one more optional `meta.json` field, ignored by an
  older build (amended 2026-09-24).
- A surviving older host during a rollout serves snapshots and summaries without `goal`: the chip
  and marker are absent until the drain-restart; nothing errors.

## 10. Testing

`node:test` per package, no live providers: synthetic frames modelled on §3's evidence.

- api: `goal.ts` helpers; fold (goal derivation, unparseable rows, revert/retention untouched,
  snapshot, serialize/deserialize, determinism at every split with goal rows); the goal fields
  surviving `slimActivityPayload`.
- daemon: ingestion mapping and summaries; Claude normaliser (synthetic text timing, each `/goal`
  text, Stop-hook feedback, check-in, `active_goal`) and the transcript reader (incremental,
  met/failed/sentinel, restore rule); Codex normaliser mapping/changes/throttle, `goalCommand`
  against the mock app-server (`adapters/codex/testing.ts`), pause-before-interrupt order, resume
  snapshot + carry; Grok mapping, dedupe, replay suppression, goal-block projection; slash parser;
  `decideGoalCommand`; watchdog goal window; summary/ladder (`continuing` suppresses finished);
  provider snapshot capability overlay.
- ui: chip model, popover action matrix, capability sanitising, timeline rows, `SessionStatusDot`,
  composer menu entry.
- `pnpm check` and `pnpm test` clean.
