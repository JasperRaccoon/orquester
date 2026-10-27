# Devices client state and fleet audit

Remote baseline `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`: seven files, 64 exact original test identities. Surviving executions: 38; removed executions: 26. Every test body and its production owner were read alongside the approved Phase1/2/3 designs and actual wire contracts. No test run was started during root-owned profiling/validation slots.

Dispositions: CONSOLIDATE 14, DELETE 14, KEEP 13, OPTIMIZE 2, REWRITE 21. Consolidate counts include surviving owners. Tests: 1251 → 933 LOC (-318); production LOC +0.

Meaningful name/ref data moved to the actual chat presentation/entry projection owners, coordinated with ui_chat_lib. Pure fleet grouping and monetary/data projections remain; unsupported ordering, copy, geometry, palette and private helper inventories are removed. Preferences and validation observe actual persisted/wire envelopes. Actual DOM owns the navigation, host action, thumbnail/auth and load/retry wiring.

Remove the direct chat helper test file, three unused API mock methods, unused thumbnail snapshot collection,20 unused export surfaces and the local test-only thumbnail-width override. Preserve fixtures/default adapters: the web dev harness is a legitimate non-test caller. Production defaults and user behavior are unchanged.

Performance work: render7 relevant device cards instead of14 per DOM case, initialize action fixtures once per fake client instead of once per visible-card request, keep virtual clocks and explicit deferred replies. No wall-clock or CI gain is claimed until equivalent root measurements.

## packages/ui/src/lib/devices/chat-rows.logic.test.ts

### CONSOLIDATE — open, close and install name the device, with a fallback

Remote line 7.

1. Contract/source: Device rows identify the referenced device, including current-store fallback when persisted names are absent. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A row names the wrong device or loses a known persisted name when a resolver supplies another.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Public presentation owner verifies explicit name precedence and resolver wiring; direct helper outputs and sentence inventory removed. packages/ui/src/lib/agent-chat/presentation.logic.test.ts: device tool rows (ui_chat_lib owner)

### DELETE — list_devices, other tools and rows without a reference keep their generic words

Remote line 18.

1. Contract/source: No independent requirement pins the inner helper returning undefined for generic tools. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: The test pins an inner fallback shape that can change while the actual rendered label remains correct.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails stable-seam/refactor/unique bars; generic labels already belong to presentation.

### CONSOLIDATE — device_action: screenshots and snapshots say so; input reads its summary, ref stripped

Remote line 25.

1. Contract/source: Rows preserve authored action target/summary data. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Actual human-readable target disappears while tool completion still succeeds.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Authored summary target preservation moves to public presentation; snapshot/screenshot vocabulary inventory removed. packages/ui/src/lib/agent-chat/presentation.logic.test.ts: device tool rows (ui_chat_lib owner)

### DELETE — device_action without a summary: a verb from the action kind

Remote line 34.

1. Contract/source: No independent requirement specifies sixteen exact fallback verb sentences. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A wording-only edit fails without changing the action or reference.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: unsupported exact-copy branch inventory.

### DELETE — summary words: only a ref before a quoted label is dropped

Remote line 59.

1. Contract/source: No independent requirement specifies stripping a particular ref token before a quote. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Changing harmless punctuation/ref presentation fails while device linking and target remain correct.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars; public presentation retains authored target data.

### CONSOLIDATE — a live row's action and summary complete the reference; a slimmed one keeps it as is

Remote line 66.

1. Contract/source: Live tool results and persisted/slimmed references retain validated action and summary metadata. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A reconstructed chat loses deviceRef metadata, accepts spoofed/unreadable fields, or live enrichment is no longer wired.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Surviving public workEntryDisplayLabel/workLogEntryFromActivity projections.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Actual workLogEntryFromActivity owner absorbs malformed action/summary checks; direct helper same-object and restatement checks removed. packages/ui/src/lib/agent-chat/entries.logic.test.ts: links a device tool's row to the device its result names (deviceRef), with the action's words (ui_chat_lib owner)

## packages/ui/src/lib/devices/follow.logic.test.ts

### REWRITE — follow the agent > the first list is the baseline: a reload never reopens a device

Remote line 15.

1. Contract/source: A reload uses the first list as a baseline and does not reopen a dismissed device. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Existing leases unexpectedly open the device rail on reload.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep observable open=null and repeated-list result; remove private baselined flag check.

### KEEP — follow the agent > an agent opening a device for the visible chat opens the panel on it

Remote line 21.

1. Contract/source: A newly agent-opened device for the visible chat opens its panel. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: The agent obtains a device but the visible chat never follows it.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Literal {threadId:chat,leaseId:a} detects missing/wrong navigation target.

### KEEP — follow the agent > not for another chat, a user-opened device, a lost one, or with the setting off

Remote line 25.

1. Contract/source: Auto-follow only applies to the visible chat, agent-created active leases, with follow enabled. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Another chat steals focus, manually opened/lost leases trigger a jump, or the opt-out is ignored.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Independent opt-out, ownership and active-state guards at the pure navigation policy seam.

### KEEP — follow the agent > a lease seen once never opens again (it was seen while another chat showed)

Remote line 33.

1. Contract/source: A lease already observed while another chat was visible does not become newly opened on a later state update. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: An old lease steals focus when its boot completes after chat navigation.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Distinct seen-lease policy, not covered by initial reload baseline or current-chat matching.

### REWRITE — follow the agent > closing the panel on a chat with a device dismisses that chat for the session; showing it again forgets that

Remote line 38.

1. Contract/source: Closing a populated device panel dismisses auto-follow for that chat during the session; reopening restores it. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: New leases reopen a user-dismissed panel, or reopening can never restore following.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep later open/null targets, verify closing empty panel permits a real new target; remove identity-only equality.

### REWRITE — follow the agent > the newest new lease wins, and a reset (null) takes a new baseline

Remote line 48.

1. Contract/source: Resetting a daemon connection establishes a fresh baseline. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Leases first received from a new daemon are mistaken for new agent opens.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed followLeases/followPanel navigation policy results.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Remove unspecified latest-array-item choice and private flag; retain null-reset then new-baseline outcome.

## packages/ui/src/lib/devices/device-view-prefs.test.ts

### REWRITE — device view prefs > validates field by field with defaults

Remote line 27.

1. Contract/source: Stored preferences tolerate invalid fields rather than reaching shared UI state unchecked. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A legacy/invalid mode or logOpen type crashes or selects an unsupported mode.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual persisted localStorage keys/read-write and production effective mode API.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Exercise real persisted keys through readDeviceViewPrefs/readDevicePanelPrefs; remove inner sanitizer imports.

### KEEP — device view prefs > persists per device model and survives corrupt storage

Remote line 34.

1. Contract/source: Per-model view preferences persist separately; corrupt panel JSON falls back safely. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Another model inherits a view preference or malformed saved JSON breaks the panel.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual persisted localStorage keys/read-write and production effective mode API.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Literal existing storage keys and literal independent flat/default outputs; public read/write and key boundary.

### KEEP — device view prefs > defaults to 3D for H.264 and Flat for MJPEG or screenshots until the user picks

Remote line 46.

1. Contract/source: Default view is 3D for H.264 and Flat for MJPEG/screenshots; an explicit user choice wins. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: The default requires unsupported video quality or stored user preference is ignored.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual persisted localStorage keys/read-write and production effective mode API.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Phase1 §10.4 specifies these choices; stable production-consumed effective mode result.

### KEEP — device view prefs > never throws without storage

Remote line 55.

1. Contract/source: Unavailable browser storage must leave the UI functional with defaults. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Restricted browser storage makes opening a device throw.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual persisted localStorage keys/read-write and production effective mode API.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Public readers return independent default and public writer must finish without throwing; no remaining test covers absent storage.

## packages/ui/src/lib/devices/store.test.ts

### REWRITE — devices store > loads the state and follows events, ignoring malformed ones

Remote line 104.

1. Contract/source: Validated device state and events converge into per-chat leases, action logs, setup and settings; malformed events are ignored. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A malformed/duplicate event corrupts visible data or closing a lease leaves stale action rows.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep literal ids/state/data and dedupe; remove incidental stable-empty identity and shared-default expected oracle.

### KEEP — devices store > a load never undoes an event that landed while it was in flight

Remote line 135.

1. Contract/source: A load in flight cannot overwrite a newer lease event, while unchanged host data can still load. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: An event-opened device disappears when an older snapshot resolves.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Deferred real load against public event/store seam; literal late lease and host label provide independent, slot-specific oracle.

### REWRITE — devices store > mutations apply their answers; action logs merge with events; a connection switch resets

Remote line 145.

1. Contract/source: Mutation replies update settings/setup state; loading historical actions keeps concurrently delivered event rows; a new connection clears logs. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Settings/setup remain stale after successful action, live action disappears after history loads, or another daemon inherits old logs.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Remove duplicate open/controller/release scenarios owned by actual panelDOM and fake-return echoes; assert store settings/setup, merged ids and connection reset.

### REWRITE — devices store > a user action applies its lease (now the user's) and its row at once; power off removes the lease

Remote line 166.

1. Contract/source: User-action replies atomically update controller/log state; malformed replies apply nothing; power-off removes the lease. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: The user successfully rotates but remains agent-controlled, malformed data partly changes UI, or powered-off lease stays active.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Assert store effects after valid response, unchanged effects after malformed response, and absence after power-off; remove arranged return echo.

### KEEP — devices store > a connection switch also clears each chat's selected device and the panel's own rows

Remote line 179.

1. Contract/source: A connection switch clears chat selections and local action rows as well as daemon state. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A same-id lease on a different server inherits the old selected device or user action history.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Public reset and actual alternate client binding; local stores are not covered by daemon-slot isolation tests.

### KEEP — devices store > the plugin off empties the store and drops events

Remote line 197.

1. Contract/source: Turning the devices plugin off empties client state and ignores incoming device events. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: Disabled functionality keeps devices visible through late events.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Public plugin switch plus event/state; DOM plugin gating alone does not prove events are discarded.

### REWRITE — devices validation > reads what it knows and drops the rest

Remote line 208.

1. Contract/source: Client accepts readable additive device wire fields and drops unknown/unreadable records safely. Source: `docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§7,10.2–10.4,11; AGENTS.md browser payload validation and per-daemon isolation`.
2. Real failure: A newer host/lease kind crashes shared UI, unsupported stream negotiates playback, or unready hosts falsely appear ready.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Exercise real sanitizeDevicesState envelope rather than exported inner host/lease helpers; literal fields and empty dropped lists.

### REWRITE — devices validation > keeps a research host's flag and notice

Remote line 221.

1. Contract/source: Research BYO hosts preserve explicit research warning metadata and reject malformed values. Source: `docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md research disclosure contract; additive DeviceHostSummary fields`.
2. Real failure: An experimental real-iOS VM host loses its research notice or untyped payload masquerades as such.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public devices state/event/mutation boundary or public sanitizeDevicesState wire envelope.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Phase3 research disclosure contract at public state envelope; no other fixture uses research metadata.

## packages/ui/src/components/devices-fleet/fleet.logic.test.ts

### REWRITE — grouping and order > puts this host first, then hosts by status and age, each with its leases

Remote line 33.

1. Contract/source: The fleet groups all active leases by their host and retains leases on unknown/disabled hosts; released devices do not appear. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A device disappears when its host is absent/off or appears under another host.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Use three hosts/four leases, assert domain membership without incidental sort order; consolidate released/off cases.

### DELETE — grouping and order > orders leases live first: ready, starting, suspended, lost

Remote line 48.

1. Contract/source: No independent product requirement fixes ready/starting/suspended/lost row sort precedence or exact age order. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Behavior-preserving ordering changes break the test without losing a leased device.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars; host membership remains in rewritten grouping owner.

### CONSOLIDATE — grouping and order > leaves out released leases and hosts that are off with nothing on them

Remote line 59.

1. Contract/source: Released devices are no longer leased; a disabled empty host need not occupy the fleet. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Released devices remain in visible fleet or off-empty host obscures useful hosts.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Combined with host membership owner using one released lease and one off-empty host.

### CONSOLIDATE — grouping and order > keeps an off host that still holds a lease, and answers nothing before the first load

Remote line 68.

1. Contract/source: Every still-leased device stays visible even when its host is disabled. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A platform switch hides a device still held by a chat.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Combined with host membership owner; null-before-load output is incidental and actual loading belongs to DOM.

### DELETE — hosts > name their kind

Remote line 76.

1. Contract/source: No independent requirement fixes provider/OS/local exact host-label vocabulary. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Copy editing produces a failure without a capability or navigation regression.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: exact-copy branch inventory.

### DELETE — hosts > read their status in the fleet's words

Remote line 83.

1. Contract/source: No independent requirement specifies private view keys, tones or status sentences. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Renaming an internal status key/color or rewriting explanatory copy breaks the test.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails stable-seam/refactor bars; actual deadline Resume prohibition survives in DOM, source protocol state remains covered in store/daemon owners.

### CONSOLIDATE — hosts > offer Drain, Destroy and Warm caches where they apply

Remote line 105.

1. Contract/source: Host controls apply to the actual selected rented host, with deadline Resume blocked. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A local host offers destructive controls or a deadline-drained host sends a forbidden resume request.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Actual HostCard DOM cases own control availability/dispatch and blocked interaction; remove helper duplication.

### KEEP — cost math > a host's cost so far is its $/h times its uptime

Remote line 126.

1. Contract/source: Estimated host cost is elapsed billable hours multiplied by independently supplied hourly price. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Displayed money is off by a time-unit conversion, negative under clock skew, or invents a missing/free rate.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Literal $0.64/h for90min→$0.96; public production-consumed monetary helper; DOM confirmation checks wiring rather than full arithmetic combinations.

### CONSOLIDATE — cost math > a lease's share splits the host's $/h across the leases on it, times the lease's age

Remote line 136.

1. Contract/source: Per-lease estimated cost splits the current host rate across still-held devices, multiplied by lease age. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Lost devices dilute active device cost or a lease rate/cost uses the wrong divisor/time unit.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Surviving combined owner takes ready/starting/suspended/lost states; literal $1.92 across3 held devices,30min→$0.64/h,$0.32. Remove hypothetical null/zero matrix.

### CONSOLIDATE — cost math > only leases that hold a device share the cost

Remote line 147.

1. Contract/source: Only devices still held participate in the active device cost estimate. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A lost lease reduces every active device cost estimate.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Absorbed into surviving lease-share arithmetic owner; no standalone count test.

### REWRITE — cost math > the pool header sums capacity over working hosts and compares spend with the cap

Remote line 151.

1. Contract/source: Pool display reflects usable capacity, requested queue, actual rate and configured spending budget. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Failed capacity is advertised as free room, queue vanishes, or price/cap/settings are lost.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Three-host fixture and literal [5,10,3,2,10,1,1] values replace large computed fixture sum and color/label expectations.

### REWRITE — cost math > the pool header works before the pool summary and the settings arrive

Remote line 168.

1. Contract/source: Older/partial pool state may omit summary or settings while existing host capacity/rates remain usable. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The fleet crashes or invents a budget before optional data arrives.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep independent absent-field and valid-host fallback numbers; remove tone/placeholder-word inventories.

### DELETE — cost math > meters and tones

Remote line 180.

1. Contract/source: No independent visual requirement fixes75% warning colors or meter widths. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A palette/layout adjustment fails while all capacity and budget data remain correct.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: geometry/tone implementation restatement.

### DELETE — time words > uptime

Remote line 188.

1. Contract/source: No independent requirement fixes abbreviated uptime wording at minute/hour/day boundaries. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Equivalent duration wording breaks the test.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: formatting inventory; monetary elapsed-time arithmetic remains independently checked.

### DELETE — time words > ago

Remote line 191.

1. Contract/source: No independent requirement fixes just-now/ago vocabulary and arbitrary5s threshold. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Equivalent time wording breaks the test.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: exact-copy boundary inventory.

### CONSOLIDATE — leases > poll their thumbnail through the daemon's downscaled thumbnail route

Remote line 207.

1. Contract/source: Live fleet cards request downscaled authenticated lease thumbnails; starting devices are not polled. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The real card asks an obsolete hub path or polls a not-yet-existing device.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Actual DOM fetch boundary verifies lease route and no starting-device request. Public API route owner covers encoding/custom width; remove local test-only width override.

### DELETE — leases > frame their thumbnail at the screen's shape, else the form factor's

Remote line 218.

1. Contract/source: No independent visual regression requirement specifies thumbnail frame ratios. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A valid layout/aspect choice breaks the test.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars: incidental geometry.

### DELETE — leases > say what covers a thumbnail that is not live

Remote line 224.

1. Contract/source: No independent requirement specifies tone or fallback words for thumbnail covers. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A copy/palette change fails with identical lease state.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars; actual queued-device semantic state survives in DOM.

### CONSOLIDATE — leases > name their chat and agent

Remote line 235.

1. Contract/source: A device card resolves the owning chat and agent from actual session data and navigates to that lease. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The wrong chat opens or the lease is not selected.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Actual DOM chat-link owner verifies session deep link+selected lease; remove fallback prose and redundant projection checks.

### CONSOLIDATE — leases > show their newest action

Remote line 243.

1. Contract/source: A visible device card shows its current action log data. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The last daemon action never appears on the actual card.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Production-consumed host-group and monetary/data projection functions; actual DOM where consolidated.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Actual DOM subscriber/fetch owner verifies injected action summary appears after the action API load; remove duplicate helper and empty-value assertions.

## packages/ui/src/components/devices-fleet/thumbnail-poller.test.ts

### CONSOLIDATE — thumbnail poller > polls only while it has a URL, is on screen and the page is visible

Remote line 83.

1. Contract/source: A thumbnail request needs a real URL and an active visible card. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A card starts network polling before it knows which device to request.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: URL gate folded into one-fps owner; off-screen/page-hidden gates have their own distinct tests.

### REWRITE — thumbnail poller > asks about once a second, one request at a time

Remote line 93.

1. Contract/source: Fleet thumbnails poll about once per second and never overlap a slow capture. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The fleet floods the daemon with concurrent captures or continuously polls.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Use independently specified1000ms and observed requests; remove expected imported interval and unused snapshot collection.

### KEEP — thumbnail poller > pauses off screen (aborting the request, keeping the frame) and resumes at once after the interval

Remote line 113.

1. Contract/source: Off-screen cards stop traffic, abort in-flight work, retain the visible frame and resume when shown. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Scrolling off screen leaves network/CPU work running or blanks the cached frame.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Controlled scheduler/fetch abort signal and public snapshot; DOM wiring does not execute off-screen timing.

### KEEP — thumbnail poller > pauses while the page is hidden

Remote line 133.

1. Contract/source: Hidden pages stop thumbnail traffic and resume when visible. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Background tabs continue expensive thumbnail requests.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Distinct page-visibility gate from card intersection; deterministic scheduler, no wall-clock sleep.

### REWRITE — thumbnail poller > keeps the last frame on failure and backs off, then recovers

Remote line 146.

1. Contract/source: Capture/network failures keep the last frame, explain failure, increase retry pauses and recover to normal cadence. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A transient failure blanks the card, loops aggressively or never resumes after the host recovers.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Observe error-state/nonempty explanation, growing delays and recovery; no oracle calculated by production backoff helper or exact error sentence.

### KEEP — thumbnail poller > starts over on a new URL and frees everything on dispose

Remote line 170.

1. Contract/source: Changing a thumbnail device discards previous device frames and dispose cancels traffic/releases object URLs. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: An old device frame leaks across selection or invisible cards leak URLs/timers/network work.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Public lifecycle with actual AbortSignal and recorded object-URL platform effects; no other owner covers resource disposal.

### REWRITE — thumbnail poller > sends the auth headers with every request; new headers start over, equal ones do not

Remote line 193.

1. Contract/source: Every request forwards current auth headers; a credential change discards old cached credentials. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Renewed login keeps sending stale credentials or polling omits authentication.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Independent Bearer one→two request headers and equal-request no-restart; remove tautological provided-URL lacks token assertion.

### DELETE — thumbnail poller > an empty answer keeps polling without replacing the frame

Remote line 208.

1. Contract/source: No independently specified contract says successful empty blobs must stay loading and keep polling. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: It asserts a defensive branch chosen by implementation, without a real response fixture or unique critical failure.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/unique bars; failure recovery and frame retention already remain.

### DELETE — thumbnail words and pauses > back off 2 s, 5 s, 15 s, then 30 s

Remote line 222.

1. Contract/source: No independent requirement specifies exact2s/5s/15s/30s thumbnail backoff values. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A valid retry tuning change breaks a copied schedule table.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars; growing bounded-cost failure recovery is observed through actual poller.

### DELETE — thumbnail words and pauses > name what failed

Remote line 225.

1. Contract/source: No independent requirement fixes exact HTTP-status-to-English failure sentences. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Equivalent failure prose breaks the test.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Public poller lifecycle/snapshot plus runtime fetch/timer/object-URL dependency effects.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Fails independent-contract/refactor bars; main failure/recovery owner requires observable error and successful recovery.

## packages/ui/src/components/devices-fleet/devices-fleet.dom.test.ts

### CONSOLIDATE — the Devices fleet view > the activity bar and the drawer offer Devices only while the plugin is on

Remote line 175.

1. Contract/source: Plugin-enabled users can open/toggle fleet from desktop/mobile entries; closing it or disabling plugin exits. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The fleet is unreachable on one surface, drawer remains open, or a disabled plugin leaves it active.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Surviving navigation owner also presses actual header Close; no separate header-count scenario.

### CONSOLIDATE — the Devices fleet view > the top bar's header counts the leased devices and closes the view

Remote line 199.

1. Contract/source: The actual fleet header can close the view. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Close button stops dispatching the state transition.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Moved into entry/navigation owner; incidental displayed count removed.

### REWRITE — the Devices fleet view > groups leased devices under their hosts, with chats, agents, last actions and thumbnails

Remote line 208.

1. Contract/source: Actual visible lease cards request authenticated downscaled thumbnails and load/render current action data. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Thumbnail route/auth forwarding or action subscription wiring breaks while lower helper tests pass.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep real component fetch/snapshot/data behavior; remove sort, row-count, full text and markup inventory. Render7 relevant devices instead of14.

### OPTIMIZE — the Devices fleet view > a card's chat link opens that chat with its Device panel on the lease

Remote line 237.

1. Contract/source: Selecting a device card opens its owning chat with that lease selected in the Device panel. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The user lands in the wrong chat or views the wrong device.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Existing actual navigation assertions retained verbatim with7-device fixture rather than14; measurement pending.

### REWRITE — the Devices fleet view > host cards drain, warm caches and destroy (after a confirmation naming the cost)

Remote line 247.

1. Contract/source: Host actions target correct hosts/platform; destructive action waits for explicit confirmation that shows actual estimated cost. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Drain/cache-warm targets another host/platform or Destroy executes before confirmation/wires wrong host money.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep API dispatch and actual dialog; verify independent currency values without surrounding English sentence snapshot;7-device fixture.

### REWRITE — the Devices fleet view > a host drained near its deadline reads Ending soon (deadline), with Resume off and the reason

Remote line 274.

1. Contract/source: Deadline-drained hosts cannot resume and explain the unavailable control. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: The GUI sends a resume forbidden by daemon deadline rule.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep disabled control, nonempty reason and no dispatch; remove exact status/title prose.

### REWRITE — the Devices fleet view > a panel Open still waiting for a host groups under Waiting for a device host

Remote line 290.

1. Contract/source: A queued starting lease is explained as waiting for capacity rather than a lost host. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Opening a device appears lost before scheduler placement has happened.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep semantic Waiting versus no-longer-listed outcome; no exact sentence snapshot.

### REWRITE — the Devices fleet view > explains how agents get devices when none is leased

Remote line 301.

1. Contract/source: An empty fleet explains the documented open_device API and lets the user reach device settings. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Empty fleet traps a new user with no way to configure devices.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Retain public tool identifier and press actual settings navigation; remove incidental no-devices wording.

### OPTIMIZE — the Devices fleet view > shows a failed load with a retry that recovers

Remote line 312.

1. Contract/source: A device-state failure is visible and an explicit retry recovers real lease data. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: Transient connectivity failure leaves fleet permanently unusable.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Keep injected failure detail, click retry and actual loaded card; replace row-count with domain card identity and halve fixture; measurement pending.

### REWRITE — the Devices fleet view > shows loading until the devices state arrives

Remote line 334.

1. Contract/source: The fleet shows loading only while actual daemon state is pending, then displays loaded devices. Source: `docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2.9–2.11; packages/api/src/devices.ts route/state contracts`.
2. Real failure: A real in-flight load renders empty state too soon or loading never clears.
3. Oracle: Literal fixture ids/names, money amounts, persisted keys, required states and public navigation targets. Timers drive behavior but expected cadence/property is independent; no imported production threshold oracle remains.
4. Seam: Actual mounted React controls, API/fetch boundary, shared app state and session deep links.
5. Refactor resistance: Retained assertions observe domain data and outcomes, not private flags, helper call order, exact copy, geometry or markup trees.
6. Unique protection/disposition: Replace api=null coverage probe with deferred real devicesState promise and subsequent observable card.

## Validation

Executed: `git diff --check -- packages/ui/src/lib/devices packages/ui/src/components/devices-fleet` (passed). At the initial source-only handoff, no tests/typechecks were executed; the later shared focused validation is recorded below. Root owns changed/full validation and commit/integration/push.

Focused target once released:

```sh
cd packages/ui
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 src/lib/devices/follow.logic.test.ts src/lib/devices/device-view-prefs.test.ts src/lib/devices/store.test.ts src/components/devices-fleet/fleet.logic.test.ts src/components/devices-fleet/thumbnail-poller.test.ts src/components/devices-fleet/devices-fleet.dom.test.ts
```

Repository-wide validation remains root-owned; the executed shared focused target is recorded below.

## Executed shared focused validation

The complete stream/state/fleet command above (from `packages/ui`) passed 122/122 tests in 5.585 s runner time with four test-file workers and `TSX_DISABLE_CACHE=1`. Exact command:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=/tmp/orquester-test-audit/reporter.mjs --test-timeout=600000 --test-concurrency=4 src/components/device/stream/*.test.ts src/lib/devices/*.test.ts src/components/devices-fleet/*.test.ts
```

Evidence: `/tmp/orquester-test-audit/devices-stream-focused.log`. No product failures or skips. This validation includes every surviving state/fleet case. Root owns typechecks, changed/full gates, build and delivery. No state/fleet-specific speedup is claimed; see stream report for matched MJPEG-only measurements.

## Final caller audit: phone navigation override

A whole-workspace caller search found that `showDeviceInPanel`'s `phone` override has a real production caller: `lib/devices/use-follow-agent.ts:32` passes `false`. `RightRailFrame.tsx:117` enables that follower only on desktop; its documented purpose is to avoid jumping a phone away from chat automatically. Manual `DeviceRowLink` and fleet-card navigation use the actual `window.matchMedia` default. Retain that runtime override and correct its misleading “for tests” comment. Removing it would change the desktop-only follower boundary during resize or in-flight callback timing.

The adjacent `openLeaseInChat` override pass-through has no caller that supplies an option, so remove its unused argument and forward only the lease target. No retained test used this argument; no test adaptation or replacement is needed. Original 610d identities, all six behavioral-bar decisions, 38 surviving tests and 933 test LOC remain unchanged. This followup changes no test LOC or production LOC. The existing card-link case remains the actual navigation owner (independent requested lease/chat oracle; recognizable wrong destination bug; public component/API state seam; survives helper refactors; no lower duplicate).

Earlier 122/122 focused validation above is preserved and predates this final parameter-only cleanup. No additional tests were run for this followup; scoped `git diff --check` passes. Root-controlled final gates must validate the final tree.

Whole-workspace test search found no `showDeviceInPanel`/`openLeaseInChat` call or `phone: true`/`phone: false` override. The retained card DOM case already exercises the actual viewport-detection default (jsdom has no `matchMedia`, so it takes the documented desktop fallback); no explicit true-path test remains to adapt.
