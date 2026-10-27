# Incoming devices: agent-chat test disposition

Only five declarations added by610d3c53 relative to923b in four changed agent-chat test files. Existing declarations retain their earlier ledgers; lower devices/chat-rows cases are counted by their own owner.

Incoming five declarations: KEEP1, REWRITE4; all five survive. No new replacement tests. Test-block LOC111→70 (−41); this excludes pre-existing cleanup and other owners’ changes. Removed the incoming unused singleToolCallLabel import.

ui_other_lib/devices_state_audit removes all six direct chat-rows tests; meaningful reference/name/target coverage moves to these actual entry/display owners. Lower copy/verb/ref-stripping inventories are deleted rather than reproduced. Do not double-count those declarations here.

Resolved presentation.logic.test.ts conflict by preserving prior public approval reason/grant protection and rewriting incoming device cases; staged only that conflict path as requested. Other two edited tests remain unstaged for root integration.

Upstream initialGoneWatch/toolApprovalCanApprove wrappers and redundant barrels stay deleted. No cache hook/export is restored. App store changes wire device state and fleet navigation; no incoming auth test declarations changed. serverViewOpen has real session-nav/desktop-host-nav/summary-event consumers; DeviceNameResolver has real ActivityRows consumer. No production edit was needed in this scope.

Scoped git diff --check and AST syntax/count inspection passed. No tests or typechecks run in this integration round; waiting for root serialized slot. No performance claim.

Proposed focused validation:

```sh
cd packages/ui && TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=30000 --test-concurrency=4 src/components/agent-chat/banners/banner-model.test.ts src/components/agent-chat/timeline/markdown/knowledge-citation.dom.test.ts src/lib/agent-chat/entries.logic.test.ts src/lib/agent-chat/presentation.logic.test.ts
```

## packages/ui/src/components/agent-chat/banners/banner-model.test.ts:20 — live activity precedes urgent notices, preserving equal-priority order and the input

**KEEP**. No edit; upstream’s simpler stable sort remains supported by its documented semantic owner.

- Independent contract: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.5 explicitly orders activity, urgent/error/warning, notices; the consumed sort API documents stable ordering and accepts readonly input.
- Real regression: A warning displaces active progress, equal-priority notices reorder, or sorting mutates the caller’s displayed entries.
- Independent oracle: The manually authored six-entry fixture has a fixed expected priority sequence and an untouched input copy, independent of bannerPriority.
- Stable seam: sortBannerStack is the production-consumed pure stack-order boundary.
- Refactor resistance: Observes entry order and readonly input behavior, without DOM geometry, classes or collaborator calls.
- Unique protection: No existing banner case tests priority order; dock selection and approval gating cover different contracts.

## packages/ui/src/components/agent-chat/timeline/markdown/knowledge-citation.dom.test.ts:157 — requires another click when a loaded remote image's source changes

**REWRITE**. Replace exact button-copy matching with existence of the action before the second click.

- Independent contract: ChatMarkdownProps.remoteImages documents explicit opt-in to prevent tracking pixels; KnowledgeEntrySections uses this mode for untrusted saved posts. This is a privacy boundary per source URL.
- Real regression: React retains the first image’s approved state when the message changes to a tracker URL, requesting a different resource without consent.
- Independent oracle: Two unrelated literal URLs and explicit clicks; after replacing the source, no image exists until another click, then the image has the second URL.
- Stable seam: Mounted public ChatMarkdown component with remoteImages="click" and real DOM click/rerender behavior.
- Refactor resistance: Only resource presence/src and the ability to click matter. Removed exact button caption assertion.
- Unique protection: Existing static-render case tests initial opt-in only; it cannot catch state leaking across a source update.

## packages/ui/src/lib/agent-chat/entries.logic.test.ts:785 — links a device tool's row to the device its result names (deviceRef), with the action's words

**REWRITE** → links live and persisted device rows, ignoring unmarked and malformed result fields. 45-line test body becomes14 lines; covers live, persisted reference with/without full result, malformed fields and unmarked provenance, while deleting six exact label mappings.

- Independent contract: docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §10.3 requires device references to drive Show device and screenshots. API session-tools reference preservation and DeviceToolReference specify slimmed references, marked provenance, recognized actions and single-line summary data.
- Real regression: Actual activity-to-entry conversion drops or corrupts device/lease/screenshot identity, loses live action data, overwrites persisted reference data, accepts malformed result fields, or links an unmarked spoof.
- Independent oracle: Authored result and persisted-reference fixtures are asserted as fixed field values; malformed action/multiline summary must leave the valid reference alone. No expected helper call is used.
- Stable seam: workLogEntryFromActivity, the actual UI entry conversion used before rendering the link/thumbnail.
- Refactor resistance: Asserts semantic entry data only; all label vocabulary inventories and private-helper calls are removed.
- Unique protection: API tests validate parsing, but do not verify the entry conversion invokes that parsing/enrichment or exposes the result. The direct lower completeDeviceReference case is absorbed here in coordination with devices_state_audit.

## packages/ui/src/lib/agent-chat/presentation.logic.test.ts:67 — read as what they did to which device, the store's name as a fallback

**REWRITE** → preserves device names and action targets, resolving a missing name from the store. 15-line test body becomes8 lines; absorbs meaningful name/target assertions from removed lower chat-rows cases without retaining copy inventory.

- Independent contract: Devices phase1 §10.3 requires identifying the device/action in the chat row. DeviceRowLink.useDeviceLinkName supplies the live store name only when the persisted reference has none; ActivityRows passes it to public row presentation.
- Real regression: The public presentation chain drops the name resolver, lets a current store name override the recorded target, or replaces an authored action target with generic wording.
- Independent oracle: Independent fixture strings Pixel9/PixelFold/Search appear in the appropriate result; no whole generated sentence or implementation-generated expected value.
- Stable seam: workEntryDisplayLabel, consumed by ActivityRows, receives the same reference and resolver shape as production.
- Refactor resistance: Checks user data and fallback precedence, allowing sentence/verb/format changes. Removes direct singleToolCallLabel invocation.
- Unique protection: Entries owner verifies data extraction only. Lower label tests cannot catch omitted forwarding in sessionToolEntryLabel/workEntryDisplayLabel and are removed in favor of this single owner.

## packages/ui/src/lib/agent-chat/presentation.logic.test.ts:83 — keep the approval suffix of a gated call

**REWRITE** → keeps the approval outcome alongside the device name. 12-line test body becomes9 lines and retains both meaningful outcomes.

- Independent contract: Unified MCP design §7.1 After and §7.3 toolApproval row reference require a gated call to report its approval outcome; devices phase1 §10.3 requires the device identity on that same row.
- Real regression: A device-specific label returns early and loses the approval outcome, or the approval label erases the device being rented. The generic workflow-label case remains green under this failure.
- Independent oracle: Authored device name plus approved input state; assert device data and semantic approved state rather than a whole exact sentence.
- Stable seam: Public workEntryDisplayLabel over a spend-approved device session-tool entry.
- Refactor resistance: Independent of helper exports, exact punctuation, verbs, suffix placement or DOM shape.
- Unique protection: Generic approval owner cannot exercise device-specific label composition; device label/name owner has no approval input. This is the unique interaction between both contracts.
