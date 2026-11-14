# Per-task Stop, resumable stops, and switching accounts mid-run

## Why

In an agent chat the only Stop is the liveness banner's, and it stops everything: the turn, every
subagent and every background shell. The user often wants to end one runaway shell or one
subagent and keep the rest. Separately, a subagent that Claude Code records as stopped by the
user can never be resumed: when the user later says "resume them", the main agent's `SendMessage`
answers "was stopped and won't be resumed", and the only way out today is hand-editing
`agent-<id>.meta.json`. Finally, the account chip is greyed out ("Available when the agent is
idle") whenever anything runs, so moving a busy chat to another account means stopping it by hand,
waiting, switching, and typing a continue message.

## Goals

1. A Stop on each live subagent row and each live background-shell row of the roster, stopping
   that one task only.
2. No stop that Orquester performs, through any surface (GUI, MCP, workflows, account switch, host
   restarts), leaves a subagent unresumable. After any such stop, "resume them" works.
3. The account chip works while the chat is busy. Picking an account then shows a warning modal;
   confirming stops the work, switches the account, and sends a continue message that resumes the
   stopped subagents and reruns the needed background commands.

## Non-goals

- Per-task Stop for Codex, Grok and OpenCode: their protocols have no single-task stop
  (`supportsTaskStop` stays Claude-only; their roster rows show no per-task Stop).
- Switching the Agent Profile while busy. The profile chip shares the account chip's idle gate
  today and keeps it.
- Stopping one member of a Claude Code workflow run (still refused: "Stop the whole workflow").
- Interrupting a running context compaction for a switch: it keeps its current refusal ("Wait for
  the context compaction to finish before switching accounts.").

## Anti-goals

- A per-task Stop that kills sibling tasks or the main turn.
- A busy switch that loses the user's queued messages or silently drops a delegated chat.
- Clearing a marker the user would want kept. (There is none in Orquester today: no Orquester
  surface lets the user stop a subagent "for good"; see the CLI facts below.)

## What the Claude CLI does (2.1.322, read from the bundled CLI and confirmed by a spike)

- `stoppedByUser` is set only by a **user-sourced task stop**: the SDK's `stop_task` control is
  hard-wired to `source: "user"` and marks the task and the subagents it cascades to, both in the
  CLI's in-memory task registry and in `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<sessionId>/
  subagents/agent-<id>.meta.json`. There is no option to stop with another source.
- The SDK `interrupt` (not `turn-cancel` scope) kills background tasks with source `"system"`, and
  closing the query kills the process: neither marks anything. So today's Stop-everything, host
  restarts and usage-limit recovery are already safe. (Observed: the JasperEngine-2 subagents
  stopped by the 2026-11-14 04:10 host restart carry no marker.)
- The agent's own `TaskStop` tool stops with `killedBy: "parent"`: no marker.
- A resume (`SendMessage` to the agent id) is refused if either the in-memory registry or the
  meta file says `stoppedByUser`. Spike (`stop_task`, then edit the meta file, then resume):
  - same CLI process, file cleared → **refused** (in-memory copy);
  - file cleared, CLI restarted with `resume: <sessionId>` → **resumed**, agent finished;
  - file kept, CLI restarted → **refused**.
- Every account home's `projects` is a symlink to one shared `/var/lib/orquester/.claude/projects`,
  so a Claude subagent's transcript and meta are reachable after an account switch.

## Approaches considered

**For a resumable single-subagent Stop** (the user picked A):

- **A. `stop_task`, then clear the marker while the CLI is down, and restart the CLI before the
  resume.** Instant stop; resumable after a restart (proven above). Cost: a CLI restart (a few
  seconds) before the next turn that might resume.
- B. Ask the main agent to stop the task with its own `TaskStop` (no marker). Not instant, spends a
  turn, and waits while the main agent is busy. Rejected.

**For switching while busy:** a single daemon-side "stop, settle, switch, continue" sequence reusing
the existing interrupt (with `cascade: false`), account route and turn route. The alternative,
lifting the host's busy refusal and swapping identity under a live process, is impossible: the
account is a launch environment, so the process must restart anyway.

## Design

### 1. Per-task Stop on subagent and shell rows (UI)

- `AgentRosterRow` gets the same Stop affordance `WorkflowGroup` already has, driven by the
  existing `taskStopControl(agents, row.agent.id, { canStopTasks, stoppingTaskIds })` and
  `onStopTask`. It shows for live subagent rows and live background-shell rows that
  `taskStopRefusal` allows; workflow members, loops/goals and settled rows show none (unchanged
  rule). "Stopping…" lasts until the row settles (`pendingTaskStops`), as for workflows.
- Nothing changes in the API, the host route (`task/stop`) or the Claude adapter's `stopTask`: they
  already accept any live roster task. Both desktop and web get it via `packages/ui`.
- A nested subagent (spawned by a subagent) gets its own Stop as well; stopping a parent also stops
  its children (the CLI's cascade).

### 2. No Orquester stop leaves a subagent unresumable (host, Claude adapter)

- **Clear at every CLI start.** Whenever the Claude adapter starts a CLI process for a thread that
  resumes a provider session (`resume: <providerThreadId>`), it first removes `stoppedByUser` (and
  only that key) from every `agent-*.meta.json` under that session's `subagents/` directory in the
  launch's `CLAUDE_CONFIG_DIR`. The process is down at that moment, so the CLI cannot race the edit.
  Unknown fields are preserved; unreadable or malformed files are left untouched and logged as a
  warning; a missing directory is not an error. This covers every restart path (account switch,
  profile switch, host restart, Stop with no turn running, the restart in the next point).
- **Restart before a turn that may resume.** The adapter records, per live CLI process, that a
  per-task stop hit a `local_agent` task (a session-scoped flag set by `stopTask` when the stopped
  task is a subagent; shells don't need it: the marker is meaningless for them). When the next user
  turn is sent and the flag is set and **nothing is live** (no running turn, no live background
  task), the adapter restarts the CLI (close, clear markers, resume) before delivering the turn. If
  something is still live, the turn is delivered without a restart and the flag stays set for the
  next turn: restarting would kill that live work.
- The resume itself is the main agent's job: Orquester never resumes a subagent on its own after a
  per-task Stop.

### 3. Switch account while busy (UI + daemon)

- **Chip.** The account chip stays enabled while the chat is busy for the reasons a stop can clear
  (running turn, unsettled turn, live background work, open approval/question, a continuing goal, a
  goal held for an update — goals are covered in "Goals" below). It stays disabled, with today's
  wording, for a running compaction and while the session is `starting`.
- **Modal.** Picking another account on a busy chat opens a warning modal before anything happens:
  it says what is running (the turn, N subagents, N shells, an open request), that all of it will be
  stopped and the agent restarted on the chosen account, and that the agent will be asked to resume
  the subagents and rerun what it still needs. Buttons: "Stop and switch" / Cancel. An idle chat
  switches exactly as today, with no modal.
- **Sequence (daemon, one new socket-trusted path behind the account route).** The account route
  gains an optional body field (`whileBusy: true`, set only by the modal). With it, the daemon:
  1. persists the intent on the tab record before acting (so a daemon restart mid-way finishes or
     abandons it cleanly, as limit recovery does with `ChatUsageLimitState.action`);
  2. sends the session-scoped interrupt with `cascade: false` (delegated chats keep running, as for
     limit recovery) — pending approvals and questions are cancelled by the interrupt's existing
     settle step;
  3. waits on the bus for the thread to be idle with no live background work (no sleeps; the same
     wait limit recovery uses);
  4. performs the ordinary `switchAccount` (which restarts the CLI on the new home; part 2 clears
     the markers then);
  5. sends a continue turn through the chat's own `/turn` route under an idempotent command id.
     Its text (new constant beside `USAGE_LIMIT_CONTINUE_MESSAGE`): *"This chat was moved to another
     account. Orquester stopped your subagents and background commands to do it; the user did not
     cancel them. Continue where you left off: resume each subagent whose work you still need with
     SendMessage (it keeps its context), and rerun the background commands you still need; check
     before repeating anything that changes state."*
  Without `whileBusy` the route behaves exactly as today (the host's refusal still applies).
- **Providers** (designer's call). The busy switch applies to every adapter that has managed
  accounts (Claude, Codex, Grok; not OpenCode, which has no per-thread account). The continue text
  is per adapter: Claude's is the one above; Codex and Grok get the same text without the
  `SendMessage` / keeps-its-context clause ("relaunch the subagents and rerun the background
  commands you still need"). The builder verifies for Codex and Grok that the session-scoped
  interrupt empties the liveness registry so step 3 can finish; if one of them cannot reach idle,
  that adapter keeps today's idle-only switch (chip gated by a capability) rather than shipping a
  sequence that hangs.
- **No other sender gets in during the sequence** (designer's call). From step 1 until the continue
  turn is accepted, the daemon refuses every other `/turn` for that chat with the existing
  not-idle refusal (`TURN_NOT_IDLE`), whoever sends it: other clients, MCP `send_message`, scheduled
  prompts, workflows, an armed limit-recovery resume. The fence is the persisted intent itself, so
  it survives a daemon restart. The confirming client does not drain its queue to the composer
  (unlike the manual Stop): queued messages stay queued, are refused while fenced, and flush the way
  they already do once the continue turn runs (at its first step, as the queue flushes today).
- **Failure after the stop** (designer's call). The stop cannot be undone, so the user must see a
  failure:
  - settle wait gives up, or the host refuses or is unavailable at step 4: the chat stays on the old
    account, stopped; the fence lifts; no continue turn is sent; a warning row in the timeline says
    the switch failed after stopping the work, with the reason, and that the user can switch again
    or tell the agent to continue. The route returns the error for a modal still open.
  - daemon restart mid-way: on start the daemon re-runs the persisted sequence from its recorded
    step under the same command ids (receipts make repeats no-ops). An intent older than the settle
    limit when it is found is abandoned with the same warning row.
- If the user picked the account the chat already runs on, nothing happens (no modal).

### 4. Goals during a busy switch

Facts (goals spec `2026-09-24-agent-goals-design.md` §5.5–§5.7): only an adapter whose
`goals.continuesAcrossTurns` is true (Codex today) starts goal turns by itself, so only there does a
goal keep a chat busy between turns ("continuing"). A Claude or Grok goal is just a running turn
and is covered by the sequence above as is. The session-scoped Stop already pauses a continuing
goal before interrupting (§5.6), and the identity switch's `carryGoal` already re-creates a paused
goal on the new account (§5.5). Today the host refuses the switch with "Pause the goal before
switching accounts." (continuing) or the held-goal words (§5.7); the busy switch replaces both
refusals with the sequences below. `identitySwitchRefusal` keeps them for any switch without
`whileBusy`.

- **Continuing goal.** Same sequence as §3, with the goal handled explicitly:
  1. persist the intent, recording that the goal was continuing;
  2. Stop (which pauses the goal first, then interrupts — §5.6, unchanged);
  3. wait for idle;
  4. switch (`carryGoal` carries the paused goal);
  5. instead of the continue message, send `/goal resume` (the same command limit recovery sends for
     a blocked goal) under the idempotent command id, so the goal goes on by itself on the new
     account. The fence lifts once it is accepted.
  The modal names the goal: "The goal will be paused, the chat moved to <account>, and the goal
  resumed there."
- **Goal held for an Orquester update** (§5.7: paused between turns while a deploy drains; the next
  host resumes it by itself). Nothing is running, so there is nothing to stop: the switch happens at
  once and the **hold is kept** — the goal stays held and resumes by itself on the new account when
  the update's host restart sets it going again (that resume reads the thread's current launch
  identity, which the switch has replaced). No `/goal resume` is sent: resuming now would start goal
  turns in the middle of the deploy's drain, which is what the hold exists to prevent. The switch
  must preserve the hold mark (`goalHeldForHandover`) and the resume mark
  (`resumeGoalAfterRestart`) on the head. The modal says: "The goal is paused for an Orquester update.
  It will move to <account> and resume there by itself after the update."
- **Failure** follows §3's rule. A continuing goal whose switch failed after the pause stays paused
  on the old account, and the warning row says so and that `/goal resume` sets it going again.

## Constraints

- Agent-chat route paths come from `agentChatRoutes`; the new body field goes into the shared
  contract first. `whileBusy` is a user-facing option, valid on remote transport too (it is the
  user's own command, not a daemon-only field).
- The sequence uses `DaemonApi`, receipts and bus events, never timed polling.
- Meta-file edits go through the Claude adapter only, against the launch's `CLAUDE_CONFIG_DIR`;
  paths are built from the session id the host already holds, never from client input.
- Host protocol changes must stay compatible with daemon handovers (an older host simply never
  receives `whileBusy`, because the daemon owns the sequence).

## Left to the builder

- Exact Stop control placement and styling on the row (match `WorkflowGroup`'s).
- How the "nothing is live" check is read inside the adapter (normalizer turn state + the liveness
  registry are the obvious sources).
- Modal copy beyond the points above, and where the busy-switch progress shows (the existing
  "Switching…" chip state is a fine default).
- Tests: a host/adapter test that a start clears `stoppedByUser` and preserves other keys; one that
  a per-task subagent stop leads to a restart before the next idle turn and not before a busy one;
  a daemon test for the busy-switch sequence order (interrupt with `cascade: false` → idle → switch
  → continue) and its idempotence after a restart; a continuing-goal switch that ends in
  `/goal resume` on the new account, and a held-goal switch that keeps both head marks and sends
  nothing; UI logic tests where `taskStopControl` /
  account-chip gating change.
