# Composer test cleanup — pre-edit disposition and completed validation

Scope: every original `*.test.ts` and `*.check.ts` under `packages/ui/src/components/agent-chat/composer`. Inventory recorded before edits. Production owners, caller searches, README.md, AGENTS.md, package scripts, the GUI design and goals design were read. This is an implemented cleanup, not only an audit.

Original inventory: 20 DELETE, 24 REWRITE, 140 KEEP; 184 original scenarios total (183 node tests and one standalone render scenario).
Independent sources: [GUI design](../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [goals design](../superpowers/specs/2026-09-24-agent-goals-design.md), [attachment path plan](../superpowers/plans/2026-09-22-chat-attachment-paths-and-chips.md), and root AGENTS.md. The source section on each file identifies the contract; production comments alone were not treated as requirements.

Validation command for every row: from `packages/ui`, `pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/components/agent-chat/composer/*.test.ts`. The render check uses the same preload arguments without `--test`. Root owns the final repository gates.

For isolated policy tests, the listed failure class and each named case below are the ways the unit can fail. KEEP/REWRITE requires the six-part justification in its file section plus its case row; a title is retained verbatim so every original test is traceable. Expected outputs are literals or deliberately supplied caller data, not recomputations of the production result. Test doubles record transport/storage actions; they do not implement the asserted selection, parsing, ordering, or merge behavior.

## `packages/ui/src/components/agent-chat/composer/composer-bridge.test.ts`

1. **Independent contract:** GUI §7.4; stale effect-cleanup regression.
2. **Visible failure:** an old tab cleanup dropping the new composer handle and losing inserted user text; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** registerComposerHandle / insertComposerText; production ChatComposer registration and browser/rail/session-upload callers.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

## `packages/ui/src/components/agent-chat/composer/composer-draft.test.ts`

1. **Independent contract:** GUI §7.4 durable draft, returned-file, and bounded-write requirements; AGENTS.md persistence rules.
2. **Visible failure:** lost text/files/context after reload, duplicated image placeholders, sent text resurrected by a late write; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** draft translation/merge functions and createDraftPersistScheduler; production ChatComposer, store draft-return paths.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| into a full tray: every returned file is staged, and the draft is held at the send gate | DELETE | Duplicate full-tray preservation at an extra layer; cases 3 and 6 cover restored refs, persisted merge and subsequent load; store.test.ts separately owns bridge routing. |

## `packages/ui/src/components/agent-chat/composer/composer-failed-send.test.ts`

1. **Independent contract:** GUI §7.4 failed-send destination and mounted-draft ownership regressions.
2. **Visible failure:** failed text reaching another thread, hidden persistent writes losing a live draft, or rejected handoff dropping text; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** restoreFailedSendDraft; production ChatComposer send completion; actual draft storage and composer registry.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| over a persisted draft already holding eight: all sixteen are written, the next mount loads all sixteen, and the send is held | DELETE | Repeats attachment count/restore/load transformations already owned by composer-draft cases 3 and 6; other cases here own destination routing and persistence. |

## `packages/ui/src/components/agent-chat/composer/composer-files.test.ts`

1. **Independent contract:** GUI §7.4 attachment path requirement and 2026-09-22 attachment paths plan.
2. **Visible failure:** removing a chip leaving a sent path behind or deleting unrelated user text; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** removeFilePath; production ChatComposer removeAttachment.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| a path against punctuation still goes, and only the path: no space is owed there | DELETE | Pins the incidental punctuation spacing ("see , now"), rather than removal or data preservation; remaining literal-removal cases protect the actual contract. |

## `packages/ui/src/components/agent-chat/composer/composer-images.test.ts`

1. **Independent contract:** GUI §7.4 image-placeholder requirement and failed-send preview regression.
2. **Visible failure:** references naming the wrong image, removed image still named, or returned chip retaining a revoked URL; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** imageOrdinal/removeImagePlaceholder/withoutPreviews; production ChatComposer and draft merge.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| revokes every preview URL a chip set holds, and only those | DELETE | Only counts calls to a mocked URL.revokeObjectURL; does not demonstrate released resources or a usable preview. Real preview restoration remains covered by case 4. |

## `packages/ui/src/components/agent-chat/composer/composer-menu.test.ts`

1. **Independent contract:** GUI §§4.6.5–4.6.8; Goals §8.5.
2. **Visible failure:** offering an unusable command or skill, wrong match selected, wrong prompt syntax, or unintended goal send; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** menu construction/ranking/insertion/gating functions consumed by ChatComposer; blocked commands also consumed by submission.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| a skill that is also advertised as a command is listed once, as the skill | REWRITE | Remove duplicate direct providerCommandsForSlashMenu assertion; retain the complete menu result and skill winner. |
| /plan and /default appear only where the plan toggle is shown | REWRITE | Replace the entire host-command inventory with positive/negative membership for plan and default only. |
| /effort appears only when the selected model has a reasoning descriptor | REWRITE | Add the positive reasoning-capability case so an empty/broken menu cannot satisfy the negative test. |
| a leading slash in the query is stripped before ranking | DELETE | No independently specified query-with-extra-slash requirement; the real trigger already removes its slash. This pins search normalization. |
| R2-2: the host dedupe is by name, case- and whitespace-insensitively | DELETE | Repeats host-command deduplication through its internal helper and adds unspecified casing/whitespace normalization; case 14 protects the actual effort-command collision. |

## `packages/ui/src/components/agent-chat/composer/composer-model.test.ts`

1. **Independent contract:** GUI §§3.4, 4.1 model option descriptors, 4.6.5 effort, 7.4 model selection.
2. **Visible failure:** missing effort control, wrong selected model, stale unsupported option sent to provider, or invalid effort accepted; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** model/option selection functions; production ComposerChips and ChatComposer.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| the reasoning descriptor is found under any of the four adapters' ids | REWRITE | Exercise the three actual protocol reasoning IDs (effort, reasoningEffort, variant), removing the misleading four-adapter claim with only two IDs checked. |

## `packages/ui/src/components/agent-chat/composer/composer-outbox.test.ts`

1. **Independent contract:** GUI §7.4 outbox reload/queue order/ten-minute absence/100-entry retention; AGENTS.md tolerant persisted payloads.
2. **Visible failure:** lost or duplicate sends, cross-thread adoption, wrong queue order, automatic stale work, malformed persisted payload reaching state; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** record/adopt/read/write outbox API over sessionStorage; production thread store in store.ts.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| forgets an entry once it settles, for this page and the next | DELETE | Duplicate settled-message durability; store.reload.test.ts "leaves nothing for a reload once a send settled" observes the real send completion and next page. |
| gives a cold generation of this page the thread's queue, and a next page none of it until adopted | DELETE | Duplicate generation seeding/adoption; store.reload.test.ts "starts a generation that has nothing retained from the queue this page kept" plus its ordered reload queue case owns the real lifecycle. |
| never drops a send in flight to stay under the cap — only messages still waiting, oldest first | REWRITE | Use the independently documented 100-entry bound, not the exported implementation constant. |
| is fresh while the later of the queue's last showing and the message's queueing is within the bound | REWRITE | Use the independently documented ten-minute bound, not the implementation constant. |
| keeps every send in flight even past the cap: the bound only ever drops a waiting message | REWRITE | Use the documented 100-entry bound; retain the all-in-flight over-cap regression. |
| reads nothing out of a value that is not a v1 outbox | REWRITE | Feed raw persisted bytes through sessionStorage and real adoption instead of a test-only parser export. |
| keeps the entries it can read, and drops each one it cannot | REWRITE | Exercise mixed valid/malformed persisted entries through production storage/adoption; test each malformed entry separately so duplicate commandIds cannot mask failed validation. |
| drops a malformed optional field, never the message it belongs to | REWRITE | Exercise tolerant optional fields through the production storage/adoption seam. |
| keeps a model selection and a plan-mode turn it can read | REWRITE | Exercise serialized model/plan/generated-prompt payload through storage/adoption. |
| reads a held message's reason, and the last-shown stamps, field-wise | REWRITE | Exercise held reason and stamp fallback through storage/adoption. |
| keeps the first of two entries under one commandId | REWRITE | Exercise commandId deduplication through storage/adoption. |

## `packages/ui/src/components/agent-chat/composer/composer-sends.test.ts`

1. **Independent contract:** GUI §7.4 remount sending and cross-generation queue-serialization regressions.
2. **Visible failure:** one completion clearing a different send, cross-thread blocking, or a UI/store subscriber not observing new state; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** per-thread registry public begin/read/subscribe seam; useComposerSending and thread-store queue driver.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| a send in flight is seen by every reader of its thread, and by no other thread | DELETE | Single-send/thread isolation is subsumed by the overlapping-send and late-settle cases plus the component remount disabled-state check. |
| tells subscribers about every change, until they unsubscribe | REWRITE | Observe sending states seen by subscribers rather than counting private notifications. |
| tells its listeners which thread's queue moved, until they unsubscribe | REWRITE | Observe the identified thread and its queue state rather than counting notifications. |

## `packages/ui/src/components/agent-chat/composer/composer-submission.test.ts`

1. **Independent contract:** GUI §§4.1, 4.6.5, 7.4, 7.5, 7.8; Goals §§5.1, 8.2, 8.5; IME and failed-send regressions.
2. **Visible failure:** accidental send, invalid turn, dropped attachments, wrong plan mode, stuck goal pause, bad image references, or lost user text; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** submission/attachment/merge policy and send outcome functions consumed by ChatComposer and store draft restoration.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| an answer to a pending question is exempt from the turn input bound | REWRITE | Use literal 120010-character input from the independently specified turn bound. |
| folded pastes get stable, increasing names | DELETE | Exact pasted-text filenames have no independently specified naming requirement; pins a numbering implementation, not preservation of pasted content. |
| an empty draft implements the plan and leaves plan mode | REWRITE | Remove the expected-prefix assertion imported from the same implementation; retain action, mode and actual plan content. |
| re-delivering the same ref is a duplicate, not a second chip and not an error | DELETE | Identical ref-id duplicate scenario to case 23: the supposedly different first case also uses a different staged key. |
| staging counts against the same eight as a picked file | DELETE | Duplicate eighth-slot rejection already exercised by case 29 and the mixed ready/uploading case 25. |
| a declared image over the image bound is still refused | DELETE | Repeats size validation owned by attachmentRejectionReason case 17; returned-reference bound case 29 also observes staging rejection. |
| fix round 1 (5): a chip action the composer accepts clears its notice, as a submit does | DELETE | Successful notice clear and trimming are folded into retained case 43; refusal behavior stays in case 39 and case 44. |
| fix round 1 (7): which typed text the host takes as its /goal (goals §5.1) | DELETE | Replays shared isGoalCommandText grammar through a boolean wrapper. packages/api/src/agent-chat/goal.test.ts owns grammar; capability gating remains in cases 43/44. |
| final wave (4): an open card never holds back a goal command the HOST applies | REWRITE | Fold the duplicate successful trimming/notice-clear assertion into this host-goal-under-card regression. |
| final wave (4): everything else still waits for the card | REWRITE | Assert refusal states instead of comparing implementation-owned copy constants. |
| Implement on a plan that cannot be read back sends nothing, and says why | REWRITE | Preserve the supplied error; require a nonempty fallback notice instead of pinning fallback wording. |
| a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft | REWRITE | Build oversized input against literal 120000-character protocol bound. |
| the wire is told an Implement's prompt is the composer's, so no send of it — a reload's re-post included — gives it back | DELETE | Asserts the internal send callback option shape rather than persisted replay behavior. store.reload.test.ts owns generated-prompt replay restoration, while cases 49/59 own failed-send outcomes. |
| a goal chip action is not the draft's either: a reload's re-post of it never gives it back | DELETE | Same private generatedPrompt callback-shape assertion for goal actions; goal failure and storage generated-prompt ownership remain at their stable seams. |
| goals §8.2: a failed goal chip action says why and writes nothing back into any draft | REWRITE | Remove duplicate ordinary-send and draftAfterSend checks; retain the goal action failed outcome and user-facing supplied error. |
| the rail's Send measures the TRIMMED text against the length bound, as Enter does | REWRITE | Use the independently specified 120000-character limit instead of importing its implementation constant. |

## `packages/ui/src/components/agent-chat/composer/composer-trigger.test.ts`

1. **Independent contract:** GUI §§4.6.7, 7.4 token/caret insertion requirements.
2. **Visible failure:** menus opening inside prose, wrong trigger/query, replacing the wrong text, or leaving the caret in the wrong location; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** detectComposerTrigger and text replacement functions; production ChatComposer.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| the position gate keys on offset 0, not on the line | DELETE | Tests a one-field offset wrapper already observed through menu position gating and trigger range parsing. |
| replaceTextRange splices and reports the caret after the replacement | REWRITE | Exercise replacement with the real trailing-space range adjustment; assert the user text and caret after a completed insertion, not an intermediate double-space artifact. |
| a trailing space in the replacement swallows one space already there | DELETE | Separate helper-only trailing-space assertion is folded into the retained insertion contract in case 8. |

## `packages/ui/src/components/agent-chat/composer/skill-mentions.test.ts`

1. **Independent contract:** GUI §§4.6.7–4.6.8 stored-text skill tokenization; R2-8 lost-tokenizer regression.
2. **Visible failure:** unknown prose becoming a chip, real mention staying literal, token names truncated, or duplicate chips; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** skillMentionsInText; production timeline MessageRow.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

## `packages/ui/src/components/agent-chat/composer/tab-visibility.test.ts`

1. **Independent contract:** GUI §7.4 Escape precedence; Q2 hidden-tab keyboard and double-interrupt regressions.
2. **Visible failure:** hidden tab sending/answering, Escape interrupting through a modal, double interrupts, or held Escape stopping work; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** isChatTabListenerActive/composerOwnsEscape/composerEscapeAction; production ChatComposer, AgentChatView, QuestionCard.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

## `packages/ui/src/components/agent-chat/composer/workspace-skills.test.ts`

1. **Independent contract:** GUI §§4.6.4, 4.6.7 cwd overlay catalog and snapshot-loading contract.
2. **Visible failure:** wrong workspace skills offered or a transient missing provider snapshot breaking the catalog; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** workspaceSkills; production ChatComposer and AgentChatView timeline catalog.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| names each skill once | DELETE | Names-each-skill-once repeats Set implementation without observing chips; skillMentionsInText already deduplicates actual mentions. |

## `packages/ui/src/components/agent-chat/composer/composer-send-render.check.ts`

**KEEP — remounted composer refuses Send and Rewind only while its own thread is sending, and re-enables both after settlement.** (1) GUI §7.4 explicitly records the remount duplicate-send bug and rewind/send exclusion. (2) An enabled control would submit twice or rewind against an in-flight turn. (3) Expected enabled/disabled states are fixed independently. (4) The public HTML disabled state and documented `data-composer-shortcut` addressing convention are observed on the real ChatComposer. (5) No tree, class, layout, wording or source snapshot is asserted. (6) The registry tests cannot catch a component reading a local stale flag instead; this is the lowest available real component render seam for that connection. Production callers are AgentChatView through the composer index. Risk: low; no DOM effects are claimed.

## Production seams and support

- Remove `parseComposerOutbox`: its wrapper has no production caller; production loads via `readDocument`/`decodeDocument`. The tolerant-payload tests will use stored bytes and `adoptOutboxLeftovers` instead.
- Make `providerCommandsForSlashMenu` private and remove its barrel re-export: the deleted helper assertions were its only external consumer; real menu construction still calls it internally.
- Make `MAX_OUTBOX_ENTRIES` private after its only external consumer (the tests) stops importing it; keep the documented 100-entry behavior.
- Remove the composer-local re-export of `PLAN_IMPLEMENTATION_PROMPT_PREFIX` when its tautological test assertion is removed. The authoritative public API constant is unchanged.
- Remove imports/constants/helpers made unused by deleted cases. Shared `isolatedPage` remains required by actual page-lifecycle tests and is not modified.
- Every other examined owner has non-test callers described above; callbacks for real transport/storage/composer handoff are not test-only injection hooks.

## Validation results

- Baseline focused suite: 183/183 passing.
- Post-cleanup focused suite: 163/163 passing.
- After strengthening malformed-outbox cases against deduplication masking: focused outbox re-run 18/18 passing.
- Real ChatComposer disabled-state render check: passed.
- `pnpm --filter @orquester/ui typecheck`: passed (exit 0); root runs final repository gates.
- Scoped diff reviewed; no production behavior changed. An initial pnpm-filter wildcard invocation did not expand, and a later helper edit ran from the wrong directory; both command setup errors were corrected, followed by the passing focused runs above.
