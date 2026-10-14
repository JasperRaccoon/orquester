# Agent visuals, session tools, and thread lineage — design

Status: binding for the plan `docs/superpowers/plans/2026-10-14-agent-visuals-and-session-tools.md`.

Reference implementation: T3 Code (MIT), a local checkout at `.t3code/` (git-excluded; HEAD
`737192594`). Orquester's agent chat was ported from it, so its shapes map closely. Port ideas and
code freely, adapted to Orquester's boundaries; keep an MIT attribution comment where a file is a
substantial port (as existing ported files do). Section "Reference map" at the end lists the T3 and
Orquester files each part starts from.

## Goals

1. **Session tools.** Every agent-chat agent (Claude, Codex, Grok, OpenCode) gets an MCP server named
   `orquester`, scoped to its own thread, whose tools act through the daemon.
2. **Visual replies.** `html_render` / `html_preview`: an agent publishes a self-contained HTML page
   that renders inline in its thread, sandboxed, themed with the user's live theme.
3. **MCP Apps.** Tool calls of third-party MCP servers that declare an MCP Apps UI resource render and
   run inline, on every provider whose protocol exposes the resource.
4. **Mermaid and math** in chat markdown.
5. **Orchestration tools.** Delegate tasks, operate other threads, schedule prompts, ask the user for
   a secret, watch a pull request.
6. **Thread lineage.** Fork a thread from a message, merge a fork's result back, show parent/child
   relationships.

## Global rules (apply to every part)

- Follow `AGENTS.md` in full. In particular: transport changes go in `packages/api` contracts first;
  persisted-data validation in `packages/config`; domain-event schema changes are additive optional
  fields only (older builds must decode new logs and new builds old logs); agent-host protocol changes
  stay compatible with daemon handovers (`AGENT_HOST_PROTOCOL_VERSION` semantics); no dynamic
  `import()` under `apps/daemon/src/agent-host`; MCP/workflow tools go through `DaemonApi`; secrets
  never in API responses, logs, process arguments, or `events.ndjson`.
- Credentials (session-tool tokens, bearer headers) never appear in argv, logs, stderr captures, or
  persisted files. Pass them over protocol frames, provider HTTP APIs, or child env only.
- Every feature works on desktop (Electron, unix-socket transport) and web (remote HTTP, behind the
  production Caddy CSP in `deploy/Caddyfile`). Shared UI lives in `packages/ui`.
- Provider-specific handling stays inside its adapter and normalizes into shared runtime events.
- Tests accompany every behavior, parsing, persistence, and protocol change. No sleep-based timing.
- Gate before every commit: `pnpm check`; before reporting: `pnpm test` (or the touched packages'
  tests plus `pnpm check` when the full suite's unrelated flakes are documented in the report).

## 1. Session tools framework

### 1.1 Shape

- MCP server name: `orquester`. Provider-visible names follow each harness (`mcp__orquester__x` for
  Claude, `orquester.x`/`orquester__x` elsewhere); tool descriptions and instructions refer to bare
  names and say a harness prefix may apply.
- **Definitions** (name, description, input schema (zod), annotations: `readOnlyHint`,
  `destructiveHint`, `idempotentHint`; result kind text/json/image) live in one statically imported
  module tree `apps/daemon/src/session-tools/` — one directory per toolkit plus an `index.ts` that
  lists toolkits. Adding a toolkit = a new directory + one line in `index.ts`. Both the agent host
  (to advertise) and the daemon (to execute) import it statically.
- **Handlers** run in the daemon, behind `DaemonApi` (the same in-process API the external `/mcp`
  server uses, `apps/daemon/src/mcp/daemon-api.ts`), with a `SessionToolContext`
  `{ threadId, projectRef/cwd, agentId (provider), callId, signal }` that the daemon derives from the
  authenticated caller — never from tool arguments.
- **Execution path:** provider → agent host (thread already known, see 1.2) → daemon over the
  daemon's trusted unix socket, on a **socket-only** route (never mounted on remote HTTP) → handler →
  `CallToolResult` back. If the daemon is unreachable the tool returns an MCP error result
  (`isError: true`, text "Orquester is restarting; retry in a few seconds."), never a crash or hang.
  Long-running handlers (waits) honour cancellation when the provider cancels the call or the turn
  is interrupted.

### 1.2 Per-provider transport (thread identity must be unforgeable)

- **Claude:** in-process SDK server in `adapters/claude/launch.ts`, bound to the thread at launch:
  the host's own `orquester` MCP server instance passed as `mcpServers.orquester = {type: "sdk",
  name, instance}` (the config shape `createSdkMcpServer` returns, without `tool()`'s zod parse), so
  the arguments reach the daemon raw and the daemon is the one validator. No network, no token. The
  `mcpServers: {}` comment there changes accordingly. User `.mcp.json`/user-scope servers keep
  loading as today.
- **Codex, Grok, OpenCode:** the agent host serves an MCP Streamable-HTTP endpoint on
  `127.0.0.1:<ephemeral port>` (one listener per host process). Each provider session gets a fresh
  random credential (≥32 bytes, base64url); the host keeps only its SHA-256 → `{threadId, launchId}`
  and revokes it when that session ends or relaunches. A request with an unknown/revoked credential
  gets 401. The credential reaches the provider only through its protocol/API/env:
  - Codex: thread config `mcp_servers.orquester` over app-server JSON-RPC (`thread/start` /
    `thread/resume` `config`), with `http_headers` or `bearer_token_env_var` + child env.
  - Grok: ACP `session/new` / `session/load` `mcpServers` entry (HTTP with headers if the CLI
    supports it; otherwise a stdio bridge the host ships, reading endpoint + credential from env).
  - OpenCode: the project's server is shared between that project's threads. Thread A must never be
    able to call tools as thread B. Choose and document the mechanism (per-thread MCP registration
    plus per-prompt tool enablement, or per-thread servers per the agent-chat spec's own note).
- Verify each provider's real behaviour against its generated bindings / fixtures / the installed
  CLI's `--help`; record the evidence in the plan's report.

### 1.3 Approvals

Session tools never raise an approval card: they are pre-approved in every permission mode (Claude
`allowedTools`/`canUseTool` short-circuit, Codex/Grok/OpenCode equivalents). Interactive consent, where
a feature needs it (secrets), is the tool's own UI.

### 1.4 Instructions

Each provider gets one short "Orquester" instruction block through its native, non-user-visible
channel (Claude: `CLAUDE_RUNTIME_INSTRUCTIONS` append; OpenCode: the per-turn `system` addendum;
Codex: a channel that does not replace the upstream prompt — `developer_instructions` stays `null`
unless an additive channel exists; Grok: whatever additive channel exists, else rely on tool
descriptions). Injected text never appears in a rendered user bubble, the prompt history, search
index, or a resumed history projection. The block is composed from per-toolkit snippets (a toolkit
may contribute one paragraph), kept under ~1.5 KB total. Tool descriptions carry the full guidance.

### 1.5 Timeline presentation

Session-tool calls are ordinary `mcp_tool_call` items. `slim.ts` keeps every `orquester` tool's
structured reference fields that the UI needs (e.g. `htmlRender`), so the UI never fetches the full
item to render them. Known tools get a readable label (`presentation.logic.ts`), never the raw JSON.

## 2. Visual replies

### 2.1 Tools (port of T3 `apps/server/src/mcp/toolkits/html`)

- `html_preview(html: string 1..512000, width?: int 240..1600 = 728, appearance?: "dark"|"light")`
  → PNG screenshot (MCP image content) + `{ width, contentHeight, capturedHeight, consoleMessages[] }`.
  Rendered in the daemon's existing headless Chromium infrastructure (browser tab service), in an
  isolated context, with local/private network destinations blocked, a hard timeout, and the same
  theme bootstrap as published pages (stock palette for the requested appearance). Read-only.
- `html_render(html, title: 1..200, height: int 80..2000)` → publishes the page and returns
  `{ htmlRender: { attachmentId, title, height, heights?: [width, height][] }, message }`.
  Message: "Shown to the reader above your reply. Don't mention or describe the page; reply with only
  what it doesn't already say."
- Descriptions: adapt T3's `PAGE_RULES`, layout guide and theme guide verbatim in substance, with
  Orquester's widths and the token list in 2.3. Local absolute image paths are inlined (≤10 MiB per
  image, ≤25 MiB per page, inside the thread's project sandbox after realpath); remote URLs load as-is.
- Instructions snippet ("Showing visuals"): build a self-contained page, check with `html_preview`,
  publish with `html_render` before the final reply, don't restate it.

### 2.2 Storage and serving

- The published page (bootstrap injected at publish time) is a thread attachment with extension
  `html`. The reference lives only in the tool result. Heights are measured at publish in headless
  Chromium at widths 320…1144 (as T3); missing browser → publish without heights.
- The attachment sweep must treat an attachment referenced by any `htmlRender` reference anywhere in
  the thread's log as live, regardless of the fold's activity retention window. Thread deletion
  deletes them.
- Serving route: an authenticated daemon route returns the page with
  `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Type: text/html`.
  Because an iframe cannot send an Authorization header, the client obtains a short-lived signed URL
  (HMAC with a daemon-held key, bound to session + attachment + expiry, ≤15 min) and the frame keeps
  its first URL for its life, re-minting only on a new mount when <5 min remain. Production Caddy
  needs a carve-out for this path (`frame-ancestors 'self'`, no `X-Frame-Options: DENY`) — edit
  `deploy/Caddyfile` and note in `deploy/README.md` that the live Caddyfile must be reconciled.
- Desktop (unix-socket transport, `file://` renderer): serve the page through a privileged custom
  protocol (or equivalent) that sets the same sandbox CSP response header, so the page still gets an
  opaque origin and no access to the preload bridge. Add `setWindowOpenHandler` /
  `will-navigate` guards if absent, so a frame cannot open windows or navigate the app.

### 2.3 Theme tokens

The page receives T3's token names, mapped from Orquester's live theme (scheme + resolved mode),
as hex (`#rrggbb` / `#rrggbbaa`):
`--background --foreground --muted --muted-foreground --card --card-foreground --popover
--popover-foreground --secondary --secondary-foreground --border --input --ring --primary
--primary-foreground --accent --accent-foreground --accent-surface --accent-surface-foreground
--destructive --destructive-foreground --destructive-surface --warning --warning-foreground
--warning-surface --success --success-foreground --info --info-foreground --code-background
--code-foreground --chart-1 … --chart-6 --radius --font-sans --font-mono`.
Map from `--n-*`, `--sem-*`, `--lane-*` and the font stack; `--background` equals the thread
surface behind the frame. One exporter function beside `tripleToHex` in `packages/ui/src/lib/theme.ts`;
a test covers every scheme × mode and asserts valid hex for every token.

### 2.4 Frame and bridge (port of T3 `HtmlRenderFrame`, `BrowserDocumentFrame`, `htmlRender.ts`)

- `<iframe sandbox="allow-scripts allow-forms">` — never `allow-same-origin`, never `srcdoc` with
  the app's origin.
- Theme before first paint via `#orq-theme=<json>` fragment read by the injected bootstrap; live
  changes via JSON-RPC `ui/notifications/host-context-changed` (MCP Apps method names); validated
  keys `^--[a-z0-9-]+$`, values stripped of `;{}<>`.
- Page → host: `ui/notifications/size-changed` (frame fits content; clamp 80..2000; agent `height`
  caps only when smaller than the page at the reference width), `ui/open-link` (http(s) only, only
  while the frame is focused and with user activation; opens through Orquester's normal link
  handling), forwarded keydowns for an allow-list of app shortcuts (command palette, attention
  cycle, scroll-to-end, Escape to close the viewer). Every listener checks
  `event.source === iframe.contentWindow`.
- No white flash (colour-scheme switch after load), no scroll trapping (hidden scrollbar + exact
  fit), transparent page background guidance, Escape/close button for the viewer.
- Full-screen viewer in the chat's modal with zoom 50–200% in 25% steps.

### 2.5 Timeline row

A new row kind `visual` (in `contracts.ts`, `rows.logic.ts`, `TimelineRow.tsx`, `isRowUnchanged`),
emitted in place of the `html_render` tool row, never folded into a collapsed tool group or turn
fold, stable key = attachment id. A failed `html_render` call stays an ordinary failed tool row.

## 3. MCP Apps

- Spec: MCP Apps (ext-apps, MIME `text/html;profile=mcp-app`, `ui://` resources, `_meta.ui`
  `{resourceUri, csp, permissions, prefersBorder, visibility}`), as T3 `packages/shared/src/mcpApp.ts`
  and `packages/client-runtime/src/mcpApps/host.ts` implement it.
- For each provider, find whether its protocol exposes the UI resource for a third-party MCP tool
  call (Codex app-server: `mcpAppResourceUri` / `McpToolCallResult._meta`; Claude SDK, Grok ACP,
  OpenCode: check their real frames/fixtures). Where exposed: snapshot the resource (≤5 MiB) as an
  `html` attachment with a CSP built from declared domains (`default-src 'none'`, never `'self'`),
  reference it from the tool row (`mcpApp` reference, own server+tool only), and render it in the
  same frame infrastructure with the full host bridge (`ui/initialize`, `tools/call` and
  `resources/read` proxied through the live provider session with user consent for non-read-only
  tools, `ui/message` with consent, `ui/open-link`, `ui/request-display-mode`, size, teardown,
  `ui/update-model-context` delivered on the next turn if the provider supports an additive context
  channel). Where not exposed, document the evidence in the spec appendix; the call renders as an
  ordinary tool row.

## 4. Mermaid and math

- Fenced ` ```mermaid ` blocks render as SVG diagrams in chat markdown (port T3 `MermaidDiagram.tsx`):
  lazy `import("mermaid")` (allowed in `packages/ui`), render only once the message stops streaming,
  serialized render queue, LRU cache keyed by theme+source, `securityLevel: "strict"`,
  `htmlLabels: false`, `secure` list, DOMPurify second pass, code/diagram toggle, error boundary
  falling back to the highlighted source, expand into the existing viewer. Theme follows resolved
  mode. Must work under the production CSP (`script-src 'self' 'wasm-unsafe-eval'`) and on desktop.
- Math: `$…$` inline and `$$…$$` display with `remark-math` + KaTeX (`rehype-katex` or KaTeX
  render), with KaTeX CSS and fonts bundled (no CDN), `trust: false`, `strict: "ignore"`, not
  triggered by ordinary currency text (`singleDollarTextMath` decision documented and tested).

## 5. Orchestration tools

All operate within the calling thread's **project**. Names (bare):

- Threads: `thread_list`, `thread_read`, `thread_create` (new chat thread in the project with
  agent/model/prompt), `thread_send`, `thread_wait` (until idle / needs input / timeout, cancellable),
  `thread_interrupt`.
- Delegation: `delegate_task(prompt, agent?, model?, title?)` creates a child thread (lineage
  `relation: "delegate"`, parent = caller), starts it, returns `taskId` (= child thread id);
  `task_status(taskId)`, `task_wait(taskId, timeoutSeconds)`, `task_cancel(taskId)`. A finished
  delegate's final answer is returned by `task_status/task_wait`.
- Scheduling: `schedule_task(prompt, at | cron, threadId? = caller)`, `list_scheduled_tasks`,
  `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`. Persisted in the
  daemon (schema in `packages/config`, tolerant store), survives restarts, delivers by sending the
  prompt to the thread (queued if busy), shown in the UI per thread with cancel. Reuse the workflow
  engine's scheduler/timer primitives if they fit; do not duplicate a cron parser.
- Secrets: `request_secret(name, prompt, purpose?)` shows a private card in the thread; the user
  types the value (or cancels). The value is never written to `events.ndjson`, logs, or any API
  response other than the tool's result to the requesting agent; the card's persisted record keeps
  name/purpose/outcome only. Port T3's design (`SecretRequestCard`, `request_secret`) and document
  where the value goes.
- PR watch: `watch_pull_request(url | number)`, `unwatch_pull_request`, `list_pull_request_watches`.
  Persisted watches poll the PR through Orquester's existing git-host providers (GitHub, Bitbucket);
  on a change in checks, reviews/comments, mergeability/conflicts, or state, the daemon sends the
  thread a concise system-authored message (queued if busy) describing the change; watches end on
  merge/close/unwatch; UI shows the thread's active watches with stop.
- External `/mcp` parity: expose fork/merge (and delegate where meaningful) to external agents too,
  following the existing MCP tool conventions.

## 6. Thread lineage

- Data: thread metadata gains optional `lineage: { parentThreadId, relation: "fork" | "delegate",
  forkedFrom?: { messageId, turnId } , createdAt }` (additive, tolerant). Children are derivable from
  parents (index or scan); expose `children` via the API.
- **Fork** from any settled user or assistant message: new chat session (tab) in the same project
  with the same agent/model/options, whose conversation is the parent's up to that message. Use the
  provider's native fork where it exists (Claude SDK `forkSession`/resume-at, Codex `thread/fork`,
  OpenCode session fork, Grok ACP fork if supported); otherwise start a fresh provider session
  seeded with a faithful transcript handoff. The fork's timeline shows the inherited history (or a
  clear "forked from" divider) and the parent is unchanged.
- **Merge back**: from a fork (button, MCP tool `thread_merge_back`), send the parent a message that
  carries the fork's result (its final assistant reply, or a user-edited summary), marked as coming
  from the fork; queued if the parent is busy.
- UI: "Fork from here" on message hover actions; a lineage breadcrumb/header chip in a child
  ("Forked from <title>" / "Delegated by <title>", click opens parent); a children list on the parent
  (status, open); sidebar shows the relation. Tabs open in the parent's project.
- Session-tool `thread_fork(messageId?)` (default: latest settled message) and `thread_merge_back`.

## Reference map

T3 (`.t3code/`):
- Tools: `apps/server/src/mcp/toolkits/html/{tools,handlers}.ts`, `toolkits/*` (orchestrator,
  thread, secrets, pull requests), `apps/server/src/mcp/{McpHttpServer,McpSessionRegistry,McpToolAccess}.ts`.
- Instructions: `packages/provider-core/src/server/orchestrationInstructions.ts`.
- Provider wiring: `ClaudeAdapterV2.ts` (~1160-1250, 738-797), `CodexAdapterV2.ts` (~1327-1355,
  227-233, 480-483, 3842), `CodexDeveloperInstructions.ts`, `packages/provider-opencode/src/server/`,
  `packages/provider-acp/src/server/adapter.ts` (~683-720).
- Publish/serve: `apps/server/src/htmlRender/HtmlRender.ts`, `publicProxy.ts`, `apps/server/src/http.ts`.
- Page bootstrap + tokens + bridge: `packages/shared/src/htmlRender.ts`, `packages/shared/src/mcpApp.ts`,
  `packages/shared/src/toolOutput.ts`.
- Web: `apps/web/src/components/chat/{HtmlRenderFrame,HtmlRenderDialog,McpAppFrame,MermaidDiagram,SecretRequestCard,ThreadRelationshipsControl}.tsx`,
  `files/BrowserDocumentFrame.tsx`, `hooks/useHtmlRenderTheme.ts`, `apps/desktop/src/window/{DesktopWindow,ContextMenuImage}.ts`.
- MCP Apps host: `packages/client-runtime/src/mcpApps/host.ts`, `apps/server/src/mcpApps/*`.

Orquester:
- Agent host map: `apps/daemon/src/agent-host/README.md`; protocol `host-protocol.ts`; env
  `support/env.ts` (`ORQUESTER_SESSION_ID`); adapters `adapters/{claude,codex,grok,opencode}/`.
- Claude launch: `adapters/claude/launch.ts` (systemPrompt append ~139, `mcpServers: {}` ~175;
  SDK serialises `mcpServers` into argv except in-process `type:"sdk"` servers).
- Codex: `adapters/codex/session.ts` (spawn ~420, `thread/start` ~1468, `item/tool/call` refusal
  ~1891), `modes.ts` (developer_instructions null ~120), `_generated/` bindings, `items.ts`
  (`mcpToolCall` mapping drops `result`/`mcpAppResourceUri`).
- Grok: `adapters/grok/session.ts` (`mcpServers: []` ~607/631), `launch.ts` overlay.
- OpenCode: `adapters/opencode/server.ts` (shared per-project server), `session.ts` (system addendum ~192, ~1885).
- Events: `packages/api/src/agent-chat/{runtime-events,domain-events,thread,slim,wire}.ts`;
  ingestion `agent-host/ingestion/activities.ts`; Claude MCP classification `claude/classify.ts`,
  `claude/normalize.ts` (~2023).
- Attachments: `agent-host/store/attachments.ts`, `store/index.ts` (save ~1395, sweep ~192/1483,
  reference scan ~873); fold retention `fold.ts` (`ACTIVITY_RETENTION_LIMIT` 500, compaction exemption ~270).
- External MCP: `apps/daemon/src/mcp/{server,tool,daemon-api,attachments}.ts`, `docs/orquester-mcp.md`.
- UI pipeline: `packages/ui/src/lib/agent-chat/{entries.logic,rows.logic,contracts,presentation.logic}.ts`,
  `components/agent-chat/timeline/{TimelineRow,context}.tsx`, `rows/{ActivityRows,MessageRows,StructureRows}.tsx`,
  `markdown/{ChatMarkdown,CodeBlock}.tsx`, `AgentChatView.tsx` (modal viewer ~1130), banners
  (`QuestionCard.tsx`, `ChatBannerDock.tsx`), `files/viewers/HtmlViewer.tsx`.
- Theme: `packages/ui/src/lib/theme.ts` (`tripleToHex` ~107), `styles/globals.css`, `tailwind-preset.ts`.
- Keyboard: `attention/GlobalShortcutListener.tsx`, `AgentChatView.tsx` Escape ~592,
  `ChatTimeline.tsx` Ctrl+J ~759, `lib/session-nav.ts`, `lib/keyboard-surfaces.ts`.
- CSP/serving: `deploy/Caddyfile` (~31, ~42), `apps/daemon/src/index.ts` (static ~4393, auth hook
  ~1367, `/mcp` mount ~4361), `apps/desktop/src/main.ts` (~642), `apps/desktop/preload.cjs`.
- Workflows/git providers: `apps/daemon/src/workflows/**` (triggers, `git-poller.ts`),
  `apps/daemon/src/providers/*`.

## Appendix A — MCP Apps per provider (§3, Task 10 evidence)

Probed 2026-10-14 on this host, each CLI against a stub stdio MCP server that declares the UI
extension, lists one tool with `_meta.ui {resourceUri: "ui://…", visibility}`, serves the resource as
`text/html;profile=mcp-app` (with `_meta.ui.csp`/`prefersBorder`) and logs every frame it receives.
Throwaway HOME / CONFIG dirs, no daemon, no Orquester session. Only Grok needed a model turn (two
one-call prompts on the Grok account, about $0.03 by the CLI's own usage report) because only it exposes the URI on a live call; the live Codex check below ran two tiny turns.

| Provider (version) | Declares UI extension to servers | URI of a call's UI resource reaches the client | Host can read the resource | Host can call the server's tools | Additive context channel | Result |
|---|---|---|---|---|---|---|
| Codex app-server (bindings 0.154.0; probed 0.159.0) | only when the app-server client declares `capabilities.extensions["io.modelcontextprotocol/ui"]` (stub saw it with, not without) | `mcpToolCall.appContext.resourceUri` / deprecated `mcpAppResourceUri` (bindings `v2/ThreadItem.ts`) | `mcpServer/resource/read {threadId, server, uri}` → `{contents}` (`_meta` intact) | `mcpServer/tool/call` → `{content, structuredContent, _meta}`; `mcpServerStatus/list` lists tools with `_meta` and `annotations` | `turn/start.additionalContext` (`kind: "untrusted"`) | **Supported** |
| Grok CLI 1.0.46 (`grok agent stdio`) | always (client name `grok-shell-apps`), whatever the ACP client declares (six variants probed) | the completed `use_tool` `tool_call_update` carries the TOOL definition's `_meta` (`ui.resourceUri`, `ui.visibility`) and `rawOutput {type:"MCP", server_name, tool_name, output:{OkayOutput}}` — same with or without a client declaration | `_x.ai/mcp/read_resource {sessionId, server, uri}` → `{result:{contents}}` | `_x.ai/mcp/call {sessionId, server, tool, arguments}` → `{result:{content}}` (no `structuredContent`/`_meta`); `_x.ai/mcp/list {sessionId}` lists tools with `_meta`, no `annotations`. Bare `x.ai/mcp/*` spellings answer -32601 | none (ACP `session/prompt` takes content blocks only, which would read as the user's words) | **Supported**, no model context; every app tool call asks consent (no read-only hint) |
| Claude Code 2.1.210 (installed) and 2.1.278 (SDK-bundled) | no: client capabilities `{roots, elicitation}` only | no: `mcpServerStatus()` tools carry `name` + `annotations` only; the CLI binary holds no `resourceUri`/`ui://` string; `tool_use_result` spreads the RESULT's `_meta`/`structuredContent` (`mcpMeta`), not the tool definition's | no: `mcp_read_resource`/`read_mcp_resource`/`mcp_resource_read` control requests answer "Unsupported control request subtype"; resources are read only by the model's `ReadMcpResource` tool | yes, `mcp_call` control request (not exposed by `Query`) | n/a | **Not exposed** — ordinary tool row |
| OpenCode 1.18.34 (`opencode serve`) | no: client capabilities `{roots}` only | no: a tool part keeps `metadata`, `output` (text), `attachments`, `content`; the result's `_meta` and the tool definition's `_meta` are never surfaced | no HTTP route: MCP routes are `/mcp` status/add/auth/connect/disconnect; `/experimental/resource` lists resources, nothing reads one for the client | no HTTP route | n/a | **Not exposed** — ordinary tool row |

Reading the resource from the daemon itself for Claude/OpenCode was considered and rejected: neither
exposes the URI of a call's UI resource in the first place, and connecting to the user's MCP servers
from the daemon would duplicate their stdio processes and credentials (OAuth tokens live in each
CLI's own store).

What runs where (as built): the exposing adapter captures the resource behind a frame hold
(`adapters/mcp-app-capture.ts`, ≤ 15 s, then the call stays a plain row) and writes
`data.mcpApp {attachmentId, server, tool, resourceUri, csp?, permissions?, prefersBorder?}` on the
completed tool row; `slim.ts` keeps it after the own-server+tool check; the UI renders an `mcp-app`
row (`McpAppFrame`) from the agent-visuals signed URL, with the bridge in
`packages/ui/src/lib/agent-chat/mcp-app-host.ts`; `tools/call`, `resources/read`,
`ui/update-model-context` go `POST /api/sessions/:id/mcp-apps/:itemId/:op` → host
`/threads/:id/mcp-apps/:op` → the live provider session. Consent (a tool not marked read-only,
`ui/message`, `ui/download-file`) is asked in the chat's banner dock.

Live Codex check (fix round 1; codex-cli 0.159.0, a scratch `CODEX_HOME` with only a managed
account's auth file, two tiny turns; fixture `apps/daemon/test/fixtures/codex/16-mcp-app-live.ndjson`,
README observation 25): the call completes with `mcpAppResourceUri` (and `appContext: null`);
`mcpServer/resource/read` with `originCallId` answers the document; a host-initiated
`mcpServer/tool/call` emits no `item/*` notification, so an app's own calls never add tool or app
rows; and the `untrusted` `additionalContext` value appears in no live notification, no
`thread/read` item and no `thread/turns/list` item — never as a user message.

Hardening (fix round 1): declared domains drop loopback, link-local and private hosts,
`.localhost`/`.local` names and bare-TLD wildcards (`*.com`); a client refuses to frame an app whose
domains reach its own origin or the daemon's (`mcpAppCspReachesOrigin`). Grok's capture read is
bounded by the capture's own 15 s deadline. A session reuses an app's snapshot for 5 minutes without
reading (and so without pausing its stream), as each call's own reference — its server, tool and
URI, since two tools may share one resource; past that, an unchanged document (same thread,
server, URI and SHA-256) reuses its stored attachment instead of storing another copy. A server's tool
listing is cached 30 s per session (dropped on Codex's `mcpServer/startupStatus/updated` and Grok's
`tools_changed` / `servers_updated` / `server_status`). The captured document reports its own
`pagehide` (`orq/notifications/document-unloaded`, from the first listener the bootstrap installs,
to the parent it read at install — never a later `window.parent` — and not for a page the
back-forward cache keeps);
the client stops the bridge on it, ahead of anything a page it navigated to could post, and still
on the frame's second `load`; the row then shows "left its page" in place of the frame. Residual:
an app that never reaches its `pagehide` listener (a crash of the document) is caught only by that
second `load`.

Known limits: Grok replays a call's result to its app as text only (its CLI folds
`structuredContent` into `OkayOutput`); a collab child's (Codex) or subagent's (Grok) app call stays a
plain row; app model context lives in the host's memory (a host restart forgets it until the app
updates it again); on the web, the production `Permissions-Policy` (`camera=(), microphone=(),
geolocation=()`) keeps an app's declared camera/microphone/geolocation off whatever the frame's
`allow` attribute says.
