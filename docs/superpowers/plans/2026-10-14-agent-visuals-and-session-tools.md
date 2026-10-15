# Agent visuals, session tools, and thread lineage — plan

Spec (binding authority): `docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md`.
Read the spec's "Global rules" and the section(s) your task names before starting; the spec's
"Reference map" lists the files to start from. T3 Code reference checkout: `.t3code/` in the main
checkout (`/var/lib/orquester/workspaces/jaspersito/orquester/.t3code`, HEAD `737192594`).

## Global constraints

- Integration branch `feat/agent-visuals`. Each task runs on its own branch in its own git worktree
  (given in the dispatch), branched from the integration branch at dispatch time. Commit on your
  task branch as you progress (small, conventional-commit subjects in the repo's style:
  `feat(scope): …`, `fix(scope): …`). Never commit to `main` or `feat/agent-visuals`; never push.
- Run `pnpm install --frozen-lockfile --prefer-offline` in your worktree first. If you add a
  dependency, use `pnpm add` in the right package and commit the lockfile.
- Never run `pnpm dev*`, the daemon, the daemon CLI, or `systemctl`; never bind the live daemon's
  port/socket; never touch `/etc/caddy`. Use tests, typechecks, and isolated test harnesses only.
- `pnpm check` must pass before every commit. Run the touched packages' tests while iterating and
  `pnpm test` once before reporting; report any failure verbatim and whether it reproduces on the
  integration branch base (pre-existing) or is yours.
- Follow AGENTS.md (in the repo root) in full; the spec's Global rules restate the critical ones.
- Unknown provider behaviour is verified, not assumed: generated bindings, fixtures under
  `apps/daemon/test/fixtures/**`, the installed CLIs' `--help`/schema output, SDK `.d.ts`. Cite the
  evidence in your report.
- Keep `docs/` accurate: update `docs/orquester-mcp.md`, the agent-host README module map, and the
  spec's appendix where your task changes what they describe.
- MIT attribution: a file that substantially ports T3 code carries a short header comment saying so,
  matching existing ported files in `packages/ui`.

## Wave 1 (parallel)

### Task 1: Session tools framework

Spec §1 in full. Deliver:
- `apps/daemon/src/session-tools/` (definitions registry, toolkit index, `SessionToolContext`,
  instruction-snippet composition, result helpers incl. image content) — the contract later tasks
  build on. Document the contract in a short `apps/daemon/src/session-tools/README.md`: how to add a
  toolkit (definition, handler, instruction snippet, presentation label), with an example.
- Daemon side: socket-only route that executes a call for an authenticated host request, with
  context derived server-side; handlers via `DaemonApi`; cancellation; error mapping.
- Agent host side: the thread-scoped credential registry, the loopback Streamable-HTTP MCP endpoint,
  the forwarder to the daemon socket (daemon-down → error result), and wiring for all four
  providers per spec §1.2, approvals per §1.3, instructions per §1.4 (with the guarantee that
  injected text never reaches user-visible/history/search surfaces), presentation/slim rules per §1.5.
- The `orquester` server is attached only when at least one toolkit is registered; ship the
  framework with a test-only toolkit registered in tests (not in production `index.ts`).
- Tests: credential lifecycle (issue, verify, revoke on end/relaunch, cross-thread rejection, 401),
  daemon-unavailable result, cancellation, each provider's launch/session config carrying the server
  (unit tests on the config builders) with no credential in argv, the Claude in-process server
  advertising registered tools, OpenCode cross-thread isolation, instruction text absent from
  projected history/user bubbles.
- Update the agent-host README module map and the agent-chat spec note on "no MCP for chat agents".

### Task 2: Mermaid and math in chat markdown

Spec §4 in full. Client-only (`packages/ui`). Deliver the Mermaid renderer and KaTeX math in
`ChatMarkdown`, the expand-to-viewer path, theming, sanitizing, streaming behaviour, tests
(render queue, cache key, sanitize, fence detection, math delimiters incl. currency text not
becoming math, error fallback), and verify CSP compatibility by inspection of what mermaid/katex
need against `deploy/Caddyfile` (document the conclusion; adjust the Caddyfile only if strictly
required and explain). Run `pnpm build` once to prove both frontends bundle (lazy chunks).

### Task 3: Visual frame infrastructure

Spec §2.2, §2.3, §2.4, §2.5. No agent tool in this task (Task 5 adds it); drive everything from
fixture thread events that contain a completed `orquester` `html_render` tool call whose result
carries `{ htmlRender: {...} }` (for every provider's MCP item shape as ingested today).
Deliver:
- A daemon-side `publishHtmlRender(threadId, html, title, height, heights?)` service (bootstrap +
  theme defaults injected, local image inlining with size limits and sandboxed paths, saved as an
  `html` thread attachment, returns the reference) that Task 5's handler will call; tests.
- Bootstrap script + theme fragment + JSON-RPC message parsing as a shared module importable by
  daemon and UI (place per package boundaries — e.g. `packages/api` for the pure protocol/parsers).
- Attachment sweep exemption for referenced visual attachments; slim rule keeping the reference.
- Signed-URL minting + serving route with the sandbox CSP headers (+ contract in `packages/api`,
  `agentChatRoutes`), Caddy carve-out + `deploy/README.md` note, desktop custom protocol / guards.
- Theme token exporter with the every-scheme × mode test.
- Frame component + bridge (size, links, shortcuts, theme live update, no flash, no scroll trap),
  full-screen viewer with zoom, the `visual` row kind end-to-end in the timeline (not folded).
- Tests for parsers, sizing math, URL signing/expiry/tamper, CSP headers, row derivation
  (including that it is not hidden in groups/folds and keyed stably), theme exporter.

### Task 4: Thread lineage — fork, merge back, relationships

Spec §6 (except the session-tool tools, which Task 6 adds) plus the external `/mcp` parity for
fork/merge from spec §5. Deliver data model (additive, tolerant), per-provider fork (native where
available, faithful transcript handoff otherwise — verify each provider's capability and test it),
API contracts + daemon routes + host protocol (handover-compatible), merge back, UI (message
"Fork from here", lineage chip/breadcrumb, children list, sidebar relation), external MCP tools
`fork_session` / `merge_back_session` (names consistent with existing `/mcp` tools) documented in
`docs/orquester-mcp.md`. Expose a daemon-side API (via `DaemonApi`) that Task 6 will call for
`thread_fork`/`thread_merge_back`/`delegate_task` lineage. Tests per provider fork path, lineage
persistence round-trip (old logs without lineage still load), merge-back delivery when parent busy.

## Wave 2 (after Tasks 1, 3, 4 are merged into the integration branch)

### Task 5: `html_render` and `html_preview` tools

Spec §2.1 on top of Task 1's framework and Task 3's publisher/frame. Deliver the toolkit
(definitions with the full adapted descriptions, handlers, "Showing visuals" instruction snippet,
presentation label), the headless-Chromium preview + height measurement service on the daemon's
existing browser infrastructure (isolated context, private-network blocking, timeouts, console
capture, screenshot), wire heights into publish, and tests (schema bounds, publish → reference →
row, preview result shape incl. image content, private-network block, timeout, browser-missing
path). Verify the tool works for all four providers' MCP item shapes end-to-end through ingestion
into a `visual` row.

### Task 6: Thread and delegation tools

Spec §5 "Threads" and "Delegation", plus `thread_fork` / `thread_merge_back` (spec §6) via Task 4's
API. Project scoping, cancellable waits using existing broadcasters/receipts (no polling sleeps),
delegate child lineage, `task_status`/`task_wait` returning the delegate's final answer, timeline
presentation (delegate rows link to the child thread; child shows "Delegated by"). Tests for every
tool incl. scope violations, wait cancellation, and timeouts.

### Task 7: Scheduled tasks (removed)

*Removed after it shipped: Orquester no longer has agent scheduled tasks (spec §5 "Scheduling").
The task text below is kept as history.*

Spec §5 "Scheduling". Persisted schema in `packages/config` (tolerant), daemon scheduler (reuse
workflow timer/cron primitives), delivery via the normal send path (queued when busy), restart
survival, missed-run policy (documented, tested), UI listing per thread with cancel/run-now, tools
+ instruction snippet. Tests incl. restart reload, cron next-run computation, delivery to a busy
thread, deletion of a thread's tasks when the thread is deleted.

### Task 8: `request_secret`

Spec §5 "Secrets". Port T3's design; the card in the banner dock (reuse `QuestionCard` secret-input
pieces where they fit), cancel path, value lifecycle (memory only, delivered once to the requesting
call), redaction tests proving the value is absent from `events.ndjson`, logs, slimmed and full item
reads, search index, and API responses other than the tool result.

### Task 9: Pull request watches (removed)

*Removed after it shipped: Orquester no longer has pull request watches (spec §5 "PR watch"). The
task text below is kept as history.*

Spec §5 "PR watch". Reuse the daemon's git-host providers and the workflow `git-poller` patterns;
persisted watches (tolerant schema), change detection (checks, reviews/comments, mergeability,
state), concise wake messages queued when busy, auto-end on merge/close, UI list with stop, tools.
Tests with provider fakes for each change kind, dedupe (no repeat wake for the same state), restart.

### Task 10: MCP Apps

Spec §3. Per-provider capability investigation with evidence, snapshot + CSP, reference on the tool
row, `McpApp` frame on Task 3's infrastructure with the full host bridge and consent prompts,
`tools/call`/`resources/read` proxied through the live provider session, model-context delivery
where supported. Document unsupported providers with evidence in the spec appendix. Tests for CSP
building, reference ownership checks, bridge method handling, consent gating.

## Finish

After all tasks merge into `feat/agent-visuals`: full `pnpm check`, `pnpm test`, `pnpm build`,
whole-branch review, one fix wave, then merge `feat/agent-visuals` into `main`.
