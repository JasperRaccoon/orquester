# UI workflows test cleanup

Completed cleanup; this record was written before edits. Companion scopes: [state](ui_workflows_state.md), [run data and steps](ui_workflows_runs.md).

Independent specification: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` (sections below), current API/config wire types and AGENTS.md storage/bridge rules. Current production owners were read before disposition; the design is used only when consistent with those contracts.

Validation for every row: from `packages/ui`, `node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test <retained assigned .test.ts files>`. Typecheck and root gates are integrated by the parent agent. Deletion risk: presentation regressions previously detected by spelling, geometry or source shape are intentionally no longer frozen; data contracts listed below remain at their owning seams.

Six-bar justification for each KEEP/REWRITE below (applied with the concrete case-specific failure, source and owner): **1** the cited independent requirement/wire/storage contract requires the stated result; **2** the listed wrong data, edit or navigation is visible to its named production caller; **3** fixtures and literal expected state/bytes come from that contract, not the implementation or a fake reproducing it; **4** calls observe the actual pure domain owner or app/bridge public operation, never private collaborator shape; **5** assertions constrain semantic results, not implementation identity, rendering, class names or call counts except network avoidance as an observable pin contract; **6** no stronger retained test exercises that same owner/branch, with duplicate source/markup/helper/default-selection cases deleted. Separate inspector/run-view/overlay owners remain separately protected where each independently derives data.

Isolated-unit failure modes before retention: graph edits can admit invalid edges or sever existing paths; clipboard can corrupt identity/references or accept malformed payloads; history can return wrong snapshots, merge unrelated edits or resurrect redo; completion can propose inaccessible/invalid language paths or overwrite the wrong span; bridge parsing can accept malformed data or open wrong/stale targets; JSON paths/copy can corrupt selected values; pins can store previews; usage rows can join the wrong account; persisted layouts can admit unsafe field types; run overlays can highlight the wrong executed branch; run/temp-project selection can misattribute user data. Only tests tied to these failures survive.

## `packages/ui/src/components/workflows/RepoPicker.test.ts`

Independent source: spec §7.2 repository picker. Production seam/callers: RepoPicker.tsx local repoForUrl; no external production caller; production component calls it locally. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `a stored clone URL maps back to the repo it was picked from` — Only private URL lookup equality is observed; a different picker implementation breaks the seam without breaking repository selection. No stronger retained picker test claimed; no independently specified lookup API is lost.
- **DELETE** `a typed URL no listed repo has, an empty value, or no list picks nothing` — Same private lookup boundary, including impossible empty-list housekeeping; no caller-visible picker action is exercised.

## `packages/ui/src/components/workflows/WorkflowChip.test.ts`

Independent source: spec §5.10 chat navigation. Production seam/callers: WorkflowChip.tsx; tab strip and phone tab switcher. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `a workflow's chat tab shows the chip; any other tab shows nothing` — Static tag/text presence duplicates owner-to-target validation in open-bridge.test.ts; markup shape is not the navigation contract.
- **DELETE** `the compact chip is the icon alone, still labelled for a screen reader` — Pins compact presentation copy and visible-text omission. No stable interaction is exercised.
- **DELETE** `clicking the chip opens its run and stops only its own click` — Calls React component as a function and invokes props; absence of handlers is private call shape. open-bridge.test.ts retains target delivery and no-listener behavior.

## `packages/ui/src/components/workflows/canvas/connection.test.ts`

Independent source: spec §3.4 directed graph validity; 7.2 add/insert/delete. Production seam/callers: connection.ts and ops.ts; WorkflowCanvas.tsx, editor-store.ts, steps-logic.ts. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `accepts an output into a block that takes input` — Valid success/false/error outputs may connect to accepting blocks; reject-all guards would fail.
- **REWRITE** `refuses cycles, self-loops and duplicates` — Cycles, self-loops and duplicate edges must be refused; distinct handles remain valid. Drop prose matching in favor of refusal state.
- **REWRITE** `refuses a handle the source does not have, a trigger or a note as target, and notes as a source` — Unknown handles/nodes and non-input targets must be refused; drop exact warning wording. Valid requests in the first case prevent reject-all false positives.
- **REWRITE** `connectBlocks adds the edge, or returns the workflow untouched` — Successful connect adds the requested graph edge; refused cycle leaves graph content unchanged. Drop reference-identity requirement.
- **REWRITE** `adds a block wired from an output, with its default config and a free name` — Add from an output must wire the new block. Drop coordinate and incidental default-name assertions.
- **KEEP** `inserts a block into an edge: source → new → target` — Insertion replaces A→B with A→new→B; missing either link breaks the workflow.
- **REWRITE** `removes blocks with their edges and pinned outputs` — Deleting a block removes incident edges and pinned data; remove no-op object-identity assertion.
- **DELETE** `moves snap to the grid; a nudge moves by grid steps; no move is the same object` — Grid coordinates and private no-op identity pin geometry/optimization rather than a stable user interaction; graph mutation contracts remain above.

## `packages/ui/src/components/workflows/canvas/tap-connect.test.ts`

Independent source: spec §7.4 two-tap connecting; 3.4 connection constraints. Production seam/callers: tap-connect.ts; PhoneEditor.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `start → tap a block: connects, back to idle` — Selecting a legal target returns the requested edge and exits pending selection; prevents lost/wrong two-tap connection.
- **REWRITE** `a refused target keeps picking and says why` — An illegal target keeps selection pending and yields no edge, then legal retry succeeds. Replace exact error-copy matches with refusal presence.
- **KEEP** `its own block or Cancel ends it; a tap while idle does nothing; a new start replaces` — Self-target/cancel clears selection, idle taps do nothing, new source replaces selection; prevents stale accidental connections.
- **DELETE** `the banner names the output` — Banner prose is not a contract; connect selection behavior remains tested above.

## `packages/ui/src/components/workflows/inspector/inspector-keys.test.ts`

Independent source: spec §7.2 inspector edits. Production seam/callers: Inspector.tsx NameField/fieldset/DataTab JSX. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `<NameField key={node.id} / <fieldset key={node.id} / <DataTab key={node.id}` — Parameterized <NameField key={node.id}, <fieldset key={node.id}, <DataTab key={node.id}: source component names and JSX shape do not survive identifier-only refactors. No actual cross-node draft leakage is observed.

## `packages/ui/src/components/workflows/phone/key-bar.test.ts`

Independent source: spec §7.4 editor key bar; 3.3 expression bytes. Production seam/callers: key-bar.ts; KeyBar.tsx plain fields and CodeMirror bridge. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `offers Tab, {{ }} and the hidden characters, in order` — Copies the key declaration list/order and title existence; no insertion action. Remaining text-edit cases protect data-changing keys.
- **KEEP** `a character replaces the selection; the caret goes after it` — Typing a symbol inserts at the caret or replaces forward/backward selection without losing surrounding text.
- **REWRITE** `{{ }} puts the caret inside, or wraps the selection` — Expression insertion/wrapping must produce usable template text and caret position. Remove lower keyBarInsertion duplicate assertion.
- **KEEP** `Tab indents by the editor's unit` — Tab inserts the configured editor indentation, preserving text and caret.
- **DELETE** `an out-of-range selection is clamped` — Out-of-range selection is not supplied by DOM/CodeMirror callers; clamp-only helper detail has no independent requirement.

## `packages/ui/src/lib/workflows/app-wiring.test.ts`

Independent source: spec §7.2 workflow tabs; API workflows event channel; AGENTS connection isolation. Production seam/callers: app.ts applyEvent/openWorkflowTab/closeTab; WorkflowsHost, WorkflowEditor, TabStrip/TabSwitcher. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `an upsert and a delete on the workflows channel reach the module store` — Workflow-channel upsert/delete reaches the module store; prevents stale/missing workflows despite correct store reducer.
- **REWRITE** `the same message on another channel does not, and garbage never throws` — Other channels must not change workflow data. Drop malformed payload coverage already owned by store.test.ts.
- **KEEP** `opens one tab per workflow per project, reusing it and updating its run` — One tab per workflow/project, refocus/reuse and absent-vs-null run selection; prevents duplicate tabs or reopening the wrong run.
- **REWRITE** `an unknown workflow takes the caller's title` — Caller-supplied title survives before a summary arrives; remove default English copy expectation.
- **REWRITE** `follows a rename and closes with its workflow, handing the focus on` — Remote rename updates all tabs and deletion closes them while preserving a next active tab; drop unrelated-upsert object-identity assertion.
- **KEEP** `closeTab closes a workflow tab like any local tab` — closeTab removes workflow tab and clears active selection; public app operation distinct from event deletion.
- **DELETE** `${name} resets them before it switches the client [signOut, selectConnection]` — signOut/selectConnection source-grep family tests function names/order and spread spelling, not connection isolation.
- **DELETE** `withoutWorkflowTabs empties the tabs and clears an active pointer at one` — withoutWorkflowTabs direct exported private helper bypasses the actual switch; remove test-only export. No claimed stronger lifecycle test; source checks never established behavior.
- **DELETE** `project and workspace cleanup drop the workflow tabs too` — Project/workspace cleanup source grep merely finds field spelling; identifier-only rename breaks it.

## `packages/ui/src/lib/workflows/canvas-fit.test.ts`

Independent source: spec §7.5 visual appearance. Production seam/callers: canvas-fit.ts; WorkflowCanvas.tsx and PhoneEditor.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `a small graph never goes below 0.7; a big one may go to 0.35` — Pins zoom/padding geometry and thresholds; no visual artifact.
- **DELETE** `a phone opens on the trigger and the step after it` — Pins opening viewport node list and zoom geometry; no interaction/artifact.
- **DELETE** `puts the first step near the left edge, a little above the middle, readable` — Pins pixel coordinates and zoom arithmetic; not a visual regression test.

## `packages/ui/src/lib/workflows/catalog-ui.test.ts`

Independent source: spec §7.2 palette; 3.4 input eligibility. Production seam/callers: catalog-ui.ts; AddBlockMenu.tsx, BlockPalette.tsx, block cards and inspectors. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `agents: the first choice with its effort, then the fallback` — Exact agent summary copy, punctuation and fallback wording are presentation.
- **DELETE** `agents: the editor's own labels win when it has them` — Stubbed labels are echoed into exact copy; no independent data behavior.
- **DELETE** `triggers: in words` — Exact trigger prose duplicates shared formatter ownership.
- **DELETE** `http: the method and a short URL` — URL-shortening and HTTP summary text are presentation.
- **DELETE** `flow and code blocks` — Flow/code summary strings and line counts are implementation presentation.
- **DELETE** `rule text` — Operator prose and brace stripping are summary presentation.
- **DELETE** `groups every block; a search narrows by title, description and keywords` — Palette group/copy/keyword inventory reproduces declarations; search alias choices have no independent contract.
- **REWRITE** `from an output it offers no triggers and no notes` — Add-from-output palette must offer accepting executable blocks and omit trigger/note types. Add positive executable membership so empty output cannot pass.

## `packages/ui/src/lib/workflows/clipboard.test.ts`

Independent source: spec §7.2 clipboard transfer; 3.3 node references; workflow config schemas. Production seam/callers: clipboard.ts; WorkflowCanvas.tsx, editor-store.ts, steps-logic.ts. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **REWRITE** `carries the selected blocks and only the edges between them, under the marker` — Copy contains selected nodes and internal edges only. Assert literal interoperable marker via JSON.parse, not production marker+parser round-trip.
- **REWRITE** `is not fooled by other text, or by a payload whose blocks do not parse` — Reject non-workflow text, unsupported marker version and malformed nodes. Use literal wire marker independent of production constant and valid nodes for unsupported-version rejection, so the negative test cannot pass due to an empty payload.
- **REWRITE** `re-mints ids and names, keeps inner edges and references, and offsets the copy` — Paste gives unique IDs/names, remaps internal template/continue references, retains external references and internal edges. Drop coordinates.
- **REWRITE** `keeps a name that is free in the target workflow (a paste across workflows)` — Cross-workflow paste preserves a name that is free; remove snapped-position assertion.
- **KEEP** `does not turn A→B, B→C renames into A→C` — Simultaneous Post/Post2 renames must not cascade and corrupt references; independent expected template catches sequential replacement bug.
- **DELETE** `duplicate is copy + paste beside the original` — Duplicate wrapper only checks minted ID/no selection; copy/paste cases above own data preservation.
- **DELETE** `freeNodeName renumbers, and falls back to the type's default for an unusable name` — Private free-name helper branch assertions duplicate paste collision behavior; remove its test-only export.

## `packages/ui/src/lib/workflows/deep-link.test.ts`

Independent source: spec §5.11 notification deep links; web service-worker message protocol; AGENTS validate bridge data. Production seam/callers: deep-link.ts; apps/web entry and WorkflowsHost.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `parses ?workflow=&run=` — URL workflow/run identifiers parse, malformed IDs reject/drop correctly; prevents navigating from invalid external data.
- **KEEP** `strips its parameters and keeps the rest` — Consuming link removes only workflow/run params and preserves other route/query/hash state; prevents replay or lost navigation.
- **REWRITE** `parses the service worker's message; anything else is null` — Service-worker message type and IDs are validated. Use literal message type rather than importing tested declaration.
- **KEEP** `one pending link, taken once, listeners told` — Newest requested link is consumed once and notifies subscribers; prevents stale or repeated notification navigation.
- **KEEP** `waits for the connection and the workflows, opens in the workflow's own project` — Disconnected/unloaded clients wait; known workflow opens its project; deleted workflow becomes gone. Prevents wrong-project/open-before-load behavior.

## `packages/ui/src/lib/workflows/history.test.ts`

Independent source: spec §7.2 snapshot undo/redo, 100 steps and coalesced drags. Production seam/callers: history.ts; WorkflowEditorStore owns one SnapshotHistory. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `undo hands back the state before each change, redo walks forward again` — Undo/redo returns exact prior/future states in order and terminates at the boundary; prevents lost or repeated edits.
- **REWRITE** `a burst with one key inside the window is one step; a pause or another key starts a new one` — Burst changes undo together; separated edits/keys remain separate. Use explicit distant times and undo outputs, not production timeout constant/private size.
- **REWRITE** `a null key never coalesces, and seal() ends a burst early` — Discrete edits and explicit end-of-drag seal remain separate undo steps. Verify returned snapshots instead of stack length.
- **KEEP** `a new change after an undo drops what could be redone` — New edit after undo discards redo branch; prevents resurrecting overwritten work.
- **REWRITE** `keeps at most the limit of steps, dropping the oldest` — Default history retains newest 100 steps. Count actual undo results; remove test-only configurable limit and size getter.

## `packages/ui/src/lib/workflows/inspector-autocomplete.test.ts`

Independent source: spec §3.2 output fields; 3.3 expression language; 7.2 upstream completion. Production seam/callers: inspector-autocomplete.ts; TemplateEditor.tsx, BlockInspectors.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **REWRITE** `lists only the blocks upstream, the triggers, and the direct input's fields` — Only upstream nodes and corresponding direct input fields are offered. Compare field/name sets without incidental ordering.
- **REWRITE** `offers the roots right after {{` — Expression roots complete and typed prefix filters candidates. Compare roots without ranking assertion.
- **REWRITE** `walks nodes → a block → output → its known fields, from the caret back` — Nested node/output/error/PR paths complete and replacement span covers typed suffix only. Compare candidate sets without ranking assertion.
- **REWRITE** `knows the trigger's fields, the run, the project, the secrets and the input` — Trigger/run/project/secret/input completions expose the documented names, not unrelated namespaces; compare sets without order.
- **KEEP** `offers filters after a pipe, with arguments filled in` — Filter completion inserts valid default argument syntax and offers json; prevents malformed inserted expressions.
- **KEEP** `says nothing outside an expression, after one closed, or after an escape` — Outside/closed/escaped expression syntax yields no completion; prevents destructive editor replacement.
- **KEEP** `offers {variables} in a prompt only, and never inside {{` — Single-brace prompt variables complete only in prompt contexts, not ordinary fields; prevents unsupported variable insertion.

## `packages/ui/src/lib/workflows/inspector-pin.test.ts`

Independent source: spec §7.6 pins must be whole outputs used by test runs; log/output wire preview flag. Production seam/callers: inspector-data.ts pinnableOutputOf; DataTab.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `pins a whole recorded output as is, without asking the daemon` — A complete recorded output is returned without network dependence; prevents offline pin failures or changed output.
- **KEEP** `reads the whole output when the run kept only a preview` — A truncated preview is replaced with daemon full output; returning preview would corrupt subsequent test runs.
- **KEEP** `refuses a malformed answer rather than pinning the preview` — Malformed full-output response rejects; prevents silently pinning preview/undefined instead of actual output.

## `packages/ui/src/lib/workflows/inspector-support.test.ts`

Independent source: spec §5.2 account family/usage; 7.2 inspector data; AGENTS tolerant localStorage validation; 7.6 pins. Production seam/callers: inspector-usage.ts AccountPolicyEditor; inspector-layout.ts WorkflowEditor; inspector-data.ts DataTab. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `joins managed accounts to their windows by id; an expired window says nothing` — Account-ID joining selects correct usage and excludes expired windows; stale/system/reauth states remain distinguishable.
- **KEEP** `families: proxy launchers borrow another's; OpenCode has none` — Proxy launchers resolve account family and accountless OpenCode does not offer unrelated accounts; scoped quota names come from wire data.
- **DELETE** `reset countdowns` — Reset countdown prose has no byte-level contract.
- **REWRITE** `reads field by field, clamping the inspector width, and falls back on anything unreadable` — Malformed persisted layout fields are rejected individually and invalid payloads fall back. Assert literal safe fields and finite bounded width; drop exact default width/exported-default tautology and direct clamp duplicates.
- **KEEP** `a block's input is its one live upstream's output, or the merge object` — Inspector input follows live upstream output(s) and excludes skipped branch; independent inspector-data owner, not daemon execution or separate run-view derivation.
- **KEEP** `a pinned output is JSON, or an error that says why` — Valid pinned JSON preserves data, invalid/empty JSON rejects without exact error prose; prevents storing malformed pin edits.

## `packages/ui/src/lib/workflows/json-tree.test.ts`

Independent source: spec §3.3 expression-path bytes; 7.2/7.3 copy input/output data. Production seam/callers: json-tree.ts; JsonTree.tsx. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `names a value's kind` — Kind declaration/typeof tests duplicate JavaScript and higher-level child/copy behavior.
- **REWRITE** `builds `{{…}}` paths: dots for identifiers, brackets for the rest` — Copied child paths must escape non-identifier keys, indexes and quotes into valid template syntax. Test complete paths, not private segment formatting twice.
- **KEEP** `pages children with their paths` — Paged children preserve offsets, values and expression paths; prevents copy/select reading wrong array element across a page.
- **DELETE** `previews a value in one short line` — Preview prose, punctuation and display truncation mirror implementation.
- **REWRITE** `copies strings raw and everything else as pretty JSON` — Copy preserves raw strings and JSON values. Compare parsed data rather than whitespace indentation; remove unspecified cyclic-object fallback copy.
- **DELETE** `opens the root and small first levels by default` — Default expansion depths/count thresholds are presentation.
- **DELETE** `clips long strings for display` — Clip length is arbitrary display policy, not required data/storage limit.

## `packages/ui/src/lib/workflows/open-bridge.test.ts`

Independent source: spec §5.10 workflow-owned chat navigation; AGENTS bridge validation. Production seam/callers: open-bridge.ts; WorkflowChip.tsx, WorkflowsHost.tsx and run-opening helpers. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `with no listener, opening a run is a no-op that reports false` — No-listener false is already asserted after unsubscribe in the next case.
- **KEEP** `every listener takes the run, and unsubscribing takes it out` — All registered views receive run target and unsubscribe stops delivery/no-listener reports false; prevents missing or stale navigation.
- **KEEP** `a listener that unsubscribes while being called does not skip the others` — Unsubscribe during delivery must not skip other registered consumers; independent reentrancy failure not covered by ordinary unsubscribe.
- **KEEP** `only a chat tab with a whole workflow owner links to a run` — Only full validated workflow-owned agent chat summaries link to runs; malformed owner/other kinds never navigate.

## `packages/ui/src/lib/workflows/outline-display.test.ts`

Independent source: spec §7.4 Steps outline presentation. Production seam/callers: outline-display.ts; steps-logic.ts, run-view.ts. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **DELETE** `a success/failure chain reads flat; its shared failure handler is one labelled row` — Display depth, labelled/underParent and flat row arrays are presentation internals; API outline tests own topological/branch identity and retained steps graph tests own actual graph editing.
- **DELETE** `branches stay indented and labelled; a lone failure branch too` — Indent depths/label flags pin geometry/appearance rather than data behavior.

## `packages/ui/src/lib/workflows/overlay.test.ts`

Independent source: spec §7.3 run overlay statuses/durations/selected paths; run wire taken/dead edges. Production seam/callers: overlay.ts; WorkflowEditor and canvas run drawing. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `per block: status, duration (live for a running one), attempt, handle, account and hops` — Run block data derives elapsed time/current account after hops and skips unreached nodes; prevents stale actor/timing data in run view.
- **KEEP** `edges: taken, active into a running block, dead, idle — read off the source when the lists lag` — Explicit taken and source-handle fallback paths distinguish active/dead/idle edges; prevents highlighting wrong branch while event lists lag.
- **REWRITE** `the run's own lists win, and a failed block's error edge is the one taken` — Error fallback chooses failure edge; recorded lists are authoritative. Add conflicting taken/dead lists because original fixture agreed with fallback and could pass for wrong reason.

## `packages/ui/src/lib/workflows/runs-mode.test.ts`

Independent source: spec §7.3 selecting historical/live runs and selected block. Production seam/callers: runs-mode.ts; RunsMode.tsx; followsNewRun has zero production callers. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `shows the run asked for, else the newest live one, else the newest` — Requested older run remains selected; default uses live then newest; empty list yields none. Prevents replacing user-selected history.
- **REWRITE** `keeps the picked block while the run has it; else the run's own default` — Existing picked block is preserved, missing selection falls back to failed step. Drop repeated live/empty defaultSelectedStep cases owned by run-view.test.ts.
- **DELETE** `a trigger's new run takes over only a view the user did not pick` — followsNewRun is never called by production. Delete dead predicate and its sole test.

## `packages/ui/src/lib/workflows/temp-projects.test.ts`

Independent source: spec §5.10 workflow temporary project attribution; persisted run tempProject fields. Production seam/callers: temp-projects.ts; ProjectList.tsx/sidebar. Risk: low for deletes (no behavior change); retained data scenarios protect the failure modes below. Stronger coverage: same-file retained owner cases unless named otherwise; distinct owners have no stronger substitute. All KEEP/REWRITE rows inherit each of bars 1–6 above with this source/seam and the stated independent expected result.

- **KEEP** `marks a project a known run names as its temp project` — Known active run path marks its temporary project despite trailing slash.
- **KEEP** `never a deleted one, and never a wf- folder on its name alone` — Deleted projects and merely similarly named user folders are not attributed to workflow runs; prevents misleading provenance.
- **KEEP** `the name fallback counts when a known run's id confirms it` — Legacy name fallback requires a known run-ID prefix; recognizes older run summaries without arbitrary folder matches.

## Standalone markup checks (DELETE)

`packages/ui/src/components/workflows/phone/phone-render.check.ts`: Steps Jira-template block/menu labels and output button count; failure-join prose; selected/problem/badge markup; chain indentation and touch sizes; read-only add-button absence; empty/lone-trigger copy; top-bar button/switch/save labels and widths; view-switch ordering/live-count labels; toolbar labels/view-specific copy/disabled markup; key-bar role/data IDs/tabindex/template-key absence. These freeze markup/copy/geometry with no interaction or verifiable end-to-end artifact. `StepsView`, `PhoneEditorChrome`, `KeyBar` owners were read. Graph edit and key insertion cases remain at real semantic seams; private rendering details intentionally lose coverage.

`packages/ui/src/components/workflows/runs/runs-render.check.ts`: RunsList trigger/skipped/filter/empty/load-more text and row/filter size; RunHeader status/actions/progress/short ID/temp-project/error copy; BlockRunDetails activity/session/account/hops/error/skip/output/tab/full-output text and phone tab size; RunTimeline names/branch/join/hop/error/state/selected/loading markup and row size; LogViewerView live/download/drop-count/byte-size/empty-copy and log role; WorkflowRunToastCard title/count/action copy; WorkflowAttentionRows detail/time/dismiss copy, target size and empty-string render. Each group pins markup, copy or geometry, and mocked no-op actions prove no workflow. `RunsList`, `RunHeader`, `BlockRunDetails`, `RunTimeline`, `LogViewer`, `WorkflowRunToast`, `WorkflowAttention` owners were read; run-view/log/history/notification data contracts remain with their actual owners. No stronger visual regression claim is made.

## Removed dead support/seams

- Delete runs/run-fixtures.ts: only runs-render.check.ts imports it.
- Make RepoPicker.repoForUrl, clipboard.freeNodeName and app.withoutWorkflowTabs private after removing direct private-helper tests.
- Remove unused runs-mode.followsNewRun entirely (only its test calls it).
- Remove SnapshotHistory.size, the unused record() added-step result, and configurable constructor options: production instantiates fixed documented history only and never reads record() return values. Keep fixed history constants private.
- Remove test-only exports of LogViewerView/its props, WorkflowRunToastCard/its props, WorkflowAttentionRows/its props; components remain internal production rendering.

## Verification results

Focused suite passed **64/64** (16 retained files). The clipboard suite passed **5/5** again after strengthening unsupported-version rejection. No retained regression failed. Scoped `git diff --check -- packages/ui/src/lib/workflows packages/ui/src/components/workflows docs/test-cleanup/ui_workflows.md` passed; final production/test diffs reviewed. Full repository gates are recorded by the parent integration report. A local preparation command first used a repository-relative path from the UI directory and exited before edits; rerun from the repository root succeeded.

Exact focused command, working directory `packages/ui`:

```sh
node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/components/workflows/canvas/connection.test.ts src/components/workflows/canvas/tap-connect.test.ts src/components/workflows/phone/key-bar.test.ts src/lib/workflows/app-wiring.test.ts src/lib/workflows/catalog-ui.test.ts src/lib/workflows/clipboard.test.ts src/lib/workflows/deep-link.test.ts src/lib/workflows/history.test.ts src/lib/workflows/inspector-autocomplete.test.ts src/lib/workflows/inspector-pin.test.ts src/lib/workflows/inspector-support.test.ts src/lib/workflows/json-tree.test.ts src/lib/workflows/open-bridge.test.ts src/lib/workflows/overlay.test.ts src/lib/workflows/runs-mode.test.ts src/lib/workflows/temp-projects.test.ts
```

The final clipboard rerun used the same import flags with `--test src/lib/workflows/clipboard.test.ts`. After removing the unused history record return value, a final run with those import flags and `--test src/lib/workflows/history.test.ts src/lib/workflows/editor-store.test.ts` passed **26/26**. Across this UI-workflow assignment, 32 original test/check files became 24 retained files and 4,423 test/check lines became 2,952; the unused 361-line run fixture was also deleted. Counts document the outcome, not the disposition criterion.
