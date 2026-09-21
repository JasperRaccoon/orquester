# T3 Code — Terminals, MCP, Remote/Auth, Lifecycle, Usage, Notifications, Source Control, Preview, Native

Research report for the Orquester team. Slice: *everything a GUI-agent product needs besides
providers, contracts/persistence, and the web UI*.

All paths are relative to the T3 Code checkout at
`/var/lib/orquester/tmp/claude-999/-var-lib-orquester-workspaces-jaspersito-orquester/1ea82399-6588-4318-8820-ff116327f08f/scratchpad/t3code`.

---

## 0. Executive summary — what is required vs. optional

| Area | Verdict for a core chat-style GUI-agent mode | Why |
|---|---|---|
| Terminals beside agents | **Required-ish** (T3 ships them, and they are cheap) | Raw node-pty + a text ring buffer; ~3 300 lines total. Orquester already has a *better* backend (tmux). |
| Server-side VT emulation | **Not done at all.** T3 streams raw PTY bytes; emulation is client-side (libghostty-vt WASM) | No lesson to adopt here — Orquester's xterm.js model is the same shape |
| MCP server | **Optional.** It carries *zero* chat primitives | Only `preview_*`, `device_*`, `*_pull_request` tools. Questions/permissions come from the provider protocols, **not** MCP |
| Remote/auth (pairing, scopes, DPoP) | **Partially required**: per-RPC scopes are the one idea worth stealing | T3 has no password auth at all. Pairing tokens + scoped sessions |
| T3 Connect relay / Tailscale / SSH | **Optional** — pure reachability plumbing | Orquester already solves this with Caddy + a public domain |
| Server lifecycle + reconcile | **Required** | A restart kills every provider process and every PTY. Reconcile is what stops the UI lying |
| Usage/quotas | Optional polish (see §6) | |
| Notifications / needs-attention | **Attention state: required. Push delivery: optional** (see §7) | |
| Source control / checkpoints / worktrees | **Checkpoints: required-ish for a *GUI* agent** (see §8) | Diff-per-turn and revert are the GUI's main advantage over a terminal |
| Preview (dev-server detection + browser automation) | **Optional**, and the automation half is architecturally incompatible with a headless VPS | |
| Native helpers | **All optional**; none needed for chat | |

---

## 1. Terminal runtime

### 1.1 Shape

The server owns PTYs; every client (including the Electron renderer) attaches over the same
environment WebSocket connection — `docs/internals/terminal-runtime.md:3-6`.

Two backends? No — **one**: `node-pty` behind a thin service interface.

- `apps/server/src/terminal/PtyAdapter.ts:37-53` — the `PtyProcess` contract
  (`write/resize/kill/onData/onExit`), deliberately implementation-agnostic.
- `apps/server/src/terminal/NodePtyAdapter.ts:25-36` — the only implementation. Loads `node-pty`
  through `createRequire` because "inside a Node single-executable, `import()` cannot load files
  from disk".
- `apps/server/src/terminal/NodePtyAdapter.ts:41-80` — **re-adds the exec bit to node-pty's
  `spawn-helper`** at runtime, resolving `build/Release`, `build/Debug`, then
  `prebuilds/<platform>-<arch>`. This is exactly Orquester's `scripts/fix-node-pty-perms.mjs`
  problem; T3 solved it *in the server* rather than in a postinstall, which survives a
  re-extracted release archive.
- `apps/server/package.json:33` — `"node-pty": "^1.1.0"`. **There is no tmux, no screen, no
  detached supervisor anywhere in the repo.**

`apps/server/src/terminal/Manager.ts` (2 900 lines) is everything else: session map, history,
persistence, subprocess polling, kill escalation.

### 1.2 Identity: terminals belong to THREADS, not projects

`packages/contracts/src/terminal.ts:34-38`:

```ts
/** Terminal ids are ALWAYS chosen by the client and sent explicitly — no server-side allocation. */
const TerminalSessionInput = Schema.Struct({ ...TerminalThreadInput.fields, terminalId: TerminalIdSchema });
```

Every terminal is keyed `(threadId, terminalId)`; the default id is `term-1`
(`packages/contracts/src/terminal.ts:10`). Terminals are a **tab inside a chat thread**, sharing
the thread's cwd/worktree (`worktreePath` is a field on every open/attach/restart input,
`terminal.ts:42,55,82`). That is the structural difference from Orquester, where a terminal *is*
the unit of work. If you build chat threads, decide early whether a terminal hangs off a thread
(T3) or stays a peer tab (Orquester today) — T3's choice is what lets "open a terminal in this
agent's worktree" be a one-click action.

Client-chosen ids are also why reconnect is trivial: the client re-attaches by the id it already
knows, with no server-side allocation table to reconcile.

### 1.3 Wire protocol

Seven RPCs plus two subscriptions, all on the single `/ws` Effect-RPC channel
(`packages/contracts/src/rpc.ts:330-336`, definitions at `rpc.ts:1101-1138`):

| Method | Payload | Result |
|---|---|---|
| `terminal.open` | `{threadId, terminalId, cwd, worktreePath?, cols?, rows?, env?, providerInstanceId?}` | `TerminalSessionSnapshot` |
| `terminal.attach` | same + `restartIfNotRunning?` | **stream** of `TerminalAttachStreamEvent` |
| `terminal.write` | `{…, data}` — non-empty, **max 65 536 chars** | void |
| `terminal.resize` | `{…, cols, rows}` | void |
| `terminal.clear` / `terminal.restart` / `terminal.close` | — | void / snapshot / void |

The attach stream starts with `{type:"snapshot", snapshot}` carrying the full retained history as
one string, then emits `output` / `exited` / `closed` / `error` / `cleared` / `restarted` /
`activity` (`packages/contracts/src/terminal.ts:222-236`). Compare Orquester's
`{t:"out"|"end"}` — same idea, but T3's event union also carries **`activity`**:

```ts
const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  label: Schema.String.check(Schema.isMaxLength(128)),
});
```
(`packages/contracts/src/terminal.ts:203-208`)

`label` is a **server-computed tab title**: the manager polls `ps -o pid,ppid,comm` (or the Rust
resource monitor's process table) for the PTY's first child and names the tab after it, so the tab
says `pnpm` instead of `zsh` — `deriveSubprocessInspectResult` at `Manager.ts:690-714`,
`parsePosixProcessTable` at `Manager.ts:655-671`. Polling starts at 1 s and backs off
exponentially to 60 s on failure (`Manager.ts:648-653`, constants at `Manager.ts:97-99`).
`ps` is resolved to an absolute path once at startup (`Manager.ts:718`) rather than spawned by
bare name. **This is a cheap, high-value steal for Orquester's tab labels and for
"is this terminal busy" in the Attention Center.**

A second subscription, `subscribeTerminalMetadata`, streams `snapshot`/`upsert`/`remove` of
lightweight `TerminalSummary` rows (`terminal.ts:117-153`) so a sidebar can list every terminal
without attaching to any of them. Orquester's `session.updated` event bus already covers this.

### 1.4 Backpressure — the part worth copying verbatim

`apps/server/src/terminal/OutputProtocol.ts:71-132` wraps the RPC protocol with a per-request
**credit window**: at most 8 pending chunks or 64 KiB in flight per attach stream. When the window
is full the server stops auto-acking and waits for the client's real `Ack`; when it has room it
self-acks immediately so the fast path costs nothing.

```ts
const MAX_PENDING_CHUNKS = 8;
const MAX_PENDING_BYTES = 64 * 1024;
```

Orquester's `/ws` has no equivalent: a `yes` in a tab on a slow mobile link buffers unboundedly in
the daemon. This is ~60 lines and directly portable to `WsSessionChannel`.

### 1.5 Retention and the sanitizer

- Caps: **5 000 lines and 8 MiB** per terminal (`Manager.ts:93-94`), enforced by
  `BoundedTerminalHistory` (`Manager.ts:820-900`) — a chunked ring buffer (16 KiB chunks,
  `Manager.ts:95`) that tracks byte length and line breaks incrementally and never materializes the
  full string on append. It even handles a **surrogate pair split across two PTY chunks**
  (`Manager.ts:847-861`), because joining it changes the UTF-8 size from 3 to 4 bytes.
- Client buffers cap separately at **512 KiB**
  (`packages/client-runtime/src/state/terminalOutput.ts:45`).
- User-facing doc: `docs/user/terminal.md:3-8`.

The sanitizer is the subtle bit. Retained history is **not** the raw PTY stream: T3 strips
query/response control traffic before storing, because replaying a stored DSR/DA/XTVERSION query
makes the *live* shell answer and the answer lands as junk at the prompt
(`Manager.ts:1031-1032`). `shouldStripCsiSequence` (`Manager.ts:1002-1028`) drops:

- `CSI … n` (DSR) and `CSI … R` (cursor-position report)
- `CSI … c` (DA) including `>`-prefixed secondary DA
- `CSI … $p` / `$y` (DECRQM/DECRPM) — the `$` guard keeps DECSTR (`!p`) and DECSCL (`"p`) intact
- `CSI > … q` (XTVERSION) but **not** space-intermediate `q` (DECSCUSR cursor shape)
- `CSI ? … u` (Kitty keyboard protocol) but not bare `u` (restore cursor)

plus DCS `$q`/`+q` (DECRQSS/XTGETTCAP) at `Manager.ts:1031-1035` and OSC 10/11/12 colour queries at
`Manager.ts:1036-1038`. A partial escape sequence straddling two chunks is carried in
`session.pendingHistoryControlSequence` (`Manager.ts:2016-2022`).

The client does the other half: during replay it **detaches the terminal's PTY writer** so any
reply the emulator does generate goes nowhere — `apps/web/src/terminal/ghostty/core.ts:332-345`,
documented at `docs/internals/terminal-runtime.md:40-45`.

> **Lesson for Orquester.** Our tmux `capture-pane` scrollback has the same hazard: a replayed
> device query can provoke a live reply into the pane. Worth auditing.

### 1.6 Persistence — and the tmux comparison

History is written to a plain file per terminal, `<logsDir>/<safeThreadId>[_<safeTerminalId>].log`
(`Manager.ts:1542-1548`), via a **keyed coalescing worker** with a 40 ms debounce
(`Manager.ts:1688-1723`, `DEFAULT_PERSIST_DEBOUNCE_MS` at `Manager.ts:96`). Clear/restart/close
force an immediate write and drain it (`persistHistory`/`flushPersist`, `Manager.ts:1727-1750`).

Restore reads only the **bounded tail**: seek to `size - 8 MiB`, skip the incomplete UTF-8 prefix,
apply the line cap (`readHistoryTail`, `Manager.ts:1752-1775`; `readHistory` at
`Manager.ts:1776-1850`, including a one-time migration from a legacy per-thread filename).

**Does a terminal survive a server restart? No.** The manager's scope finalizer kills every PTY
with a SIGTERM→SIGKILL escalation on shutdown (`Manager.ts:2490-2516`,
`DEFAULT_PROCESS_KILL_GRACE_MS = 1000` at `Manager.ts:99`). On the next `open` for the same
`(threadId, terminalId)` there is no live session, so the manager reads the `.log` file into a
fresh `BoundedTerminalHistory` and **spawns a brand-new shell** (`Manager.ts:2523-2576`). The user
sees their scrollback and a new prompt; anything that was running is gone.

| | Orquester (tmux) | T3 Code |
|---|---|---|
| Process owner | tmux server on a dedicated socket | the Node server process |
| Survives daemon restart | **yes** — reattach reconciles `orq-*` against `sessions.json` | **no** — PTYs are killed by the shutdown finalizer |
| Scrollback source | `tmux capture-pane` (durable, in tmux) | a `.log` file the server writes itself |
| Scrollback fidelity | raw, including device queries | **sanitized** of query/response traffic |
| Backpressure | none | 8-chunk / 64 KiB credit window |
| Memory cost of history | tmux's, out of process | in-process ring buffer, 8 MiB × N terminals |
| Retained idle sessions | unbounded | capped at 128, oldest evicted (`Manager.ts:100`, `evictInactiveSessionsIfNeeded`) |

**Conclusion: keep tmux.** T3's model is strictly weaker on persistence — they accept it because
their restart story is dominated by provider processes dying anyway (§5), and because `t3 update`
explicitly warns that "Restarting interrupts running agent turns, terminals, and remote clients"
(`docs/user/background-service.md:24-26`). Orquester's tmux backing is a genuine differentiator.
What to steal from T3 is the *periphery*: the credit window, the `activity`/`label` event, the
sanitizer, and the bounded-tail restore.

### 1.7 Server-side emulation vs. raw streaming — settled

There is **no server-side terminal emulation**. `native/libghostty-vt/` contains only
`VERSION` (a Ghostty git SHA, `9f62873…`), `LICENSE`, and `include/ghostty/vt.h` — headers, not
source. The emulator runs **in the client**: the web app compiles libghostty-vt to WebAssembly and
commits the artifact at `apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm` (~616 KB), loaded by
`apps/web/src/terminal/ghostty/runtime.ts`. `apps/web/src/terminal/ghostty/README.md:1-3` is
explicit: *"This directory is the browser adapter for the same official `libghostty-vt` C ABI used
by Android. It is intentionally not an xterm compatibility layer."* **There is no xterm.js
anywhere in the repo.** Android uses the same C ABI natively
(`docs/internals/terminal-runtime.md:31-38`), which is the actual reason for the choice: one VT
implementation for web and React Native, with better grapheme/wide-cell handling than xterm.js.

So the architecture is identical to Orquester's — server streams raw PTY bytes, client emulates —
and the only difference is *which* client emulator. **Do not rip out xterm.js.** The one thing
libghostty buys that xterm.js does not is a shared emulator with a native mobile client, which
Orquester does not have.

---

## 2. MCP server (`apps/server/src/mcp/**`)

### 2.1 The headline: MCP is NOT how questions or attachments reach the GUI

The MCP server exposes exactly three toolkits and **21 tools**, none of which is "ask the user a
question" or "request an attachment" (`apps/server/src/mcp/McpHttpServer.ts:631-635`):

1. **preview** — 14 browser-automation tools
2. **device** — 4 simulator/emulator tools
3. **pullRequests** — 3 PR-linking tools

Agent→user questions and permission prompts come from the **provider protocols**, not MCP:
Claude's `canUseTool` / `onUserDialog` callbacks (`apps/server/src/provider/Layers/ClaudeAdapter.ts:4947-4949`),
ACP's `session/request_permission` for Cursor/Antigravity/OpenCode/Grok
(`apps/server/src/provider/acp/AcpRuntimeModel.ts`, `AcpCoreRuntimeEvents.ts`,
`apps/server/src/provider/acp/CursorAcpExtension.ts`), and Codex's app-server protocol. The
attachment flow on an answer is a T3 *client* feature layered on top
(`docs/user/question-attachments.md:1-9`: files upload to the environment running the thread and
the agent receives **paths**, not blobs). If Orquester wants "the agent asks, the GUI answers",
that plumbing lives in the provider adapters — it is the providers subagent's territory, and it
does **not** require standing up an MCP server.

### 2.2 The tool list

**Preview toolkit** — `apps/server/src/mcp/toolkits/preview/tools.ts:244-259`:
`preview_status`, `preview_open`, `preview_navigate`, `preview_resize`,
`preview_set_appearance`, `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`,
`preview_scroll`, `preview_evaluate`, `preview_wait_for`, `preview_recording_start`,
`preview_recording_stop`.

Notable schemas:

- `preview_snapshot` (`tools.ts:119-142`) — `{tabId?, includeImage?: boolean, save?: boolean}`.
  Returns page state, semantic elements, console/network diagnostics, an action timeline, and a PNG.
  Its description carries the whole UX contract: *"Set `save=true` to also write the PNG to disk and
  get `screenshotPath` back; embed that path in your reply as `![alt](screenshotPath)` so the user
  sees it. This is the only way to show the user a screenshot."* — i.e. **the agent renders images
  into the chat by writing a file and referencing its path in markdown**, not by returning an image.
  That is a pattern Orquester can adopt today with zero MCP.
- `preview_click` / `preview_type` (`tools.ts:144-164`) prefer a **Playwright locator**, accept CSS
  `selector` as legacy, and require `x`+`y` together.
- `preview_evaluate` (`tools.ts:200-209`) — arbitrary JS, result ≤64 KB, wrapped as `{value}`
  because "MCP `structuredContent` must be a JSON object, and Claude Code rejects the whole result
  when it is not" (`tools.ts:188-192`).
- `preview_recording_stop` (`tools.ts:233-242`) transfers a ≤50 MiB compressed screen recording into
  the agent's environment as a file.

Annotations are set per tool: `Tool.OpenWorld` + `Destructive` for click/type/press/evaluate,
`Readonly` + `Idempotent` for status/snapshot/wait (`tools.ts:41-51`).

**Device toolkit** — `apps/server/src/mcp/toolkits/device/tools.ts:96-101`: `device_list`,
`device_open`, `device_screenshot`, `device_close`. The header comment at `tools.ts:21-27` explains
the restraint: *"Deliberately a small surface: lifecycle, visibility for the user, and one
image-returning verb. Driving the device … happens through the preconfigured `agent-device` CLI."*
`device_open` returns **the CLI invocation to use next** rather than putting driving instructions in
an always-loaded prompt (`docs/internals/devices.md:69-73`).

**Pull-request toolkit** — `apps/server/src/mcp/toolkits/pullRequests/tools.ts:227+`:
`link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`. This is the only toolkit
granted **unconditionally** (see §2.4) and it is the interesting one for a chat GUI: the agent tells
the app "the PR I just opened belongs to this thread", and the app then shows PR status beside the
thread and settles the thread when the PR merges (`tools.ts:189`).

### 2.3 Transport and auth between agent and server

- Mounted at **`/mcp`** over streamable HTTP, protocol `2025_06_18`
  (`McpHttpServer.ts:624-629`).
- Auth is a **bearer token, checked by an MCP-specific middleware**, not the environment auth stack
  (`McpHttpServer.ts:84-114`). A bad token gets a 401 `invalid_mcp_credential`, and the server logs
  a warning because *"Without this the only symptom of a dead credential is the agent quietly losing
  the whole `t3-code` toolkit for the rest of its session"* (`McpHttpServer.ts:95-100`).
- `apps/server/src/mcp/McpSessionRegistry.ts:117-151` — per-thread credential issuance: a
  `randomUUIDv4` provider-session id, a **32-byte random token** base64url-encoded, stored **hashed
  (SHA-256)** with a scope record `{environmentId, threadId, providerSessionId, providerInstanceId,
  capabilities, issuedAt}`.
- Liveness: a credential expires **24 h after its last sign of life**
  (`McpSessionRegistry.ts:61-75`). Both an MCP request (`resolve`, `:153-167`) and every provider
  turn (`touch`, `:169-183`) refresh it, so a long-running session never expires. Clean stops revoke
  eagerly (`revokeProviderSession` / `revokeThread` / `revokeAll`, `:194-202`); the window only
  bounds a session that died dirty.
- The endpoint the agent is told to call is derived from the bound address, with a wildcard bind
  announced as `127.0.0.1` because *"a wildcard bind is reachable on loopback, which is where the
  provider subprocesses run"* (`McpSessionRegistry.ts:82-87,99-101`).

### 2.4 Capability scoping

`apps/server/src/mcp/McpInvocationContext.ts:262` — capabilities are `"preview" | "device" |
"pull-requests"`. Every handler opens with `requireMcpCapability(...)`
(`McpInvocationContext.ts:298-306`), so the toolkit a token can reach is decided at issue time, not
at call time.

`apps/server/src/provider/Layers/ProviderService.ts:906-914` builds the set: `pull-requests`
always; `preview` only if the user enabled **agent browser access**; `device` only if **agent device
access** is on. `prepareMcpSession` (`ProviderService.ts:943-958`) issues the credential, and — when
`device` is granted — also computes a **PATH shim directory** so the `agent-device` CLI is on the
provider subprocess's PATH, *"the agent never handles a token"*
(`apps/server/src/mcp/McpProviderSession.ts:318-323`). Because a subprocess's environment is fixed
at spawn, the CLI must be started **before** the provider launches, not lazily from `device_open`
(`docs/internals/devices.md:62-67`).

### 2.5 How it is registered into each provider

`McpProviderSession.ts:33-46` keeps a per-thread in-memory `Map<ThreadId, config>`; each adapter
reads it at launch and translates it into that provider's own MCP config format:

| Provider | Mechanism | Citation |
|---|---|---|
| **Claude Code** | SDK option `mcpServers: { "t3-code": { type:"http", url, headers:{Authorization} } }` | `ClaudeAdapter.ts:4953-4963` |
| **Codex** | CLI config args `-c mcp_servers.t3-code.url=…` plus `-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`, with the raw token passed **in the child env**, never on the command line | `CodexAdapter.ts:2295-2307` |
| **Cursor** (ACP) | `mcpServers: [{type:"http", name:"t3-code", url, headers:[{name:"Authorization", value}]}]` | `CursorAdapter.ts:562-578` |
| **Grok / OpenCode / Antigravity** | same ACP `mcpServers` array | `GrokAdapter.ts:1015`, `OpenCodeAdapter.ts:2853`, `AntigravityAdapter.ts:788-801` |

Codex's env-var indirection is the good pattern: a token on a command line is visible in `ps` to
every process on the host, which matters on a shared or scoped-sudo box.

### 2.6 How the UI reacts to a tool call

It doesn't — **not directly**. The MCP tools do not push UI state. Two indirections:

1. **preview_\*** goes through `PreviewAutomationBroker` (`apps/server/src/mcp/PreviewAutomationBroker.ts`),
   which is a request/response router **back out to a connected client** over the
   `previewAutomation.connect` / `previewAutomation.respond` RPCs
   (`packages/contracts/src/rpc.ts:1179+`). The agent's `preview_click` becomes a message on a
   client's queue; the client performs it and answers. The broker pins one provider session to one
   client with a lease keyed `environmentId\0providerSessionId` (`PreviewAutomationBroker.ts:485`)
   so a multi-step interaction cannot hop between clients with independent cookie/DOM state
   (`:489-494`). No host → `PreviewAutomationNoAvailableHostError` (`:554-562`); a 15 s timeout
   evicts the whole connection **without replay**, because the client may already have applied the
   action (`:473`, `:606-610`).
2. **device_open** / **link_pull_request** mutate server state (device panel, thread PR links) which
   the UI already subscribes to (`subscribeDeviceState`, thread snapshot).

Tools that return images are registered **by hand** rather than through `McpServer.toolkit`, because
the generic path JSON-stringifies everything and a model needs an image content block
(`McpHttpServer.ts:493-498`, `registerImageTool` at `:499-577`, `registerPreviewSnapshot` at
`:346-444`). The snapshot result is also aggressively bounded to **60 000 UTF-8 bytes** because
*"Claude Code drops every MCP result above 25k tokens (~100 KB of text) and hands the agent a
truncation notice instead"* (`McpHttpServer.ts:116-127`); `boundSnapshotMetadata`
(`:170-267`) drops the accessibility tree first, then trims text/identifiers, then halves the log
arrays in a fixed shed order, and reports what it cut back to the agent.

> **Verdict: an MCP server is OPTIONAL for a chat GUI.** T3's is a *capability* server (browser,
> devices, PR linking), not a chat server. If Orquester wants one, the two ideas worth copying are
> (a) per-thread hashed bearer credentials with capability sets and liveness-based expiry, and
> (b) the "write the PNG to disk, reference the path in markdown" convention for showing images.

---

## 3. Remote access and authentication

### 3.1 There is no password

T3 has **no password auth anywhere**. The model is: a high-entropy one-time **pairing credential**
→ exchanged for a **scoped session**. Consequently there is *no* login throttle, no lockout, no
constant-time compare — a grep for `throttle|rateLimit|lockout|backoff` across
`apps/server/src/auth/*.ts` returns nothing. Orquester's password + per-IP `LoginThrottle` is a
different (and, for a public HTTPS endpoint, necessary) trade-off; T3 avoids the problem class by
never having a guessable secret.

### 3.2 Scopes — the idea to steal

`packages/contracts/src/auth.ts:81-88`:

```
orchestration:read   orchestration:operate   terminal:operate   review:write
access:read          access:write            relay:read         relay:write
```

`AuthStandardClientScopes` (`auth.ts:103-109`) is the ordinary pairing grant; `access:*` and
`relay:write` are administrative and only in `AuthAdministrativeScopes` (`auth.ts:110-115`).

**Every single RPC declares its required scope in one exhaustive table** —
`apps/server/src/auth/RpcAuthorization.ts:23-171`, typed
`satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>`, so *adding an RPC without choosing
a scope is a compile error* (`RpcAuthorization.ts:18-22`). Enforcement is per call
(`apps/server/src/ws.ts:668-686`): a successful handshake grants no authority
(`docs/internals/environment-auth.md:29-31`).

Note `terminal:operate` is its own scope (`RpcAuthorization.ts:137-145`) — a client can be paired
for chat without being allowed a shell. That maps cleanly onto Orquester's likely need for a
read-only / phone-only client.

Delegation rule: *"Exchanging a bootstrap credential can narrow that grant but cannot widen it …
Creating another pairing link requires both `access:write` and every scope being delegated"*
(`docs/internals/environment-auth.md:9-14`). And the access read model never returns recoverable
pairing secrets — only the creation response does (`environment-auth.md:16-19`).

### 3.3 The HTTP surface

`packages/contracts/src/environmentHttp.ts`:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/t3/environment` (`:412`) | unauthenticated descriptor — policy, bootstrap methods, session methods, cookie name |
| `GET /api/auth/session` (`:419`) | current session |
| `POST /api/auth/browser-session` (`:426`) | exchange a pairing credential for a **cookie** |
| `POST /oauth/token` (`:433`) | RFC 8693 token exchange → bearer/DPoP access token |
| `POST /api/auth/websocket-ticket` (`:441`) | short-lived WS ticket for bearer/DPoP clients |
| `POST /api/auth/pairing-token` (`:448`) | mint a new pairing link (needs `access:write`) |
| `GET/POST /api/auth/pairing-links[/revoke]` (`:456,:463`) | list / revoke unused links |
| `GET/POST /api/auth/clients[/revoke,/revoke-others]` (`:471-486`) | list / revoke device sessions |
| `POST /api/connect/*`, `/api/t3-connect/*` (`:559-611`) | relay link proof, mint credential, unlink |

Token exchange is real OAuth vocabulary:
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
`subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`,
`requested_token_type=…:access_token` (`packages/contracts/src/auth.ts:117-121, 186-196`) — but the
doc is careful: *"the environment does not implement a general-purpose OAuth authorization server"*
(`docs/internals/environment-auth.md:22-25`).

**DPoP** binds a token to a client proof key; *"an invalid proof must fail rather than fall back to
bearer authentication"* (`environment-auth.md:21-25`, `apps/server/src/auth/dpop.ts`).

### 3.4 WebSocket authentication

`apps/server/src/ws.ts:3738` — `serverAuth.authenticateWebSocketUpgrade(request)`. Browser sessions
authenticate the upgrade with their **cookie**; bearer/DPoP clients mint a short-lived **`wsTicket`**
over authenticated HTTP *"so long-lived tokens stay out of socket URLs"*
(`docs/internals/environment-auth.md:27-29`). That is strictly better than Orquester's `?token=…`
on `/ws` (which we redact from logs but which still lands in any intermediary's access log). The
same ticket mechanism covers `<img>` and `WebSocket` for the device hub proxy, where headers are
impossible (`docs/internals/devices.md:30-36`).

Session connect/disconnect is bracketed so the access UI can show live devices
(`ws.ts:3800-3804`).

### 3.5 Cookies

`apps/server/src/auth/http.ts:179-184` and `:277-283`:
`httpOnly: true, path: "/", sameSite: "lax"`, expiry from the session. **No `secure` flag** — a
deliberate consequence of supporting plain-HTTP LAN endpoints, but a footgun behind a TLS proxy
(see §10).

Cookie *names* are per-instance because *"cookies are scoped by host but **not** by port"*
(`apps/server/src/auth/utils.ts:13-24`). A remote-reachable web server names the cookie from its
**environment id** (`utils.ts:37-48`) so it survives a state-directory move or a public port change;
a loopback server names it `t3_session_<port>_<hash(stateDir)>`.

### 3.6 Auth policy and the loopback trap

`apps/server/src/auth/EnvironmentAuthPolicy.ts:23-37` derives a policy from the **bind host**:

```
desktop + remote-reachable → "remote-reachable"   (bootstrap: desktop-bootstrap, one-time-token)
desktop + loopback         → "desktop-managed-local" (bootstrap: desktop-bootstrap)
web + remote-reachable     → "remote-reachable"   (bootstrap: one-time-token)
web + loopback             → "loopback-browser"   (bootstrap: one-time-token)
```

`isRemoteReachableHost` (`apps/server/src/auth/utils.ts:66-80`) treats `0.0.0.0`/`::` as remote and
anything `127.*`/`localhost`/`::1` as local. **Behind a reverse proxy the server binds loopback and
therefore believes it is local** — which changes the advertised descriptor and, more importantly,
the **cookie name derivation** (instance-keyed on `stateDir`+port instead of environment id). See
§10.

### 3.7 CORS

`apps/server/src/httpCors.ts:1-8` — methods `GET, POST, OPTIONS`; headers `authorization`, `b3`,
`traceparent`, `content-type`, `dpop`.

`apps/server/src/http.ts:234-256`: **in production there is no `allowedOrigins` and no
`credentials: true`** — only dev (`devUrl`) and the Electron custom origins get an explicit
credentialed allowlist, plus `T3CODE_DEV_ALLOWED_ORIGINS`. That works because **app.t3.codes uses
bearer/DPoP tokens, not cookies**, so a wildcard non-credentialed CORS policy is sufficient. This is
the cleanest answer to "how does one server serve both a local browser and a hosted SPA": the local
browser is same-origin (cookie), the hosted SPA is cross-origin (bearer + wsTicket), and the two
never need a credentialed wildcard.

### 3.8 Hosted web is a client, not a proxy

`docs/internals/remote.md:27-38` and `apps/web/src/hostedPairing.ts:52-60`: app.t3.codes stores its
connection catalog **in the browser** and connects directly to each environment; it never proxies
and holds no server-side pairing state. A hosted pairing URL puts the backend in the **query** and
the pairing secret in the **fragment**, because fragments are never sent to the hosted origin —
*"Moving the token into a query parameter would disclose it to the wrong origin"*
(`remote.md:34-38`). Orquester's PWA is same-origin so this does not apply, but the fragment trick is
the right pattern for any future "open my server from a hosted page" link.

Corollary they call out explicitly: hosting the UI over HTTPS **cannot** make a plain-HTTP LAN
backend reachable from that browser context (`remote.md:30-32`, `docs/user/remote-access.md:111-119`).

### 3.9 Reachability plumbing: Tailscale, SSH, T3 Connect

- **Tailscale** (`packages/tailscale/src/tailscale.ts`) is just a shell-out to the `tailscale` CLI:
  `readTailscaleStatus` parses `tailscale status --json` with a 1.5 s timeout (`:217-270`),
  `ensureTailscaleServe` (`:341`) runs `tailscale serve` on port 443 by default
  (`DEFAULT_TAILSCALE_SERVE_PORT`, `:10`), `disableTailscaleServe` (`:352`) removes it, and
  `probeTailscaleHttpsEndpoint` (`:365`) verifies it. *"Tailscale supplies an endpoint for ordinary
  pairing, so it needs no separate environment type"* (`docs/internals/remote.md:42-45`).
- **SSH** (`packages/ssh/src/tunnel.ts`) is owned by Electron **main**, because it must spawn ssh
  and handle auth prompts; the renderer just uses the forwarded endpoint. Cleanup *"stops a remote
  server only if the launcher owns it"* (`remote.md:47-53`). First launch downloads the server into
  `~/.t3/runtime` on the host (`docs/user/remote-access.md:129-131`).
- **T3 Connect** (`infra/relay/`, a Cloudflare Worker) — a **trusted broker, not a proxy**. After
  bootstrap, application traffic goes straight from client to the environment's tunnel hostname; the
  Worker does not proxy HTTP or WS (`docs/internals/t3-connect.md:3-6`,
  `infra/relay/README.md:10-13`). The exchange: the relay asks the environment to mint a one-time
  bootstrap credential **bound to the client's DPoP key**; the client redeems it directly with the
  environment. *"The relay never receives that session token"* (`t3-connect.md:11-18`). Both sides
  sign: the environment accepts only bounded, replay-guarded relay proofs, and signed responses bind
  the result to the request nonce (`:20-28`). The stated residual trust: *"DPoP … does not make a
  compromised relay signing key harmless"* (`:30-32`). Identity is Clerk; SSH/headless logins use
  the OAuth **device authorization grant** because the browser cannot reach a loopback listener on
  the remote machine (`:81-86`).
- **Environment identity is route-independent** — an environment keeps its id across restarts and
  endpoint changes (`docs/internals/remote.md:9-20`), and *"Advertised endpoints are reachability
  hints. Only the connecting device can prove that a route works… Endpoint selection must not
  silently fall back to loopback"* (`:22-25`).

> **For Orquester:** none of this is needed. We have one public HTTPS origin behind Caddy. The
> transferable parts are the **scope table**, the **wsTicket instead of `?token=`**, and the
> **capability descriptor** (`/.well-known/t3/environment`) that lets an old client talk to a new
> server without version sniffing (`docs/internals/overview.md:21-38` shows the PR-linking
> capability negotiation as the worked example).

---

## 4. Server lifecycle

### 4.1 Entry points

`apps/server/src/bin.ts:55-70` builds an Effect CLI named `t3` whose bare invocation runs the server
and whose subcommands are `start`, `serve`, `pair`, `auth`, `connect`, `service`,
`service-launcher`, `service-preflight`, `update`, `uninstall`, `project`, `app`, `theme`, `triage`,
`ssh-helper`, `claude-history`. `apps/server/src/entrypoint.ts` is a 38-line `isEntrypoint` guard.
Default port **3773** (`apps/server/src/config.ts:22`); modes are `web | desktop`
(`config.ts:24`) and startup presentation is `browser | headless` (`config.ts:27`).

### 4.2 The activation gate

`apps/server/src/serverActivation.ts:6-26` is the load-bearing primitive. `forkParked` forks a
long-running root fiber but **blocks it on an activation `Deferred`** and returns only once the
fiber is proven parked. Combined with the update protocol below, this gives a hard boundary: the new
process must finish migrations, acquire every dependency, bind HTTP, and park every root **before**
it reports `prepared` — *"Keep fallible startup acquisitions before this boundary. A listener alone
does not prove the runtime is ready to commit"* (`docs/internals/server-updates.md:23-28`).

`apps/server/src/serverLifecycleEvents.ts:27-53` is a small pub-sub of `welcome` / `ready` events
with a replayable snapshot (each type deduped to the latest), surfaced to clients as
`subscribeServerLifecycle` (`RpcAuthorization.ts:168`).

### 4.3 Startup phases

`apps/server/src/serverRuntimeStartup.ts:933-1030`, in order:

1. `keybindings.start`, `settings.start` — both failure-tolerant (log a warning, continue)
2. `reactors.start` — the orchestration reactor and the **provider session reaper**
3. **`provider-sessions.reconcile`** (§4.4)
4. **`worktree-setups.reconcile`** (§4.5)
5. `projects.auto-pull` — `syncAutoPullProjects`
6. `welcome.autobootstrap` (forked parked), then the startup heartbeat and, in headless mode, the
   printed pairing URL (`issueHeadlessServeAccessInfo`, `startupAccess.ts`)

### 4.4 What survives a restart — provider sessions

**Nothing survives as a process.** Provider CLIs are children of the server. `reconcileProviderSessions`
(`serverRuntimeStartup.ts:482-745`) reconciles the *projection* against reality:

1. Ask `providerService.listSessions()` for live thread ids (`:502-504`).
2. From the command read model, find **orphans**: threads whose session says `starting`/`running`,
   or has a non-null `activeTurnId`, or is `ready` with a prepared continuation marker — but which
   are **not live** (`:536-543`).
3. For each orphan, read its `ProviderSessionDirectory` binding — which holds the provider's own
   **`resumeCursor`** (the provider-native session id) and a `runtimePayload` with a
   `SERVER_UPDATE_CONTINUATION_KEY` marker (`:553-575`).
4. **Continue** if there is a continuation marker *or* `interruptedByRestart` — the latter requires
   the per-project setting `continueThreadsAfterServerUpdate`, a `running` session with an active
   turn, and a non-null `resumeCursor` (`:580-588`, setting resolution at `:491-500`). The marker is
   re-persisted **before** sending so recovery is durable if this process also dies (`:651-663`),
   then the turn is re-sent: `providerService.sendTurn({threadId, continuation: true})` when the
   provider advertises `promptlessTurnContinuation`, otherwise a synthetic
   `SERVER_UPDATE_CONTINUATION_PROMPT` (`:703-710`). On success the marker is cleared
   uninterruptibly (`:714-723`).
5. **Otherwise settle as error** — `settleAsError(ORPHANED_PROVIDER_SESSION_ERROR)` dispatches a
   `thread.session.set` with `status:"error", activeTurnId:null` (`:594-645`, `:738`), so the UI
   never shows a spinner for a turn nobody is running.

So: **provider processes are resumed by provider session id (`resumeCursor`), opt-in per project,
and only for a turn that was actually in flight.** Everything else is settled as an error with a
message telling the user to send again (`:731-733`).

### 4.5 Worktree setups

`reconcileWorktreeSetups` (`serverRuntimeStartup.ts:749-830`). The doc comment at `:749-758` is the
whole design: the bootstrap lives only in memory, so a mid-setup exit leaves a `running` record with
nobody to finish it. Before the turn started, the persisted user message is stranded too, so the
setup is marked failed and the user is told to send again; after the handoff, only an async setup
script was still running, so its stage is marked failed and the setup settles as done —
`"interrupted by a server restart"` (`:791`, `:807-808`).

### 4.6 Terminals on restart

Killed (`Manager.ts:2490-2516`), scrollback restored, fresh shell on next open — §1.6. There is no
terminal reconcile phase at all.

### 4.7 The background service and the update protocol

`docs/user/background-service.md`: `t3 service install|status|restart|uninstall` (`:12-17`),
**systemd user services with lingering** on Linux (`:45-47`), launchd on macOS (login-scoped,
`:49-52`), **Windows unsupported** (`:54`). Troubleshooting is keyed on `linger-disabled`,
`linger-unavailable`, `user-manager-unavailable`, `service-disabled/stopped`, `restart-pending`
(`:83-88`). Running as root creates a separate installation and Connect identity (`:78-80`).

`apps/server/src/serviceLauncher.ts` is a **stable supervising launcher** deliberately written with
**zero Effect and only Node built-ins** — *"it is the one part of the executable that cannot depend
on the rest of it being loadable"* (`serviceLauncher.ts:3-6`). It is the only runtime writer of
durable service state; server children request updates over inherited IPC and never rewrite their
own service definition (`docs/internals/server-updates.md:3-8`).

The update commit boundary (`server-updates.md:16-30`, launcher constants at
`serviceLauncher.ts:33-35`: `HANDOFF_DELAY_MS=2000`, `PREPARED_TIMEOUT_MS=120000`,
`TERMINATE_GRACE_MS=5000`):

1. Launcher durably records the pending update, then stops the old child and starts the target as a
   **trial**.
2. The trial must reach the activation gate and report `prepared`.
3. Launcher commits the version durably and replies `committed`; **only then** may the child release
   its gates and accept commands.
4. A failed or timed-out trial **returns to the old version**, restoring a SQLite snapshot (main +
   WAL + shm) taken after the old child exited (`server-updates.md:32-42`). A durable restore marker
   makes an interrupted restore finish before either version boots. *"Attachments and other files
   outside SQLite are outside this rollback boundary."*
5. Clients correlate the launcher's **update id** with the `ready` event after reconnecting, because
   *"A reconnect alone cannot distinguish successful replacement from rollback"* (`:44-49`).

> **For Orquester:** we deploy by `systemctl restart` with `KillMode=process` and tmux survivors, so
> we need neither trial-boot nor DB snapshots. What we *do* lack is step 5 — a client today cannot
> tell "the daemon restarted with my change" from "the daemon restarted and rolled back". A version
> + build-id on the `ready`/hello event would close that.

### 4.8 Graceful shutdown

`apps/server/src/terminal/Manager.ts:2490-2516` kills PTYs with escalation; provider sessions have
their own reaper; `t3 update` warns that a restart interrupts running turns, terminals, and remote
clients and asks first (`docs/user/background-service.md:22-27`). There is no equivalent of
Orquester's 3 s hard-exit backstop + `closeAllConnections()` — worth keeping ours.

---

## 5. Source control, checkpoints, worktrees

### 5.1 Four layers

| Layer | Role |
|---|---|
| `apps/server/src/vcs/` | VCS-agnostic mechanism. `VcsDriver.ts:56` is a narrow contract (`capabilities`, `execute`, optional `checkpoints`, `detectRepository`, `listWorkspaceFiles`, `filterIgnoredPaths`, optional `getDiffPreview`). Only **git** is registered (`VcsDriverRegistry.ts:63-67,108`); `jj` is a declared kind (`packages/contracts/src/vcs.ts:4`) with a binary probe but no driver. |
| `apps/server/src/git/` | Product workflow. `GitWorkflowService.ts:38-112`. |
| `apps/server/src/sourceControl/` | Forge abstraction — 5 hosts (`SourceControlProviderRegistry.ts:297-325`). |
| `apps/server/src/pullRequest/` | PR data, ~30 methods (`PullRequestService.ts:174-258`). |

Every git child process funnels through `apps/server/src/vcs/VcsProcess.ts` with a **global semaphore
of 8**, a `gh`-specific sub-semaphore of 4 (`:60-61`), a 30 s default timeout and a 1 MB output cap
(`:57-58`).

### 5.2 What the git surface actually is — and isn't

`GitWorkflowService` has **no stage/unstage/discard, no stash, no blame, no log browser**. The whole
"ship it" surface is one composite streamed RPC:
`GitStackedAction = ["commit","push","create_pr","commit_push","commit_push_pr"]`
(`packages/contracts/src/git.ts:12-18`) with progress phases `branch|commit|push|pr` and hook stdout
(`:20-33`). Staging is implicit — `reset` then `add -A` (or `add -A -- <filePaths>` for a partial
selection), `apps/server/src/vcs/GitVcsDriverCore.ts:1984-1997`.

**Commit messages and PR bodies are LLM-generated**: `apps/server/src/git/GitManager.ts:1839-1846`
and `:2021-2038` feed `log --oneline`, `diff --stat` and a 60 KB patch into
`textGeneration.generatePrContent`. A "Commit" button can therefore spawn an agent CLI — budget for
it, and make it skippable.

Status is **pushed, not polled by the client**: `apps/server/src/vcs/VcsStatusBroadcaster.ts:203`
streams from one per-cwd background fiber at 30 s (`:32`) with 30 s→15 min backoff (`:33-34`),
refcounted to subscribers (`:606`) — structurally identical to Orquester's `GitWatcher`.

`apps/server/src/review/` is **neither AI review nor PR review**: it is the local diff-viewer
backend, two methods `getDiffPreview` / `getDiffFileContents` (`review/ReviewService.ts:90,119`),
sources `"working-tree" | "branch-range"` (`packages/contracts/src/review.ts:20`), guarded by
`assertWorkspaceBoundCwd` which realpaths the cwd and rejects anything outside `config.cwd` or
`config.worktreesDir` (`review/ReviewService.ts:66-88`).

### 5.3 Forges

GitHub shells **`gh`** (`sourceControl/GitHubCli.ts:408,429`, token via `GH_TOKEN` env at
`:419-421`) with **no HTTP fallback**; GitLab shells `glab` (`GitLabCli.ts:422`); Azure shells `az`
(`AzureDevOpsCli.ts:344`); Bitbucket is pure HTTP (`BitbucketApi.ts:35,615`); Forgejo is HTTP but
reads credentials out of the `fj`/`tea` CLI config (`ForgejoCli.ts:434-439`). A missing binary
degrades to a discovery hint, not a crash (`GitHubSourceControlProvider.ts:117`). Supporting
machinery worth noting: a per-host rate-limit gate with 30 s→15 min backoff
(`SourceControlRateLimit.ts:13-14,77`) and a GraphQL point-budget guard reserving the last 10 %
(`githubGraphQlBudget.ts:10,20`).

**PR review comments never reach the agent server-side.** There is no code path that renders a
comment into prompt text. A comment picked in the diff UI becomes a *client-side composer context
record* of kind `review-comment` (`packages/contracts/src/composerContext.ts:188-202`, built in
`apps/web/src/reviewCommentContext.ts:13,59`) that rides the normal message. The inverse lookup
("which threads are linked to PR #N") is SQL at `pullRequest/linkedThreads.ts:16`.

### 5.4 Checkpoints — the mechanism

Ref scheme: `refs/t3/checkpoints/<base64url(threadId)>/turn/<n>`
(`apps/server/src/checkpointing/Utils.ts:4-9`). Nothing lands on the user's branch.
`checkpointing/CheckpointStore.ts` is a thin Effect service; the real work is
`apps/server/src/vcs/GitVcsDriver.ts:768-1034`:

1. Resolve `--git-common-dir`, allocate `GIT_INDEX_FILE=<common>/t3-checkpoint-index-<uuid>`
   (`:776-781`) — an **isolated temp index**, never the user's.
2. Copy the live index, `read-tree --reset HEAD`, then **restore the index's racy mtime so stat data
   survives** (`:817-837`). This is the performance trick that avoids re-hashing the tree.
3. `git add --sparse -A -- .` into the temp index (`:923-940`), `write-tree`, `commit-tree`,
   `update-ref` (`:993-1032`).
4. Every ref/object write carries `-c core.fsync=objects,reference -c core.fsyncMethod=fsync`
   (`:760-766`), because an unclean restart can otherwise leave **0-byte files under `refs/t3/**`
   that break every later fetch and push**.
5. Author/committer forced to `T3 Code <t3code@users.noreply.github.com>` (`:784-789`); temp index +
   `.lock` cleaned in an `ensuring` (`:792-797`).

Cost: ~8–12 `git` invocations per turn plus a full `add -A` worktree scan with `core.fsmonitor=false`
forced (`:771-775`), and a `diff --numstat` for the summary. Capture retries twice on transient
exits and has its own carve-out in process admission (`VcsProcess.ts:63,206-224`).

Triggers (`apps/server/src/orchestration/Layers/CheckpointReactor.ts`): a **pre-turn baseline** on
`turn.started` / `thread.turn-start-requested`, only if the ref for the current turn count is missing
(`:461-508`); a **completion checkpoint** on `turn.completed` *or* `turn.aborted` (`:392-458`,
dispatched `:963-1001`). The per-turn diff summary is derived from
`diffCheckpoints(..., format:"numstat")` and dispatched as `thread.turn.diff.complete` plus a
`checkpoint.captured` activity row (`:288-380`).

Non-git or unresolvable cwd → **silently skipped**, never an error
(`resolveCheckpointCwd`, `:208-239`). A dirty tree is the normal case: `add -A` captures unstaged and
untracked work, and `.gitignore` is respected, so `node_modules` never enters a checkpoint.

Restore (`GitVcsDriver.ts:1041-1115`): `restore --source <oid> --worktree --staged -- .`, then
`clean -fd -- .` (no `-x`, so ignored files survive), then `reset --quiet`.

### 5.5 Revert coordinates git with the provider conversation

`handleRevertRequested` (`CheckpointReactor.ts:771-918`) calls
`providerService.assertConversationRollbackSupported` **before touching the filesystem** (`:813`) —
a provider that cannot rewind rejects first (`provider/Layers/ProviderService.ts:2190-2203`). Then:
restore files (optional) → `rollbackConversation({numTurns})` → `deleteCheckpointRefs` for every ref
above the target (`:890-893`). This is the rule the architecture doc states abstractly
(`docs/internals/overview.md:79-82`).

**File restore requires a dedicated worktree.** `isRestoreWorkspaceIsolated` (`:722-769`) returns
false when `thread.worktreePath === null`, when the worktree is shared with another thread, or when
any other thread/live-session cwd overlaps — *"Checkpoints contain the whole checkout, so restoring
a shared cwd can erase a sibling's work."* The UI encodes this as two commands,
`thread.checkpoint.revert` (files + conversation) and `thread.conversation.revert` (conversation
only) — `orchestration/decider.ts:1797-1818`,
`packages/client-runtime/src/operations/commands.ts:363` — and the "Revert files too" button renders
only when `activeWorktreePath !== null`, otherwise the copy reads *"Files stay as they are because
this thread shares the project directory"* (`apps/web/src/components/ChatView.tsx:10425-10447`).

**Checkpoint refs are never garbage-collected outside revert.** `ThreadDeletionReactor` only stops
the session and closes terminals (`orchestration/Layers/ThreadDeletionReactor.ts:59-65`);
`MAX_THREAD_CHECKPOINTS = 500` (`orchestration/projector.ts:60`) caps the *read model*, not the refs.

### 5.6 Projects and worktrees

A project is a directory record (`workspaceRoot`). An optional checked-in **`t3.json`** adds
`iconPath`, `scripts[]` (with `runOnWorktreeCreate`), and
`defaultThreadEnvMode: "worktree" | "local"` (`packages/contracts/src/t3ProjectFile.ts:68-100`),
loaded best-effort (`project/T3ProjectFileLoader.ts:67-103`).

**Worktrees are opt-in, per thread, and default to OFF.** `defaultThreadEnvMode` defaults to
`"local"` (`packages/contracts/src/settings.ts:1173-1175`); `t3.json` can flip a repo and a project
override beats both. The client passes `bootstrap.prepareWorktree` at send time
(`apps/web/src/components/ChatView.tsx:8018-8024`; server `apps/server/src/ws.ts:1301-1305,1436-1470`).

They live in an **app-data dir, not beside the repo**: `worktreesDir = join(baseDir, "worktrees")`
(`apps/server/src/config.ts:146`), laid out `<baseDir>/worktrees/<repo-basename>/<sanitized-branch>`
(`vcs/GitVcsDriverCore.ts:3054-3059`). The branch starts as `t3code/<8 hex>`
(`packages/shared/src/git.ts:13,93-105`) and is **renamed to an LLM-chosen name after the first
message** (`orchestration/Layers/ProviderCommandReactor.ts:885-935`) — the directory keeps the hex
name, so branch and directory deliberately drift apart. A separate reactor follows a manual
`git checkout` inside a thread-owned worktree (`CheckpointReactor.ts:578-636`).

Setup scripts run inside the new worktree with `T3CODE_PROJECT_ROOT` / `T3CODE_WORKTREE_PATH`
(`project/ProjectSetupScriptRunner.ts:340-372`); only the first `runOnWorktreeCreate` script runs.
Startup reconcile does **not** repair directories — it only fails stranded setup records
(`serverRuntimeStartup.ts:760-830`); a missing directory is repaired lazily at turn time via
`pruneWorktrees` + `createWorktree` (`ProviderCommandReactor.ts:474-516`). Cleanup has three paths:
bootstrap rollback (`ws.ts:1640-1666`), a client prompt on thread delete, and an hourly policy engine
that is **off by default** and refuses any worktree with uncommitted changes, live sessions, or
ignored files other than `node_modules/` (`storageCleanup.ts:172-360`). Removal deliberately keeps
the branch so the next turn can recreate the checkout (`:355-358`).

`apps/server/src/workspace/workspaceLease.ts:6-23` is a **process-local** `Map<cwd, Semaphore(1)>`
serializing checkout removal, terminal start and turn start — there is no cross-process lock.

### 5.7 Required vs optional

| Subsystem | Verdict | Why |
|---|---|---|
| `review/` diff preview | **Required** | A chat agent that edits files is unusable without "show me what changed", and it is the cheapest piece here (~140 lines over `git diff`). Ship first. Orquester's git tab already has most of it. |
| VCS status broadcaster | **Required** | Live branch/dirty/ahead-behind. Orquester's `GitWatcher` is already this shape. |
| **Per-turn diff summary** (files + ±lines) | **Required** | This is what makes a GUI agent legible versus a terminal. Note it is *derived from* checkpoints (`CheckpointReactor.ts:288-310`) — you can get it more cheaply with a `commit-tree` per turn and no restore machinery. |
| Checkpoint **restore/rewind** | **Optional, high value** | The "edit an earlier message and re-run" affordance. Gated on two hard prerequisites: provider conversation rollback and an isolated worktree. Without both, ship conversation-only rewind, which costs no git work. |
| Worktrees | **Optional — required *if* you want file restore or parallel threads** | Not automatic even in T3. |
| `git.runStackedAction` | Optional polish | Drags in LLM text generation and a forge CLI. |
| `sourceControl/` + `pullRequest/` (~8 k lines) | Optional, expensive | Bulk of the code, near-zero of the core loop. |
| PR review-comment → agent | Optional, and **needs no server work** | Pure client-side composer context. |

---

## 6. Preview

### 6.1 What it is — and is not

`apps/server/src/preview/` is only two files, and **neither is a browser and neither proxies
anything**.

**`preview/PortScanner.ts` = dev-server detection.** It runs
`lsof -iTCP -sTCP:LISTEN -P -n -F pcn` on macOS/Linux (`:520`), PowerShell `Get-NetTCPConnection` on
Windows (`:494`), and falls back to probing a hardcoded `COMMON_DEV_PORTS` list (3000/5173/4321/8080/…)
when neither works (`:69-71`, `:306-328`). A listener is published only after a 1 s HTTP GET confirms
`text/html` or a redirect (`probeWebUrl`, `:330-349`), so a Postgres on 5432 never appears. Results
cache for 15 s; polling is refcounted to one layer-scoped fiber at 3 s and is a no-op when nobody is
watching (`:551-603`). It also maps listener PIDs back to the terminal that spawned them
(`registerTerminalProcesses`, `:625-644`) — which is how the UI says *"your `pnpm dev` in terminal 2
is on :5173"*. Exposed as one streaming RPC, `subscribeDiscoveredLocalServers`
(`apps/server/src/ws.ts:3486`), consumed by
`apps/web/src/components/preview/useDiscoveredLocalServers.ts`.

**`preview/Manager.ts` = an in-memory session registry.** No browser, no I/O. Sessions keyed
`(threadId, tabId)` (`:84`) holding `navStatus`, `canGoBack/Forward`, viewport, `profileId`
(`:120-154`), mutated under a `SynchronizedRef` so event order matches state order (`:176-220`).
`refresh()` **does nothing but verify existence** — *"the desktop bridge handles the actual reload
and will report progress back via `reportStatus`"* (`:387-395`).

RPCs: `preview.open|navigate|resize|refresh|close|list|reportStatus`
(`packages/contracts/src/rpc.ts:339-345`, definitions `:1140-1177`), all `orchestration:operate`
except `previewList` (`auth/RpcAuthorization.ts:146-155`).

### 6.2 The pixels come from Electron

The actual renderer is an Electron `<webview>` — `apps/web/src/browser/ElectronBrowserHost.tsx`,
`HostedBrowserWebview.tsx`, and `apps/desktop/src/preview/Manager.ts:4` ("Hosts per-tab Chromium
WebContents references"). **In a plain browser there is no renderer at all.** The MCP automation
gate is explicit — `apps/web/src/components/preview/PreviewAutomationHosts.tsx:274`:

```ts
if (!isElectron || !previewBridge?.automation) return null;
```

Locators are resolved by injecting **Playwright's selector engine** into the webview
(`apps/desktop/src/preview/PlaywrightInjectedRuntime.ts`, `playwright-core@1.60.0` at
`apps/desktop/package.json:31`) — the injected script only. **No Playwright browser is ever
downloaded.**

> **Direct consequence for Orquester:** on a VPS whose only clients are browsers/PWA, every
> `preview_*` MCP call would return `PreviewAutomationNoAvailableHostError`. T3's architecture is the
> *mirror image* of Orquester's `/ws-browser` server-side Chromium. **Our design is the right one for
> a VPS.** What is worth copying is the tool *schema set* and the broker's lease semantics, not the
> host.

`PortScanner`, by contrast, is a genuinely good and cheap steal: ~660 lines, zero native deps, and it
turns "the agent started a dev server" into a clickable card. It needs `lsof` on PATH and degrades to
a 16-port probe otherwise.

---

## 7. Native helpers (`native/**`)

All five are **out-of-process binaries or a WASM blob. There are zero N-API addons and no
koffi/ffi-rs in the server path.** (`docs/internals/overview.md:105-110` states the rule: native
modules never load in the Electron main process on the startup path; new native capability goes "in a
child with a deadline, not an `import` in main".)

| dir | lang | loaded by | role | required? |
|---|---|---|---|---|
| `libghostty-vt` | Zig/C ABI — only `VERSION`, `LICENSE`, `include/ghostty/vt.h` | **client-side WASM**, `apps/web/src/terminal/ghostty/runtime.ts` | terminal emulation, shared with Android | **No** — xterm.js is equivalent for a web-only client |
| `resource-monitor` | Rust (`sysinfo`) | **server** spawns it as a child with a stdout JSON protocol (`resourceTelemetry/NativeTelemetryClient.ts:571-602`); binary resolved from bundled / `target/<triple>/release` with a `T3CODE_RESOURCE_MONITOR_PATH` override (`ResourceMonitorBinary.ts:137-180`) | per-process CPU/mem/IO | **No** — Orquester's `/proc` reader already covers it |
| `browser-secret` | C (libsecret/GLib) | desktop subprocess (`apps/desktop/src/preview/BrowserImport/LinuxBrowserSecret.ts:20-37`) | reads the Chromium `os_crypt` key from the GNOME keyring to import real-browser cookies | **No**, desktop-only |
| `hyprland-snap-shot` | Rust (wayland-client, `hyprland-toplevel-export-v1`) | desktop subprocess (`apps/desktop/src/snapShot/DesktopSnapShot.ts:750-757`) | window capture on Hyprland | **No** |
| `kde-snap-shot` | Rust (zbus → `org.kde.KWin.ScreenShot2`) | desktop subprocess (`DesktopSnapShot.ts:737-746`); installed to a stable XDG path with a hidden `.desktop` entry because KWin authorizes by executable path (`KdeSnapShot.ts:25-45`) | window capture on KDE | **No** |

**libghostty-vt details.** `native/libghostty-vt/VERSION` pins Ghostty commit `9f62873…`. The web
build script `apps/web/scripts/build-libghostty-wasm.sh` needs **Zig 0.15.2** and downloads Ghostty
source at that SHA, but the ~616 KB artifact is **committed** at
`apps/web/src/terminal/ghostty/vendor/ghostty-vt.wasm`, so nothing builds on a deploy host. Struct
offsets are read at runtime from `ghostty_type_json` so ABI drift is detectable
(`runtime.ts:38-42`). A second 112-byte `ghostty-write-pty.wasm` is a callback trampoline for
terminal-generated PTY replies (`apps/web/src/terminal/ghostty/README.md`).

**resource-monitor / `apps/server/src/resourceTelemetry/`.** Not load balancing. It feeds (a) a
diagnostics UI (`subscribeResourceTelemetry`, `serverGetResourceTelemetryHistory`,
`ws.ts:2591-2608,3685`), (b) `ProcessDiagnostics`/`ProcessResourceMonitor`, which attribute usage to
categories like `provider-root` / `terminal-root`, and (c) `BackgroundPolicy` (`ws.ts:627,2636`),
which throttles background work on battery. Rationale at `docs/internals/resource-telemetry.md:1-8`:
native collection stays out of Node to *"isolate collector crashes and avoid a Node/Electron addon
ABI matrix"*, and *"A missing or failed collector leaves the server running."* Documented traps: PID
reuse → identity includes start time; `/proc/<pid>/task` enumeration is disabled on Linux because
sampling it is itself expensive. On a VPS: needs a Rust toolchain, and **musl is explicitly
unsupported** — `resourceMonitorRustTarget` returns `undefined` unless glibc
(`ResourceMonitorBinary.ts:117-127`), so Alpine gets `ResourceMonitorBinaryUnsupported`. Fails soft.

**"Snap Shot"** (`docs/user/snap-shot.md:1-6`, `docs/internals/linux-snap-shot.md:20-23`) is a global
hotkey that screenshots the window you are working in **plus its accessibility tree** and attaches
both to the current agent draft. Off by default, desktop-only, **Wayland only**. Each compositor
needs its own helper because the xdg Screenshot portal returns a PNG with *no window identity*, so
portal captures carry no accessibility data. Backends never fall back to one another; selection is by
`XDG_CURRENT_DESKTOP`. It also drags in `dbus-next` with a **required local patch**
(`patches/dbus-next@0.10.2.patch`) that strips the `usocket` native dep. Meaningless on a headless
VPS.

---

## 8. Usage and quotas

T3 splits "usage" into **two subsystems that share nothing but a page**.

### 8.1 Cost/token history = transcript scanning

`apps/server/src/usage/UsageService.ts:1-13` states the design: it reads the provider CLIs' **own**
session files rather than T3's orchestration projections — *"the approach `ccusage` takes"* — so
turns driven outside T3 still count. Only three providers have parsers: **Claude, Codex, Grok**
(`UsageService.ts:263`; `parseClaudeLine`/`parseCodexLine`/`parseGrokLine` in
`apps/server/src/usage/usageTranscripts.ts`). Homes resolve per provider *instance*, honouring
`CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME` and per-account overrides, then `<home>/projects`
(Claude) or `<home>/sessions` with `updates.jsonl` (Codex/Grok) — `UsageService.ts:276-333`. Cursor,
OpenCode and Antigravity contribute **no** cost history.

The performance engineering is the transferable part:

- Files memoised by `(size, mtime)`; a file that only **grew** resumes parsing from a stored byte
  offset guarded by a hash of the preceding bytes, so an actively-written multi-hundred-MB rollout
  costs only its appended bytes (`UsageService.ts:387-442`, rationale
  `usageTranscriptReader.ts:39-50`).
- A cheap **substring gate before `JSON.parse`** on every line (`usageTranscripts.ts:63-70`) —
  "worth about an order of magnitude".
- mtime pre-filter with 36 h slack (`:79`), 90-day cache retention (`:83`), cache at
  `<stateDir>/usage-scan-cache.json` (`:163`).
- Concurrent identical requests share one detached scan keyed by window + price overrides
  (`:648-692`). Claimed: cold 30-day scan of ~1.4 GB ≈ 2–3 s.

### 8.2 Subscription limits = live provider endpoints, per driver

| Provider | Source | Citation |
|---|---|---|
| Codex | JSON-RPC `account/rateLimits/read` on the app-server + streamed `account/rateLimits/updated` mid-turn | `CodexProvider.ts:444`, `CodexAdapter.ts:2002` |
| Claude | Agent SDK `get_usage` control request during the capabilities probe + streamed `rate_limit_event` | `claudeUsageLimits.ts:1-11`, `ClaudeProvider.ts:239` |
| Grok | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`, token from `$GROK_HOME/auth.json`; `XAI_API_KEY` ⇒ `unsupported` | `grokUsageLimits.ts:128`, `:66` |
| Cursor | `https://api2.cursor.sh` with a **file-based** CLI token (keychain login unsupported) | `cursorUsageLimits.ts:112` |
| OpenCode | `GET https://opencode.ai/zen/go/v1/usage` — local server only | `openCodeUsageLimits.ts:30-38` |

> Orquester already reads exactly the Grok billing endpoint in `createGrokSource`. T3's Codex/Claude
> probes are the incremental ask, and both come free with the provider adapters if we adopt the
> app-server / SDK harnesses.

All normalise to one shape:
`ServerProviderUsageWindow { kind: session|weekly|monthly|other, id, usedPercent, resetsAt, windowDurationMins }`
(`packages/contracts/src/providerUsageLimits.ts:7-33`). Probes and streamed updates deliberately emit
**the same window ids** so a mid-turn partial upserts onto the probe's row
(`codexUsageLimits.ts:1-6`); merge at `providerUsageLimits.ts:50-59`, ingestion at
`ProviderUsageLimitsIngestion.ts:20-42`.

**Refresh cadence.** Server side, limits ride the provider health-check loop: default **5 min**
(`packages/contracts/src/settings.ts:915`), tuned by background profile — 1 min performance / 5 min
balanced / 15 min battery-saver (`packages/shared/src/backgroundActivitySettings.ts:24-60`) — and
gated by `BackgroundPolicy.shouldRunScopeWork({type:"provider-status"})` so it pauses on
locked/low-power hosts (`UsageLimitSources.ts:154-163`). The documented **"at least five minutes
between automatic checks"** rule is **client-side**, in
`packages/client-runtime/src/state/usage.ts:15-37`: a per-environment `Map` of `refreshAfter` stamps
set in a `.finally()`, so it applies even after a *failed* check.

**Pricing.** LiteLLM's `model_prices_and_context_window.json` fetched raw from GitHub
(`UsageService.ts:66-67`), 24 h TTL with a 60 s floor on forced refresh (`:70-73`), cached to
`<stateDir>/usage-model-rates.json`, with a three-tier status `fresh|cached|unavailable` so the page
works offline (`:185-230`). Prices at the **base tier only**, because transcripts do not record which
tier served the request (`usagePricing.ts:16-23`). Cost = per-token sum over uncached-input /
cached-input / cache-creation / output; `reasoningTokens` is **not** charged, being a subset of output
(`usagePricing.ts:179-201`). Precedence is **override → provider-reported → LiteLLM rate →
unpriced** (`:186-189`). Two traps: `costUsd: 0` with `costSource: "unpriced"` is **not** zero cost
and clients must not render it as dollars (`packages/shared/src/usageMerge.ts:48-54`); and an entry
missing either an input or an output rate is **dropped entirely** rather than half-priced
(`usagePricing.ts:64-73`). Overrides live in `ServerSettings.usagePriceOverrides` per environment as
USD-per-million (`createOverrideRateTable`, `usagePricing.ts:34-50`).

### 8.3 The CLIProxyAPI hub — the cheapest win for Orquester

A hub is just config: `{kind:"cliproxy", label?, url, managementKey, enabled}`
(`packages/contracts/src/settings.ts:880-886`). The management key lives in the server secret store
keyed `usage-limit-source-<base64url(id)>` and is redacted to `"••••••"` for clients, where the
redaction marker sent back means **"keep what you have"** (`apps/server/src/serverSettings.ts:145-190`,
`:694-715`, `:829-861`).

The protocol (`apps/server/src/usage/cliproxyApi.ts`) is three calls, all against
`{hubUrl}/v0/management/<path>` with `Authorization: Bearer <managementKey>`, 15 s timeout
(`:118-141`):

1. **`auth-files`** → the hub's pooled accounts (`id`, `auth_index`, `provider`, `email`,
   `disabled`, `id_token.chatgpt_*`) (`:143-146`).
2. **`api-call`** → the hub proxies an **arbitrary upstream request using that account's
   credential**, with `Authorization: Bearer $TOKEN$` as a literal placeholder the hub substitutes
   (`:154-172`). T3 uses it against `https://api.anthropic.com/api/oauth/usage` and
   `https://chatgpt.com/backend-api/wham/usage` — the same endpoints the local drivers use, but with
   someone else's token (`:211`, `:240`).
3. **`reset-quota`** → clears the hub's cooldown after a Codex reset credit is redeemed (`:342`).

Codex **reset credits** are read from `…/wham/rate-limit-reset-credits` and redeemed via `…/consume`
with a **UUIDv5 `redeem_request_id` derived from `(accountId, creditId)`**, so a retry from a
different environment is idempotent (`cliproxyApi.ts:102-113`, `:325-331`). A credits outage must not
hide successfully-read quota windows (`:252-253`); a per-account read failure degrades to
`makeUnavailableUsageLimits({reason:"probeFailed"})` rather than dropping the row (`:283-292`).
`UsageLimitSources` polls every enabled source on the provider-health interval and on every settings
change, holds a `Semaphore(1)` so a slow read cannot resurrect a just-deleted source, and keeps
failed sources visible with `error` set (`UsageLimitSources.ts:1-13`, `:99-116`, `:139-146`).
Nothing is persisted — it re-derives on boot.

### 8.4 Delivery to clients

Cost history is two RPCs — `server.getUsageSummary` and `server.refreshUsageRates`
(`packages/contracts/src/rpc.ts:383-384`, `:632-644`) — plus `provider.consumeResetCredit` (`:300`).
**Limits are not an RPC at all**: they ride `subscribeServerConfig` as `providers[].usageLimits` plus
a `usageLimitSources` array, pushed on change with a `usageLimitSourcesUpdated` event and
capability-negotiated per client (`packages/contracts/src/server.ts:597-601`, `:727`;
`apps/server/src/ws.ts:3540-3548`; `rpc.ts:1342-1343`). An untargeted `server.refreshProviders`
**awaits** `usageLimitSources.refresh` rather than forking it, because the RPC scope closes on return
(`apps/server/src/ws.ts:2318-2328`). **Aggregation is client-side** — each environment answers the same
query and the client merges (`apps/web/src/state/usage.ts:1-8`, `packages/shared/src/usageMerge.ts`).
Double-counting is prevented by a `UsageSourceFingerprint {hostId, provider, resolvedHomePath,
volumeId}` where `volumeId` is `device:inode`, because hostname+path alone collides across a fleet of
identically-named machines (`packages/contracts/src/usage.ts:120-131`). Limits pool by
`driver:lowercased-email`, so the same account on two environments *and* a hub counts once
(`packages/shared/src/usageLimits.ts:55-75`).

### 8.5 Verdict

**Optional polish**, with one exception. Cost history is ~2 500 LOC of server code plus a shared merge
layer and three client surfaces, and nothing in the chat loop depends on it. Subscription *windows*
matter operationally (knowing you are at 95 % of a 5 h window before starting a long task) — Orquester
already has per-window quota bars. The **CLIProxyAPI hub integration is the cheapest win in this
report**: ~200 lines against `/v0/management/{auth-files,api-call,reset-quota}`, and Orquester would be
calling its **own supervised local process** rather than a remote hub. Codex reset credits
(`nothing_to_reset`/`no_credit`/`already_redeemed` plus the `reset-quota` cooldown clear) are the
genuinely novel bit.

---

## 9. Notifications and "needs attention"

### 9.1 The state machine — this part is REQUIRED

Canonical model: `packages/shared/src/agentAwareness.ts:8-117`. Phases
`starting | running | waiting_for_approval | waiting_for_input | completed | failed | stale`,
resolved as a **strict priority ladder**:

```
hasPendingApprovals                     -> waiting_for_approval
hasPendingUserInput                     -> waiting_for_input
session=error | turn=error              -> failed
session=starting                        -> starting
session|turn=running                    -> running
turn=completed                          -> completed
turn=interrupted && completedAt != null -> completed   // race: teardown vs turn.completed
session=ready|idle                      -> completed   // turns that produce no checkpoint
else                                    -> null (tombstone)
```

The last two branches carry long comments about real bugs (`:98-115`): a thread that finishes and is
torn down quickly otherwise tombstones instead of publishing "Done". **Copy them verbatim.**

Attention reduces to **two booleans on the thread shell**: `hasPendingApprovals` /
`hasPendingUserInput` (`packages/contracts/src/orchestration.ts:895-896`), recomputed by the
projection pipeline as `count > 0` (`ProjectionPipeline.ts:582-600`). Pending user-input is folded
from the activity log — `user-input.requested` opens a `requestId`, `user-input.resolved` closes it
(`ProjectionPipeline.ts:161-204`). **Approvals** come from adapter `request.opened` events
(`requestKind: command | file-read | file-change | mcp-elicitation | permission`) normalised in
`ProviderRuntimeIngestion.ts:469-537`. **Questions are separate and adapter-specific**: Codex's
`item/tool/requestUserInput` (`CodexAdapter.ts:1340`), Claude's `AskUserQuestion` intercepted in
`canUseTool` (`ClaudeAdapter.ts:4450-4505`). A thread with either flag **can never settle**
(`ThreadSettlementPolicy.ts:120`).

> Orquester's `SessionSummary.activity` (working/waiting/idle + `needsAttentionAt`) is the same idea.
> What T3 adds that we want: **separating approvals from questions** (they need different UI — a
> yes/no chip vs a text answer with attachments), the **open-`requestId` fold** — a permission
> prompt is *a request with an id you must resolve*, not a screen state — and the two race fallbacks
> at `:98-115`.

### 9.2 Web + desktop delivery

All of it is one renderer component: `apps/web/src/components/ThreadNotificationCoordinator.tsx`
(~210 lines). Dedup key is `` `${turnId}:${status}` ``, firing only on change (`:114-132`);
completion dedups on a monotonically increasing `completedAt`. Suppression: a desktop `Notification`
is skipped when `visibilityState === "visible" && document.hasFocus()` (`:171-177`), in which case an
in-app toast appears, and only if the thread is not the one on screen (`:147-152`). Web notifications
are `silent: true` with `tag: env:thread` because sound is handled separately (`:179-183`). The badge
is a canvas-drawn favicon on web and an Electron overlay icon / `app.setBadgeCount` on desktop
(`apps/desktop/src/ipc/methods/notificationBadge.ts:20-42`), force-cleared on window focus (`:25`).

**There is no service worker and no Push API in `apps/web`, and no Electron native `Notification`.**
The app must be open.

### 9.3 Mobile = relay-only remote push

No local `scheduleNotificationAsync` anywhere; the only `expo-notifications` listener handles
deep-link navigation. The device registers its native APNs/FCM token **with the relay**, never with
the environment server (`apps/mobile/src/features/agent-awareness/remoteRegistration.ts:284`,
`:418-472`).

`apps/server/src/relay/AgentAwarenessRelay.ts` projects each thread into a `RelayAgentActivityState`
and POSTs it to exactly one endpoint —
`POST /v1/environments/:environmentId/threads/:threadId/agent-activity`
(`packages/contracts/src/relay.ts:1094`, handler `infra/relay/src/http/Api.ts:876-901`). Auth is two
layers: an opaque environment bearer credential **plus** a per-publish asymmetric proof signed with
the cloud-link private key and verified against the stored public key
(`AgentAwarenessRelay.ts:371`, `Api.ts:893`, replay/expiry `:912-925`). Publishing is gated on a
toggle and on link credentials existing (`AgentAwarenessRelay.ts:346-361`); only attention-bearing
activity kinds republish (`:73-93`).

**Yes, there is a push path to a disconnected device — and it lives entirely in the cloud.** The relay
stores thread state in `relay_agent_activity_rows` and fans out from `relay_environment_links` rows in
Postgres, not from a live socket (`AgentActivityPublisher.ts:146-169`). **Push tokens are held only by
the relay** (`relay_mobile_devices.push_token` / `push_to_start_token`,
`infra/relay/src/persistence/schema.ts:18-41`); the environment server never sees one. Late-arriving
devices get a silent replay (`AgentActivityPublisher.ts:112`) plus a cold-start
`GET /v1/mobile/agent-activity`.

**Relay-side debounce/dedup** (all of it worth reading before tuning Orquester's 30 s push debounce):
15 s minimum between Live Activity updates unless attention or terminality changed
(`ApnsDeliveries.ts:59`, `:162-195`); completions older than **2 min never alert**
(`agentActivityAlerts.ts:14`); alerts fire only on *observed* transitions against a stored
`last_aggregate_json` baseline (`:57-77`); more than one row coalesces to "N agents need attention"
(`:116`); max 5 rows ordered attention > failed > running > done (`agentActivityAggregate.ts:329`,
`agentActivityPayloads.ts:207`); per-job idempotency via a unique `sourceJobId` with a 10-min lease
(`DeliveryAttempts.ts:70`, `:139-219`); FCM `collapse_key: "t3-agent-activity"` plus a SHA-256
`alert_id` (`FcmClient.ts:135`, `FcmDeliveries.ts:103`). Row TTLs: running 2 h, waiting 24 h, finished
displayed 15 min.

**iOS Live Activities** are relay-driven: `relay_live_activities` holds the activity push token and a
baseline aggregate (`schema.ts:43-61`); cards are **started by the app in the foreground, never
remotely** (`ApnsDeliveries.ts:244`); the relay only updates and ends them with
`apns-push-type: liveactivity` (`ApnsClient.ts:241`).

### 9.4 Verdict — and the one place Orquester is already ahead

- **Thread phase machine + in-app attention surfacing: REQUIRED.** Cheap and it is what makes a
  multi-thread GUI usable.
- **Remote push, Live Activities, widgets: optional and, for us, structurally expensive.**
  `docs/user/mobile-notifications.md:11` is blunt: *"Background delivery requires T3 Connect; a direct
  or Tailscale connection alone does not enable push notifications."* Self-hosting it needs "its own
  initial Cloudflare stack, PostgreSQL database, Firebase project, and a Clerk instance" plus
  PlanetScale and Axiom credentials (`docs/operations/android-notifications.md:117`) **and a rebuilt
  mobile binary**, since APNs topics are bound to the maintainers' bundle ids.

> **Orquester's existing PWA + VAPID Web Push (`<appdir>/daemon/push.json`) already delivers to a
> disconnected device with zero third-party infrastructure.** On this axis we are ahead of T3, and we
> should not adopt their design. Their non-relay fallback is literally "the app must be open".

Two smaller gaps T3 has that we should deliberately *not* copy:

- Unread/attention state is **client-local and does not sync** (`apps/web/src/uiStateStore.ts:255-291`);
  viewing a thread on the laptop does not silence the phone, and they document that as intended
  (`docs/user/mobile-notifications.md:7`). Orquester's daemon already owns
  `SessionSummary.activity` server-side, so we can do better cheaply.
- The 5-minute usage throttle is a module-level `Map` per browser tab
  (`packages/client-runtime/src/state/usage.ts:12-13`) — not a server-side rate limit.

---

## 10. Footguns for a single-user VPS behind a reverse proxy with password auth

Ordered by how much they would actually hurt Orquester.

1. **`/mcp` is mounted OUTSIDE the environment auth stack.** `apps/server/src/mcp/McpHttpServer.ts:624-629`
   registers it on the main router with its own bearer middleware (`:84-114`), and
   `McpSessionRegistry.ts:71-75` says it plainly: *"`/mcp` is mounted outside the environment auth
   stack and is reachable on whatever host the server binds to, so this token is the only thing
   guarding the `t3-code` toolkits on a remote-reachable server."* Behind Caddy, `/mcp` would be
   publicly routable and guarded solely by a 32-byte token with a **24-hour** liveness window. If
   Orquester ever adds an MCP endpoint for agents, **it belongs on the unix socket** (like
   `/api/sessions/:id/agent-event` already is), or behind an explicit Caddy deny.
2. **Terminals and provider turns do not survive a restart.** §1.6 and §4.4. Orquester's tmux backing
   is a real advantage — do not regress it by moving PTYs in-process to match T3's model.
3. **Checkpoint ref bloat is unbounded.** Two refs per turn, never GC'd on thread delete
   (`ThreadDeletionReactor.ts:59-65`); `MAX_THREAD_CHECKPOINTS = 500` caps only the read model
   (`orchestration/projector.ts:60`). A year of threads leaves thousands of loose refs under
   `refs/t3/**`, each pinning a full tree that `git gc` cannot drop. **Prune on thread delete/archive
   from day one.**
4. **Checkpoint refs break fetch/push if not fsynced.** `GitVcsDriver.ts:757-766` — an unclean restart
   leaves 0-byte ref files that break every later fetch and push. If you write refs, write them with
   `-c core.fsync=objects,reference`.
5. **Never restore into a shared checkout.** `git restore --worktree --staged` + `git clean -fd` over
   a repo root deletes a concurrent session's untracked work. Copy `isRestoreWorkspaceIsolated`
   (`CheckpointReactor.ts:722-769`) verbatim, or gate restore on worktrees only.
6. **`add -A` per turn on a big repo** with `core.fsmonitor=false` forced (`GitVcsDriver.ts:771-775`)
   is a full worktree stat walk. T3 mitigates by cloning the live index and preserving its racy mtime
   (`:817-837`); a naive `git stash create` re-hashes everything.
7. **Worktree sprawl.** Cleanup policies default **off**, a full install runs per worktree, and
   `node_modules/` is the only ignored path cleanup tolerates — a stray `.env` or local SQLite
   permanently blocks automatic removal (`storageCleanup.ts:229-239`). On a single-disk VPS this fills
   up quietly.
8. **Process-pool wedging.** 8 global VCS permits (`VcsProcess.ts:60`), and `push`/`pull` run with
   `timeoutMs: null` (`GitVcsDriverCore.ts:2223`). One hung SSH push holds a permit forever; eight
   wedge the entire git surface. **Give every git op a timeout.**
9. **`isRemoteReachableHost` misreads a reverse-proxy deployment.** `apps/server/src/auth/utils.ts:66-80`
   classifies `127.0.0.1` as local, so a daemon bound to loopback behind Caddy believes it is
   loopback-only (`EnvironmentAuthPolicy.ts:23-30`). In T3 the consequence is cosmetic plus a
   different **cookie-name derivation** (instance-keyed on `stateDir`+port instead of environment id,
   `utils.ts:37-53`) — meaning a port or state-dir change silently invalidates every browser session.
   Any "am I remote?" inference must come from configuration, not the bind address. There is also **no
   `X-Forwarded-For` / trust-proxy handling anywhere** in `apps/server/src/config.ts`; Orquester's
   `LoginThrottle` keying on the rightmost XFF hop is the correct pattern and T3 has no equivalent
   because it has no password.
10. **Session cookies are set without `Secure`** (`apps/server/src/auth/http.ts:179-184`, `:277-283`) —
    a deliberate concession to plain-HTTP LAN endpoints, and wrong behind a TLS proxy. Orquester uses
    a `localStorage` bearer, not a cookie, so this is a "don't copy" rather than a "fix".
11. **Requiring `gh` on the host.** GitHub has no HTTP fallback in T3 (`GitHubCli.ts:408`); every PR
    read spawns a process. Orquester already holds GitHub PATs in `AccountsService` — prefer the
    REST/GraphQL path we own over adding a binary dependency under `ProtectSystem=strict`.
12. **The workspace lease is process-local only** (`workspace/workspaceLease.ts:6-23`). Two daemons
    sharing an appdir share `worktrees/` with no cross-process lock — directly relevant given the
    "second daemon collides with the live one" hazard already in our `AGENTS.md`.
13. **Outbound egress on a 5-minute loop forever.** Provider/hub probes hit `chatgpt.com`,
    `api.anthropic.com`, `api2.cursor.sh`, `cli-chat-proxy.grok.com`; LiteLLM pricing hits
    `raw.githubusercontent.com` (`UsageService.ts:66`, 10 s timeout). A laptop sleeps; a VPS does not.
    Copy the three-tier `fresh|cached|unavailable` status so a blocked egress degrades instead of
    breaking the page.
14. **A hub management key is a full account-impersonation credential.** `api-call` issues *arbitrary*
    upstream requests with `$TOKEN$` substituted (`cliproxyApi.ts:154-172`). It belongs in the same
    class as `PUT /api/config/daemon`: never returned by the API, redacted with a
    keep-what-you-have marker (`serverSettings.ts:147`), mutations refused over remote HTTP — exactly
    how Orquester already handles `/api/cliproxy/providers/*`.
15. **`preview_evaluate` runs arbitrary JS in a tab that may hold the user's imported browser
    cookies** (`preview/tools.ts:200-209`, cookie import via `native/browser-secret`). If Orquester
    ever exposes browser automation to an agent, scope it to the server-side Chromium profile and
    never to a profile seeded from the user's real browser.
16. **Uncapped in-memory scrollback.** T3 caps at 8 MiB × N terminals in-process
    (`Manager.ts:93-94`) with 128 retained idle sessions (`:100`). Orquester's tmux keeps scrollback
    out of the daemon's heap — another reason to keep tmux — but the client-side 512 KiB cap
    (`packages/client-runtime/src/state/terminalOutput.ts:45`) is worth matching.

---

## 11. Concrete recommendations for Orquester

**Adopt (high value, low cost):**

1. **The per-RPC scope table.** `apps/server/src/auth/RpcAuthorization.ts:23-171`, typed
   `satisfies Record<Method, Scope>` so a new route without a scope is a compile error. A
   `terminal:operate` scope separate from `orchestration:read` is immediately useful for a
   phone/read-only client.
2. **The terminal output credit window.** `apps/server/src/terminal/OutputProtocol.ts:71-132` — ~60
   lines, drops straight into `WsSessionChannel`. Our `/ws` currently has no backpressure at all.
3. **Server-computed terminal `label` + `hasRunningSubprocess`.**
   `apps/server/src/terminal/Manager.ts:690-714` with exponential backoff (`:648-653`). Feeds tab
   titles and the Attention Center with one `ps` call.
4. **A `wsTicket` instead of `?token=` on `/ws`** (`docs/internals/environment-auth.md:27-29`). Keeps
   the long-lived credential out of socket URLs and intermediary access logs; the same mechanism
   covers `<img>`-style routes where headers are impossible.
5. **Per-turn checkpoint + diff summary.** The GUI-legibility win, obtainable with a `commit-tree`
   into a temp index (`GitVcsDriver.ts:776-837`) and **no** restore machinery. Prune refs on thread
   delete, unlike T3.
6. **The two-boolean attention model** (`hasPendingApprovals` / `hasPendingUserInput`) with the race
   fallbacks at `packages/shared/src/agentAwareness.ts:98-115`.
7. **`PortScanner`** (`apps/server/src/preview/PortScanner.ts`) — refcounted `lsof` polling with an
   HTML probe and PID→terminal attribution. Turns "the agent started a dev server" into a card.
8. **The CLIProxyAPI `/v0/management` usage read** (`apps/server/src/usage/cliproxyApi.ts`), pointed
   at our own supervised proxy.
9. **A version/build id on the daemon's hello event**, so a client can tell "restarted with my
   change" from "restarted and rolled back" (`docs/internals/server-updates.md:44-49`).

**Do not adopt:**

- In-process PTYs (we have tmux, which is strictly better).
- libghostty-vt / dropping xterm.js (buys nothing without a native mobile client).
- The relay-based push architecture (our PWA + VAPID already beats it for a self-hoster).
- Client-side browser automation as the preview host (our server-side Chromium is the right shape for
  a VPS).
- A publicly routable `/mcp`.
