# Agent-chat component test audit

Scope: all 60 original `.test.ts` files and three executable `.check.ts` scripts under `packages/ui/src/components/agent-chat/`. All were read with production owners and cross-layer duplicate owners. Baseline inventory contains 537 test declarations, expanding to 618 cases. This ledger records original names; removed helper cases are explicitly assigned to survivors. Current compiler/test gates are coordinated by the root agent.

No production behavior was changed. Removed three internal helper exports (`approvalCardDescription`, `normalizeQuoteText`, `blockquote`) and two quote-limit re-exports used only by tests; production callers retain their existing functions and owning constants. No local fixture, snapshot, helper dependency or configuration became orphaned. The deleted files are `status/tools-chip.test.ts` and `timeline/row-format.test.ts`.

Validation V: from `packages/ui`, `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-concurrency=4 <file>`; executable checks use the same imports without `--test`. Root owns `pnpm check:changed`, `pnpm check`, full suite/build and comparable timing. No whole-suite speedup is claimed here; the root report owns comparable full-suite measurements.

For every retained named case, B2's distinct failure is the concrete input/state/action in its name. B3 uses literal expected strings/bytes, explicit protocol records, browser-native state or measured tokenizer input work, never a call to the implementation to calculate an expected result. Shared B1/B4/B5/B6 evidence below applies individually to each case in its file; remaining cost is ordinary worker/import overhead unless stated. Deletions leave only incidental copy/implementation checks unprotected; consolidated outcomes name their surviving owner.

## packages/ui/src/components/agent-chat/ThreadGoneNotice.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.1 and ThreadGoneNotice focus contract.

B2 credible failures: keys remain directed to a covered composer or focus is stolen from another surface.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ThreadGoneNotice props and document.activeElement.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: only these mounted cases distinguish covered-chat, body and unrelated-field focus.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| takes focus from the chat it covers | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| takes focus when nothing had it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| leaves focus that is elsewhere in the app | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/QuestionCard.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.5 and docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md preview/privacy rules.

B2 credible failures: question cannot be answered, premature/IME submission, lost multi-question answer, wrong preview/file target, or active preview content enters host.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted QuestionCard/ChatBannerDock, keyboard/click events, submitted answer maps and iframe security attributes.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: answer-model tests do not prove native event wiring, bridge registration, iframe isolation or file navigation.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| never takes focus: the composer keeps it while a question with previews appears | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders the question as the chat's markdown | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders option labels and inline markdown descriptions without nested links | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the numbered options, picks by digit, and ignores a digit typed into the answer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is a textarea: Shift+Enter is a newline, Enter answers with the line breaks kept | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never answers on an IME composition's Enter | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on a phone, Return in the field is a newline; the button answers | REWRITE | executes the claimed phone Submit button and checks actual submitted map after proving Return did not send. |
| an Enter on the first of two questions moves on rather than answering | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a secret question keeps its masked single-line field | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| answers each question in turn, then sends them all; gone once the card is | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a single question's typed answer from the composer is submitted at once | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows no pane when no option has a preview | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| follows the focused option, and says so when the focused one has none | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| follows a pick too, and starts over on the next question | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| frames an HTML preview in an empty sandbox; its markup never enters the page | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| builds the framed document with a CSP that refuses every fetch, and the theme's tokens | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| reads a relative image through the file API against the project, and opens a file link in a tab | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/ToolApprovalCard.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §§7.1,9.3,14.2.10.

B2 credible failures: accidental/duplicate approval, stale preview approval, secret reuse or incorrect grant/denial.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted ToolApprovalCard, native controls and ToolApprovalAnswer callback.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: only mounted controls prove guard wiring, preview gates, resets and clearing secret fields.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| never takes focus: the composer keeps it when the card appears | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| ignores ⌘/Ctrl+Enter for 1.5 s after the card appears, then approves | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| restarts the guard when the card changes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Enter alone never approves — not even on the focused Approve button | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the composer's own ⌘/Ctrl+Enter never reaches the card | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| sends typed secrets with the approval and clears them from the card | CONSOLIDATE | survives as password/autocomplete, disabled-until-filled, payload and secret-clearing owner; absorbs redundant SSR password check. |
| a denial carries the reason; ⌘/Ctrl+Enter in the reason denies | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the grant menu approves with exactly the grant it offers | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a cut preview keeps Approve disabled until View all loaded the whole preview | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on a phone, opening the review sheet loads the cut preview and only then enables Approve | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a double click never approves the card that replaces the answered one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a click with detail 0 (assistive or programmatic) also waits out the appearance window | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| new content under the same card id re-locks the preview gate and restarts the guards | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| new content under the same card id drops what was typed for the old content and closes the review sheet | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on a phone a blocked Approve says why next to it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a grant row ignores a pointer click inside the guard too | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/approval-detail.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.3,5.6,7.5 and documented E7 regression.

B2 credible failures: the user approves a different command/file or cannot see the gated diff.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: resolveApprovalDetail over provider request/activity wire records.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: timeline joining receives a different group-shaped contract; request-owned/id-bound detail lookup has no stronger owner.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| E7: the request's own detail wins and is marked as such | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: with no detail, the card joins the gated tool call by toolUseId | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: the path list alone is enough when the item carries no diff | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: the join is by id only — a second write in flight is never guessed at | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: the newest activity wins when a tool id is reused across updates | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: a command payload is used when there are no changed files | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| E7: a missing or malformed payload never throws | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/banner-model.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.3,7.5,7.6; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §§7.1,7.5.

B2 credible failures: wrong urgent card, unsupported decision offered, hidden background Stop access, unsafe key or stale card retained.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: approval options/dock decision model, keyboard eligibility, parsed preview summary.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: render cases do not cover this complete priority/default/capability model; copy-only and duplicate expiry cases were removed.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the default four split into Approve/Decline primary and the rest overflow | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an empty advertised list falls back to the default four | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| advertised approval decisions keep their grouping when reordered | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the liveness banner is hidden while a turn is working | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the dock shows one card at a time, in a fixed priority order | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an agent's request for a secret docks after approvals and questions, before the plan prompt — on mobile too | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an Orquester card comes after a provider approval and before everything else | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only ⌘/Ctrl+Enter approves, and never within the guard | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a secret-files push names the vault, clones and privacy boundary | DELETE | Fails independent oracle for behavior: checks fixed marketing/disclosure sentence only; no secret value or write boundary is exercised. Owner: daemon secret-files service/routes and gate tests retain actual secret redaction/containment |
| a box rental (spend card) says what approving costs and reads as money, not Admin | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the card counts down and says when it expired | CONSOLIDATE | Fails unique-protection bar: clock-to-label helper duplicated rendered expiry and disabled approval. Owner: banners/tool-approval.render.test.ts: footer counts down; expired cannot approve |
| a late answer says the agent stopped waiting; a bad one keeps the card | REWRITE | retain status-to-closed state policy; drop fixed notice sentence equality. |
| a preview is cut when the summary says so or any section is partial | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a create_box card reads as renting a VM, by its kind or, before this build knows the kind, by its tool | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/pending-answer.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.2,4.5,7.5; answer wire contract and secret confidentiality.

B2 credible failures: wrong scalar/array answer, premature upload submission, lost text, leaked secret or cross-question attachment collision.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: buildPendingUserInputAnswers/applyComposerAnswer and answer eligibility APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM cases own event registration; these fixed input maps own distinct provider answer conversion and eligibility.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| an option with no value answers with its label | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a custom answer beats a selected option | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a custom answer is refused when the question forbids one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| multi-select answers with an array and drops unknown values | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an attachment alone satisfies a question | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an unfinished upload keeps the answer unresolved | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a choice-only question offers no attachments | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an \`isOther\` option asks for text rather than answering with its label | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a secret answer is never carried back into the thread draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| displaced text lands after whatever was already in the draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| toggling clears the custom answer; multi-select toggles in place | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a new single-select choice becomes the submitted answer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| custom text overrides a choice while empty text preserves it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the answers map is null until every question resolves | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| progress reports the active question, the count and completeness | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an out-of-range question index is clamped, never thrown on | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| attachment drafts are namespaced per (requestId, questionId) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a digit picks its option on the visible tab | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an open layer keeps the digit: it never answers the question behind a modal, a menu or a popover | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a digit never answers from a hidden tab, while typing, or under a modifier | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only 1–9, and only an option the question has | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a secret field's IME Enter commits the candidate, never the answer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on a phone the multi-line field's Return is a newline; the one-line secret's still answers | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the composer's text answers a single question and submits it, over a picked option | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on an earlier question the composer's text answers it and the card moves on | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the last question cannot send while an earlier one is unanswered | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a typed answer is refused where it cannot stand | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/banners/tool-approval.render.test.ts

B1 independent source: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §§7.1,9.3,14.2.10 and handover compatibility.

B2 credible failures: proposed bytes/warnings disappear, text spoofs the action, expired/unknown card approves, old card or oldest pending card is hidden.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ToolApprovalCard/ChatBannerDock props and rendered native semantics/data.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM cases own interaction; surviving render cases own section data, compatibility and expiry with fixed timestamps.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| renders the proposed content and flags from every preview section | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| agent text is sanitised: bidi overrides stripped from titles, escaped in code | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| secret fields are masked and approval waits for them | CONSOLIDATE | Fails unique-protection bar: mounted test proves native password field, disabled state, approval payload and clearing; autocomplete assertion moved there. Owner: banners/ToolApprovalCard.dom.test.ts: sends typed secrets with approval and clears them |
| the footer counts down to expiry; an expired card cannot be approved | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an older daemon's toolset card still renders: Enable for this chat / Deny | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a newer daemon's card can only be denied here | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| on a phone the preview goes behind a sheet; the flags stay on the card | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the dock shows the oldest card with its counter, after a provider approval and before a question | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-bridge.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 composer lifetime.

B2 credible failures: late cleanup unregisters the currently visible composer.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: registerComposerHandle/insertComposerText lifecycle.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: other draft/store tests do not interleave old cleanup with replacement handle registration.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a stale unregister cannot drop the handle that replaced it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-draft.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 persisted draft/file preservation; AGENTS.md tolerant storage.

B2 credible failures: draft/quotes/files vanish, placeholders duplicate or a late write resurrects sent text.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: composerDraftToPersist/loadComposerDraft and persisted return/scheduler APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: storage routing tests own send failures; these retained cases own ready-ref persistence, returned-message conversion and flush ordering.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| builds the persisted shape from text, uploaded refs and the carried context | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| re-stages every uploaded attachment as a ready chip and keeps the text verbatim | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps every file a restore wrote, over the eight, de-duplicated — the send gate holds the rest | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a file a bound still refuses leaves the message as its chip's X would take it, and is handed back for its path | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| merges behind the persisted draft, keeping every file and its context | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| writes a returned file a bound refuses into the text as its path, so no later mount drops a file | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| persists them whole, and leaves the field off when there are none | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| tells a draft whose quotes changed from one that did not | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| loads them back with the text | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| puts a failed send's quotes back ahead of the persisted ones, with its own words | CONSOLIDATE | Fails unique-protection bar: same real draft conversion is reached through persisted storage routing; survivor now combines existing text with quotes. Owner: composer/composer-failed-send.test.ts: quoted send comes back; send gives nothing back |
| gives nothing back for a refusal, whatever it carried | CONSOLIDATE | Fails unique-protection bar: same real draft conversion is reached through persisted storage routing; survivor now combines existing text with quotes. Owner: composer/composer-failed-send.test.ts: quoted send comes back; send gives nothing back |
| keeps the persisted quotes when a message comes back behind the draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| takes a returned quoted message's quotes back out, after the draft's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| flushes synchronously, so an unmount or a reload keeps the tail | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| writes a clear immediately and drops anything the debounce still held | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-failed-send.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 failed-send ownership regression.

B2 credible failures: failure restores into wrong thread, behind live composer, or loses text/files/quotes.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: restoreFailedSendDraft through real composer bridge and localStorage bytes.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: lower merge helpers cannot verify target routing or the actual persisted record.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| handed another thread while it was in flight: into its own thread's persisted draft, never the one on screen | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| unmounted by a project switch: into its own thread's persisted draft, where the next mount loads it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| still showing its thread: into the live draft, as always, and nothing is written behind it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| its tab open again in another composer: into that composer's live draft, never behind its back | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a composer that no longer shows the thread refuses it, and the persisted draft takes it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a quoted send comes back with its quotes as quotes, ahead of any quoted meanwhile | CONSOLIDATE | persisted record now includes nonempty meanwhile text plus quote ordering; catches data loss/reordering through real storage routing. |
| a send that gives nothing back writes no draft: a refusal, a failed Implement | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-files.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 attachment host paths.

B2 credible failures: removing chip deletes other text/path or leaves the sent path behind.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: removeFilePath string behavior consumed by composer removal.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: image placeholders use a separate grammar; file literal matching and one-occurrence removal are unique.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| removing a file drops its path and one adjacent space | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| removes exactly one occurrence, so a path the user repeated stays | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| treats the path literally: metacharacters in a name never widen the match | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-image-fit.test.ts

B1 independent source: composer-image-fit.ts documented provider 2000px image contract, EXIF and lossless fallback policy.

B2 credible failures: oversized upload rejected, portrait distorted, transparency/animation lost, or codec failure prevents upload.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: prepareImageForUpload across native File/canvas codec boundary and MIME classification consumed by ChatComposer.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: mock codec supplies browser I/O only; tested scale/type/fallback decisions remain production code and have no other owner.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| accepts PNG and JPEG only | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| re-encodes a large JPEG at the cap with quality 0.85 | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| uses the decoded (EXIF-upright) dimensions for the target | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps a still PNG as PNG so transparency survives | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the original for an animated PNG, GIF, WebP and SVG | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the original when it already fits | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the original when the re-encode is not smaller, empty, retyped or missing | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the original when decoding or encoding fails, or there is no codec | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-images.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 image placeholders and preview lifetime.

B2 credible failures: wrong image referred to after removal or a staged preview leaks/gets revoked incorrectly.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: image numbering/removal APIs and actual blob URL readability.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: draft restore uses these helpers but does not own direct chip removal or live blob lifetime.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| numbers images by position among images only | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| removing an image drops its placeholder and renumbers the later ones | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| releases every staged preview without revoking an unrelated image | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| hands chips back without their revoked preview URLs, and the rest untouched | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-menu.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.6.4–4.6.8 and goal design §8.5.

B2 credible failures: unavailable command offered, provider text dispatched wrongly, duplicate skill or unsupported mode change.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: menu eligibility, insertion and command-action APIs over advertised catalog.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: trigger tests own token recognition; these own catalog/capability-driven choices and their send versus insert semantics.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a disabled skill is never offered, and userInvocable:false hides one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| userInvocationOnly does not hide a skill — it is the reason to show it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the slash-menu skill setting is honoured; the $ menu ignores it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a skill that is also advertised as a command is listed once, as the skill | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| away from offset 0 provider commands are dropped; host commands and skills stay | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| /plan and /default appear only where the plan toggle is shown | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| /effort appears only when the selected model has a reasoning descriptor | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| /compact is hidden until its full precondition list holds | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the compact precondition rejects a non-empty draft or any attachment | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a name match outranks a description match | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| insertion: provider commands and skills insert text, host commands insert nothing | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-2: a synthesised provider /effort never duplicates the host row | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-5: Grok's /always-approve is refused with a pointer at the mode chip | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-5: the refusal is Grok-only and never fires on a lookalike | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: a host-parsed /goal (Codex) joins the host commands, with its description and hint | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: a provider adapter's own /goal entry is used unchanged | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: the host row replaces a provider row of the same name — one /goal, never two | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: picking /goal TYPES it — the host parses the sent text, so it must reach the draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: /goal is offered only at the start of the prompt — the host recognises nothing else | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.5: picking /goal ACTS on nothing — the insertion is the whole pick, nothing is sent | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-model.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.1,4.6.5 and model descriptor wire contracts.

B2 credible failures: selection falls to wrong model, stale option crosses models or effort value is silently invalid.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: model/effort selection APIs over ProviderModel/ModelSelection.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: adapter tests own provider translation; these own selection before wire submission.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the reasoning descriptor is found under any of the four adapters' ids | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a boolean descriptor is never mistaken for the reasoning select | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the selected model falls back to the provider default, then to the first | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an unset option reads the descriptor's default, then its currentValue | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| switching model drops options the new model does not advertise | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an option whose value is no longer a valid choice is dropped too | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| /effort <id> matches by id or label and refuses anything else | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-outbox.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 reload idempotency/queue absence; AGENTS.md tolerant browser storage.

B2 credible failures: reload loses/reposts wrong thread message, reorders queue, drops in-flight send or rejects all old records.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: outbox APIs in isolated real module pages and sessionStorage JSON.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: store.reload tests own delivery; these own stored document parsing, page adoption, bounds and queue metadata.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| hands what this page is sending to the next page of the tab, once — never back to this page | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| hands a thread its own leftovers only, and leaves every other thread's for that thread | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| forgets a settled entry even while it is still stored under the page that left it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| writes a queue over any stored copy of its messages, whichever page stored it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| mirrors a thread's queue in order, keeping the send in flight and every other thread's queue | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never drops a send in flight to stay under the cap — only messages still waiting, oldest first | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| holds a message at the front of a thread's kept queue, reason and all, and says whether it could | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| says whether a queue write reached the storage | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps a thread's last-shown stamp while it has queued messages, and forgets it with them | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is fresh while the later of the queue's last showing and the message's queueing is within the bound | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps every send in flight even past the cap: the bound only ever drops a waiting message | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| reads nothing out of a value that is not a v1 outbox | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the entries it can read, and drops each one it cannot | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps a redirect's approvals with its send, so a re-post declines them too | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops a malformed optional field, never the message it belongs to | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps a model selection and a plan-mode turn it can read | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| reads a held message's reason, and the last-shown stamps, field-wise | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the first of two entries under one commandId | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-pending-send.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.4,7.5 redirect/question handling and goal §8.2.

B2 credible failures: redirect queues behind its own approval, typed answer becomes new turn or subagent feedback receives unsupported files.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: pending request planning and external submit APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM card tests own field input; these own composer/external-surface routing through pending requests.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| nothing pending: an ordinary send, and no hint | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a message over pending approvals redirects: every approval is declined, files and all | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an approval being answered from its card holds the redirect back | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a bare /compact cannot redirect; /compact with words or files is a message | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a /goal the host applies itself is an ordinary send over any card | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a message over a question is its answer, unless it carries files | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an approval is in front of a question, in the dock and in what a send does | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a redirect is never queued behind the turn it answers | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| another surface's send over an approval redirects too; over a question it waits | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the rail's Send over an approval is a redirect, sent now even with queueing preferred | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a request already answered elsewhere is neither redirected nor answered again | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only subagents' approvals: the message is their answer, text only, and the wording says so | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-quotes.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 selected reply passages; CommonMark blockquote/fence wire grammar.

B2 credible failures: user text swallowed by unclosed code, quoted bytes mangled, or failed send loses passage order.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: composeQuotedPrompt, splitLeadingQuotes, quote-list/restore APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: normalization/blockquote helper probes consolidated into composed prompt bytes; selection DOM owns extracting a passage, not send serialization.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| quotes every line, a blank one as a bare \`>\` so the quote stays one block | CONSOLIDATE | Fails stable-seam/unique-protection bar as direct internal formatting helper; original line endings/blank/nested/indented/code cases now run through actual composed send-prompt bytes. Owner: same file: puts quote ahead of user text; keeps quoted code block closed |
| nests a line that was already a quote, and keeps indentation | CONSOLIDATE | Fails stable-seam/unique-protection bar as direct internal formatting helper; original line endings/blank/nested/indented/code cases now run through actual composed send-prompt bytes. Owner: same file: puts quote ahead of user text; keeps quoted code block closed |
| drops blank lines at either end and unifies line endings | CONSOLIDATE | Fails stable-seam/unique-protection bar as direct internal formatting helper; original line endings/blank/nested/indented/code cases now run through actual composed send-prompt bytes. Owner: same file: puts quote ahead of user text; keeps quoted code block closed |
| quotes a fenced code block line by line, its blank lines included | CONSOLIDATE | Fails stable-seam/unique-protection bar as direct internal formatting helper; original line endings/blank/nested/indented/code cases now run through actual composed send-prompt bytes. Owner: same file: puts quote ahead of user text; keeps quoted code block closed |
| closes a fence the passage opened and never closed | REWRITE | inspect independently expected composed prompt bytes instead of private normalizer output. |
| puts the quote ahead of the user's text, a blank line between | CONSOLIDATE | survivor combines CRLF, edge blanks, nested quote and indentation; fixed expected prompt protects original four helper cases. |
| keeps several quotes several blocks, in order | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| sends the quotes alone when there is no text | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| leaves the text exactly as it is when there are no quotes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps a quoted code block closed, so the user's text never lands inside it | CONSOLIDATE | retains code-body blank line plus automatic closer and user text boundary in composed prompt. |
| reads back what a quoted send composed | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| has no body when the quotes were sent alone | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is all body when the message does not open with a quote | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is all body when a line continues a quote (markdown would fold it in) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| takes off one level of \`>\` and an optional space | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| returns as it was composed: its quotes as quotes, its words as the text | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is left as it is without quotes, or with one too long to hold | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| previews prose on one line, markers stripped | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| previews code without its fences, and bounds the length | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| knows a quote that is one code block and nothing else | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| adds a passage at the end, normalised | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| refuses an empty passage, one too long, and one past the bound | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| puts a failed send's quotes back ahead of the ones quoted meanwhile, each once | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-recall.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 prompt history and arrow ownership.

B2 credible failures: history recalls another agent/internal message, overwrites edited draft, or steals field navigation.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: recall entries/direction/step APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: persistent history/index tests do not own composer recall position and caret eligibility.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the entries: the parent's own typed prompts, oldest first, repeats collapsed onto the newest | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| walks back from the newest prompt | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| walks forward, and past the newest prompt empties the composer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a draft the user typed, or an edited recall, is never replaced | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| follows the entry by id when the list grows under it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the arrows walk the history only from the edge line, with nothing else claiming them | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-sends.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 send-outlives-composer and queued-send ordering regressions.

B2 credible failures: late settle enables another thread or queued message overtakes a still-pending predecessor.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: begin/settle/send-state subscription APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: render check owns component subscription; these interleavings own registry lifetime and idempotent settles.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| each settle closes its own send only, and a second call is a no-op | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a send that left A, settling late, never re-enables B's send | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| tells subscribers about every change, until they unsubscribe | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| holds a thread's queue while any of its queued sends is in flight, and no other thread's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is not a composer send: a queued send never reads as Sending, and a composer send never holds the queue | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-submission.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.1,4.6.5,7.4 and goal §8.2.

B2 credible failures: invalid/duplicate input sent, incorrect queue/steer/plan mode, truncated plan dispatched or draft data lost.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: submission/attachment/restore/external-send APIs and send callback payload.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: outbox tests own persistence/replay; these fixed cases own decisions and full prompt bytes before transport.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| Enter sends on desktop and Shift+Enter is a newline | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| mobile never sends on Enter, whatever else is held | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| mod+Enter during a running turn is the per-message inversion | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the mod-enter shortcut requires the modifier and makes a bare Enter a newline | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| mod-enter-multiline only demands the modifier once the draft has a newline | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| steer vs queue is the preference XOR the per-message inversion | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| nothing queues when no turn is running | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the prompt limit accepts 120000 characters and refuses the next | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an answer to a pending question is exempt from the turn input bound | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a paste at or over 32 KiB becomes an attachment | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the byte length folds a paste the character count would let through | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a smaller paste still folds when it would blow the input limit | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the escape hatch and a composer that cannot attach both keep the paste inline | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the paste-as-text chord is platform-specific | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the attachment budget counts staged and in-flight together | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an unsupported image type and an oversized file are both refused | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an unfinished or failed upload blocks send | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a draft with only whitespace has nothing to send | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| quotes alone are a message | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an empty draft implements the plan and leaves plan mode | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| text in the draft refines the plan and STAYS in plan mode | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a ref that arrives under a different key is still matched by its id | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a ref with no declared mimeType is measured as a file, never guessed into an image | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a file coming back is never refused for the count, and every other bound still applies | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the status line works the count out from the draft, so it follows every chip removed and goes once the draft fits | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a draft over eight attachments cannot be sent | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Q2-5: Enter during an IME composition is not a send | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Q2-5: the keyCode 229 fallback is honoured for engines without isComposing | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R7-3: an empty draft with an actionable plan is NOT a no-op submit | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-3: /plan is swallowed only where the toggle is shown | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-3: /default follows the same gate, and an attachment defeats both | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-3: only a STANDALONE command is swallowed | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.2: a chip action is refused for exactly what refuses the composer's own send | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| fix round 1 (7): a typed host /goal is never queued — the host applies it at once | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| final wave (4): an open card never holds back a goal command the HOST applies | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| final wave (4): everything else still waits for the card | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Implement on a plan that cannot be read back sends nothing, and says why | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a read-back prompt over the turn bound is refused before it is sent, and nothing goes back to the draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a plan read back whole is what gets sent, not the cut one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a plain send goes out as typed, and one the host refuses goes back to the draft as typed | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a failed Implement leaves the draft alone: its prompt is the composer's, not the user's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| send ownership marks only generated prompts to stay out of the draft after reload | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| every Implement reads its plan at send time, intact or cut, and no other send does | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| what was typed or staged while it was in flight stays, behind it, and no chip is doubled | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an image staged meanwhile keeps its own [Image #N] once the sent images are back ahead of it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a send that went out, a refusal and a failed Implement all leave the draft as it is | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a message returned behind the draft keeps naming its own images, never the draft's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a returned message joins the draft's text with one blank line, and no blank lines when either side is empty | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a failed send comes back ahead of the draft exactly as it was sent, the draft's own images renumbered behind it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goals §8.2: a failed goal chip action says why and writes nothing back into any draft | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the rail's Send measures the TRIMMED text against the length bound, as Enter does | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the rail's Send: a double click's twin is not queued twice | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/composer-trigger.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.6.7,7.4.

B2 credible failures: path/date opens command menu, a currency keyboard cannot mention skill, or picking menu destroys adjacent text.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: caret-relative token detection and replacement APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: menu tests own advertised choices; these own lexical trigger and replacement range.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| slash opens the command menu only at the start of a line | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a slash trigger dies as soon as the token contains whitespace | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the bare slash itself is a trigger with an empty query | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| any currency symbol starts a skill token, not just $ | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| @ starts a path token on the current whitespace-delimited word | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a caret before the trigger character sees no trigger | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| replaceTextRange splices and reports the caret after the replacement | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/profile-chip.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3; README Agent Profiles.

B2 credible failures: unready profile selected, busy thread switches or Global pick fails to clear remembered profile.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted ProfileChip and onChange profile IDs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: profile store tests cannot prove native disabled/menu action wiring.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| names Global, lists the profiles, and disables one not ready for the chat's agent | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows the thread's profile and switches back to Global | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Global in a Global chat still reports the pick (it forgets a remembered profile; the chat itself does not switch) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is closed while the thread is busy, saying why | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/skill-mentions.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §4.6.8 and provider skill-name grammar.

B2 credible failures: unknown/currency/path token misattributed to installed skill or plugin-qualified name split.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: skillMentionsInText over sent text/catalog.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: row renderer owns locating recognized mentions; token eligibility has this lowest owning seam.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| R2-8: known $skill mentions are found in order, deduped | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-8: an UNKNOWN mention stays literal — it is not a chip | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-8: a mention must start a token, so an email or a path is not one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-8: matching is case-insensitive but the text's own spelling is returned | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-8: any currency symbol opens a mention, as the composer trigger does | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| R2-8: dots and dashes are part of a skill name | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a plugin's \`plugin:skill\`, dotted plugin names included, is one mention — as the daemon dispatches it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| \`$1.50\` and a dot or colon ending a sentence are no mention, as dispatch leaves them literal | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/tab-visibility.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.1,7.4 keyboard ownership regressions.

B2 credible failures: composer steals modal/menu Escape, interrupts parent while leaving child, or held key repeats an action.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: composer Escape ownership/action APIs.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: shell Escape owns disjoint outside-composer scope; these cases own window/composer-field priority.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| while a layer is up, the composer yields Escape | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| with a subagent view open, the composer claims Escape even while idle | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the composer claims running-turn Escape only inside its shell | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the textarea keeps Escape to itself — the token menu gets first refusal | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| whoever ran first can stand the other down via defaultPrevented | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Escape with no turn running never interrupts from the composer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the token menu takes the textarea's Escape before anything else | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an open layer takes the textarea's Escape: no interrupt, and no half of Esc Esc | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| with a subagent's view open, the textarea's Escape leaves it — never an interrupt | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| with a subagent's view open, a menu or a layer still takes its Escape first | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| with nothing open, Escape stops a running turn, and an idle one is half of Esc Esc | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a held Escape is one press: its auto-repeat does nothing, whatever is open | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/composer/workspace-skills.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.6.4,4.6.7.

B2 credible failures: composer offers wrong workspace skills or hides machine catalog behind empty overlay.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: workspaceSkills over provider/cwd snapshots.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: provider catalog tests do not own client cwd preference/fallback.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the cwd's overlay wins where it lists any skill | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an empty overlay, another cwd, or none: the machine-level catalogue | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| no snapshot, no skills | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/drill-in-navigation.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 auto-return/search-reveal regressions.

B2 credible failures: reader yanked from finished child, work state inherited from other child or search hit remains hidden.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: nextDrillInReturn/revealClosesDrillIn state transitions.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: row projection and memory tests do not own transitions back to main timeline.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| an agent seen at work that settles while the reader follows its end hands the view back | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| opening a finished agent from a running agent's view stays open (was one flag for the whole view) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a reader who scrolled up stays when it settles — and is not yanked later on reaching the end | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| idle is not at work: an idle agent that settles returns nothing | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an agent the roster dropped, then back, starts over | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| A → B → A: each agent is watched from its own opening | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a NEW reveal closes an open drill-in, so the thread's timeline takes it at once | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| no new reveal closes nothing: opening a drill-in while an old one is pending leaves it open | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/escape-action.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.5,7.1,7.4,7.6.

B2 credible failures: Escape stops wrong/hidden thread, takes modal/field key or rewinds after unrelated input.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: resolveChatEscape/chatEscapeSequenceStep.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: composer Escape tests own a separate target scope; these own outside-composer and double-press gating.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the drill-in wins over the interrupt | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Escape interrupts a running turn from anywhere in the tab | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a hidden tab never acts, whatever it is doing | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a blocking layer keeps the key: Escape closes the modal, not the thread | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| focus inside the composer belongs to the composer's own arm, not this one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an event another listener already handled is not handled twice | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a held Escape is one press: its auto-repeat never stops the turn the first press spared | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only Escape | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a second idle Escape opens the rewind picker | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the first idle Escape does nothing — it is only half of the gesture | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| no message to go back to, no picker | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the double press never outranks leaving a drill-in or stopping a turn | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the rewind obeys every gate the other two do | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only an idle Escape is pressed into the double-press sequence | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an Escape that did something else starts the count over | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| any other key between two Escapes breaks the sequence | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| holding Escape is one press, and its auto-repeat breaks nothing either | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an Escape typed into a field outside this chat is that field's: nothing here, and Esc Esc starts over | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/forge-links/forge-link-pill.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 plus forge-link public URL/preview contract.

B2 credible failures: unsafe target, eager request, wrong repository identity or touch tap blocked by preview.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted ForgeLinkPill native href/rel, tooltip events and preview API.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: parser tests do not prove real native link/tooltip/API integration.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| is a real new-tab link with the short label, and reads nothing until hovered | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops owner/repo for a link into the project's own repo | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| hover opens the card, reads the preview once, and takes the merged colour | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a touch does not open the card in the way of the tap | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the author's text, and stays a plain styled link when the read fails | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never reads links that have no preview, but still shows their card | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/forge-links/forge-link-pill.render.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 and forge link labels/URL policy.

B2 credible failures: markdown URL never reaches forge UI, author words overwritten, punctuation swallowed or hostile lookalike classified.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ChatMarkdown/UserMessageRow with plain or authored links.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM pill tests start with an already parsed link and cannot catch markdown/plain-text routing.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| assistant autolinks become pills with short labels | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a link with the author's words keeps them and gains the icon | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| badge images, other hosts and look-alikes stay ordinary links | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| GitLab and Bitbucket change requests are pills too | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a user's plain-text message turns its GitHub URLs into pills and keeps the rest as typed | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/lineage.render.test.ts

B1 independent source: thread lineage GUI contract; docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8.2; old context-marker compatibility.

B2 credible failures: unavailable merge/fork offered, held reply treated as failure, or another agent/old host message attributed to user.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ThreadLineageBar/UserMessageRow props and actionable/attribution semantics.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: count/caption duplicates removed in favor of lineage.logic and folded DOM; controls and legacy attribution need renderer seam.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a fork's bar names its parent and offers Merge back | REWRITE | retain parent identity and merge action; remove caption grammar. |
| a child whose parent was closed says so, and offers no merge | REWRITE | retain unavailable merge action when parent absent; remove closed-parent sentence wording. |
| a parent's bar counts its forks and tasks; a thread with neither shows nothing | CONSOLIDATE | Fails unique-protection bar: same child relation counts already belong to the lineage model. Owner: lib/agent-chat/lineage.logic.test.ts: a parent counts its children by relation |
| a reply held after a stop is said quietly as held, with Deliver now — never as a failed merge | REWRITE | retain source identity, held state, recovery action and reported error; remove appearance class and fixed sentence. |
| the tab mark is titled with the relation and the parent | DELETE | Fails independent-contract/refactor bar for exact English captions, class/data marker spellings or duplicate counts; actionable fork/merge availability remains covered. Owner: lib/agent-chat/lineage.logic.test.ts; folded-thread-message.dom.test.ts; retained lineage control cases |
| a prompt and a reply offer Fork from here; a read-only timeline does not | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| Continue in another agent… sits beside the fork buttons, only where it is offered | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a continued chat's bar says where it came from, and keeps Merge back | DELETE | Fails independent-contract/refactor bar for exact English captions, class/data marker spellings or duplicate counts; actionable fork/merge availability remains covered. Owner: lib/agent-chat/lineage.logic.test.ts; folded-thread-message.dom.test.ts; retained lineage control cases |
| pending merges show on both tabs, with deliver and discard; a failed one says why | REWRITE | retain queued/retry state, recovery actions, parent identity and provider failure data; remove caption grammar. |
| a merged-back message shows where it came from, and the result alone | CONSOLIDATE | Fails unique-protection bar: mounted merged-result case proves marked result remains visible; protocol/parser owners prove body extraction. Owner: timeline/folded-thread-message.dom.test.ts: a merged-back result is never folded; lib/agent-chat/lineage.logic.test.ts |
| an opened chat reads Opened by — never as a fork — and its parent counts it apart | DELETE | Fails independent-contract/refactor bar for exact English captions, class/data marker spellings or duplicate counts; actionable fork/merge availability remains covered. Owner: lib/agent-chat/lineage.logic.test.ts; folded-thread-message.dom.test.ts; retained lineage control cases |
| another chat's reply reads Reply from, with its project; the bubble holds the reply alone | REWRITE | retains sender/project identity and body/provenance; removes exact caption grammar. |
| sent, opened and delegated captions keep their words; an unmarked header is the user's own text | CONSOLIDATE | Caption wording fails independent-contract bar; spoof-resistant unmarked attribution already has a mounted owner. Owner: timeline/folded-thread-message.dom.test.ts: user own message is never folded |
| an opened chat's merge back says so; an older build's automatic continue is Orquester's | REWRITE | removes duplicate opened merge caption, preserves old persisted toolset-continue attribution; final test renamed to “an older build's automatic continue is attributed to Orquester”. |

## packages/ui/src/components/agent-chat/mcp-app/McpAppFrame.dom.test.ts

B1 independent source: MCP Apps ui/initialize/resource-teardown protocol; app isolation and reconnect contract.

B2 credible failures: reconnect tears down app, stale client handles requests, denied app requests data or shortcut escapes focus.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted McpAppFrame plus actual window postMessage JSON-RPC.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: host unit tests cannot prove frame lifetime or browser-message/native focus wiring; width is protocol data, not appearance.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| keeps its host across a reconnect's new API client, and asks through the new one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| sends its teardown on unmount | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never reports a hidden tab's zero width | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| refuses an app that reaches Orquester before asking anything | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| tells the app its shortcuts, and replays one it passes on while focused | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/primitives/elapsed.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 and malformed CLI timestamp tolerance.

B2 credible failures: NaNs appears in elapsed status for malformed timestamp.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: elapsedBetween over provider timestamp values.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: other format tests own valid durations, not absent/invalid stamps.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| elapsedBetween returns empty for missing or unparseable stamps | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/roster/background-shell.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 background-shell protocol and stable disclosure identity.

B2 credible failures: shell output vanishes/stales, wrong command shown or expansion closes while streaming.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: projectBackgroundShell from ThreadItem wire activity data.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: generic row join owns joining; these own shell-specific mapping and cache invalidation.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the row keeps the first frame's id, so a streaming row cannot close itself | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| with no lifecycle frame left, the shell is titled from its roster row, its whole output joined | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a Grok shell folds its task lifecycle into the command's output and status | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a running Grok shell has no output until it prints | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a Grok monitor's latest line is its output | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a chunk of the shell's own updates the cached output | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/roster/drill-in-memory.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 50-agent reading memory and follow re-arm regression.

B2 credible failures: reopened child loses position/title, state leaks across children or stale position defeats follow.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: rememberDrillIn/recallDrillIn/drillInOpening.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: main thread persistent LRU is a different owner; no duplicate owns this per-agent transient state.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| an agent never opened opens as today: at its end, following, nothing open | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| re-opening an agent restores its disclosures and a mid-list position, with follow OFF | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a reader who re-armed follow (the pill, mod+J) comes back to the end, whatever position was published before | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an entry keeps the last roster row seen, so a reopened agent the roster evicted keeps its title and kind | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| A → B saves A's and restores B's, and each keeps its own | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the 50 most recent agents: the least recently remembered goes first | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/roster/roster-summary.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 kind-aware roster/workflow accounting.

B2 credible failures: shell counted as agent, coordinator double-counted, work tokens doubled or drivers misplaced.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: rosterKindCounts/workflowGroupSummary/partitionRosterRows.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: API panel model tests do not own client section/count projection over workflows.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| counts agents and shells apart, live ones included | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| counts a loop and a goal as neither an agent nor a shell | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| counts the members as agents and the coordinator with members as none | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| counts a coordinator with no members yet as the one agent it stands for | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| summarises the group's header from its members | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| has no members to settle before the first is reported, and the coordinator's tokens | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders a loop and a goal with the agents, never as shells | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/status/goal-chip.test.ts

B1 independent source: docs/superpowers/specs/2026-09-24-agent-goals-design.md §§4.5,8.2.

B2 credible failures: unsupported goal action offered, provider action queues behind running turn or wrong /goal bytes sent.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: goalActions over status, capabilities and turn/background state.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: adapter tests own honoring an action; this matrix owns what UI offers and sends.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the action matrix — claude × every status × running/idle × background liveness | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the action matrix — codex × every status × running/idle × background liveness | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the action matrix — grok × every status × running/idle × background liveness | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| no goal or no goal support ⇒ no actions | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only the actions an adapter honours are ever offered | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| each action sends exactly the §8.2 text, as the user's message | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/status/status-line.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.6 context meter contract.

B2 credible failures: fabricated percentage/negative remaining or absent data displayed as zero.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: deriveContextMeter over provider token/window fields.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: provider tests cannot own client degradation and percent/remaining arithmetic.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the meter reports a percentage only when a context window is reported | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| without maxTokens there is no ring and no percentage — never a zero | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an adapter that does not report a context window degrades even if a max leaks through | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| usage past the window clamps at 100% and never reports negative remaining | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| no usage frame yet means no meter at all, not a zeroed one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| zero and non-finite extras are dropped rather than shown | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/status/tools-chip.test.ts

B1 independent source: docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §7.6 grants and workflow-owned tools.

B2 credible failures: only tooltip/label copy, punctuation and direct array count changed.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: deriveToolsChip display string model.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: grant availability/revocation and workflow authorization remain in lib/agent-tools/store.test.ts and daemon gate/tool tests.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| no grants: a plain Tools chip saying every tool is available | DELETE | Fails independent-contract/stable-seam bar: directly restates label/tooltip copy and array length; no native control, grant revocation or authorization is exercised. Owner: lib/agent-tools/store.test.ts; daemon MCP/workflow-owned gate tests |
| grants are counted; a workflow-owned chat says it has no Admin tools | DELETE | Fails independent-contract/stable-seam bar: directly restates label/tooltip copy and array length; no native control, grant revocation or authorization is exercised. Owner: lib/agent-tools/store.test.ts; daemon MCP/workflow-owned gate tests |

## packages/ui/src/components/agent-chat/thread-link.render.test.ts

B1 independent source: thread lineage GUI tool target links; old provenance context compatibility.

B2 credible failures: stale result title used, closed target remains clickable, link omitted or marked legacy message attributed to user.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ThreadLink/WorkRow/UserMessageRow rendering.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: primitive target rules and activity-row integration fail independently; old marker fallback is absent from current-header DOM cases.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| the link names the thread by its live tab title, never the result's | REWRITE | retain live/stale title and target behavior, drop tooltip wording. |
| a closed thread's link says so and is no button | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the tool row carries the link beside its label | REWRITE | retain actual activity-row target link integration, drop action label wording. |
| a marked message whose header this build no longer reads is still another chat's, never the user's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/thread-switch.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.1 paint hold/reconnect behavior.

B2 credible failures: wrong thread interactive while loading, own reconnect inert or settled empty thread shows someone else.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: resolveThreadSwitchTimeline/threadSwitchDisplay.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: store tests own snapshots; these own held-paint display flags used by view.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| rows for the named thread always win | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a reconnect on the same thread repaints its own rows, still interactive | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| switching to a thread with no snapshot holds the previous one, inert | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a settled empty thread renders empty rather than someone else's rows | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/anchor.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.2,7.3 restored reading position.

B2 credible failures: drill-in/unpainted list triggers irrelevant parent history read.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: restoreTurnOf eligibility.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: mounted restore tests cover positive paging; this owns no-history/no-row eligibility.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| nothing to page for a drill-in, an unpainted list, or a row of no remembered turn | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/diff-tree.test.ts

B1 independent source: Git unified-diff byte/old-new path formats; docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 changed-files model.

B2 credible failures: wrong file path/patch, lost binary/deletion, polluted count or incorrect aggregate.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: splitUnifiedDiff/countDiffLines/buildDiffTree/summarizeDiffStats.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: standard split, CRLF full metadata/count scenario and malformed/quoted partial forms are distinct; repeated LF metadata probes removed.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| buildDiffTree rolls stats up through every ancestor | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| summarizeDiffStats totals changed lines | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| splitUnifiedDiff yields one entry per file with its own patch text | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a deletion keeps the old path when the new one is /dev/null | CONSOLIDATE | Fails unique-protection bar: same parser and count outputs already asserted together for deletion, binary and ordinary patches in existing CRLF case. Standard LF split/patch bytes remain independently covered. Owner: same file: a CRLF patch splits with clean paths, binary flags and counts |
| a binary file is flagged rather than dropped | CONSOLIDATE | Fails unique-protection bar: same parser and count outputs already asserted together for deletion, binary and ordinary patches in existing CRLF case. Standard LF split/patch bytes remain independently covered. Owner: same file: a CRLF patch splits with clean paths, binary flags and counts |
| a bare patch with no \`diff --git\` preamble is still one file | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a quoted path with spaces is unquoted | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an empty or whitespace diff is no files, not a throw | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a truncated patch still yields the file it started | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| countDiffLines ignores the file headers | CONSOLIDATE | Fails unique-protection bar: same parser and count outputs already asserted together for deletion, binary and ordinary patches in existing CRLF case. Standard LF split/patch bytes remain independently covered. Owner: same file: a CRLF patch splits with clean paths, binary flags and counts |
| a CRLF patch splits with clean paths, binary flags and counts | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/folded-thread-message.dom.test.ts

B1 independent source: docs/superpowers/research/2026-10-22-t3code-gap/10-delta-chat-web.md folded agent messages and docs/superpowers/specs/2026-10-15-unified-orquester-mcp-design.md §8.2 context provenance.

B2 credible failures: message cannot open/find, sender lost, attention hidden or user text spoofed as agent.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: UserMessageRow clicks, beforematch, native aria-expanded/hidden state.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: parser tests do not prove disclosure event wiring or accessible find-in-page retention.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| folds a sent message behind a header naming its sender and first line | CONSOLIDATE | Surviving mounted owner now absorbs whitespace/CRLF summary normalization; actual origin, disclosure, sender and findable body are still asserted. |
| folds a reply message behind a header naming its sender and first line | CONSOLIDATE | Surviving mounted owner now absorbs whitespace/CRLF summary normalization; actual origin, disclosure, sender and findable body are still asserted. |
| folds a opened message behind a header naming its sender and first line | CONSOLIDATE | Surviving mounted owner now absorbs whitespace/CRLF summary normalization; actual origin, disclosure, sender and findable body are still asserted. |
| folds a delegated message behind a header naming its sender and first line | CONSOLIDATE | Surviving mounted owner now absorbs whitespace/CRLF summary normalization; actual origin, disclosure, sender and findable body are still asserted. |
| opens on a click and closes on the next, the body in the bubble | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| opens when find-in-page matches its hidden text | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a request for the user's input keeps its caption over the full bubble | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a merged-back result is never folded | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the user's own message is never folded, even one that types another chat's header | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/follow.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 reduced-motion accessibility.

B2 credible failures: active stream animates despite reduced-motion preference.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: shouldAnimateFollow.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: row/store tests never own animation eligibility preference.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| snaps when the user prefers reduced motion, even mid-turn | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/MarkdownMath.dom.test.ts

B1 independent source: math.ts documented TeX/clipboard/lazy-render contract; CommonMark selection semantics.

B2 credible failures: eager KaTeX download, failed chunk blanks formula, copied selection loses TeX or display copy fails.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ChatMarkdown native DOM copy event/button, loader boundary and clipboard bytes.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: parse/render tests cannot prove browser clipboard events, async source fallback or retry on remount.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| is not loaded for a message without math | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is loaded once the first formula mounts, which shows its source meanwhile | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the source after a failed load and retries on the next mount | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| copies a selection across formulas as markdown with their TeX | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| copies a whole formula's TeX from a selection inside its glyphs | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| leaves a selection without a formula to the browser | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| puts both flavours on the clipboard from the copy event | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| gives display math a Copy TeX button that copies the bare TeX | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/MermaidBlock.dom.test.ts

B1 independent source: docs/superpowers/research/2026-10-22-t3code-gap/10-delta-chat-web.md Pele diagram requirements; MermaidBlock documented fallback/copy/expand contract.

B2 credible failures: missing labels, active malicious link, broken retry/toggle/fallback/expand or leaked blob.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted MermaidBlock with real Pele renderer and native controls.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: SVG sanitizer tests own sanitization; this owns actual loader/render/mount/control composition.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| draws readable diagram labels without active links | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows pele's parse error above the source, with no Retry | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| offers Retry when the renderer fails to load, and draws once it loads | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| toggles between the diagram and its source | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| falls back to the source when drawing throws | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| typesets $$ labels with the chat's KaTeX, as MathML without the TeX annotation | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| expands into the modal as a blob image, and revokes it on close | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/MermaidBlock.test.ts

B1 independent source: docs/superpowers/research/2026-10-22-t3code-gap/10-delta-chat-web.md diagrams and documented settled/streamed fence routing.

B2 credible failures: streamed partial diagram renders early, other fence reclassified or unsupported source disappears.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ChatMarkdown/MermaidBlock public React props and visible code/diagram state.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM component cases start after markdown fence routing; chrome/placeholder duplicates removed.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| shows the diagram's chrome once settled: expand, toggle and a copy button for the source | DELETE | Fails stable-seam/unique-protection bar: SSR cannot mount a diagram and checks control inventory/placeholder copy or incidental loader readiness. Real draw/toggle/retry/expand stays mounted. Owner: timeline/markdown/MermaidBlock.dom.test.ts |
| names a diagram type pele does not know above its source, with no Retry | REWRITE | retain visible unsupported source, no diagram and no Retry; remove fixed error sentence. |
| does not render an empty fence | DELETE | Fails stable-seam/unique-protection bar: SSR cannot mount a diagram and checks control inventory/placeholder copy or incidental loader readiness. Real draw/toggle/retry/expand stays mounted. Owner: timeline/markdown/MermaidBlock.dom.test.ts |
| shows a placeholder | DELETE | Fails stable-seam/unique-protection bar: SSR cannot mount a diagram and checks control inventory/placeholder copy or incidental loader readiness. Real draw/toggle/retry/expand stays mounted. Owner: timeline/markdown/MermaidBlock.dom.test.ts |
| shows a placeholder until the diagram's type has loaded too | DELETE | Fails stable-seam/unique-protection bar: SSR cannot mount a diagram and checks control inventory/placeholder copy or incidental loader readiness. Real draw/toggle/retry/expand stays mounted. Owner: timeline/markdown/MermaidBlock.dom.test.ts |
| hands a settled mermaid fence to the diagram block | REWRITE | assert image semantic state; remove attribute-order/label inventory. |
| keeps a mermaid fence as source while the message streams | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| recognises the fence language case-insensitively | REWRITE | assert image semantic state without fixed accessible wording. |
| leaves other fences on the plain code block | REWRITE | retain source language/data and absent diagram state; remove control-label wording. |

## packages/ui/src/components/agent-chat/timeline/markdown/highlight-core.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 code source preservation and documented 120000-char highlighting fallback.

B2 credible failures: code bytes lost, grammar failure kills message or incremental context colors stay stale.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: highlightCode/incremental highlighter over real JS parser and failing grammar boundary.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: markdown parse tests do not own syntax grammar token/source preservation.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| highlighting preserves source bytes across styled, empty and trailing lines | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an oversized block preserves the source without running the grammar | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a grammar failure preserves the source instead of killing the row | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| an unknown grammar preserves the source | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| syntax context changes reclassify unchanged source lines | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/incremental.test.ts

B1 independent source: CommonMark reference-link/CRLF/BOM byte semantics across streamed updates.

B2 credible failures: late reference definition never resolves or cached prefix corrupts line ending/interior character.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: incremental remark plugin through ReactMarkdown output.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: one-shot markdown tests cannot expose invalidation after earlier render.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a reference in the prefix resolves when its definition arrives later | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a streamed reference resolves a definition before the cached fence | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a streamed CR becoming CRLF preserves text and one line break | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a BOM inside streamed text remains an interior character | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/knowledge-citation.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-10-23-knowledge-graph-plugin-design.md Citations; URL/privacy policy.

B2 credible failures: custom URL navigates externally, unsafe scheme admitted, wrong entry opens or deleted citation stays valid.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: ChatMarkdown URL filter/native citation clicks and knowledge-view/API state.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: knowledge-store unit tests do not prove scheme filtering or browser navigation event behavior.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| keeps a citation link and the usual schemes, and nothing else of the custom scheme | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| refuses every near-citation: case, whitespace, controls, encodings, smuggling, length | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders link text as text and never as HTML, and a citation-shaped image as no image | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders each citation as a chip with its text, not a link | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a click opens the entry in the Knowledge view and does not navigate | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| middle-, ctrl-, meta- and keyboard activation never open a window or navigate | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| asks whether an entry exists on hover, once per entry, and strikes a deleted one through | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| asks again when the entry is deleted from this client | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| is the plain link text while the plugin is off | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/local-image.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.3 host-local markdown image path/file API contract.

B2 credible failures: relative path resolves outside project context, valid host path lost or remote URL rewritten.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: resolveMarkdownImageSource.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: question markdown integration covers one normal relative image, not absolute/query/home/remote resolution.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| joins a project-relative path onto the project root | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps an absolute host path and drops a query or fragment | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| leaves URLs to the browser | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| cannot place a relative path without a project, nor a home-relative one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/math.test.ts

B1 independent source: math.ts/math-tex.ts documented CommonMark/Pandoc/TeX notation and historical quadratic malformed-opener regression.

B2 credible failures: text/code/currency eaten as math, incomplete stream swallowed, unsafe TeX fetch, runaway macro or quadratic rescanning.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: remarkChatMath via real ReactMarkdown rendered prose/formulas and process.cpuUsage; real KaTeX rendering.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: DOM owns clipboard/loading; these own fixed parse/semantic/security examples and public CPU regressions; private consume counters and byte-prefix replay removed.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| "Inline $x^2$ and \\(y_1\\), display $$a+b$$ and \\[c\\]." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$x$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(x\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[x\\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$x$$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "so $$a+b$$ here" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$\n\\frac{a}{b}\n$$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\n\\frac{a}{b}\n\\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Where\n\\[\n\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}\n\\]\nholds." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\nx\n- y\n# z\n\\]\nafter" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\na\n=\nb\n\\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\nx \\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\nx\n   \\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "> $$\n> x\n> $$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "> \\[\n> x\n> \\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "- intro\n\n  $$\n  x^2\n  $$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$x^2\n+y^2$$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Intro\n\n$$ E = mc^2 $$\n\nOutro" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Intro\n\n\\[ E = mc^2 \\]\n\nOutro" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$a$$ is the first formula.\nSome prose.\n$$\nb\n$$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\`\`math\nx^2\n\`\`\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "~~~math\nx^2\n~~~" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\`\`Math\nx^2\n\`\`\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "> \`\`\`math\n> x^2\n> \`\`\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(\\left(x\\right)\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(a \\\\ b\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(\\{x\\}\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(x\n+y\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\\alpha\\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[x_1, x_2\\]" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(1\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Pay \\$$x$ now." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "- [ ] check \\(x\\)\n- [x] then $y$" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "**bold \\(x\\)** and *em $y$*" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "[label \\(x\\)](https://example.com)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\| A \| B \|\n\| --- \| --- \|\n\| \\(x\\) \| $y$ \|" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\| Name \| Value \|\n\| --- \| --- \|\n\| first \| \\(x \|\n\| second \| y\\) \|\n\| valid \| $z$ \|" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "As shown in \\[1\\] and \\[2, 3\\]." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "call f\\(\\) here" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "empty \\( \\) parens" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Escaped \\\\(x\\\\) stays." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(a \`\\)\` b" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "text \\[a\`\\]\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "See [docs](https://example.com/\\(a\\)) here." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Energy \\(E = mc" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$\nx^2" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\[\nx^2\n- y" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$E=mc^2" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\`\`math\nx^2" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\\(x\\)\` and \`$y$\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "    \\(x\\)" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\`\`\n$x$ \\(y\\) \\[z\\]\n\`\`\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "As shown in \\[1\\] and \\[2, 3\\]." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Escaped \\\\(x\\\\) stays." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Escaped \\$x\\$ stays." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\\(a \`\\)\` b" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "call f\\(\\) here" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Energy \\(E = mc" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$$E=mc^2" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Use \`$x$\` in code." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "\`\\(x\\)\` and \`\\[y\\]\`" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the code a code block holds, delimiters and all | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps an unclosed math fence a code block showing its source | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps link destinations with dollars and parentheses intact | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps an adjacent code span whole | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "It costs $5 and then $10." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "It costs $5 and $10." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "price $20,000 or $30,000" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Between $5 and $10 per seat, plus $3.50 tax" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Budget $5-$10 per seat, or $20,000-$30,000 a year." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Plans are $5/$10 monthly." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "We paid $ 5 and $ 10" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Run $browser then $deploy on it." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "Set $HOME before running." | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "$5" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| "just a lone $ sign" | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps prices as prose when real math follows on the same line | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| still finds real math next to currency | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the lists and quotes after an unclosed $$ or \[ as they are | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| does not split the paragraph above an unclosed block | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| does not let a \`\]\` ending a later line of prose close a block | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| parses every prefix of a streamed message without throwing | DELETE | Fails unique-protection bar: reparses every ordinary character prefix of one sample; independent delimiter/unfinished-stream cases already verify returned content and structure. Owner: same file delimiter, unclosed block, incremental cache and streaming source tests |
| composes with the incremental fence cache | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| 1,000 unclosed \( in one paragraph | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 unclosed \[ in one paragraph | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 600 alternating unclosed \( and \[ | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 openers before one backtick | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 citations before one closer | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 unclosed $ in one paragraph | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 lines of \[ | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| 1,000 lines of $$ | CONSOLIDATE | Private tokenize/effects counter fails stable seam/refactor bar and misses block source-lookahead work; replaced by two public parse/render owners with literal output plus measured CPU budget. Historical inline-cache and block-index mutants are validated separately. Owner: math.test.ts: unclosed inline/block delimiters literal, later formula, CPU budget |
| still finds the formula after a run of unclosed openers | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| typesets every delimiter, inline and display | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps formulas reachable by keyboard | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows a formula KaTeX cannot parse as its source, not an error | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| refuses links and remote loads from inside a formula (trust: false) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never turns provider HTML into elements | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows a streaming math fence as code until it closes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps an unclosed display block and the prose after it readable while streaming | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| renders math in a control's inline markdown without a tab stop or a button | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| clamps user-specified lengths (\rule) to maxSize | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| bounds macro expansion (maxExpand) | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| still reads 'the $n$th term' as math, which is why the rules stop at digits | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/mermaid-engine.test.ts

B1 independent source: Mermaid label MathML contract and KaTeX untrusted input policy.

B2 credible failures: malformed label renders error, duplicate TeX annotation or link survives label typesetting.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: loadMathResolver with real KaTeX and DOM.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: plain markdown math never uses this resolver/MathML export path.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| leaves invalid math labels unresolved and refuses links in labels | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/markdown/mermaid-svg.test.ts

B1 independent source: SVG/MathML security allowlists and standalone XML image contract.

B2 credible failures: script/remote references survive, math labels destroyed or expanded XML invalid/loses resolved colors.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: createDiagramSanitizers/standaloneSvg with real DOMPurify/DOMParser.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: mounted diagram cases sample one real drawing, not hostile SVG profiles or standalone XML serialization.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| keeps a pele diagram intact: shapes, label text, CSS variables | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops script, handlers, links, images, styles and every reference attribute | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops foreignObject entirely, HTML or MathML inside it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps KaTeX's MathML and its presentation attributes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops what KaTeX never emits: annotations, glyph images, links and unknown attributes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| drops the same hostile markup as the plain profile, HTML inside the label included | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| fixes the size from the viewBox, sets an opaque background and leaves the mounted SVG alone | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| writes the page's resolved --pele-* colours onto the copy, which an image cannot inherit | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps labels with entities and MathML well-formed | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/plan-reader.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§5.6,7.3,7.4 complete-plan-before-Implement requirement.

B2 credible failures: truncated plan returned as complete when store unavailable.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: readPlanWithoutStore.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: send tests inject reader failure; this owns actual no-store fallback reader behavior.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| with no thread store, a truncated plan rejects rather than returning partial markdown | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/quote-selection.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §7.4 selected agent passages and CommonMark quoting.

B2 credible failures: wrong sender/text selected, code/table/math serialization lost or quote action unavailable.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: DOM Selection/Range-to-markdown and QuoteSelectionToolbar native events.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: composer quote tests begin with markdown passage and cannot protect DOM selection/extraction/events.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| one inside a single agent reply, naming that reply | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| not one in a user message, a tool row, or across two replies | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a triple click that runs to the start of the next row: trimmed to what it selects | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| not one of only unselectable chrome, nor a collapsed one | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| not one outside the timeline it watches | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| rebuilds the structure: emphasis, code, links, headings, lists, code blocks, quotes, tables, math | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the part of a paragraph it selects, no more | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| quotes lines of a code block as a fenced block in its language | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| quotes a part of one code line as inline code | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| leaves the code block's header out when the selection starts in it | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| joins a paragraph and the code after it as two blocks | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| shows over a settled selection in a reply, and Quote hands its markdown to the composer | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goes on Escape, and on a collapse | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| goes on a press elsewhere, and on a scroll of the timeline | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| follows a keyboard selection once it settles | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| never shows for a user message, nor where no composer takes quotes | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/row-chrome.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§4.6.5,4.6.7,5.6,7.3 stable toolCallId/stream bytes.

B2 credible failures: command output lost or borrowed across calls, skill bytes altered or ordinary prompt mistaken for /compact.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: joinLifecycleDetails/splitSkillMentions/isCompactCommandMessage.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: projection tests own mapping events to entries; these own group-local joins and final sent-text splitting.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a \`/compact\` user message is recognised at render time | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| only a bare \`/compact\` from the user, with no attachments, is the command | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| idle compaction's own \`/compact\` is labelled automatic; any other is the user's | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the concatenated runs always reproduce the input exactly | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a sent \`$plugin:skill\` mention, dotted plugin name included, is one chip | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| a fileChange approval with no diff borrows it from its own item.started | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| several orphan chunks of one call join into ONE row: the first carries all their text, nothing lost | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the row a command's streamed output joins onto says the call streamed, however its rows were built | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the join never overwrites a value the row already has | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| the join is keyed on toolCallId only — never on a label match | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## packages/ui/src/components/agent-chat/timeline/row-format.test.ts

B1 independent source: docs/superpowers/research/2026-10-22-t3code-gap/10-delta-chat-web.md first nonempty folded-message summary.

B2 credible failures: standalone summary formatting changes.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: foldedMessageSummary.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: folded-thread-message.dom.test.ts now supplies whitespace/CRLF input to actual rendered fold header.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a folded message shows its first line with text, whitespace collapsed | CONSOLIDATE | Fails unique-protection bar: whitespace/CRLF normalization now runs through existing mounted fold header scenarios. Owner: timeline/folded-thread-message.dom.test.ts four origin cases |
| a message with no text has no line | DELETE | Fails independent-contract/credible-failure bar: empty string formatter result only; no distinct navigation/content behavior; mounted fold cases retain real nonempty content. |

## packages/ui/src/components/agent-chat/timeline/scroll-restore.dom.test.ts

B1 independent source: docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md §§7.2,7.3 cold/partial-window reading restoration regression.

B2 credible failures: restore fires before rows, pages wrong turn or re-restores on every update.

B3 independent oracle: literal expected data/native state for each named scenario; no production-derived expected algorithm.

B4 stable seam: mounted ChatTimeline with real stream store and revealTurn action boundary.

B5 refactor resistance: assertions retained for semantic data, actions, compatibility or safety; source identifiers, component decomposition and incidental class trees may change.

B6 unique protection: anchor helper tests cover eligibility only, not mount/effect/store projection handoff.

Risk: low for deleted incidental copy; medium for state/persistence/security changes, checked through V and owning integration cases. Validation: V for this file.

| Original test name | Disposition | Reason / surviving owner |
| --- | --- | --- |
| a cold open waits for its rows, then pages in a turn the window does not hold | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| pages in a turn shown only by a row kept out of it, without its prompt | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |
| keeps the pixel offset for a turn the window shows with its prompt | KEEP | Fixed input/output or event sequence named by this case detects a distinct failure within the file contract; shared six-bar evidence below applies. |

## Executable check scenarios

These scripts are included in the required UI package gate and remain executable checks; they are not silently excluded or counted as node test declarations.

### packages/ui/src/components/agent-chat/banners/banner-render.check.ts

KEEP: independent sources are GUI §§7.4–7.6 and MCP secret/provenance rules. Actual component/server-render and real stream/store boundaries observe fixed data and native disabled/password semantics, independent from implementation. Refactors may change markup/classes while preserving these semantic states. Lower pure models cannot prove component wiring to those states. V check command applies.

- KEEP: posting a decision disables approval controls.
- KEEP: posting an answer disables question controls.
- KEEP: provider warning/option data reach accessible approval controls.
- KEEP: provider reason shown only when supplied.
- KEEP: subagent provenance is visible.
- KEEP: blocking callback cannot dismiss; message-mode request may dismiss.
- KEEP: compact secret answer remains masked.
- KEEP: request_secret shows source/purpose/provider privacy boundary and masked nonremembered field.
- KEEP: secret requests remain behind questions and require an answer path.

### packages/ui/src/components/agent-chat/composer/composer-send-render.check.ts

KEEP: independent sources are GUI §§7.4–7.6 and MCP secret/provenance rules. Actual component/server-render and real stream/store boundaries observe fixed data and native disabled/password semantics, independent from implementation. Refactors may change markup/classes while preserving these semantic states. Lower pure models cannot prove component wiring to those states. V check command applies.

- KEEP: a remounted composer disables send/rewind for its thread in flight only.
- KEEP: settling enables send/rewind again.
- KEEP: approval redirect keeps composer usable and names its effect.
- KEEP: question answer hint differs; legacy pending flag promises no unknown action.

### packages/ui/src/components/agent-chat/roster/drill-in-render.check.ts

KEEP: independent sources are GUI §§7.4–7.6 and MCP secret/provenance rules. Actual component/server-render and real stream/store boundaries observe fixed data and native disabled/password semantics, independent from implementation. Refactors may change markup/classes while preserving these semantic states. Lower pure models cannot prove component wiring to those states. V check command applies.

- KEEP: seeded background shell command/output immediately visible.
- KEEP: omitted agent starts loading then shows its own delivered rows.
- KEEP: reconnect retains visible agent rows until refreshed frame.
- KEEP: truncated frame renders warning rather than claiming whole history.

## Replacement regression owners

Both REWRITE owners exercise the public markdown parse/render seam with fixed malformed inputs and literal independently expected prose/formula results. Process CPU measures actual work, including block-source lookahead; internal tokenizer shape and dependency decomposition are unconstrained. These uniquely catch historical malformed-input DoS algorithms that smaller semantic parse examples cannot. The CPU limit was calibrated with large baseline headroom and both restored historical algorithms; source mutations exist only in external validation loaders.

- REWRITE: keeps unclosed inline delimiters literal and renders the later formula within the CPU budget. Public parser output must contain all literal inline-openers and the later formula, under a measured generous CPU ceiling; cache-loss mutation detects the historical quadratic algorithm.
- REWRITE: keeps unclosed block delimiters literal and renders the later formula within the CPU budget. Public parser output must contain all literal block-openers and the later formula, under a measured generous CPU ceiling; repeated-index-build mutation detects work outside tokenizer callbacks.

## Performance and validation record

Eight implementation-coupled tokenizer-consume counters were consolidated into two real public markdown parse/render regressions. Literal prose and later-formula output must survive 5,000 inline openers or 16,000 block lines, within a generous measured 5,000 ms of process CPU; no private counter or source mutation runs in the required suite. Calibration measured safe CPU 348/911 ms versus historical failed-scan/index-rebuild mutants 11,598/18,079 ms; actual focused/mutation gates are recorded below. Real diagram rendering, security sanitization, real outbox page reloads and storage ownership tests remain because cheaper seams cannot verify their distinct integration failures. Focused validation and mutation results follow; whole-repository timing/gates belong to the root report.


## Completed cleanup and focused validation

- Original scope: 537 declarations / 618 expanded runtime cases, plus three executable check scripts.
- Original-case dispositions: 560 KEEP, 15 REWRITE, 31 CONSOLIDATE (23 removed executions and eight surviving owners), 12 DELETE. Two replacement REWRITE regression owners replace the eight old complexity-counter executions; final scope has 511 declarations / 585 runtime cases. Net reduction: 26 declarations and 33 runtime cases.
- Test/check diff: 67 lines added, 396 removed, net **-329 test lines**. Production diff: four lines added, five removed, all export narrowing or stale test-reference commentary. Audit documentation is excluded from these source metrics.
- No snapshot, fixture, dependency or test configuration became unused. Removed the private tokenizer-work counter helper; no test-only production loader/hook was introduced.
- `git diff --check -- packages/ui/src/components/agent-chat docs/testing-audit/ui-chat-components.md docs/testing-audit/ui-chat-components.json` passed.

From `packages/ui`, with `TSX_DISABLE_CACHE=1`, focused validation ran:

```sh
node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4 \
  src/components/agent-chat/banners/QuestionCard.dom.test.ts \
  src/components/agent-chat/banners/ToolApprovalCard.dom.test.ts \
  src/components/agent-chat/banners/banner-model.test.ts \
  src/components/agent-chat/banners/tool-approval.render.test.ts \
  src/components/agent-chat/composer/composer-draft.test.ts \
  src/components/agent-chat/composer/composer-failed-send.test.ts \
  src/components/agent-chat/composer/composer-quotes.test.ts \
  src/components/agent-chat/lineage.render.test.ts \
  src/components/agent-chat/thread-link.render.test.ts \
  src/components/agent-chat/timeline/diff-tree.test.ts \
  src/components/agent-chat/timeline/folded-thread-message.dom.test.ts \
  src/components/agent-chat/timeline/markdown/MermaidBlock.test.ts \
  src/components/agent-chat/timeline/markdown/math.test.ts
node --import tsx --import ./test/svg-loader.mjs src/components/agent-chat/banners/banner-render.check.ts
```

Result: **221 tests passed, zero failures/cancellations/skips/TODOs**, 11.612 seconds wall for the focused run. The executable banner check passed in 2.409 seconds. Logs: `/tmp/orquester-test-audit/ui-chat-focused.log`, `ui-chat-banner-check.log`; exact argv and process exit codes are in `ui-chat-focused-results.json` beside them. An initial command invoked UI-relative paths from repository root and exited before running tests; rerunning from the required package directory corrected the invocation.

Public performance regression validation used this additional command from `packages/ui`:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-name-pattern='CPU budget' src/components/agent-chat/timeline/markdown/math.test.ts
```

Both cases passed, 3.047 seconds for the file including import/setup. Inline/block parse wall times were 156/447 ms in this filtered run and 1000/375 ms in the concurrent focused run. That variance is recorded rather than treated as a speedup; both passed the process-CPU ceiling. Calibration probes measured 348/911 ms CPU for the actual inline/block inputs, versus 11,598/18,079 ms with the historical algorithms restored.

Two external ESM loaders (only under `/tmp/orquester-test-audit`) restored the historical algorithms without editing source or shipping mutation hooks:

- `ORQUESTER_AUDIT_MUTATION=failed-scan`: make the cached failed inline scan unavailable, preserving parse results but rescanning each suffix. The actual retained inline test failed for the intended **16,260 ms CPU > 5,000 ms** reason.
- `ORQUESTER_AUDIT_MUTATION=block-index`: create a fresh closing-line index per opener, preserving parse results but rebuilding the source index repeatedly. The actual retained block test failed for the intended **19,148 ms CPU > 5,000 ms** reason. This is the work that the removed tokenizer-consume counters could not observe.

The mutant commands added `--import /tmp/orquester-test-audit/math-mutate.mjs` and filtered respectively on `unclosed inline.*CPU budget` / `unclosed block.*CPU budget`; their `TSX_DISABLE_CACHE=1` environment also set the mutation value above. Both exited nonzero with the expected assertion, with semantic output confirmed unchanged by the calibration probes. Logs: `math-public-safe.log`, `math-public-inline-mutant.log`, `math-public-block-mutant.log`. No source mutation or runtime environment setting remains in the checkout.

Whole-repository typechecks, full required tests/build, baseline failures, final suite wall time and Git delivery are intentionally reported by the root integration report; this scoped ledger does not claim those gates ran from this agent.
