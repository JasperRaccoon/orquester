# GUI agent mode for Orquester — feasibility assessment

Date: 2026-09-20. Status: research spike, no code written.

Question: can Orquester drive coding agents (Claude Code, Codex, OpenCode, Grok, …) through a
chat-style GUI instead of a tmux PTY rendered by xterm.js, the way T3 Code does?

Sources: eight analyst reports in this directory (`orq-1..4` map Orquester, `t3-1..4` map T3 Code),
plus a probe of the agent binaries installed on this host.

## Verdict

**Yes, and it is cheaper than the tmux history suggests.** The PTY assumption in Orquester is
confined to a handful of files, every surrounding subsystem (accounts, model proxy, hooks,
conversations, usage, push, tab model) is already protocol-agnostic, and all four agent CLIs
installed here expose a machine protocol. T3 Code proves the product shape but most of its
complexity serves 200k multi-device users; a single-user port needs a fraction of it.

Recommended shape: a **new session kind (`agent-chat`) that coexists with tmux terminals**, not a
replacement. Shells and the existing agent-in-a-terminal mode keep tmux; chat sessions drive the
agent over stdio/HTTP and persist a conversation id.

## 1. What is on this host

| CLI | Version | Programmatic mode | T3 Code drives it via |
|---|---|---|---|
| claude | 2.1.210 | `-p --input-format stream-json --output-format stream-json --include-partial-messages`, `--permission-prompt-tool`, `--resume`, `--session-id` | `@anthropic-ai/claude-agent-sdk` `query()` (spawns the same CLI) |
| codex | 0.154.0 | `codex app-server` (NDJSON JSON-RPC over stdio, shared daemon available), `codex exec --json` | hand-built app-server client, schema generated from `openai/codex` at a pinned commit |
| opencode | 1.18.5 | `opencode serve` (HTTP + SSE), `opencode acp` | `@opencode-ai/sdk`, one server per thread |
| grok | 1.0.3 | `grok agent` headless, `--output-format streaming-messages-json`, `--permission-mode`, `--resume` | ACP (`grok agent stdio`) + xAI extensions |

gemini, agy, cline, kimi, deepcode are not installed here; Orquester has no integration beyond a
catalog row for them today (`orq-2`).

## 2. Orquester: what actually depends on the PTY

**Backends (`orq-1`).** `ISessionManager` is a pure byte-stream manager. Agents differ from shells
at exactly four sites: the `resolveExtraEnv` seam, `ORQUESTER_SESSION_ID`/hook install,
`resumeLaunchArgs`, and `agentEvent()`. Everything else (id/order/title/reorder/close/persist/
reattach/upload/events) is generic. 35 PTY-only quirks were catalogued; the load-bearing ones
are the second attach PTY, `$TMUX` stripping, alt-screen capture framing, the 80 ms resize
re-capture, the self-deleting 0600 launch script, and all of `ansi-activity.ts`.

**Plumbing (`orq-2`).** Managed accounts, hooks, cliproxy/claudex env, conversation discovery and
usage are filesystem-and-env side effects applied before `exec`. A stream-json child or SDK call
reads the identical env and files, so they transfer unchanged. Genuinely PTY-coupled:

- `ansi-activity.ts` bell/OSC/quiescence heuristics (replaced by protocol events, better signal).
- Every "put this in front of the agent" path is a bracketed paste: session upload,
  browser-pick (`PickComposeSheet`), `initialCommand`. These become structured messages and the
  control-byte-stripping defences in `browser-pick.ts` disappear.
- The daemon's own MCP server (`POST /mcp`: `read_terminal`, `write_input`, `send_keys`,
  `send_and_wait`) is PTY-shaped and is not auto-injected into agents.
- tmux persistence: a stdio child is a daemon child and dies on `systemctl restart`
  (`KillMode=process` signals only node).

**UI (`orq-3`).** The xterm assumption lives in three places: `TerminalView.tsx`,
`MobileKeyBar.tsx`, and the `SessionChannel` shape (`openOutput/sendInput/resize`). `ProjectTab`
is already a discriminated union that `MainView` dispatches on; a chat renderer is one more arm.
Tab strip, grid, palette, rename/reorder, status dots and push read only `SessionSummary`.
Thirteen sites branch on session kind; the one that hides a new kind from the sidebar, the
attention badge and `Ctrl+Shift+A` is `agent-sessions.ts:333`.

**Contracts (`orq-4`).** `SessionSummary` has three PTY-only fields (`cols`, `rows`,
`activity.lastOutputAt`). There is no turn/message/tool/approval concept anywhere in
`packages/api`. `Broadcaster` fans every event to every `/events` sink with no channel filter, so
per-token deltas cannot ride the bus. `sessions.json` stores no conversation id. Two one-line
gates would silently exclude a new kind: the push gate (`index.ts:643`) and the Attention Center
filter (`agent-sessions.ts:78`).

## 3. T3 Code: what to borrow, what to skip

**Borrow (design, not code).**

- One adapter interface (`ProviderAdapterShape`: `startSession`, `sendTurn`, `interruptTurn`,
  `respondToRequest`, `respondToUserInput`, `stopSession`, `readThread`, `rollbackThread`,
  `streamEvents`) and one normalized event union (49 variants) so nothing above the adapter
  branches on provider (`t3-1` §1).
- Per-provider argv/env tables and the permission-mode matrix (`t3-1` §2, §6). Changing mode
  restarts the session; no provider needs a live mode-change RPC.
- The generated method catalogs for Codex app-server and ACP (`meta.gen.ts` in both packages)
  are pure data and directly liftable.
- The minimal model (`t3-2` §8.3): a per-thread append-only NDJSON log plus a `meta.json` fold,
  12 event types, 8 commands, one `ThreadItem` union (`message` | open-kinded `activity`),
  reasoning as a sibling message role, approvals and questions derived from activities, the
  provider's own session id as the resume cursor (never replay a transcript into the provider),
  server-side delta batching (~250 ms / 8 KB), shell-vs-detail split for the sidebar, full
  activity payload persisted while a slimmed one goes on the wire.
- Per-turn git checkpoints as hidden refs (`refs/orq/checkpoints/<thread>/turn/<n>` via
  `write-tree`/`commit-tree`/`update-ref` under an isolated index), with the two rules: ask the
  adapter whether it can roll back before touching the filesystem, refuse file restore in a
  shared checkout.
- UI patterns (`t3-3` §10): three-layer identity-preserving projections (React 18 has no
  compiler, so this matters more here), the single `WorkLogEntry` row shape with a presentation
  resolver instead of per-tool components, the collapsed activity group ("Read 3 files, ran 2
  commands"), approvals and questions as a docked banner above the composer with digit
  shortcuts, composer-as-overlay publishing its height, the queued-message ghost bubble,
  `interactive-widget=resizes-content` + `viewport-fit=cover` for mobile.
- Startup reconcile (`t3-4`): on boot either resume the interrupted turn from the provider
  session id or settle the thread as an error, never leave a lying spinner.
- Terminal-side extras worth stealing independently of this project: an output credit window
  (Orquester has no backpressure), and a scrollback sanitizer that strips DSR/DA/DECRQM/XTVERSION
  queries before storing, because replaying them makes the live shell answer into the prompt
  (our `capture-pane` path has the same hazard).

**Skip.** Effect 4 RC and its `unstable/*` namespaces (the whole server is written in it; the
protocol knowledge is not Effect-shaped), SQLite + 53 migrations + per-projector cursors,
pagination stack, ACK-aware byte budget, settle/snooze/pin, PR links, multi-environment/relay/
device pairing/DPoP, Tiptap composer (a textarea plus token overlay covers `@file` and `/slash`),
`@legendapp/list` until a profile demands it, the 10k-line `ChatView` decomposition, T3's
node-pty terminals (ours are strictly better: tmux survives restarts, theirs only restore
scrollback), and T3's cloud-only push (our VAPID Web Push is better for a self-hoster).

**T3 footguns to avoid.** Their `/mcp` is mounted outside the environment auth stack behind a
24 h token; checkpoint refs are never garbage-collected on thread delete; loopback-bind detection
misreads a reverse proxy.

## 4. Open decisions (need your call before design)

1. **Coexist or replace.** Recommend coexist: `kind: "agent-chat"` beside `"shell"` and the
   existing `"agent"` terminal mode. Terminals stay tmux. Users keep the TUI escape hatch.
2. **Restart survival for the protocol child.** Options: (a) accept death and resume from the
   conversation id on boot, exactly how browser tabs work today (recommended for v1);
   (b) run the child as an `orqsvc-` supervised service with boot adoption, the cliproxy pattern;
   (c) `codex app-server daemon` / `opencode serve` as long-lived shared servers. Wrapping stdio
   protocols in tmux is not an option, the pipe is the protocol.
3. **Login.** Claude and Codex accounts can only be created by an interactive login today
   (upload of a credential file the TUI produced). Only Grok has a daemon-driven device-code
   flow. Recommend keeping the terminal path for `claude /login` and `codex login` (an "open a
   login terminal" button on the chat session), not building OAuth for v1.
4. **Provider order.** Recommend Claude first (Agent SDK does the spawning and exposes
   `canUseTool` for approvals; every claudex/claudemix proxy env applies unchanged), then Codex
   app-server, then OpenCode HTTP, then Grok ACP. Each adapter is independent work.
5. **Streaming transport.** Two analysts disagree: a `/ws-agent` channel modelled on
   `/ws-browser` (`orq-3`, `orq-4`) versus per-thread NDJSON on the existing bus with a
   per-stream filter like `GitWatcher` (`t3-2`). Recommend the option that works on both
   transports without new plumbing: a chunked NDJSON `GET /api/sessions/:id/events?after=<seq>`
   mirroring the desktop's existing `GET /api/sessions/:id/output`, with mutations as plain POSTs
   (`turn`, `decision`, `interrupt`). Only the open tab subscribes, so connection count is not a
   concern. Promote to a WS channel later if a profile says so.
6. **Checkpoints and diff/revert in v1 or later.** Recommend later; the git tab already shows
   the working tree, and a `diff.produced` hint can refresh it.

## 5. Rough shape of the work (for sizing, not a plan)

1. Contracts: widen `SessionKind`/`RegistryKind`, add the agent-chat event/command types to
   `packages/api`, a tolerant `chat` block on `sessionRecordSchema` in `packages/config`.
2. Daemon: an `AgentChatManager` beside `SessionManager` implementing the same lifecycle seam
   (create/close/rename/reorder/persist/reattach), an adapter interface, the Claude adapter, a
   per-thread NDJSON log + `meta.json`, the `turns/turn/decision/interrupt` routes, protocol →
   `SessionActivity` mapping (drops `ansi-activity.ts` for this kind), widen the push gate.
3. UI: a sixth `ProjectTab` arm with a chat renderer (timeline, composer, docked approvals),
   an `agentChannel` on the transporter, widen the Attention Center filter, redirect browser-pick
   and upload to structured messages when the target is a chat session.
4. Then one adapter per remaining provider.

## 6. Incidental findings (bugs, unrelated to the GUI work)

- `PickComposeSheet` double-pads the safe-area inset although it is `absolute`, not `fixed`,
  contradicting the AGENTS.md rule (`orq-3`).
- The service worker carries `sessionId` in every push payload and ignores it; clicking a
  notification focuses any window rather than that session's tab (`orq-3`).
- The scrollback replay from `tmux capture-pane` can contain terminal query sequences that the
  live shell will answer into the prompt; T3 sanitizes these before storing (`t3-4`).
- The `/ws` output path has no backpressure (`t3-4`).
