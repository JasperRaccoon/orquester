# Agent chat GUI — design

Date: 2026-09-21. Status: approved design, awaiting implementation plan.

Research behind this spec: `docs/superpowers/research/2026-09-20-agent-gui/` (eight analyst
reports on Orquester and T3 Code, the adapter audit `t3-5-adapter-audit.md`, and the feasibility
assessment `00-feasibility-assessment.md`).

**T3 Code citations.** Every statement derived from T3 Code carries an italic line right after it
in the form *T3: `path:lines` — note*. Paths are relative to a read-only clone of
`github.com/pingdotgg/t3code` at commit `adcd908`, kept at `.t3code/` in this repo during design
and implementation (excluded from git via `.git/info/exclude`; re-clone with
`git clone --depth 1 https://github.com/pingdotgg/t3code .t3code && git -C .t3code checkout adcd908`
if missing). A note starting with "differs:" marks a place where this design deliberately departs
from T3.

## 1. Goal

Replace the "coding agent runs as a TUI inside a tmux pane rendered by xterm.js" model with a
native chat GUI. The daemon drives each agent over its machine protocol and the client renders
messages, reasoning, tool calls, command output, diffs, approvals, questions and subagents as
structured rows. Plain terminals keep tmux exactly as today.

Decisions already taken with the user:

| Decision | Choice |
|---|---|
| Coexist or replace the agent-in-terminal mode | **Replace.** Agent tabs are chat only. |
| Providers in v1 | Claude Code, Codex, OpenCode, Grok, built in parallel. claudex/claudemix are Claude with proxy env. |
| Catalog rows without an adapter (gemini, kimi, agy, cline, deepcode) | **Dropped** until an adapter exists. |
| Login | Existing managed accounts. No new auth flow. |
| Agent processes across daemon restart | **Supervised service child** (agent host in a tmux service session). |
| Idle sessions | **Never reaped.** A thread's session lives until the tab closes. |
| Streaming transport | **Long-lived chunked HTTP NDJSON**, no new WebSocket channel. |
| Adapter layer | **T3's shape**: one adapter interface, one normalised event union, vendor SDK where one exists. |
| Checkpoints | **Full per-turn git checkpoints** for changed-files cards and diffs. |
| Revert | **Conversation only.** Files are never restored by a revert. |
| Subagents | Roster docked below the composer, drill-in to a subagent's own timeline. |
| Default approval buttons | T3's four, all user-visible: Approve, Always allow this session, Decline, Cancel. |
| Background work | A live background row is never collapsed or faded in the roster. Stopping is T3's single Stop — the session interrupt — not a per-task command. |
| Naming | Where T3 already names a field, event or status, this design uses T3's name. |

*Built: every decision above survived implementation. Two **names** could not. `RuntimeMode` (the
permission mode) collides with the client-platform `RuntimeMode` `@orquester/api` already
exported, so it is `RuntimeMode` at `@orquester/api/agent-chat` and `AgentRuntimeMode` at
`@orquester/api` — the same type, two spellings. And the thread head's session status rides
`SessionSummary` as `chatSessionStatus`, because `status` was already the PTY status
(`packages/api/src/agent-chat/adapter-types.ts`, `packages/api/src/index.ts`). The four default
approval buttons are unchanged; what a button *sends* on Codex is not — see §4.3.*

## 2. Non-goals

- Per-thread git worktrees (natural follow-up; see §10).
- File restore on revert.
- Pagination of long threads. A thread is sent whole; a `?after=` tail exists for reconnect only.
- Multi-environment, relay, device pairing, or any change to the single-password auth model.
- Voice mode, provider feedback upload, and any action that *starts* a Codex review. As in T3, the
  two review item types are classified and produce no timeline row (§4.2); nothing more. The
  per-turn `approvalsReviewer` axis of §4.4 is a different thing and is in scope.
  *T3: `packages/contracts/src/providerRuntime.ts:123-135` — `review_entered` / `review_exited` sit in the closed `CanonicalItemType`; `apps/server/src/provider/Layers/CodexAdapter.ts:658-659` — their only producer, a classifier; the protocol's `review/start` is in the generated catalog and nothing in T3 calls it*
- Replacing xterm terminals or the daemon's terminal-shaped `/mcp` server.

## 3. Architecture

```
client (web / desktop)          daemon (Fastify, dies on deploy)        agent host (tmux service, survives)
┌──────────────────┐  HTTP/NDJSON ┌────────────────────────┐  unix socket ┌──────────────────────────────┐
│ chat view        │◄────────────►│ /api/sessions/:id/*    │◄────────────►│ orchestration + projections   │
│ zustand slice    │              │ proxy + auth + tabs    │              │ 4 adapters                    │
│ composer/roster  │              │ sessions.json (tabs)   │              │ threads/<id>/{meta,events}    │
└──────────────────┘              │ /events bus (coarse)   │              │ child procs: claude/codex/    │
                                  └────────────────────────┘              │   opencode/grok               │
                                                                          └──────────────────────────────┘
```

The split of responsibilities is T3's: orchestration records intent and state without knowing
which provider runs a thread, and every protocol, account, permission and capability difference
is normalised at the adapter boundary rather than spread through the routes and the client.

*T3: `docs/internals/providers.md:1-10` — "Provider constraints": normalize at the adapter boundary, route work by instance so two accounts on one driver never share mutable session state*

### 3.1 The agent host

A separate long-lived Node process, `apps/daemon/src/agent-host/main.ts`, run with tsx like the
daemon. It hosts the four adapters, owns every provider child process, owns the per-thread event
logs, and serves a small HTTP-over-unix-socket API at `<appdir>/daemon/agent-host.sock`.

**Why separate.** `deploy/orquester.service` uses `KillMode=process`: on restart only the node
process is signalled and anything parented to the tmux server survives. Agents survive deploys
today because tmux owns them. Keeping adapters in the daemon would kill every in-flight turn and
any tool it was running on each deploy. The host preserves the current property.

*T3: `apps/server/src/serverRuntimeStartup.ts:345-347` + `:482-747` — differs: T3's provider children die with the server and every orphan is recovered by `reconcileProviderSessions` on the next boot; the host makes that path the exception rather than the rule*

**Spawn and adoption.** The daemon spawns the host the way it spawns cliproxy today
(`newServiceSession` in `apps/daemon/src/tmux.ts`): a tmux service session named
`orqsvc-agent-host`. Auth between daemon and host is a 0600 token file
`<appdir>/daemon/agent-host.token` regenerated only when no host is alive. Boot sequence in
`startDaemon`, after `sessions.reattach()`:

1. Probe the socket with the token.
2. Healthy and same `AGENT_HOST_PROTOCOL_VERSION`: adopt.
3. Healthy but version mismatch (after a deploy): adopt, then restart the host as soon as no
   thread has an active turn. Same drain rule cliproxy uses for re-parenting.
4. Socket answers but rejects the token: foreign process. Log an error, never kill or adopt.
5. Nothing answers: spawn, poll readiness, then adopt.

*Built: case 3's "no thread has an active turn" is "no thread has an active turn **or live
background work**". `GET /health` carries `backgroundWorkThreadIds` (this section's liveness
registry) next to `activeTurnThreadIds`, and the daemon unions it with its own §6.4 summary-poll
view so the host a deploy replaces, which may predate the field, is held too (that view is
"unknown" until the poll's first round, which also holds such a host at boot). A subagent fleet or
a background shell outlives its turn inside the provider process, and restarting under it killed
the fleet with no notice — the CLI reported each agent as "didn't finish before the previous
session ended" on the next message (2026-09-23). Background work ending reopens the window exactly
as a settled turn does; a manual `POST /api/agent-host/stop` still restarts at once.*

A 15 s unref'd health interval with bounded backoff supervises it afterwards, as for cliproxy.

**Readiness is a gate, not a race.** The host accepts no command until its own startup has
finished acquiring adapters, opened the thread store and completed the §3.3 reconcile. Commands
that arrive before that are queued on a readiness deferred and run in arrival order once it
resolves; if startup fails, the gate is failed with that error and every queued and subsequent
command answers with it rather than hanging. The daemon's probe in step 1 is answered only after
the gate opens, so "the socket answers" and "the host can take work" are the same fact.

*T3: `apps/server/src/serverRuntimeStartup.ts:111-152` — `makeCommandGate`: queue commands until `signalCommandReady`, fail every queued command on startup failure; `apps/server/src/serverRuntimeStartup.ts:964-981` — startup phase order: reactors parked, then `provider-sessions.reconcile`, and `:1064-1066` signals command readiness only after that; `docs/internals/server-updates.md:23-28` — the trial must acquire dependencies, bind HTTP and park every long-running root before it reports prepared*

**Supervision of provider children.** Each provider child is owned by the session's scope: the
scope closing is what kills the process, so a thread can never leak a child that nothing is
listening to, and stopping the host closes every scope. Three signals are wired for every child
regardless of protocol:

- **stderr is captured, not discarded.** The stream is decoded, split on newlines with a carried
  remainder, ANSI-stripped, and each line is classified: log lines below `ERROR` and a small
  benign-snippet list are dropped, a fatal-snippet list becomes `runtime.error {class:
  "provider_error"}`, everything else becomes `runtime.warning`. A bounded tail (last 4 KiB) is
  additionally retained so an exit error can carry an excerpt, and that excerpt is **redacted
  before it leaves the host** — home paths collapsed to `~`, `Authorization`/`x-api-key` values
  and `sk-`/`ghp_`/`xox*`-shaped tokens masked — because it is shown to the user and written to
  `events.ndjson`. Without any of this a child that dies on a missing binary, a bad `HOME` or a
  stale login produces a silent hang.
- **The exit code is watched.** A non-zero exit puts the session in `error` and a zero exit in
  `stopped`; either way it emits `session.exited` with the code in `reason`, unless the host
  itself closed the session (then it is `exitKind: "graceful"`).
- **A dead child never leaves a running turn.** Before `session.exited` is emitted the adapter
  settles the in-flight turn — `interrupted` when the stream simply ended, `failed` with the
  first captured failure when it ended in error — and closes every live task with
  `task.completed {status: "stopped"}`, which the roster folds to `interrupted` (§7.6). Every
  request still parked on that transport is failed at the same moment rather than left awaiting
  a reply that can never arrive, and any later call on that session fails fast. The projector
  then derives session status from that stream, so `session.exited` always clears `activeTurnId`.
  This is the runtime half of the §4.1 rule that a running state never outlives its process.

*T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2372-2402` — stderr decoded, line-split with remainder and emitted as a `process/stderr` notification; `:670-688` — `classifyCodexStderrLine` (ANSI strip, level and benign-snippet filter); `apps/server/src/provider/Layers/CodexAdapter.ts:420-425` + `:2145-2168` — fatal snippets become `runtime.error`, the rest `runtime.warning`; `apps/server/src/provider/acp/AcpStderr.ts:5-17` — the 4 KiB ring tail; `:19-38` — the redaction applied before an excerpt is surfaced; `apps/server/src/provider/acp/AcpSessionRuntime.ts:380-400` — the tail attached to `AcpProcessExitedError`; differs: `packages/effect-codex-app-server/src/client.ts:261-263` drains Codex's stderr, so its exit errors carry only a code and a pid — keep the ACP behaviour for all four; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2404-2428` — exit code watched, non-zero ⇒ `error` + `session/exited` carrying the code; `packages/effect-codex-app-server/src/protocol.ts:186-223` — every pending request failed once on termination, later sends fail fast; `apps/server/src/provider/Layers/ClaudeAdapter.ts:4228-4259` — `handleStreamExit` settles the turn `failed`/`interrupted` before `stopSessionInternal`; `:4272-4300` — live tasks settled `stopped` on the way out; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1846-1886` — `session.exited` ⇒ status `stopped`, `activeTurnId` null, unconditionally*

**Every step that waits on a child has a deadline.** The spawn-to-handshake window (`initialize`,
or the server's ready line), the resume/load call, cancel, and interrupt are each bounded, and an
expired deadline kills the child rather than leaving the thread `starting` forever. This is the
one place the design does not follow T3: its Codex handshake is an unbounded await, unblocked only
by the child exiting, which turns a provider that starts but never answers into a permanently
`starting` thread.

*T3: `apps/server/src/provider/opencodeRuntime.ts:82` + `:812-835` — 30 s server-start cap and its timeout error; `:143-150` — a separate 5 s cap on the health call; `apps/server/src/provider/acp/AcpSessionRuntime.ts:66` — 90 s session new/resume/load cap; `:68` + `:966-1002` — 15 s cancel cap, then the child is retired; `apps/server/src/provider/Layers/GrokProvider.ts:57-59` + `:495-510` — bounded probe timeouts (4 s version, 10 s auth, 8 s ACP initialize); differs: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2432-2436` — `initialize` awaited with no timeout*

**Interrupt and stop are bounded and ordered.** Settling pending approvals and user-input requests
before the interrupt reaches the provider (§4.1) is not only a UI nicety: a transport that answers
server requests inline on its read loop is blocked by an open prompt, so cancelling after the
interrupt RPC deadlocks Stop exactly when a card is open. Interrupts aimed at subagent threads are
issued with a per-child and an overall deadline so one wedged child cannot stop the parent's
interrupt from running — the runaway-fleet case is precisely when Stop has to work. Killing a
child is SIGTERM, then SIGKILL after a short grace; where the child spawns its own server the
whole process group is signalled, not just the direct child.

*T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2561-2601` — settle approvals and user inputs first (with the deadlock rationale), then bounded per-child (3 s) and overall (10 s) interrupts before the parent's; `:58` + `:1327-1346` — `forceKillAfter: "2 seconds"`; `apps/server/src/provider/acp/AcpSessionRuntime.ts:489-495` + `:959-964` — kill with a 1 s force-kill; `apps/server/src/provider/opencodeRuntime.ts:728-745` — SIGTERM to the process group, 1 s, then SIGKILL*

**No restart backoff, by construction.** A child that exits is not respawned. The thread's
session becomes `stopped`/`error` and the next `sendTurn` starts a fresh one from the persisted
cursor (§4.1 lazy recovery). A retry loop around a child that fails at spawn would burn an
account's rate limit against a problem — a missing binary, a stale login — that only a user
action fixes.

*T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:706-721` + `:815-818` — a session is (re)started only from a command path (`ensureSessionForThread`), never from a supervisor loop*

**One live session per thread, one command at a time.** Before a thread's session is started or
restarted the host stops any session that thread still holds on another adapter or another
account, so a resume cursor is never advanced by two processes. Within a thread every mutating
command takes a per-thread lock, so a `/turn` that arrives during a restart or during an
interrupt waits rather than racing; it is not rejected.

*T3: `apps/server/src/provider/Layers/ProviderService.ts:1362-1394` — `stopStaleSessionsForThread`; `apps/server/src/provider/Layers/GrokAdapter.ts:416-435` — the per-thread semaphore map and `withThreadLock`, taken by start/prompt/interrupt/stop; differs: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:96` + `:416` + `:438-442` and `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1866-1895` serialise every command and every side effect **globally**, one fiber for all threads — acceptable there, not here, where one slow provider would stall every other tab; `apps/server/src/workspace/workspaceLease.ts:1-22` + `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1795-1809` — a cwd-keyed lease additionally serialises threads sharing one checkout*

**Turn liveness watchdogs pause on the user.** Where a protocol hides the reasoning phase and a
turn can look silent while it is working (§4.5, Grok), the adapter runs an inactivity deadline
against the turn: **10 minutes with no activity, widened to 30 minutes while a tool call is
open**. Those two windows are stated here and nowhere else. The deadline does not start until the
protocol has produced observable progress, and it is **paused entirely while an approval or
user-input request is pending** — a turn waiting on a human is not a stalled turn, and a
watchdog that ignored that would cancel every request the user left open over lunch. On expiry
the adapter cancels the provider turn and settles it as failed with the elapsed window in the
message.

*T3: `apps/server/src/provider/Layers/GrokAdapter.ts:94-101` — 10 min turn / 30 min active-tool defaults and why; `:507-510` — `hasLivenessPause` (pending approvals, pending user input, in-flight updates); `:729-777` — `settleStalledTurn` re-checks the pause immediately before cancelling; `:778-812` — the watchdog sleeps on the remaining window and wakes on activity*

*Built: the watchdog is **host-side and runs for all four adapters**
(`apps/daemon/src/agent-host/orchestration/turn-watchdog.ts`), where T3 keeps it inside its Grok
adapter — a wedged Codex or OpenCode turn is the same failure and deserves the same bound. A turn
the watchdog stalls settles `failed` **and** puts the session in `error`, so the next `/turn` takes
the §4.1 lazy-recovery path instead of steering into a child that stopped answering.*

**Background liveness outlives the turn.** Subagent fleets, background shells and watch loops
keep running inside the provider process after the turn that launched them has settled. The host
tracks, per thread and in memory only, which task ids are still live from the same task events
the roster folds (§4.2), classifying each transition rather than making it sticky: a task that
reports `idle` or any terminal status drops out, a status-free progress row never resurrects one,
and a subagent's own shells are covered by the owning agent's entry while a *nested* agent counts
on its own. What the host derives from that registry is T3's two-state `backgroundLiveness`:
`"working"` while any agent work is live, `"monitoring"` only when watch loops and background
shells are the *only* live work, `null` otherwise (§6.4). `session.exited` clears the thread. This is not bookkeeping for a reaper — there is
none (§1) — it is what stops the thread reading `idle` with a "finished" attention stamp and
firing a push (§6.4) while an agent is still working in it. It is deliberately not persisted:
after a host restart the registry is empty, which is correct, because orphaned background work is
not live.

*T3: `apps/server/src/orchestration/ThreadBackgroundLiveness.ts:1-166` — the whole registry, its two-state vocabulary and the "no persistence, no migration" rationale; `apps/server/src/orchestration/ThreadSettlementPolicy.ts:118-124` — live background work blocks auto-settlement; `apps/server/src/provider/Layers/ProviderSessionReaper.ts:81-95` — differs: T3 consults it to skip reaping a thread; Orquester never reaps, so it feeds only the activity/attention derivation*

**No-tmux hosts** (Windows, stock macOS dev): the host is a direct daemon child and dies with it.
The same reconcile in §3.3 recovers on boot. Nothing else differs.

**Launch environment for provider children.** Built explicitly, never by spreading
`process.env`: the session PATH (`sessionPath()`, wider than the daemon's own), `TMPDIR`
(`/tmp` is unavailable under `ProtectSystem=strict`), `HOME`, the managed account's home variable
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, or OpenCode's data dir), the cliproxy launcher
env for claudex/claudemix (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
compaction and timeout env, exactly as `resolveExtraEnv` produces today), and
`ORQUESTER_SESSION_ID`. Ambient credentials for the same vendor that did not come from the
selected account are removed rather than left to win, so a thread can never silently bill a
different identity. Values are passed verbatim — nothing expands `~` or `$VAR` for a spawned
child, so any path the host injects is already absolute. Managed hooks are **not** installed into
chat sessions; the protocol replaces them.

*T3: `apps/server/src/provider/ProviderInstanceEnvironment.ts:5-22` — differs: T3 layers per-instance vars **over** a spread of `process.env`; the host builds the map from nothing because the daemon's own environment holds cliproxy and push secrets; `:14-19` — "Child processes do not apply shell expansion to environment values", so only home-dir vars are expanded and everything else is verbatim; `docs/internals/providers.md:25-31` — the launch environment removes ambient vendor credentials so an instance cannot silently use another account or billing project; `apps/server/src/provider/antigravityAuthSupport.ts:64-80` + `:212-225` — the denylist pattern: strip every credential/config key from the inherited env, then re-add only the configured one*

*Built: no hook script is installed for a chat session — but `ORQUESTER_SESSION_ID` still is (it is
in the list above), and a managed account home's user-level `settings.json` already carries
Orquester's **terminal** hooks, so those hooks fire carrying a chat session id.
`POST /api/sessions/:id/agent-event` therefore **accepts and ignores** an event for a chat session
rather than answering 404: the protocol is the only activity source for a chat thread, and a 404
would make a working hook look broken to the user's agent
(`apps/daemon/src/agent-chat/session-router.ts`).*

**Kill guard.** `apps/daemon/src/system-status.ts` adds the host pid to the protected set via
the same `protectedPids` hook cliproxy uses. Provider children remain legal kill targets.

**Observability.** Per thread, `raw.ndjson` (untranslated provider frames, tagged with source)
and `events.ndjson` (normalised). Rotation: 10 MiB per file, 10 files, 14 days for raw; events
are the durable log and are not rotated. Both writers are best-effort and never block a turn,
which takes four concrete measures: one shared writer per thread (two writers rotating the same
file race), a batch window with a bounded pending buffer that flushes early on either a record or
a byte threshold, a total-bytes ceiling across the directory on top of the per-file rotation, and
per-record truncation caps on string length, field count and nesting depth. High-rate delta
frames (`content.delta`, `item.updated`, `tool.progress`, `task.progress`, `turn.proposed.delta`
and their per-provider raw equivalents) are dropped from `raw.ndjson` rather than written: the
decoded frame that follows carries the same information without a second copy of every token. A
writer that fails to open degrades to a no-op; diagnostics never block host startup.

*T3: `apps/server/src/provider/Layers/EventNdjsonLogger.ts:25-34` — 10 MiB / 10 files / 14 days, plus the 512 MiB total ceiling, 1 s batch window and 1 MiB / 512-record buffer the spec's numbers come from; `:35-37` — 64 K char / 1024 field / depth 16 record caps; `:42-62` + `:194-235` — the transient-frame drop list and the "decoded frames carry the same information as raw" rule; `:754-782` — early flush on the buffer thresholds; `apps/server/src/provider/Layers/ProviderEventLoggers.ts:11-23` + `:61-89` — one shared store per thread and degrade-to-no-op on setup failure*

### 3.2 Processes per thread

| Agent | Long-lived process | Protocol | Client |
|---|---|---|---|
| Claude | one CLI per thread, owned by the SDK | stream-json over stdio | `@anthropic-ai/claude-agent-sdk`, `pathToClaudeCodeExecutable` set to the registry-resolved `claude` so the SDK's bundled copy is never used |
| Codex | one `codex app-server` per thread | NDJSON JSON-RPC over stdio (no `jsonrpc` field, 32 in-flight server requests max) | hand-written, ~200 lines framing; method catalog lifted from T3's `effect-codex-app-server/src/_generated/meta.gen.ts` |
| OpenCode | one `opencode serve` **per project**, shared by its threads | HTTP + SSE | `@opencode-ai/sdk` or ~20 fetch calls plus an SSE reader |
| Grok | one `grok agent stdio` per thread | ACP + `x.ai/*` extensions | hand-written ACP client; catalog from `effect-acp/src/_generated/meta.gen.ts` |

*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4916` — `pathToClaudeCodeExecutable` from the resolved binary; `apps/server/src/provider/Drivers/ClaudeExecutable.ts:45-60` — why a bare name or an npm shim cannot be handed to the SDK; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2429-2450` — `initialize` / `initialized` then `thread/start`|`thread/resume` per session; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2846-2865` — differs: T3's chat `startSession` connects its **own** `opencode serve` bound to that session's scope; `apps/server/src/provider/OpenCodeServerOwner.ts:10` + `:129-155` — the only shared server is a refcounted instance-owned helper for catalog/text-generation work, closed 30 s after its last borrower*

**The shared OpenCode server has two conditions.** T3 keeps one chat server per thread because
its MCP registrations are directory-scoped while its own MCP connection is thread-scoped, so
co-tenant threads would replace each other's connection. Orquester's chat sessions register no
per-thread MCP connection into the OpenCode server — the daemon's terminal-shaped `/mcp` server is
out of scope (§2) — which is what makes one server per project safe; the day a thread-scoped
registration is added, the server becomes per thread. Second, OpenCode stores persistent approval
grants per directory, so an automatic approval issued on behalf of a `full-access` thread must be
sent as a one-shot grant, never a persisted one, or it silently widens every other thread sharing
that server. The server is refcounted by its threads and torn down shortly after the last one
closes, so a project nobody is working in holds no process.

*T3: `docs/internals/providers.md:14-23` — per-thread chat servers, directory-scoped MCP registrations, and the `once` rule for automatic full-access replies; `apps/server/src/provider/OpenCodeServerOwner.ts:12-18` + `:85-155` — the refcount, the idle-close timer and its cancellation on re-acquire*

**Starting that server is the one readiness handshake that is not an RPC.** The port comes from
an ephemeral-port probe and the real URL is taken from the `opencode server listening …` line on
stdout, never assumed from the requested port; the whole wait is capped (§3.1) before a health
call confirms the version. The buffering, drain and version rules are §4.5's.

*T3: `apps/server/src/provider/opencodeRuntime.ts:81-84` — the ready prefix, 30 s cap, loopback default and 64 KiB startup buffer; `:675-688` — `findAvailablePort(0)` passed as `--port`; `:836-852` — startup buffers released while the pipes keep draining, then `verifyOpenCodeServerVersion`*

**Each adapter gates on a minimum CLI version at session start.** An out-of-range CLI is refused
with the required version in the message rather than started and allowed to fail on the first
unrecognised frame; for OpenCode the check runs both on `opencode --version` and on the server's
own health response, because an already-running server can be older than the binary on PATH.

*T3: `apps/server/src/provider/opencodeRuntime.ts:42` + `:143-177` — `MINIMUM_OPENCODE_VERSION` enforced against the health response; `apps/server/src/provider/Layers/OpenCodeProvider.ts:472-494` — the same gate on the CLI version*

*Built: the host's `MINIMUM_CLI_VERSIONS`
(`apps/daemon/src/agent-host/orchestration/version-gate.ts`) carries **only** OpenCode's
`1.14.19`; `claude`, `codex` and `grok` are `null`. Those three declare the version they were
validated against in their own adapter and surface drift as a `versionAdvisory` warning rather
than a refused session — a floor invented for a CLI upstream never pinned would refuse sessions on
installations that work.*

**Provider snapshots refresh on a slow interval, not per request.** The snapshot of §4.1 is
computed on demand, cached, and re-probed in the background every few minutes; refreshes are
serialised so two clients opening Settings cannot run two probes, an identical configuration
short-circuits to the cached value, and a refresh only runs while something is actually watching
provider status. The last snapshot is persisted next to the registry so a restarted host can
render agent cards before the first live probe returns, and it is keyed by the agent id it was
written for rather than trusted by filename. Each probe is individually bounded — a few seconds
for a version, longer for an auth check that may touch disk or network.

*T3: `apps/server/src/provider/makeManagedServerProvider.ts:248-283` — the interval loop, re-reading its interval each tick and racing a settings change against the sleep; `:64` + `:174-179` — refreshes serialised by a one-permit semaphore; `:129-152` — identical settings return the cache without probing; `:207-221` + `:264-271` — the demand gate; `packages/contracts/src/settings.ts:921` + `:1150-1153` — a 5-minute default, user-configurable; `apps/server/src/provider/providerStatusCache.ts:108-123` — the per-instance on-disk snapshot, with identity carried inside the file because "the filename alone is not trusted as a routing key"; `apps/server/src/provider/providerSnapshot.ts:23-25` — 4 s generic and 10 s auth probe timeouts*

*Built: **a fresh host never answers `GET /providers` with `[]`, in three
layers.** As first shipped, the registry started empty and only the 5-minute
interval filled it, so after the 2026-09-22 deploy every launcher on vps-a/vps-b
read "Still loading this agent's models" for five minutes and no chat could
open. T3 never has that window, and its three mechanisms are adopted whole
(`apps/daemon/src/agent-host/orchestration/provider-snapshots.ts`):*

1. ***A pending seed, synchronously at construction** — before `load()` and
   before any probe, the registry stores one snapshot per adapter from
   `ADAPTER_PENDING_SNAPSHOTS` (`adapters/pending.ts`, and a `pendingSnapshot()`
   on `AgentAdapter` so a new adapter cannot forget it). It carries
   `status:"unknown"` (T3's `"warning"` has no member here), `auth:{status:
   "unknown"}`, the sentence "… provider status has not been checked in this
   session yet.", and **the best catalogue the adapter can name without I/O**:
   Claude's bundled family aliases (`FALLBACK_CLAUDE_MODELS` — `default`,
   `opus`, `sonnet`, `haiku`, `fable`) and Grok's two, so those launchers work
   on a cold host. Codex and OpenCode read their catalogues off a live server
   and answer `[]`; their row exists (the provider is listed, not missing) and
   layers two and three close their window. **Never `status:"error"`** — that
   would make §7.7's toast fire for a provider nobody has looked at. A pending
   row is never persisted and never hydrated.
   *T3: `makeManagedServerProvider.ts:69-73`; `Layers/ClaudeProvider.ts:595-640`.*
2. ***The disk cache is correlated, not merely keyed.** The cache file is v2:
   each row is `{identity, snapshot}` where identity is `{adapterId,
   hostProtocolVersion, binPath, version}`. A row hydrates only when its
   adapter id agrees in all three places (map key, identity, snapshot), the
   protocol version matches, and the `binPath` still resolves to the same
   executable — so a cache written before an `npm install -g` moved the binary
   is discarded rather than rendered. A v1 identity-less payload is discarded
   outright. A correlated row **overrides** the pending seed.
   *T3: `Layers/ProviderRegistry.ts:292-352` — "old identity-less payloads are
   discarded"; `:743-751` — "on-disk state wins where present and pending
   fallbacks fill the gaps"; `providerStatusCache.ts:115-160`.*
3. ***The registry forces one probe of every provider at boot itself**
   (`startBootRefresh()`), called by `main.ts` **after** `host.openGate()` and
   **never awaited**: the socket is already bound and readiness already
   announced, so a probe's deadline can never delay either. Serialised through
   the same one-permit chain, and idempotent. The 5-minute interval is now only
   a top-up and stays demand-gated on a live watcher; the first-watcher priming
   that was the stopgap is kept purely as a no-op fallback for a registry
   nobody kicked.*
   *T3: `makeManagedServerProvider.ts:280-284` —
   `applySnapshot(initialSettings, {forceRefresh: true})` under
   `Effect.forkScoped`.*

*Client side nothing branches on `status`: `resolveLaunchModel`
(`packages/ui/src/lib/launch-models.ts`) takes `Pick<ProviderSnapshot,
"models">`, so a pending snapshot with a catalogue is launchable exactly like
any other (the host validates `modelSelection.model` at thread creation), and
"Still loading this agent's models" is reserved for a genuinely empty
catalogue.*

New runtime dependencies for the daemon package: `@anthropic-ai/claude-agent-sdk`,
`@opencode-ai/sdk`. Both are plain npm packages.

### 3.3 Reconcile on host start

The reconcile's input is every thread whose persisted state claims a live process: `meta.json`
shows an active turn, or a `starting`/`running` session, or a `ready` session that was already
prepared for continuation before the host died. Anything the host can see running is excluded
first, so an adopted host is not reconciled against itself.

*T3: `apps/server/src/serverRuntimeStartup.ts:503-540` — live thread ids from `listSessions()` subtracted, the `starting | running | activeTurnId !== null | prepared-while-ready` orphan filter*

1. Mark `continueAfterRestart` in `meta.json` before doing anything.
2. Resume the session from its resume cursor.
3. Send a continuation turn: promptless where the adapter declares
   `promptlessTurnContinuation` (Codex), otherwise the literal `"Continue where you left off."`.
4. Clear the marker on success. If resume fails, settle the turn as `failed` with
   `errorMessage: "The agent did not survive a restart. Send a new message to continue."` and
   emit `runtime.error`. Never leave a running state without a live process behind it.

*Built: step 2 resumes from the **binding's** cursor
(`threads/<id>/binding.json`), falling back to the head's — see "The resume
cursor is not event-sourced" below. Step 4 uses two messages rather than one,
as T3 does: a thread that was never eligible (no cursor, closed tab, a project
that opted out, a marker for another turn) settles with the sentence above,
while a continuation that was **attempted** and failed settles with `"Could not
continue this thread after the server restart. Send a new message to
continue."` — the user is told the thread could not be picked up, not that it
was never eligible. Both clear the marker and leave the cursor alone, so the
thread is still resumable by hand.*

**The resume cursor is not event-sourced.** It lives in a per-thread
`binding.json` beside `meta.json` that is only ever written field-wise through
one `upsertSessionBinding`, whose `undefined` means "unchanged" and whose `null`
means "cleared". `thread.session-set` names the whole session block, so an event
that omitted the cursor replaced it with nothing: the head lost it and the next
host — after the §3.1 drain-restart — opened a FRESH provider session that
remembered nothing (2026-09-22, thread c8979f6a). The fold still carries the
cursor forward and `session-set` still carries it on the wire, for old logs and
old clients, but no code path depends on it surviving there. Rollback boundary
(§8): a thread with no `binding.json`, or one that does not decode, falls back
to the head's cursor.

*T3: `apps/server/src/persistence/ProviderSessionRuntime.ts:35-52` — the
`provider_session_runtime` row, outside the event log (`packages/contracts/src/orchestration.ts:599-609`
has no `resumeCursor` on the session object); `apps/server/src/provider/Layers/ProviderSessionDirectory.ts:118-145`
— the field-wise upsert and its `undefined`/`null` contract; `apps/server/src/provider/Layers/ProviderService.ts:1053-1076`
— `upsertSessionBinding`; `:1104-1129` — the `turn.completed`/`turn.aborted` hook that saves Claude's
new boundary before a client can checkpoint the turn; `:1441-1471` + `:2150-2173` — the read-back,
`input.resumeCursor ?? persistedBinding.resumeCursor`*

*Built: T3 keeps the continuation marker in that same row's `runtimePayload`.
Here it stays on the head, where `continueAfterRestart` already is: the head is
not purely event-sourced in this codebase — no domain event carries that field,
it reaches disk only through an explicit `saveHead`, and the head projection
carries it forward untouched. Splitting it across two files would buy nothing
and add a second ordering to get wrong.*

*T3: `apps/server/src/serverRuntimeStartup.ts:655-690` — the prepare step writes the marker and flips the projection to `starting` before anything else; `:694-716` — the continuation send, promptless where `promptlessTurnContinuation`, else `SERVER_UPDATE_CONTINUATION_PROMPT`; `:347-348` — that prompt is the same literal; `:717-741` — clear on success, settle as error on failure; `:345-346` + `:588-648` — `settleAsError` writes the binding `stopped` and dispatches the session to `error` with `activeTurnId: null`*

**The marker is a turn id, not a boolean, and it is written twice.** It records *which* turn was
in flight, so a continuation can be matched against the session's `activeTurnId` and a marker
left over from an older turn is ignored rather than replaying the wrong work. It is written
once **before** an intentional host stop — the §3.1 drain-restart and any `POST
/api/agent-host/stop` — for every thread that is running with a usable cursor, and written again
by the reconcile itself, together with a `prepared` flag, immediately before the continuation is
sent. The second write is what makes recovery survive a host that dies *between* resuming and
sending: on the next boot that thread is `ready` with no active turn, which without the flag
looks like a settled thread and would silently drop the turn. If the intentional stop is aborted,
every marker written for it is cleared, so a cancelled restart does not inject a phantom
"Continue where you left off." on the next boot.

*T3: `apps/server/src/serverRuntimeStartup.ts:393-399` — `readServerUpdateContinuationTurnId`: the marker is the turn id; `:406-448` — `markRunningProviderSessionsForContinuation`, only threads with a resume cursor, and markers rolled back if the marking itself fails; `:450-480` — `clearContinuationMarkers`; `apps/server/src/cloud/selfUpdate.ts:65-135` — `withRunningThreadContinuation`: mark during the update, clear on any failure that is not an accepted handoff; `apps/server/src/provider/Layers/ProviderService.ts:2296-2360` — the same marker written from the graceful stop-all path; `apps/server/src/serverRuntimeStartup.ts:508-540` + `:576-592` — the `prepared`-while-`ready` case and its guards*

**Archived and deleted threads are settled, never continued.** A thread the user closed or
deleted while a turn was running is settled as an error on the next boot; resuming it would
restart a provider process and spend tokens for a tab nobody is looking at.

*T3: `apps/server/src/serverRuntimeStartup.ts:649-654` — `thread.archivedAt === null && thread.deletedAt === null` guards the continuation branch; everything else falls through to `settleAsError`*

**Continuation is opt-in per project.** Whether an interrupted turn is continued at all is a
setting, resolved per the thread's project over a host-wide default that is **off**, because "pick
up where you left off" is wrong for a project where a turn was halfway through a destructive
operation.
Threads whose project opts out are settled as errors with the same message and the user sends
again.

*T3: `apps/server/src/serverRuntimeStartup.ts:494-502` + `:578-586` — `continueThreadsAfterServerUpdate` resolved through `resolveProjectSettings` per project; `packages/contracts/src/settings.ts:1071-1074` — default `false`; `apps/server/src/provider/Layers/ProviderService.ts:2299-2321` — the same per-project resolution on the stop path*

*Built: the preference lives in the daemon-owned `app.json`, and the **host reads it there itself**
at reconcile rather than being told by the daemon. Reconcile runs before the daemon has necessarily
adopted the host — that is the whole point of §3.3 — so a continuation that had to wait for the
daemon to hand it a setting would either stall or silently take the default.*

**Reconcile never blocks or fails host startup.** Each continuation is forked; the loop only
prepares it. A thread whose directory binding cannot be read, whose projection dispatch fails, or
whose continuation throws is logged and settled individually, and a failure of the whole pass is
logged rather than propagated — one unrecoverable thread must not keep the host from serving the
other twenty.

*T3: `apps/server/src/serverRuntimeStartup.ts:694` — `forkParked` around the continuation; `:742-747` — the whole reconcile catches to a log warning; `:548-560` + `:629-644` — per-thread failures logged and settled, interrupts alone re-raised*

Threads without an active turn are not resumed eagerly; the first `sendTurn` re-adopts them
(lazy recovery, §4.1).

### 3.4 Session restart policy

Lives in the host's orchestration, not in adapters. A thread's session restarts, carrying its
resume cursor, when any of: runtime mode changed, cwd changed, account changed, or (Claude only)
the model selection object changed including options such as thinking level. A model change on
an adapter declaring `sessionModelSwitch: "in-session"` (all four) is applied live. Plan mode is a
per-turn field and never restarts anything.

*T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:752-777` — `runtimeModeChanged` / `cwdChanged` / `instanceChanged` / `shouldRestartForModelChange` / `shouldRestartForModelSelectionChange`, the last one Claude-only and compared by deep equality on the whole selection object; `:772-779` — none of them ⇒ return the existing session untouched*

**The check runs on the send path, not beside it.** Every `/turn` and every `/mode` goes through
one "ensure the session matches what this thread now wants" step that either returns the live
session or restarts it and rebinds, and only then sends. Nothing else starts sessions. That
ordering is what makes a mode or model change arriving during a turn safe: it is serialised
behind the same per-thread lock as the turn (§3.1), so it either lands before the send or after
the turn settles, never halfway. A restart is a no-op when nothing changed, so the common case
costs one comparison.

*T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:821-836` — `buildSendTurnRequestForThread` calls `ensureSessionForThread` first, with `pendingTurnStart: true`; `:734-750` — `bindSessionToThread` records the session as `starting` rather than `ready` while a turn start is pending, so the UI never shows idle between the restart and the send*

**A message sent while the session is down is queued, not lost.** The user message is persisted
before any provider work, and a thread whose latest user message is newer than every turn
timestamp counts as having a turn start queued — within a bounded grace window, so a clock skew
or a pre-adoption row cannot pin a thread as busy forever. That state is what the status line
(§7.6) shows during a restart and what keeps the thread out of any "settled" treatment.

*T3: `apps/server/src/orchestration/ThreadSettlementPolicy.ts:28-45` — `threadHasQueuedTurnStart` and its absolute age bound; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1777-1792` — `pendingTurnStart` consulted on every session/turn lifecycle event; `:1849-1856` — a `ready` session with a pending turn start is reported as `starting`*

**Compaction is the one operation that both refuses and queues.** `/compact` is rejected outright
while a turn is running or another compaction is in flight — it rewrites the conversation the turn
is reading. A `/turn` that arrives *during* a compaction is queued per thread instead and replayed
in order afterwards, each queued turn awaited before the next is dispatched and the original
message id reused so the user sees one bubble, not two. If the compaction fails, the queue is
cancelled and each message appends an error activity reading "Context compaction failed. Send this
message again to continue." — a queued message is never silently dropped and never sent into a
conversation that was not compacted. §6.2 carries only the HTTP surface of this rule.

*T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1414-1427` — compaction refused while `starting`/`running` or already compacting; `:1467-1476` — turn starts arriving during compaction pushed onto the per-thread queue; `:327-370` — ordered replay, one awaited at a time, re-queued on dispatch failure; `:1450-1461` + `:306-324` — the queue drained into "Queued message was not sent" activities on failure; differs: our copy is "Context compaction failed. Send this message again to continue."*

*Built: the queues are per thread and there are **two** of them plus a git queue — one for commands
and one for turns — so a `/mode`, `/approval` or `/answer` arriving during a compaction is not
parked behind a queued turn (`apps/daemon/src/agent-host/orchestration/`). And `/mode` against a
thread with no live session records the new mode and starts **nothing**: a mode change is not a
reason to boot a provider child, and spend an account's tokens on its startup, for a thread the
user has not sent a message to.*

*Built: **"account changed" is reachable from the composer's account chip**, and it follows the
`/mode` rule exactly — it records the change and starts nothing, and the restart happens on the
next `/turn`'s ensure step, carrying the cursor. Three things make it safe:*

1. ***`launch.json` is rewritten BEFORE the head.*** *`main.ts`'s `buildEnv` and `resolveHome` both
   prefer the persisted launch config over the head's account — they have to, it is the daemon's
   resolved answer — so a head that moved first would name the new account while every relaunch
   kept the old home's credentials. A failed append rolls the launch config back
   (`orchestrator.ts` — `setIdentity`/`applyIdentity`).*
2. ***It is refused unless the thread is idle*** *(`identitySwitchRefusal` in `session-policy.ts`):
   no active or unsettled turn, not `starting`/`running`, no parked request, no queued turn, not
   compacting, no live background work. The restart would otherwise kill work the user is watching,
   and a parked approval belongs to a process about to be replaced. §7.4's chip mirrors the same
   expression to gate itself. A session in **`error`** is deliberately still switchable — a stale
   login is exactly when the user wants another account, and the switch starts nothing, so it earns
   the same carve-out `/session/stop` and `/revert` have in §6.2.*
3. ***The home KIND may never cross the cliproxy boundary, and OpenCode is excluded outright.*** *A
   thread's home kind is a function of its registry entry, which never changes; and OpenCode runs
   one server per project under the daemon's own identity (§3.2), so there is no per-thread account
   to move. Both are 400 `INVALID_COMMAND`.*

*The identity itself rides `thread.meta-updated` — the one writer of head-shaped metadata — plus a
`session.identity-changed` activity, appended in the same decision. `binding.json` gains no new
writer: `startSession` refreshes `providerInstanceId` when the restart happens, as it always did.*

## 4. Adapter layer

### 4.1 Interface

Every adapter is a plain object implementing:

```ts
interface AgentAdapter {
  readonly id: "claude" | "codex" | "opencode" | "grok";
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    promptlessTurnContinuation?: boolean;      // Codex
    supportsConversationRollback?: boolean;    // absent = true; Grok false
    showPlanModeToggle: boolean;               // Claude, Codex true; OpenCode, Grok false
    reportsContextWindow: boolean;             // Claude, Codex true; OpenCode, Grok false
    compaction: { type: "native" } | { type: "slash-command"; command: string };
  };

  startSession(input: {
    threadId: string; cwd: string; home: AccountHome; title?: string;
    modelSelection: ModelSelection; runtimeMode: RuntimeMode; resumeCursor?: unknown;
  }): Promise<ProviderSession>;

  sendTurn(input: {
    threadId: string; input: string; attachments: AttachmentRef[];
    modelSelection?: ModelSelection; interactionMode: "default" | "plan"; continuation?: boolean;
  }): Promise<{ turnId: string; resumeCursor?: unknown }>;

  interruptTurn(threadId: string, turnId?: string): Promise<void>;
  respondToApproval(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  respondToUserInput(threadId: string, requestId: string, answers: Record<string, unknown>): Promise<void>;
  compact(threadId: string): Promise<void>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  rollbackThread(threadId: string, numTurns: number): Promise<ThreadSnapshot>;
  listSessions(): ProviderSession[];
  hasSession(threadId: string): boolean;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;

  readonly events: AsyncIterable<RuntimeEvent>;
}
```

*T3: `apps/server/src/provider/Services/ProviderAdapter.ts:67-158` — `ProviderAdapterShape`; `:45-55` — capabilities (`sessionModelSwitch`, `promptlessTurnContinuation`, `supportsConversationRollback`); `:35-43` — `ProviderCompaction`; `packages/contracts/src/provider.ts:54-89` — session-start / send-turn / turn-result inputs; `packages/contracts/src/server.ts:199-201` — `showInteractionModeToggle` and `reportsContextWindow`, which are snapshot presentation flags in T3 (differs: Orquester folds both onto the adapter's `capabilities`, since one adapter serves one provider); `apps/server/src/provider/Services/ProviderAdapter.ts:99-104` — T3 names it `respondToRequest` (differs: `respondToApproval` here, same contract)*

`startSession` returns the whole session record, not just a cursor: `{threadId, status:
"starting"|"ready"|"running"|"stopped"|"error", runtimeMode, cwd?, model?, resumeCursor?,
activeTurnId?, createdAt, updatedAt, lastError?}` — the same five states `session.state.changed`
carries (§4.2); `idle` exists only on the thread head (§5.1), for a thread that has no session
yet. `ThreadSnapshot` is `{threadId, turns:
[{id, items: unknown[]}]}` — opaque provider items, used to reconcile after a restart without
replaying a transcript into the provider.

*T3: `packages/contracts/src/provider.ts:35-51` — `ProviderSession`; `apps/server/src/provider/Services/ProviderAdapter.ts:57-65` — `ProviderThreadSnapshot` / `ProviderThreadTurnSnapshot`*

`resumeCursor` is `unknown` by contract — each adapter owns its shape and it is the only thing
persisted for resume. Codex `{threadId}`; OpenCode and Grok `{schemaVersion: 1, sessionId}`;
Claude `{threadId, resume: <uuid>, resumeSessionAt, turnCount, turnStartMessageIds[]}`. A cursor
that fails its own shape check means "no resume", never an error.

*T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:82-84`; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:71-91`; `apps/server/src/provider/Layers/GrokAdapter.ts:92, 282-287`; `apps/server/src/provider/Layers/ClaudeAdapter.ts:2186-2204`*

`uploadFeedback` (Codex-only, `feedback/upload`) is deliberately not part of this interface;
provider feedback upload is a non-goal (§2).

*T3: `apps/server/src/provider/Services/ProviderAdapter.ts:145-147`; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2618-2626`*

Rules of the interface, enforced by the orchestration layer so no adapter can forget them:

- **Cursor per turn.** `sendTurn`'s returned cursor is persisted to `meta.json` every time. Claude
  also refreshes it on every assistant message.
- **Steering.** `sendTurn` while a turn is active reuses the active turn id and injects into the
  running loop. It is neither an error nor a second turn.
  *Built: a steering send appends **only** the user message — no second
  `thread.turn-start-requested` — so the turn's recorded start, its checkpoint baseline and its
  duration stay those of the turn being steered.*
- **Settle before interrupt.** Every pending approval and user-input request is resolved with
  `cancel` and emitted as `request.resolved` / `user-input.resolved` before `interruptTurn` or
  `stopSession` reaches the provider.
- **Interrupt is turn-scoped.** `interruptTurn` carries the turn id the user pressed Stop on and
  is a no-op when that turn is no longer the active one, so a Stop that races a settling turn
  cannot kill the next one.
- **Lazy recovery.** `sendTurn` on a thread with no live session starts one from the persisted
  cursor first. A crashed, OOM-killed or restarted session is indistinguishable from a fresh one.
- **Promptless continuation is validated, not assumed.** A `continuation: true` turn with no
  `input` and no attachments against an adapter that does not declare
  `promptlessTurnContinuation` is a validation error, not a silently empty turn.
- **Two-phase rollback.** `assertRollbackSupported` runs after the revert's turn-count
  validation and before anything on disk, in the ref store or in the provider is touched — step 2
  of §5.5.
- **Input bounds — stated here once, referenced everywhere else.** `input` is one flat string,
  trimmed, ≤ 120 000 chars. Attachments ≤ 8, references only
  (`{id, name, mimeType, sizeBytes}`), resolved by the host against the thread's
  attachments dir. Images must match `^image/` and be ≤ 10 MiB (gif/jpeg/png/webp only); files
  ≤ 50 MiB; an unknown third arm is a deliberate forward-compat catch-all so a newer producer
  cannot break an older decoder. Claude gets that dir as an additional allowed directory so
  pasted images need no approval.
- **Composer context is not adapter input.** `@file` references are flattened into `input` and
  persisted beside the user message for re-render only.

*T3: `apps/server/src/provider/Layers/ProviderService.ts:1687-1709` — lazy recovery via `allowRecovery: true`; `:1692-1702` — promptless-continuation validation; `:1748-1766` — cursor persisted after every turn; `apps/server/src/provider/Layers/ClaudeAdapter.ts:2186-2204` — Claude's per-assistant-message cursor refresh; `:5153-5162` — steering reuses the active turn id; `apps/server/src/provider/Layers/GrokAdapter.ts:2044-2066` and `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2562-2574` — settle-pending-then-interrupt; `apps/server/src/provider/Layers/GrokAdapter.ts:2026-2041` and `:2050-2060` — turn-scoped interrupt guard; `packages/contracts/src/orchestration.ts:165-176` — input/attachment/byte/mime bounds; `:367-371` — the three-arm `ChatAttachment` union; `apps/server/src/attachmentStore.ts:120-132` — attachments are id references resolved server-side; `apps/server/src/provider/Layers/ClaudeAdapter.ts:4905-4912` — attachments dir as an additional directory; `packages/contracts/src/composerContext.ts:239-281` — composer context persisted with the message, never sent to the provider; `apps/server/src/provider/Services/ProviderService.ts:109-114` — `assertConversationRollbackSupported` ("reject unsupported rewind before files change")*

Provider snapshot (driver level, one call, not two): `refresh()` produces
`{installed, version, auth: {status, label?, email?}, models[], slashCommands[], skills[],
usageLimits}`. Probes never authenticate and never open a real session. Claude's probe feeds a
never-yielding input generator so the CLI finishes local init without an API call; Grok's sends
`initialize` and no `authenticate`/`session/new`; OpenCode infers login from `GET /provider`'s
connected list, which also lists models. The Claude model list is a static manifest with a remote
refresh, the same pattern as T3's `model-manifest.json`.

*T3: `apps/server/src/provider/Services/ServerProvider.ts:6-25` — `getSnapshot`/`refresh`/`streamChanges`/`applyUsageLimits`; `packages/contracts/src/server.ts:188-238` — the one `ServerProvider` snapshot carrying installed/version/status/auth/models/slashCommands/skills/usageLimits/versionAdvisory; `apps/server/src/provider/Layers/ClaudeProvider.ts:331-400` — never-yielding prompt probe; `apps/server/src/provider/Layers/GrokProvider.ts:342-364` — initialize-only ACP probe; `apps/server/src/provider/Layers/OpenCodeProvider.ts:258-289, 543-567` — models and login from one `GET /provider`; `apps/server/src/provider/ModelManifest.ts:36, 39-43` — bundled manifest plus a 1 h TTL remote refresh*

*Built: two changes. (1) There is **no bundled Claude manifest and no remote refresh**. The model
list comes from the live CLI — `initializationResult().models` on an open session,
`supportedModels()` on the probe — which is free, needs no network of our own and cannot go stale
against the installed binary (`apps/daemon/src/agent-host/adapters/claude/models.ts`).
`ultracode` is re-offered as its own boolean descriptor gated on `xhigh` support, because the
CLI's effort list never names it. (2) The refresh takes an optional account `home`: run without
one the probe answers under the **host** identity, and the account chip, label, email and usage
bars then describe the daemon user's login rather than the thread's account.*

*Built: `refresh()` has a **synchronous sibling, `pendingSnapshot(checkedAt)`**
— the §3.2 layer-one seed. It produces the same `ProviderSnapshot` shape with
no I/O at all: `installed:false`, `version:null`, `status:"unknown"`,
`auth:{status:"unknown"}`, the "… has not been checked in this session yet."
message, and the best catalogue the adapter can name without asking the CLI.
That last part is where T3's bundled manifest survives in this codebase after
change (1) above dropped it as the live source: `FALLBACK_CLAUDE_MODELS` keeps
the model **family aliases** (`default`/`opus`/`sonnet`/`haiku`/`fable`, never
T3's dated slugs, which go stale against the installed binary) purely as the
pre-probe and probe-failed fallback that the live list replaces wholesale.
Grok ships `FALLBACK_GROK_MODELS`; Codex and OpenCode enumerate nothing
statically and answer `[]`. It is a hard rule that a pending snapshot is never
`status:"error"` — §7.7's toast reads `error` with non-authenticated auth as
"sign in again", and a provider nobody has probed has not failed to
authenticate. `adapters/pending.ts` carries both rules and `pending.test.ts`
asserts them across every adapter at once.
*T3: `apps/server/src/provider/Layers/ClaudeProvider.ts:595-640`
(`makePendingClaudeProvider`); `makeManagedServerProvider.ts:69-73`
(`initialSnapshot`).**

The snapshot's sub-shapes are contracts the client binds to, so pin them here:

- `auth`: `{status: "authenticated"|"unauthenticated"|"unknown", type?, label?, email?}`.
- `models[]`: `{slug, name, shortName?, subProvider?, isDefault?, isLegacy?, capabilities}`, where
  `capabilities.optionDescriptors[]` is the **model-selection options schema** — each descriptor
  is `{id, label, description?}` plus either `{type:"select", options: [{id, label, description?,
  isDefault?}], currentValue?}` or `{type:"boolean", currentValue?}`. A `ModelSelection` is
  `{instanceId, model, options?: [{id, value: string|boolean}]}`. The descriptor ids in use:
  Claude `effort`, `thinking`, `fastMode`; Codex `effort` (plain string, not an enum) and
  `serviceTier`; OpenCode `variant` (labelled "Reasoning") and `agent`; Grok `reasoningEffort`
  carried as ACP `_meta`.
- `slashCommands[]`: `{name, description?, input?: {hint}}`.
- `skills[]`: `{name, description?, path, scope?, enabled, displayName?, shortDescription?,
  userInvocationOnly?, userInvocable?}`. The last two are inverse flags: `userInvocationOnly`
  means the composer must offer it under `/`; `userInvocable: false` means it must not.
- `usageLimits`: `{checkedAt, windows: [{id, kind: "session"|"weekly"|"monthly"|"other", label,
  usedPercent, resetsAt?, windowDurationMins?}], unavailable?: {reason:
  "unsupported"|"probeFailed"}}`. `id` is stable per provider so a sparse turn-driven
  `account.rate-limits.updated` lands on the same row the probe produced; `unsupported`
  (API key, no subscription) clears the bars, `probeFailed` keeps the last good ones.
- `versionAdvisory`: `{status: "unknown"|"current"|"behind_latest", currentVersion, latestVersion,
  updateCommand, canUpdate, checkedAt, message}`. Per-provider minimums the adapters enforce:
  OpenCode refuses a server below **1.14.19**; Claude gates each catalogue model on a
  `minVersion`/`maxVersionExclusive` range checked against `claude --version` and explains the
  gap rather than hiding the model.

*T3: `packages/contracts/src/server.ts:61-67` — auth; `:69-82` — model; `:88-93` — slash command; `:95-116` — skill incl. `userInvocationOnly`/`userInvocable`; `:118-123` — per-cwd workspace snapshot; `:158-166` — version advisory; `packages/contracts/src/model.ts:7-53, 90-94, 125-128` — option descriptors and selections; `packages/contracts/src/providerUsageLimits.ts:20-27, 49-61, 69-72` — usage windows, `unavailable`, and the sparse merge-by-`id` update; `apps/server/src/provider/opencodeRuntime.ts:42, 161-176` — `MINIMUM_OPENCODE_VERSION`; `apps/server/src/provider/ClaudeModelCatalog.ts:150-185` — model version gating and its message*

*Built: with the Claude catalogue coming from the live CLI there is no per-model version window
left to explain — a model the installed CLI does not support is simply not listed. The "explain
the gap rather than hide the model" rule therefore survives only on the **whole-CLI** gate
(`apps/daemon/src/agent-host/orchestration/version-gate.ts`).*

Slash commands and skills are additionally **per-cwd** for Claude, Grok and OpenCode: the
snapshot carries a narrower `workspaceSnapshots[{cwd, checkedAt, slashCommands, skills}]`
refreshed for the project a chat tab belongs to, rather than re-running the whole probe.

*T3: `packages/contracts/src/server.ts:118-123, 233` — `ServerProviderWorkspaceSnapshot`; `apps/server/src/provider/Services/ProviderRegistry.ts:51-54` — `refreshWorkspaceSnapshot`; `apps/server/src/provider/ProviderDriver.ts:75` — `snapshotForCwd`*

### 4.2 Runtime event union

Closed union at the adapter boundary. Every event carries `{eventId, threadId, createdAt,
turnId?, itemId?, requestId?, agentId?, providerRefs?, raw?}`. `providerRefs` is
`{providerTurnId?, providerItemId?, providerRequestId?}` — the native ids, kept beside ours so a
captured log can be correlated with the CLI's own. `raw` is `{source, method?, messageType?,
payload}` with `source` a closed enum naming the native protocol (`claude.sdk.message`,
`claude.sdk.permission`, `codex.app-server.notification`, `codex.app-server.request`,
`opencode.sdk.event`, `acp.jsonrpc`, `acp.<vendor>.extension`); that field is what makes
`raw.ndjson` (§3.1) replayable into the normaliser in a test. An unmapped provider message is a
typecheck error (`satisfies never` in each adapter's switch) and emits `runtime.warning` at
runtime.

*T3: `packages/contracts/src/providerRuntime.ts:202-216` — event base; `:44-51` — `ProviderRefs`; `:23-42` — `RuntimeEventRaw` and the closed `RuntimeEventRawSource`; `apps/server/src/provider/Layers/ClaudeAdapter.ts:3997-4010` and `:4185-4195` — the two `satisfies never` guards with a `runtime.warning` fallback*

| Group | Events | Notes |
|---|---|---|
| Session | `session.started {resume?}`, `session.state.changed {state: starting\|ready\|running\|stopped\|error, reason?, detail?}`, `session.exited {reason?, recoverable, exitKind: graceful\|error}` | `waiting` is derived from an unresolved request, never emitted; `recoverable` decides whether the next `/turn` may resume from the persisted cursor or the thread must surface the error — nothing is ever respawned by a supervisor (§3.1) |
| Thread | `thread.started {providerThreadId}`, `thread.state.changed {state: active\|idle\|archived\|closed\|compacted\|error, beforeTokens?, afterTokens?}`, `thread.metadata.updated {name?}`, `thread.token-usage.updated {usage: {usedTokens, maxTokens?, autoCompactAtTokens?, totalProcessedTokens?}}` | token usage drives the context meter; without `maxTokens` there is no ring (§7.6) |
| Turn | `turn.started {model?, effort?}`, `turn.completed {state: completed\|failed\|interrupted\|cancelled, stopReason?, tokenUsage?, totalCostUsd?, errorMessage?}`, `turn.aborted {reason, tokenUsage?}`, `turn.plan.updated {explanation?, plan: [{step, status: pending\|inProgress\|completed}]}`, `turn.proposed.delta {delta}`, `turn.proposed.completed {planMarkdown}`, `turn.diff.updated {unifiedDiff}` | `tokenUsage.usageStatus: complete\|partial\|unavailable`, `hasSubagents` mandatory |
| Items | `item.started/updated/completed {itemType, status: inProgress\|completed\|failed\|declined, title?, detail?, data?, agentId?, parentToolUseId?}` | `itemType` closed: `user_message, assistant_message, reasoning, plan, command_execution, file_change, mcp_tool_call, dynamic_tool_call, collab_agent_tool_call, web_search, image_view, review_entered, review_exited, context_compaction, error, unknown`; only the seven tool-lifecycle types, `command_execution` through `image_view`, become activity rows (§5.1), so the two review types are classified and then dropped |
| Content | `content.delta {streamKind, delta, contentIndex?, summaryIndex?}` | `streamKind: assistant_text\|reasoning_text\|reasoning_summary_text\|plan_text\|command_output\|file_change_output\|unknown`; Claude emits summaries only |
| Requests | `request.opened {requestType, dismissible, detail?, appName?, options?: [{decision, label, warning?}], args?}`, `request.resolved {requestType, decision?, resolution?}` | 11 request types; when `options` is absent the UI shows the default set of §4.3; `dismissible` is false for every native-callback approval |
| Questions | `user-input.requested {questions: [{id, header, question, options: [{label, description, value?}], allowCustomAnswer?, multiSelect?}], responseMode?, dismissible}`, `user-input.resolved {answers}` | `multiSelect` defaults to `false`; `dismissible` is `responseMode === "message"` and is what gates `/dismiss` (§6.2) |
| Tasks | `task.started/progress/updated/completed {taskId, agentKind: agent\|background, agentId, description, title?, model?, effort?, lastToolName?, status?, usage?, parentAgentId?, toolUseId?, outputFile?}` | linkage repeated on every row; `status` on `task.progress` / `task.updated` is T3's eight-value `RuntimeTaskStatus` — `pending\|running\|waiting\|idle\|completed\|failed\|cancelled\|interrupted` — and `task.completed` narrows it to `completed\|failed\|stopped`; the roster (§7.6) folds `stopped` to `interrupted` and uses those eight names and no other |
| Tools | `tool.progress {toolUseId, toolName?, summary?, elapsedSeconds?, taskId?}`, `tool.denied {toolName, toolUseId?, reason?, agentId?}` | `tool.denied` is a policy/hook deny with no user approval behind it |
| Hooks | `hook.started/progress/completed {hookId, hookName, hookEvent, outcome: success\|error\|cancelled, stdout?, stderr?, exitCode?}` | Claude only, rendered inside the activity group |
| Account | `auth.status {isAuthenticating?, output?, error?}`, `account.rate-limits.updated {windows}`, `model.rerouted {fromModel, toModel, reason}` | rate limits merge into the usage overview by window id |
| Runtime | `runtime.warning {message, detail?}`, `runtime.error {message, class: provider_error\|transport_error\|permission_error\|validation_error\|unknown}` | `class` decides retry vs surface vs re-auth |

*T3 schema: `packages/contracts/src/providerRuntime.ts:1177-1228` — the 49-member union; payloads at `:219-222` (session.started), `:230-234` + enum `:54-61` (session.state.changed), `:237-241` (session.exited), `:244-246` (thread.started), `:249-254` + enum `:64-72` (thread.state.changed), `:257-260` (thread.metadata.updated), `:263-285` (thread.token-usage.updated), `:313-316` (turn.started), `:325-346` (TurnTokenUsage) + `:348-356` (turn.completed), `:359-362` (turn.aborted), `:365-375` + `:77` (turn.plan.updated), `:377-385` (turn.proposed.*), `:387-390` (turn.diff.updated), `:432-449` + `:80` + `:123-135` (item lifecycle, status, CanonicalItemType), `:451-456` + `:83-92` (content.delta), `:459-472` + `:137-150` (request.*, CanonicalRequestType), `:482-502` (user-input.*), `:561-572` (classifyTaskAgentKind) + `:580-618` (task linkage) + `:623-682` + `:630-640` (task.*, RuntimeTaskStatus), `:682-704` (hook.*), `:707-715` (tool.progress), `:796-801` (tool.denied), `:724-728` (auth.status), `:740-742` + `packages/contracts/src/providerUsageLimits.ts:20-27, 69-72` (account.rate-limits.updated), `:757-761` (model.rerouted), `:804-814` + `:97-104` (runtime.warning/error).*
*T3 emit sites: Claude `apps/server/src/provider/Layers/ClaudeAdapter.ts:2555` (token usage), `:2660-2853` (turn.completed), `:2912-2964` (assistant_text), `:1725-1731` (reasoning_summary_text), `:3170-3331` (tool results → command_output/file_change_output), `:3620-3706` (session/thread state, hooks), `:3707-3873` (tasks), `:4081-4142` (rate limits), `:4145-4198` (the demux switch). Codex `apps/server/src/provider/Layers/CodexAdapter.ts:1304-2223` (notification → event mapping), `:1589` (token usage), `:1664-1672` (turn.diff.updated), `:1721, 1769` (turn.proposed.*), `:633-663` (item classification). OpenCode `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2294-2660` (the SSE switch: `session.updated`, `session.compacted`, `message.updated`, `message.part.delta/updated/removed`, `permission.asked/replied`, `question.asked/replied/rejected`, `todo.updated` → `turn.plan.updated`, `session.status`, `session.error`). Grok `apps/server/src/provider/acp/AcpRuntimeModel.ts:795-884` (`session/update` variants) and `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:37-50, 137` (normalised → runtime events).*

*Built: three corrections the real CLIs forced. (1) `RuntimeSessionState` still has no `waiting`
arm and the UI still derives `waiting` from an open request — but Codex **does** emit
`thread/status/changed.activeFlags: ["waitingOnApproval"]`, so an adapter must tolerate the flag
rather than report it as an unmapped frame
(`apps/daemon/src/agent-host/adapters/codex/normalise.ts`). (2) The `hook.*` group has **no
producer**: Claude's filesystem hooks run, but the SDK stream carries no `hook_*` messages at all,
so nothing in the timeline is fed by that group on any provider. (3) `RuntimeEventRawSource`
gained one member the adapters mint themselves, `HISTORICAL_RAW_SOURCE` (`"history.replay"`),
which tags every event projected out of a provider's **native history** so nothing downstream
mistakes a replayed row for live traffic and no historical turn claims token usage
(`packages/api/src/agent-chat/runtime-events.ts`).*

Task rows repeat their whole linkage block on **every** row, not just `task.started`, so a client
fold can rebuild an agent whose start row aged out. `agentKind` is stamped by the host at
ingestion (not trusted from the provider) with the rule: a task launched from inside a subagent
is background work unless it is itself agent-flavoured. `task.updated` is a non-terminal status
patch (`killed`→`cancelled`, `paused`→`idle` normalised at the adapter); `task.completed`
narrows to `completed|failed|stopped`.

*T3: `packages/contracts/src/providerRuntime.ts:574-618` — "repeated on progress and terminal rows … so client folds can reconstruct an agent"; `:552-572` — `classifyTaskAgentKind`; `:656-669` — the `task.updated` normalisation note; `:672-679` — `task.completed`*

*Built: no CLI actually repeats the linkage. Claude's `task_updated` carries `{task_id, patch}` and
nothing else, so the **adapter** carries each task's identity forward and re-stamps the whole
bundle on every `task.*` runtime event it emits
(`apps/daemon/src/agent-host/adapters/claude/normalize.ts`). The rule above is therefore a contract
the adapters honour rather than an observation about the providers — which is exactly what lets the
fold keep relying on it. The Claude tools that drive it are `TaskCreate` / `TaskUpdate` (decimal
string ids) and `Agent`, **not** `TodoWrite` and `Task`: a fold keyed on the old names produces
nothing.*

Deliberately excluded: `thread.realtime.*`, `mcp.status.updated`, `tool.summary`,
`config.warning`, `deprecation.notice`, `account.updated`, `mcp.oauth.completed`,
`files.persisted`.

*T3: `packages/contracts/src/providerRuntime.ts:288-310` (Codex voice mode), `:718-721`, `:731-733`, `:745-754`, `:764-775`, `:778-793` — all present in T3's union; `mcp.status.updated` has zero emitters server-wide*

The two review item types are **not** excluded. They stay in the closed enum exactly as in T3,
because the Codex item classifier needs somewhere to put them; they never become a timeline row,
and nothing starts a review (§2).

*T3: `packages/contracts/src/providerRuntime.ts:106-135` — `TOOL_LIFECYCLE_ITEM_TYPES` and `CanonicalItemType`, the latter with `review_entered` / `review_exited`; `apps/server/src/provider/Layers/CodexAdapter.ts:658-659` — the classifier; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:909-1010` — only tool-lifecycle item types become activities*

### 4.3 Approval decisions and defaults

`ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"`.
`cancel` is issued by both sides: by the user, as one of the default buttons below, and by the
host, which uses it to settle every request still open when a turn is interrupted or a session
stops (§4.1). Options are advertised **per request** as `{decision, label, warning?}`
— the provider's own wording is what the user sees, and `warning` is a provider-supplied caution
such as a prompt-injection notice. The request type is one of eleven canonical values
(`command_execution_approval`, `file_read_approval`, `file_change_approval`,
`apply_patch_approval`, `exec_command_approval`, `mcp_elicitation_approval`,
`permission_approval`, `tool_user_input`, `dynamic_tool_call`, `auth_tokens_refresh`,
`unknown`); there is no dedicated plan-exit kind — Claude's `ExitPlanMode` arrives as
`permission_approval`.

*T3: `packages/contracts/src/orchestration.ts:147-154` — the five decisions; `:155-161` — `ProviderApprovalOption` with the `warning` comment; `packages/contracts/src/providerRuntime.ts:137-150` — `CanonicalRequestType`; `:459-465` — `options` on `request.opened`*

When a provider advertises no options (Grok), the UI offers T3's default set of four — Cancel,
Decline, Always allow this session, Approve — and the Grok adapter emulates session-scoped grants
by hashing
`{kind, title, command, input, locations}` with a Bash `description` field stripped, and no key
when there is neither a command nor input. Codex downgrades `acceptAlways` to `acceptForSession`
on command and file approvals. Decline and Cancel are two answers, not two labels for one: a
provider that distinguishes them is told which, and the agent reads a decline as "do it another
way" and a cancel as "stop this".

*T3: `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx:23-28` — `DEFAULT_APPROVAL_OPTIONS`, all four user-visible; `apps/server/src/provider/Layers/ClaudeAdapter.ts:4817-4823` — the same deny carrying "User cancelled…" versus "User declined…"; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:397-402` — Codex's own elicitation options also lead with Cancel and Decline*

*Built: both halves of this paragraph moved. (1) Codex downgrades `acceptAlways` to
`acceptForSession` only when the server proposed nothing better: a command approval that carries a
proposed execpolicy amendment is answered
`{acceptWithExecpolicyAmendment: {execpolicy_amendment}}`, which is what "always allow" actually
means on that CLI, while the file-change enum has no amendment arm and always downgrades
(`apps/daemon/src/agent-host/adapters/codex/decisions.ts`). (2) Grok **does** advertise options —
`allow_always` arrives as `options[0]` on a real `session/request_permission` — so `acceptAlways`
maps onto it instead of being emulated by a local operation hash, and nothing ever treats
`options[0]` as a default. Grok asks for permission **at all** only when
`[features] support_permission = true` reaches the CLI; without it the agent self-resolves every
approval and `session/request_permission` never fires. 4.5 Grok says how the host guarantees that
setting without touching the user's config.*

The full per-provider decision mapping:

| Decision | Claude | Codex | OpenCode | Grok |
|---|---|---|---|---|
| `accept` | `{behavior:"allow", updatedInput}` | `{decision:"accept"}` | reply `once` | option with `kind: allow_once` |
| `acceptForSession` | allow **+** `updatedPermissions` rescoped `destination:"session"`; falls back to `{type:"addRules", rules:[{toolName}], behavior:"allow", destination:"session"}` when the SDK offers no suggestion | `{decision:"acceptForSession"}`; `item/permissions/requestApproval` additionally answers `scope:"session"` | reply `always` — labelled "Allow for workspace" **with a warning that it applies to other sessions in the same workspace** | `allow_always` when advertised, else the `allow_once` option id plus the local operation hash |
| `acceptAlways` | **deny** (Claude has no permanent grant through `canUseTool`) | normalised down to `acceptForSession` | reply `always` | falls through to `reject_once` — never surfaced, since Grok advertises no options |
| `decline` | `{behavior:"deny", message:"User declined tool execution."}` | `{decision:"decline"}` | reply `reject` | option with `kind: reject_once` |
| `cancel` | `{behavior:"deny", message:"User cancelled tool execution."}` | `{decision:"cancel"}` | reply `reject` | ACP `{outcome:{outcome:"cancelled"}}` |

*T3: Claude `apps/server/src/provider/Layers/ClaudeAdapter.ts:4802-4823` (decision mapping, `acceptAlways` falls to deny) and `:312-331` (`toSessionPermissionUpdates` rewriting every `destination` to `"session"` because the SDK's own suggestions target `.claude/settings.local.json`); Codex `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2107, 2165` (downgrade) and `:2287-2294` (`scope:"session"`); OpenCode `apps/server/src/provider/opencodeRuntime.ts:547-560` (`toOpenCodePermissionReply`) and `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1764-1772` (the workspace warning); Grok `apps/server/src/provider/Layers/GrokAdapter.ts:289-313` (`selectGrokPermissionOptionId`, the `allow_always`→`allow_once` fallback, `acceptAlways`→`reject_once`), `:1152-1166` (the `stableStringify` key with Bash `description` stripped and "no key at all" when there is neither a command nor a non-empty input), `:1187-1203` (no `approvalOptions` passed into `request.opened`)*

In `full-access`, Claude's `canUseTool` short-circuits to allow with **no event at all** — nothing
is written to the timeline. OpenCode instead auto-answers each ask **`once`, never `always`**,
because OpenCode stores `always` grants per directory and two upstream paths (doom-loop detection
and subagent sessions) ignore the session ruleset, so an `always` from a full-access thread would
silently widen a supervised thread in the same workspace.

*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4704-4711`; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1777-1804`*

Questions carry attachments at the route layer only: `attachmentsByQuestionId` (≤ 8 per question)
is folded into the answer text by the host before `respondToUserInput`, which takes bare
`answers`. The payload persisted beside the answer also carries `questionTextById` so an answered
card renders without the original request.

*T3: `packages/contracts/src/provider.ts:110-116` — `attachmentsByQuestionId` on the service input; `apps/server/src/provider/Services/ProviderAdapter.ts:105-112` — the adapter takes only `answers`; `packages/contracts/src/orchestration.ts:374-388` — `UserInputAttachments` (≤ 8/question) and `UserInputAttachmentAnswerPayload.questionTextById`*

### 4.4 Permission modes

`RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access"`, default
`full-access`. Mapped at launch:

| Mode | Claude | Codex | OpenCode | Grok |
|---|---|---|---|---|
| Supervised | default; every tool through `canUseTool` | `approvalPolicy: untrusted`, `sandbox: read-only`, reviewer `user` | ruleset `*`→ask, reads allow except `.env` | `--permission-mode default` |
| Accept edits | `permissionMode: acceptEdits` | `on-request`, `workspace-write`, `user` | same, `edit`→allow | `--permission-mode acceptEdits` |
| Auto | `permissionMode: auto` | `on-request`, `workspace-write`, reviewer `auto_review` | falls back to Supervised | `--permission-mode auto` |
| Full access | `bypassPermissions` + `allowDangerouslySkipPermissions`; `canUseTool` short-circuits | `never`, `danger-full-access`, reviewer `user` | `*`→allow, `external_directory`→allow | `--always-approve` |

*T3: `packages/contracts/src/orchestration.ts:128-135` — the four modes (T3's `DEFAULT_RUNTIME_MODE` is `full-access`, `:135`, and so is Orquester's). Claude `apps/server/src/provider/Layers/ClaudeAdapter.ts:4878-4882` (the map — note `approval-required` is deliberately **absent**, so `permissionMode` stays undefined and gating is entirely `canUseTool`), `:4939-4942` (`allowDangerouslySkipPermissions` iff `bypassPermissions`), `:4704-4711` (full-access short-circuit). Codex `apps/server/src/provider/Layers/CodexSessionRuntime.ts:509-542` (`runtimeModeToThreadConfig`, all three axes) and `:562-580` (a **second, per-turn** sandbox policy with a different spelling: `readOnly`/`workspaceWrite`/`dangerFullAccess`). OpenCode `apps/server/src/provider/opencodeRuntime.ts:508-545` (`buildOpenCodePermissionRules`). Grok `apps/server/src/provider/acp/GrokAcpSupport.ts:33-46` (`grokAcpSpawnArgs`).*

*Built: the default was `approval-required` through the build and was changed to `full-access`
on the owner's instruction after landing: every terminal launcher in the catalog already ran with
`--dangerously-skip-permissions` / `--yolo`, so a chat tab that opened supervised was a regression
from the tab it replaced. The per-agent chip memory (`runtimeModeByAgent`) still narrows it.*

*Built: the Grok argv is as written — `--permission-mode` is a global option and precedes `agent`,
`--always-approve` belongs to `agent` and follows it — but `acceptEdits` is a **no-op** for the ACP
edit gate. Measured against a real file write: `default` asks, `auto` does not,
`agent --always-approve` does not, and `acceptEdits` still asks. The flag is still sent (it is what
the CLI documents and a later release may honour) and the mode's promise is kept by the adapter
answering edit-flavoured approvals itself (`autoApprovesEdits` in
`apps/daemon/src/agent-host/adapters/grok/launch.ts`). Without that compensation the mode would be
a label for nothing.*

Two structural consequences. First, **a RuntimeMode change restarts the session** (§3.4) because
every provider expresses the mode as launch configuration: Claude's `canUseTool` closes over the
start-time mode, Codex sends it on `thread/start`, Grok in argv. OpenCode is the one that could
re-assert its ruleset live (a plain `PATCH /session/{id}`, no restart) but has no in-session
mutate path in the adapter, so it lands at the next `startSession` like the others. Second,
Codex's `approvalsReviewer` is **always sent explicitly**, including on resume: omitting it keeps
the thread's previous reviewer and leaves `auto_review` sticky after a mode switch.

*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4704-4705`; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2901-2947` — ruleset re-asserted on create, resume-in-place, cwd fork and rollback fork; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:511-514` — the explicit-reviewer comment; `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:752-818` — the restart decision lives in orchestration, not the adapter*

OpenCode's ruleset is a rule **list**, not an `edit/bash/webfetch` map. In full access it is
`[{*,*,allow},{external_directory,*,allow}]`; otherwise base `{*,*,ask}` plus `read` allow with
`*.env` / `*.env.*` back to ask (`*.env.example` allow), `glob`/`grep`/`lsp`/`skill`/`todowrite`/
`question` allow, `bash`/`webfetch`/`websearch`/`codesearch`/`external_directory`/`doom_loop` ask,
and `edit` allow **only** for `auto-accept-edits`. `"auto"` keeps asking by deliberate choice, not
by omission — the documented rule is that providers without an AI reviewer fall back to
Supervised.

*T3: `apps/server/src/provider/opencodeRuntime.ts:508-545`, with the in-source rationale for `auto` at `:516-519`*

Plan mode is per turn: Claude `setPermissionMode("plan")` with `ExitPlanMode` always denied;
Codex `collaborationMode: {mode: "plan"}` per turn (note: does not tighten the sandbox);
OpenCode `agent: "plan"` (no proposal event); Grok none. The toggle is shown only where
`showPlanModeToggle` is true.

*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5187-5201` (per-turn `setPermissionMode`), `:4683-4703` (`ExitPlanMode` captured then always denied); `apps/server/src/provider/Layers/CodexSessionRuntime.ts:583-606` (`collaborationMode` carries its own model, `reasoning_effort` and `developer_instructions`) with the sandbox untouched at `:611-666`; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3207`; `apps/server/src/provider/Layers/ClaudeProvider.ts:57`, `apps/server/src/provider/Layers/CodexProvider.ts:68`, `apps/server/src/provider/Layers/OpenCodeProvider.ts:34`, `apps/server/src/provider/Layers/GrokProvider.ts:51` — the four `showInteractionModeToggle` values*

*Built: Codex's `collaborationMode` is **sticky thread state**, not a per-turn field — leaving plan
mode requires an explicit `{mode:"default"}` — so the adapter sends the collaboration mode on
**every** turn including the default one, alongside `developer_instructions: null`
(`apps/daemon/src/agent-host/adapters/codex/modes.ts`). And Grok's plan mode is **declared**, not
inferred: the CLI marks the tool with `_meta["x.ai/tool"].kind`, which makes §4.5's `plan.md` path
matcher a fallback rather than the primary detector
(`apps/daemon/src/agent-host/adapters/grok/plan.ts`).*

### 4.5 Per-provider must-knows

This is the implementation reference; the audit (`t3-5-adapter-audit.md` §D) adds the rest.

#### Claude

- **Launch.** SDK `query()` with streaming input kept open across turns; one `query` per thread.
  The `Options` object sets exactly: `cwd`; `model` (catalogue slug **plus manifest suffix**, e.g.
  `claude-opus-5[1m]` for the 1M window); `pathToClaudeCodeExecutable` (resolved once per
  adapter); `systemPrompt: {type:"preset", preset:"claude_code", append: <runtime instructions>}`
  — model and effort are deliberately left out of the append because they change per turn;
  `settingSources: ["user","project","local"]`; `effort` normalised through the manifest's
  `effortMap`; `thinking: {type:"adaptive", display:"summarized"}` when summaries are wanted;
  `permissionMode`; `allowDangerouslySkipPermissions` iff `bypassPermissions`; `settings`
  (`alwaysThinkingEnabled`, `showThinkingSummaries`, `fastMode`, `ultracode`, `autoCompactWindow`);
  `resume` (cursor uuid) **or** `sessionId` (a freshly generated v4 uuid); `includePartialMessages:
  true` always; `canUseTool`; `onUserDialog` + `supportedDialogKinds: ["resume_return"]`, which
  turns the CLI's "this resume is old, compact?" dialog into an `AskUserQuestion`; `env`;
  `additionalDirectories` (`[cwd?, attachmentsDir]`); `extraArgs` parsed from the user's launch
  args **minus** `permission-mode` and `dangerously-skip-permissions`, which are folded into
  `permissionMode` so argv order cannot lose. **Never set:** `hooks`, `allowedTools`,
  `disallowedTools`, `maxTurns`, `fallbackModel`, `agents`, `stderr`, `abortController`,
  `executable`, `strictMcpConfig`, `maxThinkingTokens`. There are no SDK hooks — the `hook.*`
  events are the *user's own* configured hooks reported back as `system` messages.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4913-4965` — the whole options object; `:4834-4838` — the extraArgs strip; `:4886-4891` — the folded permission mode; `:4892-4900` — `settings`; `:4905-4912` — `additionalDirectories`; `apps/server/src/provider/ClaudeModelCatalog.ts:233-250` — the model-id suffix; `:4993-4998` — `query({prompt, options})`*
  *Built: `stderr` **is** set, although the list above forbids it. §3.1 requires every child's
  stderr to be captured, classified and redacted, and the SDK callback is the only access to it —
  the §3.1 requirement wins over the §4.5 list. The list is kept verbatim in
  `CLAUDE_NEVER_SET_OPTIONS` with the one exception named separately in
  `CLAUDE_SESSION_ALLOWED_DESPITE_SPEC` (`apps/daemon/src/agent-host/adapters/claude/launch.ts`),
  so the divergence is a constant a reader trips over rather than a silent edit. `settingSources`
  is as written; the committed fixtures were captured with `["project","local"]` only, because this
  host's user-level settings carry a hook that perturbs the capture.*
- **Env is one variable.** `CLAUDE_CONFIG_DIR` only, on top of the base env; `HOME` is **never**
  overridden, because relocating `HOME` also relocates the macOS keychain lookup and the CLI then
  reports "Not logged in". Orquester's managed-account home is therefore bound through
  `CLAUDE_CONFIG_DIR`, matching §3.1.
  *T3: `apps/server/src/provider/Drivers/ClaudeHome.ts:36-54`*
- **Prompt feeding is a long-lived streaming input.** One unbounded queue per session becomes the
  SDK prompt via `Stream.fromQueue → filter → map → toAsyncIterable`; `sendTurn` only offers onto
  that queue and `query()` is never re-made per turn. Each turn's `SDKUserMessage` is stamped
  `uuid: turnId`, so the native transcript id equals our turn id — the whole basis of rollback.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4428-4436` (queue → prompt), `:5271-5278` (offer + uuid stamp)*
- **Content-block order is load-bearing.** Optional leading text (skill dispatch) → base64 image
  blocks → the final text block **last**. The CLI only reads a streamed user message as a
  slash-command invocation when the last block is text; leading with the text made every
  image-carrying turn drop a hand-typed `/command` back to plain prose.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:1660-1676`*
  *Built: **a non-image attachment reaches Claude as a path line, not as nothing.** T3 injects
  every attachment's on-disk path into the prompt text before the adapter sees the turn
  (`t3-1-providers.md:282-292`); that step was never ported, and the adapter's `continue` past a
  `file` ref dropped it silently behind a comment that assumed it. `appendAttachmentPathLines`
  (`agent-host/adapters/attachment-lines.ts`) appends `Attached files:\n- <name>: <path>` for the
  refs the adapter does not ingest natively, skipping a path the text already names (the composer
  inserts it, §7.4) — judged against the whole prompt under a skill dispatch (`namedIn`), so a
  path typed after the `$skill` mention counts as named — as a suffix of the final text block, or
  of the leading text block when a skill dispatch owns the last one, so the command block stays
  last and untouched. The path is readable without an approval because the attachments dir is an
  `additionalDirectories` entry (`claude/session.ts`, the grant in `claude/launch.ts`). On resume
  from native history the replayed user row has the block stripped again
  (`stripAttachmentPathLines`), so the bubble shows what the user typed. A block that is the whole
  message is kept as the turn's only evidence — except the block-only leading text block of a skill
  dispatch, which is dropped when the command block carries the text (`project-history.ts`).*
- **`canUseTool` is the whole approval surface.** `AskUserQuestion` is intercepted **before** any
  approval logic and becomes `user-input.requested`; the question `id` **must equal the full
  question text**, because the SDK ≥ 2.1.121 looks answers up by text, and the reply is
  `{behavior:"allow", updatedInput:{questions:<original>, answers:{<questionText>: <label>}}}`.
  `ExitPlanMode` emits `turn.proposed.completed` and then **always denies**, with a fixed message
  telling the model to stop and wait — plan mode is a client-owned card, never the SDK's gate.
  `full-access` short-circuits to allow with no event.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4663-4824` (the callback), `:4463-4471` (the id-is-the-text rule and its issue link), `:4584-4590` (the answer shape), `:4683-4703` (ExitPlanMode), `:4704-4711` (full access)*
  *Built: `canUseTool` is **not** the whole approval surface. The CLI gates first, and silently:
  `echo hi`, `ls` and `Read` never reach the callback, and a `sleep 120 && …` was denied by the CLI
  itself with a `<tool_use_error>` tool result nobody authorised. In `acceptEdits` **and**
  `bypassPermissions` the callback is never called at all, even for `rm -f`; only
  `approval-required` ever produces an approval card. The timeline therefore renders a tool result
  that is a CLI denial as a denial — tone `error`, "denied by the CLI" — even though no
  `request.*` event exists for it (`apps/daemon/src/agent-host/adapters/claude/classify.ts`,
  `…/normalize.ts`). Two more shapes the callback forced: options carry a `requestId` that
  **must** key the pending-approvals map, because the SDK redelivers a request on reinitialize; and
  `ExitPlanMode` carries a `planFilePath`, which rides an additive optional field of the same name
  on `turn.proposed.completed` rather than being smuggled into `planMarkdown` — the path lives
  under `CLAUDE_CONFIG_DIR`, outside `fsRoot`, so it is a label and never a link.*
- **Model and plan switch live, mode does not.** `query.setModel(apiModelId)` on a changed model
  (also refreshing the per-turn effort), `query.setPermissionMode("plan")` / back to the session's
  base mode per turn. A RuntimeMode change restarts (§4.4).
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5164-5184` (setModel + effort), `:5186-5201` (setPermissionMode)*
- **Interrupt is a process kill**, not `query.interrupt()` — `interrupt()` can acknowledge while
  resumed background tasks keep the CLI alive, so Stop closes the query and lets the SDK escalate
  to SIGKILL. Teardown cancels every pending approval with `cancel`, cancels pending user-inputs,
  emits `task.completed {status:"stopped"}` for live tasks, and completes the turn as
  `interrupted`. For Claude, Stop and interrupt are the same operation and the next turn needs
  lazy recovery from the cursor.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5289-5297` (with the in-source reason), `:4262-4369` (teardown)*
  *Built: Stop is `query.interrupt()` **first** and a process kill second, not the process kill this
  paragraph prescribes. The `interrupt_receipt_v1` receipt is the fact the rationale above lacked:
  an empty `still_queued` means the CLI took the interrupt, so the host waits for the turn to
  settle and **keeps the session** (no CLI reboot per Stop); a non-empty receipt, an RPC failure or
  a turn that does not settle closes the query exactly as written here. A **session-scoped** Stop
  (no `turnId`, §6.2) always closes the query, because that is the only reach to the CLI's own
  background work (`apps/daemon/src/agent-host/adapters/claude/session.ts`). Related invariant the
  SDK imposes: breaking out of `for await (… of query)` closes the query and kills the session, so
  the adapter never does.*
- **Rollback is a native fork with a hard failure mode.** Rolling back *every* turn short-circuits
  to a fresh session rather than a fork. Otherwise: read native history through the SDK's
  `getSessionMessages` — run **in a child process** when `CLAUDE_CONFIG_DIR` differs from the
  host's, because the SDK helpers read `process.env` — find human-turn starts from the stamped
  uuids, `forkSession(sessionId, {upToMessageId})`, then re-read the fork and re-align turn
  boundaries: the fork **rewrites every uuid**, so retained messages are matched from the
  truncated end and every one must match on **deep-equal body and role** (role-only matching once
  mistook restored steering messages for turn starts). Any mismatch, any missing boundary, or a
  compaction in between is a hard error telling the user to start a new thread — refuse rather
  than guess.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5306-5486` (rollback), `:5316-5327` (full-rollback restart path), `:5337-5393` (the child-process history worker and its reason), `:180-225` (`remapClaudeForkTurnBoundaries`), `:5422-5433, 5453-5468` (the hard failures)*
  *Built: as written, with one observation that makes it load-bearing — a resume replays **nothing**
  onto the message stream (`replayUuids: []`), so `readThread` and rollback genuinely have to read
  the native history out-of-band, and a resumed thread renders from that projection tagged
  `HISTORICAL_RAW_SOURCE` (§4.2). Two more frame shapes the history and demux paths must survive:
  `user.message.content` is sometimes a plain **string** (post-compaction frames), so `content.map`
  throws on a long thread; and `command_lifecycle` is a top-level message type absent from the
  SDK's exported union. `system/init` is emitted once **per turn**, not once per session.*
- **Steering.** A `sendTurn` during a live turn reuses the turn id; a stale *synthetic* turn
  (auto-opened by background assistant output between prompts) is auto-closed first so it cannot
  block the user's next turn.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5153-5162`*
- **Compaction** is the slash command `/compact`, sent as an ordinary turn and awaited to a
  terminal turn state (§4.1's `compaction` capability). `thread.state.changed {compacted,
  beforeTokens, afterTokens}` comes from the SDK's `compact_boundary` system message.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5573`; `:3620-3669`; `apps/server/src/provider/Layers/ProviderService.ts:1883-1904` — slash-command compaction is literally a `sendTurn`*
- **Token usage** comes from the `result` message: `thread.token-usage.updated` for the context
  meter plus `turn.completed.tokenUsage`, `complete` when input and output totals are both
  present, `partial` otherwise, `unavailable` when the turn produced none.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:2555` (thread usage), `:820, 855, 878, 885` (the three `usageStatus` arms), `:3483-3504` (`result` → usage + turn.completed)*
  *Built: as written. Two result shapes to tolerate: `result.subtype: "success"` can carry
  `is_error: true` with an `api_error_status`, and `terminal_reason` is absent on a compaction
  result. An interrupt yields `aborted_streaming`.*
- **Probe.** Auth, slash commands and usage all come from **one** never-yielding `query()`: the
  prompt async-generator never yields, so the CLI finishes local init IPC and never calls the API;
  then `await q.initializationResult()` gives `account.{email, subscriptionType, tokenSource,
  apiProvider}` and `commands`, and
  `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` gives the windows. 25 s for
  init, a separate deadline for usage so a slow optional call cannot discard the init, then abort.
  Cached 5 min keyed on `binaryPath\0configDir\0cwd`. The probe's options matter as much as the
  generator: `persistSession: false`, `settings: {disableAllHooks: true}` (it fires every few
  minutes; `SessionStart` hooks would run on every health check), `allowedTools: []`,
  `mcpServers: {}` + `strictMcpConfig: true`, `stderr: () => {}`, an `abortController`, and env
  disabling claude.ai MCP discovery and IDE auto-connect. Install/version is a plain `--version`
  spawn.
  *T3: `apps/server/src/provider/Layers/ClaudeProvider.ts:331-400` (the probe), `:185-219` (`buildClaudeCapabilitiesProbeQueryOptions`, with the disable-hooks rationale), `:172` (25 s), `:457-462` (`--version`), `apps/server/src/provider/Drivers/ClaudeDriver.ts:169-181` (cache key and TTL)*
- **Models are a manifest, not a call.** A bundled `model-manifest.json` with an optional GitHub
  raw refresh (1 h TTL, disk-cached); each entry carries a `claudeCode` profile (`effortMap`,
  `modelSuffixes`, context windows) and a `minVersion`/`maxVersionExclusive` range filtered
  against `claude --version`.
  *T3: `apps/server/src/provider/ModelManifest.ts:36, 39-43, 380-393`; `apps/server/src/provider/ClaudeModelManifest.ts:32-45`; `apps/server/src/provider/ClaudeModelCatalog.ts:150-185`*
- **Skills are a filesystem scan, re-run on every `sendTurn`.** `<configDir>/skills` (scope
  `user`) then `<cwd>/.claude/skills` (scope `project`), first root wins, identity is the
  **directory name** not the frontmatter `name`, overrides merged from the settings files;
  `.agents/skills` is not scanned. Dispatch is plain text, never a control request: `$name` chips
  are rewritten and the last becomes a trailing `/name …` text block — Claude Code only expands a
  `/name` that is the first character of the last text block.
  *T3: `apps/server/src/provider/Drivers/ClaudeSkills.ts:308-384, 189-268`; `apps/server/src/provider/Layers/ClaudeAdapter.ts:5245-5257` (the rescan and its comment); `apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts:49-80`*
- **Subagents are reconstructed from `parent_tool_use_id` correlation** — subagent narration is
  dropped from the parent transcript while its tool blocks are kept — and surface as `task.*` rows
  from the SDK's `system/task_*` messages.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:3750-3762, 1337-1350, 2865-2889, 3707-3873`*
- **Traps.** Interrupting mid-tool yields `terminal_reason:"aborted_tools"` with an internal
  `[ede_diagnostic]` error that must never become the user-facing banner; repeated 529 overloads
  arrive as a **success** result carrying `api_error_status: 529`; `system` messages with subtype
  `hook_*` carry no durable `session_id` and must not update the resume cursor; a `result` with no
  active turn deliberately emits no `turn.completed`; a usage-limited turn parks inside the SDK
  with no further messages, so the thread keeps showing "working".
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:1595-1618, 1706-1714, 1684-1687, 490-500, 2747-2766`*

#### Codex

- **Launch.** `codex app-server` plus tokenised user launch args. Env sets `CODEX_HOME`,
  **tilde-expanded in the adapter** — `child_process.spawn` does not shell-expand env values, so
  `CODEX_HOME=~/.codex_work` reaches codex verbatim and it errors that the path does not exist.
  One `codex app-server` child per thread, bound to a per-session scope; probes get their own
  short-lived one.
  *T3: `apps/server/src/provider/Layers/codexLaunchArgs.ts:12-15`; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:1313-1346`; `apps/server/src/provider/Layers/CodexProvider.ts:369-373`; `apps/server/src/provider/Layers/CodexAdapter.ts:2317-2336`*
- **MCP rides `-c` config overrides, not a params field:**
  `-c mcp_servers.<name>.url=<endpoint>` and
  `-c '<name>.bearer_token_env_var="…"'` appended to argv with the token in env. Not needed for
  v1 (Orquester's `/mcp` server is terminal-shaped and out of scope), but it is the only place a
  Codex session can be given an MCP server.
  *T3: `apps/server/src/provider/Layers/CodexAdapter.ts:2298-2306`*
- **`CODEX_HOME` has two layouts.** `direct` uses the shared home. `authOverlay` builds a shadow
  home of symlinks into it — `sessions`, `archived_sessions`, `sqlite`, `shell_snapshots`,
  `worktrees`, `skills`, `plugins`, `cache`, `logs`, `mcp-oauth-locks` shared; `auth.json` and
  `models_cache.json` private (and `auth.json` in the shadow **must be a real file, never a
  symlink**); `log`, `memories`, `tmp` shadow-local. The continuation key is
  `codex:home:<sharedHomePath>`, which is how two accounts sharing a home can continue each
  other's threads — directly relevant to Orquester's managed-account homes.
  *T3: `apps/server/src/provider/Drivers/CodexHomeLayout.ts:19-33, 43-66`*
- **Handshake.** `request("initialize", {clientInfo:{name, title, version}, capabilities:
  {experimentalApi: true}})` then `notify("initialized", undefined)`. The response's `userAgent`
  is the **only** source of the Codex version (`/\/([^\s]+)/`).
  *T3: `apps/server/src/provider/Layers/CodexProvider.ts:343-353` (`buildCodexInitializeParams`), `:406-408`, `:421-422`*
- **Thread open.** `thread/start {cwd, approvalPolicy, sandbox, approvalsReviewer, model?,
  serviceTier?}`. Resume is `thread/resume {threadId, …startParams, excludeTurns: true}`, sent
  **raw** because older servers return history that would fail strict decoding; on a *recoverable*
  resume error it falls back to a fresh `thread/start` rather than failing the session.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:544-560` (`buildThreadStartParams`), `:707-775` (resume + fallback), `:59-66` (the recoverable-error matcher — English substrings, fragile, do not copy verbatim)*
- **Turn.** `turn/start {threadId, input, approvalPolicy, approvalsReviewer, sandboxPolicy,
  model?, serviceTier?, effort?, collaborationMode?}`. `input` items are `{type:"text", text}`
  plus `{type:"localImage", path}` per attachment — **images by path, never base64**. `model`,
  `effort` and `serviceTier` are documented upstream as overriding "for this turn **and subsequent
  turns**", which is why in-session model switching needs no RPC; `effort` is a plain non-empty
  string, **not an enum**. Before each turn, `config/mcpServer/reload` is issued best-effort when
  MCP servers are configured.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:611-666` (`buildTurnStartParams`), `:583-606` (`buildCodexCollaborationMode`), `:2504-2511` (the reload); `apps/server/src/provider/Layers/CodexAdapter.ts:2518-2522` (localImage)*
  *Built: a `file` ref is **not dropped**: its path line is appended to the text item by the same
  `appendAttachmentPathLines` Claude uses (§4.5 Claude Built), and an attachment-only turn sends
  the block as its only text item (`codex/session.ts`). Whether Codex may read outside the
  workspace is its own sandbox/approval policy — a path in the prompt grants nothing.*
- **Every server→client request Codex sends, and what we answer.** Five handlers:
  `item/commandExecution/requestApproval` → `{decision}` (with `acceptAlways` downgraded);
  `item/fileChange/requestApproval` → `{decision}` (same downgrade);
  `mcpServer/elicitation/request` → `{decision}` (its enum is only `accept|decline|cancel`);
  `item/permissions/requestApproval` → `{permissions, scope}` with `scope:"session"` only for
  `acceptForSession`; `item/tool/requestUserInput` → `{answers: Record<questionId, {answers:
  string[]}>}`, with a per-question validation failure mapped to `invalidParams`. Everything else
  — including `item/fileRead/requestApproval` and `account/chatgptAuthTokens/refresh` — is
  answered `-32601 methodNotFound`. Three incompatible approval enums coexist upstream; we speak
  only the v2 one and elicitation's.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2056-2346` (the five handlers), `:2107, 2165` (downgrade), `:2287-2294` (scope), `:2336-2345` (answers shape), `:2348-2350` (the catch-all `-32601`)*
- **Notifications.** Every generated server-notification method is registered generically into one
  queue; four additionally mutate session state (`thread/started`, `turn/started`,
  `turn/completed`, `error`). The mapping: `item/agentMessage/delta` → `content.delta
  {assistant_text}`; `item/reasoning/textDelta` → `{reasoning_text}`;
  `item/reasoning/summaryTextDelta` → `{reasoning_summary_text}`;
  `item/commandExecution/outputDelta` → `{command_output}`; `item/fileChange/outputDelta` →
  `{file_change_output}`; `item/plan/delta` → `turn.proposed.delta`; `item/started|completed` →
  `item.*`; `turn/diff/updated` → `turn.diff.updated`; `thread/tokenUsage/updated` →
  `thread.token-usage.updated`. Web search and MCP tool calls are *items*, not dedicated
  notifications. Item classification is a **substring heuristic over a de-camel-cased type name**,
  not a switch — another one not to copy verbatim.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2352-2370` (generic registration), `:779, 833-875` (the four stateful ones); `apps/server/src/provider/Layers/CodexAdapter.ts:1304-2223` (the mapping), `:633-663` (`toCanonicalItemType`)*
  *Built: the RPC shapes differ from the sentence above in three ways worth pinning.
  `thread/start` and `thread/resume` answer `{thread:{…}}` plus the whole resolved config, not
  `{threadId}`, and `turn/start` answers `{turn:{…}}`. Every request error is `-32600` — never
  classify a Codex failure by code — and the `error` **notification** carries `willRetry`, which is
  what separates a `runtime.warning` from a `runtime.error`. `configWarning`, `guardianWarning` and
  `deprecationNotice` all land as `runtime.warning`. `thread.started` is emitted once, and there is
  no `turn.aborted` producer on this adapter: an interrupted Codex turn settles through
  `turn.completed {state:"interrupted"}`. A Codex `cancel` ends the turn as `status:"interrupted"`
  with `items: []`, so a fold that trusts `turn.items` erases the turn — the fold must not
  (`apps/daemon/src/agent-host/adapters/codex/normalise.ts`, `…/session.ts`).*
- **Two question paths.** The RPC path (`item/tool/requestUserInput`) filters **hard**: a question
  is dropped unless it has id, header, prompt **and** at least one option whose label *and*
  description are both non-empty, and `multiSelect` is hard-coded `false`; if every question is
  dropped the event is suppressed. The second, **reply-less** path is an `item/completed`
  `agentMessage` with `delivery:"async"` and `questions[]`, which becomes
  `user-input.requested {responseMode:"message"}` with a synthetic id
  (`codex-async:<threadId>:<itemId>`) — the answer goes back as an ordinary turn, not a JSON-RPC
  response.
  *T3: `apps/server/src/provider/Layers/CodexAdapter.ts:885-910` (the filter), `:1691-1711` (the async path)*
  *Built: the RPC path is implemented with the field names the CLI actually uses —
  `requestUserInput` carries `question`, not `prompt`, its options are `{label, description}` with
  **no `value`** (so an answer goes back as the option's *label*), and it additionally carries
  `isOther`, `isSecret` and `isBlocking`, which the question card renders as a free-text option and
  a masked field (§7.5). `availableDecisions` is a presentation hint, not a whitelist. The second,
  reply-less **async** path is **not implemented**: it was never observed in any capture of this
  CLI, and a synthetic request id for a path that does not exist would be a card nobody can close
  (`apps/daemon/src/agent-host/adapters/codex/session.ts`).*
- **Token usage.** `thread/tokenUsage/updated` carries *cumulative thread* totals, so the adapter
  keeps a baseline and diffs per turn, clamping cache subsets into `inputTokens`; a turn with no
  observed delta settles `unavailable`, an interrupted one `partial`.
  *T3: `apps/server/src/provider/Layers/CodexAdapter.ts:538-617` (accumulate + complete), `:1589` (thread usage), `:2417-2444` (stamped on turn.completed/aborted)*
  *Built: no baseline arithmetic. `thread/tokenUsage/updated` already carries `last` — the per-call
  delta — and `modelContextWindow`, so the adapter reports the delta the provider gives it instead
  of diffing cumulative totals it would have to keep a baseline for; `turn/completed` carries no
  usage at all (`apps/daemon/src/agent-host/adapters/codex/usage.ts`).*
- **Interrupt, in order.** (1) settle pending approvals as `cancel`; (2) settle pending
  user-inputs; (3) interrupt every live **child** turn first, bounded at 3 s per child and 10 s
  overall, concurrency 8 — collab children are full threads and interrupting only the parent
  leaves the fleet running, and the transport awaits an unbounded deferred per request so a wedged
  child would otherwise block Stop exactly during the runaway fleet; (4) `turn/interrupt
  {threadId, turnId}`. Carry the ordering, not the in-source explanation: the comment about the
  read loop blocking is stale (inbound server requests are forked into their own scope), and the
  real constraint is a **32 in-flight server-request cap**, beyond which the peer is answered
  `-32001 "Too many Codex requests are already active."`.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2562-2602`; `packages/effect-codex-app-server/src/protocol.ts:18, 300-314` (the cap), `:159, 338` (requests forked into `requestHandlerScope`)*
- **Transport.** NDJSON, one JSON object per line, **no `jsonrpc` field**, and **no request
  timeouts at all** — callers add their own deadlines.
  *T3: `packages/effect-codex-app-server/src/protocol.ts:100-115` (line framing), `:455-474` (request/notify write only `{id, method, params}`)*
- **Compaction is native:** `thread/compact/start {threadId}`.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:2497-2500`; `apps/server/src/provider/Layers/CodexAdapter.ts:2729`*
  *Built: `thread/compact/start` is the call, but compaction surfaces as a **whole extra turn**
  signalled by a `contextCompaction` item — `thread/compacted` never fires on this CLI, so nothing
  may wait on it. There is also a `thread/reverted` notification, which the adapter handles rather
  than warning about (`apps/daemon/src/agent-host/adapters/codex/normalise.ts`).*
- **Rollback has two code paths.** Legacy threads take `thread/rollback {threadId, numTurns}`;
  **paginated** threads do not support the count-based endpoint, so the adapter reads the thread
  (`thread/turns/list`, cursor loop, a raw call not in the generated meta) and issues
  `thread/revert {threadId, beforeTurnId}` at the computed boundary. An implementation that knows
  only `thread/rollback` fails silently on newer histories.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:1215-1288`*
  *Built: there is only **one** path. `thread/rollback` is dead on every thread this CLI creates —
  it answers `-32600 "paginated threads do not support thread/rollback"` — so rollback is always
  `thread/turns/list` (cursor loop) → `thread/revert {threadId, beforeTurnId}`. The adapter never
  calls the count-based endpoint at all (`apps/daemon/src/agent-host/adapters/codex/session.ts`,
  `…/history.ts`). `thread/turns/list` is also how a resumed thread is re-hydrated: `thread/resume`
  hands back `turns: []` by design.*
- **stderr becomes events.** Lines matching Codex's log format are parsed and re-emitted, with a
  benign-snippet denylist (`state db missing rollout path for thread`,
  `record_discrepancy … falling_back`) so routine noise never surfaces.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:54-57, 670-688, 2380-2400`*
- **Probe.** One short-lived app-server serves models, auth, skills and usage: `account/read` →
  `{account, requiresOpenaiAuth}` with an early return when unauthenticated; `model/list`
  **paginated by `cursor`**; `skills/list {cwds:[cwd]}`; `account/rateLimits/read` treated as an
  *enrichment* — a timeout or failure degrades to "no usage this probe" rather than costing the
  account and model list. Login is never performed from the GUI; the flow is
  `CODEX_HOME=… codex login` on the host, which is exactly Orquester's managed-account model.
  Codex advertises exactly **two** slash commands, `compact` and `feedback`, and has no
  custom-prompt catalogue.
  *T3: `apps/server/src/provider/Layers/CodexProvider.ts:359-409` (`withCodexAppServerClient`), `:410-470` (the probe), `:325-341` (pagination), `:674-687` (the two slash commands)*
- **Trap.** Codex emits `subAgentActivity {agentPath:"/root"}` *about the root thread*; registering
  it as its own child made threads hang "working" forever. Unknown child methods default to "pass
  to parent", not "drop" — two shipped bugs came from a catch-all.
  *T3: `apps/server/src/provider/Layers/CodexSessionRuntime.ts:1622-1636, 1080-1131`*
  *Built: three more behaviours this adapter carries. A resume that fails falls back to a fresh
  `thread/start` **unconditionally**, with a `runtime.warning` naming the lost context — refusing
  the session instead would leave a tab that can never be used again. `tool.denied` is derived from
  a tool that was declined without a request ever having been opened, since the CLI gates some
  calls itself. And `developer_instructions: null` is sent explicitly (§4.4). Unverified because no
  capture produced them: `item/permissions/requestApproval`, `item/tool/call`,
  `account/chatgptAuthTokens/refresh` and `attestation/generate` — all answered, none exercised.*

#### OpenCode

- **Server lifecycle.** `opencode serve --hostname=<h> --port=<p>` with the port taken from an
  ephemeral-port probe, spawned `detached: true` off Windows. Readiness is a **stdout scrape**: a
  line starting `opencode server listening` with the URL pulled by `/on\s+(https?:\/\/[^\s]+)/`,
  30 s timeout; startup capture is capped at 64 KiB and then set to `null` while the pipes keep
  draining, because stopping the readers blocks OpenCode once its output buffers fill. A
  post-start `GET /global/health` must return `{healthy:true, version}` within 5 s and enforces
  the OpenCode minimum pinned in §4.1. Auth to the server is `Authorization: Basic base64("opencode:<password>")` when a
  password is set. `OPENCODE_CONFIG_CONTENT` must be passed **explicitly** (because `extendEnv` is
  false whenever an env is supplied) but only falls back to `"{}"` when neither the caller nor the
  inherited env set it — setting it unconditionally once clobbered the user's own config and hid
  their providers. Shutdown is SIGTERM to the **process group** (`process.kill(-pid)`), 1 s, then
  SIGKILL.
  *T3: `apps/server/src/provider/opencodeRuntime.ts:667-714` (spawn + env with the clobber rationale at `:704-711`), `:81, 290-299, 751-772` (readiness), `:42-49, 143-179` (health + minimum version), `:657-663` (basic auth), `:728-745` (group kill), `:837-841` (drain-but-discard)*
  *Built: `--port 0` does **not** give an ephemeral port — this CLI binds the well-known 4096 when
  it is free — so the adapter probes a free port itself and passes it explicitly
  (`apps/daemon/src/agent-host/adapters/opencode/server.ts`). Auth is `Basic
  base64("opencode:<password>")` exactly, and `/global/health` sits behind the same gate, so the
  version check is an authenticated call. A malformed session id answers **500**, and a bad model
  is accepted with 204 and then fails asynchronously with three `session.error` frames.*
- **There is no cwd on the process.** The working directory travels per request as the client-level
  `directory`, which becomes header `x-opencode-directory` (rewritten to `?directory=` on
  GET/HEAD). That is what lets the per-project server of §3.2 serve every thread in a project; the
  two invariants that divergence rests on are stated there.
  *T3: `apps/server/src/provider/opencodeRuntime.ts:653-665`; `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2846-2863, 3005-3037` — differs: per-thread in T3, per-project here*
- **Resume.** Cursor `{schemaVersion:1, sessionId}`; a wrong version or empty id means "no resume",
  never an error. Resume re-adopts the upstream session id, and only a **structurally confirmed
  404** may fall through to a fresh session — the check walks `cause/body/error/data` for up to 32
  steps and an explicit non-404 status **seals its subtree**, because a mis-read error once caused
  silent context loss. Same directory ⇒ reuse in place **and re-assert the permission ruleset**;
  different directory ⇒ `session.fork({sessionID, directory})` + re-assert.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:71-91, 2997-3000` (cursor), `:104-142` (`isOpenCodeNotFound`), `:2901-2947` (reuse vs fork)*
- **Prompting.** Only `session.promptAsync` (`POST /session/{id}/prompt_async`) — the blocking
  `session.prompt` is never called, because completion comes from `session.status: idle`, not the
  HTTP response. Body: `{sessionID, messageID, model:{providerID, modelID}, agent?, variant?,
  system, parts}`. The **user message id is minted client-side** in OpenCode's sortable native
  shape `msg_${48-bit-hex-time}${14 random alnum}` so prompt-admission events can be matched. The
  submit call is capped at 10 s. A slash command goes down a different route entirely —
  `session.command` (`POST /session/{id}/command`) with `{command, arguments, model, agent?,
  variant?, parts}`, which **accepts no `system` addendum**, and is bounded by the user-message
  receipt rather than a submit timeout.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3246-3291` (both routes and the no-addendum comment), `:3291-3305` (the 10 s cap), `:996-1026` (the message id)*
  *Built: **`parts` carries attachments two ways.** The four image mimes, any `text/*` and
  `application/pdf` at or under 20 MiB become `{type:"file", mime, filename, url: file://…}` parts
  the server reads off this host's disk; everything else (an `.xlsx`, an undeclared mime, an
  oversized file) rides as an `Attached files:` path line appended to the text part by
  `appendAttachmentPathLines`, so an attachment-only turn with such a file no longer throws "turns
  require text input". OpenCode's `external_directory` rule may still ask before reading it. A ref
  whose path cannot be resolved fails the turn before `turn.started`, as it does for the other
  three adapters — a silently vanished file is the bug this replaced. A native `/command` sent
  with a non-native file receives the block inside its arguments (`$ARGUMENTS`), because the
  command match runs on the appended text (`opencode/session.ts`; the `external_directory` rule
  in `opencode/ruleset.ts`, §4.4).*
- **Turn completion is three machines, not a flag.** (1) The 10 s submit cap above. (2)
  `scheduleIdleReconciliation`: on an idle for the active turn, poll `GET /session/status` with a
  1 s timeout and one retry — a **missing entry counts as idle**, `busy`/`retry` abandons unless a
  newer idle marked it dirty, undecidable emits one `runtime.warning` and backs off
  `min(250·2^n, 5000)`. (3) `schedulePromptAdmissionRecovery`, for **idle arriving before
  `promptAsync` returns**: confirm the user message exists via `GET
  /session/{id}/message/{msgId}`, poll status, and require **two consecutive idle confirmations**
  before completing; after 5 attempts it hard-fails with `turn.completed {state:"failed"}` plus
  `runtime.error {transport_error}`. Idle is additionally *deferred* while a cancellation is in
  flight, while a prompt admission is open, while awaiting busy after an interruption, or while a
  reconciliation is already scheduled. A reconnect (`server.connected`, not the first) marks usage
  incomplete and re-arms both machines.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:1170-1275` (idle reconciliation), `:1342-1503` (admission recovery), `:2622-2640` (the defer conditions), `:2182-2212` (reconnect)*
- **Text parts are snapshots; the adapter diffs them.** `mergeOpenCodeAssistantText` keeps the
  **previous** text when it is longer *and* a prefix of the incoming one, so a truncated snapshot
  never rewinds output; the prefix length is `previous.length` when the latest starts with it,
  otherwise a real common-prefix length; and the emit sets **both** `emittedText` and `text`
  before emitting so the same bytes can never go out twice. A *non-text* part update for a known
  part clears `text` but **keeps `emittedText`**. `message.part.delta` (only when `field ===
  "text"`) is genuinely incremental and appends instead of diffing.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:633-656` (merge + resolve), `:1617-1644` (emit), `:2476-2483` (non-text update), `:2410-2445` (`message.part.delta`)*
  *Built: text streaming is **both**, not one or the other. A part opens as a
  `message.part.updated` with `text: ""`, then N `message.part.delta {field:"text"}` frames carry
  the authoritative incremental text, then a closing full snapshot arrives with `time.end`. The
  snapshot-diffing merge above is still required (it is what makes the closing frame idempotent),
  and the deltas are still appended. One trap: `field: "text"` deltas arrive for **`reasoning`**
  parts too, so the content stream kind must be taken from the *part's* `type`, never from the
  delta's `field` (`apps/daemon/src/agent-host/adapters/opencode/normalize.ts`).*
- **Permissions.** The ruleset (§4.4) is written on create, on resume-in-place, after a cwd fork
  and after a rollback fork — a plain `PATCH /session/{id}`, no server restart. Asks arrive as
  `permission.asked` and are answered on `POST /permission/{requestID}/reply {reply}` — *not* the
  `/session/:id/permissions/:permissionID` route that also exists in the SDK. Questions are the
  parallel `question.asked` / `POST /question/{id}/reply` pair.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2901-2947` (ruleset write points), `:3762-3769` (the reply route), `:2535-2560` (the ask/reply events)*
  *Built: `permission.asked` additionally carries `always` — the pattern the server would persist —
  and `tool: {messageID, callID}`. That `always` grant is **directory-wide across every session of
  one server** (§3.2's second invariant, confirmed against the real server), which is why an
  automatic approval is only ever sent `once`. An aborted turn leaves its permission request open
  in `GET /permission`, so settling before interrupt (§4.1) is correctness here, not tidiness. And
  under the supervised ruleset the `task` tool's own permission ask stalls a subagent turn
  indefinitely — a known gap, surfaced rather than hidden.*
- **Child-session event routing.** Parent-session events pass; **child-session events pass only if
  they are permission or question events**, behind an ancestry-resolution retry loop (250 ms→5 s
  backoff; asked-events retry forever, terminal events give up after 5). This is the whole reason
  the OpenCode roster is thinner than Claude's.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:2215-2265`*
  *Built: the OpenCode roster is **not** thin. A child session emits 38 frames across 8 event
  types, all observable, so the adapter turns a child session into a `task.*` row set and stamps
  its own work with `agentId` — §7.6's roster shows what the provider actually reports while
  §7.2's re-homing keeps it out of the parent timeline. The ancestry-resolution retry loop above is
  kept (`apps/daemon/src/agent-host/adapters/opencode/normalize.ts`).*
- **Token usage** is accumulated per message part (`input + cache.read + cache.write` into input,
  `output + reasoning` into output) and settles `complete` only when the turn completed *and*
  every step resolved; otherwise `partial`, or `unavailable` when no part carried tokens.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:420-457`*
- **Interrupt.** `POST /session/{id}/abort` (10 s), **then** walk `GET /session/{id}/children` and
  abort every descendant, concurrency 8, cycle-guarded, 404s ignored. Teardown aborts the parent
  **first** so it cannot spawn a new child. The acknowledgement arrives either as the HTTP reply
  *or* as a `session.error` carrying `MessageAbortedError`. Success emits **`turn.aborted`**, not
  `turn.completed`.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:779-866, 3600-3741`, with the abort-error race at `:300-307, 2646-2660`*
- **Compaction is native:** `POST /session/{id}/summarize` with `auto:false`, under the prompt
  semaphore, a **10-minute** timeout, and an explicit refusal while a turn is active. The
  follow-up `session.compacted` event becomes `thread.state.changed {compacted}`.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3537-3599` (with the refusal at `:3568-3574`), `:2314-2328`*
  *Built: the explicit refusal while a turn is active is **ours**. The server does not refuse a
  `summarize` mid-turn; it accepts it and rewrites the conversation the turn is reading. §3.4's
  "compaction refuses rather than queues" is therefore enforced by the adapter, not observed from
  the provider (`apps/daemon/src/agent-host/adapters/opencode/session.ts`).*
- **Rollback forks, deliberately not `session.revert`** — native revert also rewrites workspace
  files, and this design keeps file restore out of a revert (§5.5). The fork is verified to have
  kept exactly the expected message count and errors otherwise, then the ruleset is re-applied and
  a new cursor minted.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3938-3966`*
- **Models and auth come from the same call.** `GET /provider`, skipping any provider not in
  `providerList.connected`, slug `"${provider.id}/${model.id}"`; **login state is inferred from
  `providerList.connected.length > 0`** — there is no `opencode auth list`. Effort is the
  **`variant` field**, not a reasoning parameter: a select labelled "Reasoning" built from
  `model.variants` or synthesised `low/medium/high/xhigh`, passed as `variant` on both submit
  paths; **no `reasoningEffort`/`thinking` field is ever sent**. A second select exposes the
  primary `agent` list.
  *T3: `apps/server/src/provider/Layers/OpenCodeProvider.ts:257-287` (`flattenOpenCodeModels`), `:543-567` (auth inference), `:202-256` (`openCodeCapabilitiesForModel` — variants and agents)*
- **Catalogue fallbacks.** The CLI fallback inventory runs `opencode models --verbose`,
  `opencode agent list` and `opencode debug skill` **sequentially**, because concurrent runs hit
  the same SQLite file and fail "database is locked"; the live path prefers the SDK `GET /skill`
  because the Bun-compiled binary truncates non-TTY stdout at one 64 KB pipe buffer.
  *T3: `apps/server/src/provider/opencodeRuntime.ts:962-1060`; `apps/server/src/provider/Drivers/OpenCodeDriver.ts:171-189`*

#### Grok

- **Launch argv is runtime-mode dependent and the flag position moves.**
  `["--permission-mode","default","agent","stdio"]`, `…"acceptEdits"…`, `…"auto"…`, but
  `full-access` is `["agent","--always-approve","stdio"]` — flag **after** `agent`. It is
  `grok agent stdio`, never `grok --acp`. Env adds `GROK_OAUTH2_REFERRER`. `XAI_API_KEY` is read
  but never written: it only picks the ACP auth method id (`xai.api_key` vs `cached_token`).
  `GROK_HOME` is not set by the adapter — Orquester sets it per §3.1 to bind the managed account.
  *T3: `apps/server/src/provider/acp/GrokAcpSupport.ts:33-46` (argv), `:48-63` (env), `:14-18, 65-69` (auth method)*
  *Built: one file is added to that launch. Grok's `[features] support_permission = true` — without
  which the agent self-resolves every approval and `session/request_permission` never fires (§4.3)
  — and `auto_update = false` must reach the CLI, and the obvious place to put them is a **trap**:
  on a managed account home `<GROK_HOME>/config.toml` is a **symlink** to the daemon user's own
  `~/.grok/config.toml`, so writing it reconfigures Grok host-wide, for every terminal tab and
  every account, from one chat launch (it happened twice during the build). The host therefore
  writes a per-thread overlay and points `GROK_CONFIG_PATH` at it; nothing under a shared home is
  written (`apps/daemon/src/agent-host/adapters/grok/launch.ts`,
  `apps/daemon/src/agent-chat/home-prep.ts`). `auto_update` matters because the CLI upgraded
  itself 1.0.3 → 1.0.34 mid-session: the version is read from `initialize._meta.agentVersion` on
  **every** handshake and never cached per host, and `meetsMinimumGrokVersion(null)` is
  deliberately permissive for the window before the first handshake answers.*
- **Handshake.** `initialize {protocolVersion: 1, clientCapabilities, clientInfo}`, then
  **unconditionally** `authenticate {methodId}` — the agent's own advertised `authMethods` are not
  consulted. Grok declares **no client capabilities**: `fs.readTextFile/writeTextFile: false`,
  `terminal: false`, so the agent never calls `fs/*` or `terminal/*` back. What actually matters
  is `initialize._meta`: `modelState` → models, `availableCommands` → slash commands, `modeState`.
  *T3: `apps/server/src/provider/acp/AcpSessionRuntime.ts:596-608` (capabilities), `:726-735` (initialize), `:740-748` (unconditional authenticate); `apps/server/src/provider/Layers/GrokProvider.ts:342-364` (`_meta` reads)*
- **Session setup is `session/new {cwd, mcpServers}` or `session/load {sessionId, cwd,
  mcpServers}` — never `session/resume`** (that branch exists in the shared ACP runtime but is
  gated on an agent capability Grok does not declare). `session/load` races the RPC response
  against a **2 s replay-idle gate**, because the CLI replays history as notifications and may
  never answer the RPC: replay notifications (`_meta.isReplay`) are dropped but bump a liveness
  clock, and after 2 s idle a **synthetic** `LoadSessionResponse` is fabricated from
  `initialize._meta`; 90 s overall.
  *T3: `apps/server/src/provider/acp/AcpSessionRuntime.ts:755-880` (the three branches), `:791-796` (load payload), `:804-864` (the replay-idle race); `apps/server/src/provider/acp/AcpRuntimeModel.ts:709-758` (the synthetic response)*
  *Built: `session/load` answers in ~266 ms in practice, and the replay arrives as
  **`_x.ai/session/update`** — a method name T3 does not register at all, so an adapter that only
  knows `session/update` silently loses the whole replayed history (and the usage rows in it).
  `sessionCapabilities.resume` is declared. `session/new` boots **every** MCP server the home has
  configured (~157 tools, ~3 s, discovered from `~/.claude.json` through the Claude-compat path);
  a chat thread deliberately inherits exactly what a terminal tab under the same home would — see
  §10. Concurrent prompts are **queued** by the CLI, not steered into the running turn, and there
  is an `_x.ai/task_backgrounded` notification
  (`apps/daemon/src/agent-host/adapters/grok/history.ts`, `…/normalize.ts`).*
- **Every x.ai extension method, in both spellings.** Each exists bare (`x.ai/…`) and
  underscore-prefixed (`_x.ai/…`), and params may additionally arrive **wrapped** as
  `{method, params}` — register both names and unwrap.
  - `x.ai/ask_user_question` — agent→client request `{sessionId, toolCallId, questions:[{id?,
    question, options:[{label, description?, preview?, id?}], multiSelect?}], mode}` → our
    `user-input.requested`; the answer is `{outcome:"accepted", answers:{<questionText>: [labels]},
    annotations?}` — keyed **by question text**, and unmatched free text becomes label `"Other"`
    plus a note.
  - `x.ai/exit_plan_mode` — request `{sessionId, toolCallId, planContent?}`. We **abandon the
    native gate**: emit `turn.proposed.completed` (falling back to a fixed "no plan written yet"
    markdown when `planContent` is empty) and reply `{outcome:"abandoned", feedback: …}`. The
    outcome vocabulary is `approved | abandoned | request_changes`.
  - `_x.ai/session/prompt_complete` — agent→client **notification** `{sessionId, promptId?,
    stopReason?, agentResult?}`, raced against the `session/prompt` RPC (see below).
    `stopReason:"rate_limit"` becomes a typed error with JSON-RPC code **-32003**; a missing
    `stopReason` is normalised to `end_turn` and tagged, which the adapter reports as
    `stopReason: null`.
  *T3: `apps/server/src/provider/acp/XAiAcpExtension.ts:35-64` (ask_user_question schemas + the wrapped form), `:130-196` (the answer mapping), `:203-267` (exit_plan_mode incl. `XAI_EMPTY_PLAN_MARKDOWN` and the abandon response), `:33, 418-489, 587-594` (prompt_complete and the -32003 error); `apps/server/src/provider/Layers/GrokAdapter.ts:1045-1046, 1104-1105` (both spellings registered)*
- **`session/prompt` may never return**, hence two independent safety nets: the
  `prompt_complete` notification above, and the **turn liveness watchdog of §3.1**, whose windows
  and approval pause are defined there. Grok is the reason it exists, and the one Grok-specific
  rule is that it is not started until the first observable ACP progress, because ACP hides Grok's
  private `streaming_reasoning` phase. A stall cancels and fails the turn. `stopReason` is five values, not
  four: `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:94-101` (the two constants with their rationale), `:443-446, 507-518, 729-818` (the watchdog and its approval pause); `packages/effect-acp/src/_generated/schema.gen.ts:9871`*
  *Built: every attachment reaches Grok as a path line — `promptCapabilities.image` is `false` on
  this CLI, so even an image is a path its `read_file` tool can act on — through the shared
  `appendAttachmentPathLines`, which skips a path the text already names (`grok/session.ts`).*
- **Plan mode is detected, not declared.** `showPlanModeToggle` is false, yet the adapter still
  emits `turn.proposed.completed` from two sources: `enter_plan_mode`-shaped tool calls, and
  writes to `~/.grok/sessions/<encoded-cwd>/<session-id>/plan.md` promoted into a proposal. The
  path matcher refuses `..` segments and deliberately does **not** match a workspace-local
  `docs/plan.md`.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:233-272, 1425-1446`; `apps/server/src/provider/acp/XAiAcpExtension.ts:322-353`*
- **Model switching uses the unstable `session/set_model` RPC**, not `session/set_config_option`.
  The product slug `grok-build` is **never sent over the wire** — it means "keep the session's
  current model". Reasoning effort rides as `_meta.reasoningEffort` on that request, validated
  against `/^[a-z0-9][a-z0-9._-]{0,31}$/i` and **dropped rather than forwarded** when invalid; an
  absent preference is never sent as an explicit clear, so a same-model reselection cannot wipe
  the CLI-advertised default.
  *T3: `apps/server/src/provider/acp/AcpSessionRuntime.ts:1109-1123`; `apps/server/src/provider/acp/GrokAcpSupport.ts:101-122, 156-187` (with the no-explicit-clear comment at `:181-187`)*
- **Tool output must be bounded and coalesced or it floods the bus.** Grok resends the *whole*
  accumulated output on every `tool_call_update`, so content and
  `rawOutput.{content,stdout,stderr,output}` are truncated to an 8000-char tail with an
  `"[Earlier output truncated]"` marker, and emission is coalesced: always on completed/failed or
  a title/status change, otherwise only when progress grew ≥ 256 chars or 10 updates were skipped.
  *T3: `apps/server/src/provider/acp/AcpRuntimeModel.ts:282-320, 338-442, 588-666`*
- **Generic ACP machinery a fresh implementation must rebuild.** The client-side method registry
  the agent can call back into — `fs/read_text_file`, `fs/write_text_file`,
  `session/elicitation(/complete)`, `session/request_permission`, `session/update`,
  `terminal/{create,kill,output,release,wait_for_exit}`; `session/update` variants worth handling
  are `config_option_update`, `available_commands_update`, `current_mode_update`, `plan`,
  `tool_call`, `tool_call_update`, `agent_message_chunk`, `agent_thought_chunk` — **everything
  else is dropped, including `user_message_chunk`**; assistant-message **segmentation is
  synthesised client-side** (`assistant:<sessionId>:runtime:<uuid>:segment:<n>`, opened on the
  first delta, closed on a tool call / prompt end / drain); a `drainEvents` barrier pushed through
  the queue and acknowledged by the adapter so final chunks land before turn settlement; stderr
  kept as a **redacted 4 KiB rolling tail** (home dir, pairing URLs, `Bearer`, `x-api-key`,
  `sk-`/`ghp_`/`xox?-`) attached to the first termination error; and protocol logging that
  **summarises payloads, never logs them raw**. Tool-kind normalisation: `execute`→
  `command_execution`, `edit|delete|move`→`file_change`, `search|fetch`→`web_search`, else
  `dynamic_tool_call`; permission kind → `exec_command_approval | file_read_approval |
  file_change_approval | dynamic_tool_call`.
  *T3: `packages/effect-acp/src/_generated/meta.gen.ts:4-35` (the method catalogue and `PROTOCOL_VERSION`); `apps/server/src/provider/acp/AcpRuntimeModel.ts:795-884` (the update switch), `:452-466` (kind normalisation); `apps/server/src/provider/acp/AcpSessionRuntime.ts:1204-1208, 1279-1342` (segmentation), `:941-957` (drain barrier), `:380-419` (stderr tail); `apps/server/src/provider/acp/AcpStderr.ts:5-37` (redaction); `apps/server/src/provider/acp/AcpNativeLogging.ts:18-44`; `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:37-50`*
- **Background tasks and subagents are reconstructed from `rawOutput` discriminants** on
  `tool_call_update` — `Monitor`, `BackgroundTaskStarted`, `TaskOutput`, `KillTask` — and are
  emitted **even after the turn ends**.
  *T3: `apps/server/src/provider/acp/XAiBackgroundTasks.ts:61-155`; `apps/server/src/provider/Layers/GrokAdapter.ts:1343-1366`*
- **Interrupt** marks the turn id as interrupted **synchronously, before taking the thread lock**,
  so late notifications and a late prompt result are dropped; then settles pending approvals and
  user-inputs as cancelled (the ACP spec requires a cancel to answer every pending permission
  request with `cancelled`); then sends the `session/cancel` **notification**; then settles the
  turn. Interrupt is also turn-scoped: a Stop naming a turn that is no longer active returns
  immediately.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:2015-2075`; `packages/effect-acp/src/_generated/schema.gen.ts:7782`*
  *Built: as written, with one consequence the UI must live with: a **rejected tool** also ends the
  turn as `stopReason: "cancelled"`, indistinguishable from a user Stop except through the
  `permission_denied` hook event. A 116 s window of total ACP silence was observed mid-turn on a
  trivial prompt, which is why §3.1's 10-minute watchdog is a floor and not a generosity.*
- **Grok emits no token usage at all** — no `thread.token-usage.updated`, no
  `turn.completed.tokenUsage`. The context meter and per-turn cost are simply absent on Grok
  (`reportsContextWindow: false`), and the status line must degrade rather than show zeros.
  *T3: verified by absence — no `tokenUsage`/`usageStatus` emitter in `apps/server/src/provider/Layers/GrokAdapter.ts` or `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts`; cf. `packages/contracts/src/server.ts:200-201`*
  ***Built: this is wrong for the shipped CLI and the adapter does the opposite.*** Grok 1.0.34
  emits usage in four places: `_meta.totalTokens` on every streamed chunk, a complete per-turn
  block with `costUsdTicks` on the `session/prompt` result, the same `usage` object repeated on
  `_x.ai/session_notification turn_completed`, and per-model-call usage on `response_completed`.
  The context window is `initialize._meta.modelState.availableModels[]._meta.totalContextTokens`
  (500 000). So Grok's capabilities declare **`reportsContextWindow: true`**, the status line shows
  a real meter and a real per-turn cost, and `TurnTokenUsage` is populated
  (`apps/daemon/src/agent-host/adapters/grok/usage.ts`, `…/index.ts`). The sentence above stays on
  record because it was true of the build T3 was written against — and because it is the clearest
  example of why §10's "protocols move" rule exists.*
- **No rollback.** `supportsConversationRollback: false`; `rollbackThread` always fails.
  Compaction is the slash command `/compact`.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:2190-2192`, `:2142-2157`*
- **Probe is three steps, none of which authenticate.** `grok --version` (4 s) → **`grok models`**
  (10 s, text-parsed: `/you are logged in/i`, `/not authenticated|not logged in/i`, `*`/`-` bullet
  lines, a `(default)` marker) → an **`initialize`-only ACP probe** (8 s) that deliberately sends
  no `authenticate` and no `session/new`, so it cannot open a browser login or boot the
  workspace's MCP servers. Auth verdict precedence: `XAI_API_KEY` → CLI text → unknown. Two
  advertised slash commands are filtered out by name: `always-approve` (permission changes must go
  through Orquester) and `context` (its ACP handler completes without emitting output). Skills
  come from `grok inspect --json` — entries without a name or a filesystem path are skipped, and
  `userInvocable: false` skills are kept but marked disabled — with typed probe errors so a
  failure never caches an empty catalogue.
  *T3: `apps/server/src/provider/Layers/GrokProvider.ts:247-285` (`parseGrokModelsCliOutput`), `:315-340` (the two filtered commands), `:342-364` (the initialize-only probe and its comment), `:486-492` (verdict precedence); `apps/server/src/provider/Drivers/GrokSkills.ts:45-92`*
  *Built: the probe is as written, but `initialize` advertises only **7** commands while the CLI's
  real catalogue is **69** — the slash surface is built from the full catalogue, not from the
  handshake's short list (§4.6). Not captured and therefore unverified: an unauthenticated failure
  and `stopReason: "rate_limit"`.*
- **Lifecycle.** One `grok agent stdio` child **per thread**, kept alive indefinitely, with a
  per-thread semaphore and a documented lock-ordering rule: never hold the prompt-lifecycle lock
  and the thread lock together.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:998, 1786-1787`*
  *Built: one addition to the redaction of §3.1. `_x.ai/mcp/servers_updated` carries the host's
  real MCP credentials in each server's `env` map, so `raw.ndjson` redaction runs over raw ACP
  frames too and knows about `env` maps structurally, not only about token-shaped strings
  (`apps/daemon/src/agent-host/adapters/grok/acp/redact.ts`,
  `apps/daemon/src/agent-host/store/raw-log.ts`).*

### 4.6 Slash commands and skills

A `/` in the composer must feel like the CLI it replaced, without the host pretending to own
commands it cannot implement. Three rules decide everything below:

1. **The catalog is the provider's, not ours.** Orquester never hard-codes a per-agent command
   list. Every entry comes from the agent's own handshake, RPC or on-disk scan.
2. **The host intercepts only what it can do better than the CLI.** Exactly three commands are
   taken over: `/model`, `/effort` and `/compact`. Everything else is either a client-side UI
   command or is forwarded verbatim.
3. **A forwarded command must open the message.** Every one of the four protocols expands a
   slash command only when it is the first character of the turn text. Anywhere else it is prose,
   and the composer must not pretend otherwise.

*T3: `docs/user/composer.md:145-156` — the same three rules stated to users: "Provider commands
must start the message to run. T3 Code commands such as `/model` and `/plan`, and skill mentions,
work on any line."*

#### 4.6.1 Catalog shape

The provider snapshot of §4.1 gains two arrays and one per-directory overlay:

```ts
type SlashCommand = { name: string; description?: string; input?: { hint: string } };
type Skill = {
  name: string; path: string; enabled: boolean;
  description?: string; shortDescription?: string; displayName?: string;
  scope?: "user" | "project" | "plugin" | "bundled" | string;
  userInvocationOnly?: boolean;   // agent cannot start it; the user must
  userInvocable?: boolean;        // false = only the agent may start it
};
type WorkspaceSnapshot = { cwd: string; checkedAt: string; slashCommands: SlashCommand[]; skills: Skill[] };
// ProviderSnapshot: { …, slashCommands: SlashCommand[], skills: Skill[], workspaceSnapshots?: WorkspaceSnapshot[] }
```

A command carries no `source` and no provider id — the provider is the snapshot row it sits in,
and the client re-attaches it when building a menu row.

*T3: `packages/contracts/src/server.ts:83-124` — identical `ServerProviderSlashCommand`,
`ServerProviderSkill` and `ServerProviderWorkspaceSnapshot`; `input.hint` is the only argument
metadata that exists.*
*T3: `apps/web/src/components/chat/ChatComposer.tsx:2351-2360` — the provider id is attached at
menu-build time, not carried on the wire.*

Both arrays decode to `[]` and `workspaceSnapshots` is optional, so an older client or a driver
that never learned to report them still decodes.

*T3: `packages/contracts/src/server.ts:229-233` — `withDecodingDefault([])` on both, `optionalKey`
on `workspaceSnapshots`.*

#### 4.6.2 Catalog acquisition, per provider

| Provider | Commands | Skills |
|---|---|---|
| **Claude** | the Agent SDK init handshake's `commands[]` (`{name, description, argumentHint}`) | filesystem scan of `<CLAUDE_CONFIG_DIR>/skills` and `<cwd>/.claude/skills` |
| **Codex** | none discoverable — synthesised (§4.6.3) | app-server `skills/list {cwds:[cwd]}` |
| **OpenCode** | `GET`-equivalent `command.list` on the per-project server | `app.skills` on the same server |
| **Grok** | ACP `initialize` → `_meta.availableCommands[]` | `grok inspect --json` → `skills[]` |

- **Claude.** The probe of §4.1 already opens a `query()` with a never-yielding input generator to
  read account info without an API call; the same `initializationResult()` carries the merged
  command list — built-ins, `~/.claude/commands`, `<cwd>/.claude/commands` and plugin commands,
  already resolved by the CLI. Orquester reads it there and nowhere else: there is no separate
  scan of `.claude/commands`.
  *T3: `apps/server/src/provider/Layers/ClaudeProvider.ts:325-400` — the never-yielding prompt
  generator, `init.commands`, then abort.*
  *T3: `apps/server/src/provider/Layers/ClaudeProvider.ts:246-268` — `argumentHint` → `input.hint`;
  `:271-306` case-insensitive dedupe, first wins, missing description/hint filled from the loser.*
- **Claude skills are scanned from disk**, not taken from that list, because the handshake reports
  a skill as a bare command name with no path — and the path is what a source badge, an
  enabled/disabled state and the invocability flags need. The user root wins on a name collision,
  a skill's identity is its **directory name** (not the frontmatter `name`), malformed frontmatter
  means skip, and every read is best-effort.
  *T3: `apps/server/src/provider/Drivers/ClaudeSkills.ts:1-14` — states exactly this reason;
  `.agents/skills` is deliberately not scanned because the CLI answers `Unknown command` there.*
  *T3: `apps/server/src/provider/Drivers/ClaudeSkills.ts:308-380` — precedence, directory-name
  identity, skip-on-malformed.*
  *T3: `apps/server/src/provider/Drivers/ClaudeSkills.ts:42-98` — `disable-model-invocation` →
  `userInvocationOnly`, `user-invocable: false` → `userInvocable: false`, YAML-1.1 booleans
  (`yes/no/on/off/1/0`) accepted because the CLI accepts them.*
  *T3: `apps/server/src/provider/Drivers/ClaudeSkills.ts:180-216` — settings `skillOverrides`
  (`on` / `name-only` / `user-invocable-only` / `off`) and the managed-settings policy file.*
- **Codex** has no command-catalog RPC. Skills come from `skills/list`; a command list does not
  exist.
  *T3: `apps/server/src/provider/Layers/CodexProvider.ts:477-487` — `skills/list {cwds:[cwd]}`;
  `:289-322` the field mapping. `:680-687` — the whole Codex command catalog is two hard-coded
  entries.*
  *T3: grep for `customPrompt` / `prompts/list` across `apps/` and `packages/` returns nothing —
  Codex custom prompts (`~/.codex/prompts/*.md`) are never enumerated.*
  **differs:** Orquester treats Codex's missing command catalog as a known gap and says so in the
  menu's empty state ("Codex reports no commands"), rather than letting an empty list read as a
  failed probe.
- **OpenCode.** The per-project server already started in §4.5 answers `command.list` and
  `app.skills`. Commands whose `source` is `skill` are dropped from the command array — they
  reappear as skills, and §4.6.7 removes the duplicate.
  *T3: `apps/server/src/provider/opencodeRuntime.ts:194-206` — `command.list` keeping
  `{name, description, source, hints}`; `hints[]` joined into `input.hint` at
  `apps/server/src/provider/Layers/OpenCodeProvider.ts:319-336`.*
  *T3: `apps/server/src/provider/opencodeRuntime.ts:942-962` — one `loadOpenCodeInventory` for
  providers, agents, skills and commands; a failed command list recovers to `[]`.*
- **Grok.** The `initialize`-only probe of §4.1 already returns `_meta.availableCommands`. Two
  names are removed on the way in: `always-approve`, because permission mode is a host chip and a
  provider-side change would desynchronise it, and `context`, because Grok's handler completes
  without emitting anything.
  *T3: `apps/server/src/provider/Layers/GrokProvider.ts:315-340` — both filters with those exact
  reasons; `:541` falls back to the compact entry alone when the probe failed.*
  *T3: `apps/server/src/provider/Drivers/GrokSkills.ts:1-16, 99-151` — `grok inspect --json`
  is preferred over a filesystem scan because it honours ignore lists and reaches plugin skills
  three levels deep under `~/.grok/installed-plugins/`; `userInvocable: false` rows are kept but
  marked `enabled: false`.*

#### 4.6.3 Synthesised entries

Two commands are added by the host to every provider that can serve them, because they are host
features with no CLI equivalent on this surface:

- **`/compact`** on all four, because compaction is a host route (§6.2) and must be reachable by
  typing as well as from the context meter.
- **`/effort`** on every provider whose selected model exposes a reasoning descriptor.

*T3: `apps/server/src/provider/providerSnapshot.ts:27-30` — T3 synthesises `compact` the same way
and prepends it in all five drivers (`apps/server/src/provider/Layers/ClaudeProvider.ts:537`, `apps/server/src/provider/Layers/CodexProvider.ts:681`,
`apps/server/src/provider/Layers/OpenCodeProvider.ts:322`, `apps/server/src/provider/Layers/GrokProvider.ts:320`).*
*T3: `packages/shared/src/usageLimits.ts:463-537` — T3 also synthesises `/usage-limits` and injects
it into both the machine list and every workspace snapshot. **differs:** Orquester has no such
command; quota lives in the Settings usage overview and the top-bar chip (§7.7), which are one
click away and already per-account. **differs:** T3 has no `/effort`; Orquester adds it (§4.6.5).*

#### 4.6.4 Per-cwd scoping and refresh

`workspaceSnapshots[]` overlays the machine-level catalog for one working directory. Rules:

- Only **skills** are re-scoped per cwd for Claude, Codex and Grok — their command lists are
  machine-level. OpenCode's whole inventory is per-project by construction, because the server is.
  *T3: `apps/server/src/provider/Drivers/ClaudeDriver.ts:241-250`,
  `apps/server/src/provider/Drivers/CodexDriver.ts:249-275`, `apps/server/src/provider/Drivers/GrokDriver.ts:139-166` — each `snapshotForCwd` returns
  `{...machineSnapshot, skills}`.*
- A cwd is probed **once**. A snapshot already present for that cwd is never re-probed, and
  concurrent requests for the same `(provider, cwd)` collapse into one.
  *T3: `apps/server/src/provider/Layers/ProviderRegistry.ts:806-875` — early return when the cwd
  is already present, an in-flight set keyed by `(instance, cwd)`, result dropped if the instance
  was swapped mid-probe or the scoped snapshot came back `status:"error"`.*
- At most **16** cwds are retained per provider, oldest evicted.
  *T3: `apps/server/src/provider/Layers/ProviderRegistry.ts:80-100` —
  `MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16`, `.slice(-16)`.*
- A probe that comes back empty **never blanks** a non-empty cached list.
  *T3: `apps/server/src/provider/Layers/ProviderRegistry.ts:212-223` — empty next list keeps the
  previous one, for both `slashCommands` and `skills`.*
- Refresh is triggered by the host on thread-session start and on a turn that reuses a live
  session, forked so it never delays the turn; and explicitly by
  `POST /api/agent/providers/:id/refresh` with an optional `{cwd}`. Both broadcast
  `agent.providers.changed` (§6.4) only when something actually changed.
  *T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:700-703, 721, 779` — forked
  off session start and off the reused-session path; `apps/server/src/ws.ts:2318-2335` — the
  explicit refresh takes `instanceId` + `cwd`.*
- Claude re-scans its skills on **every send**, not only per cwd: skills are added and switched off
  mid-session and the scan is a few directory reads. The set handed to the dispatcher excludes
  disabled and `userInvocable: false` skills, so a rewritten `/name` can never be one the CLI
  would answer with a notice.
  *T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:5245-5268` — that rescan, with that
  reasoning, and the `enabled && userInvocable !== false` filter.*

#### 4.6.5 Dispatch: three paths

When the composer sends `/x …`, exactly one of three things happens.

**(a) Client — never leaves the browser.** The row is a host UI affordance. Selecting it from the
menu erases the typed text and performs the action; it is never inserted into the draft.

| Command | Action |
|---|---|
| `/model` | opens the composer's model chip popover (§7.4) |
| `/effort` | opens the effort/reasoning select on that same chip; `/effort <id>` applies directly |
| `/plan`, `/default` | toggles interaction mode, where `showPlanModeToggle` is true (§4.4) |

`/plan` and `/default` are additionally recognised on **submit**, when the whole trimmed draft is
that command and nothing else is attached. `/model` and `/effort` are not: typed out and sent they
are ordinary text, which keeps the submit path free of guesswork.

*T3: `apps/web/src/composer-logic.ts:13` — `ComposerSlashCommand = "model" | "plan" | "default"` is
T3's complete built-in set.*
*T3: `apps/web/src/components/chat/ChatComposer.tsx:3576-3595` — `/model` erases and opens the
picker; `/plan`/`/default` call `handleInteractionModeChange` and erase.*
*T3: `apps/web/src/composer-logic.ts:280-289` + `apps/web/src/components/ChatView.tsx:7582-7597` —
`/^\/(plan|default)\s*$/i` on submit, only with no attachments, no terminal contexts, no queued
message and a single model selection.*
*T3: T3 has no `/effort`. **differs:** Orquester adds it because effort is the single most-changed
knob in an agent session and the CLIs all expose it as a command; it writes the `effort` /
`reasoningEffort` / `variant` option of the current `ModelSelection` and nothing else.*

**(b) Host-native — intercepted by the daemon, turned into an API call.** One command:
`/compact`. The rule is exact and deliberately narrow — role `user`, no attachments, and the
trimmed lowercased text is exactly `/compact`. The host does not start a turn; it calls the
adapter's compaction (§4.1 `compact()`), which is native on Codex and OpenCode and a
`/compact` turn on Claude and Grok. A `/turn` whose text matches that predicate and the `/compact`
command of §6.2 land on exactly the same host path, including its refusal and queueing rules
(§3.4); the composer is free to send either. The user message is still persisted verbatim as
`/compact` and rendered as a compaction marker rather than a bubble.

*T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:95-98, 1332, 1407-1462` —
that exact predicate, then `providerService.compactThread(...)` instead of a turn; refused on an
empty thread ("Context compaction requires an existing conversation") and while a turn runs.*
*T3: `apps/server/src/provider/Layers/ProviderService.ts:1806-1912` — the native-vs-slash-command
branch, one compaction in flight per thread.*
*T3: `apps/server/src/provider/Layers/CodexAdapter.ts:2729` → `thread/compact/start`;
`apps/server/src/provider/Layers/OpenCodeAdapter.ts:4032` → `session.summarize`; `apps/server/src/provider/Layers/ClaudeAdapter.ts:5573` and `apps/server/src/provider/Layers/GrokAdapter.ts:2192`
→ `{type:"slash-command", command:"/compact"}`, i.e. an ordinary turn whose input is the literal
string.*
*T3: `apps/web/src/components/ChatView.tsx:7145, 7171` — the context-meter button sends the same
literal `/compact` message; `:735-738` re-recognises it on render.*

**(c) Forwarded — the turn text, as typed.** Everything else. The host does not validate the name
against the catalog, does not rewrite it and does not block it: the CLI decides. The only send-path
check is the §4.1 input bound.

*T3: `apps/web/src/components/chat/composerSubmission.ts:12-31` — the only submit validation is
the character cap.*

Two forwarding refinements are adapter-level, not composer-level:

- **OpenCode is dispatched natively.** A prompt matching `^/name( args)?$` whose `name` is in a
  freshly fetched `command.list` is submitted through the server's command endpoint with `command`
  and `arguments` split out, instead of as prompt text. A name that is not in the list falls
  through to an ordinary prompt. Note that the command path cannot carry the per-turn system
  addendum, so Orquester's runtime instructions (§4.5) are absent on those turns.
  *T3: `apps/server/src/provider/Layers/OpenCodeAdapter.ts:3119-3126` — the regex and the live
  catalog lookup; `:3247-3262` — `client.session.command({command, arguments, …})` and the comment
  that it cannot take the addendum.*
- **Grok's `/always-approve` is refused** with a validation error that points at the permission
  chip, because a provider-side permission change would desynchronise the host's runtime mode.
  *T3: `apps/server/src/provider/Layers/GrokAdapter.ts:1524-1530` — the same refusal, same reason.*

#### 4.6.6 Per-provider matrix

**C** client-only · **H** host-native · **F** forwarded verbatim · **F\*** forwarded and the
protocol genuinely dispatches it · **—** never advertised, so never in the menu; typed by hand it
is prose.

| Command | Claude | Codex | OpenCode | Grok |
|---|---|---|---|---|
| `/model` | C | C | C | C |
| `/effort` | C | C | C | C |
| `/plan` · `/default` | C | C | not offered | not offered |
| `/compact` | H → `/compact` turn | H → `thread/compact/start` | H → `session.summarize` | H → `/compact` turn |
| `/goal` | F if a command or skill of that name exists | — | F\* if `command.list` has it | F if advertised |
| `/loop` | F if a command or skill of that name exists | — | F\* if `command.list` has it | F if advertised |
| `/clear` · `/help` · `/login` · `/status` · `/cost` · `/context` · `/init` · `/review` · `/resume` · `/rewind` · `/btw` · `/mcp` | F if the CLI advertises it | — | F\* if `command.list` has it | F if advertised, except `/context` which is stripped |
| `/feedback` | — | F (Codex's only real advertised command) | — | — |
| `/always-approve` | — | — | — | **blocked**, 400 with a pointer to the permission chip |

*T3: `apps/server/src/provider/Layers/CodexProvider.ts:680-687` — Codex's column is `—` almost
everywhere because its catalog is literally two hard-coded rows.*
*T3: `apps/server/src/provider/Layers/GrokProvider.ts:328-330` — `/context` stripped, "its ACP
handler completes without emitting output".*
*T3: `apps/server/src/provider/Layers/CodexAdapter.ts:2540` — Codex forwards `input.input`
untouched into `turn/start`; there is no interception anywhere in that adapter.*

**`/rewind`, `/clear`, `/resume` are not reimplemented.** Conversation rollback is the timeline's
"rewind to here" (§5.5), a new thread is a new tab, and resume is the launch flow's conversation
picker. Typing them reaches the CLI, which will do whatever it does in-process — the host does not
protect the user from that.
*T3: T3 likewise has no handling for any of them; `supportsConversationRollback` drives a timeline
control, not a command.*

**Neither `/goal` nor `/loop` is a host command.** No adapter, no route, no synthetic entry. They
work exactly to the extent the selected agent publishes them, and the catalog is what tells the
user whether they do.
*T3: repo-wide grep for `"/goal"` and `"/loop"` over `apps/` and `packages/` returns zero hits.*

#### 4.6.7 Composer menu

- **Trigger.** `/` opens the command menu when it is the first non-empty character of the **current
  line**, matching `/^\/(\S*)$/` up to the caret. `$` opens the skill menu on the current token;
  `@` keeps the existing file search (§7.4).
  *T3: `apps/web/src/composer-logic.ts:218-262` — line-relative slash trigger, `\p{Sc}` skill
  trigger, `@` path trigger.*
- **Position gating.** When the trigger does not start at offset 0, **provider commands are removed
  from the list**; host commands and skills stay. A provider expands a command only when it opens
  the whole message, so offering one mid-message would hand the user a guaranteed no-op.
  *T3: `apps/web/src/components/chat/composerSlashCommandSearch.ts:15-29` — the filter and that
  exact rationale, called with `rangeStart === 0` at `apps/web/src/components/chat/ChatComposer.tsx:2377-2380`.*
- **Per-provider gating.** `/plan` and `/default` appear only where `showPlanModeToggle` is true
  (§4.4), i.e. Claude and Codex. `/effort` appears only when the selected model has a reasoning
  descriptor. `/compact` appears only when the thread has something to compact and the draft is
  otherwise empty — no text after the trigger, no attachments, no context chips — because the
  host-native path discards all of that.
  *T3: `apps/web/src/components/chat/ChatComposer.tsx:2328` and
  `apps/mobile/src/features/threads/use-composer-command-menu.ts:66-67` — plan gating on
  `showInteractionModeToggle`; `apps/web/src/components/chat/ChatComposer.tsx:2234-2244, 2374-2376` — the full compact
  precondition list.*
- **Ranking.** Name match beats description match; ties break host commands → provider commands →
  skills.
  *T3: `apps/web/src/components/chat/composerSlashCommandSearch.ts:31-113` — the two-field scorer
  and the `0\0` / `1\0` / `2\0` tie-breaker.*
- **Insertion.** A provider command is inserted as `` `/name ` `` with a trailing space and the
  caret after it. A skill is inserted as `` `$name ` ``. Host commands insert nothing — they erase
  the trigger and act.
  *T3: `apps/web/src/components/chat/ChatComposer.tsx:3597-3643` — exactly these three behaviours.*
- **Argument hints** render as the row's secondary line when there is no description. There is no
  parameter form and no placeholder-stepping.
  *T3: `apps/web/src/components/chat/ChatComposer.tsx:2358` — `description ?? input.hint ??
  "Run provider command"`.*
- **What the sent message records.** Nothing. A command is ordinary message text; `/compact` is
  re-recognised by string comparison at render time and `$skill` mentions are re-chipped from the
  stored text by the same tokeniser the composer uses. No `isCommand` flag is persisted.
  *T3: `packages/shared/src/composerInlineTokens.ts:100-127` + `apps/web/src/components/ChatView.tsx:735-738` — chips and
  the compaction marker are both derived from the text.*

#### 4.6.8 Skills

A **command** is a name the provider expands; the host knows only `{name, description, hint}` and
cannot tell a built-in from a user file. A **skill** is a `SKILL.md` with a path, a scope, an
enabled flag and two invocability flags — enough to badge its source and to decide whether the user
may start it. Both live under `/`; skills also have their own `$` trigger.

- **`userInvocable: false` hides a skill from `/`.** The provider reserves it for the agent and
  would reject a user invocation.
- **`userInvocationOnly` does not hide it — it is the reason to show it.** The agent cannot start
  that skill on its own, so the `/` menu is the only way to run it. Naming it in prose does
  nothing.
- A disabled skill is never offered.
  *T3: `packages/client-runtime/src/providerSkills.ts:44-56` — `isProviderSkillUserInvocable =
  enabled && userInvocable !== false`, with that docstring.*
  *T3: `packages/contracts/src/server.ts:104-115` — both flags documented with those semantics.*
- **A skill that the provider also advertises as a command is listed once, as the skill.**
  *T3: `packages/client-runtime/src/providerSkills.ts:67-73` — `getProviderSlashCommandsForSlashMenu`
  drops any command whose name collides with a visible skill.*
- **Skills in the `/` menu are a user setting**, default on; `$` always lists them.
  *T3: `packages/client-runtime/src/providerSkills.ts:58-65` and
  `packages/contracts/src/settings.ts:448` — `showSkillsInSlashMenu`, default `true`.*
- **Invocation is `$name` on the wire for every provider; the adapter translates.** Codex parses
  `$name` natively. Claude does not, so the Claude adapter splits the prompt around the **last**
  `$skill` naming a known skill and emits `[leading text, "/name" + trailing text]` as two text
  blocks, rewriting earlier mentions to inline `/name` so the model can still start them through
  its Skill tool. An unknown `$foo` stays literal. OpenCode and Grok receive `$name` unchanged.
  *T3: `apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts:1-79` — the whole contract,
  verified against the CLI in stream-json mode: the check runs on the last text block, `/name` must
  be its first character, everything after the name (newlines included) arrives as `ARGUMENTS`,
  and only one command expands per message (anthropics/claude-code#87113).*
  *T3: there is no `GrokSkillDispatch` or `OpenCodeSkillDispatch` module — those two forward the
  chip text as-is.*

#### 4.6.9 The thing that makes forwarding work at all

Claude Code's only user-side command invocation is a text block whose **first character** is `/`.
That single fact is load-bearing for every `F` in the matrix above, and it is why Orquester never
prefixes, indents or wraps a turn whose text starts with a slash — no "Ultrathink:" prefix, no
context preamble, no `@file` expansion ahead of it. Composer context (§4.1) is flattened **after**
the command text, never before it.

*T3: `packages/shared/src/model.ts:412-431 applyClaudePromptEffortPrefix` — refuses to prepend
`Ultrathink:` when the prompt matches `/^\/[^\s/]+(?:\s|$)/u`, with the comment "Prefixing a slash
command turns it into plain prose, so Claude never runs it".*
*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:1551-1565` — that guard sits on the send
path; `apps/web/src/components/ChatView.tsx:729-730` mirrors it client-side.*
*T3: `apps/server/src/provider/model-manifest.json:26-61, 83-85` — `ultrathink` is a
`promptInjectedValues` effort level with no API equivalent (`effortMap: {ultracode:"xhigh",
ultrathink:null}`), which is why it needs a text prefix at all.*
**differs:** Orquester does not ship a prompt-injected effort level. `/effort` and the model chip
write protocol fields only — Claude `query({effort})` plus the `ultracode` setting, Codex `effort`
on `turn/start`, Grok `reasoningEffort`, OpenCode `variant` — so no turn text is ever rewritten and
the guard above is a rule rather than a workaround.
*T3: `apps/server/src/provider/Layers/ClaudeAdapter.ts:4853-4930` (Claude effort + `settings.ultracode`),
`apps/server/src/provider/Layers/CodexSessionRuntime.ts:593, 645, 657` (Codex `effort` on
`turn/start`, default `medium`), `apps/server/src/provider/Layers/GrokAdapter.ts:1567-1573`
(Grok `reasoningEffort`), `apps/server/src/provider/Layers/OpenCodeProvider.ts:175-198`
(OpenCode `variant`).*

## 5. Persistence

### 5.1 Host-owned thread directories

```
<appdir>/daemon/agent/
  threads/<sessionId>/
    meta.json          # ThreadHead, rewritten atomically every 50 events and on turn end
    events.ndjson      # append-only normalised events, per-thread monotonic `seq`
    raw.ndjson         # provider frames, rotated (§3.1)
    attachments/<id>.<ext>
  receipts.json        # commandId -> {seq, status}, ring of 500
```

*T3: `apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:8-43` — the log is one SQLite table with a global `sequence INTEGER PRIMARY KEY AUTOINCREMENT` plus a per-stream `stream_version`; differs: Orquester writes one NDJSON file per thread, so `seq` is per-thread and there is no global ordering to wait on (subscriptions are per-thread anyway); `apps/server/src/persistence/Migrations/002_OrchestrationCommandReceipts.ts:8-22` — `orchestration_command_receipts(command_id PK, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)`; differs: a bounded JSON ring, not a table*

**Two event layers, not one.** `events.ndjson` holds *domain* events — past-tense facts about the
thread — not the adapter runtime union of §4.2. Ingestion is a separate hop: the host translates
each `RuntimeEvent` into zero or more domain events before anything is persisted, so a provider
capability can change without changing the persisted shape. The persisted types are
`thread.created`, `thread.meta-updated`, `thread.runtime-mode-set`, `thread.message-sent`,
`thread.turn-start-requested`, `thread.turn-interrupt-requested`,
`thread.approval-response-requested`, `thread.user-input-response-requested`,
`thread.session-set`, `thread.activity-appended`, `thread.turn-diff-completed`,
`thread.checkpoint-revert-requested`,
`thread.reverted`, `thread.deleted`. Everything the timeline shows is one of these; there is no
persisted event per runtime event.

Every §6.2 command lands on exactly one of them: `/turn` on `thread.message-sent` +
`thread.turn-start-requested`, `/interrupt` on `thread.turn-interrupt-requested`, `/approval` on
`thread.approval-response-requested`, `/answer` on `thread.user-input-response-requested`,
`/dismiss` on `thread.activity-appended` — it appends the `user-input.resolved` activity that
closes the question (§6.2); a dismissal has no event of its own —
`/revert` on `thread.checkpoint-revert-requested` then `thread.reverted`, `/mode` on
`thread.runtime-mode-set` and/or `thread.meta-updated`, `/session/stop` and every session
transition on `thread.session-set`. `thread.meta-updated` carries `{title?, modelSelection?}` — it
is the only writer of both, which is what lets the §7 fold rebuild the head's title and model
without a second event type, and what the §6.1 `PUT` rename appends.

*T3: `packages/contracts/src/orchestration.ts:1655-1688` — the 35-member `OrchestrationEventType`; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:469-1012` — `runtimeEventToActivities`, the runtime→domain hop; `packages/contracts/src/orchestration.ts:1208-1214` + `:1808-1822` — `thread.meta.update` and `thread.meta-updated` both carry an optional `modelSelection` beside the title, so T3 has no model-set event either; `apps/server/src/orchestration/decider.ts:1753-1796` — `thread.user-input.dismiss` decides to a plain `thread.activity-appended`; differs: T3 also carries project, archive/settle/snooze/pin, proposed-plan and pull-request events this design does not*

Envelope: `{seq, eventId, threadId, type, payload, occurredAt, commandId | null,
causationEventId | null, metadata}`, where `metadata` carries `{providerTurnId?, providerItemId?,
adapterKey?, requestId?, ingestedAt?}` — the provider-shaped identifiers that must not leak into
payloads but are needed to correlate a domain event with the frame that caused it.

*T3: `packages/contracts/src/orchestration.ts:1988-1998` — `EventBaseFields`; `:1971-1986` — `OrchestrationEventMetadata`; differs: `aggregateKind`/`aggregateId`/`correlationId`/`origin` are dropped (one aggregate kind, one client identity)*

```ts
type ThreadHead = {
  id: string; projectPath: string; cwd: string; title: string;
  adapter: AgentAdapter["id"]; refId: string;          // refId = registry id (claude, claudex, codex, …)
  accountId: string; home: AccountHome;
  modelSelection: ModelSelection; runtimeMode: RuntimeMode;
  session: { status: "idle"|"starting"|"ready"|"running"|"stopped"|"error"; resumeCursor?: unknown;
             providerThreadId?: string; activeTurnId: string|null; lastError?: string };
  turnCount: number; seq: number;
  continueAfterRestart?: { turnId: string; prepared?: boolean };   // §3.3: a turn id, never a flag
  createdAt: string; updatedAt: string;
};
```

*Built: `session.resumeCursor` is a MIRROR, kept for old logs and old clients.
The authority is `threads/<id>/binding.json` (§3.3), which is not part of the
event log and is only ever merged field-wise:*

```ts
type ProviderSessionBinding = {          // threads/<threadId>/binding.json
  threadId: string; adapter: AgentAdapter["id"];
  adapterKey: string|null;               // the registry id the session launched from
  runtimeMode: RuntimeMode|null; providerInstanceId: string|null;
  status: "starting"|"ready"|"running"|"stopped"|"error";
  resumeCursor: unknown;                 // null = no resumable session
  providerThreadId: string|null; lastSeenAt: string;
};
// the ONLY writer; undefined = unchanged, null = cleared
upsertSessionBinding({ threadId, adapter, patch: Partial<ProviderSessionBinding> }): Promise<…>
```

*T3: `packages/contracts/src/orchestration.ts:599-609` — `OrchestrationSession {threadId, status: idle|starting|running|ready|interrupted|stopped|error, providerName, providerInstanceId?, runtimeMode, activeTurnId, lastError, updatedAt}`; `apps/server/src/persistence/ProviderSessionRuntime.ts:36-53` — the resume cursor is a `Schema.NullOr(Schema.Unknown)` blob each adapter writes and parses itself; differs: T3 has no `turnCount` on the head at all — it recomputes it as the maximum `checkpointTurnCount` over the thread's checkpoints, and drops the `interrupted` session status this design folds into `stopped`*

The projected timeline is a fold over `events.ndjson`. Items are one of two shapes:

```ts
type ThreadItem =
  | { kind: "message"; id; role: "user"|"assistant"|"reasoning"; text; attachments?; context?; turnId; agentId?; streaming; createdAt; updatedAt }
  | { kind: "activity"; id; tone: "info"|"tool"|"approval"|"error"; activityKind: string;  // open string at THIS layer
      summary; payload: unknown; turnId; agentId?; parentToolUseId?; status?; createdAt; updatedAt };
```

Reasoning is a sibling message with its own role, never a part of the assistant message.
`context` is the composer-chip record set persisted beside a user message for re-render only
(§4.1); it binds attachments by id and never holds bytes.

*T3: `packages/contracts/src/orchestration.ts:554-565` — `OrchestrationMessage {id, role: user|assistant|system|reasoning, text, attachments?, context?, turnId, streaming, createdAt, updatedAt}`; `:641-650` — `OrchestrationThreadActivity {id, tone, kind (open string), summary, payload (unknown), turnId, sequence?, createdAt}` — `kind` and `payload` are deliberately not a literal union; differs: no `system` role, and `agentId`/`parentToolUseId`/`status` are promoted out of the payload so the subagent roster folds without decoding it*

**Message identity and the streaming merge.** A message id is minted by the host, not by the
provider: `assistant:<itemId ?? turnId ?? eventId>` for the first segment of a turn and
`assistant:<baseKey>:segment:<n>` for later ones, with the `reasoning:` prefix and a
`summary:`/`raw:` stream key for reasoning, so a provider that streams a summary and a raw chain of
thought over one item gets two messages. A delta appends a `thread.message-sent` carrying **only
the new text** with `streaming: true`; the fold concatenates onto the existing id. A completion
appends the same event type with empty text and `streaming: false`; empty text keeps the
accumulated body, non-empty text replaces it. There is no separate delta event type.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:282-308` — segment base keys and the `assistant:` / `reasoning:` id namespaces; `apps/server/src/orchestration/decider.ts:1914-1979` — both `*.delta` and `*.complete` commands emit `thread.message-sent`; `apps/server/src/orchestration/projector.ts:777-799` — append when `streaming`, keep-on-empty / replace-on-non-empty when not*

**Turn model.** `turnId` is the provider's own turn id, stringified — never host-minted. Between a
`/turn` command and the provider's first `turn.started` the turn exists as a pending row with no
turn id. A turn is settled **by the fold from session status**, not by `turn.completed`: leaving
`running` for `idle`/`ready` settles it `completed`, for `stopped` `interrupted`, for `error`
`failed` (the §4.2 `turn.completed` vocabulary, which is the only one used for turn state); `starting` and `running` leave it unsettled. That is what keeps a late checkpoint or diff
from extending the recorded duration. A runtime `waiting` state maps to session status `running` —
`waiting` is a derived UI state from an unresolved request, never a stored status.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:147-149` — `TurnId.make(String(event.turnId))`; `apps/server/src/persistence/Layers/ProjectionTurns.ts:99-131` — the `turn_id IS NULL, state='pending'` row; `apps/server/src/orchestration/projector.ts:101-115` — `settledTurnStateForSessionStatus`; `:808-868` — the `thread.session-set` fold that drives `latestTurn`; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:376-398` — `orchestrationSessionStatusFromRuntimeState` collapses `waiting` into `running`*

**Ingestion rules** (which runtime event becomes what, enforced once in the host so no adapter
decides it):

- `content.delta` of `assistant_text` → a buffered assistant message; of `reasoning_text` /
  `reasoning_summary_text` → a buffered reasoning message. `plan_text` → the proposal buffer.
- `item.started` / `item.updated` / `item.completed` become `tool.started` / `tool.updated` /
  `tool.completed` activities **only for the tool-shaped item types**. `user_message`,
  `assistant_message`, `reasoning`, `plan`, `context_compaction`, `error` and `unknown` items are
  dropped from the activity path — they are already represented as messages or as their own events.
- `request.opened` / `request.resolved` become `approval.requested` / `approval.resolved`
  activities, except `tool_user_input`, which is dropped because it is a question, not an approval.
  The provider's native request type is rewritten to the canonical kind
  (`command_execution_approval`/`exec_command_approval` → `command`; `file_read_approval` →
  `file-read`; `file_change_approval`/`apply_patch_approval` → `file-change`;
  `mcp_elicitation_approval` → `mcp-elicitation`; `permission_approval` → `permission`) and **both**
  the canonical kind and the raw `requestType` are persisted, so a row written by an older adapter
  is still classifiable.
- `session.*`, `thread.started` and `runtime.error` become `thread.session-set` with the mapped
  status; `runtime.error` additionally appends a `runtime.error` activity.
- `thread.token-usage.updated` becomes a `context-window.updated` activity, dropped when
  `usedTokens` is negative.
- `thread.metadata.updated {name}` retitles the thread only when the title is still
  auto-generated — a manual rename is never overwritten by the provider.
- `task.*` become `task.*` activities carrying the whole linkage bundle (`agentKind`, `agentId`,
  `parentAgentId`, `toolUseId`, `title`, `model`, `status`, `outputFile`, …) on **every** row, so
  the roster fold survives activity retention even if the `task.started` row aged out.
- `turn.diff.updated` produces a placeholder checkpoint; the real one comes from §5.4.
- Everything else the timeline renders — `turn.plan.updated`, `turn.proposed.delta|completed`,
  `hook.*`, `tool.progress`, `tool.denied`, `model.rerouted` and `runtime.warning` — becomes a
  `thread.activity-appended` row carrying that event's payload and its `turnId`/`agentId`, which is
  how every §7.3 row kind reaches disk. `auth.status` and `account.rate-limits.updated` are not
  thread facts: they update the provider snapshot (§6.3) and surface in §7.7.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:480-540` — approval activities and the `tool_user_input` drop; `:400-419` — `requestKindFromCanonicalRequestType`; `:909-1010` — item lifecycle gated on `isToolLifecycleItemType`; `:889-907` — token usage; `:2437-2449` — title only when not manual; `:423-462` — `taskLinkageActivityFields`; `packages/contracts/src/providerRuntime.ts:116-135` — `ToolLifecycleItemType` as a named subset of `CanonicalItemType`*

Pending approvals and questions are derived from the activity fold, never stored separately. The
fold keeps a tombstone set: a `*.resolved` row — including the `user-input.resolved` row that
`/dismiss` appends for a `dismissible` question (§6.2) — closes the request id permanently, so a
`*.requested` row that arrives out of order can never reopen it, and a `provider.*.respond.failed`
row closes it only when its detail says the request was stale or unknown — any other failure leaves
it open so the user can retry. A question with no decodable option and no custom-answer flag is
dropped rather than shown as an unanswerable card.

*T3: `packages/client-runtime/src/pendingRequests.ts:122-186` — `derivePendingRequests` with `closedApprovals`/`closedUserInputs`; `:89-120` — the six request activity kinds and the stale-failure fragments; `:67-87` — `parseQuestions` drops questions with no usable options*

The full activity payload is persisted and `slimPayload()` runs before anything goes on the wire —
with one exception: a `tool.updated` row is persisted **already slimmed**. A streaming update's
`data` carries the whole tool output accumulated so far and a new row is written per chunk, so
persisting it verbatim writes O(N²) bytes for one tool call; the matching `tool.completed` row
persists the full payload and is the one a "load full output" fetch reads.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:909-916` — the O(N²) comment and `projectActivityPayload` applied at write time for `item.updated`; `:948-979` — `item.completed` persists the full payload*

Checkpoints, turns and the subagent roster are also folds. The fold retains the last 500 activities
per thread, plus every unresolved async question and any long-lived singleton row regardless of
age, so a chatty turn cannot scroll a still-open question out of the pending set.

*T3: `apps/server/src/orchestration/projector.ts:59-87` — `MAX_THREAD_MESSAGES = 2_000`, `MAX_THREAD_CHECKPOINTS = 500` and `retainThreadActivities`' 500-row window with pending-question retention*

*Built: the retention keeps the last 500 **parent-visible** activities plus every unresolved async
question and every agent's launch/terminal row (`task.started` / `task.completed` stamped
`agentKind: "agent"`), and **nothing else** — the "any long-lived singleton row regardless of age"
clause has no Orquester row behind it. Agent-owned rows (`agentId` set: a subagent's own tool calls,
a background shell's output) sit outside that window with their own, per-agent window of 200 and a
2 000-row ceiling across agents (`AGENT_ACTIVITY_RETENTION_LIMIT`, `AGENT_ACTIVITY_TOTAL_LIMIT`):
this design forwards a subagent's tool rows into the parent's log for the drill-in, which T3 does
not, and counting them against the parent's 500 evicted the parent's own rows — and the agents'
launch rows, which re-anchored every agent's timeline row on whatever progress tick survived, at
the bottom of the conversation (owner incident 2026-09-22). T3's counterpart retains its `WORKTREE_SETUP_ACTIVITY_KIND`, a worktree-setup
record this design has no analogue for (per-thread worktrees are a §2 non-goal), so the clause is
an artefact of the port rather than a requirement
(`packages/api/src/agent-chat/fold.ts`, `activitiesToDrop`). Also: `meta.json` is rewritten every
50 events **and on every head-shaped change**, not only on turn end — a head the stream can serve
is worth more than the write it saves
(`apps/daemon/src/agent-host/orchestration/orchestrator.ts`).*

A thread directory that fails to parse marks that thread `error` with the parse message; it
never affects other threads or host startup. A malformed line inside `events.ndjson` truncates the
fold at that point rather than discarding the file.

**Receipts.** Every command carries a client-minted `commandId`; the host writes the receipt in the
same step that appends the events, so a receipt never exists for events that did not land. A repeat
of an **accepted** commandId replays its `seq` without re-running the command. A repeat of a
**rejected** one is answered with the recorded rejection, not re-run — a retry must not turn a
validation failure into a second attempt. A commandId whose receipt names a different thread is a
hard conflict: a receipt proves only that this exact command was handled.

*T3: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144-172` — receipt lookup, `OrchestrationCommandIdConflictError`, accepted-replay and `OrchestrationCommandPreviouslyRejectedError`; `:273-320` — events, projections and the receipt commit in one transaction, with publication strictly after commit; `:392-404` — rejected receipts are persisted too*

**Attachments.** Bytes live under `attachments/`, never in an event and never inline on the wire;
an event carries `{id, name, mimeType, sizeBytes}` only. Ids are `<threadSegment>-<uuid>[-<ext>]`
with the thread segment sanitised to `[a-z0-9_-]`, so an id names its owning thread and a
traversal-shaped name cannot survive. An upload made before the thread exists uses a reserved
`pending` segment and is swept after 24 h; a `.part` file left by an interrupted upload is swept
after 1 h. The count, size and mime bounds are §4.1's, validated against the stat'd file after the
body lands, not against the declared size.

*T3: `apps/server/src/attachmentStore.ts:14-27` — id pattern, the reserved `pending` segment, 24 h / 1 h TTLs; `:83-89` — `createAttachmentId`; `packages/contracts/src/orchestration.ts:165-168` — `PROVIDER_SEND_TURN_MAX_{INPUT_CHARS,ATTACHMENTS,IMAGE_BYTES,FILE_BYTES}`; `apps/server/src/orchestration/Normalizer.ts:168-293` — a pre-uploaded file is **copied**, not hard-linked, into the thread namespace so an agent editing it in place cannot mutate the retry source*

### 5.2 Daemon-owned tab records

`sessionRecordSchema` in `packages/config` gains `kind: "agent-chat"` and an optional block:

```ts
chat: z.object({
  threadId: z.string(),            // equals the session id; kept explicit for clarity
  accountId: z.string(),
  home: z.enum(["system", "account", "cliproxy"]),
  lastSeq: z.number().int().nonnegative().default(0)
}).optional()
```

Parsed entry-wise tolerantly (the `parseRecentProjectsConfig` pattern): a bad chat record drops
that one session, never the index, because an unparseable index disables orphan reaping for every
terminal. `sessions.json` remains tab metadata only; the host is the source of truth for thread
state.

*T3: `packages/contracts/src/orchestration.ts:862-919` — the `ThreadShell` / thread-detail split, the same "the list view never pays for a thread's body" rule this record encodes*

**Migration.** Records with `kind: "agent"` and a live `orq-*` tmux session are legacy terminals:
reattached as terminals until closed, shown with a small "legacy terminal" tag. Records with
`kind: "agent"` and no live session are forgotten. The `"agent"` kind and the terminal launch path
for agents are removed in a follow-up once no legacy record exists.

### 5.3 Registry changes

`packages/registry`: agent entries gain `chat: { adapter: "claude"|"codex"|"opencode"|"grok" }`.
claudex and claudemix map to `claude` with their launcher env. gemini, kimi, agy, cline and
deepcode are removed. `resumeArgs`, `canResumeAgent` and the TUI-specific flags stay only for as
long as legacy terminals exist. The resume picker (`agent-conversations.ts`) is unchanged: a
picked conversation's `(home, id)` becomes the initial resume cursor of a new chat thread, which
also makes cliproxy-home conversations resumable for the first time since the adapter resumes
under the same home rather than through `resumeArgs`.

The cursor is the provider's own session id and nothing else — the host never replays a transcript
into a provider. The event log is the record for *rendering*; the provider's own session file is
the record for the *model's context*, and the two can diverge, which is why a revert has to
coordinate both (§5.5). The cursor is refreshed on every `sendTurn` and is **cleared** when the
restart was caused by a model change, because a cursor from the previous model is not resumable.

*T3: `apps/server/src/persistence/ProviderSessionRuntime.ts:36-53` — `resumeCursor` as an opaque per-adapter blob on the session runtime row; `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:783-806` — the cursor is passed on restart and dropped on a model-change restart*

### 5.4 Checkpoints

One hidden ref per turn: `refs/orquester/checkpoints/<base64url(threadId)>/turn/<n>`. Nothing
touches the user's branch, HEAD or visible reflog. Non-git projects skip checkpoints silently.

*T3: `apps/server/src/checkpointing/Utils.ts:4-10` — `refs/t3/checkpoints/<base64url(threadId)>/turn/<turnCount>`; `apps/server/src/checkpointing/CheckpointStore.ts:104-121` — checkpoint ops resolve through the VCS driver, and a non-git workspace declines with `VcsUnsupportedOperationError`*

Capture uses an **isolated temporary index** placed inside the repository's git common dir (not
`TMPDIR`, so it shares the object store and survives `ProtectSystem=strict`):
`GIT_INDEX_FILE=<gitCommonDir>/orq-checkpoint-index-<uuid>`, plus fixed
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` identity so a capture never depends on the user's git config.
The sequence is `git add -A -- .` → `git write-tree` → `git commit-tree` → `git update-ref`. Both
the temp index and its `.lock` are removed in a `finally`, because a forced process termination
leaves the lock behind and poisons the next capture. Writes go through
`-c core.fsync=objects,reference -c core.fsyncMethod=fsync`: git renames loose objects and refs
into place without fsync by default, and an unclean restart then leaves 0-byte files under the
checkpoint ref namespace that break every later fetch and push.

*T3: `apps/server/src/vcs/GitVcsDriver.ts:768-792` — temp index in `resolveGitCommonDir`, identity env, `.lock` cleanup; `:755-765` — the `durableWrite` fsync flags and the 0-byte-ref rationale; `:996-1034` — `write-tree` / `commit-tree` / `update-ref` with empty-oid guards*

Three capture hazards are handled rather than ignored:

- **Untracked embedded repositories.** `git add` refuses to stage a nested repo that has no commit
  yet. Staging is retried once with those directories excluded, discovered from
  `git ls-files --others --exclude-standard` and probed with the parent's git env variables
  explicitly unset so the probe sees the child's repository, not the host's. The retry is bounded
  at 64 candidate directories and 5 s total; past either bound the original failure stands.
- **Sparse checkouts.** The live index is reused where possible (copied, then `read-tree --reset
  HEAD` with the racy timestamp restored) so present-but-skipped files are not published as
  deletions; a non-cone sparse checkout that cannot be rebuilt fails the capture instead of
  recording false deletions.
- **Ignored files** are never staged — `-A` respects `.gitignore`, so a checkpoint is the tracked
  plus untracked-nonignored tree, which is also what the diff shows.

*T3: `apps/server/src/vcs/GitVcsDriver.ts:916-985` — nested-repo exclusion retry with `CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64` and `CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds"` (`:382-384`); `:797-916` — index reuse, racy-timestamp preservation and the non-cone sparse refusal*

Every git process runs under a shared permit pool of 8 with a 30 s timeout and a 1 MB default
output cap; checkpoint-capture commands additionally retry twice, 75 ms apart, on a transient
`.lock`/`ENOENT` exit, because a concurrent user-run git command holds the same locks. Diff output
is capped at 10 MB.

*T3: `apps/server/src/vcs/VcsProcess.ts:56-63` — `DEFAULT_TIMEOUT_MS = 30_000`, `DEFAULT_MAX_OUTPUT_BYTES = 1_000_000`, `VCS_PROCESS_CONCURRENCY = 8`; `:118-119`, `:205-227` — the semaphore and the capture-only retry; `apps/server/src/vcs/GitVcsDriver.ts:385` — `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000`*

*Built: the retry is decided by an explicit `retryTransient` flag on each git invocation rather
than by matching the operation's name, so a new capture-path command cannot silently lose the
retry by being spelled differently. Every git child additionally runs with `LC_ALL=C` (a localised
`git` translates the porcelain the parser reads) and `GIT_TERMINAL_PROMPT=0` (a repository with an
HTTPS remote must never block a checkpoint on a credential prompt), and `--numstat -z` output is
sorted by **byte order**, not by locale collation, so a checkpoint's file list is byte-stable on
any machine (`apps/daemon/src/agent-host/checkpoints/service.ts`).*

Lifecycle:

- On `turn.started`: capture the baseline at `turn/<turnCount>` if absent, where `turnCount` is the
  highest checkpoint turn count the thread already has — the counter is derived from the
  checkpoints, never stored independently, so a lost `meta.json` cannot desynchronise it.
- On `turn.completed` / `turn.aborted`: capture `turn/<turnCount+1>`, run
  `git diff --numstat -z <baseline> <post>`, append `thread.turn-diff-completed {turnCount, turnId,
  ref, status, files: [{path, additions, deletions}], assistantMessageId, completedAt}`. Only the
  session's active turn may produce a completion checkpoint, and a turn that already has a
  non-placeholder checkpoint is skipped; a placeholder left by `turn.diff.updated` is **reused at
  its own turn count** rather than incremented past. A missing baseline (git was initialised during
  the turn) keeps the post ref and records an empty file list rather than inventing a baseline. A
  late diff never extends the turn's recorded duration; the turn is settled by the fold from
  session status (§5.1).
- Success appends a `checkpoint.captured` activity; a capture or diff failure appends
  `checkpoint.capture.failed` and never fails the turn.
- On thread delete: all refs under the thread's prefix are deleted, together with the thread
  directory and its attachments.
- Cap: at most 200 checkpoint refs per thread; older ones are pruned oldest-first.

*T3: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:461-510` — baseline capture keyed on the max `checkpointTurnCount`; `:393-457` — active-turn guard, non-placeholder skip, placeholder turn-count reuse; `:259-332` — missing-baseline handling and the `--numstat` file list; `:337-390` — the `thread.turn.diff.complete` dispatch and the `checkpoint.captured` activity; `:150-180` — `checkpoint.capture.failed`; `apps/server/src/orchestration/projector.ts:934-944` — a `missing` placeholder never clobbers a captured `ready` checkpoint. Differs: T3 deletes checkpoint refs only on revert — nothing deletes them when a thread is deleted — and caps checkpoints at 500 in the read model (`apps/server/src/orchestration/projector.ts:60`) rather than pruning refs on disk*

*Built: ref deletion — on prune, on revert and on thread delete — is **batched** into one
`git update-ref --stdin` instead of one process per ref. Two hundred refs is two hundred process
spawns under a permit pool of eight, which turns deleting a thread into a visible stall
(`apps/daemon/src/agent-host/checkpoints/service.ts`).*

Diff read: `GET …/turns/:n/diff` runs
`git diff --patch --no-color --no-ext-diff --no-textconv <baseline>^{commit} <post>^{commit}` on
demand, with `--ignore-all-space` on by default. `from === to` short-circuits to an empty diff
without touching git, and a turn above the thread's highest checkpoint is a 404 rather than an
empty result. Results are cached in memory keyed by `(threadId, fromTurnCount, toTurnCount,
ignoreWhitespace)`; the cache is derived state and is dropped freely.

*T3: `apps/server/src/vcs/GitVcsDriver.ts:1147-1180` — the diff flags and `^{commit}` peeling; `apps/server/src/checkpointing/CheckpointDiffQuery.ts:81-140` — `ignoreWhitespace` defaults to true, the equal-turn short-circuit and the range check; `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts:7-21` — `checkpoint_diff_blobs(thread_id, from_turn_count, to_turn_count)` as a recomputable cache; differs: in memory, not on disk*

### 5.5 Revert (conversation only)

Triggered from a user message's "rewind to here" affordance with `targetTurnCount`:

1. Resolve the thread and recompute `currentTurnCount` as the highest checkpoint turn count.
   Reject if `targetTurnCount > currentTurnCount` or a turn is active.
2. `assertRollbackSupported` on the adapter, **before anything on disk is touched**; Grok refuses
   with a clear message.
3. `adapter.rollbackThread(threadId, currentTurnCount - targetTurnCount)`, skipped when that
   difference is zero.
4. Delete every checkpoint ref whose turn count is above the target.
5. Append `thread.reverted {turnCount: target}`; the projector truncates and rewrites `meta.json`.
6. Any failure is appended as an `activity` with tone `error`, not raised as a modal.

*T3: `apps/server/src/orchestration/Layers/CheckpointReactor.ts:771-915` — `handleRevertRequested` in exactly this order: turn-count check, `assertConversationRollbackSupported`, rollback, stale-ref delete, `thread.revert.complete`; `:118-148` — every failure becomes a `checkpoint.revert.failed` activity. Differs: T3 reverts through one `thread.checkpoint-revert-requested` event carrying `restoreFiles?`, with `thread.conversation.revert` as a **separate client command** so an older server rejects a history-only rewind rather than silently restoring files (`packages/contracts/src/orchestration.ts:1368-1380`, `:1916-1921`); this design has only the conversation-only path, so the flag and the isolated-worktree guard (`apps/server/src/orchestration/Layers/CheckpointReactor.ts:826-835`) do not exist*

*Built: **turn counts are turn ORDINALS, never checkpoint counts.** Step 1 counts
`startedTurns(turns)` — the fold's turn rows that got a provider turn id, in order
(`packages/api/src/agent-chat/turns.ts`) — and `targetTurnCount` means "keep the first N of
them". The checkpoint list is not the counter: it is sparse exactly where a rewind matters (nothing
on a non-git project, a skipped capture, no checkpoint at all for the history of a thread resumed
from the provider's transcript — the owner's 28-turn thread had two, numbered 1 and 2), and while it
was the counter the affordance never appeared on a real thread. Checkpoints are numbered by the same
ordinal (§5.4's refs are `turn/<ordinal>`; sparse refs are expected, and `readTurnDiff` already
falls back to HEAD for a missing baseline). Step 3 hands the adapter the cut **by turn id** as well
as by count (`RollbackTarget {firstRemovedTurnId, droppedTurnIds, retainedTurnIds}`,
`apps/daemon/src/agent-host/adapter.ts`): Claude resolves ids through its transcript uuids (the
cursor's `turnBoundaries`, our turn id paired with the native uuid and remapped on every fork),
Codex sends `thread/revert {beforeTurnId}`, OpenCode looks the turn up in its message list; an id an
adapter cannot place is a refusal, never a guess, and the count is only the fallback for a caller
that predates the id. The affordance maps a user message to its turn through `Turn.userMessageId`
(the `messageId` of its `thread.turn-start-requested`; absent on a turn the fold synthesises from
session status, such as a `/compact`), and is withheld for a message that sits before the thread's
last compaction marker (the provider no longer holds what the rewind would restore, §4.5) and for
the `/compact` message itself. The truncation keeps the first `target` started turns' rows —
messages by `turnId` or by `userMessageId`, activities by `turnId` — and the checkpoint-count rule
survives only as the fallback for a log with no turn rows. After the host has truncated the thread
the client returns the rewound message, text and attachment chips, to the composer for editing (T3's
"Edit from here"; the CLI's own rewind does the same), holding `reverting` — §7.5's one `inert`
reason — for the whole wait. Two consequences for the compaction gate: the marker is exempt from
§5.1's 500-row activity window (a busy thread evicted it within minutes, after which every
pre-compaction message was offered for a rewind the adapter could only refuse), and Claude decides
"compacted in between" by the anchor's position relative to the transcript's last
`isCompactSummary` row, falling back to `preserved_messages.all_uuids` only for an anchor before it
— that list names the pre-compaction rows the CLI kept, never the rows written afterwards, so read as
the set of reachable anchors it refused every rewind after a live `/compact` (fixtures README
observation 21). A `user` row the provider's transcript wrote itself (a slash-command echo, a
subagent's notification) is withheld too: a rewind would hand it back as the user's own prompt.*

Truncation is by **retained turn id**, not by timestamp: keep checkpoints with
`checkpointTurnCount <= target`, take their turn ids as the retained set, then keep every message,
activity and roster row whose `turnId` is in that set. Rows with `turnId: null` survive — a message
persisted before the provider minted its turn id would otherwise vanish. Because of that, a second
pass restores up to `target` user messages and up to `target` assistant messages in `createdAt`
order if the first pass retained fewer, so a revert never leaves the thread showing fewer turns
than it reverted to. `latestTurn` is recomputed from the last surviving checkpoint.

*T3: `apps/server/src/orchestration/projector.ts:985-1030` — the `thread.reverted` fold; `:209-277` — `retainThreadMessagesAfterRevert` including the turn-less fallback passes; `:280-294` — activities and plans are kept when `turnId === null` or retained*

*Built: the implementation follows T3 exactly, which is narrower than the sentence above for
**messages**. An activity or turn row with `turnId: null` does survive unconditionally; a
**message** with `turnId: null` survives only through the bounded second pass — up to `target`
user and up to `target` assistant messages in `createdAt` order — never as a blanket rule. An
unbounded "every turn-less message survives" would resurrect the prompts of the turns the revert
just undid, because a message persisted before its provider turn id was minted looks identical
whichever side of the target it fell on (`packages/api/src/agent-chat/fold.ts`,
`retainMessagesAfterRevert`).*

Attachments referenced only by truncated messages are unlinked after the revert commits, not
during it: the retained path set is recomputed from the surviving messages and from any answered
question that carried attachments, and only then is anything removed. The sweep has its own cursor
so a failed unlink is retried without replaying committed text.

*T3: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:1997-2020` — retained paths recomputed from current messages plus `user-input.answer-submitted` activities; `:2119-2169` — the separate `projection.attachment-cleanup` cursor and the deferred `thread.reverted` / `thread.deleted` sweep*

Files are never touched. The user discards working-tree changes through the git tab if wanted.

### 5.6 Batching and slimming

This section states the batching, coalescing and slimming numbers once; §6.3 and §3.1 reference
them. Assistant, reasoning and plan deltas buffer per message and flush every 250 ms or 8 KB,
whichever first, preferring a paragraph or closed-fence boundary so a flush never splits a code block.
Command and file-change output deltas use the same buffer keyed by item id. The buffer is a write
reducer, not just a wire one: it is upstream of `events.ndjson`, so a token-by-token provider
becomes a few appended events per second per message.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:117-122` — `MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400`, `MAX_BUFFERED_ASSISTANT_CHARS = 24_000`; `:1325-1370` — paragraph-mode split, pacing check and the over-budget flush valve; differs: 250 ms / 8 KB here, chosen for a single-user host with a much shorter round trip*

Two flush points are mandatory rather than opportunistic: a `request.opened` and a blocking
`user-input.requested` **flush and finalise** the buffered assistant and reasoning text for that
turn before the request activity is appended, or the approval banner appears above text the agent
had already produced; and a tool `item.started` closes the active reasoning segment, or post-tool
thinking is appended to a block that already sits above the tool row.

*T3: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:2075-2127` — `pauseForUserTurnId` flush and finalise; `:2139-2153` — the tool-start reasoning finalisation and its rationale*

`item.updated` coalesces to the latest per stable tool-call id **within the same turn** inside a
50 ms window, capped at 512 pending rows; a call with no stable id passes through unchanged
(labels are not unique under parallel tool use), and any non-update event closes the window
immediately so ordering is preserved. On a snapshot, a `tool.updated` row that a later
`tool.completed` in the same turn supersedes is dropped outright, and all but the newest
`context-window.updated` per turn are dropped. Both matchings are per turn because a live
`thread.reverted` makes the client discard whole turns, and a completion in a different turn could
vanish and leave the dropped update unrepresented.

*T3: `apps/server/src/orchestration/ThreadLiveEventCoalescer.ts:18-19` — `COALESCE_WINDOW = 50ms`, `MAX_PENDING_UPDATES = 512`; `:51-94` — latest-per-identity retention with anonymous pass-through; `:183-196` — a non-update event closes the run; `apps/server/src/orchestration/ActivityPayloadProjection.ts:578-643` — `dropSupersededToolUpdatedActivities` and the per-turn rationale; `:530-547` — `dropStaleContextWindowActivities`*

Slimming caps any string in an activity payload at 16 KB on the wire and keeps the full value on
disk; the UI shows a "load full output" action that fetches the item by id. On top of that cap,
`payload.data` is rebuilt from an allowlist rather than truncated in place, because the size is in
the structure, not in one long string:

- An MCP tool call keeps `type, id, tool, server, status, arguments, appContext, error, durationMs`
  and nothing else; its `result` is reduced to a one-line summary.
- Tool text output is summarised to the first meaningful line, elided at 84 characters, or to
  `"N lines"` when there is no single renderable line.
- Changed files are collected as a path list, at most 12 entries and 4 levels deep.
- A payload whose top-level `status` is `completed` while its nested item status is `failed` or
  `declined` is re-stamped with the item status, so a failed tool never renders as a success.

*T3: `apps/server/src/orchestration/ActivityPayloadProjection.ts:190-207` — `MCP_ITEM_KEPT_FIELDS`; `:164-188` — `summarizeToolTextOutput` (84 chars / `"N lines"`); `:24-81` — `collectChangedFiles` with the 12-path / depth-4 bounds; `:425-500` — the allowlist rebuild and the status re-stamp; `:645-689` — `projectThreadDetailSnapshot` / `projectActivityEvent`, the single choke point every read passes through. Differs: T3 has no route that serves the unslimmed payload at all — the full value is only ever read back out of its own store*

*Built: `changedFiles` is promoted to the **top level** of the slimmed payload rather than left
inside `data`. It is one of the allow-listed fields §7.2's presentation resolver reads, and a
resolver that has to reach into `data` for one of its own inputs is a resolver that will one day
read an unslimmed shape by accident (`packages/api/src/agent-chat/slim.ts`). The 16 KB string cap
is measured in **UTF-8 bytes**, never splitting a surrogate pair, and returns the input by
identity when it already fits.*


## 6. Routes and stream

All chat routes are under `/api/sessions/:id/` and are proxied by the daemon to the host. They
inherit bearer auth on HTTP, no auth on the unix socket, the SPA fallback exclusion and the
service worker bypass, all unchanged.

The split of the surface follows T3's: every mutation is one small idempotent command, and bulk
reads plus large compressible payloads go over plain HTTP so they compress and never occupy the
subscription. What differs is the carrier — T3 runs both commands and subscriptions as Effect RPC
over one WebSocket per environment; here commands are ordinary REST posts and the subscription is
one chunked NDJSON response per open thread.

*T3: `apps/server/src/ws.ts:3730-3812` — one authenticated Effect-RPC WebSocket per environment, JSON serialization at `:3769`; differs: REST + per-session NDJSON here; `packages/contracts/src/environmentHttp.ts:508-539` — the parallel HTTP snapshot/dispatch API; `:541-542` — "large, compressible payloads travel over HTTP rather than the RPC socket"*

**Auth.** T3 authenticates once at socket upgrade and then re-checks a per-method scope, so
authenticating a connection does not authorize every call on it. Orquester is single-user with one
credential, so the existing bearer check is the whole policy and no scope table is introduced. The
chat stream is opened with `fetch` and an `Authorization` header like every other `/api` call; it
does **not** get the `?token=` carve-out that `/ws` and `/api/fs/download` have, because nothing
here is fetched by a bare browser navigation.

*T3: `apps/server/src/ws.ts:3738-3750` — auth at upgrade; `apps/server/src/orchestration/http.ts:100` — `requireEnvironmentScope(AuthOrchestrationOperateScope)` per method; differs: no scopes, one password*

### 6.1 Lifecycle (existing routes)

`POST /api/sessions` with `kind: "agent-chat"`, `refId`, `projectPath`, `cwd`, `accountId`,
`modelSelection`, `runtimeMode`, and optional `resume: {home, conversationId}`. The daemon
validates the account and model exactly as it does for terminals today (seeded-account gate,
`missingModels`), writes the tab record, then asks the host to create the thread. `DELETE`,
`PUT` (rename), `POST /reorder` and `POST /upload` are unchanged; upload's returned path is the
attachment reference.

`PUT` is the thread-title route: a client-set title and a request to regenerate one are mutually
exclusive, and the title is thread head state, not a chat command. `DELETE` cascades — the host
settles pending requests, stops the provider child, prunes every checkpoint ref under the thread's
prefix (§5.4) and removes the thread directory. There is no archive state; a closed tab whose
record is gone is gone.

A `resume` the adapter cannot use — an id that fails the host's own shape check, or an adapter with
no resume path for that home — is refused at creation with 400 `RESUME_UNAVAILABLE` rather than
opening a fresh thread the user believes is their old one. This is the only route that answers that
code; no §6.2 command does.

*T3: `packages/contracts/src/orchestration.ts:1208-1226` — `thread.meta.update` carries `title` / `regenerateTitle` / `modelSelection` with a filter refusing title+regenerate together; `:1111-1115` — `thread.delete`; `:1117-1121` — `thread.archive`, differs: no archive state here*

*Built: `PUT` takes `title` and nothing else — there is no `regenerateTitle` path on the route, in
the host or in any client surface, so the mutual-exclusion rule has nothing to enforce
(`apps/daemon/src/agent-host/server/http-server.ts`). A title is generated once, client-side, from
the thread's first user message (`packages/ui/src/lib/agent-chat/title.logic.ts`); T3 then
improves it with a separate model call, which this design does not do. Regeneration is a follow-up,
and the rule above is what it must honour when it lands.*

Thread creation is two calls (create the tab, then `/turn`), not one. T3 folds thread creation,
worktree preparation and the first turn into a single `bootstrap` field on `thread.turn.start` so
"new thread from the composer" is one idempotent dispatch. We keep two because the tab record is
daemon-owned and the thread is host-owned; the ordering is fixed — the tab record is written first,
so a failed first turn leaves an empty thread the user retries into rather than a half-created tab.

*T3: `packages/contracts/src/orchestration.ts:1270-1284` — `ThreadTurnStartBootstrap` (`createThread` / `prepareWorktree` / `runSetupScript`); differs: two calls here, tab record first*

*Built: an existing thread's account is changed through **`POST /api/sessions/:id/account`**
`{commandId, accountId}` → `{seq}`, which is a **lifecycle** route, not a §6.2 command — see the
note at the end of §6.2 for why it cannot be one. It applies the same gates a create does (the
registry entry's family, the seeded-account gate, the launch-env recompose, the Claude project
trust) and then calls the host's `POST /threads/:id/identity`; on success the tab record moves
(`ChatSessionManager.setAccount` → `session.updated`), so `sessions.json`, the tab badge and
`liveAccountIds()` stay right. It answers the §6.2 codes — 400 `INVALID_COMMAND`, 404, 409
`COMMAND_REJECTED`, 503 `HOST_UNAVAILABLE` — because the client folds it into the same
command-rejection surfaces (`apps/daemon/src/agent-chat/{service.ts,proxy-routes.ts}`).*

### 6.2 Commands (new, POST, JSON, all carry `commandId`)

| Route | Body | Effect |
|---|---|---|
| `/turn` | `{commandId, input, attachments?, interactionMode?, modelSelection?}` | start a turn, or steer the active one |
| `/interrupt` | `{commandId, turnId?}` | settle pending requests, interrupt; with no running turn it stops the thread's live background work (§7.6) |
| `/approval` | `{commandId, requestId, decision}` | answer an approval |
| `/answer` | `{commandId, requestId, answers, attachmentsByQuestionId?}` | answer a question; attachments are folded into the answer text |
| `/dismiss` | `{commandId, requestId}` | close a dismissible question without answering it |
| `/revert` | `{commandId, targetTurnCount}` | §5.5 |
| `/compact` | `{commandId}` | adapter compaction |
| `/mode` | `{commandId, runtimeMode?, modelSelection?}` | apply per §3.4 |
| `/session/stop` | `{commandId}` | stop the provider child, keep the thread |

*T3: `packages/contracts/src/orchestration.ts:1394-1423` — the 28-member `ClientOrchestrationCommand` union every mutation goes through; `:1286-1326` `thread.turn.start` (server and client variants), `:1328-1334` `thread.turn.interrupt` (optional `turnId`), `:1336-1343` `thread.approval.respond`, `:1345-1353` `thread.user-input.respond`, `:1355-1364` `thread.user-input.dismiss`, `:1366-1379` the revert pair, `:1381-1392` `thread.session.stop`; differs: one HTTP route per command instead of one `dispatchCommand` with a tagged union*

`/interrupt` takes the optional `turnId` so a stale interrupt from a client that has not yet seen
the turn end cannot kill the next turn.

**`/interrupt` is also the only way to stop background work, and it stops all of it.** It is
addressed to the session, not to a turn, so it is valid with no turn running: the client omits
`turnId` whenever the session is not `running`, and the adapter kills every live subagent,
background shell and watch loop before interrupting. There is no per-task stop, as in T3. On
Claude the SDK's own interrupt can acknowledge while resumed background tasks keep the CLI alive,
so an interrupt there is a hard session boundary: the query is closed, escalating to SIGKILL, and
the next `/turn` re-adopts the conversation through lazy recovery (§4.1). Against a thread with no
bound session, or one already `stopped`, the host appends a `provider.turn.interrupt.failed`
activity rather than answering an HTTP error.

*T3: `apps/web/src/components/ChatView.logic.ts:546-555` — `buildThreadTurnInterruptInput`, `turnId` only while the session is `running`; `apps/web/src/components/ChatView.tsx:6225-6229` — "Stop routes through the stop-everything interrupt: it kills every live background task before interrupting, and works by session, so no active turn is needed"; `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:1510-1531` — no session, or a stopped one, appends the failure activity; `:1605` — the interrupt is sent by thread id; `apps/server/src/provider/Layers/ClaudeAdapter.ts:5289-5297` — Claude's `interruptTurn` is `stopSessionInternal`*

`/dismiss` exists because a question the provider is *not* blocked on can be closed without an
answer; a question delivered through a native callback (Claude's `AskUserQuestion` through
`canUseTool`, Codex's `item/tool/requestUserInput`) blocks the provider and must be answered or
cancelled. `request.opened` / `user-input.requested` therefore carry `dismissible`, and the banner
in §7.5 only offers "dismiss" when it is true.

*T3: `packages/contracts/src/orchestration.ts:1355-1364` — "the agent is not messaged; the composer is simply released. Native callback questions cannot be dismissed this way because the provider is blocked waiting on a reply"; `packages/client-runtime/src/pendingRequests.ts:20-26` — `dismissible` on the projected pending request*

A dismissal has no event of its own. The host appends an ordinary `user-input.resolved` activity —
summary "User input dismissed", tone `info`, the deterministic id `async-dismiss:<requestId>` — and
that row is what closes the question in the fold (§5.1). The agent is not messaged. Two cases are
rejected with `COMMAND_REJECTED`: the question was already answered, and the question is not
`responseMode: "message"`, whose message tells the user to answer it or stop the turn.

*T3: `apps/server/src/orchestration/decider.ts:1753-1796` — both invariant errors and the `thread.activity-appended` the command decides to*

*Built: **`responseMode` is a first-class field on the pending request**, not something each
consumer re-derives from the raw payload (`PendingUserInput.responseMode` in
`packages/api/src/agent-chat/thread.ts`, promoted by `derivePendingRequests`; `dismissible` stays
`responseMode === "message"`, derived and never independently authored). Four behaviours branch on
it and must never disagree — T3 `providerRuntime.ts:496` with the same four consumers:*

*1. **dismiss legality** (`decider.ts:1769-1775`): only a message-mode question may be closed
   without an answer;*
*2. the **terminal-turn cleanup** (`ProviderRuntimeIngestion.ts:2330-2360`): when a turn ends with
   a question still open, only the NON-message ones are force-resolved with a "User input
   dismissed" activity — a message-mode question may outlive its turn and still accept a later
   user message. Orquester did not have this rung of the rule at all; it is now
   `settleStrandedQuestions` on `turn.completed`/`turn.aborted` in the orchestrator's runtime-event
   loop, which is why `PendingUserInput` also carries the `turnId` that scopes it. Historical
   (replayed) turn events are excluded: a replayed turn is the past and has no live provider to
   strand;*
*3. **settle eligibility** (`decider.ts:500-511`) — Orquester has no settle/snooze command, so this
   consumer has no counterpart here and nothing to keep in sync;*
*4. the **turn-pause gate** (`ProviderRuntimeIngestion.ts:2076-2079`): an async question never
   parks the turn, already true of the mandatory flush point in
   `apps/daemon/src/agent-host/ingestion/index.ts`. A message-mode question does still put the
   THREAD in `waiting` on the §6.4 ladder, exactly as T3's sidebar reads it as `input` — that is
   the row's status, not the turn's state, and the turn state machine (`turn-state.ts`) is driven
   by session status alone and never by a pending request.*

*Built: **the message-mode answer is committed as ONE decision.** T3 commits the resolved activity
and the turn/steer with a single `decideCommandSequence([activity.append, turn.start])`
(`decider.ts:1629-1702`) so the card cannot close without the message being committed, nor the
reverse. Here that is one `events` array on one orchestrator decision — `responseRequested`, the
`user-input.resolved` activity (deterministic id `async-answer:<requestId>`) and the
`thread.message-sent` reach `append` together or not at all — with the steer as the decision's only
effect. The reply text **echoes each question before its answer** (`"<question>\n<answer>"`, joined
by blank lines), and a question's attachments follow as `Attached file: <name> (<path>)` lines —
the absolute host path, so the adapters' `Attached files:` block (§4.5) finds each file already
named and appends nothing; the id stands in only when the file cannot be resolved — and ride the
message as real attachment refs. The echo is not decoration: the provider parked no request, so
the agent receives this as an ordinary user turn and has nothing but the text to tell it which
question was answered — the previous shape dropped the question whenever there was exactly one,
which reads as a bare "yes" arriving from nowhere in a resumed transcript. The message id is the
deterministic `async-answer:<requestId>` too, so a replayed command cannot mint a duplicate.*

`/session/stop` stops the provider child and leaves the thread, its log and its resume cursor
intact; the next `/turn` re-adopts it through lazy recovery (§4.1). Without it a session wedged in
`starting` or `error` would be unrecoverable, because §6.2 answers 409 to every command against a
thread in `error` and the only other exit would be deleting the tab. It is a user action only:
nothing auto-settles or auto-stops an idle thread, per §1.

*T3: `packages/contracts/src/orchestration.ts:1381-1392` — `thread.session.stop` with `onlyIfSettled`, dispatched by the settlement reactor; differs: no auto-settle here, so the conditional field has nothing to guard and is dropped*

Interaction mode stays a per-turn field on `/turn` (§4.4) rather than a command of its own. T3
makes it thread state with its own command because its composer chip must survive a page load on
any device; here the plan-mode toggle is client-local per thread in the §7.2 LRU and re-sent with
every turn, which keeps the host from carrying a setting no adapter reads between turns.

*T3: `packages/contracts/src/orchestration.ts:1251-1257` — `thread.interaction-mode.set`; `:1243-1249` — `thread.runtime-mode.set` (kept here as `/mode`); differs: interaction mode is per-turn and client-local*

`/compact` refuses rather than queues, and `/turn` queues rather than refuses, exactly as §3.4
states; the HTTP surface of that rule is 409 `COMPACTION_UNAVAILABLE` on `/compact` and an ordinary
`{seq}` on a `/turn` the host will hold.

**Receipts and responses.** `commandId` is minted by the client (a UUID) and is the idempotency
key. The host keeps `commandId -> {seq, status}` in `receipts.json` (§5.1) and the response is
`{seq}` — the sequence the command landed at, or the recorded sequence for a repeated `commandId`,
so a retry after a dropped connection never double-sends a turn. Two rules make the receipt honest:
a `commandId` already recorded against a *different* thread is 409 `COMMAND_ID_CONFLICT` and is
never replayed, because a receipt only proves that exact command was handled; and a `commandId`
whose recorded status is `rejected` replays the original rejection rather than being retried.

*T3: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:144-172` — the receipt-first check, the cross-aggregate conflict and the previously-rejected replay; `:296-304` — the receipt is written inside the same transaction as the events; `apps/server/src/persistence/Migrations/002_OrchestrationCommandReceipts.ts:8-16` — the receipt row; `packages/client-runtime/src/operations/commands.ts:67-75` — the client mints the id*

**Failures.** A failed command answers `{error: {code, message, detail?}}` and is not a transport
error to swallow:

- 400 `INVALID_COMMAND` — the body failed validation: the input and attachment bounds of §4.1, an
  unknown `decision`, a malformed `targetTurnCount`.
- 404 `THREAD_NOT_FOUND` — no thread, or it was deleted between the client's snapshot and the post.
- 409 `COMMAND_ID_CONFLICT`, `COMMAND_REJECTED` (an invariant: revert past `turnCount`, revert while
  a turn is active), `COMPACTION_UNAVAILABLE` (§3.4).
- 409 for any command against a thread in `error` except `/session/stop` and `/revert`.
- 503 `HOST_UNAVAILABLE` — the agent host is restarting; the client retries the same `commandId`.

A *provider-side* failure is never an HTTP error. `/turn` returns as soon as the command is
recorded; a provider that then refuses the turn, the approval, the interrupt or the stop appends an
activity with tone `error` (§5.1) and the client renders it in the timeline. Exactly one surface,
whichever layer failed.

*T3: `apps/server/src/orchestration/Errors.ts:7-62` — the rejection union (`OrchestrationCommandInvariantError`, `…CommandIdConflictError`, `…CommandPreviouslyRejectedError`) with user-facing `message` getters; `packages/contracts/src/orchestration.ts:2361-2367` — `OrchestrationDispatchCommandError`; `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:268-304` — provider failures become `provider.*.failed` activities, not exceptions*

**Ordering.** The host applies commands for one thread strictly serially, one at a time, and
appends, folds and receipts them in one step before answering. Two clients racing the same approval
therefore resolve deterministically, and no client can observe an event whose projection is not yet
readable by a snapshot.

*T3: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:416-417,438-447` — one queue, one worker fiber, all command handling serial; `:273-320` — append + project + receipt in one transaction; `:322-340` — events published only after commit*

*Built: **the §3.4 account switch is deliberately NOT one of these commands.** Every name in
`AGENT_CHAT_COMMAND_NAMES` is forwarded to the host **verbatim** — the daemon is a proxy, not a
translator — and this one cannot be: only the daemon can validate the account against the registry
entry's family, apply the seeded-account gate, recompose the whole launch environment
(`resolveExtraEnv` + the entry's own env + the per-launcher env file) and prepare the new home.
So it is the lifecycle route `POST /api/sessions/:id/account` (§6.1) and the host sees a separate,
already-resolved `POST /threads/:id/identity`. It still carries a client-minted `commandId`, is
serialised on the same per-thread command queue, is receipt-tracked by that id with the same
conflict and previously-rejected rules, and answers the same `{seq}` and the same error codes —
everything above applies to it except the "forwarded verbatim" part
(`packages/api/src/agent-chat/wire.ts` — `agentChatRoutes.account`, `AccountCommandBody`, and its
absence from `AGENT_CHAT_COMMAND_NAMES`).*

### 6.3 Reads

- `GET /api/sessions/:id/thread` → `{head, items, turns, checkpoints, pending, roster, seq}`. With
  `?after=<seq>` the host may answer with events after that sequence instead — see the decision
  rule below. The response says which it is, so the client handles either.
- `GET /api/sessions/:id/events?after=<seq>` → long-lived chunked NDJSON. Frames:
  `{kind: "snapshot", thread}` when `after` is older than the retained replay window or below a
  revert truncation, then `{kind: "event", seq, event}` for each event, then
  `{kind: "synchronized", hostInstanceId}` once live — the instance id §8 makes the client
  re-read on rather than resume by sequence. A comment line `:hb` every 15 s keeps proxies and browsers
  from timing out, matching the daemon's existing `/events` heartbeat. Backpressure: if the
  response's write buffer exceeds 8 MiB the host closes the stream; the client reconnects with its
  last sequence.
- `GET /api/sessions/:id/turns/:n/diff?ignoreWhitespace=1` → unified diff text.
- `GET /api/sessions/:id/items/:itemId` → one item with its full, unslimmed payload.
- `GET /api/agent/providers` → one snapshot per adapter (§4.1), plus the host's instance id.
  `POST /api/agent/providers/:id/refresh` (optional `{cwd}`, §4.6.4) forces a refresh. Changes
  broadcast `agent.providers.changed` (§6.4).
- `POST /api/agent-host/stop` → the intentional host stop named in §3.3: it writes every
  continuation marker for a running thread with a usable cursor, then drains and stops the host.
  It is the one route here that is not per session.

*T3: `packages/contracts/src/orchestration.ts:2164-2177` — the three thread stream frames (`snapshot` / `event` / `synchronized`), adopted verbatim; `:953-963` — the shell stream's own frames, differs: no shell stream here (§6.4); `:2223-2229` — `getTurnDiff` takes `{threadId, fromTurnCount, toTurnCount, ignoreWhitespace?}`, with the `fromTurnCount ≤ toTurnCount` filter at `:2182-2195`*

**Snapshot-or-replay is the server's decision, not the client's.** The client only ever sends its
last sequence; the host chooses. It replays events after `after` only when the range, measured
*over this thread's rows alone*, is ≤ 1 000 events **and** ≤ 8 MiB of payload; past either it sends
a snapshot. A range containing the thread's own creation (a recreated thread), a revert truncation
below `after`, or an `after` above the current head all force a snapshot. Row count alone is not a
bound: a handful of events with large tool payloads decode to far more than their number suggests,
which is why the byte budget is measured before the replay is read.

*T3: `apps/server/src/ws.ts:373,377` — `THREAD_RESUME_MAX_EVENTS = 1_000` and `ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 MiB` with the comment on why rows are not a bound; `:2189-2251` — measure this thread's rows, replay or fall back, and the recreated-thread check; `:369` — the shell stream's own `SHELL_RESUME_MAX_GAP`*

**The live tail is attached before the read.** The host subscribes the stream to the thread's live
event feed *first*, into a scope-bound buffer, and only then measures and reads the replay or the
snapshot. Attaching afterwards loses every event published while the read was in flight — those
events are past the persisted tail the read saw and not yet in the live stream. For the same reason
`{kind: "synchronized"}` is pushed through the **same** buffer as live events, never written
straight to the socket: it must land after everything buffered during the read, or the client
believes it is caught up while frames are still queued.

*T3: `apps/server/src/ws.ts:2159-2169,2178-2184` — "attach live delivery before reading either replay or snapshot state. Otherwise an event published while the snapshot is loading is lost"; `:2236-2241,2286-2291` — the completion marker is offered into the live buffer*

**Per-stream coalescing.** Each open stream applies the §5.6 `item.updated` coalescer a second
time, independently of the persistence-layer one and with the same window, pending cap and rules —
latest per `{turnId, itemId}`, anonymous updates pass through, any non-update frame flushes.

*T3: `apps/server/src/orchestration/ThreadLiveEventCoalescer.ts:18-19` — 50 ms window, 512 pending; `:56-94` — `coalesceLiveToolUpdatedEvents`, latest-per-stable-id, anonymous calls pass through; `:189-193` — a non-update event closes the run immediately*

**The 8 MiB budget is charged, not guessed.** An event's serialized size is measured once and
cached by identity, since one event object is shared by every stream watching that thread. A
frame's charge is released only when its bytes have actually left the process — for a chunked HTTP
response, when `write()` has drained, not when the frame was handed to the socket. On overflow the
host closes the stream with a message naming the remedy: resume from the last received sequence.
A slow client is cut and told to resume by cursor; it is never allowed to grow host memory.

*T3: `apps/server/src/orchestration/LiveStreamBudget.ts:9-10` — 1 000 items / 8 MiB per subscription; `:19-29` — sizes measured once via a `WeakMap` because events are shared across subscriptions; `:65` — "The live event buffer is full. Resume from the last received sequence."; `:171-180` — the charge is released only after the client ACKs the batch, differs: the HTTP analogue is the drain of the chunked write*

**Attachments.** Upload is the existing `POST /api/sessions/:id/upload` (raw octet-stream body,
metadata in the query string) and its returned path is the attachment reference. What crosses the
command wire is metadata only — `{id, name, mimeType, sizeBytes}` — never bytes and never a data
URL. The §4.1 bounds are checked against the file the host stat'd, not against what the client
claimed; the mime is lowercased first and the whole set is refused if any member fails. An attachment uploaded for a turn that never dispatches is a pending
file the host reaps on its own schedule. Reading one back is `GET /api/fs/download` against the
thread's attachments dir, which already carries the `?token=` carve-out a native download needs.

*T3: `packages/contracts/src/orchestration.ts:165-168` — `PROVIDER_SEND_TURN_MAX_{INPUT_CHARS,ATTACHMENTS,IMAGE_BYTES,FILE_BYTES}`; `:302-372` — `ChatAttachment` carries metadata only, with an explicit unknown-type catch-all; `apps/server/src/orchestration/Normalizer.ts:168-231` — size re-validated against the stat'd file and pending uploads claimed by copy, not hard link, because "an agent editing the delivered file in place must not mutate the retry source"; `apps/server/src/attachmentStore.ts:24-26` — pending uploads TTL; `packages/contracts/src/assets.ts:85-117` — differs: T3 mints short-lived signed URLs so bytes never touch the RPC socket; our upload/download routes are already plain HTTP*

*Built: reading an attachment back is **not** `GET /api/fs/download` — that route is confined to
`fsRoot` by `assertInsideFsRoot`, and a thread's attachments live under
`<appdir>/daemon/agent/threads/<id>/attachments`, outside it, so it would refuse every one of them.
It is `GET /api/sessions/:id/attachments/:attachmentId`: the host resolves the id (it owns the
namespace and its traversal guard) and the daemon streams the file, carrying the same `?token=`
carve-out a native `<a download>` needs (`apps/daemon/src/agent-chat/proxy-routes.ts`,
`agentChatRoutes.attachment`).*

*Built: the upload reply carries the attachment's **absolute host path** beside the reference —
`AttachmentRef.path` — so the composer can name the file in the prompt (§7.4). It is a courtesy of
that one reply: `parseAttachments` rebuilds every ref from `{type, id, name, mimeType, sizeBytes}`,
so no command body reaches an adapter with it and no event carries it
(`apps/daemon/src/agent-host/orchestration/validate.ts`, `agent-host/store/index.ts`).*

**Provider snapshots.** Each adapter's snapshot carries, besides §4.1's
`{installed, version, auth, models[], slashCommands[], skills[], usageLimits, versionAdvisory,
workspaceSnapshots?}`, the adapter's
`capabilities` block, because the client cannot render without it: `showPlanModeToggle` gates the
composer chip (§7.4), `supportsConversationRollback` decides whether "rewind to here" is offered at
all rather than failing at step 2 of §5.5, and a `reportsContextWindow` flag lets the status line
reserve the meter's space before the first `thread.token-usage.updated` (§7.6). `auth.status` is an
enum plus an optional label/email, never a credential. Model rows keep §4.1's shape, including
`capabilities.optionDescriptors[]`, so the composer's model chip can label, order and configure
itself without a second lookup.

`POST /api/agent/providers/:id/refresh` is an explicit user action and is the only refresh allowed
to re-read model catalogs; the background refresh that keeps `installed`/`version`/`auth` current
must never open a provider session, which is exactly the constraint §4.1's probes are written
against.

*T3: `packages/contracts/src/server.ts:188-239` — `ServerProvider` (`showInteractionModeToggle`, `reportsContextWindow`, `requiresNewThreadForModelChange`, `supportsConversationRollback`, `auth`, `models`, `slashCommands`, `skills`, `usageLimits`); `:68-81` — `ServerProviderModel`; `:245-252` — the array decodes forward-compatibly so one unrenderable provider cannot fail the whole snapshot; `packages/contracts/src/rpc.ts:469-483` — `server.refreshProviders` with "Explicit user request. Background status refreshes must not open agent sessions."; `packages/contracts/src/server.ts:687-692,733-741` — differs: T3 pushes provider changes on a config stream, we broadcast one coarse bus event and the client re-reads*

**The sequence a snapshot claims is the floor, not the ceiling.** `seq` on a thread snapshot is the
lowest sequence every projection in it has been folded to, so a snapshot never claims to be newer
than its least-advanced part and a client resuming from it cannot skip an event.

*T3: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:276-284,318-345` — `computeSnapshotSequence` is the minimum cursor across the required projectors*

### 6.4 Event bus additions (coarse only)

`session.activity` keeps its shape and is now produced from protocol events: `running` while a
turn is active, `waiting` with attention while a request is pending, `idle` with a "finished"
attention stamp on turn end. Three new events: `agentChat.turn {id, turnId, state, tokenUsage?}`,
`agentChat.pending {id, requestId, kind: "approval"|"question", title, open: boolean}` and the
coarse `agent.providers.changed` that a snapshot refresh raises (§4.6.4, §6.3). Nothing
higher-rate rides the bus. The push gate in `index.ts` and the Attention Center filter widen from `"agent"` to include
`"agent-chat"`.

*Built: there is no `agent-sessions.ts` — the Attention Center's filter is client-side, and the
widening is `isAgentLike()` in `packages/ui/src/lib/session-kind.ts`, the one predicate every
kind-branching surface calls. The daemon's push gate is widened as written
(`apps/daemon/src/index.ts`), though in practice a chat tab raises no bell and no managed-hook
event: its pushes come from the protocol path in `apps/daemon/src/agent-chat/summary.ts`. The gate
is widened anyway so a future chat-side `session.activity` emission is not silently swallowed.*

`SessionSummary` gains six derived fields for chat sessions — this list is the contract §7.1 and
§7.7 read, and no surface may invent a name for one of them — so that every surface already
reading only `SessionSummary` (tab strip, Attention Center, command palette, push gate) keeps
working without a thread subscription: `hasPendingApprovals`, `hasPendingUserInput`,
`hasActionableProposedPlan`, `backgroundLiveness` (`"working" | "monitoring" | null`, the §3.1
registry, per thread), `latestTurn` (`{turnId, state, startedAt, completedAt}`) and the session
status from §5.1's `ThreadHead`. The names are T3's.
Approvals and questions are separate booleans on purpose — they need different UI and different
push copy, and collapsing them into one "waiting" bit loses that.

*T3: `packages/contracts/src/orchestration.ts:860-919` — `OrchestrationThreadShell` is the head without the body plus these derived columns (`latestTurn`, `session`, `hasPendingApprovals`, `hasPendingUserInput`, `hasActionableProposedPlan`, `backgroundLiveness`, `planProgress`); differs: `planProgress` is dropped (the checklist is a thread-level surface, §7.3), and we hang the rest on `SessionSummary` and push them on the existing bus instead of running a second `subscribeShell` stream*

The activity state is resolved from those fields by one strict priority ladder — this ladder, and
no per-surface variant of it: pending approval → `waiting`/approval; pending question →
`waiting`/question; session in `error` or latest turn `failed` → `error`; session starting →
`working`; session or turn running → `working`; `backgroundLiveness: "working"` → `working`;
`backgroundLiveness: "monitoring"` → `idle` — neither with a "finished" stamp, because a settled
turn whose subagents or watch loops are still running is not finished (§3.1); turn completed →
`idle`+finished. `session.activity` keeps its three states, so a surface that wants to say
"Monitoring" reads `backgroundLiveness` off the summary: the working colour without the pulse,
ranked below an actionable plan prompt wherever both could show. A session in `error` is resolved
before either liveness value, so a failure is never hidden behind a stale "working". Two fallbacks matter and are not optional. A turn recorded as
`interrupted` that carries a `completedAt` is `idle`+finished, because session teardown settles
still-running turns by session status and that write races `turn.completed`. And a live session
sitting at `ready` with nothing pending and nothing running is `idle`+finished, because a turn that
changed no files leaves no turn row to read — without this branch, a thread that finishes and is
torn down quickly shows nothing at all instead of "finished".

**Amendment (implementation, 2026-09-21): the `error` rung resolves to `idle` + a `finished`
attention.** There is no fourth `SessionActivityState` — the spec's own "`session.activity` keeps
its three states" rules one out — so a failed thread lands in the Attention Center's *Finished*
bucket and its push carries the "finished" copy. It keeps the two properties the rung exists for:
a failure still outranks lingering background liveness, and it still raises an attention the user
sees. A surface that wants to say "failed" reads `chatSessionStatus === "error"` or
`latestTurn.state === "failed"` off the summary, exactly as it reads `backgroundLiveness` to say
"Monitoring". Distinct push copy for a failure is a follow-up.

*Built: the ladder carries a **`plan-ready` rung** between `running` and
`background-working` (`apps/daemon/src/agent-chat/activity-ladder.ts`). An actionable proposed
plan on a settled turn — `hasActionableProposedPlan`, no pending user input, `latestTurn` started
and completed, session not `running` — resolves to `waiting` + `needs-input`, and its push is a
third structural type, `plan-ready` ("has a plan ready"), rather than a `needs-input` with
different words: nothing is blocked on an answer and the work is not finished either. It is
ordered exactly as T3's pill is (`Sidebar.logic.ts:1049-1066`): it **outranks background
working/monitoring** — the plan needs a decision, liveness merely reports — and sits below
approval, question and error. Differs from T3 in one clause: T3 also requires `interactionMode ===
"plan"`, which is not on `AgentChatSessionSummaryFields` and would be the wrong test anyway —
`hasActionableProposedPlan` already means "the LATEST plan is unimplemented" (R6-3), and a thread
switched out of plan mode after proposing still owes the user that decision.*

**Amendment (implementation): the trust grant is confined to `projectPath`.** A chat launch
auto-accepts Claude's project-trust dialog for the thread's project (a never-seen directory is
untrusted, and its `.claude/settings.json`, hooks and skills are then silently ignored). The
granted path is the request's `projectPath` after `realpath` + `assertInsideFsRoot`, never its
`cwd`: Claude's trust dialog gates hook execution, so an unconfined path would let a client
permanently enable arbitrary shell for the daemon user. A `projectPath` outside the sandbox gets
no grant and the launch proceeds.

*T3: `packages/shared/src/agentAwareness.ts:76-113` — the ladder and both race fallbacks, with the comments recording the bugs they fix; `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:161-204` — pending user input folded from the activity log by open `requestId`; `:582-599` — both flags recomputed as `count > 0`; `apps/web/src/components/Sidebar.logic.ts:847-863` — running, then error ("a failed session outranks lingering background liveness"), then `working`, then `monitoring`; `:1067-1087` — Monitoring is painted like Working with `pulse: false`; `:524-535` — `Monitoring` ranks below `Plan Ready`; differs: T3 has a Monitoring pill state of its own, while `session.activity` here keeps three states and the label is read off `backgroundLiveness`*

### 6.5 Desktop

The desktop's local transport reaches `/events?after=` through the same bridge that carries
chunked terminal output today; commands are ordinary bridged requests. Nothing in the chat UI
depends on WebSockets.

*Built: `?after=` is not only the reconnect cursor — it is also how a **remount** catches up. A
thread whose live stream was released keeps a retained snapshot (§7.2), and the next mount opens
`/events?after=<retained seq>` rather than re-reading the thread body, so returning to a
recently-viewed tab costs the deltas it missed instead of a full snapshot and a re-fold. The
cursor needs no new failure mode: `readThread(threadId, afterSeq)` already answers a full
`snapshot` frame whenever the cursor is unusable — above the head, too large a range, a truncated
log — and a changed `hostInstanceId` is resync-not-resume as before
(`apps/daemon/src/agent-host/orchestration/orchestrator.ts`, `resumeCursorFor` in
`packages/ui/src/lib/agent-chat/stream.logic.ts`).*

### 6.6 Multi-client convergence

The model is host-authoritative, cursor-ordered: no CRDT, no client-side merge. Every mutation is a
command answered with `{seq}`; every client learns the result the same way, from the same stream,
in the same order. A client that was offline replays or re-snapshots by cursor and converges
(§6.3). Events with `seq <= lastSeq` are dropped by the client, which is what makes the overlapping
snapshot/replay/live windows safe, and a `snapshot` frame replaces all loaded history rather than
merging into it — a turn reverted while that client was disconnected has no event left to remove it.

Optimistic updates stay deliberately narrow. Tab-local placement (reorder, rename) may update
optimistically and is retired once the stream's sequence reaches the accepted `seq`; a failed
command removes the pending update in a `finally`. Sends, approvals, answers and interrupts have
**no** optimistic path — the user's message appears when its event arrives. Reconnecting never
replays a mutation; an in-flight command whose response was lost is retried by the client with the
same `commandId`, which the receipt makes free.

*T3: `packages/client-runtime/src/state/threads.ts:459-464` — events at or below the cursor are dropped; `:446-458` — a snapshot replaces loaded history and bumps a history epoch; `packages/client-runtime/src/state/threadLifecycle.ts:18-99` — the only optimistic layer, retired when `snapshotSequence` reaches the accepted sequence and removed in a `finally` on failure*


## 7. Client

### 7.1 Placement

A sixth `ProjectTab` arm, `{type: "agent-chat", sessionId}`, dispatched by `MainView` to
`AgentChatView` in `packages/ui/src/components/agent-chat/` (the directory §9 names for the
projection tests). The launch flow's agent picker creates chat tabs; it collects agent, account,
model, runtime mode and an optional conversation to resume, then posts §6.1. The thirteen
kind-branching sites listed in `orq-3-ui-surfaces.md` §1 treat `agent-chat` as the agent kind.
The terminal key bar does not mount for chat tabs. `Transporter` gains
`agentChat: {stream(sessionId, after), command(sessionId, name, body), read(sessionId, …)}` on
both HTTP and desktop-local transports.

The outgoing thread's rows keep painting until the next thread's snapshot lands, so a tab switch
never flashes an empty timeline. While that hold is in effect every row callback is a no-op, so a
click lands on the thread the user is actually looking at.

**One instance per chat tab, not one per project (amended).** The design first said a single
`AgentChatView` instance serves every chat tab, the way T3 reuses one unkeyed `ChatView` across
thread navigation. That does not fit this shell: `MainView` keeps *every* tab mounted and toggles
visibility, which is what makes grid view work and what stops a terminal being torn down, so a
chat tab is mounted per tab and a switch is show/hide. This is strictly stronger for the property
the original rule protected — the outgoing tab is never unmounted, so a switch *cannot* flash —
and the paint hold is implemented anyway, engaging on a reconnect re-snapshot and on any change of
the `session.id` prop.

It has one consequence the rest of this section depends on: **several chat tabs are live at once**,
each with its own `window`/`document` keyboard listeners. Every such listener must therefore act
only for the visible tab (`isActiveChatTab(sessionId)`, published by the shell), or one chord
sends a queued message, answers a question or stops a turn in a thread the user cannot see.
*T3: `apps/web/src/components/ThreadRouteView.tsx:197-206` — server threads render unkeyed so one `ChatView` instance is reused across thread navigation; `apps/web/src/components/ChatView.logic.ts:374-405` — `isPaintOnlyThreadTimeline` / `resolveThreadSwitchTimeline` keep painting the previous snapshot while the next loads; `apps/web/src/components/ChatView.tsx:3542-3552, 9879-9889` — callbacks and `isWorking` neutralised during the hold*

**The tab strip and every ambient surface read a shell, never a thread.** `SessionSummary` for a
chat tab carries the six derived fields of §6.4 — `hasPendingApprovals`, `hasPendingUserInput`,
`hasActionableProposedPlan`, `backgroundLiveness`, `latestTurn` and the session status — so none of the
sidebar, Attention Center or command palette has to open a thread stream to render a status dot.
The heavy payload (`items`, `turns`, `checkpoints`, `roster`) only ships to the open tab. Without
this split the Attention Center would have to subscribe to every chat thread in the workspace.
*T3: `packages/contracts/src/orchestration.ts:860-919` — `OrchestrationThreadShell` (`latestTurn`, `session`, `hasPendingApprovals`, `hasPendingUserInput`, `hasActionableProposedPlan`, `backgroundLiveness`, `planProgress`); `:773-833` — `OrchestrationThread` adds `messages`, `activities`, `checkpoints`, `proposedPlans` and is fetched only for the open thread*

### 7.2 Store

A zustand slice per open thread, created on tab open and dropped on tab close:
`{head, entries, pending, roster, turnStatus, seq, follow, scroll, disclosures}`, where `entries` is
the snapshot's `items` (§6.3) with every later frame folded in. A reducer applies
stream frames. Rows are built by three memoised layers, entries → rows → stable rows, each with a
fast path and a per-variant `isRowUnchanged`, so one token changes one row object. Closed tabs
keep nothing; the tab strip reads only `SessionSummary`.
*T3: `apps/web/src/session-logic.ts:1654-1715` — `deriveTimelineEntriesWithState` (streaming fast path, strict-prefix append, full rebuild last); `:1620-1651` — `isStreamingMessageTextUpdate` / `replaceStreamingTimelineMessages`; `apps/web/src/components/chat/MessagesTimeline.logic.ts:1477-1554` — `replaceStreamingMessageRows` / `deriveMessagesTimelineRowsWithState`; `:1556-1675` — `computeStableMessagesTimelineRows` + the hand-written per-variant `isRowUnchanged`; `apps/web/src/components/chat/MessagesTimeline.tsx:4157-4174` — `useStableRows`. differs: T3 holds domain state in Effect Atom with per-thread scoped resources (`packages/client-runtime/src/state/threads.ts:178`); we use one zustand slice and a hand-rolled reducer, so the memoisation T3 gets partly from the React Compiler must be written by hand*

**The activity item is one normalised record, not a component taxonomy.** The presentation
resolver reads §5.1's promoted fields — `tone`, `activityKind` (the originating event kind),
`status` (`inProgress|completed|failed|declined`), `turnId`, `agentId`, `parentToolUseId` — plus
the allow-listed `payload` fields §5.6 guarantees survive slimming: `itemType`, `toolUseId`
(stable across the in-progress and completed updates of one call), `title`, `detail`, `command`,
`changedFiles`, `taskId`, and the optional `questionAnswer` and `agentSpawn` blocks. Nothing
branches on the provider. Icon, label and
status chrome are all functions of those fields; adding a tool never adds a component.
*T3: `apps/web/src/session-logic.ts:56-95` — `WorkLogEntry`, the single normalised record for every agent action, discriminated by `tone`/`itemType`/`toolLifecycleStatus`/`sourceActivityKind`; `packages/client-runtime/src/work-log/presentation.ts:196-220` — `resolveWorkEntryToolPresentation` reads only status + `toolData` + `toolTitle` + `label`; `:134-186` — the verb comes from the status switch and the icon from the tool name; `apps/web/src/components/chat/MessagesTimeline.tsx:4549-4578` — `workEntryIconName`, the icon fallback chain*

**Items stamped with an `agentId` never render in the parent timeline.** A subagent's own tool
calls, reasoning and progress ticks are re-homed to the roster (§7.6); the parent keeps its own
narrative plus at most one row per spawned agent. Without this rule a single `Task` call floods the
parent thread with a second agent's work.
*T3: `apps/web/src/session-logic.ts:389-399` — the "quiet-timeline guarantee"; `:411-449` — `isAgentInternalActivity` (rows owned by an agent, or provider-synthesized child rows carrying `timelineBypass`, are internal); `packages/contracts/src/providerRuntime.ts:613-617` — `timelineBypass`, set by adapters on synthesized child-agent events "whose activity belongs in the Agents surface, never the parent timeline"*

Per-thread scroll position, disclosure state and the client-local interaction mode live in a
100-entry LRU. The remembered record is
`{rowId, offsetWithinRow, scrollOffset, atEnd, disclosures, interactionMode}` —
`interactionMode` is the plan-mode toggle §6.2 keeps out of thread state and re-sends on every
`/turn` — and `disclosures` is the full set of
what was open — expanded turns, expanded activity groups, expanded subagent rows, expanded
reasoning blocks, and the scroll offset inside each expanded tool output — so returning to a tab
restores the reading position *and* the shape of the page under it.
*T3: `apps/web/src/components/chat/timelineScrollAnchoring.ts:110-125` — `RememberedTimelinePosition` and its five disclosure sets; `:127-141` — delete-then-set LRU, evicting past 100 entries*

*Built: "dropped on tab close" is split in two, as T3 splits it. The **live subscription** — the
stream and the slice that folds it — is released as soon as its last consumer leaves (a short
grace only, for React's StrictMode double-mount and the §7.1 paint hold:
`THREAD_STORE_DISPOSE_GRACE_MS` is 2 s). What survives it is a **value-only retained snapshot** —
the folded state plus the sequence it was folded to — held in memory for a 5-minute *idle* TTL
(`THREAD_SNAPSHOT_IDLE_TTL_MS`, `packages/ui/src/lib/agent-chat/retention.ts`). A remount takes
that value, paints it before anything is fetched, and opens its stream with `after=<retained seq>`
(§6.5). `cachedThreadState` keeps a retained `synchronized` connection **as-is**, so no sync label
flashes over a timeline that is already on screen and correct; anything else falls back to the
cold-start path. The in-flight command flags (`reverting`, `stopping`) and the thread-level error
banner are dropped with the generation that owned them; the queue, drafts, disclosures and scroll
position survive. Every write is guarded by an **owner token** minted per live generation, so a
teardown that lands after a newer store has claimed the same thread cannot clobber the newer
cache. The alternative first shipped here — holding the live stream open for fifteen minutes per
recently-viewed tab — bought the same instant repaint at the cost of one live connection and one
live fold per tab, and is gone.
*T3: `packages/client-runtime/src/state/threadRetention.ts:1-3` — `THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000`, "keep recent thread snapshots for back navigation; live subscriptions end when the last detail consumer leaves"; `packages/client-runtime/src/state/threads.ts:917-950` — the resume family at that idle TTL beside the state family at `setIdleTTL(0)`, and `Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live)`; `:161-176` — `cachedThreadState` keeping a retained "live" status; `:186-228` — the cached sequence seeding `afterSequence`; `:188-189, 228, 255, 274, 293, 418` — the owner guard.*

### 7.3 Timeline

Plain scroll container with `content-visibility: auto`; no virtualizer until a profile calls for
one.
*T3: `apps/web/src/components/chat/MessagesTimeline.tsx:1279-1358` — `LegendList` with `getItemType` pools and `recycleItems` deliberately off on the main list. differs: with threads bounded at one tab's history and no recycling benefit to reclaim, we start with a plain container and adopt a virtualizer only on evidence*

**The list mounts at its end, and only streamed growth ever glides.** The end pin happens in a
layout effect — after layout, before the browser paints — so a thread opens already at its bottom
rather than at the top and then travelling; a remembered position that is *not* at the end is the
only case that restores an offset instead. Smooth scrolling is reserved for a paragraph landing
inside an already-open thread: a thread switch, the arrival of a list's first page of rows, the
pre-first-paint window and `prefers-reduced-motion` all keep the instant variant. What makes the
switch instant is a **named two-frame latch** keyed on the list identity — two frames covers the
fresh-data layout pass and the initial end pin — not a wall-clock window, which is both too long
(a turn streaming into a thread opened half a second ago jumps instead of gliding) and too short
(a slow first fold lands after it expires and glides down in front of the user). The latch is
matched on the identity, so one armed for the thread just left cannot affect the one arrived at,
and the subagent drill-in counts as its own identity because it mounts a second timeline for the
same session id while the parent's is still mounted (§7.6).
*T3: `apps/web/src/components/chat/MessagesTimeline.tsx:1287` — `initialScrollAtEnd={citationRequest === null && rememberedPosition?.atEnd !== false}`, with `positionedThreadKey` initialised at `:548-551` so no restore scroll runs in that case; `:389-395` — `TIMELINE_MAINTAIN_SCROLL_AT_END_SMOOTH`, "thread switches and layout settles keep the instant variant so nothing visibly travels"; `:555-567, :618-631` — `settlingListIdentity` and its two-frame `requestAnimationFrame` clear; `:1294-1304` — `isWorking && !prefersReducedMotion && settlingListIdentity === null` picks the smooth variant.*
*Built: the rules are pure and live in `packages/ui/src/components/agent-chat/timeline/follow.ts`
(`shouldAnimateFollow`, `armSettleLatch`/`tickSettleLatch`/`isSettling`,
`timelineListIdentity`); `ChatTimeline` holds the latch in a ref, because the decision is read at
call time inside a scroll handler and re-rendering the whole timeline twice per switch to publish
a boolean nothing paints would be strictly worse.*

Row kinds and behaviour:

- **User message**: text, attachment thumbnails, "rewind to here".
  *Built: the affordance is T3's hover-revealed icon under the message ("Rewind to here"), disabled
  while a turn or a revert is in flight, and it confirms in a small anchored panel that names how
  many later turns leave the chat and that files stay as they are; the same panel closes the
  composer's Esc-Esc picker (§7.4). Once the host has truncated the thread the message comes back
  to the composer — its text and its attachment chips — so it can be edited and resent.*
- **Assistant text**: react-markdown + remark-gfm with an incremental parser that caches the
  prefix up to the last closed fence; code highlighted by the CodeMirror/Lezer parsers already in
  the bundle (no WASM, see below), code blocks mounted line by line while streaming, cached HTML
  once settled.
- **Reasoning**: collapsed to one line, labelled "summary" when `reasoning_summary_text`.
- **Activity group**: all activities between two assistant texts collapse into one line showing
  the live tool label while running and `summarizeToolGroup()` output when settled ("Read 3
  files, ran 2 commands"). Expanded, each tool shows its command with streamed output, file
  changes as a unified diff with click-through to an editor tab, hook runs, denials, MCP calls.
- **"+N more" toggle** inside a long expanded group, and a **working row** — one element whose
  label is swapped in place (starting → running → tool name) rather than remounted, with a
  self-ticking elapsed timer, so the turn is never represented by an empty timeline.
- **Changed-files card** at the end of each turn from `thread.turn-diff-completed`, opening the
  turn diff.
- **Plan checklist**, **plan proposal** (markdown card), **compaction marker** with before/after
  tokens, **rerouted model notice**, **warnings and errors**, **queued message ghost bubble** with
  "send now" and "return to composer".
*T3: `apps/web/src/components/chat/MessagesTimeline.logic.ts:329-442` — the twelve projected row kinds (`activity-group`, `work`, `work-live`, `work-toggle`, `turn-fold`, `context-compaction`, `message`, `assistant-meta`, `proposed-plan`, `working`, `thinking`, `worktree-setup`, `queued-message`); `apps/web/src/components/chat/MessagesTimeline.tsx:2510-2543` — `WorkingTimelineRow`, one span for every label "so the setup-to-working handoff swaps text in place instead of remounting the row"; `:3320-3348` — `WorkGroupToggleTimelineRow` ("+N more"); `:1860-1879` — `ContextCompactionTimelineRow`, a `role="separator"` hairline with a label. differs: T3 bakes the before/after token counts into that label server-side (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:863-868`) and the row never reads the numbers; we carry `beforeTokens`/`afterTokens` on `thread.state.changed` and format client-side. differs: T3 has no rerouted-model UI at all — `model.rerouted` exists only in the contracts (`packages/contracts/src/providerRuntime.ts:757-762, 1127-1132`) and is never rendered; ours is a new inline notice row*

*Built: three row kinds landed narrower than written. A user message's attachments render as named
**chips**, not thumbnails — the attachment bytes route of §6.3 exists but the timeline does not
fetch it, so nothing decodes a 10 MiB image into a bubble on a phone. The sent-message chips, like
the composer's, carry the file-type icon of §7.4 (`icons/files`). The plan proposal card offers
**copy and download only**; there is no "save into the workspace" action, which would be a write
into `fsRoot` from a render path. And there is no "load earlier" header: a thread is sent whole
(§2), so there is nothing earlier to load
(`packages/ui/src/components/agent-chat/timeline/`). One kind landed wider: Codex's `commentary`
phase gets its own activity row rather than being folded into reasoning, because it is the only
narration that CLI emits between tool calls.*

*Built: the compaction marker also carries the provider's own **summary** and reveals it behind a
"Show summary" / "Hide summary" toggle on the hairline itself, collapsed by default (the CLI's
`ctrl+o`) and rendered as markdown. After a compaction that summary is the agent's entire memory of
everything above the marker, and Claude delivers it as a synthetic `user` frame right behind
`compact_boundary` — so without this it either vanished or, worse, rendered as an 18 KB message the
user never typed. It rides `thread.state.changed {state:"compacted", summary}` and the
`context-compaction` activity's `payload.summary`; §5.6's 16 KiB string cap still applies on the
wire, and a capped one offers the full read through `GET …/items/:itemId`
(`packages/ui/src/components/agent-chat/timeline/rows/StructureRows.tsx`,
`apps/daemon/src/agent-host/adapters/claude/normalize.ts`). A **failed** compaction has no summary:
nothing was dropped.*

**Activity-group boundaries are mechanical, and the rules matter more than the styling.** A group
starts at the first reasoning row or plain tool row of a turn and runs until any of: a non-grouping
entry, a turn-id change, or a row the user has collapsed out. Assistant and user messages are not
grouping entries, so they end a group by construction. Errors, answered questions, subagent-spawn
rows and compaction markers are hoisted out and rendered as their own rows — an error must never
hide inside a collapsed summary line. A run that contains no reasoning row is rendered as a plain
tool group instead of an activity group.
*T3: `apps/web/src/components/chat/MessagesTimeline.logic.ts:317-327` — `isActivityEntry` (a message qualifies only when `role === "reasoning"`; a work entry is excluded when it carries `agentSpawn` or `questionAnswer`, is a compaction, or has `tone === "error"`); `:1139-1153` — the run scan and its four break conditions; `:1155` — the group is only emitted when it contains at least one reasoning row; `:1186-1219` — compaction, spawn, question-answer and error rows pushed as standalone rows*

Approvals are *not* hoisted: an approval request and its resolution are ordinary informational
activities and stay folded into the group summary. The interactive decision lives in the docked
banner (§7.5), never in a timeline card.
*T3: `apps/web/src/session-logic.ts:585-590` — `approval.*` activities map to `tone: "info"`; `packages/client-runtime/src/work-log/presentation.ts:464-471` — approval kinds fold into the `"update"` summary bucket*

`summarizeToolGroup()` drops superseded lifecycle markers before counting: a `item.started` row
with no `toolUseId` and no status, whose `{turnId, itemType, normalised label}` identity already has
a later terminal row, is not a second tool call. Skipping this step double-counts every tool on
providers that emit an unkeyed start frame.
*T3: `packages/client-runtime/src/work-log/presentation.ts:598-635` — `summarizeToolGroup` calls `omitSupersededLifecycleMarkers` first, buckets by `toolGroupAction`, and joins with an Oxford comma; `:637-673` — `omitSupersededLifecycleMarkers` and its `isStatuslessIdlessMarker` test; `:464-498` — `toolGroupAction`, the read/edit/command/search/other bucketing*

**Failure styling is reserved for severe failures.** A non-zero command exit gets a muted failure
mark; only a `runtime.error` or a `*.failed` lifecycle event — the turn or a core side effect
broke — gets the destructive treatment. `runtime.warning` gets its own warning icon and colour,
distinct from both. Thread-level errors do not enter the timeline at all: they surface in an
overlay banner that does not change the list's content height, clamped with the full text in a
tooltip, and a dismissal is remembered per `(threadId, message)` for the session so navigating away
and back cannot resurrect a banner the user closed while a different error still can.
*T3: `apps/web/src/session-logic.ts:161-170` — `workEntrySignalsSevereFailure`; `apps/web/src/components/chat/MessagesTimeline.tsx:4837-4847, 4879-4902` — `showDestructiveRowStyle` requires a severe or non-tool-like failure, warning rows swap to `circle-alert`; `apps/web/src/components/chat/ThreadErrorBanner.tsx:7-34` — the `threadKey\0message` dismissal key; `:54-59` — three-line clamp plus full-text tooltip; `apps/web/src/components/ChatView.tsx:9860-9873` — banners overlay the timeline rather than pushing it*

An answered question folds out of the message list and re-renders as an activity row whose
expansion shows the full question-and-answer history. Leaving the answer in place as a user
message duplicates it.
*T3: `apps/web/src/session-logic.ts:1670-1688` — the `async-answer:<requestId>` user message is dropped once a work entry carries that `questionAnswer`, and the append fast path refuses to reuse a projection containing a now-folded message; `apps/web/src/components/chat/MessagesTimeline.tsx:5012-5028` — `QuestionAnswerHistory`*

**Plan proposals.** The card renders the plan markdown with copy and "save to file"; the
approve affordance is not on the card. When the latest turn has settled in plan mode with an
un-implemented proposal and the composer holds no attachments, a "Plan ready" banner docks above
the composer and the composer's primary action becomes a split button: with an empty draft it
**implements** — one turn whose input is a fixed `"PLEASE IMPLEMENT THIS PLAN:\n"` prefix plus the
plan markdown, sent with `interactionMode: "default"` so the thread leaves plan mode — and with
draft text it **refines**, sending that text and staying in plan mode. The proposal is retired by
the turn that implements it, not by the click.
*T3: `apps/web/src/components/chat/ProposedPlanCard.tsx:36-259` — copy / download / save-to-workspace only, no approve button; `apps/web/src/components/ChatView.logic.ts:951-965` — `shouldShowPlanFollowUpPrompt`; `apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx:1-20`; `apps/web/src/components/chat/ComposerPrimaryActions.tsx:161-216` — "Refine" vs the "Implement" split button; `apps/web/src/proposedPlan.ts:73-96` — `PLAN_IMPLEMENTATION_PROMPT_PREFIX` and `resolvePlanFollowUpSubmission`; `apps/web/src/session-logic.ts:383-387` — `hasActionableProposedPlan` is `implementedAt === null`*

*Built: the composer's primary action is a **plain** "Implement" button, not a split button. T3's
menu offers "implement in a new thread", which needs a thread-creation path from inside the
composer that this design does not have (§6.1 creates a tab first, then turns) — a disabled menu
item is worse than no menu (`packages/ui/src/components/agent-chat/composer/
ComposerPrimaryActions.tsx`). "Refine" and the fixed implementation prefix are as written.*

**The plan checklist is a composer surface, not a timeline row.** `turn.plan.updated` folds into one
active plan state — current step, completed count, total — displayed beside the status line, with the
last plan of any turn retained so a follow-up message does not blank the checklist.
*T3: `apps/web/src/session-logic.ts:113-122` — `ActivePlanState`; `:324-350` — `deriveActivePlanState`, falling back to the most recent plan from any turn "so that TodoWrite tasks persist across follow-up messages"; `apps/web/src/components/ChatView.tsx:5855-5872, 10101` — fed to the composer as `activeTasksProgress`*

Markdown streams incrementally. The incremental parser is armed only while streaming, only when
the text already contains a fence, and only with the default plugin set; it caches the parsed
prefix up to the last closed top-level fence followed by a blank line and re-parses the suffix. It
bails to a full parse on a bare `\r` or a BOM (a streamed CR can become half a CRLF) and on any
link or footnote definition, which are document-wide. The whole markdown config object is memoised
once and published on a context so plugin and component arrays never change identity.
*T3: `apps/web/src/markdown-incremental.ts:32-85` — the prefix cache, the fence-plus-blank-line boundary, and the `\r`/BOM and definition bail-outs; `apps/web/src/components/ChatMarkdown.tsx:3318-3329` — the three-part arming condition; `:2658-2727, 3345, 3366` — the memoised `componentState` on a context and the `memo` wrapper*

Code is highlighted with the Lezer parsers `@codemirror/language-data` already ships — `highlightTree`
over the parsed block, language resolved by fence name and loaded lazily — not with Shiki. T3 forces
Shiki onto its Oniguruma **WASM** engine because the JS regex engine can backtrack catastrophically
and hang tokenisation; here WASM is not an option, because the production SPA's CSP is
`script-src 'self'` with no `'wasm-unsafe-eval'` and `/etc/caddy/Caddyfile` is reconciled by hand, so
a WASM highlighter would fail silently after a deploy. Lezer parsers are plain JS, incremental, and
already in the bundle for the file editor, so this adds no dependency and no CSP change, and an
unknown fence name simply renders unhighlighted. While a message streams, a code block renders as individually mounted lines
rather than one `innerHTML` blob, so appending a line never destroys the user's text selection; once
the message settles, the rendered HTML goes into a size-aware LRU and is served as HTML. A block
that streamed keeps the line renderer after settling, because swapping to cached HTML would clear a
live selection.
*T3: `apps/web/src/lib/syntaxHighlighting.ts:10-16` — `PREFERRED_HIGHLIGHTER = "shiki-wasm"` and the first-caller-wins singleton note; differs: Lezer instead of Shiki, for the CSP reason above — the line-mounted streaming renderer and the settled-HTML LRU below are kept as T3 has them; `apps/web/src/components/ChatMarkdown.tsx:1039-1073` — `preserveLines={isStreaming || hasStreamed}` and the selection comment; `:1084-1135` — `codeToHast` + `HighlightedCodeLines`; `:338-357, 1117-1126` — the settled-HTML LRU (500 entries / 50 MB), written only when not streaming*

*Built: the highlighter uses a **static light/dark token palette** rather than deriving colours
from the active colour scheme. Lezer's `highlightTree` needs a `HighlightStyle` built ahead of
parsing, and rebuilding one per scheme × mode on every theme change would re-highlight every cached
block; a code block reads as code in all seven schemes either way. A block over `MAX_TURN_INPUT_CHARS`
(120 000) is rendered unhighlighted — the parse is the cost, and nobody reads a 120 000-character
block's colours (`packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.ts`).*

Live-follow is a render-visible flag — not a ref — re-armed only inside a 40 px band at the bottom
of the content, measured as `contentLength - scroll - scrollLength`. A "near end" heuristic that
fires within half a viewport re-arms follow while the user is reading history and yanks them back on
the next chunk. Follow re-pins on new rows, row growth and layout, but explicitly **not** on footer
layout, so composer growth never moves visible messages; the composer is an overlay (§7.4). While a
turn is running and the user has not asked for reduced motion, the follow scroll is animated so each
streamed paragraph glides instead of jumping. A "scroll to end" pill appears above the composer when
follow is off and re-arms every follow flag in one place.
*T3: `apps/web/src/components/chat/MessagesTimeline.logic.ts:149-172` — the re-arm band, `TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40`, and the rationale comment; `apps/web/src/components/ChatView.tsx:5297-5300` — live-follow as a render-visible flag; `apps/web/src/components/chat/MessagesTimeline.tsx:377-395` — the trigger set with `footerLayout: false` and the smooth variant; `:1294-1304` — smooth only while working and not `prefers-reduced-motion`; `apps/web/src/components/ChatView.tsx:5388-5406, 9963-9984` — `scrollToEnd` and the pill*

### 7.4 Composer

A textarea overlaid at the bottom of the timeline, publishing its measured height as the list's
bottom content inset. `@` opens the existing file search as a token overlay and inserts a
canonical path; `/` lists the provider's slash commands and skills from the snapshot; paste or drop
of an image or file uploads through the existing route and adds an attachment chip, up to §4.1's
cap. Chips:
model (from the provider snapshot, keyed by the account's available models), account, runtime
mode, plan mode where `showPlanModeToggle`.
*T3: `apps/web/src/components/ChatView.tsx:9987-9998` — the absolutely positioned composer overlay; `:5900-5917, 9943` — the measured height republished as the list's `contentInsetEndAdjustment`; `apps/web/src/components/composerFooterLayout.ts:62-90` — the inset policy; `packages/shared/src/composerTrigger.ts:48-130` — `detectComposerTrigger` (`/` only at line start, `#`, any `\p{Sc}`, `@`); `packages/contracts/src/orchestration.ts:165-168` — `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`, `…MAX_ATTACHMENTS = 8`, `…MAX_IMAGE_BYTES = 10 MiB`, `…MAX_FILE_BYTES = 50 MiB`. differs: T3's composer is a Tiptap/ProseMirror editor with inline atom chips and three cursor coordinate spaces (`apps/web/src/components/ComposerPromptEditorTiptap.tsx`, `apps/web/src/composer-rich-text-doc.ts:9-22`); a textarea plus a token overlay buys `@` and `/` for a fraction of that, at the cost of chips being plain text*

The `/` and `$` menus — their trigger, position gating, per-provider gating, ranking and what each
row inserts — are §4.6.7's in full; nothing here restates them.

Enter sends, Shift+Enter inserts a newline, Escape interrupts when a turn is active; interrupting
also returns every queued message to the composer rather than discarding it. Sending during a turn
steers; the ghost bubble shows what was sent. Browser-pick payloads and session uploads targeting a
chat tab are written into the draft as text plus attachment, never typed into a pane.
*T3: `apps/web/src/composer-logic.ts:27-44` — `composerSubmissionIntentForEnter` and the `sendShortcut` setting (`packages/contracts/src/settings.ts:441-443`); `apps/web/src/components/ChatView.tsx:3971-3993` — `onInterrupt` drains the queue back into the composer before interrupting; `apps/web/src/components/chat/ChatComposer.tsx:5925-5955` and `apps/web/src/composerDraftStore.ts:3739-3777` — terminal selections and element-picker annotations inserted into the draft at the caret, never into a pane*

*Built: **Escape twice, while idle, opens the rewind picker** — the CLI's own "jump to a previous
message". It lists the thread's rewindable user messages newest first (`deriveRewindTargets`,
`packages/ui/src/lib/agent-chat/rewind.logic.ts` — a projection of the rows the timeline stamped
with `revertTurnCount`, so the picker and the per-row button can never disagree), each naming how
many turns it drops, and confirms in the same panel as the per-row button. The picker is also a
composer control next to the attach button (`data-composer-shortcut="rewind"`, deliberately no
chord), hidden when nothing can be rewound and disabled while a turn, a request or a revert is in
flight. The first Escape shows "Press Esc again to rewind to an earlier message" for a moment; the
second, inside the 600 ms window of `createEscapeSequence`, opens the control. An idle Escape
outside the composer goes through the shell's resolver (`escape-action.ts`), which returns
`"rewind"` for the same double press and opens the control through the composer bridge.*

Prompt-length validation measures the **larger of the literal draft and its wire-expanded form**, so
a short reference that expands on the wire cannot smuggle the thread past §4.1's input bound;
answers to a pending question are exempt, because they are not a provider turn. A paste of 32 KiB or
more — measured in UTF-8 bytes as well as characters — becomes a text attachment instead of inline
text, with a toast naming the escape hatch.
*T3: `apps/web/src/components/chat/composerSubmission.ts:12-23` — `max(literal, citation-expanded)`; `:25-31` — the `pending-user-input` exemption; `:33-50` — `submitComposerDraft` as the single funnel; `packages/client-runtime/src/textPaste.ts:1, 19-38` — `PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 KiB` and `pastedTextDisposition`, which folds on char count **or** UTF-8 byte length because "character counts substantially understate the context cost of some Unicode-heavy clipboard contents"*

**Every composer control carries a `data-composer-shortcut` token and one keybinding handler drives
them all.** `openControl(command)` un-collapses and focuses the composer inside a `flushSync`, then
queries `button[data-composer-shortcut~="<command>"]:not(:disabled)` within the composer shell,
skipping `[inert]` and invisible nodes, and focuses-and-clicks the match. This replaces one
imperative handle per control — model, account, runtime mode, plan — with a DOM convention. Our
bindings follow T3's: `Ctrl/Cmd+Shift+A` for the runtime-mode picker is already taken by the
Attention Center on this host, so the mode picker gets its own key and the conflict is resolved once,
in the keybinding table, not per component.
*T3: `apps/web/src/components/chat/ChatComposer.tsx:5880-5901` — `openControl`; `:1116`, `apps/web/src/components/chat/TraitsPicker.tsx:622`, `apps/web/src/components/BranchToolbar.tsx:211-214`, `apps/web/src/components/chat/CompactComposerControlsMenu.tsx:44-46` — the attribute sites, including multi-token values when an overflow menu absorbs two controls; `packages/shared/src/keybindings.ts:44-55` — `composer.stash` (`mod+s`), `thread.steerQueuedMessage` (`mod+shift+enter`), `composer.mode` (`mod+shift+a`), `composer.effort`, `composer.host`*

*Built: the runtime-mode picker's key is **`mod+shift+m`** — the conflict with the Attention
Center's `Ctrl+Shift+A` is resolved there, once, as this paragraph requires; the whole table is one
function, `resolveChatShortcut` (`packages/ui/src/lib/agent-chat/keybindings.logic.ts`), so a new
binding is a new arm rather than a second listener. The account chip **is a picker** — §3.4's
account switch, applied on the next message, with the menu saying so ("Applies to your next
message. The conversation is kept.") — and it carries the `account` token so the one handler can
address it, but it still gets **no chord**: it is changed rarely, and every chord spent is one the
terminal surfaces cannot have. It is offered only while the thread is idle — the client half of
§3.4's gate, `canSwitchChatAccount` in `lib/agent-chat/account-switch.ts`, mirroring the host's
`identitySwitchRefusal` — and disabled otherwise with "Available when the agent is idle"; the
daemon is authoritative and answers 409 to anything else. An OpenCode thread keeps the plain label
it always had, because its server owns the identity and a control that could only refuse is worse
than no control. `/effort <id>` is a narrow client-side bridge that writes the current `ModelSelection`'s
effort option and sends nothing (§4.6.5). A paste that folds into a text attachment reports itself
**inline in the composer** rather than as a toast, because a toast for something that already
produced a visible chip is noise (`packages/ui/src/components/agent-chat/composer/`).*

*Built: **attachments name themselves in the text.** An image inserts `[Image #N]` at the caret
when it is staged — the CLI's own placeholder for a pasted image — numbered by its position among
the staged images; removing it drops the placeholder and renumbers the later ones
(`packages/ui/src/components/agent-chat/composer/composer-images.ts`). A non-image file inserts its
**absolute host path** when its upload completes (the path is not known before), exactly as the
terminal-era upload typed it into the PTY; removing the chip removes the path, and a returned
queued message re-stages its chips without re-inserting a path the text already names
(`composer-files.ts`). The path rides the upload reply as `AttachmentRef.path` (§6.3) and the
persisted draft keeps it so a reload can still strip it. The chips carry a **file-type icon** — a
vendored subset of Material Icon Theme (`packages/ui/src/icons/files/`) — an image chip shows a
thumbnail of the local file and a hover preview, resolved through `GET …/attachments/:attachmentId`
when the draft was reloaded and the `File` is gone (`ComposerAttachments.tsx`). An insert that is
not the composer's own typing — a finished upload's path, and every insert through the composer
bridge (a delivered ref, the queue drained back by an interrupt, a displaced custom answer) —
places the caret without moving focus unless the textarea already had it; a surface that means
"edit this in the composer" (a queued row's return action) asks for focus explicitly.*

**The queued-message model.** This is the client's own queue of messages it has not dispatched
yet, and it is a different thing from the host-side queue that holds already-posted `/turn`s behind
a running compaction (§3.4). A queued message is a full draft snapshot — text, attachments,
submission intent, the id of the tool activity it was queued behind, and a `holdUntilUserAction`
flag — held in memory only, because a queued message is a live intent and not a draft worth
persisting. It flushes at the **next tool-call boundary or at turn end**, whichever comes first;
taking one re-anchors every remaining message to the new boundary, so exactly one message leaves per
boundary instead of the whole queue draining at once. Three guards are load-bearing: a send that
grabbed a message before an interrupt and finished its upload after must detect the drain and give
up, or Stop is followed by a queued message starting a new turn; a failed send is re-inserted at the
front with `holdUntilUserAction` so nothing overtakes it; and nothing flushes while an approval or a
question is pending.
*T3: `apps/web/src/queuedMessageStore.ts:15-36` — `QueuedComposerMessage` and `queuedAfterToolActivityId`; `:70-71` — "a queued message is a live intent, not a draft worth persisting"; `:84-107` — `take` re-anchors the remainder; `:40-45, 141-152` — `drainGeneration`; `:128-140` — `holdAtFront`; `:188-197` — `isQueuedMessageDue` (hold → never; connecting → never; not running → immediately; running → when a later tool activity has landed); `apps/web/src/components/ChatView.tsx:8604-8642` — the drive loop and its pending-request gates; `docs/user/composer.md:31-48` — the user-facing contract ("It goes out on its own when the agent finishes its next tool call, or when the turn ends. … Stop returns every queued message to the composer.")*

**Steer versus queue is one setting with a per-message inversion.** A plain send follows the
preference; holding the mod key with Enter does the opposite for that one message. A separate
binding sends the head of the queue immediately, leaving the current draft alone.
*T3: `apps/web/src/components/ChatView.tsx:7629-7658` — the XOR `(followUpBehavior === "queue") !== (submissionIntent === "alternate")`; `apps/web/src/composer-logic.ts:27-44` — `"alternate"` from mod+Enter while running; `packages/shared/src/keybindings.ts:45` — `mod+shift+enter` → `thread.steerQueuedMessage`*

The ghost bubble is a dashed, right-aligned, dimmed user bubble carrying a "Queued" clock chip whose
tooltip says *when* it will go — "Sends after the next tool call or when the turn ends", or "Sends
after the messages above it", or "Waits for Send now" — plus ↑ send-now and ✗ return-to-composer.
Queueing that is invisible is alarming; queueing that names its own trigger is not.
*T3: `apps/web/src/components/chat/MessagesTimeline.tsx:1759-1857` — `QueuedMessageTimelineRow`, the three `statusLabel` strings at `:1772-1777`, and the two actions at `:1811-1852`*

### 7.5 Approvals and questions

A banner docked between the status line and the composer, one request at a time with a `1/N`
counter. The dock renders in a fixed priority order — approval, then pending question, then the
plan-ready prompt, then the mobile-collapsed question — under a general notice stack that sorts
live activity first and severity behind it.
*T3: `apps/web/src/components/chat/ChatComposer.tsx:6131-6274` — the `ComposerBanner.Dock` and the four-branch if-chain, with `variant="warning"` / `density="spacious"` for approvals; `apps/web/src/components/chat/ComposerBannerStack.tsx:33-41, 91-92` — activity first, then urgent/error/warning, then notices*

Approvals: Approve and Decline as primary buttons, every other advertised option with its label and
warning in an overflow menu, "accept for session" always available. When the provider advertises no
options the offered set is §4.3's default four: Approve and Decline stay primary, and Always allow
this session and Cancel sit in the overflow menu. An option's
`warning` string becomes a triangle icon, a tooltip and an `aria-description`. The header label comes
from the request type — command, file read, file change, app permission, app access — and the detail
renders as a scrollable, keyboard-focusable monospace block (prose for elicitations) so a long
command can be read without leaving the banner. While a decision is in flight every control in the
row is disabled, keyed on the in-flight request ids.
*T3: `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx:17-36` — the `requestKind` → label map and its aria twin; `:47-49` — the `1/N` counter; `:51-63` — the `max-h-20`, `tabIndex={0}`, `whitespace-pre font-mono` detail; `apps/web/src/components/chat/ComposerPendingApprovalActions.tsx:23-28` — `DEFAULT_APPROVAL_OPTIONS`; `:36-41` — the primary/overflow split on `decline`/`accept`; `:52-68, 84-108` — the warning icon, tooltip and `aria-description`; `:51, 73, 88` — `isResponding`; `apps/web/src/components/ChatView.tsx:1728, 8673-8698` — `respondingRequestIds`*

Questions: one card per question with header, prompt, options with descriptions, digit shortcuts
1–9, multi-select where allowed, a custom answer field where allowed, and answer attachments.
Single-select commits optimistically and advances after 200 ms; multi-select toggles in place. A
non-empty custom answer beats selected options, and an attachment alone satisfies a question. The
card is collapsible, keyed by the **question id** rather than a bare flag, so it reopens when the
prompt advances — a tall prompt must stop covering the thread the user is reading, but the next
question must not arrive already hidden. Digit shortcuts are suppressed while the card is collapsed,
since the numbers they refer to are off screen. "Dismiss" is offered only when the request carries `dismissible` (§4.2) — for a question that is
`responseMode: "message"` — and posts `/dismiss` (§6.2); a native callback blocks the provider and
must be answered.
*T3: `apps/web/src/pendingUserInput.ts:160-191` — `derivePendingUserInputProgress` (`activeQuestion`, `answeredQuestionCount`, `isLastQuestion`, `canAdvance`, `isComplete`); `:42-68` — `resolvePendingUserInputAnswer`, custom-beats-options, array for multi-select, attachments-alone → `""`; `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx:75-82` — the collapse-keyed-by-question-id comment; `:118-135` — the 200 ms auto-advance with optimistic selection; `:137-166` — the digit handler and its collapsed opt-out; `packages/client-runtime/src/pendingRequests.ts:21-27, 171` — `dismissible` = `responseMode === "message"`*

*Built: the question card owns its **Submit** button and its custom-answer field outright, rather
than handing them to the composer's primary action. A question and a draft are two different
intents sharing one text input, and the 200 ms optimistic advance above makes "which one does
Enter send?" genuinely ambiguous — an explicit Submit on the card removes the question
(`packages/ui/src/components/agent-chat/banners/`). Codex's `isSecret` renders as a masked field
and its `isOther` as the free-text option, and an answer goes back as the option's **label**,
since that CLI's options carry no `value` (§4.5 Codex).*

Focus stays in the composer throughout. An approval is never a modal and never steals focus; the
user can keep typing while it sits there. The composer goes `inert` for exactly one reason — while a
revert is running.
*T3: `apps/web/src/components/chat/composerEventScope.ts:34-42` — pointer and focus landing on a docked banner act on that control and must not expand a resting composer; `:12-28` — floating layers return focus to the composer; `apps/web/src/components/ChatView.tsx:9990` — `inert` only while reverting a checkpoint; `docs/user/keyboard-focus.md:1-9` — the client's focus contract*

Any draft text displaced by an answer is carried back into the draft. Clicking an option would
otherwise silently discard a typed custom answer, because a custom answer outranks a selection; the
text is appended after whatever was already waiting in the draft instead.
*T3: `apps/web/src/pendingUserInput.ts:87-105` — `carryDisplacedCustomAnswerIntoPrompt` and the rationale comment*

Answer attachments live in their own per-question draft namespace, keyed by `(requestId,
questionId)`, separate from the prompt draft, so moving between questions keeps each one's files and
never mixes them into the next turn. Uploads must complete before the answer can be submitted, both
staged files and in-flight preparations count against the eight-attachment budget, and a question
offering only predefined choices offers no attachments at all. `responseMode: "message"` questions
are answered by an ordinary turn.
*T3: `apps/web/src/questionAttachments.ts:13-22` — the `(requestId, questionId)` draft id; `:28-36` — staged plus in-flight counted together; `apps/web/src/components/chat/ChatComposer.tsx:1692-1708, 2626-2629` — the upload gate on advance; `docs/user/question-attachments.md:1-9` — the user-facing rules*

### 7.6 Status line and roster

Between timeline and banner: elapsed time, tokens so far, current activity label, and the
context-window meter from `thread.token-usage.updated`. Anything that changes every second is a
self-ticking leaf, never a prop pushed down the row tree.
*T3: `apps/web/src/components/chat/MessagesTimeline.tsx:267-272` — "`nowIso` is intentionally excluded — self-ticking components (WorkingTimer, LiveElapsed) handle it"; `:2890` — `WorkingTimer`*

The meter needs the model's context-window size, not just a token count: without `maxTokens` there is
no ring and no percentage, only a bare total. That is why `thread.token-usage.updated` carries
`maxTokens` and — where the provider reports one — `autoCompactAtTokens` (§4.2); on an adapter with
`reportsContextWindow: false` (OpenCode, Grok) the meter degrades to the bare total. The meter's
popover shows used/total, the total processed across the thread, the auto-compaction sentence, and
a **Compact** button, which is always present because §4.6.3 synthesises `/compact` on all four
adapters. Over 90 % the ring turns red.
*T3: `apps/web/src/lib/contextWindow.ts:28-75` — `deriveLatestContextWindowSnapshot`; the percentage and remaining tokens are `null` whenever `maxTokens` is; `apps/web/src/components/chat/ContextWindowMeter.tsx:26-33` — the ring and the `> 90 %` error colour; `:60-90` — the degraded token-count-only readout; `:137-158` — the Compact button; `apps/web/src/components/chat/ContextWindowMeter.logic.ts:15-19` — `providerSupportsManualCompaction`; `:100-110` — the auto-compaction sentence*

*Built: `thread.token-usage.updated` is **last-writer-wins and never merged** — the client takes
the latest `context-window.updated` activity whole — so every emission must be a complete reading,
window included, and nothing but the MAIN agent's own context may move it. All four adapters
report one, so `reportsContextWindow` is now true everywhere (the spec's `false` for OpenCode and
Grok was true only of the versions T3 was written against). Per adapter:*

- ***Claude** — the authority is the SDK's `Query.getContextUsage({detail:"summary"})`, the CLI's
  own `/context` accounting, called once the session is ready and again after every `result` and
  `compact_boundary` under a 5 s deadline: `usedTokens = totalTokens`, `maxTokens = rawMaxTokens`
  (what the CLI measures its own percentage against), `autoCompactAtTokens = autoCompactThreshold`
  and `compactsAutomatically = isAutoCompactEnabled`. `summary` mode makes no token-count API call,
  which is the reason T3 could not do this. Between calls the meter rides the main agent's
  `message_delta` usage; `totalProcessedTokens` is Σ `modelUsage[*]`, which is cumulative across
  turns and includes subagents. A rejection, a timeout or an older CLI is one debug line and the
  last known reading — never a warning row and never a failed turn. **A subagent's
  `task_progress`/`task_notification` usage never reaches the meter** (it is roster data), and
  `result.usage` never sets `usedTokens` (it is the per-turn main-loop rollup, not a context size).*
- ***Codex** — `thread/tokenUsage/updated` carries both halves: `usedTokens =
  last.totalTokens − last.reasoningOutputTokens` against `modelContextWindow`, exactly as Codex's
  own TUI computes it. `total.totalTokens` is the thread's cumulative spend and is reported as
  `totalProcessedTokens` only.*
- ***Grok** — the size is on every chunk's `_meta.totalTokens`, the window only on the handshake's
  `modelState`; the normaliser holds the window and stamps it onto every row, including the
  per-chunk ones, because one window-less row blanks the ring until the next session-level
  emission.*
- ***OpenCode** — each owned `step-finish` carries `tokens.total` (the context that model call
  held) and `GET /provider` carries `limit.context` per `provider/model`, read once per server.
  A child session's steps never count; the running sum of the owned ones is `totalProcessedTokens`.*

*`ThreadTokenUsage` gained `compactsAutomatically?: boolean` for this: `false` is a verdict a
provider proved and the popover then reads "Auto-compaction is off.", while an absent field still
means nobody asked and keeps the existing copy.*

Below the composer: the agent roster. A `main` row, then one row per task from the task events:
type or title, live description, last tool, elapsed, tokens, status. Rows are fixed-height with a
fixed number of lines, so a changing description or token count never changes a row's height and the
roster never reflows under the pointer; status is a static dot and elapsed is written straight to the
DOM node rather than through a render, so a live roster costs no React commits per second. An idle
but resumable agent reads as settled (muted), not as in-motion — a live-coloured idle dot reads as
stuck.
*T3: `apps/web/src/components/AgentsPanel.tsx:1-12` — the visualization rules ("changing data must never change their height", "Static status dots, DOM-write elapsed timers"); `:38-49` — `STATUS_VISUALS` and the idle-reads-as-settled comment; `:86-113` — `AgentElapsed`, a DOM-write ticker; `:140-192` — `AgentRow`, three fixed lines: identity + role chip + elapsed, activity, then `model · tokens · tools · run N`; `:120-137` — `agentActivityText`, which prefers `progress`, then the last tool, then result/error while live and reverses that order once settled*

The roster row model is a fold over the §4.2 task events keyed by `taskId`, carrying the linkage
bundle those events repeat on every row — `agentKind`, `agentId`, `parentAgentId`, `toolUseId`,
`title`, `model`, `status`, `usage`, `lastToolName`, `description`, `outputFile` — plus the result,
the error and first/last-seen stamps; metadata is never downgraded to null by a later partial
event. Row status is T3's eight names (§4.2) and no other: a `task.completed {status: "stopped"}`
folds to `interrupted`, and the three in-flight statuses — `pending`, `running`, `waiting` — all
present as one steady "working" look, because a queued or waiting subagent is still the fleet
doing its job. Two rules keep it honest: **when the session is not live, every still-active row
becomes `interrupted`** — a crashed or restarted host must not leave a panel full of agents reading
"working" forever, while an `idle` row is left alone because a resumable child stays resumable —
and the roster is
capped, evicting live rows last and newest-settled first, without reshuffling rows that stay visible.
*T3: `packages/client-runtime/src/state/subagentRuntime.ts:22-30` — `RuntimeSubagentStatus`, the same eight values as `RuntimeTaskStatus`; `:426-433` — `TASK_COMPLETED_STATUS`, `stopped` → `interrupted`; `:89-105` — the terminal and active sets; `:59-88` — `RuntimeSubagent`; `:318-397` — `fillMetadata`, "never downgrades known values to null"; `:659-669` — the `sessionLive === false` → `interrupted` derivation and its review finding; `:671-681` — `ROSTER_LIMIT = 100` with the live → idle → newest-settled ranking; `:847-848` — "Updates and the >100-agent retention ranking must never reshuffle rows that remain visible"; `apps/web/src/components/AgentsPanel.tsx:32-40` — "In-flight states all present as Working"*

Background tasks (`agentKind: "background"`) list in the same roster with a distinct icon, and a
**live background row is never collapsed behind "N more" and never fades**: it outlives the turn
that started it, so it stays on screen until it ends or is stopped.

*Built: "background task" needs one more qualifier on Claude, because **every** Bash call raises a
`local_bash` task — a foreground one simply carries `is_backgrounded: false`, and surfacing those
put a roster row on screen for every `ls`. Only a detached task is surfaced (the SDK's
`is_backgrounded`, promoted later by `task_updated {patch:{is_backgrounded:true}}` when the user
hits Ctrl+B); `ambient`/`skip_transcript` tasks are not activity at all. `task.started` carries
`isBackgrounded` and `task.completed` carries `exitCode` so the row can say so. A surfaced shell
additionally owns a `command_execution` item (`itemId: "bgshell:<taskId>"`, `agentId: <taskId>`)
whose `command_output` deltas are **tailed off a file**: the CLI writes a background command's
output to its own tmp tree rather than streaming it, so a drill-in with no tail reads "has not
reported anything yet" for the whole run. `background_tasks_changed` is deliberately NOT used to
close rows — it is a level signal whose ordering against the bookends is unspecified, and
correlating it made a clean shell read as interrupted (fixtures README observation 18).*

Stopping is T3's, not the row's. Once a turn settles the composer's stop button is gone, so while
`backgroundLiveness` is non-null and no turn is working, a banner sits in the notice stack above the
composer (§7.5) at activity priority: "N agents working" — or "Background work" when the live
agent count is zero — for `working`, "Monitoring" for `monitoring`, with one **Stop** button. Stop
posts `/interrupt` with no `turnId` (§6.2), which stops every live subagent, shell and watch loop of
that thread at once; there is no per-row stop. The button reads "Stopping…" until
`backgroundLiveness` clears rather than until the command returns, because an accepted interrupt is
not yet a dead process; a failed command clears it at once and surfaces the error; and the pending
flag is per thread, so switching tabs while one thread is stopping never disables another's button.
*T3: `packages/contracts/src/providerRuntime.ts:537-571` — `classifyTaskAgentKind` and the monitor/inert task-type denylist, stamped server-side once so clients trust it outright; `packages/client-runtime/src/state/subagentRuntime.ts:110-121` — `isBackgroundTaskActivity`, unstamped rows are background by definition; `apps/web/src/components/ChatView.tsx:6225-6303` — the liveness banner: shown only when not working, `priority: "activity"`, the three titles, "Stopping…" held until liveness clears, the per-thread reset and the failure path; differs: T3 **excludes** background tasks from the roster entirely (`packages/client-runtime/src/state/subagentRuntime.ts:479-483`, "a 'Run 12s stall' shell is not a subagent") and renders them as ordinary work-log rows; we list them in the roster and keep T3's banner as the one stop affordance*

The timeline's spawn row stores only ids — the batch's `workflowId` and its member task ids — and
resolves its label, live flag and member list from the roster model at render time. Persisting a
count in the row would go stale the moment a member finishes.
*T3: `apps/web/src/session-logic.ts:85-94` — `agentSpawn: {workflowId, agentTaskIds}` and the "derives its live status and member list from the agent panel model at render time" comment; `apps/web/src/components/chat/MessagesTimeline.tsx:4594-4664` — `AgentSpawnRow` re-resolving against the panel model each render; `apps/web/src/components/chat/agentSpawnSummary.ts:8-64` — `deriveAgentSpawnSummary`: "Kicked off 3 subagents" live, "Ran 3 subagents" settled, and a status of `N working` / `N failed` / `N idle` / `Status unavailable` / `✓ completed` that never reads a missing agent as completed*

Rows past five collapse behind "N more", and finished rows fade and disappear when the turn ends —
except a live background row, which is exempt from both: it is always rendered, it does not count
towards the five, and hiding or showing the rest never moves it.
Clicking a row swaps the main area to that agent's timeline: its prompt at the top, then its items
filtered by `agentId`, streaming live, rendered with the same row components, read-only, with a
breadcrumb and Escape back to main. The drill-in must not remount the parent: the composer and roster
stay mounted so the parent can be steered while watching a child, and the child view dispatches no
commands. On OpenCode and Grok the roster shows whatever their protocols report and nothing more.

**The drill-in shares the parent's `sessionId`**, and does not remount it — so while a child is open
there are *two* live timelines under one session id, one of them hidden behind the other. Anything
keyed on the session id alone therefore cannot tell them apart: a `window` keyboard listener gated
only on "am I the visible tab?" fires twice, and a per-thread write (the §7.2 scroll LRU) would
record the child's position against the parent's thread. Both need a second discriminator — the
drill-in refuses the write outright, and the timeline's `mod+J` additionally requires the listener's
own scroller to have a layout box. Several surfaces could trip on this, not just those two.
*T3: `apps/web/src/components/AgentsPanel.tsx:139-140` — `/** Flat, non-interactive agent status line. No unfold. */`; `:550-567` — every row renders, with no "+N more" and no removal of finished rows; only the fold's silent 100-row cap bounds it; `:313-317` — a workflow section "keeps that shape as it settles so completion never yanks rows out from under the user"; `apps/web/src/components/chat/MessagesTimeline.tsx:4654-4660` — the closest T3 equivalent of a drill-in, an "Open Agents panel ›" link into a right-panel surface. differs on three counts: T3's roster is a right-panel surface rather than a dock under the composer; its rows are not clickable and there is no per-agent timeline, no `agentId` filter and no breadcrumb; and it neither collapses nor removes settled rows. Our collapse-past-five, fade-on-turn-end and the live-background exemption from both are new, so they must not fight the "never reshuffle what stays visible" rule above, and the drill-in is new surface with no precedent to lean on*

*Built: the five-row rule applies to **ungrouped** rows only. A workflow group — a spawn batch
rendered as one section — keeps its whole membership, because collapsing half a batch behind
"N more" breaks T3's "a workflow section keeps that shape as it settles" rule that the paragraph
above adopts. "Past five" is the first five rows **in spawn order**, not by rank: a roster that
re-sorts as statuses change moves rows under the pointer. An `idle` row is settled but **not**
finished — it does not fade out, because a resumable child is still there to click. Reopening a
thread that settled while the tab was closed starts every row at `removed` rather than replaying
a fade nobody was watching. And there is no workflow-script viewer
(`packages/ui/src/components/agent-chat/roster/`).*

*Built: **shells are a section of their own, and the roster counts the two kinds apart.** Listing
background shells beside subagents (the deliberate departure from T3 above) made them look like
subagents — one chip reading "shell" was the only difference, and a folded roster said "5 agents"
for four subagents and one command. Agent rows keep T3's three-line shape; shell rows sit below
them under a "Shells · N running" caption with a **two-line** shape of their own — a framed
terminal glyph, the command's description, then the one fact a process has (running, or its exit
code, which also renders as a badge toned by success/failure). Each kind keeps its own spawn order
and a row never moves between the two lists, because the partition is by `agentKind`, which never
changes — so "never reshuffle rows that stay visible" still holds. The folded label reads
"4 agents · 1 shell running", and the footer's "● N working" counts agents only
(`roster-summary.ts`, `BackgroundShellRow`). The dock above the composer (§7.5) is a drawer, not a
card: the composer's wrapper is stacked above the dock's, the bottom-most card carries the 17px
overlap as padding, and the dock's inset equals the composer box's inset plus its corner radius so
card sides meet the box's flat top edge (`ac-banner-attached`, `ChatBannerDock`).*

### 7.7 Other surfaces

Status dots, the Attention Center, push notifications and the command palette work from
`SessionSummary.activity` and the two per-thread bus events of §6.4. Rate-limit windows merge into the
Settings usage overview by window id. `auth.status` with an error surfaces a toast pointing at
Settings → Accounts. When an open chat tab's stream (§6.3) delivers `thread.turn-diff-completed`,
the client refreshes the git tab for that project; no new bus event is introduced for it (§6.4).

*Built: **`unknown` is not `unauthenticated`.** T3's Claude driver emits `auth: {status:"unknown"}`
on every failure and ambiguity path — disabled, version probe failed, timed out, capabilities
missing, no credentials found, still pending (`ClaudeProvider.ts:452,478,496,520,552,617,632`) —
and `"authenticated"` only when the initialization result positively yields credentials (`:582-587`).
`unauthenticated` is reserved for a driver that can PROVE it from a credential answer:
`CodexProvider.ts:553` (`account/read` with `requiresOpenaiAuth`) and `GrokProvider.ts:491` (the
CLI printed that it is not logged in). Orquester's Claude probe used to read a silent init result
— one that succeeded but carried no `account` block — as a logged-out verdict, which is wrong:
`claude` initialises fine under an API-key/Bedrock environment and under a first-party login whose
account block the CLI simply does not return. That claim is what made the client toast "claude
needs signing in again" at a host whose managed accounts were all valid, the bug
`apps/daemon/src/agent-chat/provider-auth-overlay.ts` was written to paper over. The overlay stays
— it still repairs the same claim arriving from an older surviving host — but the probe no longer
manufactures it (`buildClaudeAuth`). Codex, Grok and OpenCode already followed the rule;
`apps/daemon/src/agent-host/adapters/auth-status.test.ts` pins all four.*

*Built: **the toast's alarming copy is gated on proof, and its dismissal is keyed on the whole
verdict.** T3 shows "Not authenticated" only for `auth.status === "unauthenticated"` — `unknown`
reads as "Available" (`providerStatus.ts:44-79`) — and the "<provider> is unauthenticated" banner
title only when `status === "error"` AND `auth.status === "unauthenticated"`
(`ProviderStatusBanner.tsx:78-81`). `authErrorNotice` in
`packages/ui/src/lib/agent-chat/providers.ts` now returns a `tone`: `"sign-in"` (the "needs signing
in again" title, Settings → Accounts) only for `unauthenticated`, and T3's neutral `"status"` copy
for a snapshot that merely failed — and that arm additionally requires `installed`, because an
absent CLI is a Settings → Agents problem with no credential to fix. **Differs from the plain
reading of T3's rule in one place, deliberately:** an `unknown` + `status: "error"` snapshot still
raises an ambient notice rather than nothing at all, because that is exactly what a turn-time
`auth.status {error}` produces (`provider-snapshots.ts` applyAuthStatus stores `error` + `unknown`
rather than claiming a verdict the probe has not reached) and dropping it would silence a real,
provider-reported failure. It just no longer tells the user to re-authenticate. The remembered
dismissal is keyed on `[adapterId, status, auth.status, message]`, T3's own banner key
(`ProviderStatusBanner.tsx:20-23`), so the same result never re-toasts while a verdict that MOVED
still gets through (`packages/ui/src/lib/agent-auth-notice.ts`).*

**A thread's title is client-seeded and host-owned thereafter.** There is no title-generation
service, and none is introduced. The client seeds the title at creation from the first message —
plain text, context references stripped, truncated — falling back to the first attachment's name
and then to a literal default, and writes it through the `PUT` of §6.1, which appends
`thread.meta-updated` (§5.1). The host may replace that seed later — a provider that reports a
thread name through `thread.metadata.updated` (§4.2) — but only while the current title is still
exactly the default or exactly the seed, so a manual rename is never clobbered. The seed alone is
sufficient, and a failure to improve it is logged, not surfaced.
*T3: `apps/web/src/components/ChatView.tsx:8271-8287` — the client-side `titleSeed` and its fallback chain (`Image: …` → `File: …` → context label → `"New thread"`), truncated by `packages/shared/src/String.ts:1-8` at 50 chars; `apps/server/src/orchestration/threadTitles.ts:1-13` — `DEFAULT_THREAD_TITLE` and `canReplaceThreadTitle`; `packages/contracts/src/orchestration.ts:673-678` — `ThreadTitleState {source: manual|generated, version, needsRefinement}`; `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:946-1003` — the first-turn generation, re-checking replaceability after the await and logging a warning on failure; `:1005-1026` — refinement, gated on the turn having completed and the thread still holding exactly one user message. differs: T3 generates the title with a separate `TextGeneration` model call; we have no such service, so the seed is the title until a provider offers a better one*

**Needs-attention and unread are two different things.** Needs-attention is the §6.4 ladder read
off `SessionSummary` — this surface re-derives nothing — and colour is spent on only three of its
outcomes: act-now (approval), in-motion (working) and broken (failed); resting is unlabelled, and
`backgroundLiveness: "monitoring"` borrows the in-motion colour without its pulse (§6.4).
Unread is separate: the latest turn's `completedAt` is newer than this client's last visit to that
tab. A "mark unread" action is just a last-visit stamp set one millisecond before that completion.
*T3: `apps/web/src/components/Sidebar.logic.ts:805-818` — the five-state, three-colour model; `:835-864` — `resolveSidebarThreadStatus` and its precedence, including "A failed session outranks lingering background liveness"; `:635-644` — `hasUnseenCompletion`; `:1010-1099` — `resolveThreadStatusPill`, the label/colour/pulse table (only Working and Connecting pulse); `:820-833` — `shouldRecedeSidebarThread`; `apps/web/src/uiStateStore.ts:250-296` — `markThreadVisited` / `markThreadUnread`*

*Built: the visit is stamped at the latest turn's **`completedAt`, never `now()`** — T3
`ChatView.tsx:2108-2125`, and the difference is the whole behaviour: stamping the clock marks as
read a completion that has not arrived yet, so a turn finishing a second after the user glanced at
the tab is silently swallowed, while stamping the completion clears exactly the one on screen and
lets a later one raise its own mark (`markThreadVisited` is monotonic). T3 does this from an effect
keyed on `latestTurn.completedAt`, which fires on mount AND on every later completion; Orquester's
chat tabs stay warm while hidden, so the equivalent lives in the store: `activateTab` stamps, and
the `session.updated` handler re-stamps when the summary belongs to the tab the user is currently
on (`markThreadRead` in `packages/ui/src/lib/thread-visits.ts`, `visitChatThread` in
`store/app.ts`). "Mark unread" is on both the tab-strip and the sidebar-row menus. The mark refines
the daemon's signal and never replaces it: `shouldRecedeSidebarThread` dims an "Opened Agents" row
that wants nothing from the user (working/monitoring always, ready/approval only once read, input
never, the selected row never — `resolveSidebarThreadStatus` +
`shouldRecedeSidebarThread` in `packages/ui/src/lib/agent-chat/status.logic.ts`), and the status
dot drops its pulse for a `finished` attention this client has already read while keeping its
colour. Two differences from T3, both because Orquester has no snooze and no settle: the `isWoke`
input is always false and is not plumbed, and T3's `failed` recede bucket is folded into `ready`
(T3 recedes them identically).*

### 7.8 Mobile

Inherited from the shell: `#root > *` owns the safe-area insets and `visualViewport` height. The
composer overlay and roster are inside that box. No new fixed overlays; the approval banner is in
flow.
*T3: `apps/web/index.html:5-8` — `viewport-fit=cover, interactive-widget=resizes-content`; `apps/web/src/index.css:936-950` — the four `pt-safe`/`pb-safe`/`pl-safe`/`pr-safe` utilities; `:1550-1560` — `#root` owning the top inset with `overflow-y: hidden` and `overscroll-behavior-y: none`. differs: T3 lets the meta tag resize the layout viewport and has no `visualViewport` code anywhere; Orquester's shell already measures `visualViewport` and pads `#root > *`, so chat inherits that and adds nothing*

Below the narrow breakpoint the composer collapses to a single row until focused or multiline,
**Enter never sends** (the on-screen Return inserts a newline and the send button is the only send),
the composer blurs after a successful send so the keyboard dismisses, and opening a tab does not
autofocus the composer — a keyboard on every navigation is worse than a tap. The approval and
question banners get a compact variant with an explicit "write a custom answer" action that is the
only thing allowed to move focus. One breakpoint governs all of this; T3 runs three and has a band
where the sidebar is a sheet while the composer is still in desktop mode.
*T3: `apps/web/src/components/chat/ChatComposer.tsx:2102-2103` — `isComposerCollapsedMobile`; `apps/web/src/composer-logic.ts:37` — the mobile Enter suppression inside `composerSubmissionIntentForEnter`; `apps/web/src/components/chat/ChatComposer.tsx:3711-3750, 3802` — `blurMobileComposerAfterSend`; `apps/web/src/components/ChatView.tsx:5743-5768` — autofocus suppression on mobile; `apps/web/src/components/chat/ChatComposer.tsx:6200-6271` — the mobile-collapsed question layout and its focus-moving "Write custom answer" button; `apps/web/src/hooks/useMediaQuery.ts:3-11` and `apps/web/src/rightPanelLayout.ts:1` — the 640 / 768 / 980 split we deliberately do not copy*

*Built: only the **question** banner gets a compact variant; the approval banner renders the same
row at every width. This matches T3, whose approval branch is taken before any mobile check, and
the row survives a 360 px viewport — title, Decline, Approve and the overflow menu — because the
title does not truncate. A compact approval is a follow-up, not a regression
(`packages/ui/src/components/agent-chat/banners/banner-model.ts`).*


## 8. Deployment

- New daemon runtime deps require `CI=1 pnpm install --frozen-lockfile </dev/null` on deploy, as
  today.
- The host runs from `/opt/orquester` source under tsx. After a deploy the surviving host runs
  old code until the drain-restart in §3.1. The host must have no lazy dynamic imports so a
  changed source tree cannot be loaded into an old process.
- No Caddy change: every route is under `/api/`. No service worker change: `/api` is already
  bypassed.
- `pnpm build` and the browser smoke test after the UI lands, as for any web change.
- The unit file is unchanged. The host inherits `TMPDIR`, `NPM_CONFIG_PREFIX`, `PATH` and
  `HOME` from the daemon's environment by explicit copy.

**A bound socket is not readiness.** The drain-restart hands over only after the replacement host
has acquired its adapters, opened the thread store, completed the §3.3 reconcile and opened its
command gate — the boundary in §3.1, not the moment the socket accepts. Every fallible startup
step sits before that boundary, the daemon holds a deadline on it (two minutes, then give up), and
on failure the old host is left running and the deploy is reported as not switched rather than
silently half-applied.

*T3: `docs/internals/server-updates.md:16-31` — the commit boundary: migrations, dependencies, HTTP bound and every long-running root parked before `prepared`; "A listener alone does not prove the runtime is ready to commit"; a failed or timed-out trial returns to the old version; `apps/server/src/serviceLauncher.ts:33` — `PREPARED_TIMEOUT_MS = 120_000`; `:34` — `TERMINATE_GRACE_MS = 5_000` before the old child is killed*

*Built: the handover is **drain-then-replace**, not trial-then-commit. T3 starts the replacement,
waits for its `prepared` and keeps the old version if it never comes; here both hosts would have to
bind the same `agent-host.sock`, so a trial is not expressible. The restart is therefore deferred
until no thread has an active turn or live background work, the old host is asked to `/stop`
(which writes every continuation marker), and the supervisor then **waits for the old host's
process to exit** — its tmux service session ending, plus the socket — bounded at 30 s, before
spawning the replacement. The socket closing is the teardown's FIRST step, not its last: killing
the tmux session the moment it went quiet cut the teardown short, so no `session.exited` and one
"Task stopped" row out of five were written and the threads read "running" for dead work
(2026-09-23); OpenCode's server is also spawned `detached: true`, so it would survive the kill
holding its port while the new host started a second one for the same project. An intentional
`/stop` ends the process explicitly once the teardown completes. A
replacement that never reaches readiness latches `error` and is retried with backoff rather than
being silently half-applied (`apps/daemon/src/agent-chat/supervisor.ts`).*

**A restarted host is not a reconnect.** The host carries an instance id that changes on every
start; it is returned on `GET /api/agent/providers` and stamped on the `synchronized` frame of
`/events` (§6.3). A client that reconnects to a different instance id re-reads the thread instead
of resuming by sequence — otherwise a restart that happened during the disconnect is
indistinguishable from a dropped socket, and the client resumes from a sequence the new host's
reconcile has already moved past.

*T3: `docs/internals/server-updates.md:45-51` — clients correlate the launcher's update ID with the ready event; "A reconnect alone cannot distinguish successful replacement from rollback"*

**Restarting the host interrupts live work, and that is a user-facing fact.** The drain-restart
waits for turns to settle (§3.1), but a manual restart, a crash or a machine reboot does not.
Whether those threads are continued is the per-project setting in §3.3, default off; the Settings
copy must say what the setting resumes (a thread with a saved resume cursor) and what it cannot (a
thread without one needs a new message).

*T3: `docs/user/updating.md:8-22` — "Server updates restart the connection and can interrupt active agents"; the continuation setting is off by default and "threads without saved provider resume state need a new message"; `apps/server/src/cli/update.ts:468-487` — the CLI names what a restart interrupts, prompts, and refuses to restart non-interactively without `--yes`*

**The thread log is outside every rollback.** Rolling the deploy back to an older host rolls back
code, never `<appdir>/daemon/agent/threads/`: events appended by the newer host stay on disk and
the older host must still fold them. Every event shape therefore has to stay decodable by the
build before it, and an unparseable thread degrades to that thread alone (§5.1), never to a host
that will not start. The same applies to the client: a chat tab's persisted state is read by
whichever bundle the browser happens to be holding.

*T3: `docs/internals/server-updates.md:41-43` — "Attachments and other files outside SQLite are outside this rollback boundary"; `docs/internals/overview.md:68-70` — "Persisted events must remain decodable on replay. Changing a schema affects old environments at startup as well as live RPC traffic"; `docs/internals/providers.md:102-107` — a persisted event shape a newer client introduced once failed a whole environment's startup on replay*

**Agent upgrades are not deploy steps.** `POST /api/registry/:id/install|update` replaces a binary
that live provider children are running from. A running child keeps the inode it started with, so
the upgrade takes effect only for sessions started afterwards; the version shown next to a thread
is the version that thread launched with, not the registry's current one.

*T3: `docs/internals/providers.md:33-36` — "Running processes hold leases on their version. Updates and removal must respect those leases instead of replacing executables under a running agent"; `:74-77` — ownership re-read immediately before an update runs, success only when the refreshed provider is still installed with a readable version*

**Disk.** `<appdir>` is the only writable path under `ProtectSystem=strict`, and the per-thread
logs of §3.1 are now the largest thing the daemon writes there. The rotation caps, the total-bytes
ceiling and the age sweep are a disk guard, not a debugging preference, and the sweep runs on its
own interval rather than on every write.

*T3: `apps/server/src/provider/Layers/EventNdjsonLogger.ts:25-32` — per-file, file-count, total-bytes and age defaults; `:455-477` — age filter then oldest-first byte trim; `:589-620` — retention runs on an interval, not per write; `docs/operations/observability.md:75-77` — provider event NDJSON is a separate artifact from the server's own trace file*

## 9. Testing

The repo has no test runner; the gate is `pnpm check`. This design adds pure protocol and
projection code whose correctness cannot be observed by driving the app alone, so:

- Pure modules under `apps/daemon/src/agent-host/` (Codex framing, ACP framing, event
  normalisers per adapter, the thread fold, batching, slimming, receipts) and under
  `packages/ui/src/components/agent-chat/*.logic.ts` (projections, `isRowUnchanged`,
  `summarizeToolGroup`, roster fold) get tests with Node's built-in `node --test` run through tsx.
  No new dependency; a `pnpm test` script runs them and `pnpm check` is unchanged.
- Adapter tests replay captured `raw.ndjson` fixtures from real sessions of each CLI and assert
  the normalised output. Fixtures are captured once per provider during implementation and
  committed under `apps/daemon/test/fixtures/`.

Each fixture carries its provenance in the file — the CLI version it was captured from, the model
and any effort or mode that shaped the frames — because a capture whose origin is unknown cannot
be judged when the protocol moves. There is no record mode: a fixture is produced by driving the
real CLI over its own transport once and committing the result.

*T3: `apps/server/src/provider/testFixtures/codexMultiAgentWire.json:1-9` — a `capturedWith` block naming `codex-cli 0.145.0`, the model and the effort; `apps/server/src/provider/Layers/CodexCollabWire.test.ts:1-14` — the provenance note and the reason for capturing rather than hand-writing: three shipped bugs came from an implicit routing decision*

Replay happens at two levels, and the cheap one is not sufficient on its own. Frame-level tests
fold a capture through the normaliser and assert the event union. Runtime-level tests spawn a
small mock peer that speaks the provider's transport — replaying the same capture for the
handshake and then a scripted sequence from a file named in its environment — installed on `PATH`
under the agent's own name via a shell/`.cmd` shim, so the real adapter, the real framing and the
real process supervision of §3.1 are all exercised without an account or a network call. The same
shim is what lets registry detection, install state and version probing be tested against a fake
binary.

*T3: `apps/server/src/provider/testFixtures/codexCollabMockPeer.mjs:1-18` + `:36-53` — a Node-stdlib peer replaying the real capture, then a scripted sequence from `T3_CODEX_COLLAB_SCRIPT`, emitting a deterministic receipt rather than letting tests poll; `apps/server/src/provider/testFixtures/codexCollabMockPeer.sh:1-6` and `.cmd:1-8` — the `PATH` shims that strip the subcommand the runtime always passes; `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts:161-215` — the real session runtime booted against that peer; `apps/server/src/testUtils/fakeCli.ts:1-50` — the generic fake-CLI writer, with env carried in a JSON sidecar because neither `sh` nor `cmd.exe` can quote every value; `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts:150-176` — the same fake binary reused for registry probing*

One assertion per capture is structural rather than about any single frame: every method present
in the capture must map to a defined disposition, and an unrecognised method must take the
defined fallback (surface it, plus `runtime.warning`) rather than being swallowed by a catch-all.
That is what keeps §10's "protocols move" promise honest as fixtures are re-captured.

*T3: `apps/server/src/provider/Layers/CodexCollabWire.test.ts:96-110` — every method found in the capture is asserted to route somewhere; `:177-183` — "Unknown methods take the same route by design — a codex update that adds a notification must degrade to 'parent sees it', never to silent loss"; `apps/server/src/provider/Layers/CodexSessionRuntime.ts:1122-1131` — `routeCodexChildNotification`: allowlist, enumerated drop list, everything else falls through*

Nothing in these tests waits on a timer. A command's `commandId` receipt (§6.2) is the handle for
"the host accepted this", and the batcher of §5.6 is drained explicitly rather than slept past.
Where a milestone has no wire event — a checkpoint ref captured, a turn-diff appended, the event
writer flushed — the host publishes it on a receipt bus whose production implementation is a no-op
and whose test implementation is an in-memory queue, so no test-only signal can become production
behaviour. A test that needs a sleep to pass is a bug in the test or in the code.

*T3: `AGENTS.md:110` — "Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong"; `docs/internals/overview.md:84-92` — drainable workers, and test-milestone receipts kept separate from the durable command receipts that make dispatch idempotent; `apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts:1-39` — no-op live layer vs PubSub test layer; `packages/shared/src/DrainableWorker.ts:1-9` — `drain()` resolves when the queue is empty **and** the current item has finished; `apps/server/integration/OrchestrationEngineHarness.integration.ts:216-228` — `waitForReceipt` / `drainProviderRuntime` on the harness*

The §3.3 reconcile is tested headlessly, not only by restarting a real daemon. A scripted
in-process fake adapter — one that returns canned events per turn and can fail a resume on demand
— plus a temporary thread directory lets every restart flavour be asserted: marker present and
absent, cursor present and absent, archived and deleted threads, the per-project continuation
setting on and off, and the "prepared but never sent" case. The assertions are on the resulting
`meta.json` and on which continuation call the fake adapter received.

*T3: `apps/server/integration/TestProviderAdapter.integration.ts:1-50` — a fake `ProviderAdapterShape` with scripted per-turn events and optional workspace mutation; `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts:455-471` — the reconcile asserted over restart flavours with `continueThreadsAfterServerUpdate` toggled, checking session status, `activeTurnId`, `lastError` and the exact continuation input; `apps/server/src/serverRuntimeStartup.reconcile.test.ts` — the same path as a unit test*

Anything that reads a clock or a git repository is pinned. Log rotation and retention are tested
against a set clock rather than real elapsed time, and every test-created repository gets a fixed
`user`, `commit.gpgsign=false` and `init.defaultBranch` through the environment so the checkpoint
refs of §5.4 are byte-stable on any machine.

*T3: `apps/server/src/provider/Layers/EventNdjsonLogger.test.ts:718-735` — `TestClock.setTime` drives the age sweep; `apps/server/src/testUtils/gitConfig.setup.ts:1-21` — git determinism pushed through `GIT_CONFIG_KEY_*` so every spawned git child inherits it*

Tests that drive a real provider CLI stay opt-in behind an environment variable naming the binary
and are skipped otherwise, so the suite never needs an account or a network.

*T3: `apps/server/integration/orchestrationEngine.integration.test.ts:260-262` — `it.live.skipIf(!process.env.CODEX_BINARY_PATH)`, the repo's only real-CLI gate; `apps/server/integration/OrchestrationEngineHarness.integration.ts:231-300` — the harness swaps in the real adapter only when asked*

- Behaviour is verified by driving a separate checkout's daemon: create a chat tab for each of
  the four providers, run a turn that edits a file and runs a command, approve a request, answer
  a question, interrupt, compact, revert, restart the daemon mid-turn and confirm the turn
  continues, restart the **host** mid-turn with the §3.3 continuation setting enabled for that
  project and confirm the same, kill a provider child mid-turn
  and confirm the turn settles as failed rather than hanging, and reload the page mid-turn and
  confirm resume by sequence.

## 10. Risks and accepted gaps

- **Provider protocols move.** Codex app-server is marked experimental; Grok's ACP extensions
  change between releases. Each adapter pins the CLI version range it was validated against and
  emits `runtime.warning` on an unknown method rather than failing the turn. The rule is
  one-directional: an unknown frame is surfaced, never dropped by a catch-all, so a provider
  release that adds a notification degrades to a visible warning instead of a silently missing
  row. A warning never ends an active turn.

*T3: `apps/server/src/provider/Layers/CodexCollabWire.test.ts:177-183` — unknown methods must degrade to "surfaced", never to silent loss; `apps/server/src/provider/Layers/CodexAdapter.ts:2128-2142` — retryable provider errors are `runtime.warning`, terminal ones `runtime.error`; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts:3965-4005` — a `runtime.warning` during an active turn must leave the session running*

- **Version gates refuse rather than degrade.** An adapter whose CLI is below its minimum refuses
  the session with the required version in the message, and a model whose compatibility window the
  installed CLI does not satisfy is not offered at all. The cost is that version detection becomes
  load-bearing: a CLI whose version cannot be read is treated as unsupported wherever a window
  exists, so a registry detection regression looks like a provider outage.

*T3: `apps/server/src/provider/opencodeRuntime.ts:42` + `:155-177` — `MINIMUM_OPENCODE_VERSION` enforced against the server's health response, not only the binary; `apps/server/src/provider/Layers/OpenCodeProvider.ts:472-494` — the same gate on `opencode --version`; `apps/server/src/provider/ClaudeModelCatalog.ts:146-159` — per-model `minVersion`/`maxVersionExclusive`, and an unreadable version fails the window; `:170-185` — the upgrade message built from the lowest unmet minimum*

- **A shared OpenCode server per project is a divergence** from T3, which runs one chat server per
  thread. It holds only while chat threads register nothing thread-scoped into that server and
  while automatic approvals are sent as one-shot grants (§3.2). Both are invariants, not
  preferences: breaking either lets one thread's connection or permissions leak into another's.

*T3: `docs/internals/providers.md:14-23` — differs: per-thread chat servers because MCP registrations are directory-scoped, and the `once` rule for automatic full-access replies on a shared server*

- **OpenCode subagents and plan mode** are partial; the UI degrades to what is reported.
- **Grok cannot roll back conversations**; revert is refused on Grok with an explanatory row. A
  capability must describe what the provider can actually do, and the refusal happens at step 2
  of §5.5, before anything on disk or in the provider is touched — a provider that cannot roll
  back its conversation must reject the operation rather than half-perform it.

*T3: `docs/internals/providers.md:91-94` — "Capabilities must describe what the provider can actually do"; the checkpoint boundary rejects revert before touching files*

- **Claude's SDK bundles a CLI**; `pathToClaudeCodeExecutable` must always point at the registry
  bin or version detection and managed installs stop meaning anything. It must also point at a
  real executable, not a shim or a bare name: the SDK spawns the path directly, without a shell
  and without PATH resolution, and offers no fallback.

*T3: `apps/server/src/provider/Drivers/ClaudeExecutable.ts:45-60` — why a bare command name or an npm launcher shim cannot be handed to the SDK; `apps/server/src/provider/Layers/ClaudeAdapter.ts:4916` — the resolved path passed as `pathToClaudeCodeExecutable`*

- **Codex's sandbox cannot run on this host, and the failure is surfaced rather than hidden.**
  `codex app-server` sandboxes `apply_patch` with bubblewrap, which fails here with
  `bwrap: loopback: Failed RTM_NEWADDR` (the VPS kernel/container does not give the daemon user an
  unprivileged network namespace). In `approval-required` and `auto-accept-edits` a Codex thread
  therefore cannot write files on this box: the patch is approved and then fails inside the
  sandbox. `full-access` (`danger-full-access`) works, because it does not sandbox. The adapter
  reports the sandbox error as it arrives instead of translating it into something friendlier — a
  thread that silently declines to edit files is worse than one that says why.

- **A chat launch auto-accepts Claude's project-trust dialog, confined to the project.** §6.4
  records the mechanism; the accepted risk is that opening a chat tab on a project enables that
  project's `.claude/settings.json` hooks — arbitrary shell, run as the daemon user, which holds
  scoped passwordless sudo — without the dialog the CLI would have shown. The path is the
  request's `projectPath` after `realpath` + `assertInsideFsRoot`, never its `cwd`, and a
  `projectPath` outside the sandbox gets no grant at all; but inside the sandbox the grant is real
  and it outlives the tab, because it is written into the home's own `~/.claude.json`.

- **Grok's settings reach the CLI through an overlay, because its config file is shared.**
  Grok needs `[features] support_permission = true` (without it every approval self-resolves,
  §4.3) and `auto_update = false` (the CLI upgraded itself 1.0.3 → 1.0.34 mid-session). On a
  managed account home `<GROK_HOME>/config.toml` is a **symlink** to the daemon user's own
  `~/.grok/config.toml`, so writing it reconfigures Grok host-wide for every terminal tab and
  every account — which happened twice during this build. The host therefore writes a per-thread
  overlay and points `GROK_CONFIG_PATH` at it, and nothing under a shared home is written. The
  accepted risk is that the overlay is a second place Grok's configuration lives: a user editing
  `~/.grok/config.toml` will not see those two keys there, and a future CLI that stops honouring
  `GROK_CONFIG_PATH` silently returns the thread to self-resolving approvals.

- **A chat thread inherits the home's MCP servers, and their processes outlive everything.**
  Nothing strips the servers a home configures: Grok boots every server in `~/.claude.json` on
  `session/new` (~157 tools, ~3 s) and Codex boots whatever `~/.codex/config.toml` names. That is
  exactly what a terminal launch of the same agent under the same home does today, and a chat
  thread that silently had fewer tools than the terminal tab beside it would be the worse surprise.
  The cost is recorded: a provider CLI spawns its MCP servers itself, so they are children of the
  *provider* child, not of the daemon. One observed server survived the agent host, the daemon and
  thread deletion, reparented to init holding a fixed loopback port — and, being outside the
  daemon's process tree, it is not a legal kill target in Settings → System either.


- **Old host code after deploy** until drain; a protocol version bump forces the drain-restart
  as soon as turns settle. The events written by the newer host stay readable by the older one
  or the rollback is not a rollback (§8).
- **Never reaping is a deliberate memory trade.** T3 stops a provider session after thirty
  idle minutes on a five-minute sweep; here a thread's process lives until its tab closes, so the
  only bound on concurrent provider processes is the number of open chat tabs, on a single VPS
  whose RAM is shared with every terminal. The mitigation is visibility, not policy: the host pid
  and every provider child are in the process tree that Settings → System already shows, and a
  provider child stays a legal kill target (§3.1).

*T3: `apps/server/src/provider/Layers/ProviderSessionReaper.ts:17-18` — differs: 30 min inactivity, 5 min sweep; `:36-118` — the sweep skips a thread with an active turn or live background work*

*Built: the trade is sharper than written, because a chat thread's process tree is not one process.
A Claude thread is one CLI; an OpenCode **project** is one shared server plus its sessions; a Grok
or Codex thread is a child that itself spawns the home's MCP servers (above). So the bound is not
"one process per open tab" but "one process tree per open tab, whose leaves the daemon did not
spawn and cannot reap". The mitigation is unchanged and is still visibility, not policy: the host
pid and every provider child are in the process tree Settings → System shows, the agent host is
registered as an extra tree **root** so its descendants are legal kill targets even though it runs
in a tmux service session (`apps/daemon/src/system-status.ts`, `extraRootPids`), and the host pid
itself stays protected.*

- **Background work outlives the turn, and closing a tab kills it.** Subagent fleets and watch
  loops keep running inside a provider process after the turn settles (§3.1). Closing the tab
  stops the session, which stops them — without a prompt. The roster (§7.6) showing live rows
  after the turn ended is the only warning the user gets.

*T3: `apps/server/src/orchestration/ThreadBackgroundLiveness.ts:1-16` — the turn can settle while native background work runs on; `:63` — session death orphans all of a thread's background work*

- **`raw.ndjson` is as sensitive as the repository.** It records whatever the agent read: file
  contents, command output, environment echoed into a tool call. It lives under the appdir with
  the same permissions as the rest of `daemon/`, is capped and aged out by §3.1, and must never be
  attached to a bug report unread.
- **Hooks are gone for chat sessions.** Any user workflow that relied on Orquester's managed hook
  script inside agent sessions (none are documented) stops applying to chat tabs.
- **Follow-ups, explicitly out of this spec:** per-thread git worktrees; file restore on revert;
  pagination; removal of the legacy `"agent"` kind and the TUI launch path; a Gemini adapter.
