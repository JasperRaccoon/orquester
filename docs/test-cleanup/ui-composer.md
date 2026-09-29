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

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| a stale unregister cannot drop the handle that replaced it | KEEP | Protects the distinct caller-visible contract named here: a stale unregister cannot drop the handle that replaced it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| builds the persisted shape from text, uploaded refs and the carried context | KEEP | Protects the distinct caller-visible contract named here: builds the persisted shape from text, uploaded refs and the carried context. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| re-stages every uploaded attachment as a ready chip and keeps the text verbatim | KEEP | Protects the distinct caller-visible contract named here: re-stages every uploaded attachment as a ready chip and keeps the text verbatim. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| keeps every file a restore wrote, over the eight, de-duplicated — the send gate holds the rest | KEEP | Protects the distinct caller-visible contract named here: keeps every file a restore wrote, over the eight, de-duplicated — the send gate holds the rest. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| into a full tray: every returned file is staged, and the draft is held at the send gate | DELETE | Duplicate full-tray preservation at an extra layer; cases 3 and 6 cover restored refs, persisted merge and subsequent load; store.test.ts separately owns bridge routing. |
| a file a bound still refuses leaves the message as its chip's X would take it, and is handed back for its path | KEEP | Protects the distinct caller-visible contract named here: a file a bound still refuses leaves the message as its chip's X would take it, and is handed back for its path. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| merges behind the persisted draft, keeping every file and its context | KEEP | Protects the distinct caller-visible contract named here: merges behind the persisted draft, keeping every file and its context. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| writes a returned file a bound refuses into the text as its path, so no later mount drops a file | KEEP | Protects the distinct caller-visible contract named here: writes a returned file a bound refuses into the text as its path, so no later mount drops a file. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| does not write on the keystroke, and writes the newest draft once when the window closes | KEEP | Protects the distinct caller-visible contract named here: does not write on the keystroke, and writes the newest draft once when the window closes. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| flushes synchronously, so an unmount or a reload keeps the tail | KEEP | Protects the distinct caller-visible contract named here: flushes synchronously, so an unmount or a reload keeps the tail. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| writes a clear immediately and drops anything the debounce still held | KEEP | Protects the distinct caller-visible contract named here: writes a clear immediately and drops anything the debounce still held. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| cancels without writing | KEEP | Protects the distinct caller-visible contract named here: cancels without writing. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| handed another thread while it was in flight: into its own thread's persisted draft, never the one on screen | KEEP | Protects the distinct caller-visible contract named here: handed another thread while it was in flight: into its own thread's persisted draft, never the one on screen. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| unmounted by a project switch: into its own thread's persisted draft, where the next mount loads it | KEEP | Protects the distinct caller-visible contract named here: unmounted by a project switch: into its own thread's persisted draft, where the next mount loads it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| still showing its thread: into the live draft, as always, and nothing is written behind it | KEEP | Protects the distinct caller-visible contract named here: still showing its thread: into the live draft, as always, and nothing is written behind it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| its tab open again in another composer: into that composer's live draft, never behind its back | KEEP | Protects the distinct caller-visible contract named here: its tab open again in another composer: into that composer's live draft, never behind its back. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a composer that no longer shows the thread refuses it, and the persisted draft takes it | KEEP | Protects the distinct caller-visible contract named here: a composer that no longer shows the thread refuses it, and the persisted draft takes it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| over a persisted draft already holding eight: all sixteen are written, the next mount loads all sixteen, and the send is held | DELETE | Repeats attachment count/restore/load transformations already owned by composer-draft cases 3 and 6; other cases here own destination routing and persistence. |
| a send that gives nothing back writes no draft: a refusal, a failed Implement | KEEP | Protects the distinct caller-visible contract named here: a send that gives nothing back writes no draft: a refusal, a failed Implement. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| removing a file drops its path and one adjacent space | KEEP | Protects the distinct caller-visible contract named here: removing a file drops its path and one adjacent space. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a path against punctuation still goes, and only the path: no space is owed there | DELETE | Pins the incidental punctuation spacing ("see , now"), rather than removal or data preservation; remaining literal-removal cases protect the actual contract. |
| removes exactly one occurrence, so a path the user repeated stays | KEEP | Protects the distinct caller-visible contract named here: removes exactly one occurrence, so a path the user repeated stays. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| treats the path literally: metacharacters in a name never widen the match | KEEP | Protects the distinct caller-visible contract named here: treats the path literally: metacharacters in a name never widen the match. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| numbers images by position among images only | KEEP | Protects the distinct caller-visible contract named here: numbers images by position among images only. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| removing an image drops its placeholder and renumbers the later ones | KEEP | Protects the distinct caller-visible contract named here: removing an image drops its placeholder and renumbers the later ones. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| revokes every preview URL a chip set holds, and only those | DELETE | Only counts calls to a mocked URL.revokeObjectURL; does not demonstrate released resources or a usable preview. Real preview restoration remains covered by case 4. |
| hands chips back without their revoked preview URLs, and the rest untouched | KEEP | Protects the distinct caller-visible contract named here: hands chips back without their revoked preview URLs, and the rest untouched. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| a disabled skill is never offered, and userInvocable:false hides one | KEEP | Protects the distinct caller-visible contract named here: a disabled skill is never offered, and userInvocable:false hides one. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| userInvocationOnly does not hide a skill — it is the reason to show it | KEEP | Protects the distinct caller-visible contract named here: userInvocationOnly does not hide a skill — it is the reason to show it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the slash-menu skill setting is honoured; the $ menu ignores it | KEEP | Protects the distinct caller-visible contract named here: the slash-menu skill setting is honoured; the $ menu ignores it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a skill that is also advertised as a command is listed once, as the skill | REWRITE | Remove duplicate direct providerCommandsForSlashMenu assertion; retain the complete menu result and skill winner. |
| away from offset 0 provider commands are dropped; host commands and skills stay | KEEP | Protects the distinct caller-visible contract named here: away from offset 0 provider commands are dropped; host commands and skills stay. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| /plan and /default appear only where the plan toggle is shown | REWRITE | Replace the entire host-command inventory with positive/negative membership for plan and default only. |
| /effort appears only when the selected model has a reasoning descriptor | REWRITE | Add the positive reasoning-capability case so an empty/broken menu cannot satisfy the negative test. |
| /compact is hidden until its full precondition list holds | KEEP | Protects the distinct caller-visible contract named here: /compact is hidden until its full precondition list holds. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the compact precondition rejects a non-empty draft or any attachment | KEEP | Protects the distinct caller-visible contract named here: the compact precondition rejects a non-empty draft or any attachment. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a name match outranks a description match | KEEP | Protects the distinct caller-visible contract named here: a name match outranks a description match. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| ties break host commands, then provider commands, then skills | KEEP | Protects the distinct caller-visible contract named here: ties break host commands, then provider commands, then skills. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a leading slash in the query is stripped before ranking | DELETE | No independently specified query-with-extra-slash requirement; the real trigger already removes its slash. This pins search normalization. |
| insertion: provider commands and skills insert text, host commands insert nothing | KEEP | Protects the distinct caller-visible contract named here: insertion: provider commands and skills insert text, host commands insert nothing. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-2: a synthesised provider /effort never duplicates the host row | KEEP | Protects the distinct caller-visible contract named here: R2-2: a synthesised provider /effort never duplicates the host row. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-2: the host dedupe is by name, case- and whitespace-insensitively | DELETE | Repeats host-command deduplication through its internal helper and adds unspecified casing/whitespace normalization; case 14 protects the actual effort-command collision. |
| R2-5: Grok's /always-approve is refused with a pointer at the mode chip | KEEP | Protects the distinct caller-visible contract named here: R2-5: Grok's /always-approve is refused with a pointer at the mode chip. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-5: the refusal is Grok-only and never fires on a lookalike | KEEP | Protects the distinct caller-visible contract named here: R2-5: the refusal is Grok-only and never fires on a lookalike. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: a host-parsed /goal (Codex) joins the host commands, with its description and hint | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: a host-parsed /goal (Codex) joins the host commands, with its description and hint. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: a provider adapter's own /goal entry is used unchanged | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: a provider adapter's own /goal entry is used unchanged. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: the host row replaces a provider row of the same name — one /goal, never two | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: the host row replaces a provider row of the same name — one /goal, never two. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: picking /goal TYPES it — the host parses the sent text, so it must reach the draft | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: picking /goal TYPES it — the host parses the sent text, so it must reach the draft. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: /goal is offered only at the start of the prompt — the host recognises nothing else | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: /goal is offered only at the start of the prompt — the host recognises nothing else. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.5: picking /goal ACTS on nothing — the insertion is the whole pick, nothing is sent | KEEP | Protects the distinct caller-visible contract named here: goals §8.5: picking /goal ACTS on nothing — the insertion is the whole pick, nothing is sent. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| a boolean descriptor is never mistaken for the reasoning select | KEEP | Protects the distinct caller-visible contract named here: a boolean descriptor is never mistaken for the reasoning select. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the selected model falls back to the provider default, then to the first | KEEP | Protects the distinct caller-visible contract named here: the selected model falls back to the provider default, then to the first. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an unset option reads the descriptor's default, then its currentValue | KEEP | Protects the distinct caller-visible contract named here: an unset option reads the descriptor's default, then its currentValue. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| setting an option adds it, then replaces it in place | KEEP | Protects the distinct caller-visible contract named here: setting an option adds it, then replaces it in place. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| switching model drops options the new model does not advertise | KEEP | Protects the distinct caller-visible contract named here: switching model drops options the new model does not advertise. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an option whose value is no longer a valid choice is dropped too | KEEP | Protects the distinct caller-visible contract named here: an option whose value is no longer a valid choice is dropped too. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| /effort <id> matches by id or label and refuses anything else | KEEP | Protects the distinct caller-visible contract named here: /effort <id> matches by id or label and refuses anything else. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| hands what this page is sending to the next page of the tab, once — never back to this page | KEEP | Protects the distinct caller-visible contract named here: hands what this page is sending to the next page of the tab, once — never back to this page. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| hands a thread its own leftovers only, and leaves every other thread's for that thread | KEEP | Protects the distinct caller-visible contract named here: hands a thread its own leftovers only, and leaves every other thread's for that thread. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| forgets an entry once it settles, for this page and the next | DELETE | Duplicate settled-message durability; store.reload.test.ts "leaves nothing for a reload once a send settled" observes the real send completion and next page. |
| forgets a settled entry even while it is still stored under the page that left it | KEEP | Protects the distinct caller-visible contract named here: forgets a settled entry even while it is still stored under the page that left it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| writes a queue over any stored copy of its messages, whichever page stored it | KEEP | Protects the distinct caller-visible contract named here: writes a queue over any stored copy of its messages, whichever page stored it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| mirrors a thread's queue in order, keeping the send in flight and every other thread's queue | KEEP | Protects the distinct caller-visible contract named here: mirrors a thread's queue in order, keeping the send in flight and every other thread's queue. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| gives a cold generation of this page the thread's queue, and a next page none of it until adopted | DELETE | Duplicate generation seeding/adoption; store.reload.test.ts "starts a generation that has nothing retained from the queue this page kept" plus its ordered reload queue case owns the real lifecycle. |
| never drops a send in flight to stay under the cap — only messages still waiting, oldest first | REWRITE | Use the independently documented 100-entry bound, not the exported implementation constant. |
| holds a message at the front of a thread's kept queue, reason and all, and says whether it could | KEEP | Protects the distinct caller-visible contract named here: holds a message at the front of a thread's kept queue, reason and all, and says whether it could. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| holds a later failure behind the ones it follows, keeping their order | KEEP | Protects the distinct caller-visible contract named here: holds a later failure behind the ones it follows, keeping their order. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| says whether a queue write reached the storage | KEEP | Protects the distinct caller-visible contract named here: says whether a queue write reached the storage. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| keeps a thread's last-shown stamp while it has queued messages, and forgets it with them | KEEP | Protects the distinct caller-visible contract named here: keeps a thread's last-shown stamp while it has queued messages, and forgets it with them. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
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
| each settle closes its own send only, and a second call is a no-op | KEEP | Protects the distinct caller-visible contract named here: each settle closes its own send only, and a second call is a no-op. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a send that left A, settling late, never re-enables B's send | KEEP | Protects the distinct caller-visible contract named here: a send that left A, settling late, never re-enables B's send. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| tells subscribers about every change, until they unsubscribe | REWRITE | Observe sending states seen by subscribers rather than counting private notifications. |
| holds a thread's queue while any of its queued sends is in flight, and no other thread's | KEEP | Protects the distinct caller-visible contract named here: holds a thread's queue while any of its queued sends is in flight, and no other thread's. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| is not a composer send: a queued send never reads as Sending, and a composer send never holds the queue | KEEP | Protects the distinct caller-visible contract named here: is not a composer send: a queued send never reads as Sending, and a composer send never holds the queue. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
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
| Enter sends on desktop and Shift+Enter is a newline | KEEP | Protects the distinct caller-visible contract named here: Enter sends on desktop and Shift+Enter is a newline. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| mobile never sends on Enter, whatever else is held | KEEP | Protects the distinct caller-visible contract named here: mobile never sends on Enter, whatever else is held. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| mod+Enter during a running turn is the per-message inversion | KEEP | Protects the distinct caller-visible contract named here: mod+Enter during a running turn is the per-message inversion. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the mod-enter shortcut requires the modifier and makes a bare Enter a newline | KEEP | Protects the distinct caller-visible contract named here: the mod-enter shortcut requires the modifier and makes a bare Enter a newline. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| mod-enter-multiline only demands the modifier once the draft has a newline | KEEP | Protects the distinct caller-visible contract named here: mod-enter-multiline only demands the modifier once the draft has a newline. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| steer vs queue is the preference XOR the per-message inversion | KEEP | Protects the distinct caller-visible contract named here: steer vs queue is the preference XOR the per-message inversion. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| nothing queues when no turn is running | KEEP | Protects the distinct caller-visible contract named here: nothing queues when no turn is running. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the prompt limit accepts 120000 characters and refuses the next | KEEP | Protects the distinct caller-visible contract named here: the prompt limit accepts 120000 characters and refuses the next. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an answer to a pending question is exempt from the turn input bound | REWRITE | Use literal 120010-character input from the independently specified turn bound. |
| a paste at or over 32 KiB becomes an attachment | KEEP | Protects the distinct caller-visible contract named here: a paste at or over 32 KiB becomes an attachment. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the byte length folds a paste the character count would let through | KEEP | Protects the distinct caller-visible contract named here: the byte length folds a paste the character count would let through. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a smaller paste still folds when it would blow the input limit | KEEP | Protects the distinct caller-visible contract named here: a smaller paste still folds when it would blow the input limit. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the escape hatch and a composer that cannot attach both keep the paste inline | KEEP | Protects the distinct caller-visible contract named here: the escape hatch and a composer that cannot attach both keep the paste inline. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the paste-as-text chord is platform-specific | KEEP | Protects the distinct caller-visible contract named here: the paste-as-text chord is platform-specific. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| folded pastes get stable, increasing names | DELETE | Exact pasted-text filenames have no independently specified naming requirement; pins a numbering implementation, not preservation of pasted content. |
| the attachment budget counts staged and in-flight together | KEEP | Protects the distinct caller-visible contract named here: the attachment budget counts staged and in-flight together. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an unsupported image type and an oversized file are both refused | KEEP | Protects the distinct caller-visible contract named here: an unsupported image type and an oversized file are both refused. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an unfinished or failed upload blocks send | KEEP | Protects the distinct caller-visible contract named here: an unfinished or failed upload blocks send. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a draft with only whitespace has nothing to send | KEEP | Protects the distinct caller-visible contract named here: a draft with only whitespace has nothing to send. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an empty draft implements the plan and leaves plan mode | REWRITE | Remove the expected-prefix assertion imported from the same implementation; retain action, mode and actual plan content. |
| text in the draft refines the plan and STAYS in plan mode | KEEP | Protects the distinct caller-visible contract named here: text in the draft refines the plan and STAYS in plan mode. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| re-delivering the same ref is a duplicate, not a second chip and not an error | DELETE | Identical ref-id duplicate scenario to case 23: the supposedly different first case also uses a different staged key. |
| a ref that arrives under a different key is still matched by its id | KEEP | Protects the distinct caller-visible contract named here: a ref that arrives under a different key is still matched by its id. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| staging counts against the same eight as a picked file | DELETE | Duplicate eighth-slot rejection already exercised by case 29 and the mixed ready/uploading case 25. |
| an in-flight upload occupies a slot against a staged ref too | KEEP | Protects the distinct caller-visible contract named here: an in-flight upload occupies a slot against a staged ref too. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a ref with no declared mimeType is measured as a file, never guessed into an image | KEEP | Protects the distinct caller-visible contract named here: a ref with no declared mimeType is measured as a file, never guessed into an image. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a ref with no declared size is staged as zero rather than refused | KEEP | Protects the distinct caller-visible contract named here: a ref with no declared size is staged as zero rather than refused. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a declared image over the image bound is still refused | DELETE | Repeats size validation owned by attachmentRejectionReason case 17; returned-reference bound case 29 also observes staging rejection. |
| a file coming back is never refused for the count, and every other bound still applies | KEEP | Protects the distinct caller-visible contract named here: a file coming back is never refused for the count, and every other bound still applies. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the status line works the count out from the draft, so it follows every chip removed and goes once the draft fits | KEEP | Protects the distinct caller-visible contract named here: the status line works the count out from the draft, so it follows every chip removed and goes once the draft fits. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a draft over eight attachments cannot be sent | KEEP | Protects the distinct caller-visible contract named here: a draft over eight attachments cannot be sent. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| Q2-5: Enter during an IME composition is not a send | KEEP | Protects the distinct caller-visible contract named here: Q2-5: Enter during an IME composition is not a send. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| Q2-5: the keyCode 229 fallback is honoured for engines without isComposing | KEEP | Protects the distinct caller-visible contract named here: Q2-5: the keyCode 229 fallback is honoured for engines without isComposing. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| Q2-5: a composition beats every other send path, including mod+Enter steering | KEEP | Protects the distinct caller-visible contract named here: Q2-5: a composition beats every other send path, including mod+Enter steering. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R7-3: an empty draft with an actionable plan is NOT a no-op submit | KEEP | Protects the distinct caller-visible contract named here: R7-3: an empty draft with an actionable plan is NOT a no-op submit. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-3: /plan is swallowed only where the toggle is shown | KEEP | Protects the distinct caller-visible contract named here: R2-3: /plan is swallowed only where the toggle is shown. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-3: /default follows the same gate, and an attachment defeats both | KEEP | Protects the distinct caller-visible contract named here: R2-3: /default follows the same gate, and an attachment defeats both. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-3: only a STANDALONE command is swallowed | KEEP | Protects the distinct caller-visible contract named here: R2-3: only a STANDALONE command is swallowed. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.2: a chip action is refused for exactly what refuses the composer's own send | KEEP | Protects the distinct caller-visible contract named here: goals §8.2: a chip action is refused for exactly what refuses the composer's own send. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| fix round 1 (5): a chip action the composer accepts clears its notice, as a submit does | DELETE | Successful notice clear and trimming are folded into retained case 43; refusal behavior stays in case 39 and case 44. |
| fix round 1 (7): which typed text the host takes as its /goal (goals §5.1) | DELETE | Replays shared isGoalCommandText grammar through a boolean wrapper. packages/api/src/agent-chat/goal.test.ts owns grammar; capability gating remains in cases 43/44. |
| fix round 1 (7): a typed host /goal is never queued — the host applies it at once | KEEP | Protects the distinct caller-visible contract named here: fix round 1 (7): a typed host /goal is never queued — the host applies it at once. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| final wave (4): an open card never holds back a goal command the HOST applies | REWRITE | Fold the duplicate successful trimming/notice-clear assertion into this host-goal-under-card regression. |
| final wave (4): everything else still waits for the card | REWRITE | Assert refusal states instead of comparing implementation-owned copy constants. |
| Implement on a plan that cannot be read back sends nothing, and says why | REWRITE | Preserve the supplied error; require a nonempty fallback notice instead of pinning fallback wording. |
| a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft | REWRITE | Build oversized input against literal 120000-character protocol bound. |
| a plan read back whole is what gets sent, not the cut one | KEEP | Protects the distinct caller-visible contract named here: a plan read back whole is what gets sent, not the cut one. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a plain send goes out as typed, and one the host refuses goes back to the draft as typed | KEEP | Protects the distinct caller-visible contract named here: a plain send goes out as typed, and one the host refuses goes back to the draft as typed. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a failed Implement leaves the draft alone: its prompt is the composer's, not the user's | KEEP | Protects the distinct caller-visible contract named here: a failed Implement leaves the draft alone: its prompt is the composer's, not the user's. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the wire is told an Implement's prompt is the composer's, so no send of it — a reload's re-post included — gives it back | DELETE | Asserts the internal send callback option shape rather than persisted replay behavior. store.reload.test.ts owns generated-prompt replay restoration, while cases 49/59 own failed-send outcomes. |
| a goal chip action is not the draft's either: a reload's re-post of it never gives it back | DELETE | Same private generatedPrompt callback-shape assertion for goal actions; goal failure and storage generated-prompt ownership remain at their stable seams. |
| every Implement reads its plan at send time, intact or cut, and no other send does | KEEP | Protects the distinct caller-visible contract named here: every Implement reads its plan at send time, intact or cut, and no other send does. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| what was typed or staged while it was in flight stays, behind it, and no chip is doubled | KEEP | Protects the distinct caller-visible contract named here: what was typed or staged while it was in flight stays, behind it, and no chip is doubled. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an image staged meanwhile keeps its own [Image #N] once the sent images are back ahead of it | KEEP | Protects the distinct caller-visible contract named here: an image staged meanwhile keeps its own [Image #N] once the sent images are back ahead of it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a send that went out, a refusal and a failed Implement all leave the draft as it is | KEEP | Protects the distinct caller-visible contract named here: a send that went out, a refusal and a failed Implement all leave the draft as it is. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a message returned behind the draft keeps naming its own images, never the draft's | KEEP | Protects the distinct caller-visible contract named here: a message returned behind the draft keeps naming its own images, never the draft's. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a returned message joins the draft's text with one blank line, and no blank lines when either side is empty | KEEP | Protects the distinct caller-visible contract named here: a returned message joins the draft's text with one blank line, and no blank lines when either side is empty. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a failed send comes back ahead of the draft exactly as it was sent, the draft's own images renumbered behind it | KEEP | Protects the distinct caller-visible contract named here: a failed send comes back ahead of the draft exactly as it was sent, the draft's own images renumbered behind it. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| goals §8.2: a failed goal chip action says why and writes nothing back into any draft | REWRITE | Remove duplicate ordinary-send and draftAfterSend checks; retain the goal action failed outcome and user-facing supplied error. |
| the rail's Send: an idle thread sends the trimmed text | KEEP | Protects the distinct caller-visible contract named here: the rail's Send: an idle thread sends the trimmed text. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the rail's Send measures the TRIMMED text against the length bound, as Enter does | REWRITE | Use the independently specified 120000-character limit instead of importing its implementation constant. |
| the rail's Send: a double click's twin is not queued twice | KEEP | Protects the distinct caller-visible contract named here: the rail's Send: a double click's twin is not queued twice. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| slash opens the command menu only at the start of a line | KEEP | Protects the distinct caller-visible contract named here: slash opens the command menu only at the start of a line. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a slash trigger dies as soon as the token contains whitespace | KEEP | Protects the distinct caller-visible contract named here: a slash trigger dies as soon as the token contains whitespace. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the bare slash itself is a trigger with an empty query | KEEP | Protects the distinct caller-visible contract named here: the bare slash itself is a trigger with an empty query. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| any currency symbol starts a skill token, not just $ | KEEP | Protects the distinct caller-visible contract named here: any currency symbol starts a skill token, not just $. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| @ starts a path token on the current whitespace-delimited word | KEEP | Protects the distinct caller-visible contract named here: @ starts a path token on the current whitespace-delimited word. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a caret before the trigger character sees no trigger | KEEP | Protects the distinct caller-visible contract named here: a caret before the trigger character sees no trigger. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
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

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| R2-8: known $skill mentions are found in order, deduped | KEEP | Protects the distinct caller-visible contract named here: R2-8: known $skill mentions are found in order, deduped. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: an UNKNOWN mention stays literal — it is not a chip | KEEP | Protects the distinct caller-visible contract named here: R2-8: an UNKNOWN mention stays literal — it is not a chip. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: a mention must start a token, so an email or a path is not one | KEEP | Protects the distinct caller-visible contract named here: R2-8: a mention must start a token, so an email or a path is not one. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: matching is case-insensitive but the text's own spelling is returned | KEEP | Protects the distinct caller-visible contract named here: R2-8: matching is case-insensitive but the text's own spelling is returned. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: any currency symbol opens a mention, as the composer trigger does | KEEP | Protects the distinct caller-visible contract named here: R2-8: any currency symbol opens a mention, as the composer trigger does. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: dots and dashes are part of a skill name | KEEP | Protects the distinct caller-visible contract named here: R2-8: dots and dashes are part of a skill name. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| R2-8: no known skills means no chips, and empty text never throws | KEEP | Protects the distinct caller-visible contract named here: R2-8: no known skills means no chips, and empty text never throws. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

## `packages/ui/src/components/agent-chat/composer/tab-visibility.test.ts`

1. **Independent contract:** GUI §7.4 Escape precedence; Q2 hidden-tab keyboard and double-interrupt regressions.
2. **Visible failure:** hidden tab sending/answering, Escape interrupting through a modal, double interrupts, or held Escape stopping work; each retained case names its distinct input and outcome below.
3. **Independent oracle:** literal expected text/state/IDs/order and supplied immutable fixtures; retained boundary tests use documented values. These expectations can disagree with the production branch.
4. **Stable seam and production callers:** isChatTabListenerActive/composerOwnsEscape/composerEscapeAction; production ChatComposer, AgentChatView, QuestionCard.
5. **Refactor survival:** assertions observe returned domain values, persisted payloads, or subscriber-visible state; they do not inspect source identifiers, call stacks, markup classes, or geometry.
6. **Lowest owner / stronger coverage:** this module owns the stated policy; store integration tests own transport/lifecycle routing. Cases that merely replay an already covered owner are deleted below; retained cases distinguish a policy input or output absent from those stronger tests.

Risk: low for pruning, with the exact contract owners retained; lifecycle and persistence cases are kept where loss/duplicate delivery would be material.

| Original test | Disposition | Failure / reason and remaining coverage |
| --- | --- | --- |
| the visible, active tab acts | KEEP | Protects the distinct caller-visible contract named here: the visible, active tab acts. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an explicitly inactive tab never acts, even while it still has a box | KEEP | Protects the distinct caller-visible contract named here: an explicitly inactive tab never acts, even while it still has a box. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a hidden subtree never acts, even when the caller forgot to pass `active` | KEEP | Protects the distinct caller-visible contract named here: a hidden subtree never acts, even when the caller forgot to pass `active`. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an unmounted listener owner never acts | KEEP | Protects the distinct caller-visible contract named here: an unmounted listener owner never acts. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| while a layer is up, the composer yields Escape | KEEP | Protects the distinct caller-visible contract named here: while a layer is up, the composer yields Escape. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| with a subagent view open, the composer claims Escape even while idle | KEEP | Protects the distinct caller-visible contract named here: with a subagent view open, the composer claims Escape even while idle. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the composer claims running-turn Escape only inside its shell | KEEP | Protects the distinct caller-visible contract named here: the composer claims running-turn Escape only inside its shell. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the textarea keeps Escape to itself — the token menu gets first refusal | KEEP | Protects the distinct caller-visible contract named here: the textarea keeps Escape to itself — the token menu gets first refusal. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| whoever ran first can stand the other down via defaultPrevented | KEEP | Protects the distinct caller-visible contract named here: whoever ran first can stand the other down via defaultPrevented. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| Escape with no turn running never interrupts from the composer | KEEP | Protects the distinct caller-visible contract named here: Escape with no turn running never interrupts from the composer. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| the token menu takes the textarea's Escape before anything else | KEEP | Protects the distinct caller-visible contract named here: the token menu takes the textarea's Escape before anything else. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an open layer takes the textarea's Escape: no interrupt, and no half of Esc Esc | KEEP | Protects the distinct caller-visible contract named here: an open layer takes the textarea's Escape: no interrupt, and no half of Esc Esc. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| with a subagent's view open, the textarea's Escape leaves it — never an interrupt | KEEP | Protects the distinct caller-visible contract named here: with a subagent's view open, the textarea's Escape leaves it — never an interrupt. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| with a subagent's view open, a menu or a layer still takes its Escape first | KEEP | Protects the distinct caller-visible contract named here: with a subagent's view open, a menu or a layer still takes its Escape first. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| with nothing open, Escape stops a running turn, and an idle one is half of Esc Esc | KEEP | Protects the distinct caller-visible contract named here: with nothing open, Escape stops a running turn, and an idle one is half of Esc Esc. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| a held Escape is one press: its auto-repeat does nothing, whatever is open | KEEP | Protects the distinct caller-visible contract named here: a held Escape is one press: its auto-repeat does nothing, whatever is open. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |

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
| the cwd's overlay wins where it lists any skill | KEEP | Protects the distinct caller-visible contract named here: the cwd's overlay wins where it lists any skill. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| an empty overlay, another cwd, or none: the machine-level catalogue | KEEP | Protects the distinct caller-visible contract named here: an empty overlay, another cwd, or none: the machine-level catalogue. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
| no snapshot, no skills | KEEP | Protects the distinct caller-visible contract named here: no snapshot, no skills. Expected input/output is asserted at the owner seam described above; no retained stronger test covers this same case. |
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
