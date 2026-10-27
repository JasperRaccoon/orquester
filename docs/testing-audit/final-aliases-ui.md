# Final UI test-title aliases

These 14 rows map final surviving titles to existing audited source identities. They add no tests, baseline cases, disposition counts or validation claims. Every disposition is the original ledger decision. `finalLine` matches the current declaration; original lines come from their source baseline. Where an earlier ledger recorded a neighboring blank line, the original source line and recorded line are both retained in JSON.

## packages/ui/src/components/device/stream/semu.test.ts:34

**Final title:** parses v2 payloads after their extra server-time header

**Disposition:** REWRITE (existing decision). Source ledger: [devices-stream.json](devices-stream.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/device/stream/semu.test.ts:35 — parses v2 headers (24 bytes, server send time)

1. **independentContract:** The observed serve-emu Bun v2 protocol adds an 8-byte send-time header to the v1 SEMU packet; actual H264 payload/key flag and microsecond PTS survive. Source: device spike SEMU v1/v2 observations and serve-emu-semu-v1.bin provenance; approved phase1 §10.1 streaming compatibility.

2. **recognizableFailure:** Using the v1 offset for v2 sends the extra server-time bytes to the video decoder, corrupting its access unit; incorrect PTS offset/units breaks decoded timing.

3. **independentOracle:** The recorded second packet has literal PTS 42481638 and a delta flag; expected Annex-B payload is the raw recorded v1 bytes after its 16-byte header. Neither expected value calls the production parser.

4. **stableSeam:** parseSemuPacket returned data/isKey/timestamp, actually consumed by ServeEmuSession before WebCodecs.

5. **refactorResistance:** Compares meaningful protocol bytes and time rather than unused version/serverTimeMs fields, helper exports or object identity. The converter may move or rename without changing the contract.

6. **uniqueProtection:** The recorded end-to-end session uses v1 ArrayBuffers. V1 parsing/view/raw tests cannot catch failing to skip the extra v2 header; this is its lowest wire-format owner.

## packages/ui/src/components/device/three/flat.test.ts:36

**Final title:** reports the native framebuffer aspect in its visible orientation

**Disposition:** REWRITE (existing decision). Source ledger: [devices-three.json](devices-three.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/device/three/flat.test.ts:87 — reports the visible aspect, defaulting by platform before a frame

1. **independentContract:** Native decoded dimensions must describe the visible orientation: iOS may send a portrait framebuffer while the interface is landscape; Android frames are already rotated. Source: approved phase1 §10.1 stream/touch orientation and viewport frame contract.

2. **recognizableFailure:** Swapping dimensions incorrectly squeezes landscape iOS output or double-swaps an Android frame, breaking correspondence between displayed video and normalized input.

3. **independentOracle:** Independent known frame dimensions give literal ratios 1206/2622, 2622/1206 and 2400/1080. The expectation does not call a layout or transformation helper.

4. **stableSeam:** Production-consumed deviceScreenAspect(platform,nativeFrame,orientation), used by DeviceViewport/DeviceFlatViewport.

5. **refactorResistance:** Checks the native orientation relationship, with tolerances, without undocumented cosmetic defaults, CSS trees or a generated geometry snapshot.

6. **uniqueProtection:** Pointer normalization and screenshot rotation do not determine the aspect of the displayed native frame. This owner uniquely catches wrong dimension swapping; undocumented pre-frame defaults were pruned.

## packages/ui/src/components/device/three/flat.test.ts:54

**Final title:** maps screen coordinates to pixels from the viewport's top-left

**Disposition:** REWRITE (existing decision). Source ledger: [devices-three.json](devices-three.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/device/three/flat.test.ts:158 — maps a screen point to pixels from the viewport's top-left and inverts flatScreenPoint

1. **independentContract:** The viewport projectPoint interface returns CSS pixels from the viewport top-left for agent tap overlays. Source: phase1 §10.1 normalized touch/agent-overlay contract and DeviceViewport.projectPoint.

2. **recognizableFailure:** Using page coordinates or the wrong root offset moves the agent tap overlay even while device touch input remains correct.

3. **independentOracle:** Hand-authored screen rectangle (120,60,200,400) and root origin (100,50) require literal points (20,10) and (120,110). The inverse production-function oracle was removed.

4. **stableSeam:** flatViewPoint output consumed by DeviceViewport.projectPoint and the visible agent overlay.

5. **refactorResistance:** Observes the documented coordinate origin/data instead of DOM nesting, styling, helper identity or inverse implementation symmetry.

6. **uniqueProtection:** Input mapping computes the opposite direction and a 3D camera projection does not use flat DOM offsets. Neither supersedes this flat overlay output owner.

## packages/ui/src/components/device/three/modelScene.test.ts:82

**Final title:** preserves normalized screen coordinates when loading a meshopt-quantized display

**Disposition:** REWRITE (existing decision). Source ledger: [devices-three.json](devices-three.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/device/three/modelScene.test.ts:82 — bakes a meshopt-quantized display's node transform back into float geometry

1. **independentContract:** Converted device-screen assets are centered, 2.2 units wide and face +Z; meshopt-normalized integer attributes must preserve the same normalized display/touch coordinates after loading. Source: scripts/convert-device-model.py asset header and phase1 §10.4 compressed GLB support.

2. **recognizableFailure:** Transforming normalized int16 attributes in place corrupts positions and touch mapping even though ordinary float assets load correctly.

3. **independentOracle:** Pre-quantization Three PlaneGeometry vertex positions are the independent reference. Standard normalized-int16 fixture data must recover them within 1e-4; an actual center ray must map to (0.5,0.5).

4. **stableSeam:** Converted asset→bakeDisplayTransform→createImportedPhoneScene/screenPoint, used by loadDeviceModel and phoneViewer.

5. **refactorResistance:** Compares accepted asset semantics, vertex coordinates and touch results; Float32Array class and unit-scale representation assertions were removed.

6. **uniqueProtection:** Malformed-asset and ordinary-float lifecycle cases never exercise normalized integer dequantization. A varying shipped binary only proves load acceptance; this fixture isolates semantic coordinate preservation.

## packages/ui/src/components/devices-fleet/devices-fleet.dom.test.ts:212

**Final title:** visible cards fetch authenticated thumbnails and their current action log

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/devices-fleet/devices-fleet.dom.test.ts:209 — groups leased devices under their hosts, with chats, agents, last actions and thumbnails

1. **independentContract:** Actual visible lease cards request authenticated downscaled thumbnails and load/render current action data. Source: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts

2. **recognizableFailure:** Thumbnail route/auth forwarding or action subscription wiring breaks while lower helper tests pass.

3. **independentOracle:** Literal GET thumbnail paths for emulator-5554/A1B2-ios-1, width 320 and Bearer t; no request for starting A1B2-ios-3; actual image receives blob:frame and the independently seeded action appears.

4. **stableSeam:** Actual mounted React controls, API/fetch boundary, shared app state and session deep links.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** Pure grouping/path/poller owners cannot detect missing visible-card effects, lost Authorization or the action log never subscribing/rendering. This is the real component integration owner after sort/row/markup inventories were removed.

## packages/ui/src/components/devices-fleet/devices-fleet.dom.test.ts:267

**Final title:** a deadline drain cannot be resumed and explains the unavailable control

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/devices-fleet/devices-fleet.dom.test.ts:275 — a host drained near its deadline reads Ending soon (deadline), with Resume off and the reason

1. **independentContract:** Deadline-drained hosts cannot resume and explain the unavailable control. Source: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts

2. **recognizableFailure:** The GUI sends a resume forbidden by daemon deadline rule.

3. **independentOracle:** Hand-authored drainReason=deadline; Resume is disabled, an explanation is present, and clicking cannot produce a drain/resume API call.

4. **stableSeam:** Actual mounted React controls, API/fetch boundary, shared app state and session deep links.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** Daemon authorization can reject Resume yet leave a misleading live GUI control. Pure host data projections were consolidated into this actual disabled/no-dispatch component owner.

## packages/ui/src/components/devices-fleet/fleet.logic.test.ts:10

**Final title:** keeps every leased device with its host, including unknown or disabled hosts

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/devices-fleet/fleet.logic.test.ts:33 — puts this host first, then hosts by status and age, each with its leases

1. **independentContract:** The fleet groups all active leases by their host and retains leases on unknown/disabled hosts; released devices do not appear. Source: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts

2. **recognizableFailure:** A device disappears when its host is absent/off or appears under another host.

3. **independentOracle:** Three hosts and four independently named lease records yield exact host-to-lease membership for box:rented/remote, gone/orphan and local/local, with released omitted and the missing host represented as null. Ordering is normalized outside the owner.

4. **stableSeam:** Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** The reduced DOM fixture tests interactions rather than an exhaustive grouping inventory. This lowest data-projection owner alone covers orphaned/disabled host membership and released omission without sorting/appearance constraints.

## packages/ui/src/components/devices-fleet/fleet.logic.test.ts:34

**Final title:** a lease shares the host's rate with devices still held, times the lease's age

**Disposition:** CONSOLIDATE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/devices-fleet/fleet.logic.test.ts:137 — a lease's share splits the host's $/h across the leases on it, times the lease's age

1. **independentContract:** Per-lease estimated cost splits the current host rate across still-held devices, multiplied by lease age. Source: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts

2. **recognizableFailure:** Lost devices dilute active device cost or a lease rate/cost uses the wrong divisor/time unit.

3. **independentOracle:** Independent known arithmetic: $1.92/h divided among three ready/starting/suspended held devices gives $0.64/h, and a 30-minute lease costs $0.32. The lost device is excluded from the divisor.

4. **stableSeam:** Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** Host and pool monetary totals do not catch including lost leases in a per-lease divisor or multiplying by host uptime rather than lease age. The held-state divisor and cost-share cases now share this surviving owner.

## packages/ui/src/components/devices-fleet/fleet.logic.test.ts:41

**Final title:** the pool header sums working capacity and exposes queue, rate and budget

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/components/devices-fleet/fleet.logic.test.ts:152 — the pool header sums capacity over working hosts and compares spend with the cap

1. **independentContract:** Pool display reflects usable capacity, requested queue, actual rate and configured spending budget. Source: docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts

2. **recognizableFailure:** Failed capacity is advertised as free room, queue vanishes, or price/cap/settings are lost.

3. **independentOracle:** Literal [used,total,queue,hourlyUsd,capUsd,poolHosts,spentUsd]=[5,10,3,2,10,1,1], pool-only placement and rentWithoutAsking=true; failed host capacity is independently excluded.

4. **stableSeam:** Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** Per-host/per-lease arithmetic cannot catch capacity from failed hosts, missing queue/budget or loss of placement/approval settings in the pool projection. No whole-fixture sum is calculated with production code.

## packages/ui/src/lib/agent-chat/lineage.logic.test.ts:38

**Final title:** shows a child's work, pending input and settled status

**Disposition:** REWRITE (existing decision). Source ledger: [ui-chat-lib.json](ui-chat-lib.json).

**Original owner:** `beb7516b`, packages/ui/src/lib/agent-chat/lineage.logic.test.ts:38 — words the relation and a child's status

1. **independentContract:** Child progress shown in a parent conversation reflects current work, pending user input and settled/new state. Source: docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §4.1

2. **recognizableFailure:** A working or input-blocked child is shown as completed/new, so the parent misses active delegated work or a request for input.

3. **independentOracle:** Authored tabs with running chat state, pending-input=true, completed latest turn and no turn require independently chosen semantic working/needs-input/done/new outcomes.

4. **stableSeam:** lineageChildStatus selector consumed by lineage UI; expectations observe its returned semantic outcome.

5. **refactorResistance:** Removed duplicate fork/delegate relation-caption assertions. Status selection depends on public session fields, without a React tree, event implementation or collaborator inventory.

6. **uniqueProtection:** Child running/pending-input/completed/new selections are authored semantic expectations at the production-consumed lineageChildStatus selector; fork/delegate captions were removed as duplicates of opened-chat relation owner. API/daemon and rendering assertions do not supersede UI status selection.

## packages/ui/src/lib/agent-chat/status.logic.test.ts:61

**Final title:** ends on either successful or failed compaction

**Disposition:** CONSOLIDATE (existing decision). Source ledger: [ui-chat-lib.json](ui-chat-lib.json).

**Original owner:** `beb7516b`, packages/ui/src/lib/agent-chat/status.logic.test.ts:61 — ends on `compacted`

Also absorbs existing owners: 77: ends on `compaction-failed`.

1. **independentContract:** Either successful or failed terminal compaction marker clears the visible in-flight compaction phase while session/turn may remain running. Source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 compaction/context status; public context-window/identity protocol

2. **recognizableFailure:** A failed-marker branch is missed and the GUI shimmers as compacting indefinitely after the operation ended.

3. **independentOracle:** Hand-authored compacting marker followed by each literal protocol terminal state compacted/compaction-failed yields false for active compaction; current running session/turn are unchanged.

4. **stableSeam:** isCompactingThread returned state consumed by production hooks.

5. **refactorResistance:** Asserts public marker/state semantics rather than event summary/token wording, private branch structure or separate duplicate setup.

6. **uniqueProtection:** Both authored protocol terminal markers must clear live compaction. The selector consumed by hooks observes returned active state rather than strings or event details. A missing failed-marker branch leaves an endless shimmer while session/turn remain live; terminal session/turn cases cannot catch it. This owner absorbed original ends-on-compaction-failed line77.

## packages/ui/src/lib/agent-chat/timeline-position.test.ts:38

**Final title:** evicts the oldest past the limit while keeping a refreshed entry and the newcomer

**Disposition:** CONSOLIDATE (existing decision). Source ledger: [ui-chat-lib.json](ui-chat-lib.json).

**Original owner:** `beb7516b`, packages/ui/src/lib/agent-chat/timeline-position.test.ts:48 — delete-then-set moves an entry to the end so it survives eviction

Also absorbs existing owners: 38: evicts the oldest past the limit.

1. **independentContract:** The per-thread remembered timeline position uses a 100-entry persistent LRU; refreshing one preserves it when a newcomer evicts the oldest. Source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.2 persistent per-thread scroll/disclosure LRU; AGENTS.md localStorage validation

2. **recognizableFailure:** FIFO eviction removes a recently visited thread, loses its updated scroll position, retains the wrong oldest record or persists an over-limit set.

3. **independentOracle:** Independent ids keep/s0/one-more, offset 99, oldest absence, newcomer presence and a literal 100-entry persisted bound. No production LRU constant supplies the expected limit.

4. **stableSeam:** TimelinePositionStore remember/read and the actual localStorage serialized records.

5. **refactorResistance:** Observes restoration/eviction/persistence results; no delete/set spy or private Map order assertion remains.

6. **uniqueProtection:** Public TimelinePositionStore remembers 100 entries, refreshes keep, adds newcomer, then checks refreshed offset 99, oldest absent, newcomer present and persisted literal 100-entry bound. Independently authored data catches FIFO/LRU confusion and missed persistent eviction; restore/parser tests do not supersede it. Absorbed original evicts-oldest line38.

## packages/ui/src/lib/devices/follow.logic.test.ts:47

**Final title:** a connection reset takes a new baseline

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/lib/devices/follow.logic.test.ts:48 — the newest new lease wins, and a reset (null) takes a new baseline

1. **independentContract:** Resetting a daemon connection establishes a fresh baseline. Source: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation

2. **recognizableFailure:** Leases first received from a new daemon are mistaken for new agent opens.

3. **independentOracle:** An initialized empty snapshot, then null/reset, then an independently named ready lease z must produce open=null, even though that id is new.

4. **stableSeam:** Production-consumed followLeases/followPanel navigation policy results.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** The first-load baseline case does not detect forgetting to reset baseline state after an established connection. Real auto-follow hook callers rely on this pure transition; no second layer repeats the reset scenario.

## packages/ui/src/lib/devices/store.test.ts:140

**Final title:** settings and setup answers update the store; action loads preserve events across a connection

**Disposition:** REWRITE (existing decision). Source ledger: [devices-state.json](devices-state.json).

**Original owner:** `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`, packages/ui/src/lib/devices/store.test.ts:146 — mutations apply their answers; action logs merge with events; a connection switch resets

1. **independentContract:** Mutation replies update settings/setup state; loading historical actions keeps concurrently delivered event rows; a new connection clears logs. Source: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation

2. **recognizableFailure:** Settings/setup remain stale after successful action, live action disappears after history loads, or another daemon inherits old logs.

3. **independentOracle:** Literal android.enabled=true and setup state running; history x1 plus previously delivered live event remain [x1,live]; loading a different connection c2 clears the first connection action log.

4. **stableSeam:** Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.

5. **refactorResistance:** Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.

6. **uniqueProtection:** Panel/controller/open workflows were removed from this owner. Remaining load/event lease-race tests do not prove settings/setup reply adoption, historical-action/live-event merge or stale action-log isolation after connection switch.

Only these two documentation files were written for this alias task. No code, tests, baseline inventories or count totals were changed, and no test command was run.
