# Incoming boxes audit

Incoming boxes tests from origin/main 923b3a51, commit 3e4a67dc. Two new declarations; three existing remotely modified identities and four supplemental initial-cleanup identities are listed without double counting.

New declaration dispositions: REWRITE 1; OPTIMIZE 1. No complete test declaration was removed. Three private codec enum assertions were deleted. These existing and supplemental identities are already represented in the initial 710-declaration ledger and must not be counted again.

Incoming Codex trust implementation preserved. Confirmed secretPaths stays private and config-change store retention still prunes only approved/denied/stale, preserving unknown future states.

The follow-up changes four test files with net test LOC −14 relative to the integrated incoming tree. No dependency, fixture file, snapshot or production seam was added. No performance improvement is claimed before measurement.

## apps/daemon/src/boxes/sync/codecs.test.ts:72

**codex-toml: the project trust Codex adds in a box stays there and never reaches the host — REWRITE**

Replaced results compared against other outputs of the same codec with literal parsed TOML documents. Removed repeated in-sync comparisons owned by the service workflow and the generic model executable classification already covered by S6. Input box TOML is independent of toBox output.

- Independent contract: Incoming commit 3e4a67dc (origin/main 923b3a51): Codex's automatic [projects.<directory>].trust_level edits are local to a box; they must not produce approval cards, be reverted by host pushes, or reach the host/another box. Host project trust remains authoritative. AGENTS.md requires preserving unknown persisted fields.
- Regression detected: Host pushes erase box-local trust, the box overrides host-owned trust, host untrust is ignored, approval leaks box trust or loses a host credential/comment, or removing trust also drops an unrelated future project setting.
- Independent oracle: Literal model x/y/z, trusted/untrusted levels, host-only and box-only project names, blank versus original GH_TOKEN, preserved # mine comment, and other=1 in parsed output. No expected result calls a codec.
- Stable seam: Serialized SyncCodec.toBox/toHost and approval-view TOML bytes.
- Refactor resistance: Semantic parsed TOML values do not depend on helper names, traversal or layout. The retained comment is user-authored configuration data preserved during approved rewrites.
- Unique protection: Cheapest owning codec boundary for host trust precedence/untrust and future project-field preservation. The service case owns card/rule/watcher/approval propagation; generic mcp-toml tests cannot distinguish the account-specific trust exception.

## apps/daemon/src/boxes/sync/config-sync.test.ts:947

**the project trust Codex adds in a box makes no change set, is never sent back nor to the host; real edits still are — OPTIMIZE**

Retained the real two-box approval workflow, removed one identical consecutive settled ensureSynced call, and adopted fixture(t) so teardown closes the service before removing its native files.

- Independent contract: Incoming commit 3e4a67dc (origin/main 923b3a51): Codex's automatic [projects.<directory>].trust_level edits are local to a box; they must not produce approval cards, be reverted by host pushes, or reach the host/another box. Host project trust remains authoritative. AGENTS.md requires preserving unknown persisted fields.
- Regression detected: Rule selection uses the generic codec, automatic trust creates executable approval cards or feedback writes, a host edit deletes local trust, or an approved real MCP edit fails to restore host credentials and propagate to the other box.
- Independent oracle: Actual host/box TOML contains literal project names and MCP command, box files exclude the known host secret, pending card has one executable changed file and excludes box trust, and settled passes cause no new write/card receipts.
- Stable seam: BoxConfigSyncService.ensureSynced/turnEnded/decide, published approval cards, and native temporary host/two-box config files.
- Refactor resistance: End state and externally meaningful transfer/card side effects survive codec or watcher refactors; no helper/enum/call-order assertion remains.
- Unique protection: Only integrated owner combines Codex account rule selection, approval-card diff generation, host secret restoration, cross-box watcher propagation and settled no-feedback behavior. Codec tests cannot detect a service routing error.

## apps/daemon/src/boxes/sync/codecs.test.ts:120

**claude-json syncs only MCP servers and project trust, merging into the box CLI's own state — REWRITE**

Incoming host-aware boxView signature adapted; replaced the affected hostView==boxView producer comparison with a literal shareable document for each boundary. Other literal onboarding, local state, host state and approval assertions retained.

- Independent contract: Existing .claude.json sync contract in codecs.ts and ephemeral boxes spec §8.3: synchronize MCP/project policy while account/private usage state remains local; AGENTS.md keeps secrets on host.
- Regression detected: A view includes account usage/private fields, exposes host secrets, drops an MCP/project policy field, or approved edits overwrite host-only state.
- Independent oracle: Literal shareable MCP server command, empty GH_TOKEN and hasTrustDialogAccepted/mcpServers project subset; original literal usage counts, host identity, restored credential and approved fs-mcp server assertions remain.
- Stable seam: Serialized Claude codec delivery, comparison views and approved host bytes.
- Refactor resistance: Parsed JSON semantic values ignore traversal, ordering and private implementation.
- Unique protection: Lowest owner for Claude account/project subset and private state merge; real service tests own propagation. This is an existing identity already counted in boxes.json, not a new declaration.

## apps/daemon/src/boxes/sync/codecs.test.ts:230

**S6: nested process-starting and credential-routing keys make a change executable — KEEP**

Incoming calls supply null to the new host-aware boxView signature for generic JSON/TOML codecs; the independent true/false policy oracle and existing input scenarios are unchanged.

- Independent contract: Agent CLI configuration process-starting, permission-bypass, code-loading and credential routing settings require executable approval, as boxes spec §8.3/S6 and rules.ts policy document.
- Regression detected: Nested NODE_OPTIONS/base URL/marketplace/plugin/permission/provider/shell-environment edits are classified non-executable, or harmless theme/model edits are incorrectly promoted.
- Independent oracle: Literal true or false for independently named security-bearing CLI settings, not computed from the changed key inventory.
- Stable seam: Public SyncCodec.executableKeysChanged on serialized CLI config views.
- Refactor resistance: Input config documents and boolean policy outputs do not depend on traversal or private collaborator shape.
- Unique protection: Cheapest owner distinguishing nested security-bearing keys across CLI formats; real service card tests cover composition for fewer representative inputs. Existing identity already counted in boxes.json.

## apps/daemon/src/boxes/sync/rules.test.ts:53

**include lists keep transcripts, caches, telemetry and state out — REWRITE**

Deleted only three incoming assertions against codex-toml/mcp-toml dispatch enum names. Retained independently named allowed/disallowed provider files. No whole test declaration deleted.

- Independent contract: Boxes spec §8.3 configuration-only allow-lists; AGENTS.md credentials/transcripts privacy; provider CLI config/state path formats.
- Regression detected: Credentials, history, provider cache/state or staged plugin content cross the sync boundary, or supported configuration paths are excluded.
- Independent oracle: Literal known config/state/credential paths with true/false inclusion decisions.
- Stable seam: Sync rule path inclusion policy used by filesystem enumeration.
- Refactor resistance: User-facing CLI paths are compatibility data; assertions do not depend on enum dispatch representation after cleanup.
- Unique protection: Lowest policy seam covers numerous real excluded file kinds; service tests verify actual file operations and cannot cheaply arrange every path. Three removed enum assertions fail stable-seam/refactor-resistance/uniqueness: the new Codex service workflow proves routing.

## Supplemental initial cleanup fixes

- `apps/daemon/src/boxes/sync/config-sync.test.ts` — host watchers push a host edit to a watching box on their own: Use fixture-owned make() rather than constructing an untracked service. The identical relevant dependencies/policy inputs and all assertions remain; every service is closed on failed assertions before native temporary roots are removed.
- `apps/daemon/src/boxes/sync/config-sync.test.ts` — a scope synced through BoxConfigWatches.syncing stays watched: a later host edit reaches the box with no launch: Use fixture-owned make() rather than constructing an untracked service. The identical relevant dependencies/policy inputs and all assertions remain; every service is closed on failed assertions before native temporary roots are removed.
- `apps/daemon/src/boxes/sync/config-sync.test.ts` — S5: a large box file is applied only with the exact bytes its card was made of: Use fixture-owned make() rather than constructing an untracked service. The identical relevant dependencies/policy inputs and all assertions remain; every service is closed on failed assertions before native temporary roots are removed.
- `apps/daemon/src/boxes/sync/transcripts.test.ts` — Claude: new transcripts and sidecars land at the identical host path, through the shared projects link: Add one independently specified serialized directory example inside the existing real copy scenario: /work/repo.name_1 maps to -work-repo-name-1. The fixture previously used the production encoder on both arranged and expected paths.
  Source: Claude SDK transcript directory serialization: installed @anthropic-ai/claude-agent-sdk 0.3.278 sdk.mjs sanitizer converts each non-alphanumeric byte in this ASCII path to a hyphen; provider on-disk compatibility is independently owned by the SDK.
  Regression: Changing Orquester encoding for slashes, dots or underscores makes it look in a directory the provider never writes.
  Oracle: Literal -work-repo-name-1, independent of the production helper.
  Seam: Exported claudeProjectDirName provider path serialization plus existing real transcript pull and sidecar allow/deny outcome.
  Refactor resistance: Serialized provider path bytes are compatibility data; identifier-only renames and behavior-preserving refactors survive.
  Unique protection: No other owner exercises these encoder bytes; the existing copy/routing assertions use its output as fixture data and would otherwise agree with a broken encoder. No new test execution is added.

## Validation

Passed: `git diff --check -- apps/daemon/src/boxes/sync` and TypeScript syntax parsing of all four edited files (zero diagnostics). No test runner was started during the isolated incoming baseline. Subsequent coordinated focused results are below; incoming sync and full integrated tests/typechecks remain parent-owned.

Focused command: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/boxes/sync/codecs.test.ts src/boxes/sync/config-sync.test.ts src/boxes/sync/rules.test.ts src/boxes/sync/transcripts.test.ts`.

## Retained incoming-baseline download failure

The existing native download workflow failed with `The download failed: Premature close` in 30.26 ms. Native tar normally stops at zero archive-end blocks, which can race the Node stdin pipeline before the remote stream ends. The production extraction now uses `--ignore-zeros` to consume the complete bounded stream; stream errors, cancellation and byte-cap checks remain enforced. This behavior is documented by [GNU tar](https://www.gnu.org/software/tar/manual/html_node/Ignore-Zeros.html) and [libarchive](https://raw.githubusercontent.com/libarchive/libarchive/master/tar/bsdtar.1).

The existing real download case now supplies legal zero padding in reusable 64 KiB chunks (1 MiB total) to force backpressure without sleeps. It still verifies real file bytes, executable mode, nested directory contents, refusal states and removal of staging files. No tar argument shape is asserted. This strengthens an existing identity and must not increase test counts. Test LOC +11; production LOC +2.

The two source files pass syntax and diff checks. The full temporary-tools file passes all 25 tests with zero skips/failures. A non-mutating loader removes only the new extraction option: the retained directory assertion then fails with `The download failed: write EPIPE`. This independently verifies the native early-reader-close failure; the message is the broken-pipe variant of the original baseline `Premature close`, not an exact message reproduction. The loader marker proves the intended source transformation ran.

## Coordinated focused validation

- `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-reporter=spec src/boxes/temporary/tools.test.ts` — 25 passed, zero failed/skipped; runner duration 961.19 ms.
- `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/boxes-download-baseline-loader.mjs --test --test-reporter=spec --test-name-pattern='download: a file replaces' src/boxes/temporary/tools.test.ts` — one intended native directory failure (`write EPIPE`), confirming the padded archive protects the repaired owner. No source mutation.
- `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=2 --test-reporter=spec src/boxes/remote/exec/git.test.ts src/boxes/remote/gui/installer.test.ts` — 25 passed, zero failed/skipped; runner duration 1105.28 ms. Real Git watcher: 54.02 ms; controlled installer deadline: 1.85 ms.

Logs: `/tmp/orquester-test-audit/download-normal.log`, `download-mutant.log`, and `download-clock-targets.log`. The root typecheck ran concurrently, so these are correctness samples, not comparable full-suite wall-clock performance measurements. Incoming sync and full integrated repository gates remain root-owned. The exclusive main test slot was returned with no tests left running.

The integrated changed gate found a fixture mismatch in the rewritten Codex case: its new independent box input omitted `# mine`, while the surviving assertion expected that supplied comment to survive approval. The original incoming fixture contained the comment because it used the box delivery output. The independent literal input now explicitly contains it. The assertion remains; no production change was made. Syntax/diff checks pass; the parent owns the rerun.
