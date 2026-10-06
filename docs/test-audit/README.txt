Repository test cleanup

Base: 21f43b1c6956c9fac8f389cab28c6fbae323775a (main).
Scope: all 477 test files, all 10 executable check files, provider smoke scripts,
repository browser smoke, and support/seams used by those tests. This is an
implemented cleanup with a repository-wide audit, not a recommendations-only audit.

Each area report lists original test names and DELETE / REWRITE / KEEP decisions,
independent requirements, recognizable failures, expected-value evidence, stable
seams, production callers, duplicate owners, risk, and validation. Common six-bar
proofs are explicitly shared where appropriate; named rows identify the distinct
contract/input. Parameterized declarations are identified or expanded in their
area reports. Counts in different area reports use their stated declaration or
runtime-case convention and must not be added indiscriminately.

Report map
  api-chat.txt                 Shared agent-chat API/fold/protocol
  api-config.txt               Other API, workflow grammar, persisted config
  codex-adapter.txt            Codex provider adapter and support
  grok-adapter.txt             Grok provider adapter and support
  claude-opencode.txt          Claude, OpenCode, shared adapter support
  host-orchestration.txt       Agent-host orchestration and recovery
  host-storage.txt             Agent-host store and ingestion
  host-index.txt               Disposable SQLite index
  host-support.txt             Host lifecycle, server, checkpoints, support
  daemon-root.txt              Daemon root, providers, usage checks
  daemon-desktop-chat.txt      Desktop backend and daemon agent-chat bridge
  daemon-profile.txt           Native agent-profile configuration
  daemon-mcp.txt               Public MCP tools and transport
  daemon-workflows.txt         Workflow engine, storage, triggers, execution
  ui-chat-lib.txt              Agent-chat library (other than next two areas)
  ui-chat-rows.txt             Timeline rows, entries, drill-in
  ui-chat-store.txt            Chat store, history, reload and queue delivery
  ui-chat-components.txt       Agent-chat components except composer
  ui-chat-composer.txt         Composer and its executable rendering check
  ui-workflows.txt             Workflow UI and state
  ui-other.txt                 Remaining UI, storage, audio, VNC, checks
  repository-tooling.txt       Deployed browser smoke and active harness support

Independent review corrections
  - Retained full-plan copy/download selection: upstream store tests bypass the
    wrapper and cannot detect selecting a clipped preview.
  - Replaced a noVNC property inventory with actual installed Websock attachment
    and receipt of fixed RFB bytes, preserving the external dependency ABI.
  - Restored audio packet integrity with an independent captured-payload digest;
    packet lengths and TOC bytes alone cannot catch audio corruption.
  - Kept Git stash ISO author dates and distinct originating branches in real-Git
    fixtures, rather than dropping those public response fields.
  - Kept accountless provider cooldown-key derivation through the real workflow
    executor, rather than assuming a preconstructed candidate proves conversion.
  - Preserved exported public API constants and documented asynchronous drains;
    lack of a current runtime import alone is not proof a public contract is dead.
  - Isolated host lifecycle test process markers with per-rig UUIDs so parallel
    tests cannot reap each other's provider child processes.
  - Retained already-verified public results from all nine workflow E2E cases
    outside their disposable appdirs. The artifact follow-up passed 9/9 tests;
    every retained JSON was reopened, checked as 0600 and checked for absence of
    the raw test token. The profile MCP E2E likewise retains redacted responses.

Removed support and production seams
  - Four assertion-free live provider smoke scripts and unused callback replay
    machinery that manufactured the behavior it claimed to verify.
  - Dead fixtures/helpers/options identified by the owning adapter reports;
    referenced protocol provenance captures remain documented evidence.
  - Unused internal index messageSpan query/API/type/forwarder and provider
    snapshot refreshAllNow exposure; active paging and refresh paths remain.
  - Unused planProgress, audio reset/state getters, VNC clock/timing overrides,
    profile backup listing/retention override/non-file rollback branch, and
    private-helper exports used only by tests.
  - Test-only queue cap, model-catalogue and rule-matcher injection knobs.
  The area reports identify exact symbols and caller checks. No product change
  was made to preserve an otherwise unjustified test.

Validation and integration
  Area reports record focused results and clearly label runs that overlapped
  edits or were deliberately interrupted. Final repository gates and build
  verification are recorded below. There is no separate repository lint script
  and no test-count or coverage-threshold conflict.
  Initial pnpm check found opus-decoder absent from this checkout's installed
  dependencies. pnpm install --frozen-lockfile restored 10 locked packages without
  changing dependency declarations or pnpm-lock.yaml; the gate was restarted.
  A later typecheck caught the rewritten Claude callback fixture missing the SDK's
  required requestId and nullable-result narrowing. The fixture now uses its
  captured requestId and asserts a non-null decision; both focused callback cases
  passed. This was a test rewrite error, not a baseline product failure.
  The daemon and UI compiler scans with --noUnusedLocals --noUnusedParameters
  passed after cleanup. No unused local/import/parameter support remains in those
  compiler scopes.
  Final pnpm check passed all seven workspace packages, including both desktop
  and web entry points. Staged git diff --check passed.
  Final pnpm test completed successfully, including every package's executable
  check scripts: config 34, API 416, daemon 4,187, UI 1,269; total 5,906 tests,
  zero failures, cancellations, skips or TODOs. Packages ran sequentially to
  control load on the shared host. Log: /tmp/orquester-cleanup-test.log.
  All ten E2E artifacts from that full run (nine workflow, one profile MCP)
  reopened as valid JSON with mode 0600 and without the raw workflow test token.
  Their paths are indexed in /tmp/orquester-cleanup-e2e-artifacts.json.
  Final pnpm build passed every workspace build, including the emitted web SPA,
  desktop bundles and Linux AppImage. This also typechecked the final workflow
  artifact follow-up. Log: /tmp/orquester-cleanup-build.log.
  Build warnings remain for CJS import.meta, the theme script, large chunks,
  optional binaries for other platforms and desktop packaging metadata/window
  association. These are outside the test cleanup; the build did not fail.
  The packaged Electron application passed real in-memory SQLite and PTY probes
  (ABI 130). Restored the checkout's original native build directories after
  packaging, verified every saved native binary hash, and passed the same probes
  with Node (ABI 115). No dependency or lockfile changes were needed.
  The existing scripts/smoke-web.mjs passed clean-storage and legacy-usage-pref
  scenarios against freshly emitted assets on a temporary loopback static server.
  Both screenshots and results.json were inspected in:
    /var/lib/orquester/tmp/orquester-cleanup-web-artifacts-s8OU5O
  This verifies unauthenticated shell/storage startup, not authenticated workflows
  against the live daemon. No live daemon was started or restarted.
  The final pre-commit fetch found origin/main still equal to the audited base;
  no remote changes or newly introduced remote tests needed reconciliation.
  Reviewed the final source/test diff and staged whitespace checks before commit.

Final diff size (excluding this requested audit documentation):
  71 fewer static test/it declarations (5,865 before; 5,794 after).
  Test/check files: 753 lines added, 1,892 removed; net -1,139 lines.
  Runtime TAP totals differ because suites expand parameterized declarations.
