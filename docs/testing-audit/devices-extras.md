# Incoming device changes: Go agent, desktop, worker and scripts

Baseline `610d3c53` against `923b3a51`. 20 newly introduced named Go test declarations across6 changed/new Go test files. Existing worker/desktop/root-script decisions are reconfirmations/overrides, not added new-test counts.

CONSOLIDATE: **4**, DELETE: **2**, KEEP: **3**, REWRITE: **11**. **5** newly introduced declarations removed; **15** survive. No new declarations added by cleanup.

**Merge:** both assigned conflicts are resolved semantically. Worker keeps its generic browser-event fixture and independent cache seeding; agent tests keep the earlier environment consolidation and delete the incoming private uninstall callback probe. Existing native five-second output-drain protection remains unchanged.

**Removed infrastructure:** Agent.uninstallHook declaration/branch and its mock-driven test.; planRunner/osPlanRunner callback injection; real applyPlan calls native runner functions directly.; Copied DETACH_SCRIPT polling fixture replaced with independent session ready pipe.

**No timing gain is claimed.** Real hangup/drain deadlines remain because they uniquely protect process/output behavior. The session fixture uses an independent pipe receipt instead of copied production polling.

## New-case dispositions

### `apps/box-agent/internal/agent/agent_test.go` — `TestBoxDestroyedUninstallsTheServiceAndStops`

**DELETE** (removed).
The test observes only a counter installed through a new test-only uninstallHook and private stop/exit fields. It never uninstalls a service or deletes credentials; behavior-preserving uninstallation refactors break it. Remove the counter test and hook. Real removeAgentState filesystem and service configuration/planned native-command owners retain their distinct contracts; this invalid test did not independently prove end-to-end uninstall.

### `apps/box-agent/internal/agent/kvm_linux_test.go` — `TestKVMUsableOpensTheDeviceReadWrite`

**REWRITE**.
Actual missing/read-write/read-only filesystem opens establish usable access. Retain mandatory missing/positive assertions under root without marking the entire test skipped; non-root additionally checks real kernel permission refusal.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2.2
- **Credible failure:** Actual missing/read-write/read-only filesystem opens establish usable access. Retain mandatory missing/positive assertions under root without marking the entire test skipped; non-root additionally checks real kernel permission refusal.
- **Independent oracle:** Authored POSIX modes and explicit owner/group/other access expectations; controlled missing and readable/writable files.
- **Stable seam:** Real file opens/stat permissions for the current or specified work identity; sys.info/hello wire compatibility stays in Go/TypeScript golden owners.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/kvm_linux_test.go` — `TestKVMUsableForTheWorkUserFollowsTheModeBits`

**KEEP**.
Authored POSIX owner/group/other mode cases, primary/supplementary membership and owner precedence independently prove whether the actual work identity has both read and write access. A root-only opener would incorrectly allow owner-read-only and nonmember cases.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2.2
- **Credible failure:** Authored POSIX owner/group/other mode cases, primary/supplementary membership and owner precedence independently prove whether the actual work identity has both read and write access. A root-only opener would incorrectly allow owner-read-only and nonmember cases.
- **Independent oracle:** Authored POSIX modes and explicit owner/group/other access expectations; controlled missing and readable/writable files.
- **Stable seam:** Real file opens/stat permissions for the current or specified work identity; sys.info/hello wire compatibility stays in Go/TypeScript golden owners.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/kvm_linux_test.go` — `TestDetectSysInfoReportsKVM`

**DELETE** (removed).
Host-dependent probe repeats the implementation’s real /dev/kvm open and full sys-info collection. On machines without KVM both actual and expected remain false even if reporting is disconnected; there is no controlled positive regression oracle. Access/permission owners plus checked-in Go/TS sys.info/hello goldens retain independently proved access and wire-field compatibility. No fake claim that these prove positive detectSysInfo wiring.

### `apps/box-agent/internal/agent/service_linux_test.go` — `TestServiceDryRunsWriteNothing`

**REWRITE**.
Surviving public InstallServiceCommand/UninstallServiceCommand dry-run owner absorbs real bootstrap redaction and token-file preservation. It independently checks planned config keys/paths while the source token and temp HOME/data directory remain unchanged; remove arbitrary banner/wording assertions.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4
- **Credible failure:** Surviving public InstallServiceCommand/UninstallServiceCommand dry-run owner absorbs real bootstrap redaction and token-file preservation. It independently checks planned config keys/paths while the source token and temp HOME/data directory remain unchanged; remove arbitrary banner/wording assertions.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestSystemUnitIsUnchanged`

**REWRITE**.
Renamed TestSystemUnitPreservesRuntimeAndPathEscaping. Replace the whole-unit copy with independently specified executable/data-dir, restart-on-failure, KillMode=process and boot target settings; preserve literal systemd escaping for spaces, quotes and percent specifiers.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; AGENTS.md process ownership; systemd configuration grammar
- **Credible failure:** Renamed TestSystemUnitPreservesRuntimeAndPathEscaping. Replace the whole-unit copy with independently specified executable/data-dir, restart-on-failure, KillMode=process and boot target settings; preserve literal systemd escaping for spaces, quotes and percent specifiers.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestUserUnit`

**REWRITE**.
Keep user executable/data-dir, shell PATH (including spaces), user boot target, restart and OOM/session ownership settings. Remove complete formatting/template snapshot; missing PATH must not replace the service manager’s default with empty.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; systemd user-service configuration/environment contract
- **Credible failure:** Keep user executable/data-dir, shell PATH (including spaces), user boot target, restart and OOM/session ownership settings. Remove complete formatting/template snapshot; missing PATH must not replace the service manager’s default with empty.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestLaunchAgentPlist`

**CONSOLIDATE**.
Surviving owner decodes XML and checks required semantic keys without forbidding extra compatible settings. Literal LaunchAgents path, launch arguments/GUI identity, failure-only restart, user PATH and logs remain independent. Absorb enable-before-bootstrap, tolerant initial bootout and no destructive kickstart -k; private mkdir/step-count duplication disappears.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; macOS property-list/launchctl GUI service interfaces
- **Credible failure:** Surviving owner decodes XML and checks required semantic keys without forbidding extra compatible settings. Literal LaunchAgents path, launch arguments/GUI identity, failure-only restart, user PATH and logs remain independent. Absorb enable-before-bootstrap, tolerant initial bootout and no destructive kickstart -k; private mkdir/step-count duplication disappears.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestPlanInstallChoosesTheServiceManager`

**REWRITE**.
Renamed TestServicePlansRejectUnsafeInputs. Platform kind-enum table merely duplicated system/user/plist/fallback owners. Retain unique Mac root refusal (GUI-user service required) and newline-in-data-dir refusal, including independently identifiable failure reasons.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; AGENTS.md configuration security
- **Credible failure:** Renamed TestServicePlansRejectUnsafeInputs. Platform kind-enum table merely duplicated system/user/plist/fallback owners. Retain unique Mac root refusal (GUI-user service required) and newline-in-data-dir refusal, including independently identifiable failure reasons.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestPlanInstallSystemd`

**REWRITE**.
Literal native service file paths and required external systemctl operations own root/user/background routing. Remove exact unrelated step order/count, production-constant-derived path expectations and reboot prose; retain user-only path containment and meaningful linger command advice.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; deploy/README.md needrestart/OOM protection
- **Credible failure:** Literal native service file paths and required external systemctl operations own root/user/background routing. Remove exact unrelated step order/count, production-constant-derived path expectations and reboot prose; retain user-only path containment and meaningful linger command advice.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestPlanInstallLaunchAgent`

**CONSOLIDATE** (removed).
Private exact mkdir/command-array replay duplicates generated plist/native action owner. Move only enable-before-bootstrap, initial-unload tolerance and no destructive fresh-process restart into TestLaunchAgentPlist.

Surviving owner: `apps/box-agent/internal/agent/service_plan_test.go: TestLaunchAgentPlist`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestPlanUninstall`

**REWRITE**.
Keep independently named managed paths and native disable/unload operations, privilege refusal, absent-install no-op, best-effort cleanup policy and required remove/disable-before-final-stop ordering. Drop incidental order among independent removals, private kind enums, copy and empty Windows declaration assertions.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4
- **Credible failure:** Keep independently named managed paths and native disable/unload operations, privilege refusal, absent-install no-op, best-effort cleanup policy and required remove/disable-before-final-stop ordering. Drop incidental order among independent removals, private kind enums, copy and empty Windows declaration assertions.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestPrintPlan`

**CONSOLIDATE** (removed).
Exact dry-run prose/file separators and manually tagged secret steps did not verify real command wiring. Public dry-run owner now checks an actual source bootstrap token is never printed, while preserving config identity and no side effects.

Surviving owner: `apps/box-agent/internal/agent/service_linux_test.go: TestServiceDryRunsWriteNothing`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestApplyPlan`

**REWRITE**.
Replace fake runner call arrays with actual temporary directories/file bytes/mode/removal and /bin/sh marker artifacts. Ignored error permits the next real command; strict failure prevents its marker; best-effort still writes cleanup marker while returning failure. Remove planRunner/osPlanRunner injection entirely.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; service install/uninstall failure handling contract
- **Credible failure:** Replace fake runner call arrays with actual temporary directories/file bytes/mode/removal and /bin/sh marker artifacts. Ignored error permits the next real command; strict failure prevents its marker; best-effort still writes cleanup marker while returning failure. Remove planRunner/osPlanRunner injection entirely.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestRemoveAgentState`

**REWRITE**.
Real files prove credential, source bootstrap and agent.env deletion while proc history remains. Bootstrap-token now exists before action; a second removal independently checks idempotence rather than inferring it from a missing initial fixture.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4; AGENTS.md privacy/persistence boundaries
- **Credible failure:** Real files prove credential, source bootstrap and agent.env deletion while proc history remains. Bootstrap-token now exists before action; a second removal independently checks idempotence rather than inferring it from a missing initial fixture.
- **Independent oracle:** Authored paths, runtime-consumed config keys/values, OS-format decoding, literal secret marker and actual file/process results; no expected value is obtained from the service implementation.
- **Stable seam:** Native configuration file contents and explicit OS service commands planned for the public install/uninstall CLI; actual temporary filesystem/child-command effects for the executor, and actual public dry-run output/absence of side effects.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/service_plan_test.go` — `TestServiceEnvWritesNothing`

**CONSOLIDATE** (removed).
Private renderer’s exact full environment/comment/order snapshot and no-write probe duplicate the public dry-run boundary. Move token read/preserve/redaction and meaningful config key/path assertions to that owner.

Surviving owner: `apps/box-agent/internal/agent/service_linux_test.go: TestServiceDryRunsWriteNothing`.

### `apps/box-agent/internal/agent/setsid_linux_test.go` — `TestASetsidProcessOutlivesItsExec`

**REWRITE**.
Retain real exit/channel-close/link-drop process lifetime cases and real hangup escalation. Replace copied production DETACH_SCRIPT/polling with an independent setsid fixture: child reports PID from inside its session on fd3 and closes the readiness pipe before exec; parent waits for that receipt before reporting ready.

- **Independent source:** apps/daemon/src/devices/hosts/box/android-executor.ts spawnDetached lifetime contract; AGENTS.md process/session ownership
- **Credible failure:** Retain real exit/channel-close/link-drop process lifetime cases and real hangup escalation. Replace copied production DETACH_SCRIPT/polling with an independent setsid fixture: child reports PID from inside its session on fd3 and closes the readiness pipe before exec; parent waits for that receipt before reporting ready.
- **Independent oracle:** Observed child PID/session ID and survival/death; independently created processes/ownership records, not a copied daemon script.
- **Stable seam:** Real exec/channel/link actions, OS process/session liveness, durable process ownership recovery and independent ready-pipe receipt.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/internal/agent/setsid_linux_test.go` — `TestARestartLeavesASetsidProcessRunning`

**REWRITE**.
Retain actual recorded-owner recovery: matching recorded process stops while the separate setsid session survives. Independent ready-pipe fixture replaces the copied launcher; OS process/session facts and durable identity state remain the oracle.

- **Independent source:** apps/daemon/src/devices/hosts/box/android-executor.ts spawnDetached lifetime contract; AGENTS.md process/session ownership
- **Credible failure:** Retain actual recorded-owner recovery: matching recorded process stops while the separate setsid session survives. Independent ready-pipe fixture replaces the copied launcher; OS process/session facts and durable identity state remain the oracle.
- **Independent oracle:** Observed child PID/session ID and survival/death; independently created processes/ownership records, not a copied daemon script.
- **Stable seam:** Real exec/channel/link actions, OS process/session liveness, durable process ownership recovery and independent ready-pipe receipt.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/main_test.go` — `TestParseServiceArgs`

**KEEP**.
Literal supported argv forms, spaces, equal syntax and malformed/ambiguous missing-value inputs verify service CLI grammar. In particular --data-dir must not swallow --dry-run and accidentally install for real. No service/system side effect is invoked.

- **Independent source:** apps/box-agent/main.go CLI usage/flag contract; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4
- **Credible failure:** Literal supported argv forms, spaces, equal syntax and malformed/ambiguous missing-value inputs verify service CLI grammar. In particular --data-dir must not swallow --dry-run and accidentally install for real. No service/system side effect is invoked.
- **Independent oracle:** Independently authored argument arrays, field values and usage exit code2.
- **Stable seam:** CLI argv→ServiceOptions grammar and public service dispatcher→usage exit status.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

### `apps/box-agent/main_test.go` — `TestServiceCommandsRejectUnknownFlags`

**KEEP**.
Both public command dispatchers must return usage status2 for an unknown flag even with --dry-run present. Parser-only tests cannot detect dispatcher omission; status is independent and no real installation is attempted.

- **Independent source:** apps/box-agent/main.go CLI usage/exit-code contract; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and §4
- **Credible failure:** Both public command dispatchers must return usage status2 for an unknown flag even with --dry-run present. Parser-only tests cannot detect dispatcher omission; status is independent and no real installation is attempted.
- **Independent oracle:** Independently authored argument arrays, field values and usage exit code2.
- **Stable seam:** CLI argv→ServiceOptions grammar and public service dispatcher→usage exit status.
- **Refactor resistance:** Surviving assertions observe configured OS keys/paths, CLI data, artifacts or lifetime outcomes. Removed assertions pinned template formatting, private callback counts, step inventories or incidental prose. The fixture no longer copies production launcher bytes.
- **Unique protection:** The named row identifies its distinct install/uninstall/configuration/failure/privacy outcome; merged rows name the single surviving stronger owner.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./...`.

## Existing decisions and integration

- `apps/web/test/sw.test.mjs`: **retain prior cleanup**. Upstream replaces private navigation wrappers with fetch event entry. Our generic fetchEvent already does that for all relevant paths, with independent cache-version-free seeding, consolidated cache/click owners and browser timers. Drop duplicate incoming navigation helper; production wrapper inlining preserved.
- `apps/desktop/src/window-lifecycle.test.ts`: **accept upstream deletion; keep FIFO owner**. Upstream removes four private policy-wrapper cases and inlines unchanged behavior in Electron main. Original KEEP judgments for those wrappers are superseded by DELETE: private boolean/trivial branch seam cannot prove Electron event wiring. Existing RendererOutbox FIFO/one-shot test remains.
- `apps/box-agent/internal/agent/exec_unix_test.go`: **preserve prior rewrite**. Keep staged actual wire/credit/child-exit five-second regression and removed drain hooks exactly; this remote round does not touch it.
- `apps/box-agent/src/fixtures.test.ts`: **preserve prior independent goldens**. Keep checked-in golden control/frame decoder owner and private fixture producers. Incoming kvm/uninstall fields enter checked-in Go/TS compatibility records without reintroducing generated-oracle loops.
- `scripts/check-changed.mjs; scripts/ensure-node-native.mjs`: **accept unused-export cleanup; preserve prior tests**. Upstream internalizes TEST_FILE, NATIVE_MODULES, packageDir and pnpmRebuild with no external callers. Keep our semantic real-shell argv oracle/consolidated helper exports and existing native ABI hardlink/verification contracts.
- `apps/web/dev/devices*.{html,tsx}; scripts/convert-device-model.py`: **retain product/developer tooling**. Explicit dev preview surfaces and asset conversion build tool support new device feature workflows; they are not orphaned automated suite infrastructure. They add no required CI test launches. No blanket deletion based on names or geometry.

## Verification and safety

All changed fixtures use temporary directories, owned child processes and independent local shell artifacts. Service dry runs retain actual DryRun=true; never execute install/uninstall for real on the host. The deleted hook test must not fall through into real uninstall. KVM probe only touches temporary regular files, not /dev/kvm. No new daemon/server or live systemctl action is invoked.

gofmt, worker syntax and scoped diff checks passed. Focused validation results follow; repository-wide gates and comparative measurements remain root-owned.

The four desktop policy-wrapper removals are explicit overrides of original `beb7516b` KEEP rows, not additional `610d3c53` tests. Their exact identities are recorded in JSON. The retained FIFO test proves queued delivery only; it is not claimed as coverage of native window visibility/event wiring.

## Changed existing610d body identities (completeness follow-up)

The following six entries identify changed610d bodies of already-audited tests. They overlap earlier declaration ledgers and **do not add six new tests**. Newly introduced Go accounting stays20 declarations:3 KEEP,11 REWRITE,4 CONSOLIDATE,2 DELETE;5 removed/15 survive. This ledger now has26 body-identity rows:5 KEEP,15 REWRITE,4 CONSOLIDATE,2 DELETE.

### `apps/box-agent/internal/agent/agent_test.go:86` — `TestWatchIgnore`

**KEEP.** Authored ignored/allowed path cases retain the Go fs.watch ignore contract across a path segment, wildcard extension and root-relative directory prefix; unrelated siblings must remain visible.

- **Independent source:** packages/api/src/box-protocol.ts fs.watch ignore parameter and documented watcher path-pattern semantics; actual Go watcher is the separate box-side implementation.
- **Credible failure:** Incorrect segment/glob/prefix matching leaks node_modules/log noise or suppresses legitimate sibling/source changes from the remote project.
- **Independent oracle:** Literal /r/node_modules/x/y.js, /r/src/a.log and /r/build/out/z must be ignored; /r/build/keep and /r/src/a.ts must remain allowed. Expectations are authored and do not call another production matcher.
- **Stable seam:** The watcher ignore-policy boundary consumed by both native and polling Go watchers.
- **Refactor resistance:** Asserts matched/allowed paths only, without pending-map state, timers, regex construction or watcher implementation call order.
- **Unique protection:** Host-side matcher tests cannot exercise the independent Go implementation, and channel/watch integrations do not cover all three ignore pattern categories plus allowed sibling boundaries.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./internal/agent`. Covered by the focused validation below.

### `apps/box-agent/internal/agent/service_linux_test.go:41` — `TestOOMPolicyDropInIsWrittenOnce`

**KEEP.** Actual temporary systemd drop-in bytes require [Service]/OOMPolicy=continue, and a repeated identical write reports no change. This protects agent continuity when a child is OOM-killed and avoids unnecessary service-manager reloads.

- **Independent source:** deploy/README.md process-preserving service behavior; systemd OOMPolicy configuration interface; AGENTS.md preserve session/process ownership. Existing OOM child-loss regression is independent of installer helper layout.
- **Credible failure:** Omitting or corrupting OOMPolicy=continue lets systemd stop the box agent and its running sessions when one child is OOM-killed; needless changed=true causes repeated reloads on every start.
- **Independent oracle:** Literal runtime-consumed [Service] and OOMPolicy=continue bytes read from an actual temporary file, plus true on first write/false on repeated write.
- **Stable seam:** On-disk systemd drop-in and changed result consumed by ProtectService before deciding whether to reload the manager.
- **Refactor resistance:** No template/comment/whitespace snapshot, production constant equality, write-call count or private constructor shape is asserted.
- **Unique protection:** Service plan generation alone does not prove actual installed file bytes or idempotent write behavior; needrestart tests cover a different upgrade-triggered restart path.

Validation target: `cd apps/box-agent && GO=/usr/local/go/bin/go node scripts/go.mjs test -race ./internal/agent`. Covered by the focused validation below.

### `apps/web/test/sw.test.mjs:239` — `answers from the network when it comes in time, and caches the shell`

**REWRITE.** A timely real worker fetch result must answer the current navigation and persist the same authored new HTML under the offline shell lookup. Always returning stale data or forgetting to refresh the shell fails. The610d navigation helper refactor is reconciled into the existing generic fetchEvent fixture.

- **Independent source:** README.md Mobile/PWA offline shell workflow; apps/web/public/sw.js documented network-first cache policy and browser Fetch/respondWith/waitUntil contract.
- **Credible failure:** A timely real worker fetch result must answer the current navigation and persist the same authored new HTML under the offline shell lookup. Always returning stale data or forgetting to refresh the shell fails.
- **Independent oracle:** Authored <html>new</html> network body must be returned and then observed in Cache Storage after the event lifetime settles.
- **Stable seam:** Registered same-origin navigation fetch handler, returned response and independently observed Cache Storage contents/event lifetime.
- **Refactor resistance:** No private navigation wrapper or cache-version identifier is called/asserted. Cache is primed through a successful public fetch event; network and time are controlled without specifying the timeout duration.
- **Unique protection:** This case owns the distinct timing/cache availability or explicit rejection outcome named below; the other three navigation cases and asset/click owners cannot detect this distinct failure.

Validation target: `pnpm --filter @orquester/web test`. Covered by the focused validation below.

### `apps/web/test/sw.test.mjs:250` — `serves the cached shell once the timeout passes, and still caches the late answer`

**REWRITE.** A stalled request must remain pending until the controlled deadline, then return the cached old shell; its eventual network response must still refresh the cache through waitUntil. A hung startup or lost late refresh fails. The610d navigation helper refactor is reconciled into the existing generic fetchEvent fixture.

- **Independent source:** README.md Mobile/PWA offline shell workflow; apps/web/public/sw.js documented network-first cache policy and browser Fetch/respondWith/waitUntil contract.
- **Credible failure:** A stalled request must remain pending until the controlled deadline, then return the cached old shell; its eventual network response must still refresh the cache through waitUntil. A hung startup or lost late refresh fails.
- **Independent oracle:** Independent <html>old</html>/<html>new</html> bodies, manually expired timer and externally resolved late fetch; old response now/new cached body afterward.
- **Stable seam:** Registered same-origin navigation fetch handler, returned response and independently observed Cache Storage contents/event lifetime.
- **Refactor resistance:** No private navigation wrapper or cache-version identifier is called/asserted. Cache is primed through a successful public fetch event; network and time are controlled without specifying the timeout duration.
- **Unique protection:** This case owns the distinct timing/cache availability or explicit rejection outcome named below; the other three navigation cases and asset/click owners cannot detect this distinct failure.

Validation target: `pnpm --filter @orquester/web test`. Covered by the focused validation below.

### `apps/web/test/sw.test.mjs:268` — `without a cached shell, waits on the network past the timeout`

**REWRITE.** A cold cache cannot answer merely because the deadline elapsed. The navigation must continue waiting and return the independently supplied slow network body once it arrives. The610d navigation helper refactor is reconciled into the existing generic fetchEvent fixture.

- **Independent source:** README.md Mobile/PWA offline shell workflow; apps/web/public/sw.js documented network-first cache policy and browser Fetch/respondWith/waitUntil contract.
- **Credible failure:** A cold cache cannot answer merely because the deadline elapsed. The navigation must continue waiting and return the independently supplied slow network body once it arrives.
- **Independent oracle:** No response before the manually resolved fetch, even after controlled timer expiry; eventual <html>slow</html> response body.
- **Stable seam:** Registered same-origin navigation fetch handler, returned response and independently observed Cache Storage contents/event lifetime.
- **Refactor resistance:** No private navigation wrapper or cache-version identifier is called/asserted. Cache is primed through a successful public fetch event; network and time are controlled without specifying the timeout duration.
- **Unique protection:** This case owns the distinct timing/cache availability or explicit rejection outcome named below; the other three navigation cases and asset/click owners cannot detect this distinct failure.

Validation target: `pnpm --filter @orquester/web test`. Covered by the focused validation below.

### `apps/web/test/sw.test.mjs:281` — `offline, answers the cached shell, or a network error without one`

**REWRITE.** An explicitly rejected fetch must return the cached shell if available, otherwise the browser error response; returning undefined would violate respondWith and break offline startup. The610d navigation helper refactor is reconciled into the existing generic fetchEvent fixture.

- **Independent source:** README.md Mobile/PWA offline shell workflow; apps/web/public/sw.js documented network-first cache policy and browser Fetch/respondWith/waitUntil contract.
- **Credible failure:** An explicitly rejected fetch must return the cached shell if available, otherwise the browser error response; returning undefined would violate respondWith and break offline startup.
- **Independent oracle:** Authored cached <html>old</html> body or the independent browser Response.error marker on cache miss, after an actual controlled fetch rejection.
- **Stable seam:** Registered same-origin navigation fetch handler, returned response and independently observed Cache Storage contents/event lifetime.
- **Refactor resistance:** No private navigation wrapper or cache-version identifier is called/asserted. Cache is primed through a successful public fetch event; network and time are controlled without specifying the timeout duration.
- **Unique protection:** This case owns the distinct timing/cache availability or explicit rejection outcome named below; the other three navigation cases and asset/click owners cannot detect this distinct failure.

Validation target: `pnpm --filter @orquester/web test`. Covered by the focused validation below.


## Executed focused validation

All targets passed in one exclusive test slot; no skips, failures or native ABI rebuilds.

- From `apps/box-agent`: `GO=/usr/local/go/bin/go node scripts/go.mjs test -race -v ./...` — passed main, internal/agent and internal/wire; no skips; wall 14.33s.
- `pnpm --filter @orquester/desktop test` — passed 38/38, no skips; wall 1.66s.
- `pnpm --filter @orquester/web test` — passed 7/7, no skips; wall 0.58s.
- `node --test scripts/check-changed.test.mjs scripts/deploy-public-url.test.mjs scripts/ensure-node-native.test.mjs deploy/lib/remote-update.test.mjs` — passed 22/22, no skips; wall 1.21s.

The Go agent package took11.475s, including the intentionally retained real drain and hangup boundaries. These final-run values have no comparable before measurement in this workstream; no speedup or CI saving is claimed. The root agent owns remaining full-suite/build gates.
