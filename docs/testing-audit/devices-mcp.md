# Incoming Devices MCP and session-tools audit

Incoming identity source: `610d3c53b480dcfe71ff45f14ce59b6df29f8bf8`. Covers10 new declarations and7 existing modified/identity-mapped owners. **17 exact identities**: {'KEEP': 4, 'REWRITE': 8, 'CONSOLIDATE': 5}. Three declarations removed by consolidation; seven new declarations survive. This-round test LOC−56; raw seven-file diff vsremote−57 includes prior net−1.

Correction after complete current-doc lookup: `docs/orquester-mcp.md:2416` explicitly requires the Devices line≤160bytes. Preserve that limit at actual manifest output with literal160. Phase1 spec omitted the number; the earlier unsupported-cap conclusion was incomplete. No independent Devices6KiB catalog or1KiB quick-start limit was found. Six-line guide is explicitly specified. Production guidance text was not changed.

Exact instruction baseline identities at remote lines16 and50 remain KEEP: unified MCP design §9.5/§10/D-13 explicitly supplies2048; Knowledge design Agent tools adds256 only for a visible collection line. Current fixed+workflow text statically measures2042UTF8bytes. Remove only the redundant2304 check from the manifest semantic owner.

One repeated DeviceService rental fixture, the helper-only quick-start test/export and incomplete principal recorder are removed. Real Android lifecycle/iOS rental own platform guides; rental owner explicitly checks zero cards/provisions while planning. Actual manifest owns conditional public keys and160-byte guidance. Shared API action-validation negatives remain at their production-consumed lower seam.

## `apps/daemon/src/mcp/tools/devices.test.ts:79` — KEEP

**the device tools are chat-only; schemas refuse bad and unknown arguments**

External invocations of each of five independently named tools return TOOL_NOT_FOUND. Chat schemas admit supported open/tap/swipe arguments and reject unknown caller identity, executable app/ref strings, unsupported platform/profile/action/key and logs over 60 seconds.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control).
- B2 — External invocations of each of five independently named tools return TOOL_NOT_FOUND. Chat schemas admit supported open/tap/swipe arguments and reject unknown caller identity, executable app/ref strings, unsupported platform/profile/action/key and logs over 60 seconds.
- B3 — Literal public tool keys, accepted inputs, error code, and invalid strings/61-second bound; expectations are not copied from runtime schema enums.
- B4 — executeToolCall audience boundary and audienceSchema consumed for the advertised MCP arguments.
- B5 — No private wrapper/call counts; catalog implementation can change while external visibility and input protocol remain.
- B6 — Manifest availability does not test external invocation denial; shared API action validator does not own MCP argument schema, unknown keys, snake-case shape or audience. No competing lower seam owns this wire contract.

## `apps/daemon/src/mcp/tools/devices.test.ts:99` — REWRITE

**plugin off: every tool answers DEVICES_DISABLED**

Keep the two distinct wiring failures, describe actual coverage accurately.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control).
- B2 — Null backend and daemon integration without device methods both return DEVICES_DISABLED rather than throwing/hanging or exposing an unusable operation.
- B3 — Literal documented DEVICES_DISABLED code for list_devices and close_device; no success stub masquerades as the asserted error.
- B4 — Public executeToolCall with absent/null backend wiring.
- B5 — Renamed the inaccurate every-tool title; assertions depend only on public refusal codes.
- B6 — Manifest hides unavailable tools at advertisement time; explicit invocation still must fail safely. Shared domain service cannot detect a missing DaemonApi method.

Surviving owner: `an unavailable device backend returns DEVICES_DISABLED`.

## `apps/daemon/src/mcp/tools/devices.test.ts:108` — CONSOLIDATE

**open → act → screenshot → install → close, acting for the calling chat only**

Surviving Android workflow owner for the removed quick-start helper scenario.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control).
- B2 — One real DeviceService lifecycle verifies caller-bound lease isolation, normalized @e3 actions, install path/app result, screenshot MCP image bytes plus JSON and persisted deviceRef identity, bounded replay-safe summary, user takeover read/write policy, release and subsequent DEVICE_NOT_LEASED. Actual Android open also owns six-line platform guide and public operational keys/error code.
- B3 — Independent input file, literal device handle/name/app/ref, literal cG5n PNG bytes, 200-codepoint reference contract, documented codes and six-line cap; supplied host output is checked after real executor/service translation.
- B4 — executeToolCall over real runDeviceTool/DeviceService, fake hardware only; real filesystem project build and stored screenshot/reference integration.
- B5 — Removed incomplete principal-call recorder assertion and its fixture machinery, guide prose fragments and incidental control wording; preserve outputs/state/effects required by callers.
- B6 — Domain lease tests cannot catch missing executor principal propagation, MCP action normalization, reference serialization or image/JSON wrapping. API reference reader tests cannot prove the producer emits replayable records. Existing lifecycle absorbs guide protection without another service.

Surviving owner: `same declaration`.

## `apps/daemon/src/mcp/tools/devices.test.ts:189` — CONSOLIDATE

**open_device: a rental the owner did not pre-approve raises a devices spend card, and the approval reaches the open**

Surviving rental owner consolidates planning plus iOS guide assertions.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control). docs/superpowers/research/2026-10-27-devices-spikes.md:19 records SESSION_NOT_FOUND without opening an iOS app before the first snapshot. docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts.
- B2 — Conditional rental requires one ungrantable devices spend card; approval reaches provisioner, existing spare capacity needs no new card, denial creates no host. Planning first returns PERMISSION_DENIED with zero cards/provisions. Actual iOS open owns six-line .app guide and open_app before snapshot ordering.
- B3 — Literal approval kind/family, empty grants, exact one approved provision, no denied/planning side effect; iOS setup order comes from observed spike, guide length from spec.
- B4 — Public tool execution over the same real service/factory for planning, first rental, capacity reuse and denial.
- B5 — Checks spend semantics, chosen platform and state/effects, no exact title/body formatting. No real hardware, sleep or runtime timing oracle.
- B6 — Generic boxes spend and API grants tests cannot catch devices conditional-spend dispatch; DeviceService tests cannot prove MCP approval is propagated. This owner replaces a separate DeviceService startup and helper-only guide invocation.

Surviving owner: `same declaration`.

## `apps/daemon/src/mcp/tools/devices.test.ts:221` — CONSOLIDATE

**open_device while planning: no spend card can be raised**

Duplicate fixture and weaker no-card oracle; preserve unique planning contract inside rental owner.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control). docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts.
- B2 — Planning must neither create an approval card nor rent a device host.
- B3 — PERMISSION_DENIED plus zero card count and empty real provision list in surviving rental scenario.
- B4 — Public open_device through real service; removed isolated case had the same boundary.
- B5 — Uses externally visible refusal/effects and explicit card state; independent of the internal gate helper structure.
- B6 — Moved before the surviving rental opens a host, where it tests the same needs-approval condition with stronger zero-card assertion and one fewer service fixture.

Surviving owner: `apps/daemon/src/mcp/tools/devices.test.ts:189`.

## `apps/daemon/src/mcp/tools/devices.test.ts:235` — CONSOLIDATE

**the quick start is per platform, at most six lines and 1 KiB, and says what the spikes found**

Private helper coverage and copy assertions fail B1/B4/B5/B6; valid guide contracts survive at their actual public output owners.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control). docs/superpowers/research/2026-10-27-devices-spikes.md:19 records SESSION_NOT_FOUND without opening an iOS app before the first snapshot.
- B2 — Keep documented six-line operational guide, Android .apk and iOS .app distinction and iOS app-before-snapshot regression. Delete invented 1KiB bound and frozen prose list without an independent wording contract.
- B3 — Literal platform build extensions and tool keys at actual public opens; six lines from spec; app session ordering from recorded SESSION_NOT_FOUND spike.
- B4 — Actual open_device result in Android lifecycle and iOS rental; former direct exported helper was a weaker seam.
- B5 — Remove helper export and detailed wording/line decoration snapshots; behavior-preserving prose or helper rename is harmless.
- B6 — Both platforms already opened by surviving real workflows, so no separate helper scenario is needed.

Surviving owner: `apps/daemon/src/mcp/tools/devices.test.ts:108 and :189`.

## `apps/daemon/src/mcp/tools/boxes.test.ts:537` — REWRITE

**create_box on one of the owner's own machines: a 'Use your machine' card (free, names the machine), pinned to that machine**

Remove incidental approval wording/format expectations; preserve independently required target, risk and pinned effect.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 (free paired machines); ephemeral AI VMs design §13.2 (explicit never-grantable owner approval and pinned plan); existing consent/security rule that agents require approval to execute on an owner machine.
- B2 — A free owned-machine create still requires never-grantable consent naming the actual machine, free cost and command-execution warning, then creates precisely that provider/machine/region/time limit/purpose.
- B3 — Independent offered machine id/label, semantic free/risk disclosure and literal expected create payload; remove entire title/scope/fields copy snapshot.
- B4 — Public create_box executor and emitted approval preview plus transport create payload.
- B5 — Allow field ordering/labels, wording and formatting changes; retain machine identity and pinned effect/consent semantics.
- B6 — Paid provider plan tests do not cover zero-cost machine consent or correct byo selection; backend temporary-box tests cannot verify the MCP consent preview.

## `apps/daemon/src/mcp/tools/boxes.test.ts:573` — REWRITE

**create_box with provider byo when none of the owner's machines is free: a refusal saying so, and no card**

Retain distinct explicit-provider failure; discard non-contract English wording.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-3-byo-research.md §2.1 (free paired machines); ephemeral AI VMs design §13.2 (explicit never-grantable owner approval and pinned plan); existing consent/security rule that agents require approval to execute on an owner machine.
- B2 — Explicit unavailable byo selection refuses BOX_NOT_READY without raising a card or falling through to a paid provider.
- B3 — Literal code and zero cards with no owned-machine offers; delete whole English explanation substring.
- B4 — Public create_box execution with real provider selection and unrelated paid offers still present.
- B5 — Depends on requested-provider behavior and visible refusal, not wording or helper structure.
- B6 — Generic no-provider case removes every offer; it would miss an explicit byo request silently falling through to an available paid provider.

## `apps/daemon/src/session-tools/instructions.test.ts:58` — CONSOLIDATE

**devices line: present only with the device tools, under its own cap, and the worst case with every line fits**

Consolidate valid conditional guidance and160-byte contract into actual manifest; remove copied-line and coupled constant assertions.

- B1 — docs/orquester-mcp.md:2415–2417 explicitly limits the Devices instruction line to160bytes; phase1 spec §9 requires conditional guidance. Original MCP design §10 and Knowledge design §Agent tools specify their separate bounds.
- B2 — Conditional one-line Devices guidance and its independently documented160-byte limit survive at actual manifest output. Imported line-copy and sum-of-production-constants assertions are removed.
- B3 — Literal160 at the real manifest output, alongside independent public tool keys. Original imported DEVICES_LINE against itself and imported constant-sum oracle fail B3.
- B4 — Real buildSessionToolsManifest output; helper exported constants were redundant and are private/removed.
- B5 — No imported exact instruction prose, incidental order or production-constant expected value remains.
- B6 — Actual Devices manifest case owns conditional presence, public keys and160-byte line. Original helper test is redundant; direct base/Knowledge composition tests independently protect2048/2304 total bounds.

Surviving owner: `apps/daemon/src/session-tools/manifest.test.ts:200`.

## `apps/daemon/src/session-tools/manifest.test.ts:200` — REWRITE

**devices: the device tools and their instruction line only while devices are available**

Keep real per-thread availability contract and public tool-key guidance without copy freeze.

- B1 — docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §9 (chat-only tools, public argument forms, lease ownership, image/reference result, six-line quick start and conditional guidance); §8 (user control). docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts. docs/orquester-mcp.md:2415–2417 independently specifies160bytes.
- B2 — Five independent public Device tool keys and their guidance are absent while unavailable, present when enabled and retained for workflow-owned chats; device availability does not enable paid box tools. Actual emitted Devices guidance is one line ≤160bytes, independently required by current public MCP documentation.
- B3 — Literal independent five keys, semantic instruction keys and literal160-byte bound; no imported line/cap or punctuation assertion.
- B4 — Real buildSessionToolsManifest output consumed by provider launch/refresh, using actual chat catalog.
- B5 — Public name availability is a client contract that survives private identifier/schema assembly changes; instruction wording can change.
- B6 — Owns plugin-dependent advertisement and instruction integration; executor tests own explicit invocation/audience and cannot catch missing manifest propagation. Supersedes catalog name inventory and helper line-copy test.

## `apps/daemon/src/mcp/catalog/registry.test.ts:83` — REWRITE

**tools/list and instructions preserve audience names, MCP annotations and context byte budgets**

Delete only unsupported family budget/declaration assertions from otherwise independent emitted protocol owner.

- B1 — docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts.
- B2 — Retain emitted external/chat audience names, actionable tool references, MCP annotations and independently documented existing context bounds. Remove unsupported new 6KiB Devices-family gate and duplicate five-name inventory; preserve earlier deletion of obsolete 8KiB Knowledge gate.
- B3 — Existing documented literal budgets/annotations remain; no current Devices 6KiB or Knowledge 8KiB requirement found. Actual serialized byte counts can be reported without inventing a threshold.
- B4 — Actual MCP SDK initialize/tools/list over Fastify plus agent-host serialized chat definitions.
- B5 — Public protocol keys and bytes are stable; no import graph or private identifiers. Unsupported family budgets are not maintained by editing production help.
- B6 — Manifest Devices case is stronger owner of the literal five tool keys and availability; this owner uniquely protects emitted annotations, public dangling-reference absence and existing protocol context contracts.

## `apps/daemon/src/mcp/scenarios.test.ts:295` — REWRITE

**advertised to a fresh chat → Admin card (no grant even at Full access) → SKILL.md equals the card; Supervised cards too; planning and workflow-owned refused; external writes without a card**

Remove derived all-tool inventory, retain explicit required tool and critical consent/persistence workflow.

- B1 — docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts.
- B2 — Critical real fresh-chat skill workflow: required edit tool advertised; admin consent never grantable in any mode, persisted SKILL.md equals approved content, card decision races/denials/planning/workflow/external behavior remain protected.
- B3 — Literal edit_agent_profile key and independently supplied skill content/card/effect; remove full expected catalog derived from runtime catalog metadata.
- B4 — Acceptance world runs actual host tool route, approval registry and profile filesystem persistence.
- B5 — Whole runtime-catalog equality was a change detector; surviving assertions use public tool identity, security state and approved bytes.
- B6 — Unit gates cannot detect real fresh-chat advertisement/route/approval/persisted-content wiring; manifest case owns generic plugin filtering, making full inventory redundant.

## `apps/daemon/src/mcp/scenarios.test.ts:893` — REWRITE

**workflow-owned: no Admin tool or request_toolset advertised; Admin calls ADMIN_NOT_AVAILABLE, every card a denial — inherited by the chats it opens, even after it closes**

Remove catalog change detector from the unique critical lineage/security workflow.

- B1 — docs/orquester-mcp.md §5.2/§5.4/§6/§7/§9.5/§10; current shared public agent-tool and session-tool wire contracts.
- B2 — Critical unattended workflow chat advertises no Admin tools, rejects actual Admin calls without cards, and transmits persistent ownership to spawned chats even after parent closes; own allowed action remains functional.
- B3 — Literal refusals, explicit required create_session key, actual prompt/session effects and inherited ownership; no complete positive inventory derived from production.
- B4 — Real per-thread manifest, routed tool execution, workflow/session lineage and persisted approvals.
- B5 — Delete full non-Admin runtime-catalog equality; retain semantic security and lineage effects, unchanged public identities.
- B6 — Generic manifest/filter tests do not exercise daemon wiring or ownership after parent deletion. The derived positive catalog duplicated that lower manifest seam.

## `apps/daemon/src/agent-host/session-tools/host.test.ts:606` — KEEP

**pushes finishing out of order never roll a list back (`superseded`)**

No semantic change; preserve independently justified stale-push regression owner.

- B1 — Agent-host/session-tools protocol: stamped manifest pushes must not roll provider definitions back; host.ts applyManifest public result contract and documented daemon handover ordering.
- B2 — A push older than launched sequence is superseded; seq12 followed by seq11 leaves restart owed for seq12, rather than reverting wanted definitions.
- B3 — Independent literal sequences 10,9,12,11 and literal superseded/next-idle state results; deferred ordering is real, with no time sleeps.
- B4 — Public SessionToolsHost.issue/applyManifest/needsRestart and real registered manifest state.
- B5 — Observable ordering/restart state survives private identifiers and helper refactors; incoming change only removes unused callback parameter.
- B6 — Manifest builder tests cannot detect cross-push ordering in the host. This test uniquely checks late same-epoch pushes relative to launched/wanted state.

## `apps/daemon/src/session-tools/instructions.test.ts:16` — KEEP

**the worst case — workflow-owned — stays under 2 048 bytes**

KEEP: independent authored numeric budget verified in current repository source; do not delete on an unsupported-budget assumption.

- B1 — docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.5 table, §10 and decisionD-13 explicitly require2048bytes. The current no-Devices fixed+workflow block statically measures2042UTF8bytes; the bound remains live.
- B2 — No-Devices workflow-owned instruction block stays≤2048UTF8bytes. Detects fixed/workflow guidance growth beyond the independently authored context budget.
- B3 — Literal2048 and standard UTF8 byte count; the expected limit is not imported or computed from implementation.
- B4 — composeOrquesterInstructions returns the actual per-thread instruction text consumed by the host; this pure composer is the lowest stable owner of composition size.
- B5 — No exact prose or private identifiers are asserted. Behavior-preserving wording/refactors pass while within the documented budget.
- B6 — Knowledge line and manifest availability tests do not bound base workflow composition when Knowledge/Devices are absent. The combined2304 case permits extra bytes, so would not detect a2050-byte base regression.

## `apps/daemon/src/session-tools/instructions.test.ts:50` — KEEP

**the worst case with the knowledge line — workflow-owned, many collections — stays under 2 048 + 256 bytes**

KEEP: independent authored numeric budget verified in current repository source; do not delete on an unsupported-budget assumption.

- B1 — docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §9.5 table, §10 and decisionD-13 explicitly require2048bytes. docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md:301–310 explicitly permits an additional256bytes only with the collection line.
- B2 — Full workflow instruction block plus maximally crowded ASCII/multibyte Knowledge collections stays≤2304UTF8bytes, while still including Knowledge guidance. Detects composition duplicating/expanding content beyond the explicit client-context budget.
- B3 — Literal2304 and standard UTF8 byte count against independent input fixtures; expected bound does not import production constants.
- B4 — composeOrquesterInstructions returns the actual per-thread instruction text consumed by the host; this pure composer is the lowest stable owner of composition size.
- B5 — No exact prose or private identifiers are asserted. Behavior-preserving wording/refactors pass while within the documented budget.
- B6 — Existing Knowledge line test owns its256-byte truncation, not the combined workflow composition. Remove duplicate2304 assertion from manifest semantic case; this direct owner uniquely covers combined worst-case ASCII/multibyte inputs.

## `apps/daemon/src/session-tools/manifest.test.ts:190` — REWRITE

**knowledge: a workflow-owned chat keeps the knowledge tools (none is Admin) and gets both lines, under the raised cap**

Remove only redundant total-size assertion; preserve actual workflow/Knowledge manifest integration.

- B1 — Unified MCP design §5.4/§10 and Knowledge plugin design Agent tools: Knowledge tools are not Admin; workflow guidance and visible collection guidance compose.
- B2 — Workflow-owned chats retain all allowed Knowledge tools and receive both approval restriction and visible collection guidance.
- B3 — Independent literal public tool keys, supplied collection names and semantic approval/Knowledge state; no production-derived expected catalog.
- B4 — Actual buildSessionToolsManifest output handed to provider launch.
- B5 — Renamed the case to match semantic assertions; removed duplicate2304byte assertion now uniquely owned by direct instruction composition case.
- B6 — Unlike pure composition tests, detects Knowledge gating or manifest composition dropping workflow/collection guidance; its byte assertion was superseded by lower direct composer tests.

## Validation and performance

Scoped static diff checks passed. Child has not run tests/typechecks/timings; central coordinator owns uncontended baseline and required gates. The later160-byte and duplicate-budget corrections are pending root rerun. No performance percentage is inferred from fixture/declaration counts.

Focused planned command from apps/daemon:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --test --test-concurrency=4 src/mcp/tools/devices.test.ts src/mcp/tools/boxes.test.ts src/mcp/catalog/registry.test.ts src/mcp/scenarios.test.ts src/session-tools/instructions.test.ts src/session-tools/manifest.test.ts src/agent-host/session-tools/host.test.ts
```

Required changed/full/typecheck gates and final timings remain centrally coordinated. Real acceptance scenarios retain critical host/route/approval/filesystem wiring.
