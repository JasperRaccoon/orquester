# Devices integration — API audit

Incoming identity `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8` relative to `923b3a51b594ef668483a5bd320af41187899e34`.

All25 new devices runtime cases (16 source declarations),3 changed surviving old declarations, and1 already-remote-removed model-selection declaration documented separately. Four old test files changed in the remote delta, plus the new devices file; unchanged baseline cases remain in api.json.

Source declaration counts at610d: {"DELETE": 3, "REWRITE": 6, "OPTIMIZE": 0, "CONSOLIDATE": 0, "KEEP": 10} (19 total). Expanded runtime cases: {"DELETE": 8, "REWRITE": 5, "OPTIMIZE": 0, "CONSOLIDATE": 0, "KEEP": 15} (28 total). The already-remote-deleted model-default helper case is documented separately and is not counted as a610d declaration. Five parameter rows were removed without deleting their surviving parameterized source declaration.

Test changes: +17/-71 = -54 LOC. No new test declaration. Production behavior is unchanged. The unused external allowed-route array export becomes private; actual UI device reference key remains public.

No tests or typechecks run under shared baseline profiling freeze. git diff --check passes. Required package command recorded per entry; root coordinates focused/mutation/full gates and timing. No speedup claimed.

The removed work is small pure inventory/duplicate validation. No material runtime improvement is claimed without measurement; no expensive test or production behavior was removed.

Required focused command from `packages/api`:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/devices.test.ts src/agent-chat/model-selection.test.ts src/agent-chat/thread-tools.test.ts src/session-profiles.test.ts src/workflows/rules.test.ts
```

Root also owns `pnpm check:changed --no-cache`, `pnpm check`, final full `pnpm test` and comparable final profiling. No tests, typechecks, commits or staging beyond the explicitly assigned principal conflict resolution were performed by this agent in this round.

## Compatibility and ownership

- DEVICE_TOOL_REFERENCE_KEY kept exported: real UI import in devices/chat-rows.logic.ts
- PRINCIPAL_ROUTES/PrincipalGate conflict resolved without resurrecting unread static inventory; only principal.ts conflict path staged per root instruction
- Real user-action principal gate remains in devices/http-routes.ts:191; API principal prose now names the user-only endpoint
- Remote dead defaultOptionValues/isThreadReplyMessage/sessionProfileScopeIncludes and unused inventories have no remaining non-test caller; accept remote removals

The token helper remains the cheapest unique security-policy owner: actual daemon HTTP route fixtures do not install the global bearer hook, and WebSocket auth is separate. The daemon owner removes its duplicate direct helper call. MCP owner confirms missing-action-field alternatives are not repeated in its executor negatives. Config owner confirms no independent catalog parity/uniqueness requirement; tolerant persisted settings remain distinct from strict API PUT validation.

## 1. DELETE — the plugin id is a built-in plugin

`packages/api/src/devices.test.ts:36` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Delete the test and its PLUGIN_IDS/isPluginId/DEVICES_PLUGIN_ID imports.

Failed behavioral bars: 1, 2, 3, 6. The old test only proved that a declaration appeared in another declaration; it did not enable a plugin or advertise/run a device tool.

Remaining protection: Config device enablement/settings defaults, daemon service/HTTP gating and actual MCP/manifest availability owners remain; static registry inclusion is not their runtime behavior.

## 2. DELETE — profiles: ids are unique, each platform's defaults are known profiles of that platform

`packages/api/src/devices.test.ts:41` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Delete catalog/default/hint inventory and unused config/catalog imports.

Failed behavioral bars: 1, 2, 3, 6. Self-consistency checks cannot prove avdmanager/simctl accepts a profile or boots the requested device; no independent supported-model or OS oracle.

Remaining protection: API open/settings tests keep cross-platform profile refusal; daemon Android/iOS profile-to-boot/host tests exercise generated launch behavior. Config owner confirms no independent catalog parity requirement.

## 3. KEEP — device keys and box host ids name their host

`packages/api/src/devices.test.ts:57` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep two literal serialization checks.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§3/6 and packages/api/src/devices.ts public host/device identity contract.
2. **Recognizable regression:** Repeated Android serials collide across hosts or box host identifiers no longer match persisted lease/device identities.
3. **Independent oracle:** Literal local/emulator-5554 and box:ab12.
4. **Stable seam:** Exported deviceKey/boxDeviceHostId public key serialization.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** These are the lowest shared serialized identity owners. Service lease tests use their keys and cannot independently pin these public bytes.

Non-test callers: Daemon DeviceService/box host factory; UI device references/panel selection.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 4. KEEP — routes encode their parameters

`packages/api/src/devices.test.ts:62` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep path/encoding assertions. This is protocol serialization, not a visual geometry snapshot.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§8/10.6/11 HTTP/WS routes; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §4 pool/drain/cache contracts.
2. **Recognizable regression:** Slash/colon identifiers escape their URL segment, proxy leading slash doubles the path, or HTTP/WS/pool/action/thumbnail requests target the wrong public endpoint.
3. **Independent oracle:** Literal encoded URL strings and query parameter bytes, including requested fractional width serialized as integer.
4. **Stable seam:** deviceRoutes public route-builder API used by transports.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Server tests register the same route builders, so they can accept a shared accidental path change. This literal external wire owner catches incompatible path bytes.

Non-test callers: Shared reference API client; Daemon route registrations; UI media and WebSocket URL builders.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 5. REWRITE — ?token= is accepted on GET/HEAD of the image routes only: never the hub proxy, a POST or another route

`packages/api/src/devices.test.ts:75` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Replace producer route constants as inputs with literal public patterns; remove raw DEVICE_QUERY_TOKEN_ROUTES list inventory and imports. Make unread external export private.

1. **Independent contract:** 0e1d9690 fix(devices): ?token= only on GET image routes; AGENTS.md remote HTTP auth and secret/privacy guarantees; packages/api/src/devices.ts documented image-query bearer exception.
2. **Recognizable regression:** Bearer in query accepted on a hub or mutation route, or legitimate img GET/HEAD loses auth; prefix matching grants unrelated endpoint access.
3. **Independent oracle:** Literal independent matched screenshot/thumbnail/hub route patterns, true only GET/HEAD media; false for mutations, user-action and missing matched route.
4. **Stable seam:** Public deviceQueryTokenAllowed policy called by actual daemon bearer hook at index.ts:2273.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Host_other confirms route fixtures do not install actual bearer hook; its duplicate direct helper assertion is removed. WS token auth is a different boundary. Lowest policy owner remains here.

Non-test callers: apps/daemon/src/index.ts bearer hook.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 6. KEEP — drain and cache-warm requests

`packages/api/src/devices.test.ts:91` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep tiny independent normalization and invalid body cases.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2/4 drain controls and explicit-platform cache warming; public DeviceHostDrainRequest/DeviceCacheWarmRequest bodies.
2. **Recognizable regression:** String truthiness changes a drain request, unsupported platform reaches provider/cache operations, or missing body is silently accepted.
3. **Independent oracle:** Literal normalized {draining:true}/{platform:android} values; malformed-only fixtures must return ok:false.
4. **Stable seam:** Shared strict parseDeviceHostDrainRequest/parseDeviceCacheWarmRequest HTTP boundary.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Host fleet scheduling tests use valid typed inputs and do not exercise untrusted route-body parsing.

Non-test callers: apps/daemon/src/devices/http-routes.ts fleet endpoints.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 7. KEEP — user action requests: each kind with its own field, nothing else

`packages/api/src/devices.test.ts:100` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep action-shape normalization/rejection. Agent/external principal refusal stays in real daemon route owner.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §10.1 panel toolbar and public DeviceUserActionRequest discriminated union.
2. **Recognizable regression:** Unvalidated rotate/appearance reaches device input, unknown action bypasses controlled device_action path, or unknown payload fields leak into command shape.
3. **Independent oracle:** Literal four supported action results, known orientation/appearance values, extra field dropped; isolated malformed field/kind/object fixtures refuse.
4. **Stable seam:** Shared parseDeviceUserActionRequest at HTTP body boundary.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Daemon user-action workflow owns controller/logging/power-off semantics; it does not supersede full discriminated parser output and field filtering.

Non-test callers: apps/daemon/src/devices/http-routes.ts user-action handler.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 8. KEEP — open request: platform-matched profile, deviceId needs hostId, junk refused

`packages/api/src/devices.test.ts:112` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep shared input parser tests.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§5/6/7/9 open_device and DeviceOpenRequest public HTTP schema; AGENTS.md validate untrusted payloads.
2. **Recognizable regression:** iOS request launches Android profile, device serial is ambiguous without host, hostile app argument reaches host commands, or missing/unknown thread/platform is accepted.
3. **Independent oracle:** Literal normalized Android pixel-fold/fresh object and valid existing-device/app input; each invalid fixture isolates platform/profile, host pairing, app grammar or body requirement.
4. **Stable seam:** parseDeviceOpenRequest strict public HTTP lease body parser.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** DeviceService consumes typed request and host tests launch valid fixtures. This owns schema/platform pairing before either side effect.

Non-test callers: apps/daemon/src/devices/http-routes.ts POST leases.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 9. KEEP — controller and setup requests

`packages/api/src/devices.test.ts:126` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep small parser cases.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§6/7 setup and controller handoff; public DeviceSetupRequest/DeviceControllerRequest contracts.
2. **Recognizable regression:** Unknown controller acquires control, empty setup cannot mean all fixes, duplicate fixes run twice, or shell metacharacters are treated as setup action ID.
3. **Independent oracle:** Literal user controller result; empty setup result; single install-android-sdk after duplicate input; malformed controller and action refused.
4. **Stable seam:** Shared controller/setup request parsers.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Controller and install service workflows own valid operations; neither protects body normalization/unknown identifier filtering.

Non-test callers: Daemon device HTTP controller and setup handlers.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 10. KEEP — settings patch: each field checked against its range; unknown fields refused

`packages/api/src/devices.test.ts:137` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep meaningful partial patch/range/type/unknown-field checks.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§10.5/11 settings; docs/superpowers/specs/2026-10-27-devices-phase-2-fleet.md §§2/4 placement/budget; config DevicesSettingsPatch and DEVICES_SETTINGS_LIMITS public constraints.
2. **Recognizable regression:** Fractional/zero capacity, wrong-platform default profile, negative spend cap, unsupported placement or unknown setting is persisted and triggers invalid/unsafe host work.
3. **Independent oracle:** Literal partial patch including nullable provider/minWarmHosts and unique profiles; isolated bad primitive/range/platform/unknown-field inputs. Expected values never come from DEFAULT_DEVICES_SETTINGS.
4. **Stable seam:** parseDevicesSettingsPatch strict PUT request parser.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Config persisted schema is intentionally tolerant/clamping; its tests cannot protect strict untrusted PUT rejection. API is the lowest shared strict owner.

Non-test callers: apps/daemon/src/devices/http-routes.ts PUT settings; Config persistence receives only accepted patch values.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 11. REWRITE — settings patch: refuses inherited property name ${name}

`packages/api/src/devices.test.ts:183` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Reduce ten expanded input cases to five distinct validation boundaries; no mutable state is shared.

1. **Independent contract:** AGENTS.md validate untrusted transport payloads and preserve security; Public settings PUT contract refuses every unknown field, including Object.prototype property names.
2. **Recognizable regression:** Inherited prototype names become accepted settings, permitting prototype writes or unsafe host/settings changes at distinct nested parser boundaries.
3. **Independent oracle:** Independent JSON bytes preserve own __proto__/constructor keys; expected ok:false and unknown-setting failure category.
4. **Stable seam:** Strict parseDevicesSettingsPatch public untrusted JSON boundary.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Retain one prototype-name probe at each independent grammar/lookup boundary: top-level, ordinary section, warm-host platform map, research section, research host fields. Five repeated names/ordinary-section variants add no distinct failure.

Non-test callers: Daemon PUT device settings handler.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

| Expanded test suffix | Disposition | Unique boundary or stronger remaining case |
| --- | --- | --- |
| top-level constructor | DELETE | Top-level __proto__ already detects unchecked inherited key acceptance in both top-level rule maps. |
| top-level __proto__ | KEEP | Unique top-level prototype-write/own-property refusal; catches either unchecked top rule or unchecked section lookup. |
| top-level toString | DELETE | Same top-level inherited lookup as retained __proto__; no new grammar or behavioral outcome. |
| android constructor | KEEP | Unique ordinary section field rule lookup; detects inherited field acceptance after a valid section name. |
| android __proto__ | DELETE | Same ordinary-section lookup as retained android constructor; top-level __proto__ separately guards prototype-write spelling. |
| pool constructor | DELETE | Same ordinary-section rule lookup as retained android constructor; valid section name differs incidentally. |
| pool __proto__ | DELETE | Same ordinary-section rule lookup as retained android constructor; no separate parser branch before the inherited field rule. |
| warm-host constructor | KEEP | Unique warm-host platform-name validation path; prevents inherited names being accepted as a platform. |
| research constructor | KEEP | Unique research section field allowlist, separate parser from ordinary settings. |
| research host constructor | KEEP | Unique per-machine research field allowlist, separate nested parser path. |

All expanded identities use the exact shared declaration at incoming `devices.test.ts:183`; literal suffixes above are the runtime names. The parent six-bar explanation applies to each retained boundary; each duplicate fails unique protection (bar6).

## 12. KEEP — settings patch: research.vphoneHosts takes per-machine entries field by field, null forgets one

`packages/api/src/devices.test.ts:190` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep per-machine partial values/null and source-safety matrix; it covers distinct unsafe source classes rather than profile inventories.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.3 per-machine opt-in vphone hosts; 6fc99aad source safety/path or HTTPS contract; config isVphoneSource public validation.
2. **Recognizable regression:** A machine cannot be removed with null, one partial host entry wipes another, or relative/option/HTTP/control-character source is passed into host commands.
3. **Independent oracle:** Literal trimmed absolute IPSW path and null removal; independent hostile/path/type/unknown-field fixtures rejected. No filesystem/network side effect is mocked as the behavior.
4. **Stable seam:** Strict research subtree in public settings PUT parser.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Config tolerant-read tests own preservation of old/unread host entries; API strict input owns refusal before saving or launching. Host CLI source tests operate after request acceptance.

Non-test callers: Daemon settings PUT; per-machine research host setup consumes accepted settings.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 13. REWRITE — device action input: each kind names what it needs

`packages/api/src/devices.test.ts:213` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Check mutual-exclusion rejection without English wording; change press error assertion from incidental home wording to actionable key field. Retain alternatives and required-field tests.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 exact action alternatives and required fields.
2. **Recognizable regression:** A tap accepts both accessibility ref and coordinates, incomplete coordinate/swipe is executed, or fill/press/permission/wait reaches host without its required value.
3. **Independent oracle:** Literal null for valid snapshot/tap alternatives/swipe; nonempty named-field diagnostics for independently missing fields. Press now expects stable key field instead of incidental home choice text.
4. **Stable seam:** Exported validateDeviceActionInput shared action contract, called by real DeviceService.toolAction.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** MCP owner confirms executor negatives cover enum/range/ref pattern and ownership/control, not action-specific missing fields/alternatives. Shared lowest owner remains API.

Non-test callers: apps/daemon/src/devices/service.ts toolAction validation.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 14. REWRITE — deviceRef: kept through slimming, read back only from a marked session-tool row

`packages/api/src/devices.test.ts:228` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Replace SESSION_TOOL_REFERENCE_KEYS membership assertion and duplicate direct positive parse with actual slimming→reader roundtrip using one small independent result fixture.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §§9/10.3 deviceRef reference kept without screenshot base64 in transcript; agent visuals/session-tools §1.5 slimming contract.
2. **Recognizable regression:** Device reference disappears in wire allowlist projection so Show device/screenshot thumbnail cannot render, an unmarked user server forges a link, or malformed screenshot ID becomes a path.
3. **Independent oracle:** Literal device/lease/screenshot values after actual slimActivityPayload; extra field is absent; traversal screenshot omitted, malformed reference undefined and unmarked row rejected.
4. **Stable seam:** Real public activity payload projection followed by public device reference reader.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Host_other confirms no root-device slimmed-reference owner. Generic session-tool slimming tests cannot detect omission of the newly added deviceRef key. Direct parser-only inventory could not detect it.

Non-test callers: Daemon ingestion/wire payload slimming; UI devices chat-row reference and thumbnail rendering.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 15. REWRITE — deviceRef: the row's words (name, action, summary) are kept only when valid

`packages/api/src/devices.test.ts:243` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Remove undocumented exact120/200-character internal cutoff assertions; keep trimming, control/newline rejection and action type/enum filtering.

1. **Independent contract:** docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §10.3 semantic action/device labels; public DeviceToolReference accepts only one-line typed provider-supplied words.
2. **Recognizable regression:** Untrusted multi-line/control-character provider words leak into row labels or unknown action becomes an actionable device command; valid supplied words are lost/changed.
3. **Independent oracle:** Literal supplied and trimmed values, invalid newline/control/empty/type/unknown-action fields omitted while stable device identity stays.
4. **Stable seam:** readDeviceToolReference provider-result validation boundary.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Slimming/link test owns device/screenshot/provenance, not display-word validation. UI render tests consume accepted words and cannot protect this parser independently.

Non-test callers: UI device chat-row formatting/Show device labels; Provider-relayed result parser.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 16. DELETE — contracts other modules gained: the devices toolset, the device-host box purpose and setup step

`packages/api/src/devices.test.ts:253` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Delete case plus unused TOOLSETS/BOX_SETUP_STEP_IDS/isBoxPurpose imports.

Failed behavioral bars: 2, 4, 5, 6. Raw tool-name/label list, isBoxPurpose known member and setup-step index cannot prove actual provider setup, tool advertisement, ownership or device-host isolation.

Remaining protection: Daemon real catalog manifest gates and runtime device-host setup/ownership tests remain. A harmless reordering or label rename should not fail this test.

## 17. REWRITE — a reply delivery reads as another chat's by its chip; an older build's continue turn is Orquester's, never another chat's

`packages/api/src/agent-chat/thread-tools.test.ts:202` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Replace production replyDeliveryContext/TOOLSET_CONTINUE_CONTEXT_KIND fixture coupling and raw constant inventory with literal persisted context values; remove now-unused imports.

1. **Independent contract:** Thread/delegation §13 persisted composer provenance context protocol; Legacy stored toolset-continue context must remain readable.
2. **Recognizable regression:** Historical thread-reply context ceases to be recognized, or historical Orquester automatic continue is misidentified as another chat and routed incorrectly.
3. **Independent oracle:** Literal persisted kind bytes thread-reply and toolset-continue; literal LGTM stripped message body.
4. **Stable seam:** isThreadAuthoredMessage/isToolsetContinueMessage public persisted-context readers.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Remote removed unused isThreadReplyMessage helper. This owner keeps actual historical discrimination and body projection; constructing expected context with the same constants/builders obscured wire compatibility.

Non-test callers: Shared UI chat provenance decisions; Daemon thread/delegation reader flows.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 18. KEEP — validates scopes: non-empty, known agents, one agent for plugins and hooks, no OpenCode hooks

`packages/api/src/session-profiles.test.ts:36` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Accept remote removal of dead helper assertions; preserve validation case unchanged.

1. **Independent contract:** Agent profiles spec scope compatibility: plugins/hooks single agent, no OpenCode hooks; Public sessionProfileScopeProblem validation contract.
2. **Recognizable regression:** Unsupported hook is offered/run on OpenCode, multi-agent plugin/hook scope accepted, duplicate/empty/unknown agents persist.
3. **Independent oracle:** Literal accepted scopes and named-field/refusal categories for each independently invalid scope.
4. **Stable seam:** Public sessionProfileScopeProblem shared UI/daemon validation.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Remote removed unused sessionProfileScopeIncludes and only its two membership assertions; scope constraint errors remain unique here rather than tolerant config reads.

Non-test callers: Daemon profile mutations; UI profile item scope editor.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## 19. KEEP — matches with plain and /literal/flags patterns

`packages/api/src/workflows/rules.test.ts:100` at `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`.

Completed: Keep surviving named case; accept remote removal of identical repeated global-pattern call.

1. **Independent contract:** Workflow spec rule operators and public /literal/flags expression contract; Regex worker/safe matcher protocol.
2. **Recognizable regression:** Plain/literal patterns or case-insensitive flags are misparsed, global pattern rejected, invalid regex becomes true or lacks warning.
3. **Independent oracle:** Literal true/false matches for abc and known regexes; explicit invalid regex false plus warning and unsupported-flag warning.
4. **Stable seam:** evaluateRuleAsync public async rule boundary with actual safe matcher.
5. **Refactor resistance:** The surviving assertion concerns accepted/refused wire data, literal persisted bytes, returned values or observable projection. Identifier renames, helper decomposition, storage/container changes and equivalent algorithms do not affect it.
6. **Unique protection:** Remote deletes an identical second /b/g invocation that creates no separate failure mode. Worker process tests own isolation/termination, not rule literal parsing.

Non-test callers: Workflow switch/condition evaluation.

Cost: Small synchronous inputs; no timer, IO, provider process, browser or network startup. No individual or suite timing measured in this agent workstream.

## Already removed by incoming remote cleanup

DELETE `packages/api/src/agent-chat/model-selection.test.ts:83` — option defaults resolve as the composer's chips do (identity at `923b3a51b594ef668483a5bd320af41187899e34`, absent at610d).

Remote removed defaultOptionValues production-unused helper and its only test. Its own exported wrapper had no non-test callers. Actual picker output still independently proves effort high/fastMode false defaults in the fixture view case, and real composer callers use currentOptionValue. Do not resurrect dead helper/test.

packages/api/src/agent-chat/model-selection.test.ts the fixture picker view (literal option defaults); public model/option callers and UI composer owners.
