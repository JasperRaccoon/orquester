# 12 — Delta: desktop, mobile, tooling and tests (T3 `ed9b7ca9..66ee628e`)

Scope: what is new in T3 Code since the first pass (reports 00–09) for the desktop app, the
mobile app (judged only for what a PWA can use), and developer tooling and test infrastructure.
T3 paths are relative to `t3code_codebase/`; Orquester paths are relative to the repo root of
`t3gap/integration`.

The v0.1.2 release notes list several tooling PRs that landed on 20–21 Oct, just before
`ed9b7ca9`: #22557, #22559–#22565, #22645, #22711–#22718, #22735 and #22738. Reports 00–09 did
not cover test infrastructure, so this report covers them as well. The range proper adds #23983
(polling lint becomes an error), #23581 and #23988 (`check:changed`), #23023 (tsc-rs drop-in),
#24058 (more pruning), and four PRs that restore tests the prune deleted.

Read-only analysis. No builds or test suites were run, because one was already running. The only
measurements are single `node` start-ups, described in §0. They ran while that suite loaded the
host: load average 17–19 on 16 cores.

---

## 0. Headline: our slow suite is mostly the tsx transpile cache, not the tests

None of T3's changes address the main cost of our `pnpm test`. Every package test script starts
one `node --import tsx` process per test file (`apps/daemon/package.json` `test`;
`packages/{ui,api,config}/package.json`). tsx keeps its transpile cache in
`$TMPDIR/tsx-<uid>`. On this host that is `/var/lib/orquester/tmp/tsx-999`, because
`deploy/orquester.service:11-13` sets `TMPDIR=/var/lib/orquester/tmp`.

That directory now holds **1,154,534 files (21 GB) in one flat directory**. Every entry is
under 7 days old (day stamps 17920–17927), so tsx's own 7-day expiry never trims it. The cache
grows by about 165k entries a day.

tsx 4.22.4 handles this cache badly in two ways
(`node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/index-D9F1FXzN.cjs`, class `FileCache`):

- On every process start, it runs `readdirSync(cacheDirectory)` over the whole directory and
  maps each entry into an array.
- On every module load, it runs `this.cacheFiles.find(u => u.key === e)`. That is a linear scan
  of 1.15M entries for each module.

Measured with `node --import tsx` from `apps/daemon`:

| Probe | Shared stale cache | Fresh `TMPDIR`, cold | Fresh `TMPDIR`, warm | `TSX_DISABLE_CACHE=1` |
|---|---|---|---|---|
| Empty script (`-e ""`) | **27–33 s** | 0.59 s | — | 0.55 s |
| `import('./src/agent-chat/service.ts')` (346 modules) | **129 s** | 18.2 s | 11.4 s | 19.8 s |

`strace -c` of the empty start shows 5,078 `getdents64` calls (8 s) and 49 s of `futex`
time. The real cost is the per-module linear scan, which gets worse the more modules a test
imports.

We have 881 `*.test.ts` files plus `*.check.ts` files. Each one pays this cost before its first
test runs, and so does every tsx child process a test spawns. At 4 files at a time
(`ORQUESTER_TEST_CONCURRENCY` default), the cost alone is roughly 537 daemon files × 30–120 s ÷ 4,
which is 1–4 hours. That fits ">2 h on a loaded 16-core machine".

The same cache also slows every `tsx` start of the live daemon and agent host (`tsx src/cli.ts`),
and every tsx script that agents run.

**What to do:**

1. **Now (operator step, not done here):** `rm -rf /var/lib/orquester/tmp/tsx-999`. Wiping it is
   safe even while processes are running. tsx's `get()` treats an unreadable cache file as a
   miss (`Xe(o)` returns nothing, then it unlinks and moves on).
2. **Keep it bounded:**
   - The daemon owns this `TMPDIR`, so it can do housekeeping at startup and every few hours:
     when `tsx-*` holds more than about 20k entries, rename it aside and remove it in the
     background.
   - Alternatively, add a systemd tmpfiles rule with a short age, such as `e
     /var/lib/orquester/tmp/tsx-* - - - 6h`. At about 165k entries a day, a 1-day age still
     leaves start-up seconds per process.
3. **Isolate test runs from agent churn:** pass a per-checkout tsx cache to the test scripts. tsx
   4 has no cache-dir variable; the directory is `os.tmpdir()`. So the option is either a scoped
   `TMPDIR` for the test command, or `TSX_DISABLE_CACHE=1`, which costs about 1.7× a warm cache
   per process, as measured above. Changing `TMPDIR` also moves `mkdtemp` and Unix-socket paths,
   which have a length limit. Check the socket tests before choosing it.

Re-measure the suite after step 1 before acting on any ranking below. Pruning and concurrency
decisions depend on the real per-file times.

---

## 1. Change table

Value and Effort use H/M/L and S/M/L.

| Change | T3 evidence | Orquester status | Value | Effort |
|---|---|---|---|---|
| **Desktop: a stuck quit no longer leaves the app unkillable.** A second Quit or SIGTERM after 10 s of pending shutdown calls `app.exit(0)`. | `c58d558e` (#23873); `apps/desktop/src/app/DesktopLifecycle.ts:130` | **Partly safe already.**<br>- `before-quit` clears `daemon` before awaiting its stop (`apps/desktop/src/main.ts:445-454, 1131-1137`), so a second Quit is not cancelled and passes.<br>- The first quit has no bound, though. `stopIntegratedDaemon()` awaits `RunningDaemon.stop()` without a timer, while the CLI has a 3 s force-exit (`apps/daemon/src/cli.ts:18`). | M | S |
| **Desktop: fewer crashes when a preview renderer dies mid-screenshot.** One `Page.captureScreenshot` in flight per guest, with the queue released on navigation. | `cccb78c4` (#24056); `apps/desktop/src/preview/DesktopBrowserHost.ts` | **Different architecture.**<br>- The desktop app hosts no `<webview>`.<br>- The daemon's puppeteer Chromium takes screenshots without serialising them (`apps/daemon/src/browsers.ts:258, 744`).<br>- The Chromium bug (crbug 567321049) would kill that browser, not the app or the daemon. | L | S |
| **Desktop: PDFs in the preview can be annotated.** A transparent layer over Chromium's PDF frame, starting on Region. | `6ba80781` (#24022); `apps/desktop/src/preview/PickPreload.ts` | **Probably the same gap, unverified.** Our element picker is injected into the page (`apps/daemon/src/browser-pick.ts:177` `PICKER_SCRIPT`) and has no `application/pdf` branch. | L | S |
| **Electron 44.9.3** (compromised eMudhra CA) | `61e2747f` (#22645) | **Done.**<br>- The lockfile resolves `electron@44.9.3` (`pnpm-lock.yaml:3051, 8283`), and `apps/desktop/node_modules/electron` is 44.9.3.<br>- The range in `apps/desktop/package.json:37` still says `^44.9.1`. | L (raise the floor) | S |
| **New worktrees install Electron from the local download cache** | `a5d66e22` (#22712); `apps/desktop/scripts/ensure-electron-runtime.mjs` | **Not needed.**<br>- We have no custom downloader. Electron 44's own `index.js` runs `install.js` (`@electron/get`, which uses `~/.cache/electron`) on first launch (`node_modules/.pnpm/electron@44.9.3/node_modules/electron/index.js`).<br>- `onlyBuiltDependencies: ["electron"]` in the root `package.json` is a no-op, because Electron 44 has no install script. T3 notes that pnpm 11+ fails if that key is removed carelessly. | — | — |
| **Mobile: undo toasts above Android bottom nav, action kept on one row** | `a68e6e97` (#23928), `18e27425` (#23910) | **N/A.** We have no undo toasts; report 05 lists swipe and undo as missing. Our toast stack is anchored to the top (`packages/ui/src/components/status/ToastStack.tsx:28`), so the overlap bug cannot happen. | — | — |
| **Mobile: drafts swipe to discard, row moves animate** | `b295dd83` (#23205) | **N/A.** We have no drafts list; swipe rows are covered in report 05. | — | — |
| **Mobile: iOS composer reopens where you left a long draft** | `efa53812` (#23096), native Swift | **Partial.**<br>- Draft text persists in localStorage (`packages/ui/src/lib/agent-chat/composer.logic.ts:200-217`).<br>- Caret and scroll do not: the draft holds only `text/attachments/context` (`:20-23`), and insertions focus at the end (`components/agent-chat/composer/ChatComposer.tsx:596-603`). | L | S |
| **Mobile: Android composer centring/padding, empty row icon, iPad alignment, Duo foldable (13 commits), Dynamic Island wrap, Clerk SDK** | `05cd55d2`, `a8dba9ca`, `e0759571`, `9cdd0592..5ed2ea24`, `96bae546`, `2c8bdf61` | **N/A.** These are native layout fixes. A PWA has no Live Activities (see 05). | — | — |
| **Test lint: ban per-test timeouts and unreasoned skips.** The project ceiling is 60 s (`testTimeout: 60_000`), and skips need `// quarantine: #id`. | `b280e7d3` (#22560); `oxlint-plugin-t3code/rules/no-test-timeout-or-unreasoned-skip.ts`; `vite.config.ts` `testTimeout` | **No ceiling at all.**<br>- `node --test` defaults `--test-timeout` to Infinity, and no package script sets it.<br>- 15 tests set `{ timeout }` themselves (e.g. `apps/daemon/src/desktops/ws-routes.test.ts:152-373`, `boxes/hub/agent.integration.test.ts:29`).<br>- A hung file stalls the whole run: `scripts/test/assert-ok.mjs` documents a 21-minute hang. | **H** | S |
| **Test lint: polling loops** (warning in #22565, error with a burn-down list in #23983) | `08dbf834`, `24c063ae`; `oxlint-plugin-t3code/rules/no-polling-loop-in-tests.ts`; `vite.config.ts:225-280` | **Partial.**<br>- AGENTS.md:116 bans sleeps, and many helpers are already event-driven (e.g. `apps/daemon/src/workflows/testing/daemon-harness.ts:232`).<br>- About 39 polling loops remain in 31 files (heuristic count). Some spin `setImmediate` until a wall-clock deadline (`agent-chat/replies.test.ts:453`, `agent-host/support/spawn-group.test.ts:24`); one sleeps 5 ms per turn (`agent-host/adapters/codex/testing.ts:386`).<br>- The repo has no linter at all. | M | M |
| **Test lint: no wall-clock readings** | `dd4506a1` (#22562); `rules/no-wall-clock-in-tests.ts` | **Missing.** Nine elapsed-time assertions fail under load: `repo-identities/image-sniff.test.ts:62,66` (<100 ms), `favicon.test.ts:146` (<500 ms), `secret-files/files.test.ts:555,634`, `html-preview/public-proxy.test.ts:294`, `workflows/nodes/regex-worker.test.ts:28`, `packages/api/src/agent-chat/session-tools.test.ts:408`, `packages/ui/.../markdown/math.test.ts:303`. | M | S |
| **Test lint: real-clock waits; frame/transition waits in browser tests** | `bde62061` (#22564), `7895a2bc` (#22561) | **Covered or N/A.** `mock.timers` is used in 64 files, and AGENTS.md:116 already holds the rule. We have no browser tests. | L | — |
| **Delete about 11k low-signal tests** (43%, summed file time −59%), then 4 restore PRs within 3 days, plus #24058 | `05696c63` (#22557) PR body (Haiku swarm, double-voted, AST deletion by title); restores `abffeede`, `0cb033c5`, `30a405bb`, `12c91aef`; `51a7118b` | **Not done.** About 10k tests: daemon about 6,843 `test/it` calls in 537 files, ui about 2,423, api 680, config 134. Most cost is per file and per process (§0), not per test. | M (after §0) | M |
| **`check:changed` in about 10 s.**<br>- Format/lint of changed files, typecheck of affected packages and dependents, sibling `foo.test.ts` only (not the import graph: "252 of 406 server test files, 7 minutes").<br>- An input-hash pass cache.<br>- An unused-patch install check. | `66ee628e` (#23581), `b2377db9` (#23988); `scripts/check-changed.ts` | **Missing.**<br>- `pnpm check` typechecks everything and `pnpm test` runs everything (root `package.json`).<br>- 686 of 881 test files have a sibling source file, so sibling selection would work.<br>- pnpm already supports `--filter "...[<ref>]"`. | **H** | S–M |
| **Agent docs name the fast commands; "do not run repo-wide checks, CI owns the full suite"** | `73daccf4` (#22711); `AGENTS.md:96-101` | **Opposite guidance.**<br>- `AGENTS.md:98` tells every agent to "Run `pnpm test` for code behavior changes" (the 2 h suite).<br>- `:99`'s "focused" example is a whole package (537 files).<br>- No single-file command is documented. We have no CI, so agents run the full suite concurrently and load the host. | **H** | S |
| **Local test runs use a clean environment.** Strip `ANTHROPIC_/CLAUDE_/CODEX_/OPENAI_/T3CODE_` vars, fix git config, avoid the xcrun shim. | `8f66e67d` (#22714); `packages/shared/src/testing/providerEnv.ts`, `apps/server/src/testUtils/gitConfig.setup.ts` | **Missing.**<br>- Agent shells pass `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `ORQUESTER_SESSION_ID`, `ORQUESTER_AGENT_LAUNCH`, and `NODE_OPTIONS=--require …/plugins/ts-rust/preload.cjs` into every test and every node child a test spawns.<br>- Tests read `CLAUDE_CONFIG_DIR` 44 times. Some files isolate git (`apps/daemon/src/git.test.ts` etc.); there is no shared preload. | M | S |
| **Make the remaining flaky server tests deterministic** | `31dcc7c5` (#22559) | Specific to T3's code. The principle is covered by the lint rows above. | — | — |
| **Typecheck cache** (Vite+ task cache, typecheck `--cache`) | `a1dc856e` (#22716), `ea1c4941` (#22735) | **Mostly covered.** In agent shells our "Better TS Typecheck" plugin already sends `tsc` to tsrs (`NODE_OPTIONS` preload, spec `docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md`). No `incremental` is set in `tsconfig.base.json`. | L | S |
| **`typescript` is the tsc-rs drop-in** | `4040867b` (#23023) | Covered by the plugin above. | — | — |
| **pnpm 12** ("4× faster installs", 11.2 s → 2.4 s warm) | `f4a3843a` (#22738) | We are on `pnpm@10.12.1` (root `package.json`). Installs are not our bottleneck. Going to 11+ means migrating `onlyBuiltDependencies` to `allowBuilds` and adding a `permissions.skills` deny block. | L | M |
| **Replay fixtures split into per-provider files** | `dd8452a0` (#22717) | **Already ours.** Replays live in each adapter: `apps/daemon/src/agent-host/adapters/codex/replay.test.ts`, `grok/{replay,session-replay,work-replay,subagent-replay}.test.ts`, `opencode/*.replay.test.ts`. | — | — |

---

## 2. Worth copying, ranked

Rank 0 is §0, the tsx cache. Fix it first; nothing below changes the suite's wall time as much.

### 1. Make the fast path the default for agents (from #22711). H value, S effort

Edit `AGENTS.md` "Verification commands":

- Replace line 98 with: "Run the test files you changed and their siblings; run `pnpm test` only when asked, or before merging to `main`."
- Name the single-file command, with an example run from the package directory:
  `node --import tsx --import ../../scripts/test/assert-ok.mjs --test src/foo.test.ts`.
  The daemon and UI also need `--import ../../scripts/test/quiet-mock-timers.mjs`, and the UI
  also needs `--import ./test/svg-loader.mjs`.
- Add `--test-name-pattern` for large files.
- Add "never run two full suites at once on this host".

There is no CI, so someone still has to own the full suite. A nightly Orquester workflow or the
merge into `main` should run it, not every agent.

### 2. `check:changed` (from #23581). H value, S–M effort

Add a root `check:changed` script (`scripts/check-changed.mjs`). No existing script does this.

1. `base=$(git merge-base HEAD main)`. Changed files are `git diff --name-only base` plus
   untracked files.
2. Typecheck affected packages and their dependents with pnpm's filter:
   `pnpm --filter "...[$base]" typecheck`.
3. Tests: changed `*.test.ts` and `*.check.ts` files, plus siblings of changed sources. T3's rule
   is `foo.ts` → `foo.test.ts` and `foo.*.test.ts`; the sibling check above found a match for
   78% of our test files.
   - Group the files by package and run each package's own `node --import … --test <files>`
     preamble, so `assert-ok`, `quiet-mock-timers` and `svg-loader` stay identical.
   - Do not follow the import graph. T3 measured it pulling in most of a package.
4. Optional: T3's pass cache, which skips a rerun when a sha256 over the diff and untracked bytes
   matches the last passing run. It is about 40 lines (`scripts/check-changed.ts:58-125`).

Steps 2 and 3 can run in parallel. Print the summary at the end.

### 3. A project-wide test timeout ceiling (the useful half of #22560). H value, S effort

Node's test runner has no default ceiling, unlike Vitest's 5 s. So for us, T3's rule turns
around: **add** the ceiling first, then ban overrides below it.

- Add `--test-timeout=${ORQUESTER_TEST_TIMEOUT:-120000}` to the `test` scripts in
  `apps/daemon`, `packages/{ui,api,config}`, `apps/desktop` and `apps/box-agent`.
- The `.check.ts` loops run plain `node` without `--test`, so wrap them in `timeout 300`.
- Per-test `{ timeout }` still overrides the default. Keep the explicit long ones on gated
  integration tests (`boxes/hub/agent.integration.test.ts:29`). Drop the 15 s ones in
  `desktops/ws-routes.test.ts`, which the ceiling covers.
- Leave skips alone. Our 132 `skip` hits are mostly environment gates such as tmux or VM
  availability, not quarantines.

### 4. Remove wall-clock assertions (from #22562). M value, S effort

- Rewrite the nine elapsed-time assertions listed in §1 (ReDoS and "stops promptly" guards).
  Either assert a work bound (steps, bytes scanned, or a worker terminated by the regex worker's
  own deadline), or move them behind `ORQUESTER_PERF_TESTS=1`.
- `image-sniff.test.ts` at <100 ms is the likeliest to flake on a loaded host.

### 5. A clean-env preload for tests (from #22714). M value, S effort

Add `scripts/test/clean-env.mjs` and import it beside `assert-ok.mjs` in the existing package
test scripts. It adds no new command.

- Delete `CLAUDE_*`, `ANTHROPIC_*`, `CODEX_*`, `OPENAI_*`, `XAI_*`, `GROK_*`,
  `ORQUESTER_SESSION_ID`, `ORQUESTER_AGENT_LAUNCH` and `NODE_OPTIONS`. Deleting `NODE_OPTIONS`
  only affects children the test spawns, which is the goal: the ts-rust preload stops loading
  into every spawned node.
- Keep `ORQUESTER_TEST_*` and an explicit allowlist, with a `ORQUESTER_TEST_KEEP_ENV=1` escape
  hatch.
- Optionally set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` for git-spawning
  tests, as T3's `gitConfig.setup.ts` does.

### 6. A polling-loop guard with a burn-down list (from #22565 and #23983). M value, M effort

- We have no oxlint or ESLint, and adding one only for this is heavy.
- Instead, write a root test, `scripts/test/test-hygiene.test.mjs`, and add it to the root
  `node --test` list in `package.json`. It parses every `*.test.ts` with the `typescript`
  package, which `assert-ok.mjs` already loads.
- It flags:
  - `for`/`while`/`do` loops whose body awaits a `setImmediate`/`setTimeout` promise;
  - `Date.now()` deadlines inside such loops;
  - `performance.now()` deltas in assertions.
- An allowlist array names today's 31 files. The test fails on new files, and when an allowlisted
  file no longer needs its entry, which ratchets the list down.
- Port T3's detection logic from `oxlint-plugin-t3code/rules/no-polling-loop-in-tests.ts`
  (196 lines, MIT; credit it).
- The conversion target already exists in our code: `waitForFileState` (`daemon-harness.ts:232`)
  and event-driven `waitFor` helpers (`adapters/grok/lifecycle.test.ts:360`).

### 7. Measure, then prune (the lesson of #22557 and the restores). M value, M effort

- First record per-file durations: add `--test-reporter=spec --test-reporter-destination=stdout
  --test-reporter=junit --test-reporter-destination=<pkg>/.test-times.xml` (gitignored).
- After the §0 fix, prune by **time × low signal**, not by count. Thousands of millisecond-scale
  unit tests cost almost nothing next to per-process start-up and the 57 files that spawn
  processes (27 tmux, 45 git).
- Reuse T3's rubric:
  - Delete tests that are type-redundant, mirror mocks, check trivial logic, or assert wall-clock
    perf.
  - Keep protocol translation, auth and permission, persistence and migration, parsing, and race
    fixes.
- Add our own must-keep classes from their restores: secret redaction (`0cb033c5`), permission
  rechecks (`30a405bb`), time-zone and DST math (`12c91aef`), and the only test of a shipped
  primitive (`abffeede`). Require a human to review every deletion in those classes.
- Apply deletions with the TypeScript AST by test title, as T3 did.

### 8. Small desktop and PWA items. Low value, S effort

- **Desktop quit backstop:**
  - In `apps/desktop/src/main.ts:445-454`, race `current.stop()` against a 5 s timer, mirroring
    `apps/daemon/src/cli.ts:18`. On timeout, log "daemon stop stalled" and `app.exit(0)`.
  - The stop path deliberately leaves tmux sessions and the agent host running, so a forced exit
    loses little.
  - Unit-test it through `window-lifecycle.ts` with `mock.timers`.
- **Raise the floor** in `apps/desktop/package.json:37` to `^44.9.3`, so a stale lockfile cannot
  resolve a build that trusts the eMudhra CA.
- **Serialise CDP screenshots per tab** in `apps/daemon/src/browsers.ts:258, 744`: one promise
  chain per tab, reset on `Page.frameNavigated`, and skipped when the tab is detached. Crib
  from T3's `DesktopBrowserHost.ts` diff in `cccb78c4`.
- **PDF picking:** first check whether the daemon browser renders PDFs in Chromium's viewer at
  all. If it does, add T3's `document.contentType === "application/pdf"` overlay branch to
  `PICKER_SCRIPT`.
- **Draft caret and scroll restore:** add optional `selection` and `scrollTop` to the persisted
  `ComposerDraft` (`composer.logic.ts:20`). Tolerant parsing already drops unknown or invalid
  fields. Restore them on mount instead of `focusAtEnd` when they are present.

---

## 3. Skip

- **Electron local-cache installer (#22712).** Electron 44's own `index.js` already installs
  lazily through `@electron/get` and its cache, and we have no curl fallback to replace.
- **Per-provider replay fixture split (#22717).** We already keep replays per adapter.
- **tsc-rs drop-in and typecheck task cache (#23023, #22716, #22735).** The ts-rust plugin
  already sends agent `tsc` runs to tsrs. Add `incremental` only if `pnpm check` time shows up
  after §0.
- **pnpm 12 (#22738).** That is two majors with config migrations, for install seconds we don't
  feel.
- **Frame/transition-wait ban (#22561).** We have no browser test runner.
- **Real-clock-wait rule as a separate rule (#22564).** It is Effect-TestClock-specific; the
  polling guard in §2.6 plus AGENTS.md:116 covers our case.
- **Bulk "Thanos snap" by count (#22557 as executed).** It cost T3 four restore PRs within three
  days, and our time is not in cheap tests. Use §2.7 instead.
- **Unused-patch check in `check:changed` (#23988).** We have no `patchedDependencies`.
- **All native mobile items:**
  - Duo foldable (13 commits);
  - Live Activity / Dynamic Island (`96bae546`);
  - Android composer layout (`05cd55d2`, `a8dba9ca`);
  - iPad alignment (`e0759571`);
  - Clerk SDK bump (`2c8bdf61`);
  - store screenshots (`ff31a2a6`);
  - undo toast placement and swipe-to-discard drafts (`a68e6e97`, `18e27425`, `b295dd83`). They
    depend on swipe and undo infrastructure that report 05 already ranks.
- **Out of this domain:** screen-reader announcements (`eb1510d2`) and other-agent message
  folding (`f054d1b8`) belong to the chat GUI analyst.
