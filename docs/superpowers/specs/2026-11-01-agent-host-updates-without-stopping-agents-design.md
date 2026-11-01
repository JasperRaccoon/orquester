# Agent host updates that never stop running agents

Status: approved for implementation (2026-11-01).
Background: T3 Code's "update all" (t3code `docs/internals/server-updates.md`) restarts its
server at any time, kills every provider process, then resumes each cut thread with a guarded
"continue" turn. Orquester already keeps agents alive across **daemon** restarts (the agent host
lives in tmux, `KillMode=process`). Only a change to the **agent host's own code** forces a host
restart, and that restart waits, without limit, until no chat has a turn, a subagent, a
background shell or a pending wake. That wait is the "A restart is pending" banner, and its
"Restart agent host now" button stops everything.

This spec removes that wait in two phases:

- **Phase 1:** when a restart does happen, every chat that was working comes back on its own:
  a resumed session plus a continue prompt that tells the agent to revive its subagents. The
  same prompt rules apply to every other automatic "continue" Orquester sends (the usage-limit
  resume and the pending-wake delivery).
- **Phase 2:** an update no longer restarts busy work at all. The old host **retires**. It
  keeps the chats that are working, and a new host on the new code serves everything else. Each
  busy chat moves to the new host on its own as soon as it is idle. The old host exits when it
  owns nothing. Phase 1 becomes the fallback for the cases Phase 2 cannot cover.

Section numbers below (P1.n, P2.n) are referenced from code comments.

## Terms

- **Live work:** an active turn, live background work (subagents, background shells, watch
  loops: what `/health.backgroundWorkThreadIds` and the roster report), a pending wake, or a
  continuing goal.
- **Primary host:** the host that runs the current checkout's code and takes every new thread.
- **Retiring host:** an older host that keeps only the threads it owned at retirement, until
  each is idle.
- **Generation:** a host instance's slot number. Generation 0 is the legacy one: socket
  `agent-host.sock`, tmux session `orqsvc-agent-host`, token `agent-host.token`. That keeps a
  host started by today's code adoptable without change.

---

## Phase 1: interrupt-and-continue done right

### P1.1 Goals

1. A host restart never leaves a working chat silently stopped. Every chat with live work at
   the restart, and a usable resume cursor, gets one automatic continue turn on the next host.
2. The continue prompt tells the agent what was cut: the in-flight turn, and the subagents and
   background shells the restart stopped, named. It tells the agent to **relaunch the subagents
   (and background commands) whose results it still needs**, and to check before repeating any
   state-changing action.
3. The same subagent-revival wording is used by every automatic continue Orquester sends. This
   includes the usage-limit resume (`USAGE_LIMIT_CONTINUE_MESSAGE` / `limit-recovery.ts`) and
   the pending-wake prompt (`pending-wake.ts`).
4. A pending update restarts the host on its own. Nobody has to click anything, and the wait
   is bounded.

### P1.2 Requirements: which threads continue (host side)

R1. `continueThreadsAfterRestart` defaults to **true** (`packages/config`). The per-project
override (`continueThreadsByProject`) still wins. A stored explicit `false` is respected. The
Settings copy says that it is on by default and that subagents are revived.

R2. `markThreadsForContinuation` (the `/stop` path) marks a thread when it has a usable resume
cursor, the project is opted in, and either of these holds:
   - (a) a turn is running (today's rule); or
   - (b) **no turn is running, but the teardown is stopping at least one subagent, or one
     background shell/watch loop, still running in that thread.** This is the "turn ended but
     its subagents still run" case Claude produces by default. Today it gets no continuation,
     which is why subagents are not revived.

   For (b), the marker records that the continuation is a **revival**: no turn is cut, but work
   was stopped. Background shells alone qualify only if the thread's last turn ended less than
   6 hours before the stop. A days-old dev server is not something the agent waits on, so it
   must not wake the agent.

R3. The crash path (`reconcile` of an orphan with no marker, `closeLeftoverWork`) applies the
same rule. A crash that stopped subagents in an idle thread continues it under the same opt-in,
cursor and closed-tab rules and the same `MAX_CRASH_RESUME_ATTEMPTS` cap.

R4. Existing skips stay:
   - no cursor;
   - a closed tab;
   - a project that opted out;
   - a newer user message (`hasLaterTurn`);
   - a deleted thread.

   New skips:
   - the user interrupted the turn (Stop) before the teardown started;
   - the thread has been auto-continued 3 times in a row within 10 minutes with no user message
     in between, from any restart cause (deploy or crash). Then the thread is settled with a
     message saying it was not resumed again, and that the user should send a message to
     continue.

R5. A turn cut while it waited on an approval or a question **is continued**. The prompt says
the request was cancelled by the restart and to ask again if the action is still needed. The
user still decides, so nothing unapproved runs. This differs from T3 on purpose: Orquester users
run long unattended chats, and a silently dead thread is worse than a re-asked question.

R6. A continuation whose start fails with a transient error is retried up to 2 times, at 30 s
and then 120 s. A transient error is a provider start timeout or a resume handshake failure. It
is not retried for a usage limit, an auth error or a validation error; those settle with
`CONTINUATION_SEND_FAILED_MESSAGE` as today.

R7. Codex's promptless continuation (`promptlessTurnContinuation`) is used only when nothing was
stopped besides the cut turn. If subagents or background work were stopped, or a request was
cancelled, the full prompt is sent to Codex too, so it learns what to revive.

### P1.3 Requirements: the prompts

R8. One module, `apps/daemon/src/agent-host/orchestration/continuation-prompt.ts`, builds every
host-side continue prompt. Its input is the cause (`restart` | `crash` | `wake`), the stopped
work (name, kind subagent/background, with at most 12 items listed and the rest counted), and
whether a request was cancelled. It must produce text like this:

> Orquester restarted while you were working, so your last turn was cut short. Continue where
> you left off. The restart stopped these subagents and background commands: "S34: shrink
> shipped player size" (subagent), "Wait for F check completion" (background command).
> Relaunch the subagents whose results you still need, with the same instructions, and restart
> the background commands you still need. Do not wait for the old ones: they will not report
> back. A command or action that was in progress may or may not have taken effect: check before
> repeating anything that changes state.

The variants:
   - **Revival (R2b):** "…while your subagents were still running…" instead of a cut turn.
   - **Nothing stopped:** a short generic line, with no list: "If you had subagents running,
     relaunch any whose results you still need."
   - **Request cancelled:** one extra sentence (R5).

R9. Daemon side, `USAGE_LIMIT_CONTINUE_MESSAGE` becomes: "Continue where you left off. If
subagents or background commands you started stopped at the usage limit, relaunch the ones whose
results you still need with the same instructions; check before repeating anything that changes
state." It is sent unchanged by the automatic resume and by "Resume now". The goal-resume branch
(`GOAL_RESUME_COMMAND`) is untouched.

R10. Every recogniser of the old literal text keeps recognising it in old logs. Examples are
`pending-wake.ts` `isWakePrompt`-style checks and any UI or summary code that hides or labels
the synthetic continue. The new texts are recognised too. Exported constants stay the single
source; the UI copy in `ChatSettings.tsx` and the config doc comments are updated.

R11. A sweep finds every other place that sends an automatic "continue" into a chat and gives it
the revival wording. Places to check include the pending-wake prompt, goals, account switch,
workflows, "Continue in another agent", and scheduled prompts. Each one is either changed or
listed in the commit message with the reason it does not apply.

### P1.4 Requirements: the restart policy (daemon side)

R12. When the primary is stale and busy, and Phase 2 is unavailable for it (P2.6), the
supervisor waits for drain for at most **`AGENT_HOST_UPDATE_GRACE_MS` = 10 minutes** from when
the restart first became pending. Then it restarts anyway through the same `/stop` path, which
marks continuations, interrupting and continuing the chats. While it waits, the existing
triggers still restart it the moment it drains.

R13. A forced restart (R12, or "Restart agent host now") is only done to a host that advertises
the new capability **`continuationRevival: 1`** on `/health`. That capability means its `/stop`
writes R2/R5 markers. A host without it, such as today's live host, keeps today's unbounded
drain wait. Interrupting it would cut chats it would not continue.

R14. The Host status page shows the policy plainly. The pending banner says the host updates
automatically, when it will, and that working chats will be resumed. "Restart agent host now"
stays, and its confirm dialog says chats will be resumed and subagents revived, not stopped.

### P1.5 Acceptance

- A unit or integration test for each new marker case:
  - a running turn;
  - revival with subagents;
  - background shells only (fresh and stale);
  - the user-Stop skip;
  - the loop cap;
  - a cancelled request;
  - Codex promptless versus full prompt;
  - a retried transient start.
- The prompt builder is tested through its export for the list cap and the variants.
- The usage-limit resume sends the new text, and old-text recognition still works on a fixture
  log.
- Supervisor tests drive the grace with `mock.timers` (no sleeps). A host without
  `continuationRevival` is never forced.

---

## Phase 2: retire the old host instead of stopping it

### P2.1 Goals

1. An update never interrupts live work. Chats that are working keep running on the old code,
   in the old host process, until they are idle.
2. Everything else (new chats, idle chats, every global route) runs on the new code at once.
3. Each busy chat moves to the new host by itself at its first idle moment. The old host exits
   when it owns nothing.
4. Nothing is written by two hosts. Every thread has exactly one owner at a time.
5. A daemon restart, a host crash or a failed spawn at any point leaves every thread owned by
   exactly one host, or recoverable through the Phase 1 crash path.

### P2.2 Process model

- Hosts are identified by **generation** `g` (a non-negative integer).
  - Generation 0 keeps the legacy names.
  - Generation `g > 0` uses socket `agent-host-<g>.sock`, token `agent-host-<g>.token` and tmux
    session `orqsvc-agent-host-<g>`. These names come from new `packages/config` helpers, with
    no hardcoded paths. The socket path must stay within the unix socket length limit.
- At most one **primary**, plus up to **3 retiring** hosts. If retiring a 4th would exceed
  that, the oldest retiring host is ended through the cap path (P2.5 R30) first.
- The daemon persists a registry, `<appdir>/daemon/agent-hosts.json`, through a
  `packages/config` schema that preserves unknown fields. It holds each generation: role
  (`primary` | `retiring`), socket, token path, tmux session name, `retiringSince`, and the last
  known owned thread ids. A missing file means "generation 0 is primary".
- Direct (non-tmux) mode follows the same rules. Every host is a daemon child, so a daemon
  restart ends them all, as today.

### P2.3 Host requirements (capability `retire: 1`)

R15. **Boot inputs.**
   - The host reads its socket from `ORQUESTER_AGENT_HOST_SOCK` (exists already), plus a new
     `ORQUESTER_AGENT_HOST_TOKEN_PATH` and `ORQUESTER_AGENT_HOST_GENERATION`.
   - It also reads `ORQUESTER_AGENT_HOST_FOREIGN_THREADS`: the path of a JSON file
     `{ "threadIds": string[] }` naming threads other hosts own. If the file is missing or
     unreadable, boot fails; the host must never guess.
   - Without these variables the host behaves as generation 0 with no foreign threads, as
     today.

R16. **Foreign threads are untouchable.** For a foreign thread the host never folds a snapshot,
writes, reconciles, settles, marks, sweeps, indexes, or kills its processes. In particular:
   - `reconcile`, `markThreadsForContinuation`, `sweepStartup`, the deep sweep and the index
     catch-up all skip foreign threads.
   - **Every leftover-process sweep** spares processes of foreign threads. That covers the
     Codex/Grok leftovers, the box launch sweep (`agent-host/boxes`), `closeLeftoverWork`, and
     any `stopLeftovers`.
   - Every thread route answers **409 `THREAD_NOT_OWNED`** for a foreign thread, and so does
     every global route that would mutate one.

   Every boot-time and periodic path that iterates `store.listThreads()` or touches processes
   must be audited and listed in the commit.

R17. **`POST /threads/:id/adopt`.** This removes the thread from the foreign set, then brings
it in exactly as boot would bring in a thread from a stopped host:
   - settle an orphan;
   - apply a continuation marker or a revival marker (Phase 1);
   - deliver a pending wake;
   - resume a held goal (`goalHeldForHandover` / `resumeGoalAfterRestart`);
   - index catch-up from its cursor.

   It is idempotent and answers once the thread is servable. Adopting a thread that is not
   foreign is a no-op 200.

R18. **`POST /retire`.** Atomically, under the per-thread command serialisation:
   - The host computes its **owned set**: threads with live work, plus any thread with a
     command in flight.
   - It releases every other thread. Released threads become foreign to it; their idle
     provider sessions are closed with the resume cursor preserved, exactly as an idle-session
     close does today.
   - It then refuses `createThread` (and fork, which creates a thread) with **409
     `HOST_RETIRING`**.
   - It stops writing shared caches: it closes its thread index after flushing, and stops the
     provider-snapshot cache flush and store sweeps.

   It replies `{ ownedThreadIds }`. A second `/retire` returns the current owned set.

R19. **Release on idle.** While retiring, the host releases an owned thread as soon as it has no
live work and no command in flight:
   - A **continuing goal** is released at its next turn boundary. It is held with
     `goalHeldForHandover` / `resumeGoalAfterRestart` so the adopting host resumes it; reuse the
     goals §5.7 hold.
   - Release closes the thread's provider session (cursor kept). It ends the thread's open event
     streams so clients re-read from the new owner. It makes the thread foreign, after which the
     host never writes it again.
   - A command arriving for a released thread gets 409 `THREAD_NOT_OWNED`.

R20. `GET /health` adds `generation`, `retiring: boolean`, and, while retiring,
`ownedThreadIds: string[]`. The daemon polls each retiring host's `/health` at the summary
cadence (about 1.5 s), so it sees a release within one poll.

R21. **`POST /unretire`** (used only when the new host failed to start). The host takes its
released threads back as owned, re-enables creation and caches, and replies. It works only while
no other host has adopted any of them; the daemon guarantees that ordering.

R22. `/stop` on a retiring host behaves as Phase 1 `/stop` for its owned threads: it writes
markers, then interrupts. Foreign threads are not touched.

### P2.4 Daemon requirements

R23. **The update flow** (replaces "wait for drain" when the stale primary is busy and
advertises `retire: 1`):
   1. `POST /retire` to the primary, which returns owned set K. If K is empty, run today's
      restart (nothing is running).
   2. Allocate generation `g' = max + 1`. Write the foreign file listing the union of all
      retiring hosts' owned sets (K included). Persist the registry with the old primary as
      `retiring` and `g'` as `starting`. Spawn the new host.
   3. Wait for readiness, with `AGENT_HOST_PREPARED_TIMEOUT_MS`.
      - On failure: kill the new host, `POST /unretire` to the old one, restore the registry,
        and fall back to Phase 1 R12.
      - On success: the new host becomes primary; persist.

   While steps 1–3 run (seconds), routes for threads outside K answer 503 as during a restart
   today, or wait on the switch promise.

R24. **Routing.** `AgentHostClient` becomes ownership-aware behind its existing interface, so
callers (`proxy-routes`, `summary`, `service`, workflows, MCP, `limit-recovery`) do not change.
The rules:
   - A thread-scoped path (`/threads/:id…`) goes to the retiring host that owns `:id`; otherwise
     to the primary.
   - Every other path goes to the primary.
   - A 409 `THREAD_NOT_OWNED` refreshes ownership, awaits any adoption in flight for that
     thread, and retries once on the right host. It never loops.
   - Streams opened with `open()` follow the same rule.
   - Health, stop, retire and adopt calls address a specific generation explicitly.

R25. **Summary and status merge.** The summary service polls every live host. A thread's state
comes from its owner. Active turns, background work and pending wakes are the union over all
hosts. Per-thread listeners (turn settled, background ended, usage limits, idle compaction) keep
working for threads on retiring hosts.

R26. **Adoption.** When a retiring host's owned set stops listing thread T, the daemon calls
`POST /threads/T/adopt` on the primary. The adoption must complete before requests for T route to
the primary; meanwhile they wait. Adoption failures are retried with backoff and logged. A thread
is never dropped.

R27. **Exit.** When a retiring host owns nothing, the daemon sends `POST /stop` (nothing runs, so
nothing is interrupted), waits for exit, kills its tmux session, deletes its socket, token and
foreign file, and removes it from the registry.

R28. **Supervision.** Retiring hosts are health-checked like the primary. If a retiring host
dies, its owned threads are adopted by the primary; adoption runs the crash path (Phase 1 R3), so
they continue. `protectedPids()` covers every host.

R29. **Daemon restart.** Boot reads the registry, probes each generation, and adopts every live
host in its role.
   - A retiring host that is gone has its last-known owned threads adopted by the primary.
   - A primary that is gone while retiring hosts are alive is respawned as a new generation.
     It is respawned with every live retiring host's owned set as its foreign file, never as
     generation 0 reconciling everything.
   - With no registry file, today's single-host boot is unchanged.

R30. **The retirement cap.** A host retiring for more than `AGENT_HOST_RETIRE_MAX_MS` = 12 hours
is ended through `/stop`, which marks continuations and interrupts. Its remaining threads are
then adopted by the primary, and the adoption continues them (Phase 1). "Restart agent host now"
does the same thing immediately for every retiring host, and for the primary if it is stale.

R31. **Host status UI.**
   - The page lists every host: the current one, and "Previous version, finishing N chats".
   - Each previous-version host shows its chats, with their running items and Stop buttons as
     today, and when the cap would end it.
   - The "A restart is pending… waits until nothing is running" banner only appears in the
     Phase 1 fallback (R12/R13).
   - In the Phase 2 case the page says the update is applied, and that working chats move over
     when they finish.

### P2.5 Ordering invariants (must hold under every interleaving)

- I1: A thread id is in at most one host's owned set. A host writes only threads it owns.
- I2: Release happens-before adopt. Adopt happens-before the primary accepts any command for
  that thread.
- I3: The foreign file a host boots with includes every thread any other live host owns at that
  moment.
- I4: The retiring host's provider session for T is closed before T is adopted, so two
  provider processes never resume one session at once.
- I5: The registry on disk is written before any step that a daemon crash could leave
  half-done: before spawn, after promote, before stop.

### P2.6 When Phase 2 is unavailable

These cases fall back to Phase 1 (R12/R13):
- the stale primary lacks `retire: 1` (any host from before this spec);
- the spawn of the new host failed;
- the protocol version differs in a way the daemon cannot route. A `AGENT_HOST_PROTOCOL_VERSION`
  change is still a hard restart.

### P2.7 Acceptance

- Host tests:
  - `/retire` computes owned sets correctly (turn, background, pending wake, goal) and releases
    idle threads;
  - release on idle (including the goal hold);
  - 409s for foreign and released threads;
  - `/adopt` runs each continuation kind;
  - boot skips foreign threads in reconcile, sweeps and index;
  - leftover sweeps spare foreign threads' processes.
- Daemon tests, with fake host clients and `mock.timers`:
  - the update flow, including spawn failure followed by unretire;
  - routing, including 409 retry and adoption waits;
  - release → adopt;
  - exit of an empty retiring host;
  - retiring-host death → adopt;
  - daemon restart with a registry (each R29 case);
  - the cap;
  - more than 3 retiring hosts.
- An integration test starts two real host processes on a temp appdir with a fake adapter. It
  shows a thread running on the old host while a new thread runs on the new host, then its
  release and adoption, without a second writer.
- `pnpm check:changed` passes. Nothing in this spec touches the live daemon.
