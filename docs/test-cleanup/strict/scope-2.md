# Scope 2: completed strict cleanup ledger

Recorded before edits. Baseline: 201 test declarations in ten files. Each exact original name is listed below; line numbers identify the baseline and need not match the edited file. Deletion count is an outcome, not a target.

## Reading and evaluation

Read repository AGENTS.md/README.md, root and UI scripts, every assigned test, its production owner, API wire contracts, the referenced GUI/goals/history specifications and neighboring lower-level queue/history/goal coverage. No live daemon was started. Source documents: [GUI design](../../superpowers/specs/2026-09-21-agent-chat-gui-design.md), [history/index design](../../superpowers/specs/2026-09-23-thread-index-and-lazy-boot-design.md), [history bridge requirements](../../superpowers/specs/2026-09-23-fold-performance-design.md), [goal design](../../superpowers/specs/2026-09-24-agent-goals-design.md), and [wire contracts](../../../packages/api/src/agent-chat/wire.ts).

For every retained case the scenario/oracle column is the independently stated expected behavior (bar 1), the concrete caller-visible failure its violation creates (bar 2), and a literal expected datum/state/order rather than an expectation computed by the tested function (bar 3). The per-file seam and caller analysis supplies bars 4–6: tests act at the real interface, do not assert internal collaborator names/shapes, survive internal refactoring behind that interface, and retain only a distinct contract not owned more strongly below. Mock transports provide protocol inputs/record outgoing requests; they do not implement queueing, pagination, folding or selection. Recorded risk: low for deletions with identified owners; medium for dead-seam removal until UI typecheck confirms callers.

Validation command (run from packages/ui): `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test --test-concurrency=2 src/lib/agent-chat/{full-output,providers,reducer.logic,store.fixwave,store.history,store.reload,store.retention,store,stream.logic,transport}.test.ts`. Root runs repository gates.

## packages/ui/src/lib/agent-chat/full-output.test.ts

Independent sources: GUI design §5.6 payload limits, §6.3 item/output reads and §7.6 full launch prompt; API ThreadItemOutputResponse and storedCommandOutput contract. Stable seam (bar 4): full-output.ts readFullOutput/fullOutputText/source selection and createViewerReads. Non-test callers: AgentChatView.tsx; timeline/rows/ActivityRows.tsx. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: API command-output tests own provider payload extraction; these retained cases own viewer selection, partial-state labeling and read lifetime.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `shows the whole output of a command whose early chunks the window evicted, not what it still holds` (baseline 56) | KEEP | 600 original lines reach the viewer although only the final two remain in memory; prevents losing early command output. |
| `a running call's output is what exists now, and a join past the host's cap is its head: both said` (baseline 92) | KEEP | Host complete=false and truncated=true independently control running and cut state; prevents claiming a partial/live result is final. |
| `reads the item where the host has no join (a 404) or the call streamed nothing: never an error` (baseline 115) | KEEP | Absent or empty streamed output still displays the item; old hosts and silent commands must not open an error viewer. |
| `a row whose payload the wire cut reads its item alone: the join is never asked` (baseline 128) | KEEP | A file-change item remains an item, including the default source; prevents treating non-command payloads as command output. |
| `a join read that fails is the viewer's error, not a quiet fallback` (baseline 140) | KEEP | A rejected output read rejects the viewer request; prevents showing an incomplete fallback as a successful read. |
| `reads the call's join before its item's head: the host holds the whole output` (baseline 184) | KEEP | A stored-cut Codex completion displays the full streamed output instead of its retained head. |
| `shows the head as the command printed it, saying only part was kept, where no join answers` (baseline 202) | KEEP | Without streamed output the stored head is marked kept/partial and remains verbatim. |
| `asks the join once: a row that streamed read it first, and its item's head answers after` (baseline 210) | DELETE | Private read-count assertion repeats the retained missing-join/kept-output scenarios (115, 202); a cache/refactor can change read count without changing output. |
| `a completion that kept its whole output still reads it, and never asks the join` (baseline 219) | KEEP | An intact command displays its original output text without needing streamed data. |
| `an update stored cut reads the join too, then (nothing streamed) its payload, never its preview` (baseline 228) | KEEP | A cut update with no chunks stays an item; its one-line preview must not become claimed full command text. |
| `with no join to give, shows the part the tool kept as text, saying only part was kept — never that it is the start` (baseline 270) | KEEP | An OpenCode tail remains its verbatim tail, labeled partial rather than incorrectly labeled as the start. |
| `never out of an item stored cut: its data holds only a head, so the payload shows, as JSON` (baseline 281) | DELETE | Unreachable viewer combination: readFullOutput returns kind=kept for this cut completion, so AgentChatView never calls fullOutputText on it. Retained 202 protects the actual visible output. |
| `anything else as the viewer always showed it: a message's text, a string payload, JSON, else the summary` (baseline 299) | KEEP | Message text, string payload, structured payload and summary fallback retain their actual data; no blanket JSON wrapper or blank viewer. |
| `a new read retires the one before it, and closing the viewer retires the last` (baseline 330) | KEEP | A replaced/closed viewer aborts its prior read; prevents a stale completion replacing the currently selected output. |
| `shows the prompt itself, never its launch row as JSON` (baseline 347) | KEEP | A launch prompt shows its full prompt text rather than task metadata. |
| `a start with no prompt is its payload, as before` (baseline 352) | DELETE | Duplicates generic activity payload fallback in 299; no distinct launch-prompt behavior when the field is absent. |
| `a task row is no tool output: the prompt has its own read, the prompt row's` (baseline 359) | REWRITE | A task with a wire-cut prompt has no tool-output affordance; prevents offering a read that cannot supply tool output. Rewrite: Supply a literal wire-cut launch payload; avoid deriving the input/truncation oracle with production slimming code. |
| `a task's end carries none either` (baseline 376) | DELETE | Asserts only an intermediate truncated property, not an output affordance. Task lifecycle projection belongs to entries.logic tests; retained 359 checks the actual source affordance. |
| `a prompt is read as its item` (baseline 390) | DELETE | Stub item round-trip duplicates item read 128 and prompt extraction 347; prompt has no separate read algorithm. |

## packages/ui/src/lib/agent-chat/providers.test.ts

Independent sources: GUI design §6.3 provider catalog, §7.7 auth/usage notices, §8 surviving older host; goals design §8.1 capability boundary. Stable seam (bar 4): providers.ts loadProviders/refreshProvider and provider notice sink. Non-test callers: lib/store.ts, agent-chat/hooks.ts and store.ts. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: API goal parsers own schema details; these cases own old-host repair into UI state, catalog refresh and ambient routing.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| ``says nothing at all for an `unknown` provider that merely is not installed`` (baseline 66) | REWRITE | Unknown credentials on an uninstalled CLI produce no account notice; installing a binary must not be presented as a sign-in repair. Rewrite: Exercise unknown/uninstalled silence through loadProviders and the production ambient-notice sink; remove the test-only authErrorNotice export. |
| `is silent for a PENDING snapshot — nobody has looked at that provider yet` (baseline 77) | REWRITE | A not-yet-probed provider produces no notice; pending is not an authentication failure. Rewrite: Exercise pending-provider silence through loadProviders and the production ambient-notice sink; remove the test-only authErrorNotice export. |
| `publishes on every read, leaving dismissal memory to the app store` (baseline 95) | DELETE | Pins callback multiplicity/internal dismissal ownership rather than whether the user receives or dismisses the notice. Retained provider auth verdict tests plus agent-auth-notice.test.ts own those contracts. |
| `says nothing at all for a healthy catalog` (baseline 107) | KEEP | An authenticated healthy catalog produces no auth notice; guards against noisy false alarms. |
| `appends rather than silently dropping it` (baseline 116) | KEEP | Refreshing newly available Codex adds it to a Claude-only catalog; prevents a successful install remaining invisible. |
| `still replaces one it already has` (baseline 126) | KEEP | Refreshing existing Claude updates its version without a duplicate provider entry. |
| `reports a snapshot's windows under each registry id it serves` (baseline 136) | REWRITE | Both registry aliases receive the host quota window id and utilization; prevents a served alias displaying stale quota. Rewrite: Use two registry aliases and assert both receive the same quota data; original one-alias fixture could not detect broken fan-out. |
| ``toasts end-to-end when the host writes `auth: unauthenticated``` (baseline 172) | KEEP | The host unauthenticated verdict reaches the sink with sign-in tone, adapter and supplied explanation. |
| ``still surfaces `status: error` with auth unresolved — but never as a sign-in demand`` (baseline 197) | KEEP | Installed error+unknown produces a status notice rather than a false sign-in demand. |
| ``stays silent for `status: degraded`, which is not a credential verdict`` (baseline 217) | KEEP | Degraded version-advisory snapshots produce no auth notice. |
| `reports a refresh's auth error too, not just the catalog read` (baseline 236) | REWRITE | Explicit refresh surfaces its unauthenticated verdict, as catalog loading does. Rewrite: Assert sign-in tone and adapter identity, not generated fallback wording. |
| ``defaults a missing `capabilities` block to the withholding shape`` (baseline 267) | KEEP | Old-host rows lacking capabilities survive with affordances withheld, preventing composer crashes or unsupported actions. |
| ``keeps what a partial `capabilities` block does carry`` (baseline 278) | KEEP | Known partial capability values survive while unknown capability values are withheld. |
| ``defaults the list fields so `.map` on them cannot throw`` (baseline 292) | KEEP | Missing collections become safe empty collections and the provider remains findable under its adapter id. |
| ``repairs a missing `auth` block into `unknown` rather than toasting or crashing`` (baseline 302) | KEEP | Missing auth becomes unknown without a false sign-in notice. |
| `drops only the rows that cannot be repaired, keeping the rest of the catalog` (baseline 310) | KEEP | Unrepairable rows are dropped independently; valid Codex remains accessible. |
| `a row from the catalog read is repaired the same way` (baseline 325) | KEEP | A malformed goal capability block is absent at the typed state boundary; avoids offering unsupported goal commands. |

## packages/ui/src/lib/agent-chat/reducer.logic.test.ts

Independent sources: GUI design §6.3 replay/snapshot overlap and §8 old-host compatibility; goals design §4.4/§8.1. Stable seam (bar 4): reducer.logic.ts applyFrame. Non-test callers: store.ts. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: API pending/goal fold tests own event folding; client snapshot re-seeding and validation remain distinct.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `re-tombstones resolved requests so a replayed request cannot reopen a card` (baseline 27) | KEEP | An older replayed request stays resolved after snapshot reload, while a later request reusing its id stays answerable. |
| `adopts the snapshot's goal, validated, and reads a missing one as none (goals §4.4)` (baseline 45) | REWRITE | A valid snapshot goal appears on the slice; null, old-host absence and invalid status produce no goal. Rewrite: Read validated goal through applyFrame(...).slice.goal, the reducer interface used by the store; remove the test-only snapshot-fold export. |

## packages/ui/src/lib/agent-chat/store.fixwave.test.ts

Independent sources: GUI design §7.4 queue boundaries and §5.6/§7.3 Implement full-plan requirement. Stable seam (bar 4): store.ts actions.queueMessage/readFullPlanMarkdown. Non-test callers: ChatComposer.tsx; AgentChatView.tsx. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: queue.logic owns individual guards; these retained cases own session-phase/boundary orchestration and full plan retrieval.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `sends exactly one queued message per tool-call boundary` (baseline 141) | KEEP | Queueing during an existing completed boundary waits; the next tool completion posts only the first message and anchors the remainder to that boundary. |
| `never flushes while an approval is pending` (baseline 172) | DELETE | Duplicate pending-request guard already owned at the lower queue.logic seam (guard 3); this negative does not demonstrate release of the gate. |
| `marks the actionable proposal truncated and reads the whole plan back by its id` (baseline 203) | KEEP | A cut proposal reads the complete plan by its item id before implementation; prevents sending only the wire preview. |
| `never reads an intact proposal back` (baseline 217) | KEEP | An intact proposal supplies its full markdown offline, without requiring an unnecessary host read. |
| `refuses, rather than answer the cut text, when the read-back fails or brings no plan` (baseline 227) | KEEP | A failed/malformed full-plan read rejects instead of returning the cut preview for implementation. |

## packages/ui/src/lib/agent-chat/store.history.test.ts

Independent sources: thread-index-and-lazy-boot design §C Client/Search; fold-performance design Client history bridge; GUI design §5.5 rewind. Stable seam (bar 4): store.ts actions.loadOlderHistory/revealTurn/rewindTo plus displayed rows after stream events. Non-test callers: AgentChatView.tsx; timeline and search consumers through agent-chat hooks. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: history.logic owns pure bounds/merge rules; these retained cases exercise asynchronous page/stream/remount interactions or cross-page projection not represented by one helper call.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `loads the page just below the window and paints it above the live rows` (baseline 274) | DELETE | Single-page happy path repeated by retained multi-page cursor/order case 292 and reveal paging cases. |
| `pages by the oldest page's cursor and keeps the pages oldest first` (baseline 292) | KEEP | The oldest loaded cursor requests the next older page; displayed messages are oldest-first and the start cursor stops requests. |
| `shares one request between overlapping loads` (baseline 319) | KEEP | Concurrent load requests yield one page, preventing duplicate history insertion. |
| `asks nothing when the snapshot offers nothing older` (baseline 331) | KEEP | A snapshot with no older rows, no index or no history block causes no history request; protects old-host compatibility and unavailable history without inventing an empty cursor. |
| `records a readable error, keeps what it has, and clears it on the next success` (baseline 344) | DELETE | Async failure/retry scenario repeated more strongly by retained multi-page chain failure/retry 1463, including preservation of landed pages. |
| `recovers from a transport that throws before it answers, and can page again` (baseline 365) | KEEP | A synchronously throwing transport clears busy state and permits a later successful load; prevents a permanently latched pager. |
| `discards a page that lands after the snapshot it was asked against was replaced` (baseline 389) | KEEP | A page requested before a replacing snapshot never appears in the replacement history. |
| `renders a turn split across the page and the window as prompt → early work → later work` (baseline 402) | DELETE | Pure history merge ordering repeated by history.logic.test.ts keeps a turn work in log order across a page boundary, plus retained lifecycle split cases. |
| `renders a call once, at the page's position, with the window's completion` (baseline 480) | KEEP | A tool begun on a history page appears once, in its original position, with its live completion. |
| `renders a task once, at the page's position, with the window's completion` (baseline 506) | KEEP | A task begun on a history page appears once, in its original position, with its live completion. |
| `offers rewind on a page prompt, numbered by turn order` (baseline 538) | DELETE | Rewind ordinals and indexed rewindability are owned by projectHistoryRows tests; retained actual page-prompt rewind verifies action wiring. |
| `gates history rewinds by its position, not wholesale` (baseline 579) | KEEP | A shared compaction marker does not disable rewind for prompts after it on either side of the page/window boundary. |
| `rewinds to a prompt only a page holds, and hands it back once it is gone` (baseline 653) | KEEP | Rewinding a history-only prompt waits for its removal, then restores its text to the composer. |
| `scrolls to a turn the window already holds, without a request` (baseline 672) | KEEP | A turn already displayed reveals its own prompt immediately without loading history. |
| `loads older pages until the turn is on screen, then reveals it` (baseline 681) | KEEP | Search reveal follows older cursors until its actual turn row is visible. |
| `pages on past a page that lists the turn but shows none of it — a subagent's late row alone` (baseline 709) | KEEP | A page containing only hidden child work cannot satisfy a parent timeline reveal; paging continues to the visible prompt. |
| `gives up at once on a turn the thread no longer has` (baseline 746) | KEEP | A removed turn cannot be revealed or trigger history requests. |
| `gives up when nothing older is left to hold the turn` (baseline 754) | DELETE | Exhausted history refusal duplicates retained no-older-history request gating (331) and stopped cursor paging (292); the reveal cap test separately bounds lookup. |
| `gives up after 25 pages` (baseline 761) | KEEP | Search reveal terminates after the documented 25-page ceiling rather than looping indefinitely. |
| `waits for the thread to synchronize before looking` (baseline 778) | KEEP | Search reveal waits for synchronized thread data instead of concluding missing from the empty initial store. |
| `drops an unhandled reveal whose row a new snapshot no longer has` (baseline 789) | KEEP | A pending reveal survives replacement only if its target row survives; prevents later scrolling to deleted history. |
| `clears the reveal only for the nonce the timeline handled` (baseline 804) | KEEP | A stale reveal acknowledgement cannot clear a newer requested reveal. |
| `brings a thread back with its pages, and never with a dead request's spinner` (baseline 817) | KEEP | Remount restores landed pages without a spinner belonging to a dead request, and permits paging again. |
| `keeps pages, bridge and window ONE contiguous stretch while retention trims under them — nothing lost, nothing twice, in order` (baseline 984) | KEEP | All originally visible items and streamed additions remain once, in log order, across repeated real retention trims. |
| `renders the rows the first page repeats from the window ONCE — at the page's place, with the newest content — before and after the window evicts them to the bridge` (baseline 1012) | KEEP | Overlap is rendered once with newest content both before and after eviction; prevents stale page content winning over live updates. |
| `drops pages and bridge once the bridge no longer fits beside the newest page, and reads fresh bounds — the stream stays live` (baseline 1064) | KEEP | Overflow discards loaded history, obtains fresh bounds and preserves synchronized status; prevents an unusable pager after a live cap reset. |
| `refuses a re-read older than what the stream has folded since, and the next load asks without a cursor` (baseline 1088) | KEEP | A delayed stale bounds read cannot roll back live rows; the following request omits its obsolete cursor. |
| `drops pages AND bridge for a rewind that removes a bridge row's turn, and keeps both for one confined to the window` (baseline 1113) | KEEP | Rewind into a bridge turn clears obsolete history; a rewind confined to live rows preserves loaded history. |
| `reveals a turn only the bridge still shows, without loading a page` (baseline 1144) | KEEP | A bridge-only turn remains revealable through a visible row without another page request. |
| `keeps what the window evicts while the FIRST page is on its way, and joins it to the page once it lands` (baseline 1163) | KEEP | Rows evicted during the first pending page remain visible and meet that page without gaps when it arrives. |
| `lets that bridge go when the first page fails, and the retry asks without the snapshot's cursor` (baseline 1184) | KEEP | Failure of the first page drops its orphan bridge and retry asks without the stale snapshot cursor. |
| `asks for the first page without the snapshot's cursor once the window has evicted since that snapshot` (baseline 1203) | DELETE | Stale initial cursor behavior is also asserted by retained 1249 after real eviction from a snapshot without older history. |
| `drops pages, bridge and cut on a new snapshot` (baseline 1211) | KEEP | A new snapshot removes obsolete loaded pages and bridge, then paints only replacement rows and bounds. |
| `brings the bridge back with its pages on a remount — and a first page's orphan bridge never` (baseline 1225) | KEEP | Remount preserves a bridge joined to loaded pages but drops one whose pending first page died with its store. |
| `offers 'Load older' as soon as the window evicts a row, though the snapshot said nothing was older — and asks without a cursor` (baseline 1249) | KEEP | Live eviction creates older-history availability even if the original snapshot had none, and requests current bounds. |
| `renders the window's old prompts and answers in log order above a page — with no bridge yet` (baseline 1270) | KEEP | Retained old message rows precede newer page rows in independent log order despite different retention classes. |
| `renders the window's older rows above a page that shares NONE of them — a prompt, an agent's launch, a compaction marker — in log order` (baseline 1309) | KEEP | Old prompt, launch and compaction rows precede a disjoint page, followed by newer live work, in explicit log order. |
| `keeps the window's older rows in the window's order when a first page past a rewind takes the whole window into the history` (baseline 1356) | DELETE | Expected rendered rows come from the production projection before the action, so consistently wrong ordering passes. Independent-order cases 1270/1309 and history.logic merge rules remain. |
| `asks for the next page while a page shows nothing the timeline did not, and stops at the first that shows an older row — busy throughout` (baseline 1416) | KEEP | One Load older action skips overlapping pages until actual older rows appear, preserving busy state and cursor order. |
| `loads at most five pages in one click, and the next click goes on below the oldest` (baseline 1442) | KEEP | The documented five-page per-click ceiling stops automatic paging and the next click resumes from the last cursor. |
| `stops at a page that reaches the thread's start, and at a failed one — keeping what landed` (baseline 1463) | KEEP | An automatic paging chain stops on failure or thread start, retains landed pages, and retry follows their cursor. |
| `keeps a running turn live across history eviction, then settles it` (baseline 1486) | KEEP | A running call evicted into loaded history still reads active, then settles when the session ends without losing the answer. |

## packages/ui/src/lib/agent-chat/store.reload.test.ts

Independent sources: GUI design §7.4: reload never loses/duplicates a message, ten-minute replay/absence bounds, page lifecycle and cross-generation queue serialization; AGENTS persisted-state validation. Stable seam (bar 4): store.ts actions and module-reload storage boundary. Non-test callers: ChatComposer.tsx; AgentChatView.tsx; composer bridge/sends/outbox. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: composer-outbox owns storage parsing; queue.logic owns pure ordering; retained cases own end-to-end adoption, serialization, live/persisted target selection and browser lifecycle interactions.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `re-posts a send the page was still posting under the SAME commandId, once, the thread reading Sending meanwhile` (baseline 266) | KEEP | Reloading an unresolved send replays its original command id and attachment exactly once while the thread stays Sending. |
| `does not re-post a send older than the replay bound: it comes back to the thread's draft` (baseline 299) | REWRITE | An expired send restores its text/files without replay; the exact age boundary still replays and only that send remains in outbox. Rewrite: Use the documented ten-minute age and literal persisted outbox key as independent fixtures, rather than importing implementation constants. This rewrite is in shared setup: the test body is unchanged, but both referenced constants are now local specification literals, so changing production's age/key can disagree with the oracle. No case was renamed. |
| `says why a stale send is back on the thread itself, for whoever opens it next` (baseline 323) | KEEP | A stale send restored while no composer is mounted leaves a visible thread notice. |
| `gives several stale sends back in the order they were sent, ahead of what the draft holds` (baseline 331) | KEEP | Multiple stale sends precede the current draft in original send order, preventing reversed instructions. |
| `hands a stale send to the composer that shows the thread, saying why it is back` (baseline 342) | KEEP | A mounted composer receives stale text, files and notice directly, with no invisible second stored draft. |
| `gives nothing back for a stale Implement: its prompt was the composer's, and the plan is still there` (baseline 374) | KEEP | An expired generated Implement prompt is never replayed or restored as user-authored text. |
| `puts a refused re-post back into the draft, as any send that did not go out` (baseline 390) | KEEP | A refused replay restores its text/reason, clears Sending and removes the completed outbox entry. |
| `tells the composer that shows the thread why a refused re-post is back — a message from before the reload` (baseline 406) | KEEP | A mounted composer receives the host refusal reason for a pre-reload send. |
| `brings queued messages back as queued, in order, under the commandIds they were queued with` (baseline 436) | KEEP | Queued messages survive actual module reload with their original ids and drain serially in order after the turn ends. |
| `leaves nothing for a reload once a send settled — delivered, or given back to the draft` (baseline 479) | KEEP | Settled successful/refused sends leave no outbox work to replay on another reload. |
| `re-posts first, under its own id, the queued send a page was posting when it reloaded` (baseline 499) | KEEP | An interrupted queued post is replayed before its waiting successor, under its original id. |
| `starts a generation that has nothing retained from the queue this page kept` (baseline 527) | DELETE | Same-page cache expiry recovery is repeated with stronger automatic-send behavior by retained 734; queued ids/data remain covered there and 436. |
| `does not bring back as queued what Stop returned to the composer` (baseline 549) | KEEP | Queue content returned by Stop remains only in the draft after reload, never queued again. |
| `holds a queued send whose re-post failed at the front, and the rest of the queue behind it` (baseline 565) | KEEP | A refused queued replay is held ahead of waiting work and receives a new id for the user next retry. |
| `holds a stale queued send at the front instead of re-posting it, the queue behind it` (baseline 590) | KEEP | A stale queued post is held ahead of waiting work without replaying either automatically. |
| `brings back a queue its page showed less than ten minutes ago as it was, to go out by itself` (baseline 626) | KEEP | A recently visible queue resumes automatic sending after reload. |
| `holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself` (baseline 642) | KEEP | A queue unseen beyond ten minutes is held; Send now authorizes only the chosen message and preserves its queued id. |
| `measures that absence from when the page last showed the queue, never from when a message was queued` (baseline 667) | KEEP | Fresh visibility rather than original queue age governs reload freshness after a long running turn. |
| `stamps the queue as last shown when the page is hidden` (baseline 682) | KEEP | Visibilitychange captures the last visible time, so a recently hidden queue remains fresh. |
| `does not move that stamp at a teardown while the page is hidden` (baseline 699) | KEEP | Hidden teardown cannot refresh an old visibility stamp and accidentally auto-send stale intent. |
| `stamps the queue as last shown on pagehide` (baseline 716) | KEEP | Pagehide captures last-seen time even without a visibilitychange event. |
| `lets a queue kept in the page go on by itself when its thread comes back within ten minutes` (baseline 734) | KEEP | Same-page generation/cache expiry preserves and automatically sends a recently visible queue. |
| `holds a queue kept in the page when its thread comes back more than ten minutes later` (baseline 750) | KEEP | Same-page generation/cache expiry holds an old queue instead of auto-sending it. |
| `holds a queued send that fails with no live generation at the front of the kept queue, reason and all — the next generation shows it there` (baseline 784) | KEEP | A late failed send with no live generation is restored ahead of kept work with its reason, never also in draft. |
| `does the same when nothing was retained` (baseline 806) | DELETE | Expiry variant repeats retained late-failure outbox recovery 784 and same-page expiry 734; no additional failure mode beyond composing those two. |
| `brings a message held before the reload back held, with the reason it waits` (baseline 822) | KEEP | A previously held queue survives reload held with its failure reason. |
| `re-posts a thread's in-flight leftovers one at a time, in the order they were posted — a composer send among them` (baseline 848) | KEEP | Interleaved composer/queued in-flight entries replay by original send time one at a time before waiting work. |
| `holds the in-flight leftovers whose re-posts fail in the order they were posted, ahead of the rest` (baseline 880) | KEEP | Consecutive queued replay failures preserve original order ahead of waiting work. |
| `never holds a failed re-post behind a waiting message once the user has sent the one held before it` (baseline 926) | KEEP | Sending an earlier held message cannot move a later replay failure behind messages queued after it. |
| `holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them` (baseline 949) | KEEP | A later waiting message held for absence cannot overtake an older failed replay. |
| `keeps the order of consecutive failures that land with no live generation` (baseline 978) | KEEP | Consecutive replay failures with no live generation preserve order when reopened. |
| `never leaves a thread reading Sending when giving a refused re-post back throws — and still re-posts the rest` (baseline 1005) | KEEP | A throwing restore handler cannot leave Sending latched or prevent remaining outbox replay. |
| `opens the thread's stream even when giving a stale send back throws: the outbox is a safety net, never a failure` (baseline 1040) | KEEP | A throwing stale-send restore cannot prevent the thread stream opening and applying its first snapshot. |
| `does not trust a kept queue whose last write failed: the retained snapshot has what came after` (baseline 1068) | KEEP | After storage quota failure, remount uses newer retained queue data instead of a stale successful outbox write. |
| `takes a held message only the kept queue has into the snapshot's queue after a failed write` (baseline 1084) | KEEP | After storage write failure, remount merges a late held message from outbox ahead of newer retained queued work. |

## packages/ui/src/lib/agent-chat/store.retention.test.ts

Independent sources: GUI design §6.5/§7.2: retained value, five-minute idle TTL, resume cursor and generation ownership. Stable seam (bar 4): store.ts creation/destruction/remount and stream options. Non-test callers: agent-chat/hooks.ts through retainThreadStore/releaseThreadStore. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: No lower retained cache tests duplicate these; cache wiring, displayed values and resume protocol are observed together.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `paints the retained state on remount and resumes with after=<seq>` (baseline 132) | KEEP | Remount immediately displays cached messages and resumes after the retained sequence under the retained host id. |
| `does a full load once the idle TTL has elapsed` (baseline 157) | KEEP | After five idle minutes stale cache is not painted; stream requests a fresh snapshot without a cursor. |
| `refuses a write from a generation a newer store has replaced` (baseline 175) | KEEP | A late old-store teardown cannot overwrite the snapshot from its replacement generation. |
| `keeps the held queue and disclosure state on remount` (baseline 196) | KEEP | Held queue intent and expanded disclosure survive a remount. |
| `never paints a retained error banner` (baseline 216) | KEEP | A remount does not resurrect an error banner owned by a discarded generation. |

## packages/ui/src/lib/agent-chat/store.test.ts

Independent sources: GUI design §3.4 account switch, §6.2 command idempotency, §7.2 view state, §7.4 drafts/queue/generation lifetime and §7.5 rewind; AGENTS command identity/storage rules. Stable seam (bar 4): store.ts actions/getState; protocol frames, storage and composer bridge. Non-test callers: AgentChatView.tsx; ChatComposer.tsx; agent-chat/hooks.ts and composer-failed-send.ts. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: API folds own log semantics; queue/draft helpers own pure rules; retained cases own thread routing, command receipts/lifetime and observed UI state.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `never counts a live loop or goal as background work — the host treats both as inert` (baseline 149) | KEEP | Loop/goal roster entries do not claim background work; a live shell still does, matching host task classification. |
| `drops a Claude log's re-emitted copy and leaves another provider's repeat alone` (baseline 197) | KEEP | Historical Claude duplicate paragraphs are hidden while legitimate Codex repeated narration remains. |
| `reads a message's liveness through the rule: a stuck answer is settled, the running turn's streams` (baseline 228) | KEEP | A dead-host streaming flag does not keep an old answer live; the active turn remains streaming until the session stops. |
| `is on the slice the hooks read — the snapshot's, then every live goal row` (baseline 275) | DELETE | Goal event fold and projection duplicated across API fold.goal, reducer snapshot boundary, and rows.logic goal markers; remove the extra store layer. |
| `mints a commandId per command and sends no optimistic row` (baseline 334) | KEEP | Independent sends mint distinct nonempty command ids and wait for authoritative events before displaying sent rows. |
| `setAccount posts the daemon-owned route with a minted commandId (§3.4)` (baseline 346) | KEEP | Account switching uses the dedicated daemon route and requested account id without optimistic thread mutations. |
| `setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal` (baseline 359) | KEEP | Host-unavailable account switches retry with one id; definitive rejection appears on the thread. |
| ``holds `reverting` for the length of the revert and clears it even on failure`` (baseline 382) | DELETE | Only consumer of unused raw revert action; real GUI uses rewindTo, whose retained success/failure/in-flight tests protect composer lock behavior. |
| `locks the row while a decision is in flight and clears it in a finally` (baseline 399) | KEEP | An approval in flight locks only its request and a refusal releases the lock. |
| `omits turnId unless the session is running` (baseline 408) | KEEP | Interrupt omits stale turn ids when idle and names the active turn only while running. |
| ``posts `revert`, stays inert until the truncation lands, then hands the message back`` (baseline 480) | KEEP | Rewind remains locked after receipt until truncation, then restores prompt, attachment and context once. |
| `settles at once when the truncation was folded before the command answered` (baseline 505) | KEEP | A truncation arriving before HTTP response completes rewind immediately instead of waiting for a frame already applied. |
| ``rejects with the reason of a NEW rewind failure, and clears `reverting``` (baseline 516) | KEEP | Only a new rewind failure rejects the current operation and unlocks it without restoring an unremoved prompt. |
| `falls back to the failure row's summary when it carries no detail` (baseline 551) | KEEP | An old-host failure without detail still supplies its summary as the refusal reason. |
| `rejects a message it cannot find — or one that is not the user's — without posting` (baseline 576) | KEEP | Only an existing user prompt may be rewound; invalid targets post no mutation and do not lock the composer. |
| ``refuses a second rewind while one is in flight — one `/revert`, one message back`` (baseline 584) | KEEP | Concurrent rewind requests produce one mutation and restore one copy of the prompt. |
| `unlocks the composer after two minutes without claiming the rewind completed` (baseline 595) | KEEP | A two-minute unanswered rewind unlocks without claiming success or restoring an unremoved prompt. |
| `settles when its store is destroyed mid-wait, handing the message back to the persisted draft` (baseline 618) | KEEP | Teardown during rewind waiting preserves the requested prompt in persistent draft rather than losing it with the store. |
| `returns every queued message to the composer on interrupt` (baseline 663) | DELETE | Simple Stop drain duplicates retained 1208 with two messages and sixteen attachments. |
| `holds a failed send at the FRONT so nothing overtakes it` (baseline 672) | DELETE | Pure hold-at-front rule duplicated by queue.logic and stronger retained cross-generation queue failure cases. |
| `returns one queued message to the composer` (baseline 685) | DELETE | Single return duplicates retained mounted composer routing 1239 and reload Stop-return persistence 549. |
| `remembers a dismissal per (thread, message) — a DIFFERENT error still shows` (baseline 696) | KEEP | Dismissing one thread error suppresses only that error; a different later failure still appears. |
| `retries a lost response with the SAME commandId` (baseline 712) | KEEP | A lost response is retried using the same command id to avoid duplicate host mutations. |
| `writes the scroll/disclosure LRU and mirrors follow from atEnd` (baseline 725) | REWRITE | Remembering a non-tail anchor disables following; tail resumes following without erasing the existing anchor. Rewrite: Drop geometry offset assertions; retain row-anchor and follow-state behavior only. |
| `writes a saved draft straight through to storage, under its own thread id` (baseline 785) | KEEP | Saving a draft writes its text and attachment references under that thread storage key. |
| `seeds a fresh store from storage — which is what a reload is` (baseline 797) | KEEP | A fresh thread store restores typed text and attachment references from existing storage. |
| `drops the entry when the draft is cleared, so a sent message never returns` (baseline 810) | KEEP | Clearing a draft removes its persisted entry, so a sent draft does not reappear. |
| `leaves another thread's draft alone` (baseline 822) | DELETE | Other-thread isolation repeated by retained external update cases 839/854, which check both memory and persistence. |
| `with no slice open, lands in storage, where the thread's next slice seeds from, and moves no other thread's draft` (baseline 839) | KEEP | An external restore without a live slice updates only that thread persistent draft, then the next store reads it. |
| `with a slice open, goes through that slice, whose draft the next composer mount loads` (baseline 854) | KEEP | An external restore with a live slice updates both the visible and persistent draft, leaving the other thread untouched. |
| `a turn or an answer whose generation was destroyed mid-retry keeps retrying with the SAME commandId` (baseline 961) | KEEP | Turn/answer retry survives store teardown with original ids; unrelated compact operation stops with its destroyed generation. |
| `an attempt that never answers times out and is retried with the SAME commandId, so no send reads Sending forever` (baseline 1001) | KEEP | A stuck post aborts at 25 seconds and retries with original id; exhausting its retry budget rejects instead of sending forever. |
| `a queued send that fails after its generation was destroyed is held at the front of the thread's live generation` (baseline 1041) | KEEP | A queued send failing after teardown is restored with attachments and reason in the replacement generation. |
| `the live generation waits for the torn-down one's queued send in flight before sending the next` (baseline 1095) | KEEP | A replacement generation waits for the old queued post to settle before sending its successor. |
| `when the torn-down generation's queued send fails, it is held at the front and the next one still waits` (baseline 1118) | KEEP | A late failure holds the old queued post ahead of its successor; the successor never slips out automatically. |
| `with no live generation, a queued send that fails after the teardown goes back to the persisted draft` (baseline 1138) | KEEP | Without live store or session storage, late queue failure appends its text/files to existing persisted draft. |
| `a rewind torn down before the host answered merges into the thread's live slice, never over its newer draft` (baseline 1155) | KEEP | A late rewind response merges into the current generation draft without overwriting text typed after remount. |
| `an answer in flight across a teardown never locks the next generation's card` (baseline 1187) | KEEP | An answering request from a destroyed generation does not leave its replacement card locked. |
| `with no composer mounted, a Stop returning two full queued messages keeps all sixteen files for the next mount` (baseline 1208) | KEEP | Stop preserves all sixteen returning attachments from two queued messages for the next composer mount. |
| `with a composer mounted, the returned message reaches it without a hidden persisted copy` (baseline 1239) | KEEP | A mounted composer receives returned text/files once with no hidden persisted duplicate. |
| `a file the composer still refuses is written into its draft as its path, never parked behind it` (baseline 1258) | KEEP | A composer-refused file is delivered as its absolute path instead of silently discarded or hidden in store draft. |

## packages/ui/src/lib/agent-chat/stream.logic.test.ts

Independent sources: GUI design §6.3 NDJSON frame/comment framing and §8 additive protocol compatibility; AgentChatStreamFrame wire union. Stable seam (bar 4): stream.logic.ts line framing/parser used at transport boundary. Non-test callers: transport.ts. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: Retained parser cases are the lowest owner of chunk framing and malformed/additive input; heartbeat exclusion remains at transport level only.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `splits complete lines and holds the partial one` (baseline 10) | KEEP | Chunk boundaries may split JSON arbitrarily; completed lines are delivered once and partial tails are buffered. |
| `reads the heartbeat comment as a heartbeat, not a frame` (baseline 19) | DELETE | Heartbeat exclusion is already exercised through the stable transport.stream interface by the retained cold-start snapshot/event/heartbeat scenario. |
| `skips blank lines` (baseline 24) | KEEP | Whitespace-only lines are ignored rather than treated as protocol failures. |
| `rejects malformed JSON and structurally wrong frames without throwing` (baseline 29) | KEEP | Malformed JSON and invalid frame envelopes are rejected without throwing out the connection. |
| `accepts an event whose payload carries fields this bundle does not know` (baseline 38) | KEEP | Unknown additive event payload fields remain accepted for rolling-version compatibility. |

## packages/ui/src/lib/agent-chat/transport.test.ts

Independent sources: API agent-chat/wire.ts routes, frame/error/output/attachment contracts; GUI design §6.2/§6.3, §6.6 retries and §8 compatibility; AGENTS binary-upload rule. Stable seam (bar 4): transport.ts createAgentChatTransport and attachment conversion. Non-test callers: resolveAgentChatTransport in frontend hooks; AgentChatView.tsx via store. Refactor bar 5: inputs/actions and returned view/protocol data remain valid when private functions, caches and classes change. Lowest-owner/coverage bar 6: Daemon/API tests own server route handling and schema validation; these cases own actual client request encoding, receive/retry semantics, UTF-8 pagination and binary transport selection.

| Original test | Disposition | Independent oracle / failure or deletion reason |
| --- | --- | --- |
| `opens without a cursor from a cold start and decodes frames in order` (baseline 74) | KEEP | A cold stream uses the session events route without cursor and delivers snapshot/event/sync in order, omitting heartbeat comments. |
| `resumes from the highest applied sequence after a drop` (baseline 95) | KEEP | Reconnection resumes at highest delivered event sequence rather than repeating from zero. |
| `drops a replayed event so a reconnect duplicates nothing` (baseline 112) | KEEP | Overlapping replay drops already delivered event ids while delivering new events once. |
| `asks for a snapshot when the host instance changed` (baseline 139) | KEEP | A changed host instance requests a fresh snapshot, preventing skipped events in a new sequence space. |
| `reports the reconnect and stops for good on close` (baseline 161) | KEEP | A closed stream cancels pending reconnects and reports the transport ending. |
| `closes a wedged stream once the heartbeat window lapses` (baseline 178) | KEEP | A stream with three missed heartbeats closes and reconnects instead of remaining permanently wedged. |
| `posts to the right route and returns the receipt` (baseline 194) | KEEP | Stop is POSTed to the public session command route with its command id and returns the host receipt. |
| `turns an error envelope into a typed error` (baseline 204) | KEEP | COMMAND_REJECTED becomes a typed nonretryable error so a permanent refusal is surfaced. |
| `marks HOST_UNAVAILABLE retryable — the same commandId may be re-posted` (baseline 223) | KEEP | HOST_UNAVAILABLE is retryable to permit safe re-post under the same command id. |
| `defaults the turn diff to ignoring whitespace` (baseline 237) | KEEP | Turn diff defaults to whitespace-insensitive wire query. |
| `asks for an older page by cursor and turn count` (baseline 247) | KEEP | History reads encode session paths and transmit requested cursor/turn limit. |
| `omits the cursor for the first page below the window` (baseline 268) | KEEP | An initial history request omits before entirely; an empty cursor is a different wire value. |
| `searches every thread with the query, the limit and an optional project` (baseline 278) | KEEP | Search uses host-wide GET endpoint and transmits query/limit/optional project. |
| `forwards the abort signal on both reads` (baseline 294) | KEEP | History and search forward caller cancellation so superseded reads can be aborted. |
| `maps INDEX_UNAVAILABLE to a typed, non-retryable error` (baseline 307) | KEEP | INDEX_UNAVAILABLE preserves host status/code/reason and does not trigger command retry policy. |
| `pages a window chain to the end and answers the whole join` (baseline 343) | KEEP | UTF-8 windows join without loss using host byte offsets, with completion state from the final window. |
| `says what the last window says: a running call's output so far, a join cut at the host's cap` (baseline 365) | KEEP | An unfinished host-capped output preserves both incomplete and truncated flags. |
| `answers an empty join empty — the call streamed nothing` (baseline 378) | KEEP | A command producing no bytes resolves to an empty complete output rather than a malformed response. |
| `takes the whole join a host from before windows answers, whatever the query asked` (baseline 391) | KEEP | A pre-window host whole-output response is accepted unchanged for version compatibility. |
| `answers null on a 404: the host's ITEM_NOT_FOUND, or a host from before the route` (baseline 401) | KEEP | 404 output lookup resolves to absence for missing item or old host route so the viewer can fall back. |
| `keeps any other failure's code` (baseline 419) | KEEP | Other output errors preserve HOST_UNAVAILABLE instead of masquerading as missing output. |
| `refuses a body of neither shape, and windows that do not meet end to end` (baseline 434) | KEEP | Malformed shape, offset gaps/overlap, zero-progress loop, short final page and changed call identity reject rather than fabricate output. |
| `refuses a window wider than one read takes, and a join past the host's cap` (baseline 461) | KEEP | Overwide windows and joins beyond host byte cap reject rather than allocate unbounded response text. |
| `takes a whole join arriving mid-chain (an older host back after a rollback) as the answer` (baseline 475) | KEEP | A host rollback mid-chain replaces accumulated windows with its whole output, avoiding duplicate prefix. |
| `answers null on a 404 mid-chain — the thread deleted between two reads — dropping what it had` (baseline 486) | KEEP | A thread removed mid-chain returns absence rather than the incomplete prefix collected so far. |
| `forwards the abort signal on every page` (baseline 500) | KEEP | Caller cancellation reaches every page, not only the first read. |
| `carries a chat upload's server-minted AttachmentRef verbatim (the host answers the ref itself)` (baseline 516) | KEEP | Host-minted attachment metadata/id survives conversion and terminal uploads retain server path identity. |
| `turns an upload response into metadata only — never bytes, never a data URL` (baseline 536) | KEEP | Terminal upload metadata yields normalized image/file attachment references with size, without embedding bytes. |
| `keeps the host's absolute path so the composer can name the file in the prompt (§7.4)` (baseline 550) | KEEP | Host absolute attachment path survives so the composer can refer to the uploaded file. |
| `reads an attachment's bytes back over requestBytes, and refuses where the transporter has none (§7.4)` (baseline 561) | KEEP | Attachment preview uses binary GET, refuses transports without binary support, and propagates a missing-file status. |

## Dead support and production seams

- Remove unused raw `AgentChatActions.revert` method: global search across UI/web/desktop found no production caller; real GUI uses `rewindTo`. Keep protocol/daemon revert unchanged.
- Remove exported `authErrorNotice`, its helper-only `ProviderAuthNotice` result type, `foldStateFromSnapshot` and their barrel entries; first two auth negatives move to catalog boundary and snapshot goal validation moves to reducer boundary. History fixtures use applyFrame after coordination with scope 3.
- Internalize provider sanitizer helpers and the store disposal constant; remove unused TTL barrel/store reexports. Keep runtime dependency injection and destruction hooks because the frontend registry uses them.
- In coordination with scope 4, reload fixtures use literal persisted outbox key and documented ten-minute replay bound; remove the now test-only exports in composer-outbox.ts.
- Remove ThreadRetentionCache.isOwner, which has no apps/packages caller; retain/claim enforce ownership internally. Internalize the retention TTL after removing its unused store/barrel reexports.
- Remove helpers/imports orphaned by deleted suites; retain shared builders and isolatedPage because retained tests still need browser module isolation.

## Validation results

Completed cleanup: 170 KEEP, 23 DELETE and 8 REWRITE dispositions account for all 201 original declarations. The resulting ten-file focused suite contains 178 tests; all 178 passed, with zero failures, cancellations or skips. The bounded command above exited 0 (489.8 seconds); output is recorded at `/tmp/orquester-test-audit/scope-2-focused.log`. Eight test files changed, removing 419 test lines net. Six directly owned production files remove another 29 lines net; shared component outbox export cleanup is recorded by scope 4.

The original baseline attempt completed full-output/providers/reducer/fixwave without failure, but was interrupted before completing the whole scope. It is not claimed as a full untouched baseline. The complete focused validation above ran against the edited scope. AST reconciliation matched every original declaration to its recorded disposition; shared-fixture rewrites are explicitly identified. Inspected the final test/production diff, searched removed seams across apps/packages, checked remaining imports, and passed scoped `git diff --check`. Root owns repository-wide typecheck, tests, build and remote integration.

## Incoming remote audit: 9871b50f

Audited the three added `packages/ui/src/lib/agent-chat/store.test.ts` declarations in the isolated incoming checkout before merging. These decisions add three KEEP cases to the baseline dispositions above. At this recording they are an incoming audit; root owns merge and subsequent validation.

Independent source (bar 1): the current public `TaskStopCommandBody` wire contract requires the roster task id, rejects invalid targets with 409/COMMAND_REJECTED, distinguishes accepted requests from `task.completed`, and names provider failures with `payload.targetTaskId`. The roster component contract exposes `stoppingTaskIds` to control the pending Stop affordance. The older GUI design's session-only Stop description predates this added protocol; it is not used as authority for per-task Stop.

Stable seam and callers (bars 4–5): `AgentChatView` calls `actions.stopTask` and supplies `stoppingTaskIds` to `AgentRoster`; the tests invoke that same store action and feed actual wire frames through the transport boundary. Assertions read caller-visible state and outgoing command data, not private helper calls. Internal pending-set storage, parser/helper names and store organization can change while these tests remain valid. Lowest owner (bar 6): these scenarios own coordination between command receipt/failure and subsequent stream events. The pure roster owner retains only distinct missing-row, other-task isolation and malformed/unrelated failure-event guards; its duplicate successful lifecycle/identity assertions are removed or narrowed by scope 3. Risk is low: no production change or new fixture is required by these three dispositions.

| Original test | Disposition | Independent oracle and visible failure (bars 2–3); distinct ownership (bar 6) |
| --- | --- | --- |
| `posts the task's id and holds its Stop pending until the row settles` (incoming 1297) | KEEP | The outgoing `task/stop` body names the selected roster id and carries a command id; accepted response and later running progress retain that literal id in pending state, while a stopped completion clears it. Detects stopping the wrong task or re-enabling Stop before the host reports settlement. No remaining lower test coordinates the outgoing user action with both receipt and streamed lifecycle. |
| `lets the Stop go at once when the host refuses it, and says why on the banner` (incoming 1312) | KEEP | A 409 COMMAND_REJECTED makes the action reject, clears pending state, and exposes the host-supplied reason. The expected reason is independently supplied input whose preservation is the contract, not generated UI copy. Detects a permanently disabled Stop or a hidden refusal; generic command tests cannot detect leaked per-task pending state. |
| `offers the Stop again when the provider failed it` (incoming 1321) | KEEP | After an accepted stop, the literal `provider.task.stop.failed` activity with `targetTaskId` releases that task's pending state. Detects a Stop that remains unusable after asynchronous provider failure. The parser's malformed-event tests do not cover action-to-stream recovery. |

Focused validation after merging: the existing scope command, or its `src/lib/agent-chat/store.test.ts` subset. Root will record the integrated result.
