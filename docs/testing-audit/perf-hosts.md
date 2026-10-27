# Incoming Android host performance audit

Incoming identities are from `ee5c32495c88e39ff8cfef73dce8d43e59f4483f` against `610d3c53`. Scope: two changed registrations, one existing surviving owner, the Linux hardware fixture and an erased annotation in the opt-in stream harness. Prior610d cleanup and namespace safety remain intact.

Disposition counts: two REWRITE, one CONSOLIDATE. The new standalone low-memory case is removed after transferring every meaningful assertion. The cleaned Android host file remains nine tests. Against the merged index, test source is +8/−16 lines (net−8); fixture source is +2/−2. No new production seams or dependencies.

The two surviving owners overlap the prior610d audit and must not be counted as additional baseline tests. The raw incoming file also contains the cached-GPU duplicate already consolidated in that earlier cleanup.

- `apps/daemon/src/devices/hosts/box/android-host.test.ts:115` — **REWRITE**: prepares a box the device caches restored: nothing installed, hub and agent-device forwarded, the token in no argv or env
  - Final owner: `apps/daemon/src/devices/hosts/box/android-host.test.ts:115` — prepares a box the device caches restored: nothing installed, hub and agent-device forwarded, the token in no argv or env.
  - independentContract: Existing pinned-cache/auth/private-config setup plus platform resource admission: a ready box with no memory above its host reserve may not start a lease.
  - realRegression: The box memory result is dropped/misparsed and the host falls back to CPU capacity, or boot ignores zero slots and starts an emulator.
  - independentOracle: Known4GiB fake remote MemAvailable, expected public{used:0,total:0}, error{code:DEVICE_CAPACITY,status:503}, and empty external emulator argument log; existing literal token/config/file-mode oracles remain.
  - stableSeam: Actual public BoxAndroidHost.prepare/capacity/boot and real temporary scripted SDK/loopback processes through isolatedDeviceBox.
  - refactorResistance: No private-state override or computed production oracle; only supplied hardware wire data and caller-visible capacity/refusal/side-effect outcomes.
  - uniqueProtection: Owns remote-memory sampling→ready-host boot refusal; pure capacity/local-host tests cannot prove the concrete BoxExecutor/Linux-host wiring. It already performs the required expensive preparation, making a second standalone setup redundant.
- `apps/daemon/src/devices/hosts/box/android-host.test.ts:194` — **CONSOLIDATE**: refuses a boot when the box has no memory beyond the host reserve
  - Final owner: `apps/daemon/src/devices/hosts/box/android-host.test.ts:115` — prepares a box the device caches restored: nothing installed, hub and agent-device forwarded, the token in no argv or env.
  - Separate execution removed: Unique protection after its entire public refusal contract is transferred into the existing prepared-cache owner; separate SDK/hub/agent prepare is repeated expensive work.
  - independentContract: Resource admission and public DEVICE_CAPACITY503 contract from approved device requirements/API.
  - realRegression: No usable memory must never launch an emulator despite a successful host setup.
  - independentOracle: Explicit zero capacity and typed503 refusal for independently supplied remote4GiB; zero external emulator launches.
  - stableSeam: Public ready host capacity/boot; genuine scripted process startup boundary remains in the surviving owner.
  - refactorResistance: Transferred assertions inspect only DTO/error and real side-effect log, with no private fields or source matching.
  - uniqueProtection: The contract remains unique, but its separate execution adds no protection once the existing setup test owns all assertions.
- `apps/daemon/src/devices/hosts/box/android-host.test.ts:150` — **REWRITE**: boots read-only instances from orq-golden with its GPU mode; adb runs with the box's private env; release stops them
  - Final owner: `apps/daemon/src/devices/hosts/box/android-host.test.ts:152` — boots read-only instances from orq-golden with its GPU mode; adb runs with the box's private env; release stops them.
  - independentContract: The independent §3 Decisions paragraph at docs/superpowers/research/2026-10-27-devices-spikes.md:57 explicitly selects the default Blacksmith16-vCPU device-pool box with8 emulators. This default rented-box fixture uses that size with64GiB. Existing actual lease lifecycle/GPU/env/ownership contracts remain.
  - realRegression: Concrete remote capacity unexpectedly becomes1/4/0 despite enough configured CPU/memory, or uses host load instead of the deterministic remote fixture.
  - independentOracle: Literal8 comes from the documented default Blacksmith sizing decision, not a calculation using boxAndroidCapacity or imported production limits. The16CPU/64GiB fixture supplies independent machine data; existing distinct real lease PIDs/serials and external flags remain.
  - stableSeam: Public host.capacity after real preparation, plus existing public boot/release and actual child-process identity outcomes.
  - refactorResistance: No per-host memory formula copied into expected value, no imported cap constant or private-map mutation.
  - uniqueProtection: This is already the normal-capacity concrete Linux-host integration owner; moving the assertion here complements the zero-memory setup owner without another process/server startup.

Independent sources:
- `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §5/§6/anti-goals`
- `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §2 goals1,2,8,11`
- `docs/superpowers/research/2026-10-27-devices-spikes.md:57 §3 Decisions: device-pool boxes default to blacksmith-16vcpu-ubuntu-2404 with 8 emulators (12 when mostly idle; never >16)`
- `apps/daemon/src/devices/README.md BoxAndroidHost capacity/readiness contract`
- `packages/api/src/devices.ts DEVICE_CAPACITY caller-visible error contract`
- `Linux /proc/meminfo MemAvailable KiB wire format`

Supporting changes:
- `android-testing.ts`: keep deterministic external Linux `MemAvailable` fixture bytes; match `cat` by executable basename and its exact `/proc/meminfo` argument. Keep `provider` and `isolatedDeviceBox`, environment scrubbing and realpath containment. The fixture does not implement the admission policy.
- `stream-integration.it.ts:86`: retain the explicit `BoxAndroidHost` type that resolves self-referential `activeLeases` inference. Keep the isolated connection and actual default host root; no manual hardware run.
- The incoming `LocalBoxConnection.exec` interface is unchanged. Incoming `writeTar` fixes/test hooks belong to the boxes owner; Android preparation does not use them and its namespace adapter still blocks tar/raw channels.

Validation and performance: no tests/typechecks were launched while root measures the matching baseline. Focused Android file, capacity-gate mutant and required repository checks remain pending root slot. Source consolidation eliminates one repeated prepare/server/agent setup; runtime savings are unmeasured. Root owns comparable whole-suite measurements. No paid rental, SSH, hardware, manual integration, staging or commit occurred.
