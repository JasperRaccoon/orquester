# Incoming Android/toolchain/local-host test cleanup

Source `610d3c53`, compared with `923b3a51`. All 62 test declarations in 15 files were read with their production owners and [device module map](../../apps/daemon/src/devices/README.md), [phase1 design](../superpowers/specs/2026-10-27-devices-phase-1-core.md) and [measured spikes](../superpowers/research/2026-10-27-devices-spikes.md). 58 declarations survive. Dispositions: `{"KEEP": 28, "REWRITE": 27, "OPTIMIZE": 3, "CONSOLIDATE": 2, "DELETE": 2}`. Net test LOC -31; the manual integration script is separate from registration counts. Its assertions/cleanup add 39 LOC, so combined owned automated/manual test LOC changes by 8.

## Validation and performance

The exclusive15-file run passed58/58 in2.94s wall (userCPU5.99s, system1.00s, RSS162,884KB). Parent reported baseline golden case7,512.92ms; final focused case13.124616ms, saving7,499.795384ms (99.8253%). Three additional golden runs passed at8.535528/9.107727/8.434827ms, with processwall.30/.31/.30s. Different surrounding load limits interpreting tiny variance; removal of fixed7.5s waits is directly measured. No comparable whole15-file baseline or CI saving is claimed.

Both process-local mutants failed intended assertions: missing adb unroot and agent-device starting after teardown. Actual hardware integration was not executed. Full final typecheck/test gates belong to root. Minor final flag-order/config-oracle edits in hub/readiness/npm files followed the focused run and need that final gate.

Focused command: `cd apps/daemon && TSX_DISABLE_CACHE=1 /usr/bin/time -f '\nwall=%e cpu_user=%U cpu_system=%S max_rss_kb=%M' node --import tsx --test --test-concurrency=4 src/devices/android/agent-device-daemon.test.ts src/devices/android/avd-config.test.ts src/devices/android/capacity.test.ts src/devices/android/emulator.test.ts src/devices/android/env.test.ts src/devices/android/executor.test.ts src/devices/android/golden.test.ts src/devices/android/hub.test.ts src/devices/android/procs.test.ts src/devices/android/readiness.test.ts src/devices/android/state.test.ts src/devices/toolchain/index.test.ts src/devices/toolchain/lock.test.ts src/devices/toolchain/npm-tools.test.ts src/devices/hosts/local-android.test.ts > /tmp/orquester-test-audit/devices-android-focused.log 2>&1`

Repeats: `cd apps/daemon && TSX_DISABLE_CACHE=1 /usr/bin/time -f '\nwall=%e cpu_user=%U cpu_system=%S max_rss_kb=%M' node --import tsx --test --test-name-pattern='cutout: the pixel spec' src/devices/android/golden.test.ts > /tmp/orquester-test-audit/devices-golden-repeat-N.log 2>&1 (N=1,2,3 sequential)`

- `cd apps/daemon && ORQUESTER_ANDROID_AUDIT_MUTATION=leave-adbd-root TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/devices-android-mutation-loader.mjs --test --test-name-pattern='cutout: the pixel spec' src/devices/android/golden.test.ts > /tmp/orquester-test-audit/devices-mutation-leave-adbd-root.log 2>&1`: exit1; Missing unroot failed the independently required privilege cleanup/order assertion after SystemUI kill.
- `cd apps/daemon && ORQUESTER_ANDROID_AUDIT_MUTATION=late-agent-start TSX_DISABLE_CACHE=1 node --import tsx --import /tmp/orquester-test-audit/devices-android-mutation-loader.mjs --test --test-name-pattern='teardown while hub health' src/devices/hosts/local-android.test.ts > /tmp/orquester-test-audit/devices-mutation-late-agent-start.log 2>&1`: exit1; Removing post-health teardown guard invoked actual AgentDeviceDaemon start via external exec, failing no-late-agent-start assertion.

## Supporting infrastructure

- `android/golden.ts`: Remove now injection from waitForSettle; tests use controlled Date. Internalize ANIMATIONS_OFF_SCRIPT and remove unused CUTOUT_OVERLAY constant. Preserve shared exports consumed by real device-cache workflow and lease boots.
- `android/hub.ts`: Remove unused HubDeps.now override; internalize private backoff helper/cap after deleting their tuning restatement test.
- `toolchain/lock.ts`: Remove unused optional now argument; real Date is controllable without production seam.
- `toolchain/npm-tools.ts`: Remove explicit test-only deps.scrcpy and deps.lock overrides; install actual shipped pin/lock, downloadPinned lower owner proves integrity with real bytes. Retain lockPins export: hosts/box/remote.ts uses it for actual pinned tool installation; independent config assertions avoid using that verifier as their oracle.
- `fixtures`: Removed lockFor and unused fake jar downloader fixtures. Real isolated SDK/native command ports remain because production local and box tooling share these external boundaries. No dependency/config/snapshot removal justified.
- `seamCallerAudit`: rg found shared GUEST_SETTINGS_SCRIPT/CLOSE_SYSTEM_DIALOGS_SCRIPT/SYSTEM_UI_* consumers in boxes/github/device-cache.ts, so these production contracts are retained. No non-test consumers of removed override options/exports.

## Every source test

### `apps/daemon/src/devices/android/agent-device-daemon.test.ts:6`

**KEEP** — agent-device: daemon.json → loopback endpoint; the --config file holds the base URL and token

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `agent-device: daemon.json → loopback endpoint; the --config file holds the base URL and token`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/§6.2 and observed agent-device daemon.json/config protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** agent-device: daemon.json → loopback endpoint; the --config file holds the base URL and token. Credible failure classes: daemon HTTP port/token fields or host-pinned config keys are wrong; invalid metadata becomes a usable credential endpoint.
- **Independent oracle:** Captured httpPort/token input and literal loopback URL, daemonBaseUrl/daemonAuthToken keys and null outcomes
- **Stable seam:** parseDaemonInfo/agentDeviceConfig external CLI configuration format; actual daemon class and box hosts consume the result
- **Refactor resistance:** External CLI keys remain stable across daemon internals; malformed input checks have specific null outcomes
- **Unique protection:** Only focused owner of daemon.json→agent-device configuration bytes; higher host lifecycle tests use already valid metadata

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/agent-device-daemon.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:46`

**KEEP** — config.ini: placeholders replaced, Orquester's hardware applied, other keys kept

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `config.ini: placeholders replaced, Orquester's hardware applied, other keys kept`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** config.ini: placeholders replaced, Orquester's hardware applied, other keys kept. Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:75`

**KEEP** — config.ini: a foldable's display regions and hinge scale with the framebuffer; unset values stay

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `config.ini: a foldable's display regions and hinge scale with the framebuffer; unset values stay`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** config.ini: a foldable's display regions and hinge scale with the framebuffer; unset values stay. Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:84`

**KEEP** — config.ini: the Z Flip8's horizontal hinge keeps a 1 px height and moves to the new middle

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `config.ini: the Z Flip8's horizontal hinge keeps a 1 px height and moves to the new middle`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** config.ini: the Z Flip8's horizontal hinge keeps a 1 px height and moves to the new middle. Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:91`

**KEEP** — hardware: every Android profile has a tuned framebuffer of its real aspect; names and screens

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `hardware: every Android profile has a tuned framebuffer of its real aspect; names and screens`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** hardware: every Android profile has a tuned framebuffer of its real aspect; names and screens. Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:115`

**KEEP** — cutout: the system image's pixel spec becomes dp (lengths only; arc flags and markers kept)

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `cutout: the system image's pixel spec becomes dp (lengths only; arc flags and markers kept)`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** cutout: the system image's pixel spec becomes dp (lengths only; arc flags and markers kept). Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/avd-config.test.ts:127`

**REWRITE** — cutout overlays: the dp cutout, its rect in dp and the fill; the enabled emulation overlays disabled

Remove CUTOUT_RECT_LOOKUP/CUTOUT_FILL_LOOKUP declaration self-assertions; real fixDisplayCutout protocol test owns their actual Android resource lookup bytes.

Surviving owner: `cutout overlays: the dp cutout, its rect in dp and the fill; the enabled emulation overlays disabled`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 plus README Local Android / avd-config; avdmanager22 captured FOLD fixture; research§2; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** cutout overlays: the dp cutout, its rect in dp and the fill; the enabled emulation overlays disabled. Credible failure classes: Emulator rejects avdmanager placeholders; tuning changes panel aspect/dp/hinge/postures; pixel cutout is misplaced or unfilled; unrelated ini keys disappear.
- **Independent oracle:** Literal config.ini keys/values, captured physical dimensions and arc flags; expected transformed paths are fixed independently of tuning implementation
- **Stable seam:** AVD config.ini/Android overlay shell protocol used by both daemon and embedded device-cache workflow
- **Refactor resistance:** Assertions guard actual emulator keys and Android resource bytes; they survive helper renames and implementation changes. These widths/coordinates are explicit emulated-device protocol contracts, not incidental UI layout
- **Unique protection:** Lowest shared tuning owner covers fold hinges/regions, real aspect/dp size and resource conversion; SDK integration only establishes that the patch is applied

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/avd-config.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/capacity.test.ts:8`

**KEEP** — capacity: min(setting, running + (MemAvailable − 8 GB) / 3.2 GB); active ≈ threads / 8

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `capacity: min(setting, running + (MemAvailable − 8 GB) / 3.2 GB); active ≈ threads / 8`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Density, current README/capacity contract supersedes preliminary phase1 formula; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** capacity: min(setting, running + (MemAvailable − 8 GB) / 3.2 GB); active ≈ threads / 8. Credible failure classes: Scheduler overcommits host RAM, forgets running instances already removed from MemAvailable, ignores configured cap, or reports no usable active slot.
- **Independent oracle:** Hand-chosen memory/thread inputs and literal capacity totals8/4/0, active2/1; no imported production constants
- **Stable seam:** localCapacity used by real LocalAndroidHost capacity admission; documented measured policy
- **Refactor resistance:** Public numeric capacity outcomes permit refactoring arithmetic/storage without changing expected policy
- **Unique protection:** Only owner of local measured RAM/thread formula; pool tests own placement rather than derive machine capacity

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/capacity.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:8`

**REWRITE** — flags: a lease boots read-only from the snapshot without saving; a golden boot is cold and writable

Replace full ordered argv snapshot with independently required CLI flag/value semantics; equivalent argument reordering remains valid.

Surviving owner: `flags: a lease boots read-only from the snapshot without saving; a golden boot is cold and writable`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** flags: a lease boots read-only from the snapshot without saving; a golden boot is cold and writable. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:39`

**KEEP** — ports: even console ports in 5554–5682, above adb's scan range first; gRPC per console port

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `ports: even console ports in 5554–5682, above adb's scan range first; gRPC per console port`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** ports: even console ports in 5554–5682, above adb's scan range first; gRPC per console port. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:53`

**REWRITE** — ports: skips taken ports and ports busy on the machine (console, adb +1, gRPC)

Use literal expected selected gRPC port instead of production grpcPortFor output as the expected value.

Surviving owner: `ports: skips taken ports and ports busy on the machine (console, adb +1, gRPC)`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** ports: skips taken ports and ports busy on the machine (console, adb +1, gRPC). Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:60`

**REWRITE** — kvm: direct runs the binary; sg wraps it in one quoted exec

REWRITE exact quoted-text implementation check into actual POSIX shell execution of wrapped Node argv, proving quotes/spaces/$(printf injected) remain literal. Keep direct branch and sg kvm protocol values.

Surviving owner: `kvm: direct execution preserves argv; sg shell quoting does not expand text`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** kvm: direct runs the binary; sg wraps it in one quoted exec. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:66`

**REWRITE** — flags: a box lease boots its named snapshot with the snapshot's GPU mode, or cold when that failed

Replace prefix/suffix argv slice snapshots with named snapshot, GPU mode, read-only/cold/save flag semantics.

Surviving owner: `flags: a box lease boots its named snapshot with the snapshot's GPU mode, or cold when that failed`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** flags: a box lease boots its named snapshot with the snapshot's GPU mode, or cold when that failed. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:101`

**KEEP** — stop: a reused pid (another program, another appdir, or a later start) is never signalled

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `stop: a reused pid (another program, another appdir, or a later start) is never signalled`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** stop: a reused pid (another program, another appdir, or a later start) is never signalled. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/emulator.test.ts:119`

**KEEP** — stop: our emulator gets emu kill, then SIGTERM to its group; the launcher's group only while it carries the marker

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `stop: our emulator gets emu kill, then SIGTERM to its group; the launcher's group only while it carries the marker`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2/§3 flags, multi-instance and PID identity safety; README emulator contract; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** stop: our emulator gets emu kill, then SIGTERM to its group; the launcher's group only while it carries the marker. Credible failure classes: Writable lease corrupts snapshot or blocks parallel instances; wrong named/cold GPU boot; port collision; shell expansion; reused foreign PID is signalled.
- **Independent oracle:** Literal CLI option values, valid console/adb/gRPC ports, literal round-tripped shell argv and observed process signals/state
- **Stable seam:** Native emulator/sg/POSIX shell and DeviceExecutor process identity boundary; stopEmulator/allocateEmulatorPorts APIs
- **Refactor resistance:** Flags are checked by meaning, not array order; process safety checks verify command/env/start-time outcomes and protocol signals
- **Unique protection:** Local host tests own lease-to-process wiring; these cases uniquely own complete external launch protocol and reused PID/start-time safety

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/emulator.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/env.test.ts:6`

**KEEP** — env: every tool home is inside the appdir; the adb port is private; daemon secrets are not passed

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `env: every tool home is inside the appdir; the adb port is private; daemon secrets are not passed`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 private runtime state plus research§2 multi-instance/env and README android/env; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** env: every tool home is inside the appdir; the adb port is private; daemon secrets are not passed. Credible failure classes: Daemon secrets reach tool subprocesses; tools share live appdir home/AVD/adb state; box emulator overlays leak into global /tmp.
- **Independent oracle:** Literal forbidden secret absence, private path prefixes, required external environment keys and literal16000≤port<20000, default5037 excluded
- **Stable seam:** buildAndroidEnv/androidLayout/androidLayoutAt/adbServerPort public environment and persisted path contract
- **Refactor resistance:** No hash algorithm expected value; only stable private paths, actual external variable names and allowed protocol range
- **Unique protection:** Only combined allowlist/home isolation owner; host tests verify command environment wiring but do not enumerate privacy guarantees

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/env.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/env.test.ts:39`

**REWRITE** — adb port: stable per appdir, different between appdirs, never the default 5037

Use independently documented literal private port range16000–19999 instead of asserting against imported production range constants.

Surviving owner: `adb port: stable per appdir, different between appdirs, never the default 5037`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 private runtime state plus research§2 multi-instance/env and README android/env; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** adb port: stable per appdir, different between appdirs, never the default 5037. Credible failure classes: Daemon secrets reach tool subprocesses; tools share live appdir home/AVD/adb state; box emulator overlays leak into global /tmp.
- **Independent oracle:** Literal forbidden secret absence, private path prefixes, required external environment keys and literal16000≤port<20000, default5037 excluded
- **Stable seam:** buildAndroidEnv/androidLayout/androidLayoutAt/adbServerPort public environment and persisted path contract
- **Refactor resistance:** No hash algorithm expected value; only stable private paths, actual external variable names and allowed protocol range
- **Unique protection:** Only combined allowlist/home isolation owner; host tests verify command environment wiring but do not enumerate privacy guarantees

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/env.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/env.test.ts:49`

**KEEP** — env: a box host's emulator keeps its overlays and crashpad database in the box layout's temp dir, not /tmp

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `env: a box host's emulator keeps its overlays and crashpad database in the box layout's temp dir, not /tmp`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 private runtime state plus research§2 multi-instance/env and README android/env; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** env: a box host's emulator keeps its overlays and crashpad database in the box layout's temp dir, not /tmp. Credible failure classes: Daemon secrets reach tool subprocesses; tools share live appdir home/AVD/adb state; box emulator overlays leak into global /tmp.
- **Independent oracle:** Literal forbidden secret absence, private path prefixes, required external environment keys and literal16000≤port<20000, default5037 excluded
- **Stable seam:** buildAndroidEnv/androidLayout/androidLayoutAt/adbServerPort public environment and persisted path contract
- **Refactor resistance:** No hash algorithm expected value; only stable private paths, actual external variable names and allowed protocol range
- **Unique protection:** Only combined allowlist/home isolation owner; host tests verify command environment wiring but do not enumerate privacy guarantees

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/env.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/executor.test.ts:10`

**KEEP** — local executor: atomic text files, missing reads, listings

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `local executor: atomic text files, missing reads, listings`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md README DeviceExecutor external file/process adapter contract and §5 privacy modes; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** local executor: atomic text files, missing reads, listings. Credible failure classes: Adapter loses file bytes/mode, missing reads throw, detached process lacks own group/logs, invalid pid can signal kill(-1).
- **Independent oracle:** Real temporary file bytes/mode/listings, kernel process group and eventual exit; ready log notification before signalling
- **Stable seam:** LOCAL_EXECUTOR on actual filesystem, detached process and random loopback port boundaries
- **Refactor resistance:** Refactor can change implementation/temp names; assertions remain actual bytes, mode, process group and signal safety
- **Unique protection:** Only local executor implementation owner; fake-machine stop tests cannot detect broken native OS adapter

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/executor.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/executor.test.ts:25`

**OPTIMIZE** — local executor: a detached process leads its own group and logs to its file; signals never reach kill(-1)

OPTIMIZE/repair startup race: subscribe to real file notifications before spawn and wait until started bytes are observed before signalling. Add marked child cleanup; retain actual own process group, logs, exit and invalid-pid safety.

Surviving owner: `local executor: a detached process leads its own group and logs to its file; signals never reach kill(-1)`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md README DeviceExecutor external file/process adapter contract and §5 privacy modes; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** local executor: a detached process leads its own group and logs to its file; signals never reach kill(-1). Credible failure classes: Adapter loses file bytes/mode, missing reads throw, detached process lacks own group/logs, invalid pid can signal kill(-1).
- **Independent oracle:** Real temporary file bytes/mode/listings, kernel process group and eventual exit; ready log notification before signalling
- **Stable seam:** LOCAL_EXECUTOR on actual filesystem, detached process and random loopback port boundaries
- **Refactor resistance:** Refactor can change implementation/temp names; assertions remain actual bytes, mode, process group and signal safety
- **Unique protection:** Only local executor implementation owner; fake-machine stop tests cannot detect broken native OS adapter

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/executor.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/golden.test.ts:12`

**REWRITE** — settle: two quiet windows in a row, after the first-boot burst

Use Node controlled Date rather than a test-only production now injection; retain independent burst/interrupted quiet-window CPU samples.

Surviving owner: `settle: two quiet windows in a row, after the first-boot burst`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Golden snapshot and first-boot CPU; README golden tuning/Android cutout protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** settle: two quiet windows in a row, after the first-boot burst. Credible failure classes: First-boot burst accepted as settled; timeout/exit mishandled; dialogs persist in snapshots; cutout loses rect/fill; adbd stays root or SystemUI never refreshes.
- **Independent oracle:** Independent sampled CPU sequence, true/false/exit outcomes; literal Android guest commands/resource payloads and actual fake-ADB state transitions
- **Stable seam:** waitForSettle CPU sample boundary; shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT protocol also consumed by device-cache workflow; fixDisplayCutout native ADB protocol
- **Refactor resistance:** Controlled clocks replace elapsed waits; command bytes/privilege order and changed SystemUI/display state survive internal refactors
- **Unique protection:** Lowest shared CPU settle/cutout privilege owner; avd-config owns pure path/overlay conversion, while this integration owns actual applying/root/unroot/restart sequence

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/golden.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/golden.test.ts:27`

**REWRITE** — settle: gives up after the limit (the snapshot is taken anyway); an exit fails it

Use controlled Date for deadline without production injection; retain false-on-busy limit and specific exited failure.

Surviving owner: `settle: gives up after the limit (the snapshot is taken anyway); an exit fails it`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Golden snapshot and first-boot CPU; README golden tuning/Android cutout protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** settle: gives up after the limit (the snapshot is taken anyway); an exit fails it. Credible failure classes: First-boot burst accepted as settled; timeout/exit mishandled; dialogs persist in snapshots; cutout loses rect/fill; adbd stays root or SystemUI never refreshes.
- **Independent oracle:** Independent sampled CPU sequence, true/false/exit outcomes; literal Android guest commands/resource payloads and actual fake-ADB state transitions
- **Stable seam:** waitForSettle CPU sample boundary; shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT protocol also consumed by device-cache workflow; fixDisplayCutout native ADB protocol
- **Refactor resistance:** Controlled clocks replace elapsed waits; command bytes/privilege order and changed SystemUI/display state survive internal refactors
- **Unique protection:** Lowest shared CPU settle/cutout privilege owner; avd-config owns pure path/overlay conversion, while this integration owns actual applying/root/unroot/restart sequence

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/golden.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/golden.test.ts:33`

**REWRITE** — guest settings: animations off, screen never off, error dialogs hidden, stay awake

Surviving shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT owner asserts independent literal Android command bytes from research; receives loaded-dialog broadcast coverage from removed donor.

Surviving owner: `golden and lease guest commands disable animations; loaded dialogs are dismissed`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Golden snapshot and first-boot CPU; README golden tuning/Android cutout protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** guest settings: animations off, screen never off, error dialogs hidden, stay awake. Credible failure classes: First-boot burst accepted as settled; timeout/exit mishandled; dialogs persist in snapshots; cutout loses rect/fill; adbd stays root or SystemUI never refreshes.
- **Independent oracle:** Independent sampled CPU sequence, true/false/exit outcomes; literal Android guest commands/resource payloads and actual fake-ADB state transitions
- **Stable seam:** waitForSettle CPU sample boundary; shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT protocol also consumed by device-cache workflow; fixDisplayCutout native ADB protocol
- **Refactor resistance:** Controlled clocks replace elapsed waits; command bytes/privilege order and changed SystemUI/display state survive internal refactors
- **Unique protection:** Lowest shared CPU settle/cutout privilege owner; avd-config owns pure path/overlay conversion, while this integration owns actual applying/root/unroot/restart sequence

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/golden.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/golden.test.ts:40`

**CONSOLIDATE** — dialogs a loaded first boot raised are closed: before the snapshot is saved, and after every lease boot

CONSOLIDATE into preceding shared guest-script protocol owner: replace ANIMATIONS_OFF_SCRIPT/CLOSE_SYSTEM_DIALOGS_SCRIPT comparisons with independent literal lease animation/broadcast requirements. Remove this redundant execution and internalize unused animation export.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Golden snapshot and first-boot CPU; README golden tuning/Android cutout protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** dialogs a loaded first boot raised are closed: before the snapshot is saved, and after every lease boot. Credible failure classes: First-boot burst accepted as settled; timeout/exit mishandled; dialogs persist in snapshots; cutout loses rect/fill; adbd stays root or SystemUI never refreshes.
- **Independent oracle:** Independent sampled CPU sequence, true/false/exit outcomes; literal Android guest commands/resource payloads and actual fake-ADB state transitions
- **Stable seam:** waitForSettle CPU sample boundary; shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT protocol also consumed by device-cache workflow; fixDisplayCutout native ADB protocol
- **Refactor resistance:** Controlled clocks replace elapsed waits; command bytes/privilege order and changed SystemUI/display state survive internal refactors
- **Unique protection:** Lowest shared CPU settle/cutout privilege owner; avd-config owns pure path/overlay conversion, while this integration owns actual applying/root/unroot/restart sequence

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/golden.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/golden.test.ts:46`

**OPTIMIZE** — cutout: the pixel spec of the device emulation overlay is replaced by a dp one, as root, then adbd unroots

OPTIMIZE only scheduling: virtual setTimeout drains replace7.5s of real fake-ADB waits. Preserve root→fabricate cutout/rect/fill→disable/enable→SystemUI restart→unroot→new dp state assertions, all independent literals.

Surviving owner: `cutout: the pixel spec of the device emulation overlay is replaced by a dp one, as root, then adbd unroots`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md research§2 Golden snapshot and first-boot CPU; README golden tuning/Android cutout protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** cutout: the pixel spec of the device emulation overlay is replaced by a dp one, as root, then adbd unroots. Credible failure classes: First-boot burst accepted as settled; timeout/exit mishandled; dialogs persist in snapshots; cutout loses rect/fill; adbd stays root or SystemUI never refreshes.
- **Independent oracle:** Independent sampled CPU sequence, true/false/exit outcomes; literal Android guest commands/resource payloads and actual fake-ADB state transitions
- **Stable seam:** waitForSettle CPU sample boundary; shared GUEST_SETTINGS_SCRIPT/LEASE_BOOT_SCRIPT protocol also consumed by device-cache workflow; fixDisplayCutout native ADB protocol
- **Refactor resistance:** Controlled clocks replace elapsed waits; command bytes/privilege order and changed SystemUI/display state survive internal refactors
- **Unique protection:** Lowest shared CPU settle/cutout privilege owner; avd-config owns pure path/overlay conversion, while this integration owns actual applying/root/unroot/restart sequence

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/golden.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/hub.test.ts:6`

**REWRITE** — hub: loopback, token required, streaming only, no token in argv

Assert authenticated loopback Android protocol flags by meaning; remove full ordered argv snapshot and ineffective token= regex.

Surviving owner: `hub: Android streaming uses loopback and requires authentication`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 authenticated loopback streaming and README hub capture-session recycling; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** hub: loopback, token required, streaming only, no token in argv. Credible failure classes: Hub binds externally or allows unauthenticated control; active viewers lose streams; unused captures keep burning CPU; reconnect grace or reattach fallback is ignored.
- **Independent oracle:** Literal Android/127.0.0.1/port values and required flags; literal viewer/count/time states, independently chosen15s/60s windows rather than production constants
- **Stable seam:** Hub CLI flags and shouldRecycle policy fed by actual supervisor proxy/process boundaries
- **Refactor resistance:** Argument ordering and imported cut-off self-comparisons removed; only public security/recycling policy outcomes remain
- **Unique protection:** CLI security and viewer-vs-idle policy are not covered by local host wrong-lease/process tests; arbitrary exact backoff helper is removed

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/hub.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/hub.test.ts:12`

**DELETE** — hub: exponential restart backoff, capped

DELETE exact private exponential/backoff tuning restatement and imported cap self-comparison. It does not exercise actual restart/reset behavior; source§6.2 does not specify its1/2/4/8s implementation sequence. Internalize backoff helper/cap; HubDeps.now has no callers and is removed.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 authenticated loopback streaming and README hub capture-session recycling; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** hub: exponential restart backoff, capped. Credible failure classes: Hub binds externally or allows unauthenticated control; active viewers lose streams; unused captures keep burning CPU; reconnect grace or reattach fallback is ignored.
- **Independent oracle:** Literal Android/127.0.0.1/port values and required flags; literal viewer/count/time states, independently chosen15s/60s windows rather than production constants
- **Stable seam:** Hub CLI flags and shouldRecycle policy fed by actual supervisor proxy/process boundaries
- **Refactor resistance:** Argument ordering and imported cut-off self-comparisons removed; only public security/recycling policy outcomes remain
- **Unique protection:** CLI security and viewer-vs-idle policy are not covered by local host wrong-lease/process tests; arbitrary exact backoff helper is removed

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/hub.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/hub.test.ts:17`

**REWRITE** — hub: with the proxy's counts, recycle shortly after the last stream closed, never while one is open

Replace production-derived elapsed deadline with literal15s fixture; preserve active-viewer/reconnect/no-capture/never-viewed outcomes.

Surviving owner: `hub: with the proxy's counts, recycle shortly after the last stream closed, never while one is open`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 authenticated loopback streaming and README hub capture-session recycling; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** hub: with the proxy's counts, recycle shortly after the last stream closed, never while one is open. Credible failure classes: Hub binds externally or allows unauthenticated control; active viewers lose streams; unused captures keep burning CPU; reconnect grace or reattach fallback is ignored.
- **Independent oracle:** Literal Android/127.0.0.1/port values and required flags; literal viewer/count/time states, independently chosen15s/60s windows rather than production constants
- **Stable seam:** Hub CLI flags and shouldRecycle policy fed by actual supervisor proxy/process boundaries
- **Refactor resistance:** Argument ordering and imported cut-off self-comparisons removed; only public security/recycling policy outcomes remain
- **Unique protection:** CLI security and viewer-vs-idle policy are not covered by local host wrong-lease/process tests; arbitrary exact backoff helper is removed

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/hub.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/hub.test.ts:27`

**REWRITE** — hub: without counts, recycle capture sessions only after a full idle minute with no viewer

Replace production-derived elapsed deadline with literal60s fixture; preserve fallback connected/recent-viewer/idle/capture outcomes.

Surviving owner: `hub: without counts, recycle capture sessions only after a full idle minute with no viewer`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 authenticated loopback streaming and README hub capture-session recycling; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** hub: without counts, recycle capture sessions only after a full idle minute with no viewer. Credible failure classes: Hub binds externally or allows unauthenticated control; active viewers lose streams; unused captures keep burning CPU; reconnect grace or reattach fallback is ignored.
- **Independent oracle:** Literal Android/127.0.0.1/port values and required flags; literal viewer/count/time states, independently chosen15s/60s windows rather than production constants
- **Stable seam:** Hub CLI flags and shouldRecycle policy fed by actual supervisor proxy/process boundaries
- **Refactor resistance:** Argument ordering and imported cut-off self-comparisons removed; only public security/recycling policy outcomes remain
- **Unique protection:** CLI security and viewer-vs-idle policy are not covered by local host wrong-lease/process tests; arbitrary exact backoff helper is removed

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/hub.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:8`

**REWRITE** — stat: comm with spaces and parentheses, ppid, pgrp, cpu ticks

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `stat: comm with spaces and parentheses, ppid, pgrp, cpu ticks`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** stat: comm with spaces and parentheses, ppid, pgrp, cpu ticks. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:14`

**KEEP** — descendants: children and grandchildren only

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `descendants: children and grandchildren only`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** descendants: children and grandchildren only. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:20`

**KEEP** — /proc/net/tcp: established connections accepted on a port

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `/proc/net/tcp: established connections accepted on a port`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** /proc/net/tcp: established connections accepted on a port. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:31`

**KEEP** — meminfo: MemAvailable in bytes

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `meminfo: MemAvailable in bytes`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** meminfo: MemAvailable in bytes. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:36`

**KEEP** — processMatches: a live process is ours only with the appdir marker in its environment

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `processMatches: a live process is ours only with the appdir marker in its environment`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** processMatches: a live process is ours only with the appdir marker in its environment. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/procs.test.ts:50`

**CONSOLIDATE** — stat: the start time (field 22) when the line has it

CONSOLIDATE field22 start-time expectation into the first stat fixture, which also covers spaces/parentheses, PPID/group and CPU ticks. One complete external frame catches all independent offset/identity regressions without a second parse execution.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md Linux /proc stat, environ, meminfo and net/tcp ABI; research§2 process ownership; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** stat: the start time (field 22) when the line has it. Credible failure classes: Spaces/parentheses shift process fields or start-time identity; parent traversal includes unrelated process; server/client TCP ends confused; RAM units wrong; marker/argv mismatch accepted.
- **Independent oracle:** Literal captured-format stat fields/tcp rows/memory bytes; real child process marker and argv mismatches
- **Stable seam:** External Linux ABI parsers plus processMatches over actual kernel child process
- **Refactor resistance:** No private reader call order; captured protocol fields and observable process ownership survive implementation changes
- **Unique protection:** Only native /proc format reader owner; fake DeviceExecutor tables in stop tests cannot detect wrong field offsets or actual environ/cmdline reads

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/procs.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/readiness.test.ts:21`

**REWRITE** — readiness: everything installed is ready (golden snapshots are not a check; java only while installing)

Remove incidental exact detail copy; strengthen independently required no-Java-after-setup behavior. Public check IDs compared as a set, not presentation order.

Surviving owner: `readiness: everything installed is ready (golden snapshots are not a check; java only while installing)`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 setup checklist, current README readiness and observed KVM group fallback; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** readiness: everything installed is ready (golden snapshots are not a check; java only while installing). Credible failure classes: Unavailable KVM/Node/ffmpeg marked ready; installable missing pieces have no actionable ID; Java blocks an already prepared runtime; native probe output misparsed.
- **Independent oracle:** Literal public states/fix IDs, no-Java-ready condition, known node/ffmpeg/group text; incidental user copy removed
- **Stable seam:** evaluateReadiness public setup DTO and native tool/group parsers used by host probe
- **Refactor resistance:** Public states/IDs rather than full copy or result order; exact IDs are UI/API action keys
- **Unique protection:** Lowest setup-policy/native-parser owner; LocalAndroidHost test separately proves probe→status wiring and selected fix execution

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/readiness.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/readiness.test.ts:32`

**REWRITE** — readiness: installable items carry their fix action; machine items do not

Replace production FIX_ACTIONS.sdk self-reference with literal public install-android-sdk key and remove incidental detail wording.

Surviving owner: `readiness: installable items carry their fix action; machine items do not`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 setup checklist, current README readiness and observed KVM group fallback; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** readiness: installable items carry their fix action; machine items do not. Credible failure classes: Unavailable KVM/Node/ffmpeg marked ready; installable missing pieces have no actionable ID; Java blocks an already prepared runtime; native probe output misparsed.
- **Independent oracle:** Literal public states/fix IDs, no-Java-ready condition, known node/ffmpeg/group text; incidental user copy removed
- **Stable seam:** evaluateReadiness public setup DTO and native tool/group parsers used by host probe
- **Refactor resistance:** Public states/IDs rather than full copy or result order; exact IDs are UI/API action keys
- **Unique protection:** Lowest setup-policy/native-parser owner; LocalAndroidHost test separately proves probe→status wiring and selected fix execution

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/readiness.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/readiness.test.ts:56`

**REWRITE** — readiness: kvm through sg is usable; a missing /dev/kvm is an error

Remove incidental sg kvm detail wording; retain direct/sg usability vs missing KVM and missing ffmpeg states.

Surviving owner: `readiness: kvm through sg is usable; a missing /dev/kvm is an error`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 setup checklist, current README readiness and observed KVM group fallback; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** readiness: kvm through sg is usable; a missing /dev/kvm is an error. Credible failure classes: Unavailable KVM/Node/ffmpeg marked ready; installable missing pieces have no actionable ID; Java blocks an already prepared runtime; native probe output misparsed.
- **Independent oracle:** Literal public states/fix IDs, no-Java-ready condition, known node/ffmpeg/group text; incidental user copy removed
- **Stable seam:** evaluateReadiness public setup DTO and native tool/group parsers used by host probe
- **Refactor resistance:** Public states/IDs rather than full copy or result order; exact IDs are UI/API action keys
- **Unique protection:** Lowest setup-policy/native-parser owner; LocalAndroidHost test separately proves probe→status wiring and selected fix execution

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/readiness.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/readiness.test.ts:63`

**KEEP** — probe parsers: node major, ffmpeg encoders, /etc/group members

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `probe parsers: node major, ffmpeg encoders, /etc/group members`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 setup checklist, current README readiness and observed KVM group fallback; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** probe parsers: node major, ffmpeg encoders, /etc/group members. Credible failure classes: Unavailable KVM/Node/ffmpeg marked ready; installable missing pieces have no actionable ID; Java blocks an already prepared runtime; native probe output misparsed.
- **Independent oracle:** Literal public states/fix IDs, no-Java-ready condition, known node/ffmpeg/group text; incidental user copy removed
- **Stable seam:** evaluateReadiness public setup DTO and native tool/group parsers used by host probe
- **Refactor resistance:** Public states/IDs rather than full copy or result order; exact IDs are UI/API action keys
- **Unique protection:** Lowest setup-policy/native-parser owner; LocalAndroidHost test separately proves probe→status wiring and selected fix execution

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/readiness.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/state.test.ts:23`

**KEEP** — state file: unreadable entries are dropped, unknown keys kept on rewrite

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `state file: unreadable entries are dropped, unknown keys kept on rewrite`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 restart survival, README hub.json tolerant cache record; AGENTS unknown-field preservation; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** state file: unreadable entries are dropped, unknown keys kept on rewrite. Credible failure classes: Unknown envelope data lost; malformed records crash restart; running interrupted golden retained or vanished device kept; state file exposes data or loses lease binding.
- **Independent oracle:** Literal future envelope field, known good/bad records, keep/reap/forget IDs and actual fresh file mode/lease ID; trailing newline assertion removed
- **Stable seam:** Host state persistence codec/read/write and planReattach state reconciliation
- **Refactor resistance:** No JSON formatting/order/private temp filenames; durable process identity and tolerant public records remain
- **Unique protection:** Real local restart owns native marker/process lifecycle; pure state cases uniquely cover malformed/unknown envelope, interrupted golden/gone record and hub decision compatibility

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/state.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/state.test.ts:41`

**KEEP** — reattach: keep what runs under a live lease, reap running orphans and golden boots, forget the gone

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `reattach: keep what runs under a live lease, reap running orphans and golden boots, forget the gone`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 restart survival, README hub.json tolerant cache record; AGENTS unknown-field preservation; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** reattach: keep what runs under a live lease, reap running orphans and golden boots, forget the gone. Credible failure classes: Unknown envelope data lost; malformed records crash restart; running interrupted golden retained or vanished device kept; state file exposes data or loses lease binding.
- **Independent oracle:** Literal future envelope field, known good/bad records, keep/reap/forget IDs and actual fresh file mode/lease ID; trailing newline assertion removed
- **Stable seam:** Host state persistence codec/read/write and planReattach state reconciliation
- **Refactor resistance:** No JSON formatting/order/private temp filenames; durable process identity and tolerant public records remain
- **Unique protection:** Real local restart owns native marker/process lifecycle; pure state cases uniquely cover malformed/unknown envelope, interrupted golden/gone record and hub decision compatibility

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/state.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/android/state.test.ts:57`

**REWRITE** — state file: written atomically with mode 0600; a missing file reads empty

Remove incidental trailing-newline check; actual mode0600/fresh-store lease binding and missing-file fallback remain.

Surviving owner: `state file: written atomically with mode 0600; a missing file reads empty`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 restart survival, README hub.json tolerant cache record; AGENTS unknown-field preservation; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** state file: written atomically with mode 0600; a missing file reads empty. Credible failure classes: Unknown envelope data lost; malformed records crash restart; running interrupted golden retained or vanished device kept; state file exposes data or loses lease binding.
- **Independent oracle:** Literal future envelope field, known good/bad records, keep/reap/forget IDs and actual fresh file mode/lease ID; trailing newline assertion removed
- **Stable seam:** Host state persistence codec/read/write and planReattach state reconciliation
- **Refactor resistance:** No JSON formatting/order/private temp filenames; durable process identity and tolerant public records remain
- **Unique protection:** Real local restart owns native marker/process lifecycle; pure state cases uniquely cover malformed/unknown envelope, interrupted golden/gone record and hub decision compatibility

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/android/state.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:104`

**REWRITE** — readiness: a fresh appdir needs setup, with a fix action per installable item

Remove constant stream-capability self-assertion/default count; retain real readiness/state wiring, actionable setup IDs and unavailable endpoints/config.

Surviving owner: `readiness: a fresh appdir needs setup, with a fix action per installable item`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** readiness: a fresh appdir needs setup, with a fix action per installable item. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:123`

**KEEP** — setup: runs the asked fix actions, then names what is still missing; Java blocks SDK installs

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `setup: runs the asked fix actions, then names what is still missing; Java blocks SDK installs`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** setup: runs the asked fix actions, then names what is still missing; Java blocks SDK installs. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:141`

**REWRITE** — boot: refused while the host is not ready, and for iOS profiles

Use specific public PLATFORM_NOT_READY/INVALID_ARGUMENT error codes instead of incidental wording for wrong platform/not-ready operations.

Surviving owner: `boot: refused while the host is not ready, and for iOS profiles`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** boot: refused while the host is not ready, and for iOS profiles. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:151`

**KEEP** — restart: reattach to an emulator a live lease holds, reap one no lease holds and a stray; release stops it

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `restart: reattach to an emulator a live lease holds, reap one no lease holds and a stray; release stops it`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** restart: reattach to an emulator a live lease holds, reap one no lease holds and a stray; release stops it. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:194`

**DELETE** — release: a lost lease whose serial now names a golden boot leaves that emulator running

DELETE private host.emulators injection. Golden record has leaseId=null, so same ownership refusal is already protected by existing public restart case releasing a wrong lease ID against an actual current emulator then observing it alive; matching release later stops it.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** release: a lost lease whose serial now names a golden boot leaves that emulator running. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:211`

**KEEP** — teardown (plugin off): every emulator stops, then the hub, agent-device and the adb server; no boot starts after

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `teardown (plugin off): every emulator stops, then the hub, agent-device and the adb server; no boot starts after`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** teardown (plugin off): every emulator stops, then the hub, agent-device and the adb server; no boot starts after. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:238`

**REWRITE** — teardown while the services are still starting: agent-device never starts after it

REWRITE through public host.start/teardown, real host/toolchain state, a real marked process, native spawn/fetch ports and a health-response gate. Assert process exit, cleared persisted hub/config and no actual agent-device start command. No private startServices/hub/agentDevice patch.

Surviving owner: `teardown while hub health is pending leaves no hub or later agent daemon`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** teardown while the services are still starting: agent-device never starts after it. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:264`

**REWRITE** — uploads land in their own 0700 dir with a safe name

REWRITE incidental UUID/name-shape assertion into actual upload containment in private per-upload directory, exact supplied file bytes and0700directory/0600file permissions.

Surviving owner: `uploads land in their own 0700 dir with a safe name`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** uploads land in their own 0700 dir with a safe name. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/hosts/local-android.test.ts:271`

**REWRITE** — agent-device: the pinned CLI under this node with the private env; refused until installed

Remove assertion-free viewersChanged calls; preserve real pinned command path/node/private environment and unavailable error behavior.

Surviving owner: `agent-device: the pinned CLI under this node with the private env; refused until installed`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §6.2 and README local-host lifecycle/privacy; durable lease ownership and plugin-off teardown; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** agent-device: the pinned CLI under this node with the private env; refused until installed. Credible failure classes: Wrong lease kills current emulator; native marker mistakes kill foreign appdir; shutdown restarts helper; setup cannot run asked fix; upload escapes sandbox/permissions; pinned agent entry/env not wired.
- **Independent oracle:** Actual marked sleep stand-ins, persisted host state, real liveness and public capacity/list results; external program invocation refusal, actual upload bytes/modes/containment
- **Stable seam:** LocalAndroidHost public readiness/ensureReady/boot/reattach/release/teardown/start/uploadFile/agentDeviceCommand. Race uses native executor/fetch dependency boundaries, never private host members
- **Refactor resistance:** Private emulator map/private startServices collaborator spies removed; UUID directory shape/viewer coverage probes removed; actual states/files/processes remain
- **Unique protection:** Only local lifecycle wiring/lease ownership owner; lower pure policy and fake-machine tests do not prove native restart/reap/release; box hosts separately own remote wiring

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/hosts/local-android.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/index.test.ts:76`

**KEEP** — android: cmdline-tools, licences, packages; a failed step resumes without redoing the done ones

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `android: cmdline-tools, licences, packages; a failed step resumes without redoing the done ones`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 idempotent owner-authorized SDK setup; research§2 avdmanager placeholder capture; README toolchain; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** android: cmdline-tools, licences, packages; a failed step resumes without redoing the done ones. Credible failure classes: Failed SDK install cannot resume, licenses use wrong root, image/AVD profile wrong, private env lost, stale config not repaired, missing npm reported incorrectly.
- **Independent oracle:** Actual temp SDK/AVD files and state, literal named profile/device keys, independently supplied failing download line and error code; fake only supplies external SDK programs
- **Stable seam:** createDeviceToolchain public ensure/status API and native SDK argv/env/ini/marker formats
- **Refactor resistance:** Assertions observe public installation state/config and external protocol, not implementation helper calls; no network/native emulator needed
- **Unique protection:** Only owner of full SDK retry/status/env/profile-marker assembly; avd-config unit alone does not prove SDK creation invokes or persists tuned config

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/index.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/index.test.ts:118`

**KEEP** — android: an AVD is created per profile, its config patched; the private env is used

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `android: an AVD is created per profile, its config patched; the private env is used`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 idempotent owner-authorized SDK setup; research§2 avdmanager placeholder capture; README toolchain; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** android: an AVD is created per profile, its config patched; the private env is used. Credible failure classes: Failed SDK install cannot resume, licenses use wrong root, image/AVD profile wrong, private env lost, stale config not repaired, missing npm reported incorrectly.
- **Independent oracle:** Actual temp SDK/AVD files and state, literal named profile/device keys, independently supplied failing download line and error code; fake only supplies external SDK programs
- **Stable seam:** createDeviceToolchain public ensure/status API and native SDK argv/env/ini/marker formats
- **Refactor resistance:** Assertions observe public installation state/config and external protocol, not implementation helper calls; no network/native emulator needed
- **Unique protection:** Only owner of full SDK retry/status/env/profile-marker assembly; avd-config unit alone does not prove SDK creation invokes or persists tuned config

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/index.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/index.test.ts:152`

**KEEP** — tools: none installed in a fresh appdir; installing needs npm

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `tools: none installed in a fresh appdir; installing needs npm`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 idempotent owner-authorized SDK setup; research§2 avdmanager placeholder capture; README toolchain; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** tools: none installed in a fresh appdir; installing needs npm. Credible failure classes: Failed SDK install cannot resume, licenses use wrong root, image/AVD profile wrong, private env lost, stale config not repaired, missing npm reported incorrectly.
- **Independent oracle:** Actual temp SDK/AVD files and state, literal named profile/device keys, independently supplied failing download line and error code; fake only supplies external SDK programs
- **Stable seam:** createDeviceToolchain public ensure/status API and native SDK argv/env/ini/marker formats
- **Refactor resistance:** Assertions observe public installation state/config and external protocol, not implementation helper calls; no network/native emulator needed
- **Unique protection:** Only owner of full SDK retry/status/env/profile-marker assembly; avd-config unit alone does not prove SDK creation invokes or persists tuned config

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/index.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/lock.test.ts:18`

**REWRITE** — lock: the pid file appears whole; the dir goes after the run

Remove private temporary-directory inventory; preserve published owner pid and final lock cleanup.

Surviving owner: `lock: the owner pid is published while held and the lock is removed after the run`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 one install per tool and README pid-lock atomic/stale-owner protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** lock: the pid file appears whole; the dir goes after the run. Credible failure classes: Live or young unknown owner is stolen; stale owner cannot recover; cancel reason lost; owner pid not published or lock remains after completion.
- **Independent oracle:** Literal real pid file, actual live/dead process IDs, controlled old mtime and same explicit Error identity for cancellation
- **Stable seam:** withLock/inspectLock on actual temporary interprocess lock filesystem protocol
- **Refactor resistance:** No temporary filename/in-directory inventory expectation; no real700ms delay; optional unused now hook removed
- **Unique protection:** Only interprocess installer lock owner; installer happy paths cannot reproduce stale/live/young ownership and cancellation

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/lock.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/lock.test.ts:29`

**OPTIMIZE** — lock: a young dir with no pid file is held (its owner is between mkdir and the rename); an old one is stale

OPTIMIZE700ms arbitrary abort timer away: directly assert young lock held, exact already-aborted Error identity, old mtime stale and successful recovery. This removes a false-positive any-rejection cancellation oracle.

Surviving owner: `lock: a young dir with no pid file is held (its owner is between mkdir and the rename); an old one is stale`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 one install per tool and README pid-lock atomic/stale-owner protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** lock: a young dir with no pid file is held (its owner is between mkdir and the rename); an old one is stale. Credible failure classes: Live or young unknown owner is stolen; stale owner cannot recover; cancel reason lost; owner pid not published or lock remains after completion.
- **Independent oracle:** Literal real pid file, actual live/dead process IDs, controlled old mtime and same explicit Error identity for cancellation
- **Stable seam:** withLock/inspectLock on actual temporary interprocess lock filesystem protocol
- **Refactor resistance:** No temporary filename/in-directory inventory expectation; no real700ms delay; optional unused now hook removed
- **Unique protection:** Only interprocess installer lock owner; installer happy paths cannot reproduce stale/live/young ownership and cancellation

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/lock.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/lock.test.ts:46`

**KEEP** — lock: a live owner holds it; a dead owner's lock is taken over

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `lock: a live owner holds it; a dead owner's lock is taken over`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 one install per tool and README pid-lock atomic/stale-owner protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** lock: a live owner holds it; a dead owner's lock is taken over. Credible failure classes: Live or young unknown owner is stolen; stale owner cannot recover; cancel reason lost; owner pid not published or lock remains after completion.
- **Independent oracle:** Literal real pid file, actual live/dead process IDs, controlled old mtime and same explicit Error identity for cancellation
- **Stable seam:** withLock/inspectLock on actual temporary interprocess lock filesystem protocol
- **Refactor resistance:** No temporary filename/in-directory inventory expectation; no real700ms delay; optional unused now hook removed
- **Unique protection:** Only interprocess installer lock owner; installer happy paths cannot reproduce stale/live/young ownership and cancellation

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/lock.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/npm-tools.test.ts:56`

**REWRITE** — install: staging → sentinel → rename; the hub gets its scrcpy jar; installing again is a no-op

REWRITE checksum/cache/publish protection through actual shared downloadPinned and tiny controlled Response bytes with independently known SHA256(hello). Remove mock-driven hub-path/sentinel self-assertions and test-only scrcpy pin/lock injection. Generic installer success/idempotence assertions consolidate into existing incomplete-sentinel case.

Surviving owner: `pinned downloads verify actual bytes, reuse verified cache and preserve prior files on checksum failure`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 pinned reproducible installs and version pruning; README npm tools/download integrity protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** install: staging → sentinel → rename; the hub gets its scrcpy jar; installing again is a no-op. Credible failure classes: Unverified bytes published, trusted cache refetched, previous bytes overwritten on mismatch; failed/partial npm marked installed; lifecycle scripts enabled; shipped lock/pin drift; rollback version pruned.
- **Independent oracle:** Literal SHA256(hello)2cf24d…9824 and actual bytes/cache/partial files; literal native npm ci --ignore-scripts; independent external package entry paths and real shipped lock metadata
- **Stable seam:** downloadPinned with controlled HTTP Response plus actual filesystem; installNpmTool and shipped npm lock/config format; pruneToolVersions actual retained dirs
- **Refactor resistance:** Test-only pin/lock overrides and lockFor fixture removed; no helper-derived checksum/oracle or private argument ordering
- **Unique protection:** Checksum contract now lives at real shared downloader instead of fake downloader; installer sentinel/rollback/config tests cover distinct resumability and deployment failure modes

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/npm-tools.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/npm-tools.test.ts:89`

**REWRITE** — install: a failed npm leaves nothing installed and no staging dir; the error names npm's last line

Follow actual shipped version to reach intended npm failure after removing test lock injection; still requires exact404failure cause, absent installation and staging cleanup.

Surviving owner: `install: a failed npm leaves nothing installed and no staging dir; the error names npm's last line`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 pinned reproducible installs and version pruning; README npm tools/download integrity protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** install: a failed npm leaves nothing installed and no staging dir; the error names npm's last line. Credible failure classes: Unverified bytes published, trusted cache refetched, previous bytes overwritten on mismatch; failed/partial npm marked installed; lifecycle scripts enabled; shipped lock/pin drift; rollback version pruned.
- **Independent oracle:** Literal SHA256(hello)2cf24d…9824 and actual bytes/cache/partial files; literal native npm ci --ignore-scripts; independent external package entry paths and real shipped lock metadata
- **Stable seam:** downloadPinned with controlled HTTP Response plus actual filesystem; installNpmTool and shipped npm lock/config format; pruneToolVersions actual retained dirs
- **Refactor resistance:** Test-only pin/lock overrides and lockFor fixture removed; no helper-derived checksum/oracle or private argument ordering
- **Unique protection:** Checksum contract now lives at real shared downloader instead of fake downloader; installer sentinel/rollback/config tests cover distinct resumability and deployment failure modes

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/npm-tools.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/npm-tools.test.ts:98`

**REWRITE** — install: a dir without the sentinel is not installed and is replaced

REWRITE to actual shipped agent-device pin/lock, literal external package entry path, native npm ci --ignore-scripts and installed reuse. No test-only lockFor or production lock override remains.

Surviving owner: `install: a dir without the sentinel is not installed and is replaced`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 pinned reproducible installs and version pruning; README npm tools/download integrity protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** install: a dir without the sentinel is not installed and is replaced. Credible failure classes: Unverified bytes published, trusted cache refetched, previous bytes overwritten on mismatch; failed/partial npm marked installed; lifecycle scripts enabled; shipped lock/pin drift; rollback version pruned.
- **Independent oracle:** Literal SHA256(hello)2cf24d…9824 and actual bytes/cache/partial files; literal native npm ci --ignore-scripts; independent external package entry paths and real shipped lock metadata
- **Stable seam:** downloadPinned with controlled HTTP Response plus actual filesystem; installNpmTool and shipped npm lock/config format; pruneToolVersions actual retained dirs
- **Refactor resistance:** Test-only pin/lock overrides and lockFor fixture removed; no helper-derived checksum/oracle or private argument ordering
- **Unique protection:** Checksum contract now lives at real shared downloader instead of fake downloader; installer sentinel/rollback/config tests cover distinct resumability and deployment failure modes

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/npm-tools.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/npm-tools.test.ts:111`

**KEEP** — prune: keeps the current and the most recent previous version; staging leftovers go

KEEP independently specified behavioral/protocol outcome at its lowest stable owner; no justified rewrite or execution optimization found.

Surviving owner: `prune: keeps the current and the most recent previous version; staging leftovers go`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 pinned reproducible installs and version pruning; README npm tools/download integrity protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** prune: keeps the current and the most recent previous version; staging leftovers go. Credible failure classes: Unverified bytes published, trusted cache refetched, previous bytes overwritten on mismatch; failed/partial npm marked installed; lifecycle scripts enabled; shipped lock/pin drift; rollback version pruned.
- **Independent oracle:** Literal SHA256(hello)2cf24d…9824 and actual bytes/cache/partial files; literal native npm ci --ignore-scripts; independent external package entry paths and real shipped lock metadata
- **Stable seam:** downloadPinned with controlled HTTP Response plus actual filesystem; installNpmTool and shipped npm lock/config format; pruneToolVersions actual retained dirs
- **Refactor resistance:** Test-only pin/lock overrides and lockFor fixture removed; no helper-derived checksum/oracle or private argument ordering
- **Unique protection:** Checksum contract now lives at real shared downloader instead of fake downloader; installer sentinel/rollback/config tests cover distinct resumability and deployment failure modes

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/npm-tools.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

### `apps/daemon/src/devices/toolchain/npm-tools.test.ts:132`

**REWRITE** — locks: every pinned tool ships a lock of exactly its version (and the box lock pins both); no other version installs

Read actual box package/lock dependency versions independently instead of asking production lockPins to certify itself. Shipped config integrity/version and unsupported-version refusal remain; retain lockPins export for hosts/box/remote.ts production installation.

Surviving owner: `locks: every pinned tool ships a lock of exactly its version (and the box lock pins both); no other version installs`.

- **Independent source:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5 pinned reproducible installs and version pruning; README npm tools/download integrity protocol; docs/superpowers/research/2026-10-27-devices-spikes.md; apps/daemon/src/devices/README.md
- **Credible failure:** locks: every pinned tool ships a lock of exactly its version (and the box lock pins both); no other version installs. Credible failure classes: Unverified bytes published, trusted cache refetched, previous bytes overwritten on mismatch; failed/partial npm marked installed; lifecycle scripts enabled; shipped lock/pin drift; rollback version pruned.
- **Independent oracle:** Literal SHA256(hello)2cf24d…9824 and actual bytes/cache/partial files; literal native npm ci --ignore-scripts; independent external package entry paths and real shipped lock metadata
- **Stable seam:** downloadPinned with controlled HTTP Response plus actual filesystem; installNpmTool and shipped npm lock/config format; pruneToolVersions actual retained dirs
- **Refactor resistance:** Test-only pin/lock overrides and lockFor fixture removed; no helper-derived checksum/oracle or private argument ordering
- **Unique protection:** Checksum contract now lives at real shared downloader instead of fake downloader; installer sentinel/rollback/config tests cover distinct resumability and deployment failure modes

Validation target: `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/devices/toolchain/npm-tools.test.ts`. Passed in exclusive15-file focused run58/58; minor final test oracle/flag-order edits in hub/readiness/npm files require root final gate. No hardware integration executed.

## Manual hardware workflow

**REWRITE** — `apps/daemon/src/devices/android/integration.it.ts`

Replace logging-only probes with distinct emulator IDs, successful sys.boot_completed, authenticated/unauthenticated status and both device listings, actual agent-device JSON/device IDs, restart identity+leases, ready tool-open and nonempty semantic snapshots. Bound overall signal and readiness event wait; use existing host change events instead of250ms polling. Add finally teardown and0600logs/integration-result.json artifact excluding credentials. Remove dead openWaitMs and idleTimer overrides; production defaults apply.

Not executed: focused slot excluded real hardware. Requires separate throwaway appdir/KVM and actual SDK/tool assets; root final TypeScript gate must check the script.

- **independentContract:** Critical two-device agent workflow, authenticated endpoint, restart survival and plugin-off cleanup explicitly specified by README/phase1/research.
- **realRegression:** Script previously could exit0 on failed boot, exposed hub, failed CLI, lost reattach or empty snapshot; these now fail actual assertions.
- **independentOracle:** Literal boot property1, statuses200vs401/403, two known returned serials, matching restarted endpoint/token, ready lease state and semantic output, no marked processes.
- **stableSeam:** Actual local factory, native SDK/emulator/hub/agent-device, DeviceService tool methods and durable records.
- **refactorResistance:** Public process/auth/state/semantic outcomes; no internal helper inventory or implementation shape.
- **uniqueProtection:** Default tests isolate native SDK/hub dependencies; manual scenario uniquely proves actual pinned programs cooperate on real KVM. Existing box integration owns a separate remote transport/provider workflow.

## Remaining limits

Public native hub-health teardown race253.613245ms and fake-machine SIGTERM escalation203.957923ms; remaining time is small native lifecycle/condition polling plus worker startup. Actual SDK/KVM integration remains intentionally manual and expensive.

Per-case before/after compares parent-reported reference run to focused equivalent per-file runner concurrency; host/load differ somewhat. No comparable15-file baseline wall time or CI speedup measured here. Root owns full-suite totals. Real fake-ADB delay removal dominates7.5s saving.

No package/repository typecheck/full suite by this workstream; root owns final gate. No real hardware/SDK/model/browser integration run.


## Integration correction

The root backend gate found two route imports failing with a missing-export SyntaxError: `hosts/box/remote.ts` is a production consumer of `lockPins`. Its export is restored. A whole-repository audit of the other privatized helper symbols found no additional production consumers; shared cache-workflow constants remain exported. No export-inventory test was added. Root owns the rerun and final gate; the failed run is not reported as passing.

The changed-file typecheck also found TS7022 on inference of the manual authenticated fetch result. Both fetch results now use descriptive names and explicit native `Response` annotations; all auth/status/device-list assertions remain. The root rerun owns confirmation; no hardware run was performed.
