# Plugins settings section — "Better TS Typecheck" (tsc-rs) as the first built-in plugin

Status: design approved by the owner on 2026-10-14, section by section (how the redirect works;
install and auto-update; stored state and API; the tab, errors and testing). The owner chose
redirect-everywhere over per-project verification, an hourly background update check, built-in
plugins only, and asked to include the orquester-3 `types` fix. This document is the written spec
awaiting the owner's review.

> **Superseded in part (2026-10-17):** the owner found per-workspace enabling tedious, so
> Better TS Typecheck is now turned on once for the whole server, like Excalidraw Whiteboard:
> `PUT /api/plugins/ts-rust` sets `plugins.json` `ts-rust.enabled`, the per-workspace route and
> the scope picker are gone, and the preload redirects every `tsc` run inside any workspace while
> `enabled` is true. A record with a non-empty legacy `enabledWorkspaces` and no `enabled` is
> turned on at daemon start. Where this document says "enabled workspace", read "while enabled".

> **Engine choice (2026-10-17):** the plugin runs one of two TypeScript 7 engines in place of
> `tsc`: **tsrs** (oxc-project/tsrs, npm `tsrs` + `@tsrs/{darwin-arm64,linux-<cpu>-<gnu|musl>}`;
> no Windows or Intel Mac build) or **tsc-rs**. The default is tsrs where it has a build, else
> tsc-rs; `PUT /api/plugins/ts-rust` takes `{ enabled?, engine? }` (409 for an engine with no
> build here). `plugins.json` keeps tsc-rs's versions in the record's own fields and adds
> `engine` (unknown values read as absent) and `tsrs: { current, previous, skippedVersion,
> lastCheckAt, lastError }`; tsrs installs its whole package (binary beside its lib `.d.ts`
> files) under `plugins/ts-rust/tsrs/versions/<version>/`. Checks, installs, rollback and the
> skip apply to the active engine; switching while on installs the new one if it has nothing;
> removing downloads clears both. The preload picks the engine by the same rule (supported
> engines and the default are baked in) and appends `--checkers 4` for tsrs unless the
> arguments set `--checkers`/`--singleThreaded` or start build mode (`-b`/`--build`), since tsrs
> otherwise runs one checker per core up to 16. Where this document says "tsc-rs", read "the
> active engine".

Research inputs (2026-10-14, this host): a benchmark of `tsc-rs` 0.7.0 against each project's own
`tsc` (5.8/5.9/6.0) and the TypeScript 7 build it ports (`typescript@7.1.0-dev.20261008.1`) on 50
tsconfigs across 12 projects (§1.2); two throwaway probes of how `tsc` can be intercepted (§3.1);
the Settings modal, `daemon.json` and `workspaces.json` stores, the session env builders, and the
removed pinned-binary installer `cliproxy-install.ts` (`git show b72cefb2^:apps/daemon/src/cliproxy-install.ts`).

## 1. Problem and goal

`tsc` is the slowest step of most typechecks run from Orquester sessions. `tsc-rs`
([pingdotgg/ts-rust](https://github.com/pingdotgg/ts-rust)) is a Rust port of the TypeScript 7
compiler with the same command line. The goal is a **Plugins** section in Settings whose first
plugin, **Better TS Typecheck**, installs `tsc-rs`, keeps it up to date, and makes every `tsc` run
from an Orquester session in an enabled workspace run `tsc-rs` instead.

### 1.1 Requirements (the owner's)

1. A **Plugins** section in Settings, laid out like the owner's mockup: a plugin list, a detail
   panel, and a workspace scope picker.
2. Turning the plugin on for a workspace installs `tsc-rs` and redirects **every** `tsc` call made
   from Orquester sessions in that workspace to it, in every project, whether or not the project is
   TypeScript 7-ready.
3. `tsc-rs` is kept up to date automatically, without the owner doing anything.
4. Fix orquester-3 so its own `pnpm check` passes under `tsc-rs`.

### 1.2 What the benchmark established

- `tsc-rs` output equalled the TypeScript 7 build it ports on all 50 tsconfigs, and was
  deterministic across runs. On this host it was ~20× faster than the projects' own `tsc`
  (geometric mean) and ~2.4× faster than TypeScript 7. Peak memory was half of `tsc` 5.9's.
- `tsc-rs` **is TypeScript 7**. 9 of the 50 tsconfigs give different results than the projects'
  own `tsc`: removed options (`baseUrl`, `esModuleInterop: false`), the new `types` default (`[]`),
  the new `rootDir` default, newer DOM lib types, and one TS5115 type cycle. orquester-3's
  `packages/api` and `packages/ui` report 512 errors until they set `"types": ["node"]`.
- So under requirement 2, a project that is not TS 7-ready **fails its typecheck** while the plugin
  is on. This is the owner's explicit choice; the UI says it when the plugin is turned on.

### 1.3 Out of scope

- Third-party plugins, "Install from file", a plugin package format, and the mockup's
  Available/Updates sub-tabs.
- Per-project verification or a fallback to the real `tsc` when `tsc-rs` reports errors.
- Redirecting outside Orquester sessions (SSH logins, systemd services, CI), `bunx tsc` (runs under
  Bun, not Node), and the programmatic `typescript` API (ESLint, Vite plugins, tsx, editors).
- The `tsc-rs` language server.
- Making other projects TS 7-ready. Only orquester-3 is fixed (§8).

## 2. Terms

- **Plugin:** a built-in, code-defined feature listed in the Plugins section, enabled per workspace.
- **Enabled workspace:** a workspace where the owner turned the plugin on.
- **Preload:** the small CommonJS file Orquester sessions load into every Node process through
  `NODE_OPTIONS=--require`. It redirects `tsc`.
- **Current / previous version:** the installed `tsc-rs` version in use, and the one it replaced,
  which is kept for rollback.

## 3. How the redirect works

### 3.1 Why a preload and not a PATH shim

A `tsc` shim on PATH only catches a bare `tsc`. `pnpm run`, `npm run`, `npx tsc` and
`pnpm exec tsc` all prepend the project's `node_modules/.bin`, so they reach the project's own
`tsc` first. This was verified on this host. A Node preload that checks which program the process
is running redirected all four, left `require("typescript")` on the real 5.9.3, and passed exit
codes through. Every project `tsc` is a Node script, whichever package manager starts it.

### 3.2 The preload

The daemon writes `<appdir>/daemon/plugins/ts-rust/preload.cjs` (path from a new
`packages/config` helper). It writes the file atomically, and again on every start and whenever
`workspacesDir` changes. Two constants are baked into the file: the absolute `plugins.json` path
and the resolved workspaces root. On load the preload:

1. Takes `process.argv[1]`, normalises it without resolving symlinks, and also resolves its real
   path. If neither ends in `typescript/bin/tsc` or `typescript/lib/tsc.js`, it returns at once.
   That is a string test only; there is no file I/O for non-`tsc` processes.
2. Works out the workspace from the unresolved `argv[1]`, the first path segment under the
   workspaces root. With pnpm's global virtual store the real path can be outside the workspace,
   but the unresolved one goes through the project's `node_modules`. If `argv[1]` is outside the
   root (an `npx` cache, for example), it uses `process.cwd()` instead.
3. Reads `plugins.json`. It redirects only if the parse succeeds, the workspace is in
   `ts-rust.enabledWorkspaces`, and the current version's binary (`versions/<current>/tsc`, or
   `tsc.exe` on win32) exists. Otherwise it returns and the
   real `tsc` runs.
4. To redirect, it runs `spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })` with the
   same cwd and env, then `process.exit(status)`. For a signal it re-raises the signal on itself.
   If the spawn fails (`ENOENT`, `EACCES`), it prints
   `orquester: tsc-rs failed to start (<code>); running tsc` to stderr and returns, so the real
   `tsc` runs.

The preload must never throw. Its whole body is wrapped so any unexpected error falls through to
the real `tsc`.

### 3.3 Which sessions load it

`NODE_OPTIONS` gets `--require "<preload path>"`, appended to any `NODE_OPTIONS` already in the
env, never replacing it. It is added when **the plugin is enabled in at least one workspace and the
preload file exists**:

- **Shell sessions, tmux and direct PTY:** next to `sessionPath()` in `apps/daemon/src/tmux.ts`,
  using the daemon's in-memory plugin state. Both the tmux `new-session` path and the direct
  node-pty path take it. The plan must check which env a tmux pane actually inherits, the client's
  or the server's global environment, and set it there.
- **Agent-chat providers:** the agent host already receives `ORQUESTER_APPDIR`, so it derives the
  preload and `plugins.json` paths with the `packages/config` helpers; no new env var. At each
  provider spawn, `buildProviderEnv()` in `agent-host/support/env.ts` adds `NODE_OPTIONS` if the
  preload file exists and `plugins.json` shows any enabled workspace. An older agent host never
  adds it, which keeps daemon handovers compatible.
- **Workflow blocks:** `buildSandboxEnv()` in `workflows/sandbox/env.ts`, using the daemon's state.

**The daemon never deletes `preload.cjs`** once written. Already-running sessions reference it in
`NODE_OPTIONS`, and Node refuses to start when a `--require` target is missing. Turning the plugin
off is handled inside the preload by step 3.

A session's env is fixed when the session starts. So turning the plugin on for the first time
affects new tabs, chats and workflow runs, and the UI says so. Later changes (another workspace,
turning a workspace off, a new current version) apply to the next `tsc` call in every session,
because the preload reads state on each call. A session started while the plugin was on keeps
loading the preload after it is turned off everywhere. The preload then does nothing.

### 3.4 Known limitations

- A script that sets its own `NODE_OPTIONS=…` before `tsc` replaces ours, so the real `tsc` runs.
  No project on this host does this today.
- `tsc-rs --version` prints `Version 7.1.0-dev`, the TypeScript version it ports. Tools that parse
  `tsc --version` see 7.x.

## 4. Install and auto-update

### 4.1 Layout

```
<appdir>/daemon/plugins/ts-rust/
  preload.cjs
  versions/<version>/tsc        (+ the lib .d.ts files shipped beside it)
  .tmp/                         (download and extract staging; emptied on start)
```

### 4.2 Install or update one version

A new module, `apps/daemon/src/plugins/ts-rust/installer.ts`, revives the `cliproxy-install.ts`
pattern. Network access goes through injected deps, `fetchJson` and `fetchTarball`.

1. Map `process.platform`/`process.arch` to the platform package: `@tsc-rs/{linux,darwin,win32}-{x64,arm64}`.
   On any other platform the plugin reports `unsupported` and does nothing else.
2. `GET https://registry.npmjs.org/tsc-rs/latest` gives the version. Then fetch the platform
   package's metadata for that version: `dist.tarball` and `dist.integrity` (sha512).
3. Stop here if the version equals current or `skippedVersion`.
4. Download into `.tmp/`, verify the sha512 integrity, and extract with `tar`. Take `package/lib/`
   and `chmod 755` the binary (`tsc`, or `tsc.exe` on win32).
5. Smoke test: run `<binary> --version` with a 30 s timeout. It must exit 0 and print a line
   starting with `Version `. The run uses the daemon's own environment with `ORQUESTER_*` keys stripped, not
   `process.env` as is.
6. Atomically `rename` the staged directory to `versions/<version>`. Then, through the plugins
   write queue (§5.1), set `previous = current` and `current = { version, integrity, installedAt }`,
   and clear `lastError`.
7. Delete every `versions/*` directory other than current and previous.

If any step fails, it removes the staging directory, keeps `current` and `previous` as they were,
and records `lastError: { at, step, message }`. The next scheduled check retries. Download and
smoke-test timeouts are bounded, so a check cannot hang forever.

### 4.3 When it runs

The `PluginsService` owns a single serialized job queue for the plugin. A check that is already
queued is not queued again. A check runs:

- when a workspace is enabled and nothing is installed yet (the first install);
- at daemon start;
- every 60 minutes;
- on `POST /api/plugins/ts-rust/check`.

Scheduled checks run only while the plugin is enabled in at least one workspace. The manual check
always runs. A check never blocks a typecheck, and an update never interrupts a running one: a
running process keeps its binary open, and the next `tsc` call uses the new current version.

### 4.4 Rollback, skip and remove

- **Rollback** swaps current and previous, sets `skippedVersion` to the version rolled back from,
  and prunes nothing. A check stops at that skipped version. When `latest` moves past it, the newer
  release is installed and `skippedVersion` is cleared.
- **Remove downloads** deletes `versions/` and clears current, previous and `skippedVersion`. It is
  refused with `409` while any workspace is enabled. `preload.cjs` stays (§3.3).

## 5. Stored state and API

### 5.1 `plugins.json`

`<appdir>/daemon/plugins.json`, with its schema and path helper in `packages/config` next to the
other stores. Like the other tolerant stores it keeps unknown fields and unknown plugin ids, and a
corrupt file is never overwritten: the daemon reports it, and the preload falls back to the real
`tsc`.

```ts
pluginsConfigSchema = z.object({
  version: z.literal(1).default(1),
  plugins: z.record(z.string(), pluginStateSchema).default({}),   // keyed by plugin id; unknown ids preserved
}).passthrough();

pluginStateSchema = z.object({
  enabledWorkspaces: z.array(z.string()).default([]),
  current: installedVersionSchema.optional(),     // { version, integrity, installedAt }
  previous: installedVersionSchema.optional(),
  skippedVersion: z.string().optional(),
  lastCheckAt: z.string().optional(),
  lastError: z.object({ at: z.string(), step: z.string(), message: z.string() }).optional(),
}).passthrough();
```

All writes go through one read-modify-write queue, like `queueDaemonConfigWrite`, with
`writeJsonFile`. The in-memory state changes only after a write succeeds. When a workspace is
renamed or deleted, its name stays in `enabledWorkspaces`. An unknown name is ignored at runtime
and hidden from the UI, and re-creating that workspace re-enables the plugin there. This matches
how `workspaces.json` keys by name.

### 5.2 Built-in plugin list

There is a static list in the daemon (`apps/daemon/src/plugins/catalog.ts`). Its display fields are
exported through the API types: `{ id: "ts-rust", name: "Better TS Typecheck", description,
source: { label: "pingdotgg/ts-rust", url }, provider: "Community" }`. A later built-in plugin
needs a list entry and its own service handler. There is no generic plugin runtime.

### 5.3 Routes

Contracts go first in `packages/api`; then the daemon handlers and the `api-client.ts` methods.

| Route | Body / result |
| --- | --- |
| `GET /api/plugins` | `PluginsResponse`: per plugin, its display fields, `platform: "supported" \| "unsupported"`, `enabledWorkspaces` (existing workspaces only), `current`, `previous`, `skippedVersion`, `lastCheckAt`, `lastError`, `job: "idle" \| "checking" \| "installing"` |
| `PUT /api/plugins/:id/workspaces/:workspace` | `{ enabled: boolean }` → the plugin's state |
| `POST /api/plugins/:id/check` | `202`; progress arrives by broadcast |
| `POST /api/plugins/:id/rollback` | `409` without a previous version |
| `DELETE /api/plugins/:id/downloads` | `409` while any workspace is enabled |

- `:id` must be in the built-in list (`404` otherwise). `:workspace` must be an existing workspace
  directory name, checked with the same validation workspace routes use (`404`/`400`).
- State changes go out through the existing broadcaster as a `plugins.changed` event carrying the
  same `PluginsResponse`, so install progress and new versions show live in every open client.
- The routes are on both the Unix socket and authenticated remote HTTP. Enabling makes the daemon
  download and run a verified binary, which is comparable to remote users' existing abilities
  (installing agent CLIs, running shells). No secrets are involved.

## 6. The Plugins section (UI)

In `packages/ui/src/components/settings/`, so the desktop app and the web client both get it:

- A new `SectionId` `"plugins"` and a `SECTIONS` entry: group `integrations`, label "Plugins",
  a `Puzzle` icon, desc "Optional built-in features", keywords
  `plugin, plugins, typescript, tsc, ts-rust, tsc-rs, typecheck`. It renders `PluginsSettings`.
- **`PluginsSettings.tsx`**: loads with `api.getPlugins()` (with the usual load-failure notice) and
  subscribes to `plugins.changed`.
  - **Header:** "Plugins", and the subtitle "Enable optional features for your Orquester workspaces."
  - **Toolbar:** a search box filtering the list by name and description, and the scope picker
    ("Scope: <workspace>") listing the workspaces from the store. It defaults to the active
    project's workspace, or the first workspace.
  - **List:** each row shows icon, name, description, an "Installed" badge when `current` exists,
    and an on/off toggle for the selected workspace. Clicking a row selects it.
  - **Detail panel:**
    - name, description, source link, provider
    - **Status:** current version (or "Not installed"), "Checked <relative time>", the job state
      while one runs, and `lastError` in a warning notice
    - **Buttons:** "Check for updates", "Roll back to v<previous>" (shown only with a previous
      version), "Remove downloads" (enabled only when no workspace is enabled)
    - **Settings:** an "Enable for this workspace" toggle, the same control as the row toggle.
      The mockup's separate "Enable plugin" button is dropped.
  - **Unsupported platform:** the plugin shows as unavailable and its toggles are disabled.
- **First-enable confirmation**, shown when turning the plugin on in a workspace while it is
  enabled nowhere: "tsc-rs runs TypeScript 7. Projects whose tsconfig or code isn't TS 7-ready
  will fail their typecheck while this is on. Tabs, chats and workflow runs already open keep the
  normal tsc until reopened." Confirm or Cancel.

## 7. Error handling

| Situation | Behavior |
| --- | --- |
| Registry unreachable, bad integrity, extract or smoke test fails | Current version untouched; `lastError` set and shown; retried next check |
| Plugin enabled but no version installed yet | The real `tsc` runs; install in progress or failed is shown in the UI |
| Binary missing or fails to start during a redirect | One stderr line, then the real `tsc` runs |
| `plugins.json` corrupt or unreadable | Never overwritten; routes return the read error; the preload runs the real `tsc` |
| Platform has no tsc-rs build | `unsupported`, no network calls, toggles disabled |
| `tsc-rs` runs and reports type errors | Those are the result; no fallback (§1.3) |

## 8. orquester-3 fix

Add `"compilerOptions": { "types": ["node"] }` to `packages/api/tsconfig.json` and
`packages/ui/tsconfig.json`. Verified 2026-10-14 with `--types node`: 0 errors under both `tsc`
5.9.3 and `tsc-rs`. `packages/ui`'s React and bcryptjs types are imported explicitly and stay
available. With this, all nine orquester-3 tsconfigs gave identical results under `tsc` 5.9 and
`tsc-rs`.

## 9. Testing

- **Installer** (no network; fixture tarballs built in the test): first install, update, no-op when
  current, bad integrity, smoke-test failure and timeout, atomic switch, pruning to current and
  previous, rollback and skip, and a newer release clearing the skip. Also unsupported-platform
  mapping, and that a failed step leaves state and `versions/` untouched.
- **State:** schema parse with unknown fields and plugin ids preserved, a corrupt file never
  overwritten, and the write queue ordering memory after disk.
- **Preload**, run in child Node processes against a fake workspaces root with a stub `tsc-rs`
  binary:
  - `tsc` through `.bin`, `bin/tsc` and `lib/tsc.js` is redirected only in enabled workspaces;
  - a symlinked pnpm-style layout resolves to the right workspace;
  - `require("typescript")` and non-`tsc` scripts are untouched;
  - exit codes and signals pass through;
  - a missing binary or corrupt state falls back with the stderr line.
- **Env builders:** `NODE_OPTIONS` is added only when enabled anywhere and the preload exists,
  appended after any existing value, for the shell paths (tmux and direct), provider env and
  workflow sandbox env.
- **Routes:** validation (`404`/`400`/`409`), enable triggering the first install, and the
  broadcast payload.
- **UI:** logic tests for the section's state helpers: toggle, scope default, and button enablement.
- `pnpm check` and `pnpm test`. Not run against the live daemon (AGENTS.md); the final report will
  say so.
