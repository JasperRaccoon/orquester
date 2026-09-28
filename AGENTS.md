# AGENTS.md

## Work in this repository

- Read [README.md](README.md) for product architecture, setup, and deployment commands.
- Use `pnpm`; the root `package.json` owns workspace scripts and the package manager version.
- Check the relevant package's `package.json` before adding or invoking a script.
- Keep changes within the requested behavior and the existing package boundaries.
- Check current source and wire contracts before following a design document.
- Add or change tests where behavior, parsing, persistence, or protocol handling changes.
- Prefer a focused package test while developing, then run the required repository checks.
- Keep `CLAUDE.md` as a pointer to this file; put shared agent rules here once.
- Commit on the current branch when asked to commit, including when it is `main`.

## Terms used here

- **Workspace:** a named directory directly under the configured workspaces root; it groups projects and can carry a git identity.
- **Project:** a directory directly inside a workspace; it is the scope for its tabs, sessions, git state, and workflows.
- **Session:** a daemon-owned shell or agent-chat tab identified by `sessionId`; an agent-chat thread uses the same ID.
- **Agent chat GUI (the GUI):** the structured chat view showing messages, tools, approvals, and prompts instead of an agent TUI in a terminal pane.
- **Terminal:** the PTY view for shell sessions and legacy terminal-agent sessions; input is sent as terminal keystrokes.
- **Composer:** the prompt entry and controls in an agent-chat tab where the user writes and sends messages.
- **Agent host:** the separate process that runs chat-provider adapters and owns chat threads and their event logs.
- **MCP:** the daemon's authenticated Model Context Protocol endpoint for external agents to operate chats, workflows, and related data; it does not provide terminal I/O.
- **Workflow:** a daemon-owned graph of triggers and blocks that automates tasks within a project; a run is one execution of that graph.
- **Right rail:** the side panel for saved prompts, chat history and checkpoints, automated workflows, and the agent profile.
- **Agent profile:** the right-rail section that edits each agent CLI's own global config files (MCP servers, skills, plugins, marketplaces, hooks, commands, instruction file); the CLIs' files stay the only source of truth.

## Repository map

- `apps/daemon` owns the HTTP and Unix-socket server, sessions, files, git, workflows, MCP, and the agent host supervisor.
- `apps/desktop` owns the Electron shell and its bridge to the daemon.
- `apps/web` owns the remote Vite client and PWA assets.
- `packages/ui` owns the shared React UI and client state used by both frontends.
- `packages/api` owns transport contracts and the reference API client.
- `packages/config` owns appdir paths, defaults, and persisted-data schemas.
- `packages/registry` owns the static catalog of launchable tools.
- Packages import each other's TypeScript source; preserve that dependency pattern.
- Put transport changes in the shared API contracts before adapting daemon and UI callers.
- Keep route request and response types aligned with their daemon handlers and UI consumers.
- Put persisted-data validation in `packages/config`; tolerate records written by other app versions.
- Use `packages/config` path helpers instead of hardcoding appdir paths.
- Keep secrets and private keys on the daemon; never return them in API responses or logs.
- Use the module map in `apps/daemon/src/agent-host/README.md` when working on the agent host.
- Read the provider fixture README before changing a provider adapter or its replay tests.
- Use `deploy/README.md` and `deploy.sh` for deployment work.

## Runtime boundaries

- The daemon runs TypeScript through `tsx`; do not expect a daemon `dist` artifact.
- If explicitly asked to drive a daemon, use a separate checkout and appdir.
- Verify daemon-side changes with typechecks, tests, and code review without disturbing the live daemon.
- The desktop and web clients share `packages/ui`; check both entry points for shared UI changes.
- The Unix socket is trusted local control; remote HTTP and WebSocket routes require auth.
- Keep socket-only control routes off the remote transport.
- Keep auth decisions server-side; treat client checks as UI behavior only.
- Use the shared transport and API client for frontend requests.
- Preserve the multiplexed terminal WebSocket protocol when changing PTY streaming.
- Keep paths entering file and project operations inside their configured sandbox after realpath resolution.
- Keep file uploads as binary streams rather than embedding file bytes in JSON.
- Use `GROK_CONFIG_PATH` overlays for managed Grok configuration instead of writing through account-home symlinks.
- Keep agent-host protocol changes compatible with daemon handovers.
- Do not add dynamic `import()` under `apps/daemon/src/agent-host`.
- Treat agent thread `events.ndjson` as the durable record; snapshots and SQLite indexes are disposable caches.
- Preserve append-only event ordering and per-thread sequence numbers in agent logs.
- Rebuild thread caches from the log when their version or position cannot be trusted.
- Preserve unknown persisted fields and records when rewriting tolerant JSON stores.
- Validate localStorage and bridge payloads before they reach shared UI state.
- Update agent session bindings through `ThreadStore.upsertSessionBinding` field-wise.
- Omit an unknown resume cursor; clear one only when an explicit operation requires it.
- Keep agent commands idempotent by using the existing command IDs and receipts.
- Use `agentChatRoutes` from `packages/api/src/agent-chat/wire.ts` for agent-chat route paths.
- Keep provider-specific protocol handling in its adapter and normalize into shared runtime events.
- Surface unmapped provider events as warnings; do not silently discard them.
- Preserve provider resume identity in the account home that created it.
- Keep MCP and workflow tools behind `DaemonApi` rather than reaching into services directly.
- Use the existing broadcaster, receipts, or event drains for asynchronous waits.
- Treat workflow secrets as host-only values; persist names and references, not secret values.
- Persist workflow wait state before starting a side effect that may outlive the daemon.
- Preserve the daemon's session ownership when changing PTY, tmux, or shutdown behavior.
- Check both tmux-backed and direct PTY paths when changing session lifecycle code.

## Generated and persisted files

- Regenerate Codex and Grok adapter bindings using the README in the relevant `_generated` directory.
- Keep provider protocol fixtures redacted and update their provenance when adding captures.
- Keep fixture replay assertions tied to observed provider frames.
- Treat `.stage` as a development appdir; do not commit its runtime sockets, logs, or workspace data.
- Do not commit credentials, private keys, local deployment targets, or machine-specific notes.
- Keep credentials out of process arguments and generated shell commands.
- Do not edit build outputs such as `dist`, `dist-electron`, or `release` as source.

## Verification commands

- Run `pnpm install` when dependency changes require it; keep `pnpm-lock.yaml` in sync.
- Run `pnpm check` before committing; it typechecks every workspace and is the pre-commit gate.
- Run `pnpm test` for code behavior changes; it runs each package's tests and check scripts.
- During development, use `pnpm --filter @orquester/daemon test` or the relevant package filter for focused tests.
- Run `pnpm build` when a change affects emitted web, desktop, or public assets.
- Run a targeted manual or browser check only when it can use an existing safe surface.
- Record any verification that cannot run and the reason in the final report.
- Review `git diff --check` and the final diff before committing.

## Standing DON'Ts

- Don't append history, changelogs, migration stories, incident notes, or dated exceptions to this file.
- Don't copy feature tours, route inventories, design specs, or deployment procedures into this file.
- Don't add wrapper layers, helper abstractions, or broader scope without a concrete task requirement.
- Don't create scripts or commands that duplicate an existing root or package script.
- Don't hand-edit the Codex or Grok adapter `_generated` files; regenerate them from their source.
- Don't skip typechecking or relevant tests because a change looks small.
- Don't run `pnpm dev`, `pnpm dev:daemon`, `pnpm dev:web`, or the daemon CLI in this live checkout.
- Don't bind the daemon's port or socket or run `systemctl restart orquester` without explicit instruction.
- Don't use sleep-based timing in tests or orchestration when a receipt, drain, or event can signal completion.
- Don't weaken auth, filesystem containment, or secret redaction to make a local test pass.
