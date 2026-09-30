# Strict cleanup: UI chat components (scope 4)

Status: completed cleanup of the initial scope; incoming remote dispositions and patch preparation recorded below.

Independent references: [GUI design](../../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [goals design](../../superpowers/specs/2026-09-24-agent-goals-design.md), [attachment requirements](../../superpowers/plans/2026-09-22-chat-attachment-paths-and-chips.md), and shared API contracts in `packages/api/src/agent-chat/{runtime-events,adapter-types,thread}.ts`.

## Six-bar evidence convention

Each named retained case below is one concrete contract variant: its original name states the expected operation/state and its assertions use literal input/output fixtures (or a literal rejection/no-action result), never values computed by the owner. The per-file evidence identifies (1) an independent requirement/protocol/regression, (2) the visible failure, (4) the production-consumed stable seam, and (6) the distinct lowest owner. For (3), unchanged literal expectations can disagree with the implementation; no production result computes an expected result. For (5), retained cases do not inspect source, private calls, identity, CSS classes, markup trees, coordinates, or exact UI copy; callbacks are public effect boundaries, and resource/DOM checks observe data, disabled state or security attributes. REWRITEs remove private test-only seams while keeping precisely the same independent behavior. Domain IDs, command bytes and persisted schema fields are contracts, not implementation shape.

Risk: deletion removes presentation/private-helper probes, not transport/storage/security ownership. Rewrites are confined to the lowest production-consumed seam. Runtime algorithms remain unchanged. Non-test callers below were verified with repository-wide reference searches (including web and desktop, which share packages/ui).

Validation command for each .test.ts: from packages/ui, `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 <path>`. For .check.ts use the same hooks without --test. Root owns repository-wide gates.

## packages/ui/src/components/agent-chat/banners/approval-detail.test.ts

Independent source (bar 1): GUI §7.5 informed approval + §5.6 slimmed tool data; toolUseId is the shared API correlation key.
Stable seam and real callers (bars 4–5): resolveApprovalDetail → ApprovalCard.
Visible failure family (bar 2): wrong command/file shown before consent, stale details or crash.
Lowest owner / remaining stronger coverage (bar 6): Request detail precedence, same-id join, non-guessing and malformed payload are separate failure modes; no retained renderer test computes these joins..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `E7: the request's own detail wins and is marked as such` (baseline line 38) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: with no detail, the card joins the gated tool call by toolUseId` (baseline line 46) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: the path list alone is enough when the item carries no diff` (baseline line 62) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: the join is by id only — a second write in flight is never guessed at` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: the newest activity wins when a tool id is reused across updates` (baseline line 78) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: a command payload is used when there are no changed files` (baseline line 86) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `E7: a missing or malformed payload never throws` (baseline line 94) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/banners/banner-model.test.ts

Independent source (bar 1): GUI §4.3 and §7.5 approval decision availability, §7.6 background Stop availability.
Stable seam and real callers (bars 4–5): splitApprovalOptions / resolveDockCard / showBackgroundLivenessBanner → ApprovalCard / ChatBannerDock.
Visible failure family (bar 2): unavailable approval choices or hidden actionable request/Stop.
Lowest owner / remaining stronger coverage (bar 6): These policy functions own decision availability; render checks own actual disabled/masked controls, not the same policy..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `activity sorts first, then severity, then notices` (baseline line 11) — Notice presentation ordering is an appearance change detector; no action or data loss is asserted. Dock action priority remains covered by resolveDockCard.
- **KEEP** `the default four split into Approve/Decline primary and the rest overflow` (baseline line 23) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an empty advertised list falls back to the default four` (baseline line 35) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `advertised approval decisions keep their grouping when reordered` (baseline line 41) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the liveness banner is hidden while a turn is working` (baseline line 51) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the dock shows one card at a time, in a fixed priority order` (baseline line 66) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/banners/banner-render.check.ts

Stable seam/non-test callers: actual React components used by AgentChatView. Fixed provider data and accessible state are independent oracles; these checks survive layout/class refactors and own wiring that pure policy tests cannot prove. No fake implementation renders the expected behavior. Risk: low; run the check with package hooks.

- **KEEP** `approval controls disabled during response` — GUI §7.5: approval buttons have disabled state while its request is in flight; catches duplicate consent through enabled controls.
- **KEEP** `question controls disabled during response` — GUI §7.5: answer buttons and text input disabled while response is in flight; catches duplicate answers and draft edits during submission.
- **KEEP** `provider option warning and label exposed` — API ApprovalOption data: actual provider warning must reach aria-description and its option label remain visible; literals are provider data, not UI copy.
- **KEEP** `dismiss only a dismissible native request` — API PendingUserInput.dismissible / GUI §7.5: false hides dismissal, true exposes it; prevents abandoning blocked provider callbacks.
- **KEEP** `secret answer masking and attachment exclusion` — GUI §7.5/Codex isSecret: actual compact input is password and no plaintext/file input appears; security boundary absent from pure answer conversion.

## packages/ui/src/components/agent-chat/banners/pending-answer.test.ts

Independent source (bar 1): GUI §7.5 and API UserInputQuestion / answers map; AGENTS.md secret isolation.
Stable seam and real callers (bars 4–5): buildPendingUserInputAnswers / derivePendingUserInputProgress / answer transitions / questionShortcutOption → QuestionCard.
Visible failure family (bar 2): wrong submitted answer, premature submission, lost typed answer, leaked credential or unintended answer behind a modal.
Lowest owner / remaining stronger coverage (bar 6): Lowest question-answer conversion and keyboard decision owner; rendering only checks masking/disabled state. Transition cases cover edits; direct builder cases cover wire serialization..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **REWRITE** `an option with no value answers with its label` (baseline line 32) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `a custom answer beats a selected option` (baseline line 40) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `a custom answer is refused when the question forbids one` (baseline line 45) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `multi-select answers with an array and drops unknown values` (baseline line 50) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `an attachment alone satisfies a question` (baseline line 58) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `an unfinished upload keeps the answer unresolved` (baseline line 66) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **KEEP** `a choice-only question offers no attachments` (baseline line 76) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `an `isOther` option asks for text rather than answering with its label` (baseline line 81) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **KEEP** `a secret answer is never carried back into the thread draft` (baseline line 98) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `displaced text lands after whatever was already in the draft` (baseline line 102) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `toggling clears the custom answer; multi-select toggles in place` (baseline line 108) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `a new single-select choice becomes the submitted answer` (baseline line 118) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **REWRITE** `custom text overrides a choice while empty text preserves it` (baseline line 125) — Observe the submitted answers map through buildPendingUserInputAnswers, which QuestionCard calls; remove the test-only export of its single-question resolver. Existing literal answer expectations remain independent.
- **KEEP** `the answers map is null until every question resolves` (baseline line 134) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `progress reports the active question, the count and completeness` (baseline line 146) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an out-of-range question index is clamped, never thrown on` (baseline line 160) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `attachment drafts are namespaced per (requestId, questionId)` (baseline line 167) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a digit picks its option on the visible tab` (baseline line 187) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover` (baseline line 194) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a digit never answers from a hidden tab, while typing, or under a modifier` (baseline line 204) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `only 1–9, and only an option the question has` (baseline line 212) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-bridge.test.ts

Independent source (bar 1): GUI §7.4 delivery targets the live composer for a session; credible stale-effect cleanup race.
Stable seam and real callers (bars 4–5): registerComposerHandle + insertComposerText → ChatComposer, AgentChatView, right rail.
Visible failure family (bar 2): a stale unmount disconnects the replacement composer and loses inserted text.
Lowest owner / remaining stronger coverage (bar 6): Only stale-registration race test; other delivery tests assume a single registered composer..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `a stale unregister cannot drop the handle that replaced it` (baseline line 18) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-draft.test.ts

Independent source (bar 1): GUI §7.4 draft persistence, returning files, failed-send recovery; AGENTS.md persisted data survives reload.
Stable seam and real callers (bars 4–5): composerDraftToPersist / loadComposerDraft / draftAfterReturn / persistedDraftAfterReturn / scheduler flush/write → ChatComposer and store.
Visible failure family (bar 2): lost text/files/context, wrong image references or a sent message restored by a late write.
Lowest owner / remaining stronger coverage (bar 6): Serialization and restoration own these transformations. Store tests own routing; submission owns the underlying front/back merge, not persistable state and file-ref fallback..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `builds the persisted shape from text, uploaded refs and the carried context` (baseline line 45) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `re-stages every uploaded attachment as a ready chip and keeps the text verbatim` (baseline line 66) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps every file a restore wrote, over the eight, de-duplicated — the send gate holds the rest` (baseline line 84) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a file a bound still refuses leaves the message as its chip's X would take it, and is handed back for its path` (baseline line 113) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `merges behind the persisted draft, keeping every file and its context` (baseline line 142) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `writes a returned file a bound refuses into the text as its path, so no later mount drops a file` (baseline line 163) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `does not write on the keystroke, and writes the newest draft once when the window closes` (baseline line 196) — Pins the internal 300 ms batching window. Flush/unmount and immediate-clear tests protect lost-tail and resurrected-message failures without requiring this timer strategy.
- **KEEP** `flushes synchronously, so an unmount or a reload keeps the tail` (baseline line 209) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `writes a clear immediately and drops anything the debounce still held` (baseline line 221) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `cancels without writing` (baseline line 231) — Private scheduler cancellation probe with no user operation; flush/clear retained tests own persistence outcomes.

## packages/ui/src/components/agent-chat/composer/composer-failed-send.test.ts

Independent source (bar 1): GUI §7.4 failed send returns to originating thread, not a newly visible one.
Stable seam and real callers (bars 4–5): restoreFailedSendDraft → ChatComposer; real bridge and persisted draft store.
Visible failure family (bar 2): failed message lost or inserted into another conversation / overwritten behind a mounted composer.
Lowest owner / remaining stronger coverage (bar 6): Unique settle-time routing seam; lower draft tests transform text and files but do not choose the live versus persisted owner..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `handed another thread while it was in flight: into its own thread's persisted draft, never the one on screen` (baseline line 109) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `unmounted by a project switch: into its own thread's persisted draft, where the next mount loads it` (baseline line 150) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `still showing its thread: into the live draft, as always, and nothing is written behind it` (baseline line 159) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `its tab open again in another composer: into that composer's live draft, never behind its back` (baseline line 168) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a composer that no longer shows the thread refuses it, and the persisted draft takes it` (baseline line 196) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a send that gives nothing back writes no draft: a refusal, a failed Implement` (baseline line 218) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-files.test.ts

Independent source (bar 1): GUI §7.4 attachment host paths are inserted/removed with chips; attachment-paths plan Task 4.
Stable seam and real callers (bars 4–5): removeFilePath → ChatComposer and returned-draft handling.
Visible failure family (bar 2): removing one chip deletes unrelated prompt text or leaves the selected file path.
Lowest owner / remaining stronger coverage (bar 6): Lowest literal path edit owner, distinct from image ordinal edits and generic insert splicing..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `removing a file drops its path and one adjacent space` (baseline line 6) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `removes exactly one occurrence, so a path the user repeated stays` (baseline line 14) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `treats the path literally: metacharacters in a name never widen the match` (baseline line 18) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-images.test.ts

Independent source (bar 1): GUI §7.4 image placeholder identity and preview lifecycle; attachment-paths plan Task 6.
Stable seam and real callers (bars 4–5): imageOrdinal / removeImagePlaceholder / revokeImagePreviews / withoutPreviews → ChatComposer.
Visible failure family (bar 2): prompt names the wrong image, preview memory remains live, or failed send restores an unusable revoked URL.
Lowest owner / remaining stronger coverage (bar 6): Ordinal removal differs from two-draft merge. Blob fetch verifies real resource liveness, not a revoke mock; no other owner checks preview lifecycle..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `numbers images by position among images only` (baseline line 12) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `removing an image drops its placeholder and renumbers the later ones` (baseline line 24) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `releases every staged preview without revoking an unrelated image` (baseline line 34) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `hands chips back without their revoked preview URLs, and the rest untouched` (baseline line 46) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-menu.test.ts

Independent source (bar 1): GUI §4.6.7–8 menu grammar, capabilities, insertion and skills; goals §8.5; Grok permission-mode ownership §4.4.
Stable seam and real callers (bars 4–5): buildSlashMenuItems / buildSkillMenuItems / compactCommandAvailable / menuItemReplacement / menuItemAction / blockedProviderCommandMessage → ChatComposer and menu.
Visible failure family (bar 2): an unusable command is offered, valid skill hidden, permission mode desynchronizes, or a pick submits the wrong command.
Lowest owner / remaining stronger coverage (bar 6): This owner decides selectable items and inserted command bytes. Trigger parsing and host dispatch own different boundaries. Artificial tie-only helper test is deleted..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **REWRITE** `a disabled skill is never offered, and userInvocable:false hides one` (baseline line 38) — Exercise the production menu builder instead of exported private filtering/scoring helpers. Assert the actual selectable command/skill data; remove unused helper exports.
- **REWRITE** `userInvocationOnly does not hide a skill — it is the reason to show it` (baseline line 44) — Exercise the production menu builder instead of exported private filtering/scoring helpers. Assert the actual selectable command/skill data; remove unused helper exports.
- **REWRITE** `the slash-menu skill setting is honoured; the $ menu ignores it` (baseline line 49) — Exercise the production menu builder instead of exported private filtering/scoring helpers. Assert the actual selectable command/skill data; remove unused helper exports.
- **KEEP** `a skill that is also advertised as a command is listed once, as the skill` (baseline line 55) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `away from offset 0 provider commands are dropped; host commands and skills stay` (baseline line 71) — Exercise the production menu builder instead of exported private filtering/scoring helpers. Assert the actual selectable command/skill data; remove unused helper exports.
- **KEEP** `/plan and /default appear only where the plan toggle is shown` (baseline line 84) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `/effort appears only when the selected model has a reasoning descriptor` (baseline line 96) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `/compact is hidden until its full precondition list holds` (baseline line 106) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the compact precondition rejects a non-empty draft or any attachment` (baseline line 122) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `a name match outranks a description match` (baseline line 138) — Exercise the production menu builder instead of exported private filtering/scoring helpers. Assert the actual selectable command/skill data; remove unused helper exports.
- **DELETE** `ties break host commands, then provider commands, then skills` (baseline line 161) — Constructs three identically named entries that the real menu deduplicates before ranking. This impossible-input tie test cannot expose a user-visible menu failure.
- **KEEP** `insertion: provider commands and skills insert text, host commands insert nothing` (baseline line 179) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-2: a synthesised provider /effort never duplicates the host row` (baseline line 215) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-5: Grok's /always-approve is refused with a pointer at the mode chip` (baseline line 233) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-5: the refusal is Grok-only and never fires on a lookalike` (baseline line 238) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: a host-parsed /goal (Codex) joins the host commands, with its description and hint` (baseline line 253) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: a provider adapter's own /goal entry is used unchanged` (baseline line 264) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: the host row replaces a provider row of the same name — one /goal, never two` (baseline line 277) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: picking /goal TYPES it — the host parses the sent text, so it must reach the draft` (baseline line 287) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: /goal is offered only at the start of the prompt — the host recognises nothing else` (baseline line 300) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.5: picking /goal ACTS on nothing — the insertion is the whole pick, nothing is sent` (baseline line 310) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-model.test.ts

Independent source (bar 1): API ProviderModel / ModelSelection option descriptors; GUI §7.4 and §4.6.5 effort command.
Stable seam and real callers (bars 4–5): findReasoningDescriptor / resolveSelectedModel / currentOptionValue / applyModelSelection / applyEffortArgument → ComposerChips / ChatComposer / workflow chain models.
Visible failure family (bar 2): wrong selected model, dropped account binding or unsupported option sent to a provider.
Lowest owner / remaining stronger coverage (bar 6): Owns UI selection adaptation; provider validation cannot protect selected UI values. Direct list-update duplicate is deleted..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `the reasoning descriptor is found under any of the four adapters' ids` (baseline line 41) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a boolean descriptor is never mistaken for the reasoning select` (baseline line 52) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the selected model falls back to the provider default, then to the first` (baseline line 62) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an unset option reads the descriptor's default, then its currentValue` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `setting an option adds it, then replaces it in place` (baseline line 76) — Private option-list update duplicated by the retained /effort command and model-switch contracts; no distinct picker behavior is exercised.
- **KEEP** `switching model drops options the new model does not advertise` (baseline line 84) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an option whose value is no longer a valid choice is dropped too` (baseline line 102) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `/effort <id> matches by id or label and refuses anything else` (baseline line 110) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-outbox.test.ts

Independent source (bar 1): GUI §7.4 reload outbox with same commandId, per-page ownership, cap and absence bound; AGENTS.md tolerant persisted parsing.
Stable seam and real callers (bars 4–5): public outbox record/adopt/write/read operations → agent-chat store; real isolated module reload + sessionStorage bytes.
Visible failure family (bar 2): duplicate/lost messages after reload, reordered queues, wrong-thread replay or a malformed payload losing valid entries.
Lowest owner / remaining stronger coverage (bar 6): Lowest storage/reload seam; store replay tests own dispatch receipts, not each storage schema and ownership branch. Literal v1 bytes and IDs are independent oracles..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `hands what this page is sending to the next page of the tab, once — never back to this page` (baseline line 87) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `hands a thread its own leftovers only, and leaves every other thread's for that thread` (baseline line 103) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `forgets a settled entry even while it is still stored under the page that left it` (baseline line 111) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `writes a queue over any stored copy of its messages, whichever page stored it` (baseline line 120) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `mirrors a thread's queue in order, keeping the send in flight and every other thread's queue` (baseline line 130) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `never drops a send in flight to stay under the cap — only messages still waiting, oldest first` (baseline line 152) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `holds a message at the front of a thread's kept queue, reason and all, and says whether it could` (baseline line 170) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `holds a later failure behind the ones it follows, keeping their order` (baseline line 187) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `says whether a queue write reached the storage` (baseline line 196) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps a thread's last-shown stamp while it has queued messages, and forgets it with them` (baseline line 207) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `is fresh while the later of the queue's last showing and the message's queueing is within the bound` (baseline line 222) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps every send in flight even past the cap: the bound only ever drops a waiting message` (baseline line 237) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `reads nothing out of a value that is not a v1 outbox` (baseline line 264) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps the entries it can read, and drops each one it cannot` (baseline line 270) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `drops a malformed optional field, never the message it belongs to` (baseline line 298) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps a model selection and a plan-mode turn it can read` (baseline line 354) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `reads a held message's reason, and the last-shown stamps, field-wise` (baseline line 376) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps the first of two entries under one commandId` (baseline line 403) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-send-render.check.ts

Stable seam/non-test callers: actual React components used by AgentChatView. Fixed provider data and accessible state are independent oracles; these checks survive layout/class refactors and own wiring that pure policy tests cannot prove. No fake implementation renders the expected behavior. Risk: low; run the check with package hooks.

- **KEEP** `A send stays disabled on remount` — GUI §7.4 regression: composer remounted while A send in flight cannot send again.
- **KEEP** `A rewind stays disabled on remount` — GUI §5.5/§7.4: rewind cannot race A send.
- **KEEP** `B send remains available` — Unrelated thread B still implements its plan while A sends.
- **KEEP** `B rewind remains available` — Unrelated thread B can open rewind while A sends.
- **KEEP** `A send re-enables after settle` — Settled send releases actual send control.
- **KEEP** `A rewind re-enables after settle` — Settled send releases actual rewind control.

Baseline scanner also listed these assertion/helper labels (all covered by the scenarios above): `button(a, "send")`, `button(a, "rewind")`, `button(b, "send")`, `button(b, "rewind")`, `button(composer("A"), "send")`, `button(composer("A"), "rewind")`.

## packages/ui/src/components/agent-chat/composer/composer-sends.test.ts

Independent source (bar 1): GUI §7.4 a send outlives its composer and queues serialize across store generations.
Stable seam and real callers (bars 4–5): begin/is/subscribe composer and queued sends → store, ChatComposer, useComposerSending and history.
Visible failure family (bar 2): another send settles the wrong thread/token, remounted UI enables duplicates, queue overtakes or listeners keep acting after disposal.
Lowest owner / remaining stronger coverage (bar 6): Token/observer semantics are the stable subscription contract; static render verifies only initial UI subscription snapshot and does not exercise notification transitions..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `each settle closes its own send only, and a second call is a no-op` (baseline line 22) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a send that left A, settling late, never re-enables B's send` (baseline line 33) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `tells subscribers about every change, until they unsubscribe` (baseline line 44) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `holds a thread's queue while any of its queued sends is in flight, and no other thread's` (baseline line 68) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `is not a composer send: a queued send never reads as Sending, and a composer send never holds the queue` (baseline line 80) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `tells its listeners which thread's queue moved, until they unsubscribe` (baseline line 89) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-submission.test.ts

Independent source (bar 1): GUI §4.1 turn bounds, §7.4 keyboard/paste/send/recovery and §7.3 complete plans; goals §8.2/8.5 immediate host commands.
Stable seam and real callers (bars 4–5): submission policy / sendComposerTurn / draftAfterSend / mergeMessageIntoDraft / planExternalSubmit → ChatComposer and draft restoration.
Visible failure family (bar 2): accidental send, invalid attachment, lost draft, wrong image identity, partial plan sent or host Pause stuck behind queued work.
Lowest owner / remaining stronger coverage (bar 6): These are the lowest send policy and merge owners. Lower API constants do not implement GUI actions; store owns transport retries and routing. Duplicate wrapper probes are removed..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `Enter sends on desktop and Shift+Enter is a newline` (baseline line 36) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `mobile never sends on Enter, whatever else is held` (baseline line 41) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `mod+Enter during a running turn is the per-message inversion` (baseline line 57) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the mod-enter shortcut requires the modifier and makes a bare Enter a newline` (baseline line 66) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `mod-enter-multiline only demands the modifier once the draft has a newline` (baseline line 77) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `steer vs queue is the preference XOR the per-message inversion` (baseline line 89) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `nothing queues when no turn is running` (baseline line 109) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the prompt limit accepts 120000 characters and refuses the next` (baseline line 120) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an answer to a pending question is exempt from the turn input bound` (baseline line 125) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a paste at or over 32 KiB becomes an attachment` (baseline line 134) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the byte length folds a paste the character count would let through` (baseline line 143) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a smaller paste still folds when it would blow the input limit` (baseline line 150) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the escape hatch and a composer that cannot attach both keep the paste inline` (baseline line 157) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the paste-as-text chord is platform-specific` (baseline line 166) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the attachment budget counts staged and in-flight together` (baseline line 176) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an unsupported image type and an oversized file are both refused` (baseline line 182) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an unfinished or failed upload blocks send` (baseline line 214) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a draft with only whitespace has nothing to send` (baseline line 220) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an empty draft implements the plan and leaves plan mode` (baseline line 226) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `text in the draft refines the plan and STAYS in plan mode` (baseline line 236) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a ref that arrives under a different key is still matched by its id` (baseline line 250) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `an in-flight upload occupies a slot against a staged ref too` (baseline line 261) — Duplicate count policy exercised by the retained staged-plus-preparing budget and returning-ref cap cases; only replays it through the wrapper.
- **KEEP** `a ref with no declared mimeType is measured as a file, never guessed into an image` (baseline line 275) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `a ref with no declared size is staged as zero rather than refused` (baseline line 286) — Pins an internal default field (zero) rather than attachment acceptance contract; unknown metadata acceptance remains in the missing MIME case.
- **KEEP** `a file coming back is never refused for the count, and every other bound still applies` (baseline line 295) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the status line works the count out from the draft, so it follows every chip removed and goes once the draft fits` (baseline line 322) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a draft over eight attachments cannot be sent` (baseline line 330) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `Q2-5: Enter during an IME composition is not a send` (baseline line 348) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `Q2-5: the keyCode 229 fallback is honoured for engines without isComposing` (baseline line 361) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `Q2-5: a composition beats every other send path, including mod+Enter steering` (baseline line 373) — Repeats the composing guard with another flag combination. Dedicated IME and legacy keyCode fallback regressions retain both actual failure mechanisms.
- **KEEP** `R7-3: an empty draft with an actionable plan is NOT a no-op submit` (baseline line 386) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-3: /plan is swallowed only where the toggle is shown` (baseline line 395) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-3: /default follows the same gate, and an attachment defeats both` (baseline line 402) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-3: only a STANDALONE command is swallowed` (baseline line 413) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `goals §8.2: a chip action is refused for exactly what refuses the composer's own send` (baseline line 436) — Read the real planExternalSend result used by ChatComposer instead of its test-only refusal helper export. Refusal/success oracles remain independently specified command gates.
- **KEEP** `fix round 1 (7): a typed host /goal is never queued — the host applies it at once` (baseline line 449) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **REWRITE** `final wave (4): an open card never holds back a goal command the HOST applies` (baseline line 479) — Read the real planExternalSend result used by ChatComposer instead of its test-only refusal helper export. Refusal/success oracles remain independently specified command gates.
- **REWRITE** `final wave (4): everything else still waits for the card` (baseline line 488) — Read the real planExternalSend result used by ChatComposer instead of its test-only refusal helper export. Refusal/success oracles remain independently specified command gates.
- **KEEP** `Implement on a plan that cannot be read back sends nothing, and says why` (baseline line 515) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft` (baseline line 535) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a plan read back whole is what gets sent, not the cut one` (baseline line 549) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a plain send goes out as typed, and one the host refuses goes back to the draft as typed` (baseline line 558) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a failed Implement leaves the draft alone: its prompt is the composer's, not the user's` (baseline line 573) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `send ownership marks only generated prompts to stay out of the draft after reload` (baseline line 587) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `every Implement reads its plan at send time, intact or cut, and no other send does` (baseline line 603) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `what was typed or staged while it was in flight stays, behind it, and no chip is doubled` (baseline line 660) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an image staged meanwhile keeps its own [Image #N] once the sent images are back ahead of it` (baseline line 693) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a send that went out, a refusal and a failed Implement all leave the draft as it is` (baseline line 735) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a message returned behind the draft keeps naming its own images, never the draft's` (baseline line 756) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a returned message joins the draft's text with one blank line, and no blank lines when either side is empty` (baseline line 788) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a failed send comes back ahead of the draft exactly as it was sent, the draft's own images renumbered behind it` (baseline line 817) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `goals §8.2: a failed goal chip action says why and writes nothing back into any draft` (baseline line 840) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `the rail's Send: an idle thread sends the trimmed text` (baseline line 869) — Trivial forwarding/trim replay; distinct trimmed-length boundary and double-click queue behavior remain.
- **KEEP** `the rail's Send measures the TRIMMED text against the length bound, as Enter does` (baseline line 873) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the rail's Send: a double click's twin is not queued twice` (baseline line 878) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/composer-trigger.test.ts

Independent source (bar 1): GUI §4.6.7 slash/currency/path trigger grammar and §7.4 caret insertion.
Stable seam and real callers (bars 4–5): detectComposerTrigger / replaceTextRange + trailing-space extension → ChatComposer.
Visible failure family (bar 2): menu opens inside a path/email or replacement corrupts adjacent prompt text/caret.
Lowest owner / remaining stronger coverage (bar 6): Lowest text/caret parser; actual menu construction owns available items, not token boundaries..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `slash opens the command menu only at the start of a line` (baseline line 10) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a slash trigger dies as soon as the token contains whitespace` (baseline line 28) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the bare slash itself is a trigger with an empty query` (baseline line 32) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `any currency symbol starts a skill token, not just $` (baseline line 41) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `@ starts a path token on the current whitespace-delimited word` (baseline line 56) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a caret before the trigger character sees no trigger` (baseline line 65) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `replaceTextRange splices and reports the caret after the replacement` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/skill-mentions.test.ts

Independent source (bar 1): GUI §4.6.7–8 known skills re-chip from stored text; unknown tokens stay literal.
Stable seam and real callers (bars 4–5): skillMentionsInText → row-chrome splitSkillMentions.
Visible failure family (bar 2): wrong token converted to a skill or valid skill left literal.
Lowest owner / remaining stronger coverage (bar 6): Lowest mention-recognition seam shared by timeline; row-chrome only tests byte preservation and does not repeat recognition cases..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `R2-8: known $skill mentions are found in order, deduped` (baseline line 14) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-8: an UNKNOWN mention stays literal — it is not a chip` (baseline line 21) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-8: a mention must start a token, so an email or a path is not one` (baseline line 26) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-8: matching is case-insensitive but the text's own spelling is returned` (baseline line 32) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-8: any currency symbol opens a mention, as the composer trigger does` (baseline line 36) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `R2-8: dots and dashes are part of a skill name` (baseline line 40) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `R2-8: no known skills means no chips, and empty text never throws` (baseline line 44) — Empty-list/empty-string probes add no distinct contract beyond unknown mentions remaining literal.

## packages/ui/src/components/agent-chat/composer/tab-visibility.test.ts

Independent source (bar 1): GUI §7.4 Escape precedence, IME/menu/layer ownership, hidden mounted tabs.
Stable seam and real callers (bars 4–5): composerOwnsEscape / composerEscapeAction → ChatComposer.
Visible failure family (bar 2): Escape closes a menu and also interrupts, leaves a child incorrectly or repeats into rewind.
Lowest owner / remaining stronger coverage (bar 6): Separate textarea and window arms have distinct event ownership; shell resolver handles outside-composer events. Geometry mock tests are deleted..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `the visible, active tab acts` (baseline line 15) — Mocks getClientRects and asserts its arranged geometry. A behavior-preserving visibility implementation can use another DOM seam; keyboard gating remains at action resolvers.
- **DELETE** `an explicitly inactive tab never acts, even while it still has a box` (baseline line 20) — Private visibility helper duplicates active-tab keyboard policy covered by pending-answer and escape-action.
- **DELETE** `a hidden subtree never acts, even when the caller forgot to pass `active`` (baseline line 26) — Mocks zero rectangle count; does not render a hidden tab or prove no action. Action resolver active-tab coverage remains.
- **DELETE** `an unmounted listener owner never acts` (baseline line 33) — Null-input defensive helper probe adds no distinct visible keyboard behavior.
- **KEEP** `while a layer is up, the composer yields Escape` (baseline line 42) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `with a subagent view open, the composer claims Escape even while idle` (baseline line 47) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the composer claims running-turn Escape only inside its shell` (baseline line 52) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the textarea keeps Escape to itself — the token menu gets first refusal` (baseline line 57) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `whoever ran first can stand the other down via defaultPrevented` (baseline line 71) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `Escape with no turn running never interrupts from the composer` (baseline line 75) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the token menu takes the textarea's Escape before anything else` (baseline line 91) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an open layer takes the textarea's Escape: no interrupt, and no half of Esc Esc` (baseline line 100) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `with a subagent's view open, the textarea's Escape leaves it — never an interrupt` (baseline line 112) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `with a subagent's view open, a menu or a layer still takes its Escape first` (baseline line 124) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `with nothing open, Escape stops a running turn, and an idle one is half of Esc Esc` (baseline line 136) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a held Escape is one press: its auto-repeat does nothing, whatever is open` (baseline line 141) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/composer/workspace-skills.test.ts

Independent source (bar 1): GUI §4.6.4/7 cwd catalog overlay; API ProviderSnapshot workspaceSnapshots.
Stable seam and real callers (bars 4–5): workspaceSkills → ChatComposer and timelineSkillNames → AgentChatView.
Visible failure family (bar 2): composer/timeline offer or chip skills from the wrong project or crash without snapshot.
Lowest owner / remaining stronger coverage (bar 6): Lowest common catalog selector; recognition tests consume a supplied catalog and cannot catch cwd selection..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `the cwd's overlay wins where it lists any skill` (baseline line 25) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an empty overlay, another cwd, or none: the machine-level catalogue` (baseline line 29) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `no snapshot, no skills` (baseline line 35) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/drill-in-navigation.test.ts

Independent source (bar 1): GUI §7.6 return only when followed live agent settles; search reveal targets main timeline.
Stable seam and real callers (bars 4–5): nextDrillInReturn / revealClosesDrillIn → AgentChatView.
Visible failure family (bar 2): reader is yanked out of a finished/scrollback child or search result remains hidden.
Lowest owner / remaining stronger coverage (bar 6): State-machine action results across ordered observations, not state object identity; no render duplicate covers navigation transitions..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `an agent seen at work that settles while the reader follows its end hands the view back` (baseline line 29) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `opening a finished agent from a running agent's view stays open (was one flag for the whole view)` (baseline line 42) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a reader who scrolled up stays when it settles — and is not yanked later on reaching the end` (baseline line 53) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `idle is not at work: an idle agent that settles returns nothing` (baseline line 64) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an agent the roster dropped, then back, starts over` (baseline line 68) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `A → B → A: each agent is watched from its own opening` (baseline line 79) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a NEW reveal closes an open drill-in, so the thread's timeline takes it at once` (baseline line 93) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open` (baseline line 98) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/escape-action.test.ts

Independent source (bar 1): GUI §7.4 Escape and double-Escape precedence; §7.1 mounted hidden tabs.
Stable seam and real callers (bars 4–5): resolveChatEscape / chatEscapeSequenceStep → AgentChatView.
Visible failure family (bar 2): wrong thread interrupted, modal steals action, repeated hold interrupts parent, or unrelated key counts as rewind.
Lowest owner / remaining stronger coverage (bar 6): Outside-composer event decision owner; composer tests cover its own separate arm. Literal actions are user operations rather than collaborator invocation shapes..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `the drill-in wins over the interrupt` (baseline line 24) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `Escape interrupts a running turn from anywhere in the tab` (baseline line 34) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a hidden tab never acts, whatever it is doing` (baseline line 38) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a blocking layer keeps the key: Escape closes the modal, not the thread` (baseline line 51) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `focus inside the composer belongs to the composer's own arm, not this one` (baseline line 58) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an event another listener already handled is not handled twice` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a held Escape is one press: its auto-repeat never stops the turn the first press spared` (baseline line 76) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `only Escape` (baseline line 89) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a second idle Escape opens the rewind picker` (baseline line 101) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the first idle Escape does nothing — it is only half of the gesture` (baseline line 105) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `no message to go back to, no picker` (baseline line 109) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the double press never outranks leaving a drill-in or stopping a turn` (baseline line 113) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the rewind obeys every gate the other two do` (baseline line 125) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `only an idle Escape is pressed into the double-press sequence` (baseline line 142) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an Escape that did something else starts the count over` (baseline line 146) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `any other key between two Escapes breaks the sequence` (baseline line 158) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `holding Escape is one press, and its auto-repeat breaks nothing either` (baseline line 163) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an Escape typed into a field outside this chat is that field's: nothing here, and Esc Esc starts over` (baseline line 169) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/primitives/elapsed.test.ts

Independent source (bar 1): GUI §7.6 provider timestamps may be absent; credible malformed-frame resilience.
Stable seam and real callers (bars 4–5): elapsedBetween → ElapsedTicker.
Visible failure family (bar 2): NaN duration appears in transcript/status.
Lowest owner / remaining stronger coverage (bar 6): Only malformed-input resilience survives. Cosmetic duration strings are deleted..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `elapsedBetween accepts ISO stamps and epoch millis alike` (baseline line 5) — Pins cosmetic duration spelling (1m 04s/42s), not a specified protocol. Invalid timestamp resilience remains covered.
- **DELETE** `elapsedBetween measures against `now` when there is no end stamp` (baseline line 11) — Pins cosmetic live timer text 30s. No independently required byte format; invalid timestamp resilience remains covered.
- **KEEP** `elapsedBetween returns empty for missing or unparseable stamps` (baseline line 17) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/roster/background-shell.test.ts

Independent source (bar 1): GUI §7.6 background shell output and Grok task lifecycle; shared API task/tool events.
Stable seam and real callers (bars 4–5): projectBackgroundShell → AgentDrillIn.
Visible failure family (bar 2): stream closes its disclosure, drops cached output, loses shell title, or shows command text as output before printing.
Lowest owner / remaining stronger coverage (bar 6): Owns shell-specific lifecycle normalization/cache invalidation. Generic concatenation test removed; row-chrome owns joining and seeded render checks actual output visibility..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `streamed output chunks become the row's output, in arrival order` (baseline line 90) — Repeats generic chunk concatenation through projection plus two other owners. row-chrome owns byte joining; seeded drill-in render and cached-shell update retain shell integration.
- **KEEP** `the row keeps the first frame's id, so a streaming row cannot close itself` (baseline line 95) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `with no lifecycle frame left, the shell is titled from its roster row, its whole output joined` (baseline line 100) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a Grok shell folds its task lifecycle into the command's output and status` (baseline line 115) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a running Grok shell has no output until it prints` (baseline line 126) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a Grok monitor's latest line is its output` (baseline line 132) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a chunk of the shell's own updates the cached output` (baseline line 140) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/roster/drill-in-memory.test.ts

Independent source (bar 1): GUI §7.6/S12 per-agent reading memory and remembered roster metadata; bounded cache.
Stable seam and real callers (bars 4–5): rememberDrillIn / recallDrillIn / drillInOpening → AgentChatView/AgentDrillIn.
Visible failure family (bar 2): reopening one agent restores another agent or follow overrides a saved reading position.
Lowest owner / remaining stronger coverage (bar 6): Only per-agent memory owner, separate from thread timeline LRU and navigation transitions; assertions use stored row IDs and disclosure data, not measured geometry..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `an agent never opened opens as today: at its end, following, nothing open` (baseline line 34) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `re-opening an agent restores its disclosures and a mid-list position, with follow OFF` (baseline line 42) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a reader who re-armed follow (the pill, mod+J) comes back to the end, whatever position was published before` (baseline line 51) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an entry keeps the last roster row seen, so a reopened agent the roster evicted keeps its title and kind` (baseline line 61) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `A → B saves A's and restores B's, and each keeps its own` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `keeps the 50 most recent agents: the least recently remembered goes first` (baseline line 77) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/roster/drill-in-render.check.ts

Stable seam/non-test callers: actual React components used by AgentChatView. Fixed provider data and accessible state are independent oracles; these checks survive layout/class refactors and own wiring that pure policy tests cannot prove. No fake implementation renders the expected behavior. Risk: low; run the check with package hooks.

- **KEEP** `seeded background shell shows command and streamed output` — GUI §7.6 credible regression: second timeline projection hid a shell behind closed turn folds. Real store snapshot → AgentDrillIn → ChatTimeline must expose pnpm test --watch and PASS src/a.test.ts without an extra click.

## packages/ui/src/components/agent-chat/roster/roster-summary.test.ts

Independent source (bar 1): GUI §7.6 agents/shells and goals design independent background drivers.
Stable seam and real callers (bars 4–5): rosterKindCounts / partitionRosterRows → ChatRosterDock.
Visible failure family (bar 2): shell totals include goal/loop drivers or drivers are routed to shell-only view.
Lowest owner / remaining stronger coverage (bar 6): Actual domain counts and kind classification, not rendered row counts; positional layout snapshot removed..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `counts agents and shells apart, live ones included` (baseline line 13) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `counts a loop and a goal as neither an agent nor a shell` (baseline line 25) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `keeps each kind's order while splitting them` (baseline line 37) — Presentation partition/order snapshot; retained loop/goal classification case covers the meaningful distinction between agent and shell rendering.
- **KEEP** `renders a loop and a goal with the agents, never as shells` (baseline line 49) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/status/goal-chip.test.ts

Independent source (bar 1): goals design §4.5 capabilities and §8.2 exact action matrix/command bytes.
Stable seam and real callers (bars 4–5): goalActions → GoalChip.
Visible failure family (bar 2): user offered an invalid goal action, Pause unavailable while active, or wrong command sent.
Lowest owner / remaining stronger coverage (bar 6): Lowest availability/command-construction owner; API goal tests parse commands and runtime statuses but do not decide GUI capabilities..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** ``the action matrix — ${adapter} × every status × running/idle × background liveness`` (baseline line 105) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `no goal, a finished goal, or no goal support ⇒ no actions` (baseline line 123) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `only the actions an adapter honours are ever offered` (baseline line 133) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `each action sends exactly the §8.2 text, as the user's message` (baseline line 145) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/status/status-line.test.ts

Independent source (bar 1): GUI §7.6 meter reports known context size, never invented percentage.
Stable seam and real callers (bars 4–5): deriveContextMeter → ContextWindowMeter.
Visible failure family (bar 2): fabricated zero/percentage, negative remaining context, or invalid provider numbers displayed.
Lowest owner / remaining stronger coverage (bar 6): Lowest arithmetic/data-availability seam; no renderer duplicate. Pass-through auto-compaction field probe removed..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `the meter reports a percentage only when a context window is reported` (baseline line 9) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `without maxTokens there is no ring and no percentage — never a zero` (baseline line 23) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an adapter that does not report a context window degrades even if a max leaks through` (baseline line 38) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `usage past the window clamps at 100% and never reports negative remaining` (baseline line 52) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `no usage frame yet means no meter at all, not a zeroed one` (baseline line 65) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `zero and non-finite extras are dropped rather than shown` (baseline line 88) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `the meter carries the auto-compaction verdict through to its model` (baseline line 102) — Pass-through flag shape with no displayed action or independent transformation. It is a private model plumbing change detector.

## packages/ui/src/components/agent-chat/thread-switch.test.ts

Independent source (bar 1): GUI §7.1 thread switch retains prior paint inert until destination arrives.
Stable seam and real callers (bars 4–5): resolveThreadSwitchTimeline → AgentChatView.
Visible failure family (bar 2): user interacts with previous thread under a new identity or empty thread shows someone else's rows.
Lowest owner / remaining stronger coverage (bar 6): Public render decision owner; private held-cache shape test removed..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `rows for the named thread always win` (baseline line 8) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a reconnect on the same thread repaints its own rows, still interactive` (baseline line 18) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `switching to a thread with no snapshot holds the previous one, inert` (baseline line 23) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a settled empty thread renders empty rather than someone else's rows` (baseline line 30) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **DELETE** `only a settled non-empty paint is remembered` (baseline line 35) — Private cache bookkeeping snapshot; retained public resolution tests cover cross-thread inertness and settled empty state.

## packages/ui/src/components/agent-chat/timeline/diff-tree.test.ts

Independent source (bar 1): GUI §7.3 changed-file totals; Git unified-diff format and API CheckpointFile.
Stable seam and real callers (bars 4–5): buildDiffTree / summarizeDiffStats / splitUnifiedDiff / countDiffLines → ChangedFilesCard and diff viewer.
Visible failure family (bar 2): wrong changed-file path/stat, lost deletion/binary patch, cross-file output bleed or truncated diff crash.
Lowest owner / remaining stronger coverage (bar 6): Owns multi-file splitting and totals; git renderer parses already split patches and cannot catch cross-file routing..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `buildDiffTree rolls stats up through every ancestor` (baseline line 28) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `summarizeDiffStats totals changed lines` (baseline line 35) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `splitUnifiedDiff yields one entry per file with its own patch text` (baseline line 43) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a deletion keeps the old path when the new one is /dev/null` (baseline line 51) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a binary file is flagged rather than dropped` (baseline line 58) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a bare patch with no `diff --git` preamble is still one file` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a quoted path with spaces is unquoted` (baseline line 76) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an empty or whitespace diff is no files, not a throw` (baseline line 88) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a truncated patch still yields the file it started` (baseline line 93) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `countDiffLines ignores the file headers` (baseline line 100) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/follow.test.ts

Independent source (bar 1): GUI §7.3 explicit prefers-reduced-motion rule.
Stable seam and real callers (bars 4–5): shouldAnimateFollow → ChatTimeline.
Visible failure family (bar 2): streaming scroll animates despite accessibility preference.
Lowest owner / remaining stronger coverage (bar 6): Accessibility policy, not measured layout; unique reduced-motion decision owner..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `snaps when the user prefers reduced motion, even mid-turn` (baseline line 5) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.test.ts

Independent source (bar 1): GUI §7.3 source-preserving highlighting, 120000-char unhighlighted cap; parser failure fallback.
Stable seam and real callers (bars 4–5): highlightCode / createIncrementalTreeHighlighter → MarkdownCodeBlock.
Visible failure family (bar 2): code loses newlines/text, grammar exception kills message, or oversized input unnecessarily parsed.
Lowest owner / remaining stronger coverage (bar 6): Fixed source bytes/real grammar and explicit failing grammar dependency; no token style snapshots or private parser argument shapes..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `highlighting preserves source bytes across styled, empty and trailing lines` (baseline line 11) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an oversized block preserves the source without running the grammar` (baseline line 19) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a grammar failure preserves the source instead of killing the row` (baseline line 28) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `an unknown grammar preserves the source` (baseline line 34) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/markdown/incremental.test.ts

Independent source (bar 1): Markdown reference semantics and GUI §7.3 streamed text preservation.
Stable seam and real callers (bars 4–5): createIncrementalMarkdownPlugin through real ReactMarkdown/remarkGfm rendering → ChatMarkdown.
Visible failure family (bar 2): reference URL fails across cache boundary or CRLF/BOM source text is corrupted.
Lowest owner / remaining stronger coverage (bar 6): Public plugin seam through real parser; links and literal text are independent output oracles, not snapshots or fake ASTs..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `a reference in the prefix resolves when its definition arrives later` (baseline line 19) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a streamed reference resolves a definition before the cached fence` (baseline line 28) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a streamed CR becoming CRLF preserves text and one line break` (baseline line 37) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a BOM inside streamed text remains an interior character` (baseline line 46) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/plan-reader.test.ts

Independent source (bar 1): GUI §5.6 and §7.3 copy/download never return truncated plan as complete.
Stable seam and real callers (bars 4–5): readPlanWithoutStore → ChatTimeline context fallback.
Visible failure family (bar 2): partial plan copied/downloaded when its store is absent.
Lowest owner / remaining stronger coverage (bar 6): Fallback has no store path to read complete bytes; store tests cover a distinct available-store path. Trivial intact echo removed..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `with no thread store, an intact plan is still its own markdown` (baseline line 5) — Pass-through returns the supplied field unchanged. Truncated-plan refusal is the distinct data-loss regression and remains.
- **KEEP** `with no thread store, a truncated plan rejects rather than returning partial markdown` (baseline line 12) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/row-chrome.test.ts

Independent source (bar 1): GUI §4.6.5/7 compact marker and lossless skill text; §5.6 tool correlation and output preservation.
Stable seam and real callers (bars 4–5): isCompactCommandMessage / splitSkillMentions / joinLifecycleDetails → MessageRow/WorkRow.
Visible failure family (bar 2): unrelated text hidden as command, source bytes lost, wrong call details borrowed or incomplete command output cannot be loaded.
Lowest owner / remaining stronger coverage (bar 6): Owns row joins after projection, distinct from raw-event conversion and approval-card raw join. Expectations are literal bytes/IDs; no memo identity/style snapshots..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **KEEP** `a `/compact` user message is recognised at render time` (baseline line 19) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `only a bare `/compact` from the user, with no attachments, is the command` (baseline line 26) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the concatenated runs always reproduce the input exactly` (baseline line 36) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `a fileChange approval with no diff borrows it from its own item.started` (baseline line 47) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `several orphan chunks of one call join into ONE row: the first carries all their text, nothing lost` (baseline line 69) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the row a command's streamed output joins onto says the call streamed, however its rows were built` (baseline line 91) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the join never overwrites a value the row already has` (baseline line 117) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.
- **KEEP** `the join is keyed on toolCallId only — never on a label match` (baseline line 126) — Retains this distinct named contract and its fixed oracle at the stable seam above; violation causes the described visible failure, without prescribing implementation.

## packages/ui/src/components/agent-chat/timeline/row-format.test.ts

Independent source (bar 1): GUI §7.3 diff display.
Stable seam and real callers (bars 4–5): looksLikeUnifiedDiff → RowText.
Visible failure family (bar 2): appearance selector only.
Lowest owner / remaining stronger coverage (bar 6): No retained case; parsing contract remains in diff-tree.test.ts..
Oracle (bar 3): the exact named variant below is checked against fixed expected data/action, independently of the owner; see the literal assertions at the original source line.

- **DELETE** `looksLikeUnifiedDiff recognises a patch and rejects ordinary output` (baseline line 5) — Only chooses diff appearance; parsing paths, file boundaries and patch bytes are protected by unified-diff contracts in diff-tree.test.ts.

## Production/support cleanup planned before edits

- Privatize single-question answer resolution/count helpers; answer tests enter through the real submitted-map builder.
- Privatize menu filtering/ranking helpers and drop unused barrel exports; menu tests enter through real builders. Internal helpers remain because production uses them.
- Privatize refusal and attachment-key helpers plus internal constants, including the outbox storage key and both ten-minute limits; remove re-export of API plan-prompt builder. The store-test owner replaces imported outbox constants with independent protocol literals. No runtime behavior changes.
- Remove unused test imports/fixtures left by deleted cases. No snapshots or external fixture files are owned by deleted cases. Shared isolated-page support remains required for reload/storage tests.

## Completion and validation

Planned case/scenario totals: {'KEEP': 263, 'DELETE': 22, 'REWRITE': 18}.
Completed: all 22 DELETE declarations are absent; all 269 retained original declarations remain. Eighteen cases now observe a production-consumed seam instead of an export for private helpers. Focused suite: 271/271 passed (the parameterized goal matrix expands three cases); all three render checks passed. Baseline ran through 72 passing declarations before the host interruption and was not restarted. UI typecheck reported only concurrent errors in other scopes (default-agent, hooks.logic and chain-models tests), communicated to their owners; no scope-4 diagnostics. Root owns the final integrated typecheck/test/build gates. Scoped git diff --check passed.

## Incoming remote commit 9871b50f (recorded before integration)

The root agent owns merging this remote change. This section covers every newly added case in the three assigned roster test files. Independent behavior evidence is the commit's documented workflow regression: Claude runs one coordinator task with member agents; the coordinator is a container once members exist, members cannot be stopped individually, retries carry an attempt, and coordinator-only runs remain represented. The API roster tests independently retain member metadata, phase grouping, retries and coordinator-only liveness. The incoming `taskStopControl` tests in `lib/agent-chat/roster.logic.test.ts` own provider capability, membership and in-flight Stop gating.

Before retaining isolated count tests, the relevant real failure modes are: count a coordinator twice once members exist; omit the coordinator before any member exists; include its aggregate usage again over member usage; exclude failed members from settled totals; or invent settled members before any arrive. Literal domain counts catch these failures; visual text and markup counts do not add a separate contract.

### packages/ui/src/components/agent-chat/roster/format.test.ts

- **DELETE** `shows its label, its phase, model, tokens and tools` — Exact metric string array, token abbreviation and decorative tool prefix pin presentation. Member metadata is protected at the API fold; the UI test's title assertion merely retests it. Real callers of the formatting functions are AgentRosterRow, AgentDrillIn and WorkflowGroup, so functions remain.
- **DELETE** `marks a retry by its attempt, once` — Retry/reopening is already owned by API roster regressions. This extra layer asserts the spelling/order of `attempt 2` beside unrelated metric copy.
- **DELETE** `keeps a direct agent's reactivation as its run count` — API activation-count regressions own reactivation. The extra array `— tok`, `run 2` and null chip is presentation only.

### packages/ui/src/components/agent-chat/roster/workflow-group-render.test.ts

- **DELETE** `counts the members settled and lists them by phase, the name opening the coordinator` — Row/markup inventory and exact counter copy. It asserts `data-agent-id` and does not open the coordinator; API grouping and retained numeric summary tests own its real data contract.
- **DELETE** `renders the coordinator's own row, and no settled counter, before any member` — Exact aria sentence and absence of the word `settled` can fail on harmless copy changes; the coordinator-only API and numeric summary cases own the actual boundary.
- **DELETE** `offers none unless asked to` — Supplies the private presentation flag directly and checks a test-only attribute. It does not exercise capability or task eligibility; `taskStopControl` owns those gates.
- **DELETE** `offers one Stop for the run — none per member — and disables it while stopping` — Button inventory, exact title/copy and attribute-order regex around a supplied presentation flag. No Stop is invoked and no task identity/dispatch is observed. API task-stop refusal and the UI `taskStopControl` contract retain the actual run/member eligibility and stopping state; avoid a replacement rendering implementation test.

Dead support: remove the two newly added test-only attributes in WorkflowGroup (`data-task-stop`, coordinator header `data-agent-id`) and its unconsumed `WorkflowStop` export. After integration, a repository-wide caller search also found `WorkflowGroupProps` only in its declaration and internal barrel, after deleting its sole incoming test consumer. Privatize that type and remove its barrel export; it is not exported by the UI package's public entry point. Keep the component, handlers and internal types. Shared Claude workflow fixtures remain used by actual API/store/logic regressions.

### packages/ui/src/components/agent-chat/roster/roster-summary.test.ts

Shared six-bar rationale for all four cases: (1) documented coordinator/container and usage double-counting regression in 9871b50f plus the API RuntimeSubagent/AgentPanelWorkflowGroup contract; (2) wrong displayed running-agent totals or token usage is caller-visible; (3) literal expected domain totals 3/2/1/2000 or 0/0/0/300 are independent of implementation; (4) rosterKindCounts and workflowGroupSummary are consumed directly by ChatRosterDock/WorkflowGroup; (5) assertions concern numeric data, not wording, style, order of DOM rows or private calls; (6) these functions compute the actual UI totals, distinct from API grouping, and tests no longer assert the API's totals at this extra layer. Risk is low: production algorithms remain unchanged. Validation is the focused roster-summary test after merge with package hooks.

Final seam review: repository-wide reference search found the incoming `WorkflowGroupSummary` interface only at its declaration and the same module's function return annotation. Its unused export is removed while preserving the internal type and the production-consumed `workflowGroupSummary` function. Risk is limited to type visibility; UI typecheck passed again after this cleanup.

- **REWRITE** `counts the members as agents and the coordinator with members as none` — Provide domain records directly to rosterKindCounts and assert three live agents. Remove workingLivenessTitle copy, API-model equality against another production result, and duplicated API token aggregation assertions.
- **REWRITE** `counts a coordinator with no members yet as the one agent it stands for` — Provide the lone coordinator domain record directly and retain agents=1/liveAgents=1, avoiding a full fold replay for a UI count decision.
- **KEEP** `summarises the group's header from its members` — Fixed summary `{agents:3, settled:2, failed:1, totalTokens:2000}` catches counting the coordinator again or forgetting failed members among settled work; this remains the lowest UI summary owner.
- **REWRITE** `has no members to settle before the first is reported, and the coordinator's tokens` — Remove the repeated workflow-id assertion; retain `{agents:0, settled:0, failed:0, totalTokens:300}`, which catches an invented member or lost pre-member usage.

Incoming totals: 7 DELETE, 3 REWRITE, 1 KEEP. The root merged the remote changes; this agent applied the prepared cleanup patch in the shared worktree. Both new presentation-only test files are deleted, the three summary rewrites are complete, and the numeric member summary remains unchanged. Removed the two test-only attributes and the unused WorkflowStop and WorkflowGroupProps exports, including the latter's barrel export. The shared Claude workflow fixtures still have real retained test consumers. No production behavior changed.

Full-file merge review: `git show 9871b50f -- packages/ui/src/components/agent-chat/roster/roster-summary.test.ts` adds imports and the four workflow cases but changes no preexisting test body or assertion. The merged file preserves the earlier DELETE of `keeps each kind's order while splitting them`. The three existing KEEP cases retain their original independent oracles: `counts agents and shells apart, live ones included` checks four agents/two shells and two live agents/one live shell; `counts a loop and a goal as neither an agent nor a shell` checks distinct driver counts without contaminating agent/shell counts; `renders a loop and a goal with the agents, never as shells` checks classification of literal IDs l1/g1 versus s1. These remain at the production-consumed numeric/classification seams documented above; no remote inline assertion expanded their scope or duplicated workflow coverage.

Integrated validation: 19/19 tests passed across roster-summary, background-shell and drill-in-memory; drill-in-render.check.ts passed; `pnpm --filter @orquester/ui typecheck` passed after the final type-export cleanup; scoped `git diff --check` passed. Logs are `/tmp/orquester-test-audit/scope-4-incoming-{focused,check,typecheck}.log`. Root owns the final repository gates and commit/push.
