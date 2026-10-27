# Incoming Devices: visible-chat focus coverage gap

**KEEP** — `packages/ui/src/lib/agent-chat-active-tab.test.ts:98` at `610d3c53`: **the shell's hold takes the claim back from a view that releases it while still on screen**. Final identity is unchanged (`packages/ui/src/lib/agent-chat-active-tab.test.ts:98`); no alias rename or source edit.

Unique production focus-lifetime regression: a child cleanup must not orphan the still-visible shell target, and stopped holds must not revive a previous target.

1. **independentContract:** The visible/focused chat must remain the target for keyboard and right-rail actions for the lifetime of the shell's published view, even when the child chat view performs a cleanup/remount. Historical regression commit 02ad58e19b73feb6313be6f94295fcc4ef281054 records StrictMode cleanup leaving the Device panel at 'Open an agent chat' beside an open chat and disabling chat shortcuts. Devices phase-1 design §§10.1–10.2 independently requires the Device panel/follow target to be the visible chat.

2. **realRegressionDetection:** Calling releaseActiveChatTab('a') while the shell still holds visible chat 'a' must leave activeChatTab() as 'a'; losing the restoring subscription fails that literal assertion. After moving to 'b', old-view release cannot steal the new target. Stopping holds and publishing no chat must yield null; a leaked old hold instead restores an old id and fails the final assertion.

3. **independentOracle:** The expected ids 'a', 'b' and null are literal user/shell choices and the lifetime contract, not values obtained from holdActiveChatTab internals, listener counts, production constants or a mock implementing the focus policy.

4. **stableSeam:** The production-used holdActiveChatTab/releaseActiveChatTab lifecycle and public activeChatTab value. MainView's effect owns the hold; AgentChatView cleanup releases; composer/banner keyboard handlers, right-rail chat-target and Devices use-follow-agent consume the published focus.

5. **refactorResistance:** Observes active session identity after lifecycle actions and returned unsubscribe, with no source grep, effect inventory, listener implementation, markup/layout, private callback shape or exact copy requirement. A different internal focus registry preserving the same lifecycle behavior continues to pass.

6. **uniqueProtection:** This is the only test invoking holdActiveChatTab (repository-wide test search). Existing set/release/active-tab derivation cases do not hold a shell claim across child cleanup; Devices follow tests supply visibility and do not exercise restoration after release. The latter transition and hold teardown therefore have no stronger remaining owner. The non-owner release step also verifies the handover within that held lifecycle rather than adding a separate repeated scenario.

Current production owner evidence: `MainView.tsx` retains the visible id through `holdActiveChatTab`; `AgentChatView.tsx` releases on cleanup; the right rail and Devices following read `activeChatTab`. Historical fix `02ad58e19b73feb6313be6f94295fcc4ef281054` explains the observed user failure independently of this test’s assertions.

**Performance/risk:** One synchronous registry lifecycle sequence; no browser, server, filesystem, network, polling or elapsed-time wait. No timing improvement claimed. No source/test edits: retain unique regression protection.

**Validation:** No tests run because the root backend validation process owns the serialized test slot. Root should include this file in the final UI suite. No performance or test-pass claim is made.
