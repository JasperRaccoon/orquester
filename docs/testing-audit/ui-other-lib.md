# Shared UI supporting-library test audit

Scope: **73 files, 626 source test declarations / 643 expanded named cases**, baseline `beb7516b`, under `packages/ui/src/lib/**` excluding `agent-chat` and `workflows`. The named cases below include all seven parameterized declarations expanded from their checked-in input lists. This is a behavioral audit, not a coverage-percentage verdict.

Disposition counts refer to original named cases, including surviving consolidation owners: **CONSOLIDATE 8**, **DELETE 6**, **KEEP 608**, **OPTIMIZE 4**, **REWRITE 17**.

Validation is serialized by the coordinating agent. Focused/full outcomes and comparable timings are recorded below when run; no passing gate is claimed before execution.

## How to read the six-part evidence

Each file has its independent requirement/protocol source, observable contract, production seam/callers, credible failures and non-duplicate ownership explanation. These apply to each named retained row below. The row identifies the exact distinct scenario and its independent literal/fixture assertion evidence; expected fixtures are test data, never calculated by calling the production operation. Where a former test imported the very limit/helper it asserted, the changed disposition explains the replacement or deletion. Retained rows observe returned values, external-store state, callbacks, bytes, real installed consumer behavior, or controlled platform APIs; they do not inspect source identifiers or private method call structure. Thus identifier-only/internal refactors survive. Wire-policy and configuration limits are retained when they are independently specified; requested icon geometry and terminal buffer-cell coordinates are protocol/configuration data, not incidental layout.

## Cleanup and supporting seams

- Link-preview tests now exercise `LinkPreviewStore.request/get` with controlled platform Date. Remove `LinkPreviewStoreOptions` (clock/freshness/concurrency/capacity injection), six helper/timing exports and unused per-instance option fields. Production fetcher-only caller, timing defaults, concurrency and eviction behavior stay the same.
- Make `agentProfileItemKey`, `CONNECTION_LOG_LIMIT`, `RESTART_WINDOW_MS`, and `WS_BLOCKED_AFTER` private after removing derived-key/threshold oracles. Their production algorithms remain.
- Consolidate the bounded quality step-down and real installed noVNC ABI scenarios. Delete copied byte-size formatting and VM display-policy matrices while preserving actual USD duration conversions and quoted hourly amount/unit.
- Drop preferred-profile object-identity coupling and redundant new-whiteboard validation through a second production function.
- Keep the independently specified two-hour drift simulations. Omit only unobserved PCM writes and unasserted sine generation in stats-only cases; acoustic checks still record both channels. Shrink the persisted collapse-cap fixture to 501 keys.
- No dependency, snapshot or fixture file became orphaned. Shared fixture modules still have production-contract tests. No production-facing API is removed; removed exports/options have no non-test external caller.

## packages/ui/src/lib/agent-auth-notice.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.7.

**Contract / recognizable regressions (2):** Dismissed provider-auth notices stay dismissed until provider/verdict/message changes. Repeated provider reloads can make the same toast impossible to dismiss, or suppress another provider’s failure.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** agent-auth-notice.ts; app store auth-notice sink.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Each key dimension selects a distinct result; the first regression includes repeated delivery so consumption-on-read cannot pass. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L8: <code>a dismissal sticks across the re-publish the provider load causes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(shouldRaiseAgentAuthNotice(claude, dismissed), false); assert.equal(shouldRaiseAgentAuthNotice(claude, dismissed), false)</code> |
| L17: <code>a DIFFERENT message on the same provider still gets through</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( shouldRaiseAgentAuthNotice({ ...claude, message: &quot;Refresh token revoked.&quot; }, dismissed), true )</code> |
| L25: <code>the same message on a different provider still gets through</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( shouldRaiseAgentAuthNotice({ ...claude, sessionId: &quot;provider:codex&quot; }, dismissed), true )</code> |
| L33: <code>the key spans [adapterId, status, auth.status, message] (T3&#x27;s banner key)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( shouldRaiseAgentAuthNotice(errored, dismissed), false, &quot;the same result never re-toasts&quot; ); assert.equal( shouldRaiseAgentAuthNotice({ ...errored, authStatus: &quot;unauthenticated&quot; }, dismissed), true, &quot;an ambiguity turning into a verdict is new news&quot; )</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/agent-auth-notice.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/agent-chat-active-tab.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.4,7.7; documented wrong-tab keyboard regression.

**Contract / recognizable regressions (2):** Only the visible/focused chat owns keyboard commands; leaving a tab closes its popovers. A chord can send or approve in a hidden chat, a stale unmount can release another tab’s claim, or activating a grid chip can immediately close it.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** agent-chat-active-tab.ts; MainView and chat composer/banner keyboard listeners.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Derivation and registry are both production-consumed seams; event/renderer tests cannot independently distinguish these ownership transitions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L6: <code>only the published tab is active; every other mounted tab is not</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isActiveChatTab(&quot;a&quot;), true); assert.equal(isActiveChatTab(&quot;b&quot;), false)</code> |
| L17: <code>no chat tab showing means no chat tab owns the keyboard</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isActiveChatTab(&quot;a&quot;), false); assert.equal(activeChatTab(), null)</code> |
| L24: <code>subscribers see each change once and never a repeat of the same id</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(seen, [&quot;a&quot;, &quot;b&quot;, null])</code> |
| L37: <code>a tab releases the keyboard only while it still holds it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(activeChatTab(), &quot;a&quot;); assert.equal(activeChatTab(), null)</code> |
| L58: <code>the active chat tab is the one showing, not merely one that is mounted</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(activeChatSessionIdFor(tabs, &quot;t1&quot;), &quot;s1&quot;); assert.equal(activeChatSessionIdFor(tabs, &quot;t2&quot;), &quot;s2&quot;)</code> |
| L63: <code>a terminal tab on screen means NO chat tab owns the keyboard</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(activeChatSessionIdFor(tabs, &quot;t3&quot;), null); assert.equal(activeChatSessionIdFor(tabs, &quot;t4&quot;), null)</code> |
| L70: <code>no active tab, or an id naming none, owns nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(activeChatSessionIdFor(tabs, null), null); assert.equal(activeChatSessionIdFor(tabs, undefined), null)</code> |
| L79: <code>a popover subscribed while its unfocused grid cell is being activated stays open</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(dismissed, 0, &quot;activating its own tab must not close it&quot;); assert.equal(dismissed, 1, &quot;switching to another tab closes it&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/agent-chat-active-tab.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/agent-profile/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-28-agent-profile-design.md; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Global agent-config snapshots, permissions, revisions, per-connection isolation, and remembered panel selections. An old load can overwrite a mutation, a locked item can become editable, an obsolete daemon can break rendering, or a late prior-connection result can contaminate the selected daemon.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** agent-profile/store.ts and sanitize.ts; AgentProfilePanel, editor ImportSources/PluginEditor/saved, and hooks consume their state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon adapter tests cannot expose client event/load/reset races or localStorage compatibility; each named scenario selects a distinct ordering, field policy, or mutation verdict. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L178: <code>keeps a well-formed snapshot as it is</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeAgentProfileSnapshot(clean), clean)</code> |
| L183: <code>refuses a snapshot that names no known agent</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeAgentProfileSnapshot(bad), null, JSON.stringify(bad))</code> |
| L189: <code>drops malformed items rather than failing the snapshot, and keeps the first of a duplicate id</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( clean?.items.map((entry) =&gt; [entry.id, entry.name]), [ [&quot;mcp:jira&quot;, &quot;jira&quot;], [&quot;skill:review&quot;, &quot;review&quot;] ] )</code> |
| L212: <code>fails permissions closed and locks everything on a locked item</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loose?.toggleable, false); assert.equal(loose?.editable, false)</code> |
| L221: <code>repairs the source, the warnings and the meta</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(repaired?.source.ownerAgent, undefined); assert.equal(repaired?.source.pluginId, undefined)</code> |
| L241: <code>repairs the instructions and the file errors, and tolerates a missing list</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(clean); assert.deepEqual(clean.items, [])</code> |
| L263: <code>sanitizes the overview: known agents once, counts of known kinds only</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeOverview({ agents: &quot;x&quot; }), null); assert.deepEqual( sanitizeOverview({ agents: [ { agent: &quot;claude&quot;, installed: true, counts: { mcp: 2, agent: 4, skill: -1 } }, { agent: &quot;claude&quot;, installed: false, counts: {} }, { agent: &quot;gemini&quot;, installed: true }, { agent: &quot;grok&quot;</code> |
| L287: <code>loads a snapshot, and a second unforced load asks nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(entry.status, &quot;ready&quot;); assert.equal(entry.snapshot?.revision, &quot;r1&quot;)</code> |
| L296: <code>is single-flight: concurrent callers share one request</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.claude.status, &quot;loading&quot;); assert.deepEqual(api.gets, [&quot;claude&quot;])</code> |
| L307: <code>a forced load during one in flight asks once more after it — shared by every forced caller</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;])</code> |
| L318: <code>a first load that fails is an error; a refresh that fails keeps the snapshot beside the error</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( [agentProfileStore.getState().agents.claude.status, agentProfileStore.getState().agents.claude.error], [&quot;error&quot;, &quot;disk on fire&quot;] ); assert.equal(agentProfileStore.getState().agents.claude.status, &quot;ready&quot;)</code> |
| L336: <code>keeps the daemon&#x27;s refusal code for a not-installed agent</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.grok.errorCode, &quot;AGENT_NOT_INSTALLED&quot;)</code> |
| L342: <code>an answer for another agent or in a bad shape is an error, not state</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.codex.status, &quot;error&quot;); assert.equal(agentProfileStore.getState().agents.claude.snapshot, null, &quot;never lands on the agent it names&quot;)</code> |
| L349: <code>loads the overview, sanitized</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(overview.status, &quot;ready&quot;); assert.deepEqual( overview.agents?.map((summary) =&gt; [summary.agent, summary.installed]), [ [&quot;claude&quot;, true], [&quot;codex&quot;, true], [&quot;grok&quot;, false], [&quot;opencode&quot;, true] ] )</code> |
| L366: <code>marks everything loaded stale on a reconnect, and a load crossing it asks again</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.claude.stale, true); assert.equal(agentProfileStore.getState().overview.stale, true)</code> |
| L396: <code>refetches a loaded agent whose revision moved</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;]); assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, &quot;r2&quot;)</code> |
| L406: <code>does nothing for the revision already held</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;]); assert.equal(agentProfileStore.getState().agents.claude.stale, false)</code> |
| L414: <code>does not fetch an agent that was never loaded</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;]); assert.equal(agentProfileStore.getState().agents.codex.status, &quot;idle&quot;)</code> |
| L422: <code>refreshes a loaded overview too</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(api.overviewGets, 2)</code> |
| L431: <code>a change during an agent&#x27;s FIRST load asks once more after it (that answer may predate the change)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;]); assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, &quot;r2&quot;)</code> |
| L446: <code>ignores a malformed payload or another type without a throw</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.doesNotThrow(() =&gt; { applyAgentProfileEvent({ type: &quot;agentProfile.changed&quot;, payload: null }); applyAgentProfileEvent({ type: &quot;agentProfile.changed&quot;, payload: { agent: &quot;gemini&quot;, revision: &quot;x&quot; } }); applyAgentProfileEvent({ t; assert.deepEqual(api.gets, [&quot;claude&quot;])</code> |
| L464: <code>replaces the snapshot with the answer&#x27;s and says so, the change carrying the item&#x27;s revision</code> | REWRITE | Removes a private pending-key serialization echo calculated by the same production helper; snapshot/revision/request/notice and both busy/settled-pending contracts remain. The test-only helper export becomes private. Oracle: <code>assert.equal(agentProfileStore.getState().pending.has(agentProfileItemKey(&quot;claude&quot;, &quot;mcp:jira&quot;)), true); assert.equal(result.ok, true)</code> |
| L482: <code>the daemon&#x27;s notes become the notice</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(agentProfileStore.getState().notice?.text.includes(&quot;OpenCode servers restart when idle.&quot;))</code> |
| L493: <code>a 409 PROFILE_CONFLICT refetches the agent and says it changed on disk</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(result, { ok: false, error: &quot;Stale revision&quot;, code: &quot;PROFILE_CONFLICT&quot;, status: 409 }); assert.equal(agentProfileStore.getState().notice?.tone, &quot;error&quot;)</code> |
| L504: <code>another refusal becomes the notice in the daemon&#x27;s words</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().notice?.tone, &quot;error&quot;); assert.ok(agentProfileStore.getState().notice?.text.includes(&quot;Orquester&#x27;s own hook is locked&quot;))</code> |
| L513: <code>AGENT_NOT_INSTALLED refetches the agent and the overview (the picker learns it)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;]); assert.equal(api.overviewGets, 2)</code> |
| L525: <code>a copy lands the TARGET&#x27;s snapshot on the target</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, true); assert.deepEqual(api.mutations[0]?.body, { toAgent: &quot;codex&quot; })</code> |
| L537: <code>a copy whose name is taken answers ITEM_EXISTS quietly; the retry carries onConflict</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(first.ok, false); assert.equal(!first.ok &amp;&amp; first.code, &quot;ITEM_EXISTS&quot;)</code> |
| L549: <code>an answer whose snapshot does not parse refetches instead</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, true); assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;])</code> |
| L559: <code>a load that started before a mutation answered does not overwrite the mutation&#x27;s snapshot</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, &quot;r5&quot;)</code> |
| L577: <code>forgets everything, and an answer in flight across it is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.claude.snapshot, null); assert.equal(agentProfileStore.getState().agents.claude.status, &quot;idle&quot;)</code> |
| L591: <code>a client of another connection resets first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentProfileStore.getState().agents.claude.snapshot, null, &quot;the other daemon&#x27;s profile is gone&quot;); assert.equal(agentProfileStore.getState().agents.codex.snapshot?.revision, &quot;x1&quot;)</code> |
| L601: <code>after a reset an event refetches nothing (no client bound)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;])</code> |
| L643: <code>parses field by field, and anything unusable is no pick</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await withPreferences(raw, selections), [null, null, null, null, null], String(raw)); assert.deepEqual(await withPreferences(&#x27;{&quot;v&quot;:7,&quot;agent&quot;:&quot;grok&quot;,&quot;future&quot;:true}&#x27;, selections), [&quot;grok&quot;, null, null, null, null])</code> |
| L650: <code>keeps a tab only for a known agent that has that kind</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await withPreferences(JSON.stringify({ agent: &quot;claude&quot;, tabs: { claude: &quot;skill&quot;, codex: &quot;command&quot;, opencode: &quot;hook&quot;, grok: 7, gemini: &quot;mcp&quot; } }), selections), [&quot;claude&quot;, &quot;skill&quot;, &quot;command&quot;, null, null]); assert.deepEqual(await withPreferences(JSON.stringify({ agent: &quot;codex&quot;, tabs }), selections), [&quot;codex&quot;, null, null, null, null])</code> |
| L660: <code>serializes over what another bundle stored, keeping its fields and tabs</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(JSON.parse(storage.value ?? &quot;&quot;), { v: 1, agent: &quot;codex&quot;, tabs: {} }); assert.deepEqual(JSON.parse(storage.value ?? &quot;&quot;), { v: 1, agent: &quot;codex&quot;, kinds: [&quot;mcp&quot;], tabs: { gemini: &quot;mcp&quot;, codex: &quot;hook&quot; } })</code> |
| L674: <code>reads stored selections, remembers each agent&#x27;s tab, and keeps preferences across a reset</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(lastAgentProfileAgent(), &quot;opencode&quot;); assert.equal(lastAgentProfileTab(&quot;claude&quot;), &quot;plugin&quot;)</code> |
| L701: <code>a storage that throws leaves the pick and the tabs in memory</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.doesNotThrow(() =&gt; rememberAgentProfileAgent(&quot;grok&quot;)); assert.doesNotThrow(() =&gt; rememberAgentProfileTab(&quot;grok&quot;, &quot;hook&quot;))</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/agent-profile/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/agent-tools/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §§7,9; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Tool approval lifetime, per-thread identity, safe grant parsing, revocation, and watched-view refresh. An answered approval can reopen, another chat can receive its preview, malformed grant controls can reach state, or a revoked grant can remain shown.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** agent-tools/store.ts; approval cards and settings read the external stores.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon permission tests enforce access; these tests independently protect client card lifecycle, stale loads, and cross-chat presentation. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L68: <code>opens and closes on the bus, oldest first; ignores malformed and foreign cards</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(), [&quot;a&quot;, &quot;b&quot;]); assert.deepEqual(ids(), [&quot;a&quot;, &quot;b&quot;])</code> |
| L84: <code>sanitises what reaches state</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(toolApprovalsFor(toolApprovalsStore.getState(), &quot;s1&quot;)[0]!.title, &quot;xy z&quot;)</code> |
| L89: <code>a load keeps a card opened meanwhile and never revives one closed meanwhile</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(), [&quot;listed&quot;, &quot;fresh&quot;])</code> |
| L108: <code>a reset drops a load answered for the previous connection</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(), [])</code> |
| L122: <code>the full preview is checked to be this card&#x27;s; a gone card closes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await fetchToolApprovalDetail(api(async () =&gt; ({ approval: summary(&quot;a&quot;) })), &quot;s1&quot;, &quot;a&quot;))?.approvalId, &quot;a&quot;); assert.equal(await fetchToolApprovalDetail(api(async () =&gt; ({ approval: summary(&quot;zzz&quot;) })), &quot;s1&quot;, &quot;a&quot;), null)</code> |
| L137: <code>reads the settings&#x27; grants field-wise; an older daemon&#x27;s toolset fields are ignored</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsed?.grants.map((grant) =&gt; grant.workflowIds), [[&quot;w&quot;]]); assert.deepEqual(older, parsed)</code> |
| L149: <code>reads a chat&#x27;s view for that chat only; an older daemon&#x27;s toolset fields are ignored</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsed &amp;&amp; Object.keys(parsed).sort(), [&quot;agent&quot;, &quot;grants&quot;, &quot;threadId&quot;, &quot;workflowOwned&quot;]); assert.equal(parsed?.workflowOwned, true)</code> |
| L169: <code>strips control characters from a grant&#x27;s family</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parseAgentToolGrant({ id: &quot;g&quot;, family: &quot;work‮flows&quot;, scope: &quot;chat&quot;, projectPath: &quot;/p&quot;, createdAt: &quot;c&quot; })?.family, &quot;workflows&quot;)</code> |
| L199: <code>loads settings; an older daemon&#x27;s bare 404 marks them unsupported</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(agentToolsStore.getState().settings, { grants: [] }); assert.equal(agentToolsStore.getState().settingsUnsupported, true)</code> |
| L207: <code>agentTools.changed re-reads the watched chat and the shown settings</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.calls.sort(), [&quot;get&quot;, &quot;thread:t1&quot;]); assert.deepEqual(api.calls.sort(), [&quot;get&quot;, &quot;thread:t1&quot;])</code> |
| L231: <code>revoking a grant that is already gone is not an error, and the lists are read again</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.calls, [&quot;revoke:g1&quot;, &quot;get&quot;])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/agent-tools/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/app-config.test.ts

**Independent source (1):** AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields); packages/config/src/index.ts (AppConfig/usage schema migration).

**Contract / recognizable regressions (2):** Persisted app fields validate independently and legacy usage preferences migrate. An old storage blob can crash app startup, override host defaults with absent fields, or discard unrelated valid settings.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** app-config.ts; web runtime AppConfigAdapter.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Config schema tests own the schema; adapter tests own applying it to raw localStorage while preserving the rest of the app blob. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L15: <code>stored app fields validate individually and legacy usage preferences migrate</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(stored.useTitlebar, undefined); assert.equal(stored.runInBackground, true)</code> |
| L35: <code>non-object app configuration loads as empty</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await load(null), {}); assert.deepEqual(await load(&quot;junk&quot;), {})</code> |
| L42: <code>a corrupt usage group leaves unrelated valid app fields intact</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(badUsage.confirmCloseSession, false); assert.equal(badUsage.desktopNotifications, undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/app-config.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/app-wiring.test.ts

**Independent source (1):** README.md (plugin, workspace and chat behavior); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts.

**Contract / recognizable regressions (2):** App event-channel dispatch, plugin enable/disable loading, per-connection clearing, and Knowledge view navigation. A feature can stop receiving events or receive another channel, disable without clearing private state, lose track of billed boxes, or mark a covered chat read.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** store/app.ts and feature store public actions; both frontend entry points use this store.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Feature-store unit tests call their event handler directly and cannot protect app registration/channel gating; navigation tests cover the actual shared app-store actions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L91: <code>agentProfile.changed on the agent-profile channel refetches the loaded agent</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;, &quot;claude&quot;]); assert.equal(agentProfileStore.getState().agents.claude.snapshot?.revision, &quot;r2&quot;)</code> |
| L102: <code>the same message on another channel does not</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.gets, [&quot;claude&quot;])</code> |
| L164: <code>ignores boxes events until the plugins list is known</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes, null)</code> |
| L169: <code>with the plugin off, holds the boxes events report still running, and only those</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes, null); assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;b1&quot;])</code> |
| L177: <code>loads when the plugin turns on, routes events, and keeps only the running boxes when it turns off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual([...fake.calls].sort(), [&quot;boxes&quot;, &quot;changes&quot;, &quot;kinds&quot;, &quot;providers&quot;]); assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;b1&quot;])</code> |
| L206: <code>turning off with nothing running forgets everything</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes?.length, 1); assert.equal(boxesStore.getState().boxes, null)</code> |
| L217: <code>a connection switch&#x27;s empty plugin list forgets the boxes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(boxesStore.getState().boxes); assert.equal(boxesStore.getState().boxes, null)</code> |
| L263: <code>ignores knowledge events while the plugin is off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(knowledgeStore.getState().status, null)</code> |
| L269: <code>loads when the plugin turns on, routes its events, and forgets everything when it turns off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual([...fake.calls].sort(), [&quot;collections&quot;, &quot;status&quot;]); assert.equal(knowledgeStore.getState().status?.entries, 2)</code> |
| L313: <code>opens over the main area without touching the project&#x27;s tabs, and closes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(store().knowledgeView, { open: true, focus: null }); assert.equal(store().sidebarDrawerOpen, false, &quot;opened from the phone&#x27;s drawer, the drawer closes&quot;)</code> |
| L324: <code>opens with no project open</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store().knowledgeView.open, true); assert.equal(store().knowledgeView.focus?.id, &quot;ke_aaaaaaaaaaaa&quot;)</code> |
| L331: <code>openKnowledgeEntry selects the entry, with a new nonce each time; a plain open keeps it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(first?.kind, &quot;entry&quot;); assert.equal(first?.id, &quot;ke_aaaaaaaaaaaa&quot;)</code> |
| L349: <code>going to the project, a tab or a tool leaves it, keeping its focus</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store().knowledgeView.open, false, name); assert.equal(store().knowledgeView.focus, focus, `${name} keeps the focus`)</code> |
| L367: <code>a chat turn ending under it stays unread until closing it reveals the chat</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store().sessions[0]?.id, &quot;c1&quot;); assert.equal(store().threadVisits.c1, undefined, &quot;hidden under the view, the finished turn is not seen&quot;)</code> |
| L379: <code>a workflow opened in another project leaves it showing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store().knowledgeView.open, true)</code> |
| L385: <code>closes when a loaded plugins list says the plugin is off, not while the list is unknown</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store().knowledgeView.open, true, &quot;a list not loaded yet says nothing&quot;); assert.deepEqual(store().knowledgeView, { open: false, focus: null })</code> |
| L394: <code>closes and forgets its focus on a connection switch</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(store().knowledgeView, { open: false, focus: null })</code> |
| L417: <code>a change and a delete on the repo-identities channel reach the store</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;); assert.equal(getRepoIdentity(KEY), undefined)</code> |
| L425: <code>the same message on another channel does not</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY), undefined)</code> |
| L450: <code>an upsert and a delete on the saved-prompts channel reach the store</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(savedPromptsStore.getState().prompts.get(&quot;wired&quot;)?.title, &quot;Wired&quot;); assert.equal(savedPromptsStore.getState().prompts.has(&quot;wired&quot;), false)</code> |
| L460: <code>the same message on another channel does not</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(savedPromptsStore.getState().prompts.size, 0)</code> |
| L536: <code>ignores secret-files events while the plugin is off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY), undefined)</code> |
| L541: <code>loads the vaults when the plugin turns on, routes events, and forgets them when it turns off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(fake.calls, [&quot;list&quot;, &quot;get&quot;]); assert.ok(getSecretVault(WS, KEY))</code> |
| L564: <code>a connection switch&#x27;s empty plugin list forgets the vaults</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(getSecretVault(WS, KEY)); assert.equal(getSecretVault(WS, KEY), undefined)</code> |
| L577: <code>the store notes a daemon&#x27;s stop announcement from the event stream</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(getConnectionLog().stoppingAt !== null)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/app-wiring.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/auth.test.ts

**Independent source (1):** README.md Security model; packages/api auth token-shape contract.

**Contract / recognizable regressions (2):** Only revocable session tokens persist or travel as credentials; legacy password-equivalent hashes are purged. A legacy password hash can remain stored/sent, invalid storage can become an active token, or unavailable storage can break login.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** auth.ts and connections.ts; sign-in and remote connection loading consume them.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon authentication cannot establish client storage purge and connection conversion behavior; token-shape classification, storage and conversion own different boundaries. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L32: <code>only token-shaped values count as a session token</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(asSessionToken(TOKEN), TOKEN); assert.equal(asSessionToken(LEGACY), undefined, &quot;an older build&#x27;s base64(user:hash) credential&quot;)</code> |
| L42: <code>a stored token round-trips; garbage is dropped from storage; the legacy hash is purged</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loaded, TOKEN); assert.equal(left.has(`orquester.auth:${ENDPOINT}`), false, &quot;the password-equivalent hash does not linger&quot;)</code> |
| L63: <code>storage that throws reads as no token</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loadStoredToken(ENDPOINT), undefined); assert.doesNotThrow(() =&gt; storeToken(ENDPOINT, TOKEN))</code> |
| L80: <code>a remote&#x27;s configured password is carried only when it is a token</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(toUiConnection({ ...remote, password: TOKEN }).password, TOKEN); assert.equal(toUiConnection({ ...remote, password: LEGACY }).password, undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/auth.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/back-close.test.ts

**Independent source (1):** README.md Mobile/PWA; browser History pushState/go/popstate interface.

**Contract / recognizable regressions (2):** Back closes newest overlays once; UI closes release entries without dead Back presses or lost browser history. Back can leave the app, close two overlays, consume a dead press, race an in-flight history traversal, or overwrite unrelated history state.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** back-close.ts; useBackClose/overlay callers use the shared stack.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Hook/DOM tests cannot cheaply and deterministically control asynchronous go landing, forward traversal, and reload-left entries; the fake implements the browser interface, not the overlay stack. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L81: <code>an open overlay holds one entry, and Back closes it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(history.depth(), 1); assert.deepEqual(log, [&quot;sheet&quot;])</code> |
| L97: <code>nested overlays close one at a time, newest first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(history.depth(), 2); assert.deepEqual(log, [&quot;sheet&quot;])</code> |
| L113: <code>an overlay closed through the UI takes its entry back off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(history.travels, [-1]); assert.deepEqual(log, [], &quot;our own traversal closes nothing&quot;)</code> |
| L131: <code>an outer overlay closed under an inner one leaves no dead Back behind</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(history.depth(), 1); assert.deepEqual(log, [&quot;inner&quot;])</code> |
| L148: <code>closing several at once moves history once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(history.depth(), 2); assert.deepEqual(history.travels, [-2])</code> |
| L164: <code>one overlay closing as another opens moves nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(history.travels, []); assert.equal(history.length(), 2)</code> |
| L179: <code>an overlay opened while a traversal of ours travels gets its entry once it lands</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(history.travels, [-1]); assert.equal(history.depth(), 1, &quot;nothing pushed before the traversal lands&quot;)</code> |
| L197: <code>an overlay that refuses the close and registers again holds a fresh entry</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(asked, 1); assert.equal(history.depth(), 1)</code> |
| L217: <code>a Forward onto an entry no overlay holds backs off it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(log, []); assert.deepEqual(history.travels, [-1])</code> |
| L233: <code>reuses the entries a reload left behind</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(history.length(), 2, &quot;the left-over entry is the sheet&#x27;s&quot;); assert.deepEqual(history.travels, [])</code> |
| L246: <code>keeps the page&#x27;s own history state on its entries</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(history.host.history.state, { app: &quot;x&quot;, orqBackClose: 1 })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/back-close.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/boxes/format.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md (costs, $/h, UI plugin lifecycle); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** VM state/credential response validation, provider offers, config-change decisions, billed-box visibility, and honest rate/cost data. A stale destroy/decision answer can undo a newer event, unsafe credential links can be rendered, a billed running box can disappear, or rates/costs can show the wrong amount or unit.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** boxes/store.ts, validate.ts, format.ts; box surfaces, RunsOnRow, settings, sidebar and app event router.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon provisioning cannot protect UI convergence or credential-link sanitization; display prose without an independent formatting requirement is deleted; retained numeric contracts identify actual money or duration conversions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L15: <code>hourly prices keep three significant digits below a dollar, two decimals at least</code> | REWRITE | Arbitrary significant-digit/grouping/rounding matrices are removed; the survivor proves that a real sub-cent VM rate keeps its amount and hourly unit. Surviving owner: hourly rates preserve sub-cent prices and their unit. Oracle: <code>assert.equal(formatHourlyUsd(4.8), &quot;$4.80&quot;); assert.equal(formatHourlyUsd(1), &quot;$1.00&quot;)</code> |
| L32: <code>a zero, negative or non-finite price reads as nothing</code> | DELETE | Fails independent-contract/refactor-resistance: hypothetical invalid-price fallback or incidental rounding, unit phrasing and sentence formatting is copied from implementation. Real duration/cost conversion and hourly quoted amount/unit remain; these display helpers retain production callers. Oracle: <code>assert.equal(formatHourlyUsd(0), &quot;$0.00&quot;); assert.equal(formatHourlyUsd(-1), &quot;$0.00&quot;)</code> |
| L39: <code>rates carry the per-hour suffix</code> | CONSOLIDATE | Hourly unit data is asserted alongside actual sub-cent amount in the surviving rate test; separate suffix execution duplicates that owner. Surviving owner: hourly rates preserve sub-cent prices and their unit. Oracle: <code>assert.equal(formatHourlyRate(4.8), &quot;$4.80/h&quot;); assert.equal(formatHourlyRate(0.0119), &quot;$0.0119/h&quot;)</code> |
| L44: <code>amounts: whole dollars from $100, cents below, a sliver as &lt;$0.01</code> | DELETE | Fails independent-contract/refactor-resistance: hypothetical invalid-price fallback or incidental rounding, unit phrasing and sentence formatting is copied from implementation. Real duration/cost conversion and hourly quoted amount/unit remain; these display helpers retain production callers. Oracle: <code>assert.equal(formatUsd(576), &quot;$576&quot;); assert.equal(formatUsd(115.2), &quot;$115&quot;)</code> |
| L54: <code>monthly is 730 hours, daily 24, a lifetime its minutes</code> | REWRITE | Retains independent duration/cost arithmetic; asserts dailyUsd=$115.20 at USD cent precision instead of pinning formatUsd’s unrelated whole-dollar display rounding. Oracle: <code>assert.equal(monthlyUsd(0.0119).toFixed(3), &quot;8.687&quot;); assert.equal(formatUsd(dailyUsd(4.8)), &quot;$115&quot;)</code> |
| L60: <code>lifetimes read in days, hours or minutes</code> | DELETE | Fails independent-contract/refactor-resistance: hypothetical invalid-price fallback or incidental rounding, unit phrasing and sentence formatting is copied from implementation. Real duration/cost conversion and hourly quoted amount/unit remain; these display helpers retain production callers. Oracle: <code>assert.equal(formatLifetime(7200), &quot;5 days&quot;); assert.equal(formatLifetime(1440), &quot;1 day&quot;)</code> |
| L69: <code>countdowns read in the largest two units</code> | DELETE | Fails independent-contract/refactor-resistance: hypothetical invalid-price fallback or incidental rounding, unit phrasing and sentence formatting is copied from implementation. Real duration/cost conversion and hourly quoted amount/unit remain; these display helpers retain production callers. Oracle: <code>assert.equal(formatCountdown(at((4 * 24 + 6) * 3_600_000 + 59_000), now), &quot;4d 6h left&quot;); assert.equal(formatCountdown(at((3 * 60 + 12) * 60_000), now), &quot;3h 12m left&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/boxes/format.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/boxes/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md (costs, $/h, UI plugin lifecycle); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** VM state/credential response validation, provider offers, config-change decisions, billed-box visibility, and honest rate/cost data. A stale destroy/decision answer can undo a newer event, unsafe credential links can be rendered, a billed running box can disappear, or rates/costs can show the wrong amount or unit.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** boxes/store.ts, validate.ts, format.ts; box surfaces, RunsOnRow, settings, sidebar and app event router.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon provisioning cannot protect UI convergence or credential-link sanitization; display prose without an independent formatting requirement is deleted; retained numeric contracts identify actual money or duration conversions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L85: <code>keeps a well-formed box as it is</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeBoxSummary(box()), box())</code> |
| L89: <code>drops a box it cannot reason about</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeBoxSummary(null), null); assert.equal(sanitizeBoxSummary([]), null)</code> |
| L99: <code>repairs bad optional fields one by one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(clean); assert.equal(clean.providerLabel, &quot;hetzner&quot;)</code> |
| L127: <code>rejects a broken list envelope and recomputes missing totals</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeBoxesResponse({ boxes: &quot;nope&quot; }), null); assert.equal(sanitizeBoxesResponse(null), null)</code> |
| L138: <code>reads a config change set, leaving out files that do not read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeBoxConfigChangeSet(change()), change()); assert.deepEqual(set?.files, files)</code> |
| L147: <code>reads the Global MCP servers&#x27; Run in box settings</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeBoxMcpRunInBoxResponse({ servers: &quot;nope&quot; }), null); assert.deepEqual(response, { servers: [ { agent: &quot;claude&quot;, name: &quot;jira&quot;, runInBox: true }, { agent: &quot;codex&quot;, name: &quot;jira&quot;, runInBox: false } ] })</code> |
| L169: <code>narrows a destroyed reason to the ones this build knows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(readDestroyedReason(&quot;provider-gone&quot;), &quot;provider-gone&quot;); assert.equal(readDestroyedReason(&quot;meteor&quot;), null)</code> |
| L175: <code>only links http(s) URLs and masks fields of unknown secrecy</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(clean); assert.equal(clean.credentialsUrl, &quot;&quot;)</code> |
| L200: <code>drops offers for another provider or kind, and sizes rented nowhere</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeBoxOffersResponse(offers(), &quot;vultr&quot;, &quot;linux&quot;), null); assert.equal(sanitizeBoxOffersResponse(offers(), &quot;hetzner&quot;, &quot;windows&quot;), null)</code> |
| L228: <code>loads every slot the plugin needs</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state.boxes?.map((entry) =&gt; entry.id), [&quot;b1&quot;]); assert.deepEqual(state.totals, TOTALS)</code> |
| L240: <code>rejects a list in another shape and keeps what it holds</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(loadBoxesList(bad.api), /unexpected shape/); assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;b1&quot;])</code> |
| L248: <code>applies each event type and ignores malformed or unknown ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;x&quot;]); assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;x&quot;])</code> |
| L263: <code>drops a load&#x27;s answer when an event overtook it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.id), [&quot;newer&quot;])</code> |
| L273: <code>drops answers that arrive after a reset, and resets for another connection</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes, null); assert.equal(boxesStore.getState().boxes?.length, 1)</code> |
| L292: <code>applies a destroy&#x27;s answer to its box, and reloads when the answer is unreadable</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes?.[0].state, &quot;destroying&quot;); assert.ok(silent.calls.includes(&quot;listBoxes&quot;))</code> |
| L304: <code>refuses a destroy the daemon refuses, leaving the box as it was</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(destroyBox(api, &quot;b1&quot;), /409/); assert.equal(boxesStore.getState().boxes?.[0].state, &quot;ready&quot;)</code> |
| L315: <code>saving credentials upserts the provider and re-reads the kinds that were loaded</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(saved?.id, &quot;vultr&quot;); assert.deepEqual(boxesStore.getState().providers?.map((entry) =&gt; entry.id), [&quot;hetzner&quot;, &quot;vultr&quot;])</code> |
| L328: <code>a provider change event drops cached offers and re-reads the kinds</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(calls.filter((call) =&gt; call.startsWith(&quot;offers:&quot;)).length, 1); assert.ok(calls.includes(&quot;listBoxKinds&quot;))</code> |
| L342: <code>shares an offers read in flight and rejects one in another shape</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(await a, await b); assert.equal(calls.filter((call) =&gt; call.startsWith(&quot;offers:&quot;)).length, 1)</code> |
| L355: <code>marks a Windows image as preparing at once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().providers?.[0].windowsImage?.state, &quot;preparing&quot;); assert.equal(boxesStore.getState().providers?.[0].windowsImage?.message, &quot;Building&quot;)</code> |
| L374: <code>connection answers are validated, and a decision updates its change set</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(settings.mode, &quot;tailscale&quot;); assert.equal(settings.tailscale.configured, true)</code> |
| L410: <code>drops a destroy&#x27;s answer an event overtook, and re-reads the list instead</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes?.[0].state, &quot;destroyed&quot;); assert.ok(calls.includes(&quot;listBoxes&quot;))</code> |
| L428: <code>drops a decision&#x27;s answer an event overtook, and an older connection answer than the newer save&#x27;s</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(answered?.state, &quot;approved&quot;); assert.equal(boxesStore.getState().configChanges?.[0].state, &quot;denied&quot;)</code> |
| L461: <code>with the plugin off, keeps only the boxes still running and lets them be destroyed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state.boxes?.map((entry) =&gt; entry.id), [&quot;p1&quot;, &quot;t1&quot;, &quot;gone&quot;]); assert.equal(state.providers, null)</code> |
| L492: <code>with the plugin off, a read that finds nothing running holds nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(boxesStore.getState().boxes, null); assert.deepEqual(boxesStore.getState().boxes?.map((entry) =&gt; entry.state), [&quot;destroy-failed&quot;])</code> |
| L507: <code>finds a project&#x27;s box: the live one, else the latest destroyed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(projectBoxIn([gone1, gone2], path)?.id, &quot;g2&quot;); assert.equal(projectBoxIn([gone1, temp, live, gone2], path)?.id, &quot;live&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/boxes/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/chat-prefs.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (composer follow-ups and permission modes); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Client chat preferences migrate field-wise and only supported permission modes reach launch defaults. Old or malformed storage can enable an unsupported mode, erase valid choices or break composer defaults.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** chat-prefs.ts; app/composer launch callers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon config cannot protect per-device localStorage parsing and per-agent selection fallback. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L18: <code>a missing or non-object blob falls back whole</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(load(undefined), { followUpBehavior: &quot;steer&quot;, showSkillsInSlashMenu: true, runtimeModeByAgent: {} }); assert.deepEqual(load(null), { followUpBehavior: &quot;steer&quot;, showSkillsInSlashMenu: true, runtimeModeByAgent: {} })</code> |
| L25: <code>a blob from an older bundle keeps the fields it does have</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(prefs.followUpBehavior, &quot;queue&quot;); assert.equal(prefs.showSkillsInSlashMenu, true)</code> |
| L32: <code>wrong-typed fields are dropped, not coerced</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(prefs, { followUpBehavior: &quot;steer&quot;, showSkillsInSlashMenu: true, runtimeModeByAgent: {} })</code> |
| L41: <code>only known permission modes survive the per-agent map</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(prefs.runtimeModeByAgent, { claude: &quot;full-access&quot; })</code> |
| L48: <code>an agent with no remembered mode gets the full-access default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(runtimeModeForAgent(prefs, &quot;claude&quot;), &quot;auto&quot;); assert.equal(runtimeModeForAgent(prefs, &quot;codex&quot;), &quot;full-access&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/chat-prefs.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/collapsed-repo-groups.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §1; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Collapsed repository keys survive storage only when valid and remain bounded. An obsolete/malformed blob can hide the wrong groups or accumulate an unbounded key set.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** collapsed-repo-groups.ts; sidebar group state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Repository-key API tests do not own this storage-envelope parsing, deduplication and cap; the oversized fixture now uses the first value beyond the bound. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L8: <code>a stored JSON list of repo keys is the collapsed set</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(keys(JSON.stringify([&quot;github.com/o/a&quot;, &quot;gitlab.com/g/sub/b&quot;])), [ &quot;github.com/o/a&quot;, &quot;gitlab.com/g/sub/b&quot; ]); assert.deepEqual(keys(JSON.stringify([&quot;github.com/o/a&quot;, &quot;github.com/o/a&quot;])), [&quot;github.com/o/a&quot;])</code> |
| L16: <code>anything that is not a list of repo keys starts every group expanded</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(keys(raw), [])</code> |
| L22: <code>entries that are not repo keys are dropped, the rest kept</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(keys(raw), [&quot;github.com/o/a&quot;, &quot;github.com/o/b&quot;])</code> |
| L38: <code>a runaway list is bounded</code> | OPTIMIZE | Reduces 2000 generated keys to 501, the smallest fixture that crosses the 500-key persisted-data bound; the same cap assertion remains. Oracle: <code>assert.equal(parseCollapsedRepoGroups(JSON.stringify(many)).size, 500)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/collapsed-repo-groups.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/composer-inbox.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.4,7.7.

**Contract / recognizable regressions (2):** Design feedback/attachments land once in the target composer draft before/after mount, without crossing sessions. A delivery can vanish before mount, replay after mount, cross sessions, survive a closed tab, or lose current absolute attachment paths.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** composer-inbox.ts; browser picker/file drops and composer mount consume it.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Composer submission tests begin with a draft and cannot protect delivery/mount queuing or the legacy id/current path fallback boundary. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L8: <code>a delivery made before the composer mounts is waiting for it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( takeComposerDeliveries(&quot;s1&quot;).map((d) =&gt; d.text), [&quot;one&quot;, &quot;two&quot;] ); assert.deepEqual(takeComposerDeliveries(&quot;s1&quot;), [])</code> |
| L20: <code>a mounted composer receives deliveries directly and nothing queues</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(seen, [&quot;live&quot;]); assert.deepEqual(takeComposerDeliveries(&quot;s2&quot;), [])</code> |
| L30: <code>after unsubscribing, deliveries queue again</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( takeComposerDeliveries(&quot;s3&quot;).map((d) =&gt; d.text), [&quot;later&quot;] )</code> |
| L41: <code>deliveries are per session and never cross</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(takeComposerDeliveries(&quot;s5&quot;), []); assert.equal(takeComposerDeliveries(&quot;s4&quot;).length, 1)</code> |
| L49: <code>clearing a closed tab drops what was queued for it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(takeComposerDeliveries(&quot;s6&quot;), [])</code> |
| L56: <code>a delivery becomes draft text plus one attachment path per line</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( composerTextForDelivery({ text: &quot;Fix this button&quot;, attachments: [ { type: &quot;image&quot;, id: &quot;/up/a.png&quot;, name: &quot;a.png&quot;, mimeType: &quot;image/png&quot;, sizeBytes: 1 }, { type: &quot;file&quot;, id: &quot;/up/b.txt&quot;, name: &quot;b.txt&quot;, sizeBytes: 2 }</code> |
| L72: <code>either half alone stands on its own, and an empty delivery is empty text</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(composerTextForDelivery({ text: &quot;just words&quot;, attachments: [] }), &quot;just words&quot;); assert.equal( composerTextForDelivery({ text: &quot;&quot;, attachments: [{ type: &quot;file&quot;, id: &quot;/up/a&quot;, name: &quot;a&quot;, sizeBytes: 1 }] }), &quot;/up/a&quot; )</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/composer-inbox.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/connection/backoff.test.ts

**Independent source (1):** README.md (remote transports, sign-in, reconnect and secret handling); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Failure classification, safe diagnostics, reconnect scheduling, protocol mismatch and WebSocket health. A refused/TLS/HTTP failure can offer the wrong remedy, copied diagnostics can disclose credentials, a cancelled retry can redial, or a wake can run twice.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** connection/failure.ts, connection-log.ts, backoff.ts, diagnosis.logic.ts, probes.ts; app connection loop and diagnostics UI.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Transport/server tests do not exercise client classification of IPC/browser errors, diagnostics redaction, or lifecycle of scheduled wake callbacks; source-derived timing/limit expectations are removed. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L14: <code>doubles from the base up to the cap</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( [0, 1, 2, 3, 4, 5].map((attempt) =&gt; backoffCeilingMs(attempt, policy)), [500, 1_000, 2_000, 4_000, 4_000, 4_000] )</code> |
| L22: <code>a long outage stays capped at 30 seconds</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(backoffCeilingMs(5_000), 30_000)</code> |
| L28: <code>spreads the delay over the whole window (full jitter)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(backoffDelayMs(3, policy, () =&gt; 0), 0); assert.equal(backoffDelayMs(3, policy, () =&gt; 0.5), 4_000)</code> |
| L38: <code>runs after the delay, once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(runs, []); assert.deepEqual(runs, [false])</code> |
| L51: <code>a wake fires every pending retry at once and says so</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(runs, [&quot;a:true&quot;, &quot;b:true&quot;]); assert.equal(runs.length, 2, &quot;the timers were cleared&quot;)</code> |
| L62: <code>a cancelled retry never runs</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(ran, false)</code> |
| L74: <code>a retry scheduled during a wake waits for the next one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(runs, [], &quot;no tight loop inside one wake&quot;); assert.deepEqual(runs, [true])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/connection/backoff.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/connection/connection-log.test.ts

**Independent source (1):** README.md (remote transports, sign-in, reconnect and secret handling); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Failure classification, safe diagnostics, reconnect scheduling, protocol mismatch and WebSocket health. A refused/TLS/HTTP failure can offer the wrong remedy, copied diagnostics can disclose credentials, a cancelled retry can redial, or a wake can run twice.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** connection/failure.ts, connection-log.ts, backoff.ts, diagnosis.logic.ts, probes.ts; app connection loop and diagnostics UI.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Transport/server tests do not exercise client classification of IPC/browser errors, diagnostics redaction, or lifecycle of scheduled wake callbacks; source-derived timing/limit expectations are removed. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L22: <code>keeps the last failure and a capped, deduplicated history</code> | REWRITE | Uses 25 independently supplied events and observes bounded retained history/newest detail, rather than importing the implementation limit to generate inputs and expectations. Deduplication counts and last failure remain. Oracle: <code>assert.deepEqual(log.lastFailure, { kind: &quot;timeout&quot;, detail: &quot;y&quot;, at: 3 }); assert.deepEqual( log.recent.map((entry) =&gt; [entry.kind, entry.count, entry.at]), [ [&quot;refused&quot;, 2, 2], [&quot;timeout&quot;, 1, 3] ] )</code> |
| L42: <code>a connect clears the explanation, keeps the history, and restarts the WebSocket count</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getConnectionLog().ws[WS]?.failures, 2); assert.equal(log.lastFailure, null)</code> |
| L60: <code>records what the daemon says about itself</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getConnectionLog().serverProtocol, 2); assert.equal(getConnectionLog().serverProtocol, 1)</code> |
| L71: <code>notifies subscribers with a new snapshot</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(calls, 1); assert.notEqual(getConnectionLog(), before)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/connection/connection-log.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/connection/diagnosis.logic.test.ts

**Independent source (1):** README.md (remote transports, sign-in, reconnect and secret handling); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Failure classification, safe diagnostics, reconnect scheduling, protocol mismatch and WebSocket health. A refused/TLS/HTTP failure can offer the wrong remedy, copied diagnostics can disclose credentials, a cancelled retry can redial, or a wake can run twice.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** connection/failure.ts, connection-log.ts, backoff.ts, diagnosis.logic.ts, probes.ts; app connection loop and diagnostics UI.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Transport/server tests do not exercise client classification of IPC/browser errors, diagnostics redaction, or lifecycle of scheduled wake callbacks; source-derived timing/limit expectations are removed. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L58: <code>says nothing while healthy or still starting up</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(diagnose({ status: &quot;connected&quot;, attempt: 0 }), null); assert.equal(diagnose({ status: &quot;connecting&quot;, attempt: 0, log: log({ lastFailure: failure(&quot;refused&quot;) }) }), null)</code> |
| L64: <code>classifies failures and offers sign-in only for an unauthorized response</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(diagnosis, kind); assert.equal(diagnosis.kind, kind)</code> |
| L88: <code>an offline device beats whatever the last failure said</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(diagnose({ online: false, log: log({ lastFailure: failure(&quot;dns&quot;) }) })?.kind, &quot;offline&quot;)</code> |
| L92: <code>a failure right after the daemon announced a stop is a restart</code> | REWRITE | Removes imported implementation thresholds and incidental report headline/copy. Fixed causal times, a single versus repeatedly failing WS, diagnosis/action/status data, server facts and credential redaction remain. Oracle: <code>assert.equal(restarting?.kind, &quot;restarting&quot;); assert.equal( diagnose({ log: log({ stoppingAt, lastFailure: failure(&quot;proxy-down&quot;, { at: NOW - 3_000, status: 502 }) }) })?.kind, &quot;restarting&quot; )</code> |
| L114: <code>the lockout headline is the store&#x27;s countdown</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(diagnosis?.headline, &quot;Too many attempts — locked out, retry in 60s.&quot;)</code> |
| L124: <code>warns, while connected, about a protocol mismatch either way</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(newer?.kind, &quot;client-outdated&quot;); assert.equal(newer?.severity, &quot;warn&quot;)</code> |
| L135: <code>warns when HTTP works but the WebSocket keeps closing</code> | REWRITE | Removes imported implementation thresholds and incidental report headline/copy. Fixed causal times, a single versus repeatedly failing WS, diagnosis/action/status data, server facts and credential redaction remain. Oracle: <code>assert.equal(diagnose({ status: &quot;connected&quot;, attempt: 0, log: log({ ws: ws(WS_BLOCKED_AFTER - 1) }) }), null); assert.equal(blocked?.kind, &quot;ws-blocked&quot;)</code> |
| L148: <code>reports the server, client, checks and timestamped errors, never a token</code> | REWRITE | Removes imported implementation thresholds and incidental report headline/copy. Fixed causal times, a single versus repeatedly failing WS, diagnosis/action/status data, server facts and credential redaction remain. Oracle: <code>assert.ok(!text.includes(credential), text); assert.ok(!text.includes(&quot;pw@&quot;), text)</code> |
| L180: <code>the HTTP check accepts only an Orquester health answer</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await probeHttp(async () =&gt; ({ ok: true, service: &quot;orquester&quot;, protocol: 1 }))).outcome, &quot;ok&quot;); assert.equal(html.outcome, &quot;failed&quot;)</code> |
| L191: <code>the HTTP check gives up after its timeout</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(timeoutSignal.aborted, false); assert.equal(result.outcome, &quot;failed&quot;)</code> |
| L219: <code>the WebSocket check opens, closes again, and never reports the URL</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.outcome, &quot;ok&quot;); assert.equal(socket.closed, true)</code> |
| L234: <code>the WebSocket check reports a close code, a timeout, and skips without a WebSocket</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(closed.outcome, &quot;failed&quot;); assert.match(closed.summary, /code 1006/)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/connection/diagnosis.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/connection/failure.test.ts

**Independent source (1):** README.md (remote transports, sign-in, reconnect and secret handling); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Failure classification, safe diagnostics, reconnect scheduling, protocol mismatch and WebSocket health. A refused/TLS/HTTP failure can offer the wrong remedy, copied diagnostics can disclose credentials, a cancelled retry can redial, or a wake can run twice.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** connection/failure.ts, connection-log.ts, backoff.ts, diagnosis.logic.ts, probes.ts; app connection loop and diagnostics UI.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Transport/server tests do not exercise client classification of IPC/browser errors, diagnostics redaction, or lifecycle of scheduled wake callbacks; source-derived timing/limit expectations are removed. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L21: <code>names the network cause from a system error code</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(nodeFetchError(&quot;ENOTFOUND&quot;)), &quot;dns&quot;); assert.equal(kindOf(nodeFetchError(&quot;EAI_AGAIN&quot;)), &quot;dns&quot;)</code> |
| L33: <code>names it from the text the desktop bridge and Chromium report</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(ipc(&quot;getaddrinfo ENOTFOUND orq.example.com&quot;)), &quot;dns&quot;); assert.equal(kindOf(ipc(&quot;connect ECONNREFUSED 10.0.0.2:7420&quot;)), &quot;refused&quot;)</code> |
| L45: <code>an opaque browser fetch failure is &#x27;unreachable&#x27;, or &#x27;offline&#x27; without a network</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(new TypeError(&quot;Failed to fetch&quot;)), &quot;unreachable&quot;); assert.equal(kindOf(new TypeError(&quot;NetworkError when attempting to fetch resource.&quot;)), &quot;unreachable&quot;)</code> |
| L53: <code>an abort or timeout is a timeout</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(Object.assign(new Error(&quot;aborted&quot;), { name: &quot;AbortError&quot; })), &quot;timeout&quot;); assert.equal(kindOf(Object.assign(new Error(&quot;timed&quot;), { name: &quot;TimeoutError&quot; })), &quot;timeout&quot;)</code> |
| L58: <code>reads the HTTP status of an answer</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(api(401)), &quot;unauthorized&quot;); assert.equal(kindOf(api(429)), &quot;locked&quot;)</code> |
| L70: <code>a non-JSON or non-Orquester answer is &#x27;not-orquester&#x27;, unless a proxy says the daemon is down</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(kindOf(new UnexpectedResponseError(200, &quot;text/html&quot;)), &quot;not-orquester&quot;); assert.equal(kindOf(new UnexpectedResponseError(502, &quot;text/html&quot;)), &quot;proxy-down&quot;)</code> |
| L77: <code>anything else is &#x27;unknown&#x27;, with its text redacted</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(failure, { kind: &quot;unknown&quot;, detail: &quot;weird Bearer [redacted]&quot;, at: 5 })</code> |
| L84: <code>accepts an Orquester answer, including one from a daemon that predates the marker</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(checkHealth({ ok: true, service: &quot;orquester&quot;, protocol: 1 }), { ok: true, service: &quot;orquester&quot;, protocol: 1 }); assert.deepEqual(checkHealth({ ok: true }), { ok: true })</code> |
| L93: <code>refuses anything else</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.throws(() =&gt; checkHealth(value), NotOrquesterError, JSON.stringify(value))</code> |
| L101: <code>strips every credential shape from text</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(!out.includes(credential), out); assert.ok(!out.includes(encodeURIComponent(credential)), out)</code> |
| L120: <code>leaves ordinary diagnostics alone</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(redactSecrets(text), text)</code> |
| L125: <code>drops userinfo, query and fragment from the server URL</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(redactUrl(&quot;https://me:pw@orq.example.com:8443/app?token=abc#x&quot;), &quot;https://orq.example.com:8443/app&quot;); assert.equal(redactUrl(&quot;unix:///tmp/orq.sock&quot;), &quot;unix:///tmp/orq.sock&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/connection/failure.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/copy-produced.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.6; WebKit Async Clipboard gesture requirement.

**Contract / recognizable regressions (2):** Copy starts during the gesture even when full text is still loading; rejected reads/writes do not become unhandled rejections. Safari can refuse a delayed write, a failed full-text read can copy truncated data, or simultaneous read/write rejection can crash the page.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** copy-produced.ts; CopyButton passes the actual clipboard and ClipboardItem.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** The clipboard fake records real platform calls and reads the Blob promise; it does not implement copyProduced’s gesture/order/error behavior. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L38: <code>a string is written with writeText at once, inside the click</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(log.writeTextCalls, [&quot;fix the tests&quot;]); assert.equal(log.items.length, 0, &quot;a string never needs a ClipboardItem&quot;)</code> |
| L47: <code>a text still being read starts write() inside the click, and copies it once read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(log.items.length, 1, &quot;write() began within the call, before any await&quot;); assert.equal(await blob.text(), &quot;# Ship it\n\nevery step&quot;)</code> |
| L62: <code>without ClipboardItem, or without write(), a text being read falls back to writeText once read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(log.writeTextCalls, [], `${label}: there is no text to write yet`); assert.deepEqual(log.writeTextCalls, [&quot;# Ship it&quot;], `${label}: written after the await`)</code> |
| L78: <code>a read that fails copies nothing down either path, and never the cut text</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects( copyProduced(Promise.reject(new Error(&quot;read failed&quot;)), fallback.clipboard), /read failed/ ); assert.deepEqual(fallback.log.writeTextCalls, [])</code> |
| L92: <code>a write refused without reading its item leaves nothing unhandled when the read fails too</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(copyProduced(read.promise, clipboard, RecordedClipboardItem), /not focused/); assert.rejects(read.promise, /could not be loaded/)</code> |
| L132: <code>with no async clipboard at all (an insecure origin) nothing is copied, and a failing read is still observed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(copyProduced(&quot;fix the tests&quot;, undefined, FakeClipboardItem), /clipboard.*not available/i); assert.rejects(copyProduced(failed, undefined, FakeClipboardItem), /could not be loaded/)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/copy-produced.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-audio/controller.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§8.2,13.3.

**Contract / recognizable regressions (2):** Desktop audio packet decoding/routing, stream lifecycle, jitter/drift bounds, fades, and target adaptation. Audio can leak from inactive/muted tabs, old sockets can survive token changes, packet framing can corrupt audio, clock drift can accumulate latency, or discontinuities can click.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-audio/controller.ts and jitter-buffer.ts; DesktopView and the AudioWorklet consume them.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Controller tests own byte/lifecycle integration; pure jitter tests own audio-policy and signal continuity. The mandatory ±100 ppm two-hour simulation stays; short signal tests uniquely check audible output. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L130: <code>the controller streams only with an active unlocked unmuted tab and a URL</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isOpen(h.current), true); assert.equal(h.current?.binaryType, &quot;arraybuffer&quot;)</code> |
| L143: <code>staying in the playing state keeps the one socket</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(h.sockets.length, 1); assert.ok(isOpen(h.current))</code> |
| L152: <code>a new url (fresh token) replaces the socket</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(h.sockets.length, 2); assert.equal(h.sockets[0]!.closedWith, 1000)</code> |
| L161: <code>no socket without a usable decoder; none until detection finishes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(none.sockets.length, 0); assert.equal(none.controller.getSnapshot().decoder, &quot;none&quot;)</code> |
| L180: <code>volume drives the gain; mute zeroes it and closes the socket</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(h.volumes, [0.8], &quot;the GainNode starts at the volume&quot;); assert.equal(h.volumes.at(-1), 0.25)</code> |
| L196: <code>audio packet headers deliver unsigned big-endian sequences and reject invalid frames</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(h.decoders[0]!.decoded, [0x01020304, 5, 0xffffffff]); assert.deepEqual(h.decoders[0]!.payloads, [[9, 8, 7], [6], [5]])</code> |
| L211: <code>audio state messages reach the viewer and malformed messages leave it unchanged</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(h.controller.getSnapshot().serverState, { type: &quot;state&quot;, audio: &quot;unavailable&quot;, reason: &quot;no pulse&quot;, sampleRate: 48000, channels: 2, frameMs: 10 }); assert.equal(before?.audio, &quot;available&quot;)</code> |
| L225: <code>packets reach the decoder in order and a seq gap inserts nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(decoder.decoded, [10, 11, 14, 15]); assert.deepEqual(decoder.payloads, [[10], [11], [14], [15]])</code> |
| L238: <code>decoded frames wait for the player, then flow; closing disposes both</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(player.pushed, [early]); assert.equal(player.pushed.length, 2)</code> |
| L262: <code>keepalive pings every 10 s and drops a silent connection</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(socket.sent, [&#x27;{&quot;type&quot;:&quot;ping&quot;}&#x27;]); assert.equal(socket.sent.length, 2)</code> |
| L282: <code>an unexpected close reconnects with growing backoff; data resets it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(h.controller.getSnapshot().error?.includes(&quot;desktop not running&quot;)); assert.equal(h.sockets.length, 1)</code> |
| L309: <code>a wake (back online, tab visible) reconnects at once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(h.sockets.length, before + 1)</code> |
| L324: <code>pausing cancels a pending reconnect</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(h.sockets.length, 1); assert.equal(h.controller.getSnapshot().error, null)</code> |
| L335: <code>a decoder error tears the stream down and retries</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(h.controller.getSnapshot().error, &quot;The audio decoder failed: boom&quot;); assert.equal(isOpen(h.sockets[0]), false)</code> |
| L350: <code>dispose closes everything and a later update reopens (StrictMode remount)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isOpen(h.sockets[0]), false); assert.equal(h.sockets.length, 2)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-audio/controller.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-audio/jitter-buffer.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§8.2,13.3.

**Contract / recognizable regressions (2):** Desktop audio packet decoding/routing, stream lifecycle, jitter/drift bounds, fades, and target adaptation. Audio can leak from inactive/muted tabs, old sockets can survive token changes, packet framing can corrupt audio, clock drift can accumulate latency, or discontinuities can click.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-audio/controller.ts and jitter-buffer.ts; DesktopView and the AudioWorklet consume them.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Controller tests own byte/lifecycle integration; pure jitter tests own audio-policy and signal continuity. The mandatory ±100 ppm two-hour simulation stays; short signal tests uniquely check audible output. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L102: <code>+100 ppm drift over 2 simulated hours keeps depth ≤ target + 40 ms</code> | OPTIMIZE | Preserves the full simulated duration, packet schedule, render-frame clock and every stats assertion; skips unused PCM output writes, with waveform/crossfade checks still using recorded stereo samples. The stable fixture reuses silence instead of generating unasserted sine waves. Oracle: <code>assert.ok(result.maxExcessFrames &lt;= MARGIN_FRAMES, `depth exceeded target by ${result.maxExcessFrames} frames`); assert.ok(stats.drops &gt;= 60, `drops ${stats.drops}`)</code> |
| L102: <code>-100 ppm drift over 2 simulated hours keeps depth ≤ target + 40 ms</code> | OPTIMIZE | Preserves the full simulated duration, packet schedule, render-frame clock and every stats assertion; skips unused PCM output writes, with waveform/crossfade checks still using recorded stereo samples. The stable fixture reuses silence instead of generating unasserted sine waves. Oracle: <code>assert.ok(result.maxExcessFrames &lt;= MARGIN_FRAMES, `depth exceeded target by ${result.maxExcessFrames} frames`); assert.ok(stats.drops &gt;= 60, `drops ${stats.drops}`)</code> |
| L118: <code>a burst after a 300 ms stall recovers without growing latency</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(stats.underruns, 1); assert.equal(stats.targetMs, 40)</code> |
| L141: <code>underruns raise the target by 10 ms up to 150 ms</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(buffer.stats().targetMs, target); assert.equal(buffer.stats().targetMs, 150)</code> |
| L165: <code>stable periods lower the target by 5 ms per 30 s down to 20 ms</code> | OPTIMIZE | Preserves the full simulated duration, packet schedule, render-frame clock and every stats assertion; skips unused PCM output writes, with waveform/crossfade checks still using recorded stereo samples. The stable fixture reuses silence instead of generating unasserted sine waves. Oracle: <code>assert.equal(buffer.stats().targetMs, 55); assert.equal(buffer.stats().targetMs, 20)</code> |
| L185: <code>an overflow drop crossfades instead of stepping</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(stats.drops &gt; 0, &quot;the burst triggered a drop&quot;); assert.equal(stats.underruns, 0)</code> |
| L198: <code>an underrun ramps to silence and the restart fades in</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(buffer.stats().underruns, 1); assert.ok(maxStep(result.output[0]!) &lt;= SMOOTH_STEP, `step ${maxStep(result.output[0]!)}`)</code> |
| L210: <code>underrun partway through a fade-in blends from the ramp instead of jumping</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(maxStep(Float32Array.from(signal)) &lt;= 0.02, `step ${maxStep(Float32Array.from(signal))}`)</code> |
| L231: <code>a mono packet plays on both channels</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(out[0]![QUANTUM * 3], 0.25); assert.equal(out[1]![QUANTUM * 3], 0.25)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-audio/jitter-buffer.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-host-nav.test.ts

**Independent source (1):** README.md desktop/web push navigation; packages/api/src/index.ts and packages/api/src/agent-chat wire contracts.

**Contract / recognizable regressions (2):** Native notification targets use the matching deferred deep link and only the displayed session counts as viewed. A notification can open the wrong project/workflow, or a chat covered by Knowledge can be treated as seen.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-host-nav.ts; DesktopNotifications and shared app store.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Pure notification selection and deep-link resolution do not protect this app-store-to-deep-link integration. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L28: <code>knows the tab on screen</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(viewingSessionId(), &quot;c1&quot;); assert.equal(viewingSessionId(), &quot;s1&quot;)</code> |
| L36: <code>sees no tab while the Knowledge view covers it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(viewingSessionId(), null); assert.equal(viewingSessionId(), &quot;c1&quot;)</code> |
| L43: <code>opens a session through the session deep link</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(takeSessionDeepLink(), { sessionId: &quot;c2&quot; }); assert.equal(takeWorkflowDeepLink(), null)</code> |
| L49: <code>opens a workflow run through the workflow deep link</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(takeWorkflowDeepLink(), { workflowId: &quot;w1&quot;, runId: &quot;r1&quot; }); assert.equal(takeSessionDeepLink(), null)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-host-nav.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-host.test.ts

**Independent source (1):** README.md attention notifications; packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Desktop bridge/push parsing, focus-aware notifications, click targets and attention badges. Malformed bridge data can trigger actions, visible sessions can spam notifications, hidden sessions can go silent or the badge can miss attention.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-host.ts; Electron preload/native notifications integration.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Electron native-shell tests do not own the renderer’s filtering/validation and focus context; each row targets a separate protocol or notification decision. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L39: <code>shows every push while the window is unfocused, each with its click target</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(desktopNotificationFor(sessionPush, away), { title: sessionPush.title, body: &quot;&quot;, tag: &quot;session-c1&quot;, target: { kind: &quot;session&quot;, sessionId: &quot;c1&quot; } }); assert.deepEqual(desktopNotificationFor(workflowPush, away)?.target, { kind: &quot;workflow&quot;, workflowId: &quot;w1&quot;, runId: &quot;r1&quot; })</code> |
| L55: <code>stays quiet about the session the user is looking at, but not about another one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(desktopNotificationFor(sessionPush, here(&quot;c1&quot;)), null); assert.equal(desktopNotificationFor(sessionPush, here(&quot;c2&quot;))?.tag, &quot;session-c1&quot;)</code> |
| L63: <code>leaves a workflow run to the in-app toast while the window has focus</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(desktopNotificationFor(workflowPush, here(null)), null)</code> |
| L67: <code>always shows a push that names nothing, and nothing at all when turned off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(desktopNotificationFor(scriptPush, here(&quot;c1&quot;))?.title, &quot;Backup done&quot;); assert.equal(desktopNotificationFor(push, { ...away, enabled: false }), null)</code> |
| L81: <code>counts sessions blocked on the user and unseen ends, not seen ends, busy or idle ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(desktopBadgeCount([]), 0); assert.equal( desktopBadgeCount([ entry(&quot;attention&quot;, &quot;needs-input&quot;), entry(&quot;attention&quot;, &quot;finished&quot;), // A question or approval the user has looked at still waits on them. entry(&quot;attention&quot;), entry(&quot;finished&quot;, &quot;finished&quot;), entry(&quot;f</code> |
| L101: <code>parses a push event field by field, capping its text and dropping malformed ids</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePushNotificationEvent({ ...sessionPush, extra: 1 }), sessionPush); assert.deepEqual(parsePushNotificationEvent(workflowPush), workflowPush)</code> |
| L117: <code>refuses a push it could not show</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parsePushNotificationEvent(payload), null, JSON.stringify(payload))</code> |
| L132: <code>parses a clicked notification&#x27;s target and a menu action strictly</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseNotificationTarget({ kind: &quot;session&quot;, sessionId: &quot;c1&quot; }), { kind: &quot;session&quot;, sessionId: &quot;c1&quot; }); assert.deepEqual(parseNotificationTarget({ kind: &quot;workflow&quot;, workflowId: &quot;w1&quot;, runId: &quot;r 1&quot; }), { kind: &quot;workflow&quot;, workflowId: &quot;w1&quot;, runId: null })</code> |
| L147: <code>feeds valid push events from the push channel to the listeners until they unsubscribe</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(heard, [sessionPush])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-host.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-prefs.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§10.5,13.3; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Per-desktop persisted volume/view preferences keep touch defaults and validate each field. A corrupt blob can crash viewing, another desktop can inherit the volume, touch devices can lose usable dimensions, or closed desktops can leave stale prefs.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-prefs.ts; DesktopView menus and lifecycle.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon size validation cannot protect per-device defaults, localStorage keys or remembered fixed-size restoration; dimensions are an explicit configuration contract. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L43: <code>non-touch default is fit, unmuted, full volume</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(readDesktopPrefs(&quot;d1&quot;), { muted: false, volume: 1, view: &quot;fit&quot; })</code> |
| L48: <code>touch default is fixed 1280×800, scaled</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(readDesktopPrefs(&quot;d1&quot;), { muted: false, volume: 1, view: &quot;fixed&quot;, fixedSize: { width: 1280, height: 800 }, fixedMode: &quot;scale&quot; })</code> |
| L59: <code>write then read round-trips under orq.desktop.prefs.&lt;id&gt;</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(storage.getItem(&quot;orq.desktop.prefs.abc&quot;)); assert.deepEqual(readDesktopPrefs(&quot;abc&quot;), prefs)</code> |
| L68: <code>clear removes the key</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(storage.getItem(&quot;orq.desktop.prefs.abc&quot;), null)</code> |
| L75: <code>corrupt JSON falls back to the device default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(readDesktopPrefs(&quot;x&quot;).view, &quot;fixed&quot;)</code> |
| L81: <code>invalid fields fall back one by one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadStored({ muted: &quot;yes&quot;, volume: 3, view: &quot;zoom&quot; }, false), { muted: false, volume: 1, view: &quot;fit&quot; }); assert.deepEqual(loadStored({ muted: true, volume: -0.1, view: &quot;fit&quot; }, false), { muted: true, volume: 1, view: &quot;fit&quot; })</code> |
| L97: <code>a fixed view always gets a valid size and mode</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadStored({ view: &quot;fixed&quot;, fixedSize: { width: 99999, height: 800 }, fixedMode: &quot;zoom&quot; }, false), { muted: false, volume: 1, view: &quot;fixed&quot;, fixedSize: { width: 1280, height: 800 }, fixedMode: &quot;scale&quot; }); assert.deepEqual(loadStored({ view: &quot;fixed&quot;, fixedSize: { width: 1280.5, height: 800 } }, false).fixedSize, { width: 1280, height: 800 })</code> |
| L111: <code>fit keeps a remembered fixed choice for switching back</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(prefs, { muted: false, volume: 1, view: &quot;fit&quot;, fixedSize: { width: 1920, height: 1080 }, fixedMode: &quot;pan&quot; })</code> |
| L116: <code>works with no localStorage at all</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(readDesktopPrefs(&quot;d&quot;), { muted: false, volume: 1, view: &quot;fit&quot; })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-prefs.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-quality.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§11.2,13.3.

**Contract / recognizable regressions (2):** RTT quality changes follow specified streaks and recover without oscillating across threshold/intermediate samples. Congested streams can stay at high bandwidth, short spikes can lower quality, or recovering links can remain permanently degraded.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-quality.ts; DesktopView adaptive quality consumer.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** No daemon/WS test owns the client RTT policy; duplicated initial downgrade is consolidated into the complete bounded downgrade sequence. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L10: <code>3 consecutive slow samples step down one level</code> | CONSOLIDATE | Initial three-sample downgrade duplicates the complete downgrade sequence; the unique two-sample no-downgrade assertion moves into that survivor. Surviving owner: steps 6 → 4 → 2 and stops at 2. Oracle: <code>assert.equal(feed(s, [200, 200]).level, 6); assert.equal(feed(s, [200, 200, 200]).level, 4)</code> |
| L16: <code>steps 6 → 4 → 2 and stops at 2</code> | CONSOLIDATE | Survives as the single bounded downgrade owner, now asserting that two samples do not downgrade before testing the complete 6→4→2 floor sequence. Oracle: <code>assert.equal(s.level, 4); assert.equal(s.level, 2)</code> |
| L27: <code>the thresholds are strict: exactly 150 ms is not slow, exactly 50 ms is not fast</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(feed(s, [150, 150, 150]).level, 6); assert.equal(feed(low, [50, 50, 50, 50, 50]).level, 2)</code> |
| L34: <code>a sample in between breaks the streak</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(feed(s, [200, 200, 100, 200, 200]).level, 6); assert.equal(feed(low, [10, 10, 10, 10, 80, 10]).level, 2)</code> |
| L41: <code>5 consecutive fast samples step up one level, up to 6</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(s.level, 2); assert.equal(s.level, 4)</code> |
| L53: <code>a slow sample resets the fast streak and vice versa</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(feed(s, [10, 10, 10, 10, 300, 10]).level, 4); assert.equal(feed(s, [300, 300, 10, 300]).level, 4)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-quality.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-state.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§10.1,10.6; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Desktop wire validation/reducers, active-window title data and close-confirmation running-app data. Malformed desktop data can crash the client, a VM can lose its connection state, app upserts can duplicate, or confirmation can omit processes about to terminate.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-state.ts; shared app-store desktop reducer and DesktopView/tab close.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon route tests protect emitted records; these tests protect the client’s tolerant parser and list application; display checks assert selected data, not markup/copy snapshots. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L50: <code>a well-formed summary parses; unknown fields ride along</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parsed?.id, &quot;d1&quot;); assert.equal((parsed as unknown as { future: number }).future, 1)</code> |
| L56: <code>a VM desktop&#x27;s box and install progress are kept; a malformed one is dropped, not the desktop</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(vm?.box, { id: &quot;b1&quot;, connected: false }); assert.equal(vm?.statusDetail, &quot;Unpacking openbox&quot;)</code> |
| L67: <code>malformed summaries are refused</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parseDesktopSummary(null), null); assert.equal(parseDesktopSummary({ ...desktop({ id: &quot;d1&quot; }), status: &quot;exploded&quot; }), null)</code> |
| L80: <code>a windows payload validates window data and defaults an omitted active window</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(payload); assert.deepEqual(payload.windows.map((window) =&gt; window.id), [&quot;0x1&quot;, &quot;0x2&quot;])</code> |
| L99: <code>app upserts replace by id or append</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(withApp[0]?.apps.length, 1); assert.equal(updated[0]?.apps.length, 1)</code> |
| L109: <code>tab title adds the active window&#x27;s title</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(desktopTabTitle(desktop({ id: &quot;d1&quot;, title: &quot;Main&quot; })), &quot;Main&quot;); assert.ok(title.includes(&quot;Main&quot;))</code> |
| L120: <code>the close message names the running apps</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(runningDesktopApps(d).map((a) =&gt; a.id), [&quot;a1&quot;, &quot;a2&quot;]); assert.ok(warning.includes(name))</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-state.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/desktop-vnc-socket.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §§7.2,11.2,13.3; installed @novnc/novnc/core/websock.js attach/readyState/receive ABI.

**Contract / recognizable regressions (2):** RFB bytes reach the real noVNC consumer while text control frames remain isolated, RTT is measured, and stale links close. The viewer can reject the wrapper ABI, text JSON can corrupt RFB, pings can leak after close or silent links can never reconnect.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** desktop-vnc-socket.ts; DesktopView attaches it to noVNC.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Actual installed-consumer attach/receive/open assertions supersede the property-only mirror test; separate protocol and lifecycle tests retain unique failure modes. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L44: <code>noVNC attaches the channel and receives RFB bytes</code> | CONSOLIDATE | Survives at the actual installed consumer ABI: attach, connecting→open, and received RFB bytes now cover the unique transition from the deleted property-only case. Oracle: <code>assert.equal(receiver.readyState, &quot;connecting&quot;); assert.equal(receiver.rQshiftStr(4), &quot;RFB &quot;)</code> |
| L68: <code>forces arraybuffer and mirrors readyState and protocol</code> | CONSOLIDATE | A wrapper property mirror is superseded by the installed noVNC consumer. Its unique open-state transition moves there; protocol text only affects vendor logging. Surviving owner: noVNC attaches the channel and receives RFB bytes. Oracle: <code>assert.equal(channel.binaryType, &quot;arraybuffer&quot;); assert.equal(channel.readyState, 0)</code> |
| L80: <code>text frames are consumed as control messages and a pong yields an RTT sample</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(ping.type, &quot;ping&quot;); assert.deepEqual(samples, [42])</code> |
| L100: <code>pings every interval while open and stops after close</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(socket.sent.length, 0, &quot;no pings before open&quot;); assert.equal(socket.sent.length, 1, &quot;an immediate ping on open&quot;)</code> |
| L122: <code>a silent link is closed so the viewer reconnects</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(socket.closed?.code, 4000)</code> |
| L139: <code>open, close and error reach noVNC&#x27;s handlers</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(seen, [&quot;open&quot;, &quot;error&quot;, &quot;close:1011&quot;]); assert.ok(socket.sent.some((d) =&gt; d instanceof Uint8Array))</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/desktop-vnc-socket.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/file-icon.test.ts

**Independent source (1):** docs/superpowers/plans/2026-09-22-chat-attachment-paths-and-chips.md (unknown extension/mime never throws).

**Contract / recognizable regressions (2):** User-controlled prototype-looking names must resolve to a valid generic attachment icon. notes.constructor or a mime named constructor can return Object instead of an icon id and crash rendering.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** file-icon.ts; FileTypeIcon.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** File-kind classification does not protect the independent icon lookup table; this is a credible runtime crash, not an icon inventory. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L9: <code>reads only its own table keys: a name or mime spelled like an Object.prototype member is unknown</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(fileIconIdFor({ name: &quot;notes.constructor&quot; }), &quot;file&quot;); assert.equal(fileIconIdFor({ name: &quot;x.__proto__&quot; }), &quot;file&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/file-icon.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/file-kind.test.ts

**Independent source (1):** README.md Files/previews; same attachment-paths plan (unknown names safe).

**Contract / recognizable regressions (2):** File preview classification handles supported names/compound archives and refuses prototype lookup leakage. A constructor-like extension can return a non-kind, uppercase images can fall through, or a compound archive can open through the wrong viewer.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** file-kind.ts; file preview dispatcher.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** File-icon tests own a separate table and do not protect preview kind/mime dispatch. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L6: <code>never resolves a prototype member: an extension like `constructor` is the text fallback</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(detectFileKind(&quot;notes.constructor&quot;), { kind: &quot;text&quot;, mime: &quot;text/plain&quot; }); assert.deepEqual(detectFileKind(&quot;x.__proto__&quot;), { kind: &quot;text&quot;, mime: &quot;text/plain&quot; })</code> |
| L12: <code>classifies by lowercased extension and collapses .tar.* names</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(detectFileKind(&quot;shot.PNG&quot;), { kind: &quot;image&quot;, mime: &quot;image/png&quot; }); assert.deepEqual(detectFileKind(&quot;bundle.tar.gz&quot;), { kind: &quot;archive&quot;, mime: &quot;application/gzip&quot; })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/file-kind.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/github-links/pill.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (forge links); packages/api/src/forge-links.ts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Forge URL extraction, author-label preservation, state/check interpretation, and safe shared link-preview lifecycle. Prose can turn into a misleading forge link, completed/failed states can be misrepresented, credentials can cross project cache keys, invalid previews can reach UI, or 429 requests can retry too soon.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** github-links/text-links.ts, pill.logic.ts, preview-store.ts; ForgeLinkPill and timeline renderers consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API parser/daemon tests cannot expose client text splitting, preview coalescing, subscriber updates, or stale-preview retention. Private validators/default-constant echoes are consolidated into LinkPreviewStore request/get behavior. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L54: <code>maps PR states to GitHub&#x27;s icons and tones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(forgePillPresentation(pr, PULL), { icon: &quot;pull&quot;, tone: &quot;open&quot;, stateLabel: &quot;Open&quot; }); assert.deepEqual(forgePillPresentation(pr, { ...PULL, state: &quot;draft&quot; }), { icon: &quot;pull-draft&quot;, tone: &quot;draft&quot;, stateLabel: &quot;Draft&quot; })</code> |
| L62: <code>maps issue states, completed purple and not-planned grey</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(forgePillPresentation(ref, issue(&quot;open&quot;)), { icon: &quot;issue&quot;, tone: &quot;open&quot;, stateLabel: &quot;Open&quot; }); assert.deepEqual(forgePillPresentation(ref, issue(&quot;closed&quot;, &quot;completed&quot;)), { icon: &quot;issue-done&quot;, tone: &quot;merged&quot;, stateLabel: &quot;Closed&quot; })</code> |
| L76: <code>names the kind, neutrally, before or without a preview</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(forgePillPresentation(link(href), null), { icon, tone: &quot;neutral&quot;, stateLabel: null }, href)</code> |
| L97: <code>leads with the worst outcome</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(checksPresentation(null), null); assert.equal(checksPresentation({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }), null)</code> |
| L117: <code>says when the item last changed state</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(previewTimeline(PULL), { verb: &quot;opened&quot;, at: &quot;2026-10-01T00:00:00Z&quot; }); assert.deepEqual(previewTimeline({ ...PULL, state: &quot;merged&quot;, mergedAt: &quot;2026-10-05T00:00:00Z&quot; }), { verb: &quot;merged&quot;, at: &quot;2026-10-05T00:00:00Z&quot; })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/github-links/pill.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/github-links/preview-store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (forge links); packages/api/src/forge-links.ts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Forge URL extraction, author-label preservation, state/check interpretation, and safe shared link-preview lifecycle. Prose can turn into a misleading forge link, completed/failed states can be misrepresented, credentials can cross project cache keys, invalid previews can reach UI, or 429 requests can retry too soon.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** github-links/text-links.ts, pill.logic.ts, preview-store.ts; ForgeLinkPill and timeline renderers consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API parser/daemon tests cannot expose client text splitting, preview coalescing, subscriber updates, or stale-preview retention. Private validators/default-constant echoes are consolidated into LinkPreviewStore request/get behavior. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L46: <code>reads statuses and the daemon&#x27;s wait</code> | CONSOLIDATE | Direct private-helper/default-constant echoes fail stable-seam and oracle independence. Real 404/429 body handling survives through the store; the unique Retry-After seconds conversion moves into the retry owner. Surviving owner: remembers failures until their retry time. Oracle: <code>assert.deepEqual(classifyPreviewError({ status: 404 }, 0), { reason: &quot;not_found&quot;, retryAt: NOT_FOUND_RETRY_MS }); assert.deepEqual(classifyPreviewError({ status: 400 }, 0), { reason: &quot;not_found&quot;, retryAt: NOT_FOUND_RETRY_MS })</code> |
| L58: <code>accepts the three kinds and refuses the rest</code> | REWRITE | Moves validation from a test-only exported predicate to public request/get state. Issue/pull/commit acceptance, invalid shapes/state and foreign URL rejection now fail if actual shared state accepts or drops the wrong wire result. Oracle: <code>assert.equal(isGitHubLinkPreview(preview()), true); assert.equal(isGitHubLinkPreview({ ...preview(), url: &quot;https://evil.example/x&quot; }), false)</code> |
| L70: <code>reads once per item and project, shares the state, and notifies subscribers</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(store.keyOf({ ...TARGET, owner: &quot;ACME&quot; }, &quot;/w/ws/app&quot;), key); assert.notEqual(store.keyOf(TARGET, &quot;/w/ws/other&quot;), key)</code> |
| L94: <code>re-reads a stale preview in the background and keeps it if the re-read fails</code> | REWRITE | Retains fresh/stale behavior and the failed-refresh preview; uses controlled platform Date instead of unused production clock/freshness options or imported default constants. Oracle: <code>assert.equal(calls.length, 2); assert.equal(store.get(key).status, &quot;ready&quot;, &quot;no loading flash on a re-read&quot;)</code> |
| L113: <code>remembers failures until their retry time</code> | CONSOLIDATE | Survives as the real request-suppression/retry owner, including exact daemon-provided milliseconds and HTTP Retry-After seconds, plus missing-link state. Oracle: <code>assert.deepEqual(store.get(key), { status: &quot;unavailable&quot;, reason: &quot;rate_limited&quot;, retryAt: 60_000 }); assert.equal(calls.length, 1)</code> |
| L133: <code>treats a malformed answer as an error</code> | CONSOLIDATE | Duplicate minimal bad-shape case moves into the stronger public-store validation matrix; private validator exports are removed. Surviving owner: accepts the three kinds and refuses the rest. Oracle: <code>assert.equal((store.get(key) as { reason: string }).reason, &quot;error&quot;)</code> |
| L143: <code>caps concurrent reads and queues the rest</code> | REWRITE | Exercises the actual production concurrency policy with queued requests and completion/failure draining; removes the unused custom-concurrency production hook. Oracle: <code>assert.equal(calls.length, 2); assert.ok(keys.every((key) =&gt; store.get(key).status === &quot;loading&quot;))</code> |
| L159: <code>evicts the oldest unwatched entries past its cap</code> | DELETE | Fails independently specified contract/stable-seam bars: exercises a test-only capacity override to pin an internal eviction choice. Production retains the same 1000-entry bound and eviction logic; the unused override is removed. Oracle: <code>assert.equal(store.get(b).status, &quot;idle&quot;); assert.equal(store.get(c).status, &quot;loading&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/github-links/preview-store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/github-links/text-links.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (forge links); packages/api/src/forge-links.ts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Forge URL extraction, author-label preservation, state/check interpretation, and safe shared link-preview lifecycle. Prose can turn into a misleading forge link, completed/failed states can be misrepresented, credentials can cross project cache keys, invalid previews can reach UI, or 429 requests can retry too soon.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** github-links/text-links.ts, pill.logic.ts, preview-store.ts; ForgeLinkPill and timeline renderers consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API parser/daemon tests cannot expose client text splitting, preview coalescing, subscriber updates, or stale-preview retention. Private validators/default-constant echoes are consolidated into LinkPreviewStore request/get behavior. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L7: <code>drops sentence punctuation and unbalanced closers, keeps balanced ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(trimUrlCandidate(&quot;https://github.com/a/b/pull/1.&quot;), &quot;https://github.com/a/b/pull/1&quot;); assert.equal(trimUrlCandidate(&quot;https://github.com/a/b/pull/1),&quot;), &quot;https://github.com/a/b/pull/1&quot;)</code> |
| L18: <code>leaves text without forge links as one run</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(splitForgeLinks(&quot;no links here&quot;), [{ text: &quot;no links here&quot; }]); assert.deepEqual(splitForgeLinks(&quot;see https://example.com/a/b/pull/1&quot;), [{ text: &quot;see https://example.com/a/b/pull/1&quot; }])</code> |
| L23: <code>cuts each forge URL out as its own run, keeping the text around it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( runs.map((run) =&gt; [run.text, run.link?.kind ?? null]), [ [&quot;Fixes &quot;, null], [&quot;https://github.com/acme/app/issues/4&quot;, &quot;issue&quot;], [&quot;, see (&quot;, null], [&quot;https://github.com/acme/app/pull/9&quot;, &quot;pull&quot;], [&quot;).&quot;, null] ] ); assert.equal(runs.map((run) =&gt; run.text).join(&quot;&quot;), &quot;Fixes https://github.com/acme/app/issues/4, see (https://github.com/acme/app/pull/9).&quot;)</code> |
| L38: <code>does not take look-alike hosts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(splitForgeLinks(&quot;https://github.com.evil.example/a/b/pull/1&quot;), [{ text: &quot;https://github.com.evil.example/a/b/pull/1&quot; }])</code> |
| L44: <code>lists distinct links in order, capped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( forgeLinksInText(text).map((link) =&gt; link.url), [&quot;https://github.com/a/b/pull/1&quot;, &quot;https://gitlab.com/g/p/-/merge_requests/2&quot;, &quot;https://github.com/a/b/commit/abcdef1&quot;] ); assert.equal(forgeLinksInText(many).length, 8)</code> |
| L64: <code>is true for autolinks and false for the author&#x27;s words</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isUrlText(&quot;https://github.com/a/b/pull/1&quot;, &quot;https://github.com/a/b/pull/1&quot;), true); assert.equal(isUrlText(&quot;github.com/a/b/pull/1&quot;, &quot;https://github.com/a/b/pull/1&quot;), true)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/github-links/text-links.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/knowledge/citations.test.ts

**Independent source (1):** packages/api/src/index.ts and packages/api/src/agent-chat wire contracts (knowledge responses/events); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Knowledge wire validation, event-driven refresh, collection/graph revision effects, and citation existence across resets. Malformed nodes or account settings can crash UI, a deleted citation can reappear after a stale read, another connection can supply the result, or a relabel can leave stale graph colors.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** knowledge/validate.ts, store.ts, citations.ts; Knowledge view, citation chips and app event routing consume state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon knowledge persistence does not protect client sanitization or event/load/reset order. Each named scenario exercises its own transport shape or causal ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L33: <code>are forgotten when the knowledge store resets, even before any entry changed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(knowledgeCitationState(ID), &quot;exists&quot;); assert.equal(knowledgeCitationState(ID), &quot;unknown&quot;)</code> |
| L45: <code>never re-ask through the client of a connection that was reset</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(one.reads, [ID], &quot;the old connection&#x27;s client is not asked again&quot;)</code> |
| L57: <code>drop an answer from before a reset that lands after it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(knowledgeCitationState(ID), &quot;unknown&quot;)</code> |
| L66: <code>ask again when the entry changes while its first read is in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(one.reads, [ID, ID], &quot;asked again&quot;); assert.equal(knowledgeCitationState(ID), &quot;deleted&quot;)</code> |
| L79: <code>keep the newest answer when an older read settles last</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(knowledgeCitationState(ID), &quot;deleted&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/knowledge/citations.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/knowledge/store.test.ts

**Independent source (1):** packages/api/src/index.ts and packages/api/src/agent-chat wire contracts (knowledge responses/events); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Knowledge wire validation, event-driven refresh, collection/graph revision effects, and citation existence across resets. Malformed nodes or account settings can crash UI, a deleted citation can reappear after a stale read, another connection can supply the result, or a relabel can leave stale graph colors.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** knowledge/validate.ts, store.ts, citations.ts; Knowledge view, citation chips and app event routing consume state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon knowledge persistence does not protect client sanitization or event/load/reset order. Each named scenario exercises its own transport shape or causal ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L80: <code>loads the status and the collections</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().status?.entries, 2); assert.deepEqual(state().collections?.collections.map((c) =&gt; c.id), [&quot;kc_seo&quot;, &quot;kc_ads&quot;])</code> |
| L88: <code>a status event replaces the status, and a read in flight from before it is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().status?.entries, 9); assert.equal(state().status?.entries, 9)</code> |
| L98: <code>ignores a malformed status event</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().status?.entries, 4)</code> |
| L104: <code>keeps a failed read&#x27;s error, and clears it with the next good one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(read, /down/); assert.match(String(state().statusError), /down/)</code> |
| L116: <code>coalesces collection reads asked for while one is in flight into one more</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(fake.collectionReads.length, 1); assert.equal(fake.collectionReads.length, 2, &quot;one more read, for the calls made meanwhile&quot;)</code> |
| L131: <code>a change event naming entries bumps the entries revision and refetches the collections (their counts)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().entriesRevision, 1); assert.deepEqual(state().changedEntryIds, [&quot;ke_1&quot;])</code> |
| L144: <code>a graph change bumps only the graph revision; a collections change only refetches them</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().graphRevision, 1); assert.equal(state().entriesRevision, 0)</code> |
| L160: <code>entries relabelled or deleted elsewhere (entry ids with collections) recolour the graph at once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().entriesRevision, 1); assert.equal(state().graphRevision, 1, &quot;as this client&#x27;s own relabel or delete does&quot;)</code> |
| L168: <code>an entries change with no ids means any entry</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().changedEntryIds, null)</code> |
| L173: <code>mutations refetch instead of applying anything, and say what changed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(fake.calls, [&quot;patch:ke_1&quot;, &quot;collections&quot;]); assert.equal(state().entriesRevision, 1)</code> |
| L190: <code>a refused mutation rejects and refetches nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(updateKnowledgeCollection(fake.api, &quot;kc_seo&quot;, { name: &quot;Ads&quot; }), /exists/); assert.deepEqual(fake.calls, [])</code> |
| L199: <code>a reset drops answers still in flight, and another connection&#x27;s client resets first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().status, null); assert.equal(state().entriesRevision, 1)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/knowledge/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/knowledge/validate.test.ts

**Independent source (1):** packages/api/src/index.ts and packages/api/src/agent-chat wire contracts (knowledge responses/events); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Knowledge wire validation, event-driven refresh, collection/graph revision effects, and citation existence across resets. Malformed nodes or account settings can crash UI, a deleted citation can reappear after a stale read, another connection can supply the result, or a relabel can leave stale graph colors.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** knowledge/validate.ts, store.ts, citations.ts; Knowledge view, citation chips and app event routing consume state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon knowledge persistence does not protect client sanitization or event/load/reset order. Each named scenario exercises its own transport shape or causal ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L38: <code>keeps readable collections, repairs fields, and drops unreadable ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.deepEqual( parsed.collections.map((c) =&gt; [c.id, c.color, c.entryCount, c.description, c.profiles.length]), [ [&quot;kc_seo&quot;, &quot;chart-2&quot;, 3, &quot;Search&quot;, 1], [&quot;kc_new&quot;, &quot;chart-1&quot;, 0, &quot;&quot;, 0] ] )</code> |
| L62: <code>totals the entries itself when the daemon left the total out</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parsed?.totalEntries, 3)</code> |
| L67: <code>reads entry pages, defaulting what an entry may lack and keeping a citation</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.equal(parsed.entries.length, 1)</code> |
| L84: <code>drops duplicate nodes and edges whose ends are not in the graph</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.deepEqual(parsed.nodes.map((n) =&gt; n.name), [&quot;A&quot;, &quot;B&quot;])</code> |
| L106: <code>reads both kinds of item and refuses an unknown one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(entry?.kind, &quot;entry&quot;); assert.equal(entry.entry.entry.body, &quot;Full text&quot;)</code> |
| L140: <code>reads search hits of both kinds</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.deepEqual(parsed.hits.map((h) =&gt; h.kind), [&quot;entry&quot;, &quot;concept&quot;])</code> |
| L157: <code>needs enabled and installed in a status, and repairs the rest</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parseKnowledgeStatus({ installed: true }), null); assert.ok(status)</code> |
| L178: <code>reads an unknown linking state as idle and an unknown pause reason as an error</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseKnowledgeLinkingState({ state: &quot;teleporting&quot; }), { state: &quot;idle&quot; }); assert.deepEqual(parseKnowledgeLinkingState({ state: &quot;paused&quot;, reason: &quot;solar-flare&quot;, message: &quot;m&quot;, resumesAt: null, pendingEntries: 1 }), { state: &quot;paused&quot;, reason: &quot;error&quot;, message: &quot;m&quot;, resumesAt: null, pendingEntries: 1 })</code> |
| L189: <code>reads a change event&#x27;s fields and nothing else</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseKnowledgeChangedEvent({ entryIds: [&quot;a&quot;, 1], graph: true, collections: &quot;yes&quot; }), { entryIds: [&quot;a&quot;], graph: true }); assert.equal(parseKnowledgeChangedEvent(&quot;x&quot;), null)</code> |
| L194: <code>reads the indexing settings field by field, a bad field as its default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseKnowledgeSettings({ accountPolicy: policy, accountId: &quot;c1&quot;, model: &quot;opus&quot;, concurrency: 6, extra: 1 }), { accountPolicy: policy, accountId: &quot;c1&quot;, model: &quot;opus&quot;, concurrency: 6 }); assert.deepEqual(parseKnowledgeSettings({ accountPolicy: { strategy: 3, accounts: [&quot;c1&quot;, 2], maxWeeklyPct: -1, unknownUsage: &quot;exclude&quot; } })!.accountPolicy, { ...AUTO, accounts: [&quot;c1&quot;], unknownUsage: &quot;exclude&quot; })</code> |
| L228: <code>reads a rebuild estimate as two counts, or nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseKnowledgeRebuildEstimate({ entries: 12, tasks: 340 }), { entries: 12, tasks: 340 }); assert.deepEqual(parseKnowledgeRebuildEstimate({ entries: -3, tasks: 7.6 }), { entries: 0, tasks: 7 })</code> |
| L237: <code>the client validates the settings, their update&#x27;s answer and the estimate</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await client.getKnowledgeSettings(), { accountPolicy: null, accountId: null, model: &quot;opus&quot;, concurrency: 4 }); assert.deepEqual(await client.updateKnowledgeSettings({ accountPolicy: policy }), { accountPolicy: policy, accountId: &quot;c2&quot;, model: null, concurrency: 3 })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/knowledge/validate.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/launch-models.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.1; documented modelSelection.model-required launch regression.

**Contract / recognizable regressions (2):** Launch resolves a supported model/default and model search preserves the selection. A one-click chat can post an empty/retired model and fail, a valid preference can be lost, or search can show no selected model.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** launch-models.ts; ProjectOverview and new-tab launcher.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Provider catalog tests cannot protect the client’s launch resolution and selected-choice preservation. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L17: <code>a launch always names a model, so the host cannot refuse it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resolved, &quot;big-pickle&quot;)</code> |
| L24: <code>the remembered pick wins while the catalogue still serves it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( resolveLaunchModel({ snapshot: { models: catalogue }, preferred: &quot;gpt-5.6-luna&quot; }), &quot;gpt-5.6-luna&quot; )</code> |
| L31: <code>a remembered pick the catalogue dropped falls back to the default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( resolveLaunchModel({ snapshot: { models: catalogue }, preferred: &quot;retired-model&quot; }), &quot;big-pickle&quot; )</code> |
| L39: <code>no default flag at all falls back to the first entry</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resolveLaunchModel({ snapshot: { models: [model(&quot;only&quot;)] } }), &quot;only&quot;)</code> |
| L43: <code>no catalogue yields null, so the caller can refuse instead of posting</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resolveLaunchModel({ snapshot: null }), null); assert.equal(resolveLaunchModel({ snapshot: { models: [] } }), null)</code> |
| L49: <code>the selected model is always shown, even when a query excludes it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(new Set(list.shown.map((choice) =&gt; choice.slug)), new Set([ &quot;big-pickle&quot;, &quot;openrouter/anthropic/claude-3-haiku&quot; ]))</code> |
| L60: <code>search matches the slug or the display name, case-insensitively</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( list.shown.map((choice) =&gt; choice.slug), [&quot;openrouter/anthropic/claude-3-haiku&quot;] ); assert.deepEqual( byName.shown.map((choice) =&gt; choice.slug), [&quot;big-pickle&quot;] )</code> |
| L73: <code>a query with no match shows nothing but the selection</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( list.shown.map((choice) =&gt; choice.slug), [&quot;big-pickle&quot;] ); assert.equal(list.hidden, 0)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/launch-models.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/login-expiry.test.ts

**Independent source (1):** packages/api/src/index.ts AgentAccount.loginExpiresAt/needsReauth; README.md managed accounts.

**Contract / recognizable regressions (2):** Expiry warnings reflect remaining deadline and auth failure takes precedence without invented expiry data. An expired account can look healthy, future-expiry warnings can be premature, or absent/invalid data can claim an invented expiry.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** login-expiry.ts; account settings rows.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Provider token-refresh tests do not own client warning selection and countdown data; the test spans a single explicit warning policy. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L11: <code>login warnings count down from seven days through hours and minutes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loginExpiryWarning(expiresIn(remaining), NOW), expected); assert.equal(loginExpiryWarning(expiresIn(25 * MINUTE), NOW + 5 * MINUTE), &quot;Login expires in 20 minutes&quot;)</code> |
| L29: <code>failed authentication takes precedence; unknown deadlines never invent an expiry</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loginExpiryWarning({ ...expiresIn(30 * DAY), needsReauth: true }, NOW), &quot;Login expired, please re-login&quot;); assert.equal(loginExpiryWarning({}, NOW), null)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/login-expiry.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/open-layers.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (Escape ownership); documented interrupt-under-open-viewer regression.

**Contract / recognizable regressions (2):** Open overlays own Escape until their own idempotent release; newest tracked layer owns nested keyboard focus. Escape can interrupt a hidden chat under a modal, duplicate cleanup can release another overlay, or a sheet can beat an inner dropdown.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** open-layers.ts; shared key handlers and overlay hooks.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Component handlers rely on this shared registry but do not separately protect nesting, idempotence and tracked topmost ownership. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L28: <code>nested layers count separately: closing the inner one leaves the outer one open</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isAnyLayerOpen(), true, &quot;the modal is still up&quot;); assert.equal(isAnyLayerOpen(), false)</code> |
| L39: <code>a release runs once in effect: a second call never closes another layer</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isAnyLayerOpen(), true, &quot;the second layer is still open&quot;)</code> |
| L50: <code>a tracked layer knows when a newer one (a dropdown inside a sheet) is above it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sheet.isTopmost(), true); assert.equal(sheet.isTopmost(), false, &quot;the dropdown owns Escape&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/open-layers.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/opened-agents.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §1 (repo label search); docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.7.

**Contract / recognizable regressions (2):** Sidebar/Opened Agents search uses visible session/project/repo labels without crossing unrelated repositories. Search can miss custom repo labels, match obsolete labels after replacement or attach another repo’s identity.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** opened-agents.ts; attention/sidebar grouping callers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Repository grouping tests do not establish the distinct AgentSessionEntry/project-index join used by Opened Agents. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L10: <code>the sidebar search matches any field, ignoring case and outer spaces</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(matchesSidebarQuery(&quot;&quot;, &quot;anything&quot;), true); assert.equal(matchesSidebarQuery(&quot; &quot;, undefined), true)</code> |
| L39: <code>an agent&#x27;s repo is its project&#x27;s repoKey with the label it shows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(agentRepo(entryFor(repoProject), index, none), { repoKey: KEY, label: &quot;JasperRaccoon/JasperEngine&quot; }); assert.deepEqual(agentRepo(entryFor(repoProject), index, labelled(&quot;Engine&quot;)), { repoKey: KEY, label: &quot;Engine&quot; })</code> |
| L45: <code>the Opened Agents search also matches the repo&#x27;s shown label</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(matchesAgentQuery(&quot;jasperengine&quot;, entryFor(repoProject), index, none), true); assert.equal(matchesAgentQuery(&quot;raccoon engine&quot;, entryFor(repoProject), index, labelled(&quot;Raccoon engine&quot;)), true)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/opened-agents.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/plugins-state.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md; docs/superpowers/specs/2026-10-15-excalidraw-whiteboard-design.md; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Plugin response compatibility, known engine/global scope parsing and list upsert semantics. Older daemons can disappear from settings, an unknown plugin can break the whole list, a workspace plugin can look globally enabled, or engine choices can be misread.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** plugins-state.ts; shared app-store and PluginsSettings.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** App setter echo coverage is removed by the store-owning agent; this is the lowest parser/upsert owner. Live get/event/reset integration remains in store tests. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L36: <code>a well-formed plugin parses to the same value</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(value), value)</code> |
| L46: <code>absent nullable fields read as null and unknown fields are dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(sent), { ...plugin(), current: null, previous: null, skippedVersion: null, lastCheckAt: null, lastError: null })</code> |
| L61: <code>a daemon from before global plugins: a workspace plugin with updates, enabled while on anywhere</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(sent), plugin({ scope: &quot;workspace&quot;, enabledWorkspaces: [&quot;acme&quot;] })); assert.equal(parsePluginInfo({ ...sent, enabledWorkspaces: [] })?.enabled, false)</code> |
| L73: <code>a missing enabledWorkspaces reads as empty</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(sent), plugin()); assert.equal(parsePluginInfo(sent)?.enabled, false)</code> |
| L81: <code>a global plugin parses, and reads as enabled only when it is on</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(global), global); assert.equal(isGlobalPluginEnabled([plugin(), global], &quot;excalidraw&quot;), true)</code> |
| L104: <code>a plugin with a malformed field is rejected</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parsePluginInfo(value), null, JSON.stringify(value))</code> |
| L131: <code>a plugins response parses, leaving out plugin ids this client does not know</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsed, { plugins: [known] }); assert.deepEqual(parsePluginsResponse({ plugins: [] }), { plugins: [] })</code> |
| L140: <code>a plugins response with a malformed known plugin, or not a list, is rejected</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(parsePluginsResponse({ plugins: [{ ...plugin(), job: 3 }] }), null); assert.equal(parsePluginsResponse({ plugins: [null] }), null)</code> |
| L148: <code>a route&#x27;s answer yields the plugin whether it is the plugin or the whole list</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginActionResult(value, &quot;ts-rust&quot;), value); assert.deepEqual(parsePluginActionResult({ plugins: [value] }, &quot;ts-rust&quot;), value)</code> |
| L157: <code>upserting replaces a plugin by id or appends it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(upsertPluginIn([before], after), [after]); assert.deepEqual(upsertPluginIn([], after), [after])</code> |
| L182: <code>the active engine and the engines to choose from parse as sent</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parsePluginInfo(value), value)</code> |
| L187: <code>a daemon from before the engine choice: no engine fields, and the plugin still parses</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.equal(&quot;engine&quot; in parsed, false)</code> |
| L194: <code>an unknown engine reads as absent; unknown or malformed engine entries are left out</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(parsed); assert.equal(parsed.engine, undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/plugins-state.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/preferred-model.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §6.1; owner request recorded in preferred-model.ts (model+effort reused); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Model selections and options persist safely; per-model options do not follow a changed model. A new chat can lose the chosen effort level, send old options to an incompatible model, or accept garbage storage.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** preferred-model.ts; launch/composer pickers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Host effort/config tests cannot protect client-local persistence and conversion into launch ModelSelection. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L13: <code>round-trips model and options, and drops what it cannot type</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loaded.claude, { model: &quot;claude-fable-5-1&quot;, options: [{ id: &quot;effort&quot;, value: &quot;high&quot; }, { id: &quot;thinking&quot;, value: true }] }); assert.equal(loaded.codex, undefined, &quot;a non-string model is not a selection&quot;)</code> |
| L30: <code>launch carries the remembered options only for the remembered model</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(launchModelSelection(&quot;claude-fable-5-1&quot;, preferred), preferred); assert.deepEqual(launchModelSelection(&quot;haiku&quot;, preferred), { model: &quot;haiku&quot; })</code> |
| L37: <code>garbage storage loads as empty rather than throwing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadPreferredModelSelections(), {}); assert.deepEqual(loadPreferredModelSelections(), {})</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/preferred-model.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/preferred-profile.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Profile choices are per daemon/agent, Global clears a pick and deleted profiles are forgotten. A profile from another daemon can launch, an explicit Global can fail to clear a remembered pick, or deleted profiles can keep getting sent.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** preferred-profile.ts; launcher/composer and app profile-list updates.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon launch errors cannot protect local remembered choices. Object identity checks are deleted; retained assertions observe persisted/selected values. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L24: <code>round-trips per daemon connection, and drops what is not a profile id</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadPreferredProfiles(&quot;local&quot;), { claude: &quot;p-dev&quot; }); assert.deepEqual(loadPreferredProfiles(&quot;remote-1&quot;), { codex: &quot;p-ed&quot; }, &quot;another daemon has its own picks&quot;)</code> |
| L47: <code>garbage loads as every agent Global</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadPreferredProfiles(&quot;local&quot;), {}); assert.deepEqual(loadPreferredProfiles(&quot;local&quot;), {})</code> |
| L55: <code>null forgets the agent&#x27;s pick (Global); a deleted profile is forgotten everywhere</code> | REWRITE | Removes incidental same-object identity checks. Persisted/selected profile values, Global clearing, deletion and known-id filtering remain the independent observable oracle. Oracle: <code>assert.deepEqual(map, { claude: &quot;p-dev&quot; }); assert.equal(withPreferredProfile(map, &quot;claude&quot;, &quot;p-dev&quot;), map, &quot;unchanged keeps identity&quot;)</code> |
| L63: <code>keeps only the picks the daemon&#x27;s profile list knows</code> | REWRITE | Removes incidental same-object identity checks. Persisted/selected profile values, Global clearing, deletion and known-id filtering remain the independent observable oracle. Oracle: <code>assert.deepEqual(keepKnownPreferredProfiles(map, new Set([&quot;p-dev&quot;, &quot;p-broken&quot;])), { claude: &quot;p-dev&quot;, grok: &quot;p-broken&quot; }); assert.equal(keepKnownPreferredProfiles(map, new Set([&quot;p-dev&quot;, &quot;p-gone&quot;, &quot;p-broken&quot;])), map, &quot;unchanged keeps identity&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/preferred-profile.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/prompt-history/checkpoints.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.4,5.5; packages/api/src/agent-chat prompt/history/checkpoint contracts.

**Contract / recognizable regressions (2):** History prompt pagination, loaded/index merge precedence, checkpoint joins, and safe rewind gating. A prompt can disappear behind short pages, the index can overwrite full text, a steer can get the wrong checkpoint, a compaction can allow invalid rewind, or a late busy/send state can permit a destructive history change.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** prompt-history/index-cache.ts, prompts.logic.ts, checkpoints.logic.ts, rewind.logic.ts, thread-inputs.ts; right-rail history and RewindControl consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API/host index tests cannot protect client paging and merge behavior; row policy tests cannot protect the rail’s reveal-then-recheck orchestration. Named tests distinguish the input provenance and operation ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L49: <code>lists only ready checkpoints, newest turn first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( ready.map((entry) =&gt; entry.turnId), [&quot;t4&quot;, &quot;t1&quot;] )</code> |
| L62: <code>adds the older ones only a loaded history page carries; the fold&#x27;s copy wins</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( ready.map((entry) =&gt; entry.turnId), [&quot;t5&quot;, &quot;t1&quot;], &quot;a page&#x27;s stale ready copy never overrides what the fold says now&quot; )</code> |
| L78: <code>is its turn&#x27;s, for a prompt that started one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(promptCheckpoint(prompt(&quot;u1&quot;, &quot;t1&quot;, 1), byTurn)?.checkpointTurnCount, 1)</code> |
| L82: <code>is none for a steer — it rides a turn another prompt opened</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(promptCheckpoint(prompt(&quot;s1&quot;, &quot;t1&quot;, null), byTurn), null); assert.equal(promptCheckpoint(prompt(&quot;u9&quot;, null, null), byTurn), null)</code> |
| L89: <code>counts files and sums the lines</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( diffSummaryOf([ { path: &quot;a.ts&quot;, additions: 3, deletions: 1 }, { path: &quot;b.png&quot;, additions: 0, deletions: 0 }, { path: &quot;c.ts&quot;, additions: 17, deletions: 3 } ]), { fileCount: 3, additions: 20, deletions: 4 } ); assert.deepEqual(diffSummaryOf([]), { fileCount: 0, additions: 0, deletions: 0 })</code> |
| L116: <code>names what opened each turn, newest first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( entries.map((entry) =&gt; [entry.checkpoint.checkpointTurnCount, entry.origin.kind]), [ [6, &quot;unlisted&quot;], [5, &quot;unlisted&quot;], [4, &quot;plan&quot;], [3, &quot;agent&quot;], [2, &quot;agent&quot;], [1, &quot;prompt&quot;] ] )</code> |
| L144: <code>goes back to whichever user message opened the turn, and to none the agent opened</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(openers.get(1), listed, &quot;a listed prompt is its own opener&quot;); assert.equal(openers.get(2), null, &quot;no prompt opened it&quot;)</code> |
| L181: <code>numbers a card by its turn&#x27;s ordinal, falling back to the checkpoint&#x27;s own count</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( entries.map((entry) =&gt; entry.turnNumber), [2, 9] )</code> |
| L198: <code>matches the opening prompt and the changed paths together</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(matching([&quot;prompt&quot;, &quot;auth&quot;]), [&quot;t1&quot;]); assert.deepEqual(matching([&quot;readme&quot;]), [&quot;t2&quot;])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/prompt-history/checkpoints.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/prompt-history/index-cache.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.4,5.5; packages/api/src/agent-chat prompt/history/checkpoint contracts.

**Contract / recognizable regressions (2):** History prompt pagination, loaded/index merge precedence, checkpoint joins, and safe rewind gating. A prompt can disappear behind short pages, the index can overwrite full text, a steer can get the wrong checkpoint, a compaction can allow invalid rewind, or a late busy/send state can permit a destructive history change.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** prompt-history/index-cache.ts, prompts.logic.ts, checkpoints.logic.ts, rewind.logic.ts, thread-inputs.ts; right-rail history and RewindControl consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API/host index tests cannot protect client paging and merge behavior; row policy tests cannot protect the rail’s reveal-then-recheck orchestration. Named tests distinguish the input provenance and operation ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L69: <code>coalesces a session&#x27;s first page and caches its prompts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(pageCalls.length, 1, &quot;a second ensure does not ask again&quot;); assert.equal(cache.get(&quot;s1&quot;)?.status, &quot;loading&quot;)</code> |
| L92: <code>falls back for a host without an index, and does not ask it again</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(cache.get(&quot;s1&quot;)?.status, &quot;unindexed&quot;); assert.equal(pageCalls.length, 1)</code> |
| L102: <code>asks a host without an index once more when the thread says its history is indexed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(pageCalls.length, 0, &quot;nothing asked yet: nothing to recheck&quot;); assert.equal(pageCalls.length, 1, &quot;a first page on its way is not asked twice&quot;)</code> |
| L120: <code>falls back on a failure, says why, and retries on request</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(failed.status, &quot;failed&quot;); assert.ok(failed.error)</code> |
| L138: <code>keeps catching-up state during retries until the index answers</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual([state.status, state.refreshing], [&quot;catchingUp&quot;, false]); assert.deepEqual( [state.status, state.refreshing], [&quot;catchingUp&quot;, true], &quot;the note stays up while it asks — no flash back to loading&quot; )</code> |
| L167: <code>turns a failed re-ask into a failure the user can retry, and a terminal answer into no index</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(failing.cache.get(&quot;s1&quot;)?.status, &quot;failed&quot;); assert.equal(terminal.cache.get(&quot;s1&quot;)?.status, &quot;unindexed&quot;)</code> |
| L197: <code>appends the next page once per message and moves the cursor</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(pageCalls.length, 2, &quot;one request in flight at a time&quot;); assert.equal(pageCalls[1]!.query.before, &quot;c1&quot;)</code> |
| L217: <code>keeps what it has when an older page fails, and retries it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state.status, &quot;ready&quot;); assert.deepEqual( state.prompts.map((prompt) =&gt; prompt.messageId), [&quot;u2&quot;] )</code> |
| L256: <code>wants the next older page only when one exists and nothing is in the way</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(searchWantsOlder(ready()), true); assert.equal(searchWantsOlder(undefined), false)</code> |
| L266: <code>reads as paging while a page is on its way or the next one is due</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(searchIsPaging(ready()), true); assert.equal(searchIsPaging(ready({ loadingOlder: true })), true)</code> |
| L277: <code>reads a cut prompt once, and again only after a failure</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(cache.text(&quot;s1&quot;, &quot;u1&quot;), undefined); assert.equal(textCalls.length, 1)</code> |
| L310: <code>keeps asking while the list holds less than a page and the host has more</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(fillWantsOlder(readyWith(0, &quot;c1&quot;)), true); assert.equal(fillWantsOlder(readyWith(3, &quot;c1&quot;)), true)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/prompt-history/index-cache.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/prompt-history/prompts.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.4,5.5; packages/api/src/agent-chat prompt/history/checkpoint contracts.

**Contract / recognizable regressions (2):** History prompt pagination, loaded/index merge precedence, checkpoint joins, and safe rewind gating. A prompt can disappear behind short pages, the index can overwrite full text, a steer can get the wrong checkpoint, a compaction can allow invalid rewind, or a late busy/send state can permit a destructive history change.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** prompt-history/index-cache.ts, prompts.logic.ts, checkpoints.logic.ts, rewind.logic.ts, thread-inputs.ts; right-rail history and RewindControl consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API/host index tests cannot protect client paging and merge behavior; row policy tests cannot protect the rail’s reveal-then-recheck orchestration. Named tests distinguish the input provenance and operation ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L45: <code>numbers opening prompts by started turns and keeps the first claim</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(result.prompts.map(({ messageId, turnId, turnOrdinal }) =&gt; [messageId, turnId, turnOrdinal]), [ [&quot;u-pending&quot;, null, null], [&quot;u3&quot;, &quot;t3&quot;, 3], [&quot;u1&quot;, &quot;t1&quot;, 1] ])</code> |
| L69: <code>walks the pages, the bridge, then the window — parent user messages only, once each</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(result.prompts), [&quot;w1&quot;, &quot;b1&quot;, &quot;s1&quot;, &quot;p1&quot;]); assert.equal(result.prompts[2]!.text, &quot;edited prompt&quot;)</code> |
| L91: <code>lists the parent&#x27;s reusable prompts newest first, with the turn each one started</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(result.prompts), [&quot;u5&quot;, &quot;u3&quot;, &quot;u2&quot;, &quot;u1&quot;]); assert.deepEqual( [first!.text, first!.turnId, first!.turnOrdinal, first!.source, first!.truncated], [&quot;first prompt&quot;, &quot;t1&quot;, 1, &quot;loaded&quot;, false] )</code> |
| L119: <code>leaves out what nobody typed, and says what it was</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(result.prompts), [&quot;real&quot;]); assert.deepEqual(Object.fromEntries(result.unlisted), { internal: &quot;agent&quot;, compact: &quot;other&quot;, plan: &quot;plan&quot;, image: &quot;other&quot; })</code> |
| L141: <code>numbers a pending prompt when its turn starts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(after.prompts[0]!.turnOrdinal, null); assert.equal(started.prompts[0]!.turnOrdinal, 2, &quot;the turn started: the prompt is numbered&quot;)</code> |
| L166: <code>keeps the chat&#x27;s copy of a prompt both hold, and adds what only the index has below it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(merged), [&quot;u3&quot;, &quot;u2&quot;, &quot;u1&quot;]); assert.deepEqual([merged[0]!.source, merged[0]!.text, merged[0]!.truncated], [&quot;loaded&quot;, &quot;loaded u3&quot;, false])</code> |
| L184: <code>drops an index entry whose turn the fold no longer knows — a rewind removed it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(merged), [&quot;kept&quot;, &quot;unclaimed&quot;]); assert.equal(mergeHistoryPrompts([], [entry(&quot;gone&quot;, stamp(1), { turnId: &quot;tx&quot; })], null).length, 1)</code> |
| L199: <code>merges by time, newest first, each list keeping its own order; a tie keeps the loaded prompt first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(merged), [&quot;i-new&quot;, &quot;w3&quot;, &quot;w2&quot;, &quot;w1&quot;, &quot;i-tie&quot;, &quot;i-old&quot;])</code> |
| L209: <code>lists an index prompt once even when two pages carried it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(first), [&quot;u1&quot;])</code> |
| L232: <code>needs every word, in any order</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(filterPromptsBySearch(prompts, &quot;menu cafe&quot;)), [&quot;a&quot;]); assert.deepEqual(ids(filterPromptsBySearch(prompts, &quot;the&quot;)), [&quot;a&quot;, &quot;b&quot;, &quot;c&quot;])</code> |
| L239: <code>shows all prompts for a blank query</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(filterPromptsBySearch(prompts, &quot; &quot;)), [&quot;a&quot;, &quot;b&quot;, &quot;c&quot;])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/prompt-history/prompts.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/prompt-history/rewind.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.4,5.5; packages/api/src/agent-chat prompt/history/checkpoint contracts.

**Contract / recognizable regressions (2):** History prompt pagination, loaded/index merge precedence, checkpoint joins, and safe rewind gating. A prompt can disappear behind short pages, the index can overwrite full text, a steer can get the wrong checkpoint, a compaction can allow invalid rewind, or a late busy/send state can permit a destructive history change.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** prompt-history/index-cache.ts, prompts.logic.ts, checkpoints.logic.ts, rewind.logic.ts, thread-inputs.ts; right-rail history and RewindControl consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API/host index tests cannot protect client paging and merge behavior; row policy tests cannot protect the rail’s reveal-then-recheck orchestration. Named tests distinguish the input provenance and operation ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L54: <code>finds a compaction the settled turn&#x27;s fold hides from the rows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(compactedAt, marker.createdAt, &quot;the items still hold it&quot;); assert.equal( promptRewindTarget({ prompt: older, facts: { targets: rowsRewindTargetsOf(rows), latestCompactionAt: compactedAt }, rollbackSupported: true }), null )</code> |
| L86: <code>takes the newest across the loaded pages, the bridge and the window</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(latestLoadedCompactionAt({ pages, bridge: [inBridge], entries: [inWindow] }), stamp(30)); assert.equal(latestLoadedCompactionAt({ pages, bridge: [], entries: [inWindow] }), stamp(20))</code> |
| L98: <code>reads a rendered prompt&#x27;s verdict off its row</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(promptRewindTarget({ prompt: historyPrompt(), facts: known, rollbackSupported: true }), 0); assert.equal( promptRewindTarget({ prompt: historyPrompt({ messageId: &quot;u2&quot;, turnOrdinal: 2 }), facts: known, rollbackSupported: true }), null, &quot;the row withholds it&quot; )</code> |
| L112: <code>is never offered where the adapter cannot roll back, or for a prompt that started no turn</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(promptRewindTarget({ prompt: historyPrompt(), facts: known, rollbackSupported: false }), null); assert.equal( promptRewindTarget({ prompt: historyPrompt({ turnOrdinal: null }), facts: known, rollbackSupported: true }), null )</code> |
| L121: <code>vouches for an index-only prompt by its page&#x27;s `rewindable`, unless a compaction came since</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(promptRewindTarget({ prompt: indexOnly, facts: facts({}), rollbackSupported: true }), 2); assert.equal( promptRewindTarget({ prompt: { ...indexOnly, indexRewindable: false }, facts: facts({}), rollbackSupported: true }), null )</code> |
| L188: <code>rewinds a rendered prompt to its row&#x27;s count, without paging anything in</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await run(historyPrompt()), { ok: true }); assert.deepEqual(calls, [&quot;rewind u1 0&quot;])</code> |
| L194: <code>brings an older prompt in first, then reads its count off the fresh rows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(outcome, { ok: true }); assert.deepEqual(calls, [&quot;reveal t5&quot;, &quot;rewind old 4&quot;])</code> |
| L203: <code>refuses when the reveal shows the turn but still not the prompt&#x27;s row — no count the rows did not vouch for</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( (await run(historyPrompt({ messageId: &quot;old&quot;, turnId: &quot;t5&quot;, turnOrdinal: 5, source: &quot;index&quot;, indexRewindable: true }))).ok, false ); assert.deepEqual(calls, [&quot;reveal t5&quot;], &quot;nothing posted&quot;)</code> |
| L212: <code>says why the reveal could not bring the prompt in, or that its row withholds it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await tooFar.run(historyPrompt()), { ok: false, reason: &quot;outside the loaded window&quot; }); assert.deepEqual(tooFar.calls, [&quot;reveal t1&quot;])</code> |
| L225: <code>reads a reveal that threw as a history page that failed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(outcome.ok, false); assert.deepEqual(calls, [])</code> |
| L241: <code>waits for the agent to be idle — before it starts, and again after paging in</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await busy.run(historyPrompt())).ok, false); assert.deepEqual(busy.calls, [])</code> |
| L251: <code>waits for a composer send still on its way, read fresh at each step</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await sending.run(historyPrompt())).ok, false); assert.deepEqual(sending.calls, [])</code> |
| L263: <code>never offers what the adapter cannot do, nor a prompt that started no turn</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await unsupported.run(historyPrompt())).ok, false); assert.equal((await steer.run(historyPrompt({ turnOrdinal: null }))).ok, false)</code> |
| L271: <code>says why the rewind failed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await run(historyPrompt()), { ok: false, reason: &quot;The provider refused.&quot; })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/prompt-history/rewind.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/prompt-history/thread-inputs.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.4,5.5; packages/api/src/agent-chat prompt/history/checkpoint contracts.

**Contract / recognizable regressions (2):** History prompt pagination, loaded/index merge precedence, checkpoint joins, and safe rewind gating. A prompt can disappear behind short pages, the index can overwrite full text, a steer can get the wrong checkpoint, a compaction can allow invalid rewind, or a late busy/send state can permit a destructive history change.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** prompt-history/index-cache.ts, prompts.logic.ts, checkpoints.logic.ts, rewind.logic.ts, thread-inputs.ts; right-rail history and RewindControl consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API/host index tests cannot protect client paging and merge behavior; row policy tests cannot protect the rail’s reveal-then-recheck orchestration. Named tests distinguish the input provenance and operation ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L15: <code>moves when what the panel shows moves: the turn settling, a request docking, a rewind</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(rewindBusyOf(state(&quot;running&quot;)).isTurnActive, true); assert.deepEqual(rewindBusyOf(state(&quot;completed&quot;)), { isTurnActive: false, reverting: false, hasPendingRequest: false })</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/prompt-history/thread-inputs.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/regexp.test.ts

**Independent source (1):** ECMAScript RegExp literal syntax; documented Unicode-regex hyphen regression in regexp.ts.

**Contract / recognizable regressions (2):** Literal user text stays literal and remains valid in Unicode regexes. A dot can match arbitrary text or a hyphenated skill/path can make Unicode regex construction throw.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** regexp.ts; composer path removal, skill mentions, HTML self-link rewriting.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Domain callers cannot cover every metacharacter across all consumers; one literal negative case and a full literal fixture protect the shared escaping boundary. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L6: <code>escapes every metacharacter so the escaped form matches the literal</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(new RegExp(`^(?:${escapeRegExp(literal)})$`, &quot;u&quot;).test(literal), true); assert.equal(new RegExp(escapeRegExp(&quot;a.b&quot;)).test(&quot;axb&quot;), false)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/regexp.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/repo-groups.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §1.

**Contract / recognizable regressions (2):** Projects group/search/collapse by canonical repository, with stable labels and the right clone URL. Clones can split or merge incorrectly, searches can hide matching projects, active groups can remain collapsed, clone actions can use the wrong origin or input sorting can corrupt shared state.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** repo-groups.ts; Sidebar project tree.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** API repository normalization tests do not protect client grouping, label/collapse/search selection and active-project URL choice. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L52: <code>projects with a repoKey group by it; the rest are other projects, all by name</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( groups.map((g) =&gt; [g.label, names(g.projects)]), [ [&quot;JasperRaccoon/JasperEditor&quot;, [&quot;JasperEditor&quot;, &quot;JasperEditor2&quot;]], [&quot;JasperRaccoon/JasperEngine&quot;, [&quot;JasperEngine&quot;, &quot;Multiplayer&quot;, &quot;Shader optimization&quot;]] ] ); assert.deepEqual(names(other), [&quot;Aaaaa&quot;, &quot;CRYPTORISK&quot;])</code> |
| L65: <code>a repo with one clone still gets a group</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(groups.map((g) =&gt; [g.repoKey, names(g.projects)]), [[&quot;gitlab.com/me/solo&quot;, [&quot;solo&quot;]]]); assert.deepEqual(names(other), [&quot;plain&quot;])</code> |
| L76: <code>the default label is the first project&#x27;s repoName, else the key without its host</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(groups[0]?.defaultLabel, &quot;O/R&quot;); assert.equal(bare.groups[0]?.defaultLabel, &quot;team/sub/repo&quot;)</code> |
| L94: <code>a custom label is shown and drives the natural, case-insensitive order</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( groups.map((g) =&gt; [g.label, g.defaultLabel]), [ [&quot;Engine 10&quot;, &quot;JasperRaccoon/JasperEngine&quot;], [&quot;zeta editor&quot;, &quot;JasperRaccoon/JasperEditor&quot;] ] ); assert.deepEqual(numeric.groups.map((g) =&gt; g.label), [&quot;Repo 9&quot;, &quot;repo 10&quot;])</code> |
| L117: <code>equal labels fall back to the repo key</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(groups.map((g) =&gt; g.repoKey), [EDITOR, ENGINE])</code> |
| L127: <code>a search on the label or key shows the whole group; on project names only those</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( byLabel.groups.map((g) =&gt; [g.repoKey, names(g.projects)]), [[ENGINE, [&quot;JasperEngine&quot;, &quot;Multiplayer&quot;, &quot;Shader optimization&quot;]]] ); assert.deepEqual(names(byLabel.other), [])</code> |
| L149: <code>a saved collapse holds until a search or the open project pins the group open</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(plain.groups.map((g) =&gt; g.collapsed), [true, true]); assert.deepEqual(searching.groups.map((g) =&gt; [g.collapsed, g.pinnedOpen]), [ [false, true], [false, true] ])</code> |
| L167: <code>the clone URL prefers the active project&#x27;s, else the first by name that has one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(first?.cloneUrl, &quot;https://github.com/JasperRaccoon/JasperEngine.git&quot;); assert.equal(active?.cloneUrl, &quot;git@github.com:JasperRaccoon/JasperEngine.git&quot;)</code> |
| L179: <code>the input list is not reordered</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(names(PROJECTS), before)</code> |
| L185: <code>a project matches the search by its name or its repo&#x27;s shown label, owner or key</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(projectMatchesQuery(&quot;multi&quot;, multiplayer, new Map())); assert.ok(projectMatchesQuery(&quot;jasperraccoon&quot;, multiplayer, new Map()), &quot;the owner in the default label&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/repo-groups.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/repo-identities/errors.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §§3,3a; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Repo identity/image parsing, authenticated versioned image caching, upload-size/type limits, and mutation/error propagation. An old identity can return after deletion, a stale blob URL can leak or be published, an upload can exceed the cap, valid Safari PNG can be refused, or the daemon’s actual failure can be hidden.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** repo-identities/store.ts, icon-images.ts, shrink.logic.ts, errors.ts; RepoIcon/Dialog and grouping UI consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Server icon checks cannot protect the client’s version/read/reset races or canvas preparation decisions. Geometry limits are explicitly specified in §3a; the unrelated byte-size copy helper test is deleted. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L9: <code>prefers the daemon&#x27;s own message</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal( repoIdentityErrorText(apiError(502, { code: &quot;FAVICON_UNREACHABLE&quot; }, &quot;Couldn&#x27;t reach a.com (timeout).&quot;), &quot;a.com&quot;), &quot;Couldn&#x27;t reach a.com (timeout).&quot; )</code> |
| L16: <code>maps a refusal code without a message to friendly text naming the domain</code> | REWRITE | The repo-icon spec requires the failure type and domain. Retains those data with loose matching rather than exact sentence/punctuation snapshots. Oracle: <code>assert.equal(repoIdentityErrorText(apiError(502, { code: &quot;FAVICON_UNREACHABLE&quot; }), &quot;matssmile.com&quot;), &quot;Couldn&#x27;t reach matssmile.com.&quot;); assert.equal(repoIdentityErrorText(apiError(404, { code: &quot;FAVICON_NOT_FOUND&quot; }), &quot;matssmile.com&quot;), &quot;No icon found on matssmile.com.&quot;)</code> |
| L23: <code>falls back on the status, then the error&#x27;s message</code> | REWRITE | Keeps unsupported-route/status information and the actual injected network error; removes the generic no-error fallback sentence snapshot. Oracle: <code>assert.match(repoIdentityErrorText(apiError(404)), /doesn&#x27;t support repo icons/); assert.equal(repoIdentityErrorText(apiError(500)), &quot;The daemon refused the change (500).&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/repo-identities/errors.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/repo-identities/icon-images.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §§3,3a; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Repo identity/image parsing, authenticated versioned image caching, upload-size/type limits, and mutation/error propagation. An old identity can return after deletion, a stale blob URL can leak or be published, an upload can exceed the cap, valid Safari PNG can be refused, or the daemon’s actual failure can be hidden.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** repo-identities/store.ts, icon-images.ts, shrink.logic.ts, errors.ts; RepoIcon/Dialog and grouping UI consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Server icon checks cannot protect the client’s version/read/reset races or canvas preparation decisions. Geometry limits are explicitly specified in §3a; the unrelated byte-size copy helper test is deleted. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L71: <code>fetches once per version and shares one typed blob URL</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(reads.length, 1); assert.equal(getRepoIconImage(KEY)?.status, &quot;loading&quot;)</code> |
| L89: <code>revokes the URL when the version changes or the identity goes away</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(revoked, [&quot;blob:test/0&quot;]); assert.equal(getRepoIconImage(KEY), undefined)</code> |
| L105: <code>aborts a fetch overtaken by a new version and never publishes it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(reads[0].signal?.aborted, true); assert.equal(created.length, 0)</code> |
| L116: <code>does not fetch a version that is not the repo&#x27;s current icon</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(reads.length, 0)</code> |
| L124: <code>remembers a failure per version, and retries after the next load</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIconImage(KEY)?.status, &quot;failed&quot;); assert.equal(reads.length, 1)</code> |
| L146: <code>a connection reset revokes everything</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(revoked, [&quot;blob:test/0&quot;]); assert.equal(getRepoIconImage(KEY), undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/repo-identities/icon-images.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/repo-identities/shrink.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §§3,3a; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Repo identity/image parsing, authenticated versioned image caching, upload-size/type limits, and mutation/error propagation. An old identity can return after deletion, a stale blob URL can leak or be published, an upload can exceed the cap, valid Safari PNG can be refused, or the daemon’s actual failure can be hidden.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** repo-identities/store.ts, icon-images.ts, shrink.logic.ts, errors.ts; RepoIcon/Dialog and grouping UI consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Server icon checks cannot protect the client’s version/read/reset races or canvas preparation decisions. Geometry limits are explicitly specified in §3a; the unrelated byte-size copy helper test is deleted. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L19: <code>an upload type within the cap</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(canSendUnchanged(type, 1000), true, type); assert.equal(canSendUnchanged(type, REPO_ICON_MAX_BYTES), true, type)</code> |
| L26: <code>re-encodes on size</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(canSendUnchanged(&quot;image/png&quot;, OVER), false); assert.equal(canSendUnchanged(&quot;image/svg+xml&quot;, OVER), false)</code> |
| L31: <code>re-encodes on type</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(canSendUnchanged(type, 100), false, type)</code> |
| L39: <code>fits the longest side into 512 and keeps the aspect</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(initialShrinkSize(4000, 3000), { width: 512, height: 384 }); assert.deepEqual(initialShrinkSize(1000, 4000), { width: 128, height: 512 })</code> |
| L44: <code>never upscales</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(initialShrinkSize(100, 50), { width: 100, height: 50 }); assert.deepEqual(initialShrinkSize(512, 512), { width: 512, height: 512 })</code> |
| L49: <code>keeps a sliver at least one pixel wide</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(initialShrinkSize(10000, 2), { width: 512, height: 1 })</code> |
| L57: <code>is done once the result fits</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(nextShrinkStep(webp, REPO_ICON_MAX_BYTES), { kind: &quot;done&quot; })</code> |
| L61: <code>lowers WebP quality in steps to 0.6, then halves the dimensions</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(step.kind, &quot;encode&quot;); assert.deepEqual(step.attempt, { ...attempt, width: 256, height: 256 })</code> |
| L78: <code>PNG has no quality to lower: it halves at once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(nextShrinkStep(png, OVER), { kind: &quot;encode&quot;, attempt: { ...png, width: 200, height: 150 } })</code> |
| L83: <code>halves down to 64px and gives up below it</code> | REWRITE | Retains the explicitly specified 64px termination and too-large error, using the literal specified error instead of importing the same production constant as the oracle. Oracle: <code>assert.deepEqual(nextShrinkStep(at128, OVER), { kind: &quot;encode&quot;, attempt: { ...at128, width: 64, height: 50 } }); assert.deepEqual(nextShrinkStep(at64, OVER), { kind: &quot;give-up&quot;, reason: IMAGE_TOO_LARGE })</code> |
| L92: <code>encodedFormat accepts what the browser may produce for WebP</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(encodedFormat(&quot;image/webp&quot;), &quot;image/webp&quot;); assert.equal(encodedFormat(&quot;image/png&quot;), &quot;image/png&quot;)</code> |
| L99: <code>formatBytes reads like the dialog&#x27;s note</code> | DELETE | Fails independent-contract and refactor-resistance bars: incidental MB/KB/B rounding/copy has no requirement. Upload byte/type/resize/termination contracts remain; formatBytes stays because real dialog callers use it. Oracle: <code>assert.equal(formatBytes(6.3 * 1024 * 1024), &quot;6.3 MB&quot;); assert.equal(formatBytes(84 * 1024), &quot;84 KB&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/repo-identities/shrink.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/repo-identities/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §§3,3a; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Repo identity/image parsing, authenticated versioned image caching, upload-size/type limits, and mutation/error propagation. An old identity can return after deletion, a stale blob URL can leak or be published, an upload can exceed the cap, valid Safari PNG can be refused, or the daemon’s actual failure can be hidden.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** repo-identities/store.ts, icon-images.ts, shrink.logic.ts, errors.ts; RepoIcon/Dialog and grouping UI consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Server icon checks cannot protect the client’s version/read/reset races or canvas preparation decisions. Geometry limits are explicitly specified in §3a; the unrelated byte-size copy helper test is deleted. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L79: <code>keeps a well-formed identity and repairs bad fields one by one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeRepoIdentity(identity()), identity()); assert.deepEqual( sanitizeRepoIdentity({ ...identity(), icon: { kind: &quot;sticker&quot; }, extra: 1 }), identity() )</code> |
| L97: <code>drops what cannot be trusted</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeRepoIdentity(null), null); assert.equal(sanitizeRepoIdentity({ ...identity(), repoKey: &quot;/home/me/repo&quot; }), null)</code> |
| L110: <code>repoLabelOf falls back to the remote&#x27;s name</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(repoLabelOf(map, KEY, &quot;JasperRaccoon/JasperEngine&quot;), &quot;Engine&quot;); assert.equal(repoLabelOf(map, OTHER, &quot;JasperRaccoon/orquester&quot;), &quot;JasperRaccoon/orquester&quot;)</code> |
| L118: <code>apply a change and a delete; ignore malformed and unknown ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;); assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;)</code> |
| L130: <code>never go backwards by updatedAt</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;New&quot;); assert.equal(getRepoIdentity(KEY)?.label, &quot;Newer&quot;)</code> |
| L138: <code>a stale answer does not bring a deleted identity back; a newer one does</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY), undefined); assert.equal(getRepoIdentity(KEY)?.label, &quot;Again&quot;)</code> |
| L147: <code>applyRepoIdentity ignores an identity for another repo</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0)</code> |
| L154: <code>replace the map with the validated list</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual([...held().keys()], [KEY]); assert.equal(repoIdentitiesStore.getState().loads, 1)</code> |
| L164: <code>reject on a broken outer shape and keep what is held</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(load, /unexpected shape/); assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;)</code> |
| L173: <code>an answer never undoes a change that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(getRepoIdentity(KEY)?.icon, { kind: &quot;emoji&quot;, value: &quot;🦝&quot; }); assert.equal(getRepoIdentity(OTHER), undefined)</code> |
| L189: <code>an untouched repo takes the list as it is (a reload repairs it)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;Real&quot;)</code> |
| L198: <code>an older load answering after a newer one is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;Second&quot;)</code> |
| L211: <code>a reset drops the map and every answer in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0); assert.equal(held().size, 0)</code> |
| L225: <code>a load through another connection&#x27;s client resets first</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0); assert.deepEqual([...held().keys()], [OTHER])</code> |
| L239: <code>a reset also forgets deletions</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;)</code> |
| L249: <code>apply and return the answered identity; null removes it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(mutations[0].args, [{ repoKey: KEY, domain: &quot;matssmile.com&quot; }]); assert.deepEqual(await favicon, answered)</code> |
| L264: <code>reject with the daemon&#x27;s error and change nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(emoji, refusal); assert.equal(getRepoIdentity(KEY)?.label, &quot;Engine&quot;)</code> |
| L274: <code>an answer that does not parse reloads the list</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(await emoji, null); assert.equal(lists.length, 1)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/repo-identities/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/resume-account.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §5.3; AGENTS.md preserve provider resume identity in its account home.

**Contract / recognizable regressions (2):** Resumption uses the transcript-owning managed account while system/legacy rows respect caller/default selection. A conversation can resume under a signed-out or different account home and fail authentication/lose identity.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** resume-account.ts; history/new-tab resume launchers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Adapter-home preservation tests do not protect which account the client asks the daemon to launch. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L15: <code>forces the managed account whose own home holds the transcript</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resumeAccountId(row({ home: &quot;account&quot;, accountId: &quot;acc-1&quot; }), &quot;acc-2&quot;), &quot;acc-1&quot;)</code> |
| L19: <code>a system-home row with no preference is left to the daemon&#x27;s per-agent default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(accountId, undefined); assert.notEqual(accountId, SYSTEM_ACCOUNT_ID)</code> |
| L29: <code>a system-home row honours the caller&#x27;s selection, System included</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resumeAccountId(row({ home: &quot;system&quot; }), &quot;acc-2&quot;), &quot;acc-2&quot;); assert.equal(resumeAccountId(row({ home: &quot;system&quot; }), SYSTEM_ACCOUNT_ID), SYSTEM_ACCOUNT_ID)</code> |
| L34: <code>a row from a daemon predating attribution falls back to the caller&#x27;s choice</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resumeAccountId(row({}), &quot;acc-2&quot;), &quot;acc-2&quot;); assert.equal(resumeAccountId(row({})), undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/resume-account.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/saved-prompts/list.logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (saved prompts/right rail); docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md (repository-shared prompts); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Saved prompt scope/search, variable labels, list/load/event convergence, mutation rollback, and connection isolation. Foreign-project prompts can appear, a clone can lose repository context, an edited prompt can stay stale in search, a late list can resurrect deletion, or a failed optimistic pin can remain on screen.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** saved-prompts/list.logic.ts, variables.ts, store.ts; rail prompt list/editor and app router consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon CRUD cannot protect client visibility, search cache invalidation, optimistic state or concurrent API/event handling; each named scenario varies a meaningful scope, failure or ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L38: <code>the project can use every global prompt and its own, never another project&#x27;s</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(promptsForProject(list, PROJECT)), [&quot;global&quot;, &quot;mine&quot;]); assert.deepEqual(ids(promptsForProject(list, &quot;&quot;)), [&quot;global&quot;], &quot;no project: global only&quot;)</code> |
| L43: <code>All is global + this project&#x27;s; Project is this project&#x27;s only</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed(list), [&quot;global&quot;, &quot;mine&quot;]); assert.deepEqual(listed(list, &quot;&quot;, &quot;project&quot;), [&quot;mine&quot;])</code> |
| L49: <code>both filters include matching repository prompts from other folders</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(visible), [&quot;global&quot;, &quot;shared&quot;, &quot;folder&quot;]); assert.deepEqual(ids(sections.others), scope === &quot;all&quot; ? [&quot;folder&quot;, &quot;global&quot;, &quot;shared&quot;] : [&quot;folder&quot;, &quot;shared&quot;])</code> |
| L74: <code>folds the letters no decomposition takes apart: ł, ø, ß and their capitals</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed([entry], query), [&quot;p&quot;], query)</code> |
| L81: <code>matches title, description, tags and body, case- and accent-insensitively</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed([entry], query), [&quot;p&quot;], query); assert.deepEqual(listed([entry], &quot;missing&quot;), [])</code> |
| L95: <code>every word must match, each anywhere</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed([entry], &quot;fix root&quot;), [&quot;p&quot;], &quot;title word + body word&quot;); assert.deepEqual(listed([entry], &quot;fix deploy&quot;), [])</code> |
| L102: <code>an edited record is searched by its new text</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed([before], &quot;alpha&quot;), [&quot;p&quot;]); assert.deepEqual(listed([after], &quot;alpha&quot;), [])</code> |
| L111: <code>favorites are separated from unpinned prompts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(ids(sections.pinned), [&quot;favorite&quot;]); assert.deepEqual(ids(sections.others), [&quot;ordinary&quot;])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/saved-prompts/list.logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/saved-prompts/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (saved prompts/right rail); docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md (repository-shared prompts); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Saved prompt scope/search, variable labels, list/load/event convergence, mutation rollback, and connection isolation. Foreign-project prompts can appear, a clone can lose repository context, an edited prompt can stay stale in search, a late list can resurrect deletion, or a failed optimistic pin can remain on screen.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** saved-prompts/list.logic.ts, variables.ts, store.ts; rail prompt list/editor and app router consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon CRUD cannot protect client visibility, search cache invalidation, optimistic state or concurrent API/event handling; each named scenario varies a meaningful scope, failure or ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L129: <code>repairs optional fields and refuses what cannot be trusted</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state().prompts.get(&quot;a&quot;), { id: &quot;a&quot;, title: &quot;T&quot;, description: &quot;&quot;, body: &quot;B&quot;, tags: [], projectPath: null, pinned: false, createdAt: &quot;&quot;, updatedAt: &quot;&quot;, lastUsedAt: null, useCount: 0 }); assert.deepEqual(state().prompts.get(&quot;tags&quot;)?.tags, [&quot;x&quot;, &quot;y&quot;])</code> |
| L163: <code>keeps who created a prompt and the workflows that use it (unified MCP D-16); anything else reads as the user&#x27;s</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state().prompts.get(&quot;agent&quot;)?.createdBy, { kind: &quot;agent&quot;, threadId: &quot;t1&quot;, agent: &quot;codex&quot;, title: &quot;Plan&quot; }); assert.deepEqual(state().prompts.get(&quot;agent&quot;)?.usedByWorkflows, [{ workflowId: &quot;w1&quot;, name: &quot;Nightly&quot; }])</code> |
| L186: <code>loads repository context for clone filters and applies live edits and deletes by shared id</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(visible(clone), [shared]); assert.deepEqual(visible(clone), [edited])</code> |
| L211: <code>a clone refresh drops missing repository records and keeps context after a failed refresh</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().loads[KEY]?.projectRepoKey, shared.repoKey); assert.deepEqual(held(), [shared.id])</code> |
| L227: <code>shares concurrent loads and refreshes only when stale or forced</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().loads[KEY]?.status, &quot;loading&quot;); assert.deepEqual(api.listCalls, [PROJECT], &quot;one request for both callers&quot;)</code> |
| L244: <code>no project loads the global list alone</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [null]); assert.equal(savedPromptsLoadKey(&quot;&quot;), savedPromptsLoadKey(null))</code> |
| L252: <code>a reload replaces exactly its scope: what the daemon dropped goes, another project&#x27;s stays</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;other&quot;, &quot;p&quot;])</code> |
| L267: <code>an event that overtakes the load answer it is newer than survives the answer</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;g&quot;, &quot;new&quot;])</code> |
| L280: <code>an answer never brings back a prompt deleted meanwhile, nor overwrites a newer copy</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;edited&quot;]); assert.equal(state().prompts.get(&quot;edited&quot;)?.title, &quot;New&quot;)</code> |
| L299: <code>an id nothing touched during the load takes the answer as-is, even stamped older</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().prompts.get(&quot;a&quot;)?.title, &quot;Truth&quot;, &quot;a reload repairs it&quot;)</code> |
| L311: <code>a first load that fails is an error; a failed refresh keeps the rows beside the error</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state().loads[KEY], { status: &quot;error&quot;, error: &quot;disk full&quot;, refreshing: false, stale: false }); assert.equal(state().loads[KEY]?.status, &quot;loaded&quot;, &quot;an error is retried on the next load&quot;)</code> |
| L330: <code>a forced load asked while one is in flight asks again after it — once, for every such call</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [PROJECT, PROJECT]); assert.deepEqual(held(), [&quot;late&quot;])</code> |
| L348: <code>a project list the daemon refuses (400) falls back to the global list, and says why</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [PROJECT, null], &quot;then the global list on its own&quot;); assert.deepEqual(held(), [&quot;g&quot;], &quot;the global prompts stay usable&quot;)</code> |
| L372: <code>any other failure of a project list does not fall back</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [PROJECT])</code> |
| L380: <code>an answer of the wrong shape is a load error, not a crash</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().loads[KEY]?.status, &quot;error&quot;)</code> |
| L390: <code>a malformed row is dropped, the rest of the answer kept</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;ok&quot;])</code> |
| L400: <code>stale marks a reconnect: the rows stay and the next load refreshes in the background</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().loads[KEY]?.stale, true); assert.equal(state().loads[KEY]?.status, &quot;loaded&quot;, &quot;no loading state over rows&quot;)</code> |
| L418: <code>a load that crosses a reconnect asks once more, then is fresh</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [PROJECT, PROJECT]); assert.deepEqual(held(), [&quot;late&quot;])</code> |
| L440: <code>a failed load that crossed a reconnect retries once, not forever</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(api.listCalls, [PROJECT, PROJECT]); assert.equal(state().loads[KEY]?.status, &quot;error&quot;)</code> |
| L458: <code>an older record never replaces a newer one; a later use does</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().prompts.get(&quot;a&quot;)?.title, &quot;New&quot;); assert.equal(state().prompts.get(&quot;a&quot;)?.useCount, 1)</code> |
| L481: <code>a delete removes, and nothing brings the id back</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), []); assert.deepEqual(held(), [], &quot;a late upsert of a deleted id is dropped&quot;)</code> |
| L490: <code>malformed payloads and unknown types are ignored without a throw</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;keep&quot;])</code> |
| L502: <code>an update applies its answer; a delete removes and tombstones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(updated.ok, true); assert.equal(state().prompts.get(&quot;a&quot;)?.title, &quot;Renamed&quot;)</code> |
| L520: <code>a failed change becomes the notice and reloads every loaded scope</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(result, { ok: false, error: &quot;Prompt not found&quot; }); assert.match(state().notice ?? &quot;&quot;, /Prompt not found/)</code> |
| L534: <code>a quiet failure leaves the notice to the caller</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(result, { ok: false, error: &quot;Title is required&quot; }); assert.equal(state().notice, null)</code> |
| L542: <code>a pin shows at once, then carries the daemon&#x27;s record</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().pinOverrides.get(&quot;a&quot;), true); assert.equal(shown.pinned, true, &quot;shown pinned before the daemon answers&quot;)</code> |
| L559: <code>a refused pin falls back to the held value, with the notice</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, false); assert.equal(state().pinOverrides.size, 0)</code> |
| L571: <code>two quick flips: only the latest answer clears the flip</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( api.updates.map((entry) =&gt; entry.patch), [{ pinned: true }, { pinned: false }] ); assert.equal(state().pinOverrides.get(&quot;a&quot;), false, &quot;still shows the second flip&quot;)</code> |
| L594: <code>a use bumps the record; a failed bump is silent and reloads nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().prompts.get(&quot;a&quot;)?.useCount, 1); assert.equal(result.ok, false)</code> |
| L610: <code>forgets everything, and an answer from before it is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(state().prompts.size, 0); assert.deepEqual(state().loads, {})</code> |
| L630: <code>a client of another connection starts over</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(held(), [&quot;b&quot;])</code> |
| L641: <code>a mutation answered after a reset is not applied</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, false); assert.equal(state().prompts.size, 0)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/saved-prompts/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/saved-prompts/variables.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md (saved prompts/right rail); docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md (repository-shared prompts); packages/api/src/index.ts and packages/api/src/agent-chat wire contracts; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Saved prompt scope/search, variable labels, list/load/event convergence, mutation rollback, and connection isolation. Foreign-project prompts can appear, a clone can lose repository context, an edited prompt can stay stale in search, a late list can resurrect deletion, or a failed optimistic pin can remain on screen.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** saved-prompts/list.logic.ts, variables.ts, store.ts; rail prompt list/editor and app router consume results.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon CRUD cannot protect client visibility, search cache invalidation, optimistic state or concurrent API/event handling; each named scenario varies a meaningful scope, failure or ordering. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L7: <code>renders both as empty without a target chat</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( await resolveSavedPrompt({ body: &quot;[{agent}&#124;{model}]&quot;, projectPath: &quot;/w/acme/app&quot;, sessionId: null, agentLabel: &quot;Claude&quot;, modelLabel: &quot;Opus&quot;, api: { gitStatus: async () =&gt; { throw new Error(&quot;Unexpected git read&quot;);</code> |
| L18: <code>labels an agent by its registry name and a model by its catalogue name, else the raw id</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(agentLabelFor(&quot;claude&quot;, [{ id: &quot;claude&quot;, name: &quot;Claude Code&quot; }]), &quot;Claude Code&quot;); assert.equal(agentLabelFor(&quot;mystery&quot;, [{ id: &quot;claude&quot;, name: &quot;Claude Code&quot; }]), &quot;mystery&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/saved-prompts/variables.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/search-options.test.ts

**Independent source (1):** README.md Files/search (ignore toggle); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Search ignores are off by default, compatible with old records, and persist independently per project. Reload can expose ignored files unexpectedly, older storage can crash the search or one project’s toggle can contaminate another.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** search-options.ts; file browser content/name search.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon search filtering cannot establish localStorage migration, default toggle state and project isolation. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L33: <code>gitignored files are hidden by default</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loadSearchOptions(&quot;/p&quot;).includeIgnored, false)</code> |
| L38: <code>a record written before includeIgnored existed loads with it off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(options.includeIgnored, false); assert.equal(options.caseSensitive, true)</code> |
| L46: <code>includeIgnored persists per project</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loadSearchOptions(&quot;/a&quot;).includeIgnored, true); assert.equal(loadSearchOptions(&quot;/b&quot;).includeIgnored, false)</code> |
| L53: <code>a non-boolean includeIgnored is treated as off</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(loadSearchOptions(&quot;/p&quot;).includeIgnored, false)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/search-options.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/secret-files/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md (revision/content-token compatibility and non-destructive clone actions); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Vault wire/path validation, per-workspace identity, daemon-boot sequencing, stale-load/delete protection, and content-token conflict recovery. Stale boot/list/detail/mutation answers can resurrect a deleted vault or hide modified clones; unsafe paths can reach actions; a content change can be overwritten without a refresh.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** secret-files/store.ts; SecretFilesDialog, hooks and app router consume its state.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon disk/token tests cannot protect the UI’s independently concurrent list/detail/event/mutation streams and connection resets. Revision, legacy timestamp and boot-identity cases cover different persisted wire versions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L121: <code>keeps a well-formed vault as it is</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeSecretVault(vault()), vault())</code> |
| L125: <code>refuses a vault without a usable identity</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sanitizeSecretVault(null), null); assert.equal(sanitizeSecretVault({ ...vault(), workspace: &quot;../etc&quot; }), null)</code> |
| L133: <code>repairs bad fields one by one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeSecretVault(raw), { workspace: WS, repoKey: KEY, fileCount: 1, clonesNeedingAttention: 1, newCandidates: 1, updatedAt: at(1), files: [{ path: &quot;b/.env&quot;, version: &quot;v2&quot;, updatedAt: at(1), updatedBy: { kind: &quot;</code> |
| L187: <code>keeps the revision and content tokens, leaving out malformed ones field-wise</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(sanitizeSecretVault(withTokens), withTokens); assert.ok(clean)</code> |
| L222: <code>validates a setup scan, dropping malformed candidates and variants</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(scan, { workspace: WS, repoKey: KEY, clones: [ { projectPath: &quot;/ws/a&quot;, projectName: &quot;a&quot; }, { projectPath: &quot;/ws/b&quot;, projectName: &quot;b&quot; } ], candidates: [ { path: &quot;x/.env&quot;, conventional: true, managed: false, excluded; assert.throws(() =&gt; sanitizeSecretFileCandidates({ clones: [] }), /unexpected shape/)</code> |
| L275: <code>applies a vault, ignores one for another repo or a malformed one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0)); assert.equal(getSecretVault(WS, OTHER), undefined)</code> |
| L285: <code>never goes backwards, but takes a same-time change</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.fileCount, 1); assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 1)</code> |
| L293: <code>orders by revision when both copies carry one, whatever updatedAt says</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 2); assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 2)</code> |
| L310: <code>falls back to updatedAt when either copy lacks a revision</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.fileCount, 1); assert.equal(getSecretVault(WS, KEY)?.fileCount, 5)</code> |
| L320: <code>a deleted vault is not brought back by a copy of no newer revision</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY), undefined); assert.equal(getSecretVault(WS, KEY)?.revision?.seq, 6)</code> |
| L329: <code>once a newer boot is seen, a late answer from an older one is dropped — it never resurrects a deleted vault</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 2); assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 2)</code> |
| L357: <code>a load&#x27;s answers from a superseded boot keep what is held</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 1); assert.equal(getSecretVault(WS, KEY)?.revision?.boot, &quot;b2&quot;)</code> |
| L370: <code>routes changed and deleted events, ignoring malformed or foreign ones</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.ok(getSecretVault(WS, KEY)); assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0))</code> |
| L382: <code>a deleted vault is not brought back by an answer no newer than it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY), undefined); assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(6))</code> |
| L391: <code>keys vaults per workspace</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 2); assert.ok(held().has(vaultKey(&quot;other&quot;, KEY)))</code> |
| L400: <code>replaces the map with every vault&#x27;s detail</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(details.length, 1); assert.deepEqual(details[0].args.slice(0, 2), [WS, KEY])</code> |
| L413: <code>leaves out a vault deleted between list and detail; keeps one whose detail failed otherwise</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY), undefined); assert.ok(getSecretVault(WS, OTHER))</code> |
| L429: <code>rejects an answer in another shape and changes nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(load, /unexpected shape/); assert.ok(getSecretVault(WS, KEY))</code> |
| L438: <code>a load&#x27;s answer does not undo a mutation that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.fileCount, 3)</code> |
| L452: <code>a load&#x27;s older answer does not undo a clone-state event that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.clones[0].files[0].state, &quot;modified&quot;); assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 1)</code> |
| L479: <code>without revisions, a load&#x27;s same-time answer does not undo an event that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.clonesNeedingAttention, 1)</code> |
| L491: <code>a load&#x27;s strictly newer answer replaces an event that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY)?.fileCount, 3)</code> |
| L502: <code>a fetch&#x27;s older answer does not undo an event that landed while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await fetching)?.clonesNeedingAttention, 1); assert.equal((await again)?.clonesNeedingAttention, 1)</code> |
| L516: <code>a load&#x27;s answer does not bring back a vault deleted while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getSecretVault(WS, KEY), undefined)</code> |
| L527: <code>an older load&#x27;s late answer is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(details.length, 0); assert.equal(held().size, 0)</code> |
| L539: <code>a load through another connection&#x27;s client resets first, and the old answer is dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0); assert.equal(one.details.length, 0)</code> |
| L554: <code>a reset drops answers still in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0)</code> |
| L565: <code>fetching one vault applies it, and a 404 removes it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await first)?.updatedAt, at(0)); assert.equal(await second, null)</code> |
| L576: <code>a fetch&#x27;s 404 does not remove a vault set up while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await fetching)?.updatedAt, at(4))</code> |
| L586: <code>a fetch&#x27;s answer does not bring back a vault deleted while it was in flight</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(await fetching, null); assert.equal(getSecretVault(WS, KEY), undefined)</code> |
| L595: <code>a fetch&#x27;s other failure rejects</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(fetching, /boom/)</code> |
| L604: <code>push and reset apply the answered vault and return it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(mutations[0].args, [req]); assert.equal((await push).updatedAt, at(2))</code> |
| L618: <code>setup and update apply their answers; delete removes</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(getSecretVault(WS, KEY)?.excluded, [&quot;MatsSmileBack/.env&quot;]); assert.deepEqual(mutations[2].args, [WS, KEY])</code> |
| L639: <code>rejects with the daemon&#x27;s error and changes nothing</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(push, (error) =&gt; error === failure); assert.equal(getSecretVault(WS, KEY)?.updatedAt, at(0))</code> |
| L649: <code>passes expect through, and on CONTENT_CHANGED fetches the vault again and rejects</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(mutations[0].args, [req]); assert.equal(isContentChangedError(failure), true)</code> |
| L674: <code>an answer that does not parse reloads, and resolves with what is held</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await push).updatedAt, at(0)); assert.equal(lists.length, 1)</code> |
| L686: <code>an answer that a connection switch overtook is not applied</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(held().size, 0)</code> |
| L695: <code>the scan is validated before it is returned</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(mutations[0].args.slice(0, 3), [WS, KEY, &quot;deploy/targets.conf&quot;]); assert.deepEqual(await scan, answer)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/secret-files/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/server-version.test.ts

**Independent source (1):** README.md deployment (/api/info version and commit); packages/api ServerInfoResponse.

**Contract / recognizable regressions (2):** About shows server version/short commit when available and handles older daemons without them. The UI can show the wrong revision, a malformed commit or an undefined/blank label against an older daemon.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** server-version.ts; GeneralSettings About.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon build-info tests establish emitted values; this client-specific projection handles optional/legacy data separately. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L5: <code>serverVersionLabel shows the version and short commit, either alone, or nothing</code> | REWRITE | Keeps version/commit data, abbreviation and absent/legacy handling; removes the incidental separator between them. Oracle: <code>assert.equal(serverVersionLabel({ version: &quot;1.2.3&quot;, commit: sha }), &quot;1.2.3 · 0123456&quot;); assert.equal(serverVersionLabel({ version: &quot;1.2.3&quot;, commit: null }), &quot;1.2.3&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/server-version.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-deep-link.test.ts

**Independent source (1):** README.md push notifications; apps/web/public/sw.js open-session message and URL contract.

**Contract / recognizable regressions (2):** External session links validate id, consume once, resolve the actual non-archived project and preserve recoverable failures. A click can open another project, navigate archived sessions, replay on reload, accept malformed ids or suppress reconnect-retry failures.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-deep-link.ts; web/native notification hosts.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Service-worker tests protect sending; this suite owns client receipt, pending intent and daemon-backed project resolution. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L20: <code>parses ?session=</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseSessionDeepLink(`?session=${ID}`), { sessionId: ID }); assert.deepEqual(parseSessionDeepLink(&quot;session=s-1&amp;x=2&quot;), { sessionId: &quot;s-1&quot; })</code> |
| L30: <code>strips its parameter and keeps the rest</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(stripSessionDeepLink(`https://o.example.com/?session=${ID}`), &quot;/&quot;); assert.equal(stripSessionDeepLink(&quot;https://o.example.com/app?x=1&amp;session=s#h&quot;), &quot;/app?x=1#h&quot;)</code> |
| L36: <code>parses the service worker&#x27;s message; anything else is null</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseSessionOpenMessage({ type: &quot;orquester:open-session&quot;, sessionId: ID }), { sessionId: ID }); assert.equal(parseSessionOpenMessage({ type: &quot;orquester:open-workflow-run&quot;, sessionId: ID }), null)</code> |
| L45: <code>one pending link, taken once, listeners told</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(told, 2); assert.deepEqual(pendingSessionDeepLink(), { sessionId: &quot;b&quot; })</code> |
| L81: <code>opens the session in its own project</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await resolveSessionDeepLink(api, ID), { kind: &quot;open&quot;, sessionId: ID, project }); assert.deepEqual(asked, [&quot;main&quot;], &quot;archived workspaces are not listed&quot;)</code> |
| L87: <code>says so when the session is gone</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await resolveSessionDeepLink(api, ID), { kind: &quot;gone&quot;, message: &quot;That session no longer exists.&quot; })</code> |
| L92: <code>does not open a session behind the archived curtain</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(target.kind, &quot;gone&quot;, projectPath)</code> |
| L100: <code>a session without a project, or a project list that failed, is not opened</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal((await resolveSessionDeepLink(bare.api, ID)).kind, &quot;gone&quot;); assert.deepEqual(await resolveSessionDeepLink(failing.api, ID), { kind: &quot;gone&quot;, message: &quot;Couldn&#x27;t open that session: its project could not be listed.&quot; })</code> |
| L110: <code>a failed session list throws (the host retries after a reconnect)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(resolveSessionDeepLink(api, ID), (error) =&gt; error === offline)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-deep-link.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-kind.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.2,5.3,7.1.

**Contract / recognizable regressions (2):** Chat/shell/legacy distinctions, installed/capable resume selection and protection of manual titles. Chats can vanish from agent surfaces, legacy PTYs can be mistaken for chat, unsupported resumes can be offered or a manual rename overwritten.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-kind.ts; overview, launcher, attention and title-seeding callers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Runtime creation tests cannot protect the shared frontend predicates; overview and menu intentionally use different installation/agent conditions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L8: <code>the three session kinds are classified without overlap</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( [shell, legacy, chat].map(isChatSession), [false, false, true] ); assert.deepEqual( [shell, legacy, chat].map(isLegacyAgentTerminal), [false, true, false] )</code> |
| L42: <code>ProjectOverview offers a row only while its agent is installed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( offered(new Map([[&quot;claude&quot;, { enabled: true }], [&quot;codex&quot;, { enabled: true }]])), [&quot;c-claude&quot;, &quot;c-codex&quot;] ); assert.deepEqual( offered(new Map([[&quot;claude&quot;, { enabled: true }], [&quot;codex&quot;, { enabled: false }]])), [&quot;c-claude&quot;] )</code> |
| L60: <code>NewTabMenu lists a row under the agent that wrote it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(listed(&quot;claude&quot;), [&quot;c-claude&quot;]); assert.deepEqual(listed(&quot;codex&quot;), [&quot;c-codex&quot;])</code> |
| L67: <code>a conversation whose agent has no adapter is not offered</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isResumableByInstalledAgent(conversation({ agentRefId }), new Map([[agentRefId, { enabled: true }]])), false)</code> |
| L73: <code>only a title nobody chose may be overwritten by the seed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isDefaultThreadTitle(&quot;New thread&quot;, &quot;claude&quot;), true); assert.equal(isDefaultThreadTitle(&quot;Claude Code&quot;, &quot;claude&quot;), true)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-kind.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-profiles/chat-usage.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4,5,5.5,5.6; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Agent Profile availability, current/deleted identity labels, revision-safe edits, sanitized secrets, workflow delete guards, and remembered usage. A secret value can reach shared state, rapid edits can reuse stale revisions, a profile used by workflows can be deleted without the confirmed set, or a deleted/unready profile can silently appear as Global.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-profiles/store.ts, sanitize.ts, logic.ts, chat-usage.ts; profile library, editors, composer chip and workflow picker consume outputs.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon launch/profile storage tests do not protect UI edit serialization, preparation readiness, local selection labels or deletion confirmation data; the profile-id parser and counting have distinct semantics. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L26: <code>reads a chat tab&#x27;s profile and treats everything else as Global</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(sessionProfileIdOf(tab(&quot;a&quot;, { profileId: &quot;p1&quot; })), &quot;p1&quot;); assert.equal(sessionProfileIdOf(tab(&quot;b&quot;, { profileId: null })), null)</code> |
| L38: <code>counts the open chats launching with the profile</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(openChatsUsingProfile(sessions, &quot;p1&quot;), 2); assert.equal(openChatsUsingProfile(sessions, &quot;p2&quot;), 1)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-profiles/chat-usage.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-profiles/logic.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4,5,5.5,5.6; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Agent Profile availability, current/deleted identity labels, revision-safe edits, sanitized secrets, workflow delete guards, and remembered usage. A secret value can reach shared state, rapid edits can reuse stale revisions, a profile used by workflows can be deleted without the confirmed set, or a deleted/unready profile can silently appear as Global.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-profiles/store.ts, sanitize.ts, logic.ts, chat-usage.ts; profile library, editors, composer chip and workflow picker consume outputs.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon launch/profile storage tests do not protect UI edit serialization, preparation readiness, local selection labels or deletion confirmation data; the profile-id parser and counting have distinct semantics. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L44: <code>names the agent scope</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(scopeLabel(&quot;all&quot;), &quot;all agents&quot;); assert.equal(scopeLabel([&quot;claude&quot;]), &quot;Claude only&quot;)</code> |
| L51: <code>counts what is on, and what a card lists</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(enabledLine([item(true), item(false), item(true)]), &quot;2 of 3 on&quot;); assert.equal(countsLine(profile(&quot;p&quot;, &quot;Dev&quot;)), &quot;1 skill · 2 MCPs&quot;)</code> |
| L57: <code>a card&#x27;s pill says what is preparing, else what failed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(profileStatusPill(profile(&quot;p&quot;, &quot;Dev&quot;)), null); assert.deepEqual(profileStatusPill(profile(&quot;p&quot;, &quot;Dev&quot;, { codex: &quot;preparing&quot;, grok: &quot;failed&quot; }))?.text, &quot;Preparing Codex…&quot;)</code> |
| L66: <code>the chip disables a profile not ready for the chat&#x27;s agent, with the reason</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(entries.map((entry) =&gt; entry.name), [&quot;Dev&quot;, &quot;Editor&quot;, &quot;Research&quot;]); assert.equal(entries[0]?.disabledReason, &quot;Preparing for Codex…&quot;)</code> |
| L76: <code>the chip&#x27;s label: Global, the profile, or a deleted one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(profileChipLabel(null, profiles).label, &quot;Global&quot;); assert.equal(profileChipLabel(&quot;a&quot;, profiles).label, &quot;Dev&quot;)</code> |
| L84: <code>searches name and description</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(filterProfiles(profiles, &quot;edit&quot;).map((p) =&gt; p.id), [&quot;b&quot;]); assert.deepEqual(filterProfiles(profiles, &quot; &quot;).map((p) =&gt; p.id), [&quot;a&quot;, &quot;b&quot;])</code> |
| L93: <code>offers Global first, then every profile; a deleted one stays selected and says so</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(blockProfileChoices(profiles, undefined), [ { value: &quot;&quot;, label: &quot;Global (the agent&#x27;s own setup)&quot; }, { value: &quot;p1&quot;, label: &quot;Developer&quot; }, { value: &quot;p2&quot;, label: &quot;Editor&quot; } ]); assert.deepEqual(blockProfileChoices(profiles, &quot;gone&quot;).at(-1), { value: &quot;gone&quot;, label: &quot;A deleted profile — pick another&quot; })</code> |
| L103: <code>labels the block&#x27;s profile for the section summary</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(blockProfileLabel(profiles, undefined), &quot;Global&quot;); assert.equal(blockProfileLabel(profiles, &quot;p2&quot;), &quot;Editor&quot;)</code> |
| L109: <code>an item save carries the profile&#x27;s current revision unless the item itself changed</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(itemSaveRevision(held(&quot;5&quot;, [item]), null), &quot;5&quot;); assert.equal(itemSaveRevision(null, null), null)</code> |
| L131: <code>names the profile a chat switched to, resolved now (Global, a deleted one, the list still loading)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.match(profileChangeSummary({ profileId: &quot;p-dev&quot; }, profiles), /Developer/); assert.match(profileChangeSummary({ profileId: null }, profiles), /Global/)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-profiles/logic.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-profiles/sanitize.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4,5,5.5,5.6; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Agent Profile availability, current/deleted identity labels, revision-safe edits, sanitized secrets, workflow delete guards, and remembered usage. A secret value can reach shared state, rapid edits can reuse stale revisions, a profile used by workflows can be deleted without the confirmed set, or a deleted/unready profile can silently appear as Global.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-profiles/store.ts, sanitize.ts, logic.ts, chat-usage.ts; profile library, editors, composer chip and workflow picker consume outputs.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon launch/profile storage tests do not protect UI edit serialization, preparation readiness, local selection labels or deletion confirmation data; the profile-id parser and counting have distinct semantics. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L15: <code>settings.knowledgeCollections: ids kept (deduplicated), absent stays absent, junk dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(detail({ claudeWorkflowTool: true, knowledgeCollections: [&quot;kc_seo0000000&quot;, &quot;kc_seo0000000&quot;, 3, &quot;a b&quot;, &quot;kc_ads0000000&quot;] }).knowledgeCollections, [&quot;kc_seo0000000&quot;, &quot;kc_ads0000000&quot;]); assert.equal(&quot;knowledgeCollections&quot; in detail({ claudeWorkflowTool: false }), false, &quot;an older daemon: none ticked&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-profiles/sanitize.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/session-profiles/store.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-18-agent-profiles-design.md §§4,5,5.5,5.6; AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** Agent Profile availability, current/deleted identity labels, revision-safe edits, sanitized secrets, workflow delete guards, and remembered usage. A secret value can reach shared state, rapid edits can reuse stale revisions, a profile used by workflows can be deleted without the confirmed set, or a deleted/unready profile can silently appear as Global.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** session-profiles/store.ts, sanitize.ts, logic.ts, chat-usage.ts; profile library, editors, composer chip and workflow picker consume outputs.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon launch/profile storage tests do not protect UI edit serialization, preparation readiness, local selection labels or deletion confirmation data; the profile-id parser and counting have distinct semantics. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L108: <code>loads the list and a profile, dropping what does not read and every secret value</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state().list.profiles?.map((p) =&gt; p.id), [&quot;p1&quot;], &quot;the malformed summary is dropped&quot;); assert.equal(item?.kind, &quot;mcp&quot;)</code> |
| L119: <code>a toggle carries the held revision and folds the answer in</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, true); assert.deepEqual(calls.toggles, [{ profileId: &quot;p1&quot;, itemId: &quot;i1&quot;, revision: &quot;1&quot;, enabled: false }])</code> |
| L133: <code>a stale revision (409) reloads the profile and says so</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, false); assert.equal(result.ok ? null : result.code, &quot;PROFILE_CONFLICT&quot;)</code> |
| L155: <code>rapid mutations of one profile are serialized: each carries the revision the previous one answered</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(results.map((result) =&gt; result.ok), [true, true, true]); assert.deepEqual(calls.toggles.map((toggle) =&gt; toggle.revision), [&quot;1&quot;, &quot;2&quot;])</code> |
| L186: <code>a failed mutation does not block the next one of the same profile</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(first.ok, false); assert.equal(second.ok, true)</code> |
| L209: <code>events: a moved revision refetches, prepare status moves readiness, a delete drops the profile</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(calls.get.length, 1, &quot;the revision held: nothing to fetch&quot;); assert.equal(calls.get.length, 2)</code> |
| L252: <code>deleting a profile sends its revision and drops it</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(result.ok, true); assert.deepEqual(seen, [&quot;p1@1&quot;])</code> |
| L268: <code>the delete guard: the workflows using a profile, read field-wise; unknown when the daemon cannot tell or the answer does not read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(await loadProfileWorkflowUses(answer({ version: 1, profileId: &quot;p1&quot;, workflows: [use, use, { name: &quot;no id&quot; }] }), &quot;p1&quot;), { ok: true, workflows: [{ workflowId: &quot;wf_1&quot;, name: &quot;Nightly&quot;, enabled: true, workspace: &quot;a&quot; ; assert.deepEqual(await loadProfileWorkflowUses(answer({ version: 1, profileId: &quot;p1&quot;, workflows: [], unknownReason: &quot;not loaded&quot; }), &quot;p1&quot;), { ok: true, workflows: [], unknown: true })</code> |
| L281: <code>the delete guard: the confirmed workflow ids ride the delete; a 409 WORKFLOW_USES_CHANGED keeps the profile and says why</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(refused, { ok: false, error: &#x27;The workflows that use this profile changed (now: &quot;Nightly&quot;); nothing was deleted.&#x27;, code: &quot;WORKFLOW_USES_CHANGED&quot; }); assert.equal(state().list.profiles?.length, 1, &quot;still there&quot;)</code> |
| L308: <code>a client of another connection starts over</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(state().list.profiles, [])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/session-profiles/store.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/subagent-cache-ttl.test.ts

**Independent source (1):** packages/api SubagentCacheTtlStatus; README.md cost/usage settings.

**Contract / recognizable regressions (2):** Auto TTL explanations carry actual selected TTL, signed cost comparison, observation window and insufficient-sample counts. A costly choice can be explained with an inverted sign, the wrong TTL or an invented observation count.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** subagent-cache-ttl.ts; AgentsSettings TTL selector.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon TTL selection tests cannot establish what cost decision data the user sees; assertions retain data with loose wording. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L16: <code>auto reports the selected TTL and signed 1h cost comparison</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.match(cheaper, /currently\s+1h/i); assert.match(cheaper, /9\.4% less/)</code> |
| L26: <code>a held choice explains the comparison, including equal cost</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.match(held, /3\.2% less/); assert.match(held, /too close/)</code> |
| L33: <code>insufficient usage reports the request count and observation window</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.match(description, /\b120\b/); assert.match(description, /14 days/)</code> |
| L39: <code>before the first check the selected TTL is still reported</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.match(describeSubagentCacheTtl(status({ ttl: &quot;5m&quot;, lastCheck: null, nextCheckAt: null })), /currently\s+5m/i)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/subagent-cache-ttl.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/terminal-keys.test.ts

**Independent source (1):** README.md Mobile/PWA terminal key bar; xterm C0/CSI keyboard protocol.

**Contract / recognizable regressions (2):** Modifier/keyboard bytes match xterm, IME and protocol reports pass through, and latches apply only to their session. Ctrl/Alt can send wrong command bytes, a multi-character IME/paste can be corrupted, or a latched destructive key can leak to another terminal.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** terminal-keys.ts; terminal key bar/input handlers.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Server PTY tests pass bytes through and do not protect this client encoder/latch state machine; expected bytes come from the external terminal protocol. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L23: <code>Ctrl+letter maps to 0x01–0x1A regardless of case</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(ctrlChar(lower), String.fromCharCode(i + 1)); assert.equal(ctrlChar(lower.toUpperCase()), String.fromCharCode(i + 1))</code> |
| L31: <code>Ctrl on symbols follows xterm&#x27;s C0 table; unmapped characters pass through</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual( [&quot;@&quot;, &quot; &quot;, &quot;[&quot;, &quot;\\&quot;, &quot;]&quot;, &quot;^&quot;, &quot;_&quot;, &quot;/&quot;, &quot;?&quot;, &quot;2&quot;, &quot;3&quot;, &quot;8&quot;].map(ctrlChar), [&quot;\x00&quot;, &quot;\x00&quot;, &quot;\x1b&quot;, &quot;\x1c&quot;, &quot;\x1d&quot;, &quot;\x1e&quot;, &quot;\x1f&quot;, &quot;\x1f&quot;, &quot;\x7f&quot;, &quot;\x00&quot;, &quot;\x1b&quot;, &quot;\x7f&quot;] ); assert.equal(ctrlChar(&quot;~&quot;), &quot;~&quot;)</code> |
| L41: <code>characters: Alt is an ESC prefix, Ctrl+Alt prefixes the control byte</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(encodeKey({ kind: &quot;char&quot;, char: &quot;b&quot; }, NONE), &quot;b&quot;); assert.equal(encodeKey({ kind: &quot;char&quot;, char: &quot;b&quot; }, ALT), &quot;\x1bb&quot;)</code> |
| L49: <code>cursor and editing keys carry xterm&#x27;s modifier parameter</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(encodeKey(up, NONE), &quot;\x1b[A&quot;); assert.equal(encodeKey(up, ALT), &quot;\x1b[1;3A&quot;)</code> |
| L67: <code>Esc, Tab, Enter and Backspace follow xterm&#x27;s legacy encoding</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(encodeKey({ kind: &quot;special&quot;, key: &quot;escape&quot; }, NONE), &quot;\x1b&quot;); assert.equal(encodeKey({ kind: &quot;special&quot;, key: &quot;escape&quot; }, ALT), &quot;\x1b\x1b&quot;)</code> |
| L80: <code>parseInputKey reads single keys and refuses everything else</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(parseInputKey(&quot;r&quot;), { kind: &quot;char&quot;, char: &quot;r&quot; }); assert.deepEqual(parseInputKey(&quot;😀&quot;), { kind: &quot;char&quot;, char: &quot;😀&quot; })</code> |
| L93: <code>applyModifiers leaves input alone with no modifier or a non-key</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(applyModifiers(&quot;r&quot;, NONE), null); assert.equal(applyModifiers(&quot;rm&quot;, CTRL), null)</code> |
| L101: <code>store: one-shot Ctrl applies to the next key only, on its own session</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(activeModifiers(&quot;s1&quot;), CTRL); assert.deepEqual(activeModifiers(&quot;s2&quot;), NONE)</code> |
| L118: <code>store: locked Alt stays on across keys until tapped again</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(getModifierLatches().alt.state, &quot;locked&quot;); assert.equal(applyLatchedModifiers(&quot;s1&quot;, &quot;b&quot;), &quot;\x1bb&quot;)</code> |
| L134: <code>store: tapping on another session starts that session fresh</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(activeModifiers(&quot;s1&quot;), NONE); assert.deepEqual(activeModifiers(&quot;s2&quot;), ALT)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/terminal-keys.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/terminal-links.test.ts

**Independent source (1):** README.md terminal/file navigation; xterm link-provider buffer-cell API.

**Contract / recognizable regressions (2):** Terminal URLs/paths, compiler locations, wrapped/Unicode cell coordinates and sandboxed path resolution. A log route can become a fake file, punctuation can corrupt destinations, a wide character can shift activation to the wrong span, or navigation can escape the project.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** terminal-links.ts; TerminalView link provider.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Forge links use a different parser/seam; daemon realpath checks are authoritative security but cannot fix broken client navigation/terminal cell mapping. Coordinates are required protocol data, not appearance assertions. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L44: <code>finds Windows path src\index.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [ { kind: &quot;path&quot;, text, start: 9, end: 9 + text.length } ])</code> |
| L44: <code>finds Windows path .\src\index.ts:12:7</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [ { kind: &quot;path&quot;, text, start: 9, end: 9 + text.length } ])</code> |
| L44: <code>finds Windows path ..\src\index.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [ { kind: &quot;path&quot;, text, start: 9, end: 9 + text.length } ])</code> |
| L44: <code>finds Windows path C:\Users\Jane\project\index.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [ { kind: &quot;path&quot;, text, start: 9, end: 9 + text.length } ])</code> |
| L44: <code>finds Windows path \\server\share\index.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`error at ${text}: failed`), [ { kind: &quot;path&quot;, text, start: 9, end: 9 + text.length } ])</code> |
| L52: <code>finds paths containing spaces enclosed in &quot;</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${quote}${text}${quote}.`), [ { kind: &quot;path&quot;, text, start: 5, end: 5 + text.length } ])</code> |
| L52: <code>finds paths containing spaces enclosed in &#x27;</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${quote}${text}${quote}.`), [ { kind: &quot;path&quot;, text, start: 5, end: 5 + text.length } ])</code> |
| L52: <code>finds paths containing spaces enclosed in `</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${quote}${text}${quote}.`), [ { kind: &quot;path&quot;, text, start: 5, end: 5 + text.length } ])</code> |
| L61: <code>keeps positions outside quotes on ./my folder/index.ts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`&quot;${path}&quot;:12:7: error`), [ { kind: &quot;path&quot;, text: `${path}:12:7`, start: 1, end: path.length + 7 } ])</code> |
| L61: <code>keeps positions outside quotes on /home/Jane Doe/index.ts</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`&quot;${path}&quot;:12:7: error`), [ { kind: &quot;path&quot;, text: `${path}:12:7`, start: 1, end: path.length + 7 } ])</code> |
| L61: <code>keeps positions outside quotes on /home/Jane Doe/file)</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`&quot;${path}&quot;:12:7: error`), [ { kind: &quot;path&quot;, text: `${path}:12:7`, start: 1, end: path.length + 7 } ])</code> |
| L68: <code>does not treat quoted prose as a path</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(&#x27;error: &quot;something went wrong&quot;&#x27;), []); assert.deepEqual(extractTerminalLinks(&#x27;error: &quot;something went wrong.&quot;&#x27;), [])</code> |
| L73: <code>keeps quoted paths and URLs separate without duplicate partial paths</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [ { kind: &quot;path&quot;, text: path, start: 1, end: 1 + path.length }, { kind: &quot;url&quot;, text: url, start: path.length + 3, end: path.length + 3 + url.length }, { kind: &quot;path&quot;, text: &quot;src/index.t</code> |
| L84: <code>classifies uppercase schemes as URLs</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isTerminalUrl(&quot;HTTPS://example.com/docs&quot;), true); assert.equal(isTerminalUrl(&quot;Http://example.com&quot;), true)</code> |
| L91: <code>trims trailing punctuation from links</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(&quot;(https://example.com/docs), ./src/main.ts:12.&quot;), [ { kind: &quot;url&quot;, text: &quot;https://example.com/docs&quot;, start: 1, end: 25 }, { kind: &quot;path&quot;, text: &quot;./src/main.ts:12&quot;, start: 28, end: 44 } ])</code> |
| L99: <code>keeps the complete Unicode relative path src/żółć.ts:12:7</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${text} for details`), [ { kind: &quot;path&quot;, text, start: 4, end: 4 + text.length } ])</code> |
| L99: <code>keeps the complete Unicode relative path żółć/main.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${text} for details`), [ { kind: &quot;path&quot;, text, start: 4, end: 4 + text.length } ])</code> |
| L99: <code>keeps the complete Unicode relative path src/café.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${text} for details`), [ { kind: &quot;path&quot;, text, start: 4, end: 4 + text.length } ])</code> |
| L99: <code>keeps the complete Unicode relative path src/𐐀.ts:12</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`see ${text} for details`), [ { kind: &quot;path&quot;, text, start: 4, end: 4 + text.length } ])</code> |
| L106: <code>keeps a trailing colon on URLs</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(&quot;GET https://example.test/items/foo:&quot;), [ { kind: &quot;url&quot;, text: &quot;https://example.test/items/foo:&quot;, start: 4, end: 35 } ])</code> |
| L117: <code>drops the colon that ends a compiler diagnostic location in ./main.go:10:5: undefined: x</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [{ kind: &quot;path&quot;, text, start, end: start + text.length }])</code> |
| L117: <code>drops the colon that ends a compiler diagnostic location in /home/dev/app/src/main.c:10:5: error: expected &#x27;;&#x27;</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [{ kind: &quot;path&quot;, text, start, end: start + text.length }])</code> |
| L117: <code>drops the colon that ends a compiler diagnostic location in wrote ./out/report.txt:</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [{ kind: &quot;path&quot;, text, start, end: start + text.length }])</code> |
| L129: <code>does not turn a logged request route into a file link:  GET /api/trpc/post.list,user.me?batch=1&amp;input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D 200 in 35ms</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [])</code> |
| L129: <code>does not turn a logged request route into a file link: GET /api?+debug 200</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [])</code> |
| L129: <code>does not turn a logged request route into a file link: Started GET &quot;/posts?page=2&quot; for ::1</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [])</code> |
| L129: <code>does not turn a logged request route into a file link: proxying api/trpc/post.list?batch=1 to the backend</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(line), [])</code> |
| L134: <code>keeps a question mark inside a filesystem path</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(extractTerminalLinks(`wrote ${path}`), [{ kind: &quot;path&quot;, text: path, start: 6, end: 6 + path.length }])</code> |
| L141: <code>reconstructs a wrapped line from any of its rows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(fromFirst?.text, &quot;see https://example.com/a/bc?x=1&quot;); assert.deepEqual(fromWrapped, fromFirst)</code> |
| L149: <code>a link wrapping across rows spans both, and is offered on each</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(terminalLinksForRow(1, (i) =&gt; lines[i]), expected); assert.deepEqual(terminalLinksForRow(2, (i) =&gt; lines[i]), expected)</code> |
| L162: <code>maps columns past wide characters to cells, not UTF-16 offsets</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(terminalLinksForRow(1, (i) =&gt; lines[i]), [ { kind: &quot;path&quot;, text: &quot;src/main.ts:3&quot;, range: { start: { x: 6, y: 1 }, end: { x: 18, y: 1 } } } ])</code> |
| L170: <code>a row with no links has none, and a missing row is empty</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(terminalLinksForRow(1, () =&gt; row(&quot;just words here&quot;)), []); assert.deepEqual(terminalLinksForRow(5, () =&gt; undefined), [])</code> |
| L177: <code>splits a :line:col suffix</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(splitFilePathPosition(&quot;src/a.ts:12:7&quot;), { path: &quot;src/a.ts&quot;, line: 12, column: 7 }); assert.deepEqual(splitFilePathPosition(&quot;src/a.ts:12&quot;), { path: &quot;src/a.ts&quot;, line: 12 })</code> |
| L183: <code>resolves a relative path against the session&#x27;s cwd</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(resolveTerminalPathLink(&quot;./src/main.ts:10:5&quot;, &quot;/w/proj/app&quot;, &quot;/w/proj&quot;), { path: &quot;/w/proj/app/src/main.ts&quot;, line: 10, column: 5 }); assert.deepEqual(resolveTerminalPathLink(&quot;../lib/x.ts&quot;, &quot;/w/proj/app&quot;, &quot;/w/proj&quot;), { path: &quot;/w/proj/lib/x.ts&quot; })</code> |
| L192: <code>falls back to the project root without a cwd</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(resolveTerminalPathLink(&quot;README.md:1&quot;, &quot;&quot;, &quot;/w/proj&quot;), { path: &quot;/w/proj/README.md&quot;, line: 1 })</code> |
| L196: <code>keeps an absolute path inside the project</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(resolveTerminalPathLink(&quot;/w/proj/a/b.c:3&quot;, &quot;/w/proj&quot;, &quot;/w/proj&quot;), { path: &quot;/w/proj/a/b.c&quot;, line: 3 })</code> |
| L200: <code>refuses anything outside the project</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(resolveTerminalPathLink(&quot;/etc/passwd&quot;, &quot;/w/proj&quot;, &quot;/w/proj&quot;), null); assert.equal(resolveTerminalPathLink(&quot;../../etc/passwd&quot;, &quot;/w/proj&quot;, &quot;/w/proj&quot;), null)</code> |
| L209: <code>handles Windows project paths, case-insensitively</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(resolveTerminalPathLink(String.raw`src\my folder\index.ts:12:7`, String.raw`C:\Users\Jane\proj`, String.raw`C:\Users\Jane\proj`), { path: String.raw`C:\Users\Jane\proj\src\my folder\index.ts`, line: 12, column: 7 ; assert.deepEqual(resolveTerminalPathLink(&quot;c:/users/jane/proj/a.ts&quot;, String.raw`C:\Users\Jane\proj`, String.raw`C:\Users\Jane\proj`), { path: String.raw`c:\users\jane\proj\a.ts` })</code> |
| L223: <code>Cmd on Apple platforms, Ctrl elsewhere</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isTerminalLinkActivation({ metaKey: true, ctrlKey: false }, true), true); assert.equal(isTerminalLinkActivation({ metaKey: false, ctrlKey: true }, true), false)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/terminal-links.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/terminal-reset.test.ts

**Independent source (1):** README.md reconnect/replay; xterm write callback ordering.

**Contract / recognizable regressions (2):** Reset occurs after queued writes and before later replay, without duplicate old screen data. Reconnection can draw the previous snapshot after reset and duplicate scrollback.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** terminal-reset.ts; TerminalView replay/reset callback.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Wire route tests only emit reset frames; this uniquely protects asynchronous xterm queue ordering at the production wrapper’s boundary. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L24: <code>a reset lands after data already queued and before the replay that follows</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(term.screen, &quot;SNAPSHOT 2\n&quot;)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/terminal-reset.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/thread-visits.test.ts

**Independent source (1):** docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.7.

**Contract / recognizable regressions (2):** Read/unread stamps refer to actual turn completions, remain monotonic, validate storage and preserve other threads. A clock stamp can swallow a later completion, marking unread can disturb another thread or malformed storage can silently mark missed work read.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** thread-visits.ts; shared app-store unread/attention behavior.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Session activity tests protect daemon attention, which is explicitly distinct from this per-device unread state. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L9: <code>a junk blob loads as empty and bad entries are dropped</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(loadThreadVisits(), {}); assert.deepEqual(loadThreadVisits(), { a: T0 })</code> |
| L25: <code>reading a thread stamps the TURN&#x27;S COMPLETION, never the clock</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(markThreadRead({}, &quot;a&quot;, T1), { a: T1 }); assert.equal(hasUnseenCompletion(T1, markThreadRead({}, &quot;a&quot;, T1).a), false)</code> |
| L40: <code>a thread whose latest turn never completed has nothing to read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(markThreadRead(visits, &quot;a&quot;, null), visits, &quot;no completed turn changes no read data&quot;); assert.deepEqual(markThreadRead(visits, &quot;a&quot;, undefined), visits)</code> |
| L47: <code>visits are monotonic: an older stamp never moves the mark back</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(after, { a: T1 }); assert.deepEqual(markThreadRead({ a: T0 }, &quot;a&quot;, T1), { a: T1 })</code> |
| L53: <code>mark-unread makes the completed turn unread without changing another thread</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(hasUnseenCompletion(T1, visits.a), true); assert.equal(visits.b, T0)</code> |
| L59: <code>mark-unread is a no-op without a completed turn, and is idempotent</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(markThreadUnread(visits, &quot;a&quot;, null), visits); assert.deepEqual(markThreadUnread(visits, &quot;a&quot;, undefined), visits)</code> |
| L68: <code>a never-visited thread is not unread, and a running turn is never unread</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(hasUnseenCompletion(T1, undefined), false); assert.equal(hasUnseenCompletion(null, T0), false)</code> |
| L75: <code>an unreadable visit stamp reads as unread rather than silently read</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(hasUnseenCompletion(T1, &quot;garbled&quot;), true)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/thread-visits.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/transporters/http-transporter-stream.test.ts

**Independent source (1):** packages/api/src/index.ts (TerminalStreamClientFrame/ServerFrame); README.md (multiplexed WS); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** HTTP JSON/stream failures and multiplexed terminal replay/reset routing. An error JSON body can be treated as terminal output, callbacks can finish twice, non-JSON proxy failures can lose status, or one terminal’s reset/replay can be routed to another.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** transporters/http-transporter.ts and ws-session-channel.ts; web and desktop HTTP transport users consume these boundaries.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon encoder tests cannot establish the client decoder/routing half of the wire protocol, and desktop transport tests do not supersede the fetch path. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L13: <code>a non-2xx answer is one error and one end — its JSON body is never stream data</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(data, []); assert.equal(errors, 1)</code> |
| L32: <code>a 2xx body streams, then ends once</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(data.join(&quot;&quot;), &quot;hello&quot;); assert.equal(ends, 1)</code> |
| L58: <code>an answer that is not JSON is an UnexpectedResponseError carrying the status</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.rejects(answering(200, &quot;&lt;html&gt;portal&lt;/html&gt;&quot;, { &quot;Content-Type&quot;: &quot;text/html&quot; }).request({ method: &quot;GET&quot;, path: &quot;/health&quot; }), (error: unknown) =&gt; { assert.ok(error instanceof UnexpectedResponseError); assert.equal(error.statu; assert.ok(error instanceof UnexpectedResponseError)</code> |
| L70: <code>JSON and empty bodies still parse</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual((await answering(200, &#x27;{&quot;ok&quot;:true}&#x27;).request({ method: &quot;GET&quot;, path: &quot;/health&quot; })).data, { ok: true }); assert.equal((await answering(204, &quot;&quot;).request({ method: &quot;GET&quot;, path: &quot;/x&quot; })).data, undefined)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/transporters/http-transporter-stream.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/transporters/ws-session-channel.test.ts

**Independent source (1):** packages/api/src/index.ts (TerminalStreamClientFrame/ServerFrame); README.md (multiplexed WS); AGENTS.md (validate localStorage and bridge payloads; preserve unknown persisted fields).

**Contract / recognizable regressions (2):** HTTP JSON/stream failures and multiplexed terminal replay/reset routing. An error JSON body can be treated as terminal output, callbacks can finish twice, non-JSON proxy failures can lose status, or one terminal’s reset/replay can be routed to another.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** transporters/http-transporter.ts and ws-session-channel.ts; web and desktop HTTP transport users consume these boundaries.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Daemon encoder tests cannot establish the client decoder/routing half of the wire protocol, and desktop transport tests do not supersede the fetch path. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L53: <code>a replay frame goes to onReplay, live output to onData</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(socket.sent, [{ t: &quot;sub&quot;, id: &quot;s&quot; }]); assert.deepEqual(calls, [&quot;replay:SNAP&quot;, &quot;data:live&quot;, &quot;end&quot;])</code> |
| L67: <code>a replay falls back to onData for a consumer without onReplay</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(calls, [&quot;data:SNAP&quot;])</code> |
| L74: <code>a server reset clears that terminal only</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.deepEqual(calls, [&quot;reset:b&quot;])</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/transporters/ws-session-channel.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## packages/ui/src/lib/whiteboard.test.ts

**Independent source (1):** docs/superpowers/specs/2026-10-15-excalidraw-whiteboard-design.md (Excalidraw compatibility and file locations).

**Contract / recognizable regressions (2):** Whiteboard names/paths and Excalidraw scene bytes remain compatible; unrelated JSON is refused. A new scene can fail to open outside the app, a folder can be wrong or arbitrary JSON can be opened empty and then overwritten.

**Oracle (3):** Each named row uses literals or independently arranged fixtures, summarized below; these can disagree with the implementation. Changed oracles remove derived private constants/helpers.

**Stable seam / production consumers (4):** whiteboard.ts; file browser, whiteboard creation and tab logic.

**Refactor resistance (5):** Observe this seam’s results/state/events and externally required data. No source grep, export inventory, markup layout or private collaborator shape is retained.

**Unique protection (6):** Store/renderer tests do not own the file-format payload. The new-file test uses an independent parsed literal; calling the production validator as a second oracle was redundant. The named rows distinguish the concrete values, wire variant, lifecycle state or event ordering; no stronger owner was found for that remaining case.

| Original test / case | Disposition | Reason and independent oracle evidence |
| --- | --- | --- |
| L12: <code>whiteboard files are recognised by their extension, case-insensitively</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isWhiteboardFile(&quot;plan.excalidraw&quot;), true); assert.equal(isWhiteboardFile(&quot;PLAN.Excalidraw&quot;), true)</code> |
| L19: <code>a whiteboard&#x27;s title is its file name without the extension</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(whiteboardTitle(&quot;/w/acme/app/whiteboards/Untitled (1).excalidraw&quot;), &quot;Untitled (1)&quot;); assert.equal(whiteboardTitle(&quot;/w/acme/app/.excalidraw&quot;), &quot;.excalidraw&quot;)</code> |
| L25: <code>new whiteboards go in the project&#x27;s whiteboards folder</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(whiteboardsDirOf(&quot;/w/acme/app&quot;), &quot;/w/acme/app/whiteboards&quot;); assert.equal(whiteboardsDirOf(&quot;/w/acme/app/&quot;), &quot;/w/acme/app/whiteboards&quot;)</code> |
| L30: <code>a new whiteboard is an empty Excalidraw scene</code> | REWRITE | Deletes the redundant production-validator-as-oracle assertion. The literal parsed Excalidraw v2 payload independently verifies interoperability. Oracle: <code>assert.equal(isWhiteboardScene(file), true); assert.deepEqual(JSON.parse(file), { type: &quot;excalidraw&quot;, version: 2, source: &quot;orquester&quot;, elements: [], appState: {}, files: {} })</code> |
| L43: <code>only an Excalidraw scene opens as one</code> | KEEP | Retains the named independent scenario at this file’s public seam; the assertion evidence below supplies its concrete input/result oracle. Oracle: <code>assert.equal(isWhiteboardScene(&#x27;{&quot;type&quot;:&quot;excalidraw&quot;,&quot;elements&quot;:[{&quot;id&quot;:&quot;a&quot;}]}&#x27;), true); assert.equal(isWhiteboardScene(&#x27;{&quot;type&quot;:&quot;excalidrawlib&quot;,&quot;libraryItems&quot;:[]}&#x27;), false)</code> |

**Validation target:** From `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test src/lib/whiteboard.test.ts`; executed commands/outcomes follow the central test-slot schedule.

## Validation and performance record

Exclusive validation slot: one process at a time, Node 24.22.1, four logical CPUs, package cwd `packages/ui`, `TSX_DISABLE_CACHE=1`, Node runner concurrency 4, one test file per process. Before and after alternated for three pairs; both copies used the same runner, source dependency and unchanged simulation schedules. OS/library caches were warm; no shared tsx transpile cache was used. No concurrent suite ran in this slot.

| Pair | Baseline full file, seconds | Final full file, seconds |
| --- | ---: | ---: |
| 1 | 2.048743 | 1.013662 |
| 2 | 2.103256 | 1.038307 |
| 3 | 2.167384 | 1.118826 |

Median: **2.103256 → 1.038307 seconds**, saving **1.064950 seconds (50.6334%)**. Every run passed all **9 tests**. `/usr/bin/time -v` median user CPU was 2.22 → 1.16 seconds; median system CPU 0.17 → 0.12 seconds; median maximum resident set size 246832 → 213860 KiB. These are isolated file measurements, not whole-suite or CI speed claims.

On the second pair, slowest individual baseline cases were −100 ppm drift 648.240 ms, +100 ppm drift 604.017 ms and stable-target reduction 473.108 ms. Final cases were −100 ppm drift 336.531 ms, +100 ppm drift 323.870 ms, stall/burst acoustic recovery 19.685 ms, and stable-target reduction 15.449 ms. The drift scenarios intentionally retain two simulated hours under the independent desktop spec §13.3.

The exact timing command below ran for each `VERSION=before/after` and `PAIR=1/2/3` (the version/pair fields identify the six literal invocations in the JSON report):

```sh
/usr/bin/time -v -o /tmp/orquester-test-audit/ui-other-VERSION-PAIR.time env TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=tap --test-timeout=600000 --test-concurrency=4 /tmp/orquester-test-audit/ui-other-VERSION/jitter-buffer.test.ts
```

Additional exact commands, also wrapped in `/usr/bin/time -v` and run from `packages/ui`:

```sh
env TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs /tmp/orquester-test-audit/ui-other-compare.ts
env TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=tap --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=\+100 ppm' /tmp/orquester-test-audit/ui-other-mutant-overflow/jitter-buffer.test.ts
env TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=tap --test-timeout=600000 --test-concurrency=4 '--test-name-pattern=-100 ppm' /tmp/orquester-test-audit/ui-other-mutant-recovery/jitter-buffer.test.ts
env TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-reporter=tap --test-timeout=600000 --test-concurrency=4 src/lib/boxes/format.test.ts
```

- Full simulation equivalence passed both ±100 ppm cases: exact final public stats, maximum excess depth, maximum target, and all 7200 per-second depth samples matched. Positive drift ended with target 20 ms, no underruns, 72 drops, maximum excess 1792 frames. Negative drift ended with target 20 ms, 42 underruns, no drops, maximum excess approximately 352 frames. Both maximum targets were 30 ms.
- Disabling the playing-state overflow drop in an isolated copied production module made the optimized +100 ppm case fail its intended bound: **depth exceeded target by 35200 frames** (`ERR_ASSERTION`, exit 1).
- Disabling stable target recovery in another isolated copy made the optimized −100 ppm case fail its intended bound: **target climbed to 130 ms** (`ERR_ASSERTION`, exit 1).
- All mutations were confined to `/tmp`. Current production SHA256 stayed `0f9d65390a4cd54e00853c0caf851a4210bce53e52431022abaef9b36adc5e38`; current audio-test SHA256 stayed `4dbbaab7aedd685f8663790fc24c31802cfb4b8efdee238611c724e27c6e8f0a`.
- The newly rewritten daily-money assertion initially exposed an invalid exact binary-float oracle (`115.19999999999999` versus mathematical `115.2`). It now compares the independent USD result at cent precision (`115.20`); the targeted format file passed both tests. No production arithmetic changed.
- Raw commands/results are recorded in `/tmp/orquester-test-audit/ui-other-profile.json` and `ui-other-verification.json`; TAP and resource logs use the matching `ui-other-*.log/.time` names. The JSON report preserves commands and results for review after scratch artifacts expire.

No focused 14-file run is claimed: the coordinating agent owns the changed/full repository gates. Likewise, this report does not claim a successful repository typecheck, build, full test suite or remote integration before those gates finish.
