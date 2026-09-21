# Slice 1 — Daemon session backends & process plumbing

Scope: `apps/daemon/src/sessions.ts`, `tmux.ts`, `cli.ts`, the session/WS/events/shutdown parts of
`index.ts`, plus `ansi-activity.ts`, `agent-status.ts`, `agent-hooks.ts`, `agent-accounts.ts`,
`mcp/text.ts`, `mcp/terminal-control.ts`, `url-watcher.ts`, `packages/api/src/index.ts`,
`packages/config/src/index.ts`, `packages/registry/src/index.ts`.

All paths relative to `/var/lib/orquester/workspaces/jaspersito/orquester`.

---

## 0. The shape of the thing in one paragraph

There is exactly **one** session abstraction. `ISessionManager`
(`apps/daemon/src/sessions.ts:72-103`) has two implementations — `SessionManager` (tmux-backed,
`sessions.ts:276`) and `LocalSessionManager` (direct node-pty, `sessions.ts:896`) — chosen once at
boot by `createSessionManager` (`sessions.ts:142-157`) on `tmuxAvailable() && tmuxVersionOk()`.
Both are **byte-stream** managers: their entire contract is *spawn a process on a pty, ring-buffer
its bytes, let clients subscribe to the byte stream, write bytes back, resize the grid*. There is
no notion of a message, a turn, a tool call, or a conversation anywhere in this layer. Agents are
modelled as "a registry entry whose `kind === "agent"`" and differ from a shell in exactly four
places inside the backends (env injection, hook install, resume args, account resolution) — every
other line is terminal-generic.

`SessionKind` is already `"shell" | "agent"` (`packages/api/src/index.ts:789`), but
`SessionSummary.kind` is typed as the wider `RegistryKind`
(`packages/api/src/index.ts:1163`) — so adding a `"gui-agent"`-ish third kind is a typed-union
change in `packages/api` + `packages/config`'s `sessionRecordSchema.kind` enum
(`packages/config/src/index.ts:594`) and nothing else structural.

---

## 1. Lifecycle of an agent session today

### 1.1 Create — route (`index.ts`)

`POST /api/sessions` (`apps/daemon/src/index.ts:3532`) does, in order:

1. **`initialCommand` validation** — `index.ts:3539-3552`: must be a string, ≤ `MAX_INITIAL_COMMAND`
   (4096, `packages/api/src/index.ts:1231`), and contain **no control bytes**
   (`/[\u0000-\u001f\u007f]/`). Reason in the comment at `index.ts:3534-3538`: the string is typed
   into a PTY, so an ESC could smuggle a terminal control sequence into a tab the user never saw.
2. **Model gate** — `resolveLaunchModel` (`index.ts:1083-1100`): a per-launch `model` is legal only
   for `claudex`/`claudemix`; anything else is a 400. For those two it is resolved against the live
   cliproxy catalog and the **concrete** catalog string is what launches.
3. **Resume gate** — `index.ts:3565-3573`: if `resumeConversationId` is set, `resumeLaunchArgs`
   must produce a non-empty argv, else 400 `RESUME_UNAVAILABLE` (never silently degrade to a fresh
   session).
4. **Seeded-account gate** — `index.ts:3583-3602`: a claudex/claudemix launch pinning a managed
   account must have that account seeded into the proxy, unless the model is a router/xAI model
   (`accountlessModel`, `index.ts:3588-3592`).
5. `sessions.create({...body, model: effectiveModel})` (`index.ts:3605`); `SessionError` → 400
   `SESSION_UNAVAILABLE` (`index.ts:3606-3609`).
6. `markRecentProject(summary.projectPath)` (`index.ts:3613`) — daemon-owned recents.
7. **Post-launch model pre-flight** — `index.ts:3621-3634`: advisory `missingModels[]` stamped onto
   the returned summary only (never persisted).

### 1.2 Create — tmux backend (`SessionManager.create`, `sessions.ts:291-433`)

1. Registry lookup + availability check (`sessions.ts:292-295`).
2. **Env resolution via the injected `resolveExtraEnv` seam** (`sessions.ts:306-320`), wired in
   `index.ts:394-417`. The seam is agent-only (`index.ts:396`: `if (entry.kind !== "agent") return null`).
   It calls `buildAgentLaunchEnv` (`index.ts:1064-1075`), which composes three contributors:
   - **managed account** — `agentAccounts.resolveLaunchEnv` (`apps/daemon/src/agent-accounts.ts:189-215`):
     `claude` → `{ CLAUDE_CONFIG_DIR: <home> }` + `unset: CLAUDE_AUTH_ENV_UNSET`;
     `grok` → `{ GROK_HOME: <home> }` + `unset: GROK_AUTH_ENV_UNSET`;
     `codex` → `{ CODEX_HOME: <home> }` + `unset: CODEX_AUTH_ENV_UNSET`. Returns the **effective**
     accountId (explicit pick → per-agent default; `SYSTEM_ACCOUNT_ID` = null).
   - **Claude timeout env** — `claudeTimeoutEnv` (`apps/daemon/src/agent-timeout-env.ts:27-37`):
     `API_TIMEOUT_MS` / `CLAUDE_STREAM_IDLE_TIMEOUT_MS` / `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`,
     keyed on `agentFamily()` (`agent-hooks.ts:16-31`) so claudex/claudemix get them too.
   - **cliproxy contributor** — `cliproxyContributor` (`index.ts:967-1048`): `CLAUDE_CONFIG_DIR`
     = the per-entry proxy home, `ANTHROPIC_AUTH_TOKEN` read from the 0600 token file
     (`index.ts:974-980` — deliberately off argv), `ANTHROPIC_MODEL` with the optional
     `acc<hex>/` routing prefix (`index.ts:1004`) and the `[1m]` context-window suffix hack
     (`index.ts:1014-1019`), plus the compaction env `CLAUDE_CODE_MAX_CONTEXT_TOKENS` /
     `CLAUDE_CODE_AUTO_COMPACT_WINDOW` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`index.ts:1032-1044`).
     Collision order is documented at `index.ts:1058-1062` (cliproxy wins; account supplies accountId).
3. Size defaults `80×24` (`sessions.ts:322-323`), cwd fallback chain `req.cwd || req.projectPath || homedir()`
   (`sessions.ts:324`), `id = randomUUID()` (`sessions.ts:325`).
4. **`order`** = max order in this project + 1 (`sessions.ts:328-330`) — the tab-strip sort key.
5. `SessionSummary` built (`sessions.ts:332-348`); `ActivityTracker` constructed with an `onChange`
   that emits `lifecycle "activity"` (`sessions.ts:350-358`).
6. **Agent-only env** (`sessions.ts:375-387`): `ORQUESTER_SESSION_ID = id`,
   `ORQUESTER_DAEMON_SOCK = <appdir>/daemon/daemon.sock`, then `await onAgentLaunch(...)` →
   `agentHooks.ensureForEntry` (`index.ts:416`) which writes the managed hook script + patches the
   agent's own config before the process starts.
7. **argv** — `buildLaunchCommand` (`sessions.ts:159-196`): shells get `-l` appended under tmux
   (`sessions.ts:166-171`); agents get `entry.args` then **resume args last** (`sessions.ts:175`,
   because codex's `resume <id>` is a subcommand); `launchViaShell` entries (opencode,
   `packages/registry/src/index.ts:151`) get wrapped in `/usr/bin/env SHELL=… <shell> -lc '"$@"' orquester-launch <bin> …`
   (`sessions.ts:177-193`).
8. **Resume args** — `resumeLaunchArgs` (`sessions.ts:208-218`) validates against
   `CONVERSATION_ID = /^[\w.][\w.\-/]*$/` (`sessions.ts:206`), rejects `..` segments, then
   `resumeArgsFor(entry.id, id)` (`packages/registry/src/index.ts:369-373`) substitutes `{id}` into
   the static catalog's `resumeArgs` (claude `--resume {id}`, codex `resume {id}`, grok `--resume {id}`,
   opencode/kimi `--session {id}`, agy `--conversation {id}`).
9. **Secret-safe env injection** — `writeAddonEnvLaunchScript` (`sessions.ts:225-267`): the addon
   (credential-bearing) env is written into a 0600 one-shot `/tmp/orquester-launch-*/launch.sh`
   that `rm`s itself then `exec`s the real command, instead of `tmux new-session -e` (which would be
   argv-visible). Cleanup is a 30 s unref'd timer (`sessions.ts:409-412`).
10. `tmux.newSession(...)` (`sessions.ts:403` → `tmux.ts:266-302`): `new-session -d -s orq-<id> -x cols -y rows -c cwd -e K=V… -- bin args`,
    with `PATH: sessionPath()` forced onto the **new-session client's** env (`tmux.ts:296-298`),
    because the pane inherits the client env, not the `-e` table (`tmux.ts:106-114`).
11. Re-check that the session wasn't closed during the await (`sessions.ts:414-417`), then
    `this.attach(session)` (`sessions.ts:418`).
12. **`initialCommand` is typed, not executed** (`sessions.ts:425-428` → `initialCommandKeys`,
    `sessions.ts:59-62`): `this.input(id, `${trimmed}\n`)`.
13. `lifecycle.emit("created", …)` + `persistIndex()` (`sessions.ts:430-431`).

### 1.3 Create — local backend (`LocalSessionManager.create`, `sessions.ts:906-1047`)

Same sequence, differences only: env is built by spreading `sessionEnvBase()` + `PATH: sessionPath()`
+ registry env + addon env directly (`sessions.ts:947-954`), `unset` keys are `delete`d from the env
object (`sessions.ts:956-957`) since there is no wrapper script, and `spawn(launch.bin, launch.args, …)`
is a **direct child of the daemon** (`sessions.ts:973-979`). No `persistIndex`.

### 1.4 Attach / stream

`SessionManager.attach` (`sessions.ts:439-502`) spawns a **second** PTY: `tmux -S <sock> attach -t orq-<id>`
(`sessions.ts:452`, argv from `tmux.ts:305-307`) with `sessionEnvBase()` (which strips `$TMUX`/`$TMUX_PANE`,
see §2). `pty.onData` (`sessions.ts:461-469`) does four things per chunk: append to a 256 KiB ring
(`MAX_BUFFER`, `sessions.ts:30`), feed `tracker.noteOutput(data)`, emit `"output"` on the per-session
emitter, and emit `lifecycle "output"` (consumed by `UrlWatcher`, `index.ts:700-703`).

Client-facing streams:
- **Chunked HTTP** `GET /api/sessions/:id/output` (`index.ts:3871-3908`) — scrollback first
  (`index.ts:3880`), then `reply.hijack()` + raw writes, with a post-await live-status re-read
  (`index.ts:3890-3900`) to avoid a hung pane.
- **Multiplexed WS** `/ws` (`index.ts:4072-4188`), protocol `{t:"sub"|"unsub"|"input"|"resize"|"ping"}`
  in, `{t:"out"|"end"|"pong"}` out. Notable: a synchronous placeholder slot reservation around the
  `await scrollback` (`index.ts:4118-4135`) and the same exited-during-await guard
  (`index.ts:4136-4147`).
- **`/events`** (`index.ts:3988-4054`) is NDJSON lifecycle broadcast + 15 s heartbeat; session
  events published at `index.ts:621-670`.

### 1.5 Input / resize / rename / reorder / upload

- `input` (`sessions.ts:594-602` / `1114-1122`): `tracker.noteInput(...)` then `pty.write(data)`,
  try/caught because the PTY can be freshly dead. Routes: `POST /api/sessions/:id/input`
  (`index.ts:3666-3672`) and `{t:"input"}` on `/ws` (`index.ts:4161-4162`).
- `resize` (`sessions.ts:604-625` / `1124-1136`): `pty.resize(cols, rows)` try/caught for ioctl
  ENOTTY (the comment at `sessions.ts:611-615` notes the raw `/ws` handler has no Fastify error net,
  so a throw would kill the daemon), then coalesced persist (`schedulePersist`, `sessions.ts:628-636`).
  Routes: `POST /api/sessions/:id/resize` (`index.ts:3858-3865`), `{t:"resize"}` (`index.ts:4163-4177`).
- `rename` (`sessions.ts:639-650`), `reorder` (`sessions.ts:653-666`) — pure tab metadata, persisted,
  broadcast as `session.updated`.
- **Upload-to-session** `POST /api/sessions/:id/upload` (`index.ts:3809-3856`): raw octet-stream body
  → `<appdir>/daemon/uploads/<sessionId>/<name>` (0700 dir / 0600 file), returns the absolute path.
  **The daemon does not inject it** — the client types the path into the PTY. Files are swept on
  exit/close (`index.ts:628-635`) and orphans on boot (`index.ts:617-620`).

### 1.6 Exit

`pty.onExit` (`sessions.ts:470-501`): first an identity check (`sessions.get(id) !== session`) so a
`close()`-induced death doesn't emit a ghost "exited" after "closed" (`sessions.ts:471-478`). Then —
tmux-only — `tmux.hasSession(id)` disambiguates *"the command exited"* from *"the daemon is dying and
the attach master hung up"* (`sessions.ts:482-487`): if the tmux session is still alive, just null the
pty and leave `status: "running"` so the next boot reattaches. Otherwise set `status/exitCode`, emit
`"exit"` + `lifecycle "exited"`, and **only then** `tracker.noteExit()` (`sessions.ts:494-498`) — the
ordering is load-bearing (the exited summary carries no activity, so a client resetting on exit must
see the attention stamp arrive last). Local backend: same minus the tmux probe (`sessions.ts:1019-1036`).

### 1.7 Reattach after a daemon restart

`SessionManager.reattach` (`sessions.ts:756-827`), called at `index.ts:609` (best-effort, never blocks boot):

1. `tmux.listSessions()` → live `orq-*` ids (`tmux.ts:370-381`).
2. `readIndex()` (`sessions.ts:843-863`) distinguishes *absent* (clean) from *unreadable/corrupt*
   (`loaded:false`).
3. `tmux.windowSizes()` (`tmux.ts:391-411`) read **before** attaching any client, as a size fallback.
4. `tmux.setWindowSizeLatest()` (`tmux.ts:457-459`).
5. `tmux.scrubGlobalSecrets()` (`tmux.ts:471-484`) — strips leftover `ORQUESTER_*` from the surviving
   tmux server's global env table.
6. Per record: in-index + alive → rebuild `SessionSummary` (restoring `accountId`, `model`, `cols/rows`,
   `order`, `createdAt` — `sessions.ts:775-800`), fresh `ActivityTracker` (**activity state is lost**),
   empty ring buffer, `attach()`.
7. Orphan reap only when `indexLoaded` (`sessions.ts:818-824`).

`LocalSessionManager.reattach` is a no-op (`sessions.ts:1228-1230`).

### 1.8 Shutdown

`cli.ts:11-26`: SIGINT/SIGTERM → `daemon.stop()` with a 3 s hard-exit backstop (`cli.ts:18`).
`stop()` (`index.ts:871-885`) calls `sessions.shutdown()` (`index.ts:879`), which for tmux
**kills only the attach PTYs and leaves the tmux sessions running** (`sessions.ts:726-735`), and for
local kills everything (`sessions.ts:1216-1218`). Then `browsers.shutdown()`, `stopHttp()`,
`unixServer.close()` + `closeAllConnections()` (`index.ts:880-884`).

---

## 2. Quirks that exist ONLY because agents live in a PTY

| # | Where | What | Why it exists |
|---|---|---|---|
| 1 | `sessions.ts:439-458` (`attach`) | A **second** PTY per session (`tmux attach`) on top of the pane's own pty | The daemon can only read a tmux pane by attaching a client to it. |
| 2 | `sessions.ts:451`, `tmux.ts:210-223` (`sessionEnvBase`), `tmux.ts:244-246` | Stripping `$TMUX`/`$TMUX_PANE` from every spawn | tmux's nesting guard refuses `attach` regardless of `-S`, so a daemon started inside a tmux pane would silently produce blank frozen tabs. |
| 3 | `tmux.ts:210-217` | Stripping `ORQUESTER_*` from child env | A pane inherits the new-session client's env — otherwise every terminal could read the web password. |
| 4 | `tmux.ts:471-484` (`scrubGlobalSecrets`) | Unsetting `ORQUESTER_*` from the tmux server's **global** env on reattach | A pre-fix daemon leaked secrets into a server that outlived it; new panes copy the global env. |
| 5 | `tmux.ts:100-128` (`sessionPath`) + `tmux.ts:296-298` | PATH must be set on the new-session **client**, not via `-e` | `-e` only fills tmux's env *table*; the pane never reads it for PATH. Pure tmux artifact. |
| 6 | `tmux.ts:151-171` (`sessionShell`) | Advertising a fake `$SHELL` when the service account's shell is `nologin` | TUIs (opencode) spawn subprocesses via `$SHELL` and die on nologin. |
| 7 | `sessions.ts:166-171` | Shell entries get `-l` under tmux | `tmux new-session -- bash` runs non-interactive and exits status 1. |
| 8 | `sessions.ts:177-193` + `registry:151` `launchViaShell` | OpenCode must be launched as a child of a real login shell | Locked service-user environment; a direct exec misbehaves. |
| 9 | `sessions.ts:225-267` (`writeAddonEnvLaunchScript`) | Self-deleting 0600 `/tmp` shell script to carry credential env | `tmux new-session -e K=V` puts secrets on the argv of a process visible in `ps`. |
| 10 | `tmux.ts:276-280`, `tmux.ts:513-515` | Dropping env values containing `\n` | `tmux new-session` rejects them and would fail the whole launch. |
| 11 | `sessions.ts:30` `MAX_BUFFER` + ring in `onData` | A 256 KiB in-memory byte ring per session | There is no other record of what the agent said; needed for hot replay before the first client connects. |
| 12 | `tmux.ts:316-348` (`capturePane`) | **Alt-screen replay framing**: probe `#{alternate_on}`, and if set prefix `\x1b[?1049h\x1b[H`, drop `-J` and `-S` | `capture-pane` records cells but not the DEC private mode; replaying verbatim drops a TUI capture into the client's *normal* buffer and every later redraw garbles. Pure consequence of "the agent is a full-screen TUI". |
| 13 | `index.ts:4165-4177` | **Resize resync dance**: after the first resize following a `sub`, wait 80 ms then re-capture and re-send scrollback | Sub-time scrollback was captured at the 80-col default before the client reported its real size, so an alt-screen grid arrived wrapped. |
| 14 | `sessions.ts:604-625`, `tmux.ts:457-459` | Resizing the *attach* PTY to drive tmux `window-size latest` to resize the pane | Three-hop resize chain that exists only because the grid has a size at all. |
| 15 | `sessions.ts:610-616`, `1129-1132` | try/catch around `pty.resize` for ioctl ENOTTY | A `/ws` frame arriving in the window between command exit and `onExit` would otherwise crash the daemon. |
| 16 | `packages/config:604-609`, `sessions.ts:617-623`, `793-796` | Persisting `cols`/`rows` and coalescing resize writes | So a reattached TUI doesn't repaint into an 80×24 corner. |
| 17 | `ansi-activity.ts:24-150` (`BellScanner`) | A full ANSI/CSI/OSC state machine to find BEL + OSC 0/2/9/777 | The *only* attention signal a non-hook agent (gemini, kimi, agy, deepcode) or a shell emits is a byte in the stream. |
| 18 | `ansi-activity.ts:182-186, 373-389` | "Title-driven" heuristic (2 title changes in 3 s ⇒ only title changes count as heartbeats) | A spinner repainting continuously otherwise reads as endless work. |
| 19 | `ansi-activity.ts:170, 253` `INPUT_ECHO_GRACE_MS` | Output within 1.5 s of a keystroke can't wake an idle session | Terminal echo is indistinguishable from the agent producing output. |
| 20 | `ansi-activity.ts:180, 255` `BELL_ECHO_GRACE_MS` | Bells within 250 ms of input are suppressed | readline's tab-completion beep is not an agent asking a question. |
| 21 | `ansi-activity.ts:284-304` (`noteInput`) | Typing clears attention and optimistically flips `waiting → working` | "Answering a prompt produces no hook event in any agent; the user's keystrokes are the answer." |
| 22 | `mcp/text.ts:48-65` (`stripFaint`) + `sessions.ts:550-560` | Capture **with** colors, drop SGR-2 faint text, then strip ANSI, to read a session | A greyed composer placeholder is otherwise indistinguishable from real typed input in a plain-text read. |
| 23 | `mcp/terminal-control.ts:13-18` `SUBMIT_ENTER_DELAY_MS` | Send Enter as a separate write 150 ms after the text | Claude Code treats a single chunk ending in CR as a *paste* and never submits. |
| 24 | `mcp/terminal-control.ts:20-26`, `sessions.ts:49`, `ansi-activity.ts:284-287` | `programmatic: true` flag on daemon-originated writes | Otherwise the MCP tool's own write opens the echo window and blinds it to the bell it is waiting for. |
| 25 | `index.ts:3534-3552`, `sessions.ts:51-62` | `initialCommand` typed as keystrokes with a no-control-byte rule | The only way to "run something at launch" when the interface is a keyboard. |
| 26 | `index.ts:3800-3856` | Upload-to-session writes a file and returns a **path string** for the client to type | There is no way to hand an agent a file over a PTY. |
| 27 | `index.ts:698-703` + `url-watcher.ts:14-29` | Scraping dev-server URLs out of raw PTY bytes with a regex after ANSI stripping | No structured channel exists to learn what the agent started. |
| 28 | `index.ts:3879-3900`, `4118-4147` | Two separate "did it exit while capture-pane was in flight?" guards | `capturePane` is a several-ms subprocess call racing the exit. |
| 29 | `sessions.ts:471-478`, `1024-1027` | Identity check in `onExit` to avoid a ghost "exited" after "closed" | A `kill()` looks exactly like a natural exit on a pty. |
| 30 | `sessions.ts:482-487` | `tmux.hasSession()` probe inside `onExit` | The attach PTY dying is ambiguous between "command exited" and "daemon shutting down". |
| 31 | `registry:60-62`, `197` `CLAUDE_CODE_NO_FLICKER=1` | Forcing Claude Code into diff rendering | Full-frame repaint flickers over a streamed PTY. |
| 32 | `tmux.ts:9-17`, `508-512` `orqsvc-` prefix | Service sessions must not start with `orq-` | Otherwise `reattach()`'s orphan reaper would kill the cliproxy process. |
| 33 | `tmux.ts:426-433` `panePids` pid > 1 guard | Pane pids are the only `/proc` roots reaching a tmux-backed command | The command is a child of the tmux **server**, not of the daemon. |
| 34 | `sessions.ts:328-330` `order` | Per-project integer tab order assigned by the daemon | Sessions are *tabs in a terminal strip*; survives as a concept but is a tab-strip notion, not a session notion. |
| 35 | `sessions.ts:409-412` | 30 s unref'd timer to `rm -rf` the launch wrapper dir | The script deletes itself on exec; the timer covers a launch that never execs. |

---

## 3. Agent-specific vs terminal-generic

### Stays *identical* for a plain shell (and would be **shared** by a GUI agent kind)

- Session registry/map, id assignment, `order` assignment, `title`/`rename`, `reorder`, `list`, `get`
  (`sessions.ts:504-522, 639-666`).
- `close` / `closeByProjectPrefix` / `closeAll` (`sessions.ts:669-701`) — `closeByProjectPrefix` is
  called from project/workspace deletion (`index.ts:2214, 2254, 3003-3004`).
- `subscribe`/`emitter` fan-out shape (`sessions.ts:704-719`) — the *envelope* generalizes; the payload
  (`string`) does not.
- `lifecycle` events `created/exited/updated/closed/activity/output` and their `index.ts:621-670`
  broadcasting, including push policy.
- `persistIndex` / `readIndex` / atomic tmp+rename (`sessions.ts:843-883`) and the reattach
  reconciliation *policy* (index + liveness, refuse-to-reap-on-corrupt).
- `liveAccountIds()` (`sessions.ts:516-522`) — consumed by the idle-account refresher (`index.ts:611`).
- Upload-to-session store + sweep (`index.ts:3809-3856, 617-620, 628-635`).
- `/events` bus, heartbeat, git-watcher subscription — untouched.

### Agent-only inside the backends today (exactly four sites)

1. `resolveExtraEnv` seam — gated `entry.kind !== "agent"` at `index.ts:396`; the whole
   account/cliproxy/timeout env pipeline hangs off it.
2. `ORQUESTER_SESSION_ID` / `ORQUESTER_DAEMON_SOCK` injection + `onAgentLaunch` hook install —
   `sessions.ts:375-387` and `sessions.ts:959-971`, both guarded by `entry.kind === "agent"`.
3. `resumeLaunchArgs` (`sessions.ts:208-218`) — `buildLaunchCommand`'s shell branch returns before it
   (`sessions.ts:166-171`), so resume is agent-only by construction.
4. `agentEvent()` (`sessions.ts:571-582`, `1091-1102`) — hook ingestion; a shell never calls it.
   Push policy is also agent-gated (`index.ts:655-657`).

### What a non-PTY "GUI session" kind would need as a sibling implementation

- **A new backend class** implementing a *widened* `ISessionManager`. Everything PTY-shaped in the
  interface would need a sibling or a no-op: `scrollback(): Promise<string>` →
  `messages(): Promise<Turn[]>`; `buffer(id): string` (sync, `sessions.ts:83`) has no meaning;
  `captureText` (`sessions.ts:81`) becomes a transcript render; `resize(cols, rows)` becomes a no-op;
  `input(data: string)` becomes `send(prompt, attachments)`; `subscribe(onOutput: (string)=>void)`
  becomes a typed event subscription.
- **`buildLaunchCommand` / `writeAddonEnvLaunchScript` / `Tmux` wholesale** — none apply. But the
  **env construction** (`buildAgentLaunchEnv`, `agent-accounts.resolveLaunchEnv`,
  `cliproxyContributor`, `claudeTimeoutEnv`) is *fully reusable*: it produces a
  `{ env, unset, accountId }` record that an SDK child process or an HTTP client can consume
  unchanged. That is the single biggest piece of agent-specific value that survives the move.
- **`ActivityTracker` becomes unnecessary** for hook-covered agents and is replaced by protocol state
  (§4).
- `tmux.ts` stays entirely as-is for shells; only `panePids`/`serverPid` (system-status) and the
  `orqsvc-` namespace are consumed elsewhere.
- **Both backends would need the sibling**, or a GUI agent would silently fall back to a PTY on a
  no-tmux host — note `createSessionManager` (`sessions.ts:142-157`) picks *one* manager for the whole
  daemon, so a third kind means either a composite manager (route by `kind`) or a per-kind registry.

---

## 4. How activity / attention is derived today

Two sources, merged in `ActivityTracker` (`ansi-activity.ts:223-425`), with a documented precedence:
**structural hook events outrank byte-stream heuristics** (`ansi-activity.ts:204-222`).

**Heuristic path (byte stream).** `noteOutput` (`ansi-activity.ts:244-276`) per chunk:
`BellScanner.feed` counts BEL / OSC 9 / OSC 777 and extracts OSC 0/2 titles; a "heartbeat" is
`!echo && (titleChanged || !isTitleDriven)`; `idle → working` on a heartbeat; the idle timer is
armed only for `working` (never for `waiting` — `ansi-activity.ts:262-267`); `idle` after
`IDLE_MS` 3000 ms, or `TITLE_DRIVEN_IDLE_MS` 4500 ms when title-driven
(`ansi-activity.ts:155-163, 399-409`). A bell sets `attention: "bell"` only when no attention is
already set (`ansi-activity.ts:267-270`).

**Structural path (hooks).** `POST /api/sessions/:id/agent-event` (`index.ts:3781-3797`), **unix-socket
only** (`index.ts:3775`), body `{source, event, payload}` (`packages/api/src/index.ts:976-980`).
Delivery is the managed shell hook script `agent-hook.sh` (`agent-hooks.ts:85-103`) which curls the
daemon socket using `$ORQUESTER_SESSION_ID`/`$ORQUESTER_DAEMON_SOCK` and always exits 0.
`classifyAgentEvent` (`agent-status.ts:9-24`) maps per-CLI events to
`"working" | "waiting" | "done"`: Claude (`agent-status.ts:42-58`, incl. the `AskUserQuestion`
special case and the regex over `Notification.message` at `agent-status.ts:37-40`), Codex
(`:60-74`), Grok (`:81-94`, with the double-`Stop` `reason === "end_turn"` discrimination), OpenCode
(`:96-108`). `applyHookEvent` (`ansi-activity.ts:316-335`) sets state + attention
(`working`→clear, `waiting`→`needs-input`, `done`→`finished`). `noteHookSource()`
(`ansi-activity.ts:312-314`) latches hook coverage so bells stop pushing for that session.

**Exit** also raises `finished` attention (`ansi-activity.ts:345-353`), deliberately without a push.

**Publication.** `lifecycle "activity"` → `session.activity` event to all clients + push policy
(`index.ts:642-670`): structural `needs-input`/`finished` push per type, bells push only for agent
sessions with `hasHookSource === false`, debounced 30 s per session per type (`push.ts:16, 171-200`).
`SessionSummary.activity` is attached only for running sessions (`sessions.ts:588-592`).

**Where a structured protocol replaces heuristics.** Everything in `ansi-activity.ts` except
`noteExit` becomes dead for a protocol-driven agent:

- `BellScanner` (all 150 lines) — replaced by an explicit "needs approval" / "turn finished" message.
- `INPUT_ECHO_GRACE_MS`, `BELL_ECHO_GRACE_MS`, title-streak/title-driven, the idle timer — all are
  proxies for "is the agent still producing a turn", which a protocol states directly.
- `noteInput`'s optimistic `waiting → working` (`ansi-activity.ts:296-301`) — replaced by the actual
  turn-start message.
- `agent-hooks.ts` entirely (hook script install, config patching, `agentFamily` targeting,
  `INSTALL_LAUNCH_TIMEOUT_MS`) — the protocol *is* the event channel, so the unix-socket-only
  `agent-event` route and its `classifyAgentEvent` translation table disappear.
- What **stays**: the `SessionActivity` shape (`state`/`attention`/`lastOutputAt`/`needsAttentionAt`),
  its event, the Attention Center ordering by `needsAttentionAt`, and the push policy — a protocol
  would feed the same three states with certainty instead of guessing. Note the already-present
  `hasHookSource` flag (`sessions.ts:355`, `index.ts:648, 666`) is exactly the "trust the protocol,
  ignore the bytes" switch, so the merge point is already designed.

---

## 5. Persistence

**`<appdir>/daemon/sessions.json`** — schema `sessionRecordSchema`
(`packages/config/src/index.ts:588-619`), written atomically (tmp + rename) by `persistIndex`
(`sessions.ts:871-883`), only for `status === "running"` sessions (`sessions.ts:872-874`):

`id`, `title`, `order`, `projectPath`, `refId`, `kind`, `cwd`, `createdAt`, and optional
`accountId`, `cols`, `rows`, `model`. `recordOf` at `sessions.ts:830-834`.

**What survives a daemon restart (tmux backend only):**
- The **process itself** (it lives in the tmux server's tree; systemd `KillMode=process`).
- The scrollback (durable in tmux, read back via `capture-pane`, `sessions.ts:529-541`).
- The tab metadata above: title, order, project, cwd, account pin, model pin, size.

**What does NOT survive:**
- `status`/`exitCode` (only running rows are written) — a session that exited while the daemon was
  down is simply forgotten (`sessions.ts:772-774`).
- `activity` — a fresh `ActivityTracker` is constructed on reattach (`sessions.ts:801-809`), so
  state/attention/`needsAttentionAt`/`lastOutputAt` are all lost. An agent parked on a permission
  prompt comes back looking idle.
- `hasHookSource`.
- The in-memory ring `buffer` (`sessions.ts:810` — starts `""`).
- `missingModels` (explicitly a launch snapshot, `packages/api/src/index.ts:1185-1192`).
- **The conversation id.** `resumeConversationId` is a create-time argv input only
  (`sessions.ts:399`) — it is never stored on the summary nor in `sessions.json`. The daemon has no
  idea which conversation a running agent is in; that is reconstructed by scanning the agents' own
  on-disk transcripts in `agent-conversations.ts`.

**What a non-PTY agent session would need to persist instead.** Since the process would (probably) be
a daemon child or an HTTP session rather than a tmux resident, *everything* that tmux implicitly holds
becomes the daemon's job:

- `conversationId` / provider session id (today: unpersisted and unknowable).
- Provider + endpoint + model actually in use (`model` already exists but only for claudex/claudemix).
- `accountId` / HOME identity (already persisted).
- The **transcript** — today's durable scrollback comes free from `capture-pane`; with no tmux there is
  no equivalent, so either the agent's own transcript file is the source of truth (and the daemon
  records the path/home so `agent-conversations.ts`-style resolution works) or the daemon stores turns.
  Note the existing rule that *a conversation only exists inside the HOME that wrote it* (AGENTS.md)
  means the `home`/`accountId`/`proxyRefId` triple must be persisted per session.
- Pending approval / in-flight turn state, so a restart can re-present the permission prompt rather
  than losing it (today `waiting` is lost on restart, which is tolerable only because the TUI redraws it).
- `cwd`, `projectPath`, `order`, `title`, `createdAt` — unchanged.
- `cols`/`rows` become dead fields.

Related: browser tabs already model the "process does not survive, record does" case
(`packages/config/src/index.ts:624-643`) and relaunch on first subscribe — that is the closest
existing precedent for a non-tmux session kind.

---

## 6. `SessionSummary` / session kinds in `packages/api`

`packages/api/src/index.ts:1161-1195`:

| Field | Line | PTY-only? |
|---|---|---|
| `id: string` | 1162 | no |
| `kind: RegistryKind` | 1163 | no (but `SessionKind` = `"shell" \| "agent"`, `:789`) |
| `refId: string` | 1165 | no |
| `accountId?: string` | 1167 | no |
| `title: string` | 1168 | no |
| `projectPath: string` | 1170 | no |
| `cwd: string` | 1171 | no |
| `cols: number` | 1172 | **yes** — terminal grid width |
| `rows: number` | 1173 | **yes** — terminal grid height |
| `status: "running" \| "exited"` | 1174 (`:942`) | partly — "exited" is a process notion; a GUI agent session has more states (connecting/erroring) |
| `exitCode?: number` | 1175 | **yes** — process exit code |
| `order: number` | 1177 | no (tab-strip sort key) |
| `createdAt: string` | 1178 | no |
| `model?: string` | 1184 | no (currently claudex/claudemix only) |
| `missingModels?: string[]` | 1192 | no (launch-time advisory) |
| `activity?: SessionActivity` | 1194 | mixed — the *shape* survives; `lastOutputAt` (`:957`, "ISO timestamp of the last PTY output") is PTY-worded |

`SessionActivity` (`:953-964`): `state` (`working|waiting|idle`, `:945`), `attention`
(`bell|needs-input|finished`, `:951` — **`"bell"` is PTY-only**), `lastOutputAt`, `needsAttentionAt`.

`CreateSessionRequest` (`:1197-1228`): `kind`, `refId`, `projectPath?`, `cwd?`, **`cols?`/`rows?`
(PTY-only)**, `title?`, `accountId?`, `model?`, `resumeConversationId?`, **`initialCommand?`
(PTY-only by definition — "a first line to TYPE into the fresh PTY", `:1218-1227`)**.

Other PTY-only wire types: `SessionInputRequest {data: string}` (`:1245`),
`SessionResizeRequest {cols, rows}` (`:1249`), `SessionStreamMessage`
(`{type:"buffer"|"output"; data: string} | {type:"exit"; exitCode}`, `:1276-1279`),
`SessionInputMessage` (`:1282-1284`), and the `/ws` frames in `index.ts:4094-4178`.
`SessionUploadRequest/Response` (`:1259-1273`) is kind-agnostic but its *use* (returning a path for
the client to type) is PTY-shaped.

`AgentEventRequest`/`AgentEventSource` (`:973-980`) are the hook-protocol types that a native
protocol would supersede.

---

## 7. Bottom line for the GUI-agent evaluation

- The PTY assumption is **narrow but deep**: only ~4 call sites in `sessions.ts` are agent-aware, but
  the *entire* `ISessionManager` contract, the `/ws` protocol, `SessionStreamMessage`, scrollback,
  resize and `ActivityTracker` are byte-stream shaped.
- The most valuable reusable asset is the **launch-env pipeline** (`buildAgentLaunchEnv` +
  `agent-accounts.resolveLaunchEnv` + `cliproxyContributor` + `claudeTimeoutEnv`), which is already a
  pure function producing `{env, unset, accountId}` — it works just as well for an SDK subprocess.
- The most disposable assets are `ansi-activity.ts` (425 lines of heuristics), `agent-hooks.ts`
  (679 lines of hook installation), `agent-status.ts` (the event translation table), the alt-screen
  capture framing and resize resync, and `mcp/text.ts`'s faint-stripping — all of which exist purely
  because the only channel is a terminal.
- The one thing tmux gives for free that a non-PTY design must build: **restart survival + durable
  transcript**. `sessions.json` today stores no conversation id at all, so nothing in the current
  persistence layer can be reused to resume a protocol session.
