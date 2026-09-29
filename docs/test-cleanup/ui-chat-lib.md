# UI agent-chat library test cleanup

Completed cleanup: **481 original test declarations: 46 DELETE, 32 REWRITE, 403 KEEP**. The parameterized Grok declaration represents two runtime cases, so 47 runtime tests were deleted. Scoped source/test LOC changed by **+111 / −884 (net −773)**. This is a completed-cleanup ledger after implementation and validation; the disposition rows below were recorded before edits. Scope excludes `history.logic.test.ts` and `store.history.test.ts`, delegated to `ui-chat-history-current.md`. Original declaration inventory is preserved in these rows; a parameterized declaration represents both runtime cases.

Read root AGENTS.md, README.md, root/package scripts, all scoped tests and production owners. Baseline: 567 runtime tests passed across the entire original agent-chat library, including the separately delegated history tests.

Independent sources: [agent chat GUI specification](../superpowers/specs/2026-09-21-agent-chat-gui-design.md) and [agent goals specification](../superpowers/specs/2026-09-24-agent-goals-design.md); AGENTS.md storage/protocol constraints. Exact section references accompany each file. Existing captured provider fields and explicitly described historical failures provide regression provenance where the specification describes only the user behavior.

Shared six-bar interpretation: each retained row states its independently specified failure in the contract column. B1 uses the cited requirement or concrete regression; B2 that contract is user/caller visible; B3 expected literal values or explicit protocol fixtures are independent of the owner implementation; B4 the named production entry point is the seam; B5 assertions observe returned state/data/actions, so internal rewrites can preserve them; B6 this seam owns the stated policy or lifecycle transition and no remaining lower test covers that transition. Fixture generators supply inputs, never compute expected behavior. KEEP/REWRITE rows below apply all six items; DELETE rows identify the stronger remaining owner or absence of a behavioral contract.

Validation for each row: run the package node test command with its path (shown below). Risk for deletes is low because the stated stronger owner remains; retained storage/protocol/regression cases carry medium consequence if removed. Production callers are listed per file; no fixture or helper shared with the component/history scopes is removed without caller search.

`cd packages/ui && pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/agent-chat/<file>`

## packages/ui/src/lib/agent-chat/account-switch.test.ts

B1 independent source: GUI §3.4 account-family, migration and reauthentication rules. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: account-switch public policy; AgentChatView/ChatComposer. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `account-switch.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `goals §5.7: a goal a deploy HELD is continuing — paused or not, whatever the session says` (L210) | Retain held-goal continuing/account-switch gating. Remove equality to the imported refusal-message constant: declaration-against-itself and incidental copy add no contract. B1–B6 use the file rationale; this is the lowest owner of the stated policy. |
| REWRITE | `goals §5.7: held without a continuing verdict still closes the chip, as the host refuses it` (L241) | Retain the missing-support/held-goal gate; remove imported-copy equality while the meaningful refusal policy remains independently asserted. B1–B6 use the file rationale; this is the lowest owner of the stated policy. |

## packages/ui/src/lib/agent-chat/agent-prompt.logic.test.ts

B1 independent source: GUI §7.6 drill-in launch prompts, provider event ownership and truncated full-read metadata. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: agent-prompt projection; drill-in.logic/full-output. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `agent-prompt.logic.test.ts`.

## packages/ui/src/lib/agent-chat/codex-child-rows.test.ts

B1 independent source: GUI §7.6 child isolation plus Codex namespace fixture regression. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: entries projection and lifecycle join; timeline/drill-in. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `codex-child-rows.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `never lists the child itself as a spawn row: its task rows are stamped with its own id` (L127) | Duplicates generic stamped-task ownership using another provider label. Remaining: entries.logic OpenCode own-call/no-self-spawn and parent-spawn cases |
| DELETE | `the parent's timeline keeps the child's spawn row` (L137) | Duplicates generic stamped-task ownership using another provider label. Remaining: entries.logic OpenCode own-call/no-self-spawn and parent-spawn cases |

## packages/ui/src/lib/agent-chat/composer.logic.test.ts

B1 independent source: AGENTS field-wise localStorage validation; GUI §7.4 per-thread drafts. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: composer draft persistence; store/ChatComposer. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `composer.logic.test.ts`.

## packages/ui/src/lib/agent-chat/drill-in.logic.test.ts

B1 independent source: GUI §7.6 child drill-in ownership, live run/disclosure and relaunch timing requirements. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: projectAgentDrillIn; AgentDrillIn. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `drill-in.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `keeps the child's own rows only, and every unchanged row object across a re-derivation` (L142) | Rename stale identity-oriented title; keep observable agent ownership and owner-switch result only. Remaining: entries owns generic filtering; drill-in owns selected agent transitions |
| REWRITE | `the parent's fold is its settled turn's own 9 s; the agent's drill-in keeps its rows' span` (L219) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `each token moves the label of the fold the thought ends, and consecutive tokens keep the fast path` (L301) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `once the thought settles, its fold closes on its final duration` (L312) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `a background agent whose first rows rode no turn: a later turn's fold is its own rows' span` (L702) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `a relaunch followed by a turnless row: the next turn's fold is its own rows' span` (L715) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `and so while the agent is live on a third run: the earlier runs' folds keep their own spans` (L728) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `rows right after the prompt, on its launch turn: their fold is timed from the prompt` (L751) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `the thread's own timeline is unchanged: its prompt still times a turn whose first rows rode none` (L756) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| REWRITE | `each run folds and is timed on its own, under its own prompt` (L822) | Assert elapsed seconds represented by fold labels rather than exact prose/formatting; keep per-run timing and disclosure contract. Remaining: rows owns generic turn timing; drill-in owns prompt/run boundaries and roster context |
| DELETE | `the walk means what it says: the labels move with the tokens, a collapse closes run 1, the third run folds on its own` (L997) | Long scripted walk repeats timing/collapse cases and computes unused fresh projections; oracle adds no distinct failure. Remaining: drill-in focused token timing, per-launch folds, collapse isolation and third-run tests |

## packages/ui/src/lib/agent-chat/entries.logic.test.ts

B1 independent source: GUI §5.6 slim payload and §7.3/7.6 ownership/output/plan/goal timeline contracts. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: workLogEntryFromActivity/deriveTimelineEntriesFromItems; store/history/drill-in. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `entries.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `shows Grok command output instead of repeating its command` (L46) | Repeats shared API command output extraction through a re-export. Remaining: packages/api/src/agent-chat/command-output.test.ts extraction and wire cases |
| DELETE | `shows ACP output after the wire projection used by live snapshots` (L79) | Repeats shared API command output extraction through a re-export. Remaining: packages/api/src/agent-chat/command-output.test.ts extraction and wire cases |
| DELETE | `keeps provider output in detail when it is already the fuller answer` (L94) | Repeats shared API command output extraction through a re-export. Remaining: packages/api/src/agent-chat/command-output.test.ts extraction and wire cases |
| DELETE | `carries the compaction token counts for client-side formatting` (L128) | Duplicates shared compaction parsing or pass-through fields already observed in final marker rows. Remaining: API compaction tests; rows.logic token counts, summary, running/failed/legacy marker cases |
| DELETE | `carries the compaction summary, which is all that survives of what it dropped` (L139) | Duplicates shared compaction parsing or pass-through fields already observed in final marker rows. Remaining: API compaction tests; rows.logic token counts, summary, running/failed/legacy marker cases |
| DELETE | `carries the compaction PHASE, so the in-flight marker is not a divider` (L158) | Duplicates shared compaction parsing or pass-through fields already observed in final marker rows. Remaining: API compaction tests; rows.logic token counts, summary, running/failed/legacy marker cases |
| DELETE | `reads an old marker with no state as `compacted` — the only thing old logs hold` (L201) | Duplicates shared compaction parsing or pass-through fields already observed in final marker rows. Remaining: API compaction tests; rows.logic token counts, summary, running/failed/legacy marker cases |
| DELETE | `treats a tool row owned by an agent as internal` (L220) | Private classification/count assertions duplicate positive owner-filtered timeline output. Remaining: entries.logic own/parent call and assistant ownership cases |
| DELETE | `keeps an agent task row visible so it can anchor a spawn row` (L228) | Private classification/count assertions duplicate positive owner-filtered timeline output. Remaining: entries.logic own/parent call and assistant ownership cases |
| DELETE | `drops agentId-stamped messages from the parent timeline` (L238) | Private classification/count assertions duplicate positive owner-filtered timeline output. Remaining: entries.logic own/parent call and assistant ownership cases |
| DELETE | `hides a launch tool row once its task row replaces it` (L307) | Generic launch success/failure duplicates realistic Grok lifecycle fixtures at the same owner. Remaining: grok-spawn-rows launch suppression and failed-launch retention cases |
| DELETE | `keeps a failed launch visible — the only terminal signal must not vanish` (L320) | Generic launch success/failure duplicates realistic Grok lifecycle fixtures at the same owner. Remaining: grok-spawn-rows launch suppression and failed-launch retention cases |
| DELETE | `recognises both spellings` (L633) | Duplicates shared compaction parsing or pass-through fields already observed in final marker rows. Remaining: API compaction tests; rows.logic token counts, summary, running/failed/legacy marker cases |
| DELETE | `a goal update is a marker entry carrying its change, under the row's own summary` (L893) | Pass-through goal fields repeat the final visible marker projection contract. Remaining: rows.logic goal marker objective/change and ended-goal statistics cases |
| DELETE | `an ended goal's marker carries what it cost, read off the goal that ended` (L902) | Pass-through goal fields repeat the final visible marker projection contract. Remaining: rows.logic goal marker objective/change and ended-goal statistics cases |
| DELETE | `drops the turn's last message when it repeats the turn's opening one, word for word` (L975) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |
| DELETE | `keeps the same words in another turn, and a repeat that is still streaming` (L990) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |
| DELETE | `drops only a copy of the turn's OPENING message, at its end: a goal run's rounds may end on the same words` (L1002) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |
| DELETE | `a repeat of the opening that is not the turn's last message is the agent's own words, and stays` (L1019) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |
| DELETE | `leaves every other provider's repeats alone: only a Claude log holds re-emitted copies` (L1037) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |
| DELETE | `compares one author's messages only: a subagent saying the parent's words is not a copy` (L1061) | Duplicates API re-emission policy; UI cache opt-in and rendered-answer integration remain. Remaining: API re-emitted.test.ts; entries repair-option transition; rows terminal-answer regression; store adapter opt-in |

## packages/ui/src/lib/agent-chat/full-output.test.ts

B1 independent source: GUI §5.6 full output vs retained cuts; abort ownership; launch prompt reads. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: readFullOutput/fullOutputText/createViewerReads; timeline viewer. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `full-output.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `a command whose output streamed offers it whether or not its own payload was cut, and reads the join` (L65) | Affordance discriminator duplicated by successful full-output reads and the cut-item-only read. Remaining: full-output join/cut-item integration cases |
| DELETE | `a row whose payload the wire cut offers its item; a plain one offers nothing` (L73) | Affordance discriminator duplicated by successful full-output reads and the cut-item-only read. Remaining: full-output join/cut-item integration cases |
| REWRITE | `an update stored cut reads the join too, then (nothing streamed) its payload, never its preview` (L252) | Remove duplicate serialization oracle; retain join/item fallback and request order. The generic cut-item text case independently protects JSON fallback. B1–B6 use the file rationale; the observable behavior is preserved across implementation refactors. |
| DELETE | `reads the call's join first: every line the command printed, and where the whole was saved` (L295) | OpenCode label does not change join-first transport behavior; stub supplies entire asserted output. Remaining: full-output early-window-eviction join-first case; separate OpenCode kept-tail fallback |
| DELETE | `a command's output as the command printed it, where its own data carries it: a Codex completion's` (L317) | Direct provider extraction repeats the shared storedCommandOutput owner. Remaining: API command-output.test.ts whole Codex and Claude extraction cases |
| DELETE | `and a Claude Bash call's, its result's text` (L343) | Direct provider extraction repeats the shared storedCommandOutput owner. Remaining: API command-output.test.ts whole Codex and Claude extraction cases |
| REWRITE | `never out of an item stored cut: its data holds only a head, so the payload shows, as JSON` (L363) | Assert decoded data content independently instead of building the expected JSON with the implementation serialization expression. Remaining: Shared API owns command extraction; viewer owns generic payload fallback |
| REWRITE | `anything else as the viewer always showed it: a message's text, a string payload, JSON, else the summary` (L378) | Assert decoded data content independently instead of building the expected JSON with the implementation serialization expression. Remaining: Shared API owns command extraction; viewer owns generic payload fallback |
| REWRITE | `a start with no prompt is its payload, as before` (L426) | Assert decoded literal task metadata rather than serializing the input as the expected string. B1–B6 use the file rationale; the observable behavior is preserved across implementation refactors. |

## packages/ui/src/lib/agent-chat/goal.logic.test.ts

B1 independent source: goals design §4.4, §5.7, §8, §9 additive goal state/hold compatibility and Unicode integrity. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: goal display/hold policy; AgentChatView and goal controls. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `goal.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `clips with an ellipsis inside the cap, and leaves a short text alone` (L44) | Exact ellipsis/cap presentation check; no independent objective-data contract. Remaining: Unicode surrogate-pair integrity case remains |

## packages/ui/src/lib/agent-chat/grok-spawn-rows.test.ts

B1 independent source: GUI §7.6 launch replacement, sole failure visibility and background lifecycle deduplication. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: entries projection; timeline/drill-in. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `grok-spawn-rows.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | ``never lists the agent itself as a spawn row (${end})`` (L148) | Negative-only projection allows an entirely empty result to pass; no independent positive ownership contract. Remaining: entries.logic positive own-call/no-self-spawn and codex child output case |

## packages/ui/src/lib/agent-chat/hooks.logic.test.ts

B1 independent source: GUI §5.1/§7.6 settled-session timer; credible late turn-completed/reload regression. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: turnStartedAt; useAgentChatStatus. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `hooks.logic.test.ts`.

## packages/ui/src/lib/agent-chat/keybindings.logic.test.ts

B1 independent source: GUI §7.4 and §7.7 keyboard command precedence and focus behavior. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: resolveChatShortcut; ChatComposer/ChatTimeline. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `keybindings.logic.test.ts`.

## packages/ui/src/lib/agent-chat/plan.logic.test.ts

B1 independent source: GUI §7.3/§7.4 plan fallback, implementation/refinement and download filename contracts. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: plan policy; store/PlanCard/ChatComposer. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `plan.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `implements with an empty draft and leaves plan mode` (L75) | Remove expected prefix derived from the production constant; keep mode transition and independently literal plan command. Remaining: Composer submission tests own send routing; this seam owns plan-to-command policy |
| DELETE | `is an intact plan's own markdown, answered at once with nothing read` (L152) | Pass-through reader stub returns/rejects exactly what the wrapper forwards; no independently observed plan retrieval. Remaining: store.fixwave full-plan read and error cases; plan-reader component gesture tests |
| DELETE | `reads a plan the wire cut (§5.6) back whole, by its proposal id` (L160) | Pass-through reader stub returns/rejects exactly what the wrapper forwards; no independently observed plan retrieval. Remaining: store.fixwave full-plan read and error cases; plan-reader component gesture tests |
| DELETE | `fails rather than ever hand over the cut text` (L169) | Pass-through reader stub returns/rejects exactly what the wrapper forwards; no independently observed plan retrieval. Remaining: store.fixwave full-plan read and error cases; plan-reader component gesture tests |

## packages/ui/src/lib/agent-chat/presentation.logic.test.ts

B1 independent source: GUI §7.3 output grouping, explicit failure/denial and nested tool consequence visibility. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: presentation policy; rows/row-chrome/WorkEntry. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `presentation.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `buckets by the promoted fields alone — nothing branches on the provider` (L31) | Classification branch inventory; grouping policy is observed in actual timeline rows. Remaining: rows.logic tool grouping, answered-question hoisting and activity group cases |
| DELETE | `folds an approval into the update bucket — approvals are never hoisted` (L45) | Classification branch inventory; grouping policy is observed in actual timeline rows. Remaining: rows.logic tool grouping, answered-question hoisting and activity group cases |
| DELETE | `isStreamedOutputEntry names a tool.output chunk, and nothing else` (L72) | Helper discriminator/export or exact label checks duplicate the row consumer. Remaining: rows.logic live/chunk grouping; entries chunk command/title mapping |
| DELETE | `a chunk's row is headed like its call's own row — its command, else its title — else "Tool output", never its text` (L105) | Helper discriminator/export or exact label checks duplicate the row consumer. Remaining: rows.logic live/chunk grouping; entries chunk command/title mapping |
| DELETE | `buckets an answered question as an update, not as a tool call` (L149) | Classification branch inventory; grouping policy is observed in actual timeline rows. Remaining: rows.logic tool grouping, answered-question hoisting and activity group cases |
| DELETE | `exposes the live-row predicate the activity group needs` (L160) | Helper discriminator/export or exact label checks duplicate the row consumer. Remaining: rows.logic live/chunk grouping; entries chunk command/title mapping |

## packages/ui/src/lib/agent-chat/providers.test.ts

B1 independent source: GUI §6.3 provider snapshots, refresh/invalidation and retry/reauth API contract. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: providersStore; app, hooks and account controls. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `providers.test.ts`.

## packages/ui/src/lib/agent-chat/questions.logic.test.ts

B1 independent source: GUI §7.5 structured answer protocol, validation and stale-field migration. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: question answer builder; question banner. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `questions.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `typing clears the selection` (L121) | Retain mutual exclusion while positively asserting the typed answer survives; a setter returning an empty object must fail. B1–B6 use the file rationale; this is the lowest owner of the stated policy. |

## packages/ui/src/lib/agent-chat/queue.logic.test.ts

B1 independent source: GUI §7.4/§6.6 FIFO, held sends, tool boundaries and idempotent drain cancellation. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: queue policy; store queue driver. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `queue.logic.test.ts`.

## packages/ui/src/lib/agent-chat/reducer.logic.test.ts

B1 independent source: GUI §6.3 snapshot/event sequencing and resync; goals §9 tolerant additive state. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: applyFrame reducer; store stream handler. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `reducer.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `adopts the snapshot's goal, validated, and reads a missing one as none (goals §4.4)` (L45) | REWRITE: keep snapshot adoption, old-host absence and one malformed goal to verify validation is invoked; delete invalid-field matrix and normalization assertions owned by the API goal schema. B1–B6 use the file rationale; explicit fixture outcomes can disagree with the implementation. |

## packages/ui/src/lib/agent-chat/retention.test.ts

B1 independent source: GUI §7.2 bounded retained thread snapshots and oldest eviction. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: ThreadRetentionCache; store lifecycle. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `retention.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `evicts the oldest retention past the cap` (L6) | Exact private 24-entry tuning value has no independent requirement: GUI §7.2 specifies TTL, ownership, resume and persisted-position cap, but never this cache count. A valid cache-tuning refactor breaks it. Remaining: store.retention covers TTL expiry, generation ownership, retained rows/cursor and queue state. |

## packages/ui/src/lib/agent-chat/rewind.logic.test.ts

B1 independent source: GUI §5.5/§7.3 rewind targets, started turns and compaction barriers. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: rewind policy; AgentChatView. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `rewind.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `completes on the second press inside the window and then starts over` (L94) | Exercise the production default clock window instead of a test-only configurable value; explicit 1000/1400/1500/1900 ms inputs retain double-press/reset policy. B1–B6 use the file rationale; the observable behavior is preserved across implementation refactors. |
| REWRITE | `a press outside the window is a first press` (L103) | Use the independently specified 600 ms window and literal timestamps; remove expected timings derived from an imported implementation constant. B1–B6 use the file rationale; the observable behavior is preserved across implementation refactors. |
| REWRITE | `reset forgets the first press` (L110) | Exercise the production default sequence; remove the test-only window parameter. B1–B6 use the file rationale; the observable behavior is preserved across implementation refactors. |

## packages/ui/src/lib/agent-chat/roster.logic.test.ts

B1 independent source: GUI §7.6 roster source/liveness/background exemption and shell routing. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: roster policy; roster dock/banner/drill-in. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `roster.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `says 'Kicked off' while live and 'Ran' once settled` (L69) | Only exact present/past-tense copy; no data or navigation failure. Remaining: roster live/settled activity source selection remains |
| DELETE | `names the live task ids the live activity row reads` (L101) | Enumerates live-id helper output already consumed by nested live spawn rows. Remaining: drill-in nested live batch case; roster coordinator liveness case |

## packages/ui/src/lib/agent-chat/rows.logic.test.ts

B1 independent source: GUI §7.3 visible timeline, rewind/compaction/grouping; goals §8; credible live/settled and late-row regressions. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: deriveTimelineRows and state projection; store/drill-in/history. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `rows.logic.test.ts`.

## packages/ui/src/lib/agent-chat/status.logic.test.ts

B1 independent source: GUI §7.6 context usage and compaction status, authoritative session settlement. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: status policy; store/hooks/status line. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `status.logic.test.ts`.

## packages/ui/src/lib/agent-chat/store.fixwave.test.ts

B1 independent source: GUI §6.3/§7.3 reconnect, full-plan reads and state retention regressions. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: thread store actions/state; hooks/AgentChatView. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `store.fixwave.test.ts`.

## packages/ui/src/lib/agent-chat/store.reload.test.ts

B1 independent source: GUI §6.6 command-id replay and §7.4 queue/draft recovery; browser storage lifecycle. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: thread store across isolated page generations; ChatComposer/hooks. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `store.reload.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `ignores a stored value it cannot read, and still resumes every entry it can` (L1112) | Storage schema parser replay duplicates its lower outbox owner. Remaining: composer-outbox malformed payload/replay tests |

## packages/ui/src/lib/agent-chat/store.retention.test.ts

B1 independent source: GUI §7.2 lifecycle retention, page cache expiry and local storage isolation. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: thread store retain/release; hooks/project navigation. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `store.retention.test.ts`.

## packages/ui/src/lib/agent-chat/store.test.ts

B1 independent source: GUI §6.3/§6.6 transport actions, retries, queue boundaries, rewind and per-thread draft recovery. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: thread store public actions/state; hooks/ChatComposer/AgentChatView. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `store.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `omits turnId unless the session is running` (L411) | REWRITE: original negative could pass because the fixture had no active ID. Seed a ready head retaining a stale active ID, then a running head, and inspect both posted interrupt bodies. This is the store-owned session-status gate; transport tests cannot select it. B1–B6 use the file rationale; explicit fixture outcomes can disagree with the implementation. |
| REWRITE | `with no composer mounted, a Stop returning two full queued messages keeps all sixteen files for the next mount` (L1205) | Keep bridge/storage routing; remove real composer transformation from the mock and assert captured message or refused-file fallback and empty hidden draft. Remaining: composer-draft owns transformations; store alone owns mounted/unmounted routing |
| REWRITE | `with a composer mounted, every returned file is staged as returning, and nothing is parked behind it` (L1241) | Keep bridge/storage routing; remove real composer transformation from the mock and assert captured message or refused-file fallback and empty hidden draft. Remaining: composer-draft owns transformations; store alone owns mounted/unmounted routing |
| REWRITE | `a file the composer still refuses is written into its draft as its path, never parked behind it` (L1259) | Keep bridge/storage routing; remove real composer transformation from the mock and assert captured message or refused-file fallback and empty hidden draft. Remaining: composer-draft owns transformations; store alone owns mounted/unmounted routing |

## packages/ui/src/lib/agent-chat/stream.logic.test.ts

B1 independent source: GUI §6.3 NDJSON chunking, heartbeat, malformed-frame and additive protocol compatibility. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: frame parser; transport stream decoder. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `stream.logic.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| DELETE | `handles a chunk boundary inside a line and several lines at once` (L16) | Repeats the splitter boundary already exercised with a partial line; no unique parse contract. Remaining: stream.logic first splitter case; transport ordered frame/reconnect cases |
| DELETE | `decodes the three frame kinds` (L34) | Repeats decoding each declared frame kind through a second seam. Remaining: transport cold-start ordered-frame case |

## packages/ui/src/lib/agent-chat/timeline-position.test.ts

B1 independent source: GUI §7.2 100-thread ordered position/disclosure storage; AGENTS tolerant storage validation. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: TimelinePositionStore/parseTimelinePositions; store and timeline. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `timeline-position.test.ts`.

| Disposition | Original test (baseline line) / exact contract or detectable failure | Reason and remaining stronger coverage |
| --- | --- | --- |
| REWRITE | `evicts the oldest past the limit` (L24) | Exercise actual localStorage key and externally specified 100-entry bound; remove injected persistence callback, test-only size getter and unused keys method. Remaining: This is the persistence owner; component follow tests own user scrolling |
| REWRITE | `delete-then-set moves an entry to the end so it survives eviction` (L34) | Exercise actual localStorage key and externally specified 100-entry bound; remove injected persistence callback, test-only size getter and unused keys method. Remaining: This is the persistence owner; component follow tests own user scrolling |
| REWRITE | `persists as an ordered array, and replaying it rebuilds the same order` (L47) | Exercise actual localStorage key and externally specified 100-entry bound; remove injected persistence callback, test-only size getter and unused keys method. Remaining: This is the persistence owner; component follow tests own user scrolling |
| REWRITE | `forgets a thread` (L56) | Exercise actual localStorage key and externally specified 100-entry bound; remove injected persistence callback, test-only size getter and unused keys method. Remaining: This is the persistence owner; component follow tests own user scrolling |
| REWRITE | `repairs a row an older bundle wrote with missing fields` (L82) | Compare the repaired disclosure data to independent literal empty collections, not the owner’s exported default. B1–B6: tolerant storage migration requirement, visible disclosure restoration, literal oracle, public parser seam, refactor-safe fields, lowest migration owner. |
| REWRITE | `caps a persisted payload that is already over the limit` (L100) | Exercise actual localStorage key and externally specified 100-entry bound; remove injected persistence callback, test-only size getter and unused keys method. Remaining: This is the persistence owner; component follow tests own user scrolling |

## packages/ui/src/lib/agent-chat/title.logic.test.ts

B1 independent source: GUI §7.7 initial title seed, user-author intent and attachment-only fallback. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: deriveThreadTitleSeed; AgentChatView. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `title.logic.test.ts`.

## packages/ui/src/lib/agent-chat/transport.test.ts

B1 independent source: GUI §6.3 HTTP/NDJSON command receipts, cursor/reconnect, bounded window reads, binary attachments. B2 visible failure: each case contract below would be violated. B3: explicit fixture/literal oracle (rewrites remove the exceptions identified below). B4 seam and non-test callers: createAgentChatTransport; store/providers/API client. B5: state/data/command outcome assertions survive internal refactors. B6: lowest owner of these selected transitions; duplicate parser, transformer, and UI-layer assertions listed DELETE are removed. Risk: retained protocol/storage failures can lose or misroute user work; deleted duplicates have the named remaining protection. Validation: focused command above with `transport.test.ts`.

## Removed support and validation evidence

Removed dead per-suite fixtures/imports, the scripted duplicate projection walk, and copied composer transformations. Timeline position persistence now writes through the existing browser storage path without an injectable callback; unused size/keys inspection methods are removed. Shared isolated-page/test-helpers remain used by retained component and history tests. Production behavior is preserved.

Root agent owns repository gates and commit/remote integration/push; this delegated scope does not commit separately.

Before removing production support, repository caller search found `toolLifecycleStatusFromPayload` and `compactionTokens` referenced only inside `entries.logic.ts`; make these internal functions. The compaction API re-exports stay because `status.logic.ts` uses them. `TimelinePositionStore.persist`, `.size`, and `.keys` have no production consumers; only the initial-map option is used by the production singleton and remains. Shared fixture modules stay. The stale reducer prose naming removed API wrapper `deriveLatestTurn` will describe the latest-turn summary instead.

Caller check after removing refusal-copy assertions: `GOAL_HELD_SWITCH_REFUSAL` has only its internal `chatAccountSwitchRefusal` production use; remove its now test-only export.

Caller search before removal: both production `createEscapeSequence` callers (ChatComposer and AgentChatView) use the default; only tests pass `windowMs` or import `ESCAPE_SEQUENCE_WINDOW_MS`. Remove that configuration parameter and make the 600 ms constant internal. The independent GUI specification explicitly requires Escape twice within 600 ms. Isolated sequence failure modes: completing on first press, accepting a late second press, treating a third press as a second, or retaining a press after reset. The three retained cases target those failures.

Validation evidence:

- Original full library baseline: 567 runtime tests passed, zero failures.
- First rewritten-owner group (timeline position, drill-in, full output, plan): 79 passed.
- Pruned owner/store group (store, reload, entries, Codex/Grok child rows, presentation, roster, goals, stream): 151 passed.
- Final account/question/snapshot boundary group: 34 passed.
- Changed interrupt and composer routing cases re-run by name after the full store run: 4 passed, 37 unrelated cases skipped.

Post-edit failures were editing mistakes (a partly removed assertion, an expected undefined own-property, and a mistyped timestamp); all were corrected without modifying production behavior. No meaningful original baseline test failed. There is no package lint script; the repository root owns the final typecheck/test/build gates. No coverage/test-count gate blocked deletion.

Final cap audit before editing: `THREAD_SNAPSHOT_CACHE_MAX` has no caller outside its owner and barrel. After deleting its private-tuning test, make the constant internal and remove the unused barrel export; cache behavior remains unchanged. Unlike this private count, the position LRU's 100-entry bound is expressly required by GUI §7.2 and remains tested.

Final verification: 19 full-output cases passed after the final serialization cleanup; all 6 rewind cases passed after the timestamp/import correction; all 9 position cases passed after the literal disclosure oracle change. `pnpm --filter @orquester/ui typecheck` completed with exit 0. Scoped `git diff --check` and the AST unused import/local-helper scan are clean. Inspected the final diff, including all production support removals; cache size, Escape timing, storage format and user-visible behavior are unchanged.

No unresolved scoped risks or blocked checks. Shared `testing/isolated-page.ts` and `test-helpers.ts` remain because retained store/history/component tests use them. No snapshots were owned exclusively by deleted cases.
