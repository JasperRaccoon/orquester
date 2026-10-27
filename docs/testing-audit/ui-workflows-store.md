# UI workflows, app state, hooks and test support audit

Current-tree scope: 273 baseline test declarations in 43 files; all read with their production owners and applicable specifications. Six redundant executions removed, 267 remain. These are this change’s decisions; previous audit ledgers were used only to locate contract sources and were checked against current code.

Dispositions: {'DELETE': 3, 'KEEP': 251, 'CONSOLIDATE': 6, 'REWRITE': 13}. CONSOLIDATE includes three removed notification source tests, their surviving event-store owner and two surviving Steps owners; DELETE includes three redundant source tests. REWRITE preserves unique behavior and removes incidental copy/timing coupling.

Every surviving row inherits its file’s independently specified contract source (bar 1), names the observable failure it detects (bar 2), uses the independent oracle described below (bar 3), observes the listed production boundary (bar 4), asserts semantic effects that survive internal refactors (bar 5), and owns the distinct named action/input/race that stronger remaining coverage does not supersede (bar 6). Removed duplicates explicitly name the surviving owner.

V: from `packages/ui`, run `TSX_DISABLE_CACHE=1 node --import tsx --import ./test/svg-loader.mjs --test --test-timeout=600000 --test-concurrency=4` with the 43 paths in the JSON ledger. Root owns serialized test scheduling, full repository checks and comparable suite timing. No isolated speedup is claimed: these tests already use fake time or receipts; savings come from removed duplicate work and smaller fixtures.

Support review: `lib/workflows/testing.ts` remains used across the suite; both SVG/CSS loader files remain required by the UI runner. `test/performance/bundle-audit.mjs` and `test/performance/file-browser-refresh.ts` remain explicit measurement tools, outside required test gates. No snapshots, dependencies or configurations became orphaned. The sole removed production test-only seam is the exported `LONG_PRESS_MS`; its value and algorithm remain unchanged.

Validation status: pending central validation. No local test run started without the root’s slot.

## `packages/ui/src/components/workflows/canvas/connection.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 canvas add/remove and pin cleanup. **Seam/consumers:** canvas/ops.ts graph edits; WorkflowCanvas and Steps.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| adds a block wired from an output | DELETE | Duplicate addBlock from-output wiring is exercised by the named Steps action through the same production owner; its complete literal edge-set assertions are stronger than this subset check. Fails unique-protection bar 6. Owner: packages/ui/src/components/workflows/steps/steps-logic.test.ts: a block with no outputs (Stop) never splices: it becomes another branch. |
| inserts a block into an edge: source → new → target | DELETE | Duplicate addBlock edge insertion is exercised by the named Steps action through the same production owner; its complete literal edge-set assertions are stronger than this subset check. Fails unique-protection bar 6. Owner: packages/ui/src/components/workflows/steps/steps-logic.test.ts: splices into a chain without losing downstream connections. |
| removes blocks with their edges and pinned outputs | KEEP | Removing a block must also remove incident edges and its pinned output; Steps healing tests do not protect pinned-state cleanup. |

## `packages/ui/src/components/workflows/canvas/tap-connect.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.4 phone connect workflow; §3.4 acyclic edges. **Seam/consumers:** tap-connect.ts touch action reducer; WorkflowCanvas.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| start → tap a block: connects, back to idle | KEEP | Two taps must produce the exact requested connection and leave picking mode; no rendering or private React props are inspected. |
| a refused target keeps picking and says why | KEEP | Rejected target must leave picking active with explanation and permit a later valid target; validator-only tests do not protect the interaction state. |
| its own block or Cancel ends it; a tap while idle does nothing; a new start replaces | KEEP | Self-tap/cancel must clear pending connection, idle tap does nothing and new source replaces old selection; prevents accidental stale-source edges. |

## `packages/ui/src/components/workflows/phone/key-bar.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.4 phone key bar and expression entry. **Seam/consumers:** key-bar.ts text/selection editing; KeyBar.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| a character replaces the selection; the caret goes after it | KEEP | Symbol insertion/replacement must preserve surrounding text for forward/backward selections and place the caret after inserted content. |
| {{ }} puts the caret inside, or wraps the selection | KEEP | Expression shortcut must produce syntactically usable braces around a selected expression or position the caret inside an empty expression. |
| Tab indents by the editor's unit | KEEP | Tab must use the caller-selected indentation and move the caret consistently; actual edit result, not key declaration inventory. |

## `packages/ui/src/components/workflows/runs/log-buffer.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.3 process log viewer; terminal ANSI/CR stream semantics. **Seam/consumers:** log-buffer.ts append and visible output; LogViewer.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| drops colours, cursor moves, OSC titles and links | KEEP | ANSI colors/cursor/OSC sequences and unsafe control bytes must not leak into displayed text, while legitimate text and tabs remain. |
| carries an escape sequence split across chunks | KEEP | Escape sequences split between chunks must be consumed without losing ordinary text; single-chunk sanitizer coverage cannot catch carry mistakes. |
| keeps what a terminal would show | KEEP | Carriage-return progress must replace its prior line and CRLF must terminate once; ordinary newline splitting does not protect terminal-style output. |
| splits chunks into lines and keeps the line in progress | KEEP | Chunk boundaries must preserve incomplete lines without duplicating/dropping content; literal words form an independent stream oracle. |

## `packages/ui/src/components/workflows/runs/log-follower.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.3 complete logs; WorkflowLogWindow X-Log-* wire offsets. **Seam/consumers:** log-follower.ts reading and api-client.ts header parse; LogViewer and log download.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| reads a finished log to its end, window after window, by the daemon's offsets | KEEP | Finished logs must read all server windows using raw-byte cursors even when redaction expands displayed text; otherwise portions duplicate/vanish. |
| polls a live log, and a failed read resumes from the same offset once — no duplicates | KEEP | A transient live-read failure must retry the same offset and continue without duplicate text, then cease polling at terminal EOF. |
| an error on a finished log is reported, not appended | KEEP | A failed completed-log read must report an error without adding error text as log content; live retries exercise a different branch. |
| stop() ends it: no further reads, including after wake | KEEP | Stopping the viewer must terminate polling and make later wake inert, avoiding background log requests after unmount. |
| a live log held at a partial last line waits for the next poll instead of spinning | KEEP | A held partial line with no cursor advance must wait for a poll rather than spin synchronous reads; the transport stub supplies the documented stalled cursor, not retry logic. |
| readWholeLog reads every window to the end (the download) | KEEP | Full download must concatenate every log window rather than only the displayed tail or first response; follower and download are separate implementations. |
| parseWorkflowLogWindow reads the X-Log-* headers, case-insensitively | KEEP | Case-insensitive X-Log headers must decode cursor/eof/size/live correctly and missing headers fall back to raw response bytes; concrete wire protocol parser. |

## `packages/ui/src/components/workflows/steps/steps-logic.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.4 Steps add/connect/move/delete/duplicate/disable. **Seam/consumers:** steps-logic.ts graph editing; StepsView and StepSheets.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| splices into a chain without losing downstream connections | CONSOLIDATE | Adding after an occupied output must preserve downstream chain connections; this selection/splice decision is distinct from lower canvas insertion mutation. Surviving owner also asserts the requested new block type, preserving the unique type assertion from removed direct canvas setup without another execution. |
| a block with no outputs (Stop) never splices: it becomes another branch | CONSOLIDATE | Adding Stop must keep existing downstream path as a sibling branch because Stop has no onward output; prevents silently cutting off workflow work. Surviving owner also asserts the requested new block type, preserving the unique type assertion from removed direct canvas setup without another execution. |
| the first step goes after the trigger; with no trigger, loose | KEEP | The first executable step must attach to an available trigger, while a new trigger in an empty graph remains standalone. |
| connect candidates: connectable first, with why the rest cannot | KEEP | Connect choices must omit self/triggers and favor legal targets while explaining illegal ancestors; edge validation alone cannot detect missing legal choices. |
| move to another output: re-hangs the row's edge; loops are refused | KEEP | Moving must change the selected incoming edge and preserve downstream edges; refused descendant move must keep graph intact and current candidate identified. |
| deleting a middle step heals the chain | KEEP | Deleting a simple middle step must heal predecessor→successor rather than cut off downstream work. |
| a join (two edges in) is deleted without guessing a heal | KEEP | Deleting a multi-input join must avoid inventing ambiguous replacement paths, preserving independent upstream branches. |
| duplicate puts the copy right after the original, taking over what it fed | KEEP | Duplicate-after must splice the copied block into the selected chain; clipboard reminting tests do not own Steps graph wiring. |
| disable / enable | KEEP | Disable/enable must affect only the selected block IDs and reverse cleanly; false-versus-omitted property spelling is not asserted. |

## `packages/ui/src/hooks/use-back-close.dom.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.4 mobile overlay/touch interactions; browser history/pointer event semantics. **Seam/consumers:** mounted use-back-close hook receiving real DOM events; phone overlays and row context menus.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| Back closes the overlay; a refused close holds a fresh entry; a UI close gives it back | KEEP | Browser Back must ask the mounted phone overlay to close, rearm after refusal and release its history entry after a UI close. Detects navigation leaving the app or calling close twice; the pure history-stack tests do not exercise hook registration and React state. |

## `packages/ui/src/hooks/use-long-press.dom.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.4 mobile overlay/touch interactions; browser history/pointer event semantics. **Seam/consumers:** mounted use-long-press hook receiving real DOM events; phone overlays and row context menus.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| a resting finger opens it once, where it rests, and the click that follows is swallowed | REWRITE | A completed touch press opens once at the input point, suppresses its synthetic click and permits a subsequent ordinary tap. Detects duplicate actions or a menu opening at the wrong pointer data. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| a tap stays a click | REWRITE | A short touch ending after 200 virtual ms must stay a click and leave no delayed menu action. Detects immediate press classification or failure to cancel its timer. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| a finger that moves (or that the browser takes for a scroll) is not a press | REWRITE | A moved or browser-cancelled touch must never open its menu after pending timers drain. Detects scrolling opening a context menu. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| a mouse never starts the timer; its right click opens the menu | REWRITE | Mouse pointer-down must not become a touch press; right-click must open the menu and suppress the native context menu. Detects wrong input-device classification. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| Android's long-press contextmenu and the timer open it once between them | REWRITE | Android contextmenu-before-timer and timer-before-contextmenu must each open exactly once and suppress the following click. Detects duplicate menus across the two event orderings. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| a mouse event the touch still emits does not reach the menu's outside-click listener | REWRITE | The synthetic mouse-down following a completed touch must not reach an outside-click handler, while a fresh mouse-down must. Detects a newly opened menu immediately closing itself. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |
| a row unmounted mid-press opens nothing | REWRITE | Unmounting a row with a pending press must cancel it. Detects a detached row opening a menu after navigation. Replace imported timeout-derived assertions with fake-timer completion/cancellation; retain a literal short-tap check and remove the otherwise unused exported timeout. |

## `packages/ui/src/icons/registry-icons.test.ts`

**Source:** AGENTS.md untrusted wire payloads; registry id fallback contract. **Seam/consumers:** registry-icons.tsx getRegistryIcon rendered by React; tabs, registry menus and workflow agent rows.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| an id naming an Object.prototype member falls back to the generic icon instead of crashing | KEEP | Wire-supplied registry ids matching Object.prototype keys must render a nonempty fallback rather than resolve inherited methods as React components. Detects a reproducible crash from ids such as constructor; no other rendering test uses these ids. |

## `packages/ui/src/lib/workflows/agent-policy-text.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.2 account policies; §7.2 account inspector. **Seam/consumers:** inspector-usage.ts account view/edit functions; AccountPolicyEditor and ChainEditor.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| reads no list as every account, the System login last when included | KEEP | No allow-list means all managed accounts; opt-in system login follows them. Detects hiding available accounts or silently choosing system credentials. |
| matches ids, then labels, keeps list order, and reports entries naming nobody | KEEP | Detects resolving an account label to the wrong credential, changing fixed priority, losing missing-account warnings, or duplicating selected identities. |
| unticks an account into a list, and back to no list when all are ticked | KEEP | Checkbox edits must encode the intended allowed credential set in AccountPolicy; detects accidental all-account permission after an exclusion. |
| never writes an empty list (the engine would read it as every account) | KEEP | Unchecking the last account must refuse an empty allow-list because daemon semantics interpret it as every credential, a concrete privilege widening bug. |
| excludes accounts in fixed order, keeping the order of the rest | KEEP | Removing and restoring credentials must preserve the remaining fixed priority; otherwise the next run uses the wrong account. |
| moves accounts in fixed order and drops a list that is back in the family's order | KEEP | Reordering must change account priority and respect endpoints/system identity without changing allowed membership; adjacent toggle tests do not exercise movement. |
| adds and removes the System login in a list | KEEP | System opt-in/out must update both wire flags and explicit membership; otherwise the daemon may run under unintended host credentials. |
| keeps entries naming nobody until they are dropped | KEEP | An unrelated checkbox edit must preserve unknown account references; explicit removal and allow-all actions have separately specified data effects. |
| drops an order-only list when leaving fixed order, and keeps a real restriction | KEEP | Strategy changes must preserve credential restrictions while removing ordering that no longer applies; detects silently broadening a restricted policy. |
| lists reported windows, each rule for them, then rules for windows not reported | KEEP | Every configured scoped quota rule must remain editable, including missing and case-equivalent reported windows; literal rule indices identify the persisted policy entry, not visual geometry. |

## `packages/ui/src/lib/workflows/app-wiring.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 workflow tab identity and event updates. **Seam/consumers:** store/app.ts applyEvent/openWorkflowTab/closeTab; WorkflowsHost, TabStrip and TabSwitcher.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| the same message on another channel does not reach workflows | KEEP | An unrelated event channel could mutate workflow state; the positive route test prevents a reject-all implementation from passing. |
| opens one tab per workflow per project, reusing it and updating its run | KEEP | Opening/reopening a workflow must preserve one tab per project, selection and omitted-versus-null run identity; other tab cases do not exercise reuse. |
| an unknown workflow takes the caller's title | KEEP | Before list loading completes a newly opened tab must use the caller-supplied name, not lose it. |
| follows a rename and closes with its workflow, handing the focus on | KEEP | Remote rename/delete must update every project tab and transfer focus after removal; reducer tests cannot detect stale app tab state. |
| closeTab closes a workflow tab like any local tab | KEEP | Explicit closeTab must remove the workflow tab and active selection; remote-delete coverage uses another action. |

## `packages/ui/src/lib/workflows/chain-models.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.1 agent chain; current provider model-slug wire contract. **Seam/consumers:** chain-models.ts creation/default-model resolution; templates.ts, use-workflow-editor, canvas and Steps creation.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| resolves each entry against its own agent's loaded catalogue and keeps the rest | KEEP | New requests must name live slugs per provider without changing unrelated account policy or unknown providers; catches cross-provider model selection and stale aliases. |
| never resolves against a list that may be a fallback: pending, degraded or errored | KEEP | Unready provider fallback catalogues must not overwrite stored live slugs; literal status fixtures differ from live resolution and catch data loss during discovery. |
| a fresh agent block names a listed model; other blocks are their defaults | KEEP | Fresh blocks resolve against provider defaults independently of complete template requests; catches creation of a block with an immediately invalid model. |

## `packages/ui/src/lib/workflows/clipboard.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 clipboard; §3.3 expression node references. **Seam/consumers:** clipboard.ts serialize/parse/paste; WorkflowEditorTab and Steps duplicate.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| carries the selected blocks and only the edges between them, under the marker | KEEP | Only selected nodes and internal edges travel with literal interoperable marker bytes; paste tests do not prove exported payload boundaries. |
| is not fooled by other text, or by a payload whose blocks do not parse | KEEP | Unrelated text, unsupported marker versions and malformed node payloads must not paste; the unsupported-version fixture otherwise contains a valid node. |
| re-mints ids and names and keeps inner edges and references | KEEP | Paste must remint identity and internal references while retaining external references; a sequential/string-only rename would corrupt continued sessions or templates. |
| keeps a name that is free in the target workflow (a paste across workflows) | KEEP | Cross-workflow paste must preserve an unoccupied name; collision tests exercise a distinct branch. |
| does not turn A→B, B→C renames into A→C | KEEP | Simultaneous Post/Post2 collisions must not cascade into references to the wrong copied node; literals independently identify the intended destinations. |

## `packages/ui/src/lib/workflows/deep-link.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.11 notification navigation; service-worker message protocol. **Seam/consumers:** deep-link.ts parse/consume/decide; apps/web main and WorkflowsHost.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| parses ?workflow=&run= | KEEP | URL workflow/run identifiers must parse and unsafe/invalid identifiers reject; message parsing has a separate input format. |
| strips its parameters and keeps the rest | KEEP | Consuming a link must remove only workflow/run query fields and preserve other query/hash/path state, avoiding repeated opens or lost routes. |
| parses the service worker's message; anything else is null | KEEP | Only the literal service-worker message type with valid identity may navigate; URL parsing cannot detect malformed bridge messages. |
| one pending link, taken once, listeners told | KEEP | Newest pending notification navigation must be delivered once rather than replay old/opened targets; subscriber/queue seam is used by WorkflowsHost. |
| waits for the connection and the workflows, opens in the workflow's own project | KEEP | Navigation must wait for a connection/loading, choose the workflow project and distinguish a removed workflow; URL decoding does not own readiness. |

## `packages/ui/src/lib/workflows/durations.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.9 execution limits; canonical seconds/minutes wire units. **Seam/consumers:** durations.ts canonicalDuration; DurationInput.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| converts typed values to the canonical unit without float noise | KEEP | Typed fractional hours/minutes must become mathematically correct persisted minutes/seconds; literal 30/6/20/90 values catch unit or floating-point conversion errors. |
| clamps in the canonical unit, never at a converted bound | KEEP | A one-minute minimum must remain exactly one minute after hour editing; detects rounding the converted floor into an invalid stored bound. |

## `packages/ui/src/lib/workflows/editor-store.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 autosave/conflicts/undo/validation; §8.1 revision protocol; Agent Profiles design §5.5. **Seam/consumers:** editor-store.ts WorkflowEditor and editor registry; use-workflow-editor, WorkflowEditorTab and PhoneEditor.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| a missing workflow is an error with words, not a crash | KEEP | A missing remote workflow must yield an error state and no editable draft, not throw through the editor. |
| saves 600 ms after the last change, once, with the revision the draft is based on | KEEP | Edits must debounce 600ms from the last edit and submit the latest draft against its known revision; literal time comes from §7.2, not imported production constants. |
| serializes saves: a change during a save is saved right after it, on the new revision | KEEP | A save crossing another edit must not issue concurrent stale writes or discard the newer edit; held network response exposes a real revision race. |
| a failed save says so and keeps the edit; flush retries it | KEEP | A transport failure must retain unsaved user text and flush must retry it; the fake provides failure/success responses, not editor state logic. |
| an enabled draft the daemon refuses as invalid is saved disabled, and the editor says so | KEEP | An invalid enabled draft must retain the edit by saving it disabled and expose that state to the user, per errors-block-enabling-not-saving requirement. |
| a 409 raises the banner and stops autosaving | KEEP | A stale revision response must stop automatic overwrite attempts and expose conflict; otherwise another client's edit is silently lost. |
| Reload takes their copy and drops the edits (and the undo history) | KEEP | Reload must take the remote version and clear stale local history; the conflict prompt's discard action differs from overwrite. |
| Keep mine overwrites theirs with the draft | KEEP | Keep mine must fetch current revision and save the retained draft; otherwise a conflict cannot be resolved in favor of local edits. |
| a newer revision while clean reloads silently | KEEP | A newer remote revision must refresh a clean editor; dirty-draft conflict coverage cannot detect stale clean views. |
| a newer revision over unsaved edits raises the banner | KEEP | A remote update must preserve unsaved local edits and surface conflict; save-response 409 coverage does not exercise the event path. |
| an own-save event before its response preserves the draft without a false conflict | KEEP | An own-save event can precede its HTTP answer without generating a false conflict or losing edits; distinct event/response race. |
| undo drops a selection of blocks the older draft does not have | KEEP | Undoing an inserted node must drop its selected identity, preventing an inspector selection pointing at a nonexistent node; history-only snapshots cannot prove this. |
| enabling saves pending edits first, then patches set_enabled on the new revision | KEEP | Enable must flush pending draft first and patch the new revision; otherwise enabling creates stale conflicts or loses the latest edit. |
| validates the draft a moment after each change | KEEP | Editing an expression to reference a missing node must publish validation problems; validator tests do not prove validation is scheduled after a UI edit. |
| a block naming a profile the loaded list does not hold is flagged as the daemon flags it; none is checked before the list loads | KEEP | Profile validation must wait for a loaded profile list, warn for a missing id and clear the warning when the profile arrives. Detects false validation errors during loading or a permanently stale profile warning. |
| marks a model the live catalogue does not list, as the daemon does — and follows the catalogue | KEEP | Remove exact model diagnostic prose; keep error severity, node identity, field path and eventual disappearance after catalogue refresh. These stable data identify the invalid choice. |
| a catalogue not loaded yet raises no false errors | KEEP | Partial registry/provider discovery must not block valid edits with invented unknown-model errors; distinguishes not-loaded warnings from invalid live models. |
| a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id) | KEEP | A rebuilt client for the same connection must retain unsaved draft and write through the new transport, while another connection gets isolated state. |
| a load that lands after the user typed keeps the edit and raises the banner | KEEP | Typing while a remote load is pending must not let its answer replace newer user text; held GET response demonstrates the race. |
| an Enable event before its response preserves enabled state without a false conflict | KEEP | An enable event preceding its HTTP answer must not falsely conflict or revert enabled state; separate patch path from save echoes. |
| undo never flips enabled | KEEP | Undo must restore edited content while leaving enabled state alone; undoing rename must not accidentally resume/pause triggers. |
| reconnect: a failed save is retried; a newer daemon revision is a conflict | KEEP | Reconnect must retry a failed dirty save only when the daemon revision still matches, otherwise preserve the draft as conflict. |
| flushAllWorkflowEditors saves a pending edit at once (pagehide) | KEEP | The pagehide flush operation must submit a pending draft before the debounce fires; editor registry iteration is production lifecycle ownership. |

## `packages/ui/src/lib/workflows/flow-settings.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 Wait inspector; AGENTS.md tolerant unknown config fields. **Seam/consumers:** flow-settings.ts waitConfigForKind; FlowSettings.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| drops the other kind's fields and keeps unknown ones | KEEP | Switching Wait variants must remove incompatible fields and retain forward-compatible data; same-kind re-selection must not reset an existing wait. |

## `packages/ui/src/lib/workflows/format.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.1 list filters; §7.2 workflow creation; §6.2 poll errors. **Seam/consumers:** format.ts list/run data and new-workflow.ts request resolution; WorkflowsPanel, new-workflow form and trigger cards.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| times a run: its duration once ended, the time so far while running | KEEP | Live duration uses elapsed time and ended duration uses recorded duration, with unknown start remaining unknown; these are displayed numeric data rather than prose. |
| shows the running run over a queued one | KEEP | When queued and running runs coexist, the card must report the running one; run-mode selection owns a different run list and policy. |
| filters by scope, by running, and by the search | KEEP | Project/running/search filters must expose the right workflow IDs and normalize trailing slashes; a failed filter hides the user's workflows. |
| a blank workflow is one manual trigger the daemon names and places, in the browser's time zone | KEEP | Blank-create request must carry a manual trigger, selected project and timezone without invented node IDs; this is caller-visible REST data rather than a template markup snapshot. |
| defaults to this project, and resolves each target | KEEP | New-workflow form must resolve this/other/temp clone choices to their correct target paths and trimmed input; daemon schema does not own form-to-request conversion. |
| names the first thing missing | KEEP | Incomplete/oversized creation data must report the missing field and refuse submission; successful resolution cases supply the complementary positive control. |
| maps each trigger whose last poll failed to its error, and nothing else | KEEP | Poll failure messages must be associated with the correct trigger ID and absent failures omitted; backend trigger tests cannot prove UI association. |

## `packages/ui/src/lib/workflows/history.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2 undo/redo, coalescing and 100-step history. **Seam/consumers:** history.ts SnapshotHistory; WorkflowEditor.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| undo hands back the state before each change, redo walks forward again | KEEP | Undo/redo must return chronological pre-edit snapshots and stop at the ends; editor integration cases do not cover multi-step replay. |
| a burst with one key is one step; a pause or another key starts a new one | KEEP | A drag/typing burst must undo in one step while a pause or different field starts another; prevents fragmented or conflated user undo operations. |
| null keys and history navigation keep separate edit steps | KEEP | Explicit non-coalesced edits and edits following undo/redo must remain separate history steps. Detects a user undo skipping edits because history navigation accidentally continued the previous burst. |
| a new change after an undo drops what could be redone | KEEP | Editing after undo must discard the abandoned redo branch, preventing restoration of superseded user work. |
| keeps at most 100 steps, dropping the oldest | KEEP | History must enforce the independently specified 100-step retention without discarding newer edits first; no geometry assertion. |

## `packages/ui/src/lib/workflows/inspector-autocomplete.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §3.2 block outputs; §3.3 expression grammar; §7.2 autocomplete. **Seam/consumers:** inspector-autocomplete.ts completion requests; TemplateEditor.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| offers the roots right after {{ | KEEP | An opening expression must offer valid language roots and prefix filtering; roots are independently documented expression names, not UI copy. |
| walks nodes → a block → output → its known fields, from the caret back | KEEP | Nested node/output/error/PR paths must suggest accessible properties and replace only the typed suffix; this catches invalid completions or overwriting surrounding text. |
| knows the trigger's fields, the run, the project, the secrets and the input | KEEP | Context-specific trigger/run/project/secret/input completions must expose values supported by the expression protocol; dynamic secret names are supplied data. |
| offers filters after a pipe, with arguments filled in | KEEP | Pipe completion must yield executable filter syntax including required arguments; path completion tests cannot detect malformed filter insertion. |
| says nothing outside an expression, after one closed, or after an escape | KEEP | Plain, closed or escaped expression text must not activate completion; otherwise editor typing is interrupted outside the template language. |
| offers {variables} in a prompt only, and never inside {{ | KEEP | Saved-prompt single-brace variables are enabled only in prompt scope; ordinary template fields must not receive unsupported expansions. |

## `packages/ui/src/lib/workflows/inspector-data.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.2/§7.6 pinning; §8.1 null unpin wire operation and maxPinnedBytes configuration. **Seam/consumers:** inspector-data.ts pin parse/read/reference; DataTab.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| refuses JSON over the pinned-data limit | KEEP | Pinned-data form must reject payloads above the independent 1 MiB storage limit before saving them. |
| refuses null, which set_pinned would read as unpin | KEEP | Reject null to avoid removing a pin; preserve false and zero as real JSON values. These independent protocol sentinels catch truthiness bugs. |
| explains a syntax error | KEEP | Malformed JSON must return an actionable error instead of throwing through the form or accepting broken data; valid scalar case supplies a positive control. |
| writes the template reference to a block's output | KEEP | Copied template text must use the literal documented nodes.Name.output grammar; these are executable bytes, not optional presentation wording. |
| pins a whole recorded output as is, without asking the daemon | KEEP | A whole recorded output must be pinnable without an unnecessary request. Detects replacing valid recorded data or requiring a network round trip before pinning. |
| reads the whole output when the run kept only a preview | KEEP | A truncated recorded output must be replaced by the full daemon output before pinning. Detects a subsequent test run executing against preview data. |
| refuses a malformed answer rather than pinning the preview | KEEP | A malformed full-output response must reject instead of pinning preview data. Detects silent corruption of pinned test-run inputs after a bad response. |

## `packages/ui/src/lib/workflows/inspector-support.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.2 live account usage; AGENTS.md localStorage validation. **Seam/consumers:** inspector-usage.ts accountUsageRows and inspector-layout.ts loadEditorLayout; AccountPolicyEditor and WorkflowEditorTab.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| joins managed accounts to their windows by id; an expired window says nothing | KEEP | Managed-account usage must join by account identity, omit wrong families and treat expired/stale readings as unknown; selecting another account's usage changes allow-list decisions. |
| loads persisted choices field by field and falls back on unreadable data | KEEP | Malformed localStorage fields cannot poison UI state or discard independently valid fields; literal versioned storage key is the persistence contract. |

## `packages/ui/src/lib/workflows/json-tree.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §3.3 expression paths; §7.3 inspect/copy large JSON. **Seam/consumers:** json-tree.ts children/path/copy; runs/JsonTree.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| escapes quoted keys and keeps root paths usable | KEEP | Copyable expression paths must escape quotes and remain syntactically valid at object/array roots; literal paths catch corrupt template references. |
| pages children with their paths | KEEP | Pages must include the requested array segment/object values with valid paths and no children for leaves; wrong page offsets lose displayed/copied data, not merely row geometry. |
| copies strings raw and preserves JSON values | KEEP | Copying strings must preserve raw text while objects preserve JSON structure; double-quoting strings or corrupting nested JSON breaks user clipboard data. |

## `packages/ui/src/lib/workflows/notifications.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §3.4 run outcomes; §5.11 toast/attention notifications. **Seam/consumers:** notifications.ts public rules and event-fed store; app event router, WorkflowRunToast and attention UI.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| reads notify settings field-wise, defaulting to failures only | KEEP | Missing/malformed notify settings must safely default failures on/successes off while honoring valid booleans; store-success examples do not cover malformed field fallback. |
| counts a Stop block's end as a success and a cancel or a skip as nothing | KEEP | Observe finishedRunNotice output for terminal statuses under failure-only or success-only preferences, and quiet statuses with both enabled; remove direct internal classification assertions and runOutcomeKind export. Catch missing/spurious actual notices rather than private enum labels. |
| preserves the failure's error, project and test-run identity in its toast | CONSOLIDATE | Move unique failure data/project/test metadata and default-success suppression assertions into the existing finished-event→notification-store scenario, then remove duplicate direct helper execution. Owner: packages/ui/src/lib/workflows/notifications.test.ts: raises a toast and an entry once per run, however often the event arrives. |
| says nothing about a sub-workflow's run | CONSOLIDATE | Move unique sub-workflow suppression assertions into the existing finished-event→notification-store scenario, then remove duplicate direct helper execution. Owner: packages/ui/src/lib/workflows/notifications.test.ts: raises a toast and an entry once per run, however often the event arrives. |
| puts failed runs in the Attention Center, never test runs | CONSOLIDATE | Move unique attention navigation/error payload and test-run exclusion assertions into the existing finished-event→notification-store scenario, then remove duplicate direct helper execution. Owner: packages/ui/src/lib/workflows/notifications.test.ts: raises a toast and an entry once per run, however often the event arrives. |
| raises a toast and an entry once per run, however often the event arrives | CONSOLIDATE | Surviving event→store owner now verifies deduplication plus failure data, attention navigation fields, child-run exclusion, default-success suppression and test-run metadata/attention exclusion. It exercises the same public helper algorithms together with actual event sanitization and state publication. |
| stays quiet for the run the user is looking at | KEEP | A visible run already being viewed must not notify; mounted state is distinct from explicitly marking an ended run read. |
| a mounted run in a hidden document does not swallow the failure | KEEP | A hidden document must still surface its mounted run's failure; otherwise background completion silently disappears. |
| viewing a LIVE run never silences its later failure | KEEP | Merely viewing a still-live run must not silence its later failure after leaving; prevents premature read acknowledgement. |
| the workflow summary's notify settings decide (a success toast when asked, no failure when off) | KEEP | Current workflow summary preferences must control failure suppression/success notification; direct pure-rule tests do not exercise preference lookup. |
| clears a run's toast and entry once it is viewed, and stays quiet about it after | KEEP | Viewing one ended run clears only its notices and suppresses replay, while other runs remain visible; distinguishes read state from global dismissal. |
| dismisses the toasts and one entry at a time | KEEP | Dismiss-all toast and dismiss-one attention commands must not accidentally clear unrelated entries or attention state. |
| reads the workflow's notify settings from a loaded run's definition | KEEP | Without a summary, the loaded frozen definition must supply notification preferences, and successful runs never become failure attention entries. |
| forgets everything on a connection switch | KEEP | Reset must clear notices and deduplication memory so the same ID on another connection can notify; it tests the public reset operation, not connection-switch wiring. |

## `packages/ui/src/lib/workflows/open-bridge.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.10 workflow-owner chat navigation; AgentSessionSummary wire shape. **Seam/consumers:** open-bridge.ts subscribe/open/owner parsing; workflow chip and WorkflowsPanel.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| every listener takes the run, and unsubscribing takes it out | KEEP | Open-run delivery must reach subscribers, stop after unsubscribe, and report no listeners so navigation fallback can work. |
| only a chat tab with a whole workflow owner links to a run | KEEP | Only complete workflow-owned agent-chat identity may link to a run; malformed/foreign/shell owner data must not navigate to an unusable target. |

## `packages/ui/src/lib/workflows/overlay.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.3 recorded/live run path and block state. **Seam/consumers:** overlay.ts deriveRunOverlay; WorkflowCanvas.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| per block: status, duration (live for a running one), attempt, handle, account and hops | KEEP | Overlay must preserve actual block duration, selected account, attempt, activity and handle while omitting unreached blocks; independent from timeline mapping owner. |
| edges: taken, active into a running block, dead, idle — read off the source when the lists lag | KEEP | Edges must distinguish executed/live-target/dead/unreached paths even before recorded edge lists catch up; wrong colors here convey wrong execution data, not geometry. |
| a failed block takes its error edge unless the run records another path | KEEP | Failed blocks use error edges and explicit recorded paths override inferred handles; prevents falsely reporting success routes after failure. |

## `packages/ui/src/lib/workflows/process-settings.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §4 shell interpolation safety; §5.9 process/HTTP contracts; §7.2 inspector; shell/loader reserved env and HTTP token grammar. **Seam/consumers:** process-settings.ts request/body/env editing helpers; ProcessSettings.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| leaves the config untouched when the kind is already chosen | KEEP | Re-picking HTTP body kind must not destroy form fields or text content type already entered by the user. |
| carries a written value across, and starts JSON as an empty object | KEEP | HTTP body edits must preserve entered text when convertible, clear removed bodies and create valid JSON for a newly enabled body. |
| keeps the success statuses when their mode is re-picked, and restores the latest list | KEEP | Switching response acceptance mode must not discard the remembered custom status codes; parser tests do not own form state conversion. |
| reads codes separated by commas, semicolons or spaces, once each, in order | KEEP | User-entered HTTP status lists must preserve numeric meanings and remove duplicate codes across supported separators. |
| names what isn't a status code | KEEP | HTTP codes outside 100..599 and nonnumeric tokens must surface validation problems; a positive valid list prevents reject-all behavior. |
| accepts JSON, with expressions standing in for values or inside strings | KEEP | Valid HTTP JSON templates containing raw expression values or quoted strings must not be blocked by JSON-only parsing. |
| accepts exactly one expression: its value is encoded as JSON | KEEP | An entire HTTP JSON body may be a raw expression; prefix/suffix whitespace cannot make that protocol form invalid. |
| names a body that won't parse, without positions into the stand-in text | KEEP | Invalid JSON structure must show a problem without offsets into generated placeholder text; fixtures include adjacent expressions and unquoted keys. |
| plans one row per distinct expression | KEEP | Repeated references to the same shell expression must share one environment row while different expressions receive distinct usable variables. Detects duplicate mappings or one expression overwriting another. |
| never suggests a name the shell, the loader or a common tool reads | KEEP | Use literal dangerous shell/tool names as an independent forbidden set and assert proposed names are usable, nonreserved and carry the expression. Remove exact WF_ naming and circular isReservedEnvName oracle; make that helper internal. |
| never takes a name a row or a word of the script already uses | KEEP | Keep collisions with existing environment and script assignments plus invalid-name avoidance; assert names are distinct from occupied names, not arbitrary numeric suffix selection. |
| reuses a row only when it holds exactly that expression and wins at run time | KEEP | Keep exact-match reuse and rejection of whitespace/prefix/filter/shadowed/reserved mismatches, asserting reused versus newly allocated identity without freezing invented new names. |
| doesn't reuse a row the script itself sets or reads other than as $NAME | KEEP | Keep assignment/read/nameref/default-assignment collision cases and plain-read reuse, with independent A identity instead of prescribed INPUT_A fallback. |
| keeps every row as it was, fields a newer version wrote included | KEEP | Keep unknown fields and reused existing rows, then assert the appended expression value; remove new variable spelling irrelevant to persisted-data preservation. |
| adds nothing the second time, also once the script reads the variables | KEEP | Keep idempotence and halfway-manual-replacement reuse; build the second input from actual suggested identities, with unchanged environment as the independent idempotence oracle. |
| leaves Go-style {{.Field}} alone and notes a broken expression | KEEP | Keep expression/Go-template discrimination and incomplete-state output; remove invented INPUT_REPO spelling. |
| flags environment names the shell block fails on, and repeats | KEEP | Environment row editing must identify invalid names, missing names and shadowed duplicates; last-row-wins semantics comes from shell environment execution. |
| flags header names the HTTP block fails on and nameless rows it skips | KEEP | Invalid HTTP header tokens must error while query names may contain spaces; missing name with data must warn rather than silently lose input. |

## `packages/ui/src/lib/workflows/run-behaviour.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.9 timeout units and limits; current daemon blockTimeoutMs contract. **Seam/consumers:** run-behaviour.ts movedTimeoutPatch; CommonSettings.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| moves the value as the daemon applies it, capped at the type's maximum | KEEP | Migration of legacy timeout values must preserve minutes for processes, convert to seconds for HTTP and honor independent 24h/1h limits. |
| has nothing to move for other types or without a value | KEEP | Migration must not invent a process timeout for agent blocks or absent legacy values; positive migration cases prevent no-op implementations passing. |

## `packages/ui/src/lib/workflows/run-view.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.4 retry and input semantics; §7.3/§7.4 run inspection. **Seam/consumers:** run-view.ts and runs-mode.ts view/action data; RunTimeline, BlockRunDetails and RunsMode.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| preserves failed block details and distinguishes unreached steps in a finished run | KEEP | Completed runs must retain errors/attempt/duration and mark unreached blocks skipped; failed block must be selected for diagnosis. |
| shows a working agent's account, hops and activity | KEEP | Live agent steps must show the current account/activity/duration and select that step while downstream unstarted steps remain pending; finished-run case cannot detect premature skipped state. |
| builds a block's input from its live upstreams | KEEP | Run details must reconstruct trigger/single live branch inputs and exclude untaken/skipped edges; inspector DataTab uses a distinct implementation. |
| merges several live inputs by name | KEEP | Multiple live inputs merge under predecessor names and propagate truncation; single-source case does not catch overwrite or false-whole display. |
| offers what makes sense now | KEEP | Only meaningful cancel/retry/retry-failed/delete-temp actions are offered for current run state; wrong actions affect caller-visible commands. |
| retries with the same input, or from the same event | KEEP | Retries must preserve input/event/test identity and avoid empty requests before trigger data loads; asserts exact independently defined wire fields. |
| filters by status and counts each filter | KEEP | Status filters/counts must group stopped with success and interrupted with failure; verifies selected run IDs and data counts, not rendered row counts. |
| merges the live page with older pages, the live copy winning, newest first | KEEP | History merging must preserve one row per run with live/known state winning and chronological order; initial store list loads do not own older-page composition. |
| shows the run asked for, else the newest live one, else the newest | KEEP | Run navigation must keep an explicitly requested older run, otherwise select a live run before a completed one and handle an empty list. Detects jumping away from a notification target. |

## `packages/ui/src/lib/workflows/store.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §7.1/§7.3 lists/runs/events; §8.1 revision/errors; AGENTS.md bridge validation and connection isolation. **Seam/consumers:** store.ts load/event/mutation boundary, sanitize.ts wire parsing; workflow hooks, rail, editor and runs views.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| drops a row with no id or name, and repairs the rest field by field | KEEP | Malformed summary rows/fields must not enter typed client state or attach another workflow's run; fixtures independently specify valid vs invalid wire values. |
| keeps the listed errors and what they leave out | KEEP | Wire summary errors and omitted count must survive sanitization so a truncated list still communicates all blocking failures. |
| an older daemon's row (the count alone) has no list | KEEP | Mixed-version summary compatibility must retain error counts without fabricating detailed problems absent from the old daemon response. |
| repairs a malformed list entry by entry, and never counts fewer errors than it lists | KEEP | Malformed error arrays must retain valid blocking problems, drop warnings/invalid entries, and avoid contradictory counts; AGENTS demands payload validation. |
| loads once, shares a request in flight, and refreshes when stale | KEEP | Concurrent panel consumers share a load, loaded data stays cached, and stale refresh removes absent workflows; visible refresh convergence plus request lifecycle, not private collaborator ordering. |
| a failure is the error state, and a refresh failure keeps the rows | KEEP | Initial load error must surface, while refresh failure retains prior rows with stale/error state; prevents disappearing workflows during network outages. |
| an event that crosses the answer is not undone by it | KEEP | A list response crossing newer upsert/delete events must not regress names or resurrect deleted records; held response catches real network race. |
| a client of another connection resets first | KEEP | Loading another connection must replace prior daemon data rather than mix identically scoped workflows. |
| ignores malformed payloads and unknown types without a throw | KEEP | Malformed or unknown events must leave state intact and avoid throwing through event dispatch; valid event cases make this meaningful validation coverage. |
| repeated events neither duplicate rows nor resurrect deleted workflows | KEEP | Repeated upserts must preserve one record and cannot defeat deletion tombstones; detects reconnect event replay resurrecting removed workflows. |
| a run's start, updates and end fold into its workflow's row | KEEP | Run start/progress/end must update row/cache together and never revert terminal state due to late events or stale summaries; lower server tests do not protect UI convergence. |
| a secrets change marks the scopes it touches stale | KEEP | Workflow-scoped secret changes stale only that scope; global changes stale every inherited list and malformed scoped metadata is discarded. |
| block updates accept a retry but ignore an earlier attempt or state | KEEP | A retry's newer attempt may return to running while old attempts/earlier same-attempt states cannot regress progress; unique ordering invariant. |
| a workflow's recent runs load newest first, and a started run joins them | KEEP | Recent runs must be isolated by workflow, ordered newest first, and accept new started runs; pagination composition is a separate caller. |
| a loaded run keeps the deltas that landed while it was in flight | KEEP | A loaded detail response must retain newer block deltas received in flight while adding previously unknown blocks. |
| a reconnect marks a held run stale; a forced reload clears it and takes the run's end | KEEP | Reconnect must mark held detail stale and a successful forced fetch must learn its terminal status and clear staleness. |
| a list refresh updates the summary of a run held whole | KEEP | A history refresh must update an already loaded whole run's summary, recovering missed terminal events through a different response path. |
| a run whose definition does not parse is not published and does not crash | KEEP | Malformed frozen workflow definitions must be discarded before shared run state while load remains safe; catches invalid protocol data reaching run renderers. |
| enabling shows at once, then carries the daemon's answer | KEEP | Enable must show optimistic state, issue the current revision patch and adopt daemon-confirmed revision/state; daemon patch mocks do not implement UI overrides. |
| a refusal rolls back and becomes the notice; a stale revision is re-read once | KEEP | Stale enable requests must retry with fetched revision; rejected requests must roll back optimistic state and expose a dismissible error notice. |
| an overlap skip offers Run anyway | KEEP | An overlap skip must offer Run anyway and retry with force in the wire request, independently specified in §5.11. |
| create shows the row at once; delete removes it, and a gone workflow counts as deleted | KEEP | Successful create must immediately enter client state; delete of an already-gone server record still removes its client row. |
| a write's own row lists the errors its answer carries | KEEP | Write responses must update the workflow list with actual blocking errors, excluding warnings; list sanitization alone does not exercise write-result conversion. |
| a reset drops answers still in flight | KEEP | Reset during an in-flight response must discard the old answer and remain idle, preventing cross-connection stale data leakage. |

## `packages/ui/src/lib/workflows/temp-projects.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §5.10 workflow-owned temporary project marker. **Seam/consumers:** temp-projects.ts project classification; sidebar project rows.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| marks a project a known run names as its temp project | KEEP | A known run temporary path must mark the corresponding project despite trailing slash normalization; avoids missing workflow attribution. |
| never a deleted one, and never a wf- folder on its name alone | KEEP | Deleted temp projects and merely similarly named user projects must not be attributed to a workflow; positive case prevents reject-all implementation. |

## `packages/ui/src/lib/workflows/trigger-text.test.ts`

**Source:** docs/superpowers/specs/2026-09-28-automated-workflows-design.md §6 triggers; §7.2 trigger edits; AGENTS.md unknown persisted fields. **Seam/consumers:** trigger-text.ts form request editing and cron/JSON; TriggerSettings.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| builds a last-day-of-month cron the scheduler accepts | KEEP | Monthly last-day UI must serialize cron that runs Jan 31 and Feb 28 at selected time; independent calendar dates catch erroneous fixed-day schedules. |
| accepts empty or valid JSON | KEEP | Manual example input permits absence and valid JSON scalars/objects, so optional input must not block workflow editing. |
| points at the line and column of a mistake | KEEP | User JSON diagnostics must locate the actual malformed token in multiline input; asserted line/column are source positions, not arbitrary error prose. |
| re-picking the current schedule kind changes nothing | KEEP | Choosing the existing schedule kind must retain configured times, days and unknown fields; prevents silent resets while editing. |
| switching the schedule kind starts it fresh, keeping the time of day | KEEP | Schedule kind conversion must preserve selected time of day while producing a valid new preset; catches unexpected trigger firing time shifts. |
| re-picking the current repository kind keeps the URL and account | KEEP | Repository source edits must retain URL/credential/unknown fields when kind stays same and remove fields belonging to a different source kind. |
| changing the account keeps every other repository field | KEEP | Credential edits must preserve repository URL and future fields; clearing credentials must omit the account reference rather than send an invalid empty ID. |
| re-picking the current event kind changes nothing | KEEP | Git event kind re-selection must preserve filters and unknown fields; valid variant defaults avoid malformed trigger requests when switching. |
| edits within an event keep its other fields | KEEP | Editing one Git filter must preserve other event configuration and omit cleared optional filters; detects losing actions, future fields or broadened trigger matching. |

## `packages/ui/src/store/auth.test.ts`

**Source:** README.md security model; AGENTS.md privacy; authenticated-session token wire contract. **Seam/consumers:** store/app.ts establish/submitCredentials/signOut/removeRemote; connection coordinator and remote sign-in UI.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| never sends an older build's credential: it prompts for a sign-in instead | KEEP | An obsolete password-derived stored credential must be purged without making an authenticated info request, and the sign-in flow must appear. Detects legacy credential disclosure or unauthenticated fallback. |
| a 401 drops the token, forgets it in memory and prompts once | REWRITE | A refused session token must leave storage and the in-memory client, and cause one sign-in prompt instead of a reconnect loop. Detects continued reuse of revoked credentials; error wording is incidental. |
| an auth-info request that got no answer is retried, never taken for 'no sign-in needed' | KEEP | An unreachable auth-info route must preserve the credential and reject to the connection retry loop without sending an uncredentialed request. Detects interpreting network failure as authentication being disabled. |
| a daemon that answers without auth info (an older build's 404) still needs no sign-in | KEEP | An older daemon with no auth-info route must continue through the compatibility path. Detects old-daemon lockout; this is a 404 route response, distinct from the network-error case. |
| go with the credential when the daemon refuses it — that daemon's alone | KEEP | A daemon refusing credentials must clear only its own persisted chat cache. Detects leaking cached private chats after revocation or deleting another daemon's cache. |
| go when the remote is removed | KEEP | Removing a remote must clear that daemon's persisted chats and preserve other daemon caches. Detects data remaining reachable after disconnecting the remote. |
| go on sign-out | KEEP | Signing out must remove that daemon's persisted chat cache. Detects private chat data remaining after logout; revocation/removal use different app actions. |
| stores the returned token and the username, never the password | KEEP | Login must send normalized username plus the entered password once, persist only returned token/username, then reconnect using that token. Detects password-at-rest or password-derived bearer regressions. |
| a wrong password or a lockout keeps the prompt with its reason and stores nothing | KEEP | 401 and Retry-After-bearing 429 login failures must retain the prompt, expose the refusal/retry duration and store no credentials. Detects accepting rejected login or silently bypassing rate-limit guidance. |
| refuses a response that is not a token | REWRITE | A malformed login token must not be persisted or connected with, and must produce an error state. Detects trusting a legacy/password-equivalent response; exact generated wording is unnecessary. |

## `packages/ui/src/store/create-project-notice.test.ts`

**Source:** README.md git identities and clone transport reporting; ProjectSummary.clone contract. **Seam/consumers:** store/app.ts createProject; project-creation UI.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| says so when the SSH key was refused and the clone went over HTTPS | REWRITE | A successful clone that fell back from SSH to HTTPS must relay the daemon's supplied notice. Detects silent transport fallback; only notice data matters, not the toast title. |
| stays quiet for a clone over its first transport, and for a daemon that sends no report | KEEP | An ordinary clone or older daemon omitting a fallback report must not manufacture a warning. Detects false fallback warnings for normal SSH/HTTPS cloning. |

## `packages/ui/src/store/desktops.test.ts`

**Source:** docs/superpowers/specs/2026-09-30-desktop-tab-design.md §10 and §11.2; DesktopSummary/launch wire contracts. **Seam/consumers:** store/app.ts desktop events and launch/close actions; DesktopView, LaunchAppDialog and TabStrip.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| created and updated upsert; closed removes and moves the active tab on | KEEP | Create/update desktop events must upsert visible data; a close event removes the desktop and hands focus to another tab. Detects stale desktop tabs or lost updates. |
| malformed payloads never reach state | KEEP | Malformed desktop and window event payloads must leave state untouched. Detects unvalidated wire values crashing the desktop UI. |
| desktop.windows patches that desktop's windows and active window | KEEP | A windows event must patch the named desktop's window list/active id without changing another desktop. Detects cross-desktop window routing. |
| closing a desktop dismisses its pending confirm and retargets an open launch dialog | KEEP | A closed desktop must clear its pending close confirmation and retarget an open launch dialog. Detects subsequent launches or confirmations referencing a dead desktop. |
| createDesktopWithApp posts, adds the desktop and activates its tab | KEEP | Creating a desktop with an app must send the public request, hold its returned desktop and activate that project tab. Detects dropped launch data or an invisible successful launch. |
| launchIntoDesktop posts the app, records it and focuses that desktop | KEEP | Launching into an existing desktop must send the app request, attach the returned app and focus that desktop. Detects launches recorded under the wrong desktop. |
| a daemon refusal rejects so the dialog can show it | KEEP | A desktop creation refusal must reject with the API error and add no desktop. Detects a false successful/phantom launch. |
| the launch dialog opens and closes | KEEP | Opening and closing the launch dialog must publish/remove its target through actual app actions. This is the only action-level owner; deleting it would leave a broken menu-open action undetected. |
| running apps always ask first, even with session confirms off | KEEP | Closing a desktop with live apps must ask first even when terminal confirmation is disabled; confirmation invokes the close request. Detects terminating apps without consent. |
| a desktop with no running apps closes without asking | KEEP | A desktop whose apps exited must close without confirmation and remove its tab after the request. Detects an unnecessary blocked close flow. |
| a failed stop keeps the tab and says why; an already-gone desktop is dropped | KEEP | A refused close must preserve its tab and relay the supplied error; an already-missing desktop must be removed. Detects hiding a live failed-to-stop desktop or leaving an unrecoverable stale tab. |

## `packages/ui/src/store/file-reveal.test.ts`

**Source:** agent-chat GUI design changed-file navigation; terminal file:line:col link contract. **Seam/consumers:** store/app.ts revealInFileBrowser; changed-file clicks, terminal links and FileBrowser.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| opens a Files tab on the file when the project has none | KEEP | Revealing a file must create and activate a project Files tab when none exists. Detects changed-file links doing nothing. |
| reuses the first Files tab and bumps the nonce, even for the same file | KEEP | Repeated reveal must reuse the existing Files tab and change the reveal notification even for the same path, without changing other tabs. Detects duplicate tabs or ignored repeated navigation. |
| carries a line and column to jump to (a terminal's file:line:col link) | KEEP | File-link line and column must reach the reveal target and be cleared by a later plain file reveal. Detects lost terminal-link location or a stale jump. |
| does nothing without a current project | KEEP | Reveal outside a project must create no project-local tab. Detects orphaned tabs associated with no active project. |

## `packages/ui/src/store/fork-retry.test.ts`

**Source:** AGENTS.md command idempotency; docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6 lineage. **Seam/consumers:** store/app.ts forkChatTab and session-close actions; chat fork actions.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| re-sends the same commandId after an unknown outcome, and a fresh one once it answered | KEEP | An unknown fork outcome from host unavailability or network loss must retry the same commandId; an answered fork frees that id. Detects duplicated chats after reconnect, through actual app/API calls. |
| a refusal frees the point, and another fork point never reuses the id | KEEP | A definite refusal must free the command id and a different fork point must use another id. Detects unrelated forks being collapsed into a previous idempotent command. |
| closing the stray fork tab (or the daemon taking it back) frees the kept id | KEEP | Closing a stray fork through session events or the app action must free the retained retry id. Detects subsequent forks returning a closed tab or COMMAND_ID_CONFLICT; pure point-isolation cases remain in lineage.logic.test.ts. |

## `packages/ui/src/store/load-projects.test.ts`

**Source:** workspace/project scoping in AGENTS.md; README repository-grouped projects. **Seam/consumers:** store/app.ts loadProjects/closeWorkspace; workspace navigation and project refresh.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| an older listing answering last does not overwrite the newer one | KEEP | A late older project listing must not overwrite the newer listing, including repo identity fields. Detects a clone disappearing from its repository group. |
| stays loading until the newest call settles, whatever the older one does | KEEP | An older failed listing must not clear loading while the newest listing is pending. Detects premature empty-state rendering under concurrent refreshes. |
| a listing that lands after the workspace closed is dropped | KEEP | A listing completing after the workspace closes must not repopulate project state. Detects showing projects from a closed workspace. |

## `packages/ui/src/store/open-tab.test.ts`

**Source:** agent-chat GUI resume workflow; docs/superpowers/specs/2026-10-18-agent-profiles-design.md §5.3; README Agent Profiles failure rules. **Seam/consumers:** store/app.ts openTab and preferred-profile actions; new-chat and resume menus.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| shows the opening screen until the tab exists, and ignores a second click meanwhile | KEEP | Resume must expose its in-flight opening state, suppress double-click launch and activate the returned tab. Detects duplicate sessions or a never-ending opening view. |
| clears the opening screen when the launch fails | KEEP | A failed resumed launch must clear the opening state and propagate the actual error. Detects a permanently blocked composer after launch failure. |
| switches to the tab that already holds the conversation instead of failing | KEEP | CONVERSATION_ALREADY_OPEN with a local owner must activate that tab and clear resume error. Detects refusing a conversation already available in the project. |
| still refuses when the owning tab is not in this project | KEEP | An already-open owner absent from this project must preserve the daemon's refusal instead of activating a foreign tab. Detects cross-project activation. |
| a new chat and a resumed conversation launch with the agent's remembered profile | KEEP | New and resumed agent chats must carry the agent's remembered profile while resume identity remains intact. Detects silent profile omission or broken resume. |
| Global (nothing remembered, or another agent's pick) sends no profile | KEEP | Global and another agent's remembered pick must omit profileId from the launch; explicitly picking Global clears the preference. Detects loading another agent's profile. |
| a deleted profile is no agent's pick any more | KEEP | A deleted-profile event must remove remembered picks of that profile. Detects the next launch being stuck on a deleted kit. |
| a remembered profile the daemon no longer has: the pick is forgotten and the notice says so — nothing launches as Global | REWRITE | A missing remembered profile must clear its preference, explain failure and open no replacement Global session. Detects silent fallback to different instructions. |
| a remembered profile that is not ready keeps the pick and says why and how to pick another | REWRITE | A not-ready remembered profile must keep its preference and relay the preparation failure. Detects silently changing the kit or swallowing the supplied diagnostic; generic help wording is incidental. Current name: a remembered profile that is not ready keeps the pick and reports the failure. |
| another refusal of a launch that named its own profile still throws | KEEP | An explicitly requested missing profile must propagate its refusal instead of applying remembered-profile recovery. Detects incorrectly clearing or overriding a caller's explicit choice. |
| the daemon's profile list prunes remembered picks it does not have (an unreadable one is kept) | KEEP | A loaded profile list must prune missing remembered picks but preserve an unreadable profile reported separately. Detects discarding a recoverable kit or retaining deleted picks. |
| picks are kept per daemon connection | KEEP | Profile preferences must persist under the active daemon connection key. Detects one daemon's choice overwriting another daemon's preference. |
| a terminal launch never carries one | KEEP | Terminal launches must omit Agent Profiles even if the refId has a stored preference. Detects chat-only context leaking into shell requests. |

## `packages/ui/src/store/pending-merges.test.ts`

**Source:** docs/superpowers/specs/2026-10-14-agent-visuals-and-session-tools-design.md §6 pending merge state. **Seam/consumers:** store/app.ts applyEvent session updates; pending merge-back UI.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| arrive with a session update and are cleared by the next one's empty list | KEEP | Session updates must carry pending merge requests and an explicit empty list must clear them. Detects stale merge-back action buttons after the final request completes. |

## `packages/ui/src/store/plugins.test.ts`

**Source:** docs/superpowers/specs/2026-10-14-plugins-ts-rust-design.md §5.3/§6; plugin event wire contract; AGENTS.md validation. **Seam/consumers:** store/app.ts plugin list/events; Settings plugins and gated tool menus.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| a change replaces the whole list | KEEP | A plugins change event must replace the whole list, including changed enable/job state. Detects stale plugin status after another client changes it. |
| malformed payloads and other event types never reach state | KEEP | Malformed plugin payloads and unrelated event types must not change state. Detects unvalidated plugin wire values reaching typed UI state. |
| stores the daemon's list | KEEP | A plugin-list request must publish the daemon's actual list. Detects the initial connect hiding enabled plugins until a later event. |
| rejects with the request's error and keeps the last list | KEEP | A failed plugin refresh must reject with its cause and retain the previous list. Detects presenting failed refresh as success or losing visible plugin state. |
| drops an answer that lands after a connection switch | KEEP | A plugin-list answer from a previous daemon client must be discarded. Detects cross-connection plugin state leakage. |
| applies one plugin's state from a route's answer | DELETE | Duplicate of lib/plugins-state.test.ts insert/replace/null-list coverage: the app action only forwards to upsertPluginIn and this case adds no independent route or event wiring. Fails unique-protection bar 6. Owner: packages/ui/src/lib/plugins-state.test.ts: replacement/insertion/null-list upsertPluginIn case. |

## `packages/ui/src/store/setup-reload.test.ts`

**Source:** docs/superpowers/specs/2026-10-18-repo-grouped-projects-design.md §4 typed-clone grouping; AGENTS.md connection/project scope. **Seam/consumers:** store/app.ts createProjectWithCommand and events; new-project typed clone flow.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| reloads the workspace's projects once when it exits or closes | KEEP | A typed-clone setup terminal exiting must refresh its workspace exactly once, and unrelated exits must not refresh it. Detects a completed clone staying ungrouped or duplicate refresh effects. |
| closing the tab of a running setup also reloads | KEEP | Closing a running setup tab must refresh the new project listing even without an exit event. Detects missing clone state after user close. |
| leaves the list alone when another workspace is open by then | KEEP | A setup exit while another workspace is selected must not replace that workspace's projects. Detects cross-workspace state contamination. |
| follows the project's git status: a landed clone reloads until it shows its repo | KEEP | Git-status events must refresh until the clone has a repo identity, then unsubscribe and ignore a later exit. Detects missing repository grouping or endless refresh after completion. |
| a clone that lands before the terminal is open still reloads | KEEP | A clone-status event arriving before the setup tab resolves must be remembered and applied after creation. Detects fast clones whose only event is lost. |
| stops following when the terminal exits, and when it never opened | KEEP | Following must stop after setup close and after a setup tab never opens. Detects leaked event streams and background refresh after launch failure. |
| while another workspace is open, asks the daemon without touching the store's list | KEEP | While another workspace is open, clone refresh must read its original workspace without mutating the visible project list. Detects cross-workspace list replacement. |
| a template setup is not followed | KEEP | Template setup commands must not acquire clone-follow subscriptions or reload on exit. Detects unbounded monitoring of repos with no clone identity. |
| a connection switch stops every follow | KEEP | A daemon connection switch must stop all clone follows; late git/exit events must no longer refresh. Detects old-connection side effects after navigation. |

## `packages/ui/src/store/whiteboard.test.ts`

**Source:** docs/superpowers/specs/2026-10-15-excalidraw-whiteboard-design.md §3 tab identity/upload/conflict handling. **Seam/consumers:** store/app.ts whiteboard actions; new-whiteboard menu, file browser and tab controls.

**Oracle:** Authored literal payloads, mathematically fixed units/calendar results, protocol fields, input events and supplied error data; fixture setup does not generate expected results from the owner. **Refactor/unique protection:** Assert semantic request/output/state/effects through the production-used boundary; no source grep, DOM/class tree, object identity or private call order requirement. Each surviving row names its distinct action/input/race; protocol/daemon tests do not execute this client policy. Removed duplicate executions identify their surviving owner. **Risk/validation:** Low: no production algorithm changed; retained cases remain, except duplicates with explicit surviving protection. V.

| Baseline test | Disposition | Contract, failure and surviving coverage |
|---|---|---|
| opens a tab per file, titled by the file name, and focuses an open one again | KEEP | Whiteboards must open once per file in a project, use that file's name and reactivate an existing tab. Detects duplicate editor instances for the same drawing. |
| closing the active whiteboard tab activates another tab of the project | KEEP | Closing an active whiteboard must activate another tab in its project. Detects an empty main view while another drawing is open. |
| does nothing outside a project | KEEP | Opening a whiteboard without a project must create no tab. Detects unscoped file-editor state. |
| writes an empty scene to whiteboards/Untitled.excalidraw and opens it | KEEP | New whiteboard creation must upload to whiteboards/Untitled.excalidraw with a non-overwriting conflict policy before opening the returned file. Detects opening an unsaved drawing or overwriting another drawing. |
| takes a numbered name when Untitled is taken | KEEP | An existing Untitled drawing must retry using rename and open the daemon's numbered filename. Detects replacing the existing drawing or losing the successful retry. |
| raises a notice and opens nothing when the file cannot be written | REWRITE | Folder conflict must open no drawing and report an error; an explicitly injected upload failure must preserve its supplied cause in the notice. Detects phantom tabs or silent failed writes, independent of generated copy. |
