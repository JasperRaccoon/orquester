# T3 Code vs Orquester: gap analysis (2026-10-22)

T3 Code was pulled from `e8d87689` to `ed9b7ca9`: 652 commits, the "out of alpha" stable release.
Nine domain reports in this folder back every item below with file paths on both sides:

| # | Report |
|---|---|
| 01 | [Chat GUI, timeline, composer](01-chat-gui-composer.md) |
| 02 | [Providers and adapters](02-providers.md) |
| 03 | [Orchestration and threads](03-orchestration-threads.md) |
| 04 | [Remote access and connectivity](04-remote-connect.md) |
| 05 | [Mobile](05-mobile.md) |
| 06 | [Source control, diffs, PRs](06-source-control.md) |
| 07 | [Terminal, keybindings, performance](07-terminal-keys-perf.md) |
| 08 | [CLI, ops, automation](08-cli-ops-automation.md) |
| 09 | [Desktop, settings, onboarding](09-desktop-settings-onboarding.md) |

T3 is MIT licensed. Copying code needs attribution, and we have no licences screen yet (see 09).

## Tier 0: our own bugs found during the comparison

Spot-checked in source by the coordinator: the auth token, the push tap, the turn diff, and the window frame.

| Issue | Where | Effort |
|---|---|---|
| The remote bearer is `base64(user:bcryptHash)`, so the stored hash in `daemon.json` or client localStorage is a permanent login. It can't be revoked per device, and the external `/mcp` gets the same full-trust token. | `apps/daemon/src/index.ts:5800`, `packages/ui/src/lib/auth.ts:34` | M |
| Tapping a session push doesn't open the session: the service worker only reads `workflowId`. | `apps/web/public/sw.js:272` | S |
| The turn diff feeds a multi-file patch to a single-file parser, which drops the file names. One binary file blanks the whole turn, and whitespace changes are always hidden. | `packages/ui/src/components/git/git-diff.ts`, `TurnDiffModal.tsx` | S |
| The terminal `/ws` has no backpressure, so a slow client grows the queue without limit. Each PTY chunk recopies 256 KiB, and resize resync uses `setTimeout(80)`. | `apps/daemon/src/index.ts:4863`, `sessions.ts:522` | S |
| The desktop window is always frameless; turning off "Custom titlebar" leaves Windows and Linux with no window controls. | `apps/desktop/src/main.ts:713` | S |
| Codex 429 retry exhaustion is classed as a transport error, so usage-limit failover never fires. | see 02 | S |
| Git-trigger workflows pass PR titles and bodies into agent prompts raw, which allows prompt injection. | `apps/daemon/src/workflows/agent/prompt.ts` | S |
| The daemon log never rotates (opened once at boot), and failed deploys aren't auto-reverted. | `apps/daemon/src/index.ts:518`, `deploy/` | S–M |

## Tier 1: quick wins to copy (small effort, high value)

1. **Typing during a pending approval:** sending declines the approval and redirects the agent (new in T3). See 01.
2. **More LaTeX delimiters:** `\(…\)`, `\[…\]` and ```` ```math ````, plus lazy KaTeX and copy-as-TeX. Codex/GPT math currently shows as raw TeX. See 01.
3. **Show why Claude asked for approval**, including in full access (new). See 01 and 02.
4. **Change-kind classifier:** split PR and turn line counts into code / tests / docs / generated. It's one pure 76-line file, `packages/shared/src/changedFileKind.ts` (new). See 06.
5. **Idle Claude compaction:** send `/compact` 2 min before the prompt cache expires, only when the thread is idle and over 200k tokens. Persist the timers so they beat T3's in-memory ones (new). See 02 and 03.
6. **Desktop OS notifications and a dock badge**, plus the Electron basics: app menu, context menu with copy/paste and spellcheck, window size memory, single-instance lock. See 09.
7. **Clickable URLs and file paths in the terminal**, plus explicit tmux `history-limit`. See 07.
8. **Handoff budget sized to the target model's context window**, always keeping the original request. Ours is a fixed 64 KB. See 03.
9. **Mobile polish:** Android Back closes overlays, iOS long-press menus (we already have both hooks), a terminal key bar with latching Ctrl, photos downscaled before upload. See 05.
10. **Connection diagnosis with "Copy diagnostics"**, and jittered reconnect backoff. See 04.
11. **Tailscale HTTPS toggle** in Remote access. See 04.
12. **Skill discovery from installed Claude plugins**, and ArrowUp prompt recall in the composer. See 01 and 02.

## Tier 2: bigger bets (medium or large effort)

- **Inbound webhook workflow trigger** with T3's filters (16 tests over body, headers and query), replay dedupe (7 days), coalescing windows and prompt-safe payload tagging. See 08.
- **Device pairing:** QR codes or one-time links, revocable per-device sessions, scoped external MCP access (read-only / supervised / full). This also fixes the Tier 0 auth item. See 04 and 03.
- **Local `orq` CLI over the Unix socket:** `thread start/send --wait/show/list` and `orq doctor`. See 08 and 03.
- **Git as a PR review tool:** per-thread worktrees; commit, push and PR in one action with AI-written text; base-branch diffs; diff line comments sent to the composer; a better diff renderer (split view, highlighting in workers, lazy files); a PR watch that wakes the agent. See 06.
- **Generic ACP adapter:** first a "local ACP command", later the ACP Registry. This brings Cursor, Gemini/Antigravity, Copilot, DeepSeek and Droid at once. Also reduce the provider literals spread through the code (`"grok"` appears in 68 files). See 02.
- **Composer and timeline:** inline context chips, find in thread, timeline minimap, `@` thread mentions, Markdown in user messages, ANSI colour in command output. See 01.
- **Performance guards:**
  - Split the 2,199-line `ChatComposer` so a keystroke doesn't re-render everything.
  - Lazy-load pdfjs, CodeMirror, xyflow and xterm.
  - Add perf regression tests and payload budgets.
  - Add "quiet" thread state so streaming re-renders only one sidebar row.

  See 07 and 01.
- **Keybindings:** a rebindable registry with a recorder and conflict warnings, plus a command palette actions mode. See 07.
- **Desktop platform:** Electron 33 → 44, auto-update with stable and nightly channels, a version-skew warning, and a welcome wizard that checks installs and sign-ins and imports projects from Claude/Codex history. See 09.
- **Agent coordination:** a server-side message queue shared across devices, switching provider inside one thread, and file restore on rewind (a product decision). See 03.
- **Bring-your-own-machine box provider:** this gives T3's new "Run on" through our existing "Runs on" flow. See 04.

## Where we are ahead (don't regress these)

- **Agent-host survival:** turns and terminals survive daemon restarts and deploys (agent-host handover plus tmux).
- **Workflow engine:** a full graph with code, shell and HTTP blocks, failover across accounts and agents, cron with time zones, and MCP authoring. T3 only has scheduled or webhook prompts.
- **Usage-limit recovery:** it switches accounts and persists across restarts. Claude, Codex and Grok sign-in all happen in the app.
- **Boxes:** ephemeral VMs across 21 providers, the Secret-files vault, devcontainer support.
- **Ours only:** Agent Profiles, the agent-config editor, plugins, workspaces with git identities, Linux desktop tabs, the server-side browser with DevTools.
- **Approvals and delegation:** approval safety guards, the subagent roster, the rewind picker, blocked-child notifications to the parent, and merge-back that delivers full results.
- **Self-hosted push and one UI:** push is sent by the daemon with no relay or account, and the shared UI means phones get every feature on day one. T3's web app has no service worker or push.
- **Self-hosted ops:** no telemetry, multi-host deploys with a browser smoke test, a full-text search index, and git hardening against hooks and fsmonitor.
