# UI workflows: current-suite cleanup

This is the completed cleanup record for the current suite, not a re-count of deletions documented by earlier underscore-named reports. Dispositions below were recorded before source/test edits.

Independent sources: `docs/superpowers/specs/2026-09-28-automated-workflows-design.md` (section references below), current `packages/api/src/workflows` wire/type contracts and config schemas, and root `AGENTS.md` validation/connection rules. Owners and production callers were read before these decisions; historical audit conclusions were not accepted without reading current tests.

For **every KEEP and REWRITE**, all six bars apply jointly with its case-specific row and group source/caller:

1. The cited requirement/protocol/security rule or explicitly described race/resource failure determines the contract independently of this implementation.
2. The row names the wrong data, lost edit, unusable action/navigation or resource failure visible through the named production consumer.
3. Expected literals, graph relations, IDs and input/output bytes are supplied by independent fixtures; no expected value is computed by calling the owner or reproduced inside a mock. Network fakes model responses only.
4. The test exercises the actual public operation or production-used domain/serialization/state seam listed for its group.
5. Assertions constrain semantic data/state, not component identifiers, CSS/markup, pixel geometry, private method ordering or object identity. Transport requests are externally visible protocol behavior.
6. The row states the distinct branch/owner absent from stronger retained coverage. Shared renderer wrappers and duplicate scope/effect/helper assertions are pruned; separately implemented inspector, timeline and overlay mappings can fail independently and remain protected.

Isolated-unit failure inventory, before retention: graph edits can connect an invalid edge or sever existing paths; clipboard can corrupt identity/references; history can lose or combine edits; parsers can accept unsafe fields or corrupt copied bytes; completions can offer invalid paths or overwrite the wrong text; asynchronous loads/saves/events can lose edits or regress state; notifications can be duplicated, misdirected or suppressed; log buffering/following can drop/duplicate output, spin requests or grow without bound. Only cases detecting these or another concrete failure listed below survive.

Risk/validation shared by every row: low for deletion of duplicate inventory/dead seams; observable behavior is not intentionally changed. Exact pixel-width freezing is intentionally removed while persisted-data validation remains. Baseline and final command from `packages/ui`:

```sh
pnpm exec node --import tsx --import ../../scripts/test/assert-ok.mjs --import ./test/svg-loader.mjs --import ./test/quiet-mock-timers.mjs --test src/lib/workflows/*.test.ts src/components/workflows/canvas/*.test.ts src/components/workflows/steps/*.test.ts src/components/workflows/phone/*.test.ts src/components/workflows/runs/*.test.ts
```

Root integration runs `pnpm check`, `pnpm test`, any required build, and final diff review.

## `packages/ui/src/lib/workflows/app-wiring.test.ts`

Source: §7.2; workflow event-channel wire contract. Stable owners and non-test callers: store/app.ts applyEvent/openWorkflowTab/closeTab; WorkflowsHost, tab strip and tab switcher. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| an upsert and a delete on the workflows channel reach the module store | **KEEP** | Wrong-channel routing or omitted routing leaves list state stale; actual app event entry point is not exercised by reducer-only store cases. |
| the same message on another channel does not reach workflows | **KEEP** | An unrelated event channel could mutate workflow state; the positive route test prevents a reject-all implementation from passing. |
| opens one tab per workflow per project, reusing it and updating its run | **KEEP** | Opening/reopening a workflow must preserve one tab per project, selection and omitted-versus-null run identity; other tab cases do not exercise reuse. |
| an unknown workflow takes the caller's title | **KEEP** | Before list loading completes a newly opened tab must use the caller-supplied name, not lose it. |
| follows a rename and closes with its workflow, handing the focus on | **KEEP** | Remote rename/delete must update every project tab and transfer focus after removal; reducer tests cannot detect stale app tab state. |
| closeTab closes a workflow tab like any local tab | **KEEP** | Explicit closeTab must remove the workflow tab and active selection; remote-delete coverage uses another action. |

## `packages/ui/src/lib/workflows/catalog-ui.test.ts`

Source: §7.2 add from output; §3.4 input eligibility. Stable owners and non-test callers: catalog-ui.ts filterPalette; AddBlockMenu and BlockPalette. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| from an output it offers no triggers and no notes | **KEEP** | The output-add menu must include executable candidates while excluding triggers and notes; graph validation only catches a later invalid edge, not missing/misleading candidates. |

## `packages/ui/src/lib/workflows/clipboard.test.ts`

Source: §7.2 clipboard transfer; §3.3 node references; config node schemas. Stable owners and non-test callers: clipboard.ts serializer/parser/paste; WorkflowEditorTab and Steps duplicate. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| carries the selected blocks and only the edges between them, under the marker | **KEEP** | Only selected nodes and internal edges travel with literal interoperable marker bytes; paste tests do not prove exported payload boundaries. |
| is not fooled by other text, or by a payload whose blocks do not parse | **KEEP** | Unrelated text, unsupported marker versions and malformed node payloads must not paste; the unsupported-version fixture otherwise contains a valid node. |
| re-mints ids and names and keeps inner edges and references | **KEEP** | Paste must remint identity and internal references while retaining external references; a sequential/string-only rename would corrupt continued sessions or templates. |
| keeps a name that is free in the target workflow (a paste across workflows) | **KEEP** | Cross-workflow paste must preserve an unoccupied name; collision tests exercise a distinct branch. |
| does not turn A→B, B→C renames into A→C | **KEEP** | Simultaneous Post/Post2 collisions must not cascade into references to the wrong copied node; literals independently identify the intended destinations. |

## `packages/ui/src/lib/workflows/deep-link.test.ts`

Source: §5.11 notification navigation; web service-worker message protocol; AGENTS bridge validation. Stable owners and non-test callers: deep-link.ts parse/consume/decide; apps/web main and WorkflowsHost. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| parses ?workflow=&run= | **KEEP** | URL workflow/run identifiers must parse and unsafe/invalid identifiers reject; message parsing has a separate input format. |
| strips its parameters and keeps the rest | **KEEP** | Consuming a link must remove only workflow/run query fields and preserve other query/hash/path state, avoiding repeated opens or lost routes. |
| parses the service worker's message; anything else is null | **KEEP** | Only the literal service-worker message type with valid identity may navigate; URL parsing cannot detect malformed bridge messages. |
| one pending link, taken once, listeners told | **KEEP** | Newest pending notification navigation must be delivered once rather than replay old/opened targets; subscriber/queue seam is used by WorkflowsHost. |
| waits for the connection and the workflows, opens in the workflow's own project | **KEEP** | Navigation must wait for a connection/loading, choose the workflow project and distinguish a removed workflow; URL decoding does not own readiness. |

## `packages/ui/src/lib/workflows/editor-store.test.ts`

Source: §7.2 autosave/conflicts/history/continuous validation; §8.1 revision protocol; AGENTS connection ownership. Stable owners and non-test callers: editor-store.ts WorkflowEditor and shared editor registry; use-workflow-editor, WorkflowEditorTab and PhoneEditor. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| a missing workflow is an error with words, not a crash | **KEEP** | A missing remote workflow must yield an error state and no editable draft, not throw through the editor. |
| saves 600 ms after the last change, once, with the revision the draft is based on | **KEEP** | Edits must debounce 600ms from the last edit and submit the latest draft against its known revision; literal time comes from §7.2, not imported production constants. |
| the body leaves out the daemon's own fields | **KEEP** | ReplaceWorkflowRequest must omit daemon-owned identity/revision/timestamps from the definition body; typed wire protocol owns these fields separately. |
| serializes saves: a change during a save is saved right after it, on the new revision | **KEEP** | A save crossing another edit must not issue concurrent stale writes or discard the newer edit; held network response exposes a real revision race. |
| a failed save says so and keeps the edit; flush retries it | **KEEP** | A transport failure must retain unsaved user text and flush must retry it; the fake provides failure/success responses, not editor state logic. |
| an enabled draft the daemon refuses as invalid is saved disabled, and the editor says so | **KEEP** | An invalid enabled draft must retain the edit by saving it disabled and expose that state to the user, per errors-block-enabling-not-saving requirement. |
| a 409 raises the banner and stops autosaving | **KEEP** | A stale revision response must stop automatic overwrite attempts and expose conflict; otherwise another client's edit is silently lost. |
| Reload takes their copy and drops the edits (and the undo history) | **KEEP** | Reload must take the remote version and clear stale local history; the conflict prompt's discard action differs from overwrite. |
| Keep mine overwrites theirs with the draft | **KEEP** | Keep mine must fetch current revision and save the retained draft; otherwise a conflict cannot be resolved in favor of local edits. |
| a newer revision while clean reloads silently | **KEEP** | A newer remote revision must refresh a clean editor; dirty-draft conflict coverage cannot detect stale clean views. |
| a newer revision over unsaved edits raises the banner | **KEEP** | A remote update must preserve unsaved local edits and surface conflict; save-response 409 coverage does not exercise the event path. |
| an own-save event before its response preserves the draft without a false conflict | **KEEP** | An own-save event can precede its HTTP answer without generating a false conflict or losing edits; distinct event/response race. |
| undo drops a selection of blocks the older draft does not have | **KEEP** | Undoing an inserted node must drop its selected identity, preventing an inspector selection pointing at a nonexistent node; history-only snapshots cannot prove this. |
| enabling saves pending edits first, then patches set_enabled on the new revision | **KEEP** | Enable must flush pending draft first and patch the new revision; otherwise enabling creates stale conflicts or loses the latest edit. |
| validates the draft a moment after each change | **KEEP** | Editing an expression to reference a missing node must publish validation problems; validator tests do not prove validation is scheduled after a UI edit. |
| a reconnect's new client keeps the same editor and its unsaved draft (keyed by connection id) | **KEEP** | A rebuilt client for the same connection must retain unsaved draft and write through the new transport, while another connection gets isolated state. |
| a load that lands after the user typed keeps the edit and raises the banner | **KEEP** | Typing while a remote load is pending must not let its answer replace newer user text; held GET response demonstrates the race. |
| an Enable event before its response preserves enabled state without a false conflict | **KEEP** | An enable event preceding its HTTP answer must not falsely conflict or revert enabled state; separate patch path from save echoes. |
| undo never flips enabled | **KEEP** | Undo must restore edited content while leaving enabled state alone; undoing rename must not accidentally resume/pause triggers. |
| reconnect: a failed save is retried; a newer daemon revision is a conflict | **KEEP** | Reconnect must retry a failed dirty save only when the daemon revision still matches, otherwise preserve the draft as conflict. |
| flushAllWorkflowEditors saves a pending edit at once (pagehide) | **KEEP** | The pagehide flush operation must submit a pending draft before the debounce fires; editor registry iteration is production lifecycle ownership. |

## `packages/ui/src/lib/workflows/format.test.ts`

Source: §7.1 workflow filters; §7.2 creation; §6.2 poll errors; §8.1 create protocol. Stable owners and non-test callers: format.ts/new-workflow.ts/templates.ts; WorkflowCard, RunsList, WorkflowsPanel, NewWorkflowDialog and WorkflowEditorTab. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| times a run: its duration once ended, the time so far while running | **KEEP** | Live duration uses elapsed time and ended duration uses recorded duration, with unknown start remaining unknown; these are displayed numeric data rather than prose. |
| shows the running run over a queued one | **KEEP** | When queued and running runs coexist, the card must report the running one; run-mode selection owns a different run list and policy. |
| filters by scope, by running, and by the search | **KEEP** | Project/running/search filters must expose the right workflow IDs and normalize trailing slashes; a failed filter hides the user's workflows. |
| a blank workflow is one manual trigger the daemon names and places, in the browser's time zone | **KEEP** | Blank-create request must carry a manual trigger, selected project and timezone without invented node IDs; this is caller-visible REST data rather than a template markup snapshot. |
| defaults to this project, and resolves each target | **KEEP** | New-workflow form must resolve this/other/temp clone choices to their correct target paths and trimmed input; daemon schema does not own form-to-request conversion. |
| names the first thing missing | **KEEP** | Incomplete/oversized creation data must report the missing field and refuse submission; successful resolution cases supply the complementary positive control. |
| maps each trigger whose last poll failed to its error, and nothing else | **KEEP** | Poll failure messages must be associated with the correct trigger ID and absent failures omitted; backend trigger tests cannot prove UI association. |

## `packages/ui/src/lib/workflows/history.test.ts`

Source: §7.2 undo/redo, 100 steps and coalesced drags. Stable owners and non-test callers: history.ts SnapshotHistory; WorkflowEditor. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| undo hands back the state before each change, redo walks forward again | **KEEP** | Undo/redo must return chronological pre-edit snapshots and stop at the ends; editor integration cases do not cover multi-step replay. |
| a burst with one key is one step; a pause or another key starts a new one | **KEEP** | A drag/typing burst must undo in one step while a pause or different field starts another; prevents fragmented or conflated user undo operations. |
| a null key never coalesces, and seal() ends a burst early | **KEEP** | Independent changes and explicitly sealed bursts must remain independently undoable; sealHistory is invoked by actual editor editing flows. |
| a new change after an undo drops what could be redone | **KEEP** | Editing after undo must discard the abandoned redo branch, preventing restoration of superseded user work. |
| keeps at most 100 steps, dropping the oldest | **KEEP** | History must enforce the independently specified 100-step retention without discarding newer edits first; no geometry assertion. |

## `packages/ui/src/lib/workflows/inspector-autocomplete.test.ts`

Source: §7.2 upstream template completion; §3.2 output context and §3.3 expression grammar. Stable owners and non-test callers: inspector-autocomplete.ts completionScopeFor/templateCompletions; Inspector and TemplateEditor. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| lists only the blocks upstream, the triggers, and the direct input's fields | **DELETE** | Intermediate scope-field inventory duplicates the real completion tests for upstream names, trigger fields and direct input; no additional completion failure is detected. The helper still has a production Inspector caller. |
| offers the roots right after {{ | **KEEP** | An opening expression must offer valid language roots and prefix filtering; roots are independently documented expression names, not UI copy. |
| walks nodes → a block → output → its known fields, from the caret back | **KEEP** | Nested node/output/error/PR paths must suggest accessible properties and replace only the typed suffix; this catches invalid completions or overwriting surrounding text. |
| knows the trigger's fields, the run, the project, the secrets and the input | **KEEP** | Context-specific trigger/run/project/secret/input completions must expose values supported by the expression protocol; dynamic secret names are supplied data. |
| offers filters after a pipe, with arguments filled in | **KEEP** | Pipe completion must yield executable filter syntax including required arguments; path completion tests cannot detect malformed filter insertion. |
| says nothing outside an expression, after one closed, or after an escape | **KEEP** | Plain, closed or escaped expression text must not activate completion; otherwise editor typing is interrupted outside the template language. |
| offers {variables} in a prompt only, and never inside {{ | **KEEP** | Saved-prompt single-brace variables are enabled only in prompt scope; ordinary template fields must not receive unsupported expansions. |

## `packages/ui/src/lib/workflows/inspector-pin.test.ts`

Source: §7.6 pinned outputs; §8.1 whole-output endpoint. Stable owners and non-test callers: inspector-data.ts pinnableOutputOf; DataTab pinFromRun. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| pins a whole recorded output as is, without asking the daemon | **KEEP** | Whole recorded output must remain pinnable without a redundant network request; an offline daemon must not prevent pinning already available data. |
| reads the whole output when the run kept only a preview | **KEEP** | A truncated preview must be replaced with the separately fetched full output before pinning; differing preview and full values catch wrong-source selection despite a stub transport. |
| refuses a malformed answer rather than pinning the preview | **KEEP** | A malformed full-output response must refuse pinning rather than persist the preview; the adjacent valid-response case prevents reject-all false positives. |

## `packages/ui/src/lib/workflows/inspector-support.test.ts`

Source: §5.2/§7.2 account selection; AGENTS localStorage validation; §3.2 live inputs; §7.6 pinned JSON. Stable owners and non-test callers: inspector-usage.ts, inspector-layout.ts, inspector-data.ts; AccountPolicyEditor, ChainEditor, use-workflow-editor and DataTab. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| joins managed accounts to their windows by id; an expired window says nothing | **KEEP** | Managed-account usage must join by account identity, omit wrong families and treat expired/stale readings as unknown; selecting another account's usage changes allow-list decisions. |
| families: an agent's own; OpenCode and agents this build does not offer have none | **KEEP** | Only managed AgentAccount families can preserve account policy across launcher changes; OpenCode/unknown launchers have no managed family, and scoped thresholds use supplied usage labels. |
| reads field by field, clamping the inspector width, and falls back on anything unreadable | **REWRITE** | Keep persisted key/field validation through production loadEditorLayout; drop exact pixel widths/range assertions and test-only parseEditorLayout export. Invalid stored fields must not enter typed UI state; preserved palette false and fallback booleans catch field-wide resets. |
| a block's input is its one live upstream's output, or the merge object | **KEEP** | Inspector input must reflect only live predecessor outputs, merging by names and excluding skipped branches; run-view blockInput is a separate implementation and does not protect DataTab. |
| a pinned output is JSON, or an error that says why | **KEEP** | Pinned text must accept valid JSON and reject empty/malformed text before applying persisted output; test observes parser result state, not exception wording. |

## `packages/ui/src/lib/workflows/json-tree.test.ts`

Source: §7.3 data copy; §3.3 expression path grammar. Stable owners and non-test callers: json-tree.ts jsonChildren/jsonCopyText; runs/JsonTree. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| builds `{{…}}` paths: dots for identifiers, brackets for the rest | **REWRITE** | Observe quoted-key escaping and usable root paths through jsonChildren, the production-consumed page seam; remove assertions for unused jsonExpression and delete it. Remaining page test owns nested identifier/index paths, so remove duplicate direct helper assertions/exports. |
| pages children with their paths | **KEEP** | Pages must include the requested array segment/object values with valid paths and no children for leaves; wrong page offsets lose displayed/copied data, not merely row geometry. |
| copies strings raw and preserves JSON values | **KEEP** | Copying strings must preserve raw text while objects preserve JSON structure; double-quoting strings or corrupting nested JSON breaks user clipboard data. |

## `packages/ui/src/lib/workflows/notifications.test.ts`

Source: §5.11 notification policy; §3.4 stopped/interrupted outcomes; AGENTS isolation; public UI exports. Stable owners and non-test callers: notifications.ts public rules/store operations; app applyEvent, WorkflowRunToast, WorkflowAttention and use-run-on-screen. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| reads notify settings field-wise, defaulting to failures only | **KEEP** | Missing/malformed notify settings must safely default failures on/successes off while honoring valid booleans; store-success examples do not cover malformed field fallback. |
| counts a Stop block's end as a success and a cancel or a skip as nothing | **KEEP** | Public outcome classification must treat Stop as success, interrupted as failure and user cancellation/skips/live runs as quiet; these are independently specified outcome semantics. |
| toasts a failure, and a success only when the workflow asks | **REWRITE** | Retain user-provided error/project metadata, test-run identity and default success suppression in toast output; delete duplicate explicit success/failure preference checks owned by store preference cases. |
| says nothing about a sub-workflow's run | **KEEP** | Child runs must not raise their own duplicate notification; parent-run identity is independent of success/failure preference cases. |
| puts failed runs in the Attention Center, never test runs | **KEEP** | Failure attention entries must carry exact run/workflow/project/error data and exclude test runs; the expected strings are user/server data, not UI copy. |
| raises a toast and an entry once per run, however often the event arrives | **KEEP** | Duplicate finished events notify once and irrelevant/malformed events cannot add notifications; prevents reconnect spam through the app's real event-consumer seam. |
| stays quiet for the run the user is looking at | **KEEP** | A visible run already being viewed must not notify; mounted state is distinct from explicitly marking an ended run read. |
| a mounted run in a hidden document does not swallow the failure | **KEEP** | A hidden document must still surface its mounted run's failure; otherwise background completion silently disappears. |
| viewing a LIVE run never silences its later failure | **KEEP** | Merely viewing a still-live run must not silence its later failure after leaving; prevents premature read acknowledgement. |
| the workflow summary's notify settings decide (a success toast when asked, no failure when off) | **KEEP** | Current workflow summary preferences must control failure suppression/success notification; direct pure-rule tests do not exercise preference lookup. |
| clears a run's toast and entry once it is viewed, and stays quiet about it after | **KEEP** | Viewing one ended run clears only its notices and suppresses replay, while other runs remain visible; distinguishes read state from global dismissal. |
| dismisses the toasts and one entry at a time | **KEEP** | Dismiss-all toast and dismiss-one attention commands must not accidentally clear unrelated entries or attention state. |
| reads the workflow's notify settings from a loaded run's definition | **KEEP** | Without a summary, the loaded frozen definition must supply notification preferences, and successful runs never become failure attention entries. |
| forgets everything on a connection switch | **KEEP** | Reset must clear notices and deduplication memory so the same ID on another connection can notify; it tests the public reset operation, not connection-switch wiring. |

## `packages/ui/src/lib/workflows/open-bridge.test.ts`

Source: §5.10 chat Workflow chip navigation; AGENTS bridge payload validation. Stable owners and non-test callers: open-bridge.ts public subscription/target parsing; WorkflowChip and WorkflowsHost. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| every listener takes the run, and unsubscribing takes it out | **KEEP** | Open-run delivery must reach subscribers, stop after unsubscribe, and report no listeners so navigation fallback can work. |
| a listener that unsubscribes while being called does not skip the others | **KEEP** | A listener unsubscribing during delivery must not skip another mounted target; copy-versus-in-place iteration has a credible dropped-navigation failure. |
| only a chat tab with a whole workflow owner links to a run | **KEEP** | Only complete workflow-owned agent-chat identity may link to a run; malformed/foreign/shell owner data must not navigate to an unusable target. |

## `packages/ui/src/lib/workflows/overlay.test.ts`

Source: §7.3 frozen-run overlay; §3.4 executed/dead branches. Stable owners and non-test callers: overlay.ts deriveRunOverlay; RunsMode and RunsModeFallback canvas data. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| per block: status, duration (live for a running one), attempt, handle, account and hops | **KEEP** | Overlay must preserve actual block duration, selected account, attempt, activity and handle while omitting unreached blocks; independent from timeline mapping owner. |
| edges: taken, active into a running block, dead, idle — read off the source when the lists lag | **KEEP** | Edges must distinguish executed/live-target/dead/unreached paths even before recorded edge lists catch up; wrong colors here convey wrong execution data, not geometry. |
| a failed block takes its error edge unless the run records another path | **KEEP** | Failed blocks use error edges and explicit recorded paths override inferred handles; prevents falsely reporting success routes after failure. |

## `packages/ui/src/lib/workflows/run-view.test.ts`

Source: §7.3/§7.4 timeline/actions; §3.2 inputs; §8.1 retry request protocol. Stable owners and non-test callers: run-view.ts timeline/input/action/request/page functions; RunTimeline, BlockRunDetails, RunHeader, RunsList and use-run-history/use-run-actions. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| preserves failed block details and distinguishes unreached steps in a finished run | **KEEP** | Completed runs must retain errors/attempt/duration and mark unreached blocks skipped; failed block must be selected for diagnosis. |
| shows a working agent's account, hops and activity | **KEEP** | Live agent steps must show the current account/activity/duration and select that step while downstream unstarted steps remain pending; finished-run case cannot detect premature skipped state. |
| builds a block's input from its live upstreams | **KEEP** | Run details must reconstruct trigger/single live branch inputs and exclude untaken/skipped edges; inspector DataTab uses a distinct implementation. |
| merges several live inputs by name | **KEEP** | Multiple live inputs merge under predecessor names and propagate truncation; single-source case does not catch overwrite or false-whole display. |
| offers what makes sense now | **KEEP** | Only meaningful cancel/retry/retry-failed/delete-temp actions are offered for current run state; wrong actions affect caller-visible commands. |
| retries with the same input, or from the same event | **KEEP** | Retries must preserve input/event/test identity and avoid empty requests before trigger data loads; asserts exact independently defined wire fields. |
| filters by status and counts each filter | **KEEP** | Status filters/counts must group stopped with success and interrupted with failure; verifies selected run IDs and data counts, not rendered row counts. |
| merges the live page with older pages, the live copy winning, newest first | **KEEP** | History merging must preserve one row per run with live/known state winning and chronological order; initial store list loads do not own older-page composition. |

## `packages/ui/src/lib/workflows/runs-mode.test.ts`

Source: §7.3 selected run/block navigation; public UI selection API. Stable owners and non-test callers: runs-mode.ts pickRunId/pickBlockId; RunsMode. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| shows the run asked for, else the newest live one, else the newest | **KEEP** | An explicit older run must remain selectable, otherwise prefer live/newest or none; initial list sorting does not own selection precedence. |
| keeps the picked block while the run has it; else the run's own default | **KEEP** | Keep the user's selected block while present and select a useful default after disappearance; direct default-selection tests cannot detect lost retained selection. |

## `packages/ui/src/lib/workflows/store.test.ts`

Source: §7.1 shared client state; §8.1 workflow/run/secret API; AGENTS bridge validation and connection isolation. Stable owners and non-test callers: store.ts load/event/mutation APIs and sanitize.ts; app router, workflow hooks, editor and both frontend renderers. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| drops a row with no id or name, and repairs the rest field by field | **KEEP** | Malformed summary rows/fields must not enter typed client state or attach another workflow's run; fixtures independently specify valid vs invalid wire values. |
| loads once, shares a request in flight, and refreshes when stale | **KEEP** | Concurrent panel consumers share a load, loaded data stays cached, and stale refresh removes absent workflows; visible refresh convergence plus request lifecycle, not private collaborator ordering. |
| a failure is the error state, and a refresh failure keeps the rows | **KEEP** | Initial load error must surface, while refresh failure retains prior rows with stale/error state; prevents disappearing workflows during network outages. |
| an event that crosses the answer is not undone by it | **KEEP** | A list response crossing newer upsert/delete events must not regress names or resurrect deleted records; held response catches real network race. |
| a client of another connection resets first | **KEEP** | Loading another connection must replace prior daemon data rather than mix identically scoped workflows. |
| ignores malformed payloads and unknown types without a throw | **KEEP** | Malformed or unknown events must leave state intact and avoid throwing through event dispatch; valid event cases make this meaningful validation coverage. |
| upserts are idempotent and report what the tabs mirror | **REWRITE** | Keep idempotent row identity and tombstone protection; remove direct event-effect shape assertions already protected by app-wiring tab rename/delete actions. |
| a run's start, updates and end fold into its workflow's row | **KEEP** | Run start/progress/end must update row/cache together and never revert terminal state due to late events or stale summaries; lower server tests do not protect UI convergence. |
| a secrets change marks the scopes it touches stale | **KEEP** | Workflow-scoped secret changes stale only that scope; global changes stale every inherited list and malformed scoped metadata is discarded. |
| block updates accept a retry but ignore an earlier attempt or state | **KEEP** | A retry's newer attempt may return to running while old attempts/earlier same-attempt states cannot regress progress; unique ordering invariant. |
| a workflow's recent runs load newest first, and a started run joins them | **KEEP** | Recent runs must be isolated by workflow, ordered newest first, and accept new started runs; pagination composition is a separate caller. |
| a loaded run keeps the deltas that landed while it was in flight | **KEEP** | A loaded detail response must retain newer block deltas received in flight while adding previously unknown blocks. |
| a reconnect marks a held run stale; a forced reload clears it and takes the run's end | **KEEP** | Reconnect must mark held detail stale and a successful forced fetch must learn its terminal status and clear staleness. |
| a list refresh updates the summary of a run held whole | **KEEP** | A history refresh must update an already loaded whole run's summary, recovering missed terminal events through a different response path. |
| a run whose definition does not parse is an error, not a crash | **KEEP** | A malformed frozen definition must report a load error without caching unsafe detail or crashing. |
| enabling shows at once, then carries the daemon's answer | **KEEP** | Enable must show optimistic state, issue the current revision patch and adopt daemon-confirmed revision/state; daemon patch mocks do not implement UI overrides. |
| a refusal rolls back and becomes the notice; a stale revision is re-read once | **KEEP** | Stale enable requests must retry with fetched revision; rejected requests must roll back optimistic state and expose a dismissible error notice. |
| an overlap skip offers Run anyway | **KEEP** | An overlap skip must offer Run anyway and retry with force in the wire request, independently specified in §5.11. |
| create shows the row at once; delete removes it, and a gone workflow counts as deleted | **KEEP** | Successful create must immediately enter client state; delete of an already-gone server record still removes its client row. |
| a reset drops answers still in flight | **KEEP** | Reset during an in-flight response must discard the old answer and remain idle, preventing cross-connection stale data leakage. |

## `packages/ui/src/lib/workflows/temp-projects.test.ts`

Source: §5.10 temporary-project ownership and sidebar attribution. Stable owners and non-test callers: temp-projects.ts workflowTempProjects/isWorkflowTempProject; sidebar workspace/project listing. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| marks a project a known run names as its temp project | **KEEP** | A known run temporary path must mark the corresponding project despite trailing slash normalization; avoids missing workflow attribution. |
| never a deleted one, and never a wf- folder on its name alone | **KEEP** | Deleted temp projects and merely similarly named user projects must not be attributed to a workflow; positive case prevents reject-all implementation. |
| the name fallback counts when a known run's id confirms it | **KEEP** | Legacy name fallback requires a known run ID prefix; separate compatibility path from recorded tempProject.path. |

## `packages/ui/src/components/workflows/canvas/connection.test.ts`

Source: §3.4 DAG/input/output constraints; §7.2 add/insert/delete operations. Stable owners and non-test callers: connection.ts/ops.ts; WorkflowCanvas, WorkflowEditorTab and PhoneEditor. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| accepts an output into a block that takes input | **REWRITE** | Exercise valid success/false/error connections through production-used connectionRefusal instead of the unused boolean wrapper; remove wrapper/barrel export. Positive cases prevent reject-all validators. |
| refuses cycles, self-loops and duplicates | **KEEP** | Cycle/self/duplicate connections must reject while distinct output handles remain allowed; literal graph counterexamples catch reversed reachability tests. |
| refuses a handle the source does not have, a trigger or a note as target, and notes as a source | **KEEP** | Unknown output handles/nodes and targets/sources without required input/output handles must reject; connection eligibility is independent of palette filtering. |
| connectBlocks adds the edge, or returns the workflow untouched | **KEEP** | Connecting must persist the requested edge while an invalid cycle leaves graph content unchanged; refusal-only tests do not prove mutation behavior. |
| adds a block wired from an output | **KEEP** | Add-from-output must create the chosen executable block and wire it from the selected source; no geometry asserted. |
| inserts a block into an edge: source → new → target | **KEEP** | Insertion must replace one edge with source→new→target; losing either side disconnects the runnable workflow. |
| removes blocks with their edges and pinned outputs | **KEEP** | Removing a block must also remove incident edges and its pinned output; Steps healing tests do not protect pinned-state cleanup. |

## `packages/ui/src/components/workflows/canvas/tap-connect.test.ts`

Source: §7.4 tap-to-connect workflow; §3.4 graph eligibility. Stable owners and non-test callers: tap-connect.ts reduceTapConnect; PhoneEditor. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| start → tap a block: connects, back to idle | **KEEP** | Two taps must produce the exact requested connection and leave picking mode; no rendering or private React props are inspected. |
| a refused target keeps picking and says why | **KEEP** | Rejected target must leave picking active with explanation and permit a later valid target; validator-only tests do not protect the interaction state. |
| its own block or Cancel ends it; a tap while idle does nothing; a new start replaces | **KEEP** | Self-tap/cancel must clear pending connection, idle tap does nothing and new source replaces old selection; prevents accidental stale-source edges. |

## `packages/ui/src/components/workflows/phone/key-bar.test.ts`

Source: §7.4 code/prompt key bar; §3.3 expression syntax. Stable owners and non-test callers: key-bar.ts applyKeyBarKey; KeyBar DOM/CodeMirror insertion. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| a character replaces the selection; the caret goes after it | **KEEP** | Symbol insertion/replacement must preserve surrounding text for forward/backward selections and place the caret after inserted content. |
| {{ }} puts the caret inside, or wraps the selection | **KEEP** | Expression shortcut must produce syntactically usable braces around a selected expression or position the caret inside an empty expression. |
| Tab indents by the editor's unit | **KEEP** | Tab must use the caller-selected indentation and move the caret consistently; actual edit result, not key declaration inventory. |

## `packages/ui/src/components/workflows/runs/log-buffer.test.ts`

Source: §7.3 live log text; terminal escape/control semantics; bounded client log retention. Stable owners and non-test callers: log-buffer.ts appendLog/visibleLogLines; LogViewer. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| drops colours, cursor moves, OSC titles and links | **KEEP** | ANSI colors/cursor/OSC sequences and unsafe control bytes must not leak into displayed text, while legitimate text and tabs remain. |
| carries an escape sequence split across chunks | **KEEP** | Escape sequences split between chunks must be consumed without losing ordinary text; single-chunk sanitizer coverage cannot catch carry mistakes. |
| keeps what a terminal would show | **KEEP** | Carriage-return progress must replace its prior line and CRLF must terminate once; ordinary newline splitting does not protect terminal-style output. |
| splits chunks into lines and keeps the line in progress | **KEEP** | Chunk boundaries must preserve incomplete lines without duplicating/dropping content; literal words form an independent stream oracle. |
| caps the lines it keeps and counts the ones it dropped | **KEEP** | The bounded log must retain newest lines, account for removed lines and reserve room for a partial final line; counts enforce memory/data retention, not visual row geometry. |
| clips a huge line | **KEEP** | A pathological long line must be bounded while retaining its readable start, protecting the viewer from unbounded rendering; ordinary many-line cap cannot catch this resource path. |

## `packages/ui/src/components/workflows/runs/log-follower.test.ts`

Source: §7.3 log tail/download; API X-Log-* byte-offset protocol. Stable owners and non-test callers: log-follower.ts; LogViewer; parseWorkflowLogWindow in api-client.ts consumed by workflow log API. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| reads a finished log to its end, window after window, by the daemon's offsets | **KEEP** | Finished logs must read all server windows using raw-byte cursors even when redaction expands displayed text; otherwise portions duplicate/vanish. |
| polls a live log, and a failed read resumes from the same offset once — no duplicates | **KEEP** | A transient live-read failure must retry the same offset and continue without duplicate text, then cease polling at terminal EOF. |
| an error on a finished log is reported, not appended | **KEEP** | A failed completed-log read must report an error without adding error text as log content; live retries exercise a different branch. |
| stop() ends it: no further reads, including after wake | **KEEP** | Stopping the viewer must terminate polling and make later wake inert, avoiding background log requests after unmount. |
| a live log held at a partial last line waits for the next poll instead of spinning | **KEEP** | A held partial line with no cursor advance must wait for a poll rather than spin synchronous reads; the transport stub supplies the documented stalled cursor, not retry logic. |
| readWholeLog reads every window to the end (the download) | **KEEP** | Full download must concatenate every log window rather than only the displayed tail or first response; follower and download are separate implementations. |
| parseWorkflowLogWindow reads the X-Log-* headers, case-insensitively | **KEEP** | Case-insensitive X-Log headers must decode cursor/eof/size/live correctly and missing headers fall back to raw response bytes; concrete wire protocol parser. |

## `packages/ui/src/components/workflows/steps/steps-logic.test.ts`

Source: §7.4 phone Steps edits; §3.4 graph validity. Stable owners and non-test callers: steps-logic.ts editing/candidate operations; PhoneEditor and StepSheets. No stronger retained test substitutes for the distinct behavior below unless its row names one.

| Original test | Disposition | Failure / reason / stronger coverage |
| --- | --- | --- |
| splices into a chain without losing downstream connections | **KEEP** | Adding after an occupied output must preserve downstream chain connections; this selection/splice decision is distinct from lower canvas insertion mutation. |
| a block with no outputs (Stop) never splices: it becomes another branch | **KEEP** | Adding Stop must keep existing downstream path as a sibling branch because Stop has no onward output; prevents silently cutting off workflow work. |
| the first step goes after the trigger; with no trigger, loose | **KEEP** | The first executable step must attach to an available trigger, while a new trigger in an empty graph remains standalone. |
| connect candidates: connectable first, with why the rest cannot | **KEEP** | Connect choices must omit self/triggers and favor legal targets while explaining illegal ancestors; edge validation alone cannot detect missing legal choices. |
| move to another output: re-hangs the row's edge; loops are refused | **KEEP** | Moving must change the selected incoming edge and preserve downstream edges; refused descendant move must keep graph intact and current candidate identified. |
| deleting a middle step heals the chain | **KEEP** | Deleting a simple middle step must heal predecessor→successor rather than cut off downstream work. |
| a join (two edges in) is deleted without guessing a heal | **KEEP** | Deleting a multi-input join must avoid inventing ambiguous replacement paths, preserving independent upstream branches. |
| duplicate puts the copy right after the original, taking over what it fed | **KEEP** | Duplicate-after must splice the copied block into the selected chain; clipboard reminting tests do not own Steps graph wiring. |
| disable / enable | **KEEP** | Disable/enable must affect only the selected block IDs and reverse cleanly; false-versus-omitted property spelling is not asserted. |

## Production seams and support

Before removal, repository-wide searches found `isValidWorkflowConnection` only in its implementation, the component barrel, and the positive connection test. The real canvas and phone call `connectionRefusal`/`connectBlocks`. Remove the boolean wrapper and barrel exposure while retaining positive and negative connection contracts on the used seam.

`jsonExpression` has no caller except its test and the broad UI barrel export; JsonTree copies the actual `entry.path`. Remove it. `jsonChildPath` and `jsonPathSegment` are used only inside json-tree after moving escaping assertions to `jsonChildren`; make these internal. `parseEditorLayout` is used only by its test and `loadEditorLayout`; make it internal after the persisted-data test moves to the real storage loader. The obsolete intermediate completion-scope test has no unique support; `completionScopeFor` stays because Inspector calls it.

No fixture or snapshot file becomes unused. Shared `testing.ts`, fake API response fixtures, fake timers, and receipt helpers continue supporting retained tests. Production request/state behavior and package scripts remain unchanged.

## Validation results

Completed cleanup of all 156 original cases: 150 KEEP, 5 REWRITE and 1 DELETE. The retained suite has 155 cases. Source/tests are 19 lines smaller (10 fewer test lines), excluding this audit record.

- Baseline focused command above: 156 passed, zero failed/skipped.
- Final focused command above, with `--test-concurrency=2` to limit shared-host contention: 155 passed, zero failed/skipped.
- After final review removed exact notification sentence punctuation from the retained data-preservation assertion, the notification file passed again: 14 passed, zero failed/skipped.
- `pnpm --filter @orquester/ui typecheck` found only two unrelated `composer-outbox.test.ts` call-arity errors. The owning agent corrected them and reported its typecheck passing; root's final `pnpm check` verifies the integrated tree.
- Scoped `git diff --check` passed. Reviewed the final scoped diff and searched remaining callers of every removed/internalized helper; no dead fixture or snapshot remains.
