# Server-authoritative agent-session status

**Date:** 2026-07-21
**Status:** Approved design, pending implementation plan

## Problem

Orquester detects agent activity twice, independently, and poorly:

- The daemon's `ActivityTracker` (`apps/daemon/src/ansi-activity.ts`) tracks bells and
  output-quiescence, but exposes the result only to MCP terminal-control tools. Nothing
  reaches `SessionSummary` or `/events`.
- The browser re-derives the same signals from the xterm stream (`onBell`, 3 s idle timers
  in `packages/ui/src/store/app.ts`). The status dot is client-local and resets on reload;
  clients can disagree with the server and with each other.
- A bell means "done *or* needs input" — indistinguishable. Web Push therefore has a single
  generic "needs your attention" notification, debounced 30 s.

Orca (github.com/stablyai/orca) demonstrates the better approach: agents' own lifecycle
hooks report structural state (working / waiting / done) to the orchestrator; terminal
heuristics are only a fallback. This design adopts that layering, sized for Orquester.

## Goals

1. One source of truth: the daemon owns session status; clients only render it.
2. Structural status for Claude Code, Codex, and OpenCode sessions via managed hooks.
3. Two distinct push notifications: "needs your input" vs "finished".

Non-goals (v1): other agents' hooks (gemini, grok, …), OSC 9999 in-band transport,
terminal-title heuristics, keystroke interrupt inference, Codex app-server RPC trust
grants, Windows hook support (bell/quiescence fallback remains), tool-name previews
("using Edit on foo.ts"), notification on session exit.

## State model

`ActivityTracker` (daemon) becomes a small state machine:

```
state:      "working" | "waiting" | "idle"
attention:  null | "bell" | "needs-input" | "finished"
lastOutputAt: number | null
```

Transitions, in priority order:

| Input | Effect |
|---|---|
| Hook: working-class event | `state=working`; clears `attention` |
| Hook: waiting-class event | `state=waiting`, `attention="needs-input"` |
| Hook: done-class event | `state=idle`, `attention="finished"` |
| PTY output chunk | `lastOutputAt=now`; if `state=idle` → `working`. Never overrides `waiting` (a TUI repaint while at a permission prompt must not clear "waiting"). |
| 3 s output silence (`IDLE_MS=3000`, daemon-owned timer) | if `state=working` → `idle` |
| Bell (agent sessions, existing ANSI-aware `BellScanner`) | `attention="bell"` unless a structural attention is already set |
| User input (`/input` HTTP or `/ws`) | clears `attention`; if `state=waiting` → `working` (optimistic; the next hook event corrects it). Replaces Orca's client-side "question answered" inference — all input flows through the daemon. |
| Session exit | activity is dropped; `status:"exited"` renders as today |

Hook events set a per-session `hasHookSource` flag (not persisted, not on the wire) used by
the push policy below.

## Wire surface

- `SessionSummary` (`packages/api/src/index.ts`) gains
  `activity: { state, attention, lastOutputAt }`.
- New event on the existing `/events` broadcaster: `session.activity` with
  `{ id, activity }`, emitted on **transitions only** (state change or attention change),
  never on every output chunk. Worst case ≈ 1 event / 3 s per active session.
- New route `POST /api/sessions/:id/agent-event` with body
  `{ source: "claude" | "codex" | "opencode", event: string, payload?: unknown }`.
  **Unix-socket transport only** — the HTTP transport does not register it (same pattern
  as `PUT /api/config/daemon`). Sessions always run on the daemon's host, so the socket is
  always reachable. Trust model: the socket is the single-user trust boundary; the session
  id in the URL is the only claim. Unknown session id → 404; unknown source/event → 204
  no-op (fail-open, a hook must never break an agent).

## Event → state mapping

One table per source in a new `apps/daemon/src/agent-status.ts`:

| Source | → working | → waiting (+needs-input) | → idle (+finished) |
|---|---|---|---|
| claude | `UserPromptSubmit`, `PreToolUse` (tool ≠ AskUserQuestion), `PostToolUse` | `PermissionRequest`; `PreToolUse` with tool `AskUserQuestion`; `Notification` whose message matches permission phrasing | `Stop` |
| codex | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `PermissionRequest` | `Stop` |
| opencode | `SessionBusy` | `PermissionRequest`, `AskUserQuestion` | `SessionIdle` |

Anything unrecognized is ignored. Exact Claude event names are verified against the
installed Claude Code version during implementation; if `PermissionRequest` does not exist
in the installed version, `Notification` alone covers needs-input.

## Hook delivery

- The daemon writes managed hook scripts to `<appdir>/daemon/hooks/` at boot (idempotent,
  overwrite-on-version-change via a header marker).
- `claude-hook.sh` / `codex-hook.sh`: POSIX shell; exit 0 immediately when
  `ORQUESTER_SESSION_ID` is unset; otherwise
  `curl --unix-socket "$ORQUESTER_DAEMON_SOCK" -sS --connect-timeout 0.5 --max-time 1.5`
  posting `{source, event, payload}` (payload = the hook's stdin JSON) to
  `http://localhost/api/sessions/$ORQUESTER_SESSION_ID/agent-event`. Always `exit 0`.
- OpenCode plugin: POSTs JSON via `node:http` `request({ socketPath })` (works under Bun's
  node-compat). Same env-guard no-op.
- Env injection: agent sessions get `ORQUESTER_SESSION_ID` and `ORQUESTER_DAEMON_SOCK`
  through the existing per-session env path (`tmux new-session -e`, and the local backend's
  spawn env). Shell sessions do not get them.
- Windows / curl-less hosts: installers skip silently; bell/quiescence remains.

## Per-agent installers

Run at session launch for the matching registry id, idempotent, marker-managed
(marker = the command path pointing under `<appdir>/daemon/hooks/`). Install failure logs
a warning and degrades to bell/quiescence — never blocks the session spawn.

- **claude** — merge a managed hooks block into `~/.claude/settings.json`
  (`$HOME` of the daemon user; `/var/lib/orquester` in production). Parse JSON, upsert only
  our entries for `UserPromptSubmit`, `PreToolUse` (matcher `*`), `PostToolUse`
  (matcher `*`), `PermissionRequest`, `Notification`, `Stop`; preserve all user content;
  write back atomically (tmp + rename). Malformed existing JSON → abort install, keep file
  untouched.
- **codex** — upsert managed entries in `~/.codex/hooks.json` (our hook **appended** —
  Codex runs matching command hooks concurrently, so ordering doesn't delay status, and
  appending never shifts user groups' index-based trust keys) for `session_start`, `user_prompt_submit`,
  `pre_tool_use`, `permission_request`, `post_tool_use`, `stop`, plus **trust entries in
  `~/.codex/config.toml`** replicating Orca's direct trust-hash lane (reference:
  `config-toml-trust.ts` in the Orca source). Accepted risk: Codex owns the hash
  algorithm; a Codex update may invalidate trust, at which point Codex silently drops the
  hooks and we degrade to quiescence — log "run /hooks in Codex to approve" as the hint.
  Trust entries are written last so a half-write can't reference a nonexistent hook.
- **opencode** — write `~/.config/opencode/plugin/orquester-status.js`. The plugin
  subscribes to `session.status` (busy/retry → `SessionBusy`; idle → `SessionIdle`),
  `permission.asked` → `PermissionRequest`, `question.asked` → `AskUserQuestion`. It does
  **not** subscribe to message-part streaming (avoids Orca's flood problem by design). It
  carries a child-session guard: before mapping `idle`/`busy`, resolve the event session's
  `parentID` via the SDK client (cached per session id); events from child sessions are
  dropped; lookup failure fails closed (treated as child). Plugin factory takes an opaque
  ctx without destructuring (OpenCode may invoke it with `undefined` at startup).

## Push notifications (`apps/daemon/src/push.ts`)

- Two structural payloads: `"<title> in <project> needs your input"` (on
  `attention="needs-input"`) and `"<title> in <project> finished"` (on
  `attention="finished"`). Debounce: 30 s per session **per type**.
- Bell demotion: once a session has any hook event (`hasHookSource`), its bells set
  `attention="bell"` for the UI but no longer push. Sessions without hook coverage keep
  today's bell push verbatim.
- Delivery internals (VAPID, subscription pruning, log-never-throw) unchanged.

## UI (`packages/ui`)

- Delete the client-side derivation: `noteSessionActivity`, `noteSessionBell`,
  `clearSessionAttention` actions, `idleTimers`/`IDLE_THRESHOLD_MS`, and the xterm
  `onBell` wiring in `TerminalView`.
- `activityById` is fed only from `session.activity` events and seeded from
  `SessionSummary.activity` on session list load/reconnect. Dots survive reload and agree
  across clients.
- `SessionStatusDot`: amber = working, green = idle, **amber pulse** = waiting /
  needs-input, **green pulse** = finished, plain pulse for `"bell"` (today's rendering),
  gray = exited. Focusing a session or typing still clears attention — but now by the
  daemon (input path) or, for focus, via the existing input-free case: focusing sends no
  input, so the client POSTs nothing; instead the client clears the *local rendering* of
  attention on focus and the daemon clears it on next input. (Server state may briefly
  keep `attention` set after a focus-only glance; next input or hook event reconciles.
  Accepted v1 simplification.)

## MCP terminal-control

`activityFields()` and `wait_for_attention` read the same tracker: attention now also
resolves structurally (`needs-input` / `finished`), and the reported `activity` field uses
the tracker's `state` instead of recomputing from `lastOutputAt`. `wait_for_idle`
semantics unchanged.

## Error handling summary

- Hook script/plugin can never block or fail an agent: `--max-time 1.5`, always exit 0,
  fail-open 204 on the route for malformed bodies.
- Installer failures log and degrade; malformed user config files are never overwritten.
- Daemon restart: tmux sessions survive; trackers reset to `idle`/no-attention and
  re-derive from the next output/hook event. `hasHookSource` re-latches on the first hook
  event after restart. Stale `ORQUESTER_DAEMON_SOCK` in a surviving session stays valid
  (path is stable across restarts).

## Testing & verification

No test runner in this repo (`pnpm check` is the gate). Verification:

1. `pnpm check` clean.
2. Manual drive against a scratch-appdir daemon (only when explicitly requested —
   never against the live checkout's daemon): create claude/codex/opencode/shell
   sessions; verify `SessionSummary.activity`, `session.activity` events on `/events`,
   dot behavior across reloads, hook install idempotency (double-launch), and the two
   push types with a subscribed browser.
3. Simulated hook posts via `curl --unix-socket` for the mapping table without needing
   live agents.

## Files touched (expected)

- `apps/daemon/src/ansi-activity.ts` — state machine.
- `apps/daemon/src/agent-status.ts` (new) — event mappings + normalizer.
- `apps/daemon/src/agent-hooks.ts` (new) — script writer + per-agent installers.
- `apps/daemon/src/sessions.ts` — env injection, tracker wiring, launch-time install.
- `apps/daemon/src/index.ts` — route, `session.activity` broadcast, push wiring.
- `apps/daemon/src/push.ts` — per-type debounce, two payloads, bell demotion.
- `apps/daemon/src/mcp/terminal-control.ts` — read shared state.
- `packages/api/src/index.ts` — `SessionActivity` on `SessionSummary`, event type,
  agent-event request type.
- `packages/ui/src/store/app.ts`, `components/terminal/TerminalView.tsx`,
  `components/ui/session-status-dot.tsx` — consume server state, delete local derivation.
