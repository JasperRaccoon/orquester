# Agent chat component test cleanup

Status: completed cleanup. Decisions were recorded before edits; implementation and focused validation are recorded below. Timeline and roster ledgers: [timeline](ui_chat_timeline.md), [roster](ui_chat_roster.md). Every assigned path is covered by this ledger or those two delegated ledgers.

Scope: component root, banners, primitives and status. Read AGENTS.md, README.md, root/UI package scripts, production owners and GUI/goals design requirements. This is implemented cleanup, not an audit-only recommendation.

Validation command template (from packages/ui): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test <retained files>`; retained `.check.ts` runs use the same hooks without `--test`. Root owns `pnpm check`, `pnpm test`, `pnpm build` and final diff.

## `packages/ui/src/components/agent-chat/ChatErrorBoundary.test.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** `Try again hands the reset to the view (which closes a drill-in), then renders again` — Directly instantiates React components and replaces setState; private lifecycle/callback shape does not exercise error capture or recovery. No stable behavior assertion is lost.
- **DELETE** `without a view reset it only renders again` — Directly instantiates React components and replaces setState; private lifecycle/callback shape does not exercise error capture or recovery. No stable behavior assertion is lost.
- **DELETE** `catches a child's crash and offers the way back` — Directly instantiates React components and replaces setState; private lifecycle/callback shape does not exercise error capture or recovery. No stable behavior assertion is lost.

## `packages/ui/src/components/agent-chat/banners/approval-detail.test.ts`

Unit failure modes (listed before retaining cases): Approval displays another call's path or silently hides the actual command/diff; malformed payload crashes or invents detail.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §§4.3,7.5 and E7 wrong/unavailable file-change approval detail regression. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: ApprovalCard → resolveApprovalDetail; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: Provider tests ensure wire fields exist but cannot own client toolUseId joining/precedence. This resolver is the lowest semantic display-data seam.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `E7: the request's own detail wins and is marked as such` — Protects the distinct stated input/output failure: E7: the request's own detail wins and is marked as such. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `E7: with no detail, the card joins the gated tool call by toolUseId` — Protects the distinct stated input/output failure: E7: with no detail, the card joins the gated tool call by toolUseId. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `E7: the path list alone is enough when the item carries no diff` — Protects the distinct stated input/output failure: E7: the path list alone is enough when the item carries no diff. No stronger duplicate remains; shared six-item contract above applies.
- **REWRITE** `E7: the body is NEVER the card's own title` — Remove exact warning copy; keep missing-detail state.
- **REWRITE** `E7: the join is by id only — a second write in flight is never guessed at` — Assert only resolver null result; remove direct private join call.
- **REWRITE** `E7: the newest activity wins when a tool id is reused across updates` — Observe newest path through resolveApprovalDetail; stop inspecting private joined activity identity.
- **KEEP** `E7: a command payload is used when there are no changed files` — Protects the distinct stated input/output failure: E7: a command payload is used when there are no changed files. No stronger duplicate remains; shared six-item contract above applies.
- **REWRITE** `E7: a missing or malformed payload never throws` — Assert null detail for every malformed payload, not merely absence of a throw.
- **DELETE** `a file header alone is not a diff, but a hunk or a +/- pair is` — Presentation classifier, not approval data safety; resolver checks retain full diff bytes.
- **DELETE** `diff lines get their tone from the leading marker` — Color mapping only; no visual regression requirement.

## `packages/ui/src/components/agent-chat/banners/banner-model.test.ts`

Unit failure modes (listed before retaining cases): An urgent actionable request is obscured, advertised warning/decision is dropped, or background work loses its stop affordance.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §§4.3,7.5,7.6 priority, provider decision IDs/warnings and background stop availability. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: ChatBannerDock/ApprovalCard/BackgroundLivenessBanner → model functions; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: No stronger owner verifies the client's option/dock model; render duplicates are removed.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `activity sorts first, then severity, then notices` — Protects the distinct stated input/output failure: activity sorts first, then severity, then notices. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `an explicit urgent priority ranks with the severities` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.
- **KEEP** `equal priorities keep the caller's order` — Protects the distinct stated input/output failure: equal priorities keep the caller's order. No stronger duplicate remains; shared six-item contract above applies.
- **REWRITE** `the default four split into Approve/Decline primary and the rest overflow` — Remove self-inspection of exported default list length; retain literal decision IDs.
- **REWRITE** `an empty advertised list falls back to the default four` — Replace row count with exact public decision IDs, so a wrong fallback cannot pass.
- **KEEP** `advertised options keep the provider's own wording and warnings` — Protects the distinct stated input/output failure: advertised options keep the provider's own wording and warnings. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the split is on the decision, not on the position` — Protects the distinct stated input/output failure: the split is on the decision, not on the position. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `every request kind has a header label and an aria twin` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.
- **DELETE** `only an elicitation renders its detail as prose` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.
- **DELETE** `the liveness title counts agents and degrades to a generic label` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.
- **DELETE** `the liveness title names running shells beside the agents, never counts them as agents` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.
- **KEEP** `the liveness banner is hidden while a turn is working` — Protects the distinct stated input/output failure: the liveness banner is hidden while a turn is working. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the dock shows one card at a time, in a fixed priority order` — Protects the distinct stated input/output failure: the dock shows one card at a time, in a fixed priority order. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `a collapsed mobile composer gets the compact question layout, never the plan prompt` — Copy/appearance or an internal priority ordinal; retained dock/options/liveness contracts own actionable behavior.

## `packages/ui/src/components/agent-chat/banners/banner-render.check.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **REWRITE** standalone assertions — Keep only disabled answer controls, request warning accessibility, dismissibility and secret password-field state at the actual component boundary; remove copy, coordinates/classes, option-count/order echoes and tool-detail join duplicates.
  - Original line 74: `assert.match(html, /data-approval-decision="accept"/, "Approve must be a primary button");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 75: `assert.match(html, /data-approval-decision="decline"/, "Decline must be a primary button");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 76: `assert.doesNotMatch(`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 84: `assert.match(html, /data-approval-detail="request"/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 85: `assert.match(html, /tabindex="0"/i, "the detail block must stay keyboard-reachable");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 86: `assert.match(html, /rm -rf \/tmp\/build/, "the full command must be rendered");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 88: `assert.match(html, /1\/3/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 102: `assert.ok(buttons.length > 0, "the card must render buttons");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 104: `assert.match(button, /disabled/, every control must be disabled while responding: ${button});`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 106: `assert.doesNotMatch(html, /1\/1/, "a lone approval shows no counter");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 125: `assert.match(warned, /aria-description="This looks like a prompt injection"/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 126: `assert.match(warned, /Run it/, "the provider's own wording is what the user sees");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 143: `assert.match(bare, /data-approval-detail="unavailable"/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 144: `assert.match(bare, /Decline it unless you know/, "a missing detail must say so in words");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 146: `assert.doesNotMatch(`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 181: `assert.match(joined, /data-approval-detail="item"/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 182: `assert.match(joined, /src\/ui-hello\.txt/, "the path must reach the DOM");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 183: `assert.match(joined, /hello from the agent/, "the diff must reach the DOM");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 184: `assert.match(joined, /text-ok-300/, "an added line must be tone-coded");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 186: `assert.match(joined, /font-mono/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 224: `assert.match(html, /Which branch should I use\?/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 225: `assert.match(html, />1</, "option 1 must show its digit shortcut");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 226: `assert.match(html, />2</, "option 2 must show its digit shortcut");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 228: `assert.match(html, /max-h-\[min\(24rem,40dvh\)\]/, "the card body must be scroll-capped");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 230: `assert.match(html, /ac-chevron/, "the header must carry a disclosure chevron");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 232: `assert.doesNotMatch(html, /Dismiss question without answering/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 234: `assert.doesNotMatch(html, /autofocus/i, "a question card must never steal focus");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 245: `assert.match(html, /Dismiss question without answering/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 260: `assert.match(freeText, /Write a custom answer/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 279: `assert.doesNotMatch(`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 284: `assert.match(secret, /type="password"/, "a secret answer is masked in the card's own field");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 297: `assert.match(button, /disabled/, every control must be disabled while responding: ${button});`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 299: `assert.match(html, /Submitting…/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 336: `assert.match(html, /4 agents working/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 337: `assert.equal(attachedWrappers(html).length, 1, "exactly one card is attached to the composer");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 339: `assert.ok(attachedAt < html.indexOf("4 agents working"), "the attached wrapper holds the liveness card");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 346: `assert.equal(wrappers.length, 1, "only the bottom-most card is attached");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 348: `assert.ok(`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 352: `assert.ok(attachedAt < html.indexOf("rm -rf /tmp/build"), "the approval card is the attached one");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 366: `assert.match(html, /2 more/);`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 367: `assert.ok(html.indexOf("2 more") < html.indexOf("First notice"), "the toggle sits above the stack");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 368: `assert.ok(html.indexOf("2 more") < html.indexOf("4 agents working"), "the toggle sits above the front card");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 369: `assert.equal(attachedWrappers(html).length, 1, "exactly one attached card with a stack");`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.
  - Original line 370: `assert.ok(`. REWRITE only for control state/security/accessibility as specified above; all other assertions DELETE.

## `packages/ui/src/components/agent-chat/banners/pending-answer.test.ts`

Unit failure modes (listed before retaining cases): Wrong/partial answers are posted, secret text leaks into persisted prompt, typed draft is discarded, attachments cross questions, or a hidden/background card consumes a digit.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §7.5 answer semantics, Codex label/isOther/isSecret protocol, upload completion, per-question attachment identity and keyboard ownership. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: QuestionCard → pending-answer owner functions; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: Daemon answer transport validates wire input but does not own this client draft-to-answer conversion. No stronger scenario is duplicated.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `an option with no value answers with its label` — Protects the distinct stated input/output failure: an option with no value answers with its label. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a custom answer beats a selected option` — Protects the distinct stated input/output failure: a custom answer beats a selected option. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a custom answer is refused when the question forbids one` — Protects the distinct stated input/output failure: a custom answer is refused when the question forbids one. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `multi-select answers with an array and drops unknown values` — Protects the distinct stated input/output failure: multi-select answers with an array and drops unknown values. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an attachment alone satisfies a question` — Protects the distinct stated input/output failure: an attachment alone satisfies a question. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an unfinished upload keeps the answer unresolved` — Protects the distinct stated input/output failure: an unfinished upload keeps the answer unresolved. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a choice-only question offers no attachments` — Protects the distinct stated input/output failure: a choice-only question offers no attachments. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an `isOther` option asks for text rather than answering with its label` — Protects the distinct stated input/output failure: an `isOther` option asks for text rather than answering with its label. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a secret answer is never carried back into the thread draft` — Protects the distinct stated input/output failure: a secret answer is never carried back into the thread draft. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `displaced text lands after whatever was already in the draft` — Protects the distinct stated input/output failure: displaced text lands after whatever was already in the draft. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `toggling clears the custom answer; multi-select toggles in place` — Protects the distinct stated input/output failure: toggling clears the custom answer; multi-select toggles in place. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `single-select replaces the selection rather than adding to it` — Protects the distinct stated input/output failure: single-select replaces the selection rather than adding to it. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `typing clears a selection only once there is text to prefer` — Protects the distinct stated input/output failure: typing clears a selection only once there is text to prefer. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the answers map is null until every question resolves` — Protects the distinct stated input/output failure: the answers map is null until every question resolves. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `progress reports the active question, the count and completeness` — Protects the distinct stated input/output failure: progress reports the active question, the count and completeness. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an out-of-range question index is clamped, never thrown on` — Protects the distinct stated input/output failure: an out-of-range question index is clamped, never thrown on. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `attachment drafts are namespaced per (requestId, questionId)` — Protects the distinct stated input/output failure: attachment drafts are namespaced per (requestId, questionId). No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a digit picks its option on the visible tab` — Protects the distinct stated input/output failure: a digit picks its option on the visible tab. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover` — Protects the distinct stated input/output failure: an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a digit never answers from a hidden tab, while typing, or under a modifier` — Protects the distinct stated input/output failure: a digit never answers from a hidden tab, while typing, or under a modifier. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `only 1–9, and only an option the question has` — Protects the distinct stated input/output failure: only 1–9, and only an option the question has. No stronger duplicate remains; shared six-item contract above applies.

## `packages/ui/src/components/agent-chat/command-rejections.check.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** standalone assertions — Source regex depends on receiver identifiers, line wrapping and .catch syntax; no user-facing key/path/byte, and renaming identifiers defeats it.
  - Original line 68: `assert.deepEqual(`. DELETE for the file-level reason above.

## `packages/ui/src/components/agent-chat/drill-in-navigation.test.ts`

Unit failure modes (listed before retaining cases): A settling followed child fails to return; opening an already-finished child closes it; scrolling reader is displaced; a new palette hit remains hidden.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §7.6 navigation and documented cross-agent/scrolled-reader regression. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: AgentChatView → nextDrillInReturn/revealClosesDrillIn; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: No other test drives this per-opening state transition; roster hook tests own fetching rather than navigation.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `an agent seen at work that settles while the reader follows its end hands the view back` — Protects the distinct stated input/output failure: an agent seen at work that settles while the reader follows its end hands the view back. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `opening a finished agent from a running agent's view stays open (was one flag for the whole view)` — Protects the distinct stated input/output failure: opening a finished agent from a running agent's view stays open (was one flag for the whole view). No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an agent opened already finished stays open` — Protects the distinct stated input/output failure: an agent opened already finished stays open. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a reader who scrolled up stays when it settles — and is not yanked later on reaching the end` — Protects the distinct stated input/output failure: a reader who scrolled up stays when it settles — and is not yanked later on reaching the end. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `idle is not at work: an idle agent that settles returns nothing` — Protects the distinct stated input/output failure: idle is not at work: an idle agent that settles returns nothing. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an agent the roster dropped, then back, starts over` — Protects the distinct stated input/output failure: an agent the roster dropped, then back, starts over. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `A → B → A: each agent is watched from its own opening` — Protects the distinct stated input/output failure: A → B → A: each agent is watched from its own opening. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a NEW reveal closes an open drill-in, so the thread's timeline takes it at once` — Protects the distinct stated input/output failure: a NEW reveal closes an open drill-in, so the thread's timeline takes it at once. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open` — Protects the distinct stated input/output failure: no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open. No stronger duplicate remains; shared six-item contract above applies.

## `packages/ui/src/components/agent-chat/error-boundary-render.check.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** standalone assertions — Manually injected error state plus copy, classes and pixel padding cannot exercise the recovery workflow.
  - Original line 24: `assert.ok(fallback.includes('data-drill-in-crashed="agent-1"'), fallback);`. DELETE for the file-level reason above.
  - Original line 25: `assert.ok(fallback.includes("Back to the thread"), "the way back is on screen, on any device");`. DELETE for the file-level reason above.
  - Original line 26: `assert.match(fallback, /<button type="button" class="[^"]*min-h-10[^"]*"/, "a touch-sized button, not a key");`. DELETE for the file-level reason above.
  - Original line 27: `assert.ok(fallback.includes("a malformed row"), "and it says what broke");`. DELETE for the file-level reason above.
  - Original line 28: `assert.ok(fallback.includes("the thread are untouched"));`. DELETE for the file-level reason above.
  - Original line 29: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 36: `assert.ok(renderToStaticMarkup(thread.render() as ReactElement).includes("Try again"));`. DELETE for the file-level reason above.

## `packages/ui/src/components/agent-chat/escape-action.test.ts`

Unit failure modes (listed before retaining cases): Escape interrupts hidden/other-field/modal tabs; closes parent instead of drill-in; repeats trigger a second action; rewind counts an intervening non-idle key.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §§7.4,7.6 keyboard priorities, double Escape and editable-field ownership; documented unintended interruption regressions. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: AgentChatView window listener → resolveChatEscape/chatEscapeSequenceStep/chatEscapeTargetGate; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: Composer tab-visibility.test.ts owns composer scope; retained shell decisions own the disjoint outside-composer scope. Duplicated cross-owner checks are removed.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `Escape leaves the drill-in — the case a React root handler could not see` — Protects the distinct stated input/output failure: Escape leaves the drill-in — the case a React root handler could not see. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the drill-in wins over the interrupt` — Protects the distinct stated input/output failure: the drill-in wins over the interrupt. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `Escape interrupts a running turn from anywhere in the tab` — Protects the distinct stated input/output failure: Escape interrupts a running turn from anywhere in the tab. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `Escape does nothing with no drill-in and no turn` — Protects the distinct stated input/output failure: Escape does nothing with no drill-in and no turn. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a hidden tab never acts, whatever it is doing` — Protects the distinct stated input/output failure: a hidden tab never acts, whatever it is doing. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a blocking layer keeps the key: Escape closes the modal, not the thread` — Protects the distinct stated input/output failure: a blocking layer keeps the key: Escape closes the modal, not the thread. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `focus inside the composer belongs to the composer's own arm, not this one` — Protects the distinct stated input/output failure: focus inside the composer belongs to the composer's own arm, not this one. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an event another listener already handled is not handled twice` — Protects the distinct stated input/output failure: an event another listener already handled is not handled twice. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a held Escape is one press: its auto-repeat never stops the turn the first press spared` — Protects the distinct stated input/output failure: a held Escape is one press: its auto-repeat never stops the turn the first press spared. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `only Escape` — Protects the distinct stated input/output failure: only Escape. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a second idle Escape opens the rewind picker` — Protects the distinct stated input/output failure: a second idle Escape opens the rewind picker. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the first idle Escape does nothing — it is only half of the gesture` — Protects the distinct stated input/output failure: the first idle Escape does nothing — it is only half of the gesture. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `no message to go back to, no picker` — Protects the distinct stated input/output failure: no message to go back to, no picker. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the double press never outranks leaving a drill-in or stopping a turn` — Protects the distinct stated input/output failure: the double press never outranks leaving a drill-in or stopping a turn. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `the rewind obeys every gate the other two do` — Protects the distinct stated input/output failure: the rewind obeys every gate the other two do. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `under an open layer the shell does nothing, whatever the drill-in, the turn or the sequence` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **DELETE** `the rewind is returned exactly for an idle second press with somewhere to go` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **DELETE** `the two new inputs change nothing but the idle case` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **DELETE** `an idle Escape is exactly the one this side would otherwise ignore for doing nothing` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **KEEP** `only an idle Escape is pressed into the double-press sequence` — Protects the distinct stated input/output failure: only an idle Escape is pressed into the double-press sequence. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an Escape that did something else starts the count over` — Protects the distinct stated input/output failure: an Escape that did something else starts the count over. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `an Escape a composer popover takes to close itself is not half of a rewind` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **KEEP** `any other key between two Escapes breaks the sequence` — Protects the distinct stated input/output failure: any other key between two Escapes breaks the sequence. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `holding Escape is one press, and its auto-repeat breaks nothing either` — Protects the distinct stated input/output failure: holding Escape is one press, and its auto-repeat breaks nothing either. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `a text field, a select or an editor takes its own keys; a button, a checkbox or the page does not` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **DELETE** `an input that takes no text is not a field, whatever its type` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.
- **REWRITE** `an Escape typed into a field outside this chat is that field's: nothing here, and Esc Esc starts over` — Keep shell ignore/reset behavior for a foreign editable field at the stable key-decision seam; remove fake closest/attribute-walk implementation. The six-item keyboard contract above applies.
- **DELETE** `the same field inside this chat's composer keeps the composer's rules` — The fake element implements only the current private CSS selector shape and repeats action decisions already retained above. It cannot verify a real DOM listener; remove its element/gate helpers.
- **DELETE** `a field inside this chat but outside its composer keeps today's rules` — The fake element implements only the current private CSS selector shape and repeats action decisions already retained above. It cannot verify a real DOM listener; remove its element/gate helpers.
- **DELETE** `in the grid, another chat's composer and answer field are that chat's, not this one's` — The fake element implements only the current private CSS selector shape and repeats action decisions already retained above. It cannot verify a real DOM listener; remove its element/gate helpers.
- **DELETE** `a target that takes no text keeps today's rules, inside this chat or out` — The fake element implements only the current private CSS selector shape and repeats action decisions already retained above. It cannot verify a real DOM listener; remove its element/gate helpers.
- **DELETE** `an Escape a field outside this chat owns is never acted on, whatever else is true` — Redundant with explicit resolver action/gate cases or checks an internal predicate against the resolver itself; no additional user failure. Test-only exhaustive-input generator removed.

## `packages/ui/src/components/agent-chat/escape-layers.test.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** `is a layer the gate reports, and only while it is open` — Replays open-layer boolean gating already owned by lib/open-layers.test.ts, escape-action.test.ts and composer/tab-visibility.test.ts; manually passes the derived flag and cannot detect actual listener wiring failures.
- **DELETE** `popover open + running turn ⇒ the popover closes and nothing else happens` — Replays open-layer boolean gating already owned by lib/open-layers.test.ts, escape-action.test.ts and composer/tab-visibility.test.ts; manually passes the derived flag and cannot detect actual listener wiring failures.
- **DELETE** `popover open + idle ⇒ the popover closes, and no rewind is armed` — Replays open-layer boolean gating already owned by lib/open-layers.test.ts, escape-action.test.ts and composer/tab-visibility.test.ts; manually passes the derived flag and cannot detect actual listener wiring failures.
- **DELETE** `popover open + drill-in ⇒ the popover closes first; the drill-in stays` — Replays open-layer boolean gating already owned by lib/open-layers.test.ts, escape-action.test.ts and composer/tab-visibility.test.ts; manually passes the derived flag and cannot detect actual listener wiring failures.

## `packages/ui/src/components/agent-chat/full-output-render.check.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** standalone assertions — Presentation copy and markup replay the streamed/truncated-output decisions owned by lib/agent-chat/full-output.test.ts; never exercises loading or interaction.
  - Original line 88: `assert.ok(streamed.includes("line 600"), "the row shows what the window holds of its output");`. DELETE for the file-level reason above.
  - Original line 89: `assert.ok(streamed.includes("Load full output"), "and offers the whole of it, though nothing cut its payload");`. DELETE for the file-level reason above.
  - Original line 106: `assert.ok(running.includes("Load full output"), "a running command offers its output so far");`. DELETE for the file-level reason above.
  - Original line 110: `assert.ok(plain.includes("2 passed"));`. DELETE for the file-level reason above.
  - Original line 111: `assert.ok(!plain.includes("Load full output"), "a plain command offers nothing more");`. DELETE for the file-level reason above.
  - Original line 115: `assert.ok(cut.includes("Load full output"), "a cut payload offers the full read");`. DELETE for the file-level reason above.
  - Original line 132: `assert.ok(!edit.includes("Load full output"), "a file change is never offered the join");`. DELETE for the file-level reason above.
  - Original line 139: `assert.ok(loading.includes("Loading…"));`. DELETE for the file-level reason above.
  - Original line 140: `assert.ok(!loading.includes("data-full-output-note"), "nothing is said about an output not read yet");`. DELETE for the file-level reason above.
  - Original line 147: `assert.ok(whole.includes("line 1\nline 2\n"), "the output as the command printed it");`. DELETE for the file-level reason above.
  - Original line 148: `assert.ok(!whole.includes("data-full-output-note"), "a settled, whole output needs no note");`. DELETE for the file-level reason above.
  - Original line 155: `assert.ok(soFar.includes("Still running — this is its output so far."), "a running call's output is so far");`. DELETE for the file-level reason above.
  - Original line 156: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 160: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 172: `assert.ok(kept.includes("Only part of this output was kept."), "a kept part is only part of the output");`. DELETE for the file-level reason above.
  - Original line 173: `assert.ok(!kept.includes("Only the start"), "never that it is the start: OpenCode keeps the end");`. DELETE for the file-level reason above.

## `packages/ui/src/components/agent-chat/primitives/elapsed.test.ts`

Unit failure modes (listed before retaining cases): Duration uses the wrong unit/end point or malformed stamps show NaN.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §7.6 elapsed runtime data; ISO/epoch timestamp interpretation and malformed-provider-data handling. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: ElapsedTicker and WorkflowGroup → elapsedBetween; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: This formatter is the lowest timestamp boundary; no retained render suite owns timestamp arithmetic.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **DELETE** `formatElapsed keeps bare seconds under a minute` — Exact display/padding/unit style; elapsedBetween owner cases retain timestamp arithmetic and malformed-input safety.
- **DELETE** `formatElapsed pads the seconds once minutes appear, so the width is stable` — Exact display/padding/unit style; elapsedBetween owner cases retain timestamp arithmetic and malformed-input safety.
- **DELETE** `formatElapsed drops seconds past an hour and pads the minutes` — Exact display/padding/unit style; elapsedBetween owner cases retain timestamp arithmetic and malformed-input safety.
- **DELETE** `formatElapsed clamps a negative duration rather than rendering '-1s'` — Exact display/padding/unit style; elapsedBetween owner cases retain timestamp arithmetic and malformed-input safety.
- **KEEP** `elapsedBetween accepts ISO stamps and epoch millis alike` — Protects the distinct stated input/output failure: elapsedBetween accepts ISO stamps and epoch millis alike. No stronger duplicate remains; shared six-item contract above applies.
- **REWRITE** `elapsedBetween measures against `now` when there is no end stamp` — Use Node mock Date at the public clock boundary; remove test-only now argument from production.
- **KEEP** `elapsedBetween returns empty for missing or unparseable stamps` — Protects the distinct stated input/output failure: elapsedBetween returns empty for missing or unparseable stamps. No stronger duplicate remains; shared six-item contract above applies.

## `packages/ui/src/components/agent-chat/primitives/meter.test.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** `clampMeterPercent bounds the value and treats absence as empty` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.
- **DELETE** `the overload threshold is exclusive: 90% is still normal` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.
- **DELETE** `meterDashOffset counts backwards from a full stroke` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.
- **DELETE** `formatMeterPercent keeps one decimal below 10 and trims a bare .0` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.
- **DELETE** `formatMeterPercent rounds at and above 10` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.
- **DELETE** `formatMeterPercent is null without a context window, never a fake 0%` — Geometry, declaration self-check or display rounding; context-meter data contract remains in status-line.test.ts.

## `packages/ui/src/components/agent-chat/primitives/shortcut.test.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** `mod resolves per platform` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.
- **DELETE** `modifiers render in the platform's canonical order, not the typed order` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.
- **DELETE** `cmd and meta are aliases of mod, deduped` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.
- **DELETE** `named keys become glyphs on Apple and words elsewhere` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.
- **DELETE** `unknown tokens pass through, single characters upper-cased` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.
- **DELETE** `empty segments never produce a blank key cap` — Tests only display glyph spelling/order/alias formatting, not a keybinding action; no independently required exact display format. Kbd production usage remains.

## `packages/ui/src/components/agent-chat/status/goal-chip.test.ts`

Unit failure modes (listed before retaining cases): Unsupported/destructive command is offered in the wrong state, provider-running action interrupts the workflow, or emitted slash command/message is wrong.

Full bar for each KEEP/REWRITE below: **1** Independent source: Goals design §§4.5,8.2 exact adapter action matrix and command-message protocol. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: AgentChatView/GoalChip → goalActions; AgentChatView also consumes GOAL_ACTION_TEXT; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: Host goal-command tests parse commands but do not decide UI offerings. UI goal render/matrix duplicates are removed.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **DELETE** `the chip shows exactly the unfinished goals` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the chip's detail, per status — the §8.2 table` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the chip adds `<used>/<budget> tok` only when both are known` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `info while active, warn once the goal has stopped short` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the label shimmers only while an ACTIVE goal's turn is running` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the chip's title is the objective, and its spoken name says what state it is in` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `a phase reads as words; the one Orquester itself names reads as a sentence` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the popover names the status, and the phase only when there is one` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `the popover carries the whole objective and every fact the provider reported — only those` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **KEEP** ``the action matrix — ${adapter} × every status × running/idle × background liveness`` — Protects the distinct stated input/output failure: `the action matrix — ${adapter} × every status × running/idle × background liveness`. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `no goal, a finished goal, or no goal support ⇒ no actions` — Protects the distinct stated input/output failure: no goal, a finished goal, or no goal support ⇒ no actions. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `only the actions an adapter honours are ever offered` — Protects the distinct stated input/output failure: only the actions an adapter honours are ever offered. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `the order is the spec's, whatever order the adapter lists them in` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **REWRITE** `each action sends exactly the §8.2 text, as the user's message` — Replace exported-constant self-comparison with literal command text emitted by goalActions.
- **DELETE** `the popover says why a provider-command adapter offers nothing while its turn runs` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `fix round 1 (6): the chip's logic imports pure modules only — never a component` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `fix round 2 (1): Clear is the one destructive action — it is never the control that takes focus` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `fix round 2 (2b): the goal popover is a labelled dialog that takes focus — the props the chip passes` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `final wave (6): waiting on background work wins the chip's detail over the round` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `final wave (3): elapsed is left out at zero and reads `<1s` under a second` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `final wave (5): the chip's spoken name and tooltip cap the objective at 200 characters` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `final wave (2) + micro-fix: the goal popover closes when its tab is LEFT, never when its tab is activated` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: a held goal reads `paused for update`, in the in-motion tone, never live` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: a held goal's spoken name says the pause is Orquester's and ends by itself` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: the popover's status says the same` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: an ordinary pause is unchanged — the warn tone, `paused`, `Paused`` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: the held flag changes nothing on a goal that is not paused` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.
- **DELETE** `goals §5.7: the user wins — a held goal offers what any paused goal offers` — Presentation copy/tone/geometry, declaration self-comparison, import-source inspection, or duplicate lower ownership (goal.logic.test.ts, agent-chat-active-tab.test.ts, dropdown-logic.test.ts). The action matrix retains supported commands and statuses.

## `packages/ui/src/components/agent-chat/status/goal-render.check.ts`

Risk: low; removed checks cannot demonstrate the stated interaction or pin noncontractual rendering. No production behavior change is needed. Validation: retained owner suites and root typecheck/build.

- **DELETE** standalone assertions — CSS/icon/markup layout/copy and extra render-layer replays of goalActions/goal model, goal.logic, dropdown and composer-menu owners. No interactive focus/open/close workflow is exercised.
  - Original line 67: `assert.ok(running.includes("lucide-target"), "the chip carries the target glyph");`. DELETE for the file-level reason above.
  - Original line 68: `assert.ok(running.includes(">Goal<"), "and the word Goal");`. DELETE for the file-level reason above.
  - Original line 69: `assert.ok(running.includes("round 3"), "an active goal names its round");`. DELETE for the file-level reason above.
  - Original line 70: `assert.ok(running.includes("12k/50k tok"), "and its token budget when both halves are known");`. DELETE for the file-level reason above.
  - Original line 71: `assert.ok(running.includes("text-info-300"), "active is the in-motion tone");`. DELETE for the file-level reason above.
  - Original line 72: `assert.ok(running.includes('<span class="ac-shimmer">Goal</span>'), "the label shimmers while a turn runs");`. DELETE for the file-level reason above.
  - Original line 73: `assert.ok(running.includes('title="Make CI green"'), "the objective is one hover away");`. DELETE for the file-level reason above.
  - Original line 74: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 78: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 82: `assert.ok(running.includes("<button"), "the chip is a control: click opens the popover");`. DELETE for the file-level reason above.
  - Original line 83: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 90: `assert.ok(running.includes('aria-haspopup="dialog"'), "the trigger announces a dialog");`. DELETE for the file-level reason above.
  - Original line 91: `assert.ok(running.includes('data-focus-on-open="true"'), "the popover takes focus when it opens");`. DELETE for the file-level reason above.
  - Original line 99: `assert.ok(meterModel);`. DELETE for the file-level reason above.
  - Original line 101: `assert.ok(!meter.includes("aria-haspopup"), "every other dropdown keeps its default role");`. DELETE for the file-level reason above.
  - Original line 102: `assert.ok(!meter.includes("data-focus-on-open"), "…and its default focus behaviour");`. DELETE for the file-level reason above.
  - Original line 105: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 111: `assert.ok(stopped.includes("paused"), "a stopped goal says what stopped it");`. DELETE for the file-level reason above.
  - Original line 112: `assert.ok(stopped.includes("text-warn-300"), "in the warn tone");`. DELETE for the file-level reason above.
  - Original line 113: `assert.ok(!stopped.includes("text-info-300"));`. DELETE for the file-level reason above.
  - Original line 115: `assert.equal(`. DELETE for the file-level reason above.
  - Original line 153: `assert.ok(panel.includes(longObjective.trim()), "the popover carries the WHOLE objective");`. DELETE for the file-level reason above.
  - Original line 154: `assert.ok(panel.includes("overflow-y-auto"), "and scrolls it past a dozen lines rather than growing");`. DELETE for the file-level reason above.
  - Original line 155: `assert.ok(panel.includes("Active"), "the status");`. DELETE for the file-level reason above.
  - Original line 156: `assert.ok(panel.includes("executing"), "and the phase");`. DELETE for the file-level reason above.
  - Original line 157: `assert.ok(panel.includes("two integration tests still fail"), "the last check");`. DELETE for the file-level reason above.
  - Original line 158: `assert.ok(panel.includes("12k of 50k"), "tokens against the budget");`. DELETE for the file-level reason above.
  - Original line 159: `assert.ok(panel.includes("12m 5s"), "elapsed");`. DELETE for the file-level reason above.
  - Original line 160: `assert.ok(panel.includes("Pause"), "Codex offers pause while active…");`. DELETE for the file-level reason above.
  - Original line 161: `assert.ok(panel.includes("Clear goal"), "…and clear, always");`. DELETE for the file-level reason above.
  - Original line 162: `assert.ok(!panel.includes("Resume"), "never resume on an active goal");`. DELETE for the file-level reason above.
  - Original line 163: `assert.ok(panel.includes("/goal pause"), "each action says what it will send");`. DELETE for the file-level reason above.
  - Original line 167: `assert.ok(clearButton.includes('data-destructive="true"'), "Clear is marked destructive");`. DELETE for the file-level reason above.
  - Original line 169: `assert.ok(pauseButton.length > 0, "the Pause button renders");`. DELETE for the file-level reason above.
  - Original line 170: `assert.ok(!pauseButton.includes("data-destructive"), "Pause is not destructive");`. DELETE for the file-level reason above.
  - Original line 180: `assert.ok(!claudeRunning.includes("<button"), "no action while a provider-command turn runs");`. DELETE for the file-level reason above.
  - Original line 181: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 214: `assert.ok(withGoal.includes("lucide-target"), "the status line shows the chip");`. DELETE for the file-level reason above.
  - Original line 215: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 219: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 226: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 231: `assert.ok(!withoutGoal.includes("lucide-target"), "no goal, no chip");`. DELETE for the file-level reason above.
  - Original line 235: `assert.ok(!finished.includes("lucide-target"), "a goal that can't be met has no chip either");`. DELETE for the file-level reason above.
  - Original line 243: `assert.ok(dot.includes("lucide-target"), "a 9px target before the dot");`. DELETE for the file-level reason above.
  - Original line 244: `assert.ok(dot.includes('width="9"'), "at 9px");`. DELETE for the file-level reason above.
  - Original line 245: `assert.ok(dot.indexOf("lucide-target") < dot.indexOf("lucide-circle"), "before the dot, not after it");`. DELETE for the file-level reason above.
  - Original line 246: `assert.ok(dot.includes('aria-label="Goal: Make CI green (active)"'));`. DELETE for the file-level reason above.
  - Original line 247: `assert.ok(dot.includes('title="Goal: Make CI green (active)"'));`. DELETE for the file-level reason above.
  - Original line 248: `assert.ok(dot.includes("text-info-300"), "active is the in-motion tone");`. DELETE for the file-level reason above.
  - Original line 256: `assert.ok(stalledDot.includes("text-warn-300"), "a stalled goal is the warn tone");`. DELETE for the file-level reason above.
  - Original line 258: `assert.ok(!plainDot.includes("lucide-target"), "no goal: the dot is exactly what it was");`. DELETE for the file-level reason above.
  - Original line 259: `assert.ok(plainDot.startsWith("<svg"), "no wrapper around a plain dot — callers' layouts are untouched");`. DELETE for the file-level reason above.
  - Original line 267: `assert.ok(!junkDot.includes("lucide-target"), "a goal it cannot read draws nothing, never a crash");`. DELETE for the file-level reason above.
  - Original line 271: `assert.ok(exitedDot.includes("lucide-target"), "the goal outlives the process: an exited tab still has it");`. DELETE for the file-level reason above.
  - Original line 272: `assert.ok(exitedDot.includes('aria-label="Exited"'), "beside the exited dot");`. DELETE for the file-level reason above.
  - Original line 291: `assert.ok(set.includes("lucide-target"), "the marker carries the target glyph");`. DELETE for the file-level reason above.
  - Original line 292: `assert.ok(set.includes("Goal set: Make CI green"), "and the row's own summary");`. DELETE for the file-level reason above.
  - Original line 293: `assert.ok(set.includes('role="separator"'), "a compact marker, like the compaction marker");`. DELETE for the file-level reason above.
  - Original line 294: `assert.ok(!set.includes("text-danger"), "a set goal is not an error");`. DELETE for the file-level reason above.
  - Original line 307: `assert.ok(achieved.includes("4 rounds · 12m 5s · 1.3m tokens"), "an ended goal says what it cost");`. DELETE for the file-level reason above.
  - Original line 314: `assert.ok(failed.includes("text-danger"), "a goal that can't be met reads in the danger tone");`. DELETE for the file-level reason above.
  - Original line 315: `assert.ok(!failed.includes(" · "), "no stats line when nothing about the cost is known");`. DELETE for the file-level reason above.
  - Original line 341: `assert.ok(menu.includes("/goal"), "Codex's host-parsed /goal is in the menu");`. DELETE for the file-level reason above.
  - Original line 342: `assert.ok(menu.includes("Set, check, pause, resume or clear a goal"), "with its description");`. DELETE for the file-level reason above.
  - Original line 343: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 347: `assert.ok(menu.includes("lucide-target"), "under the goal glyph, not the generic wand");`. DELETE for the file-level reason above.
  - Original line 360: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 365: `assert.ok(chipTrigger.includes(ring), the chip's trigger shows a focus ring (${ring}));`. DELETE for the file-level reason above.
  - Original line 369: `assert.ok(meterTrigger.includes(ring), the context meter's trigger shows a focus ring (${ring}));`. DELETE for the file-level reason above.
  - Original line 371: `assert.ok(!meterTrigger.includes("shrink"), "the meter keeps its size: it is the line's anchor");`. DELETE for the file-level reason above.
  - Original line 381: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 385: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 389: `assert.ok(!waitingChip.includes(">round 3<"), "the round is the popover's to show here");`. DELETE for the file-level reason above.
  - Original line 409: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 421: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 425: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 429: `assert.ok(heldChip.includes("text-info-300"), "in the in-motion tone: nothing went wrong");`. DELETE for the file-level reason above.
  - Original line 430: `assert.ok(!heldChip.includes("text-warn-300"), "never the warn tone of a pause the user made");`. DELETE for the file-level reason above.
  - Original line 431: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 435: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 455: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 459: `assert.ok(!heldPanel.includes(">Paused<"), "not the bare status of a user's pause");`. DELETE for the file-level reason above.
  - Original line 460: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 468: `assert.ok(heldLine.includes(">paused for update<"), "the status line hands the hold to its chip");`. DELETE for the file-level reason above.
  - Original line 470: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 482: `assert.ok(heldDot.includes("text-info-300"), "the tab's target keeps the in-motion tone beside its working dot");`. DELETE for the file-level reason above.
  - Original line 483: `assert.ok(`. DELETE for the file-level reason above.
  - Original line 494: `assert.ok(pausedDot.includes("text-warn-300"), "a pause the user made is still the warn tone");`. DELETE for the file-level reason above.
  - Original line 495: `assert.ok(pausedDot.includes('aria-label="Goal: Make CI green (paused)"'));`. DELETE for the file-level reason above.

## `packages/ui/src/components/agent-chat/status/status-line.test.ts`

Unit failure modes (listed before retaining cases): Unavailable context becomes fake percentage, overflow yields negative remaining, no frame invents usage, malformed extras propagate or false compaction verdict is lost.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §7.6 context capability/usage data; API token usage compactsAutomatically tri-state. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: ChatStatusLine/ContextMeter → deriveContextMeter; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: Runtime status.logic owns provider frame selection, not meter arithmetic/capability degradation. This is the lowest meter model owner.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **REWRITE** `the meter reports a percentage only when a context window is reported` — Remove formatted display-copy assertion; keep literal 25 percent and 150000 remaining.
- **REWRITE** `without maxTokens there is no ring and no percentage — never a zero` — Remove formatted display-copy assertion; keep absent percentage and remaining counts.
- **KEEP** `an adapter that does not report a context window degrades even if a max leaks through` — Protects the distinct stated input/output failure: an adapter that does not report a context window degrades even if a max leaks through. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `usage past the window clamps at 100% and never reports negative remaining` — Protects the distinct stated input/output failure: usage past the window clamps at 100% and never reports negative remaining. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `no usage frame yet means no meter at all, not a zeroed one` — Protects the distinct stated input/output failure: no usage frame yet means no meter at all, not a zeroed one. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `zero and non-finite extras are dropped rather than shown` — Protects the distinct stated input/output failure: zero and non-finite extras are dropped rather than shown. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `context token formatting keeps a decimal only where it carries information` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `the auto-compaction sentence states a reported threshold exactly` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `a provider that says auto-compaction is OFF is believed over the vague copy` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **KEEP** `the meter carries the auto-compaction verdict through to its model` — Protects the distinct stated input/output failure: the meter carries the auto-compaction verdict through to its model. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `a running turn shimmers its activity label` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `a turn with no label yet still reads as working` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `a settled thread is muted, static and untimed` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `a degraded connection outranks the turn, but the elapsed timer keeps running` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.
- **DELETE** `plan progress is counted from the steps, never persisted` — Presentation copy/animation/format contract is not independently needed; retained context arithmetic/capability tests own data validity.

## `packages/ui/src/components/agent-chat/thread-switch.test.ts`

Unit failure modes (listed before retaining cases): An old thread becomes interactive under a new ID, fresh rows lose precedence, empty settled thread retains another thread, or a hold perpetuates itself.

Full bar for each KEEP/REWRITE below: **1** Independent source: GUI design §7.1 hold the outgoing rows inert until the incoming snapshot. **2** The case names its concrete caller-visible wrong result below. **3** Expected values are literal decisions, IDs, booleans, answer payloads or independently calculated durations, never imported production decisions; rewrites remove remaining self-comparisons. **4** Stable production seam: AgentChatView → resolveThreadSwitchTimeline/nextHeldTimeline; input/output semantics, not collaborator call counts. **5** Cases tolerate different internal algorithms and React markup, because they assert semantic results. **6** Lowest owner / stronger coverage: The projection helper is the lowest owner; store snapshots do not own presentation session identity.

Risk: low for removed presentation/private assertions; retained cases cover the distinct data/state failures listed. Validation: focused command above with this retained path.

- **KEEP** `rows for the named thread always win` — Protects the distinct stated input/output failure: rows for the named thread always win. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a reconnect on the same thread repaints its own rows, still interactive` — Protects the distinct stated input/output failure: a reconnect on the same thread repaints its own rows, still interactive. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `switching to a thread with no snapshot holds the previous one, inert` — Protects the distinct stated input/output failure: switching to a thread with no snapshot holds the previous one, inert. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `a settled empty thread renders empty rather than someone else's rows` — Protects the distinct stated input/output failure: a settled empty thread renders empty rather than someone else's rows. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `an empty hold never engages, so the hold cannot outlive its content` — Protects the distinct stated input/output failure: an empty hold never engages, so the hold cannot outlive its content. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `nothing held yet and nothing to show is simply empty` — Protects the distinct stated input/output failure: nothing held yet and nothing to show is simply empty. No stronger duplicate remains; shared six-item contract above applies.
- **KEEP** `only a settled non-empty paint is remembered` — Protects the distinct stated input/output failure: only a settled non-empty paint is remembered. No stronger duplicate remains; shared six-item contract above applies.
- **DELETE** `an unchanged projection keeps its object identity` — Private referential optimization, not the visible thread-switch contract.

## Banner render rewrite bar

**1** GUI §7.5 requires all decision controls disabled while replying, preserves provider warnings as accessible descriptions, gates dismissal on dismissible requests, and masks Codex secret answers. **2** Enabled duplicate decisions, unavailable dismiss buttons, lost warning descriptions or visible credentials are user-visible failures. **3** Tests use literal disabled/password/aria states and fixture warning bytes; no expected value is imported from the owner. **4** React components render semantic HTML, their external output seam. **5** No CSS, wrapper, tag ordering or copy snapshots survive; controls may be rearranged. **6** The pending-answer model cannot own actual DOM disabled/password/aria attributes; these checks are the lowest owner for those rendered states. Risk: low. Baseline and post-cleanup focused checks use existing server-render hooks.

## Production caller and seam audit

Root imports verified: AgentChatView consumes goalActions and GOAL_ACTION_TEXT; GoalChip alone consumes goalPopoverProps/GoalPanel; elapsedBetween is used by ElapsedTicker and WorkflowGroup; formatElapsed is internal except barrel export; Kbd alone uses shortcutKeys with default platform. Private approval join/classifier functions are internal except tests. bannerPriority is internal except barrel/tests. Planned removal: deleted-file helpers, exhaustive Escape generator, private approval join/classifier exports, isIdleChatEscape/isEditableTarget exports once only internal, goalPopoverProps wrapper (inline actual Dropdown props), GoalPanel external export, goal panel/elapsed clock injection, unused formatGoalPhase/wait-note/formatElapsed/overload constant exports, shortcut platform injection. Existing live owners remain.

## Follow-up decisions recorded before seam removal

- **REWRITE** approval-detail cases `E7: the request's own detail wins and is marked as such`, `E7: with no detail, the card joins the gated tool call by toolUseId`, `E7: the path list alone is enough when the item carries no diff`: retain exact independent approval bytes/paths, remove internal source labels. First case gains a competing matching tool item so precedence is actually tested. The six-item approval contract above applies.
- **REWRITE** `thread-switch.test.ts` / `only a settled non-empty paint is remembered`: compare semantic prior projection content, not private reference identity. Same six-item thread-switch contract applies.
- **REMOVE seam** `ResolvedApprovalDetail.source` and `data-approval-detail`: full repository references show only the deleted render check and resolver tests consume this provenance metadata; the real ApprovalCard needs text/isDiff. No production reader needs the field. `ApprovalCard` keeps the same visible detail content.

Before final keyboard edits: fake `closest` only accepted the current selector shape, so it fails the refactor bar. Delete those target-wiring cases and move the existing foreign-field regression to the real key decision input. No new behavior case is added.

Before final dead-support edits: repository-wide searches found no surviving reader for `data-full-output-note`, `data-drill-in-crashed` or `data-approval-decision`, and no caller outside the defining module/barrel for UI `DEFAULT_APPROVAL_OPTIONS` or `ContextMeterPanel`. Remove those selectors/exports. `DrillInErrorBoundary.back` only forwards `onBack` and existed to be invoked by the deleted class-instance test; wire the existing callback directly. `ChatErrorBoundary.reset` still owns real reset logic, so retain it as private. Risk: no visual/action change; validate UI typecheck/build and semantic banner check.

## Completed implementation and validation

The local scope was pruned and the listed production seams removed. Timeline and roster work is also implemented; their linked ledgers contain their complete case dispositions, seam removals and exact focused validation. Production behavior was not changed to make tests pass. The only rendered DOM removals are unused test selectors; visible content and actions remain.

- Local root/banners/status/primitives original test/check LOC: 3546; retained: 1185.
- Full assigned 43-file test/check scope: 9,388 original LOC; 2054 retained. This is descriptive, not a deletion target.
- Baseline local owner run: 152 tests passed, 0 failed (before edits), `/tmp/orquester-test-cleanup/chat-local-baseline.log`.
- Final local owner run: 89 tests passed, 0 failed, `/tmp/orquester-test-cleanup/chat-local-final.log`.
- Rewritten `banners/banner-render.check.ts`: passed with existing loader hooks; verifies real disabled controls, warning aria-description, dock dismissal gating and password/file-input state.
- Delegated roster: 18 tests passed plus seeded shell-output component check; see `ui_chat_roster.md`.
- Delegated timeline: 31 tests passed; see `ui_chat_timeline.md`.
- UI typecheck attempted twice during concurrent edits. First saw a file deleted after TypeScript enumerated it (`plan-follow-up.test.ts`, TS6053). Second reported ongoing edits in `src/lib/agent-chat` (removed exports/injection options versus tests still being edited), no component-scope diagnostics. Root owns the final repository typecheck/test/build gates after integration; this is not reported as a passing typecheck.

Final local unit command, from `packages/ui`:

```sh
node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/components/agent-chat/drill-in-navigation.test.ts src/components/agent-chat/escape-action.test.ts src/components/agent-chat/thread-switch.test.ts src/components/agent-chat/banners/approval-detail.test.ts src/components/agent-chat/banners/banner-model.test.ts src/components/agent-chat/banners/pending-answer.test.ts src/components/agent-chat/status/goal-chip.test.ts src/components/agent-chat/status/status-line.test.ts src/components/agent-chat/primitives/elapsed.test.ts
node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs src/components/agent-chat/banners/banner-render.check.ts
```

Typecheck command from repository root: `pnpm --filter @orquester/ui typecheck`.

Removed support: deleted checks' fake component state setters and console wrappers; exhaustive Escape generator and selector-specific fake DOM; goal test-only props wrapper and panel exports; goal panel/elapsed clock injection; shortcut platform injection; internal approval join/classifier exports/provenance and unused data selectors; private goal-phase/wait-note and primitive formatting/threshold exports; unused default-approval export; drill-in error callback forwarding method. No shared fixtures or package scripts were changed locally. Retained production-used functions (including `GOAL_ACTION_TEXT`, `formatGoalElapsed`, `isAppleLike`) were verified against repository callers and preserved.

Final support sweep: `banners/index.ts` describes exports for isolated tests but has no
production or test import anywhere in the repository; callers import the actual component
and model modules directly. Remove this unused export-only barrel. This removes no callable
package export or runtime behavior; the UI typecheck and web/desktop builds validate callers.
