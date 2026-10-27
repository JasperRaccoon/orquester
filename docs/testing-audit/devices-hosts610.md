# Devices hosts test cleanup (610d3c53)

Audit source: `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, compared with `923b3a51`. Scope: all 112 registrations across 17 new host test files, plus inspection of three opt-in integration harnesses and their production owners.

Dispositions: KEEP 50, REWRITE 49, CONSOLIDATE 7, DELETE 3, OPTIMIZE 3. Ten executions removed; 102 remain. Net test-file LOC: -77; supporting fixtures/namespace adapter +125; production -87; manual harnesses -4 (overall -43). Shared fixture changes do not add registrations.

Default tests use FakeBoxes/FakeMacBox/FakeMacLink and unique /tmp roots. No paid rental, SSH, real Mac filesystem access or KVM operations. Android fixture runs real local fake processes/loopback servers; cleanup restricted to unique fixture root. Manual android-integration.it.ts, stream-integration.it.ts and simslim.it.ts excluded, never executed.

## Cleanup and infrastructure

- BoxHostFactory host(), androidHost(), sweepIdle() and extension interface; tests now use registered public hosts and production interval with native timers.
- BoxHostDeps now, idleSweep, timing and never-used android passthrough; BoxDeviceHostDeps now/timing/simPoolSize; BoxAndroidHostDeps now/timing/root/localAgentDevice/eagerGolden/gpuModes.
- BoxDeviceHost warmSettled()/poolSettled() and SimPool.settled(); tests observe persisted remote warm marker, ready pool simulators and public busy state.
- Vphone factory hostOptions and host newToken/timing/tuning; bridge tuning; production launch/health/stream defaults unchanged.
- Internalized helper/constants: deviceHostLabel, localAgentDeviceDir, perSimulatorBytes and four resource constants, MAX_REFILL_FAILURES, ORQ_SLIM_PROFILE/SIMSLIM_MIN_IOS, runner/defaultpool timing constants, vphone isVphoneCandidate/logText/assertSafeParams/bootArgIsSet/mapPanelInput/SERVE_SIM_TAG and AVCC validators/envelope/tag constants.
- DEADLINE_MARGIN_MS remains exported: Android production uses the shared deadline contract; REAL_FRAME_MIN_PNG_BYTES remains used by manual real-Mac harness.
- FakeMacBox general boot fixture supplies an already rendered frame. The single boot-logo owner holds small-frame input, verifies its public lease promise remains pending, then supplies rendered input and advances native timers after the external command receipt.
- Factory Date/interval control uses node:test native mock timers; no custom clock/sweep suppression field. Mac default timing objects are private and production values are preserved.
- Android fake SDK process/loopback-server fixture is disposed after each case, preserving isolation and avoiding accumulating mutable processes until file teardown. One nondefault-GPU setup is consolidated into the existing two-lease lifecycle case.
- Remote timeout uses virtual time while observing actual child exit signal for both deadline and caller abort. This detects a removed child-kill even when rejection still works.
- simslim install harness uses fs mkdir/read instead of child mkdir/cat and repeats only the successful cache-hit scenario; negative checksum/platform runs execute once.
- Namespace virtualization is test-only BoxConnection infrastructure: validates canonical temporary root, translates filesystem/command/environment paths, confines direct file operations and refuses unmapped live paths. Existing manual integration harnesses use the same isolated adapter; no new daemon option.
- Vphone host/bridge follow-up from independent reviewer: actual health rejection receipts advance native 2s production clock for retry contract; ordinary hosts are immediately healthy. Streaming tests read one necessary complete MJPEG part / first three AVCC envelopes without changing production stream timing.

Filesystem isolation: No production test-only timing/token/root/pool/sweep hook remains in this scope. The external isolatedDeviceBox test/integration adapter virtualizes standard remote paths into a validated throwaway local root and fails closed before any native operation containing unmapped live paths; direct FS targets and cwd also resolve existing parent symlinks under the canonical root. Controlled exec scripts remain trusted; this is not a general OS sandbox. Production default paths stay unchanged.

## Performance and validation

Root reference baseline: slowest owned file Android9127.51ms and case restart3845.46ms; final isolated Android validation8966.94ms/restart4030.04ms. Final17-file default target9.81s wall; clock repeat4-file targets1.728/1.676s. These baseline/full-cohort vs isolated-target environments are not equivalent paired overall measurements, so no absolute/percentage suite speedup is claimed here. Root owns final comparable whole-repository results. Actual process reattachment/ownership coverage is intentionally retained despite remaining cost.

Executed only static TypeScript parsing and scoped diff review: passed. Host validation completed: 101 pass/0 fail/1 existing missing-bsdtar skip across all 102 declarations, followed by an 8/8 no-skip remote file run using libarchive extracted only under /tmp. Two clock-sensitive repeats pass 37/37 each. Five in-memory mutants fail intended regression assertions. The final bounded namespace symlink guard passed an owned-temp preflight; root will rerun Android/full gates after the last helper and action-oracle changes. Typechecks/full repository gates remain root-owned. Manual real SDK/Mac harnesses were not run.

## Exact test dispositions

Each registration below has an independent source, recognizable regression, independent oracle, stable seam, refactor-resistance rationale and unique owner. Original path/line/name identify the incoming commit; the JSON also records current survivor names/lines. Shared setup optimizations apply to tests without changing otherwise retained behavioral assertions.

### KEEP — `apps/daemon/src/devices/hosts/box-host.test.ts:187`

knows which boxes are device hosts

Known persisted box records → independently selected role/null; catches adopting a foreign box or KVM-less BYO Linux host

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Eligibility gates MAC/iOS vs Linux/KVM and owner opt-in
- **Recognizable regression**: Known persisted box records → independently selected role/null; catches adopting a foreign box or KVM-less BYO Linux host
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known persisted box records → independently selected role/null; catches adopting a foreign box or KVM-less BYO Linux host
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:201`

adopts rented device hosts and own Macs at start, and follows their boxes

Known box IDs, ready/unreachable/removed states and cost; remove incidental label copies and test-only host() lookup

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Adoption synchronously before lease reconcile, box/link/owner changes
- **Recognizable regression**: Known box IDs, ready/unreachable/removed states and cost; remove incidental label copies and test-only host() lookup
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known box IDs, ready/unreachable/removed states and cost; remove incidental label copies and test-only host() lookup
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:237`

quotes a rental from Settings → Devices and the month's spending

Different ios/android lifetimes and known provider IDs/prices; remove repeated helper-level budget matrix owned rental.test

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Rental settings and configured provider are forwarded into public quote
- **Recognizable regression**: Different ios/android lifetimes and known provider IDs/prices; remove repeated helper-level budget matrix owned rental.test
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Different ios/android lifetimes and known provider IDs/prices; remove repeated helper-level budget matrix owned rental.test
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box-host.test.ts:276`

counts what running Macs are committed to until their deadline against the monthly cap

Known live4h+$4.80 fixture and literal30cap; refuses with zero box starts; lower arithmetic tests cannot prove factory record/approval composition

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Running-host committed spend and approval recheck block unauthorized rental
- **Recognizable regression**: Known live4h+$4.80 fixture and literal30cap; refuses with zero box starts; lower arithmetic tests cannot prove factory record/approval composition
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known live4h+$4.80 fixture and literal30cap; refuses with zero box starts; lower arithmetic tests cannot prove factory record/approval composition
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:289`

one caller cancelling stops only its own wait: the shared rental goes on for the others

CANCELLED for caller1, caller2 real ready host ID and one box start; replace object reference identity

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — One cancelled waiter cannot abort shared rental for another chat
- **Recognizable regression**: CANCELLED for caller1, caller2 real ready host ID and one box start; replace object reference identity
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. CANCELLED for caller1, caller2 real ready host ID and one box start; replace object reference identity
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:304`

a failed rented host with no lease goes at once; idle rented hosts are left to the pool (whatever their state)

Use real Node20 prepare failure instead of overriding host.state; known destroyed box IDs, original CLI prerequisite reason and no extra idle destruction

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Failed paid host destroyed; ordinary idle paid hosts left to pool
- **Recognizable regression**: Use real Node20 prepare failure instead of overriding host.state; known destroyed box IDs, original CLI prerequisite reason and no extra idle destruction
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Use real Node20 prepare failure instead of overriding host.state; known destroyed box IDs, original CLI prerequisite reason and no extra idle destruction
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:324`

rents a Mac host: refuses without approval, then rents, prepares and resolves it ready

Known provider/size/lifetime, real installed tool and ready host ID; remove exact progress/copy/purposeNote snapshots and duplicate joined waiter

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Approved rental reaches actual ready host through registered preparer
- **Recognizable regression**: Known provider/size/lifetime, real installed tool and ready host ID; remove exact progress/copy/purposeNote snapshots and duplicate joined waiter
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known provider/size/lifetime, real installed tool and ready host ID; remove exact progress/copy/purposeNote snapshots and duplicate joined waiter
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box-host.test.ts:358`

fails a rental whose box is torn down

Independently supplied setup failure reason; real registry removal during provision distinguishes lost startup from cancelled waiter

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Destroyed rental rejects pending caller with original box failure
- **Recognizable regression**: Independently supplied setup failure reason; real registry removal during provision distinguishes lost startup from cancelled waiter
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independently supplied setup failure reason; real registry removal during provision distinguishes lost startup from cancelled waiter
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box-host.test.ts:366`

never destroys an idle rented host (the pool does); an own Mac's helpers stop after pool.idleTeardownMinutes

Known virtual now/lease transitions, ready beforedeadline and needs-setup after, no box destroyed; lower pool owner does not stop BYO helpers

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Only idle own-machine helpers stop, after pool timeout and no leases
- **Recognizable regression**: Known virtual now/lease transitions, ready beforedeadline and needs-setup after, no box destroyed; lower pool owner does not stop BYO helpers
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known virtual now/lease transitions, ready beforedeadline and needs-setup after, no box destroyed; lower pool owner does not stop BYO helpers
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box-host.test.ts:396`

destroys a rented host on the owner's Destroy and refuses for an own Mac

Known destroyed boxID and reason deleted; own host refuses with typed error; discard exact human destroy message

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals3–6,10; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Owner destroy only applies to paid hosts, never BYO
- **Recognizable regression**: Known destroyed boxID and reason deleted; own host refuses with typed error; discard exact human destroy message
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known destroyed boxID and reason deleted; own host refuses with typed error; discard exact human destroy message
- **Stable seam**: createBoxHostFactory public factory/registered DeviceHost objects, real host prepare over fake BoxConnection
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/android-host.test.ts:115`

prepares a box the device caches restored: nothing installed, hub and agent-device forwarded, the token in no argv or env

Actual401/200 HTTP,600 config, no token argv/env/log, ready/cache-hit; remove direct helper-return/configpath equality and command object restatement

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Restored toolchain is reused, forwarded hub is authenticated, tokens private
- **Recognizable regression**: Actual401/200 HTTP,600 config, no token argv/env/log, ready/cache-hit; remove direct helper-return/configpath equality and command object restatement
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual401/200 HTTP,600 config, no token argv/env/log, ready/cache-hit; remove direct helper-return/configpath equality and command object restatement
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/android-host.test.ts:150`

boots read-only instances from orq-golden with its GPU mode; adb runs with the box's private env; release stops them

Distinct real child PIDs/serials, read-only/snapshot/gpu CLI protocol and live process after stale release; replace private emulators-map mutation with public stalelease release

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Two independent read-only leases inherit recorded GPU and private adb environment; only matching lease stops process
- **Recognizable regression**: Distinct real child PIDs/serials, read-only/snapshot/gpu CLI protocol and live process after stale release; replace private emulators-map mutation with public stalelease release
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Distinct real child PIDs/serials, read-only/snapshot/gpu CLI protocol and live process after stale release; replace private emulators-map mutation with public stalelease release
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:194`

boots cold when the snapshot does not load

Real first fixture process exits on snapshot, second command cold, actual boot result; lower launcher options do not own snapshot retry decision

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Failed snapshot boots cold instead
- **Recognizable regression**: Real first fixture process exits on snapshot, second command cold, actual boot result; lower launcher options do not own snapshot retry decision
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Real first fixture process exits on snapshot, second command cold, actual boot result; lower launcher options do not own snapshot retry decision
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:209`

reattaches after a daemon restart: the same hub and token, the leased emulator kept, an orphan stopped

Actual durable state and process liveness; config/store tests cannot prove process reattachment lifecycle

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Restart reuses token/kept emulator, stops orphan and teardown reaps kept
- **Recognizable regression**: Actual durable state and process liveness; config/store tests cannot prove process reattachment lifecycle
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual durable state and process liveness; config/store tests cannot prove process reattachment lifecycle
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:236`

fails at once without KVM (the box record's report or the probe), naming the reason

Independent no-KVM record and probe cases, PLATFORM_NOT_READY reason plus failed state; no real KVM access required

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — KVM absence fails before installing or launching emulators
- **Recognizable regression**: Independent no-KVM record and probe cases, PLATFORM_NOT_READY reason plus failed state; no real KVM access required
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent no-KVM record and probe cases, PLATFORM_NOT_READY reason plus failed state; no real KVM access required
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:248`

needs ffmpeg: without sudo it asks the owner to install it

Independent probe output, needs-setup state and named libx264 requirement

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Missing ffmpeg without sudo produces repairable readiness failure
- **Recognizable regression**: Independent probe output, needs-setup state and named libx264 requirement
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent probe output, needs-setup state and named libx264 requirement
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:256`

an own machine caps capacity at its owner's setting; refuses boots while tearing down

Known max3/cpus32 config, boot during public teardown rejects, no private state mutation

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — BYO owner capacity cap and teardown exclude new boots
- **Recognizable regression**: Known max3/cpus32 config, boot during public teardown rejects, no private state mutation
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known max3/cpus32 config, boot during public teardown rejects, no private state mutation
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/box/android-host.test.ts:270`

a restored AVD is the cache's: leases boot from its golden with the GPU mode the cache recorded

Move cacheGpu=swangle_indirect fixture and corresponding CLI assertion into two-lease owner; that existing run already verifies restored golden flags

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/box/android-host.test.ts` — boots read-only instances from orq-golden with its GPU mode; adb runs with the box's private env; release stops them.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Cache-recorded nondefault GPU must be forwarded to emulator
- **Recognizable regression**: Move cacheGpu=swangle_indirect fixture and corresponding CLI assertion into two-lease owner; that existing run already verifies restored golden flags
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Move cacheGpu=swangle_indirect fixture and corresponding CLI assertion into two-lease owner; that existing run already verifies restored golden flags
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:283`

an older cache's untuned AVD (no markers), another config or another emulator is not trusted

Known legacy/no-marker, corrupted hash and different emulator-revision files; direct durable marker seam lower than expensive host prepare

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Older/mismatched AVD config and emulator snapshot are not trusted
- **Recognizable regression**: Known legacy/no-marker, corrupted hash and different emulator-revision files; direct durable marker seam lower than expensive host prepare
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known legacy/no-marker, corrupted hash and different emulator-revision files; direct durable marker seam lower than expensive host prepare
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/android-host.test.ts:300`

takes the Linux hosts' own time limit (pool.androidLifetimeMinutes), not the Mac hosts'

Independently different ios600/android90 and provider offer; catches accidentally borrowing Mac lifetime

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.2/6.3/anti-goals; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,6,8; packages/config durable device records — Android provider/size/lifetime comes from platform-specific pool configuration
- **Recognizable regression**: Independently different ios600/android90 and provider offer; catches accidentally borrowing Mac lifetime
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independently different ios600/android90 and provider offer; catches accidentally borrowing Mac lifetime
- **Stable seam**: BoxAndroidHost public prepare/boot/release/dispose over unique temporary scripted SDK and actual local child processes/loopback servers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/android-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/host.test.ts:104`

prepares a fresh Mac: probe, tool install, hub, agent-device, then warms the runner

Actual ready/readiness/configured endpoint and warm-marker+sims cleanup; replace whole private call/progress inventory with required external outcomes

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Fresh Mac prepares pinned runtime and warms runner once
- **Recognizable regression**: Actual ready/readiness/configured endpoint and warm-marker+sims cleanup; replace whole private call/progress inventory with required external outcomes
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual ready/readiness/configured endpoint and warm-marker+sims cleanup; replace whole private call/progress inventory with required external outcomes
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:143`

skips the runner build on a Blacksmith box that restored the runner cache

Independent cached DerivedData directory, no scratchsim work and warmed persisted marker; normal restart tests only cover already-written warm marker

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Restored runner cache avoids rebuild
- **Recognizable regression**: Independent cached DerivedData directory, no scratchsim work and warmed persisted marker; normal restart tests only cover already-written warm marker
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent cached DerivedData directory, no scratchsim work and warmed persisted marker; normal restart tests only cover already-written warm marker
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:152`

never puts a token in argv or env, and writes the agent-device config 0600

Independent fixed hub/agent secrets, actual0600file/0700dir and removal on dispose; command-builder alone cannot prove token propagation

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Tokens stay out argv/env and config readable only by owner
- **Recognizable regression**: Independent fixed hub/agent secrets, actual0600file/0700dir and removal on dispose; command-builder alone cannot prove token propagation
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent fixed hub/agent secrets, actual0600file/0700dir and removal on dispose; command-builder alone cannot prove token propagation
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:173`

skips the install when the cache restored the tools, and reattaches a running hub after a restart

Known cache files and original token/hub reused without install/relaunch; fresh install cannot detect idempotency regression

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Restored tools and running hub survive daemon restart
- **Recognizable regression**: Known cache files and original token/hub reused without install/relaunch; fresh install cannot detect idempotency regression
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known cache files and original token/hub reused without install/relaunch; fresh install cannot detect idempotency regression
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/host.test.ts:188`

boots a lease's simulator: create from the profile, boot, bootstatus, a real frame, serve-sim

Real fake-device state/list result, external simctl create tuple, hub start aftersmall thenlarge frame, public stream; drop exact command/progress/release sequence

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Lease boot uses correct public profile/runtime, waits for rendered frame, attaches and release deletes
- **Recognizable regression**: Real fake-device state/list result, external simctl create tuple, hub start aftersmall thenlarge frame, public stream; drop exact command/progress/release sequence
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Real fake-device state/list result, external simctl create tuple, hub start aftersmall thenlarge frame, public stream; drop exact command/progress/release sequence
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:224`

boots one simulator at a time per host

Two public concurrent boot calls; stable external bootB occurs after frameA, queued state; pure pool cannot prove host boot-slot ownership

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Boots serialize per host to protect CPU
- **Recognizable regression**: Two public concurrent boot calls; stable external bootB occurs after frameA, queued state; pure pool cannot prove host boot-slot ownership
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Two public concurrent boot calls; stable external bootB occurs after frameA, queued state; pure pool cannot prove host boot-slot ownership
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:239`

refuses a profile this Xcode has no simulator for, and cleans up a failed boot

Known unsupported profile and controlled simctl boot refusal, typed error/originalreason, simulator absent; not generic rejection

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Unsupported profile and failed boot refuse and remove partial simulator
- **Recognizable regression**: Known unsupported profile and controlled simctl boot refusal, typed error/originalreason, simulator absent; not generic rejection
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known unsupported profile and controlled simctl boot refusal, typed error/originalreason, simulator absent; not generic rejection
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:251`

deletes leftover simulators of leases that are gone when it prepares

Known old/live/owner simulator IDs and surviving IDs; catches deleting owner devices or leaking orphans

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Restart cleanup removes only stale Orquester lease simulators
- **Recognizable regression**: Known old/live/owner simulator IDs and surviving IDs; catches deleting owner devices or leaking orphans
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known old/live/owner simulator IDs and surviving IDs; catches deleting owner devices or leaking orphans
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/host.test.ts:261`

uploads a zipped build and resolves the .app inside

Known malicious filename + actual returned path, original bytes in sandbox and unpackresult; remove exact list/mkdir/unpack call order

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Uploaded archive name is sandboxed and .app selected
- **Recognizable regression**: Known malicious filename + actual returned path, original bytes in sandbox and unpackresult; remove exact list/mkdir/unpack call order
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known malicious filename + actual returned path, original bytes in sandbox and unpackresult; remove exact list/mkdir/unpack call order
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:273`

refuses an archive with an entry or a link outside it, before unpacking anything

Known crafted listings and INVALID_ARGUMENT/points-outside reason; no mutating unpack commands; real bsdtar lower test owns parser compatibility

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Traversal/symlink archive refusal happens before extraction
- **Recognizable regression**: Known crafted listings and INVALID_ARGUMENT/points-outside reason; no mutating unpack commands; real bsdtar lower test owns parser compatibility
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known crafted listings and INVALID_ARGUMENT/points-outside reason; no mutating unpack commands; real bsdtar lower test owns parser compatibility
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:288`

runs simctl, refuses adb, and reports unreachable while the link is down

simctl exit data, typed adb refusal and public unreachable→ready states

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Only iOS command protocol allowed; disconnect prevents boot until reconnect
- **Recognizable regression**: simctl exit data, typed adb refusal and public unreachable→ready states
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. simctl exit data, typed adb refusal and public unreachable→ready states
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/host.test.ts:301`

streams H.264 on a physical Mac and fails clearly without Node 22

Public stream capability and readiness/error, external transport h264; remove incidental log command/path snapshots owned remote path/flags cases

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Physical Mac selects H264, idle stop closes helpers, unsupported Node fails
- **Recognizable regression**: Public stream capability and readiness/error, external transport h264; remove incidental log command/path snapshots owned remote path/flags cases
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Public stream capability and readiness/error, external transport h264; remove incidental log command/path snapshots owned remote path/flags cases
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/host.test.ts:319`

drains near its box's time limit

Known now/deadline and public drainReason=deadline; phase2 pool owner relies on this boundary

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3/anti-goals/§8; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal6; docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 — Host nearing paid deadline drains visibly
- **Recognizable regression**: Known now/deadline and public drainReason=deadline; phase2 pool owner relies on this boundary
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known now/deadline and public drainReason=deadline; phase2 pool owner relies on this boundary
- **Stable seam**: BoxDeviceHost public host API and stable external BoxConnection/simctl/hub/agent-device boundaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/local-agent-device.test.ts:22`

uses the pinned layout under devicesToolsDir once its install completed

Independent .install-complete bytes missing/wrong/correct plus actual entry file; remove test-only localAgentDeviceDir export and construct fixture at documented path

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/§6.3 toolchain installation contract; devices/README.md — Partial or wrong-version install must be ignored; completed pinned install reused
- **Recognizable regression**: Independent .install-complete bytes missing/wrong/correct plus actual entry file; remove test-only localAgentDeviceDir export and construct fixture at documented path
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent .install-complete bytes missing/wrong/correct plus actual entry file; remove test-only localAgentDeviceDir export and construct fixture at documented path
- **Stable seam**: Real localAgentDeviceEntry/ensureLocalAgentDevice against actual sentinel/entry files in unique temp directory
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/local-agent-device.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### DELETE — `apps/daemon/src/devices/hosts/box/local-agent-device.test.ts:36`

prefers the toolchain's install

Fails independent oracle/unique protection: toolBin stub implements entire asserted selection and ignores requested tool; actual host toolchain reuse and sentinel test remain

Failed bar / consolidation reason: Independent oracle and unique protection: the fake toolBin returns exactly the asserted entry; retained real host command/installed-entry tests prove actual CLI reuse and the sentinel owner proves incomplete-install exclusion.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/§6.3 toolchain installation contract; devices/README.md — Fake toolchain returns exactly the expected entry string
- **Recognizable regression**: Fails independent oracle/unique protection: toolBin stub implements entire asserted selection and ignores requested tool; actual host toolchain reuse and sentinel test remain
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Fails independent oracle/unique protection: toolBin stub implements entire asserted selection and ignores requested tool; actual host toolchain reuse and sentinel test remain
- **Stable seam**: Real localAgentDeviceEntry/ensureLocalAgentDevice against actual sentinel/entry files in unique temp directory
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/local-agent-device.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/remote.test.ts:31`

lays out Blacksmith boxes under the cache paths and own machines under ~/.orquester

Literal independently documented remote cache/owner-home paths and pinned package entry paths

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Cache and BYO state paths remain compatible
- **Recognizable regression**: Literal independently documented remote cache/owner-home paths and pinned package entry paths
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal independently documented remote cache/owner-home paths and pinned package entry paths
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/remote.test.ts:39`

parses the probe

Independent literal wire output and expected Node22/macOS/VM/KVM fields; no expected result derived from parser

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Key=value probe output decodes into readiness/environment data
- **Recognizable regression**: Independent literal wire output and expected Node22/macOS/VM/KVM fields; no expected result derived from parser
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent literal wire output and expected Node22/macOS/VM/KVM fields; no expected result derived from parser
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/remote.test.ts:59`

runs the probe through a box connection

Real readonly OS/Node command output; pure parser fixture cannot catch script field/path/quoting regression

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Probe script actually discovers this execution environment through BoxConnection
- **Recognizable regression**: Real readonly OS/Node command output; pure parser fixture cannot catch script field/path/quoting regression
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Real readonly OS/Node command output; pure parser fixture cannot catch script field/path/quoting regression
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### OPTIMIZE — `apps/daemon/src/devices/hosts/box/remote.test.ts:67`

execRemote collects output, reports exit codes and times out

Independent known shell output+exit3; controlled timer deadline and specific abort reason, real child boundary; replace50ms elapsed wait with virtual timer

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Command result combines stdout/stderr/exit and bounded timeout/abort kill child
- **Recognizable regression**: Independent known shell output+exit3; controlled timer deadline and specific abort reason, real child boundary; replace50ms elapsed wait with virtual timer
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent known shell output+exit3; controlled timer deadline and specific abort reason, real child boundary; replace50ms elapsed wait with virtual timer
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### DELETE — `apps/daemon/src/devices/hosts/box/remote.test.ts:80`

installs exactly the pinned tools

Fails refactor resistance/independent oracle; actual toolchain npm install owners and lock validator cover pinned executable installation, not lexical formatting

Failed bar / consolidation reason: Stable seam, refactor resistance and unique protection: lexical/source-format inventory; executable installer/cache/toolchain owners protect the meaningful independent behavior.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Source strings contain npm flags and copied lockfile pins
- **Recognizable regression**: Fails refactor resistance/independent oracle; actual toolchain npm install owners and lock validator cover pinned executable installation, not lexical formatting
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Fails refactor resistance/independent oracle; actual toolchain npm install owners and lock validator cover pinned executable installation, not lexical formatting
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/remote.test.ts:90`

starts the hub detached, token-gated on a random loopback port, with stdout dropped

Execute generated command against independent temp Node script to prove stdout discarded; retain required external flags/state-env, drop incidental GUI/detach buffer shape

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Hub starts loopback/authenticated, suppressing token-bearing stdout
- **Recognizable regression**: Execute generated command against independent temp Node script to prove stdout discarded; retain required external flags/state-env, drop incidental GUI/detach buffer shape
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Execute generated command against independent temp Node script to prove stdout discarded; retain required external flags/state-env, drop incidental GUI/detach buffer shape
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/remote.test.ts:102`

reads the hub state and the agent-device daemon's answer

Independent literal JSON output/invalidtoken and state-dir/no-idle protocol flags; remove outputTail cosmetic punctuation oracle

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Hub and agent state wire formats supply token/port and private daemon environment
- **Recognizable regression**: Independent literal JSON output/invalidtoken and state-dir/no-idle protocol flags; remove outputTail cosmetic punctuation oracle
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent literal JSON output/invalidtoken and state-dir/no-idle protocol flags; remove outputTail cosmetic punctuation oracle
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/remote.test.ts:221`

a crafted zip, ipa or tarball: only entries that stay inside pass

Actual bsdtar listing of independently assembled archive bytes, typed reason discriminates traversal; unique OS wire compatibility

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Crafted real zip/ipa/tar archive listings accept internal links, reject escaped paths/links
- **Recognizable regression**: Actual bsdtar listing of independently assembled archive bytes, typed reason discriminates traversal; unique OS wire compatibility
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual bsdtar listing of independently assembled archive bytes, typed reason discriminates traversal; unique OS wire compatibility
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/remote.test.ts:245`

listings that disagree, special files, unreadable names and empty archives are refused

Independent invalid listing bytes and exact failure category, complement actual archive format cases

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/6.3/8 security; fixtures/agent-device/README.md; BSD tar listing format and archive containment — Malformed listings/special files/control names fail closed
- **Recognizable regression**: Independent invalid listing bytes and exact failure category, complement actual archive format cases
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent invalid listing bytes and exact failure category, complement actual archive format cases
- **Stable seam**: Pure external protocol builders/parsers plus execRemote on real localBoxConnection and actual bsdtar listings
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/remote.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/rental.test.ts:13`

reads a Blacksmith runner label into size, image and price

Independently documented6vcpu/M4/24GB/$4.8/h240min and explicit12vcpu variant

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 spend approval; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,5; packages/api device settings/box offers — Default Blacksmith runner label yields correct provider quote
- **Recognizable regression**: Independently documented6vcpu/M4/24GB/$4.8/h240min and explicit12vcpu variant
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independently documented6vcpu/M4/24GB/$4.8/h240min and explicit12vcpu variant
- **Stable seam**: Pure public rental/spend calculations over independent settings, offers and persisted records
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/rental.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/rental.test.ts:26`

takes other providers' labels and prices from their offers

Independent AWS offer0.65 and absentoffer null; no remote network

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 spend approval; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,5; packages/api device settings/box offers — Non-Blacksmith offer carries its own label/price and unknown price fails safe
- **Recognizable regression**: Independent AWS offer0.65 and absentoffer null; no remote network
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent AWS offer0.65 and absentoffer null; no remote network
- **Stable seam**: Pure public rental/spend calculations over independent settings, offers and persisted records
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/rental.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/rental.test.ts:34`

needs approval unless the pool's one switch is on and the monthly cap holds (spent + committed + the new host)

Literal80.8/80.81 boundary and4h@$4.8, unknownprice requires approval, legacyiosswitch ignored

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 spend approval; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,5; packages/api device settings/box offers — Standing pool approval applies only within spent+committed+new full lifetime cap
- **Recognizable regression**: Literal80.8/80.81 boundary and4h@$4.8, unknownprice requires approval, legacyiosswitch ignored
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal80.8/80.81 boundary and4h@$4.8, unknownprice requires approval, legacyiosswitch ignored
- **Stable seam**: Pure public rental/spend calculations over independent settings, offers and persisted records
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/rental.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/rental.test.ts:50`

spend: device-host boxes today, this month, and committed until their deadline

Independent timestamps and $6/$10/$4 expected amounts; factory owner does not own arithmetic

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 spend approval; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,5; packages/api device settings/box offers — Only device-host records bill UTC day/month and unspent commitment
- **Recognizable regression**: Independent timestamps and $6/$10/$4 expected amounts; factory owner does not own arithmetic
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent timestamps and $6/$10/$4 expected amounts; factory owner does not own arithmetic
- **Stable seam**: Pure public rental/spend calculations over independent settings, offers and persisted records
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/rental.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:80`

fills each target profile to its size, one simulator at a time

Known2targets×2 counts; remove fake-enforced serialization and exact target-order inventory so concurrency oracle can disagree with pool

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — All enabled target profiles fill once to configured size without concurrent creation
- **Recognizable regression**: Known2targets×2 counts; remove fake-enforced serialization and exact target-order inventory so concurrency oracle can disagree with pool
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known2targets×2 counts; remove fake-enforced serialization and exact target-order inventory so concurrency oracle can disagree with pool
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:92`

hands out a ready simulator of the profile and runtime, then refills

Known independently supplied A/OLD IDs and exact selected runtime; no mock produces selection result

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — Pool hands correct profile/runtime once and deduplicates restart adoption
- **Recognizable regression**: Known independently supplied A/OLD IDs and exact selected runtime; no mock produces selection result
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known independently supplied A/OLD IDs and exact selected runtime; no mock produces selection result
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:105`

never starts a refill while the host is busy; a lease boot preempts one in progress

Controlled idle/abort boundaries, no completed canceled sim and successful later fill; host integration owns cleanup of half-made actual simulator

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — Busy host postpones refills and incoming lease preempts/refill resumes
- **Recognizable regression**: Controlled idle/abort boundaries, no completed canceled sim and successful later fill; host integration owns cleanup of half-made actual simulator
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Controlled idle/abort boundaries, no completed canceled sim and successful later fill; host integration owns cleanup of half-made actual simulator
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:134`

gives up on a profile after repeated failures until reset

Known good/bad outcome fixtures, healthy result and public next after reset; remove exported internal failure constant/log-count oracle

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — Repeated bad profile does not starve healthy target; reset allows retry
- **Recognizable regression**: Known good/bad outcome fixtures, healthy result and public next after reset; remove exported internal failure constant/log-count oracle
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known good/bad outcome fixtures, healthy result and public next after reset; remove exported internal failure constant/log-count oracle
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:147`

stops: no refill starts and one in progress is aborted

Public make abort signal observed and no later operations

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — Stop cancels in-flight work and blocks later kick
- **Recognizable regression**: Public make abort signal observed and no later operations
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Public make abort signal observed and no later operations
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/sim-pool.test.ts:160`

are orq-pool-<profile>.<id>, never a lease's, never listed as devices

Independent persistent name bytes, known ready/prep/lease names and list exclusion

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md pool names/lifecycle; persistent simulator namespace contract — Pool namespace survives restart and never masquerades as lease/device
- **Recognizable regression**: Independent persistent name bytes, known ready/prep/lease names and list exclusion
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent persistent name bytes, known ready/prep/lease names and list exclusion
- **Stable seam**: SimPool public take/adopt/kick/stop/reset operations at external simulator-making port
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/sim-pool.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simctl.test.ts:22`

maps each iOS profile to a simctl device type on the newest runtime that has it

Independent catalog targettuple/fallback/unsupported profile; remove DEVICE_PROFILES declaration inventory

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 profile/newest-runtime/lease naming; simctl JSON compatibility; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md pool privacy — Profile preference selects supported type on newest iOS runtime
- **Recognizable regression**: Independent catalog targettuple/fallback/unsupported profile; remove DEVICE_PROFILES declaration inventory
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent catalog targettuple/fallback/unsupported profile; remove DEVICE_PROFILES declaration inventory
- **Stable seam**: simctl external JSON→target/device parser and public namespace/list transforms
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simctl.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simctl.test.ts:36`

honours a pinned runtime and skips unavailable or non-iOS ones

Independent explicit26vs27 and oldsimctl missing supportedDeviceTypes; fixture values not derived from selector

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 profile/newest-runtime/lease naming; simctl JSON compatibility; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md pool privacy — Pinned runtimes, unsupported types, non-iOS/unavailable runtimes and older catalog schema
- **Recognizable regression**: Independent explicit26vs27 and oldsimctl missing supportedDeviceTypes; fixture values not derived from selector
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent explicit26vs27 and oldsimctl missing supportedDeviceTypes; fixture values not derived from selector
- **Stable seam**: simctl external JSON→target/device parser and public namespace/list transforms
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simctl.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simctl.test.ts:54`

picks the newest iPhone for the runner warm-up

Independent latest phone name and absenttarget; host warmup wires result but does not enumerate empty catalog

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 profile/newest-runtime/lease naming; simctl JSON compatibility; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md pool privacy — Runner warmup gets compatible newest iPhone and no target for empty catalog
- **Recognizable regression**: Independent latest phone name and absenttarget; host warmup wires result but does not enumerate empty catalog
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent latest phone name and absenttarget; host warmup wires result but does not enumerate empty catalog
- **Stable seam**: simctl external JSON→target/device parser and public namespace/list transforms
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simctl.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simctl.test.ts:59`

reads devices and names lease simulators

Independent JSONIDs/runtimeversions and public device identity/profile/bootstate; remove full incidental DTO/display copy snapshot

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 profile/newest-runtime/lease naming; simctl JSON compatibility; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md pool privacy — External simctl devices filter unavailable/non-iOS and distinguish managed leases/scratch
- **Recognizable regression**: Independent JSONIDs/runtimeversions and public device identity/profile/bootstate; remove full incidental DTO/display copy snapshot
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent JSONIDs/runtimeversions and public device identity/profile/bootstate; remove full incidental DTO/display copy snapshot
- **Stable seam**: simctl external JSON→target/device parser and public namespace/list transforms
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simctl.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/box/simctl.test.ts:97`

tells a rendered frame from the boot logo by size

Host boot fixture already emits24k then2.4MB and verifies rendered-frame gating; delete independent constant-threshold/NaN test that restates arbitrary heuristic

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/box/host.test.ts` — boots a lease's simulator: create from the profile, boot, bootstatus, a real frame, serve-sim.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.3 profile/newest-runtime/lease naming; simctl JSON compatibility; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md pool privacy — Boot logo must not count as rendered home screen
- **Recognizable regression**: Host boot fixture already emits24k then2.4MB and verifies rendered-frame gating; delete independent constant-threshold/NaN test that restates arbitrary heuristic
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Host boot fixture already emits24k then2.4MB and verifies rendered-frame gating; delete independent constant-threshold/NaN test that restates arbitrary heuristic
- **Stable seam**: simctl external JSON→target/device parser and public namespace/list transforms
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simctl.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-capacity.test.ts:19`

fits 8 slim or 3 stock simulators on a 24 GB Mac

Literal independent measured policy8/3; remove declarations asserted against exported constants

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; docs/superpowers/research/2026-10-27-devices-spikes.md memory results; documented host admission policy — 24GB resource budget admits8slim or3stock
- **Recognizable regression**: Literal independent measured policy8/3; remove declarations asserted against exported constants
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal independent measured policy8/3; remove declarations asserted against exported constants
- **Stable seam**: simulatorCapacity stable resource-admission decision over independent RAM/lease/measurement inputs
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-capacity.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-capacity.test.ts:26`

is capped by Settings, and is the setting alone when the RAM is unknown

Known cap4/5 and null RAM, literal expected result; remove copiedperSimconstant arithmetic

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; docs/superpowers/research/2026-10-27-devices-spikes.md memory results; documented host admission policy — Settings limit applies even if machine RAM unknown
- **Recognizable regression**: Known cap4/5 and null RAM, literal expected result; remove copiedperSimconstant arithmetic
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known cap4/5 and null RAM, literal expected result; remove copiedperSimconstant arithmetic
- **Stable seam**: simulatorCapacity stable resource-admission decision over independent RAM/lease/measurement inputs
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-capacity.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim-capacity.test.ts:36`

admits only while `top` shows headroom: other simulators' memory counts

Independent0.9/4/2.4GiB measurements and6/3/0headroom; no remaining owner measures per-host resource math

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; docs/superpowers/research/2026-10-27-devices-spikes.md memory results; documented host admission policy — Owner simulators and growing app footprints consume real available admission
- **Recognizable regression**: Independent0.9/4/2.4GiB measurements and6/3/0headroom; no remaining owner measures per-host resource math
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent0.9/4/2.4GiB measurements and6/3/0headroom; no remaining owner measures per-host resource math
- **Stable seam**: simulatorCapacity stable resource-admission decision over independent RAM/lease/measurement inputs
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-capacity.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-capacity.test.ts:56`

budgets what this host's simulators really measure when it is more than the default

Independent1.6/1.4/5GiB actualmeasurement, literal2.5/6GiB budgets and6memorycapacity; remove imported constants/derivedMathfloor oracle and internalize helper

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; docs/superpowers/research/2026-10-27-devices-spikes.md memory results; documented host admission policy — Measured cost above floor lowers admission, mixing stock/slim correctly
- **Recognizable regression**: Independent1.6/1.4/5GiB actualmeasurement, literal2.5/6GiB budgets and6memorycapacity; remove imported constants/derivedMathfloor oracle and internalize helper
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent1.6/1.4/5GiB actualmeasurement, literal2.5/6GiB budgets and6memorycapacity; remove imported constants/derivedMathfloor oracle and internalize helper
- **Stable seam**: simulatorCapacity stable resource-admission decision over independent RAM/lease/measurement inputs
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-capacity.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim-capacity.test.ts:64`

never goes below zero

Independent4GiB belowreservedbudget and cap0; resource protection unique at lowest seam

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; docs/superpowers/research/2026-10-27-devices-spikes.md memory results; documented host admission policy — Insufficient RAM or disabled capacity admits none
- **Recognizable regression**: Independent4GiB belowreservedbudget and cap0; resource protection unique at lowest seam
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent4GiB belowreservedbudget and cap0; resource protection unique at lowest seam
- **Stable seam**: simulatorCapacity stable resource-admission decision over independent RAM/lease/measurement inputs
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-capacity.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:115`

installs simslim and its profile, then fills the pool for the default profile one at a time

Known2slimshutdown simulators, public list empty and ready check; remove copied production profile equality, label/proc-count/order snapshots

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — Pinned simslim/profile creates ready hidden pre-slimmed pool
- **Recognizable regression**: Known2slimshutdown simulators, public list empty and ready check; remove copied production profile equality, label/proc-count/order snapshots
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known2slimshutdown simulators, public list empty and ready check; remove copied production profile equality, label/proc-count/order snapshots
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:139`

boots a lease from the pool (rename, boot; no create, no slimming), verifies it, then refills

Known preexisting pool IDs, leasedname/booted/slim, later2ready pool sims and public8→3capacity; drop whole command sequence

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — Lease consumes ready pool sim and refills, measured capacity obeys updated setting
- **Recognizable regression**: Known preexisting pool IDs, leasedname/booted/slim, later2ready pool sims and public8→3capacity; drop whole command sequence
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known preexisting pool IDs, leasedname/booted/slim, later2ready pool sims and public8→3capacity; drop whole command sequence
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:172`

slims a new simulator while shut down when the pool is empty, and boots it stock if slimming fails

Actual shutdown→slim/booted state and targeted failure boundary; replace simPoolSize test-only hook with legitimate BYO no-pool configuration, drop command inventory

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — Empty pool slims shutdown lease or falls back stock then repairs live
- **Recognizable regression**: Actual shutdown→slim/booted state and targeted failure boundary; replace simPoolSize test-only hook with legitimate BYO no-pool configuration, drop command inventory
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual shutdown→slim/booted state and targeted failure boundary; replace simPoolSize test-only hook with legitimate BYO no-pool configuration, drop command inventory
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:199`

a lease boot preempts a refill in progress, whose half-made simulator is deleted

External held simslim process + actual fake device existence, completed lease and replenished pool; SimPool unit cannot prove host rollback deletion

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — Lease preempts refill and deletes half-created simulator before continuing
- **Recognizable regression**: External held simslim process + actual fake device existence, completed lease and replenished pool; SimPool unit cannot prove host rollback deletion
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. External held simslim process + actual fake device existence, completed lease and replenished pool; SimPool unit cannot prove host rollback deletion
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:221`

after a restart adopts ready pool simulators and deletes half-made or booted ones

Known READY/HALF/USED IDs and consumed READY; remove exact refillcallcount

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — Restart adopts only shut-down ready pool devices, removes partial/booted ones
- **Recognizable regression**: Known READY/HALF/USED IDs and consumed READY; remove exact refillcallcount
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known READY/HALF/USED IDs and consumed READY; remove exact refillcallcount
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim-host.test.ts:234`

keeps no pool on the owner's own Mac, and boots stock where simslim cannot run

Public no pool/stockboot/capacity and checkstate; drop exact tool path/readiness copy duplicates

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; devices/README.md corrected default-set decision; fixtures/simslim/README.md — BYO leaves owner simulator list free of pool; unsupported simslim boots stock
- **Recognizable regression**: Public no pool/stockboot/capacity and checkstate; drop exact tool path/readiness copy duplicates
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Public no pool/stockboot/capacity and checkstate; drop exact tool path/readiness copy duplicates
- **Stable seam**: BoxDeviceHost public lease/list/readiness/capacity over fake external simctl/simslim device state
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim-host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim.test.ts:29`

builds the commands the host runs in the default device set

Literal independent requiredargv on/preserve/no-reboot/verify/top/measure; custom set would not stream through serve-sim

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Default device set and simslim external flags match supported CLI
- **Recognizable regression**: Literal independent requiredargv on/preserve/no-reboot/verify/top/measure; custom set would not stream through serve-sim
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal independent requiredargv on/preserve/no-reboot/verify/top/measure; custom set would not stream through serve-sim
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim.test.ts:41`

writes a profile simslim accepts: known fields only, managed labels kept

Independent allowed externalfields/daemonIDs, remove production ORQ_SLIM_PROFILE.name declaration asserted against itself

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — SlimProfile strict schema and preserved push/links/photos daemons
- **Recognizable regression**: Independent allowed externalfields/daemonIDs, remove production ORQ_SLIM_PROFILE.name declaration asserted against itself
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent allowed externalfields/daemonIDs, remove production ORQ_SLIM_PROFILE.name declaration asserted against itself
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim.test.ts:50`

gates on iOS 18.5, the first runtime whose overrides persist

Known externaltool documented compatibility boundary18.4vs18.5plusnewversions

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Persistent slimming supported from iOS18.5 onward
- **Recognizable regression**: Known externaltool documented compatibility boundary18.4vs18.5plusnewversions
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known externaltool documented compatibility boundary18.4vs18.5plusnewversions
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/box/simslim.test.ts:55`

parses `top --json` (TopOutput)

Independent fixture bytes/totals and known per-sim values; remove parsedtotal derived from parsedchildren tautology

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Recorded TopOutput decodes measured/slim/stock/unreadable and empty states
- **Recognizable regression**: Independent fixture bytes/totals and known per-sim values; remove parsedtotal derived from parsedchildren tautology
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent fixture bytes/totals and known per-sim values; remove parsedtotal derived from parsedchildren tautology
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim.test.ts:84`

parses `verify --json` (VerifyResult)

Independent fixture observedprotocol values and false malformed result

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — VerifyResult success and drift preserve missing/extra service IDs
- **Recognizable regression**: Independent fixture observedprotocol values and false malformed result
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent fixture observedprotocol values and false malformed result
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/box/simslim.test.ts:95`

reads the install script's answer

Independent external script response bytes and pinnedknownversion; host orchestration does not enumerate nonpinned parse

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Install output distinguishes supported pinned/old/unsupported versions
- **Recognizable regression**: Independent external script response bytes and pinnedknownversion; host orchestration does not enumerate nonpinned parse
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent external script response bytes and pinnedknownversion; host orchestration does not enumerate nonpinned parse
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### OPTIMIZE — `apps/daemon/src/devices/hosts/box/simslim.test.ts:136`

downloads the pinned release once, checks its SHA-256, and reports the version

Actual shell over known fixturetar+stubdownload/checksum; fs mkdir/read replace child processes and onlysuccess repeats script

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Pinned release installed once with checksum gate and cache reuse
- **Recognizable regression**: Actual shell over known fixturetar+stubdownload/checksum; fs mkdir/read replace child processes and onlysuccess repeats script
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Actual shell over known fixturetar+stubdownload/checksum; fs mkdir/read replace child processes and onlysuccess repeats script
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### OPTIMIZE — `apps/daemon/src/devices/hosts/box/simslim.test.ts:145`

refuses a release whose checksum differs, and skips Macs it cannot run on

Independentbadchecksum/OS/arch cases; avoid unconditional duplicate installer executions for failures/platform skips

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Corrupt checksum rejected for correct reason, unsupported platform skips download
- **Recognizable regression**: Independentbadchecksum/OS/arch cases; avoid unconditional duplicate installer executions for failures/platform skips
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentbadchecksum/OS/arch cases; avoid unconditional duplicate installer executions for failures/platform skips
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### DELETE — `apps/daemon/src/devices/hosts/box/simslim.test.ts:156`

is part of the macOS device-tools cache and its key

Fails stable seam/independent oracle: formatting/signature inventory and helper output pattern; box workflow/cache owner protects actual executable cache behavior

Failed bar / consolidation reason: Stable seam, refactor resistance and unique protection: lexical/source-format inventory; executable installer/cache/toolchain owners protect the meaningful independent behavior.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goal7; fixtures/simslim/README.md and external simslim0.13 CLI/schema; pinned release installer integrity — Source-grep contains Darwin/hash and cachekey regex
- **Recognizable regression**: Fails stable seam/independent oracle: formatting/signature inventory and helper output pattern; box workflow/cache owner protects actual executable cache behavior
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Fails stable seam/independent oracle: formatting/signature inventory and helper output pattern; box workflow/cache owner protects actual executable cache behavior
- **Stable seam**: External simslim argv/profile/JSON protocol and actual install shell with controlled download/checksum commands
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/box/simslim.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts:61`

ui.tree renders as compact @eN lines and keeps each ref's frame

Independent captured-shaped UI tree; retain known refs/semantic lines, drop full cosmetic snapshot/noelement wording

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals4/safety; external vphoned rpc-methods/ui.tree protocol — ui.tree refs preserve usable frame/role/label and disabled state
- **Recognizable regression**: Independent captured-shaped UI tree; retain known refs/semantic lines, drop full cosmetic snapshot/noelement wording
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent captured-shaped UI tree; retain known refs/semantic lines, drop full cosmetic snapshot/noelement wording
- **Stable seam**: performVphoneAction public host adapter at stable vphoned RPC method/parameter boundary; public VphoneGuestClient for safety
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/agent-actions.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts:71`

snapshot, then ref taps: a unique identifier taps the element, else the frame's center

IndependentUI_TREEIDs/pointsandRPCparams; remove summary/targetcopy while preserve physical input coordinates as protocol data

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals4/safety; external vphoned rpc-methods/ui.tree protocol — Ref taps target unique identifier or frame center, fill types after tap, stale ref refuses
- **Recognizable regression**: IndependentUI_TREEIDs/pointsandRPCparams; remove summary/targetcopy while preserve physical input coordinates as protocol data
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. IndependentUI_TREEIDs/pointsandRPCparams; remove summary/targetcopy while preserve physical input coordinates as protocol data
- **Stable seam**: performVphoneAction public host adapter at stable vphoned RPC method/parameter boundary; public VphoneGuestClient for safety
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/agent-actions.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts:96`

each action kind maps onto its vphoned method; unsupported kinds say so

Retain actual RPC methods, caller-supplied coordinate forwarding, explicit milliseconds-to-seconds units, documented60-second logs cap, numeric directional endpoints with correct direction and screen bounds, image/log bytes and typed unsupported errors. Remove independently unspecified max_elements400, max_lines300, default0.3-second/30%-screen geometry and generated launch wording. Alternate log output still flows through the action owner.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals4/safety; external vphoned rpc-methods/ui.tree protocol — Every supported action sends correct safe RPC units/data and maps typed output; unsupported operations refuse
- **Recognizable regression**: Independent external method/param contracts, JPEG bytes/log lines/limits and typedrefusals; remove wording and consolidate outputlog compatibility
- **Independent oracle**: Known user inputs/external protocol methods,60-second public cap, exact supplied IPA/JPEG/log bytes, upward direction and independently supplied402×874screen bounds. No expected default viewport fraction, element/line cap or swipe duration is copied from implementation.
- **Stable seam**: performVphoneAction public host adapter at stable vphoned RPC method/parameter boundary; public VphoneGuestClient for safety
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/agent-actions.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts:153`

force methods are never sent

Replace direct private assertSafeParams test by VphoneGuestClient.call→VphoneRpcError(code=refused); fake actiontarget must not implement guard being tested

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals4/safety; external vphoned rpc-methods/ui.tree protocol — Client refuses force operations before network transmission
- **Recognizable regression**: Replace direct private assertSafeParams test by VphoneGuestClient.call→VphoneRpcError(code=refused); fake actiontarget must not implement guard being tested
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Replace direct private assertSafeParams test by VphoneGuestClient.call→VphoneRpcError(code=refused); fake actiontarget must not implement guard being tested
- **Stable seam**: performVphoneAction public host adapter at stable vphoned RPC method/parameter boundary; public VphoneGuestClient for safety
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/agent-actions.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts:158`

log text tolerates other result shapes

Move output-field fixture through performVphoneAction logs owner; remove internal logText export/directhelper execution

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/vphone/agent-actions.test.ts` — each action kind maps onto its vphoned method; unsupported kinds say so.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals4/safety; external vphoned rpc-methods/ui.tree protocol — Alternate logs result shape still returns original log bytes
- **Recognizable regression**: Move output-field fixture through performVphoneAction logs owner; remove internal logText export/directhelper execution
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Move output-field fixture through performVphoneAction logs owner; remove internal logText export/directhelper execution
- **Stable seam**: performVphoneAction public host adapter at stable vphoned RPC method/parameter boundary; public VphoneGuestClient for safety
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/agent-actions.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:66`

stream.avcc: vphone frames arrive as serve-sim envelopes the panel decodes

Known fixed description/key/delta bytes and required requestfields; preserve socketcomposition, trim repeated all-delta replay

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — Streaming translates frame wire and sends valid authenticated no-Origin requests
- **Recognizable regression**: Known fixed description/key/delta bytes and required requestfields; preserve socketcomposition, trim repeated all-delta replay
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known fixed description/key/delta bytes and required requestfields; preserve socketcomposition, trim repeated all-delta replay
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:88`

stream.mjpeg: screenshots as multipart parts

Literal independent multipartheaders/boundary/contentlength and fixture JPEG; purehelper alone cannot prove endpoint/transport

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — MJPEG fallback delivers correct multipart content and JPEG bytes
- **Recognizable regression**: Literal independent multipartheaders/boundary/contentlength and fixture JPEG; purehelper alone cannot prove endpoint/transport
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal independent multipartheaders/boundary/contentlength and fixture JPEG; purehelper alone cannot prove endpoint/transport
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:97`

POST /vendor/serve-sim/api/screenshot?device=: one JPEG of that device (the fleet thumbnail)

Known requestdevice/token and200/400/404/401/405plusactualthumbnail path; no fallback to firstbooteddevice

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — Explicit device screenshot endpoint serves JPEG, auth, routing/method validation and fleet client integration
- **Recognizable regression**: Known requestdevice/token and200/400/404/401/405plusactualthumbnail path; no fallback to firstbooteddevice
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Known requestdevice/token and200/400/404/401/405plusactualthumbnail path; no fallback to firstbooteddevice
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:115`

every bridge request needs the bridge token; unknown devices and paths are 404

Literal401/404 and wrong guesttoken; replace generic rejectedWSconnection by exact401 status to prevent falsepositive network error

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — Bridge token gates HTTP and WS; foreign token/device/path refused
- **Recognizable regression**: Literal401/404 and wrong guesttoken; replace generic rejectedWSconnection by exact401 status to prevent falsepositive network error
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Literal401/404 and wrong guesttoken; replace generic rejectedWSconnection by exact401 status to prevent falsepositive network error
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:129`

the input socket admits, sends the screen config, and relays touches, buttons, keys and text in order

Independentbinarytags/RPCparamsandknownsequence; absorb malformed/clipped/lock/doublehome boundaries from private mapping test

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — Input websocket forwards normalized safe input in order and collapses moves
- **Recognizable regression**: Independentbinarytags/RPCparamsandknownsequence; absorb malformed/clipped/lock/doublehome boundaries from private mapping test
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentbinarytags/RPCparamsandknownsequence; absorb malformed/clipped/lock/doublehome boundaries from private mapping test
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/vphone/bridge.test.ts:179`

panel input mapping

Move uniquecases into existing actual websocket owner; remove private mapPanelInput export/directtest and length-only doublehome assertion

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/vphone/bridge.test.ts` — the input socket admits, sends the screen config, and relays touches, buttons, keys and text in order.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goals3/4; serve-sim/vphoned screen+events wire protocol; P1auth/anti-goals — Panel input validation/clamping/safe button mapping
- **Recognizable regression**: Move uniquecases into existing actual websocket owner; remove private mapPanelInput export/directtest and length-only doublehome assertion
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Move uniquecases into existing actual websocket owner; remove private mapPanelInput export/directtest and length-only doublehome assertion
- **Stable seam**: Real loopback HTTP/WS bridge and actual VphoneGuestClient→independent fake vphoned server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/bridge.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/vphone/factory.test.ts:50`

only bring-your-own Macs marked for devices AND switched to research iPhones become vphone hosts

Move badprovider/linux/pairing/deviceHostoff/settings-off rows into actual factory registry fixture; internalize isVphoneCandidate rather than preserving export-onlyunit

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/vphone/factory.test.ts` — the factory follows the box registry and the settings.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and§2.3 owner opt-in; runtime factory synchronously registers only eligible machines — Only enabled BYO Macs marked for devices become research hosts
- **Recognizable regression**: Move badprovider/linux/pairing/deviceHostoff/settings-off rows into actual factory registry fixture; internalize isVphoneCandidate rather than preserving export-onlyunit
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Move badprovider/linux/pairing/deviceHostoff/settings-off rows into actual factory registry fixture; internalize isVphoneCandidate rather than preserving export-onlyunit
- **Stable seam**: createVphoneHostFactory settingsChanged/start/registry events and registered public DeviceHost summaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/factory.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/factory.test.ts:61`

the factory follows the box registry and the settings

Knownvphone:a ID, kind/cost/boxmetadata and realregistrychanges; remove exact humanlabel and use config createDefaultDevicesSettingsFile().settings; failure-safe cleanup

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 and§2.3 owner opt-in; runtime factory synchronously registers only eligible machines — Owner settings/box changes add/remove public research hosts and stop unsubscribes
- **Recognizable regression**: Knownvphone:a ID, kind/cost/boxmetadata and realregistrychanges; remove exact humanlabel and use config createDefaultDevicesSettingsFile().settings; failure-safe cleanup
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Knownvphone:a ID, kind/cost/boxmetadata and realregistrychanges; remove exact humanlabel and use config createDefaultDevicesSettingsFile().settings; failure-safe cleanup
- **Stable seam**: createVphoneHostFactory settingsChanged/start/registry events and registered public DeviceHost summaries
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/factory.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:85`

a ready Mac: the summary carries the research notice; a lease clones, launches, forwards and boots a VM

KnownleaseID/OS/screen units/stream, safeexternal launchargs, no token argv/log/progress/summary and device lease mapping; remove importednotice equality, incidental query/command/progress inventory

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Ready research host clones independent lease VM, launches privately and forwards healthy guest
- **Recognizable regression**: KnownleaseID/OS/screen units/stream, safeexternal launchargs, no token argv/log/progress/summary and device lease mapping; remove importednotice equality, incidental query/command/progress inventory
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. KnownleaseID/OS/screen units/stream, safeexternal launchargs, no token argv/log/progress/summary and device lease mapping; remove importednotice equality, incidental query/command/progress inventory
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:129`

agent actions and installs go to the VM's vphoned; release stops and deletes the clone

IndependentUIframe/knownIPAbytes/appID and actual guestRPC,600tokenrecord/forward/process cleanup; remove exact copy and redundant proc.release collaborator shape

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Guest actions/upload/install lifecycle and release delete only owned clone
- **Recognizable regression**: IndependentUIframe/knownIPAbytes/appID and actual guestRPC,600tokenrecord/forward/process cleanup; remove exact copy and redundant proc.release collaborator shape
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. IndependentUIframe/knownIPAbytes/appID and actual guestRPC,600tokenrecord/forward/process cleanup; remove exact copy and redundant proc.release collaborator shape
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/host.test.ts:178`

a release before the first probe finds vphone-cli first and deletes the clone

Independentpreexistingrecordwithlease7, publicrelease and absentfile; normal bootrelease has cachedCLI

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Early release before readiness probes still finds CLI and deletes durable owned clone
- **Recognizable regression**: Independentpreexistingrecordwithlease7, publicrelease and absentfile; normal bootrelease has cachedCLI
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentpreexistingrecordwithlease7, publicrelease and absentfile; normal bootrelease has cachedCLI
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:189`

released while the Mac is offline, or a delete that failed: a tombstone (no token) until the next check deletes the clone

Independentdurablerecordbytes/600mode and fakebusyCLIreason, eventualphysicalrecordremoval; replace exact generatedlog copy synchronization with suppliedbusyreason

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Offline/failed deletion persists token-free tombstone then retries on reconnect
- **Recognizable regression**: Independentdurablerecordbytes/600mode and fakebusyCLIreason, eventualphysicalrecordremoval; replace exact generatedlog copy synchronization with suppliedbusyreason
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentdurablerecordbytes/600mode and fakebusyCLIreason, eventualphysicalrecordremoval; replace exact generatedlog copy synchronization with suppliedbusyreason
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:228`

a failed clone: it is deleted, the error is readable and carries no token

KnownbusytemplateCLIreasonanddelete/no-launch; rename overclaimed token assertion in title (no token was launched in this path)

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Clone failure deletes partial VM and exposes original CLI error
- **Recognizable regression**: KnownbusytemplateCLIreasonanddelete/no-launch; rename overclaimed token assertion in title (no token was launched in this path)
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. KnownbusytemplateCLIreasonanddelete/no-launch; rename overclaimed token assertion in title (no token was launched in this path)
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/host.test.ts:242`

not ready: boot refuses with the failing check; ensureReady names every fix

Independentlydisabledresearchguestsoutput, typednotready and csrutilcommand; no automaticsecuritychanges

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Research readiness fails closed and provides manual SIP fix
- **Recognizable regression**: Independentlydisabledresearchguestsoutput, typednotready and csrutilcommand; no automaticsecuritychanges
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentlydisabledresearchguestsoutput, typednotready and csrutilcommand; no automaticsecuritychanges
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:251`

the template setup job runs vphone-cli through sudo -n and turns stage banners into progress

Knownsourcepaths/HTTPSbytes,sudo-nargsandactualrecordedstage log/donestate; remove exact translated labelcopy

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Authorized template repair uses noninteractive sudo with safe sources and reports progress completion
- **Recognizable regression**: Knownsourcepaths/HTTPSbytes,sudo-nargsandactualrecordedstage log/donestate; remove exact translated labelcopy
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Knownsourcepaths/HTTPSbytes,sudo-nargsandactualrecordedstage log/donestate; remove exact translated labelcopy
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/host.test.ts:293`

the template job refuses an IPSW source vphone-cli could read as an option, before anything runs

Independent --help source, typedINVALID_ARGUMENT/reason and zero sudoexecs; directCLIargs must not become attackeroption

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Option-like IPSW source rejected before elevation
- **Recognizable regression**: Independent --help source, typedINVALID_ARGUMENT/reason and zero sudoexecs; directCLIargs must not become attackeroption
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independent --help source, typedINVALID_ARGUMENT/reason and zero sudoexecs; directCLIargs must not become attackeroption
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/host.test.ts:313`

after a restart the host reattaches to a running VM from its record

IndependentpreexistingrecordandactualHTTPsnapshotrefs; remove full cosmeticrenderedtext equality

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 lifecycle/secret/VM safety; durable research VM record format; P1restart and upload containment — Restart reattaches durable VM token/forward and permits real guest action without launch
- **Recognizable regression**: IndependentpreexistingrecordandactualHTTPsnapshotrefs; remove full cosmeticrenderedtext equality
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. IndependentpreexistingrecordandactualHTTPsnapshotrefs; remove full cosmeticrenderedtext equality
- **Stable seam**: VphoneDeviceHost public prepare/boot/actions/install/release/restart over fake Mac BoxConnection and real local vphoned HTTP server
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/host.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:22`

vphone-cli is found at $VPHONE_CLI_PATH, on PATH, in the Homebrew prefixes, else through Launchpad

Exercise actual probeVphoneHost discovery through controlled external printenv/which/test command results; internalize locateVphoneCli. Expected paths/prefix/null remain independently supplied.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — VPHONE_CLI_PATH/Homebrew/Launchpad discovery and execution prefix
- **Recognizable regression**: Knownindependentenvironmentpaths/executablefixtureandnullwhenabsent; actualprobe calls helpers but cannot enumeratepathpriority
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Knownindependentenvironmentpaths/executablefixtureandnullwhenabsent; actualprobe calls helpers but cannot enumeratepathpriority
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:33`

host checks read captured outputs, each failure names its exact fix

Independentcapturedoutputsandsecurityfixcommandbytes; remove genericcopy/assertbootArghelper directseam, move missingCLI remediation from inventory

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — macOS/physical/SIP/AMFI readiness with exact actionable commands and no autofix
- **Recognizable regression**: Independentcapturedoutputsandsecurityfixcommandbytes; remove genericcopy/assertbootArghelper directseam, move missingCLI remediation from inventory
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentcapturedoutputsandsecurityfixcommandbytes; remove genericcopy/assertbootArghelper directseam, move missingCLI remediation from inventory
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:63`

the template check: ok with a current template or the base machine; otherwise a fix action only when Orquester can build it

Independenttemplate/base/source/elevationfixtureandfixid; actualhost happy flow does not enumerateownerpermissiongates

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — Template source readiness distinguishes valid/stale/base and only offers build if allowed
- **Recognizable regression**: Independenttemplate/base/source/elevationfixtureandfixid; actualhost happy flow does not enumerateownerpermissiongates
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independenttemplate/base/source/elevationfixtureandfixid; actualhost happy flow does not enumerateownerpermissiongates
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:76`

evaluate: every check in order

Remove exact six-check ordering inventory. Transfer every required safety gate and missing-CLI fix into the existing host-check owner using independent unsafe probe outputs and public readiness states, so omitted AMFI/SIP/VM/OS/template gates still fail.

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/vphone/readiness.test.ts` — host checks read captured outputs, each failure names its exact fix.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — Every readiness ID/state is inventoried in an exact order
- **Recognizable regression**: Failsrefactorresistance/uniqueness; individualreadinesschecks+actualprobe/hostownpublicreadinesscomposition; move unique missingCLI command to retainedcheckowner
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Failsrefactorresistance/uniqueness; individualreadinesschecks+actualprobe/hostownpublicreadinesscomposition; move unique missingCLI command to retainedcheckowner
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: Existing host-check owner now also verifies required security gates are present in the assembled public readiness result; ordering has no contract.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:100`

probe: runs each command without a shell over the box link

KnownFakeMacLink externaloutputs/CLI IDs and commandwhitelistnoshell; individualparsers cannot catch commandwiring

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — Probe runs external commands without shell and yields ready public result
- **Recognizable regression**: KnownFakeMacLink externaloutputs/CLI IDs and commandwhitelistnoshell; individualparsers cannot catch commandwiring
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. KnownFakeMacLink externaloutputs/CLI IDs and commandwhitelistnoshell; individualparsers cannot catch commandwiring
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/readiness.test.ts:112`

vphone-cli outputs: lists, the API address, stage banners

IndependentJSON/linefixturesandnamesanitization; remove internaltranslatedstageindex and selfslice oracle

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 readiness/manual fixes; externalvphoneCLIenv/location/schema and macOSsecuritycommandoutputs — Observed CLI lists/API addresses/stages/names parsed safely
- **Recognizable regression**: IndependentJSON/linefixturesandnamesanitization; remove internaltranslatedstageindex and selfslice oracle
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. IndependentJSON/linefixturesandnamesanitization; remove internaltranslatedstageindex and selfslice oracle
- **Stable seam**: External probe-output→public readiness checks, actual probeVphoneHost BoxConnection commands and vphone CLI parsers
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/readiness.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### KEEP — `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts:9`

requests carry every field vphone requires (bitrate included)

IndependentexplicitJSONfieldvaluesincludingbitrate/key; catches omittedrequiredfield

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goal3; externalvphonehostscreenlittle-endianwire; serve-simavccbig-endianwire — Required screen request fields/units serialized for vphone
- **Recognizable regression**: IndependentexplicitJSONfieldvaluesincludingbitrate/key; catches omittedrequiredfield
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. IndependentexplicitJSONfieldvaluesincludingbitrate/key; catches omittedrequiredfield
- **Stable seam**: Public screen request encoder/reply decoder/converter over independently built fixed wire fixtures
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/screen-protocol.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts:20`

an answer is a little-endian header length, the JSON header, then the access unit

Knownfixtureheader/payload/error and explicitmalformedbytes; remove assertion verifying fixture encodeScreenReply implementation itself

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goal3; externalvphonehostscreenlittle-endianwire; serve-simavccbig-endianwire — Replies decode little-endian JSONheader+payload/error and reject malformedbytes
- **Recognizable regression**: Knownfixtureheader/payload/error and explicitmalformedbytes; remove assertion verifying fixture encodeScreenReply implementation itself
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Knownfixtureheader/payload/error and explicitmalformedbytes; remove assertion verifying fixture encodeScreenReply implementation itself
- **Stable seam**: Public screen request encoder/reply decoder/converter over independently built fixed wire fixtures
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/screen-protocol.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts:39`

frames become the serve-sim envelopes the panel's demuxer reads, byte for byte

Independentliteralbigtagbytesandknownpayloads; remove extra test-demux replay and reimplementedUIcodec calculation

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goal3; externalvphonehostscreenlittle-endianwire; serve-simavccbig-endianwire — vphone frames become exact serve-sim envelopes with unchanged frame suppressed
- **Recognizable regression**: Independentliteralbigtagbytesandknownpayloads; remove extra test-demux replay and reimplementedUIcodec calculation
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Independentliteralbigtagbytesandknownpayloads; remove extra test-demux replay and reimplementedUIcodec calculation
- **Stable seam**: Public screen request encoder/reply decoder/converter over independently built fixed wire fixtures
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/screen-protocol.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### REWRITE — `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts:71`

the description repeats only when it changes; deltas before a key frame are dropped

Knownrecordchangeandwiretags/bytes; absorb malformedNAL/avcC guard from removedhelpercase

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goal3; externalvphonehostscreenlittle-endianwire; serve-simavccbig-endianwire — Description repeats on configchange, onlykeyframes unlockdeltas, invalidframes dropped
- **Recognizable regression**: Knownrecordchangeandwiretags/bytes; absorb malformedNAL/avcC guard from removedhelpercase
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Knownrecordchangeandwiretags/bytes; absorb malformedNAL/avcC guard from removedhelpercase
- **Stable seam**: Public screen request encoder/reply decoder/converter over independently built fixed wire fixtures
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/screen-protocol.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

### CONSOLIDATE — `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts:88`

helpers: length-prefixed access units, avcC records, envelopes, MJPEG parts

Convertercaseownskey/invalidpayloads/envelopebytes, bridgeownsactualmultipart; moveonlyuniqueinvalidNALfixture theninternalizeprivatevalidators

Failed bar / consolidation reason: The old implementation-order/helper inventory fails refactor resistance or duplicates the surviving owner. Its unique real contract is explicitly transferred to the listed public owner.

Surviving owner(s): `apps/daemon/src/devices/hosts/vphone/screen-protocol.test.ts` — the description repeats only when it changes; deltas before a key frame are dropped; `apps/daemon/src/devices/hosts/vphone/bridge.test.ts` — stream.mjpeg: screenshots as multipart parts.

- **Independent source and contract**: docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 goal3; externalvphonehostscreenlittle-endianwire; serve-simavccbig-endianwire — AVCC/NAL validity/envelope/MJPEG wirehelpers
- **Recognizable regression**: Convertercaseownskey/invalidpayloads/envelopebytes, bridgeownsactualmultipart; moveonlyuniqueinvalidNALfixture theninternalizeprivatevalidators
- **Independent oracle**: Expected values come from independent fixture data, documented wire/config/persistence bytes, explicit security/error states or known resource limits; they can disagree with production. Convertercaseownskey/invalidpayloads/envelopebytes, bridgeownsactualmultipart; moveonlyuniqueinvalidNALfixture theninternalizeprivatevalidators
- **Stable seam**: Public screen request encoder/reply decoder/converter over independently built fixed wire fixtures
- **Refactor resistance**: Retained checks target caller-visible state/data/errors or external protocol/files. Planned rewrites remove private overrides, object identity, formatting/source inventories and implementation-derived expectations.
- **Unique protection**: This lowest owner checks the stated distinct failure. Higher orchestration tests only survive for binding/auth/realprocess/restart composition, while lower pure owners keep detailed protocol/math. For deletions/consolidations the surviving owner and failed bar are stated in change.
- **Validation target**: `TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/vphone/screen-protocol.test.ts` from `apps/daemon` (focused validation passed; root final gate pending).

## Manual integration harnesses

- KEEP `apps/daemon/src/devices/hosts/box/android-integration.it.ts`: Actual emulator/SDK/guest/reattach/toolchaincompatibility not simulated by fakeSDK. NOT RUN: opt-in real KVM/Mac tooling/rental surfaces; default suite does not execute them.
- KEEP `apps/daemon/src/devices/hosts/box/stream-integration.it.ts`: Actual SEMU video and human takeover through real websocket proxy; savesJSON/screenshotlogs. NOT RUN: opt-in real KVM/Mac tooling/rental surfaces; default suite does not execute them.
- KEEP `apps/daemon/src/devices/hosts/box/simslim.it.ts`: ManualMacrealmemory/density/slimming+stream measurement and artifacts; generates script only. NOT RUN: opt-in real KVM/Mac tooling/rental surfaces; default suite does not execute them.

Root owns final typechecks/full testing, integration, commit and push. This workstream did not stage or commit files.
